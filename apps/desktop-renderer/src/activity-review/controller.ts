import type { PlanCalendarRideDecision, PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { reviewRange, selectedRide, type ActivityReviewRead } from "./rides";

export type ReviewChoices = "closed" | "open" | "other-day";

export type ReviewSaving = "idle" | "saving" | "failed" | "refused";

export type ActivityReviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly read: ActivityReviewRead;
      readonly selectedId: string | null;
      readonly refresh: "idle" | "refreshing" | "failed";
      readonly choices: ReviewChoices;
      readonly saving: ReviewSaving;
    };

export const ACTIVITY_REVIEW_START: ActivityReviewState = Object.freeze({ kind: "loading" });

export interface ActivityReviewController {
  open(): Promise<void>;
  refresh(): Promise<void>;
  select(activityId: string): void;
  change(): void;
  otherDay(): void;
  closeChoices(): void;
  decide(decision: PlanCalendarRideDecision): Promise<void>;
}

export interface ActivityReviewControllerDeps {
  read(range: {
    readonly startDateKey: number;
    readonly endDateKey: number;
  }): Promise<PlanCalendarRpcResult>;
  decide(request: {
    readonly planId: string;
    readonly activityId: string;
    readonly decision: PlanCalendarRideDecision;
  }): Promise<PlanCalendarRpcResult>;
  localTodayDateKey(): number;
  publish(state: ActivityReviewState): void;
}

export function createActivityReviewController(
  deps: ActivityReviewControllerDeps,
): ActivityReviewController {
  let state: ActivityReviewState = ACTIVITY_REVIEW_START;
  let generation = 0;

  const publish = (next: ActivityReviewState): void => {
    state = next;
    deps.publish(next);
  };

  const update = (
    patch: Partial<Pick<Extract<ActivityReviewState, { kind: "ready" }>, "choices" | "saving">>,
  ): void => {
    if (state.kind === "ready") publish({ ...state, ...patch });
  };

  const load = async (reset: boolean): Promise<void> => {
    generation += 1;
    const mine = generation;
    const before = state;
    if (before.kind === "ready") {
      publish({
        ...before,
        refresh: "refreshing",
        ...(reset ? { selectedId: null, choices: "closed", saving: "idle" } : {}),
      });
    } else publish({ kind: "loading" });
    let result: PlanCalendarRpcResult | null;
    try {
      result = await deps.read(reviewRange(deps.localTodayDateKey()));
    } catch {
      result = null;
    }
    if (mine !== generation) return;
    const current = state;
    if (result?.status !== "rides") {
      publish(
        current.kind === "ready" ? { ...current, refresh: "failed" } : { kind: "unavailable" },
      );
      return;
    }
    const selectedId =
      current.kind === "ready" && !reset
        ? (selectedRide(result, current.selectedId)?.activityId ?? null)
        : null;
    publish({
      kind: "ready",
      read: result,
      selectedId,
      refresh: "idle",
      choices: current.kind === "ready" ? current.choices : "closed",
      saving: current.kind === "ready" ? current.saving : "idle",
    });
  };

  return {
    open: () => load(true),
    refresh: () => load(false),
    select(activityId) {
      if (state.kind !== "ready" || state.saving === "saving") return;
      publish({ ...state, selectedId: activityId, choices: "closed", saving: "idle" });
    },
    change: () => update({ choices: "open", saving: "idle" }),
    otherDay: () => update({ choices: "other-day", saving: "idle" }),
    closeChoices: () => update({ choices: "closed", saving: "idle" }),
    async decide(decision) {
      if (state.kind !== "ready" || state.saving === "saving") return;
      const ride = selectedRide(state.read, state.selectedId);
      const planId = state.read.plan?.planId;
      if (ride === null || planId === undefined) return;
      if (
        decision.kind === "confirm" &&
        ride.match.kind === "confirmed" &&
        ride.match.planWorkoutId === decision.planWorkoutId
      ) {
        update({ choices: "closed" });
        return;
      }
      publish({ ...state, selectedId: ride.activityId, saving: "saving" });
      let result: PlanCalendarRpcResult;
      try {
        result = await deps.decide({ planId, activityId: ride.activityId, decision });
      } catch {
        update({ saving: "failed" });
        return;
      }
      if (result.status === "ride") {
        const current = state;
        if (current.kind === "ready") {
          publish({
            ...current,
            read: {
              ...current.read,
              rides: current.read.rides.map((entry) =>
                entry.activityId === result.ride.activityId ? result.ride : entry,
              ),
            },
            choices: "closed",
            saving: "idle",
          });
        }
      } else {
        update({ saving: result.status === "refused" ? "refused" : "failed" });
      }
      await load(false);
    },
  };
}
