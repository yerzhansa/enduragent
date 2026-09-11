import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { VerifyWindowsReleaseOptions } from "../scripts/verify-windows-release.mjs";
import { verifyWindowsReleaseAssets } from "../scripts/verify-windows-release.mjs";
import {
  serializeWindowsReleaseUpdaterMetadata,
  windowsReleaseArtifactNames,
  windowsUpdaterMetadataDigest,
} from "../scripts/windows-release-plan.mjs";
import { DESKTOP_FEED_URL } from "../../../tools/desktop-update-feed.js";

const version = "0.1.5";
const commit = "a".repeat(40);
const publisherDn = "CN=Enduragent Test";
const feedUrl = DESKTOP_FEED_URL;
const releaseDate = "2026-08-25T00:00:00.000Z";
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/verify-windows-release.mjs",
);
const temporaryRoots: string[] = [];
let directory: string;
let installer: Buffer;

type BlockmapFixture = {
  version: string;
  files: [{ name: string; offset: number; checksums: string[]; sizes: number[] }];
};

const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder"));
const { buildBlockMap } = electronBuilderRequire(
  "app-builder-lib/out/targets/blockmap/blockmap",
) as {
  buildBlockMap: (inputPath: string, compression: "gzip", outputPath: string) => Promise<unknown>;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function metadata(overrides: Record<string, unknown> = {}) {
  const names = windowsReleaseArtifactNames(version);
  const sha512 = createHash("sha512").update(installer).digest("base64");
  return {
    version,
    files: [{ url: names.installer, sha512, size: installer.length }],
    path: names.installer,
    sha512,
    releaseDate,
    ...overrides,
  };
}

async function writeMetadata(value = metadata()) {
  await writeFile(join(directory, "latest.yml"), stringify(value));
}

async function updateBlockmap(mutator: (value: BlockmapFixture) => void) {
  const names = windowsReleaseArtifactNames(version);
  const path = join(directory, names.blockmap);
  const value = JSON.parse(gunzipSync(await readFile(path)).toString("utf8")) as BlockmapFixture;
  mutator(value);
  await writeFile(path, gzipSync(JSON.stringify(value)));
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "windows-release-envelope-"));
  temporaryRoots.push(directory);
  installer = Buffer.from("synthetic signed Windows installer\n");
  const names = windowsReleaseArtifactNames(version);
  const installerPath = join(directory, names.installer);
  await writeFile(installerPath, installer);
  const blockmapPath = join(directory, names.blockmap);
  await buildBlockMap(installerPath, "gzip", blockmapPath);
  await writeMetadata();
});

