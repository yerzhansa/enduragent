import type { Row, SqlValue } from "./ports.js";

/** ECMAScript Number::toString (shortest round-trip, engine-stable). Rejects non-finite; normalizes -0. */
export function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`canonical dump: non-finite number ${n}`);
  return Object.is(n, -0) ? "0" : `${n}`;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Tag every scalar so TEXT/INTEGER/REAL/BLOB/NULL can never alias in the dump. */
export function canonicalScalar(v: SqlValue): [string, string | null] {
  if (v === null) return ["z", null];
  if (typeof v === "string") return ["s", v];
  if (typeof v === "number") return ["n", canonicalNumber(v)];
  if (typeof v === "bigint") return ["i", v.toString()];
  return ["b", toHex(v)];
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(rec).sort()) sorted[k] = sortKeys(rec[k]);
    return sorted;
  }
  return value;
}

/** One row → a single canonical JSON line (keys sorted, values tagged). */
export function canonicalRowJson(row: Row): string {
  const tagged: Record<string, [string, string | null]> = {};
  for (const key of Object.keys(row)) tagged[key] = canonicalScalar(row[key]);
  return JSON.stringify(sortKeys(tagged));
}
