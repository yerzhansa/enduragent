import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import type { CoreDeps, MemorySectionSpec, Sport, ToolRegistration } from "../src/sport.js";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import { TAINTED_BY_WRITES_MESSAGE as TAINTED_BY_WRITES_DESCRIPTOR } from "../src/agent/coach-agent-copy.js";

const english = await createPhrasebook({ tag: "en", locale: "en-GB" });
const TAINTED_BY_WRITES_MESSAGE = english.say(TAINTED_BY_WRITES_DESCRIPTOR);

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

// Reset per test: the stub tools close over these module-level records so the
// test can observe what each turn's tool actually saw.
const readAnchors: Record<string, ResolvedCs | null> = {};
const counters = { zones: 0 };

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-flush-iso-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  delete readAnchors.A;
  delete readAnchors.B;
  counters.zones = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sections: readonly MemorySectionSpec[] = [
  { name: "running-profile", description: "VDOT, easy pace, recent race times" },
];

function mkAssistant(opts: {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason?: "stop" | "toolUse";
}) {
  const toolCalls = opts.toolCalls ?? [];
  return {
    text: toolCalls.length > 0 ? "" : (opts.text ?? ""),
    toolCalls,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: opts.stopReason ?? "stop",
  };
}

// Two lines keeps history below the zero-write archive-deferral threshold while
// making the session stale under dailyResetHour:4, so the turn awaits the
// stale-reset flush before its main generate.
function seedStaleSession(chatId: string): void {
  const sessionsDir = join(dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const ts = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const lines = [
    JSON.stringify({ role: "user", content: "earlier question", ts }),
    JSON.stringify({ role: "assistant", content: "earlier answer", ts }),
  ].join("\n");
  writeFileSync(join(sessionsDir, `${chatId}.jsonl`), lines + "\n", { mode: 0o600 });
}

function makeStubRunningSport(): Sport {
  return {
    id: "running",
    soul: "",
    skills: {},
    sessionClusterGapMinutes: 60,
    memorySections: sections,
    mustPreserveTokens: () => ["VDOT"],
    intervalsActivityTypes: ["Run", "TrailRun"],
    athleteProfileSchema: z.object({}),
    tools: (deps: CoreDeps): readonly ToolRegistration[] => {
      const anchorSchema = z.object({ label: z.string() });
      const emptySchema = z.object({});
      return [
        {
          name: "read_anchor",
          description: "Reads the per-turn resolved CS anchor.",
          inputSchema: anchorSchema,
          tool: tool({
            description: "Reads the per-turn resolved CS anchor.",
            inputSchema: anchorSchema,
            execute: async ({ label }: { label: string }, options: unknown) => {
              readAnchors[label] = deps.resolvedCs?.(options) ?? null;
              return JSON.stringify(readAnchors[label]);
            },
          }),
        },
        {
          name: "calculate_zones",
          description: "Computes training zones.",
          inputSchema: emptySchema,
          tool: tool({
            description: "Computes training zones.",
            inputSchema: emptySchema,
            execute: async () => {
              counters.zones++;
              return { execution: counters.zones };
            },
          }),
        },
        {
          name: "memory_write",
          description: "Saves an athlete memory.",
          inputSchema: emptySchema,
          tool: tool({
            description: "Saves an athlete memory.",
            inputSchema: emptySchema,
            execute: async () => ({ saved: true }),
          }),
        },
      ];
    },
  };
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

  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  return new CoachAgent(makeStubRunningSport(), baseAgentConfig(dataDir));
}

function latestUserLabel(messages: { role: string; content?: unknown }[] | undefined): "A" | "B" {
  const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === "user");
  const content = (lastUser as { content?: unknown } | undefined)?.content;
  return typeof content === "string" && content.startsWith("B") ? "B" : "A";
}

function makeFlushGate() {
  let releaseFlush!: () => void;
  const flushReleased = new Promise<void>((r) => {
    releaseFlush = r;
  });
  let flushStarted!: () => void;
  const flushStartedP = new Promise<void>((r) => {
    flushStarted = r;
  });
  const prologue = async (sys: string): Promise<ReturnType<typeof mkAssistant> | undefined> => {
    if (sys.includes(FLUSH_MARKER)) {
      flushStarted();
      await flushReleased;
      return mkAssistant({ text: "facts noted" });
    }
    if (sys.length === 0) return mkAssistant({ text: "summary" });
    return undefined;
  };
  return { flushStartedP, releaseFlush, prologue };
}

