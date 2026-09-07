import type {
  ActivityAnalysisData,
  ActivityAnalysisSection,
  AnalysisSection,
  TrainingHistoryRide,
  UnitsPreference,
} from "@enduragent/coach-contract";
import { useRef, type ReactElement, type ReactNode, type Ref } from "react";
import type { RideAnalysisViewState } from "../../activity-analysis/controller";
import { Button } from "@enduragent/ui";
import { formatCivilDate, formatOffsetWallTime } from "../../lib/date";
import {
  formatDistance,
  formatRidingDuration,
  formatWholeNumber,
} from "../../training-context/format";
import { Page } from "@enduragent/ui";
import { TRAINING_HISTORY_COPY, analysisRefreshFailureCopy, analysisUnavailableCopy } from "./copy";
import { RideResponseReview } from "./RideResponseReview";
import { rideStyles as styles } from "./rideStyles";

const RIDE_KIND: Readonly<Record<string, string>> = {
  road: "Road ride",
  mountain: "Mountain bike ride",
  downhill: "Downhill ride",
  cyclocross: "Cyclocross ride",
  track: "Track ride",
  indoor_cycling: "Indoor ride",
  virtual_activity: "Virtual ride",
  gravel_cycling: "Gravel ride",
};

export function trainingRideKind(ride: TrainingHistoryRide): string {
  return ride.subSport === null || ride.subSport === "generic"
    ? "Cycling ride"
    : (RIDE_KIND[ride.subSport] ?? "Cycling ride");
}

function rideDuration(ride: TrainingHistoryRide): string {
  return ride.ridingSeconds === null ? "Not recorded" : formatRidingDuration(ride.ridingSeconds);
}

function rideDistance(ride: TrainingHistoryRide, units: UnitsPreference): string {
  return ride.distanceMeters === null ? "Not recorded" : formatDistance(ride.distanceMeters, units);
}

export function trainingRideTime(ride: TrainingHistoryRide): string | null {
  return formatOffsetWallTime(ride.startEpochSeconds, ride.timezoneOffsetSeconds);
}

export function trainingRideDateTime(ride: TrainingHistoryRide): string {
  const time = trainingRideTime(ride);
  return time === null
    ? formatCivilDate(ride.localDate)
    : `${formatCivilDate(ride.localDate)} · ${time}`;
}

function RideSummary(props: {
  readonly ride: TrainingHistoryRide;
  readonly units: UnitsPreference;
}): ReactElement {
  return (
    <dl className={styles.rideSummary}>
      <div>
        <dt>Date</dt>
        <dd>
          <time dateTime={props.ride.localDate}>{trainingRideDateTime(props.ride)}</time>
        </dd>
      </div>
      <div>
        <dt>Riding time</dt>
        <dd>{rideDuration(props.ride)}</dd>
      </div>
      <div>
        <dt>Distance</dt>
        <dd>{rideDistance(props.ride, props.units)}</dd>
      </div>
    </dl>
  );
}

function recordedRideMetrics(ride: TrainingHistoryRide): readonly {
  readonly label: string;
  readonly value: string;
}[] {
  const metrics: { label: string; value: string }[] = [];
  if (ride.load !== null) metrics.push({ label: "Load", value: formatWholeNumber(ride.load) });
  if (ride.averagePowerWatts !== null) {
    metrics.push({
      label: "Average power",
      value: `${formatWholeNumber(ride.averagePowerWatts)} W`,
    });
  }
  if (ride.averageHeartRateBpm !== null) {
    metrics.push({
      label: "Average heart rate",
      value: `${formatWholeNumber(ride.averageHeartRateBpm)} bpm`,
    });
  }
  if (ride.perceivedExertion !== null) {
    metrics.push({
      label: "Perceived exertion (0–10)",
      value: formatWholeNumber(ride.perceivedExertion),
    });
  }
  if (ride.energyKilojoules !== null) {
    metrics.push({
      label: "Energy",
      value: `${formatWholeNumber(ride.energyKilojoules)} kJ`,
    });
  }
  return metrics.slice(0, 4);
}

function formatAnalysisDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours === 0 ? `${minutes} min` : `${hours} hr ${remainder} min`;
}

