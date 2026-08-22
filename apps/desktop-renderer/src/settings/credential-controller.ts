import { CoachClientDisconnectedError, type CoachClient } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client.js";
import type {
  CredentialDeleteResult,
  CredentialRecoveryStatus,
  CredentialResetResult,
  DesktopCredentialId,
} from "../onboarding/bridge.js";
import type { ClaudeCliState } from "../onboarding/constants.js";
import {
  claudeCliIdentityLine,
  claudeCliPresentation,
} from "../onboarding/credential-presentation.js";
import type {
  ChatGptStatus,
  ClaudeCliStatus,
  CredentialSlotStatus,
} from "../onboarding/machine.js";

export type CredentialKind = "Provider API key" | "ChatGPT profile" | "Training account key";

export interface CredentialSettingsEntry {
  readonly credential: DesktopCredentialId;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly runtimeState: "active" | "verifying" | "stored-inactive" | "failed";
}

export const NON_CREDENTIAL_PROVIDERS = ["claude-cli", "codex-agent"] as const;

export type NonCredentialProviderId = (typeof NON_CREDENTIAL_PROVIDERS)[number];

export type NonCredentialProviderKind = "Claude Code CLI" | "Codex CLI";

export interface ProviderStatusEntry {
  readonly provider: NonCredentialProviderId;
  readonly label: string;
  readonly kind: NonCredentialProviderKind;
  readonly state: ClaudeCliState | null;
  readonly identity: string | null;
}

const NON_CREDENTIAL_PROVIDER_ROWS: Readonly<
  Record<NonCredentialProviderId, Pick<ProviderStatusEntry, "provider" | "label" | "kind">>
> = {
  "claude-cli": {
    provider: "claude-cli",
    label: "Claude subscription",
    kind: "Claude Code CLI",
  },
  "codex-agent": {
    provider: "codex-agent",
    label: "Codex agent",
    kind: "Codex CLI",
  },
};

function isNonCredentialProvider(provider: string): provider is NonCredentialProviderId {
  return (NON_CREDENTIAL_PROVIDERS as readonly string[]).includes(provider);
}

export type CredentialSettingsFocus =
  | { readonly target: "confirmation-cancel" | "confirmation-delete" }
  | { readonly target: "feedback" }
  | { readonly target: "setup"; readonly credential: DesktopCredentialId }
  | { readonly target: "setup-open" }
  | { readonly target: "delete"; readonly credential: DesktopCredentialId }
  | null;

interface CredentialSettingsContent {
  readonly entries: readonly CredentialSettingsEntry[];
  readonly providerStatuses: readonly ProviderStatusEntry[];
  readonly confirmation: DesktopCredentialId | "all" | null;
  readonly announcement: string;
  readonly recovery: CredentialRecoveryStatus;
  readonly repairCredential: DesktopCredentialId | null;
  readonly recoveryAvailable: boolean;
  readonly focus: CredentialSettingsFocus;
}

export type CredentialSettingsState =
  | {
      readonly status: "closed";
      readonly repairCredential?: DesktopCredentialId | null;
    }
  | {
      readonly status: "loading";
      readonly announcement: string;
      readonly repairCredential: DesktopCredentialId | null;
      readonly recoveryAvailable: boolean;
      readonly focus: CredentialSettingsFocus;
    }
  | ({
      readonly status: "ready" | "confirming" | "deleting" | "deleted";
    } & CredentialSettingsContent)
  | ({
      readonly status: "error";
      readonly kind: "delete";
      readonly reason: Exclude<CredentialDeleteResult, { readonly status: "deleted" }>["reason"];
    } & CredentialSettingsContent)
  | {
      readonly status: "error";
      readonly kind: "load";
      readonly announcement: string;
      readonly repairCredential: DesktopCredentialId | null;
      readonly recoveryAvailable: boolean;
      readonly focus: CredentialSettingsFocus;
    };

export function repairRequiredCredential(
  state: CredentialSettingsState,
): DesktopCredentialId | null {
  return state.status === "closed" ? (state.repairCredential ?? null) : state.repairCredential;
}

export function credentialChangesBlocked(
  state: CredentialSettingsState,
  settingsMutationActive: boolean,
): boolean {
  if (settingsMutationActive || repairRequiredCredential(state) !== null) return true;
  if (
    state.status === "ready" ||
    state.status === "confirming" ||
    state.status === "deleting" ||
    state.status === "deleted" ||
    (state.status === "error" && state.kind === "delete")
  ) {
    return state.confirmation !== null || state.recovery.state !== "ready";
  }
  return false;
}

