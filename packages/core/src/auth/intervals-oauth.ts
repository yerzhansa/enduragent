import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  decodeIntervalsCredential,
  encodeIntervalsOAuthCredential,
} from "../intervals-credential.js";

export const INTERVALS_OAUTH_CLIENT_ID = "1928";
export const INTERVALS_AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
export const INTERVALS_TOKEN_URL = "https://intervals.icu/api/oauth/token";
export const INTERVALS_DISCONNECT_URL = "https://intervals.icu/api/v1/disconnect-app";
export const INTERVALS_OAUTH_SCOPE = "ACTIVITY:READ,WELLNESS:READ,CALENDAR:WRITE,SETTINGS:READ";
export const INTERVALS_CALLBACK_PATH = "/intervals/callback";

const CALLBACK_HOST = "127.0.0.1";
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 10_000;
const CALLBACK_FORCE_CLOSE_MS = 500;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface IntervalsOAuthGrant {
  readonly credential: string;
  readonly scope: string;
  readonly athleteId: string;
  readonly athleteName: string;
}

export type IntervalsSignInPhase = "waiting-for-browser" | "completing-sign-in";

export type IntervalsSignInFailure =
  | "access-denied"
  | "authorization-failed"
  | "timed-out"
  | "cancelled"
  | "callback-unavailable"
  | "exchange-failed"
  | "unreachable";

export class IntervalsSignInError extends Error {
  constructor(readonly reason: IntervalsSignInFailure) {
    super(`intervals.icu sign-in failed: ${reason}`);
    this.name = "IntervalsSignInError";
  }
}

export interface IntervalsSignInOptions {
  readonly openExternal: (url: string) => Promise<void>;
  readonly onAuthorizeUrl?: (url: string) => void;
  readonly onBrowserOpenFailed?: () => void;
  readonly onPhase?: (phase: IntervalsSignInPhase) => void;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly authorizationTimeoutMs?: number;
  readonly tokenExchangeTimeoutMs?: number;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f2f5f8;color:#16202b;font-family:-apple-system,system-ui,sans-serif"><main style="max-width:440px;margin:18vh auto 0;padding:32px 28px;background:#fff;border:1px solid #dfe5eb;border-radius:12px"><div style="font-size:12px;font-weight:600;letter-spacing:.06em;color:#57636e">ENDURAGENT</div><h1 style="margin:12px 0 0;font-size:20px;line-height:28px">${title}</h1><p style="margin:12px 0 0;font-size:14px;line-height:20px;color:#57636e">${body}</p></main></body></html>`;
}

const RECEIVED_PAGE = page(
  "Almost done",
  "Return to Enduragent while it finishes connecting Intervals.icu. You can close this tab.",
);
const DENIED_PAGE = page(
  "Access wasn’t allowed",
  "Nothing was saved. Return to Enduragent to sign in again.",
);
const FAILED_PAGE = page(
  "Intervals.icu couldn’t finish the sign-in",
  "Nothing was saved. Return to Enduragent to try again.",
);
const INACTIVE_PAGE = page(
  "This sign-in isn’t active",
  "Start the sign-in again from Enduragent. You can close this tab.",
);

type CallbackOutcome =
  | { readonly code: string }
  | { readonly refused: "access-denied" | "authorization-failed" };

interface CallbackServer {
  readonly port: number;
  readonly outcome: Promise<CallbackOutcome>;
  readonly close: () => Promise<void>;
}

function boundedClose(server: Server): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, CALLBACK_FORCE_CLOSE_MS);
      force.unref();
      server.close(() => {
        clearTimeout(force);
        resolve();
      });
      server.closeIdleConnections();
    });
    return pending;
  };
}

function respond(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader("Connection", "close");
  res.shouldKeepAlive = false;
  res.end(html);
}

function callbackUrl(req: IncomingMessage): URL | null {
  if (req.method !== "GET" || req.url === undefined || !URL.canParse(req.url, "http://callback")) {
    return null;
  }
  const url = new URL(req.url, "http://callback");
  return url.pathname === INTERVALS_CALLBACK_PATH ? url : null;
}

function readCallback(url: URL, state: string): CallbackOutcome | null {
  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (returnedState === state && code !== null && code.length > 0) return { code };
  const error = url.searchParams.get("error");
  if (error === null || (returnedState !== null && returnedState !== state)) return null;
  return { refused: error === "access_denied" ? "access-denied" : "authorization-failed" };
}

function startCallbackServer(state: string): Promise<CallbackServer> {
  let settle: (outcome: CallbackOutcome) => void = () => undefined;
  const outcome = new Promise<CallbackOutcome>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const server = createServer((req, res) => {
    const url = callbackUrl(req);
    if (url === null) {
      respond(res, 404, INACTIVE_PAGE);
      return;
    }
    const received = settled ? null : readCallback(url, state);
    if (received === null) {
      respond(res, 400, INACTIVE_PAGE);
      return;
    }
    settled = true;
    if ("code" in received) respond(res, 200, RECEIVED_PAGE);
    else respond(res, 200, received.refused === "access-denied" ? DENIED_PAGE : FAILED_PAGE);
    settle(received);
  });
  const close = boundedClose(server);
  return new Promise<CallbackServer>((resolve, reject) => {
    server.once("error", () => reject(new IntervalsSignInError("callback-unavailable")));
    server.listen(0, CALLBACK_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new IntervalsSignInError("callback-unavailable"));
        void close();
        return;
      }
      resolve({ port: address.port, outcome, close });
    });
  });
}

function createPkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildIntervalsAuthorizeUrl(input: {
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(INTERVALS_AUTHORIZE_URL);
  url.searchParams.set("client_id", INTERVALS_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", INTERVALS_OAUTH_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function athleteIdOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return nonEmptyString(value) ? value : null;
}

function parseGrant(body: unknown): IntervalsOAuthGrant | null {
  if (!isRecord(body) || !nonEmptyString(body.access_token) || !isRecord(body.athlete)) return null;
  if (body.access_token.trim() !== body.access_token) return null;
  if (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer") {
    return null;
  }
  const athleteId = athleteIdOf(body.athlete.id);
  if (athleteId === null) return null;
  return {
    credential: encodeIntervalsOAuthCredential(body.access_token),
    scope: typeof body.scope === "string" ? body.scope : "",
    athleteId,
    athleteName: typeof body.athlete.name === "string" ? body.athlete.name : "",
  };
}

export async function exchangeIntervalsCode(input: {
  readonly code: string;
  readonly verifier: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<IntervalsOAuthGrant> {
  const doFetch = input.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(positiveTimeout(input.timeoutMs, TOKEN_EXCHANGE_TIMEOUT_MS));
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  let response: Response;
  try {
    response = await doFetch(INTERVALS_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: INTERVALS_OAUTH_CLIENT_ID,
        code: input.code,
        code_verifier: input.verifier,
      }).toString(),
      signal,
    });
  } catch {
    throw new IntervalsSignInError(input.signal?.aborted === true ? "cancelled" : "unreachable");
  }
  if (!response.ok) {
    throw new IntervalsSignInError(response.status >= 500 ? "unreachable" : "exchange-failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new IntervalsSignInError("exchange-failed");
  }
  const grant = parseGrant(body);
  if (grant === null) throw new IntervalsSignInError("exchange-failed");
  return grant;
}

export type IntervalsRevokeResult = "revoked" | "already-invalid" | "not-signed-in" | "failed";

export async function revokeIntervalsAccess(input: {
  readonly credential: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): Promise<IntervalsRevokeResult> {
  const timeoutMs = positiveTimeout(input.timeoutMs, REVOKE_TIMEOUT_MS);
  const credential = decodeIntervalsCredential(input.credential);
  if (credential.kind !== "oauth") return "not-signed-in";
  const doFetch = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(INTERVALS_DISCONNECT_URL, {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "failed";
  }
  if (response.ok) return "revoked";
  return response.status === 401 || response.status === 403 ? "already-invalid" : "failed";
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_MS) {
    throw new TypeError("invalid timeout");
  }
  return resolved;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type CallbackWait =
  | { readonly outcome: CallbackOutcome }
  | { readonly stopped: "timed-out" | "cancelled" };

type BrowserLaunch = "opened" | "failed";

function waitForCallback(
  outcome: Promise<CallbackOutcome>,
  limits: { readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<CallbackWait> {
  return new Promise<CallbackWait>((resolve) => {
    const finish = (result: CallbackWait) => {
      clearTimeout(timer);
      limits.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ stopped: "timed-out" }), limits.timeoutMs);
    const onAbort = () => finish({ stopped: "cancelled" });
    if (limits.signal.aborted) {
      finish({ stopped: "cancelled" });
      return;
    }
    limits.signal.addEventListener("abort", onAbort, { once: true });
    void outcome.then((value) => finish({ outcome: value }));
  });
}

function launchBrowser(options: IntervalsSignInOptions, url: string): Promise<BrowserLaunch> {
  return Promise.resolve()
    .then(() => options.openExternal(url))
    .then(
      (): BrowserLaunch => "opened",
      (): BrowserLaunch => "failed",
    );
}

async function awaitCallback(
  waiting: Promise<CallbackWait>,
  launch: Promise<BrowserLaunch>,
  options: IntervalsSignInOptions,
): Promise<CallbackOutcome> {
  const first = await Promise.race([waiting, launch]);
  if (first === "failed") options.onBrowserOpenFailed?.();
  const result = first === "opened" || first === "failed" ? await waiting : first;
  if ("stopped" in result) throw new IntervalsSignInError(result.stopped);
  return result.outcome;
}

export async function signInWithIntervals(
  options: IntervalsSignInOptions,
): Promise<IntervalsOAuthGrant> {
  const authorizationTimeoutMs = positiveTimeout(
    options.authorizationTimeoutMs,
    AUTHORIZATION_TIMEOUT_MS,
  );
  const tokenExchangeTimeoutMs = positiveTimeout(
    options.tokenExchangeTimeoutMs,
    TOKEN_EXCHANGE_TIMEOUT_MS,
  );
  if (isAborted(options.signal)) throw new IntervalsSignInError("cancelled");
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("hex");
  const callback = await startCallbackServer(state);
  const stopWaiting = new AbortController();
  try {
    if (isAborted(options.signal)) throw new IntervalsSignInError("cancelled");
    const url = buildIntervalsAuthorizeUrl({
      redirectUri: `http://${CALLBACK_HOST}:${callback.port}${INTERVALS_CALLBACK_PATH}`,
      state,
      challenge,
    });
    options.onAuthorizeUrl?.(url);
    options.onPhase?.("waiting-for-browser");
    const waiting = waitForCallback(callback.outcome, {
      timeoutMs: authorizationTimeoutMs,
      signal:
        options.signal === undefined
          ? stopWaiting.signal
          : AbortSignal.any([options.signal, stopWaiting.signal]),
    });
    const outcome = await awaitCallback(waiting, launchBrowser(options, url), options);
    if ("refused" in outcome) throw new IntervalsSignInError(outcome.refused);
    options.onPhase?.("completing-sign-in");
    return await exchangeIntervalsCode({
      code: outcome.code,
      verifier,
      timeoutMs: tokenExchangeTimeoutMs,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } finally {
    stopWaiting.abort();
    await callback.close();
  }
}
