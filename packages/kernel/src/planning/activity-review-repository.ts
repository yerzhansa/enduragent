import { z } from "zod";
import type { SqlStore } from "../store/ports.js";

const ActivityIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const TimeSchema = z.number().int().nonnegative();
const FlagSchema = z.union([z.literal(0), z.literal(1)]);

export const ACTIVITY_REVIEW_NOTE_MAX = 2_000;
export const ACTIVITY_REVIEW_TEXT_MAX = 3_000;

export type ActivityReviewMatch =
  | { readonly kind: "no-workout" }
  | { readonly kind: "workout"; readonly planWorkoutId: string };

export type ActivityReviewTrigger = "opened" | "matched" | "asked";

export interface ActivityReviewAttempt {
  readonly for: ActivityReviewMatch;
  readonly trigger: ActivityReviewTrigger;
  readonly usedPlan: boolean;
  readonly usedNote: boolean;
  readonly startedAtMs: number;
}

export type ActivityReviewVerdict =
  | { readonly state: "not-written" }
  | ({ readonly state: "writing" | "failed" } & ActivityReviewAttempt)
  | ({
      readonly state: "kept";
      readonly text: string;
      readonly writtenAtMs: number;
    } & ActivityReviewAttempt);

export interface ActivityReviewNote {
  readonly text: string;
  readonly savedAtMs: number;
}

export interface ActivityReviewRecord {
  readonly activityId: string;
  readonly verdict: ActivityReviewVerdict;
  readonly replies: number;
  readonly note: ActivityReviewNote | null;
}

export interface ActivityReviewRepository {
  read(activityId: string): Promise<ActivityReviewRecord | undefined>;
  save(record: ActivityReviewRecord, nowMs: number): Promise<void>;
}

const RowSchema = z.object({
  activity_id: ActivityIdSchema,
  verdict_state: z.enum(["not-written", "writing", "kept", "failed"]),
  verdict_for: z.enum(["no-workout", "workout"]).nullable(),
  verdict_plan_workout_id: UlidSchema.nullable(),
  verdict_trigger: z.enum(["opened", "matched", "asked"]).nullable(),
  verdict_used_plan: FlagSchema.nullable(),
  verdict_used_note: FlagSchema.nullable(),
  verdict_text: z.string().min(1).max(ACTIVITY_REVIEW_TEXT_MAX).nullable(),
  verdict_started_at_ms: TimeSchema.nullable(),
  verdict_written_at_ms: TimeSchema.nullable(),
  replies: z.number().int().nonnegative(),
  note: z.string().min(1).max(ACTIVITY_REVIEW_NOTE_MAX).nullable(),
  note_saved_at_ms: TimeSchema.nullable(),
});

type Row = z.infer<typeof RowSchema>;

const COLUMNS = Object.keys(RowSchema.shape).join(",");

export class ActivityReviewRowError extends Error {
  constructor() {
    super("activity review row is invalid");
    this.name = "ActivityReviewRowError";
  }
}

function matchOf(row: Row): ActivityReviewMatch {
  if (row.verdict_for === "no-workout") return { kind: "no-workout" };
  if (row.verdict_for === "workout" && row.verdict_plan_workout_id !== null) {
    return { kind: "workout", planWorkoutId: row.verdict_plan_workout_id };
  }
  throw new ActivityReviewRowError();
}

function verdictOf(row: Row): ActivityReviewVerdict {
  if (row.verdict_state === "not-written") return { state: "not-written" };
  if (
    row.verdict_trigger === null ||
    row.verdict_used_plan === null ||
    row.verdict_used_note === null ||
    row.verdict_started_at_ms === null
  ) {
    throw new ActivityReviewRowError();
  }
  const attempt: ActivityReviewAttempt = {
    for: matchOf(row),
    trigger: row.verdict_trigger,
    usedPlan: row.verdict_used_plan === 1,
    usedNote: row.verdict_used_note === 1,
    startedAtMs: row.verdict_started_at_ms,
  };
  if (row.verdict_state !== "kept") return { state: row.verdict_state, ...attempt };
  if (row.verdict_text === null || row.verdict_written_at_ms === null) {
    throw new ActivityReviewRowError();
  }
  return {
    state: "kept",
    text: row.verdict_text,
    writtenAtMs: row.verdict_written_at_ms,
    ...attempt,
  };
}

function recordOf(row: Row): ActivityReviewRecord {
  return {
    activityId: row.activity_id,
    verdict: verdictOf(row),
    replies: row.replies,
    note:
      row.note === null || row.note_saved_at_ms === null
        ? null
        : { text: row.note, savedAtMs: row.note_saved_at_ms },
  };
}

function valuesOf(
  record: ActivityReviewRecord,
  nowMs: number,
): readonly (string | number | null)[] {
  const verdict = record.verdict;
  const attempt = verdict.state === "not-written" ? null : verdict;
  return [
    ActivityIdSchema.parse(record.activityId),
    verdict.state,
    attempt?.for.kind ?? null,
    attempt?.for.kind === "workout" ? UlidSchema.parse(attempt.for.planWorkoutId) : null,
    attempt?.trigger ?? null,
    attempt === null ? null : Number(attempt.usedPlan),
    attempt === null ? null : Number(attempt.usedNote),
    verdict.state === "kept" ? verdict.text : null,
    attempt?.startedAtMs ?? null,
    verdict.state === "kept" ? verdict.writtenAtMs : null,
    record.replies,
    record.note?.text ?? null,
    record.note?.savedAtMs ?? null,
    nowMs,
  ];
}

export function createActivityReviewRepository(
  store: Pick<SqlStore, "get" | "run">,
): ActivityReviewRepository {
  return {
    async read(activityId) {
      const row = await store.get(`SELECT ${COLUMNS} FROM activity_review WHERE activity_id=?`, [
        ActivityIdSchema.parse(activityId),
      ]);
      return row === undefined ? undefined : recordOf(RowSchema.parse(row));
    },
    async save(record, nowMs) {
      await store.run(
        `INSERT INTO activity_review (${COLUMNS},updated_at_ms)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(activity_id) DO UPDATE SET
verdict_state=excluded.verdict_state,
verdict_for=excluded.verdict_for,
verdict_plan_workout_id=excluded.verdict_plan_workout_id,
verdict_trigger=excluded.verdict_trigger,
verdict_used_plan=excluded.verdict_used_plan,
verdict_used_note=excluded.verdict_used_note,
verdict_text=excluded.verdict_text,
verdict_started_at_ms=excluded.verdict_started_at_ms,
verdict_written_at_ms=excluded.verdict_written_at_ms,
replies=excluded.replies,
note=excluded.note,
note_saved_at_ms=excluded.note_saved_at_ms,
updated_at_ms=MAX(activity_review.updated_at_ms,excluded.updated_at_ms)`,
        valuesOf(record, nowMs),
      );
    },
  };
}
