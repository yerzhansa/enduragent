import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { handleModelCatalogApiFallbackRequest } from "./model-catalog-api-fallback.js";
import { jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  MODEL_CATALOG_EDGE_MAX_AGE_SECONDS,
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_PUBLIC_URL,
} from "./model-catalog-constants.js";
import {
  handleModelCatalogRequest,
  type ModelCatalogR2ObjectBody,
} from "./model-catalog-worker.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function catalogObject(): Promise<ModelCatalogR2ObjectBody> {
  const catalog = ModelCatalogSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 7,
    provenance: { kind: "published", publishedAt: "1998-09-14T09:00:00.000Z" },
    providers: [
      {
        providerId: "openai",
        label: "Synthetic provider",
        order: 0,
        recommendedModelId: "synthetic-model",
        models: [
          {
            modelId: "synthetic-model",
            label: "Synthetic model",
            order: 0,
            compatibilityProfile: "openai-ai-sdk-v1",
            contextWindow: { kind: "unknown" },
            imageInput: "unknown",
            pricing: { kind: "unknown" },
          },
        ],
      },
    ],
  });
  const bytes = jsonBytes(catalog);
  const digest = await sha256(bytes);
  return {
    size: bytes.byteLength,
    httpEtag: '"catalog-etag"',
    customMetadata: {
      "format-version": "1",
      revision: "7",
      "catalog-digest": digest.hex,
      "published-at": "1998-09-14T09:00:00.000Z",
      "record-key": `revisions/7/${digest.hex}.json`,
    },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

function environment(object: ModelCatalogR2ObjectBody | null) {
  return { MODEL_CATALOG: { get: async () => object } };
}

describe("model catalog Worker", () => {
  it("serves exact validated bytes with bounded public headers", async () => {
    const object = await catalogObject();
    const response = await handleModelCatalogRequest(
      new Request(MODEL_CATALOG_PUBLIC_URL),
      environment(object),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("etag")).toBe(object.httpEtag);
    expect(response.headers.get("cache-control")).toBe(
      `public, max-age=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, s-maxage=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, no-transform`,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(await object.arrayBuffer()));
    expect(response.headers.get("content-digest")).toBe((await sha256(bytes)).contentDigest);
  });

  it("returns matching HEAD and conditional 304 responses without bodies", async () => {
    const object = await catalogObject();
    const head = await handleModelCatalogRequest(
      new Request(MODEL_CATALOG_PUBLIC_URL, { method: "HEAD" }),
      environment(object),
    );
    const notModified = await handleModelCatalogRequest(
      new Request(MODEL_CATALOG_PUBLIC_URL, {
        headers: { "If-None-Match": `W/${object.httpEtag}` },
      }),
      environment(object),
    );

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(object.size));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(object.httpEtag);
    expect(notModified.headers.get("content-length")).toBeNull();
    expect((await notModified.arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects the wrong protocol, path, and method", async () => {
    const object = await catalogObject();
    const http = await handleModelCatalogRequest(
      new Request(MODEL_CATALOG_PUBLIC_URL.replace("https:", "http:")),
      environment(object),
    );
    const path = await handleModelCatalogRequest(
      new Request("https://api.enduragent.icu/models/v1/other.json"),
      environment(object),
    );
    const post = await handleModelCatalogRequest(
      new Request(MODEL_CATALOG_PUBLIC_URL, { method: "POST" }),
      environment(object),
    );

    expect(http.status).toBe(404);
    expect(path.status).toBe(404);
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("does not serve missing, invalid, oversized, or metadata-mismatched objects", async () => {
    const valid = await catalogObject();
    const invalid = {
      ...valid,
      size: 2,
      arrayBuffer: async () => Uint8Array.from([123, 125]).buffer,
    };
    const oversized = { ...valid, size: MODEL_CATALOG_MAX_BYTES + 1 };
    const mismatched = {
      ...valid,
      customMetadata: { ...valid.customMetadata, revision: "8" },
    };

    await expect(
      handleModelCatalogRequest(new Request(MODEL_CATALOG_PUBLIC_URL), environment(null)),
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      handleModelCatalogRequest(new Request(MODEL_CATALOG_PUBLIC_URL), environment(invalid)),
    ).resolves.toMatchObject({ status: 502 });
    await expect(
      handleModelCatalogRequest(new Request(MODEL_CATALOG_PUBLIC_URL), environment(oversized)),
    ).resolves.toMatchObject({ status: 502 });
    await expect(
      handleModelCatalogRequest(new Request(MODEL_CATALOG_PUBLIC_URL), environment(mismatched)),
    ).resolves.toMatchObject({ status: 502 });
  });

  it("turns storage read failures into retryable service responses", async () => {
    const object = await catalogObject();
    const unavailable = await handleModelCatalogRequest(new Request(MODEL_CATALOG_PUBLIC_URL), {
      MODEL_CATALOG: {
        get: async () => {
          throw new Error("synthetic storage failure");
        },
      },
    });
    const interrupted = await handleModelCatalogRequest(
      new Request(MODEL_CATALOG_PUBLIC_URL),
      environment({
        ...object,
        arrayBuffer: async () => {
          throw new Error("synthetic body failure");
        },
      }),
    );

    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("300");
    expect(interrupted.status).toBe(503);
    expect(interrupted.headers.get("retry-after")).toBe("300");
  });

  it("returns an explicit 404 from the API-host fallback", () => {
    const response = handleModelCatalogApiFallbackRequest();

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("model catalog Worker deployment", () => {
  it("uses a path Route over a same-host 404 Custom Domain in each environment", () => {
    const service = readFileSync(join(repositoryRoot, "tools/model-catalog.wrangler.toml"), "utf8");
    const fallback = readFileSync(
      join(repositoryRoot, "tools/model-catalog-api-fallback.wrangler.toml"),
      "utf8",
    );

    expect(service).toContain('pattern = "https://api.enduragent.icu/models/v1/*"');
    expect(service).toContain('pattern = "https://api-staging.enduragent.icu/models/v1/*"');
    expect(service).toContain('bucket_name = "enduragent-model-catalog"');
    expect(service).toContain('bucket_name = "enduragent-model-catalog-staging"');
    expect(fallback).toContain('pattern = "api.enduragent.icu"');
    expect(fallback).toContain('pattern = "api-staging.enduragent.icu"');
    expect(fallback.match(/custom_domain = true/gu)).toHaveLength(2);
    expect(`${service}\n${fallback}`).not.toContain("updates.enduragent.icu");
    expect(`${service}\n${fallback}`).not.toContain("ping.enduragent.icu");
  });

  it("keeps deployment manual and protects staging and production separately", () => {
    const workflow = readFileSync(
      join(repositoryRoot, ".github/workflows/model-catalog-api.yml"),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("push:");
    expect(workflow).toContain("environment: model-catalog-${{ inputs.target }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('pnpm models:verify-service "$origin"');
  });

  it("bundles only the Worker, the shared contract, and edge-safe dependencies", async () => {
    const result = await build({
      absWorkingDir: repositoryRoot,
      bundle: true,
      entryPoints: ["tools/model-catalog.worker.ts"],
      format: "esm",
      metafile: true,
      platform: "browser",
      plugins: [
        {
          name: "workspace-contract",
          setup(buildContext) {
            buildContext.onResolve(
              { filter: /^@enduragent\/coach-contract\/model-catalog$/ },
              () => ({
                path: join(repositoryRoot, "packages/coach-contract/src/model-catalog.ts"),
              }),
            );
          },
        },
      ],
      write: false,
    });
    const inputs = Object.keys(result.metafile.inputs);
    const output = result.outputFiles.map((file) => file.text).join("\n");

    expect(
      inputs.some((path) => path.endsWith("packages/coach-contract/src/model-catalog.ts")),
    ).toBe(true);
    expect(inputs.some((path) => path.includes("packages/core/"))).toBe(false);
    expect(inputs.some((path) => path.includes("packages/engine/"))).toBe(false);
    expect(inputs.some((path) => path.includes("node_modules/@aws-sdk/"))).toBe(false);
    expect(output).not.toMatch(/from\s+["']node:/u);
  });
});
