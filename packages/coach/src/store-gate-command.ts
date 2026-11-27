import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  SENDER_ID_RE,
  bootstrapReference,
  loadAllowedSendersWithSource,
  loadConfig,
  resolveConfigSecrets,
  wrapFetchWithSignal,
} from "@enduragent/core";
import { resolveAthleteHome } from "@enduragent/kernel-node/home";
import { cyclingSport } from "@enduragent/sport-cycling";
import {
  createPhysicalRequestLedger,
  PhysicalRequestLimitError,
  type PhysicalRequestCounts,
  type RefreshRequestTag,
  type SyncBudget,
} from "@enduragent/kernel/store";
import type { HttpPort } from "@enduragent/kernel/ports";
import { createRequester, type PhysicalRequestLedger } from "@enduragent/sync-intervals-icu";
import { createStoreRuntime, type StoreRuntime } from "./store-runtime.js";
import {
  createOverlapConclusion,
  createSoakConclusion,
  parseOverlapEvidence,
  parseSoakEvidence,
  validateOverlapPair,
  validateOverlapScratch,
  validateSoakPair,
  type Attempt,
  type OverlapEvidence,
  type SoakEvidence,
  type WindowEvidence,
} from "./soak-record.js";

const TELEGRAM_TOKEN = /^([1-9]\d*):[A-Za-z0-9_-]{20,}$/;

function currentHead(): string {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Current HEAD is invalid.");
  return head;
}

function assertFile(path: string, mode: 0o600 | 0o444): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== mode) {
    throw new Error("Private evidence file type or mode is invalid.");
  }
}

function exclusiveWriteBytes(path: string, bytes: Uint8Array, finalMode: 0o600 | 0o444): void {
  const handle = openSync(path, "wx", 0o600);
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  chmodSync(path, finalMode);
}

function exclusiveWrite(path: string, value: unknown, finalMode: 0o600 | 0o444): void {
  exclusiveWriteBytes(path, Buffer.from(`${JSON.stringify(value)}\n`), finalMode);
}

function readJson(path: string, mode: 0o600 | 0o444): { bytes: Uint8Array; value: unknown } {
  assertFile(path, mode);
  const bytes = readFileSync(path);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("Private evidence JSON is invalid."); }
  return { bytes, value };
}

