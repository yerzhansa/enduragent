export const FLOOR_MODELS = [
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", slug: "anthropic-claude-haiku-4-5-20251001" },
  { provider: "openrouter", model: "qwen/qwen3.5-plus", slug: "openrouter-qwen-qwen3.5-plus" },
  { provider: "openrouter", model: "deepseek/deepseek-v4-flash", slug: "openrouter-deepseek-deepseek-v4-flash" },
] as const;

export const JUDGE_MODEL_ID = "claude-sonnet-4-6";
export const JUDGED_TURNS_PER_MODEL = 70;
export const MIXING_RATE_MAX = 0.05;
export const STABLE_PREFIX_TOKEN_BUDGET = 15_000;
export const WHOLE_PROMPT_TOKEN_MAX = 50_000;
export const TOOL_CHOICE_MIN = 0.8;
export const RECALL_MIN_HITS = 5;
export const SPOT_CHECK_FRACTION = 0.1;
export const PROBE_FROZEN_NOW_ISO = "1998-07-06T08:00:00Z";
export const STEP_LIMIT = 10;
export const TOKEN_COUNT_MODEL = "claude-haiku-4-5-20251001";
export const SUITE_COMPOSITION = {
  "c1-cycling": 8,
  "c2-running": 8,
  "c3-swimming": 8,
  "c4-cross-ambiguous": 8,
  "c5-integrated": 6,
  "c6-anchor-traps": 8,
  "c7-contamination": 8,
  "c8-tool-choice": 10,
  "c9-deep-protocol": 6,
} as const;
