import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  AttachmentAdmissionReadModelSchema,
  CHAT_ATTACHMENT_LIMITS,
  DeleteArchivedConversationRpcResultSchema,
  GetArchivedTranscriptPageRpcResultSchema,
  GetPlanningReadModelRpcResultSchema,
  GetTranscriptPageRpcResultSchema,
  PlatformAbsolutePathSchema,
  type AttachmentAdmissionReadModel,
  ExecutePlanTransitionRpcParamsSchema,
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcResultSchema,
  PlanProgressEventSchema,
  PlanRaceCourseFileSelectionSchema,
  type PlanProgressEvent,
} from "@enduragent/coach-contract";
import { parseDesktopAppearance } from "../main/appearance.js";
import { desktopPlatformProjection } from "../main/platform-copy.js";
import { desktopRendererNavigationToken } from "../main/renderer-navigation.js";
import {
  DESKTOP_APPEARANCE_CHANNEL,
  DESKTOP_CONNECTION_CHANNEL,
  DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL,
  DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL,
  DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL,
  DESKTOP_DOCUMENT_REGISTRATION_CHANNEL,
  DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL,
  DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL,
  DESKTOP_LIFECYCLE_CHANNEL,
  DESKTOP_PLANNING_READ_CHANNEL,
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_OPEN_SETTINGS_CHANNEL,
  DESKTOP_PLAN_PROGRESS_CHANNEL,
  DESKTOP_PLAN_COURSE_FILE_CHANNEL,
  DESKTOP_PLAN_STATE_CHANNEL,
  DESKTOP_PLAN_TRANSITION_CHANNEL,
  DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL,
  DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL,
  DESKTOP_DELETE_ARCHIVED_CONVERSATION_CHANNEL,
  DESKTOP_TRANSCRIPT_PAGE_CHANNEL,
  DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
  DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_DISABLE_CHANNEL,
  DESKTOP_TELEGRAM_ENABLE_CHANNEL,
  DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
  DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
  DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
  DESKTOP_TELEGRAM_STATUS_CHANNEL,
  DESKTOP_TRAINING_EXPORT_CHANNEL,
  DESKTOP_UPDATE_CHECK_CHANNEL,
  DESKTOP_UPDATE_GET_CHANNEL,
  DESKTOP_UPDATE_RESTART_CHANNEL,
  DESKTOP_UPDATE_STATE_CHANNEL,
} from "../main/constants.js";

const DESKTOP_CREDENTIAL_STATUS_CHANNEL = "enduragent:onboarding:credential-status";
const DESKTOP_CREDENTIAL_RETRY_CHANNEL = "enduragent:onboarding:credential-retry";
const DESKTOP_CREDENTIAL_WRITE_CHANNEL = "enduragent:onboarding:credential-write";
const DESKTOP_CREDENTIAL_DELETE_CHANNEL = "enduragent:settings:credential-delete";
const DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL = "enduragent:settings:credential-recovery-status";
const DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL = "enduragent:settings:credential-recovery-retry";
const DESKTOP_CREDENTIAL_RESET_CHANNEL = "enduragent:settings:credential-reset";
const DESKTOP_LLM_CONFIGURATION_CHANNEL = "enduragent:onboarding:llm-configuration";
const DESKTOP_LLM_SELECTION_APPLY_CHANNEL = "enduragent:onboarding:llm-selection-apply";
const DESKTOP_CHATGPT_STATUS_CHANNEL = "enduragent:onboarding:chatgpt-status";
const DESKTOP_CHATGPT_LOGIN_CHANNEL = "enduragent:onboarding:chatgpt-login";
const DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL = "enduragent:onboarding:chatgpt-login-cancel";
const DESKTOP_CHATGPT_LOGIN_PROGRESS_CHANNEL = "enduragent:onboarding:chatgpt-login-progress";
const DESKTOP_CLAUDE_CLI_STATUS_CHANNEL = "enduragent:onboarding:claude-cli-status";
const DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL = "enduragent:onboarding:claude-cli-recheck";
const DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL = "enduragent:onboarding:choose-import-files";

const SLOTS = new Set([
  "anthropic",
  "openrouter",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "intervals-icu",
]);
const CREDENTIALS = new Set([...SLOTS, "openai-codex"]);
const LLM_PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "claude-cli",
  "codex-agent",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
] as const;
const LLM_PROVIDERS = new Set<string>(LLM_PROVIDER_ORDER);
const OFF_CATALOGUE_LLM_PROVIDERS = new Set<string>(["codex-agent"]);
const LLM_CATALOGUE_PROVIDER_ORDER = LLM_PROVIDER_ORDER.filter(
  (provider) => !OFF_CATALOGUE_LLM_PROVIDERS.has(provider),
);
const DEFAULT_ENDPOINT_PROVIDERS = new Set([
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
]);
const STATES = new Set(["missing", "configured", "re-prompt"]);
const RUNTIME_STATES = new Set(["active", "stored-inactive", "failed"]);
const REASONS = new Set([
  "invalid-input",
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "runtime-unavailable",
  "training-account-mismatch",
]);
const DELETE_REASONS = new Set([
  "not-found",
  "managed-by-environment",
  "encryption-unavailable",
  "storage-failed",
  "runtime-unavailable",
  "runtime-state-diverged",
]);
const CHATGPT_REASONS = new Set([
  "already-in-progress",
  "callback-unavailable",
  "timed-out",
  "cancelled",
  "exchange-failed",
  "storage-failed",
  "runtime-unavailable",
]);
const CLAUDE_CLI_STATES = new Set([
  "ready",
  "ready-api-key",
  "absent-binary",
  "not-logged-in",
  "api-key-token",
  "disabled",
  "working-area-unavailable",
]);
const IMPORT_EXTENSIONS = new Set([".fit", ".tcx", ".gpx"]);
const ACTIVITY_EXPORT_FORMATS = new Set(["fit", "gpx"]);
const WORKOUT_ARCHIVE_FORMATS = new Set(["zwo", "mrc", "erg", "fit"]);
const TRAINING_EXPORT_REFUSAL_REASONS = new Set([
  "not-configured",
  "source-not-found",
  "ambiguous-source",
  "provider-unavailable",
  "not-supported",
  "rate-limited",
  "network",
  "timeout",
  "response-too-large",
  "invalid-response",
  "write-failed",
  "commit-uncertain",
]);
const TELEGRAM_DESKTOP_ERROR_CODES = new Set([
  "telegram-credential-storage-failed",
  "telegram-credential-encryption-unavailable",
  "telegram-credential-unsafe-backend",
  "telegram-credential-unavailable",
  "telegram-settings-storage-uncertain",
  "telegram-daemon-unavailable",
  "telegram-home-mismatch",
  "telegram-stale-operation",
  "telegram-control-failed",
  "telegram-drain-required",
]);
const TELEGRAM_PAIRING_ERROR_CODES = new Set([
  "telegram-pairing-unavailable",
  "telegram-pairing-refused",
  "telegram-pairing-storage-failed",
  "telegram-pairing-storage-uncertain",
]);
const TELEGRAM_MUTATION_REFUSAL_REASONS = new Set([
  "clipboard-unavailable",
  "clipboard-clear-failed",
  "invalid-token-format",
  "invalid-token",
  "validation-unavailable",
  "webhook-removal-required",
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "stale-operation",
  "transfer-required",
  "polling-conflict",
  "control-unavailable",
  "invalid-state",
]);
const INTERVALS_CREDENTIAL_REFUSAL_REASONS = new Set([
  "clipboard-unavailable",
  "clipboard-clear-failed",
  "invalid-key-format",
  "credential-rejected",
  "malformed-athlete-response",
  "validation-timeout",
  "validation-aborted",
  "validation-unavailable",
  "training-account-mismatch",
  "owner-unresolved",
  "store-unavailable",
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "runtime-unavailable",
]);
const TRANSCRIPT_PAGE_MAX_TURNS = 50;
const TRANSCRIPT_PAGE_MAX_RESPONSE_BYTES = 266_240;
const TRANSCRIPT_CURSOR_LENGTH = 152;
const TRANSCRIPT_CURSOR_PATTERN = /^[A-Za-z0-9_-]{152}$/;
const TRANSCRIPT_CURSOR_VERSION = 1;
const ARCHIVED_TRANSCRIPT_CURSOR_VERSION = 2;
const ARCHIVED_CONVERSATIONS_MAX_ENTRIES = 200;
const BOUNDARY_REF_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const STABLE_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const textEncoder = new TextEncoder();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isCivilDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function parseTrainingExportRequest(value: unknown): unknown {
  if (!record(value) || typeof value.kind !== "string") throw new TypeError();
  if (value.kind === "activity") {
    if (
      !exactKeys(value, ["kind", "canonicalActivityId", "localDate", "format"]) ||
      typeof value.canonicalActivityId !== "string" ||
      !BOUNDARY_REF_PATTERN.test(value.canonicalActivityId) ||
      !isCivilDate(value.localDate) ||
      typeof value.format !== "string" ||
      !ACTIVITY_EXPORT_FORMATS.has(value.format)
    ) {
      throw new TypeError();
    }
    return {
      kind: value.kind,
      canonicalActivityId: value.canonicalActivityId,
      localDate: value.localDate,
      format: value.format,
    };
  }
  if (
    value.kind !== "workout-archive" ||
    !exactKeys(value, ["kind", "oldest", "newest", "format"]) ||
    !isCivilDate(value.oldest) ||
    !isCivilDate(value.newest) ||
    value.oldest > value.newest ||
    typeof value.format !== "string" ||
    !WORKOUT_ARCHIVE_FORMATS.has(value.format)
  ) {
    throw new TypeError();
  }
  return {
    kind: value.kind,
    oldest: value.oldest,
    newest: value.newest,
    format: value.format,
  };
}

