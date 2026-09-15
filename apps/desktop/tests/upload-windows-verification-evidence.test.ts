import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWindowsVerificationEvidenceUpload,
  safeWindowsVerificationEvidenceMessage,
} from "../scripts/upload-windows-verification-evidence.mjs";

const version = "0.1.7";
const tag = `enduragent-desktop@${version}`;
const repository = "yerzhansa/enduragent";
const releaseId = "123";
const commit = "a".repeat(40);
const catalog = {
  releaseGroupId: commit,
  revision: 1,
  digest: "0".repeat(64),
};
const evidenceName = `Enduragent-${version}-x64-verification.json`;
const uploadUrl = `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets{?name,label}`;

let directory: string;
let evidencePath: string;
let evidenceBytes: Buffer;
const verifiedFiles = [
  { id: 101, name: `Enduragent-${version}-x64.exe`, size: 11, sha256: "d".repeat(64) },
  {
    id: 102,
    name: `Enduragent-${version}-x64.exe.blockmap`,
    size: 12,
    sha256: "e".repeat(64),
  },
  { id: 103, name: "latest.yml", size: 13, sha256: "f".repeat(64) },
];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "windows-verification-evidence-"));
  evidencePath = join(directory, evidenceName);
  evidenceBytes = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 3,
      tag,
      version,
      commit,
      catalog,
      arch: "x64",
      authenticode: "verified",
      installerSha256: "b".repeat(64),
      publisherDnSha256: "c".repeat(64),
      files: verifiedFiles.map((file) =>
        file.name === `Enduragent-${version}-x64.exe` ? { ...file, sha256: "b".repeat(64) } : file,
      ),
    })}\n`,
  );
  await writeFile(evidencePath, evidenceBytes);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function expectedAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 777,
    name: evidenceName,
    state: "uploaded",
    size: evidenceBytes.length,
    digest: `sha256:${createHash("sha256").update(evidenceBytes).digest("hex")}`,
    ...overrides,
  };
}

function release(
  assets: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
  releaseFiles: readonly Record<string, unknown>[] = verifiedFiles.map((file) =>
    file.name === `Enduragent-${version}-x64.exe` ? { ...file, sha256: "b".repeat(64) } : file,
  ),
) {
  return JSON.stringify({
    id: Number(releaseId),
    tag_name: tag,
    draft: false,
    prerelease: false,
    upload_url: uploadUrl,
    assets: [
      ...releaseFiles.map((file) => ({
        id: file.id,
        name: file.name,
        state: "uploaded",
        size: file.size,
        digest: `sha256:${file.sha256}`,
      })),
      ...assets,
    ],
    ...overrides,
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    version,
    repository,
    releaseId,
    commit,
    evidencePath,
    ...overrides,
  };
}

function harness(
  options: {
    existing?: Record<string, unknown> | null;
    createOnUpload?: boolean;
    throwAfterUpload?: boolean;
    changeLatestAfterUpload?: boolean;
    changeWindowsAssetsAfterUpload?: boolean;
    changeLatestAfterPromotion?: boolean;
    uploadAssetOverrides?: Record<string, unknown>;
    failPromotionBeforeCommit?: boolean;
    throwAfterPromotion?: boolean;
    canonicalBeforePromotion?: Record<string, unknown>;
    replaceStagingAfterUpload?: Record<string, unknown>;
    replaceCanonicalAfterPromotion?: Record<string, unknown>;
    failDelete?: boolean;
  } = {},
) {
  let assets =
    options.existing === null || options.existing === undefined ? [] : [options.existing];
  let stagingName: string | null = null;
  let uploadAttempted = false;
  let promotionAttempted = false;
  let stagingReplaced = false;
  let canonicalReplaced = false;
  let concurrentCanonicalAdded = false;
  const deleteAttempts: number[] = [];

  function applyReplacementSeams() {
    if (
      uploadAttempted &&
      !promotionAttempted &&
      !stagingReplaced &&
      options.replaceStagingAfterUpload !== undefined
    ) {
      stagingReplaced = true;
      assets = [
        ...assets.filter((asset) => asset.id !== 777),
        { ...options.replaceStagingAfterUpload, name: stagingName },
      ];
    }
    if (
      promotionAttempted &&
      !canonicalReplaced &&
      options.replaceCanonicalAfterPromotion !== undefined
    ) {
      canonicalReplaced = true;
      assets = [
        ...assets.filter((asset) => asset.id !== 777),
        { ...options.replaceCanonicalAfterPromotion, name: evidenceName },
      ];
    }
  }

  const executeFile = vi.fn(async (_executable: string, arguments_: readonly string[]) => {
    if (arguments_[0] !== "api") throw new Error("unexpected command");
    const endpoint = arguments_.at(-1) ?? "";
    if (arguments_[1] === "-X" && arguments_[2] === "DELETE") {
      const id = Number(endpoint.split("/").at(-1));
      deleteAttempts.push(id);
      if (options.failDelete) throw new Error("delete failed");
      const before = assets.length;
      assets = assets.filter((asset) => asset.id !== id);
      if (assets.length === before) throw new Error("asset not found");
      return { stdout: "" };
    }
    if (arguments_[1] === "-X" && arguments_[2] === "PATCH") {
      promotionAttempted = true;
      if (!concurrentCanonicalAdded && options.canonicalBeforePromotion !== undefined) {
        concurrentCanonicalAdded = true;
        assets.push(options.canonicalBeforePromotion);
      }
      const id = Number(endpoint.split("/").at(-1));
      const index = assets.findIndex((asset) => asset.id === id);
      if (options.failPromotionBeforeCommit || index === -1) {
        throw new Error("promotion failed");
      }
      if (assets.some((asset) => asset.id !== id && asset.name === evidenceName)) {
        throw new Error("duplicate name");
      }
      assets[index] = { ...assets[index], name: evidenceName };
      if (options.throwAfterPromotion) throw new Error("connection closed");
      return { stdout: JSON.stringify(assets[index]) };
    }
    if (endpoint === `repos/${repository}/releases/${releaseId}`) {
      applyReplacementSeams();
      const releaseFiles =
        uploadAttempted && options.changeWindowsAssetsAfterUpload
          ? verifiedFiles.map((file, index) =>
              index === 1 ? { ...file, digest: "unused", sha256: "0".repeat(64) } : file,
            )
          : undefined;
      return {
        stdout: release(assets, {}, releaseFiles),
      };
    }
    if (endpoint === `repos/${repository}/releases/latest`) {
      if (
        (uploadAttempted && options.changeLatestAfterUpload) ||
        (promotionAttempted && options.changeLatestAfterPromotion)
      ) {
        return {
          stdout: release([], {
            id: 999,
            tag_name: "enduragent-desktop@0.1.8",
            upload_url: `https://uploads.github.com/repos/${repository}/releases/999/assets{?name,label}`,
          }),
        };
      }
      return { stdout: release(assets) };
    }
    if (endpoint === `repos/${repository}/git/ref/tags/${tag}`) {
      return { stdout: JSON.stringify({ object: { type: "commit", sha: commit } }) };
    }
    throw new Error(`unexpected endpoint: ${endpoint}`);
  });
  const uploadAsset = vi.fn(async (_url: string, name: string, _bytes: Buffer) => {
    uploadAttempted = true;
    stagingName = name;
    if (options.createOnUpload !== false) {
      assets.push(expectedAsset({ name, ...options.uploadAssetOverrides }));
    }
    if (options.throwAfterUpload) throw new Error("connection closed");
    return assets.find((asset) => asset.id === 777) ?? null;
  });
  const delay = vi.fn(async () => {});
  return {
    executeFile,
    uploadAsset,
    delay,
    deleteAttempts,
    get assets() {
      return assets;
    },
    get stagingName() {
      return stagingName;
    },
  };
}

