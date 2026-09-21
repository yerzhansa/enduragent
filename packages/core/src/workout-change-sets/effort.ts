import { z } from "zod";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { WorkoutChartSegment, WorkoutChartUnit } from "./presentation.js";

const amount = z.number().nonnegative();
const units = z.enum(["%ftp", "w", "watts", "rpm"]);
const providerTarget = z.union([
  z.strictObject({ units, value: amount }),
  z.strictObject({ units, start: amount, end: amount }),
]);
const providerStep = z
  .object({
    duration: z.number().positive(),
    power: providerTarget.refine((target) => target.units !== "rpm").optional(),
    cadence: providerTarget
      .refine(
        (target) => target.units === "rpm" && ("value" in target || target.start <= target.end),
      )
      .optional(),
    warmup: z.boolean().optional(),
    cooldown: z.boolean().optional(),
    ramp: z.boolean().optional(),
    heartrate: z.unknown().optional(),
    pace: z.unknown().optional(),
    steps: z.never().optional(),
    reps: z.never().optional(),
    repeat: z.never().optional(),
  })
  .refine(
    (step) =>
      step.power !== undefined ||
      step.cadence !== undefined ||
      ((step.heartrate === undefined || step.heartrate === null) &&
        (step.pace === undefined || step.pace === null)),
  );
const providerRepeat = z.object({
  reps: z.number().int().positive(),
  get steps(): z.ZodArray<z.ZodUnion<readonly [typeof providerStep, typeof providerRepeat]>> {
    return z.array(z.union([providerStep, providerRepeat])).min(1);
  },
});
const providerWorkout = z.object({
  steps: z.array(z.union([providerStep, providerRepeat])).min(1),
});
const powerKind = z.enum(["watts", "percent_ftp", "zone"]);
const authoredPower = z.union([
  z.strictObject({ kind: powerKind, value: amount }),
  z.strictObject({ kind: powerKind, low: amount, high: amount }),
]);
const authoredCadence = z.union([
  z.strictObject({ target: amount }),
  z.strictObject({ low: amount, high: amount }).refine((target) => target.low <= target.high),
]);
const authoredStep = z
  .strictObject({
    type: z.enum([
      "warmup",
      "steady",
      "ramp",
      "interval",
      "rest",
      "recovery",
      "cooldown",
      "freeride",
    ]),
    duration: z.strictObject({
      value: z.number().positive(),
      unit: z.enum(["seconds", "minutes"]),
    }),
    power: authoredPower.optional(),
    cadence: authoredCadence.optional(),
    label: z.string().optional(),
  })
  .refine((step) => {
    if (!Number.isFinite(step.duration.value * (step.duration.unit === "minutes" ? 60 : 1)))
      return false;
    if (step.type === "ramp" && (step.power === undefined || "value" in step.power)) return false;
    if (step.power === undefined) return true;
    if (step.power.kind === "zone") {
      const values = "value" in step.power ? [step.power.value] : [step.power.low, step.power.high];
      if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 7)) return false;
    }
    return "value" in step.power || step.power.low <= step.power.high;
  });
const authoredWorkout = z.object({
  steps: z
    .array(
      z.union([
        authoredStep,
        z.strictObject({
          type: z.literal("set"),
          repeat: z.number().int().positive(),
          interval: authoredStep,
          recovery: authoredStep,
        }),
      ]),
    )
    .min(1),
});

function number(value: number, book: Phrasebook): string {
  return book.format.number(value, { maximumFractionDigits: 6 });
}

function duration(seconds: number, book: Phrasebook): string {
  return seconds % 60 === 0
    ? book.say("workouts.review.minutes", { minutes: number(seconds / 60, book) })
    : book.say("training.response.seconds", { value: number(seconds, book) });
}

