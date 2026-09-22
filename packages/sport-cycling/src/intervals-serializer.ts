import { z } from "zod";
import { ZONE_INTENSITY_MIDPOINTS } from "./zones.js";
import { enduranceStepTypeSchema, cadenceTargetSchema } from "./schemas.js";

export class InvalidWorkoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkoutError";
  }
}

const powerKindSchema = z.enum(["watts", "percent_ftp", "zone"]);

const powerTargetSchema = z.object({
  kind: powerKindSchema,
  value: z.number().positive().optional(),
  low: z.number().positive().optional(),
  high: z.number().positive().optional(),
});

const durationSchema = z.object({
  value: z.number().positive(),
  unit: z.enum(["seconds", "minutes"]),
});

const simpleStepSchema = z.object({
  type: enduranceStepTypeSchema,
  duration: durationSchema,
  power: powerTargetSchema.optional(),
  cadence: cadenceTargetSchema.optional(),
  label: z.string().max(120).optional(),
});

const setStepSchema = z.object({
  type: z.literal("set"),
  repeat: z.number().int().min(1).max(20),
  interval: simpleStepSchema,
  recovery: simpleStepSchema,
});

export const intervalsWorkoutStepsSchema = z.object({
  steps: z
    .array(z.union([simpleStepSchema, setStepSchema]))
    .min(1)
    .max(40),
});

export const intervalsWorkoutInputSchema = intervalsWorkoutStepsSchema.extend({
  name: z.string().min(1).max(120),
});

export type IntervalsWorkoutInput = z.infer<typeof intervalsWorkoutInputSchema>;
export type IntervalsWorkoutSteps = z.infer<typeof intervalsWorkoutStepsSchema>;

type SimpleStep = z.infer<typeof simpleStepSchema>;
type SetStep = z.infer<typeof setStepSchema>;
type PowerTarget = z.infer<typeof powerTargetSchema>;
type CadenceTarget = z.infer<typeof cadenceTargetSchema>;
type AnyStep = SimpleStep | SetStep;
type DurationInput = z.infer<typeof durationSchema>;

const MAX_WATTS = 1500;
const MAX_PERCENT_FTP = 200;
const MAX_ZONE = 7;
const MIN_ZONE = 1;

function toSeconds(d: DurationInput): number {
  return d.unit === "seconds" ? d.value : d.value * 60;
}

