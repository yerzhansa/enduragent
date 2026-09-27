import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { canonicalJson, type ArchiveManager, type ArchiveWriteResult } from "@enduragent/kernel/archive";
import {
  buildPlatformPresentation,
  readSelectedGenericRows,
  readSelectedSourceRows,
  readSourceArtifactRows,
  type SelectedGenericRow,
  type SelectedSourceRow,
  type SourceArtifactRow,
} from "@enduragent/kernel/ingest";
import type { FileSystemPort } from "@enduragent/kernel/ports";
import {
  assertReferenceCaptureReplayable,
  parseReferenceCaptureManifest,
  referenceCaptureClock,
  type RecordRef,
  type ReferenceCaptureManifest,
  type SnapshotRef,
} from "@enduragent/kernel/reference/capture";
import {
  compareReferenceCapture,
  type ReferenceCaptureComparison,
} from "@enduragent/kernel/reference/capture-once";
import {
  assertNoTpKeysRemain,
  buildFixtureShape,
  normalizeStreams,
  parseCanonicalProjectionValue,
  parseRenamedActivity,
  parseRenamedWellnessRow,
  projectCyclingReferenceBundle,
  renameTpFieldsOnActivity,
  renameTpFieldsOnWellnessRow,
  type ReferenceBundle,
  type ProducedLocalBundle,
  type VerifiedSnapshotReader,
} from "@enduragent/kernel/reference/local-bundle";
import { H, createIntervalsSourceRepository, runMigrations, type SqlReadStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createArchiveManager, createVerifiedSnapshotReader } from "@enduragent/kernel-node/archive";
import { nodeFileSystem } from "@enduragent/kernel-node/filesystem";
import { createNodeCrypto, createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import type { PlatformImportArtifact } from "@enduragent/kernel/ingest";
import {
  createIntervalsIcuSource,
  decodeLocalBundleProjection,
  mapActivityLanding,
  mapSettingsLanding,
  mapWellnessLanding,
  normalizeStreamLanding,
  type IntervalsIcuCaptureSource,
  type LocalBundleSelectedEvidence,
} from "@enduragent/sync-intervals-icu";

const execFile = promisify(execFileCallback);
const SOURCE = "intervals-icu" as const;
const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export type ReferenceCaptureEnvironmentCode =
  | "ARGUMENTS" | "INPUT_PATH" | "INPUT_PERMISSIONS" | "INPUT_SCHEMA"
  | "MANIFEST_SCHEMA" | "ARCHIVE_MEMBER" | "CAPTURE_INCOMPLETE"
  | "SCRATCH_CREATE" | "INGEST_FAILED" | "PROJECTION_FAILED"
  | "CLEANUP_FAILED" | "CONCLUSION_PATH" | "CONCLUSION_WRITE" | "INTERNAL";

export interface ReferenceCaptureConclusionV1 {
  readonly schema_version: 1;
  readonly gate: "reference-capture-once";
  readonly head_sha: string;
  readonly capture_manifest_sha256: string | null;
  readonly capture_id_sha256: string | null;
  readonly verdict: "PASS" | "MISMATCH" | "ENVIRONMENT";
  readonly fixture_bytes_equal: boolean | null;
  readonly metric_maps_complete: boolean | null;
  readonly metric_bytes_equal: boolean | null;
  readonly registry_key_count: number | null;
  readonly metric_exception_count: number;
  readonly fixture_mismatch_count: number;
  readonly metric_mismatch_count: number;
  readonly direct_metric_exception_keys: readonly string[];
  readonly projected_metric_exception_keys: readonly string[];
  readonly fixture_mismatch_families: readonly string[];
  readonly metric_mismatch_keys: readonly string[];
  readonly direct_family_counts: Readonly<Record<string, number>>;
  readonly projected_family_counts: Readonly<Record<string, number>>;
  readonly environment_code: ReferenceCaptureEnvironmentCode | null;
}

export interface ReferenceCaptureCommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
  readonly conclusion: ReferenceCaptureConclusionV1 | null;
}

interface ReferenceCaptureInputV1 {
  readonly schema_version: 1;
  readonly manifest_path: string;
  readonly archive_root: string;
}

interface CommandOptions {
  readonly captureInput: string;
  readonly conclusion: string;
}

interface CapturedPayloads {
  readonly endpoints: readonly unknown[];
  readonly records: {
    readonly settings: readonly unknown[];
    readonly activities: readonly unknown[];
    readonly wellness: readonly unknown[];
    readonly streams: readonly unknown[];
  };
}

interface FreshCaptureDestination {
  readonly storePath: string;
  readonly archiveRoot: string;
}

export interface ReferenceCaptureCommandDependencies {
  readonly inputFileSystem?: FileSystemPort;
  readonly removeScratch?: (path: string) => Promise<void>;
  readonly verifySelection?: (store: SqlReadStore, manifest: ReferenceCaptureManifest) => Promise<boolean>;
  readonly produceLocalBundle?: (destination: FreshCaptureDestination, manifest: ReferenceCaptureManifest) => Promise<ProducedLocalBundle>;
  readonly persistConclusion?: (path: string, value: ReferenceCaptureConclusionV1) => Promise<void>;
  readonly git?: (args: readonly string[], cwd: string) => Promise<string>;
}

class EnvironmentFailure extends Error {
  readonly code: ReferenceCaptureEnvironmentCode;
  constructor(code: ReferenceCaptureEnvironmentCode) {
    super(code);
    this.name = "EnvironmentFailure";
    this.code = code;
  }
}

function fail(code: ReferenceCaptureEnvironmentCode): never {
  throw new EnvironmentFailure(code);
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("capture row is invalid");
  return value as Readonly<Record<string, unknown>>;
}

