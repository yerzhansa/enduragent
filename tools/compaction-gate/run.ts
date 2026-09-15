import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessage } from "ai";

import type { Config } from "../../packages/core/src/config.js";
import { COMPACT_MODEL_DEFAULTS, contextWindowForModel } from "../../packages/core/src/config.js";
import { LLM } from "../../packages/engine/src/llm.js";
import { createEngineHostAdapter } from "../../packages/core/src/agent/engine-host-adapter.js";
import { bundledAcceptedCatalog } from "../../packages/core/src/model-catalog.js";
import { legacyStateReader } from "../../packages/core/src/agent/legacy-athlete-state-reader.js";
import { USAGE_LEDGER_FILE, type UsageLedgerLine } from "../../packages/core/src/usage-ledger.js";
import type { MemorySnapshot, SportMemoryShape } from "@enduragent/engine/sport";
import {
  formatTranscript,
  resolveMustPreserveTokens,
  summarizeDroppedMessages,
  summarizeInStages,
} from "../../packages/engine/src/agent/compaction.js";
import { SUMMARY_PREFIX } from "../../packages/engine/src/agent/history-limit.js";
import { parseLedger } from "../usage-baseline.js";
// The built package, not src: sport.ts imports SOUL.md via tsup's text loader,
// which tsx cannot resolve; the dist bundle carries the text inlined.
import { cyclingSport } from "@enduragent/sport-cycling";

import {
  JUDGE_MODEL_ID,
  JUDGE_RUBRIC,
  JUDGE_RUNS_PER_TRANSCRIPT,
  SUMMARY_DRAWS_PER_TRANSCRIPT,
  JUDGE_MAX_OUTPUT_TOKENS,
} from "./rubric.js";
import {
  cacheEvidence,
  drawsVerdict,
  median,
  mustPreserveDiff,
  parseJudgeVerdict,
  tierJTranscriptVerdict,
  type JudgeVerdict,
} from "./checks.js";

interface Transcript {
  id: string;
  sport: "cycling" | "static";
  mode: "stages" | "dropped";
  previousSummary: string | null;
  memorySections: Record<string, string>;
  mustPreserveTokens: string[] | null;
  messages: ModelMessage[];
  facts: Array<{ id: string; statement: string }>;
}

function fail(code: number, reason: string): never {
  process.stderr.write(`compaction-gate: ${reason}\n`);
  process.exit(code);
}

function snapshotMemory(sections: Record<string, string>): MemorySnapshot {
  return {
    read: (name) => (typeof sections[name] === "string" && sections[name] !== "" ? sections[name] : null),
    has: (name) => typeof sections[name] === "string" && sections[name] !== "",
    listSections: () => Object.keys(sections),
    provenanceOf: () => ({ garmin: false, nonGarmin: false, unknown: true }),
  };
}

function makeConfig(model: string, apiKey: string, dataDir: string): Config {
  return {
    dataSource: "platform",
    llm: { provider: "anthropic", model, apiKey },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "",
    },
    contextWindowTokens: contextWindowForModel(model),
    dataDir,
  };
}

function readLedger(dataDir: string): UsageLedgerLine[] {
  const path = join(dataDir, USAGE_LEDGER_FILE);
  if (!existsSync(path)) return [];
  return parseLedger(readFileSync(path, "utf-8"));
}

function stripSummaryPrefix(text: string): string {
  return text.startsWith(SUMMARY_PREFIX) ? text.slice(SUMMARY_PREFIX.length + 1) : text;
}

function specFor(t: Transcript): SportMemoryShape["mustPreserveTokens"] {
  return t.sport === "cycling"
    ? cyclingSport.mustPreserveTokens
    : (t.mustPreserveTokens ?? []);
}

