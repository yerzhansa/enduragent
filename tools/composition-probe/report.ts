import {
  FLOOR_MODELS,
  JUDGE_MODEL_ID,
  JUDGED_TURNS_PER_MODEL,
  MIXING_RATE_MAX,
  PROBE_FROZEN_NOW_ISO,
  RECALL_MIN_HITS,
  STABLE_PREFIX_TOKEN_BUDGET,
  SUITE_COMPOSITION,
  TOOL_CHOICE_MIN,
  WHOLE_PROMPT_TOKEN_MAX,
} from "./constants.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import type { ProbeScenario, TranscriptLine } from "./types.js";
import type { TokensJson } from "./tokens.js";

export type Verdict = "PROCEED" | "ADVISORY-FAIL" | "REWORK-LAYOUT" | "ABORT-PREMISE";

export interface SpotCheckRow {
  scenarioId: string;
  model: string;
  flagSource: "needle" | "judge";
  verdict: "CONFIRM" | "OVERTURN";
  reason: string;
}

export interface ReportInput {
  runDate: string;
  tokens: TokensJson;
  transcripts: Record<string, TranscriptLine[]>;
  spotCheckRows: SpotCheckRow[];
}

export class ReportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRefusal";
  }
}

const SCENARIO_BY_ID = new Map<string, ProbeScenario>(ALL_SCENARIOS.map((s) => [s.id, s]));
const SLUGS = new Set<string>(FLOOR_MODELS.map((m) => m.slug));
const SCENARIO_IDS = new Set(ALL_SCENARIOS.map((s) => s.id));
const COMBINED_LOAD_IDS = new Set(
  ALL_SCENARIOS.filter((s) => (s.judgeItems ?? []).includes("caveat-thresholds")).map((s) => s.id),
);

export function hasForbidden(line: TranscriptLine): boolean {
  return line.needleHits.some((h) => h.kind === "forbidden");
}

export function isMixing(line: TranscriptLine): boolean {
  return hasForbidden(line) || line.judge?.mixing.flag === true;
}

function isIntegrated(scenarioId: string): boolean {
  const s = SCENARIO_BY_ID.get(scenarioId);
  return s?.class === "c5-integrated" || COMBINED_LOAD_IDS.has(scenarioId);
}

interface ModelMetrics {
  slug: string;
  provider: string;
  model: string;
  rawM1Numerator: number;
  adjustedM1Numerator: number;
  rawM1Rate: number;
  adjustedM1Rate: number;
  flaggedIds: string[];
  singleSportBleedIds: string[];
  integratedBleedIds: string[];
  overturns: Array<{ scenarioId: string; reason: string }>;
  m2Correct: number;
  m2Total: number;
  m2Accuracy: number;
  m2Rows: Array<{ id: string; expected: string[]; chosen: string }>;
  m3Hits: number;
  m3Total: number;
  m3Rows: Array<{ id: string; targetSport: string; calledSports: string[]; hit: boolean }>;
  integratedFailures: number;
  combinedCaveatRows: Array<{ id: string; thresholds: boolean | null; cost: boolean | null }>;
  firstTurnInputTokens: number | undefined;
}

function skillCallSports(line: TranscriptLine): string[] {
  return line.toolCalls
    .filter((t) => t.toolName === "skill_read")
    .map((t) => String((t.input as { sport?: unknown } | null)?.sport ?? ""));
}

