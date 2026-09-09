import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";
import type { CodexResponsesParams } from "../src/agent/codex/responses.js";
import { SUMMARY_PREFIX } from "../src/agent/history-limit.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-trimguard-"));
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

async function setupAgent(
  complete: ReturnType<typeof vi.fn>,
  windows: {
    contextWindowTokens?: number;
    compactContextWindowTokens?: number;
    historyTokenBudgetRatio?: number;
  } = {},
) {
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

  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  const ports = baseAgentConfig(dataDir);
  return new CoachAgent(cyclingSport as unknown as Sport, {
    ...ports,
    config: {
      ...ports.config,
      session: {
        ...ports.config.session,
        historyTokenBudgetRatio:
          windows.historyTokenBudgetRatio ?? ports.config.session.historyTokenBudgetRatio,
      },
      contextWindowTokens: windows.contextWindowTokens ?? 120_000,
      compactContextWindowTokens:
        windows.compactContextWindowTokens ?? ports.config.compactContextWindowTokens,
    },
  });
}

function mkAssistant(text: string, stopReason: "stop" | "length" = "stop") {
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
    stopReason,
  };
}

function seedSession(chatId: string, lines: Array<{ role: string; content: string; ts: string }>) {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${chatId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
}

function listPrecompact(chatId: string): string[] {
  return readdirSync(join(dataDir, "sessions")).filter((f) =>
    f.startsWith(`${chatId}.jsonl.precompact.`),
  );
}

const FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg",
  "## Training Status",
  "- Build phase",
  "## Coach Stance",
  "- Hold volume this week",
  "## Discussion Context",
  "- Goal review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

const FRESH_TS = new Date().toISOString();
const seeded = Array.from({ length: 30 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `TRIM-MARK-${i} ` + "x".repeat(2_400),
  ts: FRESH_TS,
}));

