import { msg } from "@enduragent/i18n";
import { say } from "./cli-copy.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { binaryEnvVar } from "./binary.js";
import { enumerateTelegramSessions } from "./channels/telegram-sessions.js";
import { atomicWriteFileSync } from "./io/atomic-write-file-sync.js";
import { withInterprocessFileLockSync } from "./io/interprocess-file-lock-sync.js";

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export const MANAGED_DEPLOY_UPDATE_NOTICE = msg("cli.update.managedDeployment", {
  railway: "Railway",
  registry: "GHCR",
});

export function isManagedDeploy(
  binaryName: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[binaryEnvVar(binaryName, "MANAGED_DEPLOY")]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

const MAX_CALVER_LENGTH = 32;
const STABLE_CALVER_PATTERN = /^([1-9]\d{3})\.([1-9]|1[0-2])\.(0|[1-9]\d*)$/;
const COMPATIBLE_CALVER_PATTERN = /^([1-9]\d{3})\.([1-9]|1[0-2])\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/;

export function isStableCalVer(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_CALVER_LENGTH) return false;
  const match = STABLE_CALVER_PATTERN.exec(value);
  if (match === null) return false;
  const patch = Number(match[3]);
  return Number.isSafeInteger(patch) && patch >= 0;
}

/**
 * Parse stable `YYYY.M.P` CalVer into a comparable tuple. The optional fourth
 * element exists only for compatibility with installed historical `-N`
 * releases, where a suffix was ordered after its unsuffixed base.
 */
function calverParts(v: string): [number, number, number, number] | null {
  if (v.length > MAX_CALVER_LENGTH) return null;
  const match = COMPATIBLE_CALVER_PATTERN.exec(v);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const patch = Number(match[3]);
  const suffix = match[4] === undefined ? 0 : Number(match[4]);
  if (![year, month, patch, suffix].every(Number.isSafeInteger)) return null;
  return [year, month, patch, suffix];
}

/**
 * True only when `latest` is strictly newer than `current` in CalVer order.
 *
 * String inequality (the original implementation) misfires when the running
 * bot is *ahead* of npm — e.g. a Railway deploy from `main` self-reports the
 * just-bumped 2026.5.4 while npm is still at 2026.5.1 from the prior
 * publish. `!==` says "different" → broadcast → users get a "downgrade as
 * upgrade" notification on every restart.
 */
export function isUpdateAvailable(latest: string, current: string): boolean {
  const l = calverParts(latest);
  const c = calverParts(current);
  if (!l || !c) return false;
  for (let i = 0; i < 4; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}

/**
 * Read the binary's package.json — installed path first (via Node's module
 * resolution), cwd fallback for dev. Memoized: package.json doesn't change
 * mid-process, and `/update` exits the process before installing a new
 * version, so the cache is naturally invalidated by restart.
 */
const pkgCache = new Map<string, Record<string, unknown> | null>();
export function readBinaryPackageJson(binaryName: string): Record<string, unknown> | null {
  if (pkgCache.has(binaryName)) return pkgCache.get(binaryName) ?? null;

  const tryRead = (path: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  let pkg: Record<string, unknown> | null = null;
  try {
    const requireFn = createRequire(import.meta.url);
    pkg = tryRead(requireFn.resolve(`${binaryName}/package.json`));
  } catch {
    // resolve() threw (binary not installed via npm) — fall through
  }
  if (!pkg) pkg = tryRead(join(process.cwd(), "package.json"));

  pkgCache.set(binaryName, pkg);
  return pkg;
}

export function getCurrentVersion(binaryName: string): string {
  const pkg = readBinaryPackageJson(binaryName);
  return (pkg?.version as string | undefined) ?? "unknown";
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const PING_ENDPOINT = "https://ping.enduragent.icu/v1/check";
const INSTANCE_ID_FILE = "instance-id";
const LAST_VERSION_PING_AT_FILE = "last-version-ping-at";
const VERSION_PING_LOCK = ".version-ping.lock";
const VERSION_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const VERSION_PING_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface CachedUpdateInfo {
  readonly cachedAt: number;
  readonly info: UpdateInfo;
}

interface ActiveUpdateCheck {
  readonly promise: Promise<UpdateInfo | null>;
}

const updateInfoCache = new Map<string, CachedUpdateInfo>();
const activeUpdateChecks = new Map<string, ActiveUpdateCheck>();

function isDevOrTest(): boolean {
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

/** Random anonymous ID, created once and persisted in the data dir. */
export function getInstanceId(dataDir: string): string {
  const path = join(dataDir, INSTANCE_ID_FILE);
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch {
    // fall through — create it
  }
  const id = randomUUID();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, id);
  } catch {
    // Non-critical — an unpersisted ID still identifies this process run
  }
  return id;
}

export function buildVersionPingUrl(binaryName: string, dataDir?: string): string {
  const params = new URLSearchParams({
    bin: binaryName,
    version: getCurrentVersion(binaryName),
    channel: isManagedDeploy(binaryName) ? "docker" : "npm",
  });
  if (dataDir) params.set("instance", getInstanceId(dataDir));
  return `${PING_ENDPOINT}?${params}`;
}

export function buildCheckUrl(binaryName: string, dataDir?: string): string {
  if (isDevOrTest()) return `${NPM_REGISTRY}/${binaryName}/latest`;
  return buildVersionPingUrl(binaryName, dataDir);
}

function getCachedUpdateInfo(binaryName: string): UpdateInfo | null {
  const cached = updateInfoCache.get(binaryName);
  if (cached === undefined) return null;
  const age = Date.now() - cached.cachedAt;
  if (age >= 0 && age < VERSION_CHECK_CACHE_TTL_MS) return cached.info;
  updateInfoCache.delete(binaryName);
  return null;
}

function rememberUpdateInfo(binaryName: string, info: UpdateInfo | null): UpdateInfo | null {
  if (info !== null) {
    updateInfoCache.set(binaryName, {
      cachedAt: Date.now(),
      info,
    });
  }
  return info;
}

async function fetchUpdateInfo(binaryName: string, url: string): Promise<UpdateInfo | null> {
  const current = getCurrentVersion(binaryName);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== "string") return null;
    return {
      current,
      latest: data.version,
      updateAvailable: isUpdateAvailable(data.version, current),
    };
  } catch {
    return null;
  }
}

