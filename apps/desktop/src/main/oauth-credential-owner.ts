import { parse as parseYaml } from "yaml";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TokenRefreshError,
  bindWindowsPrivateDirectory,
  migrateDesktopOAuthProfiles,
  refreshCodexToken,
  type CodexCredentials,
  type OAuthCredential,
  type OAuthCredentialOwner,
} from "@enduragent/core";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import { durableAtomicReplace, syncDirectory } from "./durable-atomic-replace.js";
import {
  MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
  readWindowsPrivateFile,
} from "./windows-private-file.js";

export const DESKTOP_OAUTH_ENVELOPE_FILE = "oauth.bin";
export const DESKTOP_OAUTH_PROFILE_NAME = "openai-codex";

export async function readDesktopOAuthProfileName(configDir: string): Promise<string> {
  try {
    const config: unknown = parseYaml(await readFile(join(configDir, "config.yaml"), "utf8"));
    if (
      record(config) &&
      record(config.llm) &&
      typeof config.llm.auth_profile === "string" &&
      config.llm.auth_profile.length > 0
    )
      return config.llm.auth_profile;
  } catch {}
  return DESKTOP_OAUTH_PROFILE_NAME;
}

interface EncryptedOAuthProfile {
  readonly revision: string;
  readonly legacyRevision: string | null;
  readonly profile: OAuthCredential;
}

interface OAuthEnvelope {
  readonly schemaVersion: 1;
  readonly home: string;
  readonly profiles: Readonly<Record<string, EncryptedOAuthProfile>>;
}

export interface DesktopOAuthCredentialOwner extends OAuthCredentialOwner {
  initialize(): Promise<void>;
  recoveryRequired(): Promise<boolean>;
  writeProfile(credentials: CodexCredentials): Promise<void>;
}

