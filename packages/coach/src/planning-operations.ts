import { AsyncLocalStorage } from "node:async_hooks";
import {
  ExecutePlanTransitionRpcParamsSchema,
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcParamsSchema,
  GetPlanStateRpcResultSchema,
  PlanDraftPlanProjectionSchema,
  PlanCoachProjectionDataSchema,
  PlanActiveProjectionDataSchema,
  PlanEndedProjectionDataSchema,
  PlanDraftProjectionSchema,
  PlanFtpProjectionSchema,
  PlanRaceCourseProjectionSchema,
  PlanStartDateProjectionSchema,
  PlanProgressEventSchema,
  PlanReadModelSchema,
  PlanWeeklyReviewProjectionSchema,
  PlanIntakePatchSchema,
  type ChatQueueRunResult,
  type ChatQueueSnapshot,
  type CoachEngine,
  type ExecutePlanTransitionRpcParams,
  type ExecutePlanTransitionRpcResult,
  type PlanDraftProjection,
  type PlanActiveProjectionData,
  type PlanEndedProjectionData,
  type PlanDraftPlanProjection,
  type PlanError,
  type PlanFtpProjection,
  type PlanHistoryEntry,
  type PlanIntakePatch,
  type PlanProgressEvent,
  type PlanProposalProjection,
  type PlanProposalReturn,
  type PlanRaceCourseProjection,
  type PlanRaceCourseSummary,
  type PlanStartDateProjection,
  type PlanReadModel,
  type PlanScenarioId,
  type PlanWeeklyReviewProjection,
  type PlanningOperations,
  type TurnEvent,
} from "@enduragent/coach-contract";
import {
  activatePlanDraft,
  acceptParsedRaceCourse,
  beginRaceCourseParsing,
  beginRaceCourseRemoval,
  completeRaceCourseRecalculation,
  executePlanFtpTransition,
  failRaceCourseRecalculation,
  openRaceCoursePicker,
  previewPlanStartDate,
  projectPlanReconciliation,
  cleanupPlanMirror,
  reconcileActivePlanWindow,
  rejectRaceCourseFile,
  useRouteWithoutElevation,
  verifyPlanMirror,
  verifyPlanCleanup,
  projectWorkoutMatches,
  refreshPlanWorkoutMatches,
  adoptProviderWorkoutEdit,
  refreshPlanWorkoutDrifts,
  restorePlanWorkout,
  PlanWorkoutDriftError,
  type ProjectedWorkoutMatch,
  type PlanMirrorCalendarPort,
  type PlanReconciliationProjection,
  type PlanFtpAdapter,
  type PlanFtpSnapshot,
  type PlanStartDatePreview,
  type RaceCourseRecalculatingState,
  type PlanWorkoutDriftSnapshot,
  applyValidatedPlanProposal,
  capturePlanProposalBase,
  encodePlanProposalBase,
  encodePlanProposalMutation,
  parsePlanProposalMutation,
  projectPlanProposalDiff,
  revalidatePlanProposalPremises,
  validatePlanProposal,
  PlanProposalError,
  type PlanProposalLoadCalculator,
  type PlanProposalMutation,
  type PlanProposalPremiseReader,
  applyValidatedPlanUndo,
  projectPlanHistoryEligibility,
  validatePlanUndo,
  PlanUndoError,
  validatePlanAutoApply,
  approvePlanReplacement,
  projectPlanSeason,
  failedPlanReadiness,
  projectPlanReadiness,
  taperRefusalReadiness,
  type PlanReadinessInput as EnginePlanReadinessInput,
  composeWeeklyReview,
  selectWeeklyReviewWindow,
  naturalPlanCompletionDue,
  planFinalCivilDateKey,
  raceOutcomeDue,
  evaluatePlanIntakeReadiness,
  type PlanIntakeReadiness,
} from "@enduragent/engine";
import { cyclingTaperRefusal, projectCyclingSeasonMetadata } from "@enduragent/sport-cycling";
import {
  buildActivePlanReadModel,
  buildChatOriginatedPlanResultReadModel,
  buildEndedPlanConversationReadModel,
  buildEndedPlanReadModel,
  buildPlanLifecycleReadModel,
  type ActivePlanScenario,
  type EndedPlanScenario,
} from "./planning-lifecycle.js";
import {
  addCivilDays,
  createLegacyWriterFence,
  LegacyPlanningAuthorityError,
  createLegacyPlanTransitionRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  createPlanWorkoutDriftRepository,
  createPlanProposalRepository,
  createPlanAdaptationLedgerRepository,
  createPlanSettingsRepository,
  createPlanReplacementRepository,
  createPlanWeeklyReviewRepository,
  createPlanRaceOutcomeRepository,
  createPlanIntakeRepository,
  createPlanDraftBuildRepository,
  dateKeyFromText,
  planWeekIndex,
  PlanConversationValidationError,
  type PlanConversationRecord,
  type PlanConversationRepository,
  type PlanConversationTurnRecord,
  type PlanDraftRevisionRecord,
  type PlanRecord,
  type PlanReconciliationRepository,
  type PlanRepository,
  type PlanWorkoutRecord,
  type PlanWorkoutMatchRepository,
  type PlanWorkoutDriftRecord,
  type PlanWorkoutDriftRepository,
  type PlanProposalRecord,
  type PlanProposalPremiseRecord,
  type PlanProposalRepository,
  type PlanningRequestReadModel,
  type PlanningRequestAttention,
  type PlanningRequestRecord,
  type PlanningRequestRepository,
  type PlanAdaptationLedgerRecord,
  type PlanAdaptationLedgerRepository,
  type PlanSetting,
  type PlanSettingsRecord,
  type PlanSettingsRepository,
  type PlanReplacementRepository,
  type PlanWeeklyReviewRecord,
  type PlanWeeklyReviewRepository,
  type PlanRaceOutcomeRepository,
  type PlanIntakeRecord,
  type PlanIntakeRepository,
  type PlanDraftBuildRepository,
  parsePlanAdaptationWorkoutSnapshot,
  PlanAdaptationLedgerValidationError,
  PlanProposalValidationError,
  PlanReplacementValidationError,
  parseRaceCourseSnapshot,
  type RaceCourseSnapshot,
} from "@enduragent/kernel/planning";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import type { CoachStoreWriterContext } from "./runtime.js";
import type { PlanRaceCourseAdapter } from "./planning-race-course.js";

const EMPTY_QUEUE: ChatQueueSnapshot = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  items: [],
});

const UNAVAILABLE: PlanError = Object.freeze({
  code: "unavailable",
  message: "This Plan action is not available yet.",
  retryable: true,
});

const PROVIDER_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The coach couldn’t respond. Try again.",
  retryable: true,
});

const PERSISTENCE_FAILED: PlanError = Object.freeze({
  code: "persistence-failed",
  message: "The Plan couldn’t save that change. Try again.",
  retryable: true,
});

const RACE_OUTCOME_CONFLICT: PlanError = Object.freeze({
  code: "conflict",
  message: "A different race outcome is already saved.",
  retryable: false,
});

const WORKOUT_DRIFT_PROVIDER_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "Couldn’t update this workout. Nothing was changed; try again.",
  retryable: true,
});

const WORKOUT_DRIFT_CHANGED: PlanError = Object.freeze({
  code: "conflict",
  message: "This workout changed again in Intervals. Review the latest version before choosing.",
  retryable: true,
});

const FTP_REFRESH_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "Couldn’t refresh Intervals. Try again.",
  retryable: true,
});

const FTP_SAVE_FAILED: PlanError = Object.freeze({
  code: "persistence-failed",
  message: "FTP couldn’t be saved. Try again.",
  retryable: true,
});

const COURSE_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "This file can’t be read. Choose another GPX or FIT file.",
  retryable: true,
});

const COURSE_RECALCULATION_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The Draft could not be recalculated. Your previous Draft is unchanged.",
  retryable: true,
});

const START_DATE_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "Choose a start date from today through the Goal Event.",
  retryable: true,
});

const START_DATE_RECALCULATION_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The Plan could not be recalculated. Your current Draft is safe.",
  retryable: true,
});

const CALENDAR_UPDATE_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "Some workouts could not be updated in Intervals.",
  retryable: true,
});

const CALENDAR_UPDATE_STATE_FAILED: PlanError = Object.freeze({
  code: "persistence-failed",
  message: "The Plan is active, but the Intervals update could not be saved. Retry.",
  retryable: true,
});

const CALENDAR_VERIFICATION_FAILED: PlanError = Object.freeze({
  code: "verification-failed",
  message: "Intervals does not match the active Plan yet.",
  retryable: true,
});

const CALENDAR_CLEANUP_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The Plan is ended, but some future workouts could not be removed from Intervals.",
  retryable: true,
});

const CALENDAR_CLEANUP_VERIFICATION_FAILED: PlanError = Object.freeze({
  code: "verification-failed",
  message: "The Plan is ended, but future Enduragent workouts still remain in Intervals.",
  retryable: true,
});

const READINESS_REFRESH_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "Recent training load could not be refreshed from Intervals.",
  retryable: true,
});

const DRAFT_STALE: PlanError = Object.freeze({
  code: "stale-base",
  message: "This Draft changed before approval. Review the latest Draft.",
  retryable: false,
});

const DRAFT_REVISION_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "The coach couldn’t apply that request. Your current Draft is unchanged.",
  retryable: false,
});

const DRAFT_INPUT_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "Update the Goal Event date before creating this Draft.",
  retryable: false,
});

const PROPOSAL_STALE: PlanError = Object.freeze({
  code: "stale-base",
  message: "The Plan changed before approval. Review the updated Proposal.",
  retryable: false,
});

const PROPOSAL_INVALID: PlanError = Object.freeze({
  code: "invalid-input",
  message: "This Proposal could not be applied safely. The active Plan is unchanged.",
  retryable: false,
});

type SafeProposalReturn = PlanProposalReturn & {
  readonly sourceScenarioId:
    | "PL-S004"
    | "PL-S010"
    | "PL-S013"
    | "PL-S037"
    | "PL-S038"
    | "PL-S039"
    | "PL-S040"
    | "PL-S041"
    | "PL-S042"
    | "PL-S043";
};

const SAFE_PROPOSAL_RETURN_SCENARIOS = new Set<PlanProposalReturn["sourceScenarioId"]>([
  "PL-S004",
  "PL-S010",
  "PL-S013",
  "PL-S037",
  "PL-S038",
  "PL-S039",
  "PL-S040",
  "PL-S041",
  "PL-S042",
  "PL-S043",
]);

const PROPOSAL_RESULT_SCENARIOS = new Set<PlanProposalReturn["sourceScenarioId"]>([
  "PL-S007",
  "PL-S022",
  "PL-S023",
  "PL-S024",
  "PL-S025",
  "PL-S097",
]);

function isSafeProposalReturn(value: PlanProposalReturn | undefined): value is SafeProposalReturn {
  return value !== undefined && SAFE_PROPOSAL_RETURN_SCENARIOS.has(value.sourceScenarioId);
}

const UNDO_STALE: PlanError = Object.freeze({
  code: "conflict",
  message: "The Plan changed while Undo was running. Review History and try again.",
  retryable: true,
});

function isProposalStale(error: unknown): boolean {
  return (
    (error instanceof PlanProposalError && error.code === "stale-base") ||
    (error instanceof PlanProposalValidationError && error.code === "stale-base")
  );
}

export interface PlanDraftBuild {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly snapshot: unknown;
  readonly checkpointId?: string;
  readonly draftRevisionId?: string;
}

export interface PlanDraftBuildProgress {
  readonly completedWeeks: number;
  readonly totalWeeks: number;
}

export interface PlanDraftBuilder {
  form(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous?: PlanDraftRevisionRecord;
    readonly course: RaceCourseSnapshot | null;
    readonly onProgress?: (progress: PlanDraftBuildProgress) => void;
  }): Promise<PlanDraftBuild>;
  revise(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous: PlanDraftRevisionRecord;
    readonly instruction: string;
    readonly course: RaceCourseSnapshot | null;
    readonly onProgress?: (progress: PlanDraftBuildProgress) => void;
  }): Promise<PlanDraftBuild>;
  recalculateCourse(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous: PlanDraftRevisionRecord;
    readonly course: RaceCourseSnapshot | null;
    readonly onProgress?: (progress: PlanDraftBuildProgress) => void;
  }): Promise<PlanDraftBuild>;
  recalculateStartDate?(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous: PlanDraftRevisionRecord;
    readonly preview: PlanStartDatePreview;
    readonly course: RaceCourseSnapshot | null;
    readonly onProgress?: (progress: PlanDraftBuildProgress) => void;
  }): Promise<PlanDraftBuild>;
}

export interface PlanReadinessInput {
  readonly conversation: PlanConversationRecord;
  readonly turns: readonly PlanConversationTurnRecord[];
  readonly draft: PlanDraftRevisionRecord | undefined;
}

export interface PlanRaceReadinessAdapter {
  read(input: {
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly todayDateKey: number;
  }): Promise<EnginePlanReadinessInput>;
  refresh(): Promise<void>;
}

export interface PlanProposalRevisionBuild {
  readonly title: string;
  readonly rationale: string;
  readonly confidence: PlanProposalRecord["confidence"];
  readonly mutation: PlanProposalMutation;
  readonly premises: readonly Omit<
    PlanProposalPremiseRecord,
    "id" | "proposalId" | "createdAtMs" | "deviceId" | "hlcPhysicalMs" | "hlcCounter"
  >[];
}

export interface PlanProposalReviser {
  revise(input: {
    readonly proposal: PlanProposalRecord;
    readonly premises: readonly PlanProposalPremiseRecord[];
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly instruction: string;
  }): Promise<PlanProposalRevisionBuild>;
}

export interface CreatePlanningOperationsDependencies {
  readonly conversations?: PlanConversationRepository;
  readonly intakes?: PlanIntakeRepository;
  readonly plans?: PlanRepository;
  readonly draftBuilds?: PlanDraftBuildRepository;
  readonly draftBuilder?: PlanDraftBuilder;
  readonly isReady?: (input: PlanReadinessInput) => boolean | Promise<boolean>;
  readonly ftp?: PlanFtpAdapter;
  readonly course?: PlanRaceCourseAdapter;
  readonly reconciliations?: PlanReconciliationRepository;
  readonly calendar?: PlanMirrorCalendarPort;
  readonly workoutMatches?: PlanWorkoutMatchRepository;
  readonly workoutDrifts?: PlanWorkoutDriftRepository;
  readonly proposals?: PlanProposalRepository;
  readonly requests?: PlanningRequestRepository;
  readonly history?: PlanAdaptationLedgerRepository;
  readonly settings?: PlanSettingsRepository;
  readonly replacements?: PlanReplacementRepository;
  readonly weeklyReviews?: PlanWeeklyReviewRepository;
  readonly raceOutcomes?: PlanRaceOutcomeRepository;
  readonly proposalReviser?: PlanProposalReviser;
  readonly proposalPremiseReader?: PlanProposalPremiseReader;
  readonly proposalLoadCalculator?: PlanProposalLoadCalculator;
  readonly workoutDriftCalendar?: PlanMirrorCalendarPort;
  readonly readiness?: PlanRaceReadinessAdapter;
  readonly todayDateKey?: () => number;
}

