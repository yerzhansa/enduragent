import { z } from "zod";
import type { SqlStore } from "../store/ports.js";

const ActivityIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const TimeSchema = z.number().int().nonnegative();
const FlagSchema = z.union([z.literal(0), z.literal(1)]);
const MatchKindSchema = z.enum(["no-workout", "workout"]);
const TriggerSchema = z.enum(["opened", "matched", "asked"]);

export const ACTIVITY_REVIEW_NOTE_MAX = 2_000;
export const ACTIVITY_REVIEW_TEXT_MAX = 3_000;

export type ActivityReviewMatch =
  | { readonly kind: "no-workout" }
  | { readonly kind: "workout"; readonly planWorkoutId: string };

export type ActivityReviewTrigger = "opened" | "matched" | "asked";

export type ActivityReviewFailure = "model" | "interrupted";

export interface ActivityReviewAttempt {
  readonly for: ActivityReviewMatch;
  readonly trigger: ActivityReviewTrigger;
  readonly usedPlan: boolean;
  readonly usedNote: boolean;
  readonly startedAtMs: number;
}

export type ActivityReviewVerdict =
  | { readonly state: "not-written" }
  | ({ readonly state: "writing" } & ActivityReviewAttempt)
  | ({ readonly state: "failed"; readonly failedBy: ActivityReviewFailure } & ActivityReviewAttempt)
  | ({
      readonly state: "kept";
      readonly text: string;
      readonly writtenAtMs: number;
    } & ActivityReviewAttempt);

export interface ActivityReviewEarlier {
  readonly text: string;
  readonly writtenAtMs: number;
  readonly for: ActivityReviewMatch;
  readonly trigger: ActivityReviewTrigger;
  readonly usedPlan: boolean;
  readonly usedNote: boolean;
  readonly replies: number;
}

export interface ActivityReviewNote {
  readonly text: string;
  readonly savedAtMs: number;
}

export interface ActivityReviewRecord {
  readonly activityId: string;
  readonly verdict: ActivityReviewVerdict;
  readonly replies: number;
  readonly earlier: ActivityReviewEarlier | null;
  readonly note: ActivityReviewNote | null;
}

export interface ActivityReviewRepository {
  read(activityId: string): Promise<ActivityReviewRecord | undefined>;
  save(record: ActivityReviewRecord, nowMs: number): Promise<void>;
}

const RowSchema = z.object({
  activity_id: ActivityIdSchema,
  verdict_state: z.enum(["not-written", "writing", "kept", "failed"]),
  verdict_for: MatchKindSchema.nullable(),
  verdict_plan_workout_id: UlidSchema.nullable(),
  verdict_trigger: TriggerSchema.nullable(),
  verdict_used_plan: FlagSchema.nullable(),
  verdict_used_note: FlagSchema.nullable(),
  verdict_text: z.string().min(1).max(ACTIVITY_REVIEW_TEXT_MAX).nullable(),
  verdict_started_at_ms: TimeSchema.nullable(),
  verdict_written_at_ms: TimeSchema.nullable(),
  verdict_failed_by: z.enum(["model", "interrupted"]).nullable(),
  replies: z.number().int().nonnegative(),
  earlier_text: z.string().min(1).max(ACTIVITY_REVIEW_TEXT_MAX).nullable(),
  earlier_written_at_ms: TimeSchema.nullable(),
  earlier_for: MatchKindSchema.nullable(),
  earlier_plan_workout_id: UlidSchema.nullable(),
  earlier_trigger: TriggerSchema.nullable(),
  earlier_used_plan: FlagSchema.nullable(),
  earlier_used_note: FlagSchema.nullable(),
  earlier_replies: z.number().int().positive().nullable(),
  note: z.string().min(1).max(ACTIVITY_REVIEW_NOTE_MAX).nullable(),
  note_saved_at_ms: TimeSchema.nullable(),
});

type Row = z.infer<typeof RowSchema>;