function formatDrift(value: number): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

const LIMITATION_COPY: Readonly<
  Record<ActivityAnalysisData["aerobicDrift"]["limitations"][number], string>
> = {
  "duration-under-60-minutes": "Usable duration is below the 60-minute reference context.",
  "variable-output": "Power varied substantially across the ride.",
  "moving-status-unavailable":
    "No moving-status stream was available, so stopped time may be included.",
};

function shouldOfferRetry(reason: Parameters<typeof analysisUnavailableCopy>[0]): boolean {
  return (
    reason === "empty-response" ||
    reason === "malformed-response" ||
    reason === "response-too-large" ||
    reason === "request-budget-exhausted" ||
    reason === "rate-limited" ||
    reason === "timeout" ||
    reason === "network" ||
    reason === "provider-unavailable" ||
    reason === "cancelled" ||
    reason === "temporary-failure"
  );
}

function DriftHalf(props: {
  readonly label: string;
  readonly half: ActivityAnalysisData["aerobicDrift"]["firstHalf"];
}): ReactElement {
  return (
    <div className={styles.driftHalf}>
      <h3>{props.label}</h3>
      <p className={styles.driftEf}>{props.half.efficiencyFactor.toFixed(2)} EF</p>
      <p className={styles.driftHalfStats}>
        {Math.round(props.half.averagePowerWatts)} W · {Math.round(props.half.averageHeartRateBpm)}{" "}
        bpm
      </p>
      <p className={styles.driftHalfMeta}>
        {formatAnalysisDuration(props.half.durationSeconds)} ·{" "}
        {props.half.sampleCount.toLocaleString()} samples
      </p>
    </div>
  );
}

