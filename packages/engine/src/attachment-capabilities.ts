import {
  AttachmentCapabilitiesReadModelSchema,
  isKeylessProvider,
  type AttachmentCapabilitiesReadModel,
  type ResolvedModelProfile,
} from "@enduragent/coach-contract";
import type { EngineLlmProvider } from "./host-ports.js";
import {
  resolveOpenRouterModelMetadata,
  type OpenRouterModelMetadataCache,
  type OpenRouterModelMetadataSnapshot,
} from "./openrouter-model-metadata.js";

export type NativeMediaTransport = "ai-sdk" | "openai-codex" | "claude-cli" | "codex-agent";

export interface ActiveAttachmentModel {
  readonly profile: ResolvedModelProfile;
  readonly transport: NativeMediaTransport;
  readonly apiKey?: string;
}

export interface AttachmentCapabilityResolver {
  resolve(
    active: ActiveAttachmentModel,
    signal?: AbortSignal,
  ): Promise<AttachmentCapabilitiesReadModel>;
}

export interface AttachmentCapabilityResolverOptions {
  readonly openRouterCache: OpenRouterModelMetadataCache;
  readonly metadataMaxAgeMs: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly openRouterBaseUrl?: string;
}

function base(active: ActiveAttachmentModel) {
  return {
    schemaVersion: 1 as const,
    active: {
      provider: active.profile.provider,
      model: active.profile.model,
      transport: active.transport,
    },
    documents: {
      enabled: true as const,
      extensions: ["pdf", "txt", "csv", "docx"] as const,
    },
    completedActivities: {
      enabled: true as const,
      extensions: ["fit", "tcx", "gpx"] as const,
    },
    plannedWorkouts: {
      enabled: true as const,
      extensions: ["zwo", "erg", "mrc"] as const,
    },
  };
}

function checkedAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function enabled(
  active: ActiveAttachmentModel,
  source: "maintained_catalogue" | "provider_metadata",
  epochMs: number,
): AttachmentCapabilitiesReadModel {
  return AttachmentCapabilitiesReadModelSchema.parse({
    ...base(active),
    images: {
      enabled: true,
      mediaTypes: ["image/png", "image/jpeg", "image/webp"],
      reason: "supported",
      source,
      checkedAt: checkedAt(epochMs),
    },
  });
}

function disabled(
  active: ActiveAttachmentModel,
  reason: AttachmentCapabilitiesReadModel["images"] extends infer Images
    ? Images extends { readonly enabled: false; readonly reason: infer Reason }
      ? Reason
      : never
    : never,
  source: "maintained_catalogue" | "provider_metadata" | "unknown" | "transport_blocked",
  epochMs: number,
): AttachmentCapabilitiesReadModel {
  return AttachmentCapabilitiesReadModelSchema.parse({
    ...base(active),
    images: { enabled: false, mediaTypes: [], reason, source, checkedAt: checkedAt(epochMs) },
  });
}

export function transportForProvider(provider: EngineLlmProvider): NativeMediaTransport {
  if (isKeylessProvider(provider)) return provider;
  return "ai-sdk";
}

export function resolveAttachmentCapabilities(input: {
  readonly active: ActiveAttachmentModel;
  readonly nowMs: number;
  readonly metadataMaxAgeMs: number;
  readonly openRouterMetadata?: OpenRouterModelMetadataSnapshot;
}): AttachmentCapabilitiesReadModel {
  const { active, nowMs } = input;
  if (active.transport !== "ai-sdk") {
    return disabled(active, "transport_incompatible", "transport_blocked", nowMs);
  }
  if (active.profile.provider === "openrouter") {
    const metadata = input.openRouterMetadata;
    if (metadata === undefined || metadata.modelId !== active.profile.model) {
      return disabled(active, "unknown_model", "unknown", nowMs);
    }
    if (metadata.fetchedAtMs > nowMs || nowMs - metadata.fetchedAtMs > input.metadataMaxAgeMs) {
      return disabled(active, "metadata_stale", "provider_metadata", metadata.fetchedAtMs);
    }
    return metadata.inputModalities.includes("image")
      ? enabled(active, "provider_metadata", metadata.fetchedAtMs)
      : disabled(active, "model_incompatible", "provider_metadata", metadata.fetchedAtMs);
  }
  switch (active.profile.imageInput) {
    case "supported":
      return enabled(active, "maintained_catalogue", nowMs);
    case "incompatible":
      return disabled(active, "model_incompatible", "maintained_catalogue", nowMs);
    case "provider-metadata":
    case "unknown":
      return disabled(active, "unknown_model", "unknown", nowMs);
  }
}

export function createAttachmentCapabilityResolver(
  options: AttachmentCapabilityResolverOptions,
): AttachmentCapabilityResolver {
  return Object.freeze({
    async resolve(active: ActiveAttachmentModel, signal?: AbortSignal) {
      const now = options.now ?? Date.now;
      const openRouterMetadata =
        active.profile.provider === "openrouter"
          ? await resolveOpenRouterModelMetadata({
              modelId: active.profile.model,
              cache: options.openRouterCache,
              maxAgeMs: options.metadataMaxAgeMs,
              now,
              ...(active.apiKey === undefined ? {} : { apiKey: active.apiKey }),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
              ...(signal === undefined ? {} : { signal }),
              ...(options.openRouterBaseUrl === undefined
                ? {}
                : { baseUrl: options.openRouterBaseUrl }),
            })
          : undefined;
      return resolveAttachmentCapabilities({
        active,
        nowMs: now(),
        metadataMaxAgeMs: options.metadataMaxAgeMs,
        openRouterMetadata,
      });
    },
  });
}
