import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "intervals-icu-api";
import { createPhysicalRequestLedger, PhysicalRequestLimitError } from "@enduragent/kernel/store";
import {
  CHAT_PER_REQUEST_TIMEOUT_MS,
  makeAbortableClient,
  makeChatClient,
  makeIntervalsHttpFactory,
  resetSharedRequestBucketForTests,
  wrapFetchWithSharedBucket,
  wrapFetchWithSignal,
} from "../src/reference/sync/intervals-client-factory.js";
import { encodeIntervalsOAuthCredential } from "../src/intervals-credential.js";

beforeEach(() => {
  resetSharedRequestBucketForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockAbortSignalTimeout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        ),
      ms,
    );
    return controller.signal;
  });
}

function stub500(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response("boom", { status: 500 }));
}

function hungFetch(): typeof globalThis.fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason ?? new Error("aborted")),
        { once: true },
      );
    });
}

describe("wrapFetchWithSignal", () => {
  it("threads a chained AbortSignal into the init passed to baseFetch", async () => {
    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };
    const outer = new AbortController();

    const wrapped = wrapFetchWithSignal({
      baseFetch,
      outer: outer.signal,
      perRequestMs: 30_000,
    });
    await wrapped("https://example.test/", {});

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
  });

  it("aborts in-flight signals when the outer signal aborts", async () => {
    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };
    const outer = new AbortController();

    const wrapped = wrapFetchWithSignal({
      baseFetch,
      outer: outer.signal,
      perRequestMs: 30_000,
    });
    await wrapped("https://example.test/", {});

    expect(captured!.aborted).toBe(false);
    outer.abort();
    expect(captured!.aborted).toBe(true);
  });

  it("aborts in-flight signals when the per-request timeout fires", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };
    const outer = new AbortController();

    const wrapped = wrapFetchWithSignal({
      baseFetch,
      outer: outer.signal,
      perRequestMs: 50,
    });
    await wrapped("https://example.test/", {});
    expect(captured!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60);

    expect(captured!.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
  });

  it("charges the shared legacy ceiling immediately before the physical fetch", async () => {
    const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    const baseFetch = vi.fn(async () => new Response("ok"));
    const wrapped = wrapFetchWithSignal({
      baseFetch,
      outer: new AbortController().signal,
      perRequestMs: 30_000,
      attemptLedger: ledger,
    });
    for (let index = 0; index < 15; index += 1) await wrapped(`https://example.test/${index}`);
    await expect(wrapped("https://example.test/rejected")).rejects.toBeInstanceOf(
      PhysicalRequestLimitError,
    );
    expect(baseFetch).toHaveBeenCalledTimes(15);
    expect(ledger.snapshot()).toMatchObject({ legacyRequests: 15, totalRequests: 15 });
  });

  it("threads a timeout-only AbortSignal when no outer signal is provided", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    let captured: AbortSignal | undefined;
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      captured = init?.signal ?? undefined;
      return new Response("ok");
    };

    const wrapped = wrapFetchWithSignal({ baseFetch, perRequestMs: 50 });
    await wrapped("https://example.test/", {});

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(captured!.aborted).toBe(true);
  });
});

