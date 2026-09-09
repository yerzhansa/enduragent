import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  copyFileSync,
  existsSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type { ModelMessage } from "ai";
import type { ChatLineage } from "@enduragent/engine";
import type {
  RequestUserDecisionInput,
  RequestUserDecisionResult,
} from "@enduragent/coach-contract";
import { messageText } from "@enduragent/engine/sport";
import {
  UNKNOWN_PROVENANCE,
  getMessageProvenance,
  isSourceProvenance,
  setMessageProvenance,
  type SourceProvenance,
} from "../provenance.js";
import {
  WindowsPrivatePathPolicyError,
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  windowsPrivatePathIdentity,
  type WindowsPrivateDirectoryBinding,
  type WindowsPrivatePathPolicyStage,
} from "../io/windows-private-path-policy.js";

const MS_PER_DAY = 86_400_000;
export const MAX_CHAT_SESSION_BYTES = 67_108_864;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// Recorded in history when a turn fails before producing a reply, so the
// athlete's (durably persisted) message is visibly unanswered rather than
// silently dangling.
export const TURN_FAILURE_MARKER =
  "[This turn did not complete — the message above was not answered.]";

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface ChatStoreHooks {
  readonly rename?: typeof renameSync;
  readonly syncFile?: (descriptor: number) => void;
  readonly syncDirectory?: (descriptor: number) => void;
}

interface ChatStoreOptions {
  readonly platform?: NodeJS.Platform;
}

type DirectoryDescriptor = number | null;

interface DurableChatReset {
  readonly resetId: string;
  readonly boundaryAt: string;
  readonly flushPending?: boolean;
}

export interface UnflushedResetArchive {
  readonly archiveRef: string;
  readonly messages: ModelMessage[];
}

const RESET_ARCHIVE_REF_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.[a-f0-9]{64}$/;

const DURABLE_RESET_OPERATIONS = new WeakMap<
  ChatStore,
  (chatId: string, reset: DurableChatReset) => void
>();
const CHAT_STORE_HOOKS = new WeakMap<ChatStore, ChatStoreHooks>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function identity(stats: import("node:fs").Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isStrictPrivateDirectory(stats: import("node:fs").Stats): boolean {
  return !stats.isSymbolicLink() && stats.isDirectory() && (stats.mode & 0o7777) === 0o700;
}

function isStrictPrivateFile(stats: import("node:fs").Stats, links: 1 | 2): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isFile() &&
    (stats.mode & 0o7777) === 0o600 &&
    stats.nlink === links
  );
}

function parseArchiveTimestampMs(suffix: string): number | null {
  // archiveAndReset writes toISOString() with ":" replaced by "-"; reverse
  // only the time-part dashes before parsing. Transactional reset archives
  // append a reset ID after the timestamp; it is identity, not time.
  const encodedTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)/.exec(suffix)?.[1];
  if (encodedTimestamp === undefined) return null;
  const ms = Date.parse(encodedTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));
  return Number.isNaN(ms) ? null : ms;
}

interface JsonlLine {
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  ts: string;
  decisionKey?: string;
  templateHash?: string;
  assembledHash?: string;
  provider?: string;
  model?: string;
  lineageVersion?: string;
  provenance?: SourceProvenance;
}

const VALID_ROLES = new Set(["user", "assistant", "system", "tool"]);

function isSessionContent(role: JsonlLine["role"], content: unknown): boolean {
  if (typeof content === "string") return role !== "tool";
  if (role !== "assistant" && role !== "tool") return false;
  return (
    Array.isArray(content) &&
    content.every(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        !Array.isArray(part) &&
        typeof (part as { type?: unknown }).type === "string",
    )
  );
}

function parseSessionLine(line: string): JsonlLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.role !== "string" || !VALID_ROLES.has(v.role)) return null;
  if (!isSessionContent(v.role as JsonlLine["role"], v.content) || typeof v.ts !== "string") {
    return null;
  }
  if ("decisionKey" in v && typeof v.decisionKey !== "string") return null;
  for (const k of [
    "templateHash",
    "assembledHash",
    "provider",
    "model",
    "lineageVersion",
  ] as const) {
    if (k in v && typeof v[k] !== "string") return null;
  }
  if ("provenance" in v && !isSourceProvenance(v.provenance)) {
    return { ...v, provenance: undefined } as JsonlLine;
  }
  return value as JsonlLine;
}

function messagesOf(lines: readonly JsonlLine[]): ModelMessage[] {
  return lines.map((p) =>
    setMessageProvenance(
      { role: p.role, content: p.content } as ModelMessage,
      p.role === "user" ? UNKNOWN_PROVENANCE : (p.provenance ?? UNKNOWN_PROVENANCE),
    ),
  );
}

function sameProvenance(left: SourceProvenance, right: SourceProvenance): boolean {
  return (
    left.garmin === right.garmin &&
    left.nonGarmin === right.nonGarmin &&
    left.unknown === right.unknown
  );
}

export class ChatStore {
  private readonly sessionsDir: string;
  private readonly resetArchiveRetentionDays: number;
  private readonly sessionsDirectoryIdentity: FileIdentity;
  private readonly platform: NodeJS.Platform;
  private readonly windowsDirectoryBinding: WindowsPrivateDirectoryBinding | undefined;

