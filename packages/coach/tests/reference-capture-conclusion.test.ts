import { describe, expect, it } from "vitest";
import { validateReferenceCaptureConclusion } from "../src/reference-capture-conclusion.js";

function environmentConclusion() {
  return {
    schema_version: 1,
    gate: "reference-capture-once",
    head_sha: "a".repeat(40),
    capture_manifest_sha256: null,
    capture_id_sha256: null,
    verdict: "ENVIRONMENT",
    fixture_bytes_equal: null,
    metric_maps_complete: null,
    metric_bytes_equal: null,
    registry_key_count: null,
    metric_exception_count: 0,
    fixture_mismatch_count: 0,
    metric_mismatch_count: 0,
    direct_metric_exception_keys: [],
    projected_metric_exception_keys: [],
    fixture_mismatch_families: [],
    metric_mismatch_keys: [],
    direct_family_counts: {},
    projected_family_counts: {},
    environment_code: "INTERNAL",
  };
}

describe("reference capture conclusion", () => {
  it("freezes and returns the conclusion object it was given", () => {
    const conclusion = environmentConclusion();
    const validated = validateReferenceCaptureConclusion(conclusion);
    expect(validated).toBe(conclusion);
    expect(Object.isFrozen(conclusion)).toBe(true);
    expect(validateReferenceCaptureConclusion(validated)).toBe(conclusion);
  });

  it("rejects a head commit that is not a string", () => {
    expect(() =>
      validateReferenceCaptureConclusion({
        ...environmentConclusion(),
        head_sha: ["a".repeat(40)],
      }),
    ).toThrow("invalid conclusion");
  });

  it("rejects a conclusion with a missing or extra key", () => {
    const missing: Record<string, unknown> = environmentConclusion();
    delete missing.environment_code;
    expect(() => validateReferenceCaptureConclusion(missing)).toThrow("invalid conclusion");
    expect(() =>
      validateReferenceCaptureConclusion({ ...environmentConclusion(), extra: true }),
    ).toThrow("invalid conclusion");
  });
});
