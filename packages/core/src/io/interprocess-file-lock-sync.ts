import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const OWNER_MARKER_PATTERN = /^owner-[a-f0-9]{64}\.json$/u;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface LockClaim {
  readonly version: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly createdAt: string;
}

interface ObservedMarker {
  readonly directoryIdentity: FileIdentity;
  readonly markerIdentity: FileIdentity;
  readonly markerName: string;
  readonly claim: LockClaim;
}

interface ObservedDirectory {
  readonly identity: FileIdentity;
  readonly markers: readonly ObservedMarker[];
}

export interface InterprocessFileLockOptions {
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly timestamp?: () => string;
  readonly nonce?: () => string;
  readonly pid?: number;
  readonly pidStatus?: (pid: number) => "live" | "dead";
  readonly sleepSync?: (milliseconds: number) => void;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly afterClaimPublished?: (lockPath: string) => void;
  readonly afterDeadClaimVerified?: (lockPath: string, markerPath: string) => void;
  readonly afterReleaseMarkerRemoved?: (lockPath: string) => void;
  readonly platform?: NodeJS.Platform;
}

export class InterprocessFileLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InterprocessFileLockError";
  }
}

export class InterprocessFileLockTimeoutError extends InterprocessFileLockError {
  constructor() {
    super("Timed out waiting for the profile writer lock.");
    this.name = "InterprocessFileLockTimeoutError";
  }
}

export class InterprocessFileLockClaimError extends InterprocessFileLockError {
  constructor(options?: ErrorOptions) {
    super("The profile writer lock claim is unreadable or malformed.", options);
    this.name = "InterprocessFileLockClaimError";
  }
}

export class InterprocessFileLockOwnershipError extends InterprocessFileLockError {
  constructor() {
    super("The profile writer lock changed while it was being acquired.");
    this.name = "InterprocessFileLockOwnershipError";
  }
}

interface ResolvedOptions {
  readonly timeoutMs: number;
  readonly retryDelayMs: number;
  readonly now: () => number;
  readonly timestamp: () => string;
  readonly nonce: () => string;
  readonly pid: number;
  readonly pidStatus: (pid: number) => "live" | "dead";
  readonly sleepSync: (milliseconds: number) => void;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly afterClaimPublished?: (lockPath: string) => void;
  readonly afterDeadClaimVerified?: (lockPath: string, markerPath: string) => void;
  readonly afterReleaseMarkerRemoved?: (lockPath: string) => void;
  readonly platform: NodeJS.Platform;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function defaultPidStatus(pid: number): "live" | "dead" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "dead" : "live";
  }
}

function resolveOptions(options: InterprocessFileLockOptions): ResolvedOptions {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    now: options.now ?? Date.now,
    timestamp: options.timestamp ?? (() => new Date().toISOString()),
    nonce: options.nonce ?? (() => randomBytes(16).toString("hex")),
    pid: options.pid ?? process.pid,
    pidStatus: options.pidStatus ?? defaultPidStatus,
    sleepSync:
      options.sleepSync ??
      ((milliseconds) => {
        Atomics.wait(waitBuffer, 0, 0, milliseconds);
      }),
    delay:
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    afterClaimPublished: options.afterClaimPublished,
    afterDeadClaimVerified: options.afterDeadClaimVerified,
    afterReleaseMarkerRemoved: options.afterReleaseMarkerRemoved,
    platform: options.platform ?? process.platform,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(path: string): FileIdentity | null {
  try {
    const metadata = lstatSync(path);
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new InterprocessFileLockClaimError({ cause: error });
  }
}

function parseClaim(raw: string): LockClaim | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("version" in parsed) || parsed.version !== 1) return null;
  if (!("pid" in parsed) || !Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return null;
  if (!("nonce" in parsed) || typeof parsed.nonce !== "string" || parsed.nonce.length === 0) {
    return null;
  }
  if (
    !("createdAt" in parsed) ||
    typeof parsed.createdAt !== "string" ||
    parsed.createdAt.length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    pid: Number(parsed.pid),
    nonce: parsed.nonce,
    createdAt: parsed.createdAt,
  };
}

