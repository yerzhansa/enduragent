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
  return (
    <div className={styles.analysisUnavailable}>
      <p>{props.reason === null ? props.fallback : analysisUnavailableCopy(props.reason)}</p>
      {props.onRefresh !== null && (props.reason === null || offerRetry(props.reason)) ? (
        <Button type="button" variant="outline" onClick={props.onRefresh}>
          Try again
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
  const notice =
    props.refreshFailure !== undefined
      ? `Showing the saved result. ${analysisRefreshFailureCopy(props.refreshFailure.code)}`
      : props.failed
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

function formatDuration(seconds: number): string {
  const roundedMinutes = Math.round(seconds / 60);
  if (roundedMinutes < 1) return `${Math.round(seconds)} sec`;
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

function axisValue(value: number, unit: ActivityAnalysisData["powerDistribution"]["unit"]): string {
  return `${Math.round(value)} ${unit === "watts" ? "W" : "bpm"}`;
}

function curveLabel(
  kind: ActivityAnalysisData["powerHeartRate"]["curves"][number]["kind"],
): string {
  if (kind === "all") return "All retained segments";
  if (kind === "zone-2") return "Zone 2 segments";
  return "Other provider fit";
}

function formatCoefficient(value: number): string {
  return value.toLocaleString("en-US", { maximumSignificantDigits: 8 });
}

function DistributionChart(props: {
  readonly data: ActivityAnalysisData["powerDistribution"];
  readonly label: string;
}): ReactElement {
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
          {Math.round(axisMinimum)}
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT + width}
          y={CHART_HEIGHT - 10}
          textAnchor="end"
        >
          {Math.round(axisMaximum)} {props.data.unit === "watts" ? "W" : "bpm"}
        </text>
        <text className={styles.chartTick} x={CHART_LEFT - 8} y={CHART_TOP + 5} textAnchor="end">
          {formatDuration(maximumSeconds)}
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT - 8}
          y={CHART_TOP + height}
          textAnchor="end"
        >
          0
        </text>
      </svg>
      <figcaption>
        Horizontal position is {props.data.unit === "watts" ? "power" : "heart rate"}; bar height is
        accumulated ride time. Gaps are left as recorded.
      </figcaption>
      <details className={styles.analysisTableDisclosure}>
        <summary>Read {props.label.toLowerCase()} as a table</summary>
        <div className={styles.analysisTableScroller}>
          <table className={styles.analysisDataTable}>
            <caption className={styles.srOnly}>
              {props.label} measured ride time by recorded range
            </caption>
            <thead>
              <tr>
                <th scope="col">Range</th>
                <th scope="col">Ride time</th>
              </tr>
            </thead>
            <tbody>
              {props.data.buckets.map((bucket, index) => (
                <tr key={`${bucket.lower}-${bucket.upper}-${index}`}>
                  <th scope="row">
                    {axisValue(bucket.lower, props.data.unit)}–
                    {axisValue(bucket.upper, props.data.unit)}
                  </th>
                  <td>{formatDuration(bucket.seconds)}</td>
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
  return (
    <>
      <EvidenceStatus
        saved={props.saved}
        refreshing={props.refreshing}
        failed={props.failed}
        refreshFailure={props.refreshFailure}
      />
      <p className={styles.analysisSource}>
        {formatDuration(props.data.totalSeconds)} of measured ride time ·{" "}
        {props.data.buckets.length} recorded buckets
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
        fallback={`${props.title} could not be loaded right now.`}
        onRefresh={props.onRefresh}
      />
    );
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback={`${props.title} could not be loaded right now.`}
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking {props.title.toLowerCase()}…
      </p>
    );
  }
  const titleId = `${props.resultKey}-title`;
  return (
    <section className={styles.analysisPanel} aria-labelledby={titleId}>
      <p className={styles.rideEyebrow}>Measured ride time</p>
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
          {Math.round(minimumWatts)} W
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT + width}
          y={CHART_HEIGHT - 10}
          textAnchor="end"
        >
          {Math.round(maximumWatts)} W
        </text>
        <text className={styles.chartTick} x={CHART_LEFT - 8} y={CHART_TOP + 5} textAnchor="end">
          {Math.round(maximumHeartRate)}
        </text>
        <text
          className={styles.chartTick}
          x={CHART_LEFT - 8}
          y={CHART_TOP + height}
          textAnchor="end"
        >
          {Math.round(minimumHeartRate)} bpm
        </text>
      </svg>
      <figcaption>
        Each dot is one retained server-cleaned ride segment: power is horizontal and lag-adjusted
        heart rate is vertical. No missing points or lines are interpolated.
      </figcaption>
      <details className={styles.analysisTableDisclosure}>
        <summary>Read all power and heart-rate points as a table</summary>
        <div className={styles.analysisTableScroller}>
          <table className={styles.analysisDataTable}>
            <caption className={styles.srOnly}>Retained power and heart-rate ride segments</caption>
            <thead>
              <tr>
                <th scope="col">Ride time</th>
                <th scope="col">Power</th>
                <th scope="col">Heart rate</th>
                <th scope="col">Cadence</th>
                <th scope="col">Segment</th>
              </tr>
            </thead>
            <tbody>
              {props.data.rows.map((row, index) => (
                <tr key={`${row.startSeconds}-${index}`}>
                  <th scope="row">{formatDuration(row.startSeconds)}</th>
                  <td>{Math.round(row.watts)} W</td>
                  <td>{Math.round(row.heartRateBpm)} bpm</td>
                  <td>
                    {row.cadenceRpm === null ? "Unavailable" : `${Math.round(row.cadenceRpm)} rpm`}
                  </td>
                  <td>{formatDuration(row.movingSeconds ?? row.seconds)}</td>
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
  if (props.curves.length === 0) return null;
  return (
    <section className={styles.responseFits} aria-labelledby="provider-fits-title">
      <h3 id="provider-fits-title" className={styles.responseFitsTitle}>
        Provider fitted curves
      </h3>
      <ul className={styles.responseFitList} aria-label="Provider fitted curves">
        {props.curves.map((curve, index) => (
          <li
            key={`${curve.kind}-${index}`}
            className={styles.responseFitItem}
            data-curve-kind={curve.kind}
          >
            <span className={styles.responseFitLine} aria-hidden="true" />
            <span>
              <strong>{curveLabel(curve.kind)}</strong>
              <span>
                {curve.rSquared === null ? "R² unavailable" : `R² ${curve.rSquared.toFixed(2)}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.responseFitNote}>
        Fit quality and model terms are supplied by the provider. The desktop does not infer a model
        equation.
      </p>
      <details className={styles.analysisTableDisclosure}>
        <summary>Read provider fit details</summary>
        <div className={styles.analysisTableScroller}>
          <table className={styles.analysisDataTable}>
            <caption className={styles.srOnly}>
              Provider-fitted power and heart-rate curve details
            </caption>
            <thead>
              <tr>
                <th scope="col">Fit scope</th>
                <th scope="col">Fit quality</th>
                <th scope="col">Model terms in provider order</th>
              </tr>
            </thead>
            <tbody>
              {props.curves.map((curve, index) => (
                <tr key={`${curve.kind}-${index}`}>
                  <th scope="row">{curveLabel(curve.kind)}</th>
                  <td>
                    {curve.rSquared === null ? "Unavailable" : `R² ${curve.rSquared.toFixed(2)}`}
                  </td>
                  <td>{curve.coefficients.map(formatCoefficient).join(", ")}</td>
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
          <p className={styles.responseValue}>{props.data.rows.length}</p>
          <p>retained segments</p>
        </div>
        <div>
          <p className={styles.responseValue}>{coverage}%</p>
          <p>ride coverage</p>
        </div>
        <span className={styles.responseCoverage} data-limited={coverage < 80}>
          {coverage < 80 ? "Limited coverage" : "Strong coverage"}
        </span>
      </div>
      <dl className={styles.responseMeta}>
        <div>
          <dt>HR lag adjustment</dt>
          <dd>
            {props.data.heartRateLagSeconds === null
              ? "Applied by server; duration unavailable"
              : formatDuration(props.data.heartRateLagSeconds)}
          </dd>
        </div>
        <div>
          <dt>Warm-up excluded</dt>
          <dd>
            {props.data.warmupSeconds === null
              ? "Unavailable"
              : formatDuration(props.data.warmupSeconds)}
          </dd>
        </div>
        <div>
          <dt>Cool-down excluded</dt>
          <dd>
            {props.data.cooldownSeconds === null
              ? "Unavailable"
              : formatDuration(props.data.cooldownSeconds)}
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
        fallback="Power and heart-rate response could not be loaded right now."
        onRefresh={props.onRefresh}
      />
    );
  } else if (failed) {
    content = (
      <AnalysisRetry
        reason={null}
        fallback="Power and heart-rate response could not be loaded right now."
        onRefresh={props.onRefresh}
      />
    );
  } else {
    content = (
      <p className={styles.analysisLoading} role="status">
        Checking the power and heart-rate response…
      </p>
    );
  }
  return (
    <section className={styles.analysisPanel} aria-labelledby="power-heart-rate-title">
      <p className={styles.rideEyebrow}>Server-produced relationship</p>
      <h2 id="power-heart-rate-title" className={styles.analysisTitle}>
        Power and heart-rate response
      </h2>
      <p className={styles.analysisIntro}>
        Shows intervals.icu's cleaned, lag-adjusted relationship for this ride. It is separate from
        the local aerobic drift estimate and does not prescribe training on its own.
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
  const refresh = (section: ActivityAnalysisSection): (() => void) | null =>
    props.onRefresh === null ? null : () => props.onRefresh?.([section]);
  return (
    <>
      <DistributionPanel
        rideId={props.rideId}
        analysis={props.analysis}
        sectionName="power-distribution"
        resultKey="powerDistribution"
        title="Power distribution"
        intro="Shows how much measured ride time fell inside each recorded power range. Missing ranges are not filled with zeros."
        onRefresh={refresh("power-distribution")}
      />
      <DistributionPanel
        rideId={props.rideId}
        analysis={props.analysis}
        sectionName="heart-rate-distribution"
        resultKey="heartRateDistribution"
        title="Heart-rate distribution"
        intro="Shows how much measured ride time fell inside each recorded heart-rate range. It can load even when power data is unavailable."
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
