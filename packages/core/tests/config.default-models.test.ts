import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MANAGED_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ALIBABA_API_KEY",
  "MINIMAX_API_KEY",
  "MOONSHOT_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_API_KEY",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
  "TELEGRAM_BOT_TOKEN",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "CONTEXT_WINDOW_TOKENS",
];

let tempHome: string;
let origHome: string | undefined;
let origCcHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-defaultmodels-"));
  origHome = process.env.HOME;
  origCcHome = process.env.CYCLING_COACH_HOME;
  process.env.HOME = tempHome;
  delete process.env.CYCLING_COACH_HOME;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  for (const k of MANAGED_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origCcHome !== undefined) process.env.CYCLING_COACH_HOME = origCcHome;
  else delete process.env.CYCLING_COACH_HOME;
  for (const k of MANAGED_ENV) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("config — default model and context-window resolution", () => {
  it("google provider with no model defaults to gemini-3.6-flash with a 1M window", async () => {
    process.env.LLM_PROVIDER = "google";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.llm.model).toBe("gemini-3.6-flash");
    expect(cfg.contextWindowTokens).toBe(1_048_576);
  });

  it("treats a model from another provider as custom with the conservative window", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.LLM_MODEL = "gemini-3.5-flash";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.contextWindowTokens).toBe(200_000);
  });

  it("openai provider with no model defaults to gpt-5.6-sol with a 1.05M window", async () => {
    process.env.LLM_PROVIDER = "openai";
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.llm.model).toBe("gpt-5.6-sol");
    expect(cfg.contextWindowTokens).toBe(1_050_000);
  });

  it.each([
    ["deepseek", "deepseek-v4-flash", 1_000_000],
    ["qwen", "qwen3.7-plus", 1_000_000],
    ["minimax", "MiniMax-M3", 1_000_000],
    ["kimi", "kimi-k3", 1_000_000],
    ["zai", "glm-4.7", 200_000],
    ["openrouter", "deepseek/deepseek-v4-flash", 1_000_000],
  ])("%s provider defaults to %s with the right window", async (provider, model, window) => {
    process.env.LLM_PROVIDER = provider;
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(cfg.llm.model).toBe(model);
    expect(cfg.contextWindowTokens).toBe(window);
  });

  it.each([
    ["deepseek", "https://api.deepseek.com/v1"],
    ["qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["minimax", "https://api.minimax.io/v1"],
    ["kimi", "https://api.moonshot.ai/v1"],
    ["zai", "https://api.z.ai/api/openai/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
  ])("%s resolves the per-provider default base URL", async (provider, baseUrl) => {
    process.env.LLM_PROVIDER = provider;
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.baseUrl).toBe(baseUrl);
  });

  it("LLM_BASE_URL env overrides the per-provider default", async () => {
    process.env.LLM_PROVIDER = "minimax";
    process.env.LLM_BASE_URL = "https://proxy.example/v1";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.baseUrl).toBe("https://proxy.example/v1");
  });

  it("built-in providers leave baseUrl undefined when no override is set", async () => {
    process.env.LLM_PROVIDER = "anthropic";
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig().llm.baseUrl).toBeUndefined();
  });
});
