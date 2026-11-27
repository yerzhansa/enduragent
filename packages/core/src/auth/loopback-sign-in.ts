import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const LOOPBACK_LISTEN_HOST = "127.0.0.1";
const CALLBACK_FORCE_CLOSE_MS = 500;
const MAX_TIMER_MS = 2 ** 31 - 1;

export type LoopbackSignInPhase = "waiting-for-browser" | "completing-sign-in";

export type LoopbackSignInStop = "timed-out" | "cancelled" | "callback-unavailable";

export type LoopbackCallbackOutcome<Refusal extends string> =
  | { readonly code: string }
  | { readonly refused: Refusal };

export interface LoopbackCallbackPages<Refusal extends string> {
  readonly received: string;
  readonly inactive: string;
  readonly refused: Readonly<Record<Refusal, string>>;
}

export interface LoopbackSignInHooks {
  readonly openExternal: (url: string) => Promise<void>;
  readonly onAuthorizeUrl?: (url: string) => void;
  readonly onBrowserOpenFailed?: () => void;
  readonly onPhase?: (phase: LoopbackSignInPhase) => void;
  readonly signal?: AbortSignal;
}

export interface LoopbackSignInFlow<Refusal extends string, Result> {
  readonly hooks: LoopbackSignInHooks;
  readonly authorizationTimeoutMs: number;
  readonly redirectHost: string;
  readonly callbackPath: string;
  readonly readCallback: (url: URL, state: string) => LoopbackCallbackOutcome<Refusal> | null;
  readonly pages: LoopbackCallbackPages<Refusal>;
  readonly authorizeUrl: (input: {
    readonly redirectUri: string;
    readonly state: string;
    readonly challenge: string;
  }) => string;
  readonly exchange: (code: string, verifier: string) => Promise<Result>;
  readonly fail: (reason: Refusal | LoopbackSignInStop) => Error;
}

export function loopbackResultPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;background:#f2f5f8;color:#16202b;font-family:-apple-system,system-ui,sans-serif"><main style="max-width:440px;margin:18vh auto 0;padding:32px 28px;background:#fff;border:1px solid #dfe5eb;border-radius:12px"><div style="font-size:12px;font-weight:600;letter-spacing:.06em;color:#57636e">ENDURAGENT</div><h1 style="margin:12px 0 0;font-size:20px;line-height:28px">${title}</h1><p style="margin:12px 0 0;font-size:14px;line-height:20px;color:#57636e">${body}</p></main></body></html>`;
}

export const LOOPBACK_INACTIVE_PAGE = loopbackResultPage(
  "This sign-in isn’t active",
  "Start the sign-in again from Enduragent. You can close this tab.",
);

export function createPkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function createSignInState(): string {
  return randomBytes(16).toString("hex");
}

export function positiveTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_TIMER_MS) {
    throw new TypeError("invalid timeout");
  }
  return resolved;
}

export function timeoutSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

interface CallbackServer<Refusal extends string> {
  readonly port: number;
  readonly outcome: Promise<LoopbackCallbackOutcome<Refusal>>;
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

function callbackUrl(req: IncomingMessage, path: string): URL | null {
  if (req.method !== "GET" || req.url === undefined || !URL.canParse(req.url, "http://callback")) {
    return null;
  }
  const url = new URL(req.url, "http://callback");
  return url.pathname === path ? url : null;
}

function startCallbackServer<Refusal extends string, Result>(
  flow: LoopbackSignInFlow<Refusal, Result>,
  state: string,
): Promise<CallbackServer<Refusal>> {
  let settle: (outcome: LoopbackCallbackOutcome<Refusal>) => void = () => undefined;
  const outcome = new Promise<LoopbackCallbackOutcome<Refusal>>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const server = createServer((req, res) => {
    const url = callbackUrl(req, flow.callbackPath);
    if (url === null) {
      respond(res, 404, flow.pages.inactive);
      return;
    }
    const received = settled ? null : flow.readCallback(url, state);
    if (received === null) {
      respond(res, 400, flow.pages.inactive);
      return;
    }
    settled = true;
    respond(
      res,
      200,
      "code" in received ? flow.pages.received : flow.pages.refused[received.refused],
    );
    settle(received);
  });
  const close = boundedClose(server);
  return new Promise<CallbackServer<Refusal>>((resolve, reject) => {
    server.once("error", () => reject(flow.fail("callback-unavailable")));
    server.listen(0, LOOPBACK_LISTEN_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(flow.fail("callback-unavailable"));
        void close();
        return;
      }
      resolve({ port: address.port, outcome, close });
    });
  });
}

type CallbackWait<Refusal extends string> =
  | { readonly outcome: LoopbackCallbackOutcome<Refusal> }
  | { readonly stopped: "timed-out" | "cancelled" };

type BrowserLaunch = "opened" | "failed";

function waitForCallback<Refusal extends string>(
  outcome: Promise<LoopbackCallbackOutcome<Refusal>>,
  limits: { readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<CallbackWait<Refusal>> {
  return new Promise<CallbackWait<Refusal>>((resolve) => {
    const finish = (result: CallbackWait<Refusal>) => {
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

function launchBrowser(hooks: LoopbackSignInHooks, url: string): Promise<BrowserLaunch> {
  return Promise.resolve()
    .then(() => hooks.openExternal(url))
    .then(
      (): BrowserLaunch => "opened",
      (): BrowserLaunch => "failed",
    );
}

async function awaitCallback<Refusal extends string, Result>(
  flow: LoopbackSignInFlow<Refusal, Result>,
  waiting: Promise<CallbackWait<Refusal>>,
  launch: Promise<BrowserLaunch>,
): Promise<LoopbackCallbackOutcome<Refusal>> {
  const first = await Promise.race([waiting, launch]);
  if (first === "failed") flow.hooks.onBrowserOpenFailed?.();
  const result = first === "opened" || first === "failed" ? await waiting : first;
  if ("stopped" in result) throw flow.fail(result.stopped);
  return result.outcome;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runLoopbackSignIn<Refusal extends string, Result>(
  flow: LoopbackSignInFlow<Refusal, Result>,
): Promise<Result> {
  const hooks = flow.hooks;
  if (isAborted(hooks.signal)) throw flow.fail("cancelled");
  const { verifier, challenge } = createPkce();
  const state = createSignInState();
  const callback = await startCallbackServer(flow, state);
  const stopWaiting = new AbortController();
  try {
    if (isAborted(hooks.signal)) throw flow.fail("cancelled");
    const url = flow.authorizeUrl({
      redirectUri: `http://${flow.redirectHost}:${callback.port}${flow.callbackPath}`,
      state,
      challenge,
    });
    hooks.onAuthorizeUrl?.(url);
    hooks.onPhase?.("waiting-for-browser");
    const waiting = waitForCallback(callback.outcome, {
      timeoutMs: flow.authorizationTimeoutMs,
      signal:
        hooks.signal === undefined
          ? stopWaiting.signal
          : AbortSignal.any([hooks.signal, stopWaiting.signal]),
    });
    const outcome = await awaitCallback(flow, waiting, launchBrowser(hooks, url));
    if ("refused" in outcome) throw flow.fail(outcome.refused);
    hooks.onPhase?.("completing-sign-in");
    return await flow.exchange(outcome.code, verifier);
  } finally {
    stopWaiting.abort();
    await callback.close();
  }
}
