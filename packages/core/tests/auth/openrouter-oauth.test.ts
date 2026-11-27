import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_KEY_EXCHANGE_URL,
  OPENROUTER_KEY_STATUS_URL,
  OpenRouterSignInError,
  buildOpenRouterAuthorizeUrl,
  parseOpenRouterCode,
  readOpenRouterCreditStatus,
  signInWithOpenRouter,
  startOpenRouterCodeSignIn,
  type OpenRouterSignInPhase,
} from "../../src/auth/openrouter-oauth.js";

const SYNTHETIC_KEY = `sk-or-v1-${"0".repeat(64)}`;
const CODE = "fixture-code-0001";

interface ExchangeCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function exchangeFetch(response: () => Response | Promise<Response>): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: ExchangeCall[];
} {
  const calls: ExchangeCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return response();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

type FlowResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly error: OpenRouterSignInError };

async function startSignIn(
  overrides: Partial<Parameters<typeof signInWithOpenRouter>[0]> = {},
): Promise<{
  readonly authorizeUrl: URL;
  readonly callback: URL;
  readonly reachable: URL;
  readonly state: string;
  readonly result: Promise<FlowResult>;
  readonly phases: OpenRouterSignInPhase[];
}> {
  const phases: OpenRouterSignInPhase[] = [];
  let opened: (url: string) => void = () => {};
  const openedUrl = new Promise<string>((resolve) => {
    opened = resolve;
  });
  const result = signInWithOpenRouter({
    openExternal: async (url) => opened(url),
    onPhase: (phase) => phases.push(phase),
    ...overrides,
  }).then(
    (key): FlowResult => ({ ok: true, key }),
    (error: OpenRouterSignInError): FlowResult => ({ ok: false, error }),
  );
  const authorizeUrl = new URL(await openedUrl);
  const callback = new URL(authorizeUrl.searchParams.get("callback_url") ?? "");
  const reachable = new URL(callback);
  reachable.hostname = "127.0.0.1";
  return {
    authorizeUrl,
    callback,
    reachable,
    state: authorizeUrl.searchParams.get("state") ?? "",
    result,
    phases,
  };
}

