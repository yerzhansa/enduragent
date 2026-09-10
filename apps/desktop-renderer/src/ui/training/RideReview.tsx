import { msg, type Message, type CatalogKey } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type {
  ActivityAnalysisData,
  ActivityAnalysisSection,
  AnalysisSection,
  TrainingHistoryRide,
  UnitsPreference,
} from "@enduragent/coach-contract";
import { useRef, type ReactElement, type ReactNode, type Ref } from "react";
import type { RideAnalysisViewState } from "../../activity-analysis/controller";
import { Button, RideMetricList, FactualCallout, Disclosure } from "@enduragent/ui";
import {
  formatDistance,
  formatRidingDuration,
  formatWholeNumber,
} from "../../training-context/format";
import { Page } from "@enduragent/ui";
import { TRAINING_HISTORY_COPY, analysisRefreshFailureCopy, analysisUnavailableCopy } from "./copy";
import { RideResponseReview } from "./RideResponseReview";
import { rideStyles as styles } from "./rideStyles";

const RIDE_KIND: Readonly<
  Record<string, { readonly full: CatalogKey; readonly short: CatalogKey }>
> = {
  road: { full: "training.ride.kindRoad", short: "training.ride.kindRoadShort" },
  mountain: { full: "training.ride.kindMountain", short: "training.ride.kindMountainShort" },
  downhill: { full: "training.ride.kindDownhill", short: "training.ride.kindDownhillShort" },
  cyclocross: { full: "training.ride.kindCyclocross", short: "training.ride.kindCyclocrossShort" },
  track: { full: "training.ride.kindTrack", short: "training.ride.kindTrackShort" },
  indoor_cycling: { full: "training.ride.kindIndoor", short: "training.ride.kindIndoorShort" },
  virtual_activity: { full: "training.ride.kindVirtual", short: "training.ride.kindVirtualShort" },
  gravel_cycling: { full: "training.ride.kindGravel", short: "training.ride.kindGravelShort" },
};

export function trainingRideKind(ride: TrainingHistoryRide, short = false): Message {
  const kind = ride.subSport === null ? undefined : RIDE_KIND[ride.subSport];
  return msg(
    kind === undefined
      ? short
        ? "training.ride.kindCyclingShort"
        : "training.ride.kindCycling"
      : short
        ? kind.short
        : kind.full,
  );
}

function rideDuration(ride: TrainingHistoryRide, { say, format }: Phrasebook): string {
  return ride.ridingSeconds === null
    ? say("training.ride.notRecorded")
    : say(formatRidingDuration(ride.ridingSeconds, format));
}

function rideDistance(
  ride: TrainingHistoryRide,
  units: UnitsPreference,
  { say, format }: Phrasebook,
): string {
  return ride.distanceMeters === null
    ? say("training.ride.notRecorded")
    : say(formatDistance(ride.distanceMeters, units, format));
}

export function trainingRideTime(ride: TrainingHistoryRide, { format }: Phrasebook): string | null {
  if (ride.timezoneOffsetSeconds === null) return null;
  const date = new Date((ride.startEpochSeconds + ride.timezoneOffsetSeconds) * 1_000);
  return Number.isFinite(date.getTime())
    ? format.date(date, { timeStyle: "short", timeZone: "UTC" })
    : null;
}