function DriftEvidence(props: {
  readonly data: ActivityAnalysisData["aerobicDrift"];
  readonly saved: boolean;
  readonly refreshing?: boolean;
  readonly clientRefreshUnavailable?: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["aerobicDrift"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  const provenance = props.saved ? "Saved analysis" : "Current analysis";
  const notice =
    props.refreshFailure !== undefined
      ? `Showing the saved result. ${analysisRefreshFailureCopy(props.refreshFailure.code)}`
      : props.clientRefreshUnavailable === true
        ? "Showing the previous result. The latest refresh did not finish."
        : props.refreshing === true
          ? "Refreshing the ride analysis…"
          : null;
  return (
    <>
      {notice === null ? null : (
        <p
          className={props.refreshing === true ? styles.analysisRefresh : styles.analysisNotice}
          role="status"
        >
          {notice}
        </p>
      )}
      <div className={styles.driftReading}>
        <div>
          <p className={styles.rideEyebrow}>Observed EF change</p>
          <p
            className={styles.driftValue}
            aria-label={`Observed efficiency-factor change ${formatDrift(
              props.data.decouplingPercent,
            )}`}
          >
            {formatDrift(props.data.decouplingPercent)}
          </p>
        </div>
        <div className={styles.driftContext}>
          <span className={styles.driftEvidenceBadge} data-evidence={props.data.evidence}>
            {props.data.evidence === "standard" ? "Data checks passed" : "Limited context"}
          </span>
          <p>{provenance} · whole ride</p>
        </div>
      </div>
      <div className={styles.driftTrace}>
        <DriftHalf label="First half" half={props.data.firstHalf} />
        <span className={styles.driftConnector} aria-hidden="true">
          →
        </span>
        <DriftHalf label="Second half" half={props.data.secondHalf} />
      </div>
      <p className={styles.driftCoverage}>
        {Math.round(props.data.coverage.fraction * 100)}% usable time ·{" "}
        {formatAnalysisDuration(props.data.coverage.includedDurationSeconds)} included ·{" "}
        {props.data.coverage.validSamples.toLocaleString()} of{" "}
        {props.data.coverage.totalSamples.toLocaleString()} samples
      </p>
      {props.data.limitations.length === 0 ? null : (
        <ul className={styles.driftLimitations} aria-label="Analysis limitations">
          {props.data.limitations.map((limitation) => (
            <li key={limitation}>{LIMITATION_COPY[limitation]}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function AerobicDriftPanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections.aerobicDrift : undefined;
  const refreshing = matches && props.analysis.loadingSections.includes("aerobic-drift");
  const clientRefreshUnavailable =
    matches && props.analysis.failedSections.includes("aerobic-drift");
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <DriftEvidence
        data={section.data}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        clientRefreshUnavailable={clientRefreshUnavailable}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <DriftEvidence data={section.lastGood.data} saved refreshFailure={section.refreshFailure} />
    );
  } else if (section?.kind === "unavailable") {
    content = (
      <div className={styles.analysisUnavailable}>
        <p>{analysisUnavailableCopy(section.reason)}</p>
        {props.onRefresh !== null && shouldOfferRetry(section.reason) ? (
          <Button type="button" variant="outline" onClick={props.onRefresh}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  } else if (clientRefreshUnavailable) {
    content = (
      <div className={styles.analysisUnavailable}>
        <p>The ride could not be analyzed right now.</p>
        {props.onRefresh === null ? null : (
          <Button type="button" variant="outline" onClick={props.onRefresh}>
            Try again
          </Button>
        )}
      </div>
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking ride streams…
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="aerobic-drift-title">
      <div className={styles.analysisHeading}>
        <div>
          <p className={styles.rideEyebrow}>Whole-ride analysis</p>
          <h2 id="aerobic-drift-title">Local aerobic drift estimate</h2>
        </div>
      </div>
      <p className={styles.analysisIntro}>
        Compares power per heartbeat in the first and second time-weighted halves. This local
        estimate is distinct from intervals.icu's cleaned power/HR metric.
      </p>
      {content}
    </section>
  );
}

const INTERVAL_KIND_COPY: Readonly<
  Record<ActivityAnalysisData["intervals"]["intervals"][number]["kind"], string>
> = {
  work: "Work",
  recovery: "Recovery",
  lap: "Lap",
  unknown: "Segment",
};

function unavailableMetric(): ReactElement {
  return <span aria-label="Unavailable">—</span>;
}

function durationMetric(seconds: number | null): ReactNode {
  return seconds === null ? unavailableMetric() : formatAnalysisDuration(seconds);
}

function distanceMetric(meters: number | null, units: UnitsPreference): ReactNode {
  if (meters === null) return unavailableMetric();
  return units === "imperial"
    ? `${(meters / 1_609.344).toFixed(1)} mi`
    : `${(meters / 1_000).toFixed(1)} km`;
}

function sensorMetric(average: number | null, maximum: number | null, unit: string): ReactNode {
  if (average === null && maximum === null) return unavailableMetric();
  if (average === null) return `${Math.round(maximum!)} max ${unit}`;
  if (maximum === null) return `${Math.round(average)} avg ${unit}`;
  return `${Math.round(average)} avg · ${Math.round(maximum)} max ${unit}`;
}

function decimalMetric(value: number | null, unit = ""): ReactNode {
  if (value === null) return unavailableMetric();
  const formatted = value.toFixed(1).replace(/\.0$/, "");
  return unit.length === 0 ? formatted : `${formatted}${unit}`;
}

function zoneMetric(zone: number | null): ReactNode {
  return zone === null ? unavailableMetric() : `Zone ${zone}`;
}

type IntervalMetricsData = Pick<
  ActivityAnalysisData["intervals"]["intervals"][number],
  | "movingSeconds"
  | "elapsedSeconds"
  | "averagePowerWatts"
  | "maximumPowerWatts"
  | "averageHeartRateBpm"
  | "maximumHeartRateBpm"
  | "averageCadenceRpm"
  | "maximumCadenceRpm"
  | "zone"
  | "intensityPercent"
  | "trainingLoad"
>;

function IntervalMetricGrid(props: {
  readonly metrics: IntervalMetricsData;
  readonly units: UnitsPreference;
  readonly distanceMeters?: number | null;
}): ReactElement {
  return (
    <dl className={styles.intervalMetrics}>
      <div>
        <dt>Duration</dt>
        <dd>{durationMetric(props.metrics.movingSeconds ?? props.metrics.elapsedSeconds)}</dd>
      </div>
      {props.distanceMeters === undefined ? null : (
        <div>
          <dt>Distance</dt>
          <dd>{distanceMetric(props.distanceMeters, props.units)}</dd>
        </div>
      )}
      <div>
        <dt>Power</dt>
        <dd>
          {sensorMetric(props.metrics.averagePowerWatts, props.metrics.maximumPowerWatts, "W")}
        </dd>
      </div>
      <div>
        <dt>Heart rate</dt>
        <dd>
          {sensorMetric(
            props.metrics.averageHeartRateBpm,
            props.metrics.maximumHeartRateBpm,
            "bpm",
          )}
        </dd>
      </div>
      <div>
        <dt>Cadence</dt>
        <dd>
          {sensorMetric(props.metrics.averageCadenceRpm, props.metrics.maximumCadenceRpm, "rpm")}
        </dd>
      </div>
      <div>
        <dt>Zone</dt>
        <dd>{zoneMetric(props.metrics.zone)}</dd>
      </div>
      <div>
        <dt>Intensity</dt>
        <dd>{decimalMetric(props.metrics.intensityPercent, "%")}</dd>
      </div>
      <div>
        <dt>Training load</dt>
        <dd>{decimalMetric(props.metrics.trainingLoad)}</dd>
      </div>
    </dl>
  );
}

function IntervalGroupEvidence(props: {
  readonly groups: ActivityAnalysisData["intervals"]["groups"];
  readonly units: UnitsPreference;
}): ReactElement | null {
  if (props.groups.length === 0) return null;
  return (
    <section className={styles.intervalGroups} aria-label="Interval group summaries">
      <h3>Group summaries</h3>
      <p>Provider summary metrics for related ordered segments.</p>
      <ol className={styles.intervalGroupList}>
        {props.groups.map((group) => (
          <li key={group.ordinal} className={styles.intervalGroupItem}>
            <div className={styles.intervalGroupIdentity}>
              <div>
                <span>Group {group.ordinal}</span>
                <strong>{INTERVAL_KIND_COPY[group.kind]} group</strong>
              </div>
              <p>
                {group.intervalOrdinals.length === 1 ? "Segment" : "Segments"}{" "}
                {group.intervalOrdinals.join(", ")}
              </p>
            </div>
            <IntervalMetricGrid metrics={group} units={props.units} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function AnalysisRetry(props: {
  readonly reason: Parameters<typeof analysisUnavailableCopy>[0] | null;
  readonly onRefresh: (() => void) | null;
  readonly fallback?: string;
}): ReactElement {
  const retry = props.reason === null || shouldOfferRetry(props.reason);
  return (
    <div className={styles.analysisUnavailable}>
      <p>
        {props.reason === null
          ? (props.fallback ?? "This analysis could not be loaded right now.")
          : analysisUnavailableCopy(props.reason)}
      </p>
      {props.onRefresh !== null && retry ? (
        <Button type="button" variant="outline" onClick={props.onRefresh}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function AnalysisEvidenceStatus(props: {
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly clientRefreshUnavailable: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<unknown>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement | null {
  const notice =
    props.refreshFailure !== undefined
      ? `Showing the saved result. ${analysisRefreshFailureCopy(props.refreshFailure.code)}`
      : props.clientRefreshUnavailable
        ? "Showing the previous result. The latest refresh did not finish."
        : props.refreshing
          ? "Refreshing this analysis…"
          : props.saved
            ? "Showing saved analysis."
            : null;
  return notice === null ? null : (
    <p className={props.refreshing ? styles.analysisRefresh : styles.analysisNotice} role="status">
      {notice}
    </p>
  );
}

function IntervalEvidence(props: {
  readonly data: ActivityAnalysisData["intervals"];
  readonly units: UnitsPreference;
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly clientRefreshUnavailable: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["intervals"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  return (
    <>
      <AnalysisEvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        clientRefreshUnavailable={props.clientRefreshUnavailable}
        refreshFailure={props.refreshFailure}
      />
      <p className={styles.analysisSource}>
        {props.data.source === "provider"
          ? "Ordered analysis from intervals.icu"
          : "Ordered laps from the local ride file"}
        {props.data.groups.length === 0 ? "" : ` · ${props.data.groups.length} groups`}
      </p>
      <IntervalGroupEvidence groups={props.data.groups} units={props.units} />
      {props.data.intervals.length === 0 ? (
        <p className={styles.analysisEmpty}>No intervals or laps were found for this ride.</p>
      ) : (
        <ol className={styles.intervalList} aria-label="Ordered ride intervals and laps">
          {props.data.intervals.map((interval) => (
            <li key={interval.ordinal} className={styles.intervalItem} data-kind={interval.kind}>
              <div className={styles.intervalIdentity}>
                <span className={styles.intervalOrdinal} aria-hidden="true">
                  {interval.ordinal}
                </span>
                <div>
                  <span className={styles.intervalKind}>{INTERVAL_KIND_COPY[interval.kind]}</span>
                  <h3>{interval.label ?? `Interval ${interval.ordinal}`}</h3>
                  {interval.groupOrdinal === null ? null : <p>Group {interval.groupOrdinal}</p>}
                </div>
              </div>
              <IntervalMetricGrid
                metrics={interval}
                units={props.units}
                distanceMeters={interval.distanceMeters}
              />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function IntervalReviewPanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly units: UnitsPreference;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections.intervals : undefined;
  const refreshing = matches && props.analysis.loadingSections.includes("intervals");
  const failed = matches && props.analysis.failedSections.includes("intervals");
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <IntervalEvidence
        data={section.data}
        units={props.units}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        clientRefreshUnavailable={failed}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <IntervalEvidence
        data={section.lastGood.data}
        units={props.units}
        saved
        refreshing={false}
        clientRefreshUnavailable={false}
        refreshFailure={section.refreshFailure}
      />
    );
  } else if (section?.kind === "unavailable") {
    content = <AnalysisRetry reason={section.reason} onRefresh={props.onRefresh} />;
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback="Intervals and laps could not be loaded right now."
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking ride intervals…
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="interval-review-title">
      <p className={styles.rideEyebrow}>Ordered ride segments</p>
      <h2 id="interval-review-title" className={styles.analysisTitle}>
        Intervals and laps
      </h2>
      <p className={styles.analysisIntro}>
        Shows recorded segments in order. Missing metrics stay unavailable, and no planned workout
        targets are inferred.
      </p>
      {content}
    </section>
  );
}

function BestEffortEvidence(props: {
  readonly data: ActivityAnalysisData["bestEfforts"];
  readonly units: UnitsPreference;
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly clientRefreshUnavailable: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["bestEfforts"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  return (
    <>
      <AnalysisEvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        clientRefreshUnavailable={props.clientRefreshUnavailable}
        refreshFailure={props.refreshFailure}
      />
      <p className={styles.analysisSource}>
        This ride · power · {formatAnalysisDuration(props.data.scope.durationSeconds)} · equal
        efforts rank the earlier start first
      </p>
      {props.data.efforts.length === 0 ? (
        <p className={styles.analysisEmpty}>No five-minute power efforts were found.</p>
      ) : (
        <ol className={styles.effortList} aria-label="Five-minute power efforts in this ride">
          {props.data.efforts.map((effort) => (
            <li key={effort.rank} className={styles.effortItem}>
              <span className={styles.effortRank}>#{effort.rank}</span>
              <strong>{Math.round(effort.averageWatts)} W</strong>
              <span>{distanceMetric(effort.distanceMeters, props.units)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function BestEffortPanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly units: UnitsPreference;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections.bestEfforts : undefined;
  const refreshing = matches && props.analysis.loadingSections.includes("best-efforts");
  const failed = matches && props.analysis.failedSections.includes("best-efforts");
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <BestEffortEvidence
        data={section.data}
        units={props.units}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        clientRefreshUnavailable={failed}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <BestEffortEvidence
        data={section.lastGood.data}
        units={props.units}
        saved
        refreshing={false}
        clientRefreshUnavailable={false}
        refreshFailure={section.refreshFailure}
      />
    );
  } else if (section?.kind === "unavailable") {
    content = <AnalysisRetry reason={section.reason} onRefresh={props.onRefresh} />;
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback="Five-minute efforts could not be loaded right now."
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking five-minute efforts…
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="best-efforts-title">
      <p className={styles.rideEyebrow}>Selected-ride scope</p>
      <h2 id="best-efforts-title" className={styles.analysisTitle}>
        Five-minute best efforts
      </h2>
      <p className={styles.analysisIntro}>
        Ranks measured five-minute power efforts from this ride only. It does not compare against
        other rides or all-history results.
      </p>
      {content}
    </section>
  );
}

export function RideDetailView(props: {
  readonly ride: TrainingHistoryRide;
  readonly units: UnitsPreference;
  readonly analysis: RideAnalysisViewState;
  readonly calloutReason: string | null;
  readonly onStartAnalysis: (() => void) | null;
  readonly onRefreshAnalysis: ((sections: readonly ActivityAnalysisSection[]) => void) | null;
  readonly onBack: () => void;
  readonly titleRef: Ref<HTMLHeadingElement>;
}): ReactElement {
  const analysisStarted = useRef(false);
  const metrics = recordedRideMetrics(props.ride);
  const title = props.ride.title ?? trainingRideKind(props.ride);
  return (
    <Page
      title={TRAINING_HISTORY_COPY.review}
      subtitle={formatCivilDate(props.ride.localDate)}
      titleRef={props.titleRef}
      action={
        <Button
          className={styles.rideBack}
          type="button"
          variant="outline"
          size="xs"
          onClick={props.onBack}
        >
          {TRAINING_HISTORY_COPY.back}
        </Button>
      }
    >
      <section className={styles.rideOverview} aria-labelledby="ride-overview-title">
        <p className={styles.rideOverviewEyebrow}>{trainingRideKind(props.ride)}</p>
        <h2 id="ride-overview-title">{title}</h2>
        <RideSummary ride={props.ride} units={props.units} />
        {props.ride.ridingTimeBasis === "elapsed" ? (
          <p className={styles.elapsedFallback}>
            Elapsed time used because moving time was not recorded.
          </p>
        ) : null}
        {props.calloutReason === null ? null : (
          <p className={styles.calloutReason}>
            <strong>Worth a look</strong>
            <span>{props.calloutReason}</span>
          </p>
        )}
      </section>
      {metrics.length === 0 ? null : (
        <section
          className={styles.keyStats}
          aria-labelledby="key-stats-title"
          data-parity="ride-key-stats"
        >
          <h2 id="key-stats-title">{TRAINING_HISTORY_COPY.keyStats}</h2>
          <dl className={styles.recordedMetrics}>
            {metrics.map((metric) => (
              <div key={metric.label}>
                <dt>{metric.label}</dt>
                <dd>{metric.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <details
        className={styles.recordedDisclosure}
        onToggle={(event) => {
          if (!event.currentTarget.open || analysisStarted.current) return;
          analysisStarted.current = true;
          props.onStartAnalysis?.();
        }}
      >
        <summary>{TRAINING_HISTORY_COPY.disclosure}</summary>
        <div className={styles.recordedDisclosureBody}>
          <AerobicDriftPanel
            rideId={props.ride.id}
            analysis={props.analysis}
            onRefresh={
              props.onRefreshAnalysis === null
                ? null
                : () => props.onRefreshAnalysis?.(["aerobic-drift"])
            }
          />
          <IntervalReviewPanel
            rideId={props.ride.id}
            analysis={props.analysis}
            units={props.units}
            onRefresh={
              props.onRefreshAnalysis === null
                ? null
                : () => props.onRefreshAnalysis?.(["intervals"])
            }
          />
          <BestEffortPanel
            rideId={props.ride.id}
            analysis={props.analysis}
            units={props.units}
            onRefresh={
              props.onRefreshAnalysis === null
                ? null
                : () => props.onRefreshAnalysis?.(["best-efforts"])
            }
          />
          <RideResponseReview
            rideId={props.ride.id}
            analysis={props.analysis}
            onRefresh={props.onRefreshAnalysis}
          />
        </div>
      </details>
    </Page>
  );
}
