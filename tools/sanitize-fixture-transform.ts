// Allowlist-based privacy transform for fixture JSON. Default-deny: every
// key not in the schema-derived allowlist (plus a small EXTRA_ALLOW list of
// structural extras) is dropped. Allowed keys ride through verbatim; a few
// have value-level transforms (id structural-pattern preserve, paired_event_id
// redact, name sanitize). Numeric signal is preserved at full precision —
// the realistic distribution of weights/HR/power/load is load-bearing test
// signal. ISO date strings are shifted back one full Gregorian cycle (the
// synthetic epoch) so the committed fixture never publishes the real athlete's
// training calendar; the whole-cycle shift preserves every date-to-date day
// delta exactly, so the temporal training structure downstream metrics consume
// is bit-identical in shape AND value (see tools/shift-to-synthetic-epoch.ts).
//
// Why allowlist instead of denylist: the prior denylist defaulted to
// "include" and missed several operator-identifying fields the schemas
// don't name (power_meter_serial, source, skyline_chart_bytes, etc.). The
// allowlist inverts the bias — the next intervals.icu field that ships,
// or the next field a future operator's account has that today's doesn't,
// is default-dropped rather than default-leaked.

import {
  ActivitySchema,
  FtpHistoryPointSchema,
  IcuIntervalRepSchema,
  PlannedEventSchema,
  WeeklyRollupSchema,
  WellnessDaySchema,
  ZoneTimesSchema,
} from "@enduragent/kernel/reference/schemas";
import { shiftIsoToSyntheticEpoch } from "./shift-to-synthetic-epoch.js";

// Mechanically derived from the project's input schemas. Adding a field to
// a schema auto-allows it in the sanitizer — keeps the privacy boundary
// aligned with what metrics consume by name.
const SCHEMA_DERIVED_ALLOW: ReadonlySet<string> = new Set([
  ...Object.keys(ActivitySchema.shape),
  ...Object.keys(WellnessDaySchema.shape),
  ...Object.keys(FtpHistoryPointSchema.shape),
  ...Object.keys(IcuIntervalRepSchema.shape),
  ...Object.keys(WeeklyRollupSchema.shape),
  ...Object.keys(PlannedEventSchema.shape),
  ...Object.keys(ZoneTimesSchema.shape),
]);

// Load-bearing structural keys the schemas don't enumerate. Each entry has
// a one-line justification — review-checklist for future additions.
const EXTRA_ALLOW: ReadonlySet<string> = new Set([
  // Top-level envelope arrays in GoldenFixtureSchema.
  "activities",
  "wellness",
  "ftp_history",
  // ZoneTimeEntrySchema is a union (number | {id, secs}); .shape doesn't
  // enumerate union members. `id` is already in SCHEMA_DERIVED_ALLOW via
  // Activity/Wellness; name `secs` here.
  "secs",
  // tools/fetch-real-athlete.ts derives ftp_history from sportInfo[].eftp
  // (cycling sport types). Not in named schemas but load-bearing for the
  // deriver pipeline. `type` is in ActivitySchema; just name the others.
  "sportInfo",
  "eftp",
]);

/** Union of every key permitted to appear anywhere in a sanitized fixture.
 *  Exported so the load-fixture PII regression scanner can assert the
 *  committed fixture carries nothing outside this set. */
export const ALLOWED_FIXTURE_KEYS: ReadonlySet<string> = new Set([
  ...SCHEMA_DERIVED_ALLOW,
  ...EXTRA_ALLOW,
]);

// `id` requires context-aware redaction. Two structural patterns are NOT
// redacted to the numeric sentinel because they're load-bearing test signal,
// not account-linking PII:
//   - YYYY-MM-DD wellness date — kept as a date, but date-shifted to the
//     synthetic epoch (the date itself is the athlete's training calendar).
//   - Short uppercase-prefixed label (zone bins like "Z1"/"Z10"/"SS"/"WORK") —
//     rides through unchanged (carries no calendar or account information).
// Everything else under the `id` key gets redacted to ID_NUMERIC_MOCK.
const WELLNESS_DATE_ID_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_LABEL_RE = /^[A-Z][A-Za-z0-9]{0,3}$/;
const ID_NUMERIC_MOCK = 12345;

