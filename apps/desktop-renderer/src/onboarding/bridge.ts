import type { CoachClient } from "@enduragent/coach-client";
import { CoachClientDisconnectedError, connectCoachClient } from "@enduragent/coach-client";
import {
  ImportFilesRpcParamsSchema,
  PlatformAbsolutePathSchema,
  type GetSetupStatusRpcResult,
  type CoachOperationProgressNotificationEnvelope,
  type ImportFilesRpcResult,
  type LlmProvider,
} from "@enduragent/coach-contract";
import { validateRendererDaemonConnection } from "../daemon-connection";
import { SUPPORTED_IMPORT_EXTENSIONS, type DesktopCredentialSlot } from "./constants";
import { openRouterSignInBridge } from "./openrouter-sign-in";
import type {
  ChatGptCancelLoginResult,
  ChatGptLoginProgress,
  ChatGptLoginResult,
  ChatGptStatus,
  ClaudeCliStatus,
  CredentialRuntimeState,
  CredentialState,
  CredentialSlotStatus,
} from "./machine";

export type CredentialWriteResult =
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "configured";
      readonly runtimeReady: boolean;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "stale-draft";
      readonly reason: "catalog-unavailable";
      readonly selection: OnboardingLlmSelection;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "refused";
      readonly reason:
        | "invalid-input"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed"
        | "runtime-unavailable"
        | "training-account-mismatch";
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "uncertain";
      readonly reason: "storage-uncertain";
    };

export type DesktopCredentialId = DesktopCredentialSlot | "openai-codex";

export type CredentialRecoveryStatus =
  | Readonly<{ state: "ready"; unverifiedEnvelopes: number }>
  | Readonly<{ state: "locked" | "missing" | "unavailable" }>;

export type CredentialResetResult =
  | Readonly<{ status: "reset"; keyCleanupPending: boolean }>
  | Readonly<{ status: "refused"; reason: "runtime-unavailable" | "storage-failed" }>;

export type CredentialDeleteResult =
  | {
      readonly credential: Exclude<DesktopCredentialId, "intervals-icu">;
      readonly status: "deleted";
      readonly cleanupPending: boolean;
    }
  | {
      readonly credential: "intervals-icu";
      readonly status: "deleted";
      readonly cleanupPending: boolean;
      readonly revoke: "revoked" | "already-invalid" | "not-signed-in" | "failed";
    }
  | {
      readonly credential: DesktopCredentialId;
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "managed-by-environment"
        | "encryption-unavailable"
        | "storage-failed"
        | "runtime-unavailable"
        | "runtime-state-diverged";
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "uncertain";
      readonly reason: "storage-uncertain";
    };

