import { describe, expect, it } from "vitest";
import {
  CreatePlanningRequestPayloadSchema,
  CreatePlanningRequestRpcParamsSchema,
  CreatePlanningRequestRpcResultSchema,
  CreateWorkoutPlanningRequestRpcParamsSchema,
  ListPlanningRequestsRpcParamsSchema,
  ListPlanningRequestsRpcResultSchema,
  PlanningRequestDeliverySchema,
} from "../src/index.js";

const payload = {
  requestId: "request-1",
  kind: "workout_review" as const,
  intent: "Review this Workout before I add it to my Plan.",
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
      extension: "mrc" as const,
    },
    selectedWorkout: {
      setId: "set-1",
      workoutId: "workout-1",
      workout: { name: "Tempo 3 × 12", durationSeconds: 3_840 },
    },
  },
  requestedDate: "1998-08-26",
};

describe("Planning request contract", () => {
  it("accepts the frozen by-value Workout handoff and rejects identity drift", () => {
    expect(CreatePlanningRequestPayloadSchema.parse(payload)).toEqual(payload);
    expect(() =>
      CreatePlanningRequestPayloadSchema.parse({
        ...payload,
        source: { ...payload.source, attachmentId: "attachment-2" },
      }),
    ).toThrow();
    expect(() => CreatePlanningRequestPayloadSchema.parse({ ...payload, extra: true })).toThrow();
  });

  it("keeps delivery status, retryability, and Planning acceptance aligned", () => {
    expect(
      PlanningRequestDeliverySchema.parse({
        requestId: payload.requestId,
        source: {
          kind: payload.kind,
          intent: payload.intent,
          chatId: payload.source.chatId,
          messageId: payload.source.messageId,
          attachmentId: payload.source.attachmentId,
        },
        state: "pending",
        attemptCount: 1,
        failureCode: null,
        retryable: true,
        createdAtMs: 100,
        updatedAtMs: 101,
        deliveredAtMs: null,
        planningRequest: null,
      }),
    ).toMatchObject({ state: "pending", retryable: true });
    expect(() =>
      PlanningRequestDeliverySchema.parse({
        requestId: payload.requestId,
        source: {
          kind: payload.kind,
          intent: payload.intent,
          chatId: payload.source.chatId,
          messageId: payload.source.messageId,
          attachmentId: payload.source.attachmentId,
        },
        state: "delivered",
        attemptCount: 1,
        failureCode: null,
        retryable: false,
        createdAtMs: 100,
        updatedAtMs: 101,
        deliveredAtMs: 101,
        planningRequest: null,
      }),
    ).toThrow();
  });

  it("exposes request conflicts as a bounded rejection", () => {
    expect(
      CreatePlanningRequestRpcResultSchema.parse({
        status: "rejected",
        reason: "request_conflict",
      }),
    ).toEqual({ status: "rejected", reason: "request_conflict" });
  });

  it("accepts only distinct trusted Workout source identities", () => {
    const request = {
      requestId: "request-1",
      intent: "Review Tempo 3 × 12.",
      source: {
        chatId: "chat-1",
        messageId: "message-1",
        attachmentId: "attachment-1",
      },
      requestedDate: "1998-08-26",
    };
    expect(CreateWorkoutPlanningRequestRpcParamsSchema.parse(request)).toEqual(request);
    expect(() =>
      CreateWorkoutPlanningRequestRpcParamsSchema.parse({
        ...request,
        source: { ...request.source, attachmentId: request.source.messageId },
      }),
    ).toThrow();
  });

  it("rejects Workout snapshots through the generic renderer request", () => {
    expect(() => CreatePlanningRequestRpcParamsSchema.parse({ payload })).toThrow();
    expect(
      CreatePlanningRequestRpcParamsSchema.parse({
        payload: {
          ...payload,
          kind: "plan_change",
          source: { chatId: "chat-1", messageId: "message-1" },
          sourceSnapshot: {
            capturedAt: payload.sourceSnapshot.capturedAt,
            attachment: null,
            selectedWorkout: null,
          },
        },
      }).payload.kind,
    ).toBe("plan_change");
  });

  it("lists durable handoffs for exactly one Chat", () => {
    expect(ListPlanningRequestsRpcParamsSchema.parse({ chatId: "chat-1" })).toEqual({
      chatId: "chat-1",
    });
    expect(() =>
      ListPlanningRequestsRpcParamsSchema.parse({ chatId: "chat-1", extra: true }),
    ).toThrow();
    expect(
      ListPlanningRequestsRpcResultSchema.parse({ deliveries: [], planCreation: null }),
    ).toEqual({ deliveries: [], planCreation: null });
  });
});
