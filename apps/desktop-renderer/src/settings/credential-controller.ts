import type { DesktopCoachClientProvider } from "../coach-client";
import type {
  CredentialDeleteResult,
  CredentialRecoveryStatus,
  CredentialResetResult,
  DesktopCredentialId,
} from "../onboarding/bridge";
import { DESKTOP_CREDENTIAL_SLOTS } from "../onboarding/constants";
import type { ChatGptStatus, ClaudeCliStatus, CredentialSlotStatus } from "../onboarding/machine";
import {
  createCredentialEntriesReader,
  PROVIDER_NAMES,
  type CredentialSettingsEntry,
} from "./credential-entries";
import {
  deleteCancelledCopy,
  deleteConfirmCopy,
  deletedCopy,
  deletedSetupRefreshFailedCopy,
  deletingCopy,
  recoveryCopy,
  refusalCopy,
  UNCERTAIN_DELETE_ANNOUNCEMENT,
} from "./credential-delete-copy";
import {
  createCredentialRepairRetry,
  RECONNECTING_ANNOUNCEMENT,
  repairCredentialId,
  repairNeedsAthlete,
  repairRetrying,
  type CredentialRepair,
} from "./credential-repair";
import type { ProviderStatusEntry } from "./provider-status-rows";

export {
  belongsInPrimaryAiRow,
  type CredentialKind,
  type CredentialSettingsEntry,
} from "./credential-entries";

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
  readonly repairCredential: CredentialRepair | null;
  readonly recoveryAvailable: boolean;
  readonly focus: CredentialSettingsFocus;
}

export type CredentialSettingsState = {
  readonly resetUncertain?: boolean;
} & (
  | {
      readonly status: "closed";
      readonly repairCredential?: CredentialRepair | null;
    }
  | {
      readonly status: "loading";
      readonly announcement: string;
      readonly repairCredential: CredentialRepair | null;
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
      readonly repairCredential: CredentialRepair | null;
      readonly recoveryAvailable: boolean;
      readonly focus: CredentialSettingsFocus;
    }
);

export function pendingCredentialRepair(state: CredentialSettingsState): CredentialRepair | null {
  return state.status === "closed" ? (state.repairCredential ?? null) : state.repairCredential;
}

export function repairRequiredCredential(
  state: CredentialSettingsState,
): DesktopCredentialId | null {
  return repairNeedsAthlete(pendingCredentialRepair(state));
}

export function closedCredentialSettings(state: CredentialSettingsState): CredentialSettingsState {
  const repair = pendingCredentialRepair(state);
  return {
    status: "closed",
    ...(repair === null ? {} : { repairCredential: repair }),
    ...(state.resetUncertain === true ? { resetUncertain: true } : {}),
  };
}

export function credentialChangesBlocked(
  state: CredentialSettingsState,
  settingsMutationActive: boolean,
): boolean {
  if (
    settingsMutationActive ||
    state.resetUncertain === true ||
    pendingCredentialRepair(state) !== null
  ) {
    return true;
  }
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
  render(state: CredentialSettingsState): void;
  dispose(): void;
}

export interface CredentialSettingsController {
  activate(): Promise<void>;
  refresh(): Promise<void>;
  close(): void;
  state(): CredentialSettingsState;
  dispose(): void;
}

