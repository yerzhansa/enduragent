export const RUNTIME_STATES = new Set(["active", "stored-inactive", "failed"]);
export const SLOTS: ReadonlySet<string> = new Set([
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
]);
export const CREDENTIALS: ReadonlySet<string> = new Set([...SLOTS, "openai-codex"]);

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
