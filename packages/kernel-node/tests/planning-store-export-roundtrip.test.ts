import { describe, expect, it } from "vitest";
import {
  buildExport,
  encodeContainer,
  EXPORT_DOCUMENT_KIND,
  EXPORT_FORMAT_VERSION,
  importExport,
  MIXED_AUTHORED_TABLES,
  PURE_AUTHORED_TABLES,
  type ArchiveManifestReader,
  type ArchivePresenceChecker,
  type AuthoredRow,
  type ExportSource,
} from "@enduragent/kernel/store/export";
import {
  createLegacyWriterFence,
  createPlanConversationRepository,
  createPlanReplacementRepository,
  createPlanRepository,
} from "@enduragent/kernel/planning";
import {
  dumpStore,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createSqliteImportSink, webCryptoExportEnv } from "@enduragent/kernel-node/store-export";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLANNING_TABLES = [
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

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const BASE_MS = 903_945_600_000;
const DEVICE_ID = "roundtrip-device-1998";
const PLAN_ID = id(1);
const FIRST_REVISION_ID = id(2);
const SECOND_REVISION_ID = id(3);
const CREATION_ID = id(4);
const ANSWER_ID = id(5);
const DRAFT_ID = id(6);
const PREFERENCE_ID = id(7);
const RESTRICTION_ID = id(8);
const CHANGE_ID = id(9);
const PREVIOUS_PLAN_ID = id(11);
const REPLACEMENT_PLAN_ID = id(12);
const CONVERSATION_ID = id(13);
const LEGACY_DRAFT_ID = id(14);
const REPLACEMENT_ID = id(15);
const CLEANUP_JOB_ID = id(16);
const LEDGER_PLAN_ID = id(17);
const LEDGER_WORKOUT_ID = id(18);
const LEDGER_ID = id(19);

const POST_V28_TABLES = new Set<string>([...PLANNING_TABLES, "plan_reconciliation_job"]);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqliteExportSource(store: SqlStore & MigratorStore): ExportSource {
  return {
    readUserVersion: () => store.getUserVersion(),
    readAuthoredTable: (table, { manualOnly }) =>
      store.all(
        `SELECT * FROM ${quoteIdentifier(table)}${manualOnly ? " WHERE provenance = 'manual'" : ""}`,
      ),
  };
}

async function buildPre29Container(store: SqlStore & MigratorStore): Promise<Uint8Array> {
  const source = sqliteExportSource(store);
  const authored: Record<string, readonly AuthoredRow[]> = {};
  for (const table of PURE_AUTHORED_TABLES) {
    const exists = await store.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
      [table],
    );
    if (exists !== undefined && !POST_V28_TABLES.has(table)) {
      authored[table] = await source.readAuthoredTable(table, { manualOnly: false });
    }
  }
  for (const table of MIXED_AUTHORED_TABLES) {
    authored[table] = await source.readAuthoredTable(table, { manualOnly: true });
  }
  return encodeContainer(
    {
      kind: EXPORT_DOCUMENT_KIND,
      formatVersion: EXPORT_FORMAT_VERSION,
      store: { userVersion: await store.getUserVersion(), authored },
      archiveManifest: [],
    },
    webCryptoExportEnv,
    {},
  );
}

function legacyPlan(idValue: string, name: string, status: "draft" | "active" | "ended") {
  return {
    id: idValue,
    originId: null,
    name,
    primaryGoal: "Complete a synthetic endurance event",
    startDateKey: 19980824,
    targetDateKey: 19981115,
    status,
    kind: "full_plan" as const,
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: '{"phases":[]}',
    createdAtMs: BASE_MS,
    updatedAtMs: BASE_MS + 1,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: BASE_MS + 1,
    hlcCounter: 0,
  };
}