const KEYS = Object.keys(RowSchema.shape);
const COLUMNS = KEYS.join(",");
const PLACEHOLDERS = [...KEYS, "updated_at_ms"].map(() => "?").join(",");
const UPDATES = KEYS.filter((key) => key !== "activity_id")
  .map((key) => `${key}=excluded.${key}`)
  .join(",\n");

export class ActivityReviewRowError extends Error {
  constructor() {
    super("activity review row is invalid");
    this.name = "ActivityReviewRowError";
  }
}

function matchOf(kind: Row["verdict_for"], planWorkoutId: string | null): ActivityReviewMatch {
  if (kind === "no-workout") return { kind: "no-workout" };
  if (kind === "workout" && planWorkoutId !== null) return { kind: "workout", planWorkoutId };
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
    for: matchOf(row.verdict_for, row.verdict_plan_workout_id),
    trigger: row.verdict_trigger,
    usedPlan: row.verdict_used_plan === 1,
    usedNote: row.verdict_used_note === 1,
    startedAtMs: row.verdict_started_at_ms,
  };
  switch (row.verdict_state) {
    case "writing":
      return { state: "writing", ...attempt };
    case "failed":
      if (row.verdict_failed_by === null) throw new ActivityReviewRowError();
      return { state: "failed", failedBy: row.verdict_failed_by, ...attempt };
    case "kept":
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
}

function earlierOf(row: Row): ActivityReviewEarlier | null {
  if (row.earlier_text === null) return null;
  if (
    row.earlier_written_at_ms === null ||
    row.earlier_trigger === null ||
    row.earlier_used_plan === null ||
    row.earlier_used_note === null ||
    row.earlier_replies === null
  ) {
    throw new ActivityReviewRowError();
  }
  return {
    text: row.earlier_text,
    writtenAtMs: row.earlier_written_at_ms,
    for: matchOf(row.earlier_for, row.earlier_plan_workout_id),
    trigger: row.earlier_trigger,
    usedPlan: row.earlier_used_plan === 1,
    usedNote: row.earlier_used_note === 1,
    replies: row.earlier_replies,
  };
}

function recordOf(row: Row): ActivityReviewRecord {
  return {
    activityId: row.activity_id,
    verdict: verdictOf(row),
    replies: row.replies,
    earlier: earlierOf(row),
    note:
      row.note === null || row.note_saved_at_ms === null
        ? null
        : { text: row.note, savedAtMs: row.note_saved_at_ms },
  };
}

function planWorkoutIdOf(match: ActivityReviewMatch | undefined): string | null {
  return match?.kind === "workout" ? UlidSchema.parse(match.planWorkoutId) : null;
}

function flagOf(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value);
}

function valuesOf(
  record: ActivityReviewRecord,
  nowMs: number,
): readonly (string | number | null)[] {
  const verdict = record.verdict;
  const attempt = verdict.state === "not-written" ? undefined : verdict;
  const earlier = record.earlier ?? undefined;
  return [
    ActivityIdSchema.parse(record.activityId),
    verdict.state,
    attempt?.for.kind ?? null,
    planWorkoutIdOf(attempt?.for),
    attempt?.trigger ?? null,
    flagOf(attempt?.usedPlan),
    flagOf(attempt?.usedNote),
    verdict.state === "kept" ? verdict.text : null,
    attempt?.startedAtMs ?? null,
    verdict.state === "kept" ? verdict.writtenAtMs : null,
    verdict.state === "failed" ? verdict.failedBy : null,
    record.replies,
    earlier?.text ?? null,
    earlier?.writtenAtMs ?? null,
    earlier?.for.kind ?? null,
    planWorkoutIdOf(earlier?.for),
    earlier?.trigger ?? null,
    flagOf(earlier?.usedPlan),
    flagOf(earlier?.usedNote),
    earlier?.replies ?? null,
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
VALUES (${PLACEHOLDERS})
ON CONFLICT(activity_id) DO UPDATE SET
${UPDATES},
updated_at_ms=MAX(activity_review.updated_at_ms,excluded.updated_at_ms)`,
        valuesOf(record, nowMs),
      );
    },
  };
}
