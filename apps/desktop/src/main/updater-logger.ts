import type { Logger } from "electron-updater";
import { isStableDesktopVersion } from "./desktop-version.js";

export type UpdaterLogLevel = "info" | "warn" | "error";

export type DifferentialFallbackReason =
  | "http-error"
  | "multipart-ranges-unsupported"
  | "multipart-response-incomplete"
  | "ranges-unsupported"
  | "blockmap-invalid"
  | "blockmap-version-mismatch"
  | "size-mismatch"
  | "checksum-mismatch"
  | "response-aborted"
  | "missing-cached-package"
  | "network-error"
  | "unknown";

const SAFE_SYSTEM_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EBUSY",
  "EEXIST",
  "ENOSPC",
  "EROFS",
  "EMFILE",
  "EIO",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "ESOCKETTIMEDOUT",
  "Z_DATA_ERROR",
  "Z_BUF_ERROR",
]);

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
  "ESOCKETTIMEDOUT",
]);

const HTTP_STATUS_PATTERNS: readonly RegExp[] = [
  /\bHttpError:\s*(\d{3})\b/u,
  /\bHTTP_ERROR_(\d{3})\b/u,
  /\bHTTP error:\s*(\d{3})\b/u,
  /,\s*status\s+(\d{3}):/u,
  /\(response code (\d{3})\)/u,
  /\bstatusCode[=:]\s*(\d{3})\b/u,
];

const SAFE_ERROR_CODE_PATTERNS: readonly RegExp[] = [
  /\b(ERR_UPDATER_[A-Z0-9_]{1,48})\b/u,
  /\b(net::ERR_[A-Z0-9_]{1,48})\b/u,
];

const CHANGED_BLOCKS_PATTERN = /^File(?: [^ ]+)? has (\d+) changed blocks$/u;
const DIFFERENTIAL_SUMMARY_PATTERN =
  /^Full:\s*([0-9,]+(?:\.\d+)?)\s*KB,\s*To download:\s*([0-9,]+(?:\.\d+)?)\s*KB\s*\((\d+)%\)$/u;
const FOUND_VERSION_PATTERN = /^Found version (\d+\.\d+\.\d+)\b/u;
const DOWNLOADED_VERSION_PATTERN = /^New version (\d+\.\d+\.\d+) has been downloaded to /u;

interface ExtractedInput {
  readonly text: string;
  readonly status?: number;
  readonly code?: string;
}

function validHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function normalizeSafeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (SAFE_SYSTEM_ERROR_CODES.has(value)) return value;
  if (/^(?:ERR_UPDATER|net::ERR)_[A-Z0-9_]{1,48}$/u.test(value)) return value;
  return undefined;
}

function extractHttpStatus(text: string, explicitStatus?: number): number | undefined {
  const fromExplicit = validHttpStatus(explicitStatus);
  if (fromExplicit !== undefined) return fromExplicit;
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const parsed = Number.parseInt(match[1] ?? "", 10);
    const valid = validHttpStatus(parsed);
    if (valid !== undefined) return valid;
  }
  return undefined;
}

function extractSafeErrorCode(text: string, explicitCode?: string): string | undefined {
  const fromExplicit = normalizeSafeErrorCode(explicitCode);
  if (fromExplicit !== undefined) return fromExplicit;
  for (const pattern of SAFE_ERROR_CODE_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) return match[1];
  }
  for (const token of text.matchAll(/\b([A-Z][A-Z0-9_]{2,20})\b/gu)) {
    const candidate = token[1];
    if (candidate !== undefined && SAFE_SYSTEM_ERROR_CODES.has(candidate)) return candidate;
  }
  return undefined;
}

function primaryLine(value: string): string {
  const index = value.search(/\r?\n/u);
  return index < 0 ? value : value.slice(0, index);
}

function extractInput(input: unknown): ExtractedInput {
  if (typeof input === "string") {
    const text = primaryLine(input);
    return {
      text,
      status: extractHttpStatus(text),
      code: extractSafeErrorCode(text),
    };
  }
  if (input instanceof Error) {
    const record = input as Error & { readonly code?: unknown; readonly statusCode?: unknown };
    const text = typeof input.message === "string" ? primaryLine(input.message) : "";
    const rawCode = typeof record.code === "string" ? record.code : undefined;
    const status = extractHttpStatus(
      rawCode === undefined ? text : `${text} ${rawCode}`,
      validHttpStatus(record.statusCode),
    );
    const code = extractSafeErrorCode(text, rawCode);
    return { text, status, code };
  }
  if (typeof input === "object" && input !== null) {
    const record = input as {
      readonly message?: unknown;
      readonly code?: unknown;
      readonly statusCode?: unknown;
    };
    const text = typeof record.message === "string" ? primaryLine(record.message) : "";
    const rawCode = typeof record.code === "string" ? record.code : undefined;
    const status = extractHttpStatus(
      rawCode === undefined ? text : `${text} ${rawCode}`,
      validHttpStatus(record.statusCode),
    );
    const code = extractSafeErrorCode(text, rawCode);
    return { text, status, code };
  }
  return { text: "" };
}