describe("shared request bucket", () => {
  it("two chat clients share one process-wide bucket (burst 30, refill 10 req/s)", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    const stubA = stub500();
    const stubB = stub500();
    const clientA = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stubA as unknown as typeof globalThis.fetch,
    });
    const clientB = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stubB as unknown as typeof globalThis.fetch,
    });

    const event = {
      startDateLocal: "1998-01-05T00:00:00",
      category: "WORKOUT" as const,
      name: "Test workout",
    };

    await Promise.all([
      ...Array.from({ length: 15 }, () => clientA.events.create(event)),
      ...Array.from({ length: 15 }, () => clientB.events.create(event)),
    ]);
    expect(stubA).toHaveBeenCalledTimes(15);
    expect(stubB).toHaveBeenCalledTimes(15);

    let resolved = false;
    const p = clientA.events.create(event).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    expect(stubA).toHaveBeenCalledTimes(15);

    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(resolved).toBe(true);
    expect(stubA).toHaveBeenCalledTimes(16);
  });

  it("aborts a queued wait promptly without calling the base fetch", async () => {
    vi.useFakeTimers();

    const base = vi.fn(async () => new Response("ok"));
    const wrapped = wrapFetchWithSharedBucket(base as unknown as typeof globalThis.fetch);

    await Promise.all(Array.from({ length: 30 }, () => wrapped("https://example.test/")));
    expect(base).toHaveBeenCalledTimes(30);

    const controller = new AbortController();
    const queued = wrapped("https://example.test/", { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(base).toHaveBeenCalledTimes(30);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const base = vi.fn(async () => new Response("ok"));
    const wrapped = wrapFetchWithSharedBucket(base as unknown as typeof globalThis.fetch);

    const controller = new AbortController();
    controller.abort();
    await expect(wrapped("https://example.test/", { signal: controller.signal })).rejects.toThrow();
    expect(base).not.toHaveBeenCalled();
  });
});

describe("makeAbortableClient", () => {
  it("returns an IntervalsClient instance configured with the abortable wrapper-fetch", () => {
    const outer = new AbortController();
    const client = makeAbortableClient({
      apiKey: "test-key",
      signal: outer.signal,
      perRequestMs: 30_000,
    });
    expect(client).toBeInstanceOf(IntervalsClient);
  });

  it("uses an injected transport while preserving the operation-scoped signal", async () => {
    const outer = new AbortController();
    let captured: AbortSignal | undefined;
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = makeAbortableClient({
      apiKey: "test-key",
      signal: outer.signal,
      perRequestMs: 30_000,
      baseFetch: baseFetch as unknown as typeof globalThis.fetch,
    });

    await expect(
      client.activities.getStreamMap("activity-1", {
        types: ["time"],
        includeDefaults: false,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(baseFetch).toHaveBeenCalledOnce();
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
  });
});

describe("makeChatClient", () => {
  it("returns an IntervalsClient instance", () => {
    const client = makeChatClient({ apiKey: "test-key" });
    expect(client).toBeInstanceOf(IntervalsClient);
  });

  it("injects an abortable timeout signal into chat requests", async () => {
    let captured: AbortSignal | undefined;
    const stub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      return new Response("boom", { status: 500 });
    });
    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stub as unknown as typeof globalThis.fetch,
    });

    await client.events.create({
      startDateLocal: "1998-01-05T00:00:00",
      category: "WORKOUT",
      name: "Test workout",
    });

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
  });

  it("aborts a hung chat fetch at the 30 s per-request timeout", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: hungFetch(),
    });

    let result: Awaited<ReturnType<typeof client.events.create>> | undefined;
    const p = client.events
      .create({
        startDateLocal: "1998-01-05T00:00:00",
        category: "WORKOUT",
        name: "Test workout",
      })
      .then((value) => {
        result = value;
      });

    await vi.advanceTimersByTimeAsync(CHAT_PER_REQUEST_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "Network",
        message: "Request aborted",
      },
    });
  });

  it("does not retry a POST that fails with HTTP 500", async () => {
    const stub = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stub as unknown as typeof globalThis.fetch,
    });

    const result = await client.events.create({
      startDateLocal: "1998-01-05T00:00:00",
      category: "WORKOUT",
      name: "Test workout",
    });

    expect(stub).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("does not honor Retry-After on a 429 at the HTTP layer", async () => {
    const stub = vi.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    );
    const client = makeChatClient({
      apiKey: "test-key",
      athleteId: "i1",
      fetch: stub as unknown as typeof globalThis.fetch,
    });

    const result = await client.events.create({
      startDateLocal: "1998-01-05T00:00:00",
      category: "WORKOUT",
      name: "Test workout",
    });

    expect(stub).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});

