import type { PlanCalendarWorkoutVersion } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button, cn } from "@enduragent/ui";
import { useEffect, useRef, type ReactElement } from "react";
import type { ChangeDetail, ChangeSheetState } from "../../calendar/change-controller";
import type { PlanCalendarRead } from "../../calendar/grid";
import { useCalendarText, type CalendarText } from "./calendar-text";

type Say = ReturnType<typeof usePhrasebook>["say"];

interface ChoiceText {
  readonly title: string;
  readonly body: string;
  readonly action: string;
}

function lengthOf(version: PlanCalendarWorkoutVersion | null, text: CalendarText): string {
  return version === null || version.durationS === null ? "—" : text.duration(version.durationS);
}

function weekLine(
  read: PlanCalendarRead,
  detail: ChangeDetail,
  text: CalendarText,
  say: Say,
): string | null {
  const week = read.plan?.weeks.find(
    (entry) => detail.plan.dateKey >= entry.startDateKey && detail.plan.dateKey <= entry.endDateKey,
  );
  if (week === undefined) return null;
  const planned = detail.plan.durationS ?? 0;
  const kept = detail.intervals === null ? 0 : (detail.intervals.durationS ?? planned);
  const after = week.plannedS - planned + kept;
  if (after === week.plannedS) return null;
  return after < week.plannedS
    ? say("plan.calendar.change.weekDrops", { total: text.duration(after) })
    : say("plan.calendar.change.weekGrows", { total: text.duration(after) });
}

function Comparison(props: {
  readonly detail: ChangeDetail;
  readonly text: CalendarText;
  readonly say: Say;
}): ReactElement {
  const { detail, text, say } = props;
  const intervals = detail.intervals;
  const rows: [string, string, string][] = [
    [
      say("plan.calendar.change.rowDay"),
      text.weekdayDayMonth(detail.plan.dateKey),
      intervals === null ? "—" : text.weekdayDayMonth(intervals.dateKey),
    ],
    [say("plan.calendar.change.rowName"), detail.plan.name, intervals?.name ?? "—"],
    [say("plan.calendar.change.rowLength"), lengthOf(detail.plan, text), lengthOf(intervals, text)],
  ];
  if (detail.plan.description !== null || (intervals?.description ?? null) !== null) {
    rows.push([
      say("plan.calendar.change.rowSteps"),
      detail.plan.description ?? "—",
      intervals?.description ?? "—",
    ]);
  }
  const cell = "border-t border-line px-2.5 py-1.75 text-sm break-words whitespace-pre-line";
  const head = "bg-surface-2 px-2.5 py-1.75 text-xs font-semibold text-ink-2";
  return (
    <div
      className="grid grid-cols-[92px_minmax(0,1fr)_minmax(0,1fr)] overflow-hidden rounded-card border border-line"
      role="table"
      aria-label={say("plan.calendar.change.compare")}
    >
      <div className="contents" role="row">
        <span className={head} role="columnheader" />
        <span className={head} role="columnheader">
          {say("plan.calendar.change.columnPlan")}
        </span>
        <span className={head} role="columnheader">
          {say("plan.calendar.change.columnIntervals")}
        </span>
      </div>
      {rows.map(([label, plan, now]) => (
        <div key={label} className="contents" role="row">
          <span className={cn(cell, "text-ink-2")} role="rowheader">
            {label}
          </span>
          <span className={cell} role="cell">
            {plan}
          </span>
          <span
            className={cn(cell, now !== plan && "bg-warn/10 font-semibold")}
            role="cell"
            data-changed={now === plan ? undefined : ""}
          >
            {now}
          </span>
        </div>
      ))}
    </div>
  );
}

function Choice(props: {
  readonly choice: ChoiceText;
  readonly primary: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
}): ReactElement {
  return (
    <section className="flex flex-col gap-1.5 rounded-card border border-line px-3 py-2.5">
      <strong className="text-sm text-ink">{props.choice.title}</strong>
      <span className="text-xs text-ink-2">{props.choice.body}</span>
      <Button
        type="button"
        variant={props.primary ? "default" : "outline"}
        disabled={props.disabled}
        onClick={props.onChoose}
      >
        {props.choice.action}
      </Button>
    </section>
  );
}

function joined(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join(" ");
}

