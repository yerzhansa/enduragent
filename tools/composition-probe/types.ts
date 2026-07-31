import type { GenerateOpts } from "../../packages/core/src/llm-types.js";

export type ProbeToolSet = NonNullable<GenerateOpts["tools"]>;
export type StopFn = Exclude<NonNullable<GenerateOpts["stopWhen"]>, readonly unknown[]>;

export type ScenarioClass = keyof typeof import("./constants.js")["SUITE_COMPOSITION"];

export interface ProbeScenario {
  id: string;
  class: ScenarioClass;
  userMessage: string;
  forbiddenNeedles?: RegExp[];
  requiredNeedles?: RegExp[];
  judgeItems?: string[];
  expectedTools?: string[];
  skillTarget?: { sport: string; topic: string };
}

export interface TranscriptLine {
  scenarioId: string;
  class: string;
  model: string;
  provider: string;
  userMessage: string;
  assistantText: string;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  steps: number;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  durationMs: number;
  needleHits: Array<{ kind: "forbidden" | "required-miss"; pattern: string; excerpt: string }>;
  judge?: JudgeVerdict;
  flagged: boolean;
  trademarkRedactions: number;
  error?: string;
}

export interface JudgeVerdict {
  mixing: { flag: boolean; evidence: string | null; sportsInvolved: string[] };
  items: Record<string, { pass: boolean; note: string }>;
}
