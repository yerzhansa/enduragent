export interface OAuthCredentialOwner {
  hasProfile(profileName: string): Promise<boolean>;
  getAccessToken(
    profileName: string,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<string>;
  deleteProfile(profileName: string): Promise<void>;
}