function choices(
  detail: ChangeDetail,
  read: PlanCalendarRead,
  text: CalendarText,
  say: Say,
): { readonly keep: ChoiceText; readonly putBack: ChoiceText } {
  const planDay = text.weekdayDayMonth(detail.plan.dateKey);
  const planLength = lengthOf(detail.plan, text);
  const week = weekLine(read, detail, text, say);
  const today = detail.plan.dateKey === read.todayDateKey;
  if (detail.change === "deleted" || detail.intervals === null) {
    const action = say("plan.calendar.change.keepDeleted");
    const putBack = say("plan.calendar.change.putBackDeleted");
    return {
      keep: {
        title: action,
        body: joined([say("plan.calendar.change.keepDeletedBody", { day: planDay }), week]),
        action,
      },
      putBack: {
        title: putBack,
        body:
          detail.plan.durationS === null
            ? say("plan.calendar.change.putBackDeletedBody", {
                name: detail.plan.name,
                day: planDay,
              })
            : say("plan.calendar.change.putBackDeletedLengthBody", {
                name: detail.plan.name,
                length: planLength,
                day: planDay,
              }),
        action: putBack,
      },
    };
  }
  const keepTitle = say("plan.calendar.change.keepTitle");
  const putBackTitle = say("plan.calendar.change.putBackTitle");
  if (detail.change === "moved") {
    const newDay = text.weekdayDayMonth(detail.intervals.dateKey);
    return {
      keep: {
        title: keepTitle,
        body: say("plan.calendar.change.keepMovedBody", { day: newDay }),
        action: say("plan.calendar.change.keepMovedAction", { day: newDay }),
      },
      putBack: {
        title: putBackTitle,
        body: say("plan.calendar.change.putBackMovedBody", { day: planDay }),
        action: say("plan.calendar.change.putBackMovedAction", { day: planDay }),
      },
    };
  }
  const newLength = lengthOf(detail.intervals, text);
  return {
    keep: {
      title: keepTitle,
      body: joined([
        say("plan.calendar.change.keepEditedBody", { length: newLength, day: planDay }),
        week,
      ]),
      action:
        detail.intervals.durationS === null || detail.intervals.durationS === detail.plan.durationS
          ? say("plan.calendar.change.keepEditedPlain")
          : say("plan.calendar.change.keepEditedAction", { length: newLength }),
    },
    putBack: {
      title: putBackTitle,
      body: joined([
        say("plan.calendar.change.putBackEditedBody", { length: planLength }),
        today ? say("plan.calendar.change.putBackToday") : null,
      ]),
      action:
        detail.plan.durationS === null || detail.intervals.durationS === detail.plan.durationS
          ? say("plan.calendar.change.putBackEditedPlain")
          : say("plan.calendar.change.putBackEditedAction", { length: planLength }),
    },
  };
}

function editedAt(
  value: string | null,
  format: ReturnType<typeof usePhrasebook>["format"],
): string | null {
  if (value === null) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return format.date(new Date(at), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

const FRAME =
  "absolute top-13 right-0 bottom-0 z-10 flex w-100 max-w-full flex-col gap-3 overflow-auto border-l border-line bg-surface px-5 py-4.5 shadow-elev-3";

export function ChangeSheet(props: {
  readonly state: Exclude<ChangeSheetState, { kind: "closed" }>;
  readonly read: PlanCalendarRead;
  readonly onKeep: () => void;
  readonly onPutBack: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { say, format } = usePhrasebook();
  const text = useCalendarText();
  const heading = useRef<HTMLHeadingElement>(null);
  const { state } = props;
  const opened = state.kind === "loading" || state.kind === "unavailable" ? "waiting" : "detail";
  useEffect(() => {
    heading.current?.focus();
  }, [opened]);
  if (state.kind === "loading" || state.kind === "unavailable") {
    return (
      <aside
        className={FRAME}
        aria-label={say("plan.calendar.change.sheet")}
        aria-busy={state.kind === "loading"}
        data-change-sheet={state.kind}
      >
        <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold text-ink">
          {say("plan.calendar.change.sheet")}
        </h2>
        <p
          className="m-0 text-sm text-ink-2"
          role={state.kind === "unavailable" ? "alert" : "status"}
        >
          {state.kind === "loading"
            ? say("plan.calendar.change.loading")
            : say("plan.calendar.change.unavailable")}
        </p>
        <Button type="button" variant="outline" onClick={props.onClose}>
          {say("plan.calendar.change.close")}
        </Button>
      </aside>
    );
  }
  const detail = state.detail;
  const deleted = detail.change === "deleted" || detail.intervals === null;
  const title = deleted
    ? say("plan.calendar.change.titleDeleted")
    : detail.change === "moved"
      ? say("plan.calendar.change.titleMoved")
      : say("plan.calendar.change.titleEdited");
  const options = choices(detail, props.read, text, say);
  const busy = state.kind === "working";
  const when = editedAt(detail.editedAt, format);
  const caption = [text.weekdayDayMonth(detail.plan.dateKey), detail.plan.name];
  if (deleted && detail.plan.durationS !== null) caption.push(text.duration(detail.plan.durationS));
  return (
    <aside className={FRAME} aria-label={title} aria-busy={busy} data-change-sheet={detail.change}>
      <span className="text-xs text-ink-2">{caption.join(say("plan.calendar.separator"))}</span>
      <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold text-ink">
        {title}
      </h2>
      {when === null ? null : (
        <span className="text-xs text-ink-2">{say("plan.calendar.change.editedAt", { when })}</span>
      )}
      {deleted ? null : <Comparison detail={detail} text={text} say={say} />}
      {state.kind === "failed" ? (
        <p
          className="m-0 rounded-card border border-danger bg-danger/10 px-3 py-2.5 text-xs"
          role="alert"
        >
          {state.reason === "refused"
            ? say("plan.calendar.change.refused")
            : say("plan.calendar.change.failed")}
        </p>
      ) : null}
      <Choice choice={options.keep} primary disabled={busy} onChoose={props.onKeep} />
      <Choice choice={options.putBack} primary={false} disabled={busy} onChoose={props.onPutBack} />
      <Button type="button" variant="ghost" onClick={props.onClose}>
        {say("plan.calendar.change.close")}
      </Button>
    </aside>
  );
}
