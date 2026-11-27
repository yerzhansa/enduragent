import type { LanguageModelUsage } from "ai";
import type { FinishedStepUsage } from "./sport.js";

export interface StepUsageTally {
  record(step: FinishedStepUsage): void;
  finishedSteps(): number;
  knownUsage(): LanguageModelUsage | undefined;
  knownProviderReportedCostUsd(): number | undefined;
}

function addKnown(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function addUsage(left: LanguageModelUsage, right: LanguageModelUsage): LanguageModelUsage {
  return {
    inputTokens: addKnown(left.inputTokens, right.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addKnown(
        left.inputTokenDetails.noCacheTokens,
        right.inputTokenDetails.noCacheTokens,
      ),
      cacheReadTokens: addKnown(
        left.inputTokenDetails.cacheReadTokens,
        right.inputTokenDetails.cacheReadTokens,
      ),
      cacheWriteTokens: addKnown(
        left.inputTokenDetails.cacheWriteTokens,
        right.inputTokenDetails.cacheWriteTokens,
      ),
    },
    outputTokens: addKnown(left.outputTokens, right.outputTokens),
    outputTokenDetails: {
      textTokens: addKnown(left.outputTokenDetails.textTokens, right.outputTokenDetails.textTokens),
      reasoningTokens: addKnown(
        left.outputTokenDetails.reasoningTokens,
        right.outputTokenDetails.reasoningTokens,
      ),
    },
    totalTokens: addKnown(left.totalTokens, right.totalTokens),
  };
}

export function createStepUsageTally(): StepUsageTally {
  let steps = 0;
  let usage: LanguageModelUsage | undefined;
  let providerReportedCostUsd: number | undefined;
  let everyStepReportedCost = true;
  return {
    record(step) {
      steps += 1;
      usage = usage === undefined ? step.usage : addUsage(usage, step.usage);
      if (step.providerReportedCostUsd === undefined) {
        everyStepReportedCost = false;
        return;
      }
      providerReportedCostUsd = (providerReportedCostUsd ?? 0) + step.providerReportedCostUsd;
    },
    finishedSteps: () => steps,
    knownUsage: () => usage,
    knownProviderReportedCostUsd: () =>
      everyStepReportedCost ? providerReportedCostUsd : undefined,
  };
}
