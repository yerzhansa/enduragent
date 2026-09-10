import { usePhrasebook } from "@enduragent/i18n/react";
import type { CatalogKey } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { usePlanDate } from "./plan-date";
import type { PlanCreationAnswerSummary, PlanHistoryResult } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { Card, CardContent, CardHeader } from "@enduragent/ui";
import { Fact, PlanCard } from "./plan-card";
const answerLabels: ReadonlyArray<readonly [PlanCreationAnswerSummary["answerKey"], CatalogKey]> = [
  ["plan-length", "chat.planCreation.lengthLabel"],
  ["schedule-mode", "chat.planCreation.modeLabel"],
  ["availability", "chat.planCreation.availabilityLabel"],
  ["start-timing", "chat.planCreation.startLabel"],
  ["commitments", "chat.planCreation.commitmentsLabelShort"],
  ["baseline", "chat.planCreation.baselineLabel"],
  ["success", "chat.planCreation.successLabelShort"],
  ["restriction", "chat.planCreation.restrictionLabel"],
];
const spanKinds = {
  "Short block": "chat.planCreation.spanKind.shortBlock",
  "Event preparation": "chat.planCreation.spanKind.eventPreparation",
  "Base Plan": "chat.planCreation.spanKind.basePlan",
  "Fitness Plan": "chat.planCreation.spanKind.fitnessPlan",
} satisfies Record<NonNullable<PlanHistoryResult>["revision"]["snapshot"]["spanKind"], CatalogKey>;

