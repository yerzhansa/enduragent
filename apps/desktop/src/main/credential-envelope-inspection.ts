import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { WindowsPrivateDirectoryBinding } from "@enduragent/core";
import {
  CREDENTIAL_ENVELOPE_INSPECTION_BYTES,
  KEYCHAIN_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./credential-envelope-format.js";
import { readWindowsPrivateFilePrefix } from "./windows-private-file.js";

export type CredentialEnvelopeVault = "credentials" | "telegram";

export interface CredentialEnvelopeTarget {
  readonly vault: CredentialEnvelopeVault;
  readonly root: string;
  readonly fileName: string;
  readonly mode: number;
}

export type CredentialEnvelopeInspection =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "readable"; contents: Buffer }>
  | Readonly<{ status: "blocked" }>;

export type CredentialEnvelopeRemovalState =
  | "missing"
  | "blocked"
  | "keychain-dependent"
  | "unverified";

export interface InspectCredentialEnvelopeTargetOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsDirectory?: WindowsPrivateDirectoryBinding;
  readonly openFile?: typeof open;
}

function permissions(mode: number): number {
  return mode & 0o777;
}

function safePosixEnvelopeMetadata(metadata: Stats, expectedMode: number): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    permissions(metadata.mode) === expectedMode &&
    (typeof process.getuid !== "function" || metadata.uid === process.getuid())
  );
}

function samePosixEnvelopeMetadata(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.uid === second.uid &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs &&
    first.isFile() === second.isFile() &&
    first.isSymbolicLink() === second.isSymbolicLink()
  );
}

async function inspectPosixCredentialEnvelopeTarget(
  target: CredentialEnvelopeTarget,
  openFile: typeof open = open,
): Promise<CredentialEnvelopeInspection> {
  const path = join(target.root, target.fileName);
  let beforeOpen: Stats;
  try {
    beforeOpen = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "blocked" };
  }
  if (!safePosixEnvelopeMetadata(beforeOpen, target.mode)) return { status: "blocked" };
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await openFile(path, flags);
  } catch {
    return { status: "blocked" };
  }
  let prefix: Buffer | undefined;
  try {
    const opened = await handle.stat();
    if (
      !safePosixEnvelopeMetadata(opened, target.mode) ||
      !samePosixEnvelopeMetadata(beforeOpen, opened) ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0
    ) {
      return { status: "blocked" };
    }
    const prefixBytes = Math.min(opened.size, CREDENTIAL_ENVELOPE_INSPECTION_BYTES);
    prefix = Buffer.allocUnsafe(prefixBytes);
    let offset = 0;
    while (offset < prefix.length) {
      const read = await handle.read(prefix, offset, prefix.length - offset, offset);
      if (read.bytesRead <= 0) return { status: "blocked" };
      offset += read.bytesRead;
    }
    const afterRead = await handle.stat();
    let current: Stats;
    try {
      current = await lstat(path);
    } catch {
      return { status: "blocked" };
    }
    if (
      !safePosixEnvelopeMetadata(afterRead, target.mode) ||
      !safePosixEnvelopeMetadata(current, target.mode) ||
      !samePosixEnvelopeMetadata(beforeOpen, afterRead) ||
      !samePosixEnvelopeMetadata(afterRead, current)
    ) {
      return { status: "blocked" };
    }
    await handle.close();
    handle = undefined;
    return { status: "readable", contents: Buffer.from(prefix) };
  } catch {
    return { status: "blocked" };
  } finally {
    prefix?.fill(0);
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

export async function inspectCredentialEnvelopeTarget(
  target: CredentialEnvelopeTarget,
  options: InspectCredentialEnvelopeTargetOptions = {},
): Promise<CredentialEnvelopeInspection> {
  if ((options.platform ?? process.platform) !== "win32") {
    return await inspectPosixCredentialEnvelopeTarget(target, options.openFile);
  }
  if (options.windowsDirectory === undefined) {
    try {
      await lstat(join(target.root, target.fileName));
      return { status: "blocked" };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "missing" }
        : { status: "blocked" };
    }
  }
  let prefix: Buffer | undefined;
  try {
    const snapshot = await readWindowsPrivateFilePrefix({
      directory: options.windowsDirectory,
      path: join(target.root, target.fileName),
      maximumReadBytes: CREDENTIAL_ENVELOPE_INSPECTION_BYTES,
      openFile: options.openFile,
    });
    if (snapshot === undefined) return { status: "missing" };
    prefix = snapshot.contents;
    return { status: "readable", contents: Buffer.from(prefix) };
  } catch {
    return { status: "blocked" };
  } finally {
    prefix?.fill(0);
  }
}

export async function classifyCredentialEnvelopeRemoval(
  target: CredentialEnvelopeTarget,
  options: InspectCredentialEnvelopeTargetOptions = {},
): Promise<CredentialEnvelopeRemovalState> {
  const inspected = await inspectCredentialEnvelopeTarget(target, options);
  if (inspected.status !== "readable") return inspected.status;
  try {
    return readCredentialEnvelopeKeyId(inspected.contents) === KEYCHAIN_ENVELOPE_KEY_ID
      ? "keychain-dependent"
      : "unverified";
  } finally {
    inspected.contents.fill(0);
  }
}
