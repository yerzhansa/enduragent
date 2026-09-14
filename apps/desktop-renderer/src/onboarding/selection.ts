import type {
  OnboardingLlmConfiguration,
  OnboardingLlmEndpointSelection,
  OnboardingLlmProviderConfiguration,
  OnboardingLlmSelection,
} from "./bridge";
import { CUSTOM_MODEL_SELECTION } from "./constants";
import type { ChatGptStatus, CredentialSlotStatus, OnboardingErrorCode } from "./machine";

export interface LlmSelectionDraft {
  readonly catalogRevision: number;
  readonly provider: OnboardingLlmProviderConfiguration;
  readonly modelChoice: string;
  readonly customModel: string;
  readonly endpointMode: OnboardingLlmEndpointSelection["mode"];
  readonly customEndpoint: string;
}

export function draftForProvider(
  provider: OnboardingLlmProviderConfiguration,
  catalogRevision: number,
): LlmSelectionDraft {
  const defaultIsSuggested = provider.models.some((model) => model.value === provider.defaultModel);
  return {
    catalogRevision,
    provider,
    modelChoice: defaultIsSuggested ? provider.defaultModel : CUSTOM_MODEL_SELECTION,
    customModel: defaultIsSuggested ? "" : provider.defaultModel,
    endpointMode: "automatic",
    customEndpoint: "",
  };
}

export function initialLlmDraft(
  configuration: OnboardingLlmConfiguration,
  statuses: readonly CredentialSlotStatus[],
  chatGptStatus: ChatGptStatus,
): LlmSelectionDraft | undefined {
  const activeCredential = statuses.find(
    (status) => status.slot !== "intervals-icu" && status.runtimeState === "active",
  );
  const preferredProvider =
    configuration.active?.provider ??
    activeCredential?.slot ??
    (chatGptStatus.state === "configured" && chatGptStatus.runtimeReady
      ? "openai-codex"
      : undefined);
  const provider =
    configuration.providers.find((entry) => entry.provider === preferredProvider) ??
    configuration.providers[0];
  if (provider === undefined) return undefined;
  const active = configuration.active;
  const activeModel = active?.provider === provider.provider ? active.model : provider.defaultModel;
  const knownModel = provider.models.some((model) => model.value === activeModel);
  return {
    catalogRevision: configuration.catalogRevision,
    provider,
    modelChoice: knownModel ? activeModel : CUSTOM_MODEL_SELECTION,
    customModel: knownModel ? "" : activeModel,
    endpointMode: "automatic",
    customEndpoint: "",
  };
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validCustomEndpoint(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  ) {
    return false;
  }
  if (url.protocol === "https:") return true;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet)) &&
    Number(octets[0]) === 127 &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

export function llmSelectionFromDraft(
  draft: LlmSelectionDraft | undefined,
):
  | { readonly selection: OnboardingLlmSelection; readonly error: null }
  | { readonly selection: null; readonly error: OnboardingErrorCode } {
  if (draft === undefined) return { selection: null, error: "configuration-unavailable" };
  const model =
    draft.modelChoice === CUSTOM_MODEL_SELECTION ? draft.customModel.trim() : draft.modelChoice;
  if (
    model.length === 0 ||
    model.length > 512 ||
    model.trim() !== model ||
    hasControlCharacters(model)
  ) {
    return { selection: null, error: "model-selection-required" };
  }
  if (draft.provider.defaultBaseUrl === undefined && draft.endpointMode !== "automatic") {
    return { selection: null, error: "endpoint-invalid" };
  }
  let endpoint: OnboardingLlmEndpointSelection;
  if (draft.endpointMode === "custom") {
    const value = draft.customEndpoint.trim();
    if (!validCustomEndpoint(value)) return { selection: null, error: "endpoint-invalid" };
    endpoint = { mode: "custom", value };
  } else {
    endpoint = { mode: draft.endpointMode };
  }
  return {
    selection: {
      catalogRevision: draft.catalogRevision,
      provider: draft.provider.provider,
      model,
      endpoint,
    },
    error: null,
  };
}
