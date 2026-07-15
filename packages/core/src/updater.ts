import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateTelegramSessions } from "./channels/telegram-sessions.js";

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export const MANAGED_DEPLOY_UPDATE_NOTICE =
  "This deployment updates through its container image. If Railway image auto-updates are enabled, Railway redeploys the latest GHCR image during the configured maintenance window; otherwise redeploy the service from the latest image in Railway.";

export function isManagedDeploy(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.CYCLING_COACH_MANAGED_DEPLOY?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Parse a CalVer string `YYYY.M.D` (with optional same-day re-release suffix
 * `-N`) into a comparable 4-tuple. Returns null for unparseable input —
 * "unknown" (the getCurrentVersion fallback) or a malformed npm response.
 *
 * Note: this is NOT semver. The project's binaries use CalVer where `-N`
 * means "newer same-day re-release", whereas semver treats `-N` as an older
 * pre-release. Using `semver.gt` here would silently miss every same-day
 * patch notification.
 */
function calverParts(v: string): [number, number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 0];
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
 * Read the binary's package.json from the bundle-adjacent package first, then
 * installed resolution, then a matching development cwd. Memoized for normal
 * production calls because `/update` restarts the process after installation.
 */
const pkgCache = new Map<string, Record<string, unknown> | null>();
export function readBinaryPackageJson(
  binaryName: string,
  lookup: { moduleUrl?: string; cwd?: string } = {},
): Record<string, unknown> | null {
  const cacheable = lookup.moduleUrl === undefined && lookup.cwd === undefined;
  if (cacheable && pkgCache.has(binaryName)) return pkgCache.get(binaryName) ?? null;

  const tryRead = (path: string): Record<string, unknown> | null => {
    try {
      const candidate = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      return candidate.name === binaryName &&
        typeof candidate.version === "string" &&
        candidate.version.trim().length > 0
        ? candidate
        : null;
    } catch {
      return null;
    }
  };

  const moduleUrl = lookup.moduleUrl ?? import.meta.url;
  let pkg = tryRead(fileURLToPath(new URL("../package.json", moduleUrl)));
  try {
    const requireFn = createRequire(moduleUrl);
    if (!pkg) pkg = tryRead(requireFn.resolve(`${binaryName}/package.json`));
  } catch {
    // resolve() threw (binary not installed via npm) — fall through
  }
  if (!pkg) pkg = tryRead(join(lookup.cwd ?? process.cwd(), "package.json"));

  if (cacheable) pkgCache.set(binaryName, pkg);
  return pkg;
}

export function getCurrentVersion(binaryName: string): string {
  const pkg = readBinaryPackageJson(binaryName);
  return (pkg?.version as string | undefined) ?? "unknown";
}

const NPM_REGISTRY = "https://registry.npmjs.org";
const PING_ENDPOINT = "https://ping.enduragent.icu/v1/check";
const INSTANCE_ID_FILE = "instance-id";

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

export function buildCheckUrl(binaryName: string, dataDir?: string): string {
  if (isDevOrTest()) return `${NPM_REGISTRY}/${binaryName}/latest`;
  const params = new URLSearchParams({
    bin: binaryName,
    version: getCurrentVersion(binaryName),
    channel: isManagedDeploy() ? "docker" : "npm",
  });
  if (dataDir) params.set("instance", getInstanceId(dataDir));
  return `${PING_ENDPOINT}?${params}`;
}

export async function checkForUpdate(
  binaryName: string,
  dataDir?: string,
): Promise<UpdateInfo | null> {
  const current = getCurrentVersion(binaryName);
  const parse = async (res: Response): Promise<UpdateInfo | null> => {
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return {
      current,
      latest: data.version,
      updateAvailable: isUpdateAvailable(data.version, current),
    };
  };
  try {
    const res = await fetch(buildCheckUrl(binaryName, dataDir), {
      signal: AbortSignal.timeout(5000),
    });
    const info = await parse(res);
    if (info) return info;
  } catch {
    // fall through to npm fallback
  }
  // In dev/test the primary request WAS npm — don't retry the same host.
  if (isDevOrTest()) return null;
  try {
    const res = await fetch(`${NPM_REGISTRY}/${binaryName}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    return await parse(res);
  } catch {
    return null;
  }
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
  console.log(`Installing ${binaryName}@${updateTarget(version)}...`);
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