function parseTrainingExportResult(value: unknown): unknown {
  if (!record(value) || typeof value.status !== "string") throw new TypeError();
  if (value.status === "cancelled" && exactKeys(value, ["status"])) return { status: value.status };
  if (
    value.status === "saved" &&
    exactKeys(value, ["status", "byteLength"]) &&
    typeof value.byteLength === "number" &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0
  ) {
    return { status: value.status, byteLength: value.byteLength };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["status", "reason"]) &&
    typeof value.reason === "string" &&
    TRAINING_EXPORT_REFUSAL_REASONS.has(value.reason)
  ) {
    return { status: value.status, reason: value.reason };
  }
  throw new TypeError();
}

function decodedBase64Url(value: string): Uint8Array | null {
  let accumulator = 0;
  let bits = 0;
  const decoded: number[] = [];
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  return bits === 0 ? Uint8Array.from(decoded) : null;
}

function safeCursorOffset(bytes: Uint8Array, offset: number): number | null {
  let value = 0;
  for (let index = offset; index < offset + 8; index += 1) {
    value = value * 256 + bytes[index]!;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function cursorOfVersion(value: unknown, version: number, archived: boolean): value is string {
  if (
    typeof value !== "string" ||
    value.length !== TRANSCRIPT_CURSOR_LENGTH ||
    !TRANSCRIPT_CURSOR_PATTERN.test(value)
  ) {
    return false;
  }
  const bytes = decodedBase64Url(value);
  if (bytes === null || bytes.length !== 114 || bytes[0] !== version) return false;
  const fenceKind = bytes[1];
  if (fenceKind !== 0 && fenceKind !== 1) return false;
  if (archived && fenceKind !== 1) return false;
  if (fenceKind === 0 && bytes.slice(34, 66).some((byte) => byte !== 0)) return false;
  const snapshotEnd = safeCursorOffset(bytes, 98);
  const before = safeCursorOffset(bytes, 106);
  return snapshotEnd !== null && before !== null && before <= snapshotEnd;
}

function transcriptCursor(value: unknown): value is string {
  return cursorOfVersion(value, TRANSCRIPT_CURSOR_VERSION, false);
}

function archivedTranscriptCursor(value: unknown): value is string {
  return cursorOfVersion(value, ARCHIVED_TRANSCRIPT_CURSOR_VERSION, true);
}

function boundaryRef(value: unknown): value is string {
  return typeof value === "string" && BOUNDARY_REF_PATTERN.test(value);
}

function boundedPageLimit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= TRANSCRIPT_PAGE_MAX_TURNS
  );
}

function parseTranscriptPageRequest(value: unknown): {
  readonly cursor: string | null;
  readonly limit: number;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["cursor", "limit"]) ||
    (value.cursor !== null && !transcriptCursor(value.cursor)) ||
    !boundedPageLimit(value.limit)
  ) {
    throw new TypeError();
  }
  return { cursor: value.cursor as string | null, limit: value.limit };
}

