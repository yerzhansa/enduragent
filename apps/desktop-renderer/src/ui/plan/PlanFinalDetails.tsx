import type { PlanCreationAnswerSummary, PlanHistoryResult } from "@enduragent/coach-contract";
import type { ReactElement, ReactNode } from "react";
import { Button } from "@enduragent/ui";
import { Card, CardContent, CardHeader } from "@enduragent/ui";

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
      className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-3 border-b border-line py-[calc(var(--row-inset)+1px)] max-md:grid-cols-1 max-md:gap-1"
    >
      <span role="rowheader" className="text-xs leading-4 text-ink-2">
        {props.label}
      </span>
      <strong
        role="cell"
        className="text-right text-sm leading-5 font-medium [overflow-wrap:anywhere] max-md:text-left"
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
    <section aria-label="Final Plan history" className="grid min-w-0 gap-4">
      {props.notice ? (
        <p role="status" className="m-0 text-sm leading-5 text-ink-2">
          {props.notice}
        </p>
      ) : null}
      <Card
        size="sm"
        className="block min-w-0 gap-[normal] py-0"
        role="region"
        aria-label="Closed Plan"
      >
        <CardHeader className="block rounded-none p-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="min-w-0 justify-self-start">
              <p className="mt-0 mb-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
                Closed Plan
              </p>
              <h3 className="m-0 text-base leading-6 font-semibold break-words">{plan.name}</h3>
            </div>
            <span className="inline-flex shrink-0 items-center justify-self-start gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2">
              Closed
            </span>
          </div>
          <p className="mt-inset mb-0 text-sm leading-5 text-ink-2">
            {dateLabel(plan.start)} to {dateLabel(plan.end)} · {plan.weeks} weeks · {reason}
          </p>
          {draft.goal.kind === "event" && draft.goal.date > draft.end ? (
            <p role="status" className="m-0 text-sm leading-5 text-ink-2">
              Your Event Goal is still {dateLabel(draft.goal.date)}. Start a new Plan for event
              preparation when it is within 24 weeks.
            </p>
          ) : null}
        </CardHeader>
      </Card>
      <Card
        size="sm"
        className="block min-w-0 gap-[normal] py-0"
        role="region"
        aria-label="Final Plan details"
      >
        <CardHeader className="block rounded-none p-4">
          <h3 className="m-0 text-base leading-6 font-semibold break-words">Final Plan details</h3>
        </CardHeader>
        <CardContent className="px-4 pt-0 pb-4">
          <div role="table" aria-label="Draft inputs" className="border-t border-line">
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
            <div key={week.number} className="min-w-0">
              <p className="m-0 pt-4 pb-inset text-xs font-semibold uppercase tracking-wide text-ink-2">
                Week {week.number} · {dateLabel(week.start)} to {dateLabel(week.end)} ·{" "}
                {week.workouts.reduce((minutes, workout) => minutes + workout.minutes, 0)} min
              </p>
              <div
                role="list"
                aria-label={`Week ${week.number} Workouts`}
                className="border-t border-line"
              >
                {week.workouts.length === 0 ? (
                  <p className="m-0 text-sm leading-5 text-ink-2">No Workouts this week.</p>
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
                          : dateLabel(workout.date)}
                      </span>
                      <strong className="text-sm leading-5 font-semibold [overflow-wrap:anywhere]">
                        {workout.name} · {workout.minutes} min · {workout.guidance}
                      </strong>
                      <span className="inline-flex shrink-0 items-center justify-self-start gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2">
                        {workout.date === null && !workout.pinned ? "Not chosen" : "planned"}
                        {workout.pinned ? " · Pinned" : ""}
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
        <Button variant="outline" className="border-line bg-surface" onClick={props.backToLibrary}>
          Back to library
        </Button>
      </div>
    </section>
  );
}