function parseArgs(args: readonly string[]): CommandOptions {
  if (args.length !== 4) fail("ARGUMENTS");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if ((flag !== "--capture-input" && flag !== "--conclusion") || value === undefined
      || value.length === 0 || value.startsWith("--") || values.has(flag)) fail("ARGUMENTS");
    values.set(flag, value);
  }
  const captureInput = values.get("--capture-input"), conclusion = values.get("--conclusion");
  if (captureInput === undefined || conclusion === undefined) fail("ARGUMENTS");
  return { captureInput, conclusion };
}

function parseInput(bytes: Uint8Array): ReferenceCaptureInputV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("INPUT_SCHEMA"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("INPUT_SCHEMA");
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "archive_root,manifest_path,schema_version"
    || value.schema_version !== 1 || typeof value.manifest_path !== "string"
    || typeof value.archive_root !== "string" || !isAbsolute(value.manifest_path)
    || !isAbsolute(value.archive_root)) fail("INPUT_SCHEMA");
  return value as unknown as ReferenceCaptureInputV1;
}

function modePrivate(mode: number): boolean {
  return (mode & 0o077) === 0;
}

async function privateFile(path: string, pathCode: ReferenceCaptureEnvironmentCode): Promise<void> {
  if (!isAbsolute(path)) fail("INPUT_PATH");
  let value: Awaited<ReturnType<typeof lstat>>;
  try { value = await lstat(path); } catch { fail(pathCode); }
  if (!value.isFile() || value.isSymbolicLink()) fail(pathCode);
  if (typeof process.getuid !== "function" || value.uid !== process.getuid() || !modePrivate(value.mode)) {
    fail("INPUT_PERMISSIONS");
  }
}

async function privateRealDirectory(
  path: string,
  pathCode: ReferenceCaptureEnvironmentCode,
  permissionCode: ReferenceCaptureEnvironmentCode = pathCode,
): Promise<string> {
  if (!isAbsolute(path)) fail("INPUT_PATH");
  let value: Awaited<ReturnType<typeof lstat>>, resolved: string;
  try { value = await lstat(path); resolved = await realpath(path); } catch { fail(pathCode); }
  if (!value.isDirectory() || value.isSymbolicLink() || resolved !== path) fail(pathCode);
  if (typeof process.getuid !== "function" || value.uid !== process.getuid() || !modePrivate(value.mode)) fail(permissionCode);
  return resolved;
}

async function validateConclusionPath(path: string): Promise<void> {
  if (!isAbsolute(path)) fail("CONCLUSION_PATH");
  await privateRealDirectory(dirname(path), "CONCLUSION_PATH");
  try { await lstat(path); fail("CONCLUSION_PATH"); }
  catch (error) {
    if (error instanceof EnvironmentFailure) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("CONCLUSION_PATH");
  }
}

async function validateArchiveMembers(root: string, manifest: ReferenceCaptureManifest): Promise<void> {
  const refs: SnapshotRef[] = [
    ...manifest.endpoints.map((endpoint) => endpoint.snapshot),
    ...manifest.records.settings.map((record) => record.snapshot),
    ...manifest.records.activities.map((record) => record.snapshot),
    ...manifest.records.wellness.map((record) => record.snapshot),
    ...manifest.records.streams.map((record) => record.snapshot),
  ];
  for (const ref of refs) {
    const member = resolve(root, ref.rel_path);
    let resolved: string, value: Awaited<ReturnType<typeof lstat>>;
    try { resolved = await realpath(member); value = await lstat(member); } catch { fail("ARCHIVE_MEMBER"); }
    if (!resolved.startsWith(`${root}${sep}`) || !value.isFile() || value.isSymbolicLink()
      || typeof process.getuid !== "function" || value.uid !== process.getuid() || !modePrivate(value.mode)) {
      fail("ARCHIVE_MEMBER");
    }
  }
}

function binaryCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function binarySortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(binaryCompare);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort(binaryCompare)) === canonicalJson([...keys].sort(binaryCompare));
}

function validSortedUnique(values: unknown): values is readonly string[] {
  return Array.isArray(values) && values.every((value) => typeof value === "string")
    && canonicalJson(values) === canonicalJson(binarySortedUnique(values));
}

function validCountMap(value: unknown): value is Readonly<Record<string, number>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every(safeInteger);
}

