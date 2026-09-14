import { describe, expect, it } from "vitest";
import {
  ModelCatalogDraftSchema,
  ModelCatalogSnapshotSchema,
  ResolvedModelProfileSchema,
  type CatalogModelEntry,
  type CatalogProviderEntry,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";

function model(modelId: string, compatibilityProfile = "openai-ai-sdk-v1"): CatalogModelEntry {
  return {
    modelId,
    label: modelId,
    order: 0,
    compatibilityProfile,
    contextWindow: { kind: "known", tokens: 1_050_000 },
    imageInput: "supported",
    pricing: {
      kind: "token-rates",
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      cacheReadUsdPerMillion: 0,
      cacheWriteUsdPerMillion: 0,
    },
  };
}

function provider(providerId: string, modelId = "shared-model"): CatalogProviderEntry {
  return {
    providerId,
    label: providerId,
    order: 0,
    recommendedModelId: modelId,
    models: [model(modelId)],
  };
}

function snapshot(): ModelCatalogSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    provenance: { kind: "bundled-seed", establishedAt: "2026-09-13T00:00:00.000Z" },
    providers: [provider("openai")],
  };
}

describe("ModelCatalogSnapshotSchema", () => {
  it("accepts the publication draft before revision metadata is assigned", () => {
    const { revision: _revision, provenance: _provenance, ...draft } = snapshot();

    expect(ModelCatalogDraftSchema.parse(draft).providers).toHaveLength(1);
  });

  it("accepts provider-local model identity and structurally valid future references", () => {
    const candidate = snapshot();
    candidate.providers = [provider("openai"), provider("future-provider")];
    candidate.providers[1].models[0].compatibilityProfile = "future-profile-v2";

    expect(ModelCatalogSnapshotSchema.parse(candidate).providers).toHaveLength(2);
  });

  it("distinguishes known zero token rates from unknown pricing", () => {
    const candidate = snapshot();
    candidate.providers[0].models.push({
      ...model("unknown-price"),
      pricing: { kind: "unknown" } as const,
      order: 1,
    });

    const parsed = ModelCatalogSnapshotSchema.parse(candidate);
    expect(parsed.providers[0].models[0].pricing).toEqual({
      kind: "token-rates",
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      cacheReadUsdPerMillion: 0,
      cacheWriteUsdPerMillion: 0,
    });
    expect(parsed.providers[0].models[1].pricing).toEqual({ kind: "unknown" });
  });

  it.each([
    ["unsupported schema", { schemaVersion: 2 }],
    ["zero revision", { revision: 0 }],
    ["empty provider id", { providers: [{ ...provider("openai"), providerId: "" }] }],
    ["oversized label", { providers: [{ ...provider("openai"), label: "x".repeat(129) }] }],
  ])("rejects %s", (_name, patch) => {
    expect(ModelCatalogSnapshotSchema.safeParse({ ...snapshot(), ...patch }).success).toBe(false);
  });

  it.each(["endpoint", "auth", "executable", "enabled", "providerOptions"])(
    "rejects the forbidden %s field",
    (field) => {
      expect(
        ModelCatalogSnapshotSchema.safeParse({ ...snapshot(), [field]: "remote-behavior" }).success,
      ).toBe(false);
      const candidate = snapshot();
      const nested = {
        ...candidate,
        providers: [
          {
            ...candidate.providers[0],
            models: [{ ...candidate.providers[0].models[0], [field]: "remote-behavior" }],
          },
        ],
      };
      expect(ModelCatalogSnapshotSchema.safeParse(nested).success).toBe(false);
    },
  );

  it("rejects duplicate providers", () => {
    const candidate = snapshot();
    candidate.providers.push({ ...provider("openai"), order: 1 });
    expect(ModelCatalogSnapshotSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects duplicate models within one provider", () => {
    const candidate = snapshot();
    candidate.providers[0].models.push({ ...model("shared-model"), order: 1 });
    expect(ModelCatalogSnapshotSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a dangling recommendation", () => {
    const candidate = snapshot();
    candidate.providers[0].recommendedModelId = "absent";
    expect(ModelCatalogSnapshotSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("ResolvedModelProfileSchema", () => {
  it("accepts an installed catalog profile", () => {
    const parsed = ResolvedModelProfileSchema.safeParse({
      kind: "catalog",
      catalogRevision: 1,
      provider: "openai",
      model: "gpt-5.6-sol",
      compatibilityProfile: "openai-ai-sdk-v1",
      contextWindowTokens: 1_050_000,
      imageInput: "supported",
      pricing: { kind: "unknown" },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("resolved profile was not accepted");
    expect(Object.isFrozen(parsed.data)).toBe(true);
  });

  it("rejects unresolved providers and compatibility profiles", () => {
    const profile = {
      kind: "catalog",
      catalogRevision: 1,
      provider: "future-provider",
      model: "future-model",
      compatibilityProfile: "future-profile-v2",
      contextWindowTokens: 200_000,
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    };
    expect(ResolvedModelProfileSchema.safeParse(profile).success).toBe(false);
  });

  it("keeps custom-model metadata conservative", () => {
    const profile = {
      kind: "custom",
      catalogRevision: 1,
      provider: "openai",
      model: "custom-model",
      contextWindowTokens: 200_000,
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    };
    expect(ResolvedModelProfileSchema.safeParse(profile).success).toBe(true);
    expect(
      ResolvedModelProfileSchema.safeParse({ ...profile, imageInput: "supported" }).success,
    ).toBe(false);
  });
});
