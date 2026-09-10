import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanIntakePatch } from "@enduragent/coach-contract";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createEngineHostAdapter } from "../../core/src/agent/engine-host-adapter.js";
import { legacyStateReader } from "../../core/src/agent/legacy-athlete-state-reader.js";
import type { Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import {
  assertPlanCoachReplyAuthority,
  PlanCoachAuthorityError,
} from "../src/agent/plan-coach-authority.js";

let root: string;
let priorHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plan-coach-authority-"));
  priorHome = process.env.HOME;
  process.env.HOME = root;
  mkdirSync(join(root, "data", "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function response(input: {
  readonly text?: string;
  readonly tool?: { readonly id: string; readonly name: string; readonly arguments: unknown };
}) {
  return {
    text: input.tool === undefined ? (input.text ?? "") : "",
    toolCalls:
      input.tool === undefined
        ? []
        : [
            {
              id: input.tool.id,
              name: input.tool.name,
              arguments: input.tool.arguments,
            },
          ],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: input.tool === undefined ? ("stop" as const) : ("toolUse" as const),
  };
}

describe("Plan coach authority", () => {
  it("rejects copy that claims Plan or calendar mutation before approval", () => {
    expect(() =>
      assertPlanCoachReplyAuthority(
        "Once you pick, I'll save and then start pushing week 1 workouts to your calendar.",
      ),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority(
        "The Plan will be saved and workouts will be pushed to your calendar.",
      ),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority("After you choose, I can push the workouts to your calendar."),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority("Next I can save the Plan and send it to Intervals."),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority("I’ll begin writing your workouts to Intervals."),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority("I can schedule your workouts in the calendar."),
    ).toThrow(PlanCoachAuthorityError);
    expect(() => assertPlanCoachReplyAuthority("I can sync the Plan to Intervals.")).toThrow(
      PlanCoachAuthorityError,
    );
    expect(() =>
      assertPlanCoachReplyAuthority(
        "Sample week shape: Endurance Z2, 60min; Sweet spot, 75min; Long ride, 2.5h.",
      ),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority(
        "I am going to activate your Plan and sync workouts to Intervals.",
      ),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority(
        "Training plan: Endurance Z2, 60 min; Sweet spot, 75 min; Long ride, 2.5h.",
      ),
    ).toThrow(PlanCoachAuthorityError);
    expect(() =>
      assertPlanCoachReplyAuthority("I have enough information to create your Draft."),
    ).not.toThrow();
  });

  it("records typed intake while withholding Plan and calendar write tools", async () => {
    const requests: unknown[] = [];
    const complete = vi.fn(
      async (request: { readonly system?: string; readonly messages?: unknown[] }) => {
        if ((request.system ?? "").includes("reviewing a conversation to extract and save")) {
          return response({ text: "facts noted" });
        }
        if ((request.system ?? "") === "") return response({ text: "summary" });
        requests.push(request);
        const hasToolResult = (request.messages ?? []).some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { readonly role?: unknown }).role === "tool",
        );
        return hasToolResult
          ? response({ text: "How many rides can you do each week?" })
          : response({
              tool: {
                id: "intake-1",
                name: "record_plan_intake",
                arguments: {
                  eventName: "Gran Fondo Almaty",
                  targetDate: "2026-10-04",
                  goal: "Finish in the front half",
                },
              },
            });
      },
    );
    vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));
    const config = baseAgentConfig(join(root, "data"));
    const ports = createEngineHostAdapter({ config, stateReader: legacyStateReader }).ports;
    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    const agent = new CoachAgent(cyclingSport as unknown as Sport, {
      ...ports,
      getAccessToken: async () => "token",
      transcriptWriter: { appendCompletedTurn: () => undefined },
    });
    let patch: PlanIntakePatch | undefined;

    await expect(
      agent.chat(
        "plan:01KPLANCONVERSATION0000000",
        "Gran Fondo Almaty on 4 October; front half.",
        undefined,
        undefined,
        undefined,
        undefined,
        (value) => {
          patch = value;
        },
      ),
    ).resolves.toBe("How many rides can you do each week?");

    expect(patch).toEqual({
      eventName: "Gran Fondo Almaty",
      targetDate: "2026-10-04",
      goal: "Finish in the front half",
    });
    const payload = JSON.stringify(requests);
    const tools = (requests[0] as { readonly tools?: Record<string, unknown> }).tools ?? {};
    expect(payload).toContain("record_plan_intake");
    expect(payload).toContain("dedicated Plan intake coach");
    expect(Object.keys(tools).sort()).toEqual(["record_plan_intake", "request_user_decision"]);
  });

  it("returns accumulated Plan intake when the same turn requests a decision", async () => {
    let planCall = 0;
    const complete = vi.fn(async (request: { readonly system?: string }) => {
      if ((request.system ?? "").includes("reviewing a conversation to extract and save")) {
        return response({ text: "facts noted" });
      }
      if ((request.system ?? "") === "") return response({ text: "summary" });
      planCall += 1;
      return planCall === 1
        ? response({
            tool: {
              id: "intake-before-decision",
              name: "record_plan_intake",
              arguments: {
                eventName: "Gran Fondo Almaty",
                targetDate: "2026-10-04",
              },
            },
          })
        : response({
            tool: {
              id: "availability-decision",
              name: "request_user_decision",
              arguments: {
                question: "Which four days work best?",
                options: [
                  {
                    label: "Tue, Thu, Sat, Sun",
                    description: "Keep both weekend days.",
                    recommended: true,
                    consequence: "Use Tuesday, Thursday, Saturday, and Sunday.",
                  },
                  {
                    label: "Mon, Wed, Fri, Sun",
                    description: "Spread the rides through the week.",
                    recommended: false,
                    consequence: "Use Monday, Wednesday, Friday, and Sunday.",
                  },
                ],
              },
            },
          });
    });
    vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));
    const config = baseAgentConfig(join(root, "data"));
    const ports = createEngineHostAdapter({ config, stateReader: legacyStateReader }).ports;
    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    const agent = new CoachAgent(cyclingSport as unknown as Sport, {
      ...ports,
      getAccessToken: async () => "token",
      transcriptWriter: { appendCompletedTurn: () => undefined },
    });
    let patch: PlanIntakePatch | undefined;
    let decisionId: string | undefined;

    await expect(
      agent.chat(
        "plan:01KPLANPATCHDECISION00000",
        "Gran Fondo Almaty is on 4 October.",
        undefined,
        undefined,
        (decision) => {
          decisionId = decision.decisionId;
        },
        undefined,
        (value) => {
          patch = value;
        },
      ),
    ).resolves.toBe("");

    expect(patch).toEqual({
      eventName: "Gran Fondo Almaty",
      targetDate: "2026-10-04",
    });
    expect(decisionId).toBeTypeOf("string");
  });

  it("defers generic history for a prepared Plan turn until explicit commit", async () => {
    const complete = vi.fn(
      async (request: { readonly system?: string; readonly messages?: unknown[] }) => {
        if ((request.system ?? "").includes("reviewing a conversation to extract and save")) {
          return response({ text: "facts noted" });
        }
        if ((request.system ?? "") === "") return response({ text: "summary" });
        const recorded = (request.messages ?? []).some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { readonly role?: unknown }).role === "tool",
        );
        return recorded
          ? response({ text: "What is your weekly availability?" })
          : response({
              tool: {
                id: "deferred-intake",
                name: "record_plan_intake",
                arguments: { eventName: "Gran Fondo Almaty" },
              },
            });
      },
    );
    vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));
    const config = baseAgentConfig(join(root, "data"));
    const ports = createEngineHostAdapter({ config, stateReader: legacyStateReader }).ports;
    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    type Deferred = import("../src/agent/coach-agent.js").DeferredPlanTurn;
    const agent = new CoachAgent(cyclingSport as unknown as Sport, {
      ...ports,
      getAccessToken: async () => "token",
      transcriptWriter: { appendCompletedTurn: () => undefined },
    });
    const chatId = "plan:01KPLANDEFERREDTURN00000";
    let deferred: Deferred | undefined;

    await expect(
      agent.chat(
        chatId,
        "Gran Fondo Almaty.",
        undefined,
        undefined,
        undefined,
        "deferred-plan-turn",
        undefined,
        (turn) => {
          deferred = turn;
        },
      ),
    ).resolves.toBe("What is your weekly availability?");

    expect(ports.chatStore.hasSession(chatId)).toBe(false);
    expect(deferred).toMatchObject({
      chatId,
      turnId: "deferred-plan-turn",
      athleteText: "Gran Fondo Almaty.",
      sentAthleteText: expect.stringMatching(/^Gran Fondo Almaty\.\nCurrent time: /),
      coachText: "What is your weekly availability?",
      planIntakePatch: { eventName: "Gran Fondo Almaty" },
    });
    agent.commitDeferredPlanTurn(deferred!);
    expect(ports.chatStore.load(chatId).messages).toMatchObject([
      { role: "user", content: deferred!.sentAthleteText },
      { role: "assistant", content: "What is your weekly availability?" },
    ]);
  });

  it("continues Plan decisions with the Plan prompt, tools, authority, and typed intake", async () => {
    const requests: Array<{
      readonly system?: string;
      readonly messages?: unknown[];
      readonly tools?: Record<string, unknown>;
    }> = [];
    const complete = vi.fn(
      async (request: {
        readonly system?: string;
        readonly messages?: unknown[];
        readonly tools?: Record<string, unknown>;
      }) => {
        if ((request.system ?? "").includes("reviewing a conversation to extract and save")) {
          return response({ text: "facts noted" });
        }
        if ((request.system ?? "") === "") return response({ text: "summary" });
        requests.push(request);
        const recorded = (request.messages ?? []).some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            (message as { readonly role?: unknown }).role === "tool" &&
            JSON.stringify(message).includes("record_plan_intake"),
        );
        return recorded
          ? response({ text: "Thanks. The app has enough information to create a Draft." })
          : response({
              tool: {
                id: "intake-continuation",
                name: "record_plan_intake",
                arguments: {
                  availability: {
                    sessionsPerWeek: 4,
                    weekdays: ["tue", "thu", "sat", "sun"],
                  },
                },
              },
            });
      },
    );
    vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));
    const config = baseAgentConfig(join(root, "data"));
    const ports = createEngineHostAdapter({ config, stateReader: legacyStateReader }).ports;
    const chatId = "plan:01KPLANDECISION000000000";
    ports.coachDecisions!.appendDecisionRequested({
      turnId: "decision-turn",
      toolCallId: "decision-tool",
      athleteText: "I can ride four days each week.",
      requestedAt: "1998-08-24T00:00:00.000Z",
      planIntakePatch: {
        eventName: "Gran Fondo Almaty",
        targetDate: "1998-10-04",
      },
      decision: {
        status: "unanswered",
        decisionId: "decision-1",
        chatId,
        messageId: "message-1",
        question: "Which four days work best?",
        options: [
          {
            id: "weekdays-1",
            label: "Tue, Thu, Sat, Sun",
            description: "Keep two weekday rides and both weekend days.",
            recommended: true,
            consequence: "Availability is Tuesday, Thursday, Saturday, and Sunday.",
          },
          {
            id: "weekdays-2",
            label: "Mon, Wed, Fri, Sun",
            description: "Spread four rides across the week.",
            recommended: false,
            consequence: "Availability is Monday, Wednesday, Friday, and Sunday.",
          },
        ],
      },
    });
    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    const agent = new CoachAgent(cyclingSport as unknown as Sport, {
      ...ports,
      getAccessToken: async () => "token",
      transcriptWriter: { appendCompletedTurn: () => undefined },
    });
    const events: Array<{ readonly type: string }> = [];

    const result = await agent.answerCoachDecision(
      {
        chatId,
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "weekdays-1" },
      },
      (event) => events.push(event),
    );

    expect(result.decision).toMatchObject({
      status: "answered",
      continuation: {
        status: "completed",
        coachText: "Thanks. The app has enough information to create a Draft.",
        lineage: {
          planIntakePatch: {
            eventName: "Gran Fondo Almaty",
            targetDate: "1998-10-04",
            availability: {
              sessionsPerWeek: 4,
              weekdays: ["tue", "thu", "sat", "sun"],
            },
          },
        },
      },
    });
    expect(events.map((event) => event.type)).toEqual(["turn-start", "final-text"]);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.system).toContain("dedicated Plan intake coach");
      expect(request.system).toContain("# Decision Continuation");
      expect(Object.keys(request.tools ?? {}).sort()).toEqual([
        "record_plan_intake",
        "request_user_decision",
      ]);
    }
  });

  it("rejects a mutation claim produced by a Plan decision continuation", async () => {
    const complete = vi.fn(async (request: { readonly system?: string }) => {
      if ((request.system ?? "").includes("reviewing a conversation to extract and save")) {
        return response({ text: "facts noted" });
      }
      if ((request.system ?? "") === "") return response({ text: "summary" });
      return response({ text: "I will save the Plan and push workouts to your calendar." });
    });
    vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));
    const config = baseAgentConfig(join(root, "data"));
    const ports = createEngineHostAdapter({ config, stateReader: legacyStateReader }).ports;
    const chatId = "plan:01KPLANAUTHORITY00000000";
    ports.coachDecisions!.appendDecisionRequested({
      turnId: "decision-turn",
      toolCallId: "decision-tool",
      athleteText: "Use the recommended option.",
      requestedAt: "1998-08-24T00:00:00.000Z",
      decision: {
        status: "unanswered",
        decisionId: "decision-1",
        chatId,
        messageId: "message-1",
        question: "Choose one.",
        options: [
          {
            id: "one",
            label: "One",
            description: "Use one.",
            recommended: true,
            consequence: "Use one.",
          },
          {
            id: "two",
            label: "Two",
            description: "Use two.",
            recommended: false,
            consequence: "Use two.",
          },
        ],
      },
    });
    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    const agent = new CoachAgent(cyclingSport as unknown as Sport, {
      ...ports,
      getAccessToken: async () => "token",
      transcriptWriter: { appendCompletedTurn: () => undefined },
    });

    await expect(
      agent.answerCoachDecision({
        chatId,
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "one" },
      }),
    ).rejects.toThrow("Plan coach claimed a state mutation outside its authority.");
  });
});
