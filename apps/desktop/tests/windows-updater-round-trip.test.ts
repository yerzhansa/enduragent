import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DESKTOP_FEED_URL } from "../../../tools/desktop-update-feed.js";
import {
  safeWindowsUpdaterRoundTripMessage,
  verifyWindowsUpdaterRoundTrip,
  type WindowsUpdaterPreflight,
  type WindowsUpdaterReleaseInput,
} from "../scripts/verify-windows-updater-round-trip.mjs";
import { windowsReleaseArtifactNames } from "../scripts/windows-release-plan.mjs";

type RoundTripInput = Parameters<typeof verifyWindowsUpdaterRoundTrip>[0];

const require = createRequire(import.meta.url);
const electronBuilderRequire = createRequire(require.resolve("electron-builder"));
const { blake2b } = electronBuilderRequire("@noble/hashes/blake2.js") as {
  blake2b: (input: Uint8Array, options: { dkLen: number }) => Uint8Array;
};
const baselineInstaller = Buffer.from("synthetic Windows installer 0.1.5\n");
const candidateInstaller = Buffer.from("synthetic Windows installer 0.1.6\n");

function blockmapFor(installer: Buffer, chunkSize = 16): Buffer {
  const sizes: number[] = [];
  const checksums: string[] = [];
  for (let offset = 0; offset < installer.length; offset += chunkSize) {
    const chunk = installer.subarray(offset, Math.min(offset + chunkSize, installer.length));
    sizes.push(chunk.length);
    checksums.push(Buffer.from(blake2b(chunk, { dkLen: 18 })).toString("base64"));
  }
  return gzipSync(
    JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums, sizes }] }),
  );
}
const releaseDate = "2026-08-25T00:00:00.000Z";
const preflight: WindowsUpdaterPreflight = {
  feedUrl: DESKTOP_FEED_URL,
  channel: "latest",
  publisherName: "CN=Operator Name, O=Open Source Developer, C=KZ",
  disableWebInstaller: true,
  verifyUpdateCodeSignature: true,
};

function metadata(
  version: string,
  installer: Uint8Array,
  overrides: {
    readonly version?: string;
    readonly installerName?: string;
    readonly sha512?: string;
    readonly size?: number;
    readonly extra?: Readonly<Record<string, unknown>>;
  } = {},
): string {
  const installerName = overrides.installerName ?? windowsReleaseArtifactNames(version).installer;
  const sha512 = overrides.sha512 ?? createHash("sha512").update(installer).digest("base64");
  const size = overrides.size ?? installer.byteLength;
  return stringify({
    version: overrides.version ?? version,
    files: [{ url: installerName, sha512, size }],
    path: installerName,
    sha512,
    releaseDate,
    ...overrides.extra,
  });
}

function release(
  version: string,
  installer: Uint8Array,
  options: {
    readonly metadata?: string | Uint8Array;
    readonly metadataOverrides?: Parameters<typeof metadata>[2];
    readonly blockmap?: Uint8Array;
    readonly includeBlockmap?: boolean;
  } = {},
): WindowsUpdaterReleaseInput {
  const result: {
    version: string;
    installer: Uint8Array;
    metadata: string | Uint8Array;
    blockmap?: Uint8Array;
  } = {
    version,
    installer,
    metadata: options.metadata ?? metadata(version, installer, options.metadataOverrides),
  };
  if (options.includeBlockmap !== false) {
    result.blockmap = options.blockmap ?? blockmapFor(Buffer.from(installer));
  }
  return result;
}

function roundTripInput(
  overrides: {
    readonly baseline?: WindowsUpdaterReleaseInput;
    readonly candidate?: WindowsUpdaterReleaseInput;
    readonly preflight?: WindowsUpdaterPreflight;
  } = {},
): RoundTripInput {
  return {
    baseline: overrides.baseline ?? release("0.1.5", baselineInstaller),
    candidate: overrides.candidate ?? release("0.1.6", candidateInstaller),
    preflight: overrides.preflight ?? preflight,
  };
}

