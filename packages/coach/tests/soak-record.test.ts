import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createSoakConclusion, validateSoakPair, type SoakEvidence } from "../src/soak-record.js";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const encoded = (value: string): string => Buffer.from(value).toString("base64");

export function soakEvidence(): SoakEvidence {
  const entries = Array.from({ length: 7 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    return {
      civil_date: `1998-07-${day}`,
      completed_at: `1998-07-${day}T12:00:00+00:00`,
      head_sha: head,
      bot: "bot:12345",
      tier_r: "GREEN" as const,
      tier_r_header_base64: encoded(`header-${day}`),
      suite: "GREEN" as const,
      self_test: "GREEN" as const,
      same_fetch_verdict: "GREEN" as const,
      manifest_base64: encoded(`manifest-${day}`),
      assertion_base64: encoded(`assertion-${day}`),
      last_sync_age_ms: index * 1000,
      freshness_disclosed: true,
      environmental_failures: [],
      code_changed: false,
      restart_reasons: index === 0 ? ["initial" as const] : [],
    };
  });
  return {
    schema_version: 1,
    timezone: "Etc/UTC",
    token_revoked: true,
    entries,
    outage: {
      civil_date: "1998-07-07",
      verdict: "PASS",
      credentials_preserved: true,
      stored_data_unchanged: true,
      historical_answers_passed: true,
      freshness_only_degraded: true,
    },
  };
}

describe("seven-date soak records", () => {
  it("derives and reload-validates one strict hash-bound conclusion", () => {
    const bytes = Buffer.from(`${JSON.stringify(soakEvidence())}\n`);
    const conclusion = createSoakConclusion(bytes, head);
    expect(conclusion.entries).toHaveLength(7);
    expect(validateSoakPair(bytes, conclusion, head)).toEqual(conclusion);
  });

  it("rejects post-validation mutation and asymmetric conclusions", () => {
    const bytes = Buffer.from(`${JSON.stringify(soakEvidence())}\n`);
    const conclusion = createSoakConclusion(bytes, head);
    const mutated = Buffer.from(bytes);
    mutated[mutated.length - 2] = 0x20;
    expect(() => validateSoakPair(mutated, conclusion, head)).toThrow();
    expect(() =>
      validateSoakPair(bytes, { ...conclusion, evidence_sha256: "0".repeat(64) }, head),
    ).toThrow();
  });

  it("rejects six dates, red Tier-R, duplicate dates, and unreconciled code changes", () => {
    const six = soakEvidence();
    six.entries.pop();
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(six)), head)).toThrow();
    const red = soakEvidence();
    red.entries[2] = { ...red.entries[2]!, tier_r: "RED" };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(red)), head)).toThrow();
    const duplicate = soakEvidence();
    duplicate.entries[3] = {
      ...duplicate.entries[3]!,
      civil_date: "1998-07-03",
      completed_at: "1998-07-03T13:00:00+00:00",
    };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(duplicate)), head)).toThrow();
    const changed = soakEvidence();
    changed.entries[3] = {
      ...changed.entries[3]!,
      code_changed: true,
      restart_reasons: ["code-change"],
    };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(changed)), head)).toThrow();
  });

  it("rejects eight/reversed dates, mixed identities, invalid zones, revoked-token gaps, and outage drift", () => {
    const eight = soakEvidence();
    eight.entries.push({
      ...eight.entries[6]!,
      civil_date: "1998-07-08",
      completed_at: "1998-07-08T12:00:00+00:00",
    });
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(eight)), head)).toThrow();
    const reversed = soakEvidence();
    [reversed.entries[2], reversed.entries[3]] = [reversed.entries[3]!, reversed.entries[2]!];
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(reversed)), head)).toThrow();
    const mixed = soakEvidence();
    mixed.entries[4] = { ...mixed.entries[4]!, bot: "bot:54321" };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(mixed)), head)).toThrow();
    const zone = soakEvidence();
    zone.timezone = "Not/AZone";
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(zone)), head)).toThrow();
    const token = soakEvidence();
    token.token_revoked = false;
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(token)), head)).toThrow();
    const outage = soakEvidence();
    outage.outage.credentials_preserved = false;
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(outage)), head)).toThrow();
  });

  it("rejects malformed evidence bytes, unknown keys, red same-fetch assertions, and invalid restart evidence", () => {
    const malformed = soakEvidence();
    malformed.entries[1] = { ...malformed.entries[1]!, manifest_base64: "not-base64" };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(malformed)), head)).toThrow();
    const unknown = soakEvidence() as unknown as Record<string, unknown>;
    unknown.extra = true;
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(unknown)), head)).toThrow();
    const red = soakEvidence();
    red.entries[1] = { ...red.entries[1]!, same_fetch_verdict: "RED" };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(red)), head)).toThrow();
    const restart = soakEvidence();
    restart.entries[1] = { ...restart.entries[1]!, restart_reasons: ["environment-recovery"] };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(restart)), head)).toThrow();
    const uncured = soakEvidence();
    uncured.entries[1] = {
      ...uncured.entries[1]!,
      environmental_failures: [
        {
          kind: "network",
          observed_at: "1998-07-02T13:00:00+00:00",
          cured_at: "1998-07-02T12:00:00+00:00",
        },
      ],
    };
    expect(() => createSoakConclusion(Buffer.from(JSON.stringify(uncured)), head)).toThrow();
  });
});
