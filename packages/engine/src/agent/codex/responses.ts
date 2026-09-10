import { asSchema } from "@ai-sdk/provider-utils";
import type { ModelMessage, ToolSet } from "ai";

import { extractAccountId } from "./jwt.js";

// NEVER convert to top-level runtime imports — keeps the module importable in a
// browser/Vite build where node:os is absent. The "node:" + "os" split prevents
// bundlers from statically resolving (and erroring on) the specifier.
let _os: typeof import("node:os") | null = null;
const dynamicImport = (specifier: string): Promise<unknown> => import(specifier);
const NODE_OS_SPECIFIER = "node:" + "os";
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  dynamicImport(NODE_OS_SPECIFIER).then((m) => {
    _os = m as typeof import("node:os");
  });
}

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

const CODEX_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexStopReason = "stop" | "length" | "toolUse" | "error";

export interface CodexToolCall {
  /** `${call_id}|${item_id}` — the call_id half pairs with the tool result. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CodexUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface CodexResponsesResult {
  text: string;
  toolCalls: CodexToolCall[];
  usage: CodexUsage;
  stopReason: CodexStopReason;
  responseId?: string;
  /** Present only when stopReason === "error" without a thrown rejection. */
  errorMessage?: string;
}

export interface CodexResponsesParams {
  modelId: string;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  accessToken: string;
  sessionId?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: string;
  textVerbosity?: "low" | "medium" | "high";
  temperature?: number;
  serviceTier?: string;
  signal?: AbortSignal;
  baseUrl?: string;
  onTextDelta?: (delta: string) => void;
}

// ============================================================================
// Inlined string helpers (pure; no second type system)
// ============================================================================

// Removes unpaired Unicode surrogates that break JSON serialization on many
// providers; properly paired emoji are preserved.
function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringifyToolOutput(output: unknown): string {
  if (output && typeof output === "object" && "type" in output) {
    const o = output as { type: string; value?: unknown };
    if (o.type === "text" && typeof o.value === "string") return o.value;
    if (o.type === "error-text" && typeof o.value === "string") return o.value;
    if (o.type === "json") return JSON.stringify(o.value);
    if (o.type === "error-json") return JSON.stringify(o.value);
  }
  return typeof output === "string" ? output : JSON.stringify(output);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "type" in part) {
        const p = part as { type: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") return p.text;
      }
      return "";
    })
    .join("");
}

// ============================================================================
// Message + tool conversion: AI-SDK → OpenAI Responses wire `input`
// ============================================================================

function convertMessagesToInput(messages: ModelMessage[]): unknown[] {
  const input: unknown[] = [];

  for (const [msgIndex, m] of messages.entries()) {
    if (m.role === "system") {
      // System travels via body.instructions, not input[].
      continue;
    }

    if (m.role === "user") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: sanitizeSurrogates(extractText(m.content)) }],
      });
      continue;
    }

    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        if (m.content) {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: sanitizeSurrogates(m.content), annotations: [] }],
            status: "completed",
            id: `msg_${msgIndex}`,
          });
        }
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === "text" && p.text) {
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: sanitizeSurrogates(p.text), annotations: [] }],
              status: "completed",
              id: `msg_${msgIndex}`,
            });
          } else if (p.type === "tool-call") {
            const [callId, itemId] = p.toolCallId.split("|");
            input.push({
              type: "function_call",
              id: itemId,
              call_id: callId,
              name: p.toolName,
              arguments: JSON.stringify(p.input ?? {}),
            });
          }
        }
      }
      continue;
    }

    if (m.role === "tool") {
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type !== "tool-result") continue;
          const [callId] = p.toolCallId.split("|");
          const text = stringifyToolOutput(p.output);
          input.push({
            type: "function_call_output",
            call_id: callId,
            output: sanitizeSurrogates(text.length > 0 ? text : "(see attached image)"),
          });
        }
      }
    }
  }

  return input;
}

