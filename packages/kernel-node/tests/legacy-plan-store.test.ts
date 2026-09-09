import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanningDateError, createPlanRepository } from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createAuthoredIdentity, type AthleteHome } from "../src/home/index.js";
import { createLegacyPlanRowWriter } from "../src/planning/index.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

function legacyPlan(): Record<string, unknown> {
  return {
    id: "32cc7944-facd-4b56-b1a1-7dfe43e4bfe7",
    name: "8-Week Plan",
    primaryGoal: "Gran Fondo",
    targetDate: "1998-08-30T00:00:00.000Z",
    totalWeeks: 8,
    cycleLength: 7,
    phases: [],
    createdAt: "1998-07-06T12:00:00.000Z",
    status: "draft",
  };
}

describe("legacy current Plan dual-write adapter", () => {
  let root: string;
  let home: AthleteHome;
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "plan-writer-"));
    home = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    await Promise.all([
      mkdir(join(root, "plans"), { recursive: true }),
      mkdir(home.storeDir, { recursive: true }),
      mkdir(home.archiveDir, { recursive: true }),
      mkdir(home.configDir, { recursive: true }),
    ]);
    store = openSqliteStorage(join(home.storeDir, "store.db"));
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("upserts the same row through repeated compatibility writes", async () => {
    const identity = createAuthoredIdentity(home.configDir, {
      now: () => 900,
      randomBytes: () => new Uint8Array(10).fill(4),
    });
    const repository = createPlanRepository(store);
    const writeRows = await createLegacyPlanRowWriter({
      repository,
      identity,
      fallbackDateKey: () => 19980706,
      now: () => 900,
    });
    await writeRows(legacyPlan());
    await writeRows({ ...legacyPlan(), name: "Updated Plan" });
    expect(await repository.count()).toBe(1);
    expect(await repository.readByOriginId("32cc7944-facd-4b56-b1a1-7dfe43e4bfe7")).toMatchObject({
      name: "Updated Plan",
    });
  });

  it.each([
    [
      "before today",
      "1998-07-05T00:00:00.000Z",
      "1998-08-30T00:00:00.000Z",
      new PlanningDateError("start-before-today"),
    ],
    [
      "after the target",
      "1998-08-31T00:00:00.000Z",
      "1998-08-30T00:00:00.000Z",
      new PlanningDateError("start-after-target"),
    ],
  ])(
    "rejects a new compatibility Plan starting %s",
    async (_label, startDate, targetDate, error) => {
      const identity = createAuthoredIdentity(home.configDir, {
        now: () => 900,
        randomBytes: () => new Uint8Array(10).fill(5),
      });
      const repository = createPlanRepository(store);
      const writeRows = await createLegacyPlanRowWriter({
        repository,
        identity,
        fallbackDateKey: () => 19980706,
        now: () => 900,
      });

      await expect(
        writeRows({
          ...legacyPlan(),
          id: undefined,
          startDate,
          targetDate,
        }),
      ).rejects.toEqual(error);
      await expect(repository.count()).resolves.toBe(0);
    },
  );
});
