import {
  createRideImportController,
  type RideImportController,
  type RideImportState,
} from "../ride-import";
import type {
  CredentialWriteResult,
  IntervalsCredentialMutationRefusalReason,
  IntervalsCredentialMutationResult,
  OnboardingBridge,
  OnboardingCredentialWriteInput,
  OnboardingLlmConfiguration,
  OnboardingLlmEndpointSelection,
  OnboardingLlmSelection,
} from "./bridge";
import { CUSTOM_MODEL_SELECTION, DESKTOP_CREDENTIAL_SLOTS } from "./constants";
import { handoffCredential, type CredentialDraftPort } from "./credentials";
import type { SetupCommit } from "./lanes";
import {
  chatGptSignedIn,
  chatGptUiPhase,
  createOnboardingState,
  hasTrainingData,
  intakeComplete,
  selectedProviderReady,
  toDesktopIntakeFlags,
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
  withIntake,
  withPersistedIntake,
  type ChatGptUiPhase,
  type CredentialSlotStatus,
  type DesktopIntakeDraft,
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

export interface OnboardingReadiness {
  readonly provider: boolean;
  readonly trainingData: boolean;
  readonly intake: boolean;
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
}

export function onboardingCredentialMutationActive(surface: OnboardingSurfaceState): boolean {
  return (
    surface.loading ||
    surface.loadUnavailable ||
    surface.wizard.busy ||
    surface.wizard.chatGptLoginPhase !== "idle" ||
    surface.wizard.chatGptRuntimeState === "activating" ||
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
  finish(): void;
  dismiss(): void;
  retrySavedKeys(): void;
  retryIntakeSave(): void;
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
  setIntake<Key extends keyof DesktopIntakeDraft>(
    key: Key,
    value: DesktopIntakeDraft[Key],
    intent?: { readonly persistWhenComplete?: boolean },
  ): void;
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

function credentialSlotFor(
  provider: string | undefined,
): OnboardingCredentialWriteInput["slot"] | undefined {
  const slot = DESKTOP_CREDENTIAL_SLOTS.find((candidate) => candidate === provider);
  return slot === "intervals-icu" ? undefined : slot;
}

export interface OnboardingControllerOptions {
  readonly bridge: OnboardingBridge;
  readonly credentials: CredentialDraftPort;
  readonly view: OnboardingView;
  readonly rideImports?: RideImportController;
  readonly onRideImportPresentationChange?: (presenting: boolean) => void;
  readonly focusOpener: () => void;
  readonly onComplete: (completion: OnboardingCompletion) => void;
  readonly onReady?: () => void;
  readonly ownsDroppedImportFiles?: () => boolean;
  readonly credentialMutationsBlocked?: () => boolean;
  readonly createOperationId?: () => string;
  readonly afterPaint?: (callback: () => void) => () => void;
  readonly codexAgentSupported?: boolean;
}

export const CHATGPT_PROGRESS_DETAIL_DELAY_MS = 3_000;
// The Desktop main process owns the 10-second runtime activation deadline. This
// wider renderer deadline only catches a broken IPC response path after main has
// had time to report its authoritative result.
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

type BoundedResult<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected" };

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then<BoundedResult<T>, BoundedResult<T>>(
        (value) => ({ status: "fulfilled", value }),
        () => ({ status: "rejected" }),
      ),
      new Promise<BoundedResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "rejected" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function afterNextPaint(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let secondFrame: number | undefined;
  let cancelled = false;
  const firstFrame = requestAnimationFrame(() => {
    if (cancelled) return;
    secondFrame = requestAnimationFrame(() => {
      if (!cancelled) callback();
    });
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
  };
}

type CredentialWriteFailureReason = Extract<
  CredentialWriteResult,
  { readonly status: "refused" | "uncertain" }
>["reason"];

type IntakePersistenceResult = "saved" | "failed" | "stale";

interface IntakeSaveRequest {
  readonly revision: number;
  readonly visit: number;
  readonly generation: number;
  readonly intake: ReturnType<typeof toDesktopIntakeFlags>;
  readonly waiters: Array<(result: IntakePersistenceResult) => void>;
  focusOnFailure: boolean;
}

function persistedIntakeMatchesDraft(
  persisted: ReturnType<typeof toDesktopIntakeFlags> | null,
  draft: DesktopIntakeDraft,
): boolean {
  if (persisted === null || !intakeComplete(draft)) return false;
  const expected = toDesktopIntakeFlags(draft);
  return (
    persisted.swim_skill_floor === expected.swim_skill_floor &&
    persisted.continuous_distance_capable === expected.continuous_distance_capable &&
    persisted.open_water_comfort === expected.open_water_comfort &&
    persisted.prior_bsi === expected.prior_bsi &&
    persisted.injury_status === expected.injury_status
  );
}

const CREDENTIAL_WRITE_REFUSAL_ERRORS = {
  "invalid-input": "invalid-input",
  "encryption-unavailable": "encryption-unavailable",
  "unsafe-backend": "unsafe-backend",
  "storage-failed": "storage-failed",
  "runtime-unavailable": "runtime-unavailable",
  "training-account-mismatch": "training-account-mismatch",
  "storage-uncertain": "storage-uncertain",
} as const satisfies Readonly<Record<CredentialWriteFailureReason, OnboardingErrorCode>>;

const INTERVALS_REFUSAL_ERRORS = {
  "clipboard-unavailable": "intervals-clipboard-unavailable",
  "clipboard-clear-failed": "intervals-clipboard-clear-failed",
  "invalid-key-format": "intervals-clipboard-unavailable",
  "credential-rejected": "intervals-key-rejected",
  "malformed-athlete-response": "intervals-validation-unavailable",
  "validation-timeout": "intervals-validation-unavailable",
  "validation-aborted": "intervals-validation-unavailable",
  "validation-unavailable": "intervals-validation-unavailable",
  "training-account-mismatch": "training-account-mismatch",
  "owner-unresolved": "intervals-owner-unavailable",
  "store-unavailable": "intervals-owner-unavailable",
  "encryption-unavailable": "encryption-unavailable",
  "unsafe-backend": "unsafe-backend",
  "storage-failed": "storage-failed",
  "runtime-unavailable": "intervals-runtime-unavailable",
} as const satisfies Readonly<
  Record<IntervalsCredentialMutationRefusalReason, OnboardingErrorCode>
>;

const ENDPOINT_MODES: readonly OnboardingLlmEndpointSelection["mode"][] = [
  "automatic",
  "default",
  "custom",
];

function credentialWriteRefusalError(reason: unknown): OnboardingErrorCode {
  if (typeof reason === "string" && Object.hasOwn(CREDENTIAL_WRITE_REFUSAL_ERRORS, reason)) {
    return CREDENTIAL_WRITE_REFUSAL_ERRORS[reason as CredentialWriteFailureReason];
  }
  return "credential-save-failed";
}

function intervalsMutationError(
  result: IntervalsCredentialMutationResult,
): OnboardingErrorCode | null {
  if (result.outcome === "applied") {
    return result.current.state === "configured" && result.current.runtimeState === "active"
      ? null
      : "intervals-runtime-unavailable";
  }
  if (result.outcome === "refused") return INTERVALS_REFUSAL_ERRORS[result.reason];
  return result.reason === "storage-uncertain"
    ? "intervals-storage-uncertain"
    : "intervals-runtime-uncertain";
}

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
  let intakeSaved = false;
  const readsAuthoritativeSetupStatus = options.bridge.getSetupStatus !== undefined;
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
  let authGeneration = 0;
  let statusRefreshGeneration = 0;
  let progressDetailTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelScheduledActivation: (() => void) | undefined;
  let cancellingOperationId: string | undefined;
  let intakeRevision = 0;
  let savedIntakeRevision: number | null = null;
  let intakePersistenceGeneration = 0;
  let activeIntakeSave: IntakeSaveRequest | null = null;
  let queuedIntakeSave: IntakeSaveRequest | null = null;
  let autoPersistIntakeDraft = false;

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
    intake: (readsAuthoritativeSetupStatus ? intakeSaved : true) && intakeComplete(state.intake),
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

  const settleIntakeWaiters = (
    request: IntakeSaveRequest,
    result: IntakePersistenceResult,
  ): void => {
    const waiters = request.waiters.splice(0);
    for (const resolve of waiters) resolve(result);
  };

  const discardQueuedIntakeSave = (): void => {
    if (queuedIntakeSave === null) return;
    settleIntakeWaiters(queuedIntakeSave, "stale");
    queuedIntakeSave = null;
  };

  const invalidateIntakePersistence = (): void => {
    intakePersistenceGeneration += 1;
    discardQueuedIntakeSave();
    if (activeIntakeSave !== null) settleIntakeWaiters(activeIntakeSave, "stale");
  };

  const startIntakeSave = (request: IntakeSaveRequest): void => {
    activeIntakeSave = request;
    let save: Promise<void>;
    try {
      save = options.bridge.saveIntake(request.intake);
    } catch {
      save = Promise.reject();
    }
    void save
      .then(
        () => {
          const current =
            !disposed &&
            presenting &&
            visit === request.visit &&
            intakePersistenceGeneration === request.generation &&
            intakeRevision === request.revision;
          if (current) {
            intakeSaved = true;
            savedIntakeRevision = request.revision;
            if (state.fixedError === "intake-save-failed") {
              state = { ...state, fixedError: null };
            }
            publish();
          }
          settleIntakeWaiters(request, current ? "saved" : "stale");
        },
        () => {
          const current =
            !disposed &&
            presenting &&
            visit === request.visit &&
            intakePersistenceGeneration === request.generation &&
            intakeRevision === request.revision;
          if (current) {
            intakeSaved = false;
            savedIntakeRevision = null;
            state = request.focusOnFailure
              ? withError(state, "intake-save-failed")
              : { ...state, fixedError: "intake-save-failed" };
            if (request.focusOnFailure) focusTitle();
            publish();
          }
          settleIntakeWaiters(request, current ? "failed" : "stale");
        },
      )
      .finally(() => {
        if (activeIntakeSave === request) activeIntakeSave = null;
        const next = queuedIntakeSave;
        queuedIntakeSave = null;
        if (next !== null) startIntakeSave(next);
      });
  };

  const persistIntake = (
    revision: number,
    intake: ReturnType<typeof toDesktopIntakeFlags>,
    focusOnFailure = false,
  ): Promise<IntakePersistenceResult> => {
    if (intakeSaved && savedIntakeRevision === revision) {
      return Promise.resolve("saved");
    }

    const matching = [activeIntakeSave, queuedIntakeSave].find(
      (request) =>
        request !== null &&
        request.revision === revision &&
        request.visit === visit &&
        request.generation === intakePersistenceGeneration,
    );
    if (matching !== undefined && matching !== null) {
      matching.focusOnFailure ||= focusOnFailure;
      return new Promise((resolve) => matching.waiters.push(resolve));
    }

    const request: IntakeSaveRequest = {
      revision,
      visit,
      generation: intakePersistenceGeneration,
      intake,
      waiters: [],
      focusOnFailure,
    };
    const result = new Promise<IntakePersistenceResult>((resolve) => {
      request.waiters.push(resolve);
    });
    if (activeIntakeSave === null) {
      startIntakeSave(request);
    } else {
      discardQueuedIntakeSave();
      queuedIntakeSave = request;
    }
    return result;
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
  };

  const close = (): void => {
    cancelActiveChatGptLogin();
    clearProgressDetailTimer();
    clearScheduledActivation();
    authGeneration += 1;
    statusRefreshGeneration += 1;
    invalidateIntakePersistence();
    actionStatus = null;
    visit += 1;
    options.credentials.clear();
    presenting = false;
    setRideImportPresentation(false);
    publish();
    options.focusOpener();
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
        if (applied.status === "refused") {
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
    publish();
    let result: IntervalsCredentialMutationResult;
    try {
      result = await options.bridge.pasteIntervalsApiKeyFromClipboard();
    } catch {
      if (visit !== submitVisit || !presenting) return;
      state = withError(state, "intervals-validation-unavailable");
      publish();
      return;
    }
    if (visit !== submitVisit || !presenting) return;
    credentialStatuses = [
      ...credentialStatuses.filter((entry) => entry.slot !== "intervals-icu"),
      result.current,
    ];
    state = withCredentialStatuses(state, credentialStatuses);
    const saveError = intervalsMutationError(result);
    state = withBusy(state, false);
    if (saveError !== null) state = withError(state, saveError);
    publish();
  };

  const walkGates = (): OnboardingErrorCode | null => {
    const readiness = currentReadiness();
    if (!readiness.provider) return "credential-required";
    if (!readiness.trainingData) return "training-data-required";
    if (!intakeComplete(state.intake)) return "intake-incomplete";
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
    const finishVisit = visit;
    actionStatus = null;
    state = withBusy(state, true);
    publish();
    let intake: ReturnType<typeof toDesktopIntakeFlags>;
    try {
      intake = toDesktopIntakeFlags(state.intake);
    } catch {
      state = withError(state, "intake-incomplete");
      focusTitle();
      publish();
      return;
    }
    const finishRevision = intakeRevision;
    const saved = await persistIntake(finishRevision, intake, true);
    if (
      saved !== "saved" ||
      visit !== finishVisit ||
      !presenting ||
      intakeRevision !== finishRevision
    ) {
      return;
    }
    state = withBusy(state, false);
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
      // An activation result is terminal for this auth generation. Status
      // refreshes that started while activation was pending must not overwrite it.
      authGeneration += 1;
      const ready = result.status === "fulfilled" && result.value.status === "configured";
      state = withChatGptActivationResult(state, ready);
      if (ready) {
        recordActiveSelection(selection);
        actionStatus = "ready";
      } else {
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

  const load = async (hydrateIntake: boolean, retryWhileStarting: boolean): Promise<void> => {
    if (disposed || opening) return;
    const currentIntake = state.intake;
    const currentAutoPersistIntakeDraft = autoPersistIntakeDraft;
    const currentDraft = llmDraft;
    const currentDrafts = llmDrafts;
    const hadActiveIntakeSave = activeIntakeSave !== null;
    const hydrateAuthoritativeState = hydrateIntake || !hasSuccessfulLoad;
    opening = true;
    presenting = true;
    loading = true;
    publish();
    invalidateIntakePersistence();
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
              intake: null,
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
    llmConfiguration = configurationResult.value;
    llmDrafts = {};
    if (!hydrateAuthoritativeState) {
      for (const [provider, draft] of Object.entries(currentDrafts)) {
        const refreshedProvider = llmConfiguration.providers.find(
          (entry) => entry.provider === provider,
        );
        if (refreshedProvider !== undefined) {
          llmDrafts[provider] = { ...draft, provider: refreshedProvider };
        }
      }
    }
    const refreshedCurrentProvider = llmConfiguration.providers.find(
      (entry) => entry.provider === currentDraft?.provider.provider,
    );
    setLlmDraft(
      !hydrateAuthoritativeState &&
        currentDraft !== undefined &&
        refreshedCurrentProvider !== undefined
        ? { ...currentDraft, provider: refreshedCurrentProvider }
        : initialLlmDraft(llmConfiguration, statuses, restoredChatGptStatus),
    );
    credentialStatuses = statuses;
    state = createOnboardingState(statuses, restoredChatGptStatus);
    if (hydrateAuthoritativeState) {
      state = withPersistedIntake(state, setupResult.value.intake);
      intakeSaved = setupResult.value.intake !== null;
      autoPersistIntakeDraft = false;
    } else {
      state = withIntake(state, currentIntake);
      intakeSaved = persistedIntakeMatchesDraft(setupResult.value.intake, currentIntake);
      autoPersistIntakeDraft = currentAutoPersistIntakeDraft;
    }
    const invalidatedSaveNeedsReplacement =
      !hydrateAuthoritativeState &&
      hadActiveIntakeSave &&
      autoPersistIntakeDraft &&
      intakeComplete(state.intake);
    if (invalidatedSaveNeedsReplacement) intakeSaved = false;
    intakeRevision += 1;
    savedIntakeRevision = intakeSaved ? intakeRevision : null;
    const shouldResumeIntakePersistence =
      !hydrateAuthoritativeState &&
      autoPersistIntakeDraft &&
      intakeComplete(state.intake) &&
      !intakeSaved;
    durableTrainingData = setupResult.value.durableTrainingData;
    const readiness = currentReadiness();
    if (!readiness.provider || !readiness.trainingData || !readiness.intake) {
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
    opening = false;
    if (shouldResumeIntakePersistence) {
      void persistIntake(intakeRevision, toDesktopIntakeFlags(state.intake));
    }
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
      clearProgressDetailTimer();
      clearScheduledActivation();
      disposed = true;
      authGeneration += 1;
      statusRefreshGeneration += 1;
      invalidateIntakePersistence();
      visit += 1;
      actionStatus = null;
      options.credentials.clear();
      presenting = false;
      setRideImportPresentation(false);
      publish();
      disposeChatGptProgress();
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
    retryIntakeSave(): void {
      if (
        disposed ||
        !presenting ||
        setupStatusBlocksMutations() ||
        state.busy ||
        state.fixedError !== "intake-save-failed" ||
        !intakeComplete(state.intake)
      ) {
        return;
      }
      const retryRevision = intakeRevision;
      const intake = toDesktopIntakeFlags(state.intake);
      void persistIntake(retryRevision, intake);
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
        const chatGpt = llmConfiguration?.providers.find(
          (provider) => provider.provider === "openai-codex",
        );
        if (chatGpt === undefined) {
          setFixedError("configuration-unavailable");
          return;
        }
        setLlmDraft(llmDrafts[chatGpt.provider] ?? draftForProvider(chatGpt));
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
      const next = llmConfiguration?.providers.find((entry) => entry.provider === provider);
      if (next === undefined) return;
      setLlmDraft(llmDrafts[next.provider] ?? draftForProvider(next));
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
    setIntake(key, value, intent): void {
      if (disposed || !presenting || setupStatusBlocksMutations() || state.busy) return;
      intakeRevision += 1;
      intakeSaved = false;
      savedIntakeRevision = null;
      autoPersistIntakeDraft = intent?.persistWhenComplete === true;
      discardQueuedIntakeSave();
      state = withIntake(state, { [key]: value });
      publish();
      if (autoPersistIntakeDraft && intakeComplete(state.intake)) {
        void persistIntake(intakeRevision, toDesktopIntakeFlags(state.intake));
      }
    },
  };
}
