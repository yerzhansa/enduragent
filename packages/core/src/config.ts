import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getCoachHome } from "./coach-home.js";
import { SecretRef, isSecretRef, SecretResolutionError } from "./secrets/types.js";
import { resolveSecretRef } from "./secrets/resolve.js";
import { readPersistedLlmBackgroundModels } from "./background-model-persistence.js";
import {
  isKeylessProvider,
  resolveLlmProvider,
  resolveRuntimeConfig,
  type ClaudeCliBilling,
  type ClaudeCliRuntimeConfigPatch,
  type CodexAgentReasoningEffort,
  type CodexAgentRuntimeConfigPatch,
  type EffectiveRuntimeConfig,
} from "./runtime-config.js";

export {
  COMPACT_MODEL_DEFAULTS,
  DEFAULT_MODELS,
  LLM_PROVIDERS,
  PROVIDER_BASE_URLS,
  contextWindowForModel,
} from "./runtime-config.js";
export type { LlmProvider } from "./runtime-config.js";

export const DATA_SOURCES = ["platform", "store"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];
export function resolveDataSource(value: unknown): DataSource {
  if (value === undefined) return "platform";
  if (value === "platform" || value === "store") return value;
  throw new TypeError('Config field data_source must be "platform" or "store".');
}

export interface Config extends EffectiveRuntimeConfig {
  dataSource: DataSource;
  telegram: {
    botToken: string;
  };
  dataDir: string;
}

export interface LoadConfigOptions {
  defaultDataDir?: string;
}

export const CONFIG_DIR = getCoachHome("cycling-coach");
export const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

