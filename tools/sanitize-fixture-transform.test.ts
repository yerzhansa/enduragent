// Behavioral tests for `tools/sanitize-fixture-transform.ts` — an allowlist
// privacy transform. Default-deny: every key not in the schema-derived
// allowlist (plus a small EXTRA_ALLOW list) is dropped. Allowed keys ride
// through verbatim; a few (id, paired_event_id, name, source) have value-level
// transforms. Numeric signal is preserved at full precision. Lives in tools/
// alongside the CLI per ADR-0013-companion (sanitizer-home decision).

import { describe, expect, it } from "vitest";

import {
  ALLOWED_FIXTURE_KEYS,
  sanitizeFixture,
  sanitizeFixtureWithSummary,
} from "./sanitize-fixture-transform.js";

describe("sanitizeFixture (allowlist)", () => {
  it("drops keys not in the schema-derived allowlist (default-deny)", () => {
    // `athlete_id` is not in any input schema — dropped entirely (not redacted).
    // `unknown_vendor_field` likewise. Compare with the old denylist behavior
    // which would have redacted athlete_id to 12345.
    expect(
      sanitizeFixture({
        athlete_id: "operator-uuid-xyz",
        unknown_vendor_field: "anything",
        activities: [{ id: 1, type: "Ride", power_meter_serial: "1607870937" }],
      }),
    ).toEqual({
      activities: [{ id: 12345, type: "Ride" }],
    });
  });

  it("redacts numeric and prefixed-string id values to 12345 (activity / planned event)", () => {
    expect(
      sanitizeFixture({
        activities: [{ id: 9876543, type: "Ride" }, { id: "i12345678", type: "Ride" }],
      }),
    ).toEqual({
      activities: [{ id: 12345, type: "Ride" }, { id: 12345, type: "Ride" }],
    });
  });

  it("shifts wellness-date `id`s to the synthetic epoch and rides zone-bin labels through", () => {
    expect(
      sanitizeFixture({
        wellness: [
          { id: "2026-04-15", weight: 73.4 },
          { id: "2026-04-16", weight: 73.5 },
        ],
        activities: [
          {
            id: 9876,
            average_watts: 200,
            icu_zone_times: [
              { id: "Z1", secs: 600 },
              { id: "Z2", secs: 1800 },
              // intervals.icu also emits named cross-zone bins like "SS".
              { id: "SS", secs: 780 },
            ],
          },
        ],
      }),
    ).toEqual({
      wellness: [
        // Date-shaped wellness ids shift back one full Gregorian cycle.
        { id: "1998-04-15", weight: 73.4 },
        { id: "1998-04-16", weight: 73.5 },
      ],
      activities: [
        {
          id: 12345,
          average_watts: 200,
          icu_zone_times: [
            // Zone-bin labels carry no calendar info — unchanged.
            { id: "Z1", secs: 600 },
            { id: "Z2", secs: 1800 },
            { id: "SS", secs: 780 },
          ],
        },
      ],
    });
  });

  it("shifts `start_date_local` and ftp_history `date` to the synthetic epoch", () => {
    expect(
      sanitizeFixture({
        activities: [{ id: 1, start_date_local: "2026-01-02T03:04:05", type: "Ride" }],
        ftp_history: [{ date: "2026-03-15", ftp: 280, source: "test" }],
      }),
    ).toEqual({
      activities: [{ id: 12345, start_date_local: "1998-01-02T03:04:05", type: "Ride" }],
      ftp_history: [{ date: "1998-03-15", ftp: 280, source: "test" }],
    });
  });

  it("redacts paired_event_id to 12345 (operator's planned-event linkage)", () => {
    expect(
      sanitizeFixture({
        activities: [
          { id: 1, type: "Ride", paired_event_id: 8899 },
          { id: 2, type: "Run", paired_event_id: null },
        ],
      }),
    ).toEqual({
      activities: [
        { id: 12345, type: "Ride", paired_event_id: 12345 },
        { id: 12345, type: "Run", paired_event_id: null },
      ],
    });
  });

  it("sanitizes `name` to the 'sanitized' sentinel (free-text PII via PlannedEventSchema field)", () => {
    expect(
      sanitizeFixture({
        activities: [
          { id: 1, type: "Ride", name: "Yerzhan's Friday ride near home" },
        ],
      }),
    ).toEqual({
      activities: [{ id: 12345, type: "Ride", name: "sanitized" }],
    });
  });

  it("sanitizes an activity `description` to the 'sanitized' sentinel and keeps null as null", () => {
    expect(
      sanitizeFixture({
        activities: [
          {
            id: 1,
            type: "Ride",
            start_date_local: "1998-03-14T08:00:00",
            description: "marker-1998 easy spin past the old school",
          },
          { id: 2, type: "Ride", start_date_local: "1998-03-15T08:00:00", description: null },
        ],
      }),
    ).toMatchObject({
      activities: [{ description: "sanitized" }, { description: null }],
    });
  });

  it("drops the hardware/source/route surfaces the prior denylist missed", () => {
    // Regression guard for the four leaks the QA review surfaced —
    // power_meter_serial (Favero hardware serial), power_meter (model),
    // source (vendor fingerprint), skyline_chart_bytes (route polyline).
    // None are in any schema, so default-deny drops them. Test inputs use
    // synthetic placeholders only — never the operator's real values.
    expect(
      sanitizeFixture({
        activities: [
          {
            id: 1,
            type: "Ride",
            power_meter_serial: "PLACEHOLDER-1234",
            power_meter: "PLACEHOLDER-BRAND",
            source: "GARMIN_CONNECT",
            skyline_chart_bytes: "CAcSPLACEHOLDER==",
            device_name: "Some Device",
            timezone: "America/Los_Angeles",
            athlete_max_hr: 190,
            lthr: 157,
          },
        ],
      }),
    ).toEqual({
      activities: [{ id: 12345, type: "Ride" }],
    });
  });

  it("drops GPS coordinate keys (start_latlng, end_latlng) — not in any schema", () => {
    expect(
      sanitizeFixture({
        activities: [
          {
            id: 1,
            type: "Ride",
            start_latlng: [37.7749, -122.4194],
            end_latlng: [37.7849, -122.4094],
            average_watts: 200,
          },
        ],
      }),
    ).toEqual({
      activities: [{ id: 12345, type: "Ride", average_watts: 200 }],
    });
  });

  it("drops TP-trademark-named keys (ctl/atl/tsb/tss/if/ctlLoad/atlLoad/rampRate/icu_ctl/icu_atl) — excluded from typed surface", () => {
    expect(
      sanitizeFixture({
        wellness: [
          {
            id: "2026-04-15",
            weight: 73.4,
            ctl: 52.1,
            atl: 38.4,
            ctlLoad: 51.9,
            atlLoad: 38.1,
            rampRate: 4.7,
            tsb: 13.7,
          },
        ],
        activities: [{ id: 1, type: "Ride", icu_ctl: 52.1, icu_atl: 38.4, tss: 142 }],
      }),
    ).toEqual({
      wellness: [{ id: "1998-04-15", weight: 73.4 }],
      activities: [{ id: 12345, type: "Ride" }],
    });
  });

  it("shifts ISO date strings to the synthetic epoch (no rounding, no jitter — preserves day-deltas)", () => {
    // start_date_local is a schema field; its date value is shifted back one
    // full Gregorian cycle so the committed fixture carries no real calendar.
    // The time-of-day tail rides through unchanged.
    expect(
      sanitizeFixture({
        activities: [{ id: 1, type: "Ride", start_date_local: "2026-04-15T07:30:00" }],
      }),
    ).toEqual({
      activities: [{ id: 12345, type: "Ride", start_date_local: "1998-04-15T07:30:00" }],
    });
  });

  it("preserves numeric metrics at full precision (no rounding)", () => {
    const input = {
      activities: [
        {
          id: 1,
          type: "Ride",
          icu_intensity: 0.823456,
          icu_training_load: 142.7,
          decoupling: 4.21,
          average_watts: 218.4,
        },
      ],
      wellness: [{ id: "2026-04-15", weight: 73.42, hrv: 84, bodyFat: 14.6 }],
    };
    expect(sanitizeFixture(input)).toEqual({
      activities: [
        {
          id: 12345,
          type: "Ride",
          icu_intensity: 0.823456,
          icu_training_load: 142.7,
          decoupling: 4.21,
          average_watts: 218.4,
        },
      ],
      wellness: [{ id: "1998-04-15", weight: 73.42, hrv: 84, bodyFat: 14.6 }],
    });
  });

  it("preserves the renamed fitness/fatigue fields (anti-corruption layer's emission target)", () => {
    expect(
      sanitizeFixture({
        wellness: [
          {
            id: "2026-04-15",
            fitness: 52.1,
            fatigue: 38.4,
            fitnessContribution: 51.9,
            fatigueContribution: 38.1,
            weeklyFitnessChange: 4.7,
          },
        ],
        activities: [
          { id: 1, type: "Ride", fitnessAtEnd: 52.1, fatigueAtEnd: 38.4 },
        ],
      }),
    ).toEqual({
      wellness: [
        {
          id: "1998-04-15",
          fitness: 52.1,
          fatigue: 38.4,
          fitnessContribution: 51.9,
          fatigueContribution: 38.1,
          weeklyFitnessChange: 4.7,
        },
      ],
      activities: [
        { id: 12345, type: "Ride", fitnessAtEnd: 52.1, fatigueAtEnd: 38.4 },
      ],
    });
  });

  it("preserves sportInfo[].eftp — load-bearing for tools/fetch-real-athlete.ts ftp_history derivation", () => {
    // sportInfo is not in any named schema but the deriver reads it.
    // Explicit EXTRA_ALLOW entry — keep this passing or update the comment.
    expect(
      sanitizeFixture({
        wellness: [
          {
            id: "2026-04-15",
            weight: 73.4,
            sportInfo: [{ type: "Ride", eftp: 285 }],
          },
        ],
      }),
    ).toEqual({
      wellness: [
        {
          id: "1998-04-15",
          weight: 73.4,
          sportInfo: [{ type: "Ride", eftp: 285 }],
        },
      ],
    });
  });

  it("returns empty object for empty input without crashing", () => {
    expect(sanitizeFixture({})).toEqual({});
  });

  it("preserves null and primitive top-level values without crashing", () => {
    expect(sanitizeFixture(null)).toBe(null);
    expect(sanitizeFixture(42)).toBe(42);
    expect(sanitizeFixture("plain string")).toBe("plain string");
    expect(sanitizeFixture([])).toEqual([]);
  });

  it("filters `source` to FtpHistoryPoint enum values; activity-row vendor values are dropped", () => {
    // FtpHistoryPointSchema allowlists `source` for "test"/"estimate". Real
    // intervals.icu activities carry an unrelated `source: "GARMIN_CONNECT"`
    // / "WAHOO" / etc. — operator-identifying. Value-level transform filters
    // non-enum values out so activity rows lose their head-unit fingerprint
    // while ftp_history rows keep theirs.
    expect(
      sanitizeFixture({
        ftp_history: [{ date: "2026-04-15", ftp: 285, source: "test" }],
        activities: [{ id: 1, type: "Ride", source: "GARMIN_CONNECT" }],
      }),
    ).toEqual({
      ftp_history: [{ date: "1998-04-15", ftp: 285, source: "test" }],
      activities: [{ id: 12345, type: "Ride" }],
    });
  });

  it("is deterministic — same input twice produces byte-identical output", () => {
    const dirty = {
      activities: [
        {
          id: 1,
          type: "Ride",
          name: "ride",
          start_latlng: [37, -122],
          icu_atl: 38,
          power_meter_serial: "PLACEHOLDER",
        },
      ],
    };
    const a = JSON.stringify(sanitizeFixture(dirty));
    const b = JSON.stringify(sanitizeFixture(dirty));
    expect(a).toBe(b);
  });
});

