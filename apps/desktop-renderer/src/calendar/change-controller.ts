import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";

export type ChangeDetail = Extract<PlanCalendarRpcResult, { status: "change-detail" }>;

export type ChangeChoice = "keep" | "put-back";

export type ChangeSheetState =
  | { readonly kind: "closed" }
  | { readonly kind: "loading"; readonly planId: string; readonly planWorkoutId: string }
  | { readonly kind: "open"; readonly planId: string; readonly detail: ChangeDetail }
  | {
      readonly kind: "working";
      readonly planId: string;
      readonly detail: ChangeDetail;
      readonly choice: ChangeChoice;
    }
  | {
      readonly kind: "failed";
      readonly planId: string;
      readonly detail: ChangeDetail;
      readonly reason: "unavailable" | "refused";
    }
  | { readonly kind: "unavailable"; readonly planId: string; readonly planWorkoutId: string };

export const CHANGE_SHEET_CLOSED: ChangeSheetState = Object.freeze({ kind: "closed" });

export interface ChangeController {
  open(planId: string, planWorkoutId: string): Promise<void>;
  keep(): Promise<void>;
  putBack(): Promise<void>;
  close(): void;
}

export function createChangeController(deps: {
  call(request: {
    readonly action: "change-detail" | "keep-change" | "put-back";
    readonly planId: string;
    readonly planWorkoutId: string;
  }): Promise<PlanCalendarRpcResult>;
  refresh(): void;
  publish(state: ChangeSheetState): void;
}): ChangeController {
  let state: ChangeSheetState = CHANGE_SHEET_CLOSED;
  let generation = 0;
  const publish = (next: ChangeSheetState): void => {
    state = next;
    deps.publish(next);
  };

  const load = async (planId: string, planWorkoutId: string): Promise<void> => {
    generation += 1;
    const mine = generation;
    publish({ kind: "loading", planId, planWorkoutId });
    let result: PlanCalendarRpcResult;
    try {
      result = await deps.call({ action: "change-detail", planId, planWorkoutId });
    } catch {
      if (mine === generation) publish({ kind: "unavailable", planId, planWorkoutId });
      return;
    }
    if (mine !== generation) return;
    if (result.status === "change-detail") {
      publish({ kind: "open", planId, detail: result });
      return;
    }
    if (result.status === "change-resolved") {
      publish(CHANGE_SHEET_CLOSED);
      deps.refresh();
      return;
    }
    publish({ kind: "unavailable", planId, planWorkoutId });
  };

  const choose = async (choice: ChangeChoice): Promise<void> => {
    if (state.kind !== "open" && state.kind !== "failed") return;
    const { planId, detail } = state;
    generation += 1;
    const mine = generation;
    publish({ kind: "working", planId, detail, choice });
    let result: PlanCalendarRpcResult;
    try {
      result = await deps.call({
        action: choice === "keep" ? "keep-change" : "put-back",
        planId,
        planWorkoutId: detail.planWorkoutId,
      });
    } catch {
      if (mine === generation) publish({ kind: "failed", planId, detail, reason: "unavailable" });
      return;
    }
    if (mine !== generation) return;
    if (result.status === "change-resolved" && result.outcome === "refreshed") {
      deps.refresh();
      await load(planId, detail.planWorkoutId);
      return;
    }
    if (result.status === "change-resolved") {
      publish(CHANGE_SHEET_CLOSED);
      deps.refresh();
      return;
    }
    publish({
      kind: "failed",
      planId,
      detail,
      reason:
        result.status === "refused" && result.reason === "plan-change-refused"
          ? "refused"
          : "unavailable",
    });
  };

  return {
    open: (planId, planWorkoutId) => load(planId, planWorkoutId),
    keep: () => choose("keep"),
    putBack: () => choose("put-back"),
    close() {
      generation += 1;
      publish(CHANGE_SHEET_CLOSED);
    },
  };
}
