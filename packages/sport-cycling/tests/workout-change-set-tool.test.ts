import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Preparation, PreparationResult } from "@enduragent/engine/sport";
import {
  cyclingWorkoutPreparation,
  prepareCyclingWorkoutChanges,
} from "../src/workout-change-set-tool.js";
import {
  serializeIntervalsWorkout,
  type IntervalsWorkoutInput,
} from "../src/intervals-serializer.js";

const workout: IntervalsWorkoutInput = {
  name: "Synthetic intervals",
  steps: [
    {
      type: "warmup",
      duration: { value: 10, unit: "minutes" },
      power: { kind: "percent_ftp", low: 50, high: 65 },
    },
    {
      type: "set",
      repeat: 3,
      interval: {
        type: "interval",
        duration: { value: 5, unit: "minutes" },
        power: { kind: "percent_ftp", value: 100 },
      },
      recovery: {
        type: "recovery",
        duration: { value: 2, unit: "minutes" },
        power: { kind: "zone", value: 1 },
      },
    },
  ],
};

const cycling = { kind: "add-cycling", date: "1998-09-07", workout };
const strength = {
  kind: "add-strength",
  date: "1998-09-08",
  name: "Synthetic strength",
  durationMinutes: 45,
  effort: "RPE 6",
  description: "Squat 3 x 5 at RPE 6",
};

function setupTool() {
  const submit = vi.fn(
    async (preparation: Preparation, _options: unknown): Promise<PreparationResult> =>
      preparation.kind === "incomplete"
        ? { kind: "incomplete", message: preparation.reason }
        : {
            kind: "prepared",
            changeCount:
              preparation.kind === "revise"
                ? preparation.replacements.length
                : preparation.changes.length,
          },
  );
  const registration = cyclingWorkoutPreparation.createTool(submit);
  const execute = registration.tool.execute;
  if (execute === undefined) throw new Error("Preparation tool must execute.");
  return { submit, registration, execute };
}

