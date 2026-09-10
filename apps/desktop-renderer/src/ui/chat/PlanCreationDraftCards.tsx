import { formatCivilDate } from "@enduragent/coach-contract";
import type {
  PlanCreationAnswerSummary,
  PlanCreationCardModel,
  PlanCreationDraft,
  PlanCreationCommitmentRule,
} from "@enduragent/coach-contract";
import { useEffect, useRef, type ReactElement, type ReactNode, type Ref } from "react";
import { Button } from "@enduragent/ui";
import { Fact, PlanCard } from "../plan/plan-card";
import { useEnduragentStore } from "../../state/store";

const answerLabels: ReadonlyArray<readonly [PlanCreationAnswerSummary["answerKey"], string]> = [
  ["goal", "Main Goal"],
  ["plan-length", "Plan length"],
  ["schedule-mode", "Schedule mode"],
  ["availability", "Availability"],
  ["start-timing", "Start timing"],
  ["commitments", "Commitments"],
  ["baseline", "Recent training"],
  ["success", "Success"],
  ["restriction", "Training restriction"],
];

function AnswerFacts(props: {
  readonly summaries: readonly PlanCreationAnswerSummary[];
  readonly current?: boolean;
  readonly omitGoal?: boolean;
}): ReactElement {
  return (
    <>
      {answerLabels.map(([key, label]) => {
        const summary = props.summaries.find((answer) => answer.answerKey === key);
        if (summary === undefined || (props.omitGoal && key === "goal")) return null;
        const source = props.current
          ? "current answer"
          : summary.source.kind === "athlete"
            ? "your answer"
            : summary.source.label;
        return (
          <Fact key={key} label={`${label} · ${source}`}>
            {summary.detail}
          </Fact>
        );
      })}
    </>
  );
}

export function resolvedAnswerSummaries(
  summaries: readonly PlanCreationAnswerSummary[],
): PlanCreationAnswerSummary[] {
  return summaries.filter(
    ({ answer }) =>
      answer.kind !== "commitments" ||
      answer.commitments.kind !== "interpreted" ||
      answer.commitments.status === "confirmed",
  );
}

function ReviewCard(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly status?: string;
  readonly summary?: string;
  readonly summaryId?: string;
  readonly "aria-label"?: string;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly headingTabIndex?: number;
  readonly children: ReactNode;
}): ReactElement {
  return <PlanCard {...props} aria-label={props["aria-label"] ?? props.title} />;
}

