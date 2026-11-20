import { intervalsAuthorizationHeader, intervalsCredentialKind } from "./intervals-credential.js";

export const INTERVALS_CREDENTIAL_PROBE_URL = "https://intervals.icu/api/v1/athlete/0";
export const INTERVALS_CREDENTIAL_PROBE_COOLDOWN_MS = 10 * 60_000;
export const INTERVALS_CREDENTIAL_PROBE_TIMEOUT_MS = 10_000;

const rejectedCredentials = new Set<string>();
const probesInFlight = new Map<string, Promise<void>>();
const probeCooldownUntil = new Map<string, number>();

function successful(status: number): boolean {
  return status >= 200 && status < 300;
}

export function recordIntervalsCredentialResponse(credential: string, status: number): void {
  if (intervalsCredentialKind(credential) !== "oauth") return;
  if (status === 401) {
    rejectedCredentials.add(credential);
  } else if (successful(status)) {
    rejectedCredentials.delete(credential);
  }
}

export function isIntervalsCredentialRejected(credential: string): boolean {
  return rejectedCredentials.has(credential);
}

type ProbeOutcome = "rejected" | "accepted" | "inconclusive";

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

function applyProbe(credential: string, outcome: ProbeOutcome): void {
  if (outcome === "rejected") {
    rejectedCredentials.add(credential);
  } else if (outcome === "accepted") {
    rejectedCredentials.delete(credential);
    probeCooldownUntil.set(credential, Date.now() + INTERVALS_CREDENTIAL_PROBE_COOLDOWN_MS);
  }
}

function confirmForbidden(credential: string, baseFetch: typeof globalThis.fetch): Promise<void> {
  if (rejectedCredentials.has(credential)) return Promise.resolve();
  const running = probesInFlight.get(credential);
  if (running !== undefined) return running;
  if ((probeCooldownUntil.get(credential) ?? 0) > Date.now()) return Promise.resolve();
  const started = probe(credential, baseFetch)
    .then((outcome) => applyProbe(credential, outcome))
    .finally(() => {
      if (probesInFlight.get(credential) === started) probesInFlight.delete(credential);
    });
  probesInFlight.set(credential, started);
  return started;
}

export function trackIntervalsCredentialHealth(
  credential: string,
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (intervalsCredentialKind(credential) !== "oauth") return baseFetch;
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status === 403) {
      await confirmForbidden(credential, baseFetch);
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
