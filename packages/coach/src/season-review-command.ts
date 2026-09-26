import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, dirname, join, normalize } from "node:path";
import {
  bootstrapReference,
  bundledAcceptedCatalog,
  createCoachEngine,
  isKeylessProvider,
  isSecretRef,
  loadConfig,
  readConfigYaml,
  resolveSecretRef,
  USAGE_LEDGER_FILE,
  type Config,
  type ReferenceRuntime,
} from "@enduragent/core";
import type { CoachEngine } from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import { loadReferenceCaptureSidecars } from "@enduragent/kernel-node/capture-manifest";
import { resolveAthleteHome, type AthleteHome } from "@enduragent/kernel-node/home";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { StoreRuntime } from "./store-runtime.js";
import {
  SEASON_REVIEW_MODEL_SAMPLES,
  SEASON_REVIEW_REQUEST,
  SEASON_REVIEW_RUBRIC_SAMPLES,
  assertExactSeasonReviewRubric,
  assertExactSeasonReviewScoreSchema,
  combineCosts,
  hashSeasonReviewEvidence,
  scoreVerdicts,
  seasonReviewBlindKey,
  sha256Bytes,
  summarizeGenerateUsage,
  validateCost,
  validateSeasonReviewConclusion,
  validateSeasonReviewRunRecord,
  validateSeasonReviewScore,
  type SeasonReviewConclusion,
  type SeasonReviewCost,
  type SeasonReviewModelSample,
  type SeasonReviewRunRecord,
  type SeasonReviewScore,
  type SeasonReviewUsageRow,
  type SeasonReviewVerdict,
} from "./season-review.js";

const HEAD = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HELP = "usage: season-review-command (run|validate-score|validate-stage|seal|validate-conclusion)";

export type SeasonReviewEngine = Pick<CoachEngine, "chat">;

export interface SeasonReviewComposition {
  readonly engine: SeasonReviewEngine;
  readonly provider: string;
  readonly model: string;
  close(): Promise<void>;
}

export interface SeasonReviewCompositionInput {
  readonly athleteHome: string;
  readonly agentData: string;
}

export interface SeasonReviewCommandDependencies {
  readonly currentHead?: () => string;
  readonly resolveHome?: (env: Record<string, string | undefined>) => AthleteHome;
  readonly compose?: (input: SeasonReviewCompositionInput) => Promise<SeasonReviewComposition>;
  readonly readUsage?: (agentData: string) => readonly SeasonReviewUsageRow[];
  readonly storeInventory?: (storePath: string) => string;
  readonly chatId?: (sample: SeasonReviewModelSample) => string;
}

export interface SeasonReviewCommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
}

interface RunOptions {
  readonly head: string;
  readonly executionHead: string;
  readonly sample: SeasonReviewModelSample;
  readonly athleteHome: string;
  readonly agentData: string;
  readonly report: string;
  readonly runRecord: string;
  readonly marker: string;
}

interface IndexCalibration {
  readonly sample: string;
  readonly report_path: string;
  readonly run_record_path: string | null;
  readonly score_path: string;
  readonly source_label_path: string | null;
}

interface EvidenceIndex {
  readonly schema_version: 1;
  readonly base_sha: string;
  readonly execution_head_path: string;
  readonly call_graph_path: string;
  readonly rubric_path: string;
  readonly score_schema_path: string;
  readonly rubric_calibration: readonly IndexCalibration[];
  readonly model_calibration: readonly IndexCalibration[];
  readonly real: {
    readonly report_path: string;
    readonly run_record_path: string;
    readonly score_path: string;
  };
}

