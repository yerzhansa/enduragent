import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";
import {
  createCredentialEnvelopeMutationLock,
  type CredentialEnvelopeLockProof,
} from "../src/main/credential-envelope-lock.js";
import {
  openCredentialEnvelope,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import { retireKeychainKeyWhenLastEnvelopeGone } from "../src/main/keychain-key-lifetime.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
} from "../src/main/keychain-binding.js";
import { createTelegramCredentialVault } from "../src/main/telegram-credential-vault.js";

const posixIt = it.skipIf(process.platform === "win32");
const BOT = { id: 987654, username: "synthetic_bot" } as const;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly athleteHome: string;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-key-retirement-"));
  fixtureRoots.push(base);
  const home = join(base, "athlete-home");
  await mkdir(home, { mode: 0o700 });
  return {
    credentialRoot: join(base, "credentials-v1"),
    telegramRoot: join(base, "telegram-channel-v1"),
    athleteHome: await realpath(home),
  };
}

function keychainPort(key: Buffer): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => sealCredentialEnvelope(key, value),
    decryptString: (envelope: Buffer) => openCredentialEnvelope(key, envelope),
    getSelectedStorageBackend: () => "keychain_partition_v1",
  };
}

function transportOf(...responses: readonly KeychainBindingResponse[]) {
  const remaining = [...responses];
  const requests: KeychainBindingRequest[] = [];
  return {
    requests,
    send(request: KeychainBindingRequest): Promise<KeychainBindingResponse> {
      requests.push(request);
      return Promise.resolve(remaining.shift() ?? { ok: false, code: "unknown" });
    },
  };
}

async function retireKey(
  roots: Fixture,
  transport: ReturnType<typeof transportOf>,
  lockProof: CredentialEnvelopeLockProof,
) {
  return await retireKeychainKeyWhenLastEnvelopeGone({
    ...roots,
    lockProof,
    deleteKey: async () => {
      const deleted = await transport.send({
        op: "delete-key",
        service: KEYCHAIN_CREDENTIAL_SERVICE,
      });
      if (!deleted.ok) return { status: "failed", code: deleted.code };
      if (deleted.op !== "delete-key") return { status: "failed", code: "unknown" };
      return { status: deleted.deleted ? "deleted" : "already-absent" };
    },
  });
}

describe("keychain key retirement call sites", () => {
  posixIt("retires the key when deleting the last credential envelope", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const observeEnvelopeRemoved = vi.fn(async (proof: CredentialEnvelopeLockProof) => {
      await retireKey(roots, transport, proof);
    });
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      observeEnvelopeRemoved,
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "sk-anthropic" }, { activate: false }),
    ).resolves.toMatchObject({ status: "configured" });

    await expect(vault.deleteCredential("anthropic")).resolves.toMatchObject({
      status: "deleted",
    });

    expect(observeEnvelopeRemoved).toHaveBeenCalledOnce();
    expect(transport.requests).toEqual([
      { op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
    ]);
  });

  posixIt("keeps the key while another credential envelope survives", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf();
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      observeEnvelopeRemoved: async (proof) => {
        await retireKey(roots, transport, proof);
      },
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    for (const slot of ["anthropic", "openai"] as const) {
      await expect(
        vault.writeCredential({ slot, value: `sk-${slot}` }, { activate: false }),
      ).resolves.toMatchObject({ status: "configured" });
    }

    await expect(vault.deleteCredential("anthropic")).resolves.toMatchObject({
      status: "deleted",
    });

    expect(transport.requests).toEqual([]);
  });

  posixIt("retires the key when removing the Telegram profile envelope", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const observeEnvelopeRemoved = vi.fn(async (proof: CredentialEnvelopeLockProof) => {
      await retireKey(roots, transport, proof);
    });
    const vault = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption,
      serializeEnvelopeMutation,
      observeEnvelopeRemoved,
    });
    await expect(
      vault.replaceProfile({
        token: "123:synthetic",
        bot: BOT,
        authenticatedAthleteHome: roots.athleteHome,
      }),
    ).resolves.toMatchObject({ outcome: "applied" });

    await expect(vault.deleteProfile()).resolves.toMatchObject({ outcome: "applied" });

    expect(observeEnvelopeRemoved).toHaveBeenCalledOnce();
    expect(transport.requests).toEqual([
      { op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
    ]);
  });

  posixIt("keeps the key when a credential envelope outlives the Telegram profile", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const transport = transportOf();
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const credentials = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      applyCredential: vi.fn(async () => undefined),
    });
    await expect(
      credentials.writeCredential(
        { slot: "anthropic", value: "sk-anthropic" },
        { activate: false },
      ),
    ).resolves.toMatchObject({ status: "configured" });
    const vault = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption,
      serializeEnvelopeMutation,
      observeEnvelopeRemoved: async (proof) => {
        await retireKey(roots, transport, proof);
      },
    });
    await expect(
      vault.replaceProfile({
        token: "123:synthetic",
        bot: BOT,
        authenticatedAthleteHome: roots.athleteHome,
      }),
    ).resolves.toMatchObject({ outcome: "applied" });

    await expect(vault.deleteProfile()).resolves.toMatchObject({ outcome: "applied" });

    expect(transport.requests).toEqual([]);
  });

  posixIt("never fails a deletion because retirement threw", async () => {
    const roots = await fixture();
    const encryption = keychainPort(randomBytes(KEYCHAIN_KEY_BYTES));
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const vault = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      observeEnvelopeRemoved: async () => {
        throw new Error("synthetic retirement failure");
      },
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "sk-anthropic" }, { activate: false }),
    ).resolves.toMatchObject({ status: "configured" });

    await expect(vault.deleteCredential("anthropic")).resolves.toMatchObject({
      status: "deleted",
    });
  });

  posixIt("blocks a write in the other vault through the zero-envelope census", async () => {
    const roots = await fixture();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    const baseEncryption = keychainPort(key);
    let seals = 0;
    const encryption: CredentialEncryptionPort = {
      ...baseEncryption,
      encryptString(value) {
        seals += 1;
        return baseEncryption.encryptString(value);
      },
    };
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const transport = transportOf({ ok: true, op: "delete-key", deleted: true });
    let releaseRetirement: (() => void) | undefined;
    let markRetirementStarted: (() => void) | undefined;
    const retirementBlocked = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const retirementStarted = new Promise<void>((resolve) => {
      markRetirementStarted = resolve;
    });
    const credentials = createCredentialVault({
      root: roots.credentialRoot,
      encryption,
      serializeEnvelopeMutation,
      observeEnvelopeRemoved: async (proof) => {
        markRetirementStarted?.();
        await retirementBlocked;
        await retireKey(roots, transport, proof);
      },
      applyCredential: vi.fn(async () => undefined),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    const telegram = createTelegramCredentialVault({
      root: roots.telegramRoot,
      athleteHome: roots.athleteHome,
      encryption,
      serializeEnvelopeMutation,
    });
    await credentials.writeCredential(
      { slot: "anthropic", value: "sk-anthropic" },
      { activate: false },
    );
    seals = 0;

    const deletion = credentials.deleteCredential("anthropic");
    await retirementStarted;
    const write = telegram.replaceProfile({
      token: "123:synthetic",
      bot: BOT,
      authenticatedAthleteHome: roots.athleteHome,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(seals).toBe(0);
    releaseRetirement?.();
    await expect(deletion).resolves.toMatchObject({ status: "deleted" });
    await expect(write).resolves.toMatchObject({ outcome: "applied" });
    expect(seals).toBe(1);
  });
});
