import type { UsageLedgerLine } from "./host-ports.js";
import type { GenerateOptions, GenerateResult } from "./sport.js";

export type { GenerateOptions, GenerateResult } from "./sport.js";
export type GenerateOpts = GenerateOptions;

export function cacheTokenDetails(
  usage: GenerateResult["totalUsage"],
): { cacheReadTokens?: number; cacheWriteTokens?: number } | undefined {
  return usage?.inputTokenDetails as
    | { cacheReadTokens?: number; cacheWriteTokens?: number }
    | undefined;
}

export function usageFieldsFromResult(
  result: GenerateResult,
): Pick<
  UsageLedgerLine,
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
> {
  const usage = result.totalUsage;
  const details = cacheTokenDetails(usage);
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: details?.cacheReadTokens,
    cacheWriteTokens: details?.cacheWriteTokens,
    providerReportedCostUsd: result.providerReportedCostUsd,
    catalogRevision: result.catalogRevision,
    cacheReadSavingsUsd: result.cacheReadSavingsUsd,
    costBasis: result.costBasis,
    cost: result.cost,
  };
}
