import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";
import { PlanCloseRpcParamsSchema, PlanCreationDraftSchema } from "./plan-creation.js";

const WeekdaySchema = z.number().int().min(1).max(7);

export const PlanChangeIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("weekday-duration"),
      day: WeekdaySchema,
      minutes: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("weekday-unavailable"), day: WeekdaySchema }).strict(),
  z.object({ kind: z.literal("hard-weekday"), day: WeekdaySchema }).strict(),
  z
    .object({ kind: z.literal("weekly-duration"), hours: z.number().positive().multipleOf(0.25) })
    .strict(),
  z.object({ kind: z.literal("longest-workout"), minutes: z.number().int().positive() }).strict(),
  z
    .object({ kind: z.literal("inverse"), changeId: PlanCloseRpcParamsSchema.shape.planId })
    .strict(),
]);
export type PlanChangeIntent = z.infer<typeof PlanChangeIntentSchema>;

export const PlanChangesPausedSchema = z
  .object({
    reason: z.literal("sync-stale"),
    lastSuccessfulSyncAtMs: z.number(),
  })
  .strict()
  .nullable();
export type PlanChangesPaused = z.infer<typeof PlanChangesPausedSchema>;

export const PlanChangeWorkoutSchema =
  PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element;
export type PlanChangeWorkout = z.infer<typeof PlanChangeWorkoutSchema>;

const DurationTotalsSchema = z
  .object({
    plan: z.number().nonnegative(),
    weeks: z.array(
      z.object({ number: z.number().int().positive(), minutes: z.number().nonnegative() }).strict(),
    ),
  })
  .strict();

export const PlanChangeModelSchema = z
  .object({
    changeId: PlanCloseRpcParamsSchema.shape.planId,
    planId: PlanCloseRpcParamsSchema.shape.planId,
    baseRevisionNumber: z.number().int().positive(),
    status: z.enum(["pending", "applied", "cancelled", "superseded", "stale"]),
    title: z.string().min(1),
    intent: PlanChangeIntentSchema,
    diff: z.array(
      z
        .object({
          workoutId: z.string().min(1),
          before: PlanChangeWorkoutSchema.nullable(),
          after: PlanChangeWorkoutSchema.nullable(),
        })
        .strict(),
    ),
    totals: z.object({ before: DurationTotalsSchema, after: DurationTotalsSchema }).strict(),
    supersedes: PlanCloseRpcParamsSchema.shape.planId.nullable(),
    supersededBy: PlanCloseRpcParamsSchema.shape.planId.nullable(),
    resultRevisionNumber: z.number().int().positive().nullable(),
    undo: z
      .discriminatedUnion("eligible", [
        z.object({ eligible: z.literal(true) }).strict(),
        z
          .object({
            eligible: z.literal(false),
            reason: z.enum(["not-newest", "inverse", "nothing-to-restore", "plan-changed"]),
          })
          .strict(),
      ])
      .nullable(),
    confidence: z.string(),
    premises: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          source: z.string().min(1),
          value: z.json(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine((change) => (change.status === "applied") === (change.undo !== null), {
    path: ["undo"],
    message: "Undo eligibility is required only for applied Changes",
  });
export type PlanChangeModel = z.infer<typeof PlanChangeModelSchema>;

export const PlanChangePreviewRpcParamsSchema = PlanCloseRpcParamsSchema.extend({
  intent: PlanChangeIntentSchema,
});
export type PlanChangePreviewRpcParams = z.infer<typeof PlanChangePreviewRpcParamsSchema>;

export const PlanChangePreviewResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("previewed"),
      change: PlanChangeModelSchema,
      version: z.number().int().positive(),
    })
    .strict(),
  z.discriminatedUnion("reason", [
    z
      .object({
        status: z.literal("rejected"),
        reason: z.enum([
          "stale-version",
          "no-active-plan",
          "command-conflict",
          "invalid-intent",
          "sync-stale",
        ]),
      })
      .strict(),
    z
      .object({
        status: z.literal("rejected"),
        reason: z.literal("race-window"),
        window: z
          .object({ start: TrainingExportCivilDateSchema, end: TrainingExportCivilDateSchema })
          .strict(),
      })
      .strict(),
  ]),
]);
export type PlanChangePreviewResult = z.infer<typeof PlanChangePreviewResultSchema>;

export const PlanChangeApplyRpcParamsSchema = PlanCloseRpcParamsSchema.extend({
  changeId: PlanChangeModelSchema.shape.changeId,
  decision: z.enum(["apply", "cancel"]),
});
export type PlanChangeApplyRpcParams = z.infer<typeof PlanChangeApplyRpcParamsSchema>;

export const PlanChangeApplyResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      changeId: PlanChangeModelSchema.shape.changeId,
      revisionNumber: z.number().int().positive(),
      version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      changeId: PlanChangeModelSchema.shape.changeId,
      version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum([
        "stale-version",
        "not-pending",
        "no-active-plan",
        "command-conflict",
        "sync-stale",
        "race-window",
      ]),
    })
    .strict(),
]);
export type PlanChangeApplyResult = z.infer<typeof PlanChangeApplyResultSchema>;

export interface PlanChangeOperations {
  "plan_change.preview"(request: PlanChangePreviewRpcParams): Promise<PlanChangePreviewResult>;
  "plan_change.apply"(request: PlanChangeApplyRpcParams): Promise<PlanChangeApplyResult>;
}
