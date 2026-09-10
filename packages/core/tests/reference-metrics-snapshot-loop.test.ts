import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Manifest, Snapshot } from "../../../tools/check-metric-parity";
import { HARNESS_FIXTURES } from "../../../tools/harness-fixtures";

/**
 * Smoke test for the section-11 snapshot harness oracle.
 *
 * Proves that the per-metric JSON snapshots produced by
 * `pnpm snapshot:section-11` are loadable from Vitest and carry
 * the wrapper fields downstream parity tests will need. This is
 * NOT a parity assertion — that's the gate's job.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_ROOT = resolve(__dirname, "fixtures/snapshots");
const ATHLETE_DIR = resolve(SNAPSHOT_ROOT, "realistic-athlete");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("section-11 snapshot loop", () => {
  it("manifest pins the oracle's upstream coordinates", () => {
    const manifest = readJson<Manifest>(resolve(SNAPSHOT_ROOT, "manifest.json"));
    expect(manifest.section_11_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.section_11_protocol_version).toMatch(/^\d+\.\d+$/);
    expect(manifest.section_11_commit_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Assert the FULL allowlist, not just one slug: a single-fixture debug
    // regen that clobbered the manifest down to its own slug would slip past a
    // `toContain("realistic-athlete")` check whenever that slug is the one
    // debugged. Pinned to HARNESS_FIXTURES, the single source of truth.
    expect([...manifest.fixtures].sort()).toEqual(HARNESS_FIXTURES.map((f) => f.slug).sort());
    expect(manifest.metrics.length).toBeGreaterThan(0);
    expect(manifest.frozen_now).toBe("2026-05-10T12:00:00");
  });

  it("loads a representative per-metric snapshot with the wrapper schema", () => {
    const acwr = readJson<Snapshot>(resolve(ATHLETE_DIR, "acwr.json"));
    expect(acwr.metric).toBe("acwr");
    expect(acwr.athlete).toBe("realistic-athlete");
    expect(acwr.section_11_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(acwr.section_11_protocol_version).toMatch(/^\d+\.\d+$/);
    expect(acwr.frozen_now).toBe("1998-05-10T12:00:00");
    expect(acwr).toHaveProperty("value");
  });

  it("manifest's metrics list matches the on-disk file inventory", () => {
    const manifest = readJson<Manifest>(resolve(SNAPSHOT_ROOT, "manifest.json"));
    for (const name of manifest.metrics) {
      const snap = readJson<Snapshot>(resolve(ATHLETE_DIR, `${name}.json`));
      expect(snap.metric).toBe(name);
    }
  });
});
