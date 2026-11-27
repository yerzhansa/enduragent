import { z } from "zod";

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const DateKeySchema = z.number().int().min(10101).max(99991231);
const SecondsSchema = z.number().int().min(0).max(31_536_000);

export const PlanCalendarWeekDeliverySchema = z.enum(["send-each-week", "approve-each-week"]);
export type PlanCalendarWeekDelivery = z.infer<typeof PlanCalendarWeekDeliverySchema>;

export const PlanCalendarApproveScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("first-weeks") }).strict(),
  z.object({ kind: z.literal("week"), week: z.number().int().min(1).max(52) }).strict(),
]);
export type PlanCalendarApproveScope = z.infer<typeof PlanCalendarApproveScopeSchema>;

export const PlanCalendarRpcParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("approve-weeks"),
      planId: UlidSchema,
      scope: PlanCalendarApproveScopeSchema,
    })
    .strict(),
  z.object({ action: z.literal("read-settings") }).strict(),
  z.object({ action: z.literal("send-again") }).strict(),
  z
    .object({
      action: z.literal("read"),
      startDateKey: DateKeySchema,
      endDateKey: DateKeySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("save-settings"),
      weekDelivery: PlanCalendarWeekDeliverySchema,
    })
    .strict(),
  z
    .object({
      action: z.enum(["change-detail", "keep-change", "put-back"]),
      planId: UlidSchema,
      planWorkoutId: UlidSchema,
    })
    .strict(),
]);
export type PlanCalendarRpcParams = z.infer<typeof PlanCalendarRpcParamsSchema>;

export const PlanCalendarRefusalSchema = z.enum([
  "no-active-plan",
  "already-approved",
  "not-approved-yet",
  "week-not-due",
  "intervals-unavailable",
  "plan-change-refused",
]);
export type PlanCalendarRefusal = z.infer<typeof PlanCalendarRefusalSchema>;

export const PlanCalendarCopySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan-only") }).strict(),
  z.object({ kind: z.literal("on-intervals"), owner: z.enum(["plan", "athlete-edit"]) }).strict(),
  z.object({ kind: z.literal("moving-by-you") }).strict(),
  z
    .object({
      kind: z.literal("changed-in-intervals"),
      change: z.enum(["edited", "moved", "deleted"]),
      toDateKey: DateKeySchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("removed-by-you") }).strict(),
  z.object({ kind: z.literal("kept-as-yours") }).strict(),
]);
export type PlanCalendarCopy = z.infer<typeof PlanCalendarCopySchema>;

export const PlanCalendarOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("planned") }).strict(),
  z.object({ kind: z.literal("not-synced-yet") }).strict(),
  z.object({ kind: z.literal("missed") }).strict(),
  z
    .object({
      kind: z.literal("is-this-it"),
      matchId: z.string().min(1),
      activityId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["done-as-planned", "done-differently"]),
      activityId: z.string().min(1),
      actualDurationS: SecondsSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("moved"),
      activityId: z.string().min(1),
      toDateKey: DateKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("removed-by-you") }).strict(),
]);
export type PlanCalendarOutcome = z.infer<typeof PlanCalendarOutcomeSchema>;

export const PlanCalendarWorkoutSchema = z
  .object({
    id: UlidSchema,
    dateKey: DateKeySchema,
    name: z.string().min(1).max(512),
    sport: z.string().min(1).max(64),
    durationS: SecondsSchema.nullable(),
    copy: PlanCalendarCopySchema,
    lastWrite: z.enum(["none", "ok", "failed"]),
    outcome: PlanCalendarOutcomeSchema,
    doneS: SecondsSchema,
  })
  .strict();
export type PlanCalendarWorkout = z.infer<typeof PlanCalendarWorkoutSchema>;

