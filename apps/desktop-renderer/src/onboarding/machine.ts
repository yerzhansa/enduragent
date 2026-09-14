import {
  KEYLESS_LLM_PROVIDERS,
  SaveIntakeRpcParamsSchema,
  isKeylessProvider,
  type SaveIntakeRpcParams,
} from "@enduragent/coach-contract";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  ONBOARDING_STEP_IDS,
  type ClaudeCliState,
  type DesktopCredentialSlot,
  type ChatGptLoginRefusalReason,
  type OnboardingStepId,
} from "./constants";
import { claudeCliIdentityLine } from "./credential-presentation";

const CHATGPT_SUBSCRIPTION_PROVIDER = KEYLESS_LLM_PROVIDERS[0];
const CLAUDE_CLI_PROVIDER = KEYLESS_LLM_PROVIDERS[1];

export type CredentialState = "missing" | "configured" | "re-prompt";
export type CredentialRuntimeState = "active" | "stored-inactive" | "failed";

export interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

export interface ChatGptStatus {
  readonly state: "configured" | "absent";
  readonly runtimeReady: boolean;
}

export type ChatGptLoginPhase = "idle" | "waiting-for-browser" | "completing-sign-in";

export type ChatGptRuntimeState = "inactive" | "activating" | "ready" | "failed";

export type ChatGptUiPhase =
  | "idle"
  | "waiting-for-browser"
  | "completing-sign-in"
  | "signed-in"
  | "activating-coach"
  | "ready"
  | "login-failed"
  | "activation-failed";

export interface ChatGptLoginProgress {
  readonly operationId: string;
  readonly phase: Exclude<ChatGptLoginPhase, "idle">;
}

export interface ClaudeCliStatus {
  readonly state: ClaudeCliState;
  readonly email?: string;
  readonly plan?: string;
  readonly version?: string;
}

export type ChatGptLoginResult<Selection = unknown> =
  | { readonly status: "stored"; readonly operationId: string }
  | {
      readonly status: "stale-draft";
      readonly operationId: string;
      readonly reason: "catalog-unavailable";
      readonly selection: Selection;
    }
  | {
      readonly status: "refused";
      readonly operationId: string;
      readonly reason: ChatGptLoginRefusalReason;
    };

export type ChatGptCancelLoginResult = {
  readonly status: "cancelling" | "not-active";
  readonly operationId: string;
};

export interface DesktopIntakeDraft {
  readonly injuryStatus: "none" | "managing" | "returning" | null;
}

export type OnboardingErrorCode =
  | "credential-required"
  | "credential-save-failed"
  | "invalid-input"
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed"
  | "storage-uncertain"
  | "runtime-unavailable"
  | "credential-status-unavailable"
  | "credential-reenter-required"
  | "configuration-unavailable"
  | "model-selection-required"
  | "endpoint-invalid"
  | "model-runtime-unavailable"
  | "training-account-mismatch"
  | "intervals-clipboard-unavailable"
  | "intervals-clipboard-clear-failed"
  | "intervals-key-rejected"
  | "intervals-validation-unavailable"
  | "intervals-owner-unavailable"
  | "intervals-storage-uncertain"
  | "intervals-runtime-unavailable"
  | "intervals-runtime-uncertain"
  | "training-data-required"
  | "intake-incomplete"
  | "intake-save-failed";

export interface OnboardingState {
  readonly step: OnboardingStepId;
  readonly credentialStatus: Readonly<Record<DesktopCredentialSlot, CredentialState>>;
  readonly credentialRuntimeStatus: Readonly<
    Record<DesktopCredentialSlot, CredentialRuntimeState | null>
  >;
  readonly chatGptCredentialState: "absent" | "stored";
  readonly chatGptRuntimeState: ChatGptRuntimeState;
  readonly chatGptLoginPhase: ChatGptLoginPhase;
  readonly chatGptOperationId: string | null;
  readonly chatGptRefusal: ChatGptLoginRefusalReason | null;
  readonly claudeCliState: ClaudeCliState | null;
  readonly claudeCliIdentity: string | null;
  readonly importedRideFileCount: number;
  readonly intake: DesktopIntakeDraft;
  readonly busy: boolean;
  readonly fixedError: OnboardingErrorCode | null;
}