interface ValidatedCalibration {
  readonly sample: string;
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly runRecordPath: string | null;
  readonly runRecord: SeasonReviewRunRecord | null;
  readonly scorePath: string;
  readonly score: SeasonReviewScore;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} keys are invalid.`);
  }
}

function currentHead(): string {
  const value = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!HEAD.test(value)) throw new Error("Current HEAD is invalid.");
  return value;
}

function assertMode(path: string, modes: readonly number[]): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || !modes.includes(stats.mode & 0o777)) {
    throw new TypeError("Private evidence file is invalid.");
  }
}

function readJson(path: string, modes: readonly number[]): unknown {
  assertMode(path, modes);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))); }
  catch { throw new TypeError("Private evidence JSON is invalid."); }
}

function writeExclusive(path: string, bytes: Uint8Array, mode = 0o600): void {
  const handle = openSync(path, "wx", 0o600);
  try { writeFileSync(handle, bytes); fsyncSync(handle); }
  finally { closeSync(handle); }
  chmodSync(path, mode);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function directPath(path: string, root: string, existence: "new" | "file" | "directory", modes: readonly number[] = [0o600]): void {
  if (!isAbsolute(path) || normalize(path) !== path || dirname(path) !== root) throw new TypeError("Evidence path is invalid.");
  if (existence === "new") {
    if (existsSync(path)) throw new TypeError("Evidence output already exists.");
    return;
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || (existence === "file" ? !stats.isFile() : !stats.isDirectory())) {
    throw new TypeError("Evidence path type is invalid.");
  }
  if (existence === "file" && !modes.includes(stats.mode & 0o777)) throw new TypeError("Evidence file mode is invalid.");
}

function evidenceRootFor(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path) throw new TypeError("Evidence path must be absolute and normalized.");
  const parent = dirname(path), real = realpathSync(parent), stats = lstatSync(parent);
  if (real !== parent || stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o777) !== 0o700) {
    throw new TypeError("Evidence root is invalid.");
  }
  return real;
}

function optionMap(args: readonly string[], names: readonly string[]): Record<string, string> {
  if (args.length !== names.length * 2) throw new TypeError("Command options are invalid.");
  const allowed = new Set(names), result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const raw = args[index], value = args[index + 1];
    if (raw === undefined || value === undefined || !raw.startsWith("--")) throw new TypeError("Command options are invalid.");
    const name = raw.slice(2);
    if (!allowed.has(name) || result[name] !== undefined || value.startsWith("--")) throw new TypeError("Command options are invalid.");
    result[name] = value;
  }
  return result;
}

function parseRun(args: readonly string[]): RunOptions {
  const values = optionMap(args, ["head", "execution-head", "sample", "athlete-home", "agent-data", "report", "run-record", "chat-start-marker"]);
  if (!HEAD.test(values.head ?? "") || !(SEASON_REVIEW_MODEL_SAMPLES as readonly string[]).includes(values.sample ?? "")) {
    throw new TypeError("Run identity is invalid.");
  }
  return { head: values.head!, executionHead: values["execution-head"]!, sample: values.sample as SeasonReviewModelSample,
    athleteHome: values["athlete-home"]!, agentData: values["agent-data"]!, report: values.report!,
    runRecord: values["run-record"]!, marker: values["chat-start-marker"]! };
}

function validateExecutionHead(path: string, root: string, expected: string, actual: string): void {
  directPath(path, root, "file", [0o444]);
  if (readFileSync(path, "utf8") !== `${expected}\n` || expected !== actual) throw new TypeError("Execution HEAD differs.");
}

function validateAthleteHome(path: string, resolveHome: (env: Record<string, string | undefined>) => AthleteHome): string {
  if (!isAbsolute(path) || normalize(path) !== path || process.env.ENDURAGENT_HOME !== path) {
    throw new TypeError("Athlete home binding is invalid.");
  }
  const rootStats = lstatSync(path);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || realpathSync(path) !== path) throw new TypeError("Athlete home is invalid.");
  const storePath = join(path, "store", "store.db"), storeStats = lstatSync(storePath);
  if (!storeStats.isFile() || storeStats.isSymbolicLink()) throw new TypeError("Athlete store is invalid.");
  const resolved = resolveHome(process.env);
  if (realpathSync(resolved.root) !== path || realpathSync(join(resolved.storeDir, "store.db")) !== realpathSync(storePath)) {
    throw new TypeError("Resolved athlete store differs from the explicit binding.");
  }
  return realpathSync(storePath);
}

function storeInventory(storePath: string): string {
  const rows = [storePath, `${storePath}-wal`, `${storePath}-shm`].filter(existsSync).map((path) => {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError("Store inventory member is invalid.");
    return { basename: path.slice(dirname(path).length + 1), size: stats.size, mtime_ms: stats.mtimeMs,
      sha256: fileSha256(path) };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.basename), Buffer.from(right.basename)));
  return sha256Bytes(new TextEncoder().encode(canonicalJson(rows)));
}

async function selectedCaptureManifest(root: string): Promise<ReferenceCaptureManifest> {
  const captures = join(root, "captures"), stats = lstatSync(captures);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700) throw new TypeError("Capture root is invalid.");
  const entries = readdirSync(captures, { withFileTypes: true });
  if (entries.length === 0 || entries.some((entry) => !entry.isDirectory() || !UUID.test(entry.name))) {
    throw new TypeError("Capture set is invalid.");
  }
  const loaded = await Promise.all(entries.map((entry) => loadReferenceCaptureSidecars({ root, captureId: entry.name,
    assertReplayable: async () => {} })));
  const byId = new Map(loaded.map((item) => [item.manifest.capture_id, item]));
  if (byId.size !== loaded.length) throw new TypeError("Capture set is ambiguous.");
  const successor = new Map<string, string>();
  const roots = loaded.filter((item) => item.review.replaces_capture_id === null);
  if (roots.length !== 1) throw new TypeError("Capture replacement chain is invalid.");
  for (const item of loaded) {
    const prior = item.review.replaces_capture_id;
    if (prior !== null) {
      if (!byId.has(prior) || successor.has(prior)) throw new TypeError("Capture replacement chain is invalid.");
      successor.set(prior, item.manifest.capture_id);
    }
  }
  const seen = new Set<string>();
  let selected = roots[0]!.manifest.capture_id;
  while (true) {
    if (seen.has(selected)) throw new TypeError("Capture replacement chain contains a cycle.");
    seen.add(selected);
    const next = successor.get(selected);
    if (next === undefined) break;
    selected = next;
  }
  if (seen.size !== loaded.length) throw new TypeError("Capture replacement chain is disconnected.");
  return byId.get(selected)!.manifest;
}

export async function resolveSeasonReviewLlmApiKey(loaded: Config): Promise<string> {
  if (isKeylessProvider(loaded.llm.provider)) return loaded.llm.apiKey;
  let llmApiKey = loaded.llm.apiKey;
  if (llmApiKey.length === 0) {
    const llmYaml = readConfigYaml().llm;
    const configured = llmYaml !== null && typeof llmYaml === "object" && !Array.isArray(llmYaml)
      ? (llmYaml as Record<string, unknown>).api_key : undefined;
    if (isSecretRef(configured)) llmApiKey = await resolveSecretRef(configured);
  }
  if (llmApiKey.length === 0) throw new TypeError("Configured model credentials are unavailable.");
  return llmApiKey;
}

async function productComposition(input: SeasonReviewCompositionInput): Promise<SeasonReviewComposition> {
  const localBotModule = new URL("./local-bot.js", import.meta.url).href;
  const storeRuntimeModule = new URL("./store-runtime.js", import.meta.url).href;
  const [{ prepareStoreCoachComposition }, { createStoreRuntime }] = await Promise.all([
    import(localBotModule) as Promise<typeof import("./local-bot.js")>,
    import(storeRuntimeModule) as Promise<typeof import("./store-runtime.js")>,
  ]);
  const loaded = loadConfig();
  const llmApiKey = await resolveSeasonReviewLlmApiKey(loaded);
  if (loaded.dataSource !== "store") throw new TypeError("Season review requires the configured store data source.");
  const config: Config = { ...loaded, dataDir: input.agentData,
    intervals: { ...loaded.intervals, apiKey: "" }, telegram: { botToken: "" },
    llm: { ...loaded.llm, apiKey: llmApiKey }, session: { ...loaded.session } };
  const manifest = await selectedCaptureManifest(input.athleteHome);
  const env: Record<string, string | undefined> = { ...process.env, ENDURAGENT_HOME: input.athleteHome,
    INTERVALS_API_KEY: undefined, TELEGRAM_BOT_TOKEN: undefined };
  let reference: ReferenceRuntime | undefined, runtime: StoreRuntime | undefined;
  try {
    const prepared = await prepareStoreCoachComposition({ config, sport: cyclingSport }, {
      env,
      bootstrap: async (options) => {
        const productReference = await bootstrapReference({ ...options, startScheduler: false });
        reference = { ...productReference,
          runScheduledOnce: async () => ({ kind: "skipped", reason: "cooldown" }) as never };
        return reference;
      },
      createRuntime: (options) => (runtime = createStoreRuntime(options)),
      runtimeDependencies: { capture: async () => manifest },
    });
    if (prepared.athleteData === undefined) throw new TypeError("Store athlete reader is unavailable.");
    const engine = createCoachEngine(cyclingSport, config, {
      athleteData: prepared.athleteData,
      catalog: bundledAcceptedCatalog(),
    });
    let closed = false;
    return { engine, provider: config.llm.provider, model: config.llm.model, async close() {
      if (closed) return;
      closed = true;
      try { await prepared.close?.(); }
      finally { reference?.scheduler.stop(); }
    } };
  } catch (error) {
    try { await runtime?.close(); } finally { reference?.scheduler.stop(); }
    throw error;
  }
}

function readUsage(agentData: string): readonly SeasonReviewUsageRow[] {
  const path = join(agentData, USAGE_LEDGER_FILE);
  assertMode(path, [0o600]);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  if (!text.endsWith("\n")) throw new TypeError("Usage ledger is incomplete.");
  return text.slice(0, -1).split("\n").map((line) => object(JSON.parse(line), "Usage row") as unknown as SeasonReviewUsageRow);
}

function runRecordBytes(record: SeasonReviewRunRecord): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(record)}\n`);
}

