import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { DESKTOP_FEED_URL } from "../../../tools/desktop-update-feed.js";
import {
  createWindowsAuthenticodeVerifyMode,
  decideWindowsAuthenticode,
  parseWindowsAuthenticodeSummary,
  verifyWindowsAuthenticode,
  type WindowsAuthenticodeSummary,
} from "../scripts/verify-windows-authenticode.mjs";
import { verifyWindowsReleaseAssets } from "../scripts/verify-windows-release.mjs";
import {
  serializeWindowsReleaseUpdaterMetadata,
  windowsReleaseArtifactNames,
  windowsReleaseProvenance,
  windowsUpdaterMetadataDigest,
} from "../scripts/windows-release-plan.mjs";

const version = "0.1.5";
const publisherDn = "CN=Enduragent Test Publisher, O=Enduragent Test";
const thumbprint = "a".repeat(40);
const commit = "c".repeat(40);
const feedUrl = DESKTOP_FEED_URL;
const updaterMetadata = serializeWindowsReleaseUpdaterMetadata(feedUrl, publisherDn);
const updaterMetadataSha256 = windowsUpdaterMetadataDigest(updaterMetadata);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/verify-windows-authenticode.ps1",
);
const temporaryRoots: string[] = [];
let directory: string;
let installerPath: string;

const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder"));
const { buildBlockMap } = electronBuilderRequire(
  "app-builder-lib/out/targets/blockmap/blockmap",
) as {
  buildBlockMap: (inputPath: string, compression: "gzip", outputPath: string) => Promise<unknown>;
};

function summary(
  overrides: Partial<WindowsAuthenticodeSummary> = {},
): WindowsAuthenticodeSummary {
  return {
    schema: "windows-authenticode-verification/2",
    installerPath: "/synthetic/installer.exe",
    ok: true,
    signer: {
      subject: publisherDn,
      thumbprint,
      issuer: publisherDn,
      notAfter: "2026-08-26T00:00:00.000Z",
    },
    timestamper: { subject: "CN=Test Timestamp Authority" },
    status: "Valid",
    statusMessage: "Signature verified.",
    digestAlgorithm: "sha256",
    rfc3161: true,
    signtool: { path: "C:\\signtool.exe", exitCode: 0, output: "verified" },
    versionInfo: {
      productVersion: version,
      legalTrademarks: windowsReleaseProvenance(
        commit,
        publisherDn,
        updaterMetadataSha256,
      ),
    },
    allowSelfSignedTest: false,
    checks: [
      { name: "file", ok: true, detail: "regular-executable" },
      { name: "status", ok: true, detail: "Valid" },
      { name: "digest", ok: true, detail: "sha256" },
      { name: "timestamp", ok: true, detail: "rfc3161" },
      { name: "subject", ok: true, detail: publisherDn },
      { name: "thumbprint", ok: true, detail: thumbprint },
      { name: "chain", ok: true, detail: "trusted" },
      { name: "signtool", ok: true, detail: "exit-code-0" },
    ],
    ...overrides,
  };
}

function decisionOptions(allowSelfSignedTest = false) {
  return { expectedPublisherDn: publisherDn, expectedThumbprint: thumbprint, allowSelfSignedTest };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "windows-authenticode-envelope-"));
  temporaryRoots.push(directory);
  const installer = Buffer.from("synthetic signed Windows installer\n");
  const names = windowsReleaseArtifactNames(version);
  installerPath = join(directory, names.installer);
  const sha512 = createHash("sha512").update(installer).digest("base64");
  await writeFile(installerPath, installer);
  await buildBlockMap(installerPath, "gzip", join(directory, names.blockmap));
  await writeFile(
    join(directory, names.metadata),
    stringify({
      version,
      files: [{ url: names.installer, sha512, size: installer.length }],
      path: names.installer,
      sha512,
      releaseDate: "2026-08-25T00:00:00.000Z",
    }),
  );
});

