import type { FinishReason, LanguageModelUsage, ModelMessage } from "ai";

import type { GenerateOpts, GenerateResult } from "../../llm-types.js";
import { isProviderAuthFailure } from "../../provider-auth-failure.js";
import type { ModelStreamActivity } from "../../sport.js";
import {
  buildConfigOverrideArgs,
  CODEX_MCP_SERVER_NAME,
  type CodexMcpEndpointOverride,
} from "./config-overrides.js";
import {
  disabledLaneError,
  mcpIsolationError,
  normalizeCodexAgentError,
  unsupportedPlatformError,
} from "./errors.js";
import { startCoachMcpEndpoint, type CoachMcpEndpoint } from "./mcp-endpoint.js";
import { ensureCodexAgentReady, invalidateCodexAgentProbeCache } from "./probe.js";
import {
  CodexProcessExitError,
  type CodexNotification,
  type CodexNotificationCollector,
} from "./protocol.js";
import { startAppServer, type CodexAppServerSession } from "./session.js";
import { verifySpawnedChild } from "./verify.js";

export const MAX_CODEX_ITEMS = 60;
export const MAX_CODEX_DELTA_BYTES = 512 * 1024;
export const INTER_NOTIFICATION_STALL_MS = 120_000;
export const CODEX_ABORT_COMPLETION_GRACE_MS = 5_000;
export const CODEX_TERMINAL_ERROR_GRACE_MS = 3_000;

export const CODEX_APPROVAL_POLICY = "never";
export const CODEX_APPROVALS_REVIEWER = "user";
export const CODEX_THREAD_SANDBOX = "read-only";
export const CODEX_TURN_SANDBOX_POLICY_TYPE = "readOnly";

export const CODEX_TOOL_PREFIX = `${CODEX_MCP_SERVER_NAME}__`;

export const CODEX_REASONING_NOTIFICATION_METHODS: readonly string[] = [
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
];

const TRANSCRIPT_OPEN = "<conversation-transcript>";
const TRANSCRIPT_CLOSE = "</conversation-transcript>";
const PERSONA_OPEN = "<coach-persona>";
const PERSONA_CLOSE = "</coach-persona>";

const PERSONA_PREAMBLE = [
  "The block below is your operating persona for this conversation; adopt it completely and answer in its voice.",
  "You are talking with an endurance athlete, not working on a codebase: never mention files, repositories, patches or shell commands.",
  `Everything you may do is exposed as a tool by the "${CODEX_MCP_SERVER_NAME}" MCP server.`,
].join(" ");

const STATELESS_PREAMBLE = [
  "The block below is your instruction set for a single non-conversational request.",
  "Return exactly the artifact it asks for and nothing else: no preamble, no planning narration, no commentary, no closing summary.",
  "You have no tools for this request and there is nobody to ask.",
].join(" ");

export type CodexReasoningEffort = "low" | "medium" | "high" | "ultra";

export interface CodexAgentRuntime {
  readonly enabled: boolean;
  readonly binaryPath?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
}

export interface CodexAgentReadiness {
  readonly binaryPath: string;
  readonly foreignServers: readonly string[];
}

export interface CodexAgentReadinessInput {
  readonly binaryPath?: string;
  readonly model: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly forceRefresh?: boolean;
}

export type EnsureCodexAgentReady = (
  input: CodexAgentReadinessInput,
) => Promise<CodexAgentReadiness>;

export interface CodexAgentBridgePorts {
  readonly runtime: CodexAgentRuntime;
  readonly platform?: NodeJS.Platform;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly ensureReady?: EnsureCodexAgentReady;
  readonly invalidateProbeCache?: () => void;
  readonly startSession?: typeof startAppServer;
  readonly startEndpoint?: typeof startCoachMcpEndpoint;
  readonly stallMs?: number;
  readonly abortGraceMs?: number;
  readonly terminalErrorGraceMs?: number;
  readonly maxItems?: number;
  readonly maxDeltaBytes?: number;
}

