import { describe, expect, it } from "vitest";
import {
  AnswerCoachDecisionRpcParamsSchema,
  COACH_RPC_METHOD_REGISTRY,
  CoachDecisionReadModelSchema,
  CoachTurnEventNotificationEnvelopeSchema,
  GetTranscriptPageRpcResultSchema,
  PROTOCOL_VERSION,
  RequestUserDecisionInputSchema,
  RequestUserDecisionResultSchema,
  ResumeCoachDecisionRpcResultSchema,
} from "../src/index.js";

const decision = {
  status: "unanswered",
  decisionId: "decision-1",
  chatId: "desktop",
  messageId: "message-1",
  question: "Choose tomorrow's priority.",
  options: [
    {
      id: "recovery",
      label: "Prioritize recovery",
      description: "Protect the weekend session.",
      recommended: true,
      consequence: "Tomorrow becomes an easy day.",
    },
    {
      id: "tempo",
      label: "Keep tempo",
      description: "Keep the planned session.",
      recommended: false,
      consequence: "Tomorrow keeps the tempo session.",
    },
  ],
} as const;

describe("coach decision wire contract", () => {
  it("bounds host-owned decision requests and allows at most one recommendation", () => {
    expect(
      RequestUserDecisionInputSchema.parse({
        question: decision.question,
        options: decision.options.map(({ id: _id, ...option }) => option),
      }).options,
    ).toHaveLength(2);
    expect(
      RequestUserDecisionInputSchema.safeParse({
        question: decision.question,
        options: decision.options.map(({ id: _id, ...option }) => ({
          ...option,
          recommended: true,
        })),
      }).success,
    ).toBe(false);
  });

  it("validates presented, answered, and skipped tool results", () => {
    expect(
      RequestUserDecisionResultSchema.parse({
        status: "answered",
        decisionId: decision.decisionId,
        answer: { kind: "option", optionId: "recovery" },
        consequence: "Tomorrow becomes an easy day.",
      }).status,
    ).toBe("answered");
    expect(
      RequestUserDecisionResultSchema.parse({
        status: "skipped",
        decisionId: decision.decisionId,
      }).status,
    ).toBe("skipped");
  });

  it("registers explicit decision RPCs and validates option answers", () => {
    expect(Object.keys(COACH_RPC_METHOD_REGISTRY)).toEqual(
      expect.arrayContaining([
        "getCoachDecision",
        "answerCoachDecision",
        "skipCoachDecision",
        "resumeCoachDecision",
      ]),
    );
    expect(
      AnswerCoachDecisionRpcParamsSchema.parse({
        chatId: decision.chatId,
        decisionId: decision.decisionId,
        answer: { kind: "option", optionId: "recovery" },
      }),
    ).toMatchObject({ decisionId: decision.decisionId });
    expect(
      CoachDecisionReadModelSchema.safeParse({
        ...decision,
        status: "answered",
        answer: { kind: "option", optionId: "missing" },
        consequence: "Missing",
        continuation: { continuationId: "continuation-1", status: "pending" },
      }).success,
    ).toBe(false);
  });

  it("streams chat, answer, and resume turns including a follow-up decision", () => {
    const event = { type: "turn-start", turnId: "turn-1", chatId: "desktop" } as const;
    for (const requestMethod of ["chat", "answerCoachDecision", "resumeCoachDecision"] as const) {
      expect(
        CoachTurnEventNotificationEnvelopeSchema.safeParse({
          jsonrpc: "2.0",
          method: "coach.turnEvent",
          params: { requestId: 1, requestMethod, turnId: "turn-1", event },
        }).success,
      ).toBe(true);
    }
    expect(
      CoachTurnEventNotificationEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        method: "coach.turnEvent",
        params: {
          requestId: 1,
          requestMethod: "answerCoachDecision",
          turnId: "turn-1",
          event: { type: "decision-requested", turnId: "turn-1", chatId: "desktop", decision },
        },
      }).success,
    ).toBe(true);
  });

  it("keeps v1 transcript pages and accepts ordered v2 decision entries", () => {
    expect(
      GetTranscriptPageRpcResultSchema.parse({
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: null,
      }),
    ).toEqual({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
    const parsed = GetTranscriptPageRpcResultSchema.parse({
      schemaVersion: 2,
      status: "page",
      turns: [],
      entries: [
        {
          kind: "decision-requested",
          recordedAt: "2026-08-24T00:00:00.000Z",
          athleteText: "Should I keep tomorrow's tempo session?",
          decision,
        },
      ],
      nextCursor: null,
    });
    expect(parsed.schemaVersion).toBe(2);
    if (parsed.schemaVersion !== 2) throw new Error("Expected decision transcript page.");
    expect(parsed.entries).toHaveLength(1);
  });

  it("projects resume completion explicitly at protocol 36", () => {
    expect(PROTOCOL_VERSION).toBe(36);
    expect(
      ResumeCoachDecisionRpcResultSchema.parse({
        resumed: true,
        decision: {
          ...decision,
          status: "answered",
          answer: { kind: "custom", text: "Keep it easy." },
          consequence: "Keep it easy.",
          continuation: {
            continuationId: "continuation-1",
            status: "completed",
            turnId: "turn-1",
            coachText: "I will keep tomorrow easy.",
          },
        },
      }).resumed,
    ).toBe(true);
  });
});
