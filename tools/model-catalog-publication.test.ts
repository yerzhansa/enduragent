import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { describe, expect, it } from "vitest";
import { ModelCatalogArchive } from "./model-catalog-archive.js";
import {
  WranglerCommandError,
  WranglerModelCatalogCloudflare,
  deployModelCatalogAssets,
  modelCatalogDeploymentMessage,
  modelCatalogDeploymentTag,
  type ModelCatalogCloudflareBoundary,
  type ModelCatalogTargetState,
  type WranglerCommandRunner,
} from "./model-catalog-cloudflare.js";
import {
  runModelCatalogCommand,
  type ModelCatalogCommandDependencies,
} from "./model-catalog-command.js";
import {
  MODEL_CATALOG_EDGE_MAX_AGE_SECONDS,
  MODEL_CATALOG_PUBLIC_PATH,
  MODEL_CATALOG_WRANGLER_VERSION,
} from "./model-catalog-constants.js";
import { bytesEqual, jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  CatalogPublicationError,
  buildModelCatalogPublicationRecord,
  buildModelCatalogRollbackRecord,
  modelCatalogBytes,
  validateModelCatalogPublicationFile,
  type ModelCatalogPublicationFile,
  type ModelCatalogPublicationRecord,
  type ModelCatalogTarget,
} from "./model-catalog-publication.js";
import {
  MODEL_CATALOG_ASSET_FILES,
  materializeModelCatalogAssets,
  modelCatalogAssetInventory,
  modelCatalogHeadersBytes,
} from "./model-catalog-static-assets.js";
import {
  verifyModelCatalogService,
  type ModelCatalogFetch,
} from "./verify-model-catalog-service.js";

const VERIFIED_AT = "1998-09-14T08:00:00.000Z";
const PUBLISHED_AT = Date.parse("1998-09-14T09:00:00.000Z");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function publicationFile(modelId = "synthetic-text-tool-image"): ModelCatalogPublicationFile {
  return {
    catalog: {
      schemaVersion: 1,
      providers: [
        {
          providerId: "openai",
          label: "Synthetic provider",
          order: 0,
          recommendedModelId: modelId,
          models: [
            {
              modelId,
              label: "Synthetic model",
              order: 0,
              compatibilityProfile: "openai-ai-sdk-v1",
              contextWindow: { kind: "known", tokens: 100_000 },
              imageInput: "supported",
              pricing: {
                kind: "token-rates",
                inputUsdPerMillion: 1,
                outputUsdPerMillion: 2,
                cacheReadUsdPerMillion: 0.5,
                cacheWriteUsdPerMillion: 1.5,
              },
            },
          ],
        },
      ],
    },
    evidence: [
      {
        providerId: "openai",
        modelId,
        connections: [
          {
            connectionId: "api-key",
            textCall: { verifiedAt: VERIFIED_AT, reference: "record:text-call" },
            toolCall: { verifiedAt: VERIFIED_AT, reference: "record:tool-call" },
            imageCall: { verifiedAt: VERIFIED_AT, reference: "record:image-call" },
          },
        ],
        limitsSource: "https://example.com/models/synthetic/limits",
        pricingSource: "https://example.com/models/synthetic/pricing",
      },
    ],
  };
}

async function record(
  revision: number,
  previousRevision: number,
  modelId: string,
): Promise<ModelCatalogPublicationRecord> {
  return buildModelCatalogPublicationRecord({
    publicationFile: publicationFile(modelId),
    revision,
    previousRevision,
    now: PUBLISHED_AT + revision * 1_000,
  });
}

