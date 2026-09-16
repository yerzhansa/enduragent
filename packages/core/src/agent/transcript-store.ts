import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ConversationResetInput,
  TranscriptCompletedTurnInput,
  TranscriptConversationBoundaryReason,
  TranscriptInterruptedTurnInput,
  TranscriptWriterPort,
} from "@enduragent/engine";
import {
  ChatAttachmentReferenceSchema,
  CoachDecisionAnswerSchema,
  CoachDecisionReadModelSchema,
  PlanReferenceSelectionSchema,
  PlanHandoffSuggestionSchema,
  PlanIntakePatchSchema,
  type CoachDecisionAnswer,
  type CoachDecisionContinuationLineage,
  type CoachDecisionOption,
  type CoachDecisionReadModel,
  type ChatAttachmentReference,
  type PlanReferenceSelection,
  type PlanHandoffSuggestion,
  type PlanIntakePatch,
} from "@enduragent/coach-contract";
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

const TRANSCRIPT_SCHEMA_VERSION = 1 as const;
const RESET_INTENT_SCHEMA_VERSION = 1 as const;
export const MAX_TRANSCRIPT_RECORD_BYTES = 262_144;
export const MAX_TRANSCRIPT_FILE_BYTES = 67_108_864;
export const MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES = MAX_TRANSCRIPT_RECORD_BYTES + 4_096;
export const MAX_TRANSCRIPT_PAGE_TURNS = 50;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RESET_ID_PATTERN = /^[a-f0-9]{64}$/;
const INTENT_TARGET_PATTERN = /^([a-f0-9]{64})\.reset-intent\.json$/;
const INTENT_TEMP_PATTERN = /^([a-f0-9]{64})\.([a-f0-9]{64})\.reset-intent\.tmp$/;
const TRANSCRIPT_CURSOR_BYTES = 114;
const TRANSCRIPT_CURSOR_LENGTH = 152;
const TRANSCRIPT_CURSOR_PATTERN = /^[A-Za-z0-9_-]{152}$/;
const TRANSCRIPT_CURSOR_VERSION = 1;
const ARCHIVED_TRANSCRIPT_CURSOR_VERSION = 2;
export const MAX_ARCHIVED_CONVERSATION_ENTRIES = 200;

type TranscriptWrite = (
  descriptor: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number,
  position: number | null,
) => number;

interface TranscriptStoreHooks {
  readonly write?: TranscriptWrite;
  readonly rename?: typeof renameSync;
  readonly syncFile?: (descriptor: number) => void;
  readonly syncDirectory?: (descriptor: number) => void;
  readonly beforeExistingFileOpen?: (path: string) => void;
  readonly afterChildOpen?: (path: string, descriptor: number) => void;
  readonly platform?: NodeJS.Platform;
}

type DirectoryDescriptor = number | null;

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface TranscriptBoundaryRecovery {
  readonly line: Buffer;
  readonly resetId: string;
  readonly tailLength: number;
}

class IncompleteTranscriptWriteError extends Error {
  constructor(readonly bytesWritten: number) {
    super("Transcript append was incomplete.");
    this.name = "IncompleteTranscriptWriteError";
  }
}

export class TranscriptBoundaryTargetUnchangedError extends Error {
  constructor(readonly originalError: unknown) {
    super("Conversation boundary append left the transcript target unchanged.", {
      cause: originalError,
    });
    this.name = "TranscriptBoundaryTargetUnchangedError";
  }
}

export interface TranscriptCompletedTurnRecord extends TranscriptCompletedTurnInput {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "turn-completed";
}

export interface TranscriptInterruptedTurnRecord extends TranscriptInterruptedTurnInput {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "turn-interrupted";
}

export interface TranscriptConversationBoundaryRecord extends ConversationResetInput {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "conversation-boundary";
  readonly resetId: string;
}

export interface TranscriptDecisionRequestedRecord {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "decision-requested";
  readonly chatId: string;
  readonly turnId?: string;
  readonly decisionId: string;
  readonly toolCallId: string;
  readonly messageId: string;
  readonly athleteText: string;
  readonly question: string;
  readonly options: CoachDecisionOption[];
  readonly requestedAt: string;
  readonly planIntakePatch?: PlanIntakePatch;
}

export interface TranscriptDecisionAnsweredRecord {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "decision-answered";
  readonly chatId: string;
  readonly decisionId: string;
  readonly answer: CoachDecisionAnswer;
  readonly consequence: string;
  readonly continuationId: string;
  readonly answeredAt: string;
}

export interface TranscriptDecisionSkippedRecord {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "decision-skipped";
  readonly chatId: string;
  readonly decisionId: string;
  readonly skippedAt: string;
}

export interface TranscriptDecisionAbandonedRecord {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "decision-abandoned";
  readonly chatId: string;
  readonly decisionId: string;
  readonly reason: "new_conversation";
  readonly abandonedAt: string;
}

export interface TranscriptDecisionContinuationCompletedRecord {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "decision-continuation-completed";
  readonly chatId: string;
  readonly decisionId: string;
  readonly continuationId: string;
  readonly turnId: string;
  readonly coachText: string;
  readonly lineage?: CoachDecisionContinuationLineage;
  readonly completedAt: string;
}

export interface ResetIntentRecord extends ConversationResetInput {
  readonly version: typeof RESET_INTENT_SCHEMA_VERSION;
  readonly kind: "conversation-reset-intent";
  readonly resetId: string;
}

export type TranscriptDecisionRecord =
  | TranscriptDecisionRequestedRecord
  | TranscriptDecisionAnsweredRecord
  | TranscriptDecisionSkippedRecord
  | TranscriptDecisionAbandonedRecord
  | TranscriptDecisionContinuationCompletedRecord;

export type TranscriptTurnRecord = TranscriptCompletedTurnRecord | TranscriptInterruptedTurnRecord;

export type TranscriptRecord =
  | TranscriptTurnRecord
  | TranscriptConversationBoundaryRecord
  | TranscriptDecisionRecord;

export interface TranscriptDecisionRequestedInput {
  readonly decision: CoachDecisionReadModel;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly athleteText: string;
  readonly requestedAt: string;
  readonly planIntakePatch?: PlanIntakePatch;
}

export interface TranscriptDecisionAnsweredInput {
  readonly chatId: string;
  readonly decisionId: string;
  readonly answer: CoachDecisionAnswer;
  readonly consequence: string;
  readonly continuationId: string;
  readonly answeredAt: string;
}

export interface TranscriptDecisionSkippedInput {
  readonly chatId: string;
  readonly decisionId: string;
  readonly skippedAt: string;
}

export interface TranscriptDecisionContinuationCompletedInput {
  readonly chatId: string;
  readonly decisionId: string;
  readonly continuationId: string;
  readonly turnId: string;
  readonly coachText: string;
  readonly lineage: CoachDecisionContinuationLineage;
  readonly completedAt: string;
}

export interface TranscriptPageTurn {
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
  readonly delivery?: "interrupted";
  readonly attachments?: ChatAttachmentReference[];
  readonly planReference?: PlanReferenceSelection;
  readonly planHandoff?: PlanHandoffSuggestion;
}

export type TranscriptPageEntry =
  | ({ readonly kind: "turn" } & TranscriptPageTurn)
  | {
      readonly kind: "decision-requested";
      readonly recordedAt: string;
      readonly athleteText: string;
      readonly decision: CoachDecisionReadModel;
    }
  | {
      readonly kind: "decision-answered";
      readonly recordedAt: string;
      readonly decisionId: string;
      readonly answer: CoachDecisionAnswer;
      readonly consequence: string;
      readonly continuationId: string;
    }
  | {
      readonly kind: "decision-skipped";
      readonly recordedAt: string;
      readonly decisionId: string;
    }
  | {
      readonly kind: "decision-abandoned";
      readonly recordedAt: string;
      readonly decisionId: string;
      readonly reason: "new_conversation";
    }
  | {
      readonly kind: "decision-continuation-completed";
      readonly recordedAt: string;
      readonly completedAt: string;
      readonly decisionId: string;
      readonly continuationId: string;
      readonly turnId: string;
      readonly coachText: string;
      readonly lineage?: CoachDecisionContinuationLineage;
    };

export interface TranscriptPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export type TranscriptPageResult =
  | {
      readonly schemaVersion: 1;
      readonly status: "page";
      readonly turns: TranscriptPageTurn[];
      readonly nextCursor: string | null;
    }
  | {
      readonly schemaVersion: 2;
      readonly status: "page";
      readonly turns: TranscriptPageTurn[];
      readonly entries: TranscriptPageEntry[];
      readonly nextCursor: string | null;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "restart-required";
      readonly turns: [];
      readonly nextCursor: null;
    };

export interface ArchivedConversationSummary {
  readonly boundaryRef: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
  readonly turnCount: number;
}

export interface ArchivedConversationList {
  readonly schemaVersion: 1;
  readonly conversations: ArchivedConversationSummary[];
  readonly truncated: boolean;
}

export interface ArchivedConversationDeletionManifest {
  readonly schemaVersion: 1;
  readonly boundaryRef: string;
  readonly boundaryAt: string;
  readonly turnIds: string[];
  readonly attachmentIds: string[];
  readonly manifestHash: string;
}

interface IndexedTranscriptTurn {
  readonly record: Exclude<TranscriptRecord, TranscriptConversationBoundaryRecord>;
  readonly start: number;
  readonly end: number;
}

interface CurrentTranscriptWindow {
  readonly trusted: boolean;
  readonly fenceKind: 0 | 1;
  readonly fence: Buffer;
  readonly turns: readonly IndexedTranscriptTurn[];
}

interface ArchivedTranscriptSegment {
  readonly boundary: TranscriptConversationBoundaryRecord;
  readonly start: number;
  readonly boundaryEnd: number;
  readonly turns: readonly IndexedTranscriptTurn[];
  readonly trusted: boolean;
}

export class ArchivedConversationDeletionConflictError extends Error {
  readonly code = "ARCHIVED_CONVERSATION_DELETION_CONFLICT";

  constructor() {
    super("Archived conversation changed before deletion completed.");
    this.name = "ArchivedConversationDeletionConflictError";
  }
}

interface DecodedTranscriptCursor {
  readonly fenceKind: 0 | 1;
  readonly chatDigest: Buffer;
  readonly fence: Buffer;
  readonly snapshotHash: Buffer;
  readonly snapshotEnd: number;
  readonly before: number;
}

export class UnsafeTranscriptTargetError extends Error {
  readonly code = "TRANSCRIPT_UNSAFE_TARGET";

  constructor() {
    super("Transcript storage target is unsafe.");
    this.name = "UnsafeTranscriptTargetError";
  }
}

export class TranscriptRecordTooLargeError extends Error {
  readonly code = "TRANSCRIPT_RECORD_TOO_LARGE";

