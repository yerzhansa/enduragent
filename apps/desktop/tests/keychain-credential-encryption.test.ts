import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  CREDENTIAL_ENVELOPE_IV_BYTES,
  CREDENTIAL_ENVELOPE_MAGIC,
  CREDENTIAL_ENVELOPE_TAG_BYTES,
  CredentialEnvelopeError,
  KEYCHAIN_ENVELOPE_KEY_ID,
  KEYCHAIN_PARTITION_STORAGE_BACKEND,
  KeychainEncryptionError,
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  createKeychainPartitionEncryption,
  type CreateKeychainPartitionEncryptionOptions,
  openCredentialEnvelope,
  readCredentialEnvelopeKeyId,
  sealCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_CREDENTIAL_SERVICE_DEV,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "../src/main/keychain-binding.js";

const PROBE_OK: KeychainBindingResponse = {
  ok: true,
  op: "probe",
  teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
};

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

function storedKey(): { readonly key: Buffer; readonly encoded: Buffer } {
  const key = randomBytes(KEYCHAIN_KEY_BYTES);
  return { key, encoded: Buffer.from(key) };
}

async function createEncryption(
  options: Omit<CreateKeychainPartitionEncryptionOptions, "envelopeCensus" | "lockProof"> & {
    readonly envelopeCensus?: CreateKeychainPartitionEncryptionOptions["envelopeCensus"];
  },
) {
  const {
    envelopeCensus = { deletionBlockers: 1, keychainDependents: 1 },
    ...keychainOptions
  } = options;
  const serialize = createCredentialEnvelopeMutationLock();
  return await serialize((lockProof) =>
    createKeychainPartitionEncryption({
      ...keychainOptions,
      envelopeCensus,
      lockProof,
    }),
  );
}

describe("credential envelope", () => {
  it("seals a value under the keychain key-id and reads it back", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "sk-secret-value");
    expect(envelope.subarray(0, CREDENTIAL_ENVELOPE_MAGIC.length).toString("ascii")).toBe(
      CREDENTIAL_ENVELOPE_MAGIC,
    );
    expect(readCredentialEnvelopeKeyId(envelope)).toBe(KEYCHAIN_ENVELOPE_KEY_ID);
    expect(readCredentialEnvelopeKeyId(envelope)).not.toBe(SAFE_STORAGE_ENVELOPE_KEY_ID);
    expect(envelope.includes(Buffer.from("sk-secret-value", "utf8"))).toBe(false);
    expect(openCredentialEnvelope(key, envelope)).toBe("sk-secret-value");
  });

  it("lays the envelope out as magic, key-id, iv, ciphertext, tag", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "abcd");
    const overhead =
      CREDENTIAL_ENVELOPE_MAGIC.length +
      1 +
      CREDENTIAL_ENVELOPE_IV_BYTES +
      CREDENTIAL_ENVELOPE_TAG_BYTES;
    expect(envelope.length).toBe(overhead + Buffer.byteLength("abcd", "utf8"));
  });

  it("uses a fresh iv for every seal", () => {
    const { key } = storedKey();
    const first = sealCredentialEnvelope(key, "same");
    const second = sealCredentialEnvelope(key, "same");
    expect(first.equals(second)).toBe(false);
  });

  it("refuses a tampered ciphertext", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "sk-secret-value");
    const target = CREDENTIAL_ENVELOPE_MAGIC.length + 1 + CREDENTIAL_ENVELOPE_IV_BYTES;
    envelope[target] ^= 0xff;
    expect(() => openCredentialEnvelope(key, envelope)).toThrow();
  });

  it("refuses another key", () => {
    const envelope = sealCredentialEnvelope(storedKey().key, "sk-secret-value");
    expect(() => openCredentialEnvelope(storedKey().key, envelope)).toThrow();
  });

  it("refuses a safeStorage-era envelope and foreign bytes", () => {
    const { key } = storedKey();
    const envelope = sealCredentialEnvelope(key, "sk-secret-value");
    const legacy = Buffer.from(envelope);
    legacy[CREDENTIAL_ENVELOPE_MAGIC.length] = SAFE_STORAGE_ENVELOPE_KEY_ID;
    expect(() => openCredentialEnvelope(key, legacy)).toThrow(CredentialEnvelopeError);
    expect(
      readCredentialEnvelopeKeyId(Buffer.from("v10 opaque safeStorage bytes")),
    ).toBeUndefined();
    expect(readCredentialEnvelopeKeyId(Buffer.alloc(4))).toBeUndefined();
    expect(() => openCredentialEnvelope(key, Buffer.alloc(4))).toThrow(CredentialEnvelopeError);
  });
});

