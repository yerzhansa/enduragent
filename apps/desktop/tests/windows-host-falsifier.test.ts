import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPERIMENT_IDS,
  FalsifierError,
  assessAuthoritativeHost,
  assessCiFoundationHost,
  attestGitHubHostedRunner,
  bufferContainsSentinel,
  canonicalJson,
  classifyFoundationFinalizationError,
  hashStableArtifact,
  redactText,
  resolveFoundationToolchainIdentity,
  resolveWindowsChild,
  retainedAuthoritativeEnvironment,
  retainedFoundationEnvironment,
  runCiFoundation,
  runWithDeadline,
  scanTreeForSentinel,
  validateExperimentRecord,
  validateFoundationRecord,
  validateLocalAppDataPath,
  validateRunId,
} from "../scripts/windows-host-falsifier.mjs";

const temporaryDirectories: string[] = [];
const sha = "a".repeat(64);

const observedHost = {
  platform: "win32",
  processArchitecture: "x64",
  machineArchitecture: "x64",
  windowsEdition: "Professional",
  osCaption: "Microsoft Windows 11 Pro",
  osVersion: "10.0.26100",
  osBuild: "26100",
  productType: "workstation",
  fileSystem: "NTFS",
  elevated: false,
  userSid: "S-1-5-21-111-222-333-1001",
  defenderAntivirusEnabled: true,
  defenderRealtimeProtectionEnabled: true,
  uacDefault: true,
  developerModeEnabled: false,
  toolchain: {
    nodeVersion: "v24.0.0",
    electronVersion: "43.1.1",
    electronBuilderVersion: "26.15.3",
    updaterVersion: "6.6.2",
    nsis: { state: "not-invoked", version: null },
  },
  localAppData: "C:\\Users\\Synthetic User\\AppData\\Local",
} as const;

const hostedObservedHost = {
  ...observedHost,
  windowsEdition: "ServerDatacenter",
  osCaption: "Microsoft Windows Server 2025 Datacenter",
  productType: "server",
  elevated: true,
  defenderRealtimeProtectionEnabled: false,
  uacDefault: false,
  developerModeEnabled: true,
} as const;

const authoritativeObservedHost = {
  ...observedHost,
  toolchain: {
    ...observedHost.toolchain,
    nsis: { state: "observed", version: "3.0.4.1" },
  },
} as const;

function runIdentity() {
  return {
    runId: "synthetic-run-01",
    repositoryCommit: "b".repeat(40),
    repositoryDirty: false,
    scriptSha256: sha,
    startedAt: "2026-08-06T10:00:00.000Z",
    endedAt: "2026-08-06T10:00:01.000Z",
    monotonicDurationMs: 1000,
  };
}

function authoritativeEnvironment() {
  return retainedAuthoritativeEnvironment(authoritativeObservedHost, {
    vmImageId: "synthetic-win11-current",
    vmSnapshotId: "synthetic-clean-snapshot",
  });
}

function foundationEnvironment() {
  return retainedFoundationEnvironment(hostedObservedHost, {
    runnerImage: "windows-2025",
    runnerImageVersion: "synthetic-image-version",
    hostPolicyExceptions: [
      "DEFENDER_REALTIME_DISABLED_ON_GITHUB_HOSTED_RUNNER",
      "DEVELOPER_MODE_ENABLED_ON_GITHUB_HOSTED_RUNNER",
      "ELEVATED_GITHUB_HOSTED_RUNNER",
      "UAC_DISABLED_ON_ELEVATED_GITHUB_HOSTED_SERVER",
      "WINDOWS_SERVER_GITHUB_HOSTED_RUNNER",
    ],
  });
}

function experiment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "experiment",
    authority: "native",
    id: "F-01",
    phase: "probe",
    status: "PASS",
    claim: "Synthetic schema fixture only; this is not retained experiment evidence.",
    environment: authoritativeEnvironment(),
    run: runIdentity(),
    observations: [
      {
        step: "synthetic-contract",
        expected: "schema accepts a valid fixture",
        actual: "valid fixture",
        evidenceRef: null,
      },
    ],
    stopConditionTriggered: false,
    selectedMechanism: "synthetic-mechanism",
    artifactHashes: [],
    ...overrides,
  };
}

