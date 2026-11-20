export const INTERVALS_OAUTH_CREDENTIAL_PREFIX = "intervals-oauth:";

export type IntervalsCredential =
  | { readonly kind: "api-key"; readonly apiKey: string }
  | { readonly kind: "oauth"; readonly accessToken: string };

export function encodeIntervalsOAuthCredential(accessToken: string): string {
  if (accessToken.length === 0 || accessToken.trim() !== accessToken) {
    throw new TypeError("intervals.icu access token is required");
  }
  return `${INTERVALS_OAUTH_CREDENTIAL_PREFIX}${accessToken}`;
}

export function decodeIntervalsCredential(storedCredential: string): IntervalsCredential {
  if (storedCredential.startsWith(INTERVALS_OAUTH_CREDENTIAL_PREFIX)) {
    const accessToken = storedCredential.slice(INTERVALS_OAUTH_CREDENTIAL_PREFIX.length);
    if (accessToken.length > 0) return { kind: "oauth", accessToken };
  }
  return { kind: "api-key", apiKey: storedCredential };
}

export function intervalsCredentialKind(storedCredential: string): IntervalsCredential["kind"] {
  return decodeIntervalsCredential(storedCredential).kind;
}

export function intervalsAuthorizationHeader(storedCredential: string): string {
  const credential = decodeIntervalsCredential(storedCredential);
  return credential.kind === "oauth"
    ? `Bearer ${credential.accessToken}`
    : `Basic ${btoa(`API_KEY:${credential.apiKey}`)}`;
}

export function intervalsClientAuth(
  storedCredential: string,
): { readonly apiKey: string } | { readonly bearerToken: string } {
  const credential = decodeIntervalsCredential(storedCredential);
  return credential.kind === "oauth"
    ? { bearerToken: credential.accessToken }
    : { apiKey: credential.apiKey };
}
