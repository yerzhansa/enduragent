import { describe, it, expect, afterEach, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { MemorySnapshot } from "@enduragent/engine/sport";
import { summarizeInStages, summarizeDroppedMessages } from "../src/agent/compaction.js";
import { isTimeoutError } from "../../core/src/agent/token-utils.js";
import { SUMMARY_PREFIX } from "../src/agent/history-limit.js";
import { CYCLING_VOCABULARY } from "@enduragent/sport-cycling";
import { createFakeLLM } from "./helpers/fake-llm.js";
import type { LLM } from "../src/llm.js";

const REPRESENTATIVE_CONVERSATION: ModelMessage[] = [
  { role: "user", content: "My FTP is 247W and I weigh 72kg." },
  { role: "assistant", content: "Got it. Logging FTP=247W, weight=72kg." },
  { role: "user", content: "I train Monday, Wednesday, and Friday." },
  { role: "assistant", content: "Schedule noted: Mon/Wed/Fri." },
  { role: "user", content: "Goal: lift FTP to 280W by August for the Gran Fondo." },
  { role: "assistant", content: "Target: FTP 280W by 2026-08, race type gran_fondo." },
  { role: "user", content: "Bike is Trek Madone, power meter is Quarq DZero." },
  { role: "assistant", content: "Equipment logged." },
  { role: "user", content: "I had a knee issue last winter; it flares with high volume." },
  { role: "assistant", content: "Health note: prior knee issue, watch high-volume blocks." },
];

const VALID_FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg, training Mon/Wed/Fri",
  "## Training Status",
  "- Build phase, target FTP 280W",
  "## Coach Stance",
  "- Hold volume, recheck Friday",
  "## Discussion Context",
  "- Goal-setting and equipment review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

const EMPTY_SNAPSHOT: MemorySnapshot = {
  read: () => null,
  has: () => false,
  listSections: () => [],
  provenanceOf: () => ({ garmin: false, nonGarmin: false, unknown: true }),
};

const hangingLLM = {
  generate: (opts: { deadlineMs?: number }) =>
    new Promise<never>((_, reject) => {
      if (opts.deadlineMs === undefined) return;
      setTimeout(() => {
        const err = new Error("Request timeout: The operation was aborted due to timeout");
        err.name = "TimeoutError";
        reject(err);
      }, opts.deadlineMs);
    }),
} as unknown as LLM;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("summarizeInStages guards", () => {
  it("times out a hung summarization call after 120 s and retains the previous summary and history", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: hangingLLM,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      previousSummary: VALID_FIVE_SECTION_SUMMARY,
    });

    await vi.advanceTimersByTimeAsync(120_000);
    const result = await p;

    expect(result.messages[0].role).toBe("system");
    expect(String(result.messages[0].content)).toContain("FTP 247W");
    expect(String(result.messages[0].content)).toContain("## Coach Stance");
    expect(result.messages.slice(1)).toEqual(REPRESENTATIVE_CONVERSATION);

    const chunkWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Staged summarization chunk failed"),
    );
    expect(chunkWarn).toBeDefined();
    expect(isTimeoutError(chunkWarn?.[1])).toBe(true);
  }, 10_000);

  it("retains the previous summary and history when the summarization call rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = createFakeLLM([{ error: new Error("boom") }]);

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      previousSummary: VALID_FIVE_SECTION_SUMMARY,
    });

    expect(result.messages[0].role).toBe("system");
    expect(String(result.messages[0].content)).toContain("FTP 247W");
    expect(spy.capturedOpts.length).toBe(1);
    expect(result.messages.slice(1)).toEqual(REPRESENTATIVE_CONVERSATION);

    const chunkWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Staged summarization chunk failed"),
    );
    expect(chunkWarn).toBeDefined();
  });

  it("retains every message when summarization fails without a previous summary", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = createFakeLLM([{ error: new Error("boom") }], { repeatLast: true });

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(result.messages).toEqual(REPRESENTATIVE_CONVERSATION);
    expect(result.summary).toBeUndefined();
    for (const msg of result.messages) {
      expect(String(msg.content).startsWith(SUMMARY_PREFIX)).toBe(false);
    }

    const retainedWarn = warnSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("retaining original messages"),
    );
    expect(retainedWarn).toBeDefined();
  });

  it("returns the input unchanged with no summary when there is nothing to summarize", async () => {
    const spy = createFakeLLM([]);
    const short = REPRESENTATIVE_CONVERSATION.slice(-3);

    const result = await summarizeInStages({
      messages: short,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(result.messages).toEqual(short);
    expect(result.summary).toBeUndefined();
    expect(spy.capturedOpts.length).toBe(0);
  });

  it("carries the last successful chunk summary across a failed chunk", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY, { error: new Error("boom") }]);
    const big = (s: string) => ({ role: "user" as const, content: s.repeat(30_000) });
    const messages = [big("a"), big("b"), ...REPRESENTATIVE_CONVERSATION.slice(-4)];

    const result = await summarizeInStages({
      messages,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      contextWindowTokens: 30_000,
    });

    expect(spy.capturedOpts.length).toBe(2);
    expect(result.messages.slice(1)).toEqual(messages.slice(1));
    expect(result.messages[0].role).toBe("system");
    expect(String(result.messages[0].content)).toContain("## Coach Stance");
    expect(String(result.messages[0].content)).toContain("FTP 247W");

    const chunkWarns = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && call[0].includes("Staged summarization chunk failed"),
    );
    expect(chunkWarns.length).toBe(1);
  });

  it("healthy path is unchanged", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(result.messages[0].role).toBe("system");
    expect(String(result.messages[0].content)).toContain("## Athlete Profile");
    expect(result.messages.length).toBe(5);
    expect(result.summary).toContain("## Athlete Profile");

    const guardWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        (call[0].includes("Staged summarization chunk failed") ||
          call[0].includes("retaining original messages")),
    );
    expect(guardWarn).toBeUndefined();
  });

  it("summarizeDroppedMessages hang times out and surfaces the total-failure throw", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: hangingLLM,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      previousSummary: "OLD DROPPED SUMMARY",
    });
    const rejection = p.then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as Error,
    );

    await vi.advanceTimersByTimeAsync(120_000);
    const err = await rejection;

    expect(err.message).toContain("failed before any chunk was summarized");
    expect(isTimeoutError((err as Error & { cause?: unknown }).cause)).toBe(true);

    const chunkWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("Dropped message summarization LLM call failed"),
    );
    expect(chunkWarn).toBeDefined();
  }, 10_000);
});
