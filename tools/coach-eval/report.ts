import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseKind, EvalCase } from "./cases.js";
import { evaluateTurn, type CheckResult, type TurnObservation } from "./checks.js";
import type { JudgeVerdict } from "./judge.js";
import type { SpendSnapshot } from "./spend.js";

export type RunStatus = "pass" | "fail" | "error" | "stopped" | "skipped";

export interface TurnReport extends TurnObservation {
  readonly message: string;
  readonly checks: readonly CheckResult[];
}

export interface JudgeReport {
  readonly question: string;
  readonly model: string;
  readonly status: "answered" | "skipped" | "error";
  readonly pass: boolean;
  readonly verdict?: JudgeVerdict;
  readonly detail?: string;
}

export interface RunReport {
  readonly status: RunStatus;
  readonly turns: readonly TurnReport[];
  readonly acrossTurns: readonly CheckResult[];
  readonly judge?: JudgeReport;
  readonly coachCostUsd: number;
  readonly judgeCostUsd: number;
  readonly modelCalls: number;
  readonly modelSteps: number;
  readonly error?: string;
}

export interface CaseReport {
  readonly id: string;
  readonly kind: CaseKind;
  readonly channel: EvalCase["channel"];
  readonly data: EvalCase["data"];
  readonly status: RunStatus;
  readonly costUsd: number;
  readonly runs: readonly RunReport[];
}

export interface KindSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly stopped: number;
  readonly skipped: number;
}

export interface RunSummary extends KindSummary {
  readonly completed: number;
  readonly passRate: number;
  readonly passRateOfCompleted: number;
  readonly byKind: Readonly<Record<CaseKind, KindSummary>>;
}

export interface EvalReport {
  readonly model: string;
  readonly judgeModel: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly spend: SpendSnapshot;
  readonly stopReason?: string;
  readonly costIsLowerBound: boolean;
  readonly summary: RunSummary;
  readonly cases: readonly CaseReport[];
  readonly recheckedAt?: string;
}

export function mergeTurns(turns: readonly TurnObservation[]): TurnObservation {
  const last = turns.at(-1);
  return {
    reply: last?.reply ?? "",
    offeredTools: Array.from(new Set(turns.flatMap((turn) => turn.offeredTools))),
    attempts: turns.flatMap((turn) => turn.attempts),
    results: turns.flatMap((turn) => turn.results),
    proposals: turns.flatMap((turn) => turn.proposals),
    pendingProposal: last?.pendingProposal ?? false,
    approvalCodes: Array.from(new Set(turns.flatMap((turn) => turn.approvalCodes))),
    writes: turns.flatMap((turn) => turn.writes),
  };
}

export function checksPass(turns: readonly TurnReport[], acrossTurns: readonly CheckResult[]): boolean {
  return turns.every((turn) => turn.checks.every((check) => check.pass)) && acrossTurns.every((check) => check.pass);
}

export function completedRunStatus(
  turns: readonly TurnReport[],
  acrossTurns: readonly CheckResult[],
  judge: JudgeReport | undefined,
): RunStatus {
  if (judge?.status === "error") return "error";
  if (!checksPass(turns, acrossTurns)) return "fail";
  return judge === undefined || judge.pass ? "pass" : "fail";
}

export function caseStatus(runs: readonly RunReport[]): RunStatus {
  if (runs.some((run) => run.status === "fail")) return "fail";
  if (runs.length > 0 && runs.every((run) => run.status === "skipped")) return "skipped";
  if (runs.some((run) => run.status === "stopped" || run.status === "skipped")) return "stopped";
  if (runs.some((run) => run.status === "error")) return "error";
  return runs.length === 0 ? "skipped" : "pass";
}

function kindSummary(cases: readonly CaseReport[]): KindSummary {
  const count = (status: RunStatus) => cases.filter((report) => report.status === status).length;
  return {
    total: cases.length,
    passed: count("pass"),
    failed: count("fail"),
    errored: count("error"),
    stopped: count("stopped"),
    skipped: count("skipped"),
  };
}

export function summarize(cases: readonly CaseReport[]): RunSummary {
  const all = kindSummary(cases);
  const completed = all.passed + all.failed;
  return {
    ...all,
    completed,
    passRate: all.total === 0 ? 0 : all.passed / all.total,
    passRateOfCompleted: completed === 0 ? 0 : all.passed / completed,
    byKind: {
      code: kindSummary(cases.filter((report) => report.kind === "code")),
      safety: kindSummary(cases.filter((report) => report.kind === "safety")),
    },
  };
}

export function printCase(report: CaseReport, write: (text: string) => void): void {
  const runs = report.runs.length > 1
    ? ` ${report.runs.filter((run) => run.status === "pass").length}/${report.runs.length} runs passed,`
    : "";
  const calls = report.runs.reduce((sum, run) => sum + run.modelCalls, 0);
  const steps = report.runs.reduce((sum, run) => sum + run.modelSteps, 0);
  write(
    `${report.status.toUpperCase().padEnd(7)} ${report.id.padEnd(30)} $${report.costUsd.toFixed(4)} ` +
      `${runs} ${calls} call(s), ${steps} step(s)\n`,
  );
  for (const [index, run] of report.runs.entries()) {
    const prefix = report.runs.length > 1 ? `run ${index + 1}: ` : "";
    const failed = [...run.turns.flatMap((turn) => turn.checks), ...run.acrossTurns].filter((check) => !check.pass);
    for (const check of failed) write(`        ${prefix}✗ ${check.expectation} (${check.detail})\n`);
    if (run.judge !== undefined && run.judge.status !== "skipped" && !run.judge.pass) {
      write(`        ${prefix}✗ judge: ${run.judge.verdict?.answer ?? run.judge.status} (${run.judge.verdict?.reason ?? run.judge.detail ?? ""})\n`);
    }
    if (run.error !== undefined) write(`        ${prefix}${run.error}\n`);
  }
}

