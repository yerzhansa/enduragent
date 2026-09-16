import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CACHING_UNAVAILABLE_DISCLOSURE,
  SetDailySpendCapRpcParamsSchema,
  SpendSummarySchema,
  type SpendRouteSummary,
  type SpendSummary,
} from "@enduragent/coach-contract";
import {
  atomicWriteJson,
  readUsageLedger as readUsageLedgerFromDisk,
  USAGE_LEDGER_FILE,
  type UsageLedgerReadResult,
} from "@enduragent/core";
import {
  cacheReadSavingsUsd,
  claudeCliCacheReadSavingsUsd,
  classifySpendCaching,
  codexAgentCacheReadSavingsUsd,
  priceClaudeCliInclusiveUsage,
  priceCodexAgentInclusiveUsage,
  priceInclusiveUsage,
  type UsageCost,
  type UsageLedgerLine,
  type UsageTokenCounts,
} from "@enduragent/engine";
import { z } from "zod";

export const DEFAULT_DAILY_SPEND_CAP_USD = 0.5;
export const DAILY_SPEND_CAP_FILE = "daily-spend-cap.json";
export const DAILY_SPEND_CAP_VERSION = 1;

export interface SpendMeterService {
  getSpendSummary(): Promise<SpendSummary>;
  setDailySpendCap(dailyCapUsd: number): Promise<SpendSummary>;
}

export interface CreateSpendMeterServiceInput {
  readonly dataDir: string;
  readonly configDir: string;
  readonly timezone: string;
  readonly now?: () => number;
  readonly readUsageLedger?: (dataDir: string) => UsageLedgerReadResult;
}

const DailySpendCapSchema = z
  .object({
    version: z.literal(DAILY_SPEND_CAP_VERSION),
    dailyCapUsd: z.number().finite().positive(),
  })
  .strict();

interface MutableRoute {
  readonly provider: string;
  readonly model: string;
  generationCount: number;
  pricedGenerationCount: number;
  unpricedGenerationCount: number;
  providerReportedGenerationCount: number;
  knownSpendUsd: number;
  notionalSpendUsd: number;
  cacheReadTokens: number;
  cacheSavingsKnownUsd: number;
  cacheSavingsAvailable: boolean;
}

function createDateFormatter(timezone: string): Intl.DateTimeFormat | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return undefined;
  }
}

function dateKey(
  timestamp: number,
  formatter: Intl.DateTimeFormat | undefined,
): string | undefined {
  try {
    const parts = formatter?.formatToParts(new Date(timestamp));
    if (parts === undefined) return undefined;
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    if (values.year === undefined || values.month === undefined || values.day === undefined) {
      return undefined;
    }
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return undefined;
  }
}

function regularFileRevision(path: string): string | undefined {
  try {
    const state = statSync(path, { bigint: true });
    if (!state.isFile()) return undefined;
    return ["file", state.dev, state.ino, state.size, state.mtimeNs, state.ctimeNs].join(":");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : undefined;
  }
}

function usageLedgerRevision(dataDir: string): string | undefined {
  const livePath = join(dataDir, USAGE_LEDGER_FILE);
  const rotated = regularFileRevision(`${livePath}.1`);
  if (rotated === undefined) return undefined;
  const live = regularFileRevision(livePath);
  if (live === undefined) return undefined;
  return `${rotated}|${live}`;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validProviderCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validUsageCost(value: unknown): value is UsageCost {
  if (typeof value !== "object" || value === null) return false;
  const cost = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite", "total"].every((field) =>
    validProviderCost(cost[field]),
  );
}