export const PlanCalendarWeekStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("passed") }).strict(),
  z.object({ kind: z.literal("on-intervals") }).strict(),
  z.object({ kind: z.literal("goes-out"), onDateKey: DateKeySchema }).strict(),
  z.object({ kind: z.literal("approve-from"), onDateKey: DateKeySchema }).strict(),
  z.object({ kind: z.literal("waiting-for-first-approve") }).strict(),
  z.object({ kind: z.literal("waiting-for-week-approve") }).strict(),
  z.object({ kind: z.literal("due") }).strict(),
]);
export type PlanCalendarWeekStatus = z.infer<typeof PlanCalendarWeekStatusSchema>;

export const PlanCalendarWeekSchema = z
  .object({
    index: z.number().int().min(1).max(52),
    startDateKey: DateKeySchema,
    endDateKey: DateKeySchema,
    plannedS: SecondsSchema,
    doneS: SecondsSchema,
    toConfirm: z.number().int().min(0).max(14),
    phase: z.string().min(1).max(128).nullable(),
    status: PlanCalendarWeekStatusSchema,
  })
  .strict();
export type PlanCalendarWeek = z.infer<typeof PlanCalendarWeekSchema>;

export const PlanCalendarPlanSchema = z
  .object({
    planId: UlidSchema,
    version: z.number().int().positive(),
    name: z.string().min(1).max(512),
    startDateKey: DateKeySchema,
    targetDateKey: DateKeySchema.nullable(),
    totalWeeks: z.number().int().min(1).max(52),
    currentWeek: z.number().int().min(1).max(52).nullable(),
    phase: z.string().min(1).max(128).nullable(),
    weeks: z.array(PlanCalendarWeekSchema).max(52),
    workouts: z.array(PlanCalendarWorkoutSchema).max(512),
  })
  .strict();
export type PlanCalendarPlan = z.infer<typeof PlanCalendarPlanSchema>;

export const PlanCalendarActivitySchema = z
  .object({
    activityId: z.string().min(1).max(128),
    dateKey: DateKeySchema,
    name: z.string().min(1).max(512).nullable(),
    sport: z.string().min(1).max(64),
    durationS: SecondsSchema.nullable(),
    distanceM: z.number().min(0).max(10_000_000).nullable(),
    load: z.number().min(0).max(10_000).nullable(),
    workoutId: UlidSchema.nullable(),
  })
  .strict();
export type PlanCalendarActivity = z.infer<typeof PlanCalendarActivitySchema>;

export const PlanCalendarWorkoutVersionSchema = z
  .object({
    dateKey: DateKeySchema,
    name: z.string().min(1).max(512),
    durationS: SecondsSchema.nullable(),
    description: z.string().max(20_000).nullable(),
  })
  .strict();
export type PlanCalendarWorkoutVersion = z.infer<typeof PlanCalendarWorkoutVersionSchema>;

export const PlanCalendarRpcResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("approved"),
      weeks: z.array(z.number().int().min(1).max(52)).max(52),
    })
    .strict(),
  z.object({ status: z.literal("refused"), reason: PlanCalendarRefusalSchema }).strict(),
  z.object({ status: z.literal("sending") }).strict(),
  z
    .object({ status: z.literal("settings"), weekDelivery: PlanCalendarWeekDeliverySchema })
    .strict(),
  z
    .object({
      status: z.literal("change-detail"),
      planWorkoutId: UlidSchema,
      change: z.enum(["edited", "moved", "deleted"]),
      plan: PlanCalendarWorkoutVersionSchema,
      intervals: PlanCalendarWorkoutVersionSchema.nullable(),
      editedAt: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("change-resolved"),
      outcome: z.enum(["kept", "put-back", "refreshed", "no-card"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("calendar"),
      todayDateKey: DateKeySchema,
      calendarConnected: z.boolean(),
      weekDelivery: PlanCalendarWeekDeliverySchema,
      plan: PlanCalendarPlanSchema.nullable(),
      activities: z.array(PlanCalendarActivitySchema).max(1_000),
    })
    .strict(),
]);
export type PlanCalendarRpcResult = z.infer<typeof PlanCalendarRpcResultSchema>;

export interface PlanCalendarRpcService {
  "plan.calendar"(request: PlanCalendarRpcParams): Promise<PlanCalendarRpcResult>;
}