export type CodexAgentGenerateOpts = GenerateOpts & { modelId: string };

export function isStatelessCaller(caller: GenerateOpts["caller"]): boolean {
  return caller === "flush" || caller === "compact" || caller === "intent-translation";
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

export function renderDeveloperInstructions(
  system: string | undefined,
  stateless: boolean,
): string | undefined {
  if (system === undefined || system === "") return undefined;
  const preamble = stateless ? STATELESS_PREAMBLE : PERSONA_PREAMBLE;
  return `${preamble}\n\n${PERSONA_OPEN}\n${system}\n${PERSONA_CLOSE}`;
}

export interface CodexTokenUsageBreakdown {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly totalTokens?: number;
}

function validToken(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenOrUndefined(value: unknown): number | undefined {
  return validToken(value) ? value : undefined;
}

export function mapCodexUsage(last: CodexTokenUsageBreakdown | undefined): LanguageModelUsage {
  const inputTokens = tokenOrUndefined(last?.inputTokens);
  const cacheReadTokens = tokenOrUndefined(last?.cachedInputTokens);
  const cacheWriteTokens = tokenOrUndefined(last?.cacheWriteInputTokens);
  const outputTokens = tokenOrUndefined(last?.outputTokens);
  const reasoningTokens = tokenOrUndefined(last?.reasoningOutputTokens);
  const totalTokens = tokenOrUndefined(last?.totalTokens);
  const noCacheTokens =
    inputTokens === undefined
      ? undefined
      : Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0));
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens: cacheReadTokens,
    inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens },
    outputTokenDetails: {
      reasoningTokens,
      acceptedPredictionTokens: undefined,
      rejectedPredictionTokens: undefined,
    },
  } as unknown as LanguageModelUsage;
}

function notifyTextDelta(observer: GenerateOpts["onTextDelta"], delta: string): void {
  if (delta === "") return;
  try {
    observer?.(delta);
  } catch {}
}

