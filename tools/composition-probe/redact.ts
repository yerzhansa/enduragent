// trademark-lint:skip-file — this module is the redaction substitution table:
// it must name the forbidden tokens as its match sources, exactly as the
// trademark linter's own source does. The token list has a single home here.

export interface RedactionRule {
  readonly source: string;
  readonly flags: string;
  readonly replacement: string;
}

export const REDACTION_RULES: readonly RedactionRule[] = [
  { source: "\\bTSS\\b", flags: "g", replacement: "[Load]" },
  { source: "\\bCTL\\b", flags: "g", replacement: "[Fitness]" },
  { source: "\\bATL\\b", flags: "g", replacement: "[Fatigue]" },
  { source: "\\bTSB\\b", flags: "g", replacement: "[Form]" },
  { source: "\\bNP\\b", flags: "g", replacement: "[weighted avg power]" },
  { source: "Training\\s+Stress\\s+Score", flags: "gi", replacement: "[Load]" },
  { source: "Normalized\\s+Power", flags: "gi", replacement: "[weighted avg power]" },
  { source: "Intensity\\s+Factor", flags: "gi", replacement: "[Intensity]" },
];

export function redactTrademarks(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const rule of REDACTION_RULES) {
    const re = new RegExp(rule.source, rule.flags);
    out = out.replace(re, () => {
      count += 1;
      return rule.replacement;
    });
  }
  return { text: out, count };
}
