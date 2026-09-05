import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  CREDENTIAL_DIRECTORY_MODE,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";
import {
  desktopCredentialRecoveryFailureState,
  desktopKeychainCredentialService,
  prepareDesktopCredentialEncryption,
  type PrepareDesktopCredentialEncryptionOptions,
} from "../src/main/desktop-credential-encryption.js";
import {
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
} from "../src/main/keychain-binding.js";
import { TELEGRAM_CREDENTIAL_DIRECTORY_MODE } from "../src/main/telegram-credential-vault.js";

let fixtureRoot = "";
let credentialRoot = "";
let telegramRoot = "";
const posixIt = it.skipIf(process.platform === "win32");
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

function transportOf(...answers: readonly KeychainBindingResponse[]) {
  return transportWithRollbackRetries(answers, []);
}

function transportWithRollbackRetries(
  answers: readonly KeychainBindingResponse[],
  rollbackAnswers: readonly KeychainBindingResponse[],
) {
  const requests: KeychainBindingRequest[] = [];
  const allRequests: KeychainBindingRequest[] = [];
  const queue = [...answers];
  const rollbackQueue = [...rollbackAnswers];
  return {
    requests,
    allRequests,
    send: vi.fn(async (request: KeychainBindingRequest): Promise<KeychainBindingResponse> => {
      allRequests.push(request);
      if (request.op === "retry-created-key-rollback") {
        return (
          rollbackQueue.shift() ?? {
            ok: true,
            op: "retry-created-key-rollback",
          }
        );
      }
      requests.push(request);
      return queue.shift() ?? ({ ok: false, code: "unknown" } as KeychainBindingResponse);
    }),
  };
}

function noEnvelopes() {
  return (async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }) as never;
}

function migratedTelegramEnvelope() {
  const sealed = sealCredentialEnvelope(KEY, "bot-token");
  return (async (path: string) => {
    if (path.startsWith(telegramRoot)) return Buffer.from(sealed);
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }) as never;
}

function removableTelegramEnvelope() {
  const sealed = sealCredentialEnvelope(KEY, "bot-token");
  let present = true;
  return {
    read: (async (path: string) => {
      if (present && path.startsWith(telegramRoot)) return Buffer.from(sealed);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }) as never,
    remove() {
      present = false;
    },
  };
}

