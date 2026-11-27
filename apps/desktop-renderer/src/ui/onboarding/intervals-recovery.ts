import { useState } from "react";
import type { OnboardingSurfaceState } from "../../onboarding/controller";
import { credentialPresentation } from "../../onboarding/credential-presentation";
import type { OnboardingErrorCode } from "../../onboarding/machine";
import { useEnduragentStore } from "../../state/store";
import { intervalsSignInNeedsRenewal } from "../../state/sync-slice";

export interface IntervalsRecovery {
  readonly connected: boolean;
  readonly rejected: boolean;
  readonly retrySavedKeysShown: boolean;
}

function useHeldWhile<T>(value: T, holding: boolean): T {
  const [held, setHeld] = useState<{ readonly value: T } | null>(null);
  if (holding && held === null) setHeld({ value });
  if (!holding && held !== null) setHeld(null);
  return holding && held !== null ? held.value : value;
}

export function useIntervalsRecovery(surface: OnboardingSurfaceState): IntervalsRecovery {
  const deleting = useEnduragentStore((state) => state.settings.credentials.status === "deleting");
  const signInRejected = useHeldWhile(useEnduragentStore(intervalsSignInNeedsRenewal), deleting);
  const connected = surface.wizard.credentialStatus["intervals-icu"] === "configured";
  const rejected = connected && signInRejected;
  const retryableStatus = surface.statuses.some(
    (entry) => entry.slot === "intervals-icu" && credentialPresentation(entry).retryable,
  );
  return { connected, rejected, retrySavedKeysShown: retryableStatus && !rejected };
}

export function shownSetupError(
  error: OnboardingErrorCode | null,
  recovery: IntervalsRecovery,
): OnboardingErrorCode | null {
  return error === "intervals-saved-not-active" && !recovery.retrySavedKeysShown
    ? "intervals-runtime-unavailable"
    : error;
}
