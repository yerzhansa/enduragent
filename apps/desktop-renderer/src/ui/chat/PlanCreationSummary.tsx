import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { useEffect, useRef, type ReactElement } from "react";
import { Check } from "lucide-react";
import { Button } from "@enduragent/ui";
import { Card, CardContent } from "@enduragent/ui";
import { creationTitle } from "../../plan/creation-title";
import { useEnduragentStore } from "../../state/store";

import { commitmentSummaryId } from "./PlanCreationDraftCards";

export function PlanCreationSummary(props: {
  readonly model: PlanCreationCardModel;
  readonly answersOnly?: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
  const library = useEnduragentStore((state) => state.planLibrary.value);
  const paused = useEnduragentStore((state) => state.chat.planCreationPaused);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const discardButton = useRef<HTMLButtonElement>(null);
  const ready = props.model.readiness === "ready";
  const canContinue = paused && props.model.openQuestion !== null;
  const total =
    props.model.openQuestion?.step.total ??
    props.model.answeredSummaries[0]?.question.step.total ??
    props.model.answeredSummaries.length;
  useEffect(() => {
    if (focusRequest?.target === "discard") {
      queueMicrotask(() => discardButton.current?.focus());
    }
  }, [focusRequest?.revision, focusRequest?.target]);
  return (
    <section className="grid min-w-0 gap-4" aria-label="Plan Creation progress">
      {props.model.answeredSummaries.length === 0 ? null : (
        <ul className="m-0 grid list-none gap-2 p-0" role="list">
          {props.model.answeredSummaries.map((summary) => (
            <li
              key={summary.answerKey}
              className="grid min-w-0 grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_auto] items-center gap-row rounded-card border border-line bg-surface px-ctl-px py-3 text-sm"
              data-parity="summary.row"
              aria-label={`${summary.title} answer`}
            >
              <span className="grid size-8 place-items-center rounded-full bg-[color-mix(in_srgb,var(--ok)_16%,var(--surface))] text-ok">
                <Check className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p
                  className="m-0 mb-[calc(var(--inset)/2)] text-xs font-semibold uppercase tracking-wide text-ink-2"
                  data-parity="summary.eyebrow"
                >
                  Answer recorded
                </p>
                <strong
                  className="block min-w-0 break-words font-medium"
                  data-parity="summary.label"
                >
                  {summary.detail}
                </strong>
                <p
                  className="m-0 mt-[calc(var(--inset)/2)] text-xs text-ink-2"
                  data-parity="summary.detail"
                >
                  {summary.title} ·{" "}
                  {summary.source.kind === "athlete" ? "your answer" : summary.source.label}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="gap-inset border-line bg-surface"
                data-parity="summary.edit"
                aria-label={`Edit ${summary.title}`}
                disabled={actions === null || busy || editingKey !== null}
                onClick={() => actions?.editPlanCreation(summary.answerKey)}
              >
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
      {props.answersOnly ? null : (
        <Card size="sm" className="block min-w-0 gap-0 py-0" data-parity="progress.card">
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p
                  className="mt-0 mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2"
                  data-parity="progress.eyebrow"
                >
                  Plan creation
                </p>
                <strong
                  className="block text-base font-semibold leading-6"
                  data-parity="progress.title"
                >
                  {creationTitle(props.model)}
                </strong>
              </div>
              <div className="flex items-center gap-inset self-start">
                <span
                  className="inline-flex items-center gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal leading-4 text-ink-2"
                  data-parity="progress.status"
                >
                  {paused ? "Paused" : "In progress"}
                </span>
              </div>
            </div>
            <p
              className="mt-inset mb-0 text-sm leading-5 text-ink-2"
              data-parity="progress.summary"
            >
              {ready
                ? "The essentials are complete."
                : `${props.model.answeredSummaries.length} of ${total} answered.${library === null ? "" : ` ${library.active ? `${library.active.name} keeps running.` : "No Plan is active."}`}`}
            </p>
            <div className="mt-4 flex flex-wrap gap-inset" data-parity="progress.actions">
              <Button
                ref={discardButton}
                type="button"
                variant="destructive"
                className="border-[color-mix(in_srgb,var(--danger)_52%,var(--line))] bg-transparent"
                data-plan-creation-discard={props.model.creationId}
                aria-haspopup="dialog"
                disabled={busy || actions === null}
                onClick={() => actions?.openPlanCreationDiscard()}
              >
                Discard
              </Button>
              {ready && props.model.draft === null ? (
                <Button
                  disabled={
                    actions === null ||
                    busy ||
                    editingKey !== null ||
                    props.model.pendingCommitment !== null
                  }
                  aria-describedby={
                    props.model.pendingCommitment === null
                      ? undefined
                      : commitmentSummaryId(props.model)
                  }
                  onClick={() => actions?.buildPlanCreationDraft()}
                >
                  Build Draft
                </Button>
              ) : null}
              {canContinue ? (
                <Button
                  type="button"
                  variant="default"
                  disabled={actions === null || busy}
                  onClick={() => actions?.continuePlanCreation()}
                >
                  Continue
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
