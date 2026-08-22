import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AthleteHomeIdentitySchema,
  TelegramBotIdSchema,
  TelegramBotUsernameSchema,
  TelegramCredentialSchema,
  type AthleteHomeIdentity,
  type TelegramBotId,
  type TelegramBotUsername,
  type TelegramCredential,
} from "@enduragent/coach-contract";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import type { CredentialEncryptionPort } from "./credential-vault.js";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import {
  durablyReplaceReversible,
  type ReversibleDurableReplaceOutcome,
} from "./durable-atomic-replace.js";
import {
  emitTelegramSecureStorageFailure,
  type TelegramSecureStorageObserver,
  type TelegramSecureStorageStage,
} from "./telegram-secure-storage-diagnostics.js";
import {
  assertWindowsPrivateFileAtPath,
  MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
  readWindowsPrivateFile,
} from "./windows-private-file.js";

export const TELEGRAM_CREDENTIAL_DIRECTORY_NAME = "telegram-channel-v1" as const;
export const TELEGRAM_PROFILE_FILE_NAME = "profile.bin" as const;
export const TELEGRAM_DESIRED_STATE_FILE_NAME = "desired-state.json" as const;
export const TELEGRAM_CREDENTIAL_DIRECTORY_MODE = 0o700;
export const TELEGRAM_CREDENTIAL_FILE_MODE = 0o600;

const UNSAFE_STORAGE_BACKEND = "basic_text";

export interface TelegramProfileRecord {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly athleteHome: AthleteHomeIdentity;
  readonly token: TelegramCredential;
  readonly bot: Readonly<{ id: TelegramBotId; username: TelegramBotUsername }>;
}

export type TelegramProfileRePromptReason =
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed";

export type TelegramProfileStatus =
  | Readonly<{
      state: "configured";
      profileId: string;
      bot: TelegramProfileRecord["bot"];
    }>
  | Readonly<{ state: "re-prompt"; reason: TelegramProfileRePromptReason }>
  | Readonly<{ state: "missing" | "wrong-home" | "uncertain" }>;

export type TelegramProfileReplaceResult =
  | Readonly<{
      outcome: "applied";
      profileId: string;
      bot: TelegramProfileRecord["bot"];
    }>
  | Readonly<{
      outcome: "refused";
      reason:
        | "invalid-input"
        | "wrong-home"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed";
    }>
  | Readonly<{ outcome: "uncertain"; reason: "storage-uncertain" }>;

export type TelegramProfileApplyResult =
  | Readonly<{
      outcome: "applied";
      profileId: string;
      bot: TelegramProfileRecord["bot"];
    }>
  | Readonly<{
      outcome: "refused";
      reason:
        | "missing"
        | "wrong-home"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "re-prompt"
        | "runtime-unavailable";
    }>
  | Readonly<{ outcome: "uncertain"; reason: "storage-uncertain" }>;

export type TelegramProfileDeleteResult =
  | Readonly<{ outcome: "applied"; cleanupPending: boolean }>
  | Readonly<{
      outcome: "refused";
      reason:
        | "not-found"
        | "wrong-home"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed";
    }>
  | Readonly<{ outcome: "uncertain"; reason: "storage-uncertain" }>;

export type TelegramDesiredState =
  | Readonly<{ state: "configured"; enabled: boolean }>
  | Readonly<{ state: "missing" | "re-prompt" | "wrong-home" | "uncertain"; enabled: false }>;

export type TelegramDesiredStateWriteResult =
  | Readonly<{ status: "stored"; enabled: boolean }>
  | Readonly<{ status: "refused"; reason: "invalid-input" | "storage-failed" }>
  | Readonly<{ status: "uncertain"; reason: "storage-uncertain" }>;

export interface TelegramCredentialVault {
  profileStatus(): Promise<TelegramProfileStatus>;
  replaceProfile(input: {
    readonly token: string;
    readonly bot: Readonly<{ id: TelegramBotId; username: TelegramBotUsername }>;
    readonly authenticatedAthleteHome: AthleteHomeIdentity;
  }): Promise<TelegramProfileReplaceResult>;
  applyStoredProfile(
    authenticatedAthleteHome: AthleteHomeIdentity,
    applyProfile: (profile: TelegramProfileRecord) => Promise<void>,
  ): Promise<TelegramProfileApplyResult>;
  deleteProfile(): Promise<TelegramProfileDeleteResult>;
  desiredState(): Promise<TelegramDesiredState>;
  setDesiredState(enabled: boolean): Promise<TelegramDesiredStateWriteResult>;
}

