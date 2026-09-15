import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  modelCatalogDeploymentMessage,
  modelCatalogDeploymentTag,
} from "./model-catalog-cloudflare.js";
import {
  MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
  MODEL_CATALOG_PUBLIC_URL,
} from "./model-catalog-constants.js";
import {
  ModelCatalogDeploymentReceiptSchema,
  buildModelCatalogPublicationRecord,
  type ModelCatalogPublicationFile,
} from "./model-catalog-publication.js";
import {
  CatalogDigestSchema,
  CatalogReleasePinError,
  PublishedSnapshotSchema,
  prepareReleaseGroup,
  readReleaseGroup,
  retainProductionCatalog,
  type ModelCatalogProductionFetch,
  type ModelCatalogProductionFetchResult,
  type PrepareReleaseGroupInput,
  type PreparedRelease,
  type ReleasePinStore,
} from "./model-catalog-release-pin.js";
import {
  createGitHubReleasePinStore,
  type GitHubReleasePinStoreInput,
} from "./model-catalog-release-pin-github.js";

const REPOSITORY = "yerzhansa/enduragent" as const;
const TOKEN = "fixture-github-token";
const SOURCE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACQUIRED_AT = "1998-09-14T10:00:00.000Z";
const LATER_ACQUIRED_AT = "1998-09-14T12:00:00.000Z";

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: unknown[] = value;
  return items.filter((item): item is string => typeof item === "string");
}
const SEED_ESTABLISHED_AT = "1998-01-01T00:00:00.000Z";
const VERIFIED_AT = "1998-09-14T08:00:00.000Z";
const PUBLISHED_AT_MS = Date.parse("1998-09-14T09:00:00.000Z");
const COMMITTER = Object.freeze({
  name: "Enduragent Release",
  email: "release@enduragent.example",
  date: ACQUIRED_AT,
});
const ADAPTER_SOURCE = readFileSync(
  fileURLToPath(new URL("./model-catalog-release-pin-github.ts", import.meta.url)),
  "utf8",
);
const API_PREFIX = `https://api.github.com/repos/${REPOSITORY}/`;

type GitIdentity = { name: string; email: string; date: string };
type FakeBlob = Uint8Array;
type FakeTreeEntry = { path: string; mode: string; type: string; sha: string };
type FakeCommit = {
  tree: string;
  message: string;
  parents: string[];
  author: GitIdentity;
  committer: GitIdentity;
};
type FakeTag = {
  tag: string;
  message: string;
  object: { type: string; sha: string };
};
type FakeRequest = {
  method: string;
  path: string;
  status: number;
  body: unknown;
};

type FakeGitData = {
  fetch: typeof fetch;
  refs: Map<string, string>;
  tags: Map<string, FakeTag>;
  commits: Map<string, FakeCommit>;
  trees: Map<string, FakeTreeEntry[]>;
  blobs: Map<string, FakeBlob>;
  requests: FakeRequest[];
  seedBytesTag(digest: string, bytes: Uint8Array): void;
};

