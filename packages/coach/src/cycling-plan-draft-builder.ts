import type { PlanFtpAdapter, PlanFtpSnapshot } from "@enduragent/engine";
import {
  MIN_FULL_PLAN_DAYS,
  addCivilDays,
  inclusiveCivilDays,
  planWeekIndex,
  planWeekRange,
  validatePlanWorkoutRecord,
  weekdayForDateKey,
  type PlanConversationRecord,
  type PlanDraftRevisionRecord,
  type PlanDraftBuildCheckpointRecord,
  type PlanDraftBuildOperation,
  type PlanDraftBuildRepository,
  type PlanIntakeRecord,
  type PlanIntakeRepository,
  type PlanIntakeWeekday,
  type PlanRecord,
  type PlanWorkoutRecord,
  type RaceCourseSnapshot,
} from "@enduragent/kernel/planning";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  BUILD_RECOVERY_RATIOS,
  buildPlanSkeleton,
  getSampleWeek,
  intervalsWorkoutInputSchema,
  serializeIntervalsWorkout,
  type IntervalsWorkoutInput,
  type SampleWorkout,
  type WorkoutType,
} from "@enduragent/sport-cycling";
import type {
  PlanDraftBuild,
  PlanDraftBuilder,
  PlanDraftBuildProgress,
} from "./planning-operations.js";

export interface CyclingPlanDraftBuilderDependencies {
  readonly intakes: PlanIntakeRepository;
  readonly ftp: PlanFtpAdapter;
  readonly identity: AuthoredIdentity;
  readonly todayDateKey: () => number;
  readonly checkpoints?: PlanDraftBuildRepository;
}

export class CyclingPlanDraftBuildError extends Error {
  readonly code:
    | "incomplete-intake"
    | "invalid-target-date"
    | "invalid-availability"
    | "invalid-previous-draft"
    | "unsupported-revision"
    | "revision-conflict";

  constructor(code: CyclingPlanDraftBuildError["code"]) {
    super(`cycling Plan Draft rejected: ${code}`);
    this.name = "CyclingPlanDraftBuildError";
    this.code = code;
  }
}

interface SeasonWeek {
  readonly weekIndex: number;
  readonly phase: "Base" | "Build" | "Recovery" | "Taper";
  readonly purpose: string;
}

interface CourseTrainingProfile {
  readonly climbingFocus: boolean;
  readonly durabilityMultiplier: number;
  readonly taperMultiplier: number;
}

type GeneratedWorkoutType = WorkoutType | "opener" | "race";

interface DraftSnapshot {
  readonly schemaVersion: 1;
  readonly builder: "cycling-plan-draft";
  readonly intake: {
    readonly eventName: string;
    readonly eventPriority: NonNullable<PlanIntakeRecord["eventPriority"]>;
    readonly eventDateKey: number;
    readonly athleteGoal: string;
    readonly availabilitySessionsPerWeek: number;
    readonly availabilityWeekdays: readonly PlanIntakeWeekday[];
    readonly experience: NonNullable<PlanIntakeRecord["experience"]>;
    readonly currentTrainingSummary: string | null;
  };
  readonly ftp: {
    readonly source: NonNullable<PlanFtpSnapshot["usedSource"]>;
    readonly watts: number;
  };
  readonly course: {
    readonly fileName: string;
    readonly distanceM: number;
    readonly elevationGainM: number | null;
  } | null;
  readonly evidence: {
    readonly completeWeeks: number;
    readonly workoutCount: number;
    readonly seasonWeeks: readonly SeasonWeek[];
    readonly revisions: readonly DraftRevisionEvidence[];
  };
  readonly draft: {
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
  };
}

interface WeekdayMoveEvidence {
  readonly kind: "weekday-move";
  readonly instruction: string;
  readonly source: string;
  readonly targetWeekday: PlanIntakeWeekday;
  readonly movedWorkoutIds: readonly string[];
}

interface WeekdayMoveAndDurationEvidence {
  readonly kind: "weekday-move-and-duration-cap";
  readonly instruction: string;
  readonly source: string;
  readonly targetWeekday: PlanIntakeWeekday;
  readonly movedWorkoutIds: readonly string[];
  readonly durationWeekday: PlanIntakeWeekday;
  readonly maximumDurationS: number;
  readonly durationWorkoutIds: readonly string[];
}

type DraftRevisionEvidence = WeekdayMoveEvidence | WeekdayMoveAndDurationEvidence;

interface DraftIntakeFacts {
  readonly eventName: string;
  readonly eventPriority: NonNullable<PlanIntakeRecord["eventPriority"]>;
  readonly eventDateKey: number;
  readonly athleteGoal: string;
  readonly availabilitySessionsPerWeek: number;
  readonly availabilityWeekdays: readonly PlanIntakeWeekday[];
  readonly experience: NonNullable<PlanIntakeRecord["experience"]>;
  readonly currentTrainingSummary: string | null;
}

interface DraftFtpFacts {
  readonly usedSource: NonNullable<PlanFtpSnapshot["usedSource"]>;
  readonly usedWatts: number;
}

interface BuildInputs {
  readonly conversation: PlanConversationRecord;
  readonly intake: DraftIntakeFacts;
  readonly ftp: DraftFtpFacts;
  readonly course: RaceCourseSnapshot | null;
  readonly startDateKey: number;
  readonly targetDateKey: number;
  readonly totalWeeks: number;
  readonly previous: DraftSnapshot | null;
  readonly revisions: readonly DraftRevisionEvidence[];
  readonly operation: PlanDraftBuildOperation;
  readonly buildKey: string;
  readonly targetRevision: number;
  readonly onProgress?: (progress: PlanDraftBuildProgress) => void;
}

interface DraftCheckpointPayload {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly workouts: readonly PlanWorkoutRecord[];
}

interface PreparedCheckpoint {
  readonly record: PlanDraftBuildCheckpointRecord | null;
  readonly planId: string;
  readonly draftRevisionId: string | undefined;
  readonly workouts: readonly PlanWorkoutRecord[];
}

const WEEKDAY_NUMBER: Readonly<Record<PlanIntakeWeekday, number>> = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

const WEEKDAY_NAME: Readonly<Record<string, PlanIntakeWeekday>> = Object.freeze({
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  wed: "wed",
  wednesday: "wed",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
  sun: "sun",
  sunday: "sun",
});

const POWER_RANGE: Readonly<Record<GeneratedWorkoutType, readonly [number, number]>> =
  Object.freeze({
    endurance: [0.56, 0.75],
    sweet_spot: [0.88, 0.94],
    threshold: [0.91, 1.05],
    long: [0.56, 0.75],
    recovery: [0.45, 0.54],
    opener: [0.91, 1.05],
    race: [0.65, 0.85],
  });

function completeIntake(value: PlanIntakeRecord | undefined): DraftIntakeFacts {
  if (
    value === undefined ||
    value.eventName === null ||
    value.eventPriority === null ||
    value.eventDateKey === null ||
    value.athleteGoal === null ||
    value.availabilitySessionsPerWeek === null ||
    value.experience === null
  ) {
    throw new CyclingPlanDraftBuildError("incomplete-intake");
  }
  if (
    value.availabilitySessionsPerWeek < 1 ||
    value.availabilitySessionsPerWeek > 6 ||
    value.availabilityWeekdays.length < value.availabilitySessionsPerWeek
  ) {
    throw new CyclingPlanDraftBuildError("invalid-availability");
  }
  return Object.freeze({
    eventName: value.eventName,
    eventPriority: value.eventPriority,
    eventDateKey: value.eventDateKey,
    athleteGoal: value.athleteGoal,
    availabilitySessionsPerWeek: value.availabilitySessionsPerWeek,
    availabilityWeekdays: Object.freeze([...value.availabilityWeekdays]),
    experience: value.experience,
    currentTrainingSummary: value.currentTrainingSummary,
  });
}

