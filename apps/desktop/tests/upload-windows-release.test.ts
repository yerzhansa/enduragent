import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedWindowsReleaseAssets } from "../scripts/verify-windows-release.mjs";
import { runWindowsReleaseUpload } from "../scripts/upload-windows-release.mjs";
import {
  serializeWindowsReleaseUpdaterMetadata,
  windowsReleaseArtifactNames,
  windowsUpdaterMetadataDigest,
} from "../scripts/windows-release-plan.mjs";
import { DESKTOP_FEED_URL } from "../../../tools/desktop-update-feed.js";

const version = "0.1.5";
const commit = "a".repeat(40);
const publisherDn = "CN=Enduragent Test Publisher, O=Enduragent Test";
const tag = `enduragent-desktop@${version}`;
const repository = "yerzhansa/enduragent";
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/upload-windows-release.mjs",
);
const temporaryRoots: string[] = [];
let directory: string;
let appUpdateMetadataPath: string;
let verified: VerifiedWindowsReleaseAssets;

function digestOf(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "windows-release-upload-"));
  temporaryRoots.push(directory);
  const names = windowsReleaseArtifactNames(version);
  const contents = {
    installer: Buffer.from("signed installer"),
    blockmap: Buffer.from("blockmap"),
    metadata: Buffer.from("metadata"),
  };
  const appUpdateMetadata = serializeWindowsReleaseUpdaterMetadata(
    DESKTOP_FEED_URL,
    publisherDn,
  );
  const paths = {
    installer: join(directory, names.installer),
    blockmap: join(directory, names.blockmap),
    metadata: join(directory, names.metadata),
  };
  appUpdateMetadataPath = join(directory, "..", `app-update-${process.pid}.yml`);
  temporaryRoots.push(appUpdateMetadataPath);
  await Promise.all([
    writeFile(paths.installer, contents.installer),
    writeFile(paths.blockmap, contents.blockmap),
    writeFile(paths.metadata, contents.metadata),
    writeFile(appUpdateMetadataPath, appUpdateMetadata),
  ]);
  verified = {
    version,
    commit,
    names,
    paths,
    sizes: {
      installer: contents.installer.length,
      blockmap: contents.blockmap.length,
      metadata: contents.metadata.length,
    },
    installerSha512: createHash("sha512").update(contents.installer).digest("base64"),
    installerSha256: createHash("sha256").update(contents.installer).digest("hex"),
    files: [
      {
        name: names.installer,
        size: contents.installer.length,
        sha256: createHash("sha256").update(contents.installer).digest("hex"),
      },
      {
        name: names.blockmap,
        size: contents.blockmap.length,
        sha256: createHash("sha256").update(contents.blockmap).digest("hex"),
      },
      {
        name: names.metadata,
        size: contents.metadata.length,
        sha256: createHash("sha256").update(contents.metadata).digest("hex"),
      },
    ],
    updaterMetadataSha256: windowsUpdaterMetadataDigest(appUpdateMetadata),
    authenticode: "verified",
    bytes: contents,
  };
});

function releaseAssetsApi(names: readonly string[] = Object.values(verified.names)) {
  const byName = new Map([
    [verified.names.installer, verified.bytes.installer],
    [verified.names.blockmap, verified.bytes.blockmap],
    [verified.names.metadata, verified.bytes.metadata],
  ] as const);
  return JSON.stringify({
    tag_name: tag,
    assets: names.map((name, index) => {
      const bytes = byName.get(name) ?? Buffer.from("other");
      return { id: 1000 + index, name, size: bytes.length, digest: digestOf(bytes) };
    }),
  });
}

function release(assets: readonly string[] = [], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "123",
    tagName: tag,
    isDraft: false,
    isPrerelease: false,
    assets: assets.map((name) => ({ name })),
    ...overrides,
  });
}

