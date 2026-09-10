import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_CHANGE_PREVIEW_TIMEOUT_MS,
  PLAN_CHANGE_TRANSLATION_BUDGET_MS,
} from "@enduragent/coach-contract";
import { z } from "zod";
import { createIntentTranslator } from "../src/intent-translation.js";
import { createFakeLLM } from "./helpers/fake-llm.js";
import { LLM } from "../src/llm.js";
import { llmTestPorts } from "./helpers/base-agent-config.js";
import type { EngineConfig, ModelTransportRequest } from "../src/host-ports.js";
import type { GenerateOptions, GenerateResult } from "../src/sport.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    [10_000, 20_000],
    [20_000, 10_000],
    [29_000, 1_000],
  ])("shares the translation budget after a %sms first call", async (elapsed, repairBudget) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const model = createFakeLLM(["not JSON", JSON.stringify(translated)]);
    const generate = model.generate.bind(model);
    vi.spyOn(model, "generate").mockImplementation(async (options) => {
      const result = await generate(options);
      now += model.capturedOpts.length === 1 ? elapsed : repairBudget - 1;
      return result;
    });

    await expect(
      createIntentTranslator(model).translateIntent("threshold 220", schema, context),
    ).resolves.toEqual(translated);

    expect(model.capturedOpts.map((options) => options.deadlineMs)).toEqual([30_000, repairBudget]);
    expect(elapsed + repairBudget).toBeLessThanOrEqual(PLAN_CHANGE_TRANSLATION_BUDGET_MS);
    expect(PLAN_CHANGE_PREVIEW_TIMEOUT_MS - PLAN_CHANGE_TRANSLATION_BUDGET_MS).toBe(15_000);
  });

  it("does not start a repair after the aggregate deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const model = createFakeLLM(["not JSON", JSON.stringify(translated)]);
    const generate = model.generate.bind(model);
    vi.spyOn(model, "generate").mockImplementation(async (options) => {
      const result = await generate(options);
      now = PLAN_CHANGE_TRANSLATION_BUDGET_MS;
      return result;
    });

    await expect(
      createIntentTranslator(model).translateIntent("threshold 220", schema, context),
    ).resolves.toBeNull();
    expect(model.capturedOpts).toHaveLength(1);
  });

  it("rejects a repair returned after the aggregate deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const model = createFakeLLM(["not JSON", JSON.stringify(translated)]);
    const generate = model.generate.bind(model);
    vi.spyOn(model, "generate").mockImplementation(async (options) => {
      const result = await generate(options);
      now = model.capturedOpts.length === 1 ? 10_000 : 30_000;
      return result;
    });

    await expect(
      createIntentTranslator(model).translateIntent("threshold 220", schema, context),
    ).resolves.toBeNull();
    expect(model.capturedOpts).toHaveLength(2);
    expect(model.capturedOpts[1].deadlineMs).toBe(20_000);
  });

  it("rejects a valid first response returned after the deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const model = createFakeLLM([JSON.stringify(translated)]);
    const generate = model.generate.bind(model);
    vi.spyOn(model, "generate").mockImplementation(async (options) => {
      const result = await generate(options);
      now = PLAN_CHANGE_TRANSLATION_BUDGET_MS;
      return result;
    });

    await expect(
      createIntentTranslator(model).translateIntent("threshold 220", schema, context),
    ).resolves.toBeNull();
    expect(model.capturedOpts).toHaveLength(1);
  });

  it("ends at thirty seconds when the provider ignores its deadline and abort signal", async () => {
    vi.useFakeTimers();
    const generate = vi.fn<(options: GenerateOptions) => Promise<GenerateResult>>(
      () => new Promise(() => {}),
    );
    const result = createIntentTranslator({ generate }).translateIntent("request", schema, context);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBeNull();
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not repair a provider response that arrives after timeout", async () => {
    vi.useFakeTimers();
    const invalid = await createFakeLLM(["invalid JSON"]).generate({});
    const generate = vi.fn<(options: GenerateOptions) => Promise<GenerateResult>>(
      () => new Promise((resolve) => setTimeout(() => resolve(invalid), 31_000)),
    );
    const result = createIntentTranslator({ generate }).translateIntent("request", schema, context);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(generate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled repair within the remaining shared budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const invalid = await createFakeLLM(["invalid JSON"]).generate({});
    const generate = vi
      .fn<(options: GenerateOptions) => Promise<GenerateResult>>()
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(invalid), 20_000)),
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    const result = createIntentTranslator({ generate }).translateIntent("request", schema, context);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].deadlineMs).toBe(10_000);

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBeNull();
    expect(generate.mock.calls[1][0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

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
    expect(options.deadlineMs).toBeGreaterThan(0);
    expect(options.deadlineMs).toBeLessThanOrEqual(30_000);
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
      athleteBirthday: "1998-09-08",
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

  it.each(["commitments", "success", "event", "change"] as const)(
    "checks the %s field with host expectations and resolved language",
    async (field) => {
      const checkSchema = z
        .object({
          outcome: z.literal("ask"),
          title: z.string(),
          body: z.string(),
          value: z.null(),
        })
        .strict();
      const checked = {
        outcome: "ask",
        title: "Уточните ответ",
        body: "Напишите точные ограничения.",
        value: null,
      };
      const checkContext = {
        ...context,
        field,
        expectations: "Use an exact date or duration; ask when one is missing.",
        today: "1998-09-08",
        language: "Russian",
      };
      const model = createFakeLLM([JSON.stringify(checked)]);

      await expect(
        createIntentTranslator(model).translateIntent(
          "Wednesdays short",
          checkSchema,
          checkContext,
        ),
      ).resolves.toEqual(checked);

      const options = model.capturedOpts[0];
      expect(JSON.parse(options.prompt ?? "null")).toEqual({
        text: "Wednesdays short",
        context: checkContext,
      });
      expect(options.system).toContain(JSON.stringify(z.toJSONSchema(checkSchema)));
      expect(options.system).toContain("The supplied schema is authoritative");
      expect(options.system).toContain("resolved language context.language");
      expect(options.system).toContain("outcome literals");
      expect(options.system).toContain("Never invent missing dates");
      expect(options.system).not.toContain("Report combined");
      expect(options.tools).toBeUndefined();
      expect(options.maxSteps).toBe(1);
    },
  );

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