async function executeRun(options: RunOptions, dependencies: SeasonReviewCommandDependencies): Promise<SeasonReviewCommandResult> {
  const resolveHome = dependencies.resolveHome ?? resolveAthleteHome;
  let createdAgentData = false;
  let storePath: string | undefined, before: string | undefined;
  const inventory = dependencies.storeInventory ?? storeInventory;
  try {
    const root = evidenceRootFor(options.executionHead);
    for (const path of [options.agentData, options.report, options.runRecord, options.marker]) directPath(path, root, "new");
    const actualHead = (dependencies.currentHead ?? currentHead)();
    validateExecutionHead(options.executionHead, root, options.head, actualHead);
    storePath = validateAthleteHome(options.athleteHome, resolveHome);
    before = inventory(storePath);
    if (!HASH.test(before)) throw new TypeError("Store inventory hash is invalid.");
    mkdirSync(options.agentData, { mode: 0o700 });
    createdAgentData = true;
    const composition = await (dependencies.compose ?? productComposition)({ athleteHome: options.athleteHome, agentData: options.agentData });
    let report: string | undefined, chatFailure: unknown, closeFailure: unknown;
    try {
      if (typeof composition.provider !== "string" || composition.provider.length === 0
        || typeof composition.model !== "string" || composition.model.length === 0) throw new TypeError("Model identity is invalid.");
      const chatId = (dependencies.chatId ?? ((sample) => `season-review-prototype-${sample}-${randomUUID()}`))(options.sample);
      if (!/^season-review-prototype-[a-z0-9-]+$/.test(chatId)) throw new TypeError("Season review chat ID is invalid.");
      writeFileSync(options.marker, `${options.head}\n`, { flag: "wx", mode: 0o600 });
      const response = await composition.engine.chat({
        chatId,
        message: SEASON_REVIEW_REQUEST,
      });
      report = response.text;
    } catch (error) { chatFailure = error; }
    finally { try { await composition.close(); } catch (error) { closeFailure = error; } }
    const after = inventory(storePath);
    if (before !== after) throw new TypeError("Store changed during season review.");
    if (chatFailure !== undefined) throw chatFailure;
    if (closeFailure !== undefined) throw closeFailure;
    if (typeof report !== "string") throw new TypeError("Season review report is invalid.");
    const reportBytes = new TextEncoder().encode(report), reportSha256 = sha256Bytes(reportBytes);
    const usage = (dependencies.readUsage ?? readUsage)(options.agentData);
    const summarized = summarizeGenerateUsage(usage, composition.provider, composition.model);
    const record: SeasonReviewRunRecord = validateSeasonReviewRunRecord({
      schema_version: 1, head_sha: options.head, sample: options.sample, provider: composition.provider,
      model: composition.model, report_sha256: reportSha256, store_before_sha256: before,
      store_after_sha256: after, store_unchanged: true, generate_calls: summarized.generateCalls, cost: summarized.cost,
    }, { head_sha: options.head, sample: options.sample, provider: composition.provider,
      model: composition.model, report_sha256: reportSha256 });
    writeExclusive(options.report, reportBytes);
    writeExclusive(options.runRecord, runRecordBytes(record));
    return { exitCode: 0, stdout: JSON.stringify({ status: "generated", provider: composition.provider,
      model: composition.model, sample: options.sample, report_sha256: reportSha256,
      generate_calls: summarized.generateCalls, priced: summarized.cost.priced_calls === summarized.generateCalls }) };
  } catch {
    const started = existsSync(options.marker);
    if (storePath !== undefined && before !== undefined) {
      try {
        inventory(storePath);
      } catch (error) {
        void error;
      }
    }
    if (!started && createdAgentData && existsSync(options.agentData)) rmSync(options.agentData, { recursive: true });
    return { exitCode: started ? 1 : 2, stdout: JSON.stringify({ status: started ? "run_failed" : "environment" }) };
  }
}