function withParams(base: URL, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

describe("buildOpenRouterAuthorizeUrl", () => {
  it("asks for an S256 key labelled Enduragent with the loopback callback and state", () => {
    const url = new URL(
      buildOpenRouterAuthorizeUrl({
        callbackUrl: "http://localhost:5000/openrouter/callback",
        state: "state-1",
        challenge: "challenge-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      callback_url: "http://localhost:5000/openrouter/callback",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      key_label: "Enduragent",
      state: "state-1",
    });
  });
});

describe("signInWithOpenRouter", () => {
  it("exchanges the callback code with the S256 verifier and returns the key", async () => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: SYNTHETIC_KEY, user_id: "u" }));
    const flow = await startSignIn({ fetch: exchange.fetch });
    expect(flow.callback.protocol).toBe("http:");
    expect(flow.callback.hostname).toBe("localhost");
    expect(flow.callback.pathname).toBe("/openrouter/callback");
    expect(Number(flow.callback.port)).toBeGreaterThan(0);
    expect(flow.authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.state).toMatch(/^[0-9a-f]{32}$/u);

    const page = await fetch(withParams(flow.reachable, { code: CODE, state: flow.state }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("finishes connecting OpenRouter");

    expect(await flow.result).toEqual({ ok: true, key: SYNTHETIC_KEY });
    expect(flow.phases).toEqual(["waiting-for-browser", "completing-sign-in"]);
    expect(exchange.calls).toHaveLength(1);
    const call = exchange.calls[0];
    expect(call?.url).toBe(OPENROUTER_KEY_EXCHANGE_URL);
    expect(call?.method).toBe("POST");
    expect(Object.keys(call?.body ?? {}).sort()).toEqual([
      "code",
      "code_challenge_method",
      "code_verifier",
    ]);
    expect(call?.body.code).toBe(CODE);
    expect(call?.body.code_challenge_method).toBe("S256");
    const verifier = String(call?.body.code_verifier);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/u);
    expect(challengeOf(verifier)).toBe(flow.authorizeUrl.searchParams.get("code_challenge"));
    await expect(fetch(flow.reachable.toString())).rejects.toThrow();
  });

  it("ignores a callback with another state and keeps waiting", async () => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: SYNTHETIC_KEY }));
    const flow = await startSignIn({ fetch: exchange.fetch });
    const stale = await fetch(withParams(flow.reachable, { code: "other", state: "other" }));
    expect(stale.status).toBe(400);
    const unsigned = await fetch(withParams(flow.reachable, { code: CODE }));
    expect(unsigned.status).toBe(400);
    expect(exchange.calls).toHaveLength(0);
    await fetch(withParams(flow.reachable, { code: CODE, state: flow.state }));
    expect(await flow.result).toMatchObject({ ok: true });
  });

  it("answers other paths and methods with 404 and keeps waiting", async () => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: SYNTHETIC_KEY }));
    const flow = await startSignIn({ fetch: exchange.fetch });
    expect((await fetch(new URL("/intervals/callback", flow.reachable))).status).toBe(404);
    expect((await fetch(flow.reachable, { method: "POST" })).status).toBe(404);
    await fetch(withParams(flow.reachable, { code: CODE, state: flow.state }));
    expect(await flow.result).toMatchObject({ ok: true });
  });

  it.each([
    ["an error parameter", { error: "access_denied" }],
    ["no code", {}],
  ])("reports a callback with %s as access denied", async (_label, params) => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: SYNTHETIC_KEY }));
    const flow = await startSignIn({ fetch: exchange.fetch });
    const page = await fetch(withParams(flow.reachable, params));
    expect(await page.text()).toContain("Access wasn’t allowed");
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe("access-denied");
    expect(exchange.calls).toHaveLength(0);
  });

  it("times out when the browser never comes back", async () => {
    const flow = await startSignIn({ authorizationTimeoutMs: 30 });
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe("timed-out");
  });

  it("stops when cancelled while waiting", async () => {
    const controller = new AbortController();
    const flow = await startSignIn({ signal: controller.signal });
    controller.abort();
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe("cancelled");
  });

  it.each([
    [400, "exchange-failed"],
    [403, "exchange-failed"],
    [500, "exchange-failed"],
  ] as const)("treats an HTTP %i exchange as %s", async (status, reason) => {
    const exchange = exchangeFetch(() => jsonResponse(status, { error: { message: "x" } }));
    const flow = await startSignIn({ fetch: exchange.fetch });
    await fetch(withParams(flow.reachable, { code: CODE, state: flow.state }));
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe(reason);
  });

  it("refuses a 200 exchange without a key", async () => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: "", user_id: "u" }));
    const flow = await startSignIn({ fetch: exchange.fetch });
    await fetch(withParams(flow.reachable, { code: CODE, state: flow.state }));
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe("exchange-failed");
  });

  it("maps a network failure on the exchange to unreachable", async () => {
    const fetchFailure = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const flow = await startSignIn({ fetch: fetchFailure });
    await fetch(withParams(flow.reachable, { code: CODE, state: flow.state }));
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe("unreachable");
  });

  it("rejects invalid timeouts before opening anything", async () => {
    const openExternal = vi.fn(async () => undefined);
    await expect(signInWithOpenRouter({ openExternal, tokenExchangeTimeoutMs: 0 })).rejects.toThrow(
      "invalid timeout",
    );
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("startOpenRouterCodeSignIn", () => {
  it("builds a headless authorize URL with no callback and exchanges a bare code", async () => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: SYNTHETIC_KEY }));
    const attempt = startOpenRouterCodeSignIn({ fetch: exchange.fetch });
    const url = new URL(attempt.authorizeUrl);
    expect(url.searchParams.has("callback_url")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("key_label")).toBe("Enduragent");
    expect(await attempt.exchange(`  ${CODE}\n`)).toBe(SYNTHETIC_KEY);
    const verifier = String(exchange.calls[0]?.body.code_verifier);
    expect(challengeOf(verifier)).toBe(url.searchParams.get("code_challenge"));
    expect(exchange.calls[0]?.body.code).toBe(CODE);
  });

  it("reads the code out of a pasted callback URL", async () => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: SYNTHETIC_KEY }));
    const attempt = startOpenRouterCodeSignIn({ fetch: exchange.fetch });
    await attempt.exchange(`https://openrouter.ai/somewhere?code=${CODE}`);
    expect(exchange.calls[0]?.body.code).toBe(CODE);
  });

  it.each([400, 403])("reports an HTTP %i exchange as a rejected code", async (status) => {
    const exchange = exchangeFetch(() => jsonResponse(status, { error: { message: "x" } }));
    const attempt = startOpenRouterCodeSignIn({ fetch: exchange.fetch });
    await expect(attempt.exchange(CODE)).rejects.toMatchObject({ reason: "code-rejected" });
  });

  it("reports a server error and a network failure separately from a rejected code", async () => {
    const serverError = exchangeFetch(() => jsonResponse(502, {}));
    await expect(
      startOpenRouterCodeSignIn({ fetch: serverError.fetch }).exchange(CODE),
    ).rejects.toMatchObject({ reason: "exchange-failed" });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      startOpenRouterCodeSignIn({ fetch: offline }).exchange(CODE),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("does not call OpenRouter for text that holds no code", async () => {
    const exchange = exchangeFetch(() => jsonResponse(200, { key: SYNTHETIC_KEY }));
    const attempt = startOpenRouterCodeSignIn({ fetch: exchange.fetch });
    await expect(attempt.exchange("not a code")).rejects.toBeInstanceOf(OpenRouterSignInError);
    await expect(
      attempt.exchange(`https://intervals.icu/oauth/callback?code=${CODE}`),
    ).rejects.toBeInstanceOf(OpenRouterSignInError);
    expect(exchange.calls).toHaveLength(0);
  });
});

