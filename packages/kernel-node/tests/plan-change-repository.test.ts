import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlanChangeRepository,
  createPlanCreationRepository,
  createPlanLifecycleRepository,
  createPlanReconciliationRepository,
  type PlanCreationCommandStamp,
  type PreviewPlanChangeInput,
} from "@enduragent/kernel/planning";
import {
  dumpStore,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (value: string) => value.padStart(26, "0");
const nowMs = 883_612_800_000;
const planId = id("11");
const fingerprint = "f".repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stamp = (commandId: string, offset: number): PlanCreationCommandStamp => ({
  commandId,
  requestDigest: "a".repeat(64),
  nowMs: nowMs + offset,
  deviceId: "test-device-1998",
  hlcPhysicalMs: nowMs + offset,
  hlcCounter: 0,
});
const keptWorkout = {
  id: "kept",
  name: "Endurance ride",
  kind: "easy",
  date: "1998-01-01",
  minutes: 60,
};
const removedWorkout = {
  id: "removed",
  name: "Long ride",
  kind: "long",
  date: "1998-01-02",
  minutes: 120,
};
const addedWorkout = {
  id: "added",
  name: "Easy ride",
  kind: "easy",
  date: "1998-01-03",
  minutes: 30,
};
const poolWorkout = { id: "pool", name: "Flexible ride", kind: "easy", date: null, minutes: 30 };
const draft = {
  outputFingerprint: fingerprint,
  weeks: [{ number: 1, minutes: 180, workouts: [keptWorkout, removedWorkout, poolWorkout] }],
};
const after = {
  ...draft,
  weeks: [{ number: 1, minutes: 90, workouts: [keptWorkout, addedWorkout, poolWorkout] }],
};
const envelope = {
  title: "Limit weekly duration",
  intent: { kind: "weekly-duration", hours: 1.5 },
  diff: [
    { workoutId: "removed", before: removedWorkout, after: null },
    { workoutId: "added", before: null, after: addedWorkout },
  ],
  totals: {
    before: { plan: 180, weeks: [{ number: 1, minutes: 180 }] },
    after: { plan: 90, weeks: [{ number: 1, minutes: 90 }] },
  },
  supersedes: null,
  confidence:
    "Moderate confidence. Based on your confirmed limits and the available training record.",
  premises: [
    {
      id: "confirmed-limits",
      label: "Confirmed Plan limits",
      source: "Your confirmed answers",
      value: { kind: "weekly-duration", hours: 1.5 },
    },
  ],
};
const build: PreviewPlanChangeInput["build"] = () => ({
  afterSnapshotJson: JSON.stringify(after),
  envelope,
});

describe("Plan Change repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: ReturnType<typeof createPlanChangeRepository>;
  let sequence: number;
  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    sequence = 100;
    repository = createPlanChangeRepository(store, { newId: () => id(String(++sequence)), sha256 });
  });
  afterEach(async () => store.close());

  const activate = async (pinned = false) => {
    const removed = pinned ? { ...removedWorkout, pinned: true } : removedWorkout;
    const snapshot = {
      ...draft,
      weeks: [{ ...draft.weeks[0], workouts: [keptWorkout, removed, poolWorkout] }],
    };
    const creation = createPlanCreationRepository(store);
    await creation.start({
      command: stamp("start", 1),
      creationId: id("1"),
      seed: { schemaVersion: 1, eventCandidates: [] },
    });
    await creation.recordDraft({
      command: stamp("draft", 2),
      creationId: id("1"),
      expectedVersion: 1,
      draftId: id("2"),
      inputSnapshotJson: "{}",
      inputFingerprint: "e".repeat(64),
      outputSnapshotJson: JSON.stringify(snapshot),
      builderId: "cycling",
      builderVersion: "1",
      activationFingerprint: fingerprint,
    });
    const command = stamp("activate", 3);
    await creation.activate({
      command,
      incumbent: null,
      creationId: id("1"),
      expectedVersion: 2,
      activatedAt: "1998-01-01",
      todayDateKey: 19980101,
      mirrorJobId: id("4"),
      cleanupJobId: id("5"),
      revisionId: id("3"),
      materialize: () => ({
        plan: {
          id: planId,
          originId: null,
          name: "Improve fitness",
          primaryGoal: "Ride well",
          startDateKey: 19980101,
          targetDateKey: 19980107,
          status: "active",
          kind: "short_race_preparation",
          totalWeeks: 1,
          weekStartDay: 4,
          structureJson: "{}",
          createdAtMs: command.nowMs,
          updatedAtMs: command.nowMs,
          deviceId: command.deviceId,
          hlcPhysicalMs: command.hlcPhysicalMs,
          hlcCounter: command.hlcCounter,
        },
        workouts: [keptWorkout, removed].map((workout, index) => ({
          id: id(String(31 + index)),
          planId,
          dateKey: 19980101 + index,
          sport: "Ride",
          name: workout.name,
          durationS: workout.minutes * 60,
          structureJson: JSON.stringify(workout),
          origin: "coach",
          deviceId: command.deviceId,
          hlcPhysicalMs: command.hlcPhysicalMs,
          hlcCounter: command.hlcCounter,
        })),
      }),
    });
  };
  const previewInput = (offset = 10) => ({
    command: stamp(`preview-${offset}`, offset),
    planId,
    expectedVersion: 1,
    nowMs: nowMs + offset,
    changeId: id(String(80 + offset)),
    build,
  });
  const applyInput = (decision: "apply" | "cancel" = "apply") => ({
    command: stamp(decision, 30),
    planId,
    changeId: id("90"),
    expectedVersion: 1,
    decision,
    nowMs: nowMs + 30,
    todayDateKey: () => 19980102,
    mirrorJobId: id("6"),
    materialize: (
      snapshotJson: string,
      current: Parameters<Parameters<typeof repository.apply>[0]["materialize"]>[1],
    ) => {
      expect(JSON.parse(snapshotJson)).toEqual(after);
      const kept = current.find((row) => row.id === id("31"));
      if (kept === undefined) throw new Error("Expected kept Workout");
      return {
        insert: [
          {
            ...kept,
            id: id("33"),
            dateKey: 19980103,
            name: addedWorkout.name,
            durationS: 1800,
            structureJson: JSON.stringify(addedWorkout),
          },
        ],
        update: [],
        delete: [id("32")],
      };
    },
  });

  it.each(["delete", "update"] as const)(
    "rejects a %s after midnight and leaves the preview pending without any writes",
    async (operation) => {
      await activate();
      const changed = { ...removedWorkout, minutes: 30 };
      const next =
        operation === "delete"
          ? after
          : {
              ...draft,
              weeks: [{ ...draft.weeks[0], workouts: [keptWorkout, changed, poolWorkout] }],
            };
      await repository.preview({
        ...previewInput(),
        build: () => ({
          afterSnapshotJson: JSON.stringify(next),
          envelope: { ...envelope, diff: [] },
        }),
      });
      const before = await dumpStore(store);
      const materialize = vi.fn(applyInput().materialize);
      await expect(
        repository.apply({
          ...applyInput(),
          todayDateKey: () => 19980103,
          materialize,
        }),
      ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
      expect(materialize).not.toHaveBeenCalled();
      expect(await dumpStore(store)).toBe(before);
      expect(await store.get("SELECT id FROM plan_workout WHERE id=?", [id("32")])).toEqual({
        id: id("32"),
      });
      await expect(repository.listChanges(planId)).resolves.toMatchObject([
        { status: "pending", resultRevisionNumber: null },
      ]);
    },
  );

  it("rejects changes to a pinned Workout in the saved revision", async () => {
    await activate(true);
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(repository.apply(applyInput())).resolves.toEqual({
      status: "rejected",
      reason: "stale-version",
    });
    expect(await dumpStore(store)).toBe(before);
    await expect(repository.listChanges(planId)).resolves.toMatchObject([{ status: "pending" }]);
  });

  it("previews the current revision without changing training or Plan version", async () => {
    await activate();
    const workouts = await store.all("SELECT * FROM plan_workout");
    const revisions = await store.all("SELECT * FROM plan_revision");
    const builder = vi.fn(build);
    const result = await repository.preview({ ...previewInput(), build: builder });
    expect(builder).toHaveBeenCalledTimes(1);
    expect(builder).toHaveBeenCalledWith({
      completedWorkoutIds: new Set(),
      currentRevisionNumber: 1,
      snapshotJson: JSON.stringify(draft),
      previousSnapshotJson: null,
      newestApplied: null,
    });
    expect(result).toMatchObject({
      status: "previewed",
      version: 1,
      change: {
        changeId: id("90"),
        planId,
        baseRevisionNumber: 1,
        status: "pending",
        title: envelope.title,
        intent: envelope.intent,
        diff: envelope.diff,
        totals: envelope.totals,
        supersedes: null,
        resultRevisionNumber: null,
      },
    });
    expect(await store.get("SELECT status,version,base_revision_number FROM plan_change")).toEqual({
      status: "preview",
      version: 1,
      base_revision_number: 1,
    });
    expect(await store.get("SELECT diff_json FROM plan_change")).toEqual({
      diff_json: canonicalJson(envelope),
    });
    expect(await store.get("SELECT version,current_revision_number FROM planning_plan")).toEqual({
      version: 1,
      current_revision_number: 1,
    });
    expect(await store.all("SELECT * FROM plan_workout")).toEqual(workouts);
    expect(await store.all("SELECT * FROM plan_revision")).toEqual(revisions);
    expect(
      await store.get(
        "SELECT command_name,aggregate_refs_json FROM planning_command WHERE command_id='preview-10'",
      ),
    ).toMatchObject({ command_name: "plan_change.preview" });
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "pending" },
    ]);
    await expect(repository.listChanges(id("88"))).resolves.toEqual([]);
  });

  it("supersedes the previous preview and lists history oldest first with pending last", async () => {
    await activate();
    await repository.preview(previewInput());
    const original = await store.get("SELECT diff_json FROM plan_change WHERE id=?", [id("90")]);
    const result = await repository.preview(previewInput(20));
    expect(result).toMatchObject({ status: "previewed", change: { supersedes: id("90") } });
    expect(
      await store.all("SELECT id,status,version FROM plan_change ORDER BY created_at_ms"),
    ).toEqual([
      { id: id("90"), status: "discarded", version: 2 },
      { id: id("100"), status: "preview", version: 1 },
    ]);
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "superseded", supersededBy: id("100") },
      { changeId: id("100"), status: "pending", supersedes: id("90") },
    ]);
    expect(await store.get("SELECT diff_json FROM plan_change WHERE id=?", [id("90")])).toEqual(
      original,
    );
    await repository.apply({ ...applyInput("cancel"), changeId: id("100") });
    const reopened = createPlanChangeRepository(store, { newId: () => id("200"), sha256 });
    await expect(reopened.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "superseded", supersededBy: id("100") },
      { changeId: id("100"), status: "cancelled", supersedes: id("90"), supersededBy: null },
    ]);
  });

  it("rejects missing active Plans and stale versions before building", async () => {
    const builder = vi.fn(build);
    await expect(repository.preview({ ...previewInput(), build: builder })).resolves.toEqual({
      status: "rejected",
      reason: "no-active-plan",
    });
    await activate();
    const before = await dumpStore(store);
    for (const input of [
      { ...previewInput(), expectedVersion: 2 },
      { ...previewInput(), planId: id("88") },
    ]) {
      await expect(repository.preview({ ...input, build: builder })).resolves.toEqual({
        status: "rejected",
        reason: "stale-version",
      });
    }
    expect(builder).not.toHaveBeenCalled();
    expect(await dumpStore(store)).toBe(before);
  });

  it("rejects invalid intent without retiring a pending preview", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(
      repository.preview({
        ...previewInput(20),
        build: () => ({ status: "rejected", reason: "invalid-intent" }),
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid-intent" });
    expect(await dumpStore(store)).toBe(before);
  });

  it("replays preview byte-identically after supersession and rejects command conflicts", async () => {
    await activate();
    const result = await repository.preview(previewInput());
    await repository.preview(previewInput(20));
    const before = await dumpStore(store);
    const builder = vi.fn(build);
    expect(JSON.stringify(await repository.preview({ ...previewInput(), build: builder }))).toBe(
      JSON.stringify(result),
    );
    expect(builder).not.toHaveBeenCalled();
    await expect(
      repository.preview({
        ...previewInput(),
        command: { ...previewInput().command, requestDigest: "b".repeat(64) },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "command-conflict" });
    expect(await dumpStore(store)).toBe(before);
  });

  it("applies undated Workout changes only to the revision and Plan version", async () => {
    await activate();
    const changed = { ...poolWorkout, minutes: 20, kind: "endurance" };
    const next = {
      ...draft,
      weeks: [{ ...draft.weeks[0], workouts: [keptWorkout, removedWorkout, changed] }],
    };
    await repository.preview({
      ...previewInput(),
      build: () => ({
        afterSnapshotJson: JSON.stringify(next),
        envelope: {
          ...envelope,
          diff: [{ workoutId: poolWorkout.id, before: poolWorkout, after: changed }],
        },
      }),
    });
    const rows = await store.all("SELECT * FROM plan_workout ORDER BY id");
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      await store.exec(`CREATE TRIGGER reject_workout_${operation.toLowerCase()}
        BEFORE ${operation} ON plan_workout
        BEGIN SELECT RAISE(ABORT, 'Unexpected Workout row write'); END`);
    }
    const materialize = vi.fn(() => ({ insert: [], update: [], delete: [] }));
    await expect(repository.apply({ ...applyInput(), materialize })).resolves.toMatchObject({
      status: "applied",
      revisionNumber: 2,
      version: 2,
    });
    expect(materialize).toHaveBeenCalledWith(expect.any(String), expect.any(Array), new Set());
    expect(await store.all("SELECT * FROM plan_workout ORDER BY id")).toEqual(rows);
    expect(await store.get("SELECT version,current_revision_number FROM planning_plan")).toEqual({
      version: 2,
      current_revision_number: 2,
    });
    expect(
      await store.get("SELECT snapshot_json FROM plan_revision WHERE revision_number=2"),
    ).toEqual({ snapshot_json: canonicalJson(next) });
  });

  it.each(["undated-to-dated", "dated-to-undated"])(
    "refuses %s Workout changes without writes",
    async (direction) => {
      await activate();
      const next = structuredClone(draft);
      const workout = next.weeks[0].workouts.find((candidate) =>
        direction === "undated-to-dated" ? candidate.id === "pool" : candidate.id === "removed",
      );
      if (workout === undefined) throw new Error("Expected Workout");
      workout.date = direction === "undated-to-dated" ? "1998-01-03" : null;
      await repository.preview({
        ...previewInput(),
        build: () => ({
          afterSnapshotJson: JSON.stringify(next),
          envelope: { ...envelope, diff: [] },
        }),
      });
      const before = await dumpStore(store);
      const materialize = vi.fn(() => ({ insert: [], update: [], delete: [] }));
      await expect(repository.apply({ ...applyInput(), materialize })).resolves.toEqual({
        status: "rejected",
        reason: "stale-version",
      });
      expect(materialize).not.toHaveBeenCalled();
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("applies one new revision and atomically preserves, adds and removes Workout rows", async () => {
    await activate();
    await repository.preview(previewInput());
    const oldRow = await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")]);
    await expect(repository.apply(applyInput())).resolves.toEqual({
      status: "applied",
      changeId: id("90"),
      revisionNumber: 2,
      version: 2,
    });
    expect(await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")])).toEqual(oldRow);
    expect(await store.all("SELECT id FROM plan_workout ORDER BY id")).toEqual([
      { id: id("31") },
      { id: id("33") },
    ]);
    expect(
      await store.get("SELECT status,result_revision_number,version FROM plan_change"),
    ).toEqual({ status: "applied", result_revision_number: 2, version: 2 });
    expect(await store.get("SELECT version,current_revision_number FROM planning_plan")).toEqual({
      version: 2,
      current_revision_number: 2,
    });
    const revision = await store.get(
      "SELECT revision_number,parent_revision_number,source_kind,source_id,fingerprint FROM plan_revision WHERE revision_number=2",
    );
    const change = await store.get("SELECT preview_fingerprint FROM plan_change");
    expect(change?.preview_fingerprint).toBe(sha256(canonicalJson(after)));
    expect(revision).toEqual({
      revision_number: 2,
      parent_revision_number: 1,
      source_kind: "plan-change",
      source_id: id("90"),
      fingerprint: change?.preview_fingerprint,
    });
    expect(await store.get("SELECT updated_at_ms FROM plan")).toEqual({
      updated_at_ms: nowMs + 30,
    });
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { status: "applied", resultRevisionNumber: 2 },
    ]);
    const builder = vi.fn(build);
    await repository.preview({ ...previewInput(40), expectedVersion: 2, build: builder });
    expect(builder).toHaveBeenCalledWith({
      completedWorkoutIds: new Set(),
      currentRevisionNumber: 2,
      snapshotJson: canonicalJson(after),
      previousSnapshotJson: JSON.stringify(draft),
      newestApplied: expect.objectContaining({
        changeId: id("90"),
        status: "applied",
        baseRevisionNumber: 1,
        resultRevisionNumber: 2,
      }),
    });
  });

  it("restores removed Workouts with their Draft ids in a new revision", async () => {
    await activate();
    await repository.preview(previewInput());
    await repository.apply(applyInput());
    const restoredPreview = await repository.preview({
      ...previewInput(40),
      expectedVersion: 2,
      build: ({ snapshotJson, previousSnapshotJson, newestApplied }) => {
        expect(JSON.parse(snapshotJson)).toEqual(after);
        expect(previousSnapshotJson).toBe(JSON.stringify(draft));
        expect(newestApplied?.changeId).toBe(id("90"));
        if (previousSnapshotJson === null) throw new Error("Expected previous snapshot");
        return {
          afterSnapshotJson: previousSnapshotJson,
          envelope: {
            ...envelope,
            title: "Undo the latest Change",
            intent: { kind: "inverse", changeId: id("90") },
            diff: envelope.diff.map((row) => ({
              workoutId: row.workoutId,
              before: row.after,
              after: row.before,
            })),
            totals: { before: envelope.totals.after, after: envelope.totals.before },
          },
        };
      },
    });
    expect(restoredPreview).toMatchObject({
      status: "previewed",
      change: {
        changeId: id("120"),
        baseRevisionNumber: 2,
        diff: expect.arrayContaining([
          { workoutId: "removed", before: null, after: removedWorkout },
        ]),
      },
    });
    const materialize: Parameters<typeof repository.apply>[0]["materialize"] = (
      snapshotJson,
      current,
      diffIds,
    ) => {
      expect(JSON.parse(snapshotJson)).toEqual(draft);
      expect(diffIds).toEqual(new Set(["removed", "added"]));
      const kept = current.find((row) => row.id === id("31"));
      if (kept === undefined) throw new Error("Expected kept Workout");
      return {
        insert: [
          {
            ...kept,
            id: id("34"),
            dateKey: 19980102,
            name: removedWorkout.name,
            durationS: removedWorkout.minutes * 60,
            structureJson: JSON.stringify(removedWorkout),
          },
        ],
        update: [],
        delete: [id("33")],
      };
    };
    const input = {
      ...applyInput(),
      command: stamp("restore", 50),
      changeId: id("120"),
      expectedVersion: 2,
      nowMs: nowMs + 50,
      materialize,
    };
    const result = await repository.apply(input);
    expect(result).toEqual({
      status: "applied",
      changeId: id("120"),
      revisionNumber: 3,
      version: 3,
    });
    expect(await store.all("SELECT id,structure_json FROM plan_workout ORDER BY id")).toEqual([
      { id: id("31"), structure_json: JSON.stringify(keptWorkout) },
      { id: id("34"), structure_json: JSON.stringify(removedWorkout) },
    ]);
    expect(
      await store.get(
        "SELECT snapshot_json,parent_revision_number,source_kind,source_id FROM plan_revision WHERE revision_number=3",
      ),
    ).toEqual({
      snapshot_json: canonicalJson(draft),
      parent_revision_number: 2,
      source_kind: "plan-change",
      source_id: id("120"),
    });
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "applied", resultRevisionNumber: 2 },
      { changeId: id("120"), status: "applied", resultRevisionNumber: 3 },
    ]);
    const beforeReplay = await dumpStore(store);
    await expect(repository.apply(input)).resolves.toEqual(result);
    expect(await dumpStore(store)).toBe(beforeReplay);
    await expect(repository.readUndoContext(planId)).resolves.toMatchObject({
      currentRevisionNumber: 3,
      snapshotJson: canonicalJson(draft),
      previousSnapshotJson: canonicalJson(after),
      newestApplied: { changeId: id("120"), intent: { kind: "inverse", changeId: id("90") } },
    });
  });

  it("reads the newest applied revision despite cancelled and superseded previews", async () => {
    await expect(repository.readUndoContext(planId)).resolves.toBeNull();
    await activate();
    await expect(repository.readUndoContext(id("88"))).resolves.toBeNull();
    await expect(repository.readUndoContext(planId)).resolves.toEqual({
      currentRevisionNumber: 1,
      snapshotJson: JSON.stringify(draft),
      previousSnapshotJson: null,
      newestApplied: null,
    });
    await repository.preview(previewInput());
    await repository.apply(applyInput());
    const applied = await repository.readUndoContext(planId);
    await repository.preview({ ...previewInput(40), expectedVersion: 2 });
    await repository.preview({ ...previewInput(50), expectedVersion: 2 });
    await repository.apply({
      ...applyInput("cancel"),
      command: stamp("cancel-later", 55),
      nowMs: nowMs + 55,
      changeId: id("130"),
      expectedVersion: 2,
    });
    await expect(repository.readUndoContext(planId)).resolves.toEqual(applied);
    const builder = vi.fn(build);
    await repository.preview({ ...previewInput(60), expectedVersion: 2, build: builder });
    expect(builder).toHaveBeenCalledWith({
      completedWorkoutIds: new Set(),
      currentRevisionNumber: 2,
      snapshotJson: canonicalJson(after),
      previousSnapshotJson: JSON.stringify(draft),
      newestApplied: expect.objectContaining({ changeId: id("90"), resultRevisionNumber: 2 }),
    });
  });

  it("enqueues a pending mirror job for a fresh seven-day window on apply", async () => {
    await activate();
    await repository.preview(previewInput());
    const jobs = await store.all("SELECT * FROM plan_reconciliation_job ORDER BY id");
    await expect(repository.apply(applyInput())).resolves.toMatchObject({ status: "applied" });
    expect(
      await store.all("SELECT * FROM plan_reconciliation_job WHERE id<>? ORDER BY id", [id("6")]),
    ).toEqual(jobs);
    expect(await store.get("SELECT * FROM plan_reconciliation_job WHERE id=?", [id("6")])).toEqual({
      id: id("6"),
      plan_id: planId,
      kind: "mirror",
      status: "pending",
      window_start_date_key: 19980102,
      window_end_date_key: 19980108,
      attempt_count: 0,
      failure_count: 0,
      resumed_count: 0,
      last_resumed_attempt: null,
      last_error_code: null,
      created_at_ms: nowMs + 30,
      updated_at_ms: nowMs + 30,
      completed_at_ms: null,
    });
  });

  it("reopens a verified same-window mirror while preserving counters and retained items", async () => {
    await activate();
    const reconciliation = createPlanReconciliationRepository(store);
    await reconciliation.prepareItem({
      id: id("7"),
      jobId: id("4"),
      planWorkoutId: id("31"),
      operation: "create",
      dateKey: 19980101,
      externalId: `cycling-coach:plan:${planId}:${id("31")}`,
      expectedJson: JSON.stringify(keptWorkout),
      createdAtMs: nowMs + 4,
    });
    await reconciliation.beginAttempt(id("4"), nowMs + 5);
    await reconciliation.failJob(id("4"), "calendar-list-failed", nowMs + 6);
    await reconciliation.beginAttempt(id("4"), nowMs + 7);
    await reconciliation.beginAttempt(id("4"), nowMs + 8);
    await reconciliation.startItem(id("7"), nowMs + 9);
    await reconciliation.verifyItem(id("7"), 42, nowMs + 10);
    const verified = await reconciliation.verifyJob(id("4"), nowMs + 11);
    const items = await reconciliation.readItems(id("4"));
    await repository.preview(previewInput(12));
    await expect(
      repository.apply({ ...applyInput(), changeId: id("92"), todayDateKey: () => 19980101 }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(await reconciliation.readJob(id("4"))).toEqual({
      ...verified,
      status: "pending",
      lastErrorCode: null,
      completedAtMs: null,
      updatedAtMs: nowMs + 30,
    });
    expect(await reconciliation.readItems(id("4"))).toEqual(items);
    expect(await store.all("SELECT id FROM plan_reconciliation_job")).toEqual([{ id: id("4") }]);
  });

  it("clears delete items when a Workout moves outside and back inside the reopened window", async () => {
    await activate();
    await store.run("UPDATE plan SET total_weeks=2,target_date_key=19980114 WHERE id=?", [planId]);
    const reconciliation = createPlanReconciliationRepository(store);
    const movedWorkout = { ...removedWorkout, date: "1998-01-09" };
    const movedSnapshot = {
      ...draft,
      weeks: [{ number: 1, minutes: 180, workouts: [keptWorkout, movedWorkout, poolWorkout] }],
    };
    const retainedCreate = await reconciliation.prepareItem({
      id: id("7"),
      jobId: id("4"),
      planWorkoutId: id("31"),
      operation: "create",
      dateKey: 19980101,
      externalId: `cycling-coach:plan:${planId}:${id("31")}`,
      expectedJson: JSON.stringify(keptWorkout),
      createdAtMs: nowMs + 4,
    });
    const movedCreate = await reconciliation.prepareItem({
      ...retainedCreate,
      id: id("8"),
      planWorkoutId: id("32"),
      dateKey: 19980102,
      externalId: `cycling-coach:plan:${planId}:${id("32")}`,
      expectedJson: JSON.stringify(removedWorkout),
    });
    const retainedDelete = await reconciliation.prepareItem({
      ...retainedCreate,
      id: id("9"),
      planWorkoutId: null,
      operation: "delete",
      externalId: "synthetic-old-event",
    });
    await reconciliation.createOrGetJob({
      id: id("10"),
      planId,
      kind: "mirror",
      windowStartDateKey: 19971231,
      windowEndDateKey: 19980106,
      createdAtMs: nowMs + 4,
    });
    const otherWindowCreate = await reconciliation.prepareItem({
      ...movedCreate,
      id: id("12"),
      jobId: id("10"),
    });
    await reconciliation.beginAttempt(id("4"), nowMs + 5);
    await reconciliation.verifyItem(retainedCreate.id, 41, nowMs + 6);
    await reconciliation.verifyItem(movedCreate.id, 42, nowMs + 6);
    await reconciliation.verifyItem(retainedDelete.id, null, nowMs + 6);
    await reconciliation.verifyJob(id("4"), nowMs + 7);
    const retainedItems = (await reconciliation.readItems(id("4"))).filter(
      (item) => item.id === retainedCreate.id,
    );
    await repository.preview({
      ...previewInput(),
      build: () => ({
        afterSnapshotJson: JSON.stringify(movedSnapshot),
        envelope: {
          ...envelope,
          diff: [{ workoutId: "removed", before: removedWorkout, after: movedWorkout }],
          totals: { before: envelope.totals.before, after: envelope.totals.before },
        },
      }),
    });
    await expect(
      repository.apply({
        ...applyInput(),
        todayDateKey: () => 19980101,
        materialize: (_snapshotJson, current) => {
          const moved = current.find((workout) => workout.id === id("32"));
          if (moved === undefined) throw new Error("Expected moved Workout");
          return {
            insert: [],
            delete: [],
            update: [{ ...moved, dateKey: 19980109, structureJson: JSON.stringify(movedWorkout) }],
          };
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(await reconciliation.readItems(id("4"))).toEqual(retainedItems);
    expect(await reconciliation.readItems(id("10"))).toEqual([otherWindowCreate]);
    expect(await reconciliation.readJob(id("4"))).toMatchObject({ status: "pending" });
    expect(await store.get("SELECT date_key FROM plan_workout WHERE id=?", [id("32")])).toEqual({
      date_key: 19980109,
    });
    await reconciliation.prepareItem({
      ...movedCreate,
      id: id("13"),
      operation: "delete",
      planWorkoutId: null,
      createdAtMs: nowMs + 31,
    });
    await repository.preview({
      ...previewInput(40),
      expectedVersion: 2,
      build: () => ({
        afterSnapshotJson: JSON.stringify(draft),
        envelope: {
          ...envelope,
          diff: [{ workoutId: "removed", before: movedWorkout, after: removedWorkout }],
          totals: { before: envelope.totals.before, after: envelope.totals.before },
        },
      }),
    });
    await expect(
      repository.apply({
        ...applyInput(),
        command: stamp("restore", 50),
        changeId: id("120"),
        expectedVersion: 2,
        nowMs: nowMs + 50,
        todayDateKey: () => 19980101,
        materialize: (_snapshotJson, current) => {
          const moved = current.find((workout) => workout.id === id("32"));
          if (moved === undefined) throw new Error("Expected moved Workout");
          return {
            insert: [],
            delete: [],
            update: [
              { ...moved, dateKey: 19980102, structureJson: JSON.stringify(removedWorkout) },
            ],
          };
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(await reconciliation.readItems(id("4"))).toEqual(retainedItems);
    expect(retainedItems).toHaveLength(1);
    expect(retainedItems[0]?.operation).toBe("create");
    expect(await reconciliation.readItems(id("10"))).toEqual([otherWindowCreate]);
    expect(await store.get("SELECT date_key FROM plan_workout WHERE id=?", [id("32")])).toEqual({
      date_key: 19980102,
    });
  });

  it("preserves an unchanged Workout's full row after an athlete edit", async () => {
    await activate();
    await repository.preview(previewInput());
    await store.run(
      "UPDATE plan_workout SET name=?,duration_s=?,structure_json=?,origin=?,hlc_counter=? WHERE id=?",
      [
        "Athlete's ride",
        4500,
        JSON.stringify({ ...keptWorkout, minutes: 75 }),
        "athlete",
        7,
        id("31"),
      ],
    );
    const before = await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")]);
    await expect(repository.apply(applyInput())).resolves.toMatchObject({ status: "applied" });
    expect(await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")])).toEqual(before);
  });

  it.each(
    (["changed", "removed"] as const).flatMap((operation) =>
      (["structure", "name", "duration", "name-and-duration", "date"] as const).map((field) => ({
        operation,
        field,
      })),
    ),
  )(
    "rejects $field drift on a $operation Draft Workout before materialization without any writes",
    async ({ operation, field }) => {
      await activate();
      const changedWorkout = { ...removedWorkout, minutes: 90 };
      await repository.preview({
        ...previewInput(),
        build: () => ({
          afterSnapshotJson: JSON.stringify(
            operation === "removed"
              ? after
              : {
                  ...draft,
                  weeks: [
                    { ...draft.weeks[0], workouts: [keptWorkout, changedWorkout, poolWorkout] },
                  ],
                },
          ),
          envelope:
            operation === "removed"
              ? envelope
              : {
                  ...envelope,
                  diff: [
                    { workoutId: removedWorkout.id, before: removedWorkout, after: changedWorkout },
                  ],
                },
        }),
      });
      const edits = {
        structure: {
          sql: "UPDATE plan_workout SET structure_json=? WHERE id=?",
          values: [JSON.stringify({ ...removedWorkout, minutes: 100 }), id("32")],
        },
        name: {
          sql: "UPDATE plan_workout SET name=? WHERE id=?",
          values: ["Athlete accepted edit", id("32")],
        },
        duration: {
          sql: "UPDATE plan_workout SET duration_s=? WHERE id=?",
          values: [5400, id("32")],
        },
        "name-and-duration": {
          sql: "UPDATE plan_workout SET name=?,duration_s=? WHERE id=?",
          values: ["Athlete accepted edit", 5400, id("32")],
        },
        date: {
          sql: "UPDATE plan_workout SET date_key=? WHERE id=?",
          values: [19980103, id("32")],
        },
      };
      await store.run(edits[field].sql, edits[field].values);
      const before = await dumpStore(store);
      const materialize = vi.fn(applyInput().materialize);
      await expect(repository.apply({ ...applyInput(), materialize })).resolves.toEqual({
        status: "rejected",
        reason: "stale-version",
      });
      expect(materialize).not.toHaveBeenCalled();
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("rejects a host mutation outside the Change diff without writes", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    const input = applyInput();
    await expect(
      repository.apply({
        ...input,
        materialize: (snapshotJson, current) => ({
          ...input.materialize(snapshotJson, current),
          update: current.filter((row) => row.id === id("31")),
        }),
      }),
    ).rejects.toThrow();
    expect(await dumpStore(store)).toBe(before);
  });

  it.each(["apply", "cancel"] as const)(
    "replays %s without invoking materialization again",
    async (decision) => {
      await activate();
      await repository.preview(previewInput());
      const input = applyInput(decision);
      const result = await repository.apply(input);
      const before = await dumpStore(store);
      const jobs = await store.all("SELECT * FROM plan_reconciliation_job ORDER BY id");
      const materialize = vi.fn(input.materialize);
      expect(
        JSON.stringify(
          await repository.apply({
            ...input,
            mirrorJobId: id("8"),
            todayDateKey: () => 19980103,
            materialize,
          }),
        ),
      ).toBe(JSON.stringify(result));
      expect(materialize).not.toHaveBeenCalled();
      expect(await store.all("SELECT * FROM plan_reconciliation_job ORDER BY id")).toEqual(jobs);
      await expect(
        repository.apply({
          ...input,
          command: { ...input.command, requestDigest: "b".repeat(64) },
        }),
      ).resolves.toEqual({ status: "rejected", reason: "command-conflict" });
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("cancels without changing training or revision and rejects a later apply", async () => {
    await activate();
    await repository.preview(previewInput());
    const original = await store.get("SELECT diff_json FROM plan_change");
    const workouts = await store.all("SELECT * FROM plan_workout");
    const revisions = await store.all("SELECT * FROM plan_revision");
    const plan = await store.all("SELECT * FROM planning_plan");
    const jobs = await store.all("SELECT * FROM plan_reconciliation_job ORDER BY id");
    const materialize = vi.fn(applyInput().materialize);
    await expect(repository.apply({ ...applyInput("cancel"), materialize })).resolves.toEqual({
      status: "cancelled",
      changeId: id("90"),
      version: 1,
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(await store.all("SELECT * FROM plan_workout")).toEqual(workouts);
    expect(await store.all("SELECT * FROM plan_revision")).toEqual(revisions);
    expect(await store.all("SELECT * FROM planning_plan")).toEqual(plan);
    expect(await store.all("SELECT * FROM plan_reconciliation_job ORDER BY id")).toEqual(jobs);
    expect(await store.get("SELECT diff_json FROM plan_change")).toEqual(original);
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { status: "cancelled", resultRevisionNumber: null, supersededBy: null },
    ]);
    await expect(repository.apply(applyInput())).resolves.toEqual({
      status: "rejected",
      reason: "not-pending",
    });
  });

  it("rejects apply with no active Plan, stale version or a missing Change", async () => {
    await expect(repository.apply(applyInput())).resolves.toEqual({
      status: "rejected",
      reason: "no-active-plan",
    });
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(repository.apply({ ...applyInput(), expectedVersion: 2 })).resolves.toEqual({
      status: "rejected",
      reason: "stale-version",
    });
    await expect(repository.apply({ ...applyInput(), planId: id("88") })).resolves.toEqual({
      status: "rejected",
      reason: "stale-version",
    });
    await expect(repository.apply({ ...applyInput(), changeId: id("88") })).resolves.toEqual({
      status: "rejected",
      reason: "not-pending",
    });
    expect(await dumpStore(store)).toBe(before);
  });

  it.each(["preview", "apply", "cancel"] as const)(
    "rolls back every %s write if recording the command fails",
    async (operation) => {
      await activate();
      await repository.preview(previewInput());
      await store.exec(
        `CREATE TRIGGER fail_change_ledger BEFORE INSERT ON planning_command WHEN NEW.command_name LIKE 'plan_change.%' BEGIN SELECT RAISE(ABORT,'Synthetic ledger failure'); END;`,
      );
      const before = await dumpStore(store);
      await expect(
        operation === "preview"
          ? repository.preview(previewInput(20))
          : repository.apply(applyInput(operation)),
      ).rejects.toThrow("Synthetic ledger failure");
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("rolls back revision and trigger changes when materialization fails", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(
      repository.apply({
        ...applyInput(),
        materialize: () => {
          throw new Error("Synthetic materialization failure");
        },
      }),
    ).rejects.toThrow("Synthetic materialization failure");
    expect(await dumpStore(store)).toBe(before);
  });

  it("rejects re-keying an existing Draft Workout and rolls back the revision", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    const input = applyInput();
    await expect(
      repository.apply({
        ...input,
        materialize: (snapshotJson, current) => {
          const changes = input.materialize(snapshotJson, current);
          const kept = current.find((row) => row.id === id("31"));
          if (kept === undefined) throw new Error("Expected kept Workout");
          return {
            insert: [...changes.insert, { ...kept, id: id("34") }],
            update: [],
            delete: [...changes.delete, kept.id],
          };
        },
      }),
    ).rejects.toThrow();
    expect(await dumpStore(store)).toBe(before);
  });

  it("rejects materialization that omits a dated Draft Workout", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(
      repository.apply({
        ...applyInput(),
        materialize: () => ({ insert: [], update: [], delete: [id("32")] }),
      }),
    ).rejects.toThrow();
    expect(await dumpStore(store)).toBe(before);
  });

  it("stales the pending preview when the Plan closes and keeps replay available", async () => {
    await activate();
    const result = await repository.preview(previewInput());
    const lifecycle = createPlanLifecycleRepository(store, { newId: () => id("200") });
    await lifecycle.close({
      command: stamp("close", 40),
      planId,
      expectedVersion: 1,
      closedAtMs: nowMs + 40,
      todayDateKey: 19980103,
      cleanupJobId: id("201"),
    });
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "stale" },
    ]);
    await expect(
      repository.apply({ ...applyInput(), command: stamp("apply-closed", 50), nowMs: nowMs + 50 }),
    ).resolves.toEqual({ status: "rejected", reason: "no-active-plan" });
    await expect(repository.preview(previewInput())).resolves.toEqual(result);
  });
});