describe("makeIntervalsHttpFactory raw adapter", () => {
  const basicUser = ["API", "KEY"].join("_");

  it("injects Basic credentials while preserving raw response bytes and headers", async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${btoa(`${basicUser}:dummy`)}`,
      );
      expect(init?.method).toBe("POST");
      expect(init?.body).toEqual(new Uint8Array([1, 2]));
      return new Response(new Uint8Array([9, 8]), {
        status: 201,
        headers: { "Retry-After": "120", "X-Test": "yes" },
      });
    });
    const outer = new AbortController();
    const port = makeIntervalsHttpFactory({
      apiKey: "dummy",
      baseFetch: baseFetch as typeof globalThis.fetch,
    })({
      outer: outer.signal,
      perRequestTimeoutMs: 30_000,
    });
    await expect(
      port.fetch({ method: "POST", url: "https://example.test/raw", body: new Uint8Array([1, 2]) }),
    ).resolves.toEqual({
      status: 201,
      headers: { "retry-after": "120", "x-test": "yes" },
      body: new Uint8Array([9, 8]),
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("injects Bearer credentials for a signed-in OAuth credential", async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    const port = makeIntervalsHttpFactory({
      apiKey: encodeIntervalsOAuthCredential("fixture-token"),
      baseFetch: baseFetch as typeof globalThis.fetch,
    })({ outer: new AbortController().signal, perRequestTimeoutMs: 30_000 });
    await port.fetch({ method: "GET", url: "https://example.test/raw" });
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects empty keys and caller-supplied authorization", async () => {
    expect(() => makeIntervalsHttpFactory({ apiKey: String() })).toThrow("API key is required");
    const port = makeIntervalsHttpFactory({ apiKey: "dummy", baseFetch: vi.fn() as never })({
      outer: new AbortController().signal,
      perRequestTimeoutMs: 1_000,
    });
    await expect(
      port.fetch({
        method: "GET",
        url: "https://example.test/",
        headers: { Authorization: "dummy" },
      }),
    ).rejects.toThrow("authorization header is managed");
  });

  it("creates a fresh run-scoped abort closure", async () => {
    const signals: AbortSignal[] = [];
    const baseFetch: typeof globalThis.fetch = async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Response();
    };
    const factory = makeIntervalsHttpFactory({ apiKey: "dummy", baseFetch });
    const first = new AbortController(),
      second = new AbortController();
    await factory({ outer: first.signal, perRequestTimeoutMs: 30_000 }).fetch({
      method: "GET",
      url: "https://example.test/1",
    });
    await factory({ outer: second.signal, perRequestTimeoutMs: 30_000 }).fetch({
      method: "GET",
      url: "https://example.test/2",
    });
    first.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});

describe("IntervalsClient auth for each credential kind", () => {
  const basicUser = ["API", "KEY"].join("_");
  const athleteBody = () =>
    new Response(JSON.stringify({ id: "i1", name: "Fixture" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it.each([
    ["an API key", "plain-key", `Basic ${btoa(`${basicUser}:plain-key`)}`],
    [
      "an OAuth credential",
      encodeIntervalsOAuthCredential("fixture-token"),
      "Bearer fixture-token",
    ],
  ])("the chat client sends the right header for %s", async (_label, apiKey, expected) => {
    const seen: (string | null)[] = [];
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(
        new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
          "authorization",
        ),
      );
      return athleteBody();
    });
    const client = makeChatClient({
      apiKey,
      athleteId: "i1",
      fetch: stub as unknown as typeof globalThis.fetch,
    });
    await client.athlete.get();
    expect(seen).toEqual([expected]);
  });

  it.each([
    ["an API key", "plain-key", `Basic ${btoa(`${basicUser}:plain-key`)}`],
    [
      "an OAuth credential",
      encodeIntervalsOAuthCredential("fixture-token"),
      "Bearer fixture-token",
    ],
  ])("the sync client sends the right header for %s", async (_label, apiKey, expected) => {
    const seen: (string | null)[] = [];
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(
        new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
          "authorization",
        ),
      );
      return athleteBody();
    });
    const client = makeAbortableClient({
      apiKey,
      athleteId: "i1",
      signal: new AbortController().signal,
      perRequestMs: 30_000,
      baseFetch: stub as unknown as typeof globalThis.fetch,
    });
    await client.athlete.get();
    expect(seen).toEqual([expected]);
  });
});
