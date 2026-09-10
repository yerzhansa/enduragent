import { cliPhrasebook, say } from "../cli-copy.js";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  WindowsPrivatePathPolicyError,
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  windowsPrivatePathIdentity,
  type WindowsPrivateDirectoryBinding,
  type WindowsPrivatePathIdentity,
  type WindowsPrivatePathPolicyStage,
} from "../io/windows-private-path-policy.js";
import { enumerateTelegramSessions } from "./telegram-sessions.js";

export type DmPolicy = "pairing" | "allowlist" | "open";

export const ALLOWED_SENDERS_FILE = "allowed-senders.json";
export const MAX_ALLOWED_SENDERS_FILE_BYTES = 1_048_576;
const ACCESS_RESET_MARKER = ".telegram-access-reset";
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface AllowedSendersStorageOptions {
  readonly platform?: NodeJS.Platform;
}

export interface AllowedSenders {
  version: 1;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  primaryOperator: string | null;
  capturedAt: string | null;
  addedAt: Record<string, string>;
  desktopBotId?: string;
  [unknownKey: string]: unknown;
}

export function defaultPairingState(): AllowedSenders {
  return {
    version: 1,
    dmPolicy: "pairing",
    allowFrom: [],
    primaryOperator: null,
    capturedAt: null,
    addedAt: {},
  };
}

/**
 * Telegram user-ids: positive integer with at least 2 digits, no leading zero.
 * Telegram never assigns 0 or single-digit IDs; the regex rejects malformed
 * env-var fragments and bare 0 while staying length-agnostic on the high end.
 */
export const SENDER_ID_RE = /^[1-9]\d+$/;
const OPERATOR_ID_ENV = "CYCLING_COACH_OPERATOR_ID";
const DM_POLICY_ENV = "CYCLING_COACH_DM_POLICY";

function loadFromEnv(): AllowedSenders | null {
  const raw = process.env[OPERATOR_ID_ENV];
  if (raw === undefined || raw === "") return null;
  if (!SENDER_ID_RE.test(raw)) {
    console.error(
      say("telegram.security.invalidEnvironment", {
        variable: OPERATOR_ID_ENV,
        value: raw,
        service: "Telegram",
        minimumDigits: cliPhrasebook().format.number(2),
      }),
    );
    return null;
  }
  return {
    version: 1,
    dmPolicy: "allowlist",
    allowFrom: [raw],
    primaryOperator: raw,
    capturedAt: null,
    addedAt: {},
  };
}

// Zod accepts file shapes that originated from older revisions or hand-edits:
// strings/numbers in `allowFrom` are coerced to strings, invalid items are
// dropped (with a stderr warning per item), unknown top-level fields pass
// through for forward-compat. `dmPolicy: "open"` is rejected here on purpose —
// it can only be set via the CYCLING_COACH_DM_POLICY env var.
const senderIdSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => SENDER_ID_RE.test(s));

function validateSchema(
  parsed: unknown,
  diagnostic: string,
  discloseInvalidEntries = true,
): AllowedSenders | null {
  const schema = z
    .object({
      version: z.literal(1),
      dmPolicy: z.union([z.literal("pairing"), z.literal("allowlist")]),
      allowFrom: z.array(z.unknown()).transform((arr) => {
        const out: string[] = [];
        for (const item of arr) {
          const r = senderIdSchema.safeParse(item);
          if (r.success) out.push(r.data);
          else
            console.error(
              discloseInvalidEntries
                ? say("telegram.security.invalidEntry", {
                    diagnostic,
                    field: "allowFrom",
                    entry: JSON.stringify(item),
                  })
                : say("telegram.security.invalidEntryPrivate", { diagnostic, field: "allowFrom" }),
            );
        }
        return out;
      }),
      primaryOperator: z.union([z.string().regex(SENDER_ID_RE), z.null()]).optional(),
      capturedAt: z.string().nullable().optional(),
      addedAt: z.record(z.string(), z.string()).optional(),
      desktopBotId: z.string().regex(SENDER_ID_RE).optional(),
    })
    .passthrough();

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join(".") || "root";
    console.error(say("telegram.security.invalidField", { diagnostic, field }));
    return null;
  }
  if (result.data.allowFrom.length === 0 && result.data.dmPolicy === "allowlist") {
    console.error(say("telegram.security.emptyAllowlist", { diagnostic, field: "allowFrom" }));
    return null;
  }
  return result.data as AllowedSenders;
}

