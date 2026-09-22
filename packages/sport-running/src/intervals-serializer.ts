import { z } from "zod";
import { ZONE_INTENSITY_MIDPOINTS } from "./zones.js";

export class InvalidWorkoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkoutError";
  }
}

// Pace target. Three kinds, all rendered to intervals.icu native "Pace" syntax:
//  - 'zone'        → "Z3 Pace" / "Z2-Z3 Pace"      (server resolves vs athlete threshold pace)
//  - 'cs_fraction' → "100% Pace" / "72-100% Pace"  (fraction-of-CS-SPEED == %-of-threshold-pace, zero inversion)
//  - 'pace'        → "5:00/km Pace" / "7:15-7:00/km Pace" (absolute M:SS, slower-first; escape hatch)
const paceKindSchema = z.enum(["zone", "cs_fraction", "pace"]);

const paceTargetSchema = z.object({
  kind: paceKindSchema,
  // zone: integer 1-6 | cs_fraction: ~0.5-1.3 | pace: "M:SS" string
  value: z.union([z.number().positive(), z.string()]).optional(),
  low: z.union([z.number().positive(), z.string()]).optional(),
  high: z.union([z.number().positive(), z.string()]).optional(),
  unit: z.enum(["km", "mi"]).optional(), // only meaningful for kind:'pace'
});

const durationSchema = z.object({
  value: z.number().positive(),
  // 'meters' is the natural form for 400m/800m reps; distance_km/distance_mi
  // mirror the codebase's existing durationUnitSchema vocabulary.
  unit: z.enum(["seconds", "minutes", "meters", "distance_km", "distance_mi"]),
});

const runningStepTypeSchema = z.enum([
  "warmup",
  "steady",
  "tempo",
  "threshold",
  "interval",
  "repetition",
  "strides",
  "ramp",
  "recovery",
  "rest",
  "cooldown",
]); // NOTE: no 'freeride' (cycling-only); adds running-idiomatic tempo/threshold/strides/repetition

const runningSimpleStepSchema = z
  .object({
    type: runningStepTypeSchema,
    duration: durationSchema,
    pace: paceTargetSchema.optional(),
    label: z.string().max(120).optional(),
  })
  // A distance-duration step MUST carry a pace target, so its planned time can be
  // derived. Turns the runtime InvalidWorkoutError into a schema-level correction
  // the LLM gets immediately.
  .superRefine((step, ctx) => {
    const isDistance =
      step.duration.unit === "meters" ||
      step.duration.unit === "distance_km" ||
      step.duration.unit === "distance_mi";
    if (isDistance && step.pace === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a distance-duration step requires a pace target so its planned time can be derived",
        path: ["pace"],
      });
    }
    // 'strides' is a neuromuscular drill, NOT a CS-zone prescription. Reject a
    // CS-anchored target on strides; allow duration-only or an absolute-pace
    // escape hatch + label.
    if (step.type === "strides" && step.pace !== undefined && step.pace.kind !== "pace") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "strides are a neuromuscular drill — use a duration-only step or kind:'pace', not a CS zone/fraction",
        path: ["pace", "kind"],
      });
    }
  });

const runningSetStepSchema = z.object({
  type: z.literal("set"),
  repeat: z.number().int().min(1).max(20),
  interval: runningSimpleStepSchema,
  recovery: runningSimpleStepSchema,
});

export const runningWorkoutInputSchema = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(z.union([runningSimpleStepSchema, runningSetStepSchema])).min(1).max(40),
});

export type RunningWorkoutInput = z.infer<typeof runningWorkoutInputSchema>;

type SimpleStep = z.infer<typeof runningSimpleStepSchema>;
type SetStep = z.infer<typeof runningSetStepSchema>;
type PaceTarget = z.infer<typeof paceTargetSchema>;
type AnyStep = SimpleStep | SetStep;
type DurationInput = z.infer<typeof durationSchema>;

const MAX_ZONE = 6;
const MIN_ZONE = 1;
const MAX_CS_FRACTION = 1.3;

const KM_METERS = 1000;
const MILE_METERS = 1609.344;
const MMSS_RE = /^(\d{1,2}):([0-5]\d)$/;

function isDistanceUnit(unit: DurationInput["unit"]): boolean {
  return unit === "meters" || unit === "distance_km" || unit === "distance_mi";
}

/** A distance step's length in metres; time steps return undefined. */
function distanceMeters(d: DurationInput): number | undefined {
  if (d.unit === "meters") return d.value;
  if (d.unit === "distance_km") return d.value * KM_METERS;
  if (d.unit === "distance_mi") return d.value * MILE_METERS;
  return undefined;
}

function timeSeconds(d: DurationInput): number | undefined {
  if (d.unit === "seconds") return d.value;
  if (d.unit === "minutes") return d.value * 60;
  return undefined;
}

function mid(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined && b !== undefined ? (a + b) / 2 : undefined;
}