function publicationFile(modelId: string): ModelCatalogPublicationFile {
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

function seedSnapshot(modelId = "synthetic-seed") {
  return {
    schemaVersion: 1 as const,
    revision: 1,
    provenance: { kind: "bundled-seed" as const, establishedAt: SEED_ESTABLISHED_AT },
    providers: publicationFile(modelId).catalog.providers,
  };
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  return (await sha256(bytes)).hex;
}

async function publishedFixture(revision: number, modelId: string) {
  const record = await buildModelCatalogPublicationRecord({
    publicationFile: publicationFile(modelId),
    revision,
    previousRevision: revision - 1,
    now: PUBLISHED_AT_MS + revision * 1_000,
  });
  const bytes = jsonBytes(record.catalog);
  const etag = `"etag-production-${revision}"`;
  const receipt = ModelCatalogDeploymentReceiptSchema.parse({
    formatVersion: MODEL_CATALOG_PUBLICATION_FORMAT_VERSION,
    target: "production",
    revision: record.revision,
    catalogDigest: record.catalogDigest,
    workerName: "enduragent-model-catalog",
    versionId: `version-${revision}`,
    deploymentId: `deployment-${revision}`,
    liveEtag: etag,
    verifiedAt: "1998-09-14T08:30:00.000Z",
    tag: modelCatalogDeploymentTag(record.revision, record.catalogDigest),
    message: modelCatalogDeploymentMessage(record.revision, record.catalogDigest),
    uncertaintyRecovery: "none",
  });
  return { record, receipt, snapshot: record.catalog, bytes, etag, digest: record.catalogDigest };
}

function trackingFetch(
  result:
    | ModelCatalogProductionFetchResult
    | (() => ModelCatalogProductionFetchResult | Promise<ModelCatalogProductionFetchResult>),
) {
  const urls: string[] = [];
  const fetch: ModelCatalogProductionFetch = async (url) => {
    urls.push(url);
    return typeof result === "function" ? await result() : result;
  };
  return { fetch, urls };
}

function unavailableFetch() {
  return trackingFetch({ kind: "unavailable" });
}

function prepareInput(input: {
  readonly store: ReleasePinStore;
  readonly fetch: ModelCatalogProductionFetch;
  readonly sourceCommit?: string;
  readonly acquisitionTime?: string;
  readonly seed?: unknown;
}): PrepareReleaseGroupInput {
  return {
    sourceCommit: input.sourceCommit ?? SOURCE_COMMIT,
    store: input.store,
    fetch: input.fetch,
    acquisitionTime: input.acquisitionTime ?? ACQUIRED_AT,
    seed: input.seed ?? seedSnapshot(),
  };
}

function requirePublished(prepared: PreparedRelease) {
  expect(prepared.record.kind).toBe("published");
  if (prepared.record.kind !== "published") {
    throw new Error("expected published pin");
  }
  return {
    record: prepared.record,
    snapshot: PublishedSnapshotSchema.parse(prepared.snapshot),
    bytes: prepared.bytes,
    binding: prepared.binding,
  };
}

function hrefOf(url: RequestInfo | URL): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

function wrapBase64(value: string): string {
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += 60) {
    lines.push(value.slice(offset, offset + 60));
  }
  return `${lines.join("\n")}\n`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFakeGitData(token = TOKEN): FakeGitData {
  const refs = new Map<string, string>();
  const tags = new Map<string, FakeTag>();
  const commits = new Map<string, FakeCommit>();
  const trees = new Map<string, FakeTreeEntry[]>();
  const blobs = new Map<string, FakeBlob>();
  const requests: FakeRequest[] = [];
  let next = 1;

  function nextSha(): string {
    const sha = next.toString(16).padStart(40, "0");
    next += 1;
    return sha;
  }

  function record(method: string, path: string, status: number, body: unknown): void {
    requests.push({ method, path, status, body });
  }

  function seedBytesTag(digest: string, bytes: Uint8Array): void {
    const blobSha = nextSha();
    blobs.set(blobSha, bytes.slice());
    const treeSha = nextSha();
    trees.set(treeSha, [{ path: "bytes", mode: "100644", type: "blob", sha: blobSha }]);
    const commitSha = nextSha();
    commits.set(commitSha, {
      tree: treeSha,
      message: digest,
      parents: [],
      author: COMMITTER,
      committer: COMMITTER,
    });
    const tagSha = nextSha();
    const tagName = `catalog-pin/bytes/${digest}`;
    tags.set(tagSha, {
      tag: tagName,
      message: digest,
      object: { type: "commit", sha: commitSha },
    });
    refs.set(`refs/tags/${tagName}`, tagSha);
  }

  const fetchImpl: typeof fetch = async (url, init) => {
    const href = hrefOf(url);
    if (!href.startsWith(API_PREFIX)) {
      record("UNKNOWN", href, 404, undefined);
      return jsonResponse(404, { message: "Not Found" });
    }
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(href.slice(API_PREFIX.length));
    const headers = new Headers(init?.headers);
    const body =
      init?.body === undefined || typeof init.body !== "string" ? undefined : JSON.parse(init.body);
    if (
      headers.get("Authorization") !== `Bearer ${token}` ||
      headers.get("Accept") !== "application/vnd.github+json" ||
      headers.get("X-GitHub-Api-Version") !== "2022-11-28"
    ) {
      record(method, path, 401, body);
      return jsonResponse(401, { message: "Unauthorized" });
    }

    if (method === "GET" && path.startsWith("git/ref/tags/")) {
      const name = path.slice("git/ref/tags/".length);
      const sha = refs.get(`refs/tags/${name}`);
      if (sha === undefined) {
        record(method, path, 404, body);
        return jsonResponse(404, { message: "Not Found" });
      }
      record(method, path, 200, body);
      return jsonResponse(200, {
        ref: `refs/tags/${name}`,
        node_id: "ref-node",
        url: `${API_PREFIX}git/ref/tags/${name}`,
        object: { type: "tag", sha, url: `${API_PREFIX}git/tags/${sha}` },
      });
    }

    if (method === "GET" && path === "git/matching-refs/tags/catalog-pin/retained/") {
      const matches = [...refs.entries()]
        .filter(([ref]) => ref.startsWith("refs/tags/catalog-pin/retained/"))
        .map(([ref, sha]) => ({
          ref,
          node_id: "ref-node",
          object: { type: "tag", sha, url: `${API_PREFIX}git/tags/${sha}` },
        }));
      record(method, path, 200, body);
      return jsonResponse(200, matches);
    }

    if (method === "GET" && path.startsWith("git/tags/")) {
      const sha = path.slice("git/tags/".length);
      const tag = tags.get(sha);
      if (tag === undefined) {
        record(method, path, 404, body);
        return jsonResponse(404, { message: "Not Found" });
      }
      record(method, path, 200, body);
      return jsonResponse(200, {
        sha,
        node_id: "tag-node",
        tag: tag.tag,
        message: tag.message,
        object: { type: tag.object.type, sha: tag.object.sha },
        tagger: COMMITTER,
      });
    }

    if (method === "GET" && path.startsWith("git/commits/")) {
      const sha = path.slice("git/commits/".length);
      const commit = commits.get(sha);
      if (commit === undefined) {
        record(method, path, 404, body);
        return jsonResponse(404, { message: "Not Found" });
      }
      record(method, path, 200, body);
      return jsonResponse(200, {
        sha,
        node_id: "commit-node",
        tree: { sha: commit.tree },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        message: commit.message,
        author: commit.author,
        committer: commit.committer,
      });
    }

    if (method === "GET" && path.startsWith("git/trees/")) {
      const sha = path.slice("git/trees/".length);
      const tree = trees.get(sha);
      if (tree === undefined) {
        record(method, path, 404, body);
        return jsonResponse(404, { message: "Not Found" });
      }
      record(method, path, 200, body);
      return jsonResponse(200, { sha, node_id: "tree-node", truncated: false, tree });
    }

    if (method === "GET" && path.startsWith("git/blobs/")) {
      const sha = path.slice("git/blobs/".length);
      const bytes = blobs.get(sha);
      if (bytes === undefined) {
        record(method, path, 404, body);
        return jsonResponse(404, { message: "Not Found" });
      }
      record(method, path, 200, body);
      return jsonResponse(200, {
        sha,
        node_id: "blob-node",
        encoding: "base64",
        size: bytes.byteLength,
        content: wrapBase64(Buffer.from(bytes).toString("base64")),
      });
    }

    if (method === "POST" && path === "git/blobs") {
      if (
        body === null ||
        typeof body !== "object" ||
        !("content" in body) ||
        !("encoding" in body) ||
        body.encoding !== "base64" ||
        typeof body.content !== "string"
      ) {
        record(method, path, 422, body);
        return jsonResponse(422, { message: "Invalid blob" });
      }
      const sha = nextSha();
      blobs.set(sha, Uint8Array.from(Buffer.from(body.content, "base64")));
      record(method, path, 201, body);
      return jsonResponse(201, { sha, url: `${API_PREFIX}git/blobs/${sha}` });
    }

    if (method === "POST" && path === "git/trees") {
      if (body === null || typeof body !== "object" || !("tree" in body) || !Array.isArray(body.tree)) {
        record(method, path, 422, body);
        return jsonResponse(422, { message: "Invalid tree" });
      }
      const entries: FakeTreeEntry[] = [];
      for (const entry of body.tree) {
        if (
          entry === null ||
          typeof entry !== "object" ||
          typeof entry.path !== "string" ||
          typeof entry.mode !== "string" ||
          typeof entry.type !== "string" ||
          typeof entry.sha !== "string" ||
          !blobs.has(entry.sha)
        ) {
          record(method, path, 422, body);
          return jsonResponse(422, { message: "Invalid tree entry" });
        }
        entries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha });
      }
      const sha = nextSha();
      trees.set(sha, entries);
      record(method, path, 201, body);
      return jsonResponse(201, { sha, tree: entries, truncated: false });
    }

    if (method === "POST" && path === "git/commits") {
      if (
        body === null ||
        typeof body !== "object" ||
        typeof body.message !== "string" ||
        typeof body.tree !== "string" ||
        !trees.has(body.tree) ||
        body.committer === null ||
        typeof body.committer !== "object" ||
        typeof body.committer.name !== "string" ||
        typeof body.committer.email !== "string" ||
        typeof body.committer.date !== "string"
      ) {
        record(method, path, 422, body);
        return jsonResponse(422, { message: "Invalid commit" });
      }
      const author =
        body.author !== null &&
        typeof body.author === "object" &&
        typeof body.author.name === "string" &&
        typeof body.author.email === "string" &&
        typeof body.author.date === "string"
          ? {
              name: body.author.name,
              email: body.author.email,
              date: body.author.date,
            }
          : {
              name: body.committer.name,
              email: body.committer.email,
              date: body.committer.date,
            };
      const sha = nextSha();
      commits.set(sha, {
        tree: body.tree,
        message: body.message,
        parents: stringList(body.parents),
        author,
        committer: {
          name: body.committer.name,
          email: body.committer.email,
          date: body.committer.date,
        },
      });
      record(method, path, 201, body);
      return jsonResponse(201, {
        sha,
        tree: { sha: body.tree },
        message: body.message,
        author,
        committer: {
          name: body.committer.name,
          email: body.committer.email,
          date: body.committer.date,
        },
      });
    }

    if (method === "POST" && path === "git/tags") {
      if (
        body === null ||
        typeof body !== "object" ||
        typeof body.tag !== "string" ||
        typeof body.message !== "string" ||
        typeof body.object !== "string" ||
        body.type !== "commit"
      ) {
        record(method, path, 422, body);
        return jsonResponse(422, { message: "Invalid tag" });
      }
      const sha = nextSha();
      tags.set(sha, {
        tag: body.tag,
        message: body.message,
        object: { type: "commit", sha: body.object },
      });
      record(method, path, 201, body);
      return jsonResponse(201, {
        sha,
        tag: body.tag,
        message: body.message,
        object: { type: "commit", sha: body.object },
        tagger: body.tagger ?? COMMITTER,
      });
    }

    if (method === "POST" && path === "git/refs") {
      if (
        body === null ||
        typeof body !== "object" ||
        typeof body.ref !== "string" ||
        typeof body.sha !== "string"
      ) {
        record(method, path, 422, body);
        return jsonResponse(422, { message: "Invalid ref" });
      }
      if (refs.has(body.ref)) {
        record(method, path, 422, body);
        return jsonResponse(422, { message: "Reference already exists" });
      }
      if (!tags.has(body.sha)) {
        record(method, path, 422, body);
        return jsonResponse(422, { message: "Invalid tag sha" });
      }
      refs.set(body.ref, body.sha);
      record(method, path, 201, body);
      return jsonResponse(201, {
        ref: body.ref,
        object: { type: "tag", sha: body.sha },
      });
    }

    record(method, path, 500, body);
    return jsonResponse(500, { message: `unexpected ${method} ${path}` });
  };

  return {
    fetch: fetchImpl,
    refs,
    tags,
    commits,
    trees,
    blobs,
    requests,
    seedBytesTag,
  };
}

