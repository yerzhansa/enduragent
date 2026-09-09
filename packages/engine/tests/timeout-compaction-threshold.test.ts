import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";
import {
  effectiveEstimatorWindowTokens,
  estimatePromptTokens,
  estimateTokens,
  RESERVE_TOKENS,
  TIMEOUT_COMPACTION_THRESHOLD,
} from "../src/agent/token-utils.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-timeout-compaction-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";
const WINDOW = 1_000_000;
const EFFECTIVE_BUDGET = effectiveEstimatorWindowTokens(WINDOW) - RESERVE_TOKENS;
const FILLER_CHARS = 8_000;
const FRESH_TS = new Date().toISOString();

function mkAssistant(text: string) {
  return {
    text,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop" as const,
  };
}

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

async function setupAgent(complete: ReturnType<typeof vi.fn>, summarize: ReturnType<typeof vi.fn>) {
  vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
  vi.doMock("../src/agent/codex/oauth.js", () => ({ refreshCodexToken: vi.fn(), loginCodex: vi.fn() }));
  vi.doMock("../src/auth/profiles.js", () => ({
    getFreshToken: vi.fn(async () => "token"),
    loadProfile: vi.fn(),
    saveProfile: vi.fn(),
    RefreshTokenReusedError: class extends Error {},
  }));
  vi.doMock("../src/agent/compaction.js", async () => {
    const actual = await vi.importActual<typeof import("../src/agent/compaction.js")>(
      "../src/agent/compaction.js",
    );
    return { ...actual, summarizeInStages: summarize };
  });

  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  const ports = baseAgentConfig(dataDir);
  return new CoachAgent(cyclingSport as unknown as Sport, {
    ...ports,
    config: {
      ...ports.config,
      session: { ...ports.config.session, historyTokenBudgetRatio: 1 },
      contextWindowTokens: WINDOW,
      compactContextWindowTokens: WINDOW,
    },
  });
}

function seedSession(chatId: string, messageTokens: number): void {
  const lines: Array<{ role: string; content: string; ts: string }> = [];
  let remaining = messageTokens;
  let i = 0;
  while (remaining > 0) {
    const chars = Math.min(FILLER_CHARS, Math.max(4, Math.floor((remaining * 4) / 1.2)));
    const content = `MARK-${i} ` + "x".repeat(chars);
    lines.push({ role: i % 2 === 0 ? "user" : "assistant", content, ts: FRESH_TS });
    remaining -= estimateTokens(content);
    i++;
  }
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${chatId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

async function runTimeoutTurn(promptFraction: number) {
  const seen: Array<{ system: string; messages: ModelMessage[] }> = [];
  let mainTurns = 0;
  const complete = vi.fn(async (params: { system?: string; messages: ModelMessage[] }) => {
    const sys = params.system ?? "";
    if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
    mainTurns++;
    seen.push({ system: sys, messages: params.messages });
    if (mainTurns === 1) throw timeoutError();
    return mkAssistant("recovered");
  });
  const summarize = vi.fn(async (params: { messages: ModelMessage[] }) => ({
    messages: params.messages.slice(-2),
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = await setupAgent(complete, summarize);

  const probeReply = await agent.chat("probe", "hi");
  expect(probeReply).toBe("recovered");
  const systemTokens = estimateTokens(seen[0].system);
  seen.length = 0;
  mainTurns = 0;

  seedSession("timeout-chat", Math.floor(promptFraction * EFFECTIVE_BUDGET) - systemTokens);
  const reply = await agent.chat("timeout-chat", "hello");

  const observedRatio =
    estimatePromptTokens({ messages: seen[0].messages, systemPrompt: seen[0].system }) /
    EFFECTIVE_BUDGET;
  expect(observedRatio).toBeGreaterThan(promptFraction - 0.02);
  expect(observedRatio).toBeLessThan(promptFraction + 0.02);
  return { reply, summarize, mainTurns };
}

describe("timeout compaction threshold on a 1M-token window", () => {
  it("compacts before retrying when the prompt fills 70% of the effective budget", async () => {
    expect(TIMEOUT_COMPACTION_THRESHOLD).toBe(0.65);
    const { reply, summarize, mainTurns } = await runTimeoutTurn(0.7);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(mainTurns).toBe(2);
    expect(reply).toBe("recovered");
  });

  it("retries without compaction when the prompt fills 60% of the effective budget", async () => {
    const { reply, summarize, mainTurns } = await runTimeoutTurn(0.6);
    expect(summarize).not.toHaveBeenCalled();
    expect(mainTurns).toBe(2);
    expect(reply).toBe("recovered");
  });
});
