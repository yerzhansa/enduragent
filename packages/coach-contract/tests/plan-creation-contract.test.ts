import { describe, expect, it } from "vitest";
import {
  COACH_RPC_METHOD_NAMES,
  COACH_RPC_METHOD_REGISTRY,
  CoachRpcRequestEnvelopeSchema,
  PlanCreationAnswerInputSchema,
  PlanCreationAnswerRpcParamsSchema,
  PlanCreationAnswerRpcResultSchema,
  PlanCreationCardModelSchema,
  PlanCreationStartRpcParamsSchema,
  PlanCreationStartRpcResultSchema,
} from "../src/index.js";

const creationId = "01J00000000000000000000000";
const card = {
  creationId,
  version: 1,
  status: "in-progress" as const,
  answeredSummaries: [],
  openQuestion: { kind: "goal-question" as const, prompt: "Goal?", candidates: [] },
};
const answers = [
  { kind: "goal", goal: { kind: "event-candidate", candidateId: creationId } },
  { kind: "goal", goal: { kind: "event-manual", name: "Tour", date: "1998-10-18" } },
  { kind: "goal", goal: { kind: "fitness", outcome: "Build power" } },
  { kind: "success", success: { kind: "event-finish", choice: "finish-fast" } },
  { kind: "success", success: { kind: "authored", text: "Ride well" } },
] as const;

describe("Plan Creation contract", () => {
  it("closes every answer and host-owned Card variant", () => {
    answers.forEach((answer) =>
      expect(PlanCreationAnswerInputSchema.parse(answer)).toEqual(answer),
    );
    expect(PlanCreationCardModelSchema.parse(card)).toEqual(card);
    expect(
      PlanCreationCardModelSchema.parse({
        ...card,
        version: 2,
        answeredSummaries: [{ answerKey: "goal", title: "Goal", detail: "x".repeat(2_000) }],
        openQuestion: {
          kind: "success-question",
          prompt: "Success?",
          input: { kind: "authored", placeholder: "Describe success" },
        },
      }),
    ).toMatchObject({ version: 2, openQuestion: { input: { kind: "authored" } } });
    expect(
      PlanCreationCardModelSchema.parse({
        ...card,
        openQuestion: {
          kind: "success-question",
          prompt: "Success?",
          input: {
            kind: "event-finish",
            options: [
              { choice: "finish-comfortably", label: "Finish comfortably" },
              { choice: "finish-fast", label: "Finish fast" },
              { choice: "race-for-result", label: "Race for a result" },
            ],
          },
        },
      }),
    ).toMatchObject({ openQuestion: { input: { kind: "event-finish" } } });
    expect(() =>
      PlanCreationCardModelSchema.parse({
        ...card,
        answeredSummaries: [{ answerKey: "goal", title: "Goal", detail: "x".repeat(2_001) }],
      }),
    ).toThrow();
  });

  it("rejects renderer-authored fields and malformed command boundaries", () => {
    expect(() =>
      PlanCreationAnswerInputSchema.parse({ ...answers[0], name: "Untrusted" }),
    ).toThrow();
    expect(() =>
      PlanCreationAnswerInputSchema.parse({
        kind: "goal",
        goal: { kind: "event-manual", name: "Tour", date: "2026-2-3" },
      }),
    ).toThrow();
    expect(
      PlanCreationAnswerInputSchema.parse({
        kind: "goal",
        goal: { kind: "event-manual", name: "Tour", date: "2026-02-28" },
      }),
    ).toMatchObject({ goal: { date: "2026-02-28" } });
    expect(() =>
      PlanCreationAnswerInputSchema.parse({
        kind: "goal",
        goal: { kind: "event-manual", name: "Tour", date: "2026-02-31" },
      }),
    ).toThrow();
    expect(() => PlanCreationCardModelSchema.parse({ ...card, version: 0 })).toThrow();
    expect(() =>
      PlanCreationStartRpcParamsSchema.parse({ commandId: "start", extra: true }),
    ).toThrow();
    expect(() =>
      PlanCreationAnswerRpcParamsSchema.parse({
        commandId: "answer",
        creationId,
        expectedVersion: 1,
        answer: answers[2],
        extra: true,
      }),
    ).toThrow();
  });

  it("accepts every terminal result and only the two registered operations", () => {
    expect(
      PlanCreationStartRpcResultSchema.parse({
        status: "started",
        outcome: "created",
        planCreation: card,
      }),
    ).toMatchObject({ outcome: "created" });
    expect(
      PlanCreationStartRpcResultSchema.parse({ status: "rejected", reason: "command-conflict" }),
    ).toMatchObject({ status: "rejected" });
    for (const reason of [
      "stale-version",
      "command-conflict",
      "no-unfinished-creation",
      "answer-not-expected",
      "invalid-answer",
    ] as const) {
      expect(
        PlanCreationAnswerRpcResultSchema.parse({ status: "rejected", reason, planCreation: null }),
      ).toEqual({ status: "rejected", reason, planCreation: null });
    }
    expect(COACH_RPC_METHOD_NAMES.filter((name) => name.startsWith("plan_creation."))).toEqual([
      "plan_creation.start",
      "plan_creation.answer",
    ]);
  });

  it("registers strict start and answer envelopes without events", () => {
    const requests = [
      { method: "plan_creation.start", params: { commandId: "start" } },
      {
        method: "plan_creation.answer",
        params: { commandId: "answer", creationId, expectedVersion: 1, answer: answers[2] },
      },
    ] as const;
    requests.forEach((request, id) =>
      expect(CoachRpcRequestEnvelopeSchema.parse({ jsonrpc: "2.0", id, ...request }).method).toBe(
        request.method,
      ),
    );
    for (const method of ["plan_creation.start", "plan_creation.answer"] as const) {
      expect(COACH_RPC_METHOD_REGISTRY[method].eventSchema.safeParse({}).success).toBe(false);
    }
  });
});
