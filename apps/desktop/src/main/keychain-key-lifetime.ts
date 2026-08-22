import {
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import type { CredentialEnvelopeLockProof } from "./credential-envelope-lock.js";
import type { KeychainKeyDeletion } from "./keychain-credential-encryption.js";
import type { KeychainBindingErrorCode } from "./keychain-binding.js";

export type KeychainKeyRetirement =
  | Readonly<{ status: "retained"; envelopes: number }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "already-absent" }>
  | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>;

export interface RetireKeychainKeyOptions extends CredentialEnvelopeRoots {
  readonly lockProof: CredentialEnvelopeLockProof;
  readonly deleteKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyDeletion>;
}

export async function retireKeychainKeyWhenLastEnvelopeGone(
  options: RetireKeychainKeyOptions,
): Promise<KeychainKeyRetirement> {
  const inventory = await scanCredentialEnvelopes(options);
  if (inventory.deletionBlockers.length > 0) {
    return { status: "retained", envelopes: inventory.deletionBlockers.length };
  }
  return await options.deleteKey(options.lockProof);
}
