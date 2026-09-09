import { asSchema, safeValidateTypes } from "@ai-sdk/provider-utils";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  SDKMessage,
  SDKResultMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { FinishReason, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import { z } from "zod";

import type { GenerateOpts, GenerateResult } from "../../llm-types.js";
import type { ModelStreamActivity } from "../../sport.js";
import type { ClaudeCliBilling, ClaudeCliRuntime } from "./env.js";
import { ClaudeCliConfigError, binaryMissingError, normalizeClaudeCliError } from "./errors.js";
import { resolveClaudeBinary } from "./executable.js";
import { buildQueryOptions, startGeneration, type SanitizedQueryOptions } from "./session.js";
import {
  CLAUDE_CLI_CHAT_LANE,
  claudeCliSessionKey,
  hashHistory,
  type ClaudeCliSessionPool,
  type SessionKey,
} from "./session-pool.js";
import type { ClaudeLaunchPurpose, ClaudeWorkingAreaPort } from "./working-area.js";

export const CLAUDE_CLI_MCP_SERVER_NAME = "coach";
export const CLAUDE_CLI_TOOL_PREFIX = `mcp__${CLAUDE_CLI_MCP_SERVER_NAME}__`;

const DEFAULT_STEP_LIMIT = 10;
const INTER_FRAME_STALL_MS = 120_000;
const TRANSCRIPT_OPEN = "<conversation-transcript>";
const TRANSCRIPT_CLOSE = "</conversation-transcript>";

const TERMINAL_REASON_PHRASES: Record<string, string> = {
  prompt_too_long: "prompt is too long",
  blocking_limit: "usage limit reached",
  rapid_refill_breaker: "rate limit",
  aborted_streaming: "request was aborted",
  aborted_tools: "request was aborted",
  api_error: "error_during_execution",
  model_error: "error_during_execution",
  turn_setup_failed: "error_during_execution",
};

export interface ClaudeCliBridgeRuntime {
  readonly binaryPath?: string;
  readonly configDir?: string;
  readonly billing: ClaudeCliBilling;
}

export interface ClaudeCliBridgePorts {
  readonly runtime: ClaudeCliBridgeRuntime;
  readonly workingArea: ClaudeWorkingAreaPort;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly query?: typeof sdkQuery;
  readonly resolveBinary?: (explicitPath?: string) => Promise<string | null>;
  readonly stallMs?: number;
  readonly pool?: ClaudeCliSessionPool;
}

export type ClaudeCliGenerateOpts = GenerateOpts & {
  modelId: string;
  stepLimit?: number;
};

export interface CoachToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CoachToolResult>;
}

export interface CoachToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface CoachToolContext {
  readonly messages: ModelMessage[];
  readonly signal?: AbortSignal;
  readonly context?: unknown;
}

function passthroughSchema(): Record<string, unknown> {
  return z.looseObject({}) as unknown as Record<string, unknown>;
}

function toolInputSchema(tool: ToolSet[string]): Record<string, unknown> {
  try {
    const jsonSchema = asSchema(tool.inputSchema).jsonSchema;
    const converted = z.fromJSONSchema(jsonSchema as never, { defaultTarget: "draft-7" });
    const shape = (converted as { shape?: Record<string, unknown> }).shape;
    if (shape !== undefined && Object.keys(shape).length > 0) return shape;
  } catch {
    return passthroughSchema();
  }
  return passthroughSchema();
}

function textResult(text: string, isError?: boolean): CoachToolResult {
  return isError === true
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export function buildCoachToolDefinitions(
  tools: ToolSet,
  ctx: CoachToolContext,
): CoachToolDefinition[] {
  let callCounter = 0;
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? name,
    inputSchema: toolInputSchema(tool),
    handler: async (args: Record<string, unknown>): Promise<CoachToolResult> => {
      callCounter += 1;
      const toolCallId = `claude-cli-${callCounter}`;
      if (typeof tool.execute !== "function") {
        return textResult(`Tool "${name}" is not executable`, true);
      }
      const validation = await safeValidateTypes({
        value: args,
        schema: asSchema(tool.inputSchema),
      });
      if (!validation.success) {
        return textResult(
          `Invalid arguments for tool "${name}": ${validation.error.message}`,
          true,
        );
      }
      try {
        const result = await tool.execute(validation.value, {
          toolCallId,
          messages: ctx.messages,
          abortSignal: ctx.signal,
          experimental_context: ctx.context,
        });
        return textResult(typeof result === "string" ? result : JSON.stringify(result));
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  }));
}