type Transform = (value: unknown) => unknown;

// `source` is in FtpHistoryPointSchema (z.enum(["test", "estimate"])) but
// real intervals.icu activities carry an unrelated `source` field naming
// the head-unit vendor ("GARMIN_CONNECT", "WAHOO") — operator-identifying.
// Filter to the legitimate enum values; everything else drops.
const FTP_HISTORY_SOURCE_VALUES: ReadonlySet<unknown> = new Set(["test", "estimate"]);

const TRANSFORMS: ReadonlyMap<string, Transform> = new Map<string, Transform>([
  [
    "id",
    (v) => {
      if (v === null || v === undefined) return v;
      if (typeof v === "string") {
        // Wellness-date id: keep the date shape but shift it to the synthetic
        // epoch so the committed fixture doesn't carry the real calendar.
        if (WELLNESS_DATE_ID_RE.test(v)) return shiftIsoToSyntheticEpoch(v);
        // Zone-bin label: carries no calendar/account info — ride through.
        if (ZONE_LABEL_RE.test(v)) return v;
      }
      return ID_NUMERIC_MOCK;
    },
  ],
  [
    "start_date_local",
    (v) => (typeof v === "string" ? shiftIsoToSyntheticEpoch(v) : v),
  ],
  // FtpHistoryPointSchema.date — the only other ISO-date-valued schema field.
  [
    "date",
    (v) => (typeof v === "string" ? shiftIsoToSyntheticEpoch(v) : v),
  ],
  [
    "paired_event_id",
    (v) => (v === null || v === undefined ? v : ID_NUMERIC_MOCK),
  ],
  [
    "name",
    (v) => (v === null || v === undefined ? v : "sanitized"),
  ],
  [
    "description",
    (v) => (v === null || v === undefined ? v : "sanitized"),
  ],
  [
    "source",
    (v) => {
      if (v === null || v === undefined) return v;
      if (FTP_HISTORY_SOURCE_VALUES.has(v)) return v;
      // Not a legitimate FtpHistoryPoint source — likely an activity-level
      // vendor fingerprint. Drop the value (return undefined so the walker
      // omits the key entirely, the way default-deny treats unknown keys).
      return undefined;
    },
  ],
]);

export interface SanitizeOptions {
  /** Reserved for deterministic per-row id rewriting (unused today). */
  seed?: string;
}

export interface SanitizeSummary {
  /** Keys dropped under default-deny. Aggregated counts across the whole tree. */
  droppedKeys: Record<string, number>;
  /** Keys allowed but value-transformed (id redacted, name sanitized, paired_event_id mocked). */
  transformedKeys: Record<string, number>;
}

export function sanitizeFixture(input: unknown, _opts?: SanitizeOptions): unknown {
  return walk(input, makeSummary());
}

export function sanitizeFixtureWithSummary(
  input: unknown,
  _opts?: SanitizeOptions,
): { data: unknown; summary: SanitizeSummary } {
  const summary = makeSummary();
  const data = walk(input, summary);
  return { data, summary };
}

function makeSummary(): SanitizeSummary {
  return { droppedKeys: {}, transformedKeys: {} };
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function walk(value: unknown, summary: SanitizeSummary): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, summary));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (!ALLOWED_FIXTURE_KEYS.has(key)) {
        bump(summary.droppedKeys, key);
        continue;
      }
      const transform = TRANSFORMS.get(key);
      if (transform !== undefined) {
        const transformed = transform(v);
        // Transform returning undefined for a non-undefined input means
        // "drop the key" (e.g., `source: "GARMIN_CONNECT"` on an activity
        // row — not a valid FtpHistoryPoint enum value). Counts as a drop
        // for summary purposes so operators see the leak surface.
        if (transformed === undefined && v !== undefined) {
          bump(summary.droppedKeys, key);
          continue;
        }
        out[key] = transformed;
        bump(summary.transformedKeys, key);
        continue;
      }
      out[key] = walk(v, summary);
    }
    return out;
  }
  return value;
}
