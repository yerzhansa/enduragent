import {
  CredentialRuntimeRefusal,
  type CredentialVault,
  type DesktopCredentialSlot,
} from "./credential-vault.js";

export const INTERVALS_SIGN_IN_RETRY_DELAYS_MS: readonly number[] = [
  15_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
];
export const INTERVALS_SIGN_IN_OFFLINE_RECHECK_MS = 15_000;

type RetryState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "waiting";
      readonly attempt: number;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | { readonly kind: "retrying"; readonly attempt: number }
  | { readonly kind: "closed" };

export interface IntervalsSignInRetry {
  observe<T>(slot: DesktopCredentialSlot, reapply: () => Promise<T>): Promise<T>;
}

interface PowerMonitorLike {
  on(event: "resume", listener: () => void): unknown;
  off(event: "resume", listener: () => void): unknown;
}

export function createIntervalsSignInRetry(
  input: {
    readonly vault: Pick<CredentialVault, "retryFailed">;
    readonly net: { isOnline(): boolean };
    readonly powerMonitor: PowerMonitorLike;
    readonly delaysMs?: readonly number[];
    readonly offlineRecheckMs?: number;
  },
  signal: AbortSignal,
): IntervalsSignInRetry {
  const delays = input.delaysMs ?? INTERVALS_SIGN_IN_RETRY_DELAYS_MS;
  const offlineRecheckMs = input.offlineRecheckMs ?? INTERVALS_SIGN_IN_OFFLINE_RECHECK_MS;
  let state: RetryState = { kind: "idle" };

  const transition = (next: RetryState): void => {
    if (state.kind === "closed") return;
    if (state.kind === "waiting") clearTimeout(state.timer);
    state = next;
  };

  const wait = (attempt: number, delay: number): void => {
    if (state.kind === "closed") return;
    transition({ kind: "waiting", attempt, timer: setTimeout(() => void fire(attempt), delay) });
  };

  const scheduleAttempt = (attempt: number): void => {
    wait(attempt, delays[Math.min(attempt, delays.length - 1)] ?? offlineRecheckMs);
  };

  const isAt = (kind: "waiting" | "retrying", attempt: number): boolean =>
    state.kind === kind && state.attempt === attempt;

  const fire = async (attempt: number): Promise<void> => {
    if (!isAt("waiting", attempt)) return;
    if (!input.net.isOnline()) {
      wait(attempt, offlineRecheckMs);
      return;
    }
    transition({ kind: "retrying", attempt });
    const outcome = await input.vault.retryFailed().then(
      () => "settled" as const,
      () => "vault-failed" as const,
    );
    if (!isAt("retrying", attempt)) return;
    if (outcome === "vault-failed") scheduleAttempt(attempt + 1);
    else transition({ kind: "idle" });
  };

  const resume = (): void => {
    if (state.kind === "waiting") scheduleAttempt(0);
  };

  const close = (): void => {
    transition({ kind: "closed" });
    input.powerMonitor.off("resume", resume);
  };
  if (signal.aborted) close();
  else {
    signal.addEventListener("abort", close, { once: true });
    input.powerMonitor.on("resume", resume);
  }

  return {
    async observe(slot, reapply) {
      if (slot !== "intervals-icu") return await reapply();
      try {
        const result = await reapply();
        transition({ kind: "idle" });
        return result;
      } catch (error) {
        if (error instanceof CredentialRuntimeRefusal && error.reason !== "ownership-unavailable") {
          transition({ kind: "idle" });
        } else {
          scheduleAttempt(state.kind === "retrying" ? state.attempt + 1 : 0);
        }
        throw error;
      }
    },
  };
}
