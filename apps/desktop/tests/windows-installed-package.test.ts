import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCanonicalTree,
  compareInstalledTree,
  discoverInstalledPackage,
  executeWithGuaranteedUninstall,
  parseNativeEvidenceResult,
  parseRegisteredUninstallCommands,
  runWindowsInstalledPackage,
  validateSignaturePolicy,
  waitForCleanupEvidence,
} from "../scripts/windows-installed-package.mjs";
import {
  createPrimaryAcknowledgmentFailureObserver,
  createSecuritySmokeStageObserver,
  createPrimarySecondInstanceObserver,
  createWindowsSecurityControlPipeName,
  formatSafeProcessTerminal,
  observeProcessExit,
  requireRunningPrimaryBeforeSecondLaunch,
  requestPackagedShutdown,
  removeWindowsScratch,
  SECURITY_SMOKE_SHUTDOWN_STAGES,
  throwPackagedCompletionFailures,
  validatePackagedSecondLaunch,
  validateReadyFrame,
  validateSelfTestTerminal,
  waitForPackagedSecondLaunchEvidence,
  waitForPackagedApplicationExit,
} from "../scripts/verify-windows-packaged-self-test.mjs";

const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function directoryStat(extra: Record<string, unknown> = {}) {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    size: 0,
    ...extra,
  };
}

function file(path: string, sha256 = "a", size = 1) {
  return { path, type: "file" as const, size, sha256 };
}

function directory(path: string) {
  return { path, type: "directory" as const, size: 0, sha256: null };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    keyPath: "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\x",
    keyName: "80611707-2ddf-50e5-b3ec-95f38ab4a6fa",
    displayName: "Enduragent 0.1.3",
    displayVersion: "0.1.3",
    installLocation: "C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent",
    uninstallString:
      '"C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Uninstall Enduragent.exe" /currentuser',
    quietUninstallString:
      '"C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Uninstall Enduragent.exe" /currentuser /S',
    ...overrides,
  };
}

function cleanCleanupEvidence(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    registrations: [],
    programResidues: [],
    processes: [],
    shortcut: { path: "shortcut", exists: false, targetPath: null, arguments: null, workingDirectory: null },
    run: { exists: false, value: null },
    startupApproved: { exists: false, valueBase64: null },
    reparsePaths: [],
    signatures: [],
    ...overrides,
  };
}

describe("canonical installed package manifests", () => {
  it("streams regular files into ordinal normalized manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "w17-manifest-"));
    scratchRoots.push(root);
    await writeFile(join(root, "b.bin"), "beta");
    await writeFile(join(root, "a.bin"), "alpha");
    const manifest = await collectCanonicalTree(root, { createReadStream });
    expect(manifest.map((entry) => entry.path)).toEqual(["a.bin", "b.bin"]);
    expect(manifest.every((entry) => entry.type === "file" && entry.sha256?.length === 64)).toBe(true);
  });

  it("rejects case-fold collisions", async () => {
    await expect(
      collectCanonicalTree("/synthetic", {
        lstat: vi.fn(async () => directoryStat() as never),
        readdir: vi.fn(async (path: string) => (path === "/synthetic" ? ["A", "a"] : [])),
      }),
    ).rejects.toThrow("case-fold collision");
  });

  it("rejects reparse points", async () => {
    await expect(
      collectCanonicalTree("/synthetic", {
        lstat: vi.fn(async (path: string) =>
          directoryStat(
            path === join("/synthetic", "link") ? { isSymbolicLink: () => true } : {},
          ) as never,
        ),
        readdir: vi.fn(async (path: string) => (path === "/synthetic" ? ["link"] : [])),
      }),
    ).rejects.toThrow("reparse point");
  });

  it("accepts an exact installed tree with one exact uninstaller", () => {
    const retained = [directory("resources"), file("resources/app.asar", "one", 3)];
    const installed = [...retained, file("Uninstall Enduragent.exe", "two", 7)];
    expect(compareInstalledTree(retained, installed, "Uninstall Enduragent.exe").uninstaller).toEqual(
      file("Uninstall Enduragent.exe", "two", 7),
    );
  });

  it("compares paths case-insensitively while preserving collision rejection", () => {
    const retained = [file("Resources/App.asar", "one", 3)];
    const installed = [
      file("resources/app.asar", "one", 3),
      file("uninstall enduragent.exe", "two", 7),
    ];
    expect(compareInstalledTree(retained, installed, "Uninstall Enduragent.exe").uninstaller.path).toBe(
      "uninstall enduragent.exe",
    );
    expect(() =>
      compareInstalledTree(
        [file("A", "one"), file("a", "one")],
        [file("Uninstall Enduragent.exe", "two")],
        "Uninstall Enduragent.exe",
      ),
    ).toThrow("case-fold collision");
  });

  it.each([
    ["missing", [file("a", "one")], [file("Uninstall Enduragent.exe", "u")]],
    ["extra", [file("a", "one")], [file("a", "one"), file("extra", "x"), file("Uninstall Enduragent.exe", "u")]],
    ["hash", [file("a", "one")], [file("a", "two"), file("Uninstall Enduragent.exe", "u")]],
    ["type", [file("a", "one")], [directory("a"), file("Uninstall Enduragent.exe", "u")]],
  ])("rejects a %s tree mismatch", (_label, retained, installed) => {
    expect(() => compareInstalledTree(retained, installed, "Uninstall Enduragent.exe")).toThrow();
  });
});

