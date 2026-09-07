import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  addCivilDays,
  dateKeyFromText,
  inclusiveCivilDays,
  weekdayForDateKey,
} from "@enduragent/kernel/planning";

export interface CreationDraftInput {
  answers: {
    goal:
      | { kind: "fitness"; outcome?: string; weeks: 4 | 8 | 12 | 16 }
      | { kind: "event"; name: string; date: string };
    availability:
      | {
          mode: "fixed";
          weeklyHoursLimit: number;
          longestWorkoutHours: number;
          usableWeekdays: readonly number[];
        }
      | { mode: "flexible"; weeklyHoursLimit: number; longestWorkoutHours: number };
    startTiming: { kind: "as-soon-as-possible" } | { kind: "earliest"; date: string };
    restriction:
      | { kind: "none" }
      | { kind: "no-training" | "no-hard-training"; endDate?: string }
      | { kind: "max-duration"; hours: number; endDate?: string };
    commitments: { kind: "none" } | { kind: "authored"; text: string };
    baseline: "regular" | "occasional" | "starting-again";
    success:
      | { kind: "fitness-choice"; choice: "train-consistently" | "climb-stronger" | "ride-farther" }
      | { kind: "event-finish"; choice: "finish-comfortably" | "finish-fast" | "race-for-result" }
      | { kind: "authored"; text: string };
  };
  today: string;
  ftp: number | null;
}

interface DraftWorkout {
  id: string;
  name: string;
  kind: "hard" | "endurance" | "long" | "easy" | "event";
  date: string | null;
  minutes: number;
  pinned: boolean;
  guidance: string;
  power: number | null;
}

interface DraftWeek {
  number: number;
  start: string;
  end: string;
  workouts: DraftWorkout[];
  notes: string[];
}

export interface CreationDraft {
  kind: "draft";
  goal: CreationDraftInput["answers"]["goal"];
  mode: "fixed" | "flexible";
  start: string;
  end: string;
  spanKind: "Short block" | "Event preparation" | "Base Plan" | "Fitness Plan";
  computedWeeks: number;
  weeks: DraftWeek[];
  notes: string[];
  guidance: string;
  ftp: number | null;
  builderId: string;
  builderVersion: string;
  inputFingerprint: string;
  outputFingerprint: string;
}

export type CreationDraftResult = CreationDraft | { kind: "no-workouts"; explanation: string };

const guidance = "Use comfortable perceived effort or your known heart-rate guidance";
const templates: Pick<DraftWorkout, "name" | "kind" | "minutes">[] = [
  { name: "Controlled effort", kind: "hard", minutes: 45 },
  { name: "Endurance ride", kind: "endurance", minutes: 60 },
  { name: "Long ride", kind: "long", minutes: 100 },
  { name: "Optional easy ride", kind: "easy", minutes: 30 },
  { name: "Additional endurance ride", kind: "endurance", minutes: 45 },
];

