import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";
import {
  PlanCloseRpcParamsSchema,
  PlanCreationDraftSchema,
  SupportingEventRoleSchema,
} from "./plan-creation.js";

const FtpWattsSchema = z.number().int().min(1).max(9_999);

export const PlanChangeFtpSourcesSchema = z
  .object({
    acceptedPlanFtp: FtpWattsSchema.nullable(),
    requestedFtp: FtpWattsSchema.nullable(),
    candidates: z.array(
      z
        .object({
          source: z.enum(["manual", "intervals-ftp", "intervals-eftp"]),
          watts: FtpWattsSchema,
          selected: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type PlanChangeFtpSources = z.infer<typeof PlanChangeFtpSourcesSchema>;

export const PlanChangeEventSourceSchema = z
  .object({
    providerId: z.string().min(1),
    sourceRevision: z.string().regex(/^[0-9a-f]{64}$/u),
    name: z.string().trim().min(1).max(512),
    date: TrainingExportCivilDateSchema,
    category: z.enum(["RACE_A", "RACE_B", "RACE_C"]),
  })
  .strict();
export type PlanChangeEventSource = z.infer<typeof PlanChangeEventSourceSchema>;

const SupportingEventIntentSchema = z.discriminatedUnion("operation", [
  z
    .object({
      kind: z.literal("supporting-event"),
      operation: z.literal("add"),
      name: z.string().trim().min(1).max(512),
      date: TrainingExportCivilDateSchema,
      role: SupportingEventRoleSchema,
      providerId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event"),
      operation: z.literal("remove"),
      eventId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event"),
      operation: z.literal("role"),
      eventId: z.string().min(1).max(128),
      role: SupportingEventRoleSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event"),
      operation: z.literal("manual"),
      eventId: z.string().min(1).max(128),
      name: z.string().trim().min(1).max(512),
      date: TrainingExportCivilDateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event"),
      operation: z.literal("source-update"),
      eventId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event"),
      operation: z.literal("name"),
      eventId: z.string().min(1).max(128),
      name: z.string().trim().min(1).max(512),
    })
    .strict(),
]);

const WeekdaySchema = z.number().int().min(1).max(7);

export const PlanChangeIntentSchema = z.discriminatedUnion("kind", [
  SupportingEventIntentSchema,
  z.object({ kind: z.literal("ftp"), watts: FtpWattsSchema }).strict(),
  z.object({ kind: z.literal("choose-workout"), workoutId: z.string().min(1).max(128) }).strict(),
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
    details: z.string().min(1).optional(),
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
        reason: z.enum(["stale-version", "no-active-plan", "command-conflict", "sync-stale"]),
      })
      .strict(),
    z
      .object({
        status: z.literal("rejected"),
        reason: z.literal("invalid-intent"),
        message: z.string().min(1).optional(),
        explanation: z.string().min(1).optional(),
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
  z.discriminatedUnion("reason", [
    z
      .object({
        status: z.literal("rejected"),
        reason: z.enum(["day-changed", "not-eligible"]),
        message: z.string().min(1).optional(),
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
          "ftp-sources-changed",
          "event-source-changed",
        ]),
      })
      .strict(),
  ]),
]);
export type PlanChangeApplyResult = z.infer<typeof PlanChangeApplyResultSchema>;

export interface PlanChangeOperations {
  "plan_change.preview"(request: PlanChangePreviewRpcParams): Promise<PlanChangePreviewResult>;
  "plan_change.apply"(request: PlanChangeApplyRpcParams): Promise<PlanChangeApplyResult>;
}
