import type {
  PlanCalendarActivity,
  PlanCalendarWeek,
  PlanCalendarWeekStatus,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { cn } from "@enduragent/ui";
import type { ReactElement } from "react";
import { weekdayOrder, type FirstDayOfWeek } from "../../calendar/dates";
import {
  rowLabel,
  weekTiming,
  type CalendarDay,
  type CalendarTiming,
  type CalendarRow,
  type CalendarRowLabel,
  type PlanCalendarRead,
} from "../../calendar/grid";
import { useCalendarText, type CalendarText } from "./calendar-text";

type Tone = "ok" | "warn" | "danger" | "brand" | "muted";

interface WorkoutLook {
  readonly frame: "sent" | "plan-only" | "missed" | "ask" | "changed" | "ghost";
  readonly detail: string | null;
  readonly status: { readonly tone: Tone; readonly text: string } | null;
}

const FRAME: Record<WorkoutLook["frame"], string> = {
  sent: "border border-line bg-surface",
  "plan-only": "border border-dashed border-line-2 bg-transparent",
  missed: "border border-danger bg-danger/10 outline-2 outline-offset-1 outline-danger",
  ask: "border border-dashed border-brand bg-surface",
  changed: "border border-warn bg-warn/10 outline-2 outline-offset-1 outline-warn",
  ghost: "border border-dashed border-line-2 bg-transparent text-ink-2",
};

const TONE: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  brand: "text-brand",
  muted: "text-ink-2",
};

function activityDuration(
  activities: readonly PlanCalendarActivity[],
  activityId: string,
): number | null {
  return activities.find((activity) => activity.activityId === activityId)?.durationS ?? null;
}

type Say = ReturnType<typeof usePhrasebook>["say"];

function changedLook(
  workout: PlanCalendarWorkout,
  planned: string | null,
  say: Say,
  text: CalendarText,
): WorkoutLook | null {
  const copy = workout.copy;
  if (copy.kind !== "changed-in-intervals") return null;
  if (copy.change === "deleted") {
    return {
      frame: "ghost",
      detail: planned,
      status: { tone: "warn", text: say("plan.calendar.copy.deleted") },
    };
  }
  return {
    frame: "changed",
    detail: planned,
    status: {
      tone: "warn",
      text:
        copy.change === "moved" && copy.toDateKey !== null
          ? say("plan.calendar.copy.moved", { date: text.weekdayDayMonth(copy.toDateKey) })
          : say("plan.calendar.copy.changed"),
    },
  };
}

function plannedLook(workout: PlanCalendarWorkout, planned: string | null, say: Say): WorkoutLook {
  const frame = workout.copy.kind === "plan-only" ? "plan-only" : "sent";
  return workout.lastWrite === "failed"
    ? {
        frame,
        detail: planned,
        status: { tone: "danger", text: say("plan.calendar.copy.notSent") },
      }
    : { frame, detail: planned, status: null };
}

function useWorkoutLook(): (
  workout: PlanCalendarWorkout,
  activities: readonly PlanCalendarActivity[],
  text: CalendarText,
) => WorkoutLook {
  const { say } = usePhrasebook();
  return (workout, activities, text) => {
    const planned = workout.durationS === null ? null : text.duration(workout.durationS);
    const outcome = workout.outcome;
    const changed = changedLook(workout, planned, say, text);
    switch (outcome.kind) {
      case "done-as-planned":
      case "done-differently":
        return {
          frame: "sent",
          detail:
            outcome.actualDurationS === null
              ? planned
              : planned === null
                ? text.duration(outcome.actualDurationS)
                : say("plan.calendar.doneOf", {
                    done: text.duration(outcome.actualDurationS),
                    planned,
                  }),
          status:
            outcome.kind === "done-as-planned"
              ? { tone: "ok", text: say("plan.calendar.outcome.doneAsPlanned") }
              : { tone: "warn", text: say("plan.calendar.outcome.doneDifferently") },
        };
      case "missed":
        return (
          changed ?? {
            frame: "missed",
            detail:
              planned === null
                ? say("plan.calendar.outcome.noActivity")
                : say("plan.calendar.outcome.missedDetail", { planned }),
            status: { tone: "danger", text: say("plan.calendar.outcome.missed") },
          }
        );
      case "is-this-it": {
        const seconds = activityDuration(activities, outcome.activityId);
        return {
          frame: "ask",
          detail:
            seconds === null
              ? say("plan.calendar.outcome.rideSynced")
              : say("plan.calendar.outcome.rideSyncedLength", { duration: text.duration(seconds) }),
          status: { tone: "brand", text: say("plan.calendar.outcome.isThisIt") },
        };
      }
      case "not-synced-yet":
        return (
          changed ?? {
            frame: "sent",
            detail: planned,
            status: { tone: "muted", text: say("plan.calendar.outcome.notSyncedYet") },
          }
        );
      case "moved":
        return {
          frame: "sent",
          detail: planned,
          status: {
            tone: "muted",
            text: say("plan.calendar.outcome.moved", {
              date: text.weekdayDayMonth(outcome.toDateKey),
            }),
          },
        };
      case "removed-by-you":
        return {
          frame: "ghost",
          detail: planned,
          status: { tone: "muted", text: say("plan.calendar.outcome.removedByYou") },
        };
      case "planned":
        return changed ?? plannedLook(workout, planned, say);
    }
  };
}

