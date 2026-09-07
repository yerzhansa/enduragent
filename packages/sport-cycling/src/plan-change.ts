import { addCivilDays, dateKeyFromText, weekdayForDateKey } from "@enduragent/kernel/planning";
import {
  type CreationDraft,
  type CreationDraftInput,
  type SupportingEvent,
  digest,
} from "./creation-draft-builder.js";
import { validateManualPlanFtp } from "./plan-ftp.js";

export type ScheduleIntent =
  | { kind: "weekday-duration"; day: number; minutes: number }
  | { kind: "weekday-unavailable"; day: number }
  | { kind: "hard-weekday"; day: number }
  | { kind: "weekly-duration"; hours: number }
  | { kind: "longest-workout"; minutes: number }
  | { kind: "ftp"; watts: number };

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
    before.guidance !== after.guidance ||
    before.power !== after.power ||
    before.pinned !== after.pinned ||
    before.supportingEventId !== after.supportingEventId
  );
}

function changeResult<Draft extends CreationDraft>(draft: Draft, after: Draft) {
  const current = new Map(draft.weeks.flatMap((week) => week.workouts).map((w) => [w.id, w]));
  const remaining = new Map(after.weeks.flatMap((week) => week.workouts).map((w) => [w.id, w]));
  const diff: ScheduleChangeDiff[] = [];
  for (const before of current.values()) {
    const next = remaining.get(before.id) ?? null;
    if (next === null || changed(before, next)) {
      diff.push({ workoutId: before.id, before: structuredClone(before), after: next });
    }
  }
  for (const next of remaining.values()) {
    if (!current.has(next.id)) diff.push({ workoutId: next.id, before: null, after: next });
  }
  const { inputFingerprint: _input, outputFingerprint: _output, ...snapshot } = after;
  after.outputFingerprint = digest(snapshot);
  return { after, diff, totals: { before: totals(draft), after: totals(after) } };
}

export function applyScheduleIntent<Draft extends CreationDraft>(
  input: {
    draft: Draft;
    todayDateKey: number;
    completedWorkoutIds?: ReadonlySet<string>;
  } & (
    | { intent: ScheduleIntent }
    | { intent: { kind: "inverse"; changeId: string }; previousDraft: Draft }
  ),
): { after: Draft; diff: ScheduleChangeDiff[]; totals: ScheduleChangeTotals } {
  const { draft, todayDateKey, completedWorkoutIds = new Set<string>() } = input;
  if ("previousDraft" in input) {
    const after = structuredClone(input.previousDraft);
    const current = new Map(draft.weeks.flatMap((week) => week.workouts).map((w) => [w.id, w]));
    const restorable = (workout: Workout) =>
      (!workout.pinned || (workout.kind === "event" && workout.supportingEventId !== undefined)) &&
      !completedWorkoutIds.has(workout.id) &&
      (workout.date === null || dateKeyFromText(workout.date) >= todayDateKey);
    for (const week of after.weeks) {
      const currentWeek = draft.weeks.find((candidate) => candidate.number === week.number);
      const currentWeekIds = new Set(currentWeek?.workouts.map((workout) => workout.id));
      week.workouts = week.workouts
        .filter((workout) => {
          const present = current.get(workout.id);
          return present
            ? restorable(present) || currentWeekIds.has(present.id)
            : restorable(workout);
        })
        .map((workout) => {
          const present = current.get(workout.id);
          return present && !(restorable(present) && restorable(workout))
            ? structuredClone(present)
            : workout;
        });
      const restoredIds = new Set(week.workouts.map((workout) => workout.id));
      for (const workout of currentWeek?.workouts ?? []) {
        if (!restorable(workout) && !restoredIds.has(workout.id)) {
          week.workouts.push(structuredClone(workout));
        }
      }
    }
    if (after.supportingEvents !== undefined || draft.supportingEvents !== undefined) {
      const restoredEventIds = new Set(
        after.weeks
          .flatMap((week) => week.workouts)
          .flatMap((workout) =>
            workout.supportingEventId === undefined ? [] : [workout.supportingEventId],
          ),
      );
      const protectedEventIds = new Set(
        [...current.values()]
          .filter((workout) => !restorable(workout))
          .flatMap((workout) =>
            workout.supportingEventId === undefined ? [] : [workout.supportingEventId],
          ),
      );
      const previousWorkoutEventIds = new Set(
        input.previousDraft.weeks
          .flatMap((week) => week.workouts)
          .flatMap((workout) =>
            workout.supportingEventId === undefined ? [] : [workout.supportingEventId],
          ),
      );
      const restoredEvents = (after.supportingEvents ?? []).filter(
        (event) =>
          !protectedEventIds.has(event.id) &&
          (!previousWorkoutEventIds.has(event.id) || restoredEventIds.has(event.id)),
      );
      for (const event of draft.supportingEvents ?? []) {
        if (!protectedEventIds.has(event.id)) continue;
        const previous = input.previousDraft.supportingEvents?.find(
          (candidate) => candidate.id === event.id,
        );
        restoredEvents.push(structuredClone(previous?.date === event.date ? previous : event));
      }
      if (input.previousDraft.supportingEvents !== undefined || restoredEvents.length > 0) {
        after.supportingEvents = restoredEvents;
      }
    }
    const {
      inputFingerprint: _previousInput,
      outputFingerprint: previousOutput,
      ...previousContent
    } = input.previousDraft;
    const {
      inputFingerprint: _restoredInput,
      outputFingerprint: _restoredOutput,
      ...restoredContent
    } = after;
    const result = changeResult(draft, after);
    if (digest(previousContent) === digest(restoredContent)) {
      result.after.outputFingerprint = previousOutput;
    }
    return result;
  }
  const { intent } = input;
  const after = structuredClone(draft);
  if (intent.kind === "ftp") {
    const watts = validateManualPlanFtp(intent.watts);
    after.ftp = watts;
    for (const week of after.weeks) {
      for (const workout of week.workouts) {
        if (!mutable(workout, todayDateKey, completedWorkoutIds)) continue;
        workout.power = watts;
        workout.guidance = `Use your confirmed FTP of ${watts} W`;
      }
    }
    return changeResult(draft, after);
  }
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
  return changeResult(draft, after);
}

