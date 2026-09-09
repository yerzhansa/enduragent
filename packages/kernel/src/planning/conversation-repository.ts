import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { createLegacyWriterFence } from "./writer-fence.js";
import { parseRaceCourseSnapshot } from "./race-course.js";

export type PlanConversationStatus = "open" | "ended";
export type PlanDraftRevisionStatus = "forming" | "ready" | "failed" | "discarded" | "approved";
export type PlanRaceCourseChoiceStatus = "undecided" | "omitted" | "attached";

export interface PlanConversationRecord {
  readonly id: string;
  readonly planId: string | null;
  readonly replacesPlanId: string | null;
  readonly courseChoiceStatus: PlanRaceCourseChoiceStatus;
  readonly raceCourseJson: string | null;
  readonly courseFailureJson?: string | null;
  readonly status: PlanConversationStatus;
  readonly endedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanConversationTurnRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly athleteText: string;
  readonly coachText: string;
  readonly lineageJson: string;
  readonly completedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanDraftRevisionRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly planId: string;
  readonly revision: number;
  readonly parentRevisionId: string | null;
  readonly status: PlanDraftRevisionStatus;
  readonly snapshotJson: string;
  readonly raceCourseJson: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanSourceRequestRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly sourceChatId: string;
  readonly sourceBoundaryRef: string | null;
  readonly sourceMessageId: string;
  readonly requestJson: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface ApprovePlanDraftInput {
  readonly draftRevisionId: string;
  readonly expectedRevision: number;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface ApprovePlanDraftResult {
  readonly planId: string;
  readonly draft: PlanDraftRevisionRecord;
}

export type PlanConversationValidationErrorCode =
  | "invalid-id"
  | "invalid-plan-id"
  | "invalid-replacement-plan-id"
  | "same-plan"
  | "invalid-status"
  | "invalid-ended-at"
  | "invalid-timestamp"
  | "invalid-device-id"
  | "invalid-hlc"
  | "invalid-turn"
  | "invalid-draft-revision"
  | "invalid-source-request"
  | "invalid-race-course"
  | "missing-conversation"
  | "missing-source-request"
  | "conversation-ended"
  | "conversation-conflict"
  | "turn-conflict"
  | "draft-lineage-conflict"
  | "source-request-conflict"
  | "plan-not-draft"
  | "stale-draft"
  | "active-plan-exists"
  | "replacement-requires-swap";

export class PlanConversationValidationError extends Error {
  readonly code: PlanConversationValidationErrorCode;

  constructor(code: PlanConversationValidationErrorCode) {
    super(`plan conversation rejected: ${code}`);
    this.name = "PlanConversationValidationError";
    this.code = code;
  }
}

export interface PlanConversationRepository {
  saveConversation(record: PlanConversationRecord): Promise<void>;
  readConversation(id: string): Promise<PlanConversationRecord | undefined>;
  readConversationByPlanId(planId: string): Promise<PlanConversationRecord | undefined>;
  readLatestOpenConversation(): Promise<PlanConversationRecord | undefined>;
  readLatestOpenReplacement(planId: string): Promise<PlanConversationRecord | undefined>;
  appendTurn(record: PlanConversationTurnRecord): Promise<PlanConversationTurnRecord>;
  readTurns(conversationId: string): Promise<readonly PlanConversationTurnRecord[]>;
  saveDraftRevision(record: PlanDraftRevisionRecord): Promise<void>;
  readDraftRevision(id: string): Promise<PlanDraftRevisionRecord | undefined>;
  readDraftRevisions(conversationId: string): Promise<readonly PlanDraftRevisionRecord[]>;
  readLatestDraftRevision(conversationId: string): Promise<PlanDraftRevisionRecord | undefined>;
  approveDraft(input: ApprovePlanDraftInput): Promise<ApprovePlanDraftResult>;
  createOrGetSourceRequest(record: PlanSourceRequestRecord): Promise<PlanSourceRequestRecord>;
  bindSourceBoundary(record: PlanSourceRequestRecord): Promise<PlanSourceRequestRecord>;
  readSourceRequest(id: string): Promise<PlanSourceRequestRecord | undefined>;
  readSourceRequests(conversationId: string): Promise<readonly PlanSourceRequestRecord[]>;
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONVERSATION_STATUS = new Set<unknown>(["open", "ended"]);
const DRAFT_STATUS = new Set<unknown>(["forming", "ready", "failed", "discarded", "approved"]);

function validJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validHlc(record: {
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}): boolean {
  return (
    Number.isSafeInteger(record.hlcPhysicalMs) &&
    record.hlcPhysicalMs >= 0 &&
    Number.isSafeInteger(record.hlcCounter) &&
    record.hlcCounter >= 0
  );
}

export function validatePlanConversationRecord(record: PlanConversationRecord): void {
  const endedAtMs = record.endedAtMs;
  if (!ULID.test(record.id)) throw new PlanConversationValidationError("invalid-id");
  if (record.planId !== null && !ULID.test(record.planId)) {
    throw new PlanConversationValidationError("invalid-plan-id");
  }
  if (record.replacesPlanId !== null && !ULID.test(record.replacesPlanId)) {
    throw new PlanConversationValidationError("invalid-replacement-plan-id");
  }
  if (record.planId !== null && record.planId === record.replacesPlanId) {
    throw new PlanConversationValidationError("same-plan");
  }
  if (
    (record.courseChoiceStatus === "attached") !== (record.raceCourseJson !== null) ||
    !["undecided", "omitted", "attached"].includes(record.courseChoiceStatus) ||
    !validRaceCourseJson(record.raceCourseJson) ||
    !validCourseFailureJson(record.courseFailureJson)
  ) {
    throw new PlanConversationValidationError("invalid-race-course");
  }
  if (!CONVERSATION_STATUS.has(record.status)) {
    throw new PlanConversationValidationError("invalid-status");
  }
  if (
    (record.status === "open" && endedAtMs !== null) ||
    (record.status === "ended" &&
      (!Number.isSafeInteger(endedAtMs) ||
        endedAtMs === null ||
        endedAtMs < record.createdAtMs ||
        endedAtMs > record.updatedAtMs))
  ) {
    throw new PlanConversationValidationError("invalid-ended-at");
  }
  if (
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs
  ) {
    throw new PlanConversationValidationError("invalid-timestamp");
  }
  if (!DEVICE_ID.test(record.deviceId)) {
    throw new PlanConversationValidationError("invalid-device-id");
  }
  if (!validHlc(record)) throw new PlanConversationValidationError("invalid-hlc");
}

export function validatePlanConversationTurnRecord(record: PlanConversationTurnRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.conversationId) ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence <= 0 ||
    typeof record.athleteText !== "string" ||
    record.athleteText.length === 0 ||
    typeof record.coachText !== "string" ||
    record.coachText.length === 0 ||
    !validJson(record.lineageJson) ||
    !Number.isSafeInteger(record.completedAtMs) ||
    record.completedAtMs < 0 ||
    !DEVICE_ID.test(record.deviceId) ||
    !validHlc(record)
  ) {
    throw new PlanConversationValidationError("invalid-turn");
  }
}

export function validatePlanDraftRevisionRecord(record: PlanDraftRevisionRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.conversationId) ||
    !ULID.test(record.planId) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    (record.parentRevisionId !== null && !ULID.test(record.parentRevisionId)) ||
    (record.revision === 1) !== (record.parentRevisionId === null) ||
    !DRAFT_STATUS.has(record.status) ||
    !validJson(record.snapshotJson) ||
    !validRaceCourseJson(record.raceCourseJson) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !Number.isSafeInteger(record.updatedAtMs) ||
    record.updatedAtMs < record.createdAtMs ||
    !DEVICE_ID.test(record.deviceId) ||
    !validHlc(record)
  ) {
    throw new PlanConversationValidationError("invalid-draft-revision");
  }
}

