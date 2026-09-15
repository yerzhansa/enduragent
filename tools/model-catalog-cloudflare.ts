import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { z } from "zod";
import { bytesEqual, sha256 } from "./model-catalog-bytes.js";
import {
  MODEL_CATALOG_PUBLIC_PATH,
  MODEL_CATALOG_WRANGLER_VERSION,
} from "./model-catalog-constants.js";
import {
  CatalogPublicationError,
  ModelCatalogDeploymentReceiptSchema,
  modelCatalogBytes,
  type ModelCatalogDeploymentReceipt,
  type ModelCatalogPublicationRecord,
  type ModelCatalogTarget,
} from "./model-catalog-publication.js";
import {
  boundedResponseBytes,
  verifyModelCatalogService,
  type ModelCatalogFetch,
} from "./verify-model-catalog-service.js";

const TARGETS = Object.freeze({
  staging: Object.freeze({
    origin: "https://api-staging.enduragent.icu",
    workerName: "enduragent-model-catalog-staging",
  }),
  production: Object.freeze({
    origin: "https://api.enduragent.icu",
    workerName: "enduragent-model-catalog",
  }),
});

const ActiveDeploymentSchema = z
  .object({
    id: z.string().min(1),
    versions: z
      .array(
        z.object({ version_id: z.string().min(1), percentage: z.number().finite() }).passthrough(),
      )
      .min(1),
  })
  .passthrough();

const WorkerVersionSchema = z
  .object({
    id: z.string().min(1),
    annotations: z
      .object({ "workers/tag": z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type ModelCatalogTargetState =
  | Readonly<{
      kind: "absent";
      target: ModelCatalogTarget;
      origin: string;
      workerName: string;
    }>
  | Readonly<{
      kind: "published";
      target: ModelCatalogTarget;
      origin: string;
      workerName: string;
      revision: number;
      catalogDigest: string;
      catalogBytes: Uint8Array;
      etag: string;
      tag: string;
      versionId: string;
      deploymentId: string;
    }>;

export interface ModelCatalogCloudflareBoundary {
  inspect(target: ModelCatalogTarget): Promise<ModelCatalogTargetState>;
  deploy(input: {
    readonly target: ModelCatalogTarget;
    readonly assetDirectory: string;
    readonly tag: string;
    readonly message: string;
  }): Promise<void>;
  verify(input: {
    readonly target: ModelCatalogTarget;
    readonly catalogBytes: Uint8Array;
    readonly revision: number;
    readonly digest: string;
  }): Promise<{ readonly etag: string }>;
  waitForPropagation(): Promise<void>;
}

export interface WranglerCommandRunner {
  run(args: readonly string[]): Promise<string>;
}

export class WranglerCommandError extends Error {
  constructor(
    readonly exitCode: string | number,
    readonly output: string,
  ) {
    super(`Wrangler command failed with exit code ${exitCode}`);
    this.name = "WranglerCommandError";
  }
}

export function modelCatalogDeploymentTag(revision: number, digest: string): string {
  return `model-catalog-r${revision}-${digest.slice(0, 16)}`;
}

export function modelCatalogDeploymentMessage(revision: number, digest: string): string {
  return `model catalog revision ${revision} sha256:${digest}`;
}

function parseJsonOutput(output: string, label: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new CatalogPublicationError("integrity", `${label} returned invalid JSON`);
  }
}

export function createWranglerCommandRunner(
  environment: NodeJS.ProcessEnv = process.env,
): WranglerCommandRunner {
  return {
    run: (args) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          "pnpm",
          ["dlx", `wrangler@${MODEL_CATALOG_WRANGLER_VERSION}`, ...args],
          {
            cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
            env: { ...environment, WRANGLER_SEND_METRICS: "false" },
            maxBuffer: 1024 * 1_024,
          },
          (error, stdout, stderr) => {
            if (error === null) resolve(stdout);
            else reject(new WranglerCommandError(error.code ?? "unknown", `${stdout}\n${stderr}`));
          },
        );
      }),
  };
}

