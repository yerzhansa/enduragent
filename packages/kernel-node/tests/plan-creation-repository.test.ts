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

  it("round-trips real rows through dump, export, and restore", async () => {
    await start();
    await answer();
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
          targetUserVersion: 29,
          ...webCryptoExportEnv,
        },
        { container: built.container },
      );
      expect(await dumpStore(destination)).toBe(await dumpStore(store));
      await expect(
        createPlanCreationRepository(destination).readUnfinished(),
      ).resolves.toMatchObject({ id: creationId, version: 2, answers: [{ id: id("3") }] });
    } finally {
      await destination.close();
    }
  });
});