function foundation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "ci-foundation",
    authority: "non-authoritative",
    outcome: "foundation-succeeded",
    operationQuiesced: true,
    disposalState: "external-runner-disposal-required",
    failureCode: null,
    claim: "Synthetic foundation schema fixture; closes no F-row.",
    environment: foundationEnvironment(),
    run: runIdentity(),
    observations: [
      {
        step: "synthetic-contract",
        expected: "foundation record remains structurally non-authoritative",
        actual: "non-authoritative",
        evidenceRef: null,
      },
    ],
    artifactHashes: [],
    ...overrides,
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "windows-host-falsifier-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Windows host falsifier result contracts", () => {
  it("accepts only F-01 through F-23 as authoritative experiment ids", () => {
    expect(EXPERIMENT_IDS).toHaveLength(23);
    expect(EXPERIMENT_IDS.at(0)).toBe("F-01");
    expect(EXPERIMENT_IDS.at(-1)).toBe("F-23");
    expect(validateExperimentRecord(experiment())).toMatchObject({
      kind: "experiment",
      authority: "native",
      id: "F-01",
      status: "PASS",
    });
    expect(() => validateExperimentRecord(experiment({ id: "HARNESS-FOUNDATION" }))).toThrow(
      /invalid F-row id/u,
    );
  });

  it("constructs PASS, FAIL, and INCONCLUSIVE contract cases without retaining fake results", async () => {
    const cases = JSON.parse(
      await readFile(new URL("./fixtures/windows-host/status-cases.json", import.meta.url), "utf8"),
    ) as Array<{
      name: string;
      status: "PASS" | "FAIL" | "INCONCLUSIVE";
      stopConditionTriggered: boolean;
      selectedMechanism?: string;
    }>;

    for (const fixture of cases) {
      expect(fixture).not.toHaveProperty("schemaVersion");
      expect(fixture).not.toHaveProperty("id");
      const selected =
        fixture.selectedMechanism === undefined
          ? {}
          : { selectedMechanism: fixture.selectedMechanism };
      const record = experiment({
        status: fixture.status,
        stopConditionTriggered: fixture.stopConditionTriggered,
        ...selected,
      });
      if (fixture.selectedMechanism === undefined) delete record.selectedMechanism;
      expect(validateExperimentRecord(record).status).toBe(fixture.status);
    }
  });

  it("rejects unknown keys, invalid stop-state coupling, and invalid mechanism placement", () => {
    expect(() => validateExperimentRecord(experiment({ extra: true }))).toThrow(/unexpected key/u);
    expect(() =>
      validateExperimentRecord(experiment({ status: "FAIL", stopConditionTriggered: false })),
    ).toThrow(/stop condition/u);

    const missingMechanism = experiment();
    delete missingMechanism.selectedMechanism;
    expect(() => validateExperimentRecord(missingMechanism)).toThrow(/selectedMechanism/u);

    expect(() =>
      validateExperimentRecord(
        experiment({
          phase: "implementation",
          selectedMechanism: "must-not-be-present",
        }),
      ),
    ).toThrow(/allowed only for a probe PASS/u);
  });

  it("rejects experiment authority on a hosted server or dirty worktree", () => {
    expect(() =>
      validateExperimentRecord(
        experiment({
          environment: authoritativeEnvironment(),
          run: { ...runIdentity(), repositoryDirty: true },
        }),
      ),
    ).toThrow(/clean worktree/u);
    expect(() =>
      validateExperimentRecord(
        experiment({
          environment: {
            ...authoritativeEnvironment(),
            osCaption: "Microsoft Windows Server 2025 Datacenter",
            productType: "server",
            elevated: true,
            uacDefault: false,
          },
        }),
      ),
    ).toThrow(/non-authoritative/u);
  });

  it("makes CI foundation records structurally incompatible with F-row authority", () => {
    expect(validateFoundationRecord(foundation())).toMatchObject({
      kind: "ci-foundation",
      authority: "non-authoritative",
      outcome: "foundation-succeeded",
    });
    for (const forbidden of [
      { id: "F-01" },
      { phase: "probe" },
      { status: "PASS" },
      { selectedMechanism: "anything" },
      { stopConditionTriggered: false },
    ]) {
      expect(() => validateFoundationRecord(foundation(forbidden))).toThrow(/unexpected key/u);
    }
    expect(() =>
      validateExperimentRecord(experiment({ environment: foundationEnvironment() })),
    ).toThrow();
    expect(() =>
      validateFoundationRecord(foundation({ environment: authoritativeEnvironment() })),
    ).toThrow();
  });

  it("requires snapshot and observed NSIS identity only for authoritative evidence", () => {
    const { vmSnapshotId: omittedSnapshot, ...missingSnapshot } = authoritativeEnvironment();
    expect(omittedSnapshot).toBe("synthetic-clean-snapshot");
    expect(() => validateExperimentRecord(experiment({ environment: missingSnapshot }))).toThrow(
      /vmSnapshotId/u,
    );

    expect(() =>
      validateExperimentRecord(
        experiment({
          environment: {
            ...authoritativeEnvironment(),
            toolchain: observedHost.toolchain,
          },
        }),
      ),
    ).toThrow(/authoritative NSIS state/u);
    expect(foundationEnvironment().toolchain.nsis).toEqual({
      state: "not-invoked",
      version: null,
    });
  });

  it("retains failed and inconclusive foundation outcomes without F-row status", () => {
    expect(
      validateFoundationRecord(
        foundation({
          outcome: "foundation-failed",
          failureCode: "SYNTHETIC_FAILURE",
        }),
      ),
    ).toMatchObject({ outcome: "foundation-failed", operationQuiesced: true });
    expect(
      validateFoundationRecord(
        foundation({
          outcome: "foundation-inconclusive",
          operationQuiesced: false,
          failureCode: "SYNTHETIC_UNQUIESCED",
        }),
      ),
    ).toMatchObject({ outcome: "foundation-inconclusive", operationQuiesced: false });
    expect(() =>
      validateFoundationRecord(foundation({ outcome: "foundation-failed", failureCode: null })),
    ).toThrow(/failure code/u);
  });

  it("requires sorted, case-unique artifact paths and hashed evidence references", () => {
    const artifactA = { path: "A.txt", sha256: sha };
    const artifactB = { path: "b.txt", sha256: "b".repeat(64) };
    expect(() =>
      validateFoundationRecord(foundation({ artifactHashes: [artifactB, artifactA] })),
    ).toThrow(/bytewise sorted/u);
    expect(() =>
      validateFoundationRecord(
        foundation({ artifactHashes: [artifactA, { ...artifactB, path: "a.TXT" }] }),
      ),
    ).toThrow(/collide case-insensitively/u);
    expect(() =>
      validateFoundationRecord(
        foundation({
          observations: [
            {
              step: "missing-evidence",
              expected: "hash exists",
              actual: "missing",
              evidenceRef: "missing.txt",
            },
          ],
        }),
      ),
    ).toThrow(/unhashed evidenceRef/u);
  });

  it("serializes canonical JSON deterministically and rejects unsupported values", () => {
    expect(canonicalJson({ z: 1, a: { d: 4, c: 3 } })).toBe(
      '{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "z": 1\n}\n',
    );
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/u);
    expect(() => canonicalJson({ value: new Date("2026-08-06T00:00:00.000Z") })).toThrow(/exotic/u);
  });
});