function formatDuration(d: DurationInput): string {
  const total = Math.round(toSeconds(d));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}`;
}

function assertZone(n: number, path: string): void {
  if (!Number.isInteger(n) || n < MIN_ZONE || n > MAX_ZONE) {
    throw new InvalidWorkoutError(
      `${path}: zone must be an integer ${MIN_ZONE}-${MAX_ZONE}, got ${n}`,
    );
  }
}

function validatePowerBounds(p: PowerTarget, path: string): void {
  const check = (v: number | undefined, name: string): void => {
    if (v === undefined) return;
    if (p.kind === "watts" && v > MAX_WATTS) {
      throw new InvalidWorkoutError(
        `${path}.power.${name}: ${v}w exceeds sanity bound ${MAX_WATTS}w`,
      );
    }
    if (p.kind === "percent_ftp" && v > MAX_PERCENT_FTP) {
      throw new InvalidWorkoutError(
        `${path}.power.${name}: ${v}% exceeds sanity bound ${MAX_PERCENT_FTP}%`,
      );
    }
  };
  check(p.value, "value");
  check(p.low, "low");
  check(p.high, "high");
}

function formatPower(p: PowerTarget, isRamp: boolean, path: string): string {
  const hasRange = p.low !== undefined && p.high !== undefined;
  const hasValue = p.value !== undefined;
  const prefix = isRamp ? "ramp " : "";

  if (isRamp && !hasRange) {
    throw new InvalidWorkoutError(`${path}: ramp requires power.low and power.high`);
  }

  if (hasRange) {
    if (p.low! > p.high!) {
      throw new InvalidWorkoutError(`${path}: power.low (${p.low}) > power.high (${p.high})`);
    }
    if (p.kind === "zone") {
      assertZone(p.low!, `${path}.power.low`);
      assertZone(p.high!, `${path}.power.high`);
      if (isRamp) {
        const lowPct = Math.round(ZONE_INTENSITY_MIDPOINTS[p.low!]! * 100);
        const highPct = Math.round(ZONE_INTENSITY_MIDPOINTS[p.high!]! * 100);
        return `${prefix}${lowPct}-${highPct}%`;
      }
      return `Z${p.low}-Z${p.high}`;
    }
    if (p.kind === "percent_ftp") return `${prefix}${p.low}-${p.high}%`;
    return `${prefix}${p.low}-${p.high}w`;
  }

  if (hasValue) {
    if (p.kind === "zone") {
      assertZone(p.value!, `${path}.power.value`);
      return `Z${p.value}`;
    }
    if (p.kind === "percent_ftp") return `${p.value}%`;
    return `${p.value}w`;
  }

  throw new InvalidWorkoutError(`${path}: power requires 'value' or 'low'+'high'`);
}

function formatCadence(c: CadenceTarget, path: string): string {
  const hasTarget = c.target !== undefined;
  const hasLow = c.low !== undefined;
  const hasHigh = c.high !== undefined;

  if (hasLow !== hasHigh) {
    throw new InvalidWorkoutError(`${path}: cadence range requires both 'low' and 'high'`);
  }
  if (hasLow && hasHigh) {
    if (c.low! > c.high!) {
      throw new InvalidWorkoutError(`${path}: cadence.low (${c.low}) > cadence.high (${c.high})`);
    }
    return `${c.low}-${c.high}rpm`;
  }
  if (hasTarget) return `${c.target}rpm`;
  throw new InvalidWorkoutError(`${path}: cadence requires 'target' or 'low'+'high'`);
}

function formatStepLine(step: SimpleStep, path: string): string {
  const parts: string[] = [formatDuration(step.duration)];
  if (step.power) {
    parts.push(formatPower(step.power, step.type === "ramp", path));
  }
  if (step.cadence) {
    parts.push(formatCadence(step.cadence, path));
  }
  const body = parts.join(" ");
  return step.label ? `- ${body} ${step.label}` : `- ${body}`;
}

function sectionLabelFor(type: SimpleStep["type"] | "set"): string {
  if (type === "warmup") return "Warmup";
  if (type === "cooldown") return "Cooldown";
  return "Main set";
}

function preValidate(step: AnyStep, path: string): void {
  if (step.type === "set") {
    preValidate(step.interval, `${path}.interval`);
    preValidate(step.recovery, `${path}.recovery`);
    return;
  }
  if (step.type === "ramp" && !step.power) {
    throw new InvalidWorkoutError(`${path}: ramp step requires a power target`);
  }
  if (step.power) validatePowerBounds(step.power, path);
}

function walkSimpleSteps(
  steps: AnyStep[],
  visit: (step: SimpleStep, multiplier: number) => void,
): void {
  const go = (step: AnyStep, multiplier: number): void => {
    if (step.type === "set") {
      go(step.interval, multiplier * step.repeat);
      go(step.recovery, multiplier * step.repeat);
      return;
    }
    visit(step, multiplier);
  };
  for (const s of steps) go(s, 1);
}

function totalSeconds(steps: AnyStep[]): number {
  let total = 0;
  walkSimpleSteps(steps, (step, multiplier) => {
    total += toSeconds(step.duration) * multiplier;
  });
  return Math.round(total);
}

export function serializeIntervalsWorkout(input: IntervalsWorkoutInput): {
  description: string;
  movingTime: number;
} {
  // Defense in depth: tool callers already pass a parsed object via zodSchema(),
  // but direct callers (tests, future library use) may not. Wrap ZodError so
  // both paths surface as InvalidWorkoutError to consumers.
  const parsed = intervalsWorkoutInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidWorkoutError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const checked = parsed.data;
  checked.steps.forEach((s, i) => preValidate(s, `steps[${i}]`));

  const lines: string[] = [];
  let currentLabel: string | null = null;

  checked.steps.forEach((step, i) => {
    const label = sectionLabelFor(step.type);
    const startsSection = label !== currentLabel;
    const followsSet = checked.steps[i - 1]?.type === "set";
    if ((startsSection || step.type === "set" || followsSet) && lines.length > 0) {
      lines.push("");
    }
    if (startsSection) {
      lines.push(step.type === "set" ? `${label} ${step.repeat}x` : label);
      currentLabel = label;
    } else if (step.type === "set") {
      lines.push(`${step.repeat}x`);
    }
    const path = `steps[${i}]`;
    if (step.type === "set") {
      lines.push(formatStepLine(step.interval, `${path}.interval`));
      lines.push(formatStepLine(step.recovery, `${path}.recovery`));
    } else {
      lines.push(formatStepLine(step, path));
    }
  });

  return {
    description: lines.join("\n"),
    movingTime: totalSeconds(checked.steps),
  };
}

export function serializeIntervalsWorkoutSteps(input: IntervalsWorkoutSteps): {
  description: string;
  movingTime: number;
} {
  const checked = intervalsWorkoutStepsSchema.parse(input);
  return serializeIntervalsWorkout({ name: "Structured workout", steps: checked.steps });
}
