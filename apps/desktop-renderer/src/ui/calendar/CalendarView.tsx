import { usePhrasebook } from "@enduragent/i18n/react";
import { Button, Page, cn } from "@enduragent/ui";
import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";
import {
  calendarRows,
  currentWeek,
  intervalsChanges,
  rangeDates,
  type CalendarRange,
  type PlanCalendarRead,
} from "../../calendar/grid";
import type { MoveDialogState } from "../../calendar/move-controller";
import { rendererPlatformProjection } from "../../platform-copy";
import { useEnduragentStore } from "../../state/store";
import type { CalendarActions } from "../../state/calendar-slice";
import {
  approvalFor,
  approvedWeeks,
  replacingOf,
  replaceWaiting,
  sendingFailures,
  weekApprovals,
  type PendingApproval,
} from "../../calendar/approval";
import type { ApproveSheetState } from "../../calendar/approve-controller";
import { ApproveSheet, type ApproveSheetPhase, type ApproveSheetReplace } from "./ApproveSheet";
import type { PlanCalendarWorkout } from "@enduragent/coach-contract";
import { CalendarGrid, type CalendarMoving } from "./CalendarGrid";
import { ChangeSheet } from "./ChangeSheet";
import { MoveDialog } from "./MoveDialog";
import { PlanDetailsSheet } from "./PlanDetailsSheet";
import { dropDayFrom, firstDropDay, movePreview } from "../../calendar/move";
import { detailsEnding } from "../../calendar/details-controller";
import { ReplaceWaitingBanner, WeekReadyBanner } from "./WeekReadyBanner";
import { SeasonStrip } from "./SeasonStrip";
import { WorkoutSheet } from "./WorkoutSheet";
import { useCalendarText } from "./calendar-text";

function useSubtitle(read: PlanCalendarRead | null): string | undefined {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  if (read === null) return undefined;
  const plan = read.plan;
  if (plan === null) return say("plan.calendar.subtitle.noPlan");
  if (read.todayDateKey < plan.startDateKey) {
    return say("plan.calendar.subtitle.starts", {
      name: plan.name,
      date: text.weekdayDayMonth(plan.startDateKey),
    });
  }
  const week = currentWeek(read);
  if (week === null) return say("plan.calendar.subtitle.ended", { name: plan.name });
  return plan.phase === null
    ? say("plan.calendar.subtitle.week", {
        name: plan.name,
        week: week.index,
        total: plan.totalWeeks,
      })
    : say("plan.calendar.subtitle.weekPhase", {
        name: plan.name,
        week: week.index,
        total: plan.totalWeeks,
        phase: plan.phase,
      });
}

function NoPlanCard(): ReactElement {
  const { say } = usePhrasebook();
  const setActiveView = useEnduragentStore((state) => state.setActiveView);
  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-surface px-5 py-4.5">
      <div className="flex max-w-xl flex-col gap-1">
        <h2 className="m-0 text-sm font-semibold text-ink">{say("plan.calendar.noPlan.title")}</h2>
        <p className="m-0 text-sm text-ink-2">{say("plan.calendar.noPlan.body")}</p>
      </div>
      <Button type="button" onClick={() => setActiveView("chat")}>
        {say("plan.calendar.noPlan.start")}
      </Button>
    </section>
  );
}

function RefreshFailed(props: { readonly onRetry: () => void }): ReactElement {
  const { say } = usePhrasebook();
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 rounded-card border border-warn bg-warn/10 px-3.5 py-2.5 text-sm"
      role="status"
    >
      <TriangleAlert className="size-4 text-warn" aria-hidden="true" />
      <span>{say("plan.calendar.refreshFailed")}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        {say("plan.calendar.retry")}
      </Button>
    </div>
  );
}

interface SheetView {
  readonly pending: PendingApproval;
  readonly phase: ApproveSheetPhase;
  readonly replace: ApproveSheetReplace | null;
}

