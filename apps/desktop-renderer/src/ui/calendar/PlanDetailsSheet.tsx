import type { PlanCalendarHistoryEntry, PlanCalendarTick } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useEffect, useRef, type ReactElement } from "react";
import {
  detailsEnding,
  endChoiceLocked,
  type DetailsSheetState,
  type PlanDetails,
} from "../../calendar/details-controller";
import { addDays } from "../../calendar/dates";
import type { PlanCalendarRead } from "../../calendar/grid";
import { useCalendarText, type CalendarText } from "./calendar-text";

type Say = ReturnType<typeof usePhrasebook>["say"];

const FRAME =
  "absolute top-13 right-0 bottom-0 z-10 flex w-110 max-w-full flex-col gap-3 overflow-auto border-l border-line bg-surface px-5 py-4.5 shadow-elev-3";

function dateKeyOfMs(ms: number): number {
  const at = new Date(ms);
  return at.getFullYear() * 10_000 + (at.getMonth() + 1) * 100 + at.getDate();
}

function historyText(entry: PlanCalendarHistoryEntry, text: CalendarText, say: Say): string {
  switch (entry.kind) {
    case "saved":
      return say("plan.calendar.details.historySaved");
    case "change":
      return say("plan.calendar.details.historyChange", { title: entry.title });
    case "kept": {
      const day =
        entry.dateKey === null
          ? say("plan.calendar.details.aWorkout")
          : text.weekdayDay(entry.dateKey);
      return entry.durationS === null
        ? say("plan.calendar.details.historyKeptVersion", { day })
        : say("plan.calendar.details.historyKept", { day, length: text.duration(entry.durationS) });
    }
    case "moved":
      return say("plan.calendar.details.historyMoved", {
        name: entry.name,
        from: text.weekdayDay(entry.fromDateKey),
        to: text.weekdayDay(entry.toDateKey),
      });
  }
}

function phasesLine(read: PlanCalendarRead, separator: string): string | null {
  const parts: string[] = [];
  let current: { phase: string; first: number; last: number } | null = null;
  for (const week of read.plan?.weeks ?? []) {
    if (week.phase === null) {
      current = null;
      continue;
    }
    if (current !== null && current.phase === week.phase) {
      current.last = week.index;
      parts[parts.length - 1] = `${current.phase} ${current.first}–${current.last}`;
      continue;
    }
    current = { phase: week.phase, first: week.index, last: week.index };
    parts.push(`${current.phase} ${current.first}`);
  }
  return parts.length === 0 ? null : parts.join(separator);
}

function progress(read: PlanCalendarRead) {
  const plan = read.plan;
  const workouts = plan?.workouts ?? [];
  const kinds = workouts.map((workout) => workout.outcome.kind);
  const done = kinds.filter(
    (kind) => kind === "done-as-planned" || kind === "done-differently",
  ).length;
  const missed = kinds.filter((kind) => kind === "missed").length;
  const toConfirm = kinds.filter((kind) => kind === "is-this-it").length;
  return {
    weeksDone: (plan?.weeks ?? []).filter((week) => week.endDateKey < read.todayDateKey).length,
    weeks: plan?.totalWeeks ?? 0,
    done,
    missed,
    toConfirm,
    total: done + missed + toConfirm,
  };
}

type AthleteChange = PlanDetails["ending"]["athleteChanges"][number];

function sameTick(left: PlanCalendarTick, right: PlanCalendarTick): boolean {
  return (
    left.planWorkoutId === right.planWorkoutId &&
    left.eventId === right.eventId &&
    left.dateKey === right.dateKey &&
    left.fingerprint === right.fingerprint
  );
}

function ChangeList(props: {
  readonly changes: readonly AthleteChange[];
  readonly text: CalendarText;
}): ReactElement {
  const { say } = usePhrasebook();
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-ink">
      {props.changes.map((entry) => (
        <li key={entry.planWorkoutId}>
          {[
            props.text.weekdayDay(entry.dateKey),
            entry.name,
            entry.durationS === null ? null : props.text.duration(entry.durationS),
          ]
            .filter((part): part is string => part !== null && part.length > 0)
            .join(say("plan.calendar.separator"))}
        </li>
      ))}
    </ul>
  );
}