export function createCredentialSettingsController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly loadStatuses: () => Promise<readonly CredentialSlotStatus[]>;
  readonly loadChatGptStatus: () => Promise<ChatGptStatus>;
  readonly loadRecoveryStatus?: () => Promise<CredentialRecoveryStatus>;
  readonly retryCredentialRecovery?: () => Promise<CredentialRecoveryStatus>;
  readonly retryFailedCredentials?: () => Promise<readonly CredentialSlotStatus[]>;
  readonly resetAllCredentials?: () => Promise<CredentialResetResult>;
  readonly loadClaudeCliStatus?: () => Promise<ClaudeCliStatus>;
  readonly deleteCredential: (input: {
    readonly credential: DesktopCredentialId;
  }) => Promise<CredentialDeleteResult>;
  readonly openSetup: () => void;
  readonly onDeleted?: () => Promise<void> | void;
  readonly onReconciled?: (moveFocus: boolean) => Promise<void> | void;
  readonly credentialMutationsBlocked?: () => boolean;
  readonly beginMutation: () => (() => void) | null;
  readonly view: CredentialSettingsView;
}): CredentialSettingsController {
  let currentState: CredentialSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let operation: Promise<void> | undefined;
  let activeResetOperation: symbol | undefined;

  const render = (state: CredentialSettingsState): void => {
    currentState = state;
    if (!repairRetrying(pendingCredentialRepair(state))) repairRetry.stop();
    input.view.render(state);
  };

  const loadEntries = createCredentialEntriesReader(input);

  const startLoad = (retryRecovery = false, quiet = false): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const repair = pendingCredentialRepair(currentState);
    const repairCredential = repairCredentialId(repair);
    const retrying = repairRetrying(repair);
    const closed = quiet && currentState.status === "closed";
    const resetUncertain = currentState.resetUncertain === true;
    const repairAnnouncement =
      repair === null
        ? resetUncertain && "announcement" in currentState
          ? currentState.announcement
          : ""
        : "announcement" in currentState && currentState.announcement.length > 0
          ? currentState.announcement
          : retrying
            ? RECONNECTING_ANNOUNCEMENT
            : UNCERTAIN_DELETE_ANNOUNCEMENT;
    const feedbackFocus: CredentialSettingsFocus =
      repair === null && !resetUncertain ? null : { target: "feedback" };
    const operationGeneration = ++generation;
    const superseded = (): boolean => disposed || generation !== operationGeneration;
    if (!quiet)
      render({
        status: "loading",
        announcement: repairAnnouncement,
        repairCredential: repair,
        ...(resetUncertain ? { resetUncertain: true } : {}),
        recoveryAvailable: false,
        focus: feedbackFocus,
      });
    const pending = (async () => {
      try {
        if (retryRecovery) await input.retryCredentialRecovery?.();
        const stillFailed = (entries: readonly CredentialSettingsEntry[]): boolean =>
          entries.some(
            (entry) => entry.credential === repairCredential && entry.runtimeState === "failed",
          );
        let loaded = await loadEntries();
        if (retrying && stillFailed(loaded.entries)) {
          await input.retryFailedCredentials?.();
          loaded = await loadEntries();
        }
        if (superseded()) return;
        const repaired = loaded.entries.find((entry) => entry.credential === repairCredential);
        if (retrying && repairCredential !== null && stillFailed(loaded.entries)) {
          render(
            closed
              ? { status: "closed", repairCredential }
              : {
                  status: "ready",
                  entries: loaded.entries,
                  providerStatuses: loaded.providerStatuses,
                  confirmation: null,
                  announcement: refusalCopy("runtime-state-diverged"),
                  recovery: loaded.recovery,
                  repairCredential,
                  recoveryAvailable: true,
                  focus: { target: "feedback" },
                },
          );
          return;
        }
        if (repair !== null || resetUncertain) await input.onReconciled?.(!quiet);
        if (superseded()) return;
        render(
          closed
            ? { status: "closed" }
            : {
                status: "ready",
                entries: loaded.entries,
                providerStatuses: loaded.providerStatuses,
                confirmation: null,
                announcement:
                  retrying && repaired !== undefined
                    ? refusalCopy("runtime-unavailable")
                    : recoveryCopy(loaded.recovery),
                recovery: loaded.recovery,
                repairCredential: null,
                recoveryAvailable: false,
                focus:
                  repairCredential === null || quiet
                    ? null
                    : { target: "setup", credential: repairCredential },
              },
        );
      } catch {
        if (superseded() || (retrying && quiet)) return;
        render({
          status: "error",
          kind: "load",
          announcement:
            repairAnnouncement.length === 0
              ? "Saved credentials aren’t available. Reconnect and reload."
              : repairAnnouncement,
          repairCredential: repair,
          ...(resetUncertain ? { resetUncertain: true } : {}),
          recoveryAvailable: false,
          focus: feedbackFocus,
        });
      }
    })().finally(() => settle(pending));
    operation = pending;
    return pending;
  };

  const settle = (pending: Promise<void>): void => {
    if (operation === pending) operation = undefined;
    if (!disposed && repairRetrying(pendingCredentialRepair(currentState))) repairRetry.schedule();
  };

  const repairRetry = createCredentialRepairRetry({
    run: () => void startLoad(false, true),
    onConnectionOpen: (listener) => input.clients.onConnectionOpen(listener),
  });

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
      announcement: deleteConfirmCopy(credential, PROVIDER_NAMES[credential]),
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
      credentialChangesBlocked(currentState, false)
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
        credentialChangesBlocked(currentState, false)
      ) {
        return;
      }
      showDeleteConfirmation(credential);
    })();
  };

  const requestReset = (): void => {
    if (
      disposed ||
      operation !== undefined ||
      repairRetrying(pendingCredentialRepair(currentState)) ||
      currentState.resetUncertain === true ||
      input.credentialMutationsBlocked?.()
    ) {
      return;
    }
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
      announcement: deleteCancelledCopy(credential),
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
    const resetOperation = Symbol();
    activeResetOperation = resetOperation;
    const operationGeneration = ++generation;
    render({
      status: "deleting",
      entries: content.entries,
      providerStatuses: content.providerStatuses,
      confirmation: "all",
      announcement: "Removing all credentials…",
      recovery: content.recovery,
      repairCredential: content.repairCredential,
      resetUncertain: true,
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
      if (disposed) return;
      let loaded: Awaited<ReturnType<typeof loadEntries>>;
      try {
        loaded = await loadEntries();
        if (disposed) return;
        if (result.status === "refused") {
          await input.onReconciled?.(true);
        } else {
          await input.onDeleted?.();
        }
      } catch {
        if (disposed) return;
        if (generation !== operationGeneration) {
          const repairCredential =
            result.status === "refused" ? pendingCredentialRepair(currentState) : null;
          render({
            status: "closed",
            ...(repairCredential === null ? {} : { repairCredential }),
            resetUncertain: true,
          });
          return;
        }
        releaseMutation();
        render({
          status: "error",
          kind: "load",
          announcement:
            result.status === "refused"
              ? "Credential removal could not be verified because Settings could not reload. Reconnect and reload."
              : "Credentials were removed, but Settings could not reload. Reconnect and reload.",
          repairCredential: result.status === "refused" ? content.repairCredential : null,
          resetUncertain: true,
          recoveryAvailable: true,
          focus: { target: "feedback" },
        });
        return;
      }
      if (disposed || activeResetOperation !== resetOperation) return;
      if (generation !== operationGeneration) {
        render({ status: "closed" });
        return;
      }
      releaseMutation();
      if (result.status === "refused") {
        render({
          status: "ready",
          entries: loaded.entries,
          providerStatuses: loaded.providerStatuses,
          confirmation: null,
          announcement:
            result.reason === "runtime-unavailable"
              ? "Enduragent could not stop every active credential. Retry to finish removing credentials."
              : "Enduragent could not remove every stored credential. Retry.",
          recovery: loaded.recovery,
          repairCredential: null,
          recoveryAvailable: false,
          focus: { target: "feedback" },
        });
        return;
      }
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
      if (activeResetOperation === resetOperation) activeResetOperation = undefined;
      settle(pending);
    });
    operation = pending;
    return pending;
  };

  const confirmDelete = (): Promise<void> => {
    if (
      disposed ||
      operation !== undefined ||
      currentState.resetUncertain === true ||
      input.credentialMutationsBlocked?.()
    ) {
      return operation ?? Promise.resolve();
    }
    const content = contentState();
    if (content === null || content.confirmation === null) {
      return Promise.resolve();
    }
    if (content.confirmation === "all") return confirmReset();
    if (content.repairCredential !== null || content.recovery.state !== "ready") {
      return Promise.resolve();
    }
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
      announcement: deletingCopy(credential, target.provider),
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
      const diverged = result.status === "refused" && result.reason === "runtime-state-diverged";
      const retrying = diverged && DESKTOP_CREDENTIAL_SLOTS.some((slot) => slot === credential);
      if (disposed) return;
      if (generation !== operationGeneration) {
        if (retrying) render({ ...currentState, repairCredential: { retrying: credential } });
        return;
      }
      if (result.status === "refused") {
        releaseMutation();
        render({
          status: "error",
          kind: "delete",
          reason: result.reason,
          entries,
          providerStatuses,
          confirmation: null,
          announcement: retrying ? RECONNECTING_ANNOUNCEMENT : refusalCopy(result.reason),
          recovery,
          repairCredential: retrying
            ? { retrying: credential }
            : diverged
              ? credential
              : content.repairCredential,
          recoveryAvailable: content.recoveryAvailable || diverged,
          focus: diverged ? { target: "feedback" } : { target: "delete", credential },
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
          announcement: deletedSetupRefreshFailedCopy(result),
          repairCredential: content.repairCredential,
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
        announcement: deletedCopy(result, refreshFailed),
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
      settle(pending);
    });
    operation = pending;
    return pending;
  };

  const openSetup = (): void => {
    const content = contentState();
    if (
      disposed ||
      operation !== undefined ||
      currentState.resetUncertain === true ||
      content?.recoveryAvailable !== true
    ) {
      return;
    }
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
    if (currentState.resetUncertain !== true) operation = undefined;
    currentState = closedCredentialSettings(currentState);
  };

  input.view.bind({
    onRetry: () => {
      const recovery = contentState()?.recovery;
      void startLoad(
        recovery?.state === "locked" ||
          recovery?.state === "missing" ||
          recovery?.state === "unavailable",
      );
    },
    onRequestDelete: requestDelete,
    onRequestReset: requestReset,
    onCancelDelete: cancelDelete,
    onConfirmDelete: () => void confirmDelete(),
    onSetupOpened: setupOpened,
    onOpenSetup: openSetup,
  });

  return {
    async activate() {
      if (disposed) return;
      if (currentState.status !== "closed") {
        await operation;
        return;
      }
      const reopenBarrier =
        currentState.resetUncertain === true || pendingCredentialRepair(currentState) !== null
          ? operation
          : undefined;
      if (reopenBarrier !== undefined) await reopenBarrier;
      if (disposed || currentState.status !== "closed") return;
      await startLoad();
    },
    refresh: () => startLoad(false, true),
    close,
    state: () => currentState,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      repairRetry.stop();
      operation = undefined;
      activeResetOperation = undefined;
      currentState = { status: "closed" };
      input.view.dispose();
    },
  };
}
