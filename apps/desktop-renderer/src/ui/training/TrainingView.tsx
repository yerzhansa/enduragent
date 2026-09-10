import type { Message } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { usePhrasebook } from "@enduragent/i18n/react";
import type {
  CompletedActivityWeek,
  TrainingHistoryComputed,
  TrainingHistoryPanel,
  TrainingHistoryRide,
  UnitsPreference,
} from "@enduragent/coach-contract";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronLeft, ChevronRight, Upload } from "lucide-react";
import {
  Button,
  CompactTrend,
  WeeklySummary as WeeklySummaryPresentation,
  SelectableRideRow,
  SectionHeading,
  NoticeRow,
} from "@enduragent/ui";
import { rideFileCountMessage, rideImportStatusMessage } from "../../ride-import";
import { rideImportStatusSuppressed } from "../../state/onboarding-slice";
import { useEnduragentStore } from "../../state/store";
import {
  formatDistance,
  formatRidingDuration,
  formatWholeNumber,
} from "../../training-context/format";
import { Page } from "@enduragent/ui";
import { TRAINING_DEGRADED_COPY, TRAINING_HISTORY_COPY, trainingStatusCopy } from "./copy";
import { overviewStyles as styles } from "./overviewStyles";
import { RideDetailView, trainingRideDateTime, trainingRideKind } from "./RideReview";

type Period = "anchor" | "previous";
type WeekMetric = CompletedActivityWeek["totals"][keyof CompletedActivityWeek["totals"]];

function effectiveHistory(panel: TrainingHistoryPanel): TrainingHistoryComputed | null {
  if (panel.kind === "unavailable") return null;
  return panel.kind === "stale" ? panel.lastGood : panel;
}

function selectedWeek(history: TrainingHistoryComputed, period: Period): CompletedActivityWeek {
  return period === "previous" && history.previousWeek !== null
    ? history.previousWeek
    : history.anchorWeek;
}

function periodLabel(history: TrainingHistoryComputed, period: Period, retained: boolean): Message {
  if (period === "previous") return TRAINING_HISTORY_COPY.previous;
  return retained || history.displayMode === "last-recorded"
    ? TRAINING_HISTORY_COPY.lastRecorded
    : TRAINING_HISTORY_COPY.current;
}

function coverageDate(history: TrainingHistoryComputed): string | null {
  if (history.coverage.kind === "contiguous") return history.coverage.through;
  if (history.coverage.kind === "sparse") return history.coverage.latestKnownRideDate;
  return history.coverage.provenThrough ?? history.coverage.observedThrough;
}

function dataWarning(
  panel: TrainingHistoryPanel,
  history: TrainingHistoryComputed,
  week: CompletedActivityWeek,
): Message | null {
  if (panel.kind === "stale") return TRAINING_HISTORY_COPY.refreshFailure;
  if (history.coverage.kind === "sparse") return TRAINING_HISTORY_COPY.sparse;
  if (history.displayMode === "last-recorded") {
    return history.coverage.kind === "incomplete"
      ? TRAINING_HISTORY_COPY.outOfDateIncomplete
      : TRAINING_HISTORY_COPY.outOfDate;
  }
  if (week.coverage.kind === "complete") return null;
  if (week.coverage.reason === "coverage-lag") return TRAINING_HISTORY_COPY.coverageLag;
  if (week.coverage.reason === "sparse-imports") return TRAINING_HISTORY_COPY.sparse;
  return TRAINING_HISTORY_COPY.incomplete;
}

function metricCopy(
  metric: WeekMetric,
  format: (value: number) => string,
  ridesExist: boolean,
  say: Phrasebook["say"],
): string {
  if (metric.kind === "unavailable")
    return say(ridesExist ? "training.view.notRecorded" : "training.view.unavailable");
  const value = format(metric.value);
  return metric.kind === "partial" ? say("training.view.partialValue", { value }) : value;
}

function rideCountCopy(value: number, { say, format }: Phrasebook): string {
  return say("training.view.rideCount", { count: value, number: formatWholeNumber(value, format) });
}

function formatCivilDate(
  value: string,
  { say, format }: Phrasebook,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    return say("chat.date.unknown");
  return format.date(date, {
    dateStyle: options === undefined ? "medium" : undefined,
    ...options,
    timeZone: "UTC",
  });
}

