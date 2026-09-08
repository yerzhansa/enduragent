import { tool, zodSchema } from "ai";
import { z } from "zod";
import type {
  MemoryStorePort as MemoryStore,
  PlatformCalendarMutationsPort as PlatformCalendarMutations,
} from "@enduragent/engine/sport";
import {
  buildCoachEventProvenance,
  dateKeySchema,
  isRealDateKey,
  validateWorkoutCreationDate,
} from "@enduragent/engine/sport";
import type { IntervalsClient } from "intervals-icu-api";
import {
  calculateCyclingZones,
  buildPlanSkeleton,
  assessGoalFeasibility,
  getSampleWeek,
  serializeIntervalsWorkout,
  intervalsWorkoutInputSchema,
  InvalidWorkoutError,
} from "./index.js";
import { CYCLING_PRESCRIPTION_CAPABILITY } from "./prescription-posture.js";
import type {
  AthleteProfile,
  ExperienceLevel,
  VolumeTier,
  DayOfWeek,
  RaceType,
  IntervalsWorkoutInput,
} from "./index.js";

const daysEnum = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const buildPlanSkeletonInputSchema = z.object({
  experienceLevel: z.enum(["beginner", "intermediate", "advanced", "elite"]),
  ftpWatts: z.number().int().min(50).max(600),
  weightKg: z.number().positive().optional(),
  volumeTier: z.enum(["low", "medium", "high"]),
  scheduleType: z.enum(["fixed", "flexible"]),
  availableDays: z.array(daysEnum).optional(),
  keySessionDay: daysEnum.optional(),
  sessionsPerWeek: z.number().int().min(3).max(6).optional(),
  goalType: z.enum(["race", "general"]),
  raceType: z
    .enum(["century", "gran_fondo", "criterium", "time_trial", "other"])
    .optional(),
  raceDate: dateKeySchema.optional().describe("Target race date, YYYY-MM-DD"),
  targetTime: z.string().optional().describe("Goal finish time, e.g. 5:30:00"),
  generalGoal: z.string().optional(),
  generalGoalTarget: z.string().optional(),
});

export const cyclingCreateWorkoutInputSchema = z.object({
  date: dateKeySchema.describe("Workout date (YYYY-MM-DD)"),
  workout: intervalsWorkoutInputSchema.describe(
    "Structured workout: name + ordered steps. Top-level steps can be simple (warmup/steady/interval/ramp/recovery/rest/cooldown/freeride) or a set {type:'set', repeat, interval, recovery}. Durations use seconds or minutes only. Power targets: {kind:'percent_ftp'|'watts'|'zone', value} or {kind, low, high} for ranges. Ramps require low+high. Every step except freeride and rest needs a power target.",
  ),
});

/**
 * Pure-Sport cycling tools per ADR-0004 — sport-specific math (FTP zones,
 * periodized plan-skeleton) + the cycling-flavored intervals.icu workout
 * creator (hardcoded `type: "Ride"`). Pure-Core and Core-with-sport-config
 * intervals tools live in the engine's `createPureCoreIntervalsTools`
 * and `createCoreToolsWithSportConfig`.
 */