function parseCalibration(value: unknown, label: string): IndexCalibration {
  const candidate = object(value, label);
  exactKeys(candidate, ["sample", "report_path", "run_record_path", "score_path", "source_label_path"], label);
  if (typeof candidate.sample !== "string" || typeof candidate.report_path !== "string"
    || (candidate.run_record_path !== null && typeof candidate.run_record_path !== "string")
    || typeof candidate.score_path !== "string"
    || (candidate.source_label_path !== null && typeof candidate.source_label_path !== "string")) throw new TypeError(`${label} is invalid.`);
  return candidate as unknown as IndexCalibration;
}

function loadIndex(indexPath: string): { readonly root: string; readonly index: EvidenceIndex } {
  const root = evidenceRootFor(indexPath);
  directPath(indexPath, root, "file", [0o600]);
  const candidate = object(readJson(indexPath, [0o600]), "Evidence index");
  exactKeys(candidate, ["schema_version", "base_sha", "execution_head_path", "call_graph_path", "rubric_path",
    "score_schema_path", "rubric_calibration", "model_calibration", "real"], "Evidence index");
  if (candidate.schema_version !== 1 || typeof candidate.base_sha !== "string" || !HEAD.test(candidate.base_sha)
    || typeof candidate.execution_head_path !== "string" || typeof candidate.call_graph_path !== "string"
    || typeof candidate.rubric_path !== "string" || typeof candidate.score_schema_path !== "string"
    || !Array.isArray(candidate.rubric_calibration) || !Array.isArray(candidate.model_calibration)) {
    throw new TypeError("Evidence index is invalid.");
  }
  const real = object(candidate.real, "Real evidence index");
  exactKeys(real, ["report_path", "run_record_path", "score_path"], "Real evidence index");
  if (typeof real.report_path !== "string" || typeof real.run_record_path !== "string" || typeof real.score_path !== "string") {
    throw new TypeError("Real evidence index is invalid.");
  }
  const index: EvidenceIndex = { schema_version: 1, base_sha: candidate.base_sha,
    execution_head_path: candidate.execution_head_path, call_graph_path: candidate.call_graph_path,
    rubric_path: candidate.rubric_path, score_schema_path: candidate.score_schema_path,
    rubric_calibration: candidate.rubric_calibration.map((value) => parseCalibration(value, "Rubric calibration index")),
    model_calibration: candidate.model_calibration.map((value) => parseCalibration(value, "Model calibration index")),
    real: real as unknown as EvidenceIndex["real"] };
  const paths = [index.execution_head_path, index.call_graph_path, index.rubric_path, index.score_schema_path,
    ...index.rubric_calibration.flatMap((item) => [item.report_path, item.score_path, item.source_label_path].filter((path): path is string => path !== null)),
    ...index.model_calibration.flatMap((item) => [item.report_path, item.run_record_path, item.score_path].filter((path): path is string => path !== null)),
    index.real.report_path, index.real.run_record_path, index.real.score_path];
  if (new Set([indexPath, ...paths]).size !== paths.length + 1) throw new TypeError("Evidence paths must be unique.");
  for (const path of paths) directPath(path, root, "file", [0o400, 0o444, 0o600]);
  return { root, index };
}

