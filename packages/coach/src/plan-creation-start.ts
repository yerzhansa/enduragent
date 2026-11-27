import {
  formatCivilDate,
  type GoalEventCandidate,
  type PlanCreationAnswer,
  type PlanCreationGoal,
  type PlanCreationOpenQuestion,
} from "@enduragent/coach-contract";
import { creationStart, pickedStart, type CreationDraftInput } from "@enduragent/sport-cycling";

type StartTiming = Extract<PlanCreationAnswer, { kind: "start-timing" }>["timing"];
type StartTimingQuestion = Extract<PlanCreationOpenQuestion, { kind: "start-timing-question" }>;

export function goalEventDate(
  goal: PlanCreationGoal,
  candidates: readonly GoalEventCandidate[],
): string | null {
  if (goal.kind === "fitness") return null;
  if (goal.kind === "event-manual") return goal.date;
  return candidates.find((candidate) => candidate.candidateId === goal.candidateId)?.date ?? null;
}

function latestStart(today: string, eventDate: string | null): string | null {
  return eventDate !== null && eventDate >= today ? eventDate : null;
}

export function startTimingQuestion(
  step: StartTimingQuestion["step"],
  today: string,
  eventDate: string | null,
): StartTimingQuestion {
  const latest = latestStart(today, eventDate);
  return {
    kind: "start-timing-question",
    step,
    prompt: "When should this Plan start?",
    earliestAllowed: today,
    ...(latest === null ? {} : { latestAllowed: latest }),
    options: [
      {
        timing: "first-day-of-week",
        label: "First day of your week",
        detail: "One calendar row is one Training Week.",
      },
      {
        timing: "earliest",
        label: "Pick another day",
        detail: "The Plan starts on the day you pick.",
      },
    ],
    dateLabel: "Plan starts",
  };
}

export function validStartTiming(
  timing: StartTiming,
  today: string,
  eventDate: string | null,
): boolean {
  if (timing.kind === "as-soon-as-possible") return true;
  const latest = latestStart(today, eventDate);
  return timing.date >= today && (latest === null || timing.date <= latest);
}

export function startTimingDetail(
  timing: StartTiming,
  today: string,
  answers: CreationDraftInput["answers"] | null,
  eventDate: string | null,
): string {
  if (timing.kind === "as-soon-as-possible") return "As soon as possible";
  const start =
    answers === null
      ? pickedStart(timing.date, today, eventDate)
      : (creationStart({ answers, today, ftp: null }) ?? timing.date);
  return `Starts ${formatCivilDate(start)}`;
}

interface Sequenced {
  readonly answer: PlanCreationAnswer;
  readonly record: { readonly sequence: number };
}

export function startsAfterEvent(
  start: Sequenced,
  valid: ReadonlyMap<string, Sequenced>,
  seed: { readonly eventCandidates: readonly GoalEventCandidate[] } | null | undefined,
): boolean {
  const goal = valid.get("goal");
  const answer = start.answer;
  if (answer.kind !== "start-timing" || answer.timing.kind !== "earliest") return false;
  if (goal === undefined || goal.record.sequence < start.record.sequence) return false;
  const eventDate =
    goal.answer.kind === "goal"
      ? goalEventDate(goal.answer.goal, seed?.eventCandidates ?? [])
      : null;
  return eventDate !== null && answer.timing.date > eventDate;
}
