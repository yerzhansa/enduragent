import type { LlmProvider } from "@enduragent/coach-contract";

export const ONBOARDING_STEP_IDS = ["coach-keys", "training-data", "ready"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export const PRIMARY_MODEL_CREDENTIAL_SLOTS = [
  { id: "anthropic", label: "Anthropic API key", hint: "Recommended" },
  { id: "openrouter", label: "OpenRouter API key", hint: "Everything else" },
] as const;

export const ADVANCED_MODEL_CREDENTIAL_SLOTS = [
  { id: "openai", label: "OpenAI API key" },
  { id: "google", label: "Google API key" },
  { id: "deepseek", label: "DeepSeek API key" },
  { id: "qwen", label: "Qwen API key" },
  { id: "minimax", label: "MiniMax API key" },
  { id: "kimi", label: "Kimi API key" },
  { id: "zai", label: "Z.AI API key" },
] as const;

export const DESKTOP_CREDENTIAL_SLOTS = [
  "anthropic",
  "openrouter",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "intervals-icu",
] as const;

export type DesktopCredentialSlot = (typeof DESKTOP_CREDENTIAL_SLOTS)[number];

export const ONBOARDING_LLM_PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "openai-codex": "ChatGPT subscription",
  "claude-cli": "Claude subscription",
  "codex-agent": "Codex agent (experimental)",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  minimax: "MiniMax",
  kimi: "Kimi",
  zai: "Z.AI",
  openrouter: "OpenRouter",
} as const satisfies Readonly<Record<LlmProvider, string>>;

export const CUSTOM_MODEL_SELECTION = "__custom__" as const;

export const CHATGPT_LOGIN_REFUSAL_REASONS = [
  "already-in-progress",
  "callback-unavailable",
  "timed-out",
  "cancelled",
  "exchange-failed",
  "storage-failed",
  "runtime-unavailable",
] as const;

export type ChatGptLoginRefusalReason = (typeof CHATGPT_LOGIN_REFUSAL_REASONS)[number];

export const CLAUDE_CLI_STATES = [
  "absent-binary",
  "not-logged-in",
  "api-key-token",
  "ready",
  "ready-api-key",
  "disabled",
  "working-area-unavailable",
] as const;

export type ClaudeCliState = (typeof CLAUDE_CLI_STATES)[number];

export const SUPPORTED_IMPORT_EXTENSIONS = [".fit", ".tcx", ".gpx"] as const;