describe("keychain partition backend", () => {
  it("adopts an existing key and reports its backend id", async () => {
    const { encoded } = storedKey();
    const transport = transportOf(PROBE_OK, { ok: true, op: "read-key", key: encoded });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.createdKey).toBe(false);
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
    expect(result.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    const sealed = result.encryption.encryptString("token-value");
    expect(result.encryption.decryptString(sealed)).toBe("token-value");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
    expect(
      transport.requests.every((request) => request.service === KEYCHAIN_CREDENTIAL_SERVICE),
    ).toBe(true);
    expect(JSON.stringify(transport.requests)).not.toContain(encoded);
  });

  it("keeps an absent key missing until an explicit credential write", async () => {
    const { encoded } = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: encoded },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE_DEV,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.createdKey).toBe(false);
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);

    const serialize = createCredentialEnvelopeMutationLock();
    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "ready",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "read-key",
      "create-key",
    ]);
    expect(
      transport.requests.every((request) => request.service === KEYCHAIN_CREDENTIAL_SERVICE_DEV),
    ).toBe(true);
  });

  it("deletes a readable orphan but defers replacement until a write", async () => {
    const { encoded } = storedKey();
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: encoded },
      { ok: true, op: "delete-key", deleted: true },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: encoded },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
    ]);

    const serialize = createCredentialEnvelopeMutationLock();
    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "ready",
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "read-key",
      "create-key",
    ]);
  });

  it("reports encryption as unavailable when the keychain is locked", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "keychain-locked" });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.code).toBe("keychain-locked");
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(result.encryption.getSelectedStorageBackend?.()).toBe(
      KEYCHAIN_PARTITION_STORAGE_BACKEND,
    );
    expect(() => result.encryption.encryptString("token-value")).toThrow(KeychainEncryptionError);
  });

  it("reports a duplicate only when an explicit write tries to create the key", async () => {
    const transport = transportOf(
      PROBE_OK,
      { ok: false, code: "item-not-found" },
      { ok: false, code: "item-not-found" },
      { ok: false, code: "duplicate-item" },
    );
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);

    const serialize = createCredentialEnvelopeMutationLock();
    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "failed",
      code: "duplicate-item",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => result.encryption.encryptString("token-value")).toThrow(KeychainEncryptionError);
    expect(() => result.encryption.decryptString(Buffer.alloc(0))).toThrow(KeychainEncryptionError);
  });

  it("stops at the probe and touches no keychain op when the build is not team signed", async () => {
    const transport = transportOf({ ok: false, code: "not-team-signed" });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result).toEqual({ status: "unsupported", code: "not-team-signed" });
    expect(transport.requests.map((request) => request.op)).toEqual(["probe"]);
  });

  it("refuses a probe answered by a foreign team", async () => {
    const transport = transportOf({ ok: true, op: "probe", teamIdentifier: "ZZZZZZZZZZ" });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("storage-failed");
    expect(transport.requests).toHaveLength(1);
  });

  it("refuses a helper key of the wrong size", async () => {
    const transport = transportOf(PROBE_OK, {
      ok: true,
      op: "read-key",
      key: randomBytes(16),
    });
    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
    });
    expect(result.status).toBe("storage-failed");
  });

  it("preserves an uninspectable item and reports encryption unavailable", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "uninspectable-item" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 2, keychainDependents: 1 },
    });

    expect(result.status).toBe("unavailable");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("preserves a missing key when dependent envelopes need recovery", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "item-not-found" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 1, keychainDependents: 1 },
    });

    expect(result.status).toBe("unavailable");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("preserves a positively invalid item while dependent envelopes survive", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 1, keychainDependents: 1 },
    });

    expect(result.status).toBe("storage-failed");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("never deletes or replaces an unreadable item even with zero blockers", async () => {
    const transport = transportOf(PROBE_OK, { ok: false, code: "unreadable-item" });

    const result = await createEncryption({
      transport,
      service: KEYCHAIN_CREDENTIAL_SERVICE,
      envelopeCensus: { deletionBlockers: 0, keychainDependents: 0 },
    });

    expect(result.status).toBe("storage-failed");
    expect(transport.requests.map((request) => request.op)).toEqual(["probe", "read-key"]);
  });

  it("retries a failed deletion before creating a replacement", async () => {
    const original = storedKey();
    const replacement = storedKey();
    let census = { deletionBlockers: 1, keychainDependents: 1 };
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: false, code: "unknown" },
      { ok: true, op: "delete-key", deleted: true },
      { ok: false, code: "item-not-found" },
      { ok: true, op: "create-key", key: replacement.encoded },
    );
    const serialize = createCredentialEnvelopeMutationLock();
    const result = await serialize((lockProof) =>
      createKeychainPartitionEncryption({
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
        envelopeCensus: async () => census,
        lockProof,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    census = { deletionBlockers: 0, keychainDependents: 0 };
    await expect(serialize((proof) => result.deleteKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unknown",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
    expect(() => result.encryption.encryptString("orphan-candidate")).toThrow(
      KeychainEncryptionError,
    );

    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "ready",
    });
    expect(result.encryption.isEncryptionAvailable()).toBe(true);
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
      "delete-key",
      "read-key",
      "create-key",
    ]);
    const sealed = result.encryption.encryptString("post-cleanup-secret");
    expect(openCredentialEnvelope(replacement.key, sealed)).toBe("post-cleanup-secret");
  });

  it("refuses pending cleanup when a blocker appears", async () => {
    const original = storedKey();
    let census = { deletionBlockers: 1, keychainDependents: 1 };
    const transport = transportOf(
      PROBE_OK,
      { ok: true, op: "read-key", key: original.encoded },
      { ok: false, code: "unknown" },
    );
    const serialize = createCredentialEnvelopeMutationLock();
    const result = await serialize((lockProof) =>
      createKeychainPartitionEncryption({
        transport,
        service: KEYCHAIN_CREDENTIAL_SERVICE,
        envelopeCensus: async () => census,
        lockProof,
      }),
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    census = { deletionBlockers: 0, keychainDependents: 0 };
    await expect(serialize((proof) => result.deleteKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unknown",
    });
    census = { deletionBlockers: 1, keychainDependents: 0 };
    await expect(serialize((proof) => result.prepareKey(proof))).resolves.toEqual({
      status: "failed",
      code: "unknown",
    });
    expect(transport.requests.map((request) => request.op)).toEqual([
      "probe",
      "read-key",
      "delete-key",
    ]);
    expect(result.encryption.isEncryptionAvailable()).toBe(false);
  });
});
