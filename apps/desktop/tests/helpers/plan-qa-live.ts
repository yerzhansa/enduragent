import type { DesktopFixtureScript, RunningDesktopFixture } from "./desktop-fixture.js";
import {
  PlanCoachProjectionDataSchema,
  PlanReadModelSchema,
  type AthleteState,
  type PlanScenarioId,
} from "@enduragent/coach-contract";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchDesktopFixture } from "./desktop-fixture.js";
import { PLAN_QA_ATHLETE_STATE } from "./inspection-athlete-states.js";
import {
  planQaOutcomeIsRejected,
  planQaScenario,
  planQaSeedScenarioId,
  resolvePlanQaTransition,
  planQaTransitionResult,
  type PlanQaTransitionOutcome,
} from "./plan-qa-scenario-registry.js";
import {
  planAttention,
  planCoachData,
  planReadModel,
} from "../../../desktop-renderer/tests/plan-fixtures.js";

const token = "q".repeat(43);
const requestedScenario = planQaScenario(process.env.PLAN_QA_SCENARIO ?? "PL-S001");
const scenario = planQaSeedScenarioId(requestedScenario.id);
const planId = "plan-qa";

const plan = {
  id: planId,
  name: "Gran Fondo Almaty",
  primaryGoal: "Finish in the front half",
  startDate: "1998-07-13",
  targetDate: "1998-10-04",
  kind: "full-plan" as const,
  totalWeeks: 12,
  weekStartDay: 1,
  workoutCount: 58,
  plannedDurationS: 309_600,
  phaseSummary: ["Build", "Recovery", "Taper", "Race"],
  ftpWatts: 282,
};

const workouts = [
  ["workout-1", "1998-08-18", "Endurance", 5_400, "as-planned", false],
  ["workout-2", "1998-08-19", "Threshold 4×8", 4_800, "adjusted", false],
  ["workout-3", "1998-08-20", "Easy endurance", 3_000, "moved", false],
  ["workout-4", "1998-08-21", "Recovery", 2_700, "missed", false],
  ["workout-5", "1998-08-22", "Café ride", 7_500, "extra", false],
  ["workout-6", "1998-08-23", "Suggested endurance", 1_800, "decision-needed", true],
].map(([id, date, name, durationS, status, requiresConfirmation], index) => ({
  id: String(id),
  date: String(date),
  sport: "cycling",
  name: String(name),
  durationS: Number(durationS),
  match: {
    kind: status === "extra" ? ("extra" as const) : ("planned" as const),
    status: status as "as-planned" | "adjusted" | "moved" | "missed" | "extra" | "decision-needed",
    activityId: status === "upcoming" ? null : `activity-${index + 1}`,
    matchId: `match-${index + 1}`,
    actualDate: String(date),
    actualDurationS: Number(durationS),
    requiresConfirmation: Boolean(requiresConfirmation),
    createdAtMs: index + 1,
  },
}));

const driftWorkout = {
  ...workouts[2]!,
  drift: {
    status: "detected" as const,
    eventId: "event-outside-edit",
    detectedAtMs: 903_766_320_000,
    plan: { date: "1998-08-20", name: "Easy endurance", durationS: 3_000 },
    provider: { date: "1998-08-21", name: "Tempo endurance", durationS: 3_600 },
    error: null,
  },
};

const todayWorkout = {
  ...workouts[3],
  id: "today-recovery",
  date: "1998-08-22",
  name: "Recovery spin",
  durationS: 2_700,
  powerTargetW: { min: 130, max: 165 },
  cue: "Keep the pedals light.",
  match: {
    ...workouts[3]!.match,
    activityId: "activity-today",
    matchId: "match-today",
    actualDate: "1998-08-22",
    actualDurationS: 2_700,
  },
};

const history = [
  {
    id: "history-adjustment",
    kind: "proposal-applied" as const,
    label: "Sunday adjustment applied",
    occurredAtMs: 903_766_320_000,
    targetWorkoutId: "workout-6",
    before: { date: "1998-08-23", name: "Endurance", durationS: 5_400 },
    after: { date: "1998-08-23", name: "Recovery", durationS: 1_800 },
    weekLoadBefore: 420,
    weekLoadAfter: 360,
    undoStatus: "eligible" as const,
    undoReason: null,
  },
  {
    id: "history-activation",
    kind: "activation" as const,
    label: "Plan approved",
    occurredAtMs: 900_331_200_000,
    targetWorkoutId: null,
    before: null,
    after: null,
    weekLoadBefore: null,
    weekLoadAfter: null,
    undoStatus: "none" as const,
    undoReason: null,
  },
];

const proposal = {
  id: "proposal-qa",
  revision: 1,
  title: "Sunday recovery",
  rationale: "Saturday fatigue is 12 above your normal range.",
  confidence: "High" as const,
  targetWorkoutId: "workout-6",
  affectedDate: "1998-08-23",
  createdAtMs: 903_766_320_000,
  stale: false,
  diff: [
    { field: "duration" as const, label: "Duration", before: "1:30", after: "0:30" },
    { field: "workout" as const, label: "Workout", before: "Endurance", after: "Recovery" },
    { field: "week-load" as const, label: "Week load", before: "420", after: "360" },
  ],
  premises: [
    {
      id: "premise-qa",
      sourceType: "activity",
      sourceId: "ride-historical",
      sourceLabel: "Saturday ride · 21 Aug · Assioma pedals",
      sourceDate: "1998-08-21",
      confidence: "High" as const,
      snapshotJson: '{"loadAboveNormal":12}',
    },
  ],
  error: null,
};

const attachedCourse = {
  fileName: "gran-fondo-almaty.gpx",
  format: "gpx" as const,
  pointCount: 4_200,
  distanceM: 120_000,
  elevationGainM: 1_850,
  elevationStatus: "available" as const,
};

const seasonDates = [
  ["1998-07-13", "1998-07-19"],
  ["1998-07-20", "1998-07-26"],
  ["1998-07-27", "1998-08-02"],
  ["1998-08-03", "1998-08-09"],
  ["1998-08-10", "1998-08-16"],
  ["1998-08-17", "1998-08-23"],
  ["1998-08-24", "1998-08-30"],
  ["1998-08-31", "1998-09-06"],
  ["1998-09-07", "1998-09-13"],
  ["1998-09-14", "1998-09-20"],
  ["1998-09-21", "1998-09-27"],
  ["1998-09-28", "1998-10-04"],
] as const;