export interface CoachToolSurface {
  readonly server: McpSdkServerConfigWithInstance;
  readonly toolNames: string[];
}

export function buildCoachToolSurface(tools: ToolSet, ctx: CoachToolContext): CoachToolSurface {
  const definitions = buildCoachToolDefinitions(tools, ctx);
  const server = createSdkMcpServer({
    name: CLAUDE_CLI_MCP_SERVER_NAME,
    tools: definitions as never,
  });
  return {
    server,
    toolNames: definitions.map((definition) => `${CLAUDE_CLI_TOOL_PREFIX}${definition.name}`),
  };
}

export function buildCanUseTool(allowed: readonly string[]): CanUseTool {
  const permitted = new Set(allowed);
  return async (toolName, input) =>
    permitted.has(toolName)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `${toolName} is not permitted` };
}

function messageText(message: ModelMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "tool-call") {
      parts.push(`[tool-call ${part.toolName} ${JSON.stringify(part.input)}]`);
    } else if (part.type === "tool-result") {
      parts.push(`[tool-result ${part.toolName} ${JSON.stringify(part.output)}]`);
    }
  }
  return parts.join("\n");
}

export interface SplitPrompt {
  history: ModelMessage[];
  live: string;
}

export function splitPrompt(opts: Pick<GenerateOpts, "prompt" | "messages">): SplitPrompt {
  if (opts.prompt !== undefined) return { history: [], live: opts.prompt };
  const messages = opts.messages ?? [];
  if (messages.length === 0) return { history: [], live: "" };
  let liveIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      liveIndex = i;
      break;
    }
  }
  if (liveIndex < 0) return { history: messages.slice(), live: "" };
  return { history: messages.slice(0, liveIndex), live: messageText(messages[liveIndex]) };
}

export function renderPrompt(opts: Pick<GenerateOpts, "prompt" | "messages">): string {
  const { history, live } = splitPrompt(opts);
  if (history.length === 0) return live;
  const transcript = history
    .map((message) => `${message.role}: ${messageText(message)}`)
    .join("\n\n");
  return `${TRANSCRIPT_OPEN}\n${transcript}\n${TRANSCRIPT_CLOSE}\n\n${live}`;
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function validCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeTokenSum(...values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!validToken(value)) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return validToken(value) ? value : 0;
}

export function tokenTotalsFromResult(result: SDKResultMessage): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const modelUsage = (result as { modelUsage?: unknown }).modelUsage;
  if (modelUsage !== null && typeof modelUsage === "object") {
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      totals.input += readNumber(record, "inputTokens");
      totals.output += readNumber(record, "outputTokens");
      totals.cacheRead += readNumber(record, "cacheReadInputTokens");
      totals.cacheWrite += readNumber(record, "cacheCreationInputTokens");
    }
  }
  if (totals.input > 0 || totals.output > 0 || totals.cacheRead > 0 || totals.cacheWrite > 0) {
    return totals;
  }
  const usage = (result as { usage?: unknown }).usage;
  if (usage !== null && typeof usage === "object") {
    const record = usage as Record<string, unknown>;
    totals.input = readNumber(record, "input_tokens");
    totals.output = readNumber(record, "output_tokens");
    totals.cacheRead = readNumber(record, "cache_read_input_tokens");
    totals.cacheWrite = readNumber(record, "cache_creation_input_tokens");
  }
  return totals;
}