describe("Windows host authority", () => {
  it("accepts a fully attested Windows 11 standard-user host", () => {
    expect(assessAuthoritativeHost(observedHost)).toEqual({ accepted: true });
  });

  it("refuses server, elevation, Arm64 emulation, non-NTFS, and weakened security posture", () => {
    const result = assessAuthoritativeHost({
      ...observedHost,
      machineArchitecture: "arm64",
      osCaption: "Microsoft Windows Server 2025 Datacenter",
      productType: "server",
      fileSystem: "ReFS",
      elevated: true,
      defenderAntivirusEnabled: false,
      defenderRealtimeProtectionEnabled: false,
      uacDefault: false,
      developerModeEnabled: true,
    });
    expect(result).toEqual({
      accepted: false,
      reasons: expect.arrayContaining([
        "MACHINE_NOT_X64",
        "ROOT_NOT_NTFS",
        "NOT_WINDOWS_11_CLIENT",
        "NOT_STANDARD_USER",
        "DEFENDER_ANTIVIRUS_NOT_ENABLED",
        "DEFENDER_REALTIME_NOT_ENABLED",
        "UAC_NOT_DEFAULT",
        "DEVELOPER_MODE_ENABLED_OR_UNKNOWN",
      ]),
    });
  });

  it("allows only explicitly attested GitHub-hosted posture exceptions", () => {
    const attested = { githubHostedRunnerAttested: true };
    expect(assessCiFoundationHost(hostedObservedHost, attested)).toEqual({
      accepted: true,
      exceptions: [
        "DEFENDER_REALTIME_DISABLED_ON_GITHUB_HOSTED_RUNNER",
        "DEVELOPER_MODE_ENABLED_ON_GITHUB_HOSTED_RUNNER",
        "ELEVATED_GITHUB_HOSTED_RUNNER",
        "UAC_DISABLED_ON_ELEVATED_GITHUB_HOSTED_SERVER",
        "WINDOWS_SERVER_GITHUB_HOSTED_RUNNER",
      ],
    });
    expect(assessCiFoundationHost(hostedObservedHost)).toEqual({
      accepted: false,
      reasons: expect.arrayContaining([
        "NOT_WINDOWS_11_CLIENT",
        "NOT_STANDARD_USER",
        "DEFENDER_REALTIME_NOT_ENABLED",
        "DEVELOPER_MODE_ENABLED_OR_UNKNOWN",
        "UAC_NOT_DEFAULT",
      ]),
    });
    expect(
      assessCiFoundationHost({ ...hostedObservedHost, machineArchitecture: "arm64" }, attested),
    ).toEqual({ accepted: false, reasons: ["MACHINE_NOT_X64"] });
    expect(assessCiFoundationHost({ ...hostedObservedHost, fileSystem: "ReFS" }, attested)).toEqual(
      { accepted: false, reasons: ["ROOT_NOT_NTFS"] },
    );
    expect(
      assessCiFoundationHost({ ...hostedObservedHost, defenderAntivirusEnabled: false }, attested),
    ).toEqual({ accepted: false, reasons: ["DEFENDER_ANTIVIRUS_NOT_ENABLED"] });
    expect(
      assessCiFoundationHost({ ...hostedObservedHost, developerModeEnabled: null }, attested),
    ).toEqual({ accepted: false, reasons: ["DEVELOPER_MODE_ENABLED_OR_UNKNOWN"] });
    expect(
      assessCiFoundationHost({ ...hostedObservedHost, developerModeEnabled: false }, attested),
    ).toEqual({
      accepted: true,
      exceptions: [
        "DEFENDER_REALTIME_DISABLED_ON_GITHUB_HOSTED_RUNNER",
        "ELEVATED_GITHUB_HOSTED_RUNNER",
        "UAC_DISABLED_ON_ELEVATED_GITHUB_HOSTED_SERVER",
        "WINDOWS_SERVER_GITHUB_HOSTED_RUNNER",
      ],
    });
  });

  it("binds the hosted exception to protected runner variables and matching image provenance", () => {
    const provenance = {
      runnerImage: "windows-2025",
      runnerImageVersion: "synthetic-image-version",
    };
    const environment = {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Windows",
      ImageOS: provenance.runnerImage,
      ImageVersion: provenance.runnerImageVersion,
    };
    expect(attestGitHubHostedRunner(provenance, environment)).toBe(true);
    expect(
      attestGitHubHostedRunner(provenance, { ...environment, RUNNER_ENVIRONMENT: "self-hosted" }),
    ).toBe(false);
    expect(attestGitHubHostedRunner(provenance, { ...environment, ImageVersion: "mismatch" })).toBe(
      false,
    );
  });

  it("retains strict runner and toolchain provenance without a SID or profile path", async () => {
    const retained = foundationEnvironment();
    expect(retained.userSidSha256).toBe(
      createHash("sha256").update(observedHost.userSid).digest("hex"),
    );
    expect(retained).not.toHaveProperty("userSid");
    expect(retained).not.toHaveProperty("localAppData");
    expect(canonicalJson(retained)).not.toContain("Synthetic User");
    expect(retained).toMatchObject({
      environmentKind: "github-hosted-runner",
      runnerImage: "windows-2025",
      runnerImageVersion: "synthetic-image-version",
      hostPolicyExceptions: [
        "DEFENDER_REALTIME_DISABLED_ON_GITHUB_HOSTED_RUNNER",
        "DEVELOPER_MODE_ENABLED_ON_GITHUB_HOSTED_RUNNER",
        "ELEVATED_GITHUB_HOSTED_RUNNER",
        "UAC_DISABLED_ON_ELEVATED_GITHUB_HOSTED_SERVER",
        "WINDOWS_SERVER_GITHUB_HOSTED_RUNNER",
      ],
    });

    await expect(resolveFoundationToolchainIdentity()).resolves.toMatchObject({
      nodeVersion: expect.stringMatching(/^v24\./u),
      electronVersion: "43.1.1",
      electronBuilderVersion: "26.15.3",
      updaterVersion: "6.6.2",
      nsis: { state: "not-invoked", version: null },
    });
  });
});

