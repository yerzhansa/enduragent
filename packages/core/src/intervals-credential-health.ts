import { createHash } from "node:crypto";
import { intervalsAuthorizationHeader, intervalsCredentialKind } from "./intervals-credential.js";

export const INTERVALS_CREDENTIAL_PROBE_URL = "https://intervals.icu/api/v1/athlete/0";
export const INTERVALS_CREDENTIAL_PROBE_COOLDOWN_MS = 10 * 60_000;
export const INTERVALS_CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;

const rejectedCredentials = new Set<string>();
const probesInFlight = new Map<string, Promise<void>>();
const probeCooldownUntil = new Map<string, number>();

type ProbeOutcome = "rejected" | "accepted" | "inconclusive";

function successful(status: number): boolean {
  return status >= 200 && status < 300;
}

function credentialKey(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

function markRejected(key: string): void {
  rejectedCredentials.add(key);
  probeCooldownUntil.delete(key);
}

function clearRejected(key: string): void {
  rejectedCredentials.delete(key);
}

export function recordIntervalsCredentialResponse(credential: string, status: number): void {
  if (intervalsCredentialKind(credential) !== "oauth") return;
  if (status === 401) {
    markRejected(credentialKey(credential));
  } else if (successful(status)) {
    clearRejected(credentialKey(credential));
  }
}

export function isIntervalsCredentialRejected(credential: string): boolean {
  if (intervalsCredentialKind(credential) !== "oauth") return false;
  return rejectedCredentials.has(credentialKey(credential));
}

async function probe(
  credential: string,
  baseFetch: typeof globalThis.fetch,
): Promise<ProbeOutcome> {
  let response: Response;
  try {
    response = await baseFetch(INTERVALS_CREDENTIAL_PROBE_URL, {
      method: "GET",
      headers: {
        authorization: intervalsAuthorizationHeader(credential),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(INTERVALS_CREDENTIAL_PROBE_TIMEOUT_MS),
    });
  } catch {
    return "inconclusive";
  }
  await Promise.allSettled([response.body?.cancel()]);
  if (response.status === 401 || response.status === 403) return "rejected";
  return successful(response.status) ? "accepted" : "inconclusive";
}

function applyProbe(key: string, outcome: ProbeOutcome): void {
  if (outcome === "rejected") {
    markRejected(key);
  } else if (outcome === "accepted") {
    clearRejected(key);
    probeCooldownUntil.set(key, Date.now() + INTERVALS_CREDENTIAL_PROBE_COOLDOWN_MS);
  }
}

function dropExpiredCooldowns(now: number): void {
  for (const [key, until] of probeCooldownUntil) {
    if (until <= now) probeCooldownUntil.delete(key);
  }
}

function confirmForbidden(credential: string, baseFetch: typeof globalThis.fetch): void {
  const key = credentialKey(credential);
  dropExpiredCooldowns(Date.now());
  if (rejectedCredentials.has(key) || probesInFlight.has(key) || probeCooldownUntil.has(key)) {
    return;
  }
  const started = probe(credential, baseFetch)
    .then((outcome) => applyProbe(key, outcome))
    .finally(() => {
      if (probesInFlight.get(key) === started) probesInFlight.delete(key);
    });
  probesInFlight.set(key, started);
  void Promise.allSettled([started]);
}

export function trackIntervalsCredentialHealth(
  credential: string,
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (intervalsCredentialKind(credential) !== "oauth") return baseFetch;
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status === 403) {
      confirmForbidden(credential, baseFetch);
    } else {
      recordIntervalsCredentialResponse(credential, response.status);
    }
    return response;
  };
}

export function resetIntervalsCredentialHealthForTests(): void {
  rejectedCredentials.clear();
  probesInFlight.clear();
  probeCooldownUntil.clear();
}