function sheetView(read: PlanCalendarRead, sheet: ApproveSheetState): SheetView | null {
  switch (sheet.kind) {
    case "closed":
      return null;
    case "open":
    case "approving":
    case "refused": {
      const pending = approvalFor(read, sheet.scope);
      const replacing = sheet.scope.kind === "first-weeks" ? replacingOf(read) : null;
      const removeChanges = sheet.kind !== "refused" && sheet.removeChanges === true;
      return pending === null
        ? null
        : {
            pending,
            phase: { kind: sheet.kind },
            replace: replacing === null ? null : { replacing, removeChanges },
          };
    }
    case "sending":
    case "remove-failed":
    case "send-failed": {
      const pending = approvedWeeks(read, sheet.scope, sheet.weeks);
      if (pending === null) return null;
      const replacing = read.replacing;
      if (sheet.kind !== "send-failed" && sheet.removing !== undefined && replacing !== null) {
        const replace = { replacing, removeChanges: false };
        if (sheet.kind === "remove-failed") {
          const left = replacing.removes;
          return {
            pending,
            replace,
            phase: {
              kind: "remove-failed",
              done: Math.max(0, sheet.removing - left.length),
              total: sheet.removing,
              left,
            },
          };
        }
        return {
          pending,
          replace,
          phase: {
            kind: replacing.removes.length > 0 ? "removing" : "checking",
            count: sheet.removing,
          },
        };
      }
      if (sheet.kind !== "send-failed")
        return { pending, phase: { kind: "sending" }, replace: null };
      const progress = sendingFailures(read, sheet.weeks);
      return {
        pending,
        replace: null,
        phase: {
          kind: "send-failed",
          sent: progress.sent,
          failed: [...progress.failed, ...progress.waiting].sort(
            (left, right) => left.dateKey - right.dateKey,
          ),
        },
      };
    }
  }
}

const NOTHING_HIGHLIGHTED: ReadonlySet<string> = new Set();

function beingApproved(read: PlanCalendarRead, sheet: ApproveSheetState): ReadonlySet<string> {
  if (sheet.kind !== "open" && sheet.kind !== "approving") return NOTHING_HIGHLIGHTED;
  const pending = approvalFor(read, sheet.scope);
  if (pending === null) return NOTHING_HIGHLIGHTED;
  return new Set(pending.weeks.flatMap((entry) => entry.workouts.map((workout) => workout.id)));
}

function ApprovalLayer(props: { readonly read: PlanCalendarRead }): ReactElement | null {
  const sheet = useEnduragentStore((store) => store.calendarApproval);
  const actions = useEnduragentStore((store) => store.calendarApproveActions);
  const login = useEnduragentStore((store) => store.calendarSettings.startAtLogin);
  const settingsActions = useEnduragentStore((store) => store.calendarSettingsActions);
  const open = sheet.kind !== "closed";
  useEffect(() => {
    if (open) settingsActions?.load();
  }, [open, settingsActions]);
  const view = sheetView(props.read, sheet);
  if (view === null) return null;
  return (
    <ApproveSheet
      pending={view.pending}
      phase={view.phase}
      replace={view.replace}
      connected={props.read.calendarConnected}
      login={login}
      onRemoveChanges={(remove) => actions?.setRemoveChanges(remove)}
      onApprove={() => actions?.approve()}
      onNotNow={() => actions?.notNow()}
      onConnect={() => actions?.connect()}
      onRetry={() => actions?.retry()}
      onLogin={(enabled) => settingsActions?.setStartAtLogin(enabled)}
    />
  );
}

