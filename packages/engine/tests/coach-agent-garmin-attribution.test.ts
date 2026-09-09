import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { ModelMessage } from "ai";
import type { ChatLineage, ChatStorePort, EngineHostPorts } from "../src/host-ports.js";
import type { SourceProvenance } from "../src/provenance.js";
import type { Sport, SportRuntimePorts, ToolRegistration } from "../src/sport.js";
import { createMemoryTools } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { GARMIN_DATA_ATTRIBUTION } from "../src/agent/garmin-attribution.js";
import { ConfirmationGate } from "../../core/src/agent/confirmation-gate.js";
import { createEngineHostAdapter } from "../../core/src/agent/engine-host-adapter.js";
import { legacyStateReader } from "../../core/src/agent/legacy-athlete-state-reader.js";

let tempHome: string;
let originalHome: string | undefined;
let dataDir: string;

const syntheticSport: Sport = {
  id: "cycling",
  soul: "# Synthetic Coach",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: ["Ride"],
  athleteProfileSchema: z.object({}),
  tools: () => [],
};

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-garmin-attribution-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function assistant(text: string, stopReason: "stop" | "length" | "toolUse" = "stop") {
  return {
    text,
    toolCalls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
  };
}

function activitySport(execute: (input: Record<string, unknown>) => Promise<unknown>): Sport {
  return {
    ...syntheticSport,
    tools: () => [
      {
        name: "intervals_fetch_activities",
        description: "Read activities.",
        inputSchema: z.unknown(),
        tool: tool({
          description: "Read activities.",
          inputSchema: zodSchema(z.object({ label: z.string().optional() })),
          execute,
        }),
      },
    ],
  };
}

function activityAndPlanSport(
  execute: (input: Record<string, unknown>) => Promise<unknown>,
): Sport {
  const sport: Sport = {
    ...syntheticSport,
    memorySections: [{ name: "test-profile", description: "Test profile" }],
    tools: (deps: SportRuntimePorts): readonly ToolRegistration[] => {
      const memoryTools = createMemoryTools(deps.memory, sport.memorySections, {
        bindProvenance: deps.bindMemoryToolProvenance,
      });
      return [
        ...activitySport(execute).tools(deps),
        {
          name: "plan_save",
          description: "Save a plan.",
          inputSchema: z.unknown(),
          tool: memoryTools.plan_save,
        },
        {
          name: "plan_load",
          description: "Load the plan.",
          inputSchema: z.unknown(),
          tool: memoryTools.plan_load,
        },
      ];
    },
  };
  return sport;
}

function mockRuntimeModules(complete: ReturnType<typeof vi.fn>) {
  vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
  vi.doMock("../src/agent/codex/oauth.js", () => ({
    refreshCodexToken: vi.fn(),
    loginCodex: vi.fn(),
  }));
  vi.doMock("../../core/src/auth/profiles.js", () => ({
    getFreshToken: vi.fn(async () => "synthetic-token"),
    loadProfile: vi.fn(),
    saveProfile: vi.fn(),
    RefreshTokenReusedError: class extends Error {},
  }));
}

function withWindow(ports: EngineHostPorts, contextWindowTokens?: number): EngineHostPorts {
  if (contextWindowTokens === undefined) return ports;
  return {
    ...ports,
    config: {
      ...ports.config,
      contextWindowTokens,
      compactContextWindowTokens: contextWindowTokens,
    },
  };
}

async function setupAgent(
  complete: ReturnType<typeof vi.fn>,
  sport: Sport = syntheticSport,
  contextWindowTokens?: number,
) {
  mockRuntimeModules(complete);
  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  return new CoachAgent(sport, withWindow(baseAgentConfig(dataDir), contextWindowTokens));
}

// vi.resetModules() means the agent under test runs on a freshly imported
// engine graph, so message provenance must be stamped through that same graph's
// WeakMap — the statically imported one is a different module instance.
interface SeededMessage {
  role: "user" | "assistant";
  content: string;
  provenance: SourceProvenance;
}

interface FakeChatStore extends ChatStorePort {
  appended: ChatLineage[];
}

