import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

type Message = { role: string; content: unknown };
type Call = { system?: string; messages: Message[] };

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-persist-sent-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mkAssistant(text: string) {
  return {
    text,
    toolCalls: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop" as const,
  };
}

async function setupAgent(complete: ReturnType<typeof vi.fn>) {
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
  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  const ports = baseAgentConfig(dataDir);
  const agent = new CoachAgent(cyclingSport as unknown as Sport, ports);
  return { agent, chatStore: ports.chatStore };
}

function roleContent(messages: readonly Message[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function lastUserContent(call: Call): string {
  const user = [...call.messages].reverse().find((m) => m.role === "user");
  if (typeof user?.content !== "string") throw new Error("no user message in the request");
  return user.content;
}

describe("the stored user message is the one the model received", () => {
  it("persists the timed message and reuses it verbatim as the next turn's prefix", async () => {
    const complete = vi.fn(async (_params: Call) => mkAssistant("noted"));
    const { agent, chatStore } = await setupAgent(complete);

    await agent.chat("c1", "How was my ride?");
    expect(complete).toHaveBeenCalledTimes(1);
    const sentFirst = lastUserContent(complete.mock.calls[0]![0]);
    expect(sentFirst).toContain("Current time:");

    const stored = chatStore.load("c1").messages;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ role: "user", content: sentFirst });
    expect(stored[0]!.content).not.toBe("How was my ride?");

    await agent.chat("c1", "And tomorrow?");
    expect(complete).toHaveBeenCalledTimes(2);
    const second = complete.mock.calls[1]![0];
    expect(roleContent(second.messages.slice(0, stored.length))).toEqual(roleContent(stored));
    expect(second.messages[stored.length]).toMatchObject({
      role: "user",
      content: expect.stringMatching(/^And tomorrow\?\nCurrent time: /),
    });
  });
});