function readWindowsAllowedSendersFile(dataDir: string, path: string): string | null {
  let descriptor: number | undefined;
  let contents: Buffer | undefined;
  try {
    const directory = bindWindowsPrivateDirectory(dirname(dataDir), dataDir);
    let beforeOpen;
    try {
      beforeOpen = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        assertWindowsPrivateDirectoryStable(directory);
        return null;
      }
      throw error;
    }
    assertWindowsPrivateFileMetadata(beforeOpen);
    assertWindowsPrivatePathRead({
      bounded:
        Number.isSafeInteger(beforeOpen.size) && beforeOpen.size <= MAX_ALLOWED_SENDERS_FILE_BYTES,
      identityStable: true,
      contentValid: true,
      authenticatedHomeBinding: true,
    });
    const expectedIdentity = windowsPrivatePathIdentity(beforeOpen);
    assertWindowsPrivateFileBinding(directory, path, expectedIdentity);
    descriptor = openSync(path, fsConstants.O_RDONLY);
    const opened = fstatSync(descriptor);
    assertWindowsPrivateFileMetadata(opened);
    assertWindowsPrivatePathRead({
      bounded: Number.isSafeInteger(opened.size) && opened.size <= MAX_ALLOWED_SENDERS_FILE_BYTES,
      identityStable: sameWindowsPrivatePathIdentity(
        expectedIdentity,
        windowsPrivatePathIdentity(opened),
      ),
      contentValid: true,
      authenticatedHomeBinding: true,
    });
    assertWindowsPrivateFileBinding(directory, path, windowsPrivatePathIdentity(opened));
    contents = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead <= 0) {
        throw new WindowsPrivatePathPolicyError("read-check", "corruption");
      }
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const extraBytes = readSync(descriptor, probe, 0, probe.length, offset);
    probe.fill(0);
    const afterRead = fstatSync(descriptor);
    assertWindowsPrivateFileMetadata(afterRead);
    const current = assertWindowsPrivateFileBinding(
      directory,
      path,
      windowsPrivatePathIdentity(afterRead),
    );
    assertWindowsPrivatePathRead({
      bounded: true,
      identityStable:
        sameWindowsPrivatePathIdentity(expectedIdentity, windowsPrivatePathIdentity(opened)) &&
        sameWindowsPrivatePathIdentity(
          windowsPrivatePathIdentity(opened),
          windowsPrivatePathIdentity(afterRead),
        ) &&
        opened.size === afterRead.size &&
        opened.size === current.size &&
        opened.mtimeMs === afterRead.mtimeMs &&
        opened.mtimeMs === current.mtimeMs &&
        opened.ctimeMs === afterRead.ctimeMs &&
        opened.ctimeMs === current.ctimeMs,
      contentValid: offset === opened.size && extraBytes === 0,
      authenticatedHomeBinding: true,
    });
    assertWindowsPrivateDirectoryStable(directory);
    closeSync(descriptor);
    descriptor = undefined;
    let result: string;
    try {
      result = STRICT_UTF8_DECODER.decode(contents);
    } catch {
      throw new WindowsPrivatePathPolicyError("read-check", "corruption");
    }
    contents.fill(0);
    contents = undefined;
    return result;
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("read-check", error);
  } finally {
    contents?.fill(0);
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function loadFromFile(dataDir: string, platform: NodeJS.Platform): AllowedSenders | null {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  let raw: string;
  if (platform === "win32") {
    const windowsRaw = readWindowsAllowedSendersFile(dataDir, path);
    if (windowsRaw === null) return null;
    raw = windowsRaw;
  } else {
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (platform === "win32") {
      throw new WindowsPrivatePathPolicyError("read-check", "corruption");
    }
    console.error(
      say("telegram.security.invalidJson", {
        path,
        format: "JSON",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
  const validated = validateSchema(
    parsed,
    platform === "win32" ? say("telegram.security.authorization", { service: "Telegram" }) : path,
    platform !== "win32",
  );
  if (validated === null && platform === "win32") {
    throw new WindowsPrivatePathPolicyError("read-check", "corruption");
  }
  return validated;
}

// Cache parsed AllowedSenders by file identity. The auth middleware calls
// loadAllowedSenders on every inbound message; caching avoids re-running JSON
// parse + zod validation when the file hasn't changed. saveAllowedSenders
// invalidates this cache after committing a write. Note: cache is keyed by
// dataDir so a single process serving multiple homes still works.
interface AllowedSendersFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

const fileCache = new Map<
  string,
  { identity: AllowedSendersFileIdentity; value: AllowedSenders }
>();
const uncertainAccessFences = new Set<string>();

function allowedSendersFileIdentity(path: string): AllowedSendersFileIdentity {
  const metadata = statSync(path, { bigint: true });
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
  };
}

function sameAllowedSendersFileIdentity(
  left: AllowedSendersFileIdentity,
  right: AllowedSendersFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function pathExistsOrIsUninspectable(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function accessFenceActive(dataDir: string, platform: NodeJS.Platform): boolean {
  const markerPath = join(dataDir, ACCESS_RESET_MARKER);
  if (platform === "win32" && !uncertainAccessFences.has(dataDir)) {
    try {
      lstatSync(markerPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw classifyWindowsPrivatePathFailure("read-check", error);
    }
  }
  return uncertainAccessFences.has(dataDir) || pathExistsOrIsUninspectable(markerPath);
}

function loadFromFileCached(dataDir: string, platform: NodeJS.Platform): AllowedSenders | null {
  if (platform === "win32") {
    fileCache.delete(dataDir);
    return loadFromFile(dataDir, platform);
  }
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  let identity: AllowedSendersFileIdentity;
  try {
    identity = allowedSendersFileIdentity(path);
  } catch {
    fileCache.delete(dataDir);
    return null;
  }
  const cached = fileCache.get(dataDir);
  if (cached && sameAllowedSendersFileIdentity(cached.identity, identity)) return cached.value;
  const fresh = loadFromFile(dataDir, platform);
  if (fresh) fileCache.set(dataDir, { identity, value: fresh });
  else fileCache.delete(dataDir);
  return fresh;
}

export type AllowedSendersSource = "file" | "env" | "default-pairing";

export interface AllowedSendersLoad {
  state: AllowedSenders;
  source: AllowedSendersSource;
}

export function loadAllowedSendersWithSource(
  dataDir: string,
  options: AllowedSendersStorageOptions = {},
): AllowedSendersLoad {
  const platform = options.platform ?? process.platform;
  if (accessFenceActive(dataDir, platform)) {
    return { state: defaultPairingState(), source: "default-pairing" };
  }
  const fromFile = loadFromFileCached(dataDir, platform);
  const baseAndSource: AllowedSendersLoad = fromFile
    ? { state: fromFile, source: "file" }
    : (() => {
        const fromEnv = loadFromEnv();
        return fromEnv
          ? { state: fromEnv, source: "env" }
          : { state: defaultPairingState(), source: "default-pairing" };
      })();

  // CYCLING_COACH_DM_POLICY=open is env-var-only (cannot be set via file). The
  // override preserves base.allowFrom so notifyUpdate's filter still has the
  // operator's friends list to broadcast to. Source flips to "env" since the
  // override is what determined the effective policy.
  if (process.env[DM_POLICY_ENV] === "open") {
    return { state: { ...baseAndSource.state, dmPolicy: "open" }, source: "env" };
  }
  return baseAndSource;
}

export function loadAllowedSenders(
  dataDir: string,
  options: AllowedSendersStorageOptions = {},
): AllowedSenders {
  return loadAllowedSendersWithSource(dataDir, options).state;
}

export function loadAllowedSendersFromFile(
  dataDir: string,
  options: AllowedSendersStorageOptions = {},
): AllowedSenders {
  const platform = options.platform ?? process.platform;
  if (accessFenceActive(dataDir, platform)) return defaultPairingState();
  return loadFromFileCached(dataDir, platform) ?? defaultPairingState();
}

export interface DesktopAllowedSender {
  senderId: string;
  role: "primary" | "additional";
  addedAt?: string;
}

export type ClaimPrimaryOperatorResult =
  | {
      status: "claimed" | "already-primary";
      sender: DesktopAllowedSender;
    }
  | {
      status: "refused";
      reason: "primary-exists" | "inconsistent-state";
    }
  | { status: "uncertain" };

export type AddSecondarySenderResult =
  | {
      status: "added" | "already-allowed";
      sender: DesktopAllowedSender;
    }
  | { status: "uncertain" }
  | {
      status: "refused";
      reason: "primary-required" | "inconsistent-state";
    };

export type RemoveSecondarySenderResult =
  | { status: "removed" | "not-found" }
  | { status: "uncertain" }
  | {
      status: "refused";
      reason: "primary-removal" | "inconsistent-state";
    };

// ─── PID lockfile ────────────────────────────────────────────────────────────
// Serialize cross-process writes to allowed-senders.json. Lockfile lives at
// <dataDir>/.allowed-senders.lock. Locks owned by a dead PID are reclaimed.

const LOCK_FILE = ".allowed-senders.lock";

export class LockfileContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileContentionError";
  }
}

class WindowsLockfileContentionError extends LockfileContentionError {
  readonly stage = "binding-check";
  readonly category = "sharing-violation";

  constructor() {
    super(say("telegram.security.lockHeld", { service: "Telegram" }));
  }
}

export class AllowedSendersRecoveryRequiredError extends Error {
  constructor(dataDir: string, options: AllowedSendersStorageOptions = {}) {
    super(
      (options.platform ?? process.platform) === "win32"
        ? say("telegram.security.recoveryRequired", { service: "Telegram" })
        : say("telegram.security.recoveryRequiredAt", { path: dataDir, service: "Telegram" }),
    );
    this.name = "AllowedSendersRecoveryRequiredError";
  }
}

export class AllowedSendersCommitUncertainError extends Error {
  constructor(dataDir: string, cause: unknown, options: AllowedSendersStorageOptions = {}) {
    super(
      (options.platform ?? process.platform) === "win32"
        ? say("telegram.security.commitUncertain", { service: "Telegram" })
        : say("telegram.security.commitUncertainAt", { path: dataDir, service: "Telegram" }),
      { cause },
    );
    this.name = "AllowedSendersCommitUncertainError";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Only ESRCH proves the process is gone. Permission and I/O failures must
    // preserve the lock because they do not prove its owner is dead.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockfileIsStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const [pidStr] = raw.split("\n");
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return !isProcessAlive(pid);
}

function windowsLockfileIsStale(dataDir: string, lockPath: string): boolean {
  const raw = readWindowsAllowedSendersFile(dataDir, lockPath);
  if (raw === null) return true;
  const parts = raw.split("\n");
  const pid = Number(parts[0]);
  if (
    parts.length !== 3 ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isFinite(Date.parse(parts[1] ?? "")) ||
    (parts[2]?.length ?? 0) === 0
  ) {
    throw new WindowsPrivatePathPolicyError("read-check", "corruption");
  }
  return !isProcessAlive(pid);
}

interface LockfileOwnership {
  path: string;
  content: string;
  windowsIdentity?: WindowsPrivatePathIdentity;
}

interface AllowedSendersStorageContext {
  readonly platform: NodeJS.Platform;
  readonly windowsDirectory?: WindowsPrivateDirectoryBinding;
}

function assertWindowsIdentity(expected: WindowsPrivatePathIdentity, metadata: Stats): void {
  if (!sameWindowsPrivatePathIdentity(expected, windowsPrivatePathIdentity(metadata))) {
    throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
  }
}

function prepareLockfileClaim(
  lockPath: string,
  content: string,
  token: string,
  context: AllowedSendersStorageContext,
): string {
  const tempPath = `${lockPath}.tmp.${token}`;
  let descriptor: number | undefined;
  let stage: WindowsPrivatePathPolicyStage = "content-write";
  try {
    descriptor = openSync(
      tempPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (context.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW),
      0o600,
    );
    let windowsIdentity: WindowsPrivatePathIdentity | undefined;
    if (context.platform === "win32") {
      const opened = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(opened);
      windowsIdentity = windowsPrivatePathIdentity(opened);
      assertWindowsPrivateFileBinding(context.windowsDirectory!, tempPath, windowsIdentity);
    }
    writeFileSync(descriptor, content, "utf8");
    if (context.platform === "win32") {
      const written = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(written);
      assertWindowsIdentity(windowsIdentity!, written);
      assertWindowsPrivateFileBinding(context.windowsDirectory!, tempPath, windowsIdentity!);
    }
    stage = "file-flush";
    fsyncSync(descriptor);
    if (context.platform === "win32") {
      const flushed = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(flushed);
      assertWindowsIdentity(windowsIdentity!, flushed);
      assertWindowsPrivateFileBinding(context.windowsDirectory!, tempPath, windowsIdentity!);
      assertWindowsPrivateDirectoryStable(context.windowsDirectory!);
    }
    closeSync(descriptor);
    descriptor = undefined;
    return tempPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      unlinkSync(tempPath);
    } catch {}
    throw context.platform === "win32" ? classifyWindowsPrivatePathFailure(stage, error) : error;
  }
}

function acquireLockfile(
  dataDir: string,
  context: AllowedSendersStorageContext,
): LockfileOwnership {
  const lockPath = join(dataDir, LOCK_FILE);
  const token = randomUUID();
  const content = `${process.pid}\n${new Date().toISOString()}\n${token}`;
  const tempPath = prepareLockfileClaim(lockPath, content, token, context);
  let windowsIdentity: WindowsPrivatePathIdentity | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tempPath, lockPath);
        if (context.platform === "win32") {
          const linked = lstatSync(tempPath);
          assertWindowsPrivateFileMetadata(linked, 2);
          windowsIdentity = windowsPrivatePathIdentity(linked);
          assertWindowsPrivateFileBinding(context.windowsDirectory!, tempPath, windowsIdentity, 2);
          assertWindowsPrivateFileBinding(context.windowsDirectory!, lockPath, windowsIdentity, 2);
        }
        return { path: lockPath, content, windowsIdentity };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const stale =
          context.platform === "win32"
            ? windowsLockfileIsStale(dataDir, lockPath)
            : lockfileIsStale(lockPath);
        if (stale) {
          try {
            unlinkSync(lockPath);
            if (context.platform === "win32") {
              assertWindowsPrivateDirectoryStable(context.windowsDirectory!);
            }
          } catch (error) {
            if (
              context.platform === "win32" &&
              (error as NodeJS.ErrnoException).code !== "ENOENT"
            ) {
              throw classifyWindowsPrivatePathFailure("rename", error);
            }
          }
          continue;
        }
        if (context.platform === "win32") throw new WindowsLockfileContentionError();
        throw new LockfileContentionError(
          say("telegram.security.lockHeldByProcess", {
            process: process.argv[1] ?? "cycling-coach",
            path: lockPath,
          }),
        );
      }
    }
    if (context.platform === "win32") throw new WindowsLockfileContentionError();
    throw new LockfileContentionError(say("telegram.security.lockFailed", { path: lockPath }));
  } catch (error) {
    throw context.platform === "win32" && !(error instanceof LockfileContentionError)
      ? classifyWindowsPrivatePathFailure("rename", error)
      : error;
  } finally {
    removeLockfileClaim(tempPath, context);
    if (context.platform === "win32" && windowsIdentity !== undefined) {
      assertWindowsPrivateFileBinding(context.windowsDirectory!, lockPath, windowsIdentity);
    }
  }
}

function removeLockfileClaim(path: string, context: AllowedSendersStorageContext): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (context.platform === "win32" && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw classifyWindowsPrivatePathFailure("rename", error);
    }
  }
}