async function populateV28Replacement(store: SqlStore & MigratorStore): Promise<void> {
  const plans = createPlanRepository(store);
  const conversations = createPlanConversationRepository(store);
  await plans.replace(legacyPlan(PREVIOUS_PLAN_ID, "Previous synthetic Plan", "active"), []);
  await plans.replace(legacyPlan(REPLACEMENT_PLAN_ID, "Replacement synthetic Plan", "draft"), []);
  await conversations.saveConversation({
    id: CONVERSATION_ID,
    planId: REPLACEMENT_PLAN_ID,
    replacesPlanId: PREVIOUS_PLAN_ID,
    courseChoiceStatus: "omitted",
    raceCourseJson: null,
    status: "open",
    endedAtMs: null,
    createdAtMs: BASE_MS + 2,
    updatedAtMs: BASE_MS + 2,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: BASE_MS + 2,
    hlcCounter: 0,
  });
  await conversations.saveDraftRevision({
    id: LEGACY_DRAFT_ID,
    conversationId: CONVERSATION_ID,
    planId: REPLACEMENT_PLAN_ID,
    revision: 1,
    parentRevisionId: null,
    status: "ready",
    snapshotJson: '{"weeks":12}',
    raceCourseJson: null,
    createdAtMs: BASE_MS + 3,
    updatedAtMs: BASE_MS + 3,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: BASE_MS + 3,
    hlcCounter: 0,
  });
  await createPlanReplacementRepository(store).approve({
    id: REPLACEMENT_ID,
    previousPlanId: PREVIOUS_PLAN_ID,
    replacementPlanId: REPLACEMENT_PLAN_ID,
    draftRevisionId: LEGACY_DRAFT_ID,
    expectedRevision: 1,
    cleanupJobId: CLEANUP_JOB_ID,
    windowStartDateKey: 19980824,
    windowEndDateKey: 19980830,
    updatedAtMs: BASE_MS + 4,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: BASE_MS + 4,
    hlcCounter: 0,
  });
  await store.run(
    `UPDATE plan_settings
     SET updated_at_ms=?,hlc_physical_ms=?
     WHERE plan_id IN (?,?)`,
    [BASE_MS + 4, BASE_MS + 4, PREVIOUS_PLAN_ID, REPLACEMENT_PLAN_ID],
  );
}

async function populateLegacyAdaptation(store: SqlStore & MigratorStore): Promise<void> {
  await createPlanRepository(store).replace(legacyPlan(LEDGER_PLAN_ID, "Ledger Plan", "active"), [
    {
      id: LEDGER_WORKOUT_ID,
      planId: LEDGER_PLAN_ID,
      dateKey: 19980825,
      sport: "cycling",
      name: "Synthetic endurance ride",
      durationS: 3_600,
      structureJson: '{"steps":[]}',
      origin: "coach",
      deviceId: DEVICE_ID,
      hlcPhysicalMs: BASE_MS + 2,
      hlcCounter: 0,
    },
  ]);
  await store.run(
    `INSERT INTO plan_adaptation_ledger (
      id,plan_id,target_workout_id,kind,source_id,reversal_of_id,label,before_json,after_json,
      week_load_before,week_load_after,occurred_at_ms,device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?, ?, ?, 'proposal-applied', 'synthetic-source', NULL, 'Synthetic update',
      '{"durationS":3600}', '{"durationS":4200}', 100, 110, ?, ?, ?, 0)`,
    [LEDGER_ID, LEDGER_PLAN_ID, LEDGER_WORKOUT_ID, BASE_MS + 3, DEVICE_ID, BASE_MS + 3],
  );
}