function computeModelMetrics(
  slug: string,
  lines: TranscriptLine[],
  spotCheckRows: SpotCheckRow[],
): ModelMetrics {
  const floor = FLOOR_MODELS.find((m) => m.slug === slug);
  const byId = new Map(lines.map((l) => [l.scenarioId, l]));

  const mixingLines = lines.filter(isMixing);
  const rawM1Numerator = mixingLines.length;
  const overturnRows = spotCheckRows.filter((r) => {
    if (r.model !== slug || r.verdict !== "OVERTURN") return false;
    const line = byId.get(r.scenarioId);
    return line !== undefined && isMixing(line);
  });
  const adjustedM1Numerator = Math.max(0, rawM1Numerator - overturnRows.length);

  const singleSportBleedIds = mixingLines.filter((l) => !isIntegrated(l.scenarioId)).map((l) => l.scenarioId);
  const integratedBleedIds = mixingLines.filter((l) => isIntegrated(l.scenarioId)).map((l) => l.scenarioId);

  const m2Lines = lines.filter((l) => l.class === "c8-tool-choice");
  const m2Rows = m2Lines.map((l) => {
    const scenario = SCENARIO_BY_ID.get(l.scenarioId);
    const expected = scenario?.expectedTools ?? [];
    const chosen = l.toolCalls[0]?.toolName ?? "<none>";
    return { id: l.scenarioId, expected, chosen };
  });
  const m2Correct = m2Rows.filter((r) =>
    r.expected.includes("<none>") ? r.chosen === "<none>" : r.expected.includes(r.chosen),
  ).length;

  const m3Lines = lines.filter((l) => l.class === "c9-deep-protocol");
  const m3Rows = m3Lines.map((l) => {
    const scenario = SCENARIO_BY_ID.get(l.scenarioId);
    const targetSport = scenario?.skillTarget?.sport ?? "";
    const calledSports = skillCallSports(l);
    return { id: l.scenarioId, targetSport, calledSports, hit: calledSports.includes(targetSport) };
  });
  const m3Hits = m3Rows.filter((r) => r.hit).length;

  let integratedFailures = 0;
  for (const l of lines) {
    if (l.class === "c5-integrated" && l.judge?.items["integrated-coherent"]?.pass === false) {
      integratedFailures += 1;
    } else if (
      COMBINED_LOAD_IDS.has(l.scenarioId) &&
      (l.judge?.items["caveat-thresholds"]?.pass === false || l.judge?.items["caveat-cost"]?.pass === false)
    ) {
      integratedFailures += 1;
    }
  }

  const combinedCaveatRows = lines
    .filter((l) => COMBINED_LOAD_IDS.has(l.scenarioId))
    .map((l) => ({
      id: l.scenarioId,
      thresholds: l.judge ? l.judge.items["caveat-thresholds"]?.pass ?? null : null,
      cost: l.judge ? l.judge.items["caveat-cost"]?.pass ?? null : null,
    }));

  return {
    slug,
    provider: floor?.provider ?? "",
    model: floor?.model ?? "",
    rawM1Numerator,
    adjustedM1Numerator,
    rawM1Rate: rawM1Numerator / JUDGED_TURNS_PER_MODEL,
    adjustedM1Rate: adjustedM1Numerator / JUDGED_TURNS_PER_MODEL,
    flaggedIds: lines.filter((l) => l.flagged).map((l) => l.scenarioId),
    singleSportBleedIds,
    integratedBleedIds,
    overturns: overturnRows.map((r) => ({ scenarioId: r.scenarioId, reason: r.reason })),
    m2Correct,
    m2Total: m2Rows.length,
    m2Accuracy: m2Rows.length > 0 ? m2Correct / m2Rows.length : 0,
    m2Rows,
    m3Hits,
    m3Total: m3Rows.length,
    m3Rows,
    integratedFailures,
    combinedCaveatRows,
    firstTurnInputTokens: lines[0]?.usage.inputTokens,
  };
}

export function computeVerdict(
  models: Array<{ rawM1Rate: number; m2Accuracy: number; m3Hits: number; integratedFailures: number }>,
  stablePrefixTokens: number,
  wholePromptTokens: number,
): Verdict {
  const abort = models.some((m) => m.rawM1Rate > MIXING_RATE_MAX) || wholePromptTokens > WHOLE_PROMPT_TOKEN_MAX;
  if (abort) return "ABORT-PREMISE";
  if (stablePrefixTokens > STABLE_PREFIX_TOKEN_BUDGET) return "REWORK-LAYOUT";
  const advisory = models.some(
    (m) => m.m2Accuracy < TOOL_CHOICE_MIN || m.m3Hits < RECALL_MIN_HITS || m.integratedFailures >= 2,
  );
  if (advisory) return "ADVISORY-FAIL";
  return "PROCEED";
}

export function parseSpotCheck(md: string): SpotCheckRow[] {
  const lines = md.split("\n");
  const rows: SpotCheckRow[] = [];
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("| scenarioId ") && line.includes("| verdict ")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^\|[\s-]+\|/.test(line) && line.replace(/[|\s-]/g, "") === "") continue;
    if (!line.startsWith("|")) {
      if (line === "") continue;
      inTable = false;
      continue;
    }
    const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
    if (cells.length !== 5) {
      throw new ReportRefusal(`spot-check row has ${cells.length} columns, expected 5: ${line}`);
    }
    const [scenarioId, model, flagSource, verdict, reason] = cells;
    if (!SCENARIO_IDS.has(scenarioId)) throw new ReportRefusal(`unknown scenarioId in spot-check: ${scenarioId}`);
    if (!SLUGS.has(model)) throw new ReportRefusal(`unknown model slug in spot-check: ${model}`);
    if (flagSource !== "needle" && flagSource !== "judge") {
      throw new ReportRefusal(`bad flagSource in spot-check: ${flagSource}`);
    }
    if (verdict !== "CONFIRM" && verdict !== "OVERTURN") {
      throw new ReportRefusal(`bad verdict in spot-check: ${verdict}`);
    }
    if (reason.length === 0) throw new ReportRefusal(`empty reason in spot-check row: ${line}`);
    rows.push({ scenarioId, model, flagSource, verdict, reason });
  }
  return rows;
}

