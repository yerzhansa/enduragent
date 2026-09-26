import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { ChatAttachmentKind, ChatAttachmentRepository } from "@enduragent/kernel/store";
import { ensureWindowsPrivateDirectory } from "../home/windows-home-policy.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SIGNATURE_BYTES = 65_536;
const COPY_BUFFER_BYTES = 1024 * 1024;
const SAFE_OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_CONVERSATION_KEY = /^[0-9a-f]{64}$/u;

export type AttachmentAdmissionRejection =
  | "empty_file"
  | "file_too_large"
  | "format_unsupported"
  | "signature_mismatch"
  | "unsafe_source"
  | "validation_failed";

export class ManagedAttachmentSourceError extends Error {
  constructor(readonly reason: AttachmentAdmissionRejection) {
    super("attachment source was rejected");
    this.name = "ManagedAttachmentSourceError";
  }
}

interface SourceIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

export interface InspectedChatAttachmentSource {
  readonly sourcePath: string;
  readonly identity: SourceIdentity;
  readonly displayName: string;
  readonly extension: string;
  readonly kind: ChatAttachmentKind;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface ManagedChatAttachmentStore {
  inspectNativeSource(sourcePath: string): Promise<InspectedChatAttachmentSource>;
  copyInspectedSource(input: {
    readonly source: InspectedChatAttachmentSource;
    readonly relativePath: string;
  }): Promise<void>;
  stagePrivateBytes(input: {
    readonly displayName: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly sourcePath: string; readonly displayName: string }>;
  removeStagedSource(sourcePath: string): Promise<void>;
  readObjectBytes(input: {
    readonly relativePath: string;
    readonly byteSize: number;
    readonly sha256: string;
  }): Promise<Uint8Array>;
  removeObject(relativePath: string): Promise<void>;
  reconcile(
    repository: ChatAttachmentRepository,
    orphanGraceMs: number,
  ): Promise<{
    readonly missing: number;
    readonly interruptedReservations: number;
    readonly orphansRemoved: number;
  }>;
}

export interface ManagedChatAttachmentStoreOptions {
  readonly archiveDir: string;
  readonly kindByteLimits: Readonly<Record<ChatAttachmentKind, number>>;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly randomBytes?: typeof nodeRandomBytes;
}

const FORMAT: Readonly<
  Record<string, { readonly kind: ChatAttachmentKind; readonly mediaType: string }>
> = {
  pdf: { kind: "document", mediaType: "application/pdf" },
  txt: { kind: "document", mediaType: "text/plain" },
  csv: { kind: "document", mediaType: "text/csv" },
  docx: {
    kind: "document",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  fit: { kind: "activity", mediaType: "application/vnd.ant.fit" },
  tcx: { kind: "activity", mediaType: "application/vnd.garmin.tcx+xml" },
  gpx: { kind: "activity", mediaType: "application/gpx+xml" },
  zwo: { kind: "workout", mediaType: "application/vnd.zwift.workout+xml" },
  mrc: { kind: "workout", mediaType: "text/plain" },
  erg: { kind: "workout", mediaType: "text/plain" },
  png: { kind: "image", mediaType: "image/png" },
  jpg: { kind: "image", mediaType: "image/jpeg" },
  jpeg: { kind: "image", mediaType: "image/jpeg" },
  webp: { kind: "image", mediaType: "image/webp" },
};

const UTF8_EXTENSIONS = new Set(["txt", "csv", "tcx", "gpx", "zwo", "mrc", "erg"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function sourceIdentity(metadata: Awaited<ReturnType<typeof lstat>>): SourceIdentity {
  return {
    dev: Number(metadata.dev),
    ino: Number(metadata.ino),
    size: Number(metadata.size),
    mtimeMs: Number(metadata.mtimeMs),
    ctimeMs: Number(metadata.ctimeMs),
    birthtimeMs: Number(metadata.birthtimeMs),
  };
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function assertOrdinaryFile(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ManagedAttachmentSourceError("unsafe_source");
  }
}

function signatureMatches(extension: string, head: Uint8Array): boolean {
  const bytes = Buffer.from(head);
  if (extension === "pdf") return bytes.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (extension === "png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === "jpg" || extension === "jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === "webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (extension === "fit") {
    return (
      bytes.length >= 12 &&
      (bytes[0] === 12 || bytes[0] === 14) &&
      bytes.subarray(8, 12).toString("ascii") === ".FIT"
    );
  }
  if (extension === "docx") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
        (bytes[2] === 0x05 && bytes[3] === 0x06) ||
        (bytes[2] === 0x07 && bytes[3] === 0x08))
    );
  }
  const text = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  if (extension === "txt" || extension === "csv") return !text.includes("\0");
  if (extension === "mrc" || extension === "erg") {
    return /^\s*\[COURSE HEADER\]/imu.test(text) && /\[COURSE DATA\]/iu.test(text);
  }
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) return false;
  const withoutDeclaration = text.replace(/^\s*<\?xml[^?]*\?>/iu, "").trimStart();
  if (extension === "tcx")
    return /^<(?:[A-Za-z_][\w.-]*:)?TrainingCenterDatabase(?:\s|>)/u.test(withoutDeclaration);
  if (extension === "gpx") return /^<(?:[A-Za-z_][\w.-]*:)?gpx(?:\s|>)/u.test(withoutDeclaration);
  if (extension === "zwo")
    return /^<(?:[A-Za-z_][\w.-]*:)?workout_file(?:\s|>)/u.test(withoutDeclaration);
  return false;
}

function managedRelativePath(conversationKey: string, objectId: string): string {
  if (!SAFE_CONVERSATION_KEY.test(conversationKey) || !SAFE_OBJECT_ID.test(objectId)) {
    throw new TypeError("managed attachment path is invalid");
  }
  return `chat-attachments/${conversationKey}/${objectId}`;
}

function resolveManagedPath(archiveDir: string, relativePath: string): string {
  const normalized = relativePath.split("/");
  if (
    normalized.length !== 3 ||
    normalized[0] !== "chat-attachments" ||
    !SAFE_CONVERSATION_KEY.test(normalized[1]!) ||
    !SAFE_OBJECT_ID.test(normalized[2]!)
  )
    throw new TypeError("managed attachment path is invalid");
  const full = resolve(archiveDir, ...normalized);
  const root = resolve(archiveDir);
  if (!full.startsWith(`${root}${sep}`))
    throw new TypeError("managed attachment path escaped the archive");
  return full;
}

async function ensurePosixPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory())
    throw new TypeError("managed attachment directory is unsafe");
  const physical = await realpath(path);
  if (physical !== resolve(path))
    throw new TypeError("managed attachment directory escaped its root");
  const after = await lstat(path);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.isSymbolicLink() ||
    !after.isDirectory()
  ) {
    throw new TypeError("managed attachment directory changed identity");
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function syncDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function createManagedChatAttachmentStore(
  options: ManagedChatAttachmentStoreOptions,
): ManagedChatAttachmentStore {
  if (!isAbsolute(options.archiveDir))
    throw new TypeError("attachment archive path must be absolute");
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const attachmentRoot = join(options.archiveDir, "chat-attachments");
  const ingressRoot = join(attachmentRoot, ".ingress");

  const ensureDirectory = async (path: string): Promise<void> => {
    if (platform === "win32") {
      await ensureWindowsPrivateDirectory(path);
      return;
    }
    await ensurePosixPrivateDirectory(path);
  };

  const ensureManagedDirectory = async (conversationKey?: string): Promise<string> => {
    await ensureDirectory(options.archiveDir);
    await ensureDirectory(attachmentRoot);
    if (conversationKey === undefined) return attachmentRoot;
    if (!SAFE_CONVERSATION_KEY.test(conversationKey))
      throw new TypeError("conversation key is invalid");
    const path = join(attachmentRoot, conversationKey);
    await ensureDirectory(path);
    return path;
  };

  const inspectNativeSource = async (
    sourcePath: string,
  ): Promise<InspectedChatAttachmentSource> => {
    if (!isAbsolute(sourcePath)) throw new ManagedAttachmentSourceError("unsafe_source");
    const displayName = basename(sourcePath);
    if (displayName.length < 1 || displayName.length > 512) {
      throw new ManagedAttachmentSourceError("validation_failed");
    }
    const extension = extname(displayName).slice(1).toLowerCase();
    const format = FORMAT[extension];
    if (format === undefined) throw new ManagedAttachmentSourceError("format_unsupported");

    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(sourcePath);
    } catch {
      throw new ManagedAttachmentSourceError("unsafe_source");
    }
    assertOrdinaryFile(before);
    if (before.size === 0) throw new ManagedAttachmentSourceError("empty_file");
    if (before.size > options.kindByteLimits[format.kind]) {
      throw new ManagedAttachmentSourceError("file_too_large");
    }
    const identity = sourceIdentity(before);
    let handle: FileHandle | undefined;
    try {
      const flags = constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW);
      handle = await open(sourcePath, flags);
      const opened = await handle.stat();
      assertOrdinaryFile(opened);
      if (!sameIdentity(identity, sourceIdentity(opened)))
        throw new ManagedAttachmentSourceError("unsafe_source");
      const hash = createHash("sha256");
      const decoder = UTF8_EXTENSIONS.has(extension)
        ? new TextDecoder("utf-8", { fatal: true })
        : undefined;
      const head = Buffer.allocUnsafe(Math.min(SIGNATURE_BYTES, identity.size));
      let headBytes = 0;
      let offset = 0;
      const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, identity.size));
      while (offset < identity.size) {
        const result = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, identity.size - offset),
          offset,
        );
        if (result.bytesRead === 0) break;
        const chunk = buffer.subarray(0, result.bytesRead);
        hash.update(chunk);
        if (headBytes < head.length) {
          const copied = Math.min(head.length - headBytes, chunk.length);
          chunk.copy(head, headBytes, 0, copied);
          headBytes += copied;
        }
        if (decoder !== undefined) {
          try {
            decoder.decode(chunk, { stream: true });
          } catch {
            throw new ManagedAttachmentSourceError("validation_failed");
          }
        }
        offset += result.bytesRead;
      }
      if (offset !== identity.size) throw new ManagedAttachmentSourceError("unsafe_source");
      if (decoder !== undefined) {
        try {
          decoder.decode();
        } catch {
          throw new ManagedAttachmentSourceError("validation_failed");
        }
      }
      const afterRead = await handle.stat();
      if (!sameIdentity(identity, sourceIdentity(afterRead)))
        throw new ManagedAttachmentSourceError("unsafe_source");
      await handle.close();
      handle = undefined;
      const afterPath = await lstat(sourcePath);
      assertOrdinaryFile(afterPath);
      if (!sameIdentity(identity, sourceIdentity(afterPath)))
        throw new ManagedAttachmentSourceError("unsafe_source");
      if (!signatureMatches(extension, head.subarray(0, headBytes))) {
        throw new ManagedAttachmentSourceError("signature_mismatch");
      }
      return {
        sourcePath,
        identity,
        displayName,
        extension,
        kind: format.kind,
        mediaType: format.mediaType,
        byteSize: identity.size,
        sha256: hash.digest("hex"),
      };
    } catch (error) {
      if (error instanceof ManagedAttachmentSourceError) throw error;
      throw new ManagedAttachmentSourceError("unsafe_source");
    } finally {
      try {
        await handle?.close();
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED")
          )
        )
          handle = undefined;
      }
    }
  };

  return {
    inspectNativeSource,

    async copyInspectedSource({ source, relativePath }) {
      const finalPath = resolveManagedPath(options.archiveDir, relativePath);
      const conversationKey = relativePath.split("/")[1]!;
      const directory = await ensureManagedDirectory(conversationKey);
      if (dirname(finalPath) !== directory)
        throw new TypeError("managed attachment target is invalid");
      const temporaryPath = `${finalPath}.tmp.${randomBytes(8).toString("hex")}`;
      let sourceHandle: FileHandle | undefined;
      let targetHandle: FileHandle | undefined;
      try {
        const sourceFlags = constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW);
        sourceHandle = await open(source.sourcePath, sourceFlags);
        const opened = await sourceHandle.stat();
        assertOrdinaryFile(opened);
        if (!sameIdentity(source.identity, sourceIdentity(opened))) {
          throw new ManagedAttachmentSourceError("unsafe_source");
        }
        const targetFlags =
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (platform === "win32" ? 0 : constants.O_NOFOLLOW);
        targetHandle = await open(temporaryPath, targetFlags, PRIVATE_FILE_MODE);
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, source.byteSize));
        let offset = 0;
        while (offset < source.byteSize) {
          const read = await sourceHandle.read(
            buffer,
            0,
            Math.min(buffer.length, source.byteSize - offset),
            offset,
          );
          if (read.bytesRead === 0) break;
          const chunk = buffer.subarray(0, read.bytesRead);
          hash.update(chunk);
          await targetHandle.write(chunk, 0, chunk.length, offset);
          offset += read.bytesRead;
        }
        const afterRead = await sourceHandle.stat();
        if (
          offset !== source.byteSize ||
          !sameIdentity(source.identity, sourceIdentity(afterRead)) ||
          hash.digest("hex") !== source.sha256
        )
          throw new ManagedAttachmentSourceError("unsafe_source");
        await targetHandle.sync();
        await targetHandle.close();
        targetHandle = undefined;
        await sourceHandle.close();
        sourceHandle = undefined;
        const afterPath = await lstat(source.sourcePath);
        assertOrdinaryFile(afterPath);
        if (!sameIdentity(source.identity, sourceIdentity(afterPath))) {
          throw new ManagedAttachmentSourceError("unsafe_source");
        }
        await rename(temporaryPath, finalPath);
        if (platform !== "win32") await chmod(finalPath, PRIVATE_FILE_MODE);
        await syncDirectory(directory, platform);
      } catch (error) {
        try {
          await sourceHandle?.close();
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED")
            )
          )
            throw error;
        }
        try {
          await targetHandle?.close();
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED")
            )
          )
            throw error;
        }
        await removeIfPresent(temporaryPath);
        throw error;
      }
    },

    async stagePrivateBytes({ displayName, bytes }) {
      if (displayName.length < 1 || displayName.length > 512 || bytes.byteLength === 0) {
        throw new ManagedAttachmentSourceError(
          bytes.byteLength === 0 ? "empty_file" : "validation_failed",
        );
      }
      await ensureManagedDirectory();
      await ensureDirectory(ingressRoot);
      const extension = extname(displayName).toLowerCase();
      const format = FORMAT[extension.slice(1)];
      if (format === undefined) throw new ManagedAttachmentSourceError("format_unsupported");
      if (bytes.byteLength > options.kindByteLimits[format.kind]) {
        throw new ManagedAttachmentSourceError("file_too_large");
      }
      const path = join(ingressRoot, `${randomBytes(16).toString("hex")}${extension}`);
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      try {
        await handle.writeFile(Buffer.from(bytes));
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (platform !== "win32") await chmod(path, PRIVATE_FILE_MODE);
      await syncDirectory(ingressRoot, platform);
      return { sourcePath: path, displayName };
    },

    async removeStagedSource(sourcePath) {
      const ingress = resolve(ingressRoot);
      const target = resolve(sourcePath);
      if (dirname(target) !== ingress || !target.startsWith(`${ingress}${sep}`)) {
        throw new TypeError("staged attachment path is invalid");
      }
      await removeIfPresent(target);
    },

    async readObjectBytes({ relativePath, byteSize, sha256 }) {
      if (!Number.isSafeInteger(byteSize) || byteSize < 1 || !/^[0-9a-f]{64}$/u.test(sha256)) {
        throw new TypeError("managed attachment identity is invalid");
      }
      const path = resolveManagedPath(options.archiveDir, relativePath);
      let before: Awaited<ReturnType<typeof lstat>>;
      try {
        before = await lstat(path);
      } catch {
        throw new ManagedAttachmentSourceError("unsafe_source");
      }
      assertOrdinaryFile(before);
      if (before.size !== byteSize) throw new ManagedAttachmentSourceError("unsafe_source");
      const identity = sourceIdentity(before);
      let handle: FileHandle | undefined;
      try {
        const flags = constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW);
        handle = await open(path, flags);
        const opened = await handle.stat();
        assertOrdinaryFile(opened);
        if (!sameIdentity(identity, sourceIdentity(opened))) {
          throw new ManagedAttachmentSourceError("unsafe_source");
        }
        const bytes = Buffer.allocUnsafe(byteSize);
        let offset = 0;
        while (offset < byteSize) {
          const result = await handle.read(bytes, offset, byteSize - offset, offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        const afterRead = await handle.stat();
        if (
          offset !== byteSize ||
          !sameIdentity(identity, sourceIdentity(afterRead)) ||
          createHash("sha256").update(bytes).digest("hex") !== sha256
        ) {
          throw new ManagedAttachmentSourceError("unsafe_source");
        }
        await handle.close();
        handle = undefined;
        const afterPath = await lstat(path);
        assertOrdinaryFile(afterPath);
        if (!sameIdentity(identity, sourceIdentity(afterPath))) {
          throw new ManagedAttachmentSourceError("unsafe_source");
        }
        return bytes;
      } catch (error) {
        if (error instanceof ManagedAttachmentSourceError) throw error;
        throw new ManagedAttachmentSourceError("unsafe_source");
      } finally {
        try {
          await handle?.close();
        } catch (error) {
          if (
            !(
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED")
            )
          )
            handle = undefined;
        }
      }
    },

    async removeObject(relativePath) {
      const path = resolveManagedPath(options.archiveDir, relativePath);
      await removeIfPresent(path);
      try {
        await rmdir(dirname(path));
      } catch (error) {
        if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "ENOENT") throw error;
      }
    },

    async reconcile(repository, orphanGraceMs) {
      if (!Number.isSafeInteger(orphanGraceMs) || orphanGraceMs < 0)
        throw new TypeError("orphan grace is invalid");
      await ensureManagedDirectory();
      let missing = 0;
      let interruptedReservations = 0;
      let orphansRemoved = 0;
      for (const object of await repository.listObjects()) {
        const path = resolveManagedPath(options.archiveDir, object.relative_path);
        let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          metadata = await lstat(path);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        const valid =
          metadata !== undefined &&
          metadata.isFile() &&
          !metadata.isSymbolicLink() &&
          metadata.size === object.byte_size;
        if (object.status === "durable" && !valid) {
          await repository.markObjectMissing(object.id, now());
          missing += 1;
        } else if (object.status === "reserved") {
          await repository.failObject(object.id, "admission_interrupted", now());
          await repository.deleteFailedObject(object.id);
          interruptedReservations += 1;
        } else if (
          object.status === "failed" &&
          metadata !== undefined &&
          valid &&
          now() - Number(metadata.mtimeMs) >= orphanGraceMs
        ) {
          await removeIfPresent(path);
          await repository.deleteFailedObject(object.id);
          orphansRemoved += 1;
        }
      }

      const visit = async (directory: string, conversationKey?: string): Promise<void> => {
        let entries: import("node:fs").Dirent<string>[];
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (errorCode(error) === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (conversationKey === undefined && entry.name === ".ingress" && entry.isDirectory()) {
            await visit(path, ".ingress");
            continue;
          }
          if (
            conversationKey === undefined &&
            entry.isDirectory() &&
            SAFE_CONVERSATION_KEY.test(entry.name)
          ) {
            await visit(path, entry.name);
            continue;
          }
          if (!entry.isFile()) continue;
          const metadata = await lstat(path);
          const oldEnough = now() - metadata.mtimeMs >= orphanGraceMs;
          const temporary = entry.name.includes(".tmp.") || conversationKey === ".ingress";
          const known =
            !temporary &&
            SAFE_OBJECT_ID.test(entry.name) &&
            (await repository.hasObject(entry.name));
          if (!known && oldEnough) {
            await removeIfPresent(path);
            orphansRemoved += 1;
          }
        }
      };
      await visit(attachmentRoot);
      return { missing, interruptedReservations, orphansRemoved };
    },
  };
}

export function chatAttachmentRelativePath(conversationKey: string, objectId: string): string {
  return managedRelativePath(conversationKey, objectId);
}
