import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatQueueSnapshot,
  PlanCreationAnswerInput,
  CoachEngine,
  PlanProgressEvent,
  TurnEvent,
} from "@enduragent/coach-contract";
import {
  createPlanConversationRepository,
  createPlanCreationRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  createPlanSettingsRepository,
  createPlanWeeklyReviewRepository,
  createPlanWorkoutMatchRepository,
  createPlanProposalRepository,
  createPlanningRequestRepository,
  createRaceCourseSnapshot,
  createPlanReplacementRepository,
  createPlanRaceOutcomeRepository,
  createPlanIntakeRepository,
  type PlanActivityObservation,
  type PlanIntakeRepository,
  type PlanRecord,
  type PlanWorkoutMatchRecord,
  type PlanWorkoutMatchRepository,
  type PlanWorkoutRecord,
  type RaceCourseSnapshot,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  planMirrorExternalId,
  capturePlanProposalBase,
  encodePlanProposalBase,
  encodePlanProposalMutation,
  type PlanFtpAdapter,
  type PlanFtpSnapshot,
  type PlanMirrorCalendarPort,
} from "@enduragent/engine";
import { createPlanningOperations, type PlanDraftBuilder } from "../src/planning-operations.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import type { PlanRaceCourseAdapter } from "../src/planning-race-course.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const EMPTY_QUEUE: ChatQueueSnapshot = { schemaVersion: 1, revision: 0, items: [] };
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function identity(): AuthoredIdentity {
  let sequence = 0;
  let clock = 100;
  return {
    deviceId: async () => "device-1",
    newUlid() {
      sequence += 1;
      return `${"0".repeat(25)}${ALPHABET[sequence]}`;
    },
    hlcStamp() {
      clock += 1;
      return { physicalMs: clock, counter: 0 };
    },
  };
}

function engine(): CoachEngine {
  return {
    chat: vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "engine-turn-1", chatId: request.chatId });
      onEvent?.({ type: "text_delta", turnId: "engine-turn-1", delta: "I found your rides." });
      onEvent?.({ type: "final-text", turnId: "engine-turn-1", text: "I found your rides." });
      return { text: "I found your rides." };
    }),
    getChatQueue: async () => EMPTY_QUEUE,
    getCoachDecision: async () => ({ decision: null }),
    answerCoachDecision: vi.fn(),
    skipCoachDecision: vi.fn(),
    resumeCoachDecision: vi.fn(),
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: true }),
    getAthleteState: vi.fn(),
  } as unknown as CoachEngine;
}

function plan(id: string, timestamp: number): PlanRecord {
  return {
    id,
    originId: null,
    name: "Gran Fondo Plan",
    primaryGoal: "Finish in the front half",
    startDateKey: 20260709,
    targetDateKey: 20260930,
    status: "draft",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 4,
    structureJson: '{"phases":[]}',
    createdAtMs: timestamp,
    updatedAtMs: timestamp,
    deviceId: "device-1",
    hlcPhysicalMs: timestamp,
    hlcCounter: 0,
  };
}

function activationBuilder(): PlanDraftBuilder {
  const planId = `${"0".repeat(25)}W`;
  const workouts: PlanWorkoutRecord[] = [
    ["X", 20260709],
    ["Y", 20260715],
    ["Z", 20260716],
  ].map(([suffix, dateKey]) => ({
    id: `${"0".repeat(25)}${suffix}`,
    planId,
    dateKey: dateKey as number,
    sport: "cycling",
    name: `Workout ${suffix}`,
    durationS: 3_600,
    structureJson: "{}",
    origin: "coach",
    deviceId: "device-1",
    hlcPhysicalMs: 41,
    hlcCounter: 0,
  }));
  return {
    async form() {
      return { plan: plan(planId, 40), workouts, snapshot: { weeks: 12 } };
    },
    async revise() {
      return { plan: plan(planId, 40), workouts, snapshot: { weeks: 12 } };
    },
    async recalculateCourse() {
      return { plan: plan(planId, 40), workouts, snapshot: { weeks: 12 } };
    },
  };
}

function weeklyReviewMatches(input: {
  readonly planId: string;
  readonly workoutId: string;
  readonly syncAtMs: number;
}): PlanWorkoutMatchRepository {
  const activity: PlanActivityObservation = {
    activityId: "activity-1",
    providerActivityId: "provider-activity-1",
    dateKey: 20260817,
    sport: "cycling",
    durationS: 3_600,
    pairedEventId: null,
  };
  const extra: PlanActivityObservation = {
    activityId: "activity-extra",
    providerActivityId: "provider-activity-extra",
    dateKey: 20260822,
    sport: "cycling",
    durationS: 2_700,
    pairedEventId: null,
  };
  const match: PlanWorkoutMatchRecord = {
    id: `${"0".repeat(25)}M`,
    planId: input.planId,
    planWorkoutId: input.workoutId,
    activityId: activity.activityId,
    providerActivityId: activity.providerActivityId,
    providerEventId: null,
    source: "heuristic",
    decision: "confirmed",
    activityDateKey: activity.dateKey,
    activitySport: activity.sport,
    activityDurationS: activity.durationS,
    observedAtMs: 90,
    decidedAtMs: 90,
    deviceId: "device-1",
    hlcPhysicalMs: 90,
    hlcCounter: 0,
  };
  return {
    observe: async (record) => record,
    readForPlan: async () => [match],
    readForWorkout: async () => [match],
    decide: async () => match,
    listActivities: async () => [activity, extra],
    readProviderIdentities: async () => [],
    readSyncStatus: async () => ({
      lastSuccessfulSyncAtMs: input.syncAtMs,
      awaitingSync: false,
    }),
  };
}

function course(
  fileName: string,
  elevationStatus: "available" | "unavailable" = "available",
): RaceCourseSnapshot {
  return createRaceCourseSnapshot({
    fileName,
    route: {
      format: "gpx",
      segments: [
        {
          points: [
            {
              latitude: 43.2,
              longitude: 76.8,
              elevationM: elevationStatus === "available" ? 900 : null,
            },
            {
              latitude: 43.3,
              longitude: 76.9,
              elevationM: elevationStatus === "available" ? 960 : null,
            },
          ],
        },
      ],
    },
    preview: {
      pointCount: 2,
      distanceM: 14_000,
      elevationGainM: elevationStatus === "available" ? 60 : null,
      elevationStatus,
    },
  });
}

