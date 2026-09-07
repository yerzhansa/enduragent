import { z } from "zod";
import { PlanChangeModelSchema, PlanChangesPausedSchema } from "./plan-change.js";
import { PlanCreationCardModelSchema, PlanCreationDraftSchema } from "./plan-creation.js";

export const PlanDateKeySchema = z.number().int().min(1_000_101).max(99_991_231);

export const PlanNavigationTargetSchema = z
  .object({
    destination: z.literal("plan"),
    focus: z.enum(["active-plan", "current-week", "workout"]),
    entityId: z.string().min(1).nullable(),
  })
  .strict();
export type PlanNavigationTarget = z.infer<typeof PlanNavigationTargetSchema>;

export const PlanWorkoutReadModelSchema = z
  .object({
    id: z.string().min(1),
    dateKey: PlanDateKeySchema,
    sport: z.string().min(1),
    name: z.string().min(1),
    durationSeconds: z.number().int().nonnegative().nullable(),
    targets: z.string().min(1).max(2_000).nullable().optional(),
    purpose: z.string().min(1).max(2_000).nullable().optional(),
    safetyGuardrail: z.string().min(1).max(2_000).nullable().optional(),
    origin: z.enum(["coach", "athlete"]),
    navigation: PlanNavigationTargetSchema,
  })
  .strict();
export type PlanWorkoutReadModel = z.infer<typeof PlanWorkoutReadModelSchema>;

export const ActivePlanReadModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    goal: z.string(),
    lifecycle: z.enum(["draft", "active"]),
    startDateKey: PlanDateKeySchema,
    targetDateKey: PlanDateKeySchema.nullable(),
    currentWeek: z.number().int().positive().nullable(),
    totalWeeks: z.number().int().positive(),
    phase: z.string().min(1).nullable(),
    weekStartDateKey: PlanDateKeySchema.nullable(),
    weekEndDateKey: PlanDateKeySchema.nullable(),
    workouts: z.array(PlanWorkoutReadModelSchema),
    todayWorkout: PlanWorkoutReadModelSchema.nullable(),
    navigation: PlanNavigationTargetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const hasWeek = value.currentWeek !== null;
    if (hasWeek !== (value.weekStartDateKey !== null && value.weekEndDateKey !== null)) {
      context.addIssue({
        code: "custom",
        path: ["currentWeek"],
        message: "current week and its date range must appear together",
      });
    }
    if (
      value.todayWorkout !== null &&
      !value.workouts.some((item) => item.id === value.todayWorkout?.id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["todayWorkout"],
        message: "today workout must belong to the current week",
      });
    }
  });
export type ActivePlanReadModel = z.infer<typeof ActivePlanReadModelSchema>;

export const PlanningReadModelSchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("no-plan"),
      asOfDateKey: PlanDateKeySchema,
      plan: z.null(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("ready"),
      asOfDateKey: PlanDateKeySchema,
      plan: ActivePlanReadModelSchema,
    })
    .strict(),
]);
export type PlanningReadModel = z.infer<typeof PlanningReadModelSchema>;

export const GetPlanningReadModelRpcParamsSchema = z.object({}).strict();
export type GetPlanningReadModelRpcParams = z.infer<typeof GetPlanningReadModelRpcParamsSchema>;
export const GetPlanningReadModelRpcResultSchema = PlanningReadModelSchema;
export type GetPlanningReadModelRpcResult = z.infer<typeof GetPlanningReadModelRpcResultSchema>;

const PlanCalendarWindowSchema = z
  .object({ start: z.iso.date(), end: z.iso.date() })
  .strict()
  .nullable();