function releaseLockfile(
  ownership: LockfileOwnership,
  context: AllowedSendersStorageContext,
): void {
  if (context.platform === "win32") {
    let stage: WindowsPrivatePathPolicyStage = "read-check";
    try {
      const metadata = lstatSync(ownership.path);
      assertWindowsPrivateFileMetadata(metadata);
      assertWindowsPrivateFileBinding(
        context.windowsDirectory!,
        ownership.path,
        ownership.windowsIdentity!,
      );
      const observed = readWindowsAllowedSendersFile(
        context.windowsDirectory!.path,
        ownership.path,
      );
      if (observed === null || observed !== ownership.content) {
        throw new WindowsPrivatePathPolicyError("read-check", "corruption");
      }
      assertWindowsPrivateFileBinding(
        context.windowsDirectory!,
        ownership.path,
        ownership.windowsIdentity!,
      );
      stage = "rename";
      unlinkSync(ownership.path);
      assertWindowsPrivateDirectoryStable(context.windowsDirectory!);
      return;
    } catch (error) {
      throw classifyWindowsPrivatePathFailure(stage, error);
    }
  }
  try {
    if (readFileSync(ownership.path, "utf8") !== ownership.content) return;
    unlinkSync(ownership.path);
  } catch {
    // Already gone or never created — nothing to do.
  }
}

