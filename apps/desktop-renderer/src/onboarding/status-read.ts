import type { OnboardingBridge } from "./bridge";
import { settleWithin } from "./timing";

export const ONBOARDING_STATUS_REFRESH_TIMEOUT_MS = 3_000;
export const ONBOARDING_STATUS_COLD_START_TIMEOUT_MS = 8_000;
export const ONBOARDING_STATUS_LOAD_ATTEMPTS = 4;
export const ONBOARDING_STATUS_RETRY_BASE_DELAY_MS = 500;
export const ONBOARDING_STATUS_RETRY_MAX_DELAY_MS = 2_000;
export function onboardingStatusRetryDelayMs(attempt: number): number {
  const delay = ONBOARDING_STATUS_RETRY_BASE_DELAY_MS * 2 ** attempt;
  return delay > ONBOARDING_STATUS_RETRY_MAX_DELAY_MS
    ? ONBOARDING_STATUS_RETRY_MAX_DELAY_MS
    : delay;
}

function readOnce(bridge: OnboardingBridge, timeoutMs: number) {
  return Promise.all([
    settleWithin(bridge.credentialStatuses(), timeoutMs),
    settleWithin(bridge.chatGptStatus(), timeoutMs),
    settleWithin(bridge.llmConfiguration(), timeoutMs),
    settleWithin(
      bridge.getSetupStatus?.() ??
        Promise.resolve({
          schemaVersion: 1 as const,
          durableTrainingData: false,
        }),
      timeoutMs,
    ),
  ]);
}

export async function readSetupStatus(
  bridge: OnboardingBridge,
  coldStart: boolean,
  stillCurrent: () => boolean,
): ReturnType<typeof readOnce> {
  const timeoutMs = coldStart
    ? ONBOARDING_STATUS_COLD_START_TIMEOUT_MS
    : ONBOARDING_STATUS_REFRESH_TIMEOUT_MS;
  const attempts = coldStart ? ONBOARDING_STATUS_LOAD_ATTEMPTS : 1;
  let read = await readOnce(bridge, timeoutMs);
  for (
    let attempt = 0;
    read.some((entry) => entry.status !== "fulfilled") && attempt + 1 < attempts && stillCurrent();
    attempt += 1
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, onboardingStatusRetryDelayMs(attempt));
    });
    if (!stillCurrent()) break;
    read = await readOnce(bridge, timeoutMs);
  }
  return read;
}