function createSerializedLane(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const task = tail.then(operation, operation);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

function snapshot(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function planningRequestWorkout(record: PlanningRequestRecord): {
  readonly name: string;
  readonly workoutRef: { readonly setId: string; readonly workoutId: string } | null;
} {
  const selected = record.sourceState.payload?.sourceSnapshot.selectedWorkout;
  if (selected !== null && selected !== undefined) {
    const name = selected.workout.title ?? selected.workout.name;
    return {
      name: typeof name === "string" && name.length > 0 ? name : "Workout",
      workoutRef: { setId: selected.setId, workoutId: selected.workoutId },
    };
  }
  const workout = record.sourceState.provenance?.workout;
  return {
    name: workout?.name ?? "Plan change",
    workoutRef:
      workout === null || workout === undefined
        ? null
        : { setId: workout.setId, workoutId: workout.workoutId },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dateText(dateKey: number): string {
  const value = String(dateKey).padStart(8, "0");
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function utcTodayDateKey(): number {
  const now = new Date();
  return now.getUTCFullYear() * 10_000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

function utcDateKeyFromEpochMs(epochMs: number): number {
  const date = new Date(epochMs);
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

function deliveredWeeklyReviewProjection(
  record: PlanWeeklyReviewRecord,
): PlanWeeklyReviewProjection {
  if (
    record.status !== "delivered" ||
    record.summaryJson === null ||
    record.deliveredAtMs === null
  ) {
    throw new TypeError("A delivered Weekly review requires its stored result.");
  }
  const stored = JSON.parse(record.summaryJson) as {
    readonly counts?: unknown;
    readonly summary?: unknown;
  };
  return PlanWeeklyReviewProjectionSchema.parse({
    status: "delivered",
    id: record.id,
    weekStart: dateText(record.weekStartDateKey),
    weekEnd: dateText(record.weekEndDateKey),
    deliveredAtMs: record.deliveredAtMs,
    counts: stored.counts,
    summary: stored.summary,
  });
}

function unavailableReadinessInput(
  plan: PlanRecord,
  todayDateKey: number,
): EnginePlanReadinessInput {
  return {
    today: dateText(todayDateKey),
    raceDate: plan.targetDateKey === null ? null : dateText(plan.targetDateKey),
    platformSeed: null,
    dailyLoadRanges: [],
    supportedDistanceKm: null,
    missedKeyWorkouts: 0,
    fatigue: "unknown",
    courseEstimate: {
      status: "unavailable",
      rangeMinutes: null,
      previousRangeMinutes: null,
      confidence: null,
      assumptions: [],
      changedAssumption: null,
      unavailableReason: "missing-course",
    },
    estimatedCp: {
      status: "unavailable",
      watts: null,
      calculatedOn: null,
      lastSuccessfulSyncAtMs: null,
      unavailableReason: "missing-effort",
      efforts: [],
    },
    evidence: {
      prescribedDurationS: 0,
      riddenDurationS: 0,
      adjustedDurationS: 0,
    },
  };
}

function draftPlanProjection(
  plan: PlanRecord | undefined,
  workouts: readonly PlanWorkoutRecord[],
): PlanDraftPlanProjection | null {
  if (plan === undefined) return null;
  const structure = record(snapshot(plan.structureJson));
  const metadata = projectCyclingSeasonMetadata(structure, plan.totalWeeks);
  const phaseSummary = [...new Set(metadata.weeks.map((week) => week.phase))];
  if (plan.targetDateKey !== null && !phaseSummary.includes("Race")) phaseSummary.push("Race");
  const ftpWatts = structure?.ftpWatts;
  return PlanDraftPlanProjectionSchema.parse({
    id: plan.id,
    name: plan.name,
    primaryGoal: plan.primaryGoal,
    startDate: dateText(plan.startDateKey),
    targetDate: plan.targetDateKey === null ? null : dateText(plan.targetDateKey),
    kind: plan.kind === "full_plan" ? "full-plan" : "short-race-preparation",
    totalWeeks: plan.totalWeeks,
    weekStartDay: plan.weekStartDay,
    workoutCount: workouts.length,
    plannedDurationS: workouts.reduce((total, workout) => total + (workout.durationS ?? 0), 0),
    phaseSummary,
    ...(typeof ftpWatts === "number" && Number.isSafeInteger(ftpWatts) && ftpWatts > 0
      ? { ftpWatts }
      : {}),
  });
}

function workoutGuidance(workout: PlanWorkoutRecord): {
  readonly powerTargetW?: { readonly min: number; readonly max: number };
  readonly cue?: string;
} {
  const structure = record(snapshot(workout.structureJson));
  const power = record(structure?.powerWatts);
  const min = power?.low;
  const max = power?.high;
  const workoutType = structure?.workoutType;
  return {
    ...(typeof min === "number" &&
    Number.isSafeInteger(min) &&
    min > 0 &&
    typeof max === "number" &&
    Number.isSafeInteger(max) &&
    max >= min
      ? { powerTargetW: { min, max } }
      : {}),
    ...(workoutType === "recovery" ? { cue: "Keep the pedals light." } : {}),
  };
}

function startDateProjection(input: {
  readonly plan: PlanRecord;
  readonly todayDateKey: number;
  readonly status?: PlanStartDateProjection["status"];
  readonly selectedDate?: string;
  readonly error?: PlanError | null;
}): PlanStartDateProjection | undefined {
  if (input.plan.targetDateKey === null) return undefined;
  const selectedDate = input.selectedDate ?? dateText(input.plan.startDateKey);
  try {
    const preview = previewPlanStartDate({
      planStatus: input.plan.status,
      startDate: selectedDate,
      today: dateText(input.todayDateKey),
      targetDate: dateText(input.plan.targetDateKey),
    });
    return PlanStartDateProjectionSchema.parse({
      status: input.status ?? "ready",
      selectedDate,
      today: dateText(input.todayDateKey),
      targetDate: dateText(input.plan.targetDateKey),
      kind: preview.kind === "full_plan" ? "full-plan" : "short-race-preparation",
      inclusiveDays: preview.inclusiveDays,
      totalWeeks: preview.totalWeeks,
      raceWeekday: preview.raceWeekday,
      raceDayOfPlanWeek: preview.raceDayOfPlanWeek,
      error: input.error ?? null,
    });
  } catch {
    return PlanStartDateProjectionSchema.parse({
      status: "invalid",
      selectedDate,
      today: dateText(input.todayDateKey),
      targetDate: dateText(input.plan.targetDateKey),
      kind: null,
      inclusiveDays: null,
      totalWeeks: null,
      raceWeekday: null,
      raceDayOfPlanWeek: null,
      error: input.error ?? START_DATE_INVALID,
    });
  }
}

function proposalProjection(input: {
  readonly proposal: PlanProposalRecord;
  readonly premises: readonly PlanProposalPremiseRecord[];
  readonly mutation: PlanProposalMutation;
  readonly stale: boolean;
  readonly error?: PlanError | null;
}): PlanProposalProjection {
  const first = input.mutation.changes[0];
  if (first === undefined) throw new PlanProposalError("invalid-mutation");
  return {
    id: input.proposal.id,
    revision: input.proposal.revision,
    title: input.proposal.title,
    rationale: input.proposal.rationale,
    confidence: input.proposal.confidence,
    targetWorkoutId: first.workoutId,
    affectedDate: dateText(first.after.dateKey),
    createdAtMs: input.proposal.createdAtMs,
    stale: input.stale,
    diff: [...projectPlanProposalDiff(input.mutation)],
    premises: input.premises.map((premise) => ({
      id: premise.id,
      sourceType: premise.sourceType,
      sourceId: premise.sourceId,
      sourceLabel: premise.sourceLabel,
      sourceDate: premise.sourceDateKey === null ? null : dateText(premise.sourceDateKey),
      confidence: premise.confidence,
      snapshotJson: premise.snapshotJson,
    })),
    error: input.error ?? null,
  };
}

function historyProjection(input: {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly history: readonly PlanAdaptationLedgerRecord[];
  readonly todayDateKey: number;
}): readonly PlanHistoryEntry[] {
  const eligibility = new Map(
    projectPlanHistoryEligibility(input).map((entry) => [entry.ledgerId, entry]),
  );
  const entries: PlanHistoryEntry[] = input.history.map((entry) => {
    const before =
      entry.beforeJson === null ? null : parsePlanAdaptationWorkoutSnapshot(entry.beforeJson);
    const after =
      entry.afterJson === null ? null : parsePlanAdaptationWorkoutSnapshot(entry.afterJson);
    const undo = eligibility.get(entry.id);
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      occurredAtMs: entry.occurredAtMs,
      targetWorkoutId: entry.targetWorkoutId,
      before:
        before === null
          ? null
          : { date: dateText(before.dateKey), name: before.name, durationS: before.durationS },
      after:
        after === null
          ? null
          : { date: dateText(after.dateKey), name: after.name, durationS: after.durationS },
      weekLoadBefore: entry.weekLoadBefore,
      weekLoadAfter: entry.weekLoadAfter,
      undoStatus: undo?.status ?? "none",
      undoReason: undo?.reason ?? null,
    };
  });
  entries.push({
    id: `activation:${input.plan.id}`,
    kind: "activation",
    label: "Plan approved",
    occurredAtMs: input.plan.createdAtMs,
    targetWorkoutId: null,
    before: null,
    after: null,
    weekLoadBefore: null,
    weekLoadAfter: null,
    undoStatus: "none",
    undoReason: null,
  });
  return entries.sort(
    (left, right) => right.occurredAtMs - left.occurredAtMs || right.id.localeCompare(left.id),
  );
}

function activePlanData(input: {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly todayDateKey: number;
  readonly matchRows: readonly ProjectedWorkoutMatch[];
  readonly matchSync: {
    readonly lastSuccessfulSyncAtMs: number | null;
    readonly awaitingSync: boolean;
  };
  readonly selectedWorkoutId?: string | null;
  readonly selectedWorkoutSourceScenarioId?: string | null;
  readonly returnFocusId?: string | null;
  readonly drifts: readonly PlanWorkoutDriftRecord[];
  readonly driftError?: PlanError | null;
  readonly proposals: readonly PlanProposalProjection[];
  readonly selectedProposalId?: string | null;
  readonly selectedProposalReturn?: PlanProposalReturn | null;
  readonly selectedPlanningRequest?: PlanActiveProjectionData["selectedPlanningRequest"];
  readonly proposalRevisionText?: string | null;
  readonly history: readonly PlanHistoryEntry[];
  readonly selectedHistoryId?: string | null;
  readonly settings: PlanSettingsRecord;
  readonly selectedSetting?: PlanSetting | null;
  readonly settingsError?: PlanError | null;
  readonly weeklyReview?: PlanWeeklyReviewProjection;
  readonly replacement?: PlanActiveProjectionData["replacement"];
  readonly seasonMetadata: ReturnType<typeof projectCyclingSeasonMetadata>;
  readonly readiness?: PlanActiveProjectionData["readiness"];
}): PlanActiveProjectionData {
  const plan = draftPlanProjection(input.plan, input.workouts);
  if (plan === null) throw new TypeError("An active Plan projection requires a Plan.");
  const week = planWeekIndex(input.plan, input.todayDateKey);
  const weekIndex =
    week.kind === "inside" ? week.weekIndex : week.side === "before" ? 1 : input.plan.totalWeeks;
  const weekStartDateKey =
    week.kind === "inside"
      ? addCivilDays(input.plan.startDateKey, (weekIndex - 1) * 7)
      : week.side === "before"
        ? input.plan.startDateKey
        : addCivilDays(input.plan.startDateKey, (input.plan.totalWeeks - 1) * 7);
  const windowEndDateKey = addCivilDays(weekStartDateKey, 6);
  const matchByWorkout = new Map(
    input.matchRows
      .filter(
        (row): row is ProjectedWorkoutMatch & { readonly workoutId: string } =>
          row.workoutId !== null,
      )
      .map((row) => [row.workoutId, row]),
  );
  const driftByWorkout = new Map(input.drifts.map((drift) => [drift.planWorkoutId, drift]));
  const parsedDriftSnapshot = (value: string): PlanWorkoutDriftSnapshot =>
    JSON.parse(value) as PlanWorkoutDriftSnapshot;
  const workouts = input.workouts
    .filter((workout) => workout.dateKey >= weekStartDateKey && workout.dateKey <= windowEndDateKey)
    .map((workout) => {
      const match = matchByWorkout.get(workout.id);
      const drift = driftByWorkout.get(workout.id);
      return {
        id: workout.id,
        date: dateText(workout.dateKey),
        sport: workout.sport,
        name: workout.name,
        durationS: workout.durationS,
        ...workoutGuidance(workout),
        ...(match === undefined
          ? {}
          : {
              match: {
                kind: "planned" as const,
                status: match.status,
                activityId: match.activityId,
                matchId: match.matchId,
                actualDate: match.actualDateKey === null ? null : dateText(match.actualDateKey),
                actualDurationS: match.actualDurationS,
                requiresConfirmation: match.requiresConfirmation,
                createdAtMs: match.createdAtMs,
              },
            }),
        ...(drift === undefined
          ? {}
          : {
              drift: {
                status: "detected" as const,
                eventId: String(drift.providerEventId),
                plan: {
                  date: dateText(parsedDriftSnapshot(drift.planSnapshotJson).dateKey),
                  name: parsedDriftSnapshot(drift.planSnapshotJson).name,
                  durationS: parsedDriftSnapshot(drift.planSnapshotJson).durationS,
                },
                provider: {
                  date: dateText(parsedDriftSnapshot(drift.providerSnapshotJson).dateKey),
                  name: parsedDriftSnapshot(drift.providerSnapshotJson).name,
                  durationS: parsedDriftSnapshot(drift.providerSnapshotJson).durationS,
                },
                error: input.selectedWorkoutId === workout.id ? (input.driftError ?? null) : null,
                detectedAtMs: drift.detectedAtMs,
              },
            }),
      };
    });
  const extra = input.matchRows
    .filter(
      (
        row,
      ): row is ProjectedWorkoutMatch & {
        readonly workoutId: null;
        readonly activityId: string;
        readonly actualDateKey: number;
      } => row.workoutId === null && row.activityId !== null && row.actualDateKey !== null,
    )
    .map((row) => ({
      id: row.activityId,
      date: dateText(row.actualDateKey),
      sport: row.actualSport ?? "activity",
      name: row.actualSport === "cycling" ? "Extra ride" : "Extra activity",
      durationS: row.actualDurationS,
      match: {
        kind: "extra" as const,
        status: "extra" as const,
        activityId: row.activityId,
        matchId: null,
        actualDate: dateText(row.actualDateKey),
        actualDurationS: row.actualDurationS,
        requiresConfirmation: false,
        createdAtMs: row.createdAtMs,
      },
    }));
  const allWorkouts = [...workouts, ...extra].sort(
    (left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
  );
  const seasonWorkouts = input.workouts.map((workout) => ({
    id: workout.id,
    date: dateText(workout.dateKey),
    sport: workout.sport,
    name: workout.name,
    durationS: workout.durationS,
  }));
  const selectedSource =
    input.selectedWorkoutId === undefined || input.selectedWorkoutId === null
      ? undefined
      : input.workouts.find((workout) => workout.id === input.selectedWorkoutId);
  const selectedDrift =
    selectedSource === undefined ? undefined : driftByWorkout.get(selectedSource.id);
  const selectedWorkout =
    input.selectedWorkoutId === undefined || input.selectedWorkoutId === null
      ? null
      : (allWorkouts.find((workout) => workout.id === input.selectedWorkoutId) ??
        (selectedSource === undefined
          ? null
          : {
              id: selectedSource.id,
              date: dateText(selectedSource.dateKey),
              sport: selectedSource.sport,
              name: selectedSource.name,
              durationS: selectedSource.durationS,
              ...workoutGuidance(selectedSource),
              ...(selectedDrift === undefined
                ? {}
                : {
                    drift: {
                      status: "detected" as const,
                      eventId: String(selectedDrift.providerEventId),
                      plan: {
                        date: dateText(parsedDriftSnapshot(selectedDrift.planSnapshotJson).dateKey),
                        name: parsedDriftSnapshot(selectedDrift.planSnapshotJson).name,
                        durationS: parsedDriftSnapshot(selectedDrift.planSnapshotJson).durationS,
                      },
                      provider: {
                        date: dateText(
                          parsedDriftSnapshot(selectedDrift.providerSnapshotJson).dateKey,
                        ),
                        name: parsedDriftSnapshot(selectedDrift.providerSnapshotJson).name,
                        durationS: parsedDriftSnapshot(selectedDrift.providerSnapshotJson)
                          .durationS,
                      },
                      error: input.driftError ?? null,
                      detectedAtMs: selectedDrift.detectedAtMs,
                    },
                  }),
            }));
  return PlanActiveProjectionDataSchema.parse({
    plan,
    today: dateText(input.todayDateKey),
    weekIndex,
    todayWorkout: workouts.find((workout) => workout.date === dateText(input.todayDateKey)) ?? null,
    workouts: allWorkouts,
    selectedWorkout,
    selectedWorkoutSourceScenarioId: input.selectedWorkoutSourceScenarioId ?? null,
    returnFocusId: input.returnFocusId ?? null,
    matchSync: input.matchSync,
    selectedWorkoutId: input.selectedWorkoutId ?? null,
    proposals: input.proposals,
    selectedProposalId: input.selectedProposalId ?? null,
    selectedProposalReturn: input.selectedProposalReturn ?? null,
    selectedPlanningRequest: input.selectedPlanningRequest ?? null,
    proposalRevisionText: input.proposalRevisionText ?? null,
    history: input.history,
    selectedHistoryId: input.selectedHistoryId ?? null,
    settings: {
      autoApply: input.settings.autoApply,
      weeklyReview: input.settings.weeklyReview,
      updatedAtMs: input.settings.updatedAtMs,
      selectedSetting: input.selectedSetting ?? null,
      error: input.settingsError ?? null,
    },
    ...(input.weeklyReview === undefined ? {} : { weeklyReview: input.weeklyReview }),
    season: projectPlanSeason({
      plan,
      today: dateText(input.todayDateKey),
      workouts: seasonWorkouts,
      metadata: input.seasonMetadata,
    }),
    readiness: input.readiness,
    ...(input.replacement === undefined ? {} : { replacement: input.replacement }),
  });
}

function activeScenario(
  projection: PlanReconciliationProjection | null,
  override: ActivePlanScenario | undefined,
): ActivePlanScenario {
  if (override !== undefined) return override;
  if (projection === null) return "PL-S037";
  if (projection.job.status === "pending") return "PL-S037";
  if (projection.job.status === "verified") return "PL-S004";
  if (projection.job.status === "running" || projection.job.status === "retrying") {
    return "PL-S042";
  }
  return projection.job.failureCount > 1 ? "PL-S041" : "PL-S039";
}

function selectedPlanningRequestContext(input: {
  readonly record: PlanningRequestRecord | undefined;
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly todayDateKey: number;
}): PlanActiveProjectionData["selectedPlanningRequest"] {
  const record = input.record;
  if (record === undefined) return null;
  if (record.request.attention !== "date_conflict") {
    return { request: record.request, dateConflict: null };
  }
  const requestedDateKey = record.request.requestedDateKey;
  if (requestedDateKey === null) throw new TypeError("A date conflict requires a requested date.");
  const minimumDateKey = Math.max(input.plan.startDateKey, addCivilDays(input.todayDateKey, 1));
  const maximumDateKey =
    input.plan.targetDateKey ??
    addCivilDays(input.plan.startDateKey, input.plan.totalWeeks * 7 - 1);
  const occupied = new Set(input.workouts.map((workout) => workout.dateKey));
  let recommendedDateKey: number | null = null;
  for (let dateKey = addCivilDays(requestedDateKey, 1); dateKey <= maximumDateKey;) {
    if (!occupied.has(dateKey)) {
      recommendedDateKey = dateKey;
      break;
    }
    dateKey = addCivilDays(dateKey, 1);
  }
  if (recommendedDateKey === null) {
    for (let dateKey = minimumDateKey; dateKey < requestedDateKey;) {
      if (!occupied.has(dateKey)) {
        recommendedDateKey = dateKey;
        break;
      }
      dateKey = addCivilDays(dateKey, 1);
    }
  }
  return {
    request: record.request,
    dateConflict: {
      recommendedDate: recommendedDateKey === null ? null : dateText(recommendedDateKey),
      minimumDate: dateText(minimumDateKey),
      maximumDate: dateText(maximumDateKey),
      workouts: input.workouts
        .filter((workout) => workout.dateKey === requestedDateKey)
        .map((workout) => ({
          workoutId: workout.id,
          date: dateText(workout.dateKey),
          name: workout.name,
          durationS: workout.durationS ?? 0,
          ownership: workout.origin,
          replaceable: workout.origin === "coach" && workout.dateKey > input.todayDateKey,
        })),
    },
  };
}

function draftProjection(value: PlanDraftRevisionRecord | undefined): PlanDraftProjection | null {
  if (value === undefined) return null;
  return PlanDraftProjectionSchema.parse({
    id: value.id,
    planId: value.planId,
    revision: value.revision,
    status: value.status,
    snapshot: snapshot(value.snapshotJson),
  });
}

type FtpScenario = "PL-S057" | "PL-S058" | "PL-S059" | "PL-S060" | "PL-S061" | "PL-S062";

function ftpProjection(
  value: PlanFtpSnapshot,
  scenario: FtpScenario | undefined,
  error: PlanError | null,
): PlanFtpProjection {
  const status =
    scenario === "PL-S058"
      ? "no-source"
      : scenario === "PL-S059"
        ? "refresh-failed"
        : scenario === "PL-S060"
          ? "conflict"
          : value.usedSource === null
            ? "required"
            : value.conflict
              ? "conflict"
              : "accepted";
  return PlanFtpProjectionSchema.parse({
    status,
    manual: value.manual,
    intervalsFtp: value.intervalsFtp,
    intervalsEftp: value.intervalsEftp,
    usedSource: value.usedSource,
    usedWatts: value.usedWatts,
    conflict: value.conflict,
    error: status === "refresh-failed" ? error : null,
  });
}

type CourseScenario =
  | "PL-S064"
  | "PL-S065"
  | "PL-S067"
  | "PL-S068"
  | "PL-S069"
  | "PL-S070"
  | "PL-S104";

function courseSummary(value: RaceCourseSnapshot): PlanRaceCourseSummary {
  return {
    fileName: value.fileName,
    format: value.format,
    pointCount: value.preview.pointCount,
    distanceM: value.preview.distanceM,
    elevationGainM: value.preview.elevationGainM,
    elevationStatus: value.preview.elevationStatus,
  };
}

function courseFromJson(value: string | null): RaceCourseSnapshot | null {
  return value === null ? null : parseRaceCourseSnapshot(JSON.parse(value) as unknown);
}

function courseFailureFromJson(
  value: string | null | undefined,
): { readonly fileName: string; readonly detail: string } | null {
  if (value === null || value === undefined) return null;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (typeof parsed.fileName !== "string" || typeof parsed.detail !== "string") return null;
  return { fileName: parsed.fileName, detail: parsed.detail };
}

function storedCourseProjection(
  conversation: PlanConversationRecord,
  draft: PlanDraftRevisionRecord | undefined,
): PlanRaceCourseProjection {
  const failure = courseFailureFromJson(conversation.courseFailureJson);
  if (failure !== null) {
    const accepted =
      draft !== undefined && draft.status !== "discarded"
        ? courseFromJson(draft.raceCourseJson)
        : courseFromJson(conversation.raceCourseJson);
    return courseProjection({
      status: "invalid",
      accepted,
      fileName: failure.fileName,
      detail: failure.detail,
    });
  }
  if (draft !== undefined && draft.status !== "discarded") {
    const course = courseFromJson(draft.raceCourseJson);
    return PlanRaceCourseProjectionSchema.parse(
      course === null
        ? { status: "omitted", accepted: null, candidate: null, fileName: null, detail: null }
        : {
            status: "ready",
            accepted: courseSummary(course),
            candidate: null,
            fileName: null,
            detail: null,
          },
    );
  }
  const course = courseFromJson(conversation.raceCourseJson);
  if (conversation.courseChoiceStatus === "undecided") {
    return PlanRaceCourseProjectionSchema.parse({
      status: "undecided",
      accepted: null,
      candidate: null,
      fileName: null,
      detail: null,
    });
  }
  return PlanRaceCourseProjectionSchema.parse(
    course === null
      ? { status: "omitted", accepted: null, candidate: null, fileName: null, detail: null }
      : {
          status: "ready",
          accepted: courseSummary(course),
          candidate: null,
          fileName: null,
          detail: null,
        },
  );
}

function courseProjection(input: {
  readonly status: PlanRaceCourseProjection["status"];
  readonly accepted?: RaceCourseSnapshot | null;
  readonly candidate?: RaceCourseSnapshot | null;
  readonly fileName?: string | null;
  readonly detail?: string | null;
}): PlanRaceCourseProjection {
  return PlanRaceCourseProjectionSchema.parse({
    status: input.status,
    accepted:
      input.accepted === undefined || input.accepted === null
        ? null
        : courseSummary(input.accepted),
    candidate:
      input.candidate === undefined || input.candidate === null
        ? null
        : courseSummary(input.candidate),
    fileName: input.fileName ?? null,
    detail: input.detail ?? null,
  });
}

interface ReadOverrides {
  readonly readOnly?: boolean;
  readonly sourceConversationId?: string | null;
  readonly ftpScenario?: FtpScenario;
  readonly ftpError?: PlanError | null;
  readonly courseScenario?: CourseScenario;
  readonly course?: PlanRaceCourseProjection;
  readonly dateScenario?: "PL-S046" | "PL-S048" | "PL-S050";
  readonly startDate?: PlanStartDateProjection;
  readonly activeScenario?: ActivePlanScenario;
  readonly reconciliationError?: PlanError;
  readonly endedScenario?: EndedPlanScenario;
  readonly selectedWorkoutId?: string | null;
  readonly selectedWorkoutSourceScenarioId?: string | null;
  readonly returnFocusId?: string | null;
  readonly driftError?: PlanError | null;
  readonly selectedProposalId?: string | null;
  readonly selectedProposalReturn?: PlanProposalReturn | null;
  readonly proposalRevisionText?: string | null;
  readonly proposalOverride?: PlanProposalProjection;
  readonly selectedHistoryId?: string | null;
  readonly selectedSetting?: PlanSetting | null;
  readonly settingsError?: PlanError | null;
  readonly replacementConfirmation?: boolean;
  readonly readiness?: PlanActiveProjectionData["readiness"];
  readonly weeklyReview?: PlanWeeklyReviewProjection;
}

function queueText(queue: ChatQueueSnapshot): string {
  const head = queue.items[0];
  if (head === undefined) return "";
  if (queue.retryRequired !== undefined) {
    return queue.items
      .slice(0, queue.retryRequired.queuedMessageIds.length)
      .map((item) => item.text)
      .join("\n\n");
  }
  if (head.kind === "slash-command") return head.text;
  let size = 1;
  while (queue.items[size]?.kind === "ordinary") size += 1;
  return queue.items
    .slice(0, size)
    .map((item) => item.text)
    .join("\n\n");
}

const fencedStores = new WeakSet<CoachStoreWriterContext["store"]>();
const commandAuthority = new AsyncLocalStorage<{
  readonly store: CoachStoreWriterContext["store"];
  readonly enforce: boolean;
}>();
const transactionScope = new AsyncLocalStorage<CoachStoreWriterContext["store"]>();

export function createPlanningOperations(
  input: {
    readonly context: CoachStoreWriterContext;
    readonly engine: CoachEngine;
    readonly identity: AuthoredIdentity;
  },
  dependencies: CreatePlanningOperationsDependencies = {},
): PlanningOperations {
  const writerFence = createLegacyWriterFence(input.context.store);
  const store = input.context.store;
  if (!fencedStores.has(store)) {
    const transaction = store.transaction.bind(store);
    const run = store.run.bind(store);
    const exec = store.exec.bind(store);
    const requiresAuthority = (): boolean => {
      const command = commandAuthority.getStore();
      return command?.store === store && command.enforce;
    };
    store.transaction = async (operation) => {
      if (!requiresAuthority()) return transaction(operation);
      return transaction(async () => {
        await writerFence.assertLegacyAuthority();
        return transactionScope.run(store, operation);
      });
    };
    store.run = async (sql, params) => {
      if (!requiresAuthority() || transactionScope.getStore() === store) {
        return run(sql, params);
      }
      return store.transaction(() => run(sql, params));
    };
    store.exec = async (sql) => {
      if (!requiresAuthority() || transactionScope.getStore() === store) return exec(sql);
      return store.transaction(() => exec(sql));
    };
    fencedStores.add(store);
  }
  const fencedTransitions = new Set<ExecutePlanTransitionRpcParams["transitionId"]>([
    "PL-T01",
    "PL-T02",
    "PL-T03",
    "PL-T04",
    "PL-T05",
    "PL-T06",
    "PL-T07",
    "PL-T08",
    "PL-T09",
    "PL-T10",
    "PL-T11",
    "PL-T15",
    "PL-T16",
    "PL-T17",
    "PL-T18",
    "PL-T19",
    "PL-T20",
    "PL-T21",
    "PL-T22",
    "PL-T24",
    "PL-T25",
    "PL-T26",
    "PL-T28",
    "PL-T29",
    "PL-T40",
  ]);
  const conversations = dependencies.conversations ?? createLegacyPlanTransitionRepository(store);
  const intakes = dependencies.intakes ?? createPlanIntakeRepository(store);
  const plans = dependencies.plans ?? createPlanRepository(store);
  const draftBuilds = dependencies.draftBuilds ?? createPlanDraftBuildRepository(store);
  const reconciliations = dependencies.reconciliations ?? createPlanReconciliationRepository(store);
  const workoutMatches = dependencies.workoutMatches ?? createPlanWorkoutMatchRepository(store);
  const workoutDrifts = dependencies.workoutDrifts ?? createPlanWorkoutDriftRepository(store);
  const proposalRepository = dependencies.proposals ?? createPlanProposalRepository(store);
  const planningRequests = dependencies.requests;
  const historyRepository = dependencies.history ?? createPlanAdaptationLedgerRepository(store);
  const settingsRepository = dependencies.settings ?? createPlanSettingsRepository(store);
  const replacementRepository = dependencies.replacements ?? createPlanReplacementRepository(store);
  const weeklyReviewRepository =
    dependencies.weeklyReviews ?? createPlanWeeklyReviewRepository(store);
  const raceOutcomeRepository = dependencies.raceOutcomes ?? createPlanRaceOutcomeRepository(store);
  const enqueue = createSerializedLane();
  const orderedWeekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const emptyIntake = async (conversationId: string): Promise<PlanIntakeRecord> => {
    const stamp = input.identity.hlcStamp();
    return {
      conversationId,
      eventName: null,
      eventPriority: null,
      eventDateKey: null,
      athleteGoal: null,
      availabilitySessionsPerWeek: null,
      availabilityWeekdays: [],
      experience: null,
      currentTrainingSummary: null,
      sourceTurnSequence: 0,
      createdAtMs: stamp.physicalMs,
      updatedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    };
  };
  const ensureIntake = async (conversationId: string): Promise<PlanIntakeRecord> => {
    const existing = await intakes.read(conversationId);
    if (existing !== undefined) return existing;
    return intakes.save(await emptyIntake(conversationId), null);
  };
  const applyIntakePatch = (
    current: PlanIntakeRecord,
    patch: PlanIntakePatch,
  ): PlanIntakeRecord => {
    const availability = patch.availability;
    const weekdays =
      availability === undefined
        ? current.availabilityWeekdays
        : availability === null
          ? []
          : orderedWeekdays.filter((weekday) => availability.weekdays.includes(weekday));
    return {
      ...current,
      eventName: patch.eventName === undefined ? current.eventName : patch.eventName,
      eventPriority:
        patch.eventPriority === undefined ? current.eventPriority : patch.eventPriority,
      eventDateKey:
        patch.targetDate === undefined
          ? current.eventDateKey
          : patch.targetDate === null
            ? null
            : dateKeyFromText(patch.targetDate),
      athleteGoal: patch.goal === undefined ? current.athleteGoal : patch.goal,
      availabilitySessionsPerWeek:
        availability === undefined
          ? current.availabilitySessionsPerWeek
          : (availability?.sessionsPerWeek ?? null),
      availabilityWeekdays: weekdays,
      experience: patch.experience === undefined ? current.experience : patch.experience,
      currentTrainingSummary:
        patch.currentTrainingSummary === undefined
          ? current.currentTrainingSummary
          : patch.currentTrainingSummary,
    };
  };
  const projectIntake = (
    current: PlanIntakeRecord,
    turns: readonly PlanConversationTurnRecord[],
  ): PlanIntakeRecord => {
    let next = current;
    for (const turn of turns.filter((turn) => turn.sequence > current.sourceTurnSequence)) {
      try {
        const lineage = snapshot(turn.lineageJson) as { readonly planIntakePatch?: unknown };
        const parsed = PlanIntakePatchSchema.safeParse(lineage.planIntakePatch);
        if (parsed.success) next = applyIntakePatch(next, parsed.data);
      } catch {}
    }
    return next;
  };
  const synchronizeIntake = async (
    conversationId: string,
    knownTurns?: readonly PlanConversationTurnRecord[],
  ): Promise<PlanIntakeRecord> => {
    const current = await ensureIntake(conversationId);
    const turns = knownTurns ?? (await conversations.readTurns(conversationId));
    const pending = turns.filter((turn) => turn.sequence > current.sourceTurnSequence);
    if (pending.length === 0) return current;
    const next = projectIntake(current, pending);
    const stamp = input.identity.hlcStamp();
    return intakes.save(
      {
        ...next,
        sourceTurnSequence: pending.at(-1)?.sequence ?? current.sourceTurnSequence,
        updatedAtMs: stamp.physicalMs,
        deviceId: await input.identity.deviceId(),
        hlcPhysicalMs: stamp.physicalMs,
        hlcCounter: stamp.counter,
      },
      {
        updatedAtMs: current.updatedAtMs,
        deviceId: current.deviceId,
        hlcPhysicalMs: current.hlcPhysicalMs,
        hlcCounter: current.hlcCounter,
      },
    );
  };
  const draftReadiness = async (
    readiness: PlanReadinessInput,
    synchronizedIntake?: PlanIntakeRecord,
  ): Promise<PlanIntakeReadiness> => {
    if (dependencies.isReady !== undefined) {
      return { ready: await dependencies.isReady(readiness), missing: [] };
    }
    const [intake, ftp] = await Promise.all([
      synchronizedIntake ?? synchronizeIntake(readiness.conversation.id, readiness.turns),
      dependencies.ftp?.read(),
    ]);
    const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
    return evaluatePlanIntakeReadiness({
      intake,
      ftp,
      courseChoice: readiness.conversation.courseChoiceStatus,
      minimumEventDateKey: todayDateKey,
      maximumEventDateKey: addCivilDays(todayDateKey, 24 * 7 - 1),
    });
  };
  const refuseProposal = async (
    proposal: PlanProposalRecord,
    reason = PROPOSAL_INVALID.message,
  ): Promise<void> => {
    const stamp = input.identity.hlcStamp();
    const linkedRequest = await planningRequests?.readByProposalId(proposal.id);
    const requestWorkout =
      linkedRequest === undefined ? null : planningRequestWorkout(linkedRequest);
    await proposalRepository.resolve({
      id: proposal.id,
      status: "refused",
      reason,
      resolvedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
      ...(linkedRequest === undefined
        ? {}
        : {
            requestCompletion: {
              requestId: linkedRequest.request.requestId,
              expectedRevision: linkedRequest.request.revision,
              expectedProposalId: proposal.id,
              result: {
                kind: "ended" as const,
                resultId: input.identity.newUlid(),
                completedAtMs: stamp.physicalMs,
                title: "Proposal ended",
                detail: `${requestWorkout!.name} was not applied; the active Plan remains unchanged.`,
                workoutRef: requestWorkout!.workoutRef,
                planRevisionId: null,
              },
              resolvedDateKey: linkedRequest.request.resolvedDateKey,
              updatedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            },
          }),
    });
  };
  const parseProposalMutationOrRefuse = async (
    proposal: PlanProposalRecord,
  ): Promise<PlanProposalMutation | null> => {
    try {
      return parsePlanProposalMutation(proposal.mutationJson);
    } catch (error) {
      if (!(error instanceof PlanProposalError)) throw error;
      await refuseProposal(proposal);
      return null;
    }
  };

  const readActive = async (
    plan: PlanRecord,
    revision: number,
    overrides: ReadOverrides,
  ): Promise<PlanReadModel> => {
    const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
    const [workouts, job, historyRows, settings, replacementLineage] = await Promise.all([
      plans.readWorkouts(plan.id),
      reconciliations.readLatestJob(plan.id, "mirror"),
      historyRepository.readForPlan(plan.id),
      settingsRepository.read(plan.id),
      replacementRepository.readByReplacementPlanId(plan.id),
    ]);
    if (settings === undefined) throw new TypeError("An active Plan requires Plan settings.");
    const projection =
      job === undefined ? null : await projectPlanReconciliation(reconciliations, job);
    const week = planWeekIndex(plan, todayDateKey);
    const weekIndex =
      week.kind === "inside" ? week.weekIndex : week.side === "before" ? 1 : plan.totalWeeks;
    const weekStartDateKey = addCivilDays(plan.startDateKey, (weekIndex - 1) * 7);
    const matchSync = await workoutMatches.readSyncStatus();
    const refreshed = await commandAuthority.run({ store, enforce: false }, () =>
      refreshPlanWorkoutMatches({
        planId: plan.id,
        workouts,
        startDateKey: weekStartDateKey,
        endDateKey: addCivilDays(weekStartDateKey, 6),
        repository: workoutMatches,
        identity: {
          newId: () => input.identity.newUlid(),
          deviceId: () => input.identity.deviceId(),
          stamp: () => input.identity.hlcStamp(),
        },
      }),
    );
    const matchRows = projectWorkoutMatches({
      workouts: workouts.filter(
        (workout) =>
          workout.dateKey >= weekStartDateKey &&
          workout.dateKey <= addCivilDays(weekStartDateKey, 6),
      ),
      activities: refreshed.activities,
      matches: refreshed.matches,
      todayDateKey,
      awaitingSync: matchSync.awaitingSync,
    });
    let weeklyReview = overrides.weeklyReview;
    if (
      weeklyReview === undefined &&
      !matchSync.awaitingSync &&
      matchSync.lastSuccessfulSyncAtMs !== null
    ) {
      const reviewWindow = selectWeeklyReviewWindow({
        todayDateKey,
        planStartDateKey: plan.startDateKey,
        targetDateKey: plan.targetDateKey,
        lastSuccessfulSyncDateKey: utcDateKeyFromEpochMs(matchSync.lastSuccessfulSyncAtMs),
        enabled: settings.weeklyReview,
      });
      if (reviewWindow !== null) {
        const stored = await weeklyReviewRepository.readForWeek(
          plan.id,
          reviewWindow.weekStartDateKey,
        );
        if (
          stored === undefined ||
          (stored.status === "pending" &&
            stored.lastAttemptSyncAtMs < matchSync.lastSuccessfulSyncAtMs)
        ) {
          weeklyReview = PlanWeeklyReviewProjectionSchema.parse({
            status: "due",
            weekStart: dateText(reviewWindow.weekStartDateKey),
            weekEnd: dateText(reviewWindow.weekEndDateKey),
            lastSuccessfulSyncAtMs: matchSync.lastSuccessfulSyncAtMs,
          });
        }
      }
    }
    let drifts = await workoutDrifts.readOpenForPlan(plan.id);
    if (!overrides.readOnly && dependencies.workoutDriftCalendar !== undefined) {
      try {
        const windowEndDateKey = addCivilDays(todayDateKey, 6);
        const events = await dependencies.workoutDriftCalendar.listEvents({
          startDateKey: todayDateKey,
          endDateKey: windowEndDateKey,
        });
        drifts = await refreshPlanWorkoutDrifts(
          { plan, workouts, events, todayDateKey, windowEndDateKey },
          {
            repository: workoutDrifts,
            identity: {
              newId: () => input.identity.newUlid(),
              deviceId: () => input.identity.deviceId(),
              stamp: () => input.identity.hlcStamp(),
            },
            now: () => input.identity.hlcStamp().physicalMs,
          },
        );
      } catch {
        // Provider reads are best effort; an already-detected decision stays durable and visible.
      }
    }
    let replacementData: PlanActiveProjectionData["replacement"] | undefined;
    let cleanupProjection: PlanReconciliationProjection | null = null;
    if (replacementLineage !== undefined) {
      const [previousPlan, previousWorkouts, cleanupJob] = await Promise.all([
        plans.read(replacementLineage.previousPlanId),
        plans.readWorkouts(replacementLineage.previousPlanId),
        reconciliations.readJob(replacementLineage.cleanupJobId),
      ]);
      if (previousPlan === undefined || cleanupJob === undefined) {
        throw new TypeError("Replacement lineage is incomplete.");
      }
      const previousPlanProjection = draftPlanProjection(previousPlan, previousWorkouts);
      if (previousPlanProjection === null) throw new TypeError("Previous Plan is unavailable.");
      const cleanupItems = await reconciliations.readItems(cleanupJob.id);
      cleanupProjection = await projectPlanReconciliation(reconciliations, cleanupJob);
      replacementData = {
        id: replacementLineage.id,
        previousPlan: previousPlanProjection,
        activatedAtMs: replacementLineage.createdAtMs,
        cleanupItems: cleanupItems.map((item) => ({
          id: item.id,
          date: dateText(item.dateKey),
          externalId: item.externalId,
          status:
            item.status === "verified"
              ? "verified"
              : item.status === "failed"
                ? "failed"
                : item.status === "running"
                  ? "running"
                  : "pending",
          errorCode: item.lastErrorCode,
        })),
      };
    }
    const replacementScenario =
      cleanupProjection === null
        ? undefined
        : cleanupProjection.job.status === "failed"
          ? "PL-S083"
          : cleanupProjection.job.status === "retrying"
            ? "PL-S084"
            : cleanupProjection.job.status === "verified"
              ? projection === null || projection.job.status === "pending"
                ? "PL-S085"
                : projection.job.status === "verified"
                  ? "PL-S088"
                  : projection.job.status === "failed"
                    ? projection.job.failureCount > 1
                      ? "PL-S041"
                      : "PL-S039"
                    : "PL-S086"
              : "PL-S082";
    const baseScenario = replacementScenario ?? activeScenario(projection, undefined);
    const scenarioId =
      overrides.activeScenario ??
      (matchSync.awaitingSync && baseScenario === "PL-S004" ? "PL-S013" : baseScenario);
    const displayedProjection =
      cleanupProjection !== null && cleanupProjection.job.status !== "verified"
        ? cleanupProjection
        : projection;
    const status =
      overrides.reconciliationError !== undefined
        ? "failed"
        : displayedProjection === null || displayedProjection.job.status === "pending"
          ? "not-started"
          : displayedProjection.job.status === "verified"
            ? "verified"
            : displayedProjection.job.status === "failed"
              ? "failed"
              : "running";
    const verificationFailure =
      displayedProjection?.job.lastErrorCode === "calendar-verification-failed";
    const proposalRows = await proposalRepository.readOpenForPlan(plan.id);
    const proposalProjections = (
      await Promise.all(
        proposalRows.map(async (proposal): Promise<PlanProposalProjection | null> => {
          const premises = await proposalRepository.readPremises(proposal.id);
          try {
            const validated = validatePlanProposal({
              proposal,
              premises,
              plan,
              workouts,
              todayDateKey,
              calculateWeekLoad: dependencies.proposalLoadCalculator,
            });
            return proposalProjection({
              proposal,
              premises,
              mutation: validated.mutation,
              stale: false,
            });
          } catch (error) {
            if (!(error instanceof PlanProposalError)) throw error;
            if (error.code === "missing-capability") {
              return proposalProjection({
                proposal,
                premises,
                mutation: parsePlanProposalMutation(proposal.mutationJson),
                stale: false,
                error: UNAVAILABLE,
              });
            }
            if (error.code !== "stale-base") {
              if (!overrides.readOnly) await refuseProposal(proposal);
              return null;
            }
            try {
              return proposalProjection({
                proposal,
                premises,
                mutation: parsePlanProposalMutation(proposal.mutationJson),
                stale: true,
                error: PROPOSAL_STALE,
              });
            } catch {
              if (!overrides.readOnly) await refuseProposal(proposal);
              return null;
            }
          }
        }),
      )
    ).filter((proposal): proposal is PlanProposalProjection => proposal !== null);
    const mergedProposalProjections =
      overrides.proposalOverride === undefined
        ? proposalProjections
        : [
            overrides.proposalOverride,
            ...proposalProjections.filter(
              (proposal) => proposal.id !== overrides.proposalOverride!.id,
            ),
          ];
    const selectedRequestRecord =
      overrides.selectedProposalId === undefined || overrides.selectedProposalId === null
        ? undefined
        : await planningRequests?.readByProposalId(overrides.selectedProposalId);
    const selectedPlanningRequest = selectedPlanningRequestContext({
      record: selectedRequestRecord,
      plan,
      workouts,
      todayDateKey,
    });
    const readiness =
      overrides.readiness ??
      projectPlanReadiness(
        dependencies.readiness === undefined
          ? unavailableReadinessInput(plan, todayDateKey)
          : await dependencies.readiness
              .read({ plan, workouts, todayDateKey })
              .catch(() => unavailableReadinessInput(plan, todayDateKey)),
      ).projection;
    return buildActivePlanReadModel({
      scenarioId,
      planId: plan.id,
      revision,
      data: activePlanData({
        plan,
        workouts,
        todayDateKey,
        matchRows,
        matchSync,
        selectedWorkoutId: overrides.selectedWorkoutId,
        selectedWorkoutSourceScenarioId: overrides.selectedWorkoutSourceScenarioId,
        returnFocusId: overrides.returnFocusId,
        drifts,
        driftError: overrides.driftError,
        proposals: mergedProposalProjections,
        selectedProposalId: overrides.selectedProposalId,
        selectedProposalReturn: overrides.selectedProposalReturn,
        selectedPlanningRequest,
        proposalRevisionText: overrides.proposalRevisionText,
        history: historyProjection({ plan, workouts, history: historyRows, todayDateKey }),
        selectedHistoryId: overrides.selectedHistoryId,
        settings,
        weeklyReview,
        selectedSetting: overrides.selectedSetting,
        settingsError: overrides.settingsError,
        replacement: replacementData,
        seasonMetadata: projectCyclingSeasonMetadata(snapshot(plan.structureJson), plan.totalWeeks),
        readiness,
      }),
      reconciliation: {
        status,
        created: displayedProjection?.created ?? 0,
        pending: displayedProjection?.pending ?? 0,
        failed: displayedProjection?.failed ?? 0,
        total: displayedProjection?.total ?? 0,
        currentThrough:
          displayedProjection?.job.status === "verified"
            ? dateText(displayedProjection.job.windowEndDateKey)
            : null,
        error:
          status === "failed"
            ? (overrides.reconciliationError ??
              (verificationFailure
                ? CALENDAR_VERIFICATION_FAILED
                : cleanupProjection !== null && cleanupProjection.job.status !== "verified"
                  ? CALENDAR_CLEANUP_FAILED
                  : CALENDAR_UPDATE_FAILED))
            : null,
      },
      proposalCapabilities: {
        canRevise: dependencies.proposalReviser !== undefined,
        canVerifyPremises: dependencies.proposalPremiseReader !== undefined,
        canCalculateLoad: dependencies.proposalLoadCalculator !== undefined,
      },
      attentionCreatedAtMs: displayedProjection?.job.createdAtMs,
    });
  };

  const readEnded = async (
    plan: PlanRecord,
    revision: number,
    overrides: ReadOverrides,
  ): Promise<PlanReadModel> => {
    const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
    const [workouts, job, raceOutcome, matchSync] = await Promise.all([
      plans.readWorkouts(plan.id),
      reconciliations.readLatestJob(plan.id, "cleanup"),
      raceOutcomeRepository.read(plan.id),
      workoutMatches.readSyncStatus(),
    ]);
    const projectedPlan = draftPlanProjection(plan, workouts);
    if (projectedPlan === null) throw new TypeError("An ended Plan projection requires a Plan.");
    const projection =
      job === undefined ? null : await projectPlanReconciliation(reconciliations, job);
    const items = job === undefined ? [] : await reconciliations.readItems(job.id);
    const outcomeAvailable = raceOutcomeDue({
      plan,
      todayDateKey,
      awaitingSync: matchSync.awaitingSync,
      outcome: raceOutcome,
    });
    const scenarioId: EndedPlanScenario =
      overrides.endedScenario ??
      (job !== undefined && job.status !== "verified"
        ? job.status === "failed"
          ? "PL-S053"
          : job.status === "retrying"
            ? "PL-S055"
            : "PL-S052"
        : raceOutcome?.outcome === "completed"
          ? "PL-S014"
          : raceOutcome?.outcome === "not-completed"
            ? "PL-S096"
            : outcomeAvailable
              ? "PL-S095"
              : job?.status === "verified"
                ? "PL-S089"
                : "PL-S014");
    const status =
      job === undefined
        ? ("not-applicable" as const)
        : job.status === "verified"
          ? ("verified" as const)
          : job.status === "failed"
            ? ("failed" as const)
            : job.status === "pending"
              ? ("not-started" as const)
              : ("running" as const);
    const verificationFailure = job?.lastErrorCode === "calendar-verification-failed";
    const data: PlanEndedProjectionData = PlanEndedProjectionDataSchema.parse({
      plan: projectedPlan,
      endedAtMs: plan.updatedAtMs,
      raceOutcome: raceOutcome?.outcome ?? null,
      outcomeAvailable,
      cleanupItems: items.map((item) => ({
        id: item.id,
        date: dateText(item.dateKey),
        externalId: item.externalId,
        status:
          item.status === "verified"
            ? "verified"
            : item.status === "failed"
              ? "failed"
              : item.status === "running"
                ? "running"
                : "pending",
        errorCode: item.lastErrorCode,
      })),
    });
    return buildEndedPlanReadModel({
      scenarioId,
      planId: plan.id,
      revision,
      data,
      reconciliation: {
        status,
        created: projection?.created ?? 0,
        pending: projection?.pending ?? 0,
        failed: projection?.failed ?? 0,
        total: projection?.total ?? 0,
        currentThrough: job?.status === "verified" ? dateText(job.windowEndDateKey) : null,
        error:
          status === "failed"
            ? verificationFailure
              ? CALENDAR_CLEANUP_VERIFICATION_FAILED
              : CALENDAR_CLEANUP_FAILED
            : null,
      },
    });
  };

  const read = async (
    overrides: ReadOverrides = {},
    activePlan?: PlanRecord,
  ): Promise<PlanReadModel> => {
    if (!overrides.readOnly && (await writerFence.fenced())) {
      overrides = { ...overrides, readOnly: true };
    }
    if (activePlan !== undefined) return readActive(activePlan, 0, overrides);
    const fence = await writerFence.read();
    if (fence.activePlanId !== null) {
      const activePlan = await plans.read(fence.activePlanId);
      if (activePlan === undefined) throw new TypeError("An active Plan requires a Plan record.");
      if (activePlan.status === "active" && overrides.endedScenario === undefined) {
        return readActive(activePlan, 0, overrides);
      }
      return readEnded(activePlan, 0, overrides);
    }
    const conversation = await conversations.readLatestOpenConversation();
    if (conversation === undefined) {
      const latestPlan = await plans.readLatest();
      if (latestPlan?.status === "active") return readActive(latestPlan, 0, overrides);
      if (latestPlan?.status === "ended") return readEnded(latestPlan, 0, overrides);
      return buildPlanLifecycleReadModel({
        conversation: null,
        turns: [],
        readyToCreateDraft: false,
        queue: EMPTY_QUEUE,
        decision: null,
        draft: null,
      });
    }
    const chatId = `plan:${conversation.id}`;
    const [turns, draft, queue, decision, ftp] = await Promise.all([
      conversations.readTurns(conversation.id),
      conversations.readLatestDraftRevision(conversation.id),
      overrides.readOnly
        ? EMPTY_QUEUE
        : (input.engine.getChatQueue?.({ chatId }).catch(() => EMPTY_QUEUE) ?? EMPTY_QUEUE),
      overrides.readOnly
        ? null
        : input.engine
            .getCoachDecision({ chatId })
            .then((result) => result.decision)
            .catch(() => null),
      dependencies.ftp?.read(),
    ]);
    const projectedPlanId = draft?.planId ?? conversation.planId;
    const draftPlan = projectedPlanId === null ? undefined : await plans.read(projectedPlanId);
    const draftWorkouts = draftPlan === undefined ? [] : await plans.readWorkouts(draftPlan.id);
    if (draftPlan?.status === "active") {
      return readActive(draftPlan, draft?.revision ?? 0, overrides);
    }
    if (draftPlan?.status === "ended") {
      return readEnded(draftPlan, draft?.revision ?? 0, overrides);
    }
    const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
    const projectedStartDate =
      overrides.startDate ??
      (draftPlan === undefined
        ? undefined
        : startDateProjection({ plan: draftPlan, todayDateKey }));
    const dateScenario =
      overrides.dateScenario ?? (projectedStartDate?.status === "invalid" ? "PL-S046" : undefined);
    const intake = overrides.readOnly
      ? projectIntake(
          (await intakes.read(conversation.id)) ?? {
            conversationId: conversation.id,
            eventName: null,
            eventPriority: null,
            eventDateKey: null,
            athleteGoal: null,
            availabilitySessionsPerWeek: null,
            availabilityWeekdays: [],
            experience: null,
            currentTrainingSummary: null,
            sourceTurnSequence: 0,
            createdAtMs: conversation.createdAtMs,
            updatedAtMs: conversation.updatedAtMs,
            deviceId: conversation.deviceId,
            hlcPhysicalMs: conversation.hlcPhysicalMs,
            hlcCounter: conversation.hlcCounter,
          },
          turns,
        )
      : await synchronizeIntake(conversation.id, turns);
    const readiness = await draftReadiness({ conversation, turns, draft }, intake);
    const ready = conversation.courseChoiceStatus !== "undecided" && readiness.ready;
    const projectedCourse = overrides.course ?? storedCourseProjection(conversation, draft);
    const courseScenario =
      overrides.courseScenario ?? (projectedCourse.status === "invalid" ? "PL-S065" : undefined);
    return buildPlanLifecycleReadModel({
      conversation: {
        id: conversation.id,
        planId: conversation.planId,
        replacesPlanId: conversation.replacesPlanId,
        sourceConversationId: overrides.sourceConversationId ?? null,
      },
      turns,
      readyToCreateDraft: ready,
      missingDraftRequirements: [...readiness.missing],
      intake: {
        eventName: intake.eventName,
        eventPriority: intake.eventPriority,
        eventDate: intake.eventDateKey === null ? null : dateText(intake.eventDateKey),
        goal: intake.athleteGoal,
        availabilitySessionsPerWeek: intake.availabilitySessionsPerWeek,
        availabilityWeekdays: [...intake.availabilityWeekdays],
        experience: intake.experience,
        currentTrainingSummary: intake.currentTrainingSummary,
      },
      queue,
      decision,
      draft: draftProjection(draft),
      plan: draftPlanProjection(draftPlan, draftWorkouts),
      startDate: projectedStartDate,
      ...(ftp === undefined
        ? {}
        : { ftp: ftpProjection(ftp, overrides.ftpScenario, overrides.ftpError ?? null) }),
      ...(overrides.ftpScenario === undefined ? {} : { ftpScenario: overrides.ftpScenario }),
      course: projectedCourse,
      ...(courseScenario === undefined ? {} : { courseScenario }),
      ...(dateScenario === undefined ? {} : { dateScenario }),
      ...(overrides.replacementConfirmation === undefined
        ? {}
        : { replacementConfirmation: overrides.replacementConfirmation }),
    });
  };

  const deliver = (
    onEvent: ((event: PlanProgressEvent) => void) | undefined,
    event: PlanProgressEvent,
  ): void => {
    const parsed = PlanProgressEventSchema.parse(event);
    try {
      onEvent?.(parsed);
    } catch {}
  };

  const appendTurn = async (
    conversationId: string,
    athleteText: string,
    coachText: string,
    engineTurnId: string | null,
    intakePatch?: PlanIntakePatch,
  ): Promise<boolean> => {
    if (!/\S/u.test(coachText) || engineTurnId === null) return false;
    const existing = await conversations.readTurns(conversationId);
    if (
      existing.some((turn) => {
        const lineage = snapshot(turn.lineageJson) as { readonly engineTurnId?: unknown };
        return lineage.engineTurnId === engineTurnId;
      })
    ) {
      await synchronizeIntake(conversationId, existing);
      return false;
    }
    const stamp = input.identity.hlcStamp();
    const deviceId = await input.identity.deviceId();
    const turn: PlanConversationTurnRecord = {
      id: input.identity.newUlid(),
      conversationId,
      sequence: existing.length + 1,
      athleteText,
      coachText,
      lineageJson: JSON.stringify({
        engineTurnId,
        ...(intakePatch === undefined ? {} : { planIntakePatch: intakePatch }),
      }),
      completedAtMs: stamp.physicalMs,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    };
    const current = await ensureIntake(conversationId);
    const projected = intakePatch === undefined ? current : applyIntakePatch(current, intakePatch);
    const next: PlanIntakeRecord = {
      ...projected,
      sourceTurnSequence: turn.sequence,
      updatedAtMs: stamp.physicalMs,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    };
    if (intakes.appendTurnWithIntake !== undefined) {
      await intakes.appendTurnWithIntake(turn, next, {
        updatedAtMs: current.updatedAtMs,
        deviceId: current.deviceId,
        hlcPhysicalMs: current.hlcPhysicalMs,
        hlcCounter: current.hlcCounter,
      });
      return true;
    }
    const saved = await conversations.appendTurn(turn);
    await synchronizeIntake(conversationId, [...existing, saved]);
    return true;
  };

  const executeCoachCall = async (
    command: Extract<ExecutePlanTransitionRpcParams, { transitionId: "PL-T05" }>,
    operationId: string,
    onEvent: ((event: PlanProgressEvent) => void) | undefined,
  ): Promise<void> => {
    const conversation = await conversations.readConversation(command.conversationId);
    if (conversation === undefined || conversation.status !== "open") throw UNAVAILABLE;
    const chatId = `plan:${conversation.id}`;
    const forward = (event: TurnEvent): void => {
      deliver(onEvent, {
        commandId: command.commandId,
        transitionId: command.transitionId,
        operationId,
        phase: "running",
        completed: 0,
        total: 1,
        turnEvent: event,
      });
    };
    let pendingText = command.text;
    if (command.decision === undefined) {
      const persistedTurns = await conversations.readTurns(conversation.id);
      await input.engine.replacePlanChatHistory?.({
        chatId,
        turns: persistedTurns.map((turn) => ({
          athleteText: turn.athleteText,
          coachText: turn.coachText,
        })),
      });
    }
    let queue = await (input.engine.getChatQueue?.({ chatId }) ?? Promise.resolve(EMPTY_QUEUE));
    if (command.decision !== undefined) {
      let turnId: string | null = null;
      const onTurnEvent = (event: TurnEvent): void => {
        if (event.type === "turn-start") turnId = event.turnId;
        forward(event);
      };
      if (command.decision.action === "skip") {
        await input.engine.skipCoachDecision({
          chatId,
          decisionId: command.decision.decisionId,
        });
        return;
      }
      const result =
        command.decision.action === "answer"
          ? await input.engine.answerCoachDecision(
              {
                chatId,
                decisionId: command.decision.decisionId,
                answer: command.decision.answer,
              },
              onTurnEvent,
            )
          : await input.engine.resumeCoachDecision(
              { chatId, decisionId: command.decision.decisionId },
              onTurnEvent,
            );
      const continuation =
        result.decision.status === "answered" ? result.decision.continuation : null;
      if (continuation?.status === "completed") {
        const requestedPatch = await input.engine.getPlanDecisionIntakePatch?.({
          chatId,
          decisionId: command.decision.decisionId,
        });
        const continuationPatch = PlanIntakePatchSchema.safeParse(
          continuation.lineage?.planIntakePatch,
        );
        const combinedPatch =
          requestedPatch === undefined && !continuationPatch.success
            ? undefined
            : PlanIntakePatchSchema.parse({
                ...requestedPatch,
                ...(continuationPatch.success ? continuationPatch.data : {}),
              });
        const appended = await appendTurn(
          conversation.id,
          pendingText,
          continuation.coachText,
          turnId ?? continuation.turnId,
          combinedPatch,
        );
        if (appended) {
          await input.engine.commitPlanChatTurn?.({
            chatId,
            turnId: turnId ?? continuation.turnId,
          });
        }
      }
      return;
    }
    let first = true;
    while (first || queue.items.length > 0) {
      first = false;
      let turnId: string | null = null;
      const onTurnEvent = (event: TurnEvent): void => {
        if (event.type === "turn-start") turnId = event.turnId;
        forward(event);
      };
      let resultText = "";
      let intakePatch: PlanIntakePatch | undefined;
      if (queue.items.length > 0 && queueText(queue) === pendingText) {
        let result: ChatQueueRunResult;
        if (queue.retryRequired !== undefined) {
          if (input.engine.retryQueuedTurn === undefined) throw UNAVAILABLE;
          result = await input.engine.retryQueuedTurn(
            { chatId, claimId: queue.retryRequired.claimId },
            onTurnEvent,
          );
        } else if (queue.items[0]?.kind === "slash-command" && queue.items[0]?.restored) {
          if (input.engine.runQueuedCommand === undefined) throw UNAVAILABLE;
          result = await input.engine.runQueuedCommand(
            { chatId, queuedMessageId: queue.items[0].queuedMessageId },
            onTurnEvent,
          );
        } else {
          if (input.engine.resumeChatQueue === undefined) throw UNAVAILABLE;
          result = await input.engine.resumeChatQueue({ chatId }, onTurnEvent);
        }
        resultText = result.response?.decision?.question ?? result.response?.text ?? "";
        intakePatch = result.response?.planIntakePatch;
        queue = result.snapshot;
      } else {
        const result = await input.engine.chat({ chatId, message: pendingText }, onTurnEvent);
        resultText = result.decision?.question ?? result.text;
        intakePatch = result.planIntakePatch;
        queue = await (input.engine.getChatQueue?.({ chatId }) ?? Promise.resolve(EMPTY_QUEUE));
      }
      const appended = await appendTurn(
        conversation.id,
        pendingText,
        resultText,
        turnId,
        intakePatch,
      );
      if (appended && turnId !== null) {
        await input.engine.commitPlanChatTurn?.({ chatId, turnId });
      }
      if (queue.retryRequired !== undefined || queue.items.length === 0) break;
      const nextText = queueText(queue);
      if (!/\S/u.test(nextText) || (nextText === pendingText && resultText.length === 0)) break;
      pendingText = nextText;
    }
  };

  const saveDraft = async (
    conversation: PlanConversationRecord,
    previous: PlanDraftRevisionRecord | undefined,
    build: PlanDraftBuild,
    course: RaceCourseSnapshot | null,
  ): Promise<void> => {
    const timestamp = input.identity.hlcStamp().physicalMs;
    const deviceId = await input.identity.deviceId();
    const conversationStamp = input.identity.hlcStamp();
    const nextConversation: PlanConversationRecord = {
      ...conversation,
      planId: build.plan.id,
      courseChoiceStatus: course === null ? "omitted" : "attached",
      raceCourseJson: course === null ? null : JSON.stringify(course),
      courseFailureJson: null,
      updatedAtMs: timestamp,
      deviceId,
      hlcPhysicalMs: conversationStamp.physicalMs,
      hlcCounter: conversationStamp.counter,
    };
    const stamp = input.identity.hlcStamp();
    const nextDraft: PlanDraftRevisionRecord = {
      id: build.draftRevisionId ?? input.identity.newUlid(),
      conversationId: conversation.id,
      planId: build.plan.id,
      revision: (previous?.revision ?? 0) + 1,
      parentRevisionId: previous?.id ?? null,
      status: "ready",
      snapshotJson: JSON.stringify(build.snapshot),
      raceCourseJson: course === null ? null : JSON.stringify(course),
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    };
    if (build.checkpointId !== undefined && build.draftRevisionId !== undefined) {
      await draftBuilds.commitReady({
        checkpointId: build.checkpointId,
        conversation: nextConversation,
        plan: build.plan,
        workouts: build.workouts,
        draft: nextDraft,
      });
      return;
    }
    await plans.replace(build.plan, build.workouts);
    await conversations.saveConversation(nextConversation);
    await conversations.saveDraftRevision(nextDraft);
  };

  const saveConversationCourse = async (
    conversation: PlanConversationRecord,
    course: RaceCourseSnapshot | null,
  ): Promise<void> => {
    const stamp = input.identity.hlcStamp();
    await conversations.saveConversation({
      ...conversation,
      courseChoiceStatus: course === null ? "omitted" : "attached",
      raceCourseJson: course === null ? null : JSON.stringify(course),
      courseFailureJson: null,
      updatedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const saveConversationCourseFailure = async (
    conversation: PlanConversationRecord,
    failure: { readonly fileName: string; readonly detail: string },
  ): Promise<void> => {
    const stamp = input.identity.hlcStamp();
    await conversations.saveConversation({
      ...conversation,
      courseFailureJson: JSON.stringify(failure),
      updatedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const saveProposalRevision = async (inputValue: {
    readonly current: PlanProposalRecord;
    readonly premises: readonly PlanProposalPremiseRecord[];
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly instruction: string;
    readonly requestAttention?: PlanningRequestAttention;
    readonly requestResolvedDateKey?: number | null;
  }): Promise<PlanProposalRecord> => {
    if (dependencies.proposalReviser === undefined)
      throw new Error("Proposal revision unavailable.");
    const build = await dependencies.proposalReviser.revise({
      proposal: inputValue.current,
      premises: inputValue.premises,
      plan: inputValue.plan,
      workouts: inputValue.workouts,
      instruction: inputValue.instruction,
    });
    const timestamp = input.identity.hlcStamp().physicalMs;
    const stamp = input.identity.hlcStamp();
    const deviceId = await input.identity.deviceId();
    const next: PlanProposalRecord = {
      id: input.identity.newUlid(),
      planId: inputValue.plan.id,
      parentProposalId: inputValue.current.id,
      revision: inputValue.current.revision + 1,
      status: "proposed",
      title: build.title,
      rationale: build.rationale,
      confidence: build.confidence,
      mutationJson: encodePlanProposalMutation(build.mutation),
      baseSnapshotJson: encodePlanProposalBase(
        capturePlanProposalBase(inputValue.plan, inputValue.workouts),
      ),
      refusalReason: null,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      resolvedAtMs: null,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    };
    const premiseRecords = build.premises.map((premise): PlanProposalPremiseRecord => ({
      ...premise,
      id: input.identity.newUlid(),
      proposalId: next.id,
      createdAtMs: timestamp,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    }));
    validatePlanProposal({
      proposal: next,
      premises: premiseRecords,
      plan: inputValue.plan,
      workouts: inputValue.workouts,
      todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
      calculateWeekLoad: dependencies.proposalLoadCalculator,
    });
    const linkedRequest = await planningRequests?.readByProposalId(inputValue.current.id);
    return proposalRepository.save(
      next,
      premiseRecords,
      linkedRequest === undefined
        ? undefined
        : {
            requestId: linkedRequest.request.requestId,
            expectedRevision: linkedRequest.request.revision,
            previousProposalId: inputValue.current.id,
            proposalId: next.id,
            attention: inputValue.requestAttention ?? "needs_review",
            resolvedDateKey:
              inputValue.requestResolvedDateKey ?? linkedRequest.request.resolvedDateKey,
            updatedAtMs: timestamp,
            deviceId,
            hlcPhysicalMs: stamp.physicalMs,
            hlcCounter: stamp.counter,
          },
    );
  };

  const revisePlanningRequestAttention = async (
    record: PlanningRequestRecord,
    attention: PlanningRequestAttention,
    proposalId = record.request.proposalId,
    resolvedDateKey = record.request.resolvedDateKey,
  ): Promise<PlanningRequestRecord> => {
    if (planningRequests === undefined) return record;
    const stamp = input.identity.hlcStamp();
    return planningRequests.reviseOpen({
      requestId: record.request.requestId,
      expectedRevision: record.request.revision,
      planConversationId: record.request.planConversationId,
      proposalId,
      attention,
      resolvedDateKey,
      updatedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const reject = async (
    error: PlanError,
    overrides: ReadOverrides = {},
  ): Promise<ExecutePlanTransitionRpcResult> => {
    if (commandAuthority.getStore()?.enforce) {
      try {
        await writerFence.assertLegacyAuthority();
      } catch (authorityError) {
        if (!(authorityError instanceof LegacyPlanningAuthorityError)) throw authorityError;
        error = { code: "conflict", message: authorityError.message, retryable: false };
        overrides = { ...overrides, readOnly: true };
      }
    }
    return ExecutePlanTransitionRpcResultSchema.parse({
      status: "rejected",
      error,
      state: await read({ ...overrides, ftpError: error }),
    });
  };

  const chatOriginatedResult = async (
    request: PlanningRequestReadModel,
  ): Promise<PlanReadModel> => {
    const latestPlan = await plans.readLatest();
    const lifecycle: PlanReadModel["lifecycle"] =
      latestPlan?.status === "active"
        ? "active"
        : latestPlan?.status === "draft"
          ? "draft"
          : latestPlan?.status === "ended"
            ? "ended"
            : "none";
    return buildChatOriginatedPlanResultReadModel({
      request,
      planId: latestPlan?.id ?? null,
      lifecycle,
      revision: request.revision,
    });
  };

  return {
    async getPlanState(request) {
      GetPlanStateRpcParamsSchema.parse(request);
      return commandAuthority.run({ store, enforce: true }, async () => {
        try {
          const readOnly = await writerFence.fenced();
          return GetPlanStateRpcResultSchema.parse({
            status: "ready",
            state: await read({ readOnly }),
          });
        } catch (error) {
          if (!(error instanceof LegacyPlanningAuthorityError)) throw error;
          return GetPlanStateRpcResultSchema.parse({
            status: "ready",
            state: await read({ readOnly: true }),
          });
        }
      });
    },
    executePlanTransition(request, onEvent) {
      const command = ExecutePlanTransitionRpcParamsSchema.parse(request);
      const execute = async (): Promise<ExecutePlanTransitionRpcResult> => {
        const fenced = await writerFence.fenced();
        if (
          command.transitionId === "PL-T01" ||
          command.transitionId === "PL-T25" ||
          (fenced &&
            (fencedTransitions.has(command.transitionId) ||
              ((command.transitionId === "PL-T12" || command.transitionId === "PL-T27") &&
                command.mode !== "verify")))
        ) {
          return reject(
            {
              code: "conflict",
              message:
                "This Plan is managed in Chat. Change or stop it from Chat or the Plan library.",
              retryable: false,
            },
            { readOnly: true },
          );
        }
        if (command.transitionId === "PL-T36") {
          if (planningRequests === undefined) return reject(UNAVAILABLE);
          const record = await planningRequests.read(command.requestId);
          if (
            record === undefined ||
            record.request.source.chatId !== command.sourceConversationId
          ) {
            return reject(UNAVAILABLE);
          }
          if (record.request.lifecycle !== "open") {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await chatOriginatedResult(record.request),
            });
          }
          if (record.request.proposalId !== null) {
            const proposal = await proposalRepository.read(record.request.proposalId);
            const plan = proposal === undefined ? undefined : await plans.read(proposal.planId);
            if (proposal?.status !== "proposed" || plan?.status !== "active") {
              return reject(UNAVAILABLE);
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: record.request.attention === "stale_base" ? "PL-S025" : "PL-S007",
                selectedProposalId: proposal.id,
              }),
            });
          }
          if (record.request.planConversationId !== null) {
            const conversation = await conversations.readConversation(
              record.request.planConversationId,
            );
            const current = await conversations.readLatestOpenConversation();
            if (
              conversation?.status !== "open" ||
              current?.id !== record.request.planConversationId
            ) {
              return reject(UNAVAILABLE);
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ sourceConversationId: command.sourceConversationId }),
            });
          }
          return reject(UNAVAILABLE);
        }
        if (command.transitionId === "PL-T40") {
          if (planningRequests === undefined) return reject(UNAVAILABLE);
          const record = await planningRequests.read(command.requestId);
          if (
            record === undefined ||
            record.request.lifecycle !== "open" ||
            record.request.attention !== "date_conflict" ||
            record.request.proposalId === null
          ) {
            return reject(UNAVAILABLE);
          }
          const proposal = await proposalRepository.read(record.request.proposalId);
          if (proposal?.status !== "proposed") return reject(UNAVAILABLE);
          const [plan, workouts, premises] = await Promise.all([
            plans.read(proposal.planId),
            plans.readWorkouts(proposal.planId),
            proposalRepository.readPremises(proposal.id),
          ]);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const mutation = parsePlanProposalMutation(proposal.mutationJson);
          const change = mutation.changes[0];
          if (mutation.changes.length !== 1 || change === undefined || change.before !== null) {
            return reject(UNAVAILABLE);
          }
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          let resolvedDateKey: number;
          let nextChange: PlanProposalMutation["changes"][number];
          if (command.resolution.kind === "use-date") {
            resolvedDateKey = dateKeyFromText(command.resolution.date);
            if (
              resolvedDateKey <= todayDateKey ||
              planWeekIndex(plan, resolvedDateKey).kind !== "inside" ||
              workouts.some((workout) => workout.dateKey === resolvedDateKey)
            ) {
              return reject({
                code: "conflict",
                message: "That date is no longer available. Choose another date.",
                retryable: true,
              });
            }
            nextChange = {
              ...change,
              after: { ...change.after, dateKey: resolvedDateKey },
            };
          } else {
            const replacementWorkoutId = command.resolution.workoutId;
            const existing = workouts.find((workout) => workout.id === replacementWorkoutId);
            if (
              existing === undefined ||
              existing.origin !== "coach" ||
              existing.dateKey <= todayDateKey ||
              existing.dateKey !== record.request.requestedDateKey
            ) {
              return reject({
                code: "conflict",
                message: "That Workout is protected and cannot be replaced.",
                retryable: false,
              });
            }
            resolvedDateKey = existing.dateKey;
            nextChange = {
              workoutId: existing.id,
              before: {
                dateKey: existing.dateKey,
                sport: existing.sport,
                name: existing.name,
                durationS: existing.durationS,
                structureJson: existing.structureJson,
              },
              after: { ...change.after, dateKey: existing.dateKey },
            };
          }
          const stamp = input.identity.hlcStamp();
          const timestamp = stamp.physicalMs;
          const deviceId = await input.identity.deviceId();
          const next: PlanProposalRecord = {
            ...proposal,
            id: input.identity.newUlid(),
            parentProposalId: proposal.id,
            revision: proposal.revision + 1,
            mutationJson: encodePlanProposalMutation({
              schemaVersion: 1,
              changes: [nextChange],
              weekLoad: mutation.weekLoad,
            }),
            baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(plan, workouts)),
            createdAtMs: timestamp,
            updatedAtMs: timestamp,
            deviceId,
            hlcPhysicalMs: stamp.physicalMs,
            hlcCounter: stamp.counter,
          };
          const nextPremises = premises.map((premise) => ({
            ...premise,
            id: input.identity.newUlid(),
            proposalId: next.id,
            createdAtMs: timestamp,
            deviceId,
            hlcPhysicalMs: stamp.physicalMs,
            hlcCounter: stamp.counter,
          }));
          try {
            validatePlanProposal({
              proposal: next,
              premises: nextPremises,
              plan,
              workouts,
              todayDateKey,
              calculateWeekLoad: dependencies.proposalLoadCalculator,
            });
            await proposalRepository.save(next, nextPremises, {
              requestId: record.request.requestId,
              expectedRevision: record.request.revision,
              previousProposalId: proposal.id,
              proposalId: next.id,
              attention: "needs_review",
              resolvedDateKey,
              updatedAtMs: timestamp,
              deviceId,
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
          } catch {
            return reject({
              code: "conflict",
              message: "The Plan changed while checking that date. Review the latest options.",
              retryable: true,
            });
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({ activeScenario: "PL-S007", selectedProposalId: next.id }),
          });
        }
        if (command.transitionId === "PL-T37") {
          if (planningRequests === undefined) return reject(UNAVAILABLE);
          const record = await planningRequests.read(command.requestId);
          if (
            record === undefined ||
            record.request.lifecycle === "open" ||
            !record.request.source.available ||
            record.request.source.chatId !== command.sourceConversationId
          ) {
            return reject(UNAVAILABLE);
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await chatOriginatedResult(record.request),
          });
        }
        if (command.transitionId === "PL-T02") {
          if (dependencies.course === undefined) return reject(UNAVAILABLE);
          const conversation = await conversations.readConversation(command.conversationId);
          if (conversation === undefined || conversation.status !== "open") {
            return reject(UNAVAILABLE);
          }
          const draft = await conversations.readLatestDraftRevision(conversation.id);
          if (draft !== undefined && draft.status !== "discarded") return reject(UNAVAILABLE);
          const accepted = courseFromJson(conversation.raceCourseJson);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          const parsed = await dependencies.course.parse(command.filePath);
          const picker = openRaceCoursePicker({
            planStatus: "draft",
            draft: null,
            acceptedCourse: accepted,
          });
          const parsing = beginRaceCourseParsing(
            picker,
            parsed.ok ? parsed.course.fileName : parsed.fileName,
          );
          if (!parsed.ok) {
            const invalid = rejectRaceCourseFile(parsing, parsed.detail);
            try {
              await saveConversationCourseFailure(conversation, {
                fileName: invalid.fileName,
                detail: invalid.detail,
              });
            } catch {
              return reject(PERSISTENCE_FAILED);
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(COURSE_INVALID, {
              courseScenario: "PL-S065",
              course: courseProjection({
                status: "invalid",
                accepted: invalid.acceptedCourse,
                fileName: invalid.fileName,
                detail: invalid.detail,
              }),
            });
          }
          let next = acceptParsedRaceCourse(parsing, parsed.course);
          if (next.kind === "course-missing-elevation" && command.elevation === "require") {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                courseScenario: "PL-S067",
                course: courseProjection({
                  status: "missing-elevation",
                  accepted: next.acceptedCourse,
                  candidate: next.candidateCourse,
                }),
              }),
            });
          }
          if (next.kind === "course-missing-elevation") next = useRouteWithoutElevation(next);
          const ready = completeRaceCourseRecalculation(next, {
            planStatus: "draft",
            recalculatedDraft: null,
          });
          try {
            await saveConversationCourse(conversation, ready.acceptedCourse);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(PERSISTENCE_FAILED);
          }
        }
        if (command.transitionId === "PL-T03") {
          const conversation = await conversations.readConversation(command.conversationId);
          if (conversation === undefined || conversation.status !== "open") {
            return reject(UNAVAILABLE);
          }
          const draft = await conversations.readLatestDraftRevision(conversation.id);
          if (draft !== undefined && draft.status !== "discarded") return reject(UNAVAILABLE);
          try {
            await saveConversationCourse(conversation, null);
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            return reject(PERSISTENCE_FAILED, {
              courseScenario: "PL-S104",
              course: courseProjection({
                status: "omission-failed",
                detail: "Couldn’t continue without a Race Course. Nothing changed.",
              }),
            });
          }
        }
        if (command.transitionId === "PL-T05") {
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "queued",
            completed: 0,
            total: 1,
          });
          try {
            await executeCoachCall(command, operationId, onEvent);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch (error) {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(error === UNAVAILABLE ? UNAVAILABLE : PROVIDER_FAILED);
          }
        }
        if (command.transitionId === "PL-T04") {
          if (dependencies.ftp === undefined) return reject(UNAVAILABLE);
          const conversation = await conversations.readConversation(command.conversationId);
          if (conversation === undefined || conversation.status !== "open")
            return reject(UNAVAILABLE);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          try {
            const ftp = await executePlanFtpTransition(dependencies.ftp, {
              source: command.source,
              watts: command.watts,
            });
            const scenario: FtpScenario =
              ftp.usedSource === null ? "PL-S058" : ftp.conflict ? "PL-S060" : "PL-S062";
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ ftpScenario: scenario }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return command.source === "manual"
              ? reject(FTP_SAVE_FAILED, { ftpScenario: "PL-S061" })
              : reject(FTP_REFRESH_FAILED, { ftpScenario: "PL-S059" });
          }
        }
        if (command.transitionId === "PL-T06" || command.transitionId === "PL-T07") {
          if (dependencies.draftBuilder === undefined) return reject(UNAVAILABLE);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          let buildProgress: PlanDraftBuildProgress = { completedWeeks: 0, totalWeeks: 1 };
          const onBuildProgress = (progress: PlanDraftBuildProgress): void => {
            buildProgress = progress;
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "running",
              completed: progress.completedWeeks,
              total: progress.totalWeeks,
            });
          };
          try {
            const selectedDraft =
              command.transitionId === "PL-T07"
                ? await conversations.readDraftRevision(command.draftId)
                : undefined;
            const conversation =
              command.transitionId === "PL-T06"
                ? await conversations.readConversation(command.conversationId)
                : selectedDraft === undefined
                  ? undefined
                  : await conversations.readConversationByPlanId(selectedDraft.planId);
            if (conversation === undefined || conversation.status !== "open")
              return reject(UNAVAILABLE);
            const turns = await conversations.readTurns(conversation.id);
            const previous = await conversations.readLatestDraftRevision(conversation.id);
            if (
              command.transitionId === "PL-T06" &&
              (conversation.courseChoiceStatus === "undecided" ||
                !(await draftReadiness({ conversation, turns, draft: previous })).ready)
            ) {
              return reject(UNAVAILABLE);
            }
            const course =
              previous === undefined
                ? courseFromJson(conversation.raceCourseJson)
                : courseFromJson(previous.raceCourseJson);
            const build =
              command.transitionId === "PL-T06"
                ? await dependencies.draftBuilder.form({
                    conversation,
                    turns,
                    previous,
                    course,
                    onProgress: onBuildProgress,
                  })
                : previous === undefined
                  ? null
                  : await dependencies.draftBuilder.revise({
                      conversation,
                      turns,
                      previous,
                      instruction: command.text,
                      course,
                      onProgress: onBuildProgress,
                    });
            if (build === null) return reject(UNAVAILABLE);
            await saveDraft(conversation, previous, build, course);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: buildProgress.totalWeeks,
              total: buildProgress.totalWeeks,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch (error) {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            const revisionRejected =
              command.transitionId === "PL-T07" &&
              error instanceof Error &&
              error.name === "CyclingPlanDraftBuildError" &&
              ((error as Error & { readonly code?: string }).code === "unsupported-revision" ||
                (error as Error & { readonly code?: string }).code === "revision-conflict");
            const invalidDraftInput =
              command.transitionId === "PL-T06" &&
              error instanceof Error &&
              error.name === "CyclingPlanDraftBuildError" &&
              (error as Error & { readonly code?: string }).code === "invalid-target-date";
            return reject(
              revisionRejected
                ? DRAFT_REVISION_INVALID
                : invalidDraftInput
                  ? DRAFT_INPUT_INVALID
                  : PERSISTENCE_FAILED,
            );
          }
        }
        if (command.transitionId === "PL-T08") {
          if (dependencies.draftBuilder?.recalculateStartDate === undefined) {
            return reject(UNAVAILABLE);
          }
          const current = await conversations.readDraftRevision(command.draftId);
          if (current === undefined || current.status !== "ready") return reject(UNAVAILABLE);
          const [latest, conversation, currentPlan] = await Promise.all([
            conversations.readLatestDraftRevision(current.conversationId),
            conversations.readConversation(current.conversationId),
            plans.read(current.planId),
          ]);
          if (
            latest?.id !== current.id ||
            conversation === undefined ||
            conversation.status !== "open" ||
            currentPlan === undefined ||
            currentPlan.status !== "draft" ||
            currentPlan.targetDateKey === null
          ) {
            return reject(UNAVAILABLE);
          }
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          let preview: PlanStartDatePreview;
          try {
            preview = previewPlanStartDate({
              planStatus: currentPlan.status,
              startDate: command.startDate,
              today: dateText(todayDateKey),
              targetDate: dateText(currentPlan.targetDateKey),
            });
          } catch {
            return reject(START_DATE_INVALID, {
              dateScenario: "PL-S046",
              startDate: startDateProjection({
                plan: currentPlan,
                todayDateKey,
                selectedDate: command.startDate,
                error: START_DATE_INVALID,
              }),
            });
          }
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          const currentWorkouts = await plans.readWorkouts(currentPlan.id);
          const turns = await conversations.readTurns(conversation.id);
          const course = courseFromJson(current.raceCourseJson);
          try {
            const build = await dependencies.draftBuilder.recalculateStartDate({
              conversation,
              turns,
              previous: current,
              preview,
              course,
            });
            if (
              build.plan.id !== currentPlan.id ||
              build.plan.status !== "draft" ||
              build.plan.targetDateKey !== preview.targetDateKey ||
              build.plan.startDateKey !== preview.startDateKey ||
              build.plan.kind !== preview.kind ||
              build.plan.totalWeeks !== preview.totalWeeks ||
              build.plan.weekStartDay !== preview.weekStartDay
            ) {
              throw new TypeError("Start-date recalculation returned an inconsistent Draft.");
            }
            await saveDraft(conversation, current, build, course);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                dateScenario: "PL-S050",
                startDate: startDateProjection({
                  plan: build.plan,
                  todayDateKey,
                  status: "updated",
                }),
              }),
            });
          } catch {
            await plans.replace(currentPlan, currentWorkouts).catch(() => undefined);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(START_DATE_RECALCULATION_FAILED, {
              dateScenario: "PL-S048",
              startDate: startDateProjection({
                plan: currentPlan,
                todayDateKey,
                selectedDate: command.startDate,
                status: "failed",
                error: START_DATE_RECALCULATION_FAILED,
              }),
            });
          }
        }
        if (command.transitionId === "PL-T09") {
          if (dependencies.draftBuilder === undefined) return reject(UNAVAILABLE);
          const current = await conversations.readDraftRevision(command.draftId);
          if (current === undefined || current.status !== "ready") return reject(UNAVAILABLE);
          const conversation = await conversations.readConversation(current.conversationId);
          const plan = await plans.read(current.planId);
          if (
            conversation === undefined ||
            conversation.status !== "open" ||
            plan === undefined ||
            plan.status !== "draft"
          ) {
            return reject(UNAVAILABLE);
          }
          const accepted = courseFromJson(current.raceCourseJson);
          const picker = openRaceCoursePicker({
            planStatus: plan.status,
            draft: current,
            acceptedCourse: accepted,
          });
          let recalculating: RaceCourseRecalculatingState<PlanDraftRevisionRecord>;
          if (command.course.action === "remove") {
            recalculating = beginRaceCourseRemoval(picker);
          } else {
            if (dependencies.course === undefined) return reject(UNAVAILABLE);
            const parsed = await dependencies.course.parse(command.course.filePath);
            const parsing = beginRaceCourseParsing(
              picker,
              parsed.ok ? parsed.course.fileName : parsed.fileName,
            );
            if (!parsed.ok) {
              const invalid = rejectRaceCourseFile(parsing, parsed.detail);
              try {
                await saveConversationCourseFailure(conversation, {
                  fileName: invalid.fileName,
                  detail: invalid.detail,
                });
              } catch {
                return reject(PERSISTENCE_FAILED);
              }
              return reject(COURSE_INVALID, {
                courseScenario: "PL-S065",
                course: courseProjection({
                  status: "invalid",
                  accepted: invalid.acceptedCourse,
                  fileName: invalid.fileName,
                  detail: invalid.detail,
                }),
              });
            }
            let next = acceptParsedRaceCourse(parsing, parsed.course);
            if (
              next.kind === "course-missing-elevation" &&
              command.course.elevation === "require"
            ) {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  courseScenario: "PL-S067",
                  course: courseProjection({
                    status: "missing-elevation",
                    accepted: next.acceptedCourse,
                    candidate: next.candidateCourse,
                  }),
                }),
              });
            }
            if (next.kind === "course-missing-elevation") next = useRouteWithoutElevation(next);
            recalculating = next;
          }
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          const turns = await conversations.readTurns(conversation.id);
          try {
            const build = await dependencies.draftBuilder.recalculateCourse({
              conversation,
              turns,
              previous: current,
              course: recalculating.candidateCourse,
            });
            const ready = completeRaceCourseRecalculation(recalculating, {
              planStatus: plan.status,
              recalculatedDraft: build,
            });
            await saveDraft(conversation, current, ready.draft, ready.acceptedCourse);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(ready.acceptedCourse === null ? {} : { courseScenario: "PL-S070" }),
            });
          } catch {
            const failed = failRaceCourseRecalculation(
              recalculating,
              COURSE_RECALCULATION_FAILED.message,
            );
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(COURSE_RECALCULATION_FAILED, {
              courseScenario: "PL-S069",
              course: courseProjection({
                status: "recalculation-failed",
                accepted: failed.acceptedCourse,
                candidate: failed.candidateCourse,
                detail: failed.detail,
              }),
            });
          }
        }
        if (command.transitionId === "PL-T10") {
          try {
            const current = await conversations.readDraftRevision(command.draftId);
            if (current === undefined) return reject(UNAVAILABLE);
            const timestamp = input.identity.hlcStamp().physicalMs;
            const stamp = input.identity.hlcStamp();
            await conversations.saveDraftRevision({
              ...current,
              status: "discarded",
              raceCourseJson: current.raceCourseJson,
              updatedAtMs: timestamp,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            return reject(PERSISTENCE_FAILED);
          }
        }
        if (command.transitionId === "PL-T11") {
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          try {
            const activation = await activatePlanDraft(
              {
                draftRevisionId: command.draftId,
                expectedRevision: command.expectedRevision,
              },
              { drafts: conversations, identity: input.identity },
            );
            const plan = await plans.read(activation.planId);
            if (plan === undefined || plan.status !== "active")
              throw new Error("Plan activation failed.");
            const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
            const stamp = input.identity.hlcStamp();
            try {
              await reconciliations.createOrGetJob({
                id: input.identity.newUlid(),
                planId: plan.id,
                kind: "mirror",
                windowStartDateKey: todayDateKey,
                windowEndDateKey: addCivilDays(todayDateKey, 6),
                createdAtMs: stamp.physicalMs,
              });
            } catch {
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: 0,
                total: 1,
              });
              return reject(CALENDAR_UPDATE_STATE_FAILED, {
                activeScenario: "PL-S039",
                reconciliationError: CALENDAR_UPDATE_STATE_FAILED,
              });
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S037" }),
            });
          } catch (error) {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(
              error instanceof PlanConversationValidationError &&
                (error.code === "stale-draft" || error.code === "plan-not-draft")
                ? DRAFT_STALE
                : PERSISTENCE_FAILED,
            );
          }
        }
        if (command.transitionId === "PL-T12") {
          if (dependencies.calendar === undefined) return reject(UNAVAILABLE);
          const plan = await plans.read(command.planId);
          if (plan === undefined || plan.status !== "active") return reject(UNAVAILABLE);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const workouts = await plans.readWorkouts(plan.id);
          const existingJob = await reconciliations.readLatestJob(plan.id, "mirror");
          const existingItems =
            existingJob === undefined ? [] : await reconciliations.readItems(existingJob.id);
          if (fenced && (existingJob === undefined || existingItems.length === 0)) {
            return reject(UNAVAILABLE);
          }
          const total = Math.max(existingItems.length, 1);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total,
          });
          try {
            const reconcilerDependencies = {
              repository: reconciliations,
              calendar: dependencies.calendar,
              identity: { newId: () => input.identity.newUlid() },
              now: () => input.identity.hlcStamp().physicalMs,
            };
            const result =
              command.mode === "verify" && existingJob !== undefined && existingItems.length > 0
                ? await verifyPlanMirror(existingJob, reconcilerDependencies)
                : await reconcileActivePlanWindow(
                    { plan, workouts, todayDateKey },
                    reconcilerDependencies,
                  );
            if (result.job.status === "failed") {
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: Math.min(result.created, Math.max(result.total, 1)),
                total: Math.max(result.total, 1),
              });
              const error =
                result.job.lastErrorCode === "calendar-verification-failed"
                  ? CALENDAR_VERIFICATION_FAILED
                  : CALENDAR_UPDATE_FAILED;
              return reject(error);
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: Math.max(result.total, 1),
              total: Math.max(result.total, 1),
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S043" }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total,
            });
            return reject(CALENDAR_UPDATE_STATE_FAILED, {
              activeScenario: "PL-S039",
              reconciliationError: CALENDAR_UPDATE_STATE_FAILED,
            });
          }
        }
        if (command.transitionId === "PL-T13") {
          const [plan, workout] = await Promise.all([
            plans.read(command.planId),
            plans
              .readWorkouts(command.planId)
              .then((workouts) => workouts.find((candidate) => candidate.id === command.workoutId)),
          ]);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          if (workout === undefined) {
            const current = await read();
            const data = PlanActiveProjectionDataSchema.safeParse(current.data);
            if (
              !data.success ||
              !data.data.workouts.some((candidate) => candidate.id === command.workoutId)
            ) {
              return reject(UNAVAILABLE);
            }
          }
          const drift =
            workout === undefined
              ? undefined
              : await workoutDrifts.readOpenForWorkout(command.workoutId);
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({
              activeScenario: drift === undefined ? "PL-S021" : "PL-S032",
              selectedWorkoutId: command.workoutId,
              selectedWorkoutSourceScenarioId: command.sourceScenarioId ?? null,
            }),
          });
        }
        if (command.transitionId === "PL-T31") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({ activeScenario: "PL-S006" }),
          });
        }
        if (command.transitionId === "PL-T32") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const workouts = await plans.readWorkouts(plan.id);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const beforeInput =
            dependencies.readiness === undefined
              ? unavailableReadinessInput(plan, todayDateKey)
              : await dependencies.readiness
                  .read({ plan, workouts, todayDateKey })
                  .catch(() => unavailableReadinessInput(plan, todayDateKey));
          const before = projectPlanReadiness(beforeInput);
          if (command.mode !== "refresh") {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: before.scenarioId,
                readiness: before.projection,
              }),
            });
          }
          if (dependencies.readiness === undefined) {
            return reject(READINESS_REFRESH_FAILED, {
              activeScenario: "PL-S076",
              readiness: failedPlanReadiness(before.projection),
            });
          }
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          try {
            await dependencies.readiness.refresh();
            const refreshedInput = await dependencies.readiness.read({
              plan,
              workouts,
              todayDateKey,
            });
            const refreshed = projectPlanReadiness(refreshedInput);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: refreshed.scenarioId,
                readiness: refreshed.projection,
              }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(READINESS_REFRESH_FAILED, {
              activeScenario: "PL-S076",
              readiness: failedPlanReadiness(before.projection),
            });
          }
        }
        if (command.transitionId === "PL-T14") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const candidate = (await workoutMatches.readForWorkout(command.workoutId)).find(
            (match) => match.activityId === command.activityId && match.decision === "suggested",
          );
          if (candidate === undefined) return reject(UNAVAILABLE);
          try {
            const stamp = input.identity.hlcStamp();
            await commandAuthority.run({ store, enforce: false }, async () => {
              await workoutMatches.decide({
                id: candidate.id,
                decision: command.decision === "reject" ? "rejected" : "confirmed",
                decidedAtMs: stamp.physicalMs,
                deviceId: await input.identity.deviceId(),
                hlcPhysicalMs: stamp.physicalMs,
                hlcCounter: stamp.counter,
              });
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S004", selectedWorkoutId: null }),
            });
          } catch {
            return reject(PERSISTENCE_FAILED, {
              activeScenario: "PL-S021",
              selectedWorkoutId: command.workoutId,
            });
          }
        }
        if (command.transitionId === "PL-T15" || command.transitionId === "PL-T16") {
          const eventId = Number(command.eventId);
          if (
            dependencies.workoutDriftCalendar === undefined ||
            !Number.isSafeInteger(eventId) ||
            eventId <= 0
          )
            return reject(UNAVAILABLE);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const driftDependencies = {
            repository: workoutDrifts,
            plans,
            calendar: dependencies.workoutDriftCalendar,
            identity: {
              newId: () => input.identity.newUlid(),
              deviceId: () => input.identity.deviceId(),
              stamp: () => input.identity.hlcStamp(),
            },
            now: () => input.identity.hlcStamp().physicalMs,
          };
          try {
            if (command.transitionId === "PL-T15") {
              await adoptProviderWorkoutEdit(
                {
                  planId: command.planId,
                  workoutId: command.workoutId,
                  eventId,
                  todayDateKey,
                },
                driftDependencies,
              );
            } else {
              await restorePlanWorkout(
                {
                  planId: command.planId,
                  workoutId: command.workoutId,
                  eventId,
                  todayDateKey,
                },
                driftDependencies,
              );
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: command.transitionId === "PL-T15" ? "PL-S034" : "PL-S036",
                selectedWorkoutId: command.workoutId,
              }),
            });
          } catch (error) {
            const driftError =
              error instanceof PlanWorkoutDriftError && error.code === "invalid-provider-event"
                ? WORKOUT_DRIFT_CHANGED
                : WORKOUT_DRIFT_PROVIDER_FAILED;
            return reject(driftError, {
              activeScenario: "PL-S032",
              selectedWorkoutId: command.workoutId,
              driftError,
            });
          }
        }
        if (command.transitionId === "PL-T17") {
          if (
            command.selectedProposalReturn !== undefined &&
            !isSafeProposalReturn(command.selectedProposalReturn)
          ) {
            return reject(UNAVAILABLE);
          }
          const [proposal, plan] = await Promise.all([
            proposalRepository.read(command.proposalId),
            plans.read(command.planId),
          ]);
          if (
            proposal?.status !== "proposed" ||
            plan?.status !== "active" ||
            proposal.planId !== plan.id
          ) {
            return reject(UNAVAILABLE);
          }
          const [workouts, premises, settings] = await Promise.all([
            plans.readWorkouts(plan.id),
            proposalRepository.readPremises(proposal.id),
            settingsRepository.read(plan.id),
          ]);
          if (settings === undefined) return reject(UNAVAILABLE);
          try {
            const validated = validatePlanProposal({
              proposal,
              premises,
              plan,
              workouts,
              todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
              calculateWeekLoad: dependencies.proposalLoadCalculator,
            });
            const change = validated.changes[0];
            const refusal =
              change === undefined
                ? null
                : cyclingTaperRefusal({
                    planStructureJson: plan.structureJson,
                    planStartDate: dateText(plan.startDateKey),
                    planTotalWeeks: plan.totalWeeks,
                    workoutDate: dateText(change.next.dateKey),
                    current: {
                      name: change.current?.name ?? "No Workout",
                      durationS: change.current?.durationS ?? 0,
                    },
                    next: {
                      name: change.next.name,
                      durationS: change.next.durationS,
                      structureJson: change.next.structureJson,
                    },
                  });
            if (refusal !== null) {
              await refuseProposal(
                proposal,
                "Adding missed work during taper would reduce freshness before the race.",
              );
              const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
              const readinessInput =
                dependencies.readiness === undefined
                  ? unavailableReadinessInput(plan, todayDateKey)
                  : await dependencies.readiness
                      .read({ plan, workouts, todayDateKey })
                      .catch(() => unavailableReadinessInput(plan, todayDateKey));
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S078",
                  readiness: taperRefusalReadiness(
                    projectPlanReadiness(readinessInput).projection,
                    refusal,
                  ),
                  returnFocusId: "plan-readiness-trigger",
                }),
              });
            }
            const autoApply = validatePlanAutoApply({
              enabled: settings.autoApply,
              plan,
              proposal: validated,
            });
            if (
              autoApply.status === "eligible" &&
              dependencies.proposalPremiseReader !== undefined
            ) {
              const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
              const ledgerId = input.identity.newUlid();
              try {
                await revalidatePlanProposalPremises(premises, dependencies.proposalPremiseReader);
                const current = validatePlanProposal({
                  proposal,
                  premises,
                  plan,
                  workouts,
                  todayDateKey,
                  calculateWeekLoad: dependencies.proposalLoadCalculator,
                });
                const currentEligibility = validatePlanAutoApply({
                  enabled: settings.autoApply,
                  plan,
                  proposal: current,
                });
                if (currentEligibility.status !== "eligible") {
                  throw new PlanProposalError("stale-base");
                }
                const stamp = input.identity.hlcStamp();
                const linkedRequest = await planningRequests?.readByProposalId(proposal.id);
                const requestWorkout =
                  linkedRequest === undefined ? null : planningRequestWorkout(linkedRequest);
                const appliedDateKey =
                  linkedRequest?.request.resolvedDateKey ??
                  current.changes[0]?.next.dateKey ??
                  null;
                await applyValidatedPlanProposal(current, {
                  repository: proposalRepository,
                  plan,
                  ledgerId,
                  resolvedAtMs: stamp.physicalMs,
                  deviceId: await input.identity.deviceId(),
                  hlcPhysicalMs: stamp.physicalMs,
                  hlcCounter: stamp.counter,
                  ...(linkedRequest === undefined
                    ? {}
                    : {
                        requestCompletion: {
                          requestId: linkedRequest.request.requestId,
                          expectedRevision: linkedRequest.request.revision,
                          expectedProposalId: proposal.id,
                          result: {
                            kind: "applied" as const,
                            resultId: input.identity.newUlid(),
                            completedAtMs: stamp.physicalMs,
                            title: "Added to Plan",
                            detail:
                              appliedDateKey === null
                                ? `${requestWorkout!.name} was added to the active Plan.`
                                : `${requestWorkout!.name} is scheduled for ${dateText(appliedDateKey)}.`,
                            workoutRef: requestWorkout!.workoutRef,
                            planRevisionId: ledgerId,
                          },
                          resolvedDateKey: appliedDateKey,
                          updatedAtMs: stamp.physicalMs,
                          deviceId: await input.identity.deviceId(),
                          hlcPhysicalMs: stamp.physicalMs,
                          hlcCounter: stamp.counter,
                        },
                      }),
                  mirrorJob: {
                    id: input.identity.newUlid(),
                    windowStartDateKey: todayDateKey,
                    windowEndDateKey: addCivilDays(todayDateKey, 6),
                    createdAtMs: stamp.physicalMs,
                  },
                });
              } catch (error) {
                if (isProposalStale(error)) {
                  const projected = proposalProjection({
                    proposal,
                    premises,
                    mutation: validated.mutation,
                    stale: true,
                    error: PROPOSAL_STALE,
                  });
                  return ExecutePlanTransitionRpcResultSchema.parse({
                    status: "completed",
                    state: await read({
                      activeScenario: "PL-S025",
                      selectedProposalId: proposal.id,
                      selectedProposalReturn: command.selectedProposalReturn,
                      proposalOverride: projected,
                    }),
                  });
                }
                return reject(PERSISTENCE_FAILED, {
                  activeScenario: "PL-S007",
                  selectedProposalId: proposal.id,
                  selectedProposalReturn: command.selectedProposalReturn,
                });
              }
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({ activeScenario: "PL-S101", selectedHistoryId: ledgerId }),
              });
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
                proposalOverride: proposalProjection({
                  proposal,
                  premises,
                  mutation: validated.mutation,
                  stale: false,
                }),
              }),
            });
          } catch (error) {
            if (!(error instanceof PlanProposalError)) throw error;
            if (error.code === "missing-capability") {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S007",
                  selectedProposalId: proposal.id,
                  selectedProposalReturn: command.selectedProposalReturn,
                  proposalOverride: proposalProjection({
                    proposal,
                    premises,
                    mutation: parsePlanProposalMutation(proposal.mutationJson),
                    stale: false,
                    error: UNAVAILABLE,
                  }),
                }),
              });
            }
            if (error.code === "stale-base") {
              const projected = proposalProjection({
                proposal,
                premises,
                mutation: parsePlanProposalMutation(proposal.mutationJson),
                stale: true,
                error: PROPOSAL_STALE,
              });
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S025",
                  selectedProposalId: proposal.id,
                  selectedProposalReturn: command.selectedProposalReturn,
                  proposalOverride: projected,
                }),
              });
            }
            await refuseProposal(proposal);
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S097",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
              }),
            });
          }
        }
        if (command.transitionId === "PL-T18") {
          if (
            command.selectedProposalReturn !== undefined &&
            !isSafeProposalReturn(command.selectedProposalReturn)
          ) {
            return reject(UNAVAILABLE);
          }
          if (dependencies.proposalReviser === undefined) return reject(UNAVAILABLE);
          const proposal = await proposalRepository.read(command.proposalId);
          if (proposal?.status !== "proposed") return reject(UNAVAILABLE);
          const mutation = await parseProposalMutationOrRefuse(proposal);
          if (mutation === null) {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S097",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
              }),
            });
          }
          if (mutation.weekLoad !== null && dependencies.proposalLoadCalculator === undefined) {
            return reject(UNAVAILABLE);
          }
          const [plan, workouts, premises] = await Promise.all([
            plans.read(proposal.planId),
            plans.readWorkouts(proposal.planId),
            proposalRepository.readPremises(proposal.id),
          ]);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          try {
            const revised = await saveProposalRevision({
              current: proposal,
              premises,
              plan,
              workouts,
              instruction: command.text,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S023",
                selectedProposalId: revised.id,
                selectedProposalReturn: command.selectedProposalReturn,
                proposalRevisionText: command.text,
              }),
            });
          } catch (error) {
            if (error instanceof PlanProposalError && error.code === "missing-capability") {
              return reject(UNAVAILABLE, {
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
              });
            }
            return reject(PERSISTENCE_FAILED, {
              activeScenario: "PL-S022",
              selectedProposalId: proposal.id,
              selectedProposalReturn: command.selectedProposalReturn,
              proposalRevisionText: command.text,
            });
          }
        }
        if (command.transitionId === "PL-T19") {
          if (
            command.selectedProposalReturn !== undefined &&
            !isSafeProposalReturn(command.selectedProposalReturn)
          ) {
            return reject(UNAVAILABLE);
          }
          const proposal = await proposalRepository.read(command.proposalId);
          if (proposal?.status !== "proposed") {
            return reject(PROPOSAL_STALE);
          }
          if (proposal.revision !== command.expectedRevision) {
            return reject(PROPOSAL_STALE, {
              activeScenario: "PL-S025",
              selectedProposalId: proposal.id,
              selectedProposalReturn: command.selectedProposalReturn,
            });
          }
          const mutation = await parseProposalMutationOrRefuse(proposal);
          if (mutation === null) {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S097",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
              }),
            });
          }
          const [plan, workouts, premises] = await Promise.all([
            plans.read(proposal.planId),
            plans.readWorkouts(proposal.planId),
            proposalRepository.readPremises(proposal.id),
          ]);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const premiseReader = dependencies.proposalPremiseReader;
          if (premiseReader === undefined) return reject(UNAVAILABLE);
          if (mutation.weekLoad !== null && dependencies.proposalLoadCalculator === undefined) {
            return reject(UNAVAILABLE);
          }
          let linkedRequest = await planningRequests?.readByProposalId(proposal.id);
          if (linkedRequest !== undefined) {
            try {
              linkedRequest = await revisePlanningRequestAttention(linkedRequest, "revalidating");
            } catch {
              return reject(PERSISTENCE_FAILED, {
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
              });
            }
          }
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          const ledgerId = input.identity.newUlid();
          let validationCompleted = false;
          try {
            await revalidatePlanProposalPremises(premises, premiseReader);
            const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
            const validated = validatePlanProposal({
              proposal,
              premises,
              plan,
              workouts,
              todayDateKey,
              calculateWeekLoad: dependencies.proposalLoadCalculator,
            });
            validationCompleted = true;
            const stamp = input.identity.hlcStamp();
            const requestWorkout =
              linkedRequest === undefined ? null : planningRequestWorkout(linkedRequest);
            const appliedDateKey =
              linkedRequest?.request.resolvedDateKey ?? validated.changes[0]?.next.dateKey ?? null;
            await applyValidatedPlanProposal(validated, {
              repository: proposalRepository,
              plan,
              ledgerId,
              resolvedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
              ...(linkedRequest === undefined
                ? {}
                : {
                    requestCompletion: {
                      requestId: linkedRequest.request.requestId,
                      expectedRevision: linkedRequest.request.revision,
                      expectedProposalId: proposal.id,
                      result: {
                        kind: "applied" as const,
                        resultId: input.identity.newUlid(),
                        completedAtMs: stamp.physicalMs,
                        title: "Added to Plan",
                        detail:
                          appliedDateKey === null
                            ? `${requestWorkout!.name} was added to the active Plan.`
                            : `${requestWorkout!.name} is scheduled for ${dateText(appliedDateKey)}.`,
                        workoutRef: requestWorkout!.workoutRef,
                        planRevisionId: ledgerId,
                      },
                      resolvedDateKey: appliedDateKey,
                      updatedAtMs: stamp.physicalMs,
                      deviceId: await input.identity.deviceId(),
                      hlcPhysicalMs: stamp.physicalMs,
                      hlcCounter: stamp.counter,
                    },
                  }),
              mirrorJob: {
                id: input.identity.newUlid(),
                windowStartDateKey: todayDateKey,
                windowEndDateKey: addCivilDays(todayDateKey, 6),
                createdAtMs: stamp.physicalMs,
              },
            });
          } catch (error) {
            if (error instanceof PlanProposalError && error.code === "missing-capability") {
              if (linkedRequest !== undefined) {
                await revisePlanningRequestAttention(linkedRequest, "needs_review").catch(
                  () => undefined,
                );
              }
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: 0,
                total: 1,
              });
              return reject(UNAVAILABLE, {
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
              });
            }
            if (isProposalStale(error)) {
              let current = proposal;
              if (dependencies.proposalReviser !== undefined) {
                try {
                  const latestPlan = await plans.read(proposal.planId);
                  if (latestPlan?.status !== "active") throw new Error("Plan is not active.");
                  const [latestWorkouts, refreshedPremises] = await Promise.all([
                    plans.readWorkouts(proposal.planId),
                    Promise.all(
                      premises.map(async (premise) => {
                        const snapshotJson = await premiseReader.read({
                          sourceType: premise.sourceType,
                          sourceId: premise.sourceId,
                        });
                        if (snapshotJson === null) throw new Error("Proposal premise is missing.");
                        return Object.freeze({ ...premise, snapshotJson });
                      }),
                    ),
                  ]);
                  current = await saveProposalRevision({
                    current: proposal,
                    premises: refreshedPremises,
                    plan: latestPlan,
                    workouts: latestWorkouts,
                    instruction:
                      "Revalidate this Proposal against the current Plan and source data without changing the athlete's intent.",
                    requestAttention: "stale_base",
                  });
                } catch {
                  current = proposal;
                }
              }
              if (linkedRequest !== undefined && current.id === proposal.id) {
                linkedRequest = await revisePlanningRequestAttention(
                  linkedRequest,
                  "stale_base",
                ).catch(() => linkedRequest);
              }
              const currentPremises = await proposalRepository.readPremises(current.id);
              const projected = proposalProjection({
                proposal: current,
                premises: currentPremises,
                mutation: parsePlanProposalMutation(current.mutationJson),
                stale: current.id === proposal.id,
                error: current.id === proposal.id ? PROPOSAL_STALE : null,
              });
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "completed",
                completed: 1,
                total: 1,
              });
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S025",
                  selectedProposalId: current.id,
                  selectedProposalReturn: command.selectedProposalReturn,
                  proposalOverride: projected,
                }),
              });
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            if (!validationCompleted) {
              if (linkedRequest !== undefined) {
                await revisePlanningRequestAttention(linkedRequest, "needs_review").catch(
                  () => undefined,
                );
              }
              return reject(PROPOSAL_INVALID, {
                activeScenario: "PL-S007",
                selectedProposalId: proposal.id,
                selectedProposalReturn: command.selectedProposalReturn,
              });
            }
            if (linkedRequest !== undefined) {
              await revisePlanningRequestAttention(linkedRequest, "apply_failed").catch(
                () => undefined,
              );
            }
            return reject(PERSISTENCE_FAILED, {
              activeScenario: "PL-S007",
              selectedProposalId: proposal.id,
              selectedProposalReturn: command.selectedProposalReturn,
            });
          }
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "completed",
            completed: 1,
            total: 1,
          });
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({
              activeScenario: "PL-S008",
              selectedProposalReturn: command.selectedProposalReturn,
              selectedHistoryId: ledgerId,
            }),
          });
        }
        if (command.transitionId === "PL-T20") {
          if (
            command.selectedProposalReturn !== undefined &&
            !isSafeProposalReturn(command.selectedProposalReturn)
          ) {
            return reject(UNAVAILABLE);
          }
          const proposal = await proposalRepository.read(command.proposalId);
          if (proposal?.status !== "proposed") return reject(UNAVAILABLE);
          const stamp = input.identity.hlcStamp();
          const linkedRequest = await planningRequests?.readByProposalId(proposal.id);
          const requestWorkout =
            linkedRequest === undefined ? null : planningRequestWorkout(linkedRequest);
          await proposalRepository.resolve({
            id: proposal.id,
            status: "rejected",
            resolvedAtMs: stamp.physicalMs,
            deviceId: await input.identity.deviceId(),
            hlcPhysicalMs: stamp.physicalMs,
            hlcCounter: stamp.counter,
            ...(linkedRequest === undefined
              ? {}
              : {
                  requestCompletion: {
                    requestId: linkedRequest.request.requestId,
                    expectedRevision: linkedRequest.request.revision,
                    expectedProposalId: proposal.id,
                    result: {
                      kind: "rejected" as const,
                      resultId: input.identity.newUlid(),
                      completedAtMs: stamp.physicalMs,
                      title: "Proposal rejected",
                      detail: `${requestWorkout!.name} was not applied; the active Plan remains unchanged.`,
                      workoutRef: requestWorkout!.workoutRef,
                      planRevisionId: null,
                    },
                    resolvedDateKey: linkedRequest.request.resolvedDateKey,
                    updatedAtMs: stamp.physicalMs,
                    deviceId: await input.identity.deviceId(),
                    hlcPhysicalMs: stamp.physicalMs,
                    hlcCounter: stamp.counter,
                  },
                }),
          });
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({
              activeScenario: "PL-S097",
              selectedProposalId: proposal.id,
              selectedProposalReturn: command.selectedProposalReturn,
            }),
          });
        }
        if (command.transitionId === "PL-T21") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const [workouts, historyRows] = await Promise.all([
            plans.readWorkouts(plan.id),
            historyRepository.readForPlan(plan.id),
          ]);
          const stamp = input.identity.hlcStamp();
          const deviceId = await input.identity.deviceId();
          let validated: ReturnType<typeof validatePlanUndo>;
          try {
            validated = validatePlanUndo({
              ledgerId: command.ledgerId,
              plan,
              workouts,
              history: historyRows,
              todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
              deviceId,
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
          } catch (error) {
            if (error instanceof PlanUndoError && error.code === "unavailable") {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S026",
                  selectedHistoryId: command.ledgerId,
                }),
              });
            }
            throw error;
          }
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const undoId = input.identity.newUlid();
          try {
            await applyValidatedPlanUndo(validated, {
              repository: historyRepository,
              plan,
              undoId,
              occurredAtMs: stamp.physicalMs,
              deviceId,
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
              mirrorJob: {
                id: input.identity.newUlid(),
                windowStartDateKey: todayDateKey,
                windowEndDateKey: addCivilDays(todayDateKey, 6),
                createdAtMs: stamp.physicalMs,
              },
            });
          } catch (error) {
            return reject(
              error instanceof PlanAdaptationLedgerValidationError && error.code === "stale-base"
                ? UNDO_STALE
                : PERSISTENCE_FAILED,
              { activeScenario: "PL-S005", selectedHistoryId: command.ledgerId },
            );
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({ activeScenario: "PL-S027", selectedHistoryId: undoId }),
          });
        }
        if (command.transitionId === "PL-T22") {
          const [plan, current] = await Promise.all([
            plans.read(command.planId),
            settingsRepository.read(command.planId),
          ]);
          if (plan?.status !== "active" || current === undefined) return reject(UNAVAILABLE);
          const stamp = input.identity.hlcStamp();
          try {
            await settingsRepository.save({
              planId: plan.id,
              setting: command.setting,
              value: command.value,
              expectedUpdatedAtMs: current.updatedAtMs,
              expectedHlcPhysicalMs: current.hlcPhysicalMs,
              expectedHlcCounter: current.hlcCounter,
              updatedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
          } catch {
            return reject(PERSISTENCE_FAILED, {
              activeScenario: "PL-S093",
              selectedSetting: command.setting,
              settingsError: PERSISTENCE_FAILED,
            });
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({
              activeScenario: "PL-S092",
              selectedSetting: command.setting,
            }),
          });
        }
        if (command.transitionId === "PL-T23") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({ activeScenario: "PL-S051" }),
          });
        }
        if (command.transitionId === "PL-T24") {
          if (dependencies.calendar === undefined) return reject(UNAVAILABLE);
          const plan = await plans.read(command.planId);
          if (plan === undefined || (plan.status !== "active" && plan.status !== "ended")) {
            return reject(UNAVAILABLE);
          }
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const existingJob = await reconciliations.readLatestJob(plan.id, "cleanup");
          const windowStartDateKey =
            existingJob?.windowStartDateKey ?? addCivilDays(todayDateKey, 1);
          const planEndDateKey = addCivilDays(plan.startDateKey, plan.totalWeeks * 7 - 1);
          const windowEndDateKey =
            existingJob?.windowEndDateKey ?? Math.max(windowStartDateKey, planEndDateKey);
          const operationId = input.identity.newUlid();
          const existingItems =
            existingJob === undefined ? [] : await reconciliations.readItems(existingJob.id);
          const total = Math.max(existingItems.length, 1);
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total,
          });
          try {
            const stamp = input.identity.hlcStamp();
            await plans.endActive({
              planId: plan.id,
              cleanupJobId: input.identity.newUlid(),
              windowStartDateKey,
              windowEndDateKey,
              updatedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            const job = await reconciliations.readLatestJob(plan.id, "cleanup");
            if (job === undefined) throw new Error("Cleanup job was not created.");
            const reconcilerDependencies = {
              repository: reconciliations,
              calendar: dependencies.calendar,
              identity: { newId: () => input.identity.newUlid() },
              now: () => input.identity.hlcStamp().physicalMs,
            };
            const result =
              command.mode === "verify"
                ? await verifyPlanCleanup(job, reconcilerDependencies)
                : await cleanupPlanMirror(
                    {
                      planId: plan.id,
                      todayDateKey,
                      startDateKey: job.windowStartDateKey,
                      endDateKey: job.windowEndDateKey,
                    },
                    reconcilerDependencies,
                  );
            if (result.job.status === "failed") {
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: Math.min(result.created, Math.max(result.total, 1)),
                total: Math.max(result.total, 1),
              });
              return reject(
                result.job.lastErrorCode === "calendar-verification-failed"
                  ? CALENDAR_CLEANUP_VERIFICATION_FAILED
                  : CALENDAR_CLEANUP_FAILED,
                { endedScenario: "PL-S053" },
              );
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: Math.max(result.total, 1),
              total: Math.max(result.total, 1),
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ endedScenario: "PL-S056" }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total,
            });
            const stored = await plans.read(plan.id);
            return reject(
              stored?.status === "ended" ? CALENDAR_CLEANUP_FAILED : PERSISTENCE_FAILED,
              stored?.status === "ended" ? { endedScenario: "PL-S053" as const } : {},
            );
          }
        }
        if (command.transitionId === "PL-T26") {
          const draft = await conversations.readDraftRevision(command.draftId);
          if (draft === undefined || draft.revision !== command.expectedRevision) {
            return reject(DRAFT_STALE);
          }
          if (draft.status === "approved") {
            const [lineage, replacementPlan] = await Promise.all([
              replacementRepository.readByReplacementPlanId(draft.planId),
              plans.read(draft.planId),
            ]);
            if (
              lineage?.previousPlanId !== command.activePlanId ||
              lineage.draftRevisionId !== draft.id ||
              replacementPlan?.status !== "active"
            ) {
              return reject(DRAFT_STALE);
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S082" }),
            });
          }
          const activePlan = await plans.read(command.activePlanId);
          if (activePlan?.status !== "active") return reject(UNAVAILABLE);
          const conversation = await conversations.readConversation(draft.conversationId);
          if (
            conversation?.status !== "open" ||
            conversation.replacesPlanId !== activePlan.id ||
            conversation.planId !== draft.planId ||
            draft.status !== "ready"
          ) {
            return reject(DRAFT_STALE);
          }
          if (command.confirm !== true) {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ replacementConfirmation: true }),
            });
          }
          const replacementPlan = await plans.read(draft.planId);
          if (replacementPlan?.status !== "draft") return reject(DRAFT_STALE);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          const windowStartDateKey = addCivilDays(todayDateKey, 1);
          const oldPlanEndDateKey = addCivilDays(
            activePlan.startDateKey,
            activePlan.totalWeeks * 7 - 1,
          );
          const windowEndDateKey = Math.max(windowStartDateKey, oldPlanEndDateKey);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          try {
            await approvePlanReplacement(
              {
                replacementId: input.identity.newUlid(),
                previousPlanId: activePlan.id,
                replacementPlanId: replacementPlan.id,
                draftRevisionId: draft.id,
                expectedRevision: command.expectedRevision,
                cleanupJobId: input.identity.newUlid(),
                windowStartDateKey,
                windowEndDateKey,
              },
              { replacements: replacementRepository, identity: input.identity },
            );
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S082" }),
            });
          } catch (error) {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(
              error instanceof PlanReplacementValidationError &&
                (error.code === "stale-draft" || error.code === "replacement-not-draft")
                ? DRAFT_STALE
                : PERSISTENCE_FAILED,
            );
          }
        }
        if (command.transitionId === "PL-T27") {
          if (dependencies.calendar === undefined) return reject(UNAVAILABLE);
          const replacementPlan = await plans.read(command.replacementPlanId);
          const lineage = await replacementRepository.readByReplacementPlanId(
            command.replacementPlanId,
          );
          if (
            replacementPlan?.status !== "active" ||
            lineage === undefined ||
            lineage.previousPlanId !== command.planId
          ) {
            return reject(UNAVAILABLE);
          }
          const job = await reconciliations.readJob(lineage.cleanupJobId);
          if (job === undefined || job.planId !== command.planId || job.kind !== "cleanup") {
            return reject(PERSISTENCE_FAILED);
          }
          const existingItems = await reconciliations.readItems(job.id);
          const total = Math.max(existingItems.length, 1);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total,
          });
          try {
            const reconcilerDependencies = {
              repository: reconciliations,
              calendar: dependencies.calendar,
              identity: { newId: () => input.identity.newUlid() },
              now: () => input.identity.hlcStamp().physicalMs,
            };
            const result =
              command.mode === "verify"
                ? await verifyPlanCleanup(job, reconcilerDependencies)
                : await cleanupPlanMirror(
                    {
                      planId: command.planId,
                      todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
                      startDateKey: job.windowStartDateKey,
                      endDateKey: job.windowEndDateKey,
                    },
                    reconcilerDependencies,
                  );
            if (result.job.status === "failed") {
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: Math.min(result.created, Math.max(result.total, 1)),
                total: Math.max(result.total, 1),
              });
              return reject(CALENDAR_CLEANUP_FAILED, { activeScenario: "PL-S083" });
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: Math.max(result.total, 1),
              total: Math.max(result.total, 1),
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S085" }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total,
            });
            return reject(CALENDAR_CLEANUP_FAILED, { activeScenario: "PL-S083" });
          }
        }
        if (command.transitionId === "PL-T28") {
          if (dependencies.calendar === undefined) return reject(UNAVAILABLE);
          const plan = await plans.read(command.planId);
          const lineage = await replacementRepository.readByReplacementPlanId(command.planId);
          if (plan?.status !== "active" || lineage === undefined) return reject(UNAVAILABLE);
          const cleanupJob = await reconciliations.readJob(lineage.cleanupJobId);
          if (cleanupJob?.status !== "verified") {
            return reject(UNAVAILABLE, {
              activeScenario: cleanupJob?.status === "failed" ? "PL-S083" : "PL-S082",
            });
          }
          const workouts = await plans.readWorkouts(plan.id);
          const mirrorJob = await reconciliations.readLatestJob(plan.id, "mirror");
          const existingItems =
            mirrorJob === undefined ? [] : await reconciliations.readItems(mirrorJob.id);
          const total = Math.max(existingItems.length, 1);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total,
          });
          try {
            const result = await reconcileActivePlanWindow(
              {
                plan,
                workouts,
                todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
              },
              {
                repository: reconciliations,
                calendar: dependencies.calendar,
                identity: { newId: () => input.identity.newUlid() },
                now: () => input.identity.hlcStamp().physicalMs,
              },
            );
            if (result.job.status === "failed") {
              deliver(onEvent, {
                commandId: command.commandId,
                transitionId: command.transitionId,
                operationId,
                phase: "failed",
                completed: Math.min(result.created, Math.max(result.total, 1)),
                total: Math.max(result.total, 1),
              });
              return reject(CALENDAR_UPDATE_FAILED, {
                activeScenario: result.job.failureCount > 1 ? "PL-S041" : "PL-S039",
              });
            }
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: Math.max(result.total, 1),
              total: Math.max(result.total, 1),
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S087" }),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total,
            });
            return reject(CALENDAR_UPDATE_FAILED, { activeScenario: "PL-S039" });
          }
        }
        if (command.transitionId === "PL-T29") {
          const plan = await plans.read(command.planId);
          if (plan?.status === "ended") {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          }
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const asOfDateKey = dateKeyFromText(command.asOf);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          if (asOfDateKey !== todayDateKey || !naturalPlanCompletionDue(plan, asOfDateKey)) {
            return reject(UNAVAILABLE);
          }
          const windowStartDateKey = addCivilDays(asOfDateKey, 1);
          const windowEndDateKey = Math.max(windowStartDateKey, planFinalCivilDateKey(plan));
          const stamp = input.identity.hlcStamp();
          try {
            await plans.endActive({
              planId: plan.id,
              cleanupJobId: input.identity.newUlid(),
              windowStartDateKey,
              windowEndDateKey,
              updatedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ endedScenario: "PL-S094" }),
            });
          } catch {
            return reject(PERSISTENCE_FAILED);
          }
        }
        if (command.transitionId === "PL-T30") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "ended") return reject(UNAVAILABLE);
          const [sync, stored] = await Promise.all([
            workoutMatches.readSyncStatus(),
            raceOutcomeRepository.read(plan.id),
          ]);
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          if (
            stored === undefined &&
            !raceOutcomeDue({
              plan,
              todayDateKey,
              awaitingSync: sync.awaitingSync,
              outcome: stored,
            })
          ) {
            return reject(UNAVAILABLE);
          }
          if (stored !== undefined && stored.outcome !== command.outcome) {
            return reject(RACE_OUTCOME_CONFLICT);
          }
          const stamp = input.identity.hlcStamp();
          try {
            await raceOutcomeRepository.record({
              planId: plan.id,
              outcome: command.outcome,
              recordedAtMs: stamp.physicalMs,
              updatedAtMs: stamp.physicalMs,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            return reject(PERSISTENCE_FAILED, { endedScenario: "PL-S095" });
          }
        }
        if (command.transitionId === "PL-T35") {
          const plan = await plans.read(command.planId);
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          const settings = await settingsRepository.read(plan.id);
          const sync = await workoutMatches.readSyncStatus();
          const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
          if (
            settings?.weeklyReview !== true ||
            sync.awaitingSync ||
            sync.lastSuccessfulSyncAtMs === null
          ) {
            return reject(UNAVAILABLE);
          }
          const window = selectWeeklyReviewWindow({
            todayDateKey,
            planStartDateKey: plan.startDateKey,
            targetDateKey: plan.targetDateKey,
            lastSuccessfulSyncDateKey: utcDateKeyFromEpochMs(sync.lastSuccessfulSyncAtMs),
            enabled: true,
          });
          if (window === null || dateText(window.weekStartDateKey) !== command.weekStart) {
            return reject(UNAVAILABLE);
          }
          const stored = await weeklyReviewRepository.readForWeek(plan.id, window.weekStartDateKey);
          if (stored?.status === "delivered") {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S100",
                weeklyReview: deliveredWeeklyReviewProjection(stored),
              }),
            });
          }
          const workouts = await plans.readWorkouts(plan.id);
          const refreshed = await refreshPlanWorkoutMatches({
            planId: plan.id,
            workouts,
            startDateKey: window.weekStartDateKey,
            endDateKey: window.weekEndDateKey,
            repository: workoutMatches,
            identity: {
              newId: () => input.identity.newUlid(),
              deviceId: () => input.identity.deviceId(),
              stamp: () => input.identity.hlcStamp(),
            },
          });
          const result = composeWeeklyReview(
            projectWorkoutMatches({
              workouts: workouts.filter(
                (workout) =>
                  workout.dateKey >= window.weekStartDateKey &&
                  workout.dateKey <= window.weekEndDateKey,
              ),
              activities: refreshed.activities,
              matches: refreshed.matches,
              todayDateKey,
              awaitingSync: false,
            }),
          );
          if (result === null) return reject(UNAVAILABLE);
          const stamp = input.identity.hlcStamp();
          const deviceId = await input.identity.deviceId();
          try {
            const attempt = await weeklyReviewRepository.beginAttempt({
              id: input.identity.newUlid(),
              planId: plan.id,
              weekStartDateKey: window.weekStartDateKey,
              weekEndDateKey: window.weekEndDateKey,
              status: "pending",
              lastAttemptSyncAtMs: sync.lastSuccessfulSyncAtMs,
              summaryJson: null,
              deliveredAtMs: null,
              createdAtMs: stamp.physicalMs,
              updatedAtMs: stamp.physicalMs,
              deviceId,
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            if (!attempt.started) return reject(UNAVAILABLE);
            const completedStamp = input.identity.hlcStamp();
            const completed = await weeklyReviewRepository.complete({
              id: attempt.record.id,
              summaryJson: JSON.stringify(result),
              deliveredAtMs: completedStamp.physicalMs,
              updatedAtMs: completedStamp.physicalMs,
              deviceId,
              hlcPhysicalMs: completedStamp.physicalMs,
              hlcCounter: completedStamp.counter,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: "PL-S100",
                weeklyReview: deliveredWeeklyReviewProjection(completed),
              }),
            });
          } catch {
            return reject(PERSISTENCE_FAILED);
          }
        }
        if (command.transitionId === "PL-T39") {
          const closeCoachPair =
            (command.sourceScenarioId === "PL-S017" &&
              command.destinationScenarioId === "PL-S001") ||
            (command.sourceScenarioId === "PL-S079" && command.destinationScenarioId === "PL-S004");
          if (closeCoachPair) {
            const state = await read();
            if (state.scenarioId !== command.sourceScenarioId || state.projection !== "coach") {
              return reject(UNAVAILABLE);
            }
            if (command.destinationScenarioId === "PL-S001") {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: buildPlanLifecycleReadModel({
                  conversation: null,
                  turns: [],
                  readyToCreateDraft: false,
                  queue: EMPTY_QUEUE,
                  decision: null,
                  draft: null,
                }),
              });
            }
            const data = PlanCoachProjectionDataSchema.parse(state.data);
            const activePlan =
              data.replacesPlanId === null ? undefined : await plans.read(data.replacesPlanId);
            if (activePlan?.status !== "active") return reject(UNAVAILABLE);
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S004" }, activePlan),
            });
          }
          const coachBackPair =
            (command.sourceScenarioId === "PL-S016" &&
              command.destinationScenarioId === "PL-S017") ||
            (command.sourceScenarioId === "PL-S103" && command.destinationScenarioId === "PL-S079");
          if (coachBackPair) {
            const state = await read();
            if (state.scenarioId !== command.sourceScenarioId || state.projection !== "coach") {
              return reject(UNAVAILABLE);
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: PlanReadModelSchema.parse({
                ...state,
                scenarioId: command.destinationScenarioId,
                title: "Plan coach",
                summary: "Tell your coach what else should shape this Plan.",
                transitions: state.transitions.filter(
                  (transition) =>
                    transition.transitionId !== "PL-T06" && transition.transitionId !== "PL-T39",
                ),
              }),
            });
          }
          if (
            command.sourceScenarioId === "PL-S099" &&
            command.destinationScenarioId === "PL-S004"
          ) {
            if (planningRequests === undefined) return reject(UNAVAILABLE);
            const request = await planningRequests.read(command.returnFocusId);
            const plan = await plans.readLatest();
            if (
              request === undefined ||
              request.request.lifecycle === "open" ||
              plan?.status !== "active"
            ) {
              return reject(UNAVAILABLE);
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ activeScenario: "PL-S004" }),
            });
          }
          if (
            command.sourceScenarioId === "PL-S089" &&
            command.destinationScenarioId === "PL-S102"
          ) {
            const plan = await plans.readLatest();
            if (plan?.status !== "ended") return reject(UNAVAILABLE);
            const conversation = await conversations.readConversationByPlanId(plan.id);
            if (conversation === undefined) return reject(UNAVAILABLE);
            const turns = await conversations.readTurns(conversation.id);
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: buildEndedPlanConversationReadModel({
                conversation: {
                  id: conversation.id,
                  planId: conversation.planId,
                  replacesPlanId: conversation.replacesPlanId,
                  sourceConversationId: null,
                },
                turns,
                planId: plan.id,
                revision: 0,
              }),
            });
          }
          if (
            command.sourceScenarioId === "PL-S102" &&
            command.destinationScenarioId === "PL-S089"
          ) {
            const plan = await plans.readLatest();
            if (plan?.status !== "ended") return reject(UNAVAILABLE);
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ endedScenario: "PL-S089" }),
            });
          }
          if (
            command.sourceScenarioId === "PL-S081" &&
            command.destinationScenarioId === "PL-S080"
          ) {
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ replacementConfirmation: false }),
            });
          }
          if (
            command.sourceScenarioId === "PL-S094" &&
            command.destinationScenarioId === "PL-S095"
          ) {
            const plan = await plans.readLatest();
            if (plan?.status !== "ended") return reject(UNAVAILABLE);
            const [sync, outcome] = await Promise.all([
              workoutMatches.readSyncStatus(),
              raceOutcomeRepository.read(plan.id),
            ]);
            const todayDateKey = dependencies.todayDateKey?.() ?? utcTodayDateKey();
            if (
              !raceOutcomeDue({
                plan,
                todayDateKey,
                awaitingSync: sync.awaitingSync,
                outcome,
              })
            ) {
              return reject(UNAVAILABLE);
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({ endedScenario: "PL-S095" }),
            });
          }
          const readReturnState = async (
            scenarioId: PlanScenarioId,
            returnFocusId: string,
          ): Promise<PlanReadModel> => {
            if (scenarioId !== "PL-S028") {
              return read({
                activeScenario: scenarioId as ActivePlanScenario,
                returnFocusId,
              });
            }
            const state = await read({ returnFocusId });
            return PlanReadModelSchema.parse({
              ...state,
              scenarioId: "PL-S028",
              projection: "attention",
              title: "Plan attention",
              summary: `${state.attention.count} items need your decision.`,
            });
          };
          if (PROPOSAL_RESULT_SCENARIOS.has(command.sourceScenarioId)) {
            const proposalReturn = command.selectedProposalReturn;
            if (
              !isSafeProposalReturn(proposalReturn) ||
              command.destinationScenarioId !== proposalReturn.sourceScenarioId ||
              command.returnFocusId !== proposalReturn.returnFocusId
            ) {
              return reject(UNAVAILABLE);
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await readReturnState(
                proposalReturn.sourceScenarioId,
                proposalReturn.returnFocusId,
              ),
            });
          }
          const allowed =
            (command.destinationScenarioId === "PL-S005" &&
              [
                "PL-S004",
                "PL-S008",
                "PL-S026",
                "PL-S027",
                "PL-S090",
                "PL-S091",
                "PL-S092",
                "PL-S093",
                "PL-S051",
                "PL-S101",
              ].includes(command.sourceScenarioId)) ||
            (command.destinationScenarioId === "PL-S004" &&
              [
                "PL-S005",
                "PL-S006",
                "PL-S009",
                "PL-S012",
                "PL-S074",
                "PL-S075",
                "PL-S076",
                "PL-S077",
                "PL-S078",
                "PL-S098",
                "PL-S026",
                "PL-S027",
                "PL-S051",
                "PL-S101",
              ].includes(command.sourceScenarioId)) ||
            (command.sourceScenarioId === "PL-S006" &&
              command.destinationScenarioId === "PL-S009") ||
            (command.sourceScenarioId === "PL-S009" &&
              command.destinationScenarioId === "PL-S006") ||
            ((command.sourceScenarioId === "PL-S021" || command.sourceScenarioId === "PL-S032") &&
              (command.destinationScenarioId === "PL-S004" ||
                command.destinationScenarioId === "PL-S009" ||
                command.destinationScenarioId === "PL-S028")) ||
            (command.sourceScenarioId === "PL-S005" &&
              command.destinationScenarioId === "PL-S090") ||
            (command.sourceScenarioId === "PL-S087" && command.destinationScenarioId === "PL-S088");
          if (!allowed) return reject(UNAVAILABLE);
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await readReturnState(command.destinationScenarioId, command.returnFocusId),
          });
        }
        if (command.transitionId === "PL-T33") {
          const state = await read();
          if (state.planId !== command.planId || state.attention.count === 0) {
            return reject(UNAVAILABLE);
          }
          if (state.attention.destination === "direct") {
            const item = state.attention.items[0]!;
            if (item.id.startsWith("workout-match:")) {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S021",
                  selectedWorkoutId: item.id.slice("workout-match:".length),
                }),
              });
            }
            if (item.id.startsWith("workout-drift:")) {
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: "PL-S032",
                  selectedWorkoutId: item.id.slice("workout-drift:".length),
                }),
              });
            }
            if (item.id.startsWith("proposal:")) {
              const proposalId = item.id.slice("proposal:".length);
              const proposal = await proposalRepository.read(proposalId);
              if (proposal?.status !== "proposed") return reject(UNAVAILABLE);
              return ExecutePlanTransitionRpcResultSchema.parse({
                status: "completed",
                state: await read({
                  activeScenario: item.scenarioId === "PL-S025" ? "PL-S025" : "PL-S007",
                  selectedProposalId: proposalId,
                }),
              });
            }
            return ExecutePlanTransitionRpcResultSchema.parse({ status: "completed", state });
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: PlanReadModelSchema.parse({
              ...state,
              scenarioId: "PL-S028",
              projection: "attention",
              title: "Plan attention",
              summary: `${state.attention.count} items need your decision.`,
            }),
          });
        }
        if (command.transitionId === "PL-T34") {
          const isMatch = command.attentionId.startsWith("workout-match:");
          const isDrift = command.attentionId.startsWith("workout-drift:");
          const isProposal = command.attentionId.startsWith("proposal:");
          if (!isMatch && !isDrift && !isProposal) return reject(UNAVAILABLE);
          const plan = await plans.readLatest();
          if (plan?.status !== "active") return reject(UNAVAILABLE);
          if (isProposal) {
            const proposalId = command.attentionId.slice("proposal:".length);
            const proposal = await proposalRepository.read(proposalId);
            if (proposal?.status !== "proposed" || proposal.planId !== plan.id) {
              return reject(UNAVAILABLE);
            }
            const premises = await proposalRepository.readPremises(proposal.id);
            let scenario: ActivePlanScenario = "PL-S007";
            try {
              validatePlanProposal({
                proposal,
                premises,
                plan,
                workouts: await plans.readWorkouts(plan.id),
                todayDateKey: dependencies.todayDateKey?.() ?? utcTodayDateKey(),
                calculateWeekLoad: dependencies.proposalLoadCalculator,
              });
            } catch (error) {
              if (error instanceof PlanProposalError && error.code === "stale-base") {
                scenario = "PL-S025";
              }
            }
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read({
                activeScenario: scenario,
                selectedProposalId: proposalId,
                selectedProposalReturn: {
                  sourceScenarioId: "PL-S028",
                  returnFocusId: `plan-attention-${command.attentionId}`,
                },
              }),
            });
          }
          const workoutId = command.attentionId.slice(
            isMatch ? "workout-match:".length : "workout-drift:".length,
          );
          const workout = (await plans.readWorkouts(plan.id)).find(
            (candidate) => candidate.id === workoutId,
          );
          if (workout === undefined) return reject(UNAVAILABLE);
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read({
              activeScenario: isMatch ? "PL-S021" : "PL-S032",
              selectedWorkoutId: workoutId,
              selectedWorkoutSourceScenarioId: "PL-S028",
            }),
          });
        }
        return reject(UNAVAILABLE);
      };
      return enqueue(() =>
        commandAuthority
          .run(
            {
              store,
              enforce:
                fencedTransitions.has(command.transitionId) ||
                ((command.transitionId === "PL-T12" || command.transitionId === "PL-T27") &&
                  command.mode !== "verify"),
            },
            execute,
          )
          .catch((error: unknown) => {
            if (error instanceof LegacyPlanningAuthorityError) {
              return reject(
                { code: "conflict", message: error.message, retryable: false },
                { readOnly: true },
              );
            }
            throw error;
          }),
      );
    },
  };
}