describe("Plan operations", () => {
  let store: SqlStore & MigratorStore;
  let context: CoachStoreWriterContext;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    context = {
      home: {
        root: "/synthetic/athlete",
        storeDir: "/synthetic/athlete/store",
        archiveDir: "/synthetic/athlete/archive",
        configDir: "/synthetic/athlete/config",
      },
      store,
      listener: {} as CoachStoreWriterContext["listener"],
    };
  });

  afterEach(async () => {
    await store.close();
  });

  it("reads an activated creation and its dated Workouts without legacy phases", async () => {
    let sequence = 100;
    const authored: AuthoredIdentity = {
      deviceId: async () => "activation-test-device",
      newUlid: () => `${"0".repeat(23)}${++sequence}`,
      hlcStamp: () => ({ physicalMs: 904_780_800_000, counter: 0 }),
    };
    const creation = createPlanCreationOperations({
      store,
      repository: createPlanCreationRepository(store),
      identity: authored,
      crypto: globalThis.crypto,
      eventCandidates: { read: async () => [] },
      today: () => "1998-09-02",
    });
    const started = await creation["plan_creation.start"]({ commandId: "start" });
    if (started.status !== "started") throw new Error("Expected creation");
    let card = started.planCreation;
    const answers: readonly PlanCreationAnswerInput[] = [
      { kind: "goal", goal: { kind: "fitness" } },
      { kind: "plan-length", weeks: 4 },
      { kind: "schedule-mode", mode: "fixed" },
      {
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 8,
        longestWorkoutHours: 3,
        usableWeekdays: [2, 4, 6],
      },
      { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
      { kind: "commitments", commitments: { kind: "none" } },
      { kind: "baseline", baseline: "regular" },
      { kind: "success", success: { kind: "fitness-choice", choice: "climb-stronger" } },
      { kind: "restriction", restriction: { kind: "none" } },
    ];
    for (const answer of answers) {
      const result = await creation["plan_creation.answer"]({
        commandId: `answer-${++sequence}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer,
      });
      if (result.status !== "answered") throw new Error("Expected confirmed answer");
      card = result.planCreation;
    }
    const reviewed = await creation["plan_creation.preview"]({
      commandId: "preview",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (reviewed.status !== "previewed" || reviewed.planCreation.draft === null)
      throw new Error("Expected Draft");
    const activated = await creation["plan_creation.activate"]({
      commandId: "activate",
      creationId: card.creationId,
      expectedVersion: reviewed.planCreation.version,
      incumbent: null,
    });
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { todayDateKey: () => 19980902 },
    );
    const result = await operations.getPlanState?.({});
    expect(result).toMatchObject({
      status: "ready",
      state: {
        projection: "active",
        data: {
          plan: { id: activated.planId, name: "Improve fitness" },
          workouts: expect.any(Array),
        },
      },
    });
    if (result?.status !== "ready") throw new Error("Expected active Plan state");
    const draftWorkouts = reviewed.planCreation.draft.weeks[0]?.workouts ?? [];
    expect(result.state.data.workouts).toEqual(
      draftWorkouts.map((workout) =>
        expect.objectContaining({
          date: workout.date,
          name: workout.name,
          durationS: workout.minutes * 60,
        }),
      ),
    );
  });

  it("persists and relaunches a dedicated streamed Plan conversation", async () => {
    const coach = engine();
    const authored = identity();
    const readiness = {
      isReady: ({ turns }: { readonly turns: readonly unknown[] }) => turns.length > 0,
    };
    const operations = createPlanningOperations(
      { context, engine: coach, identity: authored },
      readiness,
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    expect(started).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S017", projection: "coach" },
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = started.state.data.conversationId;
    if (typeof conversationId !== "string") throw new TypeError("Conversation id missing.");
    const progress: PlanProgressEvent[] = [];
    const sent = await operations.executePlanTransition?.(
      {
        transitionId: "PL-T05",
        commandId: "command-2",
        conversationId,
        text: "Gran Fondo Almaty on 4 October.",
      },
      (event) => progress.push(event),
    );
    expect(sent).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S017", projection: "coach" },
    });
    expect(progress.map((event) => event.phase)).toEqual([
      "queued",
      "running",
      "running",
      "running",
      "completed",
    ]);
    expect(coach.chat).toHaveBeenCalledWith(
      { chatId: `plan:${conversationId}`, message: "Gran Fondo Almaty on 4 October." },
      expect.any(Function),
    );
    const repository = createPlanConversationRepository(store);
    await expect(repository.readTurns(conversationId)).resolves.toMatchObject([
      {
        sequence: 1,
        athleteText: "Gran Fondo Almaty on 4 October.",
        coachText: "I found your rides.",
      },
    ]);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T03",
        commandId: "command-3",
        conversationId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S016", projection: "coach" },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-4",
        action: "back",
        sourceScenarioId: "PL-S016",
        destinationScenarioId: "PL-S017",
        returnFocusId: "plan-coach-composer",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S017",
        projection: "coach",
        data: { readyToCreateDraft: true },
      },
    });
    const restored = createPlanningOperations(
      { context, engine: coach, identity: authored },
      readiness,
    );
    await expect(restored.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S016",
        data: {
          conversationId,
          messages: [
            { role: "coach" },
            { role: "athlete", text: "Gran Fondo Almaty on 4 October." },
            { role: "coach", text: "I found your rides." },
          ],
        },
      },
    });
  });

  it("opens a terminal Chat-originated result and validates its exact return source", async () => {
    const authored = identity();
    const planId = `${"0".repeat(25)}P`;
    const activePlan = {
      ...plan(planId, 20),
      startDateKey: 19980709,
      targetDateKey: 19980930,
      status: "active" as const,
    };
    await createPlanRepository(store).replace(activePlan, []);
    const requests = createPlanningRequestRepository(store, createNodeCrypto());
    const created = await requests.createOrGet({
      payload: {
        requestId: "request-1",
        kind: "workout_review",
        intent: "Add Tempo 3 × 12 to Wednesday.",
        source: {
          chatId: "chat-1",
          messageId: "message-1",
          attachmentId: "attachment-1",
        },
        sourceSnapshot: {
          capturedAt: "1998-08-24T08:00:00.000Z",
          attachment: {
            attachmentId: "attachment-1",
            displayName: "tempo-3x12.mrc",
            extension: "mrc",
          },
          selectedWorkout: {
            setId: "set-1",
            workoutId: "workout-1",
            workout: {
              title: "Tempo 3 × 12",
              sport: "cycling",
              durationSeconds: 3_840,
            },
          },
        },
        requestedDate: "1998-08-26",
      },
      target: "active_plan",
      createdAtMs: 30,
      deviceId: "device-1",
      hlcPhysicalMs: 30,
      hlcCounter: 0,
    });
    await requests.complete({
      requestId: created.request.requestId,
      expectedRevision: created.request.revision,
      result: {
        kind: "applied",
        resultId: "result-1",
        completedAtMs: 40,
        title: "Workout added",
        detail: "Tempo 3 × 12 is scheduled for Wednesday.",
        workoutRef: { setId: "set-1", workoutId: "workout-1" },
        planRevisionId: "revision-1",
      },
      resolvedDateKey: 19980826,
      updatedAtMs: 40,
      deviceId: "device-1",
      hlcPhysicalMs: 40,
      hlcCounter: 0,
    });
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { requests, todayDateKey: () => 19980824 },
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T36",
        commandId: "command-open-request",
        sourceConversationId: "chat-1",
        requestId: "request-1",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S099",
        data: {
          returnTarget: { destination: "chat", chatId: "chat-1", messageId: "message-1" },
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T37",
        commandId: "command-return-wrong-source",
        sourceConversationId: "chat-2",
        requestId: "request-1",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T37",
        commandId: "command-return-source",
        sourceConversationId: "chat-1",
        requestId: "request-1",
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S099" } });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-stay-in-plan",
        action: "done",
        sourceScenarioId: "PL-S099",
        destinationScenarioId: "PL-S004",
        returnFocusId: "request-1",
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S004" } });
  });

  it("reopens the exact Plan conversation bound to an unresolved Chat request", async () => {
    const authored = identity();
    const requests = createPlanningRequestRepository(store, createNodeCrypto());
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { requests },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-start-plan",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    const created = await requests.createOrGet({
      payload: {
        requestId: "request-open",
        kind: "plan_creation",
        intent: "Build a Plan for my autumn event.",
        source: { chatId: "chat-open", messageId: "message-open" },
        sourceSnapshot: {
          capturedAt: "1998-08-24T08:00:00.000Z",
          attachment: null,
          selectedWorkout: null,
        },
      },
      target: "plan_creation",
      createdAtMs: 30,
      deviceId: "device-1",
      hlcPhysicalMs: 30,
      hlcCounter: 0,
    });
    await requests.reviseOpen({
      requestId: created.request.requestId,
      expectedRevision: created.request.revision,
      planConversationId: conversationId,
      proposalId: null,
      attention: "none",
      resolvedDateKey: null,
      updatedAtMs: 31,
      deviceId: "device-1",
      hlcPhysicalMs: 31,
      hlcCounter: 0,
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T36",
        commandId: "command-open-plan-request",
        sourceConversationId: "chat-open",
        requestId: "request-open",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S017",
        data: { conversationId, sourceConversationId: "chat-open" },
      },
    });
  });

  it("persists typed Plan intake and evaluates production Draft readiness", async () => {
    const coach = engine();
    coach.chat = vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "engine-turn-intake", chatId: request.chatId });
      onEvent?.({
        type: "final-text",
        turnId: "engine-turn-intake",
        text: "Tell me about your current training.",
      });
      return {
        text: "Tell me about your current training.",
        planIntakePatch: {
          eventName: "Gran Fondo Almaty",
          eventPriority: "A" as const,
          targetDate: "2026-10-04",
          goal: "Finish in the front half",
          availability: {
            sessionsPerWeek: 4,
            weekdays: ["tue" as const, "thu" as const, "sat" as const, "sun" as const],
          },
          experience: "intermediate" as const,
          currentTrainingSummary: "Three rides each week with a weekend long ride",
        },
      };
    });
    const ftp: PlanFtpAdapter = {
      read: async () => ({
        manual: { watts: 282, refreshedAtMs: 1 },
        intervalsFtp: null,
        intervalsEftp: null,
        usedSource: "manual",
        usedWatts: 282,
        conflict: false,
      }),
      saveManual: vi.fn(),
      refreshIntervals: vi.fn(),
    };
    const authored = identity();
    const operations = createPlanningOperations(
      { context, engine: coach, identity: authored },
      { ftp, todayDateKey: () => 20260709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "intake-start",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "intake-course",
      conversationId,
    });
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S017",
        data: {
          readyToCreateDraft: false,
          missingDraftRequirements: [
            "event",
            "priority",
            "date",
            "goal",
            "availability",
            "experience",
          ],
        },
      },
    });
    await operations.executePlanTransition?.({
      transitionId: "PL-T05",
      commandId: "intake-message",
      conversationId,
      text: "I can ride Tuesday, Thursday, Saturday, and Sunday.",
    });

    await expect(createPlanIntakeRepository(store).read(conversationId)).resolves.toMatchObject({
      eventName: "Gran Fondo Almaty",
      eventPriority: "A",
      eventDateKey: 20261004,
      athleteGoal: "Finish in the front half",
      availabilitySessionsPerWeek: 4,
      availabilityWeekdays: ["tue", "thu", "sat", "sun"],
      experience: "intermediate",
      sourceTurnSequence: 1,
    });
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { scenarioId: "PL-S016", data: { readyToCreateDraft: true } },
    });
    const restored = createPlanningOperations(
      { context, engine: coach, identity: identity() },
      { ftp, todayDateKey: () => 20260709 },
    );
    await expect(restored.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { scenarioId: "PL-S016", data: { readyToCreateDraft: true } },
    });
  });

  it("keeps an expired Goal Event in intake instead of entering Draft formation", async () => {
    const coach = engine();
    coach.chat = vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "expired-date-turn", chatId: request.chatId });
      onEvent?.({
        type: "final-text",
        turnId: "expired-date-turn",
        text: "That Goal Event date has passed. What future date should we use?",
      });
      return {
        text: "That Goal Event date has passed. What future date should we use?",
        planIntakePatch: {
          eventName: "Gran Fondo Almaty",
          eventPriority: "A" as const,
          targetDate: "2026-07-08",
          goal: "Finish in the front half",
          availability: {
            sessionsPerWeek: 4,
            weekdays: ["tue" as const, "thu" as const, "sat" as const, "sun" as const],
          },
          experience: "intermediate" as const,
        },
      };
    });
    const ftp: PlanFtpAdapter = {
      read: async () => ({
        manual: { watts: 282, refreshedAtMs: 1 },
        intervalsFtp: null,
        intervalsEftp: null,
        usedSource: "manual",
        usedWatts: 282,
        conflict: false,
      }),
      saveManual: vi.fn(),
      refreshIntervals: vi.fn(),
    };
    const builder = activationBuilder();
    const form = vi.spyOn(builder, "form");
    const operations = createPlanningOperations(
      { context, engine: coach, identity: identity() },
      { ftp, draftBuilder: builder, todayDateKey: () => 20260709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "expired-date-start",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "expired-date-course",
      conversationId,
    });
    await operations.executePlanTransition?.({
      transitionId: "PL-T05",
      commandId: "expired-date-message",
      conversationId,
      text: "The event was yesterday.",
    });

    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S017",
        data: { readyToCreateDraft: false, missingDraftRequirements: ["date"] },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T06",
        commandId: "expired-date-draft",
        conversationId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(form).not.toHaveBeenCalled();
  });

  it("persists typed Plan intake returned by a Coach decision continuation", async () => {
    const coach = engine();
    coach.answerCoachDecision = vi.fn(async (request, onEvent) => {
      onEvent?.({
        type: "turn-start",
        turnId: "decision-continuation-turn",
        chatId: request.chatId,
      });
      onEvent?.({
        type: "final-text",
        turnId: "decision-continuation-turn",
        text: "Thanks. The app has enough information to create a Draft.",
      });
      return {
        decision: {
          status: "answered" as const,
          decisionId: request.decisionId,
          chatId: request.chatId,
          messageId: "decision-message",
          question: "Which days work best?",
          options: [
            {
              id: "days-1",
              label: "Tue, Thu, Sat, Sun",
              description: "Use four available days.",
              recommended: true,
              consequence: "Use Tuesday, Thursday, Saturday, and Sunday.",
            },
            {
              id: "days-2",
              label: "Mon, Wed, Fri, Sun",
              description: "Use four alternate days.",
              recommended: false,
              consequence: "Use Monday, Wednesday, Friday, and Sunday.",
            },
          ],
          answer: request.answer,
          consequence: "Use Tuesday, Thursday, Saturday, and Sunday.",
          continuation: {
            status: "completed" as const,
            continuationId: "decision-continuation",
            turnId: "decision-continuation-turn",
            coachText: "Thanks. The app has enough information to create a Draft.",
            lineage: {
              templateHash: "template",
              assembledHash: "assembled",
              provider: "test",
              model: "test",
              lineageVersion: "1",
              planIntakePatch: {
                eventName: "Gran Fondo Almaty",
                eventPriority: "A" as const,
                targetDate: "1998-10-04",
                goal: "Finish in the front half",
                availability: {
                  sessionsPerWeek: 4,
                  weekdays: ["tue" as const, "thu" as const, "sat" as const, "sun" as const],
                },
                experience: "intermediate" as const,
                currentTrainingSummary: "Three rides each week with a weekend long ride",
              },
            },
          },
        },
      };
    });
    const ftp: PlanFtpAdapter = {
      read: async () => ({
        manual: { watts: 282, refreshedAtMs: 1 },
        intervalsFtp: null,
        intervalsEftp: null,
        usedSource: "manual",
        usedWatts: 282,
        conflict: false,
      }),
      saveManual: vi.fn(),
      refreshIntervals: vi.fn(),
    };
    const operations = createPlanningOperations(
      { context, engine: coach, identity: identity() },
      { ftp, todayDateKey: () => 19980709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "decision-start",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "decision-course",
      conversationId,
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T05",
        commandId: "decision-answer",
        conversationId,
        text: "Tue, Thu, Sat, Sun",
        decision: {
          action: "answer",
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "days-1" },
        },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S016", data: { readyToCreateDraft: true } },
    });
    await expect(createPlanIntakeRepository(store).read(conversationId)).resolves.toMatchObject({
      eventName: "Gran Fondo Almaty",
      eventPriority: "A",
      eventDateKey: 19981004,
      athleteGoal: "Finish in the front half",
      availabilitySessionsPerWeek: 4,
      availabilityWeekdays: ["tue", "thu", "sat", "sun"],
      experience: "intermediate",
      sourceTurnSequence: 1,
    });
  });

  it("recovers the intake projection from the durable turn after an interrupted save", async () => {
    const coach = engine();
    const authored = identity();
    coach.chat = vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "engine-turn-recovery", chatId: request.chatId });
      onEvent?.({
        type: "final-text",
        turnId: "engine-turn-recovery",
        text: "I have enough information to prepare the Draft.",
      });
      return {
        text: "I have enough information to prepare the Draft.",
        planIntakePatch: {
          eventName: "Gran Fondo Almaty",
          eventPriority: "A" as const,
          targetDate: "2026-10-04",
          goal: "Finish in the front half",
          availability: {
            sessionsPerWeek: 4,
            weekdays: ["tue" as const, "thu" as const, "sat" as const, "sun" as const],
          },
          experience: "intermediate" as const,
        },
      };
    });
    const ftp: PlanFtpAdapter = {
      read: async () => ({
        manual: { watts: 282, refreshedAtMs: 1 },
        intervalsFtp: null,
        intervalsEftp: null,
        usedSource: "manual",
        usedWatts: 282,
        conflict: false,
      }),
      saveManual: vi.fn(),
      refreshIntervals: vi.fn(),
    };
    const storedIntakes = createPlanIntakeRepository(store);
    let projectionAvailable = false;
    const interruptedIntakes: PlanIntakeRepository = {
      read: (conversationId) => storedIntakes.read(conversationId),
      save: async (record, expectedVersion) => {
        if (!projectionAvailable && expectedVersion !== null && record.sourceTurnSequence > 0) {
          throw new Error("interrupted projection");
        }
        return storedIntakes.save(record, expectedVersion);
      },
    };
    const operations = createPlanningOperations(
      { context, engine: coach, identity: authored },
      { ftp, intakes: interruptedIntakes, todayDateKey: () => 20260709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "recovery-start",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "recovery-course",
      conversationId,
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T05",
        commandId: "recovery-message",
        conversationId,
        text: "I can train four days each week.",
      }),
    ).rejects.toThrow("interrupted projection");
    await expect(storedIntakes.read(conversationId)).resolves.toMatchObject({
      sourceTurnSequence: 0,
      eventName: null,
    });

    projectionAvailable = true;
    const restored = createPlanningOperations(
      { context, engine: coach, identity: authored },
      { ftp, intakes: storedIntakes, todayDateKey: () => 20260709 },
    );
    await expect(restored.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { scenarioId: "PL-S016", data: { readyToCreateDraft: true } },
    });
    await expect(storedIntakes.read(conversationId)).resolves.toMatchObject({
      sourceTurnSequence: 1,
      eventName: "Gran Fondo Almaty",
      availabilityWeekdays: ["tue", "thu", "sat", "sun"],
    });
  });

  it("commits Plan engine history only after the turn and intake transaction succeeds", async () => {
    const coach = engine();
    coach.chat = vi.fn(async (request, onEvent) => {
      onEvent?.({ type: "turn-start", turnId: "engine-turn-atomic", chatId: request.chatId });
      return {
        text: "I have enough information to prepare the Draft.",
        planIntakePatch: {
          eventName: "Gran Fondo Almaty",
          eventPriority: "A" as const,
          targetDate: "2026-10-04",
          goal: "Finish in the front half",
          availability: {
            sessionsPerWeek: 4,
            weekdays: ["tue" as const, "thu" as const, "sat" as const, "sun" as const],
          },
          experience: "intermediate" as const,
        },
      };
    });
    coach.replacePlanChatHistory = vi.fn(async () => undefined);
    coach.commitPlanChatTurn = vi.fn(async () => undefined);
    const operations = createPlanningOperations(
      { context, engine: coach, identity: identity() },
      {
        ftp: {
          read: async () => ({
            manual: { watts: 282, refreshedAtMs: 1 },
            intervalsFtp: null,
            intervalsEftp: null,
            usedSource: "manual",
            usedWatts: 282,
            conflict: false,
          }),
          saveManual: vi.fn(),
          refreshIntervals: vi.fn(),
        },
        todayDateKey: () => 20260709,
      },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "atomic-start",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "atomic-course",
      conversationId,
    });
    await store.run(
      "CREATE TRIGGER fail_atomic_intake BEFORE UPDATE ON plan_intake WHEN NEW.source_turn_sequence > 0 BEGIN SELECT RAISE(FAIL, 'synthetic intake failure'); END",
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T05",
        commandId: "atomic-fail",
        conversationId,
        text: "I can train four days each week.",
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "provider-failed" } });
    expect(coach.commitPlanChatTurn).not.toHaveBeenCalled();
    await expect(
      createPlanConversationRepository(store).readTurns(conversationId),
    ).resolves.toEqual([]);
    await expect(createPlanIntakeRepository(store).read(conversationId)).resolves.toMatchObject({
      sourceTurnSequence: 0,
      eventName: null,
    });

    await store.run("DROP TRIGGER fail_atomic_intake");
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T05",
        commandId: "atomic-retry",
        conversationId,
        text: "I can train four days each week.",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S016", data: { readyToCreateDraft: true } },
    });
    expect(coach.commitPlanChatTurn).toHaveBeenCalledWith({
      chatId: `plan:${conversationId}`,
      turnId: "engine-turn-atomic",
    });
    await expect(
      createPlanConversationRepository(store).readTurns(conversationId),
    ).resolves.toHaveLength(1);
    await expect(createPlanIntakeRepository(store).read(conversationId)).resolves.toMatchObject({
      sourceTurnSequence: 1,
      eventName: "Gran Fondo Almaty",
    });
  });

  it("forms, revises, and discards a Draft without deleting the Plan conversation", async () => {
    const authored = identity();
    const coach = engine();
    let revision = 0;
    const builder: PlanDraftBuilder = {
      async form() {
        revision += 1;
        return {
          plan: plan(`${"0".repeat(25)}T`, 200),
          workouts: [],
          snapshot: { completeWeeks: 12, revision },
        };
      },
      async revise({ instruction }) {
        if (instruction === "Replace every ride with swimming.") {
          const error = new Error("unsupported Draft revision") as Error & {
            name: string;
            code: string;
          };
          error.name = "CyclingPlanDraftBuildError";
          error.code = "unsupported-revision";
          throw error;
        }
        revision += 1;
        return {
          plan: plan(`${"0".repeat(25)}T`, 201),
          workouts: [],
          snapshot: { completeWeeks: 12, revision },
        };
      },
      async recalculateCourse() {
        revision += 1;
        return {
          plan: plan(`${"0".repeat(25)}T`, 202),
          workouts: [],
          snapshot: { completeWeeks: 12, revision },
        };
      },
    };
    const operations = createPlanningOperations(
      { context, engine: coach, identity: authored },
      { draftBuilder: builder, isReady: () => true, todayDateKey: () => 20260709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-course-choice",
      conversationId,
    });
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-2",
      conversationId,
    });
    expect(formed).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S002", revision: 1 },
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const firstDraft = formed.state.data.draft;
    if (firstDraft === null || typeof firstDraft !== "object")
      throw new TypeError("Draft missing.");
    const draftId = String((firstDraft as { id: unknown }).id);
    const revised = await operations.executePlanTransition?.({
      transitionId: "PL-T07",
      commandId: "command-3",
      draftId,
      text: "Move Thursday endurance to Wednesday.",
    });
    expect(revised).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S031", revision: 2 },
    });
    if (revised?.status !== "completed") throw new TypeError("Draft did not revise.");
    const secondDraft = revised.state.data.draft;
    if (secondDraft === null || typeof secondDraft !== "object")
      throw new TypeError("Draft missing.");
    const secondDraftId = String((secondDraft as { id: unknown }).id);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T07",
        commandId: "command-invalid-revision",
        draftId: secondDraftId,
        text: "Replace every ride with swimming.",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "invalid-input",
        message: "The coach couldn’t apply that request. Your current Draft is unchanged.",
        retryable: false,
      },
      state: { scenarioId: "PL-S031", revision: 2 },
    });
    const discarded = await operations.executePlanTransition?.({
      transitionId: "PL-T10",
      commandId: "command-4",
      draftId: secondDraftId,
    });
    expect(discarded).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S020", projection: "coach" },
    });
    await expect(
      createPlanConversationRepository(store).readConversation(conversationId),
    ).resolves.toMatchObject({ status: "open" });
  });

  it("resolves manual and Intervals FTP sources before returning to the Plan coach", async () => {
    let snapshot: PlanFtpSnapshot = {
      manual: null,
      intervalsFtp: null,
      intervalsEftp: null,
      usedSource: null,
      usedWatts: null,
      conflict: false,
    };
    const saveManual = vi.fn(async (watts: number) => {
      snapshot = {
        ...snapshot,
        manual: { watts, refreshedAtMs: 10 },
        usedSource: "manual",
        usedWatts: watts,
      };
      return snapshot;
    });
    const refreshIntervals = vi.fn(async () => snapshot);
    const ftp: PlanFtpAdapter = { read: async () => snapshot, saveManual, refreshIntervals };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { ftp, isReady: () => true },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    expect(started).toMatchObject({ status: "completed", state: { scenarioId: "PL-S003" } });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    const saved = await operations.executePlanTransition?.({
      transitionId: "PL-T04",
      commandId: "command-2",
      conversationId,
      source: "manual",
      watts: 282,
    });
    expect(saveManual).toHaveBeenCalledWith(282);
    expect(saved).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S062",
        data: { ftp: { usedSource: "manual", usedWatts: 282 } },
      },
    });
    await operations.executePlanTransition?.({
      transitionId: "PL-T04",
      commandId: "command-3",
      conversationId,
      source: "intervals",
      watts: null,
    });
    expect(refreshIntervals).toHaveBeenCalledOnce();
  });

  it("keeps FTP refresh failures retryable and exposes source conflicts", async () => {
    let mode: "failure" | "conflict" = "failure";
    const empty: PlanFtpSnapshot = {
      manual: null,
      intervalsFtp: null,
      intervalsEftp: null,
      usedSource: null,
      usedWatts: null,
      conflict: false,
    };
    const conflict: PlanFtpSnapshot = {
      manual: { watts: 282, refreshedAtMs: 1 },
      intervalsFtp: { watts: 278, refreshedAtMs: 2 },
      intervalsEftp: { watts: 280, refreshedAtMs: 3 },
      usedSource: "manual",
      usedWatts: 282,
      conflict: true,
    };
    const ftp: PlanFtpAdapter = {
      read: async () => (mode === "conflict" ? conflict : empty),
      saveManual: async () => empty,
      refreshIntervals: async () => {
        if (mode === "failure") throw new Error("offline");
        return conflict;
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { ftp },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T04",
        commandId: "command-2",
        conversationId,
        source: "intervals",
        watts: null,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { retryable: true },
      state: { scenarioId: "PL-S059", data: { ftp: { status: "refresh-failed" } } },
    });
    mode = "conflict";
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T04",
        commandId: "command-3",
        conversationId,
        source: "intervals",
        watts: null,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S060",
        data: { ftp: { status: "conflict", usedSource: "manual", usedWatts: 282 } },
      },
    });
  });

  it("requires an explicit Race Course choice and preserves it across relaunch", async () => {
    const fullCourse = course("almaty-gran-fondo.gpx");
    const routeOnly = course("route-only.gpx", "unavailable");
    const adapter: PlanRaceCourseAdapter = {
      parse: vi.fn(async (filePath) => {
        if (filePath.endsWith("invalid.gpx")) {
          return { ok: false as const, fileName: "invalid.gpx", detail: "No route found." };
        }
        return {
          ok: true as const,
          course: filePath.endsWith("route-only.gpx") ? routeOnly : fullCourse,
        };
      }),
    };
    const readiness = { isReady: () => true, course: adapter };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      readiness,
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T06",
        commandId: "command-2",
        conversationId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T02",
        commandId: "command-3",
        conversationId,
        filePath: "/tmp/invalid.gpx",
        elevation: "require",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: { scenarioId: "PL-S065", data: { course: { status: "invalid" } } },
    });
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S065",
        data: {
          course: {
            status: "invalid",
            fileName: "invalid.gpx",
            detail: "No route found.",
          },
        },
      },
    });
    await expect(
      createPlanConversationRepository(store).readConversation(conversationId),
    ).resolves.toMatchObject({
      courseFailureJson: JSON.stringify({
        fileName: "invalid.gpx",
        detail: "No route found.",
      }),
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T02",
        commandId: "command-4",
        conversationId,
        filePath: "/tmp/route-only.gpx",
        elevation: "require",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S067",
        data: {
          course: { status: "missing-elevation", candidate: { elevationStatus: "unavailable" } },
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T02",
        commandId: "command-5",
        conversationId,
        filePath: "/tmp/route-only.gpx",
        elevation: "allow-missing",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S016",
        data: { readyToCreateDraft: true, course: { status: "ready" } },
      },
    });
    await expect(
      createPlanConversationRepository(store).readConversation(conversationId),
    ).resolves.toMatchObject({ courseChoiceStatus: "attached" });

    const restored = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      readiness,
    );
    await expect(restored.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S016",
        data: { course: { status: "ready", accepted: { fileName: "route-only.gpx" } } },
      },
    });
  });

  it("keeps a failed course-omission write visible and retryable", async () => {
    const conversations = createPlanConversationRepository(store);
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { conversations, isReady: () => true },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    vi.spyOn(conversations, "saveConversation").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T03",
        commandId: "command-2",
        conversationId,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "persistence-failed", retryable: true },
      state: { scenarioId: "PL-S104", data: { course: { status: "omission-failed" } } },
    });
    await expect(conversations.readConversation(conversationId)).resolves.toMatchObject({
      courseChoiceStatus: "undecided",
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T03",
        commandId: "command-3",
        conversationId,
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S016" } });
  });

  it("recalculates a Draft atomically and rejects Course edits after activation", async () => {
    const firstCourse = course("almaty-gran-fondo.gpx");
    const secondCourse = course("replacement.gpx");
    const adapter: PlanRaceCourseAdapter = {
      parse: vi.fn(async (filePath) => ({
        ok: true as const,
        course: filePath.endsWith("replacement.gpx") ? secondCourse : firstCourse,
      })),
    };
    let buildRevision = 0;
    let failRecalculation = false;
    const builder: PlanDraftBuilder = {
      async form() {
        buildRevision += 1;
        return {
          plan: plan(`${"0".repeat(25)}V`, 300),
          workouts: [],
          snapshot: { completeWeeks: 12, buildRevision },
        };
      },
      async revise() {
        throw new TypeError("not used");
      },
      async recalculateCourse() {
        if (failRecalculation) throw new Error("builder unavailable");
        buildRevision += 1;
        return {
          plan: plan(`${"0".repeat(25)}V`, 301),
          workouts: [],
          snapshot: { completeWeeks: 12, buildRevision },
        };
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        course: adapter,
        draftBuilder: builder,
        isReady: () => true,
        todayDateKey: () => 20260709,
      },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-2",
      conversationId,
    });
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-3",
      conversationId,
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const draftId = String((formed.state.data.draft as { id: string }).id);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T09",
        commandId: "command-4",
        draftId,
        course: { action: "attach", filePath: "/tmp/almaty-gran-fondo.gpx", elevation: "require" },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S070",
        revision: 2,
        data: { course: { status: "ready", accepted: { fileName: "almaty-gran-fondo.gpx" } } },
      },
    });
    const latest =
      await createPlanConversationRepository(store).readLatestDraftRevision(conversationId);
    expect(latest).toMatchObject({ revision: 2 });
    expect(latest?.raceCourseJson).toContain("almaty-gran-fondo.gpx");

    failRecalculation = true;
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T09",
        commandId: "command-5",
        draftId: String(latest?.id),
        course: { action: "attach", filePath: "/tmp/replacement.gpx", elevation: "require" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: {
        scenarioId: "PL-S069",
        revision: 2,
        data: {
          course: {
            status: "recalculation-failed",
            accepted: { fileName: "almaty-gran-fondo.gpx" },
            candidate: { fileName: "replacement.gpx" },
          },
        },
      },
    });
    await expect(
      createPlanConversationRepository(store).readLatestDraftRevision(conversationId),
    ).resolves.toMatchObject({ revision: 2, raceCourseJson: latest?.raceCourseJson });

    await createPlanRepository(store).replace(
      { ...plan(`${"0".repeat(25)}V`, 302), status: "active" },
      [],
    );
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T09",
        commandId: "command-6",
        draftId: String(latest?.id),
        course: { action: "remove" },
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unavailable" } });
  });

  it("recalculates a valid start date and keeps the previous Draft on invalid or failed dates", async () => {
    let failDateRecalculation = false;
    const builder: PlanDraftBuilder = {
      async form() {
        return {
          plan: plan(`${"0".repeat(25)}W`, 400),
          workouts: [],
          snapshot: { startDate: "2026-07-09" },
        };
      },
      async revise() {
        throw new TypeError("not used");
      },
      async recalculateCourse() {
        throw new TypeError("not used");
      },
      async recalculateStartDate({ preview }) {
        if (failDateRecalculation) throw new Error("generation failed");
        const current = plan(`${"0".repeat(25)}W`, 401);
        return {
          plan: {
            ...current,
            startDateKey: preview.startDateKey,
            targetDateKey: preview.targetDateKey,
            kind: preview.kind,
            totalWeeks: preview.totalWeeks,
            weekStartDay: preview.weekStartDay,
          },
          workouts: [],
          snapshot: { startDate: preview.startDateKey },
        };
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { draftBuilder: builder, isReady: () => true, todayDateKey: () => 20260709 },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-2",
      conversationId,
    });
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-3",
      conversationId,
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const firstDraftId = String((formed.state.data.draft as { id: string }).id);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T08",
        commandId: "command-4",
        draftId: firstDraftId,
        startDate: "2026-07-08",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid-input" },
      state: {
        scenarioId: "PL-S046",
        revision: 1,
        data: { startDate: { status: "invalid", selectedDate: "2026-07-08" } },
      },
    });

    const recalculated = await operations.executePlanTransition?.({
      transitionId: "PL-T08",
      commandId: "command-5",
      draftId: firstDraftId,
      startDate: "2026-07-20",
    });
    expect(recalculated).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S050",
        revision: 2,
        data: {
          plan: {
            startDate: "2026-07-20",
            kind: "short-race-preparation",
            totalWeeks: 11,
          },
          startDate: { status: "updated", selectedDate: "2026-07-20" },
        },
      },
    });
    if (recalculated?.status !== "completed") throw new TypeError("Draft did not recalculate.");
    const secondDraftId = String((recalculated.state.data.draft as { id: string }).id);

    failDateRecalculation = true;
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T08",
        commandId: "command-6",
        draftId: secondDraftId,
        startDate: "2026-07-21",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "provider-failed", retryable: true },
      state: {
        scenarioId: "PL-S048",
        revision: 2,
        data: { startDate: { status: "failed", selectedDate: "2026-07-21" } },
      },
    });
    await expect(createPlanRepository(store).read(`${"0".repeat(25)}W`)).resolves.toMatchObject({
      startDateKey: 20260720,
      kind: "short_race_preparation",
    });
    await expect(
      createPlanConversationRepository(store).readLatestDraftRevision(conversationId),
    ).resolves.toMatchObject({ revision: 2 });
  });

  it("activates locally before an idempotent seven-day Intervals reconciliation", async () => {
    const events: Array<{
      id: number;
      dateKey: number;
      externalId: string | null;
      name: string;
      durationS: number | null;
      description: string | null;
      workoutDoc: Readonly<Record<string, unknown>> | null;
    }> = [];
    let createFailures = 1;
    const calendar: PlanMirrorCalendarPort = {
      async listEvents({ startDateKey, endDateKey }) {
        return events.filter(
          (event) => event.dateKey >= startDateKey && event.dateKey <= endDateKey,
        );
      },
      async createEvent(value) {
        if (createFailures > 0) {
          createFailures -= 1;
          throw new Error("provider failed");
        }
        const structure = JSON.parse(value.structureJson) as Record<string, unknown>;
        events.push({
          id: events.length + 1,
          dateKey: value.dateKey,
          externalId: value.externalId,
          name: value.name,
          durationS: value.durationS,
          description: typeof structure.description === "string" ? structure.description : null,
          workoutDoc:
            structure.workoutDoc !== null &&
            typeof structure.workoutDoc === "object" &&
            !Array.isArray(structure.workoutDoc)
              ? (structure.workoutDoc as Readonly<Record<string, unknown>>)
              : null,
        });
      },
      async updateEvent(value) {
        const event = events.find((candidate) => candidate.id === value.eventId);
        if (event === undefined) throw new Error("missing event");
        event.dateKey = value.dateKey;
        event.name = value.name;
        event.durationS = value.durationS;
      },
      async deleteEvent({ eventId }) {
        const index = events.findIndex((event) => event.id === eventId);
        if (index >= 0) events.splice(index, 1);
      },
    };
    const authored = identity();
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      {
        draftBuilder: activationBuilder(),
        isReady: () => true,
        todayDateKey: () => 20260709,
        calendar,
      },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-2",
      conversationId,
    });
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-3",
      conversationId,
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const draft = formed.state.data.draft as { id: string; revision: number };

    const activated = await operations.executePlanTransition?.({
      transitionId: "PL-T11",
      commandId: "command-4",
      draftId: draft.id,
      expectedRevision: draft.revision,
    });
    expect(activated).toMatchObject({
      status: "completed",
      state: {
        lifecycle: "active",
        projection: "active",
        scenarioId: "PL-S037",
        reconciliation: { status: "not-started" },
      },
    });
    await expect(createPlanRepository(store).read(`${"0".repeat(25)}W`)).resolves.toMatchObject({
      status: "active",
    });
    await expect(
      createPlanConversationRepository(store).readDraftRevision(draft.id),
    ).resolves.toMatchObject({ status: "approved" });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T12",
        commandId: "command-5",
        planId: `${"0".repeat(25)}W`,
        mode: "reconcile",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: {
        lifecycle: "active",
        scenarioId: "PL-S039",
        attention: { count: 1, destination: "direct" },
      },
    });
    const reconciled = await operations.executePlanTransition?.({
      transitionId: "PL-T12",
      commandId: "command-6",
      planId: `${"0".repeat(25)}W`,
      mode: "reconcile",
    });
    expect(reconciled).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S043",
        reconciliation: { status: "verified", created: 2, total: 2 },
        attention: { count: 0 },
      },
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.dateKey).sort()).toEqual([20260709, 20260715]);

    const restored = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { todayDateKey: () => 20260709, calendar },
    );
    await expect(restored.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { scenarioId: "PL-S004", lifecycle: "active" },
    });
  });

  it("opens a WorkoutMatch decision and persists athlete confirmation without Intervals mutation", async () => {
    const authored = identity();
    const activePlan = plan(`${"0".repeat(25)}W`, 40);
    const workouts = await activationBuilder()
      .form({} as never)
      .then((build) => build.workouts);
    await createPlanRepository(store).replace({ ...activePlan, status: "active" }, workouts);
    const activityId = "a".repeat(64);
    const matchId = `${"0".repeat(25)}V`;
    const matchRepository = createPlanWorkoutMatchRepository(store);
    await matchRepository.observe({
      id: matchId,
      planId: activePlan.id,
      planWorkoutId: workouts[0]!.id,
      activityId,
      providerActivityId: "i123",
      providerEventId: null,
      source: "heuristic",
      decision: "suggested",
      activityDateKey: workouts[0]!.dateKey,
      activitySport: "cycling",
      activityDurationS: workouts[0]!.durationS,
      observedAtMs: 90,
      decidedAtMs: null,
      deviceId: "device-1",
      hlcPhysicalMs: 90,
      hlcCounter: 0,
    });
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { todayDateKey: () => 20260709 },
    );
    const initial = await operations.getPlanState?.({});
    expect(initial).toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S037",
        attention: { count: 1, destination: "direct" },
      },
    });
    if (initial?.status !== "ready") throw new TypeError("Active Plan missing.");
    expect(initial.state.data.workouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workouts[0]!.id,
          match: expect.objectContaining({
            status: "decision-needed",
            requiresConfirmation: true,
          }),
        }),
      ]),
    );
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T33",
        commandId: "command-attention",
        planId: activePlan.id,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S021", data: { selectedWorkoutId: workouts[0]!.id } },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T13",
        commandId: "command-open",
        planId: activePlan.id,
        workoutId: workouts[0]!.id,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S021", data: { selectedWorkoutId: workouts[0]!.id } },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-close-workout",
        action: "back",
        sourceScenarioId: "PL-S021",
        destinationScenarioId: "PL-S004",
        returnFocusId: `workout-row-${workouts[0]!.id}`,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S004",
        data: {
          selectedWorkoutId: null,
          returnFocusId: `workout-row-${workouts[0]!.id}`,
        },
      },
    });
    const confirmed = await operations.executePlanTransition?.({
      transitionId: "PL-T14",
      commandId: "command-confirm",
      planId: activePlan.id,
      workoutId: workouts[0]!.id,
      activityId,
      decision: "confirm",
    });
    expect(confirmed).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S004",
        attention: { count: 0 },
      },
    });
    if (confirmed?.status !== "completed") throw new TypeError("Match was not confirmed.");
    expect(confirmed.state.data.workouts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: workouts[0]!.id,
          match: expect.objectContaining({ status: "as-planned" }),
        }),
      ]),
    );
    await expect(matchRepository.readForWorkout(workouts[0]!.id)).resolves.toEqual([
      expect.objectContaining({ decision: "confirmed" }),
    ]);
  });

  it("returns a WorkoutMatch opened from the attention list to its exact item", async () => {
    const authored = identity();
    const activePlan = plan(`${"0".repeat(25)}W`, 40);
    const workouts = await activationBuilder()
      .form({} as never)
      .then((build) => build.workouts);
    await createPlanRepository(store).replace({ ...activePlan, status: "active" }, workouts);
    const matchRepository = createPlanWorkoutMatchRepository(store);
    for (const [index, workout] of workouts.slice(0, 2).entries()) {
      await matchRepository.observe({
        id: `${"0".repeat(25)}${index + 1}`,
        planId: activePlan.id,
        planWorkoutId: workout.id,
        activityId: `${String.fromCharCode(97 + index)}`.repeat(64),
        providerActivityId: `provider-${index + 1}`,
        providerEventId: null,
        source: "heuristic",
        decision: "suggested",
        activityDateKey: workout.dateKey,
        activitySport: "cycling",
        activityDurationS: workout.durationS,
        observedAtMs: 90 + index,
        decidedAtMs: null,
        deviceId: "device-1",
        hlcPhysicalMs: 90 + index,
        hlcCounter: 0,
      });
    }
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { todayDateKey: () => 20260709 },
    );

    const attention = await operations.executePlanTransition?.({
      transitionId: "PL-T33",
      commandId: "command-attention-list",
      planId: activePlan.id,
    });
    expect(attention).toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S028", attention: { count: 2, destination: "list" } },
    });

    const opened = await operations.executePlanTransition?.({
      transitionId: "PL-T34",
      commandId: "command-open-attention-item",
      attentionId: `workout-match:${workouts[0]!.id}`,
    });
    expect(opened).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S021",
        data: {
          selectedWorkoutId: workouts[0]!.id,
          selectedWorkoutSourceScenarioId: "PL-S028",
        },
      },
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-close-attention-item",
        action: "back",
        sourceScenarioId: "PL-S021",
        destinationScenarioId: "PL-S028",
        returnFocusId: `plan-attention-workout-match:${workouts[0]!.id}`,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S028",
        data: { returnFocusId: `plan-attention-workout-match:${workouts[0]!.id}` },
      },
    });
  });

  it("surfaces an outside Intervals edit and adopts it only after athlete confirmation", async () => {
    const authored = identity();
    const activePlan = plan(`${"0".repeat(25)}W`, 40);
    const workouts = await activationBuilder()
      .form({} as never)
      .then((build) => build.workouts);
    const target = workouts[0]!;
    await createPlanRepository(store).replace({ ...activePlan, status: "active" }, workouts);
    const providerEvent = {
      id: 42,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(activePlan.id, target.id),
      category: "WORKOUT",
      name: target.name,
      durationS: 3_300,
      description: "Shortened in Intervals",
      workoutDoc: null,
      updated: "2026-07-09T10:00:00Z",
    } as const;
    const updateEvent = vi.fn();
    const calendar: PlanMirrorCalendarPort = {
      listEvents: vi.fn(async () => [providerEvent]),
      createEvent: vi.fn(),
      deleteEvent: vi.fn(),
      readEvent: vi.fn(async () => providerEvent),
      updateEvent,
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { todayDateKey: () => target.dateKey, workoutDriftCalendar: calendar },
    );

    const initial = await operations.getPlanState?.({});
    expect(initial).toMatchObject({
      status: "ready",
      state: {
        attention: { count: 1, destination: "direct" },
        data: {
          workouts: expect.arrayContaining([
            expect.objectContaining({
              id: target.id,
              drift: expect.objectContaining({
                eventId: "42",
                provider: expect.objectContaining({ durationS: 3_300 }),
              }),
            }),
          ]),
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T33",
        commandId: "command-attention",
        planId: activePlan.id,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S032", data: { selectedWorkoutId: target.id } },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T15",
        commandId: "command-adopt",
        planId: activePlan.id,
        workoutId: target.id,
        eventId: "42",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S034", attention: { count: 0 } },
    });
    expect(updateEvent).not.toHaveBeenCalled();
    await expect(createPlanRepository(store).readWorkouts(activePlan.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: target.id, durationS: 3_300 })]),
    );
  });

  it("hydrates an interrupted reconciliation as crash-resume work without attention", async () => {
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        draftBuilder: activationBuilder(),
        isReady: () => true,
        todayDateKey: () => 20260709,
        calendar: {
          listEvents: async () => [],
          createEvent: async () => {},
          updateEvent: async () => {},
          deleteEvent: async () => {},
        },
      },
    );
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);
    await operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "command-2",
      conversationId,
    });
    const formed = await operations.executePlanTransition?.({
      transitionId: "PL-T06",
      commandId: "command-3",
      conversationId,
    });
    if (formed?.status !== "completed") throw new TypeError("Draft did not form.");
    const draft = formed.state.data.draft as { id: string; revision: number };
    await operations.executePlanTransition?.({
      transitionId: "PL-T11",
      commandId: "command-4",
      draftId: draft.id,
      expectedRevision: draft.revision,
    });
    const repository = createPlanReconciliationRepository(store);
    const job = await repository.readLatestJob(`${"0".repeat(25)}W`, "mirror");
    if (job === undefined) throw new TypeError("Reconciliation job missing.");
    await repository.beginAttempt(job.id, job.updatedAtMs + 1);

    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        scenarioId: "PL-S042",
        reconciliation: { status: "running" },
        attention: { count: 0 },
      },
    });
  });

  it("retries an interrupted Plan queue claim and persists the recovered turn", async () => {
    const recoveredQueue = {
      schemaVersion: 1 as const,
      revision: 2,
      items: [
        {
          queuedMessageId: "queued-1",
          submissionId: "submission-1",
          text: "Keep Sunday free.",
          kind: "ordinary" as const,
          position: 0,
          restored: true,
        },
      ],
      retryRequired: {
        claimId: "claim-1",
        queuedMessageIds: ["queued-1"],
        turnId: "turn-1",
        status: "retry-required" as const,
      },
    };
    const retryQueuedTurn = vi.fn(
      async (
        _request: { readonly chatId: string; readonly claimId: string },
        onEvent?: (event: TurnEvent) => void,
      ) => {
        onEvent?.({
          type: "turn-start",
          turnId: "turn-recovered",
          chatId: `plan:${"0".repeat(25)}1`,
        });
        onEvent?.({ type: "final-text", turnId: "turn-recovered", text: "Sunday stays free." });
        return { snapshot: EMPTY_QUEUE, response: { text: "Sunday stays free." } };
      },
    );
    const coach = {
      ...engine(),
      getChatQueue: vi
        .fn()
        .mockResolvedValueOnce(EMPTY_QUEUE)
        .mockResolvedValueOnce(recoveredQueue)
        .mockResolvedValue(EMPTY_QUEUE),
      retryQueuedTurn,
    } as unknown as CoachEngine;
    const operations = createPlanningOperations({ context, engine: coach, identity: identity() });
    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T01",
      commandId: "command-1",
      sourceConversationId: null,
    });
    if (started?.status !== "completed") throw new TypeError("Plan conversation did not start.");
    const conversationId = String(started.state.data.conversationId);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T05",
        commandId: "command-2",
        conversationId,
        text: "Keep Sunday free.",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(retryQueuedTurn).toHaveBeenCalledWith(
      { chatId: `plan:${conversationId}`, claimId: "claim-1" },
      expect.any(Function),
    );
    await expect(
      createPlanConversationRepository(store).readTurns(conversationId),
    ).resolves.toMatchObject([
      { athleteText: "Keep Sunday free.", coachText: "Sunday stays free." },
    ]);
  });

  it("routes a structured Proposal through review, provenance, revision, and approval", async () => {
    const planId = `${"0".repeat(25)}P`;
    const workoutId = `${"0".repeat(25)}Q`;
    const proposalId = `${"0".repeat(25)}R`;
    const premiseId = `${"0".repeat(25)}S`;
    const proposalReturn = {
      sourceScenarioId: "PL-S010" as const,
      returnFocusId: `workout-row-${workoutId}`,
    };
    const activePlan: PlanRecord = {
      ...plan(planId, 10),
      status: "active",
      updatedAtMs: 10,
      hlcPhysicalMs: 10,
    };
    const workout: PlanWorkoutRecord = {
      id: workoutId,
      planId,
      dateKey: 20260830,
      sport: "cycling",
      name: "Endurance",
      durationS: 5_400,
      structureJson: "{}",
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    };
    const plans = createPlanRepository(store);
    const proposals = createPlanProposalRepository(store);
    let forceCompareAndSwapRace = true;
    let failLoadCalculation = false;
    let premiseReadCount = 0;
    await plans.replace(activePlan, [workout]);
    await proposals.save(
      {
        id: proposalId,
        planId,
        parentProposalId: null,
        revision: 1,
        status: "proposed",
        title: "Sunday recovery",
        rationale: "Saturday fatigue is 12 above your normal range.",
        confidence: "High",
        mutationJson: encodePlanProposalMutation({
          schemaVersion: 1,
          changes: [
            {
              workoutId,
              before: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: workout.name,
                durationS: workout.durationS,
                structureJson: workout.structureJson,
              },
              after: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: "Recovery",
                durationS: 1_800,
                structureJson: workout.structureJson,
              },
            },
          ],
          weekLoad: { before: 420, after: 360 },
        }),
        baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(activePlan, [workout])),
        refusalReason: null,
        createdAtMs: 20,
        updatedAtMs: 20,
        resolvedAtMs: null,
        deviceId: "device-1",
        hlcPhysicalMs: 20,
        hlcCounter: 0,
      },
      [
        {
          id: premiseId,
          proposalId,
          sourceType: "activity",
          sourceId: "ride-21-aug",
          sourceLabel: "Saturday ride · 21 Aug · Assioma pedals",
          sourceDateKey: 20260821,
          confidence: "High",
          snapshotJson: '{"loadAboveNormal":12}',
          createdAtMs: 20,
          deviceId: "device-1",
          hlcPhysicalMs: 20,
          hlcCounter: 0,
        },
      ],
    );
    const invalidProposalId = `${"0".repeat(25)}V`;
    await store.run(
      `INSERT INTO plan_proposal (
        id, plan_id, parent_proposal_id, revision, status, title, rationale, confidence,
        mutation_json, base_snapshot_json, refusal_reason, created_at_ms, updated_at_ms,
        resolved_at_ms, device_id, hlc_physical_ms, hlc_counter
      ) VALUES (?, ?, NULL, 1, 'proposed', ?, ?, 'Low', ?, ?, NULL, 21, 21, NULL, 'device-1', 21, 0)`,
      [
        invalidProposalId,
        planId,
        "Unsafe free-text change",
        "This record simulates an unsupported persisted mutation.",
        '{"freeText":"change whatever is needed"}',
        encodePlanProposalBase(capturePlanProposalBase(activePlan, [workout])),
      ],
    );
    const readOnlyOperations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, proposals, todayDateKey: () => 20260826 },
    );
    const readOnlyOpen = await readOnlyOperations.executePlanTransition?.({
      transitionId: "PL-T17",
      commandId: "command-proposal-open-without-capabilities",
      planId,
      proposalId,
      selectedProposalReturn: proposalReturn,
    });
    expect(readOnlyOpen).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S007",
        data: {
          selectedProposalId: proposalId,
          selectedProposalReturn: proposalReturn,
          proposals: [{ id: proposalId, error: { code: "unavailable" } }],
        },
      },
    });
    if (readOnlyOpen?.status !== "completed") {
      throw new TypeError("Read-only Proposal did not open.");
    }
    expect(readOnlyOpen.state.transitions.map((transition) => transition.transitionId)).toEqual(
      expect.arrayContaining(["PL-T17", "PL-T20"]),
    );
    expect(readOnlyOpen.state.transitions.map((transition) => transition.transitionId)).not.toEqual(
      expect.arrayContaining(["PL-T18", "PL-T19"]),
    );
    await expect(proposals.read(proposalId)).resolves.toMatchObject({ status: "proposed" });
    await expect(proposals.read(invalidProposalId)).resolves.toMatchObject({ status: "refused" });
    const reviseWithoutLoadCalculation = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        proposals,
        todayDateKey: () => 20260826,
        proposalReviser: {
          revise: vi.fn(() => {
            throw new Error("Proposal revision must not start without load calculation.");
          }),
        },
      },
    );
    await expect(
      reviseWithoutLoadCalculation.executePlanTransition?.({
        transitionId: "PL-T18",
        commandId: "command-proposal-revise-without-load-calculation",
        proposalId,
        text: "Keep 45 minutes.",
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unavailable" } });
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        proposals,
        todayDateKey: () => 20260826,
        proposalLoadCalculator: (workouts) => {
          if (failLoadCalculation) throw new Error("load calculator unavailable");
          const duration = workouts.find((candidate) => candidate.id === workoutId)?.durationS;
          if (duration === 5_400) return 420;
          if (duration === 1_800) return 360;
          if (duration === 2_700) return 375;
          return 0;
        },
        proposalPremiseReader: {
          async read() {
            premiseReadCount += 1;
            if (forceCompareAndSwapRace) {
              forceCompareAndSwapRace = false;
              await plans.replace({ ...activePlan, updatedAtMs: 11, hlcPhysicalMs: 11 }, [workout]);
            }
            return premiseReadCount === 1 ? '{"loadAboveNormal":12}' : '{"loadAboveNormal":13}';
          },
        },
        proposalReviser: {
          async revise(input) {
            expect(input.plan).toMatchObject({ updatedAtMs: 11, hlcPhysicalMs: 11 });
            expect(input.premises).toEqual([
              expect.objectContaining({ snapshotJson: '{"loadAboveNormal":13}' }),
            ]);
            return {
              title: "Sunday recovery · revised",
              rationale: "Keep more easy volume while protecting recovery.",
              confidence: "High",
              mutation: {
                schemaVersion: 1,
                changes: [
                  {
                    workoutId,
                    before: {
                      dateKey: workout.dateKey,
                      sport: workout.sport,
                      name: workout.name,
                      durationS: workout.durationS,
                      structureJson: workout.structureJson,
                    },
                    after: {
                      dateKey: workout.dateKey,
                      sport: workout.sport,
                      name: "Recovery",
                      durationS: 2_700,
                      structureJson: workout.structureJson,
                    },
                  },
                ],
                weekLoad: { before: 420, after: 375 },
              },
              premises: [
                {
                  sourceType: "activity",
                  sourceId: "ride-21-aug",
                  sourceLabel: "Saturday ride · 21 Aug · Assioma pedals",
                  sourceDateKey: 20260821,
                  confidence: "High",
                  snapshotJson: '{"loadAboveNormal":13}',
                },
              ],
            };
          },
        },
      },
    );
    const insertMalformedProposal = async (id: string, timestamp: number): Promise<void> => {
      await store.run(
        `INSERT INTO plan_proposal (
          id, plan_id, parent_proposal_id, revision, status, title, rationale, confidence,
          mutation_json, base_snapshot_json, refusal_reason, created_at_ms, updated_at_ms,
          resolved_at_ms, device_id, hlc_physical_ms, hlc_counter
        ) VALUES (?, ?, NULL, 1, 'proposed', 'Malformed Proposal', 'Imported malformed data.',
          'Low', ?, ?, NULL, ?, ?, NULL, 'device-1', ?, 0)`,
        [
          id,
          planId,
          '{"freeText":"unsupported"}',
          encodePlanProposalBase(capturePlanProposalBase(activePlan, [workout])),
          timestamp,
          timestamp,
          timestamp,
        ],
      );
    };
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T17",
        commandId: "command-proposal-unsafe-return",
        planId,
        proposalId,
        selectedProposalReturn: {
          sourceScenarioId: "PL-S009",
          returnFocusId: proposalReturn.returnFocusId,
        },
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unavailable" } });
    const localActiveReturn = {
      sourceScenarioId: "PL-S037" as const,
      returnFocusId: `workout-row-${workoutId}`,
    };
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T17",
        commandId: "command-proposal-local-active-return",
        planId,
        proposalId,
        selectedProposalReturn: localActiveReturn,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { data: { selectedProposalReturn: localActiveReturn } },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-proposal-local-active-back",
        action: "back",
        sourceScenarioId: "PL-S007",
        destinationScenarioId: "PL-S037",
        returnFocusId: localActiveReturn.returnFocusId,
        selectedProposalReturn: localActiveReturn,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S037", data: { returnFocusId: localActiveReturn.returnFocusId } },
    });
    const invalidReviseId = `${"0".repeat(25)}W`;
    await insertMalformedProposal(invalidReviseId, 22);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T18",
        commandId: "command-malformed-proposal-revise",
        proposalId: invalidReviseId,
        text: "Change it.",
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S097" } });
    await expect(proposals.read(invalidReviseId)).resolves.toMatchObject({ status: "refused" });

    const invalidApproveId = `${"0".repeat(25)}X`;
    await insertMalformedProposal(invalidApproveId, 23);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T19",
        commandId: "command-malformed-proposal-approve",
        proposalId: invalidApproveId,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S097" } });
    await expect(proposals.read(invalidApproveId)).resolves.toMatchObject({ status: "refused" });
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        attention: { count: 1, destination: "direct" },
        data: {
          proposals: [
            {
              id: proposalId,
              diff: [
                { label: "Duration", before: "1:30", after: "0:30" },
                { label: "Workout", before: "Endurance", after: "Recovery" },
                { label: "Week load", before: "420", after: "360" },
              ],
              premises: [{ sourceLabel: "Saturday ride · 21 Aug · Assioma pedals" }],
            },
          ],
        },
      },
    });
    await expect(proposals.read(invalidProposalId)).resolves.toMatchObject({
      status: "refused",
      refusalReason: "This Proposal could not be applied safely. The active Plan is unchanged.",
    });
    failLoadCalculation = true;
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        data: {
          proposals: [{ id: proposalId, error: { code: "unavailable", retryable: true } }],
        },
      },
    });
    await expect(proposals.read(proposalId)).resolves.toMatchObject({ status: "proposed" });
    failLoadCalculation = false;
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T17",
        commandId: "command-proposal-open",
        planId,
        proposalId,
        selectedProposalReturn: proposalReturn,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S007",
        data: { selectedProposalId: proposalId, selectedProposalReturn: proposalReturn },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-proposal-missing-return",
        action: "back",
        sourceScenarioId: "PL-S007",
        destinationScenarioId: "PL-S010",
        returnFocusId: proposalReturn.returnFocusId,
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unavailable" } });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-proposal-forged-destination",
        action: "back",
        sourceScenarioId: "PL-S007",
        destinationScenarioId: "PL-S004",
        returnFocusId: proposalReturn.returnFocusId,
        selectedProposalReturn: proposalReturn,
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unavailable" } });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-proposal-return",
        action: "back",
        sourceScenarioId: "PL-S007",
        destinationScenarioId: "PL-S010",
        returnFocusId: proposalReturn.returnFocusId,
        selectedProposalReturn: proposalReturn,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S010",
        data: { returnFocusId: proposalReturn.returnFocusId },
      },
    });
    const staleResult = await operations.executePlanTransition?.({
      transitionId: "PL-T19",
      commandId: "command-proposal-stale-race",
      proposalId,
      expectedRevision: 1,
      selectedProposalReturn: proposalReturn,
    });
    expect(staleResult).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S025",
        data: {
          selectedProposalReturn: proposalReturn,
          proposals: [{ revision: 2, stale: false }],
        },
      },
    });
    const revalidated = (await proposals.readOpenForPlan(planId))[0];
    if (revalidated === undefined) throw new TypeError("Revalidated Proposal missing.");
    expect(staleResult).toMatchObject({
      state: { data: { selectedProposalId: revalidated.id } },
    });
    const revisedResult = await operations.executePlanTransition?.({
      transitionId: "PL-T18",
      commandId: "command-proposal-revise",
      proposalId: revalidated.id,
      text: "Keep 45 minutes and make it recovery.",
      selectedProposalReturn: proposalReturn,
    });
    expect(revisedResult).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S023",
        data: {
          selectedProposalReturn: proposalReturn,
          proposals: [
            {
              revision: 3,
              title: "Sunday recovery · revised",
              diff: [
                { label: "Duration", before: "1:30", after: "0:45" },
                { label: "Workout", before: "Endurance", after: "Recovery" },
                { label: "Week load", before: "420", after: "375" },
              ],
            },
          ],
        },
      },
    });
    const revised = (await proposals.readOpenForPlan(planId))[0];
    if (revised === undefined) throw new TypeError("Revised Proposal missing.");
    await expect(proposals.read(proposalId)).resolves.toMatchObject({ status: "superseded" });
    await expect(proposals.read(revalidated.id)).resolves.toMatchObject({ status: "superseded" });
    const appliedResult = await operations.executePlanTransition?.({
      transitionId: "PL-T19",
      commandId: "command-proposal-approve",
      proposalId: revised.id,
      expectedRevision: 3,
      selectedProposalReturn: proposalReturn,
    });
    expect(appliedResult).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S008",
        data: {
          selectedProposalReturn: proposalReturn,
          history: [
            expect.objectContaining({
              kind: "proposal-applied",
              undoStatus: "eligible",
              before: expect.objectContaining({ name: "Endurance", durationS: 5_400 }),
              after: expect.objectContaining({ name: "Recovery", durationS: 2_700 }),
              weekLoadBefore: 420,
              weekLoadAfter: 375,
            }),
            expect.objectContaining({ kind: "activation", undoStatus: "none" }),
          ],
        },
      },
    });
    if (appliedResult?.status !== "completed") {
      throw new TypeError("Proposal application did not complete.");
    }
    const ledgerId = String(appliedResult.state.data.selectedHistoryId);
    await expect(plans.readWorkouts(planId)).resolves.toEqual([
      expect.objectContaining({ name: "Recovery", durationS: 2_700 }),
    ]);
    await expect(proposals.read(revised.id)).resolves.toMatchObject({ status: "applied" });
    await expect(
      createPlanReconciliationRepository(store).readLatestJob(planId, "mirror"),
    ).resolves.toMatchObject({ status: "pending" });
    const rejectedProposalId = `${"0".repeat(25)}Y`;
    await proposals.save(
      {
        id: rejectedProposalId,
        planId,
        parentProposalId: null,
        revision: 1,
        status: "proposed",
        title: "Skip Sunday",
        rationale: "Protect recovery.",
        confidence: "High",
        mutationJson: encodePlanProposalMutation({
          schemaVersion: 1,
          changes: [
            {
              workoutId,
              before: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: "Recovery",
                durationS: 2_700,
                structureJson: workout.structureJson,
              },
              after: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: "Rest",
                durationS: 1_800,
                structureJson: workout.structureJson,
              },
            },
          ],
          weekLoad: null,
        }),
        baseSnapshotJson: encodePlanProposalBase(
          capturePlanProposalBase({ ...activePlan, updatedAtMs: 11, hlcPhysicalMs: 11 }, [
            { ...workout, name: "Recovery", durationS: 2_700 },
          ]),
        ),
        refusalReason: null,
        createdAtMs: 30,
        updatedAtMs: 30,
        resolvedAtMs: null,
        deviceId: "device-1",
        hlcPhysicalMs: 30,
        hlcCounter: 0,
      },
      [
        {
          id: `${"0".repeat(25)}Z`,
          proposalId: rejectedProposalId,
          sourceType: "wellness",
          sourceId: "wellness-reject",
          sourceLabel: "Current recovery",
          sourceDateKey: 20260829,
          confidence: "High",
          snapshotJson: "{}",
          createdAtMs: 30,
          deviceId: "device-1",
          hlcPhysicalMs: 30,
          hlcCounter: 0,
        },
      ],
    );
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T20",
        commandId: "command-proposal-reject",
        proposalId: rejectedProposalId,
        selectedProposalReturn: proposalReturn,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S097",
        data: { selectedProposalReturn: proposalReturn },
      },
    });
    await expect(proposals.read(rejectedProposalId)).resolves.toMatchObject({
      status: "rejected",
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T17",
        commandId: "command-proposal-open-after-apply",
        planId,
        proposalId: revised.id,
      }),
    ).resolves.toMatchObject({ status: "rejected" });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-history-open",
        action: "open",
        sourceScenarioId: "PL-S008",
        destinationScenarioId: "PL-S005",
        returnFocusId: planId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S005", data: { history: expect.any(Array) } },
    });
    const undoneResult = await operations.executePlanTransition?.({
      transitionId: "PL-T21",
      commandId: "command-history-undo",
      planId,
      ledgerId,
    });
    expect(undoneResult).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S027",
        data: {
          history: expect.arrayContaining([
            expect.objectContaining({ kind: "undo", undoStatus: "undone" }),
            expect.objectContaining({
              id: ledgerId,
              kind: "proposal-applied",
              undoStatus: "undone",
            }),
          ]),
        },
      },
    });
    await expect(plans.readWorkouts(planId)).resolves.toEqual([
      expect.objectContaining({ name: "Endurance", durationS: 5_400 }),
    ]);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T21",
        commandId: "command-history-undo-again",
        planId,
        ledgerId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S026",
        data: {
          selectedHistoryId: ledgerId,
          history: expect.arrayContaining([
            expect.objectContaining({ id: ledgerId, undoStatus: "undone" }),
          ]),
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-history-back-after-expiry",
        action: "open",
        sourceScenarioId: "PL-S026",
        destinationScenarioId: "PL-S005",
        returnFocusId: ledgerId,
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S005" } });
  });

  it("projects and undoes a reviewed Workout addition through Plan operations", async () => {
    const planId = `${"0".repeat(25)}A`;
    const existingWorkoutId = `${"0".repeat(25)}B`;
    const addedWorkoutId = `${"0".repeat(25)}C`;
    const proposalId = `${"0".repeat(25)}D`;
    const activePlan: PlanRecord = {
      ...plan(planId, 10),
      status: "active",
      updatedAtMs: 10,
      hlcPhysicalMs: 10,
    };
    const existingWorkout: PlanWorkoutRecord = {
      id: existingWorkoutId,
      planId,
      dateKey: 20260830,
      sport: "cycling",
      name: "Endurance",
      durationS: 5_400,
      structureJson: "{}",
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    };
    const plans = createPlanRepository(store);
    const proposals = createPlanProposalRepository(store);
    const requests = createPlanningRequestRepository(store, createNodeCrypto());
    await plans.replace(activePlan, [existingWorkout]);
    await proposals.save(
      {
        id: proposalId,
        planId,
        parentProposalId: null,
        revision: 1,
        status: "proposed",
        title: "Add Tempo 3 × 12",
        rationale: "Review the selected workout before adding it to the active Plan.",
        confidence: "High",
        mutationJson: encodePlanProposalMutation({
          schemaVersion: 1,
          changes: [
            {
              workoutId: addedWorkoutId,
              before: null,
              after: {
                dateKey: 20260831,
                sport: "cycling",
                name: "Tempo 3 × 12",
                durationS: 3_840,
                structureJson: JSON.stringify({
                  intervals: [{ repetitions: 3, durationS: 720 }],
                }),
              },
            },
          ],
          weekLoad: { before: 420, after: 480 },
        }),
        baseSnapshotJson: encodePlanProposalBase(
          capturePlanProposalBase(activePlan, [existingWorkout]),
        ),
        refusalReason: null,
        createdAtMs: 20,
        updatedAtMs: 20,
        resolvedAtMs: null,
        deviceId: "device-1",
        hlcPhysicalMs: 20,
        hlcCounter: 0,
      },
      [
        {
          id: `${"0".repeat(25)}E`,
          proposalId,
          sourceType: "chat-workout",
          sourceId: "workout-selection",
          sourceLabel: "Tempo 3 × 12 · MRC",
          sourceDateKey: null,
          confidence: "High",
          snapshotJson: '{"workoutId":"tempo-3x12"}',
          createdAtMs: 20,
          deviceId: "device-1",
          hlcPhysicalMs: 20,
          hlcCounter: 0,
        },
      ],
    );
    const request = await requests.createOrGet({
      payload: {
        requestId: "request-add-workout",
        kind: "workout_review",
        intent: "Add Tempo 3 × 12 to Monday.",
        source: {
          chatId: "chat-1",
          messageId: "message-1",
          attachmentId: "attachment-1",
        },
        sourceSnapshot: {
          capturedAt: "1998-08-24T08:00:00.000Z",
          attachment: {
            attachmentId: "attachment-1",
            displayName: "tempo-3x12.mrc",
            extension: "mrc",
          },
          selectedWorkout: {
            setId: "set-1",
            workoutId: "workout-1",
            workout: {
              title: "Tempo 3 × 12",
              sport: "cycling",
              durationSeconds: 3_840,
            },
          },
        },
        requestedDate: "2026-08-31",
      },
      target: "active_plan",
      createdAtMs: 30,
      deviceId: "device-1",
      hlcPhysicalMs: 30,
      hlcCounter: 0,
    });
    await requests.reviseOpen({
      requestId: request.request.requestId,
      expectedRevision: request.request.revision,
      planConversationId: null,
      proposalId,
      attention: "needs_review",
      resolvedDateKey: 20260831,
      updatedAtMs: 40,
      deviceId: "device-1",
      hlcPhysicalMs: 40,
      hlcCounter: 0,
    });
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        proposals,
        requests,
        todayDateKey: () => 20260826,
        proposalLoadCalculator: (workouts) => (workouts.length === 1 ? 420 : 480),
        proposalPremiseReader: {
          async read() {
            return '{"workoutId":"tempo-3x12"}';
          },
        },
      },
    );

    const applied = await operations.executePlanTransition?.({
      transitionId: "PL-T19",
      commandId: "command-add-workout",
      proposalId,
      expectedRevision: 1,
    });
    expect(applied).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S008",
        data: {
          history: [
            expect.objectContaining({
              kind: "proposal-applied",
              before: null,
              after: expect.objectContaining({ name: "Tempo 3 × 12", durationS: 3_840 }),
              undoStatus: "eligible",
            }),
            expect.objectContaining({ kind: "activation" }),
          ],
        },
      },
    });
    if (applied?.status !== "completed") throw new TypeError("Workout addition did not apply.");
    const ledgerId = String(applied.state.data.selectedHistoryId);
    await expect(plans.readWorkouts(planId)).resolves.toHaveLength(2);
    await expect(requests.read("request-add-workout")).resolves.toMatchObject({
      request: {
        lifecycle: "applied",
        attention: "none",
        terminalResult: {
          kind: "applied",
          title: "Added to Plan",
          detail: "Tempo 3 × 12 is scheduled for 2026-08-31.",
          planRevisionId: ledgerId,
        },
      },
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T21",
        commandId: "command-undo-workout-addition",
        planId,
        ledgerId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S027",
        data: {
          history: expect.arrayContaining([
            expect.objectContaining({ kind: "undo", after: null }),
            expect.objectContaining({ id: ledgerId, undoStatus: "undone" }),
          ]),
        },
      },
    });
    await expect(plans.readWorkouts(planId)).resolves.toEqual([existingWorkout]);
  });

  it("resolves Chat date conflicts without replacing protected Workouts", async () => {
    const planId = `${"0".repeat(25)}P`;
    const coachWorkoutId = `${"0".repeat(25)}W`;
    const athleteWorkoutId = `${"0".repeat(25)}X`;
    const importedWorkoutId = `${"0".repeat(25)}Y`;
    const activePlan: PlanRecord = { ...plan(planId, 10), status: "active" };
    const coachWorkout: PlanWorkoutRecord = {
      id: coachWorkoutId,
      planId,
      dateKey: 20260831,
      sport: "cycling",
      name: "Easy endurance",
      durationS: 3_000,
      structureJson: "{}",
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    };
    const athleteWorkout: PlanWorkoutRecord = {
      ...coachWorkout,
      id: athleteWorkoutId,
      name: "Club ride",
      origin: "athlete",
    };
    const plans = createPlanRepository(store);
    const proposals = createPlanProposalRepository(store);
    const requests = createPlanningRequestRepository(store, createNodeCrypto());
    await plans.replace(activePlan, [coachWorkout, athleteWorkout]);
    const seed = async (input: {
      readonly requestId: string;
      readonly proposalId: string;
      readonly premiseId: string;
      readonly chatId: string;
      readonly messageId: string;
      readonly timestamp: number;
    }): Promise<void> => {
      await proposals.save(
        {
          id: input.proposalId,
          planId,
          parentProposalId: null,
          revision: 1,
          status: "proposed",
          title: "Add Tempo 3 × 12",
          rationale: "Review the selected Workout before changing the active Plan.",
          confidence: "High",
          mutationJson: encodePlanProposalMutation({
            schemaVersion: 1,
            changes: [
              {
                workoutId: importedWorkoutId,
                before: null,
                after: {
                  dateKey: 20260831,
                  sport: "cycling",
                  name: "Tempo 3 × 12",
                  durationS: 3_840,
                  structureJson: "{}",
                },
              },
            ],
            weekLoad: null,
          }),
          baseSnapshotJson: encodePlanProposalBase(
            capturePlanProposalBase(activePlan, [coachWorkout, athleteWorkout]),
          ),
          refusalReason: null,
          createdAtMs: input.timestamp,
          updatedAtMs: input.timestamp,
          resolvedAtMs: null,
          deviceId: "device-1",
          hlcPhysicalMs: input.timestamp,
          hlcCounter: 0,
        },
        [
          {
            id: input.premiseId,
            proposalId: input.proposalId,
            sourceType: "chat-workout",
            sourceId: "workout-selection",
            sourceLabel: "Tempo 3 × 12 · MRC",
            sourceDateKey: null,
            confidence: "High",
            snapshotJson: '{"workoutId":"tempo-3x12"}',
            createdAtMs: input.timestamp,
            deviceId: "device-1",
            hlcPhysicalMs: input.timestamp,
            hlcCounter: 0,
          },
        ],
      );
      const request = await requests.createOrGet({
        payload: {
          requestId: input.requestId,
          kind: "workout_review",
          intent: "Add Tempo 3 × 12 to Monday.",
          source: {
            chatId: input.chatId,
            messageId: input.messageId,
            attachmentId: `${input.requestId}-attachment`,
          },
          sourceSnapshot: {
            capturedAt: "1998-08-24T08:00:00.000Z",
            attachment: {
              attachmentId: `${input.requestId}-attachment`,
              displayName: "tempo-3x12.mrc",
              extension: "mrc",
            },
            selectedWorkout: {
              setId: `${input.requestId}-set`,
              workoutId: `${input.requestId}-workout`,
              workout: { title: "Tempo 3 × 12", sport: "cycling", durationSeconds: 3_840 },
            },
          },
          requestedDate: "2026-08-31",
        },
        target: "active_plan",
        createdAtMs: input.timestamp + 1,
        deviceId: "device-1",
        hlcPhysicalMs: input.timestamp + 1,
        hlcCounter: 0,
      });
      await requests.reviseOpen({
        requestId: input.requestId,
        expectedRevision: request.request.revision,
        planConversationId: null,
        proposalId: input.proposalId,
        attention: "date_conflict",
        resolvedDateKey: null,
        updatedAtMs: input.timestamp + 2,
        deviceId: "device-1",
        hlcPhysicalMs: input.timestamp + 2,
        hlcCounter: 0,
      });
    };
    await seed({
      requestId: "request-date",
      proposalId: `${"0".repeat(25)}M`,
      premiseId: `${"0".repeat(25)}R`,
      chatId: "chat-date",
      messageId: "message-date",
      timestamp: 20,
    });
    const authored = identity();
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      { plans, proposals, requests, todayDateKey: () => 20260826 },
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T36",
        commandId: "command-open-date-conflict",
        sourceConversationId: "chat-date",
        requestId: "request-date",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S007",
        data: {
          selectedPlanningRequest: {
            dateConflict: {
              recommendedDate: "2026-09-01",
              workouts: expect.arrayContaining([
                expect.objectContaining({ workoutId: coachWorkoutId, replaceable: true }),
                expect.objectContaining({ workoutId: athleteWorkoutId, replaceable: false }),
              ]),
            },
          },
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T40",
        commandId: "command-protected-date-conflict",
        requestId: "request-date",
        resolution: { kind: "replace-workout", workoutId: athleteWorkoutId },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "conflict", retryable: false },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T40",
        commandId: "command-use-recommended-date",
        requestId: "request-date",
        resolution: { kind: "use-date", date: "2026-09-01" },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S007",
        data: {
          selectedPlanningRequest: {
            request: { attention: "needs_review", resolvedDateKey: 20260901 },
            dateConflict: null,
          },
        },
      },
    });
    const dateRequest = await requests.read("request-date");
    expect(dateRequest?.request).toMatchObject({
      attention: "needs_review",
      resolvedDateKey: 20260901,
    });
    const dateProposal =
      dateRequest?.request.proposalId === null || dateRequest === undefined
        ? undefined
        : await proposals.read(dateRequest.request.proposalId);
    expect(JSON.parse(dateProposal?.mutationJson ?? "{}")).toMatchObject({
      changes: [{ after: { dateKey: 20260901 } }],
    });

    await seed({
      requestId: "request-replace",
      proposalId: `${"0".repeat(25)}N`,
      premiseId: `${"0".repeat(25)}S`,
      chatId: "chat-replace",
      messageId: "message-replace",
      timestamp: 50,
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T40",
        commandId: "command-replace-coach-workout",
        requestId: "request-replace",
        resolution: { kind: "replace-workout", workoutId: coachWorkoutId },
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S007" } });
    const replaceRequest = await requests.read("request-replace");
    const replaceProposal =
      replaceRequest?.request.proposalId === null || replaceRequest === undefined
        ? undefined
        : await proposals.read(replaceRequest.request.proposalId);
    expect(JSON.parse(replaceProposal?.mutationJson ?? "{}")).toMatchObject({
      changes: [
        {
          workoutId: coachWorkoutId,
          before: { name: "Easy endurance" },
          after: { name: "Tempo 3 × 12", dateKey: 20260831 },
        },
      ],
    });

    if (dateProposal === undefined) throw new TypeError("Resolved date Proposal missing.");
    const beforeFailedApply = await plans.readWorkouts(planId);
    const failingOperations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      {
        plans,
        proposals: {
          ...proposals,
          apply: async () => {
            throw new TypeError("synthetic local save failure");
          },
        },
        requests,
        todayDateKey: () => 20260826,
        proposalPremiseReader: { read: async () => '{"workoutId":"tempo-3x12"}' },
      },
    );
    await expect(
      failingOperations.executePlanTransition?.({
        transitionId: "PL-T19",
        commandId: "command-failed-date-apply",
        proposalId: dateProposal.id,
        expectedRevision: dateProposal.revision,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "persistence-failed", retryable: true },
      state: {
        scenarioId: "PL-S007",
        data: {
          selectedPlanningRequest: {
            request: { attention: "apply_failed" },
          },
        },
      },
    });
    await expect(plans.readWorkouts(planId)).resolves.toEqual(beforeFailedApply);
    await expect(requests.read("request-date")).resolves.toMatchObject({
      request: { lifecycle: "open", attention: "apply_failed" },
    });

    const recoveringOperations = createPlanningOperations(
      { context, engine: engine(), identity: authored },
      {
        plans,
        proposals,
        requests,
        todayDateKey: () => 20260826,
        proposalPremiseReader: { read: async () => '{"workoutId":"tempo-3x12"}' },
      },
    );
    await expect(
      recoveringOperations.executePlanTransition?.({
        transitionId: "PL-T19",
        commandId: "command-retry-date-apply",
        proposalId: dateProposal.id,
        expectedRevision: dateProposal.revision,
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S008" } });
    await expect(requests.read("request-date")).resolves.toMatchObject({
      request: { lifecycle: "applied", attention: "none" },
    });
  });

  it("opens Season and Race week without mutating persisted Plan facts", async () => {
    const planId = `${"0".repeat(25)}A`;
    const raceWorkoutId = `${"0".repeat(25)}B`;
    const activePlan: PlanRecord = {
      ...plan(planId, 10),
      status: "active",
      structureJson: JSON.stringify({
        seasonWeeks: Array.from({ length: 12 }, (_, index) => ({
          phase: index === 11 ? "Race" : "Build",
          purpose: index === 11 ? "Goal race" : "Follow the approved week",
        })),
        racePriority: "A",
        raceDistanceKm: 120,
        seasonConstraint: {
          weekIndex: 8,
          title: "FTP refresh required",
          detail: "Power targets wait for refreshed FTP.",
        },
      }),
    };
    const raceWorkout: PlanWorkoutRecord = {
      id: raceWorkoutId,
      planId,
      dateKey: 20260930,
      sport: "cycling",
      name: "Gran Fondo Plan",
      durationS: 18_000,
      structureJson: "{}",
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    };
    const plans = createPlanRepository(store);
    await plans.replace(activePlan, [raceWorkout]);
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, todayDateKey: () => 20260818 },
    );
    const beforePlan = await plans.read(planId);
    const beforeWorkouts = await plans.readWorkouts(planId);

    const season = await operations.executePlanTransition?.({
      transitionId: "PL-T31",
      commandId: "command-season-open",
      planId,
    });
    expect(season).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S006",
        data: {
          season: {
            priority: "A",
            distanceKm: 120,
            weeks: expect.arrayContaining([
              expect.objectContaining({ weekIndex: 8, status: "blocked" }),
              expect.objectContaining({ weekIndex: 12, phase: "Race" }),
            ]),
            raceWeek: {
              raceDate: "2026-09-30",
              trainingDurationS: 0,
              raceDurationS: 18_000,
              totalDurationS: 18_000,
              days: expect.arrayContaining([
                expect.objectContaining({
                  date: "2026-09-30",
                  workoutId: raceWorkoutId,
                  kind: "race",
                }),
              ]),
            },
          },
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-race-week-open",
        action: "open",
        sourceScenarioId: "PL-S006",
        destinationScenarioId: "PL-S009",
        returnFocusId: "plan-race-week-trigger",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S009",
        data: { returnFocusId: "plan-race-week-trigger" },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-race-week-back",
        action: "back",
        sourceScenarioId: "PL-S009",
        destinationScenarioId: "PL-S006",
        returnFocusId: "plan-race-week-trigger",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S006",
        data: { returnFocusId: "plan-race-week-trigger" },
      },
    });
    await expect(plans.read(planId)).resolves.toEqual(beforePlan);
    await expect(plans.readWorkouts(planId)).resolves.toEqual(beforeWorkouts);
  });

  it("opens and refreshes Race readiness without persisting modeled Form", async () => {
    const planId = `${"0".repeat(25)}A`;
    const activePlan = { ...plan(planId, 10), status: "active" as const };
    const plans = createPlanRepository(store);
    await plans.replace(activePlan, []);
    const input = {
      today: "2026-08-26",
      raceDate: "2026-08-28",
      platformSeed: {
        asOf: "2026-08-26",
        fitness: 60,
        fatigue: 59,
        lastSuccessfulRefreshAtMs: 1_777_000_000_000,
      },
      dailyLoadRanges: [
        { date: "2026-08-27", min: 0, max: 0 },
        { date: "2026-08-28", min: 20, max: 30 },
      ],
      supportedDistanceKm: { min: 135, max: 145 },
      missedKeyWorkouts: 0,
      fatigue: "normal" as const,
      courseEstimate: {
        status: "available" as const,
        rangeMinutes: { min: 288, max: 312 },
        previousRangeMinutes: null,
        confidence: "moderate" as const,
        assumptions: ["Dry roads", "Low wind"],
        changedAssumption: null,
        unavailableReason: null,
      },
      estimatedCp: {
        status: "unavailable" as const,
        watts: null,
        calculatedOn: null,
        lastSuccessfulSyncAtMs: null,
        unavailableReason: "missing-effort" as const,
        efforts: [],
      },
      evidence: {
        prescribedDurationS: 154_800,
        riddenDurationS: 142_800,
        adjustedDurationS: 7_800,
      },
    };
    const readiness = { read: vi.fn(async () => input), refresh: vi.fn(async () => undefined) };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, readiness, todayDateKey: () => 20260826 },
    );
    const beforePlan = await plans.read(planId);
    const beforeWorkouts = await plans.readWorkouts(planId);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T32",
        commandId: "command-readiness-open",
        planId,
        mode: "open",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S012",
        data: {
          readiness: {
            form: { status: "available", current: 1 },
            courseEstimate: { rangeMinutes: { min: 288, max: 312 } },
          },
        },
      },
    });
    const progress: PlanProgressEvent[] = [];
    await expect(
      operations.executePlanTransition?.(
        {
          transitionId: "PL-T32",
          commandId: "command-readiness-refresh",
          planId,
          mode: "refresh",
        },
        (event) => progress.push(event),
      ),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S012" } });
    expect(progress.map((event) => event.phase)).toEqual(["running", "completed"]);
    expect(readiness.refresh).toHaveBeenCalledOnce();
    await expect(plans.read(planId)).resolves.toEqual(beforePlan);
    await expect(plans.readWorkouts(planId)).resolves.toEqual(beforeWorkouts);

    const failing = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        readiness: {
          read: async () => input,
          refresh: vi.fn(async () => {
            throw new Error("provider unavailable");
          }),
        },
        todayDateKey: () => 20260826,
      },
    );
    await expect(
      failing.executePlanTransition?.({
        transitionId: "PL-T32",
        commandId: "command-readiness-failed",
        planId,
        mode: "refresh",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "provider-failed", retryable: true },
      state: {
        scenarioId: "PL-S076",
        data: {
          readiness: {
            form: { status: "unavailable", unavailableReason: "refresh-failed" },
            courseEstimate: { rangeMinutes: { min: 288, max: 312 } },
          },
        },
      },
    });
    await expect(plans.read(planId)).resolves.toEqual(beforePlan);
  });

  it("saves each active Plan setting immediately and restores the persisted value on failure", async () => {
    const planId = `${"0".repeat(25)}A`;
    const activePlan = {
      ...plan(planId, 10),
      status: "active" as const,
      structureJson: JSON.stringify({
        phases: [
          { focus: "base", durationWeeks: 4 },
          { focus: "build", durationWeeks: 6 },
          { focus: "taper", durationWeeks: 2 },
        ],
      }),
    };
    const plans = createPlanRepository(store);
    const settings = createPlanSettingsRepository(store);
    await plans.replace(activePlan, []);

    const failing = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        settings: {
          read: (id) => settings.read(id),
          save: vi.fn(async () => {
            throw new Error("disk full");
          }),
        },
        todayDateKey: () => 20260826,
      },
    );
    await expect(
      failing.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-settings-open",
        action: "open",
        sourceScenarioId: "PL-S005",
        destinationScenarioId: "PL-S090",
        returnFocusId: "plan-settings-trigger",
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S090" } });
    await expect(
      failing.executePlanTransition?.({
        transitionId: "PL-T22",
        commandId: "command-settings-failed",
        planId,
        setting: "weekly-review",
        value: false,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "persistence-failed", retryable: true },
      state: {
        scenarioId: "PL-S093",
        data: {
          settings: {
            autoApply: false,
            weeklyReview: true,
            selectedSetting: "weekly-review",
            error: { code: "persistence-failed" },
          },
        },
      },
    });
    await expect(settings.read(planId)).resolves.toMatchObject({ weeklyReview: true });

    const working = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, settings, todayDateKey: () => 20260826 },
    );
    await expect(
      working.executePlanTransition?.({
        transitionId: "PL-T22",
        commandId: "command-settings-retry",
        planId,
        setting: "weekly-review",
        value: false,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S092",
        data: {
          settings: {
            autoApply: false,
            weeklyReview: false,
            selectedSetting: "weekly-review",
            error: null,
          },
        },
      },
    });
  });

  it("delivers one durable Weekly review and reopens the same result idempotently", async () => {
    const planId = `${"0".repeat(25)}A`;
    const workoutId = `${"0".repeat(25)}B`;
    const missedWorkoutId = `${"0".repeat(25)}C`;
    const plans = createPlanRepository(store);
    await plans.replace({ ...plan(planId, 10), status: "active" }, [
      {
        id: workoutId,
        planId,
        dateKey: 20260817,
        sport: "cycling",
        name: "Endurance",
        durationS: 3_600,
        structureJson: "{}",
        origin: "coach",
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
      {
        id: missedWorkoutId,
        planId,
        dateKey: 20260819,
        sport: "cycling",
        name: "Recovery",
        durationS: 2_700,
        structureJson: "{}",
        origin: "coach",
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
    ]);
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        workoutMatches: weeklyReviewMatches({
          planId,
          workoutId,
          syncAtMs: 1_787_702_400_000,
        }),
        todayDateKey: () => 20260826,
      },
    );
    const command = {
      transitionId: "PL-T35" as const,
      commandId: "weekly-review",
      planId,
      weekStart: "2026-08-17",
    };

    const delivered = await operations.executePlanTransition?.(command);
    expect(delivered).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S100",
        data: {
          weeklyReview: {
            status: "delivered",
            counts: { asPlanned: 1, adjusted: 0, moved: 0, missed: 1, extra: 1 },
          },
        },
      },
    });
    const reviewId = (await createPlanWeeklyReviewRepository(store).readLatestDelivered(planId))
      ?.id;
    expect(reviewId).not.toBeNull();

    await expect(
      operations.executePlanTransition?.({ ...command, commandId: "weekly-review-repeat" }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S100", data: { weeklyReview: { id: reviewId } } },
    });
  });

  it("pauses Weekly review delivery when disabled or the latest sync is stale", async () => {
    const planId = `${"0".repeat(25)}A`;
    const workoutId = `${"0".repeat(25)}B`;
    const plans = createPlanRepository(store);
    await plans.replace({ ...plan(planId, 10), status: "active" }, []);
    const command = {
      transitionId: "PL-T35" as const,
      commandId: "weekly-review",
      planId,
      weekStart: "2026-08-17",
    };
    const disabled = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        settings: {
          read: async () => ({
            planId,
            autoApply: false,
            weeklyReview: false,
            updatedAtMs: 10,
            deviceId: "device-1",
            hlcPhysicalMs: 10,
            hlcCounter: 0,
          }),
          save: async () => {
            throw new TypeError("unused");
          },
        },
        workoutMatches: weeklyReviewMatches({
          planId,
          workoutId,
          syncAtMs: 1_787_702_400_000,
        }),
        todayDateKey: () => 20260826,
      },
    );
    await expect(disabled.executePlanTransition?.(command)).resolves.toMatchObject({
      status: "rejected",
      error: { code: "unavailable" },
    });

    const stale = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        workoutMatches: weeklyReviewMatches({
          planId,
          workoutId,
          syncAtMs: 1_787_443_200_000,
        }),
        todayDateKey: () => 20260826,
      },
    );
    await expect(stale.executePlanTransition?.(command)).resolves.toMatchObject({
      status: "rejected",
      error: { code: "unavailable" },
    });
  });

  it("retries a failed Weekly review only after a newer successful sync", async () => {
    const planId = `${"0".repeat(25)}A`;
    const workoutId = `${"0".repeat(25)}B`;
    const plans = createPlanRepository(store);
    await plans.replace({ ...plan(planId, 10), status: "active" }, [
      {
        id: workoutId,
        planId,
        dateKey: 20260817,
        sport: "cycling",
        name: "Endurance",
        durationS: 3_600,
        structureJson: "{}",
        origin: "coach",
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
    ]);
    let syncAtMs = 1_787_702_400_000;
    const matches = weeklyReviewMatches({ planId, workoutId, syncAtMs });
    const weeklyReviews = createPlanWeeklyReviewRepository(store);
    let failCompletion = true;
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        workoutMatches: {
          ...matches,
          readSyncStatus: async () => ({ lastSuccessfulSyncAtMs: syncAtMs, awaitingSync: false }),
        },
        weeklyReviews: {
          ...weeklyReviews,
          complete: async (input) => {
            if (failCompletion) {
              failCompletion = false;
              throw new TypeError("disk full");
            }
            return weeklyReviews.complete(input);
          },
        },
        todayDateKey: () => 20260826,
      },
    );
    const command = {
      transitionId: "PL-T35" as const,
      commandId: "weekly-review-failure",
      planId,
      weekStart: "2026-08-17",
    };

    await expect(operations.executePlanTransition?.(command)).resolves.toMatchObject({
      status: "rejected",
      error: { code: "persistence-failed", retryable: true },
    });
    await expect(
      operations.executePlanTransition?.({ ...command, commandId: "same-sync" }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "unavailable" } });

    syncAtMs += 1_000;
    await expect(
      operations.executePlanTransition?.({ ...command, commandId: "newer-sync" }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S100", data: { weeklyReview: { status: "delivered" } } },
    });
  });

  it("refuses a hard-work increase during taper without changing the active Plan", async () => {
    const planId = `${"0".repeat(25)}A`;
    const workoutId = `${"0".repeat(25)}B`;
    const proposalId = `${"0".repeat(25)}C`;
    const activePlan: PlanRecord = {
      ...plan(planId, 10),
      status: "active",
      structureJson: JSON.stringify({
        phases: [
          { focus: "base", durationWeeks: 4 },
          { focus: "build", durationWeeks: 6 },
          { focus: "taper", durationWeeks: 2 },
        ],
      }),
    };
    const workout: PlanWorkoutRecord = {
      id: workoutId,
      planId,
      dateKey: 20260925,
      sport: "cycling",
      name: "Race opener",
      durationS: 1_800,
      structureJson: "{}",
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    };
    const plans = createPlanRepository(store);
    const proposals = createPlanProposalRepository(store);
    await plans.replace(activePlan, [workout]);
    await proposals.save(
      {
        id: proposalId,
        planId,
        parentProposalId: null,
        revision: 1,
        status: "proposed",
        title: "Add missed threshold work",
        rationale: "The athlete requested a hard session.",
        confidence: "High",
        mutationJson: encodePlanProposalMutation({
          schemaVersion: 1,
          changes: [
            {
              workoutId,
              before: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: workout.name,
                durationS: workout.durationS,
                structureJson: workout.structureJson,
              },
              after: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: "Threshold 4×8",
                durationS: 4_800,
                structureJson: workout.structureJson,
              },
            },
          ],
          weekLoad: null,
        }),
        baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(activePlan, [workout])),
        refusalReason: null,
        createdAtMs: 20,
        updatedAtMs: 20,
        resolvedAtMs: null,
        deviceId: "device-1",
        hlcPhysicalMs: 20,
        hlcCounter: 0,
      },
      [
        {
          id: `${"0".repeat(25)}D`,
          proposalId,
          sourceType: "wellness",
          sourceId: "wellness-race-week",
          sourceLabel: "Race-week recovery",
          sourceDateKey: 20260924,
          confidence: "High",
          snapshotJson: "{}",
          createdAtMs: 20,
          deviceId: "device-1",
          hlcPhysicalMs: 20,
          hlcCounter: 0,
        },
      ],
    );
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, proposals, todayDateKey: () => 20260826 },
    );
    const beforePlan = await plans.read(planId);
    const beforeWorkouts = await plans.readWorkouts(planId);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T17",
        commandId: "command-taper-refusal",
        planId,
        proposalId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S078",
        data: {
          readiness: {
            taperRefusal: {
              requested: "Threshold 4×8 · 1:20",
              kept: "Race opener · 0:30",
            },
          },
        },
      },
    });
    await expect(proposals.read(proposalId)).resolves.toMatchObject({
      status: "refused",
      refusalReason: "Adding missed work during taper would reduce freshness before the race.",
    });
    await expect(plans.read(planId)).resolves.toEqual(beforePlan);
    await expect(plans.readWorkouts(planId)).resolves.toEqual(beforeWorkouts);
  });

  it("automatically applies only an enabled eligible reduction and records its atomic result", async () => {
    const planId = `${"0".repeat(25)}B`;
    const workoutId = `${"0".repeat(25)}C`;
    const proposalId = `${"0".repeat(25)}D`;
    const premiseId = `${"0".repeat(25)}E`;
    const activePlan: PlanRecord = {
      ...plan(planId, 10),
      status: "active",
      structureJson: JSON.stringify({
        phases: [
          { focus: "base", durationWeeks: 4 },
          { focus: "build", durationWeeks: 6 },
          { focus: "taper", durationWeeks: 2 },
        ],
      }),
    };
    const workout: PlanWorkoutRecord = {
      id: workoutId,
      planId,
      dateKey: 20260830,
      sport: "cycling",
      name: "Endurance",
      durationS: 5_400,
      structureJson: "{}",
      origin: "coach",
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    };
    const plans = createPlanRepository(store);
    const proposals = createPlanProposalRepository(store);
    const settings = createPlanSettingsRepository(store);
    await plans.replace(activePlan, [workout]);
    await proposals.save(
      {
        id: proposalId,
        planId,
        parentProposalId: null,
        revision: 1,
        status: "proposed",
        title: "Reduce Sunday duration",
        rationale: "Protect recovery.",
        confidence: "High",
        mutationJson: encodePlanProposalMutation({
          schemaVersion: 1,
          changes: [
            {
              workoutId,
              before: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: workout.name,
                durationS: workout.durationS,
                structureJson: workout.structureJson,
              },
              after: {
                dateKey: workout.dateKey,
                sport: workout.sport,
                name: workout.name,
                durationS: 2_700,
                structureJson: workout.structureJson,
              },
            },
          ],
          weekLoad: null,
        }),
        baseSnapshotJson: encodePlanProposalBase(capturePlanProposalBase(activePlan, [workout])),
        refusalReason: null,
        createdAtMs: 20,
        updatedAtMs: 20,
        resolvedAtMs: null,
        deviceId: "device-1",
        hlcPhysicalMs: 20,
        hlcCounter: 0,
      },
      [
        {
          id: premiseId,
          proposalId,
          sourceType: "wellness",
          sourceId: "wellness-1",
          sourceLabel: "Wellness",
          sourceDateKey: 20260829,
          confidence: "High",
          snapshotJson: "{}",
          createdAtMs: 20,
          deviceId: "device-1",
          hlcPhysicalMs: 20,
          hlcCounter: 0,
        },
      ],
    );
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        proposals,
        settings,
        todayDateKey: () => 20260826,
        proposalPremiseReader: { read: async () => "{}" },
      },
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T17",
        commandId: "command-auto-disabled",
        planId,
        proposalId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S007", data: { selectedProposalId: proposalId } },
    });
    await operations.executePlanTransition?.({
      transitionId: "PL-T22",
      commandId: "command-auto-enable",
      planId,
      setting: "auto-apply",
      value: true,
    });
    const applied = await operations.executePlanTransition?.({
      transitionId: "PL-T17",
      commandId: "command-auto-apply",
      planId,
      proposalId,
    });
    expect(applied).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S101",
        data: {
          history: [
            expect.objectContaining({
              kind: "proposal-applied",
              before: expect.objectContaining({ durationS: 5_400 }),
              after: expect.objectContaining({ durationS: 2_700 }),
              undoStatus: "eligible",
            }),
            expect.objectContaining({ kind: "activation" }),
          ],
        },
      },
    });
    await expect(plans.readWorkouts(planId)).resolves.toEqual([
      expect.objectContaining({ name: "Endurance", durationS: 2_700 }),
    ]);
    await expect(proposals.read(proposalId)).resolves.toMatchObject({ status: "applied" });
    await expect(
      createPlanReconciliationRepository(store).readLatestJob(planId, "mirror"),
    ).resolves.toMatchObject({
      status: "pending",
      windowStartDateKey: 20260826,
      windowEndDateKey: 20260901,
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T17",
        commandId: "command-auto-repeat",
        planId,
        proposalId,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("ends locally, preserves today and athlete events, and recovers cleanup", async () => {
    const planId = `${"0".repeat(25)}F`;
    const conversationId = `${"0".repeat(25)}J`;
    const activePlan = { ...plan(planId, 10), status: "active" as const };
    const plans = createPlanRepository(store);
    const conversations = createPlanConversationRepository(store);
    await plans.replace(activePlan, []);
    await conversations.saveConversation({
      id: conversationId,
      planId,
      replacesPlanId: null,
      courseChoiceStatus: "omitted",
      raceCourseJson: null,
      status: "open",
      endedAtMs: null,
      createdAtMs: 10,
      updatedAtMs: 10,
      deviceId: "device-1",
      hlcPhysicalMs: 10,
      hlcCounter: 0,
    });
    await conversations.appendTurn({
      id: `${"0".repeat(25)}K`,
      conversationId,
      sequence: 1,
      athleteText: "Gran Fondo Almaty on 4 October.",
      coachText: "I found your recent rides and FTP.",
      lineageJson: "{}",
      completedAtMs: 11,
      deviceId: "device-1",
      hlcPhysicalMs: 11,
      hlcCounter: 0,
    });
    const ownToday = planMirrorExternalId(planId, `${"0".repeat(25)}G`);
    const ownTomorrow = planMirrorExternalId(planId, `${"0".repeat(25)}H`);
    const events = [
      { id: 1, dateKey: 20260826, externalId: ownToday },
      { id: 2, dateKey: 20260827, externalId: ownTomorrow },
      { id: 3, dateKey: 20260827, externalId: null },
    ];
    const deletes: number[] = [];
    let failListing = true;
    let todayDateKey = 20260826;
    const calendar: PlanMirrorCalendarPort = {
      async listEvents({ startDateKey, endDateKey }) {
        if (failListing) {
          failListing = false;
          throw new Error("provider unavailable");
        }
        return events.filter(
          (event) => event.dateKey >= startDateKey && event.dateKey <= endDateKey,
        );
      },
      async createEvent() {},
      async updateEvent() {},
      async deleteEvent({ eventId }) {
        deletes.push(eventId);
        const index = events.findIndex((event) => event.id === eventId);
        if (index >= 0) events.splice(index, 1);
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, calendar, todayDateKey: () => todayDateKey },
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T23",
        commandId: "command-end-confirmation",
        planId,
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S051" } });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T24",
        commandId: "command-end",
        planId,
        mode: "cleanup",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: { lifecycle: "ended", scenarioId: "PL-S053" },
    });
    await expect(plans.read(planId)).resolves.toMatchObject({ status: "ended" });
    todayDateKey = 20260827;

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T24",
        commandId: "command-verify",
        planId,
        mode: "verify",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "verification-failed" },
      state: { scenarioId: "PL-S053", attention: { count: 1 } },
    });
    expect(deletes).toEqual([]);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T24",
        commandId: "command-cleanup-retry",
        planId,
        mode: "cleanup",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { lifecycle: "ended", scenarioId: "PL-S056", reconciliation: { status: "verified" } },
    });
    expect(deletes).toEqual([2]);
    expect(events).toEqual([
      { id: 1, dateKey: 20260826, externalId: ownToday },
      { id: 3, dateKey: 20260827, externalId: null },
    ]);

    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { lifecycle: "ended", scenarioId: "PL-S089" },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-ended-conversation",
        action: "open",
        sourceScenarioId: "PL-S089",
        destinationScenarioId: "PL-S102",
        returnFocusId: planId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: {
        lifecycle: "ended",
        scenarioId: "PL-S102",
        projection: "coach",
        data: {
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "athlete", text: "Gran Fondo Almaty on 4 October." }),
            expect.objectContaining({ role: "coach", text: "I found your recent rides and FTP." }),
          ]),
        },
      },
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "command-ended-conversation-back",
        action: "back",
        sourceScenarioId: "PL-S102",
        destinationScenarioId: "PL-S089",
        returnFocusId: planId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { lifecycle: "ended", scenarioId: "PL-S089" },
    });
  });

  it("ends naturally after the target date and persists a separate completed race outcome", async () => {
    const planId = `${"0".repeat(25)}R`;
    const plans = createPlanRepository(store);
    await plans.replace(
      {
        id: planId,
        originId: null,
        name: "Gran Fondo Plan",
        primaryGoal: "Finish",
        startDateKey: 19980713,
        targetDateKey: 19981004,
        status: "active",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 1,
        updatedAtMs: 10,
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
      [],
    );
    let todayDateKey = 19981004;
    const workoutMatches = weeklyReviewMatches({
      planId,
      workoutId: `${"0".repeat(25)}S`,
      syncAtMs: 80,
    });
    const calendar: PlanMirrorCalendarPort = {
      listEvents: async () => [],
      createEvent: async () => undefined,
      updateEvent: async () => undefined,
      deleteEvent: async () => undefined,
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, workoutMatches, calendar, todayDateKey: () => todayDateKey },
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T29",
        commandId: "natural-too-early",
        planId,
        asOf: "1998-10-04",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(plans.read(planId)).resolves.toMatchObject({ status: "active" });

    todayDateKey = 19981005;
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T29",
        commandId: "natural-completion",
        planId,
        asOf: "1998-10-05",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S094", lifecycle: "ended" },
    });
    await expect(plans.read(planId)).resolves.toMatchObject({ status: "ended" });
    await expect(
      createPlanReconciliationRepository(store).readLatestJob(planId, "cleanup"),
    ).resolves.toMatchObject({ status: "pending", windowStartDateKey: 19981006 });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T24",
        commandId: "natural-cleanup",
        planId,
        mode: "cleanup",
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S056" } });
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { scenarioId: "PL-S095", data: { outcomeAvailable: true } },
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T30",
        commandId: "race-completed",
        planId,
        outcome: "completed",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S014", data: { raceOutcome: "completed" } },
    });
    await expect(createPlanRaceOutcomeRepository(store).read(planId)).resolves.toMatchObject({
      outcome: "completed",
    });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T30",
        commandId: "race-completed-repeat",
        planId,
        outcome: "completed",
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S014" } });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T30",
        commandId: "race-outcome-conflict",
        planId,
        outcome: "not-completed",
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "conflict" } });
  });

  it("keeps the outcome prompt for retry and persists Not completed without calendar writes", async () => {
    const planId = `${"0".repeat(25)}T`;
    const plans = createPlanRepository(store);
    await plans.replace(
      {
        id: planId,
        originId: null,
        name: "Gran Fondo Plan",
        primaryGoal: "Finish",
        startDateKey: 19980713,
        targetDateKey: 19981004,
        status: "ended",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 1,
        updatedAtMs: 10,
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
      [],
    );
    const stored = createPlanRaceOutcomeRepository(store);
    let fail = true;
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      {
        plans,
        todayDateKey: () => 19981005,
        workoutMatches: weeklyReviewMatches({
          planId,
          workoutId: `${"0".repeat(25)}V`,
          syncAtMs: 80,
        }),
        raceOutcomes: {
          read: (id) => stored.read(id),
          async record(value) {
            if (fail) {
              fail = false;
              throw new Error("write failed");
            }
            return stored.record(value);
          },
        },
      },
    );

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T30",
        commandId: "outcome-fails",
        planId,
        outcome: "not-completed",
      }),
    ).resolves.toMatchObject({ status: "rejected", state: { scenarioId: "PL-S095" } });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T30",
        commandId: "outcome-retry",
        planId,
        outcome: "not-completed",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S096", data: { raceOutcome: "not-completed" } },
    });
  });

  it("keeps the current Plan active until an atomic replacement and blocks new writes until cleanup", async () => {
    const previousPlanId = `${"0".repeat(25)}M`;
    const replacementPlanId = `${"0".repeat(25)}N`;
    const replacementWorkoutId = `${"0".repeat(25)}P`;
    const draftId = `${"0".repeat(25)}Q`;
    const plans = createPlanRepository(store);
    const conversations = createPlanConversationRepository(store);
    await plans.replace({ ...plan(previousPlanId, 10), status: "active" }, []);

    const ownToday = planMirrorExternalId(previousPlanId, `${"0".repeat(25)}R`);
    const ownTomorrow = planMirrorExternalId(previousPlanId, `${"0".repeat(25)}S`);
    const events = [
      { id: 1, dateKey: 20260826, externalId: ownToday },
      { id: 2, dateKey: 20260827, externalId: ownTomorrow },
      { id: 3, dateKey: 20260827, externalId: null },
    ];
    const deleted: number[] = [];
    const created: string[] = [];
    let failCleanupOnce = true;
    let todayDateKey = 20260826;
    const calendar: PlanMirrorCalendarPort = {
      async listEvents({ startDateKey, endDateKey }) {
        if (failCleanupOnce) {
          failCleanupOnce = false;
          throw new Error("provider unavailable");
        }
        return events.filter(
          (event) => event.dateKey >= startDateKey && event.dateKey <= endDateKey,
        );
      },
      async createEvent(value) {
        created.push(value.externalId);
        events.push({
          id: events.length + 10,
          dateKey: value.dateKey,
          externalId: value.externalId,
        });
      },
      async updateEvent() {},
      async deleteEvent({ eventId }) {
        deleted.push(eventId);
        const index = events.findIndex((event) => event.id === eventId);
        if (index >= 0) events.splice(index, 1);
      },
    };
    const operations = createPlanningOperations(
      { context, engine: engine(), identity: identity() },
      { plans, calendar, todayDateKey: () => todayDateKey },
    );

    const started = await operations.executePlanTransition?.({
      transitionId: "PL-T25",
      commandId: "replacement-start",
      planId: previousPlanId,
    });
    expect(started).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S079",
        lifecycle: "replacement-intake",
        data: { replacement: true, replacesPlanId: previousPlanId },
      },
    });
    await expect(plans.read(previousPlanId)).resolves.toMatchObject({ status: "active" });
    const replacementConversation = await conversations.readLatestOpenReplacement(previousPlanId);
    if (replacementConversation === undefined) throw new TypeError("Replacement intake missing.");
    await plans.replace(
      {
        ...plan(replacementPlanId, 20),
        startDateKey: 20260827,
        targetDateKey: 20261118,
        status: "draft",
      },
      [
        {
          id: replacementWorkoutId,
          planId: replacementPlanId,
          dateKey: 20260827,
          sport: "cycling",
          name: "Replacement endurance",
          durationS: 3_600,
          structureJson: "{}",
          origin: "coach",
          deviceId: "device-1",
          hlcPhysicalMs: 20,
          hlcCounter: 0,
        },
      ],
    );
    await conversations.saveConversation({
      ...replacementConversation,
      planId: replacementPlanId,
      courseChoiceStatus: "omitted",
      updatedAtMs: replacementConversation.updatedAtMs + 1,
      hlcPhysicalMs: replacementConversation.hlcPhysicalMs + 1,
    });
    const draftTimestamp = replacementConversation.updatedAtMs + 2;
    await conversations.saveDraftRevision({
      id: draftId,
      conversationId: replacementConversation.id,
      planId: replacementPlanId,
      revision: 1,
      parentRevisionId: null,
      status: "ready",
      snapshotJson: '{"weeks":12}',
      raceCourseJson: null,
      createdAtMs: draftTimestamp,
      updatedAtMs: draftTimestamp,
      deviceId: "device-1",
      hlcPhysicalMs: draftTimestamp,
      hlcCounter: 0,
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T26",
        commandId: "replacement-open-confirmation",
        activePlanId: previousPlanId,
        draftId,
        expectedRevision: 1,
        confirm: false,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S081", data: { replacesPlanId: previousPlanId } },
    });
    await expect(plans.read(previousPlanId)).resolves.toMatchObject({ status: "active" });

    const approved = await operations.executePlanTransition?.({
      transitionId: "PL-T26",
      commandId: "replacement-confirm",
      activePlanId: previousPlanId,
      draftId,
      expectedRevision: 1,
      confirm: true,
    });
    expect(approved).toMatchObject({
      status: "completed",
      state: {
        scenarioId: "PL-S082",
        lifecycle: "active",
        planId: replacementPlanId,
        data: {
          replacement: { previousPlan: { id: previousPlanId }, cleanupItems: [] },
          settings: { autoApply: false, weeklyReview: true },
        },
      },
    });
    await expect(plans.read(previousPlanId)).resolves.toMatchObject({ status: "ended" });
    await expect(plans.read(replacementPlanId)).resolves.toMatchObject({ status: "active" });
    await expect(
      createPlanReplacementRepository(store).readByReplacementPlanId(replacementPlanId),
    ).resolves.toMatchObject({ previousPlanId, draftRevisionId: draftId });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T26",
        commandId: "replacement-confirm-repeat",
        activePlanId: previousPlanId,
        draftId,
        expectedRevision: 1,
        confirm: true,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S082", planId: replacementPlanId },
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T28",
        commandId: "replacement-write-too-early",
        planId: replacementPlanId,
      }),
    ).resolves.toMatchObject({ status: "rejected", state: { scenarioId: "PL-S082" } });
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T27",
        commandId: "replacement-cleanup-fails",
        planId: previousPlanId,
        replacementPlanId,
        mode: "cleanup",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: { scenarioId: "PL-S083", planId: replacementPlanId },
    });
    await expect(plans.read(replacementPlanId)).resolves.toMatchObject({ status: "active" });
    expect(deleted).toEqual([]);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T27",
        commandId: "replacement-cleanup-verify",
        planId: previousPlanId,
        replacementPlanId,
        mode: "verify",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      state: { scenarioId: "PL-S083", planId: replacementPlanId },
    });
    expect(deleted).toEqual([]);
    todayDateKey = 20260827;

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T27",
        commandId: "replacement-cleanup-retry",
        planId: previousPlanId,
        replacementPlanId,
        mode: "cleanup",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S085", planId: replacementPlanId },
    });
    expect(deleted).toEqual([2]);
    expect(events).toEqual([
      { id: 1, dateKey: 20260826, externalId: ownToday },
      { id: 3, dateKey: 20260827, externalId: null },
    ]);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T28",
        commandId: "replacement-write",
        planId: replacementPlanId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S087", planId: replacementPlanId },
    });
    expect(created).toEqual([planMirrorExternalId(replacementPlanId, replacementWorkoutId)]);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "replacement-open-active",
        action: "open",
        sourceScenarioId: "PL-S087",
        destinationScenarioId: "PL-S088",
        returnFocusId: replacementPlanId,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S088", planId: replacementPlanId },
    });
  });
});
