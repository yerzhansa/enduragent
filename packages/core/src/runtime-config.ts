import {
  CODEX_AGENT_DISABLED_MESSAGE,
  CODEX_AGENT_WINDOWS_MESSAGE,
  KEYLESS_LLM_PROVIDERS,
  isKeylessProvider,
  type CatalogModelEntry,
  type KeylessLlmProvider,
} from "@enduragent/coach-contract";
import { GENERATED_MODEL_CATALOG_SEED } from "./model-catalog-seed.generated.js";

export { KEYLESS_LLM_PROVIDERS, isKeylessProvider };
export type { KeylessLlmProvider };

export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "claude-cli",
  "codex-agent",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export function isModelEnabledForProvider(provider: LlmProvider, model: string): boolean {
  return model !== "gpt-6-astra" || (provider !== "openai-codex" && provider !== "codex-agent");
}

export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-sol",
  google: "gemini-3.6-flash",
  "openai-codex": "gpt-5.6-sol",
  "claude-cli": "sonnet",
  "codex-agent": "gpt-5.6-sol",
  deepseek: "deepseek-v4-flash",
  qwen: "qwen3.7-plus",
  minimax: "MiniMax-M3",
  kimi: "kimi-k3",
  zai: "glm-4.7",
  openrouter: "deepseek/deepseek-v4-flash",
} as const satisfies Record<LlmProvider, string>;

export const PROVIDER_BASE_URLS = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.io/v1",
  kimi: "https://api.moonshot.ai/v1",
  zai: "https://api.z.ai/api/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
} as const satisfies Partial<Record<LlmProvider, string>>;

export interface LlmModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface LlmModelCatalogueEntry {
  readonly provider: LlmProvider;
  readonly label: string;
  readonly hint?: string;
  readonly defaultModel: string;
  readonly defaultBaseUrl?: string;
}

export const LLM_MODEL_CATALOGUE: readonly LlmModelCatalogueEntry[] = [
  {
    provider: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: DEFAULT_MODELS.anthropic,
  },
  {
    provider: "openai",
    label: "OpenAI (GPT)",
    defaultModel: DEFAULT_MODELS.openai,
  },
  {
    provider: "google",
    label: "Google (Gemini)",
    defaultModel: DEFAULT_MODELS.google,
  },
  {
    provider: "openai-codex",
    label: "OpenAI Codex (ChatGPT subscription)",
    hint: "experimental",
    defaultModel: DEFAULT_MODELS["openai-codex"],
  },
  {
    provider: "claude-cli",
    label: "Claude subscription (Claude Code CLI)",
    hint: "experimental",
    defaultModel: DEFAULT_MODELS["claude-cli"],
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    defaultModel: DEFAULT_MODELS.deepseek,
    defaultBaseUrl: PROVIDER_BASE_URLS.deepseek,
  },
  {
    provider: "qwen",
    label: "Qwen (Alibaba Model Studio)",
    defaultModel: DEFAULT_MODELS.qwen,
    defaultBaseUrl: PROVIDER_BASE_URLS.qwen,
  },
  {
    provider: "minimax",
    label: "MiniMax",
    defaultModel: DEFAULT_MODELS.minimax,
    defaultBaseUrl: PROVIDER_BASE_URLS.minimax,
  },
  {
    provider: "kimi",
    label: "Kimi (Moonshot AI)",
    defaultModel: DEFAULT_MODELS.kimi,
    defaultBaseUrl: PROVIDER_BASE_URLS.kimi,
  },
  {
    provider: "zai",
    label: "Z.AI (GLM)",
    defaultModel: DEFAULT_MODELS.zai,
    defaultBaseUrl: PROVIDER_BASE_URLS.zai,
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    hint: "one key, many models",
    defaultModel: DEFAULT_MODELS.openrouter,
    defaultBaseUrl: PROVIDER_BASE_URLS.openrouter,
  },
] as const;

export const COMPACT_MODEL_DEFAULTS = {
  anthropic: "claude-haiku-4-5-20251001",
  "claude-cli": "haiku",
  openrouter: "deepseek/deepseek-v4-flash",
} as const satisfies Partial<Record<LlmProvider, string>>;

export const CLAUDE_CLI_BILLING_MODES = ["subscription", "api-key"] as const;

export type ClaudeCliBilling = (typeof CLAUDE_CLI_BILLING_MODES)[number];

export interface ClaudeCliRuntimeSettings {
  enabled: boolean;
  binaryPath?: string;
  configDir?: string;
  billing: ClaudeCliBilling;
}

