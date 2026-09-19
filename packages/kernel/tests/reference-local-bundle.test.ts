import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/archive/canonical.js";
import {
  applyActivityProjectionFilter,
  assertNoTpKeysRemain,
  assertProjectionEvidenceEqual,
  buildMetricInput,
  buildFixtureShape,
  compareCanonicalUtf8,
  KEEP_ALL_ACTIVITIES,
  normalizeStreams,
  parseActivityLandingEnvelope,
  parseCanonicalProjectionValue,
  parseGenericLandingEnvelope,
  renameTpFieldsOnActivity,
  StreamNormalizationError,
} from "../src/reference/entry/local-bundle.js";
import type { ActivityProjectionFilter, ReferenceBundle } from "../src/reference/local-bundle.js";
import { METRIC_REGISTRY } from "../src/reference/metrics/registry.js";

const activities = [
  {
    id: "b",
    start_date_local: "1998-06-05T08:00:00",
    type: "Ride",
    moving_time: 1,
    elapsed_time: 1,
    icu_training_load: 10,
  },
  {
    id: "a",
    start_date_local: "1998-06-04T08:00:00",
    type: "Run",
    moving_time: 1,
    elapsed_time: 1,
    icu_training_load: 10,
  },
] as const;
const wellness = [
  {
    id: "1998-06-04",
    weight: null,
    restingHR: null,
    hrv: null,
    sleepSecs: null,
    sleepQuality: null,
  },
];

function bundle(streams?: ReferenceBundle["streams"]): ReferenceBundle {
  return {
    activities,
    wellness,
    ftpHistory: [],
    ...(streams === undefined ? {} : { streams }),
    athlete: { sportSettings: [] },
  };
}

