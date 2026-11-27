import { createHash } from "node:crypto";

export type Attempt = {seq:number;path:"store"|"legacy";tag:
  | "store:activities" | "store:analytics-curves" | "store:wellness" | "store:settings"
  | "store:streams" | "legacy:reference";
  started_ms:number;finished_ms:number;outcome:"ok"|"http-error"|"aborted"|"limit-rejected"};
export type WindowEvidence = {attempts:Attempt[];elapsed_ms:number;completed:boolean;
  rate_limited:boolean;cancel_propagated:boolean};
export type OverlapEvidence = {schema_version:1;head_sha:string;
  scratch:WindowEvidence;real:WindowEvidence|null};
export type WindowConclusion = {store_requests:number;legacy_requests:number;total_requests:number;
  completed:boolean;rate_limited:boolean;cancel_propagated:boolean;elapsed_ms:number};
export type OverlapConclusion = {schema_version:1;verdict:"PASS";head_sha:string;
  scratch:WindowConclusion;real:WindowConclusion;evidence_sha256:string};

export type RawFailure={kind:"dns"|"network"|"operator";observed_at:string;cured_at:string};
export type RawSoakEntry={civil_date:string;completed_at:string;head_sha:string;bot:string;
  tier_r:"GREEN"|"RED";tier_r_header_base64:string;suite:"GREEN"|"RED";
  self_test:"GREEN"|"RED";same_fetch_verdict:"GREEN"|"RED";
  manifest_base64:string;assertion_base64:string;last_sync_age_ms:number;
  freshness_disclosed:boolean;environmental_failures:RawFailure[];
  code_changed:boolean;restart_reasons:("initial"|"code-change"|"operator-restart"|"environment-recovery")[]};
export type RawOutage={civil_date:string;verdict:"PASS"|"FAIL";credentials_preserved:boolean;
  stored_data_unchanged:boolean;historical_answers_passed:boolean;freshness_only_degraded:boolean};
export type SoakEvidence={schema_version:1;timezone:string;token_revoked:boolean;
  entries:RawSoakEntry[];outage:RawOutage};
export type SoakEntry={civil_date:string;completed_at:string;head_sha:string;bot:string;
  tier_r:"GREEN";tier_r_header_sha256:string;suite:"GREEN";self_test:"GREEN";
  same_fetch:{verdict:"GREEN";manifest_sha256:string;assertion_sha256:string};
  last_sync_age_ms:number;freshness_disclosed:true;environmental_failures:RawFailure[];
  code_changed:boolean;restart_reasons:RawSoakEntry["restart_reasons"]};
export type SoakConclusion={schema_version:1;verdict:"PASS";timezone:string;token_revoked:true;
  entries:SoakEntry[];outage:{civil_date:string;verdict:"PASS";
  credentials_preserved:true;stored_data_unchanged:true;historical_answers_passed:true;
  freshness_only_degraded:true};evidence_sha256:string};

const HEAD = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOT = /^bot:[1-9]\d*$/;

