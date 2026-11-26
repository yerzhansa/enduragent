import {
  createRideImportController,
  type RideImportController,
  type RideImportState,
} from "../ride-import";
import type {
  IntervalsCredentialMutationResult,
  OnboardingBridge,
  OnboardingCredentialWriteInput,
  OnboardingLlmConfiguration,
  OnboardingLlmEndpointSelection,
  OnboardingLlmSelection,
} from "./bridge";
import { CUSTOM_MODEL_SELECTION } from "./constants";
import {
  credentialSlotFor,
  credentialWriteRefusalError,
  handoffCredential,
  type CredentialDraftPort,
} from "./credentials";
import { intervalsMutationError, type IntervalsSignInSurface } from "./intervals-sign-in";
import {
  createOpenRouterSignIn,
  openRouterSignInBusy,
  type OpenRouterSignInActions,
  type OpenRouterSignInView,
} from "./openrouter-sign-in";
import type { SetupCommit } from "./lanes";
import {
  chatGptSignedIn,
  chatGptUiPhase,
  createOnboardingState,
  hasTrainingData,
  selectedProviderReady,
  toOnboardingCompletion,
  withBusy,
  withChatGptActivationPending,
  withChatGptActivationResult,
  withChatGptLoginResult,
  withChatGptPending,
  withChatGptProgress,
  withChatGptStatus,
  withClaudeCliStatus,
  withCredentialStatuses,
  withError,
  withImportedRideFileCount,
  type ChatGptUiPhase,
  type CredentialSlotStatus,
  type OnboardingCompletion,
  type OnboardingErrorCode,
  type OnboardingState,
} from "./machine";
import {
  draftForProvider,
  initialLlmDraft,
  llmSelectionFromDraft,
  type LlmSelectionDraft,
} from "./selection";
import { afterNextPaint, settleWithin } from "./timing";

export interface OnboardingReadiness {
  readonly provider: boolean;
  readonly trainingData: boolean;
}

export interface OnboardingSurfaceState {
  readonly open: boolean;
  readonly initialized: boolean;
  readonly loading: boolean;
  readonly loadUnavailable: boolean;
  readonly hasSuccessfulLoad: boolean;
  readonly completionRequired: boolean;
  readonly wizard: OnboardingState;
  readonly statuses: readonly CredentialSlotStatus[];
  readonly configuration: OnboardingLlmConfiguration | null;
  readonly draft: LlmSelectionDraft | null;
  readonly rideImport: RideImportState;
  readonly focusSeq: number;
  readonly readiness: OnboardingReadiness;
  readonly lastCommit: SetupCommit;
  readonly actionStatus: OnboardingActionStatus;
  readonly intervalsSignIn: IntervalsSignInSurface;
  readonly openRouter: OpenRouterSignInView;
}

export function onboardingCredentialMutationActive(surface: OnboardingSurfaceState): boolean {
  return (
    surface.loading ||
    surface.loadUnavailable ||
    surface.wizard.busy ||
    surface.wizard.chatGptLoginPhase !== "idle" ||
    surface.wizard.chatGptRuntimeState === "activating" ||
    openRouterSignInBusy(surface.openRouter) ||
    surface.rideImport.status === "running"
  );
}

export type OnboardingActionStatus =
  | "working"
  | Extract<
      ChatGptUiPhase,
      "waiting-for-browser" | "completing-sign-in" | "signed-in" | "activating-coach" | "ready"
    >
  | null;

export interface OnboardingView {
  render(surface: OnboardingSurfaceState): void;
}

export interface OnboardingActions {
  saveModelKey(): void;
  connectTrainingData(): void;
  cancelIntervalsSignIn(): void;
  reopenIntervalsSignIn(): void;
  readonly openRouter: OpenRouterSignInActions;
  finish(): void;
  dismiss(): void;
  retrySavedKeys(): void;
  startChatGptLogin(): void;
  cancelChatGptLogin(): void;
  retryChatGptActivation(): void;
  recheckClaudeCli(): void;
  chooseImportFiles(): void;
  selectProvider(provider: string): void;
  selectModel(model: string): void;
  setCustomModel(model: string): void;
  setEndpointMode(mode: string): void;
  setCustomEndpoint(endpoint: string): void;
}

export interface OnboardingController extends OnboardingActions {
  open(): Promise<void>;
  refresh(): Promise<void>;
  requireCompletion(): void;
  close(): void;
  dispose(): void;
  state(): OnboardingState;
  ownsDroppedImportFiles(): boolean;
  importDroppedFiles(paths: readonly string[]): void;
}

