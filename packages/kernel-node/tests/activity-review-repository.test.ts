import { describe, expect, it, onTestFinished } from "vitest";
import {
  createActivityReviewRepository,
  type ActivityReviewRecord,
} from "@enduragent/kernel/planning";
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
  note: { text: "Legs heavy after Tuesday.", savedAtMs: AT + 9_000 },
};

describe("activity review repository", () => {
  it("reads back every verdict state and the athlete's note", async () => {
    const store = await opened();
    const reviews = createActivityReviewRepository(store);
    expect(await reviews.read(ACTIVITY)).toBeUndefined();
    await reviews.save(
      { activityId: ACTIVITY, verdict: { state: "not-written" }, replies: 0, note: null },
      AT,
    );
    expect(await reviews.read(ACTIVITY)).toEqual({
      activityId: ACTIVITY,
      verdict: { state: "not-written" },
      replies: 0,
      note: null,
    });
    const writing: ActivityReviewRecord = {
      ...kept,
      verdict: {
        state: "writing",
        for: { kind: "no-workout" },
        trigger: "asked",
        usedPlan: false,
        usedNote: true,
        startedAtMs: AT,
      },
      replies: 2,
    };
    for (const record of [
      kept,
      writing,
      { ...writing, verdict: { ...writing.verdict, state: "failed" as const } },
    ]) {
      await reviews.save(record, AT + 10_000);
      expect(await reviews.read(ACTIVITY)).toEqual(record);
    }
  });

  it("refuses a row whose verdict and match disagree", async () => {
    const store = await opened();
    const insert = (state: string, forKind: string | null, text: string | null) =>
      store.run(
        `INSERT INTO activity_review (activity_id,verdict_state,verdict_for,verdict_plan_workout_id,
verdict_trigger,verdict_used_plan,verdict_used_note,verdict_text,verdict_started_at_ms,
verdict_written_at_ms,replies,note,note_saved_at_ms,updated_at_ms)
VALUES (?,?,?,NULL,'opened',0,0,?,?,?,1,NULL,NULL,?)`,
        [ACTIVITY, state, forKind, text, AT, text === null ? null : AT, AT],
      );
    await expect(insert("kept", "no-workout", null)).rejects.toThrow();
    await expect(insert("writing", null, null)).rejects.toThrow();
    await expect(insert("kept", "workout", "Text")).rejects.toThrow();
    await expect(insert("writing", "no-workout", "Text")).rejects.toThrow();
    await expect(insert("kept", "no-workout", "Text")).resolves.toBeUndefined();
  });

  it("carries the verdict and the note through an export and an import", async () => {
    const source = await opened();
    const destination = await opened();
    await createActivityReviewRepository(source).save(kept, AT + 10_000);
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
        targetUserVersion: 37,
        ...webCryptoExportEnv,
      },
      { container: built.container },
    );
    expect(await createActivityReviewRepository(destination).read(ACTIVITY)).toEqual(kept);
    expect(await dumpStore(destination)).toBe(await dumpStore(source));
  });
});