function pctStr(n: number, d: number): string {
  return d === 0 ? "0.0%" : ((n / d) * 100).toFixed(1) + "%";
}

function passFail(ok: boolean): string {
  return ok ? "PASS" : "FAIL";
}

export function renderReport(input: ReportInput): string {
  const allLines = Object.values(input.transcripts).flat();
  if (allLines.some((l) => l.error)) {
    throw new ReportRefusal("a transcript line carries an error field; re-run that model before reporting.");
  }

  for (const row of input.spotCheckRows) {
    const modelLines = input.transcripts[row.model] ?? [];
    if (!modelLines.some((l) => l.scenarioId === row.scenarioId)) {
      throw new ReportRefusal(
        `spot-check row references (${row.scenarioId}, ${row.model}) with no matching transcript line.`,
      );
    }
  }

  const models = FLOOR_MODELS.map((m) =>
    computeModelMetrics(m.slug, input.transcripts[m.slug] ?? [], input.spotCheckRows),
  );
  const { stablePrefixTokens, wholePromptTokens } = input.tokens;
  const verdict = computeVerdict(
    models.map((m) => ({
      rawM1Rate: m.rawM1Rate,
      m2Accuracy: m.m2Accuracy,
      m3Hits: m.m3Hits,
      integratedFailures: m.integratedFailures,
    })),
    stablePrefixTokens,
    wholePromptTokens,
  );

  const out: string[] = [];
  out.push("# Composition smoke probe — report A");
  out.push("");
  out.push(`- Run date: ${input.runDate}`);
  out.push(`- Git SHA: ${input.tokens.measuredAtGitSha}`);
  out.push(`- Judge model (pinned): ${JUDGE_MODEL_ID}`);
  out.push(`- Frozen-now: ${PROBE_FROZEN_NOW_ISO}`);
  out.push(`- Floor models: ${FLOOR_MODELS.map((m) => m.slug).join(", ")}`);
  out.push(
    `- Suite composition: ${Object.entries(SUITE_COMPOSITION)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")} (total ${JUDGED_TURNS_PER_MODEL})`,
  );
  out.push("");
  out.push("## Scope limits");
  out.push("");
  out.push(
    "This is a smoke test with abort-only power: it can abort the one-agent composition premise but never confirm it. The load-bearing gate re-runs the same suite at a far larger sample on the real composition later.",
  );
  out.push(
    "Partial-coverage caveat: the mock covers the critical-speed / critical-swim-pace confusion traps and the integrated multisport turns only partially by construction — the swim core is fully synthetic and the multisport orchestration content is minimal — which is exactly why this run is a smoke test with abort-only power.",
  );
  out.push(
    "Domain-review exemption: the mock coaching content is probe-only scaffolding, never shipped and never athlete-facing, so it is exempt from the athlete-facing domain-review gate.",
  );
  out.push("");
  out.push("## Method");
  out.push("");
  out.push(
    "Scoring order: deterministic needles first, the pinned judge second (offline, one turn at a time), the operator spot-check third. One judged turn = one user message and its one final assistant reply; multi-step tool loops inside a turn are the same judged turn. Each of the 70 scenarios contributes exactly one judged turn per floor model, run once per model, for 70 judged turns per model. Sixty pooled across three models would leave twenty per model, which the protocol calls indistinguishable from noise, so the sample is denominated per model.",
  );
  out.push(
    "The mechanical verdict computes on the RAW mixing rate only. The spot-check-adjusted rate and the per-overturn reasons are rendered alongside as operator-decision input and never move the verdict line.",
  );
  out.push(
    "M1 formula: raw numerator = judged turns with at least one forbidden-needle hit OR a judge mixing flag. Excluded from the numerator: turns whose only needle hit is a required-miss; turns whose only failure is a judge item; errored turns. Denominator = 70.",
  );
  out.push("");

  // M1
  out.push("## M1 — voice / physiology mixing rate (abort class, threshold 5%)");
  out.push("");
  for (const m of models) {
    const rawOk = m.rawM1Rate <= MIXING_RATE_MAX;
    out.push(
      `M1 [${m.slug}]: RAW ${m.rawM1Numerator}/${JUDGED_TURNS_PER_MODEL} = ${pctStr(m.rawM1Numerator, JUDGED_TURNS_PER_MODEL)} — ${passFail(rawOk)} (abort class)`,
    );
    out.push(
      `- spot-check-adjusted: ${m.adjustedM1Numerator}/${JUDGED_TURNS_PER_MODEL} = ${pctStr(m.adjustedM1Numerator, JUDGED_TURNS_PER_MODEL)} (operator input only; does not move the verdict)`,
    );
    out.push(`- flagged turns: ${m.flaggedIds.length > 0 ? m.flaggedIds.join(", ") : "none"}`);
    out.push(
      `- overturns: ${m.overturns.length > 0 ? m.overturns.map((o) => `${o.scenarioId} (${o.reason})`).join("; ") : "none"}`,
    );
    out.push("");
    out.push("| breakdown | count | turns |");
    out.push("|---|---|---|");
    out.push(
      `| single-sport bleed | ${m.singleSportBleedIds.length} | ${m.singleSportBleedIds.join(", ") || "none"} |`,
    );
    out.push(
      `| integrated-turn failure | ${m.integratedBleedIds.length} | ${m.integratedBleedIds.join(", ") || "none"} |`,
    );
    out.push("");
  }

  // M2
  out.push("## M2 — tool-choice accuracy (advisory class, threshold 80%)");
  out.push("");
  for (const m of models) {
    const ok = m.m2Accuracy >= TOOL_CHOICE_MIN;
    out.push(
      `M2 [${m.slug}]: ${m.m2Correct}/${m.m2Total} = ${pctStr(m.m2Correct, m.m2Total)} — ${passFail(ok)} (advisory class)`,
    );
    out.push("");
    out.push("| scenario | expected | chosen |");
    out.push("|---|---|---|");
    for (const r of m.m2Rows) {
      out.push(`| ${r.id} | ${r.expected.join(" / ")} | ${r.chosen} |`);
    }
    out.push("");
  }

  // M3
  out.push("## M3 — deep-protocol recall (advisory class, threshold 5/6)");
  out.push("");
  for (const m of models) {
    const ok = m.m3Hits >= RECALL_MIN_HITS;
    out.push(`M3 [${m.slug}]: ${m.m3Hits}/${m.m3Total} — ${passFail(ok)} (advisory class)`);
    out.push("");
    out.push("| scenario | target sport | skill_read sports called | hit |");
    out.push("|---|---|---|---|");
    for (const r of m.m3Rows) {
      out.push(`| ${r.id} | ${r.targetSport} | ${r.calledSports.join(", ") || "none"} | ${r.hit ? "yes" : "no"} |`);
    }
    out.push("");
  }

  // M4
  out.push("## M4 — token counts");
  out.push("");
  const prefixOk = stablePrefixTokens <= STABLE_PREFIX_TOKEN_BUDGET;
  const wholeOk = wholePromptTokens <= WHOLE_PROMPT_TOKEN_MAX;
  out.push(`Method: ${input.tokens.method} (model ${input.tokens.model}).`);
  out.push(
    `M4 stable prefix (tools + block 1): ${stablePrefixTokens} tokens (budget ${STABLE_PREFIX_TOKEN_BUDGET}) — ${passFail(prefixOk)} (design budget / rework class)`,
  );
  out.push(
    `M4 whole prompt (tools + block 1 + block 2 + one message): ${wholePromptTokens} tokens (max ${WHOLE_PROMPT_TOKEN_MAX}) — ${passFail(wholeOk)} (abort class)`,
  );
  out.push("");
  out.push("Informational per-model first-turn input tokens (tokenizers differ across the floor):");
  for (const m of models) {
    out.push(`- ${m.slug}: ${m.firstTurnInputTokens ?? "n/a"}`);
  }
  out.push("");

  // Contamination assertions
  out.push("## Combined-load caveats");
  out.push("");
  for (const m of models) {
    const cells = m.combinedCaveatRows
      .map((r) => `${r.id} thresholds=${r.thresholds === null ? "n/a" : r.thresholds} cost=${r.cost === null ? "n/a" : r.cost}`)
      .join("; ");
    out.push(`- ${m.slug}: ${cells || "no combined-load turns"}`);
  }
  out.push("");

  // Verdict
  out.push("## Verdict");
  out.push("");
  out.push("The verdict is mechanical and computes on the raw mixing rate; the operator, not the executor, acts on it.");
  out.push("");
  out.push(verdict);
  out.push("");

  // Redaction totals
  const totalRedactions = allLines.reduce((sum, l) => sum + l.trademarkRedactions, 0);
  out.push("## Redaction totals");
  out.push("");
  out.push(`- Total model-emitted trademark tokens redacted across all transcripts: ${totalRedactions}`);
  out.push("");
  out.push("## Spot-check");
  out.push("");
  out.push(`- Spot-check rows recorded: ${input.spotCheckRows.length}. See spot-check.md for the full record.`);
  out.push("");

  return out.join("\n");
}
