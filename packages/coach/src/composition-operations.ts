import type {
  CoachOperations,
  PlanChangeOperations,
  PlanCreationOperations,
  PlanningOperations,
  PlanningReadOperations,
  PlanningRequestOperations,
} from "@enduragent/coach-contract";
import type { PlanCalendarOperations } from "./plan-calendar-operations.js";

export type LocalCoachOperations = CoachOperations &
  PlanningReadOperations &
  PlanningRequestOperations &
  PlanCreationOperations &
  PlanChangeOperations &
  PlanCalendarOperations &
  PlanningOperations;