describe("installed registration discovery", () => {
  const expected = {
    productName: "Enduragent",
    version: "0.1.3",
    localAppData: "C:\\Users\\runner\\AppData\\Local",
    guid: "80611707-2ddf-50e5-b3ec-95f38ab4a6fa",
  };

  it("discovers one exact registration and treats its command as inert data", () => {
    const result = discoverInstalledPackage({ registrations: [registration()] } as never, expected);
    expect(result.executable).toBe(
      "C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Enduragent.exe",
    );
    expect(result.uninstaller).toBe(
      "C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Uninstall Enduragent.exe",
    );
  });

  it.each([
    ["zero", []],
    ["duplicate", [registration(), registration({ keyPath: "second" })]],
    ["identity-alias", [registration(), registration({ keyName: "icu.enduragent.desktop" })]],
    ["outside", [registration({ installLocation: "C:\\Outside", uninstallString: '"C:\\Outside\\uninstall.exe"' })]],
    ["malformed", [registration({ uninstallString: "cmd.exe /c destructive" })]],
    [
      "different-quiet-path",
      [registration({ quietUninstallString: '"C:\\other\\uninstall.exe" /currentuser /S' })],
    ],
    ["version", [registration({ displayVersion: "0.1.2" })]],
    ["display-name", [registration({ displayName: "Enduragent" })]],
    ["identity", [registration({ keyName: "wrong-guid" })]],
    [
      "programs-root",
      [
        registration({
          installLocation: "c:\\users\\runner\\appdata\\local\\programs",
          uninstallString: '"c:\\users\\runner\\appdata\\local\\programs\\uninstall.exe" /currentuser',
          quietUninstallString:
            '"c:\\users\\runner\\appdata\\local\\programs\\uninstall.exe" /currentuser /S',
        }),
      ],
    ],
  ])("rejects %s registration evidence", (_label, registrations) => {
    expect(() => discoverInstalledPackage({ registrations } as never, expected)).toThrow();
  });

  it("rejects raw command syntax instead of executing it", () => {
    expect(() =>
      parseRegisteredUninstallCommands(
        {
          uninstallString: '"C:\\safe\\uninstall.exe" & calc.exe',
          quietUninstallString: '"C:\\safe\\uninstall.exe" /currentuser /S',
        },
        "C:\\safe",
      ),
    ).toThrow("malformed");
  });

  it("rejects whitespace outside the exact registered command", () => {
    expect(() =>
      parseRegisteredUninstallCommands(
        {
          uninstallString: ' "C:\\safe\\uninstall.exe" /currentuser',
          quietUninstallString: '"C:\\safe\\uninstall.exe" /currentuser /S',
        },
        "C:\\safe",
      ),
    ).toThrow("malformed");
  });

  it("accepts a direct child whose name begins with two dots", () => {
    const root = "C:\\Users\\runner\\AppData\\Local\\Programs\\..Enduragent";
    const result = discoverInstalledPackage(
      {
        registrations: [
          registration({
            installLocation: root,
            uninstallString: `"${root}\\uninstall.exe" /currentuser`,
            quietUninstallString: `"${root}\\uninstall.exe" /currentuser /S`,
          }),
        ],
      } as never,
      expected,
    );
    expect(result.installRoot).toBe(root);
  });
});

describe("unsigned private signature policy", () => {
  const installer = "C:\\artifact\\Enduragent.exe";
  const main = "C:\\installed\\Enduragent.exe";
  const uninstaller = "C:\\installed\\Uninstall Enduragent.exe";
  const owned = [installer, main, uninstaller];

  it("requires NotSigned for owned binaries and accepts native vendor status", () => {
    expect(
      validateSignaturePolicy(
        [
          ...owned.map((path) => ({ path, status: "NotSigned" })),
          { path: "C:\\installed\\ffmpeg.dll", status: "Valid" },
          { path: "C:\\installed\\vulkan-1.dll", status: "NotSigned" },
        ],
        "unsigned-private",
        owned,
        [...owned, "C:\\installed\\ffmpeg.dll", "C:\\installed\\vulkan-1.dll"],
      ),
    ).toBe(true);
  });

  it.each(["HashMismatch", "NotTrusted", "UnknownError"])("rejects vendor %s", (status) => {
    expect(() =>
      validateSignaturePolicy(
        [...owned.map((path) => ({ path, status: "NotSigned" })), { path: "C:\\installed\\vendor.dll", status }],
        "unsigned-private",
        owned,
        [...owned, "C:\\installed\\vendor.dll"],
      ),
    ).toThrow(status);
  });

  it("rejects signed owned binaries", () => {
    expect(() =>
      validateSignaturePolicy(
        owned.map((path, index) => ({ path, status: index === 0 ? "Valid" : "NotSigned" })),
        "unsigned-private",
        owned,
        owned,
      ),
    ).toThrow("Enduragent-owned");
  });

  it("rejects extra signature evidence", () => {
    expect(() =>
      validateSignaturePolicy(
        [...owned.map((path) => ({ path, status: "NotSigned" })), { path: "C:\\extra.dll", status: "Valid" }],
        "unsigned-private",
        owned,
        owned,
      ),
    ).toThrow("unexpected signature evidence");
  });
});