const RUBRIC_EXPECTED: readonly [SeasonReviewVerdict, SeasonReviewVerdict, SeasonReviewVerdict][] = [
  ["REWORK", "KEEP", "KEEP"], ["KEEP", "REWORK", "REWORK"], ["KEEP", "KEEP", "KEEP"],
];
const RUBRIC_LABELS = ["unsupported-specific", "grounded-generic", "strong"] as const;

function validateCalibrationFiles(
  values: readonly IndexCalibration[],
  root: string,
  kind: "rubric" | "model",
): readonly ValidatedCalibration[] {
  if (values.length !== 3) throw new TypeError("Calibration count is invalid.");
  const blindKeys: string[] = [];
  const validated = values.map((item, index): ValidatedCalibration => {
    const expectedSample = kind === "rubric" ? SEASON_REVIEW_RUBRIC_SAMPLES[index] : SEASON_REVIEW_MODEL_SAMPLES[index];
    if (item.sample !== expectedSample) throw new TypeError("Calibration order is invalid.");
    directPath(item.report_path, root, "file", [0o600]);
    directPath(item.score_path, root, "file", [0o600]);
    const reportSha256 = fileSha256(item.report_path);
    const score = validateSeasonReviewScore(readJson(item.score_path, [0o600]), reportSha256);
    if (kind === "rubric") {
      if (item.run_record_path !== null || item.source_label_path === null) throw new TypeError("Rubric calibration index is invalid.");
      directPath(item.source_label_path, root, "file", [0o600]);
      const sourceLabel = readFileSync(item.source_label_path, "utf8").trim();
      if (sourceLabel !== RUBRIC_LABELS[index]) throw new TypeError("Rubric source label is invalid.");
      blindKeys.push(seasonReviewBlindKey(readFileSync(item.report_path), sourceLabel));
      const actual = scoreVerdicts(score), expected = RUBRIC_EXPECTED[index]!;
      if (actual.grounding !== expected[0] || actual.specificity !== expected[1] || actual.question_quality !== expected[2]) {
        throw new TypeError("Rubric calibration map is invalid.");
      }
      return { sample: item.sample, reportPath: item.report_path, reportSha256, runRecordPath: null,
        runRecord: null, scorePath: item.score_path, score };
    }
    if (item.run_record_path === null || item.source_label_path !== null) throw new TypeError("Model calibration index is invalid.");
    directPath(item.run_record_path, root, "file", [0o600]);
    const runRecord = validateSeasonReviewRunRecord(readJson(item.run_record_path, [0o600]), {
      sample: expectedSample as SeasonReviewModelSample, report_sha256: reportSha256,
    });
    return { sample: item.sample, reportPath: item.report_path, reportSha256,
      runRecordPath: item.run_record_path, runRecord, scorePath: item.score_path, score };
  });
  if (kind === "rubric" && new Set(blindKeys).size !== 3) throw new TypeError("Rubric blind keys are ambiguous.");
  return validated;
}

