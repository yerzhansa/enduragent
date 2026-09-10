import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDeviationRegistry, validateResearchFile } from "../../../tools/check-metric-parity";

/**
 * Cite-path enforcement for the parity gate. Until a real
 * `approved-cite` deviation lands, the cite-path of the porting
 * discipline has zero runs against real machinery — these tests
 * synthesize the four states it must handle (missing / no marker /
 * thin / OK) and pin them so the discipline isn't hollow.
 *
 * The validator resolves `justification.path` against REPO_ROOT.
 * Passing an absolute path under `tmpdir()` bypasses that
 * resolution (resolve(REPO_ROOT, abs) === abs) so each test isolates
 * its own tempdir file.
 */

describe("cite-path enforcement — synthetic stress test", () => {
  it("rejects when the file is missing", () => {
    const r = validateResearchFile(join(tmpdir(), "definitely-not-a-real-file.md"));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/file does not exist/);
  });

  it("rejects when the file lacks any DOI or PMID marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-no-doi-"));
    const path = join(dir, "research.md");
    writeFileSync(path, "Lorem ipsum ".repeat(80));
    const r = validateResearchFile(path);
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/no DOI or PMID marker/);
  });

  it("rejects when the file has DOI but is under the word minimum", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-thin-"));
    const path = join(dir, "research.md");
    writeFileSync(path, "Short citation, DOI: 10.1234/example.2020.001 — nothing more.\n");
    const r = validateResearchFile(path);
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/word count.*below.*300-word minimum/);
  });

  it("accepts when the file has DOI and ≥ 300 words", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-ok-"));
    const path = join(dir, "research.md");
    const body = "Foo bar baz ".repeat(120) + "\n\nDOI: 10.5678/example.2021.042\n";
    writeFileSync(path, body);
    const r = validateResearchFile(path);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("accepts PMID markers equivalently to DOI markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-pmid-"));
    const path = join(dir, "research.md");
    const body = "Foo bar baz ".repeat(120) + "\n\nPMID: 12345678\n";
    writeFileSync(path, body);
    const r = validateResearchFile(path);
    expect(r.ok).toBe(true);
  });
});

describe("cite-path enforcement — registry-referenced research files", () => {
  it("every approved-cite entry resolves a research file that passes validation", () => {
    const registry = loadDeviationRegistry();
    const cites = registry.deviations.filter((d) => d.status === "approved-cite");
    for (const entry of cites) {
      const path = entry.justification?.path;
      expect(path, `${entry.metric} is approved-cite but has no justification.path`).toBeTruthy();
      const r = validateResearchFile(path);
      expect(
        r.ok,
        `${entry.metric} → ${path} failed cite-path validation: ${r.reasons.join("; ")}`,
      ).toBe(true);
    }
  });
});