async function scratchEvidence(headSha: string): Promise<OverlapEvidence> {
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  const attempts: Attempt[] = [];
  let tick = 0;
  const observeCharge = (
    path: "store" | "legacy",
    tag: RefreshRequestTag,
    charge: () => void,
  ): void => {
    const seq = attempts.length + 1;
    const started = ++tick;
    try {
      charge();
      attempts.push({ seq, path, tag, started_ms: started, finished_ms: 0, outcome: "ok" });
    } catch (error) {
      if (!(error instanceof PhysicalRequestLimitError)) throw error;
      attempts.push({ seq, path, tag, started_ms: started, finished_ms: ++tick, outcome: "limit-rejected" });
      throw error;
    }
  };
  const observingLedger: PhysicalRequestLedger = Object.freeze({
    charge(path: "store" | "legacy", tag: RefreshRequestTag): void {
      observeCharge(path, tag, () => ledger.charge(path, tag));
    },
    tryReserve(path: "store" | "legacy", tag: RefreshRequestTag, count: number) {
      const reservation = ledger.tryReserve(path, tag, count);
      if (reservation === null) return null;
      return Object.freeze({
        charge(): void {
          observeCharge(path, tag, () => reservation.charge());
        },
        release(): void {
          reservation.release();
        },
        remaining(): number {
          return reservation.remaining();
        },
      });
    },
    snapshot: () => ledger.snapshot(),
  });
  const finish = (path: "store" | "legacy", outcome: Attempt["outcome"]): void => {
    let attempt: Attempt | undefined;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const candidate = attempts[index]!;
      if (candidate.path === path && candidate.finished_ms === 0) { attempt = candidate; break; }
    }
    if (attempt === undefined) throw new Error("Scratch attempt observation failed.");
    attempt.finished_ms = ++tick;
    attempt.outcome = outcome;
  };
  let monotonic = 0;
  const makeBudget = (signal: AbortSignal): SyncBudget => ({ signal,
    clock: { monotonicNow: () => { monotonic += 1_000; return monotonic; } },
    deadlineMonotonicMs: 600_000, perRequestTimeoutMs: 30_000, maxRequests: 64, maxArtifacts: 1_000 });
  const response = (status: number) => ({ status, headers: {}, body: new Uint8Array([1]) });
  const requester = (http: HttpPort, controller = new AbortController(),
    sleep: (ms: number, signal: AbortSignal) => Promise<void> = async () => {}) => createRequester({
      http, budget: makeBudget(controller.signal), minRequestIntervalMs: 250,
      wallClock: { now: () => 0 }, sleep, attemptLedger: observingLedger,
    });
  const normalHttp: HttpPort = { fetch: async () => { finish("store", "ok"); return response(200); } };
  const left = requester(normalHttp), right = requester(normalHttp);
  await Promise.all(Array.from({ length: 60 }, (_, index) =>
    (index % 2 === 0 ? left : right).request(
      (["settings", "activities", "wellness", "streams"] as const)[index % 4]!,
      { method: "GET", url: `http://127.0.0.1/scratch/${index}` },
    )));

  let retryFetches = 0;
  const retry = requester({ fetch: async () => {
    retryFetches += 1;
    const failed = retryFetches === 1;
    finish("store", failed ? "http-error" : "ok");
    return response(failed ? 503 : 200);
  } });
  await retry.request("activities", { method: "GET", url: "http://127.0.0.1/scratch/retry" });

  const abortController = new AbortController();
  const aborting = requester({ fetch: async () => { finish("store", "http-error"); return response(503); } },
    abortController, async (_ms, signal) => {
      abortController.abort(new DOMException("scratch cancellation", "AbortError"));
      throw signal.reason;
    });
  let cancelPropagated = false;
  try {
    await aborting.request("wellness", { method: "GET", url: "http://127.0.0.1/scratch/abort" });
  } catch (error) {
    cancelPropagated = error instanceof DOMException && error.name === "AbortError";
  }
  await left.request("settings", { method: "GET", url: "http://127.0.0.1/scratch/final" });

  const legacyController = new AbortController();
  const legacyFetch = wrapFetchWithSignal({ outer: legacyController.signal, perRequestMs: 30_000,
    attemptLedger: observingLedger, baseFetch: async () => { finish("legacy", "ok"); return new Response("ok"); } });
  const legacyResults = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
    legacyFetch(`http://127.0.0.1/scratch/legacy/${index}`)));
  const counts = ledger.snapshot();
  if (!cancelPropagated || retryFetches !== 2
    || legacyResults.filter((result) => result.status === "fulfilled").length !== 15
    || legacyResults.filter((result) => result.status === "rejected").length !== 1
    || counts.storeRequests !== 64 || counts.legacyRequests !== 15 || counts.totalRequests !== 79
    || attempts.some((attempt) => attempt.finished_ms === 0)) {
    throw new Error("Scratch request accounting failed.");
  }
  return { schema_version: 1, head_sha: headSha,
    scratch: { attempts, elapsed_ms: Math.max(1, tick), completed: true,
      rate_limited: false, cancel_propagated: cancelPropagated }, real: null };
}

function attemptsFromCounts(counts: PhysicalRequestCounts): Attempt[] {
  const attempts: Attempt[] = [];
  const push = (path: Attempt["path"], tag: Attempt["tag"], count: number): void => {
    for (let index = 0; index < count; index += 1) {
      const seq = attempts.length + 1;
      attempts.push({ seq, path, tag, started_ms: seq, finished_ms: seq, outcome: "ok" });
    }
  };
  push("store", "store:settings", counts.byTag["store:settings"]);
  push("store", "store:activities", counts.byTag["store:activities"]);
  push("store", "store:analytics-curves", counts.byTag["store:analytics-curves"]);
  push("store", "store:wellness", counts.byTag["store:wellness"]);
  push("store", "store:streams", counts.byTag["store:streams"]);
  push("legacy", "legacy:reference", counts.byTag["legacy:reference"]);
  return attempts;
}

