import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tool, type ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { CoachAgent } from "../../src/agent/coach-agent.js";
import {
  codexAgentGenerateText,
  type CodexAgentBridgePorts,
} from "../../src/agent/codex-agent/bridge.js";
import {
  CODEX_MCP_BEARER_ENV_NAME,
  buildConfigOverrideArgs,
} from "../../src/agent/codex-agent/config-overrides.js";
import { buildChildEnv } from "../../src/agent/codex-agent/env.js";
import { probeVersion } from "../../src/agent/codex-agent/executable.js";
import type { CoachMcpEndpoint } from "../../src/agent/codex-agent/mcp-endpoint.js";
import {
  ensureCodexAgentReady,
  invalidateCodexAgentProbeCache,
} from "../../src/agent/codex-agent/probe.js";
import type { Sport } from "../../src/sport.js";
import { baseAgentConfig } from "../helpers/base-agent-config.js";
import { withTestModelProfiles } from "../helpers/model-profiles.js";
import { createFakeCodex, FAIL_VERSION, type FakeCodex } from "./helpers/fake-codex.js";

const TEST_TIMEOUT_MS = 30_000;
const MODEL = "gpt-5.6-sol";

const BEARER_SENTINEL = "bearer-sentinel-do-not-leak-0000";
const CONFIG_SENTINEL = "cfg-sentinel-do-not-leak-0000";
const ENV_SENTINEL = "codex-api-key-sentinel-do-not-leak-0000";

const CREDENTIAL_KEYS = [
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

let fake: FakeCodex | null = null;
const endpoints: CoachMcpEndpoint[] = [];

afterEach(async () => {
  while (endpoints.length > 0) await endpoints.pop()?.close();
  await fake?.cleanup();
  fake = null;
  invalidateCodexAgentProbeCache();
});

function pollutedEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    SHELL: "/bin/zsh",
    USER: "tester",
    LOGNAME: "tester",
  };
  for (const key of CREDENTIAL_KEYS) base[key] = ENV_SENTINEL;
  return base;
}

function sentinelBearingKeys(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(
      ([, value]) =>
        typeof value === "string" &&
        [BEARER_SENTINEL, CONFIG_SENTINEL, ENV_SENTINEL].some((sentinel) =>
          value.includes(sentinel),
        ),
    )
    .map(([key]) => key)
    .sort();
}

function providerShapedKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((key) => /^(CODEX_|OPENAI_)/.test(key))
    .sort();
}

function stubEndpoint(toolNames: readonly string[]): CoachMcpEndpoint {
  const endpoint: CoachMcpEndpoint = {
    url: "http://127.0.0.1:54321/mcp",
    bearerToken: BEARER_SENTINEL,
    bearerEnvName: CODEX_MCP_BEARER_ENV_NAME,
    toolNames,
    close: async () => undefined,
  };
  endpoints.push(endpoint);
  return endpoint;
}

function coachTools(): ToolSet {
  return {
    memory_read: tool({
      description: "Read durable memory",
      inputSchema: z.object({ section: z.string() }),
      execute: async () => "no memory yet",
    }),
  } as unknown as ToolSet;
}

function ports(binaryPath: string): CodexAgentBridgePorts {
  return {
    runtime: { enabled: true, binaryPath },
    baseEnv: pollutedEnv(),
    ensureReady: async () => ({ binaryPath, foreignServers: ["alpha"] }),
    startEndpoint: async (options) => stubEndpoint(Object.keys(options.tools)),
  };
}

