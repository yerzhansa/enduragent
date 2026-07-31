import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SYSTEM_PROMPT_CACHE_BOUNDARY, ATHLETE_CONTEXT_FENCE_OPEN } from "../../packages/core/src/agent/system-prompt.js";
import { cacheTokenDetails } from "../../packages/core/src/usage-ledger.js";

import {
  FLOOR_MODELS,
  JUDGED_TURNS_PER_MODEL,
  PROBE_FROZEN_NOW_ISO,
  STEP_LIMIT,
} from "./constants.js";
import { buildMockPrompt } from "./assemble.js";
import { MOCK_TOOLS, buildToolSet } from "./tools.js";
import { evalNeedles } from "./needles.js";
import { redactTrademarks } from "./redact.js";
import { runTokensPhase } from "./tokens.js";
import { runJudgePass } from "./judge.js";
import { scanProbeOutputs } from "./scan.js";
import { renderReport, parseSpotCheck, ReportRefusal } from "./report.js";
import { ALL_SCENARIOS } from "./scenarios/index.js";
import {
  ABORT_SPOT_CHECK_MD,
  EMPTY_SPOT_CHECK_MD,
  NEEDLE_CLEAN_TEXT,
  NEEDLE_FORBIDDEN_SCENARIO,
  NEEDLE_FORBIDDEN_TEXT,
  NEEDLE_REQUIRED_MISS_SCENARIO,
  NEEDLE_REQUIRED_MISS_TEXT,
  RECALL_HIT_LINE,
  RECALL_MISS_LINE,
  RECALL_WRONG_SPORT_LINE,
  REDACT_SAMPLE_RAW,
  REDACT_STANDALONE_IF,
  REDACT_TSS,
  TAPER_KNOWN_FACT,
  abortReportInput,
  reworkReportInput,
} from "./dryrun-fixtures.js";
import type { ProbeScenario, StopFn, TranscriptLine } from "./types.js";

function probesDir(): string {
  return fileURLToPath(new URL("../../probes/composition-smoke", import.meta.url));
}

function recallHit(line: TranscriptLine, targetSport: string): boolean {
  return line.toolCalls.some(
    (t) => t.toolName === "skill_read" && String((t.input as { sport?: unknown } | null)?.sport ?? "") === targetSport,
  );
}

