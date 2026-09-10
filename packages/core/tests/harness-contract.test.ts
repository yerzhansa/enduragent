import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./helpers/snapshot-harness";

/**
 * The snapshot harness has four implementations that must agree on the same
 * literal data — the pyodide harness, its native CPython twin, the fuzz-parity
 * differential, and the coverage probe. That data lives in one language-neutral
 * file (`tools/harness-contract.json`) because two of the four are Python and
 * cannot import the TypeScript loader. This suite is the drift tripwire: it
 * pins the contract's shape, asserts the README's documented allowlist matches
 * it, and asserts no harness file has re-grown an inline copy of the literals.
 */

const CONTRACT_PATH = join(REPO_ROOT, "tools/harness-contract.json");
const README_PATH = join(REPO_ROOT, "tools/snapshot-section-11.README.md");

const HARNESS_FILES = [
  "tools/snapshot-section-11.ts",
  "tools/snapshot-section-11-native.py",
  "tools/fuzz-parity.ts",
  "tools/measure-reference-coverage-native.py",
];

function readContractRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as Record<string, unknown>;
}

/** Drop the `$comment` documentation keys the contract carries inline. */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "$comment")
        .map(([k, v]) => [k, stripComments(v)]),
    );
  }
  return value;
}

/**
 * Parse the JSON array that follows a ```json fence in the README's
 * "Contract validation" section — the human-readable mirror of the
 * allowlist. The block is fenced exactly once in that section.
 */
function readmeAllowlist(readme: string): string[] {
  const match = readme.match(/```json\n(\[[\s\S]*?\])\n```/);
  if (!match) throw new Error("README has no fenced JSON allowlist block");
  return JSON.parse(match[1]!) as string[];
}

describe("harness-contract.json schema shape", () => {
  it("parses and exposes exactly the expected top-level keys", () => {
    const raw = stripComments(readContractRaw()) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([
      "conditionalKwargs",
      "fuzzOnlyOptionalPaths",
      "optionalFixturePaths",
      "powerCurveDeltaWindowDaysAgo",
    ]);
  });

  it("optionalFixturePaths and fuzzOnlyOptionalPaths are non-empty string arrays with no overlap", () => {
    const raw = stripComments(readContractRaw()) as {
      optionalFixturePaths: unknown;
      fuzzOnlyOptionalPaths: unknown;
    };
    expect(Array.isArray(raw.optionalFixturePaths)).toBe(true);
    expect(Array.isArray(raw.fuzzOnlyOptionalPaths)).toBe(true);
    const canonical = raw.optionalFixturePaths as string[];
    const fuzzOnly = raw.fuzzOnlyOptionalPaths as string[];
    expect(canonical.length).toBeGreaterThan(0);
    expect(fuzzOnly.length).toBeGreaterThan(0);
    for (const p of [...canonical, ...fuzzOnly]) {
      expect(typeof p).toBe("string");
      expect(p.startsWith("FIXTURE.")).toBe(true);
    }
    // No path is both canonical and fuzz-only.
    const overlap = fuzzOnly.filter((p) => canonical.includes(p));
    expect(overlap).toEqual([]);
    // No duplicates within either list.
    expect(new Set(canonical).size).toBe(canonical.length);
    expect(new Set(fuzzOnly).size).toBe(fuzzOnly.length);
  });

  it("conditionalKwargs maps every derived kwarg to a gating fixture key", () => {
    const raw = stripComments(readContractRaw()) as {
      conditionalKwargs: Record<string, string>;
    };
    const map = raw.conditionalKwargs;
    expect(Object.keys(map).length).toBeGreaterThan(0);
    for (const [kwarg, sourceKey] of Object.entries(map)) {
      expect(typeof kwarg).toBe("string");
      expect(typeof sourceKey).toBe("string");
      expect(sourceKey.length).toBeGreaterThan(0);
    }
    // The gating source keys are a subset of the fixture's optional top-level
    // keys (each conditional kwarg is derived only when its key is present).
    const optionalTopLevel = new Set(
      (raw as unknown as { optionalFixturePaths: string[] }).optionalFixturePaths
        .filter((p) => !p.includes("[*]") && !p.slice("FIXTURE.".length).includes("."))
        .map((p) => p.slice("FIXTURE.".length)),
    );
    for (const sourceKey of Object.values(map)) {
      expect(optionalTopLevel.has(sourceKey)).toBe(true);
    }
  });

  it("powerCurveDeltaWindowDaysAgo carries the three integer day-offsets", () => {
    const raw = stripComments(readContractRaw()) as {
      powerCurveDeltaWindowDaysAgo: Record<string, unknown>;
    };
    const w = raw.powerCurveDeltaWindowDaysAgo;
    expect(Object.keys(w).sort()).toEqual([
      "win1StartDaysAgo",
      "win2EndDaysAgo",
      "win2StartDaysAgo",
    ]);
    for (const v of Object.values(w)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("README allowlist matches the contract", () => {
  it("the fenced JSON allowlist block equals optionalFixturePaths exactly", () => {
    const raw = stripComments(readContractRaw()) as {
      optionalFixturePaths: string[];
    };
    const fromReadme = readmeAllowlist(readFileSync(README_PATH, "utf8"));
    expect(fromReadme).toEqual(raw.optionalFixturePaths);
  });
});

describe("no harness file carries a residual inline copy of the extracted literals", () => {
  const sources = HARNESS_FILES.map((rel) => ({
    rel,
    text: readFileSync(join(REPO_ROOT, rel), "utf8"),
  }));

  it("no file declares an inline _ALLOWED_OPTIONAL_PATHS set literal", () => {
    // The allowlist must be built from the injected contract data
    // (`set(json.loads(...))`), never re-listed as a `{ "FIXTURE..." }` set.
    for (const { rel, text } of sources) {
      const inlineSet = /_ALLOWED_OPTIONAL_PATHS\s*=\s*\{[^}]*"FIXTURE\./.test(text);
      expect(inlineSet, `${rel} re-grew an inline allowlist set`).toBe(false);
    }
  });

  it("no file re-lists the power-curve delta-window day-offsets as inline magic numbers", () => {
    // The win2 offsets (55 / 28) are unique to the curve delta-window and must
    // come from the contract; a literal `timedelta(days=55|28)` is drift. The
    // 27 offset is NOT tested here — it is shared with the base 28-day activity
    // slice (`days=27`, an inclusive-window off-by-one) that stays inline.
    const offending = /timedelta\(days=(?:28|55)\)/;
    for (const { rel, text } of sources) {
      expect(offending.test(text), `${rel} re-listed a delta-window offset as a magic number`).toBe(
        false,
      );
    }
  });

  it("every harness file references the shared contract", () => {
    for (const { rel, text } of sources) {
      expect(text.includes("harness-contract"), `${rel} does not read the shared contract`).toBe(
        true,
      );
    }
  });
});