function readUtf8File(path: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

function markerNameFor(nonce: string): string {
  return `owner-${createHash("sha256").update(nonce).digest("hex")}.json`;
}

function observeMarker(
  lockPath: string,
  directoryIdentity: FileIdentity,
  markerName: string,
  platform: NodeJS.Platform,
): ObservedMarker | null {
  if (!OWNER_MARKER_PATTERN.test(markerName)) throw new InterprocessFileLockClaimError();
  const markerPath = join(lockPath, markerName);
  const before = identity(markerPath);
  if (before === null) return null;
  let raw: string;
  try {
    const metadata = lstatSync(markerPath);
    if (!metadata.isFile() || (platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
      throw new InterprocessFileLockClaimError();
    }
    raw = readUtf8File(markerPath);
  } catch (error) {
    if (error instanceof InterprocessFileLockClaimError) throw error;
    if (errorCode(error) === "ENOENT") return null;
    throw new InterprocessFileLockClaimError({ cause: error });
  }
  const after = identity(markerPath);
  const currentDirectory = identity(lockPath);
  if (
    after === null ||
    currentDirectory === null ||
    !sameIdentity(before, after) ||
    !sameIdentity(directoryIdentity, currentDirectory)
  ) {
    return null;
  }
  const claim = parseClaim(raw);
  if (claim === null || markerNameFor(claim.nonce) !== markerName) {
    throw new InterprocessFileLockClaimError();
  }
  return { directoryIdentity, markerIdentity: before, markerName, claim };
}

function observeDirectory(lockPath: string, platform: NodeJS.Platform): ObservedDirectory | null {
  const before = identity(lockPath);
  if (before === null) return null;
  let entries: string[];
  try {
    const metadata = lstatSync(lockPath);
    if (!metadata.isDirectory() || (platform !== "win32" && (metadata.mode & 0o777) !== 0o700)) {
      throw new InterprocessFileLockClaimError();
    }
    entries = readdirSync(lockPath);
  } catch (error) {
    if (error instanceof InterprocessFileLockClaimError) throw error;
    if (errorCode(error) === "ENOENT") return null;
    throw new InterprocessFileLockClaimError({ cause: error });
  }
  const after = identity(lockPath);
  if (after === null || !sameIdentity(before, after)) return null;
  const markers: ObservedMarker[] = [];
  for (const entry of entries) {
    const marker = observeMarker(lockPath, before, entry, platform);
    if (marker === null) return null;
    markers.push(marker);
  }
  const finalIdentity = identity(lockPath);
  if (finalIdentity === null || !sameIdentity(before, finalIdentity)) return null;
  return { identity: before, markers };
}

function writeCompleteClaimTemp(lockPath: string, claim: LockClaim): string {
  const tempPath = `${lockPath}.tmp.${claim.pid}.${markerNameFor(claim.nonce)}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(claim)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    return tempPath;
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        if (!(typeof closeError === "object" && closeError !== null && "code" in closeError && (String(closeError.code) === "EBADF" || String(closeError.code) === "ERR_DIR_CLOSED"))) throw closeError;
      }
    }
    rmSync(tempPath, { force: true });
    throw new InterprocessFileLockError("Unable to prepare the profile writer lock claim.", {
      cause: error,
    });
  }
}

function createLockDirectory(lockPath: string, platform: NodeJS.Platform): FileIdentity | null {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") return null;
    throw new InterprocessFileLockError("Unable to create the profile writer lock directory.", {
      cause: error,
    });
  }
  const beforePermissions = identity(lockPath);
  if (beforePermissions === null) return null;
  if (platform !== "win32") {
    try {
      chmodSync(lockPath, 0o700);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw new InterprocessFileLockError("Unable to secure the profile writer lock directory.", {
        cause: error,
      });
    }
  }
  const afterPermissions = identity(lockPath);
  if (afterPermissions === null || !sameIdentity(beforePermissions, afterPermissions)) return null;
  return beforePermissions;
}

function publishMarker(
  lockPath: string,
  directoryIdentity: FileIdentity,
  claim: LockClaim,
): FileIdentity | null {
  const tempPath = writeCompleteClaimTemp(lockPath, claim);
  const markerPath = join(lockPath, markerNameFor(claim.nonce));
  const tempIdentity = identity(tempPath);
  if (tempIdentity === null) {
    throw new InterprocessFileLockError("The prepared profile writer lock claim disappeared.");
  }
  try {
    renameSync(tempPath, markerPath);
    return tempIdentity;
  } catch (error) {
    const currentDirectory = identity(lockPath);
    if (
      errorCode(error) === "ENOENT" ||
      currentDirectory === null ||
      !sameIdentity(currentDirectory, directoryIdentity)
    ) {
      return null;
    }
    throw new InterprocessFileLockError("Unable to publish the profile writer lock claim.", {
      cause: error,
    });
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function stillOwnedMarker(
  lockPath: string,
  expected: ObservedMarker,
  platform: NodeJS.Platform,
): boolean {
  const currentDirectory = identity(lockPath);
  if (currentDirectory === null || !sameIdentity(currentDirectory, expected.directoryIdentity)) {
    return false;
  }
  const current = observeMarker(
    lockPath,
    expected.directoryIdentity,
    expected.markerName,
    platform,
  );
  return (
    current !== null &&
    sameIdentity(current.markerIdentity, expected.markerIdentity) &&
    current.claim.nonce === expected.claim.nonce
  );
}

function stillExactMarker(
  lockPath: string,
  expected: ObservedMarker,
  platform: NodeJS.Platform,
): boolean {
  const markerPath = join(lockPath, expected.markerName);
  const before = identity(markerPath);
  if (before === null || !sameIdentity(before, expected.markerIdentity)) return false;
  let raw: string;
  try {
    const metadata = lstatSync(markerPath);
    if (!metadata.isFile() || (platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
      return false;
    }
    raw = readUtf8File(markerPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new InterprocessFileLockClaimError({ cause: error });
  }
  const after = identity(markerPath);
  const claim = parseClaim(raw);
  return (
    after !== null &&
    sameIdentity(before, after) &&
    claim !== null &&
    markerNameFor(claim.nonce) === expected.markerName &&
    claim.nonce === expected.claim.nonce
  );
}

function unlinkOwnedMarker(
  lockPath: string,
  expected: ObservedMarker,
  platform: NodeJS.Platform,
): boolean {
  if (!stillExactMarker(lockPath, expected, platform)) return false;
  try {
    unlinkSync(join(lockPath, expected.markerName));
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new InterprocessFileLockError("Unable to release the profile writer lock.", {
      cause: error,
    });
  }
}

function removeEmptyLockDirectory(lockPath: string): boolean {
  try {
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw new InterprocessFileLockError("Unable to remove the profile writer lock directory.", {
      cause: error,
    });
  }
}

function removeMarkerAndDirectory(
  lockPath: string,
  expected: ObservedMarker,
  platform: NodeJS.Platform,
  afterMarkerRemoved?: (lockPath: string) => void,
): boolean {
  const removed = unlinkOwnedMarker(lockPath, expected, platform);
  if (removed) afterMarkerRemoved?.(lockPath);
  removeEmptyLockDirectory(lockPath);
  return removed;
}

interface OwnedLock {
  release(): void;
}

function tryAcquire(lockPath: string, options: ResolvedOptions): OwnedLock | null {
  const claim: LockClaim = {
    version: 1,
    pid: options.pid,
    nonce: options.nonce(),
    createdAt: options.timestamp(),
  };
  if (claim.nonce.length === 0) throw new InterprocessFileLockClaimError();
  const directoryIdentity = createLockDirectory(lockPath, options.platform);
  if (directoryIdentity === null) return null;
  const markerIdentity = publishMarker(lockPath, directoryIdentity, claim);
  if (markerIdentity === null) {
    removeEmptyLockDirectory(lockPath);
    return null;
  }
  const published: ObservedMarker = {
    directoryIdentity,
    markerIdentity,
    markerName: markerNameFor(claim.nonce),
    claim,
  };
  try {
    options.afterClaimPublished?.(lockPath);
    const currentDirectory = identity(lockPath);
    if (currentDirectory === null || !sameIdentity(currentDirectory, directoryIdentity)) {
      removeMarkerAndDirectory(lockPath, published, options.platform);
      return null;
    }
    if (identity(join(lockPath, published.markerName)) === null) {
      removeEmptyLockDirectory(lockPath);
      return null;
    }
    if (!stillOwnedMarker(lockPath, published, options.platform)) {
      removeMarkerAndDirectory(lockPath, published, options.platform);
      throw new InterprocessFileLockOwnershipError();
    }
    const observed = observeDirectory(lockPath, options.platform);
    if (observed === null || !sameIdentity(observed.identity, directoryIdentity)) {
      removeMarkerAndDirectory(lockPath, published, options.platform);
      return null;
    }
    const [onlyMarker] = observed.markers;
    if (
      observed.markers.length !== 1 ||
      onlyMarker === undefined ||
      onlyMarker.markerName !== published.markerName ||
      !sameIdentity(onlyMarker.markerIdentity, published.markerIdentity) ||
      onlyMarker.claim.nonce !== published.claim.nonce
    ) {
      removeMarkerAndDirectory(lockPath, published, options.platform);
      return null;
    }
    return {
      release() {
        removeMarkerAndDirectory(
          lockPath,
          published,
          options.platform,
          options.afterReleaseMarkerRemoved,
        );
      },
    };
  } catch (error) {
    removeMarkerAndDirectory(lockPath, published, options.platform);
    throw error;
  }
}

function reclaimDeadMarker(
  lockPath: string,
  observed: ObservedMarker,
  options: ResolvedOptions,
): boolean {
  if (!stillOwnedMarker(lockPath, observed, options.platform)) return false;
  options.afterDeadClaimVerified?.(lockPath, join(lockPath, observed.markerName));
  return removeMarkerAndDirectory(lockPath, observed, options.platform);
}

function contentionDelay(startedAt: number, options: ResolvedOptions): number {
  const remaining = options.timeoutMs - (options.now() - startedAt);
  if (remaining <= 0) throw new InterprocessFileLockTimeoutError();
  return Math.min(options.retryDelayMs, remaining);
}

function acquireSync(lockPath: string, options: ResolvedOptions): OwnedLock {
  const startedAt = options.now();
  for (;;) {
    const owned = tryAcquire(lockPath, options);
    if (owned !== null) return owned;
    const observed = observeDirectory(lockPath, options.platform);
    if (observed === null) continue;
    if (observed.markers.length === 0) {
      removeEmptyLockDirectory(lockPath);
      continue;
    }
    let reclaimed = false;
    for (const marker of observed.markers) {
      if (options.pidStatus(marker.claim.pid) === "dead") {
        reclaimed = reclaimDeadMarker(lockPath, marker, options) || reclaimed;
      }
    }
    if (reclaimed) continue;
    options.sleepSync(contentionDelay(startedAt, options));
  }
}

async function acquireAsync(lockPath: string, options: ResolvedOptions): Promise<OwnedLock> {
  const startedAt = options.now();
  for (;;) {
    const owned = tryAcquire(lockPath, options);
    if (owned !== null) return owned;
    const observed = observeDirectory(lockPath, options.platform);
    if (observed === null) continue;
    if (observed.markers.length === 0) {
      removeEmptyLockDirectory(lockPath);
      continue;
    }
    let reclaimed = false;
    for (const marker of observed.markers) {
      if (options.pidStatus(marker.claim.pid) === "dead") {
        reclaimed = reclaimDeadMarker(lockPath, marker, options) || reclaimed;
      }
    }
    if (reclaimed) continue;
    await options.delay(contentionDelay(startedAt, options));
  }
}

export function withInterprocessFileLockSync<T>(
  lockPath: string,
  action: () => T,
  options: InterprocessFileLockOptions = {},
): T {
  const owned = acquireSync(lockPath, resolveOptions(options));
  try {
    return action();
  } finally {
    owned.release();
  }
}

export async function withInterprocessFileLock<T>(
  lockPath: string,
  action: () => T,
  options: InterprocessFileLockOptions = {},
): Promise<Awaited<T>> {
  const owned = await acquireAsync(lockPath, resolveOptions(options));
  try {
    return await action();
  } finally {
    owned.release();
  }
}

export async function acquireInterprocessFileLock(
  lockPath: string,
  options: InterprocessFileLockOptions = {},
): Promise<{ release(): void }> {
  return acquireAsync(lockPath, resolveOptions(options));
}