function trainingRideDate(ride: TrainingHistoryRide, { say, format }: Phrasebook): string {
  const date = new Date(`${ride.localDate}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === ride.localDate
    ? format.date(date, { dateStyle: "medium", timeZone: "UTC" })
    : say("training.ride.unknownDate");
}

export function trainingRideDateTime(ride: TrainingHistoryRide, phrasebook: Phrasebook): string {
  const time = trainingRideTime(ride, phrasebook);
  const date = trainingRideDate(ride, phrasebook);
  return time === null ? date : phrasebook.say("training.ride.dateTime", { date, time });
}

function RideSummary(props: {
  readonly ride: TrainingHistoryRide;
  readonly units: UnitsPreference;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  return (
    <dl className={styles.rideSummary}>
      <div>
        <dt>{say("training.ride.date")}</dt>
        <dd>
          <time dateTime={props.ride.localDate}>
            {trainingRideDateTime(props.ride, phrasebook)}
          </time>
        </dd>
      </div>
      <div>
        <dt>{say("training.ride.ridingTime")}</dt>
        <dd>{rideDuration(props.ride, phrasebook)}</dd>
      </div>
      <div>
        <dt>{say("training.ride.distance")}</dt>
        <dd>{rideDistance(props.ride, props.units, phrasebook)}</dd>
      </div>
    </dl>
  );
}

function recordedRideMetrics(
  ride: TrainingHistoryRide,
  { say, format }: Phrasebook,
): readonly {
  readonly label: string;
  readonly value: string;
}[] {
  const metrics: { label: string; value: string }[] = [];
  if (ride.load !== null)
    metrics.push({ label: say("training.ride.load"), value: formatWholeNumber(ride.load, format) });
  if (ride.averagePowerWatts !== null) {
    metrics.push({
      label: say("training.ride.averagePower"),
      value: say("training.ride.measurement", {
        value: formatWholeNumber(ride.averagePowerWatts, format),
        unit: "W",
      }),
    });
  }
  if (ride.averageHeartRateBpm !== null) {
    metrics.push({
      label: say("training.ride.averageHeartRate"),
      value: say("training.ride.measurement", {
        value: formatWholeNumber(ride.averageHeartRateBpm, format),
        unit: "bpm",
      }),
    });
  }
  if (ride.perceivedExertion !== null) {
    metrics.push({
      label: say("training.ride.perceivedExertion"),
      value: formatWholeNumber(ride.perceivedExertion, format),
    });
  }
  if (ride.energyKilojoules !== null) {
    metrics.push({
      label: say("training.ride.energy"),
      value: say("training.ride.measurement", {
        value: formatWholeNumber(ride.energyKilojoules, format),
        unit: "kJ",
      }),
    });
  }
  return metrics.slice(0, 4);
}

function formatAnalysisDuration(seconds: number, { say, format }: Phrasebook): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours === 0
    ? say("training.ride.durationMinutes", {
        value: format.number(minutes, { useGrouping: false }),
      })
    : say("training.ride.durationHoursMinutes", {
        hours: format.number(hours, { useGrouping: false }),
        minutes: format.number(remainder, { useGrouping: false }),
      });
}

function formatDrift(value: number, { say, format }: Phrasebook): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return say("training.ride.percent", {
    value: format.number(Number(rounded.toFixed(1)), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      useGrouping: false,
      signDisplay: "exceptZero",
    }),
  });
}

const LIMITATION_COPY: Readonly<
  Record<ActivityAnalysisData["aerobicDrift"]["limitations"][number], Message>
> = {
  "duration-under-60-minutes": msg("training.ride.limitationDuration"),
  "variable-output": msg("training.ride.limitationVariable"),
  "moving-status-unavailable": msg("training.ride.limitationMoving"),
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
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  return (
    <div className={styles.driftHalf}>
      <h3>{props.label}</h3>
      <p className={styles.driftEf}>
        {say("training.ride.measurement", {
          value: format.number(Number(props.half.efficiencyFactor.toFixed(2)), {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
            useGrouping: false,
          }),
          unit: "EF",
        })}
      </p>
      <p className={styles.driftHalfStats}>
        {say("training.ride.halfStats", {
          watts: format.number(Math.round(props.half.averagePowerWatts), { useGrouping: false }),
          heartRate: format.number(Math.round(props.half.averageHeartRateBpm), {
            useGrouping: false,
          }),
        })}
      </p>
      <p className={styles.driftHalfMeta}>
        {say("training.ride.halfMeta", {
          count: props.half.sampleCount,
          duration: formatAnalysisDuration(props.half.durationSeconds, phrasebook),
          value: format.number(props.half.sampleCount),
        })}
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
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const provenance = props.saved
    ? say("training.ride.savedAnalysis")
    : say("training.ride.currentAnalysis");
  const notice =
    props.refreshFailure !== undefined
      ? say("training.ride.savedResult", {
          failure: say(analysisRefreshFailureCopy(props.refreshFailure.code)),
        })
      : props.clientRefreshUnavailable === true
        ? say("training.ride.previousResult")
        : props.refreshing === true
          ? say("training.ride.refreshingRide")
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
          <p className={styles.rideEyebrow}>{say("training.ride.driftObserved")}</p>
          <p
            className={styles.driftValue}
            aria-label={say("training.ride.driftLabel", {
              value: formatDrift(props.data.decouplingPercent, phrasebook),
            })}
          >
            {formatDrift(props.data.decouplingPercent, phrasebook)}
          </p>
        </div>
        <div className={styles.driftContext}>
          <span className={styles.driftEvidenceBadge} data-evidence={props.data.evidence}>
            {props.data.evidence === "standard"
              ? say("training.ride.dataChecksPassed")
              : say("training.ride.limitedContext")}
          </span>
          <p>{say("training.ride.wholeRide", { provenance })}</p>
        </div>
      </div>
      <div className={styles.driftTrace}>
        <DriftHalf label={say("training.ride.firstHalf")} half={props.data.firstHalf} />
        <span className={styles.driftConnector} aria-hidden="true">
          →
        </span>
        <DriftHalf label={say("training.ride.secondHalf")} half={props.data.secondHalf} />
      </div>
      <p className={styles.driftCoverage}>
        {say("training.ride.coverage", {
          percent: format.number(Math.round(props.data.coverage.fraction * 100), {
            useGrouping: false,
          }),
          duration: formatAnalysisDuration(props.data.coverage.includedDurationSeconds, phrasebook),
          valid: format.number(props.data.coverage.validSamples),
          total: format.number(props.data.coverage.totalSamples),
        })}
      </p>
      {props.data.limitations.length === 0 ? null : (
        <ul className={styles.driftLimitations} aria-label={say("training.ride.limitations")}>
          {props.data.limitations.map((limitation) => (
            <li key={limitation}>{say(LIMITATION_COPY[limitation])}</li>
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
  const { say } = usePhrasebook();
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
        <p>{say(analysisUnavailableCopy(section.reason))}</p>
        {props.onRefresh !== null && shouldOfferRetry(section.reason) ? (
          <Button type="button" variant="outline" onClick={props.onRefresh}>
            {say("training.ride.retry")}
          </Button>
        ) : null}
      </div>
    );
  } else if (clientRefreshUnavailable) {
    content = (
      <div className={styles.analysisUnavailable}>
        <p>{say("training.ride.analysisFailed")}</p>
        {props.onRefresh === null ? null : (
          <Button type="button" variant="outline" onClick={props.onRefresh}>
            {say("training.ride.retry")}
          </Button>
        )}
      </div>
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        {say("training.ride.streamsLoading")}
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="aerobic-drift-title">
      <div className={styles.analysisHeading}>
        <div>
          <p className={styles.rideEyebrow}>{say("training.ride.driftEyebrow")}</p>
          <h2 id="aerobic-drift-title">{say("training.ride.driftTitle")}</h2>
        </div>
      </div>
      <p className={styles.analysisIntro}>
        {say("training.ride.driftIntro", { provider: "intervals.icu" })}
      </p>
      {content}
    </section>
  );
}

const INTERVAL_KIND_COPY: Readonly<
  Record<ActivityAnalysisData["intervals"]["intervals"][number]["kind"], Message>
> = {
  work: msg("training.ride.intervalWork"),
  recovery: msg("training.ride.intervalRecovery"),
  lap: msg("training.ride.intervalLap"),
  unknown: msg("training.ride.intervalSegment"),
};

function unavailableMetric({ say }: Phrasebook): ReactElement {
  return <span aria-label={say("training.ride.unavailableMetric")}>—</span>;
}

function durationMetric(seconds: number | null, phrasebook: Phrasebook): ReactNode {
  return seconds === null
    ? unavailableMetric(phrasebook)
    : formatAnalysisDuration(seconds, phrasebook);
}

function distanceMetric(
  meters: number | null,
  units: UnitsPreference,
  phrasebook: Phrasebook,
): ReactNode {
  if (meters === null) return unavailableMetric(phrasebook);
  return phrasebook.say("training.ride.measurement", {
    value: phrasebook.format.number(
      Number((meters / (units === "imperial" ? 1_609.344 : 1_000)).toFixed(1)),
      { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false },
    ),
    unit: units === "imperial" ? "mi" : "km",
  });
}

function sensorMetric(
  average: number | null,
  maximum: number | null,
  unit: string,
  phrasebook: Phrasebook,
): ReactNode {
  const { say, format } = phrasebook;
  if (average === null)
    return maximum === null
      ? unavailableMetric(phrasebook)
      : say("training.ride.sensorMaximum", {
          value: format.number(Math.round(maximum), { useGrouping: false }),
          unit,
        });
  if (maximum === null)
    return say("training.ride.sensorAverage", {
      value: format.number(Math.round(average), { useGrouping: false }),
      unit,
    });
  return say("training.ride.sensorBoth", {
    average: format.number(Math.round(average), { useGrouping: false }),
    maximum: format.number(Math.round(maximum), { useGrouping: false }),
    unit,
  });
}

function decimalMetric(value: number | null, phrasebook: Phrasebook, unit = ""): ReactNode {
  if (value === null) return unavailableMetric(phrasebook);
  const formatted = phrasebook.format.number(Number(value.toFixed(1)), {
    maximumFractionDigits: 1,
    useGrouping: false,
  });
  return unit.length === 0
    ? formatted
    : phrasebook.say("training.ride.decimalUnit", { value: formatted, unit });
}

function zoneMetric(zone: number | null, phrasebook: Phrasebook): ReactNode {
  return zone === null
    ? unavailableMetric(phrasebook)
    : phrasebook.say("training.ride.zoneValue", {
        value: phrasebook.format.number(zone, { useGrouping: false }),
      });
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  return (
    <dl className={styles.intervalMetrics}>
      <div>
        <dt>{say("training.ride.duration")}</dt>
        <dd>
          {durationMetric(props.metrics.movingSeconds ?? props.metrics.elapsedSeconds, phrasebook)}
        </dd>
      </div>
      {props.distanceMeters === undefined ? null : (
        <div>
          <dt>{say("training.ride.distance")}</dt>
          <dd>{distanceMetric(props.distanceMeters, props.units, phrasebook)}</dd>
        </div>
      )}
      <div>
        <dt>{say("training.ride.power")}</dt>
        <dd>
          {sensorMetric(
            props.metrics.averagePowerWatts,
            props.metrics.maximumPowerWatts,
            "W",
            phrasebook,
          )}
        </dd>
      </div>
      <div>
        <dt>{say("training.ride.heartRate")}</dt>
        <dd>
          {sensorMetric(
            props.metrics.averageHeartRateBpm,
            props.metrics.maximumHeartRateBpm,
            "bpm",
            phrasebook,
          )}
        </dd>
      </div>
      <div>
        <dt>{say("training.ride.cadence")}</dt>
        <dd>
          {sensorMetric(
            props.metrics.averageCadenceRpm,
            props.metrics.maximumCadenceRpm,
            "rpm",
            phrasebook,
          )}
        </dd>
      </div>
      <div>
        <dt>{say("training.ride.zone")}</dt>
        <dd>{zoneMetric(props.metrics.zone, phrasebook)}</dd>
      </div>
      <div>
        <dt>{say("training.ride.intensity")}</dt>
        <dd>{decimalMetric(props.metrics.intensityPercent, phrasebook, "%")}</dd>
      </div>
      <div>
        <dt>{say("training.ride.trainingLoad")}</dt>
        <dd>{decimalMetric(props.metrics.trainingLoad, phrasebook)}</dd>
      </div>
    </dl>
  );
}

function IntervalGroupEvidence(props: {
  readonly groups: ActivityAnalysisData["intervals"]["groups"];
  readonly units: UnitsPreference;
}): ReactElement | null {
  const { say, format } = usePhrasebook();
  if (props.groups.length === 0) return null;
  return (
    <section className={styles.intervalGroups} aria-label={say("training.ride.groupsLabel")}>
      <h3>{say("training.ride.groupsTitle")}</h3>
      <p>{say("training.ride.groupsIntro")}</p>
      <ol className={styles.intervalGroupList}>
        {props.groups.map((group) => (
          <li key={group.ordinal} className={styles.intervalGroupItem}>
            <div className={styles.intervalGroupIdentity}>
              <div>
                <span>
                  {say("training.ride.groupOrdinal", {
                    value: format.number(group.ordinal, { useGrouping: false }),
                  })}
                </span>
                <strong>
                  {say("training.ride.groupKind", { kind: say(INTERVAL_KIND_COPY[group.kind]) })}
                </strong>
              </div>
              <p>
                {say("training.ride.groupSegments", {
                  count: group.intervalOrdinals.length,
                  values: group.intervalOrdinals
                    .map((value) => format.number(value, { useGrouping: false }))
                    .join(", "),
                })}
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
  const { say } = usePhrasebook();
  const retry = props.reason === null || shouldOfferRetry(props.reason);
  return (
    <div className={styles.analysisUnavailable}>
      <p>
        {props.reason === null
          ? (props.fallback ?? say("training.ride.analysisUnavailable"))
          : say(analysisUnavailableCopy(props.reason))}
      </p>
      {props.onRefresh !== null && retry ? (
        <Button type="button" variant="outline" onClick={props.onRefresh}>
          {say("training.ride.retry")}
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
  const { say } = usePhrasebook();
  const notice =
    props.refreshFailure !== undefined
      ? say("training.ride.savedResult", {
          failure: say(analysisRefreshFailureCopy(props.refreshFailure.code)),
        })
      : props.clientRefreshUnavailable
        ? say("training.ride.previousResult")
        : props.refreshing
          ? say("training.ride.refreshingAnalysis")
          : props.saved
            ? say("training.ride.showingSavedAnalysis")
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
  const { say, format } = usePhrasebook();
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
          ? say("training.ride.providerIntervals", { provider: "intervals.icu" })
          : say("training.ride.localIntervals")}
        {props.data.groups.length === 0
          ? ""
          : say("training.ride.groupsSuffix", {
              count: props.data.groups.length,
              value: format.number(props.data.groups.length, { useGrouping: false }),
            })}
      </p>
      <IntervalGroupEvidence groups={props.data.groups} units={props.units} />
      {props.data.intervals.length === 0 ? (
        <p className={styles.analysisEmpty}>{say("training.ride.noIntervals")}</p>
      ) : (
        <ol className={styles.intervalList} aria-label={say("training.ride.intervalsLabel")}>
          {props.data.intervals.map((interval) => (
            <li
              key={format.number(interval.ordinal, { useGrouping: false })}
              className={styles.intervalItem}
              data-kind={interval.kind}
            >
              <div className={styles.intervalIdentity}>
                <span className={styles.intervalOrdinal} aria-hidden="true">
                  {format.number(interval.ordinal, { useGrouping: false })}
                </span>
                <div>
                  <span className={styles.intervalKind}>
                    {say(INTERVAL_KIND_COPY[interval.kind])}
                  </span>
                  <h3>
                    {interval.label ??
                      say("training.ride.intervalOrdinal", {
                        value: format.number(interval.ordinal, { useGrouping: false }),
                      })}
                  </h3>
                  {interval.groupOrdinal === null ? null : (
                    <p>
                      {say("training.ride.groupOrdinal", {
                        value: format.number(interval.groupOrdinal, { useGrouping: false }),
                      })}
                    </p>
                  )}
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
  const { say } = usePhrasebook();
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
        fallback={say("training.ride.intervalsFailed")}
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        {say("training.ride.intervalsLoading")}
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="interval-review-title">
      <p className={styles.rideEyebrow}>{say("training.ride.intervalsEyebrow")}</p>
      <h2 id="interval-review-title" className={styles.analysisTitle}>
        {say("training.ride.intervalsTitle")}
      </h2>
      <p className={styles.analysisIntro}>{say("training.ride.intervalsIntro")}</p>
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
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  return (
    <>
      <AnalysisEvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        clientRefreshUnavailable={props.clientRefreshUnavailable}
        refreshFailure={props.refreshFailure}
      />
      <p className={styles.analysisSource}>
        {say("training.ride.effortSource", {
          duration: formatAnalysisDuration(props.data.scope.durationSeconds, phrasebook),
        })}
      </p>
      {props.data.efforts.length === 0 ? (
        <p className={styles.analysisEmpty}>{say("training.ride.noEfforts")}</p>
      ) : (
        <ol className={styles.effortList} aria-label={say("training.ride.effortsLabel")}>
          {props.data.efforts.map((effort) => (
            <li key={effort.rank} className={styles.effortItem}>
              <span className={styles.effortRank}>
                {say("training.ride.effortRank", {
                  value: format.number(effort.rank, { useGrouping: false }),
                })}
              </span>
              <strong>
                {say("training.ride.measurement", {
                  value: format.number(Math.round(effort.averageWatts), { useGrouping: false }),
                  unit: "W",
                })}
              </strong>
              <span>{distanceMetric(effort.distanceMeters, props.units, phrasebook)}</span>
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
  const { say } = usePhrasebook();
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
        fallback={say("training.ride.effortsFailed")}
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        {say("training.ride.effortsLoading")}
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="best-efforts-title">
      <p className={styles.rideEyebrow}>{say("training.ride.effortsEyebrow")}</p>
      <h2 id="best-efforts-title" className={styles.analysisTitle}>
        {say("training.ride.effortsTitle")}
      </h2>
      <p className={styles.analysisIntro}>{say("training.ride.effortsIntro")}</p>
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
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const analysisStarted = useRef(false);
  const metrics = recordedRideMetrics(props.ride, phrasebook);
  const title = props.ride.title ?? say(trainingRideKind(props.ride));
  return (
    <Page
      title={say(TRAINING_HISTORY_COPY.review)}
      subtitle={trainingRideDate(props.ride, phrasebook)}
      titleRef={props.titleRef}
      action={
        <Button
          className={styles.rideBack}
          type="button"
          variant="outline"
          size="xs"
          onClick={props.onBack}
        >
          {say(TRAINING_HISTORY_COPY.back)}
        </Button>
      }
    >
      <section className={styles.rideOverview} aria-labelledby="ride-overview-title">
        <p className={styles.rideOverviewEyebrow}>{say(trainingRideKind(props.ride))}</p>
        <h2 id="ride-overview-title">{title}</h2>
        <RideSummary ride={props.ride} units={props.units} />
        {props.ride.ridingTimeBasis === "elapsed" ? (
          <p className={styles.elapsedFallback}>{say("training.ride.elapsedFallback")}</p>
        ) : null}
        {props.calloutReason === null ? null : (
          <FactualCallout title={say("training.ride.calloutTitle")}>
            {props.calloutReason}
          </FactualCallout>
        )}
      </section>
      {metrics.length === 0 ? null : (
        <section
          className={styles.keyStats}
          aria-labelledby="key-stats-title"
          data-parity="ride-key-stats"
        >
          <h2 id="key-stats-title">{say(TRAINING_HISTORY_COPY.keyStats)}</h2>
          <RideMetricList rows={metrics.map((metric) => ({ ...metric, id: metric.label }))} />
        </section>
      )}
      <Disclosure
        summary={say(TRAINING_HISTORY_COPY.disclosure)}
        className="mt-7"
        onToggle={(event) => {
          if (!event.currentTarget.open || analysisStarted.current) return;
          analysisStarted.current = true;
          props.onStartAnalysis?.();
        }}
      >
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
      </Disclosure>
    </Page>
  );
}
