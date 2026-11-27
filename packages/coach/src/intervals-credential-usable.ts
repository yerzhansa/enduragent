import { isIntervalsCredentialRejected } from "@enduragent/core";

export function isIntervalsCredentialUsable(credential: string): boolean {
  return credential.length > 0 && !isIntervalsCredentialRejected(credential);
}
