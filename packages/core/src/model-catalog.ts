import {
  ModelCatalogSnapshotSchema,
  type CatalogContextWindow,
  type CatalogImageInput,
  type CatalogPricing,
  type InstalledCompatibilityProfile,
  type ModelCatalogSnapshot,
} from "@enduragent/coach-contract/model-catalog";
import { installedProfileFor, type VisibleModelCatalogProvider } from "./model-catalog-policy.js";
import { BUNDLED_MODEL_CATALOG } from "./model-catalog-seed.js";
import {
  DEFAULT_MODELS,
  LLM_MODEL_CATALOGUE,
  PROVIDER_BASE_URLS,
  isModelEnabledForProvider,
  type LlmModelOption,
} from "./runtime-config.js";

export interface EffectiveCatalogModel {
  readonly modelId: string;
  readonly label: string;
  readonly hint?: string;
  readonly compatibilityProfile: InstalledCompatibilityProfile;
  readonly contextWindow: CatalogContextWindow;
  readonly imageInput: CatalogImageInput;
  readonly pricing: CatalogPricing;
}

export type EffectiveCatalogProvider =
  | Readonly<{
      kind: "suggested";
      provider: VisibleModelCatalogProvider;
      label: string;
      hint?: string;
      initialModel: string;
      models: readonly [EffectiveCatalogModel, ...EffectiveCatalogModel[]];
    }>
  | Readonly<{
      kind: "custom-only";
      provider: VisibleModelCatalogProvider;
      label: string;
      hint?: string;
    }>;

export interface EffectiveModelCatalog {
  readonly revision: number;
  readonly provenance: ModelCatalogSnapshot["provenance"];
  readonly providers: readonly EffectiveCatalogProvider[];
}

export interface AcceptedModelCatalogRecord {
  readonly snapshot: ModelCatalogSnapshot;
  readonly effective: EffectiveModelCatalog;
  readonly etag?: string;
}

export interface ModelCatalogSelectorProvider {
  readonly provider: VisibleModelCatalogProvider;
  readonly label: string;
  readonly hint?: string;
  readonly defaultModel: string;
  readonly models: readonly LlmModelOption[];
  readonly defaultBaseUrl?: string;
}

export interface ModelCatalogSelectorConfiguration {
  readonly revision: number;
  readonly providers: readonly ModelCatalogSelectorProvider[];
}

export type ModelCatalogCandidateEvaluation =
  | Readonly<{ kind: "accepted"; record: AcceptedModelCatalogRecord }>
  | Readonly<{
      kind: "retained";
      reason: "invalid" | "no-usable-choices";
      record: AcceptedModelCatalogRecord;
    }>;

function effectiveProvider(
  compiled: (typeof LLM_MODEL_CATALOGUE)[number],
  remote: ModelCatalogSnapshot["providers"][number] | undefined,
): EffectiveCatalogProvider {
  const label = remote?.label ?? compiled.label;
  const hint = remote?.hint ?? compiled.hint;
  const models = (remote?.models ?? [])
    .slice()
    .sort((left, right) => left.order - right.order)
    .flatMap((model): EffectiveCatalogModel[] => {
      const compatibilityProfile = installedProfileFor(
        compiled.provider,
        model.compatibilityProfile,
      );
      if (
        compatibilityProfile === undefined ||
        !isModelEnabledForProvider(compiled.provider, model.modelId)
      ) {
        return [];
      }
      return [
        Object.freeze({
          modelId: model.modelId,
          label: model.label,
          ...(model.hint === undefined ? {} : { hint: model.hint }),
          compatibilityProfile,
          contextWindow: model.contextWindow,
          imageInput: model.imageInput,
          pricing: model.pricing,
        }),
      ];
    });
  const [first, ...rest] = models;
  if (first === undefined) {
    return Object.freeze({
      kind: "custom-only",
      provider: compiled.provider,
      label,
      ...(hint === undefined ? {} : { hint }),
    });
  }
  const modelIds = new Set(models.map((model) => model.modelId));
  const initialModel =
    remote?.recommendedModelId !== null &&
    remote?.recommendedModelId !== undefined &&
    modelIds.has(remote.recommendedModelId)
      ? remote.recommendedModelId
      : modelIds.has(compiled.defaultModel)
        ? compiled.defaultModel
        : first.modelId;
  const modelChoices: readonly [EffectiveCatalogModel, ...EffectiveCatalogModel[]] = [
    first,
    ...rest,
  ];
  return Object.freeze({
    kind: "suggested",
    provider: compiled.provider,
    label,
    ...(hint === undefined ? {} : { hint }),
    initialModel,
    models: Object.freeze(modelChoices),
  });
}

