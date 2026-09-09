import { describe, it, expect, vi } from "vitest";
import {
  validateRecommendation,
  parseMetaBlock,
  getByPath,
  type ResponseHash,
} from "../src/reference/validation/validate-response.js";
import type { LatestJson } from "../src/reference/schemas/latest.js";

const testHash: ResponseHash = () => "0123456789abcdef";

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

function makeMetadata(citations: Array<{ field: string; value: unknown }>) {
  return {
    citations: citations.map((c) => ({ ...c, source: "latest.json" as const })),
    confidence: "high" as const,
    frameworks: ["fitness-fatigue"],
    phase_tag: "base",
  };
}

describe("validateRecommendation", () => {
  it("returns ok for an exactly-matching numeric citation", () => {
    const snapshot = makeSnapshot({ acwr: { value: 1.42 } });
    const meta = makeMetadata([{ field: "current_status.acwr.value", value: 1.42 }]);
    expect(validateRecommendation("reply", meta, snapshot)).toEqual({ ok: true, failures: [] });
  });

  it("returns ok for a citation within the ±0.01 tolerance", () => {
    const snapshot = makeSnapshot({ acwr: { value: 1.42 } });
    const meta = makeMetadata([{ field: "current_status.acwr.value", value: 1.425 }]);
    expect(validateRecommendation("reply", meta, snapshot)).toEqual({ ok: true, failures: [] });
  });

  it("returns the exact mismatch detail when off by more than tolerance", () => {
    const snapshot = makeSnapshot({ acwr: { value: 1.42 } });
    const meta = makeMetadata([{ field: "current_status.acwr.value", value: 1.45 }]);
    const result = validateRecommendation("reply", meta, snapshot);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].check).toBe("citation_value");
    expect(result.failures[0].detail).toBe(
      "Citation mismatch: cited current_status.acwr.value=1.45, snapshot has 1.42.",
    );
  });

  it("returns a missing-source failure naming the absent field", () => {
    const snapshot = makeSnapshot({ acwr: { value: 1.42 } });
    const meta = makeMetadata([{ field: "current_status.monotony.value", value: 1.1 }]);
    const result = validateRecommendation("reply", meta, snapshot);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].check).toBe("citation_source");
    expect(result.failures[0].detail).toContain("current_status.monotony.value");
    expect(result.failures[0].detail).toContain("not found in snapshot");
  });

  it("returns a strict mismatch for a string/enum citation", () => {
    const snapshot = makeSnapshot({ phase: "base" });
    const meta = makeMetadata([{ field: "current_status.phase", value: "build" }]);
    const result = validateRecommendation("reply", meta, snapshot);
    expect(result.ok).toBe(false);
    expect(result.failures[0].check).toBe("citation_value");
    expect(result.failures[0].detail).toContain("current_status.phase");
  });

  it("returns ok for a matching string/enum citation", () => {
    const snapshot = makeSnapshot({ phase: "base" });
    const meta = makeMetadata([{ field: "current_status.phase", value: "base" }]);
    expect(validateRecommendation("reply", meta, snapshot)).toEqual({ ok: true, failures: [] });
  });

  it("does not let a snapshot false/null/empty-string satisfy a cited 0", () => {
    for (const snapshotValue of [false, null, ""]) {
      const snapshot = makeSnapshot({ rest_flag: snapshotValue });
      const meta = makeMetadata([{ field: "current_status.rest_flag", value: 0 }]);
      const result = validateRecommendation("reply", meta, snapshot);
      expect(result.ok).toBe(false);
      expect(result.failures[0].detail).toContain("current_status.rest_flag");
    }
  });

  it("does not let a cited false/empty-string satisfy a snapshot 0", () => {
    for (const citedValue of [false, ""]) {
      const snapshot = makeSnapshot({ load: 0 });
      const meta = makeMetadata([{ field: "current_status.load", value: citedValue }]);
      const result = validateRecommendation("reply", meta, snapshot);
      expect(result.ok).toBe(false);
      expect(result.failures[0].detail).toContain("current_status.load");
    }
  });

  it("fails when metadata violates RecommendationMetadataSchema", () => {
    const snapshot = makeSnapshot({ acwr: { value: 1.42 } });
    const badMeta = {
      citations: [{ field: "current_status.acwr.value", value: 1.42, source: "history.json" }],
      confidence: "high",
      frameworks: ["fitness-fatigue"],
      phase_tag: "base",
    };
    const result = validateRecommendation("reply", badMeta, snapshot);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].check).toBe("metadata_schema");
    expect(result.failures[0].detail).toContain("Metadata failed schema validation");
  });

  it("collects ALL citation failures, not just the first", () => {
    const snapshot = makeSnapshot({ acwr: { value: 1.42 } });
    const meta = makeMetadata([
      // First citation: a missing source.
      { field: "current_status.monotony.value", value: 1.1 },
      // Second citation: a value mismatch on a present field.
      { field: "current_status.acwr.value", value: 1.99 },
    ]);
    const result = validateRecommendation("reply", meta, snapshot);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((f) => f.check)).toEqual(["citation_source", "citation_value"]);
  });
});

describe("parseMetaBlock", () => {
  it("returns the single block when exactly one is present", () => {
    const meta = { citations: [], confidence: "high" };
    const response = `Some coaching prose.\n---meta---\n${JSON.stringify(meta)}`;
    const parsed = parseMetaBlock(response, testHash);
    expect(parsed).not.toBeNull();
    expect(parsed?.blockCount).toBe(1);
    expect(parsed?.metadataJson).toEqual(meta);
  });

  it("returns the LAST block and warns when multiple blocks are present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = { which: "first" };
    const last = { which: "last" };
    const response = `prose\n---meta---\n${JSON.stringify(first)}\n---meta---\n${JSON.stringify(last)}`;
    const parsed = parseMetaBlock(response, testHash);
    expect(parsed?.metadataJson).toEqual(last);
    expect(parsed?.blockCount).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("0123456789abcdef"));
    warn.mockRestore();
  });

  it("returns null when there is no meta block", () => {
    expect(parseMetaBlock("just prose, no delimiter", testHash)).toBeNull();
  });

  it("returns null when the block is malformed JSON", () => {
    const response = "prose\n---meta---\n{ not: valid json ]";
    expect(parseMetaBlock(response, testHash)).toBeNull();
  });
});

describe("getByPath", () => {
  it("resolves a deep hit", () => {
    const obj = { a: { b: { c: 42 } } };
    expect(getByPath(obj, "a.b.c")).toBe(42);
  });

  it("returns undefined on a null/undefined hop", () => {
    const obj = { a: null };
    expect(getByPath(obj, "a.b.c")).toBeUndefined();
  });

  it("returns undefined on a missing key", () => {
    const obj = { a: { b: {} } };
    expect(getByPath(obj, "a.b.c")).toBeUndefined();
  });
});
