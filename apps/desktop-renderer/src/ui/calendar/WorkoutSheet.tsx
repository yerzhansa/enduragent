import type { PlanCalendarWorkout } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button, cn } from "@enduragent/ui";
import { Cloud, CloudCheck, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { PlanCalendarRead } from "../../calendar/grid";
import { WorkoutArchiveExportControl } from "../training/TrainingExportControls";
import { useCalendarText, type CalendarText } from "./calendar-text";

type Say = ReturnType<typeof usePhrasebook>["say"];

interface CopyLine {
  readonly tone: "ok" | "warn" | "danger" | "muted";
  readonly text: string;
}

const TONE: Record<CopyLine["tone"], string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-ink-2",
};

function isoText(dateKey: number): string {
  const text = String(dateKey).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function copyLine(
  workout: PlanCalendarWorkout,
  read: PlanCalendarRead,
  text: CalendarText,
  say: Say,
): CopyLine {
  if (workout.lastWrite === "failed") {
    return { tone: "danger", text: say("plan.calendar.copy.notSent") };
  }
  const copy = workout.copy;
  switch (copy.kind) {
    case "on-intervals":
      return {
        tone: "ok",
        text:
          copy.owner === "athlete-edit"
            ? say("plan.calendar.workout.onIntervalsYours")
            : say("plan.calendar.workout.onIntervals"),
      };
    case "kept-as-yours":
      return { tone: "ok", text: say("plan.calendar.workout.onIntervalsYours") };
    case "moving-by-you":
      return { tone: "muted", text: say("plan.calendar.workout.moving") };
    case "changed-in-intervals":
      return { tone: "warn", text: say("plan.calendar.copy.changed") };
    case "removed-by-you":
      return { tone: "muted", text: say("plan.calendar.outcome.removedByYou") };
    case "plan-only": {
      const week = read.plan?.weeks.find(
        (entry) => workout.dateKey >= entry.startDateKey && workout.dateKey <= entry.endDateKey,
      );
      return week?.status.kind === "goes-out" && read.calendarConnected
        ? {
            tone: "muted",
            text: say("plan.calendar.workout.planOnlyGoesOut", {
              date: text.weekdayDayMonth(week.status.onDateKey),
            }),
          }
        : { tone: "muted", text: say("plan.calendar.workout.planOnly") };
    }
  }
}

function CopyIcon(props: { readonly line: CopyLine }): ReactElement {
  const className = cn("size-4 shrink-0", TONE[props.line.tone]);
  if (props.line.tone === "ok") return <CloudCheck className={className} aria-hidden="true" />;
  if (props.line.tone === "muted") return <Cloud className={className} aria-hidden="true" />;
  return <TriangleAlert className={className} aria-hidden="true" />;
}

const FRAME =
  "absolute top-13 right-0 bottom-0 z-10 flex w-100 max-w-full flex-col gap-3 overflow-auto border-l border-line bg-surface px-5 py-4.5 shadow-elev-3";

export function WorkoutSheet(props: {
  readonly workout: PlanCalendarWorkout;
  readonly read: PlanCalendarRead;
  readonly canMove: boolean;
  readonly onMove: () => void;
  readonly onAsk: (draft: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [exporting, setExporting] = useState(false);
  const { workout, read } = props;
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const day = text.weekdayDayMonth(workout.dateKey);
  const caption = [
    day,
    ...(workout.dateKey === read.todayDateKey ? [say("plan.calendar.workout.today")] : []),
    say("plan.calendar.workout.planWorkout"),
  ].join(say("plan.calendar.separator"));
  const line = copyLine(workout, read, text, say);
  const exportable = workout.copy.kind === "on-intervals" && workout.lastWrite !== "failed";
  return (
    <div
      className={FRAME}
      role="dialog"
      aria-labelledby={headingId}
      data-workout-sheet={workout.id}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          event.target instanceof Node &&
          event.currentTarget.contains(event.target)
        ) {
          props.onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="pt-1.5 text-xs text-ink-2">{caption}</span>
        <Button type="button" variant="outline" onClick={props.onClose}>
          {say("plan.calendar.workout.close")}
        </Button>
      </div>
      <h2
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className="m-0 text-lg font-semibold break-words text-ink"
      >
        {workout.name}
      </h2>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-ink-2">
        {workout.durationS === null ? null : <span>{text.duration(workout.durationS)}</span>}
        <span className="inline-flex items-center gap-1.25" data-workout-copy={workout.copy.kind}>
          <CopyIcon line={line} />
          <span className={line.tone === "muted" ? undefined : TONE[line.tone]}>{line.text}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {props.canMove ? (
          <Button type="button" variant="outline" onClick={props.onMove}>
            {say("plan.calendar.workout.move")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            props.onAsk(say("plan.calendar.workout.askDraft", { name: workout.name, day }))
          }
        >
          {say("plan.calendar.workout.ask")}
        </Button>
        {exportable ? (
          <Button
            type="button"
            variant="outline"
            aria-expanded={exporting}
            onClick={() => setExporting((open) => !open)}
          >
            {say("plan.calendar.workout.export")}
          </Button>
        ) : null}
      </div>
      {exportable && exporting ? (
        <div className="rounded-ctl border border-line px-3 py-2.5" data-workout-export="">
          <WorkoutArchiveExportControl
            oldest={isoText(workout.dateKey)}
            newest={isoText(workout.dateKey)}
          />
        </div>
      ) : null}
    </div>
  );
}
