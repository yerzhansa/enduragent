import type { PlanCalendarPlan } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { cn } from "@enduragent/ui";
import type { ReactElement } from "react";
import { raceWeek, seasonPhases, seasonWeeks } from "../../calendar/grid";
import { useCalendarText } from "./calendar-text";

const BAR_HEIGHT = 22;

export function SeasonStrip(props: {
  readonly plan: PlanCalendarPlan;
  readonly onWeek: (startDateKey: number) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const weeks = seasonWeeks(props.plan);
  const longest = Math.max(
    1,
    ...weeks.flatMap((week) => week.bars.map((bar) => Math.max(bar.plannedS, bar.doneS))),
  );
  const phases = seasonPhases(props.plan);
  const race = raceWeek(props.plan);
  const columns = { gridTemplateColumns: `repeat(${props.plan.totalWeeks}, minmax(0, 1fr))` };
  return (
    <div className="flex flex-col gap-1" data-season-strip="">
      {phases.length === 0 && race === null ? null : (
        <div className="grid gap-0.75" style={columns}>
          {phases.map((phase) => (
            <span
              key={`${phase.firstWeek}-${phase.text}`}
              className="truncate border-b-2 border-line-2 pb-0.5 text-xs font-semibold text-ink-2"
              style={{ gridColumn: `${phase.firstWeek} / ${phase.lastWeek + 1}`, gridRow: 1 }}
            >
              {phase.text}
            </span>
          ))}
          {race === null || props.plan.targetDateKey === null ? null : (
            <span
              className="truncate border-b-2 border-line-2 pb-0.5 text-right text-xs font-semibold text-ink-2"
              style={{
                gridColumn: `${race} / ${race + 1}`,
                gridRow: phases.some((phase) => race >= phase.firstWeek && race <= phase.lastWeek)
                  ? 2
                  : 1,
              }}
            >
              {say("plan.calendar.season.race", { date: text.dayMonth(props.plan.targetDateKey) })}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-0.75" style={columns}>
        {weeks.map((entry) => (
          <button
            key={entry.week.index}
            type="button"
            className={cn(
              "flex h-7.5 items-end gap-0.5 rounded-ctl px-1 py-0.75",
              entry.sent === "on-intervals"
                ? "border border-line bg-surface"
                : "border border-dashed border-line-2 bg-transparent",
              entry.current && "outline-2 outline-offset-1 outline-brand",
            )}
            aria-label={say("plan.calendar.season.week", {
              week: entry.week.index,
              range: text.weekRange(entry.week.startDateKey, entry.week.endDateKey),
            })}
            aria-current={entry.current ? "date" : undefined}
            onClick={() => props.onWeek(entry.week.startDateKey)}
          >
            {entry.bars.map((bar) => (
              <i
                key={bar.workoutId}
                className={cn(
                  "block w-1.75 rounded-chip",
                  bar.doneS > 0 ? "bg-brand" : "border border-line-2",
                )}
                style={{
                  height: Math.max(
                    3,
                    Math.round((BAR_HEIGHT * Math.max(bar.plannedS, bar.doneS)) / longest),
                  ),
                }}
              />
            ))}
          </button>
        ))}
      </div>
      <div className="grid gap-0.75" style={columns}>
        {weeks.map((entry) => (
          <span key={entry.week.index} className="truncate text-center text-xs text-ink-2">
            {text.dayMonth(entry.week.startDateKey)}
          </span>
        ))}
      </div>
    </div>
  );
}
