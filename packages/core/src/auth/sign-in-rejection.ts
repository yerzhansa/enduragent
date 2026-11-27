import {
  compareAndSaveStoredProfile,
  type StoredProfile,
  type StoredProfileSnapshot,
} from "./profile-store.js";

const SIGN_IN_REJECTED = "signInRejected";

export function signInRejected(profile: StoredProfile): boolean {
  return profile[SIGN_IN_REJECTED] === true;
}

export function withoutSignInRejection(profile: StoredProfile): StoredProfile {
  return Object.fromEntries(
    Object.entries(profile).filter(([field]) => field !== SIGN_IN_REJECTED),
  );
}

export async function markSignInRejected(
  profilesPath: string,
  name: string,
  rejected: StoredProfileSnapshot,
): Promise<void> {
  await compareAndSaveStoredProfile(profilesPath, name, rejected, {
    ...rejected.profile,
    [SIGN_IN_REJECTED]: true,
  });
}
