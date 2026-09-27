import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  windowsPrivatePathIdentity,
  WindowsPrivatePathPolicyError,
  type WindowsPrivateDirectoryBinding,
  type WindowsPrivatePathIdentity,
  type WindowsPrivatePathPolicyStage,
} from "@enduragent/core";

export type DurableReplaceOutcome =
  | Readonly<{ state: "not-committed" }>
  | Readonly<{ state: "durably-committed" }>
  | Readonly<{ state: "commit-uncertain" }>;

export interface DurableAtomicReplaceInput {
  readonly root: string;
  readonly fileName: string;
  readonly contents: string | Buffer;
  readonly mode: number;
  readonly platform?: NodeJS.Platform;
  readonly createId?: () => string;
  readonly openFile?: typeof open;
  readonly openDirectory?: typeof open;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
}

export type ReversibleDurableReplaceOutcome =
  | Readonly<{ state: "applied" }>
  | Readonly<{ state: "refused" }>
  | Readonly<{ state: "uncertain" }>;

export interface ReversibleDurableReplaceInput extends DurableAtomicReplaceInput {
  readonly previousContents: Buffer | undefined;
  readonly readCurrent?: (target: string) => Promise<Buffer | undefined>;
}

export async function syncDirectory(
  root: string,
  openDirectory: typeof open = open,
): Promise<void> {
  const directory = await openDirectory(root, "r");
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
}

export async function durableAtomicReplace(
  input: DurableAtomicReplaceInput,
): Promise<DurableReplaceOutcome> {
  if (
    input.root.length === 0 ||
    input.fileName.length === 0 ||
    basename(input.fileName) !== input.fileName
  ) {
    throw new TypeError("invalid durable replacement target");
  }
  const platform = input.platform ?? process.platform;
  const createId = input.createId ?? randomUUID;
  let id: string;
  try {
    id = createId();
  } catch (error) {
    if (platform === "win32") {
      throw classifyWindowsPrivatePathFailure("content-write", error);
    }
    throw error;
  }
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new TypeError("invalid durable replacement temporary id");
  }
  const openFile = input.openFile ?? open;
  const renameFile = input.renameFile ?? rename;
  const removeFile = input.removeFile ?? rm;
  const sync =
    input.syncDirectory ??
    ((root: string): Promise<void> => syncDirectory(root, input.openDirectory ?? open));
  const target = join(input.root, input.fileName);
  const temporary = join(input.root, `.${input.fileName}.${id}.tmp`);
  const contents = Buffer.isBuffer(input.contents)
    ? Buffer.from(input.contents)
    : Buffer.from(input.contents, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  let stage: WindowsPrivatePathPolicyStage = "content-write";
  let windowsDirectory: WindowsPrivateDirectoryBinding | undefined;
  let windowsTemporaryIdentity: WindowsPrivatePathIdentity | undefined;
  try {
    if (platform === "win32") {
      windowsDirectory = bindWindowsPrivateDirectory(dirname(input.root), input.root);
    }
    handle = await openFile(temporary, "wx", input.mode);
    if (platform === "win32") {
      const opened = await handle.stat();
      assertWindowsPrivateFileMetadata(opened);
      windowsTemporaryIdentity = windowsPrivatePathIdentity(opened);
      assertWindowsPrivateFileBinding(windowsDirectory!, temporary, windowsTemporaryIdentity);
    }
    await handle.writeFile(contents);
    if (platform === "win32") {
      const written = await handle.stat();
      assertWindowsPrivateFileMetadata(written);
      if (
        !sameWindowsPrivatePathIdentity(
          windowsTemporaryIdentity!,
          windowsPrivatePathIdentity(written),
        )
      ) {
        throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
      }
      assertWindowsPrivateFileBinding(windowsDirectory!, temporary, windowsTemporaryIdentity!);
    } else {
      await handle.chmod(input.mode);
    }
    stage = "file-flush";
    await handle.sync();
    if (platform === "win32") {
      const flushed = await handle.stat();
      assertWindowsPrivateFileMetadata(flushed);
      if (
        !sameWindowsPrivatePathIdentity(
          windowsTemporaryIdentity!,
          windowsPrivatePathIdentity(flushed),
        )
      ) {
        throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
      }
      assertWindowsPrivateFileBinding(windowsDirectory!, temporary, windowsTemporaryIdentity!);
      assertWindowsPrivateDirectoryStable(windowsDirectory!);
    }
    await handle.close();
    handle = undefined;
    stage = "rename";
    await renameFile(temporary, target);
    renamed = true;
    if (platform === "win32") {
      assertWindowsPrivateFileBinding(windowsDirectory!, target, windowsTemporaryIdentity!);
      assertWindowsPrivateDirectoryStable(windowsDirectory!);
      if (classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable") {
        return { state: "durably-committed" };
      }
    }
    await sync(input.root);
    return { state: "durably-committed" };
  } catch (error) {
    if (platform === "win32" && !renamed) {
      throw classifyWindowsPrivatePathFailure(stage, error);
    }
    return { state: renamed ? "commit-uncertain" : "not-committed" };
  } finally {
    contents.fill(0);
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBADF") handle = undefined;
      }
    }
    await removeFile(temporary, { force: true });
  }
}

