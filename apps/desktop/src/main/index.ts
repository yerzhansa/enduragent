import "./keychain-binding-probe-deprecation.js";
import { bindDevelopmentUserData } from "./development-user-data.js";
import { bindWindowsUserData } from "./windows-user-data.js";
import {
  createAcceptanceKeychainTransport,
  resolveAcceptanceCredentialBackend,
} from "./acceptance-credential-backend.js";
import { realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCoachClient } from "@enduragent/coach-client";
import { checkIntervalsStoreOwnerAtPath } from "@enduragent/coach/account-identity";
import {
  prepareDesktopAthleteHome,
  startDesktopDaemonInitialRefresh,
} from "@enduragent/coach/enduragent";
import { AthleteHomeIdentitySchema } from "@enduragent/coach-contract";
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  powerMonitor,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from "electron";
import {
  CHATGPT_PROFILE_NAME,
  createChatGptAuth,
  deleteChatGptProfile,
  hasChatGptProfile,
} from "./chatgpt-auth.js";
import { createClaudeCliStatus, readClaudeCliSettings } from "./claude-cli-status.js";
import {
  installDesktopConnectionIpc,
  type DesktopConnectionIpcController,
} from "./connection-ipc.js";
import { installDesktopCrashTelemetry, startDesktopCrashReporter } from "./crash-telemetry.js";
import {
  createDesktopInitialRefreshCoordinator,
  shouldReleaseInitialRefreshAfterLoadFailure,
  shouldReleaseInitialRefreshAfterLoadRejection,
  shouldReleaseInitialRefreshForWindowEvent,
} from "./initial-refresh.js";
import { bindDesktopAppUserModelId, createDesktopActivationRelay } from "./desktop-lifecycle.js";
import { installDesktopAppearanceIpc } from "./appearance-ipc.js";
import { installDesktopExternalLinkIpc } from "./external-link-ipc.js";
import {
  createConnectionChatAttachmentClient,
  installDesktopChatAttachmentIpc,
  type DesktopChatAttachmentClient,
} from "./chat-attachment-ipc.js";
import { DESKTOP_LIFECYCLE_CHANNEL, DESKTOP_RENDERER_URL, DESKTOP_SCHEME } from "./constants.js";
import { isDesktopRendererUrl } from "./renderer-navigation.js";
import {
  createDesktopRendererNavigationTracker,
  type DesktopRendererNavigation,
} from "./renderer-navigation-load.js";
import {
  createDesktopIntervalsCredentialVerifier,
  installDesktopIntervalsIpc,
} from "./intervals-ipc.js";
import {
  applyExplicitCredentialToRuntime,
  createActiveIntervalsCredentialPreflight,
  createConnectionRuntimeAuthority,
  createCredentialRuntimeApplication,
  intervalsAthleteIdForOwnership,
  readSelectedLlmProvider,
  type CredentialRuntimeApplication,
  type RuntimeConfigurationAuthority,
} from "./credential-runtime.js";
import {
  CREDENTIAL_DIRECTORY_NAME,
  createCredentialVault,
  DESKTOP_CREDENTIAL_SLOTS,
  markUnselectedModelCredentialsInactive,
  replaceCredentialRuntimeStates,
  type CredentialRuntimeState,
  type CredentialSlotStatus,
  type DesktopCredentialSlot,
} from "./credential-vault.js";
import {
  createCredentialEnvelopeMutationLock,
  createCredentialMutationLock,
  type CredentialEnvelopeLockProof,
} from "./credential-envelope-lock.js";
import {
  desktopCredentialRecoveryFailureState,
  prepareDesktopCredentialEncryption,
} from "./desktop-credential-encryption.js";
import { createDesktopCredentialReset } from "./credential-reset-orchestration.js";
import { probePackagedKeychainBackendSelection } from "./keychain-backend-selection-probe.js";
import {
  DesktopDaemonLifecycle,
  type DesktopDaemonConnection,
  type DesktopDaemonLifecycleState,
} from "./daemon-lifecycle.js";
import { requireDesktopDaemonHome } from "./daemon-home-binding.js";
import { resolveDesktopAthleteHome, seedFirstRunConfig } from "./first-run-config.js";
import {
  connectSecuritySmokeControlPipe,
  parseSecuritySmokeControlPipeArgument,
  waitForSecuritySmokeShutdown,
  writeSecuritySmokePrimarySecondInstance,
  writeSecuritySmokePrimarySecondInstanceFailure,
  writeSecuritySmokeSecondInstance,
  writeSecuritySmokeShutdownStage,
  type SecuritySmokeShutdownStage,
} from "./security-smoke-shutdown.js";
import {
  lifecycleErrorCopy,
  startupRefusalCopy,
  unexpectedStartupCopy,
} from "./lifecycle-messages.js";
import {
  runtimeConfigurationForExistingSelection,
  type OnboardingLlmSelection,
} from "./llm-selection.js";
import {
  registerOnboardingIpc,
  runtimeConfigurationForCredential,
  type DesktopCredentialRecoveryStatus,
  type DesktopCredentialResetResult,
} from "./onboarding-ipc.js";
import { createDesktopResidency, type DesktopResidency } from "./residency.js";
import { adoptDeviceTimezoneAtStart } from "./session-timezone.js";
import {
  BACKGROUND_AT_LOGIN_PREFERENCE_DIRECTORY_NAME,
  createBackgroundAtLoginPreferenceStore,
  shouldStartInBackgroundAtLogin,
} from "./login-item.js";
import {
  createDesktopRendererConsoleCapture,
  desktopWindowOptions,
  hardenDesktopWindow,
  installDesktopProtocol,
  isTrustedConnectionRequest,
  registerDesktopScheme,
  rendererOutputRoot,
  resolveDesktopRendererSource,
} from "./security.js";
import { DesktopDaemonSupervisor, isUtilityTerminalFrame } from "./supervisor.js";
import { logDesktopStartupFailure } from "./startup-failure.js";
import { traceDesktopStartupStage } from "./startup-trace.js";
import {
  createDesktopQuitCoordinator,
  installDesktopTerminationSignalHandler,
} from "./quit-coordinator.js";
import { createDesktopUpdateController } from "./update-controller.js";
import { isDesktopUpdateReleaseEligible, isOfficialDesktopRelease } from "./update-eligibility.js";
import { installDesktopUpdateIpc } from "./update-ipc.js";
import { createDesktopUpdateVersionFloor } from "./update-version-floor.js";
import {
  createDesktopUsagePingController,
  desktopUsagePingChannelForPlatform,
} from "./desktop-usage-ping.js";
import { createDesktopUsagePingStateStore } from "./desktop-usage-ping-state.js";
import {
  createTelegramControlCoordinator,
  type TelegramDaemonBinding,
} from "./telegram-control.js";
import {
  createTelegramCredentialVault,
  TELEGRAM_CREDENTIAL_DIRECTORY_NAME,
} from "./telegram-credential-vault.js";
import { createTelegramDaemonBinding } from "./telegram-daemon-binding.js";
import { installDesktopTelegramIpc } from "./telegram-ipc.js";
import { createTelegramSecureStorageDiagnostics } from "./telegram-secure-storage-diagnostics.js";
import {
  createDesktopTelegramPowerLifecycle,
  type DesktopTelegramPowerLifecycle,
} from "./telegram-power.js";
import { startDesktopTelegram } from "./telegram-startup.js";
import {
  createConnectionTranscriptReader,
  installDesktopTranscriptIpc,
  type DesktopTranscriptReader,
} from "./transcript-ipc.js";
import {
  createConnectionPlanningClient,
  installDesktopPlanningIpc,
  type DesktopPlanningClient,
} from "./planning-ipc.js";
import {
  createConnectionTrainingExporter,
  installDesktopTrainingExportIpc,
  type DesktopTrainingExporter,
} from "./training-export-ipc.js";
import {
  createConnectionPlanningReader,
  installDesktopPlanningReadIpc,
  type DesktopPlanningReader,
} from "./planning-read-ipc.js";

