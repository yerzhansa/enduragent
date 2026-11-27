import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";

export const SEASON_REVIEW_REQUEST = `Prepare a cycling season review from the training history you can retrieve through the local store-backed tools.

Structure the response as: Season arc; What changed; What to keep or change; Questions.

Use only tool results returned during this review, and do not imply that returned ranges or fields represent the complete store. Every athlete-specific numeric, temporal, comparative, causal, observational, action, or conclusion premise must immediately carry \`[Evidence: <tool-name>(<exact arguments>) — <exact returned date/field/value>]\`. Cite only results returned during this review. Do not make claims beyond their returned date ranges or fields. Omit unsupported specificity. Label any unsupported causal interpretation \`Hypothesis\` and name the missing context needed to test it. Do not use an uncited assumption as an evidence anchor.

Treat Load, Intensity, Fitness, Fatigue, and Form as platform-supplied Reference layer values, not locally computed values. State when evidence is absent, stale, or ambiguous. Give at least three distinct evidence-backed observations across at least two parts of the season, identify an evidence-backed trend and an exception or recovery block, and give at least two actions with a time, quantity, or decision condition. Every action must cite the evidence-backed observation it responds to.

Ask 2–4 question blocks only about context absent from the returned results. Each block must use these exact labels in this exact order:
Evidence anchor: <observation> [Evidence: <tool-name>(<exact arguments>) — <exact returned date/field/value>]
Missing context: <what the returned results do not establish>
Question: <one question about that missing context>
Decision changed: <the coaching decision its answer would change>

Do not use an uncited assumption as an Evidence anchor. Do not ask for a fact already returned by a tool. Do not call mutating tools or create, delete, modify, write, or schedule calendar items, training data, or store state.`;

export const SEASON_REVIEW_MODEL_SAMPLES = [
  "model-calibration-01",
  "model-calibration-02",
  "model-calibration-03",
  "real",
] as const;
export type SeasonReviewModelSample = (typeof SEASON_REVIEW_MODEL_SAMPLES)[number];

export const SEASON_REVIEW_RUBRIC_SAMPLES = [
  "rubric-calibration-01",
  "rubric-calibration-02",
  "rubric-calibration-03",
] as const;

export const SEASON_REVIEW_SCORE_SCHEMA_BYTES = `{"type":"object","additionalProperties":false,"properties":{"schema_version":{"type":"integer","const":1},"report_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"grounding":{"type":"object","additionalProperties":false,"properties":{"G1":{"type":"boolean"},"G2":{"type":"boolean"},"G3":{"type":"boolean"},"G4":{"type":"boolean"},"verdict":{"type":"string","enum":["KEEP","REWORK"]}},"required":["G1","G2","G3","G4","verdict"]},"specificity":{"type":"object","additionalProperties":false,"properties":{"S1":{"type":"boolean"},"S2":{"type":"boolean"},"S3":{"type":"boolean"},"S4":{"type":"boolean"},"verdict":{"type":"string","enum":["KEEP","REWORK"]}},"required":["S1","S2","S3","S4","verdict"]},"question_quality":{"type":"object","additionalProperties":false,"properties":{"Q1":{"type":"boolean"},"Q2":{"type":"boolean"},"Q3":{"type":"boolean"},"Q4":{"type":"boolean"},"verdict":{"type":"string","enum":["KEEP","REWORK"]}},"required":["Q1","Q2","Q3","Q4","verdict"]}},"required":["schema_version","report_sha256","grounding","specificity","question_quality"]}
`;