async function setupAgentWithStore(
  complete: ReturnType<typeof vi.fn>,
  sport: Sport,
  opts?: { seed?: SeededMessage[]; contextWindowTokens?: number },
) {
  mockRuntimeModules(complete);
  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  const { setMessageProvenance, UNKNOWN_PROVENANCE } = await import("../src/provenance.js");
  const stamp = (m: SeededMessage): ModelMessage =>
    setMessageProvenance({ role: m.role, content: m.content } as ModelMessage, m.provenance);
  let messages: ModelMessage[] = (opts?.seed ?? []).map(stamp);
  const appended: ChatLineage[] = [];
  const chatStore: FakeChatStore = {
    appended,
    hasSession: () => messages.length > 0,
    load: () => ({
      messages: [...messages],
      lastMessageTime: messages.length === 0 ? null : new Date().toISOString(),
    }),
    appendTurn(_chatId, userContent, assistantContent, lineage) {
      appended.push(lineage);
      messages.push(
        stamp({ role: "user", content: userContent, provenance: UNKNOWN_PROVENANCE }),
        stamp({
          role: "assistant",
          content: assistantContent,
          provenance: lineage.provenance ?? UNKNOWN_PROVENANCE,
        }),
      );
    },
    overwriteHistory(_chatId, next) {
      messages = [...next];
    },
    persistDecisionContext() {},
    resetConversation() {
      messages = [];
    },
    loadUnflushedResetArchive: () => null,
    markResetArchiveFlushed() {},
    archivePreCompact() {},
  };
  const ports: EngineHostPorts = {
    ...withWindow(baseAgentConfig(dataDir), opts?.contextWindowTokens),
    chatStore,
  };
  return { agent: new CoachAgent(sport, ports), chatStore };
}

async function setupGatedAgent(complete: ReturnType<typeof vi.fn>, sport: Sport) {
  mockRuntimeModules(complete);
  const confirmations = new ConfirmationGate();
  const adapted = createEngineHostAdapter({
    config: baseAgentConfig(dataDir),
    stateReader: legacyStateReader,
    overrides: { confirmations },
  });
  const ports: EngineHostPorts = {
    ...adapted.ports,
    getAccessToken: async () => "token",
    transcriptWriter: { appendCompletedTurn: () => undefined },
  };
  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  return { agent: new CoachAgent(sport, ports), confirmations, memory: adapted.memory };
}

let nextToolCallId = 1;

function toolCall(args: Record<string, unknown> = {}, name = "intervals_fetch_activities") {
  return {
    ...assistant("", "toolUse"),
    toolCalls: [{ id: `call-${nextToolCallId++}|item`, name, arguments: args }],
  };
}

