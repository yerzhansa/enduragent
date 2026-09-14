import { z } from "zod";
import { LlmProviderSchema } from "./llm-provider.js";

export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;

export const MODEL_CATALOG_LIMITS = Object.freeze({
  providers: 64,
  modelsPerProvider: 256,
  providerIdCharacters: 64,
  modelIdCharacters: 512,
  labelCharacters: 128,
  hintCharacters: 256,
  contextWindowTokens: 10_000_000,
  usdPerMillionTokens: 1_000_000,
});

const OrderedPositionSchema = z.number().int().min(0).max(100_000);
const DisplayLabelSchema = z.string().trim().min(1).max(MODEL_CATALOG_LIMITS.labelCharacters);
const HintSchema = z.string().trim().min(1).max(MODEL_CATALOG_LIMITS.hintCharacters);

export const CatalogProviderIdSchema = z
  .string()
  .min(1)
  .max(MODEL_CATALOG_LIMITS.providerIdCharacters)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const CatalogModelIdSchema = z
  .string()
  .min(1)
  .max(MODEL_CATALOG_LIMITS.modelIdCharacters)
  .regex(/^\S+$/);

export const CompatibilityProfileReferenceSchema = z
  .string()
  .min(1)
  .max(MODEL_CATALOG_LIMITS.providerIdCharacters)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const InstalledCompatibilityProfileSchema = z.enum([
  "anthropic-ai-sdk-v1",
  "openai-ai-sdk-v1",
  "openai-astra-v1",
  "google-ai-sdk-v1",
  "openai-codex-v1",
  "claude-cli-v1",
  "codex-agent-v1",
  "deepseek-ai-sdk-v1",
  "alibaba-ai-sdk-v1",
  "openai-compatible-v1",
  "openrouter-ai-sdk-v1",
]);

export const CatalogContextWindowSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("known"),
      tokens: z.number().int().positive().max(MODEL_CATALOG_LIMITS.contextWindowTokens),
    })
    .strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);

export const CatalogImageInputSchema = z.enum([
  "supported",
  "incompatible",
  "provider-metadata",
  "unknown",
]);

const TokenRateSchema = z.number().finite().min(0).max(MODEL_CATALOG_LIMITS.usdPerMillionTokens);

export const CatalogPricingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal("token-rates"),
      inputUsdPerMillion: TokenRateSchema,
      outputUsdPerMillion: TokenRateSchema,
      cacheReadUsdPerMillion: TokenRateSchema,
      cacheWriteUsdPerMillion: TokenRateSchema,
    })
    .strict(),
]);

export const CatalogModelEntrySchema = z
  .object({
    modelId: CatalogModelIdSchema,
    label: DisplayLabelSchema,
    order: OrderedPositionSchema,
    hint: HintSchema.optional(),
    compatibilityProfile: CompatibilityProfileReferenceSchema,
    contextWindow: CatalogContextWindowSchema,
    imageInput: CatalogImageInputSchema,
    pricing: CatalogPricingSchema,
  })
  .strict();

export const CatalogProviderEntrySchema = z
  .object({
    providerId: CatalogProviderIdSchema,
    label: DisplayLabelSchema,
    order: OrderedPositionSchema,
    hint: HintSchema.optional(),
    recommendedModelId: CatalogModelIdSchema.nullable(),
    models: z.array(CatalogModelEntrySchema).max(MODEL_CATALOG_LIMITS.modelsPerProvider),
  })
  .strict()
  .superRefine((provider, context) => {
    const modelIds = new Set<string>();
    for (const [index, model] of provider.models.entries()) {
      if (modelIds.has(model.modelId)) {
        context.addIssue({
          code: "custom",
          path: ["models", index, "modelId"],
          message: "modelId must be unique within its provider",
        });
      }
      modelIds.add(model.modelId);
    }
    if (provider.recommendedModelId !== null && !modelIds.has(provider.recommendedModelId)) {
      context.addIssue({
        code: "custom",
        path: ["recommendedModelId"],
        message: "recommendedModelId must reference a model in this provider",
      });
    }
  });

const CatalogProvidersSchema = z
  .array(CatalogProviderEntrySchema)
  .min(1)
  .max(MODEL_CATALOG_LIMITS.providers)
  .superRefine((providers, context) => {
    const providerIds = new Set<string>();
    for (const [index, provider] of providers.entries()) {
      if (providerIds.has(provider.providerId)) {
        context.addIssue({
          code: "custom",
          path: [index, "providerId"],
          message: "providerId must be unique",
        });
      }
      providerIds.add(provider.providerId);
    }
  });

export const ModelCatalogDraftSchema = z
  .object({
    schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION),
    providers: CatalogProvidersSchema,
  })
  .strict();

export const CatalogProvenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("bundled-seed"),
      establishedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("published"),
      publishedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export const ModelCatalogSnapshotSchema = z
  .object({
    schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION),
    revision: z.number().int().positive().safe(),
    provenance: CatalogProvenanceSchema,
    providers: CatalogProvidersSchema,
  })
  .strict();

const ResolvedModelMetadataSchema = z.object({
  catalogRevision: z.number().int().positive().safe(),
  provider: LlmProviderSchema,
  model: CatalogModelIdSchema,
  contextWindowTokens: z.number().int().positive().max(MODEL_CATALOG_LIMITS.contextWindowTokens),
});

export const ResolvedModelProfileSchema = z
  .discriminatedUnion("kind", [
    ResolvedModelMetadataSchema.extend({
      kind: z.literal("catalog"),
      compatibilityProfile: InstalledCompatibilityProfileSchema,
      imageInput: CatalogImageInputSchema,
      pricing: CatalogPricingSchema,
    }).strict(),
    ResolvedModelMetadataSchema.extend({
      kind: z.literal("custom"),
      imageInput: z.literal("unknown"),
      pricing: z.object({ kind: z.literal("unknown") }).strict(),
    }).strict(),
  ])
  .readonly();

export type CatalogProviderId = z.infer<typeof CatalogProviderIdSchema>;
export type CatalogModelId = z.infer<typeof CatalogModelIdSchema>;
export type CompatibilityProfileReference = z.infer<typeof CompatibilityProfileReferenceSchema>;
export type InstalledCompatibilityProfile = z.infer<typeof InstalledCompatibilityProfileSchema>;
export type CatalogContextWindow = z.infer<typeof CatalogContextWindowSchema>;
export type CatalogImageInput = z.infer<typeof CatalogImageInputSchema>;
export type CatalogPricing = z.infer<typeof CatalogPricingSchema>;
export type CatalogModelEntry = z.infer<typeof CatalogModelEntrySchema>;
export type CatalogProviderEntry = z.infer<typeof CatalogProviderEntrySchema>;
export type CatalogProvenance = z.infer<typeof CatalogProvenanceSchema>;
export type ModelCatalogDraft = z.infer<typeof ModelCatalogDraftSchema>;
export type ModelCatalogSnapshot = z.infer<typeof ModelCatalogSnapshotSchema>;
export type ResolvedModelProfile = z.infer<typeof ResolvedModelProfileSchema>;
