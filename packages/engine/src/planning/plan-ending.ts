import { addCivilDays } from "@enduragent/kernel/planning";
import { icuCopyIsAthleteChange, type IcuCopy } from "./icu-copy.js";

export type AthleteChangesChoice = "keep-them" | "remove-them";

export type PlanCleanup =
  | { readonly kind: "not-needed" }
  | { readonly kind: "running" }
  | { readonly kind: "failed" }
  | { readonly kind: "verified" };

export type ReplacementDelivery =
  | { readonly kind: "no-replacement" }
  | { readonly kind: "waiting-for-cleanup"; readonly replacementPlanId: string }
  | { readonly kind: "may-send"; readonly replacementPlanId: string };

export type PlanEnding =
  | { readonly kind: "running" }
  | { readonly kind: "end-confirm-open" }
  | { readonly kind: "replacement-in-review"; readonly replacementPlanId: string }
  | {
      readonly kind: "closed";
      readonly reason: "ended" | "replaced" | "completed";
      readonly closedOnDateKey: number;
      readonly athleteChanges: AthleteChangesChoice;
      readonly cleanup: PlanCleanup;
      readonly replacement: ReplacementDelivery;
    };

export type PlanEndingEvent =
  | { readonly type: "athlete-presses-end" }
  | { readonly type: "athlete-cancels" }
  | {
      readonly type: "athlete-confirms-end";
      readonly todayDateKey: number;
      readonly athleteChanges: AthleteChangesChoice;
    }
  | { readonly type: "athlete-starts-replacing"; readonly replacementPlanId: string }
  | { readonly type: "athlete-discards-replacement" }
  | {
      readonly type: "athlete-approves-replacement";
      readonly todayDateKey: number;
      readonly athleteChanges: AthleteChangesChoice;
    }
  | { readonly type: "cleanup-failed" }
  | { readonly type: "cleanup-verified" }
  | { readonly type: "cleanup-retried" }
  | { readonly type: "race-day-passed"; readonly todayDateKey: number };

export interface PlanCopyOnIcu {
  readonly planWorkoutId: string;
  readonly dateKey: number;
  readonly copy: IcuCopy;
}

export interface PlanEndingSummary {
  readonly removes: readonly PlanCopyOnIcu[];
  readonly staysToday: readonly PlanCopyOnIcu[];
  readonly athleteChanges: readonly PlanCopyOnIcu[];
}

export const PLAN_ENDING_START: PlanEnding = Object.freeze({ kind: "running" });

function close(
  reason: "ended" | "replaced",
  todayDateKey: number,
  athleteChanges: AthleteChangesChoice,
  replacement: ReplacementDelivery,
): PlanEnding {
  return {
    kind: "closed",
    reason,
    closedOnDateKey: todayDateKey,
    athleteChanges,
    cleanup: { kind: "running" },
    replacement,
  };
}

function withCleanup(ending: PlanEnding, cleanup: PlanCleanup): PlanEnding {
  if (ending.kind !== "closed" || ending.cleanup.kind === "not-needed") return ending;
  if (cleanup.kind === "verified" && ending.replacement.kind === "waiting-for-cleanup") {
    return {
      ...ending,
      cleanup,
      replacement: { kind: "may-send", replacementPlanId: ending.replacement.replacementPlanId },
    };
  }
  return { ...ending, cleanup };
}

export function planEndingStep(ending: PlanEnding, event: PlanEndingEvent): PlanEnding {
  switch (event.type) {
    case "athlete-presses-end":
      return ending.kind === "running" ? { kind: "end-confirm-open" } : ending;
    case "athlete-cancels":
      return ending.kind === "end-confirm-open" ? PLAN_ENDING_START : ending;
    case "athlete-confirms-end":
      if (ending.kind !== "end-confirm-open") return ending;
      return close("ended", event.todayDateKey, event.athleteChanges, { kind: "no-replacement" });
    case "athlete-starts-replacing":
      if (ending.kind !== "running") return ending;
      return { kind: "replacement-in-review", replacementPlanId: event.replacementPlanId };
    case "athlete-discards-replacement":
      return ending.kind === "replacement-in-review" ? PLAN_ENDING_START : ending;
    case "athlete-approves-replacement":
      if (ending.kind !== "replacement-in-review") return ending;
      return close("replaced", event.todayDateKey, event.athleteChanges, {
        kind: "waiting-for-cleanup",
        replacementPlanId: ending.replacementPlanId,
      });
    case "cleanup-failed":
      return ending.kind === "closed" && ending.cleanup.kind === "running"
        ? withCleanup(ending, { kind: "failed" })
        : ending;
    case "cleanup-retried":
      return ending.kind === "closed" && ending.cleanup.kind === "failed"
        ? withCleanup(ending, { kind: "running" })
        : ending;
    case "cleanup-verified":
      return ending.kind === "closed" &&
        (ending.cleanup.kind === "running" || ending.cleanup.kind === "failed")
        ? withCleanup(ending, { kind: "verified" })
        : ending;
    case "race-day-passed":
      if (ending.kind !== "running") return ending;
      return {
        kind: "closed",
        reason: "completed",
        closedOnDateKey: event.todayDateKey,
        athleteChanges: "keep-them",
        cleanup: { kind: "not-needed" },
        replacement: { kind: "no-replacement" },
      };
  }
}

export function planIsClosedLocally(ending: PlanEnding): boolean {
  return ending.kind === "closed";
}

export function replacementMaySend(ending: PlanEnding): boolean {
  return ending.kind === "closed" && ending.replacement.kind === "may-send";
}

export function planEndingSummary(
  copies: readonly PlanCopyOnIcu[],
  todayDateKey: number,
): PlanEndingSummary {
  const tomorrow = addCivilDays(todayDateKey, 1);
  const onIcu = copies.filter(
    (entry) => entry.copy.kind === "on-icu" || entry.copy.kind === "changed-in-icu",
  );
  return {
    removes: onIcu.filter(
      (entry) => entry.dateKey >= tomorrow && !icuCopyIsAthleteChange(entry.copy),
    ),
    staysToday: onIcu.filter((entry) => entry.dateKey === todayDateKey),
    athleteChanges: onIcu.filter(
      (entry) => entry.dateKey >= tomorrow && icuCopyIsAthleteChange(entry.copy),
    ),
  };
}

export function cleanupDeletes(
  copies: readonly PlanCopyOnIcu[],
  todayDateKey: number,
  athleteChanges: AthleteChangesChoice,
): readonly PlanCopyOnIcu[] {
  const summary = planEndingSummary(copies, todayDateKey);
  return athleteChanges === "remove-them"
    ? [...summary.removes, ...summary.athleteChanges]
    : summary.removes;
}
