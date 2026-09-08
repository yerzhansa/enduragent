import { formatCivilDate } from "../../lib/date";
import type { PlanCreationAnswerSummary, PlanHistoryResult } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { Card, CardContent, CardHeader } from "@enduragent/ui";
import { Fact, PlanCard } from "./plan-card";

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
      <PlanCard
        eyebrow="Closed Plan"
        title={plan.name}
        status="Closed"
        aria-label="Closed Plan"
        parityAttributes={false}
        summary={`${formatCivilDate(plan.start)} to ${formatCivilDate(plan.end)} · ${plan.weeks} weeks · ${reason}`}
        headerChildren={
          draft.goal.kind === "event" && draft.goal.date > draft.end ? (
            <p role="status" className="m-0 text-sm leading-5 text-ink-2">
              Your Event Goal is still {formatCivilDate(draft.goal.date)}. Start a new Plan for
              event preparation when it is within 24 weeks.
            </p>
          ) : null
        }
      />
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
                ? `${draft.goal.name} · ${formatCivilDate(draft.goal.date)}`
                : (draft.goal.outcome ?? "Improve fitness")}
            </Fact>
            <Fact label="Calendar">{calendarLabel(plan.calendar, cleanup)}</Fact>
            <Fact label="Plan span">
              {formatCivilDate(draft.start)} to {formatCivilDate(draft.end)} · {draft.weeks.length}{" "}
              weeks · {draft.spanKind}
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
                Week {week.number} · {formatCivilDate(week.start)} to {formatCivilDate(week.end)} ·{" "}
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
                          : formatCivilDate(workout.date)}
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
