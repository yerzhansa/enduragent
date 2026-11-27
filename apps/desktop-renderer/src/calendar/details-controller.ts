import type {
  PlanCalendarRpcResult,
  PlanCalendarTick,
  PlanCloseResult,
} from "@enduragent/coach-contract";

export type PlanDetails = Extract<PlanCalendarRpcResult, { status: "plan-details" }>;

export type EndConfirm =
  | { readonly kind: "idle"; readonly removeChanges: boolean; readonly commandId: string }
  | {
      readonly kind: "ending";
      readonly removeChanges: boolean;
      readonly commandId: string;
      readonly ticked: readonly PlanCalendarTick[];
    }
  | {
      readonly kind: "failed";
      readonly removeChanges: boolean;
      readonly commandId: string;
      readonly ticked: readonly PlanCalendarTick[];
      readonly reason: "changed" | "unconfirmed";
    };

export type DetailsSheetState =
  | { readonly kind: "closed" }
  | { readonly kind: "loading"; readonly planId: string }
  | { readonly kind: "unavailable"; readonly planId: string }
  | { readonly kind: "open"; readonly details: PlanDetails; readonly end: EndConfirm | null };

export const DETAILS_SHEET_CLOSED: DetailsSheetState = Object.freeze({ kind: "closed" });

export function detailsEnding(state: DetailsSheetState): boolean {
  return state.kind === "open" && state.end?.kind === "ending";
}

export function endChoiceLocked(end: EndConfirm | null): boolean {
  return (
    end !== null &&
    (end.kind === "ending" || (end.kind === "failed" && end.reason === "unconfirmed"))
  );
}

export interface DetailsController {
  open(planId: string): Promise<void>;
  close(): void;
  startEnd(): void;
  setRemoveChanges(remove: boolean): void;
  cancelEnd(): void;
  confirmEnd(): Promise<void>;
}

type EndOutcome = "closed" | "changed" | "unconfirmed";

function closeOutcome(result: PlanCloseResult): EndOutcome {
  if (result.status === "closed") return "closed";
  return result.reason === "no-active-plan" ? "closed" : "changed";
}

interface PendingEnd {
  readonly planId: string;
  readonly commandId: string;
  readonly removeChanges: boolean;
  readonly ticked: readonly PlanCalendarTick[];
}

export function createDetailsController(deps: {
  call(
    request:
      | { readonly action: "plan-details"; readonly planId: string }
      | {
          readonly action: "save-end-choice";
          readonly planId: string;
          readonly commandId: string;
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
  let pending: PendingEnd | null = null;
  const publish = (next: DetailsSheetState): void => {
    state = next;
    deps.publish(next);
  };
  const withEnd = (end: EndConfirm | null): void => {
    if (state.kind === "open") publish({ kind: "open", details: state.details, end });
  };
  const end = async (
    details: PlanDetails,
    commandId: string,
    ticked: readonly PlanCalendarTick[],
  ): Promise<EndOutcome> => {
    try {
      const saved = await deps.call({
        action: "save-end-choice",
        planId: details.planId,
        commandId,
        ticked: [...ticked],
      });
      const mayHaveEnded = saved.status === "refused" && saved.reason === "no-active-plan";
      if (saved.status !== "end-choice-saved" && !mayHaveEnded) return "unconfirmed";
      return closeOutcome(
        await deps.closePlan({
          commandId,
          planId: details.planId,
          expectedVersion: details.version,
        }),
      );
    } catch {
      return "unconfirmed";
    }
  };

  return {
    async open(planId) {
      if (detailsEnding(state)) return;
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
      if (detailsEnding(state)) return;
      generation += 1;
      publish(DETAILS_SHEET_CLOSED);
    },
    startEnd() {
      if (state.kind !== "open" || state.end !== null) return;
      if (pending !== null && pending.planId === state.details.planId) {
        withEnd({
          kind: "failed",
          reason: "unconfirmed",
          removeChanges: pending.removeChanges,
          commandId: pending.commandId,
          ticked: pending.ticked,
        });
        return;
      }
      withEnd({ kind: "idle", removeChanges: false, commandId: deps.newCommandId() });
    },
    setRemoveChanges(removeChanges) {
      if (state.kind !== "open" || state.end === null || endChoiceLocked(state.end)) return;
      withEnd({ kind: "idle", removeChanges, commandId: state.end.commandId });
    },
    cancelEnd() {
      if (state.kind !== "open" || state.end?.kind === "ending") return;
      withEnd(null);
    },
    async confirmEnd() {
      if (state.kind !== "open" || state.end === null || state.end.kind === "ending") return;
      const { details } = state;
      const { removeChanges, commandId } = state.end;
      const ticked =
        state.end.kind === "failed" && state.end.reason === "unconfirmed"
          ? state.end.ticked
          : removeChanges
            ? details.ending.athleteChanges.map((entry) => entry.tick)
            : [];
      withEnd({ kind: "ending", removeChanges, commandId, ticked });
      const outcome = await end(details, commandId, ticked);
      pending =
        outcome === "unconfirmed"
          ? { planId: details.planId, commandId, removeChanges, ticked }
          : null;
      if (outcome === "closed") {
        publish(DETAILS_SHEET_CLOSED);
        deps.ended();
        return;
      }
      withEnd({ kind: "failed", removeChanges, commandId, ticked, reason: outcome });
    },
  };
}