export interface IntervalsCredentialStatus {
  readonly slot: "intervals-icu";
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

export type IntervalsCredentialMutationRefusalReason =
  | "sign-in-denied"
  | "sign-in-failed"
  | "sign-in-timed-out"
  | "sign-in-cancelled"
  | "sign-in-unreachable"
  | "credential-rejected"
  | "malformed-athlete-response"
  | "validation-timeout"
  | "validation-aborted"
  | "validation-unavailable"
  | "training-account-mismatch"
  | "owner-unresolved"
  | "store-unavailable"
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed"
  | "runtime-unavailable";

export type IntervalsSignInPhase = "waiting-for-browser" | "completing-sign-in";

export type IntervalsCredentialMutationResult =
  | {
      readonly outcome: "applied";
      readonly current: IntervalsCredentialStatus;
      readonly athleteName?: string;
    }
  | {
      readonly outcome: "refused";
      readonly reason: IntervalsCredentialMutationRefusalReason;
      readonly current: IntervalsCredentialStatus;
    }
  | {
      readonly outcome: "saved-not-active";
      readonly current: IntervalsCredentialStatus;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain";
      readonly current: IntervalsCredentialStatus;
    };

export interface OnboardingLlmModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface OnboardingLlmProviderConfiguration {
  readonly provider: LlmProvider;
  readonly defaultModel: string;
  readonly models: readonly OnboardingLlmModelOption[];
  readonly defaultBaseUrl?: string;
}

export type SavedModel = { readonly provider: LlmProvider; readonly model: string } & (
  | { readonly kind: "listed" }
  | { readonly kind: "retired"; readonly replacedBy: string | null }
  | { readonly kind: "custom" }
);

export interface OnboardingLlmConfiguration {
  readonly schemaVersion: 1;
  readonly catalogRevision: number;
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: SavedModel | null;
}

export type OnboardingLlmEndpointSelection =
  | { readonly mode: "automatic" }
  | { readonly mode: "default" }
  | { readonly mode: "custom"; readonly value: string };

export interface OnboardingLlmSelection {
  readonly catalogRevision: number;
  readonly provider: LlmProvider;
  readonly model: string;
  readonly endpoint: OnboardingLlmEndpointSelection;
}

export type OnboardingLlmSelectionResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | {
      readonly status: "stale-draft";
      readonly reason: "catalog-unavailable";
      readonly selection: OnboardingLlmSelection;
    }
  | {
      readonly status: "refused";
      readonly reason: "invalid-input" | "credential-required" | "runtime-unavailable";
    };

export interface OnboardingCredentialWriteInput {
  readonly slot: Exclude<DesktopCredentialSlot, "intervals-icu">;
  readonly value: string;
  readonly selection?: OnboardingLlmSelection;
}

export interface ChatGptLoginInput {
  readonly operationId: string;
  readonly selection: OnboardingLlmSelection;
}

export type OpenRouterCreditStatus = "paid" | "never-paid" | "unknown";

export type OpenRouterSignInPhase = "waiting-for-browser" | "completing-sign-in";

export type OpenRouterSignInRefusal =
  | "already-in-progress"
  | "cancelled"
  | "not-finished"
  | "unreachable"
  | "not-saved"
  | "saved-not-active"
  | "clipboard-no-code"
  | "clipboard-unavailable"
  | "code-expired"
  | "invalid-input";

export type OpenRouterSignInResult =
  | {
      readonly status: "connected";
      readonly operationId: string;
      readonly credit: OpenRouterCreditStatus;
    }
  | { readonly status: "awaiting-code"; readonly operationId: string }
  | {
      readonly status: "refused";
      readonly operationId: string;
      readonly reason: OpenRouterSignInRefusal;
    };

export interface OpenRouterSignInProgress {
  readonly operationId: string;
  readonly phase: OpenRouterSignInPhase;
}

export interface OpenRouterSignInInput {
  readonly operationId: string;
  readonly selection: OnboardingLlmSelection;
}

export interface OpenRouterSignInBridge {
  openRouterSignIn(input: OpenRouterSignInInput): Promise<OpenRouterSignInResult>;
  startOpenRouterCodeSignIn(input: OpenRouterSignInInput): Promise<OpenRouterSignInResult>;
  useCopiedOpenRouterCode(operationId: string): Promise<OpenRouterSignInResult>;
  cancelOpenRouterSignIn(operationId: string): Promise<boolean>;
  reopenOpenRouterSignIn(operationId: string): Promise<boolean>;
  openRouterCreditStatus(): Promise<OpenRouterCreditStatus>;
  openOpenRouterPage(page: "credits" | "keys"): Promise<boolean>;
  onOpenRouterSignInProgress(listener: (progress: OpenRouterSignInProgress) => void): () => void;
}

export interface OnboardingBridge extends OpenRouterSignInBridge {
  getSetupStatus?(): Promise<GetSetupStatusRpcResult>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: OnboardingCredentialWriteInput): Promise<CredentialWriteResult>;
  signInWithIntervals(): Promise<IntervalsCredentialMutationResult>;
  cancelIntervalsSignIn(): Promise<boolean>;
  reopenIntervalsSignIn(): Promise<boolean>;
  onIntervalsSignInProgress(listener: (phase: IntervalsSignInPhase) => void): () => void;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatGptStatus(): Promise<ChatGptStatus>;
  chatGptLogin(input: ChatGptLoginInput): Promise<ChatGptLoginResult<OnboardingLlmSelection>>;
  cancelChatGptLogin(operationId: string): Promise<ChatGptCancelLoginResult>;
  onChatGptLoginProgress(listener: (progress: ChatGptLoginProgress) => void): () => void;
  claudeCliStatus(): Promise<ClaudeCliStatus>;
  claudeCliRecheck(): Promise<ClaudeCliStatus>;
  chooseImportFiles(): Promise<readonly string[]>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
  importFiles(
    paths: readonly string[],
    onProgress: (event: CoachOperationProgressNotificationEnvelope) => void,
  ): Promise<ImportFilesRpcResult>;
}

