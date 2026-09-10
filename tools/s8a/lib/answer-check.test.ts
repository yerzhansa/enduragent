import { describe, expect, it, vi } from "vitest";
import type { LanguageModelPort, GenerateResult } from "@enduragent/engine/sport";
import type { ModelTransport } from "@enduragent/engine";
import { createIntentTranslator } from "../../../packages/engine/src/intent-translation.js";
import { runAnswerCheck, validateAnswerChecks } from "./answer-check.js";
import { patchForRecord, patchForReplay } from "./patch-llm.js";
import { validateRecording } from "./record-validate.js";
import type { AnswerCheckObservation, S8aRecording } from "./types.js";
import { scenario } from "../scenarios/answer-check-creation.js";

const modelResult = (text: string): GenerateResult => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  usage: {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
  },
  totalUsage: {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
  },
  steps: 1,
});

const translatorFor = (transport: ModelTransport) =>
  createIntentTranslator({
    generate: (options) =>
      transport.generate({ provider: "openai-codex", model: "test-model", options }),
  } as LanguageModelPort);

const cases = scenario.execution!.cases;

describe("maintained answer-check scenarios", () => {
  it("records and replays the production host checks, confirmations, and one repair without a live provider", async () => {
    const recorder = patchForRecord();
    const observed: AnswerCheckObservation[] = [];
    for (const test of cases) {
      let attempt = 0;
      const next = recorder.modelTransportDecorator({
        generate: async () => {
          attempt += 1;
          return modelResult(
            test.id === "clear-duration" && attempt === 1
              ? "invalid"
              : JSON.stringify({
                  outcome: test.expected.outcome,
                  title: "Check your answer",
                  body: "Please confirm or clarify your training answer.",
                  value: test.expected.value,
                }),
          );
        },
      });
      recorder.setCurrentCheck(test.id);
      observed.push(await runAnswerCheck(test, translatorFor(next)));
    }
    expect(validateAnswerChecks(cases, recorder.calls, observed)).toEqual([]);
    expect(
      validateRecording({
        scenario,
        calls: recorder.calls,
        replies: [],
        artifacts: {},
        deletedEventIds: [],
        answerChecks: observed,
      }),
    ).toEqual([]);
    expect(
      validateRecording({
        scenario,
        calls: recorder.calls,
        replies: [],
        artifacts: {},
        deletedEventIds: [],
      }),
    ).toContain("answer-check observation count differs from scenario cases");
    expect(recorder.calls).toHaveLength(6);
    expect(recorder.calls.at(-1)?.request).toMatchObject({
      shape: "intent-translation",
      input: { shape: "messages" },
    });
    const recording: S8aRecording = {
      s8aRecordingVersion: 1,
      scenario: scenario.id,
      recordedAt: "1998-09-02T12:00:00.000Z",
      provider: "openai-codex",
      model: "test-model",
      lineage: { templateHash: "", lineageVersion: "unversioned" },
      calls: recorder.calls,
      answerChecks: observed,
    };
    const replay = patchForReplay(recording, scenario.id);
    const provider = vi.fn();
    const translator = translatorFor(replay.modelTransportDecorator({ generate: provider }));
    const replayed: AnswerCheckObservation[] = [];
    for (const test of cases) {
      replay.setCurrentCheck(test.id);
      replayed.push(await runAnswerCheck(test, translator));
    }
    replay.finalize();
    expect(provider).not.toHaveBeenCalled();
    expect(replay.state.failures).toEqual([]);
    expect(validateAnswerChecks(cases, recording.calls, replayed, observed)).toEqual([]);
    expect(
      validateAnswerChecks(
        cases,
        recording.calls,
        [{ ...replayed[0], elapsedMs: 30_001 }, ...replayed.slice(1)],
        observed,
      ),
    ).toContain("vague-time-off: answer check exceeded 30 seconds");
    expect(
      validateAnswerChecks(
        cases,
        [...recording.calls, recording.calls[0], recording.calls[0]],
        replayed,
      ),
    ).toContain("vague-time-off: expected one model call and at most one repair");
    const wrong = [
      {
        ...replayed[0],
        result: {
          outcome: "understood",
          title: "Guessed dates",
          body: "You are away next month.",
          value: [],
        },
      },
      ...replayed.slice(1),
    ];
    expect(validateAnswerChecks(cases, recording.calls, wrong, observed)).toContain(
      "vague-time-off: outcome or cleaned value differs from expectation",
    );
  });

  it("detects schema and attribution drift in the exact production request", async () => {
    const record = patchForRecord();
    record.setCurrentCheck("case");
    const transport = record.modelTransportDecorator({ generate: async () => modelResult("{}") });
    const options = {
      caller: "intent-translation" as const,
      system: "schema",
      prompt: "request",
      maxSteps: 1,
      maxOutputTokens: 2048,
      deadlineMs: 30_000,
    };
    await transport.generate({ provider: "openai-codex", model: "test-model", options });
    const recording: S8aRecording = {
      s8aRecordingVersion: 1,
      scenario: "case",
      recordedAt: "1998-09-02T12:00:00Z",
      provider: "openai-codex",
      model: "test-model",
      lineage: { templateHash: "", lineageVersion: "unversioned" },
      calls: record.calls,
    };
    const replay = patchForReplay(recording, "case");
    replay.setCurrentCheck("wrong-case");
    await replay.modelTransportDecorator({ generate: vi.fn() }).generate({
      provider: "openai-codex",
      model: "test-model",
      options: { ...options, system: "changed schema" },
    });
    expect(replay.state.failures.map((failure) => failure.detail)).toEqual([
      "ordinal 0: answer-check attribution mismatch",
      "ordinal 0: answer-check request differs from recording",
    ]);
  });
});