function parseArchivedPageRequest(value: unknown): {
  readonly boundaryRef: string;
  readonly cursor: string | null;
  readonly limit: number;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["boundaryRef", "cursor", "limit"]) ||
    !boundaryRef(value.boundaryRef) ||
    (value.cursor !== null && !archivedTranscriptCursor(value.cursor)) ||
    !boundedPageLimit(value.limit)
  ) {
    throw new TypeError();
  }
  return {
    boundaryRef: value.boundaryRef,
    cursor: value.cursor as string | null,
    limit: value.limit,
  };
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseTranscriptPage(
  value: unknown,
  schema: typeof GetTranscriptPageRpcResultSchema | typeof GetArchivedTranscriptPageRpcResultSchema,
): unknown {
  if (textEncoder.encode(JSON.stringify(value)).byteLength > TRANSCRIPT_PAGE_MAX_RESPONSE_BYTES) {
    throw new TypeError();
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError();
  return parsed.data;
}

function parseArchivedConversations(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "conversations", "truncated"]) ||
    value.schemaVersion !== 1 ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.conversations) ||
    value.conversations.length > ARCHIVED_CONVERSATIONS_MAX_ENTRIES ||
    (value.truncated && value.conversations.length < ARCHIVED_CONVERSATIONS_MAX_ENTRIES)
  ) {
    throw new TypeError();
  }
  const conversations = value.conversations.map((entry) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["boundaryRef", "boundaryAt", "reason", "turnCount"]) ||
      !boundaryRef(entry.boundaryRef) ||
      !canonicalIsoTimestamp(entry.boundaryAt) ||
      (entry.reason !== "explicit-reset" && entry.reason !== "stale-reset") ||
      !Number.isSafeInteger(entry.turnCount) ||
      (entry.turnCount as number) < 0
    ) {
      throw new TypeError();
    }
    return {
      boundaryRef: entry.boundaryRef,
      boundaryAt: entry.boundaryAt,
      reason: entry.reason,
      turnCount: entry.turnCount as number,
    };
  });
  if (new Set(conversations.map((entry) => entry.boundaryRef)).size !== conversations.length) {
    throw new TypeError();
  }
  return { schemaVersion: 1, conversations, truncated: value.truncated };
}

function safeString(value: unknown, maximumLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function normalizedSelectionText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new TypeError();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError();
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) throw new TypeError();
  return normalized;
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "[::1]") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet)) &&
    Number(octets[0]) === 127 &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

function normalizedEndpoint(value: unknown): string {
  const normalized = normalizedSelectionText(value, 4_096);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.href.includes("?") ||
    parsed.href.includes("#") ||
    parsed.hostname.length === 0 ||
    (parsed.protocol === "http:" && !loopbackHost(parsed.hostname))
  ) {
    throw new TypeError();
  }
  return normalized;
}

type PreloadLlmSelection = {
  readonly provider: (typeof LLM_PROVIDER_ORDER)[number];
  readonly model: string;
  readonly endpoint:
    | { readonly mode: "automatic" }
    | { readonly mode: "default" }
    | { readonly mode: "custom"; readonly value: string };
};

function parseLlmSelection(value: unknown): PreloadLlmSelection {
  if (!record(value) || !exactKeys(value, ["provider", "model", "endpoint"])) {
    throw new TypeError();
  }
  if (typeof value.provider !== "string" || !LLM_PROVIDERS.has(value.provider)) {
    throw new TypeError();
  }
  const provider = value.provider as PreloadLlmSelection["provider"];
  const model = normalizedSelectionText(value.model, 512);
  if (!record(value.endpoint) || typeof value.endpoint.mode !== "string") {
    throw new TypeError();
  }
  let endpoint: PreloadLlmSelection["endpoint"];
  if (value.endpoint.mode === "automatic" && exactKeys(value.endpoint, ["mode"])) {
    endpoint = { mode: "automatic" };
  } else if (value.endpoint.mode === "default" && exactKeys(value.endpoint, ["mode"])) {
    endpoint = { mode: "default" };
  } else if (value.endpoint.mode === "custom" && exactKeys(value.endpoint, ["mode", "value"])) {
    endpoint = { mode: "custom", value: normalizedEndpoint(value.endpoint.value) };
  } else {
    throw new TypeError();
  }
  if (endpoint.mode !== "automatic" && !DEFAULT_ENDPOINT_PROVIDERS.has(provider)) {
    throw new TypeError();
  }
  return { provider, model, endpoint };
}

function parseChatGptSelection(value: unknown): PreloadLlmSelection {
  const selection = parseLlmSelection(value);
  if (selection.provider !== "openai-codex" || selection.endpoint.mode !== "automatic") {
    throw new TypeError();
  }
  return selection;
}

function parseChatGptOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError();
  }
  return value;
}

function parseChatGptLoginInput(value: unknown): {
  readonly operationId: string;
  readonly selection: PreloadLlmSelection;
} {
  if (!record(value) || !exactKeys(value, ["operationId", "selection"])) {
    throw new TypeError();
  }
  return {
    operationId: parseChatGptOperationId(value.operationId),
    selection: parseChatGptSelection(value.selection),
  };
}

function parseCredentialWriteInput(value: unknown): {
  readonly slot: string;
  readonly value: string;
  readonly selection?: PreloadLlmSelection;
} {
  if (!record(value)) throw new TypeError();
  const hasSelection = Object.hasOwn(value, "selection");
  if (
    !exactKeys(value, hasSelection ? ["slot", "value", "selection"] : ["slot", "value"]) ||
    !SLOTS.has(value.slot as string) ||
    typeof value.value !== "string"
  ) {
    throw new TypeError();
  }
  if (!hasSelection) return { slot: value.slot as string, value: value.value };
  if (value.slot === "intervals-icu") throw new TypeError();
  const selection = parseLlmSelection(value.selection);
  if (selection.provider !== value.slot) throw new TypeError();
  return { slot: value.slot as string, value: value.value, selection };
}

function parseCredentialDeleteInput(value: unknown): { readonly credential: string } {
  if (
    !record(value) ||
    !exactKeys(value, ["credential"]) ||
    typeof value.credential !== "string" ||
    !CREDENTIALS.has(value.credential)
  ) {
    throw new TypeError();
  }
  return { credential: value.credential };
}

type PreloadUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | { readonly status: "downloading" | "downloaded" | "installing"; readonly version: string }
  | { readonly status: "restart-required"; readonly stage: "check" | "download" }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

function parseUpdateState(value: unknown): PreloadUpdateState {
  if (!record(value) || typeof value.status !== "string") throw new TypeError();
  if (["disabled", "idle", "checking", "current"].includes(value.status)) {
    if (!exactKeys(value, ["status"])) throw new TypeError();
    return { status: value.status as "disabled" | "idle" | "checking" | "current" };
  }
  if (["downloading", "downloaded", "installing"].includes(value.status)) {
    if (
      !exactKeys(value, ["status", "version"]) ||
      !safeString(value.version, 64) ||
      !STABLE_VERSION_RE.test(value.version)
    ) {
      throw new TypeError();
    }
    return {
      status: value.status as "downloading" | "downloaded" | "installing",
      version: value.version,
    };
  }
  if (
    (value.status !== "failed" && value.status !== "restart-required") ||
    !exactKeys(value, ["status", "stage"]) ||
    (value.stage !== "check" && value.stage !== "download")
  ) {
    throw new TypeError();
  }
  return { status: value.status, stage: value.stage };
}

function parseStatuses(value: unknown): unknown {
  if (
    !Array.isArray(value) ||
    value.length !== SLOTS.size ||
    new Set(value.map((entry) => (record(entry) ? entry.slot : undefined))).size !== SLOTS.size
  ) {
    throw new TypeError();
  }
  return value.map((entry) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["slot", "state", "runtimeState"]) ||
      !SLOTS.has(entry.slot as string) ||
      !STATES.has(entry.state as string) ||
      (entry.state === "configured"
        ? !RUNTIME_STATES.has(entry.runtimeState as string)
        : entry.runtimeState !== null)
    ) {
      throw new TypeError();
    }
    return { slot: entry.slot, state: entry.state, runtimeState: entry.runtimeState };
  });
}