export interface DesktopOnboardingAuth extends OpenRouterSignInBridge {
  getDaemonConnection(): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly rendererCapability: string;
    readonly generation: number;
  }>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: OnboardingCredentialWriteInput): Promise<CredentialWriteResult>;
  signInWithIntervals(): Promise<IntervalsCredentialMutationResult>;
  cancelIntervalsSignIn(): Promise<boolean>;
  reopenIntervalsSignIn(): Promise<boolean>;
  onIntervalsSignInProgress(listener: (phase: IntervalsSignInPhase) => void): () => void;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatgptStatus(): Promise<ChatGptStatus>;
  chatgptLogin(input: ChatGptLoginInput): Promise<ChatGptLoginResult<OnboardingLlmSelection>>;
  cancelChatgptLogin(operationId: string): Promise<ChatGptCancelLoginResult>;
  onChatgptLoginProgress(listener: (progress: ChatGptLoginProgress) => void): () => void;
  claudeCliStatus(): Promise<ClaudeCliStatus>;
  claudeCliRecheck(): Promise<ClaudeCliStatus>;
  chooseImportFiles(): Promise<readonly string[]>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
}

function extension(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

export function validateImportPaths(paths: readonly string[]): readonly string[] {
  const normalized = [...paths];
  if (
    normalized.some(
      (path) =>
        typeof path !== "string" ||
        !PlatformAbsolutePathSchema.safeParse(path).success ||
        !(SUPPORTED_IMPORT_EXTENSIONS as readonly string[]).includes(extension(path)),
    )
  ) {
    throw new TypeError();
  }
  return ImportFilesRpcParamsSchema.parse({ paths: normalized }).paths;
}

export function createOnboardingBridge(
  auth: DesktopOnboardingAuth = window.enduragentAuth,
  connect: typeof connectCoachClient = connectCoachClient,
): OnboardingBridge {
  let clientPromise: Promise<CoachClient> | undefined;
  const client = (): Promise<CoachClient> => {
    if (clientPromise !== undefined) return clientPromise;
    const pending = auth
      .getDaemonConnection()
      .then(validateRendererDaemonConnection)
      .then((connection) => {
        return connect({ url: connection.url, token: connection.rendererCapability });
      })
      .catch((error: unknown) => {
        if (clientPromise === pending) clientPromise = undefined;
        throw error;
      });
    clientPromise = pending;
    return pending;
  };
  return {
    credentialStatuses: () => auth.credentialStatuses() as Promise<readonly CredentialSlotStatus[]>,
    retryFailedCredentials: () =>
      auth.retryFailedCredentials() as Promise<readonly CredentialSlotStatus[]>,
    writeCredential: (input) => auth.writeCredential(input) as Promise<CredentialWriteResult>,
    signInWithIntervals: () => auth.signInWithIntervals(),
    cancelIntervalsSignIn: () => auth.cancelIntervalsSignIn(),
    reopenIntervalsSignIn: () => auth.reopenIntervalsSignIn(),
    onIntervalsSignInProgress: (listener) => auth.onIntervalsSignInProgress(listener),
    ...openRouterSignInBridge(auth),
    llmConfiguration: () => auth.llmConfiguration(),
    applyLlmSelection: (input) => auth.applyLlmSelection(input),
    chatGptStatus: () => auth.chatgptStatus(),
    chatGptLogin: (input) => auth.chatgptLogin(input),
    cancelChatGptLogin: (operationId) => auth.cancelChatgptLogin(operationId),
    onChatGptLoginProgress: (listener) => auth.onChatgptLoginProgress(listener),
    claudeCliStatus: () => auth.claudeCliStatus(),
    claudeCliRecheck: () => auth.claudeCliRecheck(),
    chooseImportFiles: () => auth.chooseImportFiles(),
    onDroppedImportFiles: (listener) => auth.onDroppedImportFiles(listener),
    async importFiles(paths, onProgress) {
      const parsedPaths = validateImportPaths(paths);
      const connected = await client();
      try {
        return await connected.call(
          "importFiles",
          { paths: [...parsedPaths] },
          { onNotificationEnvelope: onProgress },
        );
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) clientPromise = undefined;
        throw error;
      }
    },
  };
}