function safeTokenSum(...values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!validToken(value)) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function catalogInputTokens(line: UsageLedgerLine): number | undefined {
  const inputTokens = line.inputTokens;
  if (line.provider !== "openai-codex" || inputTokens === undefined) return inputTokens;

  // Older Codex rows stored uncached input while retaining the provider's
  // inclusive total. Only that exact identity can distinguish them safely
  // from current rows without rewriting the ledger.
  const { outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } = line;
  if (
    outputTokens === undefined ||
    totalTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return inputTokens;
  }

  const cachedInputTokens = safeTokenSum(cacheReadTokens, cacheWriteTokens);
  if (cachedInputTokens === undefined || cachedInputTokens === 0) return inputTokens;

  const legacyTotalTokens = safeTokenSum(inputTokens, cachedInputTokens, outputTokens);
  if (legacyTotalTokens !== totalTokens) return inputTokens;

  return safeTokenSum(inputTokens, cachedInputTokens) ?? inputTokens;
}

const CLAUDE_CLI_PROVIDER = "claude-cli";
const CODEX_AGENT_PROVIDER = "codex-agent";

function catalogCostFor(line: UsageLedgerLine, usage: UsageTokenCounts): UsageCost | undefined {
  if (line.provider === CLAUDE_CLI_PROVIDER) return priceClaudeCliInclusiveUsage(line.model, usage);
  if (line.provider === CODEX_AGENT_PROVIDER) {
    return priceCodexAgentInclusiveUsage(line.model, usage);
  }
  return priceInclusiveUsage(line.provider, line.model, usage);
}

function catalogCacheReadSavingsFor(line: UsageLedgerLine, cacheReadTokens: number): number | null {
  if (line.provider === CLAUDE_CLI_PROVIDER) {
    return claudeCliCacheReadSavingsUsd(line.model, cacheReadTokens);
  }
  if (line.provider === CODEX_AGENT_PROVIDER) {
    return codexAgentCacheReadSavingsUsd(line.model, cacheReadTokens);
  }
  return cacheReadSavingsUsd(line.provider, line.model, cacheReadTokens);
}

function accruesToCap(line: UsageLedgerLine): boolean {
  if (line.costBasis === "notional") return false;
  if (line.costBasis === "actual") return true;
  return line.provider !== CLAUDE_CLI_PROVIDER || line.providerReportedCostUsd !== undefined;
}

function readDailyCap(path: string): number {
  try {
    return DailySpendCapSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown).dailyCapUsd;
  } catch {
    return DEFAULT_DAILY_SPEND_CAP_USD;
  }
}

function selectedNumericFieldsValid(line: Record<string, unknown>): boolean {
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    if (line[field] !== undefined && !validToken(line[field])) return false;
  }
  if (
    line.providerReportedCostUsd !== undefined &&
    !validProviderCost(line.providerReportedCostUsd)
  ) {
    return false;
  }
  if (line.catalogRevision === undefined) return true;
  return (
    typeof line.catalogRevision === "number" &&
    Number.isSafeInteger(line.catalogRevision) &&
    line.catalogRevision > 0 &&
    (line.cost === undefined || validUsageCost(line.cost)) &&
    (line.cacheReadSavingsUsd === undefined || validProviderCost(line.cacheReadSavingsUsd))
  );
}

function routeSummary(route: MutableRoute): SpendRouteSummary {
  const caching = classifySpendCaching(route.provider, route.model);
  return {
    provider: route.provider,
    model: route.model,
    generationCount: route.generationCount,
    pricedGenerationCount: route.pricedGenerationCount,
    unpricedGenerationCount: route.unpricedGenerationCount,
    providerReportedGenerationCount: route.providerReportedGenerationCount,
    knownSpendUsd: route.knownSpendUsd,
    notionalSpendUsd: route.notionalSpendUsd,
    cacheReadTokens: route.cacheReadTokens,
    cacheReadSavingsUsd: route.cacheSavingsAvailable ? route.cacheSavingsKnownUsd : null,
    caching,
    disclosure: caching === "unavailable" ? CACHING_UNAVAILABLE_DISCLOSURE : null,
  };
}