function ChangesBanner(props: { readonly read: PlanCalendarRead }): ReactElement | null {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const counts = intervalsChanges(props.read);
  const total = counts.edited + counts.moved + counts.deleted;
  if (total === 0) return null;
  const parts = [
    counts.edited === 0 ? null : say("plan.calendar.changes.edited", { count: counts.edited }),
    counts.moved === 0 ? null : say("plan.calendar.changes.moved", { count: counts.moved }),
    counts.deleted === 0 ? null : say("plan.calendar.changes.deleted", { count: counts.deleted }),
  ].filter((part): part is string => part !== null);
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 rounded-card border border-warn bg-warn/10 px-3.5 py-2.5 text-sm"
      role="status"
      data-intervals-changes={total}
    >
      <TriangleAlert className="size-4 text-warn" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong>
          {parts.length > 1
            ? say("plan.calendar.changes.leadSplit", { count: total })
            : say("plan.calendar.changes.lead", { count: total })}
        </strong>{" "}
        {parts.length > 1
          ? `${say("plan.calendar.changes.parts", { parts: text.names(parts) })} `
          : null}
        {say("plan.calendar.changes.body")}
      </span>
    </div>
  );
}

function ChangeLayer(props: { readonly read: PlanCalendarRead }): ReactElement | null {
  const sheet = useEnduragentStore((store) => store.calendarChange);
  const actions = useEnduragentStore((store) => store.calendarChangeActions);
  if (sheet.kind === "closed") return null;
  return (
    <ChangeSheet
      state={sheet}
      read={props.read}
      onKeep={() => actions?.keep()}
      onPutBack={() => actions?.putBack()}
      onClose={() => actions?.close()}
    />
  );
}

function DetailsLayer(props: { readonly read: PlanCalendarRead }): ReactElement | null {
  const state = useEnduragentStore((store) => store.calendarDetails);
  const actions = useEnduragentStore((store) => store.calendarDetailsActions);
  if (state.kind === "closed") return null;
  return (
    <PlanDetailsSheet
      state={state}
      read={props.read}
      onClose={() => actions?.close()}
      onReplace={() => actions?.replace()}
      onStartEnd={() => actions?.startEnd()}
      onRemoveChanges={(remove) => actions?.setRemoveChanges(remove)}
      onConfirmEnd={() => actions?.confirmEnd()}
      onCancelEnd={() => actions?.cancelEnd()}
    />
  );
}

interface MovePaging {
  takePaged(): boolean;
  retry(): boolean;
  athleteNavigates(): void;
}

function useMovePaging(
  range: CalendarRange | null,
  move: MoveDialogState,
  calendar: CalendarActions | null,
): MovePaging {
  const paged = useRef(false);
  const handled = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  const shown = useRef(range);
  const target = move.kind === "closed" ? null : move.toDateKey;
  useEffect(() => {
    const moved = shown.current !== range;
    shown.current = range;
    if (target === null || range === null) {
      paged.current = false;
      handled.current = null;
      pending.current = null;
      return;
    }
    const landed = moved && pending.current !== null && inRange(range, pending.current);
    if (moved) pending.current = null;
    if (handled.current === target && !landed) return;
    handled.current = target;
    if (inRange(range, target)) return;
    paged.current = true;
    pending.current = target;
    calendar?.showWeekOf(target);
  }, [target, range, calendar]);
  return {
    takePaged() {
      const was = paged.current;
      paged.current = false;
      return was;
    },
    retry() {
      if (pending.current === null || target === null) return false;
      pending.current = target;
      calendar?.showWeekOf(target);
      return true;
    },
    athleteNavigates() {
      pending.current = null;
    },
  };
}

function MoveLayer(props: {
  readonly read: PlanCalendarRead;
  readonly takePaged: () => boolean;
  readonly onPageBack: (workoutId: string, dateKey: number) => void;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.calendarMove);
  const actions = useEnduragentStore((store) => store.calendarMoveActions);
  const preview =
    state.kind === "closed"
      ? null
      : movePreview(props.read, state.workoutId, state.toDateKey, state.swap);
  useEffect(() => {
    if (state.kind !== "closed" && state.kind !== "moving" && preview === null) actions?.cancel();
  }, [state.kind, preview, actions]);
  if (state.kind === "closed" || preview === null) return null;
  return (
    <MoveDialog
      state={state}
      preview={preview}
      revision={props.read}
      earlier={dropDayFrom(props.read, preview.workout, state.toDateKey, -1)}
      later={dropDayFrom(props.read, preview.workout, state.toDateKey, 1)}
      onDay={(toDateKey) =>
        actions?.request(
          state.planId,
          state.workoutId,
          toDateKey,
          movePreview(props.read, state.workoutId, toDateKey, true)?.canSwap === true,
        )
      }
      onSwap={(swap) => actions?.setSwap(swap)}
      onMove={() => actions?.confirm(preview.canSwap)}
      onCancel={() => {
        if (state.kind === "moving") return;
        const pageBack = props.takePaged();
        actions?.cancel();
        if (pageBack) props.onPageBack(preview.workout.id, preview.workout.dateKey);
      }}
    />
  );
}

