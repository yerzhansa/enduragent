import type { LanguageModelUsage } from "ai";
import type { RequestUsage, UsageLedgerLine } from "./host-ports.js";
import type { GenerateOptions, GenerateResult } from "./sport.js";

export type { GenerateOptions, GenerateResult } from "./sport.js";
export type GenerateOpts = GenerateOptions;

function tokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function requestUsageFields(usage: RequestUsage): RequestUsage {
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cacheReadTokens),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
  };
}

export function requestUsageFromSteps(
  steps: readonly { readonly usage: LanguageModelUsage }[],
): readonly RequestUsage[] | undefined {
  if (steps.length === 0) return undefined;
  return steps.map(({ usage }) =>
    requestUsageFields({
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    }),
  );
}

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
