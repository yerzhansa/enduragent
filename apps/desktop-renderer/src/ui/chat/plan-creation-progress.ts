import type { Phrasebook } from "@enduragent/i18n/messages";
import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { creationTitle } from "../../plan/creation-title";
import { resolvedAnswerSummaries } from "./PlanCreationDraftCards";

export function creationProgressCopy(input: {
  readonly model: PlanCreationCardModel;
  readonly paused: boolean;
  readonly libraryLoaded: boolean;
  readonly activePlanName: string | null;
  readonly formatDate: (value: string) => string;
  readonly phrasebook: Phrasebook;
}): {
  readonly title: string;
  readonly status: string;
  readonly summary: string;
} {
  const { say, format } = input.phrasebook;
  const title = creationTitle(input.model, input.formatDate);
  const summaries = resolvedAnswerSummaries(input.model.answeredSummaries);
  const total =
    input.model.openQuestion?.step.total ??
    input.model.answeredSummaries[0]?.question.step.total ??
    input.model.answeredSummaries.length;
  const summary =
    input.model.readiness === "ready"
      ? say("chat.planCreation.essentialsComplete")
      : say("chat.planCreation.answersProgress", {
          answered: format.number(summaries.length, { useGrouping: false }),
          total: format.number(total, { useGrouping: false }),
          activePlan: !input.libraryLoaded
            ? ""
            : input.activePlanName === null
              ? say("chat.planCreation.noActivePlan")
              : say("chat.planCreation.activePlanRunning", { name: input.activePlanName }),
        });
  return {
    title: typeof title === "string" ? title : say(title),
    status: input.paused ? say("chat.planCreation.paused") : say("chat.planCreation.inProgress"),
    summary,
  };
}