export interface OnboardingCompletion {
  readonly providerConfigured: true;
  readonly trainingDataConfigured: true;
  readonly intakeSaved: true;
  readonly requiresProviderSync: boolean;
}

function statusRecord<T>(initial: T): Record<DesktopCredentialSlot, T> {
  return Object.fromEntries(DESKTOP_CREDENTIAL_SLOTS.map((slot) => [slot, initial])) as Record<
    DesktopCredentialSlot,
    T
  >;
}

export function createOnboardingState(
  statuses: readonly CredentialSlotStatus[] = [],
  chatGptStatus: ChatGptStatus = { state: "absent", runtimeReady: false },
  claudeCliStatus: ClaudeCliStatus | null = null,
): OnboardingState {
  const credentialStatus = statusRecord<CredentialState>("missing");
  const credentialRuntimeStatus = statusRecord<CredentialRuntimeState | null>(null);
  for (const status of statuses) {
    credentialStatus[status.slot] = status.state;
    credentialRuntimeStatus[status.slot] = status.runtimeState;
  }
  return {
    step: "coach-keys",
    credentialStatus,
    credentialRuntimeStatus,
    chatGptCredentialState: chatGptStatus.state === "configured" ? "stored" : "absent",
    chatGptRuntimeState:
      chatGptStatus.state === "configured" && chatGptStatus.runtimeReady ? "ready" : "inactive",
    chatGptLoginPhase: "idle",
    chatGptOperationId: null,
    chatGptRefusal: null,
    claudeCliState: claudeCliStatus === null ? null : claudeCliStatus.state,
    claudeCliIdentity: claudeCliStatus === null ? null : claudeCliIdentityLine(claudeCliStatus),
    importedRideFileCount: 0,
    intake: { injuryStatus: null },
    busy: false,
    fixedError: null,
  };
}

export function withChatGptStatus(state: OnboardingState, status: ChatGptStatus): OnboardingState {
  return {
    ...state,
    chatGptCredentialState: status.state === "configured" ? "stored" : "absent",
    chatGptRuntimeState:
      status.state === "configured" && status.runtimeReady ? "ready" : "inactive",
    chatGptLoginPhase: "idle",
    chatGptOperationId: null,
    chatGptRefusal: null,
  };
}

export function withClaudeCliStatus(
  state: OnboardingState,
  status: ClaudeCliStatus | null,
): OnboardingState {
  return {
    ...state,
    claudeCliState: status === null ? null : status.state,
    claudeCliIdentity: status === null ? null : claudeCliIdentityLine(status),
  };
}

export function claudeCliReady(state: OnboardingState): boolean {
  return state.claudeCliState === "ready" || state.claudeCliState === "ready-api-key";
}

export function withChatGptPending(state: OnboardingState, operationId: string): OnboardingState {
  return {
    ...state,
    chatGptLoginPhase: "waiting-for-browser",
    chatGptOperationId: operationId,
    chatGptRefusal: null,
    busy: true,
    fixedError: null,
  };
}

export function withChatGptProgress(
  state: OnboardingState,
  progress: ChatGptLoginProgress,
): OnboardingState {
  if (
    state.chatGptOperationId !== progress.operationId ||
    state.chatGptLoginPhase === "idle" ||
    (state.chatGptLoginPhase === "completing-sign-in" && progress.phase === "waiting-for-browser")
  ) {
    return state;
  }
  return { ...state, chatGptLoginPhase: progress.phase };
}