function validRaceCourseJson(value: string | null): boolean {
  if (value === null) return true;
  try {
    parseRaceCourseSnapshot(JSON.parse(value) as unknown);
    return true;
  } catch {
    return false;
  }
}

function validCourseFailureJson(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return (
      typeof parsed.fileName === "string" &&
      parsed.fileName.length > 0 &&
      typeof parsed.detail === "string" &&
      parsed.detail.length > 0
    );
  } catch {
    return false;
  }
}

export function validatePlanSourceRequestRecord(record: PlanSourceRequestRecord): void {
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.conversationId) ||
    typeof record.sourceChatId !== "string" ||
    record.sourceChatId.length === 0 ||
    (record.sourceBoundaryRef !== null &&
      (typeof record.sourceBoundaryRef !== "string" || record.sourceBoundaryRef.length === 0)) ||
    typeof record.sourceMessageId !== "string" ||
    record.sourceMessageId.length === 0 ||
    !validJson(record.requestJson) ||
    !Number.isSafeInteger(record.createdAtMs) ||
    record.createdAtMs < 0 ||
    !DEVICE_ID.test(record.deviceId) ||
    !validHlc(record)
  ) {
    throw new PlanConversationValidationError("invalid-source-request");
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanConversationValidationError("invalid-id");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanConversationValidationError("invalid-timestamp");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanConversationValidationError("invalid-id");
  }
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanConversationValidationError("invalid-timestamp");
  }
  return value;
}

