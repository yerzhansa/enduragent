export { calculateCyclingZones, ZONE_DESCRIPTIONS } from "./zones.js";
export type { CyclingZoneDisplay } from "./zones.js";

export {
  selectPeriodizationModel,
  computeTotalWeeks,
  BUILD_RECOVERY_RATIOS,
  TAPER_WEEKS,
  PHASE_TEMPLATES,
  VOLUME_PROGRESSION,
  INTENSITY_DISTRIBUTIONS,
  VOLUME_TIERS,
  VOLUME_TIER_MAPPING,
} from "./periodization.js";
export type { PeriodizationModel } from "./periodization.js";

export { assessGoalFeasibility } from "./feasibility.js";
export type { FeasibilityInput, FeasibilityResult } from "./feasibility.js";

export { getSampleWeek } from "./templates.js";
export type { SampleWorkout, WorkoutType } from "./templates.js";

export { buildPlanSkeleton, type BuildPlanSkeletonOptions } from "./plan-builder.js";
export { projectCyclingSeasonMetadata } from "./season.js";
export type {
  CyclingSeasonConstraintMetadata,
  CyclingSeasonMetadata,
  CyclingSeasonWeekMetadata,
} from "./season.js";
export { cyclingTaperRefusal, projectCyclingReadinessInput } from "./readiness.js";
export type { CyclingReadinessSourceInput, CyclingReadinessWorkoutInput } from "./readiness.js";
export { projectCyclingEstimatedCp } from "./estimated-cp.js";
export type { CyclingEstimatedCpEffort, CyclingEstimatedCpProjection } from "./estimated-cp.js";

export {
  serializeIntervalsWorkout,
  intervalsWorkoutInputSchema,
  InvalidWorkoutError,
} from "./intervals-serializer.js";
export type { IntervalsWorkoutInput } from "./intervals-serializer.js";

export * from "./schemas.js";

export { cyclingSport, CYCLING_VOCABULARY } from "./sport.js";
export { CYCLING_PRESCRIPTION_CAPABILITY } from "./prescription-posture.js";
export type { PrescriptionCapability } from "./prescription-posture.js";
export { migrateCyclingLegacySections } from "./migrate.js";
export { CyclingRaceCourseError, interpretCyclingRaceCourse } from "./race-course.js";
export type { CyclingRaceCourseInterpretation } from "./race-course.js";
export {
  createCyclingPlanFtpAdapter,
  readCyclingPlanFtpCandidates,
  validateManualPlanFtp,
  type CyclingPlanFtpSourcePorts,
} from "./plan-ftp.js";

export {
  cyclingReferenceAdapter,
  CYCLING_SUSTAINABILITY_ANCHORS,
  projectDfaSummary,
  projectPowerCurveDelta,
} from "./reference/index.js";

export { buildCreationDraft } from "./creation-draft-builder.js";
export {
  applyScheduleIntent,
  planChangeRaceWindow,
  PLAN_CHANGE_RACE_WINDOW_DAYS,
} from "./plan-change.js";
export type { ScheduleIntent, ScheduleChangeDiff, ScheduleChangeTotals } from "./plan-change.js";
export type {
  CreationDraftInput,
  CreationDraft,
  CreationDraftResult,
} from "./creation-draft-builder.js";