export function validateReferenceCaptureConclusion(value: unknown): ReferenceCaptureConclusionV1 {
  const keys = ["schema_version", "gate", "head_sha", "capture_manifest_sha256", "capture_id_sha256", "verdict",
    "fixture_bytes_equal", "metric_maps_complete", "metric_bytes_equal", "registry_key_count", "metric_exception_count",
    "fixture_mismatch_count", "metric_mismatch_count", "direct_metric_exception_keys",
    "projected_metric_exception_keys", "fixture_mismatch_families", "metric_mismatch_keys", "direct_family_counts",
    "projected_family_counts", "environment_code"] as const;
  if (value === null || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, keys)) throw new TypeError("invalid conclusion");
  const row = value as unknown as ReferenceCaptureConclusionV1;
  const nullableHash = (item: unknown): boolean => item === null || typeof item === "string" && HEX_64.test(item);
  const nullableBoolean = (item: unknown): boolean => item === null || typeof item === "boolean";
  const environmentCodes: readonly ReferenceCaptureEnvironmentCode[] = ["ARGUMENTS", "INPUT_PATH", "INPUT_PERMISSIONS",
    "INPUT_SCHEMA", "MANIFEST_SCHEMA", "ARCHIVE_MEMBER", "CAPTURE_INCOMPLETE", "SCRATCH_CREATE", "INGEST_FAILED",
    "PROJECTION_FAILED", "CLEANUP_FAILED", "CONCLUSION_PATH", "CONCLUSION_WRITE", "INTERNAL"];
  if (row.schema_version !== 1 || row.gate !== "reference-capture-once" || !HEX_40.test(row.head_sha)
    || !nullableHash(row.capture_manifest_sha256) || !nullableHash(row.capture_id_sha256)
    || !["PASS", "MISMATCH", "ENVIRONMENT"].includes(row.verdict)
    || !nullableBoolean(row.fixture_bytes_equal) || !nullableBoolean(row.metric_maps_complete)
    || !nullableBoolean(row.metric_bytes_equal) || !(row.registry_key_count === null || safeInteger(row.registry_key_count))
    || !safeInteger(row.metric_exception_count) || !safeInteger(row.fixture_mismatch_count)
    || !safeInteger(row.metric_mismatch_count) || !validSortedUnique(row.direct_metric_exception_keys)
    || !validSortedUnique(row.projected_metric_exception_keys) || !validSortedUnique(row.fixture_mismatch_families)
    || !validSortedUnique(row.metric_mismatch_keys) || !validCountMap(row.direct_family_counts)
    || !validCountMap(row.projected_family_counts)
    || !(row.environment_code === null || environmentCodes.includes(row.environment_code))) throw new TypeError("invalid conclusion");
  if (row.metric_exception_count !== row.direct_metric_exception_keys.length + row.projected_metric_exception_keys.length
    || row.fixture_mismatch_count !== row.fixture_mismatch_families.length
    || row.metric_mismatch_count !== row.metric_mismatch_keys.length) throw new TypeError("invalid conclusion counts");
  const noDiagnostics = row.metric_exception_count === 0 && row.fixture_mismatch_count === 0 && row.metric_mismatch_count === 0;
  const noFamilyCounts = Object.keys(row.direct_family_counts).length === 0
    && Object.keys(row.projected_family_counts).length === 0;
  if (row.verdict === "PASS") {
    if (row.environment_code !== null || row.fixture_bytes_equal !== true || row.metric_maps_complete !== true
      || row.metric_bytes_equal !== true || row.registry_key_count === null || !noDiagnostics) throw new TypeError("invalid PASS conclusion");
  } else if (row.verdict === "MISMATCH") {
    if (row.environment_code !== null || row.fixture_bytes_equal === null || row.metric_maps_complete === null
      || row.metric_bytes_equal === null || row.registry_key_count === null
      || row.fixture_bytes_equal && row.metric_maps_complete && row.metric_bytes_equal
        && row.metric_exception_count === 0 && row.fixture_mismatch_count === 0 && row.metric_mismatch_count === 0) {
      throw new TypeError("invalid MISMATCH conclusion");
    }
  } else if (row.environment_code === null || row.fixture_bytes_equal !== null || row.metric_maps_complete !== null
    || row.metric_bytes_equal !== null || row.registry_key_count !== null || !noDiagnostics || !noFamilyCounts) {
    throw new TypeError("invalid ENVIRONMENT conclusion");
  }
  return Object.freeze(row);
}

export interface ConclusionPersistenceHooks {
  readonly beforeLink?: () => Promise<void> | void;
  readonly afterLink?: () => Promise<void> | void;
}

