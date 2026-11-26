import {
  LOOPBACK_INACTIVE_PAGE,
  createPkce,
  loopbackResultPage,
  positiveTimeout,
  runLoopbackSignIn,
  timeoutSignal,
  type LoopbackCallbackOutcome,
  type LoopbackSignInHooks,
  type LoopbackSignInPhase,
} from "./loopback-sign-in.js";

export const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_KEY_STATUS_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_PAGE_URL = "https://openrouter.ai/settings/credits";
export const OPENROUTER_KEYS_PAGE_URL = "https://openrouter.ai/settings/keys";
export const OPENROUTER_CALLBACK_PATH = "/openrouter/callback";
export const OPENROUTER_CALLBACK_HOST = "localhost";
export const OPENROUTER_KEY_LABEL = "Enduragent";

const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const CREDIT_STATUS_TIMEOUT_MS = 10_000;
const CODE_PATTERN = /^[A-Za-z0-9._~-]{8,512}$/u;

export type OpenRouterSignInPhase = LoopbackSignInPhase;

export type OpenRouterSignInFailure =
  | "timed-out"
  | "cancelled"
  | "callback-unavailable"
  | "access-denied"
  | "exchange-failed"
  | "unreachable"
  | "code-rejected";

export type OpenRouterCreditStatus = "paid" | "never-paid" | "unknown";

export class OpenRouterSignInError extends Error {
  constructor(readonly reason: OpenRouterSignInFailure) {
    super(`OpenRouter sign-in failed: ${reason}`);
    this.name = "OpenRouterSignInError";
  }
}

export interface OpenRouterSignInOptions extends LoopbackSignInHooks {
  readonly fetch?: typeof globalThis.fetch;
  readonly authorizationTimeoutMs?: number;
  readonly tokenExchangeTimeoutMs?: number;
}

export interface OpenRouterCodeSignIn {
  readonly authorizeUrl: string;
  exchange(pastedText: string, signal?: AbortSignal): Promise<string>;
}

const RECEIVED_PAGE = loopbackResultPage(
  "Almost done",
  "Return to Enduragent while it finishes connecting OpenRouter. You can close this tab.",
);
const DENIED_PAGE = loopbackResultPage(
  "Access wasn’t allowed",
  "Nothing was saved. Return to Enduragent to sign in again.",
);

export function buildOpenRouterAuthorizeUrl(input: {
  readonly challenge: string;
  readonly callbackUrl?: string;
  readonly state?: string;
}): string {
  const url = new URL(OPENROUTER_AUTHORIZE_URL);
  if (input.callbackUrl !== undefined) url.searchParams.set("callback_url", input.callbackUrl);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", OPENROUTER_KEY_LABEL);
  if (input.state !== undefined) url.searchParams.set("state", input.state);
  return url.toString();
}

function readCallback(url: URL, state: string): LoopbackCallbackOutcome<"access-denied"> | null {
  const returnedState = url.searchParams.get("state");
  if (returnedState !== null && returnedState !== state) return null;
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || code === null || code.length === 0) {
    return { refused: "access-denied" };
  }
  return returnedState === state ? { code } : null;
}

export function parseOpenRouterCode(text: string): string | null {
  const trimmed = text.trim();
  const candidate = URL.canParse(trimmed) ? new URL(trimmed).searchParams.get("code") : trimmed;
  if (candidate === null || candidate.startsWith("sk-")) return null;
  return CODE_PATTERN.test(candidate) ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exchangeOpenRouterCode(input: {
  readonly code: string;
  readonly verifier: string;
  readonly rejectedCode: "code-rejected" | "exchange-failed";
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const doFetch = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(OPENROUTER_KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.verifier,
        code_challenge_method: "S256",
      }),
      signal: timeoutSignal(input.timeoutMs, input.signal),
    });
  } catch {
    throw new OpenRouterSignInError(input.signal?.aborted === true ? "cancelled" : "unreachable");
  }
  if (response.status !== 200) {
    const rejected = response.status === 400 || response.status === 403;
    throw new OpenRouterSignInError(rejected ? input.rejectedCode : "exchange-failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenRouterSignInError("exchange-failed");
  }
  if (!isRecord(body) || typeof body.key !== "string" || body.key.trim().length === 0) {
    throw new OpenRouterSignInError("exchange-failed");
  }
  return body.key.trim();
}

export async function signInWithOpenRouter(options: OpenRouterSignInOptions): Promise<string> {
  const authorizationTimeoutMs = positiveTimeout(
    options.authorizationTimeoutMs,
    AUTHORIZATION_TIMEOUT_MS,
  );
  const tokenExchangeTimeoutMs = positiveTimeout(
    options.tokenExchangeTimeoutMs,
    TOKEN_EXCHANGE_TIMEOUT_MS,
  );
  return runLoopbackSignIn({
    hooks: options,
    authorizationTimeoutMs,
    redirectHost: OPENROUTER_CALLBACK_HOST,
    callbackPath: OPENROUTER_CALLBACK_PATH,
    readCallback,
    pages: {
      received: RECEIVED_PAGE,
      inactive: LOOPBACK_INACTIVE_PAGE,
      refused: { "access-denied": DENIED_PAGE },
    },
    authorizeUrl: ({ redirectUri, state, challenge }) =>
      buildOpenRouterAuthorizeUrl({ callbackUrl: redirectUri, state, challenge }),
    exchange: (code, verifier) =>
      exchangeOpenRouterCode({
        code,
        verifier,
        rejectedCode: "exchange-failed",
        timeoutMs: tokenExchangeTimeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    fail: (reason) => new OpenRouterSignInError(reason),
  });
}

export function startOpenRouterCodeSignIn(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly tokenExchangeTimeoutMs?: number;
  } = {},
): OpenRouterCodeSignIn {
  const timeoutMs = positiveTimeout(options.tokenExchangeTimeoutMs, TOKEN_EXCHANGE_TIMEOUT_MS);
  const { verifier, challenge } = createPkce();
  return {
    authorizeUrl: buildOpenRouterAuthorizeUrl({ challenge }),
    exchange: async (pastedText, signal) => {
      if (signal?.aborted === true) throw new OpenRouterSignInError("cancelled");
      const code = parseOpenRouterCode(pastedText);
      if (code === null) throw new OpenRouterSignInError("code-rejected");
      return exchangeOpenRouterCode({
        code,
        verifier,
        rejectedCode: "code-rejected",
        timeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}

export async function readOpenRouterCreditStatus(input: {
  readonly key: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<OpenRouterCreditStatus> {
  const timeoutMs = positiveTimeout(input.timeoutMs, CREDIT_STATUS_TIMEOUT_MS);
  const doFetch = input.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(OPENROUTER_KEY_STATUS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${input.key}`, accept: "application/json" },
      signal: timeoutSignal(timeoutMs, input.signal),
    });
    if (response.status !== 200) return "unknown";
    const body: unknown = await response.json();
    const freeTier = isRecord(body) && isRecord(body.data) ? body.data.is_free_tier : undefined;
    if (freeTier === true) return "never-paid";
    return freeTier === false ? "paid" : "unknown";
  } catch {
    return "unknown";
  }
}
