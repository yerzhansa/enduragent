import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ResolvedModelProfileSchema,
  type CatalogPricing,
  type ResolvedModelProfile,
} from "@enduragent/coach-contract/model-catalog";
import { z } from "zod";
import { atomicWriteFileSync } from "./io/atomic-write-file-sync.js";
import { withInterprocessFileLockSync } from "./io/interprocess-file-lock-sync.js";
import type { AcceptedModelCatalogRecord, EffectiveCatalogModel } from "./model-catalog.js";
import { installedProfileFor } from "./model-catalog-policy.js";
import { isModelEnabledForProvider, type LlmProvider } from "./runtime-config.js";

export const CONSERVATIVE_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;
export const SELECTED_MODEL_PROFILES_FILE = "selected-model-profiles.json";

const SELECTED_MODEL_PROFILES_FORMAT_VERSION = 1;
const SelectedModelProfilesSchema = z
  .object({
    formatVersion: z.literal(SELECTED_MODEL_PROFILES_FORMAT_VERSION),
    profiles: z.array(ResolvedModelProfileSchema).max(3),
  })
  .strict();

export interface ModelRuntimeGeneration {
  readonly catalogRevision: number;
  readonly chat: ResolvedModelProfile;
  readonly compact: ResolvedModelProfile;
  readonly flush: ResolvedModelProfile;
}

export interface ResolveModelRuntimeGenerationInput {
  readonly catalog: AcceptedModelCatalogRecord;
  readonly provider: LlmProvider;
  readonly chatModel: string;
  readonly compactModel: string;
  readonly flushModel: string;
  readonly chatContextWindowTokensOverride?: number;
  readonly profileStorageDirectory: string;
}

function profileKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function freezePricing(pricing: CatalogPricing): CatalogPricing {
  return Object.freeze({ ...pricing });
}

function freezeProfile(profile: ResolvedModelProfile): ResolvedModelProfile {
  if (profile.kind === "custom") {
    return Object.freeze({ ...profile, pricing: Object.freeze({ kind: "unknown" as const }) });
  }
  return Object.freeze({ ...profile, pricing: freezePricing(profile.pricing) });
}

type CatalogModelResolution =
  | { readonly status: "absent" }
  | { readonly status: "incompatible" }
  | { readonly status: "compatible"; readonly model: EffectiveCatalogModel };

function catalogModel(
  catalog: AcceptedModelCatalogRecord,
  provider: LlmProvider,
  model: string,
): CatalogModelResolution {
  const providerEntry = catalog.snapshot.providers.find(
    (candidate) => candidate.providerId === provider,
  );
  const candidate = providerEntry?.models.find((entry) => entry.modelId === model);
  if (candidate === undefined) return { status: "absent" };
  if (!isModelEnabledForProvider(provider, model)) return { status: "incompatible" };
  const compatibilityProfile = installedProfileFor(provider, candidate.compatibilityProfile);
  if (compatibilityProfile === undefined) return { status: "incompatible" };
  return {
    status: "compatible",
    model: {
      modelId: candidate.modelId,
      label: candidate.label,
      ...(candidate.hint === undefined ? {} : { hint: candidate.hint }),
      compatibilityProfile,
      contextWindow: candidate.contextWindow,
      imageInput: candidate.imageInput,
      pricing: candidate.pricing,
    },
  };
}

function customProfile(
  catalogRevision: number,
  provider: LlmProvider,
  model: string,
): ResolvedModelProfile {
  return freezeProfile({
    kind: "custom",
    catalogRevision,
    provider,
    model,
    contextWindowTokens: CONSERVATIVE_MODEL_CONTEXT_WINDOW_TOKENS,
    imageInput: "unknown",
    pricing: { kind: "unknown" },
  });
}

function readPersistedProfiles(path: string): readonly ResolvedModelProfile[] {
  try {
    const parsed = SelectedModelProfilesSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    return parsed.success
      ? parsed.data.profiles.filter(
          (profile) =>
            profile.kind === "custom" ||
            (installedProfileFor(profile.provider, profile.compatibilityProfile) ===
              profile.compatibilityProfile &&
              isModelEnabledForProvider(profile.provider, profile.model)),
        )
      : [];
  } catch {
    return [];
  }
}

