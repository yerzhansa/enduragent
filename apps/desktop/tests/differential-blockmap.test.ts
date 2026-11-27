import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_FEED_URL } from "../../../tools/desktop-update-contract.js";
import {
  DESKTOP_UPDATER_CACHE_DIRECTORY,
  parseMacosReleaseUpdaterMetadata,
} from "../scripts/macos-release-plan.mjs";
import {
  parseGzipBlockmap,
  safeDifferentialBlockmapVerificationMessage,
  verifyDifferentialBlockmap,
} from "../scripts/verify-differential-blockmap.mjs";
import {
  parseWindowsReleaseUpdaterMetadata,
  serializeWindowsReleaseUpdaterMetadata,
} from "../scripts/windows-release-plan.mjs";
import { createSafeUpdaterLogger } from "../src/main/updater-logger.js";

const localRequire = createRequire(import.meta.url);
const builderRequire = createRequire(localRequire.resolve("electron-builder"));
const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap") as {
  buildBlockMap(inputPath: string, compression: "gzip", outputPath: string): Promise<unknown>;
};
const { createClient } = localRequire("electron-updater/out/providerFactory") as {
  createClient(
    data: object,
    updater: Record<string, unknown>,
    runtimeOptions: Record<string, unknown>,
  ): { readonly isUseMultipleRangeRequest: boolean };
};
const { GenericDifferentialDownloader } = localRequire(
  "electron-updater/out/differentialDownloader/GenericDifferentialDownloader",
) as {
  GenericDifferentialDownloader: new (
    blockAwareFileInfo: { readonly size: number; readonly sha512: string },
    httpExecutor: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    download(oldBlockMap: unknown, newBlockMap: unknown): Promise<void>;
  };
};
const { CancellationToken } = localRequire("builder-util-runtime") as {
  CancellationToken: new () => unknown;
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function deterministicBytes(length: number, seed: number): Buffer {
  const output = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = (state >>> 24) & 0xff;
  }
  return output;
}

async function buildDifferentialFixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-differential-blockmap-"));
  temporaryRoots.push(root);
  const sharedHead = deterministicBytes(240 * 1024, 1);
  const sharedMiddle = deterministicBytes(240 * 1024, 2);
  const sharedTail = deterministicBytes(240 * 1024, 3);
  const oldArtifact = Buffer.concat([
    sharedHead,
    deterministicBytes(32 * 1024, 10),
    sharedMiddle,
    deterministicBytes(32 * 1024, 20),
    sharedTail,
  ]);
  const newArtifact = Buffer.concat([
    sharedHead,
    deterministicBytes(32 * 1024, 30),
    sharedMiddle,
    deterministicBytes(32 * 1024, 40),
    sharedTail,
  ]);
  const oldPath = join(root, "Enduragent-0.6.0-arm64.zip");
  const newPath = join(root, "Enduragent-0.7.0-arm64.zip");
  const oldBlockmapPath = `${oldPath}.blockmap`;
  const newBlockmapPath = `${newPath}.blockmap`;
  await Promise.all([writeFile(oldPath, oldArtifact), writeFile(newPath, newArtifact)]);
  await Promise.all([
    buildBlockMap(oldPath, "gzip", oldBlockmapPath),
    buildBlockMap(newPath, "gzip", newBlockmapPath),
  ]);
  const [oldBlockmapBytes, newBlockmapBytes] = await Promise.all([
    readFile(oldBlockmapPath),
    readFile(newBlockmapPath),
  ]);
  return { root, oldPath, newPath, oldArtifact, newArtifact, oldBlockmapBytes, newBlockmapBytes };
}

function singleRangeOnlyHttpExecutor(artifact: Buffer) {
  const rangeHeaders: string[] = [];
  let wireBytesTransferred = 0;
  const httpExecutor = {
    createRequest(
      options: { readonly headers?: Record<string, string | undefined> },
      callback: (
        response: EventEmitter & {
          statusCode: number;
          statusMessage: string;
          headers: Record<string, string>;
        },
      ) => void,
    ) {
      const request = Object.assign(new EventEmitter(), {
        abort: vi.fn(),
        end() {
          const range = options.headers?.range ?? options.headers?.Range ?? "";
          rangeHeaders.push(range);
          if (range.includes(",")) {
            const response = Object.assign(Readable.from([]), {
              statusCode: 502,
              statusMessage: "Bad Gateway",
              headers: { "content-type": "text/plain" },
            });
            queueMicrotask(() => callback(response));
            return;
          }
          const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
          if (match === null) {
            const response = Object.assign(Readable.from([]), {
              statusCode: 400,
              statusMessage: "Bad Request",
              headers: {},
            });
            queueMicrotask(() => callback(response));
            return;
          }
          const start = Number.parseInt(match[1] ?? "", 10);
          const endInclusive = Number.parseInt(match[2] ?? "", 10);
          const slice = artifact.subarray(start, endInclusive + 1);
          wireBytesTransferred += slice.byteLength;
          const response = Object.assign(Readable.from([slice]), {
            statusCode: 206,
            statusMessage: "Partial Content",
            headers: {
              "accept-ranges": "bytes",
              "content-length": String(slice.byteLength),
              "content-range": `bytes ${start}-${endInclusive}/${artifact.byteLength}`,
            },
          });
          queueMicrotask(() => callback(response));
        },
      });
      return request;
    },
    addErrorAndTimeoutHandlers(request: EventEmitter, reject: (error: unknown) => void) {
      request.on("error", reject);
    },
  };
  return {
    httpExecutor,
    rangeHeaders,
    wireBytesTransferred: () => wireBytesTransferred,
  };
}