function deriveEffectiveCatalog(snapshot: ModelCatalogSnapshot): EffectiveModelCatalog {
  const remoteByProvider = new Map(
    snapshot.providers.map((provider) => [provider.providerId, provider]),
  );
  const compiledOrder = new Map(
    LLM_MODEL_CATALOGUE.map((provider, index) => [provider.provider, index]),
  );
  const providers = LLM_MODEL_CATALOGUE.map((compiled) => ({
    choice: effectiveProvider(compiled, remoteByProvider.get(compiled.provider)),
    order:
      remoteByProvider.get(compiled.provider)?.order ??
      100_000 + (compiledOrder.get(compiled.provider) ?? 0),
  }))
    .sort((left, right) => left.order - right.order)
    .map(({ choice }) => choice);
  return Object.freeze({
    revision: snapshot.revision,
    provenance: snapshot.provenance,
    providers: Object.freeze(providers),
  });
}

function suggestedProviderIds(catalog: EffectiveModelCatalog): ReadonlySet<string> {
  return new Set(
    catalog.providers.flatMap((provider) =>
      provider.kind === "suggested" ? [provider.provider] : [],
    ),
  );
}

const BUNDLED_SUGGESTED_PROVIDER_IDS = suggestedProviderIds(
  deriveEffectiveCatalog(BUNDLED_MODEL_CATALOG),
);

/** Live catalogs must keep every bundled suggested provider as suggested. */
export function catalogMeetsBundledUsableBar(catalog: EffectiveModelCatalog): boolean {
  const suggested = suggestedProviderIds(catalog);
  return (
    suggested.size > 0 &&
    [...BUNDLED_SUGGESTED_PROVIDER_IDS].every((provider) => suggested.has(provider))
  );
}

export function bundledAcceptedCatalog(): AcceptedModelCatalogRecord {
  const accepted = acceptModelCatalogSnapshot(BUNDLED_MODEL_CATALOG);
  if (accepted === undefined) {
    throw new Error("Bundled model catalog has no usable choices");
  }
  return accepted;
}

export function acceptModelCatalogSnapshot(
  candidate: unknown,
  etag?: string,
): AcceptedModelCatalogRecord | undefined {
  const parsed = ModelCatalogSnapshotSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const effective = deriveEffectiveCatalog(parsed.data);
  if (!effective.providers.some((provider) => provider.kind === "suggested")) return undefined;
  return Object.freeze({
    snapshot: parsed.data,
    effective,
    ...(etag === undefined ? {} : { etag }),
  });
}

export function modelCatalogSelectorConfiguration(
  catalog: AcceptedModelCatalogRecord,
): ModelCatalogSelectorConfiguration {
  const providers = catalog.effective.providers.map((provider) => {
    const models =
      provider.kind === "suggested"
        ? provider.models.map((model) =>
            Object.freeze({
              value: model.modelId,
              label: model.label,
              ...(model.hint === undefined ? {} : { hint: model.hint }),
            }),
          )
        : [];
    const defaultBaseUrl = PROVIDER_BASE_URLS[provider.provider as keyof typeof PROVIDER_BASE_URLS];
    return Object.freeze({
      provider: provider.provider,
      label: provider.label,
      ...(provider.hint === undefined ? {} : { hint: provider.hint }),
      defaultModel:
        provider.kind === "suggested" ? provider.initialModel : DEFAULT_MODELS[provider.provider],
      models: Object.freeze(models),
      ...(defaultBaseUrl === undefined ? {} : { defaultBaseUrl }),
    });
  });
  return Object.freeze({
    revision: catalog.effective.revision,
    providers: Object.freeze(providers),
  });
}

export function evaluateModelCatalogCandidate(
  candidate: unknown,
  etag: string | undefined,
  previous: AcceptedModelCatalogRecord,
): ModelCatalogCandidateEvaluation {
  const parsed = ModelCatalogSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    return Object.freeze({ kind: "retained", reason: "invalid", record: previous });
  }
  const accepted = acceptModelCatalogSnapshot(parsed.data, etag);
  return accepted === undefined || !catalogMeetsBundledUsableBar(accepted.effective)
    ? Object.freeze({ kind: "retained", reason: "no-usable-choices", record: previous })
    : Object.freeze({ kind: "accepted", record: accepted });
}
