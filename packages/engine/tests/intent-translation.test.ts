import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createIntentTranslator } from "../src/intent-translation.js";
import { createFakeLLM } from "./helpers/fake-llm.js";
import { LLM } from "../src/llm.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";
import type { EngineConfig, ModelTransportRequest } from "../src/host-ports.js";

const intent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ftp"), watts: z.number().positive() }).strict(),
  z.object({ kind: z.literal("choose-workout"), workoutId: z.literal("candidate-1") }).strict(),
]);
const schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("translated"), intent }).strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
  z.object({ status: z.literal("combined") }).strict(),
]);
const context = { candidates: ["candidate-1" as const], events: ["event-1" as const] };
const translated = { status: "translated", intent: { kind: "ftp", watts: 220 } };

describe("intent translation", () => {
  it("uses the exact host schema and context without tools or a model loop", async () => {
    const model = createFakeLLM([JSON.stringify(translated)]);
    const port = createIntentTranslator(model);
    await expect(port.translateIntent("my threshold is 220", schema, context)).resolves.toEqual(
      translated,
    );
    expect(model.capturedOpts).toHaveLength(1);
    const options = model.capturedOpts[0];
    expect(options.tools).toBeUndefined();
    expect(options.maxSteps).toBe(1);
    expect(options.caller).toBe("intent-translation");
    expect(options.maxOutputTokens).toBe(2_048);
    expect(options.deadlineMs).toBe(30_000);
    expect(options.system).toContain(JSON.stringify(z.toJSONSchema(schema)));
    expect(JSON.parse(options.prompt ?? "null")).toEqual({ text: "my threshold is 220", context });
  });

  it("excludes stored athlete fields from the serialized prompt", async () => {
    const privateContext = {
      ...context,
      eligibleWorkouts: [{ workoutId: "synthetic-workout-id", name: "Private candidate name" }],
      supportingEvents: [
        {
          id: "synthetic-event-id",
          providerId: "synthetic-provider-id",
          name: "Private event name",
          date: "1998-09-20",
          role: "Training",
        },
      ],
      today: "1998-09-08",
    };
    const model = createFakeLLM([JSON.stringify({ status: "unsupported" })]);
    await createIntentTranslator(model).translateIntent("unrelated words", schema, privateContext);
    const serialized = JSON.stringify(model.capturedOpts);
    for (const value of [
      "synthetic-workout-id",
      "Private candidate name",
      "synthetic-event-id",
      "synthetic-provider-id",
      "Private event name",
      "1998-09-20",
      "1998-09-08",
      "Training",
    ])
      expect(serialized).not.toContain(value);
    expect(serialized).toContain("candidate-1");
    expect(serialized).toContain("event-1");
  });

  it.each([
    "not JSON",
    JSON.stringify({ status: "translated", intent: { kind: "ftp", watts: -2 } }),
  ])("repairs invalid output once: %s", async (invalid) => {
    const model = createFakeLLM([invalid, JSON.stringify(translated)]);
    await expect(
      createIntentTranslator(model).translateIntent("threshold 220", schema, context),
    ).resolves.toEqual(translated);
    expect(model.capturedOpts).toHaveLength(2);
    expect(model.capturedOpts[1].system).toBe(model.capturedOpts[0].system);
    expect(model.capturedOpts[1].tools).toBeUndefined();
    expect(model.capturedOpts[1].maxSteps).toBe(1);
  });

  it.each([
    { kind: "inverse", commandId: "command" },
    { kind: "choose-workout", workoutId: "invented-workout" },
    { kind: "unapproved" },
  ])("rejects disallowed output after at most two calls: %j", async (invalidIntent) => {
    const response = JSON.stringify({ status: "translated", intent: invalidIntent });
    const model = createFakeLLM([response, response, JSON.stringify(translated)]);
    await expect(
      createIntentTranslator(model).translateIntent("change it", schema, context),
    ).resolves.toBeNull();
    expect(model.capturedOpts).toHaveLength(2);
  });

  it.each(["unsupported", "combined"])("returns the host's %s outcome", async (status) => {
    const model = createFakeLLM([JSON.stringify({ status })]);
    await expect(
      createIntentTranslator(model).translateIntent("request", schema, context),
    ).resolves.toEqual({ status });
    expect(model.capturedOpts).toHaveLength(1);
  });

  it("does not retry provider failures", async () => {
    const model = createFakeLLM([
      { error: new Error("provider unavailable") },
      JSON.stringify(translated),
    ]);
    await expect(
      createIntentTranslator(model).translateIntent("request", schema, context),
    ).resolves.toBeNull();
    expect(model.capturedOpts).toHaveLength(1);
  });

  it("rejects responses containing tool calls without executing them", async () => {
    const response = {
      text: JSON.stringify(translated),
      toolCalls: [
        { type: "tool-call" as const, toolCallId: "call", toolName: "mutate", input: {} },
      ],
    };
    const model = createFakeLLM([response, response]);
    await expect(
      createIntentTranslator(model).translateIntent("request", schema, context),
    ).resolves.toBeNull();
    expect(model.capturedOpts.every((options) => options.tools === undefined)).toBe(true);
  });

  it.each(["anthropic", "openai-codex", "openai"] as const)(
    "uses the existing %s transport lane",
    async (provider) => {
      const calls: ModelTransportRequest[] = [];
      const model = createFakeLLM([JSON.stringify(translated)]);
      const config: EngineConfig = {
        dataSource: "platform",
        llm: { provider, model: "configured-model", apiKey: "test" },
        session: {
          historyTokenBudgetRatio: 0.3,
          idleMinutes: 0,
          dailyResetHour: 4,
          resetArchiveRetentionDays: 0,
          timezone: "UTC",
        },
        contextWindowTokens: 100_000,
        compactContextWindowTokens: 100_000,
      };
      const llm = new LLM(config, {
        ...llmTestPorts(),
        modelTransportDecorator: () => ({
          generate: async (request) => {
            calls.push(request);
            return model.generate(request.options);
          },
        }),
      });
      await expect(
        createIntentTranslator(llm).translateIntent("request", schema, context),
      ).resolves.toEqual(translated);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        provider,
        model: "configured-model",
        options: { maxSteps: 1 },
      });
      expect(calls[0].options.tools).toBeUndefined();
    },
  );
});