function parseWriteResult(value: unknown): unknown {
  if (!record(value) || !SLOTS.has(value.slot as string)) throw new TypeError();
  if (
    value.status === "configured" &&
    exactKeys(value, ["slot", "status", "runtimeReady"]) &&
    typeof value.runtimeReady === "boolean"
  ) {
    return { slot: value.slot, status: "configured", runtimeReady: value.runtimeReady };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["slot", "status", "reason"]) &&
    REASONS.has(value.reason as string)
  ) {
    return { slot: value.slot, status: "refused", reason: value.reason };
  }
  if (
    value.status === "uncertain" &&
    exactKeys(value, ["slot", "status", "reason"]) &&
    value.reason === "storage-uncertain"
  ) {
    return { slot: value.slot, status: "uncertain", reason: "storage-uncertain" };
  }
  throw new TypeError();
}

function parseDeleteResult(value: unknown): unknown {
  if (
    record(value) &&
    value.status === "uncertain" &&
    exactKeys(value, ["slot", "status", "reason"]) &&
    SLOTS.has(value.slot as string) &&
    value.reason === "storage-uncertain"
  ) {
    return { slot: value.slot, status: "uncertain", reason: "storage-uncertain" };
  }
  if (
    !record(value) ||
    typeof value.credential !== "string" ||
    !CREDENTIALS.has(value.credential)
  ) {
    throw new TypeError();
  }
  if (
    value.status === "deleted" &&
    exactKeys(value, ["credential", "status", "cleanupPending"]) &&
    typeof value.cleanupPending === "boolean"
  ) {
    return {
      credential: value.credential,
      status: "deleted",
      cleanupPending: value.cleanupPending,
    };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["credential", "status", "reason"]) &&
    DELETE_REASONS.has(value.reason as string)
  ) {
    return { credential: value.credential, status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parseCredentialRecoveryStatus(value: unknown): unknown {
  if (!record(value) || typeof value.state !== "string") throw new TypeError();
  if (
    value.state === "ready" &&
    exactKeys(value, ["state", "unverifiedEnvelopes"]) &&
    Number.isSafeInteger(value.unverifiedEnvelopes) &&
    (value.unverifiedEnvelopes as number) >= 0
  ) {
    return { state: "ready", unverifiedEnvelopes: value.unverifiedEnvelopes };
  }
  if (
    (value.state === "locked" || value.state === "missing" || value.state === "unavailable") &&
    exactKeys(value, ["state"])
  ) {
    return { state: value.state };
  }
  throw new TypeError();
}

function parseCredentialResetResult(value: unknown): unknown {
  if (!record(value) || typeof value.status !== "string") throw new TypeError();
  if (
    value.status === "reset" &&
    exactKeys(value, ["status", "keyCleanupPending"]) &&
    typeof value.keyCleanupPending === "boolean"
  ) {
    return { status: "reset", keyCleanupPending: value.keyCleanupPending };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["status", "reason"]) &&
    (value.reason === "runtime-unavailable" || value.reason === "storage-failed")
  ) {
    return { status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parseLlmConfiguration(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "providers", "active"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.providers) ||
    value.providers.length !== LLM_CATALOGUE_PROVIDER_ORDER.length
  ) {
    throw new TypeError();
  }
  const providers = value.providers.map((entry, index) => {
    if (
      !record(entry) ||
      entry.provider !== LLM_CATALOGUE_PROVIDER_ORDER[index] ||
      typeof entry.provider !== "string"
    ) {
      throw new TypeError();
    }
    const hasDefaultBaseUrl = DEFAULT_ENDPOINT_PROVIDERS.has(entry.provider);
    if (
      !exactKeys(
        entry,
        hasDefaultBaseUrl
          ? ["provider", "defaultModel", "models", "defaultBaseUrl"]
          : ["provider", "defaultModel", "models"],
      ) ||
      !safeString(entry.defaultModel, 512) ||
      !Array.isArray(entry.models) ||
      entry.models.length === 0 ||
      entry.models.length > 100
    ) {
      throw new TypeError();
    }
    if (
      hasDefaultBaseUrl &&
      (typeof entry.defaultBaseUrl !== "string" ||
        normalizedEndpoint(entry.defaultBaseUrl) !== entry.defaultBaseUrl)
    ) {
      throw new TypeError();
    }
    const models = entry.models.map((model) => {
      if (!record(model)) throw new TypeError();
      const hasHint = Object.hasOwn(model, "hint");
      if (
        !exactKeys(model, hasHint ? ["value", "label", "hint"] : ["value", "label"]) ||
        !safeString(model.value, 512) ||
        !safeString(model.label, 512) ||
        (hasHint && !safeString(model.hint, 512))
      ) {
        throw new TypeError();
      }
      return {
        value: model.value,
        label: model.label,
        ...(hasHint ? { hint: model.hint } : {}),
      };
    });
    if (
      new Set(models.map((model) => model.value)).size !== models.length ||
      !models.some((model) => model.value === entry.defaultModel)
    ) {
      throw new TypeError();
    }
    return {
      provider: entry.provider,
      defaultModel: entry.defaultModel,
      models,
      ...(hasDefaultBaseUrl ? { defaultBaseUrl: entry.defaultBaseUrl } : {}),
    };
  });
  let active: { readonly provider: string; readonly model: string } | null = null;
  if (value.active !== null) {
    if (
      !record(value.active) ||
      !exactKeys(value.active, ["provider", "model"]) ||
      typeof value.active.provider !== "string" ||
      !LLM_PROVIDERS.has(value.active.provider) ||
      !safeString(value.active.model, 512)
    ) {
      throw new TypeError();
    }
    active = { provider: value.active.provider, model: value.active.model };
  }
  return { schemaVersion: 1, providers, active };
}

function parseLlmSelectionResult(value: unknown): unknown {
  if (!record(value)) throw new TypeError();
  if (
    value.status === "configured" &&
    exactKeys(value, ["status", "runtimeReady"]) &&
    value.runtimeReady === true
  ) {
    return { status: "configured", runtimeReady: true };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["status", "reason"]) &&
    ["invalid-input", "credential-required", "runtime-unavailable"].includes(value.reason as string)
  ) {
    return { status: "refused", reason: value.reason };
  }
  throw new TypeError();
}

function parseChatGptStatus(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["state", "runtimeReady"]) ||
    (value.state !== "configured" && value.state !== "absent") ||
    typeof value.runtimeReady !== "boolean"
  ) {
    throw new TypeError();
  }
  return { state: value.state, runtimeReady: value.runtimeReady };
}

