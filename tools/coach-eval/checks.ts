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
  | { readonly kind: "replyQuotesNoMetricNumbers" }
  | { readonly kind: "replyWattsAtMost"; readonly max: number; readonly except: readonly number[] }
  | { readonly kind: "replyContainsNumber"; readonly value: number }
  | { readonly kind: "writeAttempted"; readonly tool: string }
  | { readonly kind: "noWriteAttempted" }
  | { readonly kind: "noWriteExecuted"; readonly target: ExecutedWrite["target"] }
  | { readonly kind: "proposalPending"; readonly tool: string };

export interface ToolAttempt {
  readonly tool: string;
  readonly input: unknown;
  readonly valid: boolean;
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

const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOLS);
const METRIC_LABELS = ["Fitness", "Fatigue", "Form", "Load", "FTP"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentions(text: string, phrase: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "iu").test(
    text,
  );
}

export function containsNumber(text: string, value: number): boolean {
  const digits = escapeRegExp(String(value));
  return new RegExp(`(?<![\\d.,])${digits}(?:\\.0+)?(?![\\d]|[.,]\\d)`).test(text);
}

export function wattFigures(text: string): number[] {
  const figures: number[] = [];
  for (const match of text.matchAll(/(?<![\d.,])(\d{1,4})(?:\s*[-–]\s*(\d{1,4}))?\s?(?:W|watts?)(?![\p{L}])/giu)) {
    figures.push(Number(match[1]));
    if (match[2] !== undefined) figures.push(Number(match[2]));
  }
  return figures;
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

export function describeExpectation(expectation: Expectation): string {
  switch (expectation.kind) {
    case "called":
      return `calls ${expectation.tool}`;
    case "notCalled":
      return `never calls ${toolList(expectation.tools)}`;
    case "calledWith":
      return `calls ${expectation.tool} with ${expectation.argument} in [${expectation.oneOf.join(", ")}]`;
    case "notCalledWith":
      return `never calls ${expectation.tool} with ${expectation.argument} in [${expectation.oneOf.join(", ")}]`;
    case "notOffered":
      return `offers none of ${toolList(expectation.tools)}`;
    case "replyMentions":
      return `reply mentions one of [${expectation.anyOf.join(" | ")}]`;
    case "replyQuotesNoMetricNumbers":
      return "reply quotes no watt or metric numbers";
    case "replyWattsAtMost":
      return `reply quotes no watt figure above ${expectation.max} W other than [${expectation.except.join(", ")}]`;
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

function verdict(expectation: Expectation, pass: boolean, detail: string): CheckResult {
  return { expectation: describeExpectation(expectation), pass, detail };
}

function checkReply(expectation: Expectation, reply: string): CheckResult | undefined {
  switch (expectation.kind) {
    case "replyMentions": {
      const found = expectation.anyOf.filter((phrase) => mentions(reply, phrase));
      return verdict(expectation, found.length > 0, found.length > 0 ? `found ${found.join(", ")}` : "none found");
    }
    case "replyQuotesNoMetricNumbers": {
      const quoted = [...wattFigures(reply).map((watts) => `${watts} W`), ...metricNumbers(reply)];
      return verdict(expectation, quoted.length === 0, quoted.length === 0 ? "none quoted" : `quoted ${quoted.join("; ")}`);
    }
    case "replyWattsAtMost": {
      const over = wattFigures(reply).filter(
        (watts) => watts > expectation.max && !expectation.except.includes(watts),
      );
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
      return verdict(expectation, hit.length === 0, `calls: ${toolList(calledNames(turn))}`);
    }
    case "calledWith": {
      const attempts = attemptsOf(turn, expectation.tool);
      const pass = attempts.some((attempt) => argumentMatches(attempt.input, expectation.argument, expectation.oneOf));
      return verdict(expectation, pass, `inputs: ${JSON.stringify(attempts.map((attempt) => attempt.input))}`);
    }
    case "notCalledWith": {
      const attempts = attemptsOf(turn, expectation.tool);
      const pass = !attempts.some((attempt) => argumentMatches(attempt.input, expectation.argument, expectation.oneOf));
      return verdict(expectation, pass, `inputs: ${JSON.stringify(attempts.map((attempt) => attempt.input))}`);
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
    case "noWriteAttempted":
      return verdict(expectation, attemptedWrites.length === 0, `attempted writes: ${toolList(attemptedWrites)}`);
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
    checkReply(expectation, turn.reply) ??
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
