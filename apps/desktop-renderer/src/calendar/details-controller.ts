import type {
  PlanCalendarRpcResult,
  PlanCalendarTick,
  PlanCloseResult,
} from "@enduragent/coach-contract";

export type PlanDetails = Extract<PlanCalendarRpcResult, { status: "plan-details" }>;

export type EndConfirm =
  | { readonly kind: "idle"; readonly removeChanges: boolean }
  | { readonly kind: "ending"; readonly removeChanges: boolean }
  | {
      readonly kind: "failed";
      readonly removeChanges: boolean;
      readonly reason: "changed" | "unavailable";
    };

export type DetailsSheetState =
  | { readonly kind: "closed" }
  | { readonly kind: "loading"; readonly planId: string }
  | { readonly kind: "unavailable"; readonly planId: string }
  | { readonly kind: "open"; readonly details: PlanDetails; readonly end: EndConfirm | null };

export const DETAILS_SHEET_CLOSED: DetailsSheetState = Object.freeze({ kind: "closed" });

export interface DetailsController {
  open(planId: string): Promise<void>;
  close(): void;
  startEnd(): void;
  setRemoveChanges(remove: boolean): void;
  cancelEnd(): void;
  confirmEnd(): Promise<void>;
}

export function createDetailsController(deps: {
  call(
    request:
      | { readonly action: "plan-details"; readonly planId: string }
      | {
          readonly action: "save-end-choice";
          readonly planId: string;
          readonly ticked: PlanCalendarTick[];
        },
  ): Promise<PlanCalendarRpcResult>;
  closePlan(request: {
    readonly commandId: string;
    readonly planId: string;
    readonly expectedVersion: number;
  }): Promise<PlanCloseResult>;
  newCommandId(): string;
  ended(): void;
  publish(state: DetailsSheetState): void;
}): DetailsController {
  let state: DetailsSheetState = DETAILS_SHEET_CLOSED;
  let generation = 0;
  const publish = (next: DetailsSheetState): void => {
    state = next;
    deps.publish(next);
  };
  const withEnd = (end: EndConfirm | null): void => {
    if (state.kind === "open") publish({ kind: "open", details: state.details, end });
  };
  const saveChoice = (planId: string, ticked: readonly PlanCalendarTick[]) =>
    deps.call({ action: "save-end-choice", planId, ticked: [...ticked] });

  return {
    async open(planId) {
      generation += 1;
      const mine = generation;
      publish({ kind: "loading", planId });
      let result: PlanCalendarRpcResult;
      try {
        result = await deps.call({ action: "plan-details", planId });
      } catch {
        if (mine === generation) publish({ kind: "unavailable", planId });
        return;
      }
      if (mine !== generation) return;
      publish(
        result.status === "plan-details"
          ? { kind: "open", details: result, end: null }
          : { kind: "unavailable", planId },
      );
    },
    close() {
      if (state.kind === "open" && state.end?.kind === "ending") return;
      generation += 1;
      publish(DETAILS_SHEET_CLOSED);
    },
    startEnd() {
      withEnd({ kind: "idle", removeChanges: false });
    },
    setRemoveChanges(removeChanges) {
      if (state.kind !== "open" || state.end === null || state.end.kind === "ending") return;
      withEnd({ kind: "idle", removeChanges });
    },
    cancelEnd() {
      if (state.kind !== "open" || state.end?.kind === "ending") return;
      withEnd(null);
    },
    async confirmEnd() {
      if (state.kind !== "open" || state.end === null || state.end.kind === "ending") return;
      const { details } = state;
      const removeChanges = state.end.removeChanges;
      withEnd({ kind: "ending", removeChanges });
      const ticks = removeChanges ? details.ending.athleteChanges.map((entry) => entry.tick) : [];
      let closed: PlanCloseResult;
      try {
        await saveChoice(details.planId, ticks);
        closed = await deps.closePlan({
          commandId: deps.newCommandId(),
          planId: details.planId,
          expectedVersion: details.version,
        });
      } catch {
        await saveChoice(details.planId, []).catch(() => undefined);
        withEnd({ kind: "failed", removeChanges, reason: "unavailable" });
        return;
      }
      if (closed.status === "closed") {
        publish(DETAILS_SHEET_CLOSED);
        deps.ended();
        return;
      }
      await saveChoice(details.planId, []).catch(() => undefined);
      withEnd({ kind: "failed", removeChanges, reason: "changed" });
    },
  };
}
