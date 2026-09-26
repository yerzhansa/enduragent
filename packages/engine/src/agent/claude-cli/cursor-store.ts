import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const CURSOR_FILE_MODE = 0o600;
export const CURSOR_DIR_MODE = 0o700;

export interface PersistedCursor {
  readonly sessionId: string;
  readonly historyHash: string;
}

export type CursorStoreDocument = Record<string, PersistedCursor>;

export interface CursorStoreReadResult {
  cursors: CursorStoreDocument;
  quarantinedPath?: string;
}

function emptyDocument(): CursorStoreDocument {
  return Object.create(null) as CursorStoreDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCursorBytes(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function parseCursorDocument(contents: string): CursorStoreDocument {
  const parsed = JSON.parse(contents) as unknown;
  if (!isRecord(parsed)) throw new TypeError("Claude CLI cursor store must be a map.");
  const out = emptyDocument();
  for (const [key, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) throw new TypeError("Claude CLI cursor entries must be maps.");
    const sessionId = entry.sessionId;
    const historyHash = entry.historyHash;
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new TypeError("Claude CLI cursor entries require a sessionId.");
    }
    if (typeof historyHash !== "string") {
      throw new TypeError("Claude CLI cursor entries require a historyHash.");
    }
    out[key] = { sessionId, historyHash };
  }
  return out;
}

function quarantinePathFor(path: string, sequence: number): string {
  const suffix = sequence === 0 ? "" : `.${sequence}`;
  return join(dirname(path), `${basename(path)}.corrupt${suffix}`);
}

function writeQuarantine(path: string, bytes: Buffer): string {
  for (let sequence = 0; ; sequence += 1) {
    const candidate = quarantinePathFor(path, sequence);
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(
        candidate,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        CURSOR_FILE_MODE,
      );
      created = true;
      fchmodSync(descriptor, CURSOR_FILE_MODE);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      return candidate;
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch (closeError) {
          if (!(typeof closeError === "object" && closeError !== null && "code" in closeError && (String(closeError.code) === "EBADF" || String(closeError.code) === "ERR_DIR_CLOSED"))) throw closeError;
        }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if (created) {
        rmSync(candidate, { force: true });
      }
      throw error;
    }
  }
}

export function readCursorStore(path: string): CursorStoreReadResult {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cursors: emptyDocument() };
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return { cursors: emptyDocument() };
    throw error;
  }

  let contents: string;
  try {
    contents = decodeCursorBytes(bytes);
  } catch {
    return { cursors: emptyDocument(), quarantinedPath: writeQuarantine(path, bytes) };
  }

  try {
    return { cursors: parseCursorDocument(contents) };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    return { cursors: emptyDocument(), quarantinedPath: writeQuarantine(path, bytes) };
  }
}

export function writeCursorStore(path: string, cursors: CursorStoreDocument): void {
  mkdirSync(dirname(path), { recursive: true, mode: CURSOR_DIR_MODE });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      CURSOR_FILE_MODE,
    );
    fchmodSync(descriptor, CURSOR_FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(cursors, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temp, path);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        if (!(typeof closeError === "object" && closeError !== null && "code" in closeError && (String(closeError.code) === "EBADF" || String(closeError.code) === "ERR_DIR_CLOSED"))) throw closeError;
      }
    }
    rmSync(temp, { force: true });
    throw error;
  }
}
