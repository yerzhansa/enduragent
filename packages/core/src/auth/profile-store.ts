import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileSync } from "../io/atomic-write-file-sync.js";
import {
  withInterprocessFileLock,
  withInterprocessFileLockSync,
} from "../io/interprocess-file-lock-sync.js";

export const DESKTOP_OAUTH_OWNERSHIP_FILE = ".desktop-oauth-owner.json";

export class DesktopOwnedOAuthHomeError extends Error {
  constructor() {
    super(
      "This home belongs to Enduragent desktop. Stop shared-home CLI processes and use a separate CLI home, then sign in there.",
    );
    this.name = "DesktopOwnedOAuthHomeError";
  }
}

function desktopOwnershipMarkerPresent(profilesPath: string): boolean {
  try {
    lstatSync(join(dirname(profilesPath), DESKTOP_OAUTH_OWNERSHIP_FILE));
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function syncProfileDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function assertCliOAuthHome(profilesPath: string): void {
  if (desktopOwnershipMarkerPresent(profilesPath)) {
    throw new DesktopOwnedOAuthHomeError();
  }
}

const AUTH_PROFILES_LOCK_FILE = ".auth-profiles.lock";

export interface StoredProfile {
  readonly [field: string]: unknown;
}

export interface StoredProfileSnapshot {
  readonly profile: StoredProfile;
  readonly revision: string;
}

export type CompareAndSaveStoredProfileResult =
  | { readonly status: "saved"; readonly profile: StoredProfile }
  | { readonly status: "superseded"; readonly profile: StoredProfile }
  | { readonly status: "missing" };

export type DeleteStoredProfileResult = { readonly status: "deleted" | "missing" };

type ProfilesDocument = Record<string, StoredProfile>;

interface RecoverableProfilesDocument {
  readonly profiles: ProfilesDocument;
  readonly malformedBytes?: Buffer;
}

function isStoredProfile(value: unknown): value is StoredProfile {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyProfilesDocument(): ProfilesDocument {
  return Object.create(null) as ProfilesDocument;
}

function decodeProfilesBytes(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function profileAt(profiles: ProfilesDocument, name: string): StoredProfile | undefined {
  return Object.prototype.hasOwnProperty.call(profiles, name) ? profiles[name] : undefined;
}

function parseProfiles(contents: string): ProfilesDocument {
  const parsed = JSON.parse(contents) as unknown;
  if (!isStoredProfile(parsed)) throw new TypeError("OAuth profiles document must be a map.");
  const profiles = emptyProfilesDocument();
  for (const [name, profile] of Object.entries(parsed)) {
    if (!isStoredProfile(profile)) {
      throw new TypeError("OAuth profile entries must be maps.");
    }
    profiles[name] = profile;
  }
  return profiles;
}

function readProfiles(path: string): ProfilesDocument {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyProfilesDocument();
    throw error;
  }
  return parseProfiles(decodeProfilesBytes(bytes));
}

function salvageProfiles(contents: string): ProfilesDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return emptyProfilesDocument();
  }
  if (!isStoredProfile(parsed)) return emptyProfilesDocument();
  const profiles = emptyProfilesDocument();
  for (const [name, profile] of Object.entries(parsed)) {
    if (isStoredProfile(profile)) profiles[name] = profile;
  }
  return profiles;
}

function readProfilesForRecovery(path: string): RecoverableProfilesDocument {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { profiles: emptyProfilesDocument() };
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new TypeError("OAuth profiles recovery requires a regular file.");
  }
  const malformedBytes = readFileSync(path);
  let contents: string;
  try {
    contents = decodeProfilesBytes(malformedBytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { profiles: emptyProfilesDocument(), malformedBytes };
  }
  try {
    return { profiles: parseProfiles(contents) };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    return { profiles: salvageProfiles(contents), malformedBytes };
  }
}

function quarantinePathFor(path: string, sequence: number): string {
  const suffix = sequence === 0 ? "" : `.${sequence}`;
  return join(dirname(path), `${basename(path)}.corrupt${suffix}`);
}

function writeQuarantine(path: string, bytes: Buffer): string {
  for (let sequence = 0; ; sequence += 1) {
    const candidate = quarantinePathFor(path, sequence);
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(
        candidate,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      created = true;
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      return candidate;
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {}
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if (created) {
        try {
          unlinkSync(candidate);
        } catch {}
      }
      throw error;
    }
  }
}

function revision(profile: StoredProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

function snapshot(profile: StoredProfile): StoredProfileSnapshot {
  return { profile, revision: revision(profile) };
}

function lockPathFor(profilesPath: string): string {
  return join(dirname(profilesPath), AUTH_PROFILES_LOCK_FILE);
}

function writeProfiles(path: string, profiles: ProfilesDocument): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(profiles, null, 2));
}

