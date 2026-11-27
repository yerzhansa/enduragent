import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { runIntervalsBackfill, runIntervalsDualPresentationAudit } from "./backfill.js";
import type { ImportReportDeps } from "@enduragent/kernel/ingest";
import { nodePeakRssBytes, validateBackfillBenchmarkRecord, type BackfillBenchmarkRecord, type BenchmarkPhaseName } from "./backfill-benchmark.js";
import { CoachStoreWriterError, withCoachStoreWriter } from "./runtime.js";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";

interface CommandOptions {
  readonly synthetic: boolean;
  readonly conclusionsOnly: boolean;
  readonly dualPresentationAudit: boolean;
  readonly batchSize: number;
  readonly requestIntervalMs: number;
  readonly perRequestTimeoutMs: number;
  readonly pageDeadlineMs: number;
  readonly role: "baseline" | "candidate" | "spike";
  readonly benchmarkRecord: string;
}

function integer(value: string | undefined, name: string): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) throw new TypeError(`invalid ${name}`);
  const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new TypeError(`invalid ${name}`); return parsed;
}

function bounded(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value === undefined ? fallback : integer(value, name);
  if (selected < minimum || selected > maximum) throw new TypeError(`invalid ${name}`);
  return selected;
}

function parseArgs(args: readonly string[]): CommandOptions {
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (["--synthetic", "--conclusions-only", "--dual-presentation-audit"].includes(arg)) { flags.add(arg); continue; }
    if (!arg.startsWith("--") || index + 1 >= args.length || args[index + 1]!.startsWith("--") || values.has(arg)) throw new TypeError("invalid command arguments");
    values.set(arg, args[++index]!);
  }
  const allowed = new Set(["--batch-size", "--request-interval-ms", "--per-request-timeout-ms", "--backfill-page-deadline-ms", "--benchmark-role", "--benchmark-record"]);
  if ([...values.keys()].some((key) => !allowed.has(key))) throw new TypeError("invalid command argument");
  const role = values.get("--benchmark-role") ?? "spike";
  if (role !== "baseline" && role !== "candidate" && role !== "spike") throw new TypeError("invalid benchmark role");
  const benchmarkRecord = values.get("--benchmark-record"); if (benchmarkRecord === undefined || benchmarkRecord.length === 0) throw new TypeError("benchmark record is required");
  return { synthetic: flags.has("--synthetic"), conclusionsOnly: flags.has("--conclusions-only"),
    dualPresentationAudit: flags.has("--dual-presentation-audit"),
    batchSize: bounded(values.get("--batch-size"), 400, 1, 1_000, "batch size"),
    requestIntervalMs: bounded(values.get("--request-interval-ms"), 250, 250, 60_000, "request interval"),
    perRequestTimeoutMs: bounded(values.get("--per-request-timeout-ms"), 30_000, 1_000, 300_000, "request timeout"),
    pageDeadlineMs: bounded(values.get("--backfill-page-deadline-ms"), 21_600_000, 60_000, 86_400_000, "page deadline"),
    role, benchmarkRecord };
}

function environment(): BackfillBenchmarkRecord["environment"] {
  const cpu = cpus()[0]?.model ?? "unknown";
  return { host_kind: "node-cli", runtime: "node", runtime_version: process.version, driver: "node:sqlite",
    os: platform(), os_version: release(), arch: process.arch,
    hardware: { model: cpu, cpu, cores: Math.max(1, cpus().length), memory_bytes: totalmem() },
    power_state: "unknown" };
}

async function sqliteSettings(env: Record<string, string | undefined>): Promise<BackfillBenchmarkRecord["sqlite_settings"]> {
  return withCoachStoreWriter(env, async ({ store }) => {
    const journal = await store.get("PRAGMA journal_mode"), synchronous = await store.get("PRAGMA synchronous"), wal = await store.get("PRAGMA wal_autocheckpoint");
    const first = (row: typeof journal): unknown => row === undefined ? undefined : Object.values(row)[0];
    const journalMode = first(journal), sync = first(synchronous), checkpoint = first(wal);
    if (typeof journalMode !== "string" || (typeof sync !== "number" && typeof sync !== "string") || typeof checkpoint !== "number" || !Number.isSafeInteger(checkpoint)) {
      throw new Error("invalid SQLite benchmark settings");
    }
    return { journal_mode: journalMode, synchronous: String(sync), wal_autocheckpoint: checkpoint, cache_state: "unknown" };
  });
}

async function finalStoreOutcome(env: Record<string, string | undefined>): Promise<BackfillBenchmarkRecord["outcome"]> {
  return withCoachStoreWriter(env, async ({ store }) => {
    const row = await store.get(`SELECT
  (SELECT count(*) FROM raw_file) + (SELECT count(*) FROM source_record) AS rows_committed_final,
  (SELECT count(*) FROM (SELECT sha256 FROM raw_file GROUP BY sha256 HAVING count(*) > 1))
    + (SELECT count(*) FROM (SELECT id FROM source_record GROUP BY id HAVING count(*) > 1)) AS duplicate_rows_final`);
    if (typeof row?.rows_committed_final !== "number" || !Number.isSafeInteger(row.rows_committed_final)
      || typeof row.duplicate_rows_final !== "number" || !Number.isSafeInteger(row.duplicate_rows_final)) {
      throw new Error("invalid final store outcome");
    }
    return { status: "completed", rows_committed_final: row.rows_committed_final,
      duplicate_rows_final: row.duplicate_rows_final };
  });
}