function options(
  overrides: Partial<PrepareDesktopCredentialEncryptionOptions> = {},
): PrepareDesktopCredentialEncryptionOptions {
  return {
    credentialRoot,
    telegramRoot,
    safeStorage: safeStoragePort(),
    readEnvelopeFile: noEnvelopes(),
    location: {
      platform: "darwin",
      packaged: true,
      resourcesPath: "/Applications/Enduragent.app/Contents/Resources",
      applicationPath: "/Applications/Enduragent.app/Contents/Resources/app.asar",
    },
    serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
    ...overrides,
  };
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "desktop-credential-encryption-"));
  credentialRoot = join(fixtureRoot, "credentials-v1");
  telegramRoot = join(fixtureRoot, "telegram-channel-v1");
  await mkdir(credentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
  await mkdir(telegramRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("desktop credential encryption startup", () => {
  it.each([
    ["keychain-locked", "locked"],
    ["item-not-found", "missing"],
    ["uninspectable-item", "unavailable"],
    ["unreadable-item", "unavailable"],
    ["not-team-signed", "unavailable"],
    ["unknown", "unavailable"],
  ] as const)("maps %s onto the %s recovery state", (code, expected) => {
    expect(desktopCredentialRecoveryFailureState(code)).toBe(expected);
  });

  it("separates the signed-release service from the development service", () => {
    expect(desktopKeychainCredentialService(true)).toBe(KEYCHAIN_CREDENTIAL_SERVICE);
    expect(desktopKeychainCredentialService(false)).toBe(KEYCHAIN_CREDENTIAL_SERVICE_DEV);
    expect(KEYCHAIN_CREDENTIAL_SERVICE_DEV).not.toBe(KEYCHAIN_CREDENTIAL_SERVICE);
  });

  it("asks the packaged lane for the signed-release service exactly once per key acquisition", async () => {
    const transport = transportOf(PROBE_OK, {
      ok: true,
      op: "read-key",
      key: KEY,
    });

    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, readEnvelopeFile: migratedTelegramEnvelope() }),
    );

    expect(prepared.service).toBe(KEYCHAIN_CREDENTIAL_SERVICE);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    expect(
      transport.requests.every((request) => request.service === KEYCHAIN_CREDENTIAL_SERVICE),
    ).toBe(true);
    expect(prepared.selection.status).toBe("keychain");
    expect(prepared.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
  });

  it("publishes encryption unavailable when the persisted key changes before a write", async () => {
    const replacement = randomBytes(KEYCHAIN_KEY_BYTES);
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: true, op: "read-key", key: replacement },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        serializeEnvelopeMutation,
      }),
    );

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));

    expect(prepared.selection).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "unknown",
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
    ]);
  });

  it("publishes encryption unavailable when removal revalidation sees a replaced key", async () => {
    const replacement = randomBytes(KEYCHAIN_KEY_BYTES);
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: true, op: "read-key", key: replacement },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        serializeEnvelopeMutation,
      }),
    );

    await expect(
      serializeEnvelopeMutation((proof) => prepared.revalidateEnvelopeRemoval(proof)),
    ).resolves.toBe(false);

    expect(prepared.selection).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "unknown",
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
    ]);
  });

  it("never lets an unpackaged run touch the signed-release service", async () => {
    const transport = transportOf(PROBE_OK, {
      ok: true,
      op: "read-key",
      key: KEY,
    });

    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        location: {
          platform: "darwin",
          packaged: false,
          resourcesPath: "/opt/electron/resources",
          applicationPath: "/repository/apps/desktop",
        },
      }),
    );

    expect(prepared.service).toBe(KEYCHAIN_CREDENTIAL_SERVICE_DEV);
    expect(transport.requests).not.toHaveLength(0);
    for (const request of transport.requests) {
      expect(request.service).toBe(KEYCHAIN_CREDENTIAL_SERVICE_DEV);
      expect(request.service).not.toBe(KEYCHAIN_CREDENTIAL_SERVICE);
    }
  });

  it("resolves the development binding from the application path", async () => {
    const createTransport = vi.fn(() =>
      transportOf(PROBE_OK, { ok: true, op: "read-key", key: KEY }),
    );

    await prepareDesktopCredentialEncryption(
      options({
        createTransport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        location: {
          platform: "darwin",
          packaged: false,
          resourcesPath: "/opt/electron/resources",
          applicationPath: "/repository/apps/desktop",
        },
      }),
    );

    expect(createTransport).toHaveBeenCalledWith(
      "/repository/apps/desktop/dist/keychain-binding/keychain-binding.node",
    );
  });

  it("keeps Windows on the injected safeStorage port without resolving a binding", async () => {
    const safeStorage = safeStoragePort();
    const createTransport = vi.fn(() => transportOf());

    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        safeStorage,
        createTransport,
        serializeEnvelopeMutation,
        location: {
          platform: "win32",
          packaged: true,
          resourcesPath: "C:/Program Files/Enduragent/resources",
          applicationPath: "C:/Program Files/Enduragent/resources/app.asar",
        },
      }),
    );

    expect(prepared.encryption).toBe(safeStorage);
    expect(prepared.selection.status).toBe("safe-storage");
    expect(createTransport).not.toHaveBeenCalled();
    await expect(
      serializeEnvelopeMutation((proof) => prepared.retireKeychainKey(proof)),
    ).resolves.toBeUndefined();
    await expect(
      serializeEnvelopeMutation((proof) => prepared.deleteKeyForCredentialReset(proof)),
    ).resolves.toEqual({ status: "already-absent" });
    expect(prepared.selection.status).toBe("safe-storage");
    expect(prepared.encryption).toBe(safeStorage);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("refuses persistence when the bundled macOS binding cannot load", async () => {
    const safeStorage = safeStoragePort();
    const createTransport = vi.fn(() => transportOf());

    const prepared = await prepareDesktopCredentialEncryption(
      options({ safeStorage, createTransport: () => transportOf({ ok: false, code: "not-team-signed" }) }),
    );

    expect(prepared.encryption).not.toBe(safeStorage);
    expect(prepared.selection).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "not-team-signed",
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("refuses instead of downgrading when a migrated envelope outlives the binding", async () => {
    const safeStorage = safeStoragePort();

    const prepared = await prepareDesktopCredentialEncryption(
      options({
        safeStorage,
        createTransport: () => transportOf({ ok: false, code: "not-team-signed" }),
        readEnvelopeFile: migratedTelegramEnvelope(),
      }),
    );

    expect(prepared.selection.status).toBe("refused");
    if (prepared.selection.status !== "refused") return;
    expect(prepared.selection.reason).toBe("encryption-unavailable");
    expect(prepared.encryption).not.toBe(safeStorage);
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => prepared.encryption.encryptString("sk-anthropic")).toThrow();
  });

  it("refuses without a safeStorage downgrade when selection itself throws", async () => {
    const safeStorage = safeStoragePort();
    const createTransport = vi.fn(() => {
      throw new Error("synthetic transport failure");
    });

    const prepared = await prepareDesktopCredentialEncryption(
      options({ safeStorage, createTransport }),
    );

    expect(prepared.selection.status).toBe("refused");
    if (prepared.selection.status !== "refused") return;
    expect(prepared.selection.reason).toBe("encryption-unavailable");
    expect(prepared.encryption).not.toBe(safeStorage);
    expect(prepared.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
  });

  it("retries a locked binding without replacing the vault encryption port", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "keychain-locked" }, PROBE_OK, {
      ok: true,
      op: "read-key",
      key: KEY,
    });
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, readEnvelopeFile: migratedTelegramEnvelope() }),
    );
    const stablePort = prepared.encryption;

    expect(prepared.selection).toMatchObject({ status: "refused", code: "keychain-locked" });
    expect(stablePort.isEncryptionAvailable()).toBe(false);
    await expect(prepared.retryKeychain()).resolves.toMatchObject({ status: "keychain" });
    expect(prepared.encryption).toBe(stablePort);
    expect(stablePort.isEncryptionAvailable()).toBe(true);
    expect(stablePort.decryptString(stablePort.encryptString("synthetic-secret"))).toBe(
      "synthetic-secret",
    );
  });

  posixIt("refuses Retry when a previously safe credential root redirects", async () => {
    const retryRoot = await mkdtemp(join(fixtureRoot, "retry-redirect-"));
    const retryCredentialRoot = join(retryRoot, "credentials-v1");
    const retryTelegramRoot = join(retryRoot, "telegram-channel-v1");
    const redirectedRoot = join(retryRoot, "redirected-credentials");
    await mkdir(retryCredentialRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    await mkdir(retryTelegramRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await mkdir(redirectedRoot, { mode: CREDENTIAL_DIRECTORY_MODE });
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "keychain-locked" },
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: true, op: "delete-key", deleted: true },
    );
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        credentialRoot: retryCredentialRoot,
        telegramRoot: retryTelegramRoot,
        createTransport: () => transport,
      }),
    );
    expect(prepared.selection).toMatchObject({
      status: "refused",
      code: "keychain-locked",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    await rm(retryCredentialRoot, { recursive: true });
    await symlink(redirectedRoot, retryCredentialRoot, "dir");

    await expect(prepared.retryKeychain()).resolves.toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "unknown",
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "probe",
    ]);
  });

  it("leaves the custom key absent after reset and recreates it only before a later write", async () => {
    const replacement = randomBytes(KEY.length);
    const envelope = removableTelegramEnvelope();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: true, op: "delete-key", deleted: true },
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: replacement },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: envelope.read,
        serializeEnvelopeMutation,
      }),
    );

    envelope.remove();
    await expect(
      serializeEnvelopeMutation((proof) => prepared.deleteKeyForCredentialReset(proof)),
    ).resolves.toEqual({ status: "deleted" });
    await expect(prepared.credentialRecoverySnapshot()).resolves.toMatchObject({
      selection: { status: "keychain" },
      unverifiedEnvelopes: 0,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "read-key",
    ]);

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));
    expect(prepared.selection.status).toBe("keychain");
    expect(prepared.encryption.decryptString(prepared.encryption.encryptString("new-secret"))).toBe(
      "new-secret",
    );
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "read-key",
      "read-key",
      "create-key",
    ]);
  });

  it("reconciles an already-absent reset from a refused state before a later write", async () => {
    const replacement = randomBytes(KEY.length);
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "keychain-locked" },
      { ok: true, op: "delete-key", deleted: false },
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: replacement },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, serializeEnvelopeMutation }),
    );

    expect(prepared.selection).toMatchObject({ status: "refused", code: "keychain-locked" });
    await expect(
      serializeEnvelopeMutation((proof) => prepared.deleteKeyForCredentialReset(proof)),
    ).resolves.toEqual({ status: "already-absent" });
    await expect(prepared.credentialRecoverySnapshot()).resolves.toMatchObject({
      selection: { status: "keychain" },
      unverifiedEnvelopes: 0,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "read-key",
    ]);

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));
    expect(prepared.encryption.decryptString(prepared.encryption.encryptString("new-secret"))).toBe(
      "new-secret",
    );
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "read-key",
      "read-key",
      "create-key",
    ]);
  });

  it("keeps the key absent across restart until a credential write", async () => {
    const replacement = randomBytes(KEY.length);
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: replacement },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();

    const restarted = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, serializeEnvelopeMutation }),
    );

    expect(restarted.selection.status).toBe("keychain");
    expect(restarted.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);

    await serializeEnvelopeMutation((proof) => restarted.prepareEnvelopeWrite(proof));
    expect(restarted.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
      "create-key",
    ]);
  });

  it("publishes a failed key preparation and recovers on Retry", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "keychain-locked" },
      PROBE_OK,
      { ok: false, code: "item-not-found" },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, serializeEnvelopeMutation }),
    );

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));

    expect(prepared.selection).toMatchObject({
      status: "refused",
      code: "keychain-locked",
      keyCleanupPending: false,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    await expect(prepared.credentialRecoverySnapshot()).resolves.toMatchObject({
      selection: { status: "refused", code: "keychain-locked" },
      unverifiedEnvelopes: 0,
    });

    await expect(prepared.retryKeychain()).resolves.toMatchObject({ status: "keychain" });
    await expect(prepared.credentialRecoverySnapshot()).resolves.toMatchObject({
      selection: { status: "keychain" },
      unverifiedEnvelopes: 0,
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
      "probe",
      "read-key",
    ]);
  });

  it("keeps failed creation unavailable until exact rollback succeeds", async () => {
    const replacement = randomBytes(KEY.length);
    const transport = transportWithRollbackRetries(
      [
        PROBE_OK,
        { ok: false, code: "item-not-found" },
        { ok: false, code: "item-not-found" },
        {
          ok: false,
          code: "unreadable-item",
          creationRollbackPending: true,
        },
        PROBE_OK,
        PROBE_OK,
        { ok: false, code: "item-not-found" },
        { ok: false, code: "item-not-found" },
        { ok: true, op: "create-key", key: replacement },
      ],
      [
        { ok: true, op: "retry-created-key-rollback" },
        { ok: false, code: "item-not-found" },
        { ok: true, op: "retry-created-key-rollback" },
      ],
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, serializeEnvelopeMutation }),
    );

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));
    expect(prepared.selection).toMatchObject({
      status: "refused",
      code: "unreadable-item",
      keyCleanupDebt: "creation-rollback",
      keyCleanupPending: true,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => prepared.encryption.encryptString("must-not-seal")).toThrow();

    await expect(prepared.retryKeychain()).resolves.toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "item-not-found",
      keyCleanupDebt: "creation-rollback",
      keyCleanupPending: true,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.allRequests.at(-1)?.op).toBe("retry-created-key-rollback");
    await expect(prepared.retryKeychain()).resolves.toMatchObject({ status: "keychain" });

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));
    const sealed = prepared.encryption.encryptString("post-rollback-secret");
    expect(prepared.encryption.decryptString(sealed)).toBe("post-rollback-secret");
    expect(transport.allRequests.map((request) => request.op)).toEqual([
      "probe",
      "retry-created-key-rollback",
      "read-key",
      "read-key",
      "create-key",
      "probe",
      "retry-created-key-rollback",
      "probe",
      "retry-created-key-rollback",
      "read-key",
      "read-key",
      "create-key",
    ]);
    expect(transport.allRequests.some((request) => request.op === "delete-key")).toBe(false);
  });

  it("preserves exact creation rollback debt when explicit reset cannot reconcile it", async () => {
    const transport = transportWithRollbackRetries(
      [
        PROBE_OK,
        { ok: false, code: "item-not-found" },
        { ok: false, code: "item-not-found" },
        {
          ok: false,
          code: "unreadable-item",
          creationRollbackPending: true,
        },
        PROBE_OK,
      ],
      [
        { ok: true, op: "retry-created-key-rollback" },
        { ok: false, code: "item-not-found" },
      ],
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, serializeEnvelopeMutation }),
    );

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));
    await expect(
      serializeEnvelopeMutation((proof) => prepared.deleteKeyForCredentialReset(proof)),
    ).resolves.toEqual({ status: "failed", code: "item-not-found" });

    expect(prepared.selection).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "item-not-found",
      keyCleanupDebt: "creation-rollback",
      keyCleanupPending: true,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.allRequests.map((request) => request.op)).toEqual([
      "probe",
      "retry-created-key-rollback",
      "read-key",
      "read-key",
      "create-key",
      "probe",
      "retry-created-key-rollback",
    ]);
    expect(transport.allRequests.some((request) => request.op === "delete-key")).toBe(false);
  });

  it("publishes encryption unavailable when a recovery inventory scan fails", async () => {
    const transport = transportOf(PROBE_OK, { ok: true, op: "read-key", key: KEY });
    let inventoryAvailable = true;
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        readEnvelopeDirectory: async () => {
          if (!inventoryAvailable) {
            throw Object.assign(new Error("inventory unavailable"), { code: "EACCES" });
          }
          return [];
        },
      }),
    );
    expect(prepared.selection.status).toBe("keychain");

    inventoryAvailable = false;

    await expect(prepared.credentialRecoverySnapshot()).resolves.toMatchObject({
      selection: {
        status: "refused",
        reason: "encryption-unavailable",
        code: "unknown",
        keyCleanupPending: false,
      },
      unverifiedEnvelopes: 0,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
  });

  it("deletes a readable zero-envelope key during startup without replacing it", async () => {
    const replacement = randomBytes(KEY.length);
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: true, op: "delete-key", deleted: true },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: replacement },
    );

    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, serializeEnvelopeMutation }),
    );

    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
    ]);

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));
    expect(transport.requests.slice(-2)).toEqual([
      { op: "read-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
      { op: "create-key", service: KEYCHAIN_CREDENTIAL_SERVICE },
    ]);
    const sealed = prepared.encryption.encryptString("post-retirement-secret");
    expect(prepared.encryption.decryptString(sealed)).toBe("post-retirement-secret");
  });

  it("refuses to seal when a later write cannot recreate a retired orphan key", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: true, op: "delete-key", deleted: true },
      { ok: false, code: "item-not-found" },
      { ok: false, code: "keychain-locked" },
    );

    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport, serializeEnvelopeMutation }),
    );

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => prepared.encryption.encryptString("orphan-candidate")).toThrow();
  });

  it("retries failed reset cleanup before an immediate credential write", async () => {
    const replacement = randomBytes(KEY.length);
    const envelope = removableTelegramEnvelope();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: false, code: "keychain-locked" },
      PROBE_OK,
      { ok: true, op: "delete-key", deleted: true },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: replacement },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: envelope.read,
        serializeEnvelopeMutation,
      }),
    );

    envelope.remove();
    await expect(
      serializeEnvelopeMutation((proof) => prepared.deleteKeyForCredentialReset(proof)),
    ).resolves.toEqual({ status: "failed", code: "keychain-locked" });
    expect(prepared.selection).toMatchObject({
      status: "refused",
      code: "keychain-locked",
      keyCleanupPending: true,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);

    await serializeEnvelopeMutation((proof) => prepared.prepareEnvelopeWrite(proof));

    expect(prepared.selection.status).toBe("keychain");
    expect(prepared.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "delete-key",
      "read-key",
      "create-key",
    ]);
  });

  it("retries failed orphan cleanup on Retry without creating a key", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: false, code: "keychain-locked" },
      PROBE_OK,
      { ok: true, op: "delete-key", deleted: true },
    );
    const prepared = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport }),
    );

    expect(prepared.selection).toMatchObject({
      status: "refused",
      keyCleanupPending: true,
    });
    await expect(prepared.retryKeychain()).resolves.toMatchObject({ status: "keychain" });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "delete-key",
    ]);
  });

  it("publishes failed last-envelope retirement and recovers cleanup on Retry", async () => {
    const envelope = removableTelegramEnvelope();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: false, code: "keychain-locked" },
      PROBE_OK,
      { ok: true, op: "delete-key", deleted: true },
    );
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: envelope.read,
        serializeEnvelopeMutation,
      }),
    );

    envelope.remove();
    await expect(
      serializeEnvelopeMutation((proof) => prepared.retireKeychainKey(proof)),
    ).resolves.toEqual({
      status: "failed",
      code: "keychain-locked",
      keyCleanupPending: true,
    });
    expect(prepared.selection).toMatchObject({
      status: "refused",
      code: "keychain-locked",
      keyCleanupPending: true,
    });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(false);
    await expect(prepared.credentialRecoverySnapshot()).resolves.toMatchObject({
      selection: {
        status: "refused",
        code: "keychain-locked",
        keyCleanupPending: true,
      },
    });

    await expect(prepared.retryKeychain()).resolves.toMatchObject({ status: "keychain" });
    await expect(prepared.credentialRecoverySnapshot()).resolves.toMatchObject({
      selection: { status: "keychain" },
      unverifiedEnvelopes: 0,
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "delete-key",
    ]);
  });

  it("retries failed orphan cleanup after restart without creating a key", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: false, code: "keychain-locked" },
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      { ok: true, op: "delete-key", deleted: true },
    );

    const first = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport }),
    );
    const restarted = await prepareDesktopCredentialEncryption(
      options({ createTransport: () => transport }),
    );

    expect(first.selection).toMatchObject({ status: "refused", keyCleanupPending: true });
    expect(restarted.selection.status).toBe("keychain");
    expect(restarted.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "probe",
      "read-key",
      "delete-key",
    ]);
  });

  it("keeps the key while any envelope survives in either vault", async () => {
    const transport = transportOf(PROBE_OK, {
      ok: true,
      op: "read-key",
      key: KEY,
    });

    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        serializeEnvelopeMutation,
      }),
    );

    await expect(
      serializeEnvelopeMutation((proof) => prepared.retireKeychainKey(proof)),
    ).resolves.toEqual({ status: "retained", envelopes: 1 });
    expect(transport.requests.some((request) => request.op === "delete-key")).toBe(false);
  });

  it("recovers a surviving credential after a retirement inventory failure", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
      PROBE_OK,
      { ok: true, op: "read-key", key: KEY },
    );
    let inventoryAvailable = true;
    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        readEnvelopeDirectory: async () => {
          if (!inventoryAvailable) {
            throw Object.assign(new Error("inventory unavailable"), { code: "EACCES" });
          }
          return [];
        },
        serializeEnvelopeMutation,
      }),
    );

    inventoryAvailable = false;
    await expect(
      serializeEnvelopeMutation((proof) => prepared.retireKeychainKey(proof)),
    ).resolves.toEqual({
      status: "failed",
      code: "unknown",
      keyCleanupPending: false,
    });
    expect(prepared.selection).toMatchObject({
      status: "refused",
      keyCleanupPending: false,
    });

    inventoryAvailable = true;
    await expect(prepared.retryKeychain()).resolves.toMatchObject({ status: "keychain" });
    expect(prepared.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "probe",
      "read-key",
    ]);
  });

  it("never deletes a keychain item from a refusing or safeStorage lane", async () => {
    const transport = transportOf({ ok: false, code: "keychain-locked" });

    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    const prepared = await prepareDesktopCredentialEncryption(
      options({
        createTransport: () => transport,
        readEnvelopeFile: migratedTelegramEnvelope(),
        serializeEnvelopeMutation,
      }),
    );

    expect(prepared.selection.status).toBe("refused");
    await expect(
      serializeEnvelopeMutation((proof) => prepared.retireKeychainKey(proof)),
    ).resolves.toBeUndefined();
    expect(transport.requests.some((request) => request.op === "delete-key")).toBe(false);
  });
});

