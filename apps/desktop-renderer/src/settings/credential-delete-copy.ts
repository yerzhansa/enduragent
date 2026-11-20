import type {
  CredentialDeleteResult,
  CredentialRecoveryStatus,
  DesktopCredentialId,
} from "../onboarding/bridge";

type DeletedResult = Extract<CredentialDeleteResult, { readonly status: "deleted" }>;
type RefusalReason = Extract<CredentialDeleteResult, { readonly status: "refused" }>["reason"];

export const UNCERTAIN_DELETE_ANNOUNCEMENT =
  "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.";

export const INTERVALS_DISCONNECT_COPY = {
  confirm: "Confirm disconnecting Intervals.icu.",
  disconnecting: "Disconnecting Intervals.icu…",
  cancelled: "Disconnect cancelled.",
  revoked: "Disconnected. Enduragent’s access was revoked on Intervals.icu.",
  revokeFailed:
    "Disconnected on this computer, but Enduragent couldn’t reach Intervals.icu to revoke its access. You can remove Enduragent there under Settings → Apps.",
  apiKeyRemoved:
    "Disconnected. The API key was removed from this computer. It keeps working on Intervals.icu until you delete it there.",
  cleanupPending: "Secure storage cleanup will be retried.",
  refreshFailed: "Current connection status couldn’t be refreshed.",
  setupRefreshFailed: "Setup readiness couldn’t be refreshed. Reload credential status.",
} as const;

export type IntervalsDisconnectCopy = keyof typeof INTERVALS_DISCONNECT_COPY;

export function recoveryCopy(recovery: CredentialRecoveryStatus): string {
  if (recovery.state === "locked") {
    return "Unlock your login Keychain outside Enduragent, then Retry.";
  }
  if (recovery.state === "missing") {
    return "The credential encryption key is missing. Restore it if possible, then Retry, or remove all credentials and start again.";
  }
  if (recovery.state === "unavailable") {
    return "Secure credential storage is unavailable. Retry, or remove all credentials and start again.";
  }
  return "unverifiedEnvelopes" in recovery && recovery.unverifiedEnvelopes > 0
    ? "Enduragent can’t open some saved credentials safely. Enter each affected credential again."
    : "";
}

export function refusalCopy(reason: RefusalReason): string {
  if (reason === "managed-by-environment") {
    return "This credential is managed outside Settings and can’t be deleted here.";
  }
  if (reason === "not-found") {
    return "That credential is no longer stored. Reload to refresh the list.";
  }
  if (reason === "encryption-unavailable") {
    return "The credential was retained because secure storage could not confirm its encryption key.";
  }
  if (reason === "storage-failed") {
    return "The credential remains stored. No deletion was completed. Try again.";
  }
  if (reason === "runtime-state-diverged") {
    return "The saved and active credential states could not be reconciled. Reconnect and reload before trying again.";
  }
  return "The coach could not stop using this credential safely. It was not deleted.";
}

export function deleteConfirmCopy(credential: DesktopCredentialId, provider: string): string {
  return credential === "intervals-icu"
    ? INTERVALS_DISCONNECT_COPY.confirm
    : `Confirm deletion of the ${provider} credential.`;
}

export function deletingCopy(credential: DesktopCredentialId, provider: string): string {
  return credential === "intervals-icu"
    ? INTERVALS_DISCONNECT_COPY.disconnecting
    : `Deleting the ${provider} credential locally…`;
}

export function deleteCancelledCopy(credential: DesktopCredentialId | "all"): string {
  if (credential === "all") return "Credential removal cancelled.";
  return credential === "intervals-icu"
    ? INTERVALS_DISCONNECT_COPY.cancelled
    : "Credential deletion cancelled.";
}

function disconnectedCopy(result: DeletedResult): string | null {
  if (!("revoke" in result)) return null;
  if (result.revoke === "failed") return INTERVALS_DISCONNECT_COPY.revokeFailed;
  return result.revoke === "not-signed-in"
    ? INTERVALS_DISCONNECT_COPY.apiKeyRemoved
    : INTERVALS_DISCONNECT_COPY.revoked;
}

export function deletedCopy(result: DeletedResult, refreshFailed: boolean): string {
  const disconnected = disconnectedCopy(result);
  if (disconnected === null) {
    if (result.cleanupPending) {
      return "Credential deleted locally. Secure storage cleanup will be retried.";
    }
    return refreshFailed
      ? "Credential deleted locally. Current credential status couldn’t be refreshed."
      : "Credential deleted locally.";
  }
  if (result.cleanupPending) return `${disconnected} ${INTERVALS_DISCONNECT_COPY.cleanupPending}`;
  return refreshFailed
    ? `${disconnected} ${INTERVALS_DISCONNECT_COPY.refreshFailed}`
    : disconnected;
}

export function deletedSetupRefreshFailedCopy(result: DeletedResult): string {
  const disconnected = disconnectedCopy(result);
  return disconnected === null
    ? "Credential deleted locally, but setup readiness couldn’t be refreshed. Reload credential status."
    : `${disconnected} ${INTERVALS_DISCONNECT_COPY.setupRefreshFailed}`;
}