function validateStages(indexPath: string, stage: "rubric" | "model"): {
  readonly root: string; readonly index: EvidenceIndex; readonly rubric: readonly ValidatedCalibration[];
  readonly model: readonly ValidatedCalibration[] | null;
} {
  const { root, index } = loadIndex(indexPath);
  directPath(index.rubric_path, root, "file", stage === "rubric" ? [0o600, 0o444] : [0o444]);
  directPath(index.score_schema_path, root, "file", [0o400]);
  assertExactSeasonReviewRubric(readFileSync(index.rubric_path));
  assertExactSeasonReviewScoreSchema(readFileSync(index.score_schema_path));
  const rubric = validateCalibrationFiles(index.rubric_calibration, root, "rubric");
  if (stage === "rubric") {
    chmodSync(index.rubric_path, 0o444);
    return { root, index, rubric, model: null };
  }
  const model = validateCalibrationFiles(index.model_calibration, root, "model");
  const records = model.map((item) => item.runRecord!);
  if (records.some((record) => record.head_sha !== records[0]!.head_sha || record.provider !== records[0]!.provider
    || record.model !== records[0]!.model || record.store_before_sha256 !== records[0]!.store_before_sha256)) {
    throw new TypeError("Model calibration identity is inconsistent.");
  }
  return { root, index, rubric, model };
}

