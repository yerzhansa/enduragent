import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCoachEngine } from "@enduragent/engine";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CASES, type EvalCase } from "./cases.js";
import { evaluateTurn, type CheckResult, type TurnObservation } from "./checks.js";
import { buildStoreFixture, type StoreFixture } from "./fixture.js";
import { CHAT_IDS, CaseRecorder, createEvalPorts } from "./ports.js";
import { SpendMeter, USAGE, lineCost, parseRunArgs, type RunOptions } from "./spend.js";

type CaseStatus = "pass" | "fail" | "error" | "stopped" | "skipped";

interface TurnReport extends TurnObservation {
  readonly message: string;
  readonly checks: readonly CheckResult[];
}

interface CaseReport {
  readonly id: string;
  readonly kind: EvalCase["kind"];
  readonly channel: EvalCase["channel"];
  readonly data: EvalCase["data"];
  readonly status: CaseStatus;
  readonly costUsd: number;
  readonly modelCalls: number;
  readonly modelSteps: number;
  readonly turns: readonly TurnReport[];
  readonly error?: string;
}

function fail(code: number, reason: string): never {
  process.stderr.write(`coach-eval: ${reason}\n`);
  process.exit(code);
}

function fixtureFor(evalCase: EvalCase, today: Date): StoreFixture | "failing" | undefined {
  if (evalCase.data === "not-connected") return undefined;
  if (evalCase.data === "reads-failing") return "failing";
  return buildStoreFixture(evalCase.data, today);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function checksStatus(turns: readonly TurnReport[]): CaseStatus {
  return turns.every((turn) => turn.checks.every((check) => check.pass)) ? "pass" : "fail";
}

async function runTurns(
  evalCase: EvalCase,
  options: RunOptions,
  apiKey: string,
  meter: SpendMeter,
  recorder: CaseRecorder,
  turns: TurnReport[],
): Promise<void> {
  const harness = createEvalPorts({
    model: options.model,
    apiKey,
    fixture: fixtureFor(evalCase, new Date()),
    recorder,
    meter,
  });
  const chatId = CHAT_IDS[evalCase.channel];
  try {
    const engine = createCoachEngine({ sport: cyclingSport, ports: harness.ports });
    try {
      for (const turn of evalCase.turns) {
        recorder.startTurn();
        const response = await engine.chat({ chatId, message: turn.message });
        const observation = recorder.finishTurn(response.text, harness.gate.peek(chatId) !== undefined);
        turns.push({ message: turn.message, ...observation, checks: evaluateTurn(turn.expect, observation) });
      }
    } finally {
      await engine.settle?.();
    }
  } finally {
    harness.dispose();
  }
}

async function runCase(
  evalCase: EvalCase,
  options: RunOptions,
  apiKey: string,
  meter: SpendMeter,
): Promise<CaseReport> {
  const recorder = new CaseRecorder();
  const refusedBefore = meter.snapshot().refusedCalls;
  const turns: TurnReport[] = [];
  let error: string | undefined;
  try {
    await runTurns(evalCase, options, apiKey, meter, recorder, turns);
  } catch (caught) {
    error = errorText(caught);
  }
  const generateLines = recorder.usage.filter((line) => line.kind === "generate");
  const refused = meter.snapshot().refusedCalls > refusedBefore;
  return {
    id: evalCase.id,
    kind: evalCase.kind,
    channel: evalCase.channel,
    data: evalCase.data,
    status: refused ? "stopped" : error !== undefined ? "error" : checksStatus(turns),
    costUsd: generateLines.reduce((sum, line) => sum + (lineCost(line)?.usd ?? 0), 0),
    modelCalls: generateLines.length,
    modelSteps: generateLines.reduce((sum, line) => sum + (line.steps ?? 0), 0),
    turns,
    ...(error === undefined ? {} : { error }),
  };
}

function skippedCase(evalCase: EvalCase, reason: string): CaseReport {
  return {
    id: evalCase.id,
    kind: evalCase.kind,
    channel: evalCase.channel,
    data: evalCase.data,
    status: "skipped",
    costUsd: 0,
    modelCalls: 0,
    modelSteps: 0,
    turns: [],
    error: reason,
  };
}

function printCase(report: CaseReport): void {
  const label = report.status.toUpperCase().padEnd(7);
  process.stdout.write(
    `${label} ${report.id.padEnd(28)} $${report.costUsd.toFixed(4)}  ` +
      `${report.modelCalls} call(s), ${report.modelSteps} step(s)\n`,
  );
  for (const turn of report.turns) {
    for (const check of turn.checks.filter((item) => !item.pass)) {
      process.stdout.write(`        ✗ ${check.expectation} (${check.detail})\n`);
    }
  }
  if (report.error !== undefined) process.stdout.write(`        ${report.error}\n`);
}

function selectCases(caseIds: readonly string[]): readonly EvalCase[] {
  if (caseIds.length === 0) return CASES;
  const unknown = caseIds.filter((id) => !CASES.some((evalCase) => evalCase.id === id));
  if (unknown.length > 0) fail(2, `unknown case id(s): ${unknown.join(", ")}`);
  return CASES.filter((evalCase) => caseIds.includes(evalCase.id));
}

async function main(): Promise<void> {
  const parsed = parseRunArgs(process.argv.slice(2));
  if (!parsed.ok) fail(2, `${parsed.message}\n${USAGE}`);
  const options = parsed.options;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    fail(2, "OPENROUTER_API_KEY is not set; put it in the repository's .env or the environment");
  }
  const cases = selectCases(options.caseIds);
  const meter = new SpendMeter(options.maxUsd);
  const startedAt = new Date().toISOString();
  process.stdout.write(
    `coach-eval: ${cases.length} case(s) on ${options.model}, spend limit $${options.maxUsd.toFixed(2)}\n\n`,
  );

  const reports: CaseReport[] = [];
  for (const evalCase of cases) {
    const reason = meter.stopReason();
    const report =
      reason === undefined
        ? await runCase(evalCase, options, apiKey, meter)
        : skippedCase(evalCase, reason);
    reports.push(report);
    printCase(report);
  }

  const spend = meter.snapshot();
  const count = (status: CaseStatus) => reports.filter((report) => report.status === status).length;
  const passed = count("pass");
  const completed = passed + count("fail");
  const summary = {
    total: reports.length,
    completed,
    passed,
    failed: count("fail"),
    errored: count("error"),
    stopped: count("stopped"),
    skipped: count("skipped"),
    passRate: reports.length === 0 ? 0 : passed / reports.length,
    passRateOfCompleted: completed === 0 ? 0 : passed / completed,
  };
  process.stdout.write(
    `\npass rate ${passed}/${summary.total} (${Math.round(summary.passRate * 100)}%); ` +
      `${passed}/${completed} of the cases that ran to the end\n` +
      `cost $${spend.spentUsd.toFixed(4)} of $${spend.limitUsd.toFixed(2)} ` +
      `(${spend.providerPricedCalls} call(s) priced by the provider, ${spend.catalogPricedCalls} from the catalog, ` +
      `${spend.unpricedCalls} unpriced, ${spend.failedCalls} failed, ${spend.refusedCalls} refused)\n`,
  );
  const stopReason = meter.stopReason();
  if (stopReason !== undefined) process.stdout.write(`run stopped: ${stopReason}\n`);
  if (spend.failedCalls > 0) {
    process.stdout.write("failed model calls leave no cost row, so the cost is a lower bound\n");
  }

  const runDir = join(process.cwd(), ".tests", "runs", `${startedAt.replace(/:/g, "-")}-coach-eval`);
  mkdirSync(runDir, { recursive: true });
  const reportPath = join(runDir, "report.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        model: options.model,
        startedAt,
        finishedAt: new Date().toISOString(),
        spend,
        ...(stopReason === undefined ? {} : { stopReason }),
        costIsLowerBound: spend.failedCalls > 0,
        summary,
        cases: reports,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  process.stdout.write(`report ${reportPath}\n`);
  process.exit(passed === summary.total ? 0 : 1);
}

main().catch((error: unknown) => {
  fail(2, error instanceof Error ? (error.stack ?? error.message) : String(error));
});
