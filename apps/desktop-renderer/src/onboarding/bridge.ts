import type { CoachClient } from "@enduragent/coach-client";
import { CoachClientDisconnectedError, connectCoachClient } from "@enduragent/coach-client";
import {
  ImportFilesRpcParamsSchema,
  PlatformAbsolutePathSchema,
  SaveIntakeRpcParamsSchema,
  type GetSetupStatusRpcResult,
  type CoachOperationProgressNotificationEnvelope,
  type ImportFilesRpcResult,
  type LlmProvider,
  type SaveIntakeRpcParams,
} from "@enduragent/coach-contract";
import { validateRendererDaemonConnection } from "../daemon-connection.js";
import { SUPPORTED_IMPORT_EXTENSIONS, type DesktopCredentialSlot } from "./constants.js";
import type {
  ChatGptCancelLoginResult,
  ChatGptLoginProgress,
  ChatGptLoginResult,
  ChatGptStatus,
  ClaudeCliStatus,
  CredentialRuntimeState,
  CredentialState,
  CredentialSlotStatus,
} from "./machine.js";

export type CredentialWriteResult =
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "configured";
      readonly runtimeReady: boolean;
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
      readonly credential: DesktopCredentialId;
      readonly status: "deleted";
      readonly cleanupPending: boolean;
    }
  | {
      readonly credential: DesktopCredentialId;
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "managed-by-environment"
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
  | "clipboard-unavailable"
  | "clipboard-clear-failed"
  | "invalid-key-format"
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

export type IntervalsCredentialMutationResult =
  | {
      readonly outcome: "applied";
      readonly current: IntervalsCredentialStatus;
    }
  | {
      readonly outcome: "refused";
      readonly reason: IntervalsCredentialMutationRefusalReason;
      readonly current: IntervalsCredentialStatus;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain" | "runtime-uncertain";
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

export interface OnboardingLlmConfiguration {
  readonly schemaVersion: 1;
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: {
    readonly provider: LlmProvider;
    readonly model: string;
  } | null;
}

export type OnboardingLlmEndpointSelection =
  | { readonly mode: "automatic" }
  | { readonly mode: "default" }
  | { readonly mode: "custom"; readonly value: string };

export interface OnboardingLlmSelection {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly endpoint: OnboardingLlmEndpointSelection;
}

export type OnboardingLlmSelectionResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
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

export interface OnboardingBridge {
  getSetupStatus?(): Promise<GetSetupStatusRpcResult>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: OnboardingCredentialWriteInput): Promise<CredentialWriteResult>;
  pasteIntervalsApiKeyFromClipboard(): Promise<IntervalsCredentialMutationResult>;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatGptStatus(): Promise<ChatGptStatus>;
  chatGptLogin(input: ChatGptLoginInput): Promise<ChatGptLoginResult>;
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
  saveIntake(input: SaveIntakeRpcParams): Promise<void>;
}

export interface DesktopOnboardingAuth {
  getDaemonConnection(): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly rendererCapability: string;
    readonly generation: number;
  }>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: OnboardingCredentialWriteInput): Promise<CredentialWriteResult>;
  pasteIntervalsApiKeyFromClipboard(): Promise<IntervalsCredentialMutationResult>;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatgptStatus(): Promise<ChatGptStatus>;
  chatgptLogin(input: ChatGptLoginInput): Promise<ChatGptLoginResult>;
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
  auth: DesktopOnboardingAuth = (
    window as unknown as Window & { readonly enduragentAuth: DesktopOnboardingAuth }
  ).enduragentAuth,
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
    pasteIntervalsApiKeyFromClipboard: () => auth.pasteIntervalsApiKeyFromClipboard(),
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
    async saveIntake(input) {
      const connected = await client();
      try {
        const result = await connected.call("saveIntake", SaveIntakeRpcParamsSchema.parse(input));
        if (!result.saved) throw new TypeError();
      } catch (error) {
        if (error instanceof CoachClientDisconnectedError) clientPromise = undefined;
        throw error;
      }
    },
  };
}
