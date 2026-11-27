import { CREDENTIALS, exactKeys, record, SLOTS } from "./shape.js";

const DELETE_REASONS: ReadonlySet<unknown> = new Set([
  "not-found",
  "managed-by-environment",
  "encryption-unavailable",
  "storage-failed",
  "runtime-unavailable",
  "runtime-state-diverged",
]);
const REVOKE_RESULTS: ReadonlySet<unknown> = new Set([
  "revoked",
  "already-invalid",
  "not-signed-in",
  "failed",
]);

export function parseDeleteResult(value: unknown): unknown {
  if (
    record(value) &&
    value.status === "uncertain" &&
    exactKeys(value, ["slot", "status", "reason"]) &&
    SLOTS.has(value.slot as string) &&
    value.reason === "storage-uncertain"
  ) {
    return { slot: value.slot, status: "uncertain", reason: "storage-uncertain" };
  }
  if (
    !record(value) ||
    typeof value.credential !== "string" ||
    !CREDENTIALS.has(value.credential)
  ) {
    throw new TypeError();
  }
  if (
    value.status === "deleted" &&
    value.credential === "intervals-icu" &&
    exactKeys(value, ["credential", "status", "cleanupPending", "revoke"]) &&
    typeof value.cleanupPending === "boolean" &&
    REVOKE_RESULTS.has(value.revoke)
  ) {
    return {
      credential: value.credential,
      status: "deleted",
      cleanupPending: value.cleanupPending,
      revoke: value.revoke,
    };
  }
  if (
    value.status === "deleted" &&
    value.credential !== "intervals-icu" &&
    exactKeys(value, ["credential", "status", "cleanupPending"]) &&
    typeof value.cleanupPending === "boolean"
  ) {
    return {
      credential: value.credential,
      status: "deleted",
      cleanupPending: value.cleanupPending,
    };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["credential", "status", "reason"]) &&
    DELETE_REASONS.has(value.reason)
  ) {
    return { credential: value.credential, status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

export function parseCredentialDeleteInput(value: unknown): { readonly credential: string } {
  if (
    !record(value) ||
    !exactKeys(value, ["credential"]) ||
    typeof value.credential !== "string" ||
    !CREDENTIALS.has(value.credential)
  ) {
    throw new TypeError();
  }
  return { credential: value.credential };
}
