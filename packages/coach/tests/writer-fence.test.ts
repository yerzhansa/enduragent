import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  CoachEngine,
  ExecutePlanTransitionRpcParams,
  PlanCreationAnswerInput,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import { planMirrorExternalId, type PlanMirrorCalendarPort } from "@enduragent/engine";
import {
  createLegacyWriterFence,
  createPlanConversationRepository,
  createPlanCreationRepository,
  createPlanRepository,
  createPlanProposalRepository,
  createPlanWorkoutMatchRepository,
} from "@enduragent/kernel/planning";
import { dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { createPlanningOperations } from "../src/planning-operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const MESSAGE = "This Plan is managed in Chat. Change or stop it from Chat or the Plan library.";
const CONVERSATION_ID = "00000000000000000000000001";

async function fixture(
  status: "empty" | "in-progress" | "review" | "active" | "closed" | "discarded",
) {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  let clockCounter = 0;
  const identity = {
    deviceId: async () => "writer-fence-test-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: ++clockCounter }),
  };
  const dependencies = {
    store,
    identity,
    crypto: globalThis.crypto,
    todayDateKey: () => 19980902,
    now: () => 904_694_400_000,
  };
  const creation = createPlanCreationOperations({
    ...dependencies,
    repository: createPlanCreationRepository(store),
    eventCandidates: { read: async () => [] },
    eventSources: { read: async () => [] },
    today: () => "1998-09-02",
  });
  const seed = async () => {
    if (status === "empty") return { creationId: null, planId: null };
    const start = await creation["plan_creation.start"]({ commandId: "start" });
    if (start.status !== "started") throw new Error("Expected creation");
    let card = start.planCreation;
    if (status === "in-progress") return { creationId: card.creationId, planId: null };
    if (status === "discarded") {
      await creation["plan_creation.discard"]({
        commandId: "discard",
        creationId: card.creationId,
        expectedVersion: card.version,
      });
      return { creationId: card.creationId, planId: null };
    }
    const answers: PlanCreationAnswerInput[] = [
      { kind: "goal", goal: { kind: "fitness" } },
      { kind: "plan-length", weeks: 4 },
      { kind: "schedule-mode", mode: "fixed" },
      {
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 8,
        longestWorkoutHours: 3,
        usableWeekdays: [6, 2, 4],
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
      if (result.status !== "answered") throw new Error("Expected answer");
      card = result.planCreation;
    }
    const draftResult = await creation["plan_creation.preview"]({
      commandId: "draft",
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (draftResult.status !== "previewed" || draftResult.planCreation.draft === null)
      throw new Error("Expected Draft");
    if (status === "review") return { creationId: card.creationId, planId: null };
    const activated = await creation["plan_creation.activate"]({
      commandId: "activate",
      creationId: card.creationId,
      expectedVersion: draftResult.planCreation.version,
      incumbent: null,
    });
    expect(activated.planId).toBeTruthy();
    const listed = await creation["plan.list"]({});
    if (listed.active === null) throw new Error("Expected active Plan summary");
    const planId = listed.active.planId;
    if (status === "closed") {
      await creation["plan.close"]({ commandId: "close", planId, expectedVersion: 1 });
    }
    return { creationId: card.creationId, planId };
  };
  const ids = await seed();
  const context: CoachStoreWriterContext = {
    home: {
      root: "/synthetic/athlete",
      storeDir: "/synthetic/athlete/store",
      archiveDir: "/synthetic/athlete/archive",
      configDir: "/synthetic/athlete/config",
    },
    store,
    listener: inertWriterProtocolListener,
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("Unexpected engine call");
  };
  const engine: CoachEngine = {
    chat: vi.fn(unsupported),
    answerCoachDecision: unsupported,
    skipCoachDecision: unsupported,
    resumeCoachDecision: unsupported,
    resetSession: unsupported,
    hasSession: unsupported,
    getAthleteState: unsupported,
    getChatQueue: async () => ({ schemaVersion: 1, revision: 0, items: [] }),
    getCoachDecision: async () => ({ decision: null }),
  };
  const operations = createPlanningOperations(
    { context, engine, identity },
    { todayDateKey: () => 19980902 },
  );
  const openConversation = async (replacesPlanId: string | null = null) => {
    const conversations = createPlanConversationRepository(store);
    await conversations.saveConversation({
      id: CONVERSATION_ID,
      planId: null,
      replacesPlanId,
      courseChoiceStatus: "omitted",
      raceCourseJson: null,
      status: "open",
      endedAtMs: null,
      createdAtMs: 100,
      updatedAtMs: 100,
      deviceId: "fence-test-device",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    await conversations.appendTurn({
      id: "00000000000000000000000002",
      conversationId: CONVERSATION_ID,
      sequence: 1,
      athleteText: "Improve my climbing.",
      coachText: "We can build toward that.",
      lineageJson: canonicalJson({ planIntakePatch: { goal: "Improve my climbing" } }),
      completedAtMs: 101,
      deviceId: "fence-test-device",
      hlcPhysicalMs: 101,
      hlcCounter: 0,
    });
  };
  return { store, operations, openConversation, creation, context, engine, identity, ...ids };
}

function withoutWorkoutMatches(dump: string): string {
  return dump.replace(/(# plan_workout_match\n)[\s\S]*?(?=# |$)/, "$1");
}

function commands(planId: string): ExecutePlanTransitionRpcParams[] {
  return [
    { transitionId: "PL-T01", commandId: "start-legacy", sourceConversationId: null },
    {
      transitionId: "PL-T11",
      commandId: "activate-legacy",
      draftId: CONVERSATION_ID,
      expectedRevision: 1,
    },
    {
      transitionId: "PL-T15",
      commandId: "adopt-provider-edit",
      planId,
      workoutId: CONVERSATION_ID,
      eventId: "42",
    },
    {
      transitionId: "PL-T17",
      commandId: "proposal-legacy",
      planId,
      proposalId: CONVERSATION_ID,
      selectedProposalReturn: { sourceScenarioId: "PL-S010", returnFocusId: "workout-row" },
    },
    { transitionId: "PL-T21", commandId: "undo-legacy", planId, ledgerId: CONVERSATION_ID },
    { transitionId: "PL-T24", commandId: "stop-legacy", planId, mode: "cleanup" },
    { transitionId: "PL-T29", commandId: "complete-legacy", planId, asOf: "1998-09-02" },
    { transitionId: "PL-T12", commandId: "retry-mirror", planId, mode: "reconcile" },
    {
      transitionId: "PL-T16",
      commandId: "restore-workout",
      planId,
      workoutId: CONVERSATION_ID,
      eventId: "42",
    },
    {
      transitionId: "PL-T27",
      commandId: "retry-cleanup",
      planId,
      replacementPlanId: CONVERSATION_ID,
      mode: "cleanup",
    },
    { transitionId: "PL-T28", commandId: "mirror-replacement", planId },
    {
      transitionId: "PL-T26",
      commandId: "replace-legacy",
      activePlanId: planId,
      draftId: CONVERSATION_ID,
      expectedRevision: 1,
      confirm: true,
    },
  ];
}

describe("legacy writer fence", () => {
  it.each(["closed", "discarded"] as const)(
    "reads an open legacy conversation after %s Chat ownership without creating intake",
    async (status) => {
      const test = await fixture(status);
      await test.openConversation();
      await expect(createLegacyWriterFence(test.store).read()).resolves.toMatchObject({
        activePlanId: null,
        creationId: null,
        chatAuthoritySinceMs: 904_694_400_000,
      });
      const counts = async () =>
        test.store.get(`SELECT
          (SELECT COUNT(*) FROM plan_intake) AS intakes,
          (SELECT COUNT(*) FROM plan_conversation) AS conversations`);
      const beforeCounts = await counts();
      expect(beforeCounts).toEqual({ intakes: 0, conversations: 1 });
      const before = await dumpStore(test.store);

      await expect(test.operations.getPlanState?.({})).resolves.toMatchObject({
        status: "ready",
        state: { projection: "coach", data: { intake: { goal: "Improve my climbing" } } },
      });

      expect(await counts()).toEqual(beforeCounts);
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it("projects pending intake turns without updating stored intake after Chat authority begins", async () => {
    const test = await fixture("empty");
    await test.openConversation();
    await test.operations.getPlanState?.({});
    const intake = await test.store.get("SELECT * FROM plan_intake");
    expect(intake).toMatchObject({ source_turn_sequence: 1 });
    await createPlanConversationRepository(test.store).appendTurn({
      id: "00000000000000000000000003",
      conversationId: CONVERSATION_ID,
      sequence: 2,
      athleteText: "Improve my endurance too.",
      coachText: "We can build endurance.",
      lineageJson: canonicalJson({ planIntakePatch: { goal: "Improve my endurance" } }),
      completedAtMs: 102,
      deviceId: "fence-test-device",
      hlcPhysicalMs: 102,
      hlcCounter: 0,
    });
    const started = await test.creation["plan_creation.start"]({ commandId: "chat-start" });
    if (started.status !== "started") throw new Error("Expected creation");
    await test.creation["plan_creation.discard"]({
      commandId: "chat-discard",
      creationId: started.planCreation.creationId,
      expectedVersion: started.planCreation.version,
    });
    const before = await dumpStore(test.store);

    await expect(test.operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { projection: "coach", data: { intake: { goal: "Improve my endurance" } } },
    });

    expect(await test.store.get("SELECT * FROM plan_intake")).toEqual(intake);
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("keeps an unfenced navigation rejection read-only after Chat authority begins", async () => {
    const test = await fixture("discarded");
    await test.openConversation();
    const before = await dumpStore(test.store);

    await expect(
      test.operations.executePlanTransition?.({
        transitionId: "PL-T13",
        commandId: "open-missing-workout",
        planId: CONVERSATION_ID,
        workoutId: CONVERSATION_ID,
      }),
    ).resolves.toMatchObject({ status: "rejected" });

    expect(await dumpStore(test.store)).toBe(before);
  });

  it.each(["in-progress", "review", "discarded"] as const)(
    "rejects with %s creation without engine reads or store writes",
    async (status) => {
      const test = await fixture(status);
      await test.openConversation();
      const getChatQueue = vi.spyOn(test.engine, "getChatQueue");
      const getCoachDecision = vi.spyOn(test.engine, "getCoachDecision");
      const before = await dumpStore(test.store);

      await expect(
        test.operations.executePlanTransition?.({
          transitionId: "PL-T01",
          commandId: "fenced-legacy-start",
          sourceConversationId: null,
        }),
      ).resolves.toMatchObject({
        status: "rejected",
        error: { code: "conflict", message: MESSAGE },
        state: { projection: "coach" },
      });

      expect(getChatQueue).not.toHaveBeenCalled();
      expect(getCoachDecision).not.toHaveBeenCalled();
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it("rejects natural completion while Chat owns the active Plan", async () => {
    const test = await fixture("active");
    await test.openConversation();
    if (test.planId === null) throw new Error("Expected active Plan");
    const planId = test.planId;
    const plans = createPlanRepository(test.store);
    const plan = await plans.read(planId);
    if (plan === undefined) throw new Error("Expected Plan record");
    await plans.replace(
      {
        ...plan,
        name: "Gran Fondo Plan",
        primaryGoal: "Finish",
        startDateKey: 19980713,
        targetDateKey: 19981004,
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
      },
      [],
    );
    let todayDateKey = 19981004;
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      { plans, todayDateKey: () => todayDateKey },
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
    const before = await dumpStore(test.store);
    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T29",
        commandId: "natural-completion",
        planId,
        asOf: "1998-10-05",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: MESSAGE },
    });
    await expect(plans.read(planId)).resolves.toMatchObject({ status: "active" });
    await expect(createLegacyWriterFence(test.store).read()).resolves.toMatchObject({
      activePlanId: planId,
    });
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: { lifecycle: "active", projection: "active", planId },
    });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it.each(["in-progress", "review", "active", "closed", "discarded"] as const)(
    "reads %s ownership without writes",
    async (status) => {
      const test = await fixture(status);
      const fence = createLegacyWriterFence(test.store);
      const before = await dumpStore(test.store);
      expect(await fence.read()).toEqual({
        activePlanId: status === "active" ? test.planId : null,
        creationId: status === "in-progress" || status === "review" ? test.creationId : null,
        chatAuthoritySinceMs: 904_694_400_000,
      });
      expect(await fence.fenced()).toBe(true);
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it.each(["in-progress", "review", "active", "closed", "discarded"] as const)(
    "rejects authoring families with %s ownership and preserves authoring state",
    async (status) => {
      const test = await fixture(status);
      await test.openConversation();
      let operations = test.operations;
      if (test.planId !== null) {
        const [workout] = await createPlanRepository(test.store).readWorkouts(test.planId);
        if (workout === undefined) throw new Error("Expected Workout");
        operations = createPlanningOperations(
          { context: test.context, engine: test.engine, identity: test.identity },
          {
            todayDateKey: () => 19980902,
            workoutMatches: {
              ...createPlanWorkoutMatchRepository(test.store),
              listActivities: async () => [
                {
                  activityId: "b".repeat(64),
                  providerActivityId: "synthetic-unmatched-activity",
                  dateKey: workout.dateKey,
                  sport: workout.sport,
                  durationS: workout.durationS,
                  pairedEventId: null,
                },
              ],
            },
          },
        );
      }
      const before = withoutWorkoutMatches(await dumpStore(test.store));
      for (const command of commands(test.planId ?? CONVERSATION_ID)) {
        const result = await operations.executePlanTransition?.(command);
        expect(result).toMatchObject({
          status: "rejected",
          error: { code: "conflict", message: MESSAGE },
          state: { projection: status === "active" ? "active" : "coach" },
        });
        expect(withoutWorkoutMatches(await dumpStore(test.store))).toBe(before);
      }
    },
  );

  it("rejects PL-T01 without writes when no Chat creation has ever started", async () => {
    const test = await fixture("empty");
    const fence = createLegacyWriterFence(test.store);
    const before = await dumpStore(test.store);
    expect(await fence.read()).toEqual({
      activePlanId: null,
      creationId: null,
      chatAuthoritySinceMs: null,
    });
    expect(await fence.fenced()).toBe(false);
    expect(await dumpStore(test.store)).toBe(before);
    await expect(
      test.operations.executePlanTransition?.({
        transitionId: "PL-T01",
        commandId: "legacy-start",
        sourceConversationId: null,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: MESSAGE },
    });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it.each(commands(CONVERSATION_ID).filter((command) => command.transitionId !== "PL-T01"))(
    "does not fence $transitionId when no Chat creation has ever started",
    async (command) => {
      const test = await fixture("empty");
      const result = await test.operations.executePlanTransition?.(command);
      expect(result).toBeDefined();
      expect(result).not.toMatchObject({
        status: "rejected",
        error: { code: "conflict", message: MESSAGE },
      });
    },
  );

  it("adopts a provider Workout edit when Chat authority has never begun", async () => {
    const source = await fixture("active");
    if (source.planId === null) throw new Error("Expected active Plan");
    const sourcePlans = createPlanRepository(source.store);
    const plan = await sourcePlans.read(source.planId);
    if (plan === undefined) throw new Error("Expected Plan record");
    const workouts = await sourcePlans.readWorkouts(plan.id);
    const target = workouts.find((workout) => workout.dateKey > 19980902);
    if (target === undefined) throw new Error("Expected future Workout");
    const test = await fixture("empty");
    const plans = createPlanRepository(test.store);
    await plans.replace(plan, workouts);
    const providerEvent = {
      id: 42,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(plan.id, target.id),
      category: "WORKOUT",
      name: target.name,
      durationS: (target.durationS ?? 0) + 300,
      description: "Adjusted duration",
      workoutDoc: null,
      updated: "1998-09-02T10:00:00Z",
    };
    const calendar: PlanMirrorCalendarPort = {
      listEvents: async () => [providerEvent],
      readEvent: async () => providerEvent,
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
    };
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      { todayDateKey: () => 19980902, workoutDriftCalendar: calendar },
    );
    await expect(createLegacyWriterFence(test.store).fenced()).resolves.toBe(false);
    await operations.getPlanState?.({});

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T15",
        commandId: "adopt-provider-edit",
        planId: plan.id,
        workoutId: target.id,
        eventId: "42",
      }),
    ).resolves.toMatchObject({ status: "completed", state: { scenarioId: "PL-S034" } });

    expect(await plans.readWorkouts(plan.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: target.id, durationS: providerEvent.durationS }),
      ]),
    );
    expect(await test.store.all("SELECT kind FROM plan_adaptation_ledger")).toEqual([
      { kind: "drift-adopted" },
    ]);
    expect(calendar.updateEvent).not.toHaveBeenCalled();
  });

  it("prefers the active Chat Plan over an open legacy conversation without intake writes", async () => {
    const test = await fixture("active");
    await test.openConversation();
    const before = await dumpStore(test.store);
    await expect(test.operations.getPlanState?.({})).resolves.toMatchObject({
      status: "ready",
      state: {
        projection: "active",
        planId: test.planId,
        data: { plan: { id: test.planId, name: "Improve fitness" }, workouts: expect.any(Array) },
      },
    });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("checks ownership when a queued command enters the serialized lane", async () => {
    const test = await fixture("empty");
    await test.openConversation();
    let signalEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      {
        todayDateKey: () => 19980902,
        isReady: async () => {
          calls += 1;
          if (calls === 1) {
            signalEntered();
            await released;
          }
          return false;
        },
      },
    );
    const first = operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "first",
      conversationId: CONVERSATION_ID,
    });
    await entered;
    const queued = operations.executePlanTransition?.({
      transitionId: "PL-T03",
      commandId: "queued",
      conversationId: CONVERSATION_ID,
    });
    await test.creation["plan_creation.start"]({ commandId: "chat-start" });
    const before = await dumpStore(test.store);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    await expect(queued).resolves.toMatchObject({
      status: "rejected",
      error: { code: "conflict", message: MESSAGE },
    });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("does not create a calendar mirror when fenced verification has no prior items", async () => {
    const test = await fixture("active");
    if (test.planId === null) throw new Error("Expected active Plan");
    const calendar: PlanMirrorCalendarPort = {
      listEvents: vi.fn(async () => []),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
    };
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      { todayDateKey: () => 19980902, calendar },
    );
    const before = await dumpStore(test.store);

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T12",
        commandId: "verify-missing-mirror",
        planId: test.planId,
        mode: "verify",
      }),
    ).resolves.toMatchObject({ status: "rejected" });

    expect(calendar.listEvents).not.toHaveBeenCalled();
    expect(calendar.createEvent).not.toHaveBeenCalled();
    expect(calendar.updateEvent).not.toHaveBeenCalled();
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("matches a synced ride completed today under Chat authority without changing authoring state", async () => {
    const test = await fixture("active");
    if (test.planId === null) throw new Error("Expected active Plan");
    const plans = createPlanRepository(test.store);
    const plan = await plans.read(test.planId);
    const workouts = await plans.readWorkouts(test.planId);
    const workout = workouts[0];
    if (plan === undefined || workout === undefined) throw new Error("Expected Plan and Workout");
    const todayDateKey = workout.dateKey;
    const activityEpochS =
      Date.UTC(
        Math.floor(todayDateKey / 10_000),
        (Math.floor(todayDateKey / 100) % 100) - 1,
        todayDateKey % 100,
        12,
      ) / 1_000;
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      { todayDateKey: () => todayDateKey },
    );
    const activityId = "a".repeat(64);
    const workoutKey = "b".repeat(64);
    const jobId = "00000000000000000000000004";
    await test.store.run(
      "INSERT INTO workout(workout_key,start_utc,is_multisport,dedup_cluster_id) VALUES(?,?,?,?)",
      [workoutKey, activityEpochS, 0, "synthetic-completed-ride"],
    );
    await test.store.run(
      "INSERT INTO session(session_key,workout_key,session_seq,sport,start_utc,local_date_key,elapsed_s,is_transition) VALUES(?,?,?,?,?,?,?,?)",
      [
        activityId,
        workoutKey,
        0,
        workout.sport,
        activityEpochS,
        todayDateKey,
        workout.durationS,
        0,
      ],
    );
    await test.store.run(
      "INSERT INTO source_record(id,session_key,source,external_id,quality_rank,payload_json) VALUES(?,?,?,?,?,?)",
      [
        "c".repeat(64),
        activityId,
        "intervals-icu",
        "synthetic-completed-ride",
        1,
        JSON.stringify({ paired_event_id: 42 }),
      ],
    );
    await test.store.run(
      "INSERT INTO source_artifact(artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s) VALUES(?,?,?,?,?,?,?,?)",
      [
        "d".repeat(64),
        "intervals-icu",
        "activities",
        "synthetic-completed-ride",
        "snapshot",
        "e".repeat(64),
        "synthetic/ride.json",
        activityEpochS,
      ],
    );
    await test.store.run(
      "INSERT INTO plan_reconciliation_job(id,plan_id,kind,status,window_start_date_key,window_end_date_key,created_at_ms,updated_at_ms,completed_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
      [jobId, plan.id, "mirror", "verified", todayDateKey, todayDateKey, 100, 100, 100],
    );
    await test.store.run(
      "INSERT INTO plan_reconciliation_item(id,job_id,plan_workout_id,operation,status,date_key,external_id,provider_event_id,expected_json,created_at_ms,updated_at_ms,completed_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "00000000000000000000000005",
        jobId,
        workout.id,
        "create",
        "verified",
        todayDateKey,
        planMirrorExternalId(plan.id, workout.id),
        42,
        "{}",
        100,
        100,
        100,
      ],
    );
    const matches = createPlanWorkoutMatchRepository(test.store);
    expect(await matches.readForPlan(plan.id)).toEqual([]);
    const before = withoutWorkoutMatches(await dumpStore(test.store));

    await expect(operations.getPlanState?.({})).resolves.toMatchObject({ status: "ready" });

    expect(await matches.readForWorkout(workout.id)).toMatchObject([
      { activityId, source: "platform", decision: "confirmed", activityDateKey: todayDateKey },
    ]);
    expect(withoutWorkoutMatches(await dumpStore(test.store))).toBe(before);
  });

  it("returns from a legacy replacement conversation without refreshing drift or refusing proposals after Chat authority", async () => {
    const source = await fixture("active");
    if (source.planId === null) throw new Error("Expected active Plan");
    const sourcePlans = createPlanRepository(source.store);
    const plan = await sourcePlans.read(source.planId);
    if (plan === undefined) throw new Error("Expected Plan");
    const workouts = await sourcePlans.readWorkouts(plan.id);
    const test = await fixture("discarded");
    await createPlanRepository(test.store).replace(plan, workouts);
    await test.openConversation(plan.id);
    const proposals = createPlanProposalRepository(test.store);
    await proposals.save(
      {
        id: "00000000000000000000000004",
        planId: plan.id,
        parentProposalId: null,
        revision: 1,
        status: "proposed",
        title: "Adjust training",
        rationale: "Review training.",
        confidence: "High",
        mutationJson: "{}",
        baseSnapshotJson: "{}",
        refusalReason: null,
        createdAtMs: 100,
        updatedAtMs: 100,
        resolvedAtMs: null,
        deviceId: "fence-test-device",
        hlcPhysicalMs: 100,
        hlcCounter: 0,
      },
      [
        {
          id: "00000000000000000000000005",
          proposalId: "00000000000000000000000004",
          sourceType: "chat",
          sourceId: "synthetic-turn",
          sourceLabel: "Training request",
          sourceDateKey: null,
          confidence: "High",
          snapshotJson: "{}",
          createdAtMs: 100,
          deviceId: "fence-test-device",
          hlcPhysicalMs: 100,
          hlcCounter: 0,
        },
      ],
    );
    const calendar: PlanMirrorCalendarPort = {
      listEvents: vi.fn(async () => []),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(),
    };
    const operations = createPlanningOperations(
      { context: test.context, engine: test.engine, identity: test.identity },
      { todayDateKey: () => 19980902, workoutDriftCalendar: calendar },
    );
    const before = await dumpStore(test.store);
    await expect(operations.getPlanState?.({})).resolves.toMatchObject({
      state: { scenarioId: "PL-S079", projection: "coach" },
    });

    await expect(
      operations.executePlanTransition?.({
        transitionId: "PL-T39",
        commandId: "close-replacement",
        action: "close",
        sourceScenarioId: "PL-S079",
        destinationScenarioId: "PL-S004",
        returnFocusId: "plan",
      }),
    ).resolves.toMatchObject({
      status: "completed",
      state: { scenarioId: "PL-S004", projection: "active", planId: plan.id },
    });

    expect(calendar.listEvents).not.toHaveBeenCalled();
    expect(await dumpStore(test.store)).toBe(before);
    expect(await proposals.read("00000000000000000000000004")).toMatchObject({
      status: "proposed",
    });
  });

  it("retains Workout match confirmation while a Chat Plan is active", async () => {
    const test = await fixture("active");
    if (test.planId === null) throw new Error("Expected active Plan");
    const [workout] = await createPlanRepository(test.store).readWorkouts(test.planId);
    if (workout === undefined) throw new Error("Expected Workout");
    const matches = createPlanWorkoutMatchRepository(test.store);
    const activityId = "a".repeat(64);
    const matchId = "00000000000000000000000003";
    await matches.observe({
      id: matchId,
      planId: test.planId,
      planWorkoutId: workout.id,
      activityId,
      providerActivityId: "synthetic-activity",
      providerEventId: null,
      source: "heuristic",
      decision: "suggested",
      activityDateKey: workout.dateKey,
      activitySport: workout.sport,
      activityDurationS: workout.durationS,
      observedAtMs: 100,
      decidedAtMs: null,
      deviceId: "fence-test-device",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    await expect(
      test.operations.executePlanTransition?.({
        transitionId: "PL-T14",
        commandId: "confirm-match",
        planId: test.planId,
        workoutId: workout.id,
        activityId,
        decision: "confirm",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(await matches.readForWorkout(workout.id)).toMatchObject([
      { id: matchId, decision: "confirmed" },
    ]);
  });
});