describe("ALLOWED_FIXTURE_KEYS", () => {
  it("is exported as a ReadonlySet (used by the load-fixture PII regression scanner)", () => {
    expect(ALLOWED_FIXTURE_KEYS).toBeInstanceOf(Set);
    expect(typeof ALLOWED_FIXTURE_KEYS.has).toBe("function");
  });

  it("includes envelope top-level keys (activities, wellness, ftp_history)", () => {
    expect(ALLOWED_FIXTURE_KEYS.has("activities")).toBe(true);
    expect(ALLOWED_FIXTURE_KEYS.has("wellness")).toBe(true);
    expect(ALLOWED_FIXTURE_KEYS.has("ftp_history")).toBe(true);
  });

  it("includes the renamed fitness/fatigue fields (ADR-0012 anti-corruption layer emissions)", () => {
    for (const k of [
      "fitness",
      "fatigue",
      "fitnessContribution",
      "fatigueContribution",
      "weeklyFitnessChange",
      "fitnessAtEnd",
      "fatigueAtEnd",
    ]) {
      expect(ALLOWED_FIXTURE_KEYS.has(k)).toBe(true);
    }
  });

  it("excludes TP-trademarked source field names (rename layer strips them before sanitize sees them)", () => {
    for (const banned of ["ctl", "atl", "tsb", "tss", "if", "ctlLoad", "atlLoad", "rampRate", "icu_ctl", "icu_atl"]) {
      expect(ALLOWED_FIXTURE_KEYS.has(banned)).toBe(false);
    }
  });

  it("excludes the operator-identifying hardware fields the prior denylist missed", () => {
    // Regression guard — explicitly assert these don't leak back into the
    // allowlist via a schema change without justification. Note: `source`
    // is intentionally allowlisted because FtpHistoryPointSchema names it
    // (z.enum(["test","estimate"])). The value-level transform in
    // sanitize-fixture.ts filters non-enum `source` values (e.g.
    // "GARMIN_CONNECT" on an activity row) — verified by the sanitizeFixture
    // tests above.
    for (const banned of [
      "power_meter_serial",
      "power_meter",
      "skyline_chart_bytes",
      "device_name",
      "athlete_id",
      "athlete_max_hr",
      "lthr",
      "icu_athlete_id",
      "strava_id",
      "external_id",
      "route_id",
      "oauth_client_id",
      "oauth_client_name",
      "group",
      "timezone",
    ]) {
      expect(ALLOWED_FIXTURE_KEYS.has(banned)).toBe(false);
    }
  });
});

