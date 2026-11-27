import { describe, expect, it } from "vitest";
import { APICallError, asSchema, simulateReadableStream, stepCountIs, streamText, tool, zodSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createCoachEngine, type ModelTransport } from "@enduragent/engine";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CASES } from "./cases.js";
import { UNPARSED_TOOL, evaluateTurn, type TurnObservation } from "./checks.js";
import { buildStoreFixture, dateKey } from "./fixture.js";
import { TOMORROW_WORKOUT_ID, buildIntervalsFixture } from "./fixture-intervals.js";
import { CHAT_IDS, CaseRecorder, createEvalPorts, recordingDecorator, type Channel, type EvalData } from "./ports.js";
import { mergeTurns } from "./report.js";
import { DELETE_ALL_INJECTION } from "./safety-cases.js";
import { SpendMeter } from "./spend.js";

interface ScriptedCall {
  readonly tool: string;
  readonly input: unknown;
}

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
};

function scriptedModel(calls: readonly ScriptedCall[], costUsd: number): ModelTransport {
  return {
    generate: async (request) => {
      const tools = request.options.tools ?? {};
      for (const [index, call] of calls.entries()) {
        const tool = tools[call.tool];
        if (tool === undefined) throw new Error(`tool ${call.tool} is not offered`);
        const validated = await asSchema(tool.inputSchema).validate?.(call.input);
        if (validated?.success !== true || tool.execute === undefined) continue;
        await tool.execute(validated.value, {
          toolCallId: `call-${index}`,
          messages: [],
          experimental_context: request.options.context,
        });
      }
      return {
        text: "Done.",
        toolCalls: [],
        finishReason: "stop",
        usage,
        totalUsage: usage,
        steps: calls.length + 1,
        providerReportedCostUsd: costUsd,
      };
    },
  };
}

const tomorrow = dateKey(new Date(), 1);
const createWorkout: ScriptedCall = {
  tool: "intervals_create_workout",
  input: {
    date: tomorrow,
    workout: {
      name: "Endurance 60",
      steps: [
        { type: "warmup", duration: { value: 10, unit: "minutes" }, power: { kind: "percent_ftp", low: 50, high: 65 } },
        { type: "steady", duration: { value: 40, unit: "minutes" }, power: { kind: "percent_ftp", value: 65 } },
        { type: "cooldown", duration: { value: 10, unit: "minutes" }, power: { kind: "percent_ftp", low: 45, high: 60 } },
      ],
    },
  },
};

const rejectedKey: ModelTransport = {
  generate: async () => {
    throw new APICallError({
      message: "API key expired.",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 401,
    });
  },
};

async function runScripted(
  channel: Channel,
  turns: readonly (readonly ScriptedCall[])[],
  meter = new SpendMeter(10),
  model: (calls: readonly ScriptedCall[]) => ModelTransport = (calls) => scriptedModel(calls, 0.01),
  data: EvalData = { kind: "store", fixture: buildStoreFixture("connected", new Date()) },
): Promise<{ observations: TurnObservation[]; meter: SpendMeter; errors: string[]; summaries: string[] }> {
  const recorder = new CaseRecorder();
  const harness = createEvalPorts({
    model: "deepseek/deepseek-v4-flash",
    apiKey: "offline",
    data,
    today: new Date(),
    recorder,
    meter,
  });
  const observations: TurnObservation[] = [];
  const errors: string[] = [];
  const summaries: string[] = [];
  try {
    for (const calls of turns) {
      const engine = createCoachEngine({
        sport: cyclingSport,
        ports: {
          ...harness.ports,
          modelTransportDecorator: () => recordingDecorator(recorder, meter)(model(calls)),
        },
      });
      recorder.startTurn();
      try {
        const response = await engine.chat({ chatId: CHAT_IDS[channel], message: "Add the workout." });
        const pending = harness.gate.peek(CHAT_IDS[channel]);
        if (pending !== undefined) summaries.push(pending.summary);
        observations.push(recorder.finishTurn(response.text, pending));
      } catch (error) {
        errors.push(error instanceof Error ? error.name : String(error));
      }
      await engine.settle?.();
    }
  } finally {
    harness.dispose();
  }
  return { observations, meter, errors, summaries };
}