export interface OnboardingControllerOptions {
  readonly bridge: OnboardingBridge;
  readonly credentials: CredentialDraftPort;
  readonly view: OnboardingView;
  readonly rideImports?: RideImportController;
  readonly onRideImportPresentationChange?: (presenting: boolean) => void;
  readonly focusOpener?: () => void;
  readonly onComplete: (completion: OnboardingCompletion) => void;
  readonly onReady?: () => void;
  readonly onActiveSelectionChanged?: () => void;
  readonly ownsDroppedImportFiles?: () => boolean;
  readonly credentialMutationsBlocked?: () => boolean;
  readonly createOperationId?: () => string;
  readonly afterPaint?: (callback: () => void) => () => void;
  readonly codexAgentSupported?: boolean;
}

export const CHATGPT_PROGRESS_DETAIL_DELAY_MS = 3_000;
export const CHATGPT_ACTIVATION_TRANSPORT_TIMEOUT_MS = 12_000;
export const ONBOARDING_STATUS_REFRESH_TIMEOUT_MS = 3_000;
export const ONBOARDING_STATUS_COLD_START_TIMEOUT_MS = 8_000;
export const ONBOARDING_STATUS_LOAD_ATTEMPTS = 4;
export const ONBOARDING_STATUS_RETRY_BASE_DELAY_MS = 500;
export const ONBOARDING_STATUS_RETRY_MAX_DELAY_MS = 2_000;
export function onboardingStatusRetryDelayMs(attempt: number): number {
  const delay = ONBOARDING_STATUS_RETRY_BASE_DELAY_MS * 2 ** attempt;
  return delay > ONBOARDING_STATUS_RETRY_MAX_DELAY_MS
    ? ONBOARDING_STATUS_RETRY_MAX_DELAY_MS
    : delay;
}

export function setupStatusKnown(
  surface: Pick<OnboardingSurfaceState, "initialized" | "loadUnavailable">,
): boolean {
  return surface.initialized && !surface.loadUnavailable;
}

const ENDPOINT_MODES: readonly OnboardingLlmEndpointSelection["mode"][] = [
  "automatic",
  "default",
  "custom",
];

