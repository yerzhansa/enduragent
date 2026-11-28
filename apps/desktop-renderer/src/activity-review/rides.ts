import type { PlanCalendarRide, PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { addDays, rowStart, type FirstDayOfWeek } from "../calendar/dates";

export type ActivityReviewRead = Extract<PlanCalendarRpcResult, { status: "rides" }>;

export const REVIEW_DAYS = 120;

export type RideOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "extra" }
  | { readonly kind: "is-this"; readonly name: string }
  | { readonly kind: "done-as-planned" }
  | { readonly kind: "done-differently" };

export type RideGroupLabel =
  | { readonly kind: "training-week"; readonly week: number }
  | { readonly kind: "week"; readonly startDateKey: number; readonly endDateKey: number };

export interface RideGroup {
  readonly key: string;
  readonly label: RideGroupLabel;
  readonly rides: readonly PlanCalendarRide[];
}

export function reviewRange(todayDateKey: number): {
  readonly startDateKey: number;
  readonly endDateKey: number;
} {
  return { startDateKey: addDays(todayDateKey, -(REVIEW_DAYS - 1)), endDateKey: todayDateKey };
}

function trainingWeekOf(read: ActivityReviewRead, dateKey: number): number | null {
  return (
    read.plan?.weeks.find((week) => dateKey >= week.startDateKey && dateKey <= week.endDateKey)
      ?.index ?? null
  );
}

export function rideOutcome(read: ActivityReviewRead, ride: PlanCalendarRide): RideOutcome {
  switch (ride.match.kind) {
    case "suggested":
      return { kind: "is-this", name: ride.match.name };
    case "confirmed":
      return { kind: ride.match.outcome };
    case "none":
      return trainingWeekOf(read, ride.dateKey) === null ? { kind: "none" } : { kind: "extra" };
  }
}

function groupLabel(
  read: ActivityReviewRead,
  dateKey: number,
  firstDay: FirstDayOfWeek,
): RideGroupLabel {
  const week = trainingWeekOf(read, dateKey);
  if (week !== null) return { kind: "training-week", week };
  const startDateKey = rowStart(dateKey, firstDay);
  return { kind: "week", startDateKey, endDateKey: addDays(startDateKey, 6) };
}

function labelKey(label: RideGroupLabel): string {
  return label.kind === "training-week"
    ? `training-week-${label.week}`
    : `week-${label.startDateKey}`;
}

export function newestFirst(rides: readonly PlanCalendarRide[]): PlanCalendarRide[] {
  return [...rides].sort(
    (left, right) =>
      right.dateKey - left.dateKey ||
      right.startEpochSeconds - left.startEpochSeconds ||
      left.activityId.localeCompare(right.activityId),
  );
}

export function rideGroups(read: ActivityReviewRead, firstDay: FirstDayOfWeek): RideGroup[] {
  const groups: { key: string; label: RideGroupLabel; rides: PlanCalendarRide[] }[] = [];
  for (const ride of newestFirst(read.rides)) {
    const label = groupLabel(read, ride.dateKey, firstDay);
    const key = labelKey(label);
    const last = groups.at(-1);
    if (last?.key === key) last.rides.push(ride);
    else groups.push({ key, label, rides: [ride] });
  }
  return groups;
}

export function selectedRide(
  read: ActivityReviewRead,
  selectedId: string | null,
): PlanCalendarRide | null {
  const first = newestFirst(read.rides)[0] ?? null;
  if (selectedId === null) return first;
  return read.rides.find((ride) => ride.activityId === selectedId) ?? first;
}
