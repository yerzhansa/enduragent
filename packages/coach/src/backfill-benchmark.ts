export type BenchmarkRole = "baseline" | "candidate" | "spike";
export type BenchmarkPhaseName = "archive-decode" | "topology" | "sqlite";

export interface BackfillBenchmarkRecord {
  readonly schema_version: 1;
  readonly record_id: string;
  readonly created_at: string;
  readonly role: BenchmarkRole;
  readonly baseline_record_id?: string;
  readonly workload: { readonly identity: string; readonly fixture_id: string; readonly synthetic: boolean;
    readonly row_count: number; readonly activity_count?: number; readonly payload_bytes_total: number; readonly batch_size: number };
  readonly environment: { readonly host_kind: "node-cli" | "electron-main" | "electron-utility" | "other";
    readonly runtime: "node"; readonly runtime_version: string; readonly driver: "node:sqlite" | "better-sqlite3" | "other";
    readonly driver_version?: string; readonly os: string; readonly os_version: string; readonly arch: string;
    readonly hardware: { readonly model: string; readonly cpu: string; readonly cores: number; readonly memory_bytes: number };
    readonly power_state?: "ac" | "battery" | "unknown" };
  readonly sqlite_settings: { readonly journal_mode: string; readonly synchronous: string; readonly wal_autocheckpoint: number;
    readonly cache_state: "cold" | "warm" | "unknown" };
  readonly timings: { readonly clock_source: "monotonic" | "supervisor-external"; readonly elapsed_ms: number;
    readonly provider_wait_ms: number; readonly local_compute_ms: number;
    readonly phases?: readonly { readonly name: BenchmarkPhaseName; readonly ms: number; readonly count?: number }[];
    readonly unattributed_ms?: number };
  readonly memory: { readonly peak_rss_bytes: number; readonly source: "node-resource-usage-maxrss" | "macos-time-maxrss" | "other" };
  readonly outcome: { readonly status: "completed" | "killed" | "failed"; readonly rows_committed_final: number;
    readonly duplicate_rows_final: number; readonly error_kind?: string;
    readonly kill?: { readonly signal: string; readonly kill_point_rows_committed: number; readonly kill_point_batch: number };
    readonly resume?: { readonly resumed_from_record_id: string; readonly resumed_from_rows_committed: number;
      readonly rows_attempted: number; readonly duplicate_rows_attempted: number } };
  readonly diagnostics?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`invalid ${name}`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], name: string): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`invalid ${name}`);
  }
}
function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
}
function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`invalid ${name}`);
  return value;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${name}`);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`invalid ${name}`);
  return value as T;
}

const ABSOLUTE_POSIX = /^\/(?:[^/]+\/?)+$/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
const RAW_ADDRESS = /(?:^|[^0-9a-f])[0-9a-f]{64}(?:$|[^0-9a-f])/i;
const CREDENTIAL = /(?:bearer\s+|api[_ -]?key|secret[_ -]?key|sk-[A-Za-z0-9_-]{12,})/i;
const PRIVATE_IDENTITY = /(?:athlete|activity)[_:/ -]?(?:id)?[_:/ -]?[A-Za-z0-9]/i;
const INTERVALS_ATHLETE_ID = /\bi\d{8,9}\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

function assertPrivateStrings(value: unknown, path = ""): void {
  if (typeof value === "string") {
    if (ABSOLUTE_POSIX.test(value) || WINDOWS_PATH.test(value) || RAW_ADDRESS.test(value) || CREDENTIAL.test(value)
      || PRIVATE_IDENTITY.test(value) || INTERVALS_ATHLETE_ID.test(value)
      || (path !== "created_at" && ISO_DATE.test(value))) throw new TypeError("benchmark privacy violation");
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => assertPrivateStrings(item, `${path}[${index}]`)); return; }
  if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) assertPrivateStrings(item, path ? `${path}.${key}` : key);
}

export function validateBackfillBenchmarkRecord(value: unknown): BackfillBenchmarkRecord {
  const root = object(value, "benchmark record");
  exactKeys(root, ["schema_version", "record_id", "created_at", "role", "workload", "environment", "sqlite_settings", "timings", "memory", "outcome"],
    ["baseline_record_id", "diagnostics", "notes"], "benchmark record");
  if (root.schema_version !== 1) throw new TypeError("invalid benchmark schema version");
  text(root.record_id, "record id");
  const created = text(root.created_at, "creation time");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(created) || !Number.isFinite(Date.parse(created))) throw new TypeError("invalid creation time");
  const role = choice(root.role, ["baseline", "candidate", "spike"] as const, "benchmark role");
  if (role === "candidate") text(root.baseline_record_id, "baseline record id");
  const workload = object(root.workload, "workload");
  exactKeys(workload, ["identity", "fixture_id", "synthetic", "row_count", "payload_bytes_total", "batch_size"], ["activity_count"], "workload");
  text(workload.identity, "workload identity"); text(workload.fixture_id, "fixture id");
  if (typeof workload.synthetic !== "boolean") throw new TypeError("invalid synthetic flag");
  integer(workload.row_count, "row count"); integer(workload.payload_bytes_total, "payload bytes"); integer(workload.batch_size, "batch size", 1);
  if (workload.activity_count !== undefined) integer(workload.activity_count, "activity count");
  const environment = object(root.environment, "environment");
  exactKeys(environment, ["host_kind", "runtime", "runtime_version", "driver", "os", "os_version", "arch", "hardware"], ["driver_version", "power_state"], "environment");
  choice(environment.host_kind, ["node-cli", "electron-main", "electron-utility", "other"] as const, "host kind");
  if (environment.runtime !== "node" || !/^v?\d+\.\d+\.\d+/.test(text(environment.runtime_version, "runtime version"))) throw new TypeError("invalid runtime");
  choice(environment.driver, ["node:sqlite", "better-sqlite3", "other"] as const, "driver");
  text(environment.os, "operating system"); text(environment.os_version, "operating system version"); text(environment.arch, "architecture");
  if (environment.driver_version !== undefined) text(environment.driver_version, "driver version");
  if (environment.power_state !== undefined) choice(environment.power_state, ["ac", "battery", "unknown"] as const, "power state");
  const hardware = object(environment.hardware, "hardware");
  exactKeys(hardware, ["model", "cpu", "cores", "memory_bytes"], [], "hardware");
  text(hardware.model, "hardware model"); text(hardware.cpu, "CPU"); integer(hardware.cores, "cores", 1); integer(hardware.memory_bytes, "memory bytes");
  const sqlite = object(root.sqlite_settings, "SQLite settings");
  exactKeys(sqlite, ["journal_mode", "synchronous", "wal_autocheckpoint", "cache_state"], [], "SQLite settings");
  text(sqlite.journal_mode, "journal mode"); text(sqlite.synchronous, "synchronous"); integer(sqlite.wal_autocheckpoint, "WAL autocheckpoint");
  choice(sqlite.cache_state, ["cold", "warm", "unknown"] as const, "cache state");
  const timings = object(root.timings, "timings");
  exactKeys(timings, ["clock_source", "elapsed_ms", "provider_wait_ms", "local_compute_ms"], ["phases", "unattributed_ms"], "timings");
  const clockSource = choice(timings.clock_source, ["monotonic", "supervisor-external"] as const, "clock source");
  const elapsed = finite(timings.elapsed_ms, "elapsed time"), provider = finite(timings.provider_wait_ms, "provider wait"), local = finite(timings.local_compute_ms, "local compute");
  let phaseSum = 0; const phaseNames = new Set<string>();
  if (timings.phases !== undefined) {
    if (!Array.isArray(timings.phases) || timings.phases.length === 0) throw new TypeError("invalid phases");
    for (const item of timings.phases) { const phase = object(item, "phase"); exactKeys(phase, ["name", "ms"], ["count"], "phase");
      phaseNames.add(choice(phase.name, ["archive-decode", "topology", "sqlite"] as const, "phase name")); phaseSum += finite(phase.ms, "phase time");
      if (phase.count !== undefined) integer(phase.count, "phase count"); }
    if (Math.abs(phaseSum - local) > 1) throw new TypeError("local compute timing mismatch");
  }
  if (timings.unattributed_ms !== undefined) {
    if (typeof timings.unattributed_ms !== "number" || !Number.isFinite(timings.unattributed_ms)
      || Math.abs(timings.unattributed_ms - (elapsed - provider - local)) > 1 || timings.unattributed_ms < -1) throw new TypeError("unattributed timing mismatch");
  }
  const memory = object(root.memory, "memory"); exactKeys(memory, ["peak_rss_bytes", "source"], [], "memory");
  integer(memory.peak_rss_bytes, "peak RSS"); choice(memory.source, ["node-resource-usage-maxrss", "macos-time-maxrss", "other"] as const, "memory source");
  const outcome = object(root.outcome, "outcome");
  exactKeys(outcome, ["status", "rows_committed_final", "duplicate_rows_final"], ["error_kind", "kill", "resume"], "outcome");
  const status = choice(outcome.status, ["completed", "killed", "failed"] as const, "outcome status");
  integer(outcome.rows_committed_final, "committed rows"); const duplicates = integer(outcome.duplicate_rows_final, "duplicate rows");
  if (status === "completed") {
    if (clockSource !== "monotonic" || duplicates !== 0 || timings.phases === undefined
      || !phaseNames.has("archive-decode") || !phaseNames.has("sqlite")) throw new TypeError("invalid completed benchmark");
  }
  if (outcome.error_kind !== undefined) text(outcome.error_kind, "error kind");
  if (outcome.kill !== undefined) { const kill = object(outcome.kill, "kill"); exactKeys(kill, ["signal", "kill_point_rows_committed", "kill_point_batch"], [], "kill");
    text(kill.signal, "kill signal"); integer(kill.kill_point_rows_committed, "kill rows"); integer(kill.kill_point_batch, "kill batch"); }
  if (outcome.resume !== undefined) { const resume = object(outcome.resume, "resume"); exactKeys(resume,
    ["resumed_from_record_id", "resumed_from_rows_committed", "rows_attempted", "duplicate_rows_attempted"], [], "resume");
    text(resume.resumed_from_record_id, "resumed record"); integer(resume.resumed_from_rows_committed, "resumed rows");
    integer(resume.rows_attempted, "attempted rows"); integer(resume.duplicate_rows_attempted, "attempted duplicate rows"); }
  if (root.diagnostics !== undefined) {
    const diagnostics = object(root.diagnostics, "diagnostics");
    for (const key of ["transactions", "wal_checkpoints", "batches"] as const) {
      if (diagnostics[key] !== undefined) integer(diagnostics[key], key.replaceAll("_", " "));
    }
    const retry = diagnostics.retry_after_observations;
    if (retry !== undefined) { const values = object(retry, "retry diagnostics"); exactKeys(values,
      ["absent", "delta_seconds", "http_date", "malformed", "natural_429_count"], [], "retry diagnostics");
      const sum = integer(values.absent, "absent retries") + integer(values.delta_seconds, "delta retries")
        + integer(values.http_date, "date retries") + integer(values.malformed, "malformed retries");
      if (sum !== integer(values.natural_429_count, "natural retry count")) throw new TypeError("retry diagnostic count mismatch"); }
  }
  if (root.notes !== undefined) text(root.notes, "notes");
  assertPrivateStrings(root);
  return root as unknown as BackfillBenchmarkRecord;
}

function major(version: string): string { return /^v?(\d+)/.exec(version)?.[1] ?? ""; }
function sqliteMs(record: BackfillBenchmarkRecord): number {
  return record.timings.phases?.filter((phase) => phase.name === "sqlite").reduce((sum, phase) => sum + phase.ms, 0) ?? 0;
}

export interface BenchmarkComparison { readonly comparable: boolean; readonly reasons: readonly string[]; readonly driverInvestigation: boolean; }

export function compareBackfillBenchmarks(baselineValue: unknown, candidateValue: unknown): BenchmarkComparison {
  const baseline = validateBackfillBenchmarkRecord(baselineValue), candidate = validateBackfillBenchmarkRecord(candidateValue);
  const reasons: string[] = [];
  const equal = (ok: boolean, reason: string): void => { if (!ok) reasons.push(reason); };
  equal(baseline.workload.fixture_id === candidate.workload.fixture_id, "fixture");
  equal(baseline.environment.host_kind === "node-cli" && candidate.environment.host_kind === "node-cli", "host-kind");
  equal(baseline.environment.driver === candidate.environment.driver, "driver");
  equal(major(baseline.environment.runtime_version) === major(candidate.environment.runtime_version), "runtime-major");
  equal(baseline.environment.hardware.model === candidate.environment.hardware.model, "hardware-model");
  equal(baseline.sqlite_settings.journal_mode === candidate.sqlite_settings.journal_mode, "journal-mode");
  equal(baseline.sqlite_settings.synchronous === candidate.sqlite_settings.synchronous, "synchronous");
  equal(baseline.sqlite_settings.wal_autocheckpoint === candidate.sqlite_settings.wal_autocheckpoint, "wal-autocheckpoint");
  equal(baseline.sqlite_settings.cache_state === candidate.sqlite_settings.cache_state, "cache-state");
  const comparable = reasons.length === 0;
  const localRatio = candidate.timings.local_compute_ms / baseline.timings.local_compute_ms;
  const sqliteRatio = sqliteMs(candidate) / sqliteMs(baseline);
  return Object.freeze({ comparable, reasons: Object.freeze(reasons),
    driverInvestigation: comparable && localRatio > 2 && sqliteRatio > 2 });
}

export function nodePeakRssBytes(): number { return Math.round(process.resourceUsage().maxRSS * 1_024); }