export function loadStoredProfileSnapshot(
  profilesPath: string,
  name: string,
): StoredProfileSnapshot | null {
  assertCliOAuthHome(profilesPath);
  const profile = profileAt(readProfiles(profilesPath), name);
  return profile === undefined ? null : snapshot(profile);
}

export function saveStoredProfile(
  profilesPath: string,
  name: string,
  profile: StoredProfile,
): void {
  mkdirSync(dirname(profilesPath), { recursive: true, mode: 0o700 });
  withInterprocessFileLockSync(lockPathFor(profilesPath), () => {
    assertCliOAuthHome(profilesPath);
    const profiles = readProfiles(profilesPath);
    profiles[name] = profile;
    writeProfiles(profilesPath, profiles);
  });
}

export function recoverAndSaveStoredProfile(
  profilesPath: string,
  name: string,
  profile: StoredProfile,
): void {
  mkdirSync(dirname(profilesPath), { recursive: true, mode: 0o700 });
  withInterprocessFileLockSync(lockPathFor(profilesPath), () => {
    assertCliOAuthHome(profilesPath);
    const recovered = readProfilesForRecovery(profilesPath);
    if (recovered.malformedBytes !== undefined) {
      writeQuarantine(profilesPath, recovered.malformedBytes);
    }
    recovered.profiles[name] = profile;
    writeProfiles(profilesPath, recovered.profiles);
  });
}

export function deleteStoredProfile(profilesPath: string, name: string): DeleteStoredProfileResult {
  mkdirSync(dirname(profilesPath), { recursive: true, mode: 0o700 });
  return withInterprocessFileLockSync(lockPathFor(profilesPath), () => {
    assertCliOAuthHome(profilesPath);
    const profiles = readProfiles(profilesPath);
    if (profileAt(profiles, name) === undefined) return { status: "missing" };
    delete profiles[name];
    writeProfiles(profilesPath, profiles);
    return { status: "deleted" };
  });
}

export async function compareAndSaveStoredProfile(
  profilesPath: string,
  name: string,
  expected: StoredProfileSnapshot,
  next: StoredProfile,
): Promise<CompareAndSaveStoredProfileResult> {
  mkdirSync(dirname(profilesPath), { recursive: true, mode: 0o700 });
  return withInterprocessFileLock(lockPathFor(profilesPath), () => {
    assertCliOAuthHome(profilesPath);
    const profiles = readProfiles(profilesPath);
    const current = profileAt(profiles, name);
    if (current === undefined) return { status: "missing" };
    if (revision(current) !== expected.revision) {
      return { status: "superseded", profile: current };
    }
    profiles[name] = next;
    writeProfiles(profilesPath, profiles);
    return { status: "saved", profile: next };
  });
}

export async function migrateDesktopOAuthProfiles(
  profilesPath: string,
  names: readonly string[],
  persistAndVerify: (
    legacy: Readonly<Record<string, StoredProfileSnapshot>>,
    owned: boolean,
  ) => Promise<void>,
): Promise<void> {
  mkdirSync(dirname(profilesPath), { recursive: true, mode: 0o700 });
  await withInterprocessFileLock(lockPathFor(profilesPath), async () => {
    const marker = join(dirname(profilesPath), DESKTOP_OAUTH_OWNERSHIP_FILE);
    if (desktopOwnershipMarkerPresent(profilesPath)) {
      const metadata = lstatSync(marker);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new DesktopOwnedOAuthHomeError();
      const ownership: unknown = JSON.parse(readFileSync(marker, "utf8"));
      if (
        !isStoredProfile(ownership) ||
        ownership.schemaVersion !== 1 ||
        ownership.owner !== "desktop"
      )
        throw new DesktopOwnedOAuthHomeError();
      await persistAndVerify({}, true);
      return;
    }
    const profiles = readProfiles(profilesPath);
    const selected = Object.fromEntries(
      names.flatMap((name) => {
        const profile = profileAt(profiles, name);
        return profile === undefined ? [] : [[name, snapshot(profile)] as const];
      }),
    );
    await persistAndVerify(selected, false);
    const latest = readProfiles(profilesPath);
    for (const name of names) {
      const current = profileAt(latest, name);
      if ((current === undefined ? undefined : revision(current)) !== selected[name]?.revision) {
        throw new Error("Desktop OAuth migration is incomplete: the legacy profile changed.");
      }
      delete latest[name];
    }
    if (Object.keys(selected).length > 0) {
      writeProfiles(profilesPath, latest);
      syncProfileDirectory(profilesPath);
    }
    atomicWriteFileSync(marker, JSON.stringify({ schemaVersion: 1, owner: "desktop" }));
    syncProfileDirectory(marker);
  });
}
