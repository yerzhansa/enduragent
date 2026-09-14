import { describe, expect, it, vi } from "vitest";
import {
  createAttachmentCapabilityResolver,
  resolveAttachmentCapabilities,
  transportForProvider,
} from "../src/attachment-capabilities.js";
import type {
  OpenRouterModelMetadataCache,
  OpenRouterModelMetadataSnapshot,
} from "../src/openrouter-model-metadata.js";
import type { CatalogImageInput, ResolvedModelProfile } from "@enduragent/coach-contract";

const DAY = 86_400_000;
const NOW = 2_000_000_000_000;

function active(
  provider: Parameters<typeof transportForProvider>[0],
  model: string,
  imageInput: CatalogImageInput,
) {
  const profile: ResolvedModelProfile = {
    kind: "catalog",
    catalogRevision: 1,
    provider,
    model,
    compatibilityProfile: "openai-ai-sdk-v1",
    contextWindowTokens: 200_000,
    imageInput,
    pricing: { kind: "unknown" },
  };
  return { profile, transport: transportForProvider(provider) };
}

describe("attachment capability resolution", () => {
  it.each([
    ["openai", "gpt-5.6-sol"],
    ["anthropic", "claude-sonnet-5"],
    ["google", "gemini-3.6-flash"],
  ] as const)("enables maintained %s image input", (provider, model) => {
    expect(
      resolveAttachmentCapabilities({
        active: active(provider, model, "supported"),
        nowMs: NOW,
        metadataMaxAgeMs: DAY,
      }).images,
    ).toMatchObject({ enabled: true, source: "maintained_catalogue" });
  });

  it("fails closed for custom models and every bridge transport", () => {
    expect(
      resolveAttachmentCapabilities({
        active: active("openai", "custom-model", "unknown"),
        nowMs: NOW,
        metadataMaxAgeMs: DAY,
      }).images,
    ).toMatchObject({ enabled: false, reason: "unknown_model", source: "unknown" });
    for (const provider of ["openai-codex", "claude-cli", "codex-agent"] as const) {
      expect(
        resolveAttachmentCapabilities({
          active: active(provider, "known-looking-model", "supported"),
          nowMs: NOW,
          metadataMaxAgeMs: DAY,
        }).images,
      ).toMatchObject({
        enabled: false,
        reason: "transport_incompatible",
        source: "transport_blocked",
      });
    }
  });

  it("uses only matching, fresh OpenRouter input-modality metadata", () => {
    const metadata: OpenRouterModelMetadataSnapshot = {
      modelId: "vendor/vision-model",
      inputModalities: ["image", "text"],
      fetchedAtMs: NOW - 1_000,
    };
    expect(
      resolveAttachmentCapabilities({
        active: active("openrouter", metadata.modelId, "provider-metadata"),
        nowMs: NOW,
        metadataMaxAgeMs: DAY,
        openRouterMetadata: metadata,
      }).images,
    ).toMatchObject({ enabled: true, source: "provider_metadata" });
    expect(
      resolveAttachmentCapabilities({
        active: active("openrouter", metadata.modelId, "provider-metadata"),
        nowMs: NOW + DAY + 1_001,
        metadataMaxAgeMs: DAY,
        openRouterMetadata: metadata,
      }).images,
    ).toMatchObject({ enabled: false, reason: "metadata_stale" });
    expect(
      resolveAttachmentCapabilities({
        active: active("openrouter", metadata.modelId, "provider-metadata"),
        nowMs: NOW,
        metadataMaxAgeMs: DAY,
        openRouterMetadata: { ...metadata, inputModalities: ["text"] },
      }).images,
    ).toMatchObject({ enabled: false, reason: "model_incompatible" });
  });

  it("reads a fresh cache without network and preserves stale metadata when refresh is offline", async () => {
    let stored: OpenRouterModelMetadataSnapshot | undefined = {
      modelId: "vendor/vision-model",
      inputModalities: ["image", "text"],
      fetchedAtMs: NOW,
    };
    const cache: OpenRouterModelMetadataCache = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (snapshot) => {
        stored = snapshot;
      }),
    };
    const fetcher = vi.fn<typeof fetch>();
    const resolver = createAttachmentCapabilityResolver({
      openRouterCache: cache,
      metadataMaxAgeMs: DAY,
      now: () => NOW,
      fetch: fetcher,
    });
    await expect(
      resolver.resolve(active("openrouter", stored.modelId, "provider-metadata")),
    ).resolves.toMatchObject({
      images: { enabled: true },
    });
    expect(fetcher).not.toHaveBeenCalled();

    stored = { ...stored, fetchedAtMs: NOW - DAY - 1 };
    fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(
      resolver.resolve(active("openrouter", stored.modelId, "provider-metadata")),
    ).resolves.toMatchObject({
      images: { enabled: false, reason: "metadata_stale" },
    });
  });

  it("refreshes and caches the exact OpenRouter model metadata response", async () => {
    let stored: OpenRouterModelMetadataSnapshot | undefined;
    const cache: OpenRouterModelMetadataCache = {
      read: async () => stored,
      write: async (snapshot) => {
        stored = snapshot;
      },
    };
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              id: "vendor/vision-model",
              architecture: { input_modalities: ["text", "image", "image"] },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const resolver = createAttachmentCapabilityResolver({
      openRouterCache: cache,
      metadataMaxAgeMs: DAY,
      now: () => NOW,
      fetch: fetcher,
    });
    await expect(
      resolver.resolve(active("openrouter", "vendor/vision-model", "provider-metadata")),
    ).resolves.toMatchObject({ images: { enabled: true } });
    expect(stored).toEqual({
      modelId: "vendor/vision-model",
      inputModalities: ["image", "text"],
      fetchedAtMs: NOW,
    });
  });
});