  constructor(dataDir: string, resetArchiveRetentionDays = 0, options: ChatStoreOptions = {}) {
    this.sessionsDir = join(dataDir, "sessions");
    this.resetArchiveRetentionDays = resetArchiveRetentionDays;
    this.platform = options.platform ?? process.platform;
    let created = false;
    try {
      mkdirSync(this.sessionsDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isExists(error)) {
        throw this.platform === "win32"
          ? classifyWindowsPrivatePathFailure("entry-check", error)
          : error;
      }
    }

    if (this.platform === "win32") {
      const binding = bindWindowsPrivateDirectory(dataDir, this.sessionsDir);
      this.windowsDirectoryBinding = binding;
      this.sessionsDirectoryIdentity = binding.identity;
    } else {
      this.windowsDirectoryBinding = undefined;
      const beforeOpen = lstatSync(this.sessionsDir);
      if (beforeOpen.isSymbolicLink() || !beforeOpen.isDirectory()) {
        throw new Error("Sessions directory is unsafe.");
      }
      let descriptor: number;
      try {
        descriptor = openSync(
          this.sessionsDir,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch {
        throw new Error("Sessions directory is unsafe.");
      }
      try {
        let hardened = true;
        if (created || !isStrictPrivateDirectory(fstatSync(descriptor))) {
          try {
            fchmodSync(descriptor, 0o700);
          } catch {
            hardened = false;
          }
        }
        const opened = fstatSync(descriptor);
        const afterOpen = lstatSync(this.sessionsDir);
        if (
          !hardened ||
          !isStrictPrivateDirectory(opened) ||
          !isStrictPrivateDirectory(afterOpen) ||
          !sameIdentity(identity(beforeOpen), identity(opened)) ||
          !sameIdentity(identity(opened), identity(afterOpen))
        ) {
          throw new Error("Sessions directory is unsafe.");
        }
        this.sessionsDirectoryIdentity = identity(opened);
      } finally {
        closeSync(descriptor);
      }
    }

    DURABLE_RESET_OPERATIONS.set(this, (chatId, reset) => {
      const path = this.filePath(chatId);
      const ts = reset.boundaryAt.replace(/:/g, "-");
      const archivePath = `${path}.reset.${ts}.${reset.resetId}`;
      this.completeDurableReset(path, archivePath);
      if (reset.flushPending === true && this.sessionExists(archivePath)) {
        this.appendSessionContent(this.flushPendingPath(chatId, `${ts}.${reset.resetId}`), "");
      }
      this.pruneArchives(chatId, "reset");
    });
  }

  private flushPendingPath(chatId: string, archiveRef: string): string {
    return `${this.filePath(chatId)}.flush-pending.${archiveRef}`;
  }

  private unlinkIfPresent(path: string): void {
    if (this.sessionExists(path)) this.unlinkSessionPath(path);
  }

  loadUnflushedResetArchive(chatId: string): UnflushedResetArchive | null {
    const path = this.filePath(chatId);
    const prefix = `${path}.flush-pending.`;
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir);
    } catch (error) {
      throw this.platform === "win32"
        ? classifyWindowsPrivatePathFailure("read-check", error)
        : error;
    }
    const markers = names
      .map((name) => join(this.sessionsDir, name))
      .filter((candidate) => candidate.startsWith(prefix))
      .sort();
    for (const marker of markers) {
      const archiveRef = marker.slice(prefix.length);
      if (!RESET_ARCHIVE_REF_PATTERN.test(archiveRef)) continue;
      const archivePath = `${path}.reset.${archiveRef}`;
      if (!this.sessionExists(archivePath)) {
        this.unlinkSessionPath(marker);
        continue;
      }
      const contents = this.readSessionText(archivePath);
      if (this.platform === "win32") this.assertWindowsSessionContent(contents);
      const parsed = contents
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(parseSessionLine)
        .filter((line): line is JsonlLine => line !== null);
      return { archiveRef, messages: messagesOf(parsed) };
    }
    return null;
  }

  markResetArchiveFlushed(chatId: string, archiveRef: string): void {
    if (!RESET_ARCHIVE_REF_PATTERN.test(archiveRef)) {
      throw new TypeError("Reset archive reference is invalid.");
    }
    this.unlinkIfPresent(this.flushPendingPath(chatId, archiveRef));
  }

  private filePath(chatId: string): string {
    const fileName = this.platform === "win32" ? this.chatDigest(chatId) : chatId;
    return join(this.sessionsDir, `${fileName}.jsonl`);
  }

  private chatDigest(chatId: string): string {
    return createHash("sha256").update(chatId, "utf8").digest("hex");
  }