function inRange(range: CalendarRange, dateKey: number): boolean {
  const { startDateKey, endDateKey } = rangeDates(range);
  return dateKey >= startDateKey && dateKey <= endDateKey;
}

function movingView(read: PlanCalendarRead, move: MoveDialogState): CalendarMoving | null {
  if (move.kind === "closed") return null;
  const preview = movePreview(read, move.workoutId, move.toDateKey, move.swap);
  return {
    workoutId: move.workoutId,
    toDateKey: move.toDateKey,
    fromDateKey: preview?.workout.dateKey ?? move.toDateKey,
    swapIds:
      preview !== null && move.swap && preview.canSwap
        ? preview.clash.map((workout) => workout.id)
        : [],
    landed: false,
  };
}

function useLandingMove(
  read: PlanCalendarRead | null,
  move: MoveDialogState,
): CalendarMoving | null {
  const saving = useRef<{ readonly read: PlanCalendarRead; readonly view: CalendarMoving } | null>(
    null,
  );
  useEffect(() => {
    if (move.kind === "moving" && read !== null) {
      const view = movingView(read, move);
      saving.current = view === null ? null : { read, view: { ...view, landed: true } };
      return;
    }
    if (move.kind !== "closed" || saving.current?.read !== read) saving.current = null;
  });
  const landing = saving.current;
  return move.kind === "closed" && landing !== null && landing.read === read ? landing.view : null;
}

function WorkoutLayer(props: {
  readonly read: PlanCalendarRead;
  readonly onMove: (planId: string, workout: PlanCalendarWorkout, toDateKey: number) => void;
  readonly onClose: (workoutId: string) => void;
}): ReactElement | null {
  const state = useEnduragentStore((store) => store.calendarWorkout);
  const actions = useEnduragentStore((store) => store.calendarWorkoutActions);
  const open = state.kind === "closed" ? null : state;
  const workout =
    open === null || props.read.plan?.planId !== open.planId
      ? undefined
      : props.read.plan.workouts.find((entry) => entry.id === open.workoutId);
  const gone =
    open !== null && (workout === undefined || workout.copy.kind === "changed-in-intervals");
  const { onClose } = props;
  useEffect(() => {
    if (gone && open !== null) onClose(open.workoutId);
  }, [gone, open, onClose]);
  if (open === null || workout === undefined || gone) return null;
  const day = firstDropDay(props.read, workout);
  return (
    <WorkoutSheet
      key={workout.id}
      workout={workout}
      read={props.read}
      canMove={day !== null}
      onMove={() => {
        if (day !== null) props.onMove(open.planId, workout, day);
      }}
      onAsk={(draft) => actions?.askCoach(draft)}
      onClose={() => props.onClose(workout.id)}
    />
  );
}

function useReturnFocus(
  read: PlanCalendarRead | null,
  covered: boolean,
  moving: boolean,
): (workoutId: string, after?: PlanCalendarRead | null) => void {
  const target = useRef<{ readonly id: string; readonly after: PlanCalendarRead | null } | null>(
    null,
  );
  useEffect(() => {
    const pending = target.current;
    if (pending === null || read === null) return;
    if (moving) {
      target.current = { id: pending.id, after: read };
      return;
    }
    if (covered || pending.after === read) return;
    target.current = null;
    (
      document.querySelector<HTMLElement>(`[data-workout-id="${pending.id}"]`) ??
      document.querySelector<HTMLElement>("[data-calendar-grid]")
    )?.focus();
  });
  return (workoutId, after = null) => {
    target.current = { id: workoutId, after };
  };
}

