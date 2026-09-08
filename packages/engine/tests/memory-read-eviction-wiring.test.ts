import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import type { CoreDeps, MemorySectionSpec, Sport, ToolRegistration } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

const reads: string[] = [];
const writes: string[] = [];

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-evict-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  reads.length = 0;
  writes.length = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sections: readonly MemorySectionSpec[] = [
  { name: "cycling-profile", description: "FTP, weight, recent form" },
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

function makeStubSport(): Sport {
  return {
    id: "cycling",
    soul: "",
    skills: {},
    sessionClusterGapMinutes: 60,
    memorySections: sections,
    mustPreserveTokens: () => ["FTP"],
    intervalsActivityTypes: ["Ride"],
    athleteProfileSchema: z.object({}),
    tools: (_deps: CoreDeps): readonly ToolRegistration[] => {
      const readSchema = z.object({ section: z.string() });
      const writeSchema = z.object({ section: z.string(), content: z.string() });
      return [
        {
          name: "memory_read",
          description: "Reads a memory section.",
          inputSchema: readSchema,
          tool: tool({
            description: "Reads a memory section.",
            inputSchema: readSchema,
            execute: async ({ section }: { section: string }) => {
              reads.push(section);
              return { section, content: `read #${reads.length}` };
            },
          }),
        },
        {
          name: "memory_write",
          description: "Saves an athlete memory.",
          inputSchema: writeSchema,
          tool: tool({
            description: "Saves an athlete memory.",
            inputSchema: writeSchema,
            execute: async ({ section }: { section: string }) => {
              writes.push(section);
              return { saved: true };
            },
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
  return new CoachAgent(makeStubSport(), baseAgentConfig(dataDir));
}

function scriptedTurn(
  script: Array<Array<{ id: string; name: string; arguments: Record<string, unknown> }>>,
) {
  let step = -1;
  return vi.fn(async (params: { system?: string }) => {
    if ((params.system ?? "").length === 0) return mkAssistant({ text: "summary" });
    step++;
    const calls = script[step];
    if (calls === undefined) return mkAssistant({ text: "done" });
    return mkAssistant({ toolCalls: calls, stopReason: "toolUse" });
  });
}

describe("memory read-cache eviction at the write boundary", () => {
  it("re-executes an identical memory_read after a same-turn memory_write", async () => {
    const complete = scriptedTurn([
      [{ id: "r1", name: "memory_read", arguments: { section: "cycling-profile" } }],
      [
        {
          id: "w1",
          name: "memory_write",
          arguments: { section: "cycling-profile", content: "FTP 260" },
        },
      ],
      [{ id: "r2", name: "memory_read", arguments: { section: "cycling-profile" } }],
    ]);

    const agent = await setupAgent(complete);
    await agent.chat("evict-1", "update my FTP then tell me what you have");

    expect(writes).toEqual(["cycling-profile"]);
    expect(reads).toEqual(["cycling-profile", "cycling-profile"]);
  });

  it("still memoizes identical memory_read calls when no write intervenes", async () => {
    const complete = scriptedTurn([
      [{ id: "r1", name: "memory_read", arguments: { section: "cycling-profile" } }],
      [{ id: "r2", name: "memory_read", arguments: { section: "cycling-profile" } }],
    ]);

    const agent = await setupAgent(complete);
    await agent.chat("evict-2", "what do you have on me?");

    expect(writes).toEqual([]);
    expect(reads).toEqual(["cycling-profile"]);
  });
});