traceDesktopStartupStage("main-start");
bindDesktopAppUserModelId(app);
bindDevelopmentUserData(app, { isPackaged: app.isPackaged });
bindWindowsUserData(app);
startDesktopCrashReporter({ crashReporter });
installDesktopCrashTelemetry({ app });
registerDesktopScheme();

function disableChromiumMediaSessionIntegration(): void {
  const alreadyDisabled = app.commandLine.getSwitchValue("disable-features");
  app.commandLine.appendSwitch(
    "disable-features",
    [alreadyDisabled, "MediaSessionService", "HardwareMediaKeyHandling"]
      .filter((feature) => feature.length > 0)
      .join(","),
  );
}

let desktopIsClosing = false;
let desktopStartedInBackground = false;
const desktopAcceptanceHidden = process.env.ENDURAGENT_ACCEPTANCE_HIDDEN === "1";

const INITIAL_REFRESH_RELEASE_RETRY_DELAY_MS = 1_000;
const INITIAL_REFRESH_SETTLE_WATCHDOG_MS = 30_000;

const mainDirectory = dirname(fileURLToPath(import.meta.url));
const utilityEntry = resolve(mainDirectory, "daemon-utility.js");
const preloadEntry = resolve(mainDirectory, "../preload/index.cjs");

async function runRuntimeSmoke(): Promise<void> {
  await app.whenReady();
  if (desktopAcceptanceHidden) app.dock?.hide();
  const child = utilityProcess.fork(utilityEntry, ["--desktop-runtime-smoke"], {
    serviceName: "enduragent desktop runtime",
    stdio: "pipe",
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.resume();
  child.on("message", (message) => {
    if (isUtilityTerminalFrame(message)) child.postMessage({ type: "terminal-ack" });
  });
  const exitCode = await new Promise<number>((resolveExit) => {
    child.once("exit", (code) => resolveExit(Number.isInteger(code) ? code : 1));
  });
  app.exit(exitCode);
}

async function runKeychainBindingProbe(): Promise<void> {
  await app.whenReady();
  if (!app.isPackaged) {
    process.stderr.write("ENDURAGENT_KEYCHAIN_BINDING_PROBE refused\n");
    app.exit(1);
    return;
  }
  const userData = app.getPath("userData");
  const result = await probePackagedKeychainBackendSelection({
    credentialRoot: join(userData, CREDENTIAL_DIRECTORY_NAME),
    telegramRoot: join(userData, TELEGRAM_CREDENTIAL_DIRECTORY_NAME),
    location: {
      platform: process.platform,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      applicationPath: app.getAppPath(),
    },
    safeStorage,
  });
  process.stdout.write(`ENDURAGENT_KEYCHAIN_BINDING_PROBE ${JSON.stringify(result)}\n`);
  app.exit(0);
}

async function runDesktop(): Promise<void> {
  const securitySmokeMode = process.argv.includes("--desktop-security-smoke");
  const rendererConsoleCapture = createDesktopRendererConsoleCapture(securitySmokeMode);
  let residency: DesktopResidency | undefined;
  const activation = createDesktopActivationRelay();
  app.on("second-instance", () => {
    if (process.platform === "win32") {
      if (securitySmokeMode && desktopAcceptanceHidden) {
        void writeSecuritySmokePrimarySecondInstance(process.stdout).catch(() => {
          void writeSecuritySmokePrimarySecondInstanceFailure(process.stderr).catch(() => {});
        });
      }
      activation.request();
    } else void residency?.showMainWindow();
  });
  app.on("activate", () => {
    if (process.platform === "win32") activation.request();
    else void residency?.showMainWindow();
  });
  app.on("window-all-closed", () => {});
  traceDesktopStartupStage("app-ready");
  await app.whenReady();
  if (desktopAcceptanceHidden) app.dock?.hide();
  const desktopPreferencesRoot = join(
    app.getPath("userData"),
    BACKGROUND_AT_LOGIN_PREFERENCE_DIRECTORY_NAME,
  );
  const updateVersionFloor = createDesktopUpdateVersionFloor({ root: desktopPreferencesRoot });
  const backgroundAtLoginPreference = createBackgroundAtLoginPreferenceStore({
    root: desktopPreferencesRoot,
  });
  traceDesktopStartupStage("background-at-login");
  desktopStartedInBackground =
    !securitySmokeMode && (await shouldStartInBackgroundAtLogin(app, backgroundAtLoginPreference));
  const controller = new AbortController();
  const scheduleInitialRefreshOperation = (delayMs: number, operation: () => void): void => {
    if (controller.signal.aborted) return;
    const timer = setTimeout(() => {
      controller.signal.removeEventListener("abort", cancel);
      operation();
    }, delayMs);
    const cancel = (): void => clearTimeout(timer);
    controller.signal.addEventListener("abort", cancel, { once: true });
  };
  const environment = { ...process.env };
  const rendererSource = resolveDesktopRendererSource(
    app.isPackaged,
    environment.ELECTRON_RENDERER_URL,
  );
  try {
    traceDesktopStartupStage("prepare-athlete-home");
    const preparedHome = await prepareDesktopAthleteHome(environment);
    environment.ENDURAGENT_HOME = preparedHome.root;
    traceDesktopStartupStage("seed-first-run-config");
    await seedFirstRunConfig({ env: environment });
    traceDesktopStartupStage("adopt-device-timezone");
    await adoptDeviceTimezoneAtStart({
      configPath: join(preparedHome.root, "config", "config.yaml"),
      stateRoot: desktopPreferencesRoot,
      env: environment,
    });
  } catch {
    process.stderr.write("desktop-first-run-config-failure seed\n");
  }
  const supervisor = new DesktopDaemonSupervisor(
    {
      env: environment,
      executablePath: process.execPath,
      appVersion: app.getVersion(),
      platform: process.platform,
      signal: controller.signal,
    },
    utilityEntry,
  );
  let quitRequested = false;
  let protocolInstalled = false;
  let connectionIpc: DesktopConnectionIpcController | undefined;
  let disposeTranscriptIpc: (() => void) | undefined;
  let disposePlanningReadIpc: (() => void) | undefined;
  let disposeChatAttachmentIpc: (() => void) | undefined;
  let disposePlanningIpc: (() => void) | undefined;
  let disposeTrainingExportIpc: (() => void) | undefined;
  let disposeExternalLinkIpc: (() => void) | undefined;
  let disposeAppearanceIpc: (() => void) | undefined;
  let disposeUpdateIpc: (() => void) | undefined;
  let disposeIntervalsIpc: (() => Promise<void>) | undefined;
  let disposeTelegramIpc: (() => Promise<void>) | undefined;
  let disposeOnboarding: (() => void) | undefined;
  let telegramPower: DesktopTelegramPowerLifecycle | undefined;
  let closeTelegramCoordinator: (() => Promise<void>) | undefined;
  let daemonLifecycle: DesktopDaemonLifecycle | undefined;
  const initialRefreshCoordinator = createDesktopInitialRefreshCoordinator({
    currentConnection: () => daemonLifecycle!.connection(),
    startInitialRefresh: startDesktopDaemonInitialRefresh,
    reportFailure: () => {
      process.stderr.write("desktop-initial-refresh-release-failure\n");
    },
    scheduleRetry: (operation) =>
      scheduleInitialRefreshOperation(INITIAL_REFRESH_RELEASE_RETRY_DELAY_MS, operation),
    scheduleWatchdog: (operation) =>
      scheduleInitialRefreshOperation(INITIAL_REFRESH_SETTLE_WATCHDOG_MS, operation),
  });
  let shutdownPromise: Promise<void> | undefined;
  let securitySmokeControlPipe: import("node:net").Socket | undefined;
  let securitySmokeShutdownAccepted = false;
  const reportSecuritySmokeShutdownStage = async (
    stage: SecuritySmokeShutdownStage,
  ): Promise<void> => {
    if (!securitySmokeShutdownAccepted) return;
    await writeSecuritySmokeShutdownStage(process.stdout, stage);
  };
  const updateController = createDesktopUpdateController({
    releaseEligible: isDesktopUpdateReleaseEligible({
      isPackaged: app.isPackaged,
      platform: process.platform,
      securitySmokeMode,
      appPath: app.getAppPath(),
      currentVersion: app.getVersion(),
    }),
    currentVersion: app.getVersion(),
    versionFloor: updateVersionFloor,
    loadUpdater: async () => {
      const { autoUpdater } = await import("electron-updater");
      return autoUpdater;
    },
    requestQuit: () => app.quit(),
  });
  const desktopUsagePingChannel = desktopUsagePingChannelForPlatform(process.platform);
  const desktopUsagePingController =
    desktopUsagePingChannel === undefined
      ? undefined
      : createDesktopUsagePingController({
          releaseEligible:
            !desktopAcceptanceHidden &&
            environment.ENDURAGENT_NO_USAGE_PING !== "1" &&
            isOfficialDesktopRelease({
              isPackaged: app.isPackaged,
              platform: process.platform,
              securitySmokeMode,
              appPath: app.getAppPath(),
              currentVersion: app.getVersion(),
            }),
          version: app.getVersion(),
          channel: desktopUsagePingChannel,
          state: createDesktopUsagePingStateStore({ root: desktopPreferencesRoot }),
          request: (url, init) => net.fetch(url, init),
        });
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      const closingResidency = residency;
      const residencyClose = closingResidency?.close();
      if (closingResidency !== undefined) activation.unbind(closingResidency);
      residency = undefined;
      const intervalsIpcClose = disposeIntervalsIpc?.();
      disposeIntervalsIpc = undefined;
      const telegramIpcClose = disposeTelegramIpc?.();
      disposeTelegramIpc = undefined;
      await residencyClose;
      await reportSecuritySmokeShutdownStage("residency-closed");
      await Promise.all([intervalsIpcClose, telegramIpcClose]);
      await reportSecuritySmokeShutdownStage("ipc-closed");
      controller.abort();
      connectionIpc?.dispose();
      connectionIpc = undefined;
      disposeTranscriptIpc?.();
      disposeTranscriptIpc = undefined;
      disposePlanningReadIpc?.();
      disposePlanningReadIpc = undefined;
      disposeChatAttachmentIpc?.();
      disposeChatAttachmentIpc = undefined;
      disposePlanningIpc?.();
      disposePlanningIpc = undefined;
      disposeTrainingExportIpc?.();
      disposeTrainingExportIpc = undefined;
      disposeExternalLinkIpc?.();
      disposeExternalLinkIpc = undefined;
      disposeAppearanceIpc?.();
      disposeAppearanceIpc = undefined;
      disposeUpdateIpc?.();
      disposeUpdateIpc = undefined;
      await telegramPower?.close();
      telegramPower = undefined;
      await reportSecuritySmokeShutdownStage("telegram-power-closed");
      await closeTelegramCoordinator?.();
      closeTelegramCoordinator = undefined;
      await reportSecuritySmokeShutdownStage("telegram-coordinator-closed");
      desktopUsagePingController?.close();
      updateController.close();
      disposeOnboarding?.();
      disposeOnboarding = undefined;
      if (protocolInstalled) {
        session.defaultSession.protocol.unhandle(DESKTOP_SCHEME);
        protocolInstalled = false;
      }
      await (daemonLifecycle?.close() ?? supervisor.close());
      await reportSecuritySmokeShutdownStage("daemon-closed");
    })();
    return shutdownPromise;
  };
  const quitCoordinator = createDesktopQuitCoordinator({
    drain: shutdown,
    updateController,
    exit: (code) => app.exit(code),
  });
  app.on("before-quit", (event) => {
    desktopIsClosing = true;
    void residency?.close();
    if (quitCoordinator.beforeQuit(event) === "draining") quitRequested = true;
  });
  if (process.platform === "darwin") {
    installDesktopTerminationSignalHandler({
      signalSource: process,
      requestQuit: () => app.quit(),
      forceQuit: () => quitCoordinator.forceQuit(),
    });
  }
  try {
    traceDesktopStartupStage("resolve-daemon");
    const resolution = await supervisor.resolve();
    if (resolution.status === "refused") {
      if (!controller.signal.aborted && resolution.cause !== "cancelled") {
        const copy = startupRefusalCopy(resolution.cause);
        const unownedDaemon =
          process.platform === "win32" &&
          resolution.cause === "contention" &&
          !resolution.retryable;
        if (unownedDaemon) {
          process.stderr.write("desktop-daemon-ownership-refusal unowned\n");
        }
        if (desktopStartedInBackground || desktopAcceptanceHidden) {
          if (!unownedDaemon) {
            process.stderr.write(`desktop-startup-refusal ${resolution.cause}\n`);
          }
        } else {
          dialog.showErrorBox(copy.title, copy.content);
        }
      }
      traceDesktopStartupStage("shutdown-refused");
      await shutdown();
      if (!quitRequested) app.exit(resolution.exitCode);
      return;
    }
    traceDesktopStartupStage("resolve-athlete-home");
    const selectedAthleteHome = AthleteHomeIdentitySchema.parse(
      await realpath(resolveDesktopAthleteHome(environment)),
    );
    const intervalsStorePath = join(selectedAthleteHome, "store", "store.db");
    requireDesktopDaemonHome(selectedAthleteHome, resolution.athleteHome);
    const credentialRoot = join(app.getPath("userData"), CREDENTIAL_DIRECTORY_NAME);
    const telegramCredentialRoot = join(
      app.getPath("userData"),
      TELEGRAM_CREDENTIAL_DIRECTORY_NAME,
    );
    const serializeCredentialMutation = createCredentialMutationLock();
    const serializeCredentialEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const acceptanceCredentialBackend = resolveAcceptanceCredentialBackend({
      isPackaged: app.isPackaged,
      hidden: desktopAcceptanceHidden,
      backend: environment.ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND,
      appName: app.getName(),
      appPath: app.getAppPath(),
      userDataPath: app.getPath("userData"),
      disposableContext:
        environment.CI === "true" || environment.ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT === "1",
    });
    traceDesktopStartupStage("prepare-credential-encryption");
    const credentialEncryption = await prepareDesktopCredentialEncryption({
      credentialRoot,
      telegramRoot: telegramCredentialRoot,
      location: {
        platform: process.platform,
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        applicationPath: app.getAppPath(),
      },
      safeStorage,
      serializeEnvelopeMutation: serializeCredentialEnvelopeMutation,
      ...(acceptanceCredentialBackend !== undefined
        ? {
            createTransport: () => createAcceptanceKeychainTransport(acceptanceCredentialBackend),
          }
        : {}),
    });
    const prepareCredentialEnvelopeWrite = async (
      proof: CredentialEnvelopeLockProof,
    ): Promise<void> => {
      await credentialEncryption.prepareEnvelopeWrite(proof);
    };
    const revalidateCredentialEnvelopeRemoval = async (
      proof: CredentialEnvelopeLockProof,
    ): Promise<boolean> => await credentialEncryption.revalidateEnvelopeRemoval(proof);
    const retireCredentialEncryptionKey = async (
      proof: CredentialEnvelopeLockProof,
    ): Promise<void> => {
      await credentialEncryption.retireKeychainKey(proof);
    };
    const credentialRecoveryStatus = async (): Promise<DesktopCredentialRecoveryStatus> => {
      const snapshot = await credentialEncryption.credentialRecoverySnapshot();
      const selected = snapshot.selection;
      if (selected.status === "keychain") {
        return {
          state: "ready",
          unverifiedEnvelopes: snapshot.unverifiedEnvelopes,
        };
      }
      if (selected.status === "safe-storage") {
        return { state: "ready", unverifiedEnvelopes: 0 };
      }
      return { state: desktopCredentialRecoveryFailureState(selected.code) };
    };
    if (process.platform === "darwin") {
      const selected = credentialEncryption.selection;
      process.stderr.write(
        selected.status === "refused"
          ? `desktop-credential-backend refused ${selected.reason} ${selected.code}\n`
          : `desktop-credential-backend ${selected.status}\n`,
      );
    }
    const telegramSecureStorageDiagnostics = createTelegramSecureStorageDiagnostics();
    const telegramVault = createTelegramCredentialVault({
      root: telegramCredentialRoot,
      athleteHome: selectedAthleteHome,
      encryption: credentialEncryption.encryption,
      observeSecureStorageFailure: telegramSecureStorageDiagnostics,
      serializeEnvelopeMutation: serializeCredentialEnvelopeMutation,
      prepareEnvelopeWrite: prepareCredentialEnvelopeWrite,
      revalidateEnvelopeRemoval: revalidateCredentialEnvelopeRemoval,
      observeEnvelopeRemoved: retireCredentialEncryptionKey,
    });
    let activeTelegramBinding: TelegramDaemonBinding | undefined;
    const preparedTelegramBindings = new Map<number, TelegramDaemonBinding>();
    const telegramCoordinator = createTelegramControlCoordinator({
      selectedAthleteHome: () => selectedAthleteHome,
      vault: telegramVault,
      daemon: {
        current() {
          const lifecycleState = daemonLifecycle?.snapshot();
          return lifecycleState?.status === "ready" &&
            activeTelegramBinding?.generation === lifecycleState.generation
            ? activeTelegramBinding
            : undefined;
        },
      },
      observeSecureStorageFailure: telegramSecureStorageDiagnostics,
      serializeCredentialMutation,
    });
    closeTelegramCoordinator = () => telegramCoordinator.close();
    telegramPower = createDesktopTelegramPowerLifecycle({
      root: telegramCredentialRoot,
      athleteHome: selectedAthleteHome,
      powerMonitor,
      controller: telegramCoordinator,
      reportFailure: (failure) => {
        process.stderr.write(`desktop-telegram-power-failure ${failure}\n`);
      },
    });
    let window: BrowserWindow | null = null;
    let windowCreation: Promise<BrowserWindow> | undefined;
    const rendererNavigationTracker = createDesktopRendererNavigationTracker<BrowserWindow>();
    const currentWindow = (): BrowserWindow | null =>
      window !== null && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : null;
    const startRendererNavigation = (
      target: BrowserWindow,
      navigationUrl: string,
    ): DesktopRendererNavigation<BrowserWindow> => {
      const navigation = rendererNavigationTracker.start(target, navigationUrl, () =>
        target.loadURL(navigationUrl),
      );
      void navigation.task.catch((error: unknown) => {
        if (
          shouldReleaseInitialRefreshAfterLoadRejection(error) &&
          connectionIpc?.isCurrentDocumentNavigation(target, navigationUrl)
        ) {
          void initialRefreshCoordinator.releaseCurrent();
        }
      });
      return navigation;
    };
    type RuntimeBinding = {
      readonly authority: RuntimeConfigurationAuthority;
      readonly credentials: CredentialRuntimeApplication;
      readonly transcript: DesktopTranscriptReader;
      readonly planning: DesktopPlanningClient;
      readonly planningRead: DesktopPlanningReader;
      readonly trainingExporter: DesktopTrainingExporter;
      readonly chatAttachments: DesktopChatAttachmentClient;
    };
    let activeRuntimeBinding: RuntimeBinding | undefined;
    const preparedRuntimeBindings = new Map<
      number,
      {
        readonly binding: RuntimeBinding;
        readonly statuses: readonly CredentialSlotStatus[];
        readonly revisions: ReadonlyMap<DesktopCredentialSlot, number>;
      }
    >();
    const credentialRuntimeState = new Map<DesktopCredentialSlot, CredentialRuntimeState>();
    const credentialRuntimeRevisions = new Map<DesktopCredentialSlot, number>();
    const markCredentialRuntimeChange = (slot: DesktopCredentialSlot): void => {
      credentialRuntimeRevisions.set(slot, (credentialRuntimeRevisions.get(slot) ?? 0) + 1);
    };
    const failModelCredentialRuntimeStates = (): void => {
      for (const slot of DESKTOP_CREDENTIAL_SLOTS) {
        if (slot === "intervals-icu") continue;
        credentialRuntimeState.set(slot, "failed");
        markCredentialRuntimeChange(slot);
      }
    };
    let recoveringCredentialRuntime:
      | {
          readonly states: ReadonlyMap<DesktopCredentialSlot, CredentialRuntimeState>;
          readonly revisions: ReadonlyMap<DesktopCredentialSlot, number>;
        }
      | undefined;
    let reapplyCredentials = async (
      _connection: DesktopDaemonConnection,
      _signal: AbortSignal,
    ): Promise<void> => {};
    const publishLifecycle = (state: DesktopDaemonLifecycleState): void => {
      if (state.status === "recovering" && recoveringCredentialRuntime === undefined) {
        recoveringCredentialRuntime = {
          states: new Map(credentialRuntimeState),
          revisions: new Map(credentialRuntimeRevisions),
        };
        for (const slot of credentialRuntimeState.keys()) {
          credentialRuntimeState.set(slot, "failed");
        }
      }
      if (state.status === "ready" && recoveringCredentialRuntime !== undefined) {
        for (const [slot, runtimeState] of recoveringCredentialRuntime.states) {
          if (
            (credentialRuntimeRevisions.get(slot) ?? 0) ===
            (recoveringCredentialRuntime.revisions.get(slot) ?? 0)
          ) {
            credentialRuntimeState.set(slot, runtimeState);
          }
        }
        recoveringCredentialRuntime = undefined;
      }
      if (state.status === "closing" || state.status === "terminal") {
        activeTelegramBinding = undefined;
        for (const slot of credentialRuntimeState.keys()) {
          credentialRuntimeState.set(slot, "failed");
        }
        recoveringCredentialRuntime = undefined;
        preparedRuntimeBindings.clear();
        preparedTelegramBindings.clear();
      }
      const visibleWindow = currentWindow();
      if (visibleWindow !== null && state.status !== "starting") {
        visibleWindow.webContents.send(DESKTOP_LIFECYCLE_CHANNEL, {
          status: state.status,
          generation: state.generation,
        });
      }
      const copy =
        controller.signal.aborted || desktopIsClosing ? undefined : lifecycleErrorCopy(state);
      if (copy !== undefined) {
        const unownedDaemon =
          process.platform === "win32" &&
          state.status === "terminal" &&
          state.cause === "contention";
        if (unownedDaemon) {
          process.stderr.write("desktop-daemon-ownership-refusal unowned\n");
        }
        if (desktopAcceptanceHidden || (desktopStartedInBackground && currentWindow() === null)) {
          if (!unownedDaemon) {
            process.stderr.write(`desktop-daemon-background-failure ${state.status}\n`);
          }
        } else {
          dialog.showErrorBox(copy.title, copy.content);
        }
      }
    };
    daemonLifecycle = new DesktopDaemonLifecycle(supervisor, resolution, {
      prepareReady: ({ connection, signal }) => reapplyCredentials(connection, signal),
      onTransition: publishLifecycle,
      onReady({ previous, current }) {
        activeTelegramBinding = preparedTelegramBindings.get(current.generation);
        preparedTelegramBindings.delete(current.generation);
        const prepared = preparedRuntimeBindings.get(current.generation);
        if (prepared !== undefined) {
          activeRuntimeBinding = prepared.binding;
          replaceCredentialRuntimeStates(
            credentialRuntimeState,
            prepared.statuses,
            (slot) =>
              (credentialRuntimeRevisions.get(slot) ?? 0) === (prepared.revisions.get(slot) ?? 0),
          );
          preparedRuntimeBindings.delete(current.generation);
        }
        const visibleWindow = currentWindow();
        if (current.owner !== "app-supervised") {
          if (visibleWindow !== null) {
            const portChanged = new URL(previous.url).port !== new URL(current.url).port;
            const advanced =
              !portChanged &&
              (connectionIpc?.advanceCurrentDocumentGeneration(current.generation) ?? false);
            if (!advanced) {
              try {
                const navigationUrl = connectionIpc!.prepareDocumentNavigation(
                  visibleWindow,
                  current.generation,
                );
                startRendererNavigation(visibleWindow, navigationUrl);
              } catch {}
            }
          }
          return;
        }
        const recovery = initialRefreshCoordinator.prepareRecovery({
          current,
          rendererPresent: visibleWindow !== null,
        });
        if (recovery === "reload-required") {
          try {
            const navigationUrl = connectionIpc!.prepareDocumentNavigation(
              visibleWindow!,
              current.generation,
            );
            startRendererNavigation(visibleWindow!, navigationUrl);
          } catch {
            void initialRefreshCoordinator.releaseCurrent();
          }
        }
      },
    });
    const configDir = join(selectedAthleteHome, "config");
    const createRuntimeBinding = (
      connection: Pick<DesktopDaemonConnection, "url" | "token" | "athleteHome">,
    ): RuntimeBinding => {
      requireDesktopDaemonHome(selectedAthleteHome, connection.athleteHome);
      const boundConnection = { ...connection, athleteHome: selectedAthleteHome };
      const authority = createConnectionRuntimeAuthority(boundConnection, connectCoachClient);
      return {
        authority,
        transcript: createConnectionTranscriptReader(boundConnection),
        planning: createConnectionPlanningClient(boundConnection),
        planningRead: createConnectionPlanningReader(boundConnection),
        trainingExporter: createConnectionTrainingExporter(boundConnection),
        chatAttachments: createConnectionChatAttachmentClient(boundConnection),
        credentials: createCredentialRuntimeApplication({
          configureRuntime: authority.configureRuntime,
          clearRuntimeCredential: authority.clearCredential,
          selectedLlmProvider: async (storedCredentialSlots) =>
            readSelectedLlmProvider(await authority.getRuntimeConfig(), {
              chatGptProfilePresent: await hasChatGptProfile(configDir),
              storedCredentialSlots,
            }),
        }),
      };
    };
    activeRuntimeBinding = createRuntimeBinding({
      url: resolution.url,
      token: resolution.token,
      athleteHome: resolution.athleteHome,
    });
    const readActiveRuntimeConfig = async (signal?: AbortSignal) => {
      const binding = activeRuntimeBinding;
      const lifecycleState = daemonLifecycle?.snapshot();
      if (binding === undefined || lifecycleState?.status !== "ready") throw new TypeError();
      const snapshot = await binding.authority.getRuntimeConfig(signal);
      const currentLifecycleState = daemonLifecycle?.snapshot();
      if (
        activeRuntimeBinding !== binding ||
        currentLifecycleState?.status !== "ready" ||
        currentLifecycleState.generation !== lifecycleState.generation
      ) {
        throw new TypeError();
      }
      return snapshot;
    };
    const verifyActiveIntervalsCredential = createActiveIntervalsCredentialPreflight({
      currentBinding: () => activeRuntimeBinding,
      lifecycleSnapshot: () => daemonLifecycle?.snapshot(),
    });
    const readActiveTranscript = async <T>(
      read: (reader: DesktopTranscriptReader) => Promise<T>,
    ): Promise<T> => {
      const binding = activeRuntimeBinding;
      const lifecycleState = daemonLifecycle?.snapshot();
      if (binding === undefined || lifecycleState?.status !== "ready") throw new TypeError();
      const value = await read(binding.transcript);
      const currentLifecycleState = daemonLifecycle?.snapshot();
      if (
        activeRuntimeBinding !== binding ||
        currentLifecycleState?.status !== "ready" ||
        currentLifecycleState.generation !== lifecycleState.generation
      ) {
        throw new TypeError();
      }
      return value;
    };
    const readActivePlanning = async () => {
      const binding = activeRuntimeBinding;
      const lifecycleState = daemonLifecycle?.snapshot();
      if (binding === undefined || lifecycleState?.status !== "ready") throw new TypeError();
      const value = await binding.planningRead.getPlanningReadModel();
      const currentLifecycleState = daemonLifecycle?.snapshot();
      if (
        activeRuntimeBinding !== binding ||
        currentLifecycleState?.status !== "ready" ||
        currentLifecycleState.generation !== lifecycleState.generation
      ) {
        throw new TypeError();
      }
      return value;
    };
    const useActivePlanning = async <T>(
      use: (planning: DesktopPlanningClient, isCurrent: () => boolean) => Promise<T>,
    ): Promise<T> => {
      const binding = activeRuntimeBinding;
      const lifecycleState = daemonLifecycle?.snapshot();
      if (binding === undefined || lifecycleState?.status !== "ready") throw new TypeError();
      const isCurrent = (): boolean => {
        const currentLifecycleState = daemonLifecycle?.snapshot();
        return (
          activeRuntimeBinding === binding &&
          currentLifecycleState?.status === "ready" &&
          currentLifecycleState.generation === lifecycleState.generation
        );
      };
      const result = await use(binding.planning, isCurrent);
      if (!isCurrent()) throw new TypeError();
      return result;
    };
    const vault = createCredentialVault({
      root: credentialRoot,
      encryption: credentialEncryption.encryption,
      serializeEnvelopeMutation: serializeCredentialEnvelopeMutation,
      prepareEnvelopeWrite: prepareCredentialEnvelopeWrite,
      revalidateEnvelopeRemoval: revalidateCredentialEnvelopeRemoval,
      observeEnvelopeRemoved: retireCredentialEncryptionKey,
      runtimeState: credentialRuntimeState,
      serializeCredentialMutation,
      onRuntimeStateChange: markCredentialRuntimeChange,
      createRuntimePublicationGuard(slot) {
        const binding = activeRuntimeBinding;
        const lifecycleState = daemonLifecycle?.snapshot();
        return () => {
          const currentLifecycleState = daemonLifecycle?.snapshot();
          const canPublish =
            binding !== undefined &&
            activeRuntimeBinding === binding &&
            lifecycleState?.status === "ready" &&
            currentLifecycleState?.status === "ready" &&
            lifecycleState.generation === currentLifecycleState.generation;
          if (!canPublish && slot !== "intervals-icu") failModelCredentialRuntimeStates();
          return canPublish;
        };
      },
      async applyCredential(slot, value, selection, verificationApproval) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        const request = runtimeConfigurationForCredential(slot, value, selection);
        await applyExplicitCredentialToRuntime(binding.credentials, request, verificationApproval);
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          if (slot !== "intervals-icu") failModelCredentialRuntimeStates();
          throw new TypeError();
        }
      },
      async reapplyCredential(slot, value, storedCredentialSlots) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        const status = await binding.credentials.reapplyStoredCredential(
          slot,
          value,
          storedCredentialSlots,
        );
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          if (slot !== "intervals-icu") failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        return status;
      },
      async clearCredential(slot) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        const result = await binding.credentials.clearCredential(slot);
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          if (slot !== "intervals-icu") failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        return result;
      },
    });
    reapplyCredentials = async (connection, signal) => {
      if (signal.aborted) throw signal.reason;
      const revisions = new Map(credentialRuntimeRevisions);
      const successor = createRuntimeBinding(connection);
      const successorVault = createCredentialVault({
        root: credentialRoot,
        encryption: credentialEncryption.encryption,
        serializeCredentialMutation,
        async applyCredential(slot, value) {
          await successor.credentials.applyExplicit(runtimeConfigurationForCredential(slot, value));
        },
        reapplyCredential: successor.credentials.reapplyStoredCredential,
      });
      await successorVault.reapplyConfigured();
      const successorStatuses = await successorVault.credentialStatuses();
      const successorTelegram = createTelegramDaemonBinding(connection, selectedAthleteHome);
      if (connection.supervision === "app-supervised") {
        const successorTelegramCoordinator = createTelegramControlCoordinator({
          selectedAthleteHome: () => selectedAthleteHome,
          vault: telegramVault,
          daemon: { current: () => successorTelegram },
          observeSecureStorageFailure: telegramSecureStorageDiagnostics,
          serializeCredentialMutation,
        });
        const reconciliation = await successorTelegramCoordinator.reconcile();
        const desiredState = await telegramVault.desiredState();
        const expectedEnabled = desiredState.state === "configured" && desiredState.enabled;
        const prepared =
          reconciliation.outcome === "applied" &&
          (expectedEnabled
            ? reconciliation.current.credentialConfigured &&
              reconciliation.current.channel.desiredState === "enabled" &&
              (reconciliation.current.channel.state === "starting" ||
                reconciliation.current.channel.state === "online" ||
                reconciliation.current.channel.state === "offline-retrying")
            : reconciliation.current.channel.state === "disabled");
        if (!prepared) throw new TypeError("Telegram successor preparation failed");
      }
      const lifecycleState = daemonLifecycle?.snapshot();
      if (
        signal.aborted ||
        lifecycleState?.status !== "recovering" ||
        lifecycleState.generation + 1 !== connection.generation
      ) {
        throw new TypeError("desktop daemon successor preparation expired");
      }
      preparedRuntimeBindings.set(connection.generation, {
        binding: successor,
        statuses: successorStatuses,
        revisions,
      });
      preparedTelegramBindings.set(connection.generation, successorTelegram);
    };
    const chatGptAuth = createChatGptAuth({
      configDir,
      async applyRuntimeConfig(request, signal) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        await binding.credentials.applyExplicit(request, signal);
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        markUnselectedModelCredentialsInactive(
          credentialRuntimeState,
          undefined,
          markCredentialRuntimeChange,
        );
      },
      async clearRuntimeCredential() {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        const result = await binding.credentials.clearCredential("openai-codex");
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        if (result === "cleared") {
          markUnselectedModelCredentialsInactive(
            credentialRuntimeState,
            undefined,
            markCredentialRuntimeChange,
          );
        }
        return result;
      },
      getRuntimeConfig: readActiveRuntimeConfig,
      openExternal: (url) => shell.openExternal(url),
      signal: controller.signal,
      serializeCredentialMutation,
    });
    const managedModelCredentials = new Set<string>([
      ...DESKTOP_CREDENTIAL_SLOTS.filter((slot) => slot !== "intervals-icu"),
      CHATGPT_PROFILE_NAME,
    ]);
    const resetAllCredentials: () => Promise<DesktopCredentialResetResult> =
      createDesktopCredentialReset({
        serializeCredentialMutation,
        currentRuntimeBinding: () => activeRuntimeBinding,
        lifecycleSnapshot: () => daemonLifecycle?.snapshot(),
        managedModelCredentials,
        resetTelegramRuntime: () => telegramCoordinator.resetRuntimeForCredentialReset(),
        configDir,
        deleteChatGptProfile,
        credentialRoot,
        telegramRoot: telegramCredentialRoot,
        serializeEnvelopeMutation: serializeCredentialEnvelopeMutation,
        deleteKeyForCredentialReset: (proof) =>
          credentialEncryption.deleteKeyForCredentialReset(proof),
        credentialRuntimeState,
        onRuntimeStateChange: markCredentialRuntimeChange,
      });
    const claudeCli = createClaudeCliStatus({
      settings: () => readClaudeCliSettings({ configPath: join(configDir, "config.yaml") }),
      environment: () => environment,
      forbiddenRoots: [selectedAthleteHome, app.getPath("userData"), process.resourcesPath],
      async applyRuntimeConfig(request) {
        const binding = activeRuntimeBinding!;
        const lifecycleState = daemonLifecycle?.snapshot();
        if (lifecycleState?.status !== "ready") throw new TypeError();
        await binding.credentials.applyExplicit(request);
        const currentLifecycleState = daemonLifecycle?.snapshot();
        if (
          activeRuntimeBinding !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          failModelCredentialRuntimeStates();
          throw new TypeError();
        }
        markUnselectedModelCredentialsInactive(
          credentialRuntimeState,
          undefined,
          markCredentialRuntimeChange,
        );
      },
    });
    daemonLifecycle.start();
    traceDesktopStartupStage("reapply-credentials");
    await vault.reapplyConfigured();
    const initialTelegramConnection = daemonLifecycle.connection();
    activeTelegramBinding = createTelegramDaemonBinding(
      initialTelegramConnection,
      selectedAthleteHome,
    );
    traceDesktopStartupStage("start-telegram");
    await startDesktopTelegram({
      supervision: initialTelegramConnection.supervision,
      coordinator: telegramCoordinator,
      power: telegramPower,
    });
    traceDesktopStartupStage("install-protocol");
    await installDesktopProtocol({
      session: session.defaultSession,
      currentDaemonPort: () => daemonLifecycle!.currentPort(),
      rendererRoot: rendererOutputRoot(),
      rendererSource,
    });
    protocolInstalled = true;
    const mainWindow = {
      current: currentWindow,
      show: (): Promise<BrowserWindow> => {
        if (windowCreation !== undefined) return windowCreation;
        const current = mainWindow.current();
        if (current !== null) {
          if (!desktopAcceptanceHidden) {
            if (current.isMinimized()) current.restore();
            current.show();
            current.focus();
          }
          return Promise.resolve(current);
        }
        let creating: BrowserWindow | undefined;
        windowCreation = (async () => {
          const navigationGeneration = daemonLifecycle!.connection().generation;
          const windowOptions = desktopWindowOptions(
            preloadEntry,
            nativeTheme.shouldUseDarkColors ? "dark" : "light",
          );
          if (desktopAcceptanceHidden) {
            windowOptions.webPreferences = {
              ...windowOptions.webPreferences,
              backgroundThrottling: false,
            };
          }
          traceDesktopStartupStage("create-browser-window");
          const created = new BrowserWindow(windowOptions);
          creating = created;
          window = created;
          residency?.manageMainWindow(created);
          rendererConsoleCapture.attach(created.webContents);
          hardenDesktopWindow(created);
          disposeOnboarding?.();
          disposeOnboarding = registerOnboardingIpc({
            ipcMain,
            dialog,
            window: created,
            vault,
            chatGptAuth,
            claudeCli,
            getRuntimeConfig: readActiveRuntimeConfig,
            applyExistingLlmSelection: async (
              selection: OnboardingLlmSelection,
              signal?: AbortSignal,
            ) => {
              signal?.throwIfAborted();
              const binding = activeRuntimeBinding;
              const lifecycleState = daemonLifecycle?.snapshot();
              if (binding === undefined || lifecycleState?.status !== "ready") {
                throw new TypeError();
              }
              const applied = await binding.credentials.applyExistingLlmSelection(
                selection.provider,
                runtimeConfigurationForExistingSelection(selection),
                signal,
              );
              signal?.throwIfAborted();
              const currentLifecycleState = daemonLifecycle?.snapshot();
              if (
                activeRuntimeBinding !== binding ||
                currentLifecycleState?.status !== "ready" ||
                currentLifecycleState.generation !== lifecycleState.generation
              ) {
                throw new TypeError();
              }
              return applied;
            },
            checkIntervalsCredentialOwner: async (value) => {
              const snapshot = await activeRuntimeBinding!.authority.getRuntimeConfig();
              return checkIntervalsStoreOwnerAtPath(intervalsStorePath, {
                apiKey: value,
                athleteId: intervalsAthleteIdForOwnership(snapshot),
                historyNewestDate: "1970-01-01",
                clock: { now: () => Date.now(), monotonicNow: () => performance.now() },
                signal: controller.signal,
              });
            },
            credentialRecoveryStatus,
            retryCredentialRecovery: async () => {
              await credentialEncryption.retryKeychain();
              return await credentialRecoveryStatus();
            },
            resetAllCredentials,
            isTrusted: (event) =>
              isTrustedConnectionRequest(event, mainWindow.current() ?? undefined),
          });
          created.once("closed", () => {
            if (window === created) {
              window = null;
              disposeOnboarding?.();
              disposeOnboarding = undefined;
              void initialRefreshCoordinator.releaseCurrent();
            }
          });
          created.webContents.on("render-process-gone", () => {
            if (
              shouldReleaseInitialRefreshForWindowEvent(
                currentWindow(),
                created,
                connectionIpc?.isCurrentDocumentNavigation(created, created.webContents.getURL()) ??
                  false,
              )
            ) {
              void initialRefreshCoordinator.releaseCurrent();
            }
          });
          created.webContents.on(
            "did-fail-load",
            (_event, errorCode, _description, failedUrl, mainFrame) => {
              if (
                shouldReleaseInitialRefreshAfterLoadFailure(errorCode, mainFrame) &&
                connectionIpc?.isCurrentDocumentNavigation(created, failedUrl)
              ) {
                void initialRefreshCoordinator.releaseCurrent();
              }
            },
          );
          const navigationUrl = connectionIpc!.prepareDocumentNavigation(
            created,
            navigationGeneration,
          );
          traceDesktopStartupStage("navigate-main-window");
          const initialNavigation = startRendererNavigation(created, navigationUrl);
          await rendererNavigationTracker.waitForCurrent(initialNavigation);
          traceDesktopStartupStage("main-window-navigated");
          if (!desktopAcceptanceHidden) {
            if (created.isMinimized()) created.restore();
            created.show();
            created.focus();
          }
          return created;
        })()
          .catch((error: unknown) => {
            const created = creating;
            if (created !== undefined) {
              if (window === created) {
                window = null;
                disposeOnboarding?.();
                disposeOnboarding = undefined;
              }
              if (!created.isDestroyed()) created.destroy();
            }
            const lifecycleState = daemonLifecycle?.snapshot();
            if (
              lifecycleState?.status === "terminal" &&
              !desktopAcceptanceHidden &&
              !desktopIsClosing
            ) {
              const copy = lifecycleErrorCopy(lifecycleState);
              if (copy !== undefined) dialog.showErrorBox(copy.title, copy.content);
            }
            throw error;
          })
          .finally(() => {
            windowCreation = undefined;
          });
        return windowCreation;
      },
    };
    connectionIpc = installDesktopConnectionIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      expectedAthleteHome: selectedAthleteHome,
      runtime: daemonLifecycle,
      initialSetupStatusSettled: (generation) =>
        initialRefreshCoordinator.initialSetupStatusSettled(generation),
    });
    disposeTranscriptIpc = installDesktopTranscriptIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      readPage: (request) => readActiveTranscript((reader) => reader.getTranscriptPage(request)),
      readArchivedConversations: (request) =>
        readActiveTranscript((reader) => reader.listArchivedConversations(request)),
      deleteArchivedConversation: (request) =>
        readActiveTranscript((reader) => reader.deleteArchivedConversation(request)),
      readArchivedPage: (request) =>
        readActiveTranscript((reader) => reader.getArchivedTranscriptPage(request)),
    });
    disposePlanningReadIpc = installDesktopPlanningReadIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      read: readActivePlanning,
    });
    disposePlanningIpc = installDesktopPlanningIpc({
      ipcMain,
      dialog,
      currentWindow: () => mainWindow.current() ?? undefined,
      getPlanState: (request) => useActivePlanning((planning) => planning.getPlanState(request)),
      executePlanTransition: (request, onEvent) =>
        useActivePlanning((planning, isCurrent) =>
          planning.executePlanTransition(request, (event) => {
            if (isCurrent()) onEvent(event);
          }),
        ),
    });
    disposeTrainingExportIpc = installDesktopTrainingExportIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      dialog,
      exporter: () => {
        const binding = activeRuntimeBinding;
        const lifecycleState = daemonLifecycle?.snapshot();
        return binding !== undefined && lifecycleState?.status === "ready"
          ? binding.trainingExporter
          : undefined;
      },
    });
    disposeChatAttachmentIpc = installDesktopChatAttachmentIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      dialog,
      clipboard,
      client: () => {
        const binding = activeRuntimeBinding;
        const lifecycleState = daemonLifecycle?.snapshot();
        return binding !== undefined && lifecycleState?.status === "ready"
          ? binding.chatAttachments
          : undefined;
      },
    });
    disposeExternalLinkIpc = installDesktopExternalLinkIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      openExternal: (url) => shell.openExternal(url),
    });
    disposeAppearanceIpc = installDesktopAppearanceIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      applyThemeSource: (appearance) => {
        nativeTheme.themeSource = appearance;
        return nativeTheme.shouldUseDarkColors ? "dark" : "light";
      },
    });
    disposeUpdateIpc = installDesktopUpdateIpc({
      ipcMain,
      currentWindow: () => mainWindow.current() ?? undefined,
      isTrusted: (event) => isTrustedConnectionRequest(event, mainWindow.current() ?? undefined),
      controller: updateController,
    });
    disposeIntervalsIpc = installDesktopIntervalsIpc({
      ipcMain,
      clipboard,
      vault,
      signal: controller.signal,
      isTrusted: (event) => isTrustedConnectionRequest(event, mainWindow.current() ?? undefined),
      verifyCredential: createDesktopIntervalsCredentialVerifier({
        storePath: intervalsStorePath,
        readRuntimeConfig: readActiveRuntimeConfig,
        verifyWithDaemon: verifyActiveIntervalsCredential,
      }),
    });
    disposeTelegramIpc = installDesktopTelegramIpc({
      ipcMain,
      clipboard,
      coordinator: telegramCoordinator,
      vault: telegramVault,
      power: telegramPower,
      isTrusted: (event) => isTrustedConnectionRequest(event, mainWindow.current() ?? undefined),
    });
    const initialRefreshConnection = daemonLifecycle.connection();
    if (initialRefreshConnection.owner === "app-supervised") {
      initialRefreshCoordinator.arm(initialRefreshConnection);
    }
    residency = createDesktopResidency({
      app,
      mainWindow,
      trayIconPath: resolve(
        mainDirectory,
        process.platform === "win32"
          ? "../../resources/tray.ico"
          : "../../resources/trayTemplate.png",
      ),
      platform: process.platform,
      loginItemExecutablePath: process.execPath,
      persistLoginPreference: (enabled) => backgroundAtLoginPreference.set(enabled),
      reportFailure(operation) {
        process.stderr.write(`desktop-residency-failure ${operation}\n`);
      },
    });
    if (process.platform === "win32") {
      traceDesktopStartupStage("bind-activation");
      await activation.bind(residency);
    }
    traceDesktopStartupStage("start-residency");
    await residency.start();
    if (
      desktopStartedInBackground &&
      initialRefreshConnection.owner === "app-supervised" &&
      mainWindow.current() === null
    ) {
      void initialRefreshCoordinator.releaseCurrent();
    }
    traceDesktopStartupStage(desktopStartedInBackground ? "background-ready" : "show-main-window");
    const initialWindow = desktopStartedInBackground ? undefined : await mainWindow.show();
    void updateController.start();
    void desktopUsagePingController?.start();

    if (securitySmokeMode) {
      if (initialWindow === undefined) throw new TypeError("security smoke requires a window");
      const daemonPort = daemonLifecycle.currentPort();
      const rendererResult = await initialWindow.webContents.executeJavaScript(`(async () => {
      const blockedPort = ${daemonPort === 65_535 ? daemonPort - 1 : daemonPort + 1};
      const blocked = await new Promise((resolve) => {
        let violation = false;
        const onViolation = (event) => {
          if (event.effectiveDirective === "connect-src") violation = true;
        };
        document.addEventListener("securitypolicyviolation", onViolation, { once: true });
        const socket = new WebSocket("ws://127.0.0.1:" + blockedPort + "/rpc");
        const finish = () => { socket.close(); resolve(violation); };
        socket.addEventListener("error", () => setTimeout(finish, 0), { once: true });
        setTimeout(finish, 1000);
      });
      const detectRendererSurface = () => {
        const appSurface =
          document.querySelector('[data-shell="app"] button.sync-chip') !== null;
        const setupGateSurface =
          document.querySelector('[data-shell="gate"] [data-setup-host="gate"]') !== null;
        if (appSurface === setupGateSurface) return null;
        return appSurface ? "app" : "setup-gate";
      };
      const poll = () => new Promise((resolve) => setTimeout(resolve, 20));
      const deadline = Date.now() + 5000;
      while (document.documentElement.dataset.rpc === undefined && Date.now() < deadline) {
        await poll();
      }
      let rendererSurface = detectRendererSurface();
      while (rendererSurface === null && Date.now() < deadline) {
        await poll();
        rendererSurface = detectRendererSurface();
      }
      if (rendererSurface !== null) {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      }
      const credentialStatuses = await window.enduragentAuth.credentialStatuses();
      return {
        url: location.href,
        bridgeKeys: Object.keys(window.enduragentAuth ?? {}).sort(),
        credentialStatuses,
        noNodeGlobals: ["process", "require", "Buffer", "global", "module"].every((key) => typeof window[key] === "undefined"),
        rpcConnected: document.documentElement.dataset.rpc === "connected",
        blockedOffPort: blocked,
        rendererSurface,
        rendererSurfaces: {
          dom: document.documentElement.outerHTML,
          localStorage: Object.entries(localStorage),
          sessionStorage: Object.entries(sessionStorage)
        }
      };
    })()`);
      const screenshot = (await initialWindow.webContents.capturePage()).toPNG();
      const outputArgument = process.argv.find((value) =>
        value.startsWith("--desktop-security-output="),
      );
      if (outputArgument !== undefined) {
        await writeFile(outputArgument.slice("--desktop-security-output=".length), screenshot);
      }
      initialWindow.show();
      const useWindowsControlPipe = process.platform === "win32" && desktopAcceptanceHidden;
      if (useWindowsControlPipe) {
        securitySmokeControlPipe = await connectSecuritySmokeControlPipe(
          parseSecuritySmokeControlPipeArgument(process.argv),
        );
      }
      const controlShutdown =
        securitySmokeControlPipe === undefined
          ? undefined
          : waitForSecuritySmokeShutdown(securitySmokeControlPipe);
      const result = {
        url: DESKTOP_RENDERER_URL,
        rendererNavigationValid: isDesktopRendererUrl(rendererResult.url),
        rpcUrl: daemonLifecycle.connection().url,
        hasSingleInstanceLock: app.hasSingleInstanceLock(),
        visibleForSecondLaunch: initialWindow.isVisible(),
        bridgeKeys: rendererResult.bridgeKeys,
        noNodeGlobals: rendererResult.noNodeGlobals,
        rpcConnected: rendererResult.rpcConnected,
        blockedOffPort: rendererResult.blockedOffPort,
        rendererSurface: rendererResult.rendererSurface,
        credentialStatuses: rendererResult.credentialStatuses,
        credentialStatusesMetadataOnly:
          Array.isArray(rendererResult.credentialStatuses) &&
          rendererResult.credentialStatuses.every((entry: Record<string, unknown>) => {
            const keys = Object.keys(entry).sort();
            return JSON.stringify(keys) === JSON.stringify(["runtimeState", "slot", "state"]);
          }) &&
          !JSON.stringify(rendererResult.credentialStatuses).includes(
            daemonLifecycle.connection().token,
          ),
        tokenAbsentInRendererSurfaces:
          !JSON.stringify(rendererResult.rendererSurfaces).includes(
            daemonLifecycle.connection().token,
          ) &&
          !rendererConsoleCapture.hasMessageContaining(daemonLifecycle.connection().token) &&
          !screenshot.includes(daemonLifecycle.connection().token),
      };
      process.stdout.write(`DESKTOP_SECURITY_READY ${JSON.stringify(result)}\n`);
      await (controlShutdown ?? waitForSecuritySmokeShutdown(process.stdin));
      securitySmokeShutdownAccepted = true;
      await reportSecuritySmokeShutdownStage("stdin-accepted");
      await shutdown();
      await reportSecuritySmokeShutdownStage("exit-requested");
      app.exit(0);
    }
  } catch (error) {
    traceDesktopStartupStage("shutdown-failed");
    await shutdown();
    throw error;
  } finally {
    securitySmokeControlPipe?.destroy();
  }
}

