import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_FEED_URL,
  DESKTOP_MANIFEST,
  DESKTOP_PROVISIONAL_RELEASE_BODY,
  DESKTOP_STABLE_DMG_NAME,
  GITHUB_DESKTOP_RELEASE_FEED_URL,
  GithubClient,
  activateDesktopRelease,
  compensateDesktopRelease,
  observeDesktopLatest,
  prepareDesktopBaseline,
  promoteDesktopLatest,
  publishDesktopRelease,
  reconcileDesktopLatest,
  releaseFileNames,
  resolveDesktopRollbackLatest,
  sealDesktopRelease,
  stageDesktopRelease,
  type DesktopReleaseManifest,
  type GithubClientTimingOptions,
  verifyDesktopRelease,
} from "./desktop-release-transaction.js";

const candidateVersion = "0.1.7";
const candidateTag = `enduragent-desktop@${candidateVersion}`;
const candidateCommit = "a".repeat(40);
const realSetImmediate = setImmediate;

async function waitForPendingFakeTimer(): Promise<void> {
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (vi.getTimerCount() > 0) return;
    await new Promise<void>((resolveTurn) => realSetImmediate(resolveTurn));
  }
  throw new TypeError("release operation did not schedule its reconciliation timer");
}

async function settleFakeTimerOperation<T>(operation: Promise<T>): Promise<T> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 20_000 && !settled; turn += 1) {
    await new Promise<void>((resolveTurn) => realSetImmediate(resolveTurn));
    if (vi.getTimerCount() > 0) await vi.runOnlyPendingTimersAsync();
  }
  if (!settled) throw new TypeError("release operation exceeded the fake-timer settlement bound");
  return operation;
}

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  digest: string;
  state: "starter" | "uploaded";
  url: string;
  browser_download_url: string;
}

interface FakeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: FakeAsset[];
  upload_url: string;
  body: string;
}

function digest(bytes: Uint8Array, algorithm: "sha256" | "sha512", encoding: "hex" | "base64") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function writeEnvelope(directory: string, version: string): void {
  const [dmgName, zipName, blockmapName] = releaseFileNames(version);
  const dmg = Buffer.from(`dmg-${version}`);
  const zip = Buffer.from(`zip-${version}`);
  writeFileSync(join(directory, dmgName), dmg);
  writeFileSync(join(directory, zipName), zip);
  writeFileSync(join(directory, blockmapName), `blockmap-${version}`);
  writeFileSync(
    join(directory, "latest-mac.yml"),
    stringify({
      version,
      files: [
        { url: zipName, sha512: digest(zip, "sha512", "base64"), size: zip.length },
        { url: dmgName, sha512: digest(dmg, "sha512", "base64"), size: dmg.length },
      ],
      path: zipName,
      sha512: digest(zip, "sha512", "base64"),
      releaseDate: "1998-08-07T00:00:00.000Z",
    }),
  );
}