function isMissingWorker(error: unknown): boolean {
  return error instanceof WranglerCommandError && /\[code:\s*10007\]/u.test(error.output);
}

export class WranglerModelCatalogCloudflare implements ModelCatalogCloudflareBoundary {
  private readonly configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "model-catalog.wrangler.toml",
  );

  constructor(
    private readonly runner: WranglerCommandRunner = createWranglerCommandRunner(),
    private readonly fetcher: ModelCatalogFetch = fetch,
  ) {}

  private args(target: ModelCatalogTarget): string[] {
    return ["--config", this.configPath, "--env", target];
  }

  private async activeDeployment(target: ModelCatalogTarget): Promise<{
    readonly deploymentId: string;
    readonly versionId: string;
    readonly tag: string;
  }> {
    const deploymentOutput = await this.runner.run([
      "deployments",
      "status",
      ...this.args(target),
      "--json",
    ]);
    const deployment = ActiveDeploymentSchema.safeParse(
      parseJsonOutput(deploymentOutput, "Wrangler deployments status"),
    );
    if (!deployment.success) {
      throw new CatalogPublicationError("integrity", "Wrangler deployment state is invalid");
    }
    const active = deployment.data.versions.filter((version) => version.percentage === 100);
    if (active.length !== 1 || deployment.data.versions.length !== 1) {
      throw new CatalogPublicationError("conflict", "model catalog target has split traffic");
    }
    const versionId = active[0]?.version_id;
    if (versionId === undefined) {
      throw new CatalogPublicationError("integrity", "active Worker version is missing");
    }
    const versionOutput = await this.runner.run([
      "versions",
      "view",
      versionId,
      ...this.args(target),
      "--json",
    ]);
    const version = WorkerVersionSchema.safeParse(
      parseJsonOutput(versionOutput, "Wrangler versions view"),
    );
    if (!version.success || version.data.id !== versionId) {
      throw new CatalogPublicationError("integrity", "active Worker version is invalid");
    }
    const tag = version.data.annotations?.["workers/tag"];
    if (tag === undefined) {
      throw new CatalogPublicationError("integrity", "active Worker version has no tag");
    }
    return { deploymentId: deployment.data.id, versionId, tag };
  }

  async inspect(target: ModelCatalogTarget): Promise<ModelCatalogTargetState> {
    const config = TARGETS[target];
    let deployment: Awaited<ReturnType<WranglerModelCatalogCloudflare["activeDeployment"]>>;
    try {
      deployment = await this.activeDeployment(target);
    } catch (error) {
      if (isMissingWorker(error)) {
        return Object.freeze({ kind: "absent", target, ...config });
      }
      throw error;
    }
    const response = await this.fetcher(new URL(MODEL_CATALOG_PUBLIC_PATH, config.origin), {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { "Accept-Encoding": "identity" },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return Object.freeze({ kind: "absent", target, ...config });
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new CatalogPublicationError(
        "integrity",
        `${target} catalog returned ${response.status}`,
      );
    }
    const catalogBytes = await boundedResponseBytes(response);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(catalogBytes));
    } catch {
      throw new CatalogPublicationError("integrity", `${target} catalog is not valid UTF-8 JSON`);
    }
    const catalog = ModelCatalogSnapshotSchema.safeParse(parsedJson);
    if (!catalog.success || catalog.data.provenance.kind !== "published") {
      throw new CatalogPublicationError(
        "integrity",
        `${target} catalog does not match the shared schema`,
      );
    }
    const etag = response.headers.get("etag");
    if (etag === null || etag.length === 0) {
      throw new CatalogPublicationError("integrity", `${target} catalog has no ETag`);
    }
    const catalogDigest = (await sha256(catalogBytes)).hex;
    if (deployment.tag !== modelCatalogDeploymentTag(catalog.data.revision, catalogDigest)) {
      throw new CatalogPublicationError(
        "integrity",
        `${target} deployment tag does not match the catalog`,
      );
    }
    return Object.freeze({
      kind: "published",
      target,
      ...config,
      revision: catalog.data.revision,
      catalogDigest,
      catalogBytes,
      etag,
      ...deployment,
    });
  }

  async deploy(input: {
    readonly target: ModelCatalogTarget;
    readonly assetDirectory: string;
    readonly tag: string;
    readonly message: string;
  }): Promise<void> {
    await this.runner.run([
      "deploy",
      ...this.args(input.target),
      "--assets",
      input.assetDirectory,
      "--tag",
      input.tag,
      "--message",
      input.message,
      "--strict",
    ]);
  }

  async verify(input: {
    readonly target: ModelCatalogTarget;
    readonly catalogBytes: Uint8Array;
    readonly revision: number;
    readonly digest: string;
  }): Promise<{ readonly etag: string }> {
    return verifyModelCatalogService({
      origin: TARGETS[input.target].origin,
      expectedCatalogBytes: input.catalogBytes,
      expectedRevision: input.revision,
      expectedDigest: input.digest,
      fetcher: this.fetcher,
    });
  }

  async waitForPropagation(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
}