describe("desktop startup wiring", () => {
  it("selects the credential backend once, before either vault is constructed", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    const selection = source.indexOf("await prepareDesktopCredentialEncryption({");
    const telegramVault = source.indexOf("createTelegramCredentialVault({");
    const credentialVault = source.indexOf("createCredentialVault({");

    expect(selection).toBeGreaterThan(0);
    expect(source.split("prepareDesktopCredentialEncryption(")).toHaveLength(2);
    expect(selection).toBeLessThan(telegramVault);
    expect(selection).toBeLessThan(credentialVault);
  });

  it("injects the selected port into every vault and keeps safeStorage out of the vaults", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    expect(source).not.toMatch(/encryption: safeStorage/u);
    expect(source.split("encryption: credentialEncryption.encryption")).toHaveLength(5);
    expect(source).toMatch(/safeStorage,\n/u);
  });

  it("reports the selected backend on darwin only", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const report = source.indexOf("desktop-credential-backend ");

    expect(report).toBeGreaterThan(0);
    expect(source.slice(report - 400, report)).toMatch(/process\.platform === "darwin"/u);
  });

  it("uses one shared lock for every envelope-deletion path", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

    expect(source).toMatch(/credentialEncryption\.retireKeychainKey\(proof\)/u);
    expect(source.split("createCredentialEnvelopeMutationLock()")).toHaveLength(2);
    expect(
      source.split("revalidateEnvelopeRemoval: revalidateCredentialEnvelopeRemoval"),
    ).toHaveLength(4);
    expect(source.split("observeEnvelopeRemoved: retireCredentialEncryptionKey")).toHaveLength(4);
  });
});
