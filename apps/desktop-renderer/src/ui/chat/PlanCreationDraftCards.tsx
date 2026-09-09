import { chatFeedbackMessage } from "./copy";
import { msg, type CatalogKey } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
import { useChatDate } from "./use-chat-date";
import type {
  PlanCreationAnswerSummary,
  PlanCreationCardModel,
  PlanCreationDraft,
  PlanCreationCommitmentRule,
} from "@enduragent/coach-contract";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Button } from "@enduragent/ui";
import { Fact, PlanCard } from "../plan/plan-card";
import { useEnduragentStore } from "../../state/store";

const spanLabels: Record<PlanCreationDraft["spanKind"], CatalogKey> = {
  "Short block": "chat.planCreation.spanKind.shortBlock",
  "Event preparation": "chat.planCreation.spanKind.eventPreparation",
  "Base Plan": "chat.planCreation.spanKind.basePlan",
  "Fitness Plan": "chat.planCreation.spanKind.fitnessPlan",
};

const answerLabels: ReadonlyArray<readonly [PlanCreationAnswerSummary["answerKey"], CatalogKey]> = [
  ["goal", "chat.planCreation.goalLabel"],
  ["plan-length", "chat.planCreation.lengthLabel"],
  ["schedule-mode", "chat.planCreation.modeLabel"],
  ["availability", "chat.planCreation.availabilityLabel"],
  ["start-timing", "chat.planCreation.startLabel"],
  ["commitments", "chat.planCreation.commitmentsLabelShort"],
  ["baseline", "chat.planCreation.baselineLabel"],
  ["success", "chat.planCreation.successLabelShort"],
  ["restriction", "chat.planCreation.restrictionLabel"],
];

function AnswerFacts(props: {
  readonly summaries: readonly PlanCreationAnswerSummary[];
  readonly current?: boolean;
  readonly omitGoal?: boolean;
}): ReactElement {
  const { say } = usePhrasebook();
  return (
    <>
      {answerLabels.map(([key, label]) => {
        const summary = props.summaries.find((answer) => answer.answerKey === key);
        if (summary === undefined || (props.omitGoal && key === "goal")) return null;
        const source = props.current
          ? say("chat.planCreation.currentAnswer")
          : summary.source.kind === "athlete"
            ? say("chat.planCreation.yourAnswer")
            : summary.source.label;
        return (
          <Fact
            key={key}
            label={say("chat.planCreation.answerSource", { title: say(label), source })}
          >
            {summary.detail}
          </Fact>
        );
      })}
    </>
  );
}

function ReviewCard(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly status?: string;
  readonly summary?: string;
  readonly summaryId?: string;
  readonly "aria-label"?: string;
  readonly children: ReactNode;
}): ReactElement {
  return <PlanCard {...props} aria-label={props["aria-label"] ?? props.title} />;
}

