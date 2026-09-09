export const MAX_TURN_GENERATE_CALLS = 40;
export const MAX_TURN_GENERATE_ATTEMPTS = 4;
export const TURN_WALL_CLOCK_MS = 10 * 60_000;

export type BudgetExceededKind = "generate_calls" | "generate_attempts" | "wall_clock";

export class TurnBudgetExceededError extends Error {
  readonly kind: BudgetExceededKind;
  constructor(kind: BudgetExceededKind, detail: string) {
    super(detail);
    this.name = "TurnBudgetExceededError";
    this.kind = kind;
  }
}

export interface TurnBudget {
  /** Charge one llm.generate call; the provider steps a call runs internally are not counted. Throws TurnBudgetExceededError("generate_calls") past the cap. Call BEFORE every llm.generate. */
  chargeGenerateCall(): void;
  /** Charge one outer generate attempt. Throws "generate_attempts" past the attempt cap. */
  chargeAttempt(): void;
  /** Between-attempt deadline check (never mid-attempt). Throws "wall_clock" on overrun. */
  checkDeadline(): void;
  /** Milliseconds left in the turn's wall-clock budget (never negative). Lets a per-call LLM deadline be bounded by the budget the next attempt still has. */
  remainingMs(): number;
}

export function createTurnBudget(now: () => number): TurnBudget {
  const turnStart = now();
  let generateCalls = 0;
  let attempts = 0;
  return {
    chargeGenerateCall() {
      generateCalls++;
      if (generateCalls > MAX_TURN_GENERATE_CALLS) {
        throw new TurnBudgetExceededError(
          "generate_calls",
          `Per-turn generate-call budget exceeded (${MAX_TURN_GENERATE_CALLS}).`,
        );
      }
    },
    chargeAttempt() {
      attempts++;
      if (attempts > MAX_TURN_GENERATE_ATTEMPTS) {
        throw new TurnBudgetExceededError(
          "generate_attempts",
          `Per-turn generate-attempt budget exceeded (${MAX_TURN_GENERATE_ATTEMPTS}).`,
        );
      }
    },
    checkDeadline() {
      if (now() - turnStart >= TURN_WALL_CLOCK_MS) {
        throw new TurnBudgetExceededError(
          "wall_clock",
          `Per-turn wall-clock deadline exceeded (${TURN_WALL_CLOCK_MS}ms).`,
        );
      }
    },
    remainingMs() {
      return Math.max(0, TURN_WALL_CLOCK_MS - (now() - turnStart));
    },
  };
}
