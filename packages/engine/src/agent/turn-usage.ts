import type {
  LoggerPort,
  TurnErrorClass,
  UsageCost,
  UsageCostBasis,
  UsageLedgerLine,
  UsagePort,
} from "../host-ports.js";
import { beginTurnSpan, endTurnSpan } from "./turn-trace.js";

export type TurnStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly error_class: TurnErrorClass | "interrupted" };

type TurnUsageTotal = Pick<
  UsageLedgerLine,
  | "steps"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "providerReportedCostUsd"
  | "catalogRevision"
  | "cacheReadSavingsUsd"
  | "costBasis"
  | "cost"
>;

interface TurnRoute {
  readonly provider: string;
  readonly model: string;
}

interface TurnRowTiming {
  readonly ts: number;
  readonly durationMs: number;
  readonly templateHash: string;
}

export function isFailedCallWithoutKnownUsage(line: UsageLedgerLine): boolean {
  return (
    line.outcome === "error" &&
    line.inputTokens === undefined &&
    line.outputTokens === undefined &&
    line.providerReportedCostUsd === undefined &&
    line.cost === undefined
  );
}

function sumKnown(values: readonly (number | undefined)[]): number | undefined {
  let sum: number | undefined;
  for (const value of values) {
    if (value !== undefined) sum = (sum ?? 0) + value;
  }
  return sum;
}

function sumWhenEveryCallReports(values: readonly (number | undefined)[]): number | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (const value of values) {
    if (value === undefined) return undefined;
    sum += value;
  }
  return sum;
}

function sumCosts(costs: readonly (UsageCost | undefined)[]): UsageCost | undefined {
  if (costs.length === 0) return undefined;
  let sum: UsageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const cost of costs) {
    if (cost === undefined) return undefined;
    sum = {
      input: sum.input + cost.input,
      output: sum.output + cost.output,
      cacheRead: sum.cacheRead + cost.cacheRead,
      cacheWrite: sum.cacheWrite + cost.cacheWrite,
      total: sum.total + cost.total,
    };
  }
  return sum;
}

function sharedCostBasis(
  bases: readonly (UsageCostBasis | undefined)[],
): UsageCostBasis | undefined {
  const [first] = bases;
  return bases.every((basis) => basis === first) ? first : undefined;
}

function latestCatalogRevision(lines: readonly UsageLedgerLine[]): number | undefined {
  let revision: number | undefined;
  for (const line of lines) revision = line.catalogRevision ?? revision;
  return revision;
}

const KNOWN_ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const satisfies TurnUsageTotal;

export function sumTurnUsage(lines: readonly UsageLedgerLine[]): TurnUsageTotal {
  const reporting = lines.filter((line) => !isFailedCallWithoutKnownUsage(line));
  const steps = lines.reduce((sum, line) => sum + (line.steps ?? 0), 0);
  const catalogRevision = latestCatalogRevision(lines);
  if (reporting.length === 0) return { steps, catalogRevision, ...KNOWN_ZERO_USAGE };
  return {
    steps,
    inputTokens: sumKnown(reporting.map((line) => line.inputTokens)),
    outputTokens: sumKnown(reporting.map((line) => line.outputTokens)),
    totalTokens: sumKnown(reporting.map((line) => line.totalTokens)),
    cacheReadTokens: sumKnown(reporting.map((line) => line.cacheReadTokens)),
    cacheWriteTokens: sumKnown(reporting.map((line) => line.cacheWriteTokens)),
    providerReportedCostUsd: sumWhenEveryCallReports(
      reporting.map((line) => line.providerReportedCostUsd),
    ),
    catalogRevision,
    cacheReadSavingsUsd: sumWhenEveryCallReports(reporting.map((line) => line.cacheReadSavingsUsd)),
    costBasis: sharedCostBasis(reporting.map((line) => line.costBasis)),
    cost: sumCosts(reporting.map((line) => line.cost)),
  };
}

function isChatCall(line: UsageLedgerLine): boolean {
  return line.kind === "generate" && line.caller === "chat";
}

function turnEnding(status: TurnStatus): Pick<UsageLedgerLine, "outcome" | "errorClass"> {
  if (status.ok) return { outcome: "ok" };
  return {
    outcome: "error",
    errorClass: status.error_class === "interrupted" ? "aborted" : status.error_class,
  };
}

export class TurnUsageLedger {
  readonly port: UsagePort;
  private readonly sink: UsagePort;
  private readonly route: TurnRoute;
  private readonly log: LoggerPort;
  private readonly openTurns = new Map<string, UsageLedgerLine[]>();

  constructor(sink: UsagePort, route: TurnRoute, log: LoggerPort) {
    this.sink = sink;
    this.route = route;
    this.log = log;
    this.port = {
      append: (line) => {
        this.observe(line);
        sink.append(line);
      },
    };
  }

  begin(turnId: string, resumed: boolean): void {
    const earlier = resumed ? this.earlierRuns(turnId) : [];
    this.openTurns.set(turnId, earlier);
    beginTurnSpan(turnId, earlier.filter((line) => line.outcome === "error").length);
  }

  end(turnId: string, status: TurnStatus, timing: TurnRowTiming): void {
    endTurnSpan(turnId, turnEnding(status));
    const lines = this.openTurns.get(turnId);
    if (lines === undefined) return;
    this.openTurns.delete(turnId);
    try {
      this.sink.append({
        ts: timing.ts,
        kind: "turn",
        caller: "chat",
        provider: this.route.provider,
        model: this.route.model,
        durationMs: timing.durationMs,
        turnId,
        templateHash: timing.templateHash,
        ...turnEnding(status),
        ...sumTurnUsage(lines),
      });
    } catch (error) {
      this.log.warn("turn_usage_row_failed", error);
    }
  }

  discard(turnId: string): void {
    this.openTurns.delete(turnId);
    endTurnSpan(turnId, { outcome: "error" });
  }

  private earlierRuns(turnId: string): UsageLedgerLine[] {
    try {
      return (this.sink.callsForTurn?.(turnId) ?? []).filter(
        (line) => isChatCall(line) && line.turnId === turnId,
      );
    } catch (error) {
      this.log.warn("turn_usage_resume_failed", error);
      return [];
    }
  }

  private observe(line: UsageLedgerLine): void {
    if (!isChatCall(line) || line.turnId === undefined) return;
    this.openTurns.get(line.turnId)?.push(line);
  }
}
