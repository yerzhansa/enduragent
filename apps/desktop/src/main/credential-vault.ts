import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  isKeylessProvider,
  type ConfigureRuntimeRpcRefusalReason,
} from "@enduragent/coach-contract";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  WindowsPrivatePathPolicyError,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import {
  parseOnboardingLlmSelection,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "./llm-selection.js";
import { durablyReplaceReversible } from "./durable-atomic-replace.js";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
  SerializeCredentialMutation,
} from "./credential-envelope-lock.js";
import {
  assertWindowsPrivateFileAtPath,
  MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
  readWindowsPrivateFile,
} from "./windows-private-file.js";

export const DESKTOP_CREDENTIAL_SLOTS = [
  "anthropic",
  "openrouter",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "intervals-icu",
] as const;

export type DesktopCredentialSlot = (typeof DESKTOP_CREDENTIAL_SLOTS)[number];
export type CredentialState = "missing" | "configured" | "re-prompt";
export type CredentialRuntimeState = "active" | "stored-inactive" | "failed";
export type CredentialRuntimeStateMap = Map<DesktopCredentialSlot, CredentialRuntimeState>;

export interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

export type CredentialWriteResult =
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "configured";
      readonly runtimeReady: boolean;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "refused";
      readonly reason:
        | "invalid-input"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed"
        | "runtime-unavailable"
        | "training-account-mismatch";
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "uncertain";
      readonly reason: "storage-uncertain";
    };

export type CredentialDeleteResult =
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "deleted";
      readonly cleanupPending: boolean;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "managed-by-environment"
        | "storage-failed"
        | "runtime-unavailable"
        | "runtime-state-diverged";
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "uncertain";
      readonly reason: "storage-uncertain";
    };

export interface CredentialWriteInput {
  readonly slot: DesktopCredentialSlot;
  readonly value: string;
  readonly selection?: OnboardingLlmSelection;
}

export interface CredentialWriteBehavior {
  readonly activate?: boolean;
  readonly rollbackOnRuntimeRefusal?: boolean;
  readonly verificationApproval?: string;
}

export interface CredentialVaultMutation {
  writeCredential(
    input: CredentialWriteInput,
    behavior?: CredentialWriteBehavior,
  ): Promise<CredentialWriteResult>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
}

export class CredentialRuntimeRefusal extends Error {
  constructor(readonly reason: ConfigureRuntimeRpcRefusalReason) {
    super();
  }
}

export const CREDENTIAL_DIRECTORY_NAME = "credentials-v1" as const;
export const CREDENTIAL_DIRECTORY_MODE = 0o700;
export const CREDENTIAL_FILE_MODE = 0o600;
export const UNSAFE_STORAGE_BACKEND = "basic_text" as const;

export interface CredentialEncryptionPort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?: () => string;
}

export interface CredentialVault {
  writeCredential(
    input: CredentialWriteInput,
    behavior?: CredentialWriteBehavior,
  ): Promise<CredentialWriteResult>;
  runExclusiveMutation<T>(operation: (mutation: CredentialVaultMutation) => Promise<T>): Promise<T>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  deleteCredential(slot: DesktopCredentialSlot): Promise<CredentialDeleteResult>;
  reapplyConfigured(): Promise<void>;
  retryFailed(): Promise<void>;
}

interface CredentialVaultOptions {
  readonly root: string;
  readonly encryption: CredentialEncryptionPort;
  readonly runtimeState?: CredentialRuntimeStateMap;
  readonly onRuntimeStateChange?: (slot: DesktopCredentialSlot) => void;
  readonly createRuntimePublicationGuard?: (slot: DesktopCredentialSlot) => () => boolean;
  readonly applyCredential: (
    slot: DesktopCredentialSlot,
    value: string,
    selection?: OnboardingLlmSelection,
    verificationApproval?: string,
  ) => Promise<void>;
  readonly reapplyCredential?: (
    slot: DesktopCredentialSlot,
    value: string,
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ) => Promise<Exclude<CredentialRuntimeState, "failed">>;
  readonly clearCredential?: (
    slot: DesktopCredentialSlot,
  ) => Promise<"cleared" | "not-active" | "managed-by-environment">;
  readonly serializeCredentialMutation?: SerializeCredentialMutation;
  readonly serializeEnvelopeMutation?: SerializeCredentialEnvelopeMutation;
  readonly prepareEnvelopeWrite?: (proof: CredentialEnvelopeLockProof) => Promise<void>;
  readonly observeEnvelopeRemoved?: (proof: CredentialEnvelopeLockProof) => Promise<void>;
  readonly renameCredentialFile?: typeof rename;
  readonly removeCredentialFile?: typeof rm;
  readonly readCredentialFile?: typeof readFile;
  readonly openCredentialFile?: typeof open;
  readonly openCredentialDirectory?: typeof open;
  readonly syncCredentialDirectory?: (root: string) => Promise<void>;
  readonly syncCredentialParentDirectory?: (root: string) => Promise<void>;
  readonly createId?: () => string;
  readonly platform?: NodeJS.Platform;
}

