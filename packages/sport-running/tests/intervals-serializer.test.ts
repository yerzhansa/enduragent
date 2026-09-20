import { describe, it, expect } from "vitest";
import {
  serializeRunningWorkout,
  runningWorkoutInputSchema,
  InvalidWorkoutError,
  type RunningWorkoutInput,
} from "../src/intervals-serializer.js";

describe("serializeRunningWorkout — description output", () => {
  it("emits a Z2 easy run as a cs_fraction range", () => {
    const input: RunningWorkoutInput = {
      name: "Z2 Easy 50min",
      steps: [
        {
          type: "warmup",
          duration: { value: 10, unit: "minutes" },
          pace: { kind: "cs_fraction", low: 0.72, high: 0.82 },
        },
        {
          type: "steady",
          duration: { value: 30, unit: "minutes" },
          pace: { kind: "cs_fraction", low: 0.72, high: 0.82 },
        },
        {
          type: "cooldown",
          duration: { value: 10, unit: "minutes" },
          pace: { kind: "cs_fraction", value: 0.7 },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input);

    expect(description).toContain("Warmup");
    expect(description).toContain("- 10m 72-82% Pace");
    expect(description).toContain("Main set");
    expect(description).toContain("Cooldown");
    expect(description).toContain("- 10m 70% Pace");
  });

  it("emits a threshold set with Nx line and interval+recovery lines", () => {
    const input: RunningWorkoutInput = {
      name: "Threshold 3x1km",
      steps: [
        {
          type: "warmup",
          duration: { value: 12, unit: "minutes" },
          pace: { kind: "cs_fraction", low: 0.7, high: 0.8 },
        },
        {
          type: "set",
          repeat: 3,
          interval: {
            type: "threshold",
            duration: { value: 1, unit: "distance_km" },
            pace: { kind: "cs_fraction", value: 1.0 },
            label: "Threshold",
          },
          recovery: {
            type: "recovery",
            duration: { value: 90, unit: "seconds" },
            pace: { kind: "cs_fraction", value: 0.65 },
          },
        },
        {
          type: "cooldown",
          duration: { value: 10, unit: "minutes" },
          pace: { kind: "cs_fraction", value: 0.65 },
        },
      ],
    };

    // csMps required: the 1km interval is a distance step with a relative target,
    // so its planned time is derived from pace→m/s.
    const { description } = serializeRunningWorkout(input, 4.0);

    expect(description).toMatch(/^Warmup$/m);
    expect(description).toMatch(/^Main set 3x$/m);
    expect(description).toContain("- 1km 100% Pace Threshold");
    expect(description).toContain("- 1m30 65% Pace");
    expect(description).toContain("Cooldown");
  });

  it("isolates a repeat block from the following main-set step", () => {
    const result = serializeRunningWorkout({
      name: "Repeat then recovery",
      steps: [
        {
          type: "warmup",
          duration: { value: 5, unit: "minutes" },
          pace: { kind: "cs_fraction", low: 0.6, high: 0.7 },
        },
        {
          type: "set",
          repeat: 2,
          interval: {
            type: "interval",
            duration: { value: 2, unit: "minutes" },
            pace: { kind: "cs_fraction", value: 1 },
          },
          recovery: {
            type: "recovery",
            duration: { value: 1, unit: "minutes" },
            pace: { kind: "cs_fraction", value: 0.65 },
          },
        },
        {
          type: "recovery",
          duration: { value: 4, unit: "minutes" },
          pace: { kind: "cs_fraction", value: 0.6 },
        },
      ],
    });

    expect(result).toEqual({
      description:
        "Warmup\n- 5m 60-70% Pace\n\nMain set 2x\n- 2m 100% Pace\n- 1m 65% Pace\n\n- 4m 60% Pace",
      movingTime: 15 * 60,
    });
  });

  it("separates a plain step and consecutive repeat blocks", () => {
    const { description } = serializeRunningWorkout({
      name: "Repeat boundaries",
      steps: [
        {
          type: "steady",
          duration: { value: 5, unit: "minutes" },
          pace: { kind: "cs_fraction", value: 0.75 },
        },
        {
          type: "set",
          repeat: 2,
          interval: {
            type: "interval",
            duration: { value: 2, unit: "minutes" },
            pace: { kind: "cs_fraction", value: 1 },
          },
          recovery: {
            type: "recovery",
            duration: { value: 1, unit: "minutes" },
            pace: { kind: "cs_fraction", value: 0.65 },
          },
        },
        {
          type: "set",
          repeat: 3,
          interval: {
            type: "interval",
            duration: { value: 1, unit: "minutes" },
            pace: { kind: "cs_fraction", value: 1.05 },
          },
          recovery: {
            type: "recovery",
            duration: { value: 1, unit: "minutes" },
            pace: { kind: "cs_fraction", value: 0.65 },
          },
        },
      ],
    });

    expect(description).toBe(
      "Main set\n- 5m 75% Pace\n\n2x\n- 2m 100% Pace\n- 1m 65% Pace\n\n3x\n- 1m 105% Pace\n- 1m 65% Pace",
    );
  });

  it("emits a single zone target", () => {
    const input: RunningWorkoutInput = {
      name: "Zone target",
      steps: [
        {
          type: "steady",
          duration: { value: 60, unit: "minutes" },
          pace: { kind: "zone", value: 2 },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input);
    expect(description).toContain("- 60m Z2 Pace");
  });

  it("emits a zone range over a distance step", () => {
    const input: RunningWorkoutInput = {
      name: "Zone range",
      steps: [
        {
          type: "interval",
          duration: { value: 1, unit: "distance_mi" },
          pace: { kind: "zone", low: 4, high: 5 },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input, 4.0);
    expect(description).toContain("- 1mi Z4-Z5 Pace");
  });

  it("emits an absolute pace escape hatch", () => {
    const input: RunningWorkoutInput = {
      name: "Absolute pace",
      steps: [
        {
          type: "steady",
          duration: { value: 10, unit: "minutes" },
          pace: { kind: "pace", value: "5:00" },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input);
    expect(description).toContain("- 10m 5:00/km Pace");
  });

  it("emits a ramp step with the 'ramp' keyword and bounds", () => {
    const input: RunningWorkoutInput = {
      name: "Ramp warmup",
      steps: [
        {
          type: "ramp",
          duration: { value: 10, unit: "minutes" },
          pace: { kind: "cs_fraction", low: 0.6, high: 0.8 },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input);
    expect(description).toContain("- 10m ramp 60-80% Pace");
  });

  it("files new running step types under Main set with no extra header", () => {
    const input: RunningWorkoutInput = {
      name: "Mixed mains",
      steps: [
        { type: "tempo", duration: { value: 10, unit: "minutes" }, pace: { kind: "zone", value: 3 } },
        { type: "threshold", duration: { value: 10, unit: "minutes" }, pace: { kind: "zone", value: 4 } },
        { type: "repetition", duration: { value: 5, unit: "minutes" }, pace: { kind: "zone", value: 5 } },
      ],
    };

    const { description } = serializeRunningWorkout(input);
    const mainCount = (description.match(/^Main set$/gm) ?? []).length;
    expect(mainCount).toBe(1);
  });

  it("formats sub-minute durations as seconds", () => {
    const input: RunningWorkoutInput = {
      name: "Short reps",
      steps: [
        {
          type: "interval",
          duration: { value: 30, unit: "seconds" },
          pace: { kind: "cs_fraction", value: 1.1 },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input);
    expect(description).toContain("- 30s 110% Pace");
  });

  it("formats 90-second durations as 1m30", () => {
    const input: RunningWorkoutInput = {
      name: "90s effort",
      steps: [
        {
          type: "interval",
          duration: { value: 90, unit: "seconds" },
          pace: { kind: "cs_fraction", value: 1.05 },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input);
    expect(description).toContain("- 1m30 105% Pace");
  });

  it("does not repeat the section label for consecutive same-section steps", () => {
    const input: RunningWorkoutInput = {
      name: "Two warmup steps",
      steps: [
        { type: "warmup", duration: { value: 5, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.6 } },
        { type: "warmup", duration: { value: 5, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.7 } },
      ],
    };

    const { description } = serializeRunningWorkout(input);
    const warmupCount = (description.match(/^Warmup$/gm) ?? []).length;
    expect(warmupCount).toBe(1);
  });
});

describe("serializeRunningWorkout — distance & units (the m≠meters gate)", () => {
  it("renders a 400m rep as 0.4km, never bare 400m", () => {
    const input: RunningWorkoutInput = {
      name: "400s",
      steps: [
        {
          type: "interval",
          duration: { value: 400, unit: "meters" },
          pace: { kind: "cs_fraction", value: 1.06 },
        },
      ],
    };

    const { description } = serializeRunningWorkout(input, 4.0);
    expect(description).toContain("- 0.4km");
    expect(description).not.toContain("400m");
  });

  it("never emits a distance token ending in a bare 'm'", () => {
    const input: RunningWorkoutInput = {
      name: "Distance mix",
      steps: [
        { type: "interval", duration: { value: 400, unit: "meters" }, pace: { kind: "cs_fraction", value: 1.06 } },
        { type: "interval", duration: { value: 800, unit: "meters" }, pace: { kind: "cs_fraction", value: 1.0 } },
        { type: "steady", duration: { value: 5, unit: "distance_km" }, pace: { kind: "cs_fraction", value: 0.8 } },
        { type: "steady", duration: { value: 3, unit: "distance_mi" }, pace: { kind: "cs_fraction", value: 0.8 } },
      ],
    };

    const { description } = serializeRunningWorkout(input, 4.0);
    // The first token of every step line is the duration token; assert none of the
    // distance ones end in a bare 'm' (which intervals.icu reads as MINUTES).
    for (const line of description.split("\n")) {
      if (!line.startsWith("- ")) continue;
      const token = line.slice(2).split(" ")[0];
      expect(token).not.toMatch(/\d+m$/);
    }
  });

  it("renders distance_km and distance_mi units", () => {
    const input: RunningWorkoutInput = {
      name: "km and mi",
      steps: [
        { type: "steady", duration: { value: 1, unit: "distance_km" }, pace: { kind: "cs_fraction", value: 0.8 } },
        { type: "steady", duration: { value: 1, unit: "distance_mi" }, pace: { kind: "cs_fraction", value: 0.8 } },
      ],
    };

    const { description } = serializeRunningWorkout(input, 4.0);
    expect(description).toContain("- 1km 80% Pace");
    expect(description).toContain("- 1mi 80% Pace");
  });

  it("uses /km by default and /mi when unit is mi for absolute pace", () => {
    const km: RunningWorkoutInput = {
      name: "km pace",
      steps: [{ type: "steady", duration: { value: 5, unit: "minutes" }, pace: { kind: "pace", value: "5:00" } }],
    };
    const mi: RunningWorkoutInput = {
      name: "mi pace",
      steps: [{ type: "steady", duration: { value: 5, unit: "minutes" }, pace: { kind: "pace", value: "8:00", unit: "mi" } }],
    };

    expect(serializeRunningWorkout(km).description).toContain("5:00/km Pace");
    expect(serializeRunningWorkout(mi).description).toContain("8:00/mi Pace");
  });
});

describe("serializeRunningWorkout — movingTime", () => {
  it("sums simple time steps", () => {
    const input: RunningWorkoutInput = {
      name: "Time sum",
      steps: [
        { type: "warmup", duration: { value: 10, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.7 } },
        { type: "steady", duration: { value: 30, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.8 } },
        { type: "cooldown", duration: { value: 5, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.65 } },
      ],
    };

    const { movingTime } = serializeRunningWorkout(input);
    expect(movingTime).toBe(45 * 60);
  });

  it("multiplies set durations by repeat count", () => {
    const input: RunningWorkoutInput = {
      name: "Set sum",
      steps: [
        { type: "warmup", duration: { value: 10, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.7 } },
        {
          type: "set",
          repeat: 3,
          interval: { type: "interval", duration: { value: 3, unit: "minutes" }, pace: { kind: "cs_fraction", value: 1.05 } },
          recovery: { type: "recovery", duration: { value: 2, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.65 } },
        },
        { type: "cooldown", duration: { value: 10, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.65 } },
      ],
    };

    // 10 + (3+2)*3 + 10 = 35 min
    const { movingTime } = serializeRunningWorkout(input);
    expect(movingTime).toBe(35 * 60);
  });

  it("handles mixed seconds/minutes", () => {
    const input: RunningWorkoutInput = {
      name: "Mixed",
      steps: [
        { type: "steady", duration: { value: 90, unit: "seconds" }, pace: { kind: "cs_fraction", value: 0.7 } },
        { type: "steady", duration: { value: 2, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.7 } },
      ],
    };

    const { movingTime } = serializeRunningWorkout(input);
    expect(movingTime).toBe(90 + 120);
  });

  it("derives distance-step seconds from a cs_fraction target and csMps", () => {
    const input: RunningWorkoutInput = {
      name: "400m derive",
      steps: [
        {
          type: "interval",
          duration: { value: 400, unit: "meters" },
          pace: { kind: "cs_fraction", value: 1.06 },
        },
      ],
    };

    // mps = 1.06 * 4.0 = 4.24; seconds = 400 / 4.24 ≈ 94.3 → rounds to 94.
    const { movingTime } = serializeRunningWorkout(input, 4.0);
    expect(movingTime).toBe(94);
  });

  it("derives distance-step seconds from a zone target via ZONE_INTENSITY_MIDPOINTS", () => {
    const input: RunningWorkoutInput = {
      name: "1mi zone4 derive",
      steps: [
        {
          type: "interval",
          duration: { value: 1, unit: "distance_mi" },
          pace: { kind: "zone", value: 4 },
        },
      ],
    };

    // zone 4 midpoint = 0.955; mps = 0.955 * 4.0 = 3.82; seconds = 1609.344 / 3.82 ≈ 421.3 → 421.
    const { movingTime } = serializeRunningWorkout(input, 4.0);
    expect(movingTime).toBe(421);
  });

  it("throws when a distance step has a relative target but no csMps", () => {
    const input: RunningWorkoutInput = {
      name: "no cs",
      steps: [
        {
          type: "interval",
          duration: { value: 400, unit: "meters" },
          pace: { kind: "cs_fraction", value: 1.06 },
        },
      ],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects a bare-distance step (no pace) at schema parse", () => {
    const input = {
      name: "bare distance",
      steps: [{ type: "interval" as const, duration: { value: 400, unit: "meters" as const } }],
    };

    expect(() => serializeRunningWorkout(input as RunningWorkoutInput)).toThrow(InvalidWorkoutError);
  });
});

describe("serializeRunningWorkout — SPEED↔PACE inversion (the #1 trap)", () => {
  it("serializes a faster zone to a numerically smaller M:SS than a slower zone", () => {
    const slow: RunningWorkoutInput = {
      name: "slow",
      steps: [{ type: "steady", duration: { value: 1, unit: "distance_km" }, pace: { kind: "pace", value: "6:00" } }],
    };
    const fast: RunningWorkoutInput = {
      name: "fast",
      steps: [{ type: "steady", duration: { value: 1, unit: "distance_km" }, pace: { kind: "pace", value: "4:00" } }],
    };

    // Z2-ish (slow) carries a larger M:SS than a Z5-ish (fast) effort.
    const slowTime = serializeRunningWorkout(slow).movingTime;
    const fastTime = serializeRunningWorkout(fast).movingTime;
    expect(slowTime).toBeGreaterThan(fastTime);
  });

  it("preserves direction for cs_fraction percent emission", () => {
    const vo2: RunningWorkoutInput = {
      name: "vo2",
      steps: [{ type: "interval", duration: { value: 3, unit: "minutes" }, pace: { kind: "cs_fraction", value: 1.12 } }],
    };
    const easy: RunningWorkoutInput = {
      name: "easy",
      steps: [{ type: "steady", duration: { value: 30, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.72 } }],
    };

    expect(serializeRunningWorkout(vo2).description).toContain("112% Pace");
    expect(serializeRunningWorkout(easy).description).toContain("72% Pace");
  });
});

describe("serializeRunningWorkout — range ordering by pace kind (the #2 trap)", () => {
  it("emits a cs_fraction range ascending (slow→fast percent)", () => {
    const input: RunningWorkoutInput = {
      name: "frac range",
      steps: [{ type: "steady", duration: { value: 20, unit: "minutes" }, pace: { kind: "cs_fraction", low: 0.72, high: 0.82 } }],
    };

    expect(serializeRunningWorkout(input).description).toContain("72-82% Pace");
  });

  it("emits a zone range ascending", () => {
    const input: RunningWorkoutInput = {
      name: "zone range",
      steps: [{ type: "interval", duration: { value: 5, unit: "minutes" }, pace: { kind: "zone", low: 4, high: 5 } }],
    };

    expect(serializeRunningWorkout(input).description).toContain("Z4-Z5 Pace");
  });

  it("emits an absolute pace range slower-first when supplied slower-first", () => {
    const input: RunningWorkoutInput = {
      name: "abs range",
      steps: [{ type: "steady", duration: { value: 10, unit: "minutes" }, pace: { kind: "pace", low: "7:15", high: "7:00" } }],
    };

    expect(serializeRunningWorkout(input).description).toContain("7:15-7:00/km Pace");
  });

  it("throws on a faster-first absolute pace range", () => {
    const input: RunningWorkoutInput = {
      name: "abs range bad",
      steps: [{ type: "steady", duration: { value: 10, unit: "minutes" }, pace: { kind: "pace", low: "7:00", high: "7:15" } }],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("throws on a descending cs_fraction range", () => {
    const input: RunningWorkoutInput = {
      name: "frac range bad",
      steps: [{ type: "steady", duration: { value: 10, unit: "minutes" }, pace: { kind: "cs_fraction", low: 0.82, high: 0.72 } }],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
  });
});

describe("serializeRunningWorkout — validation / InvalidWorkoutError", () => {
  it("rejects empty steps array at schema level", () => {
    const bad = { name: "Empty", steps: [] };
    expect(() => serializeRunningWorkout(bad as RunningWorkoutInput)).toThrow();
  });

  it("rejects missing name", () => {
    const bad = {
      steps: [{ type: "steady", duration: { value: 10, unit: "minutes" }, pace: { kind: "cs_fraction", value: 0.7 } }],
    };
    expect(() => serializeRunningWorkout(bad as unknown as RunningWorkoutInput)).toThrow();
  });

  it("rejects ramp without pace.low and pace.high", () => {
    const input = {
      name: "Bad ramp",
      steps: [
        {
          type: "ramp" as const,
          duration: { value: 10, unit: "minutes" as const },
          pace: { kind: "cs_fraction" as const, value: 0.7 },
        },
      ],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
    expect(() => serializeRunningWorkout(input)).toThrow(/ramp requires pace\.low and pace\.high/);
  });

  it("rejects ramp with no pace target at all", () => {
    const input = {
      name: "Bad ramp",
      steps: [{ type: "ramp" as const, duration: { value: 10, unit: "minutes" as const } }],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects zone 7 (running MAX_ZONE is 6, unlike cycling's 7)", () => {
    const input = {
      name: "Bad zone",
      steps: [
        {
          type: "interval" as const,
          duration: { value: 5, unit: "minutes" as const },
          pace: { kind: "zone" as const, value: 7 },
        },
      ],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
    expect(() => serializeRunningWorkout(input)).toThrow(/zone must be an integer/);
  });

  it("rejects a cs_fraction above the sanity bound", () => {
    const input = {
      name: "Absurd fraction",
      steps: [
        {
          type: "interval" as const,
          duration: { value: 30, unit: "seconds" as const },
          pace: { kind: "cs_fraction" as const, value: 1.5 },
        },
      ],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
    expect(() => serializeRunningWorkout(input)).toThrow(/exceeds sanity bound/);
  });

  it("rejects a set with repeat > 20 at schema level", () => {
    const input = {
      name: "Too many repeats",
      steps: [
        {
          type: "set" as const,
          repeat: 21,
          interval: {
            type: "interval" as const,
            duration: { value: 1, unit: "minutes" as const },
            pace: { kind: "cs_fraction" as const, value: 1.05 },
          },
          recovery: {
            type: "recovery" as const,
            duration: { value: 1, unit: "minutes" as const },
            pace: { kind: "cs_fraction" as const, value: 0.65 },
          },
        },
      ],
    };

    expect(() => serializeRunningWorkout(input)).toThrow();
  });

  it("rejects a top-level steps array longer than 40", () => {
    const step = {
      type: "steady" as const,
      duration: { value: 1, unit: "minutes" as const },
      pace: { kind: "cs_fraction" as const, value: 0.7 },
    };
    const input = { name: "Too many steps", steps: Array.from({ length: 41 }, () => step) };

    expect(() => serializeRunningWorkout(input)).toThrow();
  });

  it("rejects a distance step with a non-resolvable pace", () => {
    const input: RunningWorkoutInput = {
      name: "no cs distance",
      steps: [{ type: "interval", duration: { value: 400, unit: "meters" }, pace: { kind: "zone", value: 4 } }],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects strides carrying a cs_fraction target", () => {
    const input = {
      name: "Strides zone",
      steps: [
        {
          type: "strides" as const,
          duration: { value: 20, unit: "seconds" as const },
          pace: { kind: "cs_fraction" as const, value: 1.2 },
        },
      ],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("rejects strides carrying a zone target", () => {
    const input = {
      name: "Strides zone",
      steps: [
        {
          type: "strides" as const,
          duration: { value: 20, unit: "seconds" as const },
          pace: { kind: "zone" as const, value: 6 },
        },
      ],
    };

    expect(() => serializeRunningWorkout(input)).toThrow(InvalidWorkoutError);
  });

  it("accepts strides as a duration-only step", () => {
    const input: RunningWorkoutInput = {
      name: "Strides plain",
      steps: [{ type: "strides", duration: { value: 20, unit: "seconds" }, label: "relaxed-fast" }],
    };

    const { description } = serializeRunningWorkout(input);
    expect(description).toContain("- 20s relaxed-fast");
  });

  it("accepts strides with an absolute pace escape hatch", () => {
    const input: RunningWorkoutInput = {
      name: "Strides pace",
      steps: [{ type: "strides", duration: { value: 20, unit: "seconds" }, pace: { kind: "pace", value: "3:30" } }],
    };

    const { description } = serializeRunningWorkout(input);
    expect(description).toContain("3:30/km Pace");
  });
});

describe("runningWorkoutInputSchema", () => {
  it("rejects the cycling-only freeride step type", () => {
    const result = runningWorkoutInputSchema.safeParse({
      name: "Freeride",
      steps: [{ type: "freeride", duration: { value: 60, unit: "minutes" } }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts distance-based durations (the inverse of the cycling schema)", () => {
    const result = runningWorkoutInputSchema.safeParse({
      name: "Distance",
      steps: [{ type: "interval", duration: { value: 5, unit: "distance_km" }, pace: { kind: "cs_fraction", value: 0.8 } }],
    });
    expect(result.success).toBe(true);
  });
});