function intervalsData(setting: "intervals" | "intervals-close-rides" = "intervals"): EvalData {
  return {
    kind: "intervals",
    fixture: buildIntervalsFixture(setting, new Date(), { field: "activity.name", text: DELETE_ALL_INJECTION }),
  };
}

const lastWeek = { oldest: dateKey(new Date(), -7), newest: dateKey(new Date(), 0) };

describe("coach eval ports", () => {
  it("holds a Telegram calendar write as a pending proposal and executes nothing", async () => {
    const { observations } = await runScripted("telegram", [[createWorkout]]);
    const [turn] = observations;
    expect(turn.attempts).toEqual([
      { tool: "intervals_create_workout", input: createWorkout.input, valid: true, caller: "chat" },
    ]);
    expect(turn.proposals.map((proposal) => proposal.tool)).toEqual(["intervals_create_workout"]);
    expect(turn.pendingProposal).toBe(true);
    expect(turn.writes.filter((write) => write.target === "calendar")).toEqual([]);
    const telegramCase = CASES.find((evalCase) => evalCase.id === "telegram-add-workout");
    expect(evaluateTurn(telegramCase?.turns[0].expect ?? [], turn).every((check) => check.pass)).toBe(true);
  });

  it("executes a desktop calendar write without a proposal", async () => {
    const { observations } = await runScripted("desktop", [[createWorkout]]);
    const [turn] = observations;
    expect(turn.proposals).toEqual([]);
    expect(turn.pendingProposal).toBe(false);
    expect(turn.writes.filter((write) => write.target === "calendar").map((write) => write.operation)).toEqual([
      "createEvent",
    ]);
  });

  it("records a tool call that fails input validation as an attempt", async () => {
    const { observations } = await runScripted("desktop", [[{ tool: "calculate_zones", input: { ftpWatts: 720 } }]]);
    const [turn] = observations;
    expect(turn.attempts).toEqual([{ tool: "calculate_zones", input: { ftpWatts: 720 }, valid: false, caller: "chat" }]);
    expect(turn.offeredTools).toContain("intervals_fetch_activities");
  });

  it("refuses the next model call once the spend limit is reached", async () => {
    const meter = new SpendMeter(0.01);
    const { observations, errors } = await runScripted("desktop", [[], []], meter);
    expect(observations.length + errors.length).toBe(2);
    expect(meter.snapshot().spentUsd).toBeCloseTo(0.01);
    expect(meter.snapshot().refusedCalls).toBeGreaterThan(0);
  });

  it("stops the run when the provider refuses the key", async () => {
    const meter = new SpendMeter(10);
    await runScripted("desktop", [[]], meter, () => rejectedKey);
    expect(meter.stopReason()).toMatch(/refused the key in OPENROUTER_API_KEY \(HTTP 401: API key expired\.\)/);
    expect(meter.snapshot().failedCalls).toBeGreaterThan(0);
  });
});

