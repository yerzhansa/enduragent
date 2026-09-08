import {
  Activity,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  History,
  Info,
  LoaderCircle,
  MapPinned,
  Paperclip,
  RefreshCw,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import {
  PLAN_MIN_FULL_DAYS,
  PlanActiveProjectionDataSchema,
  PlanChatOriginatedResultProjectionDataSchema,
  PlanEndedProjectionDataSchema,
  PlanCoachProjectionDataSchema,
  type PlanDraftPlanProjection,
  type PlanFtpProjection,
  type PlanFtpSourceValue,
  type PlanHistoryEntry,
  type PlanHistoryResult,
  type PlanPlanningRequestContext,
  type PlanRaceCourseProjection,
  type PlanRaceCourseSummary,
  type PlanReadinessProjection,
  type PlanStartDateProjection,
} from "@enduragent/coach-contract";
import { ArtifactCard, BeforeAfterList, Button, NoticeRow, ProgressDisplay } from "@enduragent/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@enduragent/ui";
import {
  requestPlanCalendarRetry,
  subscribePlanFinalDetailsRefresh,
} from "../../plan/library-refresh";
import { formatCivilDate } from "../../lib/date";
import { planReadModel } from "../../state/plan-slice";
import { useEnduragentStore } from "../../state/store";
import { CoachDecisionPanel } from "../chat/CoachDecisionPanel";
import { Composer, type ComposerHandle } from "../chat/Composer";
import { ConversationTranscript } from "../chat/Transcript";
import { PlanLibrary } from "./PlanLibrary";
import { PlanFinalDetails } from "./PlanFinalDetails";
import { Page } from "@enduragent/ui";
import { WorkoutArchiveExportControl } from "../training/TrainingExportControls";

const SUPPORT_PAIR = "grid gap-[calc(var(--inset)/2)]";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const ACTIVE_OVERVIEW_SCENARIOS = new Set([
  "PL-S004",
  "PL-S007",
  "PL-S010",
  "PL-S011",
  "PL-S013",
  "PL-S021",
  "PL-S022",
  "PL-S023",
  "PL-S024",
  "PL-S025",
  "PL-S028",
  "PL-S037",
  "PL-S038",
  "PL-S039",
  "PL-S040",
  "PL-S041",
  "PL-S042",
  "PL-S043",
  "PL-S051",
  "PL-S071",
  "PL-S072",
  "PL-S073",
  "PL-S097",
]);

function civilDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function civilText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addCivilDate(value: string, days: number): string {
  const date = civilDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return civilText(date);
}

function civilDays(start: string, end: string): number {
  return Math.round((civilDate(end).getTime() - civilDate(start).getTime()) / 86_400_000) + 1;
}

function weekdayIndex(value: string): number {
  return civilDate(value).getUTCDay();
}

function plannedTime(durationS: number): string {
  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.round((durationS % 3_600) / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

function clockTime(durationS: number): string {
  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.round((durationS % 3_600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function finishRange(value: { readonly min: number; readonly max: number }): string {
  const format = (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours} h ${String(rest).padStart(2, "0")}`;
  };
  return `${format(value.min)}–${format(value.max)}`;
}

function decimalHours(durationS: number): string {
  return `${(durationS / 3_600).toFixed(1)} h`;
}

function historyDuration(durationS: number | null): string {
  if (durationS === null) return "—";
  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.floor((durationS % 3_600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function historyReason(entry: PlanHistoryEntry): string | null {
  if (entry.undoStatus === "eligible") {
    return "Undo is available while this is the newest change and its Workout is future and coach-owned.";
  }
  if (entry.undoStatus === "undone") return "Undone; this entry remains in History.";
  if (entry.undoStatus !== "expired") return null;
  if (entry.undoReason === "newer-change") return "A newer change was applied.";
  if (entry.undoReason === "workout-not-future") return "The Workout is no longer in the future.";
  if (entry.undoReason === "workout-not-coach-owned")
    return "The Workout is no longer coach-owned.";
  if (entry.undoReason === "workout-changed") return "The Workout changed after this entry.";
  if (entry.undoReason === "plan-not-active") return "The Plan is no longer active.";
  if (entry.undoReason === "workout-missing") return "The Workout is no longer in this Plan.";
  return "Undo is no longer available.";
}

function historyDetail(entry: PlanHistoryEntry): string {
  if (entry.before === null || entry.after === null) return "Approved locally";
  const workout = `${entry.before.name} · ${historyDuration(entry.before.durationS)} → ${entry.after.name} · ${historyDuration(entry.after.durationS)}`;
  return entry.weekLoadBefore === null || entry.weekLoadAfter === null
    ? workout
    : `${workout} · Week load ${entry.weekLoadBefore} → ${entry.weekLoadAfter}`;
}

function PlanHistoryProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly entries: readonly PlanHistoryEntry[];
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const currentPhase =
    props.data.season?.weeks.find((week) => week.status === "current")?.phase ??
    props.data.plan.phaseSummary?.[0] ??
    "Plan";
  return (
    <div className="grid gap-6">
      <section className="flex items-start justify-between gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className={SUPPORT_PAIR}>
          <h2 className="m-0 text-lg font-semibold">{props.data.plan.name}</h2>
          <p className="m-0 text-ink-2">
            {currentPhase} phase
            {props.data.plan.ftpWatts === undefined ? "" : ` · FTP ${props.data.plan.ftpWatts} W`}
          </p>
        </div>
        <span className="rounded-chip bg-sunk px-3 py-1 text-sm text-ok">Active</span>
      </section>
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-history-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            Plan changes
          </h2>
          <p className="m-0 text-ink-2">Saved changes cannot be edited.</p>
        </div>
        <div className="relative grid pl-8">
          <span className="absolute bottom-4 left-[7px] top-4 w-px bg-line" aria-hidden="true" />
          {props.entries.map((entry) => (
            <article
              key={entry.id}
              className="relative grid gap-[calc(var(--inset)/2)] border-b border-line py-row last:border-b-0"
            >
              <span
                className="absolute -left-8 top-[calc(var(--row-inset)+2px)] size-[15px] rounded-full border-[4px] border-surface bg-primary"
                aria-hidden="true"
              />
              <div className="flex items-start justify-between gap-row">
                <div className={SUPPORT_PAIR}>
                  <h3 className="m-0 text-base font-semibold">{entry.label}</h3>
                  <p className="m-0 text-sm text-ink-2">
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(entry.occurredAtMs))}
                    {" · "}
                    {historyDetail(entry)}
                  </p>
                </div>
                {entry.undoStatus === "eligible" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => actions?.undoPlanChange(entry.id)}
                  >
                    <Undo2 className="size-4" aria-hidden="true" />
                    Undo
                  </Button>
                ) : null}
              </div>
              {historyReason(entry) === null ? null : (
                <p className="m-0 text-sm text-ink-2">{historyReason(entry)}</p>
              )}
            </article>
          ))}
        </div>
      </section>
      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1">
        <div className="flex flex-col gap-inset px-5 py-row sm:flex-row sm:items-center sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">Plan settings</h2>
            <p className="m-0 text-sm text-ink-2">Auto-apply and Weekly review.</p>
          </div>
          <Button
            id="plan-settings-trigger"
            type="button"
            variant="outline"
            onClick={() => actions?.openPlanSettings()}
          >
            Open settings
          </Button>
        </div>
        <div className="flex flex-col gap-inset border-t border-line px-5 py-row sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-sm text-ink-2">
            End this Plan. Today’s workout stays; tomorrow-onward Enduragent workouts are removed.
          </p>
          <Button
            id="plan-end-trigger"
            type="button"
            variant="destructive"
            onClick={() => actions?.openEndConfirmation()}
          >
            End Plan
          </Button>
        </div>
      </section>
    </div>
  );
}

function PlanSettingsProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly scenarioId: string;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const pending = useEnduragentStore((state) => state.plan.settingPending);
  const settings = props.data.settings;
  if (settings === undefined) {
    return <StatusCard title="Plan settings" support="Refreshing Plan settings…" />;
  }
  const saving =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T22";
  const row = (
    setting: "auto-apply" | "weekly-review",
    title: string,
    support: string,
    persisted: boolean,
  ): ReactElement => {
    const active = pending?.setting === setting || settings.selectedSetting === setting;
    const value = saving && pending?.setting === setting ? pending.value : persisted;
    const failed = active && props.scenarioId === "PL-S093";
    const saved = active && props.scenarioId === "PL-S092";
    return (
      <div className="flex min-h-[76px] items-center justify-between gap-row px-5 py-4">
        <div className={SUPPORT_PAIR}>
          <h3 className="m-0 text-base font-medium">{title}</h3>
          <p className="m-0 text-sm text-ink-2">{support}</p>
          {active ? (
            <p
              className={`m-0 text-sm ${failed ? "text-danger" : saved ? "text-ok" : "text-ink-2"}`}
              aria-live="polite"
            >
              {saving ? "Saving…" : failed ? "Couldn’t save · previous value restored" : "Saved"}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-inset">
          {failed ? (
            <Button type="button" variant="ghost" onClick={() => actions?.retry()}>
              Retry
            </Button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={value}
            aria-label={title}
            disabled={actions === null || saving}
            className={`relative h-7 w-12 rounded-full border-0 p-0 transition-colors ${
              value ? "bg-primary" : "bg-line-2"
            } disabled:cursor-wait disabled:opacity-70`}
            onClick={() => actions?.setPlanSetting(setting, !persisted)}
          >
            <span
              className={`absolute top-1 size-5 rounded-full bg-surface shadow-elev-1 transition-[left] ${
                value ? "left-6" : "left-1"
              }`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    );
  };
  return (
    <section className="grid rounded-card bg-surface shadow-elev-1">
      <div className="flex items-start justify-between gap-row p-5 pb-row">
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-settings-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            Plan settings
          </h2>
          <p className="m-0 text-ink-2">{props.data.plan.name} · changes save immediately</p>
        </div>
        <Button type="button" variant="outline" onClick={() => actions?.closePlanSettings()}>
          Back to history
        </Button>
      </div>
      <div className="divide-y divide-line border-t border-line">
        {row(
          "auto-apply",
          "Auto-apply",
          "Apply eligible coach changes without approval.",
          settings.autoApply,
        )}
        {row(
          "weekly-review",
          "Weekly review",
          "Prepare one review each week.",
          settings.weeklyReview,
        )}
      </div>
    </section>
  );
}

function HistoryResultProjection(props: {
  readonly scenarioId: string;
  readonly entry: PlanHistoryEntry | null;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  if (props.scenarioId === "PL-S026") {
    return (
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex items-start gap-row">
          <History className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h2
              id="plan-history-result-heading"
              tabIndex={-1}
              className="m-0 text-lg font-semibold outline-none"
            >
              Undo expired
            </h2>
            <p className="m-0 text-ink-2">
              {props.entry === null
                ? "This change remains in History but can no longer be undone."
                : (historyReason(props.entry) ??
                  "This change remains in History but can no longer be undone.")}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={() => actions?.openHistory()}>
            Back to history
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className="flex items-start gap-row">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-history-result-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            Plan change undone
          </h2>
          <p className="m-0 text-ink-2">
            {props.entry?.after === null || props.entry?.after === undefined
              ? "The previous Workout values are restored."
              : `${props.entry.after.name} · ${historyDuration(props.entry.after.durationS)} is restored. The seven-day Intervals window will reconcile next.`}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => actions?.openHistory()}>
          View history
        </Button>
        <Button type="button" onClick={() => actions?.closeHistory()}>
          Back to Plan
        </Button>
      </div>
    </section>
  );
}

function AppliedHistoryProjection(props: {
  readonly entry: PlanHistoryEntry | null;
  readonly autoApplied?: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const before = props.entry?.before ?? null;
  const after = props.entry?.after ?? null;
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className="flex items-start gap-row">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-history-result-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            {props.autoApplied
              ? after === null
                ? "Plan updated"
                : `${after.name} applied automatically`
              : after === null
                ? "Plan updated"
                : `${after.name} is now active`}
          </h2>
          <p className="m-0 text-ink-2">
            {props.autoApplied
              ? "Auto-apply reduced one future Workout after every safety rule passed. The seven-day Intervals update has not started yet."
              : "The approved change is part of your Plan. The seven-day Intervals update has not started yet."}
          </p>
        </div>
      </div>
      {before === null || after === null ? null : (
        <BeforeAfterList
          label="Workout change"
          rows={[
            {
              id: props.entry?.id ?? "workout",
              label: "Workout",
              before: `${before.name} · ${historyDuration(before.durationS)}`,
              after: `${after.name} · ${historyDuration(after.durationS)}`,
            },
          ]}
        />
      )}
      {props.entry === null ||
      props.entry.weekLoadBefore === null ||
      props.entry.weekLoadAfter === null ? null : (
        <div className="flex items-center justify-between gap-inset">
          <span className="text-sm text-ink-2">Week load change</span>
          <strong>
            {props.entry.weekLoadAfter - props.entry.weekLoadBefore < 0 ? "−" : "+"}
            {Math.abs(props.entry.weekLoadAfter - props.entry.weekLoadBefore)}
          </strong>
        </div>
      )}
      {props.entry?.undoStatus === "eligible" ? (
        <div className="flex flex-col gap-inset sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-sm text-ink-2">
            Undo is available while this is the newest change and its Workout is future and
            coach-owned.
          </p>
          <span className="self-start rounded-full bg-sunk px-3 py-1 text-sm text-ink-2">
            Eligible
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-inset">
        {props.entry?.undoStatus === "eligible" ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => actions?.undoPlanChange(props.entry!.id)}
          >
            <Undo2 className="size-4" aria-hidden="true" />
            Undo
          </Button>
        ) : null}
        <Button type="button" onClick={() => actions?.closeHistory()}>
          Back to Plan
        </Button>
      </div>
    </section>
  );
}

const MATCH_STATUS_COPY = {
  "as-planned": "As planned",
  adjusted: "Adjusted",
  moved: "Moved",
  missed: "Missed",
  extra: "Extra",
  "decision-needed": "Decision needed",
  "awaiting-sync": "Awaiting sync",
  upcoming: "Planned",
} as const;

function matchStatusClass(status: keyof typeof MATCH_STATUS_COPY): string {
  if (status === "as-planned") return "text-ok";
  if (status === "adjusted" || status === "decision-needed") return "text-warn";
  if (status === "missed") return "text-danger";
  return "text-ink-2";
}

function RetryButton(): ReactElement | null {
  const actions = useEnduragentStore((state) => state.planActions);
  if (actions === null) return null;
  return (
    <Button type="button" variant="outline" onClick={() => actions.retry()}>
      Retry
    </Button>
  );
}

function StatusCard(props: {
  readonly title: string;
  readonly support: string;
  readonly retry?: boolean;
}): ReactElement {
  return (
    <ArtifactCard
      headingLevel={2}
      title={props.title}
      summary={props.support}
      actions={props.retry === true ? <RetryButton /> : undefined}
    />
  );
}

function ChatOriginatedPlanResultProjection(props: {
  readonly data: ReturnType<typeof PlanChatOriginatedResultProjectionDataSchema.parse>;
}): ReactElement {
  const planningActions = useEnduragentStore((state) => state.planningReadActions);
  const planActions = useEnduragentStore((state) => state.planActions);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const request = props.data.request;
  const terminal = request.terminalResult;
  const applied = request.lifecycle === "applied";
  return (
    <section
      className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1"
      data-plan-scenario="PL-S099"
    >
      <div className="flex items-start gap-row">
        {applied ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        ) : (
          <Info className="mt-0.5 size-5 shrink-0 text-ink-2" aria-hidden="true" />
        )}
        <div className={SUPPORT_PAIR}>
          <p className="m-0 text-xs font-semibold uppercase tracking-wide text-ink-2">
            Plan result
          </p>
          <h2 className="m-0 text-lg font-semibold">
            {terminal?.title ?? (applied ? "Added to Plan" : "Proposal not added")}
          </h2>
          <p className="m-0 text-ink-2">
            {terminal?.detail ?? "This request is complete and cannot be changed."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-inset">
        {props.data.returnTarget === null ? null : (
          <Button
            type="button"
            variant="outline"
            onClick={() => planningActions?.returnToChatRequest(request.requestId)}
          >
            Back to Chat
          </Button>
        )}
        {applied && model?.planId !== null && model?.planId !== undefined ? (
          <Button type="button" onClick={() => planActions?.open()}>
            Open current week
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function StaleNotice(props: { readonly message: string }): ReactElement {
  return (
    <NoticeRow tone="warning" role="status">
      {props.message}
    </NoticeRow>
  );
}

function courseSummaryCopy(course: PlanRaceCourseSummary): string {
  const distance = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    course.distanceM / 1_000,
  );
  const elevation =
    course.elevationGainM === null
      ? "Elevation unavailable"
      : `${Math.round(course.elevationGainM).toLocaleString()} m climbing`;
  return `${distance} km · ${elevation}`;
}

function CourseActions(props: {
  readonly replace?: boolean;
  readonly routeOnly?: boolean;
  readonly retry?: boolean;
  readonly continueWithout?: boolean;
  readonly remove?: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const busy = transition.status === "submitting" || transition.status === "running";
  return (
    <div className="flex flex-wrap justify-end gap-inset pt-inset">
      {props.replace === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.openCoursePicker()}
        >
          Replace file
        </Button>
      ) : null}
      {props.routeOnly === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.useCourseWithoutElevation()}
        >
          Use route only
        </Button>
      ) : null}
      {props.retry === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.retry()}
        >
          Retry
        </Button>
      ) : null}
      {props.continueWithout === true ? (
        <Button
          type="button"
          disabled={actions === null || busy}
          onClick={() => actions?.continueWithoutCourse()}
        >
          Continue without course
        </Button>
      ) : null}
      {props.remove === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.removeCourse()}
        >
          Continue without course
        </Button>
      ) : null}
    </div>
  );
}

function RaceCoursePanel(props: {
  readonly course: PlanRaceCourseProjection;
  readonly draft: boolean;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const busy =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T02" || transition.transitionId === "PL-T09");
  if (busy) {
    const recalculating = props.draft && transition.transitionId === "PL-T09";
    return (
      <section className="flex items-start gap-row rounded-card bg-sunk p-4" aria-live="polite">
        <LoaderCircle
          className="mt-0.5 size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div className={SUPPORT_PAIR}>
          <h3 className="m-0 text-sm font-medium">
            {recalculating ? "Recalculating Draft" : "Reading Race Course"}
          </h3>
          <p className="m-0 text-ink-2">
            {recalculating
              ? "Your previous Draft stays available until this update is complete."
              : "Checking route shape, distance, and elevation."}
          </p>
        </div>
      </section>
    );
  }
  const course = props.course;
  if (course.status === "ready" && course.accepted !== null) {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4">
        <div className="flex items-start gap-row">
          <MapPinned className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <div className={`${SUPPORT_PAIR} min-w-0 flex-1`}>
            <h3 className="m-0 text-sm font-medium">{course.accepted.fileName}</h3>
            <p className="m-0 text-ink-2">{courseSummaryCopy(course.accepted)}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-inset pt-inset">
          <Button type="button" variant="outline" onClick={() => actions?.openCoursePicker()}>
            Replace file
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              props.draft ? actions?.removeCourse() : actions?.continueWithoutCourse()
            }
          >
            Continue without course
          </Button>
        </div>
      </section>
    );
  }
  if (course.status === "invalid") {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="alert">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">This file can’t be read</h3>
            <p className="m-0 text-ink-2">{course.detail}</p>
          </div>
        </div>
        <CourseActions replace continueWithout />
      </section>
    );
  }
  if (course.status === "missing-elevation" && course.candidate !== null) {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="status">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">Route found, elevation missing</h3>
            <p className="m-0 text-ink-2">{courseSummaryCopy(course.candidate)}</p>
          </div>
        </div>
        <CourseActions replace routeOnly continueWithout />
      </section>
    );
  }
  if (course.status === "recalculation-failed") {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="alert">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">Draft recalculation failed</h3>
            <p className="m-0 text-ink-2">Your previous Draft is unchanged.</p>
          </div>
        </div>
        <CourseActions retry replace continueWithout />
      </section>
    );
  }
  if (course.status === "omission-failed") {
    return (
      <section className="grid gap-row rounded-card bg-sunk p-4" role="alert">
        <div className="flex items-start gap-row">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-sm font-medium">Couldn’t continue without a Race Course</h3>
            <p className="m-0 text-ink-2">Nothing changed.</p>
          </div>
        </div>
        <div className="flex justify-end gap-inset pt-inset">
          <Button type="button" variant="outline" onClick={() => actions?.returnToCoach()}>
            Back to coach
          </Button>
          <Button type="button" onClick={() => actions?.retry()}>
            Retry
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="grid gap-row rounded-card bg-sunk p-4">
      <div className={SUPPORT_PAIR}>
        <h3 className="m-0 text-sm font-medium">Race Course · optional</h3>
        <p className="m-0 text-ink-2">
          {course.status === "omitted"
            ? "This Draft stays course-agnostic."
            : "Add a GPX or FIT file, or continue without one."}
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-inset pt-inset">
        <Button type="button" variant="outline" onClick={() => actions?.openCoursePicker()}>
          {course.status === "omitted" ? "Add file" : "Attach GPX/FIT"}
        </Button>
        {course.status === "undecided" ? (
          <Button type="button" onClick={() => actions?.continueWithoutCourse()}>
            Continue without course
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function CoursePickerDialog(): ReactElement {
  const open = useEnduragentStore((state) => state.plan.coursePicker);
  const actions = useEnduragentStore((state) => state.planActions);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) actions?.closeCoursePicker();
      }}
    >
      <DialogContent
        className="w-[min(520px,calc(100vw-32px))] max-w-none gap-0 p-6 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancel}
      >
        <DialogHeader className="gap-2.5">
          <DialogTitle className="m-0 text-xl">Add Race Course</DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            Choose a GPX or FIT file. Your Draft stays here while it is checked.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            Cancel
          </DialogClose>
          <Button type="button" size="lg" onClick={() => actions?.chooseCourseFile()}>
            Choose file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoPlan(): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const creationExists = useEnduragentStore((state) => state.planLibrary.value?.creation != null);

  return (
    <div className="grid gap-6" data-plan-scenario="PL-S001">
      <section className={SUPPORT_PAIR}>
        <h2 className="m-0 text-lg font-semibold">No active Plan</h2>
        <p className="m-0 text-ink-2">Create a Plan when you are ready.</p>
      </section>
      {creationExists ? null : (
        <div className="flex flex-wrap gap-inset">
          <Button
            id="plan-start-coach"
            type="button"
            disabled={actions === null}
            onClick={() => actions?.startPlan()}
          >
            Start a Plan
          </Button>
        </div>
      )}
    </div>
  );
}

function PlanQueue(): ReactElement | null {
  const queue = useEnduragentStore((state) => state.plan.coach.queued);
  const retry = useEnduragentStore((state) => state.plan.coach.retryRequired);
  const actions = useEnduragentStore((state) => state.planActions);
  if (queue.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-card bg-sunk" aria-label="Queued coach messages">
      <div className="flex min-h-ctl items-center justify-between px-ctl-px">
        <h3 className="m-0 text-xs font-semibold">Queued messages</h3>
        <span className="rounded-chip bg-surface px-inset text-xs text-ink-2">{queue.length}</span>
      </div>
      {retry === null ? null : (
        <div className="border-t border-line px-ctl-px py-inset">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={actions === null}
            onClick={() => actions?.retryQueuedCoachTurn(retry.claimId)}
          >
            Retry interrupted message
          </Button>
        </div>
      )}
      <ul className="m-0 list-none divide-y divide-line border-t border-line p-0">
        {queue.map((message, index) => (
          <li key={message.id} className="flex min-h-ctl items-center gap-inset px-ctl-px py-inset">
            <span className="min-w-0 flex-1 break-words text-sm text-ink-2">{message.text}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`Remove queued message ${index + 1}`}
              disabled={actions === null || retry?.queuedMessageIds.includes(message.id) === true}
              onClick={() => actions?.removeQueuedCoachMessage(message.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FTP_SCENARIOS = new Set([
  "PL-S003",
  "PL-S057",
  "PL-S058",
  "PL-S059",
  "PL-S060",
  "PL-S061",
  "PL-S062",
]);

function ftpSourceCopy(value: PlanFtpSourceValue | null, empty: string): string {
  if (value === null) return empty;
  const refreshed = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value.refreshedAtMs);
  return `${value.watts} W · ${refreshed}`;
}

function FtpSourceRow(props: {
  readonly label: string;
  readonly value: PlanFtpSourceValue | null;
  readonly empty: string;
  readonly selected: boolean;
}): ReactElement {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-inset">
      <span className="text-sm font-medium">{props.label}</span>
      <span className={props.selected ? "text-sm text-primary" : "text-sm text-ink-2"}>
        {ftpSourceCopy(props.value, props.empty)}
        {props.selected ? " · Used for this Draft" : ""}
      </span>
    </div>
  );
}

function FtpResolution(props: { readonly ftp: PlanFtpProjection }): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const [watts, setWatts] = useState(
    props.ftp.manual === null ? "" : String(props.ftp.manual.watts),
  );
  const [validation, setValidation] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "refresh" | null>(null);
  const busy =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T04";
  const failure =
    transition.status === "failed" && transition.transitionId === "PL-T04"
      ? transition.error.message
      : null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const value = Number(watts);
    if (!/^\d{1,4}$/u.test(watts) || !Number.isSafeInteger(value) || value < 1) {
      setValidation("Enter 1–9999 whole watts.");
      return;
    }
    setValidation(null);
    setPending("save");
    actions?.saveFtp(value);
  };
  const notice =
    failure ??
    validation ??
    (model?.scenarioId === "PL-S058"
      ? "No FTP was found in Intervals. Enter watts or refresh again."
      : model?.scenarioId === "PL-S060"
        ? "Sources differ. The highest-precedence value is selected for this Draft."
        : model?.scenarioId === "PL-S062"
          ? "FTP saved. Returning to your Plan coach…"
          : null);
  const scenario = busy && pending === "refresh" ? "PL-S057" : model?.scenarioId;
  const accepted = model?.scenarioId === "PL-S062";

  return (
    <section
      className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1"
      data-plan-scenario={scenario}
    >
      <div className="flex items-start gap-row">
        {accepted ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
        )}
        <div className={SUPPORT_PAIR}>
          <h2 className="m-0 text-base font-semibold">
            FTP needed before we build your cycling block
          </h2>
          <p className="m-0 text-ink-2">Power targets require an FTP value.</p>
        </div>
      </div>
      <form className="flex flex-wrap items-start gap-inset" onSubmit={submit}>
        <div className={SUPPORT_PAIR}>
          <label className="sr-only" htmlFor="plan-ftp-watts">
            FTP in whole watts
          </label>
          <div className="flex items-center gap-2">
            <input
              id="plan-ftp-watts"
              className="h-ctl w-28 rounded-ctl border border-line-2 bg-sunk px-3 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
              inputMode="numeric"
              maxLength={4}
              placeholder="e.g. 282"
              value={watts}
              disabled={busy}
              aria-invalid={validation === null ? undefined : "true"}
              aria-describedby={notice === null ? undefined : "plan-ftp-notice"}
              onChange={(event) => setWatts(event.currentTarget.value.replace(/\D/gu, ""))}
            />
            <span className="text-sm text-ink-2">W</span>
          </div>
        </div>
        <Button type="submit" disabled={actions === null || busy || watts.length === 0}>
          {busy && pending === "save" ? "Saving…" : "Save"}
        </Button>
      </form>
      {notice === null ? null : (
        <div
          id="plan-ftp-notice"
          className={`rounded-ctl p-3 text-sm ${model?.scenarioId === "PL-S062" ? "bg-[color-mix(in_srgb,var(--ok)_10%,var(--surface))] text-ok" : "bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] text-ink"}`}
          role="status"
        >
          {notice}
        </div>
      )}
      <section aria-labelledby="plan-ftp-source-status">
        <h3 id="plan-ftp-source-status" className="m-0 text-sm font-medium">
          Source status
        </h3>
        <div className="mt-inset divide-y divide-line">
          <FtpSourceRow
            label="Athlete-entered FTP"
            value={props.ftp.manual}
            empty="Not entered"
            selected={props.ftp.usedSource === "manual"}
          />
          <FtpSourceRow
            label="Intervals FTP"
            value={props.ftp.intervalsFtp}
            empty="Not found"
            selected={props.ftp.usedSource === "intervals-ftp"}
          />
          <FtpSourceRow
            label="Intervals eFTP"
            value={props.ftp.intervalsEftp}
            empty="Not found"
            selected={props.ftp.usedSource === "intervals-eftp"}
          />
        </div>
      </section>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => {
            setPending("refresh");
            actions?.refreshFtp();
          }}
        >
          <RefreshCw
            className={busy && pending === "refresh" ? "animate-spin" : ""}
            aria-hidden="true"
          />
          {busy && pending === "refresh"
            ? "Refreshing…"
            : model?.scenarioId === "PL-S059"
              ? "Retry"
              : "Refresh Intervals"}
        </Button>
      </div>
    </section>
  );
}

function PlanCoach(): ReactElement {
  const composer = useRef<ComposerHandle>(null);
  const conversation = useRef<HTMLElement>(null);
  const followsLatest = useRef(true);
  const actions = useEnduragentStore((state) => state.planActions);
  const coach = useEnduragentStore((state) => state.plan.coach);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const [customDecisionOpen, setCustomDecisionOpen] = useState(false);
  const parsed = model === null ? null : PlanCoachProjectionDataSchema.safeParse(model.data);
  const data = parsed?.success === true ? parsed.data : null;
  const busy = transition.status === "submitting" || transition.status === "running";
  const draftFormationFailed =
    transition.status === "failed" && transition.transitionId === "PL-T06";
  const ready =
    data?.readyToCreateDraft === true &&
    (model?.scenarioId === "PL-S016" || model?.scenarioId === "PL-S103");
  const messages =
    coach.messages.length > 0
      ? coach.messages
      : (data?.messages.map((message) => ({
          id: message.id,
          ...(message.turnId === null ? {} : { turnId: message.turnId }),
          role: message.role,
          text: message.text,
          delivery: "complete" as const,
          historical: false,
        })) ?? []);
  const decision = coach.decision ?? data?.decision ?? null;
  const latestMessage = messages.at(-1);
  const scrollRevision = `${messages.length}:${latestMessage?.id ?? ""}:${latestMessage?.text.length ?? 0}:${coach.status}`;

  useEffect(() => {
    composer.current?.focus();
  }, [model?.scenarioId]);

  useEffect(() => {
    const target = conversation.current;
    if (target === null) return;
    const onScroll = (): void => {
      followsLatest.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 80;
    };
    onScroll();
    target.addEventListener("scroll", onScroll);
    return () => target.removeEventListener("scroll", onScroll);
  }, [model?.scenarioId, ready]);

  useLayoutEffect(() => {
    const target = conversation.current;
    if (target !== null && followsLatest.current) target.scrollTop = target.scrollHeight;
  }, [ready, scrollRevision]);

  if (model?.scenarioId === "PL-S102") {
    return (
      <section
        className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1"
        data-plan-scenario="PL-S102"
      >
        <div className="flex flex-col gap-row sm:flex-row sm:items-start sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-lg font-semibold">Plan conversation</h2>
            <p className="m-0 text-ink-2">Read-only history for this ended Plan.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => actions?.closeEndedConversation()}>
            Back to ended Plan
          </Button>
        </div>
        <div className="border-t border-line pt-row">
          <ConversationTranscript
            messages={messages}
            timeline={coach.timeline}
            historyControls={false}
          />
        </div>
      </section>
    );
  }

  if (data?.ftp !== undefined && data.ftp !== null && FTP_SCENARIOS.has(model?.scenarioId ?? "")) {
    return <FtpResolution ftp={data.ftp} />;
  }

  if (ready) {
    const weekdayLabels: Record<string, string> = {
      mon: "Monday",
      tue: "Tuesday",
      wed: "Wednesday",
      thu: "Thursday",
      fri: "Friday",
      sat: "Saturday",
      sun: "Sunday",
    };
    const intake = data?.intake;
    const ftp = data?.ftp;
    const course = data?.course;
    const sourceLabel =
      ftp?.usedSource === "intervals-ftp"
        ? "Intervals FTP"
        : ftp?.usedSource === "intervals-eftp"
          ? "Intervals eFTP"
          : ftp?.usedSource === "manual"
            ? "Athlete-entered FTP"
            : null;
    return (
      <section
        className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1"
        data-plan-scenario={model?.scenarioId}
      >
        <ConversationTranscript
          messages={messages}
          timeline={coach.timeline}
          historyControls={false}
        />
        <section className="grid gap-row rounded-card bg-sunk p-4">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-sm font-medium">Ready to create Draft</h2>
            <p className="m-0 text-ink-2">
              Goal event, availability, FTP, and course choice are ready.
            </p>
          </div>
          {intake === undefined ? null : (
            <dl className="m-0 grid gap-0 border-y border-line">
              <div className="grid gap-1 py-row">
                <dt className="text-sm font-medium">Goal event</dt>
                <dd className="m-0 text-sm text-ink-2">
                  {intake.eventName} · {intake.eventPriority} priority · {intake.eventDate}
                </dd>
                <dd className="m-0 text-sm text-ink-2">{intake.goal}</dd>
              </div>
              <div className="grid gap-1 border-t border-line py-row">
                <dt className="text-sm font-medium">Availability</dt>
                <dd className="m-0 text-sm text-ink-2">
                  {intake.availabilityWeekdays.map((day) => weekdayLabels[day]).join(" · ")}
                </dd>
              </div>
              <div className="grid gap-1 border-t border-line py-row">
                <dt className="text-sm font-medium">FTP</dt>
                <dd className="m-0 text-sm text-ink-2">
                  {ftp?.usedWatts} W{sourceLabel === null ? "" : ` · ${sourceLabel}`}
                </dd>
              </div>
              <div className="grid gap-1 border-t border-line py-row">
                <dt className="text-sm font-medium">Race Course</dt>
                <dd className="m-0 text-sm text-ink-2">
                  {course?.accepted?.fileName ?? "Course-agnostic"}
                </dd>
              </div>
            </dl>
          )}
          {draftFormationFailed ? (
            <div
              className="grid gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3"
              role="alert"
            >
              <div className="flex items-start gap-row">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
                <div className={SUPPORT_PAIR}>
                  <h3 className="m-0 text-sm font-medium">Draft wasn’t created</h3>
                  <p className="m-0 text-ink-2">{transition.error.message}</p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={() => actions?.retry()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap justify-end gap-inset pt-inset">
            <Button
              type="button"
              variant="outline"
              disabled={actions === null || busy}
              onClick={() => actions?.backToCoachInterview()}
            >
              Back to coach
            </Button>
            <Button
              type="button"
              disabled={actions === null || busy}
              onClick={() => actions?.createDraft()}
            >
              {data?.replacement ? "Create replacement draft" : "Create draft"}
            </Button>
          </div>
        </section>
      </section>
    );
  }

  const course = data?.course;
  const courseVisible =
    course !== undefined && course.status !== "undecided" && course.status !== "omitted";

  return (
    <section
      className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]"
      data-plan-scenario={model?.scenarioId}
      aria-label="Plan coach"
    >
      <main
        ref={conversation}
        className="min-h-0 overflow-auto pt-[calc(var(--inset)*4)] pb-[calc(var(--inset)*3)] [overflow-anchor:none] max-[760px]:pt-[calc(var(--inset)*3)]"
        aria-label="Plan coaching conversation"
      >
        <div className="mx-auto grid w-[min(720px,calc(100%-48px))] gap-6 max-[760px]:w-[calc(100%-32px)]">
          {model?.scenarioId === "PL-S020" ? (
            <div className="flex items-start gap-row text-ok" role="status">
              <CheckCircle2 className="mt-0.5 size-4" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-base font-medium text-ink">Draft discarded</h2>
                <p className="m-0 text-ink-2">Your Plan conversation is still here.</p>
              </div>
            </div>
          ) : null}
          {data?.ftp?.conflict === true && data.ftp.usedWatts !== null ? (
            <div
              className="rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3 text-sm"
              role="status"
            >
              Using {data.ftp.usedWatts} W from the selected FTP source. Other FTP sources differ.
            </div>
          ) : null}
          <ConversationTranscript
            messages={messages}
            timeline={coach.timeline}
            historyControls={false}
          />
          {data?.missingDraftRequirements?.includes("date") === true ? (
            <div
              className="flex items-start gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3"
              role="status"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-medium">Choose another Goal Event date</h2>
                <p className="m-0 text-ink-2">Use a date from today through 24 weeks from now.</p>
              </div>
            </div>
          ) : null}
          <CoachDecisionPanel
            onCustomOpenChange={setCustomDecisionOpen}
            surface={{
              decision,
              phase: coach.decisionPhase,
              answerLabel: coach.decisionAnswerLabel,
              error: coach.decisionError,
              loadError: coach.decisionLoadError,
              answer: (decisionId, answer) => actions?.answerCoachDecision(decisionId, answer),
              skip: (decisionId) => actions?.skipCoachDecision(decisionId),
              retry: () => actions?.retry(),
            }}
          />
          <PlanQueue />
          {courseVisible && course !== undefined ? (
            <RaceCoursePanel course={course} draft={false} />
          ) : null}
        </div>
      </main>
      <div className="z-2 bg-bg bg-[linear-gradient(transparent,var(--bg)_22%)] px-[max(24px,calc((100%-720px)/2))] pt-[calc(var(--inset)*3)] pb-row max-[760px]:px-[calc(var(--inset)*2)]">
        <Composer
          handle={composer}
          inputId="plan-coach-composer"
          hidden={customDecisionOpen}
          leadingAction={
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach Race Course"
                disabled={actions === null || busy || coach.status === "streaming"}
                onClick={() => actions?.openCoursePicker()}
              >
                <Paperclip aria-hidden="true" />
              </Button>
              {course?.status === "undecided" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={actions === null || busy || coach.status === "streaming"}
                  onClick={() => actions?.continueWithoutCourse()}
                >
                  Continue without course
                </Button>
              ) : null}
            </div>
          }
          surface={{
            status: coach.status,
            sendDisabled: coach.sendDisabled,
            inputDisabled: coach.inputDisabled || decision?.status === "unanswered",
            placeholder: "Reply to your coach…",
            label: "Reply to your Plan coach",
            allowSlashCommands: false,
            submit: (message) => actions?.submitCoach(message) ?? Promise.resolve(false),
            stop: () => actions?.stopCoach(),
          }}
        />
      </div>
    </section>
  );
}

function DraftFormation(): ReactElement {
  const transition = useEnduragentStore((state) => state.plan.transition);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const revision = transition.status === "running" && transition.transitionId === "PL-T07";
  const replacement = model?.lifecycle === "replacement-draft-forming";
  return (
    <ArtifactCard
      headingLevel={2}
      aria-live="polite"
      aria-busy="true"
      title={
        revision
          ? "Updating your Draft"
          : replacement
            ? "Building the replacement Draft"
            : "Building your Draft"
      }
      summary={
        revision
          ? "Your previous Draft stays available until this update is complete."
          : replacement
            ? "Your current Plan stays active. The replacement Draft opens automatically."
            : "Your Draft opens automatically when it is ready."
      }
    >
      <ProgressDisplay
        className="px-4 pb-4"
        label={
          revision
            ? "Updating your Draft"
            : replacement
              ? "Building the replacement Draft"
              : "Building your Draft"
        }
        value={{ kind: "indeterminate" }}
      />
    </ArtifactCard>
  );
}

function DiscardDraftDialog(): ReactElement {
  const open = useEnduragentStore((state) => state.plan.discardConfirmation);
  const actions = useEnduragentStore((state) => state.planActions);
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) actions?.closeDiscardConfirmation();
      }}
    >
      <DialogContent
        className="w-[min(460px,calc(100vw-32px))] max-w-none gap-0 p-6 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancel}
      >
        <DialogHeader className="gap-2.5">
          <DialogTitle className="m-0 text-xl">Discard this Draft?</DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            Only this Draft is removed. Your Plan conversation and active Plan stay.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="destructive-solid"
            size="lg"
            onClick={() => actions?.discardDraft()}
          >
            Discard Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DatePreview {
  readonly kind: "full-plan" | "short-race-preparation";
  readonly inclusiveDays: number;
  readonly totalWeeks: number;
  readonly raceWeekday: number;
  readonly raceDayOfPlanWeek: number;
}

function localDatePreview(startDate: string, targetDate: string): DatePreview {
  const inclusiveDays = civilDays(startDate, targetDate);
  return {
    kind: inclusiveDays >= PLAN_MIN_FULL_DAYS ? "full-plan" : "short-race-preparation",
    inclusiveDays,
    totalWeeks: Math.ceil(inclusiveDays / 7),
    raceWeekday: weekdayIndex(targetDate),
    raceDayOfPlanWeek: ((inclusiveDays - 1) % 7) + 1,
  };
}

function DatePickerDialog(props: {
  readonly plan: PlanDraftPlanProjection | null;
  readonly startDate: PlanStartDateProjection | undefined;
}): ReactElement {
  const open = useEnduragentStore((state) => state.plan.datePicker);
  const actions = useEnduragentStore((state) => state.planActions);
  const cancel = useRef<HTMLButtonElement>(null);
  const initialDate = props.startDate?.selectedDate ?? props.plan?.startDate ?? "";
  const [selected, setSelected] = useState(initialDate);
  const initial = initialDate.length === 0 ? new Date() : civilDate(initialDate);
  const [visibleMonth, setVisibleMonth] = useState(() => ({
    year: initial.getUTCFullYear(),
    month: initial.getUTCMonth(),
  }));

  useEffect(() => {
    if (!open || initialDate.length === 0) return;
    const date = civilDate(initialDate);
    setSelected(initialDate);
    setVisibleMonth({ year: date.getUTCFullYear(), month: date.getUTCMonth() });
  }, [initialDate, open]);

  const today = props.startDate?.today;
  const targetDate = props.startDate?.targetDate ?? props.plan?.targetDate ?? undefined;
  const preview =
    selected.length === 0 || targetDate === undefined
      ? null
      : localDatePreview(selected, targetDate);
  const scenario =
    preview?.kind === "short-race-preparation"
      ? "PL-S044"
      : preview !== null && preview.raceWeekday !== 0
        ? "PL-S045"
        : "PL-S015";
  const first = new Date(Date.UTC(visibleMonth.year, visibleMonth.month, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - mondayOffset);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    return {
      value: civilText(date),
      label: date.getUTCDate(),
      currentMonth: date.getUTCMonth() === visibleMonth.month,
    };
  });
  const monthLabel = new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(first);
  const moveMonth = (offset: number): void => {
    const next = new Date(Date.UTC(visibleMonth.year, visibleMonth.month + offset, 1));
    setVisibleMonth({ year: next.getUTCFullYear(), month: next.getUTCMonth() });
  };
  const valid = (value: string): boolean =>
    today !== undefined && targetDate !== undefined && value >= today && value <= targetDate;
  const selectAndFocus = (value: string): void => {
    if (!valid(value)) return;
    setSelected(value);
    const date = civilDate(value);
    if (date.getUTCMonth() !== visibleMonth.month || date.getUTCFullYear() !== visibleMonth.year) {
      setVisibleMonth({ year: date.getUTCFullYear(), month: date.getUTCMonth() });
    }
    queueMicrotask(() => {
      document.querySelector<HTMLButtonElement>(`[data-plan-date="${value}"]`)?.focus();
    });
  };

  const primaryLabel =
    preview?.kind === "short-race-preparation"
      ? "Use short block"
      : preview !== null && preview.raceWeekday !== 0
        ? "Use this date"
        : "Recalculate Plan";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) actions?.closeDatePicker();
      }}
    >
      <DialogContent
        className="w-[min(380px,calc(100vw-32px))] max-w-none gap-0 p-4 shadow-elev-4 sm:max-w-none"
        showCloseButton={false}
        initialFocus={cancel}
        data-plan-scenario={scenario}
      >
        <DialogHeader className="gap-2.5">
          <DialogTitle className="m-0 text-xl">Choose a start date</DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            Past dates are unavailable. Shorter blocks stay valid; weekly preferences keep their
            weekdays.
          </DialogDescription>
        </DialogHeader>
        <section className="mt-5" aria-label="Plan start date calendar">
          <div className="grid grid-cols-[40px_1fr_40px] items-center gap-inset">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Previous month"
              onClick={() => moveMonth(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <h3 className="m-0 text-center text-base font-semibold">{monthLabel}</h3>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Next month"
              onClick={() => moveMonth(1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <div className="mt-inset grid grid-cols-7 gap-1" aria-hidden="true">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday} className="py-1 text-center text-xs text-ink-2">
                {weekday}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1" role="group" aria-label={monthLabel}>
            {days.map((day) => {
              const disabled = !valid(day.value);
              const active = day.value === selected;
              return (
                <button
                  key={day.value}
                  type="button"
                  data-plan-date={day.value}
                  aria-label={formatCivilDate(day.value, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                  aria-pressed={active}
                  disabled={disabled}
                  tabIndex={active ? 0 : -1}
                  className={`grid size-8 place-items-center justify-self-center rounded-ctl text-sm outline-none transition-colors focus:ring-3 focus:ring-ring/25 ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : disabled
                        ? "cursor-not-allowed bg-sunk text-ink-3 opacity-55"
                        : day.currentMonth
                          ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-sunk"
                          : "bg-sunk text-ink-2 hover:text-ink"
                  }`}
                  onClick={() => selectAndFocus(day.value)}
                  onKeyDown={(event) => {
                    const offset =
                      event.key === "ArrowLeft"
                        ? -1
                        : event.key === "ArrowRight"
                          ? 1
                          : event.key === "ArrowUp"
                            ? -7
                            : event.key === "ArrowDown"
                              ? 7
                              : 0;
                    if (offset === 0) return;
                    event.preventDefault();
                    selectAndFocus(addCivilDate(day.value, offset));
                  }}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
        </section>
        {preview === null || targetDate === undefined ? null : (
          <section className="mt-5 grid gap-row rounded-card bg-sunk p-4" aria-live="polite">
            <div className={SUPPORT_PAIR}>
              <h3 className="m-0 text-sm font-semibold">
                {preview.kind === "full-plan" ? "Full Plan" : "Short race-preparation block"}
              </h3>
              <p className="m-0 text-ink-2">
                {formatCivilDate(selected)} to {formatCivilDate(targetDate)} · {preview.totalWeeks}{" "}
                {preview.totalWeeks === 1 ? "week" : "weeks"} · {preview.inclusiveDays} inclusive
                days
              </p>
            </div>
            {preview.raceWeekday === 0 ? null : (
              <p className="m-0 text-sm text-ink-2">
                Race day stays {formatCivilDate(targetDate, { weekday: "long" })}; the Plan week
                follows the selected start weekday.
              </p>
            )}
          </section>
        )}
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            size="lg"
            disabled={
              actions === null ||
              preview === null ||
              selected === props.plan?.startDate ||
              !valid(selected)
            }
            onClick={() => actions?.recalculateStartDate(selected)}
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DraftProjection(): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const revisionComposer = useEnduragentStore((state) => state.plan.revisionComposer);
  const [instruction, setInstruction] = useState("");
  const replacementCancel = useRef<HTMLButtonElement>(null);
  const parsed = model === null ? null : PlanCoachProjectionDataSchema.safeParse(model.data);
  const data = parsed?.success === true ? parsed.data : null;
  const plan = data?.plan ?? null;
  const startDate = data?.startDate;
  const dateRunning = transition.status === "running" && transition.transitionId === "PL-T08";
  const revisionFailed = transition.status === "failed" && transition.transitionId === "PL-T07";
  const retryingDate = dateRunning && model?.scenarioId === "PL-S048";
  const replacement = data?.replacement === true;
  const approving =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T11" || transition.transitionId === "PL-T26");
  const busy = dateRunning || approving;
  const displayScenario = revisionComposer
    ? "PL-S029"
    : retryingDate
      ? "PL-S049"
      : dateRunning
        ? "PL-S047"
        : model?.scenarioId;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (/\S/u.test(instruction)) actions?.updateDraft(instruction);
  };
  return (
    <div className="grid gap-6" data-plan-scenario={displayScenario}>
      {dateRunning ? (
        <section
          className="flex items-start gap-row rounded-card bg-surface p-5 shadow-elev-1"
          aria-live="polite"
        >
          <LoaderCircle
            className="mt-0.5 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">Recalculating the Plan</h2>
            <p className="m-0 text-ink-2">
              Race day and weekly availability stay fixed. Your previous Draft remains safe.
            </p>
          </div>
        </section>
      ) : null}
      <ArtifactCard
        headingLevel={2}
        title={plan?.name ?? model?.title ?? "Draft Plan"}
        summary={
          <>
            {plan === null
              ? model?.summary
              : `${plan.workoutCount} workouts · ${plannedTime(plan.plannedDurationS)} · ${plan.phaseSummary?.join(" → ") ?? `${plan.totalWeeks} ${plan.totalWeeks === 1 ? "week" : "weeks"}`}`}
            <p className="m-0">Calendar not started.</p>
          </>
        }
        status="Draft"
      >
        <div className="grid gap-5 px-4 pb-4">
          {replacement ? (
            <div className="flex items-start gap-row rounded-ctl bg-sunk p-3">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-semibold">Current Plan stays active</h2>
                <p className="m-0 text-ink-2">
                  It changes only after you approve this replacement Draft.
                </p>
              </div>
            </div>
          ) : null}
          {model?.scenarioId === "PL-S031" ? (
            <div className="flex items-start gap-row text-ok" role="status">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-semibold text-ink">Draft updated</h2>
                <p className="m-0 text-ink-2">The coach applied your requested change.</p>
              </div>
            </div>
          ) : null}
          {model?.scenarioId === "PL-S050" ? (
            <div className="flex items-start gap-row text-ok" role="status">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-semibold text-ink">Start date updated</h2>
                <p className="m-0 text-ink-2">Review the recalculated Draft before approval.</p>
              </div>
            </div>
          ) : null}
          {model?.scenarioId === "PL-S046" || model?.scenarioId === "PL-S048" ? (
            <div
              className="grid gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3"
              role="alert"
            >
              <div className="flex items-start gap-row">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
                <div className={SUPPORT_PAIR}>
                  <h2 className="m-0 text-sm font-semibold">
                    {model.scenarioId === "PL-S046"
                      ? "Choose another start date"
                      : "The Plan could not be recalculated"}
                  </h2>
                  <p className="m-0 text-ink-2">Your current Draft is safe.</p>
                </div>
              </div>
              <div className="flex justify-end gap-inset">
                <Button type="button" variant="outline" onClick={() => actions?.openDatePicker()}>
                  Choose another date
                </Button>
                {model.scenarioId === "PL-S048" ? (
                  <Button type="button" onClick={() => actions?.retry()}>
                    Retry
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {revisionFailed && !revisionComposer ? (
            <div className="grid gap-inset">
              <StaleNotice message={transition.error.message} />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => actions?.openRevisionComposer()}
                >
                  Try another change
                </Button>
              </div>
            </div>
          ) : null}
          {transition.status === "failed" &&
          (transition.transitionId === "PL-T11" || transition.transitionId === "PL-T26") ? (
            <StaleNotice message="The Plan could not be activated. Your Draft is unchanged." />
          ) : null}
          {data?.course !== undefined ? (
            <div className="border-t border-line pt-5">
              <RaceCoursePanel course={data.course} draft />
            </div>
          ) : null}
          {plan !== null && startDate !== undefined ? (
            <div className="flex items-center justify-between gap-row border-t border-line pt-5">
              <div className="flex min-w-0 items-start gap-row">
                <CalendarDays className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <div className={SUPPORT_PAIR}>
                  <h3 className="m-0 text-sm font-semibold">Start date</h3>
                  <p className="m-0 text-ink-2">
                    {formatCivilDate(plan.startDate)} ·{" "}
                    {plan.kind === "full-plan" ? "Full Plan" : "Short race-preparation block"}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={actions === null || busy}
                onClick={() => actions?.openDatePicker()}
              >
                Change
              </Button>
            </div>
          ) : null}
          {revisionComposer ? (
            <form className="grid gap-inset border-t border-line pt-5" onSubmit={submit}>
              <label className="text-sm font-medium" htmlFor="plan-draft-revision">
                What should the coach change?
              </label>
              <textarea
                id="plan-draft-revision"
                autoFocus
                rows={4}
                className="resize-y rounded-ctl border border-line-2 bg-sunk px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
                value={instruction}
                onChange={(event) => setInstruction(event.currentTarget.value)}
              />
              <div className="flex justify-end gap-inset">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => actions?.closeRevisionComposer()}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={!/\S/u.test(instruction)}>
                  Update draft
                </Button>
              </div>
            </form>
          ) : (
            <div className="grid gap-row border-t border-line pt-5">
              <div className="flex flex-wrap items-center justify-between gap-row">
                <p className="m-0 text-sm text-ink-2">
                  {replacement
                    ? "Approval swaps Plans locally. New calendar writing waits for old cleanup verification."
                    : "Approval activates the Plan, then updates today plus the next six days in Intervals."}
                </p>
                <div className="flex flex-wrap justify-end gap-inset">
                  <Button
                    id={replacement ? "plan-approve-replacement" : undefined}
                    type="button"
                    variant="outline"
                    disabled={actions === null || busy}
                    onClick={() => actions?.openRevisionComposer()}
                  >
                    Back to coach
                  </Button>
                  <Button
                    type="button"
                    disabled={actions === null || busy}
                    aria-busy={approving ? "true" : undefined}
                    onClick={() => actions?.approveDraft()}
                  >
                    {approving
                      ? replacement
                        ? "Checking…"
                        : "Activating…"
                      : replacement
                        ? "Approve replacement"
                        : "Approve Plan"}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-row border-t border-line pt-5">
                <p className="m-0 text-sm text-ink-2">
                  Discard removes only this Draft. Your Plan conversation stays.
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={actions === null || busy}
                  onClick={() => actions?.openDiscardConfirmation()}
                >
                  Discard draft
                </Button>
              </div>
            </div>
          )}
        </div>
      </ArtifactCard>
      <DiscardDraftDialog />
      <DatePickerDialog plan={plan} startDate={startDate} />
      <Dialog
        open={model?.scenarioId === "PL-S081"}
        onOpenChange={(open) => {
          if (!open) actions?.closeReplacementConfirmation();
        }}
      >
        <DialogContent initialFocus={replacementCancel} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Replace the active Plan?</DialogTitle>
            <DialogDescription>
              The old Plan ends and the replacement activates locally together. Today's workout
              stays. New calendar writing waits for old cleanup verification.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={replacementCancel}
              type="button"
              variant="outline"
              onClick={() => actions?.closeReplacementConfirmation()}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => actions?.confirmReplacement()}>
              Replace Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AttentionProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const actions = useEnduragentStore((state) => state.planActions);
  if (model === null) return <StatusCard title="Plan attention" support="Refreshing your Plan…" />;
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <h2 className="m-0 text-base font-medium">Plan attention</h2>
        <p className="m-0 text-ink-2">
          {model.attention.count} {model.attention.count === 1 ? "item needs" : "items need"} your
          decision.
        </p>
      </div>
      <div className="grid divide-y divide-line">
        {model.attention.items.map((item) => (
          <button
            key={item.id}
            id={`plan-attention-${item.id}`}
            type="button"
            className="flex w-full items-center justify-between gap-inset bg-transparent py-3 text-left text-sm hover:text-primary"
            onClick={() => actions?.openAttention(item.id)}
          >
            <span>{item.title}</span>
            <ChevronRight className="size-4 text-ink-2" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

function WorkoutDriftProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly scenarioId: string;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const selected =
    props.data.selectedWorkoutId === undefined || props.data.selectedWorkoutId === null
      ? null
      : (props.data.selectedWorkout ??
        props.data.workouts.find((workout) => workout.id === props.data.selectedWorkoutId) ??
        null);
  if (selected === null) {
    return <StatusCard title="Workout changed in Intervals" support="Refreshing this workout…" />;
  }
  const resolving =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T15" || transition.transitionId === "PL-T16");
  const adopted = props.scenarioId === "PL-S034";
  const restored = props.scenarioId === "PL-S036";
  const drift = selected.drift;
  const heading = resolving
    ? transition.transitionId === "PL-T15"
      ? "Updating the Plan"
      : "Restoring Plan workout"
    : adopted
      ? "Intervals edit adopted"
      : restored
        ? "Plan workout restored"
        : `${formatCivilDate(selected.date, { weekday: "long" })} changed in Intervals`;
  const support = resolving
    ? transition.transitionId === "PL-T15"
      ? `Keeping the Intervals workout and recording the adopted edit in Plan history.`
      : `Writing the Plan workout back to Intervals and verifying the match.`
    : adopted
      ? `${selected.name} is now ${
          selected.durationS === null ? "updated" : plannedTime(selected.durationS)
        } in both the Plan and Intervals.`
      : restored
        ? `${selected.name} matches the Plan again in Intervals.`
        : "Choose which version becomes authoritative.";
  return (
    <div className="grid gap-6">
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex items-start gap-row">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">
              Plan active · week {props.data.weekIndex} of {props.data.plan.totalWeeks}
            </h2>
            <p className="m-0 text-ink-2">
              {props.data.plan.name} · starts {formatCivilDate(props.data.plan.startDate)}
            </p>
          </div>
        </div>
      </section>
      <section
        className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1"
        aria-live="polite"
      >
        <div className="flex items-start gap-row">
          {resolving ? (
            <LoaderCircle
              className="mt-0.5 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : adopted || restored ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          ) : (
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          )}
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">{heading}</h2>
            <p className="m-0 text-ink-2">{support}</p>
          </div>
        </div>
        {!resolving && !adopted && !restored && drift !== undefined ? (
          <>
            <div className="grid gap-inset rounded-card bg-sunk p-row sm:grid-cols-2">
              <div className={SUPPORT_PAIR}>
                <p className="m-0 text-sm text-ink-2">Plan</p>
                <p className="m-0 font-medium">{drift.plan.name}</p>
                <p className="m-0 text-sm text-ink-2">
                  {formatCivilDate(drift.plan.date)} ·{" "}
                  {drift.plan.durationS === null
                    ? "No duration"
                    : plannedTime(drift.plan.durationS)}
                </p>
              </div>
              <div className={SUPPORT_PAIR}>
                <p className="m-0 text-sm text-ink-2">Intervals</p>
                <p className="m-0 font-medium">{drift.provider.name}</p>
                <p className="m-0 text-sm text-ink-2">
                  {formatCivilDate(drift.provider.date)} ·{" "}
                  {drift.provider.durationS === null
                    ? "No duration"
                    : plannedTime(drift.provider.durationS)}
                </p>
              </div>
            </div>
            {drift.error === null ? null : (
              <div
                className="flex items-start gap-row rounded-ctl bg-[color-mix(in_srgb,var(--danger)_8%,var(--surface))] p-3"
                role="alert"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <p className="m-0 text-sm text-ink-2">{drift.error.message}</p>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-inset">
              <Button
                type="button"
                variant="outline"
                disabled={actions === null || resolving}
                onClick={() => actions?.resolveWorkoutDrift(selected.id, drift.eventId, "adopt")}
              >
                Adopt Intervals edit
              </Button>
              <Button
                type="button"
                disabled={actions === null || resolving}
                onClick={() => actions?.resolveWorkoutDrift(selected.id, drift.eventId, "restore")}
              >
                Restore Plan workout
              </Button>
            </div>
          </>
        ) : null}
        {!resolving && (adopted || restored) ? (
          <div className="flex justify-end">
            <Button type="button" onClick={() => actions?.closeWorkout()}>
              Back to Plan
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ReplacementLifecycleProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly scenarioId: string;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const replacement = props.data.replacement;
  if (replacement === undefined) {
    return <StatusCard title="Replacement Plan" support="Refreshing replacement history…" />;
  }
  const cleanupBusy =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T27";
  const mirrorBusy =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T28";
  const failed = props.scenarioId === "PL-S083" && !cleanupBusy;
  const verified = props.scenarioId === "PL-S085" && !mirrorBusy;
  const history = props.scenarioId === "PL-S087";
  const remaining = replacement.cleanupItems.filter((item) => item.status !== "verified");
  const headline = history
    ? "Replacement complete"
    : mirrorBusy || props.scenarioId === "PL-S086"
      ? "Writing today plus the next six days"
      : verified
        ? "Old cleanup verified"
        : failed
          ? "Old Plan cleanup needs attention"
          : cleanupBusy || props.scenarioId === "PL-S084"
            ? "Retrying old Plan cleanup"
            : "Replacement active locally";
  const support = history
    ? "The old cleanup verified before the replacement mirror was written."
    : mirrorBusy || props.scenarioId === "PL-S086"
      ? "The replacement is active while its rolling Intervals mirror is verified."
      : verified
        ? "No tomorrow-onward old Plan workouts remain. The replacement mirror can now write."
        : failed
          ? "The replacement stays active locally. Calendar writing is blocked until old cleanup is verified."
          : "The old Plan ended. Today stays while tomorrow-onward old workouts are removed and verified.";

  return (
    <section
      className="overflow-hidden rounded-card bg-surface shadow-elev-1"
      aria-live="polite"
      data-plan-scenario={props.scenarioId}
    >
      <div className="grid gap-5 p-5">
        <div className="flex items-start gap-row">
          {failed ? (
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          ) : verified || history ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          ) : (
            <LoaderCircle
              className="mt-0.5 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-lg font-semibold">{headline}</h2>
            <p className="m-0 text-ink-2">{support}</p>
          </div>
        </div>
        <div className="grid gap-inset border-t border-line pt-row text-sm">
          <div className="flex justify-between gap-row">
            <span>Active Plan</span>
            <strong>{props.data.plan.name}</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>Previous Plan</span>
            <strong>{replacement.previousPlan.name} · ended</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>Today</span>
            <strong>Preserved</strong>
          </div>
        </div>
        {failed && remaining.length > 0 ? (
          <div className="divide-y divide-line border-y border-line">
            {remaining.map((item) => (
              <div key={item.id} className="flex justify-between gap-row py-inset text-sm">
                <span>{formatCivilDate(item.date)}</span>
                <span className="text-warn">Still in Intervals</span>
              </div>
            ))}
          </div>
        ) : null}
        {history ? (
          <div className="grid gap-row border-t border-line pt-row text-sm">
            <div className={SUPPORT_PAIR}>
              <strong>{props.data.plan.name} activated</strong>
              <span className="text-ink-2">Local replacement committed</span>
            </div>
            <div className={SUPPORT_PAIR}>
              <strong>{replacement.previousPlan.name} cleanup verified</strong>
              <span className="text-ink-2">
                Today preserved; tomorrow-onward old workouts removed
              </span>
            </div>
            <div className={SUPPORT_PAIR}>
              <strong>Replacement mirror current</strong>
              <span className="text-ink-2">Today plus the next six civil dates</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-inset border-t border-line px-5 py-row">
        {failed ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={actions === null || cleanupBusy}
              onClick={() => actions?.verifyReplacementCleanup()}
            >
              Verify again
            </Button>
            <Button
              type="button"
              disabled={actions === null || cleanupBusy}
              onClick={() => actions?.retryReplacementCleanup()}
            >
              Retry cleanup
            </Button>
          </>
        ) : verified ? (
          <Button
            type="button"
            disabled={actions === null || mirrorBusy}
            onClick={() => actions?.writeReplacementMirror()}
          >
            Write next 7 days
          </Button>
        ) : history ? (
          <Button
            type="button"
            disabled={actions === null}
            onClick={() => actions?.openReplacementActivePlan()}
          >
            Open active Plan
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SeasonProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const season = props.data.season;
  if (season === undefined) {
    return (
      <StatusCard
        title="Season"
        support="Season details are unavailable. Return to Plan and try again."
      />
    );
  }
  const raceWeekAvailable = season.raceWeek !== null;
  return (
    <section className="grid overflow-hidden rounded-card bg-surface shadow-elev-1">
      <div className="grid gap-row p-5">
        <div className="flex flex-col gap-row sm:flex-row sm:items-start sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <h2
              id="plan-season-heading"
              tabIndex={-1}
              className="m-0 text-xl font-semibold outline-none"
            >
              Season
            </h2>
            <p className="m-0 text-ink-2">
              {props.data.plan.totalWeeks} weeks · {formatCivilDate(props.data.plan.startDate)}
              {props.data.plan.targetDate === null
                ? ""
                : `–${formatCivilDate(props.data.plan.targetDate)}`}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-inset">
            {raceWeekAvailable ? (
              <Button
                id="plan-race-week-trigger"
                type="button"
                variant="outline"
                onClick={() => actions?.openRaceWeek()}
              >
                Race week
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => actions?.closeSeason()}>
              Back to Plan
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-row border-t border-line pt-row sm:flex-row sm:items-start sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">{props.data.plan.name}</h3>
            <p className="m-0 text-sm text-ink-2">
              {props.data.plan.targetDate === null
                ? props.data.plan.primaryGoal
                : `${formatCivilDate(props.data.plan.targetDate, { weekday: "short", day: "numeric", month: "short" })} · ${props.data.plan.primaryGoal}`}
              {season.distanceKm === null ? "" : ` · ${season.distanceKm} km`}
            </p>
          </div>
          {season.priority === null ? null : (
            <span className="self-start rounded-full border border-warn px-3 py-1 text-sm text-warn">
              {season.priority} priority
            </span>
          )}
        </div>
        {season.constraint === null ? null : (
          <div
            className="flex items-start gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3"
            role="status"
          >
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <p className="m-0 font-medium">Constraint · {season.constraint.title}</p>
              <p className="m-0 text-sm text-ink-2">{season.constraint.detail}</p>
            </div>
          </div>
        )}
      </div>
      <div className="max-w-full overflow-x-auto border-t border-line">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="bg-sunk text-ink-2">
            <tr>
              <th scope="col" className="px-5 py-3 font-medium">
                Week
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Dates
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Phase
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Plan
              </th>
              <th scope="col" className="px-5 py-3 text-right font-medium">
                Hours
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {season.weeks.map((week) => {
              const status =
                week.status === "completed"
                  ? "Completed"
                  : week.status === "current"
                    ? "This week"
                    : week.status === "blocked"
                      ? "Blocked"
                      : "Planned";
              return (
                <tr
                  key={week.weekIndex}
                  aria-current={week.status === "current" ? "true" : undefined}
                  className={
                    week.status === "current"
                      ? "bg-[color-mix(in_srgb,var(--brand)_10%,var(--surface))]"
                      : "bg-surface"
                  }
                >
                  <th scope="row" className="px-5 py-row font-medium">
                    Wk {week.weekIndex}
                  </th>
                  <td className="px-5 py-row text-ink-2">
                    {formatCivilDate(week.startDate, { day: "numeric", month: "short" })}–
                    {formatCivilDate(week.endDate, { day: "numeric", month: "short" })}
                  </td>
                  <td className="px-5 py-row">{week.phase}</td>
                  <td
                    className={
                      week.status === "blocked" ? "px-5 py-row text-warn" : "px-5 py-row text-ink-2"
                    }
                  >
                    {status} · {week.purpose}
                  </td>
                  <td className="px-5 py-row text-right tabular-nums">
                    {decimalHours(week.plannedDurationS)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RaceWeekProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const season = props.data.season;
  const raceWeek = season?.raceWeek;
  if (season === undefined || raceWeek === null || raceWeek === undefined) {
    return <StatusCard title="Race week" support="This Plan has no goal-race week." />;
  }
  return (
    <section className="grid overflow-hidden rounded-card bg-surface shadow-elev-1">
      <div className="grid gap-row p-5">
        <div className="flex flex-col gap-row sm:flex-row sm:items-start sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <h2
              id="plan-race-week-heading"
              tabIndex={-1}
              className="m-0 text-xl font-semibold outline-none"
            >
              Race week
            </h2>
            <p className="m-0 text-ink-2">Final seven Plan days</p>
          </div>
          <Button type="button" variant="outline" onClick={() => actions?.closeRaceWeek()}>
            Back to Season
          </Button>
        </div>
        <div className="flex flex-col gap-row border-t border-line pt-row sm:flex-row sm:items-start sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <p className="m-0 text-sm font-medium uppercase tracking-wide text-warn">
              Race day ·{" "}
              {formatCivilDate(raceWeek.raceDate, {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}
            </p>
            <h3 className="m-0 text-lg font-semibold">{props.data.plan.name}</h3>
            <p className="m-0 text-sm text-ink-2">
              Goal: {props.data.plan.primaryGoal}
              {props.data.readiness?.courseEstimate.rangeMinutes === null ||
              props.data.readiness?.courseEstimate.rangeMinutes === undefined
                ? ""
                : ` · modeled finish ${finishRange(props.data.readiness.courseEstimate.rangeMinutes)} · with assumptions`}
            </p>
          </div>
          {season.priority === null ? null : (
            <span className="self-start rounded-full border border-warn px-3 py-1 text-sm text-warn">
              {season.priority} priority
            </span>
          )}
        </div>
        <div className="grid gap-row border-t border-line pt-row sm:grid-cols-3">
          {[
            ["Training", raceWeek.trainingDurationS],
            ["Race", raceWeek.raceDurationS],
            ["Total", raceWeek.totalDurationS],
          ].map(([label, value]) => (
            <div key={String(label)} className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">{label}</span>
              <strong className="text-2xl tabular-nums">{clockTime(Number(value))}</strong>
            </div>
          ))}
        </div>
        {props.data.matchSync?.awaitingSync === true ? (
          <div
            className="flex items-start gap-row rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3"
            role="status"
          >
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <p className="m-0 font-medium">Intervals sync is down</p>
              <p className="m-0 text-sm text-ink-2">
                Some race-week workouts may be missing in Intervals; the Plan below is
                authoritative.
              </p>
            </div>
          </div>
        ) : null}
      </div>
      <div className="max-w-full overflow-x-auto border-t border-line">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead className="bg-sunk text-ink-2">
            <tr>
              <th scope="col" className="px-5 py-3 font-medium">
                Day
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Workout
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Time
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                Purpose
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {raceWeek.days.map((day) => {
              return (
                <tr
                  key={day.date}
                  className={day.workoutId === null ? undefined : "hover:bg-surface-2"}
                >
                  <td className="px-5 py-row text-ink-2">{day.weekday}</td>
                  <td className="px-5 py-row font-medium">
                    {day.workoutId === null ? (
                      day.name
                    ) : (
                      <button
                        id={`race-week-workout-${day.workoutId}`}
                        type="button"
                        className="bg-transparent p-0 text-left font-medium text-ink underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        onClick={() => actions?.openWorkout(day.workoutId!)}
                      >
                        {day.name}
                      </button>
                    )}
                  </td>
                  <td className="px-5 py-row tabular-nums text-ink-2">
                    {day.durationS === null ? "—" : clockTime(day.durationS)}
                  </td>
                  <td
                    className={
                      day.kind === "race" || day.purpose === "Blocked"
                        ? "px-5 py-row text-warn"
                        : "px-5 py-row text-ink-2"
                    }
                  >
                    {day.purpose}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value).replace("-", "−");
}

function formRange(readiness: PlanReadinessProjection): string {
  const range = readiness.form.raceRange;
  if (range === null) return "Unavailable";
  return `${signed(range.min)} to ${signed(range.max)}`;
}

function PredictionsSummary(props: {
  readonly readiness: PlanReadinessProjection | undefined;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const atRisk = props.readiness?.feasibility.verdict === "at-risk";
  const verdict =
    props.readiness === undefined
      ? "Unavailable"
      : atRisk
        ? "At risk — here’s why"
        : "On track — with assumptions";
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <h2 className="m-0 text-base font-semibold">Predictions</h2>
      <div className="grid gap-row sm:grid-cols-2">
        <div className={SUPPORT_PAIR}>
          <p className="m-0 text-sm text-ink-2">Race-day form</p>
          <strong className="text-2xl">
            {props.readiness === undefined ? "Unavailable" : formRange(props.readiness)}
          </strong>
        </div>
        <div className={SUPPORT_PAIR}>
          <p className="m-0 text-sm text-ink-2">Goal feasibility</p>
          <span
            className={`inline-flex w-fit items-center gap-inset rounded-full border px-3 py-1 text-sm ${
              props.readiness === undefined
                ? "border-line-2 text-ink-2"
                : atRisk
                  ? "border-warn text-warn"
                  : "border-ok text-ok"
            }`}
          >
            {props.readiness === undefined ? null : atRisk ? (
              <TriangleAlert className="size-4" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="size-4" aria-hidden="true" />
            )}
            {verdict}
          </span>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          id="plan-readiness-trigger"
          type="button"
          variant="ghost"
          onClick={() => actions?.openReadiness()}
        >
          View race readiness
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

function effortDuration(durationS: number): string {
  const minutes = Math.floor(durationS / 60);
  const seconds = durationS % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ReadinessProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly scenarioId: string;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const readiness = props.data.readiness;
  const [overlay, setOverlay] = useState<"cp-info" | "cp-efforts" | "route" | null>(null);
  const cpInfoTrigger = useRef<HTMLButtonElement>(null);
  const cpEffortsTrigger = useRef<HTMLButtonElement>(null);
  const routeTrigger = useRef<HTMLButtonElement>(null);
  if (readiness === undefined) {
    return <StatusCard title="Race readiness" support="Readiness details are unavailable." />;
  }
  const refreshing =
    props.scenarioId === "PL-S098" ||
    ((transition.status === "submitting" || transition.status === "running") &&
      transition.transitionId === "PL-T32");
  const lastRefresh =
    readiness.form.lastSuccessfulRefreshAtMs === null
      ? "No successful refresh yet"
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(readiness.form.lastSuccessfulRefreshAtMs));
  const cp = readiness.estimatedCp;
  const closeOverlay = (next: boolean): void => {
    if (next) return;
    const previous = overlay;
    setOverlay(null);
    requestAnimationFrame(() => {
      if (previous === "cp-info") cpInfoTrigger.current?.focus();
      if (previous === "cp-efforts") cpEffortsTrigger.current?.focus();
      if (previous === "route") routeTrigger.current?.focus();
    });
  };
  const header = (
    <div className="flex flex-col gap-row sm:flex-row sm:items-start sm:justify-between">
      <div className={SUPPORT_PAIR}>
        <h2
          id="plan-readiness-heading"
          tabIndex={-1}
          className="m-0 text-xl font-semibold outline-none"
        >
          Race readiness
        </h2>
        <p className="m-0 text-ink-2">{props.data.plan.name} · modeled ranges and evidence</p>
      </div>
      <Button type="button" variant="outline" onClick={() => actions?.closeReadiness()}>
        Back to Plan
      </Button>
    </div>
  );
  if (refreshing) {
    return (
      <section className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1" aria-live="polite">
        {header}
        <div className="flex items-start gap-row border-t border-line pt-row">
          <LoaderCircle
            className="mt-0.5 size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">Refreshing training load</h3>
            <p className="m-0 text-ink-2">
              Checking recent training before recalculating the Form range. The last available
              readiness view stays safe.
            </p>
          </div>
        </div>
      </section>
    );
  }
  if (props.scenarioId === "PL-S078" && readiness.taperRefusal !== null) {
    return (
      <section className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1">
        {header}
        <div className="flex items-start gap-row border-t border-line pt-row">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">Hard Workout not added</h3>
            <p className="m-0 text-ink-2">{readiness.taperRefusal.reason}</p>
          </div>
        </div>
        <div className="grid gap-inset rounded-card bg-sunk p-row">
          <div className="flex items-start justify-between gap-row">
            <span className="text-ink-2">Requested</span>
            <strong className="text-right">{readiness.taperRefusal.requested}</strong>
          </div>
          <div className="flex items-start justify-between gap-row">
            <span className="text-ink-2">Kept in Plan</span>
            <strong className="text-right">{readiness.taperRefusal.kept}</strong>
          </div>
        </div>
        <p className="m-0 text-ink-2">The race-week Plan stays unchanged.</p>
      </section>
    );
  }
  if (props.scenarioId === "PL-S076") {
    return (
      <section className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1" role="alert">
        {header}
        <div className="flex items-start gap-row border-t border-line pt-row">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">Form is unavailable</h3>
            <p className="m-0 text-ink-2">
              {readiness.error?.message ??
                "Recent training load is incomplete, so a race-day Form range cannot be shown."}
            </p>
          </div>
        </div>
        <div className="grid gap-inset rounded-card bg-sunk p-row sm:grid-cols-2">
          <div className={SUPPORT_PAIR}>
            <span className="text-sm text-ink-2">Last successful refresh</span>
            <strong>{lastRefresh}</strong>
          </div>
          <div className={SUPPORT_PAIR}>
            <span className="text-sm text-ink-2">Course estimate</span>
            <strong>
              {readiness.courseEstimate.rangeMinutes === null
                ? "Unavailable"
                : finishRange(readiness.courseEstimate.rangeMinutes)}
            </strong>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={() => actions?.refreshReadiness()}>
            Retry refresh
          </Button>
        </div>
      </section>
    );
  }
  if (props.scenarioId === "PL-S077") {
    return (
      <>
        <section className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1">
          {header}
          <div className="flex items-start gap-row border-t border-line pt-row">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h3 className="m-0 text-base font-semibold">Finish-time range changed</h3>
              <p className="m-0 text-ink-2">
                {readiness.courseEstimate.changedAssumption ?? "A route assumption changed."}
              </p>
            </div>
          </div>
          <div className="grid gap-inset rounded-card bg-sunk p-row sm:grid-cols-2">
            <div className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">Previous</span>
              <strong className="text-xl">
                {readiness.courseEstimate.previousRangeMinutes === null
                  ? "Unavailable"
                  : finishRange(readiness.courseEstimate.previousRangeMinutes)}
              </strong>
            </div>
            <div className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">Updated</span>
              <strong className="text-xl">
                {readiness.courseEstimate.rangeMinutes === null
                  ? "Unavailable"
                  : finishRange(readiness.courseEstimate.rangeMinutes)}
              </strong>
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              ref={routeTrigger}
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => setOverlay("route")}
            >
              View assumptions →
            </Button>
          </div>
        </section>
        <Dialog open={overlay === "route"} onOpenChange={closeOverlay}>
          <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(440px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
            <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
              <DialogTitle>Route assumptions</DialogTitle>
              <DialogDescription>
                Inputs used for the course-based finish-time range.
              </DialogDescription>
            </DialogHeader>
            <ul className="m-0 grid flex-1 content-start gap-row overflow-auto px-10 py-5 text-ink-2">
              {readiness.courseEstimate.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
            <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
              <Button type="button" onClick={() => closeOverlay(false)}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }
  if (props.scenarioId === "PL-S074") {
    return (
      <section className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1">
        {header}
        <div className="grid gap-inset border-t border-line pt-row">
          <div className="flex items-center justify-between gap-row">
            <h3 className="m-0 text-base font-semibold">Goal feasibility</h3>
            <span className="rounded-full border border-danger px-3 py-1 text-sm text-danger">
              At risk
            </span>
          </div>
          <strong className="text-2xl">Form {formRange(readiness)}</strong>
          <ul className="m-0 grid gap-inset pl-5 text-ink-2">
            {readiness.feasibility.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
        <div className="flex items-start justify-between gap-row rounded-card bg-sunk p-row">
          <span className="text-ink-2">Recommendation</span>
          <strong className="text-right">{readiness.feasibility.recommendation}</strong>
        </div>
      </section>
    );
  }
  if (props.scenarioId === "PL-S075") {
    return (
      <section className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1">
        {header}
        <div className="flex items-start gap-row border-t border-line pt-row">
          <MapPinned className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">Finish-time estimate unavailable</h3>
            <p className="m-0 text-ink-2">
              A course with distance and elevation is required for this estimate.
            </p>
          </div>
        </div>
        <div className="grid gap-inset rounded-card bg-sunk p-row">
          <div className="flex justify-between gap-row">
            <span>Form trajectory</span>
            <strong>{formRange(readiness)}</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>Goal feasibility</span>
            <strong>Available</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>Course estimate</span>
            <strong>Unavailable</strong>
          </div>
        </div>
      </section>
    );
  }
  return (
    <>
      <section className="grid gap-6 rounded-card bg-surface p-5 shadow-elev-1">
        {header}
        <div className="grid gap-row border-t border-line pt-row md:grid-cols-2">
          <div className={`${SUPPORT_PAIR} rounded-card bg-sunk p-4`}>
            <h3 className="m-0 text-sm font-semibold">Form trajectory to race day</h3>
            <strong className="text-2xl">
              {readiness.form.current === null ? "Unavailable" : signed(readiness.form.current)} →{" "}
              {formRange(readiness)}
            </strong>
            <p className="m-0 text-sm text-ink-2">Modeled from planned Load and normal recovery.</p>
          </div>
          <div className={`${SUPPORT_PAIR} rounded-card bg-sunk p-4`}>
            <h3 className="m-0 text-sm font-semibold">Goal feasibility</h3>
            <span className="self-start rounded-full border border-ok px-3 py-1 text-sm text-ok">
              On track — with assumptions
            </span>
            <p className="m-0 text-sm text-ink-2">{readiness.feasibility.recommendation}</p>
          </div>
          <div className={`${SUPPORT_PAIR} rounded-card bg-sunk p-4`}>
            <div className="flex items-center justify-between gap-inset">
              <h3 className="m-0 text-sm font-semibold">Estimated CP</h3>
              <div className="flex items-center gap-inset">
                <span className="rounded-full border border-warn px-2 py-0.5 text-xs text-warn">
                  Experimental
                </span>
                <Button
                  ref={cpInfoTrigger}
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="About Estimated CP"
                  onClick={() => setOverlay("cp-info")}
                >
                  <Info aria-hidden="true" />
                </Button>
              </div>
            </div>
            {cp.status === "unavailable" ? (
              <>
                <strong className="text-xl">
                  {cp.unavailableReason === "mathematically-invalid"
                    ? "Estimated CP is unavailable from the current data."
                    : "Not enough measured power yet."}
                </strong>
                {cp.unavailableReason === "missing-effort" ? (
                  <p className="m-0 text-sm text-ink-2">
                    A short and a long recorded effort are needed from the last 6 weeks.
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <div className="flex items-center gap-inset">
                  <strong className="text-2xl">{cp.watts} W</strong>
                  {cp.status === "stale" ? (
                    <span className="rounded-full border border-warn px-2 py-0.5 text-xs text-warn">
                      Stale
                    </span>
                  ) : null}
                </div>
                <p className="m-0 text-sm text-ink-2">
                  {cp.status === "stale" && cp.lastSuccessfulSyncAtMs !== null
                    ? `Last successful sync ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(cp.lastSuccessfulSyncAtMs))}`
                    : cp.calculatedOn === null
                      ? "Calculation date unavailable"
                      : `Calculated ${formatCivilDate(cp.calculatedOn)}`}
                </p>
                <Button
                  ref={cpEffortsTrigger}
                  type="button"
                  variant="link"
                  className="h-auto justify-start p-0"
                  onClick={() => setOverlay("cp-efforts")}
                >
                  View the 2 efforts used →
                </Button>
              </>
            )}
          </div>
          <div className={`${SUPPORT_PAIR} rounded-card bg-sunk p-4`}>
            <h3 className="m-0 text-sm font-semibold">Course-based finish time</h3>
            <strong className="text-2xl">
              {readiness.courseEstimate.rangeMinutes === null
                ? "Unavailable"
                : finishRange(readiness.courseEstimate.rangeMinutes)}
            </strong>
            <p className="m-0 text-sm text-ink-2">
              {readiness.courseEstimate.confidence === null
                ? "No estimate"
                : `${readiness.courseEstimate.confidence} confidence`}
            </p>
            {readiness.courseEstimate.assumptions.length > 0 ? (
              <Button
                ref={routeTrigger}
                type="button"
                variant="link"
                className="h-auto justify-start p-0"
                onClick={() => setOverlay("route")}
              >
                View route assumptions →
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-row rounded-card bg-sunk p-row sm:grid-cols-3">
          {[
            ["Prescribed", readiness.evidence.prescribedDurationS],
            ["Ridden", readiness.evidence.riddenDurationS],
            ["Adjusted", readiness.evidence.adjustedDurationS],
          ].map(([label, value]) => (
            <div key={String(label)} className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">{label}</span>
              <strong className="text-xl tabular-nums">{clockTime(Number(value))}</strong>
            </div>
          ))}
        </div>
      </section>
      <Dialog open={overlay === "cp-info"} onOpenChange={closeOverlay}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Estimated CP</DialogTitle>
            <DialogDescription>
              Based on your best short and long power efforts from the last 6 weeks. This does not
              change your FTP, zones, workouts, or Plan.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
      <Dialog open={overlay === "cp-efforts"} onOpenChange={closeOverlay}>
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(480px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
            <DialogTitle>Power efforts used</DialogTitle>
            <DialogDescription>Estimated CP · {cp.watts ?? "Unavailable"} W</DialogDescription>
          </DialogHeader>
          <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
            {cp.efforts.map((effort) => (
              <section
                key={`${effort.activityId}-${effort.durationS}`}
                className="grid gap-inset rounded-card bg-sunk p-row"
              >
                <div className="flex items-start justify-between gap-row">
                  <strong>
                    {effort.ride} · {formatCivilDate(effort.date)}
                  </strong>
                  <strong className="tabular-nums">
                    {effortDuration(effort.durationS)} at {effort.averagePowerW} W
                  </strong>
                </div>
                <p className="m-0 text-sm text-ink-2">Device · {effort.device}</p>
              </section>
            ))}
            {cp.status === "unavailable" ? (
              <p className="m-0 text-ink-2">Estimated CP evidence is unavailable.</p>
            ) : (
              <p className="m-0 text-ink-2">
                These two efforts produce an Estimated CP of {cp.watts} W.
              </p>
            )}
          </div>
          <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
            <Button type="button" onClick={() => closeOverlay(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={overlay === "route"} onOpenChange={closeOverlay}>
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(440px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
            <DialogTitle>Route assumptions</DialogTitle>
            <DialogDescription>
              Inputs used for the course-based finish-time range.
            </DialogDescription>
          </DialogHeader>
          <ul className="m-0 grid flex-1 content-start gap-row overflow-auto px-10 py-5 text-ink-2">
            {readiness.courseEstimate.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
          <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
            <Button type="button" onClick={() => closeOverlay(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function WeeklyReviewProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const review = props.data.weeklyReview;
  if (review?.status !== "delivered") {
    return <StatusCard title="Weekly review" support="Preparing last week’s review…" />;
  }
  return (
    <section
      className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1"
      data-plan-scenario="PL-S100"
    >
      <div className="flex items-start justify-between gap-row">
        <div className={SUPPORT_PAIR}>
          <p className="m-0 text-sm font-medium text-ink-2">Coach</p>
          <h2 className="m-0 text-lg font-semibold">Weekly review</h2>
          <p className="m-0 text-sm text-ink-2">
            {formatCivilDate(review.weekStart)}–{formatCivilDate(review.weekEnd)}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => actions?.closeWorkout()}>
          Back to Plan
        </Button>
      </div>
      <div className="grid gap-inset rounded-card bg-sunk p-row">
        <p className="m-0 text-base">{review.summary}</p>
        <p className="m-0 text-sm text-ink-2">No response is needed.</p>
      </div>
    </section>
  );
}

function PlanningRequestDateConflictProjection(props: {
  readonly context: PlanPlanningRequestContext;
}): ReactElement {
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const conflict = props.context.dateConflict;
  const recommended = conflict?.recommendedDate ?? null;
  const firstReplaceable = conflict?.workouts.find((workout) => workout.replaceable) ?? null;
  const [choice, setChoice] = useState<"recommended" | "replace" | "custom">(
    recommended !== null ? "recommended" : firstReplaceable !== null ? "replace" : "custom",
  );
  const [replacementWorkoutId, setReplacementWorkoutId] = useState(
    firstReplaceable?.workoutId ?? null,
  );
  const [customDate, setCustomDate] = useState(recommended ?? conflict?.minimumDate ?? "");
  if (conflict === null) {
    return <StatusCard title="Plan request" support="Refreshing the current date options…" />;
  }
  const busy =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T40";
  const failed = transition.status === "failed" && transition.transitionId === "PL-T40";
  const submit = (): void => {
    if (choice === "replace" && replacementWorkoutId !== null) {
      actions?.resolvePlanningRequestDate(props.context.request.requestId, {
        kind: "replace-workout",
        workoutId: replacementWorkoutId,
      });
      return;
    }
    const date = choice === "recommended" ? recommended : customDate;
    if (date !== null && date.length > 0) {
      actions?.resolvePlanningRequestDate(props.context.request.requestId, {
        kind: "use-date",
        date,
      });
    }
  };
  const selectedDate = choice === "recommended" ? recommended : customDate;
  const primaryLabel =
    choice === "replace" && replacementWorkoutId !== null
      ? "Review replacement"
      : selectedDate === null || selectedDate.length === 0
        ? "Choose date"
        : `Use ${formatCivilDate(selectedDate)}`;
  return (
    <section className="grid gap-5 rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <p className="m-0 text-xs font-semibold tracking-wide text-ink-2 uppercase">
          Date conflict
        </p>
        <h2 className="m-0 text-xl font-semibold">
          {conflict.workouts[0] === undefined
            ? "The requested date already has a Workout"
            : `${formatCivilDate(conflict.workouts[0].date)} already has a Workout`}
        </h2>
        <p className="m-0 text-ink-2">
          Choose another date by default, or explicitly replace a future coach-owned Workout.
        </p>
      </div>
      <div className="grid gap-inset">
        {recommended === null ? null : (
          <button
            type="button"
            aria-pressed={choice === "recommended"}
            className={`grid min-h-ctl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-row rounded-ctl border p-row text-left outline-none focus:ring-3 focus:ring-ring/25 ${
              choice === "recommended" ? "border-primary bg-primary/10" : "border-line bg-surface"
            }`}
            onClick={() => setChoice("recommended")}
          >
            <span className="grid size-4 place-items-center rounded-full border-2 border-current">
              {choice === "recommended" ? (
                <span className="size-2 rounded-full bg-current" />
              ) : null}
            </span>
            <span className={SUPPORT_PAIR}>
              <strong>Use {formatCivilDate(recommended)}</strong>
              <small className="text-ink-2">No existing Workout</small>
            </span>
            <span className="rounded-full bg-ok/14 px-3 py-1 text-xs font-medium text-ok">
              Recommended
            </span>
          </button>
        )}
        {conflict.workouts.map((workout) =>
          workout.replaceable ? (
            <button
              key={workout.workoutId}
              type="button"
              aria-pressed={choice === "replace" && replacementWorkoutId === workout.workoutId}
              className={`grid min-h-ctl grid-cols-[auto_minmax(0,1fr)] items-center gap-row rounded-ctl border p-row text-left outline-none focus:ring-3 focus:ring-ring/25 ${
                choice === "replace" && replacementWorkoutId === workout.workoutId
                  ? "border-primary bg-primary/10"
                  : "border-line bg-surface"
              }`}
              onClick={() => {
                setReplacementWorkoutId(workout.workoutId);
                setChoice("replace");
              }}
            >
              <span className="grid size-4 place-items-center rounded-full border-2 border-current">
                {choice === "replace" && replacementWorkoutId === workout.workoutId ? (
                  <span className="size-2 rounded-full bg-current" />
                ) : null}
              </span>
              <span className={SUPPORT_PAIR}>
                <strong>Replace {workout.name}</strong>
                <small className="text-ink-2">
                  Future · coach-owned · {clockTime(workout.durationS)}
                </small>
              </span>
            </button>
          ) : null,
        )}
        <button
          type="button"
          aria-pressed={choice === "custom"}
          className={`grid min-h-ctl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-row rounded-ctl border p-row text-left outline-none focus:ring-3 focus:ring-ring/25 ${
            choice === "custom" ? "border-primary bg-primary/10" : "border-line bg-surface"
          }`}
          onClick={() => setChoice("custom")}
        >
          <span className="grid size-4 place-items-center rounded-full border-2 border-current">
            {choice === "custom" ? <span className="size-2 rounded-full bg-current" /> : null}
          </span>
          <span className={SUPPORT_PAIR}>
            <strong>Choose another date…</strong>
            <small className="text-ink-2">Check another day against the current Plan</small>
          </span>
          <CalendarDays className="size-4 text-ink-2" aria-hidden="true" />
        </button>
        {choice === "custom" ? (
          <label className="grid gap-inset rounded-ctl bg-sunk p-row text-sm">
            <span className="font-medium">Date</span>
            <input
              type="date"
              min={conflict.minimumDate}
              max={conflict.maximumDate}
              value={customDate}
              className="h-ctl rounded-ctl border border-line bg-surface px-3 text-sm outline-none focus:ring-3 focus:ring-ring/25"
              onChange={(event) => setCustomDate(event.currentTarget.value)}
            />
          </label>
        ) : null}
        {conflict.workouts.map((workout) =>
          workout.replaceable ? null : (
            <div
              key={workout.workoutId}
              className="grid min-h-ctl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-row rounded-ctl bg-sunk p-row text-ink-2"
            >
              <TriangleAlert className="size-4" aria-hidden="true" />
              <span className={SUPPORT_PAIR}>
                <strong className="text-ink">{workout.name}</strong>
                <small>Athlete-created · cannot be replaced by Coach</small>
              </span>
              <span className="rounded-full bg-bg-2 px-3 py-1 text-xs font-medium">Protected</span>
            </div>
          ),
        )}
      </div>
      {failed ? (
        <div className="flex items-start gap-row rounded-ctl bg-warn/10 p-row" role="alert">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
          <p className="m-0 text-sm text-ink-2">{transition.error.message}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-inset">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => actions?.closeProposal()}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={
            busy ||
            actions === null ||
            (choice === "custom" && customDate.length === 0) ||
            (choice === "replace" && replacementWorkoutId === null)
          }
          onClick={submit}
        >
          {busy ? "Checking…" : primaryLabel}
        </Button>
      </div>
    </section>
  );
}

function ActiveProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const actions = useEnduragentStore((state) => state.planActions);
  const [proposalMode, setProposalMode] = useState<"proposal" | "evidence" | "edit">("proposal");
  const [revisionText, setRevisionText] = useState("");
  const evidenceTrigger = useRef<HTMLButtonElement>(null);
  const endCancel = useRef<HTMLButtonElement>(null);
  const previousScenario = useRef<string | null>(null);
  const selectedProposalKey =
    typeof model?.data.selectedProposalId === "string" ? model.data.selectedProposalId : null;
  const failedRevisionText =
    typeof model?.data.proposalRevisionText === "string" ? model.data.proposalRevisionText : "";
  const focusData = PlanActiveProjectionDataSchema.safeParse(model?.data);
  const returnFocusId = focusData.success ? (focusData.data.returnFocusId ?? null) : null;
  useEffect(() => {
    setProposalMode(model?.scenarioId === "PL-S022" ? "edit" : "proposal");
    setRevisionText(model?.scenarioId === "PL-S022" ? failedRevisionText : "");
  }, [failedRevisionText, model?.scenarioId, selectedProposalKey]);
  useEffect(() => {
    const current = model?.scenarioId ?? null;
    const previous = previousScenario.current;
    previousScenario.current = current;
    if (
      current === previous ||
      (previous === null && current !== "PL-S006" && current !== "PL-S009")
    )
      return;
    const focusId =
      current === "PL-S004"
        ? "plan-history-trigger"
        : current === "PL-S005"
          ? "plan-history-heading"
          : current === "PL-S006"
            ? "plan-season-heading"
            : current === "PL-S009"
              ? "plan-race-week-heading"
              : current === "PL-S008" ||
                  current === "PL-S026" ||
                  current === "PL-S027" ||
                  current === "PL-S101"
                ? "plan-history-result-heading"
                : current !== null && ["PL-S090", "PL-S091", "PL-S092", "PL-S093"].includes(current)
                  ? "plan-settings-heading"
                  : current !== null &&
                      [
                        "PL-S012",
                        "PL-S074",
                        "PL-S075",
                        "PL-S076",
                        "PL-S077",
                        "PL-S078",
                        "PL-S098",
                      ].includes(current)
                    ? "plan-readiness-heading"
                    : null;
    if (focusId === null && returnFocusId === null) return;
    requestAnimationFrame(() => {
      const requested = returnFocusId === null ? null : document.getElementById(returnFocusId);
      (requested ?? (focusId === null ? null : document.getElementById(focusId)))?.focus();
    });
  }, [model?.scenarioId, returnFocusId]);
  if (model === null) return <StatusCard title="Plan" support="Refreshing your Plan…" />;
  const parsed = PlanActiveProjectionDataSchema.safeParse(model.data);
  if (!parsed.success) return <StatusCard title={model.title} support={model.summary} />;
  const data = parsed.data;
  if (data.selectedPlanningRequest?.request.attention === "date_conflict") {
    return <PlanningRequestDateConflictProjection context={data.selectedPlanningRequest} />;
  }
  if (model.scenarioId === "PL-S006") {
    return <SeasonProjection data={data} />;
  }
  if (model.scenarioId === "PL-S009") {
    return <RaceWeekProjection data={data} />;
  }
  if (
    ["PL-S012", "PL-S074", "PL-S075", "PL-S076", "PL-S077", "PL-S078", "PL-S098"].includes(
      model.scenarioId,
    )
  ) {
    return <ReadinessProjection data={data} scenarioId={model.scenarioId} />;
  }
  if (
    ["PL-S082", "PL-S083", "PL-S084", "PL-S085", "PL-S086", "PL-S087"].includes(model.scenarioId)
  ) {
    return <ReplacementLifecycleProjection data={data} scenarioId={model.scenarioId} />;
  }
  const selectedHistoryEntry =
    data.selectedHistoryId === undefined || data.selectedHistoryId === null
      ? null
      : ((data.history ?? []).find((entry) => entry.id === data.selectedHistoryId) ?? null);
  if (model.scenarioId === "PL-S005") {
    return <PlanHistoryProjection data={data} entries={data.history ?? []} />;
  }
  if (model.scenarioId === "PL-S008") {
    return <AppliedHistoryProjection entry={selectedHistoryEntry} />;
  }
  if (["PL-S090", "PL-S091", "PL-S092", "PL-S093"].includes(model.scenarioId)) {
    return <PlanSettingsProjection data={data} scenarioId={model.scenarioId} />;
  }
  if (model.scenarioId === "PL-S101") {
    return <AppliedHistoryProjection entry={selectedHistoryEntry} autoApplied />;
  }
  if (model.scenarioId === "PL-S100") {
    return <WeeklyReviewProjection data={data} />;
  }
  if (model.scenarioId === "PL-S026" || model.scenarioId === "PL-S027") {
    return <HistoryResultProjection scenarioId={model.scenarioId} entry={selectedHistoryEntry} />;
  }
  const selectedWorkout =
    data.selectedWorkoutId === undefined || data.selectedWorkoutId === null
      ? null
      : (data.selectedWorkout ??
        data.workouts.find((workout) => workout.id === data.selectedWorkoutId) ??
        null);
  const selectedProposal =
    data.selectedProposalId === undefined || data.selectedProposalId === null
      ? null
      : ((data.proposals ?? []).find((proposal) => proposal.id === data.selectedProposalId) ??
        null);
  const planningRequestAttention = data.selectedPlanningRequest?.request.attention ?? null;
  const proposalTargetWorkout =
    selectedProposal === null
      ? null
      : (data.workouts.find((workout) => workout.id === selectedProposal.targetWorkoutId) ?? null);
  const canReviseProposal = model.transitions.some(
    (guard) => guard.transitionId === "PL-T18" && guard.status === "available",
  );
  const canApproveProposal = model.transitions.some(
    (guard) => guard.transitionId === "PL-T19" && guard.status === "available",
  );
  const proposalBusy =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T18" || transition.transitionId === "PL-T19");
  const currentPhase =
    data.season?.weeks.find((week) => week.status === "current")?.phase ??
    data.plan.phaseSummary?.[0] ??
    "Plan";
  const todaySupport =
    data.todayWorkout === null
      ? "No workout scheduled."
      : data.todayWorkout.durationS === null
        ? "Follow the workout details in your Plan."
        : [
            clockTime(data.todayWorkout.durationS),
            data.todayWorkout.powerTargetW === undefined
              ? null
              : `${data.todayWorkout.powerTargetW.min}–${data.todayWorkout.powerTargetW.max} W`,
            data.todayWorkout.cue ?? null,
          ]
            .filter((value): value is string => value !== null)
            .join(" · ");
  if (["PL-S032", "PL-S033", "PL-S034", "PL-S035", "PL-S036"].includes(model.scenarioId)) {
    return <WorkoutDriftProjection data={data} scenarioId={model.scenarioId} />;
  }
  const workoutDates = data.workouts.map((workout) => workout.date).sort();
  const oldestWorkoutDate = workoutDates.at(0);
  const newestWorkoutDate = workoutDates.at(-1);
  return (
    <div className="grid gap-6" data-plan-scenario={model.scenarioId}>
      {model.scenarioId === "PL-S097" ? (
        <section className="flex items-start gap-row rounded-card bg-surface p-5 shadow-elev-1">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          <div className={`min-w-0 flex-1 ${SUPPORT_PAIR}`}>
            <h2 className="m-0 text-base font-semibold">Proposal rejected</h2>
            <p className="m-0 text-ink-2">The active Plan did not change.</p>
          </div>
          <Button type="button" onClick={() => actions?.closeProposal()}>
            Back to Plan
          </Button>
        </section>
      ) : null}
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex flex-col gap-row sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-row">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-base font-semibold">
                Plan active · week {data.weekIndex} of {data.plan.totalWeeks}
              </h2>
              <p className="m-0 text-ink-2">
                {data.plan.name} · {currentPhase} phase · starts{" "}
                {formatCivilDate(data.plan.startDate)}
                {data.plan.ftpWatts === undefined ? "" : ` · FTP ${data.plan.ftpWatts} W`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-inset">
            <Button
              id="plan-season-trigger"
              type="button"
              variant="outline"
              onClick={() => actions?.openSeason()}
            >
              <CalendarDays className="size-4" aria-hidden="true" />
              View season
            </Button>
          </div>
        </div>
        <div className="flex items-start gap-row border-t border-line pt-row">
          <Activity className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">
              Today · {data.todayWorkout?.name ?? "Rest"}
            </h3>
            <p className="m-0 text-ink-2">{todaySupport}</p>
          </div>
        </div>
      </section>

      <PredictionsSummary readiness={data.readiness} />

      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1">
        <div className="flex items-start justify-between gap-row px-5 py-row">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">WorkoutMatch · this week</h2>
            <p className="m-0 text-sm text-ink-2">
              {data.matchSync?.awaitingSync === true
                ? "Awaiting sync · previous matches remain visible."
                : data.matchSync?.lastSuccessfulSyncAtMs == null
                  ? "Workout matches appear after activity sync."
                  : `As of last sync · ${new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(data.matchSync.lastSuccessfulSyncAtMs))}`}
            </p>
          </div>
        </div>
        <div className="divide-y divide-line border-t border-line">
          {data.workouts.map((workout) => {
            const status = workout.match?.status ?? "upcoming";
            const decision = status === "decision-needed";
            const drift = workout.drift !== undefined;
            const proposal = (data.proposals ?? []).find(
              (candidate) => candidate.targetWorkoutId === workout.id,
            );
            return (
              <button
                key={workout.id}
                id={`workout-row-${workout.id}`}
                type="button"
                className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-inset gap-y-1 bg-transparent px-5 py-row text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary min-[760px]:grid-cols-[minmax(6rem,0.8fr)_minmax(0,2fr)_minmax(4rem,0.6fr)_minmax(8rem,1fr)_auto]"
                onClick={() => {
                  if (proposal !== undefined) {
                    setProposalMode("proposal");
                    setRevisionText("");
                    actions?.openProposal(proposal.id);
                  } else actions?.openWorkout(workout.id);
                }}
              >
                <span className="col-start-1 row-start-1 text-ink-2 min-[760px]:col-auto min-[760px]:row-auto">
                  {formatCivilDate(workout.date, { weekday: "short", day: "numeric" })}
                </span>
                <span className="col-start-1 row-start-2 min-w-0 truncate font-medium text-ink-1 min-[760px]:col-auto min-[760px]:row-auto">
                  {workout.name}
                </span>
                <span className="col-start-2 row-start-1 text-ink-2 min-[760px]:col-auto min-[760px]:row-auto">
                  {workout.durationS === null ? "—" : plannedTime(workout.durationS)}
                </span>
                {proposal !== undefined ? (
                  <span className="col-start-2 row-start-2 justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn min-[760px]:col-auto min-[760px]:row-auto">
                    Decision needed
                  </span>
                ) : drift ? (
                  <span className="col-start-2 row-start-2 justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn min-[760px]:col-auto min-[760px]:row-auto">
                    Changed in Intervals
                  </span>
                ) : decision ? (
                  <span className="col-start-2 row-start-2 justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn min-[760px]:col-auto min-[760px]:row-auto">
                    Decision needed
                  </span>
                ) : (
                  <span
                    className={`col-start-2 row-start-2 justify-self-start min-[760px]:col-auto min-[760px]:row-auto ${matchStatusClass(status)}`}
                  >
                    {MATCH_STATUS_COPY[status]}
                  </span>
                )}
                <ChevronRight
                  className="col-start-3 row-span-2 row-start-1 size-4 text-ink-2 min-[760px]:col-auto min-[760px]:row-auto"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        {oldestWorkoutDate === undefined || newestWorkoutDate === undefined ? null : (
          <div className="border-t border-line px-5 py-row">
            <WorkoutArchiveExportControl oldest={oldestWorkoutDate} newest={newestWorkoutDate} />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-row rounded-card bg-surface p-5 shadow-elev-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="m-0 text-sm text-ink-2">
          Replace or end future Plan management. Today's workout stays.
        </p>
        <div className="flex flex-wrap justify-end gap-inset">
          <Button
            id="plan-replace-trigger"
            type="button"
            variant="outline"
            disabled={actions === null || transition.status !== "idle"}
            onClick={() => actions?.openReplacement()}
          >
            Replace Plan
          </Button>
          <Button
            id="plan-end-trigger"
            type="button"
            variant="destructive"
            disabled={actions === null || transition.status !== "idle"}
            onClick={() => actions?.openEndConfirmation()}
          >
            End Plan
          </Button>
        </div>
      </section>

      <Dialog
        open={model.scenarioId === "PL-S051"}
        onOpenChange={(open) => {
          if (!open) actions?.closeEndConfirmation();
        }}
      >
        <DialogContent initialFocus={endCancel} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>End this Plan?</DialogTitle>
            <DialogDescription>
              The Plan ends now. Today's workout stays, and tomorrow-onward Enduragent workouts are
              removed from Intervals.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={endCancel}
              type="button"
              variant="outline"
              onClick={() => actions?.closeEndConfirmation()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive-solid"
              onClick={() => actions?.confirmEndPlan()}
            >
              End Plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedWorkout !== null}
        onOpenChange={(open) => {
          if (!open) actions?.closeWorkout();
        }}
      >
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(440px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          {selectedWorkout === null ? null : (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">{selectedWorkout.name}</DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  {formatCivilDate(selectedWorkout.date)} · {selectedWorkout.sport} ·{" "}
                  {selectedWorkout.durationS === null
                    ? "No planned duration"
                    : plannedTime(selectedWorkout.durationS)}
                </DialogDescription>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                <div className={SUPPORT_PAIR}>
                  <h3 className="m-0 text-sm font-medium">WorkoutMatch</h3>
                  <p
                    className={`m-0 text-base ${matchStatusClass(
                      selectedWorkout.match?.status ?? "upcoming",
                    )}`}
                  >
                    {MATCH_STATUS_COPY[selectedWorkout.match?.status ?? "upcoming"]}
                  </p>
                </div>
                {selectedWorkout.match?.activityId !== null &&
                selectedWorkout.match?.activityId !== undefined ? (
                  <div className="grid gap-inset rounded-card bg-sunk p-row">
                    <p className="m-0 text-sm font-medium">Observed activity</p>
                    <p className="m-0 text-sm text-ink-2">
                      {selectedWorkout.match.actualDate === null
                        ? "Date unavailable"
                        : formatCivilDate(selectedWorkout.match.actualDate)}
                      {selectedWorkout.match.actualDurationS === null
                        ? ""
                        : ` · ${plannedTime(selectedWorkout.match.actualDurationS)}`}
                    </p>
                  </div>
                ) : (
                  <p className="m-0 text-sm text-ink-2">
                    No completed activity is matched to this workout.
                  </p>
                )}
                {selectedWorkout.match?.requiresConfirmation === true ? (
                  <p className="m-0 text-sm text-ink-2">
                    The date, sport, and duration look similar. Confirm before it counts as the
                    planned workout.
                  </p>
                ) : null}
              </div>
              <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                {selectedWorkout.match?.requiresConfirmation === true &&
                selectedWorkout.match.activityId !== null ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={actions === null || transition.status !== "idle"}
                      onClick={() =>
                        actions?.resolveWorkoutMatch(
                          selectedWorkout.id,
                          selectedWorkout.match!.activityId!,
                          "reject",
                        )
                      }
                    >
                      Not this activity
                    </Button>
                    <Button
                      type="button"
                      disabled={actions === null || transition.status !== "idle"}
                      onClick={() =>
                        actions?.resolveWorkoutMatch(
                          selectedWorkout.id,
                          selectedWorkout.match!.activityId!,
                          "confirm",
                        )
                      }
                    >
                      Confirm match
                    </Button>
                  </>
                ) : (
                  <Button type="button" variant="outline" onClick={() => actions?.closeWorkout()}>
                    Close
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedProposal !== null}
        onOpenChange={(open) => {
          if (!open) {
            setProposalMode("proposal");
            setRevisionText("");
            actions?.closeProposal();
          }
        }}
      >
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(480px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          {selectedProposal === null ? null : proposalMode === "evidence" ? (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">Where this came from</DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  Evidence captured when this Proposal was created.
                </DialogDescription>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-6 overflow-auto px-5 py-5">
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">Source</h3>
                  {selectedProposal.premises.map((premise) => (
                    <p key={premise.id} className="m-0 text-sm text-ink-2">
                      {premise.sourceLabel}
                    </p>
                  ))}
                </section>
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">Evidence</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.rationale}</p>
                </section>
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">Confidence</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.confidence}</p>
                </section>
                <section className="grid gap-inset rounded-ctl bg-sunk p-row">
                  <h3 className="m-0 text-sm font-semibold">Proposed impact</h3>
                  {selectedProposal.diff.map((line) => (
                    <div key={line.field} className="grid grid-cols-[7rem_1fr] gap-inset text-sm">
                      <span>{line.label}</span>
                      <span>
                        {line.before} → {line.after}
                      </span>
                    </div>
                  ))}
                </section>
              </div>
              <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                <Button
                  type="button"
                  onClick={() => {
                    setProposalMode("proposal");
                    requestAnimationFrame(() => evidenceTrigger.current?.focus());
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : proposalMode === "edit" ? (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">Revise Proposal</DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  The active Plan stays unchanged while the coach revises this Proposal.
                </DialogDescription>
              </DialogHeader>
              <form
                className="flex min-h-0 flex-1 flex-col"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!/\S/u.test(revisionText)) return;
                  actions?.reviseProposal(selectedProposal.id, revisionText.trim());
                }}
              >
                <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                  <div className="grid gap-inset rounded-ctl bg-sunk p-row">
                    <p className="m-0 text-sm font-medium">Coach</p>
                    <p className="m-0 text-sm text-ink-2">
                      I’ll keep the active Plan unchanged while we revise this Proposal. What should
                      change?
                    </p>
                  </div>
                  <label className="grid gap-inset text-sm font-medium" htmlFor="proposal-revision">
                    Your change
                    <textarea
                      id="proposal-revision"
                      className="min-h-36 resize-y rounded-ctl border border-line bg-surface px-3 py-3 text-base text-ink-1 outline-none focus:border-primary"
                      value={revisionText}
                      placeholder="Keep 45 minutes and make it recovery."
                      disabled={proposalBusy}
                      onChange={(event) => setRevisionText(event.currentTarget.value)}
                    />
                  </label>
                  {selectedProposal.error === null ? null : (
                    <StaleNotice message={selectedProposal.error.message} />
                  )}
                </div>
                <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={proposalBusy}
                    onClick={() => {
                      setProposalMode("proposal");
                      setRevisionText("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={proposalBusy || !/\S/u.test(revisionText)}>
                    {proposalBusy ? "Updating…" : "Update Proposal"}
                  </Button>
                </DialogFooter>
              </form>
            </>
          ) : (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogDescription className="m-0 text-ink-2">
                  {formatCivilDate(selectedProposal.affectedDate)}
                </DialogDescription>
                <DialogTitle className="m-0 text-xl">
                  {proposalTargetWorkout?.name ?? selectedProposal.title}
                </DialogTitle>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                <div className="flex items-center justify-between gap-inset">
                  <span className="text-sm text-ink-2">Status</span>
                  <span className="rounded-full border border-warn px-2.5 py-1 text-sm text-warn">
                    Decision needed
                  </span>
                </div>
                {planningRequestAttention === "apply_failed" ||
                (planningRequestAttention === "revalidating" && !proposalBusy) ? (
                  <div
                    className="flex items-start gap-row rounded-ctl bg-warn/10 p-row"
                    role="alert"
                  >
                    <TriangleAlert
                      className="mt-0.5 size-5 shrink-0 text-warn"
                      aria-hidden="true"
                    />
                    <div className={SUPPORT_PAIR}>
                      <p className="m-0 font-medium">
                        {planningRequestAttention === "apply_failed"
                          ? "We couldn’t save this change"
                          : "The previous check was interrupted"}
                      </p>
                      <p className="m-0 text-sm text-ink-2">
                        The active Plan is unchanged and this Proposal is still available.
                      </p>
                    </div>
                  </div>
                ) : null}
                {selectedProposal.stale ? (
                  <StaleNotice message="The Plan changed before approval. Review this updated Proposal." />
                ) : null}
                {!selectedProposal.stale && selectedProposal.error !== null ? (
                  <StaleNotice message={selectedProposal.error.message} />
                ) : null}
                {proposalBusy && transition.transitionId === "PL-T19" ? (
                  <div className="flex items-start gap-row rounded-ctl bg-sunk p-row" role="status">
                    <LoaderCircle
                      className="mt-0.5 size-5 animate-spin text-primary"
                      aria-hidden="true"
                    />
                    <div className={SUPPORT_PAIR}>
                      <p className="m-0 font-medium">Checking the current Plan</p>
                      <p className="m-0 text-sm text-ink-2">
                        Confirming that the workout and source data have not changed.
                      </p>
                    </div>
                  </div>
                ) : null}
                <section className="grid gap-inset rounded-ctl bg-sunk p-row">
                  <h3 className="m-0 text-sm font-semibold">Proposed change</h3>
                  {selectedProposal.diff.map((line) => (
                    <div key={line.field} className="grid grid-cols-[7rem_1fr] gap-inset text-sm">
                      <span>{line.label}</span>
                      <span>
                        {line.before} → {line.after}
                      </span>
                    </div>
                  ))}
                </section>
                <section className={SUPPORT_PAIR}>
                  <h3 className="m-0 text-sm font-semibold">Why</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.rationale}</p>
                </section>
                <div className="flex items-center justify-between gap-inset">
                  <span className="text-sm text-ink-2">Confidence</span>
                  <span className="rounded-full border border-ok px-2.5 py-1 text-sm text-ok">
                    {selectedProposal.confidence}
                  </span>
                </div>
                <div>
                  <Button
                    ref={evidenceTrigger}
                    type="button"
                    variant="link"
                    aria-label="View evidence"
                    className="h-auto p-0"
                    onClick={() => setProposalMode("evidence")}
                  >
                    View evidence →
                  </Button>
                </div>
              </div>
              <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={proposalBusy}
                    onClick={() => actions?.rejectProposal(selectedProposal.id)}
                  >
                    Reject
                  </Button>
                  {canReviseProposal ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={proposalBusy}
                      onClick={() => setProposalMode("edit")}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {canApproveProposal ? (
                    <Button
                      type="button"
                      disabled={proposalBusy}
                      onClick={() =>
                        actions?.approveProposal(selectedProposal.id, selectedProposal.revision)
                      }
                    >
                      {proposalBusy
                        ? "Checking…"
                        : planningRequestAttention === "apply_failed" ||
                            planningRequestAttention === "revalidating"
                          ? "Try again"
                          : selectedProposal.stale
                            ? "Revalidate"
                            : "Approve"}
                    </Button>
                  ) : null}
                </>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EndedProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const actions = useEnduragentStore((state) => state.planActions);
  if (model === null) return <StatusCard title="Plan" support="Refreshing your Plan…" />;
  const parsed = PlanEndedProjectionDataSchema.safeParse(model.data);
  if (!parsed.success) return <StatusCard title={model.title} support={model.summary} />;
  const data = parsed.data;
  const busy =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T24";
  const failed = model.reconciliation.status === "failed";
  const verified = model.reconciliation.status === "verified";
  const remaining = data.cleanupItems.filter((item) => item.status !== "verified");
  const outcomeBusy =
    (transition.status === "submitting" || transition.status === "running") &&
    transition.transitionId === "PL-T30";
  if (model.scenarioId === "PL-S095") {
    return (
      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1" aria-live="polite">
        <div className="grid gap-6 p-5">
          <div className="flex items-start gap-row">
            <Activity className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-base font-semibold">Did you complete {data.plan.name}?</h2>
              <p className="m-0 text-ink-2">
                This records the race outcome. The ended Plan and its history stay unchanged.
              </p>
            </div>
          </div>
          {transition.status === "failed" && transition.transitionId === "PL-T30" ? (
            <div className="flex items-start gap-row rounded-ctl bg-warn/10 p-row" role="alert">
              <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
              <p className="m-0 text-sm text-ink-2">{transition.error.message}</p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-inset px-5 py-row">
          <Button
            type="button"
            variant="outline"
            disabled={outcomeBusy || actions === null}
            onClick={() => actions?.recordRaceOutcome("not-completed")}
          >
            Not completed
          </Button>
          <Button
            type="button"
            disabled={outcomeBusy || actions === null}
            onClick={() => actions?.recordRaceOutcome("completed")}
          >
            {outcomeBusy ? "Saving…" : "Completed"}
          </Button>
        </div>
      </section>
    );
  }
  if (model.scenarioId === "PL-S014" && data.raceOutcomeDetails?.outcome === "completed") {
    const result = data.raceOutcomeDetails;
    return (
      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1">
        <div className="grid gap-6 p-5">
          <div className="flex items-start gap-row">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-lg font-semibold">
                {data.plan.name} completed · {result.goal.toLowerCase()} achieved
              </h2>
              <p className="m-0 text-ink-2">
                {formatCivilDate(result.raceDate)} · result recorded. The Plan no longer changes
                future training.
              </p>
            </div>
          </div>
          <section className="grid gap-row border-t border-line pt-row">
            <h3 className="m-0 text-base font-semibold">Time across Plan</h3>
            <div className="grid grid-cols-3 gap-row">
              <div className={SUPPORT_PAIR}>
                <span className="text-sm text-ink-2">Training</span>
                <strong className="text-lg">{clockTime(result.trainingDurationS)}</strong>
              </div>
              <div className={SUPPORT_PAIR}>
                <span className="text-sm text-ink-2">Race</span>
                <strong className="text-lg">{clockTime(result.raceDurationS)}</strong>
              </div>
              <div className={SUPPORT_PAIR}>
                <span className="text-sm text-ink-2">Total</span>
                <strong className="text-lg">{clockTime(result.totalDurationS)}</strong>
              </div>
            </div>
          </section>
          <section className="grid gap-inset border-t border-line pt-row text-sm">
            <h3 className="m-0 text-base font-semibold">Plan outcome</h3>
            {[
              ["Goal", result.goal],
              ["Result", result.result],
              ["Modeled finish", finishRange(result.modeledFinishMinutes)],
              ["Actual", clockTime(result.actualDurationS)],
              ["Workout records", `${data.plan.workoutCount} total`],
              ["Applied changes", String(result.appliedChangeCount)],
              ["Eligible undo", "None"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="flex justify-between gap-row border-t border-line py-inset first:border-t-0"
              >
                <span className="text-ink-2">{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </section>
          <div className="flex items-start gap-row border-t border-line pt-row">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h3 className="m-0 text-base font-semibold">Calendar cleanup verified</h3>
              <p className="m-0 text-ink-2">
                Today stayed. No tomorrow-onward Enduragent workouts remain in Intervals.
              </p>
            </div>
          </div>
        </div>
        <div className="flex justify-end border-t border-line px-5 py-row">
          <Button type="button" disabled={actions === null} onClick={() => actions?.startPlan()}>
            Start a new Plan
          </Button>
        </div>
      </section>
    );
  }
  if (model.scenarioId === "PL-S096" && data.raceOutcomeDetails?.outcome === "not-completed") {
    return (
      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1">
        <div className="grid gap-6 p-5">
          <div className="flex items-start gap-row">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-lg font-semibold">Race outcome · Not completed</h2>
              <p className="m-0 text-ink-2">
                {formatCivilDate(data.raceOutcomeDetails.raceDate)} · the Plan remains ended and its
                history stays available.
              </p>
            </div>
          </div>
          <section className="grid gap-inset border-t border-line pt-row text-sm">
            <h3 className="m-0 text-base font-semibold">Plan record</h3>
            <div className="flex justify-between gap-row">
              <span className="text-ink-2">Planned race</span>
              <strong>{data.plan.name}</strong>
            </div>
            <div className="flex justify-between gap-row border-t border-line pt-inset">
              <span className="text-ink-2">Outcome</span>
              <strong>Not completed</strong>
            </div>
            <div className="flex justify-between gap-row border-t border-line pt-inset">
              <span className="text-ink-2">Training history</span>
              <strong>Preserved</strong>
            </div>
          </section>
        </div>
        <div className="flex justify-end border-t border-line px-5 py-row">
          <Button type="button" disabled={actions === null} onClick={() => actions?.startPlan()}>
            Start a new Plan
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-elev-1" aria-live="polite">
      <div className="grid gap-6 p-5">
        <div className="flex items-start gap-row">
          {failed ? (
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
          ) : verified ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          ) : (
            <LoaderCircle
              className="mt-0.5 size-5 shrink-0 animate-spin text-primary"
              aria-hidden="true"
            />
          )}
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">
              {model.scenarioId === "PL-S096"
                ? `${data.plan.name} · Not completed`
                : `${data.plan.name} Plan ended`}
            </h2>
            <p className="m-0 text-ink-2">
              {model.scenarioId === "PL-S094" && data.plan.targetDate !== null
                ? `The Plan ended automatically after ${formatCivilDate(data.plan.targetDate)}.`
                : model.scenarioId === "PL-S096"
                  ? "The race outcome is saved separately from the ended Plan."
                  : "The Plan no longer changes future training."}
            </p>
          </div>
        </div>
        <div className="border-t border-line pt-row">
          <div className="flex items-start gap-row">
            {verified ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
            ) : failed ? (
              <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
            ) : (
              <LoaderCircle
                className="mt-0.5 size-5 shrink-0 animate-spin text-primary"
                aria-hidden="true"
              />
            )}
            <div className={SUPPORT_PAIR}>
              <h3 className="m-0 text-base font-semibold">
                {verified
                  ? "Calendar cleanup verified"
                  : failed
                    ? "Calendar cleanup needs attention"
                    : busy || model.scenarioId === "PL-S055"
                      ? "Cleaning up Intervals"
                      : "Checking Intervals"}
              </h3>
              <p className="m-0 text-ink-2">
                {verified
                  ? "Today stayed. No tomorrow-onward Enduragent workouts remain in Intervals."
                  : failed
                    ? "The Plan remains ended. Retry cleanup or verify Intervals again."
                    : "Today stays while tomorrow-onward Plan workouts are checked."}
              </p>
            </div>
          </div>
          {failed && remaining.length > 0 ? (
            <div className="mt-row divide-y divide-line border-y border-line">
              {remaining.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-row py-inset text-sm"
                >
                  <span>{formatCivilDate(item.date)}</span>
                  <span className="text-warn">Still in Intervals</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="grid gap-inset border-t border-line pt-row text-sm">
          {data.raceOutcome === null || data.raceOutcome === undefined ? null : (
            <div className="flex justify-between gap-row">
              <span>Race outcome</span>
              <strong>{data.raceOutcome === "completed" ? "Completed" : "Not completed"}</strong>
            </div>
          )}
          <div className="flex justify-between gap-row">
            <span>Plan history</span>
            <strong>Saved</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>Past rides and athlete-created events</span>
            <strong>Preserved</strong>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-inset border-t border-line px-5 py-row">
        {model.scenarioId === "PL-S094" ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy || actions === null || data.outcomeAvailable !== true}
              onClick={() => actions?.openRaceOutcome()}
            >
              Record outcome
            </Button>
            <Button type="button" onClick={() => actions?.startPlan()}>
              Start a new Plan
            </Button>
          </>
        ) : failed ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy || actions === null}
              onClick={() => actions?.verifyPlanCleanup()}
            >
              Verify again
            </Button>
            <Button
              type="button"
              disabled={busy || actions === null}
              onClick={() => actions?.retryPlanCleanup()}
            >
              {busy ? "Working…" : "Retry"}
            </Button>
          </>
        ) : verified || data.raceOutcome !== null ? (
          <>
            {model.scenarioId === "PL-S089" ? (
              <Button
                id="plan-ended-conversation-trigger"
                type="button"
                variant="outline"
                disabled={actions === null}
                onClick={() => actions?.openEndedConversation()}
              >
                View coach conversation
              </Button>
            ) : null}
            <Button type="button" disabled={actions === null} onClick={() => actions?.startPlan()}>
              Start a new Plan
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function ReadyProjection(): ReactElement {
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  if (
    transition.status === "running" &&
    (transition.transitionId === "PL-T06" || transition.transitionId === "PL-T07")
  ) {
    return <DraftFormation />;
  }
  if (model === null) return <StatusCard title="Plan" support="Refreshing your Plan…" />;
  if (model.scenarioId === "PL-S099") {
    const parsed = PlanChatOriginatedResultProjectionDataSchema.safeParse(model.data);
    return parsed.success ? (
      <ChatOriginatedPlanResultProjection data={parsed.data} />
    ) : (
      <StatusCard title={model.title} support={model.summary} />
    );
  }
  if (model.lifecycle === "none" || model.projection === "no-plan") return <NoPlan />;
  if (model.projection === "coach") return <PlanCoach />;
  if (model.projection === "draft") return <DraftProjection />;
  if (model.projection === "active") return <ActiveProjection />;
  if (model.projection === "ended") return <EndedProjection />;
  if (model.projection === "attention") return <AttentionProjection />;
  return (
    <StatusCard
      title={model.title.length > 0 ? model.title : "Your Plan"}
      support={model.summary.length > 0 ? model.summary : "Your Plan is available."}
    />
  );
}

export function PlanView(): ReactElement {
  const [finalDetails, setFinalDetails] = useState<
    | { status: "library" }
    | { status: "loading"; planId: string; justClosed: boolean }
    | { status: "ready"; history: PlanHistoryResult; justClosed: boolean }
    | { status: "unavailable"; planId: string; justClosed: boolean }
  >({ status: "library" });
  const historyRequest = useRef(0);
  const stopHistoryRefresh = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      historyRequest.current += 1;
      stopHistoryRefresh.current?.();
    },
    [],
  );
  const library = useEnduragentStore((state) => state.planLibrary);
  const libraryActions = useEnduragentStore((state) => state.planLibraryActions);
  const readFinalDetails = (planId: string, justClosed = false): void => {
    if (libraryActions === null) return;
    const request = ++historyRequest.current;
    stopHistoryRefresh.current?.();
    setFinalDetails({ status: "loading", planId, justClosed });
    void libraryActions.readPlanHistory(planId).then(
      (history) => {
        if (request !== historyRequest.current) return;
        setFinalDetails({ status: "ready", history, justClosed });
        if (history !== null) {
          stopHistoryRefresh.current = subscribePlanFinalDetailsRefresh({
            history,
            readHistory: (id) => libraryActions.readPlanHistory(id),
            onHistory: (value) => {
              if (request === historyRequest.current)
                setFinalDetails({ status: "ready", history: value, justClosed });
            },
          });
        }
      },
      () => {
        if (request === historyRequest.current)
          setFinalDetails({ status: "unavailable", planId, justClosed });
      },
    );
  };
  const backToLibrary = (): void => {
    historyRequest.current += 1;
    stopHistoryRefresh.current?.();
    setFinalDetails({ status: "library" });
  };
  const planningActions = useEnduragentStore((state) => state.planningReadActions);
  const creationFocus = useEnduragentStore((state) => state.chat.planCreationFocusRequest);
  const details = useRef<HTMLDivElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (creationFocus?.target === "start") startButton.current?.focus();
  }, [creationFocus, library.value?.creation]);
  const plan = useEnduragentStore((state) => state.plan);
  const actions = useEnduragentStore((state) => state.planActions);
  const model = planReadModel(plan);
  const loading = plan.hydration.status === "loading";
  const returnFocusId =
    typeof model?.data.returnFocusId === "string" ? model.data.returnFocusId : null;
  const coachWorkspace =
    plan.hydration.status === "ready" &&
    model?.projection === "coach" &&
    (model.lifecycle === "intake" || model.lifecycle === "replacement-intake") &&
    model.scenarioId !== "PL-S016" &&
    model.scenarioId !== "PL-S103" &&
    !FTP_SCENARIOS.has(model.scenarioId);
  const parsedActive = PlanActiveProjectionDataSchema.safeParse(model?.data);
  const activeData = parsedActive.success ? parsedActive.data : null;
  const historyPage = model?.scenarioId === "PL-S005" && activeData !== null;
  const activeOverview =
    model?.projection === "active" && ACTIVE_OVERVIEW_SCENARIOS.has(model.scenarioId);
  const subtitle = loading
    ? "Loading…"
    : historyPage
      ? `${activeData.plan.name} · active Plan · mutation and recovery log`
      : activeOverview && activeData !== null
        ? `${activeData.plan.name}${
            activeData.plan.targetDate === null
              ? ""
              : ` · ${formatCivilDate(activeData.plan.targetDate)}`
          } · Active`
        : model?.lifecycle === "none"
          ? "No active plan"
          : undefined;

  useEffect(() => {
    if (returnFocusId === null || finalDetails.status !== "library") return;
    requestAnimationFrame(() => document.getElementById(returnFocusId)?.focus());
  }, [model?.scenarioId, returnFocusId, finalDetails.status]);

  if (finalDetails.status !== "library") {
    const notice = finalDetails.justClosed
      ? finalDetails.status === "ready" && finalDetails.history?.cleanup === "complete"
        ? "Plan closed. Cleanup complete."
        : "Plan closed. Calendar cleanup pending."
      : null;
    return (
      <Page title="Plan" className="plan-view" busy={finalDetails.status === "loading"}>
        {finalDetails.status === "ready" && finalDetails.history !== null ? (
          <PlanFinalDetails
            history={finalDetails.history}
            notice={notice}
            backToLibrary={backToLibrary}
            retryCalendar={
              libraryActions === null
                ? undefined
                : async () => {
                    if (finalDetails.history === null) return;
                    requestPlanCalendarRetry(finalDetails.history.plan.planId);
                    await libraryActions.refresh();
                  }
            }
          />
        ) : (
          <div className="grid gap-inset">
            {notice === null ? null : (
              <p role="status" className="m-0 text-sm text-ink-2">
                {notice}
              </p>
            )}
            {finalDetails.status === "loading" ? (
              <p role="status" className="m-0 text-sm text-ink-2">
                Loading final Plan details…
              </p>
            ) : null}
            {finalDetails.status === "unavailable" ? (
              <>
                <p role="alert" className="m-0 text-sm text-danger">
                  Final Plan details could not load. Try again.
                </p>
                <Button
                  variant="outline"
                  onClick={() => readFinalDetails(finalDetails.planId, finalDetails.justClosed)}
                >
                  Try again
                </Button>
              </>
            ) : null}
            <div>
              <Button variant="outline" onClick={backToLibrary}>
                Back to library
              </Button>
            </div>
          </div>
        )}
      </Page>
    );
  }

  return (
    <Page
      title={historyPage ? "Plan history" : "Plan"}
      subtitle={subtitle}
      busy={loading}
      action={
        library.value !== null && !coachWorkspace && !historyPage ? (
          library.value.creation === null ? (
            <Button
              ref={startButton}
              id="start-plan"
              disabled={libraryActions === null}
              onClick={() => libraryActions?.startCreation()}
            >
              {library.value.active === null ? "Start a Plan" : "Start a new Plan"}
            </Button>
          ) : undefined
        ) : coachWorkspace ? (
          <Button
            id="plan-coach-close"
            type="button"
            variant="ghost"
            disabled={actions === null}
            onClick={() => actions?.closeCoach()}
          >
            Close coach
          </Button>
        ) : historyPage ? (
          <Button type="button" variant="outline" onClick={() => actions?.closeHistory()}>
            Back to Plan
          </Button>
        ) : activeOverview ? (
          <Button
            id="plan-history-trigger"
            type="button"
            variant="outline"
            onClick={() => actions?.openHistory()}
          >
            <History className="size-4" aria-hidden="true" />
            Plan history
          </Button>
        ) : undefined
      }
      className="plan-view"
      contentMode={coachWorkspace ? "workspace" : "scroll"}
    >
      <div className={coachWorkspace ? "h-full min-h-0" : "grid gap-6"}>
        {library.status === "unavailable" ? (
          <div role="alert" className="grid gap-inset">
            <StaleNotice message="Plan library could not load. Try again." />
            <Button variant="outline" onClick={() => planningActions?.refresh()}>
              Try again
            </Button>
          </div>
        ) : null}
        {library.value !== null && !coachWorkspace && !historyPage ? (
          <PlanLibrary
            library={library.value}
            readFinalDetails={readFinalDetails}
            readDetails={() => {
              details.current?.scrollIntoView({ block: "start", behavior: "instant" });
              details.current?.focus({ preventScroll: true });
            }}
          />
        ) : null}
        <div
          ref={details}
          tabIndex={-1}
          className={coachWorkspace ? "h-full min-h-0" : "grid gap-6"}
        >
          {library.value !== null && activeOverview ? (
            <div className="flex justify-end">
              <Button
                id="plan-history-trigger"
                type="button"
                variant="outline"
                onClick={() => actions?.openHistory()}
              >
                <History className="size-4" aria-hidden="true" />
                Plan history
              </Button>
            </div>
          ) : null}
          {plan.hydration.status === "stale" ? (
            <StaleNotice message={plan.hydration.error.message} />
          ) : null}
          {plan.hydration.status === "loading" ? (
            <p className="m-0 text-ink-2" role="status" aria-live="polite">
              Loading your Plan…
            </p>
          ) : plan.hydration.status === "failed" ? (
            <StatusCard
              title="Plan could not load"
              support={plan.hydration.error.message}
              retry={plan.hydration.error.retryable}
            />
          ) : plan.hydration.status === "unsupported-capability" ? (
            <StatusCard
              title="Plan is not available yet"
              support="Update Enduragent and its local service to use Plan."
            />
          ) : (
            <ReadyProjection />
          )}
        </div>
        <CoursePickerDialog />
      </div>
    </Page>
  );
}