  constructor() {
    super("Transcript record exceeds the maximum encoded size.");
    this.name = "TranscriptRecordTooLargeError";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isDecisionContinuationLineage(value: unknown): value is CoachDecisionContinuationLineage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["templateHash", "assembledHash", "provider", "model", "lineageVersion"];
  return (
    (hasExactKeys(record, keys) || hasExactKeys(record, [...keys, "planIntakePatch"])) &&
    typeof record.templateHash === "string" &&
    record.templateHash.length > 0 &&
    typeof record.assembledHash === "string" &&
    record.assembledHash.length > 0 &&
    typeof record.provider === "string" &&
    record.provider.length > 0 &&
    typeof record.model === "string" &&
    record.model.length > 0 &&
    typeof record.lineageVersion === "string" &&
    record.lineageVersion.length > 0 &&
    (!Object.hasOwn(record, "planIntakePatch") ||
      PlanIntakePatchSchema.safeParse(record.planIntakePatch).success)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function isStrictPrivateDirectory(stats: Stats): boolean {
  return !stats.isSymbolicLink() && stats.isDirectory() && (stats.mode & 0o7777) === 0o700;
}

function isStrictPrivateFile(stats: Stats, allowedLinks: 1 | 2 = 1): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isFile() &&
    (stats.mode & 0o7777) === 0o600 &&
    stats.nlink === allowedLinks
  );
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  let text: string;
  try {
    text = STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function parseRecordBytes(bytes: Buffer): TranscriptRecord | null {
  if (bytes.length + 1 > MAX_TRANSCRIPT_RECORD_BYTES) return null;
  const value = parseJsonObject(bytes);
  if (value === null || value.version !== TRANSCRIPT_SCHEMA_VERSION) return null;

  if (value.kind === "turn-completed" || value.kind === "turn-interrupted") {
    const keys = ["version", "kind", "chatId", "turnId", "completedAt", "athleteText", "coachText"];
    const optionalKeys = [
      ...(value.attachments === undefined ? [] : ["attachments"]),
      ...(value.planReference === undefined ? [] : ["planReference"]),
      ...(value.planHandoff === undefined ? [] : ["planHandoff"]),
    ];
    if (
      !hasExactKeys(value, [...keys, ...optionalKeys]) ||
      typeof value.chatId !== "string" ||
      typeof value.turnId !== "string" ||
      value.turnId.length === 0 ||
      typeof value.completedAt !== "string" ||
      !isIsoTimestamp(value.completedAt) ||
      typeof value.athleteText !== "string" ||
      typeof value.coachText !== "string" ||
      (value.kind === "turn-interrupted" && value.planReference !== undefined) ||
      (value.kind === "turn-interrupted" && value.planHandoff !== undefined) ||
      (value.attachments !== undefined &&
        !ChatAttachmentReferenceSchema.array().max(5).safeParse(value.attachments).success) ||
      (value.planReference !== undefined &&
        !PlanReferenceSelectionSchema.safeParse(value.planReference).success) ||
      (value.planHandoff !== undefined &&
        !PlanHandoffSuggestionSchema.safeParse(value.planHandoff).success)
    ) {
      return null;
    }
    return value as unknown as TranscriptTurnRecord;
  }

  if (value.kind === "conversation-boundary") {
    if (
      !hasExactKeys(value, ["version", "kind", "resetId", "chatId", "boundaryAt", "reason"]) ||
      typeof value.resetId !== "string" ||
      !RESET_ID_PATTERN.test(value.resetId) ||
      typeof value.chatId !== "string" ||
      typeof value.boundaryAt !== "string" ||
      !isIsoTimestamp(value.boundaryAt) ||
      (value.reason !== "explicit-reset" && value.reason !== "stale-reset")
    ) {
      return null;
    }
    return value as unknown as TranscriptConversationBoundaryRecord;
  }

  if (value.kind === "decision-requested") {
    if (
      (!hasExactKeys(value, [
        "version",
        "kind",
        "chatId",
        "decisionId",
        "toolCallId",
        "messageId",
        "athleteText",
        "question",
        "options",
        "requestedAt",
      ]) &&
        !hasExactKeys(value, [
          "version",
          "kind",
          "chatId",
          "turnId",
          "decisionId",
          "toolCallId",
          "messageId",
          "athleteText",
          "question",
          "options",
          "requestedAt",
        ]) &&
        !hasExactKeys(value, [
          "version",
          "kind",
          "chatId",
          "decisionId",
          "toolCallId",
          "messageId",
          "athleteText",
          "question",
          "options",
          "requestedAt",
          "planIntakePatch",
        ]) &&
        !hasExactKeys(value, [
          "version",
          "kind",
          "chatId",
          "turnId",
          "decisionId",
          "toolCallId",
          "messageId",
          "athleteText",
          "question",
          "options",
          "requestedAt",
          "planIntakePatch",
        ])) ||
      typeof value.chatId !== "string" ||
      (value.turnId !== undefined &&
        (typeof value.turnId !== "string" || value.turnId.length === 0)) ||
      typeof value.decisionId !== "string" ||
      value.decisionId.length === 0 ||
      typeof value.toolCallId !== "string" ||
      value.toolCallId.length === 0 ||
      typeof value.messageId !== "string" ||
      value.messageId.length === 0 ||
      typeof value.athleteText !== "string" ||
      typeof value.question !== "string" ||
      !Array.isArray(value.options) ||
      !isIsoTimestamp(String(value.requestedAt)) ||
      (value.planIntakePatch !== undefined &&
        !PlanIntakePatchSchema.safeParse(value.planIntakePatch).success) ||
      !CoachDecisionReadModelSchema.safeParse({
        status: "unanswered",
        decisionId: value.decisionId,
        chatId: value.chatId,
        messageId: value.messageId,
        question: value.question,
        options: value.options,
      }).success
    ) {
      return null;
    }
    return value as unknown as TranscriptDecisionRequestedRecord;
  }

  if (value.kind === "decision-answered") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "chatId",
        "decisionId",
        "answer",
        "consequence",
        "continuationId",
        "answeredAt",
      ]) ||
      typeof value.chatId !== "string" ||
      typeof value.decisionId !== "string" ||
      value.decisionId.length === 0 ||
      !CoachDecisionAnswerSchema.safeParse(value.answer).success ||
      typeof value.consequence !== "string" ||
      value.consequence.length === 0 ||
      value.consequence.length > 2_000 ||
      typeof value.continuationId !== "string" ||
      value.continuationId.length === 0 ||
      typeof value.answeredAt !== "string" ||
      !isIsoTimestamp(value.answeredAt)
    ) {
      return null;
    }
    return value as unknown as TranscriptDecisionAnsweredRecord;
  }

  if (value.kind === "decision-skipped") {
    if (
      !hasExactKeys(value, ["version", "kind", "chatId", "decisionId", "skippedAt"]) ||
      typeof value.chatId !== "string" ||
      typeof value.decisionId !== "string" ||
      value.decisionId.length === 0 ||
      typeof value.skippedAt !== "string" ||
      !isIsoTimestamp(value.skippedAt)
    )
      return null;
    return value as unknown as TranscriptDecisionSkippedRecord;
  }

  if (value.kind === "decision-abandoned") {
    if (
      !hasExactKeys(value, ["version", "kind", "chatId", "decisionId", "reason", "abandonedAt"]) ||
      typeof value.chatId !== "string" ||
      typeof value.decisionId !== "string" ||
      value.decisionId.length === 0 ||
      value.reason !== "new_conversation" ||
      typeof value.abandonedAt !== "string" ||
      !isIsoTimestamp(value.abandonedAt)
    )
      return null;
    return value as unknown as TranscriptDecisionAbandonedRecord;
  }

  if (value.kind === "decision-continuation-completed") {
    const keys = [
      "version",
      "kind",
      "chatId",
      "decisionId",
      "continuationId",
      "turnId",
      "coachText",
      "completedAt",
    ];
    if (
      (!hasExactKeys(value, keys) && !hasExactKeys(value, [...keys, "lineage"])) ||
      typeof value.chatId !== "string" ||
      typeof value.decisionId !== "string" ||
      value.decisionId.length === 0 ||
      typeof value.continuationId !== "string" ||
      value.continuationId.length === 0 ||
      typeof value.turnId !== "string" ||
      value.turnId.length === 0 ||
      typeof value.coachText !== "string" ||
      (Object.hasOwn(value, "lineage") && !isDecisionContinuationLineage(value.lineage)) ||
      typeof value.completedAt !== "string" ||
      !isIsoTimestamp(value.completedAt)
    )
      return null;
    return value as unknown as TranscriptDecisionContinuationCompletedRecord;
  }

  return null;
}

function completedTurnRecord(input: TranscriptCompletedTurnInput): TranscriptCompletedTurnRecord {
  if (
    typeof input.chatId !== "string" ||
    typeof input.turnId !== "string" ||
    input.turnId.length === 0 ||
    typeof input.completedAt !== "string" ||
    !isIsoTimestamp(input.completedAt) ||
    typeof input.athleteText !== "string" ||
    typeof input.coachText !== "string" ||
    (input.attachments !== undefined &&
      !ChatAttachmentReferenceSchema.array().max(5).safeParse(input.attachments).success) ||
    (input.planReference !== undefined &&
      !PlanReferenceSelectionSchema.safeParse(input.planReference).success) ||
    (input.planHandoff !== undefined &&
      !PlanHandoffSuggestionSchema.safeParse(input.planHandoff).success)
  ) {
    throw new TypeError("Completed transcript turn is invalid.");
  }
  return {
    version: TRANSCRIPT_SCHEMA_VERSION,
    kind: "turn-completed",
    chatId: input.chatId,
    turnId: input.turnId,
    completedAt: input.completedAt,
    athleteText: input.athleteText,
    coachText: input.coachText,
    ...(input.attachments === undefined ? {} : { attachments: [...input.attachments] }),
    ...(input.planReference === undefined ? {} : { planReference: { ...input.planReference } }),
    ...(input.planHandoff === undefined ? {} : { planHandoff: { ...input.planHandoff } }),
  };
}

function interruptedTurnRecord(
  input: TranscriptInterruptedTurnInput,
): TranscriptInterruptedTurnRecord {
  if (input.planReference !== undefined || input.planHandoff !== undefined) {
    throw new TypeError("Interrupted transcript turn cannot carry Plan metadata.");
  }
  const completed = completedTurnRecord(input);
  return { ...completed, kind: "turn-interrupted" };
}

function validateResetFields(input: {
  readonly resetId: string;
  readonly chatId: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
}): void {
  if (
    typeof input.resetId !== "string" ||
    !RESET_ID_PATTERN.test(input.resetId) ||
    typeof input.chatId !== "string" ||
    typeof input.boundaryAt !== "string" ||
    !isIsoTimestamp(input.boundaryAt) ||
    (input.reason !== "explicit-reset" && input.reason !== "stale-reset")
  ) {
    throw new TypeError("Conversation reset record is invalid.");
  }
}

function conversationBoundaryRecord(
  input: ResetIntentRecord,
): TranscriptConversationBoundaryRecord {
  validateResetFields(input);
  return {
    version: TRANSCRIPT_SCHEMA_VERSION,
    kind: "conversation-boundary",
    resetId: input.resetId,
    chatId: input.chatId,
    boundaryAt: input.boundaryAt,
    reason: input.reason,
  };
}

function resetIntentRecord(input: {
  readonly resetId: string;
  readonly chatId: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
}): ResetIntentRecord {
  validateResetFields(input);
  return {
    version: RESET_INTENT_SCHEMA_VERSION,
    kind: "conversation-reset-intent",
    resetId: input.resetId,
    chatId: input.chatId,
    boundaryAt: input.boundaryAt,
    reason: input.reason,
  };
}

