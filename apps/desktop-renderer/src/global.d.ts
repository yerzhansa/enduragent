interface EnduragentAuth {
  readonly platform: DesktopPlatformProjection;
  getDaemonConnection(failedGeneration?: number): Promise<{
    readonly url: `ws://127.0.0.1:${number}/rpc`;
    readonly rendererCapability: string;
    readonly generation: number;
  }>;
  initialSetupStatusSettled(input: { readonly generation: number }): Promise<void>;
  getTranscriptPage(input: {
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<DesktopTranscriptPage>;
  listArchivedConversations(): Promise<DesktopArchivedConversationList>;
  getArchivedTranscriptPage(input: {
    readonly boundaryRef: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<DesktopTranscriptPage>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  retryFailedCredentials(): Promise<readonly CredentialSlotStatus[]>;
  writeCredential(input: {
    readonly slot: DesktopCredentialSlot;
    readonly value: string;
    readonly selection?: OnboardingLlmSelection;
  }): Promise<CredentialWriteResult>;
  pasteIntervalsApiKeyFromClipboard(): Promise<DesktopIntervalsCredentialMutationResult>;
  deleteCredential(input: {
    readonly credential: DesktopCredentialId;
  }): Promise<CredentialDeleteResult>;
  credentialRecoveryStatus(): Promise<CredentialRecoveryStatus>;
  retryCredentialRecovery(): Promise<CredentialRecoveryStatus>;
  resetAllCredentials(): Promise<CredentialResetResult>;
  llmConfiguration(): Promise<OnboardingLlmConfiguration>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  chatgptStatus(): Promise<ChatGptStatus>;
  chatgptLogin(input: ChatGptLoginInput): Promise<ChatGptLoginResult>;
  cancelChatgptLogin(operationId: string): Promise<ChatGptCancelLoginResult>;
  onChatgptLoginProgress(listener: (progress: ChatGptLoginProgress) => void): () => void;
  claudeCliStatus(): Promise<ClaudeCliStatus>;
  claudeCliRecheck(): Promise<ClaudeCliStatus>;
  telegramStatus(): Promise<DesktopTelegramStatus>;
  pasteTelegramTokenFromClipboard(): Promise<DesktopTelegramMutationResult>;
  enableTelegram(): Promise<DesktopTelegramMutationResult>;
  disableTelegram(): Promise<DesktopTelegramMutationResult>;
  removeTelegram(): Promise<DesktopTelegramMutationResult>;
  reconcileTelegram(): Promise<DesktopTelegramMutationResult>;
  removeTelegramWebhook(): Promise<DesktopTelegramMutationResult>;
  beginTelegramPairing(): Promise<DesktopTelegramMutationResult>;
  cancelTelegramPairing(): Promise<DesktopTelegramMutationResult>;
  listTelegramAllowedSenders(): Promise<DesktopTelegramAllowedSenders>;
  addTelegramAllowedSender(input: {
    readonly senderId: number;
  }): Promise<DesktopTelegramAllowedSendersMutationResult>;
  removeTelegramAllowedSender(input: {
    readonly senderId: number;
  }): Promise<DesktopTelegramAllowedSendersMutationResult>;
  acknowledgeTelegramGapWarning(): Promise<DesktopTelegramMutationResult>;
  setAppearance(appearance: "system" | "light" | "dark"): void;
  chooseImportFiles(): Promise<readonly string[]>;
  exportTrainingFile(input: DesktopTrainingExportRequest): Promise<DesktopTrainingExportResult>;
  onDroppedImportFiles(listener: (paths: readonly string[]) => void): () => void;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  restartToUpdate(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

type DesktopPlatformProjection = import("./platform-copy").DesktopPlatformProjection;
type CredentialRecoveryStatus = import("./onboarding/bridge").CredentialRecoveryStatus;
type CredentialResetResult = import("./onboarding/bridge").CredentialResetResult;

type DesktopTrainingExportRequest =
  | {
      readonly kind: "activity";
      readonly canonicalActivityId: string;
      readonly localDate: string;
      readonly format: "fit" | "gpx";
    }
  | {
      readonly kind: "workout-archive";
      readonly oldest: string;
      readonly newest: string;
      readonly format: "zwo" | "mrc" | "erg" | "fit";
    };

type DesktopTrainingExportRefusalReason =
  | "not-configured"
  | "source-not-found"
  | "ambiguous-source"
  | "provider-unavailable"
  | "not-supported"
  | "rate-limited"
  | "network"
  | "timeout"
  | "response-too-large"
  | "invalid-response"
  | "write-failed"
  | "commit-uncertain";

type DesktopTrainingExportResult =
  | { readonly status: "cancelled" }
  | { readonly status: "saved"; readonly byteLength: number }
  | { readonly status: "refused"; readonly reason: DesktopTrainingExportRefusalReason };

interface EnduragentTrayStatus {
  readonly channelState:
    | "disabled"
    | "waiting-for-credential"
    | "starting"
    | "suspended"
    | "online"
    | "offline-retrying"
    | "conflict"
    | "invalid-token"
    | "transfer-required"
    | "failed";
  readonly gapWarning: boolean;
}

interface EnduragentTray {
  onTelegramStatus(listener: (status: EnduragentTrayStatus) => void): () => void;
}

interface DesktopTranscriptTurn {
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
}

interface DesktopArchivedConversationSummary {
  readonly boundaryRef: string;
  readonly boundaryAt: string;
  readonly reason: "explicit-reset" | "stale-reset";
  readonly turnCount: number;
}

interface DesktopArchivedConversationList {
  readonly schemaVersion: 1;
  readonly conversations: readonly DesktopArchivedConversationSummary[];
  readonly truncated: boolean;
}

type DesktopTranscriptPage =
  | {
      readonly schemaVersion: 1;
      readonly status: "page";
      readonly turns: readonly DesktopTranscriptTurn[];
      readonly nextCursor: string | null;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "restart-required";
      readonly turns: readonly [];
      readonly nextCursor: null;
    };

type DesktopUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | {
      readonly status: "downloading" | "downloaded" | "installing";
      readonly version: string;
    }
  | { readonly status: "restart-required"; readonly stage: "check" | "download" }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

type DesktopTelegramControlErrorCode =
  | "telegram-start-failed"
  | "telegram-credential-storage-failed"
  | "telegram-credential-encryption-unavailable"
  | "telegram-credential-unsafe-backend"
  | "telegram-credential-unavailable"
  | "telegram-settings-storage-uncertain"
  | "telegram-daemon-unavailable"
  | "telegram-home-mismatch"
  | "telegram-stale-operation"
  | "telegram-control-failed"
  | "telegram-drain-required";

type DesktopTelegramChannel =
  | { readonly desiredState: "disabled"; readonly state: "disabled" }
  | {
      readonly desiredState: "enabled";
      readonly state:
        | "waiting-for-credential"
        | "starting"
        | "suspended"
        | "online"
        | "offline-retrying"
        | "transfer-required";
    }
  | {
      readonly desiredState: "enabled";
      readonly state: "invalid-token";
      readonly errorCode: "telegram-invalid-token";
    }
  | {
      readonly desiredState: "enabled";
      readonly state: "conflict";
      readonly errorCode: "telegram-polling-conflict";
    }
  | {
      readonly desiredState: "disabled" | "enabled";
      readonly state: "failed";
      readonly errorCode: DesktopTelegramControlErrorCode;
    };

type DesktopTelegramBot =
  | { readonly state: "unconfigured" }
  | {
      readonly state: "ready" | "webhook-removal-required";
      readonly username: string;
    };

type DesktopTelegramPairing =
  | { readonly state: "unpaired" | "paired" | "expired" }
  | { readonly state: "awaiting-code"; readonly code: string; readonly expiresAt: string }
  | {
      readonly state: "failed";
      readonly errorCode:
        | "telegram-pairing-unavailable"
        | "telegram-pairing-refused"
        | "telegram-pairing-storage-failed"
        | "telegram-pairing-storage-uncertain";
    };

interface DesktopTelegramStatus {
  readonly channel: DesktopTelegramChannel;
  readonly bot: DesktopTelegramBot;
  readonly pairing: DesktopTelegramPairing;
  readonly credentialConfigured: boolean;
  readonly gapWarning:
    | { readonly state: "clear" }
    | { readonly state: "possible-message-loss"; readonly detectedAt: string };
}

type DesktopTelegramMutationRefusalReason =
  | "clipboard-unavailable"
  | "clipboard-clear-failed"
  | "invalid-token-format"
  | "invalid-token"
  | "validation-unavailable"
  | "webhook-removal-required"
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed"
  | "stale-operation"
  | "transfer-required"
  | "polling-conflict"
  | "control-unavailable"
  | "invalid-state";

type DesktopTelegramMutationResult =
  | { readonly outcome: "applied"; readonly current: DesktopTelegramStatus }
  | {
      readonly outcome: "refused";
      readonly reason: DesktopTelegramMutationRefusalReason;
      readonly current: DesktopTelegramStatus;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain" | "control-uncertain";
      readonly current: DesktopTelegramStatus;
    };

interface DesktopTelegramAllowedSender {
  readonly senderId: number;
  readonly role: "primary" | "additional";
  readonly addedAt?: string;
}

interface DesktopTelegramAllowedSenders {
  readonly senders: readonly DesktopTelegramAllowedSender[];
}

type DesktopTelegramAllowedSendersMutationResult =
  | { readonly outcome: "applied"; readonly current: DesktopTelegramAllowedSenders }
  | { readonly outcome: "refused"; readonly reason: "invalid-state" | "control-unavailable" }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain" | "control-uncertain";
    };

type DesktopCredentialSlot =
  | "anthropic"
  | "openrouter"
  | "openai"
  | "google"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "kimi"
  | "zai"
  | "intervals-icu";

type DesktopCredentialId = DesktopCredentialSlot | "openai-codex";

type LlmProvider =
  | Exclude<DesktopCredentialSlot, "intervals-icu">
  | "openai-codex"
  | "claude-cli"
  | "codex-agent";

interface OnboardingLlmModelOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

interface OnboardingLlmProviderConfiguration {
  readonly provider: LlmProvider;
  readonly defaultModel: string;
  readonly models: readonly OnboardingLlmModelOption[];
  readonly defaultBaseUrl?: string;
}

interface OnboardingLlmConfiguration {
  readonly schemaVersion: 1;
  readonly providers: readonly OnboardingLlmProviderConfiguration[];
  readonly active: {
    readonly provider: LlmProvider;
    readonly model: string;
  } | null;
}

type OnboardingLlmEndpointSelection =
  | { readonly mode: "automatic" }
  | { readonly mode: "default" }
  | { readonly mode: "custom"; readonly value: string };

interface OnboardingLlmSelection {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly endpoint: OnboardingLlmEndpointSelection;
}

interface ChatGptLoginInput {
  readonly operationId: string;
  readonly selection: OnboardingLlmSelection;
}

type OnboardingLlmSelectionResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | {
      readonly status: "refused";
      readonly reason: "invalid-input" | "credential-required" | "runtime-unavailable";
    };

type CredentialState = "missing" | "configured" | "re-prompt";
type CredentialRuntimeState = "active" | "stored-inactive" | "failed";

interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

interface ChatGptStatus {
  readonly state: "configured" | "absent";
  readonly runtimeReady: boolean;
}

type ClaudeCliState =
  | "absent-binary"
  | "not-logged-in"
  | "api-key-token"
  | "ready"
  | "ready-api-key"
  | "disabled"
  | "working-area-unavailable";

interface ClaudeCliStatus {
  readonly state: ClaudeCliState;
  readonly email?: string;
  readonly plan?: string;
  readonly version?: string;
}

type ChatGptLoginResult =
  | { readonly status: "stored"; readonly operationId: string }
  | {
      readonly status: "refused";
      readonly operationId: string;
      readonly reason:
        | "already-in-progress"
        | "callback-unavailable"
        | "timed-out"
        | "cancelled"
        | "exchange-failed"
        | "storage-failed"
        | "runtime-unavailable";
    };

interface ChatGptLoginProgress {
  readonly operationId: string;
  readonly phase: "waiting-for-browser" | "completing-sign-in";
}

interface ChatGptCancelLoginResult {
  readonly status: "cancelling" | "not-active";
  readonly operationId: string;
}

type CredentialWriteResult =
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

type CredentialDeleteResult =
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

interface DesktopIntervalsCredentialStatus {
  readonly slot: "intervals-icu";
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

type DesktopIntervalsCredentialMutationRefusalReason =
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

type DesktopIntervalsCredentialMutationResult =
  | {
      readonly outcome: "applied";
      readonly current: DesktopIntervalsCredentialStatus;
    }
  | {
      readonly outcome: "refused";
      readonly reason: DesktopIntervalsCredentialMutationRefusalReason;
      readonly current: DesktopIntervalsCredentialStatus;
    }
  | {
      readonly outcome: "uncertain";
      readonly reason: "storage-uncertain" | "runtime-uncertain";
      readonly current: DesktopIntervalsCredentialStatus;
    };

interface Window {
  readonly enduragentAuth: EnduragentAuth;
  readonly enduragentTray: EnduragentTray;
}

interface WindowEventMap {
  readonly "enduragent-lifecycle": CustomEvent<{
    readonly status: "ready" | "recovering" | "terminal" | "closing";
    readonly generation: number;
  }>;
}

declare const __ENDURAGENT_APP_VERSION__: string;

declare module "*.css" {}
