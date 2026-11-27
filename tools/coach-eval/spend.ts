export const DEFAULT_MAX_USD = 10;
export const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-5";

export interface LiveRunOptions {
  readonly mode: "live";
  readonly model: string;
  readonly judgeModel: string;
  readonly maxUsd: number;
  readonly caseIds: readonly string[];
}

export interface RecheckOptions {
  readonly mode: "recheck";
  readonly reportPath: string;
}

export type RunOptions = LiveRunOptions | RecheckOptions;

export type ParsedRunOptions =
  | { readonly ok: true; readonly options: RunOptions }
  | { readonly ok: false; readonly message: string };

export const USAGE =
  "usage: pnpm eval:coach --model <openrouter model id> [--judge-model <openrouter model id>] " +
  "[--max-usd <dollars, at most 10>] [--case <case id>]...\n" +
  "       pnpm eval:coach --recheck <report.json>";

const FLAGS: ReadonlySet<string> = new Set(["--model", "--judge-model", "--max-usd", "--case", "--recheck"]);

function parseMaxUsd(value: string): number | string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > DEFAULT_MAX_USD) {
    return `--max-usd must be above 0 and at most ${DEFAULT_MAX_USD}, got ${value}`;
  }
  return parsed;
}

export function parseRunArgs(argv: readonly string[]): ParsedRunOptions {
  const values = new Map<string, string>();
  const caseIds: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--") continue;
    if (!FLAGS.has(flag)) return { ok: false, message: `unknown argument ${flag}` };
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${flag} needs a value` };
    index++;
    if (flag === "--case") caseIds.push(value);
    else values.set(flag, value);
  }
  const reportPath = values.get("--recheck");
  if (reportPath !== undefined) {
    if (values.size > 1 || caseIds.length > 0) {
      return { ok: false, message: "--recheck takes no other flags" };
    }
    return { ok: true, options: { mode: "recheck", reportPath } };
  }
  const model = values.get("--model");
  if (model === undefined || model.trim() === "") return { ok: false, message: "--model is required" };
  const maxUsd = parseMaxUsd(values.get("--max-usd") ?? String(DEFAULT_MAX_USD));
  if (typeof maxUsd === "string") return { ok: false, message: maxUsd };
  const judgeModel = values.get("--judge-model") ?? DEFAULT_JUDGE_MODEL;
  if (judgeModel.trim() === "") return { ok: false, message: "--judge-model needs a value" };
  return { ok: true, options: { mode: "live", model, judgeModel, maxUsd, caseIds } };
}

export interface UsageCostFigures {
  readonly providerReportedCostUsd?: number;
  readonly cost?: { readonly total: number };
  readonly outcome?: string;
}

export type CostSource = "provider" | "catalog";

export interface LineCost {
  readonly usd: number;
  readonly source: CostSource;
}

function finiteCost(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function lineCost(line: UsageCostFigures): LineCost | undefined {
  const provider = finiteCost(line.providerReportedCostUsd);
  if (provider !== undefined) return { usd: provider, source: "provider" };
  const catalog = finiteCost(line.cost?.total);
  return catalog === undefined ? undefined : { usd: catalog, source: "catalog" };
}

export interface SpendSnapshot {
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly largestCallUsd: number;
  readonly providerPricedCalls: number;
  readonly catalogPricedCalls: number;
  readonly unpricedCalls: number;
  readonly failedCalls: number;
  readonly refusedCalls: number;
}

export class RunStoppedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RunStoppedError";
  }
}

const FAILED_CALL_REASON =
  "a model call failed, so its cost is unknown and the spend limit can no longer be enforced";

export class SpendMeter {
  private spent = 0;
  private largest = 0;
  private readonly pricedBy: Record<CostSource, number> = { provider: 0, catalog: 0 };
  private unpriced = 0;
  private failed = 0;
  private refused = 0;
  private refusalUnrecorded = false;
  private haltReason: string | undefined;

  constructor(readonly limitUsd: number) {}

  record(line: UsageCostFigures): void {
    const cost = lineCost(line);
    if (cost === undefined) {
      if (line.outcome !== "error") this.unpriced++;
      return;
    }
    this.pricedBy[cost.source]++;
    this.spent += cost.usd;
    this.largest = Math.max(this.largest, cost.usd);
  }

  recordFailedCall(): void {
    this.failed++;
    this.halt(FAILED_CALL_REASON);
  }

  halt(reason: string): void {
    this.haltReason ??= reason;
  }

  stopReason(): string | undefined {
    if (this.haltReason !== undefined) return this.haltReason;
    if (this.unpriced > 0) {
      return `${this.unpriced} model call(s) reported no cost, so the spend limit cannot be enforced`;
    }
    if (this.spent + this.largest >= this.limitUsd) {
      return (
        `spend limit of $${this.limitUsd.toFixed(2)} reached: $${this.spent.toFixed(4)} spent, ` +
        `and the next call could cost $${this.largest.toFixed(4)}, like the largest so far`
      );
    }
    return undefined;
  }

  takeRefusedCall(): boolean {
    const refused = this.refusalUnrecorded;
    this.refusalUnrecorded = false;
    return refused;
  }

  assertCanCall(): void {
    const reason = this.stopReason();
    if (reason === undefined) return;
    this.refused++;
    this.refusalUnrecorded = true;
    throw new RunStoppedError(reason);
  }

  snapshot(): SpendSnapshot {
    return {
      limitUsd: this.limitUsd,
      spentUsd: this.spent,
      largestCallUsd: this.largest,
      providerPricedCalls: this.pricedBy.provider,
      catalogPricedCalls: this.pricedBy.catalog,
      unpricedCalls: this.unpriced,
      failedCalls: this.failed,
      refusedCalls: this.refused,
    };
  }
}