export function replaceCredentialRuntimeStates(
  target: CredentialRuntimeStateMap,
  statuses: readonly CredentialSlotStatus[],
  shouldReplace: (slot: DesktopCredentialSlot) => boolean = () => true,
): void {
  for (const status of statuses) {
    if (!shouldReplace(status.slot)) {
      target.set(status.slot, "failed");
      continue;
    }
    if (status.state === "configured" && status.runtimeState !== null) {
      target.set(status.slot, status.runtimeState);
    } else {
      target.delete(status.slot);
    }
  }
}

export function markUnselectedModelCredentialsInactive(
  target: CredentialRuntimeStateMap,
  selected: DesktopCredentialSlot | undefined,
  onChange: (slot: DesktopCredentialSlot) => void = () => {},
): void {
  for (const slot of target.keys()) {
    if (slot === "intervals-icu" || slot === selected || target.get(slot) === "stored-inactive") {
      continue;
    }
    target.set(slot, "stored-inactive");
    onChange(slot);
  }
}

interface ReadCredential {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly value?: string;
  readonly modifiedAt: number;
}

type CredentialVaultDurabilityState = "pending" | "verified" | "unsafe" | "uncertain";

type CredentialEncryptionRefusal = "encryption-unavailable" | "unsafe-backend";

function isCredentialSlot(value: unknown): value is DesktopCredentialSlot {
  return (
    typeof value === "string" && (DESKTOP_CREDENTIAL_SLOTS as readonly string[]).includes(value)
  );
}

function permissions(mode: number): number {
  return mode & 0o777;
}

function encryptionRefusal(
  encryption: CredentialEncryptionPort,
  platform: NodeJS.Platform,
): CredentialEncryptionRefusal | undefined {
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

function transientCredentialSlot(entry: string): DesktopCredentialSlot | undefined {
  for (const slot of DESKTOP_CREDENTIAL_SLOTS) {
    for (const prefix of [`.${slot}.`, `.${slot}.bin.`]) {
      if (!entry.startsWith(prefix)) continue;
      for (const suffix of [".tmp", ".deleted"]) {
        if (!entry.endsWith(suffix)) continue;
        const id = entry.slice(prefix.length, -suffix.length);
        if (/^[A-Za-z0-9-]{1,128}$/.test(id)) return slot;
      }
    }
  }
  return undefined;
}

const credentialRootQueues = new Map<string, Promise<void>>();

function serializeCredentialRoot<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = credentialRootQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  credentialRootQueues.set(key, tail);
  void tail.then(() => {
    if (credentialRootQueues.get(key) === tail) credentialRootQueues.delete(key);
  });
  return result;
}

async function secureDirectory(
  root: string,
  platform: NodeJS.Platform,
  bindWindowsDirectory: () => WindowsPrivateDirectoryBinding,
): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    const entry = await lstat(root);
    if (platform === "win32") {
      bindWindowsDirectory();
      return true;
    }
    return (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      permissions(entry.mode) === CREDENTIAL_DIRECTORY_MODE
    );
  } catch {
    return false;
  }
}

