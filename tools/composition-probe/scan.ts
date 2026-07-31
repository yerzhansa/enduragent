import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { REDACTION_RULES } from "./redact.js";

export interface ScanHit {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
}

export interface ScanResult {
  hits: ScanHit[];
  missing: string[];
}

const POST_2015_DATE = /\b20(1[5-9]|[2-9][0-9])-[01][0-9]-[0-3][0-9]\b/;
const REAL_ID = /\bi\d{8,9}\b/;

function windowAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 15);
  const end = Math.min(text.length, index + length + 15);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function globalize(re: RegExp): RegExp {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  return new RegExp(re.source, flags);
}

export function scanText(text: string): Array<{ rule: string; excerpt: string }> {
  const hits: Array<{ rule: string; excerpt: string }> = [];

  for (const rule of REDACTION_RULES) {
    const re = new RegExp(rule.source, rule.flags.includes("g") ? rule.flags : rule.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ rule: "redaction-token", excerpt: windowAround(text, m.index, m[0].length) });
    }
  }

  for (const [ruleName, base] of [
    ["post-2015-date", POST_2015_DATE],
    ["real-id-shape", REAL_ID],
  ] as const) {
    const re = globalize(base);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ rule: ruleName, excerpt: windowAround(text, m.index, m[0].length) });
    }
  }

  return hits;
}

function scanFile(file: string, out: ScanHit[]): void {
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const hit of scanText(lines[i])) {
      out.push({ file, line: i + 1, rule: hit.rule, excerpt: hit.excerpt });
    }
  }
}

export function scanProbeOutputs(dir: string): ScanResult {
  const hits: ScanHit[] = [];
  const missing: string[] = [];

  const transcriptsDir = join(dir, "transcripts");
  const transcriptFiles = existsSync(transcriptsDir)
    ? readdirSync(transcriptsDir).filter((f) => f.endsWith(".jsonl")).sort()
    : [];
  if (transcriptFiles.length === 0) {
    missing.push("transcripts/*.jsonl");
  }
  for (const f of transcriptFiles) {
    scanFile(join(transcriptsDir, f), hits);
  }

  const tokensFile = join(dir, "tokens.json");
  if (existsSync(tokensFile)) {
    scanFile(tokensFile, hits);
  } else {
    missing.push("tokens.json");
  }

  return { hits, missing };
}