export const CLAUDE_CLI_DISABLED_MESSAGE =
  "The Claude CLI provider is disabled on this instance (ENDURAGENT_CLAUDE_CLI_DISABLED or llm.claude_cli.enabled: false). Choose another provider or re-enable it.";

export const CODEX_AGENT_REASONING_EFFORTS = ["low", "medium", "high", "ultra"] as const;

export type CodexAgentReasoningEffort = (typeof CODEX_AGENT_REASONING_EFFORTS)[number];

export interface CodexAgentRuntimeSettings {
  enabled: boolean;
  binaryPath?: string;
  reasoningEffort?: CodexAgentReasoningEffort;
}

export { CODEX_AGENT_DISABLED_MESSAGE, CODEX_AGENT_WINDOWS_MESSAGE };

export interface EffectiveRuntimeConfig {
  llm: {
    provider: LlmProvider;
    model: string;
    apiKey: string;
    authProfile?: string;
    flushModel?: string;
    compactModel?: string;
    baseUrl?: string;
    claudeCli?: ClaudeCliRuntimeSettings;
    codexAgent?: CodexAgentRuntimeSettings;
  };
  intervals: {
    apiKey: string;
    athleteId: string;
  };
  session: {
    historyTokenBudgetRatio: number;
    idleMinutes: number;
    dailyResetHour: number;
    resetArchiveRetentionDays: number;
    timezone: string;
  };
  contextWindowTokens: number;
  contextWindowTokensOverride?: number;
}

export interface ClaudeCliRuntimeConfigPatch {
  readonly enabled?: boolean;
  readonly binaryPath?: string | null;
  readonly configDir?: string | null;
  readonly billing?: ClaudeCliBilling;
}

export interface CodexAgentRuntimeConfigPatch {
  readonly enabled?: boolean;
  readonly binaryPath?: string | null;
  readonly reasoningEffort?: CodexAgentReasoningEffort | null;
}

export interface RuntimeConfigPatch {
  readonly llm?: {
    readonly provider?: LlmProvider;
    readonly model?: string;
    readonly apiKey?: string;
    readonly flushModel?: string | null;
    readonly compactModel?: string | null;
    readonly baseUrl?: string | null;
    readonly claudeCli?: ClaudeCliRuntimeConfigPatch;
    readonly codexAgent?: CodexAgentRuntimeConfigPatch;
  };
  readonly intervals?: {
    readonly apiKey?: string;
    readonly athleteId?: string;
  };
  readonly session?: Partial<EffectiveRuntimeConfig["session"]>;
}

export interface RuntimeConfigResolverOptions {
  readonly contextWindowTokens?: number;
  readonly authProfile?: string;
}

const ROOT_FIELDS = new Set(["llm", "intervals", "session"]);
const LLM_FIELDS = new Set([
  "provider",
  "model",
  "apiKey",
  "flushModel",
  "compactModel",
  "baseUrl",
  "claudeCli",
  "codexAgent",
]);
const CLAUDE_CLI_FIELDS = new Set(["enabled", "binaryPath", "configDir", "billing"]);
const CODEX_AGENT_FIELDS = new Set(["enabled", "binaryPath", "reasoningEffort"]);
const INTERVALS_FIELDS = new Set(["apiKey", "athleteId"]);
const SESSION_FIELDS = new Set([
  "historyTokenBudgetRatio",
  "idleMinutes",
  "dailyResetHour",
  "resetArchiveRetentionDays",
  "timezone",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownFields(value: unknown, fields: ReadonlySet<string>, name: string): void {
  if (!isRecord(value)) throw new TypeError(`${name} must be a map.`);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`Unknown ${name} field: ${field}.`);
  }
}

function isSpecified(value: object, field: string): boolean {
  return Object.hasOwn(value, field) && (value as Record<string, unknown>)[field] !== undefined;
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

function requireInteger(value: unknown, name: string): number {
  const parsed = requireFiniteNumber(value, name);
  if (!Number.isInteger(parsed)) throw new TypeError(`${name} must be an integer.`);
  return parsed;
}

function requireHistoryTokenBudgetRatio(value: unknown): number {
  const parsed = requireFiniteNumber(value, "session.historyTokenBudgetRatio");
  if (parsed <= 0 || parsed > 1) {
    throw new TypeError("session.historyTokenBudgetRatio must be greater than 0 and at most 1.");
  }
  return parsed;
}

function requireNonnegativeSafeInteger(value: unknown, name: string): number {
  const parsed = requireInteger(value, name);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

function requireDailyResetHour(value: unknown): number {
  const parsed = requireInteger(value, "session.dailyResetHour");
  if (parsed < 0 || parsed > 23) {
    throw new TypeError("session.dailyResetHour must be between 0 and 23.");
  }
  return parsed;
}

function requireTimezone(value: unknown): string {
  const parsed = requireString(value, "session.timezone", true).trim();
  if (parsed.length === 0) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed }).format();
  } catch {
    throw new TypeError("session.timezone must be a valid IANA timezone.");
  }
  return parsed;
}

