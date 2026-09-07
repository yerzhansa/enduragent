import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanCreationRepository,
  createPlanRepository,
  createPlanLifecycleRepository,
  type PlanLifecycleRepository,
  type PlanCreationCommandStamp,
  type PlanCreationRepository,
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
const fingerprint = "f".repeat(64);
const stamp = (commandId: string, offset = 0): PlanCreationCommandStamp => ({
  commandId,
  requestDigest: "a".repeat(64),
  nowMs: nowMs + offset,
  deviceId: "test-device-1998",
  hlcPhysicalMs: nowMs + offset,
  hlcCounter: 0,
});
const datedWorkout = { name: "Endurance ride", date: "1998-01-01" };
const poolWorkout = { name: "Flexible ride", date: null };
const draft = {
  outputFingerprint: fingerprint,
  weeks: [{ workouts: [datedWorkout, poolWorkout] }, { workouts: [] }],
};

const activationInput = (key = "1") => {
  const command = stamp(`activate-${key}`, Number(key) * 10 + 2);
  const planId = id(`1${key}`);
  return {
    command,
    incumbent: null,
    creationId: id(key),
    expectedVersion: 2,
    activatedAt: "1998-01-01",
    todayDateKey: 19980101,
    mirrorJobId: id(`5${key}`),
    cleanupJobId: id(`6${key}`),
    revisionId: id(`2${key}`),
    materialize: () => ({
      plan: {
        id: planId,
        originId: null,
        name: "Improve fitness",
        primaryGoal: "Ride well",
        startDateKey: 19980101,
        targetDateKey: 19980114,
        status: "active" as const,
        kind: "short_race_preparation" as const,
        totalWeeks: 2,
        weekStartDay: 4,
        structureJson: JSON.stringify({ source: "plan-creation", creationId: id(key) }),
        createdAtMs: command.nowMs,
        updatedAtMs: command.nowMs,
        deviceId: command.deviceId,
        hlcPhysicalMs: command.hlcPhysicalMs,
        hlcCounter: command.hlcCounter,
      },
      workouts: [
        {
          id: id(`3${key}`),
          planId,
          dateKey: 19980101,
          sport: "Ride",
          name: datedWorkout.name,
          durationS: 3600,
          structureJson: JSON.stringify(datedWorkout),
          origin: "coach" as const,
          deviceId: command.deviceId,
          hlcPhysicalMs: command.hlcPhysicalMs,
          hlcCounter: command.hlcCounter,
        },
      ],
    }),
  } satisfies Parameters<PlanCreationRepository["activate"]>[0];
};

