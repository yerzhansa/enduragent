import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingErrorCode,
  type KeychainBindingTransport,
} from "./keychain-binding.js";

const PACKAGE_JSON_LIMIT = 64 * 1024;
const TELEGRAM_ACCEPTANCE_MARKER_DIGEST =
  "6403ac18359b3a76b67b73aaca35224bb208910cf1deb5b55df79ca6a770a272";
const TELEGRAM_ACCEPTANCE_PACKAGE_NAME_DIGEST =
  "8c7664f44392258f873dd70296c5978e00045627a70b33eebb799b38ac75c326";
const TELEGRAM_ACCEPTANCE_PRODUCT_NAME_DIGEST =
  "1cda3287fbe8127102a851088456509106bf8369111bd8860f56d80d3493461a";
const ACCEPTANCE_KEY_FILE = ".enduragent-acceptance-key";

// lockMarkerPath: while that file exists, the fake Keychain answers like a locked one.
export type AcceptanceCredentialBackend = (
  | Readonly<{ kind: "memory"; key: Buffer }>
  | Readonly<{ kind: "file"; keyPath: string }>
) &
  Readonly<{ lockMarkerPath?: string }>;

function matchesIdentity(value: unknown, digest: string): boolean {
  return (
    typeof value === "string" && createHash("sha256").update(value, "utf8").digest("hex") === digest
  );
}

function packagedAcceptanceManifest(input: {
  readonly appPath: string;
  readonly readPackageJson?: (path: string) => string;
}): boolean {
  try {
    const raw = (input.readPackageJson ?? ((path) => readFileSync(path, "utf8")))(
      join(input.appPath, "package.json"),
    );
    if (raw.length > PACKAGE_JSON_LIMIT) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const metadata = parsed as Record<string, unknown>;
    return (
      matchesIdentity(metadata.name, TELEGRAM_ACCEPTANCE_PACKAGE_NAME_DIGEST) &&
      matchesIdentity(metadata.productName, TELEGRAM_ACCEPTANCE_PRODUCT_NAME_DIGEST) &&
      Object.entries(metadata).some(
        ([name, value]) =>
          value === true && matchesIdentity(name, TELEGRAM_ACCEPTANCE_MARKER_DIGEST),
      )
    );
  } catch {
    return false;
  }
}

interface AcceptanceCredentialBackendInput {
  readonly isPackaged: boolean;
  readonly hidden: boolean;
  readonly backend: string | undefined;
  readonly appName: string;
  readonly appPath: string;
  readonly userDataPath: string;
  readonly disposableContext: boolean;
  readonly lockMarkerPath?: string | undefined;
  readonly readPackageJson?: (path: string) => string;
}

export function resolveAcceptanceCredentialBackend(
  input: AcceptanceCredentialBackendInput,
): AcceptanceCredentialBackend | undefined {
  const backend = eligibleBackend(input);
  const marker = input.lockMarkerPath;
  return backend === undefined || marker === undefined || !isAbsolute(marker)
    ? backend
    : { ...backend, lockMarkerPath: marker };
}

function eligibleBackend(
  input: AcceptanceCredentialBackendInput,
): AcceptanceCredentialBackend | undefined {
  if (!input.isPackaged) {
    return input.backend === "memory" && input.disposableContext
      ? { kind: "memory", key: randomBytes(KEYCHAIN_KEY_BYTES) }
      : undefined;
  }
  if (!input.hidden) return undefined;
  if (
    input.backend !== "file" ||
    !input.disposableContext ||
    !matchesIdentity(input.appName, TELEGRAM_ACCEPTANCE_PRODUCT_NAME_DIGEST) ||
    !packagedAcceptanceManifest(input)
  ) {
    return undefined;
  }
  return { kind: "file", keyPath: join(input.userDataPath, ACCEPTANCE_KEY_FILE) };
}

function memoryTransport(initialKey: Buffer): KeychainBindingTransport {
  let key: Buffer | undefined = Buffer.from(initialKey);
  return {
    async send(request) {
      if (request.op === "probe") {
        return { ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER };
      }
      if (request.op === "read-key") {
        return key === undefined
          ? { ok: false, code: "item-not-found" }
          : { ok: true, op: "read-key", key: Buffer.from(key) };
      }
      if (request.op === "create-key") {
        key ??= randomBytes(KEYCHAIN_KEY_BYTES);
        return { ok: true, op: "create-key", key: Buffer.from(key) };
      }
      if (request.op === "retry-created-key-rollback") {
        return { ok: true, op: "retry-created-key-rollback" };
      }
      const deleted = key !== undefined;
      key?.fill(0);
      key = undefined;
      return { ok: true, op: "delete-key", deleted };
    },
  };
}

type AcceptanceKeyRead =
  | Readonly<{ ok: true; op: "read-key"; key: Buffer }>
  | Readonly<{ ok: false; code: KeychainBindingErrorCode }>;

async function readFileKey(keyPath: string): Promise<AcceptanceKeyRead> {
  let key: Buffer;
  try {
    key = await readFile(keyPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: false, code: "item-not-found" }
      : { ok: false, code: "unknown" };
  }
  if (key.length !== KEYCHAIN_KEY_BYTES) {
    key.fill(0);
    return { ok: false, code: "unreadable-item" };
  }
  return { ok: true, op: "read-key", key };
}

function fileTransport(keyPath: string): KeychainBindingTransport {
  return {
    async send(request) {
      if (request.op === "probe") {
        return { ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER };
      }
      if (request.op === "read-key") return await readFileKey(keyPath);
      if (request.op === "create-key") {
        const existing = await readFileKey(keyPath);
        if (existing.ok) return { ...existing, op: "create-key" };
        if (existing.code !== "item-not-found") {
          return { ...existing, creationRollbackPending: false };
        }
        const key = randomBytes(KEYCHAIN_KEY_BYTES);
        try {
          await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
          return { ok: true, op: "create-key", key: Buffer.from(key) };
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EEXIST"
            ? await readFileKey(keyPath).then((response) =>
                response.ok
                  ? { ...response, op: "create-key" }
                  : { ...response, creationRollbackPending: false },
              )
            : { ok: false, code: "unknown", creationRollbackPending: false };
        } finally {
          key.fill(0);
        }
      }
      if (request.op === "retry-created-key-rollback") {
        return { ok: true, op: "retry-created-key-rollback" };
      }
      try {
        await unlink(keyPath);
        return { ok: true, op: "delete-key", deleted: true };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { ok: true, op: "delete-key", deleted: false }
          : { ok: false, code: "unknown" };
      }
    },
  };
}

// A locked login Keychain still answers the probe and a rollback retry with no debt;
// every item read, create, or delete is refused (native CreateKey reports no rollback).
function lockedWhileMarkerExists(
  transport: KeychainBindingTransport,
  markerPath: string,
): KeychainBindingTransport {
  return {
    async send(request) {
      if (request.op === "probe" || request.op === "retry-created-key-rollback") {
        return await transport.send(request);
      }
      const locked = await access(markerPath).then(
        () => true,
        () => false,
      );
      if (!locked) return await transport.send(request);
      return request.op === "create-key"
        ? { ok: false, code: "keychain-locked", creationRollbackPending: false }
        : { ok: false, code: "keychain-locked" };
    },
  };
}

export function createAcceptanceKeychainTransport(
  backend: AcceptanceCredentialBackend,
): KeychainBindingTransport {
  const transport =
    backend.kind === "memory" ? memoryTransport(backend.key) : fileTransport(backend.keyPath);
  return backend.lockMarkerPath === undefined
    ? transport
    : lockedWhileMarkerExists(transport, backend.lockMarkerPath);
}