function WorkoutCard(props: {
  readonly workout: PlanCalendarWorkout;
  readonly activities: readonly PlanCalendarActivity[];
  readonly text: CalendarText;
}): ReactElement {
  const look = useWorkoutLook()(props.workout, props.activities, props.text);
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-ctl px-1.5 py-1 text-xs",
        FRAME[look.frame],
      )}
      data-workout-id={props.workout.id}
      data-outcome={props.workout.outcome.kind}
      data-copy={props.workout.copy.kind}
    >
      <span className={cn("font-semibold", look.frame === "ghost" ? "line-through" : "text-ink")}>
        {props.workout.name}
      </span>
      {look.detail === null ? null : <span className="text-ink-2">{look.detail}</span>}
      {look.status === null ? null : (
        <span className={cn("font-semibold", TONE[look.status.tone])}>{look.status.text}</span>
      )}
    </div>
  );
}

function ActivityCard(props: {
  readonly activity: PlanCalendarActivity;
  readonly withPlan: boolean;
  readonly text: CalendarText;
}): ReactElement {
  const { say } = usePhrasebook();
  const { activity, text } = props;
  const parts = [
    activity.durationS === null ? null : text.duration(activity.durationS),
    activity.distanceM === null || activity.distanceM < 500
      ? null
      : text.kilometres(activity.distanceM),
  ].filter((part): part is string => part !== null);
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-ctl border px-1.5 py-1 text-xs",
        props.withPlan ? "border-line-2 bg-sunk" : "border-sunk bg-sunk",
      )}
      data-activity-id={activity.activityId}
    >
      <span className="font-semibold text-ink">
        {activity.name ?? say("plan.calendar.activity.untitled")}
      </span>
      {parts.length === 0 ? null : (
        <span className="text-ink-2">{parts.join(say("plan.calendar.separator"))}</span>
      )}
      {props.withPlan ? (
        <span className="text-ink-2">{say("plan.calendar.activity.extra")}</span>
      ) : null}
    </div>
  );
}

function statusLine(
  status: PlanCalendarWeekStatus,
  connected: boolean,
  say: Say,
  text: CalendarText,
): string | null {
  switch (status.kind) {
    case "passed":
      return null;
    case "on-intervals":
      return say("plan.calendar.status.onIntervals");
    case "goes-out":
      return connected
        ? say("plan.calendar.status.goesOut", { date: text.weekdayDayMonth(status.onDateKey) })
        : say("plan.calendar.status.notConnected");
    case "approve-from":
      return connected
        ? say("plan.calendar.status.approveFrom", { date: text.weekdayDayMonth(status.onDateKey) })
        : say("plan.calendar.status.notConnected");
    case "waiting-for-first-approve":
    case "waiting-for-week-approve":
      return say("plan.calendar.status.waitingForApprove");
    case "due":
      return connected
        ? say("plan.calendar.status.notSentYet")
        : say("plan.calendar.status.notConnected");
  }
}

function weekLines(
  week: PlanCalendarWeek,
  timing: CalendarTiming,
  connected: boolean,
  say: Say,
  text: CalendarText,
): readonly string[] {
  const planned = text.duration(week.plannedS);
  const status = statusLine(week.status, connected, say, text);
  if (timing !== "future") {
    return [
      say("plan.calendar.doneOf", { done: text.duration(week.doneS), planned }),
      ...(week.toConfirm > 0
        ? [say("plan.calendar.week.toConfirm", { count: week.toConfirm })]
        : []),
      ...(timing === "current" && status !== null && week.status.kind !== "on-intervals"
        ? [status]
        : []),
    ];
  }
  if (week.status.kind === "on-intervals") {
    return [say("plan.calendar.week.planned", { planned }), ...(status === null ? [] : [status])];
  }
  return [say("plan.calendar.week.planOnly", { planned }), ...(status === null ? [] : [status])];
}

