import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CoachAgent } from "../src/agent/coach-agent.js";
import {
  CONFIRMATION_GATE_RULES,
  buildSystemPrompt,
  staticRuleBlocks,
} from "../src/agent/system-prompt.js";
import type { EngineHostPorts, ToolConfirmationPort } from "../src/host-ports.js";
import type { MemoryStorePort } from "../src/host-ports.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

const emptyMemory = { getContext: () => "" } as unknown as MemoryStorePort;

const gatePort: ToolConfirmationPort = {
  gatedToolNames: new Set(["plan_save"]),
  requiresConfirmation: () => true,
  propose: async () => ({ pendingConfirmation: true, summary: "unused" }),
};

const emptyGatePort: ToolConfirmationPort = {
  gatedToolNames: new Set<string>(),
  requiresConfirmation: () => false,
  propose: async () => ({}),
};

function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-gate-prompt-"));
  roots.push(root);
  const dataDir = join(root, ".cycling-coach");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  return dataDir;
}

async function capturedSystemPrompt(
  toolConfirmations: ToolConfirmationPort | undefined,
): Promise<string> {
  const base = baseAgentConfig(makeDataDir());
  let system = "";
  const ports: EngineHostPorts = {
    ...base,
    toolConfirmations,
    transcriptWriter: { appendCompletedTurn: () => undefined },
    modelTransportDecorator: () => ({
      generate: async (request) => {
        system = request.options.system ?? "";
        const usage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        };
        return {
          text: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage,
          totalUsage: usage,
          steps: 1,
        };
      },
    }),
  };
  await new CoachAgent(cyclingSport, ports).chat("chat-1", "hi");
  return system;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("confirmation-gate prompt block is host-conditional", () => {
  it("omits the block from the default rule-block set", () => {
    const blocks = staticRuleBlocks();
    expect(blocks.some((b) => b.includes(CONFIRMATION_GATE_RULES))).toBe(false);
    expect(buildSystemPrompt(cyclingSport, emptyMemory, "UTC")).not.toContain(
      "# Mutation Confirmations",
    );
  });

  it("fuses the block onto the untrusted-data block for a gating host", () => {
    const blocks = staticRuleBlocks(30, { confirmationGate: true });
    const ungated = staticRuleBlocks();
    expect(blocks).toHaveLength(ungated.length);
    expect(blocks[0]).toBe(ungated[0] + "\n\n" + CONFIRMATION_GATE_RULES);
    expect(
      buildSystemPrompt(cyclingSport, emptyMemory, "UTC", undefined, { confirmationGate: true }),
    ).toContain("# Mutation Confirmations");
  });

  it("keeps workout preparation exclusive of per-workout confirmation", () => {
    const blocks = staticRuleBlocks(30, { confirmationGate: true, workoutPreparation: true });
    const text = blocks.join("\n");
    expect(text).toContain("# Workout Set Review");
    expect(text).toContain("plan_save");
    expect(text).not.toContain(CONFIRMATION_GATE_RULES);
    expect(text).not.toContain("scheduling a whole week");
  });

  it("keeps the block out of an auto-approving host's assembled prompt", async () => {
    expect(await capturedSystemPrompt(undefined)).not.toContain("# Mutation Confirmations");
    expect(await capturedSystemPrompt(emptyGatePort)).not.toContain("# Mutation Confirmations");
  });

  it("puts the block into a gating host's assembled prompt", async () => {
    expect(await capturedSystemPrompt(gatePort)).toContain("# Mutation Confirmations");
  });
});
