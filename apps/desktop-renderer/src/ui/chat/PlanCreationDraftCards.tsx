import type {
  PlanCreationAnswerSummary,
  PlanCreationCardModel,
  PlanCreationDraft,
  PlanCreationCommitmentRule,
} from "@enduragent/coach-contract";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Button } from "@enduragent/ui";
import { Card, CardContent } from "@enduragent/ui";
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

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function Fact(props: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(104px,0.72fr)_minmax(0,1.28fr)] gap-4 border-t border-line py-3 first:border-t-0 max-[560px]:grid-cols-1 max-[560px]:gap-1"
    >
      <span role="rowheader" className="text-xs leading-4 text-ink-2">
        {props.label}
      </span>
      <strong
        role="cell"
        className="text-right text-sm leading-5 font-semibold [overflow-wrap:anywhere] max-[560px]:text-left"
      >
        {props.children}
      </strong>
    </div>
  );
}

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

function ReviewCard(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly status?: string;
  readonly summary?: string;
  readonly summaryId?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Card
      size="sm"
      className="min-w-0"
      role="region"
      aria-label={props.eyebrow === "Draft inputs" ? "Draft inputs" : props.title}
    >
      <CardContent className="grid gap-inset">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-inset">
          <div className="grid gap-[calc(var(--inset)/2)] min-w-0">
            {props.eyebrow ? (
              <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
                {props.eyebrow}
              </p>
            ) : null}
            <h3 className="m-0 text-base leading-6 font-semibold break-words">{props.title}</h3>
          </div>
          {props.status ? (
            <span className="rounded-chip bg-ink/7 px-2 py-1 text-xs font-medium text-ink-2">
              {props.status}
            </span>
          ) : null}
        </div>
        {props.summary ? (
          <p id={props.summaryId} className="m-0 text-sm leading-5 text-ink-2">
            {props.summary}
          </p>
        ) : null}
        {props.children}
      </CardContent>
    </Card>
  );
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
  const pending = props.model.pendingCommitment !== null;
  const workouts = draft.weeks.flatMap((week) => week.workouts);
  const goal = draft.answeredSummaries.find((answer) => answer.answerKey === "goal");
  const title =
    draft.goal.kind === "event" ? draft.goal.name : (draft.goal.outcome ?? "Improve fitness");
  return (
    <section className="grid min-w-0 gap-inset" aria-label="Plan Draft review">
      {stale ? (
        <ReviewCard title="Changed answers">
          <div role="table" aria-label="Changed answers">
            <AnswerFacts summaries={props.model.answeredSummaries} current />
          </div>
        </ReviewCard>
      ) : null}
      <ReviewCard
        eyebrow="Draft inputs"
        title={title}
        status={stale ? "Stale" : "Needs review"}
        summary={
          stale
            ? "This Draft preserves the earlier answers and Workouts. Rebuild before activation."
            : "Review the whole Draft before activating."
        }
      >
        <div role="table" aria-label="Draft inputs">
          <Fact
            label={`Main Goal · ${goal?.source.kind === "derived" ? goal.source.label : "your answer"}`}
          >
            {draft.goal.kind === "event"
              ? `${draft.goal.name} · ${dateLabel(draft.goal.date)}`
              : title}
          </Fact>
          <Fact label="Calendar">Local review only</Fact>
          <Fact label="Plan span">
            {dateLabel(draft.start)} to {dateLabel(draft.end)} · {draft.weeks.length} weeks ·{" "}
            {draft.spanKind}
          </Fact>
          <AnswerFacts summaries={draft.answeredSummaries} omitGoal />
        </div>
        <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium">How this Plan was built</summary>
          <div role="table" aria-label="How this Plan was built">
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
          <div key={week.number} className="grid min-w-0 gap-inset">
            <p className="m-0 text-xs font-semibold text-ink-2">
              Week {week.number} · {dateLabel(week.start)} to {dateLabel(week.end)} ·{" "}
              {week.workouts.reduce((minutes, workout) => minutes + workout.minutes, 0)} min
            </p>
            <div role="list" aria-label={`Week ${week.number} Workouts`}>
              {week.workouts.length === 0 ? (
                <p className="m-0 text-sm leading-5 text-ink-2">No Workouts this week.</p>
              ) : (
                week.workouts.map((workout, index) => (
                  <div
                    key={workout.id}
                    role="listitem"
                    className="grid grid-cols-[minmax(0,0.6fr)_minmax(0,1.4fr)_auto] items-start gap-3 border-t border-line py-3 first:border-t-0 max-[560px]:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <span className="text-xs leading-4 text-ink-2 max-[560px]:col-span-2">
                      {workout.date === null
                        ? `Priority ${index + 1} · Undated`
                        : dateLabel(workout.date)}
                    </span>
                    <strong className="text-sm leading-5 font-medium [overflow-wrap:anywhere]">
                      {workout.name} · {workout.minutes} min · {workout.guidance}
                    </strong>
                    <span className="rounded-chip bg-ink/7 px-2 py-1 text-xs font-medium text-ink-2">
                      planned{workout.pinned ? " · Pinned" : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
            {week.notes.map((note, index) => (
              <p key={`${index}:${note}`} className="m-0 text-sm leading-5 text-ink-2">
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
        <div className="mt-inset flex flex-wrap gap-inset">
          <Button
            ref={discardButton}
            variant="destructive"
            data-plan-creation-discard={props.model.creationId}
            aria-haspopup="dialog"
            disabled={busy || actions === null}
            onClick={() => actions?.openPlanCreationDiscard()}
          >
            Discard
          </Button>
          <Button
            variant="outline"
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

export const pendingCommitmentSummary =
  "Your last confirmed limits remain effective. Draft building and activation wait for this correction.";

export function commitmentSummaryId(model: PlanCreationCardModel): string {
  return `commitment-summary-${model.creationId}`;
}

function commitmentDateLabel(value: string): string {
  const [year, month, day] = value.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
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
      return `Off ${commitmentDateLabel(rule.start)} to ${commitmentDateLabel(rule.end)}`;
  }
}

export function PlanCreationCommitmentCard(props: {
  readonly model: PlanCreationCardModel;
}): ReactElement | null {
  const actions = useEnduragentStore((state) => state.chatActions);
  const error = useEnduragentStore((state) => state.chat.planCreationError);
  const busy = useEnduragentStore((state) => state.chat.planCreationBusy);
  const editingKey = useEnduragentStore((state) => state.chat.planCreationEditingKey);
  const pending = props.model.pendingCommitment;
  if (pending === null) return null;
  const disabled = busy || actions === null;
  return (
    <ReviewCard
      eyebrow="Schedule correction"
      title={pending.status === "clarify" ? "Clarify your commitment" : "Confirm these limits"}
      status="Not yet confirmed"
      summary={pendingCommitmentSummary}
      summaryId={commitmentSummaryId(props.model)}
    >
      <div role="table" aria-label="Schedule correction">
        <Fact label="Submitted">{pending.text}</Fact>
        {pending.rules.map((rule, index) => (
          <Fact key={index} label="Interpreted limit">
            {commitmentRuleText(rule)}
          </Fact>
        ))}
        {pending.unparsed.length === 0 ? null : (
          <Fact label="Not understood">
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
          {error}
        </p>
      )}
      <div className="mt-inset flex flex-wrap gap-inset">
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => actions?.answerPlanCreation({ kind: "commitments-cancel" })}
        >
          Cancel correction
        </Button>
        <Button
          variant="outline"
          disabled={disabled || editingKey !== null}
          onClick={() => actions?.editPlanCreation("commitments")}
        >
          Clarify
        </Button>
        {pending.status === "confirm" ? (
          <Button
            disabled={disabled}
            onClick={() => actions?.answerPlanCreation({ kind: "commitments-confirm" })}
          >
            Confirm limits
          </Button>
        ) : null}
      </div>
    </ReviewCard>
  );
}