interface SpawnCapture {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runFake(binaryPath: string, args: readonly string[]): Promise<SpawnCapture> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv(pollutedEnv(), {
        bearerEnvName: CODEX_MCP_BEARER_ENV_NAME,
        bearerToken: BEARER_SENTINEL,
      }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.end();
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("codex-agent sentinel leak scan (AC-11)", () => {
  it(
    "keeps the bearer out of argv, stdout and stderr and out of every non-introduced env key",
    async () => {
      const staged = await createFakeCodex({ script: "handshake-only" });
      fake = staged;

      const args = ["app-server", ...buildConfigOverrideArgs({ foreignServers: ["alpha"] })];
      const captured = await runFake(staged.binaryPath, args);

      expect(captured.stdout).not.toContain(BEARER_SENTINEL);
      expect(captured.stderr).not.toContain(BEARER_SENTINEL);
      const argv = await staged.readArgv();
      expect(argv.join(" ")).not.toContain(BEARER_SENTINEL);
      expect(argv.join(" ")).not.toContain(ENV_SENTINEL);

      const childEnv = await staged.readEnv();
      expect(sentinelBearingKeys(childEnv)).toEqual([CODEX_MCP_BEARER_ENV_NAME]);
      expect(providerShapedKeys(childEnv)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the sentinels out of the version probe's stderr tail",
    async () => {
      const staged = await createFakeCodex({ version: FAIL_VERSION });
      fake = staged;

      const failure = await probeVersion(staged.binaryPath, { baseEnv: pollutedEnv() }).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(failure?.message).toContain("startup failed");
      for (const sentinel of [BEARER_SENTINEL, CONFIG_SENTINEL, ENV_SENTINEL]) {
        expect(failure?.message).not.toContain(sentinel);
      }
      expect(failure?.message).not.toMatch(/CODEX_|OPENAI_/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps every sentinel out of a successful generation's argv, child env and result",
    async () => {
      const staged = await createFakeCodex({ script: "turn-happy-secret-config" });
      fake = staged;

      const result = await codexAgentGenerateText(
        {
          modelId: MODEL,
          caller: "chat",
          system: "You are a cycling coach.",
          messages: [{ role: "user", content: "what should I ride today?" }],
          tools: coachTools(),
        },
        ports(staged.binaryPath),
      );

      const argv = await staged.readArgv();
      expect(argv.join(" ")).not.toContain(BEARER_SENTINEL);
      expect(argv).toContain(
        `mcp_servers.enduragent.bearer_token_env_var="${CODEX_MCP_BEARER_ENV_NAME}"`,
      );

      const childEnv = await staged.readEnv();
      expect(sentinelBearingKeys(childEnv)).toEqual([CODEX_MCP_BEARER_ENV_NAME]);
      expect(providerShapedKeys(childEnv)).toEqual([]);

      const serialized = JSON.stringify(result);
      for (const sentinel of [BEARER_SENTINEL, CONFIG_SENTINEL, ENV_SENTINEL]) {
        expect(serialized).not.toContain(sentinel);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps every sentinel out of each normalized failure message",
    async () => {
      for (const script of [
        "turn-failed",
        "rate-limit-32001",
        "die-mid-turn",
        "auth-401-mid-turn",
      ]) {
        const staged = await createFakeCodex({ script });
        fake = staged;

        const failure = await codexAgentGenerateText(
          {
            modelId: MODEL,
            caller: "chat",
            system: "You are a cycling coach.",
            messages: [{ role: "user", content: "what should I ride today?" }],
            tools: coachTools(),
          },
          ports(staged.binaryPath),
        ).then(
          () => null,
          (err: unknown) => err as Error,
        );

        expect(failure, script).not.toBeNull();
        const serialized = JSON.stringify(failure, Object.getOwnPropertyNames(failure ?? {}));
        for (const sentinel of [BEARER_SENTINEL, CONFIG_SENTINEL, ENV_SENTINEL]) {
          expect(failure?.message, `${script} ${sentinel}`).not.toContain(sentinel);
          expect(serialized, `${script} ${sentinel}`).not.toContain(sentinel);
        }

        await staged.cleanup();
        fake = null;
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "never retains a foreign server's config secret in the readiness report",
    async () => {
      const staged = await createFakeCodex({ script: "probe-secret-config-read" });
      fake = staged;

      const result = await ensureCodexAgentReady(
        { binaryPath: staged.binaryPath, model: "gpt-5.9-unlisted", baseEnv: pollutedEnv() },
        { log: () => undefined },
      );

      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.foreignServers).toEqual(["alpha"]);
      expect(result.warnings).toHaveLength(1);

      const serialized = JSON.stringify(result);
      for (const sentinel of [BEARER_SENTINEL, CONFIG_SENTINEL, ENV_SENTINEL]) {
        expect(serialized).not.toContain(sentinel);
      }
      expect(providerShapedKeys(await staged.readEnv(1))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codex-agent ledger surface (AC-11, AC-13)", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let dataDir: string;
  const originalCredentials = new Map<string, string | undefined>();

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "cc-codex-agent-sentinel-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    for (const key of CREDENTIAL_KEYS) {
      originalCredentials.set(key, process.env[key]);
      process.env[key] = ENV_SENTINEL;
    }
    dataDir = join(tempHome, ".cycling-coach");
    mkdirSync(join(dataDir, "memory"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const [key, value] of originalCredentials) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalCredentials.clear();
    rmSync(tempHome, { recursive: true, force: true });
  });

  it(
    "writes a notional generate row that carries no sentinel",
    async () => {
      const staged = await createFakeCodex({
        scriptSequence: [
          "probe-secret-config-read",
          "probe-secret-config-read",
          "turn-happy-secret-config",
        ],
      });
      fake = staged;

      const { cyclingSport } = await import("@enduragent/sport-cycling");
      const base = baseAgentConfig(dataDir);
      const agent = new CoachAgent(cyclingSport as unknown as Sport, {
        ...base,
        config: withTestModelProfiles({
          ...base.config,
          llm: {
            provider: "codex-agent",
            model: MODEL,
            apiKey: "",
            codexAgent: { enabled: true, binaryPath: staged.binaryPath },
          },
        }),
      });

      const reply = await agent.chat("sentinel-scan", "what should I ride today?");
      expect(reply).toContain("zone 2");

      const ledger = readFileSync(join(dataDir, "usage-ledger.jsonl"), "utf8");
      for (const sentinel of [BEARER_SENTINEL, CONFIG_SENTINEL, ENV_SENTINEL]) {
        expect(ledger).not.toContain(sentinel);
      }
      const rows = ledger
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const generate = rows.find((row) => row.kind === "generate");
      expect(generate).toBeDefined();
      expect(generate?.provider).toBe("codex-agent");
      expect(generate?.costBasis).toBe("notional");
      expect(generate?.providerReportedCostUsd).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