describe("per-turn state does not bleed across a parked memory flush", () => {
  it("a turn parked in a memory flush keeps its own resolved anchor while another turn completes", async () => {
    seedStaleSession("flush-anchor-a");
    const gate = makeFlushGate();

    const complete = vi.fn(
      async (params: { system?: string; messages?: { role: string; content?: unknown }[] }) => {
        const parked = await gate.prologue(params.system ?? "");
        if (parked !== undefined) return parked;
        const hasToolResult = (params.messages ?? []).some((m) => m.role === "tool");
        if (hasToolResult) return mkAssistant({ text: "done" });
        const label = latestUserLabel(params.messages);
        return mkAssistant({
          toolCalls: [{ id: `call-${label}`, name: "read_anchor", arguments: { label } }],
          stopReason: "toolUse",
        });
      },
    );

    const agent = await setupAgent(complete);
    const anchorA: ResolvedCs = { criticalSpeedMps: 4.0, source: "platform", confidence: "high" };
    const anchorB: ResolvedCs = { criticalSpeedMps: 5.0, source: "platform", confidence: "high" };

    const aPromise = agent.chat("flush-anchor-a", "A: how's my pace?", { resolvedCs: anchorA });
    await gate.flushStartedP;
    const resB = await agent.chat("flush-anchor-b", "B: how's my pace?", { resolvedCs: anchorB });
    gate.releaseFlush();
    const resA = await aPromise;

    expect(resA).toContain("done");
    expect(resB).toBe("done");
    // Shared-field regression: B's 5.0 would have clobbered A's before A's tool ran.
    expect(readAnchors.A?.criticalSpeedMps).toBe(4.0);
    expect(readAnchors.B?.criticalSpeedMps).toBe(5.0);
  });

  it("a turn parked in a memory flush does not share the read-tool memoizer cache with another turn", async () => {
    seedStaleSession("flush-cache-a");
    const gate = makeFlushGate();

    const complete = vi.fn(
      async (params: { system?: string; messages?: { role: string; content?: unknown }[] }) => {
        const parked = await gate.prologue(params.system ?? "");
        if (parked !== undefined) return parked;
        const hasToolResult = (params.messages ?? []).some((m) => m.role === "tool");
        if (hasToolResult) return mkAssistant({ text: "done" });
        const label = latestUserLabel(params.messages);
        return mkAssistant({
          toolCalls: [
            { id: `${label}-1`, name: "calculate_zones", arguments: {} },
            { id: `${label}-2`, name: "calculate_zones", arguments: {} },
          ],
          stopReason: "toolUse",
        });
      },
    );

    const agent = await setupAgent(complete);

    const aPromise = agent.chat("flush-cache-a", "A: zones please");
    await gate.flushStartedP;
    const resB = await agent.chat("flush-cache-b", "B: zones please");
    gate.releaseFlush();
    const resA = await aPromise;

    expect(resA).toContain("done");
    expect(resB).toBe("done");
    // One underlying execution per turn: the two identical calls WITHIN a turn
    // share one memoized execution, and the second turn is NOT served from the
    // first turn's cache. Shared cross-turn cache would yield 1; per-turn
    // memoization lost entirely would yield 4.
    expect(counters.zones).toBe(2);
  });

  it("write taint recorded by one turn does not leak into a turn parked in a memory flush", async () => {
    seedStaleSession("flush-taint-a");
    const gate = makeFlushGate();
    let aMainCalls = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const complete = vi.fn(
      async (params: { system?: string; messages?: { role: string; content?: unknown }[] }) => {
        const parked = await gate.prologue(params.system ?? "");
        if (parked !== undefined) return parked;
        const messages = params.messages ?? [];
        const hasToolResult = messages.some((m) => m.role === "tool");
        if (latestUserLabel(messages) === "B") {
          if (!hasToolResult) {
            return mkAssistant({
              toolCalls: [{ id: "b-write", name: "memory_write", arguments: {} }],
              stopReason: "toolUse",
            });
          }
          const err = new Error("deadline exceeded");
          err.name = "TimeoutError";
          throw err;
        }
        aMainCalls++;
        if (aMainCalls === 1) {
          const err = new Error("deadline exceeded");
          err.name = "TimeoutError";
          throw err;
        }
        return mkAssistant({ text: "A ok" });
      },
    );

    const agent = await setupAgent(complete);

    const aPromise = agent.chat("flush-taint-a", "A: how's my form?");
    await gate.flushStartedP;
    const resB = await agent.chat("flush-taint-b", "B: note this");
    gate.releaseFlush();
    const resA = await aPromise;

    expect(resB).toBe(TAINTED_BY_WRITES_MESSAGE);
    // Load-bearing: with a shared/bled write record, A's first (timeout) error
    // would observe writesCommitted > 0 and refuse instead of retrying.
    expect(resA).toContain("A ok");
    expect(aMainCalls).toBe(2);
  });
});
