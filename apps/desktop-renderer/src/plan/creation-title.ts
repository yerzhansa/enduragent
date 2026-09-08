import type { PlanCreationCardModel } from "@enduragent/coach-contract";

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

export function creationTitle(creation: PlanCreationCardModel): string {
  const summary = creation.answeredSummaries.find((answer) => answer.answerKey === "goal");
  if (summary?.answer.kind !== "goal") return "New Plan";
  const goal = summary.answer.goal;
  if (goal.kind === "fitness") return goal.outcome ?? "Improve fitness";
  if (goal.kind === "event-manual") return `${goal.name} · ${dateLabel(goal.date)}`;
  const candidate =
    summary.question.kind === "goal-question"
      ? summary.question.candidates.find((item) => item.candidateId === goal.candidateId)
      : undefined;
  return candidate === undefined
    ? summary.detail
    : `${candidate.name} · ${dateLabel(candidate.date)}`;
}