function civilText(key: number): string {
  const digits = String(key).padStart(8, "0");
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function rulesFor(answers: CreationDraftInput["answers"], key: number) {
  const restriction = answers.restriction;
  const active =
    restriction.kind !== "none" && (!restriction.endDate || civilText(key) <= restriction.endDate);
  return {
    unavailable: active && restriction.kind === "no-training",
    noHard: active && restriction.kind === "no-hard-training",
    minutes: Math.floor(
      Math.min(
        answers.availability.longestWorkoutHours,
        active && restriction.kind === "max-duration" ? restriction.hours : Infinity,
      ) * 60,
    ),
  };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildCreationDraft(input: CreationDraftInput): CreationDraftResult {
  const { answers } = input;
  const { availability, goal } = answers;
  const earliest =
    answers.startTiming.kind === "earliest" && answers.startTiming.date > input.today
      ? answers.startTiming.date
      : input.today;
  const earliestKey = dateKeyFromText(earliest);
  let startKey: number | undefined;
  for (let offset = 0; offset < 370; offset++) {
    const date = addCivilDays(earliestKey, offset);
    if (
      (availability.mode === "flexible" ||
        availability.usableWeekdays.includes(weekdayForDateKey(date) || 7)) &&
      !rulesFor(answers, date).unavailable
    ) {
      startKey = date;
      break;
    }
  }
  if (startKey === undefined)
    return {
      kind: "no-workouts",
      explanation:
        "No Workouts fit anywhere in this Plan under your confirmed limits. Edit those limits to continue.",
    };
  if (goal.kind === "event" && dateKeyFromText(goal.date) < startKey)
    return { kind: "no-workouts", explanation: "Choose an event date on or after the Plan start." };
  const computedWeeks =
    goal.kind === "fitness"
      ? goal.weeks
      : Math.ceil(inclusiveCivilDays(startKey, dateKeyFromText(goal.date)) / 7);
  const weekCount = goal.kind === "event" && computedWeeks > 24 ? 12 : computedWeeks;
  const spanKind =
    goal.kind === "fitness"
      ? "Fitness Plan"
      : computedWeeks <= 4
        ? "Short block"
        : computedWeeks > 24
          ? "Base Plan"
          : "Event preparation";
  const count =
    availability.mode === "fixed" || availability.weeklyHoursLimit <= 6
      ? 3
      : availability.weeklyHoursLimit <= 8
        ? 4
        : 5;
  const weeks: DraftWeek[] = [];
  for (let number = 1; number <= weekCount; number++) {
    const key = addCivilDays(startKey, (number - 1) * 7);
    const week: DraftWeek = {
      number,
      start: civilText(key),
      end: civilText(addCivilDays(key, 6)),
      workouts: [],
      notes: [],
    };
    let remaining = Math.floor(availability.weeklyHoursLimit * 60);
    const dates = Array.from({ length: 7 }, (_, index) => addCivilDays(key, index));
    const possible = dates.filter((date) => !rulesFor(answers, date).unavailable);
    if (goal.kind === "event" && goal.date >= week.start && goal.date <= week.end) {
      const rule = rulesFor(answers, dateKeyFromText(goal.date));
      const minutes = Math.min(60, rule.minutes, remaining);
      if (rule.unavailable || minutes <= 0)
        week.notes.push(`${goal.name} has no training assigned under your confirmed limits.`);
      else {
        week.workouts.push({
          id: `w${number}-main-goal`,
          name: goal.name,
          kind: "event",
          date: goal.date,
          minutes,
          pinned: true,
          power: null,
          guidance: "Follow the confirmed event limit",
        });
        remaining -= minutes;
        if (minutes < 60)
          week.notes.push(`${goal.name} limited to ${minutes} minutes by your confirmed limits.`);
      }
    }
    for (const [index, template] of templates.slice(0, count).entries()) {
      const assigned =
        availability.mode === "fixed"
          ? possible.find(
              (date) =>
                availability.usableWeekdays.includes(weekdayForDateKey(date) || 7) &&
                !week.workouts.some((workout) => workout.date === civilText(date)),
            )
          : undefined;
      const rule =
        assigned === undefined
          ? {
              minutes: Math.min(...possible.map((date) => rulesFor(answers, date).minutes)),
              noHard: possible.some((date) => rulesFor(answers, date).noHard),
            }
          : rulesFor(answers, assigned);
      const minutes = Math.min(template.minutes, rule.minutes, remaining);
      if (
        (availability.mode === "fixed" && assigned === undefined) ||
        possible.length === 0 ||
        minutes <= 0
      ) {
        week.notes.push(`${template.name} removed because no compatible time remains.`);
        continue;
      }
      const replaceHard = template.kind === "hard" && rule.noHard;
      const name = replaceHard ? "Easy ride" : template.name;
      if (minutes < template.minutes)
        week.notes.push(`${name} limited to ${minutes} minutes by your confirmed limits.`);
      if (replaceHard)
        week.notes.push(
          "Hard training replaced with an easy ride under the confirmed restriction.",
        );
      week.workouts.push({
        id: `w${number}-template-${index + 1}`,
        name,
        kind: replaceHard ? "easy" : template.kind,
        date: assigned === undefined ? null : civilText(assigned),
        minutes,
        pinned: false,
        power: null,
        guidance,
      });
      remaining -= minutes;
    }
    if (week.workouts.length === 0)
      week.notes.push("Confirmed limits leave no Workouts in this week.");
    weeks.push(week);
  }
  if (weeks.every((week) => week.workouts.length === 0))
    return {
      kind: "no-workouts",
      explanation:
        "No Workouts fit anywhere in this Plan under your confirmed limits. Edit those limits to continue.",
    };
  const notes = [...new Set(weeks.flatMap((week) => week.notes))];
  if (answers.commitments.kind === "authored")
    notes.push(
      "Your written commitments are recorded for review and have not been applied to Workouts.",
    );
  const draft: Omit<CreationDraft, "inputFingerprint" | "outputFingerprint"> = {
    kind: "draft",
    goal: structuredClone(goal),
    mode: availability.mode,
    start: civilText(startKey),
    end: civilText(addCivilDays(startKey, weekCount * 7 - 1)),
    spanKind,
    computedWeeks,
    weeks,
    notes,
    guidance,
    ftp: null,
    builderId: "cycling-creation-draft",
    builderVersion: "1",
  };
  return { ...draft, inputFingerprint: digest(input), outputFingerprint: digest(draft) };
}
