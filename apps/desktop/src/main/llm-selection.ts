import {
  claudeCliDisabledByEnvironment,
  LLM_PROVIDERS,
  PROVIDER_BASE_URLS,
  modelCatalogSelectorConfiguration,
  type AcceptedModelCatalogRecord,
  type LlmProvider,
} from "@enduragent/core";
import type { ConfigureRuntimeRpcParams, ModelCatalogSnapshot } from "@enduragent/coach-contract";

export interface OnboardingLlmModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface OnboardingLlmProviderConfiguration {
  readonly provider: LlmProvider;
  readonly defaultModel: string;
  readonly models: readonly OnboardingLlmModelOption[];
  readonly defaultBaseUrl?: string;
}

export interface OnboardingLlmConfiguration {
  readonly schemaVersion: 1;
  readonly catalogRevision: number;
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: {
    readonly provider: LlmProvider;
    readonly model: string;
  } | null;
}

export type OnboardingLlmEndpointSelection =
  | { readonly mode: "automatic" }
  | { readonly mode: "default" }
  | { readonly mode: "custom"; readonly value: string };

export interface OnboardingLlmSelection {
  readonly catalogRevision: number;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly endpoint: OnboardingLlmEndpointSelection;
}

export type OnboardingLlmSelectionResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | {
      readonly status: "stale-draft";
      readonly reason: "catalog-unavailable";
      readonly selection: OnboardingLlmSelection;
    }
  | {
      readonly status: "refused";
      readonly reason: "invalid-input" | "credential-required" | "runtime-unavailable";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    value !== null && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function normalizedText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new TypeError();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) throw new TypeError();
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "[::1]") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet)) &&
    Number(octets[0]) === 127 &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

function normalizedEndpoint(value: unknown): string {
  const normalized = normalizedText(value, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.href.includes("?") ||
    parsed.href.includes("#") ||
    parsed.hostname.length === 0 ||
    (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname))
  ) {
    throw new TypeError();
  }
  return normalized;
}

export function parseOnboardingLlmSelection(value: unknown): OnboardingLlmSelection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["catalogRevision", "provider", "model", "endpoint"])
  ) {
    throw new TypeError();
  }
  if (!Number.isSafeInteger(value.catalogRevision) || Number(value.catalogRevision) <= 0) {
    throw new TypeError();
  }
  if (
    typeof value.provider !== "string" ||
    !(LLM_PROVIDERS as readonly string[]).includes(value.provider)
  ) {
    throw new TypeError();
  }
  const provider = value.provider as LlmProvider;
  const model = normalizedText(value.model, 512);
  if (!isRecord(value.endpoint) || typeof value.endpoint.mode !== "string") {
    throw new TypeError();
  }
  let endpoint: OnboardingLlmEndpointSelection;
  if (value.endpoint.mode === "automatic" && hasExactKeys(value.endpoint, ["mode"])) {
    endpoint = { mode: "automatic" };
  } else if (value.endpoint.mode === "default" && hasExactKeys(value.endpoint, ["mode"])) {
    endpoint = { mode: "default" };
  } else if (value.endpoint.mode === "custom" && hasExactKeys(value.endpoint, ["mode", "value"])) {
    endpoint = { mode: "custom", value: normalizedEndpoint(value.endpoint.value) };
  } else {
    throw new TypeError();
  }
  if (
    endpoint.mode !== "automatic" &&
    PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS] === undefined
  ) {
    throw new TypeError();
  }
  return { catalogRevision: Number(value.catalogRevision), provider, model, endpoint };
}

export function parseChatGptLlmSelection(value: unknown): OnboardingLlmSelection & {
  readonly provider: "openai-codex";
  readonly endpoint: { readonly mode: "automatic" };
} {
  const selection = parseOnboardingLlmSelection(value);
  if (selection.provider !== "openai-codex" || selection.endpoint.mode !== "automatic") {
    throw new TypeError();
  }
  return selection as OnboardingLlmSelection & {
    readonly provider: "openai-codex";
    readonly endpoint: { readonly mode: "automatic" };
  };
}

export type ClaudeCliLlmSelection = OnboardingLlmSelection & {
  readonly provider: "claude-cli";
  readonly endpoint: { readonly mode: "automatic" };
};

export function parseClaudeCliLlmSelection(value: unknown): ClaudeCliLlmSelection {
  const selection = parseOnboardingLlmSelection(value);
  if (selection.provider !== "claude-cli" || selection.endpoint.mode !== "automatic") {
    throw new TypeError();
  }
  return selection as ClaudeCliLlmSelection;
}

export function isClaudeCliLaneEligible(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly enabled?: boolean;
}): boolean {
  if (input.enabled === false) return false;
  return !claudeCliDisabledByEnvironment(input.environment);
}

export function runtimeConfigurationForSelection(
  selection: OnboardingLlmSelection,
  apiKey?: string,
  catalogSnapshot?: ModelCatalogSnapshot,
): ConfigureRuntimeRpcParams {
  const endpoint =
    selection.endpoint.mode === "automatic"
      ? {}
      : selection.endpoint.mode === "default"
        ? { base_url: null }
        : { base_url: selection.endpoint.value };
  return {
    llm: {
      provider: selection.provider,
      model: selection.model,
      ...(apiKey === undefined ? {} : { api_key: apiKey }),
      ...endpoint,
      ...(catalogSnapshot === undefined ? {} : { catalog_snapshot: catalogSnapshot }),
    },
  };
}

export function runtimeConfigurationForExistingSelection(
  selection: OnboardingLlmSelection,
  catalogSnapshot?: ModelCatalogSnapshot,
): ConfigureRuntimeRpcParams {
  const endpoint =
    selection.endpoint.mode === "automatic"
      ? {}
      : selection.endpoint.mode === "default"
        ? { base_url: null }
        : { base_url: selection.endpoint.value };
  return {
    llm: {
      model: selection.model,
      ...endpoint,
      ...(catalogSnapshot === undefined ? {} : { catalog_snapshot: catalogSnapshot }),
    },
  };
}

export function publicLlmProviderConfiguration(
  catalog: AcceptedModelCatalogRecord,
): readonly OnboardingLlmProviderConfiguration[] {
  return modelCatalogSelectorConfiguration(catalog).providers.map((entry) => ({
    provider: entry.provider,
    defaultModel: entry.defaultModel,
    models: entry.models.map((model) => ({
      value: model.value,
      label: model.label,
      ...(model.hint === undefined ? {} : { hint: model.hint }),
    })),
    ...(entry.defaultBaseUrl === undefined ? {} : { defaultBaseUrl: entry.defaultBaseUrl }),
  }));
}