function runDryRun(): number {
  const results: boolean[] = [];

  // CHECK 1 — assembly
  const { block1, block2, fullSystem } = buildMockPrompt();
  const markerText = SYSTEM_PROMPT_CACHE_BOUNDARY.replace(/^\n\n---\n\n/, "");
  const c1 =
    block1.includes("# Endurance Coach") &&
    block1.includes("## Cycling") &&
    block1.includes("## Running") &&
    block1.includes("## Swimming") &&
    block1.includes("# Untrusted Data Handling") &&
    block1.includes("# Recall Before Answering") &&
    block1.includes("# Voice & Register") &&
    block1.includes("# Workout Review") &&
    block1.includes("# Tool-Call Budget") &&
    block1.includes("activities_list") &&
    !block1.includes("intervals_fetch_activities") &&
    block2.split("\n")[0] === markerText &&
    !block1.includes(ATHLETE_CONTEXT_FENCE_OPEN) &&
    fullSystem === buildMockPrompt().fullSystem;
  results.push(c1);

  // CHECK 2 — tools
  const set = buildToolSet(() => {});
  const names = Object.keys(set);
  const skillSpec = MOCK_TOOLS.find((t) => t.name === "skill_read");
  const taper = skillSpec?.makeResult({ sport: "cycling", topic: "taper" }) as { content?: string };
  const unknown = skillSpec?.makeResult({ sport: "cycling", topic: "nope" }) as { error?: string; available?: unknown };
  const c8Ids = ALL_SCENARIOS.filter((s) => s.class === "c8-tool-choice");
  const toolsExist = c8Ids.every((s) => (s.expectedTools ?? []).every((n) => n === "<none>" || names.includes(n)));
  const c2 =
    names.length === 25 &&
    new Set(names).size === 25 &&
    toolsExist &&
    typeof taper?.content === "string" &&
    taper.content.includes(TAPER_KNOWN_FACT) &&
    unknown?.error === "unknown_topic" &&
    Array.isArray(unknown.available);
  results.push(c2);

  // CHECK 3 — needle engine (breakable via PROBE_DRYRUN_BREAK_NEEDLES=1)
  const broken = process.env.PROBE_DRYRUN_BREAK_NEEDLES === "1";
  const forbiddenText = broken ? NEEDLE_CLEAN_TEXT : NEEDLE_FORBIDDEN_TEXT;
  const forbiddenFlagged = evalNeedles(NEEDLE_FORBIDDEN_SCENARIO, forbiddenText).some((h) => h.kind === "forbidden");
  const cleanIsClean = !evalNeedles(NEEDLE_FORBIDDEN_SCENARIO, NEEDLE_CLEAN_TEXT).some((h) => h.kind === "forbidden");
  const missFlagged = evalNeedles(NEEDLE_REQUIRED_MISS_SCENARIO, NEEDLE_REQUIRED_MISS_TEXT).some(
    (h) => h.kind === "required-miss",
  );
  const c3 = forbiddenFlagged && cleanIsClean && missFlagged;
  results.push(c3);

  // CHECK 4 — recall scorer
  const c4 =
    !recallHit(RECALL_MISS_LINE, "cycling") &&
    recallHit(RECALL_HIT_LINE, "cycling") &&
    !recallHit(RECALL_WRONG_SPORT_LINE, "cycling");
  results.push(c4);

  // CHECK 5 — report renderer
  const scratch = mkdtempSync(join(tmpdir(), "probe-dryrun-"));
  const abortRows = parseSpotCheck(ABORT_SPOT_CHECK_MD);
  const reworkRows = parseSpotCheck(EMPTY_SPOT_CHECK_MD);
  const abortReport = renderReport({ ...abortReportInput(), spotCheckRows: abortRows });
  const reworkReport = renderReport({ ...reworkReportInput(), spotCheckRows: reworkRows });
  writeFileSync(join(scratch, "abort-report.md"), abortReport, "utf-8");
  writeFileSync(join(scratch, "rework-report.md"), reworkReport, "utf-8");
  const sectionsOk = ["## M1", "## M2", "## M3", "## M4", "## Verdict"].every((s) => abortReport.includes(s));
  const noPending = !abortReport.includes("PENDING") && !reworkReport.includes("PENDING");
  const abortVerdict = /(^|\n)ABORT-PREMISE(\n|$)/.test(abortReport);
  const reworkVerdict = /(^|\n)REWORK-LAYOUT(\n|$)/.test(reworkReport);
  const c5 = sectionsOk && noPending && abortVerdict && reworkVerdict;
  results.push(c5);

  // CHECK 6 — redactor + needle-on-raw order
  const rawRanFirst = evalNeedles(NEEDLE_FORBIDDEN_SCENARIO, REDACT_SAMPLE_RAW).some((h) => h.kind === "forbidden");
  const { text: redacted, count } = redactTrademarks(REDACT_SAMPLE_RAW);
  const c6 =
    rawRanFirst &&
    count > 0 &&
    !redacted.includes(REDACT_TSS) &&
    redacted.includes("[Load]") &&
    redacted.includes(REDACT_STANDALONE_IF);
  results.push(c6);

  results.forEach((ok, i) => console.log(`CHECK ${i + 1}/6 ${ok ? "PASS" : "FAIL"}`));
  return results.every(Boolean) ? 0 : 1;
}

function envKeyFor(provider: string): string | undefined {
  return provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENROUTER_API_KEY;
}

