import type { PlanCalendarWorkout } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useEffect, useRef, type ReactElement } from "react";
import type { ApprovalWeek, PendingApproval } from "../../calendar/approval";
import type { LoginSwitch } from "../../calendar/settings-controller";
import { useCalendarText, type CalendarText } from "./calendar-text";

export type ApproveSheetPhase =
  | { readonly kind: "open" }
  | { readonly kind: "approving" }
  | { readonly kind: "sending" }
  | {
      readonly kind: "send-failed";
      readonly sent: number;
      readonly failed: readonly PlanCalendarWorkout[];
    }
  | { readonly kind: "refused" };

function WeekRows(props: {
  readonly entry: ApprovalWeek;
  readonly detailed: boolean;
  readonly text: CalendarText;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const { entry, text } = props;
  const first = entry.workouts[0];
  const last = entry.workouts.at(-1);
  if (first === undefined || last === undefined) return null;
  const range = text.weekRange(entry.week.startDateKey, entry.week.endDateKey);
  const header = props.detailed
    ? say("plan.calendar.approve.weekHeader", { week: entry.week.index, range })
    : say("plan.calendar.approve.weekHeaderCount", {
        week: entry.week.index,
        range,
        count: entry.workouts.length,
      });
  const row =
    "grid grid-cols-[56px_minmax(0,1fr)_auto] gap-2 border-t border-line px-2.5 py-1.5 text-sm";
  return (
    <div className="overflow-hidden rounded-card border border-line">
      <div className="bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-ink-2">{header}</div>
      {props.detailed ? (
        entry.workouts.map((workout) => (
          <div key={workout.id} className={row}>
            <span className="text-ink-2">{text.weekdayDay(workout.dateKey)}</span>
            <span>{workout.name}</span>
            <span className="text-ink-2">
              {workout.durationS === null ? "" : text.duration(workout.durationS)}
            </span>
          </div>
        ))
      ) : (
        <div className={row}>
          <span className="text-ink-2">
            {first.dateKey === last.dateKey
              ? text.weekday(text.isoWeekdayOf(first.dateKey))
              : say("plan.calendar.approve.dayRange", {
                  first: text.weekday(text.isoWeekdayOf(first.dateKey)),
                  last: text.weekday(text.isoWeekdayOf(last.dateKey)),
                })}
          </span>
          <span>{text.names(entry.workouts.map((workout) => workout.name))}</span>
          <span className="text-ink-2">
            {text.duration(
              entry.workouts.reduce((total, workout) => total + (workout.durationS ?? 0), 0),
            )}
          </span>
        </div>
      )}
    </div>
  );
}

export function ApproveSheet(props: {
  readonly pending: PendingApproval;
  readonly phase: ApproveSheetPhase;
  readonly connected: boolean;
  readonly login: LoginSwitch;
  readonly onApprove: () => void;
  readonly onNotNow: () => void;
  readonly onConnect: () => void;
  readonly onRetry: () => void;
  readonly onLogin: (enabled: boolean) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  const { pending, phase } = props;
  const firstSet = pending.scope.kind === "first-weeks";
  const heading = firstSet
    ? pending.weeks.length > 1
      ? say("plan.calendar.approve.titleFirstTwo")
      : say("plan.calendar.approve.titleFirstOne")
    : say("plan.calendar.approve.titleWeek", {
        week: pending.scope.kind === "week" ? pending.scope.week : 0,
      });
  return (
    <aside
      className="absolute top-13 right-0 bottom-0 z-10 flex w-100 max-w-full flex-col gap-3 overflow-auto border-l border-line bg-surface px-5 py-4.5 shadow-elev-3"
      aria-label={heading}
      data-approve-sheet={pending.scope.kind}
    >
      <span className="text-xs text-ink-2">
        {firstSet
          ? say("plan.calendar.approve.captionFirst")
          : say("plan.calendar.approve.captionWeek")}
      </span>
      <h2 ref={title} tabIndex={-1} className="m-0 text-lg font-semibold text-ink">
        {heading}
      </h2>
      <p className="m-0 text-xs text-ink-2">
        {say("plan.calendar.approve.body", { count: pending.count })}
      </p>
      {pending.weeks.map((entry, index) => (
        <WeekRows key={entry.week.index} entry={entry} detailed={index === 0} text={text} />
      ))}
      {props.login.kind === "unavailable" ? null : (
        <label className="flex items-start gap-2.5 rounded-card border border-line px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-brand"
            checked={props.login.enabled}
            disabled={props.login.kind === "saving"}
            onChange={(event) => props.onLogin(event.currentTarget.checked)}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-ink">
              {say("plan.calendar.approve.loginTitle")}
            </span>
            <span className="text-xs text-ink-2">{say("plan.calendar.approve.loginBody")}</span>
          </span>
        </label>
      )}
      {phase.kind === "send-failed" ? (
        <p
          className="m-0 rounded-card border border-danger bg-danger/10 px-3 py-2.5 text-xs"
          role="alert"
        >
          {say("plan.calendar.approve.failed", {
            sent: phase.sent,
            total: phase.sent + phase.failed.length,
            days: text.list(phase.failed.map((workout) => text.weekdayDay(workout.dateKey))),
          })}
        </p>
      ) : null}
      {phase.kind === "refused" ? (
        <p className="m-0 text-xs text-ink-2" role="status">
          {say("plan.calendar.approve.refused")}
        </p>
      ) : null}
      {phase.kind === "sending" ? (
        <p className="m-0 text-xs text-ink-2" role="status">
          {say("plan.calendar.approve.sending", { count: pending.count })}
        </p>
      ) : null}
      {props.connected ? null : (
        <p className="m-0 text-xs text-ink-2">{say("plan.calendar.approve.notConnected")}</p>
      )}
      <div className="flex gap-2">
        {phase.kind === "send-failed" ? (
          <Button type="button" className="flex-1" onClick={props.onRetry}>
            {say("plan.calendar.approve.retry")}
          </Button>
        ) : props.connected ? (
          <Button
            type="button"
            className="flex-1"
            disabled={phase.kind !== "open"}
            onClick={props.onApprove}
          >
            {pending.count === 0
              ? say("plan.calendar.approve.approve")
              : say("plan.calendar.approve.approveCount", { count: pending.count })}
          </Button>
        ) : (
          <Button type="button" className="flex-1" onClick={props.onConnect}>
            {say("plan.calendar.approve.connect")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={phase.kind === "approving"}
          onClick={props.onNotNow}
        >
          {say("plan.calendar.approve.notNow")}
        </Button>
      </div>
    </aside>
  );
}