const seasonWeeks = seasonDates.map(([startDate, endDate], index) => ({
  weekIndex: index + 1,
  startDate,
  endDate,
  phase: index === 11 ? "Race" : index >= 10 ? "Taper" : index === 3 ? "Recovery" : "Build",
  purpose: index === 11 ? "Goal race" : "Follow the approved week",
  status:
    index === 5 ? ("current" as const) : index < 5 ? ("completed" as const) : ("planned" as const),
  plannedDurationS: index === 11 ? 29_100 : 32_400,
}));

const raceWeek = {
  startDate: "1998-09-28",
  endDate: "1998-10-04",
  raceDate: "1998-10-04",
  trainingDurationS: 11_100,
  raceDurationS: 18_000,
  totalDurationS: 29_100,
  days: [
    ["1998-09-28", "Mon", null, "Rest", null, "Absorb", "rest"],
    ["1998-09-29", "Tue", "race-1", "Openers · 3×1 min", 2_700, "Sharpen", "training"],
    ["1998-09-30", "Wed", "race-2", "Easy endurance", 3_000, "Maintain", "training"],
    ["1998-10-01", "Thu", null, "Rest", null, "Freshen", "rest"],
    ["1998-10-02", "Fri", "race-3", "Race opener", 1_800, "Sharpen", "training"],
    ["1998-10-03", "Sat", "race-4", "Pre-race spin", 3_600, "Prime", "training"],
    ["1998-10-04", "Sun", "race-5", "Gran Fondo Almaty", 18_000, "Race", "race"],
  ].map(([date, weekday, workoutId, name, durationS, purpose, kind]) => ({
    date: String(date),
    weekday: weekday as "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun",
    workoutId: workoutId === null ? null : String(workoutId),
    name: String(name),
    durationS: durationS === null ? null : Number(durationS),
    purpose: String(purpose),
    kind: kind as "training" | "rest" | "race",
  })),
};

const activeData = {
  plan,
  today: "1998-08-22",
  weekIndex: 6,
  todayWorkout,
  workouts,
  matchSync: { lastSuccessfulSyncAtMs: 903_766_320_000, awaitingSync: false },
  selectedWorkoutId: null,
  selectedWorkout: null,
  selectedWorkoutSourceScenarioId: null,
  selectedProposalReturn: null,
  returnFocusId: null,
  proposals: [proposal],
  selectedProposalId: null,
  proposalRevisionText: null,
  history,
  selectedHistoryId: null,
  settings: {
    autoApply: false,
    weeklyReview: true,
    updatedAtMs: 903_766_320_000,
    selectedSetting: null,
    error: null,
  },
  weeklyReview: {
    status: "delivered" as const,
    id: "weekly-review-qa",
    weekStart: "1998-08-10",
    weekEnd: "1998-08-16",
    deliveredAtMs: 903_766_320_000,
    counts: { asPlanned: 3, adjusted: 1, moved: 1, missed: 1, extra: 1 },
    summary: "You completed the key work and adjusted one session for recovery.",
  },
  season: {
    priority: "A" as const,
    distanceKm: 120,
    weeks: seasonWeeks,
    constraint: {
      weekIndex: 8,
      title: "FTP refresh required before Build 2",
      detail: "Later durations stay fixed; power targets wait for refreshed FTP.",
    },
    raceWeek,
  },
  readiness: {
    form: {
      status: "available" as const,
      asOf: "1998-08-22",
      current: 1,
      raceRange: { min: 4, max: 9 },
      assumptions: ["Planned load is completed", "Recovery remains normal"],
      unavailableReason: null,
      lastSuccessfulRefreshAtMs: 903_766_320_000,
    },
    feasibility: {
      verdict: "on-track" as const,
      supportedDistanceKm: { min: 115, max: 130 },
      reasons: ["Training is consistent"],
      recommendation: "Keep the approved taper",
    },
    courseEstimate: {
      status: "available" as const,
      rangeMinutes: { min: 288, max: 312 },
      previousRangeMinutes: null,
      confidence: "moderate" as const,
      assumptions: ["Dry roads", "Low wind", "Planned fueling", "No mechanical delay"],
      changedAssumption: null,
      unavailableReason: null,
    },
    estimatedCp: {
      status: "available" as const,
      watts: 287,
      calculatedOn: "1998-08-22",
      lastSuccessfulSyncAtMs: 903_766_320_000,
      unavailableReason: null,
      efforts: [
        {
          activityId: "ride-short",
          ride: "Tuesday Hill Repeats",
          date: "1998-08-18",
          durationS: 180,
          averagePowerW: 407,
          device: "Favero Assioma Duo",
        },
        {
          activityId: "ride-long",
          ride: "Sunday Tempo Climb",
          date: "1998-08-09",
          durationS: 900,
          averagePowerW: 311,
          device: "Garmin Rally RS200",
        },
      ],
    },
    evidence: {
      prescribedDurationS: 154_800,
      riddenDurationS: 142_800,
      adjustedDurationS: 7_800,
      missedKeyWorkouts: 0,
      fatigue: "normal" as const,
    },
    taperRefusal: null,
    error: null,
  },
};

const activeScenarioIds = new Set([
  "PL-S004",
  "PL-S005",
  "PL-S006",
  "PL-S007",
  "PL-S008",
  "PL-S009",
  "PL-S010",
  "PL-S011",
  "PL-S012",
  "PL-S013",
  "PL-S021",
  "PL-S022",
  "PL-S023",
  "PL-S024",
  "PL-S025",
  "PL-S026",
  "PL-S027",
  "PL-S028",
  "PL-S032",
  "PL-S033",
  "PL-S034",
  "PL-S035",
  "PL-S036",
  "PL-S037",
  "PL-S038",
  "PL-S039",
  "PL-S040",
  "PL-S041",
  "PL-S042",
  "PL-S043",
  "PL-S051",
  "PL-S071",
  "PL-S072",
  "PL-S073",
  "PL-S074",
  "PL-S075",
  "PL-S076",
  "PL-S077",
  "PL-S078",
  "PL-S082",
  "PL-S083",
  "PL-S084",
  "PL-S085",
  "PL-S086",
  "PL-S087",
  "PL-S088",
  "PL-S090",
  "PL-S091",
  "PL-S092",
  "PL-S093",
  "PL-S097",
  "PL-S098",
  "PL-S100",
  "PL-S101",
]);

