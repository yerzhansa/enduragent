import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { App, LoginItemSettings } from "electron";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import {
  durablyReplaceReversible,
  type ReversibleDurableReplaceOutcome,
} from "./durable-atomic-replace.js";
import { DESKTOP_APP_USER_MODEL_ID } from "./constants.js";
import { assertWindowsPrivateFileAtPath, readWindowsPrivateFile } from "./windows-private-file.js";

export const CLEAN_LOGIN_ITEM_STATUSES = ["not-found", "not-registered"] as const;
export const BACKGROUND_AT_LOGIN_PREFERENCE_DIRECTORY_NAME = "desktop-preferences-v1" as const;
export const BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME = "background-at-login.json" as const;
export const LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE = 0o700;
export const LOGIN_ITEM_PREFERENCE_FILE_MODE = 0o600;
export const WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT = "--enduragent-background-at-login" as const;

const MAX_PREFERENCE_FILE_BYTES = 1_024;

export type CleanLoginItemStatus = (typeof CLEAN_LOGIN_ITEM_STATUSES)[number];

export interface LoginItemResidencyState {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin: boolean;
  readonly status: LoginItemSettings["status"] | undefined;
}

export type LoginItemAppPort = Pick<App, "getLoginItemSettings" | "setLoginItemSettings">;
export type LoginLaunchAppPort = Pick<App, "getLoginItemSettings">;

export interface LoginItemResidencyOptions {
  readonly platform?: NodeJS.Platform;
  readonly executablePath?: string;
}

export interface LoginLaunchOptions extends LoginItemResidencyOptions {
  readonly commandLine?: readonly string[];
}

export type BackgroundAtLoginPreference =
  | Readonly<{
      state: "configured";
      enabled: boolean;
      loginLaunchBehavior?: "background";
    }>
  | Readonly<{ state: "unavailable" | "uncertain"; enabled: false }>;

export type BackgroundAtLoginPreferenceWriteResult =
  | Readonly<{ status: "stored"; enabled: boolean }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "uncertain" }>;

export interface BackgroundAtLoginPreferenceStore {
  read(): Promise<BackgroundAtLoginPreference>;
  set(enabled: boolean): Promise<BackgroundAtLoginPreferenceWriteResult>;
}

export interface CreateBackgroundAtLoginPreferenceStoreInput {
  readonly root: string;
  readonly createId?: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
  readonly syncParentDirectory?: (root: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly openFile?: typeof open;
}

interface LegacyBackgroundAtLoginPreferenceRecord {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
}

interface BackgroundAtLoginPreferenceRecord {
  readonly schemaVersion: 2;
  readonly enabled: boolean;
  readonly loginLaunchBehavior: "background";
}

type StoredBackgroundAtLoginPreferenceRecord =
  | LegacyBackgroundAtLoginPreferenceRecord
  | BackgroundAtLoginPreferenceRecord;

function permissions(mode: number): number {
  return mode & 0o777;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwner(metadata: Stats, mode: number): void {
  if (
    metadata.isSymbolicLink() ||
    permissions(metadata.mode) !== mode ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("unsafe login preference path");
  }
}

function parsePreference(contents: string): StoredBackgroundAtLoginPreferenceRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.schemaVersion === 1) {
    if (
      keys.length !== 2 ||
      keys[0] !== "enabled" ||
      keys[1] !== "schemaVersion" ||
      typeof record.enabled !== "boolean"
    ) {
      return undefined;
    }
    return { schemaVersion: 1, enabled: record.enabled };
  }
  if (
    record.schemaVersion !== 2 ||
    keys.length !== 3 ||
    keys[0] !== "enabled" ||
    keys[1] !== "loginLaunchBehavior" ||
    keys[2] !== "schemaVersion" ||
    typeof record.enabled !== "boolean" ||
    record.loginLaunchBehavior !== "background"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
    enabled: record.enabled,
    loginLaunchBehavior: "background",
  };
}