describe("trim-path compaction guard", () => {
  it("flushes, archives, then overwrites on a successful trim", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) return mkAssistant("facts noted");
      if (n === 2) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("trim-ok", seeded);

    const text = await agent.chat("trim-ok", "hello");

    expect(text).toBe("final-reply");
    expect(complete).toHaveBeenCalledTimes(3);

    const archives = listPrecompact("trim-ok");
    expect(archives).toHaveLength(1);
    const archived = readFileSync(join(dataDir, "sessions", archives[0]), "utf-8");
    expect(archived).toContain("TRIM-MARK-0");
    expect(archived).toContain("TRIM-MARK-29");

    const session = readFileSync(join(dataDir, "sessions", "trim-ok.jsonl"), "utf-8");
    expect(session).toContain("## Coach Stance");
    expect(session).toContain("TRIM-MARK-29");
    expect(session).toContain("hello");
    expect(session).toContain("final-reply");
    expect(session).not.toContain("TRIM-MARK-0 ");

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("flush failed"))).toBe(false);
  });

  it("archives and overwrites when the flush fails; the turn still completes", async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n <= 2) throw new Error("boom");
      if (n === 3) return mkAssistant(FIVE_SECTION_SUMMARY);
      return mkAssistant("final-reply");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);
    seedSession("trim-flush-fail", seeded);

    const text = await agent.chat("trim-flush-fail", "hello");

    expect(text).toBe("final-reply");
    expect(complete).toHaveBeenCalledTimes(4);
    expect(listPrecompact("trim-flush-fail")).toHaveLength(1);

    const session = readFileSync(join(dataDir, "sessions", "trim-flush-fail.jsonl"), "utf-8");
    expect(session).not.toContain("TRIM-MARK-0 ");
    expect(session).toContain("## Coach Stance");
    expect(session).toContain("TRIM-MARK-29 ");

    expect(
      warnSpy.mock.calls.some((c) => String(c[0]).includes("Pre-compaction memory flush failed")),
    ).toBe(true);
  });

  it.each([false, true])(
    "preserves all history in the next request after total failure (prior summary: %s)",
    async (withSummary) => {
      let n = 0;
      const complete = vi.fn(async () => {
        n++;
        if (n === 1) return mkAssistant("facts noted");
        if (n === 2) throw new Error("boom");
        return mkAssistant("final-reply");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agent = await setupAgent(complete);
      seedSession("trim-summary-fail", [
        ...(withSummary
          ? [{ role: "system", content: `${SUMMARY_PREFIX}\nProtect the knee.`, ts: FRESH_TS }]
          : []),
        ...seeded.map((message, i) => ({
          ...message,
          content:
            message.content +
            (i === 0
              ? " Goal: finish the mountain ride."
              : i === 10
                ? " Correction: no Tuesday training."
                : ""),
        })),
      ]);

      const text = await agent.chat("trim-summary-fail", "hello");

      expect(text).toBe("final-reply");
      expect(listPrecompact("trim-summary-fail")).toHaveLength(0);
      const request = JSON.stringify(complete.mock.calls.at(-1));
      expect(request).toContain("TRIM-MARK-0 ");
      expect(request).toContain("TRIM-MARK-29 ");
      expect(request).toContain("Goal: finish the mountain ride.");
      expect(request).toContain("Correction: no Tuesday training.");
      if (withSummary) expect(request).toContain("Protect the knee.");

      const session = readFileSync(join(dataDir, "sessions", "trim-summary-fail.jsonl"), "utf-8");
      expect(session).toContain("TRIM-MARK-0 ");
      expect(session).not.toContain("## Coach Stance");

      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("Dropped message summarization failed"),
        ),
      ).toBe(true);
    },
  );

  it("retains failed chunks in the next request after partial summarization", async () => {
    let summaries = 0;
    const complete = vi.fn(async (params: CodexResponsesParams) => {
      if (String(params.messages[0]?.content).startsWith("Incorporate the older")) {
        summaries++;
        if (summaries === 2) throw new Error("summary unavailable");
        return mkAssistant(
          FIVE_SECTION_SUMMARY + "\nProtect the knee. Goal: finish the mountain ride.",
        );
      }
      return mkAssistant("final-reply");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete, { compactContextWindowTokens: 30_000 });
    seedSession("trim-partial", [
      { role: "system", content: `${SUMMARY_PREFIX}\nProtect the knee.`, ts: FRESH_TS },
      ...seeded.map((message, i) => ({
        ...message,
        content:
          message.content +
          (i === 0
            ? " Goal: finish the mountain ride."
            : i === 10
              ? " Correction: no Tuesday training."
              : ""),
      })),
    ]);

    expect(await agent.chat("trim-partial", "hello")).toBe("final-reply");

    expect(summaries).toBeGreaterThan(1);
    const request = JSON.stringify(complete.mock.calls.at(-1)?.[0].messages);
    expect(request).toContain("Goal: finish the mountain ride.");
    expect(request).toContain("Correction: no Tuesday training.");
    expect(request).toContain("Protect the knee.");
    expect(request).toContain("TRIM-MARK-29 ");
  });

  it("retains a failed staged correction in the next request after overflow rescue", async () => {
    let requests = 0;
    let summaries = 0;
    const complete = vi.fn(async (params: CodexResponsesParams) => {
      if (String(params.messages[0]?.content).startsWith("Summarize the conversation")) {
        summaries++;
        if (summaries === 2) throw new Error("summary unavailable");
        return mkAssistant(
          FIVE_SECTION_SUMMARY + "\nProtect the knee. Goal: finish the mountain ride.",
        );
      }
      if (params.system?.startsWith("You are reviewing a conversation"))
        return mkAssistant("facts noted");
      if (
        params.messages.some(
          (message) => message.role === "user" && String(message.content).startsWith("hello"),
        )
      ) {
        requests++;
        if (requests === 1) throw new Error("Request exceeds the maximum context length");
        return mkAssistant("final-reply");
      }
      return mkAssistant("facts noted");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete, {
      compactContextWindowTokens: 30_000,
      historyTokenBudgetRatio: 0.95,
    });
    seedSession("staged-partial", [
      { role: "system", content: `${SUMMARY_PREFIX}\nProtect the knee.`, ts: FRESH_TS },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content:
          (i === 0
            ? "Goal: finish the mountain ride."
            : i === 1
              ? "Correction: no Tuesday training."
              : `RECENT-${i}`) + "x".repeat(20_000),
        ts: FRESH_TS,
      })),
    ]);

    expect(await agent.chat("staged-partial", "hello")).toBe("final-reply");

    expect(requests).toBe(2);
    expect(summaries).toBeGreaterThan(1);
    const request = JSON.stringify(complete.mock.calls.at(-1)?.[0].messages);
    expect(request).toContain("Goal: finish the mountain ride.");
    expect(request).toContain("Correction: no Tuesday training.");
    expect(request).toContain("Protect the knee.");
    expect(request).toContain("RECENT-5");
  });

  it("stops before generating when failed summaries leave history over budget", async () => {
    const complete = vi.fn(async (params: CodexResponsesParams) => {
      const content = String(params.messages[0]?.content);
      if (
        content.startsWith("Incorporate the older") ||
        content.startsWith("Summarize the conversation")
      ) {
        throw new Error("summary unavailable");
      }
      return mkAssistant("facts noted");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete, { contextWindowTokens: 40_000 });
    seedSession(
      "trim-over-budget",
      seeded.map((message) => ({
        ...message,
        content: message.content + "x".repeat(8_000),
      })),
    );

    await expect(agent.chat("trim-over-budget", "hello")).rejects.toThrow(
      "Conversation could not be shortened safely to fit the context budget",
    );

    expect(
      complete.mock.calls.some(([params]) =>
        params.messages.some(
          (message) => message.role === "user" && String(message.content).startsWith("hello"),
        ),
      ),
    ).toBe(false);
    expect(listPrecompact("trim-over-budget")).toHaveLength(0);
    const session = readFileSync(join(dataDir, "sessions", "trim-over-budget.jsonl"), "utf-8");
    expect(session).toContain("TRIM-MARK-0 ");
  });
});
