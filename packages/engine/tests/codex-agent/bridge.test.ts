import { afterEach, describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";
import {
  CODEX_AGENT_DISABLED_MESSAGE,
  CODEX_AGENT_WINDOWS_MESSAGE,
} from "@enduragent/coach-contract";

import { classifyFailure } from "../../../core/src/agent/token-utils.js";
import {
  CODEX_ABORT_COMPLETION_GRACE_MS,
  CODEX_TERMINAL_ERROR_GRACE_MS,
  CODEX_THREAD_SANDBOX,
  CODEX_TURN_SANDBOX_POLICY_TYPE,
  INTER_NOTIFICATION_STALL_MS,
  MAX_CODEX_DELTA_BYTES,
  MAX_CODEX_ITEMS,
  codexAgentGenerateText,
  isStatelessCaller,
  renderDeveloperInstructions,
  splitPrompt,
  type CodexAgentBridgePorts,
  type CodexAgentGenerateOpts,
} from "../../src/agent/codex-agent/bridge.js";
import { CODEX_MCP_BEARER_ENV_NAME } from "../../src/agent/codex-agent/config-overrides.js";
import type { CoachMcpEndpoint } from "../../src/agent/codex-agent/mcp-endpoint.js";
import { invalidateCodexAgentProbeCache } from "../../src/agent/codex-agent/probe.js";
import { CodexRequestError } from "../../src/agent/codex-agent/protocol.js";
import { startAppServer } from "../../src/agent/codex-agent/session.js";
import type { ModelStreamActivity } from "../../src/sport.js";
import { createFakeCodex, readVendoredEnumRules, type FakeCodex } from "./helpers/fake-codex.js";

const TEST_TIMEOUT_MS = 25_000;
const ENDPOINT_URL = "http://127.0.0.1:54321/mcp";
const SYSTEM_PROMPT = "You are a cycling coach. Prescribe zone 2 rides and never mention code.";

let fake: FakeCodex | null = null;
const endpoints: CoachMcpEndpoint[] = [];

afterEach(async () => {
  while (endpoints.length > 0) await endpoints.pop()?.close();
  await fake?.cleanup();
  fake = null;
  invalidateCodexAgentProbeCache();
});

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
}

function stubEndpoint(toolNames: readonly string[]): CoachMcpEndpoint {
  const endpoint: CoachMcpEndpoint = {
    url: ENDPOINT_URL,
    bearerToken: "sentinel-bearer-token",
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
      description: "Read a memory section",
      inputSchema: z.object({ section: z.string() }),
      execute: async () => "profile",
    }),
    plan_save: tool({
      description: "Save the plan",
      inputSchema: z.object({ plan: z.string() }),
      execute: async () => "saved",
    }),
  };
}

function ports(
  binaryPath: string,
  overrides: Partial<CodexAgentBridgePorts> = {},
): CodexAgentBridgePorts {
  return {
    runtime: { enabled: true, binaryPath },
    baseEnv: baseEnv(),
    ensureReady: async () => ({ binaryPath, foreignServers: [] }),
    startEndpoint: async (options) => stubEndpoint(Object.keys(options.tools)),
    ...overrides,
  };
}

function chatOpts(overrides: Partial<CodexAgentGenerateOpts> = {}): CodexAgentGenerateOpts {
  return {
    modelId: "gpt-5.6-sol",
    caller: "chat",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: "how do I ride today?" }],
    tools: coachTools(),
    ...overrides,
  };
}

async function stage(script: string): Promise<FakeCodex> {
  const created = await createFakeCodex({ script });
  fake = created;
  return created;
}

function frameParams(
  frames: ReadonlyArray<Record<string, unknown>>,
  method: string,
): Record<string, unknown> | undefined {
  const frame = frames.find((entry) => entry.method === method);
  return frame === undefined ? undefined : (frame.params as Record<string, unknown>);
}

