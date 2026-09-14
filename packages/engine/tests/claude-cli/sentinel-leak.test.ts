import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { tool, zodSchema, type ModelMessage, type ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  claudeCliGenerateText,
  type ClaudeCliBridgePorts,
} from "../../src/agent/claude-cli/bridge.js";
import { buildChildEnv, type ClaudeCliBilling } from "../../src/agent/claude-cli/env.js";
import { probeVersion } from "../../src/agent/claude-cli/executable.js";
import { createFakeClaude, FAIL_VERSION, type FakeClaude } from "./helpers/fake-claude.js";
import { createScriptedQuery } from "./helpers/frame-script.js";
import { fixedClaudeWorkingArea } from "./helpers/working-area.js";

const SENTINEL = "sk-ant-sentinel-do-not-leak-0000";
const WORKING_AREA = "/Users/tester/Library/Caches/Enduragent/claude";
const BILLING_MODES: readonly ClaudeCliBilling[] = ["subscription", "api-key"];
const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
] as const;

function pollutedEnv(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    SHELL: "/bin/zsh",
    USER: "tester",
    LOGNAME: "tester",
  };
  for (const key of CREDENTIAL_KEYS) base[key] = SENTINEL;
  return base;
}

function sentinelBearingKeys(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([, value]) => typeof value === "string" && value.includes(SENTINEL))
    .map(([key]) => key)
    .sort();
}

function credentialShapedKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((key) => /^(ANTHROPIC_|CLAUDE_CODE_|AWS_)/.test(key))
    .sort();
}

