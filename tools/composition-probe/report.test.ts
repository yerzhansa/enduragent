import { describe, it, expect } from "vitest";

import {
  computeVerdict,
  hasForbidden,
  isMixing,
  parseSpotCheck,
  renderReport,
  ReportRefusal,
  type ReportInput,
} from "./report.js";
import { FLOOR_MODELS } from "./constants.js";
import { abortReportInput, makeLine, reworkReportInput } from "./dryrun-fixtures.js";

const [SLUG0, SLUG1, SLUG2] = FLOOR_MODELS.map((m) => m.slug);

function tokens(overrides: Partial<ReportInput["tokens"]> = {}): ReportInput["tokens"] {
  return {
    method: "anthropic count_tokens",
    model: "claude-haiku-4-5-20251001",
    stablePrefixTokens: 12000,
    wholePromptTokens: 40000,
    measuredAtGitSha: "0".repeat(40),
    ...overrides,
  };
}

describe("computeVerdict", () => {
  it("aborts when any model's raw mixing rate exceeds 5%", () => {
    expect(computeVerdict([{ rawM1Rate: 4 / 70, m2Accuracy: 1, m3Hits: 6, integratedFailures: 0 }], 12000, 40000)).toBe(
      "ABORT-PREMISE",
    );
  });
  it("aborts when the whole prompt exceeds the token max", () => {
    expect(computeVerdict([{ rawM1Rate: 0, m2Accuracy: 1, m3Hits: 6, integratedFailures: 0 }], 12000, 50001)).toBe(
      "ABORT-PREMISE",
    );
  });
  it("reworks when the stable prefix exceeds its budget and nothing aborts", () => {
    expect(computeVerdict([{ rawM1Rate: 0, m2Accuracy: 1, m3Hits: 6, integratedFailures: 0 }], 15001, 40000)).toBe(
      "REWORK-LAYOUT",
    );
  });
  it("advises when tool-choice is under threshold", () => {
    expect(computeVerdict([{ rawM1Rate: 0, m2Accuracy: 0.7, m3Hits: 6, integratedFailures: 0 }], 12000, 40000)).toBe(
      "ADVISORY-FAIL",
    );
  });
  it("proceeds when all metrics clear", () => {
    expect(computeVerdict([{ rawM1Rate: 0, m2Accuracy: 1, m3Hits: 6, integratedFailures: 0 }], 12000, 40000)).toBe(
      "PROCEED",
    );
  });
});

describe("renderReport", () => {
  it("renders the abort dataset on the raw rate with the adjusted rate alongside", () => {
    const md = renderReport(abortReportInput());
    expect(md).toContain("RAW 4/70");
    expect(md).toContain("3/70");
    expect(md).toContain("ABORT-PREMISE");
    expect(md).not.toContain("PENDING");
    expect(md).toContain("/70");
  });

  it("renders the rework dataset verdict", () => {
    const md = renderReport(reworkReportInput());
    expect(md).toContain("REWORK-LAYOUT");
    expect(md).not.toContain("PENDING");
  });

  it("excludes required-miss-only and judge-item-only turns from the M1 numerator but flags them", () => {
    const reqMiss = makeLine({
      scenarioId: "c7-07",
      class: "c7-contamination",
      model: SLUG0,
      needleHits: [{ kind: "required-miss", pattern: "/threshold/i", excerpt: "" }],
      flagged: true,
      judge: { mixing: { flag: false, evidence: null, sportsInvolved: [] }, items: {} },
    });
    const judgeFail = makeLine({
      scenarioId: "c8-01",
      class: "c8-tool-choice",
      model: SLUG0,
      flagged: true,
      judge: { mixing: { flag: false, evidence: null, sportsInvolved: [] }, items: { "sport-scope": { pass: false, note: "x" } } },
    });
    expect(hasForbidden(reqMiss)).toBe(false);
    expect(isMixing(judgeFail)).toBe(false);
    const input: ReportInput = {
      runDate: "1998-07-06",
      tokens: tokens(),
      transcripts: { [SLUG0]: [reqMiss, judgeFail], [SLUG1]: [], [SLUG2]: [] },
      spotCheckRows: [],
    };
    const md = renderReport(input);
    expect(md).toContain(`M1 [${SLUG0}]: RAW 0/70`);
    expect(md).toContain("c7-07");
    expect(md).toContain("c8-01");
  });

  it("refuses to render when a transcript line carries an error", () => {
    const errored = makeLine({ scenarioId: "c1-01", class: "c1-cycling", model: SLUG0, error: "boom" });
    const input: ReportInput = {
      runDate: "1998-07-06",
      tokens: tokens(),
      transcripts: { [SLUG0]: [errored], [SLUG1]: [], [SLUG2]: [] },
      spotCheckRows: [],
    };
    expect(() => renderReport(input)).toThrow(ReportRefusal);
  });

  it("carries no banned strings in the rendered output", () => {
    const md = renderReport(abortReportInput());
    const banned = ["TS" + "S", "CT" + "L", "AT" + "L", "TS" + "B", "docs/"];
    for (const token of banned) expect(md).not.toContain(token);
  });
});

describe("parseSpotCheck", () => {
  const header = "| scenarioId | model | flagSource | verdict | reason |\n|---|---|---|---|---|\n";

  it("parses a template with zero data rows as zero overturns", () => {
    const rows = parseSpotCheck(header + "\nSpot-check performed by the operator, YYYY-MM-DD\n");
    expect(rows).toEqual([]);
  });

  it("parses a valid data row", () => {
    const rows = parseSpotCheck(header + `| c2-01 | ${SLUG0} | needle | OVERTURN | conversational only |\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe("OVERTURN");
  });

  it("refuses a malformed row", () => {
    expect(() => parseSpotCheck(header + `| not-a-real-id | ${SLUG0} | needle | CONFIRM | x |\n`)).toThrow(ReportRefusal);
  });
});