function validateCallGraph(value: unknown, baseSha: string): void {
  const candidate = object(value, "Call graph");
  exactKeys(candidate, ["schema_version", "base_sha", "config", "store_binding", "composition", "store_open", "engine",
    "reads", "mutations", "fencing", "projection", "shutdown", "verdict"], "Call graph");
  if (candidate.schema_version !== 1 || candidate.base_sha !== baseSha || candidate.verdict !== "USE_PRODUCT_SEAM") {
    throw new TypeError("Call graph identity is invalid.");
  }
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "boolean") {
      if (value !== (key === "writer_called" ? false : true)) throw new TypeError("Call graph qualification is invalid.");
      return;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(candidate);
}

function costCalls(cost: SeasonReviewCost): number { return cost.priced_calls + cost.unpriced_calls; }

function conclusionCalibration(item: ValidatedCalibration): SeasonReviewConclusion["model_calibration"][number] {
  return { sample: item.sample as "model-calibration-01" | "model-calibration-02" | "model-calibration-03",
    report_sha256: item.reportSha256, ...scoreVerdicts(item.score) };
}

function seal(indexPath: string, conclusionPath: string, expectedHead: string): void {
  const validated = validateStages(indexPath, "model"), { root, index } = validated;
  directPath(conclusionPath, root, "new");
  validateExecutionHead(index.execution_head_path, root, expectedHead, expectedHead);
  directPath(index.call_graph_path, root, "file", [0o600]);
  validateCallGraph(readJson(index.call_graph_path, [0o600]), index.base_sha);
  const model = validated.model!;
  const provider = model[0]!.runRecord!.provider, modelName = model[0]!.runRecord!.model;
  const realReportSha256 = fileSha256(index.real.report_path);
  const realRecord = validateSeasonReviewRunRecord(readJson(index.real.run_record_path, [0o600]), {
    head_sha: expectedHead, sample: "real", provider, model: modelName, report_sha256: realReportSha256,
  });
  const realScore = validateSeasonReviewScore(readJson(index.real.score_path, [0o600]), realReportSha256);
  if (model.some((item) => item.runRecord!.head_sha !== expectedHead)) throw new TypeError("Calibration HEAD differs.");
  const calibrationCosts = model.map((item) => ({ cost: item.runRecord!.cost, generateCalls: item.runRecord!.generate_calls }));
  const calibrationTotal = combineCosts(calibrationCosts);
  const realTotal = { cost: validateCost(realRecord.cost, realRecord.generate_calls), generateCalls: realRecord.generate_calls };
  const combinedTotal = combineCosts([calibrationTotal, realTotal]);
  const costTotals = { calibration: calibrationTotal.cost, real: realTotal.cost, combined: combinedTotal.cost };
  const evidenceManifest = {
    base_sha: index.base_sha, head_sha: expectedHead, call_graph_sha256: fileSha256(index.call_graph_path),
    execution_head_sha256: fileSha256(index.execution_head_path), rubric_sha256: fileSha256(index.rubric_path),
    score_schema_sha256: fileSha256(index.score_schema_path),
    rubric_calibration: validated.rubric.map((item) => ({ report_sha256: item.reportSha256, score_sha256: fileSha256(item.scorePath) })),
    model_calibration: model.map((item) => ({ report_sha256: item.reportSha256,
      run_record_sha256: fileSha256(item.runRecordPath!), score_sha256: fileSha256(item.scorePath) })),
    real: { report_sha256: realReportSha256, run_record_sha256: fileSha256(index.real.run_record_path),
      score_sha256: fileSha256(index.real.score_path) },
    cost_totals_sha256: hashSeasonReviewEvidence(costTotals), store_unchanged: true,
  };
  const realVerdicts = scoreVerdicts(realScore);
  const conclusion: SeasonReviewConclusion = validateSeasonReviewConclusion({
    schema_version: 1, head_sha: expectedHead, provider, model: modelName,
    rubric_sha256: fileSha256(index.rubric_path), model_calibration: model.map(conclusionCalibration),
    ...realVerdicts, cost_totals: costTotals,
    overall: Object.values(realVerdicts).every((value) => value === "KEEP") ? "KEEP" : "REWORK",
    evidence_sha256: hashSeasonReviewEvidence(evidenceManifest),
  }, expectedHead);
  if (costCalls(conclusion.cost_totals.combined) !== combinedTotal.generateCalls) throw new TypeError("Combined call count is invalid.");
  writeExclusive(conclusionPath, new TextEncoder().encode(`${canonicalJson(conclusion)}\n`));
}