export function resolveLlmProvider(value: unknown): LlmProvider {
  if (typeof value === "string" && (LLM_PROVIDERS as readonly string[]).includes(value)) {
    return value as LlmProvider;
  }
  throw new TypeError("Unsupported LLM provider.");
}

const FALLBACK_CONTEXT_WINDOW = 200_000;

export function knownContextWindowForModel(
  model: string,
  provider?: LlmProvider,
): number | undefined {
  for (const candidate of GENERATED_MODEL_CATALOG_SEED.providers) {
    if (provider !== undefined && candidate.providerId !== provider) continue;
    const entry = (candidate.models as readonly CatalogModelEntry[]).find(
      (modelEntry) => modelEntry.modelId === model,
    );
    if (entry !== undefined) {
      return entry.contextWindow.kind === "known" ? entry.contextWindow.tokens : undefined;
    }
  }
  return undefined;
}

export function contextWindowForModel(model: string, provider?: LlmProvider): number {
  return knownContextWindowForModel(model, provider) ?? FALLBACK_CONTEXT_WINDOW;
}

function providerBaseUrl(provider: LlmProvider): string | undefined {
  return PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS];
}

function compactModelDefault(provider: LlmProvider): string | undefined {
  return COMPACT_MODEL_DEFAULTS[provider as keyof typeof COMPACT_MODEL_DEFAULTS];
}