export interface CredentialSettingsView {
  bind(handlers: {
    readonly onRetry: () => void;
    readonly onRequestDelete: (credential: DesktopCredentialId) => void;
    readonly onRequestReset: () => void;
    readonly onCancelDelete: () => void;
    readonly onConfirmDelete: () => void;
    readonly onSetupOpened: () => void;
    readonly onOpenSetup: () => void;
  }): void;
  render(state: Exclude<CredentialSettingsState, { readonly status: "closed" }>): void;
  dispose(): void;
}

export interface CredentialSettingsController {
  activate(): Promise<void>;
  close(): void;
  state(): CredentialSettingsState;
  dispose(): void;
}

const PROVIDER_NAMES: Readonly<Record<DesktopCredentialId, string>> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  minimax: "MiniMax",
  kimi: "Kimi",
  zai: "Z.AI",
  "openai-codex": "ChatGPT",
  "intervals-icu": "intervals.icu",
};

const CREDENTIAL_ORDER: readonly DesktopCredentialId[] = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
  "intervals-icu",
];

const UNCERTAIN_DELETE_ANNOUNCEMENT =
  "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.";

function recoveryCopy(recovery: CredentialRecoveryStatus): string {
  if (recovery.state === "locked") {
    return "Unlock your login Keychain outside Enduragent, then Retry.";
  }
  if (recovery.state === "missing") {
    return "These credentials cannot be recovered. Remove all credentials and start again.";
  }
  if (recovery.state === "unavailable") {
    return "Secure credential storage is unavailable. Retry, or remove all credentials and start again.";
  }
  return "unverifiedEnvelopes" in recovery && recovery.unverifiedEnvelopes > 0
    ? "Enduragent can’t open some saved credentials safely. Enter each affected credential again."
    : "";
}

function kind(credential: DesktopCredentialId): CredentialKind {
  if (credential === "openai-codex") return "ChatGPT profile";
  if (credential === "intervals-icu") return "Training account key";
  return "Provider API key";
}

function entriesFrom(
  statuses: readonly CredentialSlotStatus[],
  chatGpt: ChatGptStatus,
  runtime: RuntimeConfigSnapshot,
): readonly CredentialSettingsEntry[] {
  const entries = new Map<DesktopCredentialId, CredentialSettingsEntry>();
  const intervalsVerifying =
    runtime.intervals.credential_configured &&
    runtime.intervals.credential_verification_pending === true;
  for (const status of statuses) {
    if (status.state === "missing") continue;
    const runtimeActive =
      status.slot === "intervals-icu"
        ? runtime.intervals.credential_configured
        : runtime.llm.credential_configured && runtime.llm.provider === status.slot;
    entries.set(status.slot, {
      credential: status.slot,
      provider: PROVIDER_NAMES[status.slot],
      kind: kind(status.slot),
      runtimeState:
        status.state === "re-prompt" || status.runtimeState === "failed"
          ? "failed"
          : runtimeActive
            ? status.slot === "intervals-icu" && intervalsVerifying
              ? "verifying"
              : "active"
            : "stored-inactive",
    });
  }
  if (chatGpt.state === "configured") {
    entries.set("openai-codex", {
      credential: "openai-codex",
      provider: PROVIDER_NAMES["openai-codex"],
      kind: kind("openai-codex"),
      runtimeState: chatGpt.runtimeReady ? "active" : "stored-inactive",
    });
  }
  if (
    runtime.llm.credential_configured &&
    !isNonCredentialProvider(runtime.llm.provider) &&
    !entries.has(runtime.llm.provider)
  ) {
    const credential: DesktopCredentialId = runtime.llm.provider;
    entries.set(credential, {
      credential,
      provider: PROVIDER_NAMES[credential],
      kind: kind(credential),
      runtimeState: "active",
    });
  }
  if (runtime.intervals.credential_configured && !entries.has("intervals-icu")) {
    entries.set("intervals-icu", {
      credential: "intervals-icu",
      provider: PROVIDER_NAMES["intervals-icu"],
      kind: kind("intervals-icu"),
      runtimeState: intervalsVerifying ? "verifying" : "active",
    });
  }
  return CREDENTIAL_ORDER.flatMap((credential) => {
    const entry = entries.get(credential);
    return entry === undefined ? [] : [entry];
  });
}

