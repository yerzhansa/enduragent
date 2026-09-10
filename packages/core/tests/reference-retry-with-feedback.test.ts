import { describe, it, expect } from "vitest";
import { validateAndRetry } from "../src/reference/validation/retry-with-feedback.js";
import type { LatestJson } from "../src/reference/schemas/latest.js";
import { createFakeLLM } from "../../engine/tests/helpers/fake-llm.js";

function makeSnapshot(currentStatus: unknown): LatestJson {
  return {
    metadata: {
      schema_version: "1",
      last_updated: "1998-06-08T00:00:00.000Z",
      freshness: "fresh",
    },
    athlete_profile: {},
    current_status: currentStatus,
    derived_metrics: {},
    recent_activities: [],
    planned_workouts: [],
    wellness_data: {},
  } as LatestJson;
}

function makeMetadata(value: unknown) {
  return {
    citations: [{ field: "current_status.acwr.value", value, source: "latest.json" as const }],
    confidence: "high" as const,
    frameworks: ["fitness-fatigue"],
    phase_tag: "base",
  };
}

/** Wraps a coaching reply + its metadata into the ---meta--- wire format. */
function withMeta(prose: string, value: unknown): string {
  return `${prose}\n---meta---\n${JSON.stringify(makeMetadata(value))}`;
}

const SNAPSHOT = makeSnapshot({ acwr: { value: 1.42 } });

describe("validateAndRetry — enforce mode", () => {
  it("does not call the LLM when the first attempt validates", async () => {
    const llm = createFakeLLM([]);
    const result = await validateAndRetry(llm, "how am I doing?", "reply", makeMetadata(1.42), {
      mode: "enforce",
      snapshot: SNAPSHOT,
    });
    expect(llm.capturedPrompts.length).toBe(0);
    expect(result.validation_warning).toBeUndefined();
    expect(result.response).toBe("reply");
    expect(result.metadata?.citations[0]?.value).toBe(1.42);
  });

  it("retries exactly once with feedback and succeeds on the corrected reply", async () => {
    const corrected = withMeta("corrected coaching", 1.42);
    const llm = createFakeLLM([corrected]);
    const result = await validateAndRetry(
      llm,
      "how am I doing?",
      "first reply",
      makeMetadata(1.45),
      { mode: "enforce", snapshot: SNAPSHOT },
    );
    expect(llm.capturedPrompts.length).toBe(1);
    expect(llm.capturedPrompts[0]).toContain(
      "Citation mismatch: cited current_status.acwr.value=1.45, snapshot has 1.42.",
    );
    expect(llm.capturedPrompts[0]).toContain("Same coaching content, corrected numbers.");
    expect(result.response).toBe(corrected);
    expect(result.validation_warning).toBeUndefined();
  });

  it("returns the second response with validation_warning on a double failure", async () => {
    const stillWrong = withMeta("still wrong", 1.99);
    const llm = createFakeLLM([stillWrong]);
    const result = await validateAndRetry(
      llm,
      "how am I doing?",
      "first reply",
      makeMetadata(1.45),
      { mode: "enforce", snapshot: SNAPSHOT },
    );
    expect(llm.capturedPrompts.length).toBe(1);
    expect(result.response).toBe(stillWrong);
    expect(result.validation_warning).toBe(true);
  });

  it("never makes a third call even when the retry is also wrong", async () => {
    const stillWrong = withMeta("still wrong", 1.99);
    const llm = createFakeLLM([stillWrong, withMeta("third", 1.42)]);
    await validateAndRetry(llm, "how am I doing?", "first reply", makeMetadata(1.45), {
      mode: "enforce",
      snapshot: SNAPSHOT,
    });
    expect(llm.capturedPrompts.length).toBe(1);
  });
});
describe("validateAndRetry — observe mode", () => {
  it("flags would_have_retried on a mismatch without calling the LLM", async () => {
    const llm = createFakeLLM([]);
    const result = await validateAndRetry(llm, "how am I doing?", "reply", makeMetadata(1.45), {
      mode: "observe",
      snapshot: SNAPSHOT,
    });
    expect(llm.capturedPrompts.length).toBe(0);
    expect(result.would_have_retried).toBe(true);
    expect(result.validation_warning).toBeUndefined();
    expect(result.response).toBe("reply");
  });

  it("does not flag would_have_retried on a match", async () => {
    const llm = createFakeLLM([]);
    const result = await validateAndRetry(llm, "how am I doing?", "reply", makeMetadata(1.42), {
      mode: "observe",
      snapshot: SNAPSHOT,
    });
    expect(llm.capturedPrompts.length).toBe(0);
    expect(result.would_have_retried).toBe(false);
  });
});

describe("validateAndRetry — off mode", () => {
  it("returns the original response untouched with no validation or retry", async () => {
    const llm = createFakeLLM([]);
    const result = await validateAndRetry(llm, "how am I doing?", "reply", makeMetadata(1.45), {
      mode: "off",
      snapshot: SNAPSHOT,
    });
    expect(llm.capturedPrompts.length).toBe(0);
    expect(result.response).toBe("reply");
    expect(result.validation_warning).toBeUndefined();
    expect(result.would_have_retried).toBeUndefined();
    expect(result.metadata?.citations[0]?.value).toBe(1.45);
  });
});
