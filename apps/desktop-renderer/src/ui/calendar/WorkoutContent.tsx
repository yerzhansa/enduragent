import type {
  PlanCalendarCurrentFtp,
  PlanWorkoutBlock,
  PlanWorkoutContent,
  PlanWorkoutStep,
  PlanWorkoutTarget,
} from "@enduragent/coach-contract";
import type { CatalogKey } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
import type { ReactElement } from "react";
import { useCalendarText, type CalendarText } from "./calendar-text";

type Phrasebook = ReturnType<typeof usePhrasebook>;

const ZONE: Readonly<Record<PlanWorkoutContent["zone"], CatalogKey>> = {
  recovery: "plan.calendar.workout.zone.recovery",
  endurance: "plan.calendar.workout.zone.endurance",
  "sweet-spot": "plan.calendar.workout.zone.sweetSpot",
};

const WHY: Readonly<Record<PlanWorkoutContent["why"], CatalogKey>> = {
  recover: "plan.calendar.workout.why.recover",
  "aerobic-base": "plan.calendar.workout.why.aerobicBase",
  endurance: "plan.calendar.workout.why.endurance",
  "sustained-power": "plan.calendar.workout.why.sustainedPower",
};

const PART: Readonly<Record<PlanWorkoutStep["part"], CatalogKey>> = {
  "warm-up": "plan.calendar.workout.part.warmUp",
  main: "plan.calendar.workout.part.main",
  interval: "plan.calendar.workout.part.interval",
  recovery: "plan.calendar.workout.part.recovery",
  "cool-down": "plan.calendar.workout.part.coolDown",
};

interface StepRow {
  readonly duration: string;
  readonly label: string;
  readonly target: string;
}

function whole(phrasebook: Phrasebook, value: number): string {
  return phrasebook.format.number(value, { useGrouping: false });
}

function percentText(phrasebook: Phrasebook, target: PlanWorkoutTarget): string {
  const { say } = phrasebook;
  switch (target.kind) {
    case "steady":
      return say("plan.calendar.workout.percent", { percent: whole(phrasebook, target.percent) });
    case "range":
      return say("plan.calendar.workout.percentRange", {
        low: whole(phrasebook, target.low),
        high: whole(phrasebook, target.high),
      });
    case "ramp":
      return say("plan.calendar.workout.percentRamp", {
        from: whole(phrasebook, target.from),
        to: whole(phrasebook, target.to),
      });
  }
}

function wattsText(phrasebook: Phrasebook, target: PlanWorkoutTarget, ftp: number): string {
  const { say } = phrasebook;
  const watts = (percent: number) => whole(phrasebook, Math.round((ftp * percent) / 100));
  switch (target.kind) {
    case "steady":
      return say("plan.calendar.workout.watts", { watts: watts(target.percent) });
    case "range":
      return say("plan.calendar.workout.wattsRange", {
        low: watts(target.low),
        high: watts(target.high),
      });
    case "ramp":
      return say("plan.calendar.workout.wattsRamp", {
        from: watts(target.from),
        to: watts(target.to),
      });
  }
}

function targetText(
  phrasebook: Phrasebook,
  target: PlanWorkoutTarget,
  ftp: PlanCalendarCurrentFtp | null,
): string {
  const percent = percentText(phrasebook, target);
  return ftp === null
    ? percent
    : phrasebook.say("plan.calendar.workout.targetWatts", {
        percent,
        watts: wattsText(phrasebook, target, ftp.watts),
      });
}

function stepRow(
  phrasebook: Phrasebook,
  text: CalendarText,
  block: PlanWorkoutBlock,
  ftp: PlanCalendarCurrentFtp | null,
): StepRow {
  if (block.kind === "step") {
    return {
      duration: text.duration(block.step.seconds),
      label: phrasebook.say(PART[block.step.part]),
      target: targetText(phrasebook, block.step.target, ftp),
    };
  }
  const [work, rest] = block.steps;
  return {
    duration: phrasebook.say("plan.calendar.workout.repeat", {
      times: whole(phrasebook, block.times),
      duration: text.duration(work.seconds),
    }),
    label: phrasebook.say("plan.calendar.workout.repeatDetail", {
      duration: text.duration(rest.seconds),
    }),
    target: targetText(phrasebook, work.target, ftp),
  };
}

export function WorkoutContentMeta(props: { readonly content: PlanWorkoutContent }): ReactElement {
  const phrasebook = usePhrasebook();
  return (
    <>
      <span data-workout-load="">
        {phrasebook.say("plan.calendar.workout.load", {
          load: whole(phrasebook, props.content.load),
        })}
      </span>
      <span data-workout-zone={props.content.zone}>{phrasebook.say(ZONE[props.content.zone])}</span>
    </>
  );
}

export function WorkoutContentDetail(props: {
  readonly content: PlanWorkoutContent;
  readonly ftp: PlanCalendarCurrentFtp | null;
}): ReactElement {
  const phrasebook = usePhrasebook();
  const text = useCalendarText();
  const { say } = phrasebook;
  const rows = props.content.blocks.map((block) => stepRow(phrasebook, text, block, props.ftp));
  return (
    <>
      <ul
        className="m-0 list-none overflow-hidden rounded-ctl border border-line p-0"
        aria-label={say("plan.calendar.workout.steps")}
        data-workout-steps=""
      >
        {rows.map((row, index) => (
          <li
            key={`${index}:${row.duration}:${row.label}`}
            className="grid grid-cols-[4rem_minmax(0,1fr)_auto] gap-2 border-t border-line px-3 py-1.75 text-sm first:border-t-0"
          >
            <span className="text-ink-2">{row.duration}</span>
            <span className="min-w-0 break-words text-ink">{row.label}</span>
            <span className="text-right text-ink tabular-nums">{row.target}</span>
          </li>
        ))}
      </ul>
      <p
        className="m-0 rounded-ctl border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2"
        data-workout-ftp={props.ftp === null ? "unknown" : "known"}
      >
        {props.ftp === null
          ? say("plan.calendar.workout.byFeel")
          : say("plan.calendar.workout.ftpLine", {
              watts: whole(phrasebook, props.ftp.watts),
            })}
      </p>
      <div className="flex flex-col gap-1" data-workout-why={props.content.why}>
        <h3 className="m-0 text-xs font-semibold text-ink">
          {say("plan.calendar.workout.whyTitle")}
        </h3>
        <p className="m-0 text-xs text-ink-2">{say(WHY[props.content.why])}</p>
      </div>
    </>
  );
}