async function convertResponsesTools(tools: ToolSet): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const schema = asSchema(t.inputSchema);
    const json = await Promise.resolve(schema.jsonSchema);
    out.push({
      type: "function",
      name,
      description: t.description ?? "",
      parameters: json,
      strict: null,
    });
  }
  return out;
}

// ============================================================================
// Request building
// ============================================================================

function clampReasoningEffort(modelId: string, effort: ReasoningEffort): string {
  const id = modelId.includes("/") ? (modelId.split("/").pop() as string) : modelId;
  if (
    (id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4")) &&
    effort === "minimal"
  )
    return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini")
    return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}

async function buildRequestBody(params: CodexResponsesParams): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    model: params.modelId,
    store: false,
    stream: true,
    instructions: params.system,
    input: convertMessagesToInput(params.messages),
    text: { verbosity: params.textVerbosity ?? "medium" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: params.sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.serviceTier !== undefined) body.service_tier = params.serviceTier;
  // Always emit `tools` (an empty array when none) to match the pre-vendoring
  // wire shape, where the bridge converted an absent tool set to [].
  body.tools = params.tools ? await convertResponsesTools(params.tools) : [];
  if (params.reasoningEffort !== undefined) {
    body.reasoning = {
      effort: clampReasoningEffort(params.modelId, params.reasoningEffort),
      summary: params.reasoningSummary ?? "auto",
    };
  }
  return body;
}

function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

// ============================================================================
// Headers
// ============================================================================

function buildSSEHeaders(accountId: string, token: string, sessionId?: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "codex");
  const userAgent = _os
    ? `cycling-coach (${_os.platform()} ${_os.release()}; ${_os.arch()})`
    : "cycling-coach (browser)";
  headers.set("User-Agent", userAgent);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (sessionId) {
    headers.set("session_id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }
  return headers;
}

// ============================================================================
// SSE parsing + event normalization
// ============================================================================

async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              yield JSON.parse(data) as Record<string, unknown>;
            } catch {
              // Drop malformed frames; the terminal response.completed drives the result.
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function normalizeCodexStatus(status: unknown): string | undefined {
  if (typeof status !== "string") return undefined;
  return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}

async function* mapCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type) continue;
    if (type === "error") {
      const code = (event as { code?: string }).code || "";
      const message = (event as { message?: string }).message || "";
      throw new Error(`Codex error: ${message || code || JSON.stringify(event)}`);
    }
    if (type === "response.failed") {
      const msg = (event as { response?: { error?: { message?: string } } }).response?.error?.message;
      throw new Error(msg || "Codex response failed");
    }
    if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
      const response = (event as { response?: { status?: unknown } }).response;
      const normalizedResponse = response
        ? { ...response, status: normalizeCodexStatus(response.status) }
        : response;
      yield { ...event, type: "response.completed", response: normalizedResponse };
      return;
    }
    yield event;
  }
}

// ============================================================================
// Stream accumulation → assembled result
// ============================================================================

function mapStopReason(status: string | undefined): CodexStopReason {
  if (!status) return "stop";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    case "in_progress":
    case "queued":
      return "stop";
    default:
      throw new Error(`Unhandled stop reason: ${status}`);
  }
}

interface ToolCallScratch {
  id: string;
  name: string;
  partialJson: string;
}