describe("guaranteed uninstall", () => {
  it("attempts uninstall after a primary failure", async () => {
    const uninstall = vi.fn(async () => {});
    await expect(
      executeWithGuaranteedUninstall(async () => {
        throw new Error("runtime failed");
      }, uninstall),
    ).rejects.toThrow("runtime failed");
    expect(uninstall).toHaveBeenCalledOnce();
  });

  it("preserves primary and cleanup failures", async () => {
    const failure = executeWithGuaranteedUninstall(
      async () => {
        throw new Error("runtime failed");
      },
      async () => {
        throw new Error("uninstall failed");
      },
    );
    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await expect(failure).rejects.toMatchObject({ errors: [new Error("runtime failed"), new Error("uninstall failed")] });
  });
});

describe("uninstall cleanup convergence", () => {
  it("polls the complete native cleanup evidence until it converges", async () => {
    const clean = cleanCleanupEvidence();
    const readEvidence = vi
      .fn()
      .mockResolvedValueOnce(
        cleanCleanupEvidence({
          registrations: [registration()],
          run: { exists: true, value: "Enduragent.exe" },
        }),
      )
      .mockResolvedValueOnce(clean);
    const delay = vi.fn(async () => {});

    await expect(
      waitForCleanupEvidence(readEvidence, { delay, now: vi.fn(() => 0) }),
    ).resolves.toEqual(clean);
    expect(readEvidence).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(500);
  });

  it("fails with the fixed cleanup diagnostic at the existing deadline", async () => {
    const dirty = cleanCleanupEvidence({ registrations: [registration()] });
    const readEvidence = vi.fn(async () => dirty);
    const delay = vi.fn(async () => {});
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(30_000);

    await expect(waitForCleanupEvidence(readEvidence, { delay, now })).rejects.toThrow(
      /^uninstall registration remains$/u,
    );
    expect(readEvidence).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });
});

describe("native evidence result parsing", () => {
  it("returns successful native evidence", () => {
    const evidence = { ok: true, registrations: [] };
    expect(
      parseNativeEvidenceResult(
        { code: 0, signal: null, stdout: `${JSON.stringify(evidence)}\n`, stderr: "" },
        "native Windows evidence evidence",
      ),
    ).toEqual(evidence);
  });

  it("surfaces only a fixed native failure stage", () => {
    const stdout = `${JSON.stringify({
      ok: false,
      error: { code: "NATIVE_EVIDENCE_FAILED", stage: "install-location" },
    })}\n`;
    expect(() =>
      parseNativeEvidenceResult(
        { code: 1, signal: null, stdout, stderr: "" },
        "native Windows evidence evidence",
      ),
    ).toThrow("native Windows evidence evidence failed at install-location");
  });

  it.each([
    "registrations",
    "program-residues",
    "processes",
    "shortcut",
    "run",
    "startup-approved",
    "reparse-paths",
    "signatures",
  ])("accepts the fixed %s evidence substage", (stage) => {
    const stdout = `${JSON.stringify({
      ok: false,
      error: { code: "NATIVE_EVIDENCE_FAILED", stage },
    })}\n`;
    expect(() =>
      parseNativeEvidenceResult(
        { code: 1, signal: null, stdout, stderr: "" },
        "native Windows evidence evidence",
      ),
    ).toThrow(`native Windows evidence evidence failed at ${stage}`);
  });

  it.each([
    { ok: false, error: { code: "NATIVE_EVIDENCE_FAILED", stage: "unknown" } },
    { ok: false, error: { code: "RAW_EXCEPTION", stage: "evidence" } },
    { ok: false, error: { code: "NATIVE_EVIDENCE_FAILED", stage: "evidence", path: "C:\\secret" } },
  ])("rejects malformed native failure evidence", (failure) => {
    expect(() =>
      parseNativeEvidenceResult(
        { code: 1, signal: null, stdout: `${JSON.stringify(failure)}\n`, stderr: "" },
        "native Windows evidence evidence",
      ),
    ).toThrow(/^native Windows evidence evidence failed$/u);
  });

  it("rejects a failure envelope paired with a successful exit", () => {
    const stdout = `${JSON.stringify({
      ok: false,
      error: { code: "NATIVE_EVIDENCE_FAILED", stage: "evidence" },
    })}\n`;
    expect(() =>
      parseNativeEvidenceResult(
        { code: 0, signal: null, stdout, stderr: "" },
        "native Windows evidence evidence",
      ),
    ).toThrow(/^native Windows evidence evidence reported failure$/u);
  });

  it("rejects a signaled native failure without exposing its envelope", () => {
    const stdout = `${JSON.stringify({
      ok: false,
      error: { code: "NATIVE_EVIDENCE_FAILED", stage: "evidence" },
    })}\n`;
    expect(() =>
      parseNativeEvidenceResult(
        { code: null, signal: "SIGTERM", stdout, stderr: "" },
        "native Windows evidence evidence",
      ),
    ).toThrow(/^native Windows evidence evidence failed$/u);
  });

  it("rejects native stderr without exposing its contents", () => {
    expect(() =>
      parseNativeEvidenceResult(
        {
          code: 1,
          signal: null,
          stdout: "",
          stderr: "registry failure at C:\\Users\\runneradmin\\secret",
        },
        "native Windows evidence evidence",
      ),
    ).toThrow(/^native Windows evidence evidence wrote stderr$/u);
  });
});

