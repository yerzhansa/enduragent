import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  PlanReconciliationValidationError,
  createPlanReconciliationRepository,
  type PlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLAN_ID = "01K00000000000000000000001";
const WORKOUT_ID = "01K00000000000000000000002";
const JOB_ID = "01K00000000000000000000003";
const ITEM_ID = "01K00000000000000000000004";

async function seedPlan(store: SqlStore): Promise<void> {
  await store.run(
    `INSERT INTO plan (
      id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
      week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      PLAN_ID,
      null,
      "Synthetic Plan",
      "Synthetic goal",
      19980824,
      19981115,
      "active",
      "short_race_preparation",
      12,
      1,
      "{}",
      1,
      1,
      "device",
      1,
      0,
    ],
  );
  await store.run(
    `INSERT INTO planning_plan (
      plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,
      device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?,'active',1,1,1,1,'device',1,0)`,
    [PLAN_ID],
  );
  await store.run(
    `INSERT INTO plan_workout (
      id,plan_id,date_key,sport,name,duration_s,structure_json,origin,device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [WORKOUT_ID, PLAN_ID, 19980825, "cycling", "Endurance", 3600, "{}", "coach", "device", 1, 0],
  );
}

function job() {
  return {
    id: JOB_ID,
    planId: PLAN_ID,
    kind: "mirror" as const,
    windowStartDateKey: 19980825,
    windowEndDateKey: 19980831,
    createdAtMs: 10,
  };
}

function item(expectedJson = "{}") {
  return {
    id: ITEM_ID,
    jobId: JOB_ID,
    planWorkoutId: WORKOUT_ID,
    operation: "create" as const,
    dateKey: 19980825,
    externalId: `cycling-coach:plan:${PLAN_ID}:${WORKOUT_ID}`,
    expectedJson,
    createdAtMs: 10,
  };
}

describe("Plan reconciliation repository", () => {
  let store: (SqlStore & MigratorStore) | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function fresh(): Promise<PlanReconciliationRepository> {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await seedPlan(store);
    return createPlanReconciliationRepository(store);
  }

  it("persists a pending job and every item before the first attempt", async () => {
    const repository = await fresh();
    const savedJob = await repository.createOrGetJob(job());
    const savedItem = await repository.prepareItem(item());
    expect(savedJob).toMatchObject({
      status: "pending",
      attemptCount: 0,
      failureCount: 0,
      resumedCount: 0,
      lastResumedAttempt: null,
    });
    expect(savedItem).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(await repository.readItems(JOB_ID)).toEqual([savedItem]);
  });

  it("reads the latest library jobs for three Plans and both kinds in one query", async () => {
    const repository = await fresh();
    if (store === undefined) throw new Error("missing store");
    const planIds = [PLAN_ID, "01K00000000000000000000009", "01K00000000000000000000010"];
    for (const planId of planIds.slice(1)) {
      await store.run(
        `INSERT INTO plan (
          id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
          week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
        ) SELECT ?,origin_id,name,primary_goal,start_date_key,target_date_key,'ended',kind,total_weeks,
          week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
          FROM plan WHERE id=?`,
        [planId, PLAN_ID],
      );
    }
    let sequence = 20;
    for (const planId of planIds) {
      for (const kind of ["mirror", "cleanup"] as const) {
        for (const window of [
          { windowStartDateKey: 19980825, windowEndDateKey: 19980831, createdAtMs: 100 },
          { windowStartDateKey: 19980826, windowEndDateKey: 19980901, createdAtMs: 20 },
          { windowStartDateKey: 19980826, windowEndDateKey: 19980902, createdAtMs: 10 },
        ]) {
          await repository.createOrGetJob({
            ...job(),
            ...window,
            id: `01K${String(sequence++).padStart(23, "0")}`,
            planId,
            kind,
          });
        }
      }
    }
    const expected = [];
    for (const planId of planIds) {
      for (const kind of ["cleanup", "mirror"] as const) {
        expected.push(await repository.readLatestJobByWindow(planId, kind));
      }
    }
    let queryCount = 0;
    const source = store;
    const counted = createPlanReconciliationRepository({
      exec: source.exec.bind(source),
      run: source.run.bind(source),
      all: async (...args) => {
        queryCount += 1;
        return source.all(...args);
      },
      get: async (...args) => {
        queryCount += 1;
        return source.get(...args);
      },
      close: source.close.bind(source),
      transaction: source.transaction.bind(source),
    });
    expect(await counted.readLatestJobsForLibrary()).toEqual(expected);
    expect(queryCount).toBe(1);
    expect(expected).toHaveLength(6);
  });

  it("lists runnable jobs across Plans by window, creation time, and identity", async () => {
    const repository = await fresh();
    if (store === undefined) throw new Error("missing store");
    const otherPlanId = "01K00000000000000000000009";
    await store.run(
      `INSERT INTO plan (
        id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
        week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
      ) SELECT ?,origin_id,name,primary_goal,start_date_key,target_date_key,'ended',kind,total_weeks,
        week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
        FROM plan WHERE id=?`,
      [otherPlanId, PLAN_ID],
    );
    const pendingId = "01K00000000000000000000010";
    const retryingId = "01K00000000000000000000011";
    const failedId = "01K00000000000000000000012";
    const staleId = "01K00000000000000000000013";
    const freshId = "01K00000000000000000000014";
    const exhaustedId = "01K00000000000000000000015";
    const verifiedId = "01K00000000000000000000016";
    for (const record of [
      { id: staleId, planId: PLAN_ID, windowStartDateKey: 19980827, createdAtMs: 10 },
      { id: failedId, planId: PLAN_ID, windowStartDateKey: 19980826, createdAtMs: 11 },
      { id: retryingId, planId: otherPlanId, windowStartDateKey: 19980826, createdAtMs: 11 },
      { id: pendingId, planId: PLAN_ID, windowStartDateKey: 19980826, createdAtMs: 10 },
      { id: freshId, planId: PLAN_ID, windowStartDateKey: 19980825, createdAtMs: 10 },
      { id: exhaustedId, planId: PLAN_ID, windowStartDateKey: 19980824, createdAtMs: 10 },
      { id: verifiedId, planId: otherPlanId, windowStartDateKey: 19980824, createdAtMs: 10 },
    ]) {
      await repository.createOrGetJob({
        ...job(),
        ...record,
        kind: record.planId === otherPlanId ? "cleanup" : "mirror",
        windowEndDateKey: record.createdAtMs === 11 ? 19980901 : 19980831,
      });
    }
    for (const id of [retryingId, failedId, exhaustedId]) {
      await repository.beginAttempt(id, 20);
      await repository.failJob(id, "calendar-list-failed", 21);
    }
    await repository.beginAttempt(retryingId, 99);
    await repository.beginAttempt(exhaustedId, 22);
    await repository.failJob(exhaustedId, "calendar-list-failed", 23);
    await repository.beginAttempt(staleId, 50);
    await repository.beginAttempt(freshId, 51);
    await repository.beginAttempt(verifiedId, 20);
    await repository.verifyJob(verifiedId, 21);
    const runnable = await repository.listRunnable({ nowMs: 100, leaseMs: 50, maxFailures: 2 });
    expect(runnable.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: pendingId, status: "pending" },
      { id: retryingId, status: "retrying" },
      { id: failedId, status: "failed" },
      { id: staleId, status: "running" },
    ]);
  });

  it("lists cleanup but excludes closed Chat and legacy Plan mirrors", async () => {
    const repository = await fresh();
    if (store === undefined) throw new Error("missing store");
    const legacyPlanId = "01K00000000000000000000009";
    await store.run(
      `INSERT INTO plan (
        id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
        week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
      ) SELECT ?,origin_id,name,primary_goal,start_date_key,target_date_key,'ended',kind,total_weeks,
        week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
        FROM plan WHERE id=?`,
      [legacyPlanId, PLAN_ID],
    );
    await store.run(
      `UPDATE planning_plan SET status='closed',version=version+1,closed_at_ms=2,updated_at_ms=2,
        close_reason='stopped',close_actor='device' WHERE plan_id=?`,
      [PLAN_ID],
    );
    const closedMirror = await repository.createOrGetJob(job());
    const legacyMirror = await repository.createOrGetJob({
      ...job(),
      id: "01K00000000000000000000010",
      planId: legacyPlanId,
    });
    const cleanup = await repository.createOrGetJob({
      ...job(),
      id: "01K00000000000000000000011",
      kind: "cleanup",
    });
    expect(closedMirror.status).toBe("pending");
    expect(legacyMirror.status).toBe("pending");
    expect(await repository.listRunnable({ nowMs: 100, leaseMs: 50, maxFailures: 5 })).toEqual([
      cleanup,
    ]);
  });

  it("claims a pending job and preserves a fresh lease until its exact expiry", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    const running = await repository.claim(JOB_ID, 20, 50);
    expect(running).toMatchObject({
      status: "running",
      attemptCount: 1,
      resumedCount: 0,
      lastResumedAttempt: null,
      updatedAtMs: 20,
    });
    expect(await repository.claim(JOB_ID, 69, 50)).toBeUndefined();
    expect(await repository.readJob(JOB_ID)).toEqual(running);
    expect(await repository.claim(JOB_ID, 70, 50)).toMatchObject({
      status: "running",
      attemptCount: 2,
      resumedCount: 1,
      lastResumedAttempt: 2,
      updatedAtMs: 70,
    });
    const verified = await repository.verifyJob(JOB_ID, 71);
    expect(await repository.claim(JOB_ID, 200, 50)).toBeUndefined();
    expect(await repository.readJob(JOB_ID)).toEqual(verified);
  });

  it("claims failed jobs as retries and resumes an interrupted retry", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.beginAttempt(JOB_ID, 20);
    await repository.failJob(JOB_ID, "calendar-list-failed", 21);
    expect(await repository.claim(JOB_ID, 22, 50)).toMatchObject({
      status: "retrying",
      attemptCount: 2,
      failureCount: 1,
      resumedCount: 0,
      lastResumedAttempt: null,
      lastErrorCode: null,
      completedAtMs: null,
      updatedAtMs: 22,
    });
    expect(await repository.claim(JOB_ID, 23, 50)).toBeUndefined();
    expect(await repository.claim(JOB_ID, 71, 50)).toBeUndefined();
    expect(await repository.claim(JOB_ID, 72, 50)).toMatchObject({
      status: "retrying",
      attemptCount: 3,
      failureCount: 1,
      resumedCount: 1,
      lastResumedAttempt: 3,
      updatedAtMs: 72,
    });
  });

  it("serializes concurrent claims so only one obtains a pending job", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    const claims = await Promise.all([
      repository.claim(JOB_ID, 20, 50),
      repository.claim(JOB_ID, 20, 50),
    ]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(await repository.readJob(JOB_ID)).toMatchObject({ attemptCount: 1, resumedCount: 0 });
  });

  it("reads the newest window even when an older window was updated later", async () => {
    const repository = await fresh();
    expect(await repository.readLatestJobByWindow(PLAN_ID, "mirror")).toBeUndefined();
    const older = await repository.createOrGetJob(job());
    const newer = await repository.createOrGetJob({
      ...job(),
      id: "01K00000000000000000000005",
      windowStartDateKey: 19980826,
      windowEndDateKey: 19980901,
    });
    const longest = await repository.createOrGetJob({
      ...job(),
      id: "01K00000000000000000000006",
      windowStartDateKey: 19980826,
      windowEndDateKey: 19980902,
    });
    await repository.createOrGetJob({
      ...job(),
      id: "01K00000000000000000000007",
      kind: "cleanup",
      windowStartDateKey: 19980827,
      windowEndDateKey: 19980903,
    });
    await repository.beginAttempt(newer.id, 20);
    await repository.beginAttempt(older.id, 30);
    expect(await repository.readLatestJobByWindow(PLAN_ID, "mirror")).toEqual(longest);
    expect(await repository.readLatestJob(PLAN_ID, "mirror")).toMatchObject({ id: older.id });
  });

  it("tracks first failure retry repeated failure and final verification", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await repository.beginAttempt(JOB_ID, 11);
    await repository.startItem(ITEM_ID, 12);
    await repository.failItem(ITEM_ID, "calendar-create-failed", 13);
    expect(await repository.failJob(JOB_ID, "calendar-create-failed", 14)).toMatchObject({
      status: "failed",
      attemptCount: 1,
      failureCount: 1,
    });
    await repository.beginAttempt(JOB_ID, 15);
    await repository.startItem(ITEM_ID, 16);
    await repository.failItem(ITEM_ID, "calendar-verification-failed", 17);
    expect(await repository.failJob(JOB_ID, "calendar-verification-failed", 18)).toMatchObject({
      status: "failed",
      attemptCount: 2,
      failureCount: 2,
    });
    await repository.beginAttempt(JOB_ID, 19);
    await repository.startItem(ITEM_ID, 20);
    expect(await repository.markItemCreated(ITEM_ID, 21)).toMatchObject({ status: "created" });
    await repository.verifyItem(ITEM_ID, 42, 22);
    expect(await repository.verifyJob(JOB_ID, 23)).toMatchObject({
      status: "verified",
      attemptCount: 3,
      completedAtMs: 23,
    });
  });

  it.each(["pending", "running", "retrying", "failed", "verified"] as const)(
    "reopens a %s job while preserving its counters and items",
    async (status) => {
      const repository = await fresh();
      await repository.createOrGetJob(job());
      if (status !== "pending") {
        await repository.beginAttempt(JOB_ID, 11);
        await repository.failJob(JOB_ID, "calendar-list-failed", 12);
        if (status !== "failed") {
          await repository.beginAttempt(JOB_ID, 13);
          await repository.beginAttempt(JOB_ID, 14);
          if (status === "running") {
            await repository.reopenJob(JOB_ID, 15);
            await repository.beginAttempt(JOB_ID, 16);
          }
          if (status === "verified") await repository.verifyJob(JOB_ID, 17);
        }
      }
      const before = await repository.readJob(JOB_ID);
      expect(before?.status).toBe(status);
      const savedItem = await repository.prepareItem(item());
      expect(await repository.reopenJob(JOB_ID, 20)).toEqual({
        ...before,
        status: "pending",
        lastErrorCode: null,
        completedAtMs: null,
        updatedAtMs: 20,
      });
      expect(await repository.readItems(JOB_ID)).toEqual([savedItem]);
    },
  );

  it("rejects invalid reopen input and missing jobs", async () => {
    const repository = await fresh();
    await expect(repository.reopenJob("invalid", 20)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
    await expect(repository.reopenJob(JOB_ID, -1)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
    await expect(repository.reopenJob(JOB_ID, 20)).rejects.toEqual(
      new PlanReconciliationValidationError("missing-job"),
    );
  });

  it("refuses to verify a job while any item is incomplete", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await repository.beginAttempt(JOB_ID, 11);
    await expect(repository.verifyJob(JOB_ID, 12)).rejects.toEqual(
      new PlanReconciliationValidationError("unverified-items"),
    );
  });

  it("rejects terminal job transitions before an attempt or after verification", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await expect(repository.failJob(JOB_ID, "calendar-list-failed", 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
    await expect(repository.verifyJob(JOB_ID, 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
    await repository.beginAttempt(JOB_ID, 12);
    await repository.verifyJob(JOB_ID, 13);
    await expect(repository.failJob(JOB_ID, "calendar-list-failed", 14)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-job"),
    );
  });

  it("requires provider identity only for verified creates", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await expect(repository.verifyItem(ITEM_ID, null, 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-item"),
    );
    const deleteItemId = "01K00000000000000000000005";
    await repository.prepareItem({
      ...item(),
      id: deleteItemId,
      planWorkoutId: null,
      operation: "delete",
      externalId: `${item().externalId}:delete`,
    });
    await expect(repository.verifyItem(deleteItemId, 42, 11)).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-item"),
    );
    await expect(repository.verifyItem(deleteItemId, null, 11)).resolves.toMatchObject({
      status: "verified",
      providerEventId: null,
    });
  });

  it("removes obsolete create items when a Plan workout is replaced", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await store!.run("DELETE FROM plan_workout WHERE id=?", [WORKOUT_ID]);
    await expect(repository.readItems(JOB_ID)).resolves.toEqual([]);
  });

  it("resets a verified item when its expected payload changes", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item('{"durationS":3600}'));
    await repository.verifyItem(ITEM_ID, 42, 11);
    const changed = await repository.prepareItem({
      ...item('{"durationS":1800}'),
      id: "01K00000000000000000000005",
      createdAtMs: 12,
    });
    expect(changed).toMatchObject({
      id: ITEM_ID,
      status: "pending",
      providerEventId: null,
      expectedJson: '{"durationS":1800}',
    });
  });

  it("marks an interrupted running job as resumed on the next attempt after relaunch", async () => {
    directory = await mkdtemp(join(tmpdir(), "plan-reconcile-"));
    const path = join(directory, "store.db");
    store = openSqliteStorage(path);
    await runMigrations(store, MIGRATIONS);
    await seedPlan(store);
    let repository = createPlanReconciliationRepository(store);
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    await repository.beginAttempt(JOB_ID, 11);
    await repository.startItem(ITEM_ID, 12);
    await store.close();
    store = openSqliteStorage(path);
    repository = createPlanReconciliationRepository(store);
    expect(await repository.beginAttempt(JOB_ID, 13)).toMatchObject({
      status: "running",
      attemptCount: 2,
      resumedCount: 1,
      lastResumedAttempt: 2,
    });
    expect(await repository.readItems(JOB_ID)).toMatchObject([{ status: "running" }]);
  });

  it("deletes a single item and leaves the job and its other items intact", async () => {
    const repository = await fresh();
    await repository.createOrGetJob(job());
    await repository.prepareItem(item());
    const second = await repository.prepareItem({
      ...item(),
      id: "01K00000000000000000000005",
      externalId: "cycling-coach:plan:second",
    });
    await repository.deleteItem(ITEM_ID);
    expect(await repository.readItems(JOB_ID)).toMatchObject([{ id: second.id }]);
    expect(await repository.readJob(JOB_ID)).toMatchObject({ status: "pending" });
    await expect(repository.deleteItem("nope")).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-item"),
    );
  });

  it("rejects invalid jobs and items before storage", async () => {
    const repository = await fresh();
    await expect(
      repository.createOrGetJob({ ...job(), windowEndDateKey: 19980824 }),
    ).rejects.toEqual(new PlanReconciliationValidationError("invalid-job"));
    await expect(
      repository.createOrGetJob({ ...job(), windowStartDateKey: 19980230 }),
    ).rejects.toEqual(new PlanReconciliationValidationError("invalid-job"));
    await repository.createOrGetJob(job());
    await expect(repository.prepareItem({ ...item(), externalId: "" })).rejects.toEqual(
      new PlanReconciliationValidationError("invalid-item"),
    );
  });
});