async function subjectLine(
  scenario: ProbeScenario,
  fullSystem: string,
  floor: { provider: string; model: string; slug: string },
  apiKey: string,
): Promise<TranscriptLine> {
  const calls: Array<{ toolName: string; input: unknown }> = [];
  const tools = buildToolSet((c) => calls.push(c));
  const stop: StopFn = ({ steps }: { steps: unknown[] }) => steps.length >= STEP_LIMIT;
  const { LLM } = await import("../../packages/core/src/llm.js");
  const scratch = mkdtempSync(join(tmpdir(), "probe-run-"));
  const llm = new LLM({
    llm: { provider: floor.provider, model: floor.model, apiKey, baseUrl: undefined },
    dataDir: scratch,
  } as unknown as import("../../packages/core/src/config.js").Config);

  const start = Date.now();
  try {
    const res = await llm.generate({
      system: fullSystem,
      messages: [{ role: "user", content: scenario.userMessage + "\nCurrent time: " + PROBE_FROZEN_NOW_ISO }],
      tools,
      stopWhen: stop,
      maxOutputTokens: 2048,
      caller: "chat",
    });
    const rawText = res.text;
    const needleHits = evalNeedles(scenario, rawText);
    const { text: assistantText, count } = redactTrademarks(rawText);
    return {
      scenarioId: scenario.id,
      class: scenario.class,
      model: floor.model,
      provider: floor.provider,
      userMessage: scenario.userMessage,
      assistantText,
      toolCalls: calls,
      steps: res.steps ?? 0,
      usage: {
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
        cacheReadTokens: cacheTokenDetails(res.totalUsage)?.cacheReadTokens,
      },
      durationMs: Date.now() - start,
      needleHits,
      flagged: needleHits.length > 0,
      trademarkRedactions: count,
    };
  } catch (err) {
    return {
      scenarioId: scenario.id,
      class: scenario.class,
      model: floor.model,
      provider: floor.provider,
      userMessage: scenario.userMessage,
      assistantText: "",
      toolCalls: calls,
      steps: 0,
      usage: {},
      durationMs: Date.now() - start,
      needleHits: [],
      flagged: true,
      trademarkRedactions: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runSubjectPhase(modelId: string): Promise<number> {
  const floor = FLOOR_MODELS.find((m) => m.model === modelId);
  if (!floor) {
    console.error(`--model=${modelId} is not a pinned floor model. The floor is pinned; re-pinning is an operator procedure.`);
    return 2;
  }
  const apiKey = envKeyFor(floor.provider);
  if (!apiKey) {
    console.error(`missing ${floor.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY"} for the run phase.`);
    return 2;
  }
  const { fullSystem } = buildMockPrompt();
  const lines: TranscriptLine[] = [];
  let errorCount = 0;
  for (const scenario of ALL_SCENARIOS) {
    const line = await subjectLine(scenario, fullSystem, floor, apiKey);
    lines.push(line);
    if (line.error) errorCount += 1;
    if (errorCount >= 5) {
      const dir = probesDir();
      mkdirSync(join(dir, "transcripts"), { recursive: true });
      const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + JSON.stringify({ INCOMPLETE: true }) + "\n";
      writeFileSync(join(dir, "transcripts", `${floor.slug}.jsonl`), body, "utf-8");
      console.error(`run aborted: ${errorCount} errored turns for ${floor.slug}. Partial transcript kept, marked INCOMPLETE.`);
      return 2;
    }
  }
  const dir = probesDir();
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  writeFileSync(join(dir, "transcripts", `${floor.slug}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  console.log(`wrote ${lines.length} turns for ${floor.slug}`);
  return 0;
}

async function runJudgePhase(modelId: string): Promise<number> {
  const floor = FLOOR_MODELS.find((m) => m.model === modelId);
  if (!floor) {
    console.error(`--model=${modelId} is not a pinned floor model.`);
    return 2;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("missing ANTHROPIC_API_KEY for the judge phase.");
    return 2;
  }
  const file = join(probesDir(), "transcripts", `${floor.slug}.jsonl`);
  if (!existsSync(file)) {
    console.error(`missing transcript ${file}; run --phase=run --model=${modelId} first.`);
    return 2;
  }
  return runJudgePass(file, apiKey);
}

function runScanPhase(): number {
  const dir = probesDir();
  const { hits, missing } = scanProbeOutputs(dir);
  if (missing.length > 0) {
    console.error("scan: missing inputs: " + missing.join(", "));
    return 2;
  }
  if (hits.length > 0) {
    console.error(`scan: ${hits.length} hit(s):`);
    for (const h of hits) console.error(`  ${h.file}:${h.line} [${h.rule}] ${h.excerpt}`);
    return 2;
  }
  console.log("scan: clean.");
  return 0;
}

function readTranscript(dir: string, slug: string): TranscriptLine[] {
  return readFileSync(join(dir, "transcripts", `${slug}.jsonl`), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0 && !l.includes('"INCOMPLETE"'))
    .map((l) => JSON.parse(l) as TranscriptLine);
}

function runReportPhase(): number {
  const dir = probesDir();

  const scan = scanProbeOutputs(dir);
  if (scan.missing.length > 0) {
    console.error("report: scan missing inputs: " + scan.missing.join(", "));
    return 2;
  }
  if (scan.hits.length > 0) {
    console.error(`report: scan found ${scan.hits.length} hit(s); refusing to render.`);
    for (const h of scan.hits) console.error(`  ${h.file}:${h.line} [${h.rule}] ${h.excerpt}`);
    return 2;
  }

  const missing: string[] = [];
  for (const m of FLOOR_MODELS) {
    if (!existsSync(join(dir, "transcripts", `${m.slug}.jsonl`))) missing.push(`transcripts/${m.slug}.jsonl`);
  }
  if (!existsSync(join(dir, "tokens.json"))) missing.push("tokens.json");
  if (!existsSync(join(dir, "spot-check.md"))) missing.push("spot-check.md");
  if (missing.length > 0) {
    console.error("report: missing inputs: " + missing.join(", "));
    return 2;
  }

  const transcripts: Record<string, TranscriptLine[]> = {};
  for (const m of FLOOR_MODELS) transcripts[m.slug] = readTranscript(dir, m.slug);

  for (const m of FLOOR_MODELS) {
    const count = transcripts[m.slug].length;
    if (count !== JUDGED_TURNS_PER_MODEL) {
      console.error(
        `report: refused — transcript ${m.slug}.jsonl has ${count} judged turns, expected ${JUDGED_TURNS_PER_MODEL}; re-run --phase=run --model=${m.model} for this model.`,
      );
      return 2;
    }
  }

  const tokens = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf-8"));
  try {
    const spotCheckRows = parseSpotCheck(readFileSync(join(dir, "spot-check.md"), "utf-8"));
    const md = renderReport({
      runDate: new Date().toISOString().slice(0, 10),
      tokens,
      transcripts,
      spotCheckRows,
    });
    writeFileSync(join(dir, "report.md"), md + "\n", "utf-8");
    console.log("report: rendered report.md");
    return 0;
  } catch (err) {
    if (err instanceof ReportRefusal) {
      console.error("report: refused — " + err.message);
      return 2;
    }
    throw err;
  }
}

function parseArgs(argv: string[]): { mode: string; model?: string } {
  let mode = "";
  let model: string | undefined;
  for (const a of argv) {
    if (a === "--dry-run") mode = "dry-run";
    else if (a.startsWith("--phase=")) mode = a.slice("--phase=".length);
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
  }
  return { mode, model };
}

async function main(argv: string[]): Promise<number> {
  const { mode, model } = parseArgs(argv);
  switch (mode) {
    case "dry-run":
      return runDryRun();
    case "tokens": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error("missing ANTHROPIC_API_KEY for the tokens phase.");
        return 2;
      }
      return runTokensPhase(probesDir(), apiKey);
    }
    case "run":
      if (!model) {
        console.error("--phase=run requires --model=<floor id>");
        return 2;
      }
      return runSubjectPhase(model);
    case "judge":
      if (!model) {
        console.error("--phase=judge requires --model=<floor id>");
        return 2;
      }
      return runJudgePhase(model);
    case "scan":
      return runScanPhase();
    case "report":
      return runReportPhase();
    default:
      console.error("usage: probe:composition --dry-run | --phase=tokens|run|judge|scan|report [--model=<floor id>]");
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
