import {
  ASTRA_MODEL_ID,
  inferBackgroundModelChoices,
  type EffectiveRuntimeConfig,
} from "./runtime-config.js";

export interface PersistedLlmBackgroundModels {
  readonly flushModel?: string;
  readonly compactModel?: string;
  readonly beforeAstraModel?: string;
}

export function persistedLlmBackgroundModels(
  config: Pick<EffectiveRuntimeConfig, "llm" | "llmBackgroundModels">,
): PersistedLlmBackgroundModels {
  const choices = config.llmBackgroundModels ?? inferBackgroundModelChoices(config.llm);
  return {
    flushModel: choices.flush.kind === "explicit" ? choices.flush.model : undefined,
    compactModel:
      choices.compact.kind === "explicit"
        ? choices.compact.model
        : choices.compact.kind === "provider-default"
          ? config.llm.compactModel
          : undefined,
    beforeAstraModel:
      config.llm.provider === "openai" && config.llm.model === ASTRA_MODEL_ID
        ? choices.beforeAstra
        : undefined,
  };
}

export function assignPersistedLlmBackgroundModels(
  target: Record<string, unknown>,
  config: Pick<EffectiveRuntimeConfig, "llm" | "llmBackgroundModels">,
): void {
  const persisted = persistedLlmBackgroundModels(config);
  for (const [field, value] of [
    ["flush_model", persisted.flushModel],
    ["compact_model", persisted.compactModel],
    ["before_astra_model", persisted.beforeAstraModel],
  ] as const) {
    if (value === undefined) delete target[field];
    else target[field] = value;
  }
}
