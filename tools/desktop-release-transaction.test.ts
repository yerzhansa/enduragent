import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DESKTOP_FEED_URL,
  DESKTOP_MANIFEST,
  DESKTOP_RELEASE_SCHEMA_VERSION,
  DesktopLatestPromotionOutcomeError,
  assertLatestCas,
  assertPublishableAssets,
  assertRemoteAsset,
  inspectNpmAttestationClaims,
  macosOwnedAssets,
  materializeDesktopPublicEnvelope,
  releaseFileNames,
  resolveDesktopReleaseVersion,
  runDesktopLatestPromotionWithOutput,
  sealDesktopRelease,
  verifyNpmProvenanceBundle,
  verifyDesktopRelease,
  windowsReleaseFileNames,
} from "./desktop-release-transaction.js";

const npmVersion = "2026.8.7";
const desktopVersion = "0.1.7";
const binding = {
  tag: `enduragent-desktop@${desktopVersion}`,
  desktopVersion,
  commit: "a".repeat(40),
  catalog: {
    releaseGroupId: "a".repeat(40),
    revision: 1,
    digest: "0".repeat(64),
  },
  draftId: "123",
  mode: "steady" as const,
  workflowRunId: "456",
  workflowRunAttempt: "1",
  draftBodySha256: "b".repeat(64),
  signingIdentity: "Developer ID Application: Example (FA494ACVTF)",
  candidateCdHash: "c".repeat(40),
  candidateCodeDirectorySha256: "d".repeat(64),
  baselineTag: "enduragent-desktop@0.1.6",
  baselineReleaseId: "122",
  baselineCommit: "e".repeat(40),
  baselineZipSha256: "f".repeat(64),
  baselineSigningIdentity: "Developer ID Application: Example (FA494ACVTF)",
  baselineCdHash: "1".repeat(40),
};

let directory: string;

function sha512(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function writeEnvelope(extra?: string): void {
  const [dmgName, zipName, blockmapName] = releaseFileNames(desktopVersion);
  const dmg = Buffer.from("signed-dmg");
  const zip = Buffer.from("signed-zip");
  writeFileSync(join(directory, dmgName), dmg);
  writeFileSync(join(directory, zipName), zip);
  writeFileSync(join(directory, blockmapName), "blockmap");
  writeFileSync(
    join(directory, "latest-mac.yml"),
    stringify({
      version: desktopVersion,
      files: [
        { url: zipName, sha512: sha512(zip), size: zip.length },
        { url: dmgName, sha512: sha512(dmg), size: dmg.length },
      ],
      path: zipName,
      sha512: sha512(zip),
      releaseDate: "1998-08-07T00:00:00.000Z",
    }),
  );
  if (extra) writeFileSync(join(directory, extra), "stale");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "desktop-release-transaction-"));
  mkdirSync(directory, { recursive: true });
});

