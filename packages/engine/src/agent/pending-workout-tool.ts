import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { ToolRegistration } from "../sport.js";
import type { WorkoutPreparationTurns } from "./workout-preparation.js";

export function createPendingWorkoutTool(preparation: WorkoutPreparationTurns): ToolRegistration {
  const description =
    "Read the exact pending workout proposal, its stable item IDs, and its current set reference. " +
    "Read this before revising selected workouts or explicitly replacing the entire pending set. " +
    "Completed workouts are excluded from editable items. This read never changes the proposal or calendar. " +
    "If the result is unavailable or truncated, do not reconstruct the proposal from conversation history.";
  const inputSchema = z.strictObject({});
  return {
    name: "get_pending_workout_changes",
    description,
    inputSchema,
    tool: tool({
      description,
      inputSchema: zodSchema(inputSchema),
      execute: async (_input, options) => preparation.read(options),
    }),
  };
}