export const SEASON_REVIEW_RUBRIC_BYTES = `{
  "schema_version": 1,
  "criteria": [
    {"id":"grounding","anchors":[{"id":"G1","text":"Every athlete-specific numeric, temporal, comparative, and causal statement maps to supplied store/tool evidence; an unsupported causal idea is explicitly labeled a hypothesis."},{"id":"G2","text":"Zero statement contradicts supplied evidence and zero quantity/date is invented."},{"id":"G3","text":"Missing, stale, or ambiguous evidence relevant to a conclusion is disclosed rather than filled in."},{"id":"G4","text":"Load, Intensity, Fitness, Fatigue, and Form provenance is called platform-supplied through the Reference layer; no local-compute or whole-store claim appears."}],"rule":"all_anchors_true"},
    {"id":"specificity","anchors":[{"id":"S1","text":"At least three distinct evidence-backed observations span at least two season periods."},{"id":"S2","text":"At least one trend/change and at least one exception, recovery, or block are identified from evidence."},{"id":"S3","text":"At least two actions each bind to named evidence and a time, quantity, or decision condition."},{"id":"S4","text":"Every recommendation is tied to evidence or explicitly missing context; no generic-advice paragraph remains."}],"rule":"all_anchors_true"},
    {"id":"question_quality","anchors":[{"id":"Q1","text":"The report asks two through four semantic questions, inclusive."},{"id":"Q2","text":"Every question targets context absent from supplied store evidence."},{"id":"Q3","text":"Every question names the coaching decision its answer would change."},{"id":"Q4","text":"No question restates the report or asks for a fact already supplied by the store."}],"rule":"all_anchors_true"}
  ],
  "overall_rule": "all_three_keep"
}
`;

