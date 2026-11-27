import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCoachEngine } from "@enduragent/engine";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CASES, RUNS_PER_KIND, type EvalCase } from "./cases.js";
import { evaluateTurn, type CheckResult } from "./checks.js";
import { createJudge, judgeRun, type Judge } from "./judge.js";
import { CHAT_IDS, CaseRecorder, createEvalPorts, evalDataFor } from "./ports.js";
import {
  caseStatus,
  completedRunStatus,
  mergeTurns,
  newRunDir,
  printCase,
  printSummary,
  recheckReport,
  summarize,
  writeReport,
  type CaseReport,
  type EvalReport,
  type JudgeReport,
  type RunReport,
  type TurnReport,
} from "./report.js";
import {
  SpendMeter,
  USAGE,
  lineCost,
  parseRunArgs,
  type LiveRunOptions,
} from "./spend.js";

const write = (text: string): void => {
  process.stdout.write(text);
};

function fail(code: number, reason: string): never {
  process.stderr.write(`coach-eval: ${reason}\n`);
  process.exit(code);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

interface RunContext {
  readonly options: LiveRunOptions;
  readonly apiKey: string;
  readonly meter: SpendMeter;
  readonly judge: Judge | undefined;
}

async function runTurns(
  evalCase: EvalCase,
  context: RunContext,
  recorder: CaseRecorder,
  turns: TurnReport[],
): Promise<void> {
  const today = new Date();
  const harness = createEvalPorts({
    model: context.options.model,
    apiKey: context.apiKey,
    data: evalDataFor(evalCase, today),
    today,
    recorder,
    meter: context.meter,
  });
  const chatId = CHAT_IDS[evalCase.channel];
  try {
    const engine = createCoachEngine({ sport: cyclingSport, ports: harness.ports });
    try {
      for (const turn of evalCase.turns) {
        recorder.startTurn();
        const response = await engine.chat({ chatId, message: turn.message });
        const observation = recorder.finishTurn(response.text, harness.gate.peek(chatId));
        turns.push({ message: turn.message, ...observation, checks: evaluateTurn(turn.expect, observation) });
      }
    } finally {
      await engine.settle?.();
    }
  } finally {
    harness.dispose();
  }
}

function judgeCost(judge: Judge | undefined, from: number): number {
  return (judge?.usage ?? [])
    .slice(from)
    .filter((line) => line.kind === "generate")
    .reduce((sum, line) => sum + (lineCost(line)?.usd ?? 0), 0);
}

async function runOnce(evalCase: EvalCase, context: RunContext): Promise<RunReport> {
  const recorder = new CaseRecorder();
  const refusedBefore = context.meter.snapshot().refusedCalls;
  const judgeUsageBefore = context.judge?.usage.length ?? 0;
  const turns: TurnReport[] = [];
  let error: string | undefined;
  let acrossTurns: CheckResult[] = [];
  let judge: JudgeReport | undefined;
  try {
    await runTurns(evalCase, context, recorder, turns);
    acrossTurns = evaluateTurn(evalCase.expectAcrossTurns ?? [], mergeTurns(turns));
    judge = await judgeRun({
      question: evalCase.judgeQuestion,
      injection: evalCase.injection,
      judge: context.judge,
      judgeModel: context.options.judgeModel,
      turns: turns.map((turn) => ({ message: turn.message, observation: turn })),
      checks: [...turns.flatMap((turn) => turn.checks), ...acrossTurns],
    });
  } catch (caught) {
    error = errorText(caught);
  }
  const generateLines = recorder.usage.filter((line) => line.kind === "generate");
  const stopped = context.meter.snapshot().refusedCalls > refusedBefore;
  return {
    status: stopped ? "stopped" : error !== undefined ? "error" : completedRunStatus(turns, acrossTurns, judge),
    turns,
    acrossTurns,
    ...(judge === undefined ? {} : { judge }),
    coachCostUsd: generateLines.reduce((sum, line) => sum + (lineCost(line)?.usd ?? 0), 0),
    judgeCostUsd: judgeCost(context.judge, judgeUsageBefore),
    modelCalls: generateLines.length,
    modelSteps: generateLines.reduce((sum, line) => sum + (line.steps ?? 0), 0),
    ...(error === undefined ? {} : { error }),
  };
}

function skippedRun(reason: string): RunReport {
  return {
    status: "skipped",
    turns: [],
    acrossTurns: [],
    coachCostUsd: 0,
    judgeCostUsd: 0,
    modelCalls: 0,
    modelSteps: 0,
    error: reason,
  };
}

async function runCase(evalCase: EvalCase, context: RunContext): Promise<CaseReport> {
  const runs: RunReport[] = [];
  for (let index = 0; index < RUNS_PER_KIND[evalCase.kind]; index++) {
    const reason = context.meter.stopReason();
    runs.push(reason === undefined ? await runOnce(evalCase, context) : skippedRun(reason));
  }
  return {
    id: evalCase.id,
    kind: evalCase.kind,
    channel: evalCase.channel,
    data: evalCase.data,
    status: caseStatus(runs),
    costUsd: runs.reduce((sum, run) => sum + run.coachCostUsd + run.judgeCostUsd, 0),
    runs,
  };
}

function selectCases(caseIds: readonly string[]): readonly EvalCase[] {
  if (caseIds.length === 0) return CASES;
  const unknown = caseIds.filter((id) => !CASES.some((evalCase) => evalCase.id === id));
  if (unknown.length > 0) fail(2, `unknown case id(s): ${unknown.join(", ")}`);
  return CASES.filter((evalCase) => caseIds.includes(evalCase.id));
}

function recheck(reportPath: string): never {
  const original = JSON.parse(readFileSync(reportPath, "utf-8")) as EvalReport;
  const report = recheckReport(original, CASES, new Date());
  for (const caseReport of report.cases) printCase(caseReport, write);
  printSummary(report, write);
  const outPath = join(dirname(reportPath), "report.recheck.json");
  writeReport(report, outPath);
  write(`rechecked report ${outPath}\n`);
  process.exit(report.summary.passed === report.summary.total ? 0 : 1);
}

async function main(): Promise<void> {
  const parsed = parseRunArgs(process.argv.slice(2));
  if (!parsed.ok) fail(2, `${parsed.message}\n${USAGE}`);
  if (parsed.options.mode === "recheck") recheck(parsed.options.reportPath);
  const options = parsed.options;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    fail(2, "OPENROUTER_API_KEY is not set; put it in the repository's .env or the environment");
  }
  const cases = selectCases(options.caseIds);
  const meter = new SpendMeter(options.maxUsd);
  const judge = cases.some((evalCase) => evalCase.judgeQuestion !== undefined)
    ? createJudge({ model: options.judgeModel, apiKey, meter })
    : undefined;
  const startedAt = new Date().toISOString();
  write(
    `coach-eval: ${cases.length} case(s) on ${options.model}, judge ${options.judgeModel}, ` +
      `spend limit $${options.maxUsd.toFixed(2)}\n\n`,
  );
  const context: RunContext = { options, apiKey, meter, judge };
  const reports: CaseReport[] = [];
  try {
    for (const evalCase of cases) {
      const report = await runCase(evalCase, context);
      reports.push(report);
      printCase(report, write);
    }
  } finally {
    judge?.dispose();
  }
  const spend = meter.snapshot();
  const stopReason = meter.stopReason();
  const report: EvalReport = {
    model: options.model,
    judgeModel: options.judgeModel,
    startedAt,
    finishedAt: new Date().toISOString(),
    spend,
    ...(stopReason === undefined ? {} : { stopReason }),
    costIsLowerBound: spend.failedCalls > 0,
    summary: summarize(reports),
    cases: reports,
  };
  printSummary(report, write);
  const reportPath = join(newRunDir(startedAt), "report.json");
  writeReport(report, reportPath);
  write(`report ${reportPath}\n`);
  process.exit(report.summary.passed === report.summary.total ? 0 : 1);
}

main().catch((error: unknown) => {
  fail(2, error instanceof Error ? (error.stack ?? error.message) : String(error));
});