/** Parse an "M:SS" pace string to total seconds; throws on a malformed shape. */
function paceStringToSeconds(s: string, path: string): number {
  const m = MMSS_RE.exec(s);
  if (m === null) {
    throw new InvalidWorkoutError(`${path}: pace "${s}" must be "M:SS" (e.g. 5:00)`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

function asNumber(v: number | string | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asString(v: number | string | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function assertZone(n: number, path: string): void {
  if (!Number.isInteger(n) || n < MIN_ZONE || n > MAX_ZONE) {
    throw new InvalidWorkoutError(`${path}: zone must be an integer ${MIN_ZONE}-${MAX_ZONE}, got ${n}`);
  }
}

function formatDuration(d: DurationInput): string {
  if (isDistanceUnit(d.unit)) {
    // intervals.icu native syntax: a bare "m" means MINUTES, so a distance must
    // NEVER emit a bare-"m" token — render every distance as km/mi instead.
    if (d.unit === "distance_mi") return `${d.value}mi`;
    if (d.unit === "distance_km") return `${d.value}km`;
    // 'meters' → decimal km (400m → "0.4km"), sidestepping the "m"=minutes trap.
    return `${d.value / KM_METERS}km`;
  }
  const total = Math.round(timeSeconds(d) ?? 0);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}`;
}

/**
 * Resolve the m/s a pace target prescribes, for deriving a distance step's planned
 * time. Returns undefined when no relative anchor is available (relative kind but
 * no csMps) — the caller decides whether that is fatal.
 */
function paceTargetMps(p: PaceTarget, csMps: number | undefined): number | undefined {
  if (p.kind === "cs_fraction") {
    if (csMps === undefined) return undefined;
    const f = asNumber(p.value) ?? mid(asNumber(p.low), asNumber(p.high));
    return f === undefined ? undefined : f * csMps;
  }
  if (p.kind === "zone") {
    if (csMps === undefined) return undefined;
    const z = asNumber(p.value) ?? mid(asNumber(p.low), asNumber(p.high));
    if (z === undefined) return undefined;
    const lo = ZONE_INTENSITY_MIDPOINTS[Math.floor(z)];
    const hi = ZONE_INTENSITY_MIDPOINTS[Math.ceil(z)];
    if (lo === undefined || hi === undefined) return undefined;
    return ((lo + hi) / 2) * csMps;
  }
  // absolute 'pace': invert the M:SS to m/s (midpoint of a range).
  const meters = p.unit === "mi" ? MILE_METERS : KM_METERS;
  const seconds =
    asString(p.value) !== undefined
      ? paceStringToSeconds(asString(p.value)!, "pace.value")
      : mid(
          asString(p.low) !== undefined ? paceStringToSeconds(asString(p.low)!, "pace.low") : undefined,
          asString(p.high) !== undefined ? paceStringToSeconds(asString(p.high)!, "pace.high") : undefined,
        );
  if (seconds === undefined || seconds <= 0) return undefined;
  return meters / seconds;
}

function formatPace(p: PaceTarget, isRamp: boolean, path: string): string {
  const prefix = isRamp ? "ramp " : "";
  const hasRange = p.low !== undefined && p.high !== undefined;
  if (isRamp && !hasRange) {
    throw new InvalidWorkoutError(`${path}: ramp requires pace.low and pace.high`);
  }

  if (p.kind === "zone") {
    if (hasRange) {
      const lo = asNumber(p.low);
      const hi = asNumber(p.high);
      if (lo === undefined || hi === undefined) {
        throw new InvalidWorkoutError(`${path}: zone range requires numeric pace.low and pace.high`);
      }
      assertZone(lo, `${path}.pace.low`);
      assertZone(hi, `${path}.pace.high`);
      if (lo > hi) {
        throw new InvalidWorkoutError(`${path}: pace.low (Z${lo}) must be a slower/equal zone than pace.high (Z${hi})`);
      }
      return `${prefix}Z${lo}-Z${hi} Pace`;
    }
    const z = asNumber(p.value);
    if (z === undefined) throw new InvalidWorkoutError(`${path}: zone target requires a numeric 'value' or 'low'+'high'`);
    assertZone(z, `${path}.pace.value`);
    return `Z${z} Pace`;
  }

  if (p.kind === "cs_fraction") {
    const checkFraction = (f: number, name: string): void => {
      if (f > MAX_CS_FRACTION) {
        throw new InvalidWorkoutError(`${path}.pace.${name}: cs_fraction ${f} exceeds sanity bound ${MAX_CS_FRACTION}`);
      }
    };
    if (hasRange) {
      const lo = asNumber(p.low);
      const hi = asNumber(p.high);
      if (lo === undefined || hi === undefined) {
        throw new InvalidWorkoutError(`${path}: cs_fraction range requires numeric pace.low and pace.high`);
      }
      checkFraction(lo, "low");
      checkFraction(hi, "high");
      if (lo > hi) {
        throw new InvalidWorkoutError(`${path}: pace.low (${lo}) must be a slower/equal fraction than pace.high (${hi})`);
      }
      return `${prefix}${Math.round(lo * 100)}-${Math.round(hi * 100)}% Pace`;
    }
    const f = asNumber(p.value);
    if (f === undefined) throw new InvalidWorkoutError(`${path}: cs_fraction target requires a numeric 'value' or 'low'+'high'`);
    checkFraction(f, "value");
    return `${Math.round(f * 100)}% Pace`;
  }

  // absolute 'pace' escape hatch — low/high are M:SS strings; emit slower-first.
  const unit = p.unit === "mi" ? "/mi" : "/km";
  if (hasRange) {
    const loStr = asString(p.low);
    const hiStr = asString(p.high);
    if (loStr === undefined || hiStr === undefined) {
      throw new InvalidWorkoutError(`${path}: absolute pace range requires "M:SS" strings for low and high`);
    }
    const loSec = paceStringToSeconds(loStr, `${path}.pace.low`);
    const hiSec = paceStringToSeconds(hiStr, `${path}.pace.high`);
    // Slower pace = LARGER total seconds; the low/first value must be the slower one.
    if (loSec < hiSec) {
      throw new InvalidWorkoutError(
        `${path}: absolute pace range must be slower-first — pace.low (${loStr}) is faster than pace.high (${hiStr})`,
      );
    }
    return `${prefix}${loStr}-${hiStr}${unit} Pace`;
  }
  const valStr = asString(p.value);
  if (valStr === undefined) {
    throw new InvalidWorkoutError(`${path}: absolute pace target requires an "M:SS" 'value' or 'low'+'high'`);
  }
  paceStringToSeconds(valStr, `${path}.pace.value`);
  return `${valStr}${unit} Pace`;
}

function formatStepLine(step: SimpleStep, path: string): string {
  const parts: string[] = [formatDuration(step.duration)];
  if (step.pace) {
    parts.push(formatPace(step.pace, step.type === "ramp", path));
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
  if (step.type === "ramp" && !step.pace) {
    throw new InvalidWorkoutError(`${path}: ramp step requires a pace target`);
  }
  // formatPace carries the per-kind bound + range-ordering checks; calling it here
  // surfaces those failures up front, before any line is emitted.
  if (step.pace) formatPace(step.pace, step.type === "ramp", path);
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

/** Planned seconds for one simple step. Distance steps derive time from pace→m/s. */
function stepSeconds(step: SimpleStep, csMps: number | undefined, path: string): number {
  const timeSec = timeSeconds(step.duration);
  if (timeSec !== undefined) return timeSec;

  const meters = distanceMeters(step.duration);
  if (meters === undefined) return 0;
  // movingTime is the only client-supplied time signal; we will not fabricate it.
  if (!step.pace) {
    throw new InvalidWorkoutError(`${path}: distance step has no pace target — cannot derive planned time`);
  }
  const mps = paceTargetMps(step.pace, csMps);
  if (mps === undefined || mps <= 0) {
    throw new InvalidWorkoutError(
      `${path}: distance step pace cannot resolve to m/s (relative target needs a critical speed) — cannot derive planned time`,
    );
  }
  return meters / mps;
}

function totalSeconds(steps: AnyStep[], csMps: number | undefined): number {
  let total = 0;
  walkSimpleSteps(steps, (step, multiplier) => {
    total += stepSeconds(step, csMps, "step") * multiplier;
  });
  return Math.round(total);
}

/**
 * Serialize a CS-anchored running workout to intervals.icu native description syntax.
 *
 * @param input  Parsed running workout (name + ordered pace steps).
 * @param csMps  The resolved critical speed (m/s). REQUIRED whenever any DISTANCE
 *               step carries a relative pace target (kind:'zone' or 'cs_fraction'),
 *               because movingTime for a distance step is derived from pace→m/s.
 *               Absence in that case throws InvalidWorkoutError (we will not
 *               fabricate a planned duration — SOUL no-invented-precision).
 *               Mirrors cycling's optional ftpWatts.
 * @returns      { description, movingTime } — NO trainingLoad (running load is
 *               server-authoritative; the server derives Pace Load from the
 *               parsed steps against the athlete's own threshold pace).
 * @throws InvalidWorkoutError on schema failure, structural violation, or a
 *               distance step whose pace cannot resolve to m/s.
 */
export function serializeRunningWorkout(
  input: RunningWorkoutInput,
  csMps?: number,
): { description: string; movingTime: number } {
  // Defense in depth: tool callers already pass a parsed object via zodSchema(),
  // but direct callers (tests, future library use) may not. Wrap ZodError so
  // both paths surface as InvalidWorkoutError to consumers.
  const parsed = runningWorkoutInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidWorkoutError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
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
    movingTime: totalSeconds(checked.steps, csMps),
  };
}
