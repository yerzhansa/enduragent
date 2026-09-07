import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanCreationRepository,
  type PlanCreationCommandStamp,
  type PlanCreationRepository,
} from "@enduragent/kernel/planning";
import { buildExport, importExport, type ExportSource } from "@enduragent/kernel/store/export";
import {
  dumpStore,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createSqliteImportSink, webCryptoExportEnv } from "@enduragent/kernel-node/store-export";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (value: string) => `${"0".repeat(26 - value.length)}${value}`;
const creationId = id("1");
const secondId = id("2");
const seed = { schemaVersion: 1 as const, eventCandidates: [] };
const stamp = (
  commandId: string,
  digest: string,
  nowMs = 883_612_800_000,
): PlanCreationCommandStamp => ({
  commandId,
  requestDigest: digest.repeat(64),
  nowMs,
  deviceId: "test-device-1998",
  hlcPhysicalMs: nowMs,
  hlcCounter: 0,
});

describe("Plan Creation repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: PlanCreationRepository;
  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createPlanCreationRepository(store);
  });
  afterEach(async () => store.close());
  const start = () => repository.start({ command: stamp("start", "a"), creationId, seed });
  const answer = (expectedVersion = 1, commandId = "answer", answerId = id("3")) =>
    repository.recordAnswer({
      command: stamp(commandId, "b", 883_612_800_001),
      creationId,
      expectedVersion,
      answerId,
      answerKey: expectedVersion === 1 ? "goal" : "success",
      valueJson:
        expectedVersion === 1
          ? JSON.stringify({ kind: "goal", goal: { kind: "fitness", outcome: "Build power" } })
          : JSON.stringify({ kind: "success", success: { kind: "authored", text: "Ride well" } }),
    });
  const discard = (
    expectedVersion = 1,
    commandId = "discard",
    digest = "c",
    targetCreationId = creationId,
  ) =>
    repository.discard({
      command: stamp(commandId, digest, 883_612_800_002),
      creationId: targetCreationId,
      expectedVersion,
    });

  const draftInput = (expectedVersion = 1, commandId = "preview", draftId = id("8")) => ({
    command: stamp(commandId, "d", 883_612_800_003),
    creationId,
    expectedVersion,
    draftId,
    inputSnapshotJson: JSON.stringify({ answers: [], today: "1998-01-01", ftp: null }),
    inputFingerprint: "e".repeat(64),
    outputSnapshotJson: JSON.stringify({ weeks: [{ workouts: [{ name: "Endurance ride" }] }] }),
    builderId: "cycling",
    builderVersion: "1",
    activationFingerprint: "f".repeat(64),
  });

  it("stores immutable revisions and keeps the earlier draft after an answer edit", async () => {
    await start();
    const first = await repository.recordDraft(draftInput());
    expect(first).toMatchObject({
      outcome: "recorded",
      snapshot: {
        status: "review",
        version: 2,
        currentDraft: { revisionNumber: 1, parentRevisionNumber: null, inputVersion: 1 },
      },
    });
    const before = await store.all("SELECT * FROM plan_creation_draft_revision");
    const edited = await answer(2);
    expect(edited.snapshot).toMatchObject({
      status: "review",
      version: 3,
      currentDraft: first.snapshot.currentDraft,
    });
    expect(await store.all("SELECT * FROM plan_creation_draft_revision")).toEqual(before);
    const second = await repository.recordDraft(draftInput(3, "rebuild", id("9")));
    expect(second.snapshot).toMatchObject({
      status: "review",
      version: 4,
      currentDraft: { revisionNumber: 2, parentRevisionNumber: 1, inputVersion: 3 },
    });
    expect(
      (await store.all("SELECT * FROM plan_creation_draft_revision ORDER BY revision_number"))[0],
    ).toEqual(before[0]);
    await expect(
      store.run("UPDATE plan_creation_draft_revision SET builder_version='2'"),
    ).rejects.toThrow();
    await expect(store.run("DELETE FROM plan_creation_draft_revision")).rejects.toThrow();
    expect(await store.all("SELECT * FROM plan")).toEqual([]);
    await expect(createPlanCreationRepository(store).readUnfinished()).resolves.toEqual(
      second.snapshot,
    );
  });

  it("replays the recorded preview after answers, rebuild, discard, and a new creation", async () => {
    await start();
    const input = draftInput();
    const original = await repository.recordDraft(input);
    await answer(2);
    await repository.recordDraft(draftInput(3, "rebuild", id("9")));
    await expect(repository.recordDraft(input)).resolves.toEqual({
      outcome: "replayed",
      snapshot: original.snapshot,
    });
    await discard(4);
    await expect(repository.replayDraft(input.command)).resolves.toEqual(original.snapshot);
    await repository.start({ command: stamp("next-start", "a"), creationId: secondId, seed });
    await expect(repository.recordDraft(input)).resolves.toEqual({
      outcome: "replayed",
      snapshot: original.snapshot,
    });
    await expect(repository.readUnfinished()).resolves.toMatchObject({ id: secondId, version: 1 });
    expect(await store.all("SELECT * FROM plan_creation_draft_revision")).toHaveLength(2);
    await expect(
      repository.recordDraft({ ...input, command: stamp("preview", "a") }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    await expect(repository.replayDraft(stamp("preview", "a"))).rejects.toMatchObject({
      code: "command-conflict",
    });
  });

  it("rejects missing and stale previews without writing a revision or command", async () => {
    await expect(repository.recordDraft(draftInput())).rejects.toMatchObject({
      code: "no-unfinished-creation",
    });
    await start();
    await expect(
      repository.recordDraft({ ...draftInput(), creationId: secondId }),
    ).rejects.toMatchObject({ code: "no-unfinished-creation" });
    await answer();
    await expect(repository.recordDraft(draftInput())).rejects.toMatchObject({
      code: "stale-version",
    });
    await discard(2);
    await expect(repository.recordDraft(draftInput(2))).rejects.toMatchObject({
      code: "no-unfinished-creation",
    });
    expect(await store.all("SELECT * FROM plan_creation_draft_revision")).toEqual([]);
    expect(
      await store.all("SELECT * FROM planning_command WHERE command_name='plan_creation.preview'"),
    ).toEqual([]);
  });

  it("serializes competing preview and answer commands against one expected version", async () => {
    await start();
    const results = await Promise.allSettled([repository.recordDraft(draftInput()), answer()]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "stale-version" },
    });
    const snapshot = await repository.readUnfinished();
    expect(snapshot?.version).toBe(2);
    const revisionRows = await store.all("SELECT * FROM plan_creation_draft_revision");
    expect(revisionRows.length + (snapshot?.answers.length ?? 0)).toBe(1);
  });

  it("serializes a preview racing discard without attaching a draft to a terminal creation", async () => {
    await start();
    const results = await Promise.allSettled([discard(), repository.recordDraft(draftInput())]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "no-unfinished-creation" },
    });
    await expect(repository.readUnfinished()).resolves.toBeUndefined();
    expect(await store.all("SELECT * FROM plan_creation_draft_revision")).toEqual([]);
  });

  it("rolls back the draft and review pointer when the command ledger fails", async () => {
    await start();
    const before = await dumpStore(store);
    const failingRepository = createPlanCreationRepository({
      exec: (sql) => store.exec(sql),
      run(sql, params) {
        if (sql.includes("INSERT INTO planning_command"))
          throw new Error("Synthetic draft ledger failure");
        return store.run(sql, params);
      },
      get: (sql, params) => store.get(sql, params),
      all: (sql, params) => store.all(sql, params),
      close: () => store.close(),
      transaction: (operation) => store.transaction(operation),
    });
    await expect(failingRepository.recordDraft(draftInput())).rejects.toThrow(
      "Synthetic draft ledger failure",
    );
    expect(await dumpStore(store)).toBe(before);
  });

  it("creates once and resumes without replacing the seed", async () => {
    await expect(start()).resolves.toMatchObject({ outcome: "created", snapshot: { version: 1 } });
    const otherSeed = {
      schemaVersion: 1 as const,
      eventCandidates: [
        { candidateId: id("9"), name: "Tour", date: "1998-10-18", sourceLabel: "Calendar" },
      ],
    };
    await expect(
      repository.start({ command: stamp("resume", "c"), creationId: secondId, seed: otherSeed }),
    ).resolves.toMatchObject({ outcome: "resumed", snapshot: { id: creationId, seed } });
  });

  it("records the resulting creation version in each start and answer command", async () => {
    await start();
    await answer();
    await repository.start({ command: stamp("resume", "c"), creationId: secondId, seed });
    const rows = await store.all(
      "SELECT command_id,result_json FROM planning_command ORDER BY command_id",
    );
    expect(
      rows.map((row) => ({
        commandId: row.command_id,
        result: JSON.parse(String(row.result_json)),
      })),
    ).toEqual([
      { commandId: "answer", result: { creationId, answerId: id("3"), version: 2 } },
      { commandId: "resume", result: { creationId, outcome: "resumed", version: 2 } },
      { commandId: "start", result: { creationId, outcome: "created", version: 1 } },
    ]);
  });

  it("replays effects and rejects a changed digest", async () => {
    await start();
    await expect(start()).resolves.toMatchObject({ outcome: "replayed" });
    await expect(
      repository.start({ command: stamp("start", "c"), creationId: secondId, seed }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    await answer();
    await expect(answer()).resolves.toMatchObject({
      outcome: "replayed",
      snapshot: { version: 2 },
    });
    await expect(
      repository.recordAnswer({
        command: stamp("answer", "c"),
        creationId,
        expectedVersion: 1,
        answerId: id("3"),
        answerKey: "goal",
        valueJson: "{}",
      }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    expect(await store.all("SELECT id FROM plan_creation_answer")).toHaveLength(1);
  });

  it.each([false, true])(
    "replays the recorded creation after discard with a later creation: %s",
    async (startLater) => {
      await start();
      await answer();
      await discard(2);
      if (startLater)
        await repository.start({ command: stamp("later-start", "d"), creationId: secondId, seed });
      const before = await dumpStore(store);
      for (const replay of [start, answer]) {
        await expect(replay()).resolves.toMatchObject({
          outcome: "replayed",
          snapshot: { id: creationId, status: "discarded", version: 3, answers: [{ id: id("3") }] },
        });
      }
      expect(await dumpStore(store)).toBe(before);
      await expect(repository.readUnfinished()).resolves.toEqual(
        startLater ? expect.objectContaining({ id: secondId }) : undefined,
      );
    },
  );

  it.each(["{}", JSON.stringify({ creationId: secondId })])(
    "rejects an unresolved recorded creation",
    async (resultJson) => {
      await start();
      await store.run(
        `INSERT INTO planning_command (
command_name,command_id,request_digest,status,aggregate_refs_json,result_json,error_code,error_json,
version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) SELECT command_name,'unresolved',request_digest,status,aggregate_refs_json,?,error_code,error_json,
version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter FROM planning_command WHERE command_name='plan_creation.start'`,
        [resultJson],
      );
      await expect(
        repository.start({ command: stamp("unresolved", "a"), creationId, seed }),
      ).rejects.toMatchObject({ code: "corrupt-record" });
    },
  );

  it("leaves no partial effect for a stale version", async () => {
    await start();
    await expect(answer(2)).rejects.toMatchObject({ code: "stale-version" });
    await expect(repository.readUnfinished()).resolves.toMatchObject({ version: 1, answers: [] });
    expect(
      await store.get(
        "SELECT command_id FROM planning_command WHERE command_name='plan_creation.answer'",
      ),
    ).toBeUndefined();
  });

  it("discards terminally, preserves answers, and permits a fresh creation", async () => {
    await start();
    await answer();
    const answersBefore = await store.all(
      "SELECT * FROM plan_creation_answer WHERE creation_id=? ORDER BY sequence,id",
      [creationId],
    );

    await expect(discard(2)).resolves.toEqual({ outcome: "discarded" });
    await expect(repository.readUnfinished()).resolves.toBeUndefined();
    expect(
      await store.get(
        "SELECT status,version,terminal_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter FROM plan_creation WHERE id=?",
        [creationId],
      ),
    ).toEqual({
      status: "discarded",
      version: 3,
      terminal_at_ms: 883_612_800_002,
      updated_at_ms: 883_612_800_002,
      device_id: "test-device-1998",
      hlc_physical_ms: 883_612_800_002,
      hlc_counter: 0,
    });
    expect(
      await store.all(
        "SELECT * FROM plan_creation_answer WHERE creation_id=? ORDER BY sequence,id",
        [creationId],
      ),
    ).toEqual(answersBefore);
    const command = await store.get(
      "SELECT status,version,aggregate_refs_json,result_json FROM planning_command WHERE command_name='plan_creation.discard' AND command_id='discard'",
    );
    expect(command).toMatchObject({
      status: "succeeded",
      version: 2,
    });
    expect(JSON.parse(String(command?.aggregate_refs_json))).toEqual({ creationId });
    expect(JSON.parse(String(command?.result_json))).toEqual({
      creationId,
      outcome: "discarded",
      version: 3,
    });

    await expect(
      repository.start({
        command: stamp("start-after-discard", "d", 883_612_800_003),
        creationId: secondId,
        seed,
      }),
    ).resolves.toMatchObject({ outcome: "created", snapshot: { id: secondId, version: 1 } });
    expect(
      await store.get(
        "SELECT count(*) count FROM plan_creation WHERE status IN ('in-progress','review')",
      ),
    ).toEqual({ count: 1 });
    expect(
      await store.get("SELECT status,version FROM plan_creation WHERE id=?", [creationId]),
    ).toEqual({ status: "discarded", version: 3 });
  });

  it("leaves no partial effect for a stale discard version", async () => {
    await start();
    const before = await store.get("SELECT * FROM plan_creation WHERE id=?", [creationId]);

    await expect(discard(2)).rejects.toMatchObject({ code: "stale-version" });
    expect(await store.get("SELECT * FROM plan_creation WHERE id=?", [creationId])).toEqual(before);
    expect(
      await store.get(
        "SELECT command_id FROM planning_command WHERE command_name='plan_creation.discard'",
      ),
    ).toBeUndefined();
  });

  it("rejects discard when the guarded update no longer matches unfinished status", async () => {
    await start();
    const before = await store.get("SELECT * FROM plan_creation WHERE id=?", [creationId]);
    let intercepted = false;
    const guardedRepository = createPlanCreationRepository({
      exec: (sql) => store.exec(sql),
      run: (sql, params) => store.run(sql, params),
      async get(sql, params) {
        if (!intercepted && sql.includes("UPDATE plan_creation SET status='discarded'")) {
          intercepted = true;
          return undefined;
        }
        return store.get(sql, params);
      },
      all: (sql, params) => store.all(sql, params),
      close: () => store.close(),
      transaction: (operation) => store.transaction(operation),
    });

    await expect(
      guardedRepository.discard({
        command: stamp("guarded-discard", "e", 883_612_800_003),
        creationId,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "stale-version" });
    expect(intercepted).toBe(true);
    expect(await store.get("SELECT * FROM plan_creation WHERE id=?", [creationId])).toEqual(before);
    expect(
      await store.get(
        "SELECT command_id FROM planning_command WHERE command_name='plan_creation.discard'",
      ),
    ).toBeUndefined();
  });

  it("rolls back the terminal update when the discard ledger insert fails", async () => {
    await start();
    await answer();
    const snapshot = async () => ({
      creations: await store.all("SELECT * FROM plan_creation ORDER BY id"),
      answers: await store.all("SELECT * FROM plan_creation_answer ORDER BY id"),
      commands: await store.all("SELECT * FROM planning_command ORDER BY command_name,command_id"),
    });
    const before = await snapshot();
    let terminalUpdateObserved = false;
    const failingRepository = createPlanCreationRepository({
      exec: (sql) => store.exec(sql),
      async run(sql, params) {
        if (sql.includes("INSERT INTO planning_command")) {
          const row = await store.get("SELECT status,version FROM plan_creation WHERE id=?", [
            creationId,
          ]);
          expect(row).toEqual({ status: "discarded", version: 3 });
          terminalUpdateObserved = true;
          throw new Error("Synthetic ledger write failure");
        }
        return store.run(sql, params);
      },
      get: (sql, params) => store.get(sql, params),
      all: (sql, params) => store.all(sql, params),
      close: () => store.close(),
      transaction: (operation) => store.transaction(operation),
    });
    await expect(
      failingRepository.discard({
        command: stamp("discard", "c", 883_612_800_002),
        creationId,
        expectedVersion: 2,
      }),
    ).rejects.toThrow("Synthetic ledger write failure");
    expect(terminalUpdateObserved).toBe(true);
    expect(await snapshot()).toEqual(before);
    await expect(discard(2)).resolves.toEqual({ outcome: "discarded" });
    expect(await store.all("SELECT * FROM plan_creation_answer ORDER BY id")).toEqual(
      before.answers,
    );
    expect(
      await store.all("SELECT * FROM planning_command WHERE command_name='plan_creation.discard'"),
    ).toHaveLength(1);
  });

  it("replays a discard without touching a later creation", async () => {
    await start();
    const firstResult = await discard();
    await repository.start({
      command: stamp("start-after-discard", "d", 883_612_800_003),
      creationId: secondId,
      seed,
    });

    await expect(discard()).resolves.toEqual(firstResult);
    await expect(repository.readUnfinished()).resolves.toMatchObject({
      id: secondId,
      version: 1,
      answers: [],
    });
    expect(
      await store.get("SELECT status,version FROM plan_creation WHERE id=?", [creationId]),
    ).toEqual({ status: "discarded", version: 2 });
    expect(
      await store.get(
        "SELECT count(*) count FROM planning_command WHERE command_name='plan_creation.discard'",
      ),
    ).toEqual({ count: 1 });
  });

  it("rejects conflicting reuse of a discard command", async () => {
    await start();
    await discard();
    const creationBefore = await store.get("SELECT * FROM plan_creation WHERE id=?", [creationId]);
    const commandBefore = await store.get(
      "SELECT * FROM planning_command WHERE command_name='plan_creation.discard' AND command_id='discard'",
    );

    await expect(discard(1, "discard", "d")).rejects.toMatchObject({
      code: "command-conflict",
    });
    expect(await store.get("SELECT * FROM plan_creation WHERE id=?", [creationId])).toEqual(
      creationBefore,
    );
    expect(
      await store.get(
        "SELECT * FROM planning_command WHERE command_name='plan_creation.discard' AND command_id='discard'",
      ),
    ).toEqual(commandBefore);
  });

  it("rejects discard when the unfinished creation is absent or different", async () => {
    await expect(discard()).rejects.toMatchObject({ code: "no-unfinished-creation" });
    await start();
    await expect(discard(1, "wrong-creation", "d", secondId)).rejects.toMatchObject({
      code: "no-unfinished-creation",
    });
    expect(
      await store.get(
        "SELECT count(*) count FROM planning_command WHERE command_name='plan_creation.discard'",
      ),
    ).toEqual({ count: 0 });
  });

  it("rejects a malformed persisted seed as a corrupt record", async () => {
    await start();
    await store.run("UPDATE plan_creation SET seed_json=? WHERE id=?", [
      JSON.stringify({ schemaVersion: 1 }),
      creationId,
    ]);
    await expect(repository.readUnfinished()).rejects.toMatchObject({ code: "corrupt-record" });
  });

  it("serializes competing starts to one unfinished creation", async () => {
    const results = await Promise.all([
      start(),
      repository.start({ command: stamp("other", "c"), creationId: secondId, seed }),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["created", "resumed"]);
    expect(
      await store.get(
        "SELECT count(*) count FROM plan_creation WHERE status IN ('in-progress','review')",
      ),
    ).toEqual({ count: 1 });
  });

  it("owns one creation version bump per answer", async () => {
    await start();
    await answer();
    const result = await answer(2, "success", id("4"));
    expect(result.snapshot).toMatchObject({
      version: 3,
      answers: [
        { sequence: 1, creationVersion: 2, answerKey: "goal" },
        { sequence: 2, creationVersion: 3, answerKey: "success" },
      ],
    });
    expect(
      await store.all(
        "SELECT command_name,status FROM planning_command ORDER BY created_at_ms,command_name",
      ),
    ).toEqual([
      { command_name: "plan_creation.start", status: "succeeded" },
      { command_name: "plan_creation.answer", status: "succeeded" },
      { command_name: "plan_creation.answer", status: "succeeded" },
    ]);
  });

  it("appends a re-answer for the same key and reads every row in sequence order", async () => {
    await start();
    await answer();
    await repository.recordAnswer({
      command: stamp("edit-goal", "c", 883_612_800_002),
      creationId,
      expectedVersion: 2,
      answerId: id("4"),
      answerKey: "goal",
      valueJson: JSON.stringify({
        answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } },
        source: { kind: "athlete" },
      }),
    });

    const restored = await repository.readUnfinished();
    expect(restored).toMatchObject({
      version: 3,
      answers: [
        { id: id("3"), answerKey: "goal", sequence: 1, creationVersion: 2 },
        { id: id("4"), answerKey: "goal", sequence: 2, creationVersion: 3 },
      ],
    });
    const effectiveGoal = restored?.answers.filter((row) => row.answerKey === "goal").at(-1);
    expect(JSON.parse(effectiveGoal?.valueJson ?? "null")).toMatchObject({
      answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } },
    });
  });

  it("round-trips real rows through dump, export, and restore", async () => {
    await start();
    const goalAnswer = {
      command: stamp("answer-goal", "b", 883_612_800_001),
      creationId,
      expectedVersion: 1,
      answerId: id("3"),
      answerKey: "goal",
      valueJson: JSON.stringify({
        answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build power" } },
        source: { kind: "athlete" },
      }),
    } satisfies Parameters<PlanCreationRepository["recordAnswer"]>[0];
    const lengthAnswer = {
      ...goalAnswer,
      command: stamp("answer-length", "c", 883_612_800_002),
      expectedVersion: 2,
      answerId: id("4"),
      answerKey: "plan-length",
      valueJson: JSON.stringify({
        answer: { kind: "plan-length", weeks: 8 },
        source: { kind: "athlete" },
      }),
    };
    const editedGoalAnswer = {
      ...goalAnswer,
      command: stamp("edit-goal", "d", 883_612_800_003),
      expectedVersion: 3,
      answerId: id("5"),
      valueJson: JSON.stringify({
        answer: { kind: "goal", goal: { kind: "fitness", outcome: "Build endurance" } },
        source: { kind: "athlete" },
      }),
    };
    const answers = [goalAnswer, lengthAnswer, editedGoalAnswer];
    for (const input of answers) await repository.recordAnswer(input);
    const draft = draftInput(4);
    await repository.recordDraft(draft);
    const sourceSnapshot = await repository.readUnfinished();
    expect(sourceSnapshot).toMatchObject({
      id: creationId,
      version: 5,
      currentDraft: { revisionNumber: 1, inputVersion: 4 },
      answers: [
        { id: id("3"), answerKey: "goal", sequence: 1, creationVersion: 2 },
        { id: id("4"), answerKey: "plan-length", sequence: 2, creationVersion: 3 },
        { id: id("5"), answerKey: "goal", sequence: 3, creationVersion: 4 },
      ],
    });
    expect(sourceSnapshot?.answers.map(({ valueJson }) => valueJson)).toEqual(
      answers.map(({ valueJson }) => valueJson),
    );
    const sourceDump = await dumpStore(store);
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(destination, MIGRATIONS);
      const source: ExportSource = {
        readUserVersion: () => store.getUserVersion(),
        readAuthoredTable: (table, options) =>
          store.all(
            `SELECT * FROM "${table.replaceAll('"', '""')}"${options.manualOnly ? " WHERE provenance = 'manual'" : ""}`,
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
          targetUserVersion: MIGRATIONS.at(-1)!.version,
          ...webCryptoExportEnv,
        },
        { container: built.container },
      );
      expect(await dumpStore(destination)).toBe(sourceDump);
      for (const query of [
        "SELECT * FROM plan_creation ORDER BY id",
        "SELECT * FROM plan_creation_answer ORDER BY creation_id,sequence,id",
        "SELECT * FROM plan_creation_draft_revision ORDER BY creation_id,revision_number,id",
        "SELECT * FROM planning_command ORDER BY command_name,command_id",
      ]) {
        expect(await destination.all(query)).toEqual(await store.all(query));
      }
      const restoredRepository = createPlanCreationRepository(destination);
      await expect(restoredRepository.readUnfinished()).resolves.toEqual(sourceSnapshot);
      await expect(restoredRepository.recordDraft(draft)).resolves.toEqual({
        outcome: "replayed",
        snapshot: sourceSnapshot,
      });
      for (const input of answers) {
        await expect(restoredRepository.recordAnswer(input)).resolves.toEqual({
          outcome: "replayed",
          snapshot: sourceSnapshot,
        });
        expect(await dumpStore(destination)).toBe(sourceDump);
      }
      await expect(
        restoredRepository.recordAnswer({
          ...editedGoalAnswer,
          command: stamp("edit-goal", "e", 883_612_800_004),
          valueJson: goalAnswer.valueJson,
        }),
      ).rejects.toMatchObject({ code: "command-conflict" });
      expect(await dumpStore(destination)).toBe(sourceDump);
      await expect(restoredRepository.readUnfinished()).resolves.toEqual(sourceSnapshot);
    } finally {
      await destination.close();
    }
  });
});