describe("sanitizeFixtureWithSummary", () => {
  it("returns the sanitized data plus counts of dropped + transformed keys", () => {
    const dirty = {
      athlete_id: "operator-uuid",
      activities: [
        {
          id: 1,
          type: "Ride",
          ctl: 52,
          start_latlng: [37, -122],
          name: "morning ride",
          power_meter_serial: "PLACEHOLDER",
        },
        {
          id: 2,
          type: "Ride",
          atl: 37,
          end_latlng: [38, -123],
          name: "evening ride",
        },
      ],
    };

    const { data, summary } = sanitizeFixtureWithSummary(dirty);

    expect(data).toEqual(sanitizeFixture(dirty));

    // Dropped: athlete_id (×1 top), ctl (×1), start_latlng (×1),
    // power_meter_serial (×1), atl (×1), end_latlng (×1).
    expect(summary.droppedKeys.athlete_id).toBe(1);
    expect(summary.droppedKeys.ctl).toBe(1);
    expect(summary.droppedKeys.atl).toBe(1);
    expect(summary.droppedKeys.start_latlng).toBe(1);
    expect(summary.droppedKeys.end_latlng).toBe(1);
    expect(summary.droppedKeys.power_meter_serial).toBe(1);
    // Transformed: id ×2, name ×2.
    expect(summary.transformedKeys.id).toBe(2);
    expect(summary.transformedKeys.name).toBe(2);
  });
});