describe("whole-set cycling preparation", () => {
  it("prepares only the selected revision through the same cycling serializer", () => {
    const changedWorkout = {
      name: "Thursday recovery",
      steps: [
        {
          type: "interval",
          duration: { value: 5, unit: "minutes" },
          power: { kind: "percent_ftp", value: 45 },
        },
      ],
    };
    const result = prepareCyclingWorkoutChanges({
      kind: "revise",
      base: { setId: "pending-set", revision: 2 },
      replacements: [
        {
          id: "thursday",
          change: {
            kind: "add-cycling",
            date: "1998-09-10",
            workout: changedWorkout,
            trainingLoad: 8,
          },
        },
      ],
    });
    expect(result).toMatchObject({
      kind: "revise",
      base: { setId: "pending-set", revision: 2 },
      replacements: [
        {
          id: "thursday",
          change: {
            kind: "add",
            name: "Thursday recovery",
            durationSeconds: 300,
            effort: "45% FTP",
            trainingLoad: 8,
          },
        },
      ],
    });
    if (result.kind !== "revise") throw new Error("Missing revision");
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]?.change).toMatchObject({ description: "Main set\n- 5m 45%" });
  });
  it("supports explicit whole-set replacement with the current reference", () => {
    const prepared = prepareCyclingWorkoutChanges({
      kind: "complete",
      changes: [cycling, strength],
    });
    const replacement = prepareCyclingWorkoutChanges({
      kind: "replace",
      base: { setId: "pending-set", revision: 3 },
      changes: [cycling, strength],
    });
    if (prepared.kind !== "complete") throw new Error("Missing preparation");
    expect(replacement).toEqual({
      kind: "replace",
      base: { setId: "pending-set", revision: 3 },
      changes: prepared.changes,
    });
  });
  it("rejects duplicate pending item revisions and empty replacement sets", () => {
    expect(() =>
      prepareCyclingWorkoutChanges({
        kind: "revise",
        base: { setId: "pending-set", revision: 3 },
        replacements: [
          { id: "same-item", change: cycling },
          { id: "same-item", change: strength },
        ],
      }),
    ).toThrow("only once");
    expect(() =>
      prepareCyclingWorkoutChanges({
        kind: "revise",
        base: { setId: "pending-set", revision: 3 },
        replacements: [],
      }),
    ).toThrow();
  });
  it("freezes the existing cycling serializer's exact native text and computed duration", () => {
    const serialized = serializeIntervalsWorkout(workout);
    expect(prepareCyclingWorkoutChanges({ kind: "complete", changes: [cycling] })).toEqual({
      kind: "complete",
      changes: [
        {
          kind: "add",
          sport: "cycling",
          date: cycling.date,
          name: workout.name,
          durationSeconds: 1860,
          description: serialized.description,
          effort: "50-65% FTP, 100% FTP, Zone 1",
          structure: null,
          reviewStructure: workout,
          trainingLoad: null,
        },
      ],
    });
    expect(serialized.movingTime).toBe(1860);
  });

  it("prepares mixed additions, every supported edit field, and deletion in original order", () => {
    const patch = {
      date: "1998-09-10",
      name: "Easier ride",
      durationSeconds: 2400,
      description: "Main set\n- 40m 60%",
      trainingLoad: 30,
      structure: { steps: [{ duration: 2400, power: { value: 60 } }] },
    };
    const result = prepareCyclingWorkoutChanges({
      kind: "complete",
      changes: [
        cycling,
        { ...strength, trainingLoad: 15 },
        { kind: "edit", eventId: 101, patch },
        { kind: "delete", eventId: 102 },
      ],
    });
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("Expected complete preparation.");
    expect(result.changes).toHaveLength(4);
    expect(result.changes[1]).toEqual({
      kind: "add",
      sport: "strength",
      date: strength.date,
      name: strength.name,
      durationSeconds: 2700,
      effort: strength.effort,
      description: `${strength.effort}\n\n${strength.description}`,
      structure: null,
      trainingLoad: 15,
    });
    expect(result.changes[2]).toEqual({ kind: "edit", eventId: 101, patch });
    expect(result.changes[3]).toEqual({ kind: "delete", eventId: 102 });
  });

  it("normalizes an authored steps-only edit through the cycling serializer", () => {
    const structure = {
      steps: [
        {
          type: "steady",
          duration: { value: 15, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      ],
    };
    expect(
      prepareCyclingWorkoutChanges({
        kind: "complete",
        changes: [
          {
            kind: "edit",
            eventId: 101,
            patch: {
              name: "Synthetic recovery",
              durationSeconds: 1,
              description: "Stale instructions",
              structure,
            },
          },
        ],
      }),
    ).toEqual({
      kind: "complete",
      changes: [
        {
          kind: "edit",
          eventId: 101,
          patch: {
            name: "Synthetic recovery",
            durationSeconds: 900,
            description: "Main set\n- 15m 50%",
          },
          reviewStructure: structure,
        },
      ],
    });
  });

  it("rejects malformed authored-looking edit structures", () => {
    expect(() =>
      prepareCyclingWorkoutChanges({
        kind: "complete",
        changes: [
          {
            kind: "edit",
            eventId: 101,
            patch: {
              structure: {
                steps: [
                  {
                    type: "steady",
                    duration: { value: 15, unit: "hours" },
                    power: { kind: "percent_ftp", value: 50 },
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("preserves provider-shaped workout documents exactly", () => {
    const structure = {
      steps: [{ duration: 900, power: { units: "%ftp", value: 50 } }],
      averageWatts: 125,
    };
    const patch = {
      durationSeconds: 900,
      description: "Provider-authored instructions",
      structure,
    };
    expect(
      prepareCyclingWorkoutChanges({
        kind: "complete",
        changes: [{ kind: "edit", eventId: 101, patch }],
      }),
    ).toEqual({
      kind: "complete",
      changes: [{ kind: "edit", eventId: 101, patch }],
    });
  });

  it("preserves the reviewed strength effort in the native calendar description", () => {
    const result = prepareCyclingWorkoutChanges({
      kind: "complete",
      changes: [{ ...strength, description: "Squat 3 x 5; rest two minutes between sets." }],
    });
    expect(result).toMatchObject({
      kind: "complete",
      changes: [
        {
          kind: "add",
          effort: "RPE 6",
          description: "RPE 6\n\nSquat 3 x 5; rest two minutes between sets.",
        },
      ],
    });
  });

  it("passes one complete set to the host, with trusted options separate from model input", async () => {
    const { execute, submit } = setupTool();
    const options = { toolCallId: "synthetic-call", messages: [] };
    await expect(
      execute({ preparation: { kind: "complete", changes: [cycling, strength] } }, options),
    ).resolves.toEqual({
      kind: "prepared",
      changeCount: 2,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      prepareCyclingWorkoutChanges({ kind: "complete", changes: [cycling, strength] }),
      options,
    );
  });

  it("preserves an explicit incomplete result without creating a partial proposal", async () => {
    const { execute, submit } = setupTool();
    const input = { kind: "incomplete", reason: "The final workout could not be prepared." };
    await expect(
      execute({ preparation: input }, { toolCallId: "synthetic-call", messages: [] }),
    ).resolves.toEqual({
      kind: "incomplete",
      message: input.reason,
    });
    expect(submit).toHaveBeenCalledWith(input, expect.anything());
  });

  it("throws before host submission if the final workout fails semantic conversion", async () => {
    const { execute, submit } = setupTool();
    await expect(
      execute(
        {
          preparation: {
            kind: "complete",
            changes: [
              strength,
              {
                ...cycling,
                workout: {
                  name: "Invalid ramp",
                  steps: [
                    {
                      type: "ramp",
                      duration: { value: 10, unit: "minutes" },
                      power: { kind: "percent_ftp", value: 70 },
                    },
                  ],
                },
              },
            ],
          },
        },
        { toolCallId: "synthetic-call", messages: [] },
      ),
    ).rejects.toThrow("ramp requires");
    expect(submit).not.toHaveBeenCalled();
  });

  it("accepts a large set without a workout-count maximum", () => {
    const result = prepareCyclingWorkoutChanges({
      kind: "complete",
      changes: Array.from({ length: 1200 }, (_, index) => ({
        ...strength,
        name: `Synthetic ${index}`,
      })),
    });
    expect(result.kind === "complete" && result.changes.length).toBe(1200);
  });

  it.each([
    { kind: "complete", changes: [] },
    { kind: "complete", changes: [{ ...strength, durationMinutes: undefined }] },
    { kind: "complete", changes: [{ ...strength, effort: " " }] },
    { kind: "complete", changes: [{ ...strength, date: "1998-02-30" }] },
    { kind: "complete", changes: [{ kind: "edit", eventId: 101, patch: {} }] },
    {
      kind: "complete",
      changes: [{ kind: "edit", eventId: 101, patch: { pairedActivityId: "synthetic" } }],
    },
    { kind: "complete", changes: [strength], chatId: "injected" },
    {
      kind: "complete",
      changes: [
        { kind: "delete", eventId: 101 },
        { kind: "edit", eventId: 101, patch: { name: "Duplicate" } },
      ],
    },
    { kind: "complete", changes: [{ ...strength, durationMinutes: 1e308 }] },
    { kind: "complete", changes: [{ ...strength, durationMinutes: 0.001 }] },
  ])("rejects invalid proposals instead of returning a valid subset: %j", (input) => {
    expect(() => prepareCyclingWorkoutChanges(input)).toThrow();
  });

  it("does not share mutable model objects with the frozen domain result", () => {
    const patch = { structure: { steps: [{ duration: 300 }] } };
    const input = { kind: "complete", changes: [{ kind: "edit", eventId: 101, patch }] };
    const result = prepareCyclingWorkoutChanges(input);
    patch.structure.steps[0].duration = 999;
    expect(result).toEqual({
      kind: "complete",
      changes: [
        {
          kind: "edit",
          eventId: 101,
          patch: {
            structure: { steps: [{ duration: 300 }] },
          },
        },
      ],
    });
  });

  it("exposes an SDK-compatible schema and keeps chat and turn identifiers outside it", () => {
    const schema = z.toJSONSchema(setupTool().registration.inputSchema);
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain("durationMinutes");
    expect(JSON.stringify(schema)).not.toContain("chatId");
    expect(JSON.stringify(schema)).not.toContain("turnId");
    expect(setupTool().registration.name).toBe("prepare_workout_changes");
  });
});