function completeFtp(value: PlanFtpSnapshot): DraftFtpFacts {
  if (value.usedSource === null || value.usedWatts === null) {
    throw new CyclingPlanDraftBuildError("incomplete-intake");
  }
  return Object.freeze({ usedSource: value.usedSource, usedWatts: value.usedWatts });
}

function durationSeconds(value: string): number {
  const minutes = /^(\d+(?:\.\d+)?)min$/u.exec(value);
  if (minutes !== null) return Math.round(Number(minutes[1]) * 60);
  const hours = /^(\d+(?:\.\d+)?)h$/u.exec(value);
  if (hours !== null) return Math.round(Number(hours[1]) * 3_600);
  throw new TypeError("Cycling workout duration is invalid.");
}

function volumeTier(sessionsPerWeek: number): "low" | "medium" | "high" {
  if (sessionsPerWeek <= 3) return "low";
  if (sessionsPerWeek === 4) return "medium";
  return "high";
}

function referenceFoundation(input: {
  readonly conversationId: string;
  readonly intake: DraftIntakeFacts;
  readonly ftp: DraftFtpFacts;
  readonly totalWeeks: number;
}) {
  const skeleton = buildPlanSkeleton(
    {
      experienceLevel: input.intake.experience,
      ftpWatts: input.ftp.usedWatts,
      volumeTier: volumeTier(input.intake.availabilitySessionsPerWeek),
      scheduleType: "fixed",
      availableDays: [...input.intake.availabilityWeekdays],
      keySessionDay: input.intake.availabilityWeekdays.at(-1),
      sessionsPerWeek: input.intake.availabilitySessionsPerWeek,
      needsExtraRecovery: false,
      goalType: "race",
      raceType: "gran_fondo",
      generalGoal: input.intake.athleteGoal,
    },
    "UTC",
    {
      id: input.conversationId,
      now: "1970-01-01T00:00:00.000Z",
      totalWeeks: input.totalWeeks,
    },
  );
  return {
    cycleLength: skeleton.cycleLength,
    cycleStructureDescription: skeleton.cycleStructureDescription,
    phases: skeleton.phases,
    zoneTables: skeleton.zoneTables,
    testingProtocols: skeleton.testingProtocols,
    volumeSummary: skeleton.volumeSummary,
    schedulePreferences: skeleton.schedulePreferences,
    totalWeeks: input.totalWeeks,
  };
}

function seasonWeeks(
  totalWeeks: number,
  experience: DraftIntakeFacts["experience"] = "intermediate",
): readonly SeasonWeek[] {
  const taperWeeks = Math.min(2, totalWeeks);
  const taperStart = totalWeeks - taperWeeks + 1;
  const buildableWeeks = Math.max(0, taperStart - 1);
  const baseEnd = Math.max(1, Math.floor(buildableWeeks * 0.5));
  const recoveryCadence = BUILD_RECOVERY_RATIOS[experience].build + 1;
  return Object.freeze(
    Array.from({ length: totalWeeks }, (_, offset): SeasonWeek => {
      const weekIndex = offset + 1;
      if (weekIndex >= taperStart) {
        return { weekIndex, phase: "Taper", purpose: "Reduce volume; keep sharpness" };
      }
      if (weekIndex % recoveryCadence === 0) {
        return { weekIndex, phase: "Recovery", purpose: "Absorb the training block" };
      }
      if (weekIndex <= baseEnd) {
        return { weekIndex, phase: "Base", purpose: "Build aerobic durability" };
      }
      return { weekIndex, phase: "Build", purpose: "Practice race demands" };
    }),
  );
}

function phaseFocus(phase: SeasonWeek["phase"]): string {
  if (phase === "Base") return "base_building";
  if (phase === "Build") return "race_prep";
  if (phase === "Recovery") return "recovery";
  return "taper";
}

function phases(weeks: readonly SeasonWeek[], sessionsPerWeek: number): readonly unknown[] {
  const result: Array<Record<string, unknown>> = [];
  for (const week of weeks) {
    const previous = result.at(-1);
    if (previous?.name === week.phase && previous.purpose === week.purpose) {
      previous.durationWeeks = Number(previous.durationWeeks) + 1;
      previous.durationCycles = Number(previous.durationCycles) + 1;
      continue;
    }
    result.push({
      number: result.length + 1,
      name: week.phase,
      displayName: week.phase,
      purpose: week.purpose,
      durationWeeks: 1,
      durationCycles: 1,
      focus: phaseFocus(week.phase),
      volumeTargets: { cycling: { sessionsPerCycle: sessionsPerWeek } },
      keyAdditions: [],
    });
  }
  return Object.freeze(result.map((phase) => Object.freeze(phase)));
}

function snapshotExperience(value: unknown): DraftIntakeFacts["experience"] {
  if (value === null || typeof value !== "object" || !("intake" in value)) return "intermediate";
  const intake = value.intake;
  if (intake === null || typeof intake !== "object" || !("experience" in intake)) {
    return "intermediate";
  }
  const experience = intake.experience;
  return experience === "beginner" ||
    experience === "intermediate" ||
    experience === "advanced" ||
    experience === "elite"
    ? experience
    : "intermediate";
}

function currentTrainingSessions(summary: string | null): number | null {
  if (summary === null) return null;
  const normalized = summary.toLowerCase();
  const digits = /\b([1-6])\s+(?:rides?|sessions?|times?)\b/u.exec(normalized);
  if (digits !== null) return Number(digits[1]);
  const words: Readonly<Record<string, number>> = Object.freeze({
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  });
  const named = /\b(one|two|three|four|five|six)\s+(?:rides?|sessions?|times?)\b/u.exec(normalized);
  return named === null ? null : (words[named[1]] ?? null);
}

function progressionMultiplier(input: {
  readonly week: SeasonWeek;
  readonly intake: DraftIntakeFacts;
}): number {
  const experienceStart: Readonly<Record<DraftIntakeFacts["experience"], number>> = Object.freeze({
    beginner: 0.86,
    intermediate: 0.92,
    advanced: 0.96,
    elite: 1,
  });
  const experienceRate: Readonly<Record<DraftIntakeFacts["experience"], number>> = Object.freeze({
    beginner: 0.01,
    intermediate: 0.015,
    advanced: 0.0175,
    elite: 0.02,
  });
  const reportedSessions = currentTrainingSessions(input.intake.currentTrainingSummary);
  const sessionGap =
    reportedSessions === null
      ? 0
      : Math.max(0, input.intake.availabilitySessionsPerWeek - reportedSessions);
  const baseline = Math.max(0.78, experienceStart[input.intake.experience] - sessionGap * 0.03);
  const rampWeeks = BUILD_RECOVERY_RATIOS[input.intake.experience].build;
  const baselineRamp =
    baseline + (1 - baseline) * Math.min(1, (input.week.weekIndex - 1) / rampWeeks);
  const progression = Math.min(
    input.week.phase === "Build" ? 0.12 : 0.08,
    (input.week.weekIndex - 1) * experienceRate[input.intake.experience],
  );
  return baselineRamp * (1 + progression);
}

function courseTrainingProfile(course: RaceCourseSnapshot | null): CourseTrainingProfile {
  if (course === null) {
    return { climbingFocus: false, durabilityMultiplier: 1, taperMultiplier: 0.6 };
  }
  const distanceKm = course.preview.distanceM / 1_000;
  const elevationGainM = course.preview.elevationGainM ?? 0;
  const distanceLoad = Math.max(0, Math.min(0.04, (distanceKm - 80) / 1_000));
  const elevationLoad = Math.max(0, Math.min(0.04, elevationGainM / 37_500));
  const addedLoad = distanceLoad + elevationLoad;
  return {
    climbingFocus: elevationGainM >= 800 && elevationGainM / Math.max(1, distanceKm) >= 7,
    durabilityMultiplier: 1 + addedLoad,
    taperMultiplier: 0.6 - addedLoad / 2,
  };
}

