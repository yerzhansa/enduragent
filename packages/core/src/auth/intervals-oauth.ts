import {
  decodeIntervalsCredential,
  encodeIntervalsOAuthCredential,
} from "../intervals-credential.js";
import {
  LOOPBACK_INACTIVE_PAGE,
  LOOPBACK_LISTEN_HOST,
  loopbackResultPage,
  positiveTimeout,
  runLoopbackSignIn,
  timeoutSignal,
  type LoopbackCallbackOutcome,
  type LoopbackSignInHooks,
  type LoopbackSignInPhase,
} from "./loopback-sign-in.js";

export const INTERVALS_OAUTH_CLIENT_ID = "1928";
export const INTERVALS_AUTHORIZE_URL = "https://intervals.icu/oauth/authorize";
export const INTERVALS_TOKEN_URL = "https://intervals.icu/api/oauth/token";
export const INTERVALS_DISCONNECT_URL = "https://intervals.icu/api/v1/disconnect-app";
export const INTERVALS_OAUTH_SCOPE = "ACTIVITY:READ,WELLNESS:READ,CALENDAR:WRITE,SETTINGS:READ";
export const INTERVALS_CALLBACK_PATH = "/intervals/callback";

const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;
const REVOKE_TIMEOUT_MS = 10_000;

export interface IntervalsOAuthGrant {
  readonly credential: string;
  readonly scope: string;
  readonly athleteId: string;
  readonly athleteName: string;
}

export type IntervalsSignInPhase = LoopbackSignInPhase;

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

export interface IntervalsSignInOptions extends LoopbackSignInHooks {
  readonly fetch?: typeof globalThis.fetch;
  readonly authorizationTimeoutMs?: number;
  readonly tokenExchangeTimeoutMs?: number;
}

const RECEIVED_PAGE = loopbackResultPage(
  "Almost done",
  "Return to Enduragent while it finishes connecting Intervals.icu. You can close this tab.",
);
const DENIED_PAGE = loopbackResultPage(
  "Access wasn’t allowed",
  "Nothing was saved. Return to Enduragent to sign in again.",
);
const FAILED_PAGE = loopbackResultPage(
  "Intervals.icu couldn’t finish the sign-in",
  "Nothing was saved. Return to Enduragent to try again.",
);

type IntervalsCallbackRefusal = "access-denied" | "authorization-failed";

function readCallback(
  url: URL,
  state: string,
): LoopbackCallbackOutcome<IntervalsCallbackRefusal> | null {
  const returnedState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (returnedState === state && code !== null && code.length > 0) return { code };
  const error = url.searchParams.get("error");
  if (error === null || (returnedState !== null && returnedState !== state)) return null;
  return { refused: error === "access_denied" ? "access-denied" : "authorization-failed" };
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
  const signal = timeoutSignal(
    positiveTimeout(input.timeoutMs, TOKEN_EXCHANGE_TIMEOUT_MS),
    input.signal,
  );
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
  return runLoopbackSignIn({
    hooks: options,
    authorizationTimeoutMs,
    redirectHost: LOOPBACK_LISTEN_HOST,
    callbackPath: INTERVALS_CALLBACK_PATH,
    readCallback,
    pages: {
      received: RECEIVED_PAGE,
      inactive: LOOPBACK_INACTIVE_PAGE,
      refused: { "access-denied": DENIED_PAGE, "authorization-failed": FAILED_PAGE },
    },
    authorizeUrl: buildIntervalsAuthorizeUrl,
    exchange: (code, verifier) =>
      exchangeIntervalsCode({
        code,
        verifier,
        timeoutMs: tokenExchangeTimeoutMs,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    fail: (reason) => new IntervalsSignInError(reason),
  });
}
