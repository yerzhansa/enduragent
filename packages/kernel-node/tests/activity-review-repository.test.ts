import { describe, expect, it, onTestFinished } from "vitest";
import {
  createActivityReviewRepository,
  type ActivityReviewEarlier,
  type ActivityReviewRecord,
} from "@enduragent/kernel/planning";
import { deleteAllDerivedRowsInTransaction } from "@enduragent/kernel/ingest";
import { buildExport, importExport } from "@enduragent/kernel/store/export";
import { dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createSqliteImportSink, webCryptoExportEnv } from "@enduragent/kernel-node/store-export";
import { openSqliteStorage } from "../src/sqlite/index.js";

const ACTIVITY = "a".repeat(64);
const WORKOUT = `${"0".repeat(25)}W`;
const AT = 903_945_600_000;

async function opened() {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  onTestFinished(async () => {
    await store.close();
  });
  return store;
}

const kept: ActivityReviewRecord = {
  activityId: ACTIVITY,
  verdict: {
    state: "kept",
    for: { kind: "workout", planWorkoutId: WORKOUT },
    trigger: "opened",
    usedPlan: true,
    usedNote: false,
    startedAtMs: AT,
    text: "Three reps on target and the fourth short.",
    writtenAtMs: AT + 4_000,
  },
  replies: 1,
  earlier: null,
  note: { text: "Legs heavy after Tuesday.", savedAtMs: AT + 9_000 },
};

const earlier: ActivityReviewEarlier = {
  text: "Three reps on target and the fourth short.",
  writtenAtMs: AT + 4_000,
  for: { kind: "workout", planWorkoutId: WORKOUT },
  trigger: "opened",
  usedPlan: true,
  usedNote: false,
  replies: 1,
};

const attempt = {
  for: { kind: "no-workout" },
  trigger: "asked",
  usedPlan: false,
  usedNote: true,
  startedAtMs: AT + 20_000,
} as const;

const failedAgain: ActivityReviewRecord = {
  ...kept,
  verdict: { state: "failed", failedBy: "model", ...attempt },
  replies: 2,
  earlier,
};

