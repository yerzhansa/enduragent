import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Memory } from "../../core/src/memory/store.js";
import { createCoachEngine } from "../src/index.js";
import type { ModelTransportRequest } from "../src/host-ports.js";
import type { GenerateResult, Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const dirs: string[] = [];

const sport: Sport = {
  id: "cycling",
  soul: "Synthetic coach",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: [],
  athleteProfileSchema: z.object({}),
  tools: () => [],
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-plan-read-gate-"));
  dirs.push(dataDir);
  let authority = false;
  const memory = new Memory(dataDir, "UTC", {
    planReadGate: async () =>
      authority
        ? "This Plan is managed in Chat. Open the Plan page or ask in Chat about your Plan."
        : null,
  });
  memory.savePlan({ name: "Synthetic file Plan" });
  const ports = baseAgentConfig(dataDir);
  const prompts: string[] = [];
  const engine = createCoachEngine({
    sport,
    ports: {
      ...ports,
      memory,
      modelTransportDecorator: () => ({
        async generate(request: ModelTransportRequest): Promise<GenerateResult> {
          prompts.push(request.options.system ?? "");
          return {
            text: "Keep tomorrow easy.",
            toolCalls: [],
            finishReason: "stop",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
            },
          };
        },
      }),
    },
  });
  return {
    engine,
    prompts,
    decisions: ports.coachDecisions,
    claimAuthority: () => {
      authority = true;
    },
  };
}

describe("coach prompt Plan read gate refresh", () => {
  it.each(["desktop", "plan:synthetic"])(
    "refreshes before each chat prompt for %s",
    async (chatId) => {
      const { engine, prompts, claimAuthority } = setup();

      await engine.chat({ chatId, message: "Show my Plan." });
      expect(prompts.at(-1)).toContain("## Current Plan");
      expect(prompts.at(-1)).toContain("Synthetic file Plan");

      claimAuthority();
      await engine.chat({ chatId, message: "Show my Plan again." });

      expect(prompts.at(-1)).not.toContain("## Current Plan");
    },
  );

  it.each(["desktop", "plan:synthetic"])(
    "refreshes before a decision continuation prompt for %s",
    async (chatId) => {
      const { engine, prompts, decisions, claimAuthority } = setup();
      if (decisions === undefined) throw new Error("Decision store is required");
      await engine.chat({ chatId, message: "Show my Plan." });
      expect(prompts.at(-1)).toContain("## Current Plan");
      decisions.appendDecisionRequested({
        turnId: "decision-turn",
        toolCallId: "decision-tool",
        athleteText: "Choose tomorrow's priority.",
        requestedAt: "1998-09-07T00:00:00.000Z",
        decision: {
          status: "unanswered",
          decisionId: "decision-1",
          chatId,
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
      });

      claimAuthority();
      await engine.answerCoachDecision({
        chatId,
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "recovery" },
      });

      expect(prompts.at(-1)).toContain("# Decision Continuation");
      expect(prompts.at(-1)).not.toContain("## Current Plan");
    },
  );
});
