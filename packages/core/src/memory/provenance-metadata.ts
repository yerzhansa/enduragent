import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import {
  UNKNOWN_PROVENANCE,
  contentDigest,
  isSourceProvenance,
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
  type WindowsPrivatePathIdentity,
  type WindowsPrivatePathPolicyStage,
} from "../io/windows-private-path-policy.js";

export const MAX_PROVENANCE_METADATA_BYTES = 67_108_864;

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface Entry {
  readonly digest: string;
  readonly provenance: SourceProvenance;
}

interface PutRecord extends Entry {
  readonly version: 1;
  readonly op: "put";
  readonly key: string;
}

interface DeleteRecord {
  readonly version: 1;
  readonly op: "delete";
  readonly key: string;
}

type JournalRecord = PutRecord | DeleteRecord;

export interface ProvenanceMetadataOptions {
  readonly platform?: NodeJS.Platform;
  readonly syncFile?: (descriptor: number) => void;
  readonly syncDirectory?: (path: string) => void;
}

function syncDirectory(path: string): void {
  const directoryFd = openSync(path, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function parseRecord(value: unknown): JournalRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.key !== "string") return undefined;
  if (record.op === "delete") return { version: 1, op: "delete", key: record.key };
  if (
    record.op === "put" &&
    typeof record.digest === "string" &&
    isSourceProvenance(record.provenance)
  ) {
    return {
      version: 1,
      op: "put",
      key: record.key,
      digest: record.digest,
      provenance: record.provenance,
    };
  }
  return undefined;
}

export class ProvenanceMetadata {
  private readonly directoryPath: string;
  private readonly path: string;
  private readonly platform: NodeJS.Platform;
  private readonly syncFile: (descriptor: number) => void;
  private readonly syncDirectory: (path: string) => void;
  private readonly windowsDirectory: WindowsPrivateDirectoryBinding | undefined;
  private cached?: Map<string, Entry>;
  private directorySynced = false;

  constructor(memoryDir: string, options: ProvenanceMetadataOptions = {}) {
    this.directoryPath = memoryDir;
    this.path = join(memoryDir, ".source-provenance.jsonl");
    this.platform = options.platform ?? process.platform;
    this.syncFile = options.syncFile ?? fdatasyncSync;
    this.syncDirectory = options.syncDirectory ?? syncDirectory;
    this.windowsDirectory =
      this.platform === "win32"
        ? bindWindowsPrivateDirectory(dirname(memoryDir), memoryDir)
        : undefined;
  }

  read(key: string, content: string): SourceProvenance {
    const entry = this.load().get(key);
    if (entry === undefined || entry.digest !== contentDigest(content)) {
      return UNKNOWN_PROVENANCE;
    }
    return entry.provenance;
  }

  matches(key: string, content: string): boolean {
    return this.load().get(key)?.digest === contentDigest(content);
  }

  write(key: string, content: string, provenance: SourceProvenance): void {
    this.writeMany([{ key, content, provenance }]);
  }

  writeMany(
    entries: readonly {
      key: string;
      content: string;
      provenance: SourceProvenance;
    }[],
  ): void {
    this.replaceMany(entries, []);
  }

  replaceMany(
    entries: readonly {
      key: string;
      content: string;
      provenance: SourceProvenance;
    }[],
    deletedKeys: readonly string[],
  ): void {
    const records: JournalRecord[] = [
      ...deletedKeys.map((key): DeleteRecord => ({ version: 1, op: "delete", key })),
      ...entries.map(({ key, content, provenance }): PutRecord => ({
        version: 1,
        op: "put",
        key,
        digest: contentDigest(content),
        provenance,
      })),
    ];
    if (records.length === 0) return;

    const serialized = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    let windowsCache: Map<string, Entry> | undefined;
    if (this.platform === "win32") {
      windowsCache = this.load();
      this.appendWindows(serialized);
    } else {
      const fd = openSync(this.path, "a+", 0o600);
      try {
        const size = fstatSync(fd).size;
        const lastByte = Buffer.allocUnsafe(1);
        const boundary =
          size > 0 && readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 0x0a
            ? "\n"
            : "";
        appendFileSync(fd, boundary + serialized, { encoding: "utf8" });
        fdatasyncSync(fd);
        if (!this.directorySynced) {
          const directoryFd = openSync(this.directoryPath, "r");
          try {
            fsyncSync(directoryFd);
            this.directorySynced = true;
          } finally {
            closeSync(directoryFd);
          }
        }
      } finally {
        closeSync(fd);
      }
    }

    const cache = windowsCache ?? this.load();
    for (const record of records) {
      if (record.op === "delete") cache.delete(record.key);
      else cache.set(record.key, { digest: record.digest, provenance: record.provenance });
    }
  }

