import { afterEach, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";

import { summarizeDroppedMessages } from "../../src/agent/compaction.js";
import {
  CODEX_REASONING_NOTIFICATION_METHODS,
  codexAgentGenerateText,
  type CodexAgentBridgePorts,
} from "../../src/agent/codex-agent/bridge.js";
import type { CoachMcpEndpoint } from "../../src/agent/codex-agent/mcp-endpoint.js";
import type { EngineConfig, MemorySnapshot } from "../../src/host-ports.js";
import { LLM } from "../../src/llm.js";
import { llmTestPorts } from "../helpers/base-agent-config.js";
import { testModelProfiles } from "../helpers/model-profiles.js";
import { createFakeCodex, type FakeCodex } from "./helpers/fake-codex.js";

const TEST_TIMEOUT_MS = 25_000;
const MODEL = "gpt-5.6-sol";
const GENERATION_SPAWN_INDEX = 2;

const MUST_PRESERVE_TOKENS = [
  "FTP 247W",
  "72kg",
  "Mon/Wed/Fri",
  "target FTP 280W by August",
  "knee",
];

const EMPTY_SNAPSHOT: MemorySnapshot = {
  read: () => null,
  has: () => false,
  listSections: () => [],
  provenanceOf: () => ({ garmin: false, nonGarmin: false, unknown: true }),
};

const DROPPED: ModelMessage[] = [
  { role: "user", content: "My FTP is 247W and I weigh 72kg." },
  { role: "assistant", content: "Logged FTP 247W at 72kg." },
  { role: "user", content: "I ride Mon/Wed/Fri and want 280W by August." },
  { role: "assistant", content: "Target noted: target FTP 280W by August." },
  { role: "user", content: "My knee flares on high volume." },
  { role: "assistant", content: "Health note recorded: knee flare risk." },
];

let fake: FakeCodex | null = null;
const endpoints: CoachMcpEndpoint[] = [];

afterEach(async () => {
  while (endpoints.length > 0) await endpoints.pop()?.close();
  await fake?.cleanup();
  fake = null;
});

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
}

function codexAgentConfig(binaryPath: string): EngineConfig {
  return {
    dataSource: "platform",
    llm: {
      provider: "codex-agent",
      model: MODEL,
      apiKey: "",
      codexAgent: { enabled: true, binaryPath },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    models: testModelProfiles({
      provider: "codex-agent",
      chat: MODEL,
      chatContextWindowTokens: 1_050_000,
    }),
    contextWindowTokens: 1_050_000,
    compactContextWindowTokens: 1_050_000,
  };
}

function statelessPorts(
  binaryPath: string,
  record: { endpointStarts: number },
): CodexAgentBridgePorts {
  return {
    runtime: { enabled: true, binaryPath },
    baseEnv: baseEnv(),
    ensureReady: async () => ({ binaryPath, foreignServers: [] }),
    startEndpoint: async () => {
      record.endpointStarts += 1;
      throw new Error("the stateless path must not start an MCP endpoint");
    },
  };
}

describe("codex-agent compaction MUST-PRESERVE regression proxy (AC-15)", () => {
  it(
    "carries every must-preserve token into the compaction prompt and back out of the summary",
    async () => {
      const staged = await createFakeCodex({ script: "compact-preserves-tokens" });
      fake = staged;

      const llm = new LLM(codexAgentConfig(staged.binaryPath), llmTestPorts());
      const result = await summarizeDroppedMessages({
        dropped: DROPPED,
        llm,
        mustPreserveTokens: MUST_PRESERVE_TOKENS,
        memory: EMPTY_SNAPSHOT,
        caller: "compact",
        contextWindowTokens: 1_050_000,
      });

      for (const token of MUST_PRESERVE_TOKENS) {
        expect(result.summary, token).toContain(token);
      }
      expect(result.unsummarized).toEqual([]);

      const frames = await staged.readFramesIn(GENERATION_SPAWN_INDEX);
      const threadStart = frames.find((frame) => frame.method === "thread/start");
      const instructions = (threadStart?.params as { developerInstructions?: string } | undefined)
        ?.developerInstructions;
      expect(typeof instructions).toBe("string");
      for (const token of MUST_PRESERVE_TOKENS) {
        expect(instructions, token).toContain(token);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns a memory-flush artifact byte-for-byte and never streams it",
    async () => {
      const staged = await createFakeCodex({ script: "flush-artifact" });
      fake = staged;
      const record = { endpointStarts: 0 };
      const deltas: string[] = [];

      const result = await codexAgentGenerateText(
        {
          modelId: MODEL,
          caller: "flush",
          system: "Return the memory artifact and nothing else.",
          messages: [{ role: "user", content: "flush the profile section" }],
          onTextDelta: (delta: string) => deltas.push(delta),
        },
        statelessPorts(staged.binaryPath, record),
      );

      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed).toEqual({
        section: "Athlete Profile",
        content: "FTP 247W, 72kg, Mon/Wed/Fri, knee flare risk on high volume.",
        source: "conversation",
      });
      expect(result.finishReason).toBe("stop");
      expect(result.costBasis).toBe("notional");
      expect(deltas).toEqual([]);
      expect(record.endpointStarts).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "declares zero MCP servers and opts out of reasoning notifications on the stateless path",
    async () => {
      const staged = await createFakeCodex({ script: "compact-preserves-tokens" });
      fake = staged;
      const record = { endpointStarts: 0 };

      await codexAgentGenerateText(
        {
          modelId: MODEL,
          caller: "compact",
          system: "Summarize the conversation.",
          messages: [{ role: "user", content: "summarize" }],
        },
        statelessPorts(staged.binaryPath, record),
      );

      const argv = await staged.readArgv();
      expect(argv.some((entry) => entry.startsWith("mcp_servers."))).toBe(false);
      expect(record.endpointStarts).toBe(0);

      const frames = await staged.readFramesIn();
      const initialize = frames.find((frame) => frame.method === "initialize");
      const capabilities = (
        initialize?.params as { capabilities?: Record<string, unknown> } | undefined
      )?.capabilities;
      expect(capabilities?.experimentalApi).toBe(false);
      expect(capabilities?.optOutNotificationMethods).toEqual([
        ...CODEX_REASONING_NOTIFICATION_METHODS,
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
