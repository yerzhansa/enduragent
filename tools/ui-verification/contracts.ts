import type { StructuralContract } from "./structure";

export const preferencesContract = {
  anchors: [
    { name: "preferences", selector: '[aria-label="Preferences"]', count: { exact: 1 } },
    { name: "rows", selector: '[aria-label="Preferences"] > .settings-row', count: { exact: 2 } },
    { name: "labels", selector: '[aria-label="Preferences"] .settings-label', count: { exact: 2 } },
  ],
  rules: [
    { kind: "alignment", anchors: ["labels"], edge: "left" },
    { kind: "separators", rows: "rows" },
  ],
} satisfies StructuralContract;
