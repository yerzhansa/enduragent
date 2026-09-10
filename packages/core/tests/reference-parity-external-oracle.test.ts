import { execFile } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  crossCheckQuantity,
  isCovered,
  loadExternalCoverage,
  loadExternalSnapshot,
  runExternalForFixture,
  type ExternalCoveredEntry,
} from "../../../tools/external-oracle";
import { REPO_ROOT } from "../../../tools/check-metric-parity";

/**
 * External-oracle cross-check surface for the parity gate.
 *
 * The external oracle independently computes mean-max power/HR curves
 * from the same underlying rides the `curve-equipped` fixture's curve
 * blocks aggregate. These tests pin (1) the registry-declared coverage
 * and the floor(oracle) relation against the committed snapshots, (2) the
 * zero-coverage guard, (3) the both-mode missing-snapshot fail semantics,
 * and (4) that the section-11 default mode is unchanged.
 *
 * Exit-code scenarios run the real CLI as a subprocess so the assertions
 * cover the process boundary the way CI invokes it.
 */

const GATE = join(REPO_ROOT, "tools/check-metric-parity.ts");
const CHILD_PROCESS_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 20_000;

function runGate(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", GATE, ...args],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: CHILD_PROCESS_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          out: `${stdout}${stderr}`,
        });
      },
    );
  });
}

describe("external-oracle registry coverage", () => {
  it("declares the six covered mean-max quantities plus the uncovered cp-model file", () => {
    const coverage = loadExternalCoverage().filter((e) => e.fixture === "curve-equipped");
    const covered = coverage
      .filter(isCovered)
      .map((e) => e.quantity)
      .sort();
    const uncovered = coverage
      .filter((e) => !isCovered(e))
      .map((e) => e.quantity)
      .sort();
    expect(covered).toEqual([
      "hr_mean_max_current",
      "hr_mean_max_previous",
      "power_mean_max_current",
      "power_mean_max_previous",
      "sustainability_hr_mean_max",
      "sustainability_power_mean_max",
    ]);
    expect(uncovered).toEqual(["cp_model_peak_power_per_ride"]);
  });

  it("every covered entry declares the floor_int tolerance kind", () => {
    const covered = loadExternalCoverage().filter(isCovered);
    for (const entry of covered) {
      expect(entry.tolerance.kind).toBe("floor_int");
      expect(entry.tolerance.max_offset).toBeGreaterThan(0);
      expect(entry.tolerance.max_offset).toBeLessThan(1);
    }
  });
});

describe("external-oracle snapshots (committed, immutable)", () => {
  it("loads each covered quantity's wrapper with the external-oracle shape", () => {
    const covered = loadExternalCoverage().filter(isCovered);
    for (const entry of covered) {
      const snap = loadExternalSnapshot(entry.fixture, entry.quantity);
      expect(snap, `${entry.quantity} snapshot missing`).toBeDefined();
      expect(snap?.oracle).toBe("external");
      expect(snap?.athlete).toBe("curve-equipped");
      expect(snap?.frozen_now).toBe("1998-06-04T12:00:00");
    }
  });

  it("returns undefined for a fixture with no external snapshot", () => {
    expect(loadExternalSnapshot("realistic-athlete", "power_mean_max_current")).toBeUndefined();
  });
});

describe("floor(oracle) cross-check against the curve-equipped fixture", () => {
  it("passes for every covered quantity on the committed snapshots", () => {
    const covered = loadExternalCoverage().filter(
      (e): e is ExternalCoveredEntry => isCovered(e) && e.fixture === "curve-equipped",
    );
    for (const entry of covered) {
      const check = crossCheckQuantity(entry);
      expect(check, `${entry.quantity} produced no check`).toBeDefined();
      expect(
        check?.passed,
        `${entry.quantity} failed: ${check?.failures.map((f) => `${f.anchorSecs}s ${f.reason}`).join("; ")}`,
      ).toBe(true);
      expect(check?.comparedAnchors).toBeGreaterThan(0);
    }
  });

  it("aggregates a non-zero coverage count for the fixture", () => {
    const result = runExternalForFixture("curve-equipped");
    expect(result.coveredCount).toBe(6);
    expect(result.passedCount).toBe(6);
    expect(result.failedCount).toBe(0);
    expect(result.uncovered.map((u) => u.quantity)).toEqual(["cp_model_peak_power_per_ride"]);
    expect(result.missingSnapshots).toEqual([]);
  });

  it("reports zero coverage for a fixture the registry does not cover", () => {
    const result = runExternalForFixture("realistic-athlete");
    expect(result.coveredCount).toBe(0);
    expect(result.missingSnapshots).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it("refuses a tolerance kind the gate does not implement (anti-tolerance-shopping)", () => {
    const base = loadExternalCoverage().find((e): e is ExternalCoveredEntry => isCovered(e))!;
    const rogue: ExternalCoveredEntry = {
      ...base,
      tolerance: { kind: "epsilon_1e3", max_offset: 1000 },
    };
    expect(() => crossCheckQuantity(rogue)).toThrow(/does not implement/);
  });
});

describe("CLI exit-code contract", () => {
  it(
    "default mode (section-11) is unchanged: acwr / realistic-athlete passes",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { code, out } = await runGate(["--metric=acwr", "--fixture=realistic-athlete"]);
      expect(code).toBe(0);
      expect(out).toContain("[parity] acwr / realistic-athlete: OK");
      // The external surface must not leak into the default run.
      expect(out).not.toContain("[parity:external]");
    },
  );

  it(
    "external mode passes on the committed snapshots with coverage > 0",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { code, out } = await runGate(["--oracle=external", "--fixture=curve-equipped"]);
      expect(code).toBe(0);
      expect(out).toContain("coverage: 6/6 covered quantity(ies) passed");
      expect(out).toContain("power_mean_max_current / curve-equipped: OK");
    },
  );

  it(
    "both mode passes: section-11 matrix + external cross-checks",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { code, out } = await runGate(["--oracle=both", "--fixture=curve-equipped"]);
      expect(code).toBe(0);
      expect(out).toContain("coverage: 6/6 covered quantity(ies) passed");
      // section-11 leg present (a known curve-equipped metric).
      expect(out).toMatch(/\[parity\] \S+ \/ curve-equipped: OK/);
    },
  );

  it(
    "zero-coverage external run exits non-zero with a clear message",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { code, out } = await runGate(["--oracle=external", "--fixture=realistic-athlete"]);
      expect(code).toBe(2);
      expect(out).toContain("ZERO covered quantities");
    },
  );

  it("external mode requires an explicit fixture", { timeout: TEST_TIMEOUT_MS }, async () => {
    const { code, out } = await runGate(["--oracle=external"]);
    expect(code).toBe(2);
    expect(out).toContain("requires an explicit --fixture");
  });

  it("rejects an unknown oracle value", { timeout: TEST_TIMEOUT_MS }, async () => {
    const { code, out } = await runGate(["--oracle=nonsense", "--fixture=curve-equipped"]);
    expect(code).not.toBe(0);
    expect(out).toContain("unknown --oracle value");
  });
});
