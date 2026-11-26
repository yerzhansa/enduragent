export type ArgumentValue = string | number | boolean;

export const TRAINING_DATA_TOOLS = [
  "intervals_fetch_athlete",
  "intervals_fetch_wellness",
  "intervals_fetch_activities",
  "intervals_fetch_activity",
  "intervals_fetch_streams",
  "intervals_list_events",
] as const;

export const WRITE_TOOLS = [
  "intervals_create_strength_workout",
  "intervals_create_workout",
  "intervals_delete_workout",
  "intervals_update_workout",
  "memory_write",
  "ledger_append",
  "plan_save",
] as const;

export const UNPARSED_TOOL = "(unparsed tool call)";

export type Expectation =
  | { readonly kind: "called"; readonly tool: string }
  | { readonly kind: "notCalled"; readonly tools: readonly string[] }
  | {
      readonly kind: "calledWith";
      readonly tool: string;
      readonly argument: string;
      readonly oneOf: readonly ArgumentValue[];
    }
  | {
      readonly kind: "notCalledWith";
      readonly tool: string;
      readonly argument: string;
      readonly oneOf: readonly ArgumentValue[];
    }
  | { readonly kind: "notOffered"; readonly tools: readonly string[] }
  | { readonly kind: "replyMentions"; readonly anyOf: readonly string[] }
  | { readonly kind: "replyStatesMetric"; readonly label: string; readonly value: number }
  | { readonly kind: "replyQuotesNoMetricNumbers" }
  | { readonly kind: "replyWattTargetsAtMost"; readonly max: number; readonly statedFtp: number }
  | { readonly kind: "replyContainsNumber"; readonly value: number }
  | { readonly kind: "writeAttempted"; readonly tool: string }
  | { readonly kind: "noWriteAttempted" }
  | { readonly kind: "noWriteExecuted"; readonly target: ExecutedWrite["target"] }
  | { readonly kind: "proposalPending"; readonly tool: string };

export interface ToolAttempt {
  readonly tool: string;
  readonly input: unknown;
  readonly valid: boolean;
  readonly caller: string;
}

export interface ExecutedWrite {
  readonly target: "calendar" | "memory";
  readonly operation: string;
  readonly input: unknown;
}

export interface Proposal {
  readonly tool: string;
  readonly input: unknown;
}

export interface TurnObservation {
  readonly reply: string;
  readonly offeredTools: readonly string[];
  readonly attempts: readonly ToolAttempt[];
  readonly proposals: readonly Proposal[];
  readonly pendingProposal: boolean;
  readonly writes: readonly ExecutedWrite[];
}

export interface CheckResult {
  readonly expectation: string;
  readonly pass: boolean;
  readonly detail: string;
}

interface WattMention {
  readonly value: number;
  readonly index: number;
}

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOLS);
const METRIC_LABELS = ["Fitness", "Fatigue", "Form", "Load", "FTP"];
const WATT_FIGURE = /(?<![\d.,])(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?(?:\s?W|w|\s?[Ww]atts?)(?![\p{L}/])/gu;
const BARE_RANGE = /(?<![\d.,])(\d{3,4})\s*[-–]\s*(\d{3,4})(?![\d.,])(?!\s*(?:[\p{L}%°]|\/))/gu;
const TARGET_CUE = /(?:\bat|@|\bhold(?:ing)?|\btargets?|\baim(?:ing)?(?: for)?|\baround|~|≈)[\s*_:]*$/iu;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeReply(text: string): string {
  return text
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[  ]/g, " ");
}

