import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { tool, type ModelMessage, type ToolSet } from "ai";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { summarizeDroppedMessages } from "../../src/agent/compaction.js";
import {
  codexAgentGenerateText,
  type CodexAgentBridgePorts,
} from "../../src/agent/codex-agent/bridge.js";
import {
  buildConfigOverrideArgs,
  CODEX_FIXED_CONFIG_OVERRIDES,
  CODEX_MCP_SERVER_NAME,
  CODEX_MCP_TOOL_APPROVAL_MODE,
} from "../../src/agent/codex-agent/config-overrides.js";
import { probeVersion, resolveCodexBinary } from "../../src/agent/codex-agent/executable.js";
import { startCoachMcpEndpoint } from "../../src/agent/codex-agent/mcp-endpoint.js";
import { ensureCodexAgentReady } from "../../src/agent/codex-agent/probe.js";
import { CodexRequestError } from "../../src/agent/codex-agent/protocol.js";
import {
  startAppServer,
  type CodexAppServerSession,
  type CodexSpawnOptions,
} from "../../src/agent/codex-agent/session.js";
import { CODEX_VERSION_FLOOR, compareVersions } from "../../src/agent/codex-agent/version.js";
import {
  CODEX_CHATGPT_HOST,
  readConfigPath,
  verifySpawnedChild,
} from "../../src/agent/codex-agent/verify.js";
import type { EngineConfig, MemorySnapshot } from "../../src/host-ports.js";
import { LLM } from "../../src/llm.js";
import { llmTestPorts } from "../helpers/base-agent-config.js";
import { testModelProfiles } from "../helpers/model-profiles.js";

const ENABLED = process.env.CODEX_CLI_E2E !== undefined && process.env.CODEX_CLI_E2E !== "";
const MODEL = process.env.CODEX_CLI_E2E_MODEL ?? "gpt-5.6-sol";
const DEADLINE_MS = 300_000;
const CLIENT_REQUEST_METHODS = [
  "initialize",
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "account/read",
  "model/list",
  "config/read",
  "config/mcpServer/reload",
] as const;
const CLIENT_NOTIFICATION_METHODS = ["initialized"] as const;

const MUST_PRESERVE_TOKENS = ["FTP 247W", "72kg", "Mon/Wed/Fri", "Gran Fondo"];

const CHATGPT_BASE_URL_ABSENT = "absent";
const CHATGPT_BASE_URL_EMPTY = "empty string";

function chatgptBaseUrlHost(value: unknown): string {
  if (value === undefined || value === null) return CHATGPT_BASE_URL_ABSENT;
  if (value === "") return CHATGPT_BASE_URL_EMPTY;
  if (typeof value !== "string") return `non-string ${JSON.stringify(value)}`;
  try {
    return new URL(value).host;
  } catch {
    return `unparseable ${value}`;
  }
}

const EMPTY_SNAPSHOT: MemorySnapshot = {
  read: () => null,
  has: () => false,
  listSections: () => [],
  provenanceOf: () => ({ garmin: false, nonGarmin: false, unknown: true }),
};

const DROPPED: ModelMessage[] = [
  { role: "user", content: "My FTP is 247W and I weigh 72kg." },
  { role: "assistant", content: "Logged FTP 247W at 72kg." },
  { role: "user", content: "I ride Mon/Wed/Fri and my goal race is the Gran Fondo in August." },
  { role: "assistant", content: "Noted the Mon/Wed/Fri rhythm and the Gran Fondo target." },
];

const scratchDirs: string[] = [];
const sessions: CodexAppServerSession[] = [];

