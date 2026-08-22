import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
} from "@enduragent/coach-client";
import { SaveIntakeRpcParamsSchema } from "@enduragent/coach-contract";
import { flushSync } from "react-dom";
import { createArchiveController } from "./archive/controller.js";
import { createRideAnalysisController } from "./activity-analysis/controller.js";
import { createChatController } from "./chat/controller.js";
import { createDesktopCoachClientProvider } from "./coach-client.js";
import { createFirstSyncController } from "./first-sync.js";
import { createArchiveViewAdapter } from "./state/adapters/archive.js";
import { createChatViewAdapter } from "./state/adapters/chat.js";
import { createFirstSyncViewAdapter } from "./state/adapters/first-sync.js";
import { createOnboardingViewAdapter } from "./state/adapters/onboarding.js";
import { createRideImportAdapter } from "./state/adapters/ride-import.js";
import {
  createAthleteSettingsAdapter,
  createConversationSettingsAdapter,
  createCoachSettingsAdapter,
  createCredentialSettingsAdapter,
} from "./state/adapters/settings.js";
import { createSpendSettingsAdapter } from "./state/adapters/spend.js";
import { createTelegramSettingsAdapter } from "./state/adapters/telegram.js";
import { createManualSyncViewAdapter } from "./state/adapters/sync.js";
import { createTrainingViewAdapter } from "./state/adapters/training.js";
import { createUpdateSettingsAdapter } from "./state/adapters/update.js";
import { credentialDrafts } from "./state/credential-drafts.js";
import { restoreManualSyncFocus } from "./state/manual-sync-focus.js";
import { useEnduragentStore, type EnduragentState } from "./state/store.js";
import { setupReady, setupSurfaceOnScreen } from "./state/onboarding-slice.js";
import { nonTelegramSettingsMutationActive } from "./state/settings-slice.js";
import { validateImportPaths, type OnboardingBridge } from "./onboarding/bridge.js";
import { createOnboardingCompletionController } from "./onboarding/completion.js";
import {
  createOnboardingController,
  onboardingCredentialMutationActive,
} from "./onboarding/controller.js";
import { rendererPlatformProjection } from "./platform-copy.js";
import { createTrainingContextController } from "./training-context/controller.js";
import { createManualSyncController } from "./training-context/manual-sync.js";
import { createTrainingSyncCoordinator } from "./training-sync.js";
import { createSpendMeterController } from "./spend-meter/controller.js";
import { createDesktopUpdateController } from "./update/controller.js";
import { createProviderModelSettingsController } from "./settings/provider-model-controller.js";
import { createAthleteSettingsController } from "./settings/athlete-controller.js";
import { createSessionSettingsController } from "./settings/session-controller.js";
import { createTelegramSettingsController } from "./settings/telegram-controller.js";
import {
  credentialChangesBlocked,
  createCredentialSettingsController,
} from "./settings/credential-controller.js";
import { createRideImportController, subscribeToDroppedRideImports } from "./ride-import.js";
import { createTrainingExportController } from "./training-export/controller.js";
import { settleInitialSetupStatus } from "./initial-setup-status.js";

export type Disposer = () => void;

function focusComposer(): void {
  const composer = document.querySelector("#message");
  if (composer instanceof HTMLTextAreaElement) composer.focus();
}

export function onboardingCredentialMutationsBlocked(
  state: Pick<EnduragentState, "settings">,
): boolean {
  return credentialChangesBlocked(
    state.settings.credentials,
    nonTelegramSettingsMutationActive(state.settings),
  );
}