export async function executeSeasonReviewCommand(
  args: readonly string[],
  dependencies: SeasonReviewCommandDependencies = {},
): Promise<SeasonReviewCommandResult> {
  if (args.length === 1 && args[0] === "--help") return { exitCode: 0, stdout: HELP };
  const [command, ...rest] = args;
  if (command === "run") return executeRun(parseRun(rest), dependencies);
  if (command === "validate-score") {
    const values = optionMap(rest, ["report", "score"]), root = evidenceRootFor(values.report!);
    directPath(values.report!, root, "file", [0o600]); directPath(values.score!, root, "file", [0o600]);
    validateSeasonReviewScore(readJson(values.score!, [0o600]), fileSha256(values.report!));
    return { exitCode: 0, stdout: "" };
  }
  if (command === "validate-stage") {
    const values = optionMap(rest, ["stage", "index"]);
    if (values.stage !== "rubric" && values.stage !== "model") throw new TypeError("Validation stage is invalid.");
    validateStages(values.index!, values.stage);
    return { exitCode: 0, stdout: "" };
  }
  if (command === "seal") {
    const values = optionMap(rest, ["index", "conclusion"]), headSha = (dependencies.currentHead ?? currentHead)();
    seal(values.index!, values.conclusion!, headSha);
    return { exitCode: 0, stdout: "" };
  }
  if (command === "validate-conclusion") {
    const values = optionMap(rest, ["conclusion"]), root = evidenceRootFor(values.conclusion!);
    directPath(values.conclusion!, root, "file", [0o444]);
    validateSeasonReviewConclusion(readJson(values.conclusion!, [0o444]));
    return { exitCode: 0, stdout: "" };
  }
  throw new TypeError("Invalid season review command.");
}

async function main(): Promise<void> {
  const prior = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    const result = await executeSeasonReviewCommand(process.argv.slice(2));
    console.log = prior.log; console.warn = prior.warn; console.error = prior.error;
    if (result.stdout.length > 0) process.stdout.write(`${result.stdout}\n`);
    process.exitCode = result.exitCode;
  } catch {
    console.log = prior.log; console.warn = prior.warn; console.error = prior.error;
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href) await main();