export async function persistReferenceCaptureConclusion(
  path: string,
  value: ReferenceCaptureConclusionV1,
  hooks: ConclusionPersistenceHooks = {},
): Promise<void> {
  const record = validateReferenceCaptureConclusion(value);
  const bytes = `${canonicalJson(record)}\n`;
  const temporary = join(dirname(path), `.reference-capture-conclusion-${createHash("sha256").update(path).digest("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const reloaded = validateReferenceCaptureConclusion(JSON.parse(await readFile(temporary, "utf8")));
    if (`${canonicalJson(reloaded)}\n` !== bytes) throw new TypeError("conclusion reload differs");
    await chmod(temporary, 0o444);
    await hooks.beforeLink?.();
    await link(temporary, path);
    await hooks.afterLink?.();
    await unlink(temporary);
    const target = await lstat(path);
    if (!target.isFile() || (target.mode & 0o777) !== 0o444 || target.nlink !== 1) throw new TypeError("conclusion seal is invalid");
    const finalBytes = await readFile(path, "utf8");
    const final = validateReferenceCaptureConclusion(JSON.parse(finalBytes));
    if (finalBytes !== bytes || `${canonicalJson(final)}\n` !== bytes) throw new TypeError("conclusion reload differs");
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (closeError) {
        if (
          typeof closeError !== "object" ||
          closeError === null ||
          !("code" in closeError) ||
          (closeError.code !== "ERR_DIR_CLOSED" && closeError.code !== "EBADF")
        ) {
          throw closeError;
        }
      }
    }
    await rm(temporary, { force: true });
    throw error;
  }
}

function replayReader(payloads: CapturedPayloads): VerifiedSnapshotReader {
  const queue = [...payloads.endpoints, ...payloads.records.settings, ...payloads.records.activities,
    ...payloads.records.wellness, ...payloads.records.streams];
  let index = 0;
  return { async readVerifiedSnapshot() {
    if (index >= queue.length) throw new TypeError("capture replay exhausted");
    return queue[index++];
  } };
}

function dummyArchive(): ArchiveManager {
  const unavailable = async (): Promise<never> => { throw new TypeError("archive access is unavailable"); };
  return { writeArtifact: unavailable, writeSnapshot: unavailable, quarantine: unavailable,
    readArtifact: unavailable, readSnapshot: unavailable, has: unavailable };
}

function replaySource(manifest: ReferenceCaptureManifest): IntervalsIcuCaptureSource {
  return createIntervalsIcuSource({ athleteId: "capture-once", historyNewestDate: manifest.plan.window.newest,
    minRequestIntervalMs: 250, archive: dummyArchive(), wallClock: { now: () => manifest.plan.capture_epoch_ms },
    async sleep() {},
    httpFactory: () => ({ async fetch() { throw new TypeError("network is unavailable"); } }),
    acl: Object.freeze({
      activity(value: Record<string, unknown>) {
        return parseRenamedActivity(renameTpFieldsOnActivity(value)) as unknown as Readonly<Record<string, unknown>>;
      },
      wellness(value: Record<string, unknown>) {
        return parseRenamedWellnessRow(renameTpFieldsOnWellnessRow(value)) as unknown as Readonly<Record<string, unknown>>;
      },
      streams(value: unknown) { return object(normalizeStreams(value)); },
      assertClean: assertNoTpKeysRemain,
    }),
  });
}

type SqliteModule = typeof import("@enduragent/kernel-node/sqlite");
let sqliteModule: Promise<SqliteModule> | undefined;

async function loadSqlite(): Promise<SqliteModule> {
  if (sqliteModule !== undefined) return sqliteModule;
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const name = warning instanceof Error ? warning.name : args[0];
    const message = warning instanceof Error ? warning.message : warning;
    if (name === "ExperimentalWarning" && message === "SQLite is an experimental feature and might change at any time") return;
    return (emitWarning as (...values: unknown[]) => void).call(process, warning, ...args);
  }) as typeof process.emitWarning;
  const sqliteSpecifier = "@enduragent/kernel-node/" + "sqlite";
  try { sqliteModule = import(sqliteSpecifier) as Promise<SqliteModule>; return await sqliteModule; }
  finally { process.emitWarning = emitWarning; }
}

function archiveEpoch(row: Readonly<Record<string, unknown>>, lane: "settings" | "activities" | "wellness"): number {
  const value = lane === "settings" ? row.updated : lane === "activities" ? row.start_date : `${String(row.id)}T00:00:00.000Z`;
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  const valid = Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds % 1_000 === 0
    && Number.isSafeInteger(milliseconds / 1_000);
  if (!valid) {
    if (lane === "settings") return 0;
    throw new TypeError("capture row time is invalid");
  }
  return milliseconds / 1_000;
}

function streamEpoch(manifest: ReferenceCaptureManifest, activityId: string, payloads: CapturedPayloads): number {
  const index = manifest.records.activities.findIndex((record) => record.external_id === activityId);
  if (index < 0) throw new TypeError("stream activity is absent");
  return archiveEpoch(object(payloads.records.activities[index]), "activities");
}

function writeResult(record: RecordRef): ArchiveWriteResult {
  return { address: record.snapshot.address, relPath: record.snapshot.rel_path, deduped: true };
}

async function directSelectedEvidence(
  manifest: ReferenceCaptureManifest,
  payloads: CapturedPayloads,
): Promise<LocalBundleSelectedEvidence> {
  const crypto = createNodeCrypto();
  const activities: SelectedSourceRow[] = [];
  for (let index = 0; index < manifest.records.activities.length; index += 1) {
    const record = manifest.records.activities[index]!, raw = object(payloads.records.activities[index]);
    const normalized = parseRenamedActivity(renameTpFieldsOnActivity(structuredClone(raw)));
    assertNoTpKeysRemain(normalized);
    const epochSeconds = archiveEpoch(raw, "activities");
    const platform = await mapActivityLanding({ normalized, archiveInstant: { epochSeconds }, archive: writeResult(record) });
    const presentation = await buildPlatformPresentation(platform, (fields) => H(crypto, ...(fields as [string | number, ...(string | number)[]])));
    const revision = record.store_evidence.current_revision;
    if (revision === null) throw new TypeError("activity revision is absent");
    activities.push({ ...presentation.row, id: revision.source_record_id, revision_id: revision.revision_id,
      artifact_key: record.store_evidence.artifact_key, archive_address: record.snapshot.address,
      archive_rel_path: record.snapshot.rel_path, archive_epoch_s: epochSeconds });
  }
  const settings: SelectedGenericRow[] = [];
  for (let index = 0; index < manifest.records.settings.length; index += 1) {
    const record = manifest.records.settings[index]!, raw = object(payloads.records.settings[index]);
    assertNoTpKeysRemain(raw);
    const mapped = await mapSettingsLanding(raw);
    const revision = record.store_evidence.current_revision;
    if (revision === null) throw new TypeError("settings revision is absent");
    settings.push({ source_record_id: revision.source_record_id, external_id: record.external_id,
      revision_id: revision.revision_id, payload_json: canonicalJson({ endpoint: "settings",
        landing: parseCanonicalProjectionValue(mapped.normalizedPayloadJson, "settings"), schema_version: 1 }),
      artifact_key: record.store_evidence.artifact_key, archive_address: record.snapshot.address,
      archive_rel_path: record.snapshot.rel_path, archive_epoch_s: mapped.archiveEpochSeconds });
  }
  const streams: SelectedGenericRow[] = [];
  for (let index = 0; index < manifest.records.streams.length; index += 1) {
    const record = manifest.records.streams[index]!, normalized = normalizeStreams(payloads.records.streams[index]);
    const landing = normalizeStreamLanding(object(normalized));
    assertNoTpKeysRemain(landing);
    const revision = record.store_evidence.current_revision;
    if (revision === null) throw new TypeError("stream revision is absent");
    const activityId = manifest.captured_stream_ids[index]!;
    streams.push({ source_record_id: revision.source_record_id, external_id: record.external_id,
      revision_id: revision.revision_id, payload_json: canonicalJson({ endpoint: "streams", landing, schema_version: 1 }),
      artifact_key: record.store_evidence.artifact_key, archive_address: record.snapshot.address,
      archive_rel_path: record.snapshot.rel_path, archive_epoch_s: streamEpoch(manifest, activityId, payloads) });
  }
  const wellness: SourceArtifactRow[] = manifest.records.wellness.map((record, index) => {
    const raw = object(payloads.records.wellness[index]);
    const normalized = parseRenamedWellnessRow(renameTpFieldsOnWellnessRow(structuredClone(raw)));
    assertNoTpKeysRemain(normalized);
    return { artifact_key: record.store_evidence.artifact_key, source: SOURCE, lane: "wellness",
      external_id: record.external_id, archive_address: record.snapshot.address,
      archive_rel_path: record.snapshot.rel_path, archive_epoch_s: archiveEpoch(raw, "wellness") };
  });
  return { activities, settings, wellness, streams };
}

class CapturedReferencePayloadSet {
  readonly manifest: ReferenceCaptureManifest;
  #payloads: CapturedPayloads | undefined;
  constructor(manifest: ReferenceCaptureManifest) { this.manifest = manifest; }

  async directBundle(reader: VerifiedSnapshotReader): Promise<ReferenceBundle> {
    const endpoints: unknown[] = [];
    const records = { settings: [] as unknown[], activities: [] as unknown[], wellness: [] as unknown[], streams: [] as unknown[] };
    let index = 0;
    const recordingReader: VerifiedSnapshotReader = { readVerifiedSnapshot: async (ref) => {
      let payload: unknown;
      try { payload = await reader.readVerifiedSnapshot(ref); }
      catch { fail("ARCHIVE_MEMBER"); }
      if (index < this.manifest.endpoints.length) endpoints.push(payload);
      else {
        let offset = index - this.manifest.endpoints.length;
        for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
          if (offset < this.manifest.records[lane].length) { records[lane].push(payload); break; }
          offset -= this.manifest.records[lane].length;
        }
      }
      index += 1;
      return payload;
    } };
    const source = replaySource(this.manifest);
    try {
      await assertReferenceCaptureReplayable(this.manifest, {
        readVerifiedSnapshot: (ref) => recordingReader.readVerifiedSnapshot(ref),
        derivePayloadMembers: (plan, endpointPayloads) => source.deriveReferenceCaptureMembers(plan, endpointPayloads),
        async assertStoreEvidence() {},
      });
    } catch (error) {
      if (error instanceof EnvironmentFailure) throw error;
      fail("CAPTURE_INCOMPLETE");
    }
    this.#payloads = Object.freeze({ endpoints: Object.freeze(endpoints), records: Object.freeze({
      settings: Object.freeze(records.settings), activities: Object.freeze(records.activities),
      wellness: Object.freeze(records.wellness), streams: Object.freeze(records.streams),
    }) });
    try {
      const selected = await directSelectedEvidence(this.manifest, this.#payloads);
      return await decodeLocalBundleProjection(this.manifest, selected, replayReader(this.#payloads));
    } catch { fail("PROJECTION_FAILED"); }
  }

  async ingestInto(destination: FreshCaptureDestination): Promise<void> {
    if (this.#payloads === undefined) throw new TypeError("capture payloads are absent");
    await ingestCapturedPayloads(this.manifest, this.#payloads, destination);
  }
}

async function writeSnapshotExact(
  archive: ArchiveManager,
  payload: unknown,
  epochSeconds: number,
  expected: SnapshotRef,
): Promise<void> {
  const written = await archive.writeSnapshot(payload, { epochSeconds });
  if (written.address !== expected.address || written.relPath !== expected.rel_path) throw new TypeError("capture archive identity changed");
}

function artifactDraft(record: RecordRef, lane: "settings" | "activities" | "wellness" | "streams", epochSeconds: number) {
  return { source: SOURCE, lane, externalId: record.external_id, artifactKind: "snapshot" as const,
    archiveAddress: record.snapshot.address, archiveRelPath: record.snapshot.rel_path, archiveEpochSeconds: epochSeconds };
}

async function ingestCapturedPayloads(
  manifest: ReferenceCaptureManifest,
  payloads: CapturedPayloads,
  destination: FreshCaptureDestination,
): Promise<void> {
  await mkdir(destination.archiveRoot, { recursive: true, mode: 0o700 });
  await mkdir(dirname(destination.storePath), { recursive: true, mode: 0o700 });
  await chmod(destination.archiveRoot, 0o700);
  await chmod(dirname(destination.storePath), 0o700);
  const crypto = createNodeCrypto(), fs = nodeFileSystem();
  const archive = createArchiveManager({ archiveRoot: destination.archiveRoot, crypto, fs });
  for (let index = 0; index < manifest.endpoints.length; index += 1) {
    const endpoint = manifest.endpoints[index]!;
    const epochSeconds = index === 0
      ? Date.parse(`${manifest.plan.window.newest}T00:00:00.000Z`) / 1_000
      : index < 3 ? Date.parse(`${manifest.plan.window.oldest}T00:00:00.000Z`) / 1_000
      : streamEpoch(manifest, endpoint.request.activity_id!, payloads);
    await writeSnapshotExact(archive, payloads.endpoints[index], epochSeconds, endpoint.snapshot);
  }
  for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
    for (let index = 0; index < manifest.records[lane].length; index += 1) {
      const record = manifest.records[lane][index]!;
      const epochSeconds = lane === "streams" ? streamEpoch(manifest, manifest.captured_stream_ids[index]!, payloads)
        : archiveEpoch(object(payloads.records[lane][index]), lane);
      await writeSnapshotExact(archive, payloads.records[lane][index], epochSeconds, record.snapshot);
    }
  }

  const { openSqliteStorage } = await loadSqlite();
  const store = openSqliteStorage(destination.storePath);
  try {
    await chmod(destination.storePath, 0o600);
    await runMigrations(store, MIGRATIONS);
    const platformRecords: PlatformImportArtifact[] = [];
    for (let index = 0; index < manifest.records.activities.length; index += 1) {
      const record = manifest.records.activities[index]!, raw = object(payloads.records.activities[index]);
      const normalized = parseRenamedActivity(renameTpFieldsOnActivity(structuredClone(raw)));
      assertNoTpKeysRemain(normalized);
      const epochSeconds = archiveEpoch(raw, "activities");
      platformRecords.push(await mapActivityLanding({ normalized, archiveInstant: { epochSeconds }, archive: writeResult(record) }));
    }
    if (platformRecords.length > 0) {
      await createNodeImportRuntime({ archiveDir: destination.archiveRoot, store })
        .importBatchWithReport({ files: [], platform_records: platformRecords });
    }
    const repository = createIntervalsSourceRepository(store, (fields) => H(crypto, ...(fields as [string | number, ...(string | number)[]])));
    await store.transaction(async () => {
      for (let index = 0; index < manifest.records.settings.length; index += 1) {
        const record = manifest.records.settings[index]!, raw = object(payloads.records.settings[index]);
        assertNoTpKeysRemain(raw);
        const mapped = await mapSettingsLanding(raw);
        const artifact = await repository.recordArtifact(artifactDraft(record, "settings", mapped.archiveEpochSeconds));
        await repository.recordGenericLanding({ externalId: mapped.sourceRecordExternalId, artifactKey: artifact.artifactKey,
          archiveAddress: record.snapshot.address, endpoint: "settings", normalizedPayloadJson: mapped.normalizedPayloadJson });
        for (const anchor of mapped.anchors) await repository.insertSyncedAnchor(anchor);
        for (const zone of mapped.zones) await repository.insertSyncedZone(zone);
      }
      for (let index = 0; index < manifest.records.wellness.length; index += 1) {
        const record = manifest.records.wellness[index]!, raw = object(payloads.records.wellness[index]);
        const normalized = parseRenamedWellnessRow(renameTpFieldsOnWellnessRow(structuredClone(raw)));
        assertNoTpKeysRemain(normalized);
        const epochSeconds = archiveEpoch(raw, "wellness");
        await repository.recordArtifact(artifactDraft(record, "wellness", epochSeconds));
        await repository.upsertWellness(await mapWellnessLanding(normalized));
      }
      for (let index = 0; index < manifest.records.streams.length; index += 1) {
        const record = manifest.records.streams[index]!, normalized = normalizeStreams(payloads.records.streams[index]);
        const landing = normalizeStreamLanding(object(normalized));
        assertNoTpKeysRemain(landing);
        const epochSeconds = streamEpoch(manifest, manifest.captured_stream_ids[index]!, payloads);
        const artifact = await repository.recordArtifact(artifactDraft(record, "streams", epochSeconds));
        await repository.recordGenericLanding({ externalId: record.external_id, artifactKey: artifact.artifactKey,
          archiveAddress: record.snapshot.address, endpoint: "streams", normalizedPayloadJson: canonicalJson(landing) });
      }
    });
  } finally {
    await store.close();
  }
}

async function defaultSelectionMismatch(store: SqlReadStore, manifest: ReferenceCaptureManifest): Promise<boolean> {
  try {
    const actual = {
      activities: await readSelectedSourceRows(store, { source: SOURCE, lane: "activities" }),
      settings: await readSelectedGenericRows(store, { source: SOURCE, lane: "settings" }),
      streams: await readSelectedGenericRows(store, { source: SOURCE, lane: "streams" }),
      wellness: await readSourceArtifactRows(store, { source: SOURCE, lane: "wellness" }),
    };
    const expectedPairs = (lane: "activities" | "settings" | "streams") => manifest.records[lane].map((record) => ({
      source_record_id: record.store_evidence.current_revision!.source_record_id,
      revision_id: record.store_evidence.current_revision!.revision_id,
      artifact_key: record.store_evidence.artifact_key,
      archive_address: record.snapshot.address,
      archive_rel_path: record.snapshot.rel_path,
      external_id: record.external_id,
    })).sort((left, right) => binaryCompare(left.source_record_id, right.source_record_id));
    const actualPairs = (lane: "activities" | "settings" | "streams") => actual[lane].map((row) => ({
      source_record_id: lane === "activities" ? (row as SelectedSourceRow).id : (row as SelectedGenericRow).source_record_id,
      revision_id: row.revision_id, artifact_key: row.artifact_key, archive_address: row.archive_address,
      archive_rel_path: row.archive_rel_path, external_id: row.external_id,
    })).sort((left, right) => binaryCompare(left.source_record_id, right.source_record_id));
    if (["activities", "settings", "streams"].some((lane) => canonicalJson(expectedPairs(lane as "activities"))
      !== canonicalJson(actualPairs(lane as "activities")))) return true;
    const expectedWellness = manifest.records.wellness.map((record) => ({
      artifact_key: record.store_evidence.artifact_key, source: SOURCE, lane: "wellness",
      external_id: record.external_id, archive_address: record.snapshot.address,
      archive_rel_path: record.snapshot.rel_path,
    })).sort((left, right) => binaryCompare(left.artifact_key, right.artifact_key));
    const actualWellness = actual.wellness.map((row) => ({ artifact_key: row.artifact_key, source: row.source,
      lane: row.lane, external_id: row.external_id, archive_address: row.archive_address,
      archive_rel_path: row.archive_rel_path })).sort((left, right) => binaryCompare(left.artifact_key, right.artifact_key));
    if (canonicalJson(expectedWellness) !== canonicalJson(actualWellness)) return true;
    return false;
  } catch { return true; }
}
async function executingHead(git: NonNullable<ReferenceCaptureCommandDependencies["git"]>): Promise<string> {
  let root: string, head: string;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], process.cwd())).replace(/\n$/, "");
    head = (await git(["rev-parse", "HEAD"], root)).replace(/\n$/, "");
  } catch { fail("INTERNAL"); }
  if (!isAbsolute(root) || !HEX_40.test(head)) fail("INTERNAL");
  return head;
}
function environmentConclusion(
  head: string,
  manifestHash: string | null,
  captureIdHash: string | null,
  code: ReferenceCaptureEnvironmentCode,
): ReferenceCaptureConclusionV1 {
  return validateReferenceCaptureConclusion({ schema_version: 1, gate: "reference-capture-once", head_sha: head,
    capture_manifest_sha256: manifestHash, capture_id_sha256: captureIdHash, verdict: "ENVIRONMENT",
    fixture_bytes_equal: null, metric_maps_complete: null, metric_bytes_equal: null, registry_key_count: null,
    metric_exception_count: 0, fixture_mismatch_count: 0, metric_mismatch_count: 0,
    direct_metric_exception_keys: [], projected_metric_exception_keys: [], fixture_mismatch_families: [],
    metric_mismatch_keys: [], direct_family_counts: {}, projected_family_counts: {}, environment_code: code });
}
function completedConclusion(
  head: string,
  manifestHash: string,
  captureIdHash: string,
  comparison: ReferenceCaptureComparison,
  selectionMismatch: boolean,
): ReferenceCaptureConclusionV1 {
  const fixtureMismatchFamilies = binarySortedUnique([
    ...comparison.fixtureMismatchFamilies,
    ...(selectionMismatch ? ["selection"] : []),
  ]);
  const directExceptions = binarySortedUnique(comparison.directMetricExceptionKeys);
  const projectedExceptions = binarySortedUnique(comparison.projectedMetricExceptionKeys);
  const metricMismatchKeys = binarySortedUnique(comparison.metricMismatchKeys);
  const pass = !selectionMismatch
    && comparison.fixtureBytesEqual
    && comparison.metricMapsComplete
    && comparison.metricBytesEqual
    && comparison.directMetricExceptionKeys.length === 0
    && comparison.projectedMetricExceptionKeys.length === 0
    && comparison.fixtureMismatchFamilies.length === 0
    && comparison.metricMismatchKeys.length === 0;
  return validateReferenceCaptureConclusion({ schema_version: 1, gate: "reference-capture-once", head_sha: head,
    capture_manifest_sha256: manifestHash, capture_id_sha256: captureIdHash, verdict: pass ? "PASS" : "MISMATCH",
    fixture_bytes_equal: comparison.fixtureBytesEqual, metric_maps_complete: comparison.metricMapsComplete,
    metric_bytes_equal: comparison.metricBytesEqual, registry_key_count: comparison.registryKeyCount,
    metric_exception_count: directExceptions.length + projectedExceptions.length,
    fixture_mismatch_count: fixtureMismatchFamilies.length, metric_mismatch_count: metricMismatchKeys.length,
    direct_metric_exception_keys: directExceptions, projected_metric_exception_keys: projectedExceptions,
    fixture_mismatch_families: fixtureMismatchFamilies, metric_mismatch_keys: metricMismatchKeys,
    direct_family_counts: comparison.directFamilyCounts, projected_family_counts: comparison.projectedFamilyCounts,
    environment_code: null });
}
function outputFor(record: ReferenceCaptureConclusionV1): ReferenceCaptureCommandResult {
  if (record.verdict === "PASS") return { exitCode: 0, stream: "stdout", conclusion: record,
    line: `REFERENCE_CAPTURE PASS fixture_equal=true metric_maps_complete=true metrics_equal=true registry_keys=${record.registry_key_count} metric_exceptions=0 fixture_mismatches=0 metric_mismatches=0` };
  if (record.verdict === "MISMATCH") return { exitCode: 1, stream: "stderr", conclusion: record,
    line: `REFERENCE_CAPTURE MISMATCH fixture_equal=${record.fixture_bytes_equal} metric_maps_complete=${record.metric_maps_complete} metrics_equal=${record.metric_bytes_equal} registry_keys=${record.registry_key_count} metric_exceptions=${record.metric_exception_count} fixture_mismatches=${record.fixture_mismatch_families.join(",") || "none"} metric_mismatches=${record.metric_mismatch_keys.join(",") || "none"}` };
  return { exitCode: 2, stream: "stderr", conclusion: record,
    line: `REFERENCE_CAPTURE ENVIRONMENT code=${record.environment_code}` };
}
function bareEnvironment(code: ReferenceCaptureEnvironmentCode): ReferenceCaptureCommandResult {
  return { exitCode: 2, stream: "stderr", conclusion: null, line: `REFERENCE_CAPTURE ENVIRONMENT code=${code}` };
}
async function finalize(
  path: string,
  record: ReferenceCaptureConclusionV1,
  persist: NonNullable<ReferenceCaptureCommandDependencies["persistConclusion"]>,
): Promise<ReferenceCaptureCommandResult> {
  try { await persist(path, record); }
  catch { return bareEnvironment("CONCLUSION_WRITE"); }
  return outputFor(record);
}
export async function runReferenceCaptureCommand(
  args: readonly string[],
  dependencies: ReferenceCaptureCommandDependencies = {},
): Promise<ReferenceCaptureCommandResult> {
  let options: CommandOptions;
  try { options = parseArgs(args); } catch { return bareEnvironment("ARGUMENTS"); }
  let input: ReferenceCaptureInputV1;
  try {
    await privateFile(options.captureInput, "INPUT_PATH");
    await validateConclusionPath(options.conclusion);
    input = parseInput(new Uint8Array(await readFile(options.captureInput)));
    await privateFile(input.manifest_path, "INPUT_PATH");
    await privateRealDirectory(input.archive_root, "INPUT_PATH", "INPUT_PERMISSIONS");
  } catch (error) {
    return bareEnvironment(error instanceof EnvironmentFailure ? error.code : "INPUT_PATH");
  }
  const git = dependencies.git ?? (async (gitArgs, cwd) => (await execFile("git", gitArgs, { cwd, encoding: "utf8" })).stdout);
  let head: string;
  try { head = await executingHead(git); } catch { return bareEnvironment("INTERNAL"); }
  let manifestHash: string | null = null, captureIdHash: string | null = null;
  const persist = dependencies.persistConclusion ?? persistReferenceCaptureConclusion;
  const environment = async (code: ReferenceCaptureEnvironmentCode): Promise<ReferenceCaptureCommandResult> => {
    if (code === "CONCLUSION_PATH" || code === "CONCLUSION_WRITE") return bareEnvironment(code);
    return finalize(options.conclusion, environmentConclusion(head, manifestHash, captureIdHash, code), persist);
  };
  let manifest: ReferenceCaptureManifest;
  try {
    const manifestBytes = new Uint8Array(await readFile(input.manifest_path));
    manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
    try { manifest = parseReferenceCaptureManifest(manifestBytes); } catch { return environment("MANIFEST_SCHEMA"); }
    captureIdHash = createHash("sha256").update(manifest.capture_id, "utf8").digest("hex");
    await validateArchiveMembers(input.archive_root, manifest);
  } catch (error) {
    return environment(error instanceof EnvironmentFailure ? error.code : "ARCHIVE_MEMBER");
  }
  const payloadSet = new CapturedReferencePayloadSet(manifest);
  const inputFs = dependencies.inputFileSystem ?? nodeFileSystem();
  const reader = createVerifiedSnapshotReader({ archiveRoot: input.archive_root, crypto: createNodeCrypto(), fs: inputFs });
  const bundleProjection = projectCyclingReferenceBundle;
  let direct: ReturnType<typeof buildFixtureShape>;
  try { direct = buildFixtureShape(bundleProjection(await payloadSet.directBundle(reader))); }
  catch (error) { return environment(error instanceof EnvironmentFailure ? error.code : "PROJECTION_FAILED"); }
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(dirname(options.conclusion), ".reference-capture-"));
    await chmod(scratch, 0o700);
  } catch {
    if (scratch !== undefined) {
      try { await (dependencies.removeScratch ?? (async (path) => rm(path, { recursive: true })))(scratch); }
      catch { return environment("CLEANUP_FAILED"); }
    }
    return environment("SCRATCH_CREATE");
  }
  const destination = { storePath: join(scratch, "store", "reference.db"), archiveRoot: join(scratch, "archive") };
  let comparison: ReferenceCaptureComparison | undefined, selectionMismatch = false;
  let environmentCode: ReferenceCaptureEnvironmentCode | null = null;
  try {
    try { await payloadSet.ingestInto(destination); }
    catch { environmentCode = "INGEST_FAILED"; }
    if (environmentCode === null) {
      try {
        const { openReadonlySqliteStorage } = await loadSqlite();
        const store = openReadonlySqliteStorage(destination.storePath);
        try { selectionMismatch = await (dependencies.verifySelection ?? defaultSelectionMismatch)(store, manifest); }
        finally { await store.close(); }
      } catch { environmentCode = "INGEST_FAILED"; }
    }
    if (environmentCode === null) {
      try {
        const produced = dependencies.produceLocalBundle === undefined
          ? await (await import(new URL("./local-bundle-producer.js", import.meta.url).href))
            .createLocalBundleProducer({ ...destination, bundleProjection }).produce(manifest)
          : await dependencies.produceLocalBundle(destination, manifest);
        const expectedClock = referenceCaptureClock(manifest.plan);
        if (
          produced.captureId !== manifest.capture_id ||
          produced.captureClock.captureEpochMs !== expectedClock.captureEpochMs ||
          produced.captureClock.civilDateTime !== expectedClock.civilDateTime ||
          produced.captureClock.calendarTimeZone !== expectedClock.calendarTimeZone
        ) {
          throw new TypeError("local bundle identity changed");
        }
        const projected = buildFixtureShape(produced.bundle);
        comparison = compareReferenceCapture({ direct, projected, frozenNow: manifest.plan.frozenNow });
      } catch { environmentCode = "PROJECTION_FAILED"; }
    }
  } finally {
    try { await (dependencies.removeScratch ?? (async (path) => rm(path, { recursive: true })))(scratch); }
    catch { environmentCode = "CLEANUP_FAILED"; comparison = undefined; }
  }
  if (environmentCode !== null || comparison === undefined) return environment(environmentCode ?? "INTERNAL");
  return finalize(options.conclusion, completedConclusion(head, manifestHash!, captureIdHash!, comparison, selectionMismatch), persist);
}
async function main(): Promise<void> {
  const result = await runReferenceCaptureCommand(process.argv.slice(2));
  (result.stream === "stdout" ? console.log : console.error)(result.line);
  process.exitCode = result.exitCode;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("REFERENCE_CAPTURE ENVIRONMENT code=INTERNAL");
    process.exitCode = 2;
  });
}