describe("codexAgentGenerateText flag-off gate", () => {
  it(
    "refuses without spawning a child when the runtime is not enabled",
    async () => {
      const staged = await stage("turn-happy");

      await expect(
        codexAgentGenerateText(chatOpts(), {
          runtime: { enabled: false, binaryPath: staged.binaryPath },
          baseEnv: baseEnv(),
          startEndpoint: async (options) => stubEndpoint(Object.keys(options.tools)),
        }),
      ).rejects.toMatchObject({
        name: "CodexAgentConfigError",
        kind: "disabled",
        message: CODEX_AGENT_DISABLED_MESSAGE,
      });

      expect(await staged.spawnCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses without spawning a child when the runtime omits the flag entirely",
    async () => {
      const staged = await stage("turn-happy");
      const runtime = { binaryPath: staged.binaryPath } as CodexAgentBridgePorts["runtime"];

      await expect(
        codexAgentGenerateText(chatOpts(), {
          runtime,
          baseEnv: baseEnv(),
          startEndpoint: async (options) => stubEndpoint(Object.keys(options.tools)),
        }),
      ).rejects.toMatchObject({ kind: "disabled", message: CODEX_AGENT_DISABLED_MESSAGE });

      expect(await staged.spawnCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText platform gate", () => {
  it(
    "refuses without spawning a child when the turn runs on win32",
    async () => {
      const staged = await stage("turn-happy");

      await expect(
        codexAgentGenerateText(chatOpts(), ports(staged.binaryPath, { platform: "win32" })),
      ).rejects.toMatchObject({
        name: "CodexAgentConfigError",
        kind: "unsupported-platform",
        message: CODEX_AGENT_WINDOWS_MESSAGE,
      });

      expect(await staged.spawnCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names the platform before the flag when an enabled-less runtime runs on win32",
    async () => {
      const staged = await stage("turn-happy");

      await expect(
        codexAgentGenerateText(chatOpts(), {
          runtime: { enabled: false, binaryPath: staged.binaryPath },
          platform: "win32",
          baseEnv: baseEnv(),
          startEndpoint: async (options) => stubEndpoint(Object.keys(options.tools)),
        }),
      ).rejects.toMatchObject({
        kind: "unsupported-platform",
        message: CODEX_AGENT_WINDOWS_MESSAGE,
      });

      expect(await staged.spawnCount()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "runs the turn on a supported platform",
    async () => {
      const staged = await stage("turn-happy");
      const result = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, { platform: "darwin" }),
      );

      expect(result.finishReason).toBe("stop");
      expect(await staged.spawnCount()).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText params construction", () => {
  it(
    "starts an ephemeral thread and a read-only turn with no cwd (AC-1, AC-14, AC-20)",
    async () => {
      const staged = await stage("turn-happy");
      const result = await codexAgentGenerateText(chatOpts(), ports(staged.binaryPath));

      expect(result.text).toBe("Easy spin today: 45 minutes in zone 2, cadence 90.");
      expect(result.finishReason).toBe("stop");
      expect(result.costBasis).toBe("notional");
      expect(result.providerReportedCostUsd).toBeUndefined();
      expect(result.totalUsage?.inputTokens).toBe(1200);
      expect(result.totalUsage?.outputTokens).toBe(300);
      expect(
        (result.totalUsage?.inputTokenDetails as { cacheReadTokens?: number } | undefined)
          ?.cacheReadTokens,
      ).toBe(400);

      const frames = await staged.readFramesIn();
      expect(frames.map((frame) => frame.method)).toEqual([
        "initialize",
        "initialized",
        "account/read",
        "config/read",
        "thread/start",
        "turn/start",
      ]);

      const threadStart = frameParams(frames, "thread/start");
      expect(threadStart).toBeDefined();
      expect(threadStart?.ephemeral).toBe(true);
      expect(threadStart?.model).toBe("gpt-5.6-sol");
      expect(threadStart?.approvalPolicy).toBe("never");
      expect(threadStart?.approvalsReviewer).toBe("user");
      expect(threadStart?.sandbox).toBe("read-only");
      expect(threadStart).not.toHaveProperty("cwd");
      expect(threadStart).not.toHaveProperty("baseInstructions");
      expect(threadStart).not.toHaveProperty("collaborationMode");

      const turnStart = frameParams(frames, "turn/start");
      expect(turnStart?.threadId).toBe("thread-1");
      expect(turnStart?.input).toEqual([{ type: "text", text: "how do I ride today?" }]);
      expect(turnStart?.approvalPolicy).toBe("never");
      expect(turnStart?.approvalsReviewer).toBe("user");
      expect(turnStart?.sandboxPolicy).toEqual({ type: "readOnly" });
      expect(turnStart).not.toHaveProperty("effort");
      expect(turnStart).not.toHaveProperty("cwd");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "carries the assembled coach prompt as developerInstructions and never baseInstructions (AC-14)",
    async () => {
      const staged = await stage("turn-happy");
      await codexAgentGenerateText(chatOpts(), ports(staged.binaryPath));

      const threadStart = frameParams(await staged.readFramesIn(), "thread/start");
      const instructions = threadStart?.developerInstructions;
      expect(typeof instructions).toBe("string");
      expect(instructions).toBe(renderDeveloperInstructions(SYSTEM_PROMPT, false));
      expect(instructions as string).toContain(SYSTEM_PROMPT);
      expect(instructions as string).toContain("<coach-persona>");
      expect(instructions as string).toContain("endurance athlete");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "renders history as one fenced transcript item and passes the configured effort",
    async () => {
      const staged = await stage("turn-happy");
      await codexAgentGenerateText(
        chatOpts({
          messages: [
            { role: "user", content: "yesterday was hard" },
            { role: "assistant", content: "rest up" },
            { role: "user", content: "and today?" },
          ],
        }),
        ports(staged.binaryPath, {
          runtime: { enabled: true, binaryPath: staged.binaryPath, reasoningEffort: "medium" },
        }),
      );

      const turnStart = frameParams(await staged.readFramesIn(), "turn/start");
      expect(turnStart?.effort).toBe("medium");
      const input = turnStart?.input as Array<{ type: string; text: string }>;
      expect(input).toHaveLength(1);
      expect(input[0].type).toBe("text");
      expect(input[0].text).toContain("<conversation-transcript>");
      expect(input[0].text).toContain("user: yesterday was hard");
      expect(input[0].text).toContain("assistant: rest up");
      expect(input[0].text.endsWith("and today?")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "declares our tool endpoint and never puts the bearer token in argv (AC-11)",
    async () => {
      const staged = await stage("turn-happy-with-tool");
      const result = await codexAgentGenerateText(chatOpts(), ports(staged.binaryPath));

      expect(result.toolCalls).toEqual([
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "memory_read",
          input: { section: "Athlete Profile" },
        },
      ]);

      const argv = await staged.readArgv();
      expect(argv).toContain(`mcp_servers.enduragent.url=${ENDPOINT_URL}`);
      expect(argv).toContain(
        `mcp_servers.enduragent.bearer_token_env_var="${CODEX_MCP_BEARER_ENV_NAME}"`,
      );
      expect(argv).toContain('mcp_servers.enduragent.enabled_tools=["memory_read","plan_save"]');
      expect(argv.join(" ")).not.toContain("sentinel-bearer-token");

      const env = await staged.readEnv();
      expect(env[CODEX_MCP_BEARER_ENV_NAME]).toBe("sentinel-bearer-token");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("wire enum spellings the app-server accepts", () => {
  it("derives thread/start and turn/start enum sets from the vendored schema", async () => {
    const rules = await readVendoredEnumRules();
    const threadSandbox = rules["thread/start"]?.find((rule) => rule.path === "sandbox");
    expect(threadSandbox?.allowed).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(threadSandbox?.allowed).not.toContain("readOnly");

    const turnPolicy = rules["turn/start"]?.find((rule) => rule.path === "sandboxPolicy.type");
    expect(turnPolicy?.allowed).toContain("readOnly");
    expect(turnPolicy?.allowed).not.toContain("read-only");

    expect(CODEX_THREAD_SANDBOX).toBe("read-only");
    expect(CODEX_TURN_SANDBOX_POLICY_TYPE).toBe("readOnly");
  });

  it(
    "makes the fake reject a camel-cased thread/start sandbox the way the real binary does",
    async () => {
      const staged = await stage("turn-happy");
      const session = await startAppServer({
        binaryPath: staged.binaryPath,
        baseEnv: baseEnv(),
      });
      try {
        const failure = await session.client
          .request("thread/start", { ephemeral: true, sandbox: "readOnly" })
          .then(
            () => null,
            (err: unknown) => err as CodexRequestError,
          );
        expect(failure).toBeInstanceOf(CodexRequestError);
        expect(failure?.code).toBe(-32600);
        expect(failure?.message).toContain("unknown variant `readOnly`");
        expect(failure?.message).toContain("`read-only`");

        const accepted = await session.client.request<{ thread?: { id?: string } }>("thread/start", {
          ephemeral: true,
          sandbox: CODEX_THREAD_SANDBOX,
        });
        expect(accepted.thread?.id).toBe("thread-1");
      } finally {
        await session.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "makes the fake reject a kebab-cased turn/start sandboxPolicy tag",
    async () => {
      const staged = await stage("turn-happy");
      const session = await startAppServer({
        binaryPath: staged.binaryPath,
        baseEnv: baseEnv(),
      });
      try {
        const failure = await session.client
          .request("turn/start", {
            threadId: "thread-1",
            input: [{ type: "text", text: "hi" }],
            sandboxPolicy: { type: "read-only" },
          })
          .then(
            () => null,
            (err: unknown) => err as CodexRequestError,
          );
        expect(failure).toBeInstanceOf(CodexRequestError);
        expect(failure?.message).toContain("unknown variant `read-only`");
        expect(failure?.message).toContain("`readOnly`");
      } finally {
        await session.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText text assembly (AC-31)", () => {
  it(
    "uses the completed item text when a turn streams no deltas at all",
    async () => {
      const staged = await stage("agent-message-no-deltas");
      const streamed: string[] = [];
      const result = await codexAgentGenerateText(
        chatOpts({ onTextDelta: (delta) => streamed.push(delta) }),
        ports(staged.binaryPath),
      );

      expect(result.finishReason).toBe("stop");
      expect(result.text).toBe("Easy spin today: 45 minutes in zone 2, cadence 90.");
      expect(streamed.join("")).toBe(result.text);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "joins multiple agent messages with a blank line and streams the same string",
    async () => {
      const staged = await stage("two-agent-messages");
      const streamed: string[] = [];
      const result = await codexAgentGenerateText(
        chatOpts({ onTextDelta: (delta) => streamed.push(delta) }),
        ports(staged.binaryPath),
      );

      expect(result.text).toBe("First part.\n\nSecond part.");
      expect(streamed.join("")).toBe(result.text);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText streaming discipline (AC-17)", () => {
  it(
    "routes reasoning to activity only so a mid-turn failure leaves no observed text",
    async () => {
      const staged = await stage("reasoning-then-fail");
      const streamed: string[] = [];
      const activity: ModelStreamActivity[] = [];

      await expect(
        codexAgentGenerateText(
          chatOpts({
            onTextDelta: (delta) => streamed.push(delta),
            onStreamActivity: (event) => activity.push(event),
          }),
          ports(staged.binaryPath),
        ),
      ).rejects.toThrow(/upstream model error/);

      expect(streamed).toEqual([]);
      expect(activity.length).toBeGreaterThan(0);
      expect(activity.every((event) => event.type === "activity")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText lane-owned bounds (AC-16)", () => {
  it("pins the four bound constants", () => {
    expect(MAX_CODEX_ITEMS).toBe(60);
    expect(MAX_CODEX_DELTA_BYTES).toBe(512 * 1024);
    expect(INTER_NOTIFICATION_STALL_MS).toBe(120_000);
    expect(CODEX_ABORT_COMPLETION_GRACE_MS).toBe(5_000);
    expect(CODEX_TERMINAL_ERROR_GRACE_MS).toBe(3_000);
  });

  it(
    "cuts a runaway item stream off at the item bound and interrupts the turn",
    async () => {
      const staged = await stage("runaway-200-items");
      const result = await codexAgentGenerateText(chatOpts(), ports(staged.binaryPath));

      expect(result.finishReason).toBe("stop");
      expect(result.steps).toBe(MAX_CODEX_ITEMS);

      const frames = await staged.readFramesIn();
      expect(frames.some((frame) => frame.method === "turn/interrupt")).toBe(true);
      expect(frameParams(frames, "turn/interrupt")).toEqual({
        threadId: "thread-1",
        turnId: "turn-1",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "cuts a delta flood off at the accumulated-delta-byte bound and interrupts the turn",
    async () => {
      const staged = await stage("delta-flood");
      const streamed: string[] = [];
      const result = await codexAgentGenerateText(
        chatOpts({ onTextDelta: (delta) => streamed.push(delta) }),
        ports(staged.binaryPath, { maxDeltaBytes: 8 * 1024 }),
      );

      expect(result.finishReason).toBe("stop");
      expect(streamed.join("")).not.toBe("");
      expect(result.text).toBe(streamed.join(""));
      const frames = await staged.readFramesIn();
      expect(frames.some((frame) => frame.method === "turn/interrupt")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "interrupts and times out when no notification arrives for the stall window",
    async () => {
      const staged = await stage("stall");
      const failure = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, { stallMs: 300 }),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(failure?.name).toBe("TimeoutError");
      expect(classifyFailure(failure)).toBe("timeout");
      const frames = await staged.readFramesIn();
      expect(frames.some((frame) => frame.method === "turn/interrupt")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives up on the interrupted completion after the abort grace instead of hanging",
    async () => {
      const staged = await stage("abort-no-interrupted-completion");
      const controller = new AbortController();
      const pending = codexAgentGenerateText(
        chatOpts({
          signal: controller.signal,
          onTextDelta: () => controller.abort(),
        }),
        ports(staged.binaryPath, { abortGraceMs: 300, stallMs: 20_000 }),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

      const failure = await pending;
      expect(failure?.name).toBe("AbortError");
      const frames = await staged.readFramesIn();
      expect(frames.some((frame) => frame.method === "turn/interrupt")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "terminates an approval deny loop on the stall bound instead of hanging",
    async () => {
      const staged = await stage("deny-loop");
      const failure = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, { stallMs: 300 }),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(failure?.name).toBe("TimeoutError");
      expect(classifyFailure(failure)).toBe("timeout");

      const frames = await staged.readFramesIn();
      expect(frames.some((frame) => frame.method === "turn/interrupt")).toBe(true);

      const replies = await staged.readReplies();
      expect(replies.length).toBeGreaterThanOrEqual(2);
      for (const reply of replies) {
        expect(reply.result).toEqual({ decision: "decline" });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "normalizes a terminal error notification from the recorded error, never as a timeout",
    async () => {
      const staged = await stage("error-terminal-no-completion");
      const failure = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, { terminalErrorGraceMs: 300, stallMs: 20_000 }),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(failure?.name).toBe("ServerError");
      expect(failure?.message).toContain("upstream model error");
      expect(classifyFailure(failure)).toBe("server_error");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText child death (D-3)", () => {
  it(
    "classifies a child death as a network failure even after a will-retry error",
    async () => {
      const staged = await stage("error-will-retry-then-die");
      const failure = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, { stallMs: 20_000 }),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(failure?.name).toBe("NetworkError");
      expect(classifyFailure(failure)).toBe("network");
      expect(failure?.message).not.toContain("transient upstream hiccup");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText stateless callers (D-10)", () => {
  it.each(["flush", "compact", "intent-translation"] as const)(
    "declares no tool endpoint, opts out of reasoning chatter and never streams for %s",
    async (caller) => {
      const staged = await stage("turn-happy-stateless");
      const streamed: string[] = [];
      const result = await codexAgentGenerateText(
        chatOpts({
          caller,
          onTextDelta: (delta) => streamed.push(delta),
        }),
        ports(staged.binaryPath),
      );

      expect(isStatelessCaller(caller)).toBe(true);
      expect(result.text).toBe("Easy spin today: 45 minutes in zone 2, cadence 90.");
      expect(streamed).toEqual([]);

      const argv = await staged.readArgv();
      expect(argv.join(" ")).not.toContain("mcp_servers.enduragent");
      const env = await staged.readEnv();
      expect(env[CODEX_MCP_BEARER_ENV_NAME]).toBeUndefined();

      const frames = await staged.readFramesIn();
      const initialize = frameParams(frames, "initialize");
      const capabilities = initialize?.capabilities as Record<string, unknown>;
      expect(capabilities.experimentalApi).toBe(false);
      expect(capabilities.optOutNotificationMethods).toEqual([
        "item/reasoning/textDelta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
      ]);

      const threadStart = frameParams(frames, "thread/start");
      expect(threadStart?.developerInstructions as string).toContain("nothing else");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText census self-healing (D-19)", () => {
  it(
    "respawns once with the refreshed disable list when the census was stale",
    async () => {
      const staged = await createFakeCodex({
        scriptSequence: ["gen-child-new-server", "turn-happy"],
      });
      fake = staged;

      const censuses: Array<boolean | undefined> = [];
      const result = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, {
          ensureReady: async (input) => {
            censuses.push(input.forceRefresh);
            return { binaryPath: staged.binaryPath, foreignServers: ["alpha"] };
          },
        }),
      );

      expect(result.finishReason).toBe("stop");
      expect(censuses).toEqual([undefined, true]);
      expect(await staged.spawnCount()).toBe(2);

      const firstArgv = await staged.readArgv(0);
      expect(firstArgv).not.toContain("mcp_servers.beta.enabled=false");
      const secondArgv = await staged.readArgv(1);
      expect(secondArgv).toContain("mcp_servers.beta.enabled=false");

      const firstFrames = await staged.readFramesIn(0);
      expect(firstFrames.some((frame) => frame.method === "thread/start")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses without starting a thread when the generation child flipped to an api key (AC-18)",
    async () => {
      const staged = await stage("gen-child-auth-flip");
      let invalidations = 0;
      const failure = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, {
          invalidateProbeCache: () => {
            invalidations += 1;
          },
        }),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(failure?.message).toContain("not a ChatGPT subscription");
      expect(invalidations).toBe(1);
      const frames = await staged.readFramesIn();
      expect(frames.some((frame) => frame.method === "thread/start")).toBe(false);
      expect(frames.some((frame) => frame.method === "turn/start")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "invalidates the readiness cache on a mid-turn auth failure (AC-12)",
    async () => {
      const staged = await stage("auth-401-mid-turn");
      let invalidations = 0;
      const failure = await codexAgentGenerateText(
        chatOpts(),
        ports(staged.binaryPath, {
          invalidateProbeCache: () => {
            invalidations += 1;
          },
        }),
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

      expect(failure?.message).toContain("codex login");
      expect(invalidations).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("codexAgentGenerateText readiness wiring (D-11)", () => {
  it(
    "censuses once and disables every foreign server on the first generation spawn",
    async () => {
      const staged = await createFakeCodex({
        scriptSequence: ["probe-ready", "probe-ready", "turn-happy"],
      });
      fake = staged;

      const readinessPorts: CodexAgentBridgePorts = {
        runtime: { enabled: true, binaryPath: staged.binaryPath },
        baseEnv: baseEnv(),
        startEndpoint: async (options) => stubEndpoint(Object.keys(options.tools)),
      };

      const first = await codexAgentGenerateText(chatOpts(), readinessPorts);
      expect(first.finishReason).toBe("stop");
      expect(await staged.spawnCount()).toBe(3);

      const generationArgv = await staged.readArgv(2);
      expect(generationArgv).toContain("mcp_servers.alpha.enabled=false");
      expect(generationArgv).toContain("mcp_servers.beta.enabled=false");
      const generationFrames = await staged.readFramesIn(2);
      expect(generationFrames.some((frame) => frame.method === "thread/start")).toBe(true);

      const second = await codexAgentGenerateText(chatOpts(), readinessPorts);
      expect(second.finishReason).toBe("stop");
      expect(await staged.spawnCount()).toBe(4);
      expect(await staged.readArgv(3)).toContain("mcp_servers.beta.enabled=false");
    },
    TEST_TIMEOUT_MS,
  );
});

describe("prompt splitting", () => {
  it("treats an explicit prompt as the live message with no history", () => {
    expect(splitPrompt({ prompt: "hello" })).toEqual({ history: [], live: "hello" });
  });

  it("splits at the last user message", () => {
    const split = splitPrompt({
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });
    expect(split.live).toBe("three");
    expect(split.history).toHaveLength(2);
  });
});
