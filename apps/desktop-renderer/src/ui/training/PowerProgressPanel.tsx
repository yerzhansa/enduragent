import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { PowerProgressComputed, PowerProgressPanel } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import {
  POWER_PROGRESS_FRESHNESS_COPY,
  POWER_PROGRESS_REFRESH_FAILURE_COPY,
  POWER_PROGRESS_ROTATION_COPY,
  POWER_PROGRESS_UNAVAILABLE_COPY,
} from "./copy";
import { overviewStyles as styles } from "./overviewStyles";

function formatPowerDuration(durationSeconds: number, { say, format }: Phrasebook): string {
  return durationSeconds === 5 || ![60, 300, 1_200, 3_600].includes(durationSeconds)
    ? say("training.power.durationSeconds", {
        value: format.number(durationSeconds, { useGrouping: false }),
      })
    : say("training.power.durationMinutes", {
        value: format.number(durationSeconds / 60, { useGrouping: false }),
      });
}

function formatProgressChange(
  value: number,
  { say, format }: Phrasebook,
  magnitude = false,
): string {
  const rounded = Math.round((magnitude ? Math.abs(value) : value) * 10) / 10;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return say("training.power.percent", {
    value: format.number(normalized, {
      maximumFractionDigits: 1,
      useGrouping: false,
      signDisplay: magnitude ? "auto" : "exceptZero",
    }),
  });
}

function ProgressWatts(props: {
  readonly value:
    | { readonly kind: "computed"; readonly watts: number }
    | { readonly kind: "unavailable" };
}): ReactElement {
  const { say, format } = usePhrasebook();
  return props.value.kind === "computed" ? (
    <span>
      {say("training.power.watts", {
        value: format.number(Math.round(props.value.watts), { useGrouping: false }),
      })}
    </span>
  ) : (
    <span aria-label={say("training.power.unavailableMetric")}>—</span>
  );
}

function ProgressBpm(props: {
  readonly value:
    | { readonly kind: "computed"; readonly bpm: number }
    | { readonly kind: "unavailable" };
}): ReactElement {
  const { say, format } = usePhrasebook();
  return props.value.kind === "computed" ? (
    <span>
      {say("training.power.bpm", {
        value: format.number(Math.round(props.value.bpm), { useGrouping: false }),
      })}
    </span>
  ) : (
    <span aria-label={say("training.power.unavailableMetric")}>—</span>
  );
}

function ProgressChange(props: {
  readonly value:
    | { readonly kind: "computed"; readonly percent: number }
    | { readonly kind: "unavailable" };
}): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  if (props.value.kind === "unavailable")
    return <span aria-label={say("training.power.unavailableMetric")}>—</span>;
  const { percent } = props.value;
  const direction =
    percent > 0
      ? say("training.power.increased")
      : percent < 0
        ? say("training.power.decreased")
        : say("training.power.unchanged");
  const arrow = percent > 0 ? "↑" : percent < 0 ? "↓" : "→";
  const tone = percent > 0 ? "positive" : percent < 0 ? "negative" : "neutral";
  return (
    <span
      className={styles.progressChange}
      data-tone={tone}
      aria-label={say("training.power.changeLabel", {
        direction,
        value: formatProgressChange(percent, phrasebook, true),
      })}
    >
      <span aria-hidden="true">{arrow}</span> {formatProgressChange(percent, phrasebook)}
    </span>
  );
}