async function populatePlanningDomain(store: SqlStore): Promise<void> {
  await store.run(
    `INSERT INTO plan (
      id, origin_id, name, primary_goal, start_date_key, target_date_key, status, kind,
      total_weeks, week_start_day, structure_json, created_at_ms, updated_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, NULL, ?, ?, 19980824, 19981115, 'active', 'full_plan', 12, 1, ?, ?, ?, ?, ?, 0)`,
    [
      PLAN_ID,
      "Synthetic export Plan",
      "Build durable endurance",
      '{"schemaVersion":1}',
      BASE_MS,
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
  await store.run(
    `INSERT INTO planning_plan (
      plan_id, status, version, current_revision_number, activated_at_ms, closed_at_ms,
      close_reason, close_actor, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'active', 2, 2, ?, NULL, NULL, NULL, ?, ?, ?, 0)`,
    [PLAN_ID, BASE_MS + 3, BASE_MS + 5, DEVICE_ID, BASE_MS + 5],
  );
  await store.run(
    `INSERT INTO plan_revision (
      id, plan_id, revision_number, parent_revision_number, source_kind, source_id,
      snapshot_json, fingerprint, created_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, NULL, 'activation', ?, ?, ?, ?, ?, ?, 0)`,
    [
      FIRST_REVISION_ID,
      PLAN_ID,
      CREATION_ID,
      '{"revision":1}',
      "a".repeat(64),
      BASE_MS + 3,
      DEVICE_ID,
      BASE_MS + 3,
    ],
  );
  await store.run(
    `INSERT INTO plan_revision (
      id, plan_id, revision_number, parent_revision_number, source_kind, source_id,
      snapshot_json, fingerprint, created_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 2, 1, 'plan-change', ?, ?, ?, ?, ?, ?, 0)`,
    [
      SECOND_REVISION_ID,
      PLAN_ID,
      CHANGE_ID,
      '{"revision":2}',
      "b".repeat(64),
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
  await store.run(
    `INSERT INTO plan_creation (
      id, status, version, seed_json, current_draft_revision_number, activated_plan_id,
      created_at_ms, updated_at_ms, terminal_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'activated', 4, ?, 1, ?, ?, ?, ?, ?, ?, 0)`,
    [
      CREATION_ID,
      '{"goalDate":"1998-11-15"}',
      PLAN_ID,
      BASE_MS,
      BASE_MS + 3,
      BASE_MS + 3,
      DEVICE_ID,
      BASE_MS + 3,
    ],
  );
  await store.run(
    `INSERT INTO plan_creation_answer (
      id, creation_id, sequence, creation_version, answer_key, value_json, scope,
      preference_id, confirmed_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, 2, 'weekly-availability', ?, 'athlete-preference', ?, ?, ?, ?, 0)`,
    [ANSWER_ID, CREATION_ID, '{"sessions":4}', PREFERENCE_ID, BASE_MS + 1, DEVICE_ID, BASE_MS + 1],
  );
  await store.run(
    `INSERT INTO plan_creation_draft_revision (
      id, creation_id, revision_number, parent_revision_number, input_version,
      input_snapshot_json, input_fingerprint, builder_id, builder_version,
      output_snapshot_json, activation_fingerprint, created_at_ms, device_id,
      hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, NULL, 2, ?, ?, 'roundtrip-builder', '1', ?, ?, ?, ?, ?, 0)`,
    [
      DRAFT_ID,
      CREATION_ID,
      '{"answerVersion":2}',
      "c".repeat(64),
      '{"revision":1}',
      "a".repeat(64),
      BASE_MS + 2,
      DEVICE_ID,
      BASE_MS + 2,
    ],
  );
  await store.run(
    `INSERT INTO athlete_preference (
      id, preference_key, value_json, status, version, source_answer_id, created_at_ms,
      updated_at_ms, removed_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'weekly-availability', ?, 'active', 1, ?, ?, ?, NULL, ?, ?, 0)`,
    [PREFERENCE_ID, '{"sessions":4}', ANSWER_ID, BASE_MS + 1, BASE_MS + 1, DEVICE_ID, BASE_MS + 1],
  );
  await store.run(
    `INSERT INTO training_restriction (
      id, kind, status, version, start_date_key, end_date_key, maximum_duration_minutes,
      confirmed_at_ms, created_at_ms, updated_at_ms, ended_at_ms, device_id,
      hlc_physical_ms, hlc_counter
    ) VALUES (?, 'maximum-duration', 'active', 1, 19980824, 19980830, 90, ?, ?, ?, NULL, ?, ?, 0)`,
    [RESTRICTION_ID, BASE_MS, BASE_MS, BASE_MS, DEVICE_ID, BASE_MS],
  );
  await store.run(
    `INSERT INTO plan_change (
      id, plan_id, status, version, base_revision_number, result_revision_number,
      diff_json, rationale, premises_json, preview_fingerprint,
      reconciliation_effect_json, created_at_ms, updated_at_ms, terminal_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 'applied', 2, 1, 2, ?, 'Add recovery after the long ride', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      CHANGE_ID,
      PLAN_ID,
      '{"replace":["1998-08-30"]}',
      '[{"kind":"fatigue"}]',
      "d".repeat(64),
      '{"reschedule":true}',
      BASE_MS + 4,
      BASE_MS + 5,
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
  await store.run(
    `INSERT INTO planning_command (
      command_name, command_id, request_digest, status, aggregate_refs_json,
      result_json, error_code, error_json, version, created_at_ms, updated_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES ('plan_change.apply', ?, ?, 'succeeded', ?, ?, NULL, NULL, 2, ?, ?, ?, ?, 0)`,
    [
      id(10),
      "e".repeat(64),
      JSON.stringify({ changeId: CHANGE_ID, planId: PLAN_ID }),
      JSON.stringify({ revisionNumber: 2 }),
      BASE_MS + 4,
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
}

const emptyManifest: ArchiveManifestReader = {
  listArtifacts: async () => [],
};

const completePresence: ArchivePresenceChecker = {
  hasArtifact: async () => true,
};

describe("planning-domain SQLite export round-trip", () => {
  it.each([
    { sourceVersion: 31, expectedInstant: BASE_MS },
    { sourceVersion: 32, expectedInstant: BASE_MS - 1 },
  ])(
    "restores Chat ownership from a v$sourceVersion archive",
    async ({ sourceVersion, expectedInstant }) => {
      const source = openSqliteStorage(":memory:");
      const destination = openSqliteStorage(":memory:");
      try {
        await runMigrations(source, MIGRATIONS.slice(0, sourceVersion));
        await runMigrations(destination, MIGRATIONS);
        for (const offset of [2, 0]) {
          await source.run(
            `INSERT INTO plan_creation (
            id, status, version, seed_json, current_draft_revision_number, activated_plan_id,
            created_at_ms, updated_at_ms, terminal_at_ms, device_id, hlc_physical_ms, hlc_counter
          ) VALUES (?, 'discarded', 2, '{}', NULL, NULL, ?, ?, ?, ?, ?, 0)`,
            [
              id(20 + offset),
              BASE_MS + offset,
              BASE_MS + offset + 1,
              BASE_MS + offset + 1,
              DEVICE_ID,
              BASE_MS + offset + 1,
            ],
          );
        }
        const authored: Record<string, readonly AuthoredRow[]> = {
          plan_creation: await source.all(
            "SELECT * FROM plan_creation ORDER BY created_at_ms DESC",
          ),
        };
        if (sourceVersion === 32) {
          await source.run(
            "UPDATE planning_authority SET chat_authority_since_ms = ? WHERE singleton = 1",
            [expectedInstant],
          );
          authored.planning_authority = await source.all("SELECT * FROM planning_authority");
        }
        const container = await encodeContainer(
          {
            kind: EXPORT_DOCUMENT_KIND,
            formatVersion: EXPORT_FORMAT_VERSION,
            store: { userVersion: await source.getUserVersion(), authored },
            archiveManifest: [],
          },
          webCryptoExportEnv,
          {},
        );

        await importExport(
          {
            sink: createSqliteImportSink(destination),
            presence: completePresence,
            targetUserVersion: 32,
            ...webCryptoExportEnv,
          },
          { container },
        );

        await expect(
          destination.all("SELECT * FROM plan_creation ORDER BY created_at_ms DESC"),
        ).resolves.toEqual(authored.plan_creation);
        await expect(
          destination.get("SELECT MIN(created_at_ms) AS instant FROM plan_creation"),
        ).resolves.toEqual({ instant: BASE_MS });
        await expect(
          destination.get(
            "SELECT chat_authority_since_ms FROM planning_authority WHERE singleton = 1",
          ),
        ).resolves.toEqual({ chat_authority_since_ms: expectedInstant });
        await expect(createLegacyWriterFence(destination).fenced()).resolves.toBe(true);
      } finally {
        await source.close();
        await destination.close();
      }
    },
  );

  it("restores a legacy conversation after Chat authority has started", async () => {
    const source = openSqliteStorage(":memory:");
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(source, MIGRATIONS.slice(0, 28));
      await runMigrations(destination, MIGRATIONS);
      await populateV28Replacement(source);
      await destination.run(
        "UPDATE planning_authority SET chat_authority_since_ms = ? WHERE singleton = 1",
        [BASE_MS],
      );
      expect(await createLegacyWriterFence(destination).fenced()).toBe(true);
      const container = await buildPre29Container(source);

      await importExport(
        {
          sink: createSqliteImportSink(destination),
          presence: completePresence,
          targetUserVersion: 32,
          ...webCryptoExportEnv,
        },
        { container },
      );

      for (const table of ["plan_conversation", "plan_draft_revision"]) {
        expect(await destination.all(`SELECT * FROM ${table}`)).toEqual(
          await source.all(`SELECT * FROM ${table}`),
        );
      }
      expect(
        await destination.get(
          "SELECT chat_authority_since_ms FROM planning_authority WHERE singleton = 1",
        ),
      ).toEqual({ chat_authority_since_ms: BASE_MS });
      expect(await createLegacyWriterFence(destination).fenced()).toBe(true);
      expect(await destination.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it("restores a v28 replacement lineage without its derived cleanup table", async () => {
    const source = openSqliteStorage(":memory:");
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(source, MIGRATIONS.slice(0, 28));
      await runMigrations(destination, MIGRATIONS);
      await populateV28Replacement(source);
      const container = await buildPre29Container(source);

      await expect(
        importExport(
          {
            sink: createSqliteImportSink(destination),
            presence: completePresence,
            targetUserVersion: 32,
            ...webCryptoExportEnv,
          },
          { container },
        ),
      ).resolves.toBeDefined();
      await expect(
        destination.get(
          "SELECT previous_plan_id,replacement_plan_id,cleanup_job_id FROM plan_replacement WHERE id=?",
          [REPLACEMENT_ID],
        ),
      ).resolves.toEqual({
        previous_plan_id: PREVIOUS_PLAN_ID,
        replacement_plan_id: REPLACEMENT_PLAN_ID,
        cleanup_job_id: CLEANUP_JOB_ID,
      });
      await expect(
        destination.get(
          "SELECT plan_id,kind,status,window_start_date_key,window_end_date_key,completed_at_ms FROM plan_reconciliation_job WHERE id=?",
          [CLEANUP_JOB_ID],
        ),
      ).resolves.toEqual({
        plan_id: PREVIOUS_PLAN_ID,
        kind: "cleanup",
        status: "verified",
        window_start_date_key: 19980824,
        window_end_date_key: 19981115,
        completed_at_ms: BASE_MS + 4,
      });
      await expect(destination.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it.each([21, 27])("restores migration-028 adaptation rows from v%i", async (sourceVersion) => {
    const source = openSqliteStorage(":memory:");
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(source, MIGRATIONS.slice(0, sourceVersion));
      await runMigrations(destination, MIGRATIONS);
      await populateLegacyAdaptation(source);
      const container = await buildPre29Container(source);

      await expect(
        importExport(
          {
            sink: createSqliteImportSink(destination),
            presence: completePresence,
            targetUserVersion: 32,
            ...webCryptoExportEnv,
          },
          { container },
        ),
      ).resolves.toBeDefined();
      await expect(
        destination.get("SELECT operation FROM plan_adaptation_ledger WHERE id=?", [LEDGER_ID]),
      ).resolves.toEqual({ operation: "update" });
      await expect(destination.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it("restores all nine tables with valid links and is idempotent", async () => {
    const source = openSqliteStorage(":memory:");
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(source, MIGRATIONS);
      await runMigrations(destination, MIGRATIONS);
      await populatePlanningDomain(source);
      await source.run(
        "UPDATE planning_authority SET chat_authority_since_ms = (SELECT MIN(created_at_ms) FROM plan_creation) WHERE singleton = 1",
      );
      await populateV28Replacement(source);
      const sourceDump = await dumpStore(source);
      const built = await buildExport(
        {
          source: sqliteExportSource(source),
          manifest: emptyManifest,
          ...webCryptoExportEnv,
        },
        {},
      );

      for (const table of PLANNING_TABLES) {
        expect(built.tables.find((entry) => entry.table === table)?.count).toBeGreaterThan(0);
      }
      expect(
        built.tables.find((entry) => entry.table === "plan_reconciliation_job")?.count,
      ).toBeGreaterThan(0);

      const first = await importExport(
        {
          sink: createSqliteImportSink(destination),
          presence: completePresence,
          targetUserVersion: 32,
          ...webCryptoExportEnv,
        },
        { container: built.container },
      );

      for (const table of PLANNING_TABLES) {
        expect(first.restored.find((entry) => entry.table === table)?.inserted).toBeGreaterThan(0);
      }
      expect(await dumpStore(destination)).toBe(sourceDump);
      expect(await destination.all("PRAGMA foreign_key_check")).toEqual([]);

      const second = await importExport(
        {
          sink: createSqliteImportSink(destination),
          presence: completePresence,
          targetUserVersion: 32,
          ...webCryptoExportEnv,
        },
        { container: built.container },
      );

      expect(second.restored.reduce((total, entry) => total + entry.inserted, 0)).toBe(0);
      for (const table of PLANNING_TABLES) {
        expect(second.restored.find((entry) => entry.table === table)?.skipped).toBeGreaterThan(0);
      }
      expect(await dumpStore(destination)).toBe(sourceDump);
      expect(await destination.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await source.close();
      await destination.close();
    }
  });

  it("rejects a current replacement archive when its cleanup parent is missing", async () => {
    const source = openSqliteStorage(":memory:");
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(source, MIGRATIONS.slice(0, 28));
      await runMigrations(destination, MIGRATIONS);
      await populateV28Replacement(source);
      await source.setUserVersion(29);
      const container = await buildPre29Container(source);

      await expect(
        importExport(
          {
            sink: createSqliteImportSink(destination),
            presence: completePresence,
            targetUserVersion: 32,
            ...webCryptoExportEnv,
          },
          { container },
        ),
      ).rejects.toThrow(/FOREIGN KEY/u);
      await expect(destination.get("SELECT id FROM plan_replacement")).resolves.toBeUndefined();
      await expect(
        destination.get("SELECT id FROM plan_reconciliation_job"),
      ).resolves.toBeUndefined();
    } finally {
      await source.close();
      await destination.close();
    }
  });
});
