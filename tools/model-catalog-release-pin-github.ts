import { z } from "zod";
import { bytesEqual, jsonBytes, sha256 } from "./model-catalog-bytes.js";
import {
  CatalogDigestSchema,
  CatalogReleasePinError,
  IsoTimestampSchema,
  type BytesWriteResult,
  type CatalogDigest,
  type CreateGroupResult,
  type ReleasePinStore,
  type RetainedProductionBundle,
} from "./model-catalog-release-pin.js";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REVISION_NAME_PATTERN = /^[1-9]\d*$/u;
const GROUP_TAG_PREFIX = "catalog-pin/group/";
const BYTES_TAG_PREFIX = "catalog-pin/bytes/";
const RETAINED_TAG_PREFIX = "catalog-pin/retained/";
const BYTES_FILE = "bytes";
const CATALOG_FILE = "catalog.json";
const PUBLICATION_RECORD_FILE = "publication-record.json";
const PRODUCTION_RECEIPT_FILE = "production-receipt.json";
const RETAINED_FILES = Object.freeze([
  CATALOG_FILE,
  PUBLICATION_RECORD_FILE,
  PRODUCTION_RECEIPT_FILE,
] as const);
const MATCHING_RETAINED_REFS_PATH = "git/matching-refs/tags/catalog-pin/retained/";
const BLOB_MODE = "100644";

const GitShaSchema = z.string().regex(GIT_SHA_PATTERN);
const GitObjectSchema = z.object({
  type: z.string(),
  sha: GitShaSchema,
});
const GitRefSchema = z.object({
  ref: z.string(),
  object: GitObjectSchema,
});
const GitTagSchema = z.object({
  tag: z.string(),
  message: z.string(),
  object: GitObjectSchema,
});
const GitShaObjectSchema = z.object({
  sha: GitShaSchema,
});
const GitCommitSchema = z.object({
  sha: GitShaSchema,
  tree: z.object({ sha: GitShaSchema }),
  committer: z
    .object({
      name: z.string(),
      email: z.string(),
      date: z.string(),
    })
    .optional(),
});
const GitTreeEntrySchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  sha: GitShaSchema,
});
const GitTreeSchema = z.object({
  sha: GitShaSchema,
  tree: z.array(GitTreeEntrySchema),
  truncated: z.boolean().optional(),
});
const GitBlobSchema = z.object({
  sha: GitShaSchema,
  content: z.string(),
  encoding: z.string(),
});
const GitIdentitySchema = z
  .object({
    name: z.string().min(1),
    email: z.string().min(1),
    date: IsoTimestampSchema,
  })
  .strict();
const GitHubReleasePinStoreInputSchema = z
  .object({
    repository: z.literal("yerzhansa/enduragent"),
    token: z.string().min(1),
    committer: GitIdentitySchema,
  })
  .strict();

type GitIdentity = z.infer<typeof GitIdentitySchema>;
type GitHubResult =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "ref-exists" }>
  | Readonly<{ kind: "json"; value: unknown }>;
type TreeFile = Readonly<{ path: string; bytes: Uint8Array }>;

export type GitHubReleasePinStoreInput = {
  readonly repository: "yerzhansa/enduragent";
  readonly token: string;
  readonly fetch: typeof fetch;
  readonly committer: {
    readonly name: string;
    readonly email: string;
    readonly date: string;
  };
};

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function freezeBundle(bundle: RetainedProductionBundle): RetainedProductionBundle {
  return Object.freeze({
    revision: bundle.revision,
    catalogDigest: bundle.catalogDigest,
    publicationRecordDigest: bundle.publicationRecordDigest,
    productionReceiptDigest: bundle.productionReceiptDigest,
    catalogBytes: cloneBytes(bundle.catalogBytes),
    recordBytes: cloneBytes(bundle.recordBytes),
    receiptBytes: cloneBytes(bundle.receiptBytes),
  });
}

function parseGithub<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CatalogReleasePinError("unrecoverable", "GitHub response is invalid");
  }
  return parsed.data;
}

function parseDigest(value: string): CatalogDigest {
  const parsed = CatalogDigestSchema.safeParse(value);
  if (!parsed.success) {
    throw new CatalogReleasePinError("validation", "catalog digest is invalid");
  }
  return parsed.data;
}

async function digestOf(bytes: Uint8Array): Promise<CatalogDigest> {
  return parseDigest((await sha256(bytes)).hex);
}

function utf8Text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CatalogReleasePinError("validation", "pin bytes are not valid UTF-8");
  }
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.replaceAll(/\s+/g, ""), "base64"));
}

