import { join } from "node:path";
import {
  RefreshTokenReusedError,
  classifyFailure,
  compareAndSaveStoredProfile,
  loadStoredProfileSnapshot,
  markSignInRejected,
  refreshCodexToken,
  withoutSignInRejection,
  type StoredProfile,
  type StoredProfileSnapshot,
} from "@enduragent/core";
import type { EngineHostPorts } from "@enduragent/engine";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OAuthCredential extends StoredProfile {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
  readonly email?: string;
}

function isOAuthCredential(value: unknown): value is OAuthCredential {
  return (
    isRecord(value) &&
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.length > 0 &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires) &&
    (value.accountId === undefined || typeof value.accountId === "string") &&
    (value.email === undefined || typeof value.email === "string")
  );
}

export function credential(value: unknown): OAuthCredential {
  if (!isOAuthCredential(value)) throw new TypeError("OAuth profile is invalid.");
  return value;
}

export function createAccessTokenReader(configDir: string): EngineHostPorts["getAccessToken"] {
  const path = join(configDir, "auth-profiles.json");
  const queues = new Map<string, Promise<string>>();
  const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (signal === undefined) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(signal.reason);
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const refresh = async (
    profileName: string,
    initial: StoredProfileSnapshot,
    current: OAuthCredential,
    signal?: AbortSignal,
  ) => {
    try {
      return {
        refreshed: await refreshCodexToken(current.refresh, signal),
        requestSnapshot: initial,
        requestProfile: current,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (classifyFailure(error) !== "reauth") throw error;
      await delay(2_000, signal);
      const requestSnapshot = loadStoredProfileSnapshot(path, profileName);
      if (requestSnapshot === null) throw new TypeError("OAuth profile is invalid.");
      const requestProfile = credential(requestSnapshot.profile);
      try {
        return {
          refreshed: await refreshCodexToken(requestProfile.refresh, signal),
          requestSnapshot,
          requestProfile,
        };
      } catch (retryError) {
        signal?.throwIfAborted();
        if (classifyFailure(retryError) === "reauth") {
          await markSignInRejected(path, profileName, requestSnapshot);
          throw new RefreshTokenReusedError(profileName, retryError);
        }
        throw retryError;
      }
    }
  };
  const exclusive = async (
    profileName: string,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<string> => {
    const snapshot = loadStoredProfileSnapshot(path, profileName);
    if (snapshot === null) throw new TypeError("OAuth profile is invalid.");
    const current = credential(snapshot.profile);
    if (rejectedAccessToken === undefined || current.access !== rejectedAccessToken) {
      return current.access;
    }
    const { refreshed, requestSnapshot, requestProfile } = await refresh(
      profileName,
      snapshot,
      current,
      signal,
    );
    const next = {
      ...withoutSignInRejection(requestProfile),
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId ?? requestProfile.accountId,
      email: requestProfile.email,
    } satisfies OAuthCredential;
    const saved = await compareAndSaveStoredProfile(path, profileName, requestSnapshot, next);
    if (saved.status === "missing") throw new TypeError("OAuth profile is invalid.");
    return credential(saved.profile).access;
  };
  return async (profileName, signal, rejectedAccessToken) => {
    const previous = queues.get(profileName) ?? Promise.resolve("");
    const current = previous.then(
      () => exclusive(profileName, signal, rejectedAccessToken),
      () => exclusive(profileName, signal, rejectedAccessToken),
    );
    queues.set(profileName, current);
    try {
      return await current;
    } finally {
      if (queues.get(profileName) === current) queues.delete(profileName);
    }
  };
}