function providerEffort(target: z.infer<typeof providerTarget>, book: Phrasebook): string {
  const value =
    "value" in target
      ? number(target.value, book)
      : `${number(target.start, book)}${target.units === "rpm" ? "–" : " → "}${number(target.end, book)}`;
  const suffix = target.units === "%ftp" ? "% FTP" : target.units === "rpm" ? " rpm" : " W";
  return `${value}${suffix}`;
}

function providerLines(
  steps: z.infer<typeof providerWorkout>["steps"],
  book: Phrasebook,
  indent = "",
): string {
  return steps
    .map((step) => {
      if (step.reps !== undefined)
        return `${indent}${number(step.reps, book)} ×\n${providerLines(step.steps, book, `${indent}  `)}`;
      return `${indent}- ${[
        duration(step.duration, book),
        step.power === undefined ? "" : providerEffort(step.power, book),
        step.cadence === undefined ? "" : providerEffort(step.cadence, book),
      ]
        .filter(Boolean)
        .join(" · ")}`;
    })
    .join("\n");
}

function authoredEffort(step: z.infer<typeof authoredStep>, book: Phrasebook): string {
  const power = step.power;
  if (power === undefined) return "";
  const value =
    "value" in power
      ? number(power.value, book)
      : `${number(power.low, book)}${step.type === "ramp" ? " → " : "–"}${number(power.high, book)}`;
  switch (power.kind) {
    case "watts":
      return `${value} W`;
    case "percent_ftp":
      return `${value}% FTP`;
    case "zone":
      return `${book.say("training.ride.zone")} ${value}`;
  }
}

function authoredLine(step: z.infer<typeof authoredStep>, book: Phrasebook): string {
  const seconds = step.duration.value * (step.duration.unit === "minutes" ? 60 : 1);
  const cadence =
    step.cadence === undefined
      ? ""
      : "target" in step.cadence
        ? `${number(step.cadence.target, book)} rpm`
        : `${number(step.cadence.low, book)}–${number(step.cadence.high, book)} rpm`;
  const label = step.label ?? (step.type === "rest" ? book.say("plan.view.active.rest") : "");
  return [duration(seconds, book), authoredEffort(step, book), cadence, label]
    .filter(Boolean)
    .join(" · ");
}

export function readableEffort(value: unknown, book: Phrasebook): string {
  const provider = providerWorkout.safeParse(value);
  if (provider.success) return providerLines(provider.data.steps, book);
  const authored = authoredWorkout.safeParse(value);
  if (authored.success) {
    return authored.data.steps
      .map((step) =>
        step.type === "set"
          ? `${number(step.repeat, book)} ×\n  - ${authoredLine(step.interval, book)}\n  - ${authoredLine(step.recovery, book)}`
          : `- ${authoredLine(step, book)}`,
      )
      .join("\n");
  }
  return book.say("workouts.review.structureUnavailable");
}

interface WorkoutEffortPlot {
  readonly unit: WorkoutChartUnit;
  readonly segments: readonly WorkoutChartSegment[];
}

const MAX_PLOT_INPUT_NODES = 50_000;
const MAX_PLOT_INPUT_DEPTH = 32;
const MAX_PLOT_SEGMENTS = 512;

function plotInputWithinBounds(value: unknown): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (visited > MAX_PLOT_INPUT_NODES || current.depth > MAX_PLOT_INPUT_DEPTH) return false;
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const child of Object.values(current.value)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function providerUnit(value: z.infer<typeof units>): WorkoutChartUnit | null {
  if (value === "%ftp") return "percent_ftp";
  if (value === "w" || value === "watts") return "watts";
  return null;
}

function providerSegment(
  step: z.infer<typeof providerStep>,
): { readonly unit: WorkoutChartUnit; readonly segment: WorkoutChartSegment } | null {
  const power = step.power;
  if (power === undefined) return null;
  const unit = providerUnit(power.units);
  if (unit === null) return null;
  if ("value" in power)
    return {
      unit,
      segment: { kind: "steady", durationSeconds: step.duration, target: power.value },
    };
  if (step.ramp === true)
    return {
      unit,
      segment: {
        kind: "ramp",
        durationSeconds: step.duration,
        start: power.start,
        end: power.end,
      },
    };
  return {
    unit,
    segment: {
      kind: "range",
      durationSeconds: step.duration,
      low: Math.min(power.start, power.end),
      high: Math.max(power.start, power.end),
    },
  };
}