describe("parseOpenRouterCode", () => {
  it.each([
    [CODE, CODE],
    [`  ${CODE}  `, CODE],
    [`http://localhost:4000/openrouter/callback?code=${CODE}&state=x`, CODE],
    [`http://127.0.0.1:4000/openrouter/callback?code=${CODE}`, CODE],
    [`https://openrouter.ai/auth/code?code=${CODE}`, CODE],
    [`https://intervals.icu/oauth/callback?code=${CODE}`, null],
    [`https://openrouter.ai.example.com/callback?code=${CODE}`, null],
    [`ftp://localhost/callback?code=${CODE}`, null],
    ["", null],
    ["two words here", null],
    ["short", null],
    [SYNTHETIC_KEY, null],
    ["https://openrouter.ai/settings/keys", null],
  ])("reads %j as %j", (text, expected) => {
    expect(parseOpenRouterCode(text)).toBe(expected);
  });
});

describe("readOpenRouterCreditStatus", () => {
  function statusFetch(response: () => Response | Promise<Response>) {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return response();
    }) as typeof globalThis.fetch;
    return { fetch, seen };
  }

  it.each([
    [true, "never-paid"],
    [false, "paid"],
    ["yes", "unknown"],
  ] as const)("reads is_free_tier %j as %s", async (freeTier, expected) => {
    const status = statusFetch(() => jsonResponse(200, { data: { is_free_tier: freeTier } }));
    expect(await readOpenRouterCreditStatus({ key: SYNTHETIC_KEY, fetch: status.fetch })).toBe(
      expected,
    );
    expect(status.seen).toEqual([
      { url: OPENROUTER_KEY_STATUS_URL, authorization: `Bearer ${SYNTHETIC_KEY}` },
    ]);
  });

  it("reads an error response, a network failure and a timeout as unknown", async () => {
    const rejected = statusFetch(() => jsonResponse(401, { error: { message: "x" } }));
    expect(await readOpenRouterCreditStatus({ key: SYNTHETIC_KEY, fetch: rejected.fetch })).toBe(
      "unknown",
    );
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    expect(await readOpenRouterCreditStatus({ key: SYNTHETIC_KEY, fetch: offline })).toBe(
      "unknown",
    );
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof globalThis.fetch;
    expect(
      await readOpenRouterCreditStatus({ key: SYNTHETIC_KEY, fetch: hanging, timeoutMs: 20 }),
    ).toBe("unknown");
  });
});
