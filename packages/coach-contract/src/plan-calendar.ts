import { z } from "zod";
import {
  PlanCalendarFtpParamsSchemas,
  PlanCalendarFtpReadSchema,
  PlanCalendarRideFtpSchema,
} from "./plan-calendar-ftp.js";

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

export const PlanCalendarTickSchema = z
  .object({
    planWorkoutId: UlidSchema,
    eventId: z.number().int().nonnegative(),
    dateKey: DateKeySchema,
    fingerprint: z.string().min(1).max(131_072),
  })
  .strict();
export type PlanCalendarTick = z.infer<typeof PlanCalendarTickSchema>;

const ActivityIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const PlanCalendarRideDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm"), planWorkoutId: UlidSchema }).strict(),
  z.object({ kind: z.literal("extra") }).strict(),
  z.object({ kind: z.literal("rematch"), planWorkoutId: UlidSchema }).strict(),
]);
export type PlanCalendarRideDecision = z.infer<typeof PlanCalendarRideDecisionSchema>;

export const PlanCalendarRideExpectedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.enum(["suggested", "confirmed"]), planWorkoutId: UlidSchema }).strict(),
]);
export type PlanCalendarRideExpected = z.infer<typeof PlanCalendarRideExpectedSchema>;

export const PlanCalendarVerdictStateSchema = z.enum(["not-written", "writing", "kept", "failed"]);
export type PlanCalendarVerdictState = z.infer<typeof PlanCalendarVerdictStateSchema>;

export const PLAN_CALENDAR_NOTE_MAX = 2_000;

export const PlanCalendarVerdictExpectedSchema = z
  .object({
    state: PlanCalendarVerdictStateSchema,
    replies: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export type PlanCalendarVerdictExpected = z.infer<typeof PlanCalendarVerdictExpectedSchema>;

export const PlanCalendarRpcParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read-review"), activityId: ActivityIdSchema }).strict(),
  z
    .object({
      action: z.literal("write-verdict"),
      activityId: ActivityIdSchema,
      event: z.enum(["opens", "asks-again"]),
      expected: PlanCalendarVerdictExpectedSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("save-note"),
      activityId: ActivityIdSchema,
      note: z.string().max(PLAN_CALENDAR_NOTE_MAX),
    })
    .strict(),
  ...PlanCalendarFtpParamsSchemas,
  z
    .object({
      action: z.literal("rides"),
      startDateKey: DateKeySchema,
      endDateKey: DateKeySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("decide-ride"),
      planId: UlidSchema,
      activityId: ActivityIdSchema,
      expected: PlanCalendarRideExpectedSchema,
      decision: PlanCalendarRideDecisionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("approve-weeks"),
      planId: UlidSchema,
      scope: PlanCalendarApproveScopeSchema,
      ticked: z.array(PlanCalendarTickSchema).max(500).optional(),
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
      action: z.literal("change-detail"),
      planId: UlidSchema,
      planWorkoutId: UlidSchema,
    })
    .strict(),
  z.object({ action: z.literal("plan-details"), planId: UlidSchema }).strict(),
  z
    .object({
      action: z.literal("save-end-choice"),
      planId: UlidSchema,
      commandId: z.string().min(1).max(512),
      ticked: z.array(PlanCalendarTickSchema).max(500),
    })
    .strict(),
  z
    .object({
      action: z.enum(["keep-change", "put-back"]),
      planId: UlidSchema,
      planWorkoutId: UlidSchema,
      basis: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      action: z.literal("move-workout"),
      planId: UlidSchema,
      planWorkoutId: UlidSchema,
      toDateKey: DateKeySchema,
      swap: z.boolean(),
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
  "workout-not-movable",
  "change-card-open",
  "outside-plan",
  "match-changed",
  "review-changed",
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
      name: z.string().max(512).nullable(),
      durationS: SecondsSchema.nullable(),
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
    movable: z.boolean(),
    movedByYou: z.object({ fromDateKey: DateKeySchema }).strict().nullable(),
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
    sendsFromDateKey: DateKeySchema,
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

export const PlanCalendarHistoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), atMs: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("change"),
      atMs: z.number().int().nonnegative(),
      title: z.string().min(1).max(20_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("kept"),
      atMs: z.number().int().nonnegative(),
      dateKey: DateKeySchema.nullable(),
      durationS: SecondsSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("moved"),
      atMs: z.number().int().nonnegative(),
      name: z.string().min(1).max(512),
      fromDateKey: DateKeySchema,
      toDateKey: DateKeySchema,
    })
    .strict(),
]);
export type PlanCalendarHistoryEntry = z.infer<typeof PlanCalendarHistoryEntrySchema>;