function WeekReady(props: {
  readonly read: PlanCalendarRead;
  readonly clear: () => boolean;
}): ReactElement | null {
  const sheet = useEnduragentStore((store) => store.calendarApproval);
  const actions = useEnduragentStore((store) => store.calendarApproveActions);
  const pending = weekApprovals(props.read)[0];
  const replacing = replaceWaiting(props.read);
  if (sheet.kind !== "closed") return null;
  if (replacing !== null) {
    return (
      <ReplaceWaitingBanner
        replacing={replacing}
        onReview={() => {
          if (props.clear()) actions?.open({ kind: "first-weeks" });
        }}
      />
    );
  }
  if (pending === undefined) return null;
  return (
    <WeekReadyBanner
      pending={pending}
      onReview={() => {
        if (props.clear()) actions?.open(pending.scope);
      }}
    />
  );
}

export function CalendarView(): ReactElement {
  const { say } = usePhrasebook();
  const state = useEnduragentStore((store) => store.calendar);
  const actions = useEnduragentStore((store) => store.calendarActions);
  const approval = useEnduragentStore((store) => store.calendarApproval);
  const change = useEnduragentStore((store) => store.calendarChange);
  const changeActions = useEnduragentStore((store) => store.calendarChangeActions);
  const move = useEnduragentStore((store) => store.calendarMove);
  const details = useEnduragentStore((store) => store.calendarDetails);
  const detailsActions = useEnduragentStore((store) => store.calendarDetailsActions);
  const moveActions = useEnduragentStore((store) => store.calendarMoveActions);
  const workoutCard = useEnduragentStore((store) => store.calendarWorkout);
  const workoutActions = useEnduragentStore((store) => store.calendarWorkoutActions);
  const read = state.kind === "ready" ? state.read : null;
  const returnFocus = useReturnFocus(
    read,
    workoutCard.kind !== "closed" ||
      move.kind !== "closed" ||
      change.kind !== "closed" ||
      details.kind !== "closed" ||
      approval.kind !== "closed",
    move.kind === "moving",
  );
  const landing = useLandingMove(read, move);
  const paging = useMovePaging(state.kind === "ready" ? state.range : null, move, actions);
  const locked = change.kind === "working" || detailsEnding(details) || move.kind === "moving";
  const clearSheets = (keep: "card" | "move" | "change" | "details" | "approve"): boolean => {
    if (locked) return false;
    if (keep !== "card") workoutActions?.close();
    if (keep !== "move") moveActions?.cancel();
    if (keep !== "change") changeActions?.close();
    if (keep !== "details") detailsActions?.close();
    return true;
  };
  const changeWorkoutId =
    change.kind === "closed"
      ? null
      : "detail" in change
        ? change.detail.planWorkoutId
        : change.planWorkoutId;
  const subtitle = useSubtitle(read);
  const firstDay = rendererPlatformProjection().firstDayOfWeek;
  const navigation = (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={say("plan.calendar.previous")}
        onClick={() => {
          paging.athleteNavigates();
          actions?.previous();
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          paging.athleteNavigates();
          actions?.today();
        }}
      >
        {say("plan.calendar.today")}
      </Button>
      {read === null || read.plan === null ? null : (
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() => {
            const planId = read.plan?.planId;
            if (planId !== undefined && clearSheets("details")) detailsActions?.open(planId);
          }}
        >
          {say("plan.calendar.details.open")}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={say("plan.calendar.next")}
        onClick={() => {
          paging.athleteNavigates();
          actions?.next();
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
  return (
    <Page
      title={say("sidebar.views.calendar")}
      {...(subtitle === undefined ? {} : { subtitle })}
      busy={state.kind === "loading" || (state.kind === "ready" && state.refresh === "refreshing")}
      action={navigation}
      className="calendar-view relative"
      contentMode="workspace"
    >
      <div
        className={cn(
          "h-full min-h-0 overflow-auto px-5 pt-3.5",
          move.kind === "closed" ? "pb-6" : "pb-96",
        )}
        data-page-scroll=""
      >
        {state.kind === "unavailable" ? (
          <section className="flex flex-col items-start gap-3 py-6" role="alert">
            <p className="m-0 text-sm text-ink-2">{say("plan.calendar.unavailable")}</p>
            <Button type="button" variant="outline" onClick={() => actions?.refresh()}>
              {say("plan.calendar.retry")}
            </Button>
          </section>
        ) : null}
        {state.kind === "ready" ? (
          <div className="flex min-w-0 flex-col gap-3" data-calendar-state="ready">
            {state.refresh === "failed" ? (
              <RefreshFailed
                onRetry={() => {
                  if (!paging.retry()) actions?.refresh();
                }}
              />
            ) : null}
            <ChangesBanner read={state.read} />
            <WeekReady read={state.read} clear={() => clearSheets("approve")} />
            {state.read.plan === null ? (
              <NoPlanCard />
            ) : (
              <SeasonStrip
                plan={state.read.plan}
                onWeek={(dateKey) => {
                  paging.athleteNavigates();
                  actions?.showWeekOf(dateKey);
                }}
              />
            )}
            <CalendarGrid
              read={state.read}
              rows={calendarRows(state.read, state.range)}
              firstDay={firstDay}
              highlighted={beingApproved(state.read, approval)}
              selected={workoutCard.kind === "open" ? workoutCard.workoutId : changeWorkoutId}
              onOpen={(planWorkoutId) => {
                const planId = state.read.plan?.planId;
                const opened = state.read.plan?.workouts.find(
                  (workout) => workout.id === planWorkoutId,
                );
                if (planId === undefined || opened === undefined) return;
                const changed = opened.copy.kind === "changed-in-intervals";
                if (!clearSheets(changed ? "change" : "card")) return;
                if (changed) changeActions?.open(planId, planWorkoutId);
                else workoutActions?.open(planId, planWorkoutId);
              }}
              moving={movingView(state.read, move) ?? landing}
              onMove={(workoutId, toDateKey) => {
                const planId = state.read.plan?.planId;
                const preview = movePreview(state.read, workoutId, toDateKey, true);
                if (planId !== undefined && clearSheets("move")) {
                  moveActions?.request(planId, workoutId, toDateKey, preview?.canSwap === true);
                }
              }}
            />
          </div>
        ) : null}
      </div>
      {state.kind === "ready" &&
      change.kind === "closed" &&
      move.kind === "closed" &&
      details.kind === "closed" &&
      workoutCard.kind === "closed" ? (
        <ApprovalLayer read={state.read} />
      ) : null}
      {state.kind === "ready" ? (
        <WorkoutLayer
          read={state.read}
          onMove={(planId, workout, toDateKey) => {
            if (!clearSheets("move")) return;
            returnFocus(workout.id);
            moveActions?.request(
              planId,
              workout.id,
              toDateKey,
              movePreview(state.read, workout.id, toDateKey, true)?.canSwap === true,
            );
          }}
          onClose={(workoutId) => {
            returnFocus(workoutId);
            workoutActions?.close();
          }}
        />
      ) : null}
      {state.kind === "ready" ? (
        <MoveLayer
          read={state.read}
          takePaged={paging.takePaged}
          onPageBack={(workoutId, dateKey) => {
            returnFocus(workoutId, state.read);
            actions?.showWeekOf(dateKey);
          }}
        />
      ) : null}
      {state.kind === "ready" ? <DetailsLayer read={state.read} /> : null}
      {state.kind === "ready" ? <ChangeLayer read={state.read} /> : null}
    </Page>
  );
}