function weekRangeLabel(week: CompletedActivityWeek, phrasebook: Phrasebook): string {
  const year =
    week.window.start.slice(0, 4) === week.window.end.slice(0, 4) ? undefined : "numeric";
  const startMonth = formatCivilDate(week.window.start, phrasebook, { month: "short" });
  const endMonth = formatCivilDate(week.window.end, phrasebook, { month: "short" });
  const start = formatCivilDate(week.window.start, phrasebook, {
    day: "numeric",
    month: "short",
    year,
  });
  const end = formatCivilDate(
    week.window.end,
    phrasebook,
    startMonth === endMonth ? { day: "numeric", year } : { day: "numeric", month: "short", year },
  );
  return phrasebook.say("training.view.weekRange", { start, end });
}

function noticeCoverage(
  panel: TrainingHistoryPanel,
  history: TrainingHistoryComputed,
  week: CompletedActivityWeek,
  phrasebook: Phrasebook,
): string | null {
  const through =
    week.coverage.kind === "incomplete"
      ? week.coverage.recordedThrough
      : panel.kind === "stale" || history.displayMode === "last-recorded"
        ? coverageDate(history)
        : null;
  return through === null
    ? null
    : phrasebook.say("training.view.recordedThrough", {
        date: formatCivilDate(through, phrasebook),
      });
}

function Trend(props: { readonly week: CompletedActivityWeek }): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const trend = props.week.trend;
  return (
    <CompactTrend
      title={say(TRAINING_HISTORY_COPY.trendLabel)}
      period={say(TRAINING_HISTORY_COPY.trendPeriod)}
      content={
        trend.kind === "unavailable"
          ? {
              kind: "unavailable",
              message: say(TRAINING_HISTORY_COPY.trendUnavailable),
              reason: {
                "limited-history": say(TRAINING_HISTORY_COPY.limitedHistory),
                "incomplete-source": say(TRAINING_HISTORY_COPY.incompleteTrend),
                "missing-duration": say(TRAINING_HISTORY_COPY.missingDuration),
              }[trend.reason],
            }
          : {
              kind: "ready",
              headings: [
                say("training.view.week"),
                say("training.view.rides"),
                say("training.view.ridingTime"),
              ],
              buckets: trend.buckets.map((bucket) => ({
                id: bucket.window.start,
                value: bucket.ridingSeconds,
                label: formatCivilDate(bucket.window.start, phrasebook, {
                  day: "numeric",
                  month: "numeric",
                }),
                range: say("training.view.trendRange", {
                  start: formatCivilDate(bucket.window.start, phrasebook),
                  end: formatCivilDate(bucket.window.end, phrasebook),
                }),
                count: rideCountCopy(bucket.rideCount, phrasebook),
                formattedValue: say(formatRidingDuration(bucket.ridingSeconds, format)),
              })),
            }
      }
    />
  );
}

