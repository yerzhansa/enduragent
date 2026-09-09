import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT, section11Available, tryRunHarness } from "./helpers/snapshot-harness";

/**
 * Renaming a top-level fixture key the harness reads must fail loud
 * with the missing-key path surfaced — otherwise a typo'd fixture
 * field would silently produce wrong-because-input-was-malformed
 * snapshots, which would then bit-port into the Reference layer.
 */

const GOLDEN_FIXTURE = resolve(
  REPO_ROOT,
  "packages/core/tests/fixtures/golden/realistic-athlete.json",
);

function corruptFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-section-11-corrupt-"));
  const path = join(dir, "corrupt.json");
  const raw = JSON.parse(readFileSync(GOLDEN_FIXTURE, "utf8")) as Record<string, unknown>;
  if (!("activities" in raw)) {
    throw new Error("golden fixture has no top-level 'activities' key");
  }
  raw["activitiez"] = raw["activities"];
  delete raw["activities"];
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

describe("section-11 snapshot harness contract validation", () => {
  it.runIf(section11Available())(
    "fails loud with the missing-key path when sync.py reads a None fixture field",
    () => {
      const corrupt = corruptFixture();
      const outDir = mkdtempSync(join(tmpdir(), "snapshot-section-11-corrupt-out-"));

      const result = tryRunHarness({ fixturePath: corrupt, outDir });

      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/contract violation/i);
      expect(combined).toMatch(/FIXTURE\.activities/);
    },
    180_000,
  );
});
