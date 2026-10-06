import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { redactObject, REDACTION_SENTINEL } from "./redact.js";
import { type LogLevel, normalizeLogLevel, isLevelEnabled } from "./levels.js";

export const LOG_FILE = "log.jsonl";
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface LogLine {
  ts: string;
  level: LogLevel;
  component: string;
  event: string;
  chatId?: string;
  turnId?: string;
  syncTickId?: string;
  [field: string]: unknown;
}

export interface LogInput {
  component: string;
  event: string;
  [field: string]: unknown;
}

export interface RootLogger {
  emit(level: LogLevel, line: LogInput, fields?: Record<string, unknown>): void;
}

export interface RootLoggerOptions {
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
  threshold?: LogLevel;
}

let escalatedOnce = false;

function consoleSink(level: LogLevel): (msg: string) => void {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  return console.log;
}

function pruneAgedLines(raw: string, cutoffMs: number): string | null {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const kept: string[] = [];
  let dropped = false;
  for (const line of lines) {
    let ts: number | undefined;
    try {
      const parsed = JSON.parse(line) as { ts?: string };
      ts = parsed.ts !== undefined ? Date.parse(parsed.ts) : undefined;
    } catch {
      ts = undefined;
    }
    if (ts !== undefined && !Number.isNaN(ts) && ts < cutoffMs) {
      dropped = true;
      continue;
    }
    kept.push(line);
  }
  if (!dropped) return null;
  return kept.length > 0 ? kept.join("\n") + "\n" : "";
}

export function pruneFileByAge(path: string, cutoffMs: number): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const pruned = pruneAgedLines(raw, cutoffMs);
  if (pruned === null) return;
  try {
    writeFileSync(path, pruned, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Swallow: an observability prune failure is not a turn failure.
  }
}

export function createRootLogger(dataDir: string, options: RootLoggerOptions = {}): RootLogger {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? LOG_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const threshold = options.threshold ?? normalizeLogLevel(process.env.CYCLING_COACH_LOG_LEVEL);
  const dir = join(dataDir, "logs");
  const path = join(dir, LOG_FILE);

  function overSizeCap(): boolean {
    try {
      return statSync(path).size >= maxBytes;
    } catch {
      return false;
    }
  }

  function rotateIfNeeded(): void {
    if (!overSizeCap()) return;
    pruneFileByAge(path, now() - maxAgeMs);
    if (!overSizeCap()) return;
    try {
      renameSync(path, `${path}.1`);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && (String(error.code) === "ENOENT" || String(error.code) === "EEXIST"))) throw error;
    }
  }

  try {
    pruneFileByAge(path, now() - maxAgeMs);
  } catch {}

  return {
    emit(level, line, fields) {
      let record: LogLine;
      try {
        const sanitized = redactObject(line);
        const extra = redactObject(fields);
        const safeLine = sanitized !== null && typeof sanitized === "object" ? sanitized : {};
        const safeFields = extra !== null && typeof extra === "object" ? extra : {};
        const component =
          "component" in safeLine && typeof safeLine.component === "string"
            ? safeLine.component
            : REDACTION_SENTINEL;
        const event =
          "event" in safeLine && typeof safeLine.event === "string"
            ? safeLine.event
            : REDACTION_SENTINEL;
        record = {
          ...safeFields,
          ...safeLine,
          ts: new Date(now()).toISOString(),
          level,
          component,
          event,
        };
        delete record.err;
        const error = Object.getOwnPropertyDescriptor(safeLine, "err");
        if (error && "value" in error) record.err = error.value;
      } catch {
        return;
      }

      if (isLevelEnabled(level, threshold)) {
        const sink = consoleSink(level);
        try {
          sink(`[${record.component}] ${record.event}`);
        } catch {
          // Console may be closed in some run modes; never let it break a turn.
        }
      }

      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        rotateIfNeeded();
        appendFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf-8", mode: 0o600 });
      } catch {
        if (!escalatedOnce) {
          escalatedOnce = true;
          try {
            console.warn("[logging] local log write failed — diagnostics are not being persisted.");
          } catch {
            // Even the escalation warning is best-effort.
          }
        }
      }
    },
  };
}
