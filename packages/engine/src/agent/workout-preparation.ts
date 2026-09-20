import type { Tool } from "ai";
import type { GenerateResult } from "../sport.js";
import type { TurnBudget } from "./turn-budget.js";
import type {
  Preparation,
  PendingWorkoutSet,
  PreparationResult,
  WorkoutPreparationPort,
} from "../workout-change-sets.js";
import { getTurnContext, type TurnContext } from "./turn-context.js";

export interface WorkoutPreparationSession {
  complete(input: { finishReason: GenerateResult["finishReason"]; budget: TurnBudget }): void;
  fail(): void;
  close(): Promise<void>;
}

type PreparationTurn = {
  completion: { kind: "pending" | "failed" } | { kind: "completed"; budget: TurnBudget };
  closed: boolean;
  settled: boolean;
  submissions: number;
  submittedToHost: boolean;
  calls: Promise<unknown>[];
};

export class WorkoutPreparationTurns {
  private preparationToolName: string | undefined;
  private readonly turns = new WeakMap<TurnContext, PreparationTurn>();

  constructor(private readonly port: WorkoutPreparationPort) {}

  async read(options: unknown): Promise<PendingWorkoutSet> {
    const context = getTurnContext(options);
    const turn = context === undefined ? undefined : this.turns.get(context);
    if (context === undefined || turn === undefined || turn.closed || turn.settled)
      return { kind: "unavailable", reason: "Workout preparation is unavailable for this turn." };
    return this.port.readPending({ chatId: context.chatId });
  }

  begin(context: TurnContext, signal: AbortSignal): WorkoutPreparationSession {
    const turn: PreparationTurn = {
      completion: { kind: "pending" },
      closed: false,
      settled: false,
      submissions: 0,
      submittedToHost: false,
      calls: [],
    };
    this.turns.set(context, turn);
    return {
      complete: ({ finishReason, budget }) => {
        budget.checkDeadline();
        if (turn.completion.kind !== "failed") {
          turn.completion =
            finishReason === "stop" && !signal.aborted
              ? { kind: "completed", budget }
              : { kind: "failed" };
        }
      },
      fail: () => {
        turn.completion = { kind: "failed" };
      },
      close: () => this.settle(context, signal),
    };
  }

  async submit(preparation: Preparation, options: unknown): Promise<PreparationResult> {
    const context = getTurnContext(options);
    const turn = context === undefined ? undefined : this.turns.get(context);
    if (
      context === undefined ||
      turn === undefined ||
      turn.settled ||
      turn.completion.kind === "failed"
    ) {
      return { kind: "refused", message: "Workout preparation is unavailable for this turn." };
    }
    if (preparation.kind === "incomplete") turn.completion = { kind: "failed" };
    turn.submittedToHost = true;
    const result = await this.port.prepare({
      chatId: context.chatId,
      turnId: context.turnId,
      preparation,
    });
    if (result.kind !== "prepared") turn.completion = { kind: "failed" };
    return result;
  }

  wrap(tool: Tool, isPreparation: boolean, toolName: string): Tool {
    if (isPreparation) this.preparationToolName = toolName;
    const execute = tool.execute;
    if (execute === undefined) return tool;
    return {
      ...tool,
      execute: (input, options) => {
        const context = getTurnContext(options);
        const turn = context === undefined ? undefined : this.turns.get(context);
        if (turn === undefined || turn.closed) {
          return Promise.resolve({ error: "workout_turn_unavailable" });
        }
        if (isPreparation && ++turn.submissions > 1) {
          turn.completion = { kind: "failed" };
          return Promise.resolve({
            kind: "refused",
            message: "Submit the complete workout set once per turn.",
          });
        }
        const call = Promise.resolve()
          .then(() => execute(input, options))
          .then(
            (result) => {
              if (result !== null && typeof result === "object" && "error" in result)
                turn.completion = { kind: "failed" };
              return result;
            },
            (error: unknown) => {
              turn.completion = { kind: "failed" };
              throw error;
            },
          );
        turn.calls.push(call);
        return call;
      },
    };
  }

  private async settle(context: TurnContext, signal: AbortSignal): Promise<void> {
    const turn = this.turns.get(context);
    if (turn === undefined || turn.closed) return;
    turn.closed = true;
    await Promise.allSettled(turn.calls);
    turn.settled = true;
    const attemptedPreparation =
      turn.submissions > 0 ||
      (this.preparationToolName !== undefined &&
        context.toolExecution.failedTools.has(this.preparationToolName));
    if (attemptedPreparation && !turn.submittedToHost) {
      turn.completion = { kind: "failed" };
      await this.port.prepare({
        chatId: context.chatId,
        turnId: context.turnId,
        preparation: {
          kind: "incomplete",
          reason: "The complete workout proposal could not be prepared.",
        },
      });
    }
    await this.port.settleTurn({
      chatId: context.chatId,
      turnId: context.turnId,
      outcome:
        turn.completion.kind === "completed" &&
        turn.completion.budget.remainingMs() > 0 &&
        !signal.aborted &&
        !context.toolExecution.failed
          ? "commit"
          : "abandon",
    });
  }
}