function WeeklySummary(props: {
  readonly history: TrainingHistoryComputed;
  readonly retained: boolean;
  readonly period: Period;
  readonly week: CompletedActivityWeek;
  readonly units: UnitsPreference;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const ridesExist = props.week.rides.items.length > 0 || props.week.rides.count.value > 0;
  const label = periodLabel(props.history, props.period, props.retained);
  return (
    <WeeklySummaryPresentation
      data-panel="weekly-summary"
      label={say(label)}
      ridingTime={metricCopy(
        props.week.totals.ridingSeconds,
        (value) => say(formatRidingDuration(value, format)),
        ridesExist,
        say,
      )}
      rideCount={metricCopy(
        props.week.totals.rideCount,
        (value) => rideCountCopy(value, phrasebook),
        ridesExist,
        say,
      )}
      distance={metricCopy(
        props.week.totals.distanceMeters,
        (value) => say(formatDistance(value, props.units, format)),
        ridesExist,
        say,
      )}
      load={say("training.view.load", {
        value: metricCopy(
          props.week.totals.load,
          (value) => formatWholeNumber(value, format),
          ridesExist,
          say,
        ),
      })}
      trend={<Trend week={props.week} />}
    />
  );
}

function calloutReason(
  week: CompletedActivityWeek,
  rideId: string,
  phrasebook: Phrasebook,
): string | null {
  const callout = week.callout;
  if (callout === null || callout.rideId !== rideId) return null;
  return phrasebook.say("training.view.longestRide", {
    date: formatCivilDate(callout.window.end, phrasebook),
  });
}

function historyRideMeta(
  ride: TrainingHistoryRide,
  units: UnitsPreference,
  phrasebook: Phrasebook,
): string {
  if (ride.distanceMeters === null) return trainingRideDateTime(ride, phrasebook);
  const kind = phrasebook.say(trainingRideKind(ride, true));
  return phrasebook.say("training.view.rideMeta", {
    kind,
    distance: phrasebook.say(formatDistance(ride.distanceMeters, units, phrasebook.format)),
  });
}

function RideRow(props: {
  readonly ride: TrainingHistoryRide;
  readonly reason: string | null;
  readonly units: UnitsPreference;
  readonly onOpen: () => void;
  readonly register: (node: HTMLButtonElement | null) => void;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const title = props.ride.title ?? say(trainingRideKind(props.ride));
  const dateTime = trainingRideDateTime(props.ride, phrasebook);
  const weekday = formatCivilDate(props.ride.localDate, phrasebook, { weekday: "short" });
  const day = formatCivilDate(props.ride.localDate, phrasebook, { day: "numeric" });
  return (
    <SelectableRideRow
      ref={props.register}
      aria-label={say("training.view.openRide", { title, dateTime })}
      onClick={props.onOpen}
      date={{ iso: props.ride.localDate, weekday, day }}
      title={title}
      meta={historyRideMeta(props.ride, props.units, phrasebook)}
      duration={
        props.ride.ridingSeconds === null
          ? null
          : say(formatRidingDuration(props.ride.ridingSeconds, format))
      }
      load={
        props.ride.load === null
          ? null
          : say("training.view.load", { value: formatWholeNumber(props.ride.load, format) })
      }
      callout={
        props.reason === null
          ? undefined
          : { label: say("training.view.callout"), reason: props.reason }
      }
    />
  );
}

function emptyRidesCopy(
  history: TrainingHistoryComputed,
  retained: boolean,
  period: Period,
): Message {
  if (period === "previous") return TRAINING_HISTORY_COPY.previousEmpty;
  return retained || history.displayMode === "last-recorded"
    ? TRAINING_HISTORY_COPY.lastRecordedEmpty
    : TRAINING_HISTORY_COPY.currentEmpty;
}

function RecentRides(props: {
  readonly history: TrainingHistoryComputed;
  readonly retained: boolean;
  readonly period: Period;
  readonly week: CompletedActivityWeek;
  readonly units: UnitsPreference;
  readonly onOpen: (ride: TrainingHistoryRide) => void;
  readonly onPreviousWeek: () => void;
  readonly registerButton: (id: string, node: HTMLButtonElement | null) => void;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const heading = props.retained
    ? TRAINING_HISTORY_COPY.recordedRides
    : props.history.coverage.kind === "incomplete"
      ? TRAINING_HISTORY_COPY.latestAvailableRides
      : TRAINING_HISTORY_COPY.recentRides;
  const truncation =
    props.week.rides.truncated && props.week.rides.items.length > 0
      ? props.week.rides.count.kind === "at-least"
        ? say("training.view.truncatedMinimum", {
            shown: formatWholeNumber(props.week.rides.items.length, format),
            total: formatWholeNumber(props.week.rides.count.value, format),
          })
        : say("training.view.truncated", {
            shown: formatWholeNumber(props.week.rides.items.length, format),
            total: formatWholeNumber(props.week.rides.count.value, format),
          })
      : null;
  return (
    <section
      className={styles.ridesSection}
      data-panel="recent-rides"
      aria-labelledby="recent-rides-title"
    >
      <SectionHeading
        headingId="recent-rides-title"
        title={say(heading)}
        meta={props.week.rides.items.length === 0 ? null : say(TRAINING_HISTORY_COPY.newestFirst)}
      />
      {props.week.rides.items.length === 0 ? (
        <p className={styles.historyEmpty}>
          {say(emptyRidesCopy(props.history, props.retained, props.period))}
        </p>
      ) : (
        <ol className={styles.historyRideList}>
          {props.week.rides.items.map((ride) => (
            <RideRow
              key={ride.id}
              ride={ride}
              reason={calloutReason(props.week, ride.id, phrasebook)}
              units={props.units}
              onOpen={() => props.onOpen(ride)}
              register={(node) => props.registerButton(ride.id, node)}
            />
          ))}
        </ol>
      )}
      {truncation === null ? null : <p className={styles.truncation}>{truncation}</p>}
      {props.period !== "anchor" || props.retained || props.history.previousWeek === null ? null : (
        <div className={styles.moreHistory}>
          <Button
            type="button"
            variant="outline"
            className={styles.moreHistoryButton}
            data-parity="rides-previous-week"
            onClick={props.onPreviousWeek}
          >
            {say(TRAINING_HISTORY_COPY.previous)}
          </Button>
        </div>
      )}
    </section>
  );
}

function PeriodNavigation(props: {
  readonly history: TrainingHistoryComputed;
  readonly period: Period;
  readonly retained: boolean;
  readonly currentButtonRef: Ref<HTMLButtonElement>;
  readonly onChange: (period: Period) => void;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  return (
    <div className={styles.periodGroup} role="group" aria-label={say("training.view.period")}>
      {props.retained ? (
        <Button type="button" variant="outline" size="xs" className={styles.periodButton} disabled>
          {say(TRAINING_HISTORY_COPY.lastRecorded)}
        </Button>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            className={styles.periodButton}
            aria-label={say(TRAINING_HISTORY_COPY.previous)}
            disabled={props.period === "previous" || props.history.previousWeek === null}
            onClick={() => props.onChange("previous")}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            ref={props.currentButtonRef}
            type="button"
            variant="outline"
            size="xs"
            className={styles.periodButton}
            aria-pressed={props.period === "anchor"}
            onClick={() => props.onChange("anchor")}
          >
            {say(periodLabel(props.history, "anchor", props.retained))}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            className={styles.periodButton}
            aria-label={say(TRAINING_HISTORY_COPY.next)}
            disabled={props.period === "anchor"}
            onClick={() => props.onChange("anchor")}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  );
}

function DataNotice(props: {
  readonly coverage: string | null;
  readonly notice: string;
}): ReactElement {
  return (
    <NoticeRow className="mb-4.5" tone="warning" title={props.coverage}>
      {props.notice}
    </NoticeRow>
  );
}

function RideImportAction(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const state = useEnduragentStore((store) => store.rideImport);
  const actions = useEnduragentStore((store) => store.rideImportActions);
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-xs"
      className={styles.periodButton}
      aria-label={say("training.view.import")}
      title={say("training.view.import")}
      disabled={actions === null || state.status === "running"}
      aria-describedby={state.status === "idle" ? undefined : "ride-import-status"}
      onClick={() => actions?.choose()}
    >
      <Upload aria-hidden="true" />
    </Button>
  );
}

function RideImportStatus(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const state = useEnduragentStore((store) => store.rideImport);
  const suppressed = useEnduragentStore(rideImportStatusSuppressed);
  const active = state.status !== "idle" && !suppressed;
  const visible = active && (state.status !== "running" || state.stage !== "choosing");
  const progress = visible && state.status === "running" ? state.progress : null;
  const importMessage = active
    ? rideImportStatusMessage(state, {
        imported: say(
          rideFileCountMessage(
            state.result?.files.imported ?? 0,
            formatWholeNumber(state.result?.files.imported ?? 0, format),
          ),
        ),
        quarantined: say(
          rideFileCountMessage(
            state.result?.files.quarantined ?? 0,
            formatWholeNumber(state.result?.files.quarantined ?? 0, format),
          ),
        ),
      })
    : null;
  const copy = importMessage === null ? "" : say(importMessage);
  return (
    <>
      {visible ? (
        <section
          className={styles.importStatus}
          data-panel="ride-import"
          aria-label={say("training.view.import")}
        >
          <h2>{say("training.view.import")}</h2>
          {progress === null || !("completed" in progress.params.event) ? null : (
            <p className={styles.meta}>
              {say("training.view.importProgress", {
                completed: formatWholeNumber(progress.params.event.completed, format),
                total: formatWholeNumber(progress.params.event.total, format),
              })}
            </p>
          )}
          <p className={styles.support} aria-hidden="true">
            {copy}
          </p>
        </section>
      ) : null}
      <p
        id="ride-import-status"
        className={`${styles.srOnly} ride-import-status`}
        data-state={active ? state.status : "idle"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {copy}
      </p>
    </>
  );
}

function UnavailableHistory(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  return (
    <>
      <section
        className={styles.weekSection}
        data-panel="weekly-summary"
        aria-labelledby="weekly-summary-title"
      >
        <h2 id="weekly-summary-title" className={styles.srOnly}>
          {say("training.view.weeklySummary")}
        </h2>
        <p className={styles.historyEmpty}>{say(TRAINING_HISTORY_COPY.unavailable)}</p>
      </section>
      <section
        className={styles.ridesSection}
        data-panel="recent-rides"
        aria-labelledby="recent-rides-title"
      >
        <SectionHeading
          headingId="recent-rides-title"
          title={say(TRAINING_HISTORY_COPY.recentRides)}
        />
        <p className={styles.historyEmpty}>{say(TRAINING_HISTORY_COPY.unknownRides)}</p>
      </section>
    </>
  );
}

function reviewCalloutReason(
  history: TrainingHistoryComputed,
  rideId: string,
  phrasebook: Phrasebook,
): string | null {
  const anchor = calloutReason(history.anchorWeek, rideId, phrasebook);
  if (anchor !== null) return anchor;
  return history.previousWeek === null
    ? null
    : calloutReason(history.previousWeek, rideId, phrasebook);
}

export function TrainingView(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const training = useEnduragentStore((store) => store.training);
  const selectedRide = useEnduragentStore((store) => store.selectedRide);
  const openRide = useEnduragentStore((store) => store.openRide);
  const closeRide = useEnduragentStore((store) => store.closeRide);
  const rideAnalysis = useEnduragentStore((store) => store.rideAnalysis);
  const rideAnalysisActions = useEnduragentStore((store) => store.rideAnalysisActions);
  const [period, setPeriod] = useState<Period>("anchor");
  const rideButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousRideId = useRef<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const currentPeriodButton = useRef<HTMLButtonElement>(null);
  const panel = training.trainingContext.trainingHistory;
  const history = effectiveHistory(panel);
  const retained = panel.kind === "stale";
  const resolvedRide = selectedRide;

  useEffect(() => {
    if (period === "previous" && history?.previousWeek === null) setPeriod("anchor");
  }, [history?.previousWeek, period]);

  useLayoutEffect(() => {
    const currentRideId = resolvedRide?.id ?? null;
    if (currentRideId !== null && previousRideId.current !== currentRideId) {
      title.current?.focus();
    } else if (currentRideId === null && previousRideId.current !== null) {
      (rideButtons.current.get(previousRideId.current) ?? title.current)?.focus();
    } else {
      const element = title.current;
      if (element !== null) {
        const owner = element.ownerDocument;
        const active = owner.activeElement;
        if (active === null || active === owner.body || active === owner.documentElement) {
          element.focus();
        }
      }
    }
    previousRideId.current = currentRideId;
  }, [resolvedRide?.id]);

  const activeWeek = history === null ? null : selectedWeek(history, period);
  const warning =
    history === null || activeWeek === null ? null : dataWarning(panel, history, activeWeek);
  const statusWarning =
    training.status === "unavailable" || training.status === "refresh-unavailable"
      ? trainingStatusCopy(training.status)
      : null;
  const notice =
    statusWarning ??
    warning ??
    (training.metadata?.degraded === true ? TRAINING_DEGRADED_COPY : null);
  const coverage =
    history === null || activeWeek === null
      ? null
      : noticeCoverage(panel, history, activeWeek, phrasebook);
  const label = history === null ? null : periodLabel(history, period, retained);
  const announcement =
    label === null
      ? null
      : notice === null
        ? say(label)
        : say("training.view.announcement", { period: say(label), notice: say(notice) });
  const changePeriod = (nextPeriod: Period): void => {
    setPeriod(nextPeriod);
    currentPeriodButton.current?.focus();
  };

  if (resolvedRide !== null) {
    return (
      <RideDetailView
        key={resolvedRide.id}
        ride={resolvedRide}
        units={training.unitsPreference.value}
        analysis={rideAnalysis}
        calloutReason={
          history === null ? null : reviewCalloutReason(history, resolvedRide.id, phrasebook)
        }
        onStartAnalysis={rideAnalysisActions === null ? null : () => rideAnalysisActions.start()}
        onRefreshAnalysis={
          rideAnalysisActions === null ? null : (sections) => rideAnalysisActions.refresh(sections)
        }
        titleRef={title}
        onBack={closeRide}
      />
    );
  }

  let historyContent: ReactNode;
  if (history === null || activeWeek === null) {
    historyContent = (
      <>
        {notice === null ? null : <DataNotice coverage={coverage} notice={say(notice)} />}
        <UnavailableHistory />
      </>
    );
  } else {
    historyContent = (
      <>
        <p className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {notice === null ? null : <DataNotice coverage={coverage} notice={say(notice)} />}
        <WeeklySummary
          history={history}
          retained={retained}
          period={period}
          week={activeWeek}
          units={training.unitsPreference.value}
        />
        <RecentRides
          history={history}
          retained={retained}
          period={period}
          week={activeWeek}
          units={training.unitsPreference.value}
          onOpen={openRide}
          onPreviousWeek={() => changePeriod("previous")}
          registerButton={(id, node) => {
            if (node === null) rideButtons.current.delete(id);
            else rideButtons.current.set(id, node);
          }}
        />
      </>
    );
  }

  return (
    <Page
      title={say("training.view.title")}
      subtitle={activeWeek === null ? undefined : weekRangeLabel(activeWeek, phrasebook)}
      titleRef={title}
      busy={training.status === "loading"}
      action={
        <>
          {history === null ? null : (
            <PeriodNavigation
              history={history}
              period={period}
              retained={retained}
              currentButtonRef={currentPeriodButton}
              onChange={changePeriod}
            />
          )}
          <RideImportAction />
        </>
      }
    >
      {historyContent}
      <RideImportStatus />
    </Page>
  );
}
