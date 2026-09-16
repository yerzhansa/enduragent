import type { EngineConfig, EngineLlmProvider } from "../../src/host-ports.js";

type CatalogProfile = Extract<EngineConfig["models"]["chat"], { kind: "catalog" }>;

function profile(
  provider: EngineLlmProvider,
  model: string,
  contextWindowTokens: number,
  catalogRevision: number,
  catalog?: Pick<CatalogProfile, "compatibilityProfile" | "imageInput">,
): EngineConfig["models"]["chat"] {
  if (catalog !== undefined) {
    return Object.freeze({
      kind: "catalog" as const,
      catalogRevision,
      provider,
      model,
      compatibilityProfile: catalog.compatibilityProfile,
      contextWindowTokens,
      imageInput: catalog.imageInput,
      pricing: Object.freeze({ kind: "unknown" as const }),
    });
  }
  return Object.freeze({
    kind: "custom" as const,
    catalogRevision,
    provider,
    model,
    contextWindowTokens,
    imageInput: "unknown" as const,
    pricing: Object.freeze({ kind: "unknown" as const }),
  });
}

export function testModelProfiles(input: {
  readonly provider: EngineLlmProvider;
  readonly chat: string;
  readonly compact?: string;
  readonly flush?: string;
  readonly chatContextWindowTokens?: number;
  readonly compactContextWindowTokens?: number;
  readonly flushContextWindowTokens?: number;
  readonly catalogRevision?: number;
  readonly catalog?: Pick<CatalogProfile, "compatibilityProfile" | "imageInput">;
}): EngineConfig["models"] {
  const chatWindow = input.chatContextWindowTokens ?? 200_000;
  const catalogRevision = input.catalogRevision ?? 1;
  return Object.freeze({
    catalogRevision,
    chat: profile(input.provider, input.chat, chatWindow, catalogRevision, input.catalog),
    compact: profile(
      input.provider,
      input.compact ?? input.chat,
      input.compactContextWindowTokens ?? chatWindow,
      catalogRevision,
      input.catalog,
    ),
    flush: profile(
      input.provider,
      input.flush ?? input.chat,
      input.flushContextWindowTokens ?? chatWindow,
      catalogRevision,
      input.catalog,
    ),
  });
}

export function withTestModelProfiles<T extends Omit<EngineConfig, "models">>(
  config: T,
): T & Pick<EngineConfig, "models"> {
  return {
    ...config,
    models: testModelProfiles({
      provider: config.llm.provider,
      chat: config.llm.model,
      compact: config.llm.compactModel,
      flush: config.llm.flushModel,
      chatContextWindowTokens: config.contextWindowTokens,
      compactContextWindowTokens: config.compactContextWindowTokens,
      flushContextWindowTokens: config.contextWindowTokens,
    }),
  };
}
