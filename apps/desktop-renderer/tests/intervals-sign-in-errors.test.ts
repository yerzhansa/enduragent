import { describe, expect, it } from "vitest";
import type {
  IntervalsCredentialMutationRefusalReason,
  IntervalsCredentialMutationResult,
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

  it.each([
    { state: "configured", runtimeState: "stored-inactive" },
    { state: "configured", runtimeState: null },
    { state: "re-prompt", runtimeState: "active" },
    { state: "missing", runtimeState: null },
  ] as const)(
    "reports runtime-unavailable for an applied sign-in that is $state and $runtimeState",
    (status) => {
      expect(
        intervalsMutationError({
          outcome: "applied",
          current: { slot: "intervals-icu", ...status },
          athleteName: "Test Athlete",
        }),
      ).toBe("intervals-runtime-unavailable");
    },
  );

  it("reports uncertain storage without reading the current status", () => {
    expect(
      intervalsMutationError({
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
      }),
    ).toBe("intervals-storage-uncertain");
  });

  it.each(["applied", "runtime-uncertain"] as const)(
    "reports a saved sign-in the coach could not use as not working (%s)",
    (kind) => {
      const current = {
        slot: "intervals-icu",
        state: "configured",
        runtimeState: "failed",
      } as const;
      const result: IntervalsCredentialMutationResult =
        kind === "applied"
          ? { outcome: "applied", current }
          : { outcome: "uncertain", reason: "runtime-uncertain", current };

      expect(intervalsMutationError(result)).toBe("intervals-runtime-not-working");
    },
  );

  it("trusts an active saved status over the reported outcome", () => {
    expect(
      intervalsMutationError({
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      }),
    ).toBeNull();
  });

  it("asks for a new sign-in when activation failed and nothing usable is saved", () => {
    expect(
      intervalsMutationError({
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: MISSING,
      }),
    ).toBe("intervals-runtime-unavailable");
    expect(
      intervalsMutationError({
        outcome: "uncertain",
        reason: "runtime-uncertain",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "stored-inactive" },
      }),
    ).toBe("intervals-runtime-unavailable");
  });
});
