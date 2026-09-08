import { generateText, streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, ModelMessage } from "ai";
import { isKeylessProvider } from "@enduragent/coach-contract";
import { dirname } from "node:path";

import { splitSystemPromptAtBoundary } from "./agent/system-prompt.js";
import { isPriced } from "./agent/codex/cost.js";
import { priceInclusiveUsage } from "./usage-cost.js";

import type {
  EngineConfig,
  EngineHostPorts,
  ModelTransport,
  ChatStreamTimeouts,
} from "./host-ports.js";
import { codexGenerateText } from "./agent/codex-bridge.js";
import { claudeCliGenerateText } from "./agent/claude-cli/bridge.js";
import { codexAgentGenerateText } from "./agent/codex-agent/bridge.js";
import {
  assertClaudeCliEnabled,
  createClaudeCliSessionPool,
  type ClaudeCliSessionPool,
} from "./agent/claude-cli/session-pool.js";
import { ensureClaudeCliReady } from "./agent/claude-cli/probe.js";
import type { GenerateOpts, GenerateResult } from "./llm-types.js";
import { cacheTokenDetails, usageFieldsFromResult } from "./llm-types.js";
import type { ModelStreamActivity } from "./sport.js";
import {
  createClaudeWorkingArea,
  type ClaudeWorkingAreaPort,
} from "./agent/claude-cli/working-area.js";

export type { GenerateOpts, GenerateResult } from "./llm-types.js";
export const LLM_CALL_DEADLINE_MS = 300_000;
export const CHAT_LLM_CALL_DEADLINE_MS = 600_000;

const DEFAULT_CHAT_STREAM_TIMEOUTS: ChatStreamTimeouts = {
  ttftMs: 30_000,
  interChunkMs: 30_000,
};

const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  minimax: "https://api.minimax.io/v1",
  kimi: "https://api.moonshot.ai/v1",
  zai: "https://api.z.ai/api/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

type LLMHostPorts = Pick<
  EngineHostPorts,
  | "usage"
  | "now"
  | "getAccessToken"
  | "classifyFailure"
  | "modelTransportDecorator"
  | "chatStreamTimeouts"
  | "claudeWorkingArea"
>;

// ============================================================================
// LLM DISPATCH
// ============================================================================