function parseResetIntent(bytes: Buffer): ResetIntentRecord | null {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) return null;
  const value = parseJsonObject(bytes.subarray(0, bytes.length - 1));
  if (
    value === null ||
    !hasExactKeys(value, ["version", "kind", "resetId", "chatId", "boundaryAt", "reason"]) ||
    value.version !== RESET_INTENT_SCHEMA_VERSION ||
    value.kind !== "conversation-reset-intent" ||
    typeof value.resetId !== "string" ||
    typeof value.chatId !== "string" ||
    typeof value.boundaryAt !== "string" ||
    (value.reason !== "explicit-reset" && value.reason !== "stale-reset")
  ) {
    return null;
  }
  try {
    return resetIntentRecord({
      resetId: value.resetId,
      chatId: value.chatId,
      boundaryAt: value.boundaryAt,
      reason: value.reason,
    });
  } catch {
    return null;
  }
}

function serializeTranscriptRecord(record: TranscriptRecord): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.length > MAX_TRANSCRIPT_RECORD_BYTES) {
    throw new TranscriptRecordTooLargeError();
  }
  return bytes;
}

function canonicalBoundaryLine(record: TranscriptConversationBoundaryRecord): Buffer {
  const bytes = serializeTranscriptRecord(record);
  return bytes.subarray(0, bytes.length - 1);
}

function isCanonicalBoundaryPrefix(prefix: Buffer, complete: Buffer): boolean {
  return (
    prefix.length > 0 &&
    prefix.length <= complete.length &&
    complete.subarray(0, prefix.length).equals(prefix)
  );
}

function sameResetIntent(left: ResetIntentRecord, right: ResetIntentRecord): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.resetId === right.resetId &&
    left.chatId === right.chatId &&
    left.boundaryAt === right.boundaryAt &&
    left.reason === right.reason
  );
}

function parseCurrentWindow(contents: Buffer, chatId: string): CurrentTranscriptWindow {
  let trusted = true;
  let fenceKind: 0 | 1 = 0;
  let fence = Buffer.alloc(32);
  let turns: IndexedTranscriptTurn[] = [];
  let lineStart = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0x0a) continue;
    const lineBytes = contents.subarray(lineStart, index);
    const recordStart = lineStart;
    lineStart = index + 1;
    const record = lineBytes.length === 0 ? null : parseRecordBytes(lineBytes);
    if (record === null || record.chatId !== chatId) {
      trusted = false;
      turns = [];
      continue;
    }
    if (record.kind === "conversation-boundary") {
      trusted = true;
      fenceKind = 1;
      fence = Buffer.from(record.resetId, "hex");
      turns = [];
    } else if (trusted) {
      turns.push({ record, start: recordStart, end: lineStart });
    }
  }
  if (lineStart !== contents.length) {
    trusted = false;
    turns = [];
  }
  return { trusted, fenceKind, fence, turns };
}

function parseArchivedSegments(contents: Buffer, chatId: string): ArchivedTranscriptSegment[] {
  const segments: ArchivedTranscriptSegment[] = [];
  let trusted = true;
  let turns: IndexedTranscriptTurn[] = [];
  let segmentStart = 0;
  let lineStart = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0x0a) continue;
    const lineBytes = contents.subarray(lineStart, index);
    const recordStart = lineStart;
    lineStart = index + 1;
    const record = lineBytes.length === 0 ? null : parseRecordBytes(lineBytes);
    if (record === null || record.chatId !== chatId) {
      trusted = false;
      turns = [];
      continue;
    }
    if (record.kind === "conversation-boundary") {
      segments.push({
        boundary: record,
        start: segmentStart,
        boundaryEnd: lineStart,
        turns,
        trusted,
      });
      segmentStart = lineStart;
      trusted = true;
      turns = [];
    } else if (trusted) {
      turns.push({ record, start: recordStart, end: lineStart });
    }
  }
  return segments;
}

function archivedConversationManifest(
  contents: Buffer,
  segment: ArchivedTranscriptSegment,
): ArchivedConversationDeletionManifest {
  if (!segment.trusted) {
    throw new Error("Archived conversation cannot be safely inspected.");
  }
  const turnIds = new Set<string>();
  const attachmentIds = new Set<string>();
  for (const { record } of segment.turns) {
    if ("turnId" in record && typeof record.turnId === "string") {
      turnIds.add(record.turnId);
    }
    if (
      (record.kind === "turn-completed" || record.kind === "turn-interrupted") &&
      record.attachments !== undefined
    ) {
      for (const attachment of record.attachments) attachmentIds.add(attachment.attachmentId);
    }
  }
  return {
    schemaVersion: 1,
    boundaryRef: segment.boundary.resetId,
    boundaryAt: segment.boundary.boundaryAt,
    turnIds: [...turnIds],
    attachmentIds: [...attachmentIds],
    manifestHash: createHash("sha256")
      .update(contents.subarray(segment.start, segment.boundaryEnd))
      .digest("hex"),
  };
}

function isArchivedConversationDeletionManifest(
  value: unknown,
): value is ArchivedConversationDeletionManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, [
      "schemaVersion",
      "boundaryRef",
      "boundaryAt",
      "turnIds",
      "attachmentIds",
      "manifestHash",
    ]) &&
    record.schemaVersion === 1 &&
    typeof record.boundaryRef === "string" &&
    RESET_ID_PATTERN.test(record.boundaryRef) &&
    typeof record.boundaryAt === "string" &&
    isIsoTimestamp(record.boundaryAt) &&
    Array.isArray(record.turnIds) &&
    record.turnIds.every((turnId) => typeof turnId === "string" && turnId.length > 0) &&
    new Set(record.turnIds).size === record.turnIds.length &&
    Array.isArray(record.attachmentIds) &&
    record.attachmentIds.every(
      (attachmentId) => typeof attachmentId === "string" && attachmentId.length > 0,
    ) &&
    new Set(record.attachmentIds).size === record.attachmentIds.length &&
    typeof record.manifestHash === "string" &&
    RESET_ID_PATTERN.test(record.manifestHash)
  );
}