export interface TelegramCredentialVaultOptions {
  readonly root: string;
  readonly athleteHome: AthleteHomeIdentity;
  readonly encryption: CredentialEncryptionPort;
  readonly createId?: () => string;
  readonly createProfileId?: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
  readonly syncParentDirectory?: (root: string) => Promise<void>;
  readonly observeSecureStorageFailure?: TelegramSecureStorageObserver;
  readonly serializeEnvelopeMutation?: SerializeCredentialEnvelopeMutation;
  readonly prepareEnvelopeWrite?: (proof: CredentialEnvelopeLockProof) => Promise<void>;
  readonly observeEnvelopeRemoved?: (proof: CredentialEnvelopeLockProof) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly openFile?: typeof open;
}

interface TelegramDesiredStateRecord {
  readonly schemaVersion: 1;
  readonly athleteHome: AthleteHomeIdentity;
  readonly enabled: boolean;
}

type EncryptionRefusal = "encryption-unavailable" | "unsafe-backend";

type ReadProfile =
  | { readonly state: "configured"; readonly profile: TelegramProfileRecord }
  | { readonly state: "missing" }
  | { readonly state: "wrong-home" }
  | {
      readonly state: "re-prompt";
      readonly reason: EncryptionRefusal | "decrypt-failed" | "storage-failed";
    };

type TargetState = "missing" | "valid" | "unsafe";

type NamespaceVerification = "pending" | "verified" | "uncertain";

function permissions(mode: number): number {
  return mode & 0o777;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isOwnedTransientArtifact(entry: string): boolean {
  for (const fileName of [TELEGRAM_PROFILE_FILE_NAME, TELEGRAM_DESIRED_STATE_FILE_NAME]) {
    const prefix = `.${fileName}.`;
    for (const suffix of [".tmp", ".deleted"]) {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
      const id = entry.slice(prefix.length, -suffix.length);
      if (/^[A-Za-z0-9-]{1,128}$/.test(id)) return true;
    }
  }
  return false;
}

function parseAthleteHome(value: unknown): AthleteHomeIdentity | undefined {
  const parsed = AthleteHomeIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseToken(value: unknown): TelegramCredential | undefined {
  const parsed = TelegramCredentialSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseBotId(value: unknown): TelegramBotId | undefined {
  const parsed = TelegramBotIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseBotUsername(value: unknown): TelegramBotUsername | undefined {
  const parsed = TelegramBotUsernameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseProfileId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function parseProfileRecord(value: string): TelegramProfileRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["athleteHome", "bot", "profileId", "schemaVersion", "token"])) {
    return undefined;
  }
  if (record.bot === null || typeof record.bot !== "object" || Array.isArray(record.bot)) {
    return undefined;
  }
  const rawBot = record.bot as Record<string, unknown>;
  if (!exactKeys(rawBot, ["id", "username"])) return undefined;
  const profileId = parseProfileId(record.profileId);
  const athleteHome = parseAthleteHome(record.athleteHome);
  const token = parseToken(record.token);
  const id = parseBotId(rawBot.id);
  const username = parseBotUsername(rawBot.username);
  if (
    record.schemaVersion !== 1 ||
    profileId === undefined ||
    athleteHome === undefined ||
    token === undefined ||
    id === undefined ||
    username === undefined
  ) {
    return undefined;
  }
  return { schemaVersion: 1, profileId, athleteHome, token, bot: { id, username } };
}

function parseDesiredStateRecord(value: string): TelegramDesiredStateRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!exactKeys(record, ["athleteHome", "enabled", "schemaVersion"])) return undefined;
  const athleteHome = parseAthleteHome(record.athleteHome);
  if (
    record.schemaVersion !== 1 ||
    athleteHome === undefined ||
    typeof record.enabled !== "boolean"
  ) {
    return undefined;
  }
  return { schemaVersion: 1, athleteHome, enabled: record.enabled };
}

