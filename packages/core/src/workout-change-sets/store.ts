import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireInterprocessFileLock } from "../io/interprocess-file-lock-sync.js";
import { recordSchema, type Record } from "./record.js";

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function openStore(dataDir: string, account: string) {
  const root = join(dataDir, "workout-change-sets");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dataDirectory = await open(dataDir, "r");
  try {
    await dataDirectory.sync();
  } finally {
    await dataDirectory.close();
  }
  const ownership = await acquireInterprocessFileLock(join(root, "writer.lock"), { timeoutMs: 0 });
  const dir = join(root, digest(account));
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const rootDirectory = await open(root, "r");
    try {
      await rootDirectory.sync();
    } finally {
      await rootDirectory.close();
    }
    const records = new Map<string, Record>();
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      const record = recordSchema.parse(JSON.parse(await readFile(join(dir, file), "utf8")));
      if (record.account !== account || file !== `${digest(record.chatId)}.json`)
        throw new Error("Workout approval account binding is invalid.");
      records.set(record.chatId, record);
    }
    return {
      records,
      async save(record: Record) {
        const validated = recordSchema.parse(record);
        const temporary = join(dir, `${randomUUID()}.tmp`);
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(validated));
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await rename(temporary, join(dir, `${digest(record.chatId)}.json`));
          const directory = await open(dir, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          records.set(record.chatId, validated);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      close() {
        ownership.release();
      },
    };
  } catch (error) {
    ownership.release();
    throw error;
  }
}