function notifyActivity(observer: GenerateOpts["onStreamActivity"]): void {
  try {
    observer?.({ type: "activity" } satisfies ModelStreamActivity);
  } catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stalledError(stallMs: number): Error {
  const out = new Error(`Codex app-server sent no notification for ${stallMs}ms`);
  out.name = "TimeoutError";
  return out;
}

function abortErrorFrom(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const out = new Error("Codex turn aborted");
  out.name = "AbortError";
  return out;
}

function emptyTextError(): Error {
  return normalizeCodexAgentError(
    new Error("Codex completed the turn without any assistant text."),
    { fallback: "server-error" },
  );
}

interface AgentMessageRecord {
  readonly id: string;
  readonly text: string;
}

interface TurnCollector {
  messages: AgentMessageRecord[];
  completedMessageIds: Set<string>;
  toolCalls: GenerateResult["toolCalls"];
  itemsCompleted: number;
  deltaBytes: number;
  emitted: string;
  usage: LanguageModelUsage | undefined;
  recordedError: Error | null;
  completedTurn: Record<string, unknown> | null;
}

function newCollector(): TurnCollector {
  return {
    messages: [],
    completedMessageIds: new Set<string>(),
    toolCalls: [],
    itemsCompleted: 0,
    deltaBytes: 0,
    emitted: "",
    usage: undefined,
    recordedError: null,
    completedTurn: null,
  };
}

function assembledText(collector: TurnCollector): string {
  return collector.messages.map((message) => message.text).join("\n\n");
}

function boundedText(collector: TurnCollector): string {
  const assembled = assembledText(collector);
  return collector.emitted.length > assembled.length ? collector.emitted : assembled;
}

function openMessageBoundary(
  collector: TurnCollector,
  itemId: string,
  opts: CodexAgentGenerateOpts,
): void {
  if (collector.messages.length === 0) return;
  if (collector.completedMessageIds.has(itemId)) return;
  if (collector.emitted !== assembledText(collector)) return;
  collector.emitted += "\n\n";
  notifyTextDelta(opts.onTextDelta, "\n\n");
}

function flushStreamedText(collector: TurnCollector, opts: CodexAgentGenerateOpts): void {
  const expected = assembledText(collector);
  if (!expected.startsWith(collector.emitted)) return;
  const remainder = expected.slice(collector.emitted.length);
  if (remainder === "") return;
  collector.emitted = expected;
  notifyTextDelta(opts.onTextDelta, remainder);
}

function toolNameOf(item: Record<string, unknown>): string {
  const tool = typeof item.tool === "string" ? item.tool : "";
  return tool.startsWith(CODEX_TOOL_PREFIX) ? tool.slice(CODEX_TOOL_PREFIX.length) : tool;
}

function errorFromNotification(params: Record<string, unknown>): Error {
  const payload = isRecord(params.error) ? params.error : {};
  const message = typeof payload.message === "string" ? payload.message : "";
  return new Error(message === "" ? "Codex reported an error with no message." : message);
}

type NotificationOutcome = "continue" | "completed" | "bounded" | "terminal-error";

interface CollectorBounds {
  readonly stallMs: number;
  readonly abortGraceMs: number;
  readonly terminalErrorGraceMs: number;
  readonly maxItems: number;
  readonly maxDeltaBytes: number;
}

function handleNotification(
  notification: CodexNotification,
  collector: TurnCollector,
  opts: CodexAgentGenerateOpts,
  bounds: CollectorBounds,
  stateless: boolean,
): NotificationOutcome {
  const params = isRecord(notification.params) ? notification.params : {};

  switch (notification.method) {
    case "item/agentMessage/delta": {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta === "") return "continue";
      collector.deltaBytes += Buffer.byteLength(delta, "utf8");
      if (!stateless) {
        openMessageBoundary(
          collector,
          typeof params.itemId === "string" ? params.itemId : "",
          opts,
        );
        collector.emitted += delta;
        notifyTextDelta(opts.onTextDelta, delta);
      }
      return collector.deltaBytes > bounds.maxDeltaBytes ? "bounded" : "continue";
    }
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/mcpToolCall/progress":
    case "item/started":
    case "turn/started":
    case "thread/started": {
      const delta = typeof params.delta === "string" ? params.delta : "";
      collector.deltaBytes += Buffer.byteLength(delta, "utf8");
      notifyActivity(opts.onStreamActivity);
      return collector.deltaBytes > bounds.maxDeltaBytes ? "bounded" : "continue";
    }
    case "item/completed": {
      const item = isRecord(params.item) ? params.item : {};
      collector.itemsCompleted += 1;
      if (item.type === "agentMessage") {
        const id = typeof item.id === "string" ? item.id : String(collector.messages.length);
        collector.messages.push({ id, text: typeof item.text === "string" ? item.text : "" });
        collector.completedMessageIds.add(id);
        if (!stateless) flushStreamedText(collector, opts);
      } else if (item.type === "mcpToolCall") {
        collector.toolCalls.push({
          type: "tool-call",
          toolCallId: typeof item.id === "string" ? item.id : `${collector.toolCalls.length}`,
          toolName: toolNameOf(item),
          input: item.arguments,
        });
      }
      notifyActivity(opts.onStreamActivity);
      return collector.itemsCompleted >= bounds.maxItems ? "bounded" : "continue";
    }
    case "thread/tokenUsage/updated": {
      const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
      const last = isRecord(usage.last) ? (usage.last as CodexTokenUsageBreakdown) : undefined;
      if (last !== undefined) collector.usage = mapCodexUsage(last);
      return "continue";
    }
    case "error": {
      collector.recordedError = errorFromNotification(params);
      return params.willRetry === true ? "continue" : "terminal-error";
    }
    case "turn/completed": {
      collector.completedTurn = isRecord(params.turn) ? params.turn : {};
      return "completed";
    }
    default:
      return "continue";
  }
}

