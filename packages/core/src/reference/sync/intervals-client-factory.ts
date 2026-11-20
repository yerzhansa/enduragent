import { IntervalsClient } from "intervals-icu-api";
import type { HttpPort } from "@enduragent/kernel/ports";
import type { PhysicalRequestLedger } from "@enduragent/kernel/store";
import { chainedSignal } from "../../concurrency/abort-budget.js";
import { intervalsAuthorizationHeader, intervalsClientAuth } from "../../intervals-credential.js";

export interface RunScopedHttpFactoryArgs {
  readonly outer: AbortSignal;
  readonly perRequestTimeoutMs: number;
}

export type RunScopedHttpFactory = (args: RunScopedHttpFactoryArgs) => HttpPort;

export const CHAT_PER_REQUEST_TIMEOUT_MS = 30_000;

const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_PER_SECOND = 10;

let bucketTokens = BUCKET_CAPACITY;
let bucketLastRefillMs = Date.now();

export function resetSharedRequestBucketForTests(): void {
  bucketTokens = BUCKET_CAPACITY;
  bucketLastRefillMs = Date.now();
}

function abortReason(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function abortableDelay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireRequestToken(signal: AbortSignal | null | undefined): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    const now = Date.now();
    const elapsedMs = now - bucketLastRefillMs;
    if (elapsedMs > 0) {
      bucketTokens = Math.min(
        BUCKET_CAPACITY,
        bucketTokens + (elapsedMs / 1000) * BUCKET_REFILL_PER_SECOND,
      );
      bucketLastRefillMs = now;
    }
    if (bucketTokens >= 1) {
      bucketTokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - bucketTokens) / BUCKET_REFILL_PER_SECOND) * 1000);
    await abortableDelay(waitMs, signal);
  }
}

export function wrapFetchWithSharedBucket(
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    await acquireRequestToken(init?.signal);
    return baseFetch(input, init);
  };
}

export function wrapFetchWithSignal(opts: {
  baseFetch: typeof globalThis.fetch;
  outer?: AbortSignal;
  perRequestMs: number;
  attemptLedger?: PhysicalRequestLedger;
}): typeof globalThis.fetch {
  return async (input, init) => {
    opts.attemptLedger?.charge("legacy", "legacy:reference");
    return await opts.baseFetch(input, {
      ...init,
      signal: opts.outer
        ? chainedSignal({ outer: opts.outer, perRequestMs: opts.perRequestMs })
        : AbortSignal.timeout(opts.perRequestMs),
    });
  };
}

export function makeIntervalsHttpFactory(options: {
  readonly apiKey: string;
  readonly baseFetch?: typeof globalThis.fetch;
}): RunScopedHttpFactory {
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new TypeError("intervals.icu API key is required");
  }
  const authorization = intervalsAuthorizationHeader(options.apiKey);
  const baseFetch = options.baseFetch ?? globalThis.fetch;
  return ({ outer, perRequestTimeoutMs }) => {
    const fetch = wrapFetchWithSignal({ baseFetch, outer, perRequestMs: perRequestTimeoutMs });
    return {
      async fetch(request) {
        const headers = new Headers(request.headers);
        if (headers.has("authorization")) {
          throw new TypeError("authorization header is managed by the intervals.icu adapter");
        }
        headers.set("authorization", authorization);
        const response = await fetch(request.url, {
          method: request.method,
          headers,
          body:
            typeof request.body === "string"
              ? request.body
              : request.body === undefined
                ? undefined
                : new Uint8Array(request.body),
        });
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });
        return {
          status: response.status,
          headers: responseHeaders,
          body: new Uint8Array(await response.arrayBuffer()),
        };
      },
    };
  };
}

export function makeAbortableClient(opts: {
  apiKey: string;
  athleteId?: string;
  signal: AbortSignal;
  perRequestMs: number;
  attemptLedger?: PhysicalRequestLedger;
  baseFetch?: typeof globalThis.fetch;
}): IntervalsClient {
  return new IntervalsClient({
    ...intervalsClientAuth(opts.apiKey),
    athleteId: opts.athleteId,
    fetch: wrapFetchWithSignal({
      baseFetch: wrapFetchWithSharedBucket(opts.baseFetch ?? globalThis.fetch),
      outer: opts.signal,
      perRequestMs: opts.perRequestMs,
      attemptLedger: opts.attemptLedger,
    }),
    retry: { maxAttempts: 1 },
  });
}

export function makeChatClient(opts: {
  apiKey: string;
  athleteId?: string;
  fetch?: typeof globalThis.fetch;
}): IntervalsClient {
  return new IntervalsClient({
    ...intervalsClientAuth(opts.apiKey),
    athleteId: opts.athleteId,
    fetch: wrapFetchWithSignal({
      baseFetch: wrapFetchWithSharedBucket(opts.fetch ?? globalThis.fetch),
      perRequestMs: CHAT_PER_REQUEST_TIMEOUT_MS,
    }),
    retry: { maxAttempts: 1 },
  });
}