export function createOnboardingController(
  options: OnboardingControllerOptions,
): OnboardingController {
  const rideImports = options.rideImports ?? createRideImportController(options.bridge);
  let state = createOnboardingState();
  let rideImportState: RideImportState = rideImports.state();
  let credentialStatuses: readonly CredentialSlotStatus[] = [];
  let presenting = false;
  let initialized = false;
  let loading = false;
  let loadUnavailable = false;
  let completionRequired = false;
  let hasSuccessfulLoad = false;
  let durableTrainingData = false;
  let completed = false;
  let disposed = false;
  let opening = false;
  let visit = 0;
  let focusSeq = 0;
  let presentingRideImports = false;
  let llmConfiguration: OnboardingLlmConfiguration | undefined;
  let llmDraft: LlmSelectionDraft | undefined;
  let llmDrafts: Record<string, LlmSelectionDraft> = {};
  let lastCommit: SetupCommit = null;
  let actionStatus: OnboardingActionStatus = null;
  let intervalsSignIn: IntervalsSignInSurface = { phase: "idle", athleteName: null };
  let authGeneration = 0;
  let statusRefreshGeneration = 0;
  let progressDetailTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelScheduledActivation: (() => void) | undefined;
  let cancellingOperationId: string | undefined;

  const createOperationId = options.createOperationId ?? (() => crypto.randomUUID());
  const scheduleAfterPaint = options.afterPaint ?? afterNextPaint;
  const credentialMutationsBlocked = (): boolean => options.credentialMutationsBlocked?.() ?? false;
  const setupStatusBlocksMutations = (): boolean => loading || loadUnavailable;

  const selectedProviderIsReady = (): boolean => {
    const parsed = llmSelectionFromDraft(llmDraft);
    return parsed.error === null
      ? selectedProviderReady(state, parsed.selection, llmConfiguration?.active ?? null)
      : false;
  };

  const activeProviderIsReady = (): boolean => {
    const active = llmConfiguration?.active ?? null;
    if (active?.provider === "codex-agent" && options.codexAgentSupported === false) return false;
    if (active?.provider === "claude-cli" && state.claudeCliState === null) return true;
    return selectedProviderReady(state, active, active);
  };

  const currentReadiness = (): OnboardingReadiness => ({
    provider: activeProviderIsReady(),
    trainingData: durableTrainingData || hasTrainingData(state),
  });

  const publish = (): void => {
    const readiness = currentReadiness();
    options.view.render({
      open: presenting,
      initialized,
      loading,
      loadUnavailable,
      hasSuccessfulLoad,
      completionRequired,
      wizard: state,
      statuses: credentialStatuses,
      configuration: llmConfiguration ?? null,
      draft: llmDraft ?? null,
      rideImport: rideImportState,
      focusSeq,
      readiness,
      lastCommit,
      actionStatus,
      intervalsSignIn,
      openRouter: openRouter.view(),
    });
  };

  const clearProgressDetailTimer = (): void => {
    if (progressDetailTimer === undefined) return;
    clearTimeout(progressDetailTimer);
    progressDetailTimer = undefined;
  };

  const clearScheduledActivation = (): void => {
    cancelScheduledActivation?.();
    cancelScheduledActivation = undefined;
  };

  const cancelActiveChatGptLogin = (): void => {
    const operationId = state.chatGptOperationId;
    if (operationId === null || cancellingOperationId === operationId) return;
    cancellingOperationId = operationId;
    const clearCancellation = (): void => {
      if (cancellingOperationId === operationId) cancellingOperationId = undefined;
    };
    void options.bridge.cancelChatGptLogin(operationId).then(clearCancellation, clearCancellation);
  };

  const focusTitle = (): void => {
    focusSeq += 1;
  };

  const setLlmDraft = (next: LlmSelectionDraft | undefined): void => {
    llmDraft = next;
    if (next !== undefined) llmDrafts[next.provider.provider] = next;
  };

  const setRideImportPresentation = (next: boolean): void => {
    if (presentingRideImports === next) return;
    presentingRideImports = next;
    options.onRideImportPresentationChange?.(next);
  };

  const setFixedError = (fixedError: OnboardingErrorCode | null): void => {
    state = { ...state, fixedError };
    publish();
  };

  const recordActiveSelection = (selection: OnboardingLlmSelection): void => {
    if (llmConfiguration === undefined) return;
    llmConfiguration = {
      ...llmConfiguration,
      active: { provider: selection.provider, model: selection.model },
    };
    options.onActiveSelectionChanged?.();
  };

  const openRouter = createOpenRouterSignIn({
    bridge: options.bridge,
    createOperationId,
    publish,
    configuration: () => llmConfiguration,
    draft: () => llmDraft,
    canMutate: () =>
      presenting && !setupStatusBlocksMutations() && !state.busy && !credentialMutationsBlocked(),
    active: () =>
      llmConfiguration?.active?.provider === "openrouter" &&
      state.credentialStatus.openrouter === "configured",
    sync: async (selection) => {
      const syncVisit = visit;
      const refreshed = await refreshStatuses(syncVisit);
      if (refreshed && selection !== null) recordActiveSelection(selection);
      if (refreshed || selection === null || visit !== syncVisit || !presenting) return;
      lastCommit = "provider";
      state = { ...state, fixedError: "credential-status-unavailable" };
    },
    fail: setFixedError,
  });

  const cancelActiveIntervalsSignIn = (): void => {
    if (intervalsSignIn.phase !== "waiting-for-browser") return;
    void options.bridge.cancelIntervalsSignIn().catch(() => false);
  };

  const close = (): void => {
    cancelActiveChatGptLogin();
    cancelActiveIntervalsSignIn();
    openRouter.reset();
    clearProgressDetailTimer();
    clearScheduledActivation();
    authGeneration += 1;
    statusRefreshGeneration += 1;
    actionStatus = null;
    visit += 1;
    options.credentials.clear();
    presenting = false;
    setRideImportPresentation(false);
    publish();
    options.focusOpener?.();
  };

  const refreshStatuses = async (expectedVisit: number): Promise<boolean> => {
    const expectedAuthGeneration = authGeneration;
    const refreshGeneration = ++statusRefreshGeneration;
    const [statuses, chatGpt] = await Promise.all([
      settleWithin(options.bridge.credentialStatuses(), ONBOARDING_STATUS_REFRESH_TIMEOUT_MS),
      settleWithin(options.bridge.chatGptStatus(), ONBOARDING_STATUS_REFRESH_TIMEOUT_MS),
    ]);
    if (visit !== expectedVisit || !presenting || refreshGeneration !== statusRefreshGeneration) {
      return false;
    }
    if (statuses.status === "fulfilled") {
      credentialStatuses = statuses.value;
      state = withCredentialStatuses(state, statuses.value);
    }
    if (chatGpt.status === "fulfilled" && expectedAuthGeneration === authGeneration) {
      state = withChatGptStatus(state, chatGpt.value);
    }
    return statuses.status === "fulfilled";
  };

  const invalidateCredentialRuntimeStatus = (
    slot: OnboardingCredentialWriteInput["slot"],
  ): void => {
    const credentialRuntimeStatus = { ...state.credentialRuntimeStatus };
    credentialRuntimeStatus[slot] = null;
    state = { ...state, credentialRuntimeStatus };
    credentialStatuses = credentialStatuses.map((status) =>
      status.slot === slot ? { ...status, runtimeState: null } : status,
    );
  };

  const saveModelCredential = async (
    expectedVisit: number,
    slot: OnboardingCredentialWriteInput["slot"] | undefined,
    selection: OnboardingLlmSelection,
  ): Promise<{
    readonly error: OnboardingErrorCode | null;
    readonly selectedApplied: boolean;
  } | null> => {
    if (slot === undefined) return { error: null, selectedApplied: false };
    const input = options.credentials
      .harvest([slot])
      .find((candidate) => candidate.dataset.slot === slot);
    if (input === undefined) {
      return { error: null, selectedApplied: false };
    }
    if (visit !== expectedVisit || !presenting) return null;
    if (input.value.trim().length === 0) {
      input.value = "";
      return { error: null, selectedApplied: false };
    }
    const outcome: {
      failure: OnboardingErrorCode | null;
      selectedApplied: boolean;
    } = { failure: null, selectedApplied: false };
    let staleDraft = false;
    try {
      await handoffCredential(
        input,
        async (value) => {
          const result = await options.bridge.writeCredential(value);
          if (disposed || visit !== expectedVisit || !presenting) return;
          if (result.status === "configured") {
            if (result.runtimeReady) outcome.selectedApplied = true;
          } else {
            outcome.failure = credentialWriteRefusalError(result.reason);
            staleDraft = result.status === "stale-draft";
          }
        },
        selection,
      );
      if (disposed || visit !== expectedVisit || !presenting) return null;
    } catch {
      outcome.failure = "credential-save-failed";
    } finally {
      input.value = "";
    }
    if (disposed || visit !== expectedVisit || !presenting) return null;
    if (staleDraft) {
      return { error: "configuration-unavailable", selectedApplied: false };
    }
    const refreshed = await refreshStatuses(expectedVisit);
    if (disposed || visit !== expectedVisit || !presenting) return null;
    if (!refreshed) {
      invalidateCredentialRuntimeStatus(slot);
      return {
        error:
          outcome.failure === null || outcome.failure === "runtime-unavailable"
            ? "credential-status-unavailable"
            : outcome.failure,
        selectedApplied: outcome.selectedApplied,
      };
    }
    if (outcome.failure !== "runtime-unavailable") {
      return { error: outcome.failure, selectedApplied: outcome.selectedApplied };
    }
    const refreshedRuntimeStatus = credentialStatuses.find((entry) => entry.slot === slot);
    if (
      refreshedRuntimeStatus === undefined ||
      refreshedRuntimeStatus.state === "missing" ||
      refreshedRuntimeStatus.state === "re-prompt"
    ) {
      return { error: "credential-reenter-required", selectedApplied: outcome.selectedApplied };
    }
    if (refreshedRuntimeStatus.runtimeState === "failed") {
      return { error: "runtime-unavailable", selectedApplied: outcome.selectedApplied };
    }
    return { error: null, selectedApplied: outcome.selectedApplied };
  };

  const saveModelKey = async (): Promise<void> => {
    if (
      disposed ||
      !presenting ||
      setupStatusBlocksMutations() ||
      state.busy ||
      credentialMutationsBlocked()
    ) {
      return;
    }
    const submitVisit = visit;
    lastCommit = "provider";
    actionStatus = null;
    state = withBusy(state, true);
    publish();
    const parsedSelection = llmSelectionFromDraft(llmDraft);
    if (parsedSelection.error !== null) {
      state = withError(state, parsedSelection.error);
      focusTitle();
      publish();
      return;
    }
    const slot = credentialSlotFor(parsedSelection.selection.provider);
    const saved = await saveModelCredential(submitVisit, slot, parsedSelection.selection);
    if (visit !== submitVisit || !presenting) return;
    if (saved === null) return;
    let saveError = saved.error;
    if (saveError === "runtime-unavailable") saveError = "model-runtime-unavailable";
    if (saveError === null && saved.selectedApplied) {
      recordActiveSelection(parsedSelection.selection);
    } else if (saveError === null) {
      try {
        const applied = await options.bridge.applyLlmSelection(parsedSelection.selection);
        if (visit !== submitVisit || !presenting) return;
        if (applied.status === "stale-draft") {
          saveError = "configuration-unavailable";
        } else if (applied.status === "refused") {
          saveError =
            applied.reason === "credential-required"
              ? "credential-required"
              : applied.reason === "runtime-unavailable"
                ? "model-runtime-unavailable"
                : "invalid-input";
        } else {
          if (!(await refreshStatuses(submitVisit))) {
            saveError = "credential-status-unavailable";
          } else {
            recordActiveSelection(parsedSelection.selection);
          }
        }
      } catch {
        if (visit !== submitVisit || !presenting) return;
        saveError = "model-runtime-unavailable";
      }
    }
    state = withBusy(state, false);
    if (saveError !== null) state = withError(state, saveError);
    else if (!selectedProviderIsReady()) state = withError(state, "model-runtime-unavailable");
    else if (parsedSelection.selection.provider === "openrouter") openRouter.connectedByKey();
    focusTitle();
    publish();
  };

  const checkClaudeCliForSelection = (forceRecheck: boolean): void => {
    if (disposed || !presenting || setupStatusBlocksMutations() || state.busy) return;
    const expectedVisit = visit;
    actionStatus = null;
    state = withBusy(state, true);
    publish();
    const request = forceRecheck
      ? options.bridge.claudeCliRecheck()
      : options.bridge.claudeCliStatus();
    void request.then(
      (status) => {
        if (disposed || visit !== expectedVisit || !presenting) return;
        state = withBusy(withClaudeCliStatus(state, status), false);
        publish();
        const ready = status.state === "ready" || status.state === "ready-api-key";
        if (ready && llmDraft?.provider.provider === "claude-cli" && !selectedProviderIsReady()) {
          void saveModelKey();
        }
      },
      () => {
        if (disposed || visit !== expectedVisit || !presenting) return;
        state = withBusy(state, false);
        publish();
      },
    );
  };

  const connectTrainingData = async (): Promise<void> => {
    if (
      disposed ||
      !presenting ||
      setupStatusBlocksMutations() ||
      state.busy ||
      rideImports.isBusy() ||
      credentialMutationsBlocked()
    ) {
      return;
    }
    const submitVisit = visit;
    lastCommit = "training";
    actionStatus = null;
    state = withBusy(state, true);
    intervalsSignIn = { ...intervalsSignIn, phase: "waiting-for-browser" };
    publish();
    let result: IntervalsCredentialMutationResult;
    try {
      result = await options.bridge.signInWithIntervals();
    } catch {
      intervalsSignIn = { ...intervalsSignIn, phase: "idle" };
      if (disposed) return;
      const current = visit === submitVisit && presenting;
      state = withBusy(state, false);
      if (current) state = withError(state, "intervals-validation-unavailable");
      publish();
      return;
    }
    intervalsSignIn = {
      phase: "idle",
      athleteName:
        result.outcome === "applied" ? (result.athleteName ?? null) : intervalsSignIn.athleteName,
    };
    if (disposed) return;
    credentialStatuses = [
      ...credentialStatuses.filter((entry) => entry.slot !== "intervals-icu"),
      result.current,
    ];
    state = withBusy(withCredentialStatuses(state, credentialStatuses), false);
    const saveError = visit === submitVisit && presenting ? intervalsMutationError(result) : null;
    if (saveError !== null) state = withError(state, saveError);
    publish();
  };

  const walkGates = (): OnboardingErrorCode | null => {
    const readiness = currentReadiness();
    if (!readiness.provider) return "credential-required";
    if (!readiness.trainingData) return "training-data-required";
    return null;
  };

  const finishSetup = async (): Promise<void> => {
    if (
      disposed ||
      !presenting ||
      setupStatusBlocksMutations() ||
      state.busy ||
      rideImports.isBusy() ||
      credentialMutationsBlocked()
    ) {
      return;
    }
    const gateError = walkGates();
    if (gateError !== null) {
      state = withError(state, gateError);
      focusTitle();
      publish();
      return;
    }
    actionStatus = null;
    state = { ...state, fixedError: null };
    if (completed) {
      publish();
      return;
    }
    completed = true;
    completionRequired = false;
    publish();
    options.onComplete(toOnboardingCompletion(state));
    options.onReady?.();
  };

  const beginChatGptActivation = (
    selection: OnboardingLlmSelection,
    expectedVisit: number,
  ): void => {
    if (
      disposed ||
      visit !== expectedVisit ||
      !presenting ||
      setupStatusBlocksMutations() ||
      credentialMutationsBlocked() ||
      !chatGptSignedIn(state) ||
      state.chatGptRuntimeState === "activating"
    ) {
      return;
    }
    clearScheduledActivation();
    const activationGeneration = ++authGeneration;
    state = withChatGptActivationPending(state);
    actionStatus = "activating-coach";
    publish();
    void settleWithin(
      options.bridge.applyLlmSelection(selection),
      CHATGPT_ACTIVATION_TRANSPORT_TIMEOUT_MS,
    ).then((result) => {
      if (
        disposed ||
        visit !== expectedVisit ||
        !presenting ||
        activationGeneration !== authGeneration ||
        state.chatGptRuntimeState !== "activating"
      ) {
        return;
      }
      authGeneration += 1;
      const ready = result.status === "fulfilled" && result.value.status === "configured";
      state = withChatGptActivationResult(state, ready);
      if (ready) {
        recordActiveSelection(selection);
        actionStatus = "ready";
      } else {
        if (result.status === "fulfilled" && result.value.status === "stale-draft") {
          state = { ...state, fixedError: "configuration-unavailable" };
        }
        actionStatus = null;
      }
      focusTitle();
      publish();
    });
  };

  const scheduleChatGptActivation = (
    selection: OnboardingLlmSelection,
    expectedVisit: number,
  ): void => {
    clearScheduledActivation();
    cancelScheduledActivation = scheduleAfterPaint(() => {
      cancelScheduledActivation = undefined;
      beginChatGptActivation(selection, expectedVisit);
    });
  };

  const disposeIntervalsProgress = options.bridge.onIntervalsSignInProgress((phase) => {
    if (disposed || intervalsSignIn.phase === "idle" || intervalsSignIn.phase === phase) return;
    intervalsSignIn = { ...intervalsSignIn, phase };
    publish();
  });

  const disposeChatGptProgress = options.bridge.onChatGptLoginProgress((progress) => {
    if (
      disposed ||
      !presenting ||
      state.chatGptOperationId !== progress.operationId ||
      state.chatGptLoginPhase === "idle"
    ) {
      return;
    }
    const previous = state;
    state = withChatGptProgress(state, progress);
    if (state === previous) return;
    if (progress.phase === "completing-sign-in") {
      clearProgressDetailTimer();
      actionStatus = "completing-sign-in";
    } else if (actionStatus !== "working") {
      actionStatus = "waiting-for-browser";
    }
    publish();
  });

  const disposeImportState = rideImports.subscribe((next) => {
    rideImportState = next;
    if (next.status === "succeeded") {
      state = withImportedRideFileCount(state, rideImports.importedFileCount());
      if (next.result.files.imported > 0) durableTrainingData = true;
    } else if (next.status === "running" && next.owner === "onboarding") {
      state = { ...state, fixedError: null };
    }
    publish();
  });

  const load = async (hydrate: boolean, retryWhileStarting: boolean): Promise<void> => {
    if (disposed || opening) return;
    const currentDraft = llmDraft;
    const currentDrafts = llmDrafts;
    const hydrateAuthoritativeState = hydrate || !hasSuccessfulLoad;
    opening = true;
    presenting = true;
    loading = true;
    publish();
    const openVisit = ++visit;
    authGeneration += 1;
    statusRefreshGeneration += 1;
    clearProgressDetailTimer();
    clearScheduledActivation();
    completed = false;
    lastCommit = null;
    actionStatus = null;
    const finishUnavailableLoad = (): void => {
      loadUnavailable = true;
      state = withImportedRideFileCount(state, rideImports.importedFileCount());
      initialized = true;
      loading = false;
      setRideImportPresentation(true);
      focusTitle();
      publish();
      opening = false;
    };
    const coldStart = retryWhileStarting && !hasSuccessfulLoad;
    const attemptTimeoutMs = coldStart
      ? ONBOARDING_STATUS_COLD_START_TIMEOUT_MS
      : ONBOARDING_STATUS_REFRESH_TIMEOUT_MS;
    const maxAttempts = coldStart ? ONBOARDING_STATUS_LOAD_ATTEMPTS : 1;
    const readAuthoritativeStatus = () =>
      Promise.all([
        settleWithin(options.bridge.credentialStatuses(), attemptTimeoutMs),
        settleWithin(options.bridge.chatGptStatus(), attemptTimeoutMs),
        settleWithin(options.bridge.llmConfiguration(), attemptTimeoutMs),
        settleWithin(
          options.bridge.getSetupStatus?.() ??
            Promise.resolve({
              schemaVersion: 1 as const,
              durableTrainingData: false,
            }),
          attemptTimeoutMs,
        ),
      ]);
    let read = await readAuthoritativeStatus();
    let attempt = 0;
    while (
      read.some((entry) => entry.status !== "fulfilled") &&
      attempt + 1 < maxAttempts &&
      !disposed &&
      visit === openVisit
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, onboardingStatusRetryDelayMs(attempt));
      });
      if (disposed || visit !== openVisit) break;
      attempt += 1;
      read = await readAuthoritativeStatus();
    }
    const [statusesResult, chatGptResult, configurationResult, setupResult] = read;
    if (disposed || visit !== openVisit) {
      opening = false;
      return;
    }
    if (
      statusesResult.status !== "fulfilled" ||
      chatGptResult.status !== "fulfilled" ||
      configurationResult.status !== "fulfilled" ||
      setupResult.status !== "fulfilled"
    ) {
      finishUnavailableLoad();
      return;
    }
    const statuses = statusesResult.value;
    const restoredChatGptStatus = chatGptResult.value;
    if (hydrateAuthoritativeState) {
      llmConfiguration = configurationResult.value;
      llmDrafts = {};
      setLlmDraft(initialLlmDraft(llmConfiguration, statuses, restoredChatGptStatus));
    } else {
      llmDrafts = currentDrafts;
      setLlmDraft(currentDraft);
    }
    credentialStatuses = statuses;
    state = withBusy(
      createOnboardingState(statuses, restoredChatGptStatus),
      intervalsSignIn.phase !== "idle",
    );
    durableTrainingData = setupResult.value.durableTrainingData;
    const readiness = currentReadiness();
    if (!readiness.provider || !readiness.trainingData) {
      completionRequired = true;
    }
    if (chatGptUiPhase(state) === "signed-in") {
      actionStatus = "signed-in";
    }
    if (llmDraft === undefined) state = withError(state, "configuration-unavailable");
    state = withImportedRideFileCount(state, rideImports.importedFileCount());
    loadUnavailable = false;
    hasSuccessfulLoad = true;
    initialized = true;
    loading = false;
    setRideImportPresentation(true);
    focusTitle();
    publish();
    openRouter.refreshCredit();
    opening = false;
  };

  return {
    open(): Promise<void> {
      if (disposed || presenting || opening) return Promise.resolve();
      return load(true, true);
    },
    refresh(): Promise<void> {
      if (disposed || opening) return Promise.resolve();
      return load(false, false);
    },
    requireCompletion(): void {
      if (disposed || completionRequired) return;
      completionRequired = true;
      publish();
    },
    close,
    dispose(): void {
      cancelActiveChatGptLogin();
      cancelActiveIntervalsSignIn();
      openRouter.dispose();
      clearProgressDetailTimer();
      clearScheduledActivation();
      disposed = true;
      authGeneration += 1;
      statusRefreshGeneration += 1;
      visit += 1;
      actionStatus = null;
      options.credentials.clear();
      presenting = false;
      setRideImportPresentation(false);
      publish();
      disposeChatGptProgress();
      disposeIntervalsProgress();
      disposeImportState();
    },
    state: () => state,
    ownsDroppedImportFiles: () =>
      !disposed &&
      presenting &&
      !setupStatusBlocksMutations() &&
      !credentialMutationsBlocked() &&
      (options.ownsDroppedImportFiles?.() ?? true),
    importDroppedFiles(paths) {
      if (
        !disposed &&
        presenting &&
        !setupStatusBlocksMutations() &&
        !state.busy &&
        !rideImports.isBusy() &&
        !credentialMutationsBlocked()
      ) {
        void rideImports.importPaths("onboarding", paths);
      }
    },
    saveModelKey(): void {
      void saveModelKey();
    },
    connectTrainingData(): void {
      void connectTrainingData();
    },
    cancelIntervalsSignIn(): void {
      if (!disposed) cancelActiveIntervalsSignIn();
    },
    reopenIntervalsSignIn(): void {
      if (disposed || intervalsSignIn.phase !== "waiting-for-browser") return;
      void options.bridge.reopenIntervalsSignIn().catch(() => false);
    },
    openRouter: openRouter.actions,
    finish(): void {
      void finishSetup();
    },
    dismiss: close,
    retrySavedKeys(): void {
      if (
        disposed ||
        !presenting ||
        setupStatusBlocksMutations() ||
        state.busy ||
        credentialMutationsBlocked()
      ) {
        return;
      }
      const retryVisit = visit;
      const retryAuthGeneration = authGeneration;
      lastCommit = "training";
      actionStatus = null;
      state = withBusy(state, true);
      focusTitle();
      publish();
      void (async () => {
        try {
          const statuses = await options.bridge.retryFailedCredentials();
          if (visit !== retryVisit || !presenting) return;
          let nextState = withCredentialStatuses(state, statuses);
          const chatGpt = await settleWithin(
            options.bridge.chatGptStatus(),
            ONBOARDING_STATUS_REFRESH_TIMEOUT_MS,
          );
          if (chatGpt.status === "fulfilled" && retryAuthGeneration === authGeneration) {
            nextState = withChatGptStatus(nextState, chatGpt.value);
          }
          if (visit !== retryVisit || !presenting) return;
          credentialStatuses = statuses;
          state = withBusy(nextState, false);
          focusTitle();
          publish();
        } catch {
          if (visit !== retryVisit || !presenting) return;
          state = withError(state, "runtime-unavailable");
          focusTitle();
          publish();
        }
      })();
    },
    startChatGptLogin(): void {
      if (
        disposed ||
        !presenting ||
        setupStatusBlocksMutations() ||
        state.busy ||
        credentialMutationsBlocked() ||
        state.chatGptLoginPhase !== "idle" ||
        state.chatGptRuntimeState === "activating"
      ) {
        return;
      }
      if (chatGptSignedIn(state)) {
        const parsed = llmSelectionFromDraft(llmDraft);
        if (parsed.error === null && parsed.selection.provider === "openai-codex") {
          beginChatGptActivation(parsed.selection, visit);
        }
        return;
      }
      if (llmDraft?.provider.provider !== "openai-codex") {
        const configuration = llmConfiguration;
        const chatGpt = configuration?.providers.find(
          (provider) => provider.provider === "openai-codex",
        );
        if (chatGpt === undefined || configuration === undefined) {
          setFixedError("configuration-unavailable");
          return;
        }
        setLlmDraft(
          llmDrafts[chatGpt.provider] ?? draftForProvider(chatGpt, configuration.catalogRevision),
        );
      }
      const parsedSelection = llmSelectionFromDraft(llmDraft);
      if (parsedSelection.error !== null) {
        setFixedError(parsedSelection.error);
        return;
      }
      const loginVisit = visit;
      const operationId = createOperationId();
      authGeneration += 1;
      state = withChatGptPending(state, operationId);
      actionStatus = "working";
      clearProgressDetailTimer();
      progressDetailTimer = setTimeout(() => {
        progressDetailTimer = undefined;
        if (
          disposed ||
          visit !== loginVisit ||
          !presenting ||
          state.chatGptOperationId !== operationId ||
          state.chatGptLoginPhase === "idle"
        ) {
          return;
        }
        actionStatus = state.chatGptLoginPhase;
        publish();
      }, CHATGPT_PROGRESS_DETAIL_DELAY_MS);
      publish();
      void options.bridge.chatGptLogin({ operationId, selection: parsedSelection.selection }).then(
        (result) => {
          if (
            disposed ||
            visit !== loginVisit ||
            !presenting ||
            state.chatGptOperationId !== operationId ||
            result.operationId !== operationId
          ) {
            return;
          }
          clearProgressDetailTimer();
          authGeneration += 1;
          state = withChatGptLoginResult(state, result);
          if (result.status === "stored") {
            actionStatus = "signed-in";
          } else {
            actionStatus = null;
          }
          focusTitle();
          publish();
          if (result.status === "stored") {
            scheduleChatGptActivation(parsedSelection.selection, loginVisit);
          }
        },
        () => {
          if (
            disposed ||
            visit !== loginVisit ||
            !presenting ||
            state.chatGptOperationId !== operationId
          ) {
            return;
          }
          clearProgressDetailTimer();
          authGeneration += 1;
          state = withChatGptLoginResult(state, {
            status: "refused",
            operationId,
            reason: "exchange-failed",
          });
          actionStatus = null;
          focusTitle();
          publish();
        },
      );
    },
    cancelChatGptLogin(): void {
      if (
        disposed ||
        !presenting ||
        setupStatusBlocksMutations() ||
        state.chatGptLoginPhase === "idle"
      ) {
        return;
      }
      cancelActiveChatGptLogin();
    },
    retryChatGptActivation(): void {
      if (
        disposed ||
        !presenting ||
        setupStatusBlocksMutations() ||
        state.busy ||
        credentialMutationsBlocked() ||
        !chatGptSignedIn(state) ||
        selectedProviderIsReady() ||
        state.chatGptRuntimeState === "activating"
      ) {
        return;
      }
      const parsedSelection = llmSelectionFromDraft(llmDraft);
      if (parsedSelection.error !== null || parsedSelection.selection.provider !== "openai-codex") {
        setFixedError(parsedSelection.error ?? "configuration-unavailable");
        return;
      }
      beginChatGptActivation(parsedSelection.selection, visit);
    },
    recheckClaudeCli(): void {
      checkClaudeCliForSelection(true);
    },
    chooseImportFiles(): void {
      if (
        disposed ||
        !presenting ||
        setupStatusBlocksMutations() ||
        state.busy ||
        rideImports.isBusy() ||
        credentialMutationsBlocked()
      ) {
        return;
      }
      void rideImports.chooseAndImport("onboarding");
    },
    selectProvider(provider): void {
      if (setupStatusBlocksMutations() || state.chatGptRuntimeState === "activating") return;
      const configuration = llmConfiguration;
      const next = configuration?.providers.find((entry) => entry.provider === provider);
      if (next === undefined || configuration === undefined) return;
      setLlmDraft(
        llmDrafts[next.provider] ?? draftForProvider(next, configuration.catalogRevision),
      );
      setFixedError(null);
      if (provider === "openai-codex" && chatGptSignedIn(state) && !selectedProviderIsReady()) {
        const parsedSelection = llmSelectionFromDraft(llmDraft);
        if (
          parsedSelection.error === null &&
          parsedSelection.selection.provider === "openai-codex"
        ) {
          beginChatGptActivation(parsedSelection.selection, visit);
        }
        return;
      }
      const canActivateWithoutInput =
        provider === "claude-cli" &&
        (state.claudeCliState === "ready" || state.claudeCliState === "ready-api-key");
      if (provider === "claude-cli" && !canActivateWithoutInput) {
        checkClaudeCliForSelection(false);
      } else if (canActivateWithoutInput && !selectedProviderIsReady()) {
        void saveModelKey();
      }
    },
    selectModel(model): void {
      if (setupStatusBlocksMutations() || llmDraft === undefined) return;
      setLlmDraft({
        ...llmDraft,
        modelChoice: model,
        customModel: model === CUSTOM_MODEL_SELECTION ? llmDraft.customModel : "",
      });
      setFixedError(null);
    },
    setCustomModel(model): void {
      if (setupStatusBlocksMutations() || llmDraft === undefined) return;
      setLlmDraft({ ...llmDraft, customModel: model });
      setFixedError(null);
    },
    setEndpointMode(mode): void {
      if (setupStatusBlocksMutations() || llmDraft === undefined) return;
      const parsed = ENDPOINT_MODES.find((candidate) => candidate === mode);
      if (parsed === undefined) return;
      setLlmDraft({ ...llmDraft, endpointMode: parsed });
      setFixedError(null);
    },
    setCustomEndpoint(endpoint): void {
      if (setupStatusBlocksMutations() || llmDraft === undefined) return;
      setLlmDraft({ ...llmDraft, customEndpoint: endpoint });
      setFixedError(null);
    },
  };
}
