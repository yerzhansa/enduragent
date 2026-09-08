/**
 * usage:baseline — latency + cache-read + cost baseline over the usage ledger.
 *
 * Reads `<dataDir>/usage-ledger.jsonl` and prints a per-templateHash baseline
 * summary so a real >=3-day snapshot is one command. The ledger line shape is
 * owned by packages/core/src/usage-ledger.ts (UsageLedgerLine).
 *
 * Data-dir resolution (first match wins):
 *   1. --data-dir <path>
 *   2. CYCLING_COACH_HOME env-var
 *   3. getCoachHome("cycling-coach")   (its own legacy ~/.cycling-coach fallback)
 *
 * Percentile method: NEAREST-RANK (no interpolation). For a sorted ascending
 * sample of n values and p in [0,100], rank = clamp(ceil(p/100 * n), 1, n) and
 * the result is sorted[rank-1]. Deterministic and exactly reproducible; chosen
 * over linear interpolation so the baseline numbers are stable values drawn
 * from the observed sample rather than synthetic in-between values.
 *
 * Per-turn token/cost figures are the FINAL successful generation's, not a sum
 * across retry/compaction attempts (see usage-ledger.ts). This tool only reads
 * the live ledger; data rotated to usage-ledger.jsonl.1 at 10 MB is not read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { USAGE_LEDGER_FILE, type UsageLedgerLine } from "../packages/core/src/usage-ledger.js";
import { getCoachHome, expandTilde } from "../packages/core/src/coach-home.js";
import { MS_PER_DAY } from "../packages/engine/src/sport/date-keys.js";
import { priceInclusiveUsage } from "../packages/engine/src/usage-cost.js";

const UNKNOWN_TEMPLATE = "unknown";
const MIN_SPAN_DAYS = 3;

// ─── CLI ────────────────────────────────────────────────────────────────

export interface CliArgs {
  dataDir?: string;
  kind: UsageLedgerLine["kind"];
  caller?: UsageLedgerLine["caller"] | "all";
  json: boolean;
}

const KIND_VALUES = new Set(["generate", "turn", "boot"]);
const CALLER_VALUES = new Set(["chat", "flush", "compact", "all"]);

// Accepts both `--flag=value` and `--flag value`. Flags: --data-dir, --kind,
// --caller, --json.
export function parseCli(argv: readonly string[]): CliArgs {
  const out: CliArgs = { kind: "turn", caller: "chat", json: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) throw new Error(`unexpected positional arg: ${tok}`);
    const eq = tok.indexOf("=");
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
    const takeValue = (): string => {
      const fromNext = inlineVal === undefined;
      const val = fromNext ? argv[i + 1] : inlineVal;
      if (val === undefined || val.length === 0 || (fromNext && val.startsWith("--"))) {
        throw new Error(`flag --${key} requires a non-empty value`);
      }
      if (fromNext) i += 1;
      return val;
    };
    switch (key) {
      case "data-dir":
        out.dataDir = takeValue();
        break;
      case "kind": {
        const v = takeValue();
        if (!KIND_VALUES.has(v)) {
          throw new Error(`--kind must be one of generate|turn|boot (got '${v}')`);
        }
        out.kind = v as UsageLedgerLine["kind"];
        break;
      }
      case "caller": {
        const v = takeValue();
        if (!CALLER_VALUES.has(v)) {
          throw new Error(`--caller must be one of chat|flush|compact|all (got '${v}')`);
        }
        out.caller = v as CliArgs["caller"];
        break;
      }
      case "json":
        if (inlineVal !== undefined) throw new Error("flag --json takes no value");
        out.json = true;
        break;
      default:
        throw new Error(`unknown flag: ${tok}`);
    }
  }
  return out;
}

export function resolveDataDir(dataDirFlag: string | undefined): { dir: string; source: string } {
  if (dataDirFlag !== undefined && dataDirFlag.length > 0) {
    return { dir: expandTilde(dataDirFlag), source: "--data-dir" };
  }
  const env = process.env.CYCLING_COACH_HOME;
  if (env !== undefined && env.length > 0) {
    return { dir: expandTilde(env), source: "CYCLING_COACH_HOME" };
  }
  return { dir: getCoachHome("cycling-coach"), source: 'getCoachHome("cycling-coach")' };
}

// ─── Parsing ──────────────────────────────────────────────────────────────

// Parses JSONL, skipping blank lines and any line that fails to parse or lacks
// a numeric ts / string kind (defensive: the ledger is a best-effort sink).
export function parseLedger(raw: string): UsageLedgerLine[] {
  const out: UsageLedgerLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { ts?: unknown }).ts === "number" &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      out.push(parsed as UsageLedgerLine);
    }
  }
  return out;
}

export function selectLines(
  lines: readonly UsageLedgerLine[],
  kind: UsageLedgerLine["kind"],
  caller: CliArgs["caller"],
): UsageLedgerLine[] {
  // Boot lines never carry a caller, so the caller filter is skipped for them;
  // otherwise `--kind boot` with the default `--caller chat` would select none.
  return lines.filter(
    (l) =>
      l.kind === kind &&
      (kind === "boot" || caller === "all" || caller === undefined || l.caller === caller),
  );
}

// ─── Statistics ─────────────────────────────────────────────────────────

// Nearest-rank percentile. p in [0,100]. Returns null for an empty sample.
// Does NOT mutate the input. See the module header for the exact definition.
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length), 1), sorted.length);
  return sorted[rank - 1];
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Guarded division: a zero/negative/NaN denominator yields null, never NaN/Inf.
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

// ─── Aggregation ──────────────────────────────────────────────────────────

export interface GroupSummary {
  templateHash: string;
  count: number;
  latencyMs: {
    p50: number | null;
    p95: number | null;
    mean: number | null;
    min: number | null;
    max: number | null;
  };
  cacheRead: {
    // mean / p50 of per-line cacheReadTokens/inputTokens (lines without a
    // positive inputTokens are excluded — they cannot form a ratio).
    perLineRatioMean: number | null;
    perLineRatioP50: number | null;
    // overall sum(cacheRead)/sum(input) across the group.
    overallRatio: number | null;
    ratioSampleSize: number;
  };
  cost: {
    // Lines whose provider/model is not in the price catalog are skipped,
    // NOT counted as 0.
    total: number;
    meanPerTurn: number | null;
    costedLines: number;
  };
}

export interface Report {
  ledgerPath: string;
  dataDirSource: string;
  linesRead: number;
  linesSelected: number;
  kind: string;
  caller: string;
  window: {
    oldestTs: number | null;
    newestTs: number | null;
    spanDays: number | null;
    spanWarning: string | null;
  };
  groups: GroupSummary[];
}

function summarizeGroup(
  templateHash: string,
  lines: readonly UsageLedgerLine[],
): GroupSummary {
  const durations = lines.map((l) => l.durationMs).filter((d): d is number => Number.isFinite(d));

  const perLineRatios: number[] = [];
  let sumCacheRead = 0;
  let sumInput = 0;
  for (const l of lines) {
    const input = l.inputTokens;
    const cacheRead = l.cacheReadTokens ?? 0;
    if (typeof input === "number" && input > 0) {
      perLineRatios.push(cacheRead / input);
      sumInput += input;
      sumCacheRead += cacheRead;
    }
  }

  const costTotals = lines
    .map(
      (l) =>
        priceInclusiveUsage(l.provider, l.model, {
          inputTokens: l.inputTokens ?? 0,
          outputTokens: l.outputTokens ?? 0,
          cacheReadTokens: l.cacheReadTokens ?? 0,
          cacheWriteTokens: l.cacheWriteTokens ?? 0,
        })?.total,
    )
    .filter((c): c is number => Number.isFinite(c));

  return {
    templateHash,
    count: lines.length,
    latencyMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      mean: mean(durations),
      min: percentile(durations, 0),
      max: percentile(durations, 100),
    },
    cacheRead: {
      perLineRatioMean: mean(perLineRatios),
      perLineRatioP50: percentile(perLineRatios, 50),
      overallRatio: safeDiv(sumCacheRead, sumInput),
      ratioSampleSize: perLineRatios.length,
    },
    cost: {
      total: costTotals.reduce((a, b) => a + b, 0),
      meanPerTurn: mean(costTotals),
      costedLines: costTotals.length,
    },
  };
}

export function buildReport(args: {
  ledgerPath: string;
  dataDirSource: string;
  raw: string;
  kind: UsageLedgerLine["kind"];
  caller: CliArgs["caller"];
}): Report {
  const all = parseLedger(args.raw);
  const selected = selectLines(all, args.kind, args.caller);

  const tsValues = selected.map((l) => l.ts);
  const oldestTs = tsValues.length > 0 ? Math.min(...tsValues) : null;
  const newestTs = tsValues.length > 0 ? Math.max(...tsValues) : null;
  const spanDays =
    oldestTs !== null && newestTs !== null ? (newestTs - oldestTs) / MS_PER_DAY : null;
  const spanWarning =
    selected.length === 0
      ? "no selected lines — nothing to summarize"
      : spanDays !== null && spanDays < MIN_SPAN_DAYS
        ? `window spans ${spanDays.toFixed(2)} day(s) — below the ${MIN_SPAN_DAYS}-day minimum a real baseline needs`
        : null;

  const byHash = new Map<string, UsageLedgerLine[]>();
  for (const l of selected) {
    const key = l.templateHash ?? UNKNOWN_TEMPLATE;
    const bucket = byHash.get(key);
    if (bucket) bucket.push(l);
    else byHash.set(key, [l]);
  }

  const groups = [...byHash.keys()].sort().map((hash) => summarizeGroup(hash, byHash.get(hash)!));

  return {
    ledgerPath: args.ledgerPath,
    dataDirSource: args.dataDirSource,
    linesRead: all.length,
    linesSelected: selected.length,
    kind: args.kind,
    caller: args.caller ?? "all",
    window: { oldestTs, newestTs, spanDays, spanWarning },
    groups,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────

function fmtNum(v: number | null, digits = 0): string {
  return v === null ? "—" : v.toFixed(digits);
}

function fmtRatio(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function fmtIso(ts: number | null): string {
  return ts === null ? "—" : new Date(ts).toISOString();
}

export function formatHuman(report: Report): string {
  const out: string[] = [];
  out.push(`usage:baseline`);
  out.push(`  ledger: ${report.ledgerPath}  (via ${report.dataDirSource})`);
  out.push(`  lines read: ${report.linesRead}  selected: ${report.linesSelected}`);
  out.push(`  filter: kind=${report.kind} caller=${report.caller}`);
  out.push(
    `  window: ${fmtIso(report.window.oldestTs)} .. ${fmtIso(report.window.newestTs)} ` +
      `(${report.window.spanDays === null ? "—" : report.window.spanDays.toFixed(2)} days)`,
  );
  if (report.window.spanWarning) out.push(`  WARNING: ${report.window.spanWarning}`);
  out.push("");

  for (const g of report.groups) {
    out.push(`templateHash ${g.templateHash}  (n=${g.count})`);
    out.push(
      `  latency ms : p50 ${fmtNum(g.latencyMs.p50)}  p95 ${fmtNum(g.latencyMs.p95)}  ` +
        `mean ${fmtNum(g.latencyMs.mean)}  min ${fmtNum(g.latencyMs.min)}  max ${fmtNum(g.latencyMs.max)}`,
    );
    out.push(
      `  cache-read : per-line mean ${fmtRatio(g.cacheRead.perLineRatioMean)}  ` +
        `p50 ${fmtRatio(g.cacheRead.perLineRatioP50)}  overall ${fmtRatio(g.cacheRead.overallRatio)}  ` +
        `(n=${g.cacheRead.ratioSampleSize})`,
    );
    out.push(
      `  cost       : total ${fmtNum(g.cost.total, 4)}  mean/turn ${fmtNum(g.cost.meanPerTurn, 4)}  ` +
        `(costed lines=${g.cost.costedLines})`,
    );
    out.push("");
  }
  if (report.groups.length === 0) out.push("(no groups)");
  return out.join("\n");
}

// ─── Entry ────────────────────────────────────────────────────────────────

export function run(argv: readonly string[]): number {
  const args = parseCli(argv);
  const { dir, source } = resolveDataDir(args.dataDir);
  const ledgerPath = join(dir, USAGE_LEDGER_FILE);

  let raw: string;
  try {
    raw = readFileSync(ledgerPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`usage:baseline: no ledger at ${ledgerPath} (via ${source})`);
      return 1;
    }
    throw err;
  }

  const report = buildReport({
    ledgerPath,
    dataDirSource: source,
    raw,
    kind: args.kind,
    caller: args.caller,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(formatHuman(report));
  }
  return 0;
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  process.exit(run(process.argv.slice(2)));
}
