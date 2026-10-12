import { markTurnToolFailure } from "./agent/turn-context.js";
import { generateText, streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, ModelMessage } from "ai";
import { isKeylessProvider, type ResolvedModelProfile } from "@enduragent/coach-contract";
import { dirname } from "node:path";

import { splitSystemPromptAtBoundary } from "./agent/system-prompt.js";
import { priceResolvedModelUsage, resolvedModelCacheReadSavingsUsd } from "./usage-cost.js";

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

export function usesKeylessTransport(provider: string): boolean {
  return isKeylessProvider(provider);
}

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
  private profile: ResolvedModelProfile;
  private ports: LLMHostPorts;
  private transport: ModelTransport;
  private aiSdkModel: LanguageModel | null;
  private breakpointKey: "anthropic" | "openrouter" | undefined;
  private chatStreamTimeouts: ChatStreamTimeouts;
  private claudeCliPool: ClaudeCliSessionPool | null = null;
  private claudeWorkingArea: ClaudeWorkingAreaPort | null;

  constructor(
    config: EngineConfig,
    ports: LLMHostPorts,
    profile: ResolvedModelProfile = config.models.chat,
  ) {
    this.config = config;
    this.profile = profile;
    this.ports = ports;
    this.aiSdkModel = usesKeylessTransport(profile.provider)
      ? null
      : buildAiSdkModel(config, profile);
    this.breakpointKey = cacheBreakpointKey(profile.provider, profile.model);
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
    const deadlineMs = Math.min(
      deadlineMsForCaller(opts.caller),
      opts.deadlineMs ?? Number.POSITIVE_INFINITY,
    );
    const { signal: deadlineSignal, deadline } = withLLMDeadline(opts.signal, deadlineMs);
    const watchdog =
      opts.caller === "chat" && !usesKeylessTransport(this.profile.provider)
        ? createChatStreamWatchdog(this.chatStreamTimeouts)
        : undefined;
    const signal =
      watchdog === undefined ? deadlineSignal : AbortSignal.any([deadlineSignal, watchdog.signal]);
    const handleTextDelta = (delta: string): void => {
      watchdog?.textDelta(delta);
      opts.onTextDelta?.(delta);
    };
    const handleStreamActivity = (activity: ModelStreamActivity): void => {
      watchdog?.activity(activity);
      opts.onStreamActivity?.(activity);
    };
    let result: GenerateResult;
    try {
      const generated = await this.transport.generate({
        provider: this.profile.provider,
        model: this.profile.model,
        options: {
          ...opts,
          signal,
          onTextDelta: handleTextDelta,
          onStreamActivity: handleStreamActivity,
        },
      });
      result = applyResolvedModelMetadata(generated, this.profile);
    } catch (err) {
      if (watchdog?.error !== undefined && isAbortError(err, watchdog.signal)) {
        throw watchdog.error;
      }
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
    if (this.profile.provider === "openai-codex") {
      return codexGenerateText(
        {
          ...opts,
          modelId: this.profile.model,
          profileName: this.config.llm.authProfile ?? "openai-codex",
          stepLimit: opts.maxSteps,
          onTextDelta: opts.caller === "chat" ? opts.onTextDelta : undefined,
        },
        {
          getAccessToken: this.ports.getAccessToken,
          classifyFailure: this.ports.classifyFailure,
        },
      );
    }

    if (this.profile.provider === "claude-cli") {
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
        model: this.profile.model,
        ...(claudeCli.binaryPath === undefined ? {} : { binaryPath: claudeCli.binaryPath }),
        ...(claudeCli.configDir === undefined ? {} : { configDir: claudeCli.configDir }),
      });
      return claudeCliGenerateText(
        {
          ...opts,
          modelId: this.profile.model,
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

    if (this.profile.provider === "codex-agent") {
      const codexAgent = this.config.llm.codexAgent;
      if (codexAgent === undefined) {
        throw new Error("codex-agent provider requires llm.codexAgent configuration");
      }
      return codexAgentGenerateText(
        { ...opts, modelId: this.profile.model },
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

    const astra = this.profile.provider === "openai" && this.profile.model === "gpt-6-astra";
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
          case "tool-error":
          case "tool-output-denied":
            markTurnToolFailure(opts.context, part.toolName);
            notifyStreamActivity(opts.onStreamActivity, {
              type: "tool_end",
              toolCallId: part.toolCallId,
            });
            break;
          case "tool-result":
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
          this.profile.provider === "openrouter" ? providerReportedCostFromSteps(steps) : undefined,
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
        this.profile.provider === "openrouter"
          ? providerReportedCostFromSteps(result.steps)
          : undefined,
    };
  }

  private recordGenerate(opts: GenerateOpts, result: GenerateResult, durationMs: number): void {
    this.ports.usage.append({
      ts: this.ports.now(),
      kind: "generate",
      caller: opts.caller,
      provider: this.profile.provider,
      model: this.profile.model,
      durationMs,
      steps: result.steps,
      ...usageFieldsFromResult(result),
      stopReason: result.finishReason,
    });
  }
}

function applyResolvedModelMetadata(
  result: GenerateResult,
  profile: ResolvedModelProfile,
): GenerateResult {
  const details = cacheTokenDetails(result.totalUsage);
  const usage =
    result.totalUsage === undefined
      ? undefined
      : {
          inputTokens: result.totalUsage.inputTokens ?? 0,
          outputTokens: result.totalUsage.outputTokens ?? 0,
          cacheReadTokens: details?.cacheReadTokens ?? 0,
          cacheWriteTokens: details?.cacheWriteTokens ?? 0,
        };
  const catalogCost =
    usage === undefined ? undefined : priceResolvedModelUsage(profile.pricing, usage);
  const cacheReadSavingsUsd =
    usage === undefined
      ? undefined
      : resolvedModelCacheReadSavingsUsd(profile.pricing, usage.cacheReadTokens);
  const cost = result.costBasis === "actual" ? result.cost : catalogCost;
  const { cost: _discardedCost, cacheReadSavingsUsd: _discardedSavings, ...base } = result;
  return {
    ...base,
    catalogRevision: profile.catalogRevision,
    ...(cost === undefined ? {} : { cost }),
    ...(cacheReadSavingsUsd === undefined ? {} : { cacheReadSavingsUsd }),
  };
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
  observer?.(delta);
}

function notifyStreamActivity(
  observer: GenerateOpts["onStreamActivity"],
  activity: ModelStreamActivity,
): void {
  observer?.(activity);
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

function deadlineMsForCaller(caller: GenerateOpts["caller"]): number {
  return caller === "chat" ? CHAT_LLM_CALL_DEADLINE_MS : LLM_CALL_DEADLINE_MS;
}

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

function buildAiSdkModel(config: EngineConfig, profile: ResolvedModelProfile): LanguageModel {
  switch (profile.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.llm.apiKey });
      return anthropic(profile.model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: config.llm.apiKey });
      return openai(profile.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: config.llm.apiKey });
      return google(profile.model);
    }
    case "deepseek": {
      const deepseek = createDeepSeek({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
      return deepseek(profile.model);
    }
    case "qwen": {
      const alibaba = createAlibaba({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
      return alibaba(profile.model);
    }
    case "minimax": {
      const minimax = createOpenAICompatible({
        name: "minimax",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.minimax,
      });
      return minimax(profile.model);
    }
    case "kimi": {
      const moonshot = createOpenAICompatible({
        name: "moonshot",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.kimi,
      });
      return moonshot(profile.model);
    }
    case "zai": {
      const zai = createOpenAICompatible({
        name: "zai",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.zai,
      });
      return zai(profile.model);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl,
      });
      return openrouter.chat(profile.model, { usage: { include: true } });
    }
    case "openai-codex":
      throw new Error("openai-codex is handled via the bridge, not AI SDK");
    case "claude-cli":
      throw new Error("claude-cli is handled via the bridge, not AI SDK");
    case "codex-agent":
      throw new Error("codex-agent is handled via the bridge, not AI SDK");
  }
}
