import { describe, expect, it } from "vitest";
import { asSchema } from "ai";
import { createCoachEngine, type ModelTransport } from "@enduragent/engine";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CASES } from "./cases.js";
import { evaluateTurn, type TurnObservation } from "./checks.js";
import { buildAthleteFixture, dateKey } from "./fixture.js";
import { CHAT_IDS, CaseRecorder, createEvalPorts, recordingDecorator, type Channel } from "./ports.js";
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

async function runScripted(
  channel: Channel,
  turns: readonly (readonly ScriptedCall[])[],
  meter = new SpendMeter(10),
): Promise<{ observations: TurnObservation[]; meter: SpendMeter; errors: string[] }> {
  const recorder = new CaseRecorder();
  const harness = createEvalPorts({
    model: "deepseek/deepseek-v4-flash",
    apiKey: "offline",
    fixture: buildAthleteFixture("connected", new Date()),
    recorder,
    meter,
  });
  const observations: TurnObservation[] = [];
  const errors: string[] = [];
  try {
    for (const calls of turns) {
      const engine = createCoachEngine({
        sport: cyclingSport,
        ports: {
          ...harness.ports,
          modelTransportDecorator: () => recordingDecorator(recorder, meter)(scriptedModel(calls, 0.01)),
        },
      });
      recorder.startTurn();
      try {
        const response = await engine.chat({ chatId: CHAT_IDS[channel], message: "Add the workout." });
        observations.push(recorder.finishTurn(response.text, harness.gate.peek(CHAT_IDS[channel]) !== undefined));
      } catch (error) {
        errors.push(error instanceof Error ? error.name : String(error));
      }
      await engine.settle?.();
    }
  } finally {
    harness.dispose();
  }
  return { observations, meter, errors };
}

describe("coach eval ports", () => {
  it("holds a Telegram calendar write as a pending proposal and executes nothing", async () => {
    const { observations } = await runScripted("telegram", [[createWorkout]]);
    const [turn] = observations;
    expect(turn.attempts).toEqual([{ tool: "intervals_create_workout", input: createWorkout.input, valid: true }]);
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
    expect(turn.attempts).toEqual([{ tool: "calculate_zones", input: { ftpWatts: 720 }, valid: false }]);
    expect(turn.offeredTools).toContain("intervals_fetch_activities");
  });

  it("refuses the next model call once the spend limit is reached", async () => {
    const meter = new SpendMeter(0.01);
    const { observations, errors } = await runScripted("desktop", [[], []], meter);
    expect(observations.length + errors.length).toBe(2);
    expect(meter.snapshot().spentUsd).toBeCloseTo(0.01);
    expect(meter.snapshot().refusedCalls).toBeGreaterThan(0);
  });
});
