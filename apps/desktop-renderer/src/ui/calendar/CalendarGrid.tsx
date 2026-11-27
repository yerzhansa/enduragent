import type {
  PlanCalendarActivity,
  PlanCalendarWeek,
  PlanCalendarWeekStatus,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { cn } from "@enduragent/ui";
import { useState, type DragEvent, type ReactElement } from "react";
import { daysBetween, weekdayOrder, type FirstDayOfWeek } from "../../calendar/dates";
import {
  rowLabel,
  weekTiming,
  type CalendarDay,
  type CalendarTiming,
  type CalendarRow,
  type CalendarRowLabel,
  type PlanCalendarRead,
} from "../../calendar/grid";
import { canDropOn } from "../../calendar/move";
import { useCalendarText, type CalendarText } from "./calendar-text";

export interface CalendarMoving {
  readonly workoutId: string;
  readonly toDateKey: number;
  readonly fromDateKey: number;
  readonly swapIds: readonly string[];
  readonly landed: boolean;
}

interface Dragging {
  readonly workout: PlanCalendarWorkout | null;
  readonly over: number | null;
  readonly moving: CalendarMoving | null;
  start(workout: PlanCalendarWorkout): void;
  enter(dateKey: number | null): void;
  end(): void;
  drop(dateKey: number): void;
}

const MOVE_TYPE = "application/x-enduragent-workout";

type Tone = "ok" | "warn" | "danger" | "brand" | "muted";

interface WorkoutLook {
  readonly frame: "sent" | "plan-only" | "missed" | "ask" | "changed" | "ghost" | "ghost-alert";
  readonly detail: string | null;
  readonly status: { readonly tone: Tone; readonly text: string } | null;
  readonly opens: boolean;
}

const FRAME: Record<WorkoutLook["frame"], string> = {
  sent: "border border-line bg-surface",
  "plan-only": "border border-dashed border-line-2 bg-transparent",
  missed: "border border-danger bg-danger/10 outline-2 outline-offset-1 outline-danger",
  ask: "border border-dashed border-brand bg-surface",
  changed: "border border-warn bg-warn/10 outline-2 outline-offset-1 outline-warn",
  ghost: "border border-dashed border-line-2 bg-transparent text-ink-2",
  "ghost-alert": "border border-dashed border-warn bg-warn/10 text-warn",
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
      frame: "ghost-alert",
      detail: planned,
      status: { tone: "warn", text: say("plan.calendar.copy.deleted") },
      opens: true,
    };
  }
  if (copy.change === "moved" && copy.toDateKey !== null) {
    return {
      frame: "ghost",
      detail: null,
      status: {
        tone: "muted",
        text: say("plan.calendar.copy.moved", { date: text.weekdayDayMonth(copy.toDateKey) }),
      },
      opens: false,
    };
  }
  return {
    frame: "changed",
    detail:
      planned === null || copy.durationS === null || copy.durationS === workout.durationS
        ? planned
        : say("plan.calendar.copy.editedLength", {
            intervals: text.duration(copy.durationS),
            plan: planned,
          }),
    status: { tone: "warn", text: say("plan.calendar.copy.changed") },
    opens: true,
  };
}

function plannedLook(
  workout: PlanCalendarWorkout,
  planned: string | null,
  say: Say,
  text: CalendarText,
): WorkoutLook {
  const frame = workout.copy.kind === "plan-only" ? "plan-only" : "sent";
  if (workout.lastWrite === "failed") {
    return {
      frame,
      detail: planned,
      status: { tone: "danger", text: say("plan.calendar.copy.notSent") },
      opens: false,
    };
  }
  const moved = workout.movedByYou;
  return {
    frame,
    detail: planned,
    status:
      moved === null
        ? null
        : {
            tone: "muted",
            text: say("plan.calendar.copy.movedByYou", {
              weekday:
                Math.abs(daysBetween(moved.fromDateKey, workout.dateKey)) > 6
                  ? text.weekdayDay(moved.fromDateKey)
                  : text.weekday(text.isoWeekdayOf(moved.fromDateKey)),
            }),
          },
    opens: false,
  };
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
          opens: false,
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
            opens: false,
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
          opens: false,
        };
      }
      case "not-synced-yet":
        return (
          changed ?? {
            frame: "sent",
            detail: planned,
            status: { tone: "muted", text: say("plan.calendar.outcome.notSyncedYet") },
            opens: false,
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
          opens: false,
        };
      case "removed-by-you":
        return {
          frame: "ghost",
          detail: planned,
          status: { tone: "muted", text: say("plan.calendar.outcome.removedByYou") },
          opens: false,
        };
      case "planned":
        return changed ?? plannedLook(workout, planned, say, text);
    }
  };
}

