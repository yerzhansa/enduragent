import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialEnvelopeMutationLock,
  type CredentialEnvelopeLockProof,
} from "../src/main/credential-envelope-lock.js";
import {
  CREDENTIAL_DIRECTORY_MODE,
  createCredentialVault,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";
import { prepareDesktopCredentialEncryption } from "../src/main/desktop-credential-encryption.js";
import { sealCredentialEnvelope } from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
} from "../src/main/keychain-binding.js";
import { TELEGRAM_CREDENTIAL_DIRECTORY_MODE } from "../src/main/telegram-credential-vault.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const KEY = randomBytes(KEYCHAIN_KEY_BYTES);
const PROBE_OK: KeychainBindingResponse = {
  ok: true,
  op: "probe",
  teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
};

function safeStoragePort(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value, "utf8")]),
    decryptString: (value: Buffer) => value.subarray(5).toString("utf8"),
    getSelectedStorageBackend: () => "basic_text",
  };
}

async function launchWithLockedKeychain() {
  const base = await mkdtemp(join(await realpath(tmpdir()), "repro-llm-picker-keychain-"));
  roots.push(base);
  const credentialRoot = join(base, "credentials-v1");
  const telegramRoot = join(base, "telegram-channel-v1");
  await mkdir(credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
  await mkdir(telegramRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });

  let unlocked = false;
  const requests: string[] = [];
  const transport = {
    send: vi.fn(async (request: KeychainBindingRequest): Promise<KeychainBindingResponse> => {
      requests.push(request.op);
      if (request.op === "probe") return PROBE_OK;
      if (request.op === "retry-created-key-rollback") {
        return { ok: true, op: "retry-created-key-rollback" } as KeychainBindingResponse;
      }
      if (!unlocked) return { ok: false, code: "keychain-locked" } as KeychainBindingResponse;
      if (request.op === "read-key") return { ok: true, op: "read-key", key: KEY };
      return { ok: false, code: "unknown" } as KeychainBindingResponse;
    }),
  };
  const sealedTelegram = sealCredentialEnvelope(KEY, "synthetic-bot-token");
  const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
  const prepared = await prepareDesktopCredentialEncryption({
    credentialRoot,
    telegramRoot,
    safeStorage: safeStoragePort(),
    readEnvelopeFile: (async (path: string) => {
      if (path.startsWith(telegramRoot)) return Buffer.from(sealedTelegram);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }) as never,
    location: {
      platform: "darwin",
      packaged: true,
      resourcesPath: "/Applications/Enduragent.app/Contents/Resources",
      applicationPath: "/Applications/Enduragent.app/Contents/Resources/app.asar",
    },
    serializeEnvelopeMutation,
    createTransport: () => transport,
  });
  expect(prepared.selection).toMatchObject({ status: "refused", code: "keychain-locked" });

  const vault = createCredentialVault({
    root: credentialRoot,
    encryption: prepared.encryption,
    serializeEnvelopeMutation,
    prepareEnvelopeWrite: async (proof: CredentialEnvelopeLockProof) => {
      await prepared.prepareEnvelopeWrite(proof);
    },
    applyCredential: vi.fn(async () => undefined),
    platform: "darwin",
  } as never);

  return {
    vault,
    prepared,
    requests,
    unlock: () => {
      unlocked = true;
    },
  };
}

describe("llm-picker G15: Keychain unlocked after launch", () => {
  it("lets Setup save a key once the athlete has unlocked the Keychain", async () => {
    const { vault, requests, unlock } = await launchWithLockedKeychain();

    unlock();
    const requestsBeforeSave = requests.length;
    const saved = await vault.writeCredential({ slot: "anthropic", value: "synthetic-key" });
    const opsDuringSave = requests.slice(requestsBeforeSave);

    expect({
      save: saved.status,
      reason: "reason" in saved ? saved.reason : undefined,
      opsDuringSave,
    }).toEqual({
      save: "configured",
      reason: undefined,
      opsDuringSave: expect.arrayContaining(["read-key"]),
    });
  });

  it("keeps refusing the save while the Keychain stays locked", async () => {
    const { vault } = await launchWithLockedKeychain();

    const saved = await vault.writeCredential({ slot: "anthropic", value: "synthetic-key" });

    expect({ save: saved.status, reason: "reason" in saved ? saved.reason : undefined }).toEqual({
      save: "refused",
      reason: "encryption-unavailable",
    });
  });

  it("control: after Settings' credential Retry, the same save works", async () => {
    const { vault, prepared, unlock } = await launchWithLockedKeychain();
    unlock();
    await expect(prepared.retryKeychain()).resolves.toMatchObject({ status: "keychain" });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-key" }),
    ).resolves.toMatchObject({ status: "configured" });
  });
});
