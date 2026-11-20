import { lstat, mkdir, type open } from "node:fs/promises";
import { resolve } from "node:path";
import type { WindowsPrivateDirectoryBinding } from "@enduragent/core";
import {
  assertWindowsPrivateFileAtPath,
  MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES,
} from "./windows-private-file.js";

export function permissions(mode: number): number {
  return mode & 0o777;
}

export async function settle(operation: () => Promise<unknown>): Promise<"fulfilled" | "rejected"> {
  try {
    await operation();
    return "fulfilled";
  } catch {
    return "rejected";
  }
}

export async function syncDirectoryAt(root: string, openDirectory: typeof open): Promise<void> {
  const directory = await openDirectory(root, "r");
  try {
    await directory.sync();
  } finally {
    await Promise.allSettled([directory.close()]);
  }
}

const credentialRootQueues = new Map<string, Promise<void>>();

export function serializeCredentialRoot<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(root);
  const previous = credentialRootQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = Promise.allSettled([result]).then(() => undefined);
  credentialRootQueues.set(key, tail);
  void tail.then(() => {
    if (credentialRootQueues.get(key) === tail) credentialRootQueues.delete(key);
  });
  return result;
}

export async function secureDirectory(
  root: string,
  directoryMode: number,
  platform: NodeJS.Platform,
  bindWindowsDirectory: () => WindowsPrivateDirectoryBinding,
): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true, mode: directoryMode });
    const entry = await lstat(root);
    if (platform === "win32") {
      bindWindowsDirectory();
      return true;
    }
    return (
      entry.isDirectory() && !entry.isSymbolicLink() && permissions(entry.mode) === directoryMode
    );
  } catch {
    return false;
  }
}

export async function validTarget(
  path: string,
  fileMode: number,
  platform: NodeJS.Platform,
  windowsDirectory: WindowsPrivateDirectoryBinding | undefined,
): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (platform === "win32") {
      if (windowsDirectory === undefined) return false;
      assertWindowsPrivateFileAtPath(
        windowsDirectory,
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
      permissions(entry.mode) === fileMode
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