const HASH = /^[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{40}$/;
const VERDICTS = ["KEEP", "REWORK"] as const;
export type SeasonReviewVerdict = (typeof VERDICTS)[number];

export type SeasonReviewCriterion<I extends string> = Readonly<Record<I, boolean>> & {
  readonly verdict: SeasonReviewVerdict;
};

export interface SeasonReviewScore {
  readonly schema_version: 1;
  readonly report_sha256: string;
  readonly grounding: SeasonReviewCriterion<"G1" | "G2" | "G3" | "G4">;
  readonly specificity: SeasonReviewCriterion<"S1" | "S2" | "S3" | "S4">;
  readonly question_quality: SeasonReviewCriterion<"Q1" | "Q2" | "Q3" | "Q4">;
}

export interface SeasonReviewCost {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly priced_calls: number;
  readonly unpriced_calls: number;
  readonly usd_input: number | null;
  readonly usd_output: number | null;
  readonly usd_cache_read: number | null;
  readonly usd_cache_write: number | null;
  readonly usd_total: number | null;
}

export interface SeasonReviewRunRecord {
  readonly schema_version: 1;
  readonly head_sha: string;
  readonly sample: SeasonReviewModelSample;
  readonly provider: string;
  readonly model: string;
  readonly report_sha256: string;
  readonly store_before_sha256: string;
  readonly store_after_sha256: string;
  readonly store_unchanged: true;
  readonly generate_calls: number;
  readonly cost: SeasonReviewCost;
}

export interface SeasonReviewUsageRow {
  readonly kind: "generate" | "turn" | "boot";
  readonly provider: string;
  readonly model: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export interface SeasonReviewCalibrationConclusion {
  readonly sample: "model-calibration-01" | "model-calibration-02" | "model-calibration-03";
  readonly report_sha256: string;
  readonly grounding: SeasonReviewVerdict;
  readonly specificity: SeasonReviewVerdict;
  readonly question_quality: SeasonReviewVerdict;
}

export interface SeasonReviewConclusion {
  readonly schema_version: 1;
  readonly head_sha: string;
  readonly provider: string;
  readonly model: string;
  readonly rubric_sha256: string;
  readonly model_calibration: readonly SeasonReviewCalibrationConclusion[];
  readonly grounding: SeasonReviewVerdict;
  readonly specificity: SeasonReviewVerdict;
  readonly question_quality: SeasonReviewVerdict;
  readonly cost_totals: {
    readonly calibration: SeasonReviewCost;
    readonly real: SeasonReviewCost;
    readonly combined: SeasonReviewCost;
  };
  readonly overall: SeasonReviewVerdict;
  readonly evidence_sha256: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new TypeError(`${label} keys are invalid.`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function head(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEAD.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is invalid.`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function finiteCost(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function verdict(value: unknown, label: string): SeasonReviewVerdict {
  if (value !== "KEEP" && value !== "REWORK") throw new TypeError(`${label} is invalid.`);
  return value;
}

export function sha256Bytes(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashSeasonReviewEvidence(manifest: unknown): string {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(manifest)));
}

export function seasonReviewBlindKey(reportBytes: Uint8Array, label: string): string {
  if (typeof label !== "string" || label.length === 0) throw new TypeError("Blind label is invalid.");
  return createHash("sha256").update(reportBytes).update(new Uint8Array([0])).update(label, "utf8").digest("hex");
}

export function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("USD value is invalid.");
  return Math.round(value * 1e12) / 1e12;
}

function validateCriterion(
  value: unknown,
  ids: readonly string[],
  label: string,
): Record<string, boolean | SeasonReviewVerdict> {
  const candidate = record(value, label);
  exactKeys(candidate, [...ids, "verdict"], label);
  const anchors = ids.map((id) => {
    if (typeof candidate[id] !== "boolean") throw new TypeError(`${label}.${id} is invalid.`);
    return candidate[id] as boolean;
  });
  const expected = anchors.every(Boolean) ? "KEEP" : "REWORK";
  if (verdict(candidate.verdict, `${label}.verdict`) !== expected) {
    throw new TypeError(`${label}.verdict does not match its anchors.`);
  }
  return candidate as Record<string, boolean | SeasonReviewVerdict>;
}

export function validateSeasonReviewScore(value: unknown, reportSha256?: string): SeasonReviewScore {
  const candidate = record(value, "Season review score");
  exactKeys(candidate, ["schema_version", "report_sha256", "grounding", "specificity", "question_quality"], "Season review score");
  if (candidate.schema_version !== 1) throw new TypeError("Season review score version is invalid.");
  const reportHash = hash(candidate.report_sha256, "Season review report hash");
  if (reportSha256 !== undefined && reportHash !== hash(reportSha256, "Expected report hash")) {
    throw new TypeError("Season review score is bound to a different report.");
  }
  const grounding = validateCriterion(candidate.grounding, ["G1", "G2", "G3", "G4"], "Grounding score");
  const specificity = validateCriterion(candidate.specificity, ["S1", "S2", "S3", "S4"], "Specificity score");
  const questionQuality = validateCriterion(candidate.question_quality, ["Q1", "Q2", "Q3", "Q4"], "Question-quality score");
  return {
    schema_version: 1,
    report_sha256: reportHash,
    grounding: grounding as unknown as SeasonReviewScore["grounding"],
    specificity: specificity as unknown as SeasonReviewScore["specificity"],
    question_quality: questionQuality as unknown as SeasonReviewScore["question_quality"],
  };
}

const COST_KEYS = [
  "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens",
  "priced_calls", "unpriced_calls", "usd_input", "usd_output", "usd_cache_read", "usd_cache_write", "usd_total",
] as const;
const USD_KEYS = ["usd_input", "usd_output", "usd_cache_read", "usd_cache_write", "usd_total"] as const;

export function validateCost(value: unknown, generateCalls: number): SeasonReviewCost {
  const calls = nonNegativeSafeInteger(generateCalls, "Generate call count");
  const candidate = record(value, "Season review cost");
  exactKeys(candidate, COST_KEYS, "Season review cost");
  const cost: SeasonReviewCost = {
    input_tokens: nonNegativeSafeInteger(candidate.input_tokens, "Input tokens"),
    output_tokens: nonNegativeSafeInteger(candidate.output_tokens, "Output tokens"),
    total_tokens: nonNegativeSafeInteger(candidate.total_tokens, "Total tokens"),
    cache_read_tokens: nonNegativeSafeInteger(candidate.cache_read_tokens, "Cache-read tokens"),
    cache_write_tokens: nonNegativeSafeInteger(candidate.cache_write_tokens, "Cache-write tokens"),
    priced_calls: nonNegativeSafeInteger(candidate.priced_calls, "Priced call count"),
    unpriced_calls: nonNegativeSafeInteger(candidate.unpriced_calls, "Unpriced call count"),
    usd_input: null,
    usd_output: null,
    usd_cache_read: null,
    usd_cache_write: null,
    usd_total: null,
  };
  if (cost.priced_calls + cost.unpriced_calls !== calls) throw new TypeError("Cost call counts are invalid.");
  if (cost.unpriced_calls > 0) {
    for (const key of USD_KEYS) if (candidate[key] !== null) throw new TypeError("Unpriced costs must have null USD values.");
    return cost;
  }
  const usdInput = finiteCost(candidate.usd_input, "Input cost");
  const usdOutput = finiteCost(candidate.usd_output, "Output cost");
  const usdCacheRead = finiteCost(candidate.usd_cache_read, "Cache-read cost");
  const usdCacheWrite = finiteCost(candidate.usd_cache_write, "Cache-write cost");
  const usdTotal = finiteCost(candidate.usd_total, "Total cost");
  if (usdTotal !== roundUsd(usdInput + usdOutput + usdCacheRead + usdCacheWrite)) {
    throw new TypeError("Total USD cost is invalid.");
  }
  return { ...cost, usd_input: usdInput, usd_output: usdOutput, usd_cache_read: usdCacheRead,
    usd_cache_write: usdCacheWrite, usd_total: usdTotal };
}

function token(row: SeasonReviewUsageRow, key: "inputTokens" | "outputTokens" | "totalTokens" | "cacheReadTokens" | "cacheWriteTokens"): number {
  return row[key] === undefined ? 0 : nonNegativeSafeInteger(row[key], `Usage ${key}`);
}

export function summarizeGenerateUsage(
  rows: readonly SeasonReviewUsageRow[],
  provider: string,
  model: string,
): { readonly generateCalls: number; readonly cost: SeasonReviewCost } {
  nonEmpty(provider, "Provider");
  nonEmpty(model, "Model");
  const generated = rows.filter((row) => row.kind === "generate");
  if (generated.length < 1) throw new TypeError("No generate usage was recorded.");
  const sums = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0,
    priced: 0, usdInput: 0, usdOutput: 0, usdCacheRead: 0, usdCacheWrite: 0 };
  for (const row of generated) {
    if (row.provider !== provider || row.model !== model) throw new TypeError("Usage identity differs from the configured model.");
    sums.input += token(row, "inputTokens");
    sums.output += token(row, "outputTokens");
    sums.total += token(row, "totalTokens");
    sums.cacheRead += token(row, "cacheReadTokens");
    sums.cacheWrite += token(row, "cacheWriteTokens");
    for (const [label, amount] of [["input", sums.input], ["output", sums.output], ["total", sums.total],
      ["cache read", sums.cacheRead], ["cache write", sums.cacheWrite]] as const) {
      if (!Number.isSafeInteger(amount)) throw new TypeError(`Summed ${label} tokens are invalid.`);
    }
    if (row.cost !== undefined) {
      const priced = record(row.cost, "Generate cost");
      exactKeys(priced, ["input", "output", "cacheRead", "cacheWrite", "total"], "Generate cost");
      const input = finiteCost(priced.input, "Generate input cost");
      const output = finiteCost(priced.output, "Generate output cost");
      const cacheRead = finiteCost(priced.cacheRead, "Generate cache-read cost");
      const cacheWrite = finiteCost(priced.cacheWrite, "Generate cache-write cost");
      finiteCost(priced.total, "Generate total cost");
      sums.priced += 1;
      sums.usdInput += input; sums.usdOutput += output;
      sums.usdCacheRead += cacheRead; sums.usdCacheWrite += cacheWrite;
    }
  }
  const unpriced = generated.length - sums.priced;
  const nullUsd = unpriced > 0;
  return { generateCalls: generated.length, cost: validateCost({
    input_tokens: sums.input, output_tokens: sums.output, total_tokens: sums.total,
    cache_read_tokens: sums.cacheRead, cache_write_tokens: sums.cacheWrite,
    priced_calls: sums.priced, unpriced_calls: unpriced,
    usd_input: nullUsd ? null : roundUsd(sums.usdInput),
    usd_output: nullUsd ? null : roundUsd(sums.usdOutput),
    usd_cache_read: nullUsd ? null : roundUsd(sums.usdCacheRead),
    usd_cache_write: nullUsd ? null : roundUsd(sums.usdCacheWrite),
    usd_total: nullUsd ? null : roundUsd(sums.usdInput + sums.usdOutput + sums.usdCacheRead + sums.usdCacheWrite),
  }, generated.length) };
}

export function combineCosts(costs: readonly { readonly cost: SeasonReviewCost; readonly generateCalls: number }[]): {
  readonly cost: SeasonReviewCost; readonly generateCalls: number;
} {
  if (costs.length === 0) throw new TypeError("At least one cost is required.");
  let generateCalls = 0;
  const sums = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, priced: 0, unpriced: 0,
    usdInput: 0, usdOutput: 0, usdCacheRead: 0, usdCacheWrite: 0 };
  for (const item of costs) {
    const value = validateCost(item.cost, item.generateCalls);
    generateCalls += item.generateCalls;
    sums.input += value.input_tokens; sums.output += value.output_tokens; sums.total += value.total_tokens;
    sums.cacheRead += value.cache_read_tokens; sums.cacheWrite += value.cache_write_tokens;
    sums.priced += value.priced_calls; sums.unpriced += value.unpriced_calls;
    sums.usdInput += value.usd_input ?? 0; sums.usdOutput += value.usd_output ?? 0;
    sums.usdCacheRead += value.usd_cache_read ?? 0; sums.usdCacheWrite += value.usd_cache_write ?? 0;
  }
  for (const value of [generateCalls, sums.input, sums.output, sums.total, sums.cacheRead, sums.cacheWrite]) {
    if (!Number.isSafeInteger(value)) throw new TypeError("Combined cost is invalid.");
  }
  const nullUsd = sums.unpriced > 0;
  return { generateCalls, cost: validateCost({
    input_tokens: sums.input, output_tokens: sums.output, total_tokens: sums.total,
    cache_read_tokens: sums.cacheRead, cache_write_tokens: sums.cacheWrite,
    priced_calls: sums.priced, unpriced_calls: sums.unpriced,
    usd_input: nullUsd ? null : roundUsd(sums.usdInput),
    usd_output: nullUsd ? null : roundUsd(sums.usdOutput),
    usd_cache_read: nullUsd ? null : roundUsd(sums.usdCacheRead),
    usd_cache_write: nullUsd ? null : roundUsd(sums.usdCacheWrite),
    usd_total: nullUsd ? null : roundUsd(sums.usdInput + sums.usdOutput + sums.usdCacheRead + sums.usdCacheWrite),
  }, generateCalls) };
}

export function validateSeasonReviewRunRecord(
  value: unknown,
  expected: Partial<Pick<SeasonReviewRunRecord, "head_sha" | "sample" | "provider" | "model" | "report_sha256">> = {},
): SeasonReviewRunRecord {
  const candidate = record(value, "Season review run record");
  exactKeys(candidate, ["schema_version", "head_sha", "sample", "provider", "model", "report_sha256",
    "store_before_sha256", "store_after_sha256", "store_unchanged", "generate_calls", "cost"], "Season review run record");
  if (candidate.schema_version !== 1 || candidate.store_unchanged !== true) throw new TypeError("Season review run record is invalid.");
  const sample = candidate.sample;
  if (typeof sample !== "string" || !(SEASON_REVIEW_MODEL_SAMPLES as readonly string[]).includes(sample)) {
    throw new TypeError("Season review sample is invalid.");
  }
  const generateCalls = nonNegativeSafeInteger(candidate.generate_calls, "Generate calls");
  const cost = validateCost(candidate.cost, generateCalls);
  const result: SeasonReviewRunRecord = {
    schema_version: 1,
    head_sha: head(candidate.head_sha, "Run HEAD"),
    sample: sample as SeasonReviewModelSample,
    provider: nonEmpty(candidate.provider, "Run provider"),
    model: nonEmpty(candidate.model, "Run model"),
    report_sha256: hash(candidate.report_sha256, "Run report hash"),
    store_before_sha256: hash(candidate.store_before_sha256, "Store-before hash"),
    store_after_sha256: hash(candidate.store_after_sha256, "Store-after hash"),
    store_unchanged: true,
    generate_calls: generateCalls,
    cost,
  };
  if (result.generate_calls < 1 || result.store_before_sha256 !== result.store_after_sha256) {
    throw new TypeError("Season review run did not preserve the store.");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && result[key as keyof SeasonReviewRunRecord] !== value) {
      throw new TypeError(`Season review run ${key} differs from the expected value.`);
    }
  }
  return result;
}

export function scoreVerdicts(score: SeasonReviewScore): {
  readonly grounding: SeasonReviewVerdict;
  readonly specificity: SeasonReviewVerdict;
  readonly question_quality: SeasonReviewVerdict;
} {
  return { grounding: score.grounding.verdict, specificity: score.specificity.verdict,
    question_quality: score.question_quality.verdict };
}

export function validateSeasonReviewConclusion(value: unknown, expectedHead?: string): SeasonReviewConclusion {
  const candidate = record(value, "Season review conclusion");
  exactKeys(candidate, ["schema_version", "head_sha", "provider", "model", "rubric_sha256", "model_calibration",
    "grounding", "specificity", "question_quality", "cost_totals", "overall", "evidence_sha256"], "Season review conclusion");
  if (candidate.schema_version !== 1) throw new TypeError("Season review conclusion version is invalid.");
  const headSha = head(candidate.head_sha, "Conclusion HEAD");
  if (expectedHead !== undefined && headSha !== head(expectedHead, "Expected conclusion HEAD")) {
    throw new TypeError("Season review conclusion HEAD differs.");
  }
  if (!Array.isArray(candidate.model_calibration) || candidate.model_calibration.length !== 3) {
    throw new TypeError("Model calibration conclusions are invalid.");
  }
  const calibration = candidate.model_calibration.map((value, index): SeasonReviewCalibrationConclusion => {
    const item = record(value, "Model calibration conclusion");
    exactKeys(item, ["sample", "report_sha256", "grounding", "specificity", "question_quality"], "Model calibration conclusion");
    const sample = SEASON_REVIEW_MODEL_SAMPLES[index];
    if (index > 2 || item.sample !== sample) throw new TypeError("Model calibration order is invalid.");
    return { sample: sample as SeasonReviewCalibrationConclusion["sample"],
      report_sha256: hash(item.report_sha256, "Calibration report hash"),
      grounding: verdict(item.grounding, "Calibration grounding"),
      specificity: verdict(item.specificity, "Calibration specificity"),
      question_quality: verdict(item.question_quality, "Calibration question quality") };
  });
  const grounding = verdict(candidate.grounding, "Real grounding");
  const specificity = verdict(candidate.specificity, "Real specificity");
  const questionQuality = verdict(candidate.question_quality, "Real question quality");
  const expectedOverall = [grounding, specificity, questionQuality].every((value) => value === "KEEP") ? "KEEP" : "REWORK";
  if (verdict(candidate.overall, "Overall verdict") !== expectedOverall) throw new TypeError("Overall verdict is invalid.");
  const totals = record(candidate.cost_totals, "Cost totals");
  exactKeys(totals, ["calibration", "real", "combined"], "Cost totals");
  const calibrationCostRaw = record(totals.calibration, "Calibration cost");
  const realCostRaw = record(totals.real, "Real cost");
  const combinedCostRaw = record(totals.combined, "Combined cost");
  const calls = (cost: Record<string, unknown>): number =>
    nonNegativeSafeInteger(cost.priced_calls, "Priced calls") + nonNegativeSafeInteger(cost.unpriced_calls, "Unpriced calls");
  const calibrationCost = validateCost(calibrationCostRaw, calls(calibrationCostRaw));
  const realCost = validateCost(realCostRaw, calls(realCostRaw));
  const combinedCost = validateCost(combinedCostRaw, calls(combinedCostRaw));
  const expectedCombined = combineCosts([
    { cost: calibrationCost, generateCalls: calls(calibrationCostRaw) },
    { cost: realCost, generateCalls: calls(realCostRaw) },
  ]).cost;
  if (canonicalJson(combinedCost) !== canonicalJson(expectedCombined)) throw new TypeError("Combined cost is invalid.");
  return {
    schema_version: 1, head_sha: headSha, provider: nonEmpty(candidate.provider, "Conclusion provider"),
    model: nonEmpty(candidate.model, "Conclusion model"), rubric_sha256: hash(candidate.rubric_sha256, "Rubric hash"),
    model_calibration: calibration, grounding, specificity, question_quality: questionQuality,
    cost_totals: { calibration: calibrationCost, real: realCost, combined: combinedCost },
    overall: expectedOverall, evidence_sha256: hash(candidate.evidence_sha256, "Evidence hash"),
  };
}

export function assertExactSeasonReviewRubric(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(Buffer.from(SEASON_REVIEW_RUBRIC_BYTES))) throw new TypeError("Season review rubric bytes differ.");
}

export function assertExactSeasonReviewScoreSchema(bytes: Uint8Array): void {
  if (!Buffer.from(bytes).equals(Buffer.from(SEASON_REVIEW_SCORE_SCHEMA_BYTES))) throw new TypeError("Season review score schema bytes differ.");
}
