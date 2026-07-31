import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { scanText, scanProbeOutputs } from "./scan.js";

// Hit tokens built by concatenation so this test source is lint-clean.
const TSS = "TS" + "S";
const REAL_ID = "i" + "12345678";

describe("scanText", () => {
  it("flags a redaction-list token", () => {
    expect(scanText(`your ${TSS} was high`).some((h) => h.rule === "redaction-token")).toBe(true);
  });

  it("flags a post-2015 ISO date shape", () => {
    expect(scanText("ran on 2026-07-06").some((h) => h.rule === "post-2015-date")).toBe(true);
  });

  it("flags a real intervals id shape", () => {
    expect(scanText(`activity ${REAL_ID} done`).some((h) => h.rule === "real-id-shape")).toBe(true);
  });

  it("passes a clean 1998-era line", () => {
    expect(scanText("ran on 1998-07-06, felt easy")).toHaveLength(0);
  });

  it("does not flag a bare prose year", () => {
    expect(scanText("a 2019 study of runners")).toHaveLength(0);
  });
});

describe("scanProbeOutputs", () => {
  it("reports missing inputs when the transcripts dir is absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "probe-scan-"));
    const res = scanProbeOutputs(empty);
    expect(res.missing).toContain("transcripts/*.jsonl");
  });
});
