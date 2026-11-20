import { createHash } from "node:crypto";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  buildIntervalsAuthorizeUrl,
  exchangeIntervalsCode,
  INTERVALS_DISCONNECT_URL,
  INTERVALS_OAUTH_CLIENT_ID,
  INTERVALS_OAUTH_SCOPE,
  INTERVALS_TOKEN_URL,
  IntervalsSignInError,
  revokeIntervalsAccess,
  signInWithIntervals,
  type IntervalsSignInPhase,
} from "../../src/auth/intervals-oauth.js";
import {
  encodeIntervalsOAuthCredential,
  intervalsCredentialKind,
} from "../../src/intervals-credential.js";

const GRANT_BODY = {
  token_type: "Bearer",
  access_token: "fixture-access-token",
  scope: INTERVALS_OAUTH_SCOPE,
  athlete: { id: "fixture-athlete", name: "Ada Kovac" },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface TokenCall {
  readonly url: string;
  readonly body: URLSearchParams;
}

function tokenFetch(response: () => Response | Promise<Response>): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: TokenCall[];
} {
  const calls: TokenCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
    return response();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

type FlowResult =
  | { readonly ok: true; readonly grant: unknown }
  | { readonly ok: false; readonly error: IntervalsSignInError };

async function startSignIn(
  overrides: Partial<Parameters<typeof signInWithIntervals>[0]> = {},
): Promise<{
  readonly authorizeUrl: URL;
  readonly redirect: URL;
  readonly state: string;
  readonly result: Promise<FlowResult>;
  readonly phases: IntervalsSignInPhase[];
}> {
  const phases: IntervalsSignInPhase[] = [];
  let opened: (url: string) => void = () => {};
  const openedUrl = new Promise<string>((resolve) => {
    opened = resolve;
  });
  const result = signInWithIntervals({
    openExternal: async (url) => opened(url),
    onPhase: (phase) => phases.push(phase),
    ...overrides,
  }).then(
    (grant): FlowResult => ({ ok: true, grant }),
    (error: IntervalsSignInError): FlowResult => ({ ok: false, error }),
  );
  const authorizeUrl = new URL(await openedUrl);
  return {
    authorizeUrl,
    redirect: new URL(authorizeUrl.searchParams.get("redirect_uri") ?? ""),
    state: authorizeUrl.searchParams.get("state") ?? "",
    result,
    phases,
  };
}

function withParams(redirect: URL, params: Record<string, string>): string {
  const url = new URL(redirect);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function rawRequest(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

describe("buildIntervalsAuthorizeUrl", () => {
  it("requests the app's client, scopes, state and an S256 challenge", () => {
    const url = new URL(
      buildIntervalsAuthorizeUrl({
        redirectUri: "http://127.0.0.1:5000/intervals/callback",
        state: "state-1",
        challenge: "challenge-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://intervals.icu/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: INTERVALS_OAUTH_CLIENT_ID,
      redirect_uri: "http://127.0.0.1:5000/intervals/callback",
      scope: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:WRITE,SETTINGS:READ",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });
});

describe("signInWithIntervals", () => {
  it("exchanges the callback code with the PKCE verifier and no client secret", async () => {
    const token = tokenFetch(() => jsonResponse(200, GRANT_BODY));
    const flow = await startSignIn({ fetch: token.fetch });
    expect(flow.redirect.hostname).toBe("127.0.0.1");
    expect(flow.redirect.pathname).toBe("/intervals/callback");
    expect(Number(flow.redirect.port)).toBeGreaterThan(0);

    const page = await fetch(
      withParams(flow.redirect, { code: "fixture-code", state: flow.state }),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain("Return to Enduragent while it finishes");

    const result = await flow.result;
    expect(result).toEqual({
      ok: true,
      grant: {
        credential: encodeIntervalsOAuthCredential("fixture-access-token"),
        scope: INTERVALS_OAUTH_SCOPE,
        athleteId: "fixture-athlete",
        athleteName: "Ada Kovac",
      },
    });
    expect(flow.phases).toEqual(["waiting-for-browser", "completing-sign-in"]);
    expect(token.calls).toHaveLength(1);
    const call = token.calls[0];
    expect(call?.url).toBe(INTERVALS_TOKEN_URL);
    expect(call?.body.get("client_id")).toBe(INTERVALS_OAUTH_CLIENT_ID);
    expect(call?.body.get("code")).toBe("fixture-code");
    expect(call?.body.has("client_secret")).toBe(false);
    const verifier = call?.body.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challengeOf(verifier)).toBe(flow.authorizeUrl.searchParams.get("code_challenge"));
    await expect(fetch(flow.redirect.toString())).rejects.toThrow();
  });

  it("ignores a callback with the wrong state and keeps waiting", async () => {
    const token = tokenFetch(() => jsonResponse(200, GRANT_BODY));
    const flow = await startSignIn({ fetch: token.fetch });
    const stale = await fetch(withParams(flow.redirect, { code: "x", state: "other" }));
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("This sign-in isn’t active");
    const deniedElsewhere = await fetch(
      withParams(flow.redirect, { error: "access_denied", state: "other" }),
    );
    expect(deniedElsewhere.status).toBe(400);
    expect(token.calls).toHaveLength(0);

    await fetch(withParams(flow.redirect, { code: "fixture-code", state: flow.state }));
    expect(await flow.result).toMatchObject({ ok: true });
  });

  it("answers other paths and methods with 404 and keeps waiting", async () => {
    const token = tokenFetch(() => jsonResponse(200, GRANT_BODY));
    const flow = await startSignIn({ fetch: token.fetch });
    expect((await fetch(new URL("/other", flow.redirect))).status).toBe(404);
    expect((await fetch(flow.redirect, { method: "POST" })).status).toBe(404);
    await fetch(withParams(flow.redirect, { code: "fixture-code", state: flow.state }));
    expect(await flow.result).toMatchObject({ ok: true });
  });

  it("answers a malformed request with 400 instead of crashing", async () => {
    const token = tokenFetch(() => jsonResponse(200, GRANT_BODY));
    const flow = await startSignIn({ fetch: token.fetch });
    const response = await rawRequest(Number(flow.redirect.port), "GET http://[ HTTP/1.1");
    expect(response).toMatch(/^HTTP\/1\.1 4\d\d/);
    await fetch(withParams(flow.redirect, { code: "fixture-code", state: flow.state }));
    expect(await flow.result).toMatchObject({ ok: true });
  });

  it("refuses a second callback after the first one settles", async () => {
    let releaseExchange: () => void = () => {};
    const exchangeHeld = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const token = tokenFetch(async () => {
      await exchangeHeld;
      return jsonResponse(200, GRANT_BODY);
    });
    const flow = await startSignIn({ fetch: token.fetch });
    await fetch(withParams(flow.redirect, { code: "first", state: flow.state }));
    const second = await fetch(withParams(flow.redirect, { code: "second", state: flow.state }));
    expect(second.status).toBe(400);
    releaseExchange();
    expect(await flow.result).toMatchObject({ ok: true });
    expect(token.calls.map((call) => call.body.get("code"))).toEqual(["first"]);
  });

  it.each([
    ["with the state", true],
    ["without a state", false],
  ])("reports a denied consent %s without exchanging", async (_label, withState) => {
    const token = tokenFetch(() => jsonResponse(200, GRANT_BODY));
    const flow = await startSignIn({ fetch: token.fetch });
    const page = await fetch(
      withParams(flow.redirect, {
        error: "access_denied",
        ...(withState ? { state: flow.state } : {}),
      }),
    );
    expect(await page.text()).toContain("Access wasn’t allowed");
    const result = await flow.result;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.reason).toBe("access-denied");
    expect(token.calls).toHaveLength(0);
  });

  it("reports another authorization error separately from a denial", async () => {
    const token = tokenFetch(() => jsonResponse(200, GRANT_BODY));
    const flow = await startSignIn({ fetch: token.fetch });
    const page = await fetch(
      withParams(flow.redirect, { error: "server_error", state: flow.state }),
    );
    expect(await page.text()).toContain("couldn’t finish the sign-in");
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe("authorization-failed");
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

  it("stops when cancelled during the code exchange", async () => {
    const controller = new AbortController();
    const fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof globalThis.fetch;
    const flow = await startSignIn({ fetch, signal: controller.signal });
    await globalThis.fetch(withParams(flow.redirect, { code: "fixture-code", state: flow.state }));
    await vi.waitFor(() => expect(flow.phases).toContain("completing-sign-in"));
    controller.abort();
    const result = await flow.result;
    expect(!result.ok && result.error.reason).toBe("cancelled");
  });

  it("can be cancelled while the browser is still opening", async () => {
    const controller = new AbortController();
    const flow = signInWithIntervals({
      openExternal: () => new Promise<void>(() => {}),
      signal: controller.signal,
    }).catch((error: IntervalsSignInError) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(((await flow) as IntervalsSignInError).reason).toBe("cancelled");
  });

  it("keeps waiting when the browser fails to open", async () => {
    const urls: string[] = [];
    let openFailures = 0;
    const flow = signInWithIntervals({
      openExternal: async () => {
        throw new Error("no browser");
      },
      onAuthorizeUrl: (url) => urls.push(url),
      onBrowserOpenFailed: () => {
        openFailures += 1;
      },
      authorizationTimeoutMs: 30,
    }).catch((error: IntervalsSignInError) => error);
    const error = (await flow) as IntervalsSignInError;
    expect(urls).toHaveLength(1);
    expect(openFailures).toBe(1);
    expect(error.reason).toBe("timed-out");
  });

  it("rejects with a progress callback's error and leaves nothing pending", async () => {
    const openExternal = vi.fn(async () => undefined);
    await expect(
      signInWithIntervals({
        openExternal,
        onPhase: () => {
          throw new Error("window closed");
        },
        authorizationTimeoutMs: 20,
      }),
    ).rejects.toThrow("window closed");
    expect(openExternal).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it("treats a browser that throws synchronously as not opened", async () => {
    let openFailures = 0;
    const error = await signInWithIntervals({
      openExternal: () => {
        throw new Error("no browser");
      },
      onBrowserOpenFailed: () => {
        openFailures += 1;
      },
      authorizationTimeoutMs: 20,
    }).catch((caught: IntervalsSignInError) => caught);
    expect(openFailures).toBe(1);
    expect((error as IntervalsSignInError).reason).toBe("timed-out");
  });

  it("rejects with the open-failure callback's error and leaves nothing pending", async () => {
    await expect(
      signInWithIntervals({
        openExternal: async () => {
          throw new Error("no browser");
        },
        onBrowserOpenFailed: () => {
          throw new Error("window closed");
        },
        authorizationTimeoutMs: 20,
      }),
    ).rejects.toThrow("window closed");
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it("does not open the browser when cancelled before the listener is ready", async () => {
    const controller = new AbortController();
    const openExternal = vi.fn(async () => undefined);
    const flow = signInWithIntervals({ openExternal, signal: controller.signal });
    controller.abort();
    await expect(flow).rejects.toMatchObject({ reason: "cancelled" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("rejects invalid timeouts before opening anything", async () => {
    const openExternal = vi.fn(async () => undefined);
    await expect(signInWithIntervals({ openExternal, tokenExchangeTimeoutMs: -1 })).rejects.toThrow(
      "invalid timeout",
    );
    await expect(
      signInWithIntervals({ openExternal, authorizationTimeoutMs: 2 ** 31 }),
    ).rejects.toThrow("invalid timeout");
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("exchangeIntervalsCode", () => {
  it.each([
    [400, "exchange-failed"],
    [401, "exchange-failed"],
    [503, "unreachable"],
  ] as const)("maps HTTP %i to %s", async (status, reason) => {
    const token = tokenFetch(() => jsonResponse(status, { error: "x" }));
    await expect(
      exchangeIntervalsCode({ code: "c", verifier: "v", fetch: token.fetch }),
    ).rejects.toMatchObject({ reason });
  });

  it("rejects a response without a bearer token and athlete", async () => {
    const token = tokenFetch(() => jsonResponse(200, { access_token: "t" }));
    await expect(
      exchangeIntervalsCode({ code: "c", verifier: "v", fetch: token.fetch }),
    ).rejects.toMatchObject({ reason: "exchange-failed" });
  });

  it("returns the token only as a stored OAuth credential", async () => {
    const token = tokenFetch(() =>
      jsonResponse(200, { ...GRANT_BODY, athlete: { id: 101, name: "A" } }),
    );
    const grant = await exchangeIntervalsCode({ code: "c", verifier: "v", fetch: token.fetch });
    expect(grant.athleteId).toBe("101");
    expect(intervalsCredentialKind(grant.credential)).toBe("oauth");
    expect(grant).not.toHaveProperty("accessToken");
  });

  it("maps a network failure to unreachable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(exchangeIntervalsCode({ code: "c", verifier: "v", fetch })).rejects.toMatchObject({
      reason: "unreachable",
    });
  });
});

describe("revokeIntervalsAccess", () => {
  const credential = encodeIntervalsOAuthCredential("tok");

  it("sends DELETE with the bearer token", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;
    expect(await revokeIntervalsAccess({ credential, fetch })).toBe("revoked");
    expect(seen[0]?.url).toBe(INTERVALS_DISCONNECT_URL);
    expect(seen[0]?.init?.method).toBe("DELETE");
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("does not call intervals.icu for an API key", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    expect(await revokeIntervalsAccess({ credential: "plain-key", fetch })).toBe("not-signed-in");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "already-invalid"],
    [403, "already-invalid"],
    [500, "failed"],
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    const fetch = (async () => new Response(null, { status })) as typeof globalThis.fetch;
    expect(await revokeIntervalsAccess({ credential, fetch })).toBe(expected);
  });

  it("never throws on a network failure", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    expect(await revokeIntervalsAccess({ credential, fetch })).toBe("failed");
  });

  it("rejects an invalid timeout instead of reporting a failed revoke", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(revokeIntervalsAccess({ credential, fetch, timeoutMs: 0 })).rejects.toThrow(
      "invalid timeout",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