function fail(message: string): never { throw new TypeError(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is invalid`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} schema is invalid`);
}
function safe(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} is invalid`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is invalid`);
  return value;
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function parseJson(bytes: Uint8Array, label: string): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(`${label} JSON is invalid`); }
  return value;
}
function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}
function parseInstant(value: unknown, label: string): { value: string; milliseconds: number } {
  const string = text(value, label);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(string)) fail(`${label} needs an offset`);
  const milliseconds = Date.parse(string);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(milliseconds)) fail(`${label} is invalid`);
  return { value: string, milliseconds };
}
function localDate(milliseconds: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(milliseconds));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function canonicalBase64(value: unknown, label: string): Uint8Array {
  const encoded = text(value, label);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    fail(`${label} is invalid`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) fail(`${label} is invalid`);
  return bytes;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label} is invalid`);
  return value as T;
}

const ATTEMPT_KEYS = ["seq", "path", "tag", "started_ms", "finished_ms", "outcome"] as const;
const WINDOW_KEYS = ["attempts", "elapsed_ms", "completed", "rate_limited", "cancel_propagated"] as const;
function parseWindow(value: unknown, label: string): WindowEvidence {
  const row = object(value, label); exact(row, WINDOW_KEYS, label);
  if (!Array.isArray(row.attempts)) fail(`${label}.attempts is invalid`);
  let priorStart = -1;
  const attempts = row.attempts.map((candidate, index): Attempt => {
    const attempt = object(candidate, `${label}.attempts`); exact(attempt, ATTEMPT_KEYS, `${label}.attempts`);
    const seq = safe(attempt.seq, "attempt seq", 1);
    const path = attempt.path;
    const tag = attempt.tag;
    const outcome = attempt.outcome;
    if (seq !== index + 1 || (path !== "store" && path !== "legacy")
      || typeof tag !== "string"
      || (path === "store" && ![
        "store:activities", "store:analytics-curves", "store:wellness", "store:settings", "store:streams",
      ].includes(tag))
      || (path === "legacy" && tag !== "legacy:reference")
      || !["ok", "http-error", "aborted", "limit-rejected"].includes(String(outcome))) fail("attempt is invalid");
    const started = safe(attempt.started_ms, "attempt start");
    const finished = safe(attempt.finished_ms, "attempt finish");
    if (finished < started || started < priorStart) fail("attempt timing is invalid");
    priorStart = started;
    return { seq, path, tag: tag as Attempt["tag"], started_ms: started,
      finished_ms: finished, outcome: outcome as Attempt["outcome"] };
  });
  const elapsed = safe(row.elapsed_ms, `${label}.elapsed`, 1);
  if (elapsed > 600_000) fail(`${label}.elapsed is invalid`);
  return { attempts, elapsed_ms: elapsed, completed: boolean(row.completed, `${label}.completed`),
    rate_limited: boolean(row.rate_limited, `${label}.rate_limited`),
    cancel_propagated: boolean(row.cancel_propagated, `${label}.cancel_propagated`) };
}

export function parseOverlapEvidence(value: unknown): OverlapEvidence {
  const row = object(value, "overlap evidence");
  exact(row, ["schema_version", "head_sha", "scratch", "real"], "overlap evidence");
  const head = text(row.head_sha, "head sha");
  if (row.schema_version !== 1 || !HEAD.test(head)) fail("overlap evidence is invalid");
  return { schema_version: 1, head_sha: head, scratch: parseWindow(row.scratch, "scratch"),
    real: row.real === null ? null : parseWindow(row.real, "real") };
}

function concludeWindow(window: WindowEvidence, cancellation: boolean, exactScratch = false): WindowConclusion {
  if (!window.completed || window.rate_limited || window.cancel_propagated !== cancellation) fail("overlap window failed");
  const accepted = window.attempts.filter((attempt) => attempt.outcome !== "limit-rejected");
  const store = accepted.filter((attempt) => attempt.path === "store").length;
  const legacy = accepted.filter((attempt) => attempt.path === "legacy").length;
  if (store > 64 || legacy > 15 || accepted.length > 79 || accepted.length !== store + legacy) fail("overlap limits failed");
  if (exactScratch) {
    const rejected = window.attempts.filter((attempt) => attempt.outcome === "limit-rejected");
    if (store !== 64 || legacy !== 15 || accepted.length !== 79 || rejected.length !== 1
      || !accepted.some((attempt) => attempt.outcome === "http-error")) fail("scratch accounting failed");
  }
  return { store_requests: store, legacy_requests: legacy, total_requests: accepted.length,
    completed: true, rate_limited: false, cancel_propagated: cancellation, elapsed_ms: window.elapsed_ms };
}

export function createOverlapConclusion(rawBytes: Uint8Array, headSha: string): OverlapConclusion {
  const evidence = parseOverlapEvidence(parseJson(rawBytes, "overlap evidence"));
  if (!HEAD.test(headSha) || evidence.head_sha !== headSha || evidence.real === null) fail("overlap binding failed");
  return { schema_version: 1, verdict: "PASS", head_sha: headSha,
    scratch: concludeWindow(evidence.scratch, true, true), real: concludeWindow(evidence.real, false),
    evidence_sha256: sha256(rawBytes) };
}

export function validateOverlapScratch(evidence: OverlapEvidence, headSha: string): WindowConclusion {
  if (!HEAD.test(headSha) || evidence.head_sha !== headSha || evidence.real !== null) fail("scratch binding failed");
  return concludeWindow(evidence.scratch, true, true);
}

export function validateOverlapPair(rawBytes: Uint8Array, conclusion: unknown, headSha: string): OverlapConclusion {
  const expected = createOverlapConclusion(rawBytes, headSha);
  if (JSON.stringify(conclusion) !== JSON.stringify(expected)) fail("overlap conclusion does not match evidence");
  return expected;
}

const FAILURE_KEYS = ["kind", "observed_at", "cured_at"] as const;
const ENTRY_KEYS = ["civil_date", "completed_at", "head_sha", "bot", "tier_r", "tier_r_header_base64",
  "suite", "self_test", "same_fetch_verdict", "manifest_base64", "assertion_base64", "last_sync_age_ms",
  "freshness_disclosed", "environmental_failures", "code_changed", "restart_reasons"] as const;
const OUTAGE_KEYS = ["civil_date", "verdict", "credentials_preserved", "stored_data_unchanged",
  "historical_answers_passed", "freshness_only_degraded"] as const;

function timezone(value: unknown): string {
  const zone = text(value, "timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); } catch { fail("timezone is invalid"); }
  if (!zone.includes("/") || zone === "Etc/Unknown") fail("timezone is invalid");
  return zone;
}

export function parseSoakEvidence(value: unknown): SoakEvidence {
  const row = object(value, "soak evidence");
  exact(row, ["schema_version", "timezone", "token_revoked", "entries", "outage"], "soak evidence");
  if (row.schema_version !== 1 || !Array.isArray(row.entries)) fail("soak evidence is invalid");
  const zone = timezone(row.timezone);
  const entries = row.entries.map((candidate, index): RawSoakEntry => {
    const entry = object(candidate, "soak entry"); exact(entry, ENTRY_KEYS, "soak entry");
    const civilDate = text(entry.civil_date, "civil date");
    const completed = parseInstant(entry.completed_at, "completed at");
    const head = text(entry.head_sha, "head sha"), bot = text(entry.bot, "bot");
    const botId = BOT.test(bot) ? Number(bot.slice(4)) : Number.NaN;
    if (!realDate(civilDate) || localDate(completed.milliseconds, zone) !== civilDate || !HEAD.test(head)
      || !Number.isSafeInteger(botId) || botId <= 0) {
      fail("soak entry identity is invalid");
    }
    if (!Array.isArray(entry.environmental_failures) || !Array.isArray(entry.restart_reasons)) fail("soak entry arrays are invalid");
    let priorFailureCure = -1;
    const failures = entry.environmental_failures.map((candidateFailure): RawFailure => {
      const failure = object(candidateFailure, "soak failure"); exact(failure, FAILURE_KEYS, "soak failure");
      if (!["dns", "network", "operator"].includes(String(failure.kind))) fail("soak failure kind is invalid");
      const observed = parseInstant(failure.observed_at, "failure observed"), cured = parseInstant(failure.cured_at, "failure cured");
      if (cured.milliseconds < observed.milliseconds || observed.milliseconds < priorFailureCure
        || localDate(observed.milliseconds, zone) !== civilDate
        || localDate(cured.milliseconds, zone) !== civilDate) fail("soak failure cure is invalid");
      priorFailureCure = cured.milliseconds;
      return { kind: failure.kind as RawFailure["kind"], observed_at: observed.value, cured_at: cured.value };
    });
    const reasons = entry.restart_reasons.map((reason) => {
      if (!["initial", "code-change", "operator-restart", "environment-recovery"].includes(String(reason))) {
        fail("restart reason is invalid");
      }
      return reason as RawSoakEntry["restart_reasons"][number];
    });
    if (new Set(reasons).size !== reasons.length || (index === 0
      ? JSON.stringify(reasons) !== JSON.stringify(["initial"])
      : reasons.includes("initial"))) fail("restart reasons are invalid");
    const hasEnvironmentFailure = failures.some((failure) => failure.kind === "dns" || failure.kind === "network");
    const hasOperatorFailure = failures.some((failure) => failure.kind === "operator");
    if ((reasons.includes("environment-recovery") && !hasEnvironmentFailure)
      || (reasons.includes("operator-restart") && !hasOperatorFailure)) fail("restart evidence is invalid");
    canonicalBase64(entry.tier_r_header_base64, "Tier-R header");
    canonicalBase64(entry.manifest_base64, "manifest");
    canonicalBase64(entry.assertion_base64, "assertion");
    return { civil_date: civilDate, completed_at: completed.value, head_sha: head, bot,
      tier_r: literal(entry.tier_r, ["GREEN", "RED"], "Tier-R verdict"), tier_r_header_base64: text(entry.tier_r_header_base64, "Tier-R header"),
      suite: literal(entry.suite, ["GREEN", "RED"], "suite verdict"),
      self_test: literal(entry.self_test, ["GREEN", "RED"], "self-test verdict"),
      same_fetch_verdict: literal(entry.same_fetch_verdict, ["GREEN", "RED"], "same-fetch verdict"),
      manifest_base64: text(entry.manifest_base64, "manifest"), assertion_base64: text(entry.assertion_base64, "assertion"),
      last_sync_age_ms: safe(entry.last_sync_age_ms, "last sync age"),
      freshness_disclosed: boolean(entry.freshness_disclosed, "freshness disclosed"),
      environmental_failures: failures, code_changed: boolean(entry.code_changed, "code changed"), restart_reasons: reasons };
  });
  const outageRow = object(row.outage, "outage"); exact(outageRow, OUTAGE_KEYS, "outage");
  const outageDate = text(outageRow.civil_date, "outage date");
  if (!realDate(outageDate)) fail("outage date is invalid");
  const outage: RawOutage = { civil_date: outageDate,
    verdict: literal(outageRow.verdict, ["PASS", "FAIL"], "outage verdict"), credentials_preserved: boolean(outageRow.credentials_preserved, "credentials preserved"),
    stored_data_unchanged: boolean(outageRow.stored_data_unchanged, "stored data unchanged"),
    historical_answers_passed: boolean(outageRow.historical_answers_passed, "historical answers"),
    freshness_only_degraded: boolean(outageRow.freshness_only_degraded, "freshness only") };
  return { schema_version: 1, timezone: zone, token_revoked: boolean(row.token_revoked, "token revoked"), entries, outage };
}

export function createSoakConclusion(rawBytes: Uint8Array, headSha: string): SoakConclusion {
  const evidence = parseSoakEvidence(parseJson(rawBytes, "soak evidence"));
  if (!HEAD.test(headSha) || evidence.entries.length !== 7 || evidence.token_revoked !== true) fail("soak record is incomplete");
  const heads = new Set(evidence.entries.map((entry) => entry.head_sha));
  const bots = new Set(evidence.entries.map((entry) => entry.bot));
  if (heads.size !== 1 || !heads.has(headSha) || bots.size !== 1) fail("soak record is mixed");
  for (let index = 0; index < evidence.entries.length; index += 1) {
    const entry = evidence.entries[index]!;
    if (index > 0 && evidence.entries[index - 1]!.civil_date >= entry.civil_date) fail("soak dates are invalid");
    if (entry.tier_r !== "GREEN" || entry.suite !== "GREEN" || entry.self_test !== "GREEN"
      || entry.same_fetch_verdict !== "GREEN" || entry.freshness_disclosed !== true || entry.code_changed
      || entry.restart_reasons.includes("code-change")) fail("soak entry is red");
  }
  if (!evidence.entries.some((entry) => entry.civil_date === evidence.outage.civil_date)
    || evidence.outage.verdict !== "PASS" || !evidence.outage.credentials_preserved
    || !evidence.outage.stored_data_unchanged || !evidence.outage.historical_answers_passed
    || !evidence.outage.freshness_only_degraded) fail("outage record failed");
  return { schema_version: 1, verdict: "PASS", timezone: evidence.timezone, token_revoked: true,
    entries: evidence.entries.map((entry) => ({ civil_date: entry.civil_date, completed_at: entry.completed_at,
      head_sha: entry.head_sha, bot: entry.bot, tier_r: "GREEN",
      tier_r_header_sha256: sha256(canonicalBase64(entry.tier_r_header_base64, "Tier-R header")),
      suite: "GREEN", self_test: "GREEN", same_fetch: { verdict: "GREEN",
        manifest_sha256: sha256(canonicalBase64(entry.manifest_base64, "manifest")),
        assertion_sha256: sha256(canonicalBase64(entry.assertion_base64, "assertion")) },
      last_sync_age_ms: entry.last_sync_age_ms, freshness_disclosed: true,
      environmental_failures: entry.environmental_failures, code_changed: entry.code_changed,
      restart_reasons: entry.restart_reasons })),
    outage: { civil_date: evidence.outage.civil_date, verdict: "PASS", credentials_preserved: true,
      stored_data_unchanged: true, historical_answers_passed: true, freshness_only_degraded: true },
    evidence_sha256: sha256(rawBytes) };
}

export function validateSoakPair(rawBytes: Uint8Array, conclusion: unknown, headSha: string): SoakConclusion {
  const expected = createSoakConclusion(rawBytes, headSha);
  if (JSON.stringify(conclusion) !== JSON.stringify(expected)) fail("soak conclusion does not match evidence");
  return expected;
}
