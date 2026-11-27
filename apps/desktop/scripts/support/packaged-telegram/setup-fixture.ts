import { chmod, mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";

const WORKOUT_KEY = "a".repeat(64);
const DEDUP_CLUSTER_ID = "b".repeat(64);

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

async function enforceStorePermissions(storeDirectory: string): Promise<void> {
  await chmod(storeDirectory, 0o700);
  for (const name of await readdir(storeDirectory)) {
    if (name === "store.db" || name.startsWith("store.db-")) {
      await chmod(join(storeDirectory, name), 0o600);
    }
  }
}

export async function preparePackagedTelegramSetupFixture(athleteHome: string): Promise<void> {
  const storeDirectory = join(athleteHome, "store");
  const databasePath = join(storeDirectory, "store.db");
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  await chmod(storeDirectory, 0o700);

  let databaseFile: FileHandle;
  try {
    databaseFile = await open(databasePath, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error("packaged Telegram setup fixture refuses an existing store.db");
    }
    throw error;
  }
  await databaseFile.close();

  let store: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    store = openSqliteStorage(databasePath);
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO workout (workout_key,start_utc,tz_offset_s,name,notes,is_multisport,dedup_cluster_id) VALUES (?,?,?,?,?,?,?)",
      [WORKOUT_KEY, 0, 0, "Packaged Telegram acceptance ride", null, 0, DEDUP_CLUSTER_ID],
    );
  } finally {
    try {
      await store?.close();
    } finally {
      await enforceStorePermissions(storeDirectory);
    }
  }
}