async function validTarget(
  path: string,
  platform: NodeJS.Platform,
  windowsDirectory: WindowsPrivateDirectoryBinding | undefined,
): Promise<boolean> {
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
      return true;
    }
    return (
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.size > 0 &&
      permissions(entry.mode) === CREDENTIAL_FILE_MODE
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function createCredentialVault(options: CredentialVaultOptions): CredentialVault {
  if (
    options.serializeEnvelopeMutation === undefined &&
    (options.prepareEnvelopeWrite !== undefined || options.observeEnvelopeRemoved !== undefined)
  ) {
    throw new TypeError();
  }
  const platform = options.platform ?? process.platform;
  const serializeCredentialMutation: SerializeCredentialMutation =
    options.serializeCredentialMutation ?? ((operation) => operation());
  const runtimeState =
    options.runtimeState ?? new Map<DesktopCredentialSlot, CredentialRuntimeState>();
  const setRuntimeState = (slot: DesktopCredentialSlot, state: CredentialRuntimeState): void => {
    if (state === "active" && slot !== "intervals-icu") {
      markUnselectedModelCredentialsInactive(runtimeState, slot, options.onRuntimeStateChange);
    }
    runtimeState.set(slot, state);
    options.onRuntimeStateChange?.(slot);
  };
  const clearRuntimeState = (slot: DesktopCredentialSlot): void => {
    runtimeState.delete(slot);
    options.onRuntimeStateChange?.(slot);
  };
  const rawSyncCredentialDirectory =
    options.syncCredentialDirectory ??
    (async (root: string): Promise<void> => {
      const directory = await (options.openCredentialDirectory ?? open)(root, "r");
      try {
        await directory.sync();
      } catch (error) {
        await directory.close().catch(() => undefined);
        throw error;
      }
      await directory.close().catch(() => undefined);
    });
  const rawSyncCredentialParentDirectory =
    options.syncCredentialParentDirectory ??
    (async (root: string): Promise<void> => {
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } catch (error) {
        await directory.close().catch(() => undefined);
        throw error;
      }
      await directory.close().catch(() => undefined);
    });
  const syncCredentialDirectory = async (root: string): Promise<void> => {
    if (
      platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSyncCredentialDirectory(root);
  };
  const syncCredentialParentDirectory = async (root: string): Promise<void> => {
    if (
      platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSyncCredentialParentDirectory(root);
  };
  const renameCredentialFile = options.renameCredentialFile ?? rename;
  const removeCredentialFile = options.removeCredentialFile ?? rm;
  const readCredentialFile = options.readCredentialFile ?? readFile;
  const createId = options.createId ?? randomUUID;
  const uncertainSlots = new Set<DesktopCredentialSlot>();
  let durabilityState: CredentialVaultDurabilityState = "pending";
  let durabilityReconciliation: Promise<CredentialVaultDurabilityState> | undefined;
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

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> =>
    serializeCredentialRoot(options.root, operation);
  const envelopeExclusive = <T>(
    operation: (proof: CredentialEnvelopeLockProof | undefined) => Promise<T>,
  ): Promise<T> =>
    options.serializeEnvelopeMutation === undefined
      ? exclusive(() => operation(undefined))
      : options.serializeEnvelopeMutation((proof) => exclusive(() => operation(proof)));

  const reconcileDurability = (): Promise<CredentialVaultDurabilityState> => {
    if (durabilityState !== "pending") return Promise.resolve(durabilityState);
    if (durabilityReconciliation !== undefined) return durabilityReconciliation;
    durabilityReconciliation = (async (): Promise<CredentialVaultDurabilityState> => {
      try {
        const directory = await lstat(options.root);
        if (platform === "win32") {
          bindCredentialDirectory();
        } else if (
          !directory.isDirectory() ||
          directory.isSymbolicLink() ||
          permissions(directory.mode) !== CREDENTIAL_DIRECTORY_MODE
        ) {
          durabilityState = "unsafe";
          return durabilityState;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          durabilityState = "verified";
          return durabilityState;
        }
        durabilityState =
          error instanceof WindowsPrivatePathPolicyError &&
          error.category !== "sharing-violation" &&
          error.category !== "io-failure"
            ? "unsafe"
            : "uncertain";
        return durabilityState;
      }

      try {
        const entries = await readdir(options.root);
        for (const entry of entries) {
          if (transientCredentialSlot(entry) === undefined) continue;
          await removeCredentialFile(join(options.root, entry), { force: true });
        }
        await syncCredentialDirectory(options.root);
        durabilityState = "verified";
      } catch {
        durabilityState = "uncertain";
      }
      return durabilityState;
    })();
    return durabilityReconciliation;
  };

  const removeStoredCredential = async (
    slot: DesktopCredentialSlot,
  ): Promise<"deleted" | "cleanup-pending" | "retained" | "uncertain"> => {
    const target = join(options.root, `${slot}.bin`);
    let id: string;
    try {
      id = createId();
    } catch {
      return "retained";
    }
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) return "retained";
    const tombstone = join(options.root, `.${slot}.${id}.deleted`);
    try {
      await renameCredentialFile(target, tombstone);
    } catch {
      return "retained";
    }
    try {
      await syncCredentialDirectory(options.root);
    } catch {
      try {
        await renameCredentialFile(tombstone, target);
        await syncCredentialDirectory(options.root);
        return "retained";
      } catch {
        return "uncertain";
      }
    }
    try {
      await removeCredentialFile(tombstone, { force: true });
      await syncCredentialDirectory(options.root);
      return "deleted";
    } catch {
      return "cleanup-pending";
    }
  };
  const readSlot = async (slot: DesktopCredentialSlot): Promise<ReadCredential> => {
    if ((await reconcileDurability()) !== "verified") {
      return { slot, state: "re-prompt", modifiedAt: 0 };
    }
    if (uncertainSlots.has(slot)) {
      return { slot, state: "re-prompt", modifiedAt: 0 };
    }
    const path = join(options.root, `${slot}.bin`);
    let encrypted: Buffer | undefined;
    try {
      const directory = await lstat(options.root);
      if (platform === "win32") {
        const snapshot = await readWindowsPrivateFile({
          directory: bindCredentialDirectory(),
          path,
          minimumBytes: 1,
          maximumBytes: MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
          openFile: options.openCredentialFile,
        });
        if (snapshot === undefined) return { slot, state: "missing", modifiedAt: 0 };
        encrypted = snapshot.contents;
        if (encryptionRefusal(options.encryption, platform) !== undefined) {
          return { slot, state: "re-prompt", modifiedAt: snapshot.modifiedAt };
        }
        const value = options.encryption.decryptString(encrypted).trim();
        assertWindowsPrivatePathRead({
          bounded: true,
          identityStable: true,
          contentValid: value.length > 0,
          authenticatedHomeBinding: true,
        });
        return { slot, state: "configured", value, modifiedAt: snapshot.modifiedAt };
      }
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        permissions(directory.mode) !== CREDENTIAL_DIRECTORY_MODE
      ) {
        return { slot, state: "re-prompt", modifiedAt: 0 };
      }
      const entry = await lstat(path);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.size === 0 ||
        permissions(entry.mode) !== CREDENTIAL_FILE_MODE
      ) {
        return { slot, state: "re-prompt", modifiedAt: entry.mtimeMs };
      }
      encrypted = await readCredentialFile(path);
      const value = options.encryption.decryptString(encrypted).trim();
      if (value.length === 0) return { slot, state: "re-prompt", modifiedAt: entry.mtimeMs };
      return { slot, state: "configured", value, modifiedAt: entry.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { slot, state: "missing", modifiedAt: 0 };
      }
      return { slot, state: "re-prompt", modifiedAt: 0 };
    } finally {
      encrypted?.fill(0);
    }
  };

  const readAll = async (): Promise<readonly ReadCredential[]> => {
    if ((await reconcileDurability()) !== "verified") {
      return DESKTOP_CREDENTIAL_SLOTS.map((slot) => ({
        slot,
        state: "re-prompt",
        modifiedAt: 0,
      }));
    }
    const entries: ReadCredential[] = [];
    for (const slot of DESKTOP_CREDENTIAL_SLOTS) entries.push(await readSlot(slot));
    return entries;
  };

  const reapplyConfigured = async (): Promise<void> => {
    const entries = (await readAll())
      .filter(
        (entry): entry is ReadCredential & { readonly value: string } =>
          entry.state === "configured" && entry.value !== undefined,
      )
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    const storedCredentialSlots = entries.map((entry) => entry.slot);
    for (const entry of entries) {
      try {
        const canPublish = options.createRuntimePublicationGuard?.(entry.slot);
        const replayed =
          options.reapplyCredential === undefined
            ? await options.applyCredential(entry.slot, entry.value).then(() => "active" as const)
            : await options.reapplyCredential(entry.slot, entry.value, storedCredentialSlots);
        if (canPublish !== undefined && !canPublish()) throw new TypeError();
        setRuntimeState(entry.slot, replayed);
      } catch {
        setRuntimeState(entry.slot, "failed");
      }
    }
  };

  const retryFailed = async (): Promise<void> => {
    const configured = (await readAll())
      .filter(
        (entry): entry is ReadCredential & { readonly value: string } =>
          entry.state === "configured" && entry.value !== undefined,
      )
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    const storedCredentialSlots = configured.map((entry) => entry.slot);
    const entries = configured.filter((entry) => runtimeState.get(entry.slot) === "failed");
    for (const entry of entries) {
      try {
        const canPublish = options.createRuntimePublicationGuard?.(entry.slot);
        const retried =
          options.reapplyCredential === undefined
            ? await options.applyCredential(entry.slot, entry.value).then(() => "active" as const)
            : await options.reapplyCredential(entry.slot, entry.value, storedCredentialSlots);
        if (canPublish !== undefined && !canPublish()) throw new TypeError();
        setRuntimeState(entry.slot, retried);
      } catch {
        setRuntimeState(entry.slot, "failed");
      }
    }
  };

  const writeCredential = async (
    input: CredentialWriteInput,
    behavior?: CredentialWriteBehavior,
  ): Promise<CredentialWriteResult> => {
    if (!isCredentialSlot(input?.slot) || typeof input.value !== "string") {
      return {
        slot: isCredentialSlot(input?.slot) ? input.slot : "anthropic",
        status: "refused",
        reason: "invalid-input",
      };
    }
    let selection: OnboardingLlmSelection | undefined;
    try {
      if (input.selection !== undefined) {
        selection = parseOnboardingLlmSelection(input.selection);
        if (input.slot === "intervals-icu" || selection.provider !== input.slot) {
          throw new TypeError();
        }
      }
    } catch {
      return { slot: input.slot, status: "refused", reason: "invalid-input" };
    }
    const value = input.value.trim();
    if (value.length === 0) {
      return { slot: input.slot, status: "refused", reason: "invalid-input" };
    }
    if (
      behavior?.verificationApproval !== undefined &&
      (input.slot !== "intervals-icu" ||
        behavior.activate === false ||
        !/^[0-9a-f]{64}$/.test(behavior.verificationApproval))
    ) {
      return { slot: input.slot, status: "refused", reason: "invalid-input" };
    }
    const encryptionFailure = encryptionRefusal(options.encryption, platform);
    if (encryptionFailure !== undefined) {
      return { slot: input.slot, status: "refused", reason: encryptionFailure };
    }
    const durability = await reconcileDurability();
    if (durability === "uncertain") {
      return { slot: input.slot, status: "uncertain", reason: "storage-uncertain" };
    }
    if (durability !== "verified") {
      return { slot: input.slot, status: "refused", reason: "storage-failed" };
    }
    if (!(await secureDirectory(options.root, platform, bindCredentialDirectory))) {
      return { slot: input.slot, status: "refused", reason: "storage-failed" };
    }
    if (!parentDirectoryVerified) {
      try {
        await syncCredentialParentDirectory(dirname(options.root));
        parentDirectoryVerified = true;
      } catch {
        return { slot: input.slot, status: "refused", reason: "storage-failed" };
      }
    }
    const target = join(options.root, `${input.slot}.bin`);
    if (!(await validTarget(target, platform, windowsDirectory))) {
      return { slot: input.slot, status: "refused", reason: "storage-failed" };
    }
    const previousRuntimeState = runtimeState.get(input.slot);
    let encrypted: Buffer | undefined;
    let previous: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      if (platform === "win32") {
        previous = (
          await readWindowsPrivateFile({
            directory: bindCredentialDirectory(),
            path: target,
            minimumBytes: 1,
            maximumBytes: MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
            openFile: options.openCredentialFile,
          })
        )?.contents;
      } else {
        try {
          previous = await readCredentialFile(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      encrypted = options.encryption.encryptString(value);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new TypeError();
      if (platform === "win32") {
        plaintext = Buffer.from(value, "utf8");
        assertWindowsPrivatePathRead({
          bounded: encrypted.length <= MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
          identityStable: true,
          contentValid: !encrypted.includes(plaintext),
          authenticatedHomeBinding: true,
        });
      }
      const stored = await durablyReplaceReversible({
        root: options.root,
        fileName: `${input.slot}.bin`,
        contents: encrypted,
        previousContents: previous,
        mode: CREDENTIAL_FILE_MODE,
        createId,
        renameFile: renameCredentialFile,
        removeFile: removeCredentialFile,
        syncDirectory: syncCredentialDirectory,
        platform,
      });
      if (stored.state === "refused") {
        uncertainSlots.delete(input.slot);
        return { slot: input.slot, status: "refused", reason: "storage-failed" };
      }
      if (stored.state === "uncertain") {
        uncertainSlots.add(input.slot);
        return { slot: input.slot, status: "uncertain", reason: "storage-uncertain" };
      }
      uncertainSlots.delete(input.slot);
      setRuntimeState(input.slot, "failed");
      if (behavior?.activate === false) {
        setRuntimeState(input.slot, "stored-inactive");
        return { slot: input.slot, status: "configured", runtimeReady: false };
      }
      try {
        const canPublish = options.createRuntimePublicationGuard?.(input.slot);
        if (behavior?.verificationApproval !== undefined) {
          await options.applyCredential(
            input.slot,
            value,
            selection,
            behavior.verificationApproval,
          );
        } else if (selection === undefined) {
          await options.applyCredential(input.slot, value);
        } else {
          await options.applyCredential(input.slot, value, selection);
        }
        if (canPublish !== undefined && !canPublish()) throw new TypeError();
        setRuntimeState(input.slot, "active");
        return { slot: input.slot, status: "configured", runtimeReady: true };
      } catch (error) {
        if (
          behavior?.rollbackOnRuntimeRefusal === true &&
          error instanceof CredentialRuntimeRefusal
        ) {
          let storageRestored = false;
          try {
            if (previous === undefined) {
              const removed = await removeStoredCredential(input.slot);
              storageRestored = removed === "deleted" || removed === "cleanup-pending";
            } else {
              const restored = await durablyReplaceReversible({
                root: options.root,
                fileName: `${input.slot}.bin`,
                contents: previous,
                previousContents: encrypted,
                mode: CREDENTIAL_FILE_MODE,
                createId,
                renameFile: renameCredentialFile,
                removeFile: removeCredentialFile,
                syncDirectory: syncCredentialDirectory,
                platform,
              });
              storageRestored = restored.state === "applied";
            }
          } catch {}
          if (!storageRestored) {
            uncertainSlots.add(input.slot);
            setRuntimeState(input.slot, "failed");
            return { slot: input.slot, status: "uncertain", reason: "storage-uncertain" };
          }
          uncertainSlots.delete(input.slot);
          if (previous === undefined) {
            clearRuntimeState(input.slot);
          } else {
            setRuntimeState(input.slot, previousRuntimeState ?? "stored-inactive");
          }
          return {
            slot: input.slot,
            status: "refused",
            reason:
              error.reason === "training-account-mismatch"
                ? "training-account-mismatch"
                : "runtime-unavailable",
          };
        }
        setRuntimeState(input.slot, "failed");
        return { slot: input.slot, status: "configured", runtimeReady: false };
      }
    } catch {
      return { slot: input.slot, status: "refused", reason: "storage-failed" };
    } finally {
      previous?.fill(0);
      encrypted?.fill(0);
      plaintext?.fill(0);
    }
  };

  const credentialStatuses = async (): Promise<readonly CredentialSlotStatus[]> => {
    const entries = await readAll();
    return entries.map((entry) => ({
      slot: entry.slot,
      state: entry.state,
      runtimeState:
        entry.state === "configured" ? (runtimeState.get(entry.slot) ?? "stored-inactive") : null,
    }));
  };

  return {
    writeCredential(input, behavior): Promise<CredentialWriteResult> {
      return serializeCredentialMutation(() =>
        envelopeExclusive(async (proof) => {
          if (proof !== undefined) await options.prepareEnvelopeWrite?.(proof);
          return await writeCredential(input, behavior);
        }),
      );
    },

    runExclusiveMutation<T>(
      operation: (current: CredentialVaultMutation) => Promise<T>,
    ): Promise<T> {
      return serializeCredentialMutation(() =>
        envelopeExclusive(async (proof) => {
          if (proof !== undefined) await options.prepareEnvelopeWrite?.(proof);
          let active = true;
          const mutation = Object.freeze({
            writeCredential(
              input: CredentialWriteInput,
              behavior?: CredentialWriteBehavior,
            ): Promise<CredentialWriteResult> {
              if (!active) throw new TypeError();
              return writeCredential(input, behavior);
            },
            credentialStatuses(): Promise<readonly CredentialSlotStatus[]> {
              if (!active) throw new TypeError();
              return credentialStatuses();
            },
          }) satisfies CredentialVaultMutation;
          try {
            return await operation(mutation);
          } finally {
            active = false;
          }
        }),
      );
    },

    applyLlmSelection(input): Promise<OnboardingLlmSelectionResult> {
      return serializeCredentialMutation(() =>
        exclusive(async () => {
          let selection: OnboardingLlmSelection;
          let slot: DesktopCredentialSlot;
          try {
            selection = parseOnboardingLlmSelection(input);
            if (isKeylessProvider(selection.provider)) {
              throw new TypeError();
            }
            slot = selection.provider;
          } catch {
            return { status: "refused", reason: "invalid-input" };
          }
          const credential = await readSlot(slot);
          if (credential.state !== "configured" || credential.value === undefined) {
            return { status: "refused", reason: "credential-required" };
          }
          try {
            const canPublish = options.createRuntimePublicationGuard?.(slot);
            await options.applyCredential(slot, credential.value, selection);
            if (canPublish !== undefined && !canPublish()) throw new TypeError();
            setRuntimeState(slot, "active");
            return { status: "configured", runtimeReady: true };
          } catch {
            setRuntimeState(slot, "failed");
            return { status: "refused", reason: "runtime-unavailable" };
          }
        }),
      );
    },

    credentialStatuses(): Promise<readonly CredentialSlotStatus[]> {
      return exclusive(credentialStatuses);
    },

    deleteCredential(slot): Promise<CredentialDeleteResult> {
      return serializeCredentialMutation(() =>
        envelopeExclusive(async (proof) => {
          if (!isCredentialSlot(slot)) {
            return { slot: "anthropic", status: "refused", reason: "not-found" };
          }
          const credential = await readSlot(slot);
          if (credential.state === "missing") {
            return { slot, status: "refused", reason: "not-found" };
          }
          const runtimeStatus = runtimeState.get(slot);
          const shouldClearRuntime = runtimeStatus === "active" || runtimeStatus === "failed";
          let runtimeCleared = false;
          if (shouldClearRuntime) {
            if (options.clearCredential === undefined) {
              return { slot, status: "refused", reason: "runtime-unavailable" };
            }
            try {
              const cleared = await options.clearCredential(slot);
              if (cleared === "managed-by-environment") {
                return { slot, status: "refused", reason: "managed-by-environment" };
              }
              if (cleared !== "cleared" && cleared !== "not-active") throw new TypeError();
              runtimeCleared = cleared === "cleared";
            } catch {
              setRuntimeState(slot, "failed");
              return { slot, status: "refused", reason: "runtime-state-diverged" };
            }
          }
          const removed = await removeStoredCredential(slot);
          if (removed === "uncertain") {
            uncertainSlots.add(slot);
            setRuntimeState(slot, "failed");
            return { slot, status: "uncertain", reason: "storage-uncertain" };
          }
          if (removed === "deleted" || removed === "cleanup-pending") {
            clearRuntimeState(slot);
            if (proof !== undefined) {
              try {
                await options.observeEnvelopeRemoved?.(proof);
              } catch {}
            }
            return {
              slot,
              status: "deleted",
              cleanupPending: removed === "cleanup-pending",
            };
          }
          if (runtimeCleared && credential.value !== undefined && removed === "retained") {
            try {
              await options.applyCredential(slot, credential.value);
              setRuntimeState(slot, "active");
              return { slot, status: "refused", reason: "storage-failed" };
            } catch {
              setRuntimeState(slot, "failed");
              return { slot, status: "refused", reason: "runtime-state-diverged" };
            }
          }
          if (runtimeCleared) {
            setRuntimeState(slot, "failed");
            return { slot, status: "refused", reason: "runtime-state-diverged" };
          }
          return { slot, status: "refused", reason: "storage-failed" };
        }),
      );
    },

    reapplyConfigured: () => serializeCredentialMutation(() => exclusive(reapplyConfigured)),
    retryFailed: () => serializeCredentialMutation(() => exclusive(retryFailed)),
  };
}
