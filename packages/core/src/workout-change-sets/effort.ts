import { z } from "zod";
import type { Phrasebook } from "@enduragent/i18n/messages";

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
  name: z.string(),
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
