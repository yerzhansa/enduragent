import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CoachAgent } from "../src/agent/coach-agent.js";
import type { EngineHostPorts } from "../src/host-ports.js";
import type { Sport } from "../src/sport.js";
import type { LLM } from "../src/llm.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { testModelProfiles } from "./helpers/model-profiles.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-role-routing-"));
  mkdirSync(join(dataDir, "memory"), { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeConfig(overrides: {
  model?: string;
  compactModel?: string;
  flushModel?: string;
  contextWindowTokens?: number;
  compactContextWindowTokens?: number;
}): EngineHostPorts {
  const ports = baseAgentConfig(dataDir);
  return {
    ...ports,
    config: {
      ...ports.config,
      llm: {
        provider: "anthropic",
        model: overrides.model ?? "claude-sonnet-4-6",
        apiKey: "test-key",
        flushModel: overrides.flushModel,
        compactModel: overrides.compactModel,
      },
      models: testModelProfiles({
        provider: "anthropic",
        chat: overrides.model ?? "claude-sonnet-4-6",
        compact: overrides.compactModel,
        flush: overrides.flushModel,
        chatContextWindowTokens: overrides.contextWindowTokens ?? 1_000_000,
        compactContextWindowTokens:
          overrides.compactContextWindowTokens ?? overrides.contextWindowTokens ?? 1_000_000,
      }),
      contextWindowTokens: overrides.contextWindowTokens ?? 1_000_000,
      compactContextWindowTokens:
        overrides.compactContextWindowTokens ?? overrides.contextWindowTokens ?? 1_000_000,
    },
  };
}

function privates(agent: CoachAgent) {
  return agent as unknown as {
    llm: LLM;
    flushLlm: LLM;
    compactLlm: LLM;
    compactContextWindowTokens: number;
  };
}

describe("CoachAgent role→model routing", () => {
  it("builds a distinct compact instance when compactModel differs from the chat model", () => {
    const agent = new CoachAgent(
      cyclingSport as unknown as Sport,
      makeConfig({ model: "claude-sonnet-4-6", compactModel: "claude-haiku-4-5-20251001" }),
    );
    const p = privates(agent);
    expect(p.compactLlm).not.toBe(p.llm);
  });

  it("aliases the compact lane to the chat instance when compactModel equals the chat model", () => {
    const agent = new CoachAgent(
      cyclingSport as unknown as Sport,
      makeConfig({ model: "claude-sonnet-4-6", compactModel: "claude-sonnet-4-6" }),
    );
    const p = privates(agent);
    expect(p.compactLlm).toBe(p.llm);
  });

  it("aliases the compact lane to the flush instance when compactModel equals flushModel (≠ chat)", () => {
    const agent = new CoachAgent(
      cyclingSport as unknown as Sport,
      makeConfig({
        model: "claude-sonnet-4-6",
        compactModel: "claude-haiku-4-5-20251001",
        flushModel: "claude-haiku-4-5-20251001",
      }),
    );
    const p = privates(agent);
    expect(p.compactLlm).toBe(p.flushLlm);
    expect(p.flushLlm).not.toBe(p.llm);
  });

  it("defaults the compact lane to the chat instance and window when compactModel is absent", () => {
    const config = makeConfig({ model: "claude-sonnet-4-6", contextWindowTokens: 1_000_000 });
    const agent = new CoachAgent(cyclingSport as unknown as Sport, config);
    const p = privates(agent);
    expect(p.compactLlm).toBe(p.llm);
    expect(p.compactContextWindowTokens).toBe(config.config.contextWindowTokens);
  });

  it("sizes the compact window off the compact model, not the 1M chat window", () => {
    const agent = new CoachAgent(
      cyclingSport as unknown as Sport,
      makeConfig({
        model: "claude-sonnet-4-6",
        compactModel: "claude-haiku-4-5-20251001",
        contextWindowTokens: 1_000_000,
        compactContextWindowTokens: 200_000,
      }),
    );
    const p = privates(agent);
    expect(p.compactContextWindowTokens).toBe(200_000);
  });
});