describe("kernel local bundle contracts", () => {
  it("filters once in order, preserves references, and retains explicit empty streams", () => {
    const keep = vi.fn<ActivityProjectionFilter>((activity) => activity.id === "a");
    const original = bundle({ b: { watts: [1] }, a: { watts: [2] } });
    const filtered = applyActivityProjectionFilter(original, keep);
    expect(keep.mock.calls.map(([activity]) => activity.id)).toEqual(["b", "a"]);
    expect(filtered.activities.map((activity) => activity.id)).toEqual(["a"]);
    expect(filtered.streams).toEqual({ a: original.streams!.a });
    expect(filtered.wellness).toBe(original.wellness);
    expect(filtered.ftpHistory).toBe(original.ftpHistory);
    expect(filtered.athlete).toBe(original.athlete);
    expect(applyActivityProjectionFilter(bundle({}), KEEP_ALL_ACTIVITIES)).toHaveProperty(
      "streams",
      {},
    );
    expect(applyActivityProjectionFilter(bundle(), KEEP_ALL_ACTIVITIES)).not.toHaveProperty(
      "streams",
    );
  });

  it("rejects orphan streams before returning a filtered bundle", () => {
    expect(() =>
      applyActivityProjectionFilter(bundle({ missing: { watts: [] } }), KEEP_ALL_ACTIVITIES),
    ).toThrowError(new TypeError("local bundle contains an orphan stream"));
  });

  it("normalizes only top-level stream keys and fails closed on collisions", () => {
    const nested = { keepCamel: 1 };
    expect(normalizeStreams({ dfaA1: [1], nestedValue: nested })).toEqual({
      dfa_a1: [1],
      nested_value: nested,
    });
    expect(
      normalizeStreams([
        { type: "dfa_a1", data: [1, null] },
        { type: 3, data: [] },
      ]),
    ).toEqual({ dfa_a1: [1, null] });
    expect(() => normalizeStreams({ dfaA1: [1], dfa_a1: [1] })).toThrowError(
      new TypeError("stream key normalization collision"),
    );
    const shared = [1];
    expect(normalizeStreams({ dfaA1: shared, dfa_a1: shared })).toEqual({ dfa_a1: shared });
  });

  it("fails closed with structured diagnostics instead of overwriting duplicate descriptors", () => {
    let thrown: unknown;
    try {
      normalizeStreams([
        { type: "watts", data: [180, 190] },
        { type: "watts", data: [250, 260] },
        { type: "dfaA1", data: [0.9, 0.8] },
        { type: "dfa_a1", data: [0.7, 0.6] },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StreamNormalizationError);
    expect((thrown as StreamNormalizationError).issues).toEqual([
      { kind: "DuplicateType", type: "watts", count: 2 },
      { kind: "DuplicateType", type: "dfa_a1", count: 2 },
    ]);
    expect(Object.keys(thrown as StreamNormalizationError)).not.toContain("issues");
  });

  it("uses canonical UTF-8 byte ordering including non-ASCII and prefixes", () => {
    const javascriptCodeUnitLeft = "𐀀";
    const javascriptCodeUnitRight = "\uE000";
    expect(compareCanonicalUtf8(javascriptCodeUnitLeft, javascriptCodeUnitRight)).toBeGreaterThan(
      0,
    );
    expect(javascriptCodeUnitLeft < javascriptCodeUnitRight).toBe(true);
    expect(compareCanonicalUtf8("a", "aa")).toBeLessThan(0);
    expect(compareCanonicalUtf8({ a: 1 }, { a: 1 })).toBe(0);
  });

  it("parses strict canonical envelopes and compares the exact operands", () => {
    const activity = { id: "a" };
    const activityJson = canonicalJson({ activity, concerns: {}, dedup: {}, schema_version: 1 });
    expect(parseActivityLandingEnvelope(activityJson).activity).toEqual(activity);
    expect(() => parseActivityLandingEnvelope(`${activityJson}\n`)).toThrow(TypeError);
    expect(() =>
      parseActivityLandingEnvelope(
        canonicalJson({ activity, concerns: {}, dedup: {}, extra: 1, schema_version: 1 }),
      ),
    ).toThrow(TypeError);

    for (const endpoint of ["streams", "settings"] as const) {
      const landing = { value: 1 };
      const envelope = canonicalJson({ endpoint, landing, schema_version: 1 });
      expect(parseGenericLandingEnvelope(envelope, endpoint).landing).toEqual(landing);
      expect(() =>
        parseGenericLandingEnvelope(envelope, endpoint === "streams" ? "settings" : "streams"),
      ).toThrow(TypeError);
    }
    expect(parseCanonicalProjectionValue(canonicalJson(activity), "activity")).toEqual(activity);
    expect(() =>
      assertProjectionEvidenceEqual({ value: 1 }, { value: 2 }, "activity"),
    ).toThrowError(new TypeError("activity source evidence mismatch"));
  });

  it("keeps collision-safe rename behavior and omits unsupported fixture extensions", () => {
    expect(() => renameTpFieldsOnActivity({ id: "a", icu_ctl: 1, fitnessAtEnd: 2 })).toThrow(
      /collision/,
    );
    expect(() => assertNoTpKeysRemain({ nested: { ctl: 1 } })).toThrow(/nested\.ctl/);
    const fixture = buildFixtureShape(bundle({}));
    expect(fixture).not.toHaveProperty("power_curves");
    expect(fixture).not.toHaveProperty("hr_curves");
    expect(fixture).not.toHaveProperty("sustainability_curves");
    expect(fixture).not.toHaveProperty("past_events");
    expect(fixture).not.toHaveProperty("intervals");
  });

  it("carries validated trailing plan events into metric fixture input", () => {
    const pastEvents = [
      {
        id: 10,
        category: "WORKOUT",
        start_date_local: "1998-06-04T08:00:00",
        name: null,
        type: "Ride",
      },
    ];
    const fixture = buildFixtureShape({ ...bundle(), pastEvents });
    expect(fixture.past_events).toEqual(pastEvents);
    expect(fixture.activities).toEqual(activities);
    expect(fixture.wellness).toEqual(wellness);
  });

  it("preserves equal-Load encounter order for both primary-sport results", () => {
    const forward = buildMetricInput(bundle(), "1998-06-10T12:00:00");
    const reverse = buildMetricInput(
      { ...bundle(), activities: [...activities].reverse() },
      "1998-06-10T12:00:00",
    );
    for (const metric of ["seiler_tid_7d_primary", "seiler_tid_28d_primary"] as const) {
      const first = METRIC_REGISTRY[metric]!.compute(forward) as { sport: string };
      const second = METRIC_REGISTRY[metric]!.compute(reverse) as { sport: string };
      expect(first.sport).not.toBe(second.sport);
    }
  });
});