function encryptionRefusal(
  encryption: CredentialEncryptionPort,
  platform: NodeJS.Platform,
): EncryptionRefusal | undefined {
  try {
    if (!encryption.isEncryptionAvailable()) return "encryption-unavailable";
    if (
      platform !== "win32" &&
      encryption.getSelectedStorageBackend?.() === UNSAFE_STORAGE_BACKEND
    ) {
      return "unsafe-backend";
    }
    return undefined;
  } catch {
    return "encryption-unavailable";
  }
}

async function secureDirectoryState(
  root: string,
  platform: NodeJS.Platform,
  bindWindowsDirectory: () => WindowsPrivateDirectoryBinding,
): Promise<"missing" | "secure" | "unsafe"> {
  try {
    const entry = await lstat(root);
    if (platform === "win32") {
      bindWindowsDirectory();
      return "secure";
    }
    return entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      permissions(entry.mode) === TELEGRAM_CREDENTIAL_DIRECTORY_MODE
      ? "secure"
      : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

async function ensureSecureDirectory(
  root: string,
  platform: NodeJS.Platform,
  bindWindowsDirectory: () => WindowsPrivateDirectoryBinding,
): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    return (await secureDirectoryState(root, platform, bindWindowsDirectory)) === "secure";
  } catch {
    return false;
  }
}