function startActiveUpdateCheck(
  binaryName: string,
  task: () => Promise<UpdateInfo | null>,
): Promise<UpdateInfo | null> {
  let operation: ActiveUpdateCheck;
  const promise = Promise.resolve()
    .then(task)
    .then((info) => rememberUpdateInfo(binaryName, info))
    .finally(() => {
      if (activeUpdateChecks.get(binaryName) === operation) {
        activeUpdateChecks.delete(binaryName);
      }
    });
  operation = { promise };
  activeUpdateChecks.set(binaryName, operation);
  return promise;
}

function readLastPingAt(path: string): number | null {
  try {
    const timestamp = Date.parse(readFileSync(path, "utf-8").trim());
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch {
    return null;
  }
}

function claimDailyVersionPing(dataDir: string): boolean {
  try {
    mkdirSync(dataDir, { recursive: true });
    return withInterprocessFileLockSync(join(dataDir, VERSION_PING_LOCK), () => {
      const now = Date.now();
      const statePath = join(dataDir, LAST_VERSION_PING_AT_FILE);
      const lastPingAt = readLastPingAt(statePath);
      if (lastPingAt !== null && now - lastPingAt < VERSION_PING_INTERVAL_MS) return false;
      atomicWriteFileSync(statePath, `${new Date(now).toISOString()}\n`);
      return true;
    });
  } catch {
    return false;
  }
}

async function fetchTelemetryUpdate(
  binaryName: string,
  dataDir: string,
  priorResult?: UpdateInfo | null,
): Promise<UpdateInfo | null> {
  const pingResult = await fetchUpdateInfo(binaryName, buildVersionPingUrl(binaryName, dataDir));
  if (pingResult !== null) return pingResult;
  if (priorResult !== undefined) return priorResult;
  const cached = getCachedUpdateInfo(binaryName);
  if (cached !== null) return cached;
  return fetchUpdateInfo(binaryName, `${NPM_REGISTRY}/${binaryName}/latest`);
}

export function checkForUpdate(binaryName: string, _dataDir?: string): Promise<UpdateInfo | null> {
  const active = activeUpdateChecks.get(binaryName);
  if (active !== undefined) return active.promise;
  const cached = getCachedUpdateInfo(binaryName);
  if (cached !== null) return Promise.resolve(cached);
  return startActiveUpdateCheck(binaryName, () =>
    fetchUpdateInfo(binaryName, `${NPM_REGISTRY}/${binaryName}/latest`),
  );
}

export function checkForUpdateWithDailyTelemetry(
  binaryName: string,
  dataDir: string,
): Promise<UpdateInfo | null> {
  if (isDevOrTest() || !claimDailyVersionPing(dataDir)) return checkForUpdate(binaryName);
  const active = activeUpdateChecks.get(binaryName);
  if (active === undefined) {
    return startActiveUpdateCheck(binaryName, () => fetchTelemetryUpdate(binaryName, dataDir));
  }
  return startActiveUpdateCheck(binaryName, async () => {
    const priorResult = await active.promise;
    return fetchTelemetryUpdate(binaryName, dataDir, priorResult);
  });
}

export function __resetVersionCheckStateForTesting(): void {
  updateInfoCache.clear();
  activeUpdateChecks.clear();
}

/**
 * `version` originates from a registry response and is interpolated into a
 * shell command, so anything outside npm's version charset falls back to the
 * `latest` dist-tag instead of reaching the shell.
 */
function updateTarget(version?: string): string {
  return version && /^[0-9A-Za-z.-]+$/.test(version) ? version : "latest";
}

export function buildSelfUpdateCommand(binaryName: string, version?: string): string {
  return `npm install -g --ignore-scripts --registry=${NPM_REGISTRY} ${binaryName}@${updateTarget(version)}`;
}

export function selfUpdate(binaryName: string, version?: string): void {
  console.log(say("cli.update.installing", { package: `${binaryName}@${updateTarget(version)}` }));
  execSync(buildSelfUpdateCommand(binaryName, version), { stdio: "inherit" });
  process.exit(0);
}

export function getKnownTelegramChatIds(dataDir: string): string[] {
  return enumerateTelegramSessions(dataDir).map((s) => s.chatId);
}

const NOTIFIED_VERSION_FILE = "last-notified-version";

export function getLastNotifiedVersion(dataDir: string): string | null {
  try {
    return readFileSync(join(dataDir, NOTIFIED_VERSION_FILE), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function setLastNotifiedVersion(dataDir: string, version: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, NOTIFIED_VERSION_FILE), version);
  } catch {
    // Non-critical — don't crash the bot
  }
}