export function createBackgroundAtLoginPreferenceStore(
  input: CreateBackgroundAtLoginPreferenceStoreInput,
): BackgroundAtLoginPreferenceStore {
  const platform = input.platform ?? process.platform;
  const target = join(input.root, BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME);
  const createId = input.createId ?? randomUUID;
  let namespaceState: "pending" | "verified" | "uncertain" = "pending";
  let parentDirectoryVerified = false;
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const defaultSynchronizeDirectory = async (root: string): Promise<void> => {
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } catch (error) {
      try {
        await directory.close();
      } catch (closeError) {
        const code = (closeError as NodeJS.ErrnoException).code;
        if (code !== "ERR_DIR_CLOSED" && code !== "EBADF") throw closeError;
      }
      throw error;
    }
    try {
      await directory.close();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ERR_DIR_CLOSED" && code !== "EBADF") throw error;
    }
  };
  const rawSynchronizeDirectory = input.syncDirectory ?? defaultSynchronizeDirectory;
  const rawSynchronizeParentDirectory = input.syncParentDirectory ?? defaultSynchronizeDirectory;
  const synchronizeDirectory = async (root: string): Promise<void> => {
    if (
      platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSynchronizeDirectory(root);
  };
  const synchronizeParentDirectory = async (root: string): Promise<void> => {
    if (
      platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSynchronizeParentDirectory(root);
  };
  let windowsDirectory: WindowsPrivateDirectoryBinding | undefined;
  const bindPreferenceDirectory = (): WindowsPrivateDirectoryBinding => {
    if (windowsDirectory === undefined) {
      windowsDirectory = bindWindowsPrivateDirectory(dirname(input.root), input.root);
    } else {
      assertWindowsPrivateDirectoryStable(windowsDirectory);
    }
    return windowsDirectory;
  };
  const ownedTransient = (entry: string): boolean => {
    const prefix = `.${BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME}.`;
    if (!entry.startsWith(prefix)) return false;
    const suffix = entry.endsWith(".tmp")
      ? ".tmp"
      : entry.endsWith(".deleted")
        ? ".deleted"
        : undefined;
    if (suffix === undefined) return false;
    return /^[A-Za-z0-9-]{1,128}$/.test(entry.slice(prefix.length, -suffix.length));
  };
  const reconcileNamespace = async (): Promise<boolean> => {
    if (namespaceState === "verified") return true;
    if (namespaceState === "uncertain") return false;
    try {
      let rootMetadata;
      try {
        rootMetadata = await lstat(input.root);
      } catch (error) {
        if (isMissing(error)) {
          namespaceState = "verified";
          return true;
        }
        throw error;
      }
      if (platform === "win32") {
        bindPreferenceDirectory();
      } else {
        if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
        assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
      }
      for (const entry of await readdir(input.root)) {
        if (ownedTransient(entry)) {
          await (input.removeFile ?? rm)(join(input.root, entry), { force: true });
        }
      }
      await synchronizeDirectory(input.root);
      namespaceState = "verified";
      return true;
    } catch {
      namespaceState = "uncertain";
      return false;
    }
  };
  const readRawRecord = async (): Promise<Buffer | undefined> => {
    let rootMetadata;
    try {
      rootMetadata = await lstat(input.root);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (platform === "win32") {
      return (
        await readWindowsPrivateFile({
          directory: bindPreferenceDirectory(),
          path: target,
          maximumBytes: MAX_PREFERENCE_FILE_BYTES,
          openFile: input.openFile,
        })
      )?.contents;
    }
    if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
    assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    let before;
    try {
      before = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (!before.isFile() || before.size > MAX_PREFERENCE_FILE_BYTES) {
      throw new TypeError("invalid login preference file");
    }
    assertOwner(before, LOGIN_ITEM_PREFERENCE_FILE_MODE);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > MAX_PREFERENCE_FILE_BYTES
      ) {
        throw new TypeError("login preference changed while opening");
      }
      assertOwner(opened, LOGIN_ITEM_PREFERENCE_FILE_MODE);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  };
  const readRecord = async (): Promise<StoredBackgroundAtLoginPreferenceRecord> => {
    const contents = await readRawRecord();
    if (contents === undefined) return { schemaVersion: 1, enabled: false };
    try {
      const record = parsePreference(contents.toString("utf8"));
      if (record === undefined) {
        if (platform === "win32") {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        throw new TypeError("invalid login preference record");
      }
      return record;
    } finally {
      contents.fill(0);
    }
  };
  const writeRecord = async (
    record: BackgroundAtLoginPreferenceRecord,
  ): Promise<ReversibleDurableReplaceOutcome> => {
    await mkdir(input.root, { recursive: true, mode: LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE });
    const rootMetadata = await lstat(input.root);
    if (platform === "win32") {
      bindPreferenceDirectory();
    } else {
      if (!rootMetadata.isDirectory()) throw new TypeError("invalid login preference root");
      assertOwner(rootMetadata, LOGIN_ITEM_PREFERENCE_DIRECTORY_MODE);
    }
    if (!parentDirectoryVerified) {
      await synchronizeParentDirectory(dirname(input.root));
      parentDirectoryVerified = true;
    }
    try {
      const existing = await lstat(target);
      if (platform === "win32") {
        assertWindowsPrivateFileAtPath(
          bindPreferenceDirectory(),
          target,
          existing,
          0,
          MAX_PREFERENCE_FILE_BYTES,
        );
      } else {
        if (!existing.isFile()) throw new TypeError("invalid login preference target");
        assertOwner(existing, LOGIN_ITEM_PREFERENCE_FILE_MODE);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const id = createId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new TypeError("invalid temporary file id");
    let previous: Buffer | undefined;
    const candidate = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    try {
      previous = await readRawRecord();
      return await durablyReplaceReversible({
        root: input.root,
        fileName: BACKGROUND_AT_LOGIN_PREFERENCE_FILE_NAME,
        contents: candidate,
        previousContents: previous,
        mode: LOGIN_ITEM_PREFERENCE_FILE_MODE,
        createId: () => id,
        renameFile: input.renameFile,
        removeFile: input.removeFile,
        syncDirectory: platform === "win32" ? synchronizeDirectory : input.syncDirectory,
        platform,
      });
    } finally {
      previous?.fill(0);
      candidate.fill(0);
    }
  };

  return {
    read() {
      return serialize(async () => {
        if (!(await reconcileNamespace())) return { state: "uncertain", enabled: false };
        try {
          const record = await readRecord();
          return record.schemaVersion === 2
            ? {
                state: "configured",
                enabled: record.enabled,
                loginLaunchBehavior: record.loginLaunchBehavior,
              }
            : { state: "configured", enabled: record.enabled };
        } catch {
          return { state: "unavailable", enabled: false };
        }
      });
    },
    set(enabled) {
      return serialize(async () => {
        if (typeof enabled !== "boolean") return { status: "refused" };
        if (!(await reconcileNamespace())) return { status: "uncertain" };
        try {
          const current = await readRecord();
          const currentProtectsLoginLaunch =
            current.schemaVersion === 2 || current.enabled === true;
          if (current.enabled === enabled && currentProtectsLoginLaunch) {
            namespaceState = "verified";
            return { status: "stored", enabled };
          }
          const stored = await writeRecord({
            schemaVersion: 2,
            enabled,
            loginLaunchBehavior: "background",
          });
          if (stored.state === "applied") {
            namespaceState = "verified";
            return { status: "stored", enabled };
          }
          if (stored.state === "refused") {
            namespaceState = "verified";
            return { status: "refused" };
          }
          namespaceState = "uncertain";
          return { status: "uncertain" };
        } catch {
          return { status: "refused" };
        }
      });
    },
  };
}

export async function shouldStartInBackgroundAtLogin(
  app: LoginLaunchAppPort,
  preference: Pick<BackgroundAtLoginPreferenceStore, "read">,
  options: LoginLaunchOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const commandLine = options.commandLine ?? process.argv;
    if (!commandLine.includes(WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT)) return false;
    const state = readLoginItemResidency(app, options);
    if (!isLoginItemResidencyEnabled(state, platform)) return false;
  } else if (app.getLoginItemSettings().wasOpenedAtLogin !== true) {
    return false;
  }
  const stored = await preference.read();
  if (stored.state === "uncertain") return true;
  return (
    stored.state === "configured" && (stored.enabled || stored.loginLaunchBehavior === "background")
  );
}

export function readLoginItemResidency(
  app: LoginLaunchAppPort,
  options: LoginItemResidencyOptions = {},
): LoginItemResidencyState {
  const platform = options.platform ?? process.platform;
  const settings =
    platform === "win32"
      ? app.getLoginItemSettings({
          path: options.executablePath ?? process.execPath,
          args: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
        })
      : app.getLoginItemSettings();
  return {
    openAtLogin: settings.openAtLogin,
    executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin,
    status: settings.status,
  };
}

export function setLoginItemResidency(
  app: LoginItemAppPort,
  openAtLogin: boolean,
  options: LoginItemResidencyOptions = {},
): LoginItemResidencyState {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin,
      path: options.executablePath ?? process.execPath,
      args: [WINDOWS_BACKGROUND_AT_LOGIN_ARGUMENT],
      enabled: openAtLogin,
      name: DESKTOP_APP_USER_MODEL_ID,
    });
  } else {
    app.setLoginItemSettings({ openAtLogin });
  }
  return readLoginItemResidency(app, options);
}

export function isLoginItemResidencyEnabled(
  state: LoginItemResidencyState,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return state.openAtLogin && (platform !== "win32" || state.executableWillLaunchAtLogin === true);
}

export function loginItemResidencyMatchesRequest(
  state: LoginItemResidencyState,
  openAtLogin: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return openAtLogin ? isLoginItemResidencyEnabled(state, platform) : !state.openAtLogin;
}

export function isCleanUnregisteredLoginItem(
  state: LoginItemResidencyState,
): state is LoginItemResidencyState & {
  readonly openAtLogin: false;
  readonly executableWillLaunchAtLogin: false;
  readonly status: CleanLoginItemStatus;
} {
  return (
    state.openAtLogin === false &&
    state.executableWillLaunchAtLogin === false &&
    CLEAN_LOGIN_ITEM_STATUSES.includes(state.status as CleanLoginItemStatus)
  );
}
