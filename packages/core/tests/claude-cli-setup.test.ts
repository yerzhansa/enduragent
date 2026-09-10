import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { createClaudeWorkingArea } from "@enduragent/engine";

import { say } from "../src/cli-copy.js";
import { scriptedPrompts, type ScriptedAnswers } from "./helpers/scripted-prompts.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";
import {
  CLAUDE_CLI_API_KEY_DECLINED,
  CLAUDE_CLI_SIGN_IN_GUIDANCE,
  runClaudeCliSetupStep,
} from "../src/claude-cli-setup.js";

let tempHome: string;
let origHome: string | undefined;
let origStdinTTY: boolean | undefined;
let origStdoutTTY: boolean | undefined;

const SUBSCRIPTION_LINE = "Signed in as rider@example.test - Claude Max subscription";
const API_KEY_LINE = "Using Anthropic API key billing - usage is charged to your API account.";

function configPath(): string {
  return join(tempHome, ".cycling-coach", "config.yaml");
}

function configError(kind: string, message: string): Error {
  const err = new Error(message) as Error & { kind: string };
  err.kind = kind;
  return err;
}

function readiness(identityLine: string): {
  binaryPath: string;
  version: string;
  identityLine: string;
  accountClass: "subscription" | "api-key-token";
} {
  return {
    binaryPath: "/Users/tester/.local/bin/claude",
    version: "2.1.220",
    identityLine,
    accountClass: identityLine === API_KEY_LINE ? "api-key-token" : "subscription",
  };
}

interface EnsureCall {
  billing?: string;
  forceRecheck?: boolean;
  model?: string;
  binaryPath?: string;
}

async function loadSetup(
  answers: ScriptedAnswers,
  ensureReady: (input: EnsureCall) => Promise<unknown>,
): Promise<{
  runSetup: (binary: typeof cyclingBinary) => Promise<void>;
  prompts: ReturnType<typeof scriptedPrompts>;
  calls: EnsureCall[];
  spawns: number;
}> {
  const prompts = scriptedPrompts(answers);
  const calls: EnsureCall[] = [];
  const counters = { spawns: 0 };

  vi.doMock("@clack/prompts", () => prompts);
  vi.doMock("node:child_process", () => ({
    spawn: () => {
      counters.spawns += 1;
      throw new Error("the claude-cli setup step must never spawn a login subprocess");
    },
  }));
  vi.doMock("@enduragent/engine", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
      ...actual,
      ensureClaudeCliReady: async (input: EnsureCall) => {
        calls.push(input);
        return await ensureReady(input);
      },
    };
  });

  const mod = await import("../src/setup.js");
  return {
    runSetup: mod.runSetup,
    prompts,
    calls,
    get spawns() {
      return counters.spawns;
    },
  };
}

function loggedLines(prompts: ReturnType<typeof scriptedPrompts>): string[] {
  const sink = prompts.log as unknown as Record<string, { mock: { calls: unknown[][] } }>;
  return Object.values(sink).flatMap((fn) => fn.mock.calls.map((call) => String(call[0])));
}