function createStore(fake: FakeGitData): ReleasePinStore {
  return createGitHubReleasePinStore({
    repository: REPOSITORY,
    token: TOKEN,
    fetch: fake.fetch,
    committer: COMMITTER,
  });
}

describe("GitHub model catalog release pin store", () => {
  it("retain then prepare fetches once and readReleaseGroup returns the same digest", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    const fixture = await publishedFixture(2, "synthetic-text-tool-image");
    await retainProductionCatalog({ store, record: fixture.record, receipt: fixture.receipt });
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    const prepared = requirePublished(await prepareReleaseGroup(prepareInput({ store, fetch })));
    const read = await readReleaseGroup({
      sourceCommit: SOURCE_COMMIT,
      store,
      seed: seedSnapshot(),
    });

    expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
    expect(prepared.record.digest).toBe(fixture.digest);
    expect(read.record.digest).toBe(prepared.record.digest);
    expect(read.record).toEqual(prepared.record);
    expect(fake.refs.has(`refs/tags/catalog-pin/group/${SOURCE_COMMIT}`)).toBe(true);
    expect(fake.refs.has("refs/tags/catalog-pin/retained/2")).toBe(true);
    expect(
      [...fake.refs.keys()].some((ref) => ref.startsWith("refs/tags/catalog-pin/bytes/")),
    ).toBe(true);
    expect([...fake.tags.values()].every((tag) => tag.object.type === "commit")).toBe(true);
  });

  it("second prepare on the same SHA does not fetch", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    const fixture = await publishedFixture(2, "synthetic-text-tool-image");
    await retainProductionCatalog({ store, record: fixture.record, receipt: fixture.receipt });
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: fixture.etag,
      bytes: fixture.bytes,
    });
    const first = await prepareReleaseGroup(prepareInput({ store, fetch }));
    const second = await prepareReleaseGroup(
      prepareInput({ store, fetch, acquisitionTime: LATER_ACQUIRED_AT }),
    );

    expect(urls).toHaveLength(1);
    expect(second.record).toEqual(first.record);
    expect(second.record.acquiredAt).toBe(ACQUIRED_AT);
  });

  it("two createGroup races: first POST refs wins, second 422 exists and prepare adopts the winner", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    const fixture = await publishedFixture(2, "synthetic-text-tool-image");
    await retainProductionCatalog({ store, record: fixture.record, receipt: fixture.receipt });
    const urls: string[] = [];
    let started = 0;
    let releaseBoth: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const fetch: ModelCatalogProductionFetch = async (url) => {
      urls.push(url);
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      return { kind: "response", etag: fixture.etag, bytes: fixture.bytes };
    };
    const [left, right] = await Promise.all([
      prepareReleaseGroup(prepareInput({ store, fetch, acquisitionTime: ACQUIRED_AT })),
      prepareReleaseGroup(prepareInput({ store, fetch, acquisitionTime: LATER_ACQUIRED_AT })),
    ]);

    const groupRefPosts = fake.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === "git/refs" &&
        request.body !== null &&
        typeof request.body === "object" &&
        "ref" in request.body &&
        request.body.ref === `refs/tags/catalog-pin/group/${SOURCE_COMMIT}`,
    );
    expect(groupRefPosts.map((request) => request.status).sort()).toEqual([201, 422]);
    expect(left.record.digest).toBe(fixture.digest);
    expect(right.record.digest).toBe(left.record.digest);
    expect(left.record).toEqual(right.record);
    expect(left.record.acquiredAt === ACQUIRED_AT || left.record.acquiredAt === LATER_ACQUIRED_AT).toBe(
      true,
    );
    expect(urls).toHaveLength(2);

    const other = jsonBytes({ kind: "other-group" });
    const joined = await store.createGroup({ releaseGroupId: SOURCE_COMMIT, bytes: other });
    expect(joined.kind).toBe("exists");
    if (joined.kind !== "exists") {
      throw new Error("expected existing group");
    }
    expect(joined.bytes).toEqual(jsonBytes(left.record));
  });

  it("putBytes same digest identical bytes exists; different bytes conflict", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    const bytes = jsonBytes({ n: 1 });
    const digest = CatalogDigestSchema.parse(await digestHex(bytes));
    expect(await store.putBytes({ digest, bytes })).toBe("created");
    expect(await store.putBytes({ digest, bytes })).toBe("exists");
    expect(new Uint8Array((await store.getBytes(digest)) ?? [])).toEqual(bytes);

    const other = jsonBytes({ n: 2 });
    await expect(store.putBytes({ digest, bytes: other })).rejects.toMatchObject({
      name: "CatalogReleasePinError",
      code: "integrity",
    });

    const planted = createFakeGitData();
    const plantedStore = createStore(planted);
    planted.seedBytesTag(digest, other);
    await expect(plantedStore.putBytes({ digest, bytes })).rejects.toMatchObject({
      name: "CatalogReleasePinError",
      code: "conflict",
    });
  });

  it("putRetainedRevision conflict on a different bundle; equal bytes are idempotent", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    const first = await publishedFixture(2, "synthetic-text-tool-image");
    await retainProductionCatalog({ store, record: first.record, receipt: first.receipt });
    await retainProductionCatalog({ store, record: first.record, receipt: first.receipt });
    const retained = await store.getRetainedRevision(2);
    expect(retained?.catalogDigest).toBe(first.digest);

    const second = await publishedFixture(2, "synthetic-conflict");
    await expect(
      retainProductionCatalog({ store, record: second.record, receipt: second.receipt }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "conflict" });
    expect((await store.getRetainedRevision(2))?.catalogDigest).toBe(first.digest);
    expect(fake.refs.has("refs/tags/catalog-pin/retained/2")).toBe(true);
  });

  it("outage fetch uses the highest retained production revision stored in git tags", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    const older = await publishedFixture(2, "synthetic-text-tool-image");
    const newest = await publishedFixture(4, "synthetic-text-tool-image-v4");
    await retainProductionCatalog({ store, record: older.record, receipt: older.receipt });
    await retainProductionCatalog({ store, record: newest.record, receipt: newest.receipt });
    const { fetch, urls } = unavailableFetch();
    const prepared = requirePublished(
      await prepareReleaseGroup(
        prepareInput({ store, fetch, acquisitionTime: LATER_ACQUIRED_AT }),
      ),
    );

    expect(urls).toEqual([MODEL_CATALOG_PUBLIC_URL]);
    expect(prepared.record.acquisition).toBe("retained-production");
    expect(prepared.record.revision).toBe(4);
    expect(prepared.record.digest).toBe(newest.digest);
    expect(prepared.record.digest).not.toBe(older.digest);
    expect(
      fake.requests.some(
        (request) =>
          request.method === "GET" && request.path === "git/matching-refs/tags/catalog-pin/retained/",
      ),
    ).toBe(true);
    expect(fake.refs.has("refs/tags/catalog-pin/retained/2")).toBe(true);
    expect(fake.refs.has("refs/tags/catalog-pin/retained/4")).toBe(true);
  });

  it("missing group read throws not-found", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    await expect(
      readReleaseGroup({ sourceCommit: SOURCE_COMMIT, store, seed: seedSnapshot() }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "not-found" });
  });

  it("corrupt group tag message is unrecoverable for read and prepare, with no fetch replacement", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    await store.createGroup({
      releaseGroupId: SOURCE_COMMIT,
      bytes: new TextEncoder().encode("{not-json"),
    });
    const { fetch, urls } = trackingFetch({
      kind: "response",
      etag: `"etag-production-2"`,
      bytes: jsonBytes({ not: "used" }),
    });
    await expect(
      readReleaseGroup({ sourceCommit: SOURCE_COMMIT, store, seed: seedSnapshot() }),
    ).rejects.toMatchObject({ name: "CatalogReleasePinError", code: "unrecoverable" });
    await expect(prepareReleaseGroup(prepareInput({ store, fetch }))).rejects.toMatchObject({
      name: "CatalogReleasePinError",
      code: "unrecoverable",
    });
    expect(urls).toHaveLength(0);
  });

  it("adapter source has no wall-clock helpers and created commits use the injected committer date", async () => {
    expect(ADAPTER_SOURCE).not.toMatch(/\bDate\.now\b/);
    expect(ADAPTER_SOURCE).not.toMatch(/\bnew Date\(/);
    expect(ADAPTER_SOURCE).not.toMatch(/\bMath\.random\b/);
    expect(ADAPTER_SOURCE).not.toMatch(/npm-release/);

    const fake = createFakeGitData();
    const store = createStore(fake);
    const fixture = await publishedFixture(2, "synthetic-text-tool-image");
    await retainProductionCatalog({ store, record: fixture.record, receipt: fixture.receipt });
    expect(fake.commits.size).toBeGreaterThan(0);
    for (const commit of fake.commits.values()) {
      expect(commit.committer.date).toBe(COMMITTER.date);
      expect(commit.author.date).toBe(COMMITTER.date);
    }
    expect(
      fake.requests
        .filter((request) => request.method === "POST" && request.path === "git/tags")
        .every(
          (request) =>
            request.body !== null &&
            typeof request.body === "object" &&
            "type" in request.body &&
            request.body.type === "commit",
        ),
    ).toBe(true);
  });

  it("public ReleasePinStore and createGitHubReleasePinStore types do not contain git ref strings", () => {
    expectTypeOf<keyof ReleasePinStore>().toEqualTypeOf<
      | "createGroup"
      | "readGroup"
      | "putBytes"
      | "getBytes"
      | "putRetainedRevision"
      | "getRetainedRevision"
      | "listRetainedRevisions"
    >();
    expectTypeOf<keyof GitHubReleasePinStoreInput>().toEqualTypeOf<
      "repository" | "token" | "fetch" | "committer"
    >();
    expectTypeOf<GitHubReleasePinStoreInput["repository"]>().toEqualTypeOf<"yerzhansa/enduragent">();
    expectTypeOf(createGitHubReleasePinStore).returns.toEqualTypeOf<ReleasePinStore>();
    const exported = ADAPTER_SOURCE.split("\n")
      .filter((line) => line.startsWith("export "))
      .join("\n");
    expect(exported).not.toMatch(/refs\/tags/);
    expect(exported).not.toMatch(/catalog-pin/);
  });

  it("GET 404 on a group ref is absent, not a throw", async () => {
    const fake = createFakeGitData();
    const store = createStore(fake);
    await expect(store.readGroup(SOURCE_COMMIT)).resolves.toBeUndefined();
    expect(
      fake.requests.some(
        (request) =>
          request.method === "GET" &&
          request.path === `git/ref/tags/catalog-pin/group/${SOURCE_COMMIT}` &&
          request.status === 404,
      ),
    ).toBe(true);
    expect(
      fake.requests.some(
        (request) =>
          request.path === `git/ref/tags/catalog-pin/group/${SOURCE_COMMIT}` && request.status >= 500,
      ),
    ).toBe(false);
  });
});
