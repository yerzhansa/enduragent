import type {
  PlanCalendarEndingWorkout,
  PlanCalendarReplacing,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { useEffect, useRef, type ReactElement } from "react";
import { comingOff, type ApprovalWeek, type PendingApproval } from "../../calendar/approval";
import type { LoginSwitch } from "../../calendar/settings-controller";
import { useCalendarText, type CalendarText } from "./calendar-text";
import { ComesOff, SHEET_ROW, StaysOn } from "./ReplaceBlocks";

export type ApproveSheetPhase =
  | { readonly kind: "open" }
  | { readonly kind: "approving" }
  | { readonly kind: "sending" }
  | { readonly kind: "removing"; readonly count: number }
  | { readonly kind: "checking"; readonly count: number }
  | {
      readonly kind: "send-failed";
      readonly sent: number;
      readonly failed: readonly PlanCalendarWorkout[];
    }
  | {
      readonly kind: "remove-failed";
      readonly done: number;
      readonly total: number;
      readonly left: readonly PlanCalendarEndingWorkout[];
    }
  | { readonly kind: "refused" };

export interface ApproveSheetReplace {
  readonly replacing: PlanCalendarReplacing;
  readonly removeChanges: boolean;
}

function removal(
  replace: ApproveSheetReplace,
  phase: ApproveSheetPhase,
): { readonly count: number; readonly left: readonly PlanCalendarEndingWorkout[] } {
  switch (phase.kind) {
    case "removing":
    case "checking":
      return { count: phase.count, left: replace.replacing.removes };
    case "remove-failed":
      return { count: phase.total, left: phase.left };
    default: {
      const left = comingOff(replace.replacing, replace.removeChanges);
      return { count: left.length, left };
    }
  }
}

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
  const row = SHEET_ROW;
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
  readonly replace: ApproveSheetReplace | null;
  readonly connected: boolean;
  readonly login: LoginSwitch;
  readonly onRemoveChanges: (remove: boolean) => void;
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
  const replace = firstSet ? props.replace : null;
  const off = replace === null ? null : removal(replace, phase);
  const heading =
    replace !== null
      ? say("plan.calendar.approve.replace.title")
      : firstSet
        ? pending.weeks.length > 1
          ? say("plan.calendar.approve.titleFirstTwo")
          : say("plan.calendar.approve.titleFirstOne")
        : say("plan.calendar.approve.titleWeek", {
            week: pending.scope.kind === "week" ? pending.scope.week : 0,
          });
  const caption =
    replace !== null
      ? say("plan.calendar.approve.replace.caption", { old: replace.replacing.planName })
      : firstSet
        ? say("plan.calendar.approve.captionFirst")
        : say("plan.calendar.approve.captionWeek");
  const body =
    replace === null || off === null
      ? say("plan.calendar.approve.body", { count: pending.count })
      : `${say("plan.calendar.approve.replace.bodyOff", {
          count: off.count,
          old: replace.replacing.planName,
        })} ${
          off.count === 1
            ? say("plan.calendar.approve.replace.bodyOnAfterOne", { count: pending.count })
            : say("plan.calendar.approve.replace.bodyOn", { count: pending.count })
        }`;
  return (
    <aside
      className="absolute top-13 right-0 bottom-0 z-10 flex w-100 max-w-full flex-col gap-3 overflow-auto border-l border-line bg-surface px-5 py-4.5 shadow-elev-3"
      aria-label={heading}
      data-approve-sheet={pending.scope.kind}
      data-replace-sheet={replace === null ? undefined : replace.replacing.cleanup}
    >
      <span className="text-xs text-ink-2">{caption}</span>
      <h2 ref={title} tabIndex={-1} className="m-0 text-lg font-semibold text-ink">
        {heading}
      </h2>
      <p className="m-0 text-xs text-ink-2">{body}</p>
      {replace === null || off === null ? null : (
        <>
          <ComesOff planName={replace.replacing.planName} workouts={off.left} text={text} />
          <StaysOn
            replacing={replace.replacing}
            removeChanges={replace.removeChanges}
            choosing={
              phase.kind === "open" ? "open" : phase.kind === "approving" ? "locked" : "hidden"
            }
            onRemoveChanges={props.onRemoveChanges}
            text={text}
          />
          <span className="text-xs font-semibold text-ink-2">
            {say("plan.calendar.approve.replace.onHeader")}
          </span>
        </>
      )}
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
      {phase.kind === "remove-failed" ? (
        <p
          className="m-0 rounded-card border border-danger bg-danger/10 px-3 py-2.5 text-xs"
          role="alert"
        >
          {say("plan.calendar.approve.replace.removeFailed", {
            done: phase.done,
            total: phase.total,
            days: text.list(phase.left.map((workout) => text.weekdayDay(workout.dateKey))),
          })}
        </p>
      ) : null}
      {phase.kind === "refused" ? (
        <p className="m-0 text-xs text-ink-2" role="status">
          {say("plan.calendar.approve.refused")}
        </p>
      ) : null}
      {phase.kind === "removing" ? (
        <p className="m-0 text-xs text-ink-2" role="status">
          {say("plan.calendar.approve.replace.removing", { count: phase.count })}
        </p>
      ) : null}
      {phase.kind === "checking" ? (
        <p className="m-0 text-xs text-ink-2" role="status">
          {say("plan.calendar.approve.replace.checking", { count: phase.count })}
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
        {phase.kind === "send-failed" || phase.kind === "remove-failed" ? (
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
            {off !== null
              ? say("plan.calendar.approve.replace.approve", { off: off.count, on: pending.count })
              : pending.count === 0
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