async function runRealWindow(): Promise<WindowEvidence> {
  const config = await resolveConfigSecrets(loadConfig());
  if (config.dataSource !== "store") throw new Error("Real overlap gate requires data_source: store.");
  const env = process.env;
  const home = resolveAthleteHome(env);
  let runtime: StoreRuntime | undefined;
  const reference = await bootstrapReference({ dataDir: config.dataDir, intervals: config.intervals,
    readCalendarTimeZone: () => config.session.timezone,
    sport: cyclingSport, startScheduler: false, attemptLedgerForRun: () => {
      if (runtime === undefined) throw new Error("Store runtime is unavailable.");
      return runtime.attemptLedgerForRun();
    } });
  runtime = createStoreRuntime({ env, config, home, reference });
  const started = Date.now();
  try {
    const result = await runtime.runWindow();
    return { attempts: attemptsFromCounts(result.counts), elapsed_ms: Math.max(1, Date.now() - started),
      completed: result.published && result.legacySucceeded, rate_limited: false, cancel_propagated: false };
  } finally {
    await runtime.close();
    reference.scheduler.stop();
  }
}

export function assertDogfoodIsolation(input: { envPath: string; dataDir: string }): {
  token: string; operatorId: string;
} {
  assertFile(input.envPath, 0o600);
  const values = new Map<string, string>();
  const lines = readFileSync(input.envPath, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line === "")) throw new Error("Dogfood environment file is invalid.");
  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9_]*)=([^\s'"`$\\]+)$/.exec(line);
    if (match === null || values.has(match[1]!)) throw new Error("Dogfood environment file is invalid.");
    values.set(match[1]!, match[2]!);
  }
  const required = ["TELEGRAM_BOT_TOKEN", "CYCLING_COACH_OPERATOR_ID", "DOGFOOD_BOT_ATTESTED",
    "HOSTED_POLLER_STOPPED", "CYCLING_COACH_DM_POLICY"] as const;
  for (const key of required) if (!values.has(key)) throw new Error("Dogfood environment is incomplete.");
  const token = values.get("TELEGRAM_BOT_TOKEN")!, operatorId = values.get("CYCLING_COACH_OPERATOR_ID")!;
  if (!TELEGRAM_TOKEN.test(token) || !SENDER_ID_RE.test(operatorId)
    || values.get("DOGFOOD_BOT_ATTESTED") !== "1" || values.get("HOSTED_POLLER_STOPPED") !== "1"
    || values.get("CYCLING_COACH_DM_POLICY") !== "allowlist") throw new Error("Dogfood isolation failed.");

  const previous = new Map<string, string | undefined>();
  for (const key of required) { previous.set(key, process.env[key]); process.env[key] = values.get(key)!; }
  let loaded: ReturnType<typeof loadAllowedSendersWithSource>;
  const priorConsoleError = console.error;
  try {
    console.error = () => {};
    loaded = loadAllowedSendersWithSource(input.dataDir);
  }
  finally {
    console.error = priorConsoleError;
    for (const key of required) {
      const old = previous.get(key);
      if (old === undefined) delete process.env[key]; else process.env[key] = old;
    }
  }
  if (loaded.state.dmPolicy !== "allowlist" || loaded.state.allowFrom.length !== 1
    || loaded.state.allowFrom[0] !== operatorId || loaded.state.primaryOperator !== operatorId) {
    throw new Error("Dogfood effective sender isolation failed.");
  }
  return { token, operatorId };
}

export function writeSoakEvidenceAtomic(path: string, evidence: SoakEvidence): void {
  parseSoakEvidence(evidence);
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.soak.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try { writeFileSync(handle, `${JSON.stringify(evidence)}\n`); fsyncSync(handle); }
  finally { closeSync(handle); }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  assertFile(path, 0o600);
}

