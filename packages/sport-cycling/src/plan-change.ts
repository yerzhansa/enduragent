import { dateKeyFromText, weekdayForDateKey } from "@enduragent/kernel/planning";
import { type CreationDraft, digest } from "./creation-draft-builder.js";

export type ScheduleIntent =
  | { kind: "weekday-duration"; day: number; minutes: number }
  | { kind: "weekday-unavailable"; day: number }
  | { kind: "hard-weekday"; day: number }
  | { kind: "weekly-duration"; hours: number }
  | { kind: "longest-workout"; minutes: number };

type Workout = CreationDraft["weeks"][number]["workouts"][number];

export interface ScheduleChangeDiff {
  workoutId: string;
  before: Workout | null;
  after: Workout | null;
}

export interface ScheduleChangeTotals {
  before: { plan: number; weeks: { number: number; minutes: number }[] };
  after: { plan: number; weeks: { number: number; minutes: number }[] };
}

function totalMinutes(workouts: Workout[]): number {
  return workouts.reduce((sum, workout) => sum + (workout.date === null ? 0 : workout.minutes), 0);
}

function totals(draft: CreationDraft): ScheduleChangeTotals["before"] {
  const weeks = draft.weeks.map((week) => ({
    number: week.number,
    minutes: totalMinutes(week.workouts),
  }));
  return { plan: weeks.reduce((sum, week) => sum + week.minutes, 0), weeks };
}

function mutable(
  workout: Workout,
  todayDateKey: number,
  completedWorkoutIds: ReadonlySet<string>,
): boolean {
  return (
    !workout.pinned &&
    !completedWorkoutIds.has(workout.id) &&
    workout.date !== null &&
    dateKeyFromText(workout.date) >= todayDateKey
  );
}

function changed(before: Workout, after: Workout): boolean {
  return (
    before.name !== after.name ||
    before.kind !== after.kind ||
    before.date !== after.date ||
    before.minutes !== after.minutes ||
    before.guidance !== after.guidance
  );
}

export function applyScheduleIntent<Draft extends CreationDraft>({
  draft,
  intent,
  todayDateKey,
  completedWorkoutIds = new Set<string>(),
}: {
  draft: Draft;
  intent: ScheduleIntent;
  todayDateKey: number;
  completedWorkoutIds?: ReadonlySet<string>;
}): { after: Draft; diff: ScheduleChangeDiff[]; totals: ScheduleChangeTotals } {
  const after = structuredClone(draft);
  for (const week of after.weeks) {
    if (intent.kind === "weekly-duration") {
      const budgetMinutes = Math.floor(intent.hours * 60);
      let used = totalMinutes(week.workouts);
      for (const workout of [...week.workouts].reverse()) {
        if (!mutable(workout, todayDateKey, completedWorkoutIds) || used <= budgetMinutes) continue;
        const remaining = workout.minutes - (used - budgetMinutes);
        const minutes = remaining < 15 ? 0 : remaining;
        used -= workout.minutes - minutes;
        workout.minutes = minutes;
      }
    } else {
      for (const workout of week.workouts) {
        if (!mutable(workout, todayDateKey, completedWorkoutIds) || workout.date === null) continue;
        const weekday = weekdayForDateKey(dateKeyFromText(workout.date)) || 7;
        switch (intent.kind) {
          case "weekday-duration":
            if (weekday === intent.day) workout.minutes = Math.min(workout.minutes, intent.minutes);
            break;
          case "weekday-unavailable":
            if (weekday === intent.day) workout.minutes = 0;
            break;
          case "hard-weekday":
            if (weekday === intent.day && workout.kind === "hard") {
              workout.kind = "easy";
              workout.name = "Easy ride";
            }
            break;
          case "longest-workout":
            workout.minutes = Math.min(workout.minutes, intent.minutes);
            break;
          default: {
            const exhaustive: never = intent;
            throw new Error(`Unsupported Schedule intent: ${exhaustive}`);
          }
        }
      }
    }
    week.workouts = week.workouts.filter((workout) => workout.minutes > 0);
  }
  const remaining = new Map(after.weeks.flatMap((week) => week.workouts).map((w) => [w.id, w]));
  const diff: ScheduleChangeDiff[] = [];
  for (const before of draft.weeks.flatMap((week) => week.workouts)) {
    const next = remaining.get(before.id) ?? null;
    if (next === null || changed(before, next)) {
      diff.push({ workoutId: before.id, before: structuredClone(before), after: next });
    }
  }
  const { inputFingerprint: _input, outputFingerprint: _output, ...snapshot } = after;
  after.outputFingerprint = digest(snapshot);
  return { after, diff, totals: { before: totals(draft), after: totals(after) } };
}
