import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import type { HttpPort } from "@enduragent/kernel/ports";
import { assertNoTpKeysRemain, parseRenamedActivity,
  renameTpFieldsOnActivity } from "../../core/src/reference/sync/rename-tp-fields.js";
import { normalizeStreams } from "../../core/src/reference/sync/fetch-live-bundle.js";
import { createIntervalsIcuSource } from "../src/index.js";

function archive(log: string[]): ArchiveManager {
  const values = new Map<string, unknown>();
  return {
    async writeSnapshot(value, when) { log.push("archive"); const address = createHash("sha256").update(canonicalJson(value)).digest("hex");
      const relPath = `${when.epochSeconds}/${address}.json.gz`; values.set(relPath, structuredClone(value)); return { address, relPath, deduped: false }; },
    async has(path) { return values.has(path); }, async readSnapshot(path) { return structuredClone(values.get(path)); },
    async writeArtifact() { throw new Error("unused"); }, async readArtifact() { throw new Error("unused"); },
    async quarantine() { throw new Error("unused"); },
  };
}

describe("existing landing ACL integration", () => {
  it("archives before ACL, transport remains unchanged, and normalized keys are clean", async () => {
    const raw = { id: "acl-a", start_date: "1998-01-05T07:00:00Z", start_date_local: "1998-01-05T08:00:00",
      type: "Ride", moving_time: 90, elapsed_time: 100, icu_ctl: 52 };
    const original = structuredClone(raw), log: string[] = [];
    const http: HttpPort = { fetch: async () => ({ status: 200, headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify([raw])) }) };
    const source = createIntervalsIcuSource({ athleteId: "synthetic-athlete", historyOldestDate: "1998-01-01",
      historyNewestDate: "1998-12-31", minRequestIntervalMs: 250, httpFactory: () => http, archive: archive(log),
      wallClock: { now: () => Date.UTC(1998, 0, 1) }, sleep: async () => {}, acl: {
        activity(row) { log.push("acl"); return parseRenamedActivity(renameTpFieldsOnActivity(row)); },
        streams(value) { const normalized = normalizeStreams(value); if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) throw new TypeError("streams invalid"); return normalized as Record<string, unknown>; },
        assertClean: assertNoTpKeysRemain,
      } });
    const values = [];
    for await (const value of source.pull({ source: "intervals-icu", lane: "activities", value: null }, {
      signal: new AbortController().signal, clock: { monotonicNow: () => 0 }, deadlineMonotonicMs: 1_000_000,
      perRequestTimeoutMs: 30_000, maxRequests: 5, maxArtifacts: 5 })) values.push(value);
    expect(log.slice(0, 3)).toEqual(["archive", "archive", "acl"]);
    expect(raw).toEqual(original);
    const artifact = values[0] as { payload: unknown; landing: { platform: { activity: Record<string, unknown> } } };
    expect(artifact.payload).toEqual(original);
    expect(artifact.landing.platform.activity.fitnessAtEnd).toBe(52);
    expect(() => assertNoTpKeysRemain(artifact.landing.platform.activity)).not.toThrow();
  });

  it("uses the existing stream normalizer without mutating raw transport", () => {
    const raw = [{ type: "dfa_a1", data: [0.9] }, { type: "watts", data: [200] }];
    const original = structuredClone(raw), normalized = normalizeStreams(structuredClone(raw));
    expect(normalized).toEqual({ dfa_a1: [0.9], watts: [200] }); expect(raw).toEqual(original);
    expect(() => assertNoTpKeysRemain(normalized)).not.toThrow();
  });
});