describe("differential blockmap verification and updater single-range transport", () => {
  it("verifies computeOperations reuse and byte-exact reconstruction against real app-builder-lib blockmaps", async () => {
    const fixture = await buildDifferentialFixture();

    const summary = verifyDifferentialBlockmap(fixture.oldBlockmapBytes, fixture.newBlockmapBytes, {
      oldArtifact: fixture.oldArtifact,
      newArtifact: fixture.newArtifact,
      minimumReuseRatio: 0.7,
    });

    expect(summary.totalBytes).toBe(fixture.newArtifact.byteLength);
    expect(summary.copyBytes + summary.downloadBytes).toBe(summary.totalBytes);
    expect(summary.copyBytes).toBeGreaterThan(0);
    expect(summary.downloadBytes).toBeGreaterThan(0);
    expect(summary.downloadOperations).toBeGreaterThanOrEqual(2);
    expect(summary.reuseRatio).toBeGreaterThanOrEqual(0.7);
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it("rejects invalid blockmaps, insufficient reuse, and tampered reconstructions", async () => {
    const fixture = await buildDifferentialFixture();

    expect(() =>
      verifyDifferentialBlockmap(Buffer.from("not gzip"), fixture.newBlockmapBytes),
    ).toThrow("baseline blockmap is invalid");
    expect(() =>
      verifyDifferentialBlockmap(
        fixture.oldBlockmapBytes,
        gzipSync(JSON.stringify({ version: "1", files: [] })),
      ),
    ).toThrow("candidate blockmap is invalid");
    expect(() =>
      verifyDifferentialBlockmap(fixture.oldBlockmapBytes, fixture.newBlockmapBytes, {
        minimumReuseRatio: 0.99,
      }),
    ).toThrow("differential blockmap reuse ratio below threshold");

    const tamperedCandidate = Buffer.from(fixture.newArtifact);
    tamperedCandidate[0] = (tamperedCandidate[0] ?? 0) ^ 0xff;
    let error: unknown;
    try {
      verifyDifferentialBlockmap(fixture.oldBlockmapBytes, fixture.newBlockmapBytes, {
        oldArtifact: fixture.oldArtifact,
        newArtifact: tamperedCandidate,
      });
    } catch (caught) {
      error = caught;
    }
    expect(safeDifferentialBlockmapVerificationMessage(error)).toBe(
      "differential reconstruction does not match candidate artifact",
    );
  });

  it("disables multi-range requests in electron-updater GenericProvider for both macOS and Windows metadata", () => {
    const macMetadata = parseMacosReleaseUpdaterMetadata(
      [
        "provider: generic",
        `url: ${DESKTOP_FEED_URL}`,
        "channel: latest",
        "useMultipleRangeRequest: false",
        `updaterCacheDirName: '${DESKTOP_UPDATER_CACHE_DIRECTORY}'`,
        "",
      ].join("\n"),
    );
    const windowsMetadata = parseWindowsReleaseUpdaterMetadata(
      serializeWindowsReleaseUpdaterMetadata(
        DESKTOP_FEED_URL,
        "CN=Enduragent Test Publisher, O=Enduragent Test",
      ),
    );
    const legacyMetadata = {
      provider: "generic",
      url: DESKTOP_FEED_URL,
      channel: "latest",
      updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
    };

    const macProvider = createClient(macMetadata, {}, { isUseMultipleRangeRequest: true });
    const windowsProvider = createClient(windowsMetadata, {}, { isUseMultipleRangeRequest: true });
    const legacyProvider = createClient(legacyMetadata, {}, { isUseMultipleRangeRequest: true });

    expect(macProvider.isUseMultipleRangeRequest).toBe(false);
    expect(windowsProvider.isUseMultipleRangeRequest).toBe(false);
    expect(legacyProvider.isUseMultipleRangeRequest).toBe(true);
  });

  it("completes real electron-updater differential download against a single-range-only server while multi-range fails with 502", async () => {
    const fixture = await buildDifferentialFixture();
    const oldBlockMap = parseGzipBlockmap(fixture.oldBlockmapBytes);
    const newBlockMap = parseGzipBlockmap(fixture.newBlockmapBytes);
    const newSha512 = createHash("sha512").update(fixture.newArtifact).digest("base64");
    const macMetadata = parseMacosReleaseUpdaterMetadata(
      [
        "provider: generic",
        `url: ${DESKTOP_FEED_URL}`,
        "channel: latest",
        "useMultipleRangeRequest: false",
        `updaterCacheDirName: '${DESKTOP_UPDATER_CACHE_DIRECTORY}'`,
        "",
      ].join("\n"),
    );
    const provider = createClient(macMetadata, {}, { isUseMultipleRangeRequest: true });

    const multiRangeServer = singleRangeOnlyHttpExecutor(fixture.newArtifact);
    const multiRangeLogs: string[] = [];
    const multiRangeLogger = createSafeUpdaterLogger((message) => multiRangeLogs.push(message));
    const multiRangeOutput = join(fixture.root, "multi-range-out.zip");
    const multiRangeDownloader = new GenericDifferentialDownloader(
      { size: fixture.newArtifact.byteLength, sha512: newSha512 },
      multiRangeServer.httpExecutor,
      {
        newUrl: new URL("https://updates.enduragent.icu/Enduragent-0.7.0-arm64.zip?sig=secret"),
        oldFile: fixture.oldPath,
        newFile: multiRangeOutput,
        logger: multiRangeLogger,
        isUseMultipleRangeRequest: true,
        cancellationToken: new CancellationToken(),
      },
    );
    let multiRangeError: unknown;
    try {
      await multiRangeDownloader.download(oldBlockMap, newBlockMap);
    } catch (caught) {
      multiRangeError = caught;
    }
    expect(multiRangeError).toBeInstanceOf(Error);
    expect((multiRangeError as { statusCode?: number }).statusCode).toBe(502);
    expect(multiRangeServer.rangeHeaders.some((header) => header.includes(","))).toBe(true);
    multiRangeLogger.error(
      `Cannot download differentially, fallback to full download: ${String((multiRangeError as Error).stack ?? multiRangeError)}`,
    );
    expect(multiRangeLogs).toContain(
      "desktop-update-updater level=error event=differential-fallback reason=http-error status=502",
    );

    const singleRangeServer = singleRangeOnlyHttpExecutor(fixture.newArtifact);
    const singleRangeLogs: string[] = [];
    const singleRangeLogger = createSafeUpdaterLogger((message) => singleRangeLogs.push(message));
    const progressEvents: number[] = [];
    const singleRangeOutput = join(fixture.root, "single-range-out.zip");
    const singleRangeDownloader = new GenericDifferentialDownloader(
      { size: fixture.newArtifact.byteLength, sha512: newSha512 },
      singleRangeServer.httpExecutor,
      {
        newUrl: new URL("https://updates.enduragent.icu/Enduragent-0.7.0-arm64.zip?sig=secret"),
        oldFile: fixture.oldPath,
        newFile: singleRangeOutput,
        logger: singleRangeLogger,
        isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
        cancellationToken: new CancellationToken(),
        onProgress: (info: { transferred: number }) => progressEvents.push(info.transferred),
      },
    );

    await singleRangeDownloader.download(oldBlockMap, newBlockMap);

    expect(singleRangeServer.rangeHeaders.length).toBeGreaterThanOrEqual(2);
    expect(singleRangeServer.rangeHeaders.every((header) => !header.includes(","))).toBe(true);
    expect(singleRangeServer.wireBytesTransferred()).toBeLessThan(
      fixture.newArtifact.byteLength * 0.35,
    );
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(await readFile(singleRangeOutput)).toEqual(fixture.newArtifact);
    expect(singleRangeLogs).toContainEqual(
      expect.stringMatching(
        /^desktop-update-updater level=info event=differential-plan changedBlocks=\d+$/u,
      ),
    );
    expect(singleRangeLogs).toContainEqual(
      expect.stringMatching(
        /^desktop-update-updater level=info event=differential-summary fullKb=\d+(?:\.\d+)? downloadKb=\d+(?:\.\d+)? percent=\d+$/u,
      ),
    );
    expect(singleRangeLogs).toContain(
      "desktop-update-updater level=info event=differential-download-start",
    );
    const serializedLogs = JSON.stringify(singleRangeLogs);
    expect(serializedLogs).not.toContain("secret");
    expect(serializedLogs).not.toContain("https://");
    expect(serializedLogs).not.toContain(fixture.root);
  });
});