  private sessionExists(path: string): boolean {
    if (this.platform !== "win32") return existsSync(path);
    return this.withSessionsDirectory((directoryDescriptor) => {
      let metadata: import("node:fs").Stats;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        if (isMissing(error)) {
          this.assertSessionsDirectoryStable(directoryDescriptor);
          return false;
        }
        throw error;
      }
      assertWindowsPrivateFileMetadata(metadata);
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        path,
        windowsPrivatePathIdentity(metadata),
      );
      return true;
    });
  }

  private openWindowsSessionFile(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    flags: number,
    allowedLinks: 1 | 2 = 1,
  ): number {
    const beforeOpen = lstatSync(path);
    assertWindowsPrivateFileMetadata(beforeOpen, allowedLinks);
    this.assertSessionsDirectoryStable(directoryDescriptor);
    const descriptor = openSync(path, flags);
    try {
      const opened = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(opened, allowedLinks);
      if (
        !sameWindowsPrivatePathIdentity(
          windowsPrivatePathIdentity(beforeOpen),
          windowsPrivatePathIdentity(opened),
        )
      ) {
        throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
      }
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        path,
        windowsPrivatePathIdentity(opened),
        allowedLinks,
      );
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private readSessionText(path: string, allowedLinks: 1 | 2 = 1): string {
    if (this.platform !== "win32") return readFileSync(path, "utf-8");
    return this.withSessionsDirectory((directoryDescriptor) => {
      const descriptor = this.openWindowsSessionFile(
        directoryDescriptor,
        path,
        constants.O_RDONLY,
        allowedLinks,
      );
      try {
        return this.readWindowsSessionDescriptor(
          directoryDescriptor,
          descriptor,
          path,
          allowedLinks,
        );
      } finally {
        closeSync(descriptor);
      }
    });
  }

  private readWindowsSessionDescriptor(
    directoryDescriptor: DirectoryDescriptor,
    descriptor: number,
    path: string,
    allowedLinks: 1 | 2 = 1,
  ): string {
    const beforeRead = fstatSync(descriptor);
    const bounded =
      Number.isSafeInteger(beforeRead.size) &&
      beforeRead.size >= 0 &&
      beforeRead.size <= MAX_CHAT_SESSION_BYTES;
    if (!bounded) {
      assertWindowsPrivatePathRead({
        bounded: false,
        identityStable: true,
        contentValid: true,
        authenticatedHomeBinding: true,
      });
    }
    const contents = Buffer.allocUnsafe(beforeRead.size);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = readSync(descriptor, contents, offset, contents.length - offset, offset);
      if (bytesRead <= 0) {
        assertWindowsPrivatePathRead({
          bounded: true,
          identityStable: true,
          contentValid: false,
          authenticatedHomeBinding: true,
        });
      }
      offset += bytesRead;
    }
    const afterRead = fstatSync(descriptor);
    assertWindowsPrivateFileMetadata(afterRead, allowedLinks);
    const current = assertWindowsPrivateFileBinding(
      this.windowsDirectoryBinding!,
      path,
      windowsPrivatePathIdentity(afterRead),
      allowedLinks,
    );
    let decoded = "";
    let contentValid = true;
    try {
      decoded = STRICT_UTF8_DECODER.decode(contents);
    } catch {
      contentValid = false;
    }
    assertWindowsPrivatePathRead({
      bounded: true,
      identityStable:
        sameWindowsPrivatePathIdentity(
          windowsPrivatePathIdentity(beforeRead),
          windowsPrivatePathIdentity(afterRead),
        ) &&
        beforeRead.size === afterRead.size &&
        beforeRead.size === current.size &&
        beforeRead.mtimeMs === afterRead.mtimeMs &&
        beforeRead.mtimeMs === current.mtimeMs &&
        beforeRead.ctimeMs === afterRead.ctimeMs &&
        beforeRead.ctimeMs === current.ctimeMs,
      contentValid,
      authenticatedHomeBinding: true,
    });
    this.assertSessionsDirectoryStable(directoryDescriptor);
    return decoded;
  }

  private assertWindowsSessionContent(contents: string): void {
    assertWindowsPrivatePathRead({
      bounded: Buffer.byteLength(contents, "utf8") <= MAX_CHAT_SESSION_BYTES,
      identityStable: true,
      contentValid:
        (contents.length === 0 || contents.endsWith("\n")) &&
        contents.split("\n").every((line) => line.trim() === "" || parseSessionLine(line) !== null),
      authenticatedHomeBinding: true,
    });
  }

  private assertWindowsSessionSize(size: number): void {
    assertWindowsPrivatePathRead({
      bounded: Number.isSafeInteger(size) && size >= 0 && size <= MAX_CHAT_SESSION_BYTES,
      identityStable: true,
      contentValid: true,
      authenticatedHomeBinding: true,
    });
  }

  private isPrivateFile(stats: import("node:fs").Stats, links: 1 | 2): boolean {
    if (this.platform === "win32") {
      assertWindowsPrivateFileMetadata(stats, links);
      return true;
    }
    return isStrictPrivateFile(stats, links);
  }

  private unsafeTarget(message: string): Error {
    return this.platform === "win32"
      ? new WindowsPrivatePathPolicyError("binding-check", "corruption")
      : new Error(message);
  }

  private createWindowsSessionFile(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    extraFlags = 0,
  ): number {
    this.assertSessionsDirectoryStable(directoryDescriptor);
    const descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | extraFlags,
      0o600,
    );
    try {
      const opened = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(opened);
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        path,
        windowsPrivatePathIdentity(opened),
      );
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private appendSessionContent(path: string, content: string): void {
    if (this.platform !== "win32") {
      appendFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
      return;
    }
    this.withSessionsDirectory((directoryDescriptor) => {
      let descriptor: number;
      let created = false;
      try {
        descriptor = this.openWindowsSessionFile(
          directoryDescriptor,
          path,
          constants.O_RDWR | constants.O_APPEND,
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          descriptor = this.createWindowsSessionFile(directoryDescriptor, path, constants.O_APPEND);
          created = true;
        } catch (createError) {
          if (!isExists(createError)) throw createError;
          descriptor = this.openWindowsSessionFile(
            directoryDescriptor,
            path,
            constants.O_RDWR | constants.O_APPEND,
          );
        }
      }
      try {
        this.assertWindowsSessionContent(
          this.readWindowsSessionDescriptor(directoryDescriptor, descriptor, path),
        );
        const beforeWrite = fstatSync(descriptor);
        const contentBytes = Buffer.byteLength(content, "utf8");
        this.assertWindowsSessionSize(beforeWrite.size);
        this.assertWindowsSessionSize(beforeWrite.size + contentBytes);
        writeFileSync(descriptor, content, "utf8");
        this.syncFile(descriptor);
        const written = fstatSync(descriptor);
        assertWindowsPrivateFileMetadata(written);
        if (written.size !== beforeWrite.size + contentBytes) {
          throw new WindowsPrivatePathPolicyError("content-write", "corruption");
        }
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(written),
        );
        if (created) this.syncDirectory(directoryDescriptor);
      } finally {
        closeSync(descriptor);
      }
    }, "content-write");
  }

  private replaceSessionContent(path: string, content: string): void {
    if (this.platform !== "win32") {
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
      renameSync(tmpPath, path);
      return;
    }
    const tmpPath = `${path}.tmp`;
    this.withSessionsDirectory((directoryDescriptor) => {
      const contentBytes = Buffer.byteLength(content, "utf8");
      this.assertWindowsSessionSize(contentBytes);
      let descriptor: number;
      try {
        descriptor = this.createWindowsSessionFile(directoryDescriptor, tmpPath);
      } catch (error) {
        if (isExists(error)) throw this.unsafeTarget("Session replacement target is unsafe.");
        throw error;
      }
      try {
        writeFileSync(descriptor, content, "utf8");
        this.syncFile(descriptor);
        const written = fstatSync(descriptor);
        assertWindowsPrivateFileMetadata(written);
        if (written.size !== contentBytes) {
          throw new WindowsPrivatePathPolicyError("content-write", "corruption");
        }
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          tmpPath,
          windowsPrivatePathIdentity(written),
        );
        if (this.sessionExists(path)) this.assertSessionsDirectoryStable(directoryDescriptor);
        try {
          (CHAT_STORE_HOOKS.get(this)?.rename ?? renameSync)(tmpPath, path);
        } catch (error) {
          throw classifyWindowsPrivatePathFailure("rename", error);
        }
        const replaced = lstatSync(path);
        assertWindowsPrivateFileMetadata(replaced);
        if (
          !sameWindowsPrivatePathIdentity(
            windowsPrivatePathIdentity(written),
            windowsPrivatePathIdentity(replaced),
          )
        ) {
          throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
        }
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(replaced),
        );
        this.syncDirectory(directoryDescriptor);
      } finally {
        closeSync(descriptor);
      }
    }, "content-write");
  }

  private renameSessionPath(source: string, target: string): void {
    if (this.platform !== "win32") {
      renameSync(source, target);
      return;
    }
    this.withSessionsDirectory((directoryDescriptor) => {
      const descriptor = this.openWindowsSessionFile(
        directoryDescriptor,
        source,
        constants.O_RDONLY,
      );
      try {
        this.assertWindowsSessionContent(
          this.readWindowsSessionDescriptor(directoryDescriptor, descriptor, source),
        );
        const beforeRename = fstatSync(descriptor);
        this.assertWindowsSessionSize(beforeRename.size);
        try {
          (CHAT_STORE_HOOKS.get(this)?.rename ?? renameSync)(source, target);
        } catch (error) {
          throw classifyWindowsPrivatePathFailure("rename", error);
        }
        const moved = lstatSync(target);
        assertWindowsPrivateFileMetadata(moved);
        if (
          !sameWindowsPrivatePathIdentity(
            windowsPrivatePathIdentity(beforeRename),
            windowsPrivatePathIdentity(moved),
          )
        ) {
          throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
        }
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          target,
          windowsPrivatePathIdentity(moved),
        );
      } finally {
        closeSync(descriptor);
      }
    }, "rename");
  }

  private unlinkSessionPath(path: string): void {
    if (this.platform !== "win32") {
      unlinkSync(path);
      return;
    }
    if (!this.sessionExists(path)) return;
    this.assertWindowsSessionContent(this.readSessionText(path));
    try {
      unlinkSync(path);
    } catch (error) {
      throw classifyWindowsPrivatePathFailure("rename", error);
    }
    this.syncSessionsDirectory();
  }

  private copySessionPath(source: string, target: string): void {
    if (this.platform !== "win32") {
      copyFileSync(source, target);
      return;
    }
    this.withSessionsDirectory((directoryDescriptor) => {
      if (!this.sessionExists(source) || this.sessionExists(target)) {
        throw this.unsafeTarget("Session archive target is unsafe.");
      }
      const sourceDescriptor = this.openWindowsSessionFile(
        directoryDescriptor,
        source,
        constants.O_RDONLY,
      );
      try {
        const sourceContent = this.readWindowsSessionDescriptor(
          directoryDescriptor,
          sourceDescriptor,
          source,
        );
        this.assertWindowsSessionContent(sourceContent);
        const sourceBefore = fstatSync(sourceDescriptor);
        this.assertWindowsSessionSize(sourceBefore.size);
        copyFileSync(source, target, constants.COPYFILE_EXCL);
        const targetDescriptor = this.openWindowsSessionFile(
          directoryDescriptor,
          target,
          constants.O_RDWR,
        );
        try {
          this.syncFile(targetDescriptor);
          const targetMetadata = fstatSync(targetDescriptor);
          if (targetMetadata.size !== sourceBefore.size) {
            throw new WindowsPrivatePathPolicyError("content-write", "corruption");
          }
        } finally {
          closeSync(targetDescriptor);
        }
        const targetContent = this.readSessionText(target);
        this.assertWindowsSessionContent(targetContent);
        if (targetContent !== sourceContent) {
          throw new WindowsPrivatePathPolicyError("content-write", "corruption");
        }
        const sourceAfter = fstatSync(sourceDescriptor);
        assertWindowsPrivateFileMetadata(sourceAfter);
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          source,
          windowsPrivatePathIdentity(sourceAfter),
        );
        if (
          !sameWindowsPrivatePathIdentity(
            windowsPrivatePathIdentity(sourceBefore),
            windowsPrivatePathIdentity(sourceAfter),
          ) ||
          sourceBefore.size !== sourceAfter.size ||
          sourceBefore.mtimeMs !== sourceAfter.mtimeMs ||
          sourceBefore.ctimeMs !== sourceAfter.ctimeMs
        ) {
          throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
        }
      } finally {
        closeSync(sourceDescriptor);
      }
      this.syncDirectory(directoryDescriptor);
    }, "content-write");
  }

  hasSession(chatId: string): boolean {
    return this.sessionExists(this.filePath(chatId));
  }

  load(chatId: string): { messages: ModelMessage[]; lastMessageTime: string | null } {
    const path = this.filePath(chatId);
    if (!this.sessionExists(path)) return { messages: [], lastMessageTime: null };

    const contents = this.readSessionText(path);
    if (this.platform === "win32") this.assertWindowsSessionContent(contents);
    const lines = contents.split("\n").filter((line) => line.trim() !== "");
    const good: string[] = [];
    const corrupt: string[] = [];
    const parsed: JsonlLine[] = [];
    for (const line of lines) {
      const entry = parseSessionLine(line);
      if (entry === null) {
        corrupt.push(line);
      } else {
        good.push(line);
        parsed.push(entry);
      }
    }

    if (corrupt.length > 0) {
      try {
        this.quarantineCorruptLines(chatId, good, corrupt);
      } catch (err) {
        if (this.platform === "win32") throw err;
        console.warn(
          "Failed to quarantine corrupt session lines; continuing with parseable lines",
          err,
        );
      }
    }

    const messages = messagesOf(parsed);

    let lastMessageTime: string | null = null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].role !== "system") {
        lastMessageTime = parsed[i].ts;
        break;
      }
    }

    return { messages, lastMessageTime };
  }

  appendMessage(
    chatId: string,
    role: "user" | "assistant",
    content: string,
    lineage?: ChatLineage & { provenance?: SourceProvenance },
  ): void {
    // An empty assistant reply pollutes the next turn's loaded history. Skip it
    // and warn — never throw, so a deliver-first turn can't crash on a guarded
    // append.
    if (role === "assistant" && content.trim() === "") {
      console.warn("Skipping empty assistant message append");
      return;
    }
    const path = this.filePath(chatId);
    const line: JsonlLine =
      lineage === undefined
        ? { role, content, ts: new Date().toISOString() }
        : { role, content, ts: new Date().toISOString(), ...lineage };
    this.appendSessionContent(path, JSON.stringify(line) + "\n");
  }

  appendTurn(
    chatId: string,
    userContent: string,
    assistantContent: string,
    lineage: ChatLineage & { provenance?: SourceProvenance },
  ): void {
    // Keep the atomic pair honest: an empty assistant reply must never persist,
    // and a lone user line with no reply is the same context pollution. Skip the
    // whole turn and warn — never throw (deliver-first).
    if (assistantContent.trim() === "") {
      console.warn("Skipping turn with empty assistant content");
      return;
    }
    const path = this.filePath(chatId);
    const ts = new Date().toISOString();
    const userLine: JsonlLine = { role: "user", content: userContent, ts };
    const assistantLine: JsonlLine = {
      role: "assistant",
      content: assistantContent,
      ts,
      ...lineage,
    };
    // Both lines in one buffer and one write so the pair lands together or not
    // at all — a partial write can never leave a dangling user line.
    const buffer = JSON.stringify(userLine) + "\n" + JSON.stringify(assistantLine) + "\n";
    this.appendSessionContent(path, buffer);
  }

  persistDecisionContext(input: {
    readonly chatId: string;
    readonly decisionId: string;
    readonly athleteText: string;
    readonly request: RequestUserDecisionInput;
    readonly result?: RequestUserDecisionResult;
    readonly coachText?: string;
    readonly continuationId?: string;
    readonly lineage?: ChatLineage & { provenance?: SourceProvenance };
  }): void {
    const path = this.filePath(input.chatId);
    const toolCallId = `decision-${input.decisionId}`;
    const ts = new Date().toISOString();
    const desired: JsonlLine[] = [
      ...(input.athleteText === ""
        ? []
        : [
            {
              role: "user" as const,
              content: input.athleteText,
              ts,
              decisionKey: `${input.decisionId}:athlete`,
            },
          ]),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "request_user_decision",
            input: input.request,
          },
        ],
        ts,
        decisionKey: `${input.decisionId}:request`,
      },
    ];
    if (input.result !== undefined) {
      desired.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "request_user_decision",
            output: { type: "json", value: input.result },
          },
        ],
        ts,
        decisionKey: `${input.decisionId}:result`,
      });
    }
    if (input.coachText !== undefined) {
      if (input.continuationId === undefined || input.lineage === undefined) {
        throw new TypeError("Decision continuation context is incomplete.");
      }
      desired.push({
        role: "assistant",
        content: input.coachText,
        ts,
        decisionKey: `${input.decisionId}:continuation:${input.continuationId}`,
        ...input.lineage,
      });
    }
    const existing = new Map<string, JsonlLine>();
    if (this.sessionExists(path)) {
      for (const line of this.readSessionText(path).split("\n")) {
        if (line.trim() === "") continue;
        const parsed = parseSessionLine(line);
        if (parsed?.decisionKey !== undefined) existing.set(parsed.decisionKey, parsed);
      }
    }
    const missing: JsonlLine[] = [];
    for (const line of desired) {
      const prior = existing.get(line.decisionKey!);
      if (prior === undefined) {
        missing.push(line);
        continue;
      }
      if (
        prior.role !== line.role ||
        JSON.stringify(prior.content) !== JSON.stringify(line.content)
      ) {
        throw new Error("Decision session context is immutable.");
      }
    }
    if (missing.length > 0) {
      this.appendSessionContent(
        path,
        missing.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
    }
  }

  overwriteHistory(chatId: string, messages: ModelMessage[]): void {
    const path = this.filePath(chatId);
    const now = new Date().toISOString();

    // Preserve the original timestamp of a message that survives the rewrite so
    // freshness/idle math keeps working across a compaction. Timestamps are read
    // back from the existing file by (role, content); a summary/system line is a
    // freshly-generated artifact and always gets `now`. Build a per-key queue so
    // duplicate lines keep the stamp whose source label matches the surviving
    // message, falling back to occurrence order when the labels are identical.
    const preservedByKey = new Map<
      string,
      Array<{ ts: string; provenance?: SourceProvenance; decisionKey?: string }>
    >();
    if (this.sessionExists(path)) {
      const contents = this.readSessionText(path);
      if (this.platform === "win32") this.assertWindowsSessionContent(contents);
      for (const line of contents.split("\n")) {
        if (line.trim() === "") continue;
        const entry = parseSessionLine(line);
        if (entry === null || entry.role === "system") continue;
        const key = `${entry.role}\n${JSON.stringify(entry.content)}`;
        const queue = preservedByKey.get(key);
        const preserved = {
          ts: entry.ts,
          provenance: entry.provenance,
          decisionKey: entry.decisionKey,
        };
        if (queue) queue.push(preserved);
        else preservedByKey.set(key, [preserved]);
      }
    }

    const content =
      messages
        .map((m) => {
          const role = m.role as JsonlLine["role"];
          const text = messageText(m);
          const storedContent = typeof m.content === "string" ? text : m.content;
          let ts = now;
          let decisionKey: string | undefined;
          const provenance = getMessageProvenance(m);
          if (role !== "system") {
            const queue = preservedByKey.get(`${role}\n${JSON.stringify(storedContent)}`);
            const matchingIndex = queue?.findIndex((candidate) =>
              sameProvenance(candidate.provenance ?? UNKNOWN_PROVENANCE, provenance),
            );
            const preserved =
              queue !== undefined && matchingIndex !== undefined && matchingIndex >= 0
                ? queue.splice(matchingIndex, 1)[0]
                : queue?.shift();
            if (preserved !== undefined) {
              ts = preserved.ts;
              decisionKey = preserved.decisionKey;
            }
          }
          const line: JsonlLine = {
            role,
            content: storedContent,
            ts,
            ...(decisionKey === undefined ? {} : { decisionKey }),
            ...(role === "user" ? {} : { provenance }),
          };
          return JSON.stringify(line);
        })
        .join("\n") + "\n";
    this.replaceSessionContent(path, content);
  }

  // Terminal failure marker: makes a turn that died before producing a reply
  // visible in history instead of leaving a bare user line with no answer. The
  // athlete's message stays durable (it was appended before generation); this
  // records that the turn did not complete. No-op when no session file exists.
  appendFailureMarker(chatId: string): void {
    const path = this.filePath(chatId);
    if (!this.sessionExists(path)) return;
    const line: JsonlLine = {
      role: "system",
      content: TURN_FAILURE_MARKER,
      ts: new Date().toISOString(),
    };
    this.appendSessionContent(path, JSON.stringify(line) + "\n");
  }

  archiveAndReset(chatId: string): void {
    const path = this.filePath(chatId);
    const ts = new Date().toISOString().replace(/:/g, "-");
    const archivePath = `${path}.reset.${ts}`;
    const sessionExists = this.sessionExists(path);
    const archiveExists = this.sessionExists(archivePath);
    if (sessionExists && archiveExists) {
      throw this.unsafeTarget("Reset archive and active session both exist.");
    }
    if (!sessionExists) return;

    this.renameSessionPath(path, archivePath);
    this.syncSessionsDirectory();
    this.pruneArchives(chatId, "reset");
  }

  deleteResetArchive(chatId: string, boundaryRef: string, boundaryAt: string): boolean {
    if (
      typeof chatId !== "string" ||
      !/^[a-f0-9]{64}$/.test(boundaryRef) ||
      typeof boundaryAt !== "string" ||
      Number.isNaN(Date.parse(boundaryAt)) ||
      new Date(boundaryAt).toISOString() !== boundaryAt
    ) {
      throw new TypeError("Reset archive deletion metadata is invalid.");
    }
    const archiveRef = `${boundaryAt.replace(/:/g, "-")}.${boundaryRef}`;
    const path = `${this.filePath(chatId)}.reset.${archiveRef}`;
    const deleted = this.withSessionsDirectory((directoryDescriptor) => {
      let beforeOpen: import("node:fs").Stats;
      try {
        beforeOpen = lstatSync(path);
      } catch (error) {
        if (isMissing(error)) {
          this.assertSessionsDirectoryStable(directoryDescriptor);
          return false;
        }
        throw error;
      }
      if (!this.isPrivateFile(beforeOpen, 1)) {
        throw this.unsafeTarget("Reset archive target is unsafe.");
      }
      let descriptor: number;
      try {
        descriptor =
          this.platform === "win32"
            ? this.openWindowsSessionFile(directoryDescriptor, path, constants.O_RDONLY)
            : openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") {
          throw this.unsafeTarget("Reset archive target is unsafe.");
        }
        throw error;
      }
      try {
        const opened = fstatSync(descriptor);
        const current = lstatSync(path);
        if (
          !this.isPrivateFile(opened, 1) ||
          !this.isPrivateFile(current, 1) ||
          !sameIdentity(identity(beforeOpen), identity(opened)) ||
          !sameIdentity(identity(opened), identity(current))
        ) {
          throw this.unsafeTarget("Reset archive target is unsafe.");
        }
        if (this.platform === "win32") {
          assertWindowsPrivateFileBinding(
            this.windowsDirectoryBinding!,
            path,
            windowsPrivatePathIdentity(opened),
          );
        }
        this.assertSessionsDirectoryStable(directoryDescriptor);
        try {
          unlinkSync(path);
        } catch (error) {
          throw this.platform === "win32"
            ? classifyWindowsPrivatePathFailure("rename", error)
            : error;
        }
        this.syncDirectory(directoryDescriptor);
        return true;
      } finally {
        closeSync(descriptor);
      }
    }, "rename");
    if (deleted) this.unlinkIfPresent(this.flushPendingPath(chatId, archiveRef));
    return deleted;
  }

  archivePreCompact(chatId: string): void {
    const path = this.filePath(chatId);
    if (!this.sessionExists(path)) return;

    const ts = new Date().toISOString().replace(/:/g, "-");
    this.copySessionPath(path, `${path}.precompact.${ts}`);
    this.pruneArchives(chatId, "precompact");
  }

  private quarantineCorruptLines(chatId: string, good: string[], corrupt: string[]): void {
    const path = this.filePath(chatId);
    const ts = new Date().toISOString().replace(/:/g, "-");
    const sidecarPath = `${path}.corrupt.${ts}`;
    this.appendSessionContent(sidecarPath, corrupt.join("\n") + "\n");
    if (good.length === 0) {
      this.unlinkSessionPath(path);
      console.warn(
        this.platform === "win32"
          ? `Quarantined ${corrupt.length} corrupt session line(s); removed empty session`
          : `Quarantined ${corrupt.length} corrupt session line(s) to ${sidecarPath}; removed empty session`,
      );
      return;
    }
    this.replaceSessionContent(path, good.join("\n") + "\n");
    console.warn(
      this.platform === "win32"
        ? `Quarantined ${corrupt.length} corrupt session line(s); kept ${good.length} valid line(s)`
        : `Quarantined ${corrupt.length} corrupt session line(s) to ${sidecarPath}; kept ${good.length} valid line(s)`,
    );
  }

  private pruneArchives(chatId: string, suffix: "reset" | "precompact"): void {
    if (this.resetArchiveRetentionDays <= 0) return;
    const fileName = this.platform === "win32" ? this.chatDigest(chatId) : chatId;
    const prefix = `${fileName}.jsonl.${suffix}.`;
    const cutoffMs = Date.now() - this.resetArchiveRetentionDays * MS_PER_DAY;
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir);
    } catch (error) {
      throw this.platform === "win32"
        ? classifyWindowsPrivatePathFailure("read-check", error)
        : error;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const archivedAtMs = parseArchiveTimestampMs(name.slice(prefix.length));
      // Unparseable timestamps are kept: never delete an archive that
      // cannot be dated.
      if (archivedAtMs !== null && archivedAtMs < cutoffMs) {
        this.unlinkSessionPath(join(this.sessionsDir, name));
      }
    }
  }

  private syncSessionsDirectory(): void {
    this.withSessionsDirectory((descriptor) => {
      this.syncDirectory(descriptor);
      this.assertSessionsDirectoryStable(descriptor);
    }, "rename");
  }

  private completeDurableReset(path: string, archivePath: string): void {
    this.withSessionsDirectory((directoryDescriptor) => {
      const readStats = (candidate: string) => {
        try {
          return lstatSync(candidate);
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
      };
      const active = readStats(path);
      const archive = readStats(archivePath);
      if (active === null) {
        if (archive !== null) {
          if (!this.isPrivateFile(archive, 1)) {
            throw this.unsafeTarget("Reset archive target is unsafe.");
          }
          if (this.platform === "win32") {
            assertWindowsPrivateFileBinding(
              this.windowsDirectoryBinding!,
              archivePath,
              windowsPrivatePathIdentity(archive),
            );
            this.assertWindowsSessionContent(this.readSessionText(archivePath));
          }
          this.assertSessionsDirectoryStable(directoryDescriptor);
          this.syncDirectory(directoryDescriptor);
          this.assertSessionsDirectoryStable(directoryDescriptor);
        }
        return;
      }
      if (this.platform === "win32") {
        this.assertWindowsSessionContent(this.readSessionText(path, archive === null ? 1 : 2));
      }
      if (archive !== null) {
        this.assertLinkedResetTargets(active, archive);
        this.syncStableSessionFile(directoryDescriptor, path, identity(active), 2);
        this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
      } else {
        if (!this.isPrivateFile(active, 1)) {
          throw this.unsafeTarget("Active reset session target is unsafe.");
        }
        this.syncStableSessionFile(directoryDescriptor, path, identity(active), 1);
        linkSync(path, archivePath);
        this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
        this.syncDirectory(directoryDescriptor);
        this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
      }

      this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
      unlinkSync(path);
      this.assertSessionsDirectoryStable(directoryDescriptor);
      this.syncDirectory(directoryDescriptor);
      this.assertSessionsDirectoryStable(directoryDescriptor);
      const completed = lstatSync(archivePath);
      if (
        !this.isPrivateFile(completed, 1) ||
        !sameIdentity(identity(completed), identity(active))
      ) {
        throw this.unsafeTarget("Reset archive did not complete safely.");
      }
      if (this.platform === "win32") {
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          archivePath,
          windowsPrivatePathIdentity(completed),
        );
      }
    }, "rename");
  }

  private syncStableSessionFile(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    expectedIdentity: FileIdentity,
    expectedLinks: 1 | 2,
  ): void {
    const descriptor = openSync(
      path,
      this.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (this.platform === "win32") {
        this.assertWindowsSessionContent(
          this.readWindowsSessionDescriptor(directoryDescriptor, descriptor, path, expectedLinks),
        );
      }
      const opened = fstatSync(descriptor);
      const current = lstatSync(path);
      if (this.platform === "win32") this.assertWindowsSessionSize(opened.size);
      if (
        !this.isPrivateFile(opened, expectedLinks) ||
        !this.isPrivateFile(current, expectedLinks) ||
        !sameIdentity(identity(opened), expectedIdentity) ||
        !sameIdentity(identity(current), expectedIdentity)
      ) {
        throw this.unsafeTarget("Active reset session was raced.");
      }
      if (this.platform === "win32") {
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(opened),
          expectedLinks,
        );
      }
      this.assertSessionsDirectoryStable(directoryDescriptor);
      this.syncFile(descriptor);
      const synced = fstatSync(descriptor);
      const afterSync = lstatSync(path);
      if (
        !this.isPrivateFile(synced, expectedLinks) ||
        !this.isPrivateFile(afterSync, expectedLinks) ||
        !sameIdentity(identity(synced), expectedIdentity) ||
        !sameIdentity(identity(afterSync), expectedIdentity)
      ) {
        throw this.unsafeTarget("Active reset session was raced.");
      }
      if (this.platform === "win32") {
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(synced),
          expectedLinks,
        );
      }
      this.assertSessionsDirectoryStable(directoryDescriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private assertLinkedResetTargets(
    active: import("node:fs").Stats,
    archive: import("node:fs").Stats,
  ): void {
    if (
      !this.isPrivateFile(active, 2) ||
      !this.isPrivateFile(archive, 2) ||
      !sameIdentity(identity(active), identity(archive))
    ) {
      throw this.unsafeTarget("Reset archive and active session do not agree.");
    }
  }

  private assertLinkedResetPaths(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    archivePath: string,
    expectedIdentity: FileIdentity,
  ): void {
    const active = lstatSync(path);
    const archive = lstatSync(archivePath);
    this.assertLinkedResetTargets(active, archive);
    if (!sameIdentity(identity(active), expectedIdentity)) {
      throw this.unsafeTarget("Reset archive publication was raced.");
    }
    if (this.platform === "win32") {
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        path,
        windowsPrivatePathIdentity(active),
        2,
      );
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        archivePath,
        windowsPrivatePathIdentity(archive),
        2,
      );
    }
    this.assertSessionsDirectoryStable(directoryDescriptor);
  }

  private syncFile(descriptor: number): void {
    try {
      (CHAT_STORE_HOOKS.get(this)?.syncFile ?? fsyncSync)(descriptor);
    } catch (error) {
      throw this.platform === "win32"
        ? classifyWindowsPrivatePathFailure("file-flush", error)
        : error;
    }
  }

  private withSessionsDirectory<T>(
    operation: (descriptor: DirectoryDescriptor) => T,
    failureStage: WindowsPrivatePathPolicyStage = "read-check",
  ): T {
    if (this.platform === "win32") {
      try {
        this.assertSessionsDirectoryStable(null);
        return operation(null);
      } catch (error) {
        if (
          error instanceof WindowsPrivatePathPolicyError ||
          (typeof error === "object" && error !== null && "code" in error)
        ) {
          throw classifyWindowsPrivatePathFailure(failureStage, error);
        }
        throw error;
      }
    }
    const beforeOpen = lstatSync(this.sessionsDir);
    if (
      !isStrictPrivateDirectory(beforeOpen) ||
      !sameIdentity(identity(beforeOpen), this.sessionsDirectoryIdentity)
    ) {
      throw new Error("Sessions directory is unsafe.");
    }
    const descriptor = openSync(
      this.sessionsDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.assertSessionsDirectoryStable(descriptor);
      return operation(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private assertSessionsDirectoryStable(descriptor: DirectoryDescriptor): void {
    if (this.platform === "win32") {
      assertWindowsPrivateDirectoryStable(this.windowsDirectoryBinding!);
      return;
    }
    const current = lstatSync(this.sessionsDir);
    const opened = fstatSync(descriptor!);
    if (
      !isStrictPrivateDirectory(current) ||
      !isStrictPrivateDirectory(opened) ||
      !sameIdentity(identity(current), this.sessionsDirectoryIdentity) ||
      !sameIdentity(identity(opened), this.sessionsDirectoryIdentity)
    ) {
      throw new Error("Sessions directory is unsafe.");
    }
  }

  private syncDirectory(descriptor: DirectoryDescriptor): void {
    if (this.platform === "win32") {
      if (classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable") return;
    }
    (CHAT_STORE_HOOKS.get(this)?.syncDirectory ?? fsyncSync)(descriptor!);
  }
}

export function createChatStoreWithHooks(
  dataDir: string,
  resetArchiveRetentionDays: number,
  hooks: ChatStoreHooks,
  options: ChatStoreOptions = {},
): ChatStore {
  const store = new ChatStore(dataDir, resetArchiveRetentionDays, options);
  CHAT_STORE_HOOKS.set(store, hooks);
  return store;
}

export function archiveAndResetDurably(
  store: ChatStore,
  chatId: string,
  reset: DurableChatReset,
): void {
  if (
    !/^[a-f0-9]{64}$/.test(reset.resetId) ||
    new Date(reset.boundaryAt).toISOString() !== reset.boundaryAt
  ) {
    throw new TypeError("Durable chat reset metadata is invalid.");
  }
  const operation = DURABLE_RESET_OPERATIONS.get(store);
  if (operation === undefined) throw new TypeError("Durable chat reset store is invalid.");
  operation(chatId, reset);
}