export function bootRenderer(): Disposer {
  const store = useEnduragentStore;
  const platform = rendererPlatformProjection(window.enduragentAuth.platform);
  store.getState().setOnboardingStartupSettled(false);
  const onLifecycle = (event: WindowEventMap["enduragent-lifecycle"]): void => {
    document.documentElement.dataset.rpc = event.detail.status;
  };
  window.addEventListener("enduragent-lifecycle", onLifecycle);

  const updateAdapter = createUpdateSettingsAdapter({
    publish: (next) => store.getState().patchSettings({ update: next }),
  });
  const desktopUpdateController = createDesktopUpdateController({
    bridge: window.enduragentAuth,
    view: updateAdapter.view,
  });
  void desktopUpdateController.start();

  const clients = createDesktopCoachClientProvider();
  const rideAnalysisController = createRideAnalysisController({
    clients,
    view: {
      render: (next) => store.getState().setRideAnalysis(next),
    },
  });
  store.getState().bindRideAnalysisActions({
    refresh: (sections) => {
      void rideAnalysisController.load(sections, true);
    },
  });
  const trainingExportController = createTrainingExportController({
    transport: window.enduragentAuth,
    view: { render: (next) => store.getState().setTrainingExport(next) },
  });
  store.getState().bindTrainingExportActions(trainingExportController);
  let selectedAnalysisRide = store.getState().selectedRide?.id ?? null;
  const disposeRideAnalysisSelection = store.subscribe((next) => {
    const selected = next.selectedRide?.id ?? null;
    if (selected === selectedAnalysisRide) return;
    selectedAnalysisRide = selected;
    void rideAnalysisController.select(selected);
  });
  const clientAfterFailure = async (failedClient: CoachClient | undefined) => {
    if (failedClient === undefined) return clients.reconnect();
    const current = await clients.getClient();
    return current === failedClient ? clients.reconnect() : current;
  };
  const trainingAdapter = createTrainingViewAdapter({
    readUnits: () => store.getState().settings.units,
    publish: (next) => store.getState().setTraining(next),
    publishUnits: (units) => store.getState().patchSettings({ units }),
  });
  const trainingContextController = createTrainingContextController({
    clients,
    view: trainingAdapter.view,
  });
  const trainingSyncCoordinator = createTrainingSyncCoordinator({
    clients,
    refreshTrainingContext: () => trainingContextController.refresh(),
  });
  const syncAdapter = createManualSyncViewAdapter({
    publish: (next) =>
      flushSync(() => {
        store.getState().setSync(next);
      }),
    restoreFocus: restoreManualSyncFocus,
  });
  const manualSyncController = createManualSyncController({
    coordinator: trainingSyncCoordinator,
    view: syncAdapter.view,
  });
  store.getState().bindSyncActions({
    request: (kind) => void manualSyncController.activate(kind),
  });
  const spendAdapter = createSpendSettingsAdapter({
    read: () => store.getState().settings.spend,
    publish: (next) => store.getState().patchSettings({ spend: next }),
  });
  const spendController = createSpendMeterController({
    clients,
    view: spendAdapter.view,
  });
  const chatAdapter = createChatViewAdapter({
    publish: (next) =>
      flushSync(() => {
        store.getState().setChatSurface(next);
      }),
  });
  const chatController = createChatController({
    clients,
    view: chatAdapter.view,
    refreshTrainingContext: () => trainingContextController.refresh(),
    refreshSpend: () => spendController.refresh(),
    readTranscriptPage: (request) => window.enduragentAuth.getTranscriptPage(request),
    canChat: () => setupReady(store.getState()),
  });
  const disposeSetupReadiness = store.subscribe((state, previousState) => {
    if (!setupReady(previousState) && setupReady(state)) void chatController.resume();
  });

  const archiveAdapter = createArchiveViewAdapter({
    publish: (next) => store.getState().setArchive(next),
  });
  const archiveController = createArchiveController({
    listConversations: () => window.enduragentAuth.listArchivedConversations(),
    readPage: (request) => window.enduragentAuth.getArchivedTranscriptPage(request),
    view: archiveAdapter.view,
  });
  store.getState().bindArchiveActions({
    refresh: () => void archiveController.refresh(),
    open: (boundaryRef) => void archiveController.open(boundaryRef),
    close: () => archiveController.close(),
    loadEarlier: () => void archiveController.loadEarlier(),
    retry: () => void archiveController.retry(),
  });

  const firstSyncController = createFirstSyncController({
    coordinator: trainingSyncCoordinator,
    focusComposer,
    render: createFirstSyncViewAdapter({
      publish: (next) => store.getState().setFirstSync(next),
    }).render,
  });
  store.getState().bindChatActions({
    submit: (message) => void chatController.submit(message),
    removeQueued: (id) => chatController.removeQueued(id),
    retry: () => void chatController.retryInterrupted(),
    loadEarlier: () => void chatController.loadEarlier(),
    retryHydration: () => void chatController.retryHydration(),
    openNewConversation: () => void chatController.openNewConversation(),
    cancelNewConversation: () => chatController.cancelNewConversation(),
    confirmNewConversation: () => void chatController.confirmNewConversation(),
    retryFirstSync: () => void firstSyncController.retry(),
  });

  let onboardingNeedsReconnect = false;
  let onboardingFailedClient: CoachClient | undefined;
  const onboardingClient = async () => {
    const client = onboardingNeedsReconnect
      ? await clientAfterFailure(onboardingFailedClient)
      : await clients.getClient();
    onboardingNeedsReconnect = false;
    onboardingFailedClient = undefined;
    return client;
  };
  const onboardingBridge: OnboardingBridge = {
    async getSetupStatus() {
      const client = await onboardingClient();
      return client.call("getSetupStatus", {});
    },
    credentialStatuses: () => window.enduragentAuth.credentialStatuses(),
    retryFailedCredentials: () => window.enduragentAuth.retryFailedCredentials(),
    writeCredential: (value) => window.enduragentAuth.writeCredential(value),
    pasteIntervalsApiKeyFromClipboard: () =>
      window.enduragentAuth.pasteIntervalsApiKeyFromClipboard(),
    llmConfiguration: () => window.enduragentAuth.llmConfiguration(),
    applyLlmSelection: (value) => window.enduragentAuth.applyLlmSelection(value),
    chatGptStatus: () => window.enduragentAuth.chatgptStatus(),
    chatGptLogin: (value) => window.enduragentAuth.chatgptLogin(value),
    cancelChatGptLogin: (operationId) => window.enduragentAuth.cancelChatgptLogin(operationId),
    onChatGptLoginProgress: (listener) => window.enduragentAuth.onChatgptLoginProgress(listener),
    claudeCliStatus: () => window.enduragentAuth.claudeCliStatus(),
    claudeCliRecheck: () => window.enduragentAuth.claudeCliRecheck(),
    chooseImportFiles: () => window.enduragentAuth.chooseImportFiles(),
    onDroppedImportFiles: (listener) => window.enduragentAuth.onDroppedImportFiles(listener),
    async importFiles(paths, onProgress) {
      let client: CoachClient | undefined;
      try {
        client = await onboardingClient();
        return await client.call(
          "importFiles",
          { paths: [...validateImportPaths(paths)] },
          { onNotificationEnvelope: onProgress },
        );
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) {
          onboardingNeedsReconnect = true;
          onboardingFailedClient = client;
        }
        throw error;
      }
    },
    async saveIntake(value) {
      let client: CoachClient | undefined;
      try {
        client = await onboardingClient();
        const result = await client.call("saveIntake", SaveIntakeRpcParamsSchema.parse(value));
        if (!result.saved) throw new CoachClientProtocolError();
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) {
          onboardingNeedsReconnect = true;
          onboardingFailedClient = client;
        }
        throw error;
      }
    },
  };

  const rideImports = createRideImportController(onboardingBridge);
  const rideImportAdapter = createRideImportAdapter({
    imports: rideImports,
    publish: (next) => store.getState().setRideImport(next),
  });
  store.getState().bindRideImportActions(rideImportAdapter.port);
  const onboardingCompletion = createOnboardingCompletionController({
    storage: () => window.localStorage,
    onComplete: (completion) => void firstSyncController.start(completion),
  });
  const onboardingAdapter = createOnboardingViewAdapter({
    publish: (next) => store.getState().setOnboarding(next),
  });
  const onboarding = createOnboardingController({
    bridge: onboardingBridge,
    credentials: credentialDrafts,
    view: onboardingAdapter.view,
    rideImports,
    onRideImportPresentationChange: (presenting) =>
      store.getState().setRideImportSuppressed(presenting),
    focusOpener: () => {},
    onComplete: (completion) => onboardingCompletion.complete(completion),
    ownsDroppedImportFiles: () => setupSurfaceOnScreen(store.getState()),
    credentialMutationsBlocked: () => onboardingCredentialMutationsBlocked(store.getState()),
    codexAgentSupported: platform.capabilities.codexAgent,
  });
  store.getState().bindOnboardingActions(onboarding);
  const closePanes = (): void => {
    providerModelSettingsController.close();
    credentialSettingsController.close();
    athleteSettingsController.close();
    sessionSettingsController.close();
  };
  const openSetupFromSettings = (): void => {
    const heading = document.querySelector<HTMLElement>("#setup-panel-title");
    heading?.scrollIntoView({ block: "start" });
    heading?.focus();
  };
  const coachAdapter = createCoachSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ coach: state }),
  });
  const credentialAdapter = createCredentialSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ credentials: state }),
  });
  const athleteAdapter = createAthleteSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ athlete: state }),
  });
  const conversationAdapter = createConversationSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ conversation: state }),
  });
  const telegramAdapter = createTelegramSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ telegram: state }),
  });
  const sessionSettingsController = createSessionSettingsController({
    clients,
    beginMutation: () => store.getState().beginSettingsMutation("session"),
    view: conversationAdapter.view,
  });
  const refreshOnboardingCredentials = async (): Promise<void> => {
    await onboarding.refresh();
    if (store.getState().onboarding.loadUnavailable) throw new TypeError();
  };
  const credentialSettingsController = createCredentialSettingsController({
    clients,
    loadStatuses: () => window.enduragentAuth.credentialStatuses(),
    loadChatGptStatus: () => window.enduragentAuth.chatgptStatus(),
    loadRecoveryStatus: () => window.enduragentAuth.credentialRecoveryStatus(),
    retryCredentialRecovery: () => window.enduragentAuth.retryCredentialRecovery(),
    resetAllCredentials: () => window.enduragentAuth.resetAllCredentials(),
    loadClaudeCliStatus: () => window.enduragentAuth.claudeCliStatus(),
    deleteCredential: (value) => window.enduragentAuth.deleteCredential(value),
    openSetup: openSetupFromSettings,
    onDeleted: refreshOnboardingCredentials,
    onReconciled: refreshOnboardingCredentials,
    credentialMutationsBlocked: () =>
      onboardingCredentialMutationActive(store.getState().onboarding),
    beginMutation: () => store.getState().beginSettingsMutation("credential"),
    view: credentialAdapter.view,
  });
  const athleteSettingsController = createAthleteSettingsController({
    clients,
    openSetup: openSetupFromSettings,
    beginMutation: () => store.getState().beginSettingsMutation("athlete"),
    view: athleteAdapter.view,
  });
  const providerModelSettingsController = createProviderModelSettingsController({
    load: () => window.enduragentAuth.llmConfiguration(),
    apply: (selection) => window.enduragentAuth.applyLlmSelection(selection),
    openSetup: openSetupFromSettings,
    beginMutation: () => store.getState().beginSettingsMutation("provider-model"),
    codexAgentSupported: platform.capabilities.codexAgent,
    view: coachAdapter.view,
  });
  const telegramSettingsController = createTelegramSettingsController({
    bridge: {
      status: () => window.enduragentAuth.telegramStatus(),
      pasteTokenFromClipboard: () => window.enduragentAuth.pasteTelegramTokenFromClipboard(),
      enable: () => window.enduragentAuth.enableTelegram(),
      disable: () => window.enduragentAuth.disableTelegram(),
      remove: () => window.enduragentAuth.removeTelegram(),
      reconcile: () => window.enduragentAuth.reconcileTelegram(),
      removeWebhook: () => window.enduragentAuth.removeTelegramWebhook(),
      beginPairing: () => window.enduragentAuth.beginTelegramPairing(),
      cancelPairing: () => window.enduragentAuth.cancelTelegramPairing(),
      acknowledgeGapWarning: () => window.enduragentAuth.acknowledgeTelegramGapWarning(),
      listAllowedSenders: () => window.enduragentAuth.listTelegramAllowedSenders(),
      addAllowedSender: (senderId) => window.enduragentAuth.addTelegramAllowedSender({ senderId }),
      removeAllowedSender: (senderId) =>
        window.enduragentAuth.removeTelegramAllowedSender({ senderId }),
    },
    beginMutation: () => store.getState().beginSettingsMutation("telegram"),
    view: telegramAdapter.view,
  });
  store.getState().bindSettingsPorts({
    panes: {
      activate() {
        void providerModelSettingsController.activate();
        void credentialSettingsController.activate();
        void athleteSettingsController.activate();
        void sessionSettingsController.activate();
      },
      close: closePanes,
    },
    coach: coachAdapter.port,
    credentials: credentialAdapter.port,
    athlete: athleteAdapter.port,
    conversation: conversationAdapter.port,
    telegram: telegramAdapter.port,
    spend: spendAdapter.port,
    update: updateAdapter.port,
    units: {
      set: (value) => void trainingContextController.setUnitsPreference(value),
    },
    openSetup: openSetupFromSettings,
  });
  const disposeDroppedRideImports = subscribeToDroppedRideImports({
    subscribe: onboardingBridge.onDroppedImportFiles,
    onboarding,
    resident: {
      importDroppedFiles: (paths) => void rideImports.importPaths("resident", paths),
    },
  });

  void trainingContextController.start();
  spendController.start();
  void telegramSettingsController.activate();
  void chatController.start();
  settleInitialSetupStatus({
    captureGeneration: () =>
      window.enduragentAuth.getDaemonConnection().then((connection) => connection.generation),
    open: () => onboarding.open(),
    markSettled: () => store.getState().setOnboardingStartupSettled(true),
    reportSettled: (generation) => window.enduragentAuth.initialSetupStatusSettled({ generation }),
    reportFailure: () => console.error("desktop-initial-setup-settled-report-failure"),
  });
  void clients.getClient().then(
    () => {
      document.documentElement.dataset.rpc = "connected";
    },
    () => {
      document.documentElement.dataset.rpc = "failed";
    },
  );

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    store.getState().bindChatActions(null);
    store.getState().bindArchiveActions(null);
    store.getState().bindSettingsPorts(null);
    store.getState().bindSyncActions(null);
    store.getState().bindRideImportActions(null);
    store.getState().bindRideAnalysisActions(null);
    store.getState().bindTrainingExportActions(null);
    store.getState().bindOnboardingActions(null);
    disposeRideAnalysisSelection();
    disposeSetupReadiness();
    window.removeEventListener("enduragent-lifecycle", onLifecycle);
    window.removeEventListener("pagehide", dispose);
    desktopUpdateController.dispose();
    providerModelSettingsController.dispose();
    credentialSettingsController.dispose();
    athleteSettingsController.dispose();
    sessionSettingsController.dispose();
    telegramSettingsController.dispose();
    disposeDroppedRideImports();
    onboarding.dispose();
    onboardingAdapter.dispose();
    rideImportAdapter.dispose();
    firstSyncController.dispose();
    manualSyncController.dispose();
    trainingSyncCoordinator.dispose();
    chatController.dispose();
    archiveController.dispose();
    spendController.dispose();
    trainingContextController.dispose();
    rideAnalysisController.dispose();
    void clients.close();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