describe("Windows verification evidence upload", () => {
  it("uploads under an unguessable safe staging name and promotes the owned id", async () => {
    const fake = harness();
    const result = await runWindowsVerificationEvidenceUpload(input(), fake);
    expect(result).toMatchObject({
      status: "uploaded",
      releaseId,
      commit,
      assetId: 777,
      name: evidenceName,
    });
    expect(fake.stagingName).toMatch(/^Enduragent-Windows-verification-staging-[0-9a-f]{48}$/u);
    expect(fake.uploadAsset).toHaveBeenCalledWith(
      uploadUrl.slice(0, -"{?name,label}".length),
      fake.stagingName,
      evidenceBytes,
    );
    expect(fake.executeFile).toHaveBeenCalledWith("gh", [
      "api",
      "-X",
      "PATCH",
      "-f",
      `name=${evidenceName}`,
      `repos/${repository}/releases/assets/777`,
    ]);
    expect(fake.deleteAttempts).toEqual([]);
    expect(fake.assets).toEqual([expectedAsset()]);
  });

  it("is idempotent only for the same release, asset id, size, and digest", async () => {
    const fake = harness({ existing: expectedAsset() });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).resolves.toMatchObject({
      status: "existing",
      assetId: 777,
    });
    expect(fake.uploadAsset).not.toHaveBeenCalled();
    expect(fake.assets).toEqual([expectedAsset()]);

    const conflict = harness({ existing: expectedAsset({ digest: `sha256:${"0".repeat(64)}` }) });
    await expect(runWindowsVerificationEvidenceUpload(input(), conflict)).rejects.toThrow(
      "existing Windows verification evidence conflicts with this run",
    );
    expect(conflict.uploadAsset).not.toHaveBeenCalled();
  });

  it("recovers an ambiguously committed upload and promotes that run's staging id", async () => {
    const fake = harness({ throwAfterUpload: true });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).resolves.toMatchObject({
      status: "uploaded",
      assetId: 777,
      name: evidenceName,
    });
    expect(fake.deleteAttempts).toEqual([]);
    expect(fake.assets).toEqual([expectedAsset()]);
  });

  it("removes the recovered staging id when latest identity changes after an ambiguous POST", async () => {
    const fake = harness({ throwAfterUpload: true, changeLatestAfterUpload: true });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "release identity changed during evidence upload; verification evidence removed",
    );
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([]);
  });

  it("removes the recovered staging id when a Windows asset changes after an ambiguous POST", async () => {
    const fake = harness({ throwAfterUpload: true, changeWindowsAssetsAfterUpload: true });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "release assets changed during evidence upload; verification evidence removed",
    );
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([]);
  });

  it("fails closed when an upload error leaves no asset after bounded reconciliation", async () => {
    const fake = harness({ createOnUpload: false, throwAfterUpload: true });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "Windows verification evidence upload failed",
    );
    expect(fake.delay).toHaveBeenCalledTimes(2);
    expect(fake.deleteAttempts).toEqual([]);
  });

  it("removes an owned starter asset without accepting or promoting it", async () => {
    const fake = harness({
      throwAfterUpload: true,
      uploadAssetOverrides: { state: "starter", size: 0, digest: null },
    });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "Windows verification evidence state became unknown; created asset removed",
    );
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([]);
    expect(fake.executeFile).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["PATCH"]));
  });

  it("uses the POST response id and never a replacement staging id for cleanup", async () => {
    const replacement = expectedAsset({ id: 888 });
    const fake = harness({ replaceStagingAfterUpload: replacement });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "Windows verification evidence state became unknown; created asset removed",
    );
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([{ ...replacement, name: fake.stagingName }]);
  });

  it("leaves another run's canonical asset intact when promotion loses the duplicate-name race", async () => {
    const otherRun = expectedAsset({ id: 888 });
    const fake = harness({ canonicalBeforePromotion: otherRun });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "Windows verification evidence state became unknown; created asset removed",
    );
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([otherRun]);
  });

  it("reconciles a committed promotion whose response is lost", async () => {
    const fake = harness({ throwAfterPromotion: true });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).resolves.toMatchObject({
      status: "uploaded",
      assetId: 777,
      name: evidenceName,
    });
    expect(fake.deleteAttempts).toEqual([]);
    expect(fake.assets).toEqual([expectedAsset()]);
  });

  it("cleans only the staging id when promotion fails before committing", async () => {
    const fake = harness({ failPromotionBeforeCommit: true });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "Windows verification evidence state became unknown; created asset removed",
    );
    expect(fake.delay).toHaveBeenCalledTimes(2);
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([]);
  });

  it("never deletes a replacement canonical asset after ambiguous promotion", async () => {
    const replacement = expectedAsset({ id: 888 });
    const fake = harness({
      throwAfterPromotion: true,
      replaceCanonicalAfterPromotion: replacement,
    });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "Windows verification evidence state became unknown; created asset removed",
    );
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([replacement]);
  });

  it("removes the promoted owned id when latest identity changes at the final boundary", async () => {
    const fake = harness({ changeLatestAfterPromotion: true });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "release identity changed during evidence upload; verification evidence removed",
    );
    expect(fake.deleteAttempts).toEqual([777]);
    expect(fake.assets).toEqual([]);
  });

  it("reports cleanup failure instead of claiming that evidence was removed", async () => {
    const fake = harness({
      throwAfterUpload: true,
      changeLatestAfterUpload: true,
      failDelete: true,
    });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "Windows verification evidence cleanup failed",
    );
    expect(fake.assets).toHaveLength(1);
  });

  it("refuses a non-latest release before touching the upload endpoint", async () => {
    const fake = harness({ changeLatestAfterUpload: true });
    fake.uploadAsset.mockImplementationOnce(async () => {
      throw new Error("must not run");
    });
    const originalExecute = fake.executeFile;
    fake.executeFile = vi.fn(async (executable: string, arguments_: readonly string[]) => {
      if (arguments_.at(-1) === `repos/${repository}/releases/latest`) {
        return {
          stdout: release([], {
            id: 999,
            tag_name: "enduragent-desktop@0.1.8",
            upload_url: `https://uploads.github.com/repos/${repository}/releases/999/assets{?name,label}`,
          }),
        };
      }
      return originalExecute(executable, arguments_);
    });
    await expect(runWindowsVerificationEvidenceUpload(input(), fake)).rejects.toThrow(
      "release identity mismatch before evidence upload",
    );
    expect(fake.uploadAsset).not.toHaveBeenCalled();
  });

  it("rejects schemaVersion 2 evidence", async () => {
    const legacy = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 2,
        tag,
        version,
        commit,
        arch: "x64",
        authenticode: "verified",
        installerSha256: "b".repeat(64),
        publisherDnSha256: "c".repeat(64),
        files: verifiedFiles.map((file) =>
          file.name === `Enduragent-${version}-x64.exe` ? { ...file, sha256: "b".repeat(64) } : file,
        ),
      })}\n`,
    );
    await writeFile(evidencePath, legacy);
    await expect(runWindowsVerificationEvidenceUpload(input(), harness())).rejects.toThrow(
      "Windows verification evidence input is invalid",
    );
  });

  it("redacts unexpected failures from the CLI-safe error surface", () => {
    expect(safeWindowsVerificationEvidenceMessage(new Error("token=secret"))).toBeUndefined();
    expect(
      safeWindowsVerificationEvidenceMessage(
        new TypeError("Windows verification evidence cleanup failed"),
      ),
    ).toBe("Windows verification evidence cleanup failed");
  });
});