function readConfigYamlFrom(configDir: string): Record<string, unknown> {
  const configFile = join(configDir, "config.yaml");
  if (!existsSync(configFile)) return {};
  const raw = readFileSync(configFile, "utf-8");
  try {
    return (parseYaml(raw) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

export function readConfigYaml(): Record<string, unknown> {
  return readConfigYamlFrom(CONFIG_DIR);
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function envFrom(environment: RuntimeEnvironment, key: string): string | undefined {
  return environment[key];
}

function env(key: string): string | undefined {
  return envFrom(process.env, key);
}

function envIntFrom(environment: RuntimeEnvironment, key: string): number | undefined {
  const v = envFrom(environment, key);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function envInt(key: string): number | undefined {
  return envIntFrom(process.env, key);
}

function envFloatFrom(environment: RuntimeEnvironment, key: string): number | undefined {
  const v = envFrom(environment, key);
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export interface SessionConfigEnvironmentOwnership {
  readonly historyTokenBudgetRatio: boolean;
  readonly idleMinutes: boolean;
  readonly dailyResetHour: boolean;
  readonly resetArchiveRetentionDays: boolean;
  readonly timezone: boolean;
}

interface SessionEnvironmentOverrides {
  readonly ownership: SessionConfigEnvironmentOwnership;
  readonly historyTokenBudgetRatio?: number;
  readonly idleMinutes?: number;
  readonly dailyResetHour?: number;
  readonly resetArchiveRetentionDays?: number;
  readonly timezone?: string;
}

function sessionEnvironmentOverrides(environment: RuntimeEnvironment): SessionEnvironmentOverrides {
  const historyTokenBudgetRatio = envFloatFrom(environment, "HISTORY_TOKEN_BUDGET_RATIO");
  const idleMinutes = envIntFrom(environment, "SESSION_IDLE_MINUTES");
  const dailyResetHour = envIntFrom(environment, "SESSION_DAILY_RESET_HOUR");
  const resetArchiveRetentionDays = envIntFrom(environment, "SESSION_RESET_ARCHIVE_RETENTION_DAYS");
  const timezone = envFrom(environment, "COACH_TZ");
  return {
    historyTokenBudgetRatio,
    idleMinutes,
    dailyResetHour,
    resetArchiveRetentionDays,
    timezone,
    ownership: {
      historyTokenBudgetRatio: historyTokenBudgetRatio !== undefined,
      idleMinutes: idleMinutes !== undefined,
      dailyResetHour: dailyResetHour !== undefined,
      resetArchiveRetentionDays: resetArchiveRetentionDays !== undefined,
      timezone: timezone !== undefined,
    },
  };
}

export function sessionConfigEnvironmentOwnership(
  environment: RuntimeEnvironment,
): SessionConfigEnvironmentOwnership {
  return sessionEnvironmentOverrides(environment).ownership;
}

function isYamlRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function claudeCliDisabledByEnvironment(environment: RuntimeEnvironment): boolean {
  const value = envFrom(environment, "ENDURAGENT_CLAUDE_CLI_DISABLED")?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function claudeCliPatchFrom(
  yaml: unknown,
  environment: RuntimeEnvironment,
): ClaudeCliRuntimeConfigPatch {
  const block = isYamlRecord(yaml) ? yaml : {};
  const enabled = claudeCliDisabledByEnvironment(environment)
    ? false
    : (block.enabled as boolean | undefined);
  const binaryPath =
    envFrom(environment, "CLAUDE_CLI_PATH") ?? (block.binary_path as string | undefined);
  const configDir = block.config_dir as string | undefined;
  const billing = block.billing as ClaudeCliBilling | undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(configDir === undefined ? {} : { configDir }),
    ...(billing === undefined ? {} : { billing }),
  };
}

export function codexAgentPatchFrom(
  yaml: unknown,
  environment: RuntimeEnvironment,
): CodexAgentRuntimeConfigPatch {
  const block = isYamlRecord(yaml) ? yaml : {};
  const enabled = block.enabled as boolean | undefined;
  const binaryPath =
    envFrom(environment, "CODEX_CLI_PATH") ?? (block.binary_path as string | undefined);
  const reasoningEffort = block.reasoning_effort as CodexAgentReasoningEffort | undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

type SecretFieldPath = "llm.api_key" | "intervals.api_key" | "telegram.bot_token";

const PENDING_REFS = new WeakMap<Config, Map<SecretFieldPath, SecretRef>>();

function readSecretField(value: unknown, path: SecretFieldPath): string | SecretRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (isSecretRef(value)) return value;
  throw new SecretResolutionError(
    "INVALID_REF",
    `Config field ${path} is not a valid SecretRef. Expected a string, { source: "exec", command: string, args?: string[] }, or { source: "env", var: string }.`,
  );
}

function assignFieldByPath(cfg: Config, path: SecretFieldPath, value: string): void {
  if (path === "llm.api_key") cfg.llm.apiKey = value;
  else if (path === "intervals.api_key") cfg.intervals.apiKey = value;
  else if (path === "telegram.bot_token") cfg.telegram.botToken = value;
}

export function loadConfig(
  configDir: string = CONFIG_DIR,
  options: LoadConfigOptions = {},
): Config {
  const yaml = readConfigYamlFrom(configDir);
  return loadConfigFromYaml(yaml, configDir, options);
}

export function loadConfigFromYaml(
  yaml: Record<string, unknown>,
  configDir: string = CONFIG_DIR,
  options: LoadConfigOptions = {},
): Config {
  const dataSource = resolveDataSource(yaml.data_source);
  const llmYaml = (yaml.llm as Record<string, unknown>) ?? {};
  const intervalsYaml = (yaml.intervals as Record<string, unknown>) ?? {};
  const telegramYaml = (yaml.telegram as Record<string, unknown>) ?? {};
  const sessionYaml = (yaml.session as Record<string, unknown>) ?? {};
  const sessionEnvironment = sessionEnvironmentOverrides(process.env);

  const provider = resolveLlmProvider(
    env("LLM_PROVIDER") ?? (llmYaml.provider as string | undefined) ?? "anthropic",
  );

  const llmApiKeyRaw = readSecretField(llmYaml.api_key, "llm.api_key");
  const intervalsApiKeyRaw = readSecretField(intervalsYaml.api_key, "intervals.api_key");
  const telegramTokenRaw = readSecretField(telegramYaml.bot_token, "telegram.bot_token");

  const envKeyForProvider: Record<string, string | undefined> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    "openai-codex": undefined,
    "claude-cli": undefined,
    "codex-agent": undefined,
    deepseek: "DEEPSEEK_API_KEY",
    qwen: "ALIBABA_API_KEY",
    minimax: "MINIMAX_API_KEY",
    kimi: "MOONSHOT_API_KEY",
    zai: "ZAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };

  const pending = new Map<SecretFieldPath, SecretRef>();

  const resolveWithPrecedence = (
    envVars: string | string[] | undefined,
    raw: string | SecretRef | undefined,
    path: SecretFieldPath,
  ): string => {
    const envVarList = Array.isArray(envVars) ? envVars : envVars !== undefined ? [envVars] : [];
    for (const envVar of envVarList) {
      const envValue = env(envVar);
      if (envValue !== undefined && envValue !== "") {
        if (raw !== undefined && typeof raw !== "string") {
          console.log(`Using env ${envVar}; SecretRef for ${path} skipped.`);
        }
        return envValue;
      }
    }
    if (typeof raw === "string") return raw;
    if (raw !== undefined) {
      pending.set(path, raw);
      return "";
    }
    return "";
  };

  const keyless = isKeylessProvider(provider);
  const apiKey = keyless
    ? ""
    : resolveWithPrecedence(
        [envKeyForProvider[provider], "LLM_API_KEY"].filter(
          (key): key is string => key !== undefined,
        ),
        llmApiKeyRaw,
        "llm.api_key",
      );
  const intervalsApiKey = resolveWithPrecedence(
    "INTERVALS_API_KEY",
    intervalsApiKeyRaw,
    "intervals.api_key",
  );
  const telegramBotToken = resolveWithPrecedence(
    "TELEGRAM_BOT_TOKEN",
    telegramTokenRaw,
    "telegram.bot_token",
  );

  const contextWindowTokens = parseInt(env("CONTEXT_WINDOW_TOKENS") ?? "", 10);
  const savedBackgroundModels = readPersistedLlmBackgroundModels(llmYaml, provider);
  const runtime = resolveRuntimeConfig(
    {
      llm: {
        provider,
        model: env("LLM_MODEL") ?? (llmYaml.model as string | undefined),
        ...(keyless ? {} : { apiKey }),
        flushModel: env("LLM_FLUSH_MODEL") ?? savedBackgroundModels.flushModel,
        compactModel: env("LLM_COMPACT_MODEL") ?? savedBackgroundModels.compactModel,
        baseUrl: env("LLM_BASE_URL") ?? (llmYaml.base_url as string | undefined),
        ...(provider === "claude-cli"
          ? { claudeCli: claudeCliPatchFrom(llmYaml.claude_cli, process.env) }
          : {}),
        ...(provider === "codex-agent"
          ? { codexAgent: codexAgentPatchFrom(llmYaml.codex_agent, process.env) }
          : {}),
      },
      intervals: {
        apiKey: intervalsApiKey,
        athleteId: env("INTERVALS_ATHLETE_ID") ?? (intervalsYaml.athlete_id as string | undefined),
      },
      session: {
        historyTokenBudgetRatio:
          sessionEnvironment.historyTokenBudgetRatio ??
          (sessionYaml.historyTokenBudgetRatio as number | undefined),
        idleMinutes:
          sessionEnvironment.idleMinutes ?? (sessionYaml.idleMinutes as number | undefined),
        dailyResetHour:
          sessionEnvironment.dailyResetHour ?? (sessionYaml.dailyResetHour as number | undefined),
        resetArchiveRetentionDays:
          sessionEnvironment.resetArchiveRetentionDays ??
          (sessionYaml.resetArchiveRetentionDays as number | undefined),
        timezone: sessionEnvironment.timezone ?? (sessionYaml.timezone as string | undefined),
      },
    },
    undefined,
    {
      ...(Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
        ? { contextWindowTokens }
        : {}),
      ...(provider === "openai-codex" && typeof llmYaml.auth_profile === "string"
        ? { authProfile: llmYaml.auth_profile }
        : {}),
      ...(savedBackgroundModels.beforeAstraModel === undefined
        ? {}
        : { beforeAstraModel: savedBackgroundModels.beforeAstraModel }),
    },
  );

  const config: Config = {
    ...runtime,
    dataSource,
    telegram: {
      botToken: telegramBotToken,
    },
    dataDir: Object.hasOwn(yaml, "data_dir")
      ? ((yaml.data_dir as string) ?? configDir)
      : (options.defaultDataDir ?? configDir),
  };

  if (pending.size > 0) {
    PENDING_REFS.set(config, pending);
  }

  return config;
}

export async function resolveConfigSecrets(cfg: Config): Promise<Config> {
  const pending = PENDING_REFS.get(cfg);
  if (!pending || pending.size === 0) return cfg;

  const next: Config = {
    ...cfg,
    llm: { ...cfg.llm },
    intervals: { ...cfg.intervals },
    telegram: { ...cfg.telegram },
    session: { ...cfg.session },
  };

  for (const [path, ref] of pending) {
    const value = await resolveSecretRef(ref);
    assignFieldByPath(next, path, value);
    const desc = ref.source === "env" ? `env: ${ref.var}` : `exec: ${ref.command}`;
    console.log(`Resolved secret: ${path} (${desc})`);
  }

  return next;
}