interface Options {
  readonly root: string;
  readonly configDir: string;
  readonly selectedProfile?: string;
  readonly encryption: CredentialEncryptionPort;
  readonly serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation;
  readonly prepareEnvelopeWrite: (proof: CredentialEnvelopeLockProof) => Promise<void>;
  readonly revalidateEnvelopeRemoval: (proof: CredentialEnvelopeLockProof) => Promise<boolean>;
  readonly observeEnvelopeRemoved: (proof: CredentialEnvelopeLockProof) => Promise<void>;
  readonly refreshToken?: typeof refreshCodexToken;
  readonly replaceEnvelope?: typeof durableAtomicReplace;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

function unavailable(): Error {
  return new Error(
    "ChatGPT credentials are unavailable. Use desktop credential recovery or sign in again.",
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDesktopOAuthCredential(value: unknown): OAuthCredential {
  if (
    !record(value) ||
    value.type !== "oauth" ||
    typeof value.access !== "string" ||
    value.access.length === 0 ||
    typeof value.refresh !== "string" ||
    value.refresh.length === 0 ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    (value.accountId !== undefined && typeof value.accountId !== "string") ||
    (value.email !== undefined && typeof value.email !== "string")
  )
    throw unavailable();
  return {
    type: "oauth",
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
    ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    ...(value.email === undefined ? {} : { email: value.email }),
  };
}

function parseEnvelope(raw: string, home: string): OAuthEnvelope {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.schemaVersion !== 1 || value.home !== home || !record(value.profiles))
    throw unavailable();
  const profiles: Record<string, EncryptedOAuthProfile> = {};
  for (const [name, entry] of Object.entries(value.profiles)) {
    if (
      !record(entry) ||
      typeof entry.revision !== "string" ||
      !/^[0-9a-f-]{36}$/.test(entry.revision) ||
      (entry.legacyRevision !== null &&
        (typeof entry.legacyRevision !== "string" || !/^[0-9a-f]{64}$/.test(entry.legacyRevision)))
    )
      throw unavailable();
    Object.defineProperty(profiles, name, {
      value: {
        revision: entry.revision,
        legacyRevision: entry.legacyRevision,
        profile: parseDesktopOAuthCredential(entry.profile),
      },
      enumerable: true,
      configurable: true,
    });
  }
  return { schemaVersion: 1, home, profiles };
}

export function createDesktopOAuthCredentialOwner(options: Options): DesktopOAuthCredentialOwner {
  const platform = options.platform ?? process.platform;
  const path = join(options.root, DESKTOP_OAUTH_ENVELOPE_FILE);
  const refreshToken = options.refreshToken ?? refreshCodexToken;
  const replace = options.replaceEnvelope ?? durableAtomicReplace;
  const assertEncryption = (): void => {
    if (
      !options.encryption.isEncryptionAvailable() ||
      options.encryption.getSelectedStorageBackend?.() === "basic_text"
    )
      throw unavailable();
  };
  const ensureRoot = async (): Promise<void> => {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(options.root);
    if (platform === "win32") {
      bindWindowsPrivateDirectory(dirname(options.root), options.root);
    } else if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid())
    )
      throw unavailable();
  };
  const readBytes = async (): Promise<Buffer | undefined> => {
    await ensureRoot();
    if (platform === "win32") {
      return (
        await readWindowsPrivateFile({
          directory: bindWindowsPrivateDirectory(dirname(options.root), options.root),
          path,
          minimumBytes: 1,
          maximumBytes: MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
        })
      )?.contents;
    }
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return undefined;
      throw unavailable();
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size < 1 ||
        before.size > MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES ||
        (process.getuid !== undefined && before.uid !== process.getuid())
      )
        throw unavailable();
      const bytes = await handle.readFile();
      const after = await lstat(path);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        bytes.fill(0);
        throw unavailable();
      }
      return bytes;
    } finally {
      await handle.close();
    }
  };
  const read = async (): Promise<OAuthEnvelope | undefined> => {
    const bytes = await readBytes();
    if (bytes === undefined) return undefined;
    try {
      assertEncryption();
      return parseEnvelope(options.encryption.decryptString(bytes), options.configDir);
    } finally {
      bytes.fill(0);
    }
  };
  const write = async (value: OAuthEnvelope, proof: CredentialEnvelopeLockProof): Promise<void> => {
    await ensureRoot();
    await options.prepareEnvelopeWrite(proof);
    assertEncryption();
    const encrypted = options.encryption.encryptString(JSON.stringify(value));
    try {
      if (encrypted.length > MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES) throw unavailable();
      const result = await replace({
        root: options.root,
        fileName: DESKTOP_OAUTH_ENVELOPE_FILE,
        contents: encrypted,
        mode: 0o600,
        platform,
      });
      if (result.state !== "durably-committed") throw unavailable();
      const verified = await read();
      if (JSON.stringify(verified) !== JSON.stringify(value)) throw unavailable();
    } finally {
      encrypted.fill(0);
    }
  };
  const initializeLocked = async (proof: CredentialEnvelopeLockProof): Promise<void> => {
    await migrateDesktopOAuthProfiles(
      join(options.configDir, "auth-profiles.json"),
      [
        ...new Set([
          DESKTOP_OAUTH_PROFILE_NAME,
          options.selectedProfile ?? DESKTOP_OAUTH_PROFILE_NAME,
        ]),
      ],
      async (legacy, owned) => {
        if (owned) return;
        const existing = await read();
        if (existing !== undefined) {
          for (const [name, entry] of Object.entries(legacy)) {
            const migrated = Object.hasOwn(existing.profiles, name)
              ? existing.profiles[name]
              : undefined;
            if (
              migrated?.legacyRevision !== entry.revision ||
              JSON.stringify(migrated.profile) !==
                JSON.stringify(parseDesktopOAuthCredential(entry.profile))
            )
              throw unavailable();
          }
          return;
        }
        if (Object.keys(legacy).length === 0) return;
        const profiles = Object.fromEntries(
          Object.entries(legacy).map(([name, entry]) => [
            name,
            {
              revision: randomUUID(),
              legacyRevision: entry.revision,
              profile: parseDesktopOAuthCredential(entry.profile),
            },
          ]),
        );
        await write({ schemaVersion: 1, home: options.configDir, profiles }, proof);
      },
    );
  };
  const exclusive = <T>(
    operation: (proof: CredentialEnvelopeLockProof) => Promise<T>,
  ): Promise<T> =>
    options.serializeEnvelopeMutation(async (proof) => {
      try {
        return await operation(proof);
      } catch (error) {
        if (
          record(error) &&
          (error.refreshFailureReason === "reauth" ||
            error.refreshFailureReason === "rate_limit" ||
            error.refreshFailureReason === "server_error" ||
            error.refreshFailureReason === "network" ||
            error.refreshFailureReason === "unknown")
        ) {
          throw new TokenRefreshError(error.refreshFailureReason);
        }
        throw unavailable();
      }
    });
  const profileAt = (
    envelope: OAuthEnvelope | undefined,
    name: string,
  ): EncryptedOAuthProfile | undefined =>
    envelope !== undefined && Object.hasOwn(envelope.profiles, name)
      ? envelope.profiles[name]
      : undefined;
  return {
    initialize: () => exclusive(initializeLocked),
    recoveryRequired: () =>
      exclusive(async (proof) => {
        await initializeLocked(proof);
        await read();
        return false;
      }).catch(() => true),
    hasProfile: (name) =>
      exclusive(async (proof) => {
        await initializeLocked(proof);
        return profileAt(await read(), name) !== undefined;
      }).catch(() => false),
    writeProfile: (credentials) =>
      exclusive(async (proof) => {
        await initializeLocked(proof);
        const current = await read();
        await write(
          {
            schemaVersion: 1,
            home: options.configDir,
            profiles: {
              ...current?.profiles,
              [DESKTOP_OAUTH_PROFILE_NAME]: {
                revision: randomUUID(),
                legacyRevision: null,
                profile: parseDesktopOAuthCredential({ type: "oauth", ...credentials }),
              },
            },
          },
          proof,
        );
      }),
    getAccessToken: (name, signal, rejectedAccessToken) =>
      exclusive(async (proof) => {
        signal?.throwIfAborted();
        await initializeLocked(proof);
        const envelope = await read();
        const current = profileAt(envelope, name);
        if (envelope === undefined || current === undefined) throw unavailable();
        const profile = current.profile;
        if (profile.expires > (options.now ?? Date.now)() && profile.access !== rejectedAccessToken)
          return profile.access;
        const refreshed = await refreshToken(profile.refresh, signal);
        signal?.throwIfAborted();
        const latest = profileAt(await read(), name);
        if (latest?.revision !== current.revision) throw unavailable();
        const next = parseDesktopOAuthCredential({ ...profile, ...refreshed, type: "oauth" });
        await write(
          {
            ...envelope,
            profiles: {
              ...envelope.profiles,
              [name]: { revision: randomUUID(), legacyRevision: null, profile: next },
            },
          },
          proof,
        );
        return next.access;
      }),
    deleteProfile: (name) =>
      exclusive(async (proof) => {
        await initializeLocked(proof);
        const current = await read();
        if (current === undefined || !Object.hasOwn(current.profiles, name)) return;
        const profiles = { ...current.profiles };
        delete profiles[name];
        if (Object.keys(profiles).length > 0) {
          await write({ ...current, profiles }, proof);
          return;
        }
        if (!(await options.revalidateEnvelopeRemoval(proof))) throw unavailable();
        await rm(path, { force: true });
        if (platform !== "win32") await syncDirectory(options.root);
        await options.observeEnvelopeRemoved(proof);
      }),
  };
}
