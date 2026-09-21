import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  dateKeySchema,
  isRealDateKey,
  type PreparedChange,
  type Preparation,
  type WorkoutPreparationCapability,
} from "@enduragent/engine/sport";
import {
  intervalsWorkoutInputSchema,
  intervalsWorkoutStepsSchema,
  serializeIntervalsWorkout,
  serializeIntervalsWorkoutSteps,
  type IntervalsWorkoutInput,
} from "./intervals-serializer.js";

const dateSchema = dateKeySchema.refine(isRealDateKey, "Use a real calendar date.");
const titleSchema = z.string().trim().min(1).max(120);
const editPatchSchema = z
  .strictObject({
    date: dateSchema.optional(),
    name: titleSchema.optional(),
    durationSeconds: z.number().int().positive().optional(),
    description: z.string().max(4000).optional(),
    trainingLoad: z.number().nonnegative().optional(),
    structure: z.record(z.string(), z.json()).optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "At least one workout field must change.",
  });

const changeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("add-cycling"),
    date: dateSchema,
    workout: intervalsWorkoutInputSchema,
    trainingLoad: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("add-strength"),
    date: dateSchema,
    name: titleSchema,
    durationMinutes: z.number().positive(),
    effort: z.string().trim().min(1),
    description: z.string().min(1).max(4000),
    trainingLoad: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("edit"),
    eventId: z.number().int(),
    patch: editPatchSchema,
  }),
  z.strictObject({ kind: z.literal("delete"), eventId: z.number().int() }),
]);

const referenceSchema = z.strictObject({
  setId: z.string().min(1),
  revision: z.number().int().positive(),
});

export const workoutChangeSetInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("complete"), changes: z.array(changeSchema).min(1) }),
  z.strictObject({
    kind: z.literal("replace"),
    base: referenceSchema,
    changes: z.array(changeSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("revise"),
    base: referenceSchema,
    replacements: z.array(z.strictObject({ id: z.string().min(1), change: changeSchema })).min(1),
  }),
  z.strictObject({ kind: z.literal("incomplete"), reason: z.string().trim().min(1) }),
]);

const toolInputSchema = z.strictObject({ preparation: workoutChangeSetInputSchema });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeAuthoredStep(value: unknown): boolean {
  if (!isObject(value)) return false;
  if ("type" in value || "repeat" in value || "interval" in value || "recovery" in value)
    return true;
  if (isObject(value.duration) && ("value" in value.duration || "unit" in value.duration))
    return true;
  return isObject(value.power) && "kind" in value.power;
}

function looksLikeAuthoredStructure(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.steps) && value.steps.some(looksLikeAuthoredStep);
}

function cyclingEffort(workout: IntervalsWorkoutInput): string {
  const efforts = new Set<string>();
  const visit = (step: IntervalsWorkoutInput["steps"][number]): void => {
    if (step.type === "set") {
      visit(step.interval);
      visit(step.recovery);
      return;
    }
    const power = step.power;
    if (power === undefined) {
      efforts.add(step.type === "rest" ? "Rest" : "No power target");
      return;
    }
    const value =
      power.low !== undefined && power.high !== undefined
        ? `${power.low}-${power.high}`
        : `${power.value}`;
    switch (power.kind) {
      case "watts":
        efforts.add(`${value} W`);
        break;
      case "percent_ftp":
        efforts.add(`${value}% FTP`);
        break;
      case "zone":
        efforts.add(`Zone ${value}`);
        break;
      default: {
        const exhaustive: never = power.kind;
        return exhaustive;
      }
    }
  };
  workout.steps.forEach(visit);
  return [...efforts].join(", ");
}

