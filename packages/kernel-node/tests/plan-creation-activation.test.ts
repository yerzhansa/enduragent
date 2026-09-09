import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanCreationRepository,
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

const activationInput = (
  key = "1",
  incumbent: Parameters<PlanCreationRepository["activate"]>[0]["incumbent"] = null,
) => {
  const command = stamp(`activate-${key}`, Number(key) * 10 + 2);
  const planId = id(`1${key}`);
  return {
    command,
    creationId: id(key),
    expectedVersion: 2,
    incumbent,
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

describe("Plan Creation activation repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: PlanCreationRepository;
  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createPlanCreationRepository(store);
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

  it("activates a reviewed Draft and retains undated Workouts only in its immutable revision", async () => {
    await review();
    const input = activationInput();
    await expect(repository.activate(input)).resolves.toEqual({
      creationId: id("1"),
      planId: id("11"),
      closedPlanId: null,
      activatedAt: "1998-01-01",
    });
    await expect(repository.readUnfinished()).resolves.toBeUndefined();
    await expect(start()).resolves.toMatchObject({
      outcome: "replayed",
      snapshot: {
        id: id("1"),
        status: "activated",
        version: 3,
        currentDraft: { revisionNumber: 1 },
      },
    });
    expect(
      await store.get("SELECT status,version,activated_plan_id,terminal_at_ms FROM plan_creation"),
    ).toEqual({
      status: "activated",
      version: 3,
      activated_plan_id: id("11"),
      terminal_at_ms: input.command.nowMs,
    });
    expect(
      await store.get(
        "SELECT status,version,current_revision_number,activated_at_ms FROM planning_plan",
      ),
    ).toEqual({
      status: "active",
      version: 1,
      current_revision_number: 1,
      activated_at_ms: input.command.nowMs,
    });
    expect(await store.all("SELECT id,status FROM plan")).toEqual([
      { id: id("11"), status: "active" },
    ]);
    expect(await store.all("SELECT * FROM plan_reconciliation_job")).toEqual([
      {
        id: input.mirrorJobId,
        plan_id: id("11"),
        kind: "mirror",
        status: "pending",
        window_start_date_key: 19980101,
        window_end_date_key: 19980107,
        attempt_count: 0,
        failure_count: 0,
        resumed_count: 0,
        last_resumed_attempt: null,
        last_error_code: null,
        created_at_ms: input.command.nowMs,
        updated_at_ms: input.command.nowMs,
        completed_at_ms: null,
      },
    ]);
    expect(await store.all("SELECT date_key,origin,structure_json FROM plan_workout")).toEqual([
      { date_key: 19980101, origin: "coach", structure_json: JSON.stringify(datedWorkout) },
    ]);
    expect(
      await store.get(
        "SELECT revision_number,parent_revision_number,source_kind,source_id,snapshot_json,fingerprint FROM plan_revision",
      ),
    ).toEqual({
      revision_number: 1,
      parent_revision_number: null,
      source_kind: "activation",
      source_id: id("1"),
      snapshot_json: JSON.stringify(draft),
      fingerprint,
    });
    await expect(
      store.run("UPDATE plan_revision SET fingerprint=?", ["e".repeat(64)]),
    ).rejects.toThrow();
    expect(
      await store.all(
        "SELECT status FROM planning_command WHERE command_name='plan_creation.activate'",
      ),
    ).toEqual([{ status: "succeeded" }]);
  });

  it("closes both incumbent rows and replays the original result after another activation", async () => {
    await review();
    const first = await repository.activate(activationInput());
    await review("2");
    const second = await repository.activate(
      activationInput("2", { planId: id("11"), version: 1 }),
    );
    expect(second.closedPlanId).toBe(first.planId);
    expect(
      await store.get(
        "SELECT status,version,close_reason,close_actor,closed_at_ms FROM planning_plan WHERE plan_id=?",
        [first.planId],
      ),
    ).toEqual({
      status: "closed",
      version: 2,
      close_reason: "stopped",
      close_actor: "test-device-1998",
      closed_at_ms: nowMs + 22,
    });
    expect(await store.all("SELECT id,status FROM plan ORDER BY id")).toEqual([
      { id: first.planId, status: "ended" },
      { id: second.planId, status: "active" },
    ]);
    expect(
      await store.all(
        "SELECT id,plan_id,kind,status,window_start_date_key,window_end_date_key FROM plan_reconciliation_job ORDER BY id",
      ),
    ).toEqual([
      {
        id: id("51"),
        plan_id: first.planId,
        kind: "mirror",
        status: "pending",
        window_start_date_key: 19980101,
        window_end_date_key: 19980107,
      },
      {
        id: id("52"),
        plan_id: second.planId,
        kind: "mirror",
        status: "pending",
        window_start_date_key: 19980101,
        window_end_date_key: 19980107,
      },
      {
        id: id("62"),
        plan_id: first.planId,
        kind: "cleanup",
        status: "pending",
        window_start_date_key: 19980102,
        window_end_date_key: 19980114,
      },
    ]);
    const before = await dumpStore(store);
    await expect(
      createPlanCreationRepository(store).activate({
        ...activationInput(),
        mirrorJobId: id("91"),
        cleanupJobId: id("92"),
        materialize: () => {
          throw new Error("Replay must not materialize again");
        },
      }),
    ).resolves.toEqual(first);
    expect(await dumpStore(store)).toBe(before);
    await expect(
      repository.activate({
        ...activationInput(),
        command: { ...activationInput().command, requestDigest: "b".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    expect(await dumpStore(store)).toBe(before);
  });

  it.each(["version", "closed", "different", "unexpected"])(
    "rejects a changed incumbent when it is %s without changing stored rows",
    async (change) => {
      await review();
      const first = await repository.activate(activationInput());
      await review("2");
      if (change === "version")
        await store.run("UPDATE planning_plan SET version=version+1 WHERE plan_id=?", [
          first.planId,
        ]);
      if (change === "closed") {
        await store.run(
          "UPDATE planning_plan SET status='closed',close_reason='stopped',close_actor=?,closed_at_ms=?,updated_at_ms=?,version=version+1 WHERE plan_id=?",
          ["test-device-1998", nowMs + 23, nowMs + 23, first.planId],
        );
        await store.run("UPDATE plan SET status='ended' WHERE id=?", [first.planId]);
      }
      const before = await dumpStore(store);
      await expect(
        repository.activate(
          activationInput(
            "2",
            change === "unexpected"
              ? null
              : {
                  planId: change === "different" ? id("99") : first.planId,
                  version: 1,
                },
          ),
        ),
      ).rejects.toMatchObject({ code: "version-conflict" });
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("uses civil-day windows and keeps cleanup nonempty after the incumbent's final day", async () => {
    await review();
    await repository.activate(activationInput());
    await review("2");
    await repository.activate({
      ...activationInput("2", { planId: id("11"), version: 1 }),
      activatedAt: "1998-01-31",
      todayDateKey: 19980131,
    });
    expect(
      await store.all(
        "SELECT kind,window_start_date_key,window_end_date_key FROM plan_reconciliation_job WHERE id IN (?,?) ORDER BY id",
        [id("52"), id("62")],
      ),
    ).toEqual([
      { kind: "mirror", window_start_date_key: 19980131, window_end_date_key: 19980206 },
      { kind: "cleanup", window_start_date_key: 19980201, window_end_date_key: 19980201 },
    ]);
  });

  it.each(["missing", "stale", "version", "empty", "fingerprint"])(
    "rejects %s Draft admission without changing any stored row",
    async (kind) => {
      await review();
      await repository.activate(activationInput());
      if (kind === "missing") await start("2");
      else
        await review(
          "2",
          kind === "empty"
            ? { ...draft, weeks: [{ workouts: [] }] }
            : kind === "fingerprint"
              ? { ...draft, outputFingerprint: "d".repeat(64) }
              : draft,
        );
      if (kind === "stale")
        await repository.recordAnswer({
          command: stamp("edited-answer", 23),
          creationId: id("2"),
          expectedVersion: 2,
          answerId: id("8"),
          answerKey: "success",
          valueJson: "{}",
        });
      const before = await dumpStore(store);
      await expect(
        repository.activate({
          ...activationInput("2", { planId: id("11"), version: 1 }),
          expectedVersion: kind === "stale" ? 3 : kind === "missing" || kind === "version" ? 1 : 2,
        }),
      ).rejects.toMatchObject({
        code:
          kind === "version"
            ? "version-conflict"
            : kind === "fingerprint"
              ? "corrupt-record"
              : "not-ready",
      });
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("rejects activation when no unfinished creation exists", async () => {
    const before = await dumpStore(store);
    await expect(repository.activate(activationInput())).rejects.toMatchObject({
      code: "not-ready",
    });
    expect(await dumpStore(store)).toBe(before);
  });

  it("rolls back incumbent closure and every new row when the activation ledger fails", async () => {
    await review();
    await repository.activate(activationInput());
    await review("2");
    const before = await dumpStore(store);
    let closureObserved = false;
    const failing = createPlanCreationRepository({
      exec: (sql) => store.exec(sql),
      async run(sql, params) {
        if (sql.includes("INSERT INTO planning_command")) {
          expect(
            await store.get("SELECT status,close_reason FROM planning_plan WHERE plan_id=?", [
              id("11"),
            ]),
          ).toEqual({ status: "closed", close_reason: "stopped" });
          expect(await store.get("SELECT status FROM plan WHERE id=?", [id("11")])).toEqual({
            status: "ended",
          });
          expect(await store.get("SELECT status FROM plan_creation WHERE id=?", [id("2")])).toEqual(
            { status: "activated" },
          );
          expect(
            await store.all(
              "SELECT id,plan_id,kind,status FROM plan_reconciliation_job WHERE id IN (?,?) ORDER BY id",
              [id("52"), id("62")],
            ),
          ).toEqual([
            { id: id("52"), plan_id: id("12"), kind: "mirror", status: "pending" },
            { id: id("62"), plan_id: id("11"), kind: "cleanup", status: "pending" },
          ]);
          closureObserved = true;
          throw new Error("Synthetic activation ledger failure");
        }
        return store.run(sql, params);
      },
      get: (sql, params) => store.get(sql, params),
      all: (sql, params) => store.all(sql, params),
      close: () => store.close(),
      transaction: (operation) => store.transaction(operation),
    });
    await expect(
      failing.activate(activationInput("2", { planId: id("11"), version: 1 })),
    ).rejects.toThrow("Synthetic activation ledger failure");
    expect(closureObserved).toBe(true);
    expect(await dumpStore(store)).toBe(before);
    await expect(
      repository.activate(activationInput("2", { planId: id("11"), version: 1 })),
    ).resolves.toMatchObject({
      closedPlanId: id("11"),
    });
  });
});