function EndConfirmView(props: {
  readonly details: PlanDetails;
  readonly end: NonNullable<Extract<DetailsSheetState, { kind: "open" }>["end"]>;
  readonly text: CalendarText;
  readonly onRemoveChanges: (remove: boolean) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const { details, end, text } = props;
  const busy = end.kind === "ending";
  const removes = details.ending.removes.length;
  const changes = details.ending.athleteChanges;
  const today = details.ending.staysToday[0];
  const sent = end.kind !== "idle" && endChoiceLocked(end) && end.removeChanges ? end.ticked : null;
  const removing =
    sent === null
      ? changes
      : changes.filter((entry) => sent.some((tick) => sameTick(tick, entry.tick)));
  const staying = changes.filter((entry) => !removing.includes(entry));
  const split = sent !== null && removing.length !== changes.length;
  const box = (count: number) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-danger"
        checked={end.removeChanges}
        disabled={endChoiceLocked(end)}
        onChange={(event) => props.onRemoveChanges(event.currentTarget.checked)}
      />
      {say("plan.calendar.details.endRemoveChanges", { count })}
    </label>
  );
  return (
    <section
      className="flex flex-col gap-2 rounded-card border border-danger px-3 py-2.5"
      aria-label={say("plan.calendar.details.endTitle")}
      data-end-confirm=""
    >
      <strong className="text-sm text-ink">{say("plan.calendar.details.endTitle")}</strong>
      <p className="m-0 text-xs text-ink-2">
        {removes === 0
          ? say("plan.calendar.details.endRemovesNone")
          : say("plan.calendar.details.endRemoves", { count: removes })}
        {today === undefined
          ? null
          : ` ${say("plan.calendar.details.endToday", { name: today.name })}`}
      </p>
      {split ? (
        <>
          {staying.length === 0 ? null : (
            <>
              <p className="m-0 text-xs text-ink-2">
                {say("plan.calendar.details.endChanges", { count: staying.length })}
              </p>
              <ChangeList changes={staying} text={text} />
            </>
          )}
          {removing.length === 0 ? null : (
            <>
              <ChangeList changes={removing} text={text} />
              {box(removing.length)}
            </>
          )}
        </>
      ) : changes.length === 0 ? null : (
        <>
          <p className="m-0 text-xs text-ink-2">
            {say("plan.calendar.details.endChanges", { count: changes.length })}
          </p>
          <ChangeList changes={changes} text={text} />
          {box(changes.length)}
        </>
      )}
      {end.kind === "failed" ? (
        <p
          className="m-0 rounded-ctl border border-danger bg-danger/10 px-3 py-2 text-xs"
          role="alert"
        >
          {end.reason === "changed"
            ? say("plan.calendar.details.endChanged")
            : say("plan.calendar.details.endFailed")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
          {say("plan.calendar.details.cancel")}
        </Button>
        <Button type="button" variant="destructive" disabled={busy} onClick={props.onConfirm}>
          {say("plan.calendar.details.endAction")}
        </Button>
      </div>
    </section>
  );
}

export function PlanDetailsSheet(props: {
  readonly state: Exclude<DetailsSheetState, { kind: "closed" }>;
  readonly read: PlanCalendarRead;
  readonly onClose: () => void;
  readonly onReplace: () => void;
  readonly onStartEnd: () => void;
  readonly onRemoveChanges: (remove: boolean) => void;
  readonly onConfirmEnd: () => void;
  readonly onCancelEnd: () => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const { state, read } = props;
  const plan = read.plan;
  const header = (
    <div className="flex items-center justify-between gap-2">
      <h2 ref={heading} tabIndex={-1} className="m-0 text-lg font-semibold text-ink">
        {say("plan.calendar.details.title")}
      </h2>
      <Button
        type="button"
        variant="outline"
        disabled={detailsEnding(state)}
        onClick={props.onClose}
      >
        {say("plan.calendar.details.close")}
      </Button>
    </div>
  );
  if (state.kind !== "open" || plan === null) {
    return (
      <aside className={FRAME} aria-label={say("plan.calendar.details.title")} data-plan-details="">
        {header}
        <p className="m-0 text-sm text-ink-2" role={state.kind === "loading" ? "status" : "alert"}>
          {state.kind === "loading"
            ? say("plan.calendar.details.loading")
            : say("plan.calendar.details.unavailable")}
        </p>
      </aside>
    );
  }
  const counts = progress(read);
  const phases = phasesLine(read, say("plan.calendar.separator"));
  const lastDay = addDays(plan.startDateKey, plan.totalWeeks * 7 - 1);
  const rows: [string, string][] = [
    [
      say("plan.calendar.details.planLabel"),
      say("plan.calendar.details.planValue", { name: plan.name, count: plan.totalWeeks }),
    ],
    [
      say("plan.calendar.details.datesLabel"),
      say("plan.calendar.details.datesValue", {
        start: text.weekdayDayMonth(plan.startDateKey),
        end: text.weekdayDayMonth(lastDay),
      }),
    ],
  ];
  if (plan.targetDateKey !== null) {
    rows.push([say("plan.calendar.details.raceLabel"), text.weekdayDayMonth(plan.targetDateKey)]);
  }
  if (phases !== null) rows.push([say("plan.calendar.details.phasesLabel"), phases]);
  return (
    <aside className={FRAME} aria-label={say("plan.calendar.details.title")} data-plan-details="">
      {header}
      <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-2">{label}</dt>
            <dd className="m-0 text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="flex flex-col gap-1 rounded-card border border-line px-3.5 py-3">
        <strong className="text-sm text-ink">{say("plan.calendar.details.progressTitle")}</strong>
        <span className="text-xs text-ink">
          {say("plan.calendar.details.weeksDone", {
            done: counts.weeksDone,
            count: counts.weeks,
          })}{" "}
          {say("plan.calendar.details.workoutsDone", {
            done: counts.done,
            count: counts.total,
            missed: counts.missed,
            toConfirm: counts.toConfirm,
          })}
        </span>
      </section>
      <section className="flex flex-col gap-1">
        <strong className="text-sm text-ink">{say("plan.calendar.details.historyTitle")}</strong>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {state.details.history.map((entry, index) => (
            <li
              key={`${entry.atMs}-${index}`}
              className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 text-sm"
            >
              <span className="text-ink-2">{text.dayMonth(dateKeyOfMs(entry.atMs))}</span>
              <span className="text-ink">{historyText(entry, text, say)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-1.5 rounded-card border border-line px-3 py-2.5">
        <strong className="text-sm text-ink">{say("plan.calendar.details.replaceTitle")}</strong>
        <span className="text-xs text-ink-2">{say("plan.calendar.details.replaceBody")}</span>
        <Button
          type="button"
          variant="outline"
          disabled={detailsEnding(state)}
          onClick={props.onReplace}
        >
          {say("plan.calendar.details.replaceAction")}
        </Button>
      </section>
      {state.end === null ? (
        <section className="flex flex-col gap-1.5 rounded-card border border-line px-3 py-2.5">
          <strong className="text-sm text-ink">
            {say("plan.calendar.details.endSectionTitle")}
          </strong>
          <span className="text-xs text-ink-2">{say("plan.calendar.details.endSectionBody")}</span>
          <Button
            type="button"
            variant="outline"
            className="border-danger text-danger"
            onClick={props.onStartEnd}
          >
            {say("plan.calendar.details.endAction")}
          </Button>
        </section>
      ) : (
        <EndConfirmView
          details={state.details}
          end={state.end}
          text={text}
          onRemoveChanges={props.onRemoveChanges}
          onConfirm={props.onConfirmEnd}
          onCancel={props.onCancelEnd}
        />
      )}
    </aside>
  );
}