function RowLabelCell(props: {
  readonly label: CalendarRowLabel;
  readonly row: CalendarRow;
  readonly today: number;
  readonly connected: boolean;
  readonly text: CalendarText;
}): ReactElement {
  const { say } = usePhrasebook();
  const { label, row, text, today, connected } = props;
  const lines: string[] = [];
  let title: string;
  switch (label.kind) {
    case "training-week":
      title = say("plan.calendar.week.label", { week: label.week.index });
      lines.push(text.weekRange(label.week.startDateKey, label.week.endDateKey));
      lines.push(...weekLines(label.week, label.timing, connected, say, text));
      break;
    case "week-start":
      title = say("plan.calendar.week.label", { week: label.week.index });
      lines.push(
        say("plan.calendar.week.startsOn", {
          date: text.weekdayDayMonth(label.week.startDateKey),
        }),
      );
      lines.push(
        ...weekLines(
          label.week,
          weekTiming(label.week.startDateKey, label.week.endDateKey, today),
          connected,
          say,
          text,
        ),
      );
      break;
    case "crossing":
      title = say("plan.calendar.week.crossing", { from: label.from, to: label.to.index });
      lines.push(
        say("plan.calendar.week.nextStarts", {
          week: label.to.index,
          date: text.weekdayDayMonth(label.to.startDateKey),
        }),
      );
      lines.push(
        ...weekLines(
          label.to,
          weekTiming(label.to.startDateKey, label.to.endDateKey, today),
          connected,
          say,
          text,
        ),
      );
      break;
    case "week-end":
      title = say("plan.calendar.week.label", { week: label.week.index });
      lines.push(
        say("plan.calendar.week.endsOn", { date: text.weekdayDayMonth(label.week.endDateKey) }),
      );
      break;
    case "dates":
      title = text.weekRange(row.startDateKey, row.endDateKey);
      if (label.count === 0) {
        if (label.timing !== "past") lines.push(say("plan.calendar.week.nothingPlanned"));
      } else if (label.timing === "current") {
        lines.push(say("plan.calendar.week.soFar", { duration: text.duration(label.durationS) }));
      } else {
        lines.push(
          say("plan.calendar.week.activities", {
            duration: text.duration(label.durationS),
            count: label.count,
          }),
        );
      }
      if (label.load !== null) lines.push(say("plan.calendar.week.load", { load: label.load }));
      break;
  }
  return (
    <div
      className="flex flex-col gap-px border-t border-line bg-surface-2 px-2.5 py-2 text-xs text-ink-2"
      role="rowheader"
    >
      <span className="text-sm font-semibold text-ink">{title}</span>
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>{line}</span>
      ))}
    </div>
  );
}

function DayCell(props: {
  readonly day: CalendarDay;
  readonly read: PlanCalendarRead;
  readonly text: CalendarText;
}): ReactElement {
  const { say } = usePhrasebook();
  const { day, read, text } = props;
  const number = text.dayOfMonth(day.dateKey);
  const heading =
    day.today === "today"
      ? say("plan.calendar.day.today", { day: number })
      : day.weekStarts !== null
        ? say("plan.calendar.day.weekStarts", { day: number, week: day.weekStarts.index })
        : number;
  const empty = day.workouts.length === 0 && day.activities.length === 0;
  return (
    <div
      className={cn(
        "relative flex min-h-23 flex-col gap-1 border-t border-l border-line p-1.25",
        day.today === "today" && "bg-brand-soft",
        day.place === "before-plan" && "bg-sunk",
        day.weekStarts !== null &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-brand",
      )}
      data-date-key={day.dateKey}
      role="cell"
    >
      <span
        className={cn(
          "text-xs",
          day.today === "today" || day.weekStarts !== null
            ? "font-semibold text-brand"
            : "text-ink-2",
        )}
      >
        {heading}
      </span>
      {day.workouts.map((workout) => (
        <WorkoutCard key={workout.id} workout={workout} activities={read.activities} text={text} />
      ))}
      {day.activities.map((activity) => (
        <ActivityCard
          key={activity.activityId}
          activity={activity}
          withPlan={read.plan !== null}
          text={text}
        />
      ))}
      {empty && day.place === "in-plan" ? (
        <span className="p-0.5 text-xs text-ink-2">{say("plan.calendar.day.rest")}</span>
      ) : null}
      {empty && day.place === "before-plan" ? (
        <span className="p-0.5 text-xs text-ink-2">{say("plan.calendar.day.beforePlan")}</span>
      ) : null}
    </div>
  );
}

export function CalendarGrid(props: {
  readonly read: PlanCalendarRead;
  readonly rows: readonly CalendarRow[];
  readonly firstDay: FirstDayOfWeek;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  return (
    <div className="overflow-x-auto">
      <div
        className="grid min-w-205 grid-cols-[128px_repeat(7,minmax(0,1fr))] overflow-hidden rounded-card border border-line bg-surface"
        role="table"
        aria-label={say("sidebar.views.calendar")}
      >
        <div className="bg-surface-2 px-2 py-1.5 text-xs text-ink-2" role="columnheader">
          {props.read.plan === null
            ? say("plan.calendar.column.week")
            : say("plan.calendar.column.trainingWeek")}
        </div>
        {weekdayOrder(props.firstDay).map((weekday) => (
          <div
            key={weekday}
            className="border-l border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-2"
            role="columnheader"
          >
            {text.weekday(weekday)}
          </div>
        ))}
        {props.rows.map((row) => (
          <div key={row.startDateKey} className="contents" role="row">
            <RowLabelCell
              label={rowLabel(row, props.read.todayDateKey)}
              row={row}
              today={props.read.todayDateKey}
              connected={props.read.calendarConnected}
              text={text}
            />
            {row.days.map((day) => (
              <DayCell key={day.dateKey} day={day} read={props.read} text={text} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