function PowerProgressTable(props: { readonly progress: PowerProgressComputed }): ReactElement {
  const phrasebook = usePhrasebook();
  const { say } = phrasebook;
  return (
    <div className={styles.progressTableWrap}>
      <table className={styles.progressTable}>
        <caption className={styles.srOnly}>{say("training.power.powerCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{say("training.power.effort")}</th>
            <th scope="col">{say("training.power.now")}</th>
            <th scope="col">{say("training.power.prior")}</th>
            <th scope="col">{say("training.power.change")}</th>
          </tr>
        </thead>
        <tbody>
          {props.progress.anchors.map((anchor) => (
            <tr key={anchor.durationSeconds}>
              <th scope="row">{formatPowerDuration(anchor.durationSeconds, phrasebook)}</th>
              <td>
                <ProgressWatts value={anchor.current} />
              </td>
              <td>
                <ProgressWatts value={anchor.previous} />
              </td>
              <td>
                <ProgressChange value={anchor.change} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeartRateProgress(props: { readonly progress: PowerProgressComputed }): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  if (props.progress.heartRateContext.kind === "unavailable") {
    return <p className={styles.support}>{say("training.power.heartRateUnavailable")}</p>;
  }
  return (
    <details className={styles.progressDetails}>
      <summary>
        {say("training.power.heartRateSummary", {
          count: props.progress.heartRateContext.anchors.length,
          value: format.number(props.progress.heartRateContext.anchors.length, {
            useGrouping: false,
          }),
        })}
      </summary>
      <div className={styles.progressTableWrap}>
        <table className={`${styles.progressTable} ${styles.heartRateTable}`}>
          <caption className={styles.srOnly}>{say("training.power.heartRateCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{say("training.power.effort")}</th>
              <th scope="col">{say("training.power.now")}</th>
              <th scope="col">{say("training.power.prior")}</th>
              <th scope="col">{say("training.power.change")}</th>
            </tr>
          </thead>
          <tbody>
            {props.progress.heartRateContext.anchors.map((anchor) => (
              <tr key={anchor.durationSeconds}>
                <th scope="row">{formatPowerDuration(anchor.durationSeconds, phrasebook)}</th>
                <td>
                  <ProgressBpm value={anchor.current} />
                </td>
                <td>
                  <ProgressBpm value={anchor.previous} />
                </td>
                <td>
                  <ProgressChange value={anchor.change} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function sustainabilityCopy(progress: PowerProgressComputed, { say, format }: Phrasebook): string {
  if (progress.sustainabilityContext.kind === "unavailable") {
    return say("training.power.durabilityUnavailable");
  }
  const source = {
    indoor: say("training.power.sourceIndoor"),
    outdoor: say("training.power.sourceOutdoor"),
    mixed: say("training.power.sourceMixed"),
    unknown: say("training.power.sourceUnknown"),
  }[progress.sustainabilityContext.sourceContext];
  return say("training.power.durabilitySummary", {
    coverage: format.number(Math.round(progress.sustainabilityContext.coverageRatio * 100), {
      useGrouping: false,
    }),
    source,
  });
}

export function PowerProgressContent(props: { readonly panel: PowerProgressPanel }): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  if (props.panel.kind === "unavailable") {
    return (
      <p className={styles.empty}>{say(POWER_PROGRESS_UNAVAILABLE_COPY[props.panel.reason])}</p>
    );
  }
  const progress = props.panel.kind === "stale" ? props.panel.lastGood : props.panel;
  return (
    <>
      {props.panel.kind === "stale" ? (
        <p className={styles.progressNotice}>
          {say("training.power.refreshNotice", {
            failure: say(POWER_PROGRESS_REFRESH_FAILURE_COPY[props.panel.refreshFailure.code]),
          })}
          <time dateTime={props.panel.refreshFailure.failedAt}>
            {format.date(new Date(props.panel.refreshFailure.failedAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
          {say("training.power.refreshNoticeEnd")}
        </p>
      ) : null}
      <div className={styles.progressHeader}>
        <div>
          <p className={styles.progressLead}>
            {say(POWER_PROGRESS_ROTATION_COPY[progress.rotation])}
          </p>
          <p className={styles.meta}>
            {say("training.power.windowComparison", {
              start: format.date(new Date(`${progress.currentWindow.start}T00:00:00Z`), {
                dateStyle: "medium",
                timeZone: "UTC",
              }),
              end: format.date(new Date(`${progress.currentWindow.end}T00:00:00Z`), {
                dateStyle: "medium",
                timeZone: "UTC",
              }),
            })}
          </p>
        </div>
        <p className={styles.badge} data-freshness={progress.freshness}>
          {say(POWER_PROGRESS_FRESHNESS_COPY[progress.freshness])}
        </p>
      </div>
      <PowerProgressTable progress={progress} />
      <HeartRateProgress progress={progress} />
      <p className={styles.progressFoot}>{sustainabilityCopy(progress, phrasebook)}</p>
    </>
  );
}