export function usesKeylessTransport(provider: string): boolean {
  return isKeylessProvider(provider);
}

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
  private config: EngineConfig;
  private ports: LLMHostPorts;
  private transport: ModelTransport;
  private aiSdkModel: LanguageModel | null;
  // Provider + model are fixed for the instance, so resolve once whether this
  // configuration is in the vendored price catalog. A miss yields undefined cost
  // on the ledger (best-effort), never a fabricated figure.
  private priced: boolean;
  // Instance-constant for the same reason: the cache-breakpoint decision depends
  // only on provider + model, so resolve it once rather than per dispatch().
  private breakpointKey: "anthropic" | "openrouter" | undefined;
  private chatStreamTimeouts: ChatStreamTimeouts;
  private claudeCliPool: ClaudeCliSessionPool | null = null;
  private claudeWorkingArea: ClaudeWorkingAreaPort | null;

  constructor(config: EngineConfig, ports: LLMHostPorts) {
    this.config = config;
    this.ports = ports;
    this.aiSdkModel = usesKeylessTransport(config.llm.provider) ? null : buildAiSdkModel(config);
    this.priced = isPriced(config.llm.provider, config.llm.model);
    this.breakpointKey = cacheBreakpointKey(config.llm.provider, config.llm.model);
    this.chatStreamTimeouts = validateChatStreamTimeouts(
      ports.chatStreamTimeouts ?? DEFAULT_CHAT_STREAM_TIMEOUTS,
    );
    this.claudeWorkingArea = ports.claudeWorkingArea ?? null;
    const canonical: ModelTransport = {
      generate: (request) => this.dispatch(request.options),
    };
    this.transport = ports.modelTransportDecorator?.(canonical) ?? canonical;
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const start = this.ports.now();
    // The per-call deadline is the caller's class budget intersected with any
    // turn-remaining bound the agent loop passes, so a retry after an early
    // timeout inherits only the time the turn has left — never a fresh window.
    const deadlineMs = Math.min(
      deadlineMsForCaller(opts.caller),
      opts.deadlineMs ?? Number.POSITIVE_INFINITY,
    );
    const { signal: deadlineSignal, deadline } = withLLMDeadline(opts.signal, deadlineMs);
    const watchdog =
      opts.caller === "chat" && !usesKeylessTransport(this.config.llm.provider)
        ? createChatStreamWatchdog(this.chatStreamTimeouts)
        : undefined;
    const signal =
      watchdog === undefined ? deadlineSignal : AbortSignal.any([deadlineSignal, watchdog.signal]);
    const handleTextDelta = (delta: string): void => {
      watchdog?.textDelta(delta);
      try {
        opts.onTextDelta?.(delta);
      } catch {}
    };
    const handleStreamActivity = (activity: ModelStreamActivity): void => {
      watchdog?.activity(activity);
      try {
        opts.onStreamActivity?.(activity);
      } catch {}
    };
    let result: GenerateResult;
    try {
      result = await this.transport.generate({
        provider: this.config.llm.provider,
        model: this.config.llm.model,
        options: {
          ...opts,
          signal,
          onTextDelta: handleTextDelta,
          onStreamActivity: handleStreamActivity,
        },
      });
    } catch (err) {
      if (watchdog?.error !== undefined && isAbortError(err, watchdog.signal)) {
        throw watchdog.error;
      }
      // Relabel to TimeoutError only when OUR per-call timer fired AND the error
      // is abort-shaped: a 5xx/429/network thrown while the timer happens to be
      // aborted must keep its own class, and an outer caller cancellation that
      // never tripped our timer is not our deadline.
      if (deadline.aborted && isAbortError(err, deadline)) throw toTimeoutError(err);
      throw err;
    } finally {
      watchdog?.clear();
    }
    const durationMs = this.ports.now() - start;
    this.recordGenerate(opts, result, durationMs);
    return result;
  }

  private async dispatch(opts: GenerateOpts): Promise<GenerateResult> {
    if (this.config.llm.provider === "openai-codex") {
      const result = await codexGenerateText(
        {
          ...opts,
          modelId: this.config.llm.model,
          profileName: this.config.llm.authProfile ?? "openai-codex",
          stepLimit: opts.maxSteps,
        },
        {
          getAccessToken: this.ports.getAccessToken,
          classifyFailure: this.ports.classifyFailure,
        },
      );
      if (opts.caller === "chat" && result.text !== "") {
        notifyTextDelta(opts.onTextDelta, result.text);
      }
      return result;
    }

    if (this.config.llm.provider === "claude-cli") {
      const claudeCli = this.config.llm.claudeCli;
      if (claudeCli === undefined) {
        throw new Error("claude-cli provider requires llm.claudeCli configuration");
      }
      assertClaudeCliEnabled(claudeCli.enabled);
      this.claudeCliPool ??= createClaudeCliSessionPool({
        config: {
          enabled: claudeCli.enabled,
          cursorStorePath: claudeCli.cursorStorePath,
        },
      });
      this.claudeWorkingArea ??= createClaudeWorkingArea({
        forbiddenRoots: [dirname(claudeCli.cursorStorePath)],
        configDir: claudeCli.configDir,
      });
      const readiness = await ensureClaudeCliReady({
        workingArea: this.claudeWorkingArea,
        billing: claudeCli.billing,
        model: this.config.llm.model,
        ...(claudeCli.binaryPath === undefined ? {} : { binaryPath: claudeCli.binaryPath }),
        ...(claudeCli.configDir === undefined ? {} : { configDir: claudeCli.configDir }),
      });
      return claudeCliGenerateText(
        {
          ...opts,
          modelId: this.config.llm.model,
          stepLimit: opts.maxSteps,
        },
        {
          runtime: {
            binaryPath: readiness.binaryPath,
            configDir: claudeCli.configDir,
            billing: claudeCli.billing,
          },
          workingArea: this.claudeWorkingArea,
          pool: this.claudeCliPool,
        },
      );
    }

    if (this.config.llm.provider === "codex-agent") {
      const codexAgent = this.config.llm.codexAgent;
      if (codexAgent === undefined) {
        throw new Error("codex-agent provider requires llm.codexAgent configuration");
      }
      return codexAgentGenerateText(
        { ...opts, modelId: this.config.llm.model },
        {
          runtime: {
            enabled: codexAgent.enabled,
            binaryPath: codexAgent.binaryPath,
            reasoningEffort: codexAgent.reasoningEffort,
          },
        },
      );
    }

    if (!this.aiSdkModel) {
      throw new Error("AI SDK model not initialized");
    }

    // The provider renders tools before system, so breakpointing the FIRST
    // system block caches tools + stable prefix together. Which providers need
    // explicit breakpoints, and why the rest don't, lives on cacheBreakpointKey.
    const breakpointKey = this.breakpointKey;
    const ephemeral = (key: "anthropic" | "openrouter") => ({
      [key]: { cacheControl: { type: "ephemeral" as const } },
    });

    let system:
      | string
      | Array<{ role: "system"; content: string; providerOptions: ReturnType<typeof ephemeral> }>
      | undefined = opts.system;
    if (breakpointKey !== undefined && opts.system !== undefined) {
      const blocks = splitSystemPromptAtBoundary(opts.system);
      system = blocks
        ? [
            {
              role: "system" as const,
              content: blocks.prefix,
              providerOptions: ephemeral(breakpointKey),
            },
            {
              role: "system" as const,
              content: blocks.volatile,
              providerOptions: ephemeral(breakpointKey),
            },
          ]
        : [
            {
              role: "system" as const,
              content: opts.system,
              providerOptions: ephemeral(breakpointKey),
            },
          ];
    }

    // Message-level breakpoint on the last message so a multi-step tool turn
    // does not re-pay the whole history every step. Stamped onto a shallow
    // copy: the caller's array is reused across the retry/compaction loop and
    // enters the lineage-hash basis, so it must never be mutated here.
    let messages = opts.messages ?? [];
    if (breakpointKey !== undefined && messages.length > 0) {
      const last = messages[messages.length - 1];
      messages = [
        ...messages.slice(0, -1),
        {
          ...last,
          providerOptions: { ...last.providerOptions, ...ephemeral(breakpointKey) },
        } as ModelMessage,
      ];
    }

    const astra = this.config.llm.provider === "openai" && this.config.llm.model === "gpt-6-astra";
    const base = {
      model: this.aiSdkModel,
      ...(astra ? { providerOptions: { openai: { forceReasoning: true } } } : {}),
      system,
      tools: opts.tools,
      stopWhen: opts.stopWhen,
      maxOutputTokens: astra
        ? Math.min(opts.maxOutputTokens ?? 128_000, 128_000)
        : opts.maxOutputTokens,
      maxRetries: 0,
      abortSignal: opts.signal,
      experimental_context: opts.context,
    };
    if (opts.caller === "chat") {
      const result =
        opts.prompt !== undefined
          ? streamText({ ...base, prompt: opts.prompt })
          : streamText({ ...base, messages });
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            if (part.text === "") {
              notifyStreamActivity(opts.onStreamActivity, { type: "activity" });
            } else {
              notifyTextDelta(opts.onTextDelta, part.text);
            }
            break;
          case "tool-call":
            notifyStreamActivity(opts.onStreamActivity, {
              type: "tool_start",
              toolCallId: part.toolCallId,
            });
            break;
          case "tool-result":
          case "tool-error":
          case "tool-output-denied":
            notifyStreamActivity(opts.onStreamActivity, {
              type: "tool_end",
              toolCallId: part.toolCallId,
            });
            break;
          case "finish":
            if (astra && part.finishReason === "error") throw new Error("OpenAI response failed.");
            break;
          case "error":
            throw part.error;
          case "abort":
            throw new DOMException(part.reason ?? "Model stream aborted", "AbortError");
          default:
            notifyStreamActivity(opts.onStreamActivity, { type: "activity" });
        }
      }
      const [text, toolCalls, finishReason, usage, totalUsage, steps] = await Promise.all([
        result.text,
        result.toolCalls,
        result.finishReason,
        result.usage,
        result.totalUsage,
        result.steps,
      ]);
      return {
        text,
        toolCalls: toolCalls as GenerateResult["toolCalls"],
        finishReason,
        usage,
        totalUsage,
        steps: steps.length,
        providerReportedCostUsd:
          this.config.llm.provider === "openrouter"
            ? providerReportedCostFromSteps(steps)
            : undefined,
        cost: priceAiSdkUsage(
          this.config.llm.provider,
          this.config.llm.model,
          this.priced,
          totalUsage,
        ),
      };
    }

    const result =
      opts.prompt !== undefined
        ? await generateText({ ...base, prompt: opts.prompt })
        : await generateText({ ...base, messages });

    if (astra && result.finishReason === "error") throw new Error("OpenAI response failed.");
    return {
      text: result.text,
      toolCalls: result.toolCalls as GenerateResult["toolCalls"],
      finishReason: result.finishReason,
      usage: result.usage,
      totalUsage: result.totalUsage,
      steps: result.steps.length,
      providerReportedCostUsd:
        this.config.llm.provider === "openrouter"
          ? providerReportedCostFromSteps(result.steps)
          : undefined,
      cost: priceAiSdkUsage(
        this.config.llm.provider,
        this.config.llm.model,
        this.priced,
        result.totalUsage,
      ),
    };
  }

  private recordGenerate(opts: GenerateOpts, result: GenerateResult, durationMs: number): void {
    this.ports.usage.append({
      ts: this.ports.now(),
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

class ChatStreamTimeoutError extends Error {
  readonly code: "CHAT_TTFT_TIMEOUT" | "CHAT_INTER_CHUNK_TIMEOUT";

  constructor(code: "CHAT_TTFT_TIMEOUT" | "CHAT_INTER_CHUNK_TIMEOUT") {
    super(code);
    this.name = "TimeoutError";
    this.code = code;
  }
}

interface ChatStreamWatchdog {
  readonly signal: AbortSignal;
  readonly error: ChatStreamTimeoutError | undefined;
  textDelta(delta: string): void;
  activity(activity: ModelStreamActivity): void;
  clear(): void;
}

function createChatStreamWatchdog(timeouts: ChatStreamTimeouts): ChatStreamWatchdog {
  const controller = new AbortController();
  const activeToolIds = new Set<string>();
  let observedText = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error: ChatStreamTimeoutError | undefined;

  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    disarm();
    if (activeToolIds.size > 0 || controller.signal.aborted) return;
    const delayMs = observedText ? timeouts.interChunkMs : timeouts.ttftMs;
    timer = setTimeout(() => {
      error = new ChatStreamTimeoutError(
        observedText ? "CHAT_INTER_CHUNK_TIMEOUT" : "CHAT_TTFT_TIMEOUT",
      );
      controller.abort(error);
    }, delayMs);
  };

  arm();
  return {
    signal: controller.signal,
    get error() {
      return error;
    },
    textDelta(delta) {
      if (delta === "") {
        arm();
        return;
      }
      observedText = true;
      arm();
    },
    activity(activity) {
      if (activity.type === "tool_start") {
        activeToolIds.add(activity.toolCallId);
        disarm();
        return;
      }
      if (activity.type === "tool_end" && activeToolIds.delete(activity.toolCallId)) {
        if (activeToolIds.size === 0) arm();
        return;
      }
      arm();
    },
    clear: disarm,
  };
}

function validateChatStreamTimeouts(timeouts: ChatStreamTimeouts): ChatStreamTimeouts {
  for (const field of ["ttftMs", "interChunkMs"] as const) {
    const value = timeouts[field];
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new TypeError(`chatStreamTimeouts.${field} must be a finite positive integer`);
    }
  }
  return timeouts;
}

function notifyTextDelta(observer: GenerateOpts["onTextDelta"], delta: string): void {
  try {
    observer?.(delta);
  } catch {}
}

function notifyStreamActivity(
  observer: GenerateOpts["onStreamActivity"],
  activity: ModelStreamActivity,
): void {
  try {
    observer?.(activity);
  } catch {}
}

function providerReportedCostFromSteps(steps: readonly unknown[]): number | undefined {
  if (steps.length === 0) return undefined;
  let total = 0;
  for (const step of steps) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) return undefined;
    const providerMetadata = (step as { readonly providerMetadata?: unknown }).providerMetadata;
    if (
      providerMetadata === null ||
      typeof providerMetadata !== "object" ||
      Array.isArray(providerMetadata)
    ) {
      return undefined;
    }
    const openrouter = (providerMetadata as Record<string, unknown>).openrouter;
    if (openrouter === null || typeof openrouter !== "object" || Array.isArray(openrouter)) {
      return undefined;
    }
    const usage = (openrouter as Record<string, unknown>).usage;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return undefined;
    const cost = (usage as Record<string, unknown>).cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
    total += cost;
    if (!Number.isFinite(total)) return undefined;
  }
  return total;
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
  return priceInclusiveUsage(provider, modelId, {
    inputTokens: totalUsage.inputTokens ?? 0,
    outputTokens: totalUsage.outputTokens ?? 0,
    cacheReadTokens: details?.cacheReadTokens ?? 0,
    cacheWriteTokens: details?.cacheWriteTokens ?? 0,
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

function buildAiSdkModel(config: EngineConfig): LanguageModel {
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
      return openrouter.chat(config.llm.model, { usage: { include: true } });
    }
    case "openai-codex":
      throw new Error("openai-codex is handled via the bridge, not AI SDK");
    case "claude-cli":
      throw new Error("claude-cli is handled via the bridge, not AI SDK");
    case "codex-agent":
      throw new Error("codex-agent is handled via the bridge, not AI SDK");
  }
}
