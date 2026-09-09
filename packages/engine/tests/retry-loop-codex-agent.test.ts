import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cyclingSport } from "@enduragent/sport-cycling";

import { classifyFailure } from "../../core/src/agent/token-utils.js";
import { CoachAgent } from "../src/agent/coach-agent.js";
import type { EngineHostPorts } from "../src/host-ports.js";
import type { Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { createFakeCodex, type FakeCodex } from "./codex-agent/helpers/fake-codex.js";

const TEST_TIMEOUT_MS = 45_000;
const READINESS_SCRIPTS = ["probe-ready", "probe-ready"] as const;
const READINESS_SPAWNS = READINESS_SCRIPTS.length;

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;
let fake: FakeCodex | null = null;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-retry-codex-agent-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
});

afterEach(async () => {
  process.env.HOME = origHome;
  await fake?.cleanup();
  fake = null;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupAgent(scripts: readonly string[]): Promise<{
  chat: (chatId: string, text: string) => Promise<string>;
  codex: FakeCodex;
}> {
  const codex = await createFakeCodex({ scriptSequence: [...READINESS_SCRIPTS, ...scripts] });
  fake = codex;
  const base = baseAgentConfig(dataDir);
  const ports: EngineHostPorts = {
    ...base,
    config: {
      ...base.config,
      llm: {
        provider: "codex-agent",
        model: "gpt-5.6-sol",
        apiKey: "",
        codexAgent: { enabled: true, binaryPath: codex.binaryPath },
      },
    },
  };
  const agent = new CoachAgent(cyclingSport as unknown as Sport, ports);
  return { chat: (chatId, text) => agent.chat(chatId, text), codex };
}

function readSession(chatId: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(dataDir, "sessions", `${chatId}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function settle(
  work: Promise<string>,
): Promise<{ ok: true; value: string } | { ok: false; error: Error }> {
  return await work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as Error }),
  );
}

describe("retry loop on the codex-agent path", () => {
  it(
    "completes a turn and keeps the ledger row on notional cost basis",
    async () => {
      const rows: Array<Record<string, unknown>> = [];
      const codex = await createFakeCodex({
        scriptSequence: [...READINESS_SCRIPTS, "turn-happy"],
      });
      fake = codex;
      const base = baseAgentConfig(dataDir);
      const agent = new CoachAgent(
        cyclingSport as unknown as Sport,
        {
          ...base,
          usage: { append: (line) => rows.push(line as unknown as Record<string, unknown>) },
          config: {
            ...base.config,
            llm: {
              provider: "codex-agent",
              model: "gpt-5.6-sol",
              apiKey: "",
              codexAgent: { enabled: true, binaryPath: codex.binaryPath },
            },
          },
        } as EngineHostPorts,
      );

      const text = await agent.chat("codex-agent-happy", "how do I ride today?");

      expect(text).toContain("Easy spin today.".slice(0, 10));
      const generate = rows.filter((row) => row.kind === "generate");
      expect(generate.length).toBeGreaterThanOrEqual(1);
      for (const row of generate) {
        expect(row.provider).toBe("codex-agent");
        expect(row.costBasis).toBe("notional");
        expect(row.providerReportedCostUsd).toBeUndefined();
      }

      const persisted = readSession("codex-agent-happy");
      expect(persisted).toHaveLength(2);
      expect(persisted[0].role).toBe("user");
      expect(persisted[0].content).toMatch(/^how do I ride today\?\nCurrent time: /);
      const assistant = persisted[1];
      expect(assistant.role).toBe("assistant");
      expect(assistant.content).toBe(text);
      expect(assistant.provider).toBe("codex-agent");
      expect(assistant.model).toBe("gpt-5.6-sol");
      expect(assistant.lineageVersion).toBe("2");
      expect(typeof assistant.templateHash).toBe("string");
      expect(typeof assistant.assembledHash).toBe("string");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retries a mid-turn failure that only streamed reasoning and recovers on the next attempt",
    async () => {
      const agent = await setupAgent(["reasoning-then-fail", "turn-happy"]);

      const text = await agent.chat("codex-agent-reasoning-retry", "hello");

      expect(text).toContain("zone 2");
      expect(await agent.codex.spawnCount()).toBe(READINESS_SPAWNS + 2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "retries after a -32001 overload and then succeeds",
    async () => {
      const agent = await setupAgent(["rate-limit-32001", "turn-happy"]);

      const text = await agent.chat("codex-agent-rate-limit", "hello");

      expect(text).toContain("zone 2");
      expect(await agent.codex.spawnCount()).toBe(READINESS_SPAWNS + 2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps collecting after an error notification that says it will retry",
    async () => {
      const agent = await setupAgent(["error-will-retry-then-complete"]);

      const text = await agent.chat("codex-agent-will-retry", "hello");

      expect(text).toContain("zone 2");
      expect(await agent.codex.spawnCount()).toBe(READINESS_SPAWNS + 1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "classifies a context-window failure as overflow",
    async () => {
      const agent = await setupAgent(["context-overflow"]);

      const outcome = await settle(agent.chat("codex-agent-overflow", "hello"));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(classifyFailure(outcome.error)).toBe("overflow");
      expect(outcome.error.name).toBe("ContextOverflowError");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "classifies a failed turn as a server error",
    async () => {
      const agent = await setupAgent(["turn-failed"]);

      const outcome = await settle(agent.chat("codex-agent-failed", "hello"));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(classifyFailure(outcome.error)).toBe("server_error");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "classifies a completed turn with no assistant text as a server error",
    async () => {
      const agent = await setupAgent(["turn-completed-empty-text"]);

      const outcome = await settle(agent.chat("codex-agent-empty", "hello"));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(classifyFailure(outcome.error)).toBe("server_error");
      expect(outcome.error.message).toContain("without any assistant text");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "treats a mid-turn 401 as terminal auth without burning server-error retries",
    async () => {
      const agent = await setupAgent(["auth-401-mid-turn"]);

      const outcome = await settle(agent.chat("codex-agent-auth", "hello"));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(classifyFailure(outcome.error)).toBe("auth");
      expect(outcome.error.message).toContain("codex login");
      expect(await agent.codex.spawnCount()).toBe(READINESS_SPAWNS + 1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "surfaces a child death mid-turn as a single terminal network attempt",
    async () => {
      const agent = await setupAgent(["die-mid-turn"]);

      const outcome = await settle(agent.chat("codex-agent-death", "hello"));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(classifyFailure(outcome.error)).toBe("network");
      expect(await agent.codex.spawnCount()).toBe(READINESS_SPAWNS + 1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "normalizes a terminal error notification with no completion off the recorded error",
    async () => {
      const agent = await setupAgent(["error-terminal-no-completion"]);

      const outcome = await settle(agent.chat("codex-agent-terminal-error", "hello"));

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(classifyFailure(outcome.error)).toBe("server_error");
      expect(outcome.error.name).not.toBe("TimeoutError");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "classifies a notification stall as a timeout and interrupts the turn",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const agent = await setupAgent(["stall"]);
        let finished = false;
        const settled = settle(agent.chat("codex-agent-stall", "hello")).then((value) => {
          finished = true;
          return value;
        });

        for (let attempt = 0; attempt < 4 && !finished; attempt++) {
          if (!(await waitForTurnStart(agent.codex, READINESS_SPAWNS + attempt, () => finished))) break;
          await vi.advanceTimersByTimeAsync(121_000);
        }

        const outcome = await settled;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(classifyFailure(outcome.error)).toBe("timeout");

        const frames = await agent.codex.readFramesIn(READINESS_SPAWNS);
        expect(frames.some((frame) => frame.method === "turn/interrupt")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

async function waitForTurnStart(
  codex: FakeCodex,
  index: number,
  finished: () => boolean,
): Promise<boolean> {
  for (let poll = 0; poll < 500; poll++) {
    if (finished()) return false;
    const frames = await codex.readFramesIn(index).catch(() => []);
    if (frames.some((frame) => frame.method === "turn/start")) return true;
    await sleep(20);
  }
  throw new Error(`fake codex spawn ${index} never received turn/start`);
}
