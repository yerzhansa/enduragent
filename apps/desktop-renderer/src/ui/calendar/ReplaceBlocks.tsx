import type { PlanCalendarEndingWorkout, PlanCalendarReplacing } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { ReactElement } from "react";
import type { CalendarText } from "./calendar-text";

export const SHEET_ROW =
  "grid grid-cols-[56px_minmax(0,1fr)_auto] gap-2 border-t border-line px-2.5 py-1.5 text-sm";

function Block(props: {
  readonly header: string;
  readonly children: ReactElement | readonly ReactElement[];
  readonly marker: string;
}): ReactElement {
  return (
    <div
      className="shrink-0 overflow-hidden rounded-card border border-line"
      data-replace-block={props.marker}
    >
      <div className="bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-ink-2">
        {props.header}
      </div>
      {props.children}
    </div>
  );
}

export function ComesOff(props: {
  readonly planName: string;
  readonly workouts: readonly PlanCalendarEndingWorkout[];
  readonly text: CalendarText;
}): ReactElement | null {
  const { say } = usePhrasebook();
  if (props.workouts.length === 0) return null;
  return (
    <Block
      marker="comes-off"
      header={say("plan.calendar.approve.replace.offHeader", {
        old: props.planName,
        count: props.workouts.length,
      })}
    >
      {props.workouts.map((workout) => (
        <div key={workout.planWorkoutId} className={SHEET_ROW}>
          <span className="text-ink-2">{props.text.weekdayDay(workout.dateKey)}</span>
          <span className="text-ink-2 line-through">{workout.name}</span>
          <span className="text-ink-2">
            {workout.durationS === null ? "" : props.text.duration(workout.durationS)}
          </span>
        </div>
      ))}
    </Block>
  );
}

export function StaysOn(props: {
  readonly replacing: PlanCalendarReplacing;
  readonly removeChanges: boolean;
  readonly choosing: "open" | "locked" | "hidden";
  readonly onRemoveChanges: (remove: boolean) => void;
  readonly text: CalendarText;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const changes = props.replacing.athleteChanges;
  const kept = props.removeChanges ? [] : changes;
  const box = props.choosing !== "hidden" && changes.length > 0;
  if (props.replacing.staysToday.length + kept.length === 0 && !box) return null;
  const row = (workout: PlanCalendarEndingWorkout, label: string) => (
    <div key={`${label}:${workout.planWorkoutId}`} className={SHEET_ROW}>
      <span className="text-ink-2">{props.text.weekdayDay(workout.dateKey)}</span>
      <span>{label}</span>
      <span className="text-ink-2">
        {workout.durationS === null ? "" : props.text.duration(workout.durationS)}
      </span>
    </div>
  );
  return (
    <Block marker="stays" header={say("plan.calendar.approve.replace.staysHeader")}>
      {[
        ...props.replacing.staysToday.map((workout) =>
          row(workout, say("plan.calendar.approve.replace.staysToday", { name: workout.name })),
        ),
        ...kept.map((workout) =>
          row(workout, say("plan.calendar.approve.replace.staysChanged", { name: workout.name })),
        ),
        ...(box
          ? [
              <label
                key="remove-changes"
                className="flex items-start gap-2 border-t border-line px-2.5 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-danger"
                  checked={props.removeChanges}
                  disabled={props.choosing === "locked"}
                  onChange={(event) => props.onRemoveChanges(event.currentTarget.checked)}
                />
                {say("plan.calendar.approve.replace.removeChanges", { count: changes.length })}
              </label>,
            ]
          : []),
      ]}
    </Block>
  );
}
