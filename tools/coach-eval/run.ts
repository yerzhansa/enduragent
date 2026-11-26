import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCoachEngine } from "@enduragent/engine";
import { cyclingSport } from "@enduragent/sport-cycling";
import { CASES, type EvalCase } from "./cases.js";
import { evaluateTurn, type CheckResult, type TurnObservation } from "./checks.js";
import { buildAthleteFixture, type AthleteFixture } from "./fixture.js";
import { CHAT_IDS, CaseRecorder, createEvalPorts } from "./ports.js";
import { SpendMeter, USAGE, lineCostUsd, parseRunArgs, type RunOptions } from "./spend.js";

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
  readonly turns: readonly TurnReport[];
  readonly error?: string;
}

function fail(code: number, reason: string): never {
  process.stderr.write(`coach-eval: ${reason}\n`);
  process.exit(code);
}

function fixtureFor(evalCase: EvalCase, today: Date): AthleteFixture | "failing" | undefined {
  if (evalCase.data === "not-connected") return undefined;
  if (evalCase.data === "reads-failing") return "failing";
  return buildAthleteFixture(evalCase.data, today);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function checksStatus(turns: readonly TurnReport[]): CaseStatus {
  return turns.every((turn) => turn.checks.every((check) => check.pass)) ? "pass" : "fail";
}

async function runCase(
  evalCase: EvalCase,
  options: RunOptions,
  apiKey: string,
  meter: SpendMeter,
  today: Date,
): Promise<CaseReport> {
  const recorder = new CaseRecorder();
  const refusedBefore = meter.snapshot().refusedCalls;
  const harness = createEvalPorts({
    model: options.model,
    apiKey,
    fixture: fixtureFor(evalCase, today),
    recorder,
    meter,
  });
  const chatId = CHAT_IDS[evalCase.channel];
  const turns: TurnReport[] = [];
  let error: string | undefined;
  try {
    const engine = createCoachEngine({ sport: cyclingSport, ports: harness.ports });
    for (const turn of evalCase.turns) {
      recorder.startTurn();
      const response = await engine.chat({ chatId, message: turn.message });
      const observation = recorder.finishTurn(response.text, harness.gate.peek(chatId) !== undefined);
      turns.push({ message: turn.message, ...observation, checks: evaluateTurn(turn.expect, observation) });
    }
    await engine.settle?.();
  } catch (caught) {
    error = errorText(caught);
  } finally {
    harness.dispose();
  }
  const generateLines = recorder.usage.filter((line) => line.kind === "generate");
  const refused = meter.snapshot().refusedCalls > refusedBefore;
  return {
    id: evalCase.id,
    kind: evalCase.kind,
    channel: evalCase.channel,
    data: evalCase.data,
    status: refused ? "stopped" : error !== undefined ? "error" : checksStatus(turns),
    costUsd: generateLines.reduce((sum, line) => sum + (lineCostUsd(line) ?? 0), 0),
    modelCalls: generateLines.length,
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
    turns: [],
    error: reason,
  };
}

function printCase(report: CaseReport): void {
  const label = report.status.toUpperCase().padEnd(7);
  process.stdout.write(
    `${label} ${report.id.padEnd(28)} $${report.costUsd.toFixed(4)}  ${report.modelCalls} call(s)\n`,
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
  const today = new Date();
  const startedAt = today.toISOString();
  process.stdout.write(
    `coach-eval: ${cases.length} case(s) on ${options.model}, spend limit $${options.maxUsd.toFixed(2)}\n\n`,
  );

  const reports: CaseReport[] = [];
  for (const evalCase of cases) {
    const stopReason = meter.stopReason();
    const report =
      stopReason === undefined
        ? await runCase(evalCase, options, apiKey, meter, today)
        : skippedCase(evalCase, stopReason);
    reports.push(report);
    printCase(report);
  }

  const spend = meter.snapshot();
  const count = (status: CaseStatus) => reports.filter((report) => report.status === status).length;
  const passed = count("pass");
  const summary = {
    total: reports.length,
    passed,
    failed: count("fail"),
    errored: count("error"),
    stopped: count("stopped"),
    skipped: count("skipped"),
    passRate: reports.length === 0 ? 0 : passed / reports.length,
  };
  process.stdout.write(
    `\npass rate ${passed}/${summary.total} (${Math.round(summary.passRate * 100)}%)\n` +
      `cost $${spend.spentUsd.toFixed(4)} of $${spend.limitUsd.toFixed(2)} ` +
      `(${spend.pricedCalls} priced call(s), ${spend.unpricedCalls} unpriced, ` +
      `${spend.failedCalls} failed, ${spend.refusedCalls} refused by the limit)\n`,
  );
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
