import type { Stats } from "node:fs";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertWindowsPrivateDirectoryStable,
  bindWindowsPrivateDirectory,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import {
  credentialEnvelopeTargets,
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import { CREDENTIAL_DIRECTORY_MODE } from "./credential-vault.js";
import { syncDirectory } from "./durable-atomic-replace.js";
import type { KeychainKeyDeletion } from "./keychain-credential-encryption.js";
import { TELEGRAM_CREDENTIAL_DIRECTORY_MODE } from "./telegram-credential-vault.js";

export type EncryptedCredentialResetResult =
  | Readonly<{ status: "reset"; keyCleanupPending: boolean }>
  | Readonly<{ status: "failed" }>;

export interface ResetEncryptedCredentialStorageOptions extends CredentialEnvelopeRoots {
  readonly serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation;
  readonly deleteKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyDeletion>;
  readonly removeFile?: typeof rm;
  readonly syncCredentialDirectory?: (root: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
}

interface CredentialRootIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

type CredentialRootBinding =
  | Readonly<{
      state: "missing";
      root: string;
      expectedMode: number;
    }>
  | Readonly<{
      state: "bound";
      root: string;
      expectedMode: number;
      identity: CredentialRootIdentity;
      windowsDirectory?: WindowsPrivateDirectoryBinding;
    }>;

function permissions(mode: number): number {
  return mode & 0o777;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function missingPath(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error("credential root is missing"), { code: "ENOENT", path });
}

function assertPosixCredentialRoot(metadata: Stats, expectedMode: number): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    permissions(metadata.mode) !== expectedMode ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("unsafe credential root");
  }
}

async function bindCredentialRoot(
  root: string,
  expectedMode: number,
  platform: NodeJS.Platform,
): Promise<CredentialRootBinding> {
  let metadata: Stats;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if (isMissing(error)) return { state: "missing", root, expectedMode };
    throw error;
  }
  if (platform === "win32") {
    const windowsDirectory = bindWindowsPrivateDirectory(dirname(root), root);
    return {
      state: "bound",
      root,
      expectedMode,
      identity: windowsDirectory.identity,
      windowsDirectory,
    };
  }
  assertPosixCredentialRoot(metadata, expectedMode);
  return {
    state: "bound",
    root,
    expectedMode,
    identity: { dev: metadata.dev, ino: metadata.ino },
  };
}

async function assertCredentialRootStable(
  binding: CredentialRootBinding,
  platform: NodeJS.Platform,
): Promise<void> {
  if (binding.state === "missing") {
    try {
      await lstat(binding.root);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    throw new TypeError("missing credential root appeared during reset");
  }
  if (platform === "win32") {
    assertWindowsPrivateDirectoryStable(binding.windowsDirectory!);
    return;
  }
  const metadata = await lstat(binding.root);
  assertPosixCredentialRoot(metadata, binding.expectedMode);
  if (metadata.dev !== binding.identity.dev || metadata.ino !== binding.identity.ino) {
    throw new TypeError("credential root changed during reset");
  }
}

async function useBoundCredentialRoot<T>(
  binding: CredentialRootBinding,
  platform: NodeJS.Platform,
  operation: () => Promise<T>,
): Promise<T> {
  if (binding.state === "missing") throw missingPath(binding.root);
  await assertCredentialRootStable(binding, platform);
  const result = await operation();
  await assertCredentialRootStable(binding, platform);
  return result;
}

export function resetEncryptedCredentialStorage(
  options: ResetEncryptedCredentialStorageOptions,
): Promise<EncryptedCredentialResetResult> {
  return options.serializeEnvelopeMutation(async (proof) => {
    const removeFile = options.removeFile ?? rm;
    const syncCredentialDirectory = options.syncCredentialDirectory ?? syncDirectory;
    const platform = options.platform ?? process.platform;
    try {
      const credentialBinding = await bindCredentialRoot(
        options.credentialRoot,
        CREDENTIAL_DIRECTORY_MODE,
        platform,
      );
      const telegramBinding = await bindCredentialRoot(
        options.telegramRoot,
        TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
        platform,
      );
      const bindingByVault = {
        credentials: credentialBinding,
        telegram: telegramBinding,
      } as const;
      const bindingByRoot = new Map<string, CredentialRootBinding>([
        [credentialBinding.root, credentialBinding],
        [telegramBinding.root, telegramBinding],
      ]);
      const guardedRoots: CredentialEnvelopeRoots = {
        credentialRoot: options.credentialRoot,
        telegramRoot: options.telegramRoot,
        readEnvelopeFile: async (path) => {
          const binding = bindingByRoot.get(dirname(path));
          if (binding === undefined) throw new TypeError("unexpected credential root");
          return useBoundCredentialRoot(binding, platform, () =>
            (options.readEnvelopeFile ?? readFile)(path),
          );
        },
        readEnvelopeDirectory: async (root) => {
          const binding = bindingByRoot.get(root);
          if (binding === undefined) throw new TypeError("unexpected credential root");
          return useBoundCredentialRoot(binding, platform, () =>
            (options.readEnvelopeDirectory ?? readdir)(root),
          );
        },
      };
      for (const target of credentialEnvelopeTargets(options)) {
        const binding = bindingByVault[target.vault];
        if (binding.state === "missing") continue;
        await useBoundCredentialRoot(binding, platform, () =>
          removeFile(join(target.root, target.fileName), { force: true }),
        );
      }
      const remaining = await scanCredentialEnvelopes(guardedRoots);
      for (const blocker of remaining.deletionBlockers) {
        const binding = bindingByVault[blocker.vault];
        if (binding.state === "missing") throw new TypeError("missing credential root was scanned");
        await useBoundCredentialRoot(binding, platform, () =>
          removeFile(join(blocker.root, blocker.fileName), { force: true }),
        );
      }
      for (const binding of [credentialBinding, telegramBinding]) {
        if (binding.state === "missing") continue;
        try {
          await useBoundCredentialRoot(binding, platform, () =>
            syncCredentialDirectory(binding.root),
          );
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      if ((await scanCredentialEnvelopes(guardedRoots)).deletionBlockers.length !== 0) {
        return { status: "failed" };
      }
      await assertCredentialRootStable(credentialBinding, platform);
      await assertCredentialRootStable(telegramBinding, platform);
      const key = await options.deleteKey(proof);
      return { status: "reset", keyCleanupPending: key.status === "failed" };
    } catch {
      return { status: "failed" };
    }
  });
}
