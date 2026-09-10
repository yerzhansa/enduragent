import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { usePlanDate } from "./plan-date";
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
const WEEKDAYS = [
  "chat.planChange.day.mon",
  "chat.planChange.day.tue",
  "chat.planChange.day.wed",
  "chat.planChange.day.thu",
  "chat.planChange.day.fri",
  "chat.planChange.day.sat",
  "chat.planChange.day.sun",
] as const;
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

function plannedTime(phrasebook: Phrasebook, durationS: number): string {
  const { say, format } = phrasebook;

  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.round((durationS % 3_600) / 60);
  if (hours === 0)
    return say("chat.planChange.minutes", {
      minutes: format.number(minutes, { useGrouping: false }),
    });
  return minutes === 0
    ? say("plan.view.plannedTime.hours", { hours: format.number(hours, { useGrouping: false }) })
    : say("plan.view.plannedTime.hoursMinutes", {
        hours: format.number(hours, { useGrouping: false }),
        minutes: format.number(minutes, { useGrouping: false }),
      });
}

function clockTime(phrasebook: Phrasebook, durationS: number): string {
  const { say, format } = phrasebook;

  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.round((durationS % 3_600) / 60);
  return say("plan.view.duration.clock", {
    major: format.number(hours, { useGrouping: false }),
    minor: format.number(minutes, { useGrouping: false, minimumIntegerDigits: 2 }),
  });
}

function finishRange(
  phrasebook: Phrasebook,
  value: { readonly min: number; readonly max: number },
): string {
  const { say, format } = phrasebook;

  const duration = (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return say("plan.view.finishRange.hoursMinutes", {
      hours: format.number(hours, { useGrouping: false }),
      value2: format.number(rest, { useGrouping: false, minimumIntegerDigits: 2 }),
    });
  };
  return `${duration(value.min)}–${duration(value.max)}`;
}

function decimalHours(phrasebook: Phrasebook, durationS: number): string {
  const { say, format } = phrasebook;

  return say("plan.view.decimalHours.hours", {
    value1: format.number(durationS / 3_600, {
      useGrouping: false,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  });
}

function historyDuration(phrasebook: Phrasebook, durationS: number | null): string {
  const { say, format } = phrasebook;

  if (durationS === null) return "—";
  const hours = Math.floor(durationS / 3_600);
  const minutes = Math.floor((durationS % 3_600) / 60);
  return say("plan.view.duration.clock", {
    major: format.number(hours, { useGrouping: false }),
    minor: format.number(minutes, { useGrouping: false, minimumIntegerDigits: 2 }),
  });
}

function historyReason(phrasebook: Phrasebook, entry: PlanHistoryEntry): string | null {
  const { say } = phrasebook;

  if (entry.undoStatus === "eligible") {
    return say("plan.view.appliedHistory.undoEligibility");
  }
  if (entry.undoStatus === "undone") return say("plan.view.historyReason.undone");
  if (entry.undoStatus !== "expired") return null;
  if (entry.undoReason === "newer-change") return say("plan.view.historyReason.newerChange");
  if (entry.undoReason === "workout-not-future") return say("plan.view.historyReason.workoutPast");
  if (entry.undoReason === "workout-not-coach-owned")
    return say("plan.view.historyReason.workoutUnowned");
  if (entry.undoReason === "workout-changed") return say("plan.view.historyReason.workoutChanged");
  if (entry.undoReason === "plan-not-active") return say("plan.view.historyReason.planInactive");
  if (entry.undoReason === "workout-missing") return say("plan.view.historyReason.workoutMissing");
  return say("plan.view.historyReason.unavailable");
}

function historyDetail(phrasebook: Phrasebook, entry: PlanHistoryEntry): string {
  const { say, format } = phrasebook;

  if (entry.before === null || entry.after === null)
    return say("plan.view.historyDetail.approvedLocally");
  const workout = `${entry.before.name} · ${historyDuration(phrasebook, entry.before.durationS)} → ${entry.after.name} · ${historyDuration(phrasebook, entry.after.durationS)}`;
  return entry.weekLoadBefore === null || entry.weekLoadAfter === null
    ? workout
    : say("plan.view.historyDetail.workoutLoadChange", {
        workout: workout,
        value2: format.number(entry.weekLoadBefore, { useGrouping: false }),
        value3: format.number(entry.weekLoadAfter, { useGrouping: false }),
      });
}

function PlanHistoryProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly entries: readonly PlanHistoryEntry[];
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;

  const actions = useEnduragentStore((state) => state.planActions);
  const currentPhase =
    props.data.season?.weeks.find((week) => week.status === "current")?.phase ??
    props.data.plan.phaseSummary?.[0] ??
    say("plan.view.planView.plan");
  return (
    <div className="grid gap-6">
      <section className="flex items-start justify-between gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className={SUPPORT_PAIR}>
          <h2 className="m-0 text-lg font-semibold">{props.data.plan.name}</h2>
          <p className="m-0 text-ink-2">
            {say("plan.view.planHistory.phaseSummary", {
              currentPhase: currentPhase,
              value1:
                props.data.plan.ftpWatts === undefined
                  ? ""
                  : say("plan.view.active.ftpSummary", {
                      value1: format.number(props.data.plan.ftpWatts, { useGrouping: false }),
                    }),
            })}
          </p>
        </div>
        <span className="rounded-chip bg-sunk px-3 py-1 text-sm text-ok">
          {say("plan.view.planHistory.active")}
        </span>
      </section>
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className={SUPPORT_PAIR}>
          <h2
            id="plan-history-heading"
            tabIndex={-1}
            className="m-0 text-lg font-semibold outline-none"
          >
            {say("plan.view.planHistory.planChanges")}
          </h2>
          <p className="m-0 text-ink-2">{say("plan.view.planHistory.immutableDescription")}</p>
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
                    {format.date(new Date(entry.occurredAtMs), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    {" · "}
                    {historyDetail(phrasebook, entry)}
                  </p>
                </div>
                {entry.undoStatus === "eligible" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => actions?.undoPlanChange(entry.id)}
                  >
                    <Undo2 className="size-4" aria-hidden="true" />
                    {say("chat.planChange.undo")}
                  </Button>
                ) : null}
              </div>
              {historyReason(phrasebook, entry) === null ? null : (
                <p className="m-0 text-sm text-ink-2">{historyReason(phrasebook, entry)}</p>
              )}
            </article>
          ))}
        </div>
      </section>
      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1">
        <div className="flex flex-col gap-inset px-5 py-row sm:flex-row sm:items-center sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">
              {say("plan.view.planSettings.planSettings")}
            </h2>
            <p className="m-0 text-sm text-ink-2">
              {say("plan.view.planHistory.settingsDescription")}
            </p>
          </div>
          <Button
            id="plan-settings-trigger"
            type="button"
            variant="outline"
            onClick={() => actions?.openPlanSettings()}
          >
            {say("plan.view.planHistory.openSettings")}
          </Button>
        </div>
        <div className="flex flex-col gap-inset border-t border-line px-5 py-row sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-sm text-ink-2">
            {say("plan.view.planHistory.endDescription", { product: "Enduragent" })}
          </p>
          <Button
            id="plan-end-trigger"
            type="button"
            variant="destructive"
            onClick={() => actions?.openEndConfirmation()}
          >
            {say("plan.view.active.endPlan")}
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const pending = useEnduragentStore((state) => state.plan.settingPending);
  const settings = props.data.settings;
  if (settings === undefined) {
    return (
      <StatusCard
        title={say("plan.view.planSettings.planSettings")}
        support={say("plan.view.planSettings.refreshing")}
      />
    );
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
              {saving
                ? say("plan.view.ended.saving")
                : failed
                  ? say("plan.view.planSettings.saveFailure")
                  : say("plan.view.ended.saved")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-inset">
          {failed ? (
            <Button type="button" variant="ghost" onClick={() => actions?.retry()}>
              {say("plan.view.ended.retry")}
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
            {say("plan.view.planSettings.planSettings")}
          </h2>
          <p className="m-0 text-ink-2">
            {say("plan.view.planSettings.subtitle", { value1: props.data.plan.name })}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => actions?.closePlanSettings()}>
          {say("plan.view.historyResult.backToHistory")}
        </Button>
      </div>
      <div className="divide-y divide-line border-t border-line">
        {row(
          "auto-apply",
          say("plan.view.planSettings.autoApply"),
          say("plan.view.planSettings.autoApplyDescription"),
          settings.autoApply,
        )}
        {row(
          "weekly-review",
          say("plan.view.weeklyReview.weeklyReview"),
          say("plan.view.planSettings.weeklyReviewDescription"),
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
              {say("plan.view.historyResult.undoExpired")}
            </h2>
            <p className="m-0 text-ink-2">
              {props.entry === null
                ? say("plan.view.historyResult.expiredDescription")
                : (historyReason(phrasebook, props.entry) ??
                  say("plan.view.historyResult.expiredDescription"))}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={() => actions?.openHistory()}>
            {say("plan.view.historyResult.backToHistory")}
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
            {say("plan.view.historyResult.planChangeUndone")}
          </h2>
          <p className="m-0 text-ink-2">
            {props.entry?.after === null || props.entry?.after === undefined
              ? say("plan.view.historyResult.restoredDescription")
              : say("plan.view.historyResult.restoredWorkoutDescription", {
                  value1: props.entry.after.name,
                  value2: historyDuration(phrasebook, props.entry.after.durationS),
                  intervals: "Intervals",
                })}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => actions?.openHistory()}>
          {say("plan.view.historyResult.viewHistory")}
        </Button>
        <Button type="button" onClick={() => actions?.closeHistory()}>
          {say("plan.view.planView.backToPlan")}
        </Button>
      </div>
    </section>
  );
}

function AppliedHistoryProjection(props: {
  readonly entry: PlanHistoryEntry | null;
  readonly autoApplied?: boolean;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;

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
                ? say("plan.view.appliedHistory.planUpdated")
                : say("plan.view.appliedHistory.automaticTitle", { value1: after.name })
              : after === null
                ? say("plan.view.appliedHistory.planUpdated")
                : say("plan.view.appliedHistory.approvedTitle", { value1: after.name })}
          </h2>
          <p className="m-0 text-ink-2">
            {props.autoApplied
              ? say("plan.view.appliedHistory.automaticDescription", { intervals: "Intervals" })
              : say("plan.view.appliedHistory.approvedDescription", { intervals: "Intervals" })}
          </p>
        </div>
      </div>
      {before === null || after === null ? null : (
        <BeforeAfterList
          label={say("plan.view.appliedHistory.workoutChange")}
          rows={[
            {
              id: props.entry?.id ?? "workout",
              label: say("chat.planChange.workout"),
              before: `${before.name} · ${historyDuration(phrasebook, before.durationS)}`,
              after: `${after.name} · ${historyDuration(phrasebook, after.durationS)}`,
            },
          ]}
        />
      )}
      {props.entry === null ||
      props.entry.weekLoadBefore === null ||
      props.entry.weekLoadAfter === null ? null : (
        <div className="flex items-center justify-between gap-inset">
          <span className="text-sm text-ink-2">
            {say("plan.view.appliedHistory.weekLoadChange")}
          </span>
          <strong>
            {props.entry.weekLoadAfter - props.entry.weekLoadBefore < 0 ? "−" : "+"}
            {format.number(Math.abs(props.entry.weekLoadAfter - props.entry.weekLoadBefore), {
              useGrouping: false,
            })}
          </strong>
        </div>
      )}
      {props.entry?.undoStatus === "eligible" ? (
        <div className="flex flex-col gap-inset sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-sm text-ink-2">
            {say("plan.view.appliedHistory.undoEligibility")}
          </p>
          <span className="self-start rounded-full bg-sunk px-3 py-1 text-sm text-ink-2">
            {say("plan.view.appliedHistory.eligible")}
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
            {say("chat.planChange.undo")}
          </Button>
        ) : null}
        <Button type="button" onClick={() => actions?.closeHistory()}>
          {say("plan.view.planView.backToPlan")}
        </Button>
      </div>
    </section>
  );
}

const MATCH_STATUS_COPY = {
  "as-planned": "plan.view.labels.asPlanned",
  adjusted: "plan.view.readiness.adjusted",
  moved: "plan.view.labels.moved",
  missed: "plan.view.labels.missed",
  extra: "plan.view.labels.extra",
  "decision-needed": "plan.view.active.decisionNeeded",
  "awaiting-sync": "plan.view.labels.awaitingSync",
  upcoming: "plan.view.season.planned",
} as const;

function matchStatusClass(status: keyof typeof MATCH_STATUS_COPY): string {
  if (status === "as-planned") return "text-ok";
  if (status === "adjusted" || status === "decision-needed") return "text-warn";
  if (status === "missed") return "text-danger";
  return "text-ink-2";
}

function RetryButton(): ReactElement | null {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

  const actions = useEnduragentStore((state) => state.planActions);
  if (actions === null) return null;
  return (
    <Button type="button" variant="outline" onClick={() => actions.retry()}>
      {say("plan.view.ended.retry")}
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
            {say("plan.view.chatOriginatedPlanResult.planResult")}
          </p>
          <h2 className="m-0 text-lg font-semibold">
            {terminal?.title ??
              (applied
                ? say("plan.view.chatOriginatedPlanResult.addedToPlan")
                : say("plan.view.chatOriginatedPlanResult.proposalNotAdded"))}
          </h2>
          <p className="m-0 text-ink-2">
            {terminal?.detail ?? say("plan.view.chatOriginatedPlanResult.completedDescription")}
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
            {say("plan.view.chatOriginatedPlanResult.backToChat")}
          </Button>
        )}
        {applied && model?.planId !== null && model?.planId !== undefined ? (
          <Button type="button" onClick={() => planActions?.open()}>
            {say("plan.view.chatOriginatedPlanResult.openCurrentWeek")}
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

function courseSummaryCopy(phrasebook: Phrasebook, course: PlanRaceCourseSummary): string {
  const { say, format } = phrasebook;

  const distance = format.number(course.distanceM / 1_000, { maximumFractionDigits: 1 });
  const elevation =
    course.elevationGainM === null
      ? say("plan.view.courseSummary.elevationUnavailable")
      : say("plan.view.courseSummary.elevation", {
          value1: format.number(Math.round(course.elevationGainM)),
        });
  return say("plan.view.courseSummary.summary", { distance: distance, elevation: elevation });
}

function CourseActions(props: {
  readonly replace?: boolean;
  readonly routeOnly?: boolean;
  readonly retry?: boolean;
  readonly continueWithout?: boolean;
  readonly remove?: boolean;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
          {say("plan.view.raceCourse.replaceFile")}
        </Button>
      ) : null}
      {props.routeOnly === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.useCourseWithoutElevation()}
        >
          {say("plan.view.courseActions.useRouteOnly")}
        </Button>
      ) : null}
      {props.retry === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.retry()}
        >
          {say("plan.view.ended.retry")}
        </Button>
      ) : null}
      {props.continueWithout === true ? (
        <Button
          type="button"
          disabled={actions === null || busy}
          onClick={() => actions?.continueWithoutCourse()}
        >
          {say("plan.view.planCoach.continueWithoutCourse")}
        </Button>
      ) : null}
      {props.remove === true ? (
        <Button
          type="button"
          variant="outline"
          disabled={actions === null || busy}
          onClick={() => actions?.removeCourse()}
        >
          {say("plan.view.planCoach.continueWithoutCourse")}
        </Button>
      ) : null}
    </div>
  );
}

