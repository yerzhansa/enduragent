import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWindowsParityScenarios } from "../scripts/windows-parity-scenarios.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const requiredAutomation = [
  "daemon.supervision.crash-restart",
  "storage.windows.durable-writes",
  "settings.providers.chatgpt-refusals",
  "training.import.progress-results",
  "training.export.cancellation-failures",
  "telegram.lifecycle.conflict-rejection",
  "telegram.power.sleep-wake",
  "telegram.power.delivery-gap",
  "updater.unsigned.package-truth",
  "shell.single-instance.activation",
  "shell.tray.window-residency",
  "daemon.shutdown.quit-drain",
  "telegram.storage.encrypted-profile",
] as const;

const requiredVmProofs = [
  "updater.windows.unsigned-ui",
  "shell.windows.second-launch",
  "uninstall.durable.desktop-credentials",
] as const;

describe("Windows parity automation contract", () => {
  it("binds the required fault lanes to deterministic scenarios", async () => {
    const collection = await loadWindowsParityScenarios();
    const scenarios = new Map(collection.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const id of requiredAutomation)
      expect(scenarios.get(id)?.automation, id).toBe("deterministic");
  });

  it("keeps Windows-host-only proofs explicit", async () => {
    const collection = await loadWindowsParityScenarios();
    const scenarios = new Map(collection.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const id of requiredVmProofs) expect(scenarios.get(id)?.automation, id).toBe("vm-only");
  });

  it("builds once and invokes one hosted installed driver without 7-Zip", async () => {
    const workflow = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const driver = await readFile(
      join(repositoryRoot, "apps/desktop/scripts/windows-installed-package.mjs"),
      "utf8",
    );
    const nativeEvidence = await readFile(
      join(repositoryRoot, "apps/desktop/scripts/windows-installed-evidence.ps1"),
      "utf8",
    );
    const packagedSelfTest = await readFile(
      join(repositoryRoot, "apps/desktop/scripts/verify-windows-packaged-self-test.mjs"),
      "utf8",
    );
    const desktopMain = await readFile(
      join(repositoryRoot, "apps/desktop/src/main/index.ts"),
      "utf8",
    );
    const packageCommands =
      workflow.match(/pnpm --filter @enduragent\/desktop package:win$/gmu) ?? [];
    const storePackageCommands =
      workflow.match(/pnpm --filter @enduragent\/desktop package:win-store$/gmu) ?? [];
    const installedCommands =
      workflow.match(
        /pnpm --filter @enduragent\/desktop test:windows-installed-self-test --github-hosted --signature-policy unsigned-private/g,
      ) ?? [];
    const windowsJob = workflow
      .split("  windows-desktop-package:")[1]
      ?.split(/\r?\n  [a-z0-9_-]+:/u)[0];
    const linuxCheckJob = workflow.split("  check:")[1]?.split(/\r?\n  [a-z0-9_-]+:/u)[0];
    expect(packageCommands).toHaveLength(1);
    expect(installedCommands).toHaveLength(1);
    expect(storePackageCommands).toHaveLength(1);
    expect(windowsJob).toContain(storePackageCommands[0]);
    expect(workflow.indexOf(installedCommands[0]!)).toBeLessThan(
      workflow.indexOf(storePackageCommands[0]!),
    );
    expect(linuxCheckJob).toContain("pnpm exec vitest run --shard=1/2");
    expect(linuxCheckJob).toContain("pnpm exec vitest run --shard=2/2");
    expect(windowsJob).not.toContain("Run Windows package contract tests");
    expect(windowsJob).not.toContain("pnpm exec vitest run apps/desktop/tests ");
    expect(windowsJob).not.toContain("@enduragent/desktop-renderer test");
    expect(workflow.indexOf(packageCommands[0]!)).toBeLessThan(
      workflow.indexOf(installedCommands[0]!),
    );
    expect(workflow).not.toMatch(
      /7-zip|7z\.exe|verify:win-package|test:windows-packaged-self-test/iu,
    );
    expect(workflow).toContain("timeout-minutes: 45");
    expect(manifest.scripts["test:windows-installed-self-test"]).toBe(
      "node scripts/verify-windows-installed-self-test.mjs",
    );
    expect(
      driver.match(/dependencies\.verifyWindowsPackage \?\? verifyWindowsPackage/gu),
    ).toHaveLength(1);
    expect(driver).toContain('await run(installer, ["/S"]');
    expect(driver).toContain("installed.quietArgs");
    expect(driver).toContain("new AggregateError");
    expect(driver).toContain('child.once("close"');
    expect(driver).toContain('"pwsh.exe"');
    expect(driver).not.toContain('"powershell.exe"');
    const commonRequest = driver.slice(
      driver.indexOf("function commonNativeRequest"),
      driver.indexOf("function validateHostedEnvironment"),
    );
    expect(commonRequest).toContain("treeRoots: []");
    expect(commonRequest).toContain("signaturePaths: []");
    expect(nativeEvidence).toContain("ConvertFrom-Json");
    expect(nativeEvidence).toContain("Get-AuthenticodeSignature");
    expect(nativeEvidence).toContain('$installRoot = "HKCU:\\Software\\$($Request.guid)"');
    expect(nativeEvidence).toContain(
      "[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames",
    );
    expect(nativeEvidence).toContain('code = "NATIVE_EVIDENCE_FAILED"');
    expect(nativeEvidence).not.toContain("$_.Exception.Message");
    expect(nativeEvidence).toContain("[Collections.Generic.Stack[string]]::new()");
    expect(nativeEvidence).not.toMatch(/Get-ChildItem[^\r\n]*-Recurse/u);
    expect(nativeEvidence).toMatch(
      /if \(\(\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0\) \{\s+\$paths \+= \$item\.FullName\s+continue\s+\}\s+if \(-not \$item\.PSIsContainer\) \{ continue \}/u,
    );
    expect(nativeEvidence).toMatch(
      /if \(\(\$child\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0\) \{\s+\$paths \+= \$child\.FullName\s+\} elseif \(\$child\.PSIsContainer\) \{\s+\$pending\.Push\(\$child\.FullName\)\s+\}/u,
    );
    expect(nativeEvidence).toContain("installLocation = $installLocation");
    expect(nativeEvidence).toMatch(
      /catch \[System\.Management\.Automation\.ItemNotFoundException\] \{\s+continue\s+\}/u,
    );
    expect(nativeEvidence).toContain("WScript.Shell");
    expect(nativeEvidence).toContain("Get-CimInstance Win32_Process -Filter");
    expect(nativeEvidence).not.toContain("[IO.Path]::GetFileName");
    expect(nativeEvidence).not.toContain("Invoke-Expression");
    const secondaryExit = desktopMain.indexOf("async function exitSecondaryDesktop");
    const evidenceGate = desktopMain.indexOf(
      'process.argv.includes("--desktop-security-smoke") && desktopAcceptanceHidden',
      secondaryExit,
    );
    const normalExit = desktopMain.indexOf("app.exit(0);", evidenceGate);
    const markerWrite = desktopMain.indexOf(
      "await writeSecuritySmokeSecondInstance(process.stdout);",
      normalExit,
    );
    const evidenceExit = desktopMain.indexOf("app.exit(0);", markerWrite);
    const evidenceFailureExit = desktopMain.indexOf("app.exit(1);", evidenceExit);
    const singleInstanceLock = desktopMain.indexOf(
      "app.requestSingleInstanceLock()",
      secondaryExit,
    );
    const loserBranch = desktopMain.indexOf("if (!primaryInstance)", singleInstanceLock);
    const loserCall = desktopMain.indexOf("void exitSecondaryDesktop();", loserBranch);
    expect(secondaryExit).toBeGreaterThanOrEqual(0);
    expect(evidenceGate).toBeGreaterThan(secondaryExit);
    expect(normalExit).toBeGreaterThan(evidenceGate);
    expect(markerWrite).toBeGreaterThan(normalExit);
    expect(evidenceExit).toBeGreaterThan(markerWrite);
    expect(evidenceFailureExit).toBeGreaterThan(evidenceExit);
    expect(singleInstanceLock).toBeGreaterThan(evidenceFailureExit);
    expect(loserBranch).toBeGreaterThan(singleInstanceLock);
    expect(loserCall).toBeGreaterThan(loserBranch);
    const screenshotCapture = desktopMain.indexOf("initialWindow.webContents.capturePage()");
    const visibleSecurityWindow = desktopMain.indexOf("initialWindow.show();", screenshotCapture);
    const visibleEvidence = desktopMain.indexOf(
      "visibleForSecondLaunch: initialWindow.isVisible()",
      visibleSecurityWindow,
    );
    const readyFrame = desktopMain.indexOf("DESKTOP_SECURITY_READY", visibleEvidence);
    expect(screenshotCapture).toBeGreaterThanOrEqual(0);
    expect(visibleSecurityWindow).toBeGreaterThan(screenshotCapture);
    expect(visibleEvidence).toBeGreaterThan(visibleSecurityWindow);
    expect(readyFrame).toBeGreaterThan(visibleEvidence);
    const primaryAcknowledgment = desktopMain.indexOf(
      "writeSecuritySmokePrimarySecondInstance(process.stdout)",
    );
    const primaryAcknowledgmentFailure = desktopMain.indexOf(
      "writeSecuritySmokePrimarySecondInstanceFailure(process.stderr)",
      primaryAcknowledgment,
    );
    expect(primaryAcknowledgment).toBeGreaterThanOrEqual(0);
    expect(primaryAcknowledgmentFailure).toBeGreaterThan(primaryAcknowledgment);
    expect(desktopMain.slice(primaryAcknowledgment, primaryAcknowledgmentFailure)).not.toContain(
      "app.exit(",
    );
    const packagedLaunchArguments = packagedSelfTest.slice(
      packagedSelfTest.indexOf("const launchArguments"),
      packagedSelfTest.indexOf("running = launchApplication"),
    );
    expect(packagedLaunchArguments).toContain("--desktop-security-output=");
    expect(packagedLaunchArguments).toContain("--desktop-security-control-pipe=");
    expect(packagedLaunchArguments).not.toContain("--user-data-dir=");
    expect(packagedSelfTest).toContain('const windowsUserData = join(localAppData, "Enduragent");');
    expect(packagedSelfTest).toContain("mkdir(windowsUserData, { recursive: true })");
    expect(packagedSelfTest).toContain("requireRunningPrimaryBeforeSecondLaunch(running.child);");
    const controlServer = packagedSelfTest.indexOf(
      "controlPipe = await createWindowsSecurityControlPipe(controlPipeName)",
    );
    const primaryLaunch = packagedSelfTest.indexOf(
      "running = launchApplication(executable, launchArguments, launchEnvironment)",
      controlServer,
    );
    expect(controlServer).toBeGreaterThanOrEqual(0);
    expect(primaryLaunch).toBeGreaterThan(controlServer);
    expect(packagedSelfTest).toContain("controlPipe.connection");
    expect(packagedSelfTest).toContain(
      "validatePackagedSecondLaunch(second, [security.athleteHome, token, controlPipeName])",
    );
    expect(packagedSelfTest).toContain(
      "requestPackagedShutdown(running.shutdownInput ?? running.child.stdin)",
    );
    expect(packagedSelfTest).toContain("await controlPipe.close()");
    const controlConnect = desktopMain.indexOf("connectSecuritySmokeControlPipe(");
    const controlWait = desktopMain.indexOf(
      "waitForSecuritySmokeShutdown(securitySmokeControlPipe)",
      controlConnect,
    );
    const controlReady = desktopMain.indexOf("DESKTOP_SECURITY_READY", controlWait);
    const runDesktopStart = desktopMain.indexOf("async function runDesktop");
    expect(controlConnect).toBeGreaterThan(runDesktopStart);
    expect(controlConnect).toBeLessThan(secondaryExit);
    expect(controlWait).toBeGreaterThan(controlConnect);
    expect(controlReady).toBeGreaterThan(controlWait);
    expect(desktopMain.slice(secondaryExit, singleInstanceLock)).not.toContain(
      "desktop-security-control-pipe",
    );
    expect(desktopMain).toContain("controlShutdown ?? waitForSecuritySmokeShutdown(process.stdin)");
    expect(packagedSelfTest).toContain("waitForPackagedSecondLaunchEvidence({");
    expect(packagedSelfTest).toContain(
      "primaryAcknowledgment: running.primarySecondInstance.acknowledgment",
    );
    expect(packagedSelfTest).toContain("primaryExited: running.exited");
    expect(packagedSelfTest).toContain(
      "primaryAcknowledgmentWriteFailure: running.primaryAcknowledgmentFailure.failure",
    );
    expect(packagedSelfTest).toContain(
      "primaryAcknowledged: running.primarySecondInstance.isAcknowledged",
    );
    expect(packagedSelfTest).toContain("deadline: secondDeadline");
    expect(packagedSelfTest).toContain("clearTimeout(timer)");
    const shutdownStart = desktopMain.indexOf("const shutdown = (): Promise<void> =>");
    const residencyClosed = desktopMain.indexOf(
      'reportSecuritySmokeShutdownStage("residency-closed")',
      shutdownStart,
    );
    const ipcClosed = desktopMain.indexOf(
      'reportSecuritySmokeShutdownStage("ipc-closed")',
      residencyClosed,
    );
    const telegramPowerClosed = desktopMain.indexOf(
      'reportSecuritySmokeShutdownStage("telegram-power-closed")',
      ipcClosed,
    );
    const telegramCoordinatorClosed = desktopMain.indexOf(
      'reportSecuritySmokeShutdownStage("telegram-coordinator-closed")',
      telegramPowerClosed,
    );
    const daemonClosed = desktopMain.indexOf(
      'reportSecuritySmokeShutdownStage("daemon-closed")',
      telegramCoordinatorClosed,
    );
    const shutdownAccepted = desktopMain.indexOf(
      'reportSecuritySmokeShutdownStage("stdin-accepted")',
      daemonClosed,
    );
    const shutdownAwaited = desktopMain.indexOf("await shutdown();", shutdownAccepted);
    const exitRequested = desktopMain.indexOf(
      'reportSecuritySmokeShutdownStage("exit-requested")',
      shutdownAwaited,
    );
    expect(shutdownStart).toBeGreaterThanOrEqual(0);
    expect(residencyClosed).toBeGreaterThan(shutdownStart);
    expect(ipcClosed).toBeGreaterThan(residencyClosed);
    expect(telegramPowerClosed).toBeGreaterThan(ipcClosed);
    expect(telegramCoordinatorClosed).toBeGreaterThan(telegramPowerClosed);
    expect(daemonClosed).toBeGreaterThan(telegramCoordinatorClosed);
    expect(shutdownAccepted).toBeGreaterThan(daemonClosed);
    expect(shutdownAwaited).toBeGreaterThan(shutdownAccepted);
    expect(exitRequested).toBeGreaterThan(shutdownAwaited);
    const packagedRun = packagedSelfTest.indexOf(
      "export async function runWindowsPackagedSelfTest",
    );
    const packagedCatch = packagedSelfTest.indexOf("  } catch (error) {", packagedRun);
    const exitSettlement = packagedSelfTest.indexOf(
      "running.exited.then(() => true)",
      packagedCatch,
    );
    const forcedExit = packagedSelfTest.indexOf('running.child.kill("SIGKILL")', exitSettlement);
    const forcedSettlement = packagedSelfTest.indexOf("await running.exited;", forcedExit);
    const scratchCleanup = packagedSelfTest.indexOf(
      "await removeWindowsScratch(scratch);",
      forcedSettlement,
    );
    expect(packagedRun).toBeGreaterThanOrEqual(0);
    expect(packagedCatch).toBeGreaterThan(packagedRun);
    expect(exitSettlement).toBeGreaterThan(packagedCatch);
    expect(forcedExit).toBeGreaterThan(exitSettlement);
    expect(forcedSettlement).toBeGreaterThan(forcedExit);
    expect(scratchCleanup).toBeGreaterThan(forcedSettlement);
  });
});