const CARD = "flex w-full flex-col gap-0.5 rounded-ctl px-1.5 py-1 text-left text-xs";
const OPENS = "cursor-pointer focus-visible:outline-2 focus-visible:outline-brand";

function CardBody(props: { readonly name: string; readonly look: WorkoutLook }): ReactElement {
  const { look } = props;
  const ghost = look.frame === "ghost" || look.frame === "ghost-alert";
  return (
    <>
      <span className={cn("font-semibold", ghost ? "line-through" : "text-ink")}>{props.name}</span>
      {look.detail === null ? null : (
        <span className={look.frame === "ghost-alert" ? undefined : "text-ink-2"}>
          {look.detail}
        </span>
      )}
      {look.status === null ? null : (
        <span className={cn(ghost ? undefined : "font-semibold", TONE[look.status.tone])}>
          {look.status.text}
        </span>
      )}
    </>
  );
}

function WorkoutCard(props: {
  readonly workout: PlanCalendarWorkout;
  readonly activities: readonly PlanCalendarActivity[];
  readonly highlighted: boolean;
  readonly selected: boolean;
  readonly text: CalendarText;
  readonly onOpen: (planWorkoutId: string) => void;
  readonly drag: Dragging;
  readonly preview?: boolean;
}): ReactElement {
  const { say } = usePhrasebook();
  const look = useWorkoutLook()(props.workout, props.activities, props.text);
  const { drag, workout } = props;
  const beingMoved =
    props.preview !== true &&
    (drag.moving?.workoutId === workout.id || drag.moving?.swapIds.includes(workout.id) === true);
  const landed = props.preview === true && drag.moving?.landed === true;
  const draggable = props.preview !== true && workout.movable && !look.opens;
  const ghost = look.frame === "ghost" || look.frame === "ghost-alert";
  const interactive = props.preview !== true && (look.opens || !ghost);
  const shared = {
    className: cn(
      CARD,
      FRAME[look.frame],
      interactive && OPENS,
      props.highlighted && "border-brand",
      draggable && "cursor-grab",
      beingMoved && "border-dashed opacity-45",
      props.preview === true && !landed && "shadow-elev-2 outline-2 outline-offset-1 outline-brand",
      props.selected && "outline-2 outline-offset-1 outline-brand",
    ),
    "data-workout-id": props.preview === true ? undefined : workout.id,
    "data-move-preview": props.preview === true && !landed ? workout.id : undefined,
    "data-move-landed": landed ? workout.id : undefined,
    "data-outcome": workout.outcome.kind,
    "data-copy": workout.copy.kind,
    "data-highlighted": props.highlighted ? "" : undefined,
    "aria-label": beingMoved
      ? say("plan.calendar.move.beingMoved", { name: workout.name })
      : undefined,
    draggable: draggable ? true : undefined,
    onDragStart: draggable
      ? (event: DragEvent<HTMLElement>) => {
          event.dataTransfer.setData(MOVE_TYPE, workout.id);
          event.dataTransfer.effectAllowed = "move";
          drag.start(workout);
        }
      : undefined,
    onDragEnd: draggable ? () => drag.end() : undefined,
  };
  const body = <CardBody name={props.workout.name} look={look} />;
  return interactive ? (
    <button
      type="button"
      {...shared}
      aria-haspopup={look.opens ? undefined : "dialog"}
      aria-expanded={props.selected}
      onClick={() => props.onOpen(props.workout.id)}
    >
      {body}
    </button>
  ) : (
    <div {...shared}>{body}</div>
  );
}