interface LedgerAggregate {
  readonly knownSpendUsd: number;
  readonly notionalSpendUsd: number;
  readonly generationCount: number;
  readonly pricedGenerationCount: number;
  readonly unpricedGenerationCount: number;
  readonly malformedLineCount: number;
  readonly spendComplete: boolean;
  readonly cacheReadTokens: number;
  readonly knownCacheReadSavingsUsd: number;
  readonly cacheSavingsComplete: boolean;
  readonly routes: readonly SpendRouteSummary[];
}

function aggregateLedger(
  ledger: UsageLedgerReadResult,
  localDate: string,
  formatter: Intl.DateTimeFormat,
): LedgerAggregate {
  let malformedLineCount = ledger.malformedLineCount;
  const routesByKey = new Map<string, MutableRoute>();

  for (const rawLine of ledger.lines) {
    const line = rawLine as UsageLedgerLine & Record<string, unknown>;
    if (
      !["generate", "turn", "boot"].includes(String(line.kind)) ||
      typeof line.ts !== "number" ||
      !Number.isFinite(line.ts) ||
      !nonemptyString(line.provider) ||
      !nonemptyString(line.model)
    ) {
      malformedLineCount += 1;
      continue;
    }
    const lineDate = dateKey(line.ts, formatter);
    if (lineDate === undefined) {
      malformedLineCount += 1;
      continue;
    }
    if (line.kind !== "generate" || lineDate !== localDate) continue;

    const key = JSON.stringify([line.provider, line.model]);
    const route = routesByKey.get(key) ?? {
      provider: line.provider,
      model: line.model,
      generationCount: 0,
      pricedGenerationCount: 0,
      unpricedGenerationCount: 0,
      providerReportedGenerationCount: 0,
      knownSpendUsd: 0,
      notionalSpendUsd: 0,
      cacheReadTokens: 0,
      cacheSavingsKnownUsd: 0,
      cacheSavingsAvailable: true,
    };
    routesByKey.set(key, route);
    route.generationCount += 1;

    if (!selectedNumericFieldsValid(line)) {
      malformedLineCount += 1;
      route.unpricedGenerationCount += 1;
      continue;
    }
    const catalogRevision = line.catalogRevision as number | undefined;
    const storedCost = line.cost as UsageCost | undefined;
    const storedCacheReadSavingsUsd = line.cacheReadSavingsUsd as number | undefined;

    const cacheReadTokens = line.cacheReadTokens ?? 0;
    const nextCacheReadTokens = route.cacheReadTokens + cacheReadTokens;
    if (!Number.isSafeInteger(nextCacheReadTokens)) {
      malformedLineCount += 1;
      route.unpricedGenerationCount += 1;
      route.cacheSavingsAvailable = false;
      continue;
    }
    route.cacheReadTokens = nextCacheReadTokens;
    if (cacheReadTokens > 0) {
      const savings =
        catalogRevision === undefined
          ? catalogCacheReadSavingsFor(line, cacheReadTokens)
          : (storedCacheReadSavingsUsd ?? null);
      if (savings === null || !Number.isFinite(route.cacheSavingsKnownUsd + savings)) {
        route.cacheSavingsAvailable = false;
      } else {
        route.cacheSavingsKnownUsd += savings;
      }
    }

    const providerReported = line.providerReportedCostUsd;
    const catalogCost =
      providerReported === undefined &&
      catalogRevision === undefined &&
      line.inputTokens !== undefined &&
      line.outputTokens !== undefined
        ? catalogCostFor(line, {
            inputTokens: catalogInputTokens(line) ?? line.inputTokens,
            outputTokens: line.outputTokens,
            cacheReadTokens,
            cacheWriteTokens: line.cacheWriteTokens ?? 0,
          })
        : undefined;
    const cost =
      providerReported ?? (catalogRevision === undefined ? catalogCost?.total : storedCost?.total);
    const accrues = accruesToCap(line);
    const running = accrues ? route.knownSpendUsd : route.notionalSpendUsd;
    if (cost === undefined || !Number.isFinite(running + cost)) {
      route.unpricedGenerationCount += 1;
    } else if (accrues) {
      route.knownSpendUsd += cost;
      route.pricedGenerationCount += 1;
      if (providerReported !== undefined) route.providerReportedGenerationCount += 1;
    } else {
      route.notionalSpendUsd += cost;
      route.pricedGenerationCount += 1;
    }
  }

  const routes = [...routesByKey.values()]
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
    )
    .map(routeSummary);
  const generationCount = routes.reduce((sum, route) => sum + route.generationCount, 0);
  const pricedGenerationCount = routes.reduce((sum, route) => sum + route.pricedGenerationCount, 0);
  const unpricedGenerationCount = routes.reduce(
    (sum, route) => sum + route.unpricedGenerationCount,
    0,
  );
  const knownSpendUsd = routes.reduce((sum, route) => sum + route.knownSpendUsd, 0);
  const notionalSpendUsd = routes.reduce((sum, route) => sum + (route.notionalSpendUsd ?? 0), 0);
  const cacheReadTokens = routes.reduce((sum, route) => sum + route.cacheReadTokens, 0);
  const knownCacheReadSavingsUsd = routes.reduce(
    (sum, route) => sum + (route.cacheReadSavingsUsd ?? 0),
    0,
  );
  const spendComplete = unpricedGenerationCount === 0 && malformedLineCount === 0;
  const cacheSavingsComplete =
    malformedLineCount === 0 && routes.every((route) => route.cacheReadSavingsUsd !== null);
  return {
    knownSpendUsd,
    notionalSpendUsd,
    generationCount,
    pricedGenerationCount,
    unpricedGenerationCount,
    malformedLineCount,
    spendComplete,
    cacheReadTokens,
    knownCacheReadSavingsUsd,
    cacheSavingsComplete,
    routes,
  };
}