export function modelCatalogTargetRevision(state: ModelCatalogTargetState): number {
  return state.kind === "absent" ? 0 : state.revision;
}

function sameTargetState(left: ModelCatalogTargetState, right: ModelCatalogTargetState): boolean {
  if (left.kind !== right.kind || left.target !== right.target) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return (
    left.revision === right.revision &&
    left.catalogDigest === right.catalogDigest &&
    left.etag === right.etag &&
    left.tag === right.tag &&
    left.versionId === right.versionId &&
    left.deploymentId === right.deploymentId &&
    bytesEqual(left.catalogBytes, right.catalogBytes)
  );
}

function isIntended(
  state: ModelCatalogTargetState,
  record: ModelCatalogPublicationRecord,
  tag: string,
): state is Extract<ModelCatalogTargetState, { kind: "published" }> {
  return (
    state.kind === "published" &&
    state.revision === record.revision &&
    state.catalogDigest === record.catalogDigest &&
    state.tag === tag &&
    bytesEqual(state.catalogBytes, modelCatalogBytes(record))
  );
}

async function verifyAndReceipt(input: {
  readonly boundary: ModelCatalogCloudflareBoundary;
  readonly target: ModelCatalogTarget;
  readonly record: ModelCatalogPublicationRecord;
  readonly state: Extract<ModelCatalogTargetState, { kind: "published" }>;
  readonly tag: string;
  readonly message: string;
  readonly now: number;
  readonly uncertaintyRecovery: ModelCatalogDeploymentReceipt["uncertaintyRecovery"];
}): Promise<ModelCatalogDeploymentReceipt> {
  const verified = await input.boundary.verify({
    target: input.target,
    catalogBytes: modelCatalogBytes(input.record),
    revision: input.record.revision,
    digest: input.record.catalogDigest,
  });
  if (verified.etag !== input.state.etag) {
    throw new CatalogPublicationError(
      "conflict",
      "verified ETag differs from inspected deployment",
    );
  }
  return ModelCatalogDeploymentReceiptSchema.parse({
    formatVersion: input.record.formatVersion,
    target: input.target,
    revision: input.record.revision,
    catalogDigest: input.record.catalogDigest,
    workerName: input.state.workerName,
    versionId: input.state.versionId,
    deploymentId: input.state.deploymentId,
    liveEtag: verified.etag,
    verifiedAt: new Date(input.now).toISOString(),
    tag: input.tag,
    message: input.message,
    uncertaintyRecovery: input.uncertaintyRecovery,
  });
}

export async function reconcilePublishedModelCatalogAssets(input: {
  readonly boundary: ModelCatalogCloudflareBoundary;
  readonly target: ModelCatalogTarget;
  readonly record: ModelCatalogPublicationRecord;
  readonly state: ModelCatalogTargetState;
  readonly now: number;
}): Promise<ModelCatalogDeploymentReceipt> {
  const tag = modelCatalogDeploymentTag(input.record.revision, input.record.catalogDigest);
  if (!isIntended(input.state, input.record, tag)) {
    throw new CatalogPublicationError(
      "conflict",
      `${input.target} does not serve the archived deployment`,
    );
  }
  return verifyAndReceipt({
    ...input,
    state: input.state,
    tag,
    message: modelCatalogDeploymentMessage(input.record.revision, input.record.catalogDigest),
    uncertaintyRecovery: "reconciled-existing-intended-deployment",
  });
}

