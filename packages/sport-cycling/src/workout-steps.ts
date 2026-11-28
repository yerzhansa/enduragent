import type { WorkoutType } from "./templates.js";

export type StepSession = WorkoutType | "opener" | "race";

export const POWER_RANGE: Readonly<Record<StepSession, readonly [number, number]>> = Object.freeze({
  endurance: [0.56, 0.75],
  sweet_spot: [0.88, 0.94],
  threshold: [0.91, 1.05],
  long: [0.56, 0.75],
  recovery: [0.45, 0.54],
  opener: [0.91, 1.05],
  race: [0.65, 0.85],
});

export const WARM_UP_PERCENT = Object.freeze({ low: 45, high: 65 });
export const COOL_DOWN_PERCENT = 45;
export const SET_RECOVERY_PERCENT = 50;
export const SWEET_SPOT_SET = Object.freeze({ repeats: 3, recoveryMinutes: 3 });

export type WorkoutTarget =
  | { readonly kind: "steady"; readonly percent: number }
  | { readonly kind: "range"; readonly low: number; readonly high: number }
  | { readonly kind: "ramp"; readonly from: number; readonly to: number };

export interface WorkoutStep {
  readonly part: "warm-up" | "main" | "interval" | "recovery" | "cool-down";
  readonly seconds: number;
  readonly target: WorkoutTarget;
}

export type WorkoutBlock =
  | { readonly kind: "step"; readonly step: WorkoutStep }
  | {
      readonly kind: "repeat";
      readonly times: number;
      readonly steps: readonly [WorkoutStep, WorkoutStep];
    };

export interface WorkoutContent {
  readonly version: 1;
  readonly zone: "recovery" | "endurance" | "sweet-spot";
  readonly load: number;
  readonly why: "recover" | "aerobic-base" | "endurance" | "sustained-power";
  readonly blocks: readonly WorkoutBlock[];
}

export type ContentWorkoutKind = "hard" | "endurance" | "long" | "easy" | "event";

const SHORTEST_SWEET_SPOT_MINUTES = 25;
const SHORTEST_THREE_SET_MINUTES = 35;
const SHORTEST_EASY_WARM_UP_MINUTES = 15;
const EASY_WARM_UP_MINUTES = 5;

function percentRange(range: readonly [number, number]): WorkoutTarget {
  return { kind: "range", low: Math.round(range[0] * 100), high: Math.round(range[1] * 100) };
}

const WARM_UP: WorkoutTarget = { kind: "range", ...WARM_UP_PERCENT };
const COOL_DOWN: WorkoutTarget = { kind: "steady", percent: COOL_DOWN_PERCENT };
const ENDURANCE = percentRange(POWER_RANGE.endurance);
const RECOVERY = percentRange(POWER_RANGE.recovery);

function step(part: WorkoutStep["part"], minutes: number, target: WorkoutTarget): WorkoutBlock[] {
  return minutes <= 0 ? [] : [{ kind: "step", step: { part, seconds: minutes * 60, target } }];
}

function warmUpMinutes(minutes: number): number {
  return Math.min(10, Math.floor(minutes / 4));
}

function steadyRide(minutes: number): WorkoutBlock[] {
  const warmUp = warmUpMinutes(minutes);
  const coolDown = Math.min(10, Math.floor(minutes / 5));
  return [
    ...step("warm-up", warmUp, WARM_UP),
    ...step("main", minutes - warmUp - coolDown, ENDURANCE),
    ...step("cool-down", coolDown, COOL_DOWN),
  ];
}

function sweetSpotRide(minutes: number): WorkoutBlock[] {
  const warmUp = warmUpMinutes(minutes);
  const { recoveryMinutes } = SWEET_SPOT_SET;
  const repeats = minutes < SHORTEST_THREE_SET_MINUTES ? 2 : SWEET_SPOT_SET.repeats;
  const shortestCoolDown = Math.ceil((minutes * 15) / 100);
  const work = Math.floor((minutes - warmUp - shortestCoolDown) / repeats) - recoveryMinutes;
  return [
    ...step("warm-up", warmUp, WARM_UP),
    {
      kind: "repeat",
      times: repeats,
      steps: [
        { part: "interval", seconds: work * 60, target: percentRange(POWER_RANGE.sweet_spot) },
        {
          part: "recovery",
          seconds: recoveryMinutes * 60,
          target: { kind: "steady", percent: SET_RECOVERY_PERCENT },
        },
      ],
    },
    ...step("cool-down", minutes - warmUp - repeats * (work + recoveryMinutes), COOL_DOWN),
  ];
}

function easyRide(minutes: number): WorkoutBlock[] {
  return minutes < SHORTEST_EASY_WARM_UP_MINUTES
    ? step("main", minutes, RECOVERY)
    : [
        ...step("warm-up", EASY_WARM_UP_MINUTES, RECOVERY),
        ...step("main", minutes - EASY_WARM_UP_MINUTES, RECOVERY),
      ];
}

type Shape = Pick<WorkoutContent, "zone" | "why"> & {
  readonly blocks: (minutes: number) => WorkoutBlock[];
};

const SHAPES: Readonly<Record<Exclude<ContentWorkoutKind, "event">, Shape>> = {
  hard: { zone: "sweet-spot", why: "sustained-power", blocks: sweetSpotRide },
  endurance: { zone: "endurance", why: "aerobic-base", blocks: steadyRide },
  long: { zone: "endurance", why: "endurance", blocks: steadyRide },
  easy: { zone: "recovery", why: "recover", blocks: easyRide },
};

function doubledPercent(target: WorkoutTarget): number {
  switch (target.kind) {
    case "steady":
      return target.percent * 2;
    case "range":
      return target.low + target.high;
    case "ramp":
      return target.from + target.to;
  }
}

function workoutSteps(blocks: readonly WorkoutBlock[]): WorkoutStep[] {
  return blocks.flatMap((block) =>
    block.kind === "step"
      ? [block.step]
      : Array.from({ length: block.times }, () => block.steps).flat(),
  );
}

function workoutLoad(blocks: readonly WorkoutBlock[]): number {
  const weighted = workoutSteps(blocks).reduce(
    (sum, entry) => sum + entry.seconds * doubledPercent(entry.target) ** 2,
    0,
  );
  return Math.round(weighted / 1_440_000);
}

export function workoutContent(
  kind: ContentWorkoutKind,
  minutes: number,
): WorkoutContent | undefined {
  if (kind === "event" || !Number.isInteger(minutes) || minutes <= 0) return undefined;
  const shape =
    kind === "hard" && minutes < SHORTEST_SWEET_SPOT_MINUTES ? SHAPES.endurance : SHAPES[kind];
  const blocks = shape.blocks(minutes);
  return { version: 1, zone: shape.zone, load: workoutLoad(blocks), why: shape.why, blocks };
}