function expectedChildKeys(billing: ClaudeCliBilling): string[] {
  const keys = ["HOME", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"];
  return billing === "api-key" ? ["ANTHROPIC_API_KEY", ...keys].sort() : keys.sort();
}

interface SpawnCapture {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runFake(
  binaryPath: string,
  args: string[],
  billing: ClaudeCliBilling,
): Promise<SpawnCapture> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv(pollutedEnv(), { binaryPath, billing }),
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

function coachTools(): ToolSet {
  return {
    memory_read: tool({
      description: "Read durable memory",
      inputSchema: zodSchema(z.object({ section: z.string().describe("section name") })),
      execute: async () => "no memory yet",
    }),
  } as unknown as ToolSet;
}

const TURN: ModelMessage[] = [{ role: "user", content: "how is my week" }];

describe.each(BILLING_MODES)("claude-cli sentinel leak scan (%s billing)", (billing) => {
  let fake: FakeClaude | null = null;

  afterEach(async () => {
    if (fake !== null) {
      await fake.cleanup();
      fake = null;
    }
  });

  it("keeps the sentinel out of the spawned CLI's stdout, stderr and argv", async () => {
    fake = await createFakeClaude({ script: "happy-turn" });

    const captured = await runFake(
      fake.binaryPath,
      ["--output-format", "stream-json", "--verbose"],
      billing,
    );

    expect(captured.code).toBe(0);
    expect(captured.stdout).not.toContain(SENTINEL);
    expect(captured.stderr).not.toContain(SENTINEL);
    expect((await fake.readArgv()).join(" ")).not.toContain(SENTINEL);

    const childEnv = await fake.readEnv();
    expect(Object.keys(childEnv).sort()).toEqual(
      expect.arrayContaining(expectedChildKeys(billing)),
    );
    expect(credentialShapedKeys(childEnv)).toEqual(
      billing === "api-key" ? ["ANTHROPIC_API_KEY"] : [],
    );
    expect(sentinelBearingKeys(childEnv)).toEqual(
      billing === "api-key" ? ["ANTHROPIC_API_KEY"] : [],
    );
  });

  it("keeps the sentinel out of the version probe's success output", async () => {
    fake = await createFakeClaude({ version: "2.1.220" });

    const version = await probeVersion(fake.binaryPath, {
      baseEnv: pollutedEnv(),
      runtime: { binaryPath: fake.binaryPath, billing },
      workingArea: fixedClaudeWorkingArea(dirname(fake.binaryPath)),
    });

    expect(version).toBe("2.1.220");
    expect(version).not.toContain(SENTINEL);
    expect(sentinelBearingKeys(await fake.readEnv())).toEqual(
      billing === "api-key" ? ["ANTHROPIC_API_KEY"] : [],
    );
  });

  it("keeps the sentinel out of the version probe's stderr tail", async () => {
    fake = await createFakeClaude({ version: FAIL_VERSION });

    const failure = await probeVersion(fake.binaryPath, {
      baseEnv: pollutedEnv(),
      runtime: { binaryPath: fake.binaryPath, billing },
      workingArea: fixedClaudeWorkingArea(dirname(fake.binaryPath)),
    }).then(
      () => null,
      (err: unknown) => err as Error,
    );

    expect(failure?.message).toContain("startup failed");
    expect(failure?.message).not.toContain(SENTINEL);
    if (billing === "api-key") {
      expect(failure?.message).toContain("ANTHROPIC_API_KEY");
    } else {
      expect(failure?.message).not.toContain("ANTHROPIC_");
    }
  });

  it("keeps the sentinel out of the chat lane's child env and generation result", async () => {
    const scripted = createScriptedQuery(["happy-turn"]);
    const ports: ClaudeCliBridgePorts = {
      runtime: { binaryPath: "/Users/tester/.local/bin/claude", billing },
      workingArea: fixedClaudeWorkingArea(WORKING_AREA),
      baseEnv: pollutedEnv(),
      query: scripted.query,
    };

    const result = await claudeCliGenerateText(
      {
        system: "You are the coach.",
        messages: TURN,
        tools: coachTools(),
        caller: "chat",
        cacheKey: "0123456789abcdef",
        modelId: "sonnet",
      },
      ports,
    );

    const childEnv = scripted.state.options[0].env as Record<string, string>;
    expect(Object.keys(childEnv).sort()).toEqual(
      [...expectedChildKeys(billing), "ENABLE_CLAUDEAI_MCP_SERVERS"].sort(),
    );
    expect(sentinelBearingKeys(childEnv)).toEqual(
      billing === "api-key" ? ["ANTHROPIC_API_KEY"] : [],
    );
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("keeps the sentinel out of every normalized error message", async () => {
    for (const script of ["rate-limit", "prompt-too-long", "die-twice", "logged-out-mid-stream"]) {
      const scripted = createScriptedQuery([script]);
      const ports: ClaudeCliBridgePorts = {
        runtime: { binaryPath: "/Users/tester/.local/bin/claude", billing },
        workingArea: fixedClaudeWorkingArea(WORKING_AREA),
        baseEnv: pollutedEnv(),
        query: scripted.query,
      };

      const failure = await claudeCliGenerateText(
        {
          system: "You are the coach.",
          messages: TURN,
          tools: coachTools(),
          caller: "chat",
          cacheKey: "0123456789abcdef",
          modelId: "sonnet",
        },
        ports,
      ).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(failure, script).not.toBeNull();
      expect(failure?.message, script).not.toContain(SENTINEL);
      expect(
        JSON.stringify(failure, Object.getOwnPropertyNames(failure ?? {})),
        script,
      ).not.toContain(SENTINEL);
    }
  });

  it("sanitizes the flush and compact one-shot child env identically to the chat lane", async () => {
    for (const caller of ["flush", "compact"] as const) {
      const scripted = createScriptedQuery(["happy-turn"]);
      const ports: ClaudeCliBridgePorts = {
        runtime: { binaryPath: "/Users/tester/.local/bin/claude", billing },
        workingArea: fixedClaudeWorkingArea(WORKING_AREA),
        baseEnv: pollutedEnv(),
        query: scripted.query,
      };

      await claudeCliGenerateText(
        {
          system: "Summarize the conversation.",
          messages: TURN,
          tools: coachTools(),
          caller,
          cacheKey: "0123456789abcdef",
          modelId: "sonnet",
        },
        ports,
      );

      const options = scripted.state.options[0];
      const childEnv = options.env as Record<string, string>;
      expect(options.persistSession, caller).toBe(false);
      expect(Object.keys(childEnv).sort(), caller).toEqual(
        [...expectedChildKeys(billing), "ENABLE_CLAUDEAI_MCP_SERVERS"].sort(),
      );
      expect(sentinelBearingKeys(childEnv), caller).toEqual(
        billing === "api-key" ? ["ANTHROPIC_API_KEY"] : [],
      );
    }
  });
});

describe.each(BILLING_MODES)("claude-cli ledger and error surfaces (%s billing)", (billing) => {
  let tempHome: string;
  let originalHome: string | undefined;
  let dataDir: string;
  const originalCredentials = new Map<string, string | undefined>();

  beforeEach(() => {
    tempHome = mkdtempSync(join(realpathSync(tmpdir()), "cc-sentinel-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    for (const key of CREDENTIAL_KEYS) {
      originalCredentials.set(key, process.env[key]);
      process.env[key] = SENTINEL;
    }
    dataDir = join(tempHome, ".cycling-coach");
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    for (const [key, value] of originalCredentials) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalCredentials.clear();
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function chatOnce(
    script: string,
    text: string,
  ): Promise<{ error: Error | null; ledger: string }> {
    const scripted = createScriptedQuery([script]);
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: scripted.query,
      createSdkMcpServer: (options: { name: string }) => ({
        type: "sdk",
        name: options.name,
        instance: {},
      }),
    }));
    vi.doMock("../../src/agent/claude-cli/probe.js", () => ({
      ensureClaudeCliReady: vi.fn(async (input: { binaryPath?: string; billing?: string }) => ({
        binaryPath: input.binaryPath ?? "/Users/tester/.local/bin/claude",
        version: "2.1.80",
        identityLine: "Claude subscription",
        accountClass:
          input.billing === "api-key" ? ("api-key-token" as const) : ("subscription" as const),
      })),
    }));

    const { CoachAgent } = await import("../../src/agent/coach-agent.js");
    const { baseAgentConfig } = await import("../helpers/base-agent-config.js");
    const { withTestModelProfiles } = await import("../helpers/model-profiles.js");
    const { cyclingSport } = await import("@enduragent/sport-cycling");
    const base = baseAgentConfig(dataDir);
    const agent = new CoachAgent(cyclingSport as never, {
      ...base,
      config: withTestModelProfiles({
        ...base.config,
        llm: {
          provider: "claude-cli",
          model: "sonnet",
          apiKey: "",
          claudeCli: {
            enabled: true,
            binaryPath: "/Users/tester/.local/bin/claude",
            billing,
            cursorStorePath: join(dataDir, "claude-cli-sessions.json"),
          },
        },
      }),
    });

    const error = await agent.chat("sentinel-scan", text).then(
      () => null,
      (err: unknown) => err as Error,
    );
    let ledger = "";
    try {
      ledger = readFileSync(join(dataDir, "usage-ledger.jsonl"), "utf8");
    } catch {
      ledger = "";
    }
    return { error, ledger };
  }

  it("emits no ledger line carrying the sentinel", async () => {
    const { error, ledger } = await chatOnce("happy-turn", "hello");

    expect(error).toBeNull();
    expect(ledger).toContain('"provider":"claude-cli"');
    expect(ledger).not.toContain(SENTINEL);
    for (const raw of ledger.split("\n").filter((entry) => entry.trim() !== "")) {
      expect(JSON.stringify(JSON.parse(raw) as unknown)).not.toContain(SENTINEL);
    }
  });

  it("normalizes a mid-stream auth failure without echoing the sentinel", async () => {
    const { error, ledger } = await chatOnce("logged-out-mid-stream", "hello");

    expect(error?.message).toContain("Claude Code CLI is not signed in");
    expect(error?.message).not.toContain(SENTINEL);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))).not.toContain(SENTINEL);
    expect(ledger).not.toContain(SENTINEL);
  });
});
