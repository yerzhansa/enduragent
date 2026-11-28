import type { PlanCalendarFtpRead } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { ReactElement } from "react";
import { CHART, ftpChart } from "../../activity-review/ftp-chart";
import { dateOf } from "../../calendar/dates";
import { useFtpText } from "./ftp-text";

export function FtpChart(props: { readonly read: PlanCalendarFtpRead }): ReactElement | null {
  const { say, format } = usePhrasebook();
  const text = useFtpText();
  const chart = ftpChart(props.read);
  if (chart.stepPath === null && chart.estimate === null) return null;
  const steps = chart.steps.map((step) => {
    if (step.watts === null)
      return say("activity.review.ftp.chartCleared", { date: text.dayMonth(step.dateKey) });
    if (step.source === "first-sync")
      return say("activity.review.ftp.chartFirstSync", { watts: text.watts(step.watts) });
    return say("activity.review.ftp.chartStep", {
      watts: text.watts(step.watts),
      date: text.dayMonth(step.dateKey),
    });
  });
  const label = say("activity.review.ftp.chartLabel", {
    start: text.dayMonth(chart.startDateKey),
    end: text.dayMonth(chart.endDateKey),
    steps:
      steps.length === 0
        ? say("activity.review.ftp.chartNoFtp")
        : format.list(steps, { type: "unit", style: "short" }),
  });
  return (
    <svg
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      className="block h-auto w-full overflow-visible"
      role="img"
      aria-label={
        chart.proposed === null
          ? label
          : `${label} ${say("activity.review.ftp.chartProposed", { watts: text.watts(chart.proposed.watts) })}`
      }
      data-ftp-chart=""
    >
      <line
        className="stroke-line [stroke-width:1]"
        x1={CHART.left}
        x2={CHART.right}
        y1={CHART.bottom}
        y2={CHART.bottom}
      />
      {chart.ticks.map((tick) => (
        <g key={tick.watts}>
          <line
            className="stroke-line [stroke-dasharray:2_4] [stroke-width:1]"
            x1={CHART.left}
            x2={CHART.right}
            y1={tick.y}
            y2={tick.y}
          />
          <text
            className="fill-ink-2 text-xs tabular-nums"
            x={CHART.left - 6}
            y={tick.y + 4}
            textAnchor="end"
          >
            {say("activity.review.ftp.chartWatts", { watts: text.watts(tick.watts) })}
          </text>
        </g>
      ))}
      {chart.estimate === null ? null : (
        <polyline
          className="fill-none stroke-ink-2 [stroke-dasharray:3_4] [stroke-width:1.5]"
          points={chart.estimate}
          data-ftp-estimate=""
        />
      )}
      {chart.stepPath === null ? null : (
        <path
          className="fill-none stroke-brand [stroke-linejoin:round] [stroke-width:3]"
          d={chart.stepPath}
          data-ftp-steps=""
        />
      )}
      {chart.changes.map((point) => (
        <circle
          key={`${point.x}-${point.y}`}
          className="fill-brand"
          cx={point.x}
          cy={point.y}
          r={4}
        />
      ))}
      {chart.proposed === null ? null : (
        <g data-ftp-proposed="">
          <circle
            className="fill-surface stroke-warn [stroke-width:2]"
            cx={chart.proposed.x}
            cy={chart.proposed.y}
            r={5}
          />
          <text
            className="fill-warn text-xs font-semibold"
            x={chart.proposed.x}
            y={CHART.top - 14}
            textAnchor="end"
          >
            {say("activity.review.ftp.chartProposed", { watts: text.watts(chart.proposed.watts) })}
          </text>
        </g>
      )}
      {chart.months.map((month) => (
        <text key={month.dateKey} className="fill-ink-2 text-xs" x={month.x} y={CHART.bottom + 18}>
          {format.date(dateOf(month.dateKey), { month: "short", timeZone: "UTC" })}
        </text>
      ))}
    </svg>
  );
}