  private appendWindows(serialized: string): void {
    let fd: number | undefined;
    let closeFailure: unknown;
    let stage: WindowsPrivatePathPolicyStage = "content-write";
    try {
      const opened = this.openWindowsFile(fsConstants.O_RDWR | fsConstants.O_APPEND);
      if (opened === undefined) {
        assertWindowsPrivateDirectoryStable(this.windowsDirectory!);
        fd = openSync(
          this.path,
          fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_EXCL,
          0o600,
        );
        const created = fstatSync(fd);
        assertWindowsPrivateFileMetadata(created);
        const identity = windowsPrivatePathIdentity(created);
        assertWindowsPrivateFileBinding(this.windowsDirectory!, this.path, identity);
        stage = "read-check";
        const contents = this.readWindowsDescriptor(fd, identity);
        this.assertWindowsRecords(contents);
        stage = "content-write";
        this.appendWindowsDescriptor(fd, identity, created.size, contents, serialized);
      } else {
        fd = opened.fd;
        stage = "read-check";
        const contents = this.readWindowsDescriptor(fd, opened.identity);
        this.assertWindowsRecords(contents);
        stage = "content-write";
        this.appendWindowsDescriptor(fd, opened.identity, fstatSync(fd).size, contents, serialized);
      }
      stage = "file-flush";
      this.syncFile(fd);
      const flushed = fstatSync(fd);
      assertWindowsPrivateFileMetadata(flushed);
      assertWindowsPrivateFileBinding(
        this.windowsDirectory!,
        this.path,
        windowsPrivatePathIdentity(flushed),
      );
      closeSync(fd);
      fd = undefined;
      assertWindowsPrivateDirectoryStable(this.windowsDirectory!);
      if (!this.directorySynced) {
        if (classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable") {
          this.directorySynced = true;
        } else {
          this.syncDirectory(this.directoryPath);
          this.directorySynced = true;
        }
      }
    } catch (error) {
      throw classifyWindowsPrivatePathFailure(stage, error);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (closeError) {
          if (
            !(
              typeof closeError === "object" &&
              closeError !== null &&
              "code" in closeError &&
              (String(closeError.code) === "EBADF" || String(closeError.code) === "ERR_DIR_CLOSED")
            )
          )
            closeFailure = closeError;
        }
      }
    }
    if (closeFailure !== undefined) throw closeFailure;
  }

  private openWindowsFile(
    flags: number,
  ): { readonly fd: number; readonly identity: WindowsPrivatePathIdentity } | undefined {
    assertWindowsPrivateDirectoryStable(this.windowsDirectory!);
    let before;
    try {
      before = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        assertWindowsPrivateDirectoryStable(this.windowsDirectory!);
        return undefined;
      }
      throw error;
    }
    assertWindowsPrivateFileMetadata(before);
    const identity = windowsPrivatePathIdentity(before);
    assertWindowsPrivateFileBinding(this.windowsDirectory!, this.path, identity);
    const fd = openSync(this.path, flags);
    try {
      const opened = fstatSync(fd);
      assertWindowsPrivateFileMetadata(opened);
      if (!sameWindowsPrivatePathIdentity(identity, windowsPrivatePathIdentity(opened))) {
        throw new WindowsPrivatePathPolicyError("binding-check", "corruption");
      }
      assertWindowsPrivateFileBinding(this.windowsDirectory!, this.path, identity);
      return { fd, identity };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private readWindowsDescriptor(fd: number, identity: WindowsPrivatePathIdentity): string {
    const before = fstatSync(fd);
    assertWindowsPrivateFileMetadata(before);
    assertWindowsPrivatePathRead({
      bounded:
        Number.isSafeInteger(before.size) &&
        before.size >= 0 &&
        before.size <= MAX_PROVENANCE_METADATA_BYTES,
      identityStable: sameWindowsPrivatePathIdentity(identity, windowsPrivatePathIdentity(before)),
      contentValid: true,
      authenticatedHomeBinding: true,
    });
    const buffer = Buffer.alloc(before.size + 1);
    try {
      let offset = 0;
      while (offset < before.size) {
        const bytesRead = readSync(fd, buffer, offset, before.size - offset, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      const extraBytes = readSync(fd, buffer, before.size, 1, before.size);
      const after = fstatSync(fd);
      assertWindowsPrivateFileMetadata(after);
      const current = assertWindowsPrivateFileBinding(this.windowsDirectory!, this.path, identity);
      let contents = "";
      let contentValid = true;
      try {
        contents = STRICT_UTF8_DECODER.decode(buffer.subarray(0, before.size));
      } catch {
        contentValid = false;
      }
      assertWindowsPrivatePathRead({
        bounded: offset === before.size && extraBytes === 0,
        identityStable:
          sameWindowsPrivatePathIdentity(identity, windowsPrivatePathIdentity(after)) &&
          before.size === after.size &&
          before.size === current.size &&
          before.mtimeMs === after.mtimeMs &&
          before.mtimeMs === current.mtimeMs &&
          before.ctimeMs === after.ctimeMs &&
          before.ctimeMs === current.ctimeMs,
        contentValid,
        authenticatedHomeBinding: true,
      });
      assertWindowsPrivateDirectoryStable(this.windowsDirectory!);
      return contents;
    } finally {
      buffer.fill(0);
    }
  }

  private appendWindowsDescriptor(
    fd: number,
    identity: WindowsPrivatePathIdentity,
    size: number,
    contents: string,
    serialized: string,
  ): void {
    const boundary = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
    const payload = boundary + serialized;
    const expectedSize = size + Buffer.byteLength(payload, "utf8");
    assertWindowsPrivatePathRead({
      bounded: Number.isSafeInteger(expectedSize) && expectedSize <= MAX_PROVENANCE_METADATA_BYTES,
      identityStable: true,
      contentValid: true,
      authenticatedHomeBinding: true,
    });
    appendFileSync(fd, payload, { encoding: "utf8" });
    const written = fstatSync(fd);
    assertWindowsPrivateFileMetadata(written);
    if (
      !sameWindowsPrivatePathIdentity(identity, windowsPrivatePathIdentity(written)) ||
      written.size !== expectedSize
    ) {
      throw new WindowsPrivatePathPolicyError("content-write", "corruption");
    }
    assertWindowsPrivateFileBinding(this.windowsDirectory!, this.path, identity);
  }

  private assertWindowsRecords(contents: string): Map<string, Entry> {
    const entries = new Map<string, Entry>();
    for (const line of contents.split("\n")) {
      if (line === "") continue;
      let record: JournalRecord | undefined;
      try {
        record = parseRecord(JSON.parse(line) as unknown);
      } catch {
        throw new WindowsPrivatePathPolicyError("read-check", "corruption");
      }
      if (record === undefined) {
        throw new WindowsPrivatePathPolicyError("read-check", "corruption");
      }
      if (record.op === "delete") entries.delete(record.key);
      else entries.set(record.key, { digest: record.digest, provenance: record.provenance });
    }
    return entries;
  }

  private loadWindows(): Map<string, Entry> {
    let fd: number | undefined;
    try {
      const opened = this.openWindowsFile(fsConstants.O_RDONLY);
      if (opened === undefined) return new Map();
      fd = opened.fd;
      const entries = this.assertWindowsRecords(this.readWindowsDescriptor(fd, opened.identity));
      closeSync(fd);
      fd = undefined;
      return entries;
    } catch (error) {
      throw classifyWindowsPrivatePathFailure("read-check", error);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch (closeError) {
          if (
            !(
              typeof closeError === "object" &&
              closeError !== null &&
              "code" in closeError &&
              (String(closeError.code) === "EBADF" || String(closeError.code) === "ERR_DIR_CLOSED")
            )
          )
            fd = undefined;
        }
      }
    }
  }

  private load(): Map<string, Entry> {
    if (this.platform === "win32") {
      const entries = this.loadWindows();
      this.cached = entries;
      return entries;
    }
    if (this.cached !== undefined) return this.cached;
    const entries = new Map<string, Entry>();
    if (!existsSync(this.path)) {
      this.cached = entries;
      return entries;
    }
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const record = parseRecord(value);
        if (record === undefined) continue;
        if (record.op === "delete") entries.delete(record.key);
        else entries.set(record.key, { digest: record.digest, provenance: record.provenance });
      }
    } catch {
      entries.clear();
    }
    this.cached = entries;
    return entries;
  }
}
