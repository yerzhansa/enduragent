import type { DesktopCredentialId } from "../onboarding/bridge";

export type CredentialRepair =
  | DesktopCredentialId
  | { readonly retrying: DesktopCredentialId; readonly failedResends: number };

const FAILED_RESENDS_BEFORE_ASKING = 2;

export const RECONNECTING_ANNOUNCEMENT =
  "The credential was not deleted. Reconnecting to the coach…";

export function repairCredentialId(repair: CredentialRepair | null): DesktopCredentialId | null {
  return repair === null || typeof repair === "string" ? repair : repair.retrying;
}

export function repairNeedsAthlete(repair: CredentialRepair | null): DesktopCredentialId | null {
  return typeof repair === "string" ? repair : null;
}

export function repairRetrying(repair: CredentialRepair | null): boolean {
  return repair !== null && typeof repair !== "string";
}

export function retryingRepair(credential: DesktopCredentialId): CredentialRepair {
  return { retrying: credential, failedResends: 0 };
}

export function afterFailedResend(repair: CredentialRepair): CredentialRepair {
  if (typeof repair === "string") return repair;
  const failedResends = repair.failedResends + 1;
  return failedResends < FAILED_RESENDS_BEFORE_ASKING
    ? { ...repair, failedResends }
    : repair.retrying;
}

const FIRST_RETRY_DELAY_MS = 1_000;
export const LONGEST_RETRY_DELAY_MS = 15_000;

export function credentialRepairRetryDelayMs(attempt: number): number {
  if (attempt === 0) return 0;
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), LONGEST_RETRY_DELAY_MS);
}

export interface CredentialRepairRetry {
  schedule(): void;
  stop(): void;
}

type RetryState =
  | { readonly status: "idle" }
  | {
      readonly status: "following";
      readonly attempt: number;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
      readonly unfollow: () => void;
    };

export function createCredentialRepairRetry(input: {
  readonly run: () => void;
  readonly onConnectionOpen: (listener: () => void) => () => void;
}): CredentialRepairRetry {
  let state: RetryState = { status: "idle" };
  const runNow = (): void => {
    if (state.status !== "following") return;
    clearTimeout(state.timer);
    state = { ...state, timer: undefined };
    input.run();
  };
  return {
    schedule() {
      if (state.status === "following" && state.timer !== undefined) return;
      const following =
        state.status === "following"
          ? state
          : { attempt: 0, unfollow: input.onConnectionOpen(runNow) };
      state = {
        status: "following",
        attempt: following.attempt + 1,
        unfollow: following.unfollow,
        timer: setTimeout(runNow, credentialRepairRetryDelayMs(following.attempt)),
      };
    },
    stop() {
      if (state.status !== "following") return;
      clearTimeout(state.timer);
      state.unfollow();
      state = { status: "idle" };
    },
  };
}
