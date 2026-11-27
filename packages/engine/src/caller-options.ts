import type { JSONValue } from "ai";
import type { GenerateOpts } from "./llm-types.js";

export const ASTRA_MODEL = "gpt-6-astra";
export const COACH_TEXT_LOW_EFFORT_TOKENS = 600;
export const COACH_TEXT_DEFAULT_EFFORT_TOKENS = 2_000;

export interface CoachTextBudget {
  readonly lowEffort: boolean;
  readonly maxOutputTokens: number;
}

export function openAiHonoursReasoningEffort(model: string): boolean {
  return (
    model === ASTRA_MODEL ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4-mini") ||
    (model.startsWith("gpt-5") && !model.startsWith("gpt-5-chat"))
  );
}

export function coachTextBudget(provider: string, model: string): CoachTextBudget {
  const lowEffort =
    (provider === "openai" && openAiHonoursReasoningEffort(model)) || provider === "codex-agent";
  return {
    lowEffort,
    maxOutputTokens:
      lowEffort || provider === "anthropic"
        ? COACH_TEXT_LOW_EFFORT_TOKENS
        : COACH_TEXT_DEFAULT_EFFORT_TOKENS,
  };
}

function coachTextLowEffort(
  provider: string,
  model: string,
  caller: GenerateOpts["caller"],
): boolean {
  return caller === "coach-text" && coachTextBudget(provider, model).lowEffort;
}

export function callerProviderOptions(
  provider: string,
  model: string,
  caller: GenerateOpts["caller"],
): Record<string, Record<string, JSONValue>> | undefined {
  const astra = provider === "openai" && model === ASTRA_MODEL;
  const low = provider === "openai" && coachTextLowEffort(provider, model, caller);
  if (!astra && !low) return undefined;
  return {
    openai: {
      ...(astra ? { forceReasoning: true } : {}),
      ...(low ? { reasoningEffort: "low" } : {}),
    },
  };
}

export function callerMaxOutputTokens(
  provider: string,
  model: string,
  caller: GenerateOpts["caller"],
  requested: number | undefined,
): number | undefined {
  const tokens =
    caller === "coach-text" ? coachTextBudget(provider, model).maxOutputTokens : requested;
  return provider === "openai" && model === ASTRA_MODEL
    ? Math.min(tokens ?? 128_000, 128_000)
    : tokens;
}

export function codexAgentEffort<Effort extends string>(
  caller: GenerateOpts["caller"],
  configured: Effort | undefined,
): Effort | "low" | undefined {
  return coachTextLowEffort("codex-agent", "", caller) ? "low" : configured;
}

export function keylessBridgeCaller(caller: GenerateOpts["caller"]): GenerateOpts["caller"] {
  return caller === "coach-text" ? "intent-translation" : caller;
}
