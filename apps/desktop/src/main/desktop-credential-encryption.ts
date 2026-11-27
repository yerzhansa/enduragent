import {
  selectDesktopCredentialBackend,
  selectDesktopCredentialBackendLocked,
  type DesktopCredentialBackendSelection,
} from "./credential-backend-selection.js";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import type { KeychainKeyRetirement } from "./automatic-key-retirement.js";
import type { CredentialEnvelopeRoots } from "./credential-envelope-inventory.js";
import { scanBoundCredentialEnvelopes } from "./credential-envelope-root-binding.js";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import type { KeyCleanupDebt } from "./key-cleanup-debt.js";
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

const UNAVAILABLE_BINDING_RESPONSE: KeychainBindingResponse = Object.freeze({
  ok: false,
  code: "not-team-signed",
});

export function desktopKeychainCredentialService(packaged: boolean): string {
  return packaged ? KEYCHAIN_CREDENTIAL_SERVICE : KEYCHAIN_CREDENTIAL_SERVICE_DEV;
}

export function desktopCredentialRecoveryFailureState(
  code: KeychainBindingErrorCode,
): "locked" | "missing" | "unavailable" {
  if (code === "keychain-locked") return "locked";
  if (code === "item-not-found") return "missing";
  return "unavailable";
}

export interface DesktopCredentialEncryption {
  readonly encryption: CredentialEncryptionPort;
  readonly selection: DesktopCredentialBackendSelection;
  readonly service: string;
  prepareEnvelopeWrite(proof: CredentialEnvelopeLockProof): Promise<void>;
  revalidateEnvelopeRemoval(proof: CredentialEnvelopeLockProof): Promise<boolean>;
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
    const keyCleanupDebt: KeyCleanupDebt = "none";
    selection = {
      status: "refused",
      encryption: createRefusingKeychainEncryption("unknown", !unavailable),
      reason: unavailable ? "encryption-unavailable" : "storage-failed",
      code: "unknown",
      keyCleanupDebt,
      keyCleanupPending: keyCleanupDebt !== "none",
    };
  }
  let currentEncryption = selection.encryption;
  let keyCleanupDebt: KeyCleanupDebt =
    selection.status === "refused" ? selection.keyCleanupDebt : "none";
  const encryption: CredentialEncryptionPort = {
    isEncryptionAvailable: () => currentEncryption.isEncryptionAvailable(),
    encryptString: (value) => currentEncryption.encryptString(value),
    decryptString: (value) => currentEncryption.decryptString(value),
    getSelectedStorageBackend: () => currentEncryption.getSelectedStorageBackend?.() ?? "",
  };
  const transitionToUnavailable = (
    code: KeychainBindingErrorCode,
    cleanupDebt: KeyCleanupDebt,
  ): void => {
    selection = {
      status: "refused",
      encryption: createRefusingKeychainEncryption(code, false),
      reason: "encryption-unavailable",
      code,
      keyCleanupDebt: cleanupDebt,
      keyCleanupPending: cleanupDebt !== "none",
    };
    currentEncryption = selection.encryption;
    keyCleanupDebt = cleanupDebt;
  };
  const refreshSelection = async (
    proof: CredentialEnvelopeLockProof,
  ): Promise<DesktopCredentialBackendSelection> => {
    try {
      const next = await selectDesktopCredentialBackendLocked(
        {
          ...roots,
          transport,
          service,
          safeStorage: options.safeStorage,
          platform: options.location.platform,
          keyCleanupDebt,
          serializeEnvelopeMutation: options.serializeEnvelopeMutation,
        },
        proof,
      );
      selection = next;
      currentEncryption = next.encryption;
      keyCleanupDebt = next.status === "refused" ? next.keyCleanupDebt : "none";
    } catch {
      selection = {
        status: "refused",
        encryption: createRefusingKeychainEncryption("unknown", false),
        reason: "encryption-unavailable",
        code: "unknown",
        keyCleanupDebt,
        keyCleanupPending: keyCleanupDebt !== "none",
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
      if (
        selection.status !== "keychain" &&
        (options.location.platform === "darwin" || keyCleanupDebt !== "none")
      ) {
        await refreshSelection(proof);
      }
      if (selection.status !== "keychain") return;
      const prepared = await selection.prepareKey(proof);
      if (prepared.status === "failed") {
        transitionToUnavailable(prepared.code, prepared.keyCleanupDebt ?? "none");
      }
    },
    async revalidateEnvelopeRemoval(proof: CredentialEnvelopeLockProof): Promise<boolean> {
      if (options.location.platform !== "darwin") return true;
      if (selection.status !== "keychain") return false;
      const validated = await selection.validateKey(proof);
      if (validated.status === "ready") return true;
      transitionToUnavailable(validated.code, validated.keyCleanupDebt ?? "none");
      return false;
    },
    async retireKeychainKey(
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyRetirement | undefined> {
      if (selection.status !== "keychain") return undefined;
      const retired = await selection.retireKey(proof);
      if (retired.status === "failed") {
        transitionToUnavailable(
          retired.code,
          retired.keyCleanupPending ? "retirement" : "none",
        );
      }
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
        try {
          const { inventory } = await scanBoundCredentialEnvelopes(
            roots,
            options.location.platform,
          );
          return { selection: current, unverifiedEnvelopes: inventory.unverified };
        } catch {
          transitionToUnavailable("unknown", keyCleanupDebt);
          return { selection, unverifiedEnvelopes: 0 };
        }
      });
    },
    async deleteKeyForCredentialReset(
      proof: CredentialEnvelopeLockProof,
    ): Promise<KeychainKeyDeletion> {
      if (options.location.platform !== "darwin") return { status: "already-absent" };
      if (keyCleanupDebt === "creation-rollback") {
        const reconciled = await refreshSelection(proof);
        if (reconciled.status !== "keychain") {
          return {
            status: "failed",
            code: reconciled.status === "refused" ? reconciled.code : "unknown",
          };
        }
      }
      const deleted =
        selection.status === "keychain"
          ? await selection.deleteKeyForReset(proof)
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
        transitionToUnavailable(
          deleted.code,
          keyCleanupDebt === "creation-rollback" ? "creation-rollback" : "retirement",
        );
        return deleted;
      }
      keyCleanupDebt = "none";
      await refreshSelection(proof);
      return deleted;
    },
  };
}
