import { afterEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CoachAgent } from "../src/agent/coach-agent.js";
import { ATHLETE_SNAPSHOT_HEADING } from "../src/agent/athlete-snapshot.js";
import {
  buildSystemPrompt,
  NO_PLAN_CONTEXT,
  splitSystemPromptAtBoundary,
} from "../src/agent/system-prompt.js";
import type { AthleteDataReaderPort, EngineHostPorts } from "../src/host-ports.js";
import { Memory } from "../../core/src/memory/store.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-athlete-snapshot-"));
  roots.push(root);
  const dataDir = join(root, ".cycling-coach");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  return dataDir;
}

const athlete = { icuFtp: 250, maxHr: 185, icuRestingHr: 47, icuWeight: 70, sportSettings: [] };
const wellness = [{ id: "1998-07-05", ctl: 55, atl: 48, restingHR: 46, hrv: 75 }];

function reader(available: boolean): AthleteDataReaderPort {
  const unavailable = async () => ({
    ok: false as const,
    error: "store_read_unavailable" as const,
    message: "No complete local training-store snapshot is available.",
  });
  return {
    getAthlete: available ? async () => ({ ok: true, value: athlete }) : unavailable,
    listWellness: available ? async () => ({ ok: true, value: wellness }) : unavailable,
    listActivities: unavailable,
    getActivity: unavailable,
    getStreams: unavailable,
    listCalendar: unavailable,
    freshness: () => undefined,
  };
}

async function runTurn(
  dataDir: string,
  athleteData: AthleteDataReaderPort | undefined,
): Promise<{ system: string; tools: ToolSet }> {
  const base = baseAgentConfig(dataDir);
  let system = "";
  let tools: ToolSet = {};
  const ports: EngineHostPorts = {
    ...base,
    platform: { ...base.platform, athleteData },
    transcriptWriter: { appendCompletedTurn: () => undefined },
    modelTransportDecorator: () => ({
      generate: async (request) => {
        system = request.options.system ?? "";
        tools = request.options.tools ?? {};
        const usage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
        };
        return {
          text: "ok",
          toolCalls: [],
          finishReason: "stop",
          usage,
          totalUsage: usage,
          steps: 1,
        };
      },
    }),
  };
  await new CoachAgent(cyclingSport, ports).chat("chat-1", "hi");
  return { system, tools };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("athlete profile and latest wellness in the turn context", () => {
  it("renders the block after the cache boundary and leaves the static prefix byte-identical", async () => {
    const dataDir = makeDataDir();
    const withData = await runTurn(dataDir, reader(true));
    const withoutData = await runTurn(dataDir, undefined);

    const blocks = splitSystemPromptAtBoundary(withData.system)!;
    expect(blocks.prefix).not.toContain(ATHLETE_SNAPSHOT_HEADING);
    expect(blocks.volatile).toContain(
      `${ATHLETE_SNAPSHOT_HEADING}\n\nProfile: FTP 250 W · max HR 185 bpm · resting HR 47 bpm · weight 70 kg\n` +
        "Wellness 1998-07-05: Fitness 55 · Fatigue 48 · Form +7 · resting HR 46 bpm · HRV 75",
    );
    expect(blocks.prefix).toBe(splitSystemPromptAtBoundary(withoutData.system)!.prefix);
    expect(withoutData.system).not.toContain(ATHLETE_SNAPSHOT_HEADING);
  });

  it("omits the block when the sync store has no data", async () => {
    const { system } = await runTurn(makeDataDir(), reader(false));
    expect(system).not.toContain(ATHLETE_SNAPSHOT_HEADING);
    expect(system).toContain("# Current Date & Time");
  });

  it("says no plan is saved yet instead of leaving the plan block out", async () => {
    const dataDir = makeDataDir();
    const { system } = await runTurn(dataDir, undefined);
    expect(system).toContain(`# Athlete Context\n\n`);
    expect(system).toContain(NO_PLAN_CONTEXT);

    new Memory(dataDir).savePlan({ name: "Spring build" });
    const { system: withPlan } = await runTurn(dataDir, undefined);
    expect(withPlan).toContain("## Current Plan\n- Name: Spring build");
    expect(withPlan).not.toContain(NO_PLAN_CONTEXT);
  });

  it("appends the plan state after the stored context inside the fence", () => {
    const memory = { getContext: () => "## Athlete Memory\n## person\nName: Sam" } as unknown as Memory;
    const prompt = buildSystemPrompt(cyclingSport, memory, "UTC", undefined, { planNone: true });
    expect(prompt).toContain(`## person\nName: Sam\n\n${NO_PLAN_CONTEXT}`);
    expect(buildSystemPrompt(cyclingSport, memory, "UTC")).not.toContain(NO_PLAN_CONTEXT);
  });
});

describe("memory_read registration follows the non-injected sections", () => {
  it("withholds memory_read while every stored section is already injected", async () => {
    const dataDir = makeDataDir();
    const memory = new Memory(dataDir);
    memory.writeSection("person", "Name: Sam");
    memory.writeSection("cycling-profile", "FTP 250W");
    const { tools } = await runTurn(dataDir, undefined);
    expect(tools).not.toHaveProperty("memory_read");
    expect(tools).toHaveProperty("memory_query");
    expect(tools).toHaveProperty("plan_load");
  });

  it("registers memory_read once a non-injected section has content", async () => {
    const dataDir = makeDataDir();
    const memory = new Memory(dataDir);
    memory.writeSection("person", "Name: Sam");
    memory.writeSection("notes", "prefers hill repeats");
    const { tools } = await runTurn(dataDir, undefined);
    expect(tools).toHaveProperty("memory_read");
    expect(tools.memory_read.description).toBe(
      "Read only stored sections that Athlete Context does not show, plus today's notes and plan state.",
    );
  });
});
