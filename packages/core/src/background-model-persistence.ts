import {
  ASTRA_MODEL_ID,
  DEFAULT_MODELS,
  currentModelId,
  inferBackgroundModelChoices,
  type EffectiveRuntimeConfig,
  type LlmProvider,
} from "./runtime-config.js";

const BACKGROUND_MODEL_SLOTS = ["compact", "flush"] as const;

export type BackgroundModelSlot = (typeof BACKGROUND_MODEL_SLOTS)[number];

export interface PersistedLlmBackgroundModels {
  readonly flushModel?: string;
  readonly compactModel?: string;
  readonly beforeAstraModel?: string;
  readonly explicitBackgroundModels?: readonly BackgroundModelSlot[];
}

export function persistedLlmBackgroundModels(
  config: Pick<EffectiveRuntimeConfig, "llm" | "llmBackgroundModels">,
): PersistedLlmBackgroundModels {
  const choices = config.llmBackgroundModels ?? inferBackgroundModelChoices(config.llm);
  const explicit = BACKGROUND_MODEL_SLOTS.filter((slot) => choices[slot].kind === "explicit");
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
    explicitBackgroundModels: explicit.length === 0 ? undefined : explicit,
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
    ["explicit_background_models", persisted.explicitBackgroundModels],
  ] as const) {
    if (value === undefined) delete target[field];
    else target[field] = value;
  }
}

function savedExplicitSlots(value: unknown): readonly BackgroundModelSlot[] | undefined {
  return Array.isArray(value)
    ? BACKGROUND_MODEL_SLOTS.filter((slot) => value.includes(slot))
    : undefined;
}

function explicitSlotsSavedByOlderVersion(
  llm: Readonly<Record<string, unknown>>,
  provider: LlmProvider,
): { readonly explicit: readonly BackgroundModelSlot[]; readonly beforeAstraModel?: string } {
  const baseUrl = typeof llm.base_url === "string" ? llm.base_url : undefined;
  const saved = (value: unknown): string | undefined =>
    typeof value === "string" ? currentModelId(provider, value, baseUrl) : undefined;
  const model = saved(llm.model) ?? DEFAULT_MODELS[provider];
  const compactModel = saved(llm.compact_model);
  const flushModel = saved(llm.flush_model);
  const beforeAstraModel =
    provider === "openai" && model === ASTRA_MODEL_ID ? (flushModel ?? compactModel) : undefined;
  const choices = inferBackgroundModelChoices({ provider, model, compactModel, flushModel });
  const derived: Record<BackgroundModelSlot, boolean> =
    beforeAstraModel !== undefined
      ? { compact: compactModel === beforeAstraModel, flush: flushModel === beforeAstraModel }
      : {
          compact:
            compactModel !== undefined &&
            (compactModel === model || choices.compact.kind !== "explicit"),
          flush: flushModel === model,
        };
  return {
    explicit: BACKGROUND_MODEL_SLOTS.filter(
      (slot) => llm[`${slot}_model`] !== undefined && !derived[slot],
    ),
    ...(beforeAstraModel === undefined ? {} : { beforeAstraModel }),
  };
}

export function readPersistedLlmBackgroundModels(
  llm: Readonly<Record<string, unknown>>,
  provider: LlmProvider,
): Pick<PersistedLlmBackgroundModels, "flushModel" | "compactModel" | "beforeAstraModel"> {
  const savedExplicit = savedExplicitSlots(llm.explicit_background_models);
  const { explicit, beforeAstraModel } =
    savedExplicit === undefined
      ? explicitSlotsSavedByOlderVersion(llm, provider)
      : { explicit: savedExplicit, beforeAstraModel: undefined };
  return {
    flushModel: explicit.includes("flush") ? (llm.flush_model as string | undefined) : undefined,
    compactModel: explicit.includes("compact")
      ? (llm.compact_model as string | undefined)
      : undefined,
    beforeAstraModel:
      typeof llm.before_astra_model === "string" ? llm.before_astra_model : beforeAstraModel,
  };
}
