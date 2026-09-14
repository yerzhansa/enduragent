import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelCatalogDraftSchema,
  ModelCatalogSnapshotSchema,
  type ModelCatalogDraft,
  type ModelCatalogSnapshot,
} from "@enduragent/coach-contract/model-catalog";
import { ModelCatalogArchive, type LockedModelCatalogArchive } from "./model-catalog-archive.js";
import {
  WranglerModelCatalogCloudflare,
  deployModelCatalogAssets,
  modelCatalogDeploymentMessage,
  modelCatalogDeploymentTag,
  modelCatalogTargetRevision,
  reconcilePublishedModelCatalogAssets,
  type ModelCatalogCloudflareBoundary,
  type ModelCatalogTargetState,
} from "./model-catalog-cloudflare.js";
import { MODEL_CATALOG_PUBLICATION_MAX_BYTES } from "./model-catalog-constants.js";
import {
  CatalogPublicationError,
  ModelCatalogPublicationFileSchema,
  buildModelCatalogPublicationRecord,
  buildModelCatalogRollbackRecord,
  diffModelCatalogs,
  modelCatalogBytes,
  validateModelCatalogPublicationFile,
  type CatalogDiff,
  type ModelCatalogDeploymentReceipt,
  type ModelCatalogPublicationRecord,
} from "./model-catalog-publication.js";
import { bytesEqual, sha256 } from "./model-catalog-bytes.js";
import { materializeModelCatalogAssets } from "./model-catalog-static-assets.js";

export interface ModelCatalogCommandDependencies {
  readonly now: () => number;
  readonly output: (line: string) => void;
  readonly boundary: ModelCatalogCloudflareBoundary;
  readonly createArchive: (path: string) => ModelCatalogArchive;
  readonly createAssetDirectory: () => string;
  readonly removeAssetDirectory: (path: string) => void;
}

function defaultDependencies(): ModelCatalogCommandDependencies {
  return {
    now: Date.now,
    output: (line) => process.stdout.write(`${line}\n`),
    boundary: new WranglerModelCatalogCloudflare(),
    createArchive: (path) => new ModelCatalogArchive(path),
    createAssetDirectory: () => mkdtempSync(join(tmpdir(), "enduragent-model-catalog-")),
    removeAssetDirectory: (path) => rmSync(path, { force: true, recursive: true }),
  };
}

function readJson(path: string): unknown {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new CatalogPublicationError("validation", `cannot read ${path}`);
  }
  if (size <= 0 || size > MODEL_CATALOG_PUBLICATION_MAX_BYTES) {
    throw new CatalogPublicationError("validation", `${path} exceeds the publication file limit`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CatalogPublicationError("validation", `${path} is not valid JSON`);
  }
}

function parseRevision(value: string | undefined, label: string): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new CatalogPublicationError("validation", `${label} must be a non-negative integer`);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw new CatalogPublicationError("validation", `${label} must be a safe integer`);
  }
  return revision;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length === 0) return undefined;
  if (indexes.length !== 1)
    throw new CatalogPublicationError("validation", `${name} may appear once`);
  const value = args[indexes[0] + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CatalogPublicationError("validation", `${name} needs a value`);
  }
  return value;
}

function positionals(args: readonly string[], flags: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (flags.includes(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new CatalogPublicationError("validation", `unknown option ${value}`);
    }
    values.push(value);
  }
  return values;
}

function baseCatalog(input: unknown): ModelCatalogDraft {
  const publication = ModelCatalogPublicationFileSchema.safeParse(input);
  if (publication.success) return publication.data.catalog;
  const snapshot = ModelCatalogSnapshotSchema.safeParse(input);
  if (snapshot.success) {
    return { schemaVersion: snapshot.data.schemaVersion, providers: snapshot.data.providers };
  }
  const draft = ModelCatalogDraftSchema.safeParse(input);
  if (draft.success) return draft.data;
  throw new CatalogPublicationError("validation", "comparison catalog is invalid");
}

function writeDiff(diff: CatalogDiff, output: (line: string) => void): void {
  output(`Additions: ${diff.additions.length === 0 ? "none" : diff.additions.join(", ")}`);
  output(`Removals: ${diff.removals.length === 0 ? "none" : diff.removals.join(", ")}`);
  output(`Changes: ${diff.changes.length === 0 ? "none" : diff.changes.join(", ")}`);
}

function stateCatalog(state: ModelCatalogTargetState): ModelCatalogSnapshot | undefined {
  if (state.kind === "absent") return undefined;
  const parsed = ModelCatalogSnapshotSchema.safeParse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(state.catalogBytes)),
  );
  if (!parsed.success) throw new CatalogPublicationError("integrity", "live catalog is invalid");
  return parsed.data;
}

