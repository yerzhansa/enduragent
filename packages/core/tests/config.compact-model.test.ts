import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupConfigEnvSandbox } from "./helpers/config-env-sandbox.js";

const tempHome = setupConfigEnvSandbox("cc-compactmodel-");

function writeYaml(body: string): void {
  writeFileSync(join(tempHome(), ".cycling-coach", "config.yaml"), body, "utf-8");
}

describe("config — compact-model resolution", () => {
  it("provider anthropic, no knob → the Haiku background default", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.compactModel).toBe("claude-haiku-4-5-20251001");
  });

  it("provider openrouter, no knob → the DeepSeek background default", async () => {
    process.env.LLM_PROVIDER = "openrouter";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.compactModel).toBe("deepseek/deepseek-v4-flash");
  });

  it("provider openai (no background slot), no knob → the chat model", async () => {
    process.env.LLM_PROVIDER = "openai";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.llm.compactModel).toBe(cfg.llm.model);
  });

  it("env LLM_COMPACT_MODEL beats yaml llm.compact_model", async () => {
    writeYaml("llm:\n  provider: anthropic\n  compact_model: claude-haiku-4-5-20251001\n");
    process.env.LLM_COMPACT_MODEL = "claude-sonnet-4-6";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.compactModel).toBe("claude-sonnet-4-6");
  });

  it("yaml llm.compact_model beats the per-provider default", async () => {
    writeYaml("llm:\n  provider: anthropic\n  compact_model: claude-sonnet-4-6\n");
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.compactModel).toBe("claude-sonnet-4-6");
  });

  it("provider openai-codex ignores LLM_COMPACT_MODEL and stays on the chat model", async () => {
    process.env.LLM_PROVIDER = "openai-codex";
    process.env.LLM_COMPACT_MODEL = "claude-haiku-4-5-20251001";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.llm.compactModel).toBe(cfg.llm.model);
  });

  it("contextWindowForModel returns per-model windows with a 200k fallback", async () => {
    const { contextWindowForModel } = await import("../src/config.js");
    expect(contextWindowForModel("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(contextWindowForModel("no-such-model")).toBe(200_000);
    expect(contextWindowForModel("claude-sonnet-4-6")).toBe(200_000);
  });
});
