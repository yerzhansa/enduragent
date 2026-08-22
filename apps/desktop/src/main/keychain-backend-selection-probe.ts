import { createCredentialEnvelopeMutationLock } from "./credential-envelope-lock.js";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import { prepareDesktopCredentialEncryption } from "./desktop-credential-encryption.js";
import { KEYCHAIN_PARTITION_STORAGE_BACKEND } from "./keychain-credential-encryption.js";
import {
  KEYCHAIN_TEAM_IDENTIFIER,
  createKeychainBindingTransport,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "./keychain-binding.js";
import type { KeychainBindingLocation } from "./keychain-binding-path.js";

export interface KeychainBackendSelectionProbeOptions {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly location: KeychainBindingLocation;
  readonly safeStorage: CredentialEncryptionPort;
  readonly createTransport?: (bindingPath: string) => KeychainBindingTransport;
}

export interface KeychainBackendSelectionProbeResult {
  readonly backend: typeof KEYCHAIN_PARTITION_STORAGE_BACKEND;
  readonly teamIdentifier: typeof KEYCHAIN_TEAM_IDENTIFIER;
}

const SYNTHETIC_MISSING_KEY: KeychainBindingResponse = Object.freeze({
  ok: false,
  code: "item-not-found",
});

export function createKeychainBackendSelectionProbeTransport(
  bindingTransport: KeychainBindingTransport,
  captureTeamIdentifier: (teamIdentifier: string) => void,
): KeychainBindingTransport {
  return {
    async send(request): Promise<KeychainBindingResponse> {
      if (request.op === "read-key") return SYNTHETIC_MISSING_KEY;
      if (request.op === "create-key" || request.op === "delete-key") {
        throw new Error("release backend selection probe refused key mutation");
      }
      const response = await bindingTransport.send(request);
      if (response.ok && response.op === "probe") {
        captureTeamIdentifier(response.teamIdentifier);
      }
      return response;
    },
  };
}

export async function probePackagedKeychainBackendSelection(
  options: KeychainBackendSelectionProbeOptions,
): Promise<KeychainBackendSelectionProbeResult> {
  if (options.location.platform !== "darwin" || !options.location.packaged) {
    throw new Error("release backend selection probe requires a packaged macOS application");
  }
  let teamIdentifier: string | undefined;
  const prepared = await prepareDesktopCredentialEncryption({
    credentialRoot: options.credentialRoot,
    telegramRoot: options.telegramRoot,
    location: options.location,
    safeStorage: options.safeStorage,
    serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
    createTransport: (bindingPath) =>
      createKeychainBackendSelectionProbeTransport(
        (
          options.createTransport ??
          ((path: string) => createKeychainBindingTransport({ bindingPath: path }))
        )(bindingPath),
        (selectedTeamIdentifier) => {
          teamIdentifier = selectedTeamIdentifier;
        },
      ),
  });
  if (teamIdentifier !== undefined && teamIdentifier !== KEYCHAIN_TEAM_IDENTIFIER) {
    throw new Error("release backend selection probe reported an unexpected identity");
  }
  if (prepared.selection.status !== "keychain") {
    throw new Error("release backend selection probe did not select the keychain backend");
  }
  const backend = prepared.selection.encryption.getSelectedStorageBackend?.();
  if (backend !== KEYCHAIN_PARTITION_STORAGE_BACKEND) {
    throw new Error("release backend selection probe selected an unexpected backend");
  }
  if (teamIdentifier !== KEYCHAIN_TEAM_IDENTIFIER) {
    throw new Error("release backend selection probe reported an unexpected identity");
  }
  return Object.freeze({ backend, teamIdentifier });
}
