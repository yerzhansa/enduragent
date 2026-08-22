import {
  selectDesktopCredentialBackend,
  selectDesktopCredentialBackendLocked,
  type DesktopCredentialBackendSelection,
} from "./credential-backend-selection.js";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import {
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import {
  createRefusingKeychainEncryption,
  type KeychainKeyDeletion,
} from "./keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  createKeychainBindingTransport,
  type KeychainBindingErrorCode,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "./keychain-binding.js";
import { resolveKeychainBindingPath, type KeychainBindingLocation } from "./keychain-binding-path.js";
import {
  retireKeychainKeyWhenLastEnvelopeGone,
  type KeychainKeyRetirement,
} from "./keychain-key-lifetime.js";

const UNAVAILABLE_BINDING_RESPONSE: KeychainBindingResponse = Object.freeze({
  ok: false,
  code: "not-team-signed",
});

export function desktopKeychainCredentialService(packaged: boolean): string {
  return packaged ? KEYCHAIN_CREDENTIAL_SERVICE : KEYCHAIN_CREDENTIAL_SERVICE_DEV;
}

export interface DesktopCredentialEncryption {
  readonly encryption: CredentialEncryptionPort;
  readonly selection: DesktopCredentialBackendSelection;
  readonly service: string;
  prepareEnvelopeWrite(proof: CredentialEnvelopeLockProof): Promise<void>;
  retireKeychainKey(proof: CredentialEnvelopeLockProof): Promise<KeychainKeyRetirement | undefined>;
  retryKeychain(): Promise<DesktopCredentialBackendSelection>;
  deleteKeyForCredentialReset(proof: CredentialEnvelopeLockProof): Promise<KeychainKeyDeletion>;
  credentialRecoverySnapshot(): Promise<{
    selection: DesktopCredentialBackendSelection;
    unverifiedEnvelopes: number;
  }>;
}

export interface PrepareDesktopCredentialEncryptionOptions extends CredentialEnvelopeRoots {
  readonly location: KeychainBindingLocation;
  readonly safeStorage: CredentialEncryptionPort;
  readonly createTransport?: (bindingPath: string) => KeychainBindingTransport;
  readonly serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation;
}

export async function prepareDesktopCredentialEncryption(
  options: PrepareDesktopCredentialEncryptionOptions,
): Promise<DesktopCredentialEncryption> {
  const service = desktopKeychainCredentialService(options.location.packaged);
  const bindingPath = resolveKeychainBindingPath(options.location);
  const roots = {
    credentialRoot: options.credentialRoot,
    telegramRoot: options.telegramRoot,
    readEnvelopeFile: options.readEnvelopeFile,
    readEnvelopeDirectory: options.readEnvelopeDirectory,
  };
  let transport: KeychainBindingTransport = { send: async () => UNAVAILABLE_BINDING_RESPONSE };
  let selection: DesktopCredentialBackendSelection;
  try {
    if (bindingPath !== undefined) {
      transport = (
        options.createTransport ??
        ((path: string) => createKeychainBindingTransport({ bindingPath: path }))
      )(bindingPath);
    }
    selection = await selectDesktopCredentialBackend({
      ...roots,
      transport,
      service,
      safeStorage: options.safeStorage,
      platform: options.location.platform,
      serializeEnvelopeMutation: options.serializeEnvelopeMutation,
    });
  } catch {
    const unavailable = options.location.platform === "darwin";
    selection = {
      status: "refused",
      encryption: createRefusingKeychainEncryption("unknown", !unavailable),
      reason: unavailable ? "encryption-unavailable" : "storage-failed",
      code: "unknown",
      keyCleanupPending: false,
    };
  }
  let currentEncryption = selection.encryption;
  let keyCleanupPending = selection.status === "refused" && selection.keyCleanupPending;
  let refreshBeforeWrite = keyCleanupPending;
  const encryption: CredentialEncryptionPort = {
    isEncryptionAvailable: () => currentEncryption.isEncryptionAvailable(),
    encryptString: (value) => currentEncryption.encryptString(value),
    decryptString: (value) => currentEncryption.decryptString(value),
    getSelectedStorageBackend: () => currentEncryption.getSelectedStorageBackend?.() ?? "",
  };
  const transitionToUnavailable = (
    code: KeychainBindingErrorCode,
    cleanupPending: boolean,
  ): void => {
    selection = {
      status: "refused",
      encryption: createRefusingKeychainEncryption(code, false),
      reason: "encryption-unavailable",
      code,
      keyCleanupPending: cleanupPending,
    };
    currentEncryption = selection.encryption;
    keyCleanupPending = cleanupPending;
    refreshBeforeWrite = cleanupPending;
  };
  const refreshSelection = async (
    proof: CredentialEnvelopeLockProof,
  ): Promise<DesktopCredentialBackendSelection> => {
    const pendingBeforeRefresh = keyCleanupPending;
    try {
      let next = await selectDesktopCredentialBackendLocked(
        {
          ...roots,
          transport,
          service,
          safeStorage: options.safeStorage,
          platform: options.location.platform,
          keyCleanupPending,
          serializeEnvelopeMutation: options.serializeEnvelopeMutation,
        },
        proof,
      );
      if (next.status === "refused" && pendingBeforeRefresh && !next.keyCleanupPending) {
        next = { ...next, keyCleanupPending: true };
      }
      selection = next;
      currentEncryption = next.encryption;
      keyCleanupPending = next.status === "refused" && next.keyCleanupPending;
      refreshBeforeWrite = keyCleanupPending;
    } catch {
      selection = {
        status: "refused",
        encryption: createRefusingKeychainEncryption("unknown", false),
        reason: "encryption-unavailable",
        code: "unknown",
        keyCleanupPending,
      };
      currentEncryption = selection.encryption;
    }
    return selection;
  };
  return {
    encryption: options.location.platform === "darwin" ? encryption : currentEncryption,
    get selection() {
      return selection;
    },
    service,
    async prepareEnvelopeWrite(proof: CredentialEnvelopeLockProof): Promise<void> {
      if (selection.status !== "keychain" && refreshBeforeWrite) {
        await refreshSelection(proof);
      }
      if (selection.status !== "keychain") return;
      const prepared = await selection.prepareKey(proof);
      if (prepared.status === "failed") transitionToUnavailable(prepared.code, false);
    },
    async retireKeychainKey(
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyRetirement | undefined> {
      if (selection.status !== "keychain") return undefined;
      const retired = await retireKeychainKeyWhenLastEnvelopeGone({
        ...roots,
        lockProof: proof,
        deleteKey: selection.deleteKey,
      });
      if (retired.status === "failed") transitionToUnavailable(retired.code, true);
      return retired;
    },
    retryKeychain(): Promise<DesktopCredentialBackendSelection> {
      return options.serializeEnvelopeMutation(refreshSelection);
    },
    credentialRecoverySnapshot(): Promise<{
      selection: DesktopCredentialBackendSelection;
      unverifiedEnvelopes: number;
    }> {
      return options.serializeEnvelopeMutation(async () => {
        const current = selection;
        if (current.status !== "keychain") {
          return { selection: current, unverifiedEnvelopes: 0 };
        }
        const inventory = await scanCredentialEnvelopes(roots);
        return { selection: current, unverifiedEnvelopes: inventory.unverified };
      });
    },
    async deleteKeyForCredentialReset(
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyDeletion> {
      if (options.location.platform !== "darwin") return { status: "already-absent" };
      const deleted =
        selection.status === "keychain"
          ? await selection.deleteKey(proof)
          : await transport.send({ op: "delete-key", service }).then((response) => {
              if (!response.ok) return { status: "failed" as const, code: response.code };
              if (response.op !== "delete-key") {
                return { status: "failed" as const, code: "unknown" as const };
              }
              return {
                status: response.deleted ? ("deleted" as const) : ("already-absent" as const),
              };
            });
      if (deleted.status === "failed") {
        transitionToUnavailable(deleted.code, true);
        return deleted;
      }
      keyCleanupPending = false;
      refreshBeforeWrite = false;
      await refreshSelection(proof);
      return deleted;
    },
  };
}