export async function runStoreGateCommand(args: readonly string[]): Promise<string> {
  const [command, ...paths] = args;
  const head = currentHead();
  if (command === "overlap-scratch" && paths.length === 1) {
    const evidence = await scratchEvidence(head);
    validateOverlapScratch(evidence, head);
    exclusiveWrite(paths[0]!, evidence, 0o600);
    return "OVERLAP SCRATCH PASS total=79/79";
  }
  if (command === "overlap-real" && paths.length === 2) {
    if (process.env.STORE_OVERLAP_REAL !== "1") throw new Error("Real overlap gate is not enabled.");
    const prior = readJson(paths[0]!, 0o600), evidence = parseOverlapEvidence(prior.value);
    validateOverlapScratch(evidence, head);
    const real = await runRealWindow();
    const combined: OverlapEvidence = { ...evidence, real };
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(prior.bytes);
    const marker = '"real":null';
    if (rawText.split(marker).length !== 2) throw new Error("Scratch evidence bytes are not augmentable.");
    const combinedBytes = Buffer.from(rawText.replace(marker, `"real":${JSON.stringify(real)}`));
    if (JSON.stringify(parseOverlapEvidence(JSON.parse(combinedBytes.toString("utf8")))) !== JSON.stringify(combined)) {
      throw new Error("Real evidence augmentation changed scratch evidence.");
    }
    createOverlapConclusion(combinedBytes, head);
    exclusiveWriteBytes(paths[1]!, combinedBytes, 0o600);
    const count = real.attempts.filter((attempt) => attempt.outcome !== "limit-rejected").length;
    return `OVERLAP REAL PASS total=${count}/79`;
  }
  if (command === "overlap-emit" && paths.length === 2) {
    const raw = readJson(paths[0]!, 0o600);
    const conclusion = createOverlapConclusion(raw.bytes, head);
    validateOverlapPair(raw.bytes, conclusion, head);
    exclusiveWrite(paths[1]!, conclusion, 0o600);
    return `OVERLAP PASS scratch=${conclusion.scratch.total_requests}/79 real=${conclusion.real.total_requests}/79`;
  }
  if (command === "overlap-check" && paths.length === 2) {
    const raw = readJson(paths[0]!, 0o600), conclusion = readJson(paths[1]!, 0o444);
    const valid = validateOverlapPair(raw.bytes, conclusion.value, head);
    return `OVERLAP PASS scratch=${valid.scratch.total_requests}/79 real=${valid.real.total_requests}/79`;
  }
  if (command === "soak-emit" && paths.length === 2) {
    const raw = readJson(paths[0]!, 0o600);
    const conclusion = createSoakConclusion(raw.bytes, head);
    validateSoakPair(raw.bytes, conclusion, head);
    exclusiveWrite(paths[1]!, conclusion, 0o600);
    return `SOAK PASS dates=7 bot=${conclusion.entries[0]!.bot} outage=PASS`;
  }
  if (command === "soak-check" && paths.length === 2) {
    const raw = readJson(paths[0]!, 0o600), conclusion = readJson(paths[1]!, 0o444);
    const valid = validateSoakPair(raw.bytes, conclusion.value, head);
    return `SOAK PASS dates=7 bot=${valid.entries[0]!.bot} outage=PASS`;
  }
  if (command === "dogfood-check" && paths.length === 2) {
    const isolation = assertDogfoodIsolation({ envPath: paths[0]!, dataDir: paths[1]! });
    const response = await fetch(`https://api.telegram.org/bot${isolation.token}/getMe`);
    const body = await response.json() as { ok?: unknown; result?: { id?: unknown } };
    const id = body.result?.id;
    const tokenId = TELEGRAM_TOKEN.exec(isolation.token)?.[1];
    if (!response.ok || body.ok !== true || !Number.isSafeInteger(id) || String(id) !== tokenId) {
      throw new Error("Dogfood bot attestation failed.");
    }
    return `DOGFOOD PASS bot=bot:${id} policy=allowlist senders=1`;
  }
  throw new Error("Invalid store gate command.");
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) {
  try { console.log(await runStoreGateCommand(process.argv.slice(2))); }
  catch { process.exitCode = 1; }
}