function weekMultiplier(input: {
  readonly week: SeasonWeek;
  readonly intake: DraftIntakeFacts;
  readonly course: RaceCourseSnapshot | null;
}): number {
  const profile = courseTrainingProfile(input.course);
  const progression = progressionMultiplier({ week: input.week, intake: input.intake });
  if (input.week.phase === "Recovery") return 0.7 * progression;
  if (input.week.phase === "Taper") return profile.taperMultiplier * progression;
  if (input.week.phase === "Build") return progression;
  return 0.9 * progression;
}

function weekdayDate(weekStartDateKey: number, weekday: PlanIntakeWeekday): number {
  return addCivilDays(
    weekStartDateKey,
    (WEEKDAY_NUMBER[weekday] - weekdayForDateKey(weekStartDateKey) + 7) % 7,
  );
}

function sampleDay(value: SampleWorkout): PlanIntakeWeekday {
  const weekday = value.day === undefined ? undefined : WEEKDAY_NAME[value.day.toLowerCase()];
  if (weekday === undefined) throw new TypeError("Cycling workout weekday is invalid.");
  return weekday;
}

function workoutSlot(value: PlanWorkoutRecord): string | null {
  try {
    const structure = JSON.parse(value.structureJson) as Record<string, unknown>;
    return typeof structure.slot === "string" ? structure.slot : null;
  } catch {
    return null;
  }
}

function existingWorkoutIds(snapshot: DraftSnapshot | null): ReadonlyMap<string, string> {
  if (snapshot === null) return new Map();
  return workoutIds(snapshot.draft.workouts);
}

function workoutIds(workouts: readonly PlanWorkoutRecord[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const workout of workouts) {
    const slot = workoutSlot(workout);
    if (slot !== null && !ids.has(slot)) ids.set(slot, workout.id);
  }
  return ids;
}

function planAllowedWeekdays(plan: PlanRecord): ReadonlySet<number> {
  try {
    const structure = JSON.parse(plan.structureJson) as {
      readonly schedulePreferences?: { readonly availableDays?: readonly unknown[] };
    };
    const days = structure.schedulePreferences?.availableDays;
    if (!Array.isArray(days)) return new Set();
    return new Set(
      days.flatMap((day) =>
        typeof day === "string" && day in WEEKDAY_NUMBER
          ? [WEEKDAY_NUMBER[day as PlanIntakeWeekday]]
          : [],
      ),
    );
  } catch {
    return new Set();
  }
}

function raceDurationS(course: RaceCourseSnapshot | null): number {
  if (course === null) return 18_000;
  const elevationGainM = course.preview.elevationGainM ?? 0;
  const averageSpeedKph = 25 - Math.min(5, elevationGainM / 1_000);
  return Math.max(3_600, Math.round((course.preview.distanceM / 1_000 / averageSpeedKph) * 3_600));
}

function courseSummary(course: RaceCourseSnapshot | null): DraftSnapshot["course"] {
  return course === null
    ? null
    : {
        fileName: course.fileName,
        distanceM: course.preview.distanceM,
        elevationGainM: course.preview.elevationGainM,
      };
}

function parseSnapshot(previous: PlanDraftRevisionRecord): DraftSnapshot {
  try {
    const value = JSON.parse(previous.snapshotJson) as DraftSnapshot;
    if (
      value.schemaVersion !== 1 ||
      value.builder !== "cycling-plan-draft" ||
      value.draft.plan.id !== previous.planId ||
      !Array.isArray(value.draft.workouts) ||
      !Array.isArray(value.evidence.revisions)
    ) {
      throw new TypeError("invalid snapshot");
    }
    return value;
  } catch {
    throw new CyclingPlanDraftBuildError("invalid-previous-draft");
  }
}

function snapshot(input: {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly intake: DraftIntakeFacts;
  readonly ftp: DraftFtpFacts;
  readonly course: RaceCourseSnapshot | null;
  readonly weeks: readonly SeasonWeek[];
  readonly revisions: readonly DraftRevisionEvidence[];
}): DraftSnapshot {
  return {
    schemaVersion: 1,
    builder: "cycling-plan-draft",
    intake: {
      eventName: input.intake.eventName,
      eventPriority: input.intake.eventPriority,
      eventDateKey: input.intake.eventDateKey,
      athleteGoal: input.intake.athleteGoal,
      availabilitySessionsPerWeek: input.intake.availabilitySessionsPerWeek,
      availabilityWeekdays: input.intake.availabilityWeekdays,
      experience: input.intake.experience,
      currentTrainingSummary: input.intake.currentTrainingSummary,
    },
    ftp: { source: input.ftp.usedSource, watts: input.ftp.usedWatts },
    course: courseSummary(input.course),
    evidence: {
      completeWeeks: input.weeks.length,
      workoutCount: input.workouts.length,
      seasonWeeks: input.weeks,
      revisions: input.revisions,
    },
    draft: { plan: input.plan, workouts: input.workouts },
  };
}

function checkpointPayload(value: string, planId: string): DraftCheckpointPayload {
  try {
    const parsed = JSON.parse(value) as DraftCheckpointPayload;
    if (parsed.schemaVersion !== 1 || parsed.planId !== planId || !Array.isArray(parsed.workouts)) {
      throw new TypeError("invalid checkpoint");
    }
    return parsed;
  } catch {
    throw new CyclingPlanDraftBuildError("invalid-previous-draft");
  }
}