function sameArchivedConversationDeletionManifest(
  left: ArchivedConversationDeletionManifest,
  right: ArchivedConversationDeletionManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectArchivedSegment(
  segments: readonly ArchivedTranscriptSegment[],
  boundaryRef: string,
): ArchivedTranscriptSegment | null {
  const matches = segments.filter((segment) => segment.boundary.resetId === boundaryRef);
  if (matches.length > 1) throw new Error("Transcript contains duplicate reset boundaries.");
  return matches[0] ?? null;
}

function decodeSafeOffset(bytes: Buffer, offset: number): number | null {
  const value = bytes.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function decodeCursorVersion(value: string, version: number): DecodedTranscriptCursor | null {
  if (!TRANSCRIPT_CURSOR_PATTERN.test(value) || value.length !== TRANSCRIPT_CURSOR_LENGTH) {
    return null;
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length !== TRANSCRIPT_CURSOR_BYTES ||
    bytes.toString("base64url") !== value ||
    bytes[0] !== version ||
    (bytes[1] !== 0 && bytes[1] !== 1)
  ) {
    return null;
  }
  const fenceKind = bytes[1] as 0 | 1;
  const fence = Buffer.from(bytes.subarray(34, 66));
  if (fenceKind === 0 && fence.some((byte) => byte !== 0)) return null;
  const snapshotEnd = decodeSafeOffset(bytes, 98);
  const before = decodeSafeOffset(bytes, 106);
  if (snapshotEnd === null || before === null || before > snapshotEnd) return null;
  return {
    fenceKind,
    chatDigest: Buffer.from(bytes.subarray(2, 34)),
    fence,
    snapshotHash: Buffer.from(bytes.subarray(66, 98)),
    snapshotEnd,
    before,
  };
}

function decodeTranscriptCursor(value: string): DecodedTranscriptCursor | null {
  return decodeCursorVersion(value, TRANSCRIPT_CURSOR_VERSION);
}

function decodeArchivedTranscriptCursor(value: string): DecodedTranscriptCursor | null {
  const decoded = decodeCursorVersion(value, ARCHIVED_TRANSCRIPT_CURSOR_VERSION);
  return decoded === null || decoded.fenceKind !== 1 ? null : decoded;
}

function encodeCursorVersion(input: DecodedTranscriptCursor, version: number): string {
  const bytes = Buffer.alloc(TRANSCRIPT_CURSOR_BYTES);
  bytes[0] = version;
  bytes[1] = input.fenceKind;
  input.chatDigest.copy(bytes, 2);
  input.fence.copy(bytes, 34);
  input.snapshotHash.copy(bytes, 66);
  bytes.writeBigUInt64BE(BigInt(input.snapshotEnd), 98);
  bytes.writeBigUInt64BE(BigInt(input.before), 106);
  return bytes.toString("base64url");
}

function encodeTranscriptCursor(input: DecodedTranscriptCursor): string {
  return encodeCursorVersion(input, TRANSCRIPT_CURSOR_VERSION);
}

function encodeArchivedTranscriptCursor(input: DecodedTranscriptCursor): string {
  return encodeCursorVersion(input, ARCHIVED_TRANSCRIPT_CURSOR_VERSION);
}

function transcriptPageTurn(record: TranscriptTurnRecord): TranscriptPageTurn {
  return {
    turnId: record.turnId,
    completedAt: record.completedAt,
    athleteText: record.athleteText,
    coachText: record.coachText,
    ...(record.attachments === undefined ? {} : { attachments: [...record.attachments] }),
    ...(record.planReference === undefined ? {} : { planReference: record.planReference }),
    ...(record.planHandoff === undefined ? {} : { planHandoff: record.planHandoff }),
    ...(record.kind === "turn-interrupted" ? { delivery: "interrupted" as const } : {}),
  };
}

function transcriptPageEntry(
  record: Exclude<TranscriptRecord, TranscriptConversationBoundaryRecord>,
): TranscriptPageEntry {
  if (record.kind === "turn-completed" || record.kind === "turn-interrupted") {
    return { kind: "turn", ...transcriptPageTurn(record) };
  }
  if (record.kind === "decision-requested") {
    return {
      kind: record.kind,
      recordedAt: record.requestedAt,
      athleteText: record.athleteText,
      decision: {
        status: "unanswered",
        decisionId: record.decisionId,
        chatId: record.chatId,
        messageId: record.messageId,
        question: record.question,
        options: record.options,
      },
    };
  }
  if (record.kind === "decision-answered") {
    return {
      kind: record.kind,
      recordedAt: record.answeredAt,
      decisionId: record.decisionId,
      answer: record.answer,
      consequence: record.consequence,
      continuationId: record.continuationId,
    };
  }
  if (record.kind === "decision-skipped") {
    return { kind: record.kind, recordedAt: record.skippedAt, decisionId: record.decisionId };
  }
  if (record.kind === "decision-abandoned") {
    return {
      kind: record.kind,
      recordedAt: record.abandonedAt,
      decisionId: record.decisionId,
      reason: record.reason,
    };
  }
  return {
    kind: record.kind,
    recordedAt: record.completedAt,
    completedAt: record.completedAt,
    decisionId: record.decisionId,
    continuationId: record.continuationId,
    turnId: record.turnId,
    coachText: record.coachText,
    ...(record.lineage === undefined ? {} : { lineage: record.lineage }),
  };
}

function restartRequiredPage(): TranscriptPageResult {
  return {
    schemaVersion: 1,
    status: "restart-required",
    turns: [],
    nextCursor: null,
  };
}

function pageResult(
  turns: readonly IndexedTranscriptTurn[],
  nextCursor: string | null,
): TranscriptPageResult {
  const pageTurns = turns.flatMap(({ record }) =>
    record.kind === "turn-completed" || record.kind === "turn-interrupted"
      ? [transcriptPageTurn(record)]
      : [],
  );
  if (
    turns.every(
      ({ record }) => record.kind === "turn-completed" || record.kind === "turn-interrupted",
    )
  ) {
    return { schemaVersion: 1, status: "page", turns: pageTurns, nextCursor };
  }
  return {
    schemaVersion: 2,
    status: "page",
    turns: pageTurns,
    entries: turns.map(({ record }) => transcriptPageEntry(record)),
    nextCursor,
  };
}

function encodedPageBytes(result: TranscriptPageResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function transcriptUnitKey(
  record: Exclude<TranscriptRecord, TranscriptConversationBoundaryRecord>,
): string {
  return record.kind === "turn-completed" || record.kind === "turn-interrupted"
    ? `turn:${record.turnId}`
    : `decision:${record.decisionId}`;
}

function decisionReadModels(
  records: readonly Exclude<TranscriptRecord, TranscriptConversationBoundaryRecord>[],
): Map<string, CoachDecisionReadModel> {
  const decisions = new Map<string, CoachDecisionReadModel>();
  for (const record of records) {
    if (record.kind === "decision-requested") {
      decisions.set(record.decisionId, {
        status: "unanswered",
        decisionId: record.decisionId,
        chatId: record.chatId,
        messageId: record.messageId,
        question: record.question,
        options: record.options,
      });
      continue;
    }
    if (record.kind === "turn-completed" || record.kind === "turn-interrupted") continue;
    const current = decisions.get(record.decisionId);
    if (current === undefined) continue;
    if (record.kind === "decision-answered" && current.status === "unanswered") {
      decisions.set(record.decisionId, {
        ...current,
        status: "answered",
        answer: record.answer,
        consequence: record.consequence,
        continuation: { continuationId: record.continuationId, status: "pending" },
      });
      continue;
    }
    if (record.kind === "decision-skipped" && current.status === "unanswered") {
      decisions.set(record.decisionId, { ...current, status: "skipped" });
      continue;
    }
    if (record.kind === "decision-abandoned" && current.status === "unanswered") {
      decisions.set(record.decisionId, {
        ...current,
        status: "abandoned",
        reason: record.reason,
      });
      continue;
    }
    if (
      record.kind === "decision-continuation-completed" &&
      current.status === "answered" &&
      current.continuation.continuationId === record.continuationId
    ) {
      decisions.set(record.decisionId, {
        ...current,
        continuation: {
          continuationId: record.continuationId,
          status: "completed",
          turnId: record.turnId,
          coachText: record.coachText,
          ...(record.lineage === undefined ? {} : { lineage: record.lineage }),
        },
      });
    }
  }
  return decisions;
}

function assertValidPageRequest(
  request: TranscriptPageRequest,
  decode: (value: string) => DecodedTranscriptCursor | null,
): void {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== 2 ||
    !Object.hasOwn(request, "cursor") ||
    !Object.hasOwn(request, "limit") ||
    (request.cursor !== null && decode(request.cursor) === null) ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_TRANSCRIPT_PAGE_TURNS
  ) {
    throw new TypeError("Transcript page request is invalid.");
  }
}

function backwardPage(
  turns: readonly IndexedTranscriptTurn[],
  cursor: DecodedTranscriptCursor,
  limit: number,
  encode: (cursor: DecodedTranscriptCursor) => string,
): TranscriptPageResult {
  const beforeIsValid =
    cursor.before === cursor.snapshotEnd || turns.some((turn) => turn.start === cursor.before);
  if (!beforeIsValid) throw new TypeError("Transcript page cursor is invalid.");
  let index = turns.length - 1;
  while (index >= 0 && turns[index]!.end > cursor.before) index -= 1;
  let selected: readonly IndexedTranscriptTurn[] = [];
  let selectedUnits = 0;
  while (index >= 0 && selectedUnits < limit) {
    const unitKey = transcriptUnitKey(turns[index]!.record);
    let unitStart = index;
    while (unitStart > 0 && transcriptUnitKey(turns[unitStart - 1]!.record) === unitKey) {
      unitStart -= 1;
    }
    const tentative = [...turns.slice(unitStart, index + 1), ...selected];
    const hasMore = unitStart > 0;
    const nextCursor = hasMore ? encode({ ...cursor, before: tentative[0]!.start }) : null;
    const tentativeResult = pageResult(tentative, nextCursor);
    if (encodedPageBytes(tentativeResult) > MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES) {
      if (selected.length === 0) {
        throw new Error("Transcript page record exceeds the response budget.");
      }
      break;
    }
    selected = tentative;
    selectedUnits += 1;
    index = unitStart - 1;
  }
  const nextCursor = index >= 0 ? encode({ ...cursor, before: selected[0]!.start }) : null;
  const result = pageResult(selected, nextCursor);
  if (encodedPageBytes(result) > MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES) {
    throw new Error("Transcript page exceeds the response budget.");
  }
  return result;
}

export class TranscriptStore implements TranscriptWriterPort {
  private readonly transcriptsDir: string;
  private readonly directoryIdentity: FileIdentity;
  private readonly hooks: TranscriptStoreHooks;
  private readonly platform: NodeJS.Platform;
  private readonly windowsDirectoryBinding: WindowsPrivateDirectoryBinding | undefined;

  constructor(dataDir: string, hooks: TranscriptStoreHooks = {}) {
    this.transcriptsDir = join(dataDir, "transcripts");
    this.hooks = hooks;
    this.platform = hooks.platform ?? process.platform;
    let created = false;
    try {
      mkdirSync(this.transcriptsDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isExists(error)) {
        throw this.platform === "win32"
          ? classifyWindowsPrivatePathFailure("entry-check", error)
          : error;
      }
    }

    if (this.platform === "win32") {
      const binding = bindWindowsPrivateDirectory(dataDir, this.transcriptsDir);
      this.windowsDirectoryBinding = binding;
      this.directoryIdentity = binding.identity;
      if (created) this.syncParentDirectory(dataDir);
    } else {
      this.windowsDirectoryBinding = undefined;
      const beforeOpen = lstatSync(this.transcriptsDir);
      if (beforeOpen.isSymbolicLink() || !beforeOpen.isDirectory()) {
        throw new UnsafeTranscriptTargetError();
      }
      const descriptor = openSync(
        this.transcriptsDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
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
        const afterOpen = lstatSync(this.transcriptsDir);
        if (
          !hardened ||
          !isStrictPrivateDirectory(opened) ||
          !isStrictPrivateDirectory(afterOpen) ||
          !sameIdentity(identity(beforeOpen), identity(opened)) ||
          !sameIdentity(identity(opened), identity(afterOpen))
        ) {
          throw new UnsafeTranscriptTargetError();
        }
        this.directoryIdentity = identity(opened);
        if (created) this.syncParentDirectory(dataDir);
      } finally {
        closeSync(descriptor);
      }
    }
  }

  private unsafeTarget(message?: string): Error {
    return this.platform === "win32"
      ? new WindowsPrivatePathPolicyError("read-check", "corruption")
      : message === undefined
        ? new UnsafeTranscriptTargetError()
        : new Error(message);
  }

  private isPrivateFile(metadata: Stats, allowedLinks: 1 | 2 = 1): boolean {
    if (this.platform === "win32") {
      assertWindowsPrivateFileMetadata(metadata, allowedLinks);
      return true;
    }
    return isStrictPrivateFile(metadata, allowedLinks);
  }

  private selectArchivedSegment(
    segments: readonly ArchivedTranscriptSegment[],
    boundaryRef: string,
  ): ArchivedTranscriptSegment | null {
    try {
      return selectArchivedSegment(segments, boundaryRef);
    } catch (error) {
      if (this.platform === "win32") {
        throw this.unsafeTarget("Transcript contains duplicate reset boundaries.");
      }
      throw error;
    }
  }

  appendCompletedTurn(input: TranscriptCompletedTurnInput): void {
    const bytes = serializeTranscriptRecord(completedTurnRecord(input));
    this.appendRecord(input.chatId, bytes);
  }

  appendInterruptedTurn(input: TranscriptInterruptedTurnInput): void {
    const bytes = serializeTranscriptRecord(interruptedTurnRecord(input));
    this.appendRecord(input.chatId, bytes);
  }

  appendDecisionRequested(input: TranscriptDecisionRequestedInput): CoachDecisionReadModel {
    const parsed = CoachDecisionReadModelSchema.parse(input.decision);
    if (
      parsed.status !== "unanswered" ||
      input.turnId.length === 0 ||
      input.toolCallId.length === 0 ||
      typeof input.athleteText !== "string" ||
      !isIsoTimestamp(input.requestedAt)
    ) {
      throw new TypeError("Decision request is invalid.");
    }
    const matchingToolCall = this.readCurrentRecords(parsed.chatId).find(
      (record) => record.kind === "decision-requested" && record.toolCallId === input.toolCallId,
    );
    if (matchingToolCall?.kind === "decision-requested") {
      const existing = this.getDecision(parsed.chatId, matchingToolCall.decisionId);
      const matchingOptions = matchingToolCall.options.map(({ id: _id, ...option }) => option);
      const requestedOptions = parsed.options.map(({ id: _id, ...option }) => option);
      const sameRequest =
        matchingToolCall.athleteText === input.athleteText &&
        (matchingToolCall.turnId === undefined || matchingToolCall.turnId === input.turnId) &&
        matchingToolCall.question === parsed.question &&
        JSON.stringify(matchingOptions) === JSON.stringify(requestedOptions) &&
        JSON.stringify(matchingToolCall.planIntakePatch) === JSON.stringify(input.planIntakePatch);
      if (sameRequest && existing !== null) return existing;
      throw new Error("Tool call identifier already belongs to another decision request.");
    }
    const current = this.getDecision(parsed.chatId, parsed.decisionId);
    if (current !== null) throw new Error("Decision identifier already exists.");
    const active = this.getDecision(parsed.chatId);
    if (
      active?.status === "unanswered" ||
      (active?.status === "answered" && active.continuation.status === "pending")
    ) {
      throw new Error("A decision is already active.");
    }
    const record: TranscriptDecisionRequestedRecord = {
      version: TRANSCRIPT_SCHEMA_VERSION,
      kind: "decision-requested",
      chatId: parsed.chatId,
      turnId: input.turnId,
      decisionId: parsed.decisionId,
      toolCallId: input.toolCallId,
      messageId: parsed.messageId,
      athleteText: input.athleteText,
      question: parsed.question,
      options: parsed.options,
      requestedAt: input.requestedAt,
      ...(input.planIntakePatch === undefined ? {} : { planIntakePatch: input.planIntakePatch }),
    };
    this.appendRecord(parsed.chatId, serializeTranscriptRecord(record));
    return parsed;
  }

  answerDecision(input: TranscriptDecisionAnsweredInput): CoachDecisionReadModel {
    if (
      !isIsoTimestamp(input.answeredAt) ||
      input.continuationId.length === 0 ||
      input.consequence.length === 0 ||
      input.consequence.length > 2_000 ||
      !CoachDecisionAnswerSchema.safeParse(input.answer).success
    )
      throw new TypeError("Decision answer is invalid.");
    const current = this.getDecision(input.chatId, input.decisionId);
    if (current === null) throw new Error("Decision was not found.");
    if (current.status === "answered") {
      if (
        JSON.stringify(current.answer) === JSON.stringify(input.answer) &&
        current.consequence === input.consequence &&
        current.continuation.continuationId === input.continuationId
      )
        return current;
      throw new Error("Decision is immutable after it is answered.");
    }
    if (current.status !== "unanswered") throw new Error("Decision is already terminal.");
    if (input.answer.kind === "option") {
      const optionId = input.answer.optionId;
      if (!current.options.some((option) => option.id === optionId)) {
        throw new TypeError("Decision answer references an unknown option.");
      }
    }
    const record: TranscriptDecisionAnsweredRecord = {
      version: TRANSCRIPT_SCHEMA_VERSION,
      kind: "decision-answered",
      chatId: input.chatId,
      decisionId: input.decisionId,
      answer: input.answer,
      consequence: input.consequence,
      continuationId: input.continuationId,
      answeredAt: input.answeredAt,
    };
    this.appendRecord(input.chatId, serializeTranscriptRecord(record));
    return this.getDecision(input.chatId, input.decisionId)!;
  }

  skipDecision(input: TranscriptDecisionSkippedInput): CoachDecisionReadModel {
    if (!isIsoTimestamp(input.skippedAt)) throw new TypeError("Decision skip is invalid.");
    const current = this.getDecision(input.chatId, input.decisionId);
    if (current === null) throw new Error("Decision was not found.");
    if (current.status === "skipped") return current;
    if (current.status !== "unanswered") throw new Error("Decision is already terminal.");
    const record: TranscriptDecisionSkippedRecord = {
      version: TRANSCRIPT_SCHEMA_VERSION,
      kind: "decision-skipped",
      chatId: input.chatId,
      decisionId: input.decisionId,
      skippedAt: input.skippedAt,
    };
    this.appendRecord(input.chatId, serializeTranscriptRecord(record));
    return this.getDecision(input.chatId, input.decisionId)!;
  }

  completeDecisionContinuation(
    input: TranscriptDecisionContinuationCompletedInput,
  ): CoachDecisionReadModel {
    if (
      !isIsoTimestamp(input.completedAt) ||
      input.continuationId.length === 0 ||
      input.turnId.length === 0 ||
      typeof input.coachText !== "string" ||
      input.coachText.length === 0 ||
      !isDecisionContinuationLineage(input.lineage)
    ) {
      throw new TypeError("Decision continuation completion is invalid.");
    }
    const current = this.getDecision(input.chatId, input.decisionId);
    if (current === null) throw new Error("Decision was not found.");
    if (current.status !== "answered") throw new Error("Decision has no continuation.");
    if (current.continuation.continuationId !== input.continuationId) {
      throw new Error("Decision continuation identifier does not match.");
    }
    if (current.continuation.status === "completed") {
      if (
        current.continuation.turnId === input.turnId &&
        current.continuation.coachText === input.coachText &&
        JSON.stringify(current.continuation.lineage) === JSON.stringify(input.lineage)
      ) {
        return current;
      }
      throw new Error("Decision continuation is immutable after it is completed.");
    }
    const record: TranscriptDecisionContinuationCompletedRecord = {
      version: TRANSCRIPT_SCHEMA_VERSION,
      kind: "decision-continuation-completed",
      chatId: input.chatId,
      decisionId: input.decisionId,
      continuationId: input.continuationId,
      turnId: input.turnId,
      coachText: input.coachText,
      lineage: input.lineage,
      completedAt: input.completedAt,
    };
    this.appendRecord(input.chatId, serializeTranscriptRecord(record));
    return this.getDecision(input.chatId, input.decisionId)!;
  }

  abandonUnansweredDecisions(chatId: string, abandonedAt: string): CoachDecisionReadModel[] {
    if (!isIsoTimestamp(abandonedAt)) throw new TypeError("Decision abandonment is invalid.");
    const unanswered = [...decisionReadModels(this.readCurrentRecords(chatId)).values()].filter(
      (decision) => decision.status === "unanswered",
    );
    for (const decision of unanswered) {
      const record: TranscriptDecisionAbandonedRecord = {
        version: TRANSCRIPT_SCHEMA_VERSION,
        kind: "decision-abandoned",
        chatId,
        decisionId: decision.decisionId,
        reason: "new_conversation",
        abandonedAt,
      };
      this.appendRecord(chatId, serializeTranscriptRecord(record));
    }
    return unanswered.map((decision) => this.getDecision(chatId, decision.decisionId)!);
  }

  getDecision(chatId: string, decisionId?: string): CoachDecisionReadModel | null {
    const decisions = decisionReadModels(this.readCurrentRecords(chatId));
    if (decisionId !== undefined) return decisions.get(decisionId) ?? null;
    const values = [...decisions.values()];
    return values.at(-1) ?? null;
  }

  getDecisionAthleteText(chatId: string, decisionId: string): string | null {
    const request = this.readCurrentRecords(chatId).find(
      (record) => record.kind === "decision-requested" && record.decisionId === decisionId,
    );
    return request?.kind === "decision-requested" ? request.athleteText : null;
  }

  getDecisionPlanIntakePatch(chatId: string, decisionId: string): PlanIntakePatch | null {
    const request = this.readCurrentRecords(chatId).find(
      (record) => record.kind === "decision-requested" && record.decisionId === decisionId,
    );
    return request?.kind === "decision-requested" ? (request.planIntakePatch ?? null) : null;
  }

  getTerminalTurnIds(chatId: string): ReadonlySet<string> {
    return new Set(
      this.readCurrentRecords(chatId).flatMap<string>((record) => {
        if (record.kind === "turn-completed") return [record.turnId];
        if (record.kind === "decision-requested" && record.turnId !== undefined) {
          return [record.turnId];
        }
        return [];
      }),
    );
  }

  private readCurrentRecords(
    chatId: string,
  ): Exclude<TranscriptRecord, TranscriptConversationBoundaryRecord>[] {
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) return [];
      try {
        const contents = this.readSnapshot(directoryDescriptor, descriptor, path);
        if (this.platform === "win32") this.assertWindowsTranscriptContent(contents, chatId);
        const window = parseCurrentWindow(contents, chatId);
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return window.trusted ? window.turns.map(({ record }) => record) : [];
      } finally {
        closeSync(descriptor);
      }
    });
  }

  readCurrentConversation(chatId: string): TranscriptTurnRecord[] {
    return this.readCurrentRecords(chatId).filter(
      (record): record is TranscriptTurnRecord =>
        record.kind === "turn-completed" || record.kind === "turn-interrupted",
    );
  }

  readCurrentConversationPage(
    chatId: string,
    request: TranscriptPageRequest,
  ): TranscriptPageResult {
    if (typeof chatId !== "string") throw new TypeError("Transcript page request is invalid.");
    assertValidPageRequest(request, decodeTranscriptCursor);
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) {
        return request.cursor === null ? pageResult([], null) : restartRequiredPage();
      }
      try {
        const contents = this.readSnapshot(directoryDescriptor, descriptor, path);
        if (this.platform === "win32") this.assertWindowsTranscriptContent(contents, chatId);
        const current = parseCurrentWindow(contents, chatId);
        const chatDigest = Buffer.from(this.chatDigest(chatId), "hex");
        let snapshot = contents;
        let snapshotWindow = current;
        let cursor: DecodedTranscriptCursor;
        if (request.cursor === null) {
          if (!current.trusted) {
            this.assertOpenedFileSafe(descriptor);
            this.assertDirectoryStable(directoryDescriptor);
            return pageResult([], null);
          }
          cursor = {
            fenceKind: current.fenceKind,
            chatDigest,
            fence: current.fence,
            snapshotHash: createHash("sha256").update(contents).digest(),
            snapshotEnd: contents.length,
            before: contents.length,
          };
        } else {
          const decoded = decodeTranscriptCursor(request.cursor);
          if (decoded === null || !decoded.chatDigest.equals(chatDigest)) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          if (
            !current.trusted ||
            current.fenceKind !== decoded.fenceKind ||
            !current.fence.equals(decoded.fence)
          ) {
            this.assertOpenedFileSafe(descriptor);
            this.assertDirectoryStable(directoryDescriptor);
            return restartRequiredPage();
          }
          if (decoded.snapshotEnd > contents.length) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          snapshot = contents.subarray(0, decoded.snapshotEnd);
          if (!createHash("sha256").update(snapshot).digest().equals(decoded.snapshotHash)) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          snapshotWindow = parseCurrentWindow(snapshot, chatId);
          if (
            !snapshotWindow.trusted ||
            snapshotWindow.fenceKind !== decoded.fenceKind ||
            !snapshotWindow.fence.equals(decoded.fence)
          ) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          cursor = decoded;
        }
        const result = backwardPage(
          snapshotWindow.turns,
          cursor,
          request.limit,
          encodeTranscriptCursor,
        );
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return result;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  listArchivedConversations(chatId: string): ArchivedConversationList {
    if (typeof chatId !== "string") {
      throw new TypeError("Archived conversation request is invalid.");
    }
    return this.withDirectory((directoryDescriptor): ArchivedConversationList => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) {
        return { schemaVersion: 1, conversations: [], truncated: false };
      }
      try {
        const contents = this.readSnapshot(directoryDescriptor, descriptor, path);
        if (this.platform === "win32") this.assertWindowsTranscriptContent(contents, chatId);
        const segments = parseArchivedSegments(contents, chatId);
        const refs = new Set(segments.map((segment) => segment.boundary.resetId));
        if (refs.size !== segments.length) {
          throw this.unsafeTarget("Transcript contains duplicate reset boundaries.");
        }
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        const newestFirst = [...segments].reverse();
        const selected = newestFirst.slice(0, MAX_ARCHIVED_CONVERSATION_ENTRIES);
        return {
          schemaVersion: 1,
          conversations: selected.map((segment) => ({
            boundaryRef: segment.boundary.resetId,
            boundaryAt: segment.boundary.boundaryAt,
            reason: segment.boundary.reason,
            turnCount: new Set(
              segment.turns.flatMap(({ record }) => {
                if (record.kind === "turn-completed" || record.kind === "turn-interrupted") {
                  return [`turn:${record.turnId}`];
                }
                if (record.kind !== "decision-requested") return [];
                return [
                  record.turnId === undefined
                    ? `decision:${record.decisionId}`
                    : `turn:${record.turnId}`,
                ];
              }),
            ).size,
          })),
          truncated: newestFirst.length > selected.length,
        };
      } finally {
        closeSync(descriptor);
      }
    });
  }

  readArchivedConversationPage(
    chatId: string,
    boundaryRef: string,
    request: TranscriptPageRequest,
  ): TranscriptPageResult {
    if (
      typeof chatId !== "string" ||
      typeof boundaryRef !== "string" ||
      !RESET_ID_PATTERN.test(boundaryRef)
    ) {
      throw new TypeError("Archived transcript page request is invalid.");
    }
    assertValidPageRequest(request, decodeArchivedTranscriptCursor);
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) return restartRequiredPage();
      try {
        const contents = this.readSnapshot(directoryDescriptor, descriptor, path);
        if (this.platform === "win32") this.assertWindowsTranscriptContent(contents, chatId);
        const chatDigest = Buffer.from(this.chatDigest(chatId), "hex");
        const fence = Buffer.from(boundaryRef, "hex");
        let result: TranscriptPageResult;
        if (request.cursor === null) {
          const target = this.selectArchivedSegment(
            parseArchivedSegments(contents, chatId),
            boundaryRef,
          );
          if (target === null) {
            this.assertOpenedFileSafe(descriptor);
            this.assertDirectoryStable(directoryDescriptor);
            return restartRequiredPage();
          }
          result = backwardPage(
            target.turns,
            {
              fenceKind: 1,
              chatDigest,
              fence,
              snapshotHash: createHash("sha256")
                .update(contents.subarray(0, target.boundaryEnd))
                .digest(),
              snapshotEnd: target.boundaryEnd,
              before: target.boundaryEnd,
            },
            request.limit,
            encodeArchivedTranscriptCursor,
          );
        } else {
          const decoded = decodeArchivedTranscriptCursor(request.cursor);
          if (
            decoded === null ||
            !decoded.chatDigest.equals(chatDigest) ||
            !decoded.fence.equals(fence) ||
            decoded.snapshotEnd > contents.length
          ) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          const snapshot = contents.subarray(0, decoded.snapshotEnd);
          if (!createHash("sha256").update(snapshot).digest().equals(decoded.snapshotHash)) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          const target = this.selectArchivedSegment(
            parseArchivedSegments(snapshot, chatId),
            boundaryRef,
          );
          if (target === null || target.boundaryEnd !== decoded.snapshotEnd) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          result = backwardPage(
            target.turns,
            decoded,
            request.limit,
            encodeArchivedTranscriptCursor,
          );
        }
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return result;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  inspectArchivedConversation(
    chatId: string,
    boundaryRef: string,
  ): ArchivedConversationDeletionManifest | null {
    if (
      typeof chatId !== "string" ||
      typeof boundaryRef !== "string" ||
      !RESET_ID_PATTERN.test(boundaryRef)
    ) {
      throw new TypeError("Archived conversation inspection request is invalid.");
    }
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) return null;
      try {
        const contents = this.readSnapshot(directoryDescriptor, descriptor, path);
        if (this.platform === "win32") this.assertWindowsTranscriptContent(contents, chatId);
        const segments = parseArchivedSegments(contents, chatId);
        if (new Set(segments.map(({ boundary }) => boundary.resetId)).size !== segments.length) {
          throw this.unsafeTarget("Transcript contains duplicate reset boundaries.");
        }
        const target = this.selectArchivedSegment(segments, boundaryRef);
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return target === null ? null : archivedConversationManifest(contents, target);
      } finally {
        closeSync(descriptor);
      }
    });
  }

  finalizeArchivedConversationDeletion(
    chatId: string,
    manifest: ArchivedConversationDeletionManifest,
  ): boolean {
    if (typeof chatId !== "string" || !isArchivedConversationDeletionManifest(manifest)) {
      throw new TypeError("Archived conversation deletion request is invalid.");
    }
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const tempPath = this.deletionTempPath(chatId, manifest.boundaryRef);
      this.unlinkPrivateFileIfPresent(directoryDescriptor, tempPath, 1);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) return false;
      let tempDescriptor: number | null = null;
      let renamed = false;
      try {
        const beforeSnapshot = fstatSync(descriptor);
        const contents = this.readSnapshot(directoryDescriptor, descriptor, path);
        if (this.platform === "win32") this.assertWindowsTranscriptContent(contents, chatId);
        const source = fstatSync(descriptor);
        if (
          !sameIdentity(identity(beforeSnapshot), identity(source)) ||
          beforeSnapshot.size !== source.size ||
          beforeSnapshot.mtimeMs !== source.mtimeMs ||
          beforeSnapshot.ctimeMs !== source.ctimeMs ||
          source.size !== contents.length
        ) {
          throw new ArchivedConversationDeletionConflictError();
        }
        const segments = parseArchivedSegments(contents, chatId);
        if (new Set(segments.map(({ boundary }) => boundary.resetId)).size !== segments.length) {
          throw this.unsafeTarget("Transcript contains duplicate reset boundaries.");
        }
        const target = this.selectArchivedSegment(segments, manifest.boundaryRef);
        if (target === null) {
          this.assertOpenedFileSafe(descriptor);
          this.assertDirectoryStable(directoryDescriptor);
          return false;
        }
        const current = archivedConversationManifest(contents, target);
        if (!sameArchivedConversationDeletionManifest(current, manifest)) {
          throw new ArchivedConversationDeletionConflictError();
        }
        const replacement = Buffer.concat([
          contents.subarray(0, target.start),
          contents.subarray(target.boundaryEnd),
        ]);
        if (this.platform === "win32") this.assertWindowsTranscriptSize(replacement.length);
        tempDescriptor = this.openNewFile(directoryDescriptor, tempPath, 0, false);
        this.writeComplete(tempDescriptor, replacement);
        this.syncFile(tempDescriptor);
        if (fstatSync(tempDescriptor).size !== replacement.length) {
          throw this.unsafeTarget("Transcript replacement was incomplete.");
        }
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
        const sourceCurrent = fstatSync(descriptor);
        if (
          !sameIdentity(identity(source), identity(sourceCurrent)) ||
          source.size !== sourceCurrent.size ||
          source.mtimeMs !== sourceCurrent.mtimeMs ||
          source.ctimeMs !== sourceCurrent.ctimeMs
        ) {
          throw new ArchivedConversationDeletionConflictError();
        }
        try {
          (this.hooks.rename ?? renameSync)(tempPath, path);
        } catch (error) {
          throw this.platform === "win32"
            ? classifyWindowsPrivatePathFailure("rename", error)
            : error;
        }
        renamed = true;
        this.assertOpenedPathSafe(directoryDescriptor, tempDescriptor, path);
        this.syncDirectory(directoryDescriptor);
        this.assertOpenedPathSafe(directoryDescriptor, tempDescriptor, path);
        return true;
      } catch (error) {
        if (!renamed) {
          try {
            this.unlinkPrivateFileIfPresent(directoryDescriptor, tempPath, 1);
          } catch {}
        }
        throw this.platform === "win32"
          ? classifyWindowsPrivatePathFailure("content-write", error)
          : error;
      } finally {
        if (tempDescriptor !== null) closeSync(tempDescriptor);
        closeSync(descriptor);
      }
    }, "content-write");
  }

  createResetIntent(input: ResetIntentRecord): void {
    const intent = resetIntentRecord(input);
    this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor, this.chatDigest(intent.chatId));
      const targetPath = this.intentPath(intent.chatId);
      const tempPath = this.intentTempPath(intent.chatId, intent.resetId);
      this.assertPathMissing(targetPath);
      this.assertPathMissing(tempPath);

      let tempDescriptor: number | null = null;
      let linked = false;
      try {
        tempDescriptor = this.openNewFile(directoryDescriptor, tempPath, 0, false);
        const bytes = Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
        this.writeComplete(tempDescriptor, bytes);
        this.syncFile(tempDescriptor);
        if (this.platform === "win32") {
          this.assertOpenedPathSafe(directoryDescriptor, tempDescriptor, tempPath);
        } else {
          closeSync(tempDescriptor);
          tempDescriptor = null;
        }

        this.assertPathMissing(targetPath);
        try {
          linkSync(tempPath, targetPath);
        } catch (error) {
          if (isExists(error)) throw this.unsafeTarget();
          throw this.platform === "win32"
            ? classifyWindowsPrivatePathFailure("rename", error)
            : error;
        }
        linked = true;
        if (this.platform === "win32") {
          this.assertOpenedPathSafe(directoryDescriptor, tempDescriptor!, tempPath, 2);
          const target = lstatSync(targetPath);
          const opened = fstatSync(tempDescriptor!);
          if (!this.isPrivateFile(target, 2) || !sameIdentity(identity(target), identity(opened))) {
            throw this.unsafeTarget();
          }
          assertWindowsPrivateFileBinding(
            this.windowsDirectoryBinding!,
            targetPath,
            windowsPrivatePathIdentity(opened),
            2,
          );
        }
        this.syncDirectory(directoryDescriptor);
        this.unlinkMatchingTemp(directoryDescriptor, tempPath, targetPath);
        this.assertIntentTarget(directoryDescriptor, targetPath, intent);
        if (tempDescriptor !== null) {
          const descriptor = tempDescriptor;
          tempDescriptor = null;
          closeSync(descriptor);
        }
      } catch (error) {
        if (this.platform === "win32") {
          if (tempDescriptor !== null) {
            try {
              closeSync(tempDescriptor);
            } catch {}
          }
          throw classifyWindowsPrivatePathFailure("content-write", error);
        }
        if (tempDescriptor !== null) closeSync(tempDescriptor);
        try {
          if (linked) this.unlinkMatchingTemp(directoryDescriptor, tempPath, targetPath);
          else this.unlinkPrivateFileIfPresent(directoryDescriptor, tempPath, 1);
        } catch {}
        throw error;
      }
    }, "content-write");
  }

  readResetIntent(chatId: string): ResetIntentRecord | null {
    return this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor, this.chatDigest(chatId));
      return this.readIntentPath(directoryDescriptor, this.intentPath(chatId), chatId);
    });
  }

  listResetIntents(): ResetIntentRecord[] {
    return this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor);
      const names = readdirSync(this.transcriptsDir);
      this.assertDirectoryStable(directoryDescriptor);
      const intents: ResetIntentRecord[] = [];
      for (const name of names) {
        if (name.endsWith(".reset-intent.json") && !INTENT_TARGET_PATTERN.test(name)) {
          throw this.unsafeTarget();
        }
        const match = INTENT_TARGET_PATTERN.exec(name);
        if (match === null) continue;
        const path = join(this.transcriptsDir, name);
        const intent = this.readIntentPath(directoryDescriptor, path);
        if (intent === null || this.chatDigest(intent.chatId) !== match[1]) {
          throw this.unsafeTarget();
        }
        intents.push(intent);
      }
      return intents;
    });
  }

  removeResetIntent(expected: ResetIntentRecord): void {
    const intent = resetIntentRecord(expected);
    this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor, this.chatDigest(intent.chatId));
      const path = this.intentPath(intent.chatId);
      const descriptor = this.openExistingFile(
        directoryDescriptor,
        path,
        constants.O_RDONLY,
        false,
      );
      if (descriptor === null) return;
      try {
        const actual = parseResetIntent(this.readOpenedFile(directoryDescriptor, descriptor, path));
        if (actual === null || JSON.stringify(actual) !== JSON.stringify(intent)) {
          throw this.unsafeTarget();
        }
        const pathStats = lstatSync(path);
        const openedStats = fstatSync(descriptor);
        if (!sameIdentity(identity(pathStats), identity(openedStats))) {
          throw this.unsafeTarget();
        }
        this.assertDirectoryStable(directoryDescriptor);
        this.unlinkPath(path);
        this.syncDirectory(directoryDescriptor);
      } finally {
        closeSync(descriptor);
      }
    }, "rename");
  }

  hasConversationBoundary(chatId: string, resetId: string): boolean {
    if (!RESET_ID_PATTERN.test(resetId)) throw new TypeError("Reset identifier is invalid.");
    return this.boundaryCount(chatId, resetId) > 0;
  }

  ensureConversationBoundary(input: ResetIntentRecord): void {
    const intent = resetIntentRecord(input);
    const bytes = serializeTranscriptRecord(conversationBoundaryRecord(intent));
    const before = this.boundaryCount(intent.chatId, intent.resetId, intent);
    if (before > 1) {
      throw this.unsafeTarget("Transcript contains duplicate reset boundaries.");
    }
    if (before === 1) {
      this.syncTranscriptFileAndDirectory(intent.chatId);
      return;
    }
    this.appendRecord(intent.chatId, bytes, true, intent);
    if (this.boundaryCount(intent.chatId, intent.resetId) !== 1) {
      throw this.unsafeTarget("Conversation boundary was not durably persisted exactly once.");
    }
  }

  private boundaryCount(
    chatId: string,
    resetId: string,
    recoveryIntent?: ResetIntentRecord,
  ): number {
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) return 0;
      try {
        const contents = this.readOpenedFile(directoryDescriptor, descriptor, path);
        if (this.platform === "win32") {
          const recovery =
            recoveryIntent === undefined
              ? undefined
              : this.authorizeBoundaryRecovery(directoryDescriptor, contents, recoveryIntent);
          this.assertWindowsTranscriptContent(contents, chatId, recovery);
        }
        let count = 0;
        let lineStart = 0;
        for (let index = 0; index < contents.length; index += 1) {
          if (contents[index] !== 0x0a) continue;
          const bytes = contents.subarray(lineStart, index);
          lineStart = index + 1;
          const record = bytes.length === 0 ? null : parseRecordBytes(bytes);
          if (
            record?.kind === "conversation-boundary" &&
            record.chatId === chatId &&
            record.resetId === resetId
          ) {
            count += 1;
          }
        }
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return count;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  private appendRecord(
    chatId: string,
    recordBytes: Buffer,
    classifyUnchangedBoundaryFailure = false,
    recoveryIntent?: ResetIntentRecord,
  ): void {
    this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const { descriptor, created } = this.openForAppend(directoryDescriptor, path);
      const beforeAppend = fstatSync(descriptor);
      try {
        let recovery: TranscriptBoundaryRecovery | undefined;
        if (this.platform === "win32") {
          const existing = this.readSnapshot(directoryDescriptor, descriptor, path);
          recovery =
            recoveryIntent === undefined
              ? undefined
              : this.authorizeBoundaryRecovery(directoryDescriptor, existing, recoveryIntent);
          this.assertWindowsTranscriptContent(existing, chatId, recovery);
        }
        let prefix = "";
        if (beforeAppend.size > 0 && recovery === undefined) {
          const tail = Buffer.allocUnsafe(1);
          const bytesRead = readSync(descriptor, tail, 0, 1, beforeAppend.size - 1);
          if (bytesRead !== 1) throw new Error("Transcript tail could not be read.");
          if (tail[0] !== 0x0a) prefix = "\n";
        }
        const bytes =
          recovery !== undefined
            ? recordBytes.subarray(recovery.tailLength)
            : prefix === ""
              ? recordBytes
              : Buffer.concat([Buffer.from(prefix), recordBytes]);
        if (this.platform === "win32") {
          this.assertWindowsTranscriptSize(beforeAppend.size + bytes.length);
        }
        this.writeComplete(descriptor, bytes);
        this.syncFile(descriptor);
        if (this.platform === "win32") {
          const afterAppend = fstatSync(descriptor);
          if (afterAppend.size !== beforeAppend.size + bytes.length) {
            throw new WindowsPrivatePathPolicyError("content-write", "corruption");
          }
        }
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
        this.syncDirectory(directoryDescriptor);
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
      } catch (error) {
        if (
          classifyUnchangedBoundaryFailure &&
          !created &&
          error instanceof IncompleteTranscriptWriteError &&
          error.bytesWritten === 0 &&
          this.openedPathIsUnchanged(directoryDescriptor, descriptor, path, beforeAppend)
        ) {
          throw new TranscriptBoundaryTargetUnchangedError(
            this.platform === "win32"
              ? classifyWindowsPrivatePathFailure("content-write", error)
              : error,
          );
        }
        throw this.platform === "win32"
          ? classifyWindowsPrivatePathFailure("content-write", error)
          : error;
      } finally {
        closeSync(descriptor);
      }
    }, "content-write");
  }

  private syncTranscriptFileAndDirectory(chatId: string): void {
    this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(
        directoryDescriptor,
        path,
        this.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY,
        false,
      );
      if (descriptor === null) throw this.unsafeTarget();
      try {
        this.syncFile(descriptor);
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
        this.syncDirectory(directoryDescriptor);
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
      } finally {
        closeSync(descriptor);
      }
    }, "file-flush");
  }

  private readSnapshot(
    directoryDescriptor: DirectoryDescriptor,
    descriptor: number,
    path: string,
    allowedLinks: 1 | 2 = 1,
  ): Buffer {
    const beforeRead = fstatSync(descriptor);
    const size = beforeRead.size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (this.platform === "win32" && size > MAX_TRANSCRIPT_FILE_BYTES)
    ) {
      if (this.platform === "win32") {
        assertWindowsPrivatePathRead({
          bounded: false,
          identityStable: true,
          contentValid: true,
          authenticatedHomeBinding: true,
        });
      }
      throw this.unsafeTarget();
    }
    const contents = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(descriptor, contents, offset, size - offset, offset);
      if (bytesRead <= 0) {
        if (this.platform === "win32") {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        throw new Error("Transcript snapshot could not be read.");
      }
      offset += bytesRead;
    }
    if (this.platform === "win32") {
      const afterRead = fstatSync(descriptor);
      assertWindowsPrivateFileMetadata(beforeRead, allowedLinks);
      assertWindowsPrivateFileMetadata(afterRead, allowedLinks);
      const current = assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        path,
        windowsPrivatePathIdentity(afterRead),
        allowedLinks,
      );
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
        contentValid: offset === size,
        authenticatedHomeBinding: true,
      });
      this.assertDirectoryStable(directoryDescriptor);
    }
    return contents;
  }

  private assertWindowsTranscriptSize(size: number): void {
    assertWindowsPrivatePathRead({
      bounded: Number.isSafeInteger(size) && size >= 0 && size <= MAX_TRANSCRIPT_FILE_BYTES,
      identityStable: true,
      contentValid: true,
      authenticatedHomeBinding: true,
    });
  }

  private assertWindowsTranscriptContent(
    contents: Buffer,
    chatId: string,
    recovery?: TranscriptBoundaryRecovery,
  ): void {
    let contentValid = true;
    let lineStart = 0;
    const resetIds = new Set<string>();
    for (let index = 0; index < contents.length; index += 1) {
      if (contents[index] !== 0x0a) continue;
      const line = contents.subarray(lineStart, index);
      lineStart = index + 1;
      const record = line.length === 0 ? null : parseRecordBytes(line);
      if (record === null || record.chatId !== chatId) {
        contentValid = false;
        break;
      }
      if (record.kind === "conversation-boundary") {
        if (resetIds.has(record.resetId)) {
          contentValid = false;
          break;
        }
        resetIds.add(record.resetId);
      }
      contentValid = true;
    }
    if (contentValid && lineStart !== contents.length) {
      const tail = contents.subarray(lineStart);
      contentValid =
        recovery !== undefined &&
        !resetIds.has(recovery.resetId) &&
        isCanonicalBoundaryPrefix(tail, recovery.line);
    }
    assertWindowsPrivatePathRead({
      bounded: contents.length <= MAX_TRANSCRIPT_FILE_BYTES,
      identityStable: true,
      contentValid,
      authenticatedHomeBinding: true,
    });
  }

  private authorizeBoundaryRecovery(
    directoryDescriptor: DirectoryDescriptor,
    contents: Buffer,
    intent: ResetIntentRecord,
  ): TranscriptBoundaryRecovery | undefined {
    const line = canonicalBoundaryLine(conversationBoundaryRecord(intent));
    const lastNewline = contents.lastIndexOf(0x0a);
    const tail = contents.subarray(lastNewline + 1);
    if (!isCanonicalBoundaryPrefix(tail, line)) return undefined;
    const persisted = this.readIntentPath(
      directoryDescriptor,
      this.intentPath(intent.chatId),
      intent.chatId,
    );
    if (persisted === null || !sameResetIntent(persisted, intent)) return undefined;
    return { line, resetId: intent.resetId, tailLength: tail.length };
  }

  private readOpenedFile(
    directoryDescriptor: DirectoryDescriptor,
    descriptor: number,
    path: string,
    allowedLinks: 1 | 2 = 1,
  ): Buffer {
    return this.platform === "win32"
      ? this.readSnapshot(directoryDescriptor, descriptor, path, allowedLinks)
      : readFileSync(descriptor);
  }

  private openForAppend(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
  ): { readonly descriptor: number; readonly created: boolean } {
    const existing = this.openExistingFile(
      directoryDescriptor,
      path,
      constants.O_RDWR | constants.O_APPEND,
      true,
    );
    if (existing !== null) return { descriptor: existing, created: false };
    try {
      return {
        descriptor: this.openNewFile(directoryDescriptor, path, constants.O_APPEND, false),
        created: true,
      };
    } catch (error) {
      if (!isExists(error)) throw error;
      const raced = this.openExistingFile(
        directoryDescriptor,
        path,
        constants.O_RDWR | constants.O_APPEND,
        false,
      );
      if (raced === null) throw this.unsafeTarget();
      return { descriptor: raced, created: false };
    }
  }

  private openExistingFile(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    flags: number,
    missingAllowed: boolean,
    allowedLinks: 1 | 2 = 1,
  ): number | null {
    let beforeOpen: Stats;
    try {
      beforeOpen = lstatSync(path);
    } catch (error) {
      if (missingAllowed && isMissing(error)) {
        this.assertDirectoryStable(directoryDescriptor);
        return null;
      }
      throw error;
    }
    if (!this.isPrivateFile(beforeOpen, allowedLinks)) {
      throw this.unsafeTarget();
    }
    this.hooks.beforeExistingFileOpen?.(path);
    this.assertDirectoryStable(directoryDescriptor);
    let descriptor: number;
    try {
      descriptor = openSync(path, flags | (this.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") {
        throw this.unsafeTarget();
      }
      throw error;
    }
    try {
      this.hooks.afterChildOpen?.(path, descriptor);
      this.assertDirectoryStable(directoryDescriptor);
      const opened = fstatSync(descriptor);
      if (
        !sameIdentity(identity(beforeOpen), identity(opened)) ||
        !this.isPrivateFile(opened, allowedLinks)
      ) {
        throw this.unsafeTarget();
      }
      const afterOpen = lstatSync(path);
      if (
        !this.isPrivateFile(afterOpen, allowedLinks) ||
        !sameIdentity(identity(afterOpen), identity(opened))
      ) {
        throw this.unsafeTarget();
      }
      if (this.platform === "win32") {
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(opened),
          allowedLinks,
        );
      }
      this.assertDirectoryStable(directoryDescriptor);
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private openNewFile(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    extraFlags = 0,
    syncOnCreate = true,
  ): number {
    this.assertDirectoryStable(directoryDescriptor);
    const descriptor = openSync(
      path,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        (this.platform === "win32" ? 0 : constants.O_NOFOLLOW) |
        extraFlags,
      0o600,
    );
    try {
      this.hooks.afterChildOpen?.(path, descriptor);
      this.assertDirectoryStable(directoryDescriptor);
      const created = fstatSync(descriptor);
      if (this.platform === "win32") {
        assertWindowsPrivateFileMetadata(created);
      } else {
        if (!created.isFile() || created.nlink !== 1) throw new UnsafeTranscriptTargetError();
        fchmodSync(descriptor, 0o600);
      }
      const opened = fstatSync(descriptor);
      const afterOpen = lstatSync(path);
      if (
        !this.isPrivateFile(opened) ||
        !this.isPrivateFile(afterOpen) ||
        !sameIdentity(identity(afterOpen), identity(opened))
      ) {
        throw this.unsafeTarget();
      }
      if (this.platform === "win32") {
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(opened),
        );
      }
      this.assertDirectoryStable(directoryDescriptor);
      if (syncOnCreate) this.syncDirectory(directoryDescriptor);
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private assertOpenedFileSafe(descriptor: number, allowedLinks: 1 | 2 = 1): void {
    if (!this.isPrivateFile(fstatSync(descriptor), allowedLinks)) {
      throw this.unsafeTarget();
    }
  }

  private assertOpenedPathSafe(
    directoryDescriptor: DirectoryDescriptor,
    descriptor: number,
    path: string,
    allowedLinks: 1 | 2 = 1,
  ): void {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      !this.isPrivateFile(opened, allowedLinks) ||
      !this.isPrivateFile(current, allowedLinks) ||
      !sameIdentity(identity(opened), identity(current))
    ) {
      throw this.unsafeTarget();
    }
    if (this.platform === "win32") {
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        path,
        windowsPrivatePathIdentity(opened),
        allowedLinks,
      );
    }
    this.assertDirectoryStable(directoryDescriptor);
  }

  private openedPathIsUnchanged(
    directoryDescriptor: DirectoryDescriptor,
    descriptor: number,
    path: string,
    before: Stats,
  ): boolean {
    try {
      const opened = fstatSync(descriptor);
      const current = lstatSync(path);
      this.assertDirectoryStable(directoryDescriptor);
      const unchanged =
        this.isPrivateFile(before) &&
        this.isPrivateFile(opened) &&
        this.isPrivateFile(current) &&
        sameIdentity(identity(before), identity(opened)) &&
        sameIdentity(identity(opened), identity(current)) &&
        before.size === opened.size &&
        before.mtimeMs === opened.mtimeMs &&
        before.ctimeMs === opened.ctimeMs;
      if (unchanged && this.platform === "win32") {
        assertWindowsPrivateFileBinding(
          this.windowsDirectoryBinding!,
          path,
          windowsPrivatePathIdentity(opened),
        );
      }
      return unchanged;
    } catch (error) {
      if (this.platform === "win32") {
        throw classifyWindowsPrivatePathFailure("binding-check", error);
      }
      return false;
    }
  }

  private withDirectory<T>(
    operation: (descriptor: DirectoryDescriptor) => T,
    failureStage: WindowsPrivatePathPolicyStage = "read-check",
  ): T {
    if (this.platform === "win32") {
      try {
        this.assertDirectoryStable(null);
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
    const beforeOpen = lstatSync(this.transcriptsDir);
    if (
      beforeOpen.isSymbolicLink() ||
      !beforeOpen.isDirectory() ||
      (beforeOpen.mode & 0o7777) !== 0o700 ||
      !sameIdentity(identity(beforeOpen), this.directoryIdentity)
    ) {
      throw new UnsafeTranscriptTargetError();
    }
    const descriptor = openSync(
      this.transcriptsDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.assertDirectoryStable(descriptor);
      return operation(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private assertDirectoryStable(descriptor: DirectoryDescriptor): void {
    if (this.platform === "win32") {
      assertWindowsPrivateDirectoryStable(this.windowsDirectoryBinding!);
      return;
    }
    const pathStats = lstatSync(this.transcriptsDir);
    const openedStats = fstatSync(descriptor!);
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isDirectory() ||
      !openedStats.isDirectory() ||
      (pathStats.mode & 0o7777) !== 0o700 ||
      (openedStats.mode & 0o7777) !== 0o700 ||
      !sameIdentity(identity(pathStats), this.directoryIdentity) ||
      !sameIdentity(identity(openedStats), this.directoryIdentity)
    ) {
      throw new UnsafeTranscriptTargetError();
    }
  }

  private syncParentDirectory(dataDir: string): void {
    if (this.platform === "win32") {
      this.syncDirectory(null);
      return;
    }
    const descriptor = openSync(
      dataDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.syncDirectory(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private syncFile(descriptor: number): void {
    try {
      (this.hooks.syncFile ?? fsyncSync)(descriptor);
    } catch (error) {
      throw this.platform === "win32"
        ? classifyWindowsPrivatePathFailure("file-flush", error)
        : error;
    }
  }

  private syncDirectory(descriptor: DirectoryDescriptor): void {
    if (this.platform === "win32") {
      if (classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable") return;
    }
    (this.hooks.syncDirectory ?? fsyncSync)(descriptor!);
  }

  private writeComplete(descriptor: number, bytes: Buffer): void {
    const written = (this.hooks.write ?? writeSync)(descriptor, bytes, 0, bytes.length, null);
    if (written !== bytes.length) throw new IncompleteTranscriptWriteError(written);
  }

  private assertPathMissing(path: string): void {
    try {
      lstatSync(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    throw this.unsafeTarget();
  }

  private assertIntentTarget(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    expected: ResetIntentRecord,
  ): void {
    const actual = this.readIntentPath(directoryDescriptor, path, expected.chatId);
    if (actual === null || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw this.unsafeTarget();
    }
  }

  private readIntentPath(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    expectedChatId?: string,
  ): ResetIntentRecord | null {
    const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
    if (descriptor === null) return null;
    try {
      const intent = parseResetIntent(this.readOpenedFile(directoryDescriptor, descriptor, path));
      if (intent === null || (expectedChatId !== undefined && intent.chatId !== expectedChatId)) {
        throw this.unsafeTarget();
      }
      this.assertOpenedFileSafe(descriptor);
      this.assertDirectoryStable(directoryDescriptor);
      return intent;
    } finally {
      closeSync(descriptor);
    }
  }

  private reconcileResetTemps(directoryDescriptor: DirectoryDescriptor, onlyDigest?: string): void {
    const names = readdirSync(this.transcriptsDir);
    this.assertDirectoryStable(directoryDescriptor);
    for (const name of names) {
      if (name.endsWith(".reset-intent.tmp") && !INTENT_TEMP_PATTERN.test(name)) {
        throw this.unsafeTarget();
      }
      const match = INTENT_TEMP_PATTERN.exec(name);
      if (match === null || (onlyDigest !== undefined && match[1] !== onlyDigest)) continue;
      const tempPath = join(this.transcriptsDir, name);
      const observedTemp = lstatSync(tempPath);
      const allowedLinks = observedTemp.nlink === 2 ? 2 : 1;
      const targetPath = join(this.transcriptsDir, `${match[1]}.reset-intent.json`);
      let targetStats: Stats | null = null;
      try {
        targetStats = lstatSync(targetPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const descriptor = this.openExistingFile(
        directoryDescriptor,
        tempPath,
        constants.O_RDONLY,
        false,
        allowedLinks,
      );
      if (descriptor === null) throw this.unsafeTarget();
      if (targetStats === null) {
        closeSync(descriptor);
        if (allowedLinks !== 1) throw this.unsafeTarget();
        this.unlinkPrivateFileIfPresent(directoryDescriptor, tempPath, 1);
        continue;
      }
      try {
        const tempStats = lstatSync(tempPath);
        if (
          allowedLinks !== 2 ||
          !this.isPrivateFile(tempStats, 2) ||
          !this.isPrivateFile(targetStats, 2) ||
          !sameIdentity(identity(tempStats), identity(targetStats))
        ) {
          throw this.unsafeTarget();
        }
        if (this.platform === "win32") {
          assertWindowsPrivateFileBinding(
            this.windowsDirectoryBinding!,
            targetPath,
            windowsPrivatePathIdentity(targetStats),
            2,
          );
        }
        const intent = parseResetIntent(
          this.readOpenedFile(directoryDescriptor, descriptor, tempPath, allowedLinks),
        );
        if (
          intent === null ||
          this.chatDigest(intent.chatId) !== match[1] ||
          intent.resetId !== match[2]
        ) {
          throw this.unsafeTarget();
        }
      } finally {
        closeSync(descriptor);
      }
      this.unlinkMatchingTemp(directoryDescriptor, tempPath, targetPath);
    }
  }

  private unlinkMatchingTemp(
    directoryDescriptor: DirectoryDescriptor,
    tempPath: string,
    targetPath: string,
  ): void {
    let tempStats: Stats;
    try {
      tempStats = lstatSync(tempPath);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const targetStats = lstatSync(targetPath);
    if (
      !this.isPrivateFile(tempStats, 2) ||
      !this.isPrivateFile(targetStats, 2) ||
      !sameIdentity(identity(tempStats), identity(targetStats))
    ) {
      throw this.unsafeTarget();
    }
    if (this.platform === "win32") {
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        tempPath,
        windowsPrivatePathIdentity(tempStats),
        2,
      );
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        targetPath,
        windowsPrivatePathIdentity(targetStats),
        2,
      );
    }
    this.assertDirectoryStable(directoryDescriptor);
    this.unlinkPath(tempPath);
    this.syncDirectory(directoryDescriptor);
  }

  private unlinkPrivateFileIfPresent(
    directoryDescriptor: DirectoryDescriptor,
    path: string,
    links: 1 | 2,
  ): void {
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (!this.isPrivateFile(stats, links)) {
      throw this.unsafeTarget();
    }
    if (this.platform === "win32") {
      assertWindowsPrivateFileBinding(
        this.windowsDirectoryBinding!,
        path,
        windowsPrivatePathIdentity(stats),
        links,
      );
    }
    this.assertDirectoryStable(directoryDescriptor);
    this.unlinkPath(path);
    this.syncDirectory(directoryDescriptor);
  }

  private unlinkPath(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      throw this.platform === "win32" ? classifyWindowsPrivatePathFailure("rename", error) : error;
    }
  }

  private transcriptPath(chatId: string): string {
    return join(this.transcriptsDir, `${this.chatDigest(chatId)}.jsonl`);
  }

  private deletionTempPath(chatId: string, resetId: string): string {
    return join(this.transcriptsDir, `${this.chatDigest(chatId)}.${resetId}.delete.tmp`);
  }

  private intentPath(chatId: string): string {
    return join(this.transcriptsDir, `${this.chatDigest(chatId)}.reset-intent.json`);
  }

  private intentTempPath(chatId: string, resetId: string): string {
    return join(this.transcriptsDir, `${this.chatDigest(chatId)}.${resetId}.reset-intent.tmp`);
  }

  private chatDigest(chatId: string): string {
    return createHash("sha256").update(chatId, "utf8").digest("hex");
  }
}

TranscriptStore.prototype satisfies TranscriptWriterPort;
