import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlanChangeRepository,
  createPlanCreationRepository,
  createPlanLifecycleRepository,
  createPlanRepository,
  createPlanningPendingCheckRepository,
  type PlanCreationCommandStamp,
  type PlanCreationStore,
  type PlanningCheckOwner,
  type PlanningPendingCheck,
} from "@enduragent/kernel/planning";
import { runMigrations, type SqlStore, type MigratorStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { buildExport, importExport, type ExportSource } from "@enduragent/kernel/store/export";
import { createSqliteImportSink, webCryptoExportEnv } from "../src/store-export/index.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (suffix: string) => suffix.padStart(26, "0");
const creationId = id("1");
const planId = id("2");
const nowMs = 883_612_800_000;
const stamp = (commandId: string, offset = 1): PlanCreationCommandStamp => ({
  commandId,
  requestDigest: "a".repeat(64),
  nowMs: nowMs + offset,
  deviceId: "pending-check-test",
  hlcPhysicalMs: nowMs + offset,
  hlcCounter: 0,
});
const owner: PlanningCheckOwner = { kind: "creation", creationId, sourceVersion: 1 };
const changeOwner: PlanningCheckOwner = {
  kind: "change",
  planId,
  sourceVersion: 1,
  sourceChangeSequence: 0,
};
const busy = (target: PlanningCheckOwner = owner, commandId = "check"): PlanningPendingCheck => ({
  owner: target,
  checkId: commandId,
  commandId,
  attempt: 1,
  state: "busy",
  submissionJson: '{"field":"success","text":"ride well"}',
  checkJson: '{"state":"busy"}',
});
const ready = (check = busy()): PlanningPendingCheck => ({
  ...check,
  state: "ready",
  checkJson: '{"state":"ready","value":"Ride comfortably"}',
});
const readyResult = '{ "status": "checked", "check": {"state":"ready"} }';
const staleResult = '{"status":"rejected","reason":"stale-version"}';
const draftInput = {
  command: stamp("draft"),
  creationId,
  expectedVersion: 1,
  draftId: id("3"),
  inputSnapshotJson: "{}",
  inputFingerprint: "b".repeat(64),
  outputSnapshotJson: '{"weeks":[]}',
  builderId: "cycling",
  builderVersion: "1",
  activationFingerprint: "c".repeat(64),
};

describe("durable planning checks", () => {
  let store: SqlStore & MigratorStore;
  let checks: ReturnType<typeof createPlanningPendingCheckRepository>;
  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    checks = createPlanningPendingCheckRepository(store);
    await createPlanCreationRepository(store).start({
      command: stamp("start", 0),
      creationId,
      seed: { schemaVersion: 1, eventCandidates: [] },
    });
  });
  afterEach(async () => store.close());
  const settle = (check = ready()) =>
    checks.settle({
      command: stamp(check.commandId, 2),
      check,
      resultJson: readyResult,
      staleResultJson: staleResult,
    });
  const makePlan = async () => {
    await createPlanRepository(store).replace(
      {
        id: planId,
        originId: null,
        name: "Synthetic Plan",
        primaryGoal: "Ride comfortably",
        startDateKey: 19980101,
        targetDateKey: 19980107,
        status: "active",
        kind: "short_race_preparation",
        totalWeeks: 1,
        weekStartDay: 4,
        structureJson: "{}",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        deviceId: "pending-check-test",
        hlcPhysicalMs: nowMs,
        hlcCounter: 0,
      },
      [],
    );
    await store.run(
      `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,'active',1,1,?,?,'pending-check-test',?,0)`,
      [planId, nowMs, nowMs, nowMs],
    );
    await store.run(
      `INSERT INTO plan_revision (id,plan_id,revision_number,parent_revision_number,source_kind,source_id,snapshot_json,fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,?,1,NULL,'migration',NULL,'{"weeks":[]}',?,?,'pending-check-test',?,0)`,
      [id("4"), planId, "a".repeat(64), nowMs, nowMs],
    );
  };
  const preview = (transactionStore: PlanCreationStore = store, commandId = "preview") =>
    createPlanChangeRepository(transactionStore, {
      newId: () => id("8"),
      sha256: () => "a".repeat(64),
    }).preview({
      command: stamp(commandId, 3),
      planId,
      expectedVersion: 1,
      expectedChangeSequence: 0,
      nowMs: nowMs + 3,
      changeId: id("5"),
      build: () => ({
        afterSnapshotJson: '{"weeks":[]}',
        envelope: {
          title: "Keep the current week",
          intent: { kind: "test" },
          diff: [],
          totals: { before: { plan: 0, weeks: [] }, after: { plan: 0, weeks: [] } },
          supersedes: null,
          premises: [],
          confidence: "Moderate",
        },
      }),
    });

  it("admits once, preserves confirmed answers, and replays the exact saved response", async () => {
    const [first, duplicate] = await Promise.all([
      checks.admit({ command: stamp("check"), check: busy() }),
      checks.admit({ command: stamp("check"), check: busy() }),
    ]);
    expect(first.status).toBe("admitted");
    expect(duplicate).toEqual({ status: "pending", check: busy() });
    expect(await store.all("SELECT * FROM plan_creation_answer")).toEqual([]);
    expect((await createPlanCreationRepository(store).readUnfinished())?.version).toBe(1);
    expect(await settle()).toEqual({ status: "stored", resultJson: readyResult });
    await checks.resolve({
      owner,
      command: stamp("cancel", 3),
      checkId: "check",
      effect: async () => '{"status":"cancelled"}',
    });
    expect(await checks.read(owner)).toBeNull();
    expect(await checks.admit({ command: stamp("check"), check: busy() })).toEqual({
      status: "replayed",
      resultJson: readyResult,
    });
    expect(await settle()).toEqual({ status: "replayed", resultJson: readyResult });
  });

  it("rejects command collisions and owner changes before admission", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    await expect(
      checks.admit({
        command: { ...stamp("check"), requestDigest: "b".repeat(64) },
        check: busy(),
      }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    await expect(
      checks.admit({
        command: stamp("other"),
        check: busy({ ...owner, sourceVersion: 2 }, "other"),
      }),
    ).rejects.toMatchObject({ code: "stale-version" });
    expect(
      await store.all("SELECT command_id FROM planning_command WHERE status='pending'"),
    ).toEqual([{ command_id: "check" }]);
  });

  it("rejects replacement while busy and permits deliberate retry after error", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    const retry = { ...busy(owner, "retry"), attempt: 2 };
    await expect(
      checks.admit({ command: stamp("retry"), check: retry, replacesCheckId: "check" }),
    ).rejects.toMatchObject({ code: "not-ready" });
    await settle({ ...busy(), state: "error", checkJson: '{"state":"error"}' });
    await expect(
      checks.admit({ command: stamp("retry", 3), check: retry, replacesCheckId: "check" }),
    ).resolves.toMatchObject({ status: "admitted", check: { attempt: 2 } });
    expect(await checks.admit({ command: stamp("check"), check: busy() })).toEqual({
      status: "replayed",
      resultJson: readyResult,
    });
  });

  it("confirms an answer and clears the check atomically without nested transactions", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    await settle();
    const effect = vi.fn(
      async (transactionStore: Parameters<typeof createPlanCreationRepository>[0]) => {
        const result = await createPlanCreationRepository(transactionStore).recordAnswer({
          command: stamp("confirm-inner", 4),
          creationId,
          expectedVersion: 1,
          answerId: id("6"),
          answerKey: "success",
          valueJson: '{"kind":"success","success":{"kind":"authored","text":"Ride comfortably"}}',
        });
        return JSON.stringify(result);
      },
    );
    const input = { owner, command: stamp("confirm", 4), checkId: "check", effect };
    const result = await checks.resolve(input);
    expect(JSON.parse(result)).toMatchObject({
      snapshot: { version: 2, pendingCheckJson: null, answers: [{ answerKey: "success" }] },
    });
    expect(await checks.resolve(input)).toBe(result);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await checks.read(owner)).toBeNull();
  });

  it("rolls back the confirmed answer and clear when the result cannot be recorded", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    await settle();
    await expect(
      checks.resolve({
        owner,
        command: stamp("confirm", 4),
        checkId: "check",
        effect: async (transactionStore) => {
          await createPlanCreationRepository(transactionStore).recordAnswer({
            command: stamp("inner", 4),
            creationId,
            expectedVersion: 1,
            answerId: id("6"),
            answerKey: "success",
            valueJson: "{}",
          });
          return "invalid json";
        },
      }),
    ).rejects.toThrow();
    expect(await checks.read(owner)).toEqual(ready());
    expect(await store.all("SELECT * FROM plan_creation_answer")).toEqual([]);
    expect(
      await store.all(
        "SELECT command_id FROM planning_command WHERE command_id IN ('confirm','inner')",
      ),
    ).toEqual([]);
  });

  it("does not settle against a stale creation version", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    await createPlanCreationRepository(store).recordAnswer({
      command: stamp("different-answer", 3),
      creationId,
      expectedVersion: 1,
      answerId: id("6"),
      answerKey: "goal",
      valueJson: "{}",
    });
    expect(await settle()).toEqual({ status: "stale", resultJson: staleResult });
    expect(await checks.read(owner)).toBeNull();
    expect(await checks.admit({ command: stamp("check"), check: busy() })).toEqual({
      status: "replayed",
      resultJson: staleResult,
    });
  });

  it("recovers interrupted commands after discard without updating a terminal owner", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    await createPlanCreationRepository(store).discard({
      command: stamp("discard", 3),
      creationId,
      expectedVersion: 1,
    });
    const before = await store.get("SELECT * FROM plan_creation");
    expect(await checks.listLive()).toEqual([]);
    const pending = await checks.listPendingCommands();
    expect(pending).toEqual([{ check: busy(), command: stamp("check") }]);
    expect(await settle({ ...busy(), state: "error", checkJson: '{"state":"error"}' })).toEqual({
      status: "stale",
      resultJson: staleResult,
    });
    expect(await store.get("SELECT * FROM plan_creation")).toEqual(before);
    expect(await checks.listPendingCommands()).toEqual([]);
  });

  it("restores an interrupted live check as an error and keeps the response replayable", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    checks = createPlanningPendingCheckRepository(store);
    const [pending] = await checks.listPendingCommands();
    expect(pending).toBeDefined();
    if (pending === undefined) throw new Error("missing pending check");
    const error = { ...pending.check, state: "error" as const, checkJson: '{"state":"error"}' };
    expect(
      await checks.settle({
        command: pending.command,
        check: error,
        resultJson: '{"state":"error"}',
        staleResultJson: staleResult,
      }),
    ).toEqual({ status: "stored", resultJson: '{"state":"error"}' });
    expect(await checks.listLive()).toEqual([error]);
  });

  it("blocks draft building while any field has a pending check", async () => {
    await checks.admit({ command: stamp("check"), check: busy() });
    await expect(createPlanCreationRepository(store).recordDraft(draftInput)).rejects.toMatchObject(
      { code: "not-ready" },
    );
    expect(await store.all("SELECT * FROM plan_creation_draft_revision")).toEqual([]);
  });

  it("keeps old answer replay free of a newer mutable check", async () => {
    const input = {
      command: stamp("answer"),
      creationId,
      expectedVersion: 1,
      answerId: id("6"),
      answerKey: "success",
      valueJson: "{}",
    };
    const creation = createPlanCreationRepository(store);
    await creation.recordAnswer(input);
    await checks.admit({ command: stamp("check", 2), check: busy({ ...owner, sourceVersion: 2 }) });
    expect((await creation.recordAnswer(input)).snapshot.pendingCheckJson).toBeNull();
    expect((await creation.readUnfinished())?.pendingCheckJson).not.toBeNull();
  });

  it("rejects stale Plan Change sequence even when the Plan version did not advance", async () => {
    await makePlan();
    await checks.admit({ command: stamp("check"), check: busy(changeOwner) });
    expect((await preview()).status).toBe("previewed");
    expect(await checks.read(changeOwner)).toBeNull();
    expect(await settle(ready(busy(changeOwner)))).toEqual({
      status: "stale",
      resultJson: staleResult,
    });
    expect(await checks.read(changeOwner)).toBeNull();
    await expect(
      checks.admit({ command: stamp("new"), check: busy(changeOwner, "new") }),
    ).rejects.toMatchObject({ code: "stale-version" });
  });

  it("confirms a Plan Change preview atomically and skips check commands when projecting changes", async () => {
    await makePlan();
    await checks.admit({ command: stamp("check"), check: busy(changeOwner) });
    await settle(ready(busy(changeOwner)));
    const result = await checks.resolve({
      owner: changeOwner,
      command: stamp("confirm", 3),
      checkId: "check",
      effect: async (transactionStore) =>
        JSON.stringify(await preview(transactionStore, "preview-inner")),
    });
    expect(JSON.parse(result)).toMatchObject({ status: "previewed" });
    expect(await checks.read(changeOwner)).toBeNull();
    expect(
      await createPlanChangeRepository(store, {
        newId: () => id("8"),
        sha256: () => "a".repeat(64),
      }).listChanges(planId),
    ).toMatchObject([{ changeId: id("5"), status: "pending" }]);
  });

  it("clears a pending check when a structured preview is cancelled", async () => {
    await makePlan();
    await preview();
    const pendingOwner = { ...changeOwner, sourceChangeSequence: 1 };
    await checks.admit({ command: stamp("check", 4), check: busy(pendingOwner) });
    const result = await createPlanChangeRepository(store, {
      newId: () => id("8"),
      sha256: () => "a".repeat(64),
    }).apply({
      command: stamp("cancel-preview", 5),
      planId,
      changeId: id("5"),
      expectedVersion: 1,
      decision: "cancel",
      nowMs: nowMs + 5,
      todayDateKey: () => 19980101,
      mirrorJobId: id("8"),
      materialize: () => ({ insert: [], update: [], delete: [] }),
    });
    expect(result.status).toBe("cancelled");
    expect(await checks.read(pendingOwner)).toBeNull();
  });

  it("replays a check after newer preview context changes its captured sequence", async () => {
    await makePlan();
    await checks.admit({ command: stamp("check"), check: busy(changeOwner) });
    await settle(ready(busy(changeOwner)));
    await preview();
    expect(
      await checks.admit({
        command: stamp("check"),
        check: busy({ ...changeOwner, sourceChangeSequence: 1 }),
      }),
    ).toEqual({ status: "replayed", resultJson: readyResult });
  });

  it("clears a check when the active Plan closes", async () => {
    await makePlan();
    await checks.admit({ command: stamp("check"), check: busy(changeOwner) });
    const result = await createPlanLifecycleRepository(store, { newId: () => id("8") }).close({
      command: stamp("close", 3),
      planId,
      expectedVersion: 1,
      closedAtMs: nowMs + 3,
      todayDateKey: 19980101,
      cleanupJobId: id("8"),
    });
    expect(result.status).toBe("closed");
    expect(await store.get("SELECT status,pending_check_json FROM planning_plan")).toEqual({
      status: "closed",
      pending_check_json: null,
    });
    expect(await settle(ready(busy(changeOwner)))).toEqual({
      status: "stale",
      resultJson: staleResult,
    });
  });

  it("rejects invalid pending JSON and terminal owners retaining a check", async () => {
    for (const value of ["{", "[]", '"text"', "null"]) {
      await expect(
        store.run("UPDATE plan_creation SET pending_check_json=?", [value]),
      ).rejects.toThrow();
    }
    await checks.admit({ command: stamp("check"), check: busy() });
    await expect(
      store.run("UPDATE plan_creation SET status='discarded',terminal_at_ms=?,version=version+1", [
        nowMs + 3,
      ]),
    ).rejects.toThrow();
  });

  it("defaults historical Draft command snapshots to no pending check", async () => {
    const creation = createPlanCreationRepository(store);
    await creation.recordDraft(draftInput);
    await store.run(`INSERT INTO planning_command
      SELECT command_name,'historical-draft',request_digest,status,aggregate_refs_json,
        json_remove(result_json,'$.pendingCheckJson'),error_code,error_json,version,
        created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
      FROM planning_command WHERE command_id='draft'`);
    await checks.admit({ command: stamp("check", 2), check: busy({ ...owner, sourceVersion: 2 }) });
    expect((await creation.replayDraft(stamp("historical-draft")))?.pendingCheckJson).toBeNull();
    expect((await creation.readUnfinished())?.pendingCheckJson).not.toBeNull();
  });

  it("clears pending checks when an active Plan expires", async () => {
    await makePlan();
    await checks.admit({ command: stamp("check"), check: busy(changeOwner) });
    await createPlanLifecycleRepository(store, { newId: () => id("8") }).completeExpired({
      todayDateKey: 19980108,
      nowMs: nowMs + 4,
    });
    expect(await store.get("SELECT pending_check_json FROM planning_plan")).toEqual({
      pending_check_json: null,
    });
  });

  it("round-trips busy owner state and command replay through export/import", async () => {
    await makePlan();
    await checks.admit({ command: stamp("check"), check: busy() });
    await checks.admit({
      command: stamp("change-check"),
      check: busy(changeOwner, "change-check"),
    });
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(destination, MIGRATIONS);
      const source: ExportSource = {
        readUserVersion: () => store.getUserVersion(),
        readAuthoredTable: (table, { manualOnly }) =>
          store.all(
            `SELECT * FROM "${table.replaceAll('"', '""')}"${manualOnly ? " WHERE provenance='manual'" : ""}`,
          ),
      };
      const built = await buildExport(
        { source, manifest: { listArtifacts: async () => [] }, ...webCryptoExportEnv },
        {},
      );
      await importExport(
        {
          sink: createSqliteImportSink(destination),
          presence: { hasArtifact: async () => true },
          targetUserVersion: 34,
          ...webCryptoExportEnv,
        },
        { container: built.container },
      );
      const restored = createPlanningPendingCheckRepository(destination);
      expect(await restored.listLive()).toEqual(await checks.listLive());
      expect(await restored.listPendingCommands()).toEqual(await checks.listPendingCommands());
      await restored.settle({
        command: stamp("check", 2),
        check: ready(),
        resultJson: readyResult,
        staleResultJson: staleResult,
      });
      expect(await restored.admit({ command: stamp("check"), check: busy() })).toEqual({
        status: "replayed",
        resultJson: readyResult,
      });
    } finally {
      await destination.close();
    }
  });
});