function stateMatchesRecord(
  state: ModelCatalogTargetState,
  record: ModelCatalogPublicationRecord,
): state is Extract<ModelCatalogTargetState, { kind: "published" }> {
  return (
    state.kind === "published" &&
    state.revision === record.revision &&
    state.catalogDigest === record.catalogDigest &&
    state.tag === modelCatalogDeploymentTag(record.revision, record.catalogDigest) &&
    bytesEqual(state.catalogBytes, modelCatalogBytes(record))
  );
}

function samePublicationIntent(
  left: ModelCatalogPublicationRecord,
  right: ModelCatalogPublicationRecord,
): boolean {
  return (
    left.revision === right.revision &&
    left.previousRevision === right.previousRevision &&
    JSON.stringify(left.action) === JSON.stringify(right.action) &&
    left.catalog.schemaVersion === right.catalog.schemaVersion &&
    JSON.stringify(left.catalog.providers) === JSON.stringify(right.catalog.providers) &&
    JSON.stringify(left.evidence) === JSON.stringify(right.evidence)
  );
}

function receiptMatchesState(
  receipt: ModelCatalogDeploymentReceipt,
  state: Extract<ModelCatalogTargetState, { kind: "published" }>,
  record: ModelCatalogPublicationRecord,
): boolean {
  return (
    receipt.target === state.target &&
    receipt.revision === record.revision &&
    receipt.catalogDigest === record.catalogDigest &&
    receipt.tag === modelCatalogDeploymentTag(record.revision, record.catalogDigest) &&
    receipt.message === modelCatalogDeploymentMessage(record.revision, record.catalogDigest) &&
    receipt.liveEtag === state.etag &&
    receipt.versionId === state.versionId &&
    receipt.deploymentId === state.deploymentId
  );
}

async function reconcileExistingDeployment(input: {
  readonly dependencies: ModelCatalogCommandDependencies;
  readonly archive: LockedModelCatalogArchive;
  readonly target: "staging" | "production";
  readonly state: ModelCatalogTargetState;
  readonly record: ModelCatalogPublicationRecord;
}): Promise<ModelCatalogDeploymentReceipt> {
  if (!stateMatchesRecord(input.state, input.record)) {
    throw new CatalogPublicationError(
      "conflict",
      `${input.target} does not serve the archived deployment`,
    );
  }
  let existingReceipt: ModelCatalogDeploymentReceipt | undefined;
  try {
    existingReceipt = await input.archive.readDeploymentReceipt(
      input.target,
      input.record.revision,
    );
  } catch (error) {
    if (!(error instanceof CatalogPublicationError) || error.code !== "not-found") throw error;
  }
  if (existingReceipt !== undefined) {
    if (!receiptMatchesState(existingReceipt, input.state, input.record)) {
      throw new CatalogPublicationError(
        "conflict",
        `stored ${input.target} receipt does not match the live deployment`,
      );
    }
    await input.dependencies.boundary.verify({
      target: input.target,
      catalogBytes: modelCatalogBytes(input.record),
      revision: input.record.revision,
      digest: input.record.catalogDigest,
    });
    return existingReceipt;
  }
  const receipt = await reconcilePublishedModelCatalogAssets({
    boundary: input.dependencies.boundary,
    target: input.target,
    record: input.record,
    state: input.state,
    now: input.dependencies.now(),
  });
  await input.archive.writeDeploymentReceipt(receipt);
  return receipt;
}

async function targetStates(boundary: ModelCatalogCloudflareBoundary): Promise<{
  readonly staging: ModelCatalogTargetState;
  readonly production: ModelCatalogTargetState;
}> {
  const [staging, production] = await Promise.all([
    boundary.inspect("staging"),
    boundary.inspect("production"),
  ]);
  return { staging, production };
}

function globalRevision(states: {
  readonly staging: ModelCatalogTargetState;
  readonly production: ModelCatalogTargetState;
}): number {
  if (
    states.staging.kind === "published" &&
    states.production.kind === "published" &&
    states.staging.revision === states.production.revision &&
    (states.staging.catalogDigest !== states.production.catalogDigest ||
      !bytesEqual(states.staging.catalogBytes, states.production.catalogBytes))
  ) {
    throw new CatalogPublicationError(
      "conflict",
      "staging and production disagree at the same revision",
    );
  }
  return Math.max(
    modelCatalogTargetRevision(states.staging),
    modelCatalogTargetRevision(states.production),
  );
}

function globalCatalog(states: {
  readonly staging: ModelCatalogTargetState;
  readonly production: ModelCatalogTargetState;
}): ModelCatalogSnapshot | undefined {
  const stagingRevision = modelCatalogTargetRevision(states.staging);
  const productionRevision = modelCatalogTargetRevision(states.production);
  return stateCatalog(productionRevision > stagingRevision ? states.production : states.staging);
}

