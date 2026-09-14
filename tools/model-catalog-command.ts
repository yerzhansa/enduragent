import { readFileSync, statSync } from "node:fs";
import {
  ModelCatalogDraftSchema,
  ModelCatalogSnapshotSchema,
  type ModelCatalogDraft,
} from "@enduragent/coach-contract/model-catalog";
import {
  CatalogPublicationError,
  ModelCatalogPublicationFileSchema,
  diffModelCatalogs,
  publishModelCatalog,
  rollbackModelCatalog,
  validateModelCatalogPublicationFile,
  type CatalogDiff,
  type ModelCatalogPublicationStore,
} from "./model-catalog-publication.js";
import { MODEL_CATALOG_PUBLICATION_MAX_BYTES } from "./model-catalog-constants.js";
import {
  ModelCatalogR2Store,
  modelCatalogR2ConfigFromEnvironment,
} from "./model-catalog-r2-store.js";

export interface ModelCatalogCommandDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly output: (line: string) => void;
  readonly createStore: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => ModelCatalogPublicationStore;
}

function defaultDependencies(): ModelCatalogCommandDependencies {
  return {
    environment: process.env,
    now: Date.now,
    output: (line) => process.stdout.write(`${line}\n`),
    createStore: (environment) =>
      new ModelCatalogR2Store(modelCatalogR2ConfigFromEnvironment(environment)),
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
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
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
  if (command === "publish") {
    const paths = positionals(args, ["--expect-revision"]);
    if (paths.length !== 1) {
      throw new CatalogPublicationError("validation", "models:publish needs one catalog file");
    }
    const expectedRevision = parseRevision(
      flagValue(args, "--expect-revision"),
      "--expect-revision",
    );
    const receipt = await publishModelCatalog({
      store: dependencies.createStore(dependencies.environment),
      expectedRevision,
      publicationFile: readJson(paths[0]),
      now: dependencies.now(),
    });
    writeDiff(receipt.diff, dependencies.output);
    dependencies.output(JSON.stringify(receipt));
    return;
  }
  if (command === "rollback") {
    const values = positionals(args, ["--expect-revision"]);
    if (values.length !== 1) {
      throw new CatalogPublicationError("validation", "models:rollback needs one source revision");
    }
    const receipt = await rollbackModelCatalog({
      store: dependencies.createStore(dependencies.environment),
      sourceRevision: parseRevision(values[0], "source revision"),
      expectedRevision: parseRevision(flagValue(args, "--expect-revision"), "--expect-revision"),
      now: dependencies.now(),
    });
    writeDiff(receipt.diff, dependencies.output);
    dependencies.output(JSON.stringify(receipt));
    return;
  }
  throw new CatalogPublicationError(
    "validation",
    "use validate, publish, or rollback through the package scripts",
  );
}

export function publicModelCatalogCommandError(error: unknown): string {
  if (error instanceof CatalogPublicationError) return `${error.code}: ${error.message}`;
  if (
    error instanceof Error &&
    /^ENDURAGENT_MODEL_CATALOG_[A-Z_]+ is missing or invalid$/u.test(error.message)
  ) {
    return error.message;
  }
  return "model catalog command failed";
}
