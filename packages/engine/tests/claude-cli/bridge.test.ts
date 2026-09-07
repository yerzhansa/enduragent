import { describe, expect, it, vi } from "vitest";
import { tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";

import {
  CLAUDE_CLI_TOOL_PREFIX,
  buildCanUseTool,
  buildCoachToolDefinitions,
  claudeCliGenerateText,
  mapUsage,
  renderPrompt,
  tokenTotalsFromResult,
  type ClaudeCliBridgePorts,
} from "../../src/agent/claude-cli/bridge.js";
import { NOT_SIGNED_IN_MESSAGE } from "../../src/agent/claude-cli/errors.js";
import {
  type ClaudeLaunchPurpose,
  type ClaudeWorkingAreaPort,
} from "../../src/agent/claude-cli/working-area.js";
import type { ModelStreamActivity } from "../../src/sport.js";
import { createScriptedQuery } from "./helpers/frame-script.js";
import { fixedClaudeWorkingArea } from "./helpers/working-area.js";

const SENTINEL = "sk-ant-sentinel-bridge-0000";
const BINARY = "/Users/tester/.local/bin/claude";
const WORKING_AREA = "/Users/tester/Library/Caches/Enduragent/claude";

function recordingWorkingArea(): {
  workingArea: ClaudeWorkingAreaPort;
  purposes: ClaudeLaunchPurpose[];
} {
  const purposes: ClaudeLaunchPurpose[] = [];
  return {
    purposes,
    workingArea: {
      cacheKey: WORKING_AREA,
      async prepareForLaunch(purpose) {
        purposes.push(purpose);
        return { cwd: WORKING_AREA, assertCurrent() {} };
      },
    },
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
    USER: "tester",
    ANTHROPIC_API_KEY: SENTINEL,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
    ANTHROPIC_VERTEX_PROJECT_ID: SENTINEL,
  };
}

type ToolExecuteMock = ReturnType<typeof vi.fn<(input: unknown, options: unknown) => unknown>>;

function coachTools(
  execute: ToolExecuteMock = vi.fn<(input: unknown, options: unknown) => unknown>(
    async () => "no memory yet",
  ),
): ToolSet {
  return {
    memory_read: tool({
      description: "Read durable memory",
      inputSchema: zodSchema(z.object({ section: z.string().describe("section name") })),
      execute,
    }),
    calculate_zones: tool({
      description: "Calculate zones",
      inputSchema: zodSchema(z.object({ ftpWatts: z.number().int().min(50).max(600) })),
      execute: async () => ({ z2: [120, 180] }),
    }),
  } as unknown as ToolSet;
}

function ports(
  scripts: readonly string[],
  overrides: Partial<ClaudeCliBridgePorts> = {},
): { ports: ClaudeCliBridgePorts; state: ReturnType<typeof createScriptedQuery>["state"] } {
  const scripted = createScriptedQuery(scripts);
  return {
    ports: {
      runtime: { binaryPath: BINARY, billing: "subscription" },
      workingArea: fixedClaudeWorkingArea(WORKING_AREA),
      baseEnv: baseEnv(),
      query: scripted.query,
      ...overrides,
    },
    state: scripted.state,
  };
}

function generateOpts(overrides: Record<string, unknown> = {}) {
  return {
    system: "You are the coach.",
    messages: [{ role: "user" as const, content: "how is my week" }],
    tools: coachTools(),
    caller: "chat" as const,
    modelId: "haiku",
    ...overrides,
  };
}

describe("claudeCliGenerateText option construction", () => {
  it("pins the resolved executable, the model and the sanitized env on every query site", async () => {
    const harness = ports(["die-mid-stream", "happy-turn"]);
    await claudeCliGenerateText(generateOpts(), harness.ports);

    expect(harness.state.calls).toBe(2);
    for (const options of harness.state.options) {
      expect(options.pathToClaudeCodeExecutable).toBe(BINARY);
      expect(options.model).toBe("haiku");
      expect(options.cwd).toBe(WORKING_AREA);
      const env = options.env as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBeUndefined();
      expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
      expect(env.HOME).toBe("/Users/tester");
      expect(JSON.stringify(env)).not.toContain(SENTINEL);
    }
  });

  it("carries the lane invariants and never a permission bypass", async () => {
    const harness = ports(["happy-turn"]);
    await claudeCliGenerateText(generateOpts(), harness.ports);

    const options = harness.state.options[0];
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.maxTurns).toBe(10);
    expect(options.includePartialMessages).toBe(true);
    expect(options.systemPrompt).toBe("You are the coach.");
    expect("permissionMode" in options).toBe(false);
    expect("allowDangerouslySkipPermissions" in options).toBe(false);
    expect(JSON.stringify(Object.keys(options))).not.toContain("bypassPermissions");
  });

  it("restricts the toolset to the coach MCP surface and enumerates the allowlist", async () => {
    const harness = ports(["happy-turn"]);
    await claudeCliGenerateText(generateOpts(), harness.ports);

    const options = harness.state.options[0];
    const expected = [
      `${CLAUDE_CLI_TOOL_PREFIX}memory_read`,
      `${CLAUDE_CLI_TOOL_PREFIX}calculate_zones`,
    ];
    expect(options.tools).toEqual(expected);
    expect(options.allowedTools).toEqual(expected);
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toEqual(["coach"]);
    expect(typeof options.canUseTool).toBe("function");
  });

  it("runs a toolless lane with an empty toolset and no MCP server", async () => {
    const harness = ports(["happy-turn"]);
    await claudeCliGenerateText(
      generateOpts({ tools: undefined, caller: "compact", messages: undefined, prompt: "compact" }),
      harness.ports,
    );

    const options = harness.state.options[0];
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.mcpServers).toEqual({});
  });

  it("resolves the binary through the port when the config pins no path", async () => {
    const resolveBinary = vi.fn(async () => "/opt/homebrew/bin/claude");
    const harness = ports(["happy-turn"], {
      runtime: { billing: "subscription" },
      resolveBinary,
    });
    await claudeCliGenerateText(generateOpts(), harness.ports);

    expect(resolveBinary).toHaveBeenCalledTimes(1);
    expect(harness.state.options[0].pathToClaudeCodeExecutable).toBe("/opt/homebrew/bin/claude");
  });

  it("refuses to run when no binary can be resolved", async () => {
    const harness = ports(["happy-turn"], {
      runtime: { billing: "subscription" },
      resolveBinary: async () => null,
    });

    await expect(claudeCliGenerateText(generateOpts(), harness.ports)).rejects.toThrow(
      /Claude Code CLI not found/,
    );
    expect(harness.state.calls).toBe(0);
  });
});