async function runCompaction(
  t: Transcript,
  llm: LLM,
  contextWindowTokens: number,
): Promise<string> {
  const memory = snapshotMemory(t.memorySections);
  const mustPreserveTokens = specFor(t);
  if (t.mode === "stages") {
    const result = await summarizeInStages({
      messages: t.messages,
      llm,
      mustPreserveTokens,
      memory,
      recentToKeep: 0,
      contextWindowTokens,
      caller: "compact",
    });
    return stripSummaryPrefix(String(result.messages[0].content));
  }
  const { summary } = await summarizeDroppedMessages({
    dropped: t.messages,
    previousSummary: t.previousSummary ?? undefined,
    llm,
    mustPreserveTokens,
    memory,
    contextWindowTokens,
    caller: "compact",
  });
  return summary;
}

async function judgeOnce(
  judge: LLM,
  payload: { transcript: string; facts: Transcript["facts"]; summary: string },
): Promise<JudgeVerdict> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await judge.generate({
      system: JUDGE_RUBRIC,
      prompt: JSON.stringify(payload),
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    });
    try {
      return parseJudgeVerdict(text, payload.facts.map((fact) => fact.id));
    } catch (err) {
      lastErr = err;
    }
  }
  fail(2, `judge parse failed twice: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function exerciserMessages(): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < 2000; i++) {
    const n = String(i + 1).padStart(4, "0");
    let content = `Ride log ${n}: FTP 262W on the climb, sweet spot work, TTE near 40min, ride dated 1998-08-15, cadence steady. `;
    while (content.length < 220) content += `entry ${n} note. `;
    content = content.slice(0, 224);
    out.push({ role: i % 2 === 0 ? "user" : "assistant", content });
  }
  return out;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    fail(2, "ANTHROPIC_API_KEY is required (live gate, direct Anthropic route only)");
  }

  const compactModel = COMPACT_MODEL_DEFAULTS.anthropic;
  const tempDir = mkdtempSync(join(tmpdir(), "compaction-gate-"));
  const compactHost = createEngineHostAdapter({
    catalog: bundledAcceptedCatalog(),
    config: makeConfig(compactModel, apiKey, tempDir),
    stateReader: legacyStateReader,
  }).ports;
  const judgeHost = createEngineHostAdapter({
    catalog: bundledAcceptedCatalog(),
    config: makeConfig(JUDGE_MODEL_ID, apiKey, tempDir),
    stateReader: legacyStateReader,
  }).ports;
  const compactLlm = new LLM(compactHost.config, compactHost);
  const judgeLlm = new LLM(judgeHost.config, judgeHost);
  const compactWindow = contextWindowForModel(compactModel);

  const transcriptsDir = join(dirname(fileURLToPath(import.meta.url)), "transcripts");
  const files = [
    "cycling-dense.json",
    "running-dense.json",
    "stance-dispute.json",
    "injury-illness.json",
    "mixed-week.json",
  ];

  interface Row {
    id: string;
    medianFactScore: number;
    fabricationsPerDraw: number[];
    passDraws: number;
    diff: string[];
  }
  const rows: Row[] = [];
  let anyFail = false;

  for (const file of files) {
    const t = JSON.parse(readFileSync(join(transcriptsDir, file), "utf-8")) as Transcript;
    const memory = snapshotMemory(t.memorySections);
    const tokens = resolveMustPreserveTokens(specFor(t), memory);

    const sourceText =
      formatTranscript(t.messages) + (t.previousSummary ? `\n${t.previousSummary}` : "");
    const judgeTranscript = t.previousSummary
      ? `EXISTING SUMMARY:\n${t.previousSummary}\n\n${formatTranscript(t.messages)}`
      : formatTranscript(t.messages);

    // The summarizer samples, so the Tier-J verdict is a majority over
    // independent draws; MUST-PRESERVE stays strict on every draw.
    const diff: string[] = [];
    const drawPasses: boolean[] = [];
    const drawFactScores: number[] = [];
    const fabricationsPerDraw: number[] = [];
    for (let d = 0; d < SUMMARY_DRAWS_PER_TRANSCRIPT; d++) {
      const summary = await runCompaction(t, compactLlm, compactWindow);
      const drawDiff = mustPreserveDiff({ tokens, sourceText, summary });
      for (const tok of drawDiff) if (!diff.includes(tok)) diff.push(tok);

      // Judge calls are independent and their small rubric prompt is below the
      // provider's cacheable-prefix minimum, so unlike the draw loop (whose
      // first compact call must WRITE the cache before later draws read it)
      // there is no ordering to protect — run the 3 judges concurrently.
      const runs = await Promise.all(
        Array.from({ length: JUDGE_RUNS_PER_TRANSCRIPT }, () =>
          judgeOnce(judgeLlm, { transcript: judgeTranscript, facts: t.facts, summary }),
        ),
      );
      const verdict = tierJTranscriptVerdict(runs, t.facts.map((f) => f.id));
      drawPasses.push(verdict.pass);
      drawFactScores.push(verdict.medianFactScore);
      fabricationsPerDraw.push(verdict.medianFabrications);
    }
    if (diff.length > 0) anyFail = true;
    if (!drawsVerdict(drawPasses)) anyFail = true;

    rows.push({
      id: t.id,
      medianFactScore: median(drawFactScores),
      fabricationsPerDraw,
      passDraws: drawPasses.filter(Boolean).length,
      diff,
    });
  }

  // Cache exerciser — oversized synthetic pass forces >= 2 sequential compact
  // calls sharing one byte-identical system block.
  const ledgerBefore = readLedger(tempDir).length;
  const exTokens = ["FTP 262W", "sweet spot", "TTE"];
  const exMessages = exerciserMessages();
  const exResult = await summarizeInStages({
    messages: exMessages,
    llm: compactLlm,
    mustPreserveTokens: exTokens,
    memory: snapshotMemory({}),
    recentToKeep: 0,
    caller: "compact",
    contextWindowTokens: compactWindow,
  });
  const exSummary = stripSummaryPrefix(String(exResult.messages[0].content));
  const exLines = readLedger(tempDir)
    .slice(ledgerBefore)
    .filter((l) => l.kind === "generate" && l.caller === "compact");
  const exDiff = mustPreserveDiff({
    tokens: exTokens,
    sourceText: formatTranscript(exMessages),
    summary: exSummary,
  });
  if (exDiff.length > 0) anyFail = true;
  const evidence = cacheEvidence(exLines);
  if (!evidence.ok) anyFail = true;

  process.stdout.write("\ncompaction-gate report\n");
  process.stdout.write("=======================\n");
  for (const row of rows) {
    process.stdout.write(
      `${row.id.padEnd(16)} factScore=${row.medianFactScore.toFixed(2)} ` +
        `fabricationsPerDraw=${row.fabricationsPerDraw.join(",")} ` +
        `passDraws=${row.passDraws}/${SUMMARY_DRAWS_PER_TRANSCRIPT} ` +
        `mustPreserveDiff=${row.diff.length === 0 ? "empty" : row.diff.join("|")}\n`,
    );
  }
  const firstWrite = exLines[0]?.cacheWriteTokens ?? 0;
  const maxRead = Math.max(0, ...exLines.slice(1).map((l) => l.cacheReadTokens ?? 0));
  process.stdout.write(
    `exerciser        compactCalls=${exLines.length} ` +
      `firstCacheWriteTokens=${firstWrite} maxLaterCacheReadTokens=${maxRead} ` +
      `mustPreserveDiff=${exDiff.length === 0 ? "empty" : exDiff.join("|")} ` +
      `cacheEvidence=${evidence.ok ? "ok" : `FAIL(${evidence.reason})`}\n`,
  );

  const runDir = join(
    process.cwd(),
    ".tests",
    "runs",
    `${new Date().toISOString().replace(/:/g, "-")}-compaction-gate`,
  );
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "report.json"),
    JSON.stringify(
      { rows, exerciser: { compactCalls: exLines.length, firstWrite, maxRead, diff: exDiff, evidence } },
      null,
      2,
    ),
    "utf-8",
  );

  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  fail(2, err instanceof Error ? err.stack ?? err.message : String(err));
});
