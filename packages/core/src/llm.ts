import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import { isPriced, priceUsage } from "./agent/codex/cost.js";

import type { Config } from "./config.js";
import { PROVIDER_BASE_URLS } from "./config.js";
import { codexGenerateText } from "./agent/codex-bridge.js";
import type { GenerateOpts, GenerateResult } from "./llm-types.js";
import { appendUsageLine, cacheTokenDetails, usageFieldsFromResult } from "./usage-ledger.js";

export type { GenerateOpts, GenerateResult } from "./llm-types.js";
export const LLM_CALL_DEADLINE_MS = 300_000;
// Chat calls clip this by the turn's remaining wall-clock (TURN_WALL_CLOCK_MS
// in ./agent/turn-budget.ts), so any value above it never binds — keep <= it.
export const CHAT_LLM_CALL_DEADLINE_MS = 600_000;

// ============================================================================
// LLM DISPATCH
// ============================================================================

// Most providers cache the stable system prefix automatically server-side and
// get the plain system string, so they are absent here: direct openai/google,
// the OpenAI-compatible direct providers, and OpenRouter's OpenAI/DeepSeek/
// Grok/Moonshot routes. Explicit breakpoints are needed by direct Anthropic and
// — through OpenRouter — the Anthropic/Qwen/Gemini routes; of those we ship only
// the Qwen route (`qwen/`-namespaced ids), so `anthropic/` and `google/` via
// OpenRouter are intentionally out of scope and stay uncached. (Same breakpoint
// shape as Anthropic; only the providerOptions key differs —
// @openrouter/ai-sdk-provider reads it from message-level
// providerOptions.openrouter.cacheControl.)
export function cacheBreakpointKey(
  provider: string,
  model: string,
): "anthropic" | "openrouter" | undefined {
  if (provider === "anthropic") return "anthropic";
  if (provider === "openrouter" && model.startsWith("qwen/")) return "openrouter";
  return undefined;
}

export class LLM {
  private config: Config;
  private aiSdkModel: LanguageModel | null;
  // Provider + model are fixed for the instance, so resolve once whether this
  // configuration is in the vendored price catalog. A miss yields undefined cost
  // on the ledger (best-effort), never a fabricated figure.
  private priced: boolean;
  // Instance-constant for the same reason: the cache-breakpoint decision depends
  // only on provider + model, so resolve it once rather than per dispatch().
  private breakpointKey: "anthropic" | "openrouter" | undefined;

  constructor(config: Config) {
    this.config = config;
    this.aiSdkModel = config.llm.provider === "openai-codex" ? null : buildAiSdkModel(config);
    this.priced = isPriced(config.llm.provider, config.llm.model);
    this.breakpointKey = cacheBreakpointKey(config.llm.provider, config.llm.model);
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const start = Date.now();
    // The per-call deadline is the caller's class budget intersected with any
    // turn-remaining bound the agent loop passes, so a retry after an early
    // timeout inherits only the time the turn has left — never a fresh window.
    const deadlineMs = Math.min(
      deadlineMsForCaller(opts.caller),
      opts.deadlineMs ?? Number.POSITIVE_INFINITY,
    );
    const { signal, deadline } = withLLMDeadline(opts.signal, deadlineMs);
    let result: GenerateResult;
    try {
      result = await this.dispatch({ ...opts, signal });
    } catch (err) {
      // Relabel to TimeoutError only when OUR per-call timer fired AND the error
      // is abort-shaped: a 5xx/429/network thrown while the timer happens to be
      // aborted must keep its own class, and an outer caller cancellation that
      // never tripped our timer is not our deadline.
      if (deadline.aborted && isAbortError(err, deadline)) throw toTimeoutError(err);
      throw err;
    }
    const durationMs = Date.now() - start;
    this.recordGenerate(opts, result, durationMs);
    return result;
  }

  private async dispatch(opts: GenerateOpts): Promise<GenerateResult> {
    if (this.config.llm.provider === "openai-codex") {
      return await codexGenerateText({
        ...opts,
        modelId: this.config.llm.model,
        profileName: this.config.llm.authProfile ?? "openai-codex",
        stepLimit: opts.maxSteps,
      });
    }

    if (!this.aiSdkModel) {
      throw new Error("AI SDK model not initialized");
    }

    // The provider renders tools before system, so breakpointing the (only)
    // stable system block caches tools + system together. Which providers need a
    // breakpoint, and why the rest don't, lives on cacheBreakpointKey above.
    const breakpointKey = this.breakpointKey;
    const cachedSystem =
      breakpointKey !== undefined && opts.system !== undefined
        ? [
            {
              role: "system" as const,
              content: opts.system,
              providerOptions: { [breakpointKey]: { cacheControl: { type: "ephemeral" } } },
            },
          ]
        : undefined;

    const base = {
      model: this.aiSdkModel,
      system: cachedSystem ?? opts.system,
      tools: opts.tools,
      stopWhen: opts.stopWhen,
      maxOutputTokens: opts.maxOutputTokens,
      maxRetries: 0,
      abortSignal: opts.signal,
    };
    const result = opts.prompt !== undefined
      ? await generateText({ ...base, prompt: opts.prompt })
      : await generateText({ ...base, messages: opts.messages ?? [] });

    return {
      text: result.text,
      toolCalls: result.toolCalls as GenerateResult["toolCalls"],
      finishReason: result.finishReason,
      usage: result.usage,
      totalUsage: result.totalUsage,
      steps: result.steps.length,
      cost: priceAiSdkUsage(this.config.llm.provider, this.config.llm.model, this.priced, result.totalUsage),
    };
  }

