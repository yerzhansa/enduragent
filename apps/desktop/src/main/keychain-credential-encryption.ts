import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialEnvelopeLockProof } from "./credential-envelope-lock.js";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import {
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingErrorCode,
  type KeychainBindingTransport,
} from "./keychain-binding.js";

export const KEYCHAIN_PARTITION_STORAGE_BACKEND = "keychain_partition_v1" as const;
export const CREDENTIAL_ENVELOPE_MAGIC = "ENDURAGENT1" as const;
export const SAFE_STORAGE_ENVELOPE_KEY_ID = 0;
export const KEYCHAIN_ENVELOPE_KEY_ID = 1;
export const CREDENTIAL_ENVELOPE_IV_BYTES = 12;
export const CREDENTIAL_ENVELOPE_TAG_BYTES = 16;

const MAGIC = Buffer.from(CREDENTIAL_ENVELOPE_MAGIC, "ascii");
const HEADER_BYTES = MAGIC.length + 1;
const MINIMUM_ENVELOPE_BYTES =
  HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES + CREDENTIAL_ENVELOPE_TAG_BYTES;

export class KeychainEncryptionError extends Error {
  constructor(readonly code: KeychainBindingErrorCode) {
    super();
  }
}

export class CredentialEnvelopeError extends Error {}

export function readCredentialEnvelopeKeyId(envelope: Buffer): number | undefined {
  if (envelope.length < MINIMUM_ENVELOPE_BYTES) return undefined;
  if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) return undefined;
  return envelope[MAGIC.length];
}

