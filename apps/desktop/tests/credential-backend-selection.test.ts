import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  keychainFailureRefusal,
  selectDesktopCredentialBackend,
  type SelectDesktopCredentialBackendOptions,
} from "../src/main/credential-backend-selection.js";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import { credentialEnvelopeKeyId } from "../src/main/credential-envelope-inventory.js";
import {
  CREDENTIAL_ENVELOPE_MAGIC,
  KEYCHAIN_ENVELOPE_KEY_ID,
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  createKeychainPartitionEncryption,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "../src/main/keychain-binding.js";
import {
  TELEGRAM_PROFILE_FILE_NAME,
  createTelegramCredentialVault,
} from "../src/main/telegram-credential-vault.js";

const fixtureRoots: string[] = [];
const posixIt = it.skipIf(process.platform === "win32");
const BOT = { id: 123456, username: "synthetic_bot" } as const;
const PROBE_OK: KeychainBindingResponse = {
  ok: true,
  op: "probe",
  teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
};

interface Fixture {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly athleteHome: string;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "desktop-backend-selection-"));
  fixtureRoots.push(base);
  const home = join(base, "athlete-home");
  await mkdir(home, { mode: 0o700 });
  return {
    credentialRoot: join(base, "credentials-v1"),
    telegramRoot: join(base, "telegram-channel-v1"),
    athleteHome: await realpath(home),
  };
}

function safeStorage(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value, "utf8").reverse()]),
    decryptString(value) {
      if (!value.subarray(0, 5).equals(Buffer.from("SAFE:"))) throw new TypeError();
      return Buffer.from(value.subarray(5)).reverse().toString("utf8");
    },
  };
}

interface RecordingTransport extends KeychainBindingTransport {
  readonly requests: KeychainBindingRequest[];
}

function transportOf(...responses: readonly KeychainBindingResponse[]): RecordingTransport {
  const remaining = [...responses];
  const requests: KeychainBindingRequest[] = [];
  return {
    requests,
    send(request) {
      requests.push(request);
      const next = remaining.shift();
      if (next === undefined) throw new Error("unexpected helper request");
      return Promise.resolve(next);
    },
  };
}

function readKey(key: Buffer): KeychainBindingResponse {
  return { ok: true, op: "read-key", key };
}

async function keychainEncryption(key: Buffer): Promise<CredentialEncryptionPort> {
  const serialize = createCredentialEnvelopeMutationLock();
  const result = await serialize((lockProof) =>
    createKeychainPartitionEncryption({
      transport: transportOf(PROBE_OK, readKey(key)),
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 1, keychainDependents: 1 },
      lockProof,
    }),
  );
  if (result.status !== "ready") throw new TypeError();
  return result.encryption;
}

function selection(
  roots: Fixture,
  transport: KeychainBindingTransport,
): SelectDesktopCredentialBackendOptions {
  return {
    credentialRoot: roots.credentialRoot,
    telegramRoot: roots.telegramRoot,
    transport,
    service: KEYCHAIN_CREDENTIAL_SERVICE,
    safeStorage: safeStorage(),
    platform: "darwin",
    serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
  };
}

async function seedCredential(
  root: string,
  slot: DesktopCredentialSlot,
  value: string,
  encryption: CredentialEncryptionPort,
): Promise<void> {
  const vault = createCredentialVault({
    root,
    encryption,
    applyCredential: vi.fn(async () => undefined),
  });
  await expect(vault.writeCredential({ slot, value }, { activate: false })).resolves.toMatchObject({
    status: "configured",
  });
}

async function seedProfile(
  roots: Fixture,
  token: string,
  encryption: CredentialEncryptionPort,
): Promise<void> {
  const vault = createTelegramCredentialVault({
    root: roots.telegramRoot,
    athleteHome: roots.athleteHome,
    encryption,
  });
  await expect(
    vault.replaceProfile({ token, bot: BOT, authenticatedAthleteHome: roots.athleteHome }),
  ).resolves.toMatchObject({ outcome: "applied" });
}

function credentialVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  return createCredentialVault({
    root: roots.credentialRoot,
    encryption,
    applyCredential: vi.fn(async () => undefined),
  });
}