const PlanCalendarBaseSchema = z
  .object({
    window: PlanCalendarWindowSchema,
    currentThrough: z.iso.date().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const PlanCalendarStatusSchema = z
  .discriminatedUnion("status", [
    PlanCalendarBaseSchema.extend({ status: z.literal("not-connected"), error: z.null() }),
    PlanCalendarBaseSchema.extend({ status: z.literal("pending"), error: z.null() }),
    PlanCalendarBaseSchema.extend({ status: z.literal("running") }),
    PlanCalendarBaseSchema.extend({ status: z.literal("verified"), currentThrough: z.iso.date() }),
    PlanCalendarBaseSchema.extend({ status: z.literal("failed"), error: z.string() }),
  ])
  .superRefine((value, context) => {
    if (value.status !== "failed" && value.error !== null) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only a failed calendar can have an error",
      });
    }
    if (value.window !== null && value.window.start > value.window.end) {
      context.addIssue({
        code: "custom",
        path: ["window", "end"],
        message: "Window end must be on or after its start",
      });
    }
    if (value.status === "verified") {
      if (value.window === null) {
        context.addIssue({
          code: "custom",
          path: ["window"],
          message: "Verified calendar requires a window",
        });
      } else if (value.currentThrough !== value.window.end) {
        context.addIssue({
          code: "custom",
          path: ["currentThrough"],
          message: "Verified calendar must be current through the window end",
        });
      }
    } else if (value.currentThrough !== null) {
      context.addIssue({
        code: "custom",
        path: ["currentThrough"],
        message: "Only a verified calendar can have a current-through date",
      });
    }
  });
export type PlanCalendarStatus = z.infer<typeof PlanCalendarStatusSchema>;

export const PlanSummarySchema = z
  .object({
    planId: z.string().min(1),
    version: z.number().int().positive(),
    name: z.string().min(1),
    start: z.iso.date(),
    end: z.iso.date(),
    weeks: z.number().int().positive(),
    status: z.enum(["active", "closed"]),
    closeReason: z.enum(["stopped", "completed", "legacy-unclassified"]).nullable(),
    closedAt: z.iso.date().nullable(),
    activatedAt: z.iso.date().nullable(),
    creationId: z.string().min(1).nullable(),
    calendar: PlanCalendarStatusSchema,
  })
  .strict();
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

export const LegacyPlanSummarySchema = z
  .object({
    name: z.string().min(1),
    goal: z.string().nullable(),
    weeks: z.number().int().positive().nullable(),
    sourceStatus: z.string().nullable(),
    createdAt: z.iso.date().nullable(),
    targetDate: z.iso.date().nullable(),
    readOnly: z.literal(true),
    source: z.literal("current-plan.json"),
  })
  .strict();
export type LegacyPlanSummary = z.infer<typeof LegacyPlanSummarySchema>;

export const ListPlansParamsSchema = z.object({}).strict();
export type ListPlansParams = z.infer<typeof ListPlansParamsSchema>;
export const ListPlansResultSchema = z
  .object({
    calendarConnected: z.boolean(),
    legacy: LegacyPlanSummarySchema.nullable(),
    creation: PlanCreationCardModelSchema.nullable(),
    active: PlanSummarySchema.extend({ status: z.literal("active") }).nullable(),
    closed: z.array(PlanSummarySchema.extend({ status: z.literal("closed") })),
    changes: z.array(PlanChangeModelSchema),
    changesPaused: PlanChangesPausedSchema,
  })
  .strict();
export type ListPlansResult = z.infer<typeof ListPlansResultSchema>;

export const PlanHistoryParamsSchema = z.object({ planId: z.string().min(1) }).strict();
export type PlanHistoryParams = z.infer<typeof PlanHistoryParamsSchema>;
export const PlanHistoryResultSchema = z
  .object({
    plan: PlanSummarySchema,
    closeActor: z.string().min(1).max(128).nullable(),
    revision: z
      .object({
        revisionNumber: z.number().int().positive(),
        fingerprint: z.string().min(1),
        snapshot: PlanCreationDraftSchema,
      })
      .strict(),
    cleanup: z.enum(["none", "pending", "complete", "failed"]),
  })
  .strict()
  .nullable();
export type PlanHistoryResult = z.infer<typeof PlanHistoryResultSchema>;

export interface PlanningReadOperations {
  "plan.history"?(request: PlanHistoryParams): Promise<PlanHistoryResult>;
  "plan.list"?(request: ListPlansParams): Promise<ListPlansResult>;
  getPlanningReadModel?(
    request: GetPlanningReadModelRpcParams,
  ): Promise<GetPlanningReadModelRpcResult>;
}
