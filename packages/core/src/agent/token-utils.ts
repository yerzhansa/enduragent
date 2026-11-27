import { APICallError } from "@ai-sdk/provider";
import { isProviderAuthFailure } from "@enduragent/engine";
import { readRefreshFailureReason } from "../auth/refresh-failure.js";

const OVERFLOW_MESSAGE_PATTERNS = [
  "context_length",
  "context window",
  "maximum context",
  "token limit",
  "too many tokens",
  "content_too_large",
  "prompt is too long",
  "exceeds the maximum",
  "input token count",
] as const;

// A single OpenAI-family structured code; other providers signal overflow only
// in the message text, handled by the pattern list above.
const OVERFLOW_ERROR_CODES = new Set(["context_length_exceeded"]);

function matchesOverflowText(text: string): boolean {
  const lower = text.toLowerCase();
  return OVERFLOW_MESSAGE_PATTERNS.some((p) => lower.includes(p));
}

// A 400 is the only status that can carry a context-overflow invalid request;
// a generic 400 must stay invalid_request, so read the structured body rather
// than treating every 400 as overflow.
function apiCallOverflowSignal(err: APICallError): boolean {
  if (err.statusCode !== 400) return false;
  const data = err.data as
    | { error?: { code?: unknown; message?: unknown } }
    | undefined;
  const code = data?.error?.code;
  if (typeof code === "string" && OVERFLOW_ERROR_CODES.has(code)) return true;
  const bodyMessage = data?.error?.message;
  if (typeof bodyMessage === "string" && matchesOverflowText(bodyMessage)) return true;
  if (typeof err.responseBody === "string" && matchesOverflowText(err.responseBody)) return true;
  return false;
}

export function isContextOverflowError(err: unknown): boolean {
  // Codex-normalized overflow is authoritative (the bridge sets this name).
  if (err instanceof Error && err.name === "ContextOverflowError") return true;
  if (APICallError.isInstance(err) && apiCallOverflowSignal(err)) return true;
  if (!(err instanceof Error)) return false;
  return matchesOverflowText(err.message);
}

export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("deadline exceeded") ||
    err.name === "TimeoutError" ||
    ("code" in err && (err as { code: string }).code === "ETIMEDOUT")
  );
}

export function isRateLimitError(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    return err.statusCode === 429;
  }
  // Fallback for non-SDK errors
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests");
}

export type FailureReason =
  | "overflow"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "network"
  | "auth"
  | "reauth"
  | "payment_required"
  | "invalid_request"
  | "unknown";

const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

export function isServerError(err: unknown): boolean {
  if (APICallError.isInstance(err)) {
    const statusCode = err.statusCode ?? -1;
    return statusCode >= 500 && statusCode <= 599;
  }
  // A codex 5xx is normalized into a plain Error with this name so both
  // providers route the server-error class identically.
  return err instanceof Error && err.name === "ServerError";
}

interface Caused {
  code?: unknown;
  cause?: unknown;
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof Error && err.name === "NetworkError") return true;
  // undici hides the conn code on the wrapped inner error, so chase the chain.
  let n = err as Caused | null | undefined;
  const seen = new Set<unknown>();
  for (let d = 0; d < 5 && n != null && !seen.has(n); d++, n = n.cause as Caused | null) {
    seen.add(n);
    if (typeof n.code === "string" && NETWORK_ERROR_CODES.has(n.code)) return true;
  }
  return false;
}

export function isAuthError(err: unknown): boolean {
  if (isProviderAuthFailure(err)) return true;
  return APICallError.isInstance(err) && (err.statusCode === 401 || err.statusCode === 403);
}

// HTTP 402: the provider account cannot pay for the request. OpenRouter sends it
// as the response status, or as a `{ code: 402 }` error part mid-stream.
export function isPaymentRequiredError(err: unknown): boolean {
  if (APICallError.isInstance(err)) return err.statusCode === 402;
  return (
    typeof err === "object" &&
    err !== null &&
    !(err instanceof Error) &&
    (err as { code?: unknown }).code === 402
  );
}

export function isInvalidRequestError(err: unknown): boolean {
  return APICallError.isInstance(err) && err.statusCode === 400;
}

export function classifyFailure(err: unknown): FailureReason {
  const refreshFailureReason = readRefreshFailureReason(err);
  if (refreshFailureReason !== null) return refreshFailureReason;
  // Ahead of the message-text heuristics, so a provider's credit message can
  // never read as overflow, timeout or rate limit.
  if (isPaymentRequiredError(err)) return "payment_required";
  if (isContextOverflowError(err)) return "overflow";
  if (isTimeoutError(err)) return "timeout";
  if (isRateLimitError(err)) return "rate_limit";
  if (isServerError(err)) return "server_error";
  if (isNetworkError(err)) return "network";
  if (isAuthError(err)) return "auth";
  if (isInvalidRequestError(err)) return "invalid_request";
  return "unknown";
}

export function extractRetryAfterMs(err: unknown): number | null {
  if (!APICallError.isInstance(err)) return null;
  const headers = err.responseHeaders;
  if (!headers) return null;

  // Prefer precise ms header (OpenAI convention)
  const msHeader = headers["retry-after-ms"];
  if (msHeader) {
    const ms = parseInt(msHeader, 10);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }

  // Standard retry-after header (seconds)
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const secs = parseInt(retryAfter, 10);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }

  return null;
}

export function formatRateLimitWaitMs(ms: number | null): string {
  if (!ms) return "about a minute";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `~${secs} seconds`;
  return `~${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) > 1 ? "s" : ""}`;
}

export function formatRateLimitWait(err: unknown): string {
  return formatRateLimitWaitMs(extractRetryAfterMs(err));
}