async function accumulate(
  events: AsyncIterable<Record<string, unknown>>,
  onTextDelta?: (delta: string) => void,
): Promise<CodexResponsesResult> {
  let text = "";
  // The current message item's text accumulates here and is committed to `text`
  // when the item completes; this keeps each item's text separate so the
  // server-authoritative reconciliation on output_item.done replaces only the
  // current item rather than clobbering text already committed by earlier items.
  let currentItemText = "";
  let currentItemEmitted = "";
  const emitTextDelta = (delta: string): void => {
    if (delta === "") return;
    currentItemEmitted += delta;
    onTextDelta?.(delta);
  };
  const commitCurrentItem = (): void => {
    if (currentItemText.startsWith(currentItemEmitted)) {
      emitTextDelta(currentItemText.slice(currentItemEmitted.length));
    }
    text += currentItemText;
    currentItemText = "";
    currentItemEmitted = "";
  };
  const toolScratch: ToolCallScratch[] = [];
  let currentItemType: "message" | "function_call" | "reasoning" | undefined;
  let currentMessageHasOutputText = false;
  let currentTool: ToolCallScratch | undefined;
  let usage: CodexUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let responseId: string | undefined;
  let stopReason: CodexStopReason = "stop";

  for await (const event of events) {
    const type = event.type as string;

    if (type === "response.created") {
      responseId = (event as { response?: { id?: string } }).response?.id ?? responseId;
    } else if (type === "response.output_item.added") {
      const item = (event as { item?: Record<string, unknown> }).item;
      const itemType = item?.type as string | undefined;
      // Commit any prior item's text before starting a new one (defensive: a
      // completed item normally commits via output_item.done first).
      commitCurrentItem();
      if (itemType === "function_call") {
        currentItemType = "function_call";
        currentTool = {
          id: `${item?.call_id as string}|${item?.id as string}`,
          name: item?.name as string,
          partialJson: (item?.arguments as string) || "",
        };
        toolScratch.push(currentTool);
      } else if (itemType === "message") {
        currentItemType = "message";
        currentMessageHasOutputText = false;
      } else {
        currentItemType = "reasoning";
      }
    } else if (type === "response.content_part.added") {
      if (currentItemType === "message") {
        const part = (event as { part?: { type?: string } }).part;
        if (part?.type === "output_text" || part?.type === "refusal") {
          currentMessageHasOutputText = true;
        }
      }
    } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      if (currentItemType === "message" && currentMessageHasOutputText) {
        const delta = (event as { delta?: string }).delta ?? "";
        currentItemText += delta;
        emitTextDelta(delta);
      }
    } else if (type === "response.function_call_arguments.delta") {
      if (currentTool) currentTool.partialJson += (event as { delta?: string }).delta ?? "";
    } else if (type === "response.function_call_arguments.done") {
      if (currentTool) currentTool.partialJson = (event as { arguments?: string }).arguments ?? currentTool.partialJson;
    } else if (type === "response.output_item.done") {
      const item = (event as { item?: Record<string, unknown> }).item;
      const itemType = item?.type as string | undefined;
      if (itemType === "function_call" && currentTool && !currentTool.partialJson) {
        currentTool.partialJson = (item?.arguments as string) || "{}";
      } else if (itemType === "message") {
        // The completed item carries the server-authoritative text. Reconcile
        // this item's text against it so a delta missed because
        // content_part.added never arrived (or arrived after its delta) is
        // recovered rather than dropped. Only overwrite when content is
        // actually present, so an empty/absent content array never wipes
        // legitimately-accumulated deltas.
        const content = item?.content as
          | Array<{ type?: string; text?: string; refusal?: string }>
          | undefined;
        if (Array.isArray(content) && content.length > 0) {
          const authoritative = content
            .map((c) => (c.type === "output_text" ? c.text ?? "" : c.refusal ?? ""))
            .join("");
          if (authoritative) currentItemText = authoritative;
        }
      }
      commitCurrentItem();
      currentItemType = undefined;
      currentTool = undefined;
      currentMessageHasOutputText = false;
    } else if (type === "response.completed") {
      const response = (event as {
        response?: {
          id?: string;
          status?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
          };
        };
      }).response;
      if (response?.id) responseId = response.id;
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        usage = {
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
        };
      }
      stopReason = mapStopReason(response?.status);
      if (toolScratch.length > 0 && stopReason === "stop") stopReason = "toolUse";
    }
  }

  // Commit a message item whose output_item.done never arrived (e.g. a stream
  // truncated after its deltas).
  commitCurrentItem();

  const toolCalls: CodexToolCall[] = toolScratch.map((t) => ({
    id: t.id,
    name: t.name,
    arguments: safeParseJson(t.partialJson || "{}"),
  }));

  return { text, toolCalls, usage, stopReason, responseId };
}

// ============================================================================
// Error parsing
// ============================================================================