const negativeScenarios: readonly {
  readonly name: string;
  readonly expected: string;
  readonly input: () => RoundTripInput;
}[] = [
  {
    name: "wrong-version",
    expected: "latest.yml version mismatch",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          metadataOverrides: { version: "0.1.7" },
        }),
      }),
  },
  {
    name: "wrong-sha512",
    expected: "latest.yml installer sha512 mismatch",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          metadataOverrides: { sha512: "d3Jvbmc=" },
        }),
      }),
  },
  {
    name: "wrong-size",
    expected: "latest.yml installer size mismatch",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          metadataOverrides: { size: candidateInstaller.byteLength + 1 },
        }),
      }),
  },
  {
    name: "missing blockmap",
    expected: "missing candidate installer blockmap",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, { includeBlockmap: false }),
      }),
  },
  {
    name: "non-gzip blockmap",
    expected: "installer blockmap is invalid",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          blockmap: Buffer.from("not gzip"),
        }),
      }),
  },
  {
    name: "blockmap built from other installer bytes",
    expected: "installer blockmap does not match the Windows installer",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          blockmap: blockmapFor(baselineInstaller),
        }),
      }),
  },
  {
    name: "blockmap chunk sizes covering fewer bytes than the installer",
    expected: "installer blockmap does not match the Windows installer",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          blockmap: blockmapFor(candidateInstaller.subarray(0, 1)),
        }),
      }),
  },
  {
    name: "blockmap with a descriptor-only installer",
    expected: "installer blockmap requires installer bytes",
    input: () =>
      roundTripInput({
        candidate: release(
          "0.1.6",
          {
            sha512: createHash("sha512").update(candidateInstaller).digest("base64"),
            size: candidateInstaller.byteLength,
          } as unknown as Uint8Array,
          {
            blockmap: blockmapFor(candidateInstaller),
            metadataOverrides: {
              sha512: createHash("sha512").update(candidateInstaller).digest("base64"),
              size: candidateInstaller.byteLength,
            },
          },
        ),
      }),
  },
  {
    name: "downgrade",
    expected: "updater round-trip candidate must be a higher version than the baseline",
    input: () => roundTripInput({ candidate: release("0.1.4", candidateInstaller) }),
  },
  {
    name: "equal versions",
    expected: "updater round-trip candidate must be a higher version than the baseline",
    input: () => roundTripInput({ candidate: release("0.1.5", candidateInstaller) }),
  },
  {
    name: "wrong installer name",
    expected: "latest.yml installer name mismatch",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          metadataOverrides: { installerName: "Enduragent-0.1.6-arm64.exe" },
        }),
      }),
  },
  {
    name: "oversized latest.yml",
    expected: "latest.yml is invalid",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          metadata: new Uint8Array(16_384 + 1),
        }),
      }),
  },
  {
    name: "extra key in latest.yml",
    expected: "latest.yml is invalid",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6", candidateInstaller, {
          metadataOverrides: { extra: { unexpected: true } },
        }),
      }),
  },
  {
    name: "prerelease version",
    expected: "updater round-trip version must be stable SemVer",
    input: () =>
      roundTripInput({
        candidate: release("0.1.6-beta.1", candidateInstaller, {
          metadataOverrides: { installerName: "Enduragent-0.1.6-beta.1-x64.exe" },
        }),
      }),
  },
  {
    name: "CN-only publisherName",
    expected: "updater preflight publisher name must be a full distinguished name",
    input: () => roundTripInput({ preflight: { ...preflight, publisherName: "CN=Operator Name" } }),
  },
  {
    name: "empty publisherName",
    expected: "updater preflight publisher name must be a full distinguished name",
    input: () => roundTripInput({ preflight: { ...preflight, publisherName: "" } }),
  },
  {
    name: "http feed URL",
    expected: "updater preflight feed URL is invalid",
    input: () =>
      roundTripInput({
        preflight: {
          ...preflight,
          feedUrl: "http://github.com/yerzhansa/enduragent/releases/latest/download/",
        },
      }),
  },
  {
    name: "disableWebInstaller false",
    expected: "updater preflight is invalid",
    input: () =>
      roundTripInput({
        preflight: {
          ...preflight,
          disableWebInstaller: false,
        } as unknown as WindowsUpdaterPreflight,
      }),
  },
];

describe("Windows updater N-to-N+1 round trip", () => {
  it("verifies a complete 0.1.5 to 0.1.6 round trip", () => {
    const result = verifyWindowsUpdaterRoundTrip(roundTripInput());
    expect(result).toEqual({
      baselineVersion: "0.1.5",
      candidateVersion: "0.1.6",
      candidateInstallerName: "Enduragent-0.1.6-x64.exe",
      candidateInstallerSha512: createHash("sha512").update(candidateInstaller).digest("base64"),
      candidateInstallerSize: candidateInstaller.byteLength,
      preflight,
      authenticode: "pending-w19",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(negativeScenarios)("rejects $name", ({ expected, input }) => {
    let error: unknown;
    try {
      verifyWindowsUpdaterRoundTrip(input());
    } catch (caught) {
      error = caught;
    }
    expect(safeWindowsUpdaterRoundTripMessage(error)).toBe(expected);
  });

  it.skip("rejects wrong publisher — Authenticode publisher comparison requires W19 signature verification", () => {});
});