function providerPlot(value: unknown): WorkoutEffortPlot | null {
  if (!plotInputWithinBounds(value)) return null;
  const parsed = providerWorkout.safeParse(value);
  if (!parsed.success) return null;
  const collected: { unit: WorkoutChartUnit; segment: WorkoutChartSegment }[] = [];
  const visit = (steps: z.infer<typeof providerWorkout>["steps"]): boolean => {
    for (const step of steps) {
      if (step.reps !== undefined) {
        for (let repetition = 0; repetition < step.reps; repetition += 1) {
          if (!visit(step.steps)) return false;
          if (collected.length > MAX_PLOT_SEGMENTS) return false;
        }
        continue;
      }
      const converted = providerSegment(step);
      if (converted === null) return false;
      collected.push(converted);
      if (collected.length > MAX_PLOT_SEGMENTS) return false;
    }
    return true;
  };
  if (!visit(parsed.data.steps)) return null;
  const unit = collected[0]?.unit;
  if (unit === undefined || collected.some((item) => item.unit !== unit)) return null;
  return { unit, segments: collected.map((item) => item.segment) };
}

function authoredSegment(
  step: z.infer<typeof authoredStep>,
): { readonly unit: WorkoutChartUnit; readonly segment: WorkoutChartSegment } | null {
  const power = step.power;
  if (power === undefined) return null;
  const durationSeconds = step.duration.value * (step.duration.unit === "minutes" ? 60 : 1);
  const unit: WorkoutChartUnit = power.kind;
  if ("value" in power)
    return { unit, segment: { kind: "steady", durationSeconds, target: power.value } };
  if (step.type === "ramp")
    return {
      unit,
      segment: { kind: "ramp", durationSeconds, start: power.low, end: power.high },
    };
  return {
    unit,
    segment: { kind: "range", durationSeconds, low: power.low, high: power.high },
  };
}

function authoredPlot(value: unknown): WorkoutEffortPlot | null {
  if (!plotInputWithinBounds(value)) return null;
  const parsed = authoredWorkout.safeParse(value);
  if (!parsed.success) return null;
  const collected: { unit: WorkoutChartUnit; segment: WorkoutChartSegment }[] = [];
  for (const step of parsed.data.steps) {
    if (step.type === "set") {
      for (let repetition = 0; repetition < step.repeat; repetition += 1) {
        const interval = authoredSegment(step.interval);
        const recovery = authoredSegment(step.recovery);
        if (interval === null || recovery === null) return null;
        collected.push(interval, recovery);
        if (collected.length > MAX_PLOT_SEGMENTS) return null;
      }
      continue;
    }
    const converted = authoredSegment(step);
    if (converted === null) return null;
    collected.push(converted);
    if (collected.length > MAX_PLOT_SEGMENTS) return null;
  }
  const unit = collected[0]?.unit;
  if (unit === undefined || collected.some((item) => item.unit !== unit)) return null;
  return { unit, segments: collected.map((item) => item.segment) };
}

function totalDuration(segments: readonly WorkoutChartSegment[]): number {
  return segments.reduce((total, segment) => total + segment.durationSeconds, 0);
}

export function workoutEffortPlot(input: {
  readonly structure: unknown;
  readonly durationSeconds: number | null;
}): WorkoutEffortPlot | null {
  if (input.durationSeconds === null) return null;
  const structured = providerPlot(input.structure) ?? authoredPlot(input.structure);
  if (structured !== null && totalDuration(structured.segments) === input.durationSeconds)
    return structured;
  return null;
}