describe("packaged second launch", () => {
  const privateValues = ["C:\\private\\athlete-home", "private-daemon-token"];
  const marker = "DESKTOP_SECURITY_SECOND_INSTANCE\n";

  it("accepts a clean loser with harmless captured output", () => {
    expect(
      validatePackagedSecondLaunch(
        {
          code: 0,
          signal: null,
          stdout: `diagnostic output\n${marker}`,
          stderr: "desktop-crash-reporter-unavailable\n",
        },
        privateValues,
      ),
    ).toMatchObject({ code: 0, signal: null });
  });

  it.each([
    [
      { code: 1, signal: null, stdout: marker, stderr: "" },
      "packaged second launch failed; code=1; signal=none; marker=present",
    ],
    [
      { code: 3_221_225_477, signal: null, stdout: "", stderr: "" },
      "packaged second launch failed; code=3221225477; signal=none; marker=absent",
    ],
    [
      { code: null, signal: "SIGTERM", stdout: marker, stderr: "" },
      "packaged second launch failed; code=unknown; signal=SIGTERM; marker=present",
    ],
    [
      { code: null, signal: "private-daemon-token", stdout: marker, stderr: "" },
      "packaged second launch failed; code=unknown; signal=unknown; marker=present",
    ],
  ])("classifies an unclean loser without exposing its result", (result, diagnostic) => {
    expect(() => validatePackagedSecondLaunch(result, privateValues)).toThrow(
      new RegExp(`^${diagnostic}$`, "u"),
    );
  });

  it.each([
    ["", "", "absent"],
    [marker.repeat(2), "", "invalid"],
    ["DESKTOP_SECURITY_SECOND_INSTANCE", "", "invalid"],
    ["prefix DESKTOP_SECURITY_SECOND_INSTANCE\n", "", "invalid"],
    ["DESKTOP_SECURITY_SECOND_INSTANCE suffix\n", "", "invalid"],
    ["", marker, "invalid"],
  ])("rejects malformed marker evidence %#", (stdout, stderr, markerState) => {
    expect(() =>
      validatePackagedSecondLaunch({ code: 0, signal: null, stdout, stderr }, privateValues),
    ).toThrow(
      new RegExp(
        `^packaged second launch failed; code=0; signal=none; marker=${markerState}$`,
        "u",
      ),
    );
  });

  it("rejects a readiness marker without exposing captured output", () => {
    const output = "DESKTOP_SECURITY_READY C:\\private\\readiness";
    expect(() =>
      validatePackagedSecondLaunch(
        { code: 0, signal: null, stdout: `${marker}${output}`, stderr: "" },
        privateValues,
      ),
    ).toThrow(/^packaged second launch emitted a readiness marker$/u);
    try {
      validatePackagedSecondLaunch(
        { code: 0, signal: null, stdout: `${marker}${output}`, stderr: "" },
        privateValues,
      );
    } catch (error) {
      expect(String(error)).not.toContain("C:\\private\\readiness");
    }
  });

  it.each(privateValues)("rejects a supplied private value without exposing it", (privateValue) => {
    expect(() =>
      validatePackagedSecondLaunch(
        { code: 1, signal: "private-signal", stdout: marker, stderr: `diagnostic ${privateValue}` },
        privateValues,
      ),
    ).toThrow(/^packaged second launch output exposed private data$/u);
    try {
      validatePackagedSecondLaunch(
        { code: 1, signal: "private-signal", stdout: marker, stderr: `diagnostic ${privateValue}` },
        privateValues,
      );
    } catch (error) {
      expect(String(error)).not.toContain(privateValue);
    }
  });
});

describe("packaged primary identity", () => {
  const ready = {
    url: "enduragent://app/index.html",
    rpcUrl: "ws://127.0.0.1:18473",
    hasSingleInstanceLock: true,
    visibleForSecondLaunch: true,
    bridgeKeys: ["desktop"],
    noNodeGlobals: true,
    rpcConnected: true,
    blockedOffPort: true,
    rendererSurface: "app",
    credentialStatusesMetadataOnly: true,
    tokenAbsentInRendererSurfaces: true,
  };

  it("requires the ready primary to retain Electron's single-instance lock", () => {
    expect(validateReadyFrame(ready)).toBe(ready);
    expect(() => validateReadyFrame({ ...ready, hasSingleInstanceLock: false })).toThrow(
      /^packaged security assertion failed at hasSingleInstanceLock$/u,
    );
    expect(() => validateReadyFrame({ ...ready, visibleForSecondLaunch: false })).toThrow(
      /^packaged security assertion failed at visibleForSecondLaunch$/u,
    );
  });

  it("accepts only known packaged renderer surfaces", () => {
    expect(validateReadyFrame({ ...ready, rendererSurface: "app" })).toMatchObject({
      rendererSurface: "app",
    });
    expect(validateReadyFrame({ ...ready, rendererSurface: "setup-gate" })).toMatchObject({
      rendererSurface: "setup-gate",
    });

    const missingRendererSurface: Record<string, unknown> = { ...ready };
    delete missingRendererSurface.rendererSurface;
    for (const candidate of [
      { ...ready, rendererSurface: null },
      { ...ready, rendererSurface: "unknown" },
      missingRendererSurface,
    ]) {
      expect(() => validateReadyFrame(candidate)).toThrow(/^packaged renderer surface was invalid$/u);
    }
  });

  it("rejects an exited primary before starting the second process", () => {
    expect(() =>
      requireRunningPrimaryBeforeSecondLaunch({ exitCode: null, signalCode: null }),
    ).not.toThrow();
    for (const child of [
      { exitCode: 0, signalCode: null },
      { exitCode: null, signalCode: "SIGTERM" },
    ]) {
      expect(() => requireRunningPrimaryBeforeSecondLaunch(child)).toThrow(
        /^packaged Windows primary exited before second launch$/u,
      );
    }
  });
});