function prepareChange(change: z.infer<typeof changeSchema>): PreparedChange {
  switch (change.kind) {
    case "add-cycling": {
      const serialized = serializeIntervalsWorkout(change.workout);
      if (!Number.isSafeInteger(serialized.movingTime) || serialized.movingTime <= 0) {
        throw new Error("Workout duration must be a finite number of seconds greater than zero.");
      }
      return {
        kind: "add",
        sport: "cycling",
        date: change.date,
        name: change.workout.name,
        durationSeconds: serialized.movingTime,
        description: serialized.description,
        effort: cyclingEffort(change.workout),
        structure: null,
        reviewStructure: change.workout,
        trainingLoad: change.trainingLoad ?? null,
      };
    }
    case "add-strength": {
      const durationSeconds = Math.round(change.durationMinutes * 60);
      if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
        throw new Error("Strength duration must be a finite number of seconds greater than zero.");
      }
      return {
        kind: "add",
        sport: "strength",
        date: change.date,
        name: change.name,
        durationSeconds,
        description: `${change.effort}\n\n${change.description}`,
        effort: change.effort,
        structure: null,
        trainingLoad: change.trainingLoad ?? null,
      };
    }
    case "edit": {
      const structure = change.patch.structure;
      if (structure === undefined || !looksLikeAuthoredStructure(structure))
        return { kind: "edit", eventId: change.eventId, patch: change.patch };
      const reviewStructure = intervalsWorkoutStepsSchema.parse(structure);
      const serialized = serializeIntervalsWorkoutSteps(reviewStructure);
      if (!Number.isSafeInteger(serialized.movingTime) || serialized.movingTime <= 0) {
        throw new Error("Workout duration must be a finite number of seconds greater than zero.");
      }
      const { structure: _structure, ...patch } = change.patch;
      return {
        kind: "edit",
        eventId: change.eventId,
        patch: {
          ...patch,
          durationSeconds: serialized.movingTime,
          description: serialized.description,
        },
        reviewStructure,
      };
    }
    case "delete":
      return change;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

export function prepareCyclingWorkoutChanges(input: unknown): Preparation {
  const checked = workoutChangeSetInputSchema.parse(input);
  if (checked.kind === "incomplete") return checked;
  if (checked.kind === "revise") {
    const ids = new Set<string>();
    for (const replacement of checked.replacements) {
      if (ids.has(replacement.id))
        throw new Error("Each pending workout may be revised only once.");
      ids.add(replacement.id);
    }
    return {
      ...checked,
      replacements: checked.replacements.map(({ id, change }) => ({
        id,
        change: prepareChange(change),
      })),
    };
  }
  const targets = new Set<number>();
  for (const change of checked.changes) {
    if (change.kind === "edit" || change.kind === "delete") {
      if (targets.has(change.eventId))
        throw new Error("Each existing workout may appear only once.");
      targets.add(change.eventId);
    }
  }
  return { ...checked, changes: checked.changes.map(prepareChange) };
}

export const cyclingWorkoutPreparation: WorkoutPreparationCapability = {
  version: "aggregate-v1",
  replacesTools: [
    "intervals_create_workout",
    "intervals_create_strength_workout",
    "intervals_delete_workout",
    "intervals_update_workout",
  ],
  createTool(submit) {
    const description =
      "Prepare the entire requested set of calendar additions, edits, and deletions for one athlete review. " +
      "Submit exactly once per turn, including single workouts. This does not write to the calendar. " +
      "Use incomplete with a reason when any requested change cannot be prepared; never submit a partial set. " +
      "For pending proposal changes, first read get_pending_workout_changes. Use revise with its base reference and selected item replacements; all other pending items are preserved exactly. " +
      "Preserve unspecified fields in selected items. Keep each item's action kind and existing calendar event ID; use replace for an explicitly requested whole-set replacement. " +
      "Use complete only without a pending set. Pending item IDs differ from calendar event IDs. " +
      "Cycling additions use structured steps converted to native workout text. Strength additions require explicit durationMinutes and effort. " +
      "Edit patches accept date, name, durationSeconds, description, trainingLoad, and structure. Structure may be a platform workout document or authored cycling steps; authored steps become the saved native description and duration. " +
      "Today and future dates only; edits and deletions require coach-created workouts. Existing same-date workouts are preserved.";
    return {
      name: "prepare_workout_changes",
      description,
      inputSchema: toolInputSchema,
      tool: tool({
        description,
        inputSchema: zodSchema(toolInputSchema),
        execute: async (input, options) =>
          submit(prepareCyclingWorkoutChanges(input.preparation), options),
      }),
    };
  },
};
