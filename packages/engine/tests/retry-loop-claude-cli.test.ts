import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { withTestModelProfiles } from "./helpers/model-profiles.js";
import { classifyFailure } from "../../core/src/agent/token-utils.js";
import { createScriptedQuery, type ScriptedQueryState } from "./claude-cli/helpers/frame-script.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createClaudeWorkingArea } from "../src/index.js";
import type { EngineHostPorts } from "../src/host-ports.js";
import type { Sport } from "../src/sport.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = realpathSync(mkdtempSync(join(tmpdir(), "cc-retry-claude-")));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupAgent(
  scripts: readonly string[],
  configDir?: string,
): Promise<{
  chat: (chatId: string, text: string) => Promise<string>;
  state: ScriptedQueryState;
}> {
  const scripted = createScriptedQuery(scripts);
  vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
    query: scripted.query,
    createSdkMcpServer: (options: { name: string }) => ({
      type: "sdk",
      name: options.name,
      instance: {},
    }),
  }));
  vi.doMock("../src/agent/claude-cli/probe.js", () => ({
    ensureClaudeCliReady: vi.fn(async (input: { binaryPath?: string; billing?: string }) => ({
      binaryPath: input.binaryPath ?? "/Users/tester/.local/bin/claude",
      version: "2.1.80",
      identityLine: "Claude subscription",
      accountClass:
        input.billing === "api-key" ? ("api-key-token" as const) : ("subscription" as const),
    })),
  }));

  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  const base = baseAgentConfig(dataDir);
  const ports: EngineHostPorts = {
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
          billing: "subscription",
          cursorStorePath: join(dataDir, "claude-cli-sessions.json"),
          ...(configDir === undefined ? {} : { configDir }),
        },
      },
    }),
  };
  const agent = new CoachAgent(cyclingSport as unknown as Sport, ports);
  return {
    chat: (chatId: string, text: string) => agent.chat(chatId, text),
    state: scripted.state,
  };
}

describe("retry loop on the claude-cli path", () => {
  it("refuses a configuration overlap before starting a Claude query", async () => {
    const workspace = createClaudeWorkingArea({
      environment: { ...process.env, HOME: tempHome },
      homeDirectory: tempHome,
    }).cacheKey;
    const agent = await setupAgent(["happy-turn"], workspace);

    const outcome = await agent.chat("claude-overlap", "hello").then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ kind: "working-area-unavailable" });
      expect(outcome.error.message).not.toContain(tempHome);
      expect(outcome.error.message).not.toContain(workspace);
    }
    expect(agent.state.calls).toBe(0);
  });

  it("retries after a rate-limit result and then succeeds", async () => {
    vi.useFakeTimers();
    const agent = await setupAgent(["rate-limit", "happy-turn"]);

    const chatPromise = agent.chat("claude-rate-limit", "hello");
    await vi.advanceTimersByTimeAsync(130_000);

    await expect(chatPromise).resolves.toContain("Easy spin today.");
    expect(agent.state.calls).toBe(2);

    vi.useRealTimers();
  });

  it("compacts and retries after a prompt-too-long result", async () => {
    const agent = await setupAgent(["prompt-too-long", "happy-turn"]);

    const text = await agent.chat("claude-overflow", "hello");

    expect(text).toContain("Easy spin today.");
    expect(agent.state.calls).toBeGreaterThanOrEqual(2);
  });

  it("treats a mid-stream auth failure as terminal without burning server-error retries", async () => {
    const agent = await setupAgent(["logged-out-mid-stream"]);

    const outcome = await agent.chat("claude-auth", "hello").then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("Claude Code CLI is not signed in");
      expect(classifyFailure(outcome.error)).toBe("auth");
    }
    expect(agent.state.calls).toBe(1);
  });

  it("replays a mid-stream subprocess death inside the bridge and completes the turn", async () => {
    const agent = await setupAgent(["die-mid-stream", "happy-turn"]);

    const text = await agent.chat("claude-death", "hello");

    expect(text).toContain("Easy spin today.");
    expect(agent.state.calls).toBe(2);
    expect(agent.state.scripts).toEqual(["die-mid-stream", "happy-turn"]);
  });

  it("surfaces a second subprocess death as a single terminal attempt", async () => {
    vi.useFakeTimers();
    const agent = await setupAgent(["die-twice"]);

    const settled = agent.chat("claude-death-twice", "hello").then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    expect(agent.state.calls).toBe(2);

    vi.useRealTimers();
  });

  it("recovers text when the CLI exhausts its per-generation turn budget", async () => {
    const agent = await setupAgent(["max-turns", "happy-turn"]);

    const text = await agent.chat("claude-max-turns", "hello");

    expect(text).toContain("Easy spin today.");
    expect(agent.state.calls).toBe(2);
  });
});