export function withChatGptLoginResult(
  state: OnboardingState,
  result: ChatGptLoginResult,
): OnboardingState {
  if (state.chatGptOperationId !== result.operationId || state.chatGptLoginPhase === "idle") {
    return state;
  }
  if (result.status === "stale-draft") {
    return {
      ...state,
      chatGptLoginPhase: "idle",
      chatGptOperationId: null,
      busy: false,
      fixedError: "configuration-unavailable",
    };
  }
  return result.status === "stored"
    ? {
        ...state,
        chatGptCredentialState: "stored",
        chatGptRuntimeState: "inactive",
        chatGptLoginPhase: "idle",
        chatGptOperationId: null,
        chatGptRefusal: null,
        busy: false,
        fixedError: null,
      }
    : {
        ...state,
        chatGptLoginPhase: "idle",
        chatGptOperationId: null,
        chatGptRefusal: result.reason,
        busy: false,
      };
}

export function withChatGptActivationPending(state: OnboardingState): OnboardingState {
  if (state.chatGptCredentialState !== "stored") return state;
  return {
    ...state,
    chatGptRuntimeState: "activating",
    chatGptRefusal: null,
    busy: false,
    fixedError: null,
  };
}

export function withChatGptActivationResult(
  state: OnboardingState,
  ready: boolean,
): OnboardingState {
  if (state.chatGptCredentialState !== "stored") return state;
  return {
    ...state,
    chatGptRuntimeState: ready ? "ready" : "failed",
    busy: false,
  };
}

export function chatGptUiPhase(state: OnboardingState): ChatGptUiPhase {
  if (state.chatGptLoginPhase !== "idle") return state.chatGptLoginPhase;
  if (state.chatGptCredentialState === "stored") {
    if (state.chatGptRuntimeState === "activating") return "activating-coach";
    if (state.chatGptRuntimeState === "ready") return "ready";
    if (state.chatGptRuntimeState === "failed") return "activation-failed";
    return "signed-in";
  }
  return state.chatGptRefusal === null ? "idle" : "login-failed";
}

export function chatGptSignedIn(state: OnboardingState): boolean {
  return state.chatGptCredentialState === "stored";
}

export function chatGptReady(state: OnboardingState): boolean {
  return state.chatGptCredentialState === "stored" && state.chatGptRuntimeState === "ready";
}

export function withCredentialStatuses(
  state: OnboardingState,
  statuses: readonly CredentialSlotStatus[],
): OnboardingState {
  const credentialStatus = { ...state.credentialStatus };
  const credentialRuntimeStatus = { ...state.credentialRuntimeStatus };
  for (const status of statuses) {
    credentialStatus[status.slot] = status.state;
    credentialRuntimeStatus[status.slot] = status.runtimeState;
  }
  return { ...state, credentialStatus, credentialRuntimeStatus };
}

export function hasConfiguredModel(state: OnboardingState): boolean {
  return (
    chatGptReady(state) ||
    claudeCliReady(state) ||
    DESKTOP_CREDENTIAL_SLOTS.some(
      (slot) =>
        slot !== "intervals-icu" &&
        state.credentialStatus[slot] === "configured" &&
        state.credentialRuntimeStatus[slot] === "active",
    )
  );
}

export function selectedProviderReady(
  state: OnboardingState,
  selected: { readonly provider: string; readonly model: string } | null,
  active: { readonly provider: string; readonly model: string } | null,
): boolean {
  if (
    selected === null ||
    active === null ||
    selected.provider !== active.provider ||
    selected.model !== active.model
  ) {
    return false;
  }
  if (selected.provider === CHATGPT_SUBSCRIPTION_PROVIDER) {
    return chatGptReady(state);
  }
  if (selected.provider === CLAUDE_CLI_PROVIDER) return claudeCliReady(state);
  if (selected.provider === "codex-agent") return true;
  if (selected.provider === "intervals-icu" || isKeylessProvider(selected.provider)) return false;
  const slot = DESKTOP_CREDENTIAL_SLOTS.find((candidate) => candidate === selected.provider);
  if (slot === undefined) return false;
  return (
    state.credentialStatus[slot] === "configured" &&
    state.credentialRuntimeStatus[slot] === "active"
  );
}

