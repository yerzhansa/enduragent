import type { PlanCreationAnswerSummary, PlanHistoryResult } from "@enduragent/coach-contract";
import type { ReactElement, ReactNode } from "react";
import { Button } from "@enduragent/ui";
import { Card, CardContent } from "@enduragent/ui";

const answerLabels: ReadonlyArray<readonly [PlanCreationAnswerSummary["answerKey"], string]> = [
  ["plan-length", "Plan length"],
  ["schedule-mode", "Schedule mode"],
  ["availability", "Availability"],
  ["start-timing", "Start timing"],
  ["commitments", "Commitments"],
  ["baseline", "Recent training"],
  ["success", "Success"],
  ["restriction", "Training restriction"],
];

const cleanupLabels = {
  complete: "Cleanup complete",
  pending: "Calendar cleanup pending",
  failed: "Calendar cleanup pending",
  none: "Final history",
} satisfies Record<NonNullable<PlanHistoryResult>["cleanup"], string>;

function calendarLabel(
  calendar: NonNullable<PlanHistoryResult>["plan"]["calendar"] | undefined,
  cleanup: NonNullable<PlanHistoryResult>["cleanup"],
): string {
  if (calendar === undefined) return cleanupLabels[cleanup];
  switch (calendar.status) {
    case "verified":
      return "Cleanup complete";
    case "failed":
      return calendar.error.endsWith("Retry available.")
        ? "Calendar cleanup failed. Retry available."
        : "Calendar cleanup failed.";
    case "pending":
    case "running":
      return "Calendar cleanup pending";
    case "not-connected":
      return "Calendar cleanup waits for intervals.icu";
  }
}

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

export function PlanFinalDetails(props: {
  readonly history: NonNullable<PlanHistoryResult>;
  readonly notice?: string | null;
  readonly backToLibrary: () => void;
  readonly retryCalendar?: () => Promise<void>;
}): ReactElement {
  const { plan, revision, cleanup } = props.history;
  const draft = revision.snapshot;
  const goal = draft.answeredSummaries.find((answer) => answer.answerKey === "goal");
  const reason =
    plan.closeReason === "completed"
      ? "Completed"
      : plan.closeReason === "stopped"
        ? "Stopped"
        : "Unknown reason";
  return (
    <section aria-label="Final Plan history" className="grid min-w-0 gap-inset">
      {props.notice ? (
        <p role="status" className="m-0 text-sm leading-5 text-ink-2">
          {props.notice}
        </p>
      ) : null}
      <Card size="sm" className="min-w-0" role="region" aria-label="Closed Plan">
        <CardContent className="grid gap-inset">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-inset">
            <div className="grid min-w-0 gap-[calc(var(--inset)/2)]">
              <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
                Closed Plan
              </p>
              <h3 className="m-0 text-base leading-6 font-semibold break-words">{plan.name}</h3>
            </div>
            <span className="rounded-chip bg-ink/7 px-2 py-1 text-xs font-medium text-ink-2">
              Closed
            </span>
          </div>
          <p className="m-0 text-sm leading-5 text-ink-2">
            {dateLabel(plan.start)} to {dateLabel(plan.end)} · {plan.weeks} weeks · {reason}
          </p>
          {draft.goal.kind === "event" && draft.goal.date > draft.end ? (
            <p role="status" className="m-0 text-sm leading-5 text-ink-2">
              Your Event Goal is still {dateLabel(draft.goal.date)}. Start a new Plan for event
              preparation when it is within 24 weeks.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card size="sm" className="min-w-0" role="region" aria-label="Final Plan details">
        <CardContent className="grid gap-inset">
          <h3 className="m-0 text-base leading-6 font-semibold break-words">Final Plan details</h3>
          <div role="table" aria-label="Draft inputs">
            <Fact
              label={`Main Goal · ${goal?.source.kind === "derived" ? goal.source.label : "your answer"}`}
            >
              {draft.goal.kind === "event"
                ? `${draft.goal.name} · ${dateLabel(draft.goal.date)}`
                : (draft.goal.outcome ?? "Improve fitness")}
            </Fact>
            <Fact label="Calendar">{calendarLabel(plan.calendar, cleanup)}</Fact>
            <Fact label="Plan span">
              {dateLabel(draft.start)} to {dateLabel(draft.end)} · {draft.weeks.length} weeks ·{" "}
              {draft.spanKind}
            </Fact>
            {answerLabels.map(([key, label]) => {
              const summary = draft.answeredSummaries.find((answer) => answer.answerKey === key);
              if (summary === undefined) return null;
              const source =
                summary.source.kind === "athlete" ? "your answer" : summary.source.label;
              return (
                <Fact key={key} label={`${label} · ${source}`}>
                  {summary.detail}
                </Fact>
              );
            })}
          </div>
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
                        {workout.date === null && !workout.pinned ? "Not chosen" : "planned"}
                        {workout.pinned ? " · Pinned" : ""}
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
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-inset">
        {plan.calendar?.status === "failed" && plan.calendar.error.endsWith("Retry available.") ? (
          <Button
            variant="outline"
            disabled={props.retryCalendar === undefined}
            onClick={() => void props.retryCalendar?.()}
          >
            Retry calendar
          </Button>
        ) : null}
        <Button variant="outline" onClick={props.backToLibrary}>
          Back to library
        </Button>
      </div>
    </section>
  );
}
