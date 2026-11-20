import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERVALS_CREDENTIAL_PROBE_COOLDOWN_MS,
  INTERVALS_CREDENTIAL_PROBE_URL,
  isIntervalsCredentialRejected,
  recordIntervalsCredentialResponse,
  resetIntervalsCredentialHealthForTests,
  trackIntervalsCredentialHealth,
} from "../src/intervals-credential-health.js";
import { encodeIntervalsOAuthCredential } from "../src/intervals-credential.js";
import {
  makeAbortableClient,
  makeChatClient,
  makeIntervalsHttpFactory,
  resetSharedRequestBucketForTests,
} from "../src/reference/sync/intervals-client-factory.js";

const SIGNED_IN = encodeIntervalsOAuthCredential("fixture-token-a");
const OTHER_SIGNED_IN = encodeIntervalsOAuthCredential("fixture-token-b");
const API_KEY = "fixture-api-key";
const OUT_OF_SCOPE_URL = "https://intervals.test/api/v1/athlete/0/workouts.zip";

function reply(status: number): Response {
  return new Response(status === 204 ? null : JSON.stringify({ id: "i1", name: "Fixture" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respondWith(status: number): typeof globalThis.fetch {
  return vi.fn(async () => reply(status)) as unknown as typeof globalThis.fetch;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function forbiddenWithProbe(probeStatus: number | "offline") {
  const probeAuthorizations: (string | null)[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (requestUrl(input) !== INTERVALS_CREDENTIAL_PROBE_URL) return reply(403);
    probeAuthorizations.push(new Headers(init?.headers).get("authorization"));
    if (probeStatus === "offline") throw new TypeError("offline");
    return reply(probeStatus);
  });
  const probes = () =>
    fetch.mock.calls.filter(([input]) => requestUrl(input) === INTERVALS_CREDENTIAL_PROBE_URL)
      .length;
  return { fetch: fetch as unknown as typeof globalThis.fetch, probes, probeAuthorizations };
}

beforeEach(() => {
  resetIntervalsCredentialHealthForTests();
  resetSharedRequestBucketForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetIntervalsCredentialHealthForTests();
});

describe("intervals.icu credential health", () => {
  it("marks a signed-in credential rejected on 401", () => {
    recordIntervalsCredentialResponse(SIGNED_IN, 401);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
    expect(isIntervalsCredentialRejected(OTHER_SIGNED_IN)).toBe(false);
  });

  it("does not mark a credential from a 403 alone", () => {
    recordIntervalsCredentialResponse(SIGNED_IN, 403);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(false);
  });

  it.each([200, 204, 299])("clears a rejected credential on %i", (status) => {
    recordIntervalsCredentialResponse(SIGNED_IN, 401);
    recordIntervalsCredentialResponse(SIGNED_IN, status);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(false);
  });

  it.each([404, 429, 500, 503, 302])("keeps the current state on %i", (status) => {
    recordIntervalsCredentialResponse(SIGNED_IN, 401);
    recordIntervalsCredentialResponse(SIGNED_IN, status);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
    recordIntervalsCredentialResponse(OTHER_SIGNED_IN, status);
    expect(isIntervalsCredentialRejected(OTHER_SIGNED_IN)).toBe(false);
  });

  it("never marks or probes an API key", async () => {
    recordIntervalsCredentialResponse(API_KEY, 401);
    expect(isIntervalsCredentialRejected(API_KEY)).toBe(false);
    const baseFetch = respondWith(403);
    expect(trackIntervalsCredentialHealth(API_KEY, baseFetch)).toBe(baseFetch);
  });

  it("clears only the credential that succeeded", () => {
    recordIntervalsCredentialResponse(SIGNED_IN, 401);
    recordIntervalsCredentialResponse(OTHER_SIGNED_IN, 401);
    recordIntervalsCredentialResponse(OTHER_SIGNED_IN, 200);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
    expect(isIntervalsCredentialRejected(OTHER_SIGNED_IN)).toBe(false);
  });

  it("returns the response unchanged and rethrows transport failures", async () => {
    const tracked = trackIntervalsCredentialHealth(SIGNED_IN, respondWith(401));
    const response = await tracked("https://intervals.test/api/v1/athlete/0");
    expect(response.status).toBe(401);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
    const failing = trackIntervalsCredentialHealth(SIGNED_IN, async () => {
      throw new TypeError("offline");
    });
    await expect(failing("https://intervals.test/api/v1/athlete/0")).rejects.toThrow("offline");
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
  });

  it("keeps a credential that a 2xx probe accepts after an out-of-scope 403", async () => {
    const stub = forbiddenWithProbe(200);
    const tracked = trackIntervalsCredentialHealth(SIGNED_IN, stub.fetch);
    const response = await tracked(OUT_OF_SCOPE_URL);
    expect(response.status).toBe(403);
    expect(stub.probes()).toBe(1);
    expect(stub.probeAuthorizations).toEqual(["Bearer fixture-token-a"]);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(false);
  });

  it.each([401, 403])("marks a credential when the probe answers %i", async (probeStatus) => {
    const stub = forbiddenWithProbe(probeStatus);
    await trackIntervalsCredentialHealth(SIGNED_IN, stub.fetch)(OUT_OF_SCOPE_URL);
    expect(stub.probes()).toBe(1);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
    await trackIntervalsCredentialHealth(SIGNED_IN, stub.fetch)(OUT_OF_SCOPE_URL);
    expect(stub.probes()).toBe(1);
  });

  it.each([500, "offline"] as const)("marks nothing when the probe is %s", async (probeStatus) => {
    const stub = forbiddenWithProbe(probeStatus);
    const tracked = trackIntervalsCredentialHealth(SIGNED_IN, stub.fetch);
    await expect(tracked(OUT_OF_SCOPE_URL)).resolves.toMatchObject({ status: 403 });
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(false);
    await tracked(OUT_OF_SCOPE_URL);
    expect(stub.probes()).toBe(2);
  });

  it("runs one probe for concurrent 403s on the same credential", async () => {
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input) !== INTERVALS_CREDENTIAL_PROBE_URL) return reply(403);
      await probeGate;
      return reply(401);
    });
    const tracked = trackIntervalsCredentialHealth(
      SIGNED_IN,
      fetch as unknown as typeof globalThis.fetch,
    );
    const requests = [
      tracked(OUT_OF_SCOPE_URL),
      tracked(OUT_OF_SCOPE_URL),
      tracked(OUT_OF_SCOPE_URL),
    ];
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(4);
    });
    releaseProbe();
    await Promise.all(requests);
    expect(
      fetch.mock.calls.filter(([input]) => requestUrl(input) === INTERVALS_CREDENTIAL_PROBE_URL),
    ).toHaveLength(1);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
  });

  it("skips probes for ten minutes after a probe accepts the credential", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2001-02-03T04:05:06Z"));
    const stub = forbiddenWithProbe(200);
    const tracked = trackIntervalsCredentialHealth(SIGNED_IN, stub.fetch);
    await tracked(OUT_OF_SCOPE_URL);
    await tracked(OUT_OF_SCOPE_URL);
    vi.setSystemTime(Date.now() + INTERVALS_CREDENTIAL_PROBE_COOLDOWN_MS - 1);
    await tracked(OUT_OF_SCOPE_URL);
    expect(stub.probes()).toBe(1);
    const otherStub = forbiddenWithProbe(200);
    await trackIntervalsCredentialHealth(OTHER_SIGNED_IN, otherStub.fetch)(OUT_OF_SCOPE_URL);
    expect(otherStub.probes()).toBe(1);

    vi.setSystemTime(Date.now() + 2);
    await tracked(OUT_OF_SCOPE_URL);
    expect(stub.probes()).toBe(2);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(false);
  });

  it("tracks the store-sync adapter", async () => {
    const port = makeIntervalsHttpFactory({ apiKey: SIGNED_IN, baseFetch: respondWith(401) })({
      outer: new AbortController().signal,
      perRequestTimeoutMs: 30_000,
    });
    await port.fetch({ method: "GET", url: "https://intervals.test/api/v1/athlete/0" });
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);

    const recovered = makeIntervalsHttpFactory({ apiKey: SIGNED_IN, baseFetch: respondWith(200) })({
      outer: new AbortController().signal,
      perRequestTimeoutMs: 30_000,
    });
    await recovered.fetch({ method: "GET", url: "https://intervals.test/api/v1/athlete/0" });
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(false);
  });

  it("confirms a store-sync 403 with a probe through the same base fetch", async () => {
    const stub = forbiddenWithProbe(401);
    const port = makeIntervalsHttpFactory({ apiKey: SIGNED_IN, baseFetch: stub.fetch })({
      outer: new AbortController().signal,
      perRequestTimeoutMs: 30_000,
    });
    await port.fetch({ method: "GET", url: OUT_OF_SCOPE_URL });
    expect(stub.probes()).toBe(1);
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
  });

  it("tracks the abortable client", async () => {
    const client = makeAbortableClient({
      apiKey: SIGNED_IN,
      athleteId: "i1",
      signal: new AbortController().signal,
      perRequestMs: 30_000,
      baseFetch: respondWith(401),
    });
    await expect(client.athlete.get()).resolves.toMatchObject({ ok: false });
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
  });

  it("tracks the chat client and ignores API keys there", async () => {
    await expect(
      makeChatClient({ apiKey: SIGNED_IN, athleteId: "i1", fetch: respondWith(401) }).athlete.get(),
    ).resolves.toMatchObject({ ok: false });
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(true);
    await makeChatClient({
      apiKey: SIGNED_IN,
      athleteId: "i1",
      fetch: respondWith(200),
    }).athlete.get();
    expect(isIntervalsCredentialRejected(SIGNED_IN)).toBe(false);

    await expect(
      makeChatClient({ apiKey: API_KEY, athleteId: "i1", fetch: respondWith(401) }).athlete.get(),
    ).resolves.toMatchObject({ ok: false });
    expect(isIntervalsCredentialRejected(API_KEY)).toBe(false);
  });
});
