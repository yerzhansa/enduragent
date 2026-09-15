import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelCatalogSnapshot } from "@enduragent/coach-contract/model-catalog";
import { BUNDLED_MODEL_CATALOG } from "../packages/core/src/model-catalog-seed.js";
import { MODEL_CATALOG_PUBLIC_URL } from "./model-catalog-constants.js";
import {
  assertArtifactMatchesGroup,
  BundledCatalogExtractError,
  extractBundledCatalog,
  type ArtifactLocator,
  type DockerCommandRunner,
} from "./extract-bundled-model-catalog.js";
import { createGitHubReleasePinStore } from "./model-catalog-release-pin-github.js";
import {
  CatalogReleasePinError,
  IsoTimestampSchema,
  MATERIALIZED_MODEL_CATALOG_SEED_PATH,
  ReleaseBindingSchema,
  ReleaseGroupIdSchema,
  materializeReleaseCatalog,
  prepareReleaseGroup,
  readReleaseGroup,
  type IsoTimestamp,
  type ModelCatalogProductionFetch,
  type ModelCatalogProductionFetchResult,
  type PreparedRelease,
  type ReleaseBinding,
  type ReleasePinStore,
} from "./model-catalog-release-pin.js";

const PREPARE_FLAGS = ["--now-iso", "--workspace", "--source-commit"] as const;
const EXTRACT_FLAGS = [
  "--now-iso",
  "--workspace",
  "--kind",
  "--path",
  "--reference",
  "--image",
  "--platform",
  "--expected-release-group-id",
  "--expected-revision",
  "--expected-digest",
] as const;
const GITHUB_COMMITTER_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

type PinVerb = "prepare" | "read" | "materialize";
type ExtractKind = ArtifactLocator["kind"];

type ReleasePinCommand =
  | {
      readonly verb: PinVerb;
      readonly nowIso: IsoTimestamp;
      readonly workspaceRoot: string;
      readonly sourceCommit: string;
    }
  | {
      readonly verb: "extract";
      readonly nowIso: IsoTimestamp;
      readonly workspaceRoot: string;
      readonly artifact: ArtifactLocator;
      readonly expected: ReleaseBinding | undefined;
    };

export type ModelCatalogReleasePinCommandDependencies = {
  readonly store?: ReleasePinStore;
  readonly fetchProductionCatalog?: ModelCatalogProductionFetch;
  readonly seed?: ModelCatalogSnapshot;
  readonly output?: (line: string) => void;
  readonly githubOutput?: (name: string, value: string) => void;
  readonly fetch?: typeof fetch;
  readonly docker?: DockerCommandRunner;
  readonly env?: NodeJS.Dict<string>;
  readonly createStore?: () => ReleasePinStore;
};

function validation(message: string): CatalogReleasePinError {
  return new CatalogReleasePinError("validation", message);
}

function parseNamedFlags(args: readonly string[]): {
  readonly flags: Map<string, string[]>;
  readonly positionals: string[];
} {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw validation(`${arg} needs a value`);
    }
    const existing = flags.get(arg) ?? [];
    existing.push(value);
    flags.set(arg, existing);
    index += 1;
  }
  return { flags, positionals };
}

function once(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw validation(`${name} may appear once`);
  return values[0];
}

function requireFlag(flags: Map<string, string[]>, name: string): string {
  const value = once(flags, name);
  if (value === undefined) throw validation(`${name} is required`);
  return value;
}

function rejectUnknown(flags: Map<string, string[]>, allowed: readonly string[]): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) throw validation(`unknown option ${name}`);
  }
}

function parseNowIso(value: string | undefined): IsoTimestamp {
  if (value === undefined) throw validation("--now-iso is required");
  const parsed = IsoTimestampSchema.safeParse(value);
  if (!parsed.success) throw validation("--now-iso is not a valid timestamp");
  return parsed.data;
}

function parseSourceCommit(value: string): string {
  const parsed = ReleaseGroupIdSchema.safeParse(value);
  if (!parsed.success) {
    throw validation("--source-commit must be a 40-character lowercase hex digest");
  }
  return parsed.data;
}