function parseChatGptLogin(value: unknown, operationId: string): unknown {
  if (!record(value)) throw new TypeError();
  if (
    value.status === "stored" &&
    exactKeys(value, ["status", "operationId"]) &&
    value.operationId === operationId
  ) {
    return { status: "stored", operationId };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["status", "operationId", "reason"]) &&
    value.operationId === operationId &&
    CHATGPT_REASONS.has(value.reason as string)
  ) {
    return { status: "refused", operationId, reason: value.reason };
  }
  throw new TypeError();
}

function parseChatGptCancel(value: unknown, operationId: string): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["status", "operationId"]) ||
    (value.status !== "cancelling" && value.status !== "not-active") ||
    value.operationId !== operationId
  ) {
    throw new TypeError();
  }
  return { status: value.status, operationId };
}

interface PreloadChatGptLoginProgress {
  readonly operationId: string;
  readonly phase: "waiting-for-browser" | "completing-sign-in";
}

function parseChatGptLoginProgress(value: unknown): PreloadChatGptLoginProgress {
  if (
    !record(value) ||
    !exactKeys(value, ["operationId", "phase"]) ||
    (value.phase !== "waiting-for-browser" && value.phase !== "completing-sign-in")
  ) {
    throw new TypeError();
  }
  return { operationId: parseChatGptOperationId(value.operationId), phase: value.phase };
}

function parseClaudeCliStatus(value: unknown): unknown {
  if (!record(value) || typeof value.state !== "string" || !CLAUDE_CLI_STATES.has(value.state)) {
    throw new TypeError();
  }
  const keys = ["state"];
  for (const field of ["email", "plan", "version"]) {
    if (Object.hasOwn(value, field)) keys.push(field);
  }
  if (
    !exactKeys(value, keys) ||
    keys.some((field) => field !== "state" && !safeString(value[field], 512))
  ) {
    throw new TypeError();
  }
  return {
    state: value.state,
    ...(Object.hasOwn(value, "email") ? { email: value.email } : {}),
    ...(Object.hasOwn(value, "plan") ? { plan: value.plan } : {}),
    ...(Object.hasOwn(value, "version") ? { version: value.version } : {}),
  };
}

function parsePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TypeError();
  }
  const paths = value.map((path) => {
    if (!PlatformAbsolutePathSchema.safeParse(path).success) {
      throw new TypeError();
    }
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dot = path.lastIndexOf(".");
    if (dot <= slash || !IMPORT_EXTENSIONS.has(path.slice(dot).toLowerCase())) {
      throw new TypeError();
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new TypeError();
  return paths;
}

function parseAttachmentAdmissions(value: unknown): readonly AttachmentAdmissionReadModel[] {
  if (!Array.isArray(value) || value.length > CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage) {
    throw new TypeError();
  }
  return value.map((item) => AttachmentAdmissionReadModelSchema.parse(item));
}

function parsePlanningReadModel(value: unknown): unknown {
  const parsed = GetPlanningReadModelRpcResultSchema.safeParse(value);
  if (!parsed.success) throw new TypeError();
  return parsed.data;
}

function telegramUsername(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value);
}

function parseTelegramChannel(value: unknown): unknown {
  if (!record(value) || typeof value.state !== "string") throw new TypeError();
  const simple =
    (value.state === "disabled" && value.desiredState === "disabled") ||
    (["waiting-for-credential", "starting", "suspended"].includes(value.state) &&
      value.desiredState === "enabled") ||
    (value.state === "transfer-required" && value.desiredState === "enabled");
  if (simple && exactKeys(value, ["desiredState", "state"])) {
    return { desiredState: value.desiredState, state: value.state };
  }
  if (
    (value.state === "online" || value.state === "offline-retrying") &&
    value.desiredState === "enabled"
  ) {
    const keys = ["desiredState", "state"];
    if (Object.hasOwn(value, "lastSuccessfulPollAt")) {
      if (!canonicalIsoTimestamp(value.lastSuccessfulPollAt)) throw new TypeError();
      keys.push("lastSuccessfulPollAt");
    }
    if (!exactKeys(value, keys)) throw new TypeError();
    return {
      desiredState: "enabled",
      state: value.state,
      ...(Object.hasOwn(value, "lastSuccessfulPollAt")
        ? { lastSuccessfulPollAt: value.lastSuccessfulPollAt }
        : {}),
    };
  }
  const daemonError =
    (value.desiredState === "enabled" &&
      value.state === "invalid-token" &&
      value.errorCode === "telegram-invalid-token") ||
    (value.desiredState === "enabled" &&
      value.state === "conflict" &&
      value.errorCode === "telegram-polling-conflict") ||
    (value.state === "failed" &&
      value.desiredState === "enabled" &&
      value.errorCode === "telegram-start-failed");
  const desktopError =
    value.state === "failed" &&
    (value.desiredState === "disabled" || value.desiredState === "enabled") &&
    typeof value.errorCode === "string" &&
    TELEGRAM_DESKTOP_ERROR_CODES.has(value.errorCode);
  if ((daemonError || desktopError) && exactKeys(value, ["desiredState", "errorCode", "state"])) {
    return {
      desiredState: value.desiredState,
      state: value.state,
      errorCode: value.errorCode,
    };
  }
  throw new TypeError();
}

function parseTelegramBot(value: unknown): unknown {
  if (!record(value) || typeof value.state !== "string") throw new TypeError();
  if (value.state === "unconfigured" && exactKeys(value, ["state"])) {
    return { state: "unconfigured" };
  }
  if (
    (value.state === "ready" || value.state === "webhook-removal-required") &&
    telegramUsername(value.username) &&
    exactKeys(value, ["state", "username"])
  ) {
    return { state: value.state, username: value.username };
  }
  throw new TypeError();
}

function parseTelegramPairing(value: unknown): unknown {
  if (!record(value) || typeof value.state !== "string") throw new TypeError();
  if (["unpaired", "paired", "expired"].includes(value.state) && exactKeys(value, ["state"])) {
    return { state: value.state };
  }
  if (
    value.state === "awaiting-code" &&
    typeof value.code === "string" &&
    /^[A-F0-9]{6}$/.test(value.code) &&
    canonicalIsoTimestamp(value.expiresAt) &&
    exactKeys(value, ["code", "expiresAt", "state"])
  ) {
    return { state: value.state, code: value.code, expiresAt: value.expiresAt };
  }
  if (
    value.state === "failed" &&
    typeof value.errorCode === "string" &&
    TELEGRAM_PAIRING_ERROR_CODES.has(value.errorCode) &&
    exactKeys(value, ["errorCode", "state"])
  ) {
    return { state: value.state, errorCode: value.errorCode };
  }
  throw new TypeError();
}

function parseTelegramStatus(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["bot", "channel", "credentialConfigured", "gapWarning", "pairing"]) ||
    typeof value.credentialConfigured !== "boolean"
  ) {
    throw new TypeError();
  }
  let gapWarning: unknown;
  if (
    record(value.gapWarning) &&
    value.gapWarning.state === "clear" &&
    exactKeys(value.gapWarning, ["state"])
  ) {
    gapWarning = { state: "clear" };
  } else if (
    record(value.gapWarning) &&
    value.gapWarning.state === "possible-message-loss" &&
    canonicalIsoTimestamp(value.gapWarning.detectedAt) &&
    exactKeys(value.gapWarning, ["detectedAt", "state"])
  ) {
    gapWarning = {
      state: "possible-message-loss",
      detectedAt: value.gapWarning.detectedAt,
    };
  } else {
    throw new TypeError();
  }
  return {
    channel: parseTelegramChannel(value.channel),
    bot: parseTelegramBot(value.bot),
    pairing: parseTelegramPairing(value.pairing),
    credentialConfigured: value.credentialConfigured,
    gapWarning,
  };
}