describe("Plan lifecycle repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: PlanCreationRepository;
  let lifecycle: PlanLifecycleRepository;
  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createPlanCreationRepository(store);
    lifecycle = createPlanLifecycleRepository(store, { newId: () => id("99") });
  });
  afterEach(async () => store.close());
  const start = (key = "1") =>
    repository.start({
      command: stamp(`start-${key}`, Number(key) * 10),
      creationId: id(key),
      seed: { schemaVersion: 1, eventCandidates: [] },
    });
  const review = async (key = "1", output = draft) => {
    await start(key);
    await repository.recordDraft({
      command: stamp(`preview-${key}`, Number(key) * 10 + 1),
      creationId: id(key),
      expectedVersion: 1,
      draftId: id(`4${key}`),
      inputSnapshotJson: "{}",
      inputFingerprint: "e".repeat(64),
      outputSnapshotJson: JSON.stringify(output),
      builderId: "cycling",
      builderVersion: "1",
      activationFingerprint: fingerprint,
    });
  };

  const closeInput = () => ({
    command: stamp("close-1", 50),
    planId: id("11"),
    expectedVersion: 1,
    closedAtMs: nowMs + 50,
    todayDateKey: 19980103,
    cleanupJobId: id("91"),
  });
  const activate = async () => {
    await review();
    await repository.activate(activationInput());
  };
  const preview = () =>
    store.run(
      `INSERT INTO plan_change (
    id,plan_id,status,version,base_revision_number,result_revision_number,
    diff_json,rationale,premises_json,preview_fingerprint,reconciliation_effect_json,
    created_at_ms,updated_at_ms,terminal_at_ms,device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?,?,'preview',1,1,NULL,'{}','Adjust training','[]',?,'{}',?,?,NULL,'test-device',?,3)`,
      [id("81"), id("11"), fingerprint, nowMs + 60, nowMs + 60, nowMs + 60],
    );

  it("lists the current Plan version before and after closure", async () => {
    await activate();
    const plans = createPlanRepository(store);
    const [active] = await plans.listPlans();
    expect(active).toMatchObject({ planId: id("11"), status: "active", version: 1 });
    if (active === undefined) throw new Error("Expected an active Plan");

    await expect(
      lifecycle.close({ ...closeInput(), expectedVersion: active.version }),
    ).resolves.toMatchObject({ status: "closed" });

    await expect(plans.listPlans()).resolves.toMatchObject([
      { planId: active.planId, status: "closed", version: active.version + 1 },
    ]);
  });

  it("closes offline, records cleanup intent and preserves every revision and Workout", async () => {
    await activate();
    const revisions = await store.all("SELECT * FROM plan_revision");
    const workouts = await store.all("SELECT * FROM plan_workout");
    await expect(lifecycle.close(closeInput())).resolves.toEqual({
      status: "closed",
      planId: id("11"),
      closedAt: nowMs + 50,
      cleanupJobId: id("91"),
    });
    expect(
      await store.get(`SELECT status,version,current_revision_number,close_actor,
      close_reason,closed_at_ms FROM planning_plan`),
    ).toEqual({
      status: "closed",
      version: 2,
      current_revision_number: 1,
      close_actor: "athlete",
      close_reason: "stopped",
      closed_at_ms: nowMs + 50,
    });
    expect(await store.get("SELECT status FROM plan")).toEqual({ status: "ended" });
    expect(
      await store.get(`SELECT kind,status,window_start_date_key,window_end_date_key
      FROM plan_reconciliation_job WHERE kind='cleanup'`),
    ).toEqual({
      kind: "cleanup",
      status: "pending",
      window_start_date_key: 19980104,
      window_end_date_key: 19980114,
    });
    expect(
      await store.get(
        "SELECT aggregate_refs_json FROM planning_command WHERE command_name='plan.close'",
      ),
    ).toEqual({ aggregate_refs_json: JSON.stringify({ planId: id("11") }, null, 2) });
    expect(await store.all("SELECT * FROM plan_revision")).toEqual(revisions);
    expect(await store.all("SELECT * FROM plan_workout")).toEqual(workouts);
    await expect(store.run("UPDATE planning_plan SET version=version+1")).rejects.toThrow(
      "immutable",
    );
  });

  it("replays an already-closed Plan byte-identically, including after another activation", async () => {
    await activate();
    const result = await lifecycle.close(closeInput());
    let before = await dumpStore(store);
    await expect(lifecycle.close(closeInput())).resolves.toEqual(result);
    expect(await dumpStore(store)).toBe(before);
    await review("2");
    await repository.activate(activationInput("2"));
    before = await dumpStore(store);
    await expect(lifecycle.close({ ...closeInput(), closedAtMs: nowMs + 100 })).resolves.toEqual(
      result,
    );
    expect(await dumpStore(store)).toBe(before);
  });

  it.each(["stale-version", "no-active-plan", "command-conflict"] as const)(
    "rejects %s without any store changes",
    async (reason) => {
      await activate();
      if (reason === "command-conflict") await lifecycle.close(closeInput());
      const before = await dumpStore(store);
      await expect(
        lifecycle.close({
          ...closeInput(),
          expectedVersion: reason === "stale-version" ? 2 : 1,
          planId: reason === "no-active-plan" ? id("88") : id("11"),
          command: {
            ...closeInput().command,
            requestDigest: reason === "command-conflict" ? "b".repeat(64) : "a".repeat(64),
          },
        }),
      ).resolves.toEqual({ status: "rejected", reason });
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("rejects when no active Plan exists, including a fresh command after closure", async () => {
    await expect(lifecycle.close(closeInput())).resolves.toEqual({
      status: "rejected",
      reason: "no-active-plan",
    });
    await activate();
    await lifecycle.close(closeInput());
    const before = await dumpStore(store);
    await expect(
      lifecycle.close({ ...closeInput(), command: stamp("close-again", 70) }),
    ).resolves.toEqual({ status: "rejected", reason: "no-active-plan" });
    expect(await dumpStore(store)).toBe(before);
  });

  it("bounds cleanup after the final Plan day", async () => {
    await activate();
    await lifecycle.close({ ...closeInput(), todayDateKey: 19980201 });
    expect(
      await store.get(
        "SELECT window_start_date_key,window_end_date_key FROM plan_reconciliation_job WHERE kind='cleanup'",
      ),
    ).toEqual({ window_start_date_key: 19980202, window_end_date_key: 19980202 });
  });

  it("rolls back closure, cleanup and preview changes if the ledger write fails", async () => {
    await activate();
    await preview();
    await store.exec(`CREATE TRIGGER fail_close_ledger BEFORE INSERT ON planning_command
      WHEN NEW.command_name='plan.close' BEGIN SELECT RAISE(ABORT,'Synthetic ledger failure'); END;`);
    const before = await dumpStore(store);
    await expect(
      lifecycle.close({ ...closeInput(), command: stamp("close-1", 70), closedAtMs: nowMs + 70 }),
    ).rejects.toThrow("Synthetic ledger failure");
    expect(await dumpStore(store)).toBe(before);
  });

  it("enforces preview wall and logical clock ordering before staling the preview", async () => {
    await activate();
    await preview();
    const before = await dumpStore(store);
    for (const input of [
      closeInput(),
      { ...closeInput(), command: stamp("close-1", 60), closedAtMs: nowMs + 60 },
      { ...closeInput(), command: stamp("close-1", 70), closedAtMs: nowMs + 50 },
    ]) {
      await expect(lifecycle.close(input)).rejects.toThrow("clock precedes preview");
      expect(await dumpStore(store)).toBe(before);
    }
    await lifecycle.close({
      ...closeInput(),
      command: stamp("close-1", 70),
      closedAtMs: nowMs + 70,
    });
    expect(await store.get("SELECT status,version,terminal_at_ms FROM plan_change")).toEqual({
      status: "stale",
      version: 2,
      terminal_at_ms: nowMs + 70,
    });
    expect(await store.get("SELECT current_revision_number FROM planning_plan")).toEqual({
      current_revision_number: 1,
    });
  });

  it.each([19980113, 19980114])("keeps the Plan active on %s", async (todayDateKey) => {
    await activate();
    const before = await dumpStore(store);
    await expect(lifecycle.completeExpired({ todayDateKey, nowMs: nowMs + 100 })).resolves.toEqual({
      completedPlanId: null,
    });
    expect(await dumpStore(store)).toBe(before);
  });

  it.each([false, true])(
    "completes after its own final day with a later Goal=%s, once",
    async (laterGoal) => {
      const totalWeeks = laterGoal ? 12 : 2;
      const finalDateKey = laterGoal ? 19980325 : 19980114;
      const completionDay = laterGoal ? 19980326 : 19980115;
      const snapshot = {
        ...draft,
        goal: { kind: "event", name: "Autumn ride", date: laterGoal ? "1998-12-31" : "1998-01-14" },
        spanKind: laterGoal ? "Base Plan" : "Short block",
        weeks: Array.from({ length: totalWeeks }, (_, index) => ({
          workouts: index === 0 ? [datedWorkout, poolWorkout] : [],
        })),
      };
      await review("1", snapshot);
      const input = activationInput();
      await repository.activate({
        ...input,
        materialize: () => {
          const materialized = input.materialize();
          return {
            ...materialized,
            plan: {
              ...materialized.plan,
              totalWeeks,
              kind: laterGoal ? "full_plan" : materialized.plan.kind,
              targetDateKey: finalDateKey,
            },
          };
        },
      });
      await preview();
      const commands = await store.all("SELECT * FROM planning_command");
      const revisions = await store.all("SELECT * FROM plan_revision");
      await expect(
        lifecycle.completeExpired({ todayDateKey: completionDay, nowMs: nowMs + 100 }),
      ).resolves.toEqual({ completedPlanId: id("11") });
      expect(
        await store.get("SELECT status,close_reason,close_actor,closed_at_ms FROM planning_plan"),
      ).toEqual({
        status: "closed",
        close_reason: "completed",
        close_actor: "system:plan-completion",
        closed_at_ms: nowMs + 100,
      });
      expect(await store.get("SELECT status FROM plan")).toEqual({ status: "ended" });
      expect(
        await store.get(
          "SELECT kind,status,window_start_date_key,window_end_date_key FROM plan_reconciliation_job WHERE kind='cleanup'",
        ),
      ).toEqual({
        kind: "cleanup",
        status: "pending",
        window_start_date_key: completionDay,
        window_end_date_key: completionDay,
      });
      expect(await store.all("SELECT * FROM planning_command")).toEqual(commands);
      expect(await store.all("SELECT * FROM plan_revision")).toEqual(revisions);
      expect((await lifecycle.readClosedDetail(id("11")))?.revision.snapshot).toEqual(snapshot);
      const before = await dumpStore(store);
      await expect(
        lifecycle.completeExpired({ todayDateKey: 19990101, nowMs: nowMs + 200 }),
      ).resolves.toEqual({ completedPlanId: null });
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("returns the final applied revision rather than the activation snapshot", async () => {
    await activate();
    await preview();
    const finalSnapshot = {
      ...draft,
      weeks: [{ workouts: [{ ...poolWorkout, name: "Final flexible ride" }] }],
    };
    await store.run(
      `INSERT INTO plan_revision (
      id,plan_id,revision_number,parent_revision_number,source_kind,source_id,snapshot_json,
      fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter
      ) VALUES (?,?,2,1,'plan-change',?,?,?,?,'test-device',?,0)`,
      [
        id("82"),
        id("11"),
        id("81"),
        JSON.stringify(finalSnapshot),
        "e".repeat(64),
        nowMs + 70,
        nowMs + 70,
      ],
    );
    await store.run(
      `UPDATE planning_plan SET current_revision_number=2,version=2,
      updated_at_ms=?,hlc_physical_ms=? WHERE plan_id=?`,
      [nowMs + 70, nowMs + 70, id("11")],
    );
    await lifecycle.close({
      ...closeInput(),
      expectedVersion: 2,
      command: stamp("close-1", 80),
      closedAtMs: nowMs + 80,
    });
    const before = await dumpStore(store);
    expect((await lifecycle.readClosedDetail(id("11")))?.revision).toEqual({
      revisionNumber: 2,
      fingerprint: "e".repeat(64),
      snapshot: finalSnapshot,
    });
    expect(await dumpStore(store)).toBe(before);
  });

  it("returns the existing cleanup job when its window is already recorded", async () => {
    await activate();
    await store.run(
      `INSERT INTO plan_reconciliation_job (
      id,plan_id,kind,status,window_start_date_key,window_end_date_key,created_at_ms,updated_at_ms
      ) VALUES (?,?,'cleanup','pending',19980104,19980114,?,?)`,
      [id("90"), id("11"), nowMs, nowMs],
    );
    await expect(lifecycle.close(closeInput())).resolves.toMatchObject({ cleanupJobId: id("90") });
    expect(await store.all("SELECT id FROM plan_reconciliation_job ORDER BY id")).toEqual([
      { id: id("51") },
      { id: id("90") },
    ]);
  });

  it("reads immutable closed details including undated Workouts and cleanup state", async () => {
    await expect(lifecycle.readClosedDetail(id("11"))).resolves.toBeNull();
    await activate();
    await expect(lifecycle.readClosedDetail(id("11"))).resolves.toBeNull();
    await lifecycle.close(closeInput());
    const before = await dumpStore(store);
    const detail = await lifecycle.readClosedDetail(id("11"));
    expect(detail).toEqual({
      plan: {
        planId: id("11"),
        name: "Improve fitness",
        startDateKey: 19980101,
        totalWeeks: 2,
        status: "closed",
        closeReason: "stopped",
        closedAtMs: nowMs + 50,
        activatedAtMs: nowMs + 12,
        version: 2,
        creationId: id("1"),
      },
      closeActor: "athlete",
      revision: { revisionNumber: 1, fingerprint, snapshot: draft },
      cleanup: "pending",
    });
    expect(await dumpStore(store)).toBe(before);
    await store.run(
      "UPDATE plan_reconciliation_job SET status='verified',completed_at_ms=updated_at_ms",
    );
    expect((await lifecycle.readClosedDetail(id("11")))?.cleanup).toBe("complete");
    await store.run(
      "UPDATE plan_reconciliation_job SET status='failed',completed_at_ms=NULL,last_error_code='calendar-delete-failed'",
    );
    expect((await lifecycle.readClosedDetail(id("11")))?.cleanup).toBe("failed");
    await store.run("DELETE FROM plan_reconciliation_job");
    expect((await lifecycle.readClosedDetail(id("11")))?.cleanup).toBe("none");
  });
});