  private recordGenerate(opts: GenerateOpts, result: GenerateResult, durationMs: number): void {
    appendUsageLine(this.config.dataDir, {
      ts: Date.now(),
      kind: "generate",
      caller: opts.caller,
      provider: this.config.llm.provider,
      model: this.config.llm.model,
      durationMs,
      steps: result.steps,
      ...usageFieldsFromResult(result),
      stopReason: result.finishReason,
    });
  }
}

// The AI SDK reports token usage but no cost, so derive it from the vendored
// per-million price catalog (the same numbers the codex path prices against).
// `priced` is resolved once at construction; an uncatalogued configuration
// yields undefined rather than a fabricated figure (best-effort ledger).
function priceAiSdkUsage(
  provider: string,
  modelId: string,
  priced: boolean,
  totalUsage: GenerateResult["totalUsage"],
): GenerateResult["cost"] | undefined {
  if (!priced || !totalUsage) return undefined;
  const details = cacheTokenDetails(totalUsage);
  return priceUsage(provider, modelId, {
    input: totalUsage.inputTokens ?? 0,
    output: totalUsage.outputTokens ?? 0,
    cacheRead: details?.cacheReadTokens ?? 0,
    cacheWrite: details?.cacheWriteTokens ?? 0,
  });
}

function deadlineMsForCaller(caller: GenerateOpts["caller"]): number {
  return caller === "chat" ? CHAT_LLM_CALL_DEADLINE_MS : LLM_CALL_DEADLINE_MS;
}

// Returns BOTH the per-call timer (so the catch can ask "did our timer fire?")
// and the signal actually handed to the provider — the timer alone when there is
// no outer signal, else the union of the two.
function withLLMDeadline(
  signal: AbortSignal | undefined,
  deadlineMs: number,
): { signal: AbortSignal; deadline: AbortSignal } {
  const deadline = AbortSignal.timeout(deadlineMs);
  return {
    deadline,
    signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
  };
}

// True when the caught error is the shape an aborted request produces -- the
// timer's own reason, or an AbortError/TimeoutError anywhere in its cause chain
// (some providers wrap the abort under a non-standard name). A 5xx/429/network
// error carries no such cause and is NOT matched, so it keeps its own retry
// class. Only consulted when OUR timer fired (deadline.aborted), so widening to
// the cause chain cannot mislabel an unrelated failure.
function isAbortError(err: unknown, deadline: AbortSignal): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (current === deadline.reason) return true;
    if (typeof current !== "object") return false;
    const name = (current as { name?: unknown }).name;
    if (name === "AbortError" || name === "TimeoutError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function toTimeoutError(err: unknown): Error {
  if (err instanceof Error && err.name === "TimeoutError") return err;
  const message = err instanceof Error ? err.message : String(err);
  const out = new Error(`Request timeout: ${message}`) as Error & { cause?: unknown };
  out.name = "TimeoutError";
  if (err instanceof Error) out.cause = err;
  return out;
}

// ============================================================================
// AI SDK MODEL FACTORY
// ============================================================================

function buildAiSdkModel(config: Config): LanguageModel {
  switch (config.llm.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.llm.apiKey });
      return anthropic(config.llm.model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: config.llm.apiKey });
      return openai(config.llm.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: config.llm.apiKey });
      return google(config.llm.model);
    }
    case "deepseek": {
      // baseUrl is undefined only on direct construction (loadConfig always
      // resolves it); undefined lets the SDK fall back to its package default.
      const deepseek = createDeepSeek({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
      return deepseek(config.llm.model);
    }
    case "qwen": {
      const alibaba = createAlibaba({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
      return alibaba(config.llm.model);
    }
    case "minimax": {
      // createOpenAICompatible requires a baseURL, so fall back to the shared
      // default when one wasn't resolved (direct construction in tests).
      const minimax = createOpenAICompatible({
        name: "minimax",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.minimax,
      });
      return minimax(config.llm.model);
    }
    case "kimi": {
      const moonshot = createOpenAICompatible({
        name: "moonshot",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.kimi,
      });
      return moonshot(config.llm.model);
    }
    case "zai": {
      const zai = createOpenAICompatible({
        name: "zai",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.zai,
      });
      return zai(config.llm.model);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl,
      });
      return openrouter.chat(config.llm.model);
    }
    case "openai-codex":
      throw new Error("openai-codex is handled via the bridge, not AI SDK");
  }
}