export function PlanCreationDraftCards(props: {
  readonly model: PlanCreationCardModel;
  readonly draft: PlanCreationDraft;
  readonly onEditAnswers: () => void;
}): ReactElement {
  const { say, format } = usePhrasebook();
  const formatDate = useChatDate();
  const actions = useEnduragentStore((state) => state.chatActions);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const errorMessage = error === null ? null : chatFeedbackMessage(error);
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
  const pending = props.model.pendingCommitment !== null;
  const workouts = draft.weeks.flatMap((week) => week.workouts);
  const goal = draft.answeredSummaries.find((answer) => answer.answerKey === "goal");
  const title =
    draft.goal.kind === "event"
      ? draft.goal.name
      : (draft.goal.outcome ?? say("chat.planCreation.improveFitness"));
  return (
    <section className="grid min-w-0 gap-4" aria-label={say("chat.planCreation.draftReview")}>
      {stale ? (
        <ReviewCard title={say("chat.planCreation.changedAnswers")}>
          <div
            role="table"
            className="border-t border-line"
            aria-label={say("chat.planCreation.changedAnswers")}
          >
            <AnswerFacts summaries={props.model.answeredSummaries} current />
          </div>
        </ReviewCard>
      ) : null}
      <ReviewCard
        eyebrow={say("chat.planCreation.draftInputs")}
        aria-label={say("chat.planCreation.draftInputs")}
        title={title}
        status={stale ? say("chat.planCreation.stale") : say("chat.planCreation.needsReview")}
        summary={
          stale ? say("chat.planCreation.staleDetail") : say("chat.planCreation.reviewDetail")
        }
      >
        <div
          role="table"
          className="border-t border-line"
          aria-label={say("chat.planCreation.draftInputs")}
        >
          <Fact
            label={say("chat.planCreation.answerSource", {
              title: say("chat.planCreation.goalLabel"),
              source:
                goal?.source.kind === "derived"
                  ? goal.source.label
                  : say("chat.planCreation.yourAnswer"),
            })}
          >
            {draft.goal.kind === "event"
              ? say("chat.planCreation.eventDate", {
                  name: draft.goal.name,
                  date: formatDate(draft.goal.date),
                })
              : title}
          </Fact>
          <Fact label={say("chat.planCreation.calendarLabel")}>
            {say("chat.planCreation.localReview")}
          </Fact>
          <Fact label={say("chat.planCreation.spanLabel")}>
            {say(
              draft.weeks.length === 1
                ? "chat.planCreation.span_one"
                : "chat.planCreation.span_other",
              {
                count: draft.weeks.length,
                start: formatDate(draft.start),
                end: formatDate(draft.end),
                weeks: format.number(draft.weeks.length, { useGrouping: false }),
                kind: say(spanLabels[draft.spanKind]),
              },
            )}
          </Fact>
          <AnswerFacts summaries={draft.answeredSummaries} omitGoal />
        </div>
        <details className="mt-row border-t border-line">
          <summary className="cursor-pointer py-inset text-sm font-normal text-ink-2">
            {say("chat.planCreation.builtTitle")}
          </summary>
          <div
            role="table"
            className="border-t border-line"
            aria-label={say("chat.planCreation.builtTitle")}
          >
            <Fact label={say("chat.planCreation.guidanceLabel")}>
              {say("chat.planCreation.guidance")}
            </Fact>
            <Fact label={say("chat.planCreation.approachLabel")}>
              {say("chat.planCreation.approach")}
            </Fact>
            {draft.notes.map((note, index) => (
              <Fact key={`${index}:${note}`} label={say("chat.planCreation.limitsLabel")}>
                {note}
              </Fact>
            ))}
          </div>
        </details>
      </ReviewCard>
      <ReviewCard
        eyebrow={say("chat.planCreation.outlineLabel")}
        title={say("chat.planCreation.outlineTitle")}
        status={stale ? say("chat.planCreation.outOfDate") : say("chat.planCreation.draft")}
        summary={say(
          workouts.length === 1
            ? "chat.planCreation.outlineSummary_one"
            : "chat.planCreation.outlineSummary_other",
          {
            count: workouts.length,
            weeks: format.number(draft.weeks.length, { useGrouping: false }),
            workouts: format.number(workouts.length, { useGrouping: false }),
            minutes: format.number(
              workouts.reduce((minutes, workout) => minutes + workout.minutes, 0),
              { useGrouping: false },
            ),
          },
        )}
      >
        {draft.weeks.map((week) => (
          <div key={week.number} className="min-w-0 [&:not(:first-child)]:pt-4">
            <p className="m-0 pb-inset text-xs font-semibold uppercase tracking-wide text-ink-2">
              {say("chat.planCreation.weekSummary", {
                week: format.number(week.number, { useGrouping: false }),
                start: formatDate(week.start),
                end: formatDate(week.end),
                minutes: format.number(
                  week.workouts.reduce((minutes, workout) => minutes + workout.minutes, 0),
                  { useGrouping: false },
                ),
              })}
            </p>
            <div
              role="list"
              className="border-t border-line"
              aria-label={say("chat.planCreation.weekWorkouts", {
                week: format.number(week.number, { useGrouping: false }),
              })}
            >
              {week.workouts.length === 0 ? (
                <p className="m-0 text-sm leading-5 text-ink">
                  {say("chat.planCreation.noWorkouts")}
                </p>
              ) : (
                week.workouts.map((workout, index) => (
                  <div
                    key={workout.id}
                    role="listitem"
                    className="grid grid-cols-[minmax(72px,0.6fr)_minmax(0,1.5fr)_auto] items-center gap-inset border-t border-line py-row first:border-t-0 max-md:grid-cols-1 max-md:gap-1 max-md:px-3 max-md:py-inset"
                  >
                    <span className="text-xs leading-4 text-ink-2">
                      {workout.date === null
                        ? say("chat.planCreation.undatedPriority", {
                            priority: format.number(index + 1, { useGrouping: false }),
                          })
                        : formatDate(workout.date)}
                    </span>
                    <strong className="text-sm leading-5 font-semibold [overflow-wrap:anywhere]">
                      {say("chat.planCreation.workoutSummary", {
                        name: workout.name,
                        minutes: format.number(workout.minutes, { useGrouping: false }),
                        guidance: workout.guidance,
                      })}
                    </strong>
                    <span className="inline-flex shrink-0 items-center justify-self-start gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2">
                      {workout.pinned
                        ? say("chat.planCreation.plannedPinned")
                        : say("chat.planCreation.planned")}
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
            {errorMessage === null ? error : say(errorMessage)}
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
            {say("chat.planCreation.discard")}
          </Button>
          <Button
            variant="outline"
            className="border-line bg-surface"
            ref={editButton}
            disabled={busy || actions === null || editingKey !== null}
            onClick={props.onEditAnswers}
          >
            {say("chat.planCreation.editAnswers")}
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
              {say("chat.planCreation.rebuildDraft")}
            </Button>
          ) : (
            <Button
              ref={activateButton}
              aria-haspopup="dialog"
              aria-describedby={pending ? commitmentSummaryId(props.model) : undefined}
              disabled={busy || actions === null || workouts.length === 0 || pending}
              onClick={() => actions?.openPlanCreationActivate()}
            >
              {say("chat.planCreation.activate")}
            </Button>
          )}
        </div>
      </ReviewCard>
    </section>
  );
}

export const pendingCommitmentSummary = msg("chat.planCreation.pendingCommitment");

export function commitmentSummaryId(model: PlanCreationCardModel): string {
  return `commitment-summary-${model.creationId}`;
}

function CommitmentRuleText({ rule }: { readonly rule: PlanCreationCommitmentRule }): ReactElement {
  const { say, format } = usePhrasebook();
  const formatDate = useChatDate();
  const day =
    rule.kind === "time-off"
      ? ""
      : format.date(new Date(Date.UTC(1998, 0, 4 + rule.day)), {
          weekday: "short",
          timeZone: "UTC",
        });
  switch (rule.kind) {
    case "weekday-duration":
      return (
        <>
          {say("chat.planCreation.weekdayDuration", {
            day,
            minutes: format.number(rule.minutes, { useGrouping: false }),
          })}
        </>
      );
    case "weekday-unavailable":
      return <>{say("chat.planCreation.weekdayUnavailable", { day })}</>;
    case "hard-weekday":
      return <>{say("chat.planCreation.weekdayNoHardTraining", { day })}</>;
    case "time-off":
      return (
        <>
          {say("chat.planCreation.timeOff", {
            start: formatDate(rule.start),
            end: formatDate(rule.end),
          })}
        </>
      );
  }
}

export function PlanCreationCommitmentCard(props: {
  readonly model: PlanCreationCardModel;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const actions = useEnduragentStore((state) => state.chatActions);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const errorMessage = error === null ? null : chatFeedbackMessage(error);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const pending = props.model.pendingCommitment;
  if (pending === null) return null;
  const disabled = busy || actions === null;
  return (
    <ReviewCard
      eyebrow={say("chat.planCreation.correctionLabel")}
      title={
        pending.status === "clarify"
          ? say("chat.planCreation.clarifyTitle")
          : say("chat.planCreation.confirmTitle")
      }
      status={say("chat.planCreation.notConfirmed")}
      summary={say(pendingCommitmentSummary)}
      summaryId={commitmentSummaryId(props.model)}
    >
      <div
        role="table"
        className="border-t border-line"
        aria-label={say("chat.planCreation.correctionLabel")}
      >
        <Fact label={say("chat.planCreation.submittedLabel")}>{pending.text}</Fact>
        {pending.rules.map((rule, index) => (
          <Fact key={index} label={say("chat.planCreation.interpretedLabel")}>
            <CommitmentRuleText rule={rule} />
          </Fact>
        ))}
        {pending.unparsed.length === 0 ? null : (
          <Fact label={say("chat.planCreation.notUnderstood")}>
            <ul className="m-0 grid list-none gap-1 p-0">
              {pending.unparsed.map((fragment, index) => (
                <li key={index}>{fragment}</li>
              ))}
            </ul>
          </Fact>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {errorMessage === null ? error : say(errorMessage)}
        </p>
      )}
      <div className="mt-inset flex flex-wrap gap-inset">
        <Button
          variant="outline"
          className="border-line bg-surface"
          disabled={disabled}
          onClick={() => actions?.answerPlanCreation({ kind: "commitments-cancel" })}
        >
          {say("chat.planCreation.cancelCorrection")}
        </Button>
        <Button
          variant="outline"
          className="border-line bg-surface"
          disabled={disabled || editingKey !== null}
          onClick={() => actions?.editPlanCreation("commitments")}
        >
          {say("chat.planCreation.clarify")}
        </Button>
        {pending.status === "confirm" ? (
          <Button
            disabled={disabled}
            onClick={() => actions?.answerPlanCreation({ kind: "commitments-confirm" })}
          >
            {say("chat.planCreation.confirmLimits")}
          </Button>
        ) : null}
      </div>
    </ReviewCard>
  );
}