function parseTelegramMutationResult(value: unknown): unknown {
  if (!record(value) || typeof value.outcome !== "string") throw new TypeError();
  if (value.outcome === "applied" && exactKeys(value, ["current", "outcome"])) {
    return { outcome: "applied", current: parseTelegramStatus(value.current) };
  }
  if (
    value.outcome === "refused" &&
    typeof value.reason === "string" &&
    TELEGRAM_MUTATION_REFUSAL_REASONS.has(value.reason) &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return {
      outcome: "refused",
      reason: value.reason,
      current: parseTelegramStatus(value.current),
    };
  }
  if (
    value.outcome === "uncertain" &&
    (value.reason === "storage-uncertain" || value.reason === "control-uncertain") &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return {
      outcome: "uncertain",
      reason: value.reason,
      current: parseTelegramStatus(value.current),
    };
  }
  throw new TypeError();
}

function parseIntervalsCredentialCurrent(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["runtimeState", "slot", "state"]) ||
    value.slot !== "intervals-icu" ||
    (value.state !== "missing" && value.state !== "configured" && value.state !== "re-prompt") ||
    (value.state === "configured"
      ? !RUNTIME_STATES.has(value.runtimeState as string)
      : value.runtimeState !== null)
  ) {
    throw new TypeError();
  }
  return {
    slot: "intervals-icu",
    state: value.state,
    runtimeState: value.runtimeState,
  };
}

function parseIntervalsCredentialMutationResult(value: unknown): unknown {
  if (!record(value) || typeof value.outcome !== "string") throw new TypeError();
  if (value.outcome === "applied" && exactKeys(value, ["current", "outcome"])) {
    return {
      outcome: "applied",
      current: parseIntervalsCredentialCurrent(value.current),
    };
  }
  if (
    value.outcome === "refused" &&
    typeof value.reason === "string" &&
    INTERVALS_CREDENTIAL_REFUSAL_REASONS.has(value.reason) &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return {
      outcome: "refused",
      reason: value.reason,
      current: parseIntervalsCredentialCurrent(value.current),
    };
  }
  if (
    value.outcome === "uncertain" &&
    (value.reason === "storage-uncertain" || value.reason === "runtime-uncertain") &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return {
      outcome: "uncertain",
      reason: value.reason,
      current: parseIntervalsCredentialCurrent(value.current),
    };
  }
  throw new TypeError();
}

function parseTelegramSenderInput(value: unknown): { readonly senderId: number } {
  if (
    !record(value) ||
    !exactKeys(value, ["senderId"]) ||
    !Number.isSafeInteger(value.senderId) ||
    (value.senderId as number) < 10
  ) {
    throw new TypeError();
  }
  return { senderId: value.senderId as number };
}

function parseTelegramSenders(value: unknown): unknown {
  if (!record(value) || !exactKeys(value, ["senders"]) || !Array.isArray(value.senders)) {
    throw new TypeError();
  }
  if (value.senders.length > 1_000) throw new TypeError();
  const senders = value.senders.map((sender) => {
    if (
      !record(sender) ||
      !Number.isSafeInteger(sender.senderId) ||
      (sender.senderId as number) < 10 ||
      (sender.role !== "primary" && sender.role !== "additional")
    ) {
      throw new TypeError();
    }
    const keys = ["role", "senderId"];
    if (Object.hasOwn(sender, "addedAt")) {
      if (!canonicalIsoTimestamp(sender.addedAt)) throw new TypeError();
      keys.push("addedAt");
    }
    if (!exactKeys(sender, keys)) throw new TypeError();
    return {
      senderId: sender.senderId,
      role: sender.role,
      ...(Object.hasOwn(sender, "addedAt") ? { addedAt: sender.addedAt } : {}),
    };
  });
  if (new Set(senders.map((sender) => sender.senderId)).size !== senders.length) {
    throw new TypeError();
  }
  const primaryCount = senders.filter((sender) => sender.role === "primary").length;
  if (primaryCount !== (senders.length === 0 ? 0 : 1)) throw new TypeError();
  return { senders };
}

function parseTelegramSenderMutation(value: unknown): unknown {
  if (!record(value) || typeof value.outcome !== "string") throw new TypeError();
  if (value.outcome === "applied" && exactKeys(value, ["current", "outcome"])) {
    return { outcome: "applied", current: parseTelegramSenders(value.current) };
  }
  if (
    value.outcome === "refused" &&
    (value.reason === "invalid-state" || value.reason === "control-unavailable") &&
    exactKeys(value, ["outcome", "reason"])
  ) {
    return { outcome: "refused", reason: value.reason };
  }
  if (
    value.outcome === "uncertain" &&
    (value.reason === "storage-uncertain" || value.reason === "control-uncertain") &&
    exactKeys(value, ["outcome", "reason"])
  ) {
    return { outcome: "uncertain", reason: value.reason };
  }
  throw new TypeError();
}

function requireZeroArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new TypeError();
}

async function invokeTelegramMutation(channel: string): Promise<unknown> {
  try {
    return parseTelegramMutationResult(await ipcRenderer.invoke(channel));
  } catch {
    throw new TypeError();
  }
}

async function invokeIntervalsCredentialMutation(): Promise<unknown> {
  try {
    return parseIntervalsCredentialMutationResult(
      await ipcRenderer.invoke(DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL),
    );
  } catch {
    throw new TypeError();
  }
}

async function invokeTelegramStatus(): Promise<unknown> {
  try {
    return parseTelegramStatus(await ipcRenderer.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL));
  } catch {
    throw new TypeError();
  }
}

async function invokeTelegramSenders(): Promise<unknown> {
  try {
    return parseTelegramSenders(
      await ipcRenderer.invoke(DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL),
    );
  } catch {
    throw new TypeError();
  }
}

let dropDisposer: (() => void) | undefined;
let chatAttachmentDropDisposer: (() => void) | undefined;
let chatAttachmentDropSequence = 0;
const openSettingsListeners = new Set<() => void>();
const updateListeners = new Set<(state: PreloadUpdateState) => void>();
const chatGptLoginProgressListeners = new Set<(progress: PreloadChatGptLoginProgress) => void>();
const planProgressListeners = new Set<(progress: PlanProgressEvent) => void>();
const desktopDocumentNavigationToken = desktopRendererNavigationToken(window.location.href);
if (desktopDocumentNavigationToken === undefined) throw new TypeError();