function parseRepository(repository: "yerzhansa/enduragent"): {
  readonly owner: string;
  readonly name: string;
} {
  const [owner, name, extra] = repository.split("/");
  if (
    extra !== undefined ||
    owner === undefined ||
    name === undefined ||
    owner.length === 0 ||
    name.length === 0
  ) {
    throw new CatalogReleasePinError("validation", "repository is invalid");
  }
  return Object.freeze({ owner, name });
}

function retainedEqual(left: RetainedProductionBundle, right: RetainedProductionBundle): boolean {
  return (
    left.revision === right.revision &&
    left.catalogDigest === right.catalogDigest &&
    left.publicationRecordDigest === right.publicationRecordDigest &&
    left.productionReceiptDigest === right.productionReceiptDigest &&
    bytesEqual(left.catalogBytes, right.catalogBytes) &&
    bytesEqual(left.recordBytes, right.recordBytes) &&
    bytesEqual(left.receiptBytes, right.receiptBytes)
  );
}

function fileMap(entries: readonly z.infer<typeof GitTreeEntrySchema>[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "blob" || entry.mode !== BLOB_MODE) continue;
    files.set(entry.path, entry.sha);
  }
  return files;
}

export function createGitHubReleasePinStore(input: GitHubReleasePinStoreInput): ReleasePinStore {
  const parsedInput = GitHubReleasePinStoreInputSchema.safeParse({
    repository: input.repository,
    token: input.token,
    committer: input.committer,
  });
  if (!parsedInput.success || typeof input.fetch !== "function") {
    throw new CatalogReleasePinError("validation", "GitHub release pin store input is invalid");
  }
  const { owner, name: repositoryName } = parseRepository(parsedInput.data.repository);
  const token = parsedInput.data.token;
  const fetchImpl = input.fetch;
  const committer: GitIdentity = parsedInput.data.committer;
  const apiRoot = `https://api.github.com/repos/${owner}/${repositoryName}`;

  async function github(path: string, body?: unknown): Promise<GitHubResult> {
    const method = body === undefined ? "GET" : "POST";
    const response = await fetchImpl(`${apiRoot}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && method === "GET") {
      await response.arrayBuffer();
      return Object.freeze({ kind: "missing" });
    }
    if (response.status === 422 && method === "POST" && path === "git/refs") {
      await response.arrayBuffer();
      return Object.freeze({ kind: "ref-exists" });
    }
    if (!response.ok) {
      await response.arrayBuffer();
      throw new Error(`GitHub request failed with ${response.status}`);
    }
    const payload: unknown = await response.json();
    return Object.freeze({ kind: "json", value: payload });
  }

  async function githubJson(path: string, body?: unknown): Promise<unknown> {
    const result = await github(path, body);
    if (result.kind !== "json") {
      throw new CatalogReleasePinError("unrecoverable", "GitHub response is invalid");
    }
    return result.value;
  }

  async function githubGet(path: string): Promise<unknown | undefined> {
    const result = await github(path);
    if (result.kind === "missing") return undefined;
    if (result.kind !== "json") {
      throw new CatalogReleasePinError("unrecoverable", "GitHub response is invalid");
    }
    return result.value;
  }

  async function readAnnotatedTag(tagName: string): Promise<
    | Readonly<{ message: string; object: z.infer<typeof GitObjectSchema> }>
    | undefined
  > {
    const refValue = await githubGet(`git/ref/tags/${tagName}`);
    if (refValue === undefined) return undefined;
    const ref = parseGithub(GitRefSchema, refValue);
    if (ref.object.type !== "tag") {
      throw new CatalogReleasePinError("unrecoverable", "pin tag must be an annotated tag");
    }
    const tagValue = await githubGet(`git/tags/${ref.object.sha}`);
    if (tagValue === undefined) {
      throw new CatalogReleasePinError("unrecoverable", "pin tag object is missing");
    }
    const tag = parseGithub(GitTagSchema, tagValue);
    if (tag.tag !== tagName || tag.object.type !== "commit") {
      throw new CatalogReleasePinError("unrecoverable", "pin tag object is invalid");
    }
    return Object.freeze({ message: tag.message, object: tag.object });
  }

  async function createAnnotatedTagRef(input: {
    readonly tagName: string;
    readonly message: string;
    readonly commitSha: string;
  }): Promise<"created" | "exists"> {
    const tag = parseGithub(
      GitShaObjectSchema,
      await githubJson("git/tags", {
        tag: input.tagName,
        message: input.message,
        object: input.commitSha,
        type: "commit",
        tagger: committer,
      }),
    );
    const result = await github("git/refs", {
      ref: `refs/tags/${input.tagName}`,
      sha: tag.sha,
    });
    if (result.kind === "ref-exists") return "exists";
    if (result.kind !== "json") {
      throw new CatalogReleasePinError("unrecoverable", "GitHub response is invalid");
    }
    return "created";
  }

  async function readBlob(sha: string): Promise<Uint8Array | undefined> {
    const value = await githubGet(`git/blobs/${sha}`);
    if (value === undefined) return undefined;
    const blob = parseGithub(GitBlobSchema, value);
    if (blob.encoding !== "base64") return undefined;
    return base64ToBytes(blob.content);
  }

  async function readTreeFiles(commitSha: string): Promise<Map<string, Uint8Array> | undefined> {
    const commitValue = await githubGet(`git/commits/${commitSha}`);
    if (commitValue === undefined) return undefined;
    const commit = parseGithub(GitCommitSchema, commitValue);
    const treeValue = await githubGet(`git/trees/${commit.tree.sha}`);
    if (treeValue === undefined) return undefined;
    const tree = parseGithub(GitTreeSchema, treeValue);
    if (tree.truncated === true) return undefined;
    const files = new Map<string, Uint8Array>();
    for (const [path, blobSha] of fileMap(tree.tree)) {
      const bytes = await readBlob(blobSha);
      if (bytes === undefined) return undefined;
      files.set(path, bytes);
    }
    return files;
  }

  async function createFilesCommit(input: {
    readonly files: readonly TreeFile[];
    readonly message: string;
  }): Promise<string> {
    const entries: Array<{
      path: string;
      mode: typeof BLOB_MODE;
      type: "blob";
      sha: string;
    }> = [];
    for (const file of input.files) {
      const blob = parseGithub(
        GitShaObjectSchema,
        await githubJson("git/blobs", {
          content: bytesToBase64(file.bytes),
          encoding: "base64",
        }),
      );
      entries.push({ path: file.path, mode: BLOB_MODE, type: "blob", sha: blob.sha });
    }
    const tree = parseGithub(GitShaObjectSchema, await githubJson("git/trees", { tree: entries }));
    const commit = parseGithub(
      GitShaObjectSchema,
      await githubJson("git/commits", {
        message: input.message,
        tree: tree.sha,
        parents: [],
        author: committer,
        committer,
      }),
    );
    return commit.sha;
  }

  async function readGroup(releaseGroupId: string): Promise<Uint8Array | undefined> {
    const tag = await readAnnotatedTag(`${GROUP_TAG_PREFIX}${releaseGroupId}`);
    if (tag === undefined) return undefined;
    if (tag.object.sha !== releaseGroupId) {
      throw new CatalogReleasePinError("unrecoverable", "pin tag object is invalid");
    }
    return utf8Bytes(tag.message);
  }

  async function getBytes(digest: string): Promise<Uint8Array | undefined> {
    const tag = await readAnnotatedTag(`${BYTES_TAG_PREFIX}${digest}`);
    if (tag === undefined) return undefined;
    const files = await readTreeFiles(tag.object.sha);
    if (files === undefined || files.size !== 1) return undefined;
    const bytes = files.get(BYTES_FILE);
    return bytes === undefined ? undefined : cloneBytes(bytes);
  }

  async function hydrateRetained(revision: number): Promise<RetainedProductionBundle | undefined> {
    const tag = await readAnnotatedTag(`${RETAINED_TAG_PREFIX}${revision}`);
    if (tag === undefined) return undefined;
    const files = await readTreeFiles(tag.object.sha);
    if (files === undefined || files.size !== RETAINED_FILES.length) return undefined;
    const catalogBytes = files.get(CATALOG_FILE);
    const recordBytes = files.get(PUBLICATION_RECORD_FILE);
    const receiptBytes = files.get(PRODUCTION_RECEIPT_FILE);
    if (catalogBytes === undefined || recordBytes === undefined || receiptBytes === undefined) {
      return undefined;
    }
    return freezeBundle({
      revision,
      catalogDigest: await digestOf(catalogBytes),
      publicationRecordDigest: await digestOf(recordBytes),
      productionReceiptDigest: await digestOf(receiptBytes),
      catalogBytes,
      recordBytes,
      receiptBytes,
    });
  }

  const store: ReleasePinStore = {
    async createGroup(input) {
      const tagName = `${GROUP_TAG_PREFIX}${input.releaseGroupId}`;
      const created = await createAnnotatedTagRef({
        tagName,
        message: utf8Text(input.bytes),
        commitSha: input.releaseGroupId,
      });
      if (created === "created") return Object.freeze({ kind: "created" });
      const existing = await readGroup(input.releaseGroupId);
      if (existing === undefined) {
        throw new CatalogReleasePinError("unrecoverable", "existing release group is unrecoverable");
      }
      return Object.freeze({ kind: "exists", bytes: existing }) satisfies CreateGroupResult;
    },
    async readGroup(releaseGroupId) {
      const bytes = await readGroup(releaseGroupId);
      return bytes === undefined ? undefined : cloneBytes(bytes);
    },
    async putBytes(input) {
      const digest = parseDigest(input.digest);
      const actual = await digestOf(input.bytes);
      if (actual !== digest) {
        throw new CatalogReleasePinError("integrity", "blob digest does not match bytes");
      }
      const existing = await getBytes(digest);
      if (existing !== undefined) {
        if (bytesEqual(existing, input.bytes)) return "exists";
        throw new CatalogReleasePinError("conflict", "blob already exists with different bytes");
      }
      const commitSha = await createFilesCommit({
        files: [{ path: BYTES_FILE, bytes: input.bytes }],
        message: digest,
      });
      const created = await createAnnotatedTagRef({
        tagName: `${BYTES_TAG_PREFIX}${digest}`,
        message: digest,
        commitSha,
      });
      if (created === "created") return "created" satisfies BytesWriteResult;
      const winner = await getBytes(digest);
      if (winner === undefined) {
        throw new CatalogReleasePinError("unrecoverable", "existing blob is unrecoverable");
      }
      if (!bytesEqual(winner, input.bytes)) {
        throw new CatalogReleasePinError("conflict", "blob already exists with different bytes");
      }
      return "exists";
    },
    async getBytes(digest) {
      return getBytes(digest);
    },
    async putRetainedRevision(bundle) {
      const catalogDigest = await digestOf(bundle.catalogBytes);
      const publicationRecordDigest = await digestOf(bundle.recordBytes);
      const productionReceiptDigest = await digestOf(bundle.receiptBytes);
      if (
        catalogDigest !== bundle.catalogDigest ||
        publicationRecordDigest !== bundle.publicationRecordDigest ||
        productionReceiptDigest !== bundle.productionReceiptDigest
      ) {
        throw new CatalogReleasePinError("integrity", "retained bundle digest does not match bytes");
      }
      const existing = await hydrateRetained(bundle.revision);
      if (existing !== undefined) {
        if (retainedEqual(existing, bundle)) return "exists";
        throw new CatalogReleasePinError(
          "conflict",
          "retained revision already exists with different bytes",
        );
      }
      const retainedMessage = utf8Text(
        jsonBytes({
          revision: bundle.revision,
          catalogDigest: bundle.catalogDigest,
          publicationRecordDigest: bundle.publicationRecordDigest,
          productionReceiptDigest: bundle.productionReceiptDigest,
        }),
      );
      const commitSha = await createFilesCommit({
        files: [
          { path: CATALOG_FILE, bytes: bundle.catalogBytes },
          { path: PUBLICATION_RECORD_FILE, bytes: bundle.recordBytes },
          { path: PRODUCTION_RECEIPT_FILE, bytes: bundle.receiptBytes },
        ],
        message: retainedMessage,
      });
      const created = await createAnnotatedTagRef({
        tagName: `${RETAINED_TAG_PREFIX}${bundle.revision}`,
        message: retainedMessage,
        commitSha,
      });
      if (created === "created") return "created";
      const winner = await hydrateRetained(bundle.revision);
      if (winner === undefined) {
        throw new CatalogReleasePinError("unrecoverable", "existing retained revision is unrecoverable");
      }
      if (!retainedEqual(winner, bundle)) {
        throw new CatalogReleasePinError(
          "conflict",
          "retained revision already exists with different bytes",
        );
      }
      return "exists";
    },
    async getRetainedRevision(revision) {
      return hydrateRetained(revision);
    },
    async listRetainedRevisions() {
      const value = await githubGet(MATCHING_RETAINED_REFS_PATH);
      if (value === undefined) return Object.freeze([]);
      const refs = parseGithub(z.array(GitRefSchema), value);
      const bundles: RetainedProductionBundle[] = [];
      for (const ref of refs) {
        const prefix = `refs/tags/${RETAINED_TAG_PREFIX}`;
        if (!ref.ref.startsWith(prefix)) continue;
        const revisionText = ref.ref.slice(prefix.length);
        if (!REVISION_NAME_PATTERN.test(revisionText)) continue;
        const bundle = await hydrateRetained(Number(revisionText));
        if (bundle !== undefined) bundles.push(bundle);
      }
      return Object.freeze(
        bundles
          .sort((left, right) => right.revision - left.revision)
          .map((bundle) => freezeBundle(bundle)),
      );
    },
  };
  return Object.freeze(store);
}