async function deployArchivedRecord(input: {
  readonly dependencies: ModelCatalogCommandDependencies;
  readonly archive: LockedModelCatalogArchive;
  readonly target: "staging" | "production";
  readonly predecessor: ModelCatalogTargetState;
  readonly record: ModelCatalogPublicationRecord;
}): Promise<ModelCatalogDeploymentReceipt> {
  const assetDirectory = input.dependencies.createAssetDirectory();
  try {
    const catalogBytes = modelCatalogBytes(input.record);
    const digest = await sha256(catalogBytes);
    if (digest.hex !== input.record.catalogDigest) {
      throw new CatalogPublicationError("integrity", "archived catalog digest is invalid");
    }
    await materializeModelCatalogAssets({
      directory: assetDirectory,
      catalogBytes,
      contentDigest: digest.contentDigest,
    });
    const receipt = await deployModelCatalogAssets({
      boundary: input.dependencies.boundary,
      target: input.target,
      assetDirectory,
      predecessor: input.predecessor,
      record: input.record,
      now: input.dependencies.now(),
    });
    await input.archive.writeDeploymentReceipt(receipt);
    return receipt;
  } finally {
    input.dependencies.removeAssetDirectory(assetDirectory);
  }
}

async function publishOrRollback(input: {
  readonly dependencies: ModelCatalogCommandDependencies;
  readonly archivePath: string;
  readonly expectedRevision: number;
  readonly createRecord: (
    revision: number,
    previousRevision: number,
    archive: LockedModelCatalogArchive,
  ) => Promise<ModelCatalogPublicationRecord>;
}): Promise<{ readonly receipt: ModelCatalogDeploymentReceipt; readonly diff: CatalogDiff }> {
  const archive = input.dependencies.createArchive(input.archivePath);
  return archive.withExclusiveLock(async (locked) => {
    const states = await targetStates(input.dependencies.boundary);
    const predecessorRevision = globalRevision(states);
    if (predecessorRevision !== input.expectedRevision) {
      if (
        predecessorRevision === input.expectedRevision + 1 &&
        modelCatalogTargetRevision(states.staging) === predecessorRevision
      ) {
        let archived: ModelCatalogPublicationRecord | undefined;
        try {
          archived = await locked.readPublicationRecord(predecessorRevision);
        } catch (error) {
          if (!(error instanceof CatalogPublicationError) || error.code !== "not-found")
            throw error;
        }
        if (archived !== undefined) {
          const candidate = await input.createRecord(
            predecessorRevision,
            input.expectedRevision,
            locked,
          );
          if (
            samePublicationIntent(archived, candidate) &&
            stateMatchesRecord(states.staging, archived)
          ) {
            const previous =
              input.expectedRevision === 0
                ? undefined
                : (await locked.readPublicationRecord(input.expectedRevision)).catalog;
            const receipt = await reconcileExistingDeployment({
              dependencies: input.dependencies,
              archive: locked,
              target: "staging",
              state: states.staging,
              record: archived,
            });
            return { receipt, diff: diffModelCatalogs(previous, archived.catalog) };
          }
        }
      }
      throw new CatalogPublicationError(
        "conflict",
        `expected global revision ${input.expectedRevision}, found ${predecessorRevision}`,
      );
    }
    const candidate = await input.createRecord(
      predecessorRevision + 1,
      predecessorRevision,
      locked,
    );
    let archived: ModelCatalogPublicationRecord;
    try {
      archived = await locked.readPublicationRecord(candidate.revision);
      if (!samePublicationIntent(archived, candidate)) {
        throw new CatalogPublicationError(
          "conflict",
          `revision ${candidate.revision} is archived for a different publication`,
        );
      }
    } catch (error) {
      if (!(error instanceof CatalogPublicationError) || error.code !== "not-found") throw error;
      await locked.writePublicationRecord(candidate);
      archived = await locked.readPublicationRecord(candidate.revision);
    }
    const diff = diffModelCatalogs(globalCatalog(states), archived.catalog);
    const receipt = await deployArchivedRecord({
      dependencies: input.dependencies,
      archive: locked,
      target: "staging",
      predecessor: states.staging,
      record: archived,
    });
    return { receipt, diff };
  });
}