export function mapUsage(totals: TokenTotals): LanguageModelUsage {
  return {
    inputTokens: safeTokenSum(totals.input, totals.cacheRead, totals.cacheWrite),
    outputTokens: validToken(totals.output) ? totals.output : undefined,
    totalTokens: safeTokenSum(totals.input, totals.cacheRead, totals.cacheWrite, totals.output),
    reasoningTokens: undefined,
    cachedInputTokens: validToken(totals.cacheRead) ? totals.cacheRead : undefined,
    inputTokenDetails: {
      noCacheTokens: validToken(totals.input) ? totals.input : undefined,
      cacheReadTokens: validToken(totals.cacheRead) ? totals.cacheRead : undefined,
      cacheWriteTokens: validToken(totals.cacheWrite) ? totals.cacheWrite : undefined,
    },
    outputTokenDetails: {
      reasoningTokens: undefined,
      acceptedPredictionTokens: undefined,
      rejectedPredictionTokens: undefined,
    },
  } as unknown as LanguageModelUsage;
}

export function mapFinishReason(result: SDKResultMessage): FinishReason {
  if (result.subtype === "error_max_turns") return "tool-calls";
  switch (result.stop_reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "end_turn":
    case "stop_sequence":
    case null:
    case undefined:
      return "stop";
    default:
      return "other";
  }
}

function resultErrorMessage(result: SDKResultMessage): string {
  const parts: string[] = [];
  const errors = (result as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) if (typeof entry === "string") parts.push(entry);
  }
  const text = (result as { result?: unknown }).result;
  if (typeof text === "string" && text.trim() !== "") parts.push(text);
  const reason = result.terminal_reason;
  if (typeof reason === "string") {
    const phrase = TERMINAL_REASON_PHRASES[reason];
    parts.push(phrase ?? `terminal_reason=${reason}`);
  }
  return parts.length === 0 ? "Claude Code CLI returned an error result" : parts.join(" | ");
}

interface FrameCollector {
  text: string;
  toolCalls: GenerateResult["toolCalls"];
  retryAfterMs?: number;
  streamed: boolean;
  sessionId?: string;
  compactBoundary: boolean;
}

interface FrameHooks {
  onTextDelta?: (delta: string) => void;
  onStreamActivity?: (activity: ModelStreamActivity) => void;
  onSessionId?: (sessionId: string) => void;
  onCompactBoundary?: () => void;
}

function retryAfterFromRateLimit(frame: SDKMessage): number | undefined {
  const info = (frame as { rate_limit_info?: Record<string, unknown> }).rate_limit_info;
  if (info === undefined) return undefined;
  if (info.status !== "rejected") return undefined;
  const resetsAt = info.resetsAt;
  if (!validToken(resetsAt)) return undefined;
  const remainingMs = resetsAt * 1000 - Date.now();
  return remainingMs > 0 ? remainingMs : undefined;
}

function collectFrame(frame: SDKMessage, collector: FrameCollector, hooks: FrameHooks): void {
  const onTextDelta = hooks.onTextDelta;
  const onStreamActivity = hooks.onStreamActivity;

  const sessionId = (frame as { session_id?: unknown }).session_id;
  if (typeof sessionId === "string" && sessionId !== "" && collector.sessionId !== sessionId) {
    collector.sessionId = sessionId;
    try {
      hooks.onSessionId?.(sessionId);
    } catch {}
  }

  if (frame.type === "system" && (frame as { subtype?: unknown }).subtype === "compact_boundary") {
    collector.compactBoundary = true;
    try {
      hooks.onCompactBoundary?.();
    } catch {}
    return;
  }

  if (frame.type === "stream_event") {
    const event = (frame as unknown as { event?: Record<string, unknown> }).event;
    const delta = event?.delta as { type?: string; text?: string } | undefined;
    if (event?.type === "content_block_delta" && delta?.type === "text_delta") {
      const text = delta.text ?? "";
      if (text !== "") {
        collector.streamed = true;
        notify(onTextDelta, text);
      }
    }
    return;
  }

  if (frame.type === "assistant") {
    const content = (frame as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    const toolCalls: GenerateResult["toolCalls"] = [];
    let text = "";
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const name = typeof block.name === "string" ? block.name : "";
        toolCalls.push({
          type: "tool-call",
          toolCallId: block.id,
          toolName: name.startsWith(CLAUDE_CLI_TOOL_PREFIX)
            ? name.slice(CLAUDE_CLI_TOOL_PREFIX.length)
            : name,
          input: block.input,
        });
        notifyActivity(onStreamActivity, { type: "tool_start", toolCallId: block.id });
      }
    }
    collector.text = text;
    collector.toolCalls = toolCalls;
    if (!collector.streamed && text !== "") notify(onTextDelta, text);
    return;
  }

  if (frame.type === "user") {
    const content = (frame as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        notifyActivity(onStreamActivity, { type: "tool_end", toolCallId: block.tool_use_id });
      }
    }
    return;
  }

  if (frame.type === "rate_limit_event") {
    const retryAfterMs = retryAfterFromRateLimit(frame);
    if (retryAfterMs !== undefined) collector.retryAfterMs = retryAfterMs;
  }
}