function telegramVault(roots: Fixture, encryption: CredentialEncryptionPort) {
  return createTelegramCredentialVault({
    root: roots.telegramRoot,
    athleteHome: roots.athleteHome,
    encryption,
  });
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("backend selection", () => {
  posixIt("selects the keychain backend on a team-signed darwin build", async () => {
    const roots = await fixture();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    await seedCredential(
      roots.credentialRoot,
      "anthropic",
      "sk-anthropic",
      await keychainEncryption(key),
    );
    const transport = transportOf(PROBE_OK, readKey(key));

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    expect(selected.unverifiedEnvelopes).toBe(0);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt("refuses persistence on a macOS build that carries no team identity", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    const decryptString = vi.spyOn(legacy, "decryptString");
    const transport = transportOf({ ok: false, code: "not-team-signed" });
    const options = { ...selection(roots, transport), safeStorage: legacy };

    const selected = await selectDesktopCredentialBackend(options);

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "not-team-signed",
    });
    expect(decryptString).not.toHaveBeenCalled();
    expect(transport.requests.map((request) => request.op)).toEqual(["probe"]);
  });

  posixIt("keeps safeStorage off darwin without probing the helper", async () => {
    const roots = await fixture();
    const transport = transportOf();

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transport),
      platform: "win32",
    });

    expect(selected.status).toBe("safe-storage");
    expect(transport.requests).toHaveLength(0);
  });

  posixIt("preserves old envelopes for inline re-entry without calling safeStorage", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedProfile(roots, "synthetic-token", legacy);
    const credentialBefore = await readFile(join(roots.credentialRoot, "anthropic.bin"));
    const telegramBefore = await readFile(join(roots.telegramRoot, TELEGRAM_PROFILE_FILE_NAME));
    const decryptString = vi.spyOn(legacy, "decryptString");
    const transport = transportOf(PROBE_OK, readKey(key));
    const options = {
      ...selection(roots, transport),
      safeStorage: legacy,
    };

    const selected = await selectDesktopCredentialBackend(options);

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.unverifiedEnvelopes).toBe(2);
    expect(decryptString).not.toHaveBeenCalled();
    await expect(readFile(join(roots.credentialRoot, "anthropic.bin"))).resolves.toEqual(
      credentialBefore,
    );
    await expect(readFile(join(roots.telegramRoot, TELEGRAM_PROFILE_FILE_NAME))).resolves.toEqual(
      telegramBefore,
    );
    await expect(credentialVault(roots, selected.encryption).credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([{ slot: "anthropic", state: "re-prompt", runtimeState: null }]),
    );
    await expect(telegramVault(roots, selected.encryption).profileStatus()).resolves.toMatchObject({
      state: "re-prompt",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt(
    "keeps legacy-only recovery keyless through Retry and creates once for explicit re-entry",
    async () => {
      const roots = await fixture();
      const legacy = safeStorage();
      await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
      await seedCredential(roots.credentialRoot, "openrouter", "sk-openrouter", legacy);
      const unknownPath = join(roots.credentialRoot, "openrouter.bin");
      await writeFile(unknownPath, Buffer.from("unrecognized-envelope"));
      const keyIdZeroPath = join(roots.credentialRoot, "intervals-icu.bin");
      const keyIdZero = sealCredentialEnvelope(randomBytes(KEYCHAIN_KEY_BYTES), "legacy-intervals");
      keyIdZero[CREDENTIAL_ENVELOPE_MAGIC.length] = SAFE_STORAGE_ENVELOPE_KEY_ID;
      await writeFile(keyIdZeroPath, keyIdZero);
      keyIdZero.fill(0);
      const unknownBefore = await readFile(unknownPath);
      const keyIdZeroBefore = await readFile(keyIdZeroPath);
      const replacement = randomBytes(KEYCHAIN_KEY_BYTES);
      const transport = transportOf(
        PROBE_OK,
        { ok: false, code: "item-not-found" },
        PROBE_OK,
        { ok: false, code: "item-not-found" },
        { ok: false, code: "item-not-found" },
        { ok: true, op: "create-key", key: replacement },
      );
      const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
      const options = {
        ...selection(roots, transport),
        safeStorage: legacy,
        serializeEnvelopeMutation,
      };
      const decryptString = vi.spyOn(legacy, "decryptString");

      const startup = await selectDesktopCredentialBackend(options);
      const retried = await selectDesktopCredentialBackend(options);

      expect(startup.status).toBe("keychain");
      expect(retried.status).toBe("keychain");
      if (startup.status !== "keychain" || retried.status !== "keychain") return;
      expect(startup.encryption.isEncryptionAvailable()).toBe(false);
      expect(retried.encryption.isEncryptionAvailable()).toBe(false);
      expect(retried.unverifiedEnvelopes).toBe(3);
      expect(transport.requests.map((request) => request.op)).toEqual([
        "probe",
        "read-key",
        "probe",
        "read-key",
      ]);

      await expect(
        serializeEnvelopeMutation((proof) => retried.prepareKey(proof)),
      ).resolves.toEqual({ status: "ready" });
      await expect(
        credentialVault(roots, retried.encryption).writeCredential(
          { slot: "anthropic", value: "sk-replacement" },
          { activate: false },
        ),
      ).resolves.toMatchObject({ status: "configured" });

      expect(transport.requests.map((request) => request.op)).toEqual([
        "probe",
        "read-key",
        "probe",
        "read-key",
        "read-key",
        "create-key",
      ]);
      expect(decryptString).not.toHaveBeenCalled();
      expect(
        credentialEnvelopeKeyId(await readFile(join(roots.credentialRoot, "anthropic.bin"))),
      ).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
      await expect(readFile(unknownPath)).resolves.toEqual(unknownBefore);
      await expect(readFile(keyIdZeroPath)).resolves.toEqual(keyIdZeroBefore);
    },
  );
});