async function withTemporaryDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "model-catalog-test-"));
  try {
    return await action(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function copyState(state: ModelCatalogTargetState): ModelCatalogTargetState {
  if (state.kind === "absent") return { ...state };
  return { ...state, catalogBytes: state.catalogBytes.slice() };
}

function targetConfig(target: ModelCatalogTarget): {
  readonly origin: string;
  readonly workerName: string;
} {
  return target === "staging"
    ? {
        origin: "https://api-staging.enduragent.icu",
        workerName: "enduragent-model-catalog-staging",
      }
    : { origin: "https://api.enduragent.icu", workerName: "enduragent-model-catalog" };
}

async function publishedState(
  target: ModelCatalogTarget,
  value: ModelCatalogPublicationRecord,
  identity = `${target}-${value.revision}`,
): Promise<ModelCatalogTargetState> {
  return {
    kind: "published",
    target,
    ...targetConfig(target),
    revision: value.revision,
    catalogDigest: value.catalogDigest,
    catalogBytes: modelCatalogBytes(value),
    etag: `"etag-${identity}"`,
    tag: modelCatalogDeploymentTag(value.revision, value.catalogDigest),
    versionId: `version-${identity}`,
    deploymentId: `deployment-${identity}`,
  };
}

type FakeFailure =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "before" }>
  | Readonly<{ kind: "after" }>
  | Readonly<{ kind: "different"; state: ModelCatalogTargetState }>;

class FakeCloudflareBoundary implements ModelCatalogCloudflareBoundary {
  readonly deploys: Array<{
    readonly target: ModelCatalogTarget;
    readonly bytes: Uint8Array;
    readonly tag: string;
    readonly message: string;
  }> = [];
  deployAttempts = 0;
  verifyFailures = 0;
  failure: FakeFailure = { kind: "none" };
  private deploymentCount = 0;

  constructor(
    readonly states: Record<ModelCatalogTarget, ModelCatalogTargetState> = {
      staging: { kind: "absent", target: "staging", ...targetConfig("staging") },
      production: { kind: "absent", target: "production", ...targetConfig("production") },
    },
  ) {}

  async inspect(target: ModelCatalogTarget): Promise<ModelCatalogTargetState> {
    return copyState(this.states[target]);
  }

  async deploy(input: {
    readonly target: ModelCatalogTarget;
    readonly assetDirectory: string;
    readonly tag: string;
    readonly message: string;
  }): Promise<void> {
    this.deployAttempts += 1;
    const bytes = readFileSync(join(input.assetDirectory, "models/v1/catalog.json"));
    const failure = this.failure;
    this.failure = { kind: "none" };
    if (failure.kind === "before") throw new Error("uncertain before deployment");
    if (failure.kind === "different") {
      this.states[input.target] = copyState(failure.state);
      throw new Error("different deployment won");
    }
    const catalog = ModelCatalogSnapshotSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    const digest = await sha256(bytes);
    this.deploymentCount += 1;
    const identity = `${input.target}-${this.deploymentCount}`;
    this.states[input.target] = {
      kind: "published",
      target: input.target,
      ...targetConfig(input.target),
      revision: catalog.revision,
      catalogDigest: digest.hex,
      catalogBytes: bytes.slice(),
      etag: `"etag-${identity}"`,
      tag: input.tag,
      versionId: `version-${identity}`,
      deploymentId: `deployment-${identity}`,
    };
    this.deploys.push({
      target: input.target,
      bytes: bytes.slice(),
      tag: input.tag,
      message: input.message,
    });
    if (failure.kind === "after") throw new Error("uncertain after deployment");
  }

  async verify(input: {
    readonly target: ModelCatalogTarget;
    readonly catalogBytes: Uint8Array;
    readonly revision: number;
    readonly digest: string;
  }): Promise<{ readonly etag: string }> {
    if (this.verifyFailures > 0) {
      this.verifyFailures -= 1;
      throw new CatalogPublicationError("integrity", "synthetic verification failure");
    }
    const state = this.states[input.target];
    if (
      state.kind !== "published" ||
      state.revision !== input.revision ||
      state.catalogDigest !== input.digest ||
      !bytesEqual(state.catalogBytes, input.catalogBytes)
    ) {
      throw new CatalogPublicationError("conflict", "fake verification mismatch");
    }
    return { etag: state.etag };
  }

  async waitForPropagation(): Promise<void> {}
}

async function materializedRecord(
  directory: string,
  value: ModelCatalogPublicationRecord,
): Promise<string> {
  const assetDirectory = join(directory, "assets");
  const bytes = modelCatalogBytes(value);
  await materializeModelCatalogAssets({
    directory: assetDirectory,
    catalogBytes: bytes,
    contentDigest: (await sha256(bytes)).contentDigest,
  });
  return assetDirectory;
}

describe("model catalog publication records", () => {
  it("preserves evidence validation and creates deterministic exact records", async () => {
    await expect(
      validateModelCatalogPublicationFile(publicationFile(), PUBLISHED_AT),
    ).resolves.toEqual(publicationFile());
    const invalid = publicationFile();
    invalid.evidence[0].connections[0].imageCall = undefined;
    await expect(validateModelCatalogPublicationFile(invalid, PUBLISHED_AT)).rejects.toThrow(
      "advertised image input requires evidence",
    );
    const first = await record(4, 3, "same-model");
    const second = await record(4, 3, "same-model");
    expect(jsonBytes(first)).toEqual(jsonBytes(second));
    expect((await sha256(modelCatalogBytes(first))).hex).toBe(first.catalogDigest);
    expect(JSON.stringify(first)).toContain("record:text-call");
  });

  it("builds rollback content and evidence under a higher revision", async () => {
    const source = await record(2, 1, "old-model");
    const rollback = await buildModelCatalogRollbackRecord({
      source,
      revision: 8,
      previousRevision: 7,
      now: PUBLISHED_AT + 8_000,
    });
    expect(rollback.action).toEqual({ kind: "rollback", sourceRevision: 2 });
    expect(rollback.catalog.revision).toBe(8);
    expect(rollback.catalog.providers).toEqual(source.catalog.providers);
    expect(rollback.evidence).toEqual(source.evidence);
  });
});

describe("private model catalog archive", () => {
  it("keeps publication records and receipts immutable", async () => {
    await withTemporaryDirectory(async (directory) => {
      const archive = new ModelCatalogArchive(join(directory, "private-archive"));
      const first = await record(1, 0, "first-model");
      const different = await record(1, 0, "different-model");
      await archive.withExclusiveLock(async (locked) => {
        await locked.writePublicationRecord(first);
        await locked.writePublicationRecord(first);
        await expect(locked.writePublicationRecord(different)).rejects.toThrow("different bytes");
        expect(await locked.readPublicationRecord(1)).toEqual(first);
      });
    });
  });

  it("rejects a second archive-wide writer while the lock is held", async () => {
    await withTemporaryDirectory(async (directory) => {
      const archive = new ModelCatalogArchive(join(directory, "private-archive"));
      let release = (): void => {};
      let acquired = (): void => {};
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      const ready = new Promise<void>((resolveReady) => {
        acquired = resolveReady;
      });
      const first = archive.withExclusiveLock(async () => {
        acquired();
        await held;
      });
      await ready;
      await expect(archive.withExclusiveLock(async () => undefined)).rejects.toThrow(
        "archive is locked",
      );
      release();
      await first;
    });
  });
});

describe("static model catalog assets", () => {
  it("materializes only the exact catalog and header files", async () => {
    await withTemporaryDirectory(async (directory) => {
      const value = await record(3, 2, "asset-model");
      const assetDirectory = await materializedRecord(directory, value);
      const bytes = modelCatalogBytes(value);
      const digest = await sha256(bytes);
      expect(await modelCatalogAssetInventory(assetDirectory)).toEqual(MODEL_CATALOG_ASSET_FILES);
      expect(bytesEqual(readFileSync(join(assetDirectory, "models/v1/catalog.json")), bytes)).toBe(
        true,
      );
      expect(
        bytesEqual(
          readFileSync(join(assetDirectory, "_headers")),
          modelCatalogHeadersBytes(digest.contentDigest),
        ),
      ).toBe(true);
    });
  });

  it("configures two assets-only Custom Domains without a request-time Worker", () => {
    const config = readFileSync(join(repositoryRoot, "tools/model-catalog.wrangler.toml"), "utf8");
    expect(config).toContain('pattern = "api-staging.enduragent.icu"');
    expect(config).toContain('pattern = "api.enduragent.icu"');
    expect(config.match(/custom_domain = true/gu)).toHaveLength(2);
    expect(config.match(/run_worker_first = false/gu)).toHaveLength(2);
    expect(config.match(/html_handling = "none"/gu)).toHaveLength(2);
    expect(config.match(/not_found_handling = "none"/gu)).toHaveLength(2);
    expect(config).not.toMatch(/\bmain\s*=|binding\s*=|r2_buckets|fallback/gu);
    expect(existsSync(join(repositoryRoot, "tools/model-catalog.worker.ts"))).toBe(false);
    expect(existsSync(join(repositoryRoot, ".github/workflows/model-catalog-api.yml"))).toBe(false);
    expect(MODEL_CATALOG_WRANGLER_VERSION).toMatch(/^4\.\d+\.\d+$/u);
  });
});

describe("Cloudflare deployment reconciliation", () => {
  it("treats only Cloudflare's missing-Worker response as an absent bootstrap target", async () => {
    let fetched = false;
    const runner: WranglerCommandRunner = {
      run: async () => {
        throw new WranglerCommandError(1, "This Worker does not exist [code: 10007]");
      },
    };
    const boundary = new WranglerModelCatalogCloudflare(runner, async () => {
      fetched = true;
      throw new Error("fetch should not run");
    });
    await expect(boundary.inspect("staging")).resolves.toMatchObject({
      kind: "absent",
      target: "staging",
    });
    expect(fetched).toBe(false);
  });

  it.each([
    { failure: "before", recovery: "retried-after-unchanged-predecessor", calls: 2 },
    { failure: "after", recovery: "verified-after-uncertain-response", calls: 1 },
  ] as const)("reconciles an uncertain $failure response", async ({ failure, recovery, calls }) => {
    await withTemporaryDirectory(async (directory) => {
      const predecessor = await record(1, 0, "predecessor");
      const intended = await record(2, 1, "intended");
      const boundary = new FakeCloudflareBoundary({
        staging: await publishedState("staging", predecessor),
        production: { kind: "absent", target: "production", ...targetConfig("production") },
      });
      boundary.failure = { kind: failure };
      const receipt = await deployModelCatalogAssets({
        boundary,
        target: "staging",
        assetDirectory: await materializedRecord(directory, intended),
        predecessor: await publishedState("staging", predecessor),
        record: intended,
        now: PUBLISHED_AT,
      });
      expect(receipt.uncertaintyRecovery).toBe(recovery);
      expect(boundary.deployAttempts).toBe(calls);
      expect(receipt.tag).toBe(modelCatalogDeploymentTag(2, intended.catalogDigest));
      expect(receipt.message).toBe(modelCatalogDeploymentMessage(2, intended.catalogDigest));
    });
  });

  it("stops when an uncertain deployment reveals a different state", async () => {
    await withTemporaryDirectory(async (directory) => {
      const predecessor = await record(1, 0, "predecessor");
      const intended = await record(2, 1, "intended");
      const different = await record(2, 1, "different");
      const predecessorState = await publishedState("staging", predecessor);
      const boundary = new FakeCloudflareBoundary({
        staging: predecessorState,
        production: { kind: "absent", target: "production", ...targetConfig("production") },
      });
      boundary.failure = { kind: "different", state: await publishedState("staging", different) };
      await expect(
        deployModelCatalogAssets({
          boundary,
          target: "staging",
          assetDirectory: await materializedRecord(directory, intended),
          predecessor: predecessorState,
          record: intended,
          now: PUBLISHED_AT,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });
});

describe("model catalog commands", () => {
  it("reconciles an intended staging deployment after verification interrupted publication", async () => {
    await withTemporaryDirectory(async (directory) => {
      const archivePath = join(directory, "private-archive");
      const publicationPath = join(directory, "publication.json");
      writeFileSync(publicationPath, jsonBytes(publicationFile("recovered-model")));
      const boundary = new FakeCloudflareBoundary();
      boundary.verifyFailures = 1;
      const dependencies: ModelCatalogCommandDependencies = {
        now: () => PUBLISHED_AT,
        output: () => undefined,
        boundary,
        createArchive: (path) => new ModelCatalogArchive(path),
        createAssetDirectory: () => mkdtempSync(join(directory, "assets-")),
        removeAssetDirectory: (path) => rmSync(path, { force: true, recursive: true }),
      };
      const args = [
        "publish-to-staging",
        publicationPath,
        "--expect-revision",
        "0",
        "--archive",
        archivePath,
      ];
      await expect(runModelCatalogCommand(args, dependencies)).rejects.toThrow(
        "synthetic verification failure",
      );
      await expect(runModelCatalogCommand(args, dependencies)).resolves.toBeUndefined();
      await expect(runModelCatalogCommand(args, dependencies)).resolves.toBeUndefined();
      expect(boundary.deployAttempts).toBe(1);
      await new ModelCatalogArchive(archivePath).withExclusiveLock(async (locked) => {
        expect(await locked.readDeploymentReceipt("staging", 1)).toMatchObject({
          revision: 1,
          uncertaintyRecovery: "reconciled-existing-intended-deployment",
        });
      });
    });
  });

  it("uses the global predecessor, promotes archived staged bytes, and rolls back higher", async () => {
    await withTemporaryDirectory(async (directory) => {
      const archivePath = join(directory, "private-archive");
      const publicationPath = join(directory, "publication.json");
      writeFileSync(publicationPath, jsonBytes(publicationFile("new-model")));
      const source = await record(1, 0, "old-model");
      const staging = await record(3, 2, "staging-model");
      const production = await record(5, 4, "production-model");
      const archive = new ModelCatalogArchive(archivePath);
      await archive.withExclusiveLock((locked) => locked.writePublicationRecord(source));
      const boundary = new FakeCloudflareBoundary({
        staging: await publishedState("staging", staging),
        production: await publishedState("production", production),
      });
      const output: string[] = [];
      const dependencies: ModelCatalogCommandDependencies = {
        now: () => PUBLISHED_AT + 10_000,
        output: (line) => output.push(line),
        boundary,
        createArchive: (path) => new ModelCatalogArchive(path),
        createAssetDirectory: () => mkdtempSync(join(directory, "assets-")),
        removeAssetDirectory: (path) => rmSync(path, { force: true, recursive: true }),
      };
      await expect(
        runModelCatalogCommand(
          [
            "publish-to-staging",
            publicationPath,
            "--expect-revision",
            "3",
            "--archive",
            archivePath,
          ],
          dependencies,
        ),
      ).rejects.toThrow("expected global revision 3, found 5");
      await runModelCatalogCommand(
        ["publish-to-staging", publicationPath, "--expect-revision", "5", "--archive", archivePath],
        dependencies,
      );
      let revisionSix: ModelCatalogPublicationRecord | undefined;
      await archive.withExclusiveLock(async (locked) => {
        revisionSix = await locked.readPublicationRecord(6);
        const receipt = await locked.readDeploymentReceipt("staging", 6);
        expect(receipt.catalogDigest).toBe(revisionSix.catalogDigest);
      });
      if (revisionSix === undefined) throw new Error("revision six was not archived");
      const stagedRevisionSix = copyState(boundary.states.staging);
      boundary.states.staging = await publishedState(
        "staging",
        await record(6, 5, "different-staged-model"),
      );
      await expect(
        runModelCatalogCommand(
          [
            "promote-existing-staged-revision-to-production",
            "6",
            "--expect-revision",
            "5",
            "--archive",
            archivePath,
          ],
          dependencies,
        ),
      ).rejects.toThrow("staging no longer serves the archived deployment receipt");
      boundary.states.staging = stagedRevisionSix;
      await runModelCatalogCommand(
        [
          "promote-existing-staged-revision-to-production",
          "6",
          "--expect-revision",
          "5",
          "--archive",
          archivePath,
        ],
        dependencies,
      );
      const productionDeploy = boundary.deploys.find(
        (deployment) => deployment.target === "production",
      );
      expect(
        productionDeploy !== undefined &&
          bytesEqual(productionDeploy.bytes, modelCatalogBytes(revisionSix)),
      ).toBe(true);
      await runModelCatalogCommand(
        ["rollback-to-staging", "1", "--expect-revision", "6", "--archive", archivePath],
        dependencies,
      );
      await archive.withExclusiveLock(async (locked) => {
        const rollback = await locked.readPublicationRecord(7);
        expect(rollback.action).toEqual({ kind: "rollback", sourceRevision: 1 });
        expect(rollback.catalog.providers).toEqual(source.catalog.providers);
        expect(await locked.readDeploymentReceipt("staging", 7)).toMatchObject({ revision: 7 });
      });
      expect(output.some((line) => line.includes('"target":"production"'))).toBe(true);
    });
  });
});

function verifierFetch(
  expected: Uint8Array,
  digest: string,
): {
  readonly fetcher: ModelCatalogFetch;
  readonly methods: string[];
} {
  const methods: string[] = [];
  const etag = '"synthetic-etag"';
  const cacheControl = `public, max-age=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, s-maxage=${MODEL_CATALOG_EDGE_MAX_AGE_SECONDS}, no-transform`;
  const headers = {
    "Cache-Control": cacheControl,
    "Content-Digest": digest,
    "Content-Length": String(expected.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  return {
    methods,
    fetcher: async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? input.toString());
      const method = init?.method ?? request?.method ?? "GET";
      const requestHeaders = new Headers(init?.headers ?? request?.headers);
      methods.push(`${method} ${url.pathname}`);
      expect(init?.redirect).toBe("error");
      expect(requestHeaders.get("accept-encoding")).toBe("identity");
      if (url.pathname !== MODEL_CATALOG_PUBLIC_PATH) return new Response(null, { status: 404 });
      if (method === "HEAD") return new Response(null, { status: 200, headers });
      if (requestHeaders.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return new Response(expected.slice(), { status: 200, headers });
    },
  };
}

describe("public model catalog verifier", () => {
  it("checks archived bytes, identity GET, HEAD, 304, and unrelated 404s without POST", async () => {
    const value = await record(9, 8, "verified-model");
    const bytes = modelCatalogBytes(value);
    const digest = await sha256(bytes);
    const fake = verifierFetch(bytes, digest.contentDigest);
    await expect(
      verifyModelCatalogService({
        origin: "https://api-staging.enduragent.icu",
        expectedCatalogBytes: bytes,
        expectedRevision: 9,
        expectedDigest: digest.hex,
        fetcher: fake.fetcher,
      }),
    ).resolves.toMatchObject({ revision: 9, catalogDigest: digest.hex });
    expect(fake.methods).toEqual([
      "GET /models/v1/catalog.json",
      "HEAD /models/v1/catalog.json",
      "GET /models/v1/catalog.json",
      "GET /models/v1/not-catalog.json",
      "GET /not-a-service",
    ]);
    expect(fake.methods.some((entry) => entry.startsWith("POST"))).toBe(false);
  });

  it("rejects a byte mismatch even when the public JSON is valid", async () => {
    const expectedRecord = await record(9, 8, "expected-model");
    const servedRecord = await record(9, 8, "served-model");
    const expected = modelCatalogBytes(expectedRecord);
    const served = modelCatalogBytes(servedRecord);
    const expectedDigest = await sha256(expected);
    const servedDigest = await sha256(served);
    const fake = verifierFetch(served, servedDigest.contentDigest);
    await expect(
      verifyModelCatalogService({
        origin: "https://api-staging.enduragent.icu",
        expectedCatalogBytes: expected,
        expectedRevision: 9,
        expectedDigest: expectedDigest.hex,
        fetcher: fake.fetcher,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