export function sealCredentialEnvelope(key: Buffer, value: string): Buffer {
  const iv = randomBytes(CREDENTIAL_ENVELOPE_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const header = Buffer.concat([MAGIC, Buffer.of(KEYCHAIN_ENVELOPE_KEY_ID)]);
  return Buffer.concat([header, iv, ciphertext, cipher.getAuthTag()]);
}

export function openCredentialEnvelope(key: Buffer, envelope: Buffer): string {
  if (readCredentialEnvelopeKeyId(envelope) !== KEYCHAIN_ENVELOPE_KEY_ID) {
    throw new CredentialEnvelopeError();
  }
  const iv = envelope.subarray(HEADER_BYTES, HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES);
  const tag = envelope.subarray(envelope.length - CREDENTIAL_ENVELOPE_TAG_BYTES);
  const ciphertext = envelope.subarray(
    HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES,
    envelope.length - CREDENTIAL_ENVELOPE_TAG_BYTES,
  );
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export type KeychainPartitionEncryptionResult =
  | {
      readonly status: "ready";
      readonly encryption: CredentialEncryptionPort;
      readonly createdKey: boolean;
      readonly prepareKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyPreparation>;
      readonly deleteKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyDeletion>;
    }
  | {
      readonly status: "unavailable";
      readonly code: KeychainBindingErrorCode;
      readonly keyCleanupPending: boolean;
      readonly encryption: CredentialEncryptionPort;
    }
  | {
      readonly status: "storage-failed";
      readonly code: KeychainBindingErrorCode;
      readonly keyCleanupPending: boolean;
      readonly encryption: CredentialEncryptionPort;
    }
  | {
      readonly status: "unsupported";
      readonly code: "not-team-signed";
    };

export interface CreateKeychainPartitionEncryptionOptions {
  readonly transport: KeychainBindingTransport;
  readonly service: string;
  readonly envelopeCensus:
    | KeychainEnvelopeCensus
    | (() => Promise<KeychainEnvelopeCensus>);
  readonly keyCleanupPending?: boolean;
  readonly lockProof: CredentialEnvelopeLockProof;
}

export interface KeychainEnvelopeCensus {
  readonly deletionBlockers: number;
  readonly keychainDependents: number;
}

export function createRefusingKeychainEncryption(
  code: KeychainBindingErrorCode,
  available: boolean,
): CredentialEncryptionPort {
  const refuse = (): never => {
    throw new KeychainEncryptionError(code);
  };
  return {
    isEncryptionAvailable: () => available,
    encryptString: refuse,
    decryptString: refuse,
    getSelectedStorageBackend: () => KEYCHAIN_PARTITION_STORAGE_BACKEND,
  };
}

export type KeychainKeyPreparation =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>;

export type KeychainKeyDeletion =
  | Readonly<{ status: "deleted" | "already-absent" }>
  | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>;

interface KeyHolder {
  key: Buffer | null;
  failure: KeychainBindingErrorCode;
  cleanupPending: boolean;
}

function readyPort(holder: KeyHolder): CredentialEncryptionPort {
  const currentKey = (): Buffer => {
    if (holder.key === null) throw new KeychainEncryptionError(holder.failure);
    return holder.key;
  };
  return {
    isEncryptionAvailable: () => holder.key !== null,
    encryptString: (value: string) => sealCredentialEnvelope(currentKey(), value),
    decryptString: (envelope: Buffer) => openCredentialEnvelope(currentKey(), envelope),
    getSelectedStorageBackend: () => KEYCHAIN_PARTITION_STORAGE_BACKEND,
  };
}

function refused(
  code: KeychainBindingErrorCode,
  keyCleanupPending = false,
): KeychainPartitionEncryptionResult {
  if (code === "keychain-locked" || code === "uninspectable-item" || code === "item-not-found") {
    return {
      status: "unavailable",
      code,
      keyCleanupPending,
      encryption: createRefusingKeychainEncryption(code, false),
    };
  }
  return {
    status: "storage-failed",
    code,
    keyCleanupPending,
    encryption: createRefusingKeychainEncryption(code, true),
  };
}

export async function createKeychainPartitionEncryption(
  options: CreateKeychainPartitionEncryptionOptions,
): Promise<KeychainPartitionEncryptionResult> {
  const { transport, service } = options;
  const probe = await transport.send({ op: "probe", service });
  if (!probe.ok) {
    return probe.code === "not-team-signed"
      ? { status: "unsupported", code: "not-team-signed" }
      : refused(probe.code);
  }
  if (probe.op !== "probe" || probe.teamIdentifier !== KEYCHAIN_TEAM_IDENTIFIER) {
    return refused("unknown");
  }
  const envelopeCensus = async (): Promise<KeychainEnvelopeCensus> =>
    typeof options.envelopeCensus === "function"
      ? await options.envelopeCensus()
      : options.envelopeCensus;
  const initialCensus = await envelopeCensus();

  const createMaterial = async (): Promise<
    | Readonly<{ status: "ready"; key: Buffer }>
    | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>
  > => {
    const created = await transport.send({ op: "create-key", service });
    if (!created.ok) return { status: "failed", code: created.code };
    if (created.op !== "create-key") return { status: "failed", code: "unknown" };
    const key = Buffer.from(created.key);
    return key.length === KEYCHAIN_KEY_BYTES
      ? { status: "ready", key }
      : { status: "failed", code: "unknown" };
  };

  const readMaterial = async (): Promise<
    | Readonly<{ status: "ready"; key: Buffer }>
    | Readonly<{ status: "missing" }>
    | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>
  > => {
    const read = await transport.send({ op: "read-key", service });
    if (!read.ok) {
      return read.code === "item-not-found"
        ? { status: "missing" }
        : { status: "failed", code: read.code };
    }
    if (read.op !== "read-key") return { status: "failed", code: "unknown" };
    const key = Buffer.from(read.key);
    return key.length === KEYCHAIN_KEY_BYTES
      ? { status: "ready", key }
      : { status: "failed", code: "unknown" };
  };

  const deleteMaterial = async (): Promise<KeychainKeyDeletion> => {
    const deleted = await transport.send({ op: "delete-key", service });
    if (!deleted.ok || deleted.op !== "delete-key") {
      return { status: "failed", code: deleted.ok ? "unknown" : deleted.code };
    }
    return { status: deleted.deleted ? "deleted" : "already-absent" };
  };

  const ready = (key: Buffer | null, createdKey: boolean): KeychainPartitionEncryptionResult => {
    const holder: KeyHolder = { key, failure: "item-not-found", cleanupPending: false };
    const prepareKey = async (): Promise<KeychainKeyPreparation> => {
      if (holder.key !== null) return { status: "ready" };
      if (holder.cleanupPending) {
        const census = await envelopeCensus();
        if (census.deletionBlockers > 0) {
          holder.failure = "unknown";
          return { status: "failed", code: holder.failure };
        }
        const deleted = await deleteMaterial();
        if (deleted.status === "failed") {
          holder.failure = deleted.code;
          return deleted;
        }
        holder.cleanupPending = false;
      }
      const existing = await readMaterial();
      if (existing.status === "ready") {
        holder.key = existing.key;
        holder.failure = "item-not-found";
        return { status: "ready" };
      }
      if (existing.status === "failed") {
        holder.failure = existing.code;
        return existing;
      }
      const census = await envelopeCensus();
      if (census.keychainDependents > 0) {
        holder.failure = "item-not-found";
        return { status: "failed", code: holder.failure };
      }
      const created = await createMaterial();
      if (created.status === "failed") {
        holder.failure = created.code;
        return created;
      }
      holder.key = created.key;
      holder.failure = "item-not-found";
      return { status: "ready" };
    };
    const deleteKey = async (): Promise<KeychainKeyDeletion> => {
      const census = await envelopeCensus();
      if (census.deletionBlockers > 0) {
        holder.failure = "unknown";
        return { status: "failed", code: holder.failure };
      }
      const previous = holder.key;
      holder.key = null;
      const deleted = await deleteMaterial();
      if (deleted.status === "failed") {
        previous?.fill(0);
        holder.failure = deleted.code;
        holder.cleanupPending = true;
        return deleted;
      }
      previous?.fill(0);
      holder.failure = "item-not-found";
      holder.cleanupPending = false;
      return deleted;
    };
    return { status: "ready", encryption: readyPort(holder), createdKey, prepareKey, deleteKey };
  };

  if (options.keyCleanupPending) {
    if (initialCensus.deletionBlockers > 0) return refused("unknown", true);
    const deleted = await deleteMaterial();
    return deleted.status === "failed" ? refused(deleted.code, true) : ready(null, false);
  }

  const read = await readMaterial();
  if (read.status === "ready") {
    if (initialCensus.deletionBlockers > 0) return ready(read.key, false);
    const deleted = await deleteMaterial();
    read.key.fill(0);
    return deleted.status === "failed" ? refused(deleted.code, true) : ready(null, false);
  }
  if (read.status === "missing") {
    return initialCensus.keychainDependents === 0
      ? ready(null, false)
      : refused("item-not-found");
  }
  return refused(read.code);
}
