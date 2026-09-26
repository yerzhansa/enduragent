import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  assertWindowsPrivatePathRead,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  WindowsPrivatePathPolicyError,
  windowsPrivatePathIdentity,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";

export const MAX_WINDOWS_DESKTOP_VAULT_FILE_BYTES = 262_144;

export interface WindowsPrivateFileSnapshot {
  readonly contents: Buffer;
  readonly modifiedAt: number;
}

export interface WindowsPrivateFilePrefixSnapshot {
  readonly contents: Buffer;
}

export class WindowsPrivateFileMaximumBytesExceededError extends WindowsPrivatePathPolicyError {
  constructor() {
    super("read-check", "corruption");
  }
}

export interface ReadWindowsPrivateFileInput {
  readonly directory: WindowsPrivateDirectoryBinding;
  readonly path: string;
  readonly minimumBytes?: number;
  readonly maximumBytes: number;
  readonly allowedLinks?: 1 | 2;
  readonly openFile?: typeof open;
}

export interface ReadWindowsPrivateFilePrefixInput {
  readonly directory: WindowsPrivateDirectoryBinding;
  readonly path: string;
  readonly maximumReadBytes: number;
  readonly allowedLinks?: 1 | 2;
  readonly openFile?: typeof open;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertBounded(metadata: Stats, minimumBytes: number, maximumBytes: number): void {
  if (Number.isSafeInteger(metadata.size) && metadata.size > maximumBytes) {
    throw new WindowsPrivateFileMaximumBytesExceededError();
  }
  assertWindowsPrivatePathRead({
    bounded:
      Number.isSafeInteger(metadata.size) &&
      metadata.size >= minimumBytes &&
      metadata.size <= maximumBytes,
    identityStable: true,
    contentValid: true,
    authenticatedHomeBinding: true,
  });
}

export function assertWindowsPrivateFileAtPath(
  directory: WindowsPrivateDirectoryBinding,
  path: string,
  metadata: Stats,
  minimumBytes: number,
  maximumBytes: number,
  allowedLinks: 1 | 2 = 1,
): void {
  assertWindowsPrivateFileMetadata(metadata, allowedLinks);
  assertWindowsPrivateFileBinding(
    directory,
    path,
    windowsPrivatePathIdentity(metadata),
    allowedLinks,
  );
  assertBounded(metadata, minimumBytes, maximumBytes);
}

export async function readWindowsPrivateFile(
  input: ReadWindowsPrivateFileInput,
): Promise<WindowsPrivateFileSnapshot | undefined> {
  const minimumBytes = input.minimumBytes ?? 0;
  const allowedLinks = input.allowedLinks ?? 1;
  try {
    assertWindowsPrivateDirectoryStable(input.directory);
    let beforeOpen: Stats;
    try {
      beforeOpen = await lstat(input.path);
    } catch (error) {
      if (isMissing(error)) {
        assertWindowsPrivateDirectoryStable(input.directory);
        return undefined;
      }
      throw error;
    }
    assertWindowsPrivateFileAtPath(
      input.directory,
      input.path,
      beforeOpen,
      minimumBytes,
      input.maximumBytes,
      allowedLinks,
    );
    const handle = await (input.openFile ?? open)(input.path, constants.O_RDONLY);
    let contents: Buffer | undefined;
    try {
      const opened = await handle.stat();
      assertWindowsPrivateFileMetadata(opened, allowedLinks);
      assertWindowsPrivatePathRead({
        bounded: true,
        identityStable: sameWindowsPrivatePathIdentity(
          windowsPrivatePathIdentity(beforeOpen),
          windowsPrivatePathIdentity(opened),
        ),
        contentValid: true,
        authenticatedHomeBinding: true,
      });
      assertWindowsPrivateFileBinding(
        input.directory,
        input.path,
        windowsPrivatePathIdentity(opened),
        allowedLinks,
      );
      assertBounded(opened, minimumBytes, input.maximumBytes);
      contents = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      while (offset < contents.length) {
        const read = await handle.read(contents, offset, contents.length - offset, offset);
        if (read.bytesRead <= 0) {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        offset += read.bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const extra = await handle.read(probe, 0, probe.length, offset);
      probe.fill(0);
      const afterRead = await handle.stat();
      assertWindowsPrivateFileMetadata(afterRead, allowedLinks);
      const current = assertWindowsPrivateFileBinding(
        input.directory,
        input.path,
        windowsPrivatePathIdentity(afterRead),
        allowedLinks,
      );
      assertWindowsPrivatePathRead({
        bounded: true,
        identityStable:
          sameWindowsPrivatePathIdentity(
            windowsPrivatePathIdentity(beforeOpen),
            windowsPrivatePathIdentity(opened),
          ) &&
          sameWindowsPrivatePathIdentity(
            windowsPrivatePathIdentity(opened),
            windowsPrivatePathIdentity(afterRead),
          ) &&
          opened.size === afterRead.size &&
          opened.size === current.size &&
          opened.mtimeMs === afterRead.mtimeMs &&
          opened.mtimeMs === current.mtimeMs &&
          opened.ctimeMs === afterRead.ctimeMs &&
          opened.ctimeMs === current.ctimeMs,
        contentValid: offset === opened.size && extra.bytesRead === 0,
        authenticatedHomeBinding: true,
      });
      assertWindowsPrivateDirectoryStable(input.directory);
      await handle.close();
      return { contents, modifiedAt: afterRead.mtimeMs };
    } catch (error) {
      contents?.fill(0);
      try {
        await handle.close();
      } catch (closeError) {
        const code = (closeError as NodeJS.ErrnoException).code;
        if (code !== "EBADF") throw closeError;
      }
      throw error;
    }
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("read-check", error);
  }
}

export async function readWindowsPrivateFilePrefix(
  input: ReadWindowsPrivateFilePrefixInput,
): Promise<WindowsPrivateFilePrefixSnapshot | undefined> {
  const allowedLinks = input.allowedLinks ?? 1;
  try {
    assertWindowsPrivateDirectoryStable(input.directory);
    let beforeOpen: Stats;
    try {
      beforeOpen = await lstat(input.path);
    } catch (error) {
      if (isMissing(error)) {
        assertWindowsPrivateDirectoryStable(input.directory);
        return undefined;
      }
      throw error;
    }
    assertWindowsPrivateFileMetadata(beforeOpen, allowedLinks);
    assertWindowsPrivateFileBinding(
      input.directory,
      input.path,
      windowsPrivatePathIdentity(beforeOpen),
      allowedLinks,
    );
    const handle = await (input.openFile ?? open)(input.path, constants.O_RDONLY);
    let contents: Buffer | undefined;
    try {
      const opened = await handle.stat();
      assertWindowsPrivateFileMetadata(opened, allowedLinks);
      assertWindowsPrivateFileBinding(
        input.directory,
        input.path,
        windowsPrivatePathIdentity(opened),
        allowedLinks,
      );
      const bounded =
        Number.isSafeInteger(opened.size) &&
        opened.size >= 0 &&
        Number.isSafeInteger(input.maximumReadBytes) &&
        input.maximumReadBytes > 0;
      assertWindowsPrivatePathRead({
        bounded,
        identityStable: sameWindowsPrivatePathIdentity(
          windowsPrivatePathIdentity(beforeOpen),
          windowsPrivatePathIdentity(opened),
        ),
        contentValid: true,
        authenticatedHomeBinding: true,
      });
      const prefixBytes = Math.min(opened.size, input.maximumReadBytes);
      contents = Buffer.allocUnsafe(prefixBytes);
      let offset = 0;
      while (offset < contents.length) {
        const read = await handle.read(contents, offset, contents.length - offset, offset);
        if (read.bytesRead <= 0) {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        offset += read.bytesRead;
      }
      const afterRead = await handle.stat();
      assertWindowsPrivateFileMetadata(afterRead, allowedLinks);
      const current = assertWindowsPrivateFileBinding(
        input.directory,
        input.path,
        windowsPrivatePathIdentity(afterRead),
        allowedLinks,
      );
      assertWindowsPrivatePathRead({
        bounded: true,
        identityStable:
          sameWindowsPrivatePathIdentity(
            windowsPrivatePathIdentity(beforeOpen),
            windowsPrivatePathIdentity(opened),
          ) &&
          sameWindowsPrivatePathIdentity(
            windowsPrivatePathIdentity(opened),
            windowsPrivatePathIdentity(afterRead),
          ) &&
          opened.size === afterRead.size &&
          opened.size === current.size &&
          opened.mtimeMs === afterRead.mtimeMs &&
          opened.mtimeMs === current.mtimeMs &&
          opened.ctimeMs === afterRead.ctimeMs &&
          opened.ctimeMs === current.ctimeMs,
        contentValid: offset === prefixBytes,
        authenticatedHomeBinding: true,
      });
      assertWindowsPrivateDirectoryStable(input.directory);
      await handle.close();
      return { contents };
    } catch (error) {
      contents?.fill(0);
      try {
        await handle.close();
      } catch (closeError) {
        const code = (closeError as NodeJS.ErrnoException).code;
        if (code !== "EBADF") throw closeError;
      }
      throw error;
    }
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("read-check", error);
  }
}