window.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const anchor = event
      .composedPath()
      .find((candidate): candidate is HTMLAnchorElement => candidate instanceof HTMLAnchorElement);
    if (anchor === undefined || anchor.target !== "_blank") return;
    event.preventDefault();
    ipcRenderer.send(DESKTOP_OPEN_EXTERNAL_CHANNEL, anchor.href);
  },
  true,
);

ipcRenderer.on(DESKTOP_LIFECYCLE_CHANNEL, (_event, value: unknown) => {
  if (
    !record(value) ||
    !exactKeys(value, ["generation", "status"]) ||
    !["ready", "recovering", "terminal", "closing"].includes(value.status as string) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1
  ) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent("enduragent-lifecycle", {
      detail: { status: value.status, generation: value.generation },
    }),
  );
});

ipcRenderer.on(DESKTOP_UPDATE_STATE_CHANNEL, (_event, value: unknown) => {
  let state: PreloadUpdateState;
  try {
    state = parseUpdateState(value);
  } catch {
    return;
  }
  for (const listener of updateListeners) {
    try {
      listener(parseUpdateState(state));
    } catch {}
  }
});

ipcRenderer.on(DESKTOP_CHATGPT_LOGIN_PROGRESS_CHANNEL, (_event, value: unknown) => {
  let progress: PreloadChatGptLoginProgress;
  try {
    progress = parseChatGptLoginProgress(value);
  } catch {
    return;
  }
  for (const listener of chatGptLoginProgressListeners) {
    try {
      listener(parseChatGptLoginProgress(progress));
    } catch {}
  }
});

ipcRenderer.on(DESKTOP_OPEN_SETTINGS_CHANNEL, () => {
  for (const listener of openSettingsListeners) listener();
});

ipcRenderer.on(DESKTOP_PLAN_PROGRESS_CHANNEL, (_event, value: unknown) => {
  const parsed = PlanProgressEventSchema.safeParse(value);
  if (!parsed.success) return;
  for (const listener of planProgressListeners) {
    try {
      listener(PlanProgressEventSchema.parse(parsed.data));
    } catch {}
  }
});

if (
  ipcRenderer.sendSync(DESKTOP_DOCUMENT_REGISTRATION_CHANNEL, {
    navigationToken: desktopDocumentNavigationToken,
  }) !== true
) {
  throw new TypeError();
}

