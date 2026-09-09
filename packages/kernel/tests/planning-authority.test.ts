import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations/index.js";

let db: DatabaseSync | undefined;

function openStore(version = 32): DatabaseSync {
  const store = new DatabaseSync(":memory:");
  store.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= version)) {
    store.exec(migration.sql);
  }
  db = store;
  return store;
}

afterEach(() => db?.close());

describe("planning authority", () => {
  it("seeds one unset STRICT singleton and prevents deletion or reinsertion", () => {
    const store = openStore();
    expect(store.prepare("SELECT * FROM planning_authority").all()).toEqual([
      {
        singleton: 1,
        chat_authority_since_ms: null,
        device_id: null,
        hlc_physical_ms: null,
        hlc_counter: null,
      },
    ]);
    expect(store.prepare("PRAGMA table_list").all()).toContainEqual(
      expect.objectContaining({ name: "planning_authority", strict: 1 }),
    );
    expect(() => store.exec("DELETE FROM planning_authority")).toThrow(
      "planning authority is durable",
    );
    for (const singleton of [1, 2]) {
      expect(() =>
        store.prepare("INSERT INTO planning_authority (singleton) VALUES (?)").run(singleton),
      ).toThrow("planning authority already exists");
    }
    expect(() =>
      store.exec("INSERT OR REPLACE INTO planning_authority (singleton) VALUES (1)"),
    ).toThrow("planning authority already exists");
    expect(() => store.exec("UPDATE planning_authority SET singleton = 2")).toThrow();
    expect(() =>
      store.exec("UPDATE planning_authority SET chat_authority_since_ms = -1"),
    ).toThrow();
  });

  it("allows the first instant and new stamps while refusing release or a different instant", () => {
    const store = openStore();
    store.exec(
      "UPDATE planning_authority SET chat_authority_since_ms = 0, device_id = 'device-1', hlc_physical_ms = 1, hlc_counter = 0",
    );
    for (const instant of [null, 2]) {
      expect(() =>
        store.prepare("UPDATE planning_authority SET chat_authority_since_ms = ?").run(instant),
      ).toThrow("Chat planning authority cannot change");
    }
    store.exec(
      "UPDATE planning_authority SET chat_authority_since_ms = 0, device_id = 'device-2', hlc_physical_ms = 2, hlc_counter = 1",
    );
    expect(store.prepare("SELECT * FROM planning_authority").get()).toEqual({
      singleton: 1,
      chat_authority_since_ms: 0,
      device_id: "device-2",
      hlc_physical_ms: 2,
      hlc_counter: 1,
    });
  });

  it("backfills the earliest creation even when all creations were discarded", () => {
    const store = openStore(31);
    const insert = store.prepare(`INSERT INTO plan_creation (
      id,status,version,seed_json,current_draft_revision_number,activated_plan_id,
      created_at_ms,updated_at_ms,terminal_at_ms,device_id,hlc_physical_ms,hlc_counter
    ) VALUES (?, 'discarded', 2, '{}', NULL, NULL, ?, ?, ?, 'device-1', ?, 0)`);
    insert.run("1".repeat(26), 20, 21, 21, 21);
    insert.run("2".repeat(26), 10, 11, 11, 11);
    const migration = MIGRATIONS.find((entry) => entry.version === 32);
    expect(migration).toBeDefined();
    store.exec(migration!.sql);
    expect(store.prepare("SELECT * FROM planning_authority").get()).toEqual({
      singleton: 1,
      chat_authority_since_ms: 10,
      device_id: null,
      hlc_physical_ms: null,
      hlc_counter: null,
    });
  });
});
