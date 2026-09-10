import { msg, type Message } from "@enduragent/i18n";
import type { PlanCreationCardModel } from "@enduragent/coach-contract";

export function creationTitle(
  creation: PlanCreationCardModel,
  formatDate: (value: string) => string,
): Message | string {
  const summary = creation.answeredSummaries.find((answer) => answer.answerKey === "goal");
  if (summary?.answer.kind !== "goal") return msg("chat.planCreation.newPlan");
  const goal = summary.answer.goal;
  if (goal.kind === "fitness") return goal.outcome ?? msg("chat.planCreation.improveFitness");
  if (goal.kind === "event-manual")
    return msg("chat.planCreation.eventDate", { name: goal.name, date: formatDate(goal.date) });
  const candidate =
    summary.question.kind === "goal-question"
      ? summary.question.candidates.find((item) => item.candidateId === goal.candidateId)
      : undefined;
  return candidate === undefined
    ? summary.detail
    : msg("chat.planCreation.eventDate", {
        name: candidate.name,
        date: formatDate(candidate.date),
      });
}