type NextOutcome =
  | { readonly kind: "notification"; readonly value: CodexNotification }
  | { readonly kind: "closed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

type NotificationReader = (
  timeoutMs: number,
  signal: AbortSignal | undefined,
) => Promise<NextOutcome>;

function createReader(source: CodexNotificationCollector): NotificationReader {
  let pending: Promise<IteratorResult<CodexNotification>> | null = null;
  return (timeoutMs, signal) => {
    pending ??= source.next();
    const current = pending;
    return new Promise<NextOutcome>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => finish({ kind: "aborted" });
      const finish = (outcome: NextOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      if (signal !== undefined) {
        if (signal.aborted) {
          finish({ kind: "aborted" });
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      void current.then(
        (step) => {
          if (pending === current) pending = null;
          finish(
            step.done === true ? { kind: "closed" } : { kind: "notification", value: step.value },
          );
        },
        () => {
          if (pending === current) pending = null;
          finish({ kind: "closed" });
        },
      );
    });
  };
}

const LANE_NORMALIZED_ERROR_NAMES = new Set([
  "AbortError",
  "CodexAgentConfigError",
  "ContextOverflowError",
  "NetworkError",
  "RateLimitError",
  "ServerError",
  "TimeoutError",
]);

function normalizeOnce(err: unknown): Error {
  if (err instanceof Error && LANE_NORMALIZED_ERROR_NAMES.has(err.name)) return err;
  return normalizeCodexAgentError(err);
}

function exitError(session: CodexAppServerSession): Error {
  const exit = session.exitStatus() ?? { code: null, signal: null };
  return new CodexProcessExitError(exit, session.stderrTail());
}

interface TurnOutcome {
  readonly text: string;
  readonly finishReason: FinishReason;
}

async function collectTurn(args: {
  readonly session: CodexAppServerSession;
  readonly reader: NotificationReader;
  readonly collector: TurnCollector;
  readonly opts: CodexAgentGenerateOpts;
  readonly bounds: CollectorBounds;
  readonly stateless: boolean;
  readonly interrupt: () => void;
}): Promise<TurnOutcome> {
  const { collector, opts, bounds, session } = args;
  const signal = opts.signal;
  let phase: "live" | "terminal-error" | "aborting" = "live";
  let waitMs = bounds.stallMs;

  for (;;) {
    if (phase !== "aborting" && signal?.aborted === true) {
      args.interrupt();
      phase = "aborting";
      waitMs = bounds.abortGraceMs;
    }

    const step = await args.reader(waitMs, phase === "aborting" ? undefined : signal);

    if (step.kind === "aborted") continue;

    if (step.kind === "timeout") {
      if (phase === "aborting") throw abortErrorFrom(signal);
      if (phase === "terminal-error" && collector.recordedError !== null) {
        throw normalizeCodexAgentError(collector.recordedError, { fallback: "server-error" });
      }
      args.interrupt();
      throw stalledError(bounds.stallMs);
    }

    if (step.kind === "closed") {
      if (phase === "terminal-error" && collector.recordedError !== null) {
        throw normalizeCodexAgentError(collector.recordedError, { fallback: "server-error" });
      }
      throw normalizeCodexAgentError(exitError(session));
    }

    const outcome = handleNotification(step.value, collector, opts, bounds, args.stateless);

    if (outcome === "terminal-error") {
      phase = "terminal-error";
      waitMs = bounds.terminalErrorGraceMs;
      continue;
    }

    if (outcome === "bounded") {
      args.interrupt();
      return { text: boundedText(collector), finishReason: "stop" };
    }

    if (outcome !== "completed") continue;

    if (phase === "aborting") throw abortErrorFrom(signal);

    const turn = collector.completedTurn ?? {};
    const status = typeof turn.status === "string" ? turn.status : "completed";

    if (status === "failed") {
      const payload = isRecord(turn.error) ? turn.error : {};
      const message = typeof payload.message === "string" ? payload.message : "";
      throw normalizeCodexAgentError(
        new Error(message === "" ? "Codex ended the turn with a failure." : message),
        { fallback: "server-error" },
      );
    }

    const text = assembledText(collector);
    if (status === "interrupted") return { text, finishReason: "stop" };
    if (text === "") throw emptyTextError();
    return { text, finishReason: "stop" };
  }
}

async function defaultEnsureReady(input: CodexAgentReadinessInput): Promise<CodexAgentReadiness> {
  const result = await ensureCodexAgentReady({
    ...(input.binaryPath === undefined ? {} : { binaryPath: input.binaryPath }),
    model: input.model,
    baseEnv: input.baseEnv,
    ...(input.forceRefresh === undefined ? {} : { forceRefresh: input.forceRefresh }),
  });
  if (result.status === "refused") throw result.error;
  return { binaryPath: result.binaryPath, foreignServers: result.foreignServers };
}

interface AttemptInput {
  readonly opts: CodexAgentGenerateOpts;
  readonly ports: CodexAgentBridgePorts;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly binaryPath: string;
  readonly foreignServers: readonly string[];
  readonly endpoint: CoachMcpEndpoint | null;
  readonly stateless: boolean;
  readonly bounds: CollectorBounds;
  readonly invalidateProbeCache: () => void;
}

type AttemptOutcome =
  | { readonly kind: "result"; readonly result: GenerateResult }
  | { readonly kind: "stale-census"; readonly servers: readonly string[] };

async function attemptGeneration(input: AttemptInput): Promise<AttemptOutcome> {
  const { opts, ports, endpoint, stateless, bounds } = input;
  const mcp: CodexMcpEndpointOverride | undefined =
    endpoint === null
      ? undefined
      : {
          url: endpoint.url,
          bearerEnvName: endpoint.bearerEnvName,
          enabledTools: endpoint.toolNames,
        };

  const configArgs = buildConfigOverrideArgs({
    foreignServers: input.foreignServers,
    mcp,
  });

  const start = ports.startSession ?? startAppServer;
  const session = await start({
    binaryPath: input.binaryPath,
    baseEnv: input.baseEnv,
    configArgs,
    bearer:
      endpoint === null
        ? undefined
        : { envName: endpoint.bearerEnvName, token: endpoint.bearerToken },
    optOutNotificationMethods: stateless ? CODEX_REASONING_NOTIFICATION_METHODS : undefined,
  });

  let threadId = "";
  let turnId = "";
  let interrupted = false;
  const interrupt = (): void => {
    if (interrupted || threadId === "" || turnId === "") return;
    interrupted = true;
    void session.client.request("turn/interrupt", { threadId, turnId }).then(
      () => undefined,
      () => undefined,
    );
  };

  try {
    const verdict = await verifySpawnedChild(session.client, {
      censusForeignServers: input.foreignServers,
      mcp,
    });
    if (verdict.status === "refuse") throw verdict.error;
    if (verdict.status === "stale-census") {
      return {
        kind: "stale-census",
        servers: [...new Set([...input.foreignServers, ...verdict.uncensusedServers])],
      };
    }

    const notifications = session.notifications();
    const reader = createReader(notifications);

    const thread = await session.client.request<{ thread?: { id?: unknown } }>("thread/start", {
      ephemeral: true,
      model: opts.modelId,
      developerInstructions: renderDeveloperInstructions(opts.system, stateless),
      approvalPolicy: CODEX_APPROVAL_POLICY,
      approvalsReviewer: CODEX_APPROVALS_REVIEWER,
      sandbox: CODEX_THREAD_SANDBOX,
    });
    threadId = typeof thread?.thread?.id === "string" ? thread.thread.id : "";
    if (threadId === "") throw new Error("Codex app-server started a thread with no id.");

    const effort = ports.runtime.reasoningEffort;
    const turn = await session.client.request<{ turn?: { id?: unknown } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: renderPrompt(opts) }],
      ...(effort === undefined ? {} : { effort }),
      approvalPolicy: CODEX_APPROVAL_POLICY,
      approvalsReviewer: CODEX_APPROVALS_REVIEWER,
      sandboxPolicy: { type: CODEX_TURN_SANDBOX_POLICY_TYPE },
    });
    turnId = typeof turn?.turn?.id === "string" ? turn.turn.id : "";

    const collector = newCollector();
    const outcome = await collectTurn({
      session,
      reader,
      collector,
      opts,
      bounds,
      stateless,
      interrupt,
    });

    const usage = collector.usage ?? mapCodexUsage(undefined);
    return {
      kind: "result",
      result: {
        text: outcome.text,
        toolCalls: collector.toolCalls,
        finishReason: outcome.finishReason,
        usage,
        totalUsage: usage,
        steps: collector.itemsCompleted,
        costBasis: "notional",
      },
    };
  } catch (err) {
    const normalized = normalizeOnce(err);
    if (isProviderAuthFailure(normalized)) input.invalidateProbeCache();
    throw normalized;
  } finally {
    await session.close();
  }
}