const cleanupLabels = {
  complete: "plan.details.calendar.complete",
  pending: "plan.details.calendar.pending",
  failed: "plan.details.calendar.pending",
  none: "plan.details.labels.finalHistory",
} satisfies Record<NonNullable<PlanHistoryResult>["cleanup"], CatalogKey>;
function calendarLabel(
  phrasebook: Phrasebook,
  calendar: NonNullable<PlanHistoryResult>["plan"]["calendar"] | undefined,
  cleanup: NonNullable<PlanHistoryResult>["cleanup"],
): string {
  const { say } = phrasebook;

  if (calendar === undefined) return say(cleanupLabels[cleanup]);
  switch (calendar.status) {
    case "verified":
      return say("plan.details.calendar.complete");
    case "failed":
      return calendar.error.endsWith("Retry available.")
        ? say("plan.details.calendar.retryAvailable")
        : say("plan.details.calendar.failed");
    case "pending":
    case "running":
      return say("plan.details.calendar.pending");
    case "not-connected":
      return say("plan.details.calendar.connectionRequired", { intervals: "intervals.icu" });
  }
}
export function PlanFinalDetails(props: {
  readonly history: NonNullable<PlanHistoryResult>;
  readonly notice?: string | null;
  readonly backToLibrary: () => void;
  readonly retryCalendar?: () => Promise<void>;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
  const { plan, revision, cleanup } = props.history;
  const draft = revision.snapshot;
  const goal = draft.answeredSummaries.find((answer) => answer.answerKey === "goal");
  const reason =
    plan.closeReason === "completed"
      ? say("plan.details.planFinalDetails.completed")
      : plan.closeReason === "stopped"
        ? say("plan.details.planFinalDetails.stopped")
        : say("plan.details.planFinalDetails.unknownReason");
  return (
    <section
      aria-label={say("plan.details.planFinalDetails.historyLabel")}
      className="grid min-w-0 gap-4"
    >
      {props.notice ? (
        <p role="status" className="m-0 text-sm leading-5 text-ink-2">
          {props.notice}
        </p>
      ) : null}
      <PlanCard
        eyebrow={say("plan.details.planFinalDetails.closedPlan")}
        title={plan.name}
        status={say("plan.details.planFinalDetails.closed")}
        aria-label={say("plan.details.planFinalDetails.closedPlan")}
        parityAttributes={false}
        summary={say("plan.details.planFinalDetails.closedSummary", {
          value1: planDate(plan.start),
          value2: planDate(plan.end),
          value3: format.number(plan.weeks, { useGrouping: false }),
          reason: reason,
        })}
        headerChildren={
          draft.goal.kind === "event" && draft.goal.date > draft.end ? (
            <p role="status" className="m-0 text-sm leading-5 text-ink-2">
              {say("plan.details.planFinalDetails.distantEventDescription", {
                value1: planDate(draft.goal.date),
              })}
            </p>
          ) : null
        }
      />
      <Card
        size="sm"
        className="block min-w-0 gap-[normal] py-0"
        role="region"
        aria-label={say("plan.details.planFinalDetails.title")}
      >
        <CardHeader className="block rounded-none p-4">
          <h3 className="m-0 text-base leading-6 font-semibold break-words">
            {say("plan.details.planFinalDetails.title")}
          </h3>
        </CardHeader>
        <CardContent className="px-4 pt-0 pb-4">
          <div
            role="table"
            aria-label={say("chat.planCreation.draftInputs")}
            className="border-t border-line"
          >
            <Fact
              label={say("plan.details.planFinalDetails.goalSource", {
                value1:
                  goal?.source.kind === "derived"
                    ? goal.source.label
                    : say("chat.planCreation.yourAnswer"),
              })}
            >
              {draft.goal.kind === "event"
                ? `${draft.goal.name} · ${planDate(draft.goal.date)}`
                : (draft.goal.outcome ?? say("chat.planCreation.improveFitness"))}
            </Fact>
            <Fact label={say("chat.planCreation.calendarLabel")}>
              {calendarLabel(phrasebook, plan.calendar, cleanup)}
            </Fact>
            <Fact label={say("chat.planCreation.spanLabel")}>
              {say("plan.details.planFinalDetails.spanSummary", {
                value1: planDate(draft.start),
                value2: planDate(draft.end),
                value3: format.number(draft.weeks.length, { useGrouping: false }),
                value4: say(spanKinds[draft.spanKind]),
              })}
            </Fact>
            {answerLabels.map(([key, label]) => {
              const summary = draft.answeredSummaries.find((answer) => answer.answerKey === key);
              if (summary === undefined) return null;
              const source =
                summary.source.kind === "athlete"
                  ? say("chat.planCreation.yourAnswer")
                  : summary.source.label;
              return (
                <Fact key={key} label={`${say(label)} · ${source}`}>
                  {summary.detail}
                </Fact>
              );
            })}
          </div>
          {draft.weeks.map((week) => (
            <div key={week.number} className="min-w-0">
              <p className="m-0 pt-4 pb-inset text-xs font-semibold uppercase tracking-wide text-ink-2">
                {say("chat.planCreation.weekSummary", {
                  week: format.number(week.number, { useGrouping: false }),
                  start: planDate(week.start),
                  end: planDate(week.end),
                  minutes: format.number(
                    week.workouts.reduce((minutes, workout) => minutes + workout.minutes, 0),
                    { useGrouping: false },
                  ),
                })}
              </p>
              <div
                role="list"
                aria-label={say("chat.planCreation.weekWorkouts", {
                  week: format.number(week.number, { useGrouping: false }),
                })}
                className="border-t border-line"
              >
                {week.workouts.length === 0 ? (
                  <p className="m-0 text-sm leading-5 text-ink-2">
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
                          : planDate(workout.date)}
                      </span>
                      <strong className="text-sm leading-5 font-semibold [overflow-wrap:anywhere]">
                        {say("chat.planCreation.workoutSummary", {
                          name: workout.name,
                          minutes: format.number(workout.minutes, { useGrouping: false }),
                          guidance: workout.guidance,
                        })}
                      </strong>
                      <span className="inline-flex shrink-0 items-center justify-self-start gap-[calc(var(--row-inset)/2)] rounded-full bg-sunk px-2 py-0.75 text-xs font-normal whitespace-nowrap text-ink-2">
                        {workout.date === null && !workout.pinned
                          ? say("plan.details.planFinalDetails.notChosen")
                          : say("chat.planCreation.planned")}
                        {workout.pinned ? say("plan.details.planFinalDetails.pinned") : ""}
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
            {say("plan.details.planFinalDetails.retryCalendar")}
          </Button>
        ) : null}
        <Button variant="outline" className="border-line bg-surface" onClick={props.backToLibrary}>
          {say("plan.details.planFinalDetails.backToLibrary")}
        </Button>
      </div>
    </section>
  );
}
