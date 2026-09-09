import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlanRepository } from "@enduragent/kernel/planning";
import {
  DUMP_TABLES,
  createAnchorRepository,
  dumpStore,
  runMigrations,
  StoreNewerThanAppError,
  type AnchorHistoryRow,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

describe("migrator end-to-end over node:sqlite", () => {
  let dir: string;
  let store: SqlStore & MigratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "kn-"));
    store = openSqliteStorage(join(dir, "store.db"));
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies the full migration list and advances user_version to 32", async () => {
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 32 });

    const tables = await store.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(tables.map((r) => r.name as string));
    for (const { table } of DUMP_TABLES) {
      expect(names.has(table)).toBe(true);
    }

    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(
      await store.all("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer"),
    ).toEqual([]);
    expect(
      await store.get(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dedup_confirmation_effective'",
      ),
    ).toEqual({ name: "idx_dedup_confirmation_effective" });
    expect(await store.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    expect(await store.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 32 });
  });

  it("upgrades the released Plan version 24 schema through the current schema", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 24));
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 24 });
    expect(
      await store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_intake'"),
    ).toEqual({ name: "plan_intake" });

    await expect(runMigrations(store, MIGRATIONS)).resolves.toEqual({
      fromVersion: 24,
      toVersion: 32,
      applied: [25, 26, 27, 28, 29, 30, 31, 32],
    });
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 32 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_attachment','planning_request','chat_plan_outbox') ORDER BY name",
      ),
    ).resolves.toEqual([
      { name: "chat_attachment" },
      { name: "chat_plan_outbox" },
      { name: "planning_request" },
    ]);
    await expect(store.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("produces a deterministic INV-2 dump of a fixed state", async () => {
    await runMigrations(store, MIGRATIONS);
    const repo = createAnchorRepository(store);
    const row: AnchorHistoryRow = {
      id: "anchor-e2e",
      sport: "cycling",
      anchor_type: "ftp",
      value: 250.5,
      unit: "W",
      valid_from: 1000,
      source: "manual",
      confidence: "manual",
      note: null,
      provenance: "manual",
      device_id: null,
      hlc_physical_ms: null,
      hlc_counter: null,
    };
    await repo.insertIfAbsent(row);

    const dump = await dumpStore(store);
    expect(dump).toContain("# anchor_history");
    expect(dump).toContain("anchor-e2e");
    expect(await dumpStore(store)).toBe(dump);
  });

  it("upgrades a version-1-on-disk store to version 32", async () => {
    await runMigrations(store, [MIGRATIONS[0]!]);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 32 });
    expect(await store.get("SELECT singleton,ingest_version FROM ingest_metadata")).toEqual({
      singleton: 1,
      ingest_version: 0,
    });
    expect(
      await store.all("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer"),
    ).toEqual([]);
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("upgrades an existing version-4 store and backfills legacy source records", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 4));
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 4 });
    await store.run(
      "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json) VALUES(?,?,?,?,?,?,?,?)",
      ["legacy-source", null, null, "intervals-icu", "42", null, 300, '{"v":1}'],
    );

    const result = await runMigrations(store, MIGRATIONS);
    expect(result).toEqual({
      fromVersion: 4,
      toVersion: 32,
      applied: [
        5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
        29, 30, 31, 32,
      ],
    });
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 32 });
    expect(
      await store.get("SELECT revision_id,source_record_id FROM source_record_revision"),
    ).toEqual({
      revision_id: "legacy-source",
      source_record_id: "legacy-source",
    });
    expect(
      await store.get("SELECT source_record_id,revision_id FROM source_record_current"),
    ).toEqual({
      source_record_id: "legacy-source",
      revision_id: "legacy-source",
    });
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("rolls back an injected migration-005 failure to version 4 without 005 objects", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 4));
    const broken005 = {
      ...MIGRATIONS[4]!,
      sql: `${MIGRATIONS[4]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 4), broken005])).rejects.toThrow();

    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 4 });
    const objects = await store.all(
      "SELECT name FROM sqlite_master WHERE name IN ('source_artifact','source_record_revision','source_record_current','source_watermark','sync_operation')",
    );
    expect(objects).toEqual([]);
    const columns = await store.all("PRAGMA table_info(source_record)");
    expect(columns.some((row) => row.name === "artifact_key")).toBe(false);
  });

  it("rolls back an injected migration-007 failure to version 6 without a partial table", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 6));
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 6 });
    const broken007 = {
      ...MIGRATIONS[6]!,
      sql: `${MIGRATIONS[6]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 6), broken007])).rejects.toThrow();
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 6 });
    expect(
      await store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_failure'"),
    ).toBeUndefined();
  });

  it("upgrades a version-6 store through the current schema and reruns as a no-op", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 6));
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 6 });
    const result = await runMigrations(store, MIGRATIONS);
    expect(result).toEqual({
      fromVersion: 6,
      toVersion: 32,
      applied: [
        7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
        31, 32,
      ],
    });
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 32 });
    expect(
      await store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_failure'"),
    ).toEqual({ name: "sync_failure" });
    await expect(runMigrations(store, MIGRATIONS)).resolves.toEqual({
      fromVersion: 32,
      toVersion: 32,
      applied: [],
    });
  });

  it("upgrades version 11 through 32 while preserving existing rows", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 11));
    await store.run("INSERT INTO repair_fixer_settings(fixer,enabled) VALUES(?,?)", [
      "chronoBridge",
      1,
    ]);

    await expect(runMigrations(store, MIGRATIONS)).resolves.toEqual({
      fromVersion: 11,
      toVersion: 32,
      applied: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
    });
    await expect(store.get("SELECT fixer,enabled FROM repair_fixer_settings")).resolves.toEqual({
      fixer: "chronoBridge",
      enabled: 1,
    });
    await expect(store.get("SELECT count(*) AS count FROM repair_fixer_settings")).resolves.toEqual(
      { count: 1 },
    );
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 32 });
  });

  it("rolls back a failed migration 12 without partial Planning tables", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 11));
    await store.run("INSERT INTO repair_fixer_settings(fixer,enabled) VALUES(?,?)", [
      "pulseWeave",
      1,
    ]);
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[11]!,
      sql: `${MIGRATIONS[11]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 11), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 11 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan','plan_workout')",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
    await expect(store.get("SELECT fixer,enabled FROM repair_fixer_settings")).resolves.toEqual({
      fixer: "pulseWeave",
      enabled: 1,
    });
  });

  it("rolls back a failed migration 13 without partial Plan conversation tables", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 12));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[12]!,
      sql: `${MIGRATIONS[12]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 12), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 12 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan_conversation','plan_conversation_turn','plan_draft_revision','plan_source_request') ORDER BY name",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("rolls back a failed migration 14 without partial reconciliation tables", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 13));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[13]!,
      sql: `${MIGRATIONS[13]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 13), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 13 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan_reconciliation_job','plan_reconciliation_item') ORDER BY name",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("rolls back a failed migration 24 without partial Plan intake storage", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 23));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[23]!,
      sql: `${MIGRATIONS[23]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };

    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 23), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 23 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan_intake','plan_draft_build_checkpoint') ORDER BY name",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan','plan_workout','plan_race_outcome') ORDER BY name",
      ),
    ).resolves.toEqual([{ name: "plan" }, { name: "plan_race_outcome" }, { name: "plan_workout" }]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("upgrades released Plan migration 24 to attachment migration 25", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 24));

    await expect(runMigrations(store, MIGRATIONS.slice(0, 25))).resolves.toEqual({
      fromVersion: 24,
      toVersion: 25,
      applied: [25],
    });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chat_attachment%' ORDER BY name",
      ),
    ).resolves.toEqual([
      { name: "chat_attachment" },
      { name: "chat_attachment_draft" },
      { name: "chat_attachment_draft_ref" },
      { name: "chat_attachment_object" },
    ]);
    await expect(
      store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_intake'"),
    ).resolves.toEqual({ name: "plan_intake" });
    await expect(store.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("rolls back a failed migration 25 without partial attachment storage", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 24));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[24]!,
      sql: `${MIGRATIONS[24]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };

    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 24), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 24 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chat_attachment%' ORDER BY name",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("upgrades attachment migration 25 to Planning request migration 26", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 25));
    await store.run(
      `INSERT INTO chat_attachment_object (
  id, conversation_id, conversation_key, sha256, byte_size, relative_path,
  status, failure_code, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "object-1",
        "chat-1",
        "b".repeat(64),
        "a".repeat(64),
        4,
        "objects/object-1",
        "durable",
        null,
        1,
        1,
      ],
    );

    await expect(runMigrations(store, MIGRATIONS.slice(0, 26))).resolves.toEqual({
      fromVersion: 25,
      toVersion: 26,
      applied: [26],
    });
    await expect(store.get("SELECT id FROM chat_attachment_object")).resolves.toEqual({
      id: "object-1",
    });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'planning_request%' ORDER BY name",
      ),
    ).resolves.toEqual([
      { name: "planning_request" },
      { name: "planning_request_terminal_result" },
      { name: "planning_request_tombstone" },
    ]);
    await expect(store.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("rolls back a failed migration 26 without partial Planning request storage", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 25));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[25]!,
      sql: `${MIGRATIONS[25]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };

    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 25), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 25 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'planning_request%' ORDER BY name",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("upgrades Planning request migration 26 to Chat outbox migration 27", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 26));
    await store.run(
      `INSERT INTO planning_request (
  request_id, kind, target, intent, payload_hash, payload_json, source_status,
  source_chat_id, source_message_id, source_attachment_id, provenance_json,
  plan_conversation_id, proposal_id, requested_date_key, resolved_date_key,
  lifecycle, attention, revision, created_at_ms, updated_at_ms,
  device_id, hlc_physical_ms, hlc_counter
) VALUES (?, 'plan_question', 'active_plan', ?, ?, ?, 'linked', ?, ?, NULL, NULL,
  NULL, NULL, NULL, NULL, 'open', 'none', 1, 1, 1, 'device-1', 1, 0)`,
      ["request-1", "Review next week.", "a".repeat(64), "{}", "chat-1", "message-1"],
    );

    await expect(runMigrations(store, MIGRATIONS.slice(0, 27))).resolves.toEqual({
      fromVersion: 26,
      toVersion: 27,
      applied: [27],
    });
    await expect(store.get("SELECT request_id FROM planning_request")).resolves.toEqual({
      request_id: "request-1",
    });
    await expect(
      store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_plan_outbox'"),
    ).resolves.toEqual({ name: "chat_plan_outbox" });
    await expect(store.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("upgrades migration 27 to 28 with reversible Plan Workout addition columns", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 27));
    const planId = `${"0".repeat(25)}1`;
    const workoutId = `${"0".repeat(25)}2`;
    await createPlanRepository(store).replace(
      {
        id: planId,
        originId: null,
        name: "Migration Plan",
        primaryGoal: "Finish",
        startDateKey: 20260824,
        targetDateKey: null,
        status: "active",
        kind: "short_race_preparation",
        totalWeeks: 4,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 1,
        updatedAtMs: 10,
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
      [
        {
          id: workoutId,
          planId,
          dateKey: 20260830,
          sport: "cycling",
          name: "Endurance",
          durationS: 5_400,
          structureJson: "{}",
          origin: "coach",
          deviceId: "device-1",
          hlcPhysicalMs: 10,
          hlcCounter: 0,
        },
      ],
    );
    const snapshot = JSON.stringify({
      dateKey: 20260830,
      sport: "cycling",
      name: "Endurance",
      durationS: 5_400,
      structureJson: "{}",
      origin: "coach",
    });
    await store.run(
      `INSERT INTO plan_adaptation_ledger (
  id, plan_id, target_workout_id, kind, source_id, reversal_of_id, label,
  before_json, after_json, week_load_before, week_load_after, occurred_at_ms,
  device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, 'proposal-applied', ?, NULL, ?, ?, ?, NULL, NULL, 10, 'device-1', 10, 0)`,
      [
        `${"0".repeat(25)}3`,
        planId,
        workoutId,
        `${"0".repeat(25)}4`,
        "Applied",
        snapshot,
        snapshot,
      ],
    );

    await expect(runMigrations(store, MIGRATIONS.slice(0, 28))).resolves.toEqual({
      fromVersion: 27,
      toVersion: 28,
      applied: [28],
    });
    const columns = await store.all("PRAGMA table_info(plan_adaptation_ledger)");
    await expect(columns.find((column) => column.name === "operation")).toMatchObject({
      name: "operation",
      notnull: 1,
    });
    await expect(columns.find((column) => column.name === "before_json")).toMatchObject({
      name: "before_json",
      notnull: 0,
    });
    await expect(
      store.get(
        "SELECT operation, before_json, after_json FROM plan_adaptation_ledger WHERE target_workout_id=?",
        [workoutId],
      ),
    ).resolves.toEqual({ operation: "update", before_json: snapshot, after_json: snapshot });
    await expect(store.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("rolls back a failed migration 27 without partial Chat outbox storage", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 26));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[26]!,
      sql: `${MIGRATIONS[26]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };

    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 26), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 26 });
    await expect(
      store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_plan_outbox'"),
    ).resolves.toBeUndefined();
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("rolls back a failed migration 28 without replacing the adaptation ledger", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 27));
    const columnsBefore = await store.all("PRAGMA table_info(plan_adaptation_ledger)");
    const broken = {
      ...MIGRATIONS[27]!,
      sql: `${MIGRATIONS[27]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };

    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 27), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 27 });
    await expect(store.all("PRAGMA table_info(plan_adaptation_ledger)")).resolves.toEqual(
      columnsBefore,
    );
    await expect(
      store.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='plan_adaptation_ledger_v26'",
      ),
    ).resolves.toBeUndefined();
  });

  it("upgrades migration 28 through 32 without classifying legacy Planning rows", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 28));
    const planId = `${"0".repeat(25)}A`;
    const workoutId = `${"0".repeat(25)}B`;
    const conversationId = `${"0".repeat(25)}C`;
    const turnId = `${"0".repeat(25)}D`;
    const draftId = `${"0".repeat(25)}E`;
    const proposalId = `${"0".repeat(25)}F`;

    await createPlanRepository(store).replace(
      {
        id: planId,
        originId: null,
        name: "Legacy Plan",
        primaryGoal: "Finish",
        startDateKey: 19980824,
        targetDateKey: null,
        status: "active",
        kind: "short_race_preparation",
        totalWeeks: 4,
        weekStartDay: 1,
        structureJson: '{"source":"legacy"}',
        createdAtMs: 1,
        updatedAtMs: 10,
        deviceId: "device-1",
        hlcPhysicalMs: 10,
        hlcCounter: 0,
      },
      [
        {
          id: workoutId,
          planId,
          dateKey: 19980830,
          sport: "cycling",
          name: "Endurance",
          durationS: 5_400,
          structureJson: "{}",
          origin: "coach",
          deviceId: "device-1",
          hlcPhysicalMs: 10,
          hlcCounter: 0,
        },
      ],
    );
    await store.run(
      `INSERT INTO plan_conversation (
  id, plan_id, replaces_plan_id, status, ended_at_ms, created_at_ms, updated_at_ms,
  device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, NULL, 'ended', 12, 11, 12, 'device-1', 12, 0)`,
      [conversationId, planId],
    );
    await store.run(
      `INSERT INTO plan_conversation_turn (
  id, conversation_id, sequence, athlete_text, coach_text, lineage_json,
  completed_at_ms, device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, 1, 'Build a plan.', 'Draft ready.', '{}', 12, 'device-1', 12, 0)`,
      [turnId, conversationId],
    );
    await store.run(
      `INSERT INTO plan_draft_revision (
  id, conversation_id, plan_id, revision, parent_revision_id, parent_revision,
  status, snapshot_json, created_at_ms, updated_at_ms, device_id,
  hlc_physical_ms, hlc_counter
) VALUES (?, ?, ?, 1, NULL, NULL, 'approved', '{}', 11, 12, 'device-1', 12, 0)`,
      [draftId, conversationId, planId],
    );
    await store.run(
      `INSERT INTO plan_proposal (
  id, plan_id, parent_proposal_id, revision, status, title, rationale, confidence,
  mutation_json, base_snapshot_json, refusal_reason, created_at_ms, updated_at_ms,
  resolved_at_ms, device_id, hlc_physical_ms, hlc_counter
) VALUES (?, ?, NULL, 1, 'proposed', 'Adjust volume', 'Recovery needed', 'Moderate',
  '{}', '{}', NULL, 13, 13, NULL, 'device-1', 13, 0)`,
      [proposalId, planId],
    );

    const legacyTables = [
      "plan",
      "plan_workout",
      "plan_conversation",
      "plan_conversation_turn",
      "plan_draft_revision",
      "plan_proposal",
    ] as const;
    const rowsBefore = await Promise.all(
      legacyTables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY 1`)),
    );

    await expect(runMigrations(store, MIGRATIONS)).resolves.toEqual({
      fromVersion: 28,
      toVersion: 32,
      applied: [29, 30, 31, 32],
    });
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 32 });
    await expect(
      Promise.all(legacyTables.map((table) => store.all(`SELECT * FROM ${table} ORDER BY 1`))),
    ).resolves.toEqual(rowsBefore);

    const targetTables = [
      "planning_plan",
      "plan_revision",
      "plan_creation",
      "plan_creation_answer",
      "plan_creation_draft_revision",
      "athlete_preference",
      "training_restriction",
      "plan_change",
      "planning_command",
    ] as const;
    for (const table of targetTables) {
      await expect(store.get(`SELECT count(*) AS count FROM ${table}`)).resolves.toEqual({
        count: 0,
      });
    }
    await expect(store.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("rolls back a failed migration 29 without partial Planning domain storage", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 28));
    const schemaBefore = await store.all(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    );
    const broken = {
      ...MIGRATIONS[28]!,
      sql: `${MIGRATIONS[28]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };

    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 28), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 28 });
    await expect(
      store.all(
        `SELECT name FROM sqlite_master
WHERE type='table'
  AND name IN (
    'planning_plan',
    'plan_revision',
    'plan_creation',
    'plan_creation_answer',
    'plan_creation_draft_revision',
    'athlete_preference',
    'training_restriction',
    'plan_change',
    'planning_command'
  )
ORDER BY name`,
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"),
    ).resolves.toEqual(schemaBefore);
  });

  it("preserves an existing cursor and leaves its store owner unset", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 7));
    await store.run("INSERT INTO source_watermark(source,lane,watermark) VALUES(?,?,?)", [
      "intervals-icu",
      "bulk-fit",
      "legacy-cursor",
    ]);

    await runMigrations(store, MIGRATIONS);

    expect(await store.get("SELECT watermark FROM source_watermark")).toEqual({
      watermark: "legacy-cursor",
    });
    expect(await store.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 0 });
  });

  it("shares one real transaction for exec + version bump (atomic rollback)", async () => {
    const migrations = [
      { version: 1, sql: "CREATE TABLE first_ok (a TEXT);" },
      {
        version: 2,
        sql: "CREATE TABLE second_partial (a TEXT); INSERT INTO nonexistent VALUES (1);",
      },
    ];
    await expect(runMigrations(store, migrations)).rejects.toThrow();

    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    const tables = await store.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(tables.map((r) => r.name as string));
    expect(names.has("first_ok")).toBe(true);
    expect(names.has("second_partial")).toBe(false);
  });

  it("refuses a newer store without changing bytes or creating sidecars", async () => {
    const path = join(dir, "newer.db");
    const maximum = MIGRATIONS.at(-1)!.version;
    const seed = openSqliteStorage(path);
    await seed.setUserVersion(maximum + 1);
    await seed.close();
    const beforeNames = (await readdir(dir)).sort();
    const beforeHash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");

    const refused = openSqliteStorage(path);
    const error = await runMigrations(refused, MIGRATIONS).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(StoreNewerThanAppError);
    expect(error).toMatchObject({
      storeVersion: maximum + 1,
      appMaxVersion: maximum,
      message: "store is newer than this app",
    });
    await refused.close();

    expect((await readdir(dir)).sort()).toEqual(beforeNames);
    expect(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ).toBe(beforeHash);
    expect(beforeNames).not.toContain("newer.db-wal");
    expect(beforeNames).not.toContain("newer.db-shm");
  });
});