function secureDataDir(
  dataDir: string,
  platform: NodeJS.Platform,
): WindowsPrivateDirectoryBinding | undefined {
  if (platform === "win32") {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      return bindWindowsPrivateDirectory(dirname(dataDir), dataDir);
    } catch (error) {
      throw classifyWindowsPrivatePathFailure("entry-check", error);
    }
  }
  // mkdirSync with `mode` is a no-op on existing dirs, so explicit chmod is the
  // only path that tightens upgrade installs that pre-date this enforcement.
  if (existsSync(dataDir)) {
    const mode = statSync(dataDir).mode & 0o777;
    if (mode !== 0o700) {
      chmodSync(dataDir, 0o700);
      console.error(
        say("telegram.security.permissions", {
          path: dataDir,
          previous: `0o${mode.toString(8)}`,
          next: "0o700",
        }),
      );
    }
  } else {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  return undefined;
}

export function ensureDataDirSecure(
  dataDir: string,
  options: AllowedSendersStorageOptions = {},
): void {
  secureDataDir(dataDir, options.platform ?? process.platform);
}

function syncDirectory(dataDir: string, context: AllowedSendersStorageContext): void {
  if (context.platform === "win32") {
    assertWindowsPrivateDirectoryStable(context.windowsDirectory!);
    if (classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable") return;
  }
  const descriptor = openSync(
    dataDir,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeWindowsFileDurably(
  path: string,
  contents: string,
  directory: WindowsPrivateDirectoryBinding,
): WindowsPrivatePathIdentity {
  let descriptor: number | undefined;
  let identity: WindowsPrivatePathIdentity | undefined;
  let stage: WindowsPrivatePathPolicyStage = "content-write";
  try {
    assertWindowsPrivateDirectoryStable(directory);
    let beforeOpen;
    try {
      beforeOpen = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (beforeOpen === undefined) {
      descriptor = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      const opened = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(opened);
      identity = windowsPrivatePathIdentity(opened);
    } else {
      assertWindowsPrivateFileMetadata(beforeOpen);
      identity = windowsPrivatePathIdentity(beforeOpen);
      assertWindowsPrivateFileBinding(directory, path, identity);
      descriptor = openSync(path, fsConstants.O_WRONLY);
      const opened = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(opened);
      assertWindowsIdentity(identity, opened);
      assertWindowsPrivateFileBinding(directory, path, identity);
      ftruncateSync(descriptor, 0);
    }
    assertWindowsPrivateFileBinding(directory, path, identity);
    writeFileSync(descriptor, contents, "utf8");
    const written = fstatSync(descriptor);
    assertWindowsPrivateFileMetadata(written);
    assertWindowsIdentity(identity, written);
    assertWindowsPrivateFileBinding(directory, path, identity);
    stage = "file-flush";
    fsyncSync(descriptor);
    const flushed = fstatSync(descriptor);
    assertWindowsPrivateFileMetadata(flushed);
    assertWindowsIdentity(identity, flushed);
    assertWindowsPrivateFileBinding(directory, path, identity);
    assertWindowsPrivateDirectoryStable(directory);
    closeSync(descriptor);
    descriptor = undefined;
    return identity;
  } catch (error) {
    throw classifyWindowsPrivatePathFailure(stage, error);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function writeFileDurably(
  path: string,
  contents: string,
  context: AllowedSendersStorageContext,
): WindowsPrivatePathIdentity | undefined {
  if (context.platform === "win32") {
    return writeWindowsFileDurably(path, contents, context.windowsDirectory!);
  }
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return undefined;
}

function withAllowedSendersLock<T>(
  dataDir: string,
  operation: (context: AllowedSendersStorageContext) => T,
  options: AllowedSendersStorageOptions,
): T {
  const platform = options.platform ?? process.platform;
  const context = { platform, windowsDirectory: secureDataDir(dataDir, platform) };
  const ownership = acquireLockfile(dataDir, context);
  try {
    return operation(context);
  } finally {
    releaseLockfile(ownership, context);
  }
}

function publishAccessFenceLocked(dataDir: string, context: AllowedSendersStorageContext): void {
  uncertainAccessFences.add(dataDir);
  fileCache.delete(dataDir);
  writeFileDurably(join(dataDir, ACCESS_RESET_MARKER), "reset\n", context);
  syncDirectory(dataDir, context);
}

function removeAccessFenceLocked(dataDir: string, context: AllowedSendersStorageContext): void {
  const markerPath = join(dataDir, ACCESS_RESET_MARKER);
  let unlinked = false;
  try {
    unlinkSync(markerPath);
    unlinked = true;
    syncDirectory(dataDir, context);
    uncertainAccessFences.delete(dataDir);
  } catch (error) {
    uncertainAccessFences.add(dataDir);
    if (unlinked) {
      if (context.platform === "win32") {
        writeFileDurably(markerPath, "reset\n", context);
        syncDirectory(dataDir, context);
      } else {
        try {
          writeFileDurably(markerPath, "reset\n", context);
          syncDirectory(dataDir, context);
        } catch {}
      }
    }
    throw context.platform === "win32" ? classifyWindowsPrivatePathFailure("rename", error) : error;
  }
}

function refreshAllowedSendersCache(dataDir: string, next: AllowedSenders): void {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  try {
    fileCache.set(dataDir, { identity: allowedSendersFileIdentity(path), value: next });
  } catch {
    fileCache.delete(dataDir);
  }
}

function replaceAllowedSendersLocked(
  dataDir: string,
  next: AllowedSenders,
  context: AllowedSendersStorageContext,
): void {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  const tmp = `${path}.tmp`;
  let renamed = false;
  try {
    const windowsIdentity = writeFileDurably(tmp, JSON.stringify(next, null, 2), context);
    renameSync(tmp, path);
    renamed = true;
    if (context.platform === "win32") {
      assertWindowsPrivateFileBinding(context.windowsDirectory!, path, windowsIdentity!);
      assertWindowsPrivateDirectoryStable(context.windowsDirectory!);
    }
    syncDirectory(dataDir, context);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    if (context.platform === "win32") {
      throw classifyWindowsPrivatePathFailure(renamed ? "binding-check" : "rename", error);
    }
    if (renamed) throw new AllowedSendersCommitUncertainError(dataDir, error);
    throw error;
  }
}

function commitAllowedSendersLocked(
  dataDir: string,
  next: AllowedSenders,
  context: AllowedSendersStorageContext,
): AllowedSenders {
  publishAccessFenceLocked(dataDir, context);
  try {
    replaceAllowedSendersLocked(dataDir, next, context);
    try {
      removeAccessFenceLocked(dataDir, context);
    } catch (error) {
      if (context.platform === "win32") throw error;
      throw new AllowedSendersCommitUncertainError(dataDir, error);
    }
  } catch (error) {
    uncertainAccessFences.add(dataDir);
    fileCache.delete(dataDir);
    throw error;
  }
  refreshAllowedSendersCache(dataDir, next);
  return next;
}

function recoveryState(current: AllowedSenders | null): AllowedSenders {
  return {
    ...defaultPairingState(),
    ...(current?.desktopBotId === undefined ? {} : { desktopBotId: current.desktopBotId }),
  };
}

function mutateAllowedSenders(
  dataDir: string,
  transform: (current: AllowedSenders | null) => AllowedSenders,
  recoverPendingFence: boolean,
  options: AllowedSendersStorageOptions,
): AllowedSenders {
  return withAllowedSendersLock(
    dataDir,
    (context) => {
      let current = loadFromFile(dataDir, context.platform);
      if (accessFenceActive(dataDir, context.platform)) {
        if (!recoverPendingFence) {
          throw new AllowedSendersRecoveryRequiredError(dataDir, { platform: context.platform });
        }
        current = commitAllowedSendersLocked(dataDir, recoveryState(current), context);
      }
      const next = transform(current);
      if (next === current) return next;
      return commitAllowedSendersLocked(dataDir, next, context);
    },
    options,
  );
}

export function saveAllowedSenders(
  dataDir: string,
  transform: (current: AllowedSenders | null) => AllowedSenders,
  options: AllowedSendersStorageOptions = {},
): AllowedSenders {
  return mutateAllowedSenders(dataDir, transform, false, options);
}

export function resetDesktopAllowedSenders(
  dataDir: string,
  options: AllowedSendersStorageOptions = {},
): void {
  withAllowedSendersLock(
    dataDir,
    (context) => {
      commitAllowedSendersLocked(
        dataDir,
        recoveryState(loadFromFile(dataDir, context.platform)),
        context,
      );
    },
    options,
  );
}

export function bindDesktopTelegramAccess(
  dataDir: string,
  desktopBotId: string,
  options: AllowedSendersStorageOptions = {},
): "preserved" | "reset" {
  if (!SENDER_ID_RE.test(desktopBotId)) {
    throw new TypeError("invalid Desktop Telegram bot id");
  }
  return withAllowedSendersLock(
    dataDir,
    (context) => {
      const pendingReset = accessFenceActive(dataDir, context.platform);
      const current = loadFromFile(dataDir, context.platform);
      if (!pendingReset && current?.desktopBotId === desktopBotId) return "preserved";
      commitAllowedSendersLocked(dataDir, { ...defaultPairingState(), desktopBotId }, context);
      return "reset";
    },
    options,
  );
}

function assertSenderId(id: string): void {
  if (!SENDER_ID_RE.test(id)) {
    throw new Error(
      say("telegram.security.invalidSender", {
        id: JSON.stringify(id),
        minimumDigits: cliPhrasebook().format.number(2),
      }),
    );
  }
}

function desktopSender(state: AllowedSenders, senderId: string): DesktopAllowedSender {
  const addedAt =
    state.addedAt?.[senderId] ??
    (state.primaryOperator === senderId ? (state.capturedAt ?? undefined) : undefined);
  return {
    senderId,
    role: state.primaryOperator === senderId ? "primary" : "additional",
    ...(addedAt === undefined ? {} : { addedAt }),
  };
}

function hasUniqueSenderIds(state: AllowedSenders): boolean {
  return new Set(state.allowFrom).size === state.allowFrom.length;
}

function hasValidPrimary(state: AllowedSenders): boolean {
  return (
    state.dmPolicy === "allowlist" &&
    typeof state.primaryOperator === "string" &&
    SENDER_ID_RE.test(state.primaryOperator) &&
    hasUniqueSenderIds(state) &&
    state.allowFrom.includes(state.primaryOperator)
  );
}

function hasConsistentUnownedState(state: AllowedSenders): boolean {
  return (
    state.dmPolicy === "pairing" &&
    (state.primaryOperator === null || state.primaryOperator === undefined) &&
    state.allowFrom.length === 0
  );
}

class DesktopSenderMutationExit<T> extends Error {
  constructor(readonly result: T) {
    super(say("telegram.security.mutationNotWritten"));
  }
}

function exitDesktopMutation<T>(result: T): never {
  throw new DesktopSenderMutationExit(result);
}

function allowedSendersFileExists(dataDir: string, platform: NodeJS.Platform): boolean {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  if (platform !== "win32") return pathExistsOrIsUninspectable(path);
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw classifyWindowsPrivatePathFailure("read-check", error);
  }
}

export function claimPrimaryOperator(
  dataDir: string,
  senderId: string,
  options: AllowedSendersStorageOptions = {},
): ClaimPrimaryOperatorResult {
  assertSenderId(senderId);
  const nowIso = new Date().toISOString();
  let result: ClaimPrimaryOperatorResult | undefined;

  try {
    saveAllowedSenders(
      dataDir,
      (current) => {
        if (!current && allowedSendersFileExists(dataDir, options.platform ?? process.platform)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }

        const base = current ?? defaultPairingState();
        if (hasValidPrimary(base)) {
          if (base.primaryOperator !== senderId) {
            return exitDesktopMutation({ status: "refused", reason: "primary-exists" });
          }
          return exitDesktopMutation({
            status: "already-primary",
            sender: desktopSender(base, senderId),
          });
        }
        if (!hasConsistentUnownedState(base)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }

        const next: AllowedSenders = {
          ...base,
          dmPolicy: "allowlist",
          allowFrom: [senderId],
          primaryOperator: senderId,
          capturedAt: nowIso,
          addedAt: { ...base.addedAt, [senderId]: nowIso },
        };
        result = { status: "claimed", sender: desktopSender(next, senderId) };
        return next;
      },
      options,
    );
  } catch (err) {
    if (err instanceof DesktopSenderMutationExit) {
      return err.result as ClaimPrimaryOperatorResult;
    }
    if (err instanceof AllowedSendersRecoveryRequiredError) {
      return { status: "refused", reason: "inconsistent-state" };
    }
    if (err instanceof AllowedSendersCommitUncertainError) {
      return { status: "uncertain" };
    }
    throw err;
  }

  return result as ClaimPrimaryOperatorResult;
}

export function addSecondarySender(
  dataDir: string,
  senderId: string,
  options: AllowedSendersStorageOptions = {},
): AddSecondarySenderResult {
  assertSenderId(senderId);
  const nowIso = new Date().toISOString();
  let result: AddSecondarySenderResult | undefined;

  try {
    saveAllowedSenders(
      dataDir,
      (current) => {
        if (!current && allowedSendersFileExists(dataDir, options.platform ?? process.platform)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }

        const base = current ?? defaultPairingState();
        if (hasConsistentUnownedState(base)) {
          return exitDesktopMutation({ status: "refused", reason: "primary-required" });
        }
        if (!hasValidPrimary(base)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }
        if (base.allowFrom.includes(senderId)) {
          return exitDesktopMutation({
            status: "already-allowed",
            sender: desktopSender(base, senderId),
          });
        }

        const next: AllowedSenders = {
          ...base,
          allowFrom: [...base.allowFrom, senderId],
          addedAt: { ...base.addedAt, [senderId]: nowIso },
        };
        result = { status: "added", sender: desktopSender(next, senderId) };
        return next;
      },
      options,
    );
  } catch (err) {
    if (err instanceof DesktopSenderMutationExit) {
      return err.result as AddSecondarySenderResult;
    }
    if (err instanceof AllowedSendersRecoveryRequiredError) {
      return { status: "refused", reason: "inconsistent-state" };
    }
    if (err instanceof AllowedSendersCommitUncertainError) {
      return { status: "uncertain" };
    }
    throw err;
  }

  return result as AddSecondarySenderResult;
}

export function removeSecondarySender(
  dataDir: string,
  senderId: string,
  options: AllowedSendersStorageOptions = {},
): RemoveSecondarySenderResult {
  assertSenderId(senderId);
  let result: RemoveSecondarySenderResult | undefined;

  try {
    mutateAllowedSenders(
      dataDir,
      (current) => {
        if (!current && allowedSendersFileExists(dataDir, options.platform ?? process.platform)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }

        const base = current ?? defaultPairingState();
        if (hasConsistentUnownedState(base)) {
          return exitDesktopMutation({ status: "not-found" });
        }
        if (!hasValidPrimary(base)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }
        if (base.primaryOperator === senderId) {
          return exitDesktopMutation({ status: "refused", reason: "primary-removal" });
        }
        if (!base.allowFrom.includes(senderId)) {
          return exitDesktopMutation({ status: "not-found" });
        }

        const { [senderId]: _removed, ...addedAt } = base.addedAt ?? {};
        result = { status: "removed" };
        return {
          ...base,
          allowFrom: base.allowFrom.filter((id) => id !== senderId),
          addedAt,
        };
      },
      true,
      options,
    );
  } catch (err) {
    if (err instanceof DesktopSenderMutationExit) {
      return err.result as RemoveSecondarySenderResult;
    }
    if (err instanceof AllowedSendersCommitUncertainError) {
      return { status: "uncertain" };
    }
    throw err;
  }

  return result as RemoveSecondarySenderResult;
}

export function listDesktopAllowedSenders(
  dataDir: string,
  options: AllowedSendersStorageOptions = {},
): DesktopAllowedSender[] {
  const state = loadAllowedSendersFromFile(dataDir, options);
  return state.allowFrom.map((senderId) => desktopSender(state, senderId));
}

export function addSender(
  dataDir: string,
  senderId: string,
  options: AllowedSendersStorageOptions = {},
): void {
  assertSenderId(senderId);
  const nowIso = new Date().toISOString();
  saveAllowedSenders(
    dataDir,
    (current) => {
      const base = current ?? defaultPairingState();
      if (base.allowFrom.includes(senderId)) {
        // Idempotent — keep dmPolicy "allowlist" if it isn't already.
        if (base.dmPolicy === "pairing") {
          return { ...base, dmPolicy: "allowlist" };
        }
        return base;
      }
      return {
        ...base,
        dmPolicy: "allowlist",
        allowFrom: [...base.allowFrom, senderId],
        addedAt: { ...base.addedAt, [senderId]: nowIso },
        primaryOperator: base.primaryOperator ?? senderId,
      };
    },
    options,
  );
}

interface SessionCandidate {
  chatId: string;
  lineCount: number;
  mtime: number;
  lastModified: string;
}

async function countLines(path: string): Promise<number> {
  let n = 0;
  let lastByte = -1;
  try {
    for await (const buf of createReadStream(path) as AsyncIterable<Buffer>) {
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) n++;
        lastByte = buf[i];
      }
    }
  } catch {
    return 0;
  }
  // Trailing content without a final newline still counts as one line.
  if (lastByte !== -1 && lastByte !== 0x0a) n++;
  return n;
}

export async function readKnownSessions(dataDir: string): Promise<SessionCandidate[]> {
  const sessions = enumerateTelegramSessions(dataDir);
  return Promise.all(
    sessions.map(async (s) => ({
      chatId: s.chatId,
      lineCount: await countLines(s.path),
      mtime: s.mtimeMs,
      lastModified: new Date(s.mtimeMs).toISOString(),
    })),
  );
}

export async function listSenders(
  dataDir: string,
  options: AllowedSendersStorageOptions = {},
): Promise<{
  senders: AllowedSenders;
  sessionCandidates: SessionCandidate[];
}> {
  return {
    senders: loadAllowedSenders(dataDir, options),
    sessionCandidates: await readKnownSessions(dataDir),
  };
}

export function removeSender(
  dataDir: string,
  senderId: string,
  options: AllowedSendersStorageOptions = {},
): void {
  mutateAllowedSenders(
    dataDir,
    (current) => {
      if (!current) return defaultPairingState();
      if (!current.allowFrom.includes(senderId)) return current;
      const filtered = current.allowFrom.filter((id) => id !== senderId);
      const { [senderId]: _dropped, ...remainingAddedAt } = current.addedAt;
      return {
        ...current,
        allowFrom: filtered,
        addedAt: remainingAddedAt,
        dmPolicy: filtered.length === 0 ? "pairing" : current.dmPolicy,
        primaryOperator: current.primaryOperator === senderId ? null : current.primaryOperator,
      };
    },
    true,
    options,
  );
}
