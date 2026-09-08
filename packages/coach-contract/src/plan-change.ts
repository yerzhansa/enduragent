import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";
import {
  PlanCloseRpcParamsSchema,
  PlanCreationDraftSchema,
  SupportingEventRoleSchema,
} from "./plan-creation.js";

export const PLAN_CHANGE_TRANSLATION_BUDGET_MS = 45_000;
export const PLAN_CHANGE_PREVIEW_TIMEOUT_MS = PLAN_CHANGE_TRANSLATION_BUDGET_MS + 15_000;

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
      kind: z.literal("supporting-event").describe("Add or update a supporting event in the plan"),
      operation: z.literal("add").describe("Add a supporting event to the plan"),
      name: z.string().trim().min(1).max(512).describe("Name of the supporting event"),
      date: TrainingExportCivilDateSchema.describe(
        "Date of the supporting event in YYYY-MM-DD format",
      ),
      role: SupportingEventRoleSchema.describe(
        "Important = reduce training in the event week; Training = include the event without reducing surrounding training",
      ),
      providerId: z
        .string()
        .min(1)
        .optional()
        .describe("Identifier of the synchronized source event, when adding a linked event"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event").describe("Add or update a supporting event in the plan"),
      operation: z.literal("remove").describe("Remove an existing supporting event from the plan"),
      eventId: z
        .string()
        .min(1)
        .max(128)
        .describe("Identifier of the existing supporting event to change"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event").describe("Add or update a supporting event in the plan"),
      operation: z
        .literal("role")
        .describe("Change the training priority of an existing supporting event"),
      eventId: z
        .string()
        .min(1)
        .max(128)
        .describe("Identifier of the existing supporting event to change"),
      role: SupportingEventRoleSchema.describe(
        "Important = reduce training in the event week; Training = include the event without reducing surrounding training",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event").describe("Add or update a supporting event in the plan"),
      operation: z
        .literal("manual")
        .describe("Correct the name and date of a manually added supporting event"),
      eventId: z
        .string()
        .min(1)
        .max(128)
        .describe("Identifier of the existing supporting event to change"),
      name: z.string().trim().min(1).max(512).describe("Name of the supporting event"),
      date: TrainingExportCivilDateSchema.describe(
        "Date of the supporting event in YYYY-MM-DD format",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event").describe("Add or update a supporting event in the plan"),
      operation: z
        .literal("source-update")
        .describe("Accept synchronized name and date updates for a supporting event"),
      eventId: z
        .string()
        .min(1)
        .max(128)
        .describe("Identifier of the existing supporting event to change"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("supporting-event").describe("Add or update a supporting event in the plan"),
      operation: z.literal("name").describe("Rename an existing supporting event"),
      eventId: z
        .string()
        .min(1)
        .max(128)
        .describe("Identifier of the existing supporting event to change"),
      name: z.string().trim().min(1).max(512).describe("Name of the supporting event"),
    })
    .strict(),
]);

const WeekdaySchema = z
  .number()
  .int()
  .min(1)
  .max(7)
  .describe(
    "ISO weekday, 1 = Monday, 2 = Tuesday, 3 = Wednesday, 4 = Thursday, 5 = Friday, 6 = Saturday, 7 = Sunday",
  );

export const PlanChangeIntentSchema = z.discriminatedUnion("kind", [
  SupportingEventIntentSchema,
  z
    .object({
      kind: z.literal("ftp").describe("Set the functional threshold power used by the plan"),
      watts: FtpWattsSchema.describe("Functional threshold power, in watts"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("choose-workout").describe("Choose an existing workout for today"),
      workoutId: z
        .string()
        .min(1)
        .max(128)
        .describe("Identifier of the existing workout to choose"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("weekday-duration").describe("Limit session length on a recurring weekday"),
      day: WeekdaySchema,
      minutes: z
        .number()
        .int()
        .positive()
        .describe("Maximum session length for that weekday, in minutes"),
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("weekday-unavailable")
        .describe("Make a recurring weekday unavailable for training"),
      day: WeekdaySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("hard-weekday").describe("Disallow hard training on a recurring weekday"),
      day: WeekdaySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("weekly-duration").describe("Limit total training time each week"),
      hours: z
        .number()
        .positive()
        .multipleOf(0.25)
        .describe("Maximum total training hours per week"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("longest-workout").describe("Limit the length of any single workout"),
      minutes: z
        .number()
        .int()
        .positive()
        .describe("Maximum session length for any weekday, in minutes"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inverse").describe("Undo a previously applied plan change"),
      changeId: PlanCloseRpcParamsSchema.shape.planId.describe(
        "Identifier of the applied plan change to undo",
      ),
    })
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

export const PlanChangeRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intent"), intent: PlanChangeIntentSchema }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(500) }).strict(),
]);
export type PlanChangeRequest = z.infer<typeof PlanChangeRequestSchema>;

export const PlanChangePreviewRpcParamsSchema = z.union([
  PlanCloseRpcParamsSchema.extend({
    request: PlanChangeRequestSchema,
    intent: z.never().optional(),
  }),
  PlanCloseRpcParamsSchema.extend({ intent: PlanChangeIntentSchema }),
]);
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
        reason: z.literal("unsupported-request"),
        explanation: z.string().min(1),
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