function optionalModel(
  patch: NonNullable<RuntimeConfigPatch["llm"]>,
  field: "flushModel" | "compactModel",
): string | null | undefined {
  if (!isSpecified(patch, field)) return undefined;
  const value = patch[field];
  return value === null ? null : requireString(value, `llm.${field}`);
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean.`);
  return value;
}

function requireClaudeCliBilling(value: unknown): ClaudeCliBilling {
  if (
    typeof value === "string" &&
    (CLAUDE_CLI_BILLING_MODES as readonly string[]).includes(value)
  ) {
    return value as ClaudeCliBilling;
  }
  throw new TypeError('llm.claudeCli.billing must be "subscription" or "api-key".');
}

function optionalClaudeCliPath(
  patch: ClaudeCliRuntimeConfigPatch,
  field: "binaryPath" | "configDir",
  current: string | undefined,
): string | undefined {
  if (!isSpecified(patch, field)) return current;
  const value = patch[field];
  return value === null ? undefined : requireString(value, `llm.claudeCli.${field}`);
}

function resolveClaudeCli(
  patch: ClaudeCliRuntimeConfigPatch,
  current: ClaudeCliRuntimeSettings | undefined,
): ClaudeCliRuntimeSettings {
  assertKnownFields(patch, CLAUDE_CLI_FIELDS, "llm.claudeCli");
  const binaryPath = optionalClaudeCliPath(patch, "binaryPath", current?.binaryPath);
  const configDir = optionalClaudeCliPath(patch, "configDir", current?.configDir);
  return {
    enabled: isSpecified(patch, "enabled")
      ? requireBoolean(patch.enabled, "llm.claudeCli.enabled")
      : (current?.enabled ?? true),
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(configDir === undefined ? {} : { configDir }),
    billing: isSpecified(patch, "billing")
      ? requireClaudeCliBilling(patch.billing)
      : (current?.billing ?? "subscription"),
  };
}

function requireCodexAgentReasoningEffort(value: unknown): CodexAgentReasoningEffort {
  if (
    typeof value === "string" &&
    (CODEX_AGENT_REASONING_EFFORTS as readonly string[]).includes(value)
  ) {
    return value as CodexAgentReasoningEffort;
  }
  throw new TypeError(
    'llm.codexAgent.reasoningEffort must be "low", "medium", "high", or "ultra".',
  );
}

function resolveCodexAgent(
  patch: CodexAgentRuntimeConfigPatch,
  current: CodexAgentRuntimeSettings | undefined,
): CodexAgentRuntimeSettings {
  assertKnownFields(patch, CODEX_AGENT_FIELDS, "llm.codexAgent");
  const binaryPath = !isSpecified(patch, "binaryPath")
    ? current?.binaryPath
    : patch.binaryPath === null
      ? undefined
      : requireString(patch.binaryPath, "llm.codexAgent.binaryPath");
  const reasoningEffort = !isSpecified(patch, "reasoningEffort")
    ? current?.reasoningEffort
    : patch.reasoningEffort === null
      ? undefined
      : requireCodexAgentReasoningEffort(patch.reasoningEffort);
  return {
    enabled: isSpecified(patch, "enabled")
      ? requireBoolean(patch.enabled, "llm.codexAgent.enabled")
      : (current?.enabled ?? false),
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

export function resolveRuntimeConfig(
  patch: RuntimeConfigPatch = {},
  current?: EffectiveRuntimeConfig,
  options: RuntimeConfigResolverOptions = {},
): EffectiveRuntimeConfig {
  assertKnownFields(patch, ROOT_FIELDS, "runtime config");
  const llmPatch = patch.llm ?? {};
  const intervalsPatch = patch.intervals ?? {};
  const sessionPatch = patch.session ?? {};
  assertKnownFields(llmPatch, LLM_FIELDS, "llm");
  assertKnownFields(intervalsPatch, INTERVALS_FIELDS, "intervals");
  assertKnownFields(sessionPatch, SESSION_FIELDS, "session");

  const provider = isSpecified(llmPatch, "provider")
    ? resolveLlmProvider(llmPatch.provider)
    : (current?.llm.provider ?? "anthropic");
  const providerChanged = current !== undefined && provider !== current.llm.provider;
  const model = isSpecified(llmPatch, "model")
    ? requireString(llmPatch.model, "llm.model")
    : current !== undefined && !providerChanged
      ? current.llm.model
      : DEFAULT_MODELS[provider];
  if (!isModelEnabledForProvider(provider, model)) {
    throw new TypeError(
      "GPT-6 Astra is not enabled for this connection; use the public OpenAI API.",
    );
  }
  const selectionChanged = current === undefined || providerChanged || model !== current.llm.model;
  const keyless = isKeylessProvider(provider);
  const apiKey = keyless
    ? ""
    : isSpecified(llmPatch, "apiKey")
      ? requireString(llmPatch.apiKey, "llm.apiKey", true)
      : current !== undefined && !providerChanged
        ? current.llm.apiKey
        : "";
  if (keyless && isSpecified(llmPatch, "apiKey")) {
    throw new TypeError(`llm.apiKey must be absent for ${provider}.`);
  }
  if (provider !== "claude-cli" && isSpecified(llmPatch, "claudeCli")) {
    throw new TypeError("llm.claudeCli must be absent unless the provider is claude-cli.");
  }
  const claudeCli =
    provider === "claude-cli"
      ? resolveClaudeCli(
          isSpecified(llmPatch, "claudeCli") ? (llmPatch.claudeCli ?? {}) : {},
          providerChanged ? undefined : current?.llm.claudeCli,
        )
      : undefined;
  if (provider !== "codex-agent" && isSpecified(llmPatch, "codexAgent")) {
    throw new TypeError("llm.codexAgent must be absent unless the provider is codex-agent.");
  }
  const codexAgent =
    provider === "codex-agent"
      ? resolveCodexAgent(
          isSpecified(llmPatch, "codexAgent") ? (llmPatch.codexAgent ?? {}) : {},
          providerChanged ? undefined : current?.llm.codexAgent,
        )
      : undefined;

  const astra = provider === "openai" && model === "gpt-6-astra";
  const backgroundModel = astra
    ? current !== undefined && !providerChanged && current.llm.model !== "gpt-6-astra"
      ? current.llm.model
      : DEFAULT_MODELS.openai
    : model;
  const requestedFlushModel = optionalModel(llmPatch, "flushModel");
  const flushModel =
    requestedFlushModel === null
      ? undefined
      : (requestedFlushModel ??
        (current !== undefined && !providerChanged ? current.llm.flushModel : undefined) ??
        (astra ? backgroundModel : undefined));

  const requestedCompactModel = optionalModel(llmPatch, "compactModel");
  const compactModel =
    provider === "openai-codex"
      ? model
      : requestedCompactModel === null
        ? (compactModelDefault(provider) ?? backgroundModel)
        : (requestedCompactModel ??
          (current !== undefined && !providerChanged
            ? model !== current.llm.model && current.llm.compactModel === current.llm.model
              ? backgroundModel
              : current.llm.compactModel
            : (compactModelDefault(provider) ?? backgroundModel)));

  let baseUrl: string | undefined;
  if (
    provider === "claude-cli" &&
    isSpecified(llmPatch, "baseUrl") &&
    llmPatch.baseUrl !== null &&
    llmPatch.baseUrl !== ""
  ) {
    throw new TypeError(
      "llm.baseUrl must be absent for claude-cli — the Claude Code CLI owns its endpoint.",
    );
  }
  if (
    provider === "codex-agent" &&
    isSpecified(llmPatch, "baseUrl") &&
    llmPatch.baseUrl !== null &&
    llmPatch.baseUrl !== ""
  ) {
    throw new TypeError(
      "llm.baseUrl must be absent for codex-agent — the Codex CLI owns its endpoint.",
    );
  }
  if (isSpecified(llmPatch, "baseUrl")) {
    baseUrl =
      llmPatch.baseUrl === null
        ? providerBaseUrl(provider)
        : requireString(llmPatch.baseUrl, "llm.baseUrl", true) || undefined;
  } else {
    baseUrl =
      current !== undefined && !providerChanged ? current.llm.baseUrl : providerBaseUrl(provider);
  }

  const intervalsApiKeySpecified = isSpecified(intervalsPatch, "apiKey");
  const intervalsApiKey = intervalsApiKeySpecified
    ? requireString(intervalsPatch.apiKey, "intervals.apiKey", true)
    : (current?.intervals.apiKey ?? "");
  const intervals = {
    apiKey: intervalsApiKey,
    athleteId: isSpecified(intervalsPatch, "athleteId")
      ? requireString(intervalsPatch.athleteId, "intervals.athleteId", current === undefined)
      : current?.intervals.athleteId === "" &&
          intervalsApiKeySpecified &&
          intervalsApiKey.length > 0
        ? "0"
        : (current?.intervals.athleteId ?? "0"),
  };

  const session = {
    historyTokenBudgetRatio: isSpecified(sessionPatch, "historyTokenBudgetRatio")
      ? requireHistoryTokenBudgetRatio(sessionPatch.historyTokenBudgetRatio)
      : (current?.session.historyTokenBudgetRatio ?? 0.3),
    idleMinutes: isSpecified(sessionPatch, "idleMinutes")
      ? requireNonnegativeSafeInteger(sessionPatch.idleMinutes, "session.idleMinutes")
      : (current?.session.idleMinutes ?? 0),
    dailyResetHour: isSpecified(sessionPatch, "dailyResetHour")
      ? requireDailyResetHour(sessionPatch.dailyResetHour)
      : (current?.session.dailyResetHour ?? 4),
    resetArchiveRetentionDays: isSpecified(sessionPatch, "resetArchiveRetentionDays")
      ? requireNonnegativeSafeInteger(
          sessionPatch.resetArchiveRetentionDays,
          "session.resetArchiveRetentionDays",
        )
      : (current?.session.resetArchiveRetentionDays ?? 0),
    timezone: isSpecified(sessionPatch, "timezone")
      ? requireTimezone(sessionPatch.timezone)
      : (current?.session.timezone ?? ""),
  };

  const contextWindowTokensOverride =
    options.contextWindowTokens !== undefined
      ? requireInteger(options.contextWindowTokens, "contextWindowTokens")
      : current?.contextWindowTokensOverride;
  const contextWindowTokens =
    contextWindowTokensOverride ??
    (current !== undefined && !selectionChanged
      ? current.contextWindowTokens
      : contextWindowForModel(model, provider));
  if (contextWindowTokens <= 0) throw new TypeError("contextWindowTokens must be positive.");

  const authProfile =
    provider === "openai-codex"
      ? isSpecified(llmPatch, "provider")
        ? options.authProfile === undefined
          ? "openai-codex"
          : requireString(options.authProfile, "authProfile")
        : current !== undefined
          ? (current.llm.authProfile ?? "openai-codex")
          : options.authProfile === undefined
            ? "openai-codex"
            : requireString(options.authProfile, "authProfile")
      : undefined;

  return {
    llm: {
      provider,
      model,
      apiKey,
      authProfile,
      flushModel,
      compactModel,
      baseUrl,
      ...(claudeCli === undefined ? {} : { claudeCli }),
      ...(codexAgent === undefined ? {} : { codexAgent }),
    },
    intervals,
    session,
    contextWindowTokens,
    ...(contextWindowTokensOverride === undefined ? {} : { contextWindowTokensOverride }),
  };
}