export function PlanCreationDraftCards(props: {
  readonly model: PlanCreationCardModel;
  readonly draft: PlanCreationDraft;
  readonly onEditAnswers: () => void;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.chatActions);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const confirmationOpen = useEnduragentStore(
    (state) =>
      state.chat.planCreationActivateConfirmationOpen ||
      state.chat.planCreationDiscardConfirmationOpen,
  );
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const focusRequest = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const discardButton = useRef<HTMLButtonElement>(null);
  const activateButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusRequest?.target === "discard") queueMicrotask(() => discardButton.current?.focus());
    if (focusRequest?.target === "activate") queueMicrotask(() => activateButton.current?.focus());
    if (focusRequest?.target === "edit") queueMicrotask(() => editButton.current?.focus());
  }, [focusRequest?.revision, focusRequest?.target]);
  const draft = props.draft;
  const stale = props.model.draftStale;
  const pending = props.model.pendingCommitment !== null || props.model.pendingCheck !== null;
  const workouts = draft.weeks.flatMap((week) => week.workouts);
  const goal = draft.answeredSummaries.find((answer) => answer.answerKey === "goal");
  const title =
    draft.goal.kind === "event" ? draft.goal.name : (draft.goal.outcome ?? "Improve fitness");
  return (
    <section className="grid min-w-0 gap-4" aria-label="Plan Draft review">
      {stale ? (
        <ReviewCard title="Changed answers">
          <div role="table" className="border-t border-line" aria-label="Changed answers">
            <AnswerFacts
              summaries={resolvedAnswerSummaries(props.model.answeredSummaries)}
              current
            />
          </div>
        </ReviewCard>
      ) : null}
      <ReviewCard
        eyebrow="Draft inputs"
        aria-label="Draft inputs"
        title={title}
        status={stale ? "Stale" : "Needs review"}
        summary={
          stale
            ? "This Draft preserves the earlier answers and Workouts. Rebuild before activation."
            : "Review the whole Draft before activating."
        }
      >
        <div role="table" className="border-t border-line" aria-label="Draft inputs">
          <Fact
            label={`Main Goal · ${goal?.source.kind === "derived" ? goal.source.label : "your answer"}`}
          >
            {draft.goal.kind === "event"
              ? `${draft.goal.name} · ${formatCivilDate(draft.goal.date)}`
              : title}
          </Fact>
          <Fact label="Calendar">Local review only</Fact>
          <Fact label="Plan span">
            {formatCivilDate(draft.start)} to {formatCivilDate(draft.end)} · {draft.weeks.length}{" "}
            weeks · {draft.spanKind}
          </Fact>
          <AnswerFacts summaries={draft.answeredSummaries} omitGoal />
        </div>
        <details className="mt-row border-t border-line">
          <summary className="cursor-pointer py-inset text-sm font-normal text-ink-2">
            How this Plan was built
          </summary>
          <div role="table" className="border-t border-line" aria-label="How this Plan was built">
            <Fact label="Guidance">Heart rate or perceived effort. No FTP test.</Fact>
            <Fact label="Training approach">Balanced · default</Fact>
            {draft.notes.map((note, index) => (
              <Fact key={`${index}:${note}`} label="Confirmed limits">
                {note}
              </Fact>
            ))}
          </div>
        </details>
      </ReviewCard>
      <ReviewCard
        eyebrow="Training outline"
        title="Every week and Workout"
        status={stale ? "Out of date" : "Draft"}
        summary={`${draft.weeks.length} weeks · ${workouts.length} Workouts · ${workouts.reduce((minutes, workout) => minutes + workout.minutes, 0)} min`}
      >
        {draft.weeks.map((week) => (
          <div key={week.number} className="min-w-0 [&:not(:first-child)]:pt-4">
            <p className="m-0 pb-inset text-xs font-semibold uppercase tracking-wide text-ink-2">
              Week {week.number} · {formatCivilDate(week.start)} to {formatCivilDate(week.end)} ·{" "}
              {week.workouts.reduce((minutes, workout) => minutes + workout.minutes, 0)} min
            </p>
            <div
              role="list"
              className="border-t border-line"
              aria-label={`Week ${week.number} Workouts`}
            >
              {week.workouts.length === 0 ? (
                <p className="m-0 text-sm leading-5 text-ink">No Workouts this week.</p>
              ) : (
                week.workouts.map((workout, index) => (
                  <div
                    key={workout.id}
                    role="listitem"
                    className="grid grid-cols-[minmax(72px,0.6fr)_minmax(0,1.5fr)_auto] items-center gap-inset border-t border-line py-row first:border-t-0 max-md:grid-cols-1 max-md:gap-1 max-md:px-3 max-md:py-inset"
                  >
                    <span className="text-xs leading-4 text-ink-2">
                      {workout.date === null
                        ? `Priority ${index + 1} · Undated`
                        : formatCivilDate(workout.date)}
                    </span>
                    <strong className="text-sm leading-5 font-semibold [overflow-wrap:anywhere]">
                      {workout.name} · {workout.minutes} min · {workout.guidance}
                    </strong>
                    <span className="inline-flex shrink-0 items-center justify-self-start gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2">
                      planned{workout.pinned ? " · Pinned" : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
            {week.notes.map((note, index) => (
              <p key={`${index}:${note}`} className="mt-inset mb-0 text-sm leading-5 text-ink-2">
                {note}
              </p>
            ))}
          </div>
        ))}
        {error === null || confirmationOpen || pending ? null : (
          <p className="m-0 text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-inset">
          <Button
            ref={discardButton}
            variant="destructive"
            className="border-[color-mix(in_srgb,var(--danger)_52%,var(--line))]"
            data-plan-creation-discard={props.model.creationId}
            aria-haspopup="dialog"
            disabled={busy || actions === null}
            onClick={() => actions?.openPlanCreationDiscard()}
          >
            Discard
          </Button>
          <Button
            variant="outline"
            className="border-line bg-surface"
            ref={editButton}
            disabled={busy || actions === null || editingKey !== null}
            onClick={props.onEditAnswers}
          >
            Edit answers
          </Button>
          {stale ? (
            <Button
              disabled={
                busy ||
                actions === null ||
                props.model.readiness !== "ready" ||
                editingKey !== null ||
                pending
              }
              aria-describedby={pending ? commitmentSummaryId(props.model) : undefined}
              onClick={() => actions?.buildPlanCreationDraft()}
            >
              Rebuild Draft
            </Button>
          ) : (
            <Button
              ref={activateButton}
              aria-haspopup="dialog"
              aria-describedby={pending ? commitmentSummaryId(props.model) : undefined}
              disabled={busy || actions === null || workouts.length === 0 || pending}
              onClick={() => actions?.openPlanCreationActivate()}
            >
              Activate Plan
            </Button>
          )}
        </div>
      </ReviewCard>
    </section>
  );
}

export function commitmentSummaryId(model: PlanCreationCardModel): string {
  return `commitment-summary-${model.creationId}`;
}

function commitmentRuleText(rule: PlanCreationCommitmentRule): string {
  const days = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  switch (rule.kind) {
    case "weekday-duration":
      return `${days[rule.day]} · at most ${rule.minutes} min`;
    case "weekday-unavailable":
      return `${days[rule.day]} · unavailable`;
    case "hard-weekday":
      return `${days[rule.day]} · no hard training`;
    case "time-off":
      return `Off ${formatCivilDate(rule.start)} to ${formatCivilDate(rule.end)}`;
  }
}

export function PlanCreationCommitmentCard(props: {
  readonly model: PlanCreationCardModel;
}): ReactElement | null {
  const actions = useEnduragentStore((state) => state.chatActions);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const focusRevision = useEnduragentStore((state) => state.chat.planCreationFocusRevision);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = props.model.pendingCommitment;
  const pendingText = pending?.text ?? null;
  useEffect(() => {
    if (pendingText !== null) heading.current?.focus();
  }, [focusRevision, pendingText]);
  if (pending === null) return null;
  const disabled = busy || actions === null;
  const clarify = pending.status === "clarify";
  const resolve = (): void => {
    void actions?.answerPlanCreation({
      kind: clarify ? "commitments-cancel" : "commitments-confirm",
    });
  };
  return (
    <ReviewCard
      eyebrow="Plan creation · Commitments"
      title={clarify ? "I could not use that answer" : "Did I read this right?"}
      summary={
        clarify
          ? "Tell me again in a different way, with weekdays, time limits, or exact dates."
          : "I understood your note as this limit. Confirm it and your other confirmed limits stay as they are."
      }
      summaryId={commitmentSummaryId(props.model)}
      headingRef={heading}
      headingTabIndex={-1}
    >
      <div role="table" className="border-t border-line" aria-label="Commitments">
        <Fact label="You wrote">{pending.text}</Fact>
        {clarify
          ? null
          : pending.rules.map((rule, index) => (
              <Fact key={index} label="I understood">
                {commitmentRuleText(rule)}
              </Fact>
            ))}
      </div>
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="mt-inset flex flex-wrap gap-inset">
        <Button
          variant="outline"
          className="border-line bg-surface"
          disabled={disabled}
          onClick={clarify ? resolve : () => actions?.editPlanCreation("commitments")}
        >
          {clarify ? "Skip for now" : "Change it"}
        </Button>
        <Button
          disabled={disabled}
          onClick={clarify ? () => actions?.editPlanCreation("commitments") : resolve}
        >
          {clarify ? "Answer" : "Confirm"}
        </Button>
      </div>
    </ReviewCard>
  );
}
