import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import {
  resetEncryptedCredentialStorage,
  type EncryptedCredentialResetResult,
  type ResetEncryptedCredentialStorageOptions,
} from "./credential-reset.js";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
  SerializeCredentialMutation,
} from "./credential-envelope-lock.js";
import type {
  CredentialRuntimeApplication,
  DesktopManagedCredential,
} from "./credential-runtime.js";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  type CredentialRuntimeState,
  type DesktopCredentialSlot,
} from "./credential-vault.js";
import type { KeychainKeyDeletion } from "./keychain-credential-encryption.js";
import type { DesktopCredentialResetResult } from "./onboarding-ipc.js";

export interface DesktopCredentialResetRuntimeBinding {
  readonly authority: {
    getRuntimeConfig(): Promise<RuntimeConfigSnapshot>;
  };
  readonly credentials: Pick<CredentialRuntimeApplication, "clearCredential">;
}

export interface DesktopCredentialResetLifecycleSnapshot {
  readonly status: string;
  readonly generation?: number;
}

type ResetEncryptedCredentialStorage = (
  options: ResetEncryptedCredentialStorageOptions,
) => Promise<EncryptedCredentialResetResult>;

export interface CreateDesktopCredentialResetOptions {
  readonly serializeCredentialMutation: SerializeCredentialMutation;
  readonly currentRuntimeBinding: () => DesktopCredentialResetRuntimeBinding | undefined;
  readonly lifecycleSnapshot: () => DesktopCredentialResetLifecycleSnapshot | undefined;
  readonly managedModelCredentials: ReadonlySet<string>;
  readonly resetTelegramRuntime: () => Promise<boolean>;
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation;
  readonly deleteKeyForCredentialReset: (
    proof: CredentialEnvelopeLockProof,
  ) => Promise<KeychainKeyDeletion>;
  readonly credentialRuntimeState: Map<DesktopCredentialSlot, CredentialRuntimeState>;
  readonly onRuntimeStateChange: (slot: DesktopCredentialSlot) => void;
  readonly resetEncryptedCredentialStorage?: ResetEncryptedCredentialStorage;
}

export function createDesktopCredentialReset(
  options: CreateDesktopCredentialResetOptions,
): () => Promise<DesktopCredentialResetResult> {
  const resetStorage = options.resetEncryptedCredentialStorage ?? resetEncryptedCredentialStorage;
  return (): Promise<DesktopCredentialResetResult> =>
    options.serializeCredentialMutation(async (): Promise<DesktopCredentialResetResult> => {
      const binding = options.currentRuntimeBinding();
      const lifecycleState = options.lifecycleSnapshot();
      if (binding === undefined || lifecycleState?.status !== "ready") {
        return { status: "refused", reason: "runtime-unavailable" };
      }
      try {
        const snapshot = await binding.authority.getRuntimeConfig();
        const activeCredentials: DesktopManagedCredential[] = [];
        if (
          snapshot.llm.credential_configured &&
          options.managedModelCredentials.has(snapshot.llm.provider)
        ) {
          activeCredentials.push(snapshot.llm.provider as DesktopManagedCredential);
        }
        if (snapshot.intervals.credential_configured) activeCredentials.push("intervals-icu");
        for (const credential of activeCredentials) {
          const cleared = await binding.credentials.clearCredential(credential);
          if (cleared !== "cleared") continue;
          const slot = DESKTOP_CREDENTIAL_SLOTS.find((candidate) => candidate === credential);
          if (slot !== undefined) {
            options.credentialRuntimeState.set(slot, "failed");
            options.onRuntimeStateChange(slot);
          }
        }
        if (!(await options.resetTelegramRuntime())) {
          return { status: "refused", reason: "runtime-unavailable" };
        }
        const currentLifecycleState = options.lifecycleSnapshot();
        if (
          options.currentRuntimeBinding() !== binding ||
          currentLifecycleState?.status !== "ready" ||
          currentLifecycleState.generation !== lifecycleState.generation
        ) {
          return { status: "refused", reason: "runtime-unavailable" };
        }
      } catch {
        return { status: "refused", reason: "runtime-unavailable" };
      }
      try {
        const reset = await resetStorage({
          credentialRoot: options.credentialRoot,
          telegramRoot: options.telegramRoot,
          serializeEnvelopeMutation: options.serializeEnvelopeMutation,
          deleteKey: options.deleteKeyForCredentialReset,
        });
        if (reset.status !== "reset") {
          return { status: "refused", reason: "storage-failed" };
        }
        options.credentialRuntimeState.clear();
        return reset;
      } catch {
        return { status: "refused", reason: "storage-failed" };
      }
    });
}