describe("coach eval data paths", () => {
  it("serves the intervals fake and records the injected ride name in a tool result", async () => {
    const fetch: ScriptedCall = { tool: "intervals_fetch_activities", input: lastWeek };
    const { observations, errors } = await runScripted("cli", [[fetch]], undefined, undefined, intervalsData());
    expect(errors).toEqual([]);
    const [turn] = observations;
    expect(turn.results.map((result) => result.tool)).toEqual(["intervals_fetch_activities"]);
    const injected = CASES.find((evalCase) => evalCase.id === "injected-delete-cli");
    expect(evaluateTurn(injected?.turns[0].expect ?? [], turn).map((check) => check.pass)).toEqual([true, true, true]);
    expect(turn.offeredTools).not.toContain("read_plan_reference");
  });

  it("holds every calendar write for approval on the intervals data, the cli chat included", async () => {
    const { observations } = await runScripted("cli", [[createWorkout]], undefined, undefined, intervalsData());
    const [turn] = observations;
    expect(turn.proposals.map((proposal) => proposal.tool)).toEqual(["intervals_create_workout"]);
    expect(turn.pendingProposal).toBe(true);
    expect(turn.writes).toEqual([]);
  });

  it("holds a Telegram delete of tomorrow's workout and summarizes it from the fake calendar", async () => {
    const list: ScriptedCall = { tool: "intervals_list_events", input: { oldest: dateKey(new Date(), 0), newest: dateKey(new Date(), 7) } };
    const remove: ScriptedCall = { tool: "intervals_delete_workout", input: { eventId: TOMORROW_WORKOUT_ID } };
    const { observations, summaries, errors } = await runScripted(
      "telegram",
      [[list], [remove]],
      undefined,
      undefined,
      intervalsData(),
    );
    expect(errors).toEqual([]);
    expect(summaries.at(-1)).toContain("Endurance 60");
    const merged = mergeTurns(observations);
    expect(merged.approvalCodes).toHaveLength(1);
    const deleteCase = CASES.find((evalCase) => evalCase.id === "telegram-delete-workout");
    expect(evaluateTurn(deleteCase?.expectAcrossTurns ?? [], merged).every((check) => check.pass)).toBe(true);
  });

  it("offers the desktop plan reference tool on store data", async () => {
    const { observations } = await runScripted("desktop", [[]]);
    expect(observations[0].offeredTools).toContain("read_plan_reference");
  });

  it("tells the coach how old the stale store data is", async () => {
    const fetch: ScriptedCall = { tool: "intervals_fetch_wellness", input: { oldest: dateKey(new Date(), -30) } };
    const stale: EvalData = { kind: "store", fixture: buildStoreFixture("stale-data", new Date()) };
    const { observations } = await runScripted("desktop", [[fetch]], undefined, undefined, stale);
    expect(JSON.stringify(observations[0].results)).toContain("last synchronized 10 days ago");
  });
});

describe("attempt recorder under the AI SDK's own tool-call parsing", () => {
  const zones = tool({
    description: "zones",
    inputSchema: zodSchema(z.object({ ftpWatts: z.number().int().min(50).max(600) })),
    execute: async ({ ftpWatts }: { ftpWatts: number }) => ({ z2: [Math.round(ftpWatts * 0.56), Math.round(ftpWatts * 0.75)] }),
  });

  function streamingModel(calls: readonly { readonly toolName: string; readonly input: string }[]): MockLanguageModelV3 {
    return new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            ...calls.map((call, index) => ({
              type: "tool-call" as const,
              toolCallId: `call-${index}`,
              toolName: call.toolName,
              input: call.input,
            })),
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ],
        }),
      },
    });
  }

  function sdkTransport(model: MockLanguageModelV3): ModelTransport {
    return {
      generate: async (request) => {
        const result = streamText({ model, tools: request.options.tools, prompt: "go", stopWhen: stepCountIs(1) });
        for await (const part of result.fullStream) {
          if (part.type === "tool-call") request.options.onStreamActivity?.({ type: "tool_start", toolCallId: part.toolCallId });
        }
        return { text: "", toolCalls: [], finishReason: "tool-calls", usage, totalUsage: usage, steps: 1 };
      },
    };
  }

  it("records valid, invalid, unparseable and unknown-tool calls", async () => {
    const recorder = new CaseRecorder();
    const model = streamingModel([
      { toolName: "calculate_zones", input: JSON.stringify({ ftpWatts: 250 }) },
      { toolName: "calculate_zones", input: JSON.stringify({ ftpWatts: 720 }) },
      { toolName: "calculate_zones", input: "{not json" },
      { toolName: "intervals_fetch_streams", input: JSON.stringify({ activityId: "90401" }) },
    ]);
    await recordingDecorator(recorder, new SpendMeter(10))(sdkTransport(model)).generate({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      options: { caller: "chat", tools: { calculate_zones: zones }, onStreamActivity: () => undefined },
    });
    expect(recorder.attempts).toEqual([
      { tool: "calculate_zones", input: { ftpWatts: 250 }, valid: true, caller: "chat" },
      { tool: "calculate_zones", input: { ftpWatts: 720 }, valid: false, caller: "chat" },
      { tool: "intervals_fetch_streams", input: undefined, valid: false, caller: "chat" },
      { tool: UNPARSED_TOOL, input: undefined, valid: false, caller: "chat" },
    ]);
  });
});
