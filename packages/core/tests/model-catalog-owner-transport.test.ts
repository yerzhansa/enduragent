import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  MODEL_CATALOG_RESPONSE_LIMIT_BYTES,
} from "../src/model-catalog-owner.js";
import {
  baseTime,
  openCatalog,
  own,
  remoteCatalog,
  resetOwnerCatalogFixtures,
  serverFor,
  tempDirectory,
  unreadBodyCases,
  type CountedHttpResponse,
} from "./helpers/model-catalog-owner-harness.js";

afterEach(resetOwnerCatalogFixtures);

describe("model catalog request transport", () => {
  it("fails closed at request time when Node TLS verification is disabled and keeps the attempt claimed", async () => {
    let now = baseTime;
    const installationRoot = tempDirectory("catalog-disabled-tls-");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify(remoteCatalog()), {
        status: 200,
        headers: { ETag: '"revision-2"' },
      }),
    );
    const first = openCatalog({
      endpoint: "https://catalog.invalid/test",
      fetch,
      installationRoot,
      now: () => now,
    });
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    await own(first);

    await expect(first.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
      revision: 1,
    });
    expect(fetch).not.toHaveBeenCalled();
    await first.shutdown();
    vi.unstubAllEnvs();

    now += MODEL_CATALOG_REFRESH_INTERVAL_MS - 1;
    const replacement = openCatalog({
      endpoint: "https://catalog.invalid/test",
      fetch,
      installationRoot,
      now: () => now,
    });
    await own(replacement);
    await expect(replacement.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "not-due",
      revision: 1,
    });
    expect(fetch).not.toHaveBeenCalled();

    now += 1;
    await expect(replacement.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes into one request", async () => {
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"revision-2"' },
      chunks: [JSON.stringify(remoteCatalog())],
      delayBetweenChunksMs: 20,
    }));
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    const outcomes = await Promise.all(Array.from({ length: 40 }, () => catalog.refresh()));
    expect(server.requests).toHaveLength(1);
    expect(outcomes).toEqual(Array.from({ length: 40 }, () => ({ kind: "updated", revision: 2 })));
  });

  it("bounds the streamed response at the transport before JSON parsing", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const chunks = Array.from(
      { length: MODEL_CATALOG_RESPONSE_LIMIT_BYTES / chunk.byteLength + 1 },
      () => chunk,
    );
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"oversized"' },
      chunks,
    }));
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "response-too-large",
      revision: 1,
    });
    expect(catalog.current().revision).toBe(1);
  });

  it("times out a slow request and retains local data", async () => {
    const server = await serverFor(() => ({
      status: 200,
      headers: { ETag: '"slow"' },
      chunks: ["{", JSON.stringify(remoteCatalog()).slice(1)],
      delayBetweenChunksMs: 100,
    }));
    const catalog = openCatalog({ endpoint: server.url, requestTimeoutMs: 20 });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
      revision: 1,
    });
    expect(catalog.current().revision).toBe(1);
  });

  it("uses a matching ETag and rejects a 304 without one", async () => {
    let now = baseTime;
    const candidate = remoteCatalog();
    const server = await serverFor((_request, index) =>
      index === 0
        ? {
            status: 200,
            headers: { ETag: '"revision-2"' },
            chunks: [JSON.stringify(candidate)],
          }
        : { status: 304, headers: { ETag: '"revision-2"' } },
    );
    const catalog = openCatalog({ endpoint: server.url, now: () => now });
    await own(catalog);
    await expect(catalog.refresh()).resolves.toEqual({ kind: "updated", revision: 2 });

    now += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    await expect(catalog.refresh()).resolves.toEqual({ kind: "unchanged", revision: 2 });
    expect(server.requests[1]?.headers["if-none-match"]).toBe('"revision-2"');

    const other = openCatalog({
      endpoint: server.url,
      installationRoot: tempDirectory("catalog-304-"),
    });
    await own(other);
    await expect(other.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "invalid-not-modified",
      revision: 1,
    });
  });

  it("rejects a successful response without an ETag", async () => {
    const server = await serverFor(() => ({
      status: 200,
      chunks: [JSON.stringify(remoteCatalog())],
    }));
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "invalid-response",
      revision: 1,
    });
    expect(catalog.current().revision).toBe(1);
  });

  it("rejects stale, malformed, forbidden, and unusable responses without advancing state", async () => {
    let now = baseTime;
    const stale = remoteCatalog(1);
    const forbidden = { ...remoteCatalog(3), endpoint: "https://invalid.example" };
    const unusable = remoteCatalog(4);
    unusable.providers = unusable.providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        compatibilityProfile: "future-profile-v2",
      })),
    }));
    const unknownSchema: unknown = { ...remoteCatalog(5), schemaVersion: 2 };
    const bodies = [
      JSON.stringify(stale),
      "{broken",
      JSON.stringify(forbidden),
      JSON.stringify(unusable),
      JSON.stringify(unknownSchema),
    ];
    const server = await serverFor((_request, index) => ({
      status: 200,
      headers: { ETag: `"candidate-${index}"` },
      chunks: [bodies[index] ?? "{}"],
    }));
    const catalog = openCatalog({ endpoint: server.url, now: () => now });
    await own(catalog);

    const retainedReasons: readonly (
      | "invalid-response"
      | "no-usable-choices"
      | "stale-revision"
    )[] = [
      "stale-revision",
      "invalid-response",
      "invalid-response",
      "no-usable-choices",
      "invalid-response",
    ];
    for (const reason of retainedReasons) {
      await expect(catalog.refresh()).resolves.toMatchObject({
        kind: "retained",
        reason,
        revision: 1,
      });
      now += MODEL_CATALOG_REFRESH_INTERVAL_MS;
    }
    expect(catalog.current().revision).toBe(1);
  });

  it.each(unreadBodyCases)(
    "cancels unread bodies for $title",
    async ({ headers, reason, status }) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        cancel,
        start(controller) {
          controller.enqueue(new TextEncoder().encode("still streaming"));
        },
      });
      let requestSignal: AbortSignal | null | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        requestSignal = init?.signal;
        return new Response(body, { headers, status });
      });
      const catalog = openCatalog({
        endpoint: "https://catalog.invalid/test",
        fetch,
      });
      await own(catalog);

      await expect(catalog.refresh()).resolves.toMatchObject({ kind: "retained", reason });
      expect(cancel).toHaveBeenCalledOnce();
      expect(requestSignal?.aborted).toBe(true);
    },
  );

  it("does not follow redirects beyond the claimed request", async () => {
    const server = await serverFor((_request, index): CountedHttpResponse => {
      if (index === 0) return { status: 302, headers: { Location: "/redirected" } };
      return {
        status: 200,
        headers: { ETag: '"revision-2"' },
        chunks: [JSON.stringify(remoteCatalog())],
      };
    });
    const catalog = openCatalog({ endpoint: server.url });
    await own(catalog);

    await expect(catalog.refresh()).resolves.toMatchObject({
      kind: "retained",
      reason: "request-failed",
      revision: 1,
    });
    expect(server.requests).toHaveLength(1);
  });
});
