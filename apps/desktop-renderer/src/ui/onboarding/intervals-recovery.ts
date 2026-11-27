import { useState } from "react";
import type { OnboardingSurfaceState } from "../../onboarding/controller";
import { credentialPresentation } from "../../onboarding/credential-presentation";
import { intervalsErrorWithRetry } from "../../onboarding/intervals-sign-in";
import type { OnboardingErrorCode } from "../../onboarding/machine";
import { useEnduragentStore } from "../../state/store";
import { intervalsSignInNeedsRenewal } from "../../state/sync-slice";

export interface IntervalsRecovery {
  readonly rejected: boolean;
  readonly retryShown: boolean;
  readonly error: OnboardingErrorCode | null;
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
  const rejected =
    surface.wizard.credentialStatus["intervals-icu"] === "configured" && signInRejected;
  const retryShown =
    !rejected &&
    surface.statuses.some(
      (entry) => entry.slot === "intervals-icu" && credentialPresentation(entry).retryable,
    );
  const fixedError = surface.wizard.fixedError;
  return {
    rejected,
    retryShown,
    error: fixedError === null ? null : intervalsErrorWithRetry(fixedError, retryShown),
  };
}