export function createCyclingTools(
  _memory: MemoryStore,
  intervals: IntervalsClient | null,
  tz: string = "UTC",
  calendarMutations?: PlatformCalendarMutations,
) {
  void intervals;
  const selectedMutations = calendarMutations;
  return {
    calculate_zones: tool({
      description: "Calculate power-zone watt ranges from FTP watts (7-zone numbering)",
      inputSchema: zodSchema(
        z.object({
          ftpWatts: z.number().int().min(50).max(600).describe("FTP in watts"),
        }),
      ),
      execute: async (input: { ftpWatts: number }) => calculateCyclingZones(input.ftpWatts),
    }),

    build_plan_skeleton: tool({
      description:
        CYCLING_PRESCRIPTION_CAPABILITY.toolSelectionRule +
        " Build a periodized training plan skeleton from athlete profile. Returns phases, volume targets, zone tables, and testing protocols. Does NOT save anything — present the skeleton to the athlete and call plan_save only after they approve.",
      inputSchema: zodSchema(buildPlanSkeletonInputSchema),
      execute: async (params: {
        experienceLevel: ExperienceLevel;
        ftpWatts: number;
        weightKg?: number;
        volumeTier: VolumeTier;
        scheduleType: "fixed" | "flexible";
        availableDays?: DayOfWeek[];
        keySessionDay?: DayOfWeek;
        sessionsPerWeek?: number;
        goalType: "race" | "general";
        raceType?: RaceType;
        raceDate?: string;
        targetTime?: string;
        generalGoal?: string;
        generalGoalTarget?: string;
      }) => {
        if (params.raceDate !== undefined && !isRealDateKey(params.raceDate)) {
          return {
            error: "invalid_date",
            details: `${params.raceDate} is not a real calendar date. Use YYYY-MM-DD.`,
          };
        }
        const profile: AthleteProfile = { ...params, needsExtraRecovery: false };
        const plan = buildPlanSkeleton(profile, tz);
        return plan;
      },
    }),

    assess_feasibility: tool({
      description:
        "Assess whether an FTP or W/kg target is realistic given current fitness and experience level",
      inputSchema: zodSchema(
        z.object({
          currentFtp: z.number().int().min(50).max(600),
          targetFtp: z.number().int().optional(),
          targetWkg: z.number().optional(),
          currentWeightKg: z.number().positive().optional(),
          experienceLevel: z.enum(["beginner", "intermediate", "advanced", "elite"]),
        }),
      ),
      execute: async (params: {
        currentFtp: number;
        targetFtp?: number;
        targetWkg?: number;
        currentWeightKg?: number;
        experienceLevel: ExperienceLevel;
      }) => {
        const result = assessGoalFeasibility(params);
        return result ?? { message: "Goal appears achievable within one plan cycle." };
      },
    }),

    get_sample_week: tool({
      description:
        CYCLING_PRESCRIPTION_CAPABILITY.toolSelectionRule +
        " Get a sample training week for a given volume tier and schedule type",
      inputSchema: zodSchema(
        z.object({
          volumeTier: z.enum(["low", "medium", "high"]),
          scheduleType: z.enum(["fixed", "flexible"]),
          availableDays: z.array(daysEnum).optional(),
          keySessionDay: daysEnum.optional(),
          sessionsPerWeek: z.number().int().min(3).max(6).optional(),
        }),
      ),
      execute: async (params: {
        volumeTier: VolumeTier;
        scheduleType: "fixed" | "flexible";
        availableDays?: DayOfWeek[];
        keySessionDay?: DayOfWeek;
        sessionsPerWeek?: number;
      }) =>
        getSampleWeek(
          params.volumeTier,
          params.scheduleType,
          params.availableDays,
          params.keySessionDay,
          params.sessionsPerWeek,
        ),
    }),

    ...(selectedMutations
      ? {
          intervals_create_workout: tool({
            description:
              CYCLING_PRESCRIPTION_CAPABILITY.toolSelectionRule +
              " Create a structured workout on the intervals.icu calendar. Auto-syncs to Garmin/Wahoo. " +
              "Supply the workout as structured steps — the tool serializes them into the intervals.icu " +
              "native description syntax so the power chart renders. Put athlete-facing coaching narrative " +
              "(feel, notes, hydration) in your chat reply, not in this tool. " +
              "Past dates are refused — workouts can only be created for today or later. " +
              "For gym/strength sessions use intervals_create_strength_workout instead.",
            inputSchema: zodSchema(cyclingCreateWorkoutInputSchema),
            execute: async (input: { date: string; workout: IntervalsWorkoutInput }) => {
              const dateError = validateWorkoutCreationDate(input.date, tz);
              if (dateError) return dateError;
              let serialized: ReturnType<typeof serializeIntervalsWorkout>;
              try {
                serialized = serializeIntervalsWorkout(input.workout);
              } catch (err) {
                if (err instanceof InvalidWorkoutError) {
                  return { error: "invalid_workout", details: err.message };
                }
                throw err;
              }
              try {
                const event = await selectedMutations.createEvent({
                  startDateLocal: `${input.date}T00:00:00`,
                  category: "WORKOUT",
                  name: input.workout.name,
                  type: "Ride",
                  ...buildCoachEventProvenance(input.date, input.workout.name),
                  description: serialized.description,
                });
                return { created: true, event };
              } catch (error) {
                if ((error as { name?: unknown })?.name === "PlatformCredentialsRequiredError") {
                  return { error: "platform_credentials_required", message: "Calendar changes need platform credentials." };
                }
                const candidate = error as { name?: unknown; apiError?: { kind?: unknown } };
                if (candidate?.name === "PlatformApiError" && typeof candidate.apiError?.kind === "string") {
                  return { error: candidate.apiError.kind };
                }
                throw error;
              }
            },
          }),
        }
      : {}),
  };
}