beforeEach(() => {
  for (const key of ["ENDURAGENT_LANGUAGE", "LANGUAGE", "LC_ALL", "LC_MESSAGES"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("LANG", "en_US.UTF-8");
  tempHome = mkdtempSync(join(tmpdir(), "cc-claude-setup-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  origStdinTTY = process.stdin.isTTY;
  origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.resetModules();
  vi.doMock("../src/secrets/backends/detect.js", () => ({
    detectBackends: vi.fn(async () => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    })),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.HOME = origHome;
  Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("claude-cli setup wizard", () => {
  it("writes the provider block and skips the api-key prompt when the probe verifies a subscription", async () => {
    const harness = await loadSetup(
      { selects: ["claude-cli", "sonnet", "plain"], passwords: ["", ""] },
      async () => readiness(SUBSCRIPTION_LINE),
    );

    await harness.runSetup(cyclingBinary);

    const yaml = parseYaml(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    const llm = yaml.llm as Record<string, unknown>;
    expect(llm.provider).toBe("claude-cli");
    expect(llm.model).toBe("sonnet");
    expect(llm.api_key).toBeUndefined();
    expect(llm.claude_cli).toEqual({
      enabled: true,
      binary_path: "/Users/tester/.local/bin/claude",
      billing: "subscription",
    });
    expect(loggedLines(harness.prompts)).toContain(SUBSCRIPTION_LINE);
    expect(harness.prompts.password).toHaveBeenCalledTimes(2);
    expect(harness.calls[0]).toMatchObject({ billing: "subscription", model: "sonnet" });
    expect(harness.spawns).toBe(0);
  });

  it("refuses without writing config and never initiates a login when the CLI is signed out", async () => {
    const harness = await loadSetup(
      { selects: ["claude-cli", "sonnet", "plain"], passwords: ["", ""] },
      async () => {
        throw configError("not-signed-in", "Claude Code CLI is not signed in.");
      },
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(harness.runSetup(cyclingBinary)).rejects.toThrow("exit:1");

    expect(existsSync(configPath())).toBe(false);
    expect(loggedLines(harness.prompts)).toContain(say(CLAUDE_CLI_SIGN_IN_GUIDANCE));
    expect(harness.spawns).toBe(0);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("offers the api-key opt-in when the CLI is authenticated with a key and honours acceptance", async () => {
    const harness = await loadSetup(
      { selects: ["claude-cli", "sonnet", "plain"], passwords: ["", ""], confirms: [true] },
      async (input) => {
        if (input.billing === "subscription") {
          throw configError("api-key-identity", "authenticated with an API key/token");
        }
        return readiness(API_KEY_LINE);
      },
    );

    await harness.runSetup(cyclingBinary);

    const yaml = parseYaml(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    const llm = yaml.llm as Record<string, unknown>;
    expect((llm.claude_cli as Record<string, unknown>).billing).toBe("api-key");
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]).toMatchObject({ billing: "api-key", forceRecheck: true });
    expect(loggedLines(harness.prompts)).toContain(API_KEY_LINE);
  });

  it("writes no config when the api-key opt-in is declined", async () => {
    const harness = await loadSetup(
      { selects: ["claude-cli", "sonnet", "plain"], passwords: ["", ""], confirms: [false] },
      async () => {
        throw configError("api-key-identity", "authenticated with an API key/token");
      },
    );
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(harness.runSetup(cyclingBinary)).rejects.toThrow("exit:1");

    expect(existsSync(configPath())).toBe(false);
    expect(loggedLines(harness.prompts)).toContain(say(CLAUDE_CLI_API_KEY_DECLINED));
    expect(harness.calls).toHaveLength(1);
  });

  it("refuses an unapproved key when the previous config already selected api-key billing", async () => {
    writeFileSync(
      configPath(),
      toYaml({
        llm: {
          provider: "claude-cli",
          model: "sonnet",
          claude_cli: { enabled: true, billing: "api-key" },
        },
      }),
      { mode: 0o600 },
    );
    const harness = await loadSetup(
      { selects: ["claude-cli", "sonnet", "plain"], passwords: ["", ""], confirms: [true] },
      async () => {
        throw configError("api-key-unapproved", "Your API key is not approved in the Claude CLI");
      },
    );
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);

    await expect(harness.runSetup(cyclingBinary)).rejects.toThrow("exit:1");

    const yaml = parseYaml(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    expect((yaml.llm as Record<string, unknown>).claude_cli).toEqual({
      enabled: true,
      billing: "api-key",
    });
    expect(harness.calls).toEqual([
      expect.objectContaining({ billing: "api-key", forceRecheck: false }),
    ]);
  });
});

describe("claude-cli setup step", () => {
  it("refuses before probing when the configured Claude directory overlaps the working area", async () => {
    const ensureReady = vi.fn(async () => readiness(SUBSCRIPTION_LINE));
    const baseEnv = { HOME: tempHome, XDG_CACHE_HOME: join(tempHome, ".cache") };
    const workspace = createClaudeWorkingArea({
      environment: baseEnv,
      homeDirectory: tempHome,
    }).cacheKey;

    const outcome = await runClaudeCliSetupStep(
      {
        billing: "subscription",
        model: "sonnet",
        configDir: workspace,
      },
      {
        baseEnv,
        ensureReady,
        note: () => {},
      },
    );

    expect(outcome).toMatchObject({ status: "refused", kind: "working-area-unavailable" });
    expect(outcome.status === "refused" ? outcome.message : "").not.toContain(tempHome);
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("never re-probes in api-key mode when the subscription attempt succeeded", async () => {
    const notes: string[] = [];
    const outcome = await runClaudeCliSetupStep(
      { billing: "subscription", model: "sonnet" },
      {
        ensureReady: async () => readiness(SUBSCRIPTION_LINE),
        confirmApiKeyOptIn: async () => {
          throw new Error("opt-in must not be offered on a verified subscription");
        },
        note: (line) => notes.push(line),
      },
    );
    expect(outcome).toMatchObject({ status: "ready", billing: "subscription" });
    expect(notes).toEqual([SUBSCRIPTION_LINE]);
  });

  it("does not offer the api-key opt-in for a timed-out probe", async () => {
    const notes: string[] = [];
    const outcome = await runClaudeCliSetupStep(
      { billing: "subscription", model: "sonnet" },
      {
        ensureReady: async () => {
          throw configError("probe-timeout", "Claude Code CLI account probe timed out.");
        },
        confirmApiKeyOptIn: async () => {
          throw new Error("opt-in must not be offered on a probe timeout");
        },
        note: (line) => notes.push(line),
      },
    );
    expect(outcome.status).toBe("refused");
    expect(notes).toEqual(["Claude Code CLI account probe timed out."]);
  });

  it("offers the opt-in for an unrecognized auth source", async () => {
    const seen: string[] = [];
    const outcome = await runClaudeCliSetupStep(
      { billing: "subscription", model: "sonnet", binaryPath: "/opt/bin/claude" },
      {
        ensureReady: async (input) => {
          seen.push(String(input?.billing));
          if (input?.billing === "subscription") {
            throw configError("unrecognized-auth-source", "Unrecognized Claude CLI auth source");
          }
          return readiness(API_KEY_LINE);
        },
        confirmApiKeyOptIn: async () => true,
        note: () => {},
      },
    );
    expect(seen).toEqual(["subscription", "api-key"]);
    expect(outcome).toMatchObject({ status: "ready", billing: "api-key" });
  });
});
