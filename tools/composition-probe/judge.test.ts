import { describe, it, expect } from "vitest";

import { parseJudgeVerdict, JudgeParseError } from "./judge.js";
import type { JudgeVerdict } from "./types.js";

const valid: JudgeVerdict = {
  mixing: { flag: false, evidence: null, sportsInvolved: [] },
  items: { "sport-scope": { pass: true, note: "confined to running" } },
};

describe("parseJudgeVerdict", () => {
  it("parses a bare JSON verdict", () => {
    expect(parseJudgeVerdict(JSON.stringify(valid))).toEqual(valid);
  });

  it("parses a fenced JSON verdict", () => {
    const fenced = "```json\n" + JSON.stringify(valid) + "\n```";
    expect(parseJudgeVerdict(fenced)).toEqual(valid);
  });

  it("throws a typed error on non-JSON garbage", () => {
    expect(() => parseJudgeVerdict("this is not json at all")).toThrow(JudgeParseError);
  });

  it("rejects a verdict missing mixing.flag", () => {
    const bad = JSON.stringify({ mixing: { evidence: null, sportsInvolved: [] }, items: {} });
    expect(() => parseJudgeVerdict(bad)).toThrow(JudgeParseError);
  });
});