async function targetState(
  path: string,
  platform: NodeJS.Platform,
  windowsDirectory: WindowsPrivateDirectoryBinding | undefined,
): Promise<TargetState> {
  try {
    const entry = await lstat(path);
    if (platform === "win32") {
      assertWindowsPrivateFileAtPath(
        windowsDirectory!,
        path,
        entry,
        1,
        MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
      );
      return "valid";
    }
    return entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.size > 0 &&
      permissions(entry.mode) === TELEGRAM_CREDENTIAL_FILE_MODE
      ? "valid"
      : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

async function syncDirectory(root: string): Promise<void> {
  const directory = await open(root, "r");
  try {
    await directory.sync();
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
  await directory.close().catch(() => undefined);
}

export function createTelegramCredentialVault(
  options: TelegramCredentialVaultOptions,
): TelegramCredentialVault {
  if (
    options.serializeEnvelopeMutation === undefined &&
    (options.prepareEnvelopeWrite !== undefined || options.observeEnvelopeRemoved !== undefined)
  ) {
    throw new TypeError();
  }
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("invalid Telegram credential vault root");
  }
  const platform = options.platform ?? process.platform;
  const athleteHome = AthleteHomeIdentitySchema.parse(options.athleteHome);
  const createId = options.createId ?? randomUUID;
  const createProfileId = options.createProfileId ?? randomUUID;
  const renameFile = options.renameFile ?? rename;
  const removeFile = options.removeFile ?? rm;
  const rawSync = options.syncDirectory ?? syncDirectory;
  const rawSyncParent = options.syncParentDirectory ?? syncDirectory;
  const sync = async (root: string): Promise<void> => {
    if (
      platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSync(root);
  };
  const syncParent = async (root: string): Promise<void> => {
    if (
      platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSyncParent(root);
  };
  let operationQueue = Promise.resolve();
  let namespaceVerification: NamespaceVerification = "pending";
  let transientArtifactsMayExist = false;
  let profileUncertain = false;
  let desiredStateUncertain = false;
  let parentDirectoryVerified = false;
  let windowsDirectory: WindowsPrivateDirectoryBinding | undefined;

  const bindCredentialDirectory = (): WindowsPrivateDirectoryBinding => {
    if (windowsDirectory === undefined) {
      windowsDirectory = bindWindowsPrivateDirectory(dirname(options.root), options.root);
    } else {
      assertWindowsPrivateDirectoryStable(windowsDirectory);
    }
    return windowsDirectory;
  };

  const observeFailure = (
    stage: TelegramSecureStorageStage,
    reason: EncryptionRefusal | "storage-failed" | "storage-uncertain",
  ): void => {
    emitTelegramSecureStorageFailure(options.observeSecureStorageFailure, { stage, reason });
  };

  const observedEncryptionRefusal = (): EncryptionRefusal | undefined => {
    const reason = encryptionRefusal(options.encryption, platform);
    if (reason !== undefined) observeFailure("encryption-availability", reason);
    return reason;
  };

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const envelopeExclusive = <T>(
    operation: (proof: CredentialEnvelopeLockProof | undefined) => Promise<T>,
  ): Promise<T> =>
    options.serializeEnvelopeMutation === undefined
      ? exclusive(() => operation(undefined))
      : options.serializeEnvelopeMutation((proof) => exclusive(() => operation(proof)));

  const reconcileOwnedTransients = async (forceSync: boolean): Promise<boolean> => {
    const directory = await secureDirectoryState(options.root, platform, bindCredentialDirectory);
    if (directory !== "secure") return true;
    let entries: readonly string[];
    try {
      entries = await readdir(options.root);
    } catch {
      return false;
    }
    const ownedTransients = entries.filter(isOwnedTransientArtifact);
    for (const entry of ownedTransients) {
      try {
        await removeFile(join(options.root, entry), { force: true });
      } catch {
        return false;
      }
    }
    if (forceSync || ownedTransients.length > 0) {
      try {
        await sync(options.root);
      } catch {
        return false;
      }
    }
    transientArtifactsMayExist = false;
    return true;
  };

  const prepareNamespace = async (): Promise<boolean> => {
    if (namespaceVerification === "uncertain") return false;
    if (namespaceVerification === "pending") {
      if (!(await reconcileOwnedTransients(true))) {
        namespaceVerification = "uncertain";
        observeFailure("namespace", "storage-uncertain");
        return false;
      }
      namespaceVerification = "verified";
    }
    if (transientArtifactsMayExist && !(await reconcileOwnedTransients(false))) {
      namespaceVerification = "uncertain";
      observeFailure("namespace", "storage-uncertain");
      return false;
    }
    return true;
  };

  const readProfile = async (): Promise<ReadProfile> => {
    const directory = await secureDirectoryState(options.root, platform, bindCredentialDirectory);
    if (directory === "missing") return { state: "missing" };
    if (directory === "unsafe") {
      observeFailure("namespace", "storage-failed");
      return { state: "re-prompt", reason: "storage-failed" };
    }
    const path = join(options.root, TELEGRAM_PROFILE_FILE_NAME);
    const file = await targetState(path, platform, windowsDirectory);
    if (file === "missing") return { state: "missing" };
    if (file === "unsafe") {
      observeFailure("profile-atomic-write", "storage-failed");
      return { state: "re-prompt", reason: "storage-failed" };
    }
    const encryptionFailure = observedEncryptionRefusal();
    if (encryptionFailure !== undefined) {
      return { state: "re-prompt", reason: encryptionFailure };
    }
    let encrypted: Buffer | undefined;
    try {
      if (platform === "win32") {
        const snapshot = await readWindowsPrivateFile({
          directory: bindCredentialDirectory(),
          path,
          minimumBytes: 1,
          maximumBytes: MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
          openFile: options.openFile,
        });
        if (snapshot === undefined) throw new TypeError();
        encrypted = snapshot.contents;
      } else {
        encrypted = await readFile(path);
      }
    } catch {
      observeFailure("profile-atomic-write", "storage-failed");
      return { state: "re-prompt", reason: "storage-failed" };
    }
    try {
      const profile = parseProfileRecord(options.encryption.decryptString(encrypted));
      if (profile === undefined) {
        if (platform === "win32") {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        observeFailure("encryption-availability", "storage-failed");
        return { state: "re-prompt", reason: "decrypt-failed" };
      }
      if (profile.athleteHome !== athleteHome) return { state: "wrong-home" };
      return { state: "configured", profile };
    } catch {
      observeFailure("encryption-availability", "storage-failed");
      return { state: "re-prompt", reason: "decrypt-failed" };
    } finally {
      encrypted?.fill(0);
    }
  };

  const readDesiredState = async (): Promise<TelegramDesiredState> => {
    const directory = await secureDirectoryState(options.root, platform, bindCredentialDirectory);
    if (directory === "missing") return { state: "missing", enabled: false };
    if (directory === "unsafe") {
      observeFailure("namespace", "storage-failed");
      return { state: "re-prompt", enabled: false };
    }
    const path = join(options.root, TELEGRAM_DESIRED_STATE_FILE_NAME);
    const file = await targetState(path, platform, windowsDirectory);
    if (file === "missing") return { state: "missing", enabled: false };
    if (file === "unsafe") {
      observeFailure("desired-state-write", "storage-failed");
      return { state: "re-prompt", enabled: false };
    }
    let contents: Buffer | undefined;
    try {
      let serialized: string;
      if (platform === "win32") {
        contents = (
          await readWindowsPrivateFile({
            directory: bindCredentialDirectory(),
            path,
            minimumBytes: 1,
            maximumBytes: MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
            openFile: options.openFile,
          })
        )?.contents;
        serialized = contents?.toString("utf8") ?? "";
      } else {
        serialized = await readFile(path, "utf8");
      }
      const record = parseDesiredStateRecord(serialized);
      if (record === undefined) {
        if (platform === "win32") {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        observeFailure("desired-state-write", "storage-failed");
        return { state: "re-prompt", enabled: false };
      }
      if (record.athleteHome !== athleteHome) return { state: "wrong-home", enabled: false };
      return { state: "configured", enabled: record.enabled };
    } catch {
      observeFailure("desired-state-write", "storage-failed");
      return { state: "re-prompt", enabled: false };
    } finally {
      contents?.fill(0);
    }
  };

  const writeReversible = async (
    fileName: string,
    candidate: Buffer,
    stage: Extract<TelegramSecureStorageStage, "profile-atomic-write" | "desired-state-write">,
  ): Promise<ReversibleDurableReplaceOutcome> => {
    if (!(await ensureSecureDirectory(options.root, platform, bindCredentialDirectory))) {
      observeFailure("namespace", "storage-failed");
      return { state: "refused" };
    }
    if (!parentDirectoryVerified) {
      try {
        await syncParent(dirname(options.root));
        parentDirectoryVerified = true;
      } catch {
        observeFailure("namespace", "storage-failed");
        return { state: "refused" };
      }
    }
    const target = join(options.root, fileName);
    const state = await targetState(target, platform, windowsDirectory);
    if (state === "unsafe") {
      observeFailure(stage, "storage-failed");
      return { state: "refused" };
    }
    let previous: Buffer | undefined;
    try {
      if (platform === "win32") {
        assertWindowsPrivatePathRead({
          bounded: candidate.length <= MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
          identityStable: true,
          contentValid: candidate.length > 0,
          authenticatedHomeBinding: true,
        });
      }
      if (state === "valid") {
        previous =
          platform === "win32"
            ? (
                await readWindowsPrivateFile({
                  directory: bindCredentialDirectory(),
                  path: target,
                  minimumBytes: 1,
                  maximumBytes: MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
                  openFile: options.openFile,
                })
              )?.contents
            : await readFile(target);
        if (previous === undefined) throw new TypeError();
      }
      transientArtifactsMayExist = true;
      const stored = await durablyReplaceReversible({
        root: options.root,
        fileName,
        contents: candidate,
        previousContents: previous,
        mode: TELEGRAM_CREDENTIAL_FILE_MODE,
        createId,
        renameFile,
        removeFile,
        syncDirectory: sync,
        platform,
      });
      if (stored.state !== "applied") {
        observeFailure(
          stage,
          stored.state === "uncertain" ? "storage-uncertain" : "storage-failed",
        );
      }
      return stored;
    } catch {
      observeFailure(stage, "storage-failed");
      return { state: "refused" };
    } finally {
      previous?.fill(0);
    }
  };

  const removeStoredProfile = async (): Promise<
    "deleted" | "cleanup-pending" | "retained" | "uncertain"
  > => {
    if (
      (await secureDirectoryState(options.root, platform, bindCredentialDirectory)) !== "secure"
    ) {
      return "retained";
    }
    const target = join(options.root, TELEGRAM_PROFILE_FILE_NAME);
    if ((await targetState(target, platform, windowsDirectory)) !== "valid") return "retained";
    let id: string;
    try {
      id = createId();
    } catch {
      return "retained";
    }
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) return "retained";
    const tombstone = join(options.root, `.${TELEGRAM_PROFILE_FILE_NAME}.${id}.deleted`);
    try {
      await renameFile(target, tombstone);
      transientArtifactsMayExist = true;
    } catch {
      return "retained";
    }
    try {
      await sync(options.root);
    } catch {
      try {
        await renameFile(tombstone, target);
        await sync(options.root);
        return "retained";
      } catch {
        return "uncertain";
      }
    }
    try {
      await removeFile(tombstone, { force: true });
      await sync(options.root);
      return "deleted";
    } catch {
      return "cleanup-pending";
    }
  };

  return {
    profileStatus(): Promise<TelegramProfileStatus> {
      return exclusive(async () => {
        if (!(await prepareNamespace())) return { state: "uncertain" };
        if (profileUncertain) return { state: "uncertain" };
        const profile = await readProfile();
        if (profile.state === "configured") {
          return {
            state: "configured",
            profileId: profile.profile.profileId,
            bot: profile.profile.bot,
          };
        }
        if (profile.state === "re-prompt") {
          return {
            state: "re-prompt",
            reason:
              profile.reason === "encryption-unavailable" || profile.reason === "unsafe-backend"
                ? profile.reason
                : "storage-failed",
          };
        }
        return { state: profile.state };
      });
    },

    replaceProfile(input): Promise<TelegramProfileReplaceResult> {
      return envelopeExclusive(async (proof) => {
        if (proof !== undefined) await options.prepareEnvelopeWrite?.(proof);
        const authenticatedAthleteHome = parseAthleteHome(input?.authenticatedAthleteHome);
        if (authenticatedAthleteHome === undefined || authenticatedAthleteHome !== athleteHome) {
          return { outcome: "refused", reason: "wrong-home" };
        }
        const token = parseToken(input?.token);
        const id = parseBotId(input?.bot?.id);
        const username = parseBotUsername(input?.bot?.username);
        if (token === undefined || id === undefined || username === undefined) {
          return { outcome: "refused", reason: "invalid-input" };
        }
        const encryptionFailure = observedEncryptionRefusal();
        if (encryptionFailure !== undefined) {
          return { outcome: "refused", reason: encryptionFailure };
        }
        if (!(await prepareNamespace())) {
          profileUncertain = true;
          return { outcome: "uncertain", reason: "storage-uncertain" };
        }
        let profileId: string | undefined;
        try {
          profileId = parseProfileId(createProfileId());
        } catch {
          return { outcome: "refused", reason: "storage-failed" };
        }
        if (profileId === undefined) return { outcome: "refused", reason: "storage-failed" };
        const bot = { id, username } as const;
        const profile: TelegramProfileRecord = {
          schemaVersion: 1,
          profileId,
          athleteHome,
          token,
          bot,
        };
        let encrypted: Buffer | undefined;
        let plaintext: Buffer | undefined;
        let tokenPlaintext: Buffer | undefined;
        try {
          const serialized = JSON.stringify(profile);
          encrypted = options.encryption.encryptString(serialized);
          if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new TypeError();
          if (platform === "win32") {
            plaintext = Buffer.from(serialized, "utf8");
            tokenPlaintext = Buffer.from(token, "utf8");
            assertWindowsPrivatePathRead({
              bounded: true,
              identityStable: true,
              contentValid: !encrypted.includes(plaintext) && !encrypted.includes(tokenPlaintext),
              authenticatedHomeBinding: true,
            });
          }
        } catch {
          encrypted?.fill(0);
          plaintext?.fill(0);
          tokenPlaintext?.fill(0);
          observeFailure("encryption-availability", "storage-failed");
          return { outcome: "refused", reason: "storage-failed" };
        }
        try {
          const stored = await writeReversible(
            TELEGRAM_PROFILE_FILE_NAME,
            encrypted,
            "profile-atomic-write",
          );
          profileUncertain = stored.state === "uncertain";
          if (stored.state === "applied") {
            return { outcome: "applied", profileId, bot };
          }
          return stored.state === "refused"
            ? { outcome: "refused", reason: "storage-failed" }
            : { outcome: "uncertain", reason: "storage-uncertain" };
        } catch {
          observeFailure("profile-atomic-write", "storage-failed");
          return { outcome: "refused", reason: "storage-failed" };
        } finally {
          encrypted?.fill(0);
          plaintext?.fill(0);
          tokenPlaintext?.fill(0);
        }
      });
    },

    applyStoredProfile(
      authenticatedAthleteHome,
      applyProfile,
    ): Promise<TelegramProfileApplyResult> {
      return exclusive(async () => {
        if (!(await prepareNamespace())) {
          return { outcome: "uncertain", reason: "storage-uncertain" };
        }
        if (profileUncertain) return { outcome: "uncertain", reason: "storage-uncertain" };
        const authenticated = parseAthleteHome(authenticatedAthleteHome);
        if (authenticated === undefined || authenticated !== athleteHome) {
          return { outcome: "refused", reason: "wrong-home" };
        }
        const profile = await readProfile();
        if (profile.state === "missing") return { outcome: "refused", reason: "missing" };
        if (profile.state === "wrong-home") {
          return { outcome: "refused", reason: "wrong-home" };
        }
        if (profile.state === "re-prompt") {
          return {
            outcome: "refused",
            reason:
              profile.reason === "encryption-unavailable" || profile.reason === "unsafe-backend"
                ? profile.reason
                : "re-prompt",
          };
        }
        if (typeof applyProfile !== "function") {
          return { outcome: "refused", reason: "runtime-unavailable" };
        }
        try {
          await applyProfile(profile.profile);
          return {
            outcome: "applied",
            profileId: profile.profile.profileId,
            bot: profile.profile.bot,
          };
        } catch {
          return { outcome: "refused", reason: "runtime-unavailable" };
        }
      });
    },

    deleteProfile(): Promise<TelegramProfileDeleteResult> {
      return envelopeExclusive(async (proof) => {
        if (!(await prepareNamespace())) {
          return { outcome: "uncertain", reason: "storage-uncertain" };
        }
        if (profileUncertain) return { outcome: "uncertain", reason: "storage-uncertain" };
        const profile = await readProfile();
        if (profile.state === "missing") return { outcome: "refused", reason: "not-found" };
        if (profile.state === "wrong-home") {
          return { outcome: "refused", reason: "wrong-home" };
        }
        if (profile.state === "re-prompt") {
          if (profile.reason === "encryption-unavailable" || profile.reason === "unsafe-backend") {
            return { outcome: "refused", reason: profile.reason };
          }
          return { outcome: "refused", reason: "storage-failed" };
        }
        const removed = await removeStoredProfile();
        if (removed === "deleted" || removed === "cleanup-pending") {
          if (proof !== undefined) {
            try {
              await options.observeEnvelopeRemoved?.(proof);
            } catch {}
          }
          return { outcome: "applied", cleanupPending: removed === "cleanup-pending" };
        }
        if (removed === "uncertain") profileUncertain = true;
        observeFailure(
          "profile-atomic-write",
          removed === "uncertain" ? "storage-uncertain" : "storage-failed",
        );
        return removed === "uncertain"
          ? { outcome: "uncertain", reason: "storage-uncertain" }
          : { outcome: "refused", reason: "storage-failed" };
      });
    },

    desiredState(): Promise<TelegramDesiredState> {
      return exclusive(async () => {
        if (!(await prepareNamespace()) || desiredStateUncertain) {
          return { state: "uncertain", enabled: false };
        }
        return await readDesiredState();
      });
    },

    setDesiredState(enabled): Promise<TelegramDesiredStateWriteResult> {
      return exclusive(async () => {
        if (typeof enabled !== "boolean") {
          return { status: "refused", reason: "invalid-input" };
        }
        if (!(await prepareNamespace())) {
          desiredStateUncertain = true;
          return { status: "uncertain", reason: "storage-uncertain" };
        }
        const candidate = Buffer.from(
          `${JSON.stringify({ schemaVersion: 1, athleteHome, enabled })}\n`,
          "utf8",
        );
        try {
          const stored = await writeReversible(
            TELEGRAM_DESIRED_STATE_FILE_NAME,
            candidate,
            "desired-state-write",
          );
          desiredStateUncertain = stored.state === "uncertain";
          if (stored.state === "applied") return { status: "stored", enabled };
          return stored.state === "refused"
            ? { status: "refused", reason: "storage-failed" }
            : { status: "uncertain", reason: "storage-uncertain" };
        } catch {
          observeFailure("desired-state-write", "storage-failed");
          return { status: "refused", reason: "storage-failed" };
        } finally {
          candidate.fill(0);
        }
      });
    },
  };
}
