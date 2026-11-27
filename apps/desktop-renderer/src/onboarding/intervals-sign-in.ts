import type {
  IntervalsCredentialMutationRefusalReason,
  IntervalsCredentialMutationResult,
  IntervalsSignInPhase,
} from "./bridge";
import type { OnboardingErrorCode } from "./machine";

export interface IntervalsSignInSurface {
  readonly phase: IntervalsSignInPhase | "idle";
  readonly athleteName: string | null;
}

const INTERVALS_REFUSAL_ERRORS = {
  "sign-in-denied": "intervals-sign-in-denied",
  "sign-in-failed": "intervals-sign-in-failed",
  "sign-in-timed-out": "intervals-sign-in-timed-out",
  "sign-in-cancelled": null,
  "sign-in-unreachable": "intervals-sign-in-unreachable",
  "credential-rejected": "intervals-sign-in-rejected",
  "malformed-athlete-response": "intervals-validation-unavailable",
  "validation-timeout": "intervals-validation-unavailable",
  "validation-aborted": "intervals-validation-unavailable",
  "validation-unavailable": "intervals-validation-unavailable",
  "training-account-mismatch": "training-account-mismatch",
  "owner-unresolved": "intervals-owner-unavailable",
  "store-unavailable": "intervals-owner-unavailable",
  "encryption-unavailable": "encryption-unavailable",
  "unsafe-backend": "unsafe-backend",
  "storage-failed": "storage-failed",
  "runtime-unavailable": "intervals-runtime-unavailable",
} as const satisfies Readonly<
  Record<IntervalsCredentialMutationRefusalReason, OnboardingErrorCode | null>
>;

export function intervalsMutationError(
  result: IntervalsCredentialMutationResult,
): OnboardingErrorCode | null {
  if (result.outcome === "refused") return INTERVALS_REFUSAL_ERRORS[result.reason];
  if (result.outcome === "uncertain" && result.reason === "storage-uncertain") {
    return "intervals-storage-uncertain";
  }
  const current = result.current;
  if (current.state !== "configured") return "intervals-runtime-unavailable";
  if (current.runtimeState === "active") return null;
  return current.runtimeState === "failed"
    ? "intervals-runtime-not-working"
    : "intervals-runtime-unavailable";
}