export async function codexAgentGenerateText(
  opts: CodexAgentGenerateOpts,
  ports: CodexAgentBridgePorts,
): Promise<GenerateResult> {
  if (opts.modelId === "gpt-6-astra") {
    throw new Error("GPT-6 Astra is not enabled for this connection; use the public OpenAI API.");
  }
  if ((ports.platform ?? process.platform) === "win32") throw unsupportedPlatformError();
  if (ports.runtime.enabled !== true) throw disabledLaneError();

  const baseEnv = ports.baseEnv ?? process.env;
  const stateless = isStatelessCaller(opts.caller);
  const ensureReady = ports.ensureReady ?? defaultEnsureReady;
  const invalidateProbeCache = ports.invalidateProbeCache ?? invalidateCodexAgentProbeCache;
  const bounds: CollectorBounds = {
    stallMs: ports.stallMs ?? INTER_NOTIFICATION_STALL_MS,
    abortGraceMs: ports.abortGraceMs ?? CODEX_ABORT_COMPLETION_GRACE_MS,
    terminalErrorGraceMs: ports.terminalErrorGraceMs ?? CODEX_TERMINAL_ERROR_GRACE_MS,
    maxItems: ports.maxItems ?? MAX_CODEX_ITEMS,
    maxDeltaBytes: ports.maxDeltaBytes ?? MAX_CODEX_DELTA_BYTES,
  };

  const readiness = await ensureReady({
    binaryPath: ports.runtime.binaryPath,
    model: opts.modelId,
    baseEnv,
  });

  const tools = opts.tools;
  const startEndpoint = ports.startEndpoint ?? startCoachMcpEndpoint;
  const historyMessages: ModelMessage[] =
    opts.prompt === undefined ? (opts.messages ?? []) : [{ role: "user", content: opts.prompt }];
  const endpoint =
    stateless || tools === undefined || Object.keys(tools).length === 0
      ? null
      : await startEndpoint({
          tools,
          ctx: opts.context,
          abortSignal: opts.signal,
          messages: historyMessages,
        });

  try {
    let foreignServers = readiness.foreignServers;
    for (let attempt = 0; ; attempt++) {
      const outcome = await attemptGeneration({
        opts,
        ports,
        baseEnv,
        binaryPath: readiness.binaryPath,
        foreignServers,
        endpoint,
        stateless,
        bounds,
        invalidateProbeCache,
      });
      if (outcome.kind === "result") return outcome.result;
      if (attempt > 0) {
        throw mcpIsolationError(
          `the MCP server '${outcome.servers.join("', '")}' is still enabled after a fresh census`,
        );
      }
      invalidateProbeCache();
      const refreshed = await ensureReady({
        binaryPath: ports.runtime.binaryPath,
        model: opts.modelId,
        baseEnv,
        forceRefresh: true,
      });
      foreignServers = [...new Set([...refreshed.foreignServers, ...outcome.servers])];
    }
  } finally {
    await endpoint?.close();
  }
}