describe("packaged Windows control pipe", () => {
  it("derives one private candidate-scoped local pipe name", () => {
    expect(createWindowsSecurityControlPipeName("eaw-Ab09xy")).toBe(
      String.raw`\\.\pipe\enduragent-w17-eaw-Ab09xy`,
    );
    for (const candidate of ["", "private/path", "x".repeat(65)]) {
      expect(() => createWindowsSecurityControlPipeName(candidate)).toThrow(
        /^packaged Windows control pipe candidate was invalid$/u,
      );
    }
  });
});

describe("packaged primary second-instance evidence", () => {
  const second = { code: 0, signal: null, stdout: "", stderr: "" };

  it("parses one fragmented fixed primary acknowledgment", async () => {
    const observer = createPrimarySecondInstanceObserver();
    observer.write("harmless\nDESKTOP_SECURITY_PRIMARY_SECOND_");
    observer.write("INSTANCE\n");
    await expect(observer.acknowledgment).resolves.toBeUndefined();
    expect(observer.isAcknowledged()).toBe(true);
  });

  it.each([
    "DESKTOP_SECURITY_PRIMARY_SECOND_INSTANCE suffix\n",
    "DESKTOP_SECURITY_PRIMARY_SECOND_INSTANCE\nDESKTOP_SECURITY_PRIMARY_SECOND_INSTANCE\n",
  ])("rejects invalid primary acknowledgment evidence %#", async (source) => {
    const observer = createPrimarySecondInstanceObserver();
    observer.write(source);
    await expect(observer.failure).resolves.toMatchObject({
      message: "packaged Windows primary second-instance evidence was invalid",
    });
  });

  it("requires both the primary acknowledgment and secondary result", async () => {
    let acknowledge = () => {};
    let finishSecond = (_result: typeof second) => {};
    const primaryAcknowledgment = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const secondResult = new Promise<typeof second>((resolve) => {
      finishSecond = resolve;
    });
    let settled = false;
    const evidence = waitForPackagedSecondLaunchEvidence({
      second: secondResult,
      primaryAcknowledgment,
      primaryAcknowledgmentEvidenceFailure: new Promise(() => {}),
      primaryAcknowledgmentWriteFailure: new Promise(() => {}),
      primaryAcknowledged: () => true,
      primaryExited: new Promise(() => {}),
      deadline: performance.now() + 10_000,
    }).then((result) => {
      settled = true;
      return result;
    });
    finishSecond(second);
    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledge();
    await expect(evidence).resolves.toBe(second);
  });

  it("maps primary exit code 2 and every other exit without private data", async () => {
    for (const [result, acknowledged, message] of [
      [
        { code: 2, signal: null },
        false,
        "packaged Windows primary was terminated during second launch; code=2; signal=none; ack=absent",
      ],
      [
        { code: null, signal: "C:\\private\\signal" },
        true,
        "packaged Windows primary exited during second launch; code=unknown; signal=unknown; ack=present",
      ],
    ] as const) {
      await expect(
        waitForPackagedSecondLaunchEvidence({
          second: new Promise(() => {}),
          primaryAcknowledgment: new Promise(() => {}),
          primaryAcknowledgmentEvidenceFailure: new Promise(() => {}),
          primaryAcknowledgmentWriteFailure: new Promise(() => {}),
          primaryAcknowledged: () => acknowledged,
          primaryExited: Promise.resolve(result),
          deadline: performance.now() + 10_000,
        }),
      ).rejects.toThrow(new RegExp(`^${message}$`, "u"));
    }
  });

  it("does not expose primary acknowledgment evidence failures", async () => {
    await expect(
      waitForPackagedSecondLaunchEvidence({
        second: new Promise(() => {}),
        primaryAcknowledgment: new Promise(() => {}),
        primaryAcknowledgmentEvidenceFailure: Promise.resolve(
          new Error("C:\\private\\primary-acknowledgment"),
        ),
        primaryAcknowledgmentWriteFailure: new Promise(() => {}),
        primaryAcknowledged: () => false,
        primaryExited: new Promise(() => {}),
        deadline: performance.now() + 10_000,
      }),
    ).rejects.toThrow(/^packaged Windows primary second-instance evidence was invalid$/u);
  });

  it("fails at the absolute deadline when the secondary closes without a primary acknowledgment", async () => {
    await expect(
      waitForPackagedSecondLaunchEvidence({
        second: Promise.resolve(second),
        primaryAcknowledgment: new Promise(() => {}),
        primaryAcknowledgmentEvidenceFailure: new Promise(() => {}),
        primaryAcknowledgmentWriteFailure: new Promise(() => {}),
        primaryAcknowledged: () => false,
        primaryExited: new Promise(() => {}),
        deadline: performance.now(),
      }),
    ).rejects.toThrow(
      /^packaged Windows primary second-instance acknowledgment timed out$/u,
    );
  });

  it("observes only the exact fixed primary acknowledgment write failure frame", async () => {
    const observer = createPrimaryAcknowledgmentFailureObserver();
    observer.write("private C:\\athlete\nDESKTOP_SECURITY_PRIMARY_SECOND_INSTANCE_");
    observer.write("FAILURE\n");
    await expect(observer.failure).resolves.toMatchObject({
      message: "packaged Windows primary acknowledgment write failed",
    });
  });

  it("fails immediately on the fixed primary acknowledgment write failure", async () => {
    await expect(
      waitForPackagedSecondLaunchEvidence({
        second: new Promise(() => {}),
        primaryAcknowledgment: new Promise(() => {}),
        primaryAcknowledgmentEvidenceFailure: new Promise(() => {}),
        primaryAcknowledgmentWriteFailure: Promise.resolve(
          new Error("C:\\private\\ack-write"),
        ),
        primaryAcknowledged: () => false,
        primaryExited: new Promise(() => {}),
        deadline: performance.now() + 10_000,
      }),
    ).rejects.toThrow(/^packaged Windows primary acknowledgment write failed$/u);
  });

  it("shares one path-free process terminal formatter", () => {
    expect(formatSafeProcessTerminal({ code: 7, signal: null })).toBe("code=7; signal=none");
    expect(formatSafeProcessTerminal({ code: null, signal: "SIGTERM" })).toBe(
      "code=unknown; signal=SIGTERM",
    );
    expect(formatSafeProcessTerminal({ code: null, signal: "C:\\private" })).toBe(
      "code=unknown; signal=unknown",
    );
  });
});