async function prepareCheckpoint(
  dependencies: CyclingPlanDraftBuilderDependencies,
  input: {
    readonly conversationId: string;
    readonly buildKey: string;
    readonly operation: PlanDraftBuildOperation;
    readonly requestedPlanId: string | null;
    readonly targetRevision: number;
    readonly totalWeeks: number;
  },
): Promise<PreparedCheckpoint> {
  if (dependencies.checkpoints === undefined) {
    return {
      record: null,
      planId: input.requestedPlanId ?? dependencies.identity.newUlid(),
      draftRevisionId: undefined,
      workouts: [],
    };
  }
  const existing = await dependencies.checkpoints.read(input.conversationId);
  if (existing?.buildKey === input.buildKey) {
    if (
      existing.operation !== input.operation ||
      existing.targetRevision !== input.targetRevision ||
      existing.totalWeeks !== input.totalWeeks ||
      (input.requestedPlanId !== null && existing.planId !== input.requestedPlanId)
    ) {
      throw new CyclingPlanDraftBuildError("invalid-previous-draft");
    }
    const payload = checkpointPayload(existing.payloadJson, existing.planId);
    return {
      record: existing,
      planId: existing.planId,
      draftRevisionId: existing.draftRevisionId,
      workouts: payload.workouts,
    };
  }
  const stamp = dependencies.identity.hlcStamp();
  const planId = input.requestedPlanId ?? dependencies.identity.newUlid();
  const record = await dependencies.checkpoints.save({
    id: dependencies.identity.newUlid(),
    conversationId: input.conversationId,
    buildKey: input.buildKey,
    operation: input.operation,
    planId,
    draftRevisionId: dependencies.identity.newUlid(),
    targetRevision: input.targetRevision,
    completedWeeks: 0,
    totalWeeks: input.totalWeeks,
    payloadJson: JSON.stringify({ schemaVersion: 1, planId, workouts: [] }),
    createdAtMs: stamp.physicalMs,
    updatedAtMs: stamp.physicalMs,
    deviceId: await dependencies.identity.deviceId(),
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
  return {
    record,
    planId,
    draftRevisionId: record.draftRevisionId,
    workouts: [],
  };
}

interface GenerateWeekInput {
  readonly plan: PlanRecord;
  readonly week: SeasonWeek;
  readonly sample: readonly SampleWorkout[];
  readonly intake: DraftIntakeFacts;
  readonly ftpWatts: number;
  readonly eventName: string;
  readonly course: RaceCourseSnapshot | null;
  readonly targetDateKey: number;
  readonly deviceId: string;
  readonly ids: ReadonlyMap<string, string>;
}

interface ScheduledWorkout {
  readonly workout: SampleWorkout;
  readonly sessionIndex: number;
  readonly dateKey: number;
  readonly overrideType?: GeneratedWorkoutType;
  readonly overrideName?: string;
  readonly overrideDurationS?: number;
}

function generatedWorkoutType(
  week: SeasonWeek,
  workout: SampleWorkout,
  overrideType?: GeneratedWorkoutType,
): GeneratedWorkoutType {
  if (overrideType !== undefined) return overrideType;
  if (week.phase !== "Recovery") return workout.type;
  return workout.type === "recovery" ? "recovery" : "endurance";
}

function generatedDurationS(input: {
  readonly week: SeasonWeek;
  readonly workout: SampleWorkout;
  readonly intake: DraftIntakeFacts;
  readonly course: RaceCourseSnapshot | null;
  readonly overrideDurationS?: number;
}): number {
  if (input.overrideDurationS !== undefined) return input.overrideDurationS;
  const courseMultiplier =
    input.workout.type === "long" && input.week.phase !== "Recovery" && input.week.phase !== "Taper"
      ? courseTrainingProfile(input.course).durabilityMultiplier
      : 1;
  const duration = Math.max(
    600,
    Math.round(
      durationSeconds(input.workout.duration) *
        weekMultiplier({ week: input.week, intake: input.intake, course: input.course }) *
        courseMultiplier,
    ),
  );
  return input.week.phase === "Recovery" ? Math.min(7_200, duration) : Math.min(21_600, duration);
}

function minutes(valueS: number): number {
  return Number((valueS / 60).toFixed(2));
}

function workoutDocument(input: {
  readonly name: string;
  readonly workoutType: GeneratedWorkoutType;
  readonly durationS: number;
  readonly climbingFocus: boolean;
}): IntervalsWorkoutInput {
  const totalMinutes = minutes(input.durationS);
  const isGoalEvent = input.workoutType === "opener" || input.workoutType === "race";
  const warmupMinutes = Math.min(
    isGoalEvent ? 15 : input.workoutType === "recovery" ? 5 : 10,
    totalMinutes * 0.25,
  );
  const cooldownMinutes = Math.min(
    isGoalEvent ? 10 : input.workoutType === "recovery" ? 5 : 10,
    totalMinutes * 0.2,
  );
  const mainMinutes = totalMinutes - warmupMinutes - cooldownMinutes;
  const warmup = {
    type: "warmup" as const,
    duration: { value: warmupMinutes, unit: "minutes" as const },
    power: {
      kind: "percent_ftp" as const,
      low: 45,
      high: input.workoutType === "recovery" ? 54 : 65,
    },
  };
  const cooldown = {
    type: "cooldown" as const,
    duration: { value: cooldownMinutes, unit: "minutes" as const },
    power: { kind: "percent_ftp" as const, value: 45 },
  };
  let steps: IntervalsWorkoutInput["steps"];
  if (input.workoutType === "sweet_spot" || input.workoutType === "threshold") {
    const repeat = input.workoutType === "sweet_spot" ? 3 : 4;
    const recoveryMinutes = input.workoutType === "sweet_spot" ? 3 : 2;
    const intervalMinutes = (mainMinutes - recoveryMinutes * repeat) / repeat;
    const range = POWER_RANGE[input.workoutType];
    steps = [
      warmup,
      {
        type: "set",
        repeat,
        interval: {
          type: "interval",
          duration: { value: intervalMinutes, unit: "minutes" },
          power: {
            kind: "percent_ftp",
            low: Math.round(range[0] * 100),
            high: Math.round(range[1] * 100),
          },
          cadence: input.climbingFocus ? { low: 75, high: 85 } : { low: 85, high: 95 },
        },
        recovery: {
          type: "recovery",
          duration: { value: recoveryMinutes, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      },
      cooldown,
    ];
  } else if (input.workoutType === "opener") {
    const openerSetMinutes = 7.5;
    steps = [
      warmup,
      {
        type: "steady",
        duration: { value: mainMinutes - openerSetMinutes, unit: "minutes" },
        power: { kind: "percent_ftp", low: 56, high: 70 },
      },
      {
        type: "set",
        repeat: 3,
        interval: {
          type: "interval",
          duration: { value: 30, unit: "seconds" },
          power: { kind: "percent_ftp", value: 120 },
        },
        recovery: {
          type: "recovery",
          duration: { value: 2, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      },
      cooldown,
    ];
  } else {
    const range = POWER_RANGE[input.workoutType];
    steps = [
      warmup,
      {
        type: input.workoutType === "recovery" ? "recovery" : "steady",
        duration: { value: mainMinutes, unit: "minutes" },
        power: {
          kind: "percent_ftp",
          low: Math.round(range[0] * 100),
          high: Math.round(range[1] * 100),
        },
        cadence:
          input.workoutType === "recovery"
            ? { low: 90, high: 100 }
            : input.climbingFocus
              ? { low: 75, high: 85 }
              : { low: 85, high: 95 },
      },
      cooldown,
    ];
  }
  return intervalsWorkoutInputSchema.parse({ name: input.name, steps });
}

function structuredWorkoutContent(input: {
  readonly name: string;
  readonly workoutType: GeneratedWorkoutType;
  readonly durationS: number;
  readonly climbingFocus: boolean;
}): {
  readonly description: string;
  readonly workoutDoc: IntervalsWorkoutInput;
} {
  const workoutDoc = workoutDocument(input);
  const serialized = serializeIntervalsWorkout(workoutDoc);
  if (serialized.movingTime !== input.durationS) {
    throw new CyclingPlanDraftBuildError("invalid-availability");
  }
  return { description: serialized.description, workoutDoc };
}

function isGeneratedWorkoutType(value: unknown): value is GeneratedWorkoutType {
  return (
    value === "endurance" ||
    value === "sweet_spot" ||
    value === "threshold" ||
    value === "long" ||
    value === "recovery" ||
    value === "opener" ||
    value === "race"
  );
}

function raceWeekSchedule(input: {
  readonly scheduled: readonly ScheduledWorkout[];
  readonly targetDateKey: number;
  readonly preparationSlots: number;
}): readonly ScheduledWorkout[] {
  if (input.preparationSlots === 0) return [];
  const candidates = input.scheduled.map((scheduled) => ({
    ...scheduled,
    daysToEvent: inclusiveCivilDays(scheduled.dateKey, input.targetDateKey) - 1,
  }));
  const opener = candidates
    .filter(({ daysToEvent }) => daysToEvent >= 2 && daysToEvent <= 4)
    .sort((left, right) => left.daysToEvent - right.daysToEvent)[0];
  const selected = candidates
    .filter((candidate) => candidate !== opener)
    .sort((left, right) => right.daysToEvent - left.daysToEvent)
    .slice(0, Math.max(0, input.preparationSlots - (opener === undefined ? 0 : 1)));
  if (opener !== undefined) selected.push(opener);
  return Object.freeze(
    selected
      .sort((left, right) => left.dateKey - right.dateKey)
      .map(({ daysToEvent, ...scheduled }) =>
        opener !== undefined && scheduled.sessionIndex === opener.sessionIndex
          ? {
              ...scheduled,
              overrideType: "opener" as const,
              overrideName: "Race opener",
              overrideDurationS: 2_400,
            }
          : {
              ...scheduled,
              overrideType: daysToEvent === 1 ? ("recovery" as const) : ("endurance" as const),
              overrideName: daysToEvent === 1 ? "Pre-race spin" : "Easy endurance",
              overrideDurationS: daysToEvent === 1 ? 1_800 : 3_600,
            },
      ),
  );
}

function generateWeekWorkouts(
  dependencies: CyclingPlanDraftBuilderDependencies,
  input: GenerateWeekInput,
): readonly PlanWorkoutRecord[] {
  const range = planWeekRange(input.plan, input.week.weekIndex);
  const scheduled: readonly ScheduledWorkout[] = input.sample
    .map(
      (workout, sessionIndex): ScheduledWorkout => ({
        workout,
        sessionIndex,
        dateKey: weekdayDate(range.startDateKey, sampleDay(workout)),
      }),
    )
    .filter(({ dateKey }) => dateKey <= input.targetDateKey && dateKey !== input.targetDateKey);
  const isRaceWeek = input.week.weekIndex === input.plan.totalWeeks;
  const selected = isRaceWeek
    ? raceWeekSchedule({
        scheduled,
        targetDateKey: input.targetDateKey,
        preparationSlots: Math.max(0, input.intake.availabilitySessionsPerWeek - 1),
      })
    : scheduled;
  const courseProfile = courseTrainingProfile(input.course);
  const workouts: PlanWorkoutRecord[] = selected.map(
    ({
      workout,
      sessionIndex,
      dateKey,
      overrideType,
      overrideName,
      overrideDurationS,
    }): PlanWorkoutRecord => {
      const slot = `week:${input.week.weekIndex}:session:${sessionIndex}`;
      const stamp = dependencies.identity.hlcStamp();
      const workoutType = generatedWorkoutType(input.week, workout, overrideType);
      const powerRange = POWER_RANGE[workoutType];
      const durationS = generatedDurationS({
        week: input.week,
        workout,
        intake: input.intake,
        course: input.course,
        overrideDurationS,
      });
      const baseName =
        overrideName ??
        (input.week.phase === "Recovery" && workoutType !== workout.type
          ? "Easy endurance"
          : workout.name.replace(/\s+\d+(?:\.\d+)?(?:min|h)$/u, ""));
      const name =
        courseProfile.climbingFocus &&
        input.week.phase === "Build" &&
        (workoutType === "long" || workoutType === "sweet_spot" || workoutType === "threshold")
          ? `Climbing ${baseName.toLowerCase()}`
          : baseName;
      const content = structuredWorkoutContent({
        name,
        workoutType,
        durationS,
        climbingFocus: courseProfile.climbingFocus,
      });
      return {
        id: input.ids.get(slot) ?? dependencies.identity.newUlid(),
        planId: input.plan.id,
        dateKey,
        sport: "cycling",
        name,
        durationS,
        structureJson: JSON.stringify({
          schemaVersion: 1,
          slot,
          weekIndex: input.week.weekIndex,
          phase: input.week.phase,
          purpose: input.week.purpose,
          workoutType,
          ftpWatts: input.ftpWatts,
          powerWatts: {
            low: Math.round(input.ftpWatts * powerRange[0]),
            high: Math.round(input.ftpWatts * powerRange[1]),
          },
          courseProfile,
          ...content,
        }),
        origin: "coach",
        deviceId: input.deviceId,
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      };
    },
  );
  if (isRaceWeek) {
    const stamp = dependencies.identity.hlcStamp();
    const durationS = raceDurationS(input.course);
    const content = structuredWorkoutContent({
      name: input.eventName,
      workoutType: "race",
      durationS,
      climbingFocus: courseProfile.climbingFocus,
    });
    workouts.push({
      id: input.ids.get("race") ?? dependencies.identity.newUlid(),
      planId: input.plan.id,
      dateKey: input.targetDateKey,
      sport: "cycling",
      name: input.eventName,
      durationS,
      structureJson: JSON.stringify({
        schemaVersion: 1,
        slot: "race",
        weekIndex: input.week.weekIndex,
        phase: input.week.phase,
        purpose: "Goal Event",
        workoutType: "race",
        course: courseSummary(input.course),
        courseProfile,
        ...content,
      }),
      origin: "coach",
      deviceId: input.deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  }
  return Object.freeze(workouts);
}

function expectedWeekWorkoutCount(input: {
  readonly plan: PlanRecord;
  readonly week: SeasonWeek;
  readonly sample: readonly SampleWorkout[];
  readonly intake: DraftIntakeFacts;
  readonly targetDateKey: number;
}): number {
  const range = planWeekRange(input.plan, input.week.weekIndex);
  const scheduled = input.sample.filter((workout) => {
    const dateKey = weekdayDate(range.startDateKey, sampleDay(workout));
    return dateKey <= input.targetDateKey && dateKey !== input.targetDateKey;
  }).length;
  if (input.week.weekIndex !== input.plan.totalWeeks) return scheduled;
  return (
    raceWeekSchedule({
      scheduled: input.sample
        .map((workout, sessionIndex) => ({
          workout,
          sessionIndex,
          dateKey: weekdayDate(range.startDateKey, sampleDay(workout)),
        }))
        .filter(({ dateKey }) => dateKey <= input.targetDateKey && dateKey !== input.targetDateKey),
      targetDateKey: input.targetDateKey,
      preparationSlots: Math.max(0, input.intake.availabilitySessionsPerWeek - 1),
    }).length + 1
  );
}

function validateGeneratedWeek(
  plan: PlanRecord,
  week: SeasonWeek,
  workouts: readonly PlanWorkoutRecord[],
  targetDateKey: number,
  options: {
    readonly allowedWeekdays?: ReadonlySet<number>;
    readonly expectedCount?: number;
  } = {},
): void {
  const dates = new Set<number>();
  const ids = new Set<string>();
  let targetEvents = 0;
  for (const workout of workouts) {
    validatePlanWorkoutRecord(plan, workout);
    const location = planWeekIndex(plan, workout.dateKey);
    if (location.kind !== "inside" || location.weekIndex !== week.weekIndex) {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    if (workout.sport !== "cycling" || workout.durationS === null || workout.durationS <= 0) {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    if (dates.has(workout.dateKey) || ids.has(workout.id) || workout.dateKey > targetDateKey) {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    dates.add(workout.dateKey);
    ids.add(workout.id);
    if (workout.dateKey === targetDateKey) targetEvents += 1;
    let structure: Record<string, unknown>;
    try {
      structure = JSON.parse(workout.structureJson) as Record<string, unknown>;
    } catch {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    if (structure.weekIndex !== week.weekIndex) {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    const workoutDoc = intervalsWorkoutInputSchema.safeParse(structure.workoutDoc);
    if (
      !workoutDoc.success ||
      serializeIntervalsWorkout(workoutDoc.data).movingTime !== workout.durationS
    ) {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    const isRace = structure.slot === "race";
    if (
      !isRace &&
      options.allowedWeekdays !== undefined &&
      !options.allowedWeekdays.has(weekdayForDateKey(workout.dateKey))
    ) {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    if (!isRace && workout.durationS > 21_600) {
      throw new CyclingPlanDraftBuildError("invalid-availability");
    }
    if (week.phase === "Recovery" && !isRace) {
      const workoutType = structure.workoutType;
      const powerWatts = structure.powerWatts as Record<string, unknown> | undefined;
      const ftpWatts = structure.ftpWatts;
      if (
        (workoutType !== "recovery" && workoutType !== "endurance") ||
        workout.durationS > 7_200 ||
        typeof ftpWatts !== "number" ||
        typeof powerWatts?.high !== "number" ||
        powerWatts.high > Math.round(ftpWatts * 0.75)
      ) {
        throw new CyclingPlanDraftBuildError("invalid-availability");
      }
    }
  }
  if (options.expectedCount !== undefined && workouts.length !== options.expectedCount) {
    throw new CyclingPlanDraftBuildError("invalid-availability");
  }
  if (workouts.length > 6) throw new CyclingPlanDraftBuildError("invalid-availability");
  if (week.weekIndex === plan.totalWeeks) {
    if (targetEvents !== 1) throw new CyclingPlanDraftBuildError("invalid-target-date");
  } else if (targetEvents !== 0) {
    throw new CyclingPlanDraftBuildError("invalid-target-date");
  }
}

function replaceWeekWorkouts(
  plan: PlanRecord,
  workouts: PlanWorkoutRecord[],
  weekIndex: number,
  replacement: readonly PlanWorkoutRecord[],
): void {
  const retained = workouts.filter((workout) => {
    const location = planWeekIndex(plan, workout.dateKey);
    return location.kind !== "inside" || location.weekIndex !== weekIndex;
  });
  workouts.splice(0, workouts.length, ...retained, ...replacement);
}

function buildInputKey(input: {
  readonly operation: PlanDraftBuildOperation;
  readonly conversationId: string;
  readonly previousRevisionId: string | null;
  readonly intake: DraftIntakeFacts;
  readonly ftp: DraftFtpFacts;
  readonly course: RaceCourseSnapshot | null;
  readonly startDateKey: number;
  readonly targetDateKey: number;
  readonly totalWeeks: number;
  readonly instruction?: string;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    operation: input.operation,
    conversationId: input.conversationId,
    previousRevisionId: input.previousRevisionId,
    intake: input.intake,
    ftp: input.ftp,
    course: courseSummary(input.course),
    startDateKey: input.startDateKey,
    targetDateKey: input.targetDateKey,
    totalWeeks: input.totalWeeks,
    instruction: input.instruction ?? null,
  });
}

async function checkpointCompletedBuild(
  dependencies: CyclingPlanDraftBuilderDependencies,
  input: {
    readonly conversationId: string;
    readonly buildKey: string;
    readonly operation: PlanDraftBuildOperation;
    readonly targetRevision: number;
    readonly build: PlanDraftBuild;
    readonly onProgress?: (progress: PlanDraftBuildProgress) => void;
  },
): Promise<PlanDraftBuild> {
  const totalWeeks = input.build.plan.totalWeeks;
  const prepared = await prepareCheckpoint(dependencies, {
    conversationId: input.conversationId,
    buildKey: input.buildKey,
    operation: input.operation,
    requestedPlanId: input.build.plan.id,
    targetRevision: input.targetRevision,
    totalWeeks,
  });
  if (prepared.record === null || dependencies.checkpoints === undefined) {
    input.onProgress?.({ completedWeeks: totalWeeks, totalWeeks });
    return input.build;
  }
  for (const week of seasonWeeks(totalWeeks, snapshotExperience(input.build.snapshot))) {
    const allowedWeekdays = planAllowedWeekdays(input.build.plan);
    validateGeneratedWeek(
      input.build.plan,
      week,
      input.build.workouts.filter((workout) => {
        const location = planWeekIndex(input.build.plan, workout.dateKey);
        return location.kind === "inside" && location.weekIndex === week.weekIndex;
      }),
      input.build.plan.targetDateKey ?? planWeekRange(input.build.plan, totalWeeks).endDateKey,
      { allowedWeekdays: allowedWeekdays.size === 0 ? undefined : allowedWeekdays },
    );
  }
  const stamp = dependencies.identity.hlcStamp();
  const checkpoint = await dependencies.checkpoints.save({
    ...prepared.record,
    completedWeeks: totalWeeks,
    payloadJson: JSON.stringify({
      schemaVersion: 1,
      planId: input.build.plan.id,
      workouts: input.build.workouts,
    } satisfies DraftCheckpointPayload),
    updatedAtMs: stamp.physicalMs,
    deviceId: await dependencies.identity.deviceId(),
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
  input.onProgress?.({ completedWeeks: totalWeeks, totalWeeks });
  return {
    ...input.build,
    checkpointId: checkpoint.id,
    draftRevisionId: checkpoint.draftRevisionId,
  };
}

async function generateDraft(
  dependencies: CyclingPlanDraftBuilderDependencies,
  input: BuildInputs,
): Promise<PlanDraftBuild> {
  const prepared = await prepareCheckpoint(dependencies, {
    conversationId: input.conversation.id,
    buildKey: input.buildKey,
    operation: input.operation,
    requestedPlanId: input.previous?.draft.plan.id ?? null,
    targetRevision: input.targetRevision,
    totalWeeks: input.totalWeeks,
  });
  const deviceId = await dependencies.identity.deviceId();
  const planStamp = dependencies.identity.hlcStamp();
  const weeks = seasonWeeks(input.totalWeeks, input.intake.experience);
  const previousIds = existingWorkoutIds(input.previous);
  const plan: PlanRecord = {
    id: prepared.planId,
    originId: null,
    name: `${input.intake.eventName} Plan`,
    primaryGoal: input.intake.athleteGoal,
    startDateKey: input.startDateKey,
    targetDateKey: input.targetDateKey,
    status: "draft",
    kind:
      inclusiveCivilDays(input.startDateKey, input.targetDateKey) >= MIN_FULL_PLAN_DAYS
        ? "full_plan"
        : "short_race_preparation",
    totalWeeks: input.totalWeeks,
    weekStartDay: weekdayForDateKey(input.startDateKey),
    structureJson: "{}",
    createdAtMs: input.previous?.draft.plan.createdAtMs ?? planStamp.physicalMs,
    updatedAtMs: planStamp.physicalMs,
    deviceId,
    hlcPhysicalMs: planStamp.physicalMs,
    hlcCounter: planStamp.counter,
  };
  const selectedWeekdays = input.intake.availabilityWeekdays.slice(
    0,
    input.intake.availabilitySessionsPerWeek,
  );
  const sample = getSampleWeek(
    volumeTier(input.intake.availabilitySessionsPerWeek),
    "fixed",
    [...selectedWeekdays],
    selectedWeekdays.at(-1),
    input.intake.availabilitySessionsPerWeek,
  );
  if (sample.length !== input.intake.availabilitySessionsPerWeek) {
    throw new CyclingPlanDraftBuildError("invalid-availability");
  }
  const allowedWeekdays = new Set(
    input.intake.availabilityWeekdays.map((weekday) => WEEKDAY_NUMBER[weekday]),
  );
  let checkpoint = prepared.record;
  const completedWeeks = checkpoint?.completedWeeks ?? 0;
  const workouts: PlanWorkoutRecord[] = [...prepared.workouts];
  for (const workout of workouts) {
    const location = planWeekIndex(plan, workout.dateKey);
    if (location.kind !== "inside" || location.weekIndex > completedWeeks) {
      throw new CyclingPlanDraftBuildError("invalid-previous-draft");
    }
  }
  let repairedCheckpoint = false;
  for (const week of weeks.slice(0, completedWeeks)) {
    const restored = workouts.filter((workout) => {
      const location = planWeekIndex(plan, workout.dateKey);
      return location.kind === "inside" && location.weekIndex === week.weekIndex;
    });
    const expectedCount = expectedWeekWorkoutCount({
      plan,
      week,
      sample,
      intake: input.intake,
      targetDateKey: input.targetDateKey,
    });
    try {
      validateGeneratedWeek(plan, week, restored, input.targetDateKey, {
        allowedWeekdays,
        expectedCount,
      });
    } catch (error) {
      if (!(error instanceof CyclingPlanDraftBuildError)) throw error;
      const regenerated = generateWeekWorkouts(dependencies, {
        plan,
        week,
        sample,
        intake: input.intake,
        ftpWatts: input.ftp.usedWatts,
        eventName: input.intake.eventName,
        course: input.course,
        targetDateKey: input.targetDateKey,
        deviceId,
        ids: workoutIds(restored),
      });
      replaceWeekWorkouts(plan, workouts, week.weekIndex, regenerated);
      validateGeneratedWeek(plan, week, regenerated, input.targetDateKey, {
        allowedWeekdays,
        expectedCount,
      });
      repairedCheckpoint = true;
    }
  }
  if (repairedCheckpoint && checkpoint !== null && dependencies.checkpoints !== undefined) {
    const stamp = dependencies.identity.hlcStamp();
    checkpoint = await dependencies.checkpoints.save({
      ...checkpoint,
      payloadJson: JSON.stringify({
        schemaVersion: 1,
        planId: plan.id,
        workouts,
      } satisfies DraftCheckpointPayload),
      updatedAtMs: stamp.physicalMs,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  }
  input.onProgress?.({ completedWeeks, totalWeeks: input.totalWeeks });
  for (const week of weeks) {
    if (week.weekIndex <= completedWeeks) continue;
    const generated = generateWeekWorkouts(dependencies, {
      plan,
      week,
      sample,
      intake: input.intake,
      ftpWatts: input.ftp.usedWatts,
      eventName: input.intake.eventName,
      course: input.course,
      targetDateKey: input.targetDateKey,
      deviceId,
      ids: previousIds,
    });
    replaceWeekWorkouts(plan, workouts, week.weekIndex, generated);
    validateGeneratedWeek(plan, week, generated, input.targetDateKey, {
      allowedWeekdays,
      expectedCount: generated.length,
    });
    if (checkpoint !== null && dependencies.checkpoints !== undefined) {
      const stamp = dependencies.identity.hlcStamp();
      checkpoint = await dependencies.checkpoints.save({
        ...checkpoint,
        completedWeeks: week.weekIndex,
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          planId: plan.id,
          workouts,
        } satisfies DraftCheckpointPayload),
        updatedAtMs: stamp.physicalMs,
        deviceId,
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      });
    }
    input.onProgress?.({ completedWeeks: week.weekIndex, totalWeeks: input.totalWeeks });
  }
  const structure = {
    schemaVersion: 1,
    foundation: referenceFoundation({
      conversationId: input.conversation.id,
      intake: input.intake,
      ftp: input.ftp,
      totalWeeks: input.totalWeeks,
    }),
    eventName: input.intake.eventName,
    racePriority: input.intake.eventPriority,
    raceDistanceKm: input.course === null ? null : input.course.preview.distanceM / 1_000,
    ftpWatts: input.ftp.usedWatts,
    schedulePreferences: {
      scheduleType: "fixed",
      availableDays: input.intake.availabilityWeekdays,
      sessionsPerWeek: input.intake.availabilitySessionsPerWeek,
    },
    seasonWeeks: weeks,
    phases: phases(weeks, input.intake.availabilitySessionsPerWeek),
    revisions: input.revisions,
  };
  const finalPlan: PlanRecord = { ...plan, structureJson: JSON.stringify(structure) };
  return {
    plan: finalPlan,
    workouts: Object.freeze(workouts),
    snapshot: snapshot({
      plan: finalPlan,
      workouts,
      intake: input.intake,
      ftp: input.ftp,
      course: input.course,
      weeks,
      revisions: input.revisions,
    }),
    ...(checkpoint === null
      ? {}
      : {
          checkpointId: checkpoint.id,
          draftRevisionId: prepared.draftRevisionId,
        }),
  };
}

interface ParsedWeekdayMove {
  readonly source: string;
  readonly sourceWeekday: PlanIntakeWeekday | null;
  readonly targetWeekday: PlanIntakeWeekday;
  readonly duration: {
    readonly weekday: PlanIntakeWeekday;
    readonly maximumDurationS: number;
    readonly shorten: boolean;
  } | null;
}

function parseWeekdayMove(instruction: string): ParsedWeekdayMove | null {
  const compact = instruction.trim().replace(/[.!?]+$/u, "");
  const compound =
    /^keep\s+(\w+)\s+(under\s+60\s+minutes|shorter)\s+and\s+move\s+(?:the\s+)?long\s+ride\s+to\s+(\w+)$/iu.exec(
      compact,
    );
  if (compound !== null) {
    const durationWeekday = WEEKDAY_NAME[compound[1].toLowerCase()];
    const targetWeekday = WEEKDAY_NAME[compound[3].toLowerCase()];
    if (durationWeekday === undefined || targetWeekday === undefined) return null;
    return {
      source: "long ride",
      sourceWeekday: null,
      targetWeekday,
      duration: {
        weekday: durationWeekday,
        maximumDurationS: 3_300,
        shorten: compound[2].toLowerCase() === "shorter",
      },
    };
  }
  const match = /^move\s+(?:all\s+|the\s+)?(.+?)\s+(?:workouts?\s+)?to\s+(\w+)$/iu.exec(compact);
  if (match === null) return null;
  const targetWeekday = WEEKDAY_NAME[match[2].toLowerCase()];
  if (targetWeekday === undefined) return null;
  const source = match[1].trim().replace(/\s+workouts?$/iu, "");
  const sourceWeekday = WEEKDAY_NAME[source.toLowerCase()] ?? null;
  return { source, sourceWeekday, targetWeekday, duration: null };
}

function applyWeekdayMove(
  dependencies: CyclingPlanDraftBuilderDependencies,
  previous: DraftSnapshot,
  instruction: string,
): PlanDraftBuild {
  const parsed = parseWeekdayMove(instruction);
  if (parsed === null) throw new CyclingPlanDraftBuildError("unsupported-revision");
  const plan = previous.draft.plan;
  const allowedWeekdays = planAllowedWeekdays(plan);
  if (
    (allowedWeekdays.size > 0 && !allowedWeekdays.has(WEEKDAY_NUMBER[parsed.targetWeekday])) ||
    (parsed.duration !== null &&
      allowedWeekdays.size > 0 &&
      !allowedWeekdays.has(WEEKDAY_NUMBER[parsed.duration.weekday]))
  ) {
    throw new CyclingPlanDraftBuildError("revision-conflict");
  }
  const candidates = previous.draft.workouts.filter((workout) => {
    const structure = JSON.parse(workout.structureJson) as Record<string, unknown>;
    if (structure.slot === "race") return false;
    return parsed.sourceWeekday === null
      ? workout.name.toLowerCase().includes(parsed.source.toLowerCase())
      : weekdayForDateKey(workout.dateKey) === WEEKDAY_NUMBER[parsed.sourceWeekday];
  });
  if (candidates.length === 0) throw new CyclingPlanDraftBuildError("unsupported-revision");
  const durationCandidates =
    parsed.duration === null
      ? []
      : previous.draft.workouts.filter((workout) => {
          const structure = JSON.parse(workout.structureJson) as Record<string, unknown>;
          return (
            structure.slot !== "race" &&
            weekdayForDateKey(workout.dateKey) === WEEKDAY_NUMBER[parsed.duration!.weekday]
          );
        });
  if (parsed.duration !== null && durationCandidates.length === 0) {
    throw new CyclingPlanDraftBuildError("unsupported-revision");
  }
  const candidateIds = new Set(candidates.map((workout) => workout.id));
  const occupied = new Set(
    previous.draft.workouts
      .filter((workout) => !candidateIds.has(workout.id))
      .map((workout) => workout.dateKey),
  );
  const destinations = new Map<string, number>();
  for (const workout of candidates) {
    const week = planWeekIndex(plan, workout.dateKey);
    if (week.kind !== "inside") throw new CyclingPlanDraftBuildError("invalid-previous-draft");
    const range = planWeekRange(plan, week.weekIndex);
    const dateKey = weekdayDate(range.startDateKey, parsed.targetWeekday);
    if ((plan.targetDateKey !== null && dateKey > plan.targetDateKey) || occupied.has(dateKey)) {
      throw new CyclingPlanDraftBuildError("revision-conflict");
    }
    occupied.add(dateKey);
    destinations.set(workout.id, dateKey);
  }
  const planStamp = dependencies.identity.hlcStamp();
  const durationIds = new Set(durationCandidates.map((workout) => workout.id));
  const moved = previous.draft.workouts.map((workout) => {
    const dateKey = destinations.get(workout.id);
    const duration = parsed.duration;
    const adjustsDuration = duration !== null && durationIds.has(workout.id);
    if (dateKey === undefined && !adjustsDuration) return workout;
    const stamp = dependencies.identity.hlcStamp();
    const structure = JSON.parse(workout.structureJson) as Record<string, unknown>;
    const durationS =
      adjustsDuration && workout.durationS !== null
        ? duration!.shorten
          ? Math.max(600, Math.min(duration!.maximumDurationS, workout.durationS - 300))
          : Math.min(duration!.maximumDurationS, workout.durationS)
        : workout.durationS;
    const workoutType = structure.workoutType;
    if (!isGeneratedWorkoutType(workoutType) || durationS === null) {
      throw new CyclingPlanDraftBuildError("invalid-previous-draft");
    }
    const courseProfile = structure.courseProfile as Record<string, unknown> | undefined;
    const content = adjustsDuration
      ? structuredWorkoutContent({
          name: workout.name,
          workoutType,
          durationS,
          climbingFocus: courseProfile?.climbingFocus === true,
        })
      : {};
    return {
      ...workout,
      dateKey: dateKey ?? workout.dateKey,
      durationS,
      structureJson: JSON.stringify({
        ...structure,
        ...(dateKey === undefined ? {} : { movedToWeekday: parsed.targetWeekday }),
        ...(adjustsDuration
          ? {
              durationWeekday: duration!.weekday,
              maximumDurationS: duration!.maximumDurationS,
            }
          : {}),
        ...content,
      }),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    };
  });
  const evidence: DraftRevisionEvidence =
    parsed.duration === null
      ? {
          kind: "weekday-move",
          instruction: instruction.trim(),
          source: parsed.source,
          targetWeekday: parsed.targetWeekday,
          movedWorkoutIds: Object.freeze(candidates.map((workout) => workout.id)),
        }
      : {
          kind: "weekday-move-and-duration-cap",
          instruction: instruction.trim(),
          source: parsed.source,
          targetWeekday: parsed.targetWeekday,
          movedWorkoutIds: Object.freeze(candidates.map((workout) => workout.id)),
          durationWeekday: parsed.duration.weekday,
          maximumDurationS: parsed.duration.maximumDurationS,
          durationWorkoutIds: Object.freeze(durationCandidates.map((workout) => workout.id)),
        };
  const revisions = Object.freeze([...previous.evidence.revisions, evidence]);
  const sourceStructure = JSON.parse(plan.structureJson) as Record<string, unknown>;
  const updatedPlan: PlanRecord = {
    ...plan,
    structureJson: JSON.stringify({ ...sourceStructure, revisions }),
    updatedAtMs: planStamp.physicalMs,
    hlcPhysicalMs: planStamp.physicalMs,
    hlcCounter: planStamp.counter,
  };
  return {
    plan: updatedPlan,
    workouts: Object.freeze(moved),
    snapshot: {
      ...previous,
      evidence: {
        ...previous.evidence,
        workoutCount: moved.length,
        revisions,
      },
      draft: { plan: updatedPlan, workouts: moved },
    } satisfies DraftSnapshot,
  };
}

export function createCyclingPlanDraftBuilder(
  dependencies: CyclingPlanDraftBuilderDependencies,
): PlanDraftBuilder {
  const sources = async (
    conversation: PlanConversationRecord,
  ): Promise<{ readonly intake: DraftIntakeFacts; readonly ftp: DraftFtpFacts }> => {
    const [intake, ftp] = await Promise.all([
      dependencies.intakes.read(conversation.id),
      dependencies.ftp.read(),
    ]);
    return { intake: completeIntake(intake), ftp: completeFtp(ftp) };
  };
  const builder: PlanDraftBuilder = {
    async form({ conversation, previous, course, onProgress }) {
      const { intake, ftp } = await sources(conversation);
      const todayDateKey = dependencies.todayDateKey();
      if (intake.eventDateKey < todayDateKey) {
        throw new CyclingPlanDraftBuildError("invalid-target-date");
      }
      const previousSnapshot = previous === undefined ? null : parseSnapshot(previous);
      let startDateKey = todayDateKey;
      let totalWeeks = Math.ceil(inclusiveCivilDays(startDateKey, intake.eventDateKey) / 7);
      const existingCheckpoint = await dependencies.checkpoints?.read(conversation.id);
      if (existingCheckpoint?.operation === "form") {
        try {
          const prior = JSON.parse(existingCheckpoint.buildKey) as Record<string, unknown>;
          if (
            typeof prior.startDateKey === "number" &&
            typeof prior.totalWeeks === "number" &&
            buildInputKey({
              operation: "form",
              conversationId: conversation.id,
              previousRevisionId: previous?.id ?? null,
              intake,
              ftp,
              course,
              startDateKey: prior.startDateKey,
              targetDateKey: intake.eventDateKey,
              totalWeeks: prior.totalWeeks,
            }) === existingCheckpoint.buildKey
          ) {
            startDateKey = prior.startDateKey;
            totalWeeks = prior.totalWeeks;
          }
        } catch {
          startDateKey = todayDateKey;
          totalWeeks = Math.ceil(inclusiveCivilDays(startDateKey, intake.eventDateKey) / 7);
        }
      }
      if (totalWeeks < 1 || totalWeeks > 24) {
        throw new CyclingPlanDraftBuildError("invalid-target-date");
      }
      const buildKey = buildInputKey({
        operation: "form",
        conversationId: conversation.id,
        previousRevisionId: previous?.id ?? null,
        intake,
        ftp,
        course,
        startDateKey,
        targetDateKey: intake.eventDateKey,
        totalWeeks,
      });
      return generateDraft(dependencies, {
        conversation,
        intake,
        ftp,
        course,
        startDateKey,
        targetDateKey: intake.eventDateKey,
        totalWeeks,
        previous: previousSnapshot,
        revisions: [],
        operation: "form",
        buildKey,
        targetRevision: (previous?.revision ?? 0) + 1,
        onProgress,
      });
    },
    async revise({ conversation, previous, instruction, course, onProgress }) {
      const prior = parseSnapshot(previous);
      const build = applyWeekdayMove(dependencies, prior, instruction);
      return checkpointCompletedBuild(dependencies, {
        conversationId: conversation.id,
        operation: "revise",
        buildKey: buildInputKey({
          operation: "revise",
          conversationId: conversation.id,
          previousRevisionId: previous.id,
          intake: prior.intake,
          ftp: { usedSource: prior.ftp.source, usedWatts: prior.ftp.watts },
          course,
          startDateKey: prior.draft.plan.startDateKey,
          targetDateKey: prior.draft.plan.targetDateKey ?? prior.intake.eventDateKey,
          totalWeeks: prior.draft.plan.totalWeeks,
          instruction,
        }),
        targetRevision: previous.revision + 1,
        build,
        onProgress,
      });
    },
    async recalculateCourse({ conversation, previous, course, onProgress }) {
      const prior = parseSnapshot(previous);
      const intake = prior.intake;
      const ftp = { usedSource: prior.ftp.source, usedWatts: prior.ftp.watts };
      const targetDateKey = prior.draft.plan.targetDateKey ?? intake.eventDateKey;
      const buildKey = buildInputKey({
        operation: "course",
        conversationId: conversation.id,
        previousRevisionId: previous.id,
        intake,
        ftp,
        course,
        startDateKey: prior.draft.plan.startDateKey,
        targetDateKey,
        totalWeeks: prior.draft.plan.totalWeeks,
      });
      return generateDraft(dependencies, {
        conversation,
        intake,
        ftp,
        course,
        startDateKey: prior.draft.plan.startDateKey,
        targetDateKey,
        totalWeeks: prior.draft.plan.totalWeeks,
        previous: prior,
        revisions: prior.evidence.revisions,
        operation: "course",
        buildKey,
        targetRevision: previous.revision + 1,
        onProgress,
      });
    },
    async recalculateStartDate({ conversation, previous, preview, course, onProgress }) {
      const prior = parseSnapshot(previous);
      const intake = prior.intake;
      const ftp = { usedSource: prior.ftp.source, usedWatts: prior.ftp.watts };
      const buildKey = buildInputKey({
        operation: "start-date",
        conversationId: conversation.id,
        previousRevisionId: previous.id,
        intake,
        ftp,
        course,
        startDateKey: preview.startDateKey,
        targetDateKey: preview.targetDateKey,
        totalWeeks: preview.totalWeeks,
      });
      return generateDraft(dependencies, {
        conversation,
        intake,
        ftp,
        course,
        startDateKey: preview.startDateKey,
        targetDateKey: preview.targetDateKey,
        totalWeeks: preview.totalWeeks,
        previous: prior,
        revisions: prior.evidence.revisions,
        operation: "start-date",
        buildKey,
        targetRevision: previous.revision + 1,
        onProgress,
      });
    },
  };
  return Object.freeze(builder);
}
