import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { TurnEvent } from "@enduragent/coach-contract";
import { CoachAgent } from "../src/agent/coach-agent.js";
import { createCoachEngine } from "../src/index.js";
import type { EngineHostPorts } from "../src/host-ports.js";
import type { GenerateOptions, GenerateResult, Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sport: Sport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: ["Ride"],
  athleteProfileSchema: z.object({}),
  tools: () => [],
};

function reply(
  text: string,
  finishReason: GenerateResult["finishReason"] = "stop",
): GenerateResult {
  return {
    text,
    toolCalls: [],
    finishReason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
    steps: 1,
  };
}

function harness(respond: (options: GenerateOptions) => GenerateResult) {
  const root = mkdtempSync(join(tmpdir(), "generate-turn-id-"));
  roots.push(root);
  mkdirSync(join(root, "memory"));
  const calls: GenerateOptions[] = [];
  const ports: EngineHostPorts = {
    ...baseAgentConfig(root),
    modelTransportDecorator: () => ({
      generate: async (request) => {
        calls.push(request.options);
        return respond(request.options);
      },
    }),
  };
  return { ports, calls };
}

function chat(agent: CoachAgent, chatId: string, text: string, turnId: string) {
  return agent.chat(chatId, text, undefined, undefined, undefined, turnId);
}

describe("every model call in a turn carries that turn's ID", () => {
  it("passes the turn ID to the chat call and to step-limit recovery", async () => {
    const { ports, calls } = harness((options) =>
      options.tools === undefined ? reply("Ride easy for an hour today.") : reply("", "tool-calls"),
    );
    const agent = new CoachAgent(sport, ports);

    await expect(
      chat(agent, "chat-steps", "What should I ride today?", "turn-steps"),
    ).resolves.toContain("Ride easy for an hour today.");

    expect(
      calls.map((call) => ({
        caller: call.caller,
        recovery: call.tools === undefined,
        turnId: call.turnId,
      })),
    ).toEqual([
      { caller: "chat", recovery: false, turnId: "turn-steps" },
      { caller: "chat", recovery: true, turnId: "turn-steps" },
    ]);
  });

  it("passes the turn ID to the memory flush and compaction an overflow triggers", async () => {
    let overflowNext = false;
    const { ports, calls } = harness((options) => {
      if (options.caller === "flush") return reply("Nothing new to save.");
      if (options.caller === "compact")
        return reply("## Athlete Profile\n- Rides three days a week");
      if (overflowNext) {
        overflowNext = false;
        throw new Error("Request exceeds the maximum context length of 272000 tokens");
      }
      return reply("Noted.");
    });
    const agent = new CoachAgent(sport, ports);
    await chat(agent, "chat-overflow", "I rode two hours yesterday.", "turn-earlier-1");
    await chat(agent, "chat-overflow", "My legs feel fine today.", "turn-earlier-2");
    await agent.settle("chat-overflow");
    calls.length = 0;
    overflowNext = true;

    await expect(chat(agent, "chat-overflow", "Plan my week.", "turn-overflow")).resolves.toContain(
      "Noted.",
    );
    await agent.settle("chat-overflow");

    const callers = calls.map((call) => call.caller);
    expect(callers).toEqual(expect.arrayContaining(["chat", "flush", "compact"]));
    expect(callers.filter((caller) => caller === "chat")).toHaveLength(2);
    expect(calls.map((call) => call.turnId)).toEqual(calls.map(() => "turn-overflow"));
  });

  it("passes each decision continuation its own turn ID", async () => {
    let failNext = true;
    const { ports, calls } = harness(() => {
      if (failNext) {
        failNext = false;
        throw new Error("continuation provider failure");
      }
      return reply("Keep tomorrow easy, then reassess.");
    });
    const ids = ["continuation-1", "turn-answer", "turn-resume"];
    const coachDecisions = ports.coachDecisions;
    if (coachDecisions === undefined) throw new Error("Coach decisions are not configured.");
    const engine = createCoachEngine({
      sport,
      ports: { ...ports, randomId: () => ids.shift() ?? "unused" },
    });
    coachDecisions.appendDecisionRequested({
      turnId: "turn-decision",
      decision: {
        status: "unanswered",
        decisionId: "decision-1",
        chatId: "chat-decision",
        messageId: "message-1",
        question: "Choose tomorrow's priority.",
        options: [
          {
            id: "recovery",
            label: "Recovery",
            description: "Ride easy.",
            recommended: true,
            consequence: "Tomorrow becomes a recovery day.",
          },
          {
            id: "tempo",
            label: "Tempo",
            description: "Keep the planned work.",
            recommended: false,
            consequence: "Tomorrow keeps the tempo session.",
          },
        ],
      },
      toolCallId: "tool-1",
      athleteText: "What should I do tomorrow?",
      requestedAt: "1998-08-24T00:00:00.000Z",
    });
    const starts: string[] = [];
    const onEvent = (event: TurnEvent): void => {
      if (event.type === "turn-start") starts.push(event.turnId);
    };

    await expect(
      engine.answerCoachDecision(
        {
          chatId: "chat-decision",
          decisionId: "decision-1",
          answer: { kind: "option", optionId: "recovery" },
        },
        onEvent,
      ),
    ).rejects.toThrow("continuation provider failure");
    await engine.resumeCoachDecision(
      { chatId: "chat-decision", decisionId: "decision-1" },
      onEvent,
    );

    expect(starts).toEqual(["turn-answer", "turn-resume"]);
    expect(calls.map((call) => call.turnId)).toEqual(starts);
  });
});
