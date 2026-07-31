import { FLOOR_MODELS } from "./constants.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import type { ProbeScenario, TranscriptLine } from "./types.js";
import type { ReportInput, SpotCheckRow } from "./report.js";
import type { TokensJson } from "./tokens.js";

export const TAPER_KNOWN_FACT = "Day -8";

function byId(id: string): ProbeScenario {
  const s = ALL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`fixture references unknown scenario ${id}`);
  return s;
}

export function makeLine(o: Partial<TranscriptLine> & { scenarioId: string; class: string }): TranscriptLine {
  return {
    scenarioId: o.scenarioId,
    class: o.class,
    model: o.model ?? "mock-model",
    provider: o.provider ?? "anthropic",
    userMessage: o.userMessage ?? "question",
    assistantText: o.assistantText ?? "a synthetic coaching reply",
    toolCalls: o.toolCalls ?? [],
    steps: o.steps ?? 1,
    usage: o.usage ?? { inputTokens: 1200 },
    durationMs: o.durationMs ?? 10,
    needleHits: o.needleHits ?? [],
    judge: o.judge,
    flagged: o.flagged ?? false,
    trademarkRedactions: o.trademarkRedactions ?? 0,
    error: o.error,
  };
}

// ---- Check 3: needle engine ----
export const NEEDLE_FORBIDDEN_SCENARIO = byId("c2-01");
export const NEEDLE_FORBIDDEN_TEXT = "Reviewing your run, your DFA reading drifted through the session.";
export const NEEDLE_CLEAN_TEXT = "Reviewing your run: you held about 82% of critical speed and it stayed conversational.";
export const NEEDLE_REQUIRED_MISS_SCENARIO = byId("c7-07");
export const NEEDLE_REQUIRED_MISS_TEXT = "Your combined load across the three sports is about 525 this week.";

// ---- Check 4: recall scorer ----
export const RECALL_HIT_LINE = makeLine({
  scenarioId: "c9-01",
  class: "c9-deep-protocol",
  toolCalls: [{ toolName: "skill_read", input: { sport: "cycling", topic: "taper" } }],
});
export const RECALL_MISS_LINE = makeLine({ scenarioId: "c9-01", class: "c9-deep-protocol", toolCalls: [] });
export const RECALL_WRONG_SPORT_LINE = makeLine({
  scenarioId: "c9-01",
  class: "c9-deep-protocol",
  toolCalls: [{ toolName: "skill_read", input: { sport: "running", topic: "fueling" } }],
});

// ---- Check 6: redactor + needle-on-raw order ----
const TSS_TOKEN = "TS" + "S";
const IF_TOKEN = "I" + "F";
export const REDACT_SAMPLE_RAW = `Reviewing your run: DFA drifted, and your ${TSS_TOKEN} was high though ${IF_TOKEN} felt easy.`;
export const REDACT_STANDALONE_IF = IF_TOKEN;
export const REDACT_TSS = TSS_TOKEN;

// ---- Check 5 + report tests: canned run data ----
const SLUG0 = FLOOR_MODELS[0].slug;
const SLUG1 = FLOOR_MODELS[1].slug;
const SLUG2 = FLOOR_MODELS[2].slug;

const SPOT_CHECK_HEADER = "| scenarioId | model | flagSource | verdict | reason |\n|---|---|---|---|---|\n";
export const ABORT_SPOT_CHECK_MD =
  SPOT_CHECK_HEADER + `| c2-01 | ${SLUG0} | needle | OVERTURN | conversational mention only |\n`;
export const EMPTY_SPOT_CHECK_MD = SPOT_CHECK_HEADER;

function forbiddenLine(scenarioId: string, slug: string): TranscriptLine {
  return makeLine({
    scenarioId,
    class: "c2-running",
    model: slug,
    needleHits: [{ kind: "forbidden", pattern: "/\\bDFA\\b/i", excerpt: "DFA drifted" }],
    flagged: true,
    judge: { mixing: { flag: false, evidence: null, sportsInvolved: [] }, items: {} },
  });
}

function cleanRunnerLine(scenarioId: string, cls: string, slug: string): TranscriptLine {
  return makeLine({
    scenarioId,
    class: cls,
    model: slug,
    judge: { mixing: { flag: false, evidence: null, sportsInvolved: [] }, items: {} },
  });
}

function baseTokens(overrides: Partial<TokensJson>): TokensJson {
  return {
    method: "anthropic count_tokens",
    model: "claude-haiku-4-5-20251001",
    stablePrefixTokens: 12000,
    wholePromptTokens: 40000,
    measuredAtGitSha: "0000000000000000000000000000000000000000",
    ...overrides,
  };
}

export function abortReportInput(): ReportInput {
  const model0 = [
    forbiddenLine("c2-01", SLUG0),
    forbiddenLine("c2-02", SLUG0),
    forbiddenLine("c2-03", SLUG0),
    forbiddenLine("c2-04", SLUG0),
    cleanRunnerLine("c1-01", "c1-cycling", SLUG0),
  ];
  const model1 = [cleanRunnerLine("c1-01", "c1-cycling", SLUG1)];
  const model2 = [cleanRunnerLine("c1-01", "c1-cycling", SLUG2)];
  const spotCheckRows: SpotCheckRow[] = [
    { scenarioId: "c2-01", model: SLUG0, flagSource: "needle", verdict: "OVERTURN", reason: "conversational mention only" },
  ];
  return {
    runDate: "1998-07-06",
    tokens: baseTokens({}),
    transcripts: { [SLUG0]: model0, [SLUG1]: model1, [SLUG2]: model2 },
    spotCheckRows,
  };
}

export function reworkReportInput(): ReportInput {
  const clean = (slug: string) => [cleanRunnerLine("c1-01", "c1-cycling", slug)];
  return {
    runDate: "1998-07-06",
    tokens: baseTokens({ stablePrefixTokens: 15001 }),
    transcripts: { [SLUG0]: clean(SLUG0), [SLUG1]: clean(SLUG1), [SLUG2]: clean(SLUG2) },
    spotCheckRows: [],
  };
}
