import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCoachEngine, type Config } from "@enduragent/core";
import type { ModelTransportDecorator } from "@enduragent/engine";
import { runningSport } from "@enduragent/sport-running";

function config(dataDir: string): Config {
  return {
    dataSource: "platform",
    llm: {
      provider: "openai-codex",
      model: "gpt-5.4",
      apiKey: "",
      authProfile: "openai-codex",
    },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1_050_000,
    dataDir,
  };
}

describe("running canonical engine compatibility", () => {
  let dataDir: string;
  afterEach(async () => rm(dataDir, { recursive: true, force: true }));

  it("preserves tool order, anchors, replies, sessions, and reset shape", async () => {
    dataDir = await mkdtemp(join(await realpath(tmpdir()), "running-engine-compat-"));
    await mkdir(join(dataDir, "memory"), { recursive: true });
    const zoneResults: unknown[] = [];
    const decorator: ModelTransportDecorator = () => ({
      generate: async (request) => {
        if (request.options.caller === "flush") {
          return {
            text: "facts noted",
            toolCalls: [],
            finishReason: "stop",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
            },
            steps: 1,
          };
        }
        const tools = request.options.tools as Record<
          string,
          { execute?: (input: unknown, options: unknown) => unknown }
        >;
        zoneResults.push(
          await tools.calculate_zones.execute?.(
            {},
            {
              experimental_context: request.options.context,
            },
          ),
        );
        return {
          text: "injected reply",
          toolCalls: [],
          finishReason: "stop",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
          },
          steps: 1,
        };
      },
    });
    let toolNames: readonly string[] = [];
    const engine = createCoachEngine(runningSport, config(dataDir), {
      modelTransportDecorator: decorator,
      onToolsAssembled: (names) => {
        toolNames = names;
      },
    });

    expect(toolNames).toEqual([
      "memory_read",
      "memory_query",
      "ledger_append",
      "memory_write",
      "plan_save",
      "plan_load",
      "calculate_zones",
    ]);
    expect(Object.isFrozen(toolNames)).toBe(true);
    await expect(engine.hasSession({ chatId: "running-chat" })).resolves.toEqual({
      hasSession: false,
    });

    await expect(
      engine.chat({
        chatId: "running-chat",
        message: "calculate my zones",
        turn: {
          resolvedCs: { criticalSpeedMps: 4, source: "platform", confidence: "high" },
        },
      }),
    ).resolves.toEqual({ text: "injected reply" });
    const envelope = zoneResults[0] as { untrusted_data: string; data: unknown };
    expect(typeof envelope.untrusted_data).toBe("string");
    const resolved = envelope.data as {
      zones: unknown[];
      criticalSpeedMps: number;
      anchorOrigin: string;
      csSource: string;
    };
    expect(resolved.zones).toHaveLength(6);
    expect(resolved).toMatchObject({
      criticalSpeedMps: 4,
      anchorOrigin: "auto-resolved",
      csSource: "platform",
    });
    await expect(engine.hasSession({ chatId: "running-chat" })).resolves.toEqual({
      hasSession: true,
    });

    const sessionLines = (await readFile(join(dataDir, "sessions", "running-chat.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sessionLines[0]).toMatchObject({ role: "user", content: "calculate my zones" });
    expect(sessionLines[1]).toMatchObject({
      role: "assistant",
      content: "injected reply",
      provider: "openai-codex",
      model: "gpt-5.4",
      lineageVersion: "2",
    });
    expect(sessionLines[1].templateHash).toEqual(expect.any(String));
    expect(sessionLines[1].assembledHash).toEqual(expect.any(String));

    await expect(
      engine.chat({ chatId: "missing-anchor", message: "calculate my zones" }),
    ).resolves.toEqual({ text: "injected reply" });
    expect(zoneResults[1]).toMatchObject({ data: { error: "no_cs_anchor" } });
    await expect(engine.resetSession({ chatId: "running-chat" })).resolves.toEqual({
      memoryFlushed: true,
    });
  });
});
