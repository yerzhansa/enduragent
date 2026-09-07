import { type CreationDraft, type CreationDraftInput } from "./creation-draft-builder.js";

type Workout = CreationDraft["weeks"][number]["workouts"][number];

export interface TodayChoice {
  date: string;
  eligible: { workoutId: string; name: string; minutes: number; kind: Workout["kind"] }[];
  blocked: { workoutId: string; name: string; reason: string }[];
  reason: string | null;
}

export function readTodayChoice(input: {
  draft: CreationDraft;
  todayDateKey: number;
  answers: Pick<CreationDraftInput["answers"], "availability" | "restriction">;
  completedWorkoutIds?: ReadonlySet<string>;
  occupiedByClosedPlan?: boolean;
}): TodayChoice | null {
  const { draft, answers } = input;
  if (draft.mode !== "flexible") return null;
  const digits = String(input.todayDateKey).padStart(8, "0");
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const week = draft.weeks.find((week) => week.start <= date && date <= week.end);
  const candidates = week?.workouts.filter(
    (workout) =>
      workout.date === null && !workout.pinned && !input.completedWorkoutIds?.has(workout.id),
  );
  if (!candidates?.length) return null;
  const occupied =
    input.occupiedByClosedPlan ||
    draft.weeks.some((week) => week.workouts.some((workout) => workout.date === date));
  const restriction = answers.restriction;
  const active =
    restriction.kind !== "none" && (!restriction.endDate || date <= restriction.endDate);
  const unavailable = active && restriction.kind === "no-training";
  const noHard = active && restriction.kind === "no-hard-training";
  const minutes = Math.floor(
    Math.min(
      answers.availability.longestWorkoutHours,
      active && restriction.kind === "max-duration" ? restriction.hours : Infinity,
    ) * 60,
  );
  const planReason = occupied
    ? "Today already belongs to a dated Workout."
    : unavailable
      ? "Today is unavailable under your confirmed limits."
      : null;
  const result: TodayChoice = { date, eligible: [], blocked: [], reason: null };
  for (const workout of candidates) {
    const reason =
      planReason ??
      (workout.minutes > minutes
        ? `Today is limited to ${minutes} minutes.`
        : workout.kind === "hard" && noHard
          ? "No hard training today."
          : null);
    if (reason) {
      result.blocked.push({ workoutId: workout.id, name: workout.name, reason });
    } else {
      result.eligible.push({
        workoutId: workout.id,
        name: workout.name,
        minutes: workout.minutes,
        kind: workout.kind,
      });
    }
  }
  if (result.eligible.length === 0) result.reason = planReason ?? result.blocked[0]?.reason ?? null;
  return result;
}