describe("packaged application process exit", () => {
  it("resolves on exit without waiting for close", async () => {
    const child = new EventEmitter();
    const exited = observeProcessExit(child as never);
    child.emit("exit", 0, null);
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
  });

  it("does not resolve on close alone", async () => {
    const child = new EventEmitter();
    let settled = false;
    const exited = observeProcessExit(child as never).then((result) => {
      settled = true;
      return result;
    });
    child.emit("close", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("exit", 0, null);
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
  });

  it("rejects process errors without exposing their contents", async () => {
    const child = new EventEmitter();
    const exited = observeProcessExit(child as never);
    child.emit("error", new Error("C:\\private\\process"));
    await expect(exited).rejects.toThrow(/^packaged application process observation failed$/u);
  });
});

describe("packaged Windows shutdown diagnostics", () => {
  const completeStages = (stages: ReturnType<typeof createSecuritySmokeStageObserver>) => {
    stages.write(
      SECURITY_SMOKE_SHUTDOWN_STAGES.map(
        (stage) => `DESKTOP_SECURITY_STAGE ${stage}\n`,
      ).join(""),
    );
  };

  it("parses fragmented fixed stages in exact order", () => {
    const stages = createSecuritySmokeStageObserver();
    stages.write("DESKTOP_SECURITY_STAGE stdin-");
    expect(stages.lastStage()).toBe("none");
    stages.write("accepted\nDESKTOP_SECURITY_STAGE residency-closed\n");
    expect(stages.lastStage()).toBe("residency-closed");
  });

  it("rejects duplicate and unknown stage frames without exposing output", async () => {
    for (const frame of [
      "DESKTOP_SECURITY_STAGE stdin-accepted\nDESKTOP_SECURITY_STAGE stdin-accepted\n",
      "DESKTOP_SECURITY_STAGE C:\\private\\athlete-home\n",
    ]) {
      const stages = createSecuritySmokeStageObserver();
      stages.write(frame);
      const error = await stages.failure;
      expect(error.message).toBe("packaged Windows shutdown stage evidence was invalid");
      expect(String(error)).not.toContain("athlete-home");
    }
  });

  it("observes shutdown write completion and rejects unavailable input", async () => {
    const input = new PassThrough();
    let source = "";
    input.on("data", (chunk) => {
      source += String(chunk);
    });
    await expect(requestPackagedShutdown(input)).resolves.toBeUndefined();
    expect(source).toBe("shutdown\n");
    expect(input.listenerCount("error")).toBe(0);
    await expect(requestPackagedShutdown(undefined)).rejects.toThrow(
      /^packaged Windows shutdown input was unavailable$/u,
    );
  });

  it("maps callback, stream, and synchronous request failures without retaining listeners", async () => {
    const callbackInput = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      end: (_chunk: string, callback: (error?: Error | null) => void) =>
        callback(new Error("C:\\private\\callback")),
    });
    await expect(requestPackagedShutdown(callbackInput as never)).rejects.toThrow(
      /^packaged Windows shutdown request failed$/u,
    );
    expect(callbackInput.listenerCount("error")).toBe(0);

    const streamInput = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      end: () => undefined,
    });
    const streamFailure = requestPackagedShutdown(streamInput as never);
    streamInput.emit("error", new Error("C:\\private\\stream"));
    await expect(streamFailure).rejects.toThrow(/^packaged Windows shutdown request failed$/u);
    expect(streamInput.listenerCount("error")).toBe(0);

    const synchronousInput = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      end: () => {
        throw new Error("C:\\private\\end");
      },
    });
    await expect(requestPackagedShutdown(synchronousInput as never)).rejects.toThrow(
      /^packaged Windows shutdown request failed$/u,
    );
    expect(synchronousInput.listenerCount("error")).toBe(0);
  });

  it("waits for terminal evidence after root exit", async () => {
    const stages = createSecuritySmokeStageObserver();
    let settled = false;
    const waiting = waitForPackagedApplicationExit(
      {
        child: { stdin: new PassThrough() },
        exited: Promise.resolve({ code: 0, signal: null }),
        stages,
      },
      100,
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    completeStages(stages);
    await expect(waiting).resolves.toEqual({ code: 0, signal: null });
  });

  it("waits for root exit after terminal evidence", async () => {
    const stages = createSecuritySmokeStageObserver();
    completeStages(stages);
    let resolveExit!: (result: { code: number; signal: null }) => void;
    const exited = new Promise<{ code: number; signal: null }>((resolve) => {
      resolveExit = resolve;
    });
    let settled = false;
    const waiting = waitForPackagedApplicationExit(
      { child: { stdin: new PassThrough() }, exited, stages },
      100,
    ).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveExit({ code: 0, signal: null });
    await expect(waiting).resolves.toEqual({ code: 0, signal: null });
  });

  it("reports only the last allowlisted stage at the absolute deadline", async () => {
    const stages = createSecuritySmokeStageObserver();
    stages.write("DESKTOP_SECURITY_STAGE stdin-accepted\n");
    const privateValue = "C:\\private\\athlete-home";
    const waiting = waitForPackagedApplicationExit(
      {
        child: { stdin: new PassThrough() },
        exited: new Promise(() => undefined),
        stages,
      },
      1,
    );
    await expect(waiting).rejects.toThrow(
      /^packaged Windows application did not stop cleanly; last stage=stdin-accepted$/u,
    );
    await waiting.catch((error) => {
      expect(String(error)).not.toContain(privateValue);
    });
  });
});

