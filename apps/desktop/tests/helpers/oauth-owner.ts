import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { createDesktopOAuthCredentialOwner } from "../../src/main/oauth-credential-owner.js";
import { createCredentialEnvelopeMutationLock } from "../../src/main/credential-envelope-lock.js";
import {
  openCredentialEnvelope,
  sealCredentialEnvelope,
} from "../../src/main/keychain-credential-encryption.js";

export function syntheticOAuthOwner(
  configDir: string,
  overrides: Partial<Parameters<typeof createDesktopOAuthCredentialOwner>[0]> = {},
) {
  const key = randomBytes(32);
  return createDesktopOAuthCredentialOwner({
    configDir,
    root: join(dirname(configDir), "credentials-v1"),
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => sealCredentialEnvelope(key, value),
      decryptString: (value) => openCredentialEnvelope(key, value),
      getSelectedStorageBackend: () => "synthetic-test",
    },
    serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
    prepareEnvelopeWrite: async () => {},
    revalidateEnvelopeRemoval: async () => true,
    observeEnvelopeRemoved: async () => {},
    ...overrides,
  });
}