export function createPlanQaFixtureModel(
  id: string,
  context: {
    readonly selectedWorkoutId?: string;
    readonly workoutSourceScenarioId?: PlanScenarioId;
    readonly selectedProposalReturn?: {
      readonly sourceScenarioId: PlanScenarioId;
      readonly returnFocusId: string;
    };
    readonly returnFocusId?: string;
  } = {},
) {
  if (id === "PL-S001") return planReadModel();
  if (id === "PL-S017" || id === "PL-S016" || id === "PL-S079" || id === "PL-S103") {
    const ready = id === "PL-S016" || id === "PL-S103";
    const replacement = id === "PL-S079" || id === "PL-S103";
    return planReadModel({
      lifecycle: "intake",
      scenarioId: id as "PL-S017" | "PL-S016" | "PL-S079" | "PL-S103",
      projection: "coach",
      data: planCoachData({
        ready,
        replacement,
        replacesPlanId: replacement ? "plan-previous" : null,
        intake: {
          eventName: "Gran Fondo Almaty",
          eventPriority: "A",
          eventDate: "1998-10-04",
          goal: "Finish in the front half",
          availabilitySessionsPerWeek: 4,
          availabilityWeekdays: ["tue", "thu", "sat", "sun"],
          experience: "intermediate",
          currentTrainingSummary: "Four rides each week with a long weekend ride.",
        },
        missingDraftRequirements: ready ? [] : ["course-choice"],
        ftp: {
          status: "accepted",
          manual: { watts: 282, refreshedAtMs: 903_766_320_000 },
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: "manual",
          usedWatts: 282,
          conflict: false,
          error: null,
        },
        course: {
          status: ready ? "omitted" : "undecided",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
        messages: [
          {
            id: "coach-1",
            turnId: null,
            role: "coach",
            text: "Let’s build this here in Plan. What event are you training toward?",
          },
          {
            id: "athlete-1",
            turnId: "turn-1",
            role: "athlete",
            text: "Gran Fondo Almaty on 4 October. I want to finish in the front half.",
          },
          {
            id: "coach-2",
            turnId: "turn-1",
            role: "coach",
            text: "I found your recent rides, recovery, weekly availability, and FTP 282 W. Add a Race Course now, or keep the Draft course-agnostic.",
          },
        ],
      }),
    });
  }
  if (id === "PL-S018" || id === "PL-S030" || id === "PL-S105" || id === "PL-S020") {
    const replacement = id === "PL-S105";
    const discarded = id === "PL-S020";
    const revision = id === "PL-S030" ? 2 : 1;
    return planReadModel({
      lifecycle: discarded ? "intake" : replacement ? "replacement-draft-forming" : "draft-forming",
      scenarioId: id as "PL-S018" | "PL-S030" | "PL-S105" | "PL-S020",
      projection: discarded ? "coach" : "draft",
      planId: discarded ? null : planId,
      revision,
      data: planCoachData({
        replacement,
        replacesPlanId: replacement ? "plan-previous" : null,
        draft: discarded
          ? { id: "draft-qa", planId, revision: 1, status: "discarded", snapshot: {} }
          : { id: "draft-qa", planId, revision, status: "forming", snapshot: {} },
        course: {
          status: "omitted",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
  }
  if (id === "PL-S003") {
    return planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S003",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "required",
          manual: null,
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: null,
          usedWatts: null,
          conflict: false,
          error: null,
        },
      }),
    });
  }
  if (["PL-S057", "PL-S058", "PL-S059", "PL-S060", "PL-S061", "PL-S062"].includes(id)) {
    const manual = { watts: 282, refreshedAtMs: 903_766_320_000 };
    const intervals = { watts: 276, refreshedAtMs: 903_762_000_000 };
    return planReadModel({
      lifecycle: "intake",
      scenarioId: id as "PL-S057" | "PL-S058" | "PL-S059" | "PL-S060" | "PL-S061" | "PL-S062",
      projection: "coach",
      data: planCoachData({
        ftp:
          id === "PL-S058"
            ? {
                status: "no-source",
                manual: null,
                intervalsFtp: null,
                intervalsEftp: null,
                usedSource: null,
                usedWatts: null,
                conflict: false,
                error: null,
              }
            : id === "PL-S059"
              ? {
                  status: "refresh-failed",
                  manual: null,
                  intervalsFtp: null,
                  intervalsEftp: null,
                  usedSource: null,
                  usedWatts: null,
                  conflict: false,
                  error: {
                    code: "provider-failed",
                    message: "Intervals refresh failed.",
                    retryable: true,
                  },
                }
              : id === "PL-S060"
                ? {
                    status: "conflict",
                    manual,
                    intervalsFtp: intervals,
                    intervalsEftp: null,
                    usedSource: "manual",
                    usedWatts: 282,
                    conflict: true,
                    error: null,
                  }
                : id === "PL-S062"
                  ? {
                      status: "accepted",
                      manual,
                      intervalsFtp: null,
                      intervalsEftp: null,
                      usedSource: "manual",
                      usedWatts: 282,
                      conflict: false,
                      error: null,
                    }
                  : {
                      status: "required",
                      manual: null,
                      intervalsFtp: null,
                      intervalsEftp: null,
                      usedSource: null,
                      usedWatts: null,
                      conflict: false,
                      error: null,
                    },
      }),
    });
  }
  if (id === "PL-S102") {
    return planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S102",
      projection: "coach",
      planId,
      data: planCoachData({
        messages: [
          {
            id: "coach-history-1",
            turnId: null,
            role: "coach",
            text: "Let’s build this here in Plan. What event are you training toward?",
          },
          {
            id: "athlete-history-1",
            turnId: "turn-history-1",
            role: "athlete",
            text: "Gran Fondo Almaty on 4 October. I want to finish in the front half.",
          },
          {
            id: "coach-history-2",
            turnId: "turn-history-1",
            role: "coach",
            text: "I found your recent rides, recovery, weekly availability, and FTP 282 W.",
          },
        ],
      }),
    });
  }
  if (["PL-S002", "PL-S031", "PL-S050", "PL-S070", "PL-S080"].includes(id)) {
    const recalculated = id === "PL-S050";
    const replacement = id === "PL-S080";
    const draftPlan = recalculated
      ? {
          ...plan,
          startDate: "1998-07-20",
          kind: "short-race-preparation" as const,
          totalWeeks: 11,
          workoutCount: 53,
          plannedDurationS: 280_800,
        }
      : plan;
    return planReadModel({
      lifecycle: replacement ? "replacement-draft" : "draft",
      scenarioId: id as "PL-S002" | "PL-S031" | "PL-S050" | "PL-S070" | "PL-S080",
      projection: "draft",
      planId,
      revision: id === "PL-S002" ? 1 : 2,
      data: planCoachData({
        replacement,
        replacesPlanId: replacement ? "plan-previous" : null,
        draft: {
          id: "draft-qa",
          planId,
          revision: id === "PL-S002" ? 1 : 2,
          status: "ready",
          snapshot: { completeWeeks: 12 },
        },
        plan: draftPlan,
        course: {
          status: id === "PL-S070" ? "ready" : "omitted",
          accepted: id === "PL-S070" ? attachedCourse : null,
          candidate: null,
          fileName: null,
          detail: null,
        },
        startDate: {
          status: recalculated ? "updated" : "ready",
          selectedDate: recalculated ? "1998-07-20" : "1998-07-13",
          today: "1998-07-13",
          targetDate: "1998-10-04",
          kind: recalculated ? "short-race-preparation" : "full-plan",
          inclusiveDays: recalculated ? 77 : 84,
          totalWeeks: recalculated ? 11 : 12,
          raceWeekday: 0,
          raceDayOfPlanWeek: 7,
          error: null,
        },
      }),
    });
  }
  if (
    [
      "PL-S015",
      "PL-S019",
      "PL-S029",
      "PL-S044",
      "PL-S045",
      "PL-S047",
      "PL-S049",
      "PL-S066",
      "PL-S068",
      "PL-S081",
    ].includes(id)
  ) {
    const midweek = id === "PL-S045";
    const shortBlock = id === "PL-S044";
    const recalculating = id === "PL-S047" || id === "PL-S049";
    const replacement = id === "PL-S081";
    const courseAttached = id === "PL-S066" || id === "PL-S068";
    const draftPlan = midweek
      ? {
          ...plan,
          startDate: "1998-07-15",
          targetDate: "1998-10-07",
          totalWeeks: 13,
        }
      : shortBlock
        ? {
            ...plan,
            startDate: "1998-08-17",
            kind: "short-race-preparation" as const,
            totalWeeks: 7,
            workoutCount: 32,
            plannedDurationS: 172_800,
          }
        : plan;
    return planReadModel({
      lifecycle: replacement ? "replacement-draft" : "draft",
      scenarioId: id as
        | "PL-S015"
        | "PL-S019"
        | "PL-S029"
        | "PL-S044"
        | "PL-S045"
        | "PL-S047"
        | "PL-S049"
        | "PL-S066"
        | "PL-S068"
        | "PL-S081",
      projection: "draft",
      planId,
      revision: 1,
      data: planCoachData({
        replacement,
        replacesPlanId: replacement ? "plan-previous" : null,
        draft: { id: "draft-qa", planId, revision: 1, status: "ready", snapshot: {} },
        plan: draftPlan,
        startDate: {
          status: recalculating ? "recalculating" : "ready",
          selectedDate: draftPlan.startDate,
          today: "1998-07-13",
          targetDate: draftPlan.targetDate!,
          kind: draftPlan.kind,
          inclusiveDays: midweek ? 85 : shortBlock ? 49 : 84,
          totalWeeks: draftPlan.totalWeeks,
          raceWeekday: midweek ? 3 : 0,
          raceDayOfPlanWeek: midweek ? 1 : 7,
          error: null,
        },
        course: {
          status: id === "PL-S068" ? "recalculating" : courseAttached ? "ready" : "omitted",
          accepted: courseAttached ? attachedCourse : null,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
  }
  if (id === "PL-S063" || id === "PL-S064") {
    return planReadModel({
      lifecycle: "intake",
      scenarioId: id,
      projection: "coach",
      data: planCoachData({
        course: {
          status: id === "PL-S064" ? "parsing" : "undecided",
          accepted: null,
          candidate: null,
          fileName: id === "PL-S064" ? "gran-fondo-almaty.gpx" : null,
          detail: null,
        },
      }),
    });
  }
  if (id === "PL-S046") {
    return planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S046",
      projection: "draft",
      planId,
      revision: 1,
      data: planCoachData({
        draft: { id: "draft-qa", planId, revision: 1, status: "ready", snapshot: {} },
        plan,
        startDate: {
          status: "invalid",
          selectedDate: "1998-10-05",
          today: "1998-07-13",
          targetDate: "1998-10-04",
          kind: null,
          inclusiveDays: null,
          totalWeeks: null,
          raceWeekday: null,
          raceDayOfPlanWeek: null,
          error: {
            code: "invalid-input",
            message: "Choose a date before race day.",
            retryable: true,
          },
        },
        course: {
          status: "omitted",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
      }),
    });
  }
  if (id === "PL-S048") {
    return planReadModel({
      lifecycle: "draft",
      scenarioId: "PL-S048",
      projection: "draft",
      planId,
      revision: 1,
      data: planCoachData({
        draft: { id: "draft-qa", planId, revision: 1, status: "ready", snapshot: {} },
        plan,
        startDate: {
          status: "failed",
          selectedDate: "1998-07-20",
          today: "1998-07-13",
          targetDate: "1998-10-04",
          kind: "short-race-preparation",
          inclusiveDays: 77,
          totalWeeks: 11,
          raceWeekday: 0,
          raceDayOfPlanWeek: 7,
          error: { code: "persistence-failed", message: "Recalculation failed.", retryable: true },
        },
      }),
    });
  }
  if (["PL-S065", "PL-S067", "PL-S069", "PL-S104"].includes(id)) {
    const course =
      id === "PL-S065"
        ? {
            status: "invalid" as const,
            accepted: null,
            candidate: null,
            fileName: "course.fit",
            detail: "This file can’t be read.",
          }
        : id === "PL-S067"
          ? {
              status: "missing-elevation" as const,
              accepted: null,
              candidate: {
                fileName: "course.gpx",
                format: "gpx" as const,
                pointCount: 420,
                distanceM: 120_000,
                elevationGainM: null,
                elevationStatus: "unavailable" as const,
              },
              fileName: null,
              detail: null,
            }
          : id === "PL-S069"
            ? {
                status: "recalculation-failed" as const,
                accepted: null,
                candidate: null,
                fileName: null,
                detail: "Draft recalculation failed.",
              }
            : {
                status: "omission-failed" as const,
                accepted: null,
                candidate: null,
                fileName: null,
                detail: "Course choice could not be saved.",
              };
    return planReadModel({
      lifecycle: id === "PL-S104" ? "intake" : "draft",
      scenarioId: id as "PL-S065" | "PL-S067" | "PL-S069" | "PL-S104",
      projection: id === "PL-S104" ? "coach" : "draft",
      planId: id === "PL-S104" ? null : planId,
      revision: id === "PL-S104" ? 0 : 1,
      data: planCoachData({
        ready: id === "PL-S104",
        draft:
          id === "PL-S104"
            ? null
            : { id: "draft-qa", planId, revision: 1, status: "ready", snapshot: {} },
        plan: id === "PL-S104" ? null : plan,
        course,
      }),
    });
  }
  if (
    id === "PL-S014" ||
    id === "PL-S052" ||
    id === "PL-S053" ||
    id === "PL-S054" ||
    id === "PL-S055" ||
    id === "PL-S056" ||
    id === "PL-S089" ||
    id === "PL-S094" ||
    id === "PL-S095" ||
    id === "PL-S096"
  ) {
    const cleanupFailed = id === "PL-S053";
    const cleanupRunning = id === "PL-S052" || id === "PL-S054" || id === "PL-S055";
    return planReadModel({
      lifecycle: "ended",
      scenarioId: id as
        | "PL-S014"
        | "PL-S052"
        | "PL-S053"
        | "PL-S054"
        | "PL-S055"
        | "PL-S056"
        | "PL-S089"
        | "PL-S094"
        | "PL-S095"
        | "PL-S096",
      projection: "ended",
      planId,
      reconciliation: cleanupFailed
        ? {
            status: "failed",
            created: 0,
            pending: 0,
            failed: 1,
            total: 1,
            currentThrough: null,
            error: {
              code: "provider-failed",
              message: "Cleanup could not be verified.",
              retryable: true,
            },
          }
        : cleanupRunning
          ? {
              status: "running",
              created: 0,
              pending: 1,
              failed: 0,
              total: 1,
              currentThrough: null,
              error: null,
            }
          : {
              status: "verified",
              created: 0,
              pending: 0,
              failed: 0,
              total: 0,
              currentThrough: "1998-10-06",
              error: null,
            },
      data: {
        plan,
        endedAtMs: 903_766_320_000,
        raceOutcome: id === "PL-S096" ? "not-completed" : id === "PL-S014" ? "completed" : null,
        ...(id === "PL-S014"
          ? {
              raceOutcomeDetails: {
                outcome: "completed" as const,
                raceDate: "1998-10-04",
                goal: "Front half",
                result: "Front third",
                trainingDurationS: 303_600,
                raceDurationS: 18_180,
                totalDurationS: 321_780,
                modeledFinishMinutes: { min: 288, max: 312 },
                actualDurationS: 18_180,
                appliedChangeCount: 12,
              },
            }
          : id === "PL-S096"
            ? {
                raceOutcomeDetails: {
                  outcome: "not-completed" as const,
                  raceDate: "1998-10-04",
                },
              }
            : {}),
        outcomeAvailable: id === "PL-S094" || id === "PL-S095",
        cleanupItems: [
          {
            id: "cleanup-1",
            date: "1998-08-19",
            externalId: "external-1",
            status: cleanupFailed ? "failed" : cleanupRunning ? "pending" : "verified",
            errorCode: cleanupFailed ? "calendar-delete-failed" : null,
          },
        ],
      },
    });
  }
  const workoutSourceScenarioId = context.workoutSourceScenarioId ?? "PL-S004";
  const raceDay = raceWeek.days.find((day) => day.workoutId === context.selectedWorkoutId);
  const selectedWorkout =
    workoutSourceScenarioId === "PL-S009" && raceDay !== undefined
      ? {
          id: raceDay.workoutId!,
          date: raceDay.date,
          sport: "cycling",
          name: raceDay.name,
          durationS: raceDay.durationS,
        }
      : (workouts.find((workout) => workout.id === context.selectedWorkoutId) ?? workouts[5]);
  if (!activeScenarioIds.has(id)) throw new TypeError(`no truthful Plan QA model for ${id}`);
  const driftSelected = ["PL-S032", "PL-S033", "PL-S034", "PL-S035", "PL-S036"].includes(id)
    ? driftWorkout
    : null;
  const selected = id === "PL-S021" ? selectedWorkout : driftSelected;
  const reconciliation = ["PL-S039", "PL-S041", "PL-S083"].includes(id)
    ? {
        status: "failed" as const,
        created: 3,
        pending: 1,
        failed: 1,
        total: 5,
        currentThrough: null,
        error: {
          code: "provider-failed" as const,
          message: "Calendar update needs attention.",
          retryable: true,
        },
      }
    : ["PL-S038", "PL-S040", "PL-S042", "PL-S084", "PL-S086"].includes(id)
      ? {
          status: "running" as const,
          created: 3,
          pending: 2,
          failed: 0,
          total: 5,
          currentThrough: null,
          error: null,
        }
      : ["PL-S010", "PL-S043", "PL-S085", "PL-S087", "PL-S088"].includes(id)
        ? {
            status: "verified" as const,
            created: 5,
            pending: 0,
            failed: 0,
            total: 5,
            currentThrough: "1998-08-28",
            error: null,
          }
        : {
            status: "not-started" as const,
            created: 0,
            pending: 0,
            failed: 0,
            total: 0,
            currentThrough: null,
            error: null,
          };
  const activeScenario = id as
    | "PL-S004"
    | "PL-S005"
    | "PL-S006"
    | "PL-S009"
    | "PL-S010"
    | "PL-S012"
    | "PL-S013"
    | "PL-S021"
    | "PL-S028"
    | "PL-S090"
    | "PL-S091"
    | "PL-S092"
    | "PL-S093";
  return {
    ...planReadModel({
      lifecycle: "active",
      scenarioId: activeScenario,
      projection: id === "PL-S028" ? "attention" : "active",
      planId,
      reconciliation,
      attentionCount: id === "PL-S028" ? 2 : id === "PL-S021" ? 1 : 0,
      data: {
        ...activeData,
        ...(["PL-S028", "PL-S032", "PL-S033", "PL-S035"].includes(id)
          ? {
              workouts: activeData.workouts.map((workout) =>
                workout.id === driftWorkout.id ? driftWorkout : workout,
              ),
            }
          : {}),
        ...(["PL-S007", "PL-S022", "PL-S023", "PL-S024", "PL-S025"].includes(id)
          ? {
              proposals: [
                {
                  ...proposal,
                  revision: id === "PL-S023" ? 2 : proposal.revision,
                  stale: id === "PL-S025",
                },
              ],
              selectedProposalId: proposal.id,
              selectedProposalReturn: context.selectedProposalReturn ?? {
                sourceScenarioId: "PL-S004" as const,
                returnFocusId: `workout-row-${proposal.targetWorkoutId}`,
              },
              proposalRevisionText: id === "PL-S022" ? "Keep the long ride on Sunday." : null,
            }
          : {}),
        ...(id === "PL-S008" || id === "PL-S097"
          ? {
              proposals: [],
              selectedProposalReturn:
                id === "PL-S097"
                  ? (context.selectedProposalReturn ?? {
                      sourceScenarioId: "PL-S004" as const,
                      returnFocusId: `workout-row-${proposal.targetWorkoutId}`,
                    })
                  : null,
            }
          : {}),
        ...(["PL-S008", "PL-S026", "PL-S027", "PL-S101"].includes(id)
          ? { selectedHistoryId: "history-adjustment" }
          : {}),
        ...(id === "PL-S026"
          ? {
              history: activeData.history.map((entry) =>
                entry.id === "history-adjustment"
                  ? {
                      ...entry,
                      undoStatus: "expired" as const,
                      undoReason: "newer-change" as const,
                    }
                  : entry,
              ),
            }
          : {}),
        ...(id === "PL-S027"
          ? {
              history: activeData.history.map((entry) =>
                entry.id === "history-adjustment"
                  ? { ...entry, undoStatus: "undone" as const }
                  : entry,
              ),
            }
          : {}),
        ...(["PL-S074", "PL-S075", "PL-S076", "PL-S077", "PL-S078", "PL-S098"].includes(id)
          ? {
              readiness: {
                ...activeData.readiness,
                ...(id === "PL-S074"
                  ? {
                      feasibility: {
                        verdict: "at-risk" as const,
                        supportedDistanceKm: { min: 85, max: 100 },
                        reasons: ["Recent training is below the load needed for the goal"],
                        recommendation: "Adjust the goal or extend the build",
                      },
                    }
                  : {}),
                ...(id === "PL-S075"
                  ? {
                      courseEstimate: {
                        status: "unavailable" as const,
                        rangeMinutes: null,
                        previousRangeMinutes: null,
                        confidence: null,
                        assumptions: [],
                        changedAssumption: null,
                        unavailableReason: "missing-course" as const,
                      },
                    }
                  : {}),
                ...(id === "PL-S076"
                  ? {
                      form: {
                        status: "unavailable" as const,
                        asOf: null,
                        current: null,
                        raceRange: null,
                        assumptions: [],
                        unavailableReason: "missing-platform-seed" as const,
                        lastSuccessfulRefreshAtMs: null,
                      },
                    }
                  : {}),
                ...(id === "PL-S077"
                  ? {
                      courseEstimate: {
                        ...activeData.readiness.courseEstimate,
                        status: "changed" as const,
                        rangeMinutes: { min: 300, max: 325 },
                        previousRangeMinutes: { min: 288, max: 312 },
                        changedAssumption: "Wind forecast increased",
                      },
                    }
                  : {}),
                ...(id === "PL-S078"
                  ? {
                      taperRefusal: {
                        requested: "Add the missed Threshold workout on Friday",
                        kept: "Race opener · 0:30",
                        reason: "Adding missed work during taper would reduce freshness",
                      },
                    }
                  : {}),
                ...(id === "PL-S098"
                  ? {
                      form: {
                        ...activeData.readiness.form,
                        status: "refreshing" as const,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(id === "PL-S009"
          ? {
              matchSync: {
                lastSuccessfulSyncAtMs: 903_766_320_000,
                awaitingSync: true,
              },
              season: {
                ...activeData.season,
                raceWeek: {
                  ...raceWeek,
                  days: raceWeek.days.map((day) =>
                    day.weekday === "Fri" ? { ...day, purpose: "Blocked" } : day,
                  ),
                },
              },
            }
          : {}),
        ...(id === "PL-S093"
          ? {
              settings: {
                ...activeData.settings,
                selectedSetting: "auto-apply" as const,
                error: {
                  code: "persistence-failed" as const,
                  message: "Could not save.",
                  retryable: true,
                },
              },
            }
          : {}),
        ...(id === "PL-S091"
          ? {
              settings: {
                ...activeData.settings,
                selectedSetting: "auto-apply" as const,
              },
            }
          : {}),
        ...(id === "PL-S092"
          ? {
              settings: {
                ...activeData.settings,
                autoApply: true,
                selectedSetting: null,
              },
            }
          : {}),
        ...(["PL-S082", "PL-S083", "PL-S084", "PL-S085", "PL-S086", "PL-S087", "PL-S088"].includes(
          id,
        )
          ? {
              replacement: {
                id: "replacement-qa",
                previousPlan: { ...plan, id: "plan-previous", name: "Previous Plan" },
                activatedAtMs: 903_766_320_000,
                cleanupItems: [
                  {
                    id: "cleanup-old-plan",
                    date: "1998-08-23",
                    externalId: "cycling-coach:plan:historical:workout",
                    status:
                      id === "PL-S083"
                        ? "failed"
                        : id === "PL-S085" ||
                            id === "PL-S086" ||
                            id === "PL-S087" ||
                            id === "PL-S088"
                          ? "verified"
                          : "pending",
                    errorCode: id === "PL-S083" ? "calendar-delete-failed" : null,
                  },
                ],
              },
            }
          : {}),
        selectedWorkoutId: selected?.id ?? null,
        selectedWorkout: selected,
        selectedWorkoutSourceScenarioId: selected === null ? null : workoutSourceScenarioId,
        returnFocusId: context.returnFocusId ?? null,
      },
    }),
    attention:
      id === "PL-S028"
        ? {
            count: 2,
            destination: "list" as const,
            items: [
              {
                id: "workout-match:workout-6",
                title: "Confirm Suggested endurance",
                scenarioId: "PL-S021" as const,
                priority: "dated" as const,
                affectedDate: "1998-08-23",
                createdAtMs: 903_766_320_000,
              },
              {
                id: "workout-drift:workout-3",
                title: "Easy endurance changed in Intervals",
                scenarioId: "PL-S032" as const,
                priority: "dated" as const,
                affectedDate: "1998-08-20",
                createdAtMs: 903_766_320_001,
              },
            ],
          }
        : planAttention(id === "PL-S021" ? 1 : 0),
  };
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

export function createPlanQaHydratedModel(
  id: string,
  context: {
    readonly selectedWorkoutId?: string;
    readonly workoutSourceScenarioId?: PlanScenarioId;
    readonly selectedProposalReturn?: {
      readonly sourceScenarioId: PlanScenarioId;
      readonly returnFocusId: string;
    };
    readonly returnFocusId?: string;
  } = {},
) {
  const model = createPlanQaFixtureModel(id, context);
  const definition = planQaScenario(id);
  return PlanReadModelSchema.parse({
    ...model,
    transitions: definition.expectedTransitions.map((transitionId) => ({
      transitionId,
      status: "available",
      reason: null,
    })),
  });
}

function qaOutcome(): PlanQaTransitionOutcome {
  const value = process.env.PLAN_QA_OUTCOME ?? "success";
  if (
    ![
      "success",
      "failure",
      "repeated-failure",
      "resumed",
      "no-source",
      "conflict",
      "validation",
      "not-completed",
    ].includes(value)
  ) {
    throw new TypeError(`unknown PLAN_QA_OUTCOME ${value}`);
  }
  return value as PlanQaTransitionOutcome;
}

export function createPlanQaFixtureScript(
  initialScenarioId: string = requestedScenario.id,
  athleteState: AthleteState = PLAN_QA_ATHLETE_STATE,
): DesktopFixtureScript {
  let current = createPlanQaHydratedModel(initialScenarioId);
  let intakeStatus: "incomplete" | "ready" = "ready";
  let courseChoice: "undecided" | "resolved" =
    current.scenarioId === "PL-S016" || current.scenarioId === "PL-S103" ? "resolved" : "undecided";
  let workoutSourceScenarioId: PlanScenarioId | null = null;
  let selectedWorkoutId: string | null = null;
  let selectedProposalReturn: {
    readonly sourceScenarioId: PlanScenarioId;
    readonly returnFocusId: string;
  } | null = null;
  let acceptedFtpReturnScenarioId: "PL-S016" | "PL-S103" | null = null;
  return {
    onRequest(value) {
      const request = value as {
        readonly method: string;
        readonly params: Record<string, unknown>;
      };
      if (request.method === "getPlanState") {
        if (acceptedFtpReturnScenarioId !== null) {
          current = createPlanQaHydratedModel(acceptedFtpReturnScenarioId);
          courseChoice = "resolved";
          acceptedFtpReturnScenarioId = null;
        }
        if (current.scenarioId === "PL-S021" && workoutSourceScenarioId !== null) {
          current = createPlanQaHydratedModel(workoutSourceScenarioId, {
            returnFocusId:
              selectedWorkoutId === null ? undefined : `workout-row-${selectedWorkoutId}`,
          });
          workoutSourceScenarioId = null;
          selectedWorkoutId = null;
        }
        if (
          ["PL-S007", "PL-S022", "PL-S023", "PL-S025", "PL-S097"].includes(current.scenarioId) &&
          selectedProposalReturn !== null
        ) {
          current = createPlanQaHydratedModel(selectedProposalReturn.sourceScenarioId, {
            returnFocusId: selectedProposalReturn.returnFocusId,
          });
          selectedProposalReturn = null;
        }
        return response({ status: "ready", state: current });
      }
      if (request.method === "executePlanTransition") {
        const transitionId = String(request.params.transitionId ?? "");
        const destination = request.params.destinationScenarioId;
        const sourceCoach = PlanCoachProjectionDataSchema.safeParse(current.data);
        if (transitionId === "PL-T13") {
          workoutSourceScenarioId = current.scenarioId;
          selectedWorkoutId = String(request.params.workoutId ?? "workout-6");
        }
        if (
          transitionId === "PL-T34" &&
          current.scenarioId === "PL-S028" &&
          typeof request.params.attentionId === "string"
        ) {
          workoutSourceScenarioId = "PL-S028";
          selectedWorkoutId = request.params.attentionId.slice(
            request.params.attentionId.indexOf(":") + 1,
          );
        }
        if (["PL-T17", "PL-T18", "PL-T19", "PL-T20"].includes(transitionId)) {
          const candidate = request.params.selectedProposalReturn;
          if (
            typeof candidate === "object" &&
            candidate !== null &&
            "sourceScenarioId" in candidate &&
            "returnFocusId" in candidate &&
            typeof candidate.sourceScenarioId === "string" &&
            typeof candidate.returnFocusId === "string"
          ) {
            selectedProposalReturn = {
              sourceScenarioId: candidate.sourceScenarioId as PlanScenarioId,
              returnFocusId: candidate.returnFocusId,
            };
          }
        }
        const outcome = qaOutcome();
        const rejected = planQaOutcomeIsRejected(outcome);
        const resolved = resolvePlanQaTransition(current.scenarioId, transitionId, {
          outcome,
          intakeStatus,
          courseChoice,
          ...(typeof request.params.attentionId === "string"
            ? { attentionId: request.params.attentionId }
            : {}),
          ...(typeof destination === "string" ? { destinationScenarioId: destination } : {}),
        });
        if ((transitionId === "PL-T02" || transitionId === "PL-T03") && !rejected) {
          courseChoice = "resolved";
        }
        current = createPlanQaHydratedModel(resolved.terminalScenarioId, {
          ...(["PL-S021", "PL-S032"].includes(resolved.terminalScenarioId) &&
          selectedWorkoutId !== null
            ? {
                selectedWorkoutId,
                workoutSourceScenarioId: workoutSourceScenarioId ?? "PL-S004",
              }
            : {}),
          ...(["PL-S007", "PL-S022", "PL-S023", "PL-S024", "PL-S025", "PL-S097"].includes(
            resolved.terminalScenarioId,
          ) && selectedProposalReturn !== null
            ? { selectedProposalReturn }
            : {}),
          ...(transitionId === "PL-T39" && typeof request.params.returnFocusId === "string"
            ? { returnFocusId: request.params.returnFocusId }
            : {}),
        });
        if (transitionId === "PL-T04" && !rejected && resolved.terminalScenarioId === "PL-S062") {
          acceptedFtpReturnScenarioId =
            sourceCoach.success && sourceCoach.data.replacement ? "PL-S103" : "PL-S016";
        }
        if (transitionId === "PL-T05" && current.projection === "coach") {
          const coach = PlanCoachProjectionDataSchema.parse(current.data);
          current = PlanReadModelSchema.parse({
            ...current,
            data: {
              ...coach,
              messages: [
                ...coach.messages,
                {
                  id: "plan-qa-athlete-turn",
                  turnId: "plan-qa-turn",
                  role: "athlete",
                  text: String(request.params.text ?? "Saved choice"),
                },
                {
                  id: "plan-qa-coach-turn",
                  turnId: "plan-qa-turn",
                  role: "coach",
                  text: "Thanks — I have that. What else should we update?",
                },
              ],
            },
          });
        }
        if (transitionId === "PL-T39") {
          workoutSourceScenarioId = null;
          selectedWorkoutId = null;
          selectedProposalReturn = null;
        }
        const commandId = String(request.params.commandId ?? "plan-qa-command");
        const progress = resolved.progressScenarioIds.map((_progressScenarioId, index) => ({
          commandId,
          transitionId,
          operationId: `plan-qa:${transitionId}`,
          phase: "running",
          completed: index,
          total: resolved.progressScenarioIds.length + 1,
        }));
        const coachTurnProgress =
          transitionId === "PL-T05"
            ? [
                {
                  commandId,
                  transitionId,
                  operationId: `plan-qa:${transitionId}`,
                  phase: "running" as const,
                  completed: 0,
                  total: 1,
                  turnEvent: {
                    type: "turn-start" as const,
                    turnId: "plan-qa-turn",
                    chatId: `plan:${String(request.params.conversationId ?? "plan-qa")}`,
                  },
                },
                {
                  commandId,
                  transitionId,
                  operationId: `plan-qa:${transitionId}`,
                  phase: "running" as const,
                  completed: 0,
                  total: 1,
                  turnEvent: {
                    type: "final-text" as const,
                    turnId: "plan-qa-turn",
                    text: "Thanks — I have that. What else should we update?",
                  },
                },
              ]
            : [];
        return [
          ...progress.map((event) => JSON.stringify({ event })),
          ...coachTurnProgress.map((event) => JSON.stringify({ event })),
          ...response(planQaTransitionResult(outcome, current)),
        ];
      }
      if (request.method === "getSetupStatus") {
        return response({
          schemaVersion: 1,
          durableTrainingData: true,
        });
      }
      if (request.method === "getAthleteState") {
        return response(athleteState);
      }
      if (request.method === "getRuntimeConfig") {
        return response({
          schemaVersion: 3,
          llm: { provider: "codex-agent", model: "fixture", credential_configured: true },
          intervals: {
            athlete_id: "0",
            credential_configured: true,
            managedByEnvironment: { athleteId: false },
          },
          session: {
            historyTokenBudgetRatio: 0.3,
            idleMinutes: 0,
            dailyResetHour: 4,
            resetArchiveRetentionDays: 0,
            timezone: "UTC",
            managedByEnvironment: {
              historyTokenBudgetRatio: false,
              idleMinutes: false,
              dailyResetHour: false,
              resetArchiveRetentionDays: false,
              timezone: false,
            },
          },
        });
      }
      if (request.method === "getUnitsPreference")
        return response({ value: "metric", source: "default" });
      if (request.method === "getChatQueue")
        return response({ schemaVersion: 1, revision: 0, items: [] });
      if (request.method === "hasSession") return response({ hasSession: false });
      if (request.method === "getCoachDecision") return response({ decision: null });
      if (request.method === "getTranscriptPage") {
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      }
      if (request.method === "getSpendSummary") {
        return response({
          schemaVersion: 1,
          status: "available",
          timezone: "UTC",
          currency: "USD",
          today: { date: "1998-08-22", amountUsd: 0, capUsd: null },
          month: { month: "1998-08", amountUsd: 0 },
        });
      }
      throw new TypeError(`unexpected fixture method ${request.method}`);
    },
  };
}

let fixture: RunningDesktopFixture | undefined;

async function close(): Promise<void> {
  await fixture?.close();
  process.exit(0);
}

const directExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  fixture = await launchDesktopFixture({
    script: createPlanQaFixtureScript(),
    token,
    ...(process.env.PLAN_QA_EXECUTABLE === undefined
      ? {}
      : { executable: process.env.PLAN_QA_EXECUTABLE }),
    ...(process.env.PLAN_QA_APPLICATION === undefined
      ? {}
      : { applicationBundle: process.env.PLAN_QA_APPLICATION }),
    width: Number(process.env.PLAN_QA_WIDTH ?? 1180),
    height: Number(process.env.PLAN_QA_HEIGHT ?? 820),
    colorScheme:
      process.env.PLAN_QA_THEME === "dark" ||
      (process.env.PLAN_QA_THEME === undefined && requestedScenario.theme === "dark")
        ? "dark"
        : "light",
    reducedMotion: true,
    hidden: false,
  });

  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  process.stdout.write(`PLAN_QA_READY ${requestedScenario.id} SOURCE ${scenario}\n`);
}