function parseExpectedBinding(input: {
  readonly releaseGroupId: string | undefined;
  readonly revision: string | undefined;
  readonly digest: string | undefined;
}): ReleaseBinding | undefined {
  const present = [input.releaseGroupId, input.revision, input.digest].filter(
    (value) => value !== undefined,
  );
  if (present.length === 0) return undefined;
  if (present.length !== 3) {
    throw validation(
      "--expected-release-group-id, --expected-revision, and --expected-digest are required together",
    );
  }
  const parsed = ReleaseBindingSchema.safeParse({
    releaseGroupId: input.releaseGroupId,
    revision: Number(input.revision),
    digest: input.digest,
  });
  if (!parsed.success) throw validation("expected catalog binding is invalid");
  return parsed.data;
}

function parseOciImage(value: string): "cycling-coach" | "enduragent" {
  if (value === "cycling-coach" || value === "enduragent") return value;
  throw validation("--image must be cycling-coach or enduragent");
}

function parseOciPlatform(value: string): "linux/amd64" | "linux/arm64" {
  if (value === "linux/amd64" || value === "linux/arm64") return value;
  throw validation("--platform must be linux/amd64 or linux/arm64");
}

function parseExtractArtifact(flags: Map<string, string[]>): ArtifactLocator {
  const kind = requireFlag(flags, "--kind") as ExtractKind | string;
  const path = once(flags, "--path");
  const reference = once(flags, "--reference");
  const image = once(flags, "--image");
  const platform = once(flags, "--platform");
  if (kind === "npm-tarball" || kind === "macos-zip" || kind === "windows-unpacked") {
    if (reference !== undefined || image !== undefined || platform !== undefined) {
      throw validation(`${kind} uses --path`);
    }
    if (path === undefined) throw validation("--path is required");
    return { kind, path };
  }
  if (kind === "oci-image") {
    if (path !== undefined) throw validation("oci-image uses --reference, --image, and --platform");
    if (reference === undefined || image === undefined || platform === undefined) {
      throw validation("oci-image requires --reference, --image, and --platform");
    }
    return {
      kind,
      reference,
      image: parseOciImage(image),
      platform: parseOciPlatform(platform),
    };
  }
  throw validation("--kind must be npm-tarball, macos-zip, windows-unpacked, or oci-image");
}

function parseCommand(argv: readonly string[]): ReleasePinCommand {
  const [verb, ...rest] = argv;
  if (verb !== "prepare" && verb !== "read" && verb !== "materialize" && verb !== "extract") {
    throw validation("use prepare, read, materialize, or extract");
  }
  const { flags, positionals } = parseNamedFlags(rest);
  if (positionals.length !== 0) throw validation("unexpected argument");
  const nowIso = parseNowIso(once(flags, "--now-iso"));
  const workspaceRoot = resolve(once(flags, "--workspace") ?? process.cwd());
  if (verb === "extract") {
    rejectUnknown(flags, EXTRACT_FLAGS);
    return {
      verb,
      nowIso,
      workspaceRoot,
      artifact: parseExtractArtifact(flags),
      expected: parseExpectedBinding({
        releaseGroupId: once(flags, "--expected-release-group-id"),
        revision: once(flags, "--expected-revision"),
        digest: once(flags, "--expected-digest"),
      }),
    };
  }
  rejectUnknown(flags, PREPARE_FLAGS);
  return {
    verb,
    nowIso,
    workspaceRoot,
    sourceCommit: parseSourceCommit(requireFlag(flags, "--source-commit")),
  };
}

async function fetchProductionFromHttp(
  fetchImpl: typeof fetch,
  url: typeof MODEL_CATALOG_PUBLIC_URL,
): Promise<ModelCatalogProductionFetchResult> {
  try {
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      await response.arrayBuffer();
      return { kind: "unavailable" };
    }
    const etag = response.headers.get("etag") ?? "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (etag.length === 0) return { kind: "unavailable" };
    return { kind: "response", etag, bytes };
  } catch {
    return { kind: "unavailable" };
  }
}

function githubFileOutput(path: string): (name: string, value: string) => void {
  return (name, value) => {
    if (/[\r\n]/u.test(value)) throw validation("Invalid workflow output");
    appendFileSync(path, `${name}=${value}\n`);
  };
}