function MovedInCard(props: {
  readonly workout: PlanCalendarWorkout;
  readonly selected: boolean;
  readonly text: CalendarText;
  readonly onOpen: (planWorkoutId: string) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const { workout, text } = props;
  const copy = workout.copy;
  const seconds =
    copy.kind === "changed-in-intervals" ? (copy.durationS ?? workout.durationS) : null;
  const from = say("plan.calendar.copy.movedFrom", { date: text.weekdayDay(workout.dateKey) });
  const look: WorkoutLook = {
    frame: "changed",
    detail:
      seconds === null ? from : `${text.duration(seconds)}${say("plan.calendar.separator")}${from}`,
    status: { tone: "warn", text: say("plan.calendar.copy.movedIn") },
    opens: true,
  };
  return (
    <button
      type="button"
      className={cn(
        CARD,
        FRAME.changed,
        OPENS,
        props.selected && "outline-2 outline-offset-1 outline-brand",
      )}
      data-moved-in={workout.id}
      aria-expanded={props.selected}
      onClick={() => props.onOpen(workout.id)}
    >
      <CardBody
        name={copy.kind === "changed-in-intervals" && copy.name !== null ? copy.name : workout.name}
        look={look}
      />
    </button>
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
  readonly highlighted: ReadonlySet<string>;
  readonly selected: string | null;
  readonly text: CalendarText;
  readonly onOpen: (planWorkoutId: string) => void;
  readonly drag: Dragging;
}): ReactElement {
  const { say } = usePhrasebook();
  const { day, read, text, drag } = props;
  const dragged = drag.workout;
  const accepts = dragged !== null && canDropOn(read, dragged, day.dateKey);
  const moving = drag.moving;
  const landedIds = moving?.landed === true ? [moving.workoutId, ...moving.swapIds] : [];
  const workouts = day.workouts.filter((workout) => !landedIds.includes(workout.id));
  const incoming = (read.plan?.workouts ?? []).filter(
    (workout) =>
      moving !== null &&
      ((moving.toDateKey === day.dateKey && workout.id === moving.workoutId) ||
        (moving.fromDateKey === day.dateKey && moving.swapIds.includes(workout.id))),
  );
  const number = text.dayOfMonth(day.dateKey);
  const heading =
    day.today === "today"
      ? say("plan.calendar.day.today", { day: number })
      : day.weekStarts !== null
        ? say("plan.calendar.day.weekStarts", { day: number, week: day.weekStarts.index })
        : number;
  const empty =
    workouts.length === 0 &&
    day.movedIn.length === 0 &&
    day.activities.length === 0 &&
    incoming.length === 0;
  return (
    <div
      className={cn(
        "relative flex min-h-23 flex-col gap-1 border-t border-l border-line p-1.25",
        day.today === "today" && "bg-brand-soft",
        day.place === "before-plan" && "bg-sunk",
        day.weekStarts !== null &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.75 before:bg-brand",
        accepts && drag.over === day.dateKey && "outline-2 -outline-offset-2 outline-brand",
      )}
      data-date-key={day.dateKey}
      data-drop-target={accepts && drag.over === day.dateKey ? "" : undefined}
      role="cell"
      onDragOver={(event) => {
        if (!accepts) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (drag.over !== day.dateKey) drag.enter(day.dateKey);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) drag.enter(null);
      }}
      onDrop={(event) => {
        if (!accepts) return;
        event.preventDefault();
        drag.drop(day.dateKey);
      }}
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
      {workouts.map((workout) => (
        <WorkoutCard
          key={workout.id}
          workout={workout}
          activities={read.activities}
          highlighted={props.highlighted.has(workout.id)}
          selected={props.selected === workout.id}
          text={text}
          onOpen={props.onOpen}
          drag={drag}
        />
      ))}
      {incoming.map((workout) => (
        <WorkoutCard
          key={`preview-${workout.id}`}
          workout={workout}
          activities={read.activities}
          highlighted={false}
          selected={false}
          text={text}
          onOpen={props.onOpen}
          drag={drag}
          preview
        />
      ))}
      {day.movedIn.map((workout) => (
        <MovedInCard
          key={`in-${workout.id}`}
          workout={workout}
          selected={props.selected === workout.id}
          text={text}
          onOpen={props.onOpen}
        />
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
  readonly highlighted: ReadonlySet<string>;
  readonly selected: string | null;
  readonly onOpen: (planWorkoutId: string) => void;
  readonly moving: Dragging["moving"];
  readonly onMove: (workoutId: string, toDateKey: number) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const [dragged, setDragged] = useState<PlanCalendarWorkout | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const drag: Dragging = {
    workout: dragged,
    over,
    moving: props.moving,
    start: (workout) => setDragged(workout),
    enter: (dateKey) => setOver(dateKey),
    end: () => {
      setDragged(null);
      setOver(null);
    },
    drop: (dateKey) => {
      if (dragged !== null) props.onMove(dragged.id, dateKey);
      setDragged(null);
      setOver(null);
    },
  };
  return (
    <div className="overflow-x-auto">
      <div
        className="grid min-w-205 grid-cols-[128px_repeat(7,minmax(0,1fr))] overflow-hidden rounded-card border border-line bg-surface"
        role="table"
        aria-label={say("sidebar.views.calendar")}
        tabIndex={-1}
        data-calendar-grid=""
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
              <DayCell
                key={day.dateKey}
                day={day}
                read={props.read}
                highlighted={props.highlighted}
                selected={props.selected}
                text={text}
                onOpen={props.onOpen}
                drag={drag}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