async function pollIntended(input: {
  readonly boundary: ModelCatalogCloudflareBoundary;
  readonly target: ModelCatalogTarget;
  readonly predecessor: ModelCatalogTargetState;
  readonly record: ModelCatalogPublicationRecord;
  readonly tag: string;
}): Promise<Extract<ModelCatalogTargetState, { kind: "published" }>> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const state = await input.boundary.inspect(input.target);
      if (isIntended(state, input.record, input.tag)) return state;
      if (!sameTargetState(state, input.predecessor)) {
        throw new CatalogPublicationError(
          "conflict",
          `${input.target} changed to a different state`,
        );
      }
    } catch (error) {
      if (error instanceof CatalogPublicationError && error.code === "conflict") throw error;
    }
    if (attempt < 29) await input.boundary.waitForPropagation();
  }
  throw new CatalogPublicationError(
    "uncertain",
    `${input.target} did not expose the intended deployment`,
  );
}

export async function deployModelCatalogAssets(input: {
  readonly boundary: ModelCatalogCloudflareBoundary;
  readonly target: ModelCatalogTarget;
  readonly assetDirectory: string;
  readonly predecessor: ModelCatalogTargetState;
  readonly record: ModelCatalogPublicationRecord;
  readonly now: number;
}): Promise<ModelCatalogDeploymentReceipt> {
  const before = await input.boundary.inspect(input.target);
  if (!sameTargetState(before, input.predecessor)) {
    throw new CatalogPublicationError("conflict", `${input.target} changed before deployment`);
  }
  const tag = modelCatalogDeploymentTag(input.record.revision, input.record.catalogDigest);
  const message = modelCatalogDeploymentMessage(input.record.revision, input.record.catalogDigest);
  let recovery: ModelCatalogDeploymentReceipt["uncertaintyRecovery"] = "none";
  try {
    await input.boundary.deploy({
      target: input.target,
      assetDirectory: input.assetDirectory,
      tag,
      message,
    });
  } catch {
    let afterUncertain: ModelCatalogTargetState;
    try {
      afterUncertain = await input.boundary.inspect(input.target);
    } catch {
      throw new CatalogPublicationError(
        "uncertain",
        `${input.target} state could not be inspected after deployment`,
      );
    }
    if (isIntended(afterUncertain, input.record, tag)) {
      recovery = "verified-after-uncertain-response";
      return verifyAndReceipt({
        ...input,
        state: afterUncertain,
        tag,
        message,
        uncertaintyRecovery: recovery,
      });
    }
    if (!sameTargetState(afterUncertain, input.predecessor)) {
      throw new CatalogPublicationError(
        "conflict",
        `${input.target} changed after an uncertain deployment`,
      );
    }
    recovery = "retried-after-unchanged-predecessor";
    try {
      await input.boundary.deploy({
        target: input.target,
        assetDirectory: input.assetDirectory,
        tag,
        message,
      });
    } catch {
      const afterRetry = await input.boundary.inspect(input.target);
      if (isIntended(afterRetry, input.record, tag)) {
        return verifyAndReceipt({
          ...input,
          state: afterRetry,
          tag,
          message,
          uncertaintyRecovery: recovery,
        });
      }
      if (sameTargetState(afterRetry, input.predecessor)) {
        throw new CatalogPublicationError("uncertain", `${input.target} deployment failed twice`);
      }
      throw new CatalogPublicationError(
        "conflict",
        `${input.target} changed after a deployment retry`,
      );
    }
  }
  const state = await pollIntended({ ...input, tag });
  return verifyAndReceipt({ ...input, state, tag, message, uncertaintyRecovery: recovery });
}