async function synthetic(options: CommandOptions): Promise<BackfillBenchmarkRecord> {
  const home = await mkdtemp(join(tmpdir(), "enduragent-backfill-synthetic-"));
  const started = performance.now(); const phases: { name: BenchmarkPhaseName; ms: number; count: number }[] = [];
  const archiveStarted = performance.now();
  createHash("sha256").update(new Uint8Array(16_384)).digest();
  phases.push({ name: "archive-decode", ms: performance.now() - archiveStarted, count: 1 });
  const sqliteStarted = performance.now();
  const storeDir = join(home, "store"); await mkdir(storeDir, { recursive: true });
  const store = openSqliteStorage(join(storeDir, "reference.db")); await runMigrations(store, MIGRATIONS);
  const journal = await store.get("PRAGMA journal_mode"), synchronous = await store.get("PRAGMA synchronous"), wal = await store.get("PRAGMA wal_autocheckpoint");
  const first = (row: typeof journal): unknown => row === undefined ? undefined : Object.values(row)[0];
  const journalMode = first(journal), sync = first(synchronous), checkpoint = first(wal);
  if (typeof journalMode !== "string" || (typeof sync !== "number" && typeof sync !== "string") || typeof checkpoint !== "number") {
    await store.close(); throw new Error("invalid SQLite benchmark settings");
  }
  const sqlite: BackfillBenchmarkRecord["sqlite_settings"] = { journal_mode: journalMode, synchronous: String(sync),
    wal_autocheckpoint: checkpoint, cache_state: "unknown" };
  await store.close();
  phases.push({ name: "sqlite", ms: performance.now() - sqliteStarted, count: 1 });
  const elapsed = performance.now() - started, local = phases.reduce((sum, phase) => sum + phase.ms, 0);
  return validateBackfillBenchmarkRecord({ schema_version: 1, record_id: `synthetic-${options.role}`, created_at: new Date().toISOString(), role: options.role,
    ...(options.role === "candidate" ? { baseline_record_id: "synthetic-baseline" } : {}),
    workload: { identity: "synthetic-history", fixture_id: "synthetic-history-v1", synthetic: true, row_count: 0,
      activity_count: 0, payload_bytes_total: 16_384, batch_size: options.batchSize }, environment: environment(), sqlite_settings: sqlite,
    timings: { clock_source: "monotonic", elapsed_ms: elapsed, provider_wait_ms: 0, local_compute_ms: local,
      phases, unattributed_ms: elapsed - local }, memory: { peak_rss_bytes: nodePeakRssBytes(), source: "node-resource-usage-maxrss" },
    outcome: { status: "completed", rows_committed_final: 0, duplicate_rows_final: 0 },
    diagnostics: { transactions: 1, wal_checkpoints: 0, batches: 0,
      retry_after_observations: { absent: 0, delta_seconds: 0, http_date: 0, malformed: 0, natural_429_count: 0 } },
  });
}