async function exitSecondaryDesktop(): Promise<void> {
  const evidenceRequired =
    process.argv.includes("--desktop-security-smoke") && desktopAcceptanceHidden;
  if (!evidenceRequired) {
    app.exit(0);
    return;
  }
  try {
    await writeSecuritySmokeSecondInstance(process.stdout);
    app.exit(0);
  } catch {
    app.exit(1);
  }
}

if (process.argv.includes("--desktop-keychain-binding-probe")) {
  void runKeychainBindingProbe().catch(() => app.exit(1));
} else {
  traceDesktopStartupStage("single-instance-lock");
  const primaryInstance = app.requestSingleInstanceLock();
  if (!primaryInstance) {
    void exitSecondaryDesktop();
  } else {
    disableChromiumMediaSessionIntegration();
    const runPrimaryDesktop = process.argv.includes("--desktop-runtime-smoke")
      ? runRuntimeSmoke
      : runDesktop;
    void runPrimaryDesktop().catch((error: unknown) => {
      logDesktopStartupFailure(error);
      console.error("desktop startup failed", error);
      if (!desktopIsClosing && !desktopStartedInBackground && !desktopAcceptanceHidden) {
        dialog.showErrorBox(unexpectedStartupCopy.title, unexpectedStartupCopy.content);
      }
      app.exit(1);
    });
  }
}