export function providerStatusesFrom(
  runtime: RuntimeConfigSnapshot,
  claudeCli: ClaudeCliStatus | null = null,
): readonly ProviderStatusEntry[] {
  const provider = runtime.llm.provider;
  if (!isNonCredentialProvider(provider)) return [];
  if (provider === "codex-agent") {
    return [{ ...NON_CREDENTIAL_PROVIDER_ROWS[provider], state: null, identity: null }];
  }
  const state = claudeCli?.state ?? null;
  const identity = claudeCli === null ? null : claudeCliIdentityLine(claudeCli);
  return [
    {
      ...NON_CREDENTIAL_PROVIDER_ROWS[provider],
      state,
      identity: identity ?? claudeCliPresentation(state).detail,
    },
  ];
}

function refusalCopy(
  reason: Extract<CredentialDeleteResult, { readonly status: "refused" }>["reason"],
): string {
  if (reason === "managed-by-environment") {
    return "This credential is managed outside Settings and can’t be deleted here.";
  }
  if (reason === "not-found") {
    return "That credential is no longer stored. Reload to refresh the list.";
  }
  if (reason === "storage-failed") {
    return "The credential remains stored. No deletion was completed. Try again.";
  }
  if (reason === "runtime-state-diverged") {
    return "The saved and active credential states could not be reconciled. Reconnect and reload before trying again.";
  }
  return "The coach could not stop using this credential safely. It was not deleted.";
}

