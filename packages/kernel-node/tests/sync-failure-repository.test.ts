import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DERIVED_TABLES,
  DUMP_TABLES,
  SYNC_FAILURE_DETAILS,
  createSyncFailureRepository,
  dumpStore,
  nextSyncFailureOrdinal,
  reduceSyncFailures,
  runMigrations,
  type MigratorStore,
  type SqlStore,
  type SyncFailureRow,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const block = (source: SyncFailureRow["source"], logical_ordinal = 1): SyncFailureRow => ({
  source,
  severity: "block",
  detail: "source synchronization failed",
  logical_ordinal,
});

describe("sync failure repository", () => {
  let store: (SqlStore & MigratorStore) | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
  });

  async function fresh(): Promise<SqlStore & MigratorStore> {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    return store;
  }

  it("accepts only the two governed sources and closed details", async () => {
    const value = await fresh();
    const repository = createSyncFailureRepository(value);
    for (const [index, detail] of SYNC_FAILURE_DETAILS.entries()) {
      await repository.upsert({
        source: index % 2 === 0 ? "intervals-icu" : "file-import",
        severity: index % 2 === 0 ? "warn" : "block",
        detail,
        logical_ordinal: index,
      });
    }
    expect(await repository.readAll()).toHaveLength(2);
  });

  it("rejects every invalid severity detail and ordinal before SQL", async () => {
    const run = vi.fn<SqlStore["run"]>();
    const repository = createSyncFailureRepository({ run } as unknown as SqlStore);
    for (const row of [
      { ...block("file-import"), source: "other" },
      { ...block("file-import"), severity: "fatal" },
      { ...block("file-import"), detail: "/synthetic/private.fit" },
      { ...block("file-import"), logical_ordinal: -1 },
      { ...block("file-import"), logical_ordinal: 8_640_000_000_000_001 },
      { ...block("file-import"), logical_ordinal: 1.5 },
      { ...block("file-import"), extra: "field" },
    ]) {
      await expect(repository.upsert(row as never)).rejects.toThrow(
        new TypeError("invalid sync failure row"),
      );
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("round trips one frozen row per source in binary source order", async () => {
    const repository = createSyncFailureRepository(await fresh());
    await repository.upsert(block("intervals-icu", 2));
    await repository.upsert({ ...block("file-import", 1), severity: "warn" });
    const rows = await repository.readAll();
    expect(rows.map((row) => row.source)).toEqual(["file-import", "intervals-icu"]);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every(Object.isFrozen)).toBe(true);
  });

  it("upserts only the addressed source", async () => {
    const repository = createSyncFailureRepository(await fresh());
    await repository.upsert(block("intervals-icu", 1));
    await repository.upsert({ ...block("file-import", 2), severity: "warn" });
    await repository.upsert({
      ...block("intervals-icu", 3),
      detail: "source temporarily unavailable",
    });
    expect(await repository.readAll()).toEqual([
      { ...block("file-import", 2), severity: "warn" },
      { ...block("intervals-icu", 3), detail: "source temporarily unavailable" },
    ]);
  });

  it("clears only the addressed source and reports absence", async () => {
    const repository = createSyncFailureRepository(await fresh());
    await repository.upsert(block("file-import"));
    await repository.upsert(block("intervals-icu"));
    await expect(repository.clear("file-import")).resolves.toBe(true);
    await expect(repository.clear("file-import")).resolves.toBe(false);
    expect((await repository.readAll()).map((row) => row.source)).toEqual(["intervals-icu"]);
    await expect(repository.clear("other" as never)).rejects.toThrow(
      new TypeError("invalid sync failure row"),
    );
  });

  it("rejects invalid selected rows", async () => {
    const invalidRows = [
      {
        source: "other",
        severity: "block",
        detail: "source synchronization failed",
        logical_ordinal: 1,
      },
      {
        source: "file-import",
        severity: "fatal",
        detail: "source synchronization failed",
        logical_ordinal: 1,
      },
      {
        source: "file-import",
        severity: "block",
        detail: "https://invalid.test/?token=value",
        logical_ordinal: 1,
      },
      {
        source: "file-import",
        severity: "block",
        detail: "source synchronization failed",
        logical_ordinal: -1,
      },
    ];
    for (const row of invalidRows) {
      const repository = createSyncFailureRepository({
        async all() {
          return [row];
        },
      } as unknown as SqlStore);
      await expect(repository.readAll()).rejects.toThrow(new TypeError("invalid sync failure row"));
    }
  });

  it("computes epoch-or-successor ordinal", () => {
    expect(nextSyncFailureOrdinal([], 10)).toBe(10);
    expect(nextSyncFailureOrdinal([block("file-import", 10)], 5)).toBe(11);
    expect(nextSyncFailureOrdinal([block("file-import", 10)], 20)).toBe(20);
    expect(() => nextSyncFailureOrdinal([], -1)).toThrow(new TypeError("invalid sync failure row"));
  });

  it("rejects duplicate source rows", () => {
    expect(() => reduceSyncFailures([block("file-import", 1), block("file-import", 2)])).toThrow(
      new TypeError("duplicate sync failure source"),
    );
  });

  it("rejects ordinal exhaustion", () => {
    expect(() => nextSyncFailureOrdinal([block("file-import", 8_640_000_000_000_000)], 1)).toThrow(
      new RangeError("sync failure ordinal exhausted"),
    );
  });

  it("reduces block before warn independent of insertion order", () => {
    const warning = { ...block("file-import", 100), severity: "warn" as const };
    const blocked = block("intervals-icu", 1);
    expect(reduceSyncFailures([warning, blocked])?.detail).toBe(
      "intervals-icu: source synchronization failed",
    );
    expect(reduceSyncFailures([blocked, warning])).toEqual(reduceSyncFailures([warning, blocked]));
  });

  it("reduces newer ordinal within one severity", () => {
    expect(reduceSyncFailures([block("file-import", 1), block("intervals-icu", 2)])?.detail).toBe(
      "intervals-icu: source synchronization failed",
    );
  });

  it("reduces lexical source on an exact tie", () => {
    expect(reduceSyncFailures([block("intervals-icu", 1), block("file-import", 1)])?.detail).toBe(
      "file-import: source synchronization failed",
    );
  });

  it("maps exact version timestamp mitigation and closed detail", () => {
    expect(
      reduceSyncFailures([
        {
          source: "file-import",
          severity: "warn",
          detail: "source data failed validation",
          logical_ordinal: 1_000,
        },
      ]),
    ).toEqual({
      schema_version: "1",
      step: "source_failure",
      detail: "file-import: source data failed validation",
      ts: "1970-01-01T00:00:01.000Z",
      mitigation: "warn_only",
    });
  });

  it("returns null for no failures", () => {
    expect(reduceSyncFailures([])).toBeNull();
  });

  it("fresh migration accepts valid rows and rejects adversarial rows", async () => {
    const value = await fresh();
    await expect(
      value.run("INSERT INTO sync_failure VALUES(?,?,?,?)", [
        "file-import",
        "block",
        "source synchronization failed",
        0,
      ]),
    ).resolves.toBeUndefined();
    await value.run("DELETE FROM sync_failure");
    for (const [source, detail] of [
      ["file-import", "/synthetic/private.fit"],
      ["file-import", "https://invalid.test/?token=value"],
      ["file-import", "bearer-token-shaped-value"],
      ["file-import", '{"athlete":"synthetic"}'],
      ["file-import", "source synchronization failed\nprivate"],
      ["unknown", "source synchronization failed"],
      ["file-import", "unknown detail"],
    ] as const) {
      await expect(
        value.run("INSERT INTO sync_failure VALUES(?,?,?,?)", [source, "block", detail, 1]),
      ).rejects.toThrow();
    }
  });

  it("upgrades a migration-six store while keeping sync failures outside the dump", async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS.slice(0, 6));
    await runMigrations(store, MIGRATIONS);
    const dump = await dumpStore(store);
    expect(dump).not.toContain("# sync_failure");
    expect(dump).toContain("# plan_reconciliation_job");
    expect(dump).toContain("# plan_reconciliation_item");
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 32 });
    expect(DUMP_TABLES).toHaveLength(70);
    expect(DERIVED_TABLES).toHaveLength(12);
    expect(DUMP_TABLES.map(({ table }) => table)).not.toContain("sync_failure");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("plan_reconciliation_job");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("plan_reconciliation_item");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("plan_workout_match");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("plan_replacement");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("plan_race_outcome");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("plan_intake");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("plan_weekly_review");
    expect(DUMP_TABLES.map(({ table }) => table)).toContain("chat_plan_outbox");
    expect(DERIVED_TABLES).not.toContain("sync_failure");
  });
});
