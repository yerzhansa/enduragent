import type { MockIntervalsOptions } from "../../../packages/core/tests/helpers/mock-intervals.js";

export const S8A_PROVIDERS = ["anthropic", "openai-codex"] as const;
export type S8aProvider = (typeof S8A_PROVIDERS)[number];

export interface S8aScenario {
  execution?: { kind: "answer-check"; cases: AnswerCheckCase[] };
  id: string; // kebab-case, unique; used in fixture paths
  tier: "replay" | "live"; // ONLY "replay" scenarios gate CI
  description: string;
  /** Files staged into the fresh temp athlete home before the agent is constructed. */
  home?: {
    memoryMd?: string; // -> <home>/memory/MEMORY.md
    eventsJsonl?: string; // -> <home>/memory/events.jsonl
    sessions?: Record<string, string>; // chatId -> <home>/sessions/<chatId>.jsonl content
  };
  /** Dataset served by the MSW intervals mock. Every section any recorded tool
   *  execution touches MUST be explicit (record mode enforces; exit 2 otherwise). */
  intervals: MockIntervalsOptions;
  /** ISO instant the frozen clock is pinned to. Default: FROZEN_NOW. */
  frozenNowIso?: string;
  /** Narrow spawn-env override; ONLY this key is honored. Needed by
   *  session-trim-compaction to trigger the trim path without a megabyte fixture. */
  env?: { HISTORY_TOKEN_BUDGET_RATIO?: string };
  /** The conversation. Each turn is one CoachAgent.chat() call. */
  turns: Array<{ chatId: string; userMessage: string }>;
  /** Deterministic needles evaluated against every turn's final reply text. */
  forbiddenNeedles?: Array<string | RegExp>;
  requiredNeedles?: Array<string | RegExp>;
  /** Record-mode validation: the recording must contain executions of these tools /
   *  calls by these callers, else record mode exits 2 (prevents committing a
   *  fixture that never exercised the intended path). */
  recordExpectations?: {
    tools?: string[];
    callers?: Array<"chat" | "flush" | "compact" | "intent-translation">;
  };
}

export interface AnswerCheckCase {
  id: string;
  field: "commitments" | "success";
  text: string;
  expected: {
    outcome: "understood" | "ask" | "skip";
    value: unknown;
    action: "confirm" | "skip" | "cancel";
    savedAnswer: unknown;
  };
}

export interface AnswerCheckObservation {
  id: string;
  elapsedMs: number;
  busyObserved: boolean;
  unchangedBeforeConfirmation: boolean;
  result: unknown;
  savedAnswer: unknown;
}

/** The intervals client's wellness response schema requires `sportInfo` to be
 *  an array (or absent), while the mock helper's type declares an object — an
 *  object value makes the real tool return a validation error instead of data.
 *  Scenario wellness entries pin this typed empty array. */
export const EMPTY_SPORT_INFO = [] as unknown as Record<string, unknown>;

export interface RecordedToolExecution {
  seq: number;
  toolName: string;
  input: unknown; // as passed to execute()
  resultCanonical: unknown; // stable-serialized tool result
}

export interface RecordedTextDeltaEvent {
  readonly type: "text_delta";
  readonly delta: string;
}

export type RecordedRequest =
  | MessagesShapedRequest
  | PromptShapedRequest
  | IntentTranslationRequest;

export interface MessagesShapedRequest {
  shape: "messages";
  caller: "chat" | "flush";
  system: string; // full assembled system prompt (the human-diff source)
  systemSha256_16: string;
  templateHash?: string; // caller "chat" only; absent on flush
  assembledHash: string; // sha256_16(JSON.stringify({system, messages})) — production formula
  messages: unknown[]; // the ModelMessage[] as passed to generate
  toolNames: string[]; // sorted Object.keys(opts.tools ?? {})
  maxSteps: number | null;
  cacheKey: string | null; // chat: sha256_16(chatId); flush: null
}

export interface PromptShapedRequest {
  shape: "prompt";
  caller: "compact";
  prompt: string; // full prompt string (byte-compared on replay)
  promptSha256_16: string;
  maxOutputTokens: number | null;
  toolNames: []; // compact calls carry no tools
  maxSteps: null;
  cacheKey: null;
}

export interface IntentTranslationRequest {
  shape: "intent-translation";
  caller: "intent-translation";
  system: string;
  systemSha256_16: string;
  input: { shape: "prompt"; prompt: string } | { shape: "messages"; messages: unknown[] };
  toolNames: string[];
  maxSteps: number | null;
  maxOutputTokens: number | null;
  cacheKey: string | null;
  deadlineMs: number;
}

export interface RecordedCall {
  ordinal: number;
  caller: "chat" | "flush" | "compact" | "intent-translation";
  checkId?: string;
  turn: { chatId: string; turnIndex: number } | null;
  request: RecordedRequest;
  toolExecutions: RecordedToolExecution[];
  result: {
    text: string;
    toolCalls: unknown[]; // last-step toolCalls as the generate result carries them
    finishReason: string;
    usage: unknown;
    totalUsage: unknown;
    steps: number;
    cost?: unknown;
  };
  events: RecordedTextDeltaEvent[] | null;
}

export interface S8aRecording {
  s8aRecordingVersion: 1;
  scenario: string;
  recordedAt: string; // frozen-now ISO
  provider: S8aProvider; // stamped from the recording run's config
  model: string; // stamped from the recording run's config
  lineage: { templateHash: string; lineageVersion: "unversioned" }; // header hash informational, NOT asserted
  calls: RecordedCall[];
  answerChecks?: AnswerCheckObservation[];
}

export type AssertId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7";
export interface AssertFailure {
  assertId: AssertId;
  scenario: string;
  detail: string;
  diffFile?: string;
}
export interface ScenarioVerdict {
  scenario: string;
  pass: boolean;
  failures: AssertFailure[];
  warns?: AssertFailure[];
}

/** An AssertFailure that still carries the diff-file body; the runner writes the
 *  body to `diffFile` under the run dir and reports the bare AssertFailure. */
export interface FailureWithDiff extends AssertFailure {
  diffContent?: string;
}

/** An A1/A3 hash mismatch on a chat-caller call cannot be ruled FAIL-vs-WARN at
 *  call time: the supersession lookup needs the live session-line templateHash,
 *  which production writes only after generate returns. */
export interface PendingHashMismatch {
  ordinal: number;
  assertId: "A1" | "A3";
  turn: { chatId: string; turnIndex: number } | null;
  recordedTemplateHash?: string;
  detail: string;
  recordedText: string; // recorded request.system
  liveText: string; // live opts.system
}