describe("advertised npm attestation claims", () => {
  const integrityBytes = Buffer.alloc(64, 7);
  const integrity = `sha512-${integrityBytes.toString("base64")}`;
  const expectation = {
    name: "cycling-coach",
    version: npmVersion,
    integrity,
    repository: "https://github.com/yerzhansa/enduragent",
    workflow: ".github/workflows/release.yml",
    ref: `refs/tags/cycling-coach@${npmVersion}`,
    releaseTag: `cycling-coach@${npmVersion}`,
    workflowCommit: "a".repeat(40),
    invocationId: "https://github.com/yerzhansa/enduragent/actions/runs/456/attempts/1",
    eventName: "push",
    repositoryId: "1209631813",
    repositoryOwnerId: "23091036",
  };

  function attestation(predicateType: string, predicate: unknown) {
    const statement = {
      _type:
        predicateType === "https://slsa.dev/provenance/v1"
          ? "https://in-toto.io/Statement/v1"
          : "https://in-toto.io/Statement/v0.1",
      subject: [
        {
          name: `pkg:npm/cycling-coach@${npmVersion}`,
          digest: { sha512: integrityBytes.toString("hex") },
        },
      ],
      predicateType,
      predicate,
    };
    return {
      predicateType,
      bundle: {
        dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") },
      },
    };
  }

  function document(
    commit = expectation.workflowCommit,
    ref = expectation.ref,
    eventName = expectation.eventName,
  ) {
    return {
      attestations: [
        attestation("https://slsa.dev/provenance/v1", {
          buildDefinition: {
            buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
            internalParameters: {
              github: {
                event_name: eventName,
                repository_id: expectation.repositoryId,
                repository_owner_id: expectation.repositoryOwnerId,
              },
            },
            externalParameters: {
              workflow: {
                ref,
                repository: expectation.repository,
                path: expectation.workflow,
              },
            },
            resolvedDependencies: [
              {
                uri: `git+${expectation.repository}@${ref}`,
                digest: { gitCommit: commit },
              },
            ],
          },
          runDetails: {
            builder: { id: "https://github.com/actions/runner/github-hosted" },
            metadata: { invocationId: expectation.invocationId },
          },
        }),
        attestation("https://github.com/npm/attestation/tree/main/specs/publish/v0.1", {
          name: expectation.name,
          version: expectation.version,
          registry: "https://registry.npmjs.org",
        }),
      ],
    };
  }

  it("accepts statements bound to the exact tarball, workflow, ref, and commit", () => {
    expect(() => inspectNpmAttestationClaims(document(), expectation)).not.toThrow();
  });

  it("binds main dispatch provenance to the publisher workflow commit independently of source", () => {
    const sourceCommit = expectation.workflowCommit;
    const main = {
      ...expectation,
      ref: "refs/heads/main",
      eventName: "workflow_dispatch",
      workflowCommit: "b".repeat(40),
    };
    const metadata = document(main.workflowCommit, main.ref, main.eventName);
    expect(() => inspectNpmAttestationClaims(metadata, main)).not.toThrow();
    expect(() =>
      inspectNpmAttestationClaims(metadata, { ...main, workflowCommit: sourceCommit }),
    ).toThrow("workflow binding");
    expect(() =>
      inspectNpmAttestationClaims(metadata, {
        ...main,
        invocationId: "https://github.com/yerzhansa/enduragent/actions/runs/999/attempts/1",
      }),
    ).toThrow("workflow binding");
  });

  it("accepts workflow_dispatch provenance on the exact release tag ref", () => {
    const dispatched = { ...expectation, eventName: "workflow_dispatch" };
    const metadata = document();
    const provenance = metadata.attestations.find(
      (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
    )!;
    const statement = JSON.parse(
      Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
    ) as {
      predicate: { buildDefinition: { internalParameters: { github: { event_name: string } } } };
    };
    statement.predicate.buildDefinition.internalParameters.github.event_name = "workflow_dispatch";
    provenance.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString(
      "base64",
    );
    expect(() => inspectNpmAttestationClaims(metadata, dispatched)).not.toThrow();
  });

  it("cryptographically verifies the exact SLSA bundle with the pinned workflow identity", async () => {
    const metadata = document();
    const provenanceBundle = metadata.attestations.find(
      (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
    )!.bundle;
    let calls = 0;
    await verifyNpmProvenanceBundle(metadata, expectation, async (bundle, identity) => {
      calls += 1;
      expect(bundle).toBe(provenanceBundle);
      expect(identity).toEqual({
        issuer: "https://token.actions.githubusercontent.com",
        uri: `https://github.com/yerzhansa/enduragent/.github/workflows/release.yml@${expectation.ref}`,
      });
    });
    expect(calls).toBe(1);
    await expect(
      verifyNpmProvenanceBundle(metadata, expectation, async () => {
        throw new TypeError("certificate identity mismatch");
      }),
    ).rejects.toThrow("certificate identity mismatch");
  });

  it("rejects commit drift and duplicate provenance statements", () => {
    expect(() => inspectNpmAttestationClaims(document("f".repeat(40)), expectation)).toThrow(
      "workflow binding",
    );
    const duplicate = document();
    duplicate.attestations.push(duplicate.attestations[0]);
    expect(() => inspectNpmAttestationClaims(duplicate, expectation)).toThrow("duplicate");
    const extra = document();
    extra.attestations.push(attestation("https://example.invalid/extra", {}));
    expect(() => inspectNpmAttestationClaims(extra, expectation)).toThrow("unexpected");
  });

  it("permits a prior same-repository invocation only for exact resume", () => {
    const prior = document();
    const payload = JSON.parse(
      Buffer.from(prior.attestations[0].bundle.dsseEnvelope.payload, "base64").toString("utf8"),
    ) as { predicate: { runDetails: { metadata: { invocationId: string } } } };
    payload.predicate.runDetails.metadata.invocationId =
      "https://github.com/yerzhansa/enduragent/actions/runs/123/attempts/2";
    prior.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(payload),
    ).toString("base64");
    expect(() =>
      inspectNpmAttestationClaims(prior, { ...expectation, allowPriorInvocation: true }),
    ).not.toThrow();
    expect(() => inspectNpmAttestationClaims(prior, expectation)).toThrow("workflow binding");
  });

  it("permits a prior tag invocation across push and workflow_dispatch reruns", () => {
    const prior = document();
    const payload = JSON.parse(
      Buffer.from(prior.attestations[0].bundle.dsseEnvelope.payload, "base64").toString("utf8"),
    ) as {
      predicate: {
        buildDefinition: { internalParameters: { github: { event_name: string } } };
        runDetails: { metadata: { invocationId: string } };
      };
    };
    payload.predicate.buildDefinition.internalParameters.github.event_name = "workflow_dispatch";
    payload.predicate.runDetails.metadata.invocationId =
      "https://github.com/yerzhansa/enduragent/actions/runs/123/attempts/1";
    prior.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(payload),
    ).toString("base64");
    expect(() =>
      inspectNpmAttestationClaims(prior, { ...expectation, allowPriorInvocation: true }),
    ).not.toThrow();
    expect(() => inspectNpmAttestationClaims(prior, expectation)).toThrow("workflow binding");
  });

  it("fails closed at the repository rename migration boundary", () => {
    const renamed = document();
    const payload = JSON.parse(
      Buffer.from(renamed.attestations[0].bundle.dsseEnvelope.payload, "base64").toString("utf8"),
    ) as {
      predicate: {
        buildDefinition: { externalParameters: { workflow: { repository: string } } };
      };
    };
    payload.predicate.buildDefinition.externalParameters.workflow.repository =
      "https://github.com/yerzhansa/cycling-coach";
    renamed.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(payload),
    ).toString("base64");
    expect(() =>
      inspectNpmAttestationClaims(renamed, { ...expectation, allowPriorInvocation: true }),
    ).toThrow("repository rename boundary requires a new release version");
  });
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("desktop latest promotion command output", () => {
  it("records an applied outcome before resolving", async () => {
    const output = join(directory, "github-output");

    await expect(runDesktopLatestPromotionWithOutput(output, async () => "applied")).resolves.toBe(
      "applied",
    );

    expect(readFileSync(output, "utf8")).toBe("promotion_outcome=applied\n");
  });

  it.each(["foreign", "unapplied", "unknown"] as const)(
    "records a %s outcome before rejecting",
    async (outcome) => {
      const output = join(directory, "github-output");
      const error = new DesktopLatestPromotionOutcomeError(outcome, "synthetic promotion failure");

      await expect(
        runDesktopLatestPromotionWithOutput(output, async () => Promise.reject(error)),
      ).rejects.toBe(error);

      expect(readFileSync(output, "utf8")).toBe(`promotion_outcome=${outcome}\n`);
    },
  );

  it("records an unknown outcome for an unclassified command failure", async () => {
    const output = join(directory, "github-output");
    const error = new TypeError("synthetic command failure");

    await expect(
      runDesktopLatestPromotionWithOutput(output, async () => Promise.reject(error)),
    ).rejects.toBe(error);

    expect(readFileSync(output, "utf8")).toBe("promotion_outcome=unknown\n");
  });
});

describe("desktop release envelope", () => {
  it("seals exactly four updater files with metadata last and digest bindings", async () => {
    writeEnvelope();
    const manifest = await sealDesktopRelease(directory, binding);
    expect(manifest.schemaVersion).toBe(DESKTOP_RELEASE_SCHEMA_VERSION);
    expect(
      (
        JSON.parse(readFileSync(join(directory, DESKTOP_MANIFEST), "utf8")) as {
          schemaVersion: unknown;
        }
      ).schemaVersion,
    ).toBe(DESKTOP_RELEASE_SCHEMA_VERSION);
    expect(manifest.feedUrl).toBe(DESKTOP_FEED_URL);
    expect(manifest).toMatchObject({
      tag: `enduragent-desktop@${desktopVersion}`,
      desktopVersion,
    });
    expect(manifest).not.toHaveProperty("npmVersion");
    expect(manifest).not.toHaveProperty("npmIntegrity");
    expect(manifest).not.toHaveProperty("npmAttestationUrl");
    expect(manifest.files.map((file) => file.name)).toEqual(releaseFileNames(desktopVersion));
    expect(manifest.files.at(-1)?.name).toBe("latest-mac.yml");
    await expect(verifyDesktopRelease(directory, binding)).resolves.toEqual(manifest);
  });

  it("changes transactionSha256 when only catalog.digest differs and still seals four updater files", async () => {
    writeEnvelope();
    const first = await sealDesktopRelease(directory, binding);
    const otherDirectory = mkdtempSync(join(tmpdir(), "desktop-release-catalog-"));
    try {
      const [dmgName, zipName, blockmapName] = releaseFileNames(desktopVersion);
      writeFileSync(join(otherDirectory, dmgName), readFileSync(join(directory, dmgName)));
      writeFileSync(join(otherDirectory, zipName), readFileSync(join(directory, zipName)));
      writeFileSync(join(otherDirectory, blockmapName), readFileSync(join(directory, blockmapName)));
      writeFileSync(
        join(otherDirectory, "latest-mac.yml"),
        readFileSync(join(directory, "latest-mac.yml")),
      );
      const second = await sealDesktopRelease(otherDirectory, {
        ...binding,
        catalog: { ...binding.catalog, digest: "1".repeat(64) },
      });
      expect(second.transactionSha256).not.toBe(first.transactionSha256);
      expect(readdirSync(directory).sort()).toEqual(
        [...releaseFileNames(desktopVersion), DESKTOP_MANIFEST].sort(),
      );
      expect(readdirSync(otherDirectory).sort()).toEqual(
        [...releaseFileNames(desktopVersion), DESKTOP_MANIFEST].sort(),
      );
      expect(releaseFileNames(desktopVersion)).toHaveLength(4);
    } finally {
      rmSync(otherDirectory, { recursive: true, force: true });
    }
  });

  it("materializes a digest-verified exact-four hardlink view for the native verifier", async () => {
    writeEnvelope();
    const manifest = await sealDesktopRelease(directory, binding);
    const parent = mkdtempSync(join(tmpdir(), "desktop-public-envelope-"));
    const output = join(parent, "public");
    try {
      await expect(materializeDesktopPublicEnvelope(directory, output)).resolves.toEqual(manifest);
      expect(readdirSync(output).sort()).toEqual([...releaseFileNames(desktopVersion)].sort());
      expect(readdirSync(output)).not.toContain(DESKTOP_MANIFEST);
      for (const file of manifest.files) {
        expect(lstatSync(join(output, file.name)).ino).toBe(
          lstatSync(join(directory, file.name)).ino,
        );
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("requires the canonical two-entry updater metadata contract", async () => {
    writeEnvelope();
    const metadataPath = join(directory, "latest-mac.yml");
    const metadata = parse(readFileSync(metadataPath, "utf8")) as {
      files: Array<Record<string, unknown>>;
    };
    metadata.files.push({ ...metadata.files[0] });
    writeFileSync(metadataPath, stringify(metadata));
    await expect(sealDesktopRelease(directory, binding)).rejects.toThrow("latest-mac.yml");

    metadata.files.pop();
    metadata.files[0].unexpected = true;
    writeFileSync(metadataPath, stringify(metadata));
    await expect(sealDesktopRelease(directory, binding)).rejects.toThrow("latest-mac.yml");
  });

  it("requires the desktop tag to match the app version and pins the Developer ID team", async () => {
    writeEnvelope();
    await expect(
      sealDesktopRelease(directory, {
        ...binding,
        tag: "enduragent-desktop@0.1.8",
      }),
    ).rejects.toThrow("tag and version do not match");
    await expect(
      sealDesktopRelease(directory, {
        ...binding,
        signingIdentity: "Developer ID Application: Example (ABCDE12345)",
      }),
    ).rejects.toThrow("signing identity");
  });

  it("allows only desktop tags and the exact legacy first-signed tag as baseline evidence", async () => {
    writeEnvelope();
    await expect(
      sealDesktopRelease(directory, {
        ...binding,
        baselineTag: "cycling-coach@2026.8.9",
      }),
    ).rejects.toThrow("baseline evidence");
    await expect(
      sealDesktopRelease(directory, {
        ...binding,
        baselineTag: "cycling-coach@2026.8.8",
      }),
    ).resolves.toMatchObject({ baselineTag: "cycling-coach@2026.8.8" });
  });

  it("rejects an extra pre-seal file and post-seal byte changes", async () => {
    writeEnvelope("old-latest.yml");
    await expect(sealDesktopRelease(directory, binding)).rejects.toThrow("exactly four");

    rmSync(join(directory, "old-latest.yml"));
    await sealDesktopRelease(directory, binding);
    writeFileSync(join(directory, releaseFileNames(desktopVersion)[1]), "conflict");
    await expect(verifyDesktopRelease(directory, binding)).rejects.toThrow("digest mismatch");
  });

  it("rejects a manifest whose release binding is changed", async () => {
    writeEnvelope();
    await sealDesktopRelease(directory, binding);
    const path = join(directory, DESKTOP_MANIFEST);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest.commit = "b".repeat(40);
    manifest.catalog = { releaseGroupId: "b".repeat(40), revision: 1, digest: "0".repeat(64) };
    writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    await expect(verifyDesktopRelease(directory, binding)).rejects.toThrow("transaction hash");
  });

  it("rejects unknown top-level manifest keys", async () => {
    writeEnvelope();
    await sealDesktopRelease(directory, binding);
    const path = join(directory, DESKTOP_MANIFEST);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest.unexpected = true;
    writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    await expect(verifyDesktopRelease(directory, binding)).rejects.toThrow("manifest is invalid");
  });

  it("rejects legacy npm release fields in the desktop manifest", async () => {
    writeEnvelope();
    await sealDesktopRelease(directory, binding);
    const path = join(directory, DESKTOP_MANIFEST);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest.npmVersion = npmVersion;
    writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    await expect(verifyDesktopRelease(directory)).rejects.toThrow("manifest is invalid");
  });

  it("rejects unknown nested-file manifest keys", async () => {
    writeEnvelope();
    await sealDesktopRelease(directory, binding);
    const path = join(directory, DESKTOP_MANIFEST);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      files: Array<Record<string, unknown>>;
    };
    manifest.files[0]!.unexpected = true;
    writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    await expect(verifyDesktopRelease(directory, binding)).rejects.toThrow("manifest is invalid");
  });

  it("rejects unsupported desktop release schema versions", async () => {
    writeEnvelope();
    await sealDesktopRelease(directory, binding);
    const path = join(directory, DESKTOP_MANIFEST);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest.schemaVersion = DESKTOP_RELEASE_SCHEMA_VERSION + 1;
    writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    await expect(verifyDesktopRelease(directory, binding)).rejects.toThrow("manifest is invalid");
  });
});

describe("desktop release publication guards", () => {
  it("rejects stale assets and conflicting bytes while permitting exact resume", async () => {
    writeEnvelope();
    const manifest = await sealDesktopRelease(directory, binding);
    expect(() => assertPublishableAssets([{ name: "old.zip" }], manifest)).toThrow("stale");
    expect(() =>
      assertPublishableAssets([{ name: manifest.files[0].name }], manifest),
    ).not.toThrow();
    const local = readFileSync(join(directory, manifest.files[0].name));
    expect(() => assertRemoteAsset(manifest.files[0], local)).not.toThrow();
    expect(() => assertRemoteAsset(manifest.files[0], Buffer.from("other"))).toThrow("conflicting");
  });

  it("refuses to seal a new genesis transaction", async () => {
    writeEnvelope();
    await expect(
      sealDesktopRelease(directory, {
        ...binding,
        mode: "genesis",
        baselineTag: "none",
        baselineReleaseId: "none",
        baselineCommit: "none",
        baselineZipSha256: "none",
        baselineSigningIdentity: "none",
        baselineCdHash: "none",
      }),
    ).rejects.toThrow("genesis release authority is retired");
    expect(readdirSync(directory)).not.toContain(DESKTOP_MANIFEST);
  });

  it("requires an unchanged latest observation and monotonic desktop version", () => {
    const observed = {
      id: 12,
      tag: "enduragent-desktop@0.1.6",
      metadataSha256: "e".repeat(64),
    };
    expect(() => assertLatestCas(desktopVersion, observed, observed, "0.1.6")).not.toThrow();
    expect(() =>
      assertLatestCas(
        desktopVersion,
        observed,
        { id: 13, tag: "running-coach@2026.8.7", metadataSha256: null },
        "0.1.6",
      ),
    ).toThrow("changed");
    expect(() =>
      assertLatestCas(
        desktopVersion,
        observed,
        { ...observed, metadataSha256: "f".repeat(64) },
        "0.1.6",
      ),
    ).toThrow("changed");
    expect(() => assertLatestCas(desktopVersion, observed, observed, "0.1.8")).toThrow("monotonic");
  });
});

describe("windows release assets", () => {
  function asset(name: string) {
    return {
      id: 1,
      name,
      size: 1,
      digest: "sha256:synthetic",
      state: "uploaded" as const,
      url: `https://api.example.test/assets/${name}`,
      browser_download_url: `https://downloads.example.test/${name}`,
    };
  }

  function release(assets: readonly ReturnType<typeof asset>[]) {
    return {
      id: 123,
      tag_name: `enduragent-desktop@${desktopVersion}`,
      draft: false,
      prerelease: false,
      assets,
      upload_url: "https://uploads.example.test/release",
      body: "synthetic release",
    };
  }

  it("returns the exact Windows release assets including verification evidence", () => {
    expect(windowsReleaseFileNames("0.1.7")).toEqual([
      "Enduragent-0.1.7-x64.exe",
      "Enduragent-0.1.7-x64.exe.blockmap",
      "latest.yml",
      "Enduragent-0.1.7-x64-verification.json",
    ]);
  });

  it("allows the exact same-version Windows assets and still rejects stale assets", async () => {
    writeEnvelope();
    const manifest = await sealDesktopRelease(directory, binding);
    const macos = manifest.files.map((file) => ({ name: file.name }));
    const windows = windowsReleaseFileNames(desktopVersion).map((name) => ({ name }));
    expect(() => assertPublishableAssets([...macos, ...windows], manifest)).not.toThrow();
    expect(() => assertPublishableAssets([...macos, { name: "old.zip" }], manifest)).toThrow(
      "stale",
    );
    expect(() =>
      assertPublishableAssets(
        [...macos, ...windowsReleaseFileNames("0.1.6").map((name) => ({ name }))],
        manifest,
      ),
    ).toThrow("stale");
  });

  it("strips exactly the same-version Windows assets from macOS-owned assets", () => {
    const macos = releaseFileNames(desktopVersion).map(asset);
    const windows = windowsReleaseFileNames(desktopVersion).map(asset);
    const otherWindows = windowsReleaseFileNames("0.1.6").map(asset);
    expect(macosOwnedAssets([...macos, ...windows, ...otherWindows], desktopVersion)).toEqual([
      ...macos,
      ...otherWindows.slice(0, 2),
      otherWindows[3],
    ]);
  });

  it.each([
    ["no", 0],
    ["a partial set of", 1],
    ["a complete set of", 3],
    ["a complete set plus verification evidence", 4],
  ] as const)("resolves a complete macOS release with %s Windows assets", (_label, count) => {
    const macos = releaseFileNames(desktopVersion).map(asset);
    const windows = windowsReleaseFileNames(desktopVersion).map(asset);
    expect(resolveDesktopReleaseVersion(release([...macos, ...windows.slice(0, count)]))).toBe(
      desktopVersion,
    );
  });

  it("rejects foreign Windows assets including verification evidence", () => {
    const macos = releaseFileNames(desktopVersion).map(asset);
    const otherWindows = windowsReleaseFileNames("0.1.6").map(asset);
    expect(resolveDesktopReleaseVersion(release([...macos, ...otherWindows]))).toBeNull();
  });
});
