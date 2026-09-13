import {
  InstalledCompatibilityProfileSchema,
  type InstalledCompatibilityProfile,
} from "@enduragent/coach-contract/model-catalog";
import { LLM_MODEL_CATALOGUE } from "./runtime-config.js";

export type VisibleModelCatalogProvider = (typeof LLM_MODEL_CATALOGUE)[number]["provider"];

export const INSTALLED_MODEL_CATALOG_PROFILES = {
  anthropic: ["anthropic-ai-sdk-v1"],
  openai: ["openai-ai-sdk-v1", "openai-astra-v1"],
  google: ["google-ai-sdk-v1"],
  "openai-codex": ["openai-codex-v1"],
  "claude-cli": ["claude-cli-v1"],
  "codex-agent": ["codex-agent-v1"],
  deepseek: ["deepseek-ai-sdk-v1"],
  qwen: ["alibaba-ai-sdk-v1"],
  minimax: ["openai-compatible-v1"],
  kimi: ["openai-compatible-v1"],
  zai: ["openai-compatible-v1"],
  openrouter: ["openrouter-ai-sdk-v1"],
} as const satisfies Record<VisibleModelCatalogProvider, readonly InstalledCompatibilityProfile[]>;

export function installedProfileFor(
  provider: VisibleModelCatalogProvider,
  profile: string,
): InstalledCompatibilityProfile | undefined {
  const parsed = InstalledCompatibilityProfileSchema.safeParse(profile);
  if (!parsed.success) return undefined;
  return (INSTALLED_MODEL_CATALOG_PROFILES[provider] as readonly string[]).includes(parsed.data)
    ? parsed.data
    : undefined;
}
