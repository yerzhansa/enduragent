import { describe, expect, it } from "vitest";
import type {
  IntervalsCredentialMutationRefusalReason,
  IntervalsCredentialStatus,
} from "../src/onboarding/bridge";
import { intervalsMutationError } from "../src/onboarding/intervals-sign-in";
import type { OnboardingErrorCode } from "../src/onboarding/machine";

const MISSING: IntervalsCredentialStatus = {
  slot: "intervals-icu",
  state: "missing",
  runtimeState: null,
};

const REFUSAL_ERRORS: Readonly<
  Record<IntervalsCredentialMutationRefusalReason, OnboardingErrorCode | null>
> = {
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
};

describe("intervalsMutationError", () => {
  it.each(
    Object.entries(REFUSAL_ERRORS) as ReadonlyArray<
      [IntervalsCredentialMutationRefusalReason, OnboardingErrorCode | null]
    >,
  )("maps the %s refusal to %s", (reason, expected) => {
    expect(intervalsMutationError({ outcome: "refused", reason, current: MISSING })).toBe(expected);
  });

  it("reports no error for an applied and active sign-in, with or without a name", () => {
    const current = { slot: "intervals-icu", state: "configured", runtimeState: "active" } as const;

    expect(intervalsMutationError({ outcome: "applied", current })).toBeNull();
    expect(
      intervalsMutationError({ outcome: "applied", current, athleteName: "Test Athlete" }),
    ).toBeNull();
  });

  it.each(["applied", "saved-not-active"] as const)(
    "points a %s sign-in the coach can't use at Retry saved keys",
    (outcome) => {
      expect(
        intervalsMutationError({
          outcome,
          current: { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
        }),
      ).toBe("intervals-saved-not-active");
    },
  );

  it("reports no error when the saved sign-in turns out to be active", () => {
    expect(
      intervalsMutationError({
        outcome: "saved-not-active",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      }),
    ).toBeNull();
  });

  it.each([
    { state: "configured", runtimeState: "stored-inactive" },
    { state: "configured", runtimeState: null },
    { state: "re-prompt", runtimeState: "active" },
    { state: "missing", runtimeState: null },
  ] as const)(
    "reports runtime-unavailable for a saved sign-in that is $state and $runtimeState",
    (status) => {
      for (const outcome of ["applied", "saved-not-active"] as const) {
        expect(
          intervalsMutationError({ outcome, current: { slot: "intervals-icu", ...status } }),
        ).toBe("intervals-runtime-unavailable");
      }
    },
  );

  it("reports uncertain storage", () => {
    expect(
      intervalsMutationError({
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: MISSING,
      }),
    ).toBe("intervals-storage-uncertain");
  });
});
