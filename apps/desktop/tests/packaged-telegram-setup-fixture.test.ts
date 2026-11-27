import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { preparePackagedTelegramSetupFixture } from "../scripts/support/packaged-telegram/setup-fixture.js";

const scratchDirectories: string[] = [];

async function createAthleteHome(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "packaged-telegram-setup-"));
  scratchDirectories.push(scratch);
  return join(scratch, "athlete-home");
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("packaged Telegram setup fixture", () => {
  it("creates the migrated setup evidence once with private permissions", async () => {
    const athleteHome = await createAthleteHome();
    const storeDirectory = join(athleteHome, "store");
    const databasePath = join(storeDirectory, "store.db");

    await preparePackagedTelegramSetupFixture(athleteHome);

    const store = openSqliteStorage(databasePath);
    try {
      await expect(store.getUserVersion()).resolves.toBe(MIGRATIONS.at(-1)?.version);
      await expect(store.get("SELECT count(*) AS count FROM workout")).resolves.toEqual({
        count: 1,
      });
      await expect(store.get("SELECT * FROM workout")).resolves.toEqual({
        workout_key: "a".repeat(64),
        start_utc: 0,
        tz_offset_s: 0,
        name: "Packaged Telegram acceptance ride",
        notes: null,
        is_multisport: 0,
        dedup_cluster_id: "b".repeat(64),
      });
      await expect(store.get("SELECT count(*) AS count FROM intake_flags")).resolves.toEqual({
        count: 0,
      });
    } finally {
      await store.close();
    }
    expect((await stat(storeDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);

    await expect(preparePackagedTelegramSetupFixture(athleteHome)).rejects.toThrow(
      "packaged Telegram setup fixture refuses an existing store.db",
    );
  });

  it("releases the database so the isolated home can be removed", async () => {
    const athleteHome = await createAthleteHome();
    const scratch = scratchDirectories.pop();
    expect(scratch).toBeDefined();

    await preparePackagedTelegramSetupFixture(athleteHome);
    await rm(scratch!, { recursive: true });

    expect(existsSync(scratch!)).toBe(false);
  });
});