async function sealed(
  version: string,
  draftId: string,
  baseline?: { release: FakeRelease; manifest: DesktopReleaseManifest },
): Promise<{ directory: string; manifest: DesktopReleaseManifest }> {
  const directory = mkdtempSync(join(tmpdir(), "desktop-release-github-"));
  directories.push(directory);
  writeEnvelope(directory, version);
  const baselineZip = baseline?.manifest.files.find((file) => file.name.endsWith("-arm64.zip"));
  const manifest = await sealDesktopRelease(directory, {
    tag: `enduragent-desktop@${version}`,
    desktopVersion: version,
    commit: version === candidateVersion ? candidateCommit : "b".repeat(40),
    draftId,
    mode: "steady",
    workflowRunId: "456",
    workflowRunAttempt: "1",
    draftBodySha256: digest(Buffer.from("release body"), "sha256", "hex"),
    signingIdentity: "Developer ID Application: Example (FA494ACVTF)",
    candidateCdHash: "d".repeat(40),
    candidateCodeDirectorySha256: "e".repeat(64),
    baselineTag: baseline?.release.tag_name ?? "cycling-coach@2026.8.8",
    baselineReleaseId: baseline ? String(baseline.release.id) : "121",
    baselineCommit: baseline?.manifest.commit ?? "c".repeat(40),
    baselineZipSha256: baselineZip?.sha256 ?? "f".repeat(64),
    baselineSigningIdentity:
      baseline?.manifest.signingIdentity ?? "Developer ID Application: Example (FA494ACVTF)",
    baselineCdHash: baseline?.manifest.candidateCdHash ?? "1".repeat(40),
  });
  return { directory, manifest };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class FakeGithub {
  readonly calls: Array<{
    method: string;
    url: string;
    authorization: string | null;
    cacheControl: string | null;
  }> = [];
  readonly bytes = new Map<string, Buffer>();
  readonly commits = new Map<string, string>();
  pages: FakeRelease[][] = [[]];
  candidate: FakeRelease;
  latest: FakeRelease | null = null;
  nextAssetId = 1000;
  failNextUploadWithStarter = false;
  anonymousDownloadFailures = 0;
  nextLatestApiLagReads = 0;
  nextLatestFeedLagReads = 0;
  latestApiLaggedReads = 0;
  latestFeedLaggedReads = 0;
  private latestBeforeTransition: FakeRelease | null = null;
  private latestApiLagReads = 0;
  private latestFeedLagReads = 0;
  private resolveAnonymousDownloadFailure!: () => void;
  private resolveLatestApiLagObserved!: () => void;
  private resolveLatestFeedLagObserved!: () => void;
  readonly anonymousDownloadFailureObserved = new Promise<void>((resolveFailure) => {
    this.resolveAnonymousDownloadFailure = resolveFailure;
  });
  readonly latestApiLagObserved = new Promise<void>((resolveLag) => {
    this.resolveLatestApiLagObserved = resolveLag;
  });
  readonly latestFeedLagObserved = new Promise<void>((resolveLag) => {
    this.resolveLatestFeedLagObserved = resolveLag;
  });

  constructor(tag = candidateTag, commit = candidateCommit) {
    this.candidate = this.release(123, tag, true);
    this.commits.set(tag, commit);
  }

  release(id: number, tag: string, draft: boolean): FakeRelease {
    return {
      id,
      tag_name: tag,
      draft,
      prerelease: false,
      assets: [],
      upload_url: `https://uploads.github.com/repos/yerzhansa/enduragent/releases/${id}/assets{?name,label}`,
      body: "release body",
    };
  }

  addEnvelope(release: FakeRelease, directory: string, version: string): void {
    for (const name of releaseFileNames(version)) {
      this.addAsset(release, name, readFileSync(join(directory, name)));
    }
  }

  addAsset(
    release: FakeRelease,
    name: string,
    bytes: Buffer,
    state: "starter" | "uploaded" = "uploaded",
  ): FakeAsset {
    const asset = {
      id: this.nextAssetId++,
      name,
      size: bytes.length,
      digest: `sha256:${digest(bytes, "sha256", "hex")}`,
      state,
      url: `https://api.github.com/repos/yerzhansa/enduragent/releases/assets/${this.nextAssetId - 1}`,
      browser_download_url: `https://github.com/yerzhansa/enduragent/releases/download/${release.tag_name}/${name}`,
    };
    release.assets.push(asset);
    this.bytes.set(asset.url, bytes);
    this.bytes.set(asset.browser_download_url, bytes);
    return asset;
  }

  findRelease(id: number): FakeRelease | undefined {
    return [this.candidate, ...this.pages.flat()].find((release) => release.id === id);
  }

  transitionLatest(release: FakeRelease): void {
    this.latestBeforeTransition = this.latest;
    this.latest = release;
    this.latestApiLagReads = this.nextLatestApiLagReads;
    this.latestFeedLagReads = this.nextLatestFeedLagReads;
    this.nextLatestApiLagReads = 0;
    this.nextLatestFeedLagReads = 0;
  }

  apiLatest(): FakeRelease | null {
    if (this.latestApiLagReads === 0) return this.latest;
    this.latestApiLagReads -= 1;
    this.latestApiLaggedReads += 1;
    this.resolveLatestApiLagObserved();
    return this.latestBeforeTransition;
  }

  feedLatest(): FakeRelease | null {
    if (this.latestFeedLagReads === 0) return this.latest;
    this.latestFeedLagReads -= 1;
    this.latestFeedLaggedReads += 1;
    this.resolveLatestFeedLagObserved();
    return this.latestBeforeTransition;
  }

  client(timingOptions: GithubClientTimingOptions = {}): GithubClient {
    return new GithubClient("yerzhansa/enduragent", "token", this.fetch, timingOptions);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    this.calls.push({
      method,
      url,
      authorization: headers.get("Authorization"),
      cacheControl: headers.get("Cache-Control"),
    });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const binary = (bytes: Buffer | undefined, status = 200) =>
      new Response(
        bytes
          ? (bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer)
          : null,
        { status },
      );
    const releaseMatch = /\/releases\/([1-9]\d*)$/u.exec(new URL(url).pathname);
    if (releaseMatch && method === "GET") {
      const release = this.findRelease(Number(releaseMatch[1]));
      return release ? json(release) : json({}, 404);
    }
    if (url.includes("/git/ref/tags/")) {
      const tag = decodeURIComponent(url.split("/git/ref/tags/")[1]);
      const commit = this.commits.get(tag);
      return commit ? json({ object: { type: "commit", sha: commit } }) : json({}, 404);
    }
    if (url.includes("/releases?per_page=100&page=")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(this.pages[page - 1] ?? []);
    }
    if (url.endsWith("/releases/latest")) {
      const latest = this.apiLatest();
      return latest ? json(latest) : json({}, 404);
    }
    if (url.startsWith("https://uploads.github.com/") && method === "POST") {
      const name = new URL(url).searchParams.get("name")!;
      const bytes = Buffer.from((init.body as ArrayBuffer) ?? new ArrayBuffer(0));
      if (this.failNextUploadWithStarter) {
        this.failNextUploadWithStarter = false;
        this.addAsset(this.candidate, name, Buffer.alloc(0), "starter");
        return json({}, 502);
      }
      return json(this.addAsset(this.candidate, name, bytes));
    }
    if (url.includes("/releases/assets/") && method === "DELETE") {
      const id = Number(url.split("/releases/assets/")[1]);
      const index = this.candidate.assets.findIndex((asset) => asset.id === id);
      if (index === -1) return json({}, 404);
      const [asset] = this.candidate.assets.splice(index, 1);
      this.bytes.delete(asset.url);
      this.bytes.delete(asset.browser_download_url);
      return new Response(null, { status: 204 });
    }
    if (releaseMatch && method === "PATCH") {
      const release = this.findRelease(Number(releaseMatch[1]));
      if (!release) return json({}, 404);
      const update = JSON.parse(String(init.body)) as {
        body?: string;
        draft?: boolean;
        make_latest?: string;
      };
      if (update.body !== undefined) release.body = update.body;
      if (update.draft !== undefined) release.draft = update.draft;
      if (update.make_latest === "true") this.transitionLatest(release);
      if (release.draft && this.latest?.id === release.id) this.latest = null;
      return json(release);
    }
    if (url === `${DESKTOP_FEED_URL}latest-mac.yml`) {
      const asset = this.feedLatest()?.assets.find(
        (candidate) => candidate.name === "latest-mac.yml",
      );
      return asset ? binary(this.bytes.get(asset.url)) : binary(undefined, 404);
    }
    if (url.includes("/releases/download/") && this.anonymousDownloadFailures > 0) {
      this.anonymousDownloadFailures -= 1;
      this.resolveAnonymousDownloadFailure();
      return binary(undefined, 404);
    }
    const bytes = this.bytes.get(url);
    if (bytes) return binary(bytes);
    const release = [...this.pages.flat(), this.candidate].find((candidate) =>
      candidate.assets.some((asset) => asset.url === url || asset.browser_download_url === url),
    );
    if (release) return binary(this.bytes.get(url));
    return json({}, 404);
  };
}

async function steadyCandidate(fake: FakeGithub) {
  const baselineEnvelope = await sealed("0.1.6", "122");
  const baseline = fake.release(122, "enduragent-desktop@0.1.6", false);
  fake.commits.set(baseline.tag_name, baselineEnvelope.manifest.commit);
  fake.addEnvelope(baseline, baselineEnvelope.directory, "0.1.6");
  fake.latest = baseline;
  fake.pages = [[baseline]];
  const candidate = await sealed(candidateVersion, "123", {
    release: baseline,
    manifest: baselineEnvelope.manifest,
  });
  return { ...candidate, baseline, baselineDirectory: baselineEnvelope.directory };
}

async function retiredGenesisCandidate() {
  const candidate = await sealed(candidateVersion, "123");
  const path = join(candidate.directory, DESKTOP_MANIFEST);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as DesktopReleaseManifest;
  const retired = {
    ...manifest,
    mode: "genesis" as const,
    baselineTag: "none",
    baselineReleaseId: "none",
    baselineCommit: "none",
    baselineZipSha256: "none",
    baselineSigningIdentity: "none",
    baselineCdHash: "none",
  };
  const { schemaVersion: _, transactionSha256: __, ...transaction } = retired;
  retired.transactionSha256 = digest(Buffer.from(JSON.stringify(transaction)), "sha256", "hex");
  writeFileSync(path, `${JSON.stringify(retired, null, 2)}\n`);
  return candidate.directory;
}

describe("GitHub desktop release transaction", () => {
  it("reads retained genesis evidence but refuses every operational entry point", async () => {
    const fake = new FakeGithub();
    const directory = await retiredGenesisCandidate();
    const observed = { id: null, tag: null, metadataSha256: null };

    await expect(verifyDesktopRelease(directory)).resolves.toMatchObject({ mode: "genesis" });
    const operations: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["observe", () => observeDesktopLatest(directory, fake.client())],
      ["resolve rollback", () => resolveDesktopRollbackLatest(directory, fake.client(), "none")],
      ["publish", () => publishDesktopRelease(directory, fake.client(), observed)],
      ["stage", () => stageDesktopRelease(directory, fake.client())],
      ["promote", () => promoteDesktopLatest(directory, fake.client(), observed)],
      ["reconcile", () => reconcileDesktopLatest(directory, fake.client())],
      [
        "activate",
        () => activateDesktopRelease(directory, "/synthetic/release-body.md", fake.client()),
      ],
      [
        "compensate",
        () =>
          compensateDesktopRelease(
            directory,
            "/synthetic/release-body.md",
            fake.client(),
            observed,
          ),
      ],
    ];
    for (const [name, operation] of operations) {
      await expect(operation(), name).rejects.toThrow("genesis release authority is retired");
    }
    expect(fake.calls).toEqual([]);
  });

  it("stages audit manifest, payload, then metadata and leaves the candidate private", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    expect(
      fake.calls
        .filter((call) => call.method === "POST")
        .map((call) => new URL(call.url).searchParams.get("name")),
    ).toEqual(releaseFileNames(candidateVersion));
    expect(fake.candidate.draft).toBe(true);
    expect(fake.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("resumes exact bytes, rejects conflicts, and performs no mutation on conflict", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const posts = fake.calls.filter((call) => call.method === "POST").length;
    fake.pages = [[fake.candidate]];
    await stageDesktopRelease(directory, fake.client());
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
    const dmg = fake.candidate.assets.find((asset) => asset.name.endsWith(".dmg"))!;
    fake.bytes.set(dmg.url, Buffer.from("conflict"));
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("conflicting");
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
  });

  it("checks tag-to-commit binding before uploading", async () => {
    const fake = new FakeGithub(undefined, "f".repeat(40));
    const { directory } = await steadyCandidate(fake);
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("commit binding");
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("checks the draft body before any release mutation", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    fake.candidate.body = "operator changed the body";
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("body binding");
    expect(fake.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(
      false,
    );
  });

  it("rejects a prerelease draft before any release mutation", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    fake.candidate.prerelease = true;
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow(
      "candidate binding",
    );
    expect(fake.calls.some((call) => call.method === "POST" || call.method === "PATCH")).toBe(
      false,
    );
  });

  it("deletes only a same-name starter asset after a full preflight", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    const name = releaseFileNames(candidateVersion)[0];
    fake.addAsset(fake.candidate, name, Buffer.alloc(0), "starter");
    await stageDesktopRelease(directory, fake.client());
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fake.candidate.assets).toHaveLength(4);
    expect(fake.candidate.assets.every((asset) => asset.state === "uploaded")).toBe(true);
  });

  it("recovers a 502-created starter with bounded delete and retry", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    fake.failNextUploadWithStarter = true;
    await stageDesktopRelease(directory, fake.client());
    expect(fake.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(5);
    expect(fake.candidate.assets).toHaveLength(4);
  });

  it("preflights every existing asset before deleting starters or uploading", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    const [starterName, conflictName] = releaseFileNames(candidateVersion);
    fake.addAsset(fake.candidate, starterName, Buffer.alloc(0), "starter");
    fake.addAsset(fake.candidate, conflictName, Buffer.from("conflict"));
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("conflicting");
    expect(fake.calls.some((call) => call.method === "DELETE" || call.method === "POST")).toBe(
      false,
    );
  });

  it("never sends the bearer token to unbound asset or upload origins", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    fake.candidate.upload_url = "https://example.invalid/assets{?name,label}";
    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow("upload URL");
    expect(fake.calls.some((call) => call.url.includes("example.invalid"))).toBe(false);

    const second = new FakeGithub();
    const candidate = await steadyCandidate(second);
    const asset = second.addAsset(
      second.candidate,
      releaseFileNames(candidateVersion)[0],
      readFileSync(join(candidate.directory, releaseFileNames(candidateVersion)[0])),
    );
    asset.url = "https://example.invalid/asset";
    await expect(stageDesktopRelease(candidate.directory, second.client())).rejects.toThrow(
      "asset API URL",
    );
    expect(second.calls.some((call) => call.url.includes("example.invalid"))).toBe(false);
  });

  it("strips authorization from validated cross-origin asset redirects", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init = {}) => {
      const url = String(input);
      const authorization = new Headers(init.headers).get("Authorization");
      calls.push({ url, authorization });
      if (url.startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/signed-object" },
        });
      }
      return new Response(Buffer.from("asset"));
    });
    await expect(
      client.bytes("https://api.github.com/repos/yerzhansa/enduragent/releases/assets/123"),
    ).resolves.toEqual(Buffer.from("asset"));
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer token", null]);
    await expect(
      client.anonymousBytes(
        "https://github.com/other/repository/releases/download/tag/latest-mac.yml",
      ),
    ).rejects.toThrow("outside the bound repository");
    await expect(client.anonymousBytes(`${DESKTOP_FEED_URL}latest-mac.yml`)).rejects.toThrow(
      "outside the bound repository",
    );
  });

  it("reads latest metadata from the public feed without following redirects", async () => {
    const yaml = Buffer.from("version: 0.1.7\n");
    const digest = createHash("sha256").update(yaml).digest("hex");
    let feedRedirect: RequestInit["redirect"];
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/releases/latest")) {
        return Response.json({
          id: 123,
          tag_name: "enduragent-desktop@0.1.7",
          draft: false,
          prerelease: false,
          assets: [
            {
              id: 1,
              name: "latest-mac.yml",
              size: yaml.length,
              digest: `sha256:${digest}`,
              state: "uploaded",
              url: "https://api.github.com/repos/yerzhansa/enduragent/releases/assets/1",
              browser_download_url:
                "https://github.com/yerzhansa/enduragent/releases/download/enduragent-desktop@0.1.7/latest-mac.yml",
            },
          ],
          upload_url:
            "https://uploads.github.com/repos/yerzhansa/enduragent/releases/123/assets{?name,label}",
          body: "body",
        });
      }
      if (url === `${DESKTOP_FEED_URL}latest-mac.yml`) {
        feedRedirect = init.redirect;
        expect(new Headers(init.headers).get("Authorization")).toBeNull();
        return new Response(yaml);
      }
      return new Response(null, { status: 599 });
    });
    await expect(client.latest()).resolves.toEqual({
      id: 123,
      tag: "enduragent-desktop@0.1.7",
      metadataSha256: digest,
    });
    expect(feedRedirect).toBe("error");
  });

  it("refuses a public feed that still redirects", async () => {
    const client = new GithubClient("yerzhansa/enduragent", "token", async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: `${GITHUB_DESKTOP_RELEASE_FEED_URL}latest-mac.yml` },
      });
    });
    await expect(client.publicFeedMetadataBytes()).rejects.toThrow("public updater feed redirected");
  });

  it("uses injected deadlines for metadata requests without exposing secrets or URLs", async () => {
    let fireTimeout: (() => void) | undefined;
    let cancelled = false;
    let bodyReadStarted = false;
    let requestSignal: AbortSignal | undefined;
    const client = new GithubClient(
      "yerzhansa/enduragent",
      "sensitive-token",
      async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          json: async () => {
            bodyReadStarted = true;
            return new Promise<never>(() => undefined);
          },
        } as unknown as Response;
      },
      {
        metadataRequestTimeoutMs: 17,
        scheduleTimeout: (callback, delayMs) => {
          expect(delayMs).toBe(17);
          fireTimeout = callback;
          return "metadata-timer";
        },
        cancelTimeout: (timer) => {
          expect(timer).toBe("metadata-timer");
          cancelled = true;
        },
      },
    );

    const request = client.release(123);
    await Promise.resolve();
    await Promise.resolve();
    expect(bodyReadStarted).toBe(true);
    expect(fireTimeout).toBeTypeOf("function");
    fireTimeout!();
    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("GitHub metadata request timed out");
    expect((error as Error).message).not.toContain("sensitive-token");
    expect((error as Error).message).not.toContain("github.com");
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("derives a fixed preflight, request, and reconciliation budget", () => {
    const client = new GithubClient(
      "yerzhansa/enduragent",
      "token",
      async () => Response.json({}),
      {
        metadataRequestTimeoutMs: 30,
        releasePropagationTimeoutMs: 600,
        latestReleasePropagationTimeoutMs: 1_200,
        now: () => 1_000,
      },
    );

    expect(client.latestMutationDeadlines(4_000)).toEqual({
      preflightDeadlineAt: 2_770,
      requestDeadlineAt: 2_800,
      reconciliationDeadlineAt: 4_000,
    });
    expect(() => client.latestMutationDeadlines(2_230)).toThrow(
      "desktop latest promotion reconciliation budget is unavailable",
    );
  });

  it("bounds asset response consumption with a separate transfer budget", async () => {
    vi.useFakeTimers();
    try {
      const response = {
        ok: true,
        status: 200,
        arrayBuffer: async () => new Promise<ArrayBuffer>(() => undefined),
      } as unknown as Response;
      const client = new GithubClient("yerzhansa/enduragent", "token", async () => response, {
        metadataRequestTimeoutMs: 10,
        assetTransferTimeoutMs: 40,
      });
      let settled = false;
      const transfer = client
        .bytes("https://api.github.com/repos/yerzhansa/enduragent/releases/assets/123")
        .finally(() => {
          settled = true;
        });
      const assertion = expect(transfer).rejects.toThrow("GitHub asset transfer timed out");
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes steady assets provisionally and verifies tag downloads anonymously", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    expect(fake.candidate.draft).toBe(false);
    expect(fake.latest?.id).toBe(122);
    expect(fake.candidate.body).toBe(DESKTOP_PROVISIONAL_RELEASE_BODY);
    const anonymousDownloads = fake.calls.filter((call) =>
      call.url.includes("/releases/download/"),
    );
    expect(anonymousDownloads).toHaveLength(4);
    expect(anonymousDownloads.every((call) => call.authorization === null)).toBe(true);
    const uploads = fake.calls
      .filter((call) => call.method === "POST")
      .map((call) => new URL(call.url).searchParams.get("name"));
    expect(uploads.at(-1)).toBe("latest-mac.yml");
  });

  it("waits for transient tag-specific asset propagation", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeGithub();
      const { directory } = await steadyCandidate(fake);
      await stageDesktopRelease(directory, fake.client());
      const observed = await observeDesktopLatest(directory, fake.client());
      fake.anonymousDownloadFailures = 1;
      const publication = publishDesktopRelease(directory, fake.client(), observed);
      await fake.anonymousDownloadFailureObserved;
      await new Promise<void>((resolveTurn) => realSetImmediate(resolveTurn));
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await publication;
      expect(fake.candidate.body).toBe(DESKTOP_PROVISIONAL_RELEASE_BODY);
      expect(fake.anonymousDownloadFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows latest API pointer convergence beyond the tag-download retry window", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);

    vi.useFakeTimers();
    try {
      fake.nextLatestApiLagReads = 35;
      await promoteDesktopLatest(directory, fake.client(), observed);
      expect(fake.latestApiLaggedReads).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const authenticatedAssetReadsBefore = fake.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.authorization !== null &&
          call.url.includes("/releases/assets/"),
      ).length;
      const reconciliation = reconcileDesktopLatest(directory, fake.client());
      await fake.latestApiLagObserved;
      await new Promise<void>((resolveTurn) => realSetImmediate(resolveTurn));
      expect(vi.getTimerCount()).toBe(1);
      let reconciled = false;
      void reconciliation.then(() => {
        reconciled = true;
      });
      await vi.advanceTimersByTimeAsync(175_000);
      expect(reconciled).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      await reconciliation;

      expect(fake.latestApiLaggedReads).toBe(35);
      expect(fake.latestFeedLaggedReads).toBe(0);
      expect(fake.latest?.id).toBe(fake.candidate.id);
      expect(
        fake.calls.filter(
          (call) =>
            call.method === "GET" &&
            call.authorization !== null &&
            call.url.includes("/releases/assets/"),
        ),
      ).toHaveLength(authenticatedAssetReadsBefore);
      const latestApiCalls = fake.calls.filter((call) => call.url.endsWith("/releases/latest"));
      expect(latestApiCalls.length).toBeGreaterThan(35);
      expect(latestApiCalls.every((call) => call.cacheControl === "no-cache")).toBe(true);
      expect(
        fake.calls
          .filter((call) => call.cacheControl !== null)
          .every((call) => call.url.endsWith("/releases/latest")),
      ).toBe(true);
      expect(
        fake.calls
          .filter((call) => call.url === `${DESKTOP_FEED_URL}latest-mac.yml`)
          .every((call) => call.cacheControl === null),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a promotion whose successful response was lost without retrying", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    let promotionRequests = 0;
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init) => {
      const promotion =
        (init?.method ?? "GET") === "PATCH" &&
        JSON.parse(String(init?.body ?? "{}") || "{}").make_latest === "true";
      if (!promotion) return fake.fetch(input, init);
      promotionRequests += 1;
      await fake.fetch(input, init);
      throw new TypeError("connection closed after mutation");
    });

    vi.useFakeTimers();
    try {
      await expect(
        settleFakeTimerOperation(promoteDesktopLatest(directory, client, observed)),
      ).resolves.toBe("applied");
      expect(promotionRequests).toBe(1);
      expect(fake.latest?.id).toBe(fake.candidate.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops aggregate promotion preflight before consuming the reconciliation reserve", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    let now = 10_000;
    let promotionRequests = 0;
    const client = new GithubClient(
      "yerzhansa/enduragent",
      "token",
      async (input, init) => {
        now += 5;
        if (
          (init?.method ?? "GET") === "PATCH" &&
          JSON.parse(String(init?.body ?? "{}") || "{}").make_latest === "true"
        ) {
          promotionRequests += 1;
        }
        return fake.fetch(input, init);
      },
      {
        metadataRequestTimeoutMs: 10,
        assetTransferTimeoutMs: 10,
        releasePropagationTimeoutMs: 100,
        latestReleasePropagationTimeoutMs: 50,
        now: () => now,
      },
    );
    const transactionDeadlineAt = now + 80;

    await expect(
      promoteDesktopLatest(directory, client, observed, transactionDeadlineAt),
    ).rejects.toThrow("GitHub metadata request timed out");
    expect(now).toBeLessThanOrEqual(transactionDeadlineAt - 60);
    expect(promotionRequests).toBe(0);
    expect(fake.latest?.id).toBe(observed.id);
  });

  it("read-only reconciliation classifies applied, unapplied, and foreign hard-stop outcomes", async () => {
    const fake = new FakeGithub();
    const { directory, baseline } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;
    const client = fake.client({
      latestReleasePropagationTimeoutMs: 25,
      latestReleasePropagationDelayMs: 5,
    });

    vi.useFakeTimers();
    try {
      fake.transitionLatest(fake.candidate);
      await settleFakeTimerOperation(reconcileDesktopLatest(directory, client));

      fake.transitionLatest(baseline);
      await expect(
        settleFakeTimerOperation(reconcileDesktopLatest(directory, client)),
      ).rejects.toThrow("desktop latest reconciliation did not converge");

      fake.transitionLatest(fake.release(999, "other@1.0.0", false));
      await expect(
        settleFakeTimerOperation(reconcileDesktopLatest(directory, client)),
      ).rejects.toThrow("desktop latest reconciliation did not converge");

      expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies an unapplied promotion without an unsafe blind retry", async () => {
    const fake = new FakeGithub();
    const { directory, baseline } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    let promotionRequests = 0;
    const client = new GithubClient(
      "yerzhansa/enduragent",
      "token",
      async (input, init) => {
        const promotion =
          (init?.method ?? "GET") === "PATCH" &&
          JSON.parse(String(init?.body ?? "{}") || "{}").make_latest === "true";
        if (!promotion) return fake.fetch(input, init);
        promotionRequests += 1;
        throw new TypeError("connection closed before mutation");
      },
      { latestReleasePropagationTimeoutMs: 25, latestReleasePropagationDelayMs: 5 },
    );

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      await expect(
        settleFakeTimerOperation(promoteDesktopLatest(directory, client, observed)),
      ).rejects.toMatchObject({
        outcome: "unapplied",
        message: "desktop latest promotion was not applied",
      });
      expect(promotionRequests).toBe(1);
      expect(fake.latest?.id).toBe(baseline.id);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a foreign latest winner after an ambiguous promotion response", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    const unrelated = fake.release(999, "other@1.0.0", false);
    let promotionRequests = 0;
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init) => {
      const promotion =
        (init?.method ?? "GET") === "PATCH" &&
        JSON.parse(String(init?.body ?? "{}") || "{}").make_latest === "true";
      if (!promotion) return fake.fetch(input, init);
      promotionRequests += 1;
      fake.transitionLatest(unrelated);
      throw new TypeError("connection closed during concurrent mutation");
    });

    await expect(promoteDesktopLatest(directory, client, observed)).rejects.toMatchObject({
      outcome: "foreign",
      message: "desktop latest promotion observed a foreign latest release",
    });
    expect(promotionRequests).toBe(1);
    expect(fake.latest?.id).toBe(unrelated.id);
  });

  it("makes a pre-mutation latest CAS violation a sticky foreign outcome", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    const unrelated = fake.release(999, "other@1.0.0", false);
    fake.transitionLatest(unrelated);
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;

    await expect(promoteDesktopLatest(directory, fake.client(), observed)).rejects.toMatchObject({
      outcome: "foreign",
    });
    expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
    expect(fake.latest?.id).toBe(unrelated.id);
  });

  it("keeps an unapplied observation unknown after trailing reconciliation failures", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    let mutationAttempted = false;
    let reconciliationReads = 0;
    const client = new GithubClient(
      "yerzhansa/enduragent",
      "token",
      async (input, init) => {
        const promotion =
          (init?.method ?? "GET") === "PATCH" &&
          JSON.parse(String(init?.body ?? "{}") || "{}").make_latest === "true";
        if (promotion) {
          mutationAttempted = true;
          throw new TypeError("connection closed before mutation");
        }
        if (mutationAttempted && String(input).endsWith("/releases/latest")) {
          reconciliationReads += 1;
          if (reconciliationReads > 2) throw new TypeError("synthetic trailing outage");
        }
        return fake.fetch(input, init);
      },
      { latestReleasePropagationTimeoutMs: 25, latestReleasePropagationDelayMs: 5 },
    );

    vi.useFakeTimers();
    try {
      await expect(
        settleFakeTimerOperation(promoteDesktopLatest(directory, client, observed)),
      ).rejects.toMatchObject({
        outcome: "unknown",
        message: "desktop latest promotion outcome could not be reconciled",
      });
      expect(reconciliationReads).toBeGreaterThan(2);
      expect(fake.latest?.id).toBe(observed.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an exact public provisional release without replacing its assets", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    const uploadCount = fake.calls.filter(
      (call) => call.method === "POST" && call.url.startsWith("https://uploads.github.com/"),
    ).length;
    const publicationPatchCount = fake.calls.filter((call) => call.method === "PATCH").length;

    const resumedObserved = await observeDesktopLatest(directory, fake.client());
    await stageDesktopRelease(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), resumedObserved);
    expect(
      fake.calls.filter(
        (call) => call.method === "POST" && call.url.startsWith("https://uploads.github.com/"),
      ),
    ).toHaveLength(uploadCount);
    expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(
      publicationPatchCount,
    );

    await promoteDesktopLatest(directory, fake.client(), resumedObserved);
    const promotionPatchCount = fake.calls.filter((call) => call.method === "PATCH").length;
    const promotedObservation = await observeDesktopLatest(directory, fake.client());
    await stageDesktopRelease(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), promotedObservation);
    expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(promotionPatchCount);
    expect(fake.candidate.body).toBe(DESKTOP_PROVISIONAL_RELEASE_BODY);
  });

  it("rejects a public recovery candidate with an unexpected body", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    fake.candidate.body = "unexpected public body";
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;

    await expect(stageDesktopRelease(directory, fake.client())).rejects.toThrow(
      "public body binding mismatch",
    );
    expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
  });

  it("refuses promotion when the public candidate gained an extra asset", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    fake.addAsset(fake.candidate, "unexpected.txt", Buffer.from("unexpected"));
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;

    await expect(promoteDesktopLatest(directory, fake.client(), observed)).rejects.toThrow(
      "stale release asset",
    );
    expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
    expect(fake.latest?.id).not.toBe(fake.candidate.id);
  });

  it("allows anonymous latest-feed convergence beyond 30 polls during compensation", async () => {
    const fake = new FakeGithub();
    const { directory, baseline } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    await promoteDesktopLatest(directory, fake.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");

    vi.useFakeTimers();
    try {
      await settleFakeTimerOperation(reconcileDesktopLatest(directory, fake.client()));
      fake.nextLatestFeedLagReads = 35;
      const compensation = compensateDesktopRelease(directory, bodyPath, fake.client(), observed);
      await settleFakeTimerOperation(compensation);

      expect(fake.latestApiLaggedReads).toBe(0);
      expect(fake.latestFeedLaggedReads).toBe(35);
      expect(fake.latest?.id).toBe(baseline.id);
      expect(fake.candidate.draft).toBe(true);
      expect(fake.candidate.body).toBe("release body");
    } finally {
      vi.useRealTimers();
    }
  });

  it("activates only after promotion and restores the observed latest on compensation", async () => {
    const successful = new FakeGithub();
    const accepted = await steadyCandidate(successful);
    accepted.baseline.draft = false;
    successful.latest = accepted.baseline;
    await stageDesktopRelease(accepted.directory, successful.client());
    const observed = await observeDesktopLatest(accepted.directory, successful.client());
    await publishDesktopRelease(accepted.directory, successful.client(), observed);
    await promoteDesktopLatest(accepted.directory, successful.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");
    vi.useFakeTimers();
    try {
      await settleFakeTimerOperation(
        reconcileDesktopLatest(accepted.directory, successful.client()),
      );
      const activation = activateDesktopRelease(accepted.directory, bodyPath, successful.client());
      await settleFakeTimerOperation(activation);
      expect(successful.latest?.id).toBe(successful.candidate.id);
      expect(successful.candidate.body).toBe("release body");

      const failed = new FakeGithub();
      const compensating = await steadyCandidate(failed);
      compensating.baseline.draft = false;
      failed.latest = compensating.baseline;
      await stageDesktopRelease(compensating.directory, failed.client());
      const prior = await observeDesktopLatest(compensating.directory, failed.client());
      await publishDesktopRelease(compensating.directory, failed.client(), prior);
      await promoteDesktopLatest(compensating.directory, failed.client(), prior);
      await settleFakeTimerOperation(
        reconcileDesktopLatest(compensating.directory, failed.client()),
      );
      const compensation = compensateDesktopRelease(
        compensating.directory,
        bodyPath,
        failed.client(),
        prior,
      );
      await settleFakeTimerOperation(compensation);
      expect(failed.latest?.id).toBe(compensating.baseline.id);
      expect(failed.candidate.draft).toBe(true);
      expect(failed.candidate.body).toBe("release body");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the manifest baseline when a resumed candidate is already latest", async () => {
    const fake = new FakeGithub();
    const { directory, baseline } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    await promoteDesktopLatest(directory, fake.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");
    const baselineMetadata = baseline.assets.find((asset) => asset.name === "latest-mac.yml")!;

    vi.useFakeTimers();
    try {
      await settleFakeTimerOperation(reconcileDesktopLatest(directory, fake.client()));
      const resumedCurrent = await observeDesktopLatest(directory, fake.client());
      expect(resumedCurrent.id).toBe(fake.candidate.id);
      const rollback = await resolveDesktopRollbackLatest(
        directory,
        fake.client(),
        baselineMetadata.digest.slice("sha256:".length),
      );
      expect(rollback).toEqual({
        id: baseline.id,
        tag: baseline.tag_name,
        metadataSha256: baselineMetadata.digest.slice("sha256:".length),
      });
      const compensation = compensateDesktopRelease(directory, bodyPath, fake.client(), rollback);
      await settleFakeTimerOperation(compensation);
      expect(fake.latest?.id).toBe(baseline.id);
      expect(fake.candidate.draft).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an exact public final latest release as an idempotent terminal state", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    await promoteDesktopLatest(directory, fake.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");

    vi.useFakeTimers();
    try {
      await settleFakeTimerOperation(reconcileDesktopLatest(directory, fake.client()));
      await settleFakeTimerOperation(activateDesktopRelease(directory, bodyPath, fake.client()));
      const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;
      const resumedObserved = await observeDesktopLatest(directory, fake.client());
      await stageDesktopRelease(directory, fake.client());
      await publishDesktopRelease(directory, fake.client(), resumedObserved);
      await promoteDesktopLatest(directory, fake.client(), resumedObserved);
      await settleFakeTimerOperation(reconcileDesktopLatest(directory, fake.client()));
      await settleFakeTimerOperation(activateDesktopRelease(directory, bodyPath, fake.client()));

      expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
      expect(fake.candidate.draft).toBe(false);
      expect(fake.candidate.body).toBe("release body");
      expect(fake.latest?.id).toBe(fake.candidate.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to overwrite a concurrent body edit at the activation boundary", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    await promoteDesktopLatest(directory, fake.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");
    let candidateReads = 0;
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init) => {
      const url = String(input);
      if (
        (init?.method ?? "GET") === "GET" &&
        url.endsWith(`/releases/${fake.candidate.id}`) &&
        ++candidateReads === 2
      ) {
        fake.candidate.body = "concurrent operator body";
      }
      return fake.fetch(input, init);
    });
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;

    vi.useFakeTimers();
    try {
      await settleFakeTimerOperation(reconcileDesktopLatest(directory, fake.client()));
      await expect(
        settleFakeTimerOperation(activateDesktopRelease(directory, bodyPath, client)),
      ).rejects.toThrow("candidate changed at the mutation boundary");
      expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
      expect(fake.candidate.body).toBe("concurrent operator body");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses rollback when the candidate body changes at the mutation boundary", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    await promoteDesktopLatest(directory, fake.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");
    let candidateReads = 0;
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init) => {
      const url = String(input);
      if (
        (init?.method ?? "GET") === "GET" &&
        url.endsWith(`/releases/${fake.candidate.id}`) &&
        ++candidateReads === 2
      ) {
        fake.candidate.body = "concurrent operator body";
      }
      return fake.fetch(input, init);
    });
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;

    vi.useFakeTimers();
    try {
      await settleFakeTimerOperation(reconcileDesktopLatest(directory, fake.client()));
      await expect(
        settleFakeTimerOperation(compensateDesktopRelease(directory, bodyPath, client, observed)),
      ).rejects.toThrow("candidate changed at the mutation boundary");
      expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
      expect(fake.candidate.body).toBe("concurrent operator body");
      expect(fake.candidate.draft).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to overwrite a concurrent latest release at the compensation boundary", async () => {
    const fake = new FakeGithub();
    const { directory, baseline } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const rollback = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), rollback);
    await promoteDesktopLatest(directory, fake.client(), rollback);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");
    const unrelated = fake.release(999, "other@1.0.0", false);
    let raced = false;
    const client = new GithubClient("yerzhansa/enduragent", "token", async (input, init) => {
      const response = await fake.fetch(input, init);
      if (
        !raced &&
        (init?.method ?? "GET") === "GET" &&
        String(input).endsWith(`/releases/${baseline.id}`)
      ) {
        raced = true;
        fake.transitionLatest(unrelated);
      }
      return response;
    });
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;

    vi.useFakeTimers();
    try {
      await expect(
        settleFakeTimerOperation(compensateDesktopRelease(directory, bodyPath, client, rollback)),
      ).rejects.toThrow("latest changed at the mutation boundary");
      expect(raced).toBe(true);
      expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
      expect(fake.latest?.id).toBe(unrelated.id);
      expect(fake.candidate.draft).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses compensation before candidate latest reconciliation without mutating releases", async () => {
    const fake = new FakeGithub();
    const { directory } = await steadyCandidate(fake);
    await stageDesktopRelease(directory, fake.client());
    const observed = await observeDesktopLatest(directory, fake.client());
    await publishDesktopRelease(directory, fake.client(), observed);
    const bodyDirectory = mkdtempSync(join(tmpdir(), "desktop-release-body-"));
    directories.push(bodyDirectory);
    const bodyPath = join(bodyDirectory, "body.md");
    writeFileSync(bodyPath, "release body");
    const patchCount = fake.calls.filter((call) => call.method === "PATCH").length;
    const latestCallsBefore = fake.calls.filter((call) =>
      call.url.endsWith("/releases/latest"),
    ).length;

    vi.useFakeTimers();
    try {
      const compensation = compensateDesktopRelease(directory, bodyPath, fake.client(), observed);
      const refused = expect(compensation).rejects.toThrow(
        "desktop compensation requires a reconciled candidate latest state",
      );
      await waitForPendingFakeTimer();
      await vi.runAllTimersAsync();
      await refused;
      expect(
        fake.calls.filter((call) => call.url.endsWith("/releases/latest")).length -
          latestCallsBefore,
      ).toBeLessThanOrEqual(240);
      expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(patchCount);
      expect(fake.candidate.draft).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers a complete retained baseline on a later page", async () => {
    const fake = new FakeGithub();
    const { baseline } = await steadyCandidate(fake);
    fake.pages = [
      Array.from({ length: 100 }, (_, index) =>
        fake.release(2000 + index, `other@${index}`, false),
      ),
      [baseline],
    ];
    const output = join(mkdtempSync(join(tmpdir(), "desktop-baseline-output-")), "output");
    directories.push(output.slice(0, output.lastIndexOf("/")));
    writeFileSync(output, "");
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(target);
    await prepareDesktopBaseline(
      target,
      fake.client(),
      "steady",
      candidateTag,
      candidateVersion,
      baseline.tag_name,
      output,
    );
    expect(readFileSync(output, "utf8")).toContain("baseline_release_id=122");
    expect(readFileSync(output, "utf8")).toContain("baseline_version=0.1.6");
    expect(readdirSync(target).sort()).toEqual([...releaseFileNames("0.1.6")].sort());
    expect(fake.calls.some((call) => call.url.includes("page=2"))).toBe(true);
  });

  it("accepts only the exact legacy first-signed desktop baseline", async () => {
    const fake = new FakeGithub();
    const legacyEnvelope = await sealed("0.1.0", "121");
    const legacy = fake.release(121, "cycling-coach@2026.8.8", false);
    fake.commits.set(legacy.tag_name, legacyEnvelope.manifest.commit);
    fake.addEnvelope(legacy, legacyEnvelope.directory, "0.1.0");
    fake.latest = legacy;
    fake.pages = [[legacy]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await prepareDesktopBaseline(
      target,
      fake.client(),
      "steady",
      "enduragent-desktop@0.1.1",
      "0.1.1",
      legacy.tag_name,
      output,
    );

    expect(readFileSync(output, "utf8")).toContain("baseline_tag=cycling-coach@2026.8.8");
    expect(readFileSync(output, "utf8")).toContain("baseline_version=0.1.0");
    expect(readdirSync(target).sort()).toEqual([...releaseFileNames("0.1.0")].sort());
  });

  it("accepts a stable DMG alias only when it matches the versioned release asset", async () => {
    const accepted = new FakeGithub();
    const acceptedCandidate = await steadyCandidate(accepted);
    const acceptedDmg = acceptedCandidate.baseline.assets.find((asset) =>
      asset.name.endsWith("-arm64.dmg"),
    )!;
    accepted.addAsset(
      acceptedCandidate.baseline,
      DESKTOP_STABLE_DMG_NAME,
      accepted.bytes.get(acceptedDmg.url)!,
    );
    const acceptedOutputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const acceptedTarget = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(acceptedOutputDirectory, acceptedTarget);
    const acceptedOutput = join(acceptedOutputDirectory, "output");
    writeFileSync(acceptedOutput, "");

    await prepareDesktopBaseline(
      acceptedTarget,
      accepted.client(),
      "steady",
      candidateTag,
      candidateVersion,
      acceptedCandidate.baseline.tag_name,
      acceptedOutput,
    );

    const rejected = new FakeGithub();
    const rejectedCandidate = await steadyCandidate(rejected);
    rejected.addAsset(
      rejectedCandidate.baseline,
      DESKTOP_STABLE_DMG_NAME,
      Buffer.from("wrong-dmg"),
    );
    const rejectedOutputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const rejectedTarget = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(rejectedOutputDirectory, rejectedTarget);
    const rejectedOutput = join(rejectedOutputDirectory, "output");
    writeFileSync(rejectedOutput, "");

    await expect(
      prepareDesktopBaseline(
        rejectedTarget,
        rejected.client(),
        "steady",
        candidateTag,
        candidateVersion,
        rejectedCandidate.baseline.tag_name,
        rejectedOutput,
      ),
    ).rejects.toThrow("desktop baseline");
  });

  it.each([
    ["cycling-coach@2026.8.9", "0.1.0"],
    ["cycling-coach@2026.8.8", "0.1.1"],
    ["enduragent-desktop@0.1.1", "0.1.0"],
  ])("rejects a noncanonical desktop baseline %s carrying %s assets", async (tag, version) => {
    const fake = new FakeGithub();
    const envelope = await sealed(version, "121");
    const release = fake.release(121, tag, false);
    fake.commits.set(release.tag_name, envelope.manifest.commit);
    fake.addEnvelope(release, envelope.directory, version);
    fake.latest = release;
    fake.pages = [[release]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await expect(
      prepareDesktopBaseline(
        target,
        fake.client(),
        "steady",
        candidateTag,
        candidateVersion,
        tag,
        output,
      ),
    ).rejects.toThrow("desktop baseline");
    expect(readdirSync(target)).toEqual([]);
  });

  it("requires the candidate desktop tag to equal the candidate app version", async () => {
    const fake = new FakeGithub();
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await expect(
      prepareDesktopBaseline(
        target,
        fake.client(),
        "genesis",
        "enduragent-desktop@0.1.8",
        candidateVersion,
        "none",
        output,
      ),
    ).rejects.toThrow("tag and version do not match");
    expect(fake.calls).toEqual([]);
  });

  it("refuses retired genesis baseline resolution before reading GitHub state", async () => {
    const fake = new FakeGithub();
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await expect(
      prepareDesktopBaseline(
        target,
        fake.client(),
        "genesis",
        candidateTag,
        candidateVersion,
        "none",
        output,
      ),
    ).rejects.toThrow("genesis release authority is retired");
    expect(fake.calls).toEqual([]);
  });

  it("uses the requested retained baseline instead of a newer failed draft", async () => {
    const fake = new FakeGithub();
    const { baseline } = await steadyCandidate(fake);
    const failed = await sealed("0.1.8", "124");
    const failedRelease = fake.release(124, "enduragent-desktop@0.1.8", true);
    fake.commits.set(failedRelease.tag_name, failed.manifest.commit);
    fake.addEnvelope(failedRelease, failed.directory, "0.1.8");
    fake.pages = [[failedRelease, baseline]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");

    await prepareDesktopBaseline(
      target,
      fake.client(),
      "steady",
      "enduragent-desktop@0.1.9",
      "0.1.9",
      baseline.tag_name,
      output,
    );

    expect(readFileSync(output, "utf8")).toContain("baseline_release_id=122");
    expect(readFileSync(output, "utf8")).not.toContain("baseline_release_id=124");
  });

  it("requires N+1 latest instead of reusing N as the N+2 baseline", async () => {
    const fake = new FakeGithub();
    const { baseline } = await steadyCandidate(fake);
    const accepted = await sealed("0.1.7", "124");
    const latest = fake.release(124, "enduragent-desktop@0.1.7", false);
    fake.commits.set(latest.tag_name, accepted.manifest.commit);
    fake.addEnvelope(latest, accepted.directory, "0.1.7");
    fake.latest = latest;
    fake.pages = [[latest, baseline]];
    const outputDirectory = mkdtempSync(join(tmpdir(), "desktop-baseline-output-"));
    const target = mkdtempSync(join(tmpdir(), "desktop-baseline-target-"));
    directories.push(outputDirectory, target);
    const output = join(outputDirectory, "output");
    writeFileSync(output, "");
    await expect(
      prepareDesktopBaseline(
        target,
        fake.client(),
        "steady",
        "enduragent-desktop@0.1.8",
        "0.1.8",
        baseline.tag_name,
        output,
      ),
    ).rejects.toThrow("must match the accepted desktop latest release");
  });

  it("refuses latest metadata CAS drift before mutation", async () => {
    const fake = new FakeGithub();
    const { directory, baseline } = await steadyCandidate(fake);
    fake.candidate.draft = false;
    fake.addEnvelope(fake.candidate, directory, candidateVersion);
    baseline.draft = false;
    fake.latest = baseline;
    const metadata = baseline.assets.find((asset) => asset.name === "latest-mac.yml")!;
    const observed = {
      id: baseline.id,
      tag: baseline.tag_name,
      metadataSha256: digest(fake.bytes.get(metadata.url)!, "sha256", "hex"),
    };
    fake.bytes.set(metadata.url, Buffer.from("changed"));
    await expect(promoteDesktopLatest(directory, fake.client(), observed)).rejects.toMatchObject({
      outcome: "unapplied",
      message: "repository latest and updater feed digest differ",
    });
    expect(
      fake.calls.some((call) => call.method === "PATCH" && call.url.endsWith("/releases/123")),
    ).toBe(false);
  });
});
