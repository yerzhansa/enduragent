import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NativeClientError,
  buildNativeHelper,
  deriveNativePreflightObservationDigest,
  deriveNativePreflightTranscriptDigest,
  observeNativePreflight,
  validateNativePreflightObservation,
  validateNativePreflightTranscript,
} from "../scripts/windows-host-falsifier/native-client.mjs";

const roots: string[] = [];
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const authoritativeWindowsLab =
  process.platform === "win32" && process.env.ENDURAGENT_AUTHORITATIVE_WINDOWS_LAB === "1";

function observationFields(pathProfileId: "ascii" | "spaces-unicode" = "ascii") {
  const complex = pathProfileId === "spaces-unicode";
  return {
    schemaVersion: 1 as const,
    kind: "windows-host-native-preflight-observation" as const,
    pathProfileId,
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("session"),
    runnerUserSidSha256: sha256("runner-user"),
    rootPathSha256: sha256("root"),
    rootSecuritySha256: sha256("root-security"),
    evidenceRootObjectIdentitySha256: sha256("object"),
    volumeIdSha256: sha256("volume"),
    localAbsolute: true as const,
    interactiveSessionActive: true as const,
    networkPath: false as const,
    removableVolume: false as const,
    reparsePoint: false as const,
    nfcNormalized: true as const,
    containsSpaces: complex,
    containsUnicode: complex,
    fileSystem: "NTFS" as const,
    driveType: "fixed" as const,
    nativeHelperSha256: sha256("helper"),
    nativeCandidateDigest: sha256("candidate"),
    nativeManifestSha256: sha256("manifest"),
    sourceBundleSha256: sha256("sources"),
  };
}

describe("native preflight observer", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("validates a self-digested non-destructive observation envelope", () => {
    const fields = observationFields();
    const observation = validateNativePreflightObservation({
      ...fields,
      observationSha256: deriveNativePreflightObservationDigest(fields),
    });
    expect(observation.observationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(() =>
      validateNativePreflightObservation({
        ...observation,
        bootIdSha256: sha256("another-boot"),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NativeClientError>>({
        code: "NATIVE_PREFLIGHT_OBSERVATION_DIGEST",
      }),
    );
  });

  it("rejects storage and path-profile claims that the native observer did not prove", () => {
    for (const fields of [
      { ...observationFields(), networkPath: true },
      { ...observationFields(), interactiveSessionActive: false },
      { ...observationFields(), fileSystem: "ReFS" },
      { ...observationFields("spaces-unicode"), containsUnicode: false },
      { ...observationFields(), privateKey: "forbidden" },
    ]) {
      expect(() =>
        validateNativePreflightObservation({
          ...fields,
          observationSha256: sha256("invalid"),
        }),
      ).toThrowError(NativeClientError);
    }
  });

  it("validates a canonical transcript bound to one candidate, root, and profile", () => {
    const fields = observationFields();
    const observation = validateNativePreflightObservation({
      ...fields,
      observationSha256: deriveNativePreflightObservationDigest(fields),
    });
    const draft = {
      schemaVersion: 1 as const,
      kind: "windows-host-native-preflight-transcript" as const,
      binding: {
        candidateRootSha256: sha256("candidate-root"),
        candidateDirectorySha256: sha256("candidate-directory"),
        requestedRunRootSha256: sha256("run-root"),
        rootMutationCheck: "bounded-recursive-before-after-v1" as const,
        nativeHelperArtifactPath: "bin/windows-host-falsifier-native.exe",
        nativeHelperSha256: fields.nativeHelperSha256,
        nativeCandidateDigest: fields.nativeCandidateDigest,
        nativeManifestSha256: fields.nativeManifestSha256,
        sourceBundleSha256: fields.sourceBundleSha256,
        pathProfileId: fields.pathProfileId,
      },
      observation,
      termination: { code: 0 as const, signal: null, stderrBytes: 0 as const },
    };
    const transcript = validateNativePreflightTranscript({
      ...draft,
      transcriptSha256: deriveNativePreflightTranscriptDigest(draft),
    });
    expect(transcript.transcriptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      validateNativePreflightTranscript({
        ...transcript,
        binding: { ...transcript.binding, requestedRunRootSha256: sha256("other-root") },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NativeClientError>>({
        code: "NATIVE_PREFLIGHT_TRANSCRIPT_DIGEST",
      }),
    );
  });

  it.skipIf(process.platform === "win32")("refuses native observation off Windows", async () => {
    await expect(
      observeNativePreflight({
        runRoot: "/tmp/evidence",
        pathProfileId: "ascii",
        candidateRoot: "/tmp/candidate",
        candidateDirectory: "/tmp/candidate/bin",
      }),
    ).rejects.toMatchObject({ code: "NATIVE_PLATFORM" });
  });

  it.runIf(authoritativeWindowsLab)(
    "observes both path profiles without changing nested root state",
    async () => {
      const labRoot = await mkdtemp(join(tmpdir(), "enduragent-native-observer-"));
      roots.push(labRoot);
      const candidateRoot = join(labRoot, "candidate");
      await mkdir(candidateRoot);
      const build = await buildNativeHelper({ runRoot: candidateRoot, timeoutMs: 90_000 });
      const profiles = [
        { pathProfileId: "ascii" as const, leaf: "evidence-ascii" },
        { pathProfileId: "spaces-unicode" as const, leaf: "evidence space-é" },
      ];
      for (const profile of profiles) {
        const evidenceRoot = join(labRoot, profile.leaf);
        const nested = join(evidenceRoot, "nested");
        const factPath = join(nested, "fact.txt");
        await mkdir(evidenceRoot);
        await mkdir(nested);
        await writeFile(factPath, `pre-existing-${profile.pathProfileId}\n`, "utf8");
        const beforeEntries = (await readdir(evidenceRoot, { recursive: true })).sort();
        const beforeFact = await readFile(factPath);
        const observed = await observeNativePreflight({
          runRoot: evidenceRoot,
          pathProfileId: profile.pathProfileId,
          candidateRoot: build.candidateRoot,
          candidateDirectory: build.candidateDirectory,
          timeoutMs: 90_000,
        });

        expect((await readdir(evidenceRoot, { recursive: true })).sort()).toEqual(beforeEntries);
        expect(await readFile(factPath)).toEqual(beforeFact);
        expect(observed.observation).toMatchObject({
          pathProfileId: profile.pathProfileId,
          localAbsolute: true,
          networkPath: false,
          removableVolume: false,
          reparsePoint: false,
          fileSystem: "NTFS",
          driveType: "fixed",
          nativeHelperSha256: build.assemblySha256,
          nativeCandidateDigest: build.candidateDigest,
          nativeManifestSha256: build.manifestSha256,
          sourceBundleSha256: build.sourceBundleSha256,
          rootSecuritySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        });
        expect(observed.transcript.binding.rootMutationCheck).toBe(
          "bounded-recursive-before-after-v1",
        );
        expect(observed.transcript.observation).toEqual(observed.observation);
        expect(observed.transcriptBytes.at(-1)).toBe(0x0a);
        const attestationDirectory = join(evidenceRoot, "attestations");
        await mkdir(attestationDirectory);
        await writeFile(join(attestationDirectory, "guest.json"), observed.transcriptBytes);
        const repeated = await observeNativePreflight({
          runRoot: evidenceRoot,
          pathProfileId: profile.pathProfileId,
          candidateRoot: build.candidateRoot,
          candidateDirectory: build.candidateDirectory,
          timeoutMs: 90_000,
        });
        expect(repeated.transcriptBytes).toEqual(observed.transcriptBytes);
      }
    },
    180_000,
  );
});
