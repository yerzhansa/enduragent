import type {
  CredentialWriteResult,
  OnboardingCredentialWriteInput,
  OnboardingLlmSelection,
} from "./bridge";
import { DESKTOP_CREDENTIAL_SLOTS } from "./constants";
import type { OnboardingErrorCode } from "./machine";

export interface TransientPasswordInput {
  value: string;
  readonly dataset: { readonly slot?: string };
}

export interface CredentialDraftPort {
  harvest(slots?: readonly string[]): readonly TransientPasswordInput[];
  clear(): void;
}

export async function handoffCredential(
  input: TransientPasswordInput,
  write: (value: OnboardingCredentialWriteInput) => Promise<unknown>,
  selection?: OnboardingLlmSelection,
): Promise<boolean> {
  let secret: string | undefined;
  try {
    secret = input.value;
    input.value = "";
    if (secret.trim().length === 0) return false;
    await write({
      slot: input.dataset.slot as OnboardingCredentialWriteInput["slot"],
      value: secret,
      ...(selection === undefined ? {} : { selection }),
    });
    return true;
  } finally {
    input.value = "";
    secret = undefined;
  }
}

export function credentialSlotFor(
  provider: string | undefined,
): OnboardingCredentialWriteInput["slot"] | undefined {
  const slot = DESKTOP_CREDENTIAL_SLOTS.find((candidate) => candidate === provider);
  return slot === "intervals-icu" ? undefined : slot;
}

type CredentialWriteFailureReason = Extract<
  CredentialWriteResult,
  { readonly status: "stale-draft" | "refused" | "uncertain" }
>["reason"];

const CREDENTIAL_WRITE_REFUSAL_ERRORS = {
  "invalid-input": "invalid-input",
  "encryption-unavailable": "encryption-unavailable",
  "unsafe-backend": "unsafe-backend",
  "storage-failed": "storage-failed",
  "runtime-unavailable": "runtime-unavailable",
  "catalog-unavailable": "configuration-unavailable",
  "training-account-mismatch": "training-account-mismatch",
  "storage-uncertain": "storage-uncertain",
} as const satisfies Readonly<Record<CredentialWriteFailureReason, OnboardingErrorCode>>;

export function credentialWriteRefusalError(reason: unknown): OnboardingErrorCode {
  if (typeof reason === "string" && Object.hasOwn(CREDENTIAL_WRITE_REFUSAL_ERRORS, reason)) {
    return CREDENTIAL_WRITE_REFUSAL_ERRORS[reason as CredentialWriteFailureReason];
  }
  return "credential-save-failed";
}