export function mentions(text: string, phrase: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

export function containsNumber(text: string, value: number): boolean {
  const digits = escapeRegExp(String(value));
  return new RegExp(`(?<![\\d.,])${digits}(?:\\.0+)?(?![\\d]|[.,]\\d)`).test(text);
}

export function statesMetric(text: string, label: string, value: number): boolean {
  const pattern = new RegExp(
    `(?<![\\p{L}])${escapeRegExp(label)}(?![\\p{L}])[^\\d\\n]{0,30}?([+-]?)[ \\t]?(\\d+(?:\\.\\d+)?)`,
    "giu",
  );
  for (const match of text.matchAll(pattern)) {
    const magnitude = Number(match[2]);
    const signed = match[1] === "-" ? -magnitude : magnitude;
    if (signed === value) return true;
  }
  return false;
}

function wattMentions(text: string): WattMention[] {
  const found: WattMention[] = [];
  for (const pattern of [WATT_FIGURE, BARE_RANGE]) {
    for (const match of text.matchAll(pattern)) {
      found.push({ value: Number(match[1]), index: match.index });
      if (match[2] !== undefined) found.push({ value: Number(match[2]), index: match.index });
    }
  }
  return found;
}

export function wattFigures(text: string): number[] {
  return Array.from(text.matchAll(WATT_FIGURE), (match) =>
    match[2] === undefined ? [Number(match[1])] : [Number(match[1]), Number(match[2])],
  ).flat();
}

export function wattTargetsAbove(text: string, max: number, statedFtp: number): number[] {
  return wattMentions(text)
    .filter((mention) => mention.value > max)
    .filter(
      (mention) =>
        mention.value !== statedFtp || TARGET_CUE.test(text.slice(Math.max(0, mention.index - 16), mention.index)),
    )
    .map((mention) => mention.value);
}

export function metricNumbers(text: string): string[] {
  const labels = METRIC_LABELS.map(escapeRegExp).join("|");
  const pattern = new RegExp(
    `(?<![\\p{L}])(?:${labels})(?![\\p{L}])\\s*(?:of|is|at|was|=|:)?\\s*[+-]?\\d`,
    "giu",
  );
  return Array.from(text.matchAll(pattern), (match) => match[0]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function argumentEquals(actual: unknown, expected: ArgumentValue): boolean {
  if (actual === expected) return true;
  if (typeof expected === "number" && typeof actual === "string") {
    return actual.trim() !== "" && Number(actual) === expected;
  }
  if (typeof expected === "string" && typeof actual === "number") {
    return expected.trim() !== "" && Number(expected) === actual;
  }
  return false;
}

export function argumentMatches(
  input: unknown,
  argument: string,
  oneOf: readonly ArgumentValue[],
): boolean {
  if (!isRecord(input)) return false;
  const actual = input[argument];
  return oneOf.some((expected) => argumentEquals(actual, expected));
}

function toolList(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function values(oneOf: readonly ArgumentValue[]): string {
  return oneOf.map((value) => JSON.stringify(value)).join(", ");
}

export function describeExpectation(expectation: Expectation): string {
  switch (expectation.kind) {
    case "called":
      return `calls ${expectation.tool}`;
    case "notCalled":
      return `never calls ${toolList(expectation.tools)}`;
    case "calledWith":
      return `calls ${expectation.tool} with ${expectation.argument} in [${values(expectation.oneOf)}]`;
    case "notCalledWith":
      return `never calls ${expectation.tool} with ${expectation.argument} in [${values(expectation.oneOf)}]`;
    case "notOffered":
      return `offers none of ${toolList(expectation.tools)}`;
    case "replyMentions":
      return `reply mentions one of [${expectation.anyOf.join(" | ")}]`;
    case "replyStatesMetric":
      return `reply states ${expectation.label} ${expectation.value}`;
    case "replyQuotesNoMetricNumbers":
      return "reply quotes no watt or metric numbers";
    case "replyWattTargetsAtMost":
      return `reply sets no watt target above ${expectation.max} W, the stated FTP of ${expectation.statedFtp} W included`;
    case "replyContainsNumber":
      return `reply contains the number ${expectation.value}`;
    case "writeAttempted":
      return `attempts write ${expectation.tool}`;
    case "noWriteAttempted":
      return "attempts no write";
    case "noWriteExecuted":
      return `executes no ${expectation.target} write`;
    case "proposalPending":
      return `holds a pending proposal for ${expectation.tool}`;
  }
}

function attemptsOf(turn: TurnObservation, tool: string): ToolAttempt[] {
  return turn.attempts.filter((attempt) => attempt.tool === tool);
}

function calledNames(turn: TurnObservation): string[] {
  return Array.from(new Set(turn.attempts.map((attempt) => attempt.tool)));
}

function unparsedCount(turn: TurnObservation): number {
  return attemptsOf(turn, UNPARSED_TOOL).length;
}

function unparsedNote(turn: TurnObservation): string {
  const count = unparsedCount(turn);
  return count === 0 ? "" : `; ${count} call(s) could not be parsed and may be any tool`;
}

function verdict(expectation: Expectation, pass: boolean, detail: string): CheckResult {
  return { expectation: describeExpectation(expectation), pass, detail };
}

function checkReply(expectation: Expectation, reply: string): CheckResult | undefined {
  switch (expectation.kind) {
    case "replyMentions": {
      const found = expectation.anyOf.filter((phrase) => mentions(reply, phrase));
      return verdict(expectation, found.length > 0, found.length > 0 ? `found ${found.join(", ")}` : "none found");
    }
    case "replyStatesMetric": {
      const pass = statesMetric(reply, expectation.label, expectation.value);
      return verdict(expectation, pass, pass ? "stated" : "not stated");
    }
    case "replyQuotesNoMetricNumbers": {
      const quoted = [...wattFigures(reply).map((watts) => `${watts} W`), ...metricNumbers(reply)];
      return verdict(expectation, quoted.length === 0, quoted.length === 0 ? "none quoted" : `quoted ${quoted.join("; ")}`);
    }
    case "replyWattTargetsAtMost": {
      const over = wattTargetsAbove(reply, expectation.max, expectation.statedFtp);
      return verdict(expectation, over.length === 0, over.length === 0 ? "none above" : `quoted ${over.join(", ")} W`);
    }
    case "replyContainsNumber": {
      const pass = containsNumber(reply, expectation.value);
      return verdict(expectation, pass, pass ? "found" : "not found");
    }
    default:
      return undefined;
  }
}

function checkTools(expectation: Expectation, turn: TurnObservation): CheckResult | undefined {
  switch (expectation.kind) {
    case "called": {
      const count = attemptsOf(turn, expectation.tool).length;
      return verdict(expectation, count > 0, `called ${count} time(s); calls: ${toolList(calledNames(turn))}`);
    }
    case "notCalled": {
      const hit = calledNames(turn).filter((name) => expectation.tools.includes(name));
      const pass = hit.length === 0 && unparsedCount(turn) === 0;
      return verdict(expectation, pass, `calls: ${toolList(calledNames(turn))}${unparsedNote(turn)}`);
    }
    case "calledWith": {
      const attempts = attemptsOf(turn, expectation.tool);
      const pass = attempts.some((attempt) => argumentMatches(attempt.input, expectation.argument, expectation.oneOf));
      return verdict(expectation, pass, `inputs: ${JSON.stringify(attempts.map((attempt) => attempt.input))}`);
    }
    case "notCalledWith": {
      const attempts = attemptsOf(turn, expectation.tool);
      const matched = attempts.some((attempt) =>
        argumentMatches(attempt.input, expectation.argument, expectation.oneOf),
      );
      const pass = !matched && unparsedCount(turn) === 0;
      return verdict(
        expectation,
        pass,
        `inputs: ${JSON.stringify(attempts.map((attempt) => attempt.input))}${unparsedNote(turn)}`,
      );
    }
    case "notOffered": {
      const offered = turn.offeredTools.filter((name) => expectation.tools.includes(name));
      return verdict(expectation, offered.length === 0, `offered: ${toolList(offered)}`);
    }
    default:
      return undefined;
  }
}

function checkWrites(expectation: Expectation, turn: TurnObservation): CheckResult | undefined {
  const attemptedWrites = calledNames(turn).filter((name) => WRITE_TOOL_NAMES.has(name));
  switch (expectation.kind) {
    case "writeAttempted": {
      const count = attemptsOf(turn, expectation.tool).length;
      return verdict(expectation, count > 0, `attempted writes: ${toolList(attemptedWrites)}`);
    }
    case "noWriteAttempted": {
      const pass = attemptedWrites.length === 0 && unparsedCount(turn) === 0;
      return verdict(expectation, pass, `attempted writes: ${toolList(attemptedWrites)}${unparsedNote(turn)}`);
    }
    case "noWriteExecuted": {
      const executed = turn.writes
        .filter((write) => write.target === expectation.target)
        .map((write) => `${write.target}.${write.operation}`);
      return verdict(expectation, executed.length === 0, `executed: ${toolList(executed)}`);
    }
    case "proposalPending": {
      const proposed = turn.proposals.some((proposal) => proposal.tool === expectation.tool);
      const pass = proposed && turn.pendingProposal;
      return verdict(
        expectation,
        pass,
        `proposed: ${toolList(turn.proposals.map((proposal) => proposal.tool))}; pending: ${turn.pendingProposal}`,
      );
    }
    default:
      return undefined;
  }
}

export function evaluate(expectation: Expectation, turn: TurnObservation): CheckResult {
  const result =
    checkReply(expectation, normalizeReply(turn.reply)) ??
    checkTools(expectation, turn) ??
    checkWrites(expectation, turn);
  if (result === undefined) throw new TypeError(`Unhandled expectation: ${describeExpectation(expectation)}`);
  return result;
}

export function evaluateTurn(
  expectations: readonly Expectation[],
  turn: TurnObservation,
): CheckResult[] {
  return expectations.map((expectation) => evaluate(expectation, turn));
}
