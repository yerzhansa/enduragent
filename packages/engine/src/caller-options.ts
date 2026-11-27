import type { JSONValue } from "ai";
import type { GenerateOpts } from "./llm-types.js";

export const LOWEST_CODEX_AGENT_EFFORT = "low";

export function callerProviderOptions(
  provider: string,
  caller: GenerateOpts["caller"],
  astra: boolean,
): Record<string, Record<string, JSONValue>> | undefined {
  const lowest = caller === "coach-text";
  if (provider === "openai" && (astra || lowest)) {
    return {
      openai: {
        ...(astra ? { forceReasoning: true } : {}),
        ...(lowest ? { reasoningEffort: "low" } : {}),
      },
    };
  }
  if (provider === "openrouter" && lowest) return { openrouter: { reasoning: { effort: "low" } } };
  return undefined;
}

export function keylessBridgeCaller(caller: GenerateOpts["caller"]): GenerateOpts["caller"] {
  return caller === "coach-text" ? "intent-translation" : caller;
}