export function hasTrainingData(state: OnboardingState): boolean {
  return (
    (state.credentialStatus["intervals-icu"] === "configured" &&
      state.credentialRuntimeStatus["intervals-icu"] === "active") ||
    state.importedRideFileCount > 0
  );
}

export function toDesktopIntakeFlags(draft: DesktopIntakeDraft): SaveIntakeRpcParams {
  if (draft.injuryStatus === null) throw new TypeError();
  return SaveIntakeRpcParamsSchema.parse({
    swim_skill_floor: null,
    continuous_distance_capable: null,
    open_water_comfort: null,
    prior_bsi: false,
    clinician_cleared: null,
    injury_status: draft.injuryStatus,
  });
}

export function intakeComplete(draft: DesktopIntakeDraft): boolean {
  try {
    toDesktopIntakeFlags(draft);
    return true;
  } catch {
    return false;
  }
}

export function nextStep(
  state: OnboardingState,
  runtimeModelConfigured = hasConfiguredModel(state),
): OnboardingState {
  const index = ONBOARDING_STEP_IDS.indexOf(state.step);
  if (index >= ONBOARDING_STEP_IDS.length - 1) return state;
  if (state.step === "coach-keys" && !runtimeModelConfigured) {
    return { ...state, fixedError: "credential-required" };
  }
  if (state.step === "training-data" && !hasTrainingData(state)) {
    return { ...state, fixedError: "training-data-required" };
  }
  if (state.step === "safety-intake") {
    try {
      toDesktopIntakeFlags(state.intake);
    } catch {
      return { ...state, fixedError: "intake-incomplete" };
    }
  }
  return { ...state, step: ONBOARDING_STEP_IDS[index + 1]!, fixedError: null };
}

export function previousStep(state: OnboardingState): OnboardingState {
  const index = ONBOARDING_STEP_IDS.indexOf(state.step);
  if (index <= 0) return state;
  return { ...state, step: ONBOARDING_STEP_IDS[index - 1]!, fixedError: null };
}

export function withIntake(
  state: OnboardingState,
  update: Partial<DesktopIntakeDraft>,
): OnboardingState {
  const intake = { ...state.intake, ...update };
  return {
    ...state,
    intake,
    fixedError: null,
  };
}

export function withPersistedIntake(
  state: OnboardingState,
  intake: SaveIntakeRpcParams | null,
): OnboardingState {
  if (intake === null) return state;
  const parsed = SaveIntakeRpcParamsSchema.parse(intake);
  return withIntake(state, { injuryStatus: parsed.injury_status });
}

export function withBusy(state: OnboardingState, busy: boolean): OnboardingState {
  return { ...state, busy, fixedError: busy ? null : state.fixedError };
}

export function withError(
  state: OnboardingState,
  fixedError: OnboardingErrorCode,
): OnboardingState {
  return { ...state, busy: false, fixedError };
}

export function withImportedRideFileCount(
  state: OnboardingState,
  importedRideFileCount: number,
): OnboardingState {
  if (!Number.isSafeInteger(importedRideFileCount) || importedRideFileCount < 0) {
    throw new TypeError();
  }
  return {
    ...state,
    importedRideFileCount: Math.max(state.importedRideFileCount, importedRideFileCount),
  };
}

export function toOnboardingCompletion(state: OnboardingState): OnboardingCompletion {
  return {
    providerConfigured: true,
    trainingDataConfigured: true,
    intakeSaved: true,
    requiresProviderSync:
      state.credentialStatus["intervals-icu"] === "configured" &&
      state.credentialRuntimeStatus["intervals-icu"] === "active",
  };
}
