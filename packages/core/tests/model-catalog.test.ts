import { describe, expect, it } from "vitest";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import {
  acceptModelCatalogSnapshot,
  evaluateModelCatalogCandidate,
  modelCatalogSelectorConfiguration,
} from "../src/model-catalog.js";

function cloneSeed() {
  return structuredClone(BUNDLED_MODEL_CATALOG);
}

function acceptedSeed() {
  const record = acceptModelCatalogSnapshot(BUNDLED_MODEL_CATALOG, "seed-etag");
  if (record === undefined) throw new Error("bundled seed was not accepted");
  return record;
}

describe("model catalog compatibility filtering", () => {
  it("projects the accepted revision, published order, and compatible model choices", () => {
    const candidate = cloneSeed();
    candidate.revision = 7;
    candidate.providers = candidate.providers.map((provider) => ({
      ...provider,
      order: candidate.providers.length - provider.order,
    }));
    const openai = candidate.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("missing OpenAI seed provider");
    openai.models.push({
      modelId: "new-compatible-model",
      label: "New Compatible Model",
      order: 40,
      compatibilityProfile: "openai-ai-sdk-v1",
      contextWindow: { kind: "unknown" },
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });

    const accepted = acceptModelCatalogSnapshot(candidate);
    if (accepted === undefined) throw new Error("candidate was not accepted");
    const configuration = modelCatalogSelectorConfiguration(accepted);

    expect(configuration.revision).toBe(7);
    expect(configuration.providers[0]?.provider).toBe("openrouter");
    expect(
      configuration.providers
        .find((provider) => provider.provider === "openai")
        ?.models.map((model) => model.value),
    ).toContain("new-compatible-model");
  });

  it("keeps a provider available for custom entry when all published models are incompatible", () => {
    const candidate = cloneSeed();
    const openai = candidate.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("missing OpenAI seed provider");
    openai.models = openai.models.map((model) => ({
      ...model,
      compatibilityProfile: "future-profile-v2",
    }));

    const accepted = acceptModelCatalogSnapshot(candidate);
    if (accepted === undefined) throw new Error("candidate was not accepted");
    const provider = modelCatalogSelectorConfiguration(accepted).providers.find(
      (entry) => entry.provider === "openai",
    );

    expect(provider).toMatchObject({
      provider: "openai",
      defaultModel: "gpt-5.6-sol",
      models: [],
    });
  });

  it("filters future providers and profiles while accepting compatible new models", () => {
    const candidate = cloneSeed();
    candidate.revision = 2;
    const openai = candidate.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("missing OpenAI seed provider");
    openai.models.push({
      modelId: "future-compatible-model",
      label: "Future Compatible Model",
      order: 3,
      compatibilityProfile: "openai-ai-sdk-v1",
      contextWindow: { kind: "unknown" },
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });
    candidate.providers.push({
      providerId: "future-provider",
      label: "Future Provider",
      order: 20,
      recommendedModelId: "shared-model",
      models: [
        {
          modelId: "shared-model",
          label: "Shared Model",
          order: 0,
          compatibilityProfile: "future-profile-v2",
          contextWindow: { kind: "unknown" },
          imageInput: "unknown",
          pricing: { kind: "unknown" },
        },
      ],
    });

    const accepted = acceptModelCatalogSnapshot(candidate, "candidate-etag");
    expect(accepted?.effective.providers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "future-provider" })]),
    );
    const effectiveOpenai = accepted?.effective.providers.find(
      (provider) => provider.provider === "openai",
    );
    expect(effectiveOpenai).toMatchObject({ kind: "suggested" });
    if (effectiveOpenai?.kind !== "suggested") throw new Error("OpenAI is not suggested");
    expect(effectiveOpenai.models.map((model) => model.modelId)).toContain(
      "future-compatible-model",
    );
  });

  it("repairs a filtered recommendation with the first eligible choice", () => {
    const candidate = cloneSeed();
    candidate.revision = 2;
    const openai = candidate.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("missing OpenAI seed provider");
    openai.models = openai.models.map((model, index) => ({
      ...model,
      order: index,
      compatibilityProfile:
        model.modelId === openai.recommendedModelId
          ? "future-profile-v2"
          : model.compatibilityProfile,
    }));

    const accepted = acceptModelCatalogSnapshot(candidate, "candidate-etag");
    const effectiveOpenai = accepted?.effective.providers.find(
      (provider) => provider.provider === "openai",
    );
    expect(effectiveOpenai).toMatchObject({
      kind: "suggested",
      initialModel: "gpt-5.6-terra",
    });
  });

  it("prefers the compiled recommendation when a different published recommendation is filtered", () => {
    const candidate = cloneSeed();
    candidate.revision = 2;
    const openai = candidate.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("missing OpenAI seed provider");
    openai.recommendedModelId = "gpt-5.6-luna";
    openai.models = openai.models.map((model) => ({
      ...model,
      compatibilityProfile:
        model.modelId === "gpt-5.6-luna" ? "future-profile-v2" : model.compatibilityProfile,
    }));

    const accepted = acceptModelCatalogSnapshot(candidate, "candidate-etag");
    expect(
      accepted?.effective.providers.find((provider) => provider.provider === "openai"),
    ).toMatchObject({ kind: "suggested", initialModel: "gpt-5.6-sol" });
  });

  it("filters models refused by the compiled provider eligibility policy", () => {
    const candidate = cloneSeed();
    candidate.revision = 2;
    const codex = candidate.providers.find((provider) => provider.providerId === "openai-codex");
    if (codex === undefined) throw new Error("missing OpenAI Codex seed provider");
    codex.recommendedModelId = "gpt-6-astra";
    codex.models.unshift({
      modelId: "gpt-6-astra",
      label: "GPT-6 Astra",
      order: 2,
      compatibilityProfile: "openai-codex-v1",
      contextWindow: { kind: "unknown" },
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });

    const accepted = acceptModelCatalogSnapshot(candidate, "candidate-etag");
    const effectiveCodex = accepted?.effective.providers.find(
      (provider) => provider.provider === "openai-codex",
    );
    expect(effectiveCodex).toMatchObject({ kind: "suggested", initialModel: "gpt-5.6-sol" });
    if (effectiveCodex?.kind !== "suggested") {
      throw new Error("OpenAI Codex is not suggested");
    }
    expect(effectiveCodex.models.map((model) => model.modelId)).not.toContain("gpt-6-astra");
  });

  it("represents an installed provider with no compatible entries as custom-only", () => {
    const candidate = cloneSeed();
    candidate.revision = 2;
    const openai = candidate.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("missing OpenAI seed provider");
    openai.models = openai.models.map((model) => ({
      ...model,
      compatibilityProfile: "future-profile-v2",
    }));

    const accepted = acceptModelCatalogSnapshot(candidate, "candidate-etag");
    expect(
      accepted?.effective.providers.find((provider) => provider.provider === "openai"),
    ).toMatchObject({ kind: "custom-only", provider: "openai" });
  });

  it("retains the exact prior record for invalid data", () => {
    const previous = acceptedSeed();
    const candidate = { ...cloneSeed(), endpoint: "https://attacker.invalid" };
    const result = evaluateModelCatalogCandidate(candidate, "candidate-etag", previous);
    expect(result).toEqual({ kind: "retained", reason: "invalid", record: previous });
    expect(result.record).toBe(previous);
  });

  it("retains the exact prior snapshot, revision, and ETag when filtering removes all choices", () => {
    const previous = acceptedSeed();
    const candidate = cloneSeed();
    candidate.revision = 2;
    candidate.providers = [
      {
        providerId: "future-provider",
        label: "Future Provider",
        order: 0,
        recommendedModelId: "future-model",
        models: [
          {
            modelId: "future-model",
            label: "Future Model",
            order: 0,
            compatibilityProfile: "future-profile-v2",
            contextWindow: { kind: "unknown" },
            imageInput: "unknown",
            pricing: { kind: "unknown" },
          },
        ],
      },
    ];

    const result = evaluateModelCatalogCandidate(candidate, "candidate-etag", previous);
    expect(result).toEqual({ kind: "retained", reason: "no-usable-choices", record: previous });
    expect(result.record).toBe(previous);
    expect(result.record.snapshot.revision).toBe(1);
    expect(result.record.etag).toBe("seed-etag");
  });
});