function assistantHistory(chatId: string): Array<Record<string, unknown>> {
  const path = join(dataDir, "sessions", `${chatId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.role === "assistant");
}

describe("CoachAgent selective Garmin attribution", () => {
  it.each([
    ["confirmed Garmin", "GARMIN_CONNECT", true],
    ["confirmed non-Garmin", "POLAR", false],
    ["unknown", "UPLOAD", false],
  ])("uses usable %s activity data", async (_name, source, attributed) => {
    let calls = 0;
    const execute = vi.fn(async () => [{ id: "synthetic", source, load: 42 }]);
    const complete = vi.fn(async () => (++calls === 1 ? toolCall() : assistant("Guidance.")));
    const agent = await setupAgent(complete, activitySport(execute));

    const reply = await agent.chat(String(source), "Coach me.");

    expect(execute).toHaveBeenCalledOnce();
    expect(reply).toBe(attributed ? `Guidance.\n\n${GARMIN_DATA_ATTRIBUTION}` : "Guidance.");
  });

  it("does not attribute a turn with no training data", async () => {
    const agent = await setupAgent(vi.fn(async () => assistant("General guidance.")));
    expect(await agent.chat("empty", "Hello")).toBe("General guidance.");
  });

  it("strips a model-supplied footer on an unknown turn", async () => {
    const agent = await setupAgent(
      vi.fn(async () => assistant(`General guidance.\n${GARMIN_DATA_ATTRIBUTION}`)),
    );
    expect(await agent.chat("strip", "Hello")).toBe("General guidance.");
  });

  it("delivers and persists a fallback when the model returns only the footer", async () => {
    const agent = await setupAgent(
      vi.fn(async () => assistant(` \n${GARMIN_DATA_ATTRIBUTION}\n `)),
    );

    const reply = await agent.chat("footer-only", "Hello");

    expect(reply).toContain("ran out of steps");
    expect(reply.trim()).not.toBe("");
    expect(assistantHistory("footer-only")[0]?.content).toBe(reply);
  });

  it("observes a memoized Garmin result on every delivery", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls <= 2) return toolCall({ label: "same" });
      return assistant("Memoized guidance.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    const reply = await agent.chat("memo", "Use the activity twice.");

    expect(execute).toHaveBeenCalledOnce();
    expect(reply).toBe(`Memoized guidance.\n\n${GARMIN_DATA_ATTRIBUTION}`);
  });

  it("caps a 30,000-token payload even with a 1M context window", async () => {
    const execute = vi.fn(async () => [
      { id: "synthetic", source: "GARMIN_CONNECT", samples: "x".repeat(100_000) },
    ]);
    let calls = 0;
    const complete = vi.fn(async (params: { messages: unknown }) => {
      if (++calls === 1) return toolCall();
      expect(JSON.stringify(params.messages)).toContain("Tool result too large");
      expect(JSON.stringify(params.messages)).not.toContain("x".repeat(100_000));
      return assistant("Capped guidance.");
    });
    const agent = await setupAgent(complete, activitySport(execute), 1_000_000);

    expect(await agent.chat("capped", "Use the activity.")).toBe("Capped guidance.");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not carry Garmin evidence across a failed outer attempt", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) return toolCall();
      if (calls === 2) {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return assistant("Retried guidance.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    expect(await agent.chat("retry", "Coach me.")).toBe("Retried guidance.");
  });

  it("attributes a retry only when that attempt reads the Garmin result again", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1 || calls === 3) return toolCall();
      if (calls === 2) {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return assistant("Retried with data.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    expect(await agent.chat("retry-reread", "Coach me.")).toBe(
      `Retried with data.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not carry hidden Garmin tool evidence into no-tools recovery", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) return toolCall();
      if (calls === 2) return assistant("", "toolUse");
      return assistant("Recovered guidance.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    expect(await agent.chat("recovery", "Coach me.")).toBe("Recovered guidance.");
  });

  it("preserves Garmin provenance when a proposed plan is later confirmed", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) return toolCall();
      if (calls === 2) return toolCall({ plan: { name: "Base" } }, "plan_save");
      return assistant("Plan proposed.");
    });
    const { agent, confirmations, memory } = await setupGatedAgent(
      complete,
      activityAndPlanSport(execute),
    );

    await agent.chat("confirmed-plan", "Use my activity and save a plan.");
    const proposal = confirmations.peek("confirmed-plan")!;
    expect(await confirmations.confirm("confirmed-plan", proposal.nonce)).toMatchObject({
      status: "executed",
    });
    expect(memory.provenanceForToolRead("plan_load", {})).toEqual({
      garmin: true,
      nonGarmin: false,
      unknown: true,
    });
  });

  it("persists assistant provenance and reuses it only while history survives", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) return toolCall();
      return assistant(calls === 2 ? "First." : "Second.");
    });
    const { agent, chatStore } = await setupAgentWithStore(complete, activitySport(execute));

    await agent.chat("history", "First turn.");
    const later = await agent.chat("history", "Later turn.");

    expect(later).toBe(`Second.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(chatStore.appended[0].provenance).toEqual({
      garmin: true,
      nonGarmin: false,
      unknown: true,
    });
  });

  it("persists the assistant reply's provenance on the session line", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => (++calls === 1 ? toolCall() : assistant("Guidance.")));
    const agent = await setupAgent(complete, activitySport(execute));

    await agent.chat("persisted", "Coach me.");

    expect(assistantHistory("persisted")[0].provenance).toEqual({
      garmin: true,
      nonGarmin: false,
      unknown: true,
    });
  });

  it("attributes retained history after dropped-message summarization fails", async () => {
    const complete = vi.fn(async (params: { messages: unknown }) => {
      if (JSON.stringify(params.messages).includes("Incorporate the older conversation")) {
        throw new Error("summary unavailable");
      }
      return assistant("Visible-history guidance.");
    });
    const { agent } = await setupAgentWithStore(complete, syntheticSport, {
      contextWindowTokens: 40_000,
      seed: [
        {
          role: "assistant",
          content: "x".repeat(30_000),
          provenance: { garmin: true, nonGarmin: false, unknown: false },
        },
        {
          role: "assistant",
          content: "Visible unknown reply",
          provenance: { garmin: false, nonGarmin: false, unknown: true },
        },
      ],
    });

    expect(await agent.chat("dropped-history", "What now?")).toBe(
      `Visible-history guidance.\n\n${GARMIN_DATA_ATTRIBUTION}`,
    );
    expect(
      complete.mock.calls.some(([params]) =>
        JSON.stringify(params.messages).includes("Incorporate the older conversation"),
      ),
    ).toBe(true);
    expect(JSON.stringify(complete.mock.calls.at(-1)?.[0].messages)).toContain("x".repeat(30_000));
  });

  it("isolates concurrent chats", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => [
      { id: input.label, source: input.label === "garmin" ? "GARMIN_CONNECT" : "POLAR" },
    ]);
    const seen = new Set<string>();
    const complete = vi.fn(
      async (params: { messages: Array<{ role: string; content: unknown }> }) => {
        const serialized = JSON.stringify(params.messages);
        const label = serialized.includes("garmin request") ? "garmin" : "polar";
        await Promise.resolve();
        if (!seen.has(label)) {
          seen.add(label);
          return toolCall({ label });
        }
        return assistant(`${label} answer.`);
      },
    );
    const agent = await setupAgent(complete, activitySport(execute));

    const [garmin, polar] = await Promise.all([
      agent.chat("concurrent-g", "garmin request"),
      agent.chat("concurrent-p", "polar request"),
    ]);

    expect(garmin).toBe(`garmin answer.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(polar).toBe("polar answer.");
  });
});