describe("bounded Windows paths and identifiers", () => {
  it("accepts a narrow run id and rejects ambiguous ids", () => {
    expect(validateRunId("ci-123-1")).toBe("ci-123-1");
    for (const candidate of ["", "a", "UPPER", "two words", "-leading", "trailing-", "../escape"]) {
      expect(() => validateRunId(candidate)).toThrow(/run id/u);
    }
  });

  it("accepts a local profile path and rejects roots, UNC, and device namespaces", () => {
    expect(validateLocalAppDataPath(observedHost.localAppData)).toBe(observedHost.localAppData);
    for (const candidate of [
      "C:\\",
      "C:/",
      "relative",
      "\\\\server\\share",
      "\\\\?\\C:\\Users\\A",
      "C:\\Users\\A:stream",
      "C:\\Users\\A. ",
    ]) {
      expect(() => validateLocalAppDataPath(candidate)).toThrow(/LOCALAPPDATA/u);
    }
  });

  it("resolves a safe child and rejects the deliberate traversal/path fixture", async () => {
    const root = "C:\\Users\\Synthetic User\\AppData\\Local\\Enduragent-Falsifier\\run-01";
    expect(resolveWindowsChild(root, "evidence\\result.json")).toBe(
      `${root}\\evidence\\result.json`,
    );
    const unsafePaths = JSON.parse(
      await readFile(new URL("./fixtures/windows-host/unsafe-paths.json", import.meta.url), "utf8"),
    ) as string[];
    for (const candidate of unsafePaths) {
      expect(() => resolveWindowsChild(root, candidate), candidate).toThrow();
    }
  });

  it("keeps the hosted CI invocation explicitly non-authoritative and pnpm-compatible", async () => {
    const workflow = await readFile(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("Windows host falsifier foundation (non-authoritative)");
    expect(workflow).toContain("--mode=ci-foundation");
    expect(workflow).toContain("--runner-image=$env:ImageOS");
    expect(workflow).toContain("--runner-image-version=$env:ImageVersion");
    expect(workflow).not.toContain("falsifier -- --mode=ci-foundation");
    expect(workflow).not.toContain("--vm-image-id");
    expect(workflow).not.toMatch(/--(?:id|phase|status)=F-/u);
  });

  it("does not recursively delete a tree before native cleanup mechanisms are selected", async () => {
    const harness = await readFile(
      new URL("../scripts/windows-host-falsifier.mjs", import.meta.url),
      "utf8",
    );
    expect(harness).not.toMatch(/\brm\s*\([^)]*recursive\s*:\s*true/su);
    expect(harness).toContain("external-runner-disposal-required");
  });
});

describe("redaction, scanning, hashing, and deadlines", () => {
  it("redacts the run sentinel, email, SID, and known profile paths", () => {
    const sentinel = "ENDURAGENT-FALSIFIER-SYNTHETIC";
    const text = [
      sentinel,
      "synthetic@example.invalid",
      "S-1-5-21-111-222-333-1001",
      "C:\\Users\\Alice\\secret\\file.txt",
    ].join(" ");
    const redacted = redactText(text, { sentinel });
    expect(redacted).not.toContain(sentinel);
    expect(redacted).not.toContain("synthetic@example.invalid");
    expect(redacted).not.toContain("S-1-5-21");
    expect(redacted).not.toContain("Alice");
  });

  it("detects sentinels in UTF-8 and UTF-16LE bytes", () => {
    const sentinel = "SYNTHETIC-SENTINEL-123";
    expect(bufferContainsSentinel(Buffer.from(`before${sentinel}after`, "utf8"), sentinel)).toBe(
      true,
    );
    expect(bufferContainsSentinel(Buffer.from(`before${sentinel}after`, "utf16le"), sentinel)).toBe(
      true,
    );
    expect(bufferContainsSentinel(Buffer.from("clean", "utf8"), sentinel)).toBe(false);
  });

  it("scans a bounded tree and refuses sentinel content and filenames", async () => {
    const directory = await makeTemporaryDirectory();
    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "clean.txt"), "clean");
    await expect(scanTreeForSentinel(directory, "UNIQUE-SENTINEL")).resolves.toMatchObject({
      files: 1,
    });

    await writeFile(join(nested, "utf16.txt"), Buffer.from("UNIQUE-SENTINEL", "utf16le"));
    await expect(scanTreeForSentinel(directory, "UNIQUE-SENTINEL")).rejects.toMatchObject({
      code: "SENTINEL_CONTENT",
    });
    await rm(join(nested, "utf16.txt"));
    await writeFile(join(nested, "UNIQUE-SENTINEL.txt"), "clean");
    await expect(scanTreeForSentinel(directory, "UNIQUE-SENTINEL")).rejects.toMatchObject({
      code: "SENTINEL_FILENAME",
    });
  });

  it("hashes only a stable regular artifact", async () => {
    const directory = await makeTemporaryDirectory();
    const nested = join(directory, "nested");
    await mkdir(nested);
    const path = join(nested, "artifact.txt");
    await writeFile(path, "synthetic artifact\n");
    await expect(hashStableArtifact(directory, "nested/artifact.txt")).resolves.toEqual({
      path: "nested/artifact.txt",
      sha256: createHash("sha256").update("synthetic artifact\n").digest("hex"),
    });
    for (const forgedPath of ["../artifact.txt", "/artifact.txt", "nested\\artifact.txt"]) {
      await expect(hashStableArtifact(directory, forgedPath)).rejects.toMatchObject({
        code: "SCHEMA_ARTIFACT_PATH",
      });
    }

    const outside = await makeTemporaryDirectory();
    await writeFile(join(outside, "outside.txt"), "outside");
    await expect(hashStableArtifact(directory, "outside.txt")).rejects.toMatchObject({
      code: expect.stringMatching(/HASH|ENOENT/u),
    });
  });

  it("scans the exact retained bytes while hashing", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(join(directory, "artifact.txt"), "UNIQUE-SENTINEL");
    await expect(
      hashStableArtifact(directory, "artifact.txt", { sentinel: "UNIQUE-SENTINEL" }),
    ).rejects.toMatchObject({ code: "SENTINEL_CONTENT" });
  });

  it("classifies only proven sentinel leaks as finalization failures", () => {
    expect(
      classifyFoundationFinalizationError(new FalsifierError("SENTINEL_CONTENT", "synthetic leak")),
    ).toEqual({ outcome: "foundation-failed", failureCode: "SENTINEL_CONTENT" });
    expect(
      classifyFoundationFinalizationError(
        new FalsifierError("HASH_UNSTABLE", "synthetic instability"),
      ),
    ).toEqual({ outcome: "foundation-inconclusive", failureCode: "HASH_UNSTABLE" });
    expect(classifyFoundationFinalizationError(new Error("synthetic uncertainty"))).toEqual({
      outcome: "foundation-inconclusive",
      failureCode: "FOUNDATION_FINALIZATION_FAILED",
    });
  });

  it("waits for aborted work to quiesce before reporting a safe timeout", async () => {
    let observedAbort = false;
    const result = await runWithDeadline(
      async (signal) => {
        await new Promise<void>((resolveAbort) =>
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              setTimeout(resolveAbort, 5);
            },
            { once: true },
          ),
        );
      },
      { timeoutMs: 10, quiescenceMs: 100 },
    );
    expect(observedAbort).toBe(true);
    expect(result).toEqual({ state: "timed-out", quiesced: true });
  });

  it("reports unquiesced work instead of permitting cleanup", async () => {
    const result = await runWithDeadline(async () => new Promise<never>(() => undefined), {
      timeoutMs: 5,
      quiescenceMs: 5,
    });
    expect(result).toEqual({ state: "timed-out", quiesced: false });
  });

  it("returns a rejected operation for total failure finalization", async () => {
    const failure = new Error("synthetic rejection");
    await expect(
      runWithDeadline(
        async () => {
          throw failure;
        },
        { timeoutMs: 50 },
      ),
    ).resolves.toEqual({ state: "rejected", error: failure });
  });

  it.runIf(process.platform === "win32")(
    "persists a rejected native foundation operation as non-authoritative evidence",
    async () => {
      const result = await runCiFoundation({
        runId: `test-failure-${process.pid}`,
        runnerImage: process.env.ImageOS ?? "local-windows",
        runnerImageVersion: process.env.ImageVersion ?? "local-test",
        selfTestOperation: async () => {
          throw new FalsifierError("SYNTHETIC_OPERATION_FAILURE", "synthetic failure");
        },
      });
      expect(result.record).toMatchObject({
        authority: "non-authoritative",
        outcome: "foundation-failed",
        operationQuiesced: true,
        failureCode: "SYNTHETIC_OPERATION_FAILURE",
        disposalState: "external-runner-disposal-required",
      });
      await expect(
        readFile(join(result.evidenceDirectory, "ci-foundation.json"), "utf8"),
      ).resolves.toContain('"outcome": "foundation-failed"');
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "persists an unquiesced timeout and requires external disposal",
    async () => {
      const result = await runCiFoundation({
        runId: `test-timeout-${process.pid}`,
        runnerImage: process.env.ImageOS ?? "local-windows",
        runnerImageVersion: process.env.ImageVersion ?? "local-test",
        timeoutMs: 5,
        quiescenceMs: 5,
        selfTestOperation: async () => new Promise<never>(() => undefined),
      });
      expect(result.record).toMatchObject({
        authority: "non-authoritative",
        outcome: "foundation-inconclusive",
        operationQuiesced: false,
        failureCode: "FOUNDATION_TIMEOUT_UNQUIESCED",
        disposalState: "external-runner-disposal-required",
      });
      await expect(
        readFile(join(result.evidenceDirectory, "ci-foundation.json"), "utf8"),
      ).resolves.toContain('"operationQuiesced": false');
    },
    30_000,
  );
});
