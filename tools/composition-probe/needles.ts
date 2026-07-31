import type { ProbeScenario, TranscriptLine } from "./types.js";

export type NeedleHit = TranscriptLine["needleHits"][number];

function stable(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.replace("g", ""));
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export function evalNeedles(scenario: ProbeScenario, rawAssistantText: string): NeedleHit[] {
  const hits: NeedleHit[] = [];

  for (const re of scenario.forbiddenNeedles ?? []) {
    const m = stable(re).exec(rawAssistantText);
    if (m) {
      hits.push({
        kind: "forbidden",
        pattern: re.toString(),
        excerpt: excerptAround(rawAssistantText, m.index, m[0].length),
      });
    }
  }

  for (const re of scenario.requiredNeedles ?? []) {
    if (!stable(re).test(rawAssistantText)) {
      hits.push({ kind: "required-miss", pattern: re.toString(), excerpt: "" });
    }
  }

  return hits;
}