function conversationFromRow(row: Row): PlanConversationRecord {
  const courseFailureJson = nullableText(row, "course_failure_json");
  const record: PlanConversationRecord = Object.freeze({
    id: text(row, "id"),
    planId: nullableText(row, "plan_id"),
    replacesPlanId: nullableText(row, "replaces_plan_id"),
    courseChoiceStatus: text(row, "course_choice_status") as PlanRaceCourseChoiceStatus,
    raceCourseJson: nullableText(row, "race_course_json"),
    ...(courseFailureJson === null ? {} : { courseFailureJson }),
    status: text(row, "status") as PlanConversationStatus,
    endedAtMs: nullableInteger(row, "ended_at_ms"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  validatePlanConversationRecord(record);
  return record;
}

function turnFromRow(row: Row): PlanConversationTurnRecord {
  const record: PlanConversationTurnRecord = Object.freeze({
    id: text(row, "id"),
    conversationId: text(row, "conversation_id"),
    sequence: integer(row, "sequence"),
    athleteText: text(row, "athlete_text"),
    coachText: text(row, "coach_text"),
    lineageJson: text(row, "lineage_json"),
    completedAtMs: integer(row, "completed_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  validatePlanConversationTurnRecord(record);
  return record;
}

function draftRevisionFromRow(row: Row): PlanDraftRevisionRecord {
  const record: PlanDraftRevisionRecord = Object.freeze({
    id: text(row, "id"),
    conversationId: text(row, "conversation_id"),
    planId: text(row, "plan_id"),
    revision: integer(row, "revision"),
    parentRevisionId: nullableText(row, "parent_revision_id"),
    status: text(row, "status") as PlanDraftRevisionStatus,
    snapshotJson: text(row, "snapshot_json"),
    raceCourseJson: nullableText(row, "race_course_json"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  validatePlanDraftRevisionRecord(record);
  return record;
}

function sourceRequestFromRow(row: Row): PlanSourceRequestRecord {
  const record: PlanSourceRequestRecord = Object.freeze({
    id: text(row, "id"),
    conversationId: text(row, "conversation_id"),
    sourceChatId: text(row, "source_chat_id"),
    sourceBoundaryRef: nullableText(row, "source_boundary_ref"),
    sourceMessageId: text(row, "source_message_id"),
    requestJson: text(row, "request_json"),
    createdAtMs: integer(row, "created_at_ms"),
    updatedAtMs: integer(row, "updated_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  });
  validatePlanSourceRequestRecord(record);
  return record;
}

function sameRecord<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createPlanConversationRepository(store: PlanningStore): PlanConversationRepository {
  return createConversationRepository(store, false);
}

export function createLegacyPlanTransitionRepository(
  store: PlanningStore,
): PlanConversationRepository {
  return createConversationRepository(store, true);
}

function createConversationRepository(
  store: PlanningStore,
  enforceLegacyAuthority: boolean,
): PlanConversationRepository {
  const writerFence = createLegacyWriterFence(store);
  const readConversation = async (id: string): Promise<PlanConversationRecord | undefined> => {
    const row = await store.get("SELECT * FROM plan_conversation WHERE id = ?", [id]);
    return row === undefined ? undefined : conversationFromRow(row);
  };

  const readDraftRevision = async (id: string): Promise<PlanDraftRevisionRecord | undefined> => {
    const row = await store.get("SELECT * FROM plan_draft_revision WHERE id = ?", [id]);
    return row === undefined ? undefined : draftRevisionFromRow(row);
  };

  const readSourceRequest = async (id: string): Promise<PlanSourceRequestRecord | undefined> => {
    const row = await store.get("SELECT * FROM plan_source_request WHERE id = ?", [id]);
    return row === undefined ? undefined : sourceRequestFromRow(row);
  };

  const requireOpenConversation = async (id: string): Promise<PlanConversationRecord> => {
    const conversation = await readConversation(id);
    if (conversation === undefined)
      throw new PlanConversationValidationError("missing-conversation");
    if (conversation.status === "ended") {
      throw new PlanConversationValidationError("conversation-ended");
    }
    return conversation;
  };

  return {
    async saveConversation(record) {
      validatePlanConversationRecord(record);
      await store.transaction(async () => {
        if (enforceLegacyAuthority) await writerFence.assertLegacyAuthority();
        const existing = await readConversation(record.id);
        if (existing !== undefined) {
          if (existing.status === "ended") {
            if (!sameRecord(existing, record)) {
              throw new PlanConversationValidationError("conversation-conflict");
            }
            return;
          }
          if (
            existing.createdAtMs !== record.createdAtMs ||
            existing.updatedAtMs > record.updatedAtMs ||
            (existing.planId !== null && existing.planId !== record.planId) ||
            existing.replacesPlanId !== record.replacesPlanId
          ) {
            throw new PlanConversationValidationError("conversation-conflict");
          }
        }
        await store.run(
          `INSERT INTO plan_conversation (
  id, plan_id, replaces_plan_id, course_choice_status, race_course_json, course_failure_json, status,
  ended_at_ms, created_at_ms, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  plan_id = excluded.plan_id,
  course_choice_status = excluded.course_choice_status,
  race_course_json = excluded.race_course_json,
  course_failure_json = excluded.course_failure_json,
  status = excluded.status,
  ended_at_ms = excluded.ended_at_ms,
  updated_at_ms = excluded.updated_at_ms,
  device_id = excluded.device_id,
  hlc_physical_ms = excluded.hlc_physical_ms,
  hlc_counter = excluded.hlc_counter`,
          [
            record.id,
            record.planId,
            record.replacesPlanId,
            record.courseChoiceStatus,
            record.raceCourseJson,
            record.courseFailureJson ?? null,
            record.status,
            record.endedAtMs,
            record.createdAtMs,
            record.updatedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
          ],
        );
      });
    },

    readConversation,

    async readConversationByPlanId(planId) {
      const row = await store.get("SELECT * FROM plan_conversation WHERE plan_id = ?", [planId]);
      return row === undefined ? undefined : conversationFromRow(row);
    },

    async readLatestOpenConversation() {
      const row = await store.get(
        "SELECT * FROM plan_conversation WHERE status = 'open' ORDER BY created_at_ms DESC, id DESC LIMIT 1",
      );
      return row === undefined ? undefined : conversationFromRow(row);
    },

    async readLatestOpenReplacement(planId) {
      const row = await store.get(
        "SELECT * FROM plan_conversation WHERE status = 'open' AND replaces_plan_id = ? ORDER BY created_at_ms DESC, id DESC LIMIT 1",
        [planId],
      );
      return row === undefined ? undefined : conversationFromRow(row);
    },

    async appendTurn(record) {
      validatePlanConversationTurnRecord(record);
      return store.transaction(async () => {
        if (enforceLegacyAuthority) await writerFence.assertLegacyAuthority();
        await requireOpenConversation(record.conversationId);
        const existingRow = await store.get("SELECT * FROM plan_conversation_turn WHERE id = ?", [
          record.id,
        ]);
        if (existingRow !== undefined) {
          const existing = turnFromRow(existingRow);
          if (!sameRecord(existing, record)) {
            throw new PlanConversationValidationError("turn-conflict");
          }
          return existing;
        }
        const last = await store.get(
          "SELECT sequence FROM plan_conversation_turn WHERE conversation_id = ? ORDER BY sequence DESC LIMIT 1",
          [record.conversationId],
        );
        const expected = last === undefined ? 1 : integer(last, "sequence") + 1;
        if (record.sequence !== expected) {
          throw new PlanConversationValidationError("turn-conflict");
        }
        await store.run(
          `INSERT INTO plan_conversation_turn (
  id, conversation_id, sequence, athlete_text, coach_text, lineage_json,
  completed_at_ms, device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.conversationId,
            record.sequence,
            record.athleteText,
            record.coachText,
            record.lineageJson,
            record.completedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
          ],
        );
        return record;
      });
    },

    async readTurns(conversationId) {
      const rows = await store.all(
        "SELECT * FROM plan_conversation_turn WHERE conversation_id = ? ORDER BY sequence ASC, id ASC",
        [conversationId],
      );
      return Object.freeze(rows.map(turnFromRow));
    },

    async saveDraftRevision(record) {
      validatePlanDraftRevisionRecord(record);
      await store.transaction(async () => {
        if (enforceLegacyAuthority) await writerFence.assertLegacyAuthority();
        const conversation = await requireOpenConversation(record.conversationId);
        if (conversation.planId !== null && conversation.planId !== record.planId) {
          throw new PlanConversationValidationError("draft-lineage-conflict");
        }
        const plan = await store.get("SELECT status FROM plan WHERE id = ?", [record.planId]);
        if (plan === undefined || text(plan, "status") !== "draft") {
          throw new PlanConversationValidationError("plan-not-draft");
        }
        const existing = await readDraftRevision(record.id);
        if (existing !== undefined) {
          if (
            existing.conversationId !== record.conversationId ||
            existing.planId !== record.planId ||
            existing.revision !== record.revision ||
            existing.parentRevisionId !== record.parentRevisionId ||
            existing.createdAtMs !== record.createdAtMs ||
            existing.updatedAtMs > record.updatedAtMs
          ) {
            throw new PlanConversationValidationError("draft-lineage-conflict");
          }
        } else if (record.revision === 1) {
          const first = await store.get(
            "SELECT id FROM plan_draft_revision WHERE plan_id = ? LIMIT 1",
            [record.planId],
          );
          if (first !== undefined) {
            throw new PlanConversationValidationError("draft-lineage-conflict");
          }
        } else {
          const parent = await readDraftRevision(record.parentRevisionId!);
          const latest = await store.get(
            "SELECT id FROM plan_draft_revision WHERE plan_id = ? ORDER BY revision DESC LIMIT 1",
            [record.planId],
          );
          if (
            parent === undefined ||
            parent.conversationId !== record.conversationId ||
            parent.planId !== record.planId ||
            parent.revision + 1 !== record.revision ||
            latest === undefined ||
            text(latest, "id") !== parent.id
          ) {
            throw new PlanConversationValidationError("draft-lineage-conflict");
          }
        }
        await store.run(
          `INSERT INTO plan_draft_revision (
  id, conversation_id, plan_id, revision, parent_revision_id, parent_revision, status,
  snapshot_json, race_course_json, created_at_ms, updated_at_ms, device_id, hlc_physical_ms,
  hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  status = excluded.status,
  snapshot_json = excluded.snapshot_json,
  race_course_json = excluded.race_course_json,
  updated_at_ms = excluded.updated_at_ms,
  device_id = excluded.device_id,
  hlc_physical_ms = excluded.hlc_physical_ms,
  hlc_counter = excluded.hlc_counter`,
          [
            record.id,
            record.conversationId,
            record.planId,
            record.revision,
            record.parentRevisionId,
            record.parentRevisionId === null ? null : record.revision - 1,
            record.status,
            record.snapshotJson,
            record.raceCourseJson,
            record.createdAtMs,
            record.updatedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
          ],
        );
      });
    },

    readDraftRevision,

    async readDraftRevisions(conversationId) {
      const rows = await store.all(
        "SELECT * FROM plan_draft_revision WHERE conversation_id = ? ORDER BY revision ASC, id ASC",
        [conversationId],
      );
      return Object.freeze(rows.map(draftRevisionFromRow));
    },

    async readLatestDraftRevision(conversationId) {
      const row = await store.get(
        "SELECT * FROM plan_draft_revision WHERE conversation_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
        [conversationId],
      );
      return row === undefined ? undefined : draftRevisionFromRow(row);
    },

    async approveDraft(input) {
      if (
        !ULID.test(input.draftRevisionId) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision <= 0 ||
        !Number.isSafeInteger(input.updatedAtMs) ||
        input.updatedAtMs < 0 ||
        !DEVICE_ID.test(input.deviceId) ||
        !validHlc(input)
      ) {
        throw new PlanConversationValidationError("invalid-draft-revision");
      }
      return store.transaction(async () => {
        if (enforceLegacyAuthority) await writerFence.assertLegacyAuthority();
        const draft = await readDraftRevision(input.draftRevisionId);
        if (draft === undefined) {
          throw new PlanConversationValidationError("stale-draft");
        }
        const latest = await store.get(
          "SELECT id FROM plan_draft_revision WHERE conversation_id = ? ORDER BY revision DESC, id DESC LIMIT 1",
          [draft.conversationId],
        );
        if (
          latest === undefined ||
          text(latest, "id") !== draft.id ||
          draft.revision !== input.expectedRevision
        ) {
          throw new PlanConversationValidationError("stale-draft");
        }
        const conversation = await requireOpenConversation(draft.conversationId);
        if (conversation.replacesPlanId !== null) {
          throw new PlanConversationValidationError("replacement-requires-swap");
        }
        const plan = await store.get("SELECT status FROM plan WHERE id = ?", [draft.planId]);
        if (
          draft.status === "approved" &&
          plan !== undefined &&
          text(plan, "status") === "active"
        ) {
          return { planId: draft.planId, draft };
        }
        if (draft.status !== "ready") {
          throw new PlanConversationValidationError("stale-draft");
        }
        if (plan === undefined || text(plan, "status") !== "draft") {
          throw new PlanConversationValidationError("plan-not-draft");
        }
        const active = await store.get("SELECT id FROM plan WHERE status = 'active' LIMIT 1");
        if (active !== undefined && text(active, "id") !== draft.planId) {
          throw new PlanConversationValidationError("active-plan-exists");
        }
        if (input.updatedAtMs < draft.updatedAtMs) {
          throw new PlanConversationValidationError("stale-draft");
        }
        await store.run(
          `UPDATE plan SET status='active',updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
           WHERE id=? AND status='draft'`,
          [input.updatedAtMs, input.deviceId, input.hlcPhysicalMs, input.hlcCounter, draft.planId],
        );
        await store.run(
          `UPDATE plan_draft_revision SET status='approved',updated_at_ms=?,device_id=?,
             hlc_physical_ms=?,hlc_counter=? WHERE id=? AND status='ready'`,
          [input.updatedAtMs, input.deviceId, input.hlcPhysicalMs, input.hlcCounter, draft.id],
        );
        const approved = await readDraftRevision(draft.id);
        if (approved === undefined || approved.status !== "approved") {
          throw new PlanConversationValidationError("stale-draft");
        }
        return { planId: draft.planId, draft: approved };
      });
    },

    async createOrGetSourceRequest(record) {
      validatePlanSourceRequestRecord(record);
      return store.transaction(async () => {
        if (enforceLegacyAuthority) await writerFence.assertLegacyAuthority();
        await requireOpenConversation(record.conversationId);
        const existing = await readSourceRequest(record.id);
        if (existing !== undefined) {
          if (!sameRecord(existing, record)) {
            throw new PlanConversationValidationError("source-request-conflict");
          }
          return existing;
        }
        await store.run(
          `INSERT INTO plan_source_request (
  id, conversation_id, source_chat_id, source_boundary_ref, source_message_id,
  request_json, created_at_ms, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.conversationId,
            record.sourceChatId,
            record.sourceBoundaryRef,
            record.sourceMessageId,
            record.requestJson,
            record.createdAtMs,
            record.updatedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
          ],
        );
        return record;
      });
    },

    async bindSourceBoundary(record) {
      validatePlanSourceRequestRecord(record);
      if (record.sourceBoundaryRef === null) {
        throw new PlanConversationValidationError("invalid-source-request");
      }
      return store.transaction(async () => {
        if (enforceLegacyAuthority) await writerFence.assertLegacyAuthority();
        const existing = await readSourceRequest(record.id);
        if (existing === undefined) {
          throw new PlanConversationValidationError("missing-source-request");
        }
        if (
          existing.conversationId !== record.conversationId ||
          existing.sourceChatId !== record.sourceChatId ||
          existing.sourceMessageId !== record.sourceMessageId ||
          existing.requestJson !== record.requestJson ||
          existing.createdAtMs !== record.createdAtMs ||
          existing.updatedAtMs > record.updatedAtMs
        ) {
          throw new PlanConversationValidationError("source-request-conflict");
        }
        if (existing.sourceBoundaryRef !== null) {
          if (!sameRecord(existing, record)) {
            throw new PlanConversationValidationError("source-request-conflict");
          }
          return existing;
        }
        await store.run(
          `UPDATE plan_source_request SET
  source_boundary_ref = ?,
  updated_at_ms = ?,
  device_id = ?,
  hlc_physical_ms = ?,
  hlc_counter = ?
WHERE id = ?`,
          [
            record.sourceBoundaryRef,
            record.updatedAtMs,
            record.deviceId,
            record.hlcPhysicalMs,
            record.hlcCounter,
            record.id,
          ],
        );
        return record;
      });
    },

    readSourceRequest,

    async readSourceRequests(conversationId) {
      const rows = await store.all(
        "SELECT * FROM plan_source_request WHERE conversation_id = ? ORDER BY created_at_ms ASC, id ASC",
        [conversationId],
      );
      return Object.freeze(rows.map(sourceRequestFromRow));
    },
  };
}
