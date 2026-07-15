import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { refreshCodexToken } from "../agent/codex/oauth.js";

import { CONFIG_DIR } from "../config.js";

// ============================================================================
// TYPES
// ============================================================================

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}

export class RefreshTokenReusedError extends Error {
  constructor(public readonly profile: string, cause: unknown) {
    super(
      `OAuth token for "${profile}" could not be refreshed — if this persists after checking your connection, re-run \`npm run setup\` or \`cycling-coach setup\` to reauthenticate.`,
    );
    this.name = "RefreshTokenReusedError";
    this.cause = cause;
  }
}

// ============================================================================
// STORAGE
// ============================================================================

const PROFILES_FILE = join(CONFIG_DIR, "auth-profiles.json");
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

type ProfilesFile = Record<string, OAuthCredential>;

function readAll(): ProfilesFile {
  if (!existsSync(PROFILES_FILE)) return {};
  try {
    const raw = readFileSync(PROFILES_FILE, "utf-8");
    return JSON.parse(raw) as ProfilesFile;
  } catch {
    return {};
  }
}

function writeAll(profiles: ProfilesFile): void {
  const tempPath = `${PROFILES_FILE}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tempPath, JSON.stringify(profiles, null, 2), { mode: 0o600 });
    // writeFileSync's mode is masked by the process umask; chmod guarantees 0o600.
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, PROFILES_FILE);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Temp may not exist if the initial write failed.
    }
    throw err;
  }
}

export function loadProfile(name: string): OAuthCredential | null {
  const all = readAll();
  return all[name] ?? null;
}

export function saveProfile(name: string, cred: OAuthCredential): void {
  const all = readAll();
  all[name] = cred;
  writeAll(all);
}

function isExpiredOrUnusable(cred: OAuthCredential): boolean {
  if (!Number.isFinite(cred.expires)) return true;
  return Date.now() > cred.expires - REFRESH_THRESHOLD_MS;
}

// ============================================================================
// REFRESH
// ============================================================================

const REFRESH_RETRY_DELAY_MS = 2_000;

function isRefreshDenied(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /refresh.*reuse|invalid.*refresh|Failed to refresh/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshWithRetry(name: string, cred: OAuthCredential, signal?: AbortSignal) {
  try {
    return await refreshCodexToken(cred.refresh, signal);
  } catch (err) {
    // A caller-deadline abort is not a denied refresh -- skip the 2s retry/deny path
    // and propagate it so the surfaced error is not a misleading "re-run setup".
    if (signal?.aborted) throw err;
    if (!isRefreshDenied(err)) throw err;
    // Another process may have refreshed the credential after this attempt
    // started, so reread disk and retry once before declaring it denied.
    await delay(REFRESH_RETRY_DELAY_MS);
    const onDisk = loadProfile(name) ?? cred;
    try {
      return await refreshCodexToken(onDisk.refresh, signal);
    } catch (retryErr) {
      if (isRefreshDenied(retryErr)) {
        throw new RefreshTokenReusedError(name, retryErr);
      }
      throw retryErr;
    }
  }
}

const refreshQueues = new Map<string, Promise<unknown>>();

export async function getFreshToken(name: string, signal?: AbortSignal): Promise<string> {
  const prev = refreshQueues.get(name) ?? Promise.resolve();
  const run = prev.then(
    () => getFreshTokenExclusive(name, signal),
    () => getFreshTokenExclusive(name, signal),
  );
  refreshQueues.set(name, run);
  try {
    return await run;
  } finally {
    if (refreshQueues.get(name) === run) {
      refreshQueues.delete(name);
    }
  }
}

async function getFreshTokenExclusive(name: string, signal?: AbortSignal): Promise<string> {
  const cred = loadProfile(name);
  if (!cred) {
    throw new Error(`No OAuth profile "${name}". Run \`cycling-coach setup\` to create one.`);
  }

  if (!isExpiredOrUnusable(cred)) {
    return cred.access;
  }

  if (name !== "openai-codex") {
    throw new Error(`Refresh not implemented for profile "${name}"`);
  }

  const refreshed = await refreshWithRetry(name, cred, signal);

  const next: OAuthCredential = {
    type: "oauth",
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    accountId: typeof refreshed.accountId === "string" ? refreshed.accountId : cred.accountId,
    email: cred.email,
  };
  saveProfile(name, next);
  return next.access;
}
