import { describe, expect, it } from "vitest";
import { bundledAcceptedCatalog } from "../src/model-catalog.js";
import { BUNDLED_MODEL_CATALOG } from "../src/model-catalog-seed.js";
import { ResponseLimitError } from "../src/model-catalog-http.js";
import { createCatalogRefreshSession } from "../src/model-catalog-refresh.js";

const SUCCESSFUL_AT = "1998-01-01T00:00:00.000Z";

describe("catalog refresh session", () => {
  const current = bundledAcceptedCatalog();
  const session = createCatalogRefreshSession({
    requestEtag: '"revision-1"',
    current,
  });

  it("retains HTTP errors and invalid 304s without treating them as updates", () => {
    expect(
      session.fromHeaders({
        status: 500,
        responseEtag: '"revision-2"',
        successfulAt: SUCCESSFUL_AT,
      }),
    ).toEqual({ kind: "retain", reason: "http-error", cancelBody: true });
    expect(
      session.fromHeaders({
        status: 304,
        responseEtag: '"other"',
        successfulAt: SUCCESSFUL_AT,
      }),
    ).toEqual({ kind: "retain", reason: "invalid-not-modified", cancelBody: true });
    expect(
      session.fromHeaders({
        status: 304,
        responseEtag: '"revision-1"',
        successfulAt: SUCCESSFUL_AT,
      }),
    ).toEqual({ kind: "not-modified", successfulAt: SUCCESSFUL_AT });
  });

  it("reads a successful body only when the ETag and timestamp are present", () => {
    expect(
      session.fromHeaders({
        status: 200,
        responseEtag: null,
        successfulAt: SUCCESSFUL_AT,
      }),
    ).toEqual({ kind: "retain", reason: "invalid-response", cancelBody: true });
    expect(
      session.fromHeaders({
        status: 200,
        responseEtag: '"revision-2"',
        successfulAt: SUCCESSFUL_AT,
      }),
    ).toEqual({ kind: "read-body", etag: '"revision-2"', successfulAt: SUCCESSFUL_AT });
  });

  it("accepts a newer snapshot and retains a stale or unusable one", () => {
    const newer = structuredClone(BUNDLED_MODEL_CATALOG);
    newer.revision = current.snapshot.revision + 1;
    const openai = newer.providers.find((provider) => provider.providerId === "openai");
    if (openai === undefined) throw new Error("missing openai provider");
    openai.models.push({
      modelId: "new-model-2",
      label: "New Model 2",
      order: 50,
      compatibilityProfile: "openai-ai-sdk-v1",
      contextWindow: { kind: "unknown" },
      imageInput: "unknown",
      pricing: { kind: "unknown" },
    });
    const accepted = session.fromBody({
      closed: false,
      body: JSON.stringify(newer),
      etag: '"revision-2"',
    });
    expect(accepted).toMatchObject({
      kind: "updated",
      record: { snapshot: { revision: newer.revision } },
    });
    expect(
      session.fromBody({
        closed: false,
        body: JSON.stringify(BUNDLED_MODEL_CATALOG),
        etag: '"revision-1"',
      }),
    ).toEqual({ kind: "retain", reason: "stale-revision" });
    expect(
      session.fromBody({
        closed: false,
        body: "{",
        etag: '"revision-2"',
      }),
    ).toEqual({ kind: "retain", reason: "invalid-response" });
    expect(session.bodyFailure(false, new ResponseLimitError())).toBe("response-too-large");
    expect(session.networkFailure(true)).toBe("shutdown");
  });
});
