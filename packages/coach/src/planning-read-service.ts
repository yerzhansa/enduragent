import {
  GetPlanningReadModelRpcParamsSchema,
  GetPlanningReadModelRpcResultSchema,
  type GetPlanningReadModelRpcParams,
  type GetPlanningReadModelRpcResult,
  type PlanWorkoutReadModel,
} from "@enduragent/coach-contract";
import {
  createPlanRepository,
  planWeekIndex,
  planWeekRange,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { phaseForWeek } from "./plan-phase.js";

export interface PlanningReadService {
  getPlanningReadModel(
    request: GetPlanningReadModelRpcParams,
  ): Promise<GetPlanningReadModelRpcResult>;
}

export interface PlanningReadServiceInput {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly timezone: string;
  readonly now?: () => number;
}

function todayInTimezone(nowMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]),
  );
  return Number(`${parts.year}${parts.month}${parts.day}`);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workoutDetails(row: PlanWorkoutRecord): {
  readonly targets: string | null;
  readonly purpose: string | null;
  readonly safetyGuardrail: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.structureJson) as unknown;
  } catch {
    return { targets: null, purpose: null, safetyGuardrail: null };
  }
  if (!record(parsed)) return { targets: null, purpose: null, safetyGuardrail: null };
  const details = parsed;
  const text = (...keys: readonly string[]): string | null => {
    for (const key of keys) {
      const value = details[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  };
  return {
    targets: text("targets", "target"),
    purpose: text("purpose", "description"),
    safetyGuardrail: text("safetyGuardrail", "safety_guardrail", "guardrail"),
  };
}

function workoutReadModel(row: PlanWorkoutRecord): PlanWorkoutReadModel {
  const details = workoutDetails(row);
  return {
    id: row.id,
    dateKey: row.dateKey,
    sport: row.sport,
    name: row.name,
    durationSeconds: row.durationS,
    ...details,
    origin: row.origin,
    navigation: { destination: "plan", focus: "workout", entityId: row.id },
  };
}

export function createPlanningReadService(input: PlanningReadServiceInput): PlanningReadService {
  const plans = createPlanRepository(input.store);
  const now = input.now ?? Date.now;

  return {
    async getPlanningReadModel(request) {
      GetPlanningReadModelRpcParamsSchema.parse(request);
      const asOfDateKey = todayInTimezone(now(), input.timezone);
      const plan = await plans.readLatest();
      if (plan === undefined || plan.status === "ended") {
        return GetPlanningReadModelRpcResultSchema.parse({
          schemaVersion: 1,
          status: "no-plan",
          asOfDateKey,
          plan: null,
        });
      }

      const week = planWeekIndex(plan, asOfDateKey);
      const currentWeek = week.kind === "inside" ? week.weekIndex : null;
      const range = currentWeek === null ? null : planWeekRange(plan, currentWeek);
      const planWorkouts = await plans.readWorkouts(plan.id);
      const currentWorkouts =
        range === null
          ? []
          : planWorkouts
              .filter(
                (workout) =>
                  workout.dateKey >= range.startDateKey && workout.dateKey <= range.endDateKey,
              )
              .map(workoutReadModel);
      const todayWorkout =
        currentWorkouts.find((workout) => workout.dateKey === asOfDateKey) ?? null;

      return GetPlanningReadModelRpcResultSchema.parse({
        schemaVersion: 1,
        status: "ready",
        asOfDateKey,
        plan: {
          id: plan.id,
          name: plan.name,
          goal: plan.primaryGoal,
          lifecycle: plan.status === "draft" ? "draft" : "active",
          startDateKey: plan.startDateKey,
          targetDateKey: plan.targetDateKey,
          currentWeek,
          totalWeeks: plan.totalWeeks,
          phase: phaseForWeek(plan, currentWeek),
          weekStartDateKey: range?.startDateKey ?? null,
          weekEndDateKey: range?.endDateKey ?? null,
          workouts: currentWorkouts,
          todayWorkout,
          navigation: { destination: "plan", focus: "active-plan", entityId: plan.id },
        },
      });
    },
  };
}
