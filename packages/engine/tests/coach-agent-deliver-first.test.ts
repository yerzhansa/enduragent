import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-deliver-first-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

function mkAssistant(text: string) {
  return {
    text,
    toolCalls: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
    stopReason: "stop" as const,
  };
}

function errored(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: append failed`), { code });
}

async function setupAgent(complete: ReturnType<typeof vi.fn>) {
  vi.doMock("../src/agent/codex/responses.js", () => ({
    codexResponses: complete,
  }));
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

  const { CoachAgent, __resetPersistenceNoticeState } = await import("../src/agent/coach-agent.js");
  const ports = baseAgentConfig(dataDir);
  const agent = new CoachAgent(cyclingSport as unknown as Sport, ports);
  return { agent, chatStore: ports.chatStore, __resetPersistenceNoticeState };
}

function happyComplete(reply: string) {
  return vi.fn(async (params: { system?: string }) => {
    const sys = params.system ?? "";
    if (sys.includes(FLUSH_MARKER)) return mkAssistant("facts noted");
    if (sys.length === 0) return mkAssistant("summary");
    return mkAssistant(reply);
  });
}

function sessionFile(chatId: string): string {
  return join(dataDir, "sessions", `${chatId}.jsonl`);
}

const DISK_FULL_FRAGMENT = "disk is full";

describe("coach-agent deliver-first persistence", () => {
  let resetNotice: () => void;

  afterEach(() => {
    resetNotice?.();
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("delivers the reply on an ENOSPC append and appends the disk-full note only once", async () => {
    const { agent, chatStore, __resetPersistenceNoticeState } = await setupAgent(
      happyComplete("here is your reply"),
    );
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    vi.spyOn(chatStore, "appendTurn").mockImplementation(() => {
      throw errored("ENOSPC");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await agent.chat("disk-chat", "hello");
    expect(first).toContain("here is your reply");
    expect(first).toContain(DISK_FULL_FRAGMENT);

    const second = await agent.chat("disk-chat", "again");
    expect(second).toContain("here is your reply");
    expect(second).not.toContain(DISK_FULL_FRAGMENT);
  });

  it("delivers the reply on a non-ENOSPC append with no athlete note", async () => {
    const { agent, chatStore, __resetPersistenceNoticeState } = await setupAgent(
      happyComplete("eacces reply"),
    );
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    vi.spyOn(chatStore, "appendTurn").mockImplementation(() => {
      throw errored("EACCES");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const text = await agent.chat("eacces-chat", "hello");
    expect(text).toBe("eacces reply");
    expect(text).not.toContain(DISK_FULL_FRAGMENT);
  });

  it("happy path returns the reply with no note and persists the turn", async () => {
    const { agent, __resetPersistenceNoticeState } = await setupAgent(
      happyComplete("persisted reply"),
    );
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();

    const text = await agent.chat("happy-chat", "hello");
    expect(text).toBe("persisted reply");
    expect(text).not.toContain(DISK_FULL_FRAGMENT);

    expect(existsSync(sessionFile("happy-chat"))).toBe(true);
    const lines = readFileSync(sessionFile("happy-chat"), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes('"role":"user"'))).toBe(true);
    expect(lines.some((l) => l.includes('"role":"assistant"'))).toBe(true);
  });

  it("prefixes the post-reset notice and shows the model a one-turn archive marker", async () => {
    const POST_RESET_NOTICE =
      "Started a fresh session - earlier conversation is archived, and I still have your key details in memory.";
    const complete = happyComplete("here is the answer");
    const { agent, __resetPersistenceNoticeState } = await setupAgent(complete);
    resetNotice = __resetPersistenceNoticeState;
    resetNotice();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const oldTs = "1998-01-01T00:00:00.000Z";
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(
      sessionFile("reset-chat"),
      JSON.stringify({ role: "user", content: "old q", ts: oldTs }) +
        "\n" +
        JSON.stringify({ role: "assistant", content: "old a", ts: oldTs }) +
        "\n",
      { encoding: "utf-8", mode: 0o600 },
    );

    const reply = await agent.chat("reset-chat", "how's my form?");

    expect(reply).toBe(`${POST_RESET_NOTICE}\n\n${"here is the answer"}`);

    const archiveMarkers = complete.mock.calls.flatMap((call) => {
      const params = call[0] as { messages?: Array<{ role: string; content: unknown }> };
      return Array.isArray(params.messages)
        ? params.messages
            .filter(
              (m): m is { role: string; content: string } =>
                m.role === "system" &&
                typeof m.content === "string" &&
                m.content.includes("Previous session archived at"),
            )
            .map((m) => m.content)
        : [];
    });
    expect(archiveMarkers).toHaveLength(1);
    expect(archiveMarkers[0]).not.toMatch(/disclose/i);

    const currentSession = readFileSync(sessionFile("reset-chat"), "utf-8");
    expect(currentSession).not.toContain("old q");
    const currentLines = currentSession
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { role: string; content: string });
    expect(
      currentLines.filter((line) => line.role === "assistant").map((line) => line.content),
    ).toEqual(["here is the answer"]);
    expect(currentSession).not.toContain(POST_RESET_NOTICE);
  });
});