function RaceCoursePanel(props: {
  readonly course: PlanRaceCourseProjection;
  readonly draft: boolean;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
            {recalculating
              ? say("plan.view.raceCourse.recalculatingDraft")
              : say("plan.view.raceCourse.readingRaceCourse")}
          </h3>
          <p className="m-0 text-ink-2">
            {recalculating
              ? say("plan.view.draftFormation.updateDescription")
              : say("plan.view.raceCourse.readingDescription")}
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
            <p className="m-0 text-ink-2">{courseSummaryCopy(phrasebook, course.accepted)}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-inset pt-inset">
          <Button type="button" variant="outline" onClick={() => actions?.openCoursePicker()}>
            {say("plan.view.raceCourse.replaceFile")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              props.draft ? actions?.removeCourse() : actions?.continueWithoutCourse()
            }
          >
            {say("plan.view.planCoach.continueWithoutCourse")}
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
            <h3 className="m-0 text-sm font-medium">
              {say("plan.view.raceCourse.unreadableTitle")}
            </h3>
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
            <h3 className="m-0 text-sm font-medium">
              {say("plan.view.raceCourse.missingElevationTitle")}
            </h3>
            <p className="m-0 text-ink-2">{courseSummaryCopy(phrasebook, course.candidate)}</p>
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
            <h3 className="m-0 text-sm font-medium">
              {say("plan.view.raceCourse.draftRecalculationFailed")}
            </h3>
            <p className="m-0 text-ink-2">
              {say("plan.view.raceCourse.yourPreviousDraftIsUnchanged")}
            </p>
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
            <h3 className="m-0 text-sm font-medium">{say("plan.view.raceCourse.skipFailure")}</h3>
            <p className="m-0 text-ink-2">{say("plan.view.raceCourse.nothingChanged")}</p>
          </div>
        </div>
        <div className="flex justify-end gap-inset pt-inset">
          <Button type="button" variant="outline" onClick={() => actions?.returnToCoach()}>
            {say("plan.view.draft.backToCoach")}
          </Button>
          <Button type="button" onClick={() => actions?.retry()}>
            {say("plan.view.ended.retry")}
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section className="grid gap-row rounded-card bg-sunk p-4">
      <div className={SUPPORT_PAIR}>
        <h3 className="m-0 text-sm font-medium">
          {say("plan.view.raceCourse.raceCourseOptional")}
        </h3>
        <p className="m-0 text-ink-2">
          {course.status === "omitted"
            ? say("plan.view.raceCourse.skippedDescription")
            : say("plan.view.raceCourse.attachDescription", { gpx: "GPX", fit: "FIT" })}
        </p>
      </div>
      <div className="flex flex-wrap justify-end gap-inset pt-inset">
        <Button type="button" variant="outline" onClick={() => actions?.openCoursePicker()}>
          {course.status === "omitted"
            ? say("plan.view.raceCourse.addFile")
            : say("plan.view.raceCourse.attachCourse", { gpx: "GPX", fit: "FIT" })}
        </Button>
        {course.status === "undecided" ? (
          <Button type="button" onClick={() => actions?.continueWithoutCourse()}>
            {say("plan.view.planCoach.continueWithoutCourse")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function CoursePickerDialog(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
          <DialogTitle className="m-0 text-xl">
            {say("plan.view.coursePicker.addRaceCourse")}
          </DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            {say("plan.view.coursePicker.description", { gpx: "GPX", fit: "FIT" })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            {say("common.cancel")}
          </DialogClose>
          <Button type="button" size="lg" onClick={() => actions?.chooseCourseFile()}>
            {say("plan.view.coursePicker.chooseFile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanQueue(): ReactElement | null {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;

  const queue = useEnduragentStore((state) => state.plan.coach.queued);
  const retry = useEnduragentStore((state) => state.plan.coach.retryRequired);
  const actions = useEnduragentStore((state) => state.planActions);
  if (queue.length === 0) return null;
  return (
    <section
      className="overflow-hidden rounded-card bg-sunk"
      aria-label={say("plan.view.planQueue.queuedCoachMessages")}
    >
      <div className="flex min-h-ctl items-center justify-between px-ctl-px">
        <h3 className="m-0 text-xs font-semibold">{say("plan.view.planQueue.queuedMessages")}</h3>
        <span className="rounded-chip bg-surface px-inset text-xs text-ink-2">
          {format.number(queue.length, { useGrouping: false })}
        </span>
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
            {say("plan.view.planQueue.retryInterruptedMessage")}
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
              aria-label={say("plan.view.planQueue.removeMessageLabel", {
                value1: format.number(index + 1, { useGrouping: false }),
              })}
              disabled={actions === null || retry?.queuedMessageIds.includes(message.id) === true}
              onClick={() => actions?.removeQueuedCoachMessage(message.id)}
            >
              {say("plan.view.planQueue.remove")}
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

function ftpSourceCopy(
  phrasebook: Phrasebook,
  value: PlanFtpSourceValue | null,
  empty: string,
): string {
  const { say, format } = phrasebook;

  if (value === null) return empty;
  const refreshed = format.date(value.refreshedAtMs, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return say("plan.view.ftpSource.sourceSummary", {
    value1: format.number(value.watts, { useGrouping: false }),
    refreshed: refreshed,
  });
}

function FtpSourceRow(props: {
  readonly label: string;
  readonly value: PlanFtpSourceValue | null;
  readonly empty: string;
  readonly selected: boolean;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-inset">
      <span className="text-sm font-medium">{props.label}</span>
      <span className={props.selected ? "text-sm text-primary" : "text-sm text-ink-2"}>
        {ftpSourceCopy(phrasebook, props.value, props.empty)}
        {props.selected ? say("plan.view.ftpSourceRow.usedForThisDraft") : ""}
      </span>
    </div>
  );
}

function FtpResolution(props: { readonly ftp: PlanFtpProjection }): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
      setValidation(say("plan.view.ftpResolution.wattsValidation"));
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
      ? say("plan.view.ftpResolution.missingSourceDescription", { intervals: "Intervals" })
      : model?.scenarioId === "PL-S060"
        ? say("plan.view.ftpResolution.conflictingSourcesDescription")
        : model?.scenarioId === "PL-S062"
          ? say("plan.view.ftpResolution.savedDescription")
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
            {say("plan.view.ftpResolution.ftpRequiredTitle")}
          </h2>
          <p className="m-0 text-ink-2">{say("plan.view.ftpResolution.ftpRequiredDescription")}</p>
        </div>
      </div>
      <form className="flex flex-wrap items-start gap-inset" onSubmit={submit}>
        <div className={SUPPORT_PAIR}>
          <label className="sr-only" htmlFor="plan-ftp-watts">
            {say("plan.view.ftpResolution.wattsLabel")}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="plan-ftp-watts"
              className="h-ctl w-28 rounded-ctl border border-line-2 bg-sunk px-3 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/20"
              inputMode="numeric"
              maxLength={4}
              placeholder={say("plan.view.ftpResolution.wattsPlaceholder")}
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
          {busy && pending === "save" ? say("plan.view.ended.saving") : say("common.save")}
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
          {say("plan.view.ftpResolution.sourceStatus")}
        </h3>
        <div className="mt-inset divide-y divide-line">
          <FtpSourceRow
            label={say("plan.view.planCoach.athleteEnteredFTP")}
            value={props.ftp.manual}
            empty={say("plan.view.ftpResolution.notEntered")}
            selected={props.ftp.usedSource === "manual"}
          />
          <FtpSourceRow
            label={say("chat.planChange.ftpSource.intervalsFtp", { provider: "Intervals" })}
            value={props.ftp.intervalsFtp}
            empty={say("plan.view.ftpResolution.notFound")}
            selected={props.ftp.usedSource === "intervals-ftp"}
          />
          <FtpSourceRow
            label={say("chat.planChange.ftpSource.intervalsEftp", { provider: "Intervals" })}
            value={props.ftp.intervalsEftp}
            empty={say("plan.view.ftpResolution.notFound")}
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
            ? say("plan.view.ftpResolution.refreshing")
            : model?.scenarioId === "PL-S059"
              ? say("plan.view.ended.retry")
              : say("plan.view.ftpResolution.refreshIntervals", { intervals: "Intervals" })}
        </Button>
      </div>
    </section>
  );
}

function PlanCoach(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;

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
            <h2 className="m-0 text-lg font-semibold">
              {say("plan.view.planCoach.planConversation")}
            </h2>
            <p className="m-0 text-ink-2">{say("plan.view.planCoach.historyDescription")}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => actions?.closeEndedConversation()}>
            {say("plan.view.planCoach.backToEndedPlan")}
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
      mon: say("plan.view.planCoach.monday"),
      tue: say("plan.view.planCoach.tuesday"),
      wed: say("plan.view.planCoach.wednesday"),
      thu: say("plan.view.planCoach.thursday"),
      fri: say("plan.view.planCoach.friday"),
      sat: say("plan.view.planCoach.saturday"),
      sun: say("plan.view.planCoach.sunday"),
    };
    const intake = data?.intake;
    const ftp = data?.ftp;
    const course = data?.course;
    const sourceLabel =
      ftp?.usedSource === "intervals-ftp"
        ? say("chat.planChange.ftpSource.intervalsFtp", { provider: "Intervals" })
        : ftp?.usedSource === "intervals-eftp"
          ? say("chat.planChange.ftpSource.intervalsEftp", { provider: "Intervals" })
          : ftp?.usedSource === "manual"
            ? say("plan.view.planCoach.athleteEnteredFTP")
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
            <h2 className="m-0 text-sm font-medium">{say("plan.view.planCoach.readinessTitle")}</h2>
            <p className="m-0 text-ink-2">{say("plan.view.planCoach.readinessDescription")}</p>
          </div>
          {intake === undefined ? null : (
            <dl className="m-0 grid gap-0 border-y border-line">
              <div className="grid gap-1 py-row">
                <dt className="text-sm font-medium">{say("plan.view.planCoach.goalEvent")}</dt>
                <dd className="m-0 text-sm text-ink-2">
                  {say("plan.view.planCoach.goalSummary", {
                    value1: intake.eventName ?? "",
                    value2: intake.eventPriority ?? "",
                    value3: intake.eventDate ?? "",
                  })}
                </dd>
                <dd className="m-0 text-sm text-ink-2">{intake.goal}</dd>
              </div>
              <div className="grid gap-1 border-t border-line py-row">
                <dt className="text-sm font-medium">
                  {say("chat.planCreation.availabilityLabel")}
                </dt>
                <dd className="m-0 text-sm text-ink-2">
                  {intake.availabilityWeekdays.map((day) => weekdayLabels[day]).join(" · ")}
                </dd>
              </div>
              <div className="grid gap-1 border-t border-line py-row">
                <dt className="text-sm font-medium">{say("plan.view.planCoach.ftpLabel")}</dt>
                <dd className="m-0 text-sm text-ink-2">
                  {say("plan.view.planCoach.ftpSummary", {
                    value1: ftp?.usedWatts ?? "",
                    value2: sourceLabel === null ? "" : ` · ${sourceLabel}`,
                  })}
                </dd>
              </div>
              <div className="grid gap-1 border-t border-line py-row">
                <dt className="text-sm font-medium">{say("plan.view.planCoach.raceCourse")}</dt>
                <dd className="m-0 text-sm text-ink-2">
                  {course?.accepted?.fileName ?? say("plan.view.planCoach.courseAgnostic")}
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
                  <h3 className="m-0 text-sm font-medium">
                    {say("plan.view.planCoach.creationFailure")}
                  </h3>
                  <p className="m-0 text-ink-2">{transition.error.message}</p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={() => actions?.retry()}>
                  {say("plan.view.ended.retry")}
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
              {say("plan.view.draft.backToCoach")}
            </Button>
            <Button
              type="button"
              disabled={actions === null || busy}
              onClick={() => actions?.createDraft()}
            >
              {data?.replacement
                ? say("plan.view.planCoach.createReplacementDraft")
                : say("plan.view.planCoach.createDraft")}
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
      aria-label={say("plan.view.planCoach.planCoach")}
    >
      <main
        ref={conversation}
        className="min-h-0 overflow-auto pt-[calc(var(--inset)*4)] pb-[calc(var(--inset)*3)] [overflow-anchor:none] max-[760px]:pt-[calc(var(--inset)*3)]"
        aria-label={say("plan.view.planCoach.conversationLabel")}
      >
        <div className="mx-auto grid w-[min(720px,calc(100%-48px))] gap-6 max-[760px]:w-[calc(100%-32px)]">
          {model?.scenarioId === "PL-S020" ? (
            <div className="flex items-start gap-row text-ok" role="status">
              <CheckCircle2 className="mt-0.5 size-4" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-base font-medium text-ink">
                  {say("plan.view.planCoach.draftDiscarded")}
                </h2>
                <p className="m-0 text-ink-2">{say("plan.view.planCoach.conversationPreserved")}</p>
              </div>
            </div>
          ) : null}
          {data?.ftp?.conflict === true && data.ftp.usedWatts !== null ? (
            <div
              className="rounded-ctl bg-[color-mix(in_srgb,var(--warn)_10%,var(--surface))] p-3 text-sm"
              role="status"
            >
              {say("plan.view.planCoach.selectedFtpConflict", {
                value1: format.number(data.ftp.usedWatts, { useGrouping: false }),
              })}
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
                <h2 className="m-0 text-sm font-medium">
                  {say("plan.view.planCoach.chooseAnotherGoalEventDate")}
                </h2>
                <p className="m-0 text-ink-2">{say("plan.view.planCoach.goalDateConstraints")}</p>
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
                aria-label={say("plan.view.planCoach.attachRaceCourse")}
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
                  {say("plan.view.planCoach.continueWithoutCourse")}
                </Button>
              ) : null}
            </div>
          }
          surface={{
            status: coach.status,
            sendDisabled: coach.sendDisabled,
            inputDisabled: coach.inputDisabled || decision?.status === "unanswered",
            placeholder: say("plan.view.planCoach.replyPlaceholder"),
            label: say("plan.view.planCoach.replyLabel"),
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
          ? say("plan.view.draftFormation.updatingYourDraft")
          : replacement
            ? say("plan.view.draftFormation.buildingTheReplacementDraft")
            : say("plan.view.draftFormation.buildingYourDraft")
      }
      summary={
        revision
          ? say("plan.view.draftFormation.updateDescription")
          : replacement
            ? say("plan.view.draftFormation.replacementDescription")
            : say("plan.view.draftFormation.creationDescription")
      }
    >
      <ProgressDisplay
        className="px-4 pb-4"
        label={
          revision
            ? say("plan.view.draftFormation.updatingYourDraft")
            : replacement
              ? say("plan.view.draftFormation.buildingTheReplacementDraft")
              : say("plan.view.draftFormation.buildingYourDraft")
        }
        value={{ kind: "indeterminate" }}
      />
    </ArtifactCard>
  );
}

function DiscardDraftDialog(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
          <DialogTitle className="m-0 text-xl">{say("plan.view.discardDraft.title")}</DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            {say("plan.view.discardDraft.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            {say("common.cancel")}
          </DialogClose>
          <Button
            type="button"
            variant="destructive-solid"
            size="lg"
            onClick={() => actions?.discardDraft()}
          >
            {say("plan.view.discardDraft.discardDraft")}
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
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
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
  const monthLabel = format.date(first, {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
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
      ? say("plan.view.datePicker.useShortBlock")
      : preview !== null && preview.raceWeekday !== 0
        ? say("plan.view.datePicker.useThisDate")
        : say("plan.view.datePicker.recalculatePlan");

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
          <DialogTitle className="m-0 text-xl">
            {say("plan.view.datePicker.chooseAStartDate")}
          </DialogTitle>
          <DialogDescription className="m-0 leading-[1.5]">
            {say("plan.view.datePicker.dateConstraints")}
          </DialogDescription>
        </DialogHeader>
        <section className="mt-5" aria-label={say("plan.view.datePicker.planStartDateCalendar")}>
          <div className="grid grid-cols-[40px_1fr_40px] items-center gap-inset">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={say("plan.view.datePicker.previousMonth")}
              onClick={() => moveMonth(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <h3 className="m-0 text-center text-base font-semibold">{monthLabel}</h3>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={say("plan.view.datePicker.nextMonth")}
              onClick={() => moveMonth(1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <div className="mt-inset grid grid-cols-7 gap-1" aria-hidden="true">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday} className="py-1 text-center text-xs text-ink-2">
                {say(weekday)}
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
                  aria-label={planDate(day.value, {
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
                  {format.number(day.label, { useGrouping: false })}
                </button>
              );
            })}
          </div>
        </section>
        {preview === null || targetDate === undefined ? null : (
          <section className="mt-5 grid gap-row rounded-card bg-sunk p-4" aria-live="polite">
            <div className={SUPPORT_PAIR}>
              <h3 className="m-0 text-sm font-semibold">
                {preview.kind === "full-plan"
                  ? say("plan.view.draft.fullPlan")
                  : say("plan.view.draft.shortRacePreparationBlock")}
              </h3>
              <p className="m-0 text-ink-2">
                {say("plan.view.datePicker.dateSummary", {
                  count: preview.totalWeeks,
                  start: planDate(selected),
                  end: planDate(targetDate),
                  weeks: format.number(preview.totalWeeks, { useGrouping: false }),
                  days: format.number(preview.inclusiveDays, { useGrouping: false }),
                })}
              </p>
            </div>
            {preview.raceWeekday === 0 ? null : (
              <p className="m-0 text-sm text-ink-2">
                {say("plan.view.datePicker.fixedRaceDateDescription", {
                  value1: planDate(targetDate, { weekday: "long" }),
                })}
              </p>
            )}
          </section>
        )}
        <DialogFooter className="mx-0 mt-[22px] mb-0 flex-row justify-end border-0 bg-transparent p-0">
          <DialogClose render={<Button ref={cancel} variant="outline" size="lg" />}>
            {say("common.cancel")}
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
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
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
            <h2 className="m-0 text-base font-semibold">{say("plan.view.draft.recalculating")}</h2>
            <p className="m-0 text-ink-2">{say("plan.view.draft.recalculationDescription")}</p>
          </div>
        </section>
      ) : null}
      <ArtifactCard
        headingLevel={2}
        title={plan?.name ?? model?.title ?? say("plan.view.draft.draftPlan")}
        summary={
          <>
            {plan === null
              ? model?.summary
              : say("plan.view.draft.summary", {
                  value1: format.number(plan.workoutCount, { useGrouping: false }),
                  value2: plannedTime(phrasebook, plan.plannedDurationS),
                  value3:
                    plan.phaseSummary?.join(" → ") ??
                    say("plan.view.draft.weeks", {
                      count: plan.totalWeeks,
                      weeks: format.number(plan.totalWeeks, { useGrouping: false }),
                    }),
                })}
            <p className="m-0">{say("plan.view.draft.calendarNotStarted")}</p>
          </>
        }
        status={say("chat.planCreation.draft")}
      >
        <div className="grid gap-5 px-4 pb-4">
          {replacement ? (
            <div className="flex items-start gap-row rounded-ctl bg-sunk p-3">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-semibold">
                  {say("plan.view.draft.currentPlanStaysActive")}
                </h2>
                <p className="m-0 text-ink-2">
                  {say("plan.view.draft.replacementPendingDescription")}
                </p>
              </div>
            </div>
          ) : null}
          {model?.scenarioId === "PL-S031" ? (
            <div className="flex items-start gap-row text-ok" role="status">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-semibold text-ink">
                  {say("plan.view.draft.draftUpdated")}
                </h2>
                <p className="m-0 text-ink-2">{say("plan.view.draft.updatedDescription")}</p>
              </div>
            </div>
          ) : null}
          {model?.scenarioId === "PL-S050" ? (
            <div className="flex items-start gap-row text-ok" role="status">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className={SUPPORT_PAIR}>
                <h2 className="m-0 text-sm font-semibold text-ink">
                  {say("plan.view.draft.startDateUpdated")}
                </h2>
                <p className="m-0 text-ink-2">
                  {say("plan.view.draft.startDateUpdatedDescription")}
                </p>
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
                      ? say("plan.view.draft.chooseAnotherStartDate")
                      : say("plan.view.draft.recalculationFailure")}
                  </h2>
                  <p className="m-0 text-ink-2">{say("plan.view.draft.preservedDescription")}</p>
                </div>
              </div>
              <div className="flex justify-end gap-inset">
                <Button type="button" variant="outline" onClick={() => actions?.openDatePicker()}>
                  {say("plan.view.draft.chooseAnotherDate")}
                </Button>
                {model.scenarioId === "PL-S048" ? (
                  <Button type="button" onClick={() => actions?.retry()}>
                    {say("plan.view.ended.retry")}
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
                  {say("plan.view.draft.reviseAgain")}
                </Button>
              </div>
            </div>
          ) : null}
          {transition.status === "failed" &&
          (transition.transitionId === "PL-T11" || transition.transitionId === "PL-T26") ? (
            <StaleNotice message={say("plan.view.draft.activationFailure")} />
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
                  <h3 className="m-0 text-sm font-semibold">{say("plan.view.draft.startDate")}</h3>
                  <p className="m-0 text-ink-2">
                    {planDate(plan.startDate)} ·{" "}
                    {plan.kind === "full-plan"
                      ? say("plan.view.draft.fullPlan")
                      : say("plan.view.draft.shortRacePreparationBlock")}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={actions === null || busy}
                onClick={() => actions?.openDatePicker()}
              >
                {say("chat.planChange.change")}
              </Button>
            </div>
          ) : null}
          {revisionComposer ? (
            <form className="grid gap-inset border-t border-line pt-5" onSubmit={submit}>
              <label className="text-sm font-medium" htmlFor="plan-draft-revision">
                {say("plan.view.draft.revisionLabel")}
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
                  {say("common.cancel")}
                </Button>
                <Button type="submit" disabled={!/\S/u.test(instruction)}>
                  {say("plan.view.draft.updateDraft")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="grid gap-row border-t border-line pt-5">
              <div className="flex flex-wrap items-center justify-between gap-row">
                <p className="m-0 text-sm text-ink-2">
                  {replacement
                    ? say("plan.view.draft.replacementApprovalDescription")
                    : say("plan.view.draft.approvalDescription", { intervals: "Intervals" })}
                </p>
                <div className="flex flex-wrap justify-end gap-inset">
                  <Button
                    id={replacement ? "plan-approve-replacement" : undefined}
                    type="button"
                    variant="outline"
                    disabled={actions === null || busy}
                    onClick={() => actions?.openRevisionComposer()}
                  >
                    {say("plan.view.draft.backToCoach")}
                  </Button>
                  <Button
                    type="button"
                    disabled={actions === null || busy}
                    aria-busy={approving ? "true" : undefined}
                    onClick={() => actions?.approveDraft()}
                  >
                    {approving
                      ? replacement
                        ? say("plan.view.active.checking")
                        : say("plan.view.draft.activating")
                      : replacement
                        ? say("plan.view.draft.approveReplacement")
                        : say("plan.view.draft.approvePlan")}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-row border-t border-line pt-5">
                <p className="m-0 text-sm text-ink-2">
                  {say("plan.view.draft.discardDescription")}
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={actions === null || busy}
                  onClick={() => actions?.openDiscardConfirmation()}
                >
                  {say("plan.view.draft.discardDraft")}
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
            <DialogTitle>{say("plan.view.draft.replacementTitle")}</DialogTitle>
            <DialogDescription>{say("plan.view.draft.replacementDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={replacementCancel}
              type="button"
              variant="outline"
              onClick={() => actions?.closeReplacementConfirmation()}
            >
              {say("common.cancel")}
            </Button>
            <Button type="button" onClick={() => actions?.confirmReplacement()}>
              {say("plan.view.active.replacePlan")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AttentionProjection(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;

  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const actions = useEnduragentStore((state) => state.planActions);
  if (model === null)
    return (
      <StatusCard
        title={say("plan.view.attention.planAttention")}
        support={say("plan.view.ready.refreshing")}
      />
    );
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <h2 className="m-0 text-base font-medium">{say("plan.view.attention.planAttention")}</h2>
        <p className="m-0 text-ink-2">
          {say("plan.view.attention.decisionCount", {
            count: model.attention.count,
            formattedCount: format.number(model.attention.count, { useGrouping: false }),
          })}
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
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const selected =
    props.data.selectedWorkoutId === undefined || props.data.selectedWorkoutId === null
      ? null
      : (props.data.selectedWorkout ??
        props.data.workouts.find((workout) => workout.id === props.data.selectedWorkoutId) ??
        null);
  if (selected === null) {
    return (
      <StatusCard
        title={say("plan.view.workoutDrift.title", { intervals: "Intervals" })}
        support={say("plan.view.workoutDrift.refreshing")}
      />
    );
  }
  const resolving =
    (transition.status === "submitting" || transition.status === "running") &&
    (transition.transitionId === "PL-T15" || transition.transitionId === "PL-T16");
  const adopted = props.scenarioId === "PL-S034";
  const restored = props.scenarioId === "PL-S036";
  const drift = selected.drift;
  const heading = resolving
    ? transition.transitionId === "PL-T15"
      ? say("plan.view.workoutDrift.updatingThePlan")
      : say("plan.view.workoutDrift.restoringPlanWorkout")
    : adopted
      ? say("plan.view.workoutDrift.adoptedTitle", { intervals: "Intervals" })
      : restored
        ? say("plan.view.workoutDrift.planWorkoutRestored")
        : say("plan.view.workoutDrift.changedDate", {
            value1: planDate(selected.date, { weekday: "long" }),
            intervals: "Intervals",
          });
  const support = resolving
    ? transition.transitionId === "PL-T15"
      ? say("plan.view.workoutDrift.adoptingDescription", { intervals: "Intervals" })
      : say("plan.view.workoutDrift.restoringDescription", { intervals: "Intervals" })
    : adopted
      ? say("plan.view.workoutDrift.adoptedDescription", {
          value1: selected.name,
          value2:
            selected.durationS === null
              ? say("plan.view.workoutDrift.updated")
              : plannedTime(phrasebook, selected.durationS),
          intervals: "Intervals",
        })
      : restored
        ? say("plan.view.workoutDrift.restoredDescription", {
            value1: selected.name,
            intervals: "Intervals",
          })
        : say("plan.view.workoutDrift.decisionDescription");
  return (
    <div className="grid gap-6">
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex items-start gap-row">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">
              {say("plan.view.active.activeWeek", {
                value1: format.number(props.data.weekIndex, { useGrouping: false }),
                value2: format.number(props.data.plan.totalWeeks, { useGrouping: false }),
              })}
            </h2>
            <p className="m-0 text-ink-2">
              {say("plan.view.workoutDrift.planStart", {
                value1: props.data.plan.name,
                value2: planDate(props.data.plan.startDate),
              })}
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
                <p className="m-0 text-sm text-ink-2">{say("plan.view.planView.plan")}</p>
                <p className="m-0 font-medium">{drift.plan.name}</p>
                <p className="m-0 text-sm text-ink-2">
                  {planDate(drift.plan.date)} ·{" "}
                  {drift.plan.durationS === null
                    ? say("plan.view.workoutDrift.noDuration")
                    : plannedTime(phrasebook, drift.plan.durationS)}
                </p>
              </div>
              <div className={SUPPORT_PAIR}>
                <p className="m-0 text-sm text-ink-2">Intervals</p>
                <p className="m-0 font-medium">{drift.provider.name}</p>
                <p className="m-0 text-sm text-ink-2">
                  {planDate(drift.provider.date)} ·{" "}
                  {drift.provider.durationS === null
                    ? say("plan.view.workoutDrift.noDuration")
                    : plannedTime(phrasebook, drift.provider.durationS)}
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
                {say("plan.view.workoutDrift.adoptCalendarEdit", { intervals: "Intervals" })}
              </Button>
              <Button
                type="button"
                disabled={actions === null || resolving}
                onClick={() => actions?.resolveWorkoutDrift(selected.id, drift.eventId, "restore")}
              >
                {say("plan.view.workoutDrift.restorePlanWorkout")}
              </Button>
            </div>
          </>
        ) : null}
        {!resolving && (adopted || restored) ? (
          <div className="flex justify-end">
            <Button type="button" onClick={() => actions?.closeWorkout()}>
              {say("plan.view.planView.backToPlan")}
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const planDate = usePlanDate();
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const replacement = props.data.replacement;
  if (replacement === undefined) {
    return (
      <StatusCard
        title={say("plan.view.replacementLifecycle.replacementPlan")}
        support={say("plan.view.replacementLifecycle.refreshing")}
      />
    );
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
    ? say("plan.view.replacementLifecycle.replacementComplete")
    : mirrorBusy || props.scenarioId === "PL-S086"
      ? say("plan.view.replacementLifecycle.writingCalendar")
      : verified
        ? say("plan.view.replacementLifecycle.oldCleanupVerified")
        : failed
          ? say("plan.view.replacementLifecycle.oldPlanCleanupNeedsAttention")
          : cleanupBusy || props.scenarioId === "PL-S084"
            ? say("plan.view.replacementLifecycle.retryingOldPlanCleanup")
            : say("plan.view.replacementLifecycle.replacementActiveLocally");
  const support = history
    ? say("plan.view.replacementLifecycle.replacementCompleteDescription")
    : mirrorBusy || props.scenarioId === "PL-S086"
      ? say("plan.view.replacementLifecycle.mirrorVerifyingDescription", { intervals: "Intervals" })
      : verified
        ? say("plan.view.replacementLifecycle.cleanupVerifiedDescription")
        : failed
          ? say("plan.view.replacementLifecycle.cleanupBlockedDescription")
          : say("plan.view.replacementLifecycle.cleanupPendingDescription");

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
            <span>{say("chat.planChange.activePlan")}</span>
            <strong>{props.data.plan.name}</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>{say("plan.view.replacementLifecycle.previousPlan")}</span>
            <strong>
              {say("plan.view.replacementLifecycle.endedPlan", {
                value1: replacement.previousPlan.name,
              })}
            </strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>{say("chat.planChange.today")}</span>
            <strong>{say("plan.view.ended.preserved")}</strong>
          </div>
        </div>
        {failed && remaining.length > 0 ? (
          <div className="divide-y divide-line border-y border-line">
            {remaining.map((item) => (
              <div key={item.id} className="flex justify-between gap-row py-inset text-sm">
                <span>{planDate(item.date)}</span>
                <span className="text-warn">
                  {say("plan.view.ended.remainingCalendarEntry", { intervals: "Intervals" })}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {history ? (
          <div className="grid gap-row border-t border-line pt-row text-sm">
            <div className={SUPPORT_PAIR}>
              <strong>
                {say("plan.view.replacementLifecycle.activatedPlan", {
                  value1: props.data.plan.name,
                })}
              </strong>
              <span className="text-ink-2">
                {say("plan.view.replacementLifecycle.localReplacementCommitted")}
              </span>
            </div>
            <div className={SUPPORT_PAIR}>
              <strong>
                {say("plan.view.replacementLifecycle.cleanupVerified", {
                  value1: replacement.previousPlan.name,
                })}
              </strong>
              <span className="text-ink-2">
                {say("plan.view.replacementLifecycle.cleanupResult")}
              </span>
            </div>
            <div className={SUPPORT_PAIR}>
              <strong>{say("plan.view.replacementLifecycle.replacementMirrorCurrent")}</strong>
              <span className="text-ink-2">
                {say("plan.view.replacementLifecycle.mirrorWindow")}
              </span>
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
              {say("plan.view.ended.verifyAgain")}
            </Button>
            <Button
              type="button"
              disabled={actions === null || cleanupBusy}
              onClick={() => actions?.retryReplacementCleanup()}
            >
              {say("plan.view.replacementLifecycle.retryCleanup")}
            </Button>
          </>
        ) : verified ? (
          <Button
            type="button"
            disabled={actions === null || mirrorBusy}
            onClick={() => actions?.writeReplacementMirror()}
          >
            {say("plan.view.replacementLifecycle.writeNext7Days")}
          </Button>
        ) : history ? (
          <Button
            type="button"
            disabled={actions === null}
            onClick={() => actions?.openReplacementActivePlan()}
          >
            {say("plan.view.replacementLifecycle.openActivePlan")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function SeasonProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
  const actions = useEnduragentStore((state) => state.planActions);
  const season = props.data.season;
  if (season === undefined) {
    return (
      <StatusCard
        title={say("plan.view.season.season")}
        support={say("plan.view.season.unavailableDescription")}
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
              {say("plan.view.season.season")}
            </h2>
            <p className="m-0 text-ink-2">
              {say("plan.view.season.summary", {
                value1: format.number(props.data.plan.totalWeeks, { useGrouping: false }),
                value2: planDate(props.data.plan.startDate),
                value3:
                  props.data.plan.targetDate === null
                    ? ""
                    : `–${planDate(props.data.plan.targetDate)}`,
              })}
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
                {say("plan.view.raceWeek.raceWeek")}
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => actions?.closeSeason()}>
              {say("plan.view.planView.backToPlan")}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-row border-t border-line pt-row sm:flex-row sm:items-start sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">{props.data.plan.name}</h3>
            <p className="m-0 text-sm text-ink-2">
              {props.data.plan.targetDate === null
                ? props.data.plan.primaryGoal
                : `${planDate(props.data.plan.targetDate, { weekday: "short", day: "numeric", month: "short" })} · ${props.data.plan.primaryGoal}`}
              {season.distanceKm === null
                ? ""
                : say("plan.view.season.distance", {
                    value1: format.number(season.distanceKm, { useGrouping: false }),
                  })}
            </p>
          </div>
          {season.priority === null ? null : (
            <span className="self-start rounded-full border border-warn px-3 py-1 text-sm text-warn">
              {say("plan.view.raceWeek.eventPriority", { value1: season.priority })}
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
              <p className="m-0 font-medium">
                {say("plan.view.season.constraint", { value1: season.constraint.title })}
              </p>
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
                {say("plan.view.season.week")}
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                {say("plan.view.season.dates")}
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                {say("plan.view.season.phase")}
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                {say("plan.view.planView.plan")}
              </th>
              <th scope="col" className="px-5 py-3 text-right font-medium">
                {say("plan.view.season.hours")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {season.weeks.map((week) => {
              const status =
                week.status === "completed"
                  ? say("plan.view.ended.completed")
                  : week.status === "current"
                    ? say("plan.view.season.thisWeek")
                    : week.status === "blocked"
                      ? say("plan.view.season.blocked")
                      : say("plan.view.season.planned");
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
                    {say("plan.view.season.weekNumber", {
                      value1: format.number(week.weekIndex, { useGrouping: false }),
                    })}
                  </th>
                  <td className="px-5 py-row text-ink-2">
                    {planDate(week.startDate, { day: "numeric", month: "short" })}–
                    {planDate(week.endDate, { day: "numeric", month: "short" })}
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
                    {decimalHours(phrasebook, week.plannedDurationS)}
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const planDate = usePlanDate();
  const actions = useEnduragentStore((state) => state.planActions);
  const season = props.data.season;
  const raceWeek = season?.raceWeek;
  if (season === undefined || raceWeek === null || raceWeek === undefined) {
    return (
      <StatusCard
        title={say("plan.view.raceWeek.raceWeek")}
        support={say("plan.view.raceWeek.emptyDescription")}
      />
    );
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
              {say("plan.view.raceWeek.raceWeek")}
            </h2>
            <p className="m-0 text-ink-2">{say("plan.view.raceWeek.finalSevenPlanDays")}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => actions?.closeRaceWeek()}>
            {say("plan.view.raceWeek.backToSeason")}
          </Button>
        </div>
        <div className="flex flex-col gap-row border-t border-line pt-row sm:flex-row sm:items-start sm:justify-between">
          <div className={SUPPORT_PAIR}>
            <p className="m-0 text-sm font-medium uppercase tracking-wide text-warn">
              {say("plan.view.raceWeek.raceDay", {
                value1: planDate(raceWeek.raceDate, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                }),
              })}
            </p>
            <h3 className="m-0 text-lg font-semibold">{props.data.plan.name}</h3>
            <p className="m-0 text-sm text-ink-2">
              {say("plan.view.raceWeek.goalSummary", {
                value1: props.data.plan.primaryGoal,
                value2:
                  props.data.readiness?.courseEstimate.rangeMinutes === null ||
                  props.data.readiness?.courseEstimate.rangeMinutes === undefined
                    ? ""
                    : say("plan.view.raceWeek.finishEstimate", {
                        value1: finishRange(
                          phrasebook,
                          props.data.readiness.courseEstimate.rangeMinutes,
                        ),
                      }),
              })}
            </p>
          </div>
          {season.priority === null ? null : (
            <span className="self-start rounded-full border border-warn px-3 py-1 text-sm text-warn">
              {say("plan.view.raceWeek.eventPriority", { value1: season.priority })}
            </span>
          )}
        </div>
        <div className="grid gap-row border-t border-line pt-row sm:grid-cols-3">
          {[
            [say("plan.view.ended.training"), raceWeek.trainingDurationS],
            [say("plan.view.ended.race"), raceWeek.raceDurationS],
            [say("plan.view.ended.total"), raceWeek.totalDurationS],
          ].map(([label, value]) => (
            <div key={String(label)} className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">{label}</span>
              <strong className="text-2xl tabular-nums">
                {clockTime(phrasebook, Number(value))}
              </strong>
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
              <p className="m-0 font-medium">
                {say("plan.view.raceWeek.syncFailureTitle", { intervals: "Intervals" })}
              </p>
              <p className="m-0 text-sm text-ink-2">
                {say("plan.view.raceWeek.syncFailureDescription", { intervals: "Intervals" })}
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
                {say("plan.view.raceWeek.day")}
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                {say("chat.planChange.workout")}
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                {say("plan.view.raceWeek.time")}
              </th>
              <th scope="col" className="px-5 py-3 font-medium">
                {say("plan.view.raceWeek.purpose")}
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
                    {day.durationS === null ? "—" : clockTime(phrasebook, day.durationS)}
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

function signed(phrasebook: Phrasebook, value: number): string {
  const { format } = phrasebook;

  return format
    .number(value, { useGrouping: false, signDisplay: value > 0 ? "always" : "auto" })
    .replace("-", "−");
}

function formRange(phrasebook: Phrasebook, readiness: PlanReadinessProjection): string {
  const { say } = phrasebook;

  const range = readiness.form.raceRange;
  if (range === null) return say("plan.view.readiness.unavailable");
  return say("plan.view.formRange.signedRange", {
    value1: signed(phrasebook, range.min),
    value2: signed(phrasebook, range.max),
  });
}

function PredictionsSummary(props: {
  readonly readiness: PlanReadinessProjection | undefined;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

  const actions = useEnduragentStore((state) => state.planActions);
  const atRisk = props.readiness?.feasibility.verdict === "at-risk";
  const verdict =
    props.readiness === undefined
      ? say("plan.view.readiness.unavailable")
      : atRisk
        ? say("plan.view.predictionsSummary.riskDescription")
        : say("plan.view.readiness.onTrackWithAssumptions");
  return (
    <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
      <h2 className="m-0 text-base font-semibold">
        {say("plan.view.predictionsSummary.predictions")}
      </h2>
      <div className="grid gap-row sm:grid-cols-2">
        <div className={SUPPORT_PAIR}>
          <p className="m-0 text-sm text-ink-2">
            {say("plan.view.predictionsSummary.raceDayForm")}
          </p>
          <strong className="text-2xl">
            {props.readiness === undefined
              ? say("plan.view.readiness.unavailable")
              : formRange(phrasebook, props.readiness)}
          </strong>
        </div>
        <div className={SUPPORT_PAIR}>
          <p className="m-0 text-sm text-ink-2">{say("plan.view.readiness.goalFeasibility")}</p>
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
          {say("plan.view.predictionsSummary.viewRaceReadiness")}
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

function effortDuration(phrasebook: Phrasebook, durationS: number): string {
  const { say, format } = phrasebook;

  const minutes = Math.floor(durationS / 60);
  const seconds = durationS % 60;
  return say("plan.view.duration.clock", {
    major: format.number(minutes, { useGrouping: false }),
    minor: format.number(seconds, { useGrouping: false, minimumIntegerDigits: 2 }),
  });
}

function ReadinessProjection(props: {
  readonly data: ReturnType<typeof PlanActiveProjectionDataSchema.parse>;
  readonly scenarioId: string;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
  const actions = useEnduragentStore((state) => state.planActions);
  const transition = useEnduragentStore((state) => state.plan.transition);
  const readiness = props.data.readiness;
  const [overlay, setOverlay] = useState<"cp-info" | "cp-efforts" | "route" | null>(null);
  const cpInfoTrigger = useRef<HTMLButtonElement>(null);
  const cpEffortsTrigger = useRef<HTMLButtonElement>(null);
  const routeTrigger = useRef<HTMLButtonElement>(null);
  if (readiness === undefined) {
    return (
      <StatusCard
        title={say("plan.view.readiness.raceReadiness")}
        support={say("plan.view.readiness.unavailableDescription")}
      />
    );
  }
  const refreshing =
    props.scenarioId === "PL-S098" ||
    ((transition.status === "submitting" || transition.status === "running") &&
      transition.transitionId === "PL-T32");
  const lastRefresh =
    readiness.form.lastSuccessfulRefreshAtMs === null
      ? say("plan.view.readiness.refreshPending")
      : format.date(new Date(readiness.form.lastSuccessfulRefreshAtMs), {
          dateStyle: "medium",
          timeStyle: "short",
        });
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
          {say("plan.view.readiness.raceReadiness")}
        </h2>
        <p className="m-0 text-ink-2">
          {say("plan.view.readiness.subtitle", { value1: props.data.plan.name })}
        </p>
      </div>
      <Button type="button" variant="outline" onClick={() => actions?.closeReadiness()}>
        {say("plan.view.planView.backToPlan")}
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
            <h3 className="m-0 text-base font-semibold">
              {say("plan.view.readiness.refreshingTrainingLoad")}
            </h3>
            <p className="m-0 text-ink-2">{say("plan.view.readiness.refreshDescription")}</p>
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
            <h3 className="m-0 text-base font-semibold">
              {say("plan.view.readiness.hardWorkoutNotAdded")}
            </h3>
            <p className="m-0 text-ink-2">{readiness.taperRefusal.reason}</p>
          </div>
        </div>
        <div className="grid gap-inset rounded-card bg-sunk p-row">
          <div className="flex items-start justify-between gap-row">
            <span className="text-ink-2">{say("plan.view.readiness.requested")}</span>
            <strong className="text-right">{readiness.taperRefusal.requested}</strong>
          </div>
          <div className="flex items-start justify-between gap-row">
            <span className="text-ink-2">{say("plan.view.readiness.keptInPlan")}</span>
            <strong className="text-right">{readiness.taperRefusal.kept}</strong>
          </div>
        </div>
        <p className="m-0 text-ink-2">{say("plan.view.readiness.rejectedRequestDescription")}</p>
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
            <h3 className="m-0 text-base font-semibold">
              {say("plan.view.readiness.formUnavailableTitle")}
            </h3>
            <p className="m-0 text-ink-2">
              {readiness.error?.message ?? say("plan.view.readiness.incompleteLoadDescription")}
            </p>
          </div>
        </div>
        <div className="grid gap-inset rounded-card bg-sunk p-row sm:grid-cols-2">
          <div className={SUPPORT_PAIR}>
            <span className="text-sm text-ink-2">
              {say("plan.view.readiness.lastSuccessfulRefresh")}
            </span>
            <strong>{lastRefresh}</strong>
          </div>
          <div className={SUPPORT_PAIR}>
            <span className="text-sm text-ink-2">{say("plan.view.readiness.courseEstimate")}</span>
            <strong>
              {readiness.courseEstimate.rangeMinutes === null
                ? say("plan.view.readiness.unavailable")
                : finishRange(phrasebook, readiness.courseEstimate.rangeMinutes)}
            </strong>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" onClick={() => actions?.refreshReadiness()}>
            {say("plan.view.readiness.retryRefresh")}
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
              <h3 className="m-0 text-base font-semibold">
                {say("plan.view.readiness.changedEstimateTitle")}
              </h3>
              <p className="m-0 text-ink-2">
                {readiness.courseEstimate.changedAssumption ??
                  say("plan.view.readiness.changedAssumptionDescription")}
              </p>
            </div>
          </div>
          <div className="grid gap-inset rounded-card bg-sunk p-row sm:grid-cols-2">
            <div className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">{say("plan.view.readiness.previous")}</span>
              <strong className="text-xl">
                {readiness.courseEstimate.previousRangeMinutes === null
                  ? say("plan.view.readiness.unavailable")
                  : finishRange(phrasebook, readiness.courseEstimate.previousRangeMinutes)}
              </strong>
            </div>
            <div className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">{say("plan.view.readiness.updated")}</span>
              <strong className="text-xl">
                {readiness.courseEstimate.rangeMinutes === null
                  ? say("plan.view.readiness.unavailable")
                  : finishRange(phrasebook, readiness.courseEstimate.rangeMinutes)}
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
              {say("plan.view.readiness.viewAssumptions")}
            </Button>
          </div>
        </section>
        <Dialog open={overlay === "route"} onOpenChange={closeOverlay}>
          <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(440px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
            <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
              <DialogTitle>{say("plan.view.readiness.routeAssumptions")}</DialogTitle>
              <DialogDescription>
                {say("plan.view.readiness.assumptionsDescription")}
              </DialogDescription>
            </DialogHeader>
            <ul className="m-0 grid flex-1 content-start gap-row overflow-auto px-10 py-5 text-ink-2">
              {readiness.courseEstimate.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
            <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
              <Button type="button" onClick={() => closeOverlay(false)}>
                {say("plan.view.active.done")}
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
            <h3 className="m-0 text-base font-semibold">
              {say("plan.view.readiness.goalFeasibility")}
            </h3>
            <span className="rounded-full border border-danger px-3 py-1 text-sm text-danger">
              {say("plan.view.readiness.atRisk")}
            </span>
          </div>
          <strong className="text-2xl">
            {say("plan.view.readiness.currentForm", { value1: formRange(phrasebook, readiness) })}
          </strong>
          <ul className="m-0 grid gap-inset pl-5 text-ink-2">
            {readiness.feasibility.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
        <div className="flex items-start justify-between gap-row rounded-card bg-sunk p-row">
          <span className="text-ink-2">{say("plan.view.readiness.recommendation")}</span>
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
            <h3 className="m-0 text-base font-semibold">
              {say("plan.view.readiness.estimateUnavailableTitle")}
            </h3>
            <p className="m-0 text-ink-2">{say("plan.view.readiness.courseRequiredDescription")}</p>
          </div>
        </div>
        <div className="grid gap-inset rounded-card bg-sunk p-row">
          <div className="flex justify-between gap-row">
            <span>{say("plan.view.readiness.formTrajectory")}</span>
            <strong>{formRange(phrasebook, readiness)}</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>{say("plan.view.readiness.goalFeasibility")}</span>
            <strong>{say("plan.view.readiness.available")}</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>{say("plan.view.readiness.courseEstimate")}</span>
            <strong>{say("plan.view.readiness.unavailable")}</strong>
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
            <h3 className="m-0 text-sm font-semibold">
              {say("plan.view.readiness.raceDayTrajectory")}
            </h3>
            <strong className="text-2xl">
              {readiness.form.current === null
                ? say("plan.view.readiness.unavailable")
                : signed(phrasebook, readiness.form.current)}{" "}
              → {formRange(phrasebook, readiness)}
            </strong>
            <p className="m-0 text-sm text-ink-2">
              {say("plan.view.readiness.formModelDescription")}
            </p>
          </div>
          <div className={`${SUPPORT_PAIR} rounded-card bg-sunk p-4`}>
            <h3 className="m-0 text-sm font-semibold">
              {say("plan.view.readiness.goalFeasibility")}
            </h3>
            <span className="self-start rounded-full border border-ok px-3 py-1 text-sm text-ok">
              {say("plan.view.readiness.onTrackWithAssumptions")}
            </span>
            <p className="m-0 text-sm text-ink-2">{readiness.feasibility.recommendation}</p>
          </div>
          <div className={`${SUPPORT_PAIR} rounded-card bg-sunk p-4`}>
            <div className="flex items-center justify-between gap-inset">
              <h3 className="m-0 text-sm font-semibold">
                {say("plan.view.readiness.estimatedCP")}
              </h3>
              <div className="flex items-center gap-inset">
                <span className="rounded-full border border-warn px-2 py-0.5 text-xs text-warn">
                  {say("plan.view.readiness.experimental")}
                </span>
                <Button
                  ref={cpInfoTrigger}
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={say("plan.view.readiness.aboutEstimatedCP")}
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
                    ? say("plan.view.readiness.invalidPowerEstimate")
                    : say("plan.view.readiness.missingEffortsTitle")}
                </strong>
                {cp.unavailableReason === "missing-effort" ? (
                  <p className="m-0 text-sm text-ink-2">
                    {say("plan.view.readiness.missingEffortsDescription")}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <div className="flex items-center gap-inset">
                  <strong className="text-2xl">
                    {say("chat.planChange.watts", { watts: cp.watts ?? "" })}
                  </strong>
                  {cp.status === "stale" ? (
                    <span className="rounded-full border border-warn px-2 py-0.5 text-xs text-warn">
                      {say("chat.planCreation.stale")}
                    </span>
                  ) : null}
                </div>
                <p className="m-0 text-sm text-ink-2">
                  {cp.status === "stale" && cp.lastSuccessfulSyncAtMs !== null
                    ? say("plan.view.readiness.lastSync", {
                        value1: format.date(new Date(cp.lastSuccessfulSyncAtMs), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })
                    : cp.calculatedOn === null
                      ? say("plan.view.readiness.calculationDateUnavailable")
                      : say("plan.view.readiness.calculationDate", {
                          value1: planDate(cp.calculatedOn),
                        })}
                </p>
                <Button
                  ref={cpEffortsTrigger}
                  type="button"
                  variant="link"
                  className="h-auto justify-start p-0"
                  onClick={() => setOverlay("cp-efforts")}
                >
                  {say("plan.view.readiness.viewPowerEvidence")}
                </Button>
              </>
            )}
          </div>
          <div className={`${SUPPORT_PAIR} rounded-card bg-sunk p-4`}>
            <h3 className="m-0 text-sm font-semibold">
              {say("plan.view.readiness.courseBasedFinishTime")}
            </h3>
            <strong className="text-2xl">
              {readiness.courseEstimate.rangeMinutes === null
                ? say("plan.view.readiness.unavailable")
                : finishRange(phrasebook, readiness.courseEstimate.rangeMinutes)}
            </strong>
            <p className="m-0 text-sm text-ink-2">
              {readiness.courseEstimate.confidence === null
                ? say("plan.view.readiness.noEstimate")
                : say("plan.view.readiness.estimateConfidence", {
                    value1: readiness.courseEstimate.confidence,
                  })}
            </p>
            {readiness.courseEstimate.assumptions.length > 0 ? (
              <Button
                ref={routeTrigger}
                type="button"
                variant="link"
                className="h-auto justify-start p-0"
                onClick={() => setOverlay("route")}
              >
                {say("plan.view.readiness.viewRouteAssumptions")}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-row rounded-card bg-sunk p-row sm:grid-cols-3">
          {[
            [say("plan.view.readiness.prescribed"), readiness.evidence.prescribedDurationS],
            [say("plan.view.readiness.ridden"), readiness.evidence.riddenDurationS],
            [say("plan.view.readiness.adjusted"), readiness.evidence.adjustedDurationS],
          ].map(([label, value]) => (
            <div key={String(label)} className={SUPPORT_PAIR}>
              <span className="text-sm text-ink-2">{label}</span>
              <strong className="text-xl tabular-nums">
                {clockTime(phrasebook, Number(value))}
              </strong>
            </div>
          ))}
        </div>
      </section>
      <Dialog open={overlay === "cp-info"} onOpenChange={closeOverlay}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{say("plan.view.readiness.estimatedCP")}</DialogTitle>
            <DialogDescription>{say("plan.view.readiness.cpDescription")}</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
      <Dialog open={overlay === "cp-efforts"} onOpenChange={closeOverlay}>
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(480px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
            <DialogTitle>{say("plan.view.readiness.powerEffortsUsed")}</DialogTitle>
            <DialogDescription>
              {say("plan.view.readiness.cpEvidenceSummary", {
                value1: cp.watts ?? say("plan.view.readiness.unavailable"),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
            {cp.efforts.map((effort) => (
              <section
                key={`${effort.activityId}-${effort.durationS}`}
                className="grid gap-inset rounded-card bg-sunk p-row"
              >
                <div className="flex items-start justify-between gap-row">
                  <strong>
                    {effort.ride} · {planDate(effort.date)}
                  </strong>
                  <strong className="tabular-nums">
                    {say("plan.view.readiness.effortPower", {
                      value1: effortDuration(phrasebook, effort.durationS),
                      value2: format.number(effort.averagePowerW, { useGrouping: false }),
                    })}
                  </strong>
                </div>
                <p className="m-0 text-sm text-ink-2">
                  {say("plan.view.readiness.effortDevice", { value1: effort.device })}
                </p>
              </section>
            ))}
            {cp.status === "unavailable" ? (
              <p className="m-0 text-ink-2">{say("plan.view.readiness.cpEvidenceUnavailable")}</p>
            ) : (
              <p className="m-0 text-ink-2">
                {say("plan.view.readiness.cpEvidenceResult", { value1: cp.watts ?? "" })}
              </p>
            )}
          </div>
          <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
            <Button type="button" onClick={() => closeOverlay(false)}>
              {say("plan.view.active.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={overlay === "route"} onOpenChange={closeOverlay}>
        <DialogContent className="top-0 right-0 left-auto flex h-full max-h-none w-[min(440px,calc(100%-32px))] max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-l-card border-y-0 border-r-0 p-0">
          <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
            <DialogTitle>{say("plan.view.readiness.routeAssumptions")}</DialogTitle>
            <DialogDescription>
              {say("plan.view.readiness.assumptionsDescription")}
            </DialogDescription>
          </DialogHeader>
          <ul className="m-0 grid flex-1 content-start gap-row overflow-auto px-10 py-5 text-ink-2">
            {readiness.courseEstimate.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
          <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-line bg-surface px-5 py-row">
            <Button type="button" onClick={() => closeOverlay(false)}>
              {say("plan.view.active.done")}
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const planDate = usePlanDate();
  const actions = useEnduragentStore((state) => state.planActions);
  const review = props.data.weeklyReview;
  if (review?.status !== "delivered") {
    return (
      <StatusCard
        title={say("plan.view.weeklyReview.weeklyReview")}
        support={say("plan.view.weeklyReview.preparing")}
      />
    );
  }
  return (
    <section
      className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1"
      data-plan-scenario="PL-S100"
    >
      <div className="flex items-start justify-between gap-row">
        <div className={SUPPORT_PAIR}>
          <p className="m-0 text-sm font-medium text-ink-2">{say("plan.view.active.coach")}</p>
          <h2 className="m-0 text-lg font-semibold">
            {say("plan.view.weeklyReview.weeklyReview")}
          </h2>
          <p className="m-0 text-sm text-ink-2">
            {planDate(review.weekStart)}–{planDate(review.weekEnd)}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => actions?.closeWorkout()}>
          {say("plan.view.planView.backToPlan")}
        </Button>
      </div>
      <div className="grid gap-inset rounded-card bg-sunk p-row">
        <p className="m-0 text-base">{review.summary}</p>
        <p className="m-0 text-sm text-ink-2">
          {say("plan.view.weeklyReview.responseNotRequired")}
        </p>
      </div>
    </section>
  );
}

function PlanningRequestDateConflictProjection(props: {
  readonly context: PlanPlanningRequestContext;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const planDate = usePlanDate();
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
    return (
      <StatusCard
        title={say("plan.view.planningRequestDateConflict.planRequest")}
        support={say("plan.view.planningRequestDateConflict.refreshing")}
      />
    );
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
      ? say("plan.view.planningRequestDateConflict.reviewReplacement")
      : selectedDate === null || selectedDate.length === 0
        ? say("plan.view.planningRequestDateConflict.chooseDate")
        : say("plan.view.planningRequestDateConflict.useDate", { value1: planDate(selectedDate) });
  return (
    <section className="grid gap-5 rounded-card bg-surface p-5 shadow-elev-1">
      <div className={SUPPORT_PAIR}>
        <p className="m-0 text-xs font-semibold tracking-wide text-ink-2 uppercase">
          {say("plan.view.planningRequestDateConflict.dateConflict")}
        </p>
        <h2 className="m-0 text-xl font-semibold">
          {conflict.workouts[0] === undefined
            ? say("plan.view.planningRequestDateConflict.conflictTitle")
            : say("plan.view.planningRequestDateConflict.conflictDateTitle", {
                value1: planDate(conflict.workouts[0].date),
              })}
        </h2>
        <p className="m-0 text-ink-2">
          {say("plan.view.planningRequestDateConflict.conflictDescription")}
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
              <strong>
                {say("plan.view.planningRequestDateConflict.useDate", {
                  value1: planDate(recommended),
                })}
              </strong>
              <small className="text-ink-2">
                {say("plan.view.planningRequestDateConflict.noExistingWorkout")}
              </small>
            </span>
            <span className="rounded-full bg-ok/14 px-3 py-1 text-xs font-medium text-ok">
              {say("plan.view.planningRequestDateConflict.recommended")}
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
                <strong>
                  {say("plan.view.planningRequestDateConflict.replaceWorkout", {
                    value1: workout.name,
                  })}
                </strong>
                <small className="text-ink-2">
                  {say("plan.view.planningRequestDateConflict.replaceableWorkoutDescription", {
                    value1: clockTime(phrasebook, workout.durationS),
                  })}
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
            <strong>{say("plan.view.planningRequestDateConflict.chooseAnotherDate")}</strong>
            <small className="text-ink-2">
              {say("plan.view.planningRequestDateConflict.customDateDescription")}
            </small>
          </span>
          <CalendarDays className="size-4 text-ink-2" aria-hidden="true" />
        </button>
        {choice === "custom" ? (
          <label className="grid gap-inset rounded-ctl bg-sunk p-row text-sm">
            <span className="font-medium">{say("plan.view.planningRequestDateConflict.date")}</span>
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
                <small>
                  {say("plan.view.planningRequestDateConflict.protectedWorkoutDescription")}
                </small>
              </span>
              <span className="rounded-full bg-bg-2 px-3 py-1 text-xs font-medium">
                {say("plan.view.planningRequestDateConflict.protected")}
              </span>
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
          {say("common.cancel")}
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
          {busy ? say("plan.view.active.checking") : primaryLabel}
        </Button>
      </div>
    </section>
  );
}

function ActiveProjection(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
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
  if (model === null)
    return (
      <StatusCard
        title={say("plan.view.planView.plan")}
        support={say("plan.view.ready.refreshing")}
      />
    );
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
    say("plan.view.planView.plan");
  const todaySupport =
    data.todayWorkout === null
      ? say("plan.view.active.restInstructions")
      : data.todayWorkout.durationS === null
        ? say("plan.view.active.workoutInstructions")
        : [
            clockTime(phrasebook, data.todayWorkout.durationS),
            data.todayWorkout.powerTargetW === undefined
              ? null
              : say("plan.view.active.powerRange", {
                  value1: format.number(data.todayWorkout.powerTargetW.min, { useGrouping: false }),
                  value2: format.number(data.todayWorkout.powerTargetW.max, { useGrouping: false }),
                }),
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
            <h2 className="m-0 text-base font-semibold">
              {say("plan.view.active.proposalRejected")}
            </h2>
            <p className="m-0 text-ink-2">{say("plan.view.active.rejectedDescription")}</p>
          </div>
          <Button type="button" onClick={() => actions?.closeProposal()}>
            {say("plan.view.planView.backToPlan")}
          </Button>
        </section>
      ) : null}
      <section className="grid gap-row rounded-card bg-surface p-5 shadow-elev-1">
        <div className="flex flex-col gap-row sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-row">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
            <div className={SUPPORT_PAIR}>
              <h2 className="m-0 text-base font-semibold">
                {say("plan.view.active.activeWeek", {
                  value1: format.number(data.weekIndex, { useGrouping: false }),
                  value2: format.number(data.plan.totalWeeks, { useGrouping: false }),
                })}
              </h2>
              <p className="m-0 text-ink-2">
                {say("plan.view.active.planSummary", {
                  value1: data.plan.name,
                  currentPhase: currentPhase,
                  value2: planDate(data.plan.startDate),
                  value3:
                    data.plan.ftpWatts === undefined
                      ? ""
                      : say("plan.view.active.ftpSummary", {
                          value1: format.number(data.plan.ftpWatts, { useGrouping: false }),
                        }),
                })}
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
              {say("plan.view.active.viewSeason")}
            </Button>
          </div>
        </div>
        <div className="flex items-start gap-row border-t border-line pt-row">
          <Activity className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
          <div className={SUPPORT_PAIR}>
            <h3 className="m-0 text-base font-semibold">
              {say("plan.view.active.todayWorkout", {
                value1: data.todayWorkout?.name ?? say("plan.view.active.rest"),
              })}
            </h3>
            <p className="m-0 text-ink-2">{todaySupport}</p>
          </div>
        </div>
      </section>

      <PredictionsSummary readiness={data.readiness} />

      <section className="overflow-hidden rounded-card bg-surface shadow-elev-1">
        <div className="flex items-start justify-between gap-row px-5 py-row">
          <div className={SUPPORT_PAIR}>
            <h2 className="m-0 text-base font-semibold">{say("plan.view.active.weeklyMatches")}</h2>
            <p className="m-0 text-sm text-ink-2">
              {data.matchSync?.awaitingSync === true
                ? say("plan.view.active.matchesStale")
                : data.matchSync?.lastSuccessfulSyncAtMs == null
                  ? say("plan.view.active.matchesPending")
                  : say("plan.view.active.lastSync", {
                      value1: format.date(new Date(data.matchSync.lastSuccessfulSyncAtMs), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
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
                  {planDate(workout.date, { weekday: "short", day: "numeric" })}
                </span>
                <span className="col-start-1 row-start-2 min-w-0 truncate font-medium text-ink-1 min-[760px]:col-auto min-[760px]:row-auto">
                  {workout.name}
                </span>
                <span className="col-start-2 row-start-1 text-ink-2 min-[760px]:col-auto min-[760px]:row-auto">
                  {workout.durationS === null ? "—" : plannedTime(phrasebook, workout.durationS)}
                </span>
                {proposal !== undefined ? (
                  <span className="col-start-2 row-start-2 justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn min-[760px]:col-auto min-[760px]:row-auto">
                    {say("plan.view.active.decisionNeeded")}
                  </span>
                ) : drift ? (
                  <span className="col-start-2 row-start-2 justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn min-[760px]:col-auto min-[760px]:row-auto">
                    {say("plan.view.active.calendarChanged", { intervals: "Intervals" })}
                  </span>
                ) : decision ? (
                  <span className="col-start-2 row-start-2 justify-self-start rounded-full border border-warn px-2.5 py-1 text-warn min-[760px]:col-auto min-[760px]:row-auto">
                    {say("plan.view.active.decisionNeeded")}
                  </span>
                ) : (
                  <span
                    className={`col-start-2 row-start-2 justify-self-start min-[760px]:col-auto min-[760px]:row-auto ${matchStatusClass(status)}`}
                  >
                    {say(MATCH_STATUS_COPY[status])}
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
          {say("plan.view.active.lifecycleActionsDescription")}
        </p>
        <div className="flex flex-wrap justify-end gap-inset">
          <Button
            id="plan-replace-trigger"
            type="button"
            variant="outline"
            disabled={actions === null || transition.status !== "idle"}
            onClick={() => actions?.openReplacement()}
          >
            {say("plan.view.active.replacePlan")}
          </Button>
          <Button
            id="plan-end-trigger"
            type="button"
            variant="destructive"
            disabled={actions === null || transition.status !== "idle"}
            onClick={() => actions?.openEndConfirmation()}
          >
            {say("plan.view.active.endPlan")}
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
            <DialogTitle>{say("plan.view.active.endConfirmationTitle")}</DialogTitle>
            <DialogDescription>
              {say("plan.view.active.endConfirmationDescription", {
                product: "Enduragent",
                intervals: "Intervals",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={endCancel}
              type="button"
              variant="outline"
              onClick={() => actions?.closeEndConfirmation()}
            >
              {say("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive-solid"
              onClick={() => actions?.confirmEndPlan()}
            >
              {say("plan.view.active.endPlan")}
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
                  {planDate(selectedWorkout.date)} · {selectedWorkout.sport} ·{" "}
                  {selectedWorkout.durationS === null
                    ? say("plan.view.active.noPlannedDuration")
                    : plannedTime(phrasebook, selectedWorkout.durationS)}
                </DialogDescription>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                <div className={SUPPORT_PAIR}>
                  <h3 className="m-0 text-sm font-medium">
                    {say("plan.view.active.workoutMatch")}
                  </h3>
                  <p
                    className={`m-0 text-base ${matchStatusClass(
                      selectedWorkout.match?.status ?? "upcoming",
                    )}`}
                  >
                    {say(MATCH_STATUS_COPY[selectedWorkout.match?.status ?? "upcoming"])}
                  </p>
                </div>
                {selectedWorkout.match?.activityId !== null &&
                selectedWorkout.match?.activityId !== undefined ? (
                  <div className="grid gap-inset rounded-card bg-sunk p-row">
                    <p className="m-0 text-sm font-medium">
                      {say("plan.view.active.observedActivity")}
                    </p>
                    <p className="m-0 text-sm text-ink-2">
                      {selectedWorkout.match.actualDate === null
                        ? say("plan.view.active.dateUnavailable")
                        : planDate(selectedWorkout.match.actualDate)}
                      {selectedWorkout.match.actualDurationS === null
                        ? ""
                        : ` · ${plannedTime(phrasebook, selectedWorkout.match.actualDurationS)}`}
                    </p>
                  </div>
                ) : (
                  <p className="m-0 text-sm text-ink-2">
                    {say("plan.view.active.unmatchedDescription")}
                  </p>
                )}
                {selectedWorkout.match?.requiresConfirmation === true ? (
                  <p className="m-0 text-sm text-ink-2">
                    {say("plan.view.active.matchConfirmationDescription")}
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
                      {say("plan.view.active.notThisActivity")}
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
                      {say("plan.view.active.confirmMatch")}
                    </Button>
                  </>
                ) : (
                  <Button type="button" variant="outline" onClick={() => actions?.closeWorkout()}>
                    {say("plan.view.active.close")}
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
                <DialogTitle className="m-0 text-xl">
                  {say("plan.view.active.evidenceTitle")}
                </DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  {say("plan.view.active.evidenceDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-6 overflow-auto px-5 py-5">
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">{say("plan.view.active.source")}</h3>
                  {selectedProposal.premises.map((premise) => (
                    <p key={premise.id} className="m-0 text-sm text-ink-2">
                      {premise.sourceLabel}
                    </p>
                  ))}
                </section>
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">{say("chat.planChange.evidence")}</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.rationale}</p>
                </section>
                <section className="grid gap-inset">
                  <h3 className="m-0 text-sm font-semibold">{say("chat.planChange.confidence")}</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.confidence}</p>
                </section>
                <section className="grid gap-inset rounded-ctl bg-sunk p-row">
                  <h3 className="m-0 text-sm font-semibold">
                    {say("plan.view.active.proposedImpact")}
                  </h3>
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
                  {say("plan.view.active.done")}
                </Button>
              </DialogFooter>
            </>
          ) : proposalMode === "edit" ? (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogTitle className="m-0 text-xl">
                  {say("plan.view.active.reviseProposal")}
                </DialogTitle>
                <DialogDescription className="m-0 text-ink-2">
                  {say("plan.view.active.revisionDescription")}
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
                    <p className="m-0 text-sm font-medium">{say("plan.view.active.coach")}</p>
                    <p className="m-0 text-sm text-ink-2">
                      {say("plan.view.active.revisionPrompt")}
                    </p>
                  </div>
                  <label className="grid gap-inset text-sm font-medium" htmlFor="proposal-revision">
                    {say("plan.view.active.yourChange")}
                    <textarea
                      id="proposal-revision"
                      className="min-h-36 resize-y rounded-ctl border border-line bg-surface px-3 py-3 text-base text-ink-1 outline-none focus:border-primary"
                      value={revisionText}
                      placeholder={say("plan.view.active.revisionPlaceholder")}
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
                    {say("common.cancel")}
                  </Button>
                  <Button type="submit" disabled={proposalBusy || !/\S/u.test(revisionText)}>
                    {proposalBusy
                      ? say("plan.view.active.updating")
                      : say("plan.view.active.updateProposal")}
                  </Button>
                </DialogFooter>
              </form>
            </>
          ) : (
            <>
              <DialogHeader className="grid gap-2 border-b border-line px-5 py-5 pr-16">
                <DialogDescription className="m-0 text-ink-2">
                  {planDate(selectedProposal.affectedDate)}
                </DialogDescription>
                <DialogTitle className="m-0 text-xl">
                  {proposalTargetWorkout?.name ?? selectedProposal.title}
                </DialogTitle>
              </DialogHeader>
              <div className="grid flex-1 content-start gap-row overflow-auto px-5 py-5">
                <div className="flex items-center justify-between gap-inset">
                  <span className="text-sm text-ink-2">{say("plan.view.active.status")}</span>
                  <span className="rounded-full border border-warn px-2.5 py-1 text-sm text-warn">
                    {say("plan.view.active.decisionNeeded")}
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
                          ? say("plan.view.active.saveFailureTitle")
                          : say("plan.view.active.interruptedTitle")}
                      </p>
                      <p className="m-0 text-sm text-ink-2">
                        {say("plan.view.active.proposalPreserved")}
                      </p>
                    </div>
                  </div>
                ) : null}
                {selectedProposal.stale ? (
                  <StaleNotice message={say("plan.view.active.staleProposal")} />
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
                      <p className="m-0 font-medium">{say("plan.view.active.revalidationTitle")}</p>
                      <p className="m-0 text-sm text-ink-2">
                        {say("plan.view.active.revalidationDescription")}
                      </p>
                    </div>
                  </div>
                ) : null}
                <section className="grid gap-inset rounded-ctl bg-sunk p-row">
                  <h3 className="m-0 text-sm font-semibold">
                    {say("plan.view.active.proposedChange")}
                  </h3>
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
                  <h3 className="m-0 text-sm font-semibold">{say("plan.view.active.why")}</h3>
                  <p className="m-0 text-sm text-ink-2">{selectedProposal.rationale}</p>
                </section>
                <div className="flex items-center justify-between gap-inset">
                  <span className="text-sm text-ink-2">{say("chat.planChange.confidence")}</span>
                  <span className="rounded-full border border-ok px-2.5 py-1 text-sm text-ok">
                    {selectedProposal.confidence}
                  </span>
                </div>
                <div>
                  <Button
                    ref={evidenceTrigger}
                    type="button"
                    variant="link"
                    aria-label={say("chat.planChange.viewEvidence")}
                    className="h-auto p-0"
                    onClick={() => setProposalMode("evidence")}
                  >
                    {say("plan.view.active.viewEvidence")}
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
                    {say("plan.view.active.reject")}
                  </Button>
                  {canReviseProposal ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={proposalBusy}
                      onClick={() => setProposalMode("edit")}
                    >
                      {say("chat.planCreation.edit")}
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
                        ? say("plan.view.active.checking")
                        : planningRequestAttention === "apply_failed" ||
                            planningRequestAttention === "revalidating"
                          ? say("plan.view.planView.tryAgain")
                          : selectedProposal.stale
                            ? say("plan.view.active.revalidate")
                            : say("plan.view.active.approve")}
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
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const planDate = usePlanDate();
  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  const actions = useEnduragentStore((state) => state.planActions);
  if (model === null)
    return (
      <StatusCard
        title={say("plan.view.planView.plan")}
        support={say("plan.view.ready.refreshing")}
      />
    );
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
              <h2 className="m-0 text-base font-semibold">
                {say("plan.view.ended.outcomeQuestion", { value1: data.plan.name })}
              </h2>
              <p className="m-0 text-ink-2">{say("plan.view.ended.outcomeDescription")}</p>
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
            {say("plan.view.ended.notCompleted")}
          </Button>
          <Button
            type="button"
            disabled={outcomeBusy || actions === null}
            onClick={() => actions?.recordRaceOutcome("completed")}
          >
            {outcomeBusy ? say("plan.view.ended.saving") : say("plan.view.ended.completed")}
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
                {say("plan.view.ended.completedTitle", {
                  value1: data.plan.name,
                  value2: result.goal.toLowerCase(),
                })}
              </h2>
              <p className="m-0 text-ink-2">
                {say("plan.view.ended.completedDescription", { value1: planDate(result.raceDate) })}
              </p>
            </div>
          </div>
          <section className="grid gap-row border-t border-line pt-row">
            <h3 className="m-0 text-base font-semibold">{say("plan.view.ended.timeAcrossPlan")}</h3>
            <div className="grid grid-cols-3 gap-row">
              <div className={SUPPORT_PAIR}>
                <span className="text-sm text-ink-2">{say("plan.view.ended.training")}</span>
                <strong className="text-lg">
                  {clockTime(phrasebook, result.trainingDurationS)}
                </strong>
              </div>
              <div className={SUPPORT_PAIR}>
                <span className="text-sm text-ink-2">{say("plan.view.ended.race")}</span>
                <strong className="text-lg">{clockTime(phrasebook, result.raceDurationS)}</strong>
              </div>
              <div className={SUPPORT_PAIR}>
                <span className="text-sm text-ink-2">{say("plan.view.ended.total")}</span>
                <strong className="text-lg">{clockTime(phrasebook, result.totalDurationS)}</strong>
              </div>
            </div>
          </section>
          <section className="grid gap-inset border-t border-line pt-row text-sm">
            <h3 className="m-0 text-base font-semibold">{say("plan.view.ended.planOutcome")}</h3>
            {[
              [say("plan.view.ended.goal"), result.goal],
              [say("plan.view.ended.result"), result.result],
              [
                say("plan.view.ended.modeledFinish"),
                finishRange(phrasebook, result.modeledFinishMinutes),
              ],
              [say("plan.view.ended.actual"), clockTime(phrasebook, result.actualDurationS)],
              [
                say("plan.view.ended.workoutRecords"),
                say("plan.view.ended.workoutCount", {
                  value1: format.number(data.plan.workoutCount, { useGrouping: false }),
                }),
              ],
              [
                say("plan.view.ended.appliedChanges"),
                format.number(result.appliedChangeCount, { useGrouping: false }),
              ],
              [say("plan.view.ended.eligibleUndo"), say("chat.planChange.none")],
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
              <h3 className="m-0 text-base font-semibold">
                {say("plan.view.ended.calendarCleanupVerified")}
              </h3>
              <p className="m-0 text-ink-2">
                {say("plan.view.ended.cleanupVerifiedDescription", {
                  product: "Enduragent",
                  intervals: "Intervals",
                })}
              </p>
            </div>
          </div>
        </div>
        <div className="flex justify-end border-t border-line px-5 py-row">
          <Button type="button" disabled={actions === null} onClick={() => actions?.startPlan()}>
            {say("plan.view.ended.startANewPlan")}
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
              <h2 className="m-0 text-lg font-semibold">
                {say("plan.view.ended.raceOutcomeNotCompleted")}
              </h2>
              <p className="m-0 text-ink-2">
                {say("plan.view.ended.incompleteDescription", {
                  value1: planDate(data.raceOutcomeDetails.raceDate),
                })}
              </p>
            </div>
          </div>
          <section className="grid gap-inset border-t border-line pt-row text-sm">
            <h3 className="m-0 text-base font-semibold">{say("plan.view.ended.planRecord")}</h3>
            <div className="flex justify-between gap-row">
              <span className="text-ink-2">{say("plan.view.ended.plannedRace")}</span>
              <strong>{data.plan.name}</strong>
            </div>
            <div className="flex justify-between gap-row border-t border-line pt-inset">
              <span className="text-ink-2">{say("plan.view.ended.outcome")}</span>
              <strong>{say("plan.view.ended.notCompleted")}</strong>
            </div>
            <div className="flex justify-between gap-row border-t border-line pt-inset">
              <span className="text-ink-2">{say("plan.view.ended.trainingHistory")}</span>
              <strong>{say("plan.view.ended.preserved")}</strong>
            </div>
          </section>
        </div>
        <div className="flex justify-end border-t border-line px-5 py-row">
          <Button type="button" disabled={actions === null} onClick={() => actions?.startPlan()}>
            {say("plan.view.ended.startANewPlan")}
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
                ? say("plan.view.ended.incompleteTitle", { value1: data.plan.name })
                : say("plan.view.ended.endedTitle", { value1: data.plan.name })}
            </h2>
            <p className="m-0 text-ink-2">
              {model.scenarioId === "PL-S094" && data.plan.targetDate !== null
                ? say("plan.view.ended.automaticCloseDescription", {
                    value1: planDate(data.plan.targetDate),
                  })
                : model.scenarioId === "PL-S096"
                  ? say("plan.view.ended.outcomeSavedDescription")
                  : say("plan.view.ended.endedDescription")}
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
                  ? say("plan.view.ended.calendarCleanupVerified")
                  : failed
                    ? say("plan.view.ended.calendarCleanupNeedsAttention")
                    : busy || model.scenarioId === "PL-S055"
                      ? say("plan.view.ended.cleaningCalendar", { intervals: "Intervals" })
                      : say("plan.view.ended.checkingCalendar", { intervals: "Intervals" })}
              </h3>
              <p className="m-0 text-ink-2">
                {verified
                  ? say("plan.view.ended.cleanupVerifiedDescription", {
                      product: "Enduragent",
                      intervals: "Intervals",
                    })
                  : failed
                    ? say("plan.view.ended.cleanupFailedDescription", { intervals: "Intervals" })
                    : say("plan.view.ended.cleanupPendingDescription")}
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
                  <span>{planDate(item.date)}</span>
                  <span className="text-warn">
                    {say("plan.view.ended.remainingCalendarEntry", { intervals: "Intervals" })}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="grid gap-inset border-t border-line pt-row text-sm">
          {data.raceOutcome === null || data.raceOutcome === undefined ? null : (
            <div className="flex justify-between gap-row">
              <span>{say("plan.view.ended.raceOutcome")}</span>
              <strong>
                {data.raceOutcome === "completed"
                  ? say("plan.view.ended.completed")
                  : say("plan.view.ended.notCompleted")}
              </strong>
            </div>
          )}
          <div className="flex justify-between gap-row">
            <span>{say("plan.view.planView.planHistory")}</span>
            <strong>{say("plan.view.ended.saved")}</strong>
          </div>
          <div className="flex justify-between gap-row">
            <span>{say("plan.view.ended.preservedRecords")}</span>
            <strong>{say("plan.view.ended.preserved")}</strong>
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
              {say("plan.view.ended.recordOutcome")}
            </Button>
            <Button type="button" onClick={() => actions?.startPlan()}>
              {say("plan.view.ended.startANewPlan")}
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
              {say("plan.view.ended.verifyAgain")}
            </Button>
            <Button
              type="button"
              disabled={busy || actions === null}
              onClick={() => actions?.retryPlanCleanup()}
            >
              {busy ? say("plan.view.ended.working") : say("plan.view.ended.retry")}
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
                {say("plan.view.ended.viewCoachConversation")}
              </Button>
            ) : null}
            <Button type="button" disabled={actions === null} onClick={() => actions?.startPlan()}>
              {say("plan.view.ended.startANewPlan")}
            </Button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function ReadyProjection(): ReactElement | null {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

  const model = useEnduragentStore((state) => planReadModel(state.plan));
  const transition = useEnduragentStore((state) => state.plan.transition);
  if (
    transition.status === "running" &&
    (transition.transitionId === "PL-T06" || transition.transitionId === "PL-T07")
  ) {
    return <DraftFormation />;
  }
  if (model === null)
    return (
      <StatusCard
        title={say("plan.view.planView.plan")}
        support={say("plan.view.ready.refreshing")}
      />
    );
  if (model.scenarioId === "PL-S099") {
    const parsed = PlanChatOriginatedResultProjectionDataSchema.safeParse(model.data);
    return parsed.success ? (
      <ChatOriginatedPlanResultProjection data={parsed.data} />
    ) : (
      <StatusCard title={model.title} support={model.summary} />
    );
  }
  if (model.lifecycle === "none" || model.projection === "no-plan") return null;
  if (model.projection === "coach") return <PlanCoach />;
  if (model.projection === "draft") return <DraftProjection />;
  if (model.projection === "active") return <ActiveProjection />;
  if (model.projection === "ended") return <EndedProjection />;
  if (model.projection === "attention") return <AttentionProjection />;
  return (
    <StatusCard
      title={model.title.length > 0 ? model.title : say("plan.view.ready.yourPlan")}
      support={
        model.summary.length > 0 ? model.summary : say("plan.view.ready.availableDescription")
      }
    />
  );
}

export function PlanView(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;

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
    ? say("plan.view.planView.loading")
    : historyPage
      ? say("plan.view.planView.historySubtitle", { value1: activeData.plan.name })
      : undefined;

  useEffect(() => {
    if (returnFocusId === null || finalDetails.status !== "library") return;
    requestAnimationFrame(() => document.getElementById(returnFocusId)?.focus());
  }, [model?.scenarioId, returnFocusId, finalDetails.status]);

  if (finalDetails.status !== "library") {
    const notice = finalDetails.justClosed
      ? finalDetails.status === "ready" && finalDetails.history?.cleanup === "complete"
        ? say("plan.view.planView.closedCleanupComplete")
        : say("plan.view.planView.closedCleanupPending")
      : null;
    return (
      <Page
        title={say("plan.view.planView.plan")}
        className="plan-view [&_[data-page-scroll]>div]:w-[min(720px,calc(100%-64px))] max-md:[&_[data-page-scroll]>div]:w-[calc(100%-32px)]"
        busy={finalDetails.status === "loading"}
      >
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
                {say("plan.view.planView.loadingHistory")}
              </p>
            ) : null}
            {finalDetails.status === "unavailable" ? (
              <>
                <p role="alert" className="m-0 text-sm text-danger">
                  {say("plan.view.planView.historyFailure")}
                </p>
                <Button
                  variant="outline"
                  onClick={() => readFinalDetails(finalDetails.planId, finalDetails.justClosed)}
                >
                  {say("plan.view.planView.tryAgain")}
                </Button>
              </>
            ) : null}
            <div>
              <Button variant="outline" onClick={backToLibrary}>
                {say("plan.view.planView.backToLibrary")}
              </Button>
            </div>
          </div>
        )}
      </Page>
    );
  }

  return (
    <Page
      title={historyPage ? say("plan.view.planView.planHistory") : say("plan.view.planView.plan")}
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
              {library.value.active === null
                ? say("plan.view.planView.startPlan")
                : say("plan.view.ended.startANewPlan")}
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
            {say("plan.view.planView.closeCoach")}
          </Button>
        ) : historyPage ? (
          <Button type="button" variant="outline" onClick={() => actions?.closeHistory()}>
            {say("plan.view.planView.backToPlan")}
          </Button>
        ) : activeOverview ? (
          <Button
            id="plan-history-trigger"
            type="button"
            variant="outline"
            onClick={() => actions?.openHistory()}
          >
            <History className="size-4" aria-hidden="true" />
            {say("plan.view.planView.planHistory")}
          </Button>
        ) : undefined
      }
      className="plan-view [&_[data-page-scroll]>div]:w-[min(720px,calc(100%-64px))] max-md:[&_[data-page-scroll]>div]:w-[calc(100%-32px)]"
      contentMode={coachWorkspace ? "workspace" : "scroll"}
    >
      <div className={coachWorkspace ? "h-full min-h-0" : "grid gap-6"}>
        {library.status === "unavailable" ? (
          <div role="alert" className="grid gap-inset">
            <StaleNotice message={say("plan.view.planView.libraryFailure")} />
            <Button variant="outline" onClick={() => planningActions?.refresh()}>
              {say("plan.view.planView.tryAgain")}
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
                {say("plan.view.planView.planHistory")}
              </Button>
            </div>
          ) : null}
          {plan.hydration.status === "stale" ? (
            <StaleNotice message={plan.hydration.error.message} />
          ) : null}
          {plan.hydration.status === "loading" ? (
            <p className="m-0 text-ink-2" role="status" aria-live="polite">
              {say("plan.view.planView.loadingPlan")}
            </p>
          ) : plan.hydration.status === "failed" ? (
            <StatusCard
              title={say("plan.view.planView.loadFailureTitle")}
              support={plan.hydration.error.message}
              retry={plan.hydration.error.retryable}
            />
          ) : plan.hydration.status === "unsupported-capability" ? (
            <StatusCard
              title={say("plan.view.planView.unavailableTitle")}
              support={say("plan.view.planView.upgradeRequired", { product: "Enduragent" })}
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
