import { z } from "zod";

export const LlmProviderSchema = z.enum([
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
]);

export type LlmProvider = z.infer<typeof LlmProviderSchema>;