describe("unreadable envelopes", () => {
  posixIt("treats an uninspectable file as dependent without legacy decryption", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf(PROBE_OK, readKey(randomBytes(KEYCHAIN_KEY_BYTES)))),
      safeStorage: legacy,
      readEnvelopeFile: (async (path: string) => {
        if (path.endsWith("anthropic.bin")) {
          throw Object.assign(new Error("synthetic read failure"), { code: "EACCES" });
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }) as never,
    });

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.unverifiedEnvelopes).toBe(1);
    await expect(readFile(join(roots.credentialRoot, "anthropic.bin"))).resolves.toEqual(
      legacy.encryptString("sk-anthropic"),
    );
    expect(() => selected.encryption.decryptString(legacy.encryptString("sk-old"))).toThrow();
  });
});

describe("mandatory keychain rule", () => {
  posixIt("never falls back to safeStorage on macOS", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedProfile(roots, "synthetic-token", legacy);
    const before = await readFile(join(roots.credentialRoot, "anthropic.bin"));
    const decryptString = vi.spyOn(legacy, "decryptString");

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf({ ok: false, code: "not-team-signed" })),
      safeStorage: legacy,
    });

    expect(selected.status).toBe("refused");
    if (selected.status !== "refused") return;
    expect(selected.reason).toBe("encryption-unavailable");
    expect(selected.code).toBe("not-team-signed");
    expect(selected.encryption.isEncryptionAvailable()).toBe(false);
    expect(selected.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    expect(decryptString).not.toHaveBeenCalled();
    await expect(readFile(join(roots.credentialRoot, "anthropic.bin"))).resolves.toEqual(before);
  });

  posixIt("checks the helper before reading any credential envelope", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    const readEnvelopeFile = vi.fn(async () => {
      throw Object.assign(new Error("must not scan"), { code: "EACCES" });
    });

    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf({ ok: false, code: "unknown" })),
      safeStorage: legacy,
      readEnvelopeFile,
    });

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "unknown",
    });
    expect(readEnvelopeFile).not.toHaveBeenCalled();
  });

  posixIt("leaves every credential untouched when the helper probe fails", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedProfile(roots, "synthetic-token", legacy);
    const selected = await selectDesktopCredentialBackend({
      ...selection(roots, transportOf({ ok: false, code: "not-team-signed" })),
      safeStorage: legacy,
    });
    if (selected.status !== "refused") throw new TypeError();

    await expect(
      credentialVault(roots, selected.encryption).writeCredential({
        slot: "anthropic",
        value: "sk-replacement",
      }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "encryption-unavailable",
    });
    await expect(telegramVault(roots, selected.encryption).profileStatus()).resolves.toEqual({
      state: "re-prompt",
      reason: "encryption-unavailable",
    });
    expect(
      credentialEnvelopeKeyId(await readFile(join(roots.credentialRoot, "anthropic.bin"))),
    ).toBeUndefined();
  });
});