async function parseErrorResponse(
  response: Response,
): Promise<{ message: string; friendlyMessage?: string }> {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
  let friendlyMessage: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { error?: Record<string, unknown> };
    const err = parsed?.error;
    if (err) {
      const code = (err.code as string) || (err.type as string) || "";
      if (
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) ||
        response.status === 429
      ) {
        const plan = err.plan_type ? ` (${(err.plan_type as string).toLowerCase()} plan)` : "";
        const mins =
          typeof err.resets_at === "number"
            ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
            : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      message = (err.message as string) || friendlyMessage || message;
    }
  } catch {
    // Non-JSON body; keep the raw text.
  }
  return { message, friendlyMessage };
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const msHeader = headers.get("retry-after-ms");
  if (msHeader) {
    const ms = parseInt(msHeader, 10);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const secHeader = headers.get("retry-after");
  if (secHeader) {
    const secs = parseInt(secHeader, 10);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  return undefined;
}

function isTimeoutAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  if (reason instanceof Error && /timeout|deadline/i.test(`${reason.name} ${reason.message}`)) {
    return true;
  }
  if (reason && typeof reason === "object") {
    const { name, message } = reason as { name?: unknown; message?: unknown };
    return /timeout|deadline/i.test(`${String(name ?? "")} ${String(message ?? "")}`);
  }
  return false;
}

function abortError(signal: AbortSignal | undefined, fallback?: unknown): Error {
  if (isTimeoutAbort(signal)) return new Error("Request was aborted");
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (fallback instanceof Error) return fallback;
  if (reason === undefined) return new Error("Request was aborted");
  if (typeof reason === "string") return new Error(reason);
  try {
    const serialized = JSON.stringify(reason);
    return new Error(serialized ?? "Request was aborted");
  } catch {
    return new Error("Request was aborted");
  }
}

// ============================================================================
// Main entrypoint — one round-trip, no internal retry loop
// ============================================================================

export async function codexResponses(params: CodexResponsesParams): Promise<CodexResponsesResult> {
  if (params.signal?.aborted) throw abortError(params.signal);

  const accountId = extractAccountId(params.accessToken);
  const headers = buildSSEHeaders(accountId, params.accessToken, params.sessionId);
  const body = await buildRequestBody(params);
  const bodyJson = JSON.stringify(body);

  let response: Response;
  try {
    response = await fetch(resolveCodexUrl(params.baseUrl), {
      method: "POST",
      headers,
      body: bodyJson,
      signal: params.signal,
    });
  } catch (err) {
    // A thrown fetch is a network failure (DNS/conn reset). Let it propagate so
    // the outer classifier reads the errno via the cause chain. Abort surfaces
    // as the verbatim string the timeout classifier matches.
    if (err instanceof Error && (err.name === "AbortError" || params.signal?.aborted)) {
      throw abortError(params.signal, err);
    }
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text();
    const fake = new Response(errorText, {
      status: response.status,
      statusText: response.statusText,
    });
    const info = await parseErrorResponse(fake);
    // For a bare 429 with an opaque body, the friendly message may not contain a
    // rate-limit token; appending the status keeps normalizeError's classifier
    // matching even without the old no-retry marker.
    const baseMessage = info.friendlyMessage || info.message;
    const message = response.status === 429 ? `${baseMessage} (status=429)` : baseMessage;
    const e = new Error(message) as Error & { httpStatus?: number; retryAfterMs?: number };
    e.httpStatus = response.status;
    const retryAfterMs = parseRetryAfterMs(response.headers);
    if (retryAfterMs !== undefined) e.retryAfterMs = retryAfterMs;
    throw e;
  }

  if (!response.body) throw new Error("No response body");

  let result: CodexResponsesResult;
  try {
    result = await accumulate(mapCodexEvents(parseSSE(response)), params.onTextDelta);
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || params.signal?.aborted)) {
      throw abortError(params.signal, err);
    }
    throw err;
  }

  // A fully-accumulated result is already paid for; return it even if the signal
  // races the boundary and flips to aborted after accumulation has resolved.
  return result;
}
