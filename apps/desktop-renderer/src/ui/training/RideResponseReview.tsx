import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type {
  ActivityAnalysisData,
  ActivityAnalysisSection,
  AnalysisSection,
} from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import type { RideAnalysisViewState } from "../../activity-analysis/controller";
import { Button } from "@enduragent/ui";
import { analysisRefreshFailureCopy, analysisUnavailableCopy } from "./copy";
import { responseStyles as styles } from "./responseStyles";

const CHART_WIDTH = 640;
const CHART_HEIGHT = 190;
const CHART_LEFT = 52;
const CHART_RIGHT = 18;
const CHART_TOP = 14;
const CHART_BOTTOM = 34;

function offerRetry(reason: Parameters<typeof analysisUnavailableCopy>[0]): boolean {
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

function AnalysisRetry(props: {
  readonly reason: Parameters<typeof analysisUnavailableCopy>[0] | null;
  readonly onRefresh: (() => void) | null;
  readonly fallback: string;
}): ReactElement {
  const { say } = usePhrasebook();
  return (
    <div className={styles.analysisUnavailable}>
      <p>{props.reason === null ? props.fallback : say(analysisUnavailableCopy(props.reason))}</p>
      {props.onRefresh !== null && (props.reason === null || offerRetry(props.reason)) ? (
        <Button type="button" variant="outline" onClick={props.onRefresh}>
          {say("training.response.retry")}
        </Button>
      ) : null}
    </div>
  );
}

function EvidenceStatus(props: {
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly failed: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<unknown>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement | null {
  const { say } = usePhrasebook();
  const notice =
    props.refreshFailure !== undefined
      ? say("training.response.savedResult", {
          failure: say(analysisRefreshFailureCopy(props.refreshFailure.code)),
        })
      : props.failed
        ? say("training.response.previousResult")
        : props.refreshing
          ? say("training.response.refreshing")
          : props.saved
            ? say("training.response.savedAnalysis")
            : null;
  return notice === null ? null : (
    <p className={props.refreshing ? styles.analysisRefresh : styles.analysisNotice} role="status">
      {notice}
    </p>
  );
}

function formatDuration(seconds: number, { say, format }: Phrasebook): string {
  const roundedMinutes = Math.round(seconds / 60);
  if (roundedMinutes < 1)
    return say("training.response.seconds", {
      value: format.number(Math.round(seconds), { useGrouping: false }),
    });
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours === 0)
    return say("training.response.minutes", {
      value: format.number(minutes, { useGrouping: false }),
    });
  return minutes === 0
    ? say("training.response.hours", { value: format.number(hours, { useGrouping: false }) })
    : say("training.response.hoursMinutes", {
        hours: format.number(hours, { useGrouping: false }),
        minutes: format.number(minutes, { useGrouping: false }),
      });
}

function axisValue(
  value: number,
  unit: ActivityAnalysisData["powerDistribution"]["unit"],
  { say, format }: Phrasebook,
): string {
  return say("training.response.measurement", {
    value: format.number(Math.round(value), { useGrouping: false }),
    unit: unit === "watts" ? "W" : "bpm",
  });
}

function curveLabel(
  kind: ActivityAnalysisData["powerHeartRate"]["curves"][number]["kind"],
  { say }: Phrasebook,
): string {
  if (kind === "all") return say("training.response.curveAll");
  if (kind === "zone-2") return say("training.response.curveZoneTwo");
  return say("training.response.curveOther");
}

function DistributionChart(props: {
  readonly data: ActivityAnalysisData["powerDistribution"];
  readonly label: string;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const first = props.data.buckets[0]!;
  const last = props.data.buckets.at(-1)!;
  const axisMinimum = first.lower;
  const axisMaximum = last.upper;
  const axisSpan = Math.max(axisMaximum - axisMinimum, 1);
  const maximumSeconds = Math.max(...props.data.buckets.map((bucket) => bucket.seconds), 1);
  const width = CHART_WIDTH - CHART_LEFT - CHART_RIGHT;
  const height = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
  return (
    <figure className={styles.distributionFigure}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className={styles.distributionChart}
        data-unit={props.data.unit}
        aria-hidden="true"
        focusable="false"
      >
        <line
          className={styles.chartAxis}
          x1={CHART_LEFT}
          x2={CHART_LEFT}
          y1={CHART_TOP}
          y2={CHART_TOP + height}
        />
        <line
          className={styles.chartAxis}
          x1={CHART_LEFT}
          x2={CHART_LEFT + width}
          y1={CHART_TOP + height}
          y2={CHART_TOP + height}
        />
        {props.data.buckets.map((bucket, index) => {
          const x = CHART_LEFT + ((bucket.lower - axisMinimum) / axisSpan) * width;
          const barWidth = Math.max(1, ((bucket.upper - bucket.lower) / axisSpan) * width - 1);
          const barHeight = (bucket.seconds / maximumSeconds) * height;
          return (
            <rect
              key={`${bucket.lower}-${bucket.upper}-${index}`}
              className={styles.distributionBar}
              x={x}
              y={CHART_TOP + height - barHeight}
              width={barWidth}
              height={barHeight}
              rx="2"
            />
          );
        })}
        <text className={styles.chartTick} x={CHART_LEFT} y={CHART_HEIGHT - 10}>
          {format.number(Math.round(axisMinimum), { useGrouping: false })}
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT + width}
          y={CHART_HEIGHT - 10}
          textAnchor="end"
        >
          {axisValue(axisMaximum, props.data.unit, phrasebook)}
        </text>
        <text className={styles.chartTick} x={CHART_LEFT - 8} y={CHART_TOP + 5} textAnchor="end">
          {formatDuration(maximumSeconds, phrasebook)}
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT - 8}
          y={CHART_TOP + height}
          textAnchor="end"
        >
          {format.number(0)}
        </text>
      </svg>
      <figcaption>
        {say(
          props.data.unit === "watts"
            ? "training.response.distributionAxisPower"
            : "training.response.distributionAxisHeartRate",
        )}
      </figcaption>
      <details className={styles.analysisTableDisclosure}>
        <summary>
          {say("training.response.distributionTable", {
            label: props.label.toLocaleLowerCase(phrasebook.locale),
          })}
        </summary>
        <div className={styles.analysisTableScroller}>
          <table className={styles.analysisDataTable}>
            <caption className={styles.srOnly}>
              {say("training.response.distributionCaption", { label: props.label })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{say("training.response.rangeHeading")}</th>
                <th scope="col">{say("training.response.rideTime")}</th>
              </tr>
            </thead>
            <tbody>
              {props.data.buckets.map((bucket, index) => (
                <tr key={`${bucket.lower}-${bucket.upper}-${index}`}>
                  <th scope="row">
                    {say("training.response.range", {
                      lower: axisValue(bucket.lower, props.data.unit, phrasebook),
                      upper: axisValue(bucket.upper, props.data.unit, phrasebook),
                    })}
                  </th>
                  <td>{formatDuration(bucket.seconds, phrasebook)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function DistributionEvidence(props: {
  readonly data: ActivityAnalysisData["powerDistribution"];
  readonly label: string;
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly failed: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["powerDistribution"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  return (
    <>
      <EvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        failed={props.failed}
        refreshFailure={props.refreshFailure}
      />
      <p className={styles.analysisSource}>
        {say("training.response.distributionSummary", {
          count: props.data.buckets.length,
          duration: formatDuration(props.data.totalSeconds, phrasebook),
          value: format.number(props.data.buckets.length, { useGrouping: false }),
        })}
      </p>
      <DistributionChart data={props.data} label={props.label} />
    </>
  );
}

function DistributionPanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly sectionName: "power-distribution" | "heart-rate-distribution";
  readonly resultKey: "powerDistribution" | "heartRateDistribution";
  readonly title: string;
  readonly intro: string;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections[props.resultKey] : undefined;
  const refreshing = matches && props.analysis.loadingSections.includes(props.sectionName);
  const failed = matches && props.analysis.failedSections.includes(props.sectionName);
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <DistributionEvidence
        data={section.data}
        label={props.title}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        failed={failed}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <DistributionEvidence
        data={section.lastGood.data}
        label={props.title}
        saved
        refreshing={false}
        failed={false}
        refreshFailure={section.refreshFailure}
      />
    );
  } else if (section?.kind === "unavailable") {
    content = (
      <AnalysisRetry
        reason={section.reason}
        fallback={say("training.response.distributionUnavailable", { title: props.title })}
        onRefresh={props.onRefresh}
      />
    );
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback={say("training.response.distributionUnavailable", { title: props.title })}
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        {say("training.response.distributionLoading", {
          title: props.title.toLocaleLowerCase(phrasebook.locale),
        })}
      </p>
    );
  }
  const titleId = `${props.resultKey}-title`;
  return (
    <section className={styles.analysisPanel} aria-labelledby={titleId}>
      <p className={styles.rideEyebrow}>{say("training.response.measuredTime")}</p>
      <h2 id={titleId} className={styles.analysisTitle}>
        {props.title}
      </h2>
      <p className={styles.analysisIntro}>{props.intro}</p>
      {content}
    </section>
  );
}

function ScatterChart(props: {
  readonly data: ActivityAnalysisData["powerHeartRate"];
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const watts = props.data.rows.map((row) => row.watts);
  const heartRates = props.data.rows.map((row) => row.heartRateBpm);
  const minimumWatts = Math.min(...watts);
  const maximumWatts = Math.max(...watts);
  const minimumHeartRate = Math.min(...heartRates);
  const maximumHeartRate = Math.max(...heartRates);
  const wattsSpan = Math.max(maximumWatts - minimumWatts, 1);
  const heartRateSpan = Math.max(maximumHeartRate - minimumHeartRate, 1);
  const width = CHART_WIDTH - CHART_LEFT - CHART_RIGHT;
  const height = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
  return (
    <figure className={styles.responseFigure}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className={styles.responseChart}
        aria-hidden="true"
        focusable="false"
      >
        <line
          className={styles.chartAxis}
          x1={CHART_LEFT}
          x2={CHART_LEFT}
          y1={CHART_TOP}
          y2={CHART_TOP + height}
        />
        <line
          className={styles.chartAxis}
          x1={CHART_LEFT}
          x2={CHART_LEFT + width}
          y1={CHART_TOP + height}
          y2={CHART_TOP + height}
        />
        {props.data.rows.map((row, index) => {
          const x = CHART_LEFT + ((row.watts - minimumWatts) / wattsSpan) * width;
          const y =
            CHART_TOP + height - ((row.heartRateBpm - minimumHeartRate) / heartRateSpan) * height;
          return (
            <circle
              key={`${row.startSeconds}-${index}`}
              className={styles.responsePoint}
              cx={x}
              cy={y}
              r="4"
            />
          );
        })}
        <text className={styles.chartTick} x={CHART_LEFT} y={CHART_HEIGHT - 10}>
          {say("training.response.measurement", {
            value: format.number(Math.round(minimumWatts), { useGrouping: false }),
            unit: "W",
          })}
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT + width}
          y={CHART_HEIGHT - 10}
          textAnchor="end"
        >
          {say("training.response.measurement", {
            value: format.number(Math.round(maximumWatts), { useGrouping: false }),
            unit: "W",
          })}
        </text>
        <text className={styles.chartTick} x={CHART_LEFT - 8} y={CHART_TOP + 5} textAnchor="end">
          {format.number(Math.round(maximumHeartRate), { useGrouping: false })}
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT - 8}
          y={CHART_TOP + height}
          textAnchor="end"
        >
          {say("training.response.measurement", {
            value: format.number(Math.round(minimumHeartRate), { useGrouping: false }),
            unit: "bpm",
          })}
        </text>
      </svg>
      <figcaption>{say("training.response.scatterDescription")}</figcaption>
      <details className={styles.analysisTableDisclosure}>
        <summary>{say("training.response.scatterTable")}</summary>
        <div className={styles.analysisTableScroller}>
          <table className={styles.analysisDataTable}>
            <caption className={styles.srOnly}>{say("training.response.scatterCaption")}</caption>
            <thead>
              <tr>
                <th scope="col">{say("training.response.rideTime")}</th>
                <th scope="col">{say("training.response.power")}</th>
                <th scope="col">{say("training.response.heartRate")}</th>
                <th scope="col">{say("training.response.cadence")}</th>
                <th scope="col">{say("training.response.segment")}</th>
              </tr>
            </thead>
            <tbody>
              {props.data.rows.map((row, index) => (
                <tr key={`${row.startSeconds}-${index}`}>
                  <th scope="row">{formatDuration(row.startSeconds, phrasebook)}</th>
                  <td>
                    {say("training.response.measurement", {
                      value: format.number(Math.round(row.watts), { useGrouping: false }),
                      unit: "W",
                    })}
                  </td>
                  <td>
                    {say("training.response.measurement", {
                      value: format.number(Math.round(row.heartRateBpm), { useGrouping: false }),
                      unit: "bpm",
                    })}
                  </td>
                  <td>
                    {row.cadenceRpm === null
                      ? say("training.response.unavailable")
                      : say("training.response.measurement", {
                          value: format.number(Math.round(row.cadenceRpm), { useGrouping: false }),
                          unit: "rpm",
                        })}
                  </td>
                  <td>{formatDuration(row.movingSeconds ?? row.seconds, phrasebook)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function ProviderCurveFits(props: {
  readonly curves: ActivityAnalysisData["powerHeartRate"]["curves"];
}): ReactElement | null {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  if (props.curves.length === 0) return null;
  return (
    <section className={styles.responseFits} aria-labelledby="provider-fits-title">
      <h3 id="provider-fits-title" className={styles.responseFitsTitle}>
        {say("training.response.fitsTitle")}
      </h3>
      <ul className={styles.responseFitList} aria-label={say("training.response.fitsTitle")}>
        {props.curves.map((curve, index) => (
          <li
            key={`${curve.kind}-${index}`}
            className={styles.responseFitItem}
            data-curve-kind={curve.kind}
          >
            <span className={styles.responseFitLine} aria-hidden="true" />
            <span>
              <strong>{curveLabel(curve.kind, phrasebook)}</strong>
              <span>
                {curve.rSquared === null
                  ? say("training.response.fitQualityUnavailable")
                  : say("training.response.fitQualityValue", {
                      value: format.number(Number(curve.rSquared.toFixed(2)), {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                        useGrouping: false,
                      }),
                    })}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.responseFitNote}>{say("training.response.fitDescription")}</p>
      <details className={styles.analysisTableDisclosure}>
        <summary>{say("training.response.fitDetails")}</summary>
        <div className={styles.analysisTableScroller}>
          <table className={styles.analysisDataTable}>
            <caption className={styles.srOnly}>{say("training.response.fitCaption")}</caption>
            <thead>
              <tr>
                <th scope="col">{say("training.response.fitScope")}</th>
                <th scope="col">{say("training.response.fitQuality")}</th>
                <th scope="col">{say("training.response.fitTerms")}</th>
              </tr>
            </thead>
            <tbody>
              {props.curves.map((curve, index) => (
                <tr key={`${curve.kind}-${index}`}>
                  <th scope="row">{curveLabel(curve.kind, phrasebook)}</th>
                  <td>
                    {curve.rSquared === null
                      ? say("training.response.unavailable")
                      : say("training.response.fitQualityValue", {
                          value: format.number(Number(curve.rSquared.toFixed(2)), {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                            useGrouping: false,
                          }),
                        })}
                  </td>
                  <td>
                    {curve.coefficients
                      .map((value) => format.number(value, { maximumSignificantDigits: 8 }))
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function PowerHeartRateEvidence(props: {
  readonly data: ActivityAnalysisData["powerHeartRate"];
  readonly saved: boolean;
  readonly refreshing: boolean;
  readonly failed: boolean;
  readonly refreshFailure?: Extract<
    AnalysisSection<ActivityAnalysisData["powerHeartRate"]>,
    { readonly kind: "stale" }
  >["refreshFailure"];
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const coverage = Math.round(props.data.coverageFraction * 100);
  return (
    <>
      <EvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        failed={props.failed}
        refreshFailure={props.refreshFailure}
      />
      <div className={styles.responseSummary}>
        <div>
          <p className={styles.responseValue}>
            {format.number(props.data.rows.length, { useGrouping: false })}
          </p>
          <p>{say("training.response.retainedSegments")}</p>
        </div>
        <div>
          <p className={styles.responseValue}>
            {say("training.response.percent", {
              value: format.number(coverage, { useGrouping: false }),
            })}
          </p>
          <p>{say("training.response.rideCoverage")}</p>
        </div>
        <span className={styles.responseCoverage} data-limited={coverage < 80}>
          {coverage < 80
            ? say("training.response.limitedCoverage")
            : say("training.response.strongCoverage")}
        </span>
      </div>
      <dl className={styles.responseMeta}>
        <div>
          <dt>{say("training.response.lagAdjustment")}</dt>
          <dd>
            {props.data.heartRateLagSeconds === null
              ? say("training.response.lagDurationUnavailable")
              : formatDuration(props.data.heartRateLagSeconds, phrasebook)}
          </dd>
        </div>
        <div>
          <dt>{say("training.response.warmupExcluded")}</dt>
          <dd>
            {props.data.warmupSeconds === null
              ? say("training.response.unavailable")
              : formatDuration(props.data.warmupSeconds, phrasebook)}
          </dd>
        </div>
        <div>
          <dt>{say("training.response.cooldownExcluded")}</dt>
          <dd>
            {props.data.cooldownSeconds === null
              ? say("training.response.unavailable")
              : formatDuration(props.data.cooldownSeconds, phrasebook)}
          </dd>
        </div>
      </dl>
      <ProviderCurveFits curves={props.data.curves} />
      <ScatterChart data={props.data} />
    </>
  );
}

function PowerHeartRatePanel(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly onRefresh: (() => void) | null;
}): ReactElement {
  const { say } = usePhrasebook();
  const matches = props.analysis.activityId === props.rideId;
  const section = matches ? props.analysis.sections.powerHeartRate : undefined;
  const refreshing = matches && props.analysis.loadingSections.includes("power-heart-rate");
  const failed = matches && props.analysis.failedSections.includes("power-heart-rate");
  let content: ReactElement;
  if (section?.kind === "computed") {
    content = (
      <PowerHeartRateEvidence
        data={section.data}
        saved={section.provenance.delivery === "persisted-cache"}
        refreshing={refreshing}
        failed={failed}
      />
    );
  } else if (section?.kind === "stale") {
    content = (
      <PowerHeartRateEvidence
        data={section.lastGood.data}
        saved
        refreshing={false}
        failed={false}
        refreshFailure={section.refreshFailure}
      />
    );
  } else if (section?.kind === "unavailable") {
    content = (
      <AnalysisRetry
        reason={section.reason}
        fallback={say("training.response.responseUnavailable")}
        onRefresh={props.onRefresh}
      />
    );
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback={say("training.response.responseUnavailable")}
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        {say("training.response.responseLoading")}
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="power-heart-rate-title">
      <p className={styles.rideEyebrow}>{say("training.response.responseEyebrow")}</p>
      <h2 id="power-heart-rate-title" className={styles.analysisTitle}>
        {say("training.response.responseTitle")}
      </h2>
      <p className={styles.analysisIntro}>
        {say("training.response.responseIntro", { provider: "intervals.icu" })}
      </p>
      {content}
    </section>
  );
}

export function RideResponseReview(props: {
  readonly rideId: string;
  readonly analysis: RideAnalysisViewState;
  readonly onRefresh: ((sections: readonly ActivityAnalysisSection[]) => void) | null;
}): ReactElement {
  const { say } = usePhrasebook();
  const refresh = (section: ActivityAnalysisSection): (() => void) | null =>
    props.onRefresh === null ? null : () => props.onRefresh?.([section]);
  return (
    <>
      <DistributionPanel
        rideId={props.rideId}
        analysis={props.analysis}
        sectionName="power-distribution"
        resultKey="powerDistribution"
        title={say("training.response.powerDistributionTitle")}
        intro={say("training.response.powerDistributionIntro")}
        onRefresh={refresh("power-distribution")}
      />
      <DistributionPanel
        rideId={props.rideId}
        analysis={props.analysis}
        sectionName="heart-rate-distribution"
        resultKey="heartRateDistribution"
        title={say("training.response.heartRateDistributionTitle")}
        intro={say("training.response.heartRateDistributionIntro")}
        onRefresh={refresh("heart-rate-distribution")}
      />
      <PowerHeartRatePanel
        rideId={props.rideId}
        analysis={props.analysis}
        onRefresh={refresh("power-heart-rate")}
      />
    </>
  );
}