export const PLAN_CHANGE_RACE_WINDOW_DAYS = 7;

type IncreaseWorkout = Pick<Workout, "date" | "minutes" | "kind"> & { power: number | null };

export function planChangeRaceWindow(input: {
  goal: CreationDraft["goal"];
  todayDateKey: number;
  diff: readonly { before: IncreaseWorkout | null; after: IncreaseWorkout | null }[];
}): { start: string; end: string } | null {
  if (input.goal.kind !== "event") return null;
  const end = dateKeyFromText(input.goal.date);
  const start = addCivilDays(end, 1 - PLAN_CHANGE_RACE_WINDOW_DAYS);
  if (input.todayDateKey < start || input.todayDateKey > end) return null;
  const increases = input.diff.some(({ before, after }) => {
    if (after?.date == null) return false;
    const date = dateKeyFromText(after.date);
    return (
      date >= start &&
      date <= end &&
      (before === null ||
        after.minutes > before.minutes ||
        (before.kind !== "hard" && after.kind === "hard") ||
        (after.power ?? 0) > (before.power ?? 0))
    );
  });
  const startText = String(start).padStart(8, "0");
  return increases
    ? {
        start: `${startText.slice(0, 4)}-${startText.slice(4, 6)}-${startText.slice(6, 8)}`,
        end: input.goal.date,
      }
    : null;
}

export type SupportingEventIntent = { kind: "supporting-event" } & (
  | {
      operation: "add";
      name: string;
      date: string;
      role: SupportingEvent["role"];
      providerId?: string;
    }
  | { operation: "remove"; eventId: string }
  | { operation: "role"; eventId: string; role: SupportingEvent["role"] }
  | { operation: "manual"; eventId: string; name: string; date: string }
  | { operation: "source-update"; eventId: string }
  | { operation: "name"; eventId: string; name: string }
);

export type SupportingEventRules = Pick<
  CreationDraftInput["answers"],
  "availability" | "restriction"
>;