export function createSpendMeterService(input: CreateSpendMeterServiceInput): SpendMeterService {
  const now = input.now ?? Date.now;
  const capPath = join(input.configDir, DAILY_SPEND_CAP_FILE);
  const readLedger = input.readUsageLedger ?? readUsageLedgerFromDisk;
  const formatter = createDateFormatter(input.timezone);
  let cache:
    | {
        readonly localDate: string;
        readonly revision: string;
        readonly aggregate: LedgerAggregate;
      }
    | undefined;

  const summarize = async (): Promise<SpendSummary> => {
    const capturedNow = now();
    const localDate = dateKey(capturedNow, formatter);
    if (localDate === undefined || formatter === undefined) {
      throw new TypeError("Spend date could not be resolved.");
    }
    const dailyCapUsd = readDailyCap(capPath);
    const revision = usageLedgerRevision(input.dataDir);
    let aggregate =
      revision !== undefined && cache?.localDate === localDate && cache.revision === revision
        ? cache.aggregate
        : undefined;
    if (aggregate === undefined) {
      aggregate = aggregateLedger(readLedger(input.dataDir), localDate, formatter);
      const finalRevision = usageLedgerRevision(input.dataDir);
      if (
        revision !== undefined &&
        finalRevision === revision &&
        aggregate.malformedLineCount === 0
      ) {
        cache = { localDate, revision, aggregate };
      }
    }
    return SpendSummarySchema.parse({
      localDate,
      timezone: input.timezone,
      dailyCapUsd,
      ...aggregate,
      capStatus:
        aggregate.knownSpendUsd >= dailyCapUsd
          ? "reached"
          : aggregate.spendComplete
            ? "below"
            : "unknown",
    });
  };

  return {
    getSpendSummary: summarize,
    async setDailySpendCap(dailyCapUsd) {
      const parsed = SetDailySpendCapRpcParamsSchema.parse({ dailyCapUsd });
      await atomicWriteJson(capPath, {
        version: DAILY_SPEND_CAP_VERSION,
        dailyCapUsd: parsed.dailyCapUsd,
      });
      return summarize();
    },
  };
}
