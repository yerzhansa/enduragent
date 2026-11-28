import type { PlanCalendarFtpRead } from "@enduragent/coach-contract";
import { addDays, daysBetween } from "../calendar/dates";

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface FtpChartModel {
  readonly startDateKey: number;
  readonly endDateKey: number;
  readonly steps: PlanCalendarFtpRead["chart"]["steps"];
  readonly stepPath: string | null;
  readonly changes: readonly ChartPoint[];
  readonly estimate: string | null;
  readonly proposed: (ChartPoint & { readonly watts: number }) | null;
  readonly ticks: readonly { readonly watts: number; readonly y: number }[];
  readonly months: readonly { readonly dateKey: number; readonly x: number }[];
}

export const CHART = Object.freeze({
  width: 600,
  height: 200,
  left: 50,
  right: 580,
  top: 30,
  bottom: 170,
});

function niceTicks(low: number, high: number): number[] {
  const step = high - low > 60 ? 20 : 10;
  const ticks: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high; value += step) ticks.push(value);
  return ticks.length > 3 ? [ticks[0] ?? low, ticks.at(-1) ?? high] : ticks;
}

export function ftpChart(read: PlanCalendarFtpRead): FtpChartModel {
  const { startDateKey, endDateKey, steps } = read.chart;
  const estimates = read.estimates.filter(
    (sample) => sample.dateKey >= startDateKey && sample.dateKey <= endDateKey,
  );
  const proposedWatts = read.proposal.kind === "none" ? null : read.proposal.watts;
  const values = [
    ...steps.flatMap((step) => (step.watts === null ? [] : [step.watts])),
    ...estimates.map((sample) => sample.watts),
    ...(proposedWatts === null ? [] : [proposedWatts]),
  ];
  const span = Math.max(daysBetween(startDateKey, endDateKey), 1);
  const x = (dateKey: number) =>
    CHART.left + (daysBetween(startDateKey, dateKey) / span) * (CHART.right - CHART.left);
  const low = values.length === 0 ? 0 : Math.min(...values) - 6;
  const high = values.length === 0 ? 1 : Math.max(...values) + 6;
  const y = (watts: number) =>
    CHART.bottom - ((watts - low) / Math.max(high - low, 1)) * (CHART.bottom - CHART.top);
  const segments: string[] = [];
  let drawing = false;
  for (const [index, step] of steps.entries()) {
    const nextDateKey = steps[index + 1]?.dateKey ?? endDateKey;
    if (step.watts === null) {
      drawing = false;
      continue;
    }
    segments.push(
      drawing
        ? `V${y(step.watts).toFixed(1)}`
        : `M${x(step.dateKey).toFixed(1)},${y(step.watts).toFixed(1)}`,
      `H${x(nextDateKey).toFixed(1)}`,
    );
    drawing = steps[index + 1]?.watts !== null;
  }
  const months: { dateKey: number; x: number }[] = [];
  for (let dateKey = startDateKey; dateKey <= endDateKey; dateKey = addDays(dateKey, 1)) {
    if (dateKey % 100 === 1) months.push({ dateKey, x: x(dateKey) });
  }
  return {
    startDateKey,
    endDateKey,
    steps,
    stepPath: segments.length === 0 ? null : segments.join(" "),
    changes: steps.flatMap((step) =>
      step.dateKey > startDateKey && step.watts !== null
        ? [{ x: x(step.dateKey), y: y(step.watts) }]
        : [],
    ),
    estimate:
      estimates.length < 2
        ? null
        : estimates
            .map((sample) => `${x(sample.dateKey).toFixed(1)},${y(sample.watts).toFixed(1)}`)
            .join(" "),
    proposed:
      proposedWatts === null
        ? null
        : { x: x(endDateKey), y: y(proposedWatts), watts: proposedWatts },
    ticks: niceTicks(low, high).map((watts) => ({ watts, y: y(watts) })),
    months,
  };
}