function successfulExecutor(
  options: {
    readonly initialAssets?: readonly string[];
    readonly reference?: { readonly type: "commit" | "tag"; readonly sha: string };
    readonly peeled?: { readonly type: "commit" | "tag"; readonly sha: string };
    readonly latestTag?: string;
    readonly latestTagAfterUpload?: string;
    readonly assetsApi?: string;
    readonly onUpload?: (paths: readonly string[]) => Promise<void> | void;
    readonly onDelete?: (id: string) => Promise<void> | void;
  } = {},
) {
  let views = 0;
  let uploads = 0;
  const deleted: string[] = [];
  return vi.fn(async (_executable: string, arguments_: readonly string[]) => {
    if (arguments_[0] === "release" && arguments_[1] === "view") {
      views += 1;
      const uploadedNames = Object.values(verified.names).filter(
        (_name, index) => !deleted.includes(String(1000 + index)),
      );
      return {
        stdout:
          views === 1
            ? release(options.initialAssets ?? [`Enduragent-${version}-arm64.dmg`])
            : release(uploadedNames),
      };
    }
    if (arguments_[0] === "release" && arguments_[1] === "upload") {
      uploads += 1;
      await options.onUpload?.(arguments_.slice(5));
      return { stdout: "" };
    }
    if (arguments_[0] === "api" && arguments_[1] === "-X" && arguments_[2] === "DELETE") {
      const id = arguments_[3]?.split("/").at(-1) ?? "";
      await options.onDelete?.(id);
      deleted.push(id);
      return { stdout: "" };
    }
    if (arguments_[0] === "api" && arguments_[1]?.endsWith("/releases/latest")) {
      const latestTag =
        uploads > 0
          ? (options.latestTagAfterUpload ?? options.latestTag ?? tag)
          : (options.latestTag ?? tag);
      return { stdout: JSON.stringify({ tag_name: latestTag }) };
    }
    if (arguments_[0] === "api" && arguments_[1]?.includes("/releases/tags/")) {
      return { stdout: options.assetsApi ?? releaseAssetsApi() };
    }
    if (arguments_[0] === "api" && arguments_[1]?.includes("/git/ref/tags/")) {
      return {
        stdout: JSON.stringify({ object: options.reference ?? { type: "commit", sha: commit } }),
      };
    }
    if (arguments_[0] === "api" && arguments_[1]?.includes("/git/tags/")) {
      return {
        stdout: JSON.stringify({ object: options.peeled ?? { type: "commit", sha: commit } }),
      };
    }
    return { stdout: "" };
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    version,
    directory,
    commit,
    authenticode: "verify" as const,
    publisherDn,
    appUpdateMetadata: appUpdateMetadataPath,
    ...overrides,
  };
}

describe("Windows release upload", () => {
  it("verifies locally, views the release, and uploads installer, blockmap, then metadata", async () => {
    const uploadedBytes: Buffer[] = [];
    let uploadedPaths: readonly string[] = [];
    const executeFile = successfulExecutor({
      onUpload: async (paths) => {
        uploadedPaths = paths;
        for (const path of paths) uploadedBytes.push(await readFile(path));
      },
    });
    const verifyAssets = vi.fn(async () => verified);
    await runWindowsReleaseUpload(input(), { executeFile, verifyAssets });
    expect(verifyAssets).toHaveBeenCalledWith(directory, {
      version,
      commit,
      expectedPublisherName: publisherDn,
      appUpdateMetadata: await readFile(appUpdateMetadataPath),
      authenticode: expect.objectContaining({ mode: "verify", expectedPublisherDn: publisherDn }),
    });
    expect(uploadedPaths).toHaveLength(3);
    expect(uploadedPaths.every((path) => !path.startsWith(directory))).toBe(true);
    expect(uploadedPaths.map((path) => path.split(/[\\/]/u).at(-1))).toEqual(
      Object.values(verified.names),
    );
    expect(uploadedBytes).toEqual([
      verified.bytes.installer,
      verified.bytes.blockmap,
      verified.bytes.metadata,
    ]);
    await expect(stat(uploadedPaths[0]!)).rejects.toThrow();
    const viewArguments = [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "id,tagName,isDraft,isPrerelease,assets",
    ];
    expect(executeFile.mock.calls[0]).toEqual(["gh-personal", viewArguments]);
    expect(executeFile.mock.calls[1]).toEqual([
      "gh-personal",
      ["api", `repos/${repository}/releases/latest`],
    ]);
    expect(executeFile.mock.calls[2]).toEqual([
      "gh-personal",
      ["api", `repos/${repository}/git/ref/tags/${tag}`],
    ]);
    expect(executeFile.mock.calls[3]).toEqual([
      "gh-personal",
      ["release", "upload", tag, "--repo", repository, ...uploadedPaths],
    ]);
    expect(executeFile.mock.calls[4]).toEqual(["gh-personal", viewArguments]);
    expect(executeFile.mock.calls[5]).toEqual([
      "gh-personal",
      ["api", `repos/${repository}/releases/tags/${tag}`],
    ]);
    expect(executeFile.mock.calls[6]).toEqual([
      "gh-personal",
      ["api", `repos/${repository}/releases/latest`],
    ]);
    expect(executeFile.mock.calls).toHaveLength(7);
    expect(executeFile.mock.calls.flat(2)).not.toContain("--clobber");
    expect(executeFile.mock.calls.flat(2)).not.toContain(verified.paths.installer);
  });

  it("removes the uploaded assets when the release stops being latest during the upload", async () => {
    const record = join(directory, "..", `upload-record-rollback-${process.pid}.json`);
    temporaryRoots.push(record);
    const verifyAssets = vi.fn(async () => verified);
    const executeFile = successfulExecutor({ latestTagAfterUpload: "enduragent-desktop@0.1.7" });
    await expect(
      runWindowsReleaseUpload(input({ record }), { executeFile, verifyAssets }),
    ).rejects.toThrow("release lost latest status during upload; Windows assets removed");
    const deletes = executeFile.mock.calls
      .filter(([, arguments_]) => arguments_[1] === "-X" && arguments_[2] === "DELETE")
      .map(([, arguments_]) => arguments_[3]);
    expect(deletes).toEqual([
      `repos/${repository}/releases/assets/1000`,
      `repos/${repository}/releases/assets/1001`,
      `repos/${repository}/releases/assets/1002`,
    ]);
    const written = JSON.parse(await readFile(record, "utf8"));
    expect(written.status).toBe("failed");
    expect(written.uploaded).toBe(false);
    expect(written.uploadedAssets).toEqual([]);
    expect(written.error).toBe("release lost latest status during upload; Windows assets removed");
  });

  it("reports an incomplete upload when the rollback of a non-latest release fails", async () => {
    const record = join(directory, "..", `upload-record-rollback-fail-${process.pid}.json`);
    temporaryRoots.push(record);
    const verifyAssets = vi.fn(async () => verified);
    const executeFile = successfulExecutor({
      latestTagAfterUpload: "enduragent-desktop@0.1.7",
      onDelete: (id) => {
        if (id === "1001") throw new Error("boom");
      },
    });
    await expect(
      runWindowsReleaseUpload(input({ record }), { executeFile, verifyAssets }),
    ).rejects.toThrow("Windows release upload is incomplete");
    const written = JSON.parse(await readFile(record, "utf8"));
    expect(written.uploaded).toBe(true);
    expect(written.uploadedAssets).toEqual([verified.names.blockmap, verified.names.metadata]);
  });

  it("refuses to delete when a GitHub asset has no numeric id", async () => {
    const withoutIds = JSON.parse(releaseAssetsApi()) as { assets: { id?: number }[] };
    for (const asset of withoutIds.assets) delete asset.id;
    const executeFile = successfulExecutor({
      latestTagAfterUpload: "enduragent-desktop@0.1.7",
      assetsApi: JSON.stringify(withoutIds),
    });
    await expect(
      runWindowsReleaseUpload(input(), { executeFile, verifyAssets: vi.fn(async () => verified) }),
    ).rejects.toThrow("Windows release upload is incomplete");
    expect(executeFile.mock.calls.flat(2)).not.toContain("DELETE");
  });

  it("reports an incomplete upload when the post-upload latest check is unavailable", async () => {
    const base = successfulExecutor();
    let uploads = 0;
    const executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (arguments_[0] === "release" && arguments_[1] === "upload") uploads += 1;
      if (uploads > 0 && arguments_[1]?.endsWith("/releases/latest")) throw new Error("offline");
      return base(executable, arguments_);
    });
    await expect(
      runWindowsReleaseUpload(input(), { executeFile, verifyAssets: vi.fn(async () => verified) }),
    ).rejects.toThrow("Windows release upload is incomplete");
    expect(executeFile.mock.calls.flat(2)).not.toContain("DELETE");
  });

  it("uploads the verified bytes even when the artifact file changes after verification", async () => {
    const uploadedBytes: Buffer[] = [];
    const executeFile = successfulExecutor({
      onUpload: async (paths) => {
        for (const path of paths) uploadedBytes.push(await readFile(path));
      },
    });
    const verifyAssets = vi.fn(async () => {
      await writeFile(verified.paths.installer, Buffer.from("TAMPERED installer"));
      return verified;
    });
    await runWindowsReleaseUpload(input(), { executeFile, verifyAssets });
    expect(uploadedBytes[0]).toEqual(verified.bytes.installer);
    expect(await readFile(verified.paths.installer)).toEqual(Buffer.from("TAMPERED installer"));
  });

  it("refuses an upload to a release that is not the repository's latest", async () => {
    const executeFile = successfulExecutor({ latestTag: "enduragent-desktop@0.1.6" });
    await expect(
      runWindowsReleaseUpload(input(), { executeFile, verifyAssets: vi.fn(async () => verified) }),
    ).rejects.toThrow("release is not the latest release");
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("fails when a GitHub asset digest or size differs from the uploaded bytes", async () => {
    const wrong = JSON.parse(releaseAssetsApi()) as {
      assets: { name: string; size: number; digest: string }[];
    };
    wrong.assets[1]!.digest = digestOf(Buffer.from("other blockmap"));
    const recordPath = join(directory, "..", `upload-record-digest-${process.pid}.json`);
    temporaryRoots.push(recordPath);
    await expect(
      runWindowsReleaseUpload(input({ record: recordPath }), {
        executeFile: successfulExecutor({ assetsApi: JSON.stringify(wrong) }),
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow("Windows release asset digest mismatch");
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
      status: "failed",
      error: "Windows release asset digest mismatch",
      uploaded: true,
      uploadedAssets: Object.values(verified.names),
    });
  });

  it("requires a readable absolute app-update.yml path before verification", async () => {
    const executeFile = successfulExecutor();
    const verifyAssets = vi.fn(async () => verified);
    await expect(
      runWindowsReleaseUpload(input({ appUpdateMetadata: "relative/app-update.yml" }), {
        executeFile,
        verifyAssets,
      }),
    ).rejects.toThrow("app-update.yml path must be absolute");
    await expect(
      runWindowsReleaseUpload(input({ appUpdateMetadata: join(directory, "..", "missing.yml") }), {
        executeFile,
        verifyAssets,
      }),
    ).rejects.toThrow("app-update.yml is unreadable");
    expect(verifyAssets).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("refuses app-update.yml bytes that do not match the digest sealed by verification", async () => {
    const substituted = serializeWindowsReleaseUpdaterMetadata(
      "https://updates.example.test/",
      publisherDn,
    );
    await writeFile(appUpdateMetadataPath, substituted);
    const executeFile = successfulExecutor();
    const verifyAssets = vi.fn(async () => verified);
    await expect(runWindowsReleaseUpload(input(), { executeFile, verifyAssets })).rejects.toThrow(
      "app-update.yml does not match the signed installer",
    );
    expect(verifyAssets).toHaveBeenCalledWith(
      directory,
      expect.objectContaining({ appUpdateMetadata: substituted }),
    );
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("binds a matching lightweight release tag to the commit", async () => {
    const result = await runWindowsReleaseUpload(input(), {
      executeFile: successfulExecutor(),
      verifyAssets: vi.fn(async () => verified),
    });
    expect(result.tagCommit).toBe(commit);
  });

  it("peels a matching annotated release tag to the commit", async () => {
    const tagObject = "b".repeat(40);
    const executeFile = successfulExecutor({
      reference: { type: "tag", sha: tagObject },
      peeled: { type: "commit", sha: commit },
    });
    const result = await runWindowsReleaseUpload(input(), {
      executeFile,
      verifyAssets: vi.fn(async () => verified),
    });
    expect(result.tagCommit).toBe(commit);
    expect(executeFile.mock.calls[3]).toEqual([
      "gh-personal",
      ["api", `repos/${repository}/git/tags/${tagObject}`],
    ]);
  });

  it("refuses a release tag commit mismatch before upload", async () => {
    const executeFile = successfulExecutor({
      reference: { type: "commit", sha: "b".repeat(40) },
    });
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow("release commit mismatch");
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses an unresolvable release tag before upload", async () => {
    const executeFile = successfulExecutor({
      reference: { type: "commit", sha: "short" },
    });
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow("release tag is unresolvable");
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses a missing or unparsable release", async () => {
    const executeFile = vi.fn(async () => Promise.reject(new Error("not found")));
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release does not exist: ${tag}`);
  });

  it("refuses a draft release", async () => {
    const executeFile = vi.fn(async () => ({ stdout: release([], { isDraft: true }) }));
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release is still a draft: ${tag}`);
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses a prerelease release", async () => {
    const executeFile = vi.fn(async () => ({ stdout: release([], { isPrerelease: true }) }));
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release is a prerelease: ${tag}`);
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses pre-existing Windows assets", async () => {
    const existing = verified.names.blockmap;
    const executeFile = successfulExecutor({ initialAssets: [existing] });
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`Windows release asset already exists: ${existing}`);
  });

  it("refuses a pre-existing upload record before verification or GitHub access", async () => {
    const recordPath = join(directory, "..", `upload-record-existing-${process.pid}.json`);
    temporaryRoots.push(recordPath);
    await writeFile(recordPath, "existing");
    const executeFile = successfulExecutor();
    const verifyAssets = vi.fn(async () => verified);
    await expect(
      runWindowsReleaseUpload(input({ record: recordPath }), { executeFile, verifyAssets }),
    ).rejects.toThrow("upload record already exists");
    expect(verifyAssets).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("writes a safe failed record when release lookup fails", async () => {
    const recordPath = join(directory, "..", `upload-record-failed-${process.pid}.json`);
    temporaryRoots.push(recordPath);
    const executeFile = vi.fn(async () => Promise.reject(new Error("not found")));
    await expect(
      runWindowsReleaseUpload(input({ record: recordPath }), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release does not exist: ${tag}`);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual({
      schemaVersion: 1,
      tag,
      version,
      commit,
      arch: "x64",
      status: "failed",
      error: `release does not exist: ${tag}`,
      uploaded: false,
      uploadedAssets: [],
    });
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("records the assets that became public when a multi-asset upload fails partway", async () => {
    const recordPath = join(directory, "..", `upload-record-${process.pid}.json`);
    temporaryRoots.push(recordPath);
    let views = 0;
    const executeFile = vi.fn(async (_executable: string, arguments_: readonly string[]) => {
      if (arguments_[0] === "release" && arguments_[1] === "view") {
        views += 1;
        return {
          stdout:
            views === 1
              ? release([])
              : release([verified.names.installer, verified.names.blockmap]),
        };
      }
      if (arguments_[0] === "api" && arguments_[1]?.endsWith("/releases/latest")) {
        return { stdout: JSON.stringify({ tag_name: tag }) };
      }
      if (arguments_[0] === "api") {
        return { stdout: JSON.stringify({ object: { type: "commit", sha: commit } }) };
      }
      throw new Error("upload interrupted");
    });
    await expect(
      runWindowsReleaseUpload(input({ record: recordPath }), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow("Windows release upload is incomplete");
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
      status: "failed",
      error: "Windows release upload is incomplete",
      uploaded: true,
      uploadedAssets: [verified.names.installer, verified.names.blockmap],
    });
  });

  it("records an unknown upload state when reconciliation fails after an upload error", async () => {
    const recordPath = join(directory, "..", `upload-record-unknown-${process.pid}.json`);
    temporaryRoots.push(recordPath);
    let views = 0;
    const executeFile = vi.fn(async (_executable: string, arguments_: readonly string[]) => {
      if (arguments_[0] === "release" && arguments_[1] === "view") {
        views += 1;
        if (views === 1) return { stdout: release([]) };
        throw new Error("network");
      }
      if (arguments_[0] === "api" && arguments_[1]?.endsWith("/releases/latest")) {
        return { stdout: JSON.stringify({ tag_name: tag }) };
      }
      if (arguments_[0] === "api") {
        return { stdout: JSON.stringify({ object: { type: "commit", sha: commit } }) };
      }
      throw new Error("upload interrupted");
    });
    await expect(
      runWindowsReleaseUpload(input({ record: recordPath }), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow("Windows release upload is incomplete");
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({
      status: "failed",
      uploaded: "unknown",
      uploadedAssets: null,
    });
  });

  it("refuses an upload record inside the artifact directory before touching it", async () => {
    const executeFile = successfulExecutor();
    const verifyAssets = vi.fn(async () => verified);
    for (const recordPath of [
      join(directory, "upload-record.json"),
      join(directory, "..record.json"),
    ]) {
      await expect(
        runWindowsReleaseUpload(input({ record: recordPath }), { executeFile, verifyAssets }),
      ).rejects.toThrow("upload record must be outside the artifact directory");
      await expect(stat(recordPath)).rejects.toThrow();
    }
    expect(verifyAssets).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("refuses the placeholder or missing publisher DN before verification", async () => {
    const executeFile = vi.fn(async () => ({ stdout: "" }));
    const verifyAssets = vi.fn(async () => verified);
    await expect(
      runWindowsReleaseUpload(
        input({ publisherDn: "CN=ENDURAGENT PUBLISHER DN PLACEHOLDER, O=PLACEHOLDER" }),
        { executeFile, verifyAssets },
      ),
    ).rejects.toThrow("Windows publisher DN is invalid");
    await expect(
      runWindowsReleaseUpload(input({ publisherDn: undefined }), { executeFile, verifyAssets }),
    ).rejects.toThrow("Windows publisher DN is invalid");
    expect(verifyAssets).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("refuses an installer the verifier did not mark as Authenticode verified", async () => {
    const executeFile = successfulExecutor();
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => ({ ...verified, authenticode: "pending-w19" }) as never),
      }),
    ).rejects.toThrow("unsigned Windows installer refused");
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("refuses unsupported Authenticode modes before verification or upload", async () => {
    const executeFile = vi.fn(async () => ({ stdout: "" }));
    const verifyAssets = vi.fn(async () => verified);
    await expect(
      runWindowsReleaseUpload(input({ authenticode: "pending-w19" }) as never, {
        executeFile,
        verifyAssets,
      }),
    ).rejects.toThrow("Authenticode verification mode is required");
    expect(verifyAssets).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("rejects an unsupported Authenticode CLI value before invoking GitHub", () => {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--version",
        version,
        "--directory",
        directory,
        "--commit",
        commit,
        "--authenticode",
        "pending-w19",
        "--publisher-dn",
        publisherDn,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Authenticode verification mode is required\n");
  });

  it("writes an owner-only immutable upload record with all file hashes", async () => {
    const recordPath = join(directory, "..", `upload-record-ok-${process.pid}.json`);
    temporaryRoots.push(recordPath);
    const result = await runWindowsReleaseUpload(input({ record: recordPath }), {
      executeFile: successfulExecutor(),
      verifyAssets: vi.fn(async () => verified),
    });
    const recorded = JSON.parse(await readFile(recordPath, "utf8"));
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    expect(recorded).toEqual(result);
    expect(recorded).toMatchObject({
      schemaVersion: 1,
      tag,
      version,
      commit,
      tagCommit: commit,
      arch: "x64",
      status: "uploaded",
      authenticode: "verified",
    });
    expect(recorded.files.map((file: { name: string }) => file.name)).toEqual([
      verified.names.installer,
      verified.names.blockmap,
      verified.names.metadata,
    ]);
    expect(
      recorded.files.every((file: { sha256: string }) => /^[0-9a-f]{64}$/u.test(file.sha256)),
    ).toBe(true);
  });
});
