import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatePlanningRequestPayload } from "@enduragent/coach-contract";
import {
  createPlanningRequestRepository,
  createPlanRepository,
  type PlanRecord,
} from "@enduragent/kernel/planning";
import {
  createChatPlanOutboxRepository,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  createPlanningRequestDeliveryService,
  type PlanningRequestDeliveryServiceDependencies,
} from "../src/planning-request-delivery.js";

const PLAN_ID = "01J60HFQ7T0000000000000000";

function requestPayload(
  overrides: Partial<CreatePlanningRequestPayload> = {},
): CreatePlanningRequestPayload {
  return {
    requestId: "request-1",
    kind: "plan_change",
    intent: "Move the tempo Workout to Wednesday.",
    source: {
      chatId: "chat-1",
      messageId: "message-1",
    },
    sourceSnapshot: {
      capturedAt: "1998-08-24T08:00:00.000Z",
      attachment: null,
      selectedWorkout: null,
    },
    requestedDate: "1998-08-26",
    ...overrides,
  };
}

function plan(status: PlanRecord["status"]): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Autumn base",
    primaryGoal: "Build consistency",
    startDateKey: 19980824,
    targetDateKey: null,
    status,
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: 1,
    updatedAtMs: 10,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
  };
}

describe("Planning request delivery", () => {
  let store: SqlStore & MigratorStore;
  let instant: number;
  let identity: AuthoredIdentity;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    instant = 100;
    identity = {
      deviceId: async () => "device-1",
      newUlid: () => "01J60HFQ7T0000000000000001",
      hlcStamp: () => ({ physicalMs: instant++, counter: 0 }),
    };
  });

  afterEach(async () => store.close());

  const service = (
    afterPlanningAccepted?: PlanningRequestDeliveryServiceDependencies["afterPlanningAccepted"],
    resolveWorkoutSource?: Parameters<
      typeof createPlanningRequestDeliveryService
    >[0]["resolveWorkoutSource"],
    readPlanCreationCard: Parameters<
      typeof createPlanningRequestDeliveryService
    >[0]["readPlanCreationCard"] = async () => null,
  ) => {
    const crypto = createNodeCrypto();
    const plans = createPlanRepository(store);
    return createPlanningRequestDeliveryService(
      {
        outbox: createChatPlanOutboxRepository(store, crypto),
        requests: createPlanningRequestRepository(store, crypto),
        identity,
        readPlanCreationCard,
        async resolveTarget() {
          const latest = await plans.readLatest();
          if (latest?.status === "active") return "active_plan";
          if (latest?.status === "draft") return "draft";
          return "plan_creation";
        },
        ...(resolveWorkoutSource === undefined ? {} : { resolveWorkoutSource }),
      },
      { afterPlanningAccepted },
    );
  };

  it.each([
    ["active", "active_plan"],
    ["draft", "draft"],
    ["ended", "plan_creation"],
  ] as const)("routes a %s Plan to %s", async (status, target) => {
    await createPlanRepository(store).replace(plan(status), []);
    const result = await service().createPlanningRequest!({ payload: requestPayload() });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new TypeError();
    expect(result.delivery).toMatchObject({
      state: "delivered",
      attemptCount: 1,
      retryable: false,
      planningRequest: { target },
    });
  });

  it("routes to Plan creation when no Plan exists", async () => {
    const result = await service().createPlanningRequest!({ payload: requestPayload() });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new TypeError();
    expect(result.delivery.planningRequest?.target).toBe("plan_creation");
  });

  it("builds a trusted Workout request from the selected local attachment", async () => {
    const resolveWorkoutSource = vi.fn(async () => ({
      attachment: {
        attachmentId: "attachment-1",
        displayName: "tempo-3x12.mrc",
        extension: "mrc" as const,
      },
      selectedWorkout: {
        setId: "set-1",
        workoutId: "workout-1",
        workout: {
          workoutId: "workout-1",
          title: "Tempo 3 × 12",
          sport: "cycling",
          durationSeconds: 3_840,
          purpose: "Build sustainable power",
          segments: [],
        },
      },
    }));
    const result = await service(undefined, resolveWorkoutSource).createWorkoutPlanningRequest!({
      requestId: "request-workout",
      intent: "Tempo 3 × 12",
      source: {
        chatId: "chat-1",
        messageId: "message-workout",
        attachmentId: "attachment-1",
      },
      requestedDate: "1998-08-26",
    });

    expect(result).toMatchObject({
      status: "accepted",
      delivery: {
        source: {
          kind: "workout_review",
          intent: "Tempo 3 × 12",
          chatId: "chat-1",
          messageId: "message-workout",
          attachmentId: "attachment-1",
        },
        state: "delivered",
        planningRequest: {
          requestId: "request-workout",
          kind: "workout_review",
          intent: "Tempo 3 × 12",
        },
      },
    });
    expect(resolveWorkoutSource).toHaveBeenCalledWith({
      chatId: "chat-1",
      attachmentId: "attachment-1",
    });
    const record = await createPlanningRequestRepository(store, createNodeCrypto()).read(
      "request-workout",
    );
    expect(record?.sourceState.payload?.sourceSnapshot).toMatchObject({
      attachment: { displayName: "tempo-3x12.mrc" },
      selectedWorkout: { setId: "set-1", workoutId: "workout-1" },
    });
  });

  it("rejects a Workout request when its local source cannot be resolved", async () => {
    const result = await service(undefined, async () => {
      throw new Error("missing selection");
    }).createWorkoutPlanningRequest!({
      requestId: "request-workout",
      intent: "Tempo 3 × 12",
      source: {
        chatId: "chat-1",
        messageId: "message-workout",
        attachmentId: "attachment-1",
      },
    });

    expect(result).toEqual({ status: "rejected", reason: "invalid_request" });
  });

  it("retries the same request after Planning accepted before Chat acknowledged", async () => {
    const interrupted = await service(() => {
      throw new Error("synthetic process interruption");
    }).createPlanningRequest!({ payload: requestPayload() });
    expect(interrupted).toMatchObject({
      status: "accepted",
      delivery: {
        state: "failed",
        attemptCount: 1,
        failureCode: "planning_unavailable",
        retryable: true,
      },
    });

    const before = await service().getPlanningRequest!({ requestId: "request-1" });
    expect(before).toMatchObject({
      status: "found",
      delivery: { state: "failed", attemptCount: 1, planningRequest: { requestId: "request-1" } },
    });

    const retried = await service().retryPlanningRequest!({ requestId: "request-1" });
    expect(retried).toMatchObject({
      status: "found",
      delivery: {
        state: "delivered",
        attemptCount: 2,
        planningRequest: { requestId: "request-1" },
      },
    });
    expect(
      await createPlanningRequestRepository(store, createNodeCrypto()).readOpen(),
    ).toHaveLength(1);
  });

  it("resumes persisted pending delivery and rejects conflicting reuse", async () => {
    const crypto = createNodeCrypto();
    await createChatPlanOutboxRepository(store, crypto).createOrGet({
      payload: requestPayload(),
      createdAtMs: instant++,
    });
    const resumed = await service().resumePlanningRequests!({});
    expect(resumed.deliveries).toHaveLength(1);
    expect(resumed.deliveries[0]).toMatchObject({ state: "delivered", attemptCount: 1 });

    await expect(
      service().createPlanningRequest!({
        payload: requestPayload({ intent: "Use a different intent under the same identifier." }),
      }),
    ).resolves.toEqual({ status: "rejected", reason: "request_conflict" });
  });

  it("lists current handoffs for one Chat after relaunch", async () => {
    await service().createPlanningRequest!({ payload: requestPayload() });
    await service().createPlanningRequest!({
      payload: requestPayload({
        requestId: "request-2",
        source: { chatId: "chat-2", messageId: "message-2" },
      }),
    });

    const planCreation = {
      creationId: "01J60HFQ7T0000000000000001",
      version: 1,
      status: "in-progress" as const,
      answeredSummaries: [],
      openQuestion: { kind: "goal-question" as const, prompt: "Goal?", candidates: [] },
    };
    const result = await service(undefined, undefined, async () => planCreation)
      .listPlanningRequests!({ chatId: "chat-1" });
    expect(result.planCreation).toEqual(planCreation);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({
      requestId: "request-1",
      source: {
        kind: "plan_change",
        intent: "Move the tempo Workout to Wednesday.",
        chatId: "chat-1",
        messageId: "message-1",
        attachmentId: null,
      },
      state: "delivered",
      planningRequest: { source: { chatId: "chat-1", messageId: "message-1" } },
    });
  });

  it("records a non-retryable failure when Planning owns a conflicting payload", async () => {
    const crypto = createNodeCrypto();
    await createPlanningRequestRepository(store, crypto).createOrGet({
      payload: requestPayload({ intent: "The payload Planning accepted first." }),
      target: "plan_creation",
      createdAtMs: 90,
      deviceId: "device-1",
      hlcPhysicalMs: 90,
      hlcCounter: 0,
    });

    const result = await service().createPlanningRequest!({ payload: requestPayload() });
    expect(result).toMatchObject({
      status: "accepted",
      delivery: {
        state: "failed",
        failureCode: "request_conflict",
        retryable: false,
        planningRequest: null,
      },
    });
  });
});