describe("Windows Authenticode decisions", () => {
  it("accepts an exact SHA-256 signature with an RFC 3161 timestamp", () => {
    expect(decideWindowsAuthenticode(summary(), decisionOptions())).toMatchObject({
      ok: true,
      digestAlgorithm: "sha256",
      rfc3161: true,
    });
  });

  it("re-derives publisher, digest, and timestamp decisions from summary fields", () => {
    expect(() =>
      decideWindowsAuthenticode(
        summary({ signer: { ...summary().signer!, subject: "CN=Wrong Publisher" } }),
        decisionOptions(),
      ),
    ).toThrow("Authenticode publisher mismatch");
    expect(() =>
      decideWindowsAuthenticode(summary({ digestAlgorithm: "sha1" }), decisionOptions()),
    ).toThrow("Authenticode digest is not SHA-256");
    expect(() =>
      decideWindowsAuthenticode(summary({ rfc3161: false }), decisionOptions()),
    ).toThrow("Authenticode timestamp is missing");
  });

  it("accepts an explicitly requested self-signed test chain and rejects it otherwise", () => {
    const checks = summary().checks.map((check) =>
      check.name === "chain"
        ? { ...check, detail: "untrusted-root-accepted-for-test" }
        : check.name === "status"
          ? { ...check, detail: "NotTrusted" }
          : check,
    );
    const testSummary = summary({
      status: "NotTrusted",
      statusMessage: "terminated in a root certificate which is not trusted",
      allowSelfSignedTest: true,
      checks,
    });
    expect(decideWindowsAuthenticode(testSummary, decisionOptions(true)).ok).toBe(true);
    expect(() => decideWindowsAuthenticode(testSummary, decisionOptions())).toThrow(
      "Authenticode summary is invalid",
    );
    const refusedChecks = checks.map((check) =>
      check.name === "chain" || check.name === "status" ? { ...check, ok: false } : check,
    );
    expect(() =>
      decideWindowsAuthenticode(
        summary({
          ok: false,
          status: "NotTrusted",
          statusMessage: "terminated in a root certificate which is not trusted",
          checks: refusedChecks,
        }),
        decisionOptions(),
      ),
    ).toThrow("Authenticode chain is untrusted");
  });

  it("binds the sealed provenance to the expected commit and version", () => {
    expect(
      decideWindowsAuthenticode(summary(), {
        ...decisionOptions(),
        expectedCommit: commit,
        expectedVersion: version,
        expectedUpdaterMetadataSha256: updaterMetadataSha256,
      }).ok,
    ).toBe(true);
    expect(() =>
      decideWindowsAuthenticode(summary(), {
        ...decisionOptions(),
        expectedCommit: "d".repeat(40),
      }),
    ).toThrow("Authenticode provenance mismatch");
    expect(() =>
      decideWindowsAuthenticode(
        summary({ versionInfo: { productVersion: version, legalTrademarks: null } }),
        { ...decisionOptions(), expectedCommit: commit },
      ),
    ).toThrow("Authenticode provenance mismatch");
    expect(() =>
      decideWindowsAuthenticode(summary(), { ...decisionOptions(), expectedVersion: "0.1.6" }),
    ).toThrow("Authenticode provenance mismatch");
    expect(() =>
      decideWindowsAuthenticode(
        summary({
          versionInfo: {
            productVersion: version,
            legalTrademarks: `enduragent-release-commit:${commit} enduragent-updater-publisher-sha256:${"0".repeat(64)} enduragent-updater-metadata-sha256:${updaterMetadataSha256}`,
          },
        }),
        { ...decisionOptions(), expectedCommit: commit },
      ),
    ).toThrow("Authenticode provenance mismatch");
    expect(() =>
      decideWindowsAuthenticode(summary(), {
        ...decisionOptions(),
        expectedCommit: commit,
        expectedUpdaterMetadataSha256: "0".repeat(64),
      }),
    ).toThrow("Authenticode provenance mismatch");
    expect(() =>
      decideWindowsAuthenticode(summary(), {
        ...decisionOptions(),
        expectedUpdaterMetadataSha256: "0".repeat(64),
      }),
    ).toThrow("Authenticode provenance mismatch");
    expect(() =>
      decideWindowsAuthenticode(
        summary({
          versionInfo: {
            productVersion: version,
            legalTrademarks: `enduragent-release-commit:${commit}`,
          },
        }),
        { ...decisionOptions(), expectedCommit: commit },
      ),
    ).toThrow("Authenticode provenance mismatch");
    expect(() =>
      decideWindowsAuthenticode({ ...summary(), versionInfo: undefined } as never, decisionOptions()),
    ).toThrow("Authenticode summary is invalid");
  });

  it("rejects thumbprint and signtool failures", () => {
    expect(() =>
      decideWindowsAuthenticode(
        summary({ signer: { ...summary().signer!, thumbprint: "b".repeat(40) } }),
        decisionOptions(),
      ),
    ).toThrow("Authenticode thumbprint mismatch");
    expect(() =>
      decideWindowsAuthenticode(
        summary({
          ok: false,
          signtool: { path: "C:\\signtool.exe", exitCode: 1, output: "failed" },
          checks: summary().checks.map((check) =>
            check.name === "signtool" ? { ...check, ok: false, detail: "exit-code-1" } : check,
          ),
        }),
        decisionOptions(),
      ),
    ).toThrow("signtool verification failed");
  });

  it("strictly parses the summary envelope", () => {
    expect(parseWindowsAuthenticodeSummary(JSON.stringify(summary()))).toEqual(summary());
    expect(() => parseWindowsAuthenticodeSummary("not json")).toThrow(
      "Authenticode summary is invalid",
    );
    expect(() =>
      parseWindowsAuthenticodeSummary(JSON.stringify({ ...summary(), unexpected: true })),
    ).toThrow("Authenticode summary is invalid");
  });

  it("captures summaries from successful and failed verifier exits", async () => {
    const executeFile = vi.fn(async () => ({ stdout: JSON.stringify(summary()), exitCode: 0 }));
    await expect(
      verifyWindowsAuthenticode(
        { installerPath, expectedPublisherDn: publisherDn, expectedThumbprint: thumbprint },
        { executeFile, scriptPath },
      ),
    ).resolves.toMatchObject({ ok: true });
    const wrong = summary({ signer: { ...summary().signer!, subject: "CN=Wrong Publisher" } });
    await expect(
      verifyWindowsAuthenticode(
        { installerPath, expectedPublisherDn: publisherDn, expectedThumbprint: thumbprint },
        {
          executeFile: vi.fn(async () => ({ stdout: JSON.stringify(wrong), exitCode: 1 })),
          scriptPath,
        },
      ),
    ).rejects.toThrow("Authenticode publisher mismatch");
  });

  it("runs the verify mode through the Windows release envelope", async () => {
    const executeFile = vi.fn(async () => ({
      stdout: JSON.stringify(summary({ installerPath })),
      exitCode: 0,
    }));
    const authenticode = createWindowsAuthenticodeVerifyMode(
      { expectedPublisherDn: publisherDn, expectedThumbprint: thumbprint },
      { executeFile, scriptPath },
    );
    const result = await verifyWindowsReleaseAssets(directory, {
      version,
      commit,
      expectedPublisherName: publisherDn,
      appUpdateMetadata: updaterMetadata,
      authenticode,
    });
    expect(result.authenticode).toBe("verified");
    await expect(
      verifyWindowsReleaseAssets(directory, {
        version,
        commit: "d".repeat(40),
        expectedPublisherName: publisherDn,
        appUpdateMetadata: updaterMetadata,
        authenticode,
      }),
    ).rejects.toThrow("Windows installer Authenticode verification failed");
    expect(executeFile).toHaveBeenCalledWith(
      "pwsh",
      expect.arrayContaining([
        "-File",
        scriptPath,
        "-InstallerPath",
        expect.not.stringMatching(new RegExp(`^${directory.replaceAll("\\", "\\\\")}`, "u")),
        "-ExpectedPublisherDn",
        publisherDn,
      ]),
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  });

  it("rejects a substituted canonical app-update.yml not sealed by the signed installer", async () => {
    const authenticode = createWindowsAuthenticodeVerifyMode(
      { expectedPublisherDn: publisherDn, expectedThumbprint: thumbprint },
      {
        executeFile: vi.fn(async () => ({
          stdout: JSON.stringify(summary({ installerPath })),
          exitCode: 0,
        })),
        scriptPath,
      },
    );
    const substituted = serializeWindowsReleaseUpdaterMetadata(
      "https://updates.example.test/",
      publisherDn,
    );
    expect(windowsUpdaterMetadataDigest(substituted)).not.toBe(updaterMetadataSha256);
    await expect(
      verifyWindowsReleaseAssets(directory, {
        version,
        commit,
        expectedPublisherName: publisherDn,
        appUpdateMetadata: substituted,
        authenticode,
      }),
    ).rejects.toThrow("Windows installer Authenticode verification failed");
  });
});
