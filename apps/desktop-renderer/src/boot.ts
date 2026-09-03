import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
} from "@enduragent/coach-client";
import { SaveIntakeRpcParamsSchema } from "@enduragent/coach-contract";
import { flushSync } from "react-dom";
import { createArchiveController } from "./archive/controller";
import { createRideAnalysisController } from "./activity-analysis/controller";
import { createChatController } from "./chat/controller";
import { createDesktopCoachClientProvider } from "./coach-client";
import { createFirstSyncController } from "./first-sync";
import { createArchiveViewAdapter } from "./state/adapters/archive";
import { createChatViewAdapter } from "./state/adapters/chat";
import { createFirstSyncViewAdapter } from "./state/adapters/first-sync";
import { createOnboardingViewAdapter } from "./state/adapters/onboarding";
import { createPlanViewAdapter } from "./state/adapters/plan";
import { createRideImportAdapter } from "./state/adapters/ride-import";
import {
  createAthleteSettingsAdapter,
  createConversationSettingsAdapter,
  createCoachSettingsAdapter,
  createCredentialSettingsAdapter,
} from "./state/adapters/settings";
import { createSpendSettingsAdapter } from "./state/adapters/spend";
import { createTelegramSettingsAdapter } from "./state/adapters/telegram";
import { createManualSyncViewAdapter } from "./state/adapters/sync";
import { createTrainingViewAdapter } from "./state/adapters/training";
import { createUpdateSettingsAdapter } from "./state/adapters/update";
import { credentialDrafts } from "./state/credential-drafts";
import { restoreManualSyncFocus } from "./state/manual-sync-focus";
import { useEnduragentStore, type EnduragentState } from "./state/store";
import { setupReady, setupSurfaceOnScreen } from "./state/onboarding-slice";
import { nonTelegramSettingsMutationActive } from "./state/settings-slice";
import { validateImportPaths, type OnboardingBridge } from "./onboarding/bridge";
import { createOnboardingCompletionController } from "./onboarding/completion";
import {
  createOnboardingController,
  onboardingCredentialMutationActive,
} from "./onboarding/controller";
import { rendererPlatformProjection } from "./platform-copy";
import { createTrainingContextController } from "./training-context/controller";
import { createManualSyncController } from "./training-context/manual-sync";
import { createTrainingSyncCoordinator } from "./training-sync";
import { createSpendMeterController } from "./spend-meter/controller";
import { createDesktopUpdateController } from "./update/controller";
import { createProviderModelSettingsController } from "./settings/provider-model-controller";
import { createAthleteSettingsController } from "./settings/athlete-controller";
import { createSessionSettingsController } from "./settings/session-controller";
import { createTelegramSettingsController } from "./settings/telegram-controller";
import {
  credentialChangesBlocked,
  createCredentialSettingsController,
} from "./settings/credential-controller";
import { createRideImportController, subscribeToDroppedRideImports } from "./ride-import";
import { createTrainingExportController } from "./training-export/controller";
import { settleInitialSetupStatus } from "./initial-setup-status";
import { createPlanController } from "./plan/controller";

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
    start: () => {
      void rideAnalysisController.start();
    },
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
  const planController = createPlanController({
    read: () => window.enduragentAuth.getPlanningReadModel(),
    render: (next) => store.getState().setPlanSurface(next),
    navigate: (view) => store.getState().setActiveView(view),
    focus: (target, returnToChat) => store.getState().setPlanFocus(target, returnToChat),
  });
  const trainingSyncCoordinator = createTrainingSyncCoordinator({
    clients,
    refreshTrainingContext: async () => {
      rideAnalysisController.invalidate();
      await Promise.all([trainingContextController.refresh(), planController.refresh()]);
    },
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
  let activePlanAdapter: ReturnType<typeof createPlanViewAdapter> | null = null;
  const chatController = createChatController({
    clients,
    view: chatAdapter.view,
    refreshTrainingContext: async () => {
      await Promise.all([trainingContextController.refresh(), planController.refresh()]);
    },
    refreshSpend: () => spendController.refresh(),
    readTranscriptPage: (request) => window.enduragentAuth.getTranscriptPage(request),
    canChat: () => setupReady(store.getState()),
    nativeAttachments: {
      choose: () => window.enduragentAuth.chooseChatAttachments(),
      paste: () => window.enduragentAuth.pasteChatAttachment(),
    },
    openPlanningRequest: (chatId, requestId) => {
      store.getState().setActiveView("plan");
      activePlanAdapter?.openChatRequest(chatId, requestId);
    },
  });
  const disposeSetupReadiness = store.subscribe((state, previousState) => {
    if (!setupReady(previousState) && setupReady(state)) void chatController.resume();
  });
  const disposePlanToChatRefresh = store.subscribe((state, previousState) => {
    if (previousState.activeView === "plan" && state.activeView === "chat") {
      chatController.refreshPlanningRequests();
    }
  });

  const planAdapter = createPlanViewAdapter({
    bridge: window.enduragentAuth,
    clients,
    read: () => store.getState().plan,
    publishHydration: (next) => store.getState().setPlanHydration(next),
    publishTransition: (next) => store.getState().setPlanTransition(next),
    publishCoach: (next) => store.getState().setPlanCoach(next),
    publishDiscardConfirmation: (open) => store.getState().setPlanDiscardConfirmation(open),
    publishRevisionComposer: (open) => store.getState().setPlanRevisionComposer(open),
    publishCoursePicker: (open) => store.getState().setPlanCoursePicker(open),
    publishDatePicker: (open) => store.getState().setPlanDatePicker(open),
    publishSettingPending: (next) => store.getState().setPlanSettingPending(next),
  });
  activePlanAdapter = planAdapter;
  store.getState().bindPlanningReadActions({
    refresh: () => void planController.refresh(),
    openFromChat: (target) => {
      planController.openFromChat(target);
      planAdapter.open();
      if (target.focus === "workout" && target.entityId !== null) {
        planAdapter.openWorkout(target.entityId);
      }
    },
    backToChat: () => planController.backToChat(),
    returnToChatRequest: (requestId) => {
      chatController.focusPlanningRequest(requestId);
      planController.backToChat();
    },
  });
  store.getState().bindPlanActions({
    open: () => planAdapter.open(),
    startPlan: () => planAdapter.startPlan(),
    closeCoach: () => planAdapter.closeCoach(),
    submitCoach: (message) => planAdapter.submitCoach(message),
    stopCoach: () => planAdapter.stopCoach(),
    removeQueuedCoachMessage: (id) => planAdapter.removeQueuedCoachMessage(id),
    retryQueuedCoachTurn: (claimId) => planAdapter.retryQueuedCoachTurn(claimId),
    answerCoachDecision: (decisionId, answer) =>
      planAdapter.answerCoachDecision(decisionId, answer),
    skipCoachDecision: (decisionId) => planAdapter.skipCoachDecision(decisionId),
    saveFtp: (watts) => planAdapter.saveFtp(watts),
    refreshFtp: () => planAdapter.refreshFtp(),
    backToCoachInterview: () => planAdapter.backToCoachInterview(),
    createDraft: () => planAdapter.createDraft(),
    updateDraft: (message) => planAdapter.updateDraft(message),
    openDiscardConfirmation: () => planAdapter.openDiscardConfirmation(),
    closeDiscardConfirmation: () => planAdapter.closeDiscardConfirmation(),
    discardDraft: () => planAdapter.discardDraft(),
    openRevisionComposer: () => planAdapter.openRevisionComposer(),
    closeRevisionComposer: () => planAdapter.closeRevisionComposer(),
    openCoursePicker: () => planAdapter.openCoursePicker(),
    closeCoursePicker: () => planAdapter.closeCoursePicker(),
    chooseCourseFile: () => planAdapter.chooseCourseFile(),
    continueWithoutCourse: () => planAdapter.continueWithoutCourse(),
    useCourseWithoutElevation: () => planAdapter.useCourseWithoutElevation(),
    removeCourse: () => planAdapter.removeCourse(),
    openDatePicker: () => planAdapter.openDatePicker(),
    closeDatePicker: () => planAdapter.closeDatePicker(),
    recalculateStartDate: (startDate) => planAdapter.recalculateStartDate(startDate),
    approveDraft: () => planAdapter.approveDraft(),
    openReplacement: () => planAdapter.openReplacement(),
    closeReplacementConfirmation: () => planAdapter.closeReplacementConfirmation(),
    confirmReplacement: () => planAdapter.confirmReplacement(),
    retryReplacementCleanup: () => planAdapter.retryReplacementCleanup(),
    verifyReplacementCleanup: () => planAdapter.verifyReplacementCleanup(),
    writeReplacementMirror: () => planAdapter.writeReplacementMirror(),
    openReplacementActivePlan: () => planAdapter.openReplacementActivePlan(),
    reconcilePlan: () => planAdapter.reconcilePlan(),
    verifyReconciliation: () => planAdapter.verifyReconciliation(),
    openSeason: () => planAdapter.openSeason(),
    closeSeason: () => planAdapter.closeSeason(),
    openRaceWeek: () => planAdapter.openRaceWeek(),
    closeRaceWeek: () => planAdapter.closeRaceWeek(),
    openReadiness: () => planAdapter.openReadiness(),
    closeReadiness: () => planAdapter.closeReadiness(),
    refreshReadiness: () => planAdapter.refreshReadiness(),
    openWorkout: (workoutId) => planAdapter.openWorkout(workoutId),
    closeWorkout: () => planAdapter.closeWorkout(),
    resolveWorkoutMatch: (workoutId, activityId, decision) =>
      planAdapter.resolveWorkoutMatch(workoutId, activityId, decision),
    resolveWorkoutDrift: (workoutId, eventId, decision) =>
      planAdapter.resolveWorkoutDrift(workoutId, eventId, decision),
    openProposal: (proposalId) => planAdapter.openProposal(proposalId),
    closeProposal: () => planAdapter.closeProposal(),
    reviseProposal: (proposalId, text) => planAdapter.reviseProposal(proposalId, text),
    approveProposal: (proposalId, expectedRevision) =>
      planAdapter.approveProposal(proposalId, expectedRevision),
    rejectProposal: (proposalId) => planAdapter.rejectProposal(proposalId),
    resolvePlanningRequestDate: (requestId, resolution) =>
      planAdapter.resolvePlanningRequestDate(requestId, resolution),
    openHistory: () => planAdapter.openHistory(),
    closeHistory: () => planAdapter.closeHistory(),
    undoPlanChange: (ledgerId) => planAdapter.undoPlanChange(ledgerId),
    openPlanSettings: () => planAdapter.openPlanSettings(),
    closePlanSettings: () => planAdapter.closePlanSettings(),
    setPlanSetting: (setting, value) => planAdapter.setPlanSetting(setting, value),
    openEndConfirmation: () => planAdapter.openEndConfirmation(),
    closeEndConfirmation: () => planAdapter.closeEndConfirmation(),
    confirmEndPlan: () => planAdapter.confirmEndPlan(),
    retryPlanCleanup: () => planAdapter.retryPlanCleanup(),
    verifyPlanCleanup: () => planAdapter.verifyPlanCleanup(),
    openRaceOutcome: () => planAdapter.openRaceOutcome(),
    recordRaceOutcome: (outcome) => planAdapter.recordRaceOutcome(outcome),
    openEndedConversation: () => planAdapter.openEndedConversation(),
    closeEndedConversation: () => planAdapter.closeEndedConversation(),
    openAttention: (attentionId) => planAdapter.openAttention(attentionId),
    returnToCoach: () => planAdapter.returnToCoach(),
    retry: () => planAdapter.retry(),
  });
  planAdapter.start();

  const archiveAdapter = createArchiveViewAdapter({
    publish: (next) => store.getState().setArchive(next),
  });
  const archiveController = createArchiveController({
    listConversations: () => window.enduragentAuth.listArchivedConversations(),
    readPage: (request) => window.enduragentAuth.getArchivedTranscriptPage(request),
    deleteConversation: (boundaryRef) =>
      window.enduragentAuth.deleteArchivedConversation(boundaryRef),
    view: archiveAdapter.view,
  });
  store.getState().bindArchiveActions({
    refresh: () => void archiveController.refresh(),
    open: (boundaryRef) => void archiveController.open(boundaryRef),
    close: () => archiveController.close(),
    loadEarlier: () => void archiveController.loadEarlier(),
    retry: () => void archiveController.retry(),
    requestDeletion: (boundaryRef) => archiveController.requestDeletion(boundaryRef),
    cancelDeletion: () => archiveController.cancelDeletion(),
    confirmDeletion: () => void archiveController.confirmDeletion(),
  });

  const firstSyncController = createFirstSyncController({
    coordinator: trainingSyncCoordinator,
    focusComposer,
    render: createFirstSyncViewAdapter({
      publish: (next) => store.getState().setFirstSync(next),
    }).render,
  });
  store.getState().bindChatActions({
    submit: (message, attachmentIds) => chatController.submit(message, attachmentIds),
    chooseAttachments: () => chatController.chooseAttachments(),
    pasteAttachment: () => chatController.pasteAttachment(),
    receiveAttachmentAdmissions: (results) => chatController.receiveAttachmentAdmissions(results),
    saveAttachmentDraftText: (text) => chatController.saveAttachmentDraftText(text),
    removeAttachment: (attachmentId) => chatController.removeAttachment(attachmentId),
    retryAttachment: (attachmentId) => chatController.retryAttachment(attachmentId),
    selectAttachmentWorkout: (attachmentId, workoutId) =>
      chatController.selectAttachmentWorkout(attachmentId, workoutId),
    reviewAttachmentInPlan: (attachmentId) => chatController.reviewAttachmentInPlan(attachmentId),
    continueMessageInPlan: (messageId, suggestion) =>
      chatController.continueMessageInPlan(messageId, suggestion),
    openPlanningRequest: (requestId) => chatController.openPlanningRequest(requestId),
    retryPlanningRequest: (requestId) => chatController.retryPlanningRequest(requestId),
    retryPlanningRequestLoad: () => chatController.retryPlanningRequestLoad(),
    clearPlanningRequestFocus: () => chatController.clearPlanningRequestFocus(),
    startPlanCreation: () => void chatController.startPlanCreation(),
    answerPlanCreation: (answer) => void chatController.answerPlanCreation(answer),
    stop: () => chatController.stop(),
    removeQueued: (id) => chatController.removeQueued(id),
    runQueuedCommand: (id) => void chatController.runQueuedCommand(id),
    retryQueuedTurn: (claimId) => void chatController.retryQueuedTurn(claimId),
    retry: () => void chatController.retryInterrupted(),
    loadEarlier: () => void chatController.loadEarlier(),
    retryHydration: () => void chatController.retryHydration(),
    retryDecision: () => void chatController.retryDecision(),
    openNewConversation: () => void chatController.openNewConversation(),
    cancelNewConversation: () => chatController.cancelNewConversation(),
    confirmNewConversation: () => void chatController.confirmNewConversation(),
    retryFirstSync: () => void firstSyncController.retry(),
    answerDecision: (decisionId, answer) => void chatController.answerDecision(decisionId, answer),
    skipDecision: (decisionId) => void chatController.skipDecision(decisionId),
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
    onSucceeded: () => {
      rideAnalysisController.invalidate();
      void trainingContextController.refresh();
    },
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
    onSaved: () => chatController.refreshAttachments(),
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
    credentialMutationsBlocked: () =>
      credentialChangesBlocked(store.getState().settings.credentials, false),
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
  const disposeDroppedChatAttachments = window.enduragentAuth.onDroppedChatAttachments((event) => {
    if (event.phase === "started") {
      return chatController.beginDroppedAttachmentAdmission(event.operationId);
    }
    chatController.settleDroppedAttachmentAdmission(event.operationId, event.results);
  });

  void trainingContextController.start();
  void planController.start();
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
    store.getState().bindPlanningReadActions(null);
    store.getState().bindPlanActions(null);
    store.getState().bindSettingsPorts(null);
    store.getState().bindSyncActions(null);
    store.getState().bindRideImportActions(null);
    store.getState().bindRideAnalysisActions(null);
    store.getState().bindTrainingExportActions(null);
    store.getState().bindOnboardingActions(null);
    disposeRideAnalysisSelection();
    disposeSetupReadiness();
    disposePlanToChatRefresh();
    window.removeEventListener("enduragent-lifecycle", onLifecycle);
    window.removeEventListener("pagehide", dispose);
    desktopUpdateController.dispose();
    providerModelSettingsController.dispose();
    credentialSettingsController.dispose();
    athleteSettingsController.dispose();
    sessionSettingsController.dispose();
    telegramSettingsController.dispose();
    disposeDroppedRideImports();
    disposeDroppedChatAttachments();
    onboarding.dispose();
    onboardingAdapter.dispose();
    rideImportAdapter.dispose();
    firstSyncController.dispose();
    manualSyncController.dispose();
    trainingSyncCoordinator.dispose();
    chatController.dispose();
    archiveController.dispose();
    planAdapter.dispose();
    spendController.dispose();
    trainingContextController.dispose();
    planController.dispose();
    rideAnalysisController.dispose();
    void clients.close();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