export interface SupportingEventSourceCandidate {
  providerId: string;
  name: string;
  date: string;
  category: "RACE_A" | "RACE_B" | "RACE_C";
  sourceRevision: string;
}

function supportingEventDateValid(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function eventDayRules(rules: SupportingEventRules, date: string) {
  const restriction = rules.restriction;
  const active =
    restriction.kind !== "none" && (!restriction.endDate || date <= restriction.endDate);
  return {
    unavailable:
      (rules.availability.mode === "fixed" &&
        !rules.availability.usableWeekdays.includes(
          weekdayForDateKey(dateKeyFromText(date)) || 7,
        )) ||
      (active && restriction.kind === "no-training"),
    minutes: Math.floor(
      Math.min(
        rules.availability.longestWorkoutHours,
        active && restriction.kind === "max-duration" ? restriction.hours : Infinity,
      ) * 60,
    ),
  };
}

export function supportingEventWorkoutLimitExplanation(draft: CreationDraft): string | null {
  const civilWeeks = new Map<number, number>();
  let exceeded = draft.weeks.some((week) => week.workouts.length > 6);
  for (const week of draft.weeks) {
    for (const workout of week.workouts) {
      if (workout.date === null) continue;
      const date = dateKeyFromText(workout.date);
      const start = addCivilDays(date, 1 - (weekdayForDateKey(date) || 7));
      const count = (civilWeeks.get(start) ?? 0) + 1;
      civilWeeks.set(start, count);
      if (count > 6) exceeded = true;
    }
  }
  return exceeded
    ? "A week can hold at most six Workouts. Remove or move one before adding this event."
    : null;
}

export function applySupportingEventIntent<Draft extends CreationDraft>(input: {
  draft: Draft;
  intent: SupportingEventIntent;
  todayDateKey: number;
  completedWorkoutIds?: ReadonlySet<string>;
  eventId?: string;
  source?: SupportingEventSourceCandidate;
  rules: SupportingEventRules;
}):
  | { status: "changed"; after: Draft; diff: ScheduleChangeDiff[]; totals: ScheduleChangeTotals }
  | { status: "invalid"; explanation: string } {
  const { draft, intent, todayDateKey, completedWorkoutIds = new Set<string>(), source } = input;
  const invalid = (explanation: string) => ({ status: "invalid" as const, explanation });
  const after = structuredClone(draft);
  after.supportingEvents ??= [];
  const result = () => {
    const explanation = supportingEventWorkoutLimitExplanation(after);
    return explanation === null
      ? { status: "changed" as const, ...changeResult(draft, after) }
      : invalid(explanation);
  };
  const existing =
    "eventId" in intent
      ? after.supportingEvents.find((event) => event.id === intent.eventId)
      : undefined;
  if (intent.operation !== "add" && !existing) {
    return invalid("Choose a Supporting Event already accepted in this Plan.");
  }
  if (intent.operation === "manual" && existing?.source.kind === "synced") {
    return invalid("Accept synchronized event updates through a fresh source-update preview.");
  }
  if (intent.operation === "source-update" && existing?.source.kind !== "synced") {
    return invalid("Choose a synchronized Supporting Event already accepted in this Plan.");
  }
  const providerId =
    intent.operation === "add"
      ? intent.providerId
      : intent.operation === "source-update" && existing?.source.kind === "synced"
        ? existing.source.providerId
        : undefined;
  if (providerId !== undefined && (!source || source.providerId !== providerId)) {
    return invalid("Choose an available synchronized event.");
  }
  let event: SupportingEvent;
  if (intent.operation === "add") {
    if (
      !input.eventId ||
      after.supportingEvents.some((candidate) => candidate.id === input.eventId)
    ) {
      return invalid("Choose a Supporting Event already accepted in this Plan.");
    }
    event = {
      id: input.eventId,
      name: providerId === undefined ? intent.name : (source?.name ?? intent.name),
      date: providerId === undefined ? intent.date : (source?.date ?? intent.date),
      role: intent.role,
      source:
        providerId !== undefined && source
          ? { kind: "synced", providerId, sourceRevision: source.sourceRevision }
          : { kind: "manual" },
    };
  } else {
    if (!existing) return invalid("Choose a Supporting Event already accepted in this Plan.");
    event = existing;
    switch (intent.operation) {
      case "remove":
        break;
      case "role":
        event.role = intent.role;
        break;
      case "manual":
        event.name = intent.name;
        event.date = intent.date;
        break;
      case "source-update":
        if (source) {
          event.name = source.name;
          event.date = source.date;
          event.source = {
            kind: "synced",
            providerId: source.providerId,
            sourceRevision: source.sourceRevision,
          };
        }
        break;
      case "name":
        event.name = intent.name;
        break;
      default: {
        const exhaustive: never = intent;
        throw new Error(`Unsupported Supporting Event intent: ${exhaustive}`);
      }
    }
  }
  if (intent.operation !== "remove") {
    if (!event.name.trim() || !supportingEventDateValid(event.date)) {
      return invalid("Enter the event name and exact date.");
    }
    if (event.role !== "Important" && event.role !== "Training") {
      return invalid("Choose Important or Training.");
    }
  }
  if (intent.operation === "name") return result();
  const eventWorkouts = draft.weeks
    .flatMap((week) => week.workouts)
    .filter((workout) => workout.supportingEventId === event.id);
  const canEditEventWorkout = (workout: Workout) =>
    workout.date !== null &&
    dateKeyFromText(workout.date) >= todayDateKey &&
    !completedWorkoutIds.has(workout.id);
  if (eventWorkouts.some((workout) => !canEditEventWorkout(workout))) {
    return invalid("Past or completed event Workouts cannot be changed.");
  }
  if (intent.operation === "remove") {
    after.supportingEvents = after.supportingEvents.filter(
      (candidate) => candidate.id !== event.id,
    );
    for (const week of after.weeks) {
      week.workouts = week.workouts.filter((workout) => workout.supportingEventId !== event.id);
    }
    return result();
  }
  const targetWeek = after.weeks.find((week) => event.date >= week.start && event.date <= week.end);
  if (
    !targetWeek ||
    event.date < draft.start ||
    event.date > draft.end ||
    (draft.goal.kind === "event" && event.date === draft.goal.date)
  ) {
    return invalid("Choose a Supporting Event inside this Plan span.");
  }
  const rules = eventDayRules(input.rules, event.date);
  if (rules.unavailable || rules.minutes <= 0) {
    return invalid("The event date conflicts with a confirmed training limit.");
  }
  if (dateKeyFromText(event.date) < todayDateKey) {
    return invalid("Past or completed event Workouts cannot be changed.");
  }
  if (intent.operation === "add") after.supportingEvents.push(event);
  for (const week of after.weeks) {
    week.workouts = week.workouts.filter(
      (workout) =>
        workout.supportingEventId !== event.id &&
        !(workout.date === event.date && mutable(workout, todayDateKey, completedWorkoutIds)),
    );
  }
  const previousWorkout = eventWorkouts[0];
  targetWeek.workouts.push({
    id: previousWorkout?.id ?? `supporting-event-${event.id}`,
    name: event.name,
    kind: "event",
    date: event.date,
    minutes: Math.min(45, rules.minutes),
    pinned: true,
    power: previousWorkout?.power ?? null,
    guidance: "Use the accepted event limit",
    supportingEventId: event.id,
  });
  if (event.role === "Important") {
    const eventDateKey = dateKeyFromText(event.date);
    const weekStart = addCivilDays(eventDateKey, 1 - (weekdayForDateKey(eventDateKey) || 7));
    const weekEnd = addCivilDays(weekStart, 6);
    for (const week of after.weeks) {
      for (const workout of week.workouts) {
        if (workout.pinned || completedWorkoutIds.has(workout.id)) continue;
        if (workout.date === null) {
          if (week !== targetWeek) continue;
        } else {
          const date = dateKeyFromText(workout.date);
          if (date < todayDateKey || date < weekStart || date > weekEnd) continue;
        }
        workout.minutes = Math.min(workout.minutes, 30);
        if (workout.kind === "hard") {
          workout.kind = "endurance";
          workout.name = "Endurance ride";
        }
      }
    }
  }
  return result();
}