function resolveGithubOutput(
  deps: ModelCatalogReleasePinCommandDependencies,
  env: NodeJS.Dict<string>,
): ((name: string, value: string) => void) | undefined {
  if (deps.githubOutput !== undefined) return deps.githubOutput;
  const path = env.GITHUB_OUTPUT;
  if (typeof path !== "string" || path.length === 0) return undefined;
  return githubFileOutput(path);
}

function resolveStore(
  deps: ModelCatalogReleasePinCommandDependencies,
  env: NodeJS.Dict<string>,
  nowIso: IsoTimestamp,
): ReleasePinStore {
  if (deps.store !== undefined) return deps.store;
  if (deps.createStore !== undefined) return deps.createStore();
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw validation("GH_TOKEN or GITHUB_TOKEN is required");
  }
  const actor = env.GITHUB_ACTOR;
  return createGitHubReleasePinStore({
    repository: "yerzhansa/enduragent",
    token,
    fetch: deps.fetch ?? globalThis.fetch,
    committer: {
      name: typeof actor === "string" && actor.length > 0 ? actor : "github-actions",
      email: GITHUB_COMMITTER_EMAIL,
      date: nowIso,
    },
  });
}

function pinPayload(prepared: PreparedRelease): {
  readonly catalog: ReleaseBinding;
  readonly kind: PreparedRelease["record"]["kind"];
  readonly acquisition: PreparedRelease["record"]["acquisition"];
} {
  return {
    catalog: prepared.binding,
    kind: prepared.record.kind,
    acquisition: prepared.record.acquisition,
  };
}

function emitGithubPin(
  write: ((name: string, value: string) => void) | undefined,
  prepared: PreparedRelease,
): void {
  if (write === undefined) return;
  write("catalog_release_group_id", prepared.binding.releaseGroupId);
  write("catalog_revision", String(prepared.binding.revision));
  write("catalog_digest", prepared.binding.digest);
  write("catalog_kind", prepared.record.kind);
  write("catalog_acquisition", prepared.record.acquisition);
}

function writeJson(
  output: (line: string) => void,
  value: Record<string, unknown>,
): void {
  output(JSON.stringify(value));
}

export async function runModelCatalogReleasePinCommand(
  args: readonly string[],
  deps: ModelCatalogReleasePinCommandDependencies = {},
): Promise<void> {
  const command = parseCommand(args);
  const env = deps.env ?? process.env;
  const seed = deps.seed ?? BUNDLED_MODEL_CATALOG;
  const output = deps.output ?? ((line) => process.stdout.write(`${line}\n`));
  const githubOutput = resolveGithubOutput(deps, env);
  if (command.verb === "extract") {
    const extracted = await extractBundledCatalog(command.artifact, { docker: deps.docker });
    if (command.expected !== undefined) {
      assertArtifactMatchesGroup(extracted, command.expected);
    }
    writeJson(output, {
      ...(command.expected === undefined ? {} : { catalog: command.expected }),
      kind: extracted.artifact.kind,
      digest: extracted.digest,
      revision: extracted.revision,
    });
    return;
  }
  const store = resolveStore(deps, env, command.nowIso);
  if (command.verb === "prepare") {
    const fetch =
      deps.fetchProductionCatalog ??
      ((url) => fetchProductionFromHttp(deps.fetch ?? globalThis.fetch, url));
    const prepared = await prepareReleaseGroup({
      sourceCommit: command.sourceCommit,
      store,
      fetch,
      acquisitionTime: command.nowIso,
      seed,
    });
    writeJson(output, pinPayload(prepared));
    emitGithubPin(githubOutput, prepared);
    return;
  }
  const prepared = await readReleaseGroup({
    sourceCommit: command.sourceCommit,
    store,
    seed,
  });
  if (command.verb === "read") {
    writeJson(output, pinPayload(prepared));
    emitGithubPin(githubOutput, prepared);
    return;
  }
  await materializeReleaseCatalog({
    prepared,
    workspaceRoot: command.workspaceRoot,
  });
  writeJson(output, {
    ...pinPayload(prepared),
    path: MATERIALIZED_MODEL_CATALOG_SEED_PATH,
  });
  emitGithubPin(githubOutput, prepared);
}

export function publicModelCatalogReleasePinError(error: unknown): string {
  if (error instanceof CatalogReleasePinError || error instanceof BundledCatalogExtractError) {
    return `${error.code}: ${error.message}`;
  }
  return "model catalog release pin command failed";
}