function classifyDifferentialFallbackReason(
  text: string,
  status?: number,
  code?: string,
): DifferentialFallbackReason {
  if (text.includes('Content-Type "multipart/byteranges" is expected')) {
    return "multipart-ranges-unsupported";
  }
  if (text.includes("Response ends without calling any handlers")) {
    return "multipart-response-incomplete";
  }
  if (text.includes("Server doesn't support Accept-Ranges")) return "ranges-unsupported";
  if (text.includes("version is different")) return "blockmap-version-mismatch";
  if (text.includes("Cannot parse blockmap") || /Blockmap ".*" is empty/u.test(text)) {
    return "blockmap-invalid";
  }
  if (text.includes("Internal error, size mismatch")) return "size-mismatch";
  if (/sha512|checksum/iu.test(text)) return "checksum-mismatch";
  if (text.includes("response has been aborted by the server")) return "response-aborted";
  if (code === "ENOENT") return "missing-cached-package";
  if (status !== undefined) return "http-error";
  if (code !== undefined && (NETWORK_ERROR_CODES.has(code) || code.startsWith("net::ERR_"))) {
    return "network-error";
  }
  return "unknown";
}

function formatTokens(
  level: UpdaterLogLevel,
  event: string,
  fields: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const parts = ["desktop-update-updater", `level=${level}`, `event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

function normalizeKbMetric(raw: string): string | undefined {
  const normalized = raw.replaceAll(",", "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? normalized : undefined;
}

export function formatUpdaterDiagnostic(
  level: UpdaterLogLevel,
  input: unknown,
): string | undefined {
  const { text, status, code } = extractInput(input);
  if (text.startsWith("Cannot download differentially, fallback to full download")) {
    return formatTokens(level, "differential-fallback", {
      reason: classifyDifferentialFallbackReason(text, status, code),
      status,
      code,
    });
  }
  if (text.includes("Unable to locate previous") && text.includes("differential download")) {
    return formatTokens(level, "differential-skipped", { reason: "missing-cached-package" });
  }
  if (text.startsWith("Download block maps")) {
    return formatTokens(level, "differential-blockmaps");
  }
  const changedBlocksMatch = CHANGED_BLOCKS_PATTERN.exec(text);
  if (changedBlocksMatch?.[1] !== undefined) {
    const changedBlocks = Number.parseInt(changedBlocksMatch[1], 10);
    if (Number.isSafeInteger(changedBlocks) && changedBlocks >= 0) {
      return formatTokens(level, "differential-plan", { changedBlocks });
    }
  }
  const summaryMatch = DIFFERENTIAL_SUMMARY_PATTERN.exec(text);
  if (summaryMatch !== null) {
    const fullKb = normalizeKbMetric(summaryMatch[1] ?? "");
    const downloadKb = normalizeKbMetric(summaryMatch[2] ?? "");
    const percent = Number.parseInt(summaryMatch[3] ?? "", 10);
    if (
      fullKb !== undefined &&
      downloadKb !== undefined &&
      Number.isSafeInteger(percent) &&
      percent >= 0 &&
      percent <= 100
    ) {
      return formatTokens(level, "differential-summary", { fullKb, downloadKb, percent });
    }
  }
  if (text.startsWith("Differential download:")) {
    return formatTokens(level, "differential-download-start");
  }
  if (text.startsWith("Unable to copy file for caching for future differential downloads")) {
    return formatTokens(level, "differential-cache-save-failed", { code });
  }
  if (text.startsWith("Cannot parse blockmap")) {
    return formatTokens(level, "cached-blockmap-invalid");
  }
  if (text.includes("checksum doesn't match the latest available update")) {
    return formatTokens(level, "cached-package-checksum-mismatch");
  }
  if (text === "Checking for update") {
    return formatTokens(level, "check-start");
  }
  const foundVersionMatch = FOUND_VERSION_PATTERN.exec(text);
  if (foundVersionMatch?.[1] !== undefined && isStableDesktopVersion(foundVersionMatch[1])) {
    return formatTokens(level, "update-available", { version: foundVersionMatch[1] });
  }
  if (text.startsWith("Update for version ") && text.includes("is not available")) {
    return formatTokens(level, "update-not-available");
  }
  if (text.startsWith("Downloading update from ")) {
    return formatTokens(level, "download-start");
  }
  const downloadedVersionMatch = DOWNLOADED_VERSION_PATTERN.exec(text);
  if (
    downloadedVersionMatch?.[1] !== undefined &&
    isStableDesktopVersion(downloadedVersionMatch[1])
  ) {
    return formatTokens(level, "download-complete", { version: downloadedVersionMatch[1] });
  }
  if (text.startsWith("Update has already been downloaded to ")) {
    return formatTokens(level, "download-cached");
  }
  if (text.startsWith("Redirect to ")) {
    return formatTokens(level, "redirect");
  }
  if (text === "cancelled") {
    return formatTokens(level, "download-cancelled");
  }
  if (level === "warn") {
    return formatTokens(level, "updater-warning", { status, code });
  }
  if (level === "error") {
    return formatTokens(level, "updater-error", { status, code });
  }
  return undefined;
}

export function createSafeUpdaterLogger(log: (message: string) => void): Logger {
  const emit = (level: UpdaterLogLevel, message: unknown): void => {
    const formatted = formatUpdaterDiagnostic(level, message);
    if (formatted !== undefined) log(formatted);
  };
  return {
    info(message?: unknown): void {
      emit("info", message);
    },
    warn(message?: unknown): void {
      emit("warn", message);
    },
    error(message?: unknown): void {
      emit("error", message);
    },
  };
}