export function createCredentialSettingsController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly loadStatuses: () => Promise<readonly CredentialSlotStatus[]>;
  readonly loadChatGptStatus: () => Promise<ChatGptStatus>;
  readonly loadRecoveryStatus?: () => Promise<CredentialRecoveryStatus>;
  readonly retryCredentialRecovery?: () => Promise<CredentialRecoveryStatus>;
  readonly resetAllCredentials?: () => Promise<CredentialResetResult>;
  readonly loadClaudeCliStatus?: () => Promise<ClaudeCliStatus>;
  readonly deleteCredential: (input: {
    readonly credential: DesktopCredentialId;
  }) => Promise<CredentialDeleteResult>;
  readonly openSetup: () => void;
  readonly onDeleted?: () => Promise<void> | void;
  readonly onReconciled?: () => Promise<void> | void;
  readonly credentialMutationsBlocked?: () => boolean;
  readonly beginMutation: () => (() => void) | null;
  readonly view: CredentialSettingsView;
}): CredentialSettingsController {
  let currentState: CredentialSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let operation: Promise<void> | undefined;
  let reconnectRequired = false;
  let failedClient: CoachClient | undefined;

  const render = (state: Exclude<CredentialSettingsState, { readonly status: "closed" }>): void => {
    currentState = state;
    input.view.render(state);
  };

  const runtimeClient = async (): Promise<CoachClient> => {
    if (!reconnectRequired) return input.clients.getClient();
    const current = await input.clients.getClient();
    const client =
      failedClient !== undefined && current === failedClient
        ? await input.clients.reconnect()
        : current;
    reconnectRequired = false;
    failedClient = undefined;
    return client;
  };

  const loadEntries = async (): Promise<{
    readonly entries: readonly CredentialSettingsEntry[];
    readonly providerStatuses: readonly ProviderStatusEntry[];
    readonly recovery: CredentialRecoveryStatus;
  }> => {
    const client = await runtimeClient();
    try {
      const [statuses, chatGpt, runtime, recovery] = await Promise.all([
        input.loadStatuses(),
        input.loadChatGptStatus(),
        client.call("getRuntimeConfig", {}),
        input.loadRecoveryStatus?.() ??
          Promise.resolve({ state: "ready" as const, unverifiedEnvelopes: 0 }),
      ]);
      const loadClaudeCli = input.loadClaudeCliStatus;
      const claudeCli =
        loadClaudeCli === undefined || runtime.llm.provider !== "claude-cli"
          ? null
          : await loadClaudeCli().catch(() => null);
      return {
        entries: entriesFrom(statuses, chatGpt, runtime),
        providerStatuses: providerStatusesFrom(runtime, claudeCli),
        recovery,
      };
    } catch (error) {
      if (error instanceof CoachClientDisconnectedError) {
        reconnectRequired = true;
        failedClient = client;
      }
      throw error;
    }
  };

  const startLoad = (retryRecovery = false): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const repairCredential = repairRequiredCredential(currentState);
    const repairAnnouncement =
      repairCredential === null
        ? ""
        : "announcement" in currentState && currentState.announcement.length > 0
          ? currentState.announcement
          : UNCERTAIN_DELETE_ANNOUNCEMENT;
    const operationGeneration = ++generation;
    render({
      status: "loading",
      announcement: repairAnnouncement,
      repairCredential,
      recoveryAvailable: false,
      focus: repairCredential === null ? null : { target: "feedback" },
    });
    const pending = (async () => {
      try {
        if (retryRecovery) await input.retryCredentialRecovery?.();
        const loaded = await loadEntries();
        if (disposed || generation !== operationGeneration) return;
        if (repairCredential !== null) await input.onReconciled?.();
        if (disposed || generation !== operationGeneration) return;
        render({
          status: "ready",
          entries: loaded.entries,
          providerStatuses: loaded.providerStatuses,
          confirmation: null,
          announcement: recoveryCopy(loaded.recovery),
          recovery: loaded.recovery,
          repairCredential: null,
          recoveryAvailable: false,
          focus:
            repairCredential === null ? null : { target: "setup", credential: repairCredential },
        });
      } catch {
        if (disposed || generation !== operationGeneration) return;
        render({
          status: "error",
          kind: "load",
          announcement:
            repairAnnouncement.length === 0
              ? "Saved credentials aren’t available. Reconnect and reload."
              : repairAnnouncement,
          repairCredential,
          recoveryAvailable: false,
          focus: repairCredential === null ? null : { target: "feedback" },
        });
      }
    })().finally(() => {
      if (operation === pending) operation = undefined;
    });
    operation = pending;
    return pending;
  };

  const contentState = (): Extract<CredentialSettingsState, CredentialSettingsContent> | null => {
    if (
      currentState.status === "ready" ||
      currentState.status === "confirming" ||
      currentState.status === "deleting" ||
      currentState.status === "deleted" ||
      (currentState.status === "error" && currentState.kind === "delete")
    ) {
      return currentState;
    }
    return null;
  };

  const showDeleteConfirmation = (credential: DesktopCredentialId): boolean => {
    const content = contentState();
    if (
      content === null ||
      content.repairCredential !== null ||
      !content.entries.some((entry) => entry.credential === credential)
    ) {
      return false;
    }
    render({
      status: "confirming",
      entries: content.entries,
      providerStatuses: content.providerStatuses,
      confirmation: credential,
      announcement: `Confirm deletion of the ${PROVIDER_NAMES[credential]} credential.`,
      recovery: content.recovery,
      repairCredential: content.repairCredential,
      recoveryAvailable: content.recoveryAvailable,
      focus: { target: "confirmation-cancel" },
    });
    return true;
  };

  const requestDelete = (credential: DesktopCredentialId): void => {
    if (
      disposed ||
      operation !== undefined ||
      input.credentialMutationsBlocked?.() ||
      repairRequiredCredential(currentState) !== null
    ) {
      return;
    }
    if (showDeleteConfirmation(credential)) return;
    if (credential !== "intervals-icu") return;
    const content = contentState();
    if (content?.entries.some((entry) => entry.credential === credential)) return;
    void (async () => {
      await startLoad();
      if (
        disposed ||
        operation !== undefined ||
        input.credentialMutationsBlocked?.() ||
        repairRequiredCredential(currentState) !== null
      ) {
        return;
      }
      showDeleteConfirmation(credential);
    })();
  };

  const requestReset = (): void => {
    if (disposed || operation !== undefined || input.credentialMutationsBlocked?.()) return;
    const content = contentState();
    if (
      content === null ||
      content.confirmation !== null ||
      (content.entries.length === 0 &&
        content.recovery.state === "ready" &&
        content.recovery.unverifiedEnvelopes === 0)
    ) {
      return;
    }
    render({
      status: "confirming",
      entries: content.entries,
      providerStatuses: content.providerStatuses,
      confirmation: "all",
      announcement: "Confirm removal of all credentials.",
      recovery: content.recovery,
      repairCredential: content.repairCredential,
      recoveryAvailable: content.recoveryAvailable,
      focus: { target: "confirmation-cancel" },
    });
  };

  const cancelDelete = (): void => {
    if (disposed || operation !== undefined) return;
    const content = contentState();
    if (content === null || content.confirmation === null) return;
    const credential = content.confirmation;
    render({
      status: "ready",
      entries: content.entries,
      providerStatuses: content.providerStatuses,
      confirmation: null,
      announcement:
        credential === "all" ? "Credential removal cancelled." : "Credential deletion cancelled.",
      recovery: content.recovery,
      repairCredential: content.repairCredential,
      recoveryAvailable: content.recoveryAvailable,
      focus: credential === "all" ? { target: "feedback" } : { target: "delete", credential },
    });
  };

  const confirmReset = (): Promise<void> => {
    const content = contentState();
    if (content === null || content.confirmation !== "all") return Promise.resolve();
    const releaseMutation = input.beginMutation();
    if (releaseMutation === null) return Promise.resolve();
    const operationGeneration = ++generation;
    render({
      status: "deleting",
      entries: content.entries,
      providerStatuses: content.providerStatuses,
      confirmation: "all",
      announcement: "Removing all credentials…",
      recovery: content.recovery,
      repairCredential: content.repairCredential,
      recoveryAvailable: content.recoveryAvailable,
      focus: { target: "confirmation-delete" },
    });
    const pending = (async () => {
      let result: CredentialResetResult;
      try {
        result = (await input.resetAllCredentials?.()) ?? {
          status: "refused",
          reason: "storage-failed",
        };
      } catch {
        result = { status: "refused", reason: "storage-failed" };
      }
      if (disposed || generation !== operationGeneration) return;
      if (result.status === "refused") {
        releaseMutation();
        render({
          status: "ready",
          entries: content.entries,
          providerStatuses: content.providerStatuses,
          confirmation: null,
          announcement:
            result.reason === "runtime-unavailable"
              ? "Enduragent could not stop every active credential. Retry to finish removing credentials."
              : "Enduragent could not remove every stored credential. Retry.",
          recovery: content.recovery,
          repairCredential: content.repairCredential,
          recoveryAvailable: content.recoveryAvailable,
          focus: { target: "feedback" },
        });
        return;
      }
      let loaded: Awaited<ReturnType<typeof loadEntries>>;
      try {
        loaded = await loadEntries();
        await input.onDeleted?.();
      } catch {
        if (disposed || generation !== operationGeneration) return;
        releaseMutation();
        render({
          status: "error",
          kind: "load",
          announcement:
            "Credentials were removed, but Settings could not reload. Reconnect and reload.",
          repairCredential: null,
          recoveryAvailable: true,
          focus: { target: "feedback" },
        });
        return;
      }
      if (disposed || generation !== operationGeneration) return;
      releaseMutation();
      render({
        status: "deleted",
        entries: loaded.entries,
        providerStatuses: loaded.providerStatuses,
        confirmation: null,
        announcement: result.keyCleanupPending
          ? "All credentials were removed. Secure storage cleanup will be retried."
          : "All credentials were removed. Set them up again when you’re ready.",
        recovery: loaded.recovery,
        repairCredential: null,
        recoveryAvailable: true,
        focus: { target: "setup-open" },
      });
    })().finally(() => {
      releaseMutation();
      if (operation === pending) operation = undefined;
    });
    operation = pending;
    return pending;
  };

  const confirmDelete = (): Promise<void> => {
    if (disposed || operation !== undefined || input.credentialMutationsBlocked?.()) {
      return operation ?? Promise.resolve();
    }
    const content = contentState();
    if (content === null || content.confirmation === null) {
      return Promise.resolve();
    }
    if (content.confirmation === "all") return confirmReset();
    if (content.repairCredential !== null) return Promise.resolve();
    const target = content.entries.find((entry) => entry.credential === content.confirmation);
    if (target === undefined) return Promise.resolve();
    const releaseMutation = input.beginMutation();
    if (releaseMutation === null) return Promise.resolve();
    const credential = target.credential;
    const operationGeneration = ++generation;
    render({
      status: "deleting",
      entries: content.entries,
      providerStatuses: content.providerStatuses,
      confirmation: credential,
      announcement: `Deleting the ${target.provider} credential locally…`,
      recovery: content.recovery,
      repairCredential: content.repairCredential,
      recoveryAvailable: content.recoveryAvailable,
      focus: { target: "confirmation-delete" },
    });
    const pending = (async () => {
      let result: CredentialDeleteResult;
      try {
        result = await input.deleteCredential({ credential });
      } catch {
        if (disposed || generation !== operationGeneration) return;
        releaseMutation();
        render({
          status: "error",
          kind: "delete",
          reason: "storage-uncertain",
          entries: content.entries,
          providerStatuses: content.providerStatuses,
          confirmation: null,
          announcement: UNCERTAIN_DELETE_ANNOUNCEMENT,
          recovery: content.recovery,
          repairCredential: credential,
          recoveryAvailable: content.recoveryAvailable,
          focus: { target: "feedback" },
        });
        return;
      }
      if (result.status === "uncertain") {
        if (disposed || generation !== operationGeneration) return;
        releaseMutation();
        render({
          status: "error",
          kind: "delete",
          reason: "storage-uncertain",
          entries: content.entries,
          providerStatuses: content.providerStatuses,
          confirmation: null,
          announcement: UNCERTAIN_DELETE_ANNOUNCEMENT,
          recovery: content.recovery,
          repairCredential: credential,
          recoveryAvailable: content.recoveryAvailable,
          focus: { target: "feedback" },
        });
        return;
      }
      let entries = content.entries;
      let providerStatuses = content.providerStatuses;
      let recovery = content.recovery;
      let refreshFailed = false;
      try {
        const loaded = await loadEntries();
        entries = loaded.entries;
        providerStatuses = loaded.providerStatuses;
        recovery = loaded.recovery;
      } catch {
        refreshFailed = true;
        if (result.status === "deleted") {
          entries = entries.filter((entry) => entry.credential !== credential);
        }
      }
      if (disposed || generation !== operationGeneration) return;
      if (result.status === "refused") {
        const repairRequired = result.reason === "runtime-state-diverged";
        releaseMutation();
        render({
          status: "error",
          kind: "delete",
          reason: result.reason,
          entries,
          providerStatuses,
          confirmation: null,
          announcement: refusalCopy(result.reason),
          recovery,
          repairCredential: repairRequired ? credential : content.repairCredential,
          recoveryAvailable: content.recoveryAvailable || repairRequired,
          focus: repairRequired ? { target: "feedback" } : { target: "delete", credential },
        });
        return;
      }
      try {
        await input.onDeleted?.();
      } catch {
        if (disposed || generation !== operationGeneration) return;
        releaseMutation();
        render({
          status: "error",
          kind: "load",
          announcement:
            "Credential deleted locally, but setup readiness couldn’t be refreshed. Reload credential status.",
          repairCredential: credential,
          recoveryAvailable: content.recoveryAvailable || target.runtimeState === "active",
          focus: { target: "feedback" },
        });
        return;
      }
      if (disposed || generation !== operationGeneration) return;
      releaseMutation();
      const recoveryAvailable = content.recoveryAvailable || target.runtimeState === "active";
      const nextDelete = entries[0]?.credential;
      render({
        status: "deleted",
        entries,
        providerStatuses,
        confirmation: null,
        announcement: result.cleanupPending
          ? "Credential deleted locally. Secure storage cleanup will be retried."
          : refreshFailed
            ? "Credential deleted locally. Current credential status couldn’t be refreshed."
            : "Credential deleted locally.",
        recovery,
        repairCredential: null,
        recoveryAvailable,
        focus:
          credential === "intervals-icu"
            ? { target: "setup-open" }
            : recoveryAvailable
              ? { target: "setup", credential }
              : nextDelete === undefined
                ? null
                : { target: "delete", credential: nextDelete },
      });
    })().finally(() => {
      releaseMutation();
      if (operation === pending) operation = undefined;
    });
    operation = pending;
    return pending;
  };

  const openSetup = (): void => {
    const content = contentState();
    if (disposed || operation !== undefined || content?.recoveryAvailable !== true) return;
    currentState = { status: "closed" };
    input.openSetup();
  };

  const setupOpened = (): void => {
    const content = contentState();
    if (content === null || content.focus?.target !== "setup-open") return;
    render({ ...content, focus: null });
  };

  const close = (): void => {
    if (disposed) return;
    ++generation;
    operation = undefined;
    const repairCredential = repairRequiredCredential(currentState);
    currentState = {
      status: "closed",
      ...(repairCredential === null ? {} : { repairCredential }),
    };
  };

  input.view.bind({
    onRetry: () => {
      const recovery = contentState()?.recovery;
      void startLoad(recovery?.state === "locked" || recovery?.state === "unavailable");
    },
    onRequestDelete: requestDelete,
    onRequestReset: requestReset,
    onCancelDelete: cancelDelete,
    onConfirmDelete: () => void confirmDelete(),
    onSetupOpened: setupOpened,
    onOpenSetup: openSetup,
  });

  return {
    activate() {
      if (disposed) return Promise.resolve();
      if (currentState.status !== "closed") return operation ?? Promise.resolve();
      return startLoad();
    },
    close,
    state: () => currentState,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      operation = undefined;
      currentState = { status: "closed" };
      input.view.dispose();
    },
  };
}