export async function runModelCatalogCommand(
  argv: readonly string[],
  dependencies: ModelCatalogCommandDependencies = defaultDependencies(),
): Promise<void> {
  const [command, ...args] = argv;
  if (command === "validate") {
    const paths = positionals(args, ["--against"]);
    if (paths.length !== 1) {
      throw new CatalogPublicationError("validation", "models:validate needs one catalog file");
    }
    const publicationFile = await validateModelCatalogPublicationFile(
      readJson(paths[0]),
      dependencies.now(),
    );
    const againstPath = flagValue(args, "--against");
    const previous = againstPath === undefined ? undefined : baseCatalog(readJson(againstPath));
    dependencies.output("Catalog valid");
    writeDiff(diffModelCatalogs(previous, publicationFile.catalog), dependencies.output);
    return;
  }
  if (command === "publish-to-staging") {
    const paths = positionals(args, ["--expect-revision", "--archive"]);
    if (paths.length !== 1) {
      throw new CatalogPublicationError("validation", "models:publish needs one catalog file");
    }
    const publicationFile = readJson(paths[0]);
    const result = await publishOrRollback({
      dependencies,
      archivePath: flagValue(args, "--archive") ?? "",
      expectedRevision: parseRevision(flagValue(args, "--expect-revision"), "--expect-revision"),
      createRecord: (revision, previousRevision) =>
        buildModelCatalogPublicationRecord({
          publicationFile,
          revision,
          previousRevision,
          now: dependencies.now(),
        }),
    });
    writeDiff(result.diff, dependencies.output);
    dependencies.output(JSON.stringify(result.receipt));
    return;
  }
  if (command === "rollback-to-staging") {
    const values = positionals(args, ["--expect-revision", "--archive"]);
    if (values.length !== 1) {
      throw new CatalogPublicationError("validation", "models:rollback needs one source revision");
    }
    const sourceRevision = parseRevision(values[0], "source revision");
    const result = await publishOrRollback({
      dependencies,
      archivePath: flagValue(args, "--archive") ?? "",
      expectedRevision: parseRevision(flagValue(args, "--expect-revision"), "--expect-revision"),
      createRecord: async (revision, previousRevision, archive) =>
        buildModelCatalogRollbackRecord({
          source: await archive.readPublicationRecord(sourceRevision),
          revision,
          previousRevision,
          now: dependencies.now(),
        }),
    });
    writeDiff(result.diff, dependencies.output);
    dependencies.output(JSON.stringify(result.receipt));
    return;
  }
  if (command === "promote-existing-staged-revision-to-production") {
    const values = positionals(args, ["--expect-revision", "--archive"]);
    if (values.length !== 1) {
      throw new CatalogPublicationError("validation", "models:promote needs one staged revision");
    }
    const revision = parseRevision(values[0], "staged revision");
    const expectedRevision = parseRevision(
      flagValue(args, "--expect-revision"),
      "--expect-revision",
    );
    const archive = dependencies.createArchive(flagValue(args, "--archive") ?? "");
    const receipt = await archive.withExclusiveLock(async (locked) => {
      const [record, stagingReceipt, states] = await Promise.all([
        locked.readPublicationRecord(revision),
        locked.readDeploymentReceipt("staging", revision),
        targetStates(dependencies.boundary),
      ]);
      if (
        stagingReceipt.revision !== record.revision ||
        stagingReceipt.catalogDigest !== record.catalogDigest ||
        stagingReceipt.tag !== modelCatalogDeploymentTag(record.revision, record.catalogDigest) ||
        stagingReceipt.message !==
          modelCatalogDeploymentMessage(record.revision, record.catalogDigest)
      ) {
        throw new CatalogPublicationError(
          "integrity",
          "staging receipt does not match the archived record",
        );
      }
      if (
        !stateMatchesRecord(states.staging, record) ||
        stagingReceipt.liveEtag !== states.staging.etag ||
        stagingReceipt.versionId !== states.staging.versionId ||
        stagingReceipt.deploymentId !== states.staging.deploymentId
      ) {
        throw new CatalogPublicationError(
          "conflict",
          "staging no longer serves the archived deployment receipt",
        );
      }
      const productionRevision = modelCatalogTargetRevision(states.production);
      if (productionRevision !== expectedRevision) {
        if (productionRevision === record.revision && productionRevision > expectedRevision) {
          return reconcileExistingDeployment({
            dependencies,
            archive: locked,
            target: "production",
            state: states.production,
            record,
          });
        }
        throw new CatalogPublicationError(
          "conflict",
          `expected production revision ${expectedRevision}, found ${productionRevision}`,
        );
      }
      if (record.revision <= productionRevision) {
        throw new CatalogPublicationError(
          "conflict",
          "promotion must advance the production revision",
        );
      }
      return deployArchivedRecord({
        dependencies,
        archive: locked,
        target: "production",
        predecessor: states.production,
        record,
      });
    });
    dependencies.output(JSON.stringify(receipt));
    return;
  }
  throw new CatalogPublicationError(
    "validation",
    "use validate, publish-to-staging, promote-existing-staged-revision-to-production, or rollback-to-staging",
  );
}

export function publicModelCatalogCommandError(error: unknown): string {
  if (error instanceof CatalogPublicationError) return `${error.code}: ${error.message}`;
  return "model catalog command failed";
}