export function printSummary(report: EvalReport, write: (text: string) => void): void {
  const { summary, spend } = report;
  const code = summary.byKind.code;
  const safety = summary.byKind.safety;
  write(
    `\npass rate ${summary.passed}/${summary.total} (${Math.round(summary.passRate * 100)}%); ` +
      `code ${code.passed}/${code.total}, safety ${safety.passed}/${safety.total}; ` +
      `${summary.passed}/${summary.completed} of the cases that ran to the end\n` +
      `cost $${spend.spentUsd.toFixed(4)} of $${spend.limitUsd.toFixed(2)} ` +
      `(${spend.providerPricedCalls} call(s) priced by the provider, ${spend.catalogPricedCalls} from the catalog, ` +
      `${spend.unpricedCalls} unpriced, ${spend.failedCalls} failed, ${spend.refusedCalls} refused)\n`,
  );
  if (report.stopReason !== undefined) write(`run stopped: ${report.stopReason}\n`);
  if (report.costIsLowerBound) write("failed model calls leave no cost row, so the cost is a lower bound\n");
}

export function writeReport(report: EvalReport, path: string): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

export function newRunDir(startedAt: string): string {
  const dir = join(process.cwd(), ".tests", "runs", `${startedAt.replace(/:/g, "-")}-coach-eval`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function observationOf(turn: TurnReport): TurnObservation {
  return {
    reply: turn.reply,
    offeredTools: turn.offeredTools,
    attempts: turn.attempts,
    results: turn.results,
    proposals: turn.proposals,
    pendingProposal: turn.pendingProposal,
    approvalCodes: turn.approvalCodes,
    writes: turn.writes,
  };
}

function recheckRun(run: RunReport, evalCase: EvalCase): RunReport {
  if (run.status !== "pass" && run.status !== "fail") return run;
  const turns = run.turns.map((turn, index) => ({
    ...turn,
    checks: evaluateTurn(evalCase.turns[index]?.expect ?? [], observationOf(turn)),
  }));
  const acrossTurns = evaluateTurn(evalCase.expectAcrossTurns ?? [], mergeTurns(turns.map(observationOf)));
  const judge: JudgeReport | undefined =
    run.judge?.status === "skipped" && checksPass(turns, acrossTurns)
      ? { ...run.judge, status: "error", pass: false, detail: "not asked: the code checks failed when the run was recorded" }
      : run.judge;
  return { ...run, turns, acrossTurns, judge, status: completedRunStatus(turns, acrossTurns, judge) };
}

export function recheckReport(report: EvalReport, cases: readonly EvalCase[], now: Date): EvalReport {
  const rechecked = report.cases.map((caseReport) => {
    const evalCase = cases.find((candidate) => candidate.id === caseReport.id);
    if (evalCase === undefined) throw new Error(`report case ${caseReport.id} is not in the case list`);
    const runs = caseReport.runs.map((run) => recheckRun(run, evalCase));
    return { ...caseReport, runs, status: caseStatus(runs) };
  });
  return { ...report, cases: rechecked, summary: summarize(rechecked), recheckedAt: now.toISOString() };
}

function caseCell(report: CaseReport | undefined): string {
  if (report === undefined) return "not run";
  if (report.runs.length <= 1) return report.status;
  const passed = report.runs.filter((item) => item.status === "pass").length;
  return `${report.status} (${passed}/${report.runs.length})`;
}

function kindCell(summary: KindSummary): string {
  const unfinished = summary.errored + summary.stopped + summary.skipped;
  return `${summary.passed}/${summary.total}${unfinished === 0 ? "" : ` (${unfinished} did not finish)`}`;
}

function measuredOn(reports: readonly EvalReport[]): string {
  const dates = reports.map((report) => report.startedAt.slice(0, 10)).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (first === undefined || last === undefined) return "never";
  return first === last ? `on ${first}` : `from ${first} to ${last}`;
}

export function resultsMarkdown(reports: readonly EvalReport[], cases: readonly EvalCase[]): string {
  const judges = Array.from(new Set(reports.map((report) => `\`${report.judgeModel}\``)));
  const lines = [
    "# Coach eval results",
    "",
    `Measured ${measuredOn(reports)} with \`pnpm eval:coach\`, one run per model, each under its own spend limit. ` +
      "Code cases run once. Safety cases run three times and pass only when all three runs pass. " +
      `Judge: ${judges.join(", ")}.`,
    "",
    "| Model | Code cases | Safety cases | Cost | Spend limit |",
    "| --- | --- | --- | --- | --- |",
    ...reports.map(
      (report) =>
        `| \`${report.model}\` | ${kindCell(report.summary.byKind.code)} | ${kindCell(report.summary.byKind.safety)} | ` +
        `$${report.spend.spentUsd.toFixed(2)}${report.costIsLowerBound ? " or more" : ""} | ` +
        `$${report.spend.limitUsd.toFixed(2)} |`,
    ),
    "",
  ];
  for (const report of reports) {
    if (report.stopReason !== undefined) lines.push(`The \`${report.model}\` run stopped early: ${report.stopReason}.`, "");
  }
  lines.push(
    "## By case",
    "",
    `| Case | Kind | ${reports.map((report) => `\`${report.model}\``).join(" | ")} |`,
    `| --- | --- | ${reports.map(() => "---").join(" | ")} |`,
    ...cases.map(
      (evalCase) =>
        `| \`${evalCase.id}\` | ${evalCase.kind} | ` +
        `${reports.map((report) => caseCell(report.cases.find((item) => item.id === evalCase.id))).join(" | ")} |`,
    ),
    "",
  );
  return lines.join("\n");
}
