import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AthleteState, CoachEngine } from "@enduragent/coach-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createCoachEngine } from "../src/index.js";
import type { ModelTransportDecorator } from "../src/host-ports.js";
import type { Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const state: AthleteState = {
  schemaVersion: "1",
  lastUpdated: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2026-07-18T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

const sport: Sport = {
  id: "cycling",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: [],
  athleteProfileSchema: {} as never,
  tools: () => [],
};

describe("createCoachEngine", () => {
  let dataDir: string;

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("returns the canonical contract and delegates state and chat behavior", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-contract-"));
    const decorator: ModelTransportDecorator = () => ({
      generate: async () => ({
        text: "unchanged reply",
        toolCalls: [],
        finishReason: "stop",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        },
        steps: 1,
      }),
    });
    const base = baseAgentConfig(dataDir);
    const engine: CoachEngine = createCoachEngine({
      sport,
      ports: {
        ...base,
        stateReader: { getAthleteState: async () => state },
        modelTransportDecorator: decorator,
      },
    });

    expect(Object.keys(engine).sort()).toEqual([
      "answerCoachDecision",
      "chat",
      "commitPlanChatTurn",
      "enqueueChatMessage",
      "getAthleteState",
      "getChatQueue",
      "getCoachDecision",
      "getPlanDecisionIntakePatch",
      "hasSession",
      "removeQueuedChatMessage",
      "replacePlanChatHistory",
      "resetSession",
      "resumeChatQueue",
      "resumeCoachDecision",
      "retryQueuedTurn",
      "runQueuedCommand",
      "settle",
      "skipCoachDecision",
      "stopChat",
      "translateIntent",
    ]);
    await expect(engine.hasSession({ chatId: "c1" })).resolves.toEqual({ hasSession: false });
    await expect(engine.chat({ chatId: "c1", message: "hello" })).resolves.toEqual({
      text: "unchanged reply",
    });
    await expect(engine.hasSession({ chatId: "c1" })).resolves.toEqual({ hasSession: true });
    let planTurnId = "";
    await expect(
      engine.chat({ chatId: "plan:c2", message: "hello" }, (event) => {
        if (event.type === "turn-start") planTurnId = event.turnId;
      }),
    ).resolves.toEqual({ text: "unchanged reply" });
    await expect(engine.hasSession({ chatId: "plan:c2" })).resolves.toEqual({
      hasSession: false,
    });
    await engine.commitPlanChatTurn?.({ chatId: "plan:c2", turnId: planTurnId });
    await expect(engine.hasSession({ chatId: "plan:c2" })).resolves.toEqual({ hasSession: true });
    await engine.replacePlanChatHistory?.({
      chatId: "plan:c2",
      turns: [{ athleteText: "restored athlete", coachText: "restored coach" }],
    });
    await expect(engine.hasSession({ chatId: "plan:c2" })).resolves.toEqual({ hasSession: true });
    await expect(engine.getAthleteState()).resolves.toBe(state);
  });
});
