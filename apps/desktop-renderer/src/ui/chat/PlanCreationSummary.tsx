import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { useEffect, useRef, type ReactElement } from "react";
import { Check } from "lucide-react";
import { Button } from "@enduragent/ui";
import { Card, CardContent } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";

import { commitmentSummaryId } from "./PlanCreationDraftCards";

export function PlanCreationSummary(props: {
  readonly model: PlanCreationCardModel;
  readonly answersOnly?: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
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
    <section className="grid min-w-0 gap-inset" aria-label="Plan Creation progress">
      {props.model.answeredSummaries.length === 0 ? null : (
        <ul className="m-0 grid list-none gap-2 p-0" role="list">
          {props.model.answeredSummaries.map((summary) => (
            <li
              key={summary.answerKey}
              className="grid min-w-0 grid-cols-[var(--ctl-h-sm)_minmax(0,1fr)_auto] items-center gap-row rounded-card border border-line bg-surface px-ctl-px py-3 text-sm"
              data-parity="summary.row"
              aria-label={`${summary.title} answer`}
            >
              <span className="grid size-8 place-items-center rounded-full bg-primary/10 text-primary">
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
        <Card size="sm" className="min-w-0" data-parity="progress.card">
          <CardContent className="grid gap-inset">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-inset">
              <div className="grid gap-[calc(var(--inset)/2)]">
                <p
                  className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2"
                  data-parity="progress.eyebrow"
                >
                  Plan creation
                </p>
                <strong data-parity="progress.title">New Plan</strong>
              </div>
              <div className="flex items-center gap-inset self-start">
                <span
                  className="rounded-full bg-ink/7 px-2 py-1 text-xs font-medium text-ink-2"
                  data-parity="progress.status"
                >
                  {ready ? "Ready" : "In progress"}
                </span>
                <Button
                  ref={discardButton}
                  type="button"
                  variant="destructive"
                  size="sm"
                  data-plan-creation-discard={props.model.creationId}
                  aria-haspopup="dialog"
                  disabled={busy || actions === null}
                  onClick={() => actions?.openPlanCreationDiscard()}
                >
                  Discard
                </Button>
              </div>
            </div>
            <p className="m-0 text-xs text-ink-2" data-parity="progress.summary">
              {ready
                ? "The essentials are complete."
                : `${props.model.answeredSummaries.length} of ${total} answered.`}
            </p>
            <div className="flex flex-wrap gap-inset" data-parity="progress.actions">
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
                  variant="outline"
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