interface DurableAtomicRemoveInput {
  readonly root: string;
  readonly fileName: string;
  readonly platform?: NodeJS.Platform;
  readonly createId?: () => string;
  readonly openDirectory?: typeof open;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
}

async function durableAtomicRemove(
  input: DurableAtomicRemoveInput,
): Promise<DurableReplaceOutcome> {
  const platform = input.platform ?? process.platform;
  const createId = input.createId ?? randomUUID;
  let id: string;
  try {
    id = createId();
  } catch (error) {
    if (platform === "win32") {
      throw classifyWindowsPrivatePathFailure("content-write", error);
    }
    throw error;
  }
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new TypeError("invalid durable removal temporary id");
  }
  const renameFile = input.renameFile ?? rename;
  const removeFile = input.removeFile ?? rm;
  const sync =
    input.syncDirectory ??
    ((root: string): Promise<void> => syncDirectory(root, input.openDirectory ?? open));
  const target = join(input.root, input.fileName);
  const tombstone = join(input.root, `.${input.fileName}.${id}.deleted`);
  let windowsDirectory: WindowsPrivateDirectoryBinding | undefined;
  let windowsTargetIdentity: WindowsPrivatePathIdentity | undefined;
  try {
    if (platform === "win32") {
      windowsDirectory = bindWindowsPrivateDirectory(dirname(input.root), input.root);
      const targetMetadata = await lstat(target);
      assertWindowsPrivateFileMetadata(targetMetadata);
      windowsTargetIdentity = windowsPrivatePathIdentity(targetMetadata);
      assertWindowsPrivateFileBinding(windowsDirectory, target, windowsTargetIdentity);
    }
    await renameFile(target, tombstone);
    if (platform === "win32") {
      assertWindowsPrivateFileBinding(windowsDirectory!, tombstone, windowsTargetIdentity!);
      assertWindowsPrivateDirectoryStable(windowsDirectory!);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (platform === "win32") {
        throw classifyWindowsPrivatePathFailure("rename", error);
      }
      return { state: "not-committed" };
    }
  }
  if (
    platform !== "win32" ||
    classifyWindowsPrivatePathDurability("directory-sync").kind !== "unavailable"
  ) {
    try {
      await sync(input.root);
    } catch {
      return { state: "commit-uncertain" };
    }
  }
  await removeFile(tombstone, { force: true });
  if (
    platform !== "win32" ||
    classifyWindowsPrivatePathDurability("directory-sync").kind !== "unavailable"
  ) {
    try {
      await sync(input.root);
    } catch {
      return { state: "commit-uncertain" };
    }
  }
  return { state: "durably-committed" };
}

async function readVisibleFile(target: string): Promise<Buffer | undefined> {
  try {
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function durablyReplaceReversible(
  input: ReversibleDurableReplaceInput,
): Promise<ReversibleDurableReplaceOutcome> {
  let operationId: string;
  try {
    operationId = (input.createId ?? randomUUID)();
  } catch {
    return { state: "refused" };
  }
  if (!/^[A-Za-z0-9-]{1,128}$/.test(operationId)) return { state: "refused" };
  const operationInput = { ...input, createId: () => operationId };
  const candidate = Buffer.isBuffer(input.contents)
    ? Buffer.from(input.contents)
    : Buffer.from(input.contents, "utf8");
  const previous =
    input.previousContents === undefined ? undefined : Buffer.from(input.previousContents);
  const replace = (contents: Buffer): Promise<DurableReplaceOutcome> =>
    durableAtomicReplace({ ...operationInput, contents });
  const restorePrevious = (): Promise<DurableReplaceOutcome> =>
    previous === undefined
      ? durableAtomicRemove(operationInput)
      : durableAtomicReplace({ ...operationInput, contents: previous });
  try {
    const initial = await replace(candidate);
    if (initial.state === "durably-committed") return { state: "applied" };
    if (initial.state === "not-committed") return { state: "refused" };

    let compensation: DurableReplaceOutcome;
    try {
      compensation = await restorePrevious();
    } catch {
      return { state: "uncertain" };
    }
    if (compensation.state === "durably-committed") return { state: "refused" };

    let current: Buffer | undefined;
    try {
      current = await (input.readCurrent ?? readVisibleFile)(join(input.root, input.fileName));
    } catch {
      return { state: "uncertain" };
    }
    try {
      const previousVisible =
        previous === undefined ? current === undefined : current?.equals(previous) === true;
      if (previousVisible) {
        let convergedPrevious: DurableReplaceOutcome;
        try {
          convergedPrevious = await restorePrevious();
        } catch {
          return { state: "uncertain" };
        }
        return convergedPrevious.state === "durably-committed"
          ? { state: "refused" }
          : { state: "uncertain" };
      }
      if (current?.equals(candidate) === true) {
        let convergedCandidate: DurableReplaceOutcome;
        try {
          convergedCandidate = await replace(candidate);
        } catch {
          return { state: "uncertain" };
        }
        return convergedCandidate.state === "durably-committed"
          ? { state: "applied" }
          : { state: "uncertain" };
      }
      return { state: "uncertain" };
    } finally {
      current?.fill(0);
    }
  } finally {
    candidate.fill(0);
    previous?.fill(0);
  }
}
