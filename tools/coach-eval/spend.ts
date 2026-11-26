export const DEFAULT_MAX_USD = 10;

export interface RunOptions {
  readonly model: string;
  readonly maxUsd: number;
  readonly caseIds: readonly string[];
}

export type ParsedRunOptions =
  | { readonly ok: true; readonly options: RunOptions }
  | { readonly ok: false; readonly message: string };

export const USAGE =
  "usage: pnpm eval:coach --model <openrouter model id> [--max-usd <dollars, at most 10>] [--case <case id>]...";

export function parseRunArgs(argv: readonly string[]): ParsedRunOptions {
  let model: string | undefined;
  let maxUsd = DEFAULT_MAX_USD;
  const caseIds: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--") continue;
    if (flag !== "--model" && flag !== "--max-usd" && flag !== "--case") {
      return { ok: false, message: `unknown argument ${flag}` };
    }
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `${flag} needs a value` };
    }
    index++;
    if (flag === "--model") model = value;
    if (flag === "--case") caseIds.push(value);
    if (flag === "--max-usd") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > DEFAULT_MAX_USD) {
        return {
          ok: false,
          message: `--max-usd must be above 0 and at most ${DEFAULT_MAX_USD}, got ${value}`,
        };
      }
      maxUsd = parsed;
    }
  }
  if (model === undefined || model.trim() === "") return { ok: false, message: "--model is required" };
  return { ok: true, options: { model, maxUsd, caseIds } };
}

export interface UsageCostFigures {
  readonly providerReportedCostUsd?: number;
  readonly cost?: { readonly total: number };
}

function finiteCost(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function lineCostUsd(line: UsageCostFigures): number | undefined {
  return finiteCost(line.providerReportedCostUsd) ?? finiteCost(line.cost?.total);
}

export interface SpendSnapshot {
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly pricedCalls: number;
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

export class SpendMeter {
  private spent = 0;
  private priced = 0;
  private unpriced = 0;
  private failed = 0;
  private refused = 0;
  private haltReason: string | undefined;

  constructor(readonly limitUsd: number) {}

  record(line: UsageCostFigures): void {
    const cost = lineCostUsd(line);
    if (cost === undefined) {
      this.unpriced++;
      return;
    }
    this.priced++;
    this.spent += cost;
  }

  recordFailedCall(): void {
    this.failed++;
  }

  halt(reason: string): void {
    this.haltReason ??= reason;
  }

  stopReason(): string | undefined {
    if (this.haltReason !== undefined) return this.haltReason;
    if (this.unpriced > 0) {
      return `${this.unpriced} model call(s) reported no cost, so the spend limit cannot be enforced`;
    }
    if (this.spent >= this.limitUsd) {
      return `spend limit of $${this.limitUsd.toFixed(2)} reached ($${this.spent.toFixed(4)} spent)`;
    }
    return undefined;
  }

  assertCanCall(): void {
    const reason = this.stopReason();
    if (reason === undefined) return;
    this.refused++;
    throw new RunStoppedError(reason);
  }

  snapshot(): SpendSnapshot {
    return {
      limitUsd: this.limitUsd,
      spentUsd: this.spent,
      pricedCalls: this.priced,
      unpricedCalls: this.unpriced,
      failedCalls: this.failed,
      refusedCalls: this.refused,
    };
  }
}