afterAll(async () => {
  while (sessions.length > 0) await sessions.pop()?.close();
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function codexConfigTomlPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

function configTomlStamp(): { size: number; mtimeMs: number } {
  const stats = statSync(codexConfigTomlPath());
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveBinaryPath(): Promise<string> {
  const explicit = process.env.CODEX_CLI_E2E_BINARY;
  const resolved = await resolveCodexBinary(
    explicit === undefined || explicit === "" ? {} : { explicitPath: explicit },
  );
  if (resolved === null) throw new Error("no codex binary resolved for the gated e2e run");
  return resolved;
}

async function readiness(binaryPath: string): Promise<{
  binaryPath: string;
  foreignServers: readonly string[];
  identityLine: string;
  version: string;
  models: readonly string[];
}> {
  const result = await ensureCodexAgentReady({
    binaryPath,
    model: MODEL,
    baseEnv: process.env,
    forceRefresh: true,
  });
  if (result.status !== "ready") throw result.error;
  return result;
}

function coachTools(dataDir: string): ToolSet {
  return {
    memory_read: tool({
      description: "Read the athlete's durable memory for one section.",
      inputSchema: z.object({ section: z.string().describe("memory section name") }),
      execute: async ({ section }: { section: string }) => {
        writeFileSync(join(dataDir, "memory-read-called"), section);
        return `Section ${section}: FTP 247W, 72kg, rides Mon/Wed/Fri, goal Gran Fondo.`;
      },
    }),
  } as unknown as ToolSet;
}

function bridgePorts(binaryPath: string): CodexAgentBridgePorts {
  return {
    runtime: { enabled: true, binaryPath },
    baseEnv: process.env,
    ensureReady: async (input) => {
      const result = await ensureCodexAgentReady(input);
      if (result.status !== "ready") throw result.error;
      return { binaryPath: result.binaryPath, foreignServers: result.foreignServers };
    },
  };
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

describe.skipIf(!ENABLED)("real codex app-server", () => {
  it(
    "reports a ChatGPT account on the census child and on the generation child",
    async () => {
      const binaryPath = await resolveBinaryPath();
      const version = await withDeadline(probeVersion(binaryPath), 30_000, "version probe");
      expect(compareVersions(version, CODEX_VERSION_FLOOR)).toBeGreaterThanOrEqual(0);

      const census = await withDeadline(readiness(binaryPath), 60_000, "census");
      expect(census.identityLine).toContain("ChatGPT");
      expect(census.models.length).toBeGreaterThan(0);

      const endpoint = await startCoachMcpEndpoint({
        tools: coachTools(await scratch("codex-e2e-tools-")),
        ctx: undefined,
      });
      try {
        const session = await startAppServer({
          binaryPath,
          baseEnv: process.env,
          configArgs: buildConfigOverrideArgs({
            foreignServers: census.foreignServers,
            mcp: {
              url: endpoint.url,
              bearerEnvName: endpoint.bearerEnvName,
              enabledTools: endpoint.toolNames,
            },
          }),
          bearer: { envName: endpoint.bearerEnvName, token: endpoint.bearerToken },
        });
        sessions.push(session);

        const verdict = await withDeadline(
          verifySpawnedChild(session.client, {
            censusForeignServers: census.foreignServers,
            mcp: {
              url: endpoint.url,
              bearerEnvName: endpoint.bearerEnvName,
              enabledTools: endpoint.toolNames,
            },
          }),
          60_000,
          "generation-child verification",
        );
        expect(verdict.status).toBe("ok");
        if (verdict.status !== "ok") return;
        expect(verdict.account.type).toBe("chatgpt");

        const config = await session.client.request<{ config?: Record<string, unknown> }>(
          "config/read",
          { includeLayers: false },
        );
        const values = config.config ?? {};
        for (const override of CODEX_FIXED_CONFIG_OVERRIDES) {
          const lookup = readConfigPath(values, override.key);
          expect(lookup.found, override.key).toBe(true);
          expect(lookup.value, override.key).toEqual(override.value);
        }
        const chatgptBaseUrl = readConfigPath(values, "chatgpt_base_url").value;
        expect([CHATGPT_BASE_URL_ABSENT, CODEX_CHATGPT_HOST]).toContain(
          chatgptBaseUrlHost(chatgptBaseUrl),
        );

        const servers = readConfigPath(values, "mcp_servers").value as Record<
          string,
          Record<string, unknown>
        >;
        const own = servers[CODEX_MCP_SERVER_NAME];
        expect(own?.enabled).toBe(true);
        expect(own?.url).toBe(endpoint.url);
        expect(own?.bearer_token_env_var).toBe(endpoint.bearerEnvName);
        expect(own?.enabled_tools).toEqual([...endpoint.toolNames]);
        expect(own?.default_tools_approval_mode).toBe(CODEX_MCP_TOOL_APPROVAL_MODE);
        for (const [name, entry] of Object.entries(servers)) {
          if (name === CODEX_MCP_SERVER_NAME) continue;
          expect(entry.enabled, name).toBe(false);
        }
      } finally {
        await endpoint.close();
      }
    },
    DEADLINE_MS,
  );

  it(
    "runs a full MCP round-trip turn without touching the user's config.toml",
    async () => {
      const binaryPath = await resolveBinaryPath();
      const dataDir = await scratch("codex-e2e-turn-");
      const before = configTomlStamp();
      const beforeText = await readFile(codexConfigTomlPath(), "utf8");

      const result = await withDeadline(
        codexAgentGenerateText(
          {
            modelId: MODEL,
            caller: "chat",
            system:
              "You are an endurance cycling coach talking to an athlete. Before answering, call the memory_read tool with section 'Athlete Profile'. Then answer in two sentences using the athlete's numbers.",
            messages: [{ role: "user", content: "What should I ride today?" }],
            tools: coachTools(dataDir),
          },
          bridgePorts(binaryPath),
        ),
        240_000,
        "real coaching turn",
      );

      expect(result.text.trim()).not.toBe("");
      expect(result.costBasis).toBe("notional");
      expect(existsSync(join(dataDir, "memory-read-called"))).toBe(true);
      expect(result.toolCalls.map((call) => call.toolName)).toContain("memory_read");

      const after = configTomlStamp();
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      const afterText = await readFile(codexConfigTomlPath(), "utf8");
      expect(afterText).toBe(beforeText);
      expect((afterText.match(/\[projects\./g) ?? []).length).toBe(
        (beforeText.match(/\[projects\./g) ?? []).length,
      );
    },
    DEADLINE_MS,
  );

  it(
    "enumerates every client method we send in the unknown-method error",
    async () => {
      const binaryPath = await resolveBinaryPath();
      const session = await startAppServer({ binaryPath, baseEnv: process.env });
      sessions.push(session);

      const failure = await session.client.request("thread/definitelyNotAMethod", {}).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(failure).toBeInstanceOf(CodexRequestError);
      const requestError = failure as CodexRequestError;
      expect(requestError.code).toBe(-32600);
      for (const method of CLIENT_REQUEST_METHODS) {
        expect(requestError.message, method).toContain(method);
      }
      for (const method of CLIENT_NOTIFICATION_METHODS) {
        expect(requestError.message.split(/[`']/u), method).not.toContain(method);
      }
    },
    DEADLINE_MS,
  );

  it(
    "preserves the must-preserve tokens through a real compaction and a real memory flush",
    async () => {
      const binaryPath = await resolveBinaryPath();
      const llm = new LLM(codexAgentConfig(binaryPath), llmTestPorts());

      const compacted = await withDeadline(
        summarizeDroppedMessages({
          dropped: DROPPED,
          llm,
          mustPreserveTokens: MUST_PRESERVE_TOKENS,
          memory: EMPTY_SNAPSHOT,
          caller: "compact",
          contextWindowTokens: 1_050_000,
        }),
        240_000,
        "real compaction round-trip",
      );
      for (const token of MUST_PRESERVE_TOKENS) {
        expect(compacted.summary, token).toContain(token);
      }

      const flushed = await withDeadline(
        codexAgentGenerateText(
          {
            modelId: MODEL,
            caller: "flush",
            system:
              'Return a single JSON object with exactly the keys "section" and "content" capturing the athlete facts stated below. Copy every number and date range verbatim. Output JSON only.',
            messages: [
              {
                role: "user",
                content: `FTP 247W, 72kg, rides Mon/Wed/Fri, goal race Gran Fondo in August.`,
              },
            ],
          },
          bridgePorts(binaryPath),
        ),
        240_000,
        "real memory flush",
      );

      const artifact = JSON.parse(
        flushed.text
          .replace(/^```(?:json)?/u, "")
          .replace(/```$/u, "")
          .trim(),
      ) as Record<string, unknown>;
      expect(typeof artifact.section).toBe("string");
      expect(typeof artifact.content).toBe("string");
      for (const token of MUST_PRESERVE_TOKENS) {
        expect(String(artifact.content), token).toContain(token);
      }
    },
    DEADLINE_MS,
  );

  it(
    "never starts a foreign stdio MCP server during the thread-less census",
    async () => {
      const binaryPath = await resolveBinaryPath();
      const codexHome = await scratch("codex-e2e-home-");
      const canaryPath = join(codexHome, "CANARY_FIRED");
      const canaryScript = join(codexHome, "canary.sh");
      mkdirSync(join(codexHome, "sessions"), { recursive: true });
      writeFileSync(canaryScript, `#!/bin/sh\ntouch ${JSON.stringify(canaryPath)}\nsleep 60\n`, {
        mode: 0o755,
      });
      writeFileSync(
        join(codexHome, "config.toml"),
        ["[mcp_servers.canaryserver]", `command = ${JSON.stringify(canaryScript)}`, ""].join("\n"),
      );

      const spawnProcess = (options: CodexSpawnOptions): ChildProcess =>
        spawn(options.command, [...options.args], {
          env: { ...options.env, CODEX_HOME: codexHome },
          shell: options.shell,
          stdio: [...options.stdio],
          windowsHide: options.windowsHide,
        });

      const session = await startAppServer({
        binaryPath,
        baseEnv: process.env,
        configArgs: buildConfigOverrideArgs(),
        spawnProcess,
      });
      sessions.push(session);

      const config = await withDeadline(
        session.client.request<{ config?: Record<string, unknown> }>("config/read", {
          includeLayers: false,
        }),
        60_000,
        "census config/read",
      );
      const servers = readConfigPath(config.config ?? {}, "mcp_servers").value as Record<
        string,
        unknown
      >;
      expect(Object.keys(servers)).toContain("canaryserver");

      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      expect(existsSync(canaryPath)).toBe(false);

      await session.close();
    },
    DEADLINE_MS,
  );
});