describe("packaged Windows scratch cleanup", () => {
  it("uses bounded native recursive removal options", async () => {
    const remove = vi.fn(async () => {});
    await expect(removeWindowsScratch("C:\\scratch", remove)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("C:\\scratch", {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it("rejects a persistent failure without exposing its path", async () => {
    const privatePath = "C:\\private\\athlete-home\\store\\store.db-shm";
    const remove = vi.fn(async () => {
      throw Object.assign(new Error(`busy ${privatePath}`), { code: "EBUSY" });
    });
    const cleanup = removeWindowsScratch(privatePath, remove);
    await expect(cleanup).rejects.toThrow(/^packaged Windows scratch cleanup failed$/u);
    await cleanup.catch((error) => {
      expect(String(error)).not.toContain(privatePath);
    });
  });

  it.each(["process", "scratch"] as const)(
    "preserves the body diagnostic when %s cleanup also fails",
    (cleanupStage) => {
      const bodyFailure = new Error("packaged Windows shutdown failed at an allowlisted stage");
      try {
        throwPackagedCompletionFailures(bodyFailure, [cleanupStage]);
        throw new Error("expected aggregate failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toBe(
          "packaged Windows verification and cleanup failed",
        );
        expect((error as AggregateError).errors[0]).toBe(bodyFailure);
        expect((error as AggregateError).errors[1]).toEqual(
          new Error(`packaged Windows ${cleanupStage} cleanup failed`),
        );
      }
    },
  );
});

describe("packaged self-test terminal", () => {
  const valid = {
    type: "self-test-terminal",
    ok: true,
    runtime: { node: "24.18.0", electron: "44.4.3" },
    suites: {
      parity: { cases: 2, passed: 2 },
      differential: { cases: 3, passed: 3 },
    },
  } as const;

  it("accepts the exact shipped suite object", () => {
    expect(validateSelfTestTerminal(valid)).toBe(valid);
  });

  it.each([
    [{ ...valid, suites: [] }, "packaged self-test suites were invalid"],
    [
      { ...valid, suites: { parity: valid.suites.parity } },
      "packaged self-test suites were invalid",
    ],
    [
      { ...valid, suites: { ...valid.suites, privateExtra: { cases: 1, passed: 1 } } },
      "packaged self-test suites were invalid",
    ],
    [
      {
        ...valid,
        suites: {
          ...valid.suites,
          parity: { ...valid.suites.parity, privateExtra: "C:\\private\\suite" },
        },
      },
      "packaged self-test suite counts were invalid",
    ],
    [
      { ...valid, suites: { ...valid.suites, parity: { cases: 1.5, passed: 1.5 } } },
      "packaged self-test suite counts were invalid",
    ],
    [
      { ...valid, suites: { ...valid.suites, differential: { cases: 0, passed: 0 } } },
      "packaged self-test suite counts were invalid",
    ],
    [
      { ...valid, suites: { ...valid.suites, parity: { cases: 2, passed: 1 } } },
      "packaged self-test suites did not pass",
    ],
  ])("rejects malformed suite results with a fixed error", (terminal, message) => {
    expect(() => validateSelfTestTerminal(terminal)).toThrow(new RegExp(`^${message}$`, "u"));
  });
});

describe("installed driver binding", () => {
  it("refuses execution when the immediate installer rehash differs from package evidence", async () => {
    const installerBytes = Buffer.from("changed-installer", "utf8");
    const capture = vi.fn();
    await expect(
      runWindowsInstalledPackage(
        {
          args: ["--github-hosted", "--signature-policy", "unsigned-private"],
          environment: {
            GITHUB_ACTIONS: "true",
            RUNNER_ENVIRONMENT: "github-hosted",
            USERPROFILE: "C:\\Users\\runner",
            LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
            APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
          },
          desktopRoot: "/desktop",
          platform: "win32",
          arch: "x64",
        },
        {
          createWindowsPackagePlan: vi.fn(async () => ({
            artifactPath: "/artifacts/Enduragent-0.1.3-x64.exe",
            artifactName: "Enduragent-0.1.3-x64.exe",
            applicationPath: "/retained",
            version: "0.1.3",
          })) as never,
          verifyWindowsPackage: vi.fn(async () => ({ artifact: { sha256: "different" } })) as never,
          runNativeEvidence: vi.fn(async () => ({
            ok: true,
            registrations: [],
            programResidues: [],
            processes: [],
            shortcut: {
              path: "shortcut",
              exists: false,
              targetPath: null,
              arguments: null,
              workingDirectory: null,
            },
            run: { exists: false, value: null },
            startupApproved: { exists: false, valueBase64: null },
            reparsePaths: [],
            signatures: [],
          })) as never,
          capture,
          createReadStream: vi.fn(() => Readable.from(installerBytes) as never),
          isAbsolute: () => true,
          readdir: vi.fn(async () => []),
          lstat: vi.fn(async () => directoryStat() as never),
        },
      ),
    ).rejects.toThrow("installer changed after package verification");
    expect(capture).not.toHaveBeenCalled();
  });

  it("rehashes verified evidence and attempts registered uninstall after install failure", async () => {
    const installerBytes = Buffer.from("synthetic-installer", "utf8");
    const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");
    const installRoot = "C:\\Users\\runner\\AppData\\Local\\Programs\\SyntheticRoot";
    const partialRegistration = registration({
      installLocation: installRoot,
      uninstallString: `"${installRoot}\\Uninstall Enduragent.exe" /currentuser`,
      quietUninstallString: `"${installRoot}\\Uninstall Enduragent.exe" /currentuser /S`,
    });
    const emptyEvidence = {
      ok: true,
      registrations: [],
      programResidues: [],
      processes: [],
      shortcut: { path: "shortcut", exists: false, targetPath: null, arguments: null, workingDirectory: null },
      run: { exists: false, value: null },
      startupApproved: { exists: false, valueBase64: null },
      reparsePaths: [],
      signatures: [],
    };
    const runNativeEvidence = vi
      .fn()
      .mockResolvedValueOnce(emptyEvidence)
      .mockResolvedValueOnce({
        ...emptyEvidence,
        registrations: [partialRegistration],
        programResidues: [installRoot],
      })
      .mockResolvedValueOnce({ ok: true, terminated: [] })
      .mockResolvedValueOnce(emptyEvidence);
    let uninstalled = false;
    const capture = vi.fn(async (file: string) => {
      if (file === "/artifacts/Enduragent-0.1.3-x64.exe") {
        return { code: 1, signal: null, stdout: "", stderr: "install failed" };
      }
      uninstalled = true;
      return { code: 0, signal: null, stdout: "", stderr: "" };
    });
    const createReadStreamMock = vi.fn(() => Readable.from(installerBytes) as never);
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const verifyWindowsPackage = vi.fn(async () => ({
      artifact: {
        name: "Enduragent-0.1.3-x64.exe",
        size: installerBytes.length,
        sha256: installerSha256,
        peMachine: 0x8664 as const,
        nsisEnvelope: true as const,
      },
      application: { fileCount: 0, directoryCount: 0, manifestSha256: "x", peMachine: 0x8664 as const },
    }));
    await expect(
      runWindowsInstalledPackage(
        {
          args: ["--github-hosted", "--signature-policy", "unsigned-private"],
          environment: {
            GITHUB_ACTIONS: "true",
            RUNNER_ENVIRONMENT: "github-hosted",
            USERPROFILE: "C:\\Users\\runner",
            LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
            APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
          },
          desktopRoot: "/desktop",
          platform: "win32",
          arch: "x64",
        },
        {
          createWindowsPackagePlan: vi.fn(async () => ({
            artifactPath: "/artifacts/Enduragent-0.1.3-x64.exe",
            artifactName: "Enduragent-0.1.3-x64.exe",
            applicationPath: "/retained",
            version: "0.1.3",
          })) as never,
          verifyWindowsPackage,
          runNativeEvidence: runNativeEvidence as never,
          capture,
          createReadStream: createReadStreamMock,
          isAbsolute: () => true,
          readdir: vi.fn(async () => []),
          lstat: vi.fn(async (path: string) => {
            if (
              path === "/retained" ||
              path === "C:\\Users\\runner\\AppData\\Local\\Programs" ||
              (path === installRoot && !uninstalled)
            ) {
              return directoryStat() as never;
            }
            throw missing;
          }),
          realpath: vi.fn(async (path: string) => path),
        },
      ),
    ).rejects.toThrow("silent NSIS install failed");
    expect(verifyWindowsPackage).toHaveBeenCalledOnce();
    expect(createReadStreamMock).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenNthCalledWith(
      2,
      `${installRoot}\\Uninstall Enduragent.exe`,
      ["/currentuser", "/S"],
      120_000,
    );
  });
});