async function real(options: CommandOptions): Promise<BackfillBenchmarkRecord> {
  if (process.env.RUN_PRIVATE_HISTORY_GATE !== "1") throw new Error("private history gate is not authorized");
  const required = ["BACKFILL_PRIVATE_HOME", "BACKFILL_BENCHMARK_OUT", "BACKFILL_NEAR_MISS_AUDIT_OUT",
    "BACKFILL_NEAR_MISS_SIGNOFF", "INTERVALS_ICU_API_KEY", "INTERVALS_ICU_ATHLETE_ID", "BACKFILL_HISTORY_NEWEST_DATE"] as const;
  for (const name of required) if (!process.env[name]) throw new Error(`missing private history setting: ${name}`);
  if (options.benchmarkRecord !== process.env.BACKFILL_BENCHMARK_OUT) throw new Error("benchmark output must match the private environment path");
  const env = { ...process.env, ENDURAGENT_HOME: process.env.BACKFILL_PRIVATE_HOME };
  const phases: { name: BenchmarkPhaseName; ms: number; count: number }[] = [];
  let providerWaitMs = 0;
  const retryAfterObservations = { absent: 0, delta_seconds: 0, http_date: 0, malformed: 0, natural_429_count: 0 };
  const baseFetch: typeof globalThis.fetch = async (input, init) => {
    const requestStarted = performance.now();
    try {
      const response = await globalThis.fetch(input, init);
      if (response.status === 429) {
        retryAfterObservations.natural_429_count += 1;
        const header = response.headers.get("retry-after");
        if (header === null) retryAfterObservations.absent += 1;
        else if (/^[0-9]+$/.test(header) && Number.isSafeInteger(Number(header))
          && Number(header) <= Number.MAX_SAFE_INTEGER / 1_000) retryAfterObservations.delta_seconds += 1;
        else if (Number.isFinite(Date.parse(header))) retryAfterObservations.http_date += 1;
        else retryAfterObservations.malformed += 1;
      }
      return response;
    } finally { providerWaitMs += performance.now() - requestStarted; }
  };
  const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
    const sleepStarted = performance.now();
    try { await setTimeoutPromise(ms, undefined, { signal }); }
    finally { providerWaitMs += performance.now() - sleepStarted; }
  };
  if (options.dualPresentationAudit && options.batchSize !== 400) throw new Error("dual-presentation audit batch size must be 400");
  const started = performance.now();
  const measurePhase: NonNullable<ImportReportDeps["measurePhase"]> = async (name, work) => {
    const phaseStarted = performance.now();
    try { return await work(); }
    finally { phases.push({ name, ms: performance.now() - phaseStarted, count: 1 }); }
  };
  const common = { env, apiKey: process.env.INTERVALS_ICU_API_KEY!, athleteId: process.env.INTERVALS_ICU_ATHLETE_ID!,
    historyNewestDate: process.env.BACKFILL_HISTORY_NEWEST_DATE!, calendarTimeZone: "UTC",
    requestIntervalMs: options.requestIntervalMs,
    batchSize: options.batchSize, perRequestTimeoutMs: options.perRequestTimeoutMs, backfillPageDeadlineMs: options.pageDeadlineMs,
    sleep, measurePhase, baseFetch };
  const dual = options.dualPresentationAudit ? await runIntervalsDualPresentationAudit(common) : null;
  const result = dual === null ? await runIntervalsBackfill(common) : dual.bulkFit;
  if (dual !== null) {
    if (dual.rerunRawFileInserts !== 0 || dual.rerunSourceRecordInserts !== 0) throw new Error("dual-presentation rerun inserted input-lane rows");
    if (!dual.dumpBytesStable) throw new Error("dual-presentation canonical dump changed on rerun");
    await writeFile(process.env.BACKFILL_NEAR_MISS_AUDIT_OUT!, `${JSON.stringify(dual.thresholdNearMisses, null, 2)}\n`, { mode: 0o600 });
    await chmod(process.env.BACKFILL_NEAR_MISS_AUDIT_OUT!, 0o600);
  }
  const attempted = result.reports.reduce((sum, report) => sum + report.files.length, 0);
  const quarantined = result.reports.reduce((sum, report) => sum + report.files.filter((file) => file.outcome === "quarantined").length, 0);
  if (100 * quarantined / Math.max(1, attempted) > 1) throw new Error("unexplained quarantine exceeds one percent");
  const outcome = await finalStoreOutcome(env);
  const elapsed = performance.now() - started, local = phases.reduce((sum, phase) => sum + phase.ms, 0), sqlite = await sqliteSettings(env);
  return validateBackfillBenchmarkRecord({ schema_version: 1, record_id: "real-history-private", created_at: new Date().toISOString(), role: options.role,
    ...(options.role === "candidate" ? { baseline_record_id: "real-history-private-baseline" } : {}),
    workload: { identity: "real-history-private", fixture_id: "real-history-private", synthetic: false,
      row_count: result.artifacts + (dual?.activities.artifacts ?? 0), activity_count: dual?.activities.artifacts ?? result.artifacts,
      payload_bytes_total: 0, batch_size: options.batchSize }, environment: environment(), sqlite_settings: sqlite,
    timings: { clock_source: "monotonic", elapsed_ms: elapsed, provider_wait_ms: providerWaitMs, local_compute_ms: local, phases,
      unattributed_ms: elapsed - local - providerWaitMs }, memory: { peak_rss_bytes: nodePeakRssBytes(), source: "node-resource-usage-maxrss" },
    outcome,
    diagnostics: { transactions: result.pages, wal_checkpoints: 0, batches: result.pages,
      retry_after_observations: retryAfterObservations } });
}

export async function runBackfillCommand(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args); const record = options.synthetic ? await synthetic(options) : await real(options);
  await writeFile(options.benchmarkRecord, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(options.benchmarkRecord, 0o600);
  if (options.conclusionsOnly) console.log(`BACKFILL completed rows=${record.outcome.rows_committed_final} duplicates=${record.outcome.duplicate_rows_final}`);
  else console.log(JSON.stringify({ status: record.outcome.status, rows: record.outcome.rows_committed_final, duplicates: record.outcome.duplicate_rows_final }));
}

if (process.argv[1]?.endsWith("backfill-command.ts") || process.argv[1]?.endsWith("backfill-command.js")) {
  runBackfillCommand().catch((error: unknown) => {
    const stage = error instanceof CoachStoreWriterError && error.stage !== null ? ` stage=${error.stage}` : "";
    console.error(`${error instanceof Error && error.name.length > 0 ? error.name : "backfill failed"}${stage}`);
    process.exitCode = 1;
  });
}
