import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";
import type { MovePreview } from "../../calendar/move";
import type { MoveDialogState } from "../../calendar/move-controller";
import { useCalendarText, type CalendarText } from "./calendar-text";

type Say = ReturnType<typeof usePhrasebook>["say"];

const STEP = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

function effect(preview: MovePreview, text: CalendarText, say: Say): string {
  const where =
    preview.where.kind === "goes"
      ? say("plan.calendar.move.onIntervals", { weekday: text.weekdayLong(preview.toDateKey) })
      : preview.where.kind === "leaves"
        ? say("plan.calendar.move.leaves", { week: preview.where.week })
        : say("plan.calendar.move.planOnly");
  const weeks = preview.weeks;
  if (weeks === null) return where;
  const totals =
    weeks.kind === "same"
      ? say("plan.calendar.move.weekStays", { total: text.duration(weeks.week.plannedS) })
      : say("plan.calendar.move.weeksChange", {
          from: weeks.from.index,
          fromTotal: text.duration(weeks.fromS),
          to: weeks.to.index,
          toTotal: text.duration(weeks.toS),
        });
  return `${where} ${totals}`;
}

function failure(
  state: Extract<MoveDialogState, { kind: "failed" }>,
  preview: MovePreview,
  text: CalendarText,
  say: Say,
): string {
  switch (state.reason) {
    case "card-open": {
      const opened =
        [preview.workout, ...preview.clash].find(
          (entry) => entry.copy.kind === "changed-in-intervals",
        ) ?? preview.workout;
      return say("plan.calendar.move.cardOpen", { day: text.weekdayDayMonth(opened.dateKey) });
    }
    case "refused":
      return say("plan.calendar.move.refused");
    case "not-movable":
      return say("plan.calendar.move.notMovable");
    case "unavailable":
      return say("plan.calendar.move.failed");
  }
}

export function MoveDialog(props: {
  readonly state: Exclude<MoveDialogState, { kind: "closed" }>;
  readonly preview: MovePreview;
  readonly earlier: number | null;
  readonly later: number | null;
  readonly onDay: (toDateKey: number) => void;
  readonly onSwap: (swap: boolean) => void;
  readonly onMove: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const frame = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { state, preview, earlier, later } = props;
  useEffect(() => {
    if (frame.current?.contains(document.activeElement) === true) return;
    heading.current?.focus();
  }, [preview.toDateKey]);
  const title = say("plan.calendar.move.title", {
    name: preview.workout.name,
    day: text.weekdayDayMonth(preview.toDateKey),
  });
  const busy = state.kind === "moving";
  const clashNames = text.names(
    preview.clash.map((workout) =>
      workout.durationS === null
        ? workout.name
        : `${workout.name} ${text.duration(workout.durationS)}`,
    ),
  );
  return (
    <div
      ref={frame}
      className="absolute top-58 right-5 z-20 flex w-85 max-w-full flex-col gap-2.5 rounded-card border border-line bg-surface p-4 shadow-elev-3"
      role="dialog"
      aria-label={title}
      aria-busy={busy}
      data-move-dialog=""
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onCancel();
      }}
    >
      <div className="flex items-start gap-2">
        <h2
          ref={heading}
          tabIndex={-1}
          aria-live="polite"
          className="m-0 min-w-0 flex-1 text-base font-semibold text-ink"
        >
          {title}
        </h2>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={STEP}
          aria-label={say("plan.calendar.move.earlier")}
          aria-disabled={busy || earlier === null}
          onClick={() => {
            if (!busy && earlier !== null) props.onDay(earlier);
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className={STEP}
          aria-label={say("plan.calendar.move.later")}
          aria-disabled={busy || later === null}
          onClick={() => {
            if (!busy && later !== null) props.onDay(later);
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <p className="m-0 text-xs text-ink-2">{effect(preview, text, say)}</p>
      {preview.clash.length === 0 ? null : (
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 p-0 text-xs font-semibold text-ink">
            {say("plan.calendar.move.clash", {
              weekday: text.weekdayLong(preview.toDateKey),
              workouts: clashNames,
            })}
          </legend>
          {preview.canSwap ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="move-clash"
                className="mt-0.5 accent-brand"
                checked={state.swap}
                disabled={busy}
                onChange={() => props.onSwap(true)}
              />
              {say("plan.calendar.move.swap", {
                count: preview.clash.length,
                names: text.names(preview.clash.map((workout) => workout.name)),
                weekday: text.weekdayLong(preview.workout.dateKey),
              })}
            </label>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="move-clash"
              className="mt-0.5 accent-brand"
              checked={!state.swap || !preview.canSwap}
              disabled={busy}
              onChange={() => props.onSwap(false)}
            />
            {say("plan.calendar.move.keepBoth", {
              weekday: text.weekdayLong(preview.toDateKey),
            })}
          </label>
        </fieldset>
      )}
      {state.kind === "failed" ? (
        <p
          className="m-0 rounded-ctl border border-danger bg-danger/10 px-3 py-2 text-xs"
          role="alert"
        >
          {failure(state, preview, text, say)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
          {say("plan.calendar.move.cancel")}
        </Button>
        <Button type="button" disabled={busy} onClick={props.onMove}>
          {say("plan.calendar.move.confirm")}
        </Button>
      </div>
    </div>
  );
}
