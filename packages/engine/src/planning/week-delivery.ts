import { thisTrainingWeekAndNext, trainingWeek, type TrainingWeekPlan } from "./training-week.js";

export type WeekDeliverySetting = "send-each-week" | "approve-each-week";

export type WeekDelivery =
  | { readonly kind: "waiting-for-first-approve" }
  | {
      readonly kind: "approved";
      readonly firstSetWeeks: readonly number[];
      readonly approvedWeeks: readonly number[];
    };

export type WeekDeliveryEvent =
  | { readonly type: "first-approve"; readonly todayDateKey: number }
  | { readonly type: "approve-week"; readonly week: number; readonly todayDateKey: number };

export type WeekDeliveryRefusal = "already-approved" | "not-approved-yet" | "week-not-due";

export type WeekDeliveryResult =
  | { readonly kind: "changed"; readonly state: WeekDelivery }
  | {
      readonly kind: "refused";
      readonly reason: WeekDeliveryRefusal;
      readonly state: WeekDelivery;
    };

export interface WeekDeliveryInput {
  readonly plan: TrainingWeekPlan;
  readonly state: WeekDelivery;
  readonly setting: WeekDeliverySetting;
  readonly todayDateKey: number;
  readonly sentWeeks: ReadonlySet<number>;
}

export type WeekDeliveryStatus =
  | { readonly kind: "passed" }
  | { readonly kind: "on-intervals" }
  | { readonly kind: "goes-out"; readonly onDateKey: number }
  | { readonly kind: "waiting-for-first-approve" }
  | { readonly kind: "approve-from"; readonly onDateKey: number }
  | { readonly kind: "waiting-for-week-approve" }
  | { readonly kind: "due" };

export const WEEK_DELIVERY_START: WeekDelivery = Object.freeze({
  kind: "waiting-for-first-approve",
});

export function firstChangeSetWeeks(
  plan: TrainingWeekPlan,
  todayDateKey: number,
): readonly number[] {
  return thisTrainingWeekAndNext(plan, todayDateKey);
}

export function weekDeliveryStep(
  plan: TrainingWeekPlan,
  state: WeekDelivery,
  event: WeekDeliveryEvent,
): WeekDeliveryResult {
  if (event.type === "first-approve") {
    if (state.kind === "approved") return { kind: "refused", reason: "already-approved", state };
    return {
      kind: "changed",
      state: {
        kind: "approved",
        firstSetWeeks: firstChangeSetWeeks(plan, event.todayDateKey),
        approvedWeeks: [],
      },
    };
  }
  if (state.kind !== "approved") return { kind: "refused", reason: "not-approved-yet", state };
  if (!thisTrainingWeekAndNext(plan, event.todayDateKey).includes(event.week)) {
    return { kind: "refused", reason: "week-not-due", state };
  }
  if (state.approvedWeeks.includes(event.week) || state.firstSetWeeks.includes(event.week)) {
    return { kind: "refused", reason: "already-approved", state };
  }
  return {
    kind: "changed",
    state: {
      ...state,
      approvedWeeks: [...state.approvedWeeks, event.week].sort((left, right) => left - right),
    },
  };
}

export function weekIsAllowed(
  state: WeekDelivery,
  setting: WeekDeliverySetting,
  week: number,
): boolean {
  if (state.kind !== "approved") return false;
  return (
    state.firstSetWeeks.includes(week) ||
    setting === "send-each-week" ||
    state.approvedWeeks.includes(week)
  );
}

export function weeksToSend(input: WeekDeliveryInput): readonly number[] {
  return thisTrainingWeekAndNext(input.plan, input.todayDateKey).filter(
    (week) => weekIsAllowed(input.state, input.setting, week) && !input.sentWeeks.has(week),
  );
}

export function weeksWaitingForApprove(input: WeekDeliveryInput): readonly number[] {
  if (input.state.kind !== "approved" || input.setting !== "approve-each-week") return [];
  return thisTrainingWeekAndNext(input.plan, input.todayDateKey).filter(
    (week) => !weekIsAllowed(input.state, input.setting, week) && !input.sentWeeks.has(week),
  );
}

export function weekDeliveryStatus(
  input: WeekDeliveryInput & { readonly week: number },
): WeekDeliveryStatus {
  if (input.sentWeeks.has(input.week)) return { kind: "on-intervals" };
  const due = thisTrainingWeekAndNext(input.plan, input.todayDateKey);
  const current = due[0];
  if (current !== undefined && input.week < current) return { kind: "passed" };
  if (due.length === 0) return { kind: "passed" };
  if (input.state.kind !== "approved" && due.includes(input.week)) {
    return { kind: "waiting-for-first-approve" };
  }
  if (!due.includes(input.week)) {
    const onDateKey = trainingWeek(input.plan, input.week).sendDateKey;
    return input.setting === "approve-each-week"
      ? { kind: "approve-from", onDateKey }
      : { kind: "goes-out", onDateKey };
  }
  if (!weekIsAllowed(input.state, input.setting, input.week)) {
    return { kind: "waiting-for-week-approve" };
  }
  return { kind: "due" };
}