const insert = (
  store: Awaited<ReturnType<typeof opened>>,
  columns: Readonly<Record<string, string | number | null>>,
) => {
  const row: Record<string, string | number | null> = {
    activity_id: ACTIVITY,
    verdict_state: "kept",
    verdict_for: "no-workout",
    verdict_plan_workout_id: null,
    verdict_trigger: "opened",
    verdict_used_plan: 0,
    verdict_used_note: 0,
    verdict_text: "Text",
    verdict_started_at_ms: AT,
    verdict_written_at_ms: AT,
    verdict_failed_by: null,
    replies: 1,
    updated_at_ms: AT,
    ...columns,
  };
  const names = Object.keys(row);
  return store.run(
    `INSERT INTO activity_review (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
    names.map((name) => row[name] ?? null),
  );
};

const earlierColumns = {
  earlier_text: "Earlier",
  earlier_written_at_ms: AT,
  earlier_for: "no-workout",
  earlier_trigger: "opened",
  earlier_used_plan: 0,
  earlier_used_note: 0,
  earlier_replies: 1,
};

describe("activity review repository", () => {
  it("reads back every verdict state, the earlier kept verdict and the athlete's note", async () => {
    const store = await opened();
    const reviews = createActivityReviewRepository(store);
    expect(await reviews.read(ACTIVITY)).toBeUndefined();
    const nothing: ActivityReviewRecord = {
      activityId: ACTIVITY,
      verdict: { state: "not-written" },
      replies: 0,
      earlier: null,
      note: null,
    };
    const writingAgain: ActivityReviewRecord = {
      ...failedAgain,
      verdict: { state: "writing", ...attempt },
    };
    const interrupted: ActivityReviewRecord = {
      ...failedAgain,
      verdict: { state: "failed", failedBy: "interrupted", ...attempt },
      earlier: null,
    };
    for (const record of [nothing, kept, writingAgain, failedAgain, interrupted]) {
      await reviews.save(record, AT + 30_000);
      expect(await reviews.read(ACTIVITY)).toEqual(record);
    }
  });

  it("refuses a row whose verdict, match, failure or earlier verdict disagree", async () => {
    const store = await opened();
    await expect(insert(store, { verdict_text: null })).rejects.toThrow();
    await expect(insert(store, { verdict_state: "writing", verdict_for: null })).rejects.toThrow();
    await expect(insert(store, { verdict_for: "workout" })).rejects.toThrow();
    await expect(
      insert(store, { verdict_state: "failed", verdict_text: null, verdict_written_at_ms: null }),
    ).rejects.toThrow();
    await expect(insert(store, { verdict_failed_by: "model" })).rejects.toThrow();
    await expect(insert(store, { replies: 2, ...earlierColumns })).rejects.toThrow();
    await expect(
      insert(store, {
        verdict_state: "failed",
        verdict_failed_by: "model",
        verdict_text: null,
        verdict_written_at_ms: null,
        replies: 2,
        ...earlierColumns,
        earlier_replies: 2,
      }),
    ).rejects.toThrow();
    await expect(
      insert(store, {
        verdict_state: "failed",
        verdict_failed_by: "model",
        verdict_text: null,
        verdict_written_at_ms: null,
        replies: 2,
        ...earlierColumns,
        earlier_trigger: null,
      }),
    ).rejects.toThrow();
    await expect(
      insert(store, {
        verdict_state: "failed",
        verdict_failed_by: "model",
        verdict_text: null,
        verdict_written_at_ms: null,
        replies: 2,
        ...earlierColumns,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the verdict and the note when the training history is rebuilt", async () => {
    const store = await opened();
    await store.run(
      "INSERT INTO workout (workout_key, start_utc, tz_offset_s, name, dedup_cluster_id) VALUES (?, ?, 0, NULL, ?)",
      [ACTIVITY, AT / 1000, ACTIVITY],
    );
    await store.run(
      `INSERT INTO session (session_key, workout_key, session_seq, sport, start_utc, tz_offset_s,
        local_date_key, moving_s, is_transition) VALUES (?, ?, 0, 'cycling', ?, 0, 19980822, 3300, 0)`,
      [ACTIVITY, ACTIVITY, AT / 1000],
    );
    await createActivityReviewRepository(store).save(failedAgain, AT + 30_000);
    await store.transaction(() => deleteAllDerivedRowsInTransaction(store));
    expect(await store.get("SELECT count(*) AS count FROM session")).toEqual({ count: 0 });
    expect(await createActivityReviewRepository(store).read(ACTIVITY)).toEqual(failedAgain);
  });

  it("carries the verdict, the earlier verdict and the note through an export and an import", async () => {
    const source = await opened();
    const destination = await opened();
    await createActivityReviewRepository(source).save(failedAgain, AT + 30_000);
    const built = await buildExport(
      {
        source: {
          readUserVersion: () => source.getUserVersion(),
          readAuthoredTable: (table, { manualOnly }) =>
            source.all(
              `SELECT * FROM "${table}"${manualOnly ? " WHERE provenance = 'manual'" : ""}`,
            ),
        },
        manifest: { listArtifacts: async () => [] },
        ...webCryptoExportEnv,
      },
      {},
    );
    expect(built.tables.find((entry) => entry.table === "activity_review")?.count).toBe(1);
    await importExport(
      {
        sink: createSqliteImportSink(destination),
        presence: { hasArtifact: async () => true },
        targetUserVersion: 38,
        ...webCryptoExportEnv,
      },
      { container: built.container },
    );
    expect(await createActivityReviewRepository(destination).read(ACTIVITY)).toEqual(failedAgain);
    expect(await dumpStore(destination)).toBe(await dumpStore(source));
  });
});