function notify(observer: ((delta: string) => void) | undefined, delta: string): void {
  try {
    observer?.(delta);
  } catch {}
}

function notifyActivity(
  observer: ((activity: ModelStreamActivity) => void) | undefined,
  activity: ModelStreamActivity,
): void {
  try {
    observer?.(activity);
  } catch {}
}

function stalledError(stallMs: number): Error {
  const out = new Error(`Claude Code CLI stalled for ${stallMs}ms without a frame`);
  out.name = "TimeoutError";
  return out;
}

async function nextFrame(
  iterator: AsyncIterator<SDKMessage>,
  stallMs: number,
): Promise<IteratorResult<SDKMessage>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(stalledError(stallMs)), stallMs);
  });
  try {
    return await Promise.race([iterator.next(), stall]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function linkAbort(signal: AbortSignal | undefined): {
  controller: AbortController;
  release: () => void;
} {
  const controller = new AbortController();
  if (signal === undefined) return { controller, release: () => undefined };
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { controller, release: () => undefined };
  }
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return { controller, release: () => signal.removeEventListener("abort", onAbort) };
}

async function resolveRuntime(ports: ClaudeCliBridgePorts): Promise<ClaudeCliRuntime> {
  const explicit = ports.runtime.binaryPath;
  if (explicit !== undefined && explicit !== "") {
    return {
      binaryPath: explicit,
      configDir: ports.runtime.configDir,
      billing: ports.runtime.billing,
    };
  }
  const resolve =
    ports.resolveBinary ?? ((path?: string) => resolveClaudeBinary({ explicitPath: path }));
  const resolved = await resolve(explicit);
  if (resolved === null || resolved === "") throw binaryMissingError("claude");
  return {
    binaryPath: resolved,
    configDir: ports.runtime.configDir,
    billing: ports.runtime.billing,
  };
}

export type GenerationMode = "resume" | "rebuild" | "stateless";

export interface GenerationPlan {
  mode: GenerationMode;
  prompt: string;
  resume?: string;
  sessionId?: string;
}

export function buildGenerationOptions(
  opts: ClaudeCliGenerateOpts,
  runtime: ClaudeCliRuntime,
  baseEnv: NodeJS.ProcessEnv,
  surface: CoachToolSurface | null,
  abortController: AbortController,
  plan: GenerationPlan,
  cwd: string,
  assertWorkingArea: () => void,
): SanitizedQueryOptions {
  const toolNames = surface === null ? [] : surface.toolNames;
  return buildQueryOptions({
    runtime,
    baseEnv,
    model: opts.modelId,
    systemPrompt: opts.system,
    mcpServers: surface === null ? {} : { [CLAUDE_CLI_MCP_SERVER_NAME]: surface.server },
    tools: toolNames,
    allowedTools: toolNames,
    canUseTool: buildCanUseTool(toolNames),
    maxTurns: opts.stepLimit ?? DEFAULT_STEP_LIMIT,
    includePartialMessages: true,
    abortController,
    resume: plan.resume,
    sessionId: plan.sessionId,
    persistSession: plan.mode === "stateless" ? false : undefined,
    cwd,
    assertWorkingArea,
  });
}

interface GenerationHooks {
  onSessionId?: (sessionId: string) => void;
  onCompactBoundary?: () => void;
}

async function runGeneration(
  opts: ClaudeCliGenerateOpts,
  ports: ClaudeCliBridgePorts,
  runtime: ClaudeCliRuntime,
  plan: GenerationPlan,
  hooks: GenerationHooks = {},
  launchPurpose?: ClaudeLaunchPurpose,
): Promise<GenerateResult> {
  const baseEnv = ports.baseEnv ?? process.env;
  const stallMs = ports.stallMs ?? INTER_FRAME_STALL_MS;
  const initialMessages: ModelMessage[] = opts.prompt
    ? [{ role: "user", content: opts.prompt }]
    : (opts.messages ?? []);
  const surface =
    plan.mode === "stateless" || opts.tools === undefined || Object.keys(opts.tools).length === 0
      ? null
      : buildCoachToolSurface(opts.tools, {
          messages: initialMessages,
          signal: opts.signal,
          context: opts.context,
        });

  const { controller, release } = linkAbort(opts.signal);
  const purpose =
    launchPurpose ??
    (plan.mode === "stateless" ? "maintenance" : plan.mode === "resume" ? "resume" : "rebuild");
  const binding = await ports.workingArea.prepareForLaunch(purpose);
  const options = buildGenerationOptions(
    opts,
    runtime,
    baseEnv,
    surface,
    controller,
    plan,
    binding.cwd,
    binding.assertCurrent,
  );
  binding.assertCurrent();
  const generation = startGeneration({ prompt: plan.prompt, options }, { query: ports.query });

  const collector: FrameCollector = {
    text: "",
    toolCalls: [],
    streamed: false,
    compactBoundary: false,
  };
  let iterationFailure: unknown;
  try {
    const iterator = generation.frames()[Symbol.asyncIterator]();
    for (;;) {
      const step = await nextFrame(iterator, stallMs);
      if (step.done === true) break;
      collectFrame(step.value, collector, {
        onTextDelta: opts.onTextDelta,
        onStreamActivity: opts.onStreamActivity,
        onSessionId: hooks.onSessionId,
        onCompactBoundary: hooks.onCompactBoundary,
      });
    }
  } catch (err) {
    iterationFailure = err;
  } finally {
    release();
    await generation.close();
  }

  const result = generation.lastResult();
  const cleanupFailure = generation.cleanupError();
  if (result === null) {
    const normalized = normalizeClaudeCliError(
      iterationFailure ?? new Error("Claude Code CLI ended without a result frame"),
      { retryAfterMs: collector.retryAfterMs },
    );
    const carrier = normalized as Error & {
      retryAfterMs?: number;
      cleanupFailure?: ClaudeCliConfigError;
    };
    if (carrier.retryAfterMs === undefined && collector.retryAfterMs !== undefined) {
      carrier.retryAfterMs = collector.retryAfterMs;
    }
    if (cleanupFailure !== null && cleanupFailure !== normalized) {
      carrier.cleanupFailure = cleanupFailure;
    }
    throw normalized;
  }

  if (result.is_error === true && result.subtype !== "error_max_turns") {
    const failure = new Error(resultErrorMessage(result)) as Error & { httpStatus?: number };
    const status = (result as { api_error_status?: unknown }).api_error_status;
    if (validToken(status)) failure.httpStatus = status;
    const normalized = normalizeClaudeCliError(failure, {
      retryAfterMs: collector.retryAfterMs,
    }) as Error & { cleanupFailure?: ClaudeCliConfigError };
    if (cleanupFailure !== null) normalized.cleanupFailure = cleanupFailure;
    throw normalized;
  }

  if (cleanupFailure !== null) throw cleanupFailure;

  const text = result.subtype === "success" ? result.result : collector.text;
  const usage = mapUsage(tokenTotalsFromResult(result));
  return {
    text,
    toolCalls: collector.toolCalls,
    finishReason: mapFinishReason(result),
    usage,
    totalUsage: usage,
    steps: validToken(result.num_turns) ? result.num_turns : undefined,
    providerReportedCostUsd:
      runtime.billing === "api-key" && validCost(result.total_cost_usd)
        ? result.total_cost_usd
        : undefined,
    costBasis: runtime.billing === "api-key" ? "actual" : "notional",
  };
}

function isSubprocessDeath(err: unknown): boolean {
  return err instanceof Error && err.name === "NetworkError";
}

const RESUME_FAILURE_PATTERN =
  /no conversation found|session .{0,40}not found|unknown session|session is (busy|locked|in use)|cannot resume|could not resume|failed to resume|unable to resume|resume failed/i;

function isResumeFailure(err: unknown): boolean {
  if (isSubprocessDeath(err)) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  return RESUME_FAILURE_PATTERN.test(err.message);
}

export function isStatelessCaller(caller: GenerateOpts["caller"]): boolean {
  return caller === "flush" || caller === "compact" || caller === "intent-translation";
}

function assistantReply(text: string): ModelMessage {
  return { role: "assistant", content: text };
}

function postTurnHistory(split: SplitPrompt, text: string): ModelMessage[] {
  const out: ModelMessage[] = [...split.history];
  if (split.live !== "") out.push({ role: "user", content: split.live });
  out.push(assistantReply(text));
  return out;
}

export async function claudeCliGenerateText(
  opts: ClaudeCliGenerateOpts,
  ports: ClaudeCliBridgePorts,
): Promise<GenerateResult> {
  const runtime = await resolveRuntime(ports);
  const split = splitPrompt(opts);
  const pool = isStatelessCaller(opts.caller) ? undefined : ports.pool;

  if (pool === undefined) {
    const plan: GenerationPlan = isStatelessCaller(opts.caller)
      ? { mode: "stateless", prompt: renderPrompt(opts) }
      : { mode: "rebuild", prompt: renderPrompt(opts) };
    try {
      return await runGeneration(opts, ports, runtime, plan);
    } catch (err) {
      if (
        opts.caller === "intent-translation" ||
        !isSubprocessDeath(err) ||
        opts.signal?.aborted === true
      )
        throw err;
      return await runGeneration(opts, ports, runtime, plan, {}, "retry");
    }
  }

  const key: SessionKey = claudeCliSessionKey(
    opts.cacheKey ?? "",
    CLAUDE_CLI_CHAT_LANE,
    opts.modelId,
  );
  const historyHash = hashHistory(split.history);
  const acquired = await pool.acquire(key, historyHash);

  let observed: string | undefined;
  const hooks: GenerationHooks = {
    onSessionId: (sessionId) => {
      observed = sessionId;
      pool.observeSessionId(key, sessionId);
    },
    onCompactBoundary: () => pool.markDirty(key),
  };

  const settle = async (result: GenerateResult): Promise<GenerateResult> => {
    const sessionId = observed ?? "";
    await pool.commit(key, {
      sessionId,
      historyHash: hashHistory(postTurnHistory(split, result.text)),
    });
    return result;
  };

  let replayedAfterDeath = false;

  if (acquired.mode === "resume" && acquired.cursor !== null) {
    const plan: GenerationPlan = {
      mode: "resume",
      prompt: split.live,
      resume: acquired.cursor.sessionId,
    };
    try {
      return await settle(await runGeneration(opts, ports, runtime, plan, hooks));
    } catch (err) {
      const rebuildable = isResumeFailure(err) && opts.signal?.aborted !== true;
      if (rebuildable || err instanceof ClaudeCliConfigError) pool.invalidate(key);
      if (!rebuildable) throw err;
      replayedAfterDeath = isSubprocessDeath(err);
      observed = undefined;
    }
  }

  const rebuild = (): GenerationPlan => ({
    mode: "rebuild",
    prompt: renderPrompt(opts),
    sessionId: pool.mintSessionId(),
  });

  try {
    return await settle(await runGeneration(opts, ports, runtime, rebuild(), hooks));
  } catch (err) {
    pool.invalidate(key);
    if (replayedAfterDeath || !isSubprocessDeath(err) || opts.signal?.aborted === true) throw err;
    observed = undefined;
    return await settle(await runGeneration(opts, ports, runtime, rebuild(), hooks, "retry"));
  }
}
