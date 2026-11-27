import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";

export type MoveFailure = "card-open" | "refused" | "not-movable" | "unavailable";

interface MoveTarget {
  readonly planId: string;
  readonly workoutId: string;
  readonly toDateKey: number;
  readonly swap: boolean;
}

export type MoveDialogState =
  | { readonly kind: "closed" }
  | ({ readonly kind: "open" } & MoveTarget)
  | ({ readonly kind: "moving" } & MoveTarget)
  | ({ readonly kind: "failed"; readonly reason: MoveFailure } & MoveTarget);

export const MOVE_DIALOG_CLOSED: MoveDialogState = Object.freeze({ kind: "closed" });

export interface MoveController {
  request(planId: string, workoutId: string, toDateKey: number, swap: boolean): void;
  setSwap(swap: boolean): void;
  confirm(): Promise<void>;
  cancel(): void;
}

function failureOf(result: PlanCalendarRpcResult): MoveFailure {
  if (result.status !== "refused") return "unavailable";
  switch (result.reason) {
    case "change-card-open":
      return "card-open";
    case "plan-change-refused":
      return "refused";
    case "workout-not-movable":
    case "outside-plan":
      return "not-movable";
    default:
      return "unavailable";
  }
}

export function createMoveController(deps: {
  call(request: {
    readonly action: "move-workout";
    readonly planId: string;
    readonly planWorkoutId: string;
    readonly toDateKey: number;
    readonly swap: boolean;
  }): Promise<PlanCalendarRpcResult>;
  refresh(): void;
  publish(state: MoveDialogState): void;
}): MoveController {
  let state: MoveDialogState = MOVE_DIALOG_CLOSED;
  const publish = (next: MoveDialogState): void => {
    state = next;
    deps.publish(next);
  };
  return {
    request(planId, workoutId, toDateKey, swap) {
      if (state.kind === "moving") return;
      publish({ kind: "open", planId, workoutId, toDateKey, swap });
    },
    setSwap(swap) {
      if (state.kind !== "open" && state.kind !== "failed") return;
      publish({
        kind: "open",
        planId: state.planId,
        workoutId: state.workoutId,
        toDateKey: state.toDateKey,
        swap,
      });
    },
    async confirm() {
      if (state.kind !== "open" && state.kind !== "failed") return;
      const target: MoveTarget = {
        planId: state.planId,
        workoutId: state.workoutId,
        toDateKey: state.toDateKey,
        swap: state.swap,
      };
      publish({ kind: "moving", ...target });
      let result: PlanCalendarRpcResult;
      try {
        result = await deps.call({
          action: "move-workout",
          planId: target.planId,
          planWorkoutId: target.workoutId,
          toDateKey: target.toDateKey,
          swap: target.swap,
        });
      } catch {
        publish({ kind: "failed", reason: "unavailable", ...target });
        deps.refresh();
        return;
      }
      if (result.status === "moved") {
        publish(MOVE_DIALOG_CLOSED);
        deps.refresh();
        return;
      }
      publish({ kind: "failed", reason: failureOf(result), ...target });
      deps.refresh();
    },
    cancel() {
      if (state.kind === "moving") return;
      publish(MOVE_DIALOG_CLOSED);
    },
  };
}