function baseProfile(input: {
  readonly catalog: AcceptedModelCatalogRecord;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly persisted: ReadonlyMap<string, ResolvedModelProfile>;
}): ResolvedModelProfile {
  const current = catalogModel(input.catalog, input.provider, input.model);
  if (current.status === "compatible") {
    return freezeProfile({
      kind: "catalog",
      catalogRevision: input.catalog.snapshot.revision,
      provider: input.provider,
      model: input.model,
      compatibilityProfile: current.model.compatibilityProfile,
      contextWindowTokens:
        current.model.contextWindow.kind === "known"
          ? current.model.contextWindow.tokens
          : CONSERVATIVE_MODEL_CONTEXT_WINDOW_TOKENS,
      imageInput: current.model.imageInput,
      pricing: current.model.pricing,
    });
  }
  if (current.status === "incompatible") {
    return customProfile(input.catalog.snapshot.revision, input.provider, input.model);
  }
  const previous = input.persisted.get(profileKey(input.provider, input.model));
  if (previous !== undefined) {
    return freezeProfile({ ...previous, catalogRevision: input.catalog.snapshot.revision });
  }
  return customProfile(input.catalog.snapshot.revision, input.provider, input.model);
}

function runtimeProfile(
  profile: ResolvedModelProfile,
  contextWindowTokensOverride: number | undefined,
): ResolvedModelProfile {
  return contextWindowTokensOverride === undefined
    ? profile
    : freezeProfile({ ...profile, contextWindowTokens: contextWindowTokensOverride });
}

function uniqueProfiles(
  profiles: readonly ResolvedModelProfile[],
): readonly ResolvedModelProfile[] {
  const unique = new Map<string, ResolvedModelProfile>();
  for (const profile of profiles) unique.set(profileKey(profile.provider, profile.model), profile);
  return [...unique.values()];
}

function persistProfiles(
  storageDirectory: string,
  profiles: readonly ResolvedModelProfile[],
): void {
  const directory = resolve(storageDirectory);
  const path = join(directory, SELECTED_MODEL_PROFILES_FILE);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    withInterprocessFileLockSync(join(directory, ".selected-model-profiles.lock"), () => {
      atomicWriteFileSync(
        path,
        `${JSON.stringify({
          formatVersion: SELECTED_MODEL_PROFILES_FORMAT_VERSION,
          profiles: uniqueProfiles(profiles),
        })}\n`,
      );
    });
  } catch {}
}

export function resolveModelRuntimeGeneration(
  input: ResolveModelRuntimeGenerationInput,
): ModelRuntimeGeneration {
  const profilePath = join(resolve(input.profileStorageDirectory), SELECTED_MODEL_PROFILES_FILE);
  const persisted = new Map(
    readPersistedProfiles(profilePath).map((profile) => [
      profileKey(profile.provider, profile.model),
      profile,
    ]),
  );
  const chatBase = baseProfile({
    catalog: input.catalog,
    provider: input.provider,
    model: input.chatModel,
    persisted,
  });
  const compactBase = baseProfile({
    catalog: input.catalog,
    provider: input.provider,
    model: input.compactModel,
    persisted,
  });
  const flushBase = baseProfile({
    catalog: input.catalog,
    provider: input.provider,
    model: input.flushModel,
    persisted,
  });
  persistProfiles(input.profileStorageDirectory, [chatBase, compactBase, flushBase]);
  const chatOverride = input.chatContextWindowTokensOverride;
  const generation = {
    catalogRevision: input.catalog.snapshot.revision,
    chat: runtimeProfile(chatBase, chatOverride),
    compact: runtimeProfile(
      compactBase,
      input.compactModel === input.chatModel ? chatOverride : undefined,
    ),
    flush: runtimeProfile(
      flushBase,
      input.flushModel === input.chatModel ? chatOverride : undefined,
    ),
  } satisfies ModelRuntimeGeneration;
  return Object.freeze(generation);
}