contextBridge.exposeInMainWorld(
  "enduragentAuth",
  Object.freeze({
    platform: desktopPlatformProjection(),
    onOpenSettings: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const notify = (): void => {
        listener();
      };
      openSettingsListeners.add(notify);
      return (): void => {
        openSettingsListeners.delete(notify);
      };
    },
    getDaemonConnection: (failedGeneration?: number) => {
      if (
        failedGeneration !== undefined &&
        (!Number.isSafeInteger(failedGeneration) || failedGeneration < 1)
      ) {
        throw new TypeError();
      }
      return ipcRenderer.invoke(DESKTOP_CONNECTION_CHANNEL, {
        navigationToken: desktopDocumentNavigationToken,
        ...(failedGeneration === undefined ? {} : { generation: failedGeneration }),
      });
    },
    initialSetupStatusSettled: (...args: unknown[]) => {
      if (args.length !== 1) throw new TypeError();
      const input = args[0];
      if (
        !record(input) ||
        !exactKeys(input, ["generation"]) ||
        !Number.isSafeInteger(input.generation) ||
        (input.generation as number) < 1
      ) {
        throw new TypeError();
      }
      return ipcRenderer.invoke(DESKTOP_INITIAL_SETUP_STATUS_SETTLED_CHANNEL, {
        navigationToken: desktopDocumentNavigationToken,
        generation: input.generation,
      });
    },
    getTranscriptPage: async (input: unknown) => {
      const request = parseTranscriptPageRequest(input);
      return parseTranscriptPage(
        await ipcRenderer.invoke(DESKTOP_TRANSCRIPT_PAGE_CHANNEL, request),
        GetTranscriptPageRpcResultSchema,
      );
    },
    listArchivedConversations: async () =>
      parseArchivedConversations(await ipcRenderer.invoke(DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL)),
    deleteArchivedConversation: async (value: unknown, ...args: unknown[]) => {
      requireZeroArguments(args);
      if (!boundaryRef(value)) throw new TypeError();
      const result = DeleteArchivedConversationRpcResultSchema.safeParse(
        await ipcRenderer.invoke(DESKTOP_DELETE_ARCHIVED_CONVERSATION_CHANNEL, {
          boundaryRef: value,
        }),
      );
      if (!result.success) throw new TypeError();
      return result.data;
    },
    getArchivedTranscriptPage: async (input: unknown) => {
      const request = parseArchivedPageRequest(input);
      return parseTranscriptPage(
        await ipcRenderer.invoke(DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL, request),
        GetArchivedTranscriptPageRpcResultSchema,
      );
    },
    getPlanningReadModel: async () =>
      parsePlanningReadModel(await ipcRenderer.invoke(DESKTOP_PLANNING_READ_CHANNEL)),
    getPlanState: async (...args: unknown[]) => {
      requireZeroArguments(args);
      const parsed = GetPlanStateRpcResultSchema.safeParse(
        await ipcRenderer.invoke(DESKTOP_PLAN_STATE_CHANNEL),
      );
      if (!parsed.success) throw new TypeError();
      return parsed.data;
    },
    choosePlanRaceCourseFile: async (...args: unknown[]) => {
      requireZeroArguments(args);
      const parsed = PlanRaceCourseFileSelectionSchema.safeParse(
        await ipcRenderer.invoke(DESKTOP_PLAN_COURSE_FILE_CHANNEL),
      );
      if (!parsed.success) throw new TypeError();
      return parsed.data;
    },
    executePlanTransition: async (input: unknown, ...args: unknown[]) => {
      requireZeroArguments(args);
      const request = ExecutePlanTransitionRpcParamsSchema.safeParse(input);
      if (!request.success) throw new TypeError();
      const result = ExecutePlanTransitionRpcResultSchema.safeParse(
        await ipcRenderer.invoke(DESKTOP_PLAN_TRANSITION_CHANNEL, request.data),
      );
      if (!result.success) throw new TypeError();
      return result.data;
    },
    onPlanProgress: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const typedListener = listener as (progress: PlanProgressEvent) => void;
      planProgressListeners.add(typedListener);
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        planProgressListeners.delete(typedListener);
      };
    },
    credentialStatuses: async () =>
      parseStatuses(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL)),
    retryFailedCredentials: async () =>
      parseStatuses(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_RETRY_CHANNEL)),
    writeCredential: async (input: unknown) => {
      const parsed = parseCredentialWriteInput(input);
      return parseWriteResult(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, parsed));
    },
    deleteCredential: async (input: unknown) => {
      const parsed = parseCredentialDeleteInput(input);
      return parseDeleteResult(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, parsed));
    },
    credentialRecoveryStatus: async () =>
      parseCredentialRecoveryStatus(
        await ipcRenderer.invoke(DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL),
      ),
    retryCredentialRecovery: async () =>
      parseCredentialRecoveryStatus(
        await ipcRenderer.invoke(DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL),
      ),
    resetAllCredentials: async () =>
      parseCredentialResetResult(await ipcRenderer.invoke(DESKTOP_CREDENTIAL_RESET_CHANNEL)),
    llmConfiguration: async () =>
      parseLlmConfiguration(await ipcRenderer.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL)),
    applyLlmSelection: async (input: unknown) => {
      const selection = parseLlmSelection(input);
      return parseLlmSelectionResult(
        await ipcRenderer.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, selection),
      );
    },
    chatgptStatus: async () =>
      parseChatGptStatus(await ipcRenderer.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL)),
    chatgptLogin: async (input: unknown) => {
      const request = parseChatGptLoginInput(input);
      return parseChatGptLogin(
        await ipcRenderer.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, request),
        request.operationId,
      );
    },
    cancelChatgptLogin: async (input: unknown) => {
      const operationId = parseChatGptOperationId(input);
      return parseChatGptCancel(
        await ipcRenderer.invoke(DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL, { operationId }),
        operationId,
      );
    },
    onChatgptLoginProgress: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const typedListener = listener as (progress: PreloadChatGptLoginProgress) => void;
      chatGptLoginProgressListeners.add(typedListener);
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        chatGptLoginProgressListeners.delete(typedListener);
      };
    },
    claudeCliStatus: async () =>
      parseClaudeCliStatus(await ipcRenderer.invoke(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL)),
    claudeCliRecheck: async () =>
      parseClaudeCliStatus(await ipcRenderer.invoke(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL)),
    telegramStatus: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramStatus();
    },
    pasteIntervalsApiKeyFromClipboard: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeIntervalsCredentialMutation();
    },
    pasteTelegramTokenFromClipboard: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);
    },
    enableTelegram: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_ENABLE_CHANNEL);
    },
    disableTelegram: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_DISABLE_CHANNEL);
    },
    removeTelegram: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_REMOVE_CHANNEL);
    },
    reconcileTelegram: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_RECONCILE_CHANNEL);
    },
    removeTelegramWebhook: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL);
    },
    beginTelegramPairing: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL);
    },
    cancelTelegramPairing: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL);
    },
    listTelegramAllowedSenders: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramSenders();
    },
    addTelegramAllowedSender: async (input: unknown, ...args: unknown[]) => {
      requireZeroArguments(args);
      const sender = parseTelegramSenderInput(input);
      try {
        return parseTelegramSenderMutation(
          await ipcRenderer.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, sender),
        );
      } catch {
        return { outcome: "uncertain", reason: "control-uncertain" };
      }
    },
    removeTelegramAllowedSender: async (input: unknown, ...args: unknown[]) => {
      requireZeroArguments(args);
      const sender = parseTelegramSenderInput(input);
      try {
        return parseTelegramSenderMutation(
          await ipcRenderer.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, sender),
        );
      } catch {
        return { outcome: "uncertain", reason: "control-uncertain" };
      }
    },
    acknowledgeTelegramGapWarning: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeTelegramMutation(DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL);
    },
    setAppearance: (input: unknown, ...args: unknown[]) => {
      requireZeroArguments(args);
      const appearance = parseDesktopAppearance(input);
      if (appearance === undefined) throw new TypeError();
      ipcRenderer.send(DESKTOP_APPEARANCE_CHANNEL, appearance);
    },
    chooseImportFiles: async () =>
      parsePaths(await ipcRenderer.invoke(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL)),
    chooseChatAttachments: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return parseAttachmentAdmissions(
        await ipcRenderer.invoke(DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL),
      );
    },
    pasteChatAttachment: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return parseAttachmentAdmissions(
        await ipcRenderer.invoke(DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL),
      );
    },
    exportTrainingFile: async (input: unknown) => {
      const request = parseTrainingExportRequest(input);
      return parseTrainingExportResult(
        await ipcRenderer.invoke(DESKTOP_TRAINING_EXPORT_CHANNEL, request),
      );
    },
    getUpdateState: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_GET_CHANNEL)),
    checkForUpdates: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_CHECK_CHANNEL)),
    restartToUpdate: async () =>
      parseUpdateState(await ipcRenderer.invoke(DESKTOP_UPDATE_RESTART_CHANNEL)),
    onUpdateState: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const typedListener = listener as (state: PreloadUpdateState) => void;
      updateListeners.add(typedListener);
      let active = true;
      return (): void => {
        if (!active) return;
        active = false;
        updateListeners.delete(typedListener);
      };
    },
    onDroppedImportFiles: (listener: unknown) => {
      if (typeof listener !== "function" || dropDisposer !== undefined) throw new TypeError();
      const onDrop = (event: DragEvent): void => {
        event.preventDefault();
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter((path) => path.length > 0);
        if (paths.length > 0) listener(paths);
      };
      const onDragOver = (event: DragEvent): void => event.preventDefault();
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("drop", onDrop);
      const dispose = (): void => {
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("drop", onDrop);
        if (dropDisposer === dispose) dropDisposer = undefined;
      };
      dropDisposer = dispose;
      return dispose;
    },
    onDroppedChatAttachments: (listener: unknown) => {
      if (typeof listener !== "function" || chatAttachmentDropDisposer !== undefined) {
        throw new TypeError();
      }
      const onDrop = (event: DragEvent): void => {
        const target = event.target;
        if (
          !(target instanceof Element) ||
          target.closest("[data-chat-attachment-dropzone]") === null
        ) {
          return;
        }
        event.preventDefault();
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter((path) => PlatformAbsolutePathSchema.safeParse(path).success)
          .slice(0, CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage);
        if (paths.length === 0) return;
        const operationId = `drop-${++chatAttachmentDropSequence}`;
        let accepted = false;
        try {
          accepted = listener({ phase: "started", operationId }) === true;
        } catch {}
        if (!accepted) return;
        void ipcRenderer.invoke(DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL, paths).then(
          (value) => {
            let results: readonly AttachmentAdmissionReadModel[] | null = null;
            try {
              results = parseAttachmentAdmissions(value);
            } catch {}
            try {
              listener({ phase: "settled", operationId, results });
            } catch {}
          },
          () => {
            try {
              listener({ phase: "settled", operationId, results: null });
            } catch {}
          },
        );
      };
      const onDragOver = (event: DragEvent): void => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("[data-chat-attachment-dropzone]") !== null
        ) {
          event.preventDefault();
        }
      };
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("drop", onDrop);
      const dispose = (): void => {
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("drop", onDrop);
        if (chatAttachmentDropDisposer === dispose) chatAttachmentDropDisposer = undefined;
      };
      chatAttachmentDropDisposer = dispose;
      return dispose;
    },
  }),
);
