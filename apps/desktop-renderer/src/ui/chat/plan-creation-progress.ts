import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { creationTitle } from "../../plan/creation-title";
import { resolvedAnswerSummaries } from "./PlanCreationDraftCards";

export function creationProgressCopy(input: {
  readonly model: PlanCreationCardModel;
  readonly paused: boolean;
  readonly libraryLoaded: boolean;
  readonly activePlanName: string | null;
}): {
  readonly title: string;
  readonly status: "Paused" | "In progress";
  readonly summary: string;
} {
  const summaries = resolvedAnswerSummaries(input.model.answeredSummaries);
  const total =
    input.model.openQuestion?.step.total ??
    input.model.answeredSummaries[0]?.question.step.total ??
    input.model.answeredSummaries.length;
  const summary =
    input.model.readiness === "ready"
      ? "The essentials are complete."
      : `${summaries.length} of ${total} answered.${
          input.libraryLoaded
            ? input.activePlanName === null
              ? " No Plan is active."
              : ` ${input.activePlanName} keeps running.`
            : ""
        }`;
  return {
    title: creationTitle(input.model),
    status: input.paused ? "Paused" : "In progress",
    summary,
  };
}
