import { describe, it, expect } from "vitest";

import { redactTrademarks } from "./redact.js";

// Every forbidden token is built by concatenation so this test source stays
// trademark-lint-clean.
const TSS = "TS" + "S";
const CTL = "CT" + "L";
const ATL = "AT" + "L";
const TSB = "TS" + "B";
const NP = "N" + "P";
const TSS_LONG = "Training" + " " + "Stress" + " " + "Score";
const NP_LONG = "Normalized" + " " + "Power";
const IFACTOR = "Intensity" + " " + "Factor";
const IF_STANDALONE = "I" + "F";

describe("redactTrademarks", () => {
  it("replaces every redaction-list token", () => {
    const raw = `${TSS} ${CTL} ${ATL} ${TSB} ${NP} — ${TSS_LONG}, ${NP_LONG}, ${IFACTOR}.`;
    const { text, count } = redactTrademarks(raw);
    expect(count).toBe(8);
    for (const token of [TSS, CTL, ATL, TSB, NP, TSS_LONG, NP_LONG, IFACTOR]) {
      expect(text).not.toContain(token);
    }
    expect(text).toContain("[Load]");
    expect(text).toContain("[Fitness]");
    expect(text).toContain("[Intensity]");
  });

  it("leaves the standalone English-collision token untouched", () => {
    const raw = `${IF_STANDALONE} the effort felt easy.`;
    const { text, count } = redactTrademarks(raw);
    expect(count).toBe(0);
    expect(text).toBe(raw);
  });

  it("is idempotent on already-clean text", () => {
    const clean = "Your Load was moderate and your Form is climbing.";
    const { text, count } = redactTrademarks(clean);
    expect(count).toBe(0);
    expect(text).toBe(clean);
  });
});