describe("keychain failure mapping", () => {
  it("maps every helper error code onto the existing taxonomy", () => {
    expect(keychainFailureRefusal("keychain-locked", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("not-team-signed", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("duplicate-item", false)).toBe("storage-failed");
    expect(keychainFailureRefusal("unreadable-item", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("item-not-found", false)).toBe("storage-failed");
    expect(keychainFailureRefusal("uninspectable-item", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("unknown", false)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("keychain-locked", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("not-team-signed", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("unknown", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("duplicate-item", true)).toBe("storage-failed");
    expect(keychainFailureRefusal("unreadable-item", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("item-not-found", true)).toBe("encryption-unavailable");
    expect(keychainFailureRefusal("uninspectable-item", true)).toBe("encryption-unavailable");
  });

  posixIt("maps a locked keychain onto encryption-unavailable in both vaults", async () => {
    const roots = await fixture();
    const transport = transportOf(PROBE_OK, { ok: false, code: "keychain-locked" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "keychain-locked",
    });
    if (selected.status !== "refused") return;
    await expect(
      credentialVault(roots, selected.encryption).writeCredential({
        slot: "anthropic",
        value: "sk-anthropic",
      }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "encryption-unavailable",
    });
    await expect(
      telegramVault(roots, selected.encryption).replaceProfile({
        token: "synthetic-token",
        bot: BOT,
        authenticatedAthleteHome: roots.athleteHome,
      }),
    ).resolves.toEqual({ outcome: "refused", reason: "encryption-unavailable" });
  });

  posixIt("maps an unreadable zero-blocker item onto encryption-unavailable", async () => {
    const roots = await fixture();
    const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "unreadable-item",
    });
    if (selected.status !== "refused") return;
    expect(selected.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt("defers duplicate-item handling until a credential write creates the key", async () => {
    const roots = await fixture();
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: false, code: "duplicate-item" },
    );

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.createdKey).toBe(false);
    expect(selected.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);

    const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
    await expect(
      serializeEnvelopeMutation((proof) => selected.prepareKey(proof)),
    ).resolves.toEqual({ status: "failed", code: "duplicate-item" });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
      "create-key",
    ]);
  });

  posixIt("preserves an invalid item while dependent envelopes need recovery", async () => {
    const roots = await fixture();
    const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
    await seedProfile(roots, "synthetic-token", retired);
    const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "unreadable-item",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt("preserves missing-key envelopes for explicit recovery", async () => {
    const roots = await fixture();
    const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
    const transport = transportOf(PROBE_OK, { ok: false, code: "item-not-found" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "item-not-found",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt("lets a recognised transient key-id one envelope block key creation", async () => {
    const roots = await fixture();
    await mkdir(roots.credentialRoot, { recursive: true });
    const transient = sealCredentialEnvelope(
      randomBytes(KEYCHAIN_KEY_BYTES),
      "transient-secret",
    );
    await writeFile(join(roots.credentialRoot, ".anthropic.bin.pending-1.tmp"), transient);
    transient.fill(0);
    const transport = transportOf(PROBE_OK, { ok: false, code: "item-not-found" });

    const selected = await selectDesktopCredentialBackend(selection(roots, transport));

    expect(selected).toMatchObject({
      status: "refused",
      reason: "encryption-unavailable",
      code: "item-not-found",
    });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  posixIt(
    "preserves an unrecognized envelope when legacy decryption cannot prove ownership",
    async () => {
      const roots = await fixture();
      const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
      await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
      const path = join(roots.credentialRoot, "anthropic.bin");
      const damaged = await readFile(path);
      damaged[0] ^= 0xff;
      await writeFile(path, damaged);
      damaged.fill(0);
      const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

      const selected = await selectDesktopCredentialBackend(selection(roots, transport));

      expect(selected).toMatchObject({
        status: "refused",
        reason: "encryption-unavailable",
        code: "unreadable-item",
      });
      expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    },
  );

  posixIt(
    "preserves a key-id zero envelope when legacy decryption cannot prove ownership",
    async () => {
      const roots = await fixture();
      const retired = await keychainEncryption(randomBytes(KEYCHAIN_KEY_BYTES));
      await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", retired);
      const path = join(roots.credentialRoot, "anthropic.bin");
      const damaged = await readFile(path);
      damaged[CREDENTIAL_ENVELOPE_MAGIC.length] = SAFE_STORAGE_ENVELOPE_KEY_ID;
      await writeFile(path, damaged);
      damaged.fill(0);
      const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

      const selected = await selectDesktopCredentialBackend(selection(roots, transport));

      expect(selected).toMatchObject({
        status: "refused",
        reason: "encryption-unavailable",
        code: "unreadable-item",
      });
      expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    },
  );

  posixIt("keeps healthy keychain slots readable while old slots require re-entry", async () => {
    const roots = await fixture();
    const legacy = safeStorage();
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    const keychain = await keychainEncryption(key);
    await seedCredential(roots.credentialRoot, "anthropic", "sk-anthropic", legacy);
    await seedCredential(roots.credentialRoot, "openrouter", "sk-openrouter", keychain);
    const legacyBefore = await readFile(join(roots.credentialRoot, "anthropic.bin"));

    const selected = await selectDesktopCredentialBackend(
      selection(roots, transportOf(PROBE_OK, readKey(key))),
    );

    expect(selected.status).toBe("keychain");
    if (selected.status !== "keychain") return;
    expect(selected.unverifiedEnvelopes).toBe(1);
    await expect(readFile(join(roots.credentialRoot, "anthropic.bin"))).resolves.toEqual(
      legacyBefore,
    );
    expect(
      credentialEnvelopeKeyId(await readFile(join(roots.credentialRoot, "openrouter.bin"))),
    ).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
    await expect(credentialVault(roots, selected.encryption).credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "re-prompt", runtimeState: null },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
    expect(credentialEnvelopeKeyId(selected.encryption.encryptString("sk-new"))).toBe(
      KEYCHAIN_ENVELOPE_KEY_ID,
    );
  });
});