export const PlanCalendarEndingWorkoutSchema = z
  .object({
    planWorkoutId: UlidSchema,
    name: z.string().max(512),
    dateKey: DateKeySchema,
    durationS: SecondsSchema.nullable(),
  })
  .strict();
export type PlanCalendarEndingWorkout = z.infer<typeof PlanCalendarEndingWorkoutSchema>;

export const PlanCalendarAthleteChangeSchema = PlanCalendarEndingWorkoutSchema.extend({
  tick: PlanCalendarTickSchema,
});
export type PlanCalendarAthleteChange = z.infer<typeof PlanCalendarAthleteChangeSchema>;

export const PlanCalendarReplacingSchema = z
  .object({
    planName: z.string().max(512),
    cleanup: z.enum(["held", "pending", "running", "failed"]),
    removes: z.array(PlanCalendarEndingWorkoutSchema).max(500),
    staysToday: z.array(PlanCalendarEndingWorkoutSchema).max(20),
    athleteChanges: z.array(PlanCalendarAthleteChangeSchema).max(500),
  })
  .strict();
export type PlanCalendarReplacing = z.infer<typeof PlanCalendarReplacingSchema>;
export const PlanCalendarRideWorkoutSchema = z
  .object({
    planWorkoutId: UlidSchema,
    name: z.string().min(1).max(512),
    dateKey: DateKeySchema,
    durationS: SecondsSchema.nullable(),
  })
  .strict();
export type PlanCalendarRideWorkout = z.infer<typeof PlanCalendarRideWorkoutSchema>;

export const PlanCalendarRideMatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  PlanCalendarRideWorkoutSchema.extend({ kind: z.literal("suggested") }).strict(),
  PlanCalendarRideWorkoutSchema.extend({
    kind: z.literal("confirmed"),
    outcome: z.enum(["done-as-planned", "done-differently"]),
    by: z.enum(["you", "intervals"]),
  }).strict(),
]);
export type PlanCalendarRideMatch = z.infer<typeof PlanCalendarRideMatchSchema>;

export const PlanCalendarRideSchema = z
  .object({
    activityId: ActivityIdSchema,
    dateKey: DateKeySchema,
    startEpochSeconds: z.number().int().nonnegative(),
    timezoneOffsetSeconds: z.number().int().min(-86_400).max(86_400).nullable(),
    name: z.string().min(1).max(512).nullable(),
    kind: z.enum(["road", "indoor", "mountain", "gravel", "other"]),
    fromIntervals: z.boolean(),
    sport: z.string().min(1).max(64),
    durationS: SecondsSchema.nullable(),
    distanceM: z.number().min(0).max(10_000_000).nullable(),
    load: z.number().min(0).max(10_000).nullable(),
    averagePowerW: z.number().min(0).max(20_000).nullable(),
    averageHeartRateBpm: z.number().min(0).max(500).nullable(),
    perceivedExertion: z.number().min(0).max(10).nullable(),
    match: PlanCalendarRideMatchSchema,
    otherWorkouts: z.array(PlanCalendarRideWorkoutSchema).max(32),
    ftp: PlanCalendarRideFtpSchema,
  })
  .strict();
export type PlanCalendarRide = z.infer<typeof PlanCalendarRideSchema>;

export const PlanCalendarRideWeekSchema = z
  .object({
    index: z.number().int().min(1).max(52),
    startDateKey: DateKeySchema,
    endDateKey: DateKeySchema,
  })
  .strict();
export type PlanCalendarRideWeek = z.infer<typeof PlanCalendarRideWeekSchema>;

export const PlanCalendarVerdictMarkerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({ kind: z.literal("matched-to"), name: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("matched-extra") }).strict(),
  z.object({ kind: z.literal("match-pending") }).strict(),
]);
export type PlanCalendarVerdictMarker = z.infer<typeof PlanCalendarVerdictMarkerSchema>;

const PlanCalendarKeptVerdictShape = {
  text: z.string().min(1).max(3_000),
  writtenAtMs: z.number().int().nonnegative(),
  trigger: z.enum(["opened", "matched", "asked"]),
  usedPlan: z.boolean(),
  usedNote: z.boolean(),
  marker: PlanCalendarVerdictMarkerSchema,
};

export const PlanCalendarEarlierVerdictSchema = z
  .object({ ...PlanCalendarKeptVerdictShape, replies: z.number().int().min(1).max(1_000_000) })
  .strict();
export type PlanCalendarEarlierVerdict = z.infer<typeof PlanCalendarEarlierVerdictSchema>;

export const PlanCalendarVerdictSchema = z.discriminatedUnion("state", [
  z.object({ state: z.enum(["not-written", "writing"]) }).strict(),
  z
    .object({
      state: z.literal("failed"),
      failedBy: z.enum(["model", "interrupted"]),
      earlier: PlanCalendarEarlierVerdictSchema.nullable(),
    })
    .strict(),
  z.object({ state: z.literal("kept"), ...PlanCalendarKeptVerdictShape }).strict(),
]);
export type PlanCalendarVerdict = z.infer<typeof PlanCalendarVerdictSchema>;

export const PlanCalendarRideReviewSchema = z
  .object({
    activityId: ActivityIdSchema,
    verdict: PlanCalendarVerdictSchema,
    replies: z.number().int().min(0).max(1_000_000),
    blocked: z.enum(["none", "no-file", "no-model", "waiting-for-match"]),
    note: z
      .object({
        text: z.string().min(1).max(PLAN_CALENDAR_NOTE_MAX),
        savedAtMs: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PlanCalendarRideReview = z.infer<typeof PlanCalendarRideReviewSchema>;

export const PlanCalendarRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("review"), review: PlanCalendarRideReviewSchema }).strict(),
  PlanCalendarFtpReadSchema,
  z
    .object({
      status: z.literal("rides"),
      todayDateKey: DateKeySchema,
      plan: z
        .object({
          planId: UlidSchema,
          weeks: z.array(PlanCalendarRideWeekSchema).max(52),
        })
        .strict()
        .nullable(),
      rides: z.array(PlanCalendarRideSchema).max(1_000),
    })
    .strict(),
  z.object({ status: z.literal("ride"), ride: PlanCalendarRideSchema }).strict(),
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
      basis: z.string().min(1).max(128),
      change: z.enum(["edited", "moved", "deleted"]),
      plan: PlanCalendarWorkoutVersionSchema,
      intervals: PlanCalendarWorkoutVersionSchema.nullable(),
      editedAt: z.string().min(1).max(64).nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal("moved"),
    })
    .strict(),
  z.object({ status: z.literal("end-choice-saved") }).strict(),
  z
    .object({
      status: z.literal("plan-details"),
      planId: UlidSchema,
      version: z.number().int().positive(),
      history: z.array(PlanCalendarHistoryEntrySchema).max(500),
      ending: z
        .object({
          removes: z.array(PlanCalendarEndingWorkoutSchema).max(500),
          staysToday: z.array(PlanCalendarEndingWorkoutSchema).max(20),
          athleteChanges: z.array(PlanCalendarAthleteChangeSchema).max(500),
        })
        .strict(),
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
      replacing: PlanCalendarReplacingSchema.nullable(),
      activities: z.array(PlanCalendarActivitySchema).max(1_000),
    })
    .strict(),
]);
export type PlanCalendarRpcResult = z.infer<typeof PlanCalendarRpcResultSchema>;

export interface PlanCalendarRpcService {
  "plan.calendar"(request: PlanCalendarRpcParams): Promise<PlanCalendarRpcResult>;
}
