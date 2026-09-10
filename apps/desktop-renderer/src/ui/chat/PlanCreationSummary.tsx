import { usePhrasebook } from "@enduragent/i18n/react";
import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { Check } from "lucide-react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { resolvedAnswerSummaries } from "./PlanCreationDraftCards";

export function PlanCreationSummary(props: {
  readonly model: PlanCreationCardModel;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((state) => state.chatActions);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const summaries = resolvedAnswerSummaries(props.model.answeredSummaries);
  if (summaries.length === 0) return null;
  return (
    <ul className="m-0 grid list-none gap-2 p-0" role="list">
      {summaries.map((summary) => (
        <li
          key={summary.answerKey}
          className="grid min-w-0 grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_auto] items-center gap-row rounded-card border border-line bg-surface px-ctl-px py-3 text-sm"
          data-parity="summary.row"
          aria-label={say("chat.planCreation.answerLabel", { title: summary.title })}
        >
          <span className="grid size-8 place-items-center rounded-full bg-[color-mix(in_srgb,var(--ok)_16%,var(--surface))] text-ok">
            <Check className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p
              className="m-0 mb-[calc(var(--inset)/2)] text-xs font-semibold uppercase tracking-wide text-ink-2"
              data-parity="summary.eyebrow"
            >
              {say("chat.planCreation.answerRecorded")}
            </p>
            <strong className="block min-w-0 break-words font-medium" data-parity="summary.label">
              {summary.detail}
            </strong>
            <p
              className="m-0 mt-[calc(var(--inset)/2)] text-xs text-ink-2"
              data-parity="summary.detail"
            >
              {say("chat.planCreation.answerSource", {
                title: summary.title,
                source:
                  summary.source.kind === "athlete"
                    ? say("chat.planCreation.yourAnswer")
                    : summary.source.label,
              })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="gap-inset border-line bg-surface"
            data-parity="summary.edit"
            aria-label={say("chat.planCreation.editLabel", { title: summary.title })}
            disabled={actions === null || busy || editingKey !== null}
            onClick={() => actions?.editPlanCreation(summary.answerKey)}
          >
            {say("chat.planCreation.edit")}
          </Button>
        </li>
      ))}
    </ul>
  );
}