describe("canUseTool", () => {
  it("allows only the enumerated coach tools and denies everything else", async () => {
    const canUseTool = buildCanUseTool([`${CLAUDE_CLI_TOOL_PREFIX}memory_read`]);
    const allowOptions = {
      signal: new AbortController().signal,
      toolUseID: "toolu_1",
      requestId: "req_1",
    } as unknown as Parameters<typeof canUseTool>[2];

    await expect(
      canUseTool(`${CLAUDE_CLI_TOOL_PREFIX}memory_read`, { section: "a" }, allowOptions),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(canUseTool("Bash", { command: "rm -rf /" }, allowOptions)).resolves.toMatchObject({
      behavior: "deny",
      message: "Bash is not permitted",
    });
    await expect(
      canUseTool(`${CLAUDE_CLI_TOOL_PREFIX}memory_write`, {}, allowOptions),
    ).resolves.toMatchObject({ behavior: "deny" });
  });
});

describe("coach tool definitions", () => {
  it("executes the wrapped tool with the caller's context and threads the result back", async () => {
    const execute = vi.fn<(input: unknown, options: unknown) => unknown>(
      async () => "week looks steady",
    );
    const context = { chatId: "chat-1" };
    const definitions = buildCoachToolDefinitions(coachTools(execute), {
      messages: [{ role: "user", content: "hi" }],
      context,
    });

    const memoryRead = definitions.find((definition) => definition.name === "memory_read");
    const result = await memoryRead?.handler({ section: "training" }, undefined);

    expect(result).toEqual({ content: [{ type: "text", text: "week looks steady" }] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ experimental_context: context });
  });

  it("returns an error result for invalid arguments instead of throwing", async () => {
    const definitions = buildCoachToolDefinitions(coachTools(), {
      messages: [],
    });
    const zones = definitions.find((definition) => definition.name === "calculate_zones");

    const result = await zones?.handler({ ftpWatts: "not a number" }, undefined);

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("Invalid arguments");
  });

  it("surfaces a throwing tool as an error result", async () => {
    const execute = vi.fn(async () => {
      throw new Error("intervals unreachable");
    });
    const definitions = buildCoachToolDefinitions(coachTools(execute), { messages: [] });
    const memoryRead = definitions.find((definition) => definition.name === "memory_read");

    const result = await memoryRead?.handler({ section: "training" }, undefined);

    expect(result).toEqual({
      content: [{ type: "text", text: "intervals unreachable" }],
      isError: true,
    });
  });

  it("derives a declared input schema from the tool's json schema", () => {
    const definitions = buildCoachToolDefinitions(coachTools(), { messages: [] });
    const zones = definitions.find((definition) => definition.name === "calculate_zones");
    expect(Object.keys(zones?.inputSchema ?? {})).toEqual(["ftpWatts"]);
  });
});

describe("prompt rendering", () => {
  it("passes an explicit prompt straight through", () => {
    expect(renderPrompt({ prompt: "summarize" })).toBe("summarize");
  });

  it("renders prior history as a fenced transcript ahead of the live message", () => {
    const rendered = renderPrompt({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    });
    expect(rendered).toContain("<conversation-transcript>");
    expect(rendered).toContain("user: first");
    expect(rendered).toContain("assistant: reply");
    expect(rendered.endsWith("second")).toBe(true);
    expect(rendered.indexOf("</conversation-transcript>")).toBeLessThan(rendered.indexOf("second"));
  });

  it("sends a lone user message without a transcript block", () => {
    expect(renderPrompt({ messages: [{ role: "user", content: "only" }] })).toBe("only");
  });
});

describe("usage mapping", () => {
  it("maps a result frame's per-model usage into cache-aware token details", async () => {
    const harness = ports(["happy-turn"]);
    const result = await claudeCliGenerateText(generateOpts(), harness.ports);

    const details = result.usage.inputTokenDetails as unknown as Record<string, number>;
    expect(result.usage.inputTokens).toBe(350);
    expect(result.usage.outputTokens).toBe(27);
    expect(result.usage.totalTokens).toBe(377);
    expect(details.noCacheTokens).toBe(180);
    expect(details.cacheReadTokens).toBe(160);
    expect(details.cacheWriteTokens).toBe(10);
    expect(result.totalUsage).toEqual(result.usage);
    expect(result.steps).toBe(2);
    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("Easy spin today.");
  });

  it("falls back to the wire usage block when no per-model usage is reported", () => {
    const totals = tokenTotalsFromResult({
      type: "result",
      subtype: "success",
      modelUsage: {},
      usage: {
        input_tokens: 11,
        output_tokens: 3,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
    } as never);

    expect(totals).toEqual({ input: 11, output: 3, cacheRead: 5, cacheWrite: 2 });
    expect(mapUsage(totals).inputTokens).toBe(18);
  });

  it("omits the provider cost in subscription mode and reports it under api-key billing", async () => {
    const subscription = ports(["happy-turn"]);
    const subscriptionResult = await claudeCliGenerateText(generateOpts(), subscription.ports);
    expect(subscriptionResult.providerReportedCostUsd).toBeUndefined();
    expect(subscriptionResult.costBasis).toBe("notional");

    const apiKey = ports(["happy-turn"], {
      runtime: { binaryPath: BINARY, billing: "api-key" },
    });
    const apiKeyResult = await claudeCliGenerateText(generateOpts(), apiKey.ports);
    expect(apiKeyResult.providerReportedCostUsd).toBe(0.0021);
    expect(apiKeyResult.costBasis).toBe("actual");
    expect((apiKey.state.options[0].env as Record<string, string>).ANTHROPIC_API_KEY).toBe(
      SENTINEL,
    );
  });
});

describe("streaming", () => {
  it("forwards text deltas and tool activity to the caller's observers", async () => {
    const deltas: string[] = [];
    const activity: ModelStreamActivity[] = [];
    const harness = ports(["happy-turn"]);

    const result = await claudeCliGenerateText(
      generateOpts({
        onTextDelta: (delta: string) => deltas.push(delta),
        onStreamActivity: (event: ModelStreamActivity) => activity.push(event),
      }),
      harness.ports,
    );

    expect(deltas.slice(0, 2)).toEqual(["Checking ", "your week."]);
    expect(activity).toContainEqual({ type: "tool_start", toolCallId: "toolu_stub_1" });
    expect(activity).toContainEqual({ type: "tool_end", toolCallId: "toolu_stub_1" });
    expect(result.text).toBe("Easy spin today.");
  });
});

describe("error normalization", () => {
  it("maps a rate-limited result to RateLimitError with a retry hint", async () => {
    const harness = ports(["rate-limit"]);
    await expect(claudeCliGenerateText(generateOpts(), harness.ports)).rejects.toMatchObject({
      name: "RateLimitError",
    });

    let carried: (Error & { retryAfterMs?: number }) | null = null;
    try {
      await claudeCliGenerateText(generateOpts(), ports(["rate-limit"]).ports);
    } catch (err) {
      carried = err as Error & { retryAfterMs?: number };
    }
    expect(carried?.retryAfterMs).toBeGreaterThan(0);
  });

  it("maps a prompt-too-long result to ContextOverflowError", async () => {
    const harness = ports(["prompt-too-long"]);
    await expect(claudeCliGenerateText(generateOpts(), harness.ports)).rejects.toMatchObject({
      name: "ContextOverflowError",
    });
  });

  it("maps a mid-stream auth failure to the terminal sign-in guidance", async () => {
    const harness = ports(["logged-out-mid-stream"]);
    await expect(claudeCliGenerateText(generateOpts(), harness.ports)).rejects.toMatchObject({
      name: "ClaudeCliConfigError",
      kind: "not-signed-in",
      message: NOT_SIGNED_IN_MESSAGE,
    });
    expect(harness.state.calls).toBe(1);
  });

  it("treats a max-turns result as step exhaustion rather than an error", async () => {
    const harness = ports(["max-turns"]);
    const result = await claudeCliGenerateText(generateOpts(), harness.ports);

    expect(result.finishReason).toBe("tool-calls");
    expect(result.text).toBe("");
    expect(result.steps).toBe(10);
    expect(result.toolCalls).toEqual([
      {
        type: "tool-call",
        toolCallId: "toolu_stub_maxturns",
        toolName: "memory_read",
        input: {},
      },
    ]);
  });

  it("raises a TimeoutError when no frame arrives inside the stall window", async () => {
    const harness = ports(["never-init"], { stallMs: 25 });
    await expect(claudeCliGenerateText(generateOpts(), harness.ports)).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});

describe("subprocess death", () => {
  it("keeps intent translation stateless with no tools and no subprocess retry", async () => {
    const area = recordingWorkingArea();
    const harness = ports(["die-mid-stream", "happy-turn"], { workingArea: area.workingArea });
    await expect(
      claudeCliGenerateText(
        {
          ...generateOpts(),
          caller: "intent-translation",
          tools: undefined,
          stepLimit: 1,
        },
        harness.ports,
      ),
    ).rejects.toThrow();
    expect(harness.state.calls).toBe(1);
    expect(area.purposes).toEqual(["maintenance"]);
    expect(harness.state.options[0]).toMatchObject({
      tools: [],
      allowedTools: [],
      maxTurns: 1,
      persistSession: false,
    });
  });

  it("rebuilds and replays the generation exactly once", async () => {
    const area = recordingWorkingArea();
    const harness = ports(["die-mid-stream", "happy-turn"], {
      workingArea: area.workingArea,
    });
    const result = await claudeCliGenerateText(generateOpts(), harness.ports);

    expect(harness.state.calls).toBe(2);
    expect(harness.state.scripts).toEqual(["die-mid-stream", "happy-turn"]);
    expect(harness.state.options.map((options) => options.cwd)).toEqual([
      WORKING_AREA,
      WORKING_AREA,
    ]);
    expect(area.purposes).toEqual(["rebuild", "retry"]);
    expect(result.text).toBe("Easy spin today.");
  });

  it("fails before querying when the private working area cannot be prepared", async () => {
    const harness = ports(["happy-turn"], {
      workingArea: {
        cacheKey: WORKING_AREA,
        async prepareForLaunch() {
          throw new Error("private working area unavailable");
        },
      },
    });

    await expect(claudeCliGenerateText(generateOpts(), harness.ports)).rejects.toThrow(
      "private working area unavailable",
    );
    expect(harness.state.calls).toBe(0);
  });

  it("surfaces a second death as a terminal NetworkError", async () => {
    const harness = ports(["die-twice"]);
    await expect(claudeCliGenerateText(generateOpts(), harness.ports)).rejects.toMatchObject({
      name: "NetworkError",
    });
    expect(harness.state.calls).toBe(2);
  });

  it("does not replay once the caller aborted", async () => {
    const controller = new AbortController();
    const harness = ports(["die-mid-stream", "happy-turn"]);
    controller.abort();

    await expect(
      claudeCliGenerateText(generateOpts({ signal: controller.signal }), harness.ports),
    ).rejects.toMatchObject({ name: "NetworkError" });
    expect(harness.state.calls).toBe(1);
  });
});