describe("Windows release artifact verification", () => {
  it("verifies the exact envelope and records the pending Authenticode notice", async () => {
    const notice = vi.fn();
    const result = await verifyWindowsReleaseAssets(
      directory,
      { version, commit, authenticode: "pending-w19" },
      { notice },
    );
    expect(result.commit).toBe(commit);
    expect(result.authenticode).toBe("pending-w19");
    expect(result.installerSha256).toBe(createHash("sha256").update(installer).digest("hex"));
    expect(notice).toHaveBeenCalledWith(
      "Authenticode verification is pending W19; signature not verified",
    );
  });

  it("requires an explicit Authenticode mode", async () => {
    await expect(
      verifyWindowsReleaseAssets(directory, { version } as unknown as VerifyWindowsReleaseOptions),
    ).rejects.toThrow("Authenticode verification mode is required");
  });

  it("calls an injected Authenticode verifier and fails closed on rejection", async () => {
    let stagedPath = "";
    let stagedBytes: Buffer | undefined;
    const verify = vi.fn(async (installerPath: string) => {
      stagedPath = installerPath;
      stagedBytes = await readFile(installerPath);
      await writeFile(join(directory, `Enduragent-${version}-x64.exe`), "TAMPERED");
    });
    const appUpdateMetadata = serializeWindowsReleaseUpdaterMetadata(feedUrl, publisherDn);
    const result = await verifyWindowsReleaseAssets(directory, {
      version,
      commit,
      expectedPublisherName: publisherDn,
      appUpdateMetadata,
      authenticode: { verify },
    });
    expect(verify).toHaveBeenCalledWith(expect.any(String), {
      version,
      commit,
      publisherName: publisherDn,
      updaterMetadataSha256: windowsUpdaterMetadataDigest(appUpdateMetadata),
    });
    expect(stagedPath.startsWith(directory)).toBe(false);
    expect(stagedPath.endsWith(`Enduragent-${version}-x64.exe`)).toBe(true);
    expect(stagedBytes).toEqual(installer);
    await expect(readFile(stagedPath)).rejects.toThrow();
    expect(result.authenticode).toBe("verified");
    expect(result.updaterMetadataSha256).toBe(windowsUpdaterMetadataDigest(appUpdateMetadata));
    expect(result.bytes.installer).toEqual(installer);
    await writeFile(join(directory, `Enduragent-${version}-x64.exe`), installer);
    await expect(
      verifyWindowsReleaseAssets(directory, {
        version,
        commit,
        authenticode: { verify: vi.fn(async () => Promise.reject(new Error("signature"))) },
      }),
    ).rejects.toThrow("Windows installer Authenticode verification failed");
  });

  it("requires byte-exact electron-builder updater metadata serialization", async () => {
    const canonical = serializeWindowsReleaseUpdaterMetadata(feedUrl, publisherDn);
    const verify = vi.fn(async () => {});
    await expect(
      verifyWindowsReleaseAssets(directory, {
        version,
        commit,
        expectedPublisherName: publisherDn,
        appUpdateMetadata: canonical,
        authenticode: { verify },
      }),
    ).resolves.toMatchObject({
      updaterMetadataSha256: windowsUpdaterMetadataDigest(canonical),
    });

    await expect(
      verifyWindowsReleaseAssets(directory, {
        version,
        commit,
        expectedPublisherName: publisherDn,
        appUpdateMetadata: Buffer.concat([canonical, Buffer.from("\n")]),
        authenticode: { verify },
      }),
    ).rejects.toThrow("release updater metadata is not canonical");
  });

  it("requires the release commit before running an Authenticode verifier", async () => {
    const verify = vi.fn(async () => {});
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: { verify } }),
    ).rejects.toThrow("release commit is required for Authenticode verification");
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects extra files and symlinked installers", async () => {
    await writeFile(join(directory, "extra.txt"), "extra");
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("release artifact envelope differs");
    await unlink(join(directory, "extra.txt"));
    const names = windowsReleaseArtifactNames(version);
    await unlink(join(directory, names.installer));
    await symlink(join(directory, names.blockmap), join(directory, names.installer));
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("invalid Windows installer");
  });

  it.each(["wrong sha512", "wrong size", "non-canonical releaseDate"])(
    "rejects %s metadata that does not bind the installer",
    async (failure) => {
      const value = metadata();
      if (failure === "wrong sha512") value.sha512 = "wrong";
      if (failure === "wrong size") value.files[0]!.size = 1;
      if (failure === "non-canonical releaseDate") value.releaseDate = "2026-08-25T00:00:00Z";
      await writeMetadata(value);
      await expect(
        verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
      ).rejects.toThrow("latest.yml does not match the Windows installer");
    },
  );

  it("rejects a mismatched file digest", async () => {
    const value = metadata();
    value.files[0]!.sha512 = "wrong";
    await writeMetadata(value);
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("latest.yml does not match the Windows installer");
  });

  it("rejects extra latest.yml keys as invalid", async () => {
    await writeMetadata(metadata({ unexpected: true }));
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("latest.yml is invalid");
  });

  it("rejects a non-gzip installer blockmap", async () => {
    const names = windowsReleaseArtifactNames(version);
    await writeFile(join(directory, names.blockmap), "not gzip");
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap is invalid");
  });

  it("rejects a blockmap with the wrong total size", async () => {
    await updateBlockmap((value) => {
      value.files[0].sizes[0] = value.files[0].sizes[0]! + 1;
    });
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap does not match the Windows installer");
  });

  it("rejects a blockmap with mismatched checksum and size counts", async () => {
    await updateBlockmap((value) => {
      value.files[0].checksums.push(value.files[0].checksums[0]!);
    });
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap is invalid");
  });

  it("rejects a blockmap for a different installer name", async () => {
    await updateBlockmap((value) => {
      value.files[0].name = "different.exe";
    });
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap is invalid");
  });

  it("rejects a version 1 blockmap", async () => {
    await updateBlockmap((value) => {
      value.version = "1";
    });
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap is invalid");
  });

  it("rejects a blockmap with a non-base64 checksum", async () => {
    await updateBlockmap((value) => {
      value.files[0].checksums[0] = "!";
    });
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap is invalid");
  });

  it("rejects a blockmap with a checksum of the wrong length", async () => {
    await updateBlockmap((value) => {
      value.files[0].checksums[0] = Buffer.alloc(17).toString("base64");
    });
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap is invalid");
  });

  it("rejects an installer whose bytes do not match the blockmap", async () => {
    installer = Buffer.from(installer);
    installer[0] ^= 0xff;
    const names = windowsReleaseArtifactNames(version);
    await writeFile(join(directory, names.installer), installer);
    await writeMetadata();
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap does not match the Windows installer");
  });

  it("runs the pending CLI and rejects unsupported Authenticode modes", async () => {
    const { spawnSync } = await import("node:child_process");
    const success = spawnSync(
      process.execPath,
      [script, directory, "--version", version, "--authenticode", "pending-w19"],
      { encoding: "utf8" },
    );
    expect(success.status).toBe(0);
    const lines = success.stdout.trimEnd().split("\n");
    const names = windowsReleaseArtifactNames(version);
    const blockmapBytes = await readFile(join(directory, names.blockmap));
    const metadataBytes = await readFile(join(directory, names.metadata));
    expect(lines[0]).toMatch(/^Windows release envelope verified [0-9a-f]{64}$/u);
    expect(lines[1]).toMatch(/^Windows release evidence files /u);
    expect(JSON.parse(lines[1]!.slice("Windows release evidence files ".length))).toEqual([
      {
        name: `Enduragent-${version}-x64.exe`,
        size: installer.length,
        sha256: createHash("sha256").update(installer).digest("hex"),
      },
      {
        name: `Enduragent-${version}-x64.exe.blockmap`,
        size: blockmapBytes.length,
        sha256: createHash("sha256").update(blockmapBytes).digest("hex"),
      },
      {
        name: "latest.yml",
        size: metadataBytes.length,
        sha256: createHash("sha256").update(metadataBytes).digest("hex"),
      },
    ]);
    expect(success.stderr).toBe(
      "Authenticode verification is pending W19; signature not verified\n",
    );
    const failure = spawnSync(
      process.execPath,
      [script, directory, "--version", version, "--authenticode", "verified"],
      { encoding: "utf8" },
    );
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("Authenticode verification mode is required");
  });
});
