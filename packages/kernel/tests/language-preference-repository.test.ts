import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteStorage } from "../../kernel-node/src/sqlite/index.js";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import { runMigrations } from "../src/store/migrator.js";
import { createLanguagePreferenceRepository } from "../src/store/language-preference-repository.js";

let store: ReturnType<typeof openSqliteStorage>;
const stamp = { id: "01J00000000000000000000002", deviceId: "desktop:synthetic", now: 300 };

beforeEach(async () => {
  store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
});
afterEach(async () => {
  await store.close();
});

describe("language preference repository", () => {
  it("reads absent and cleared preferences as null", async () => {
    const repository = createLanguagePreferenceRepository(store);
    await expect(repository.read()).resolves.toEqual({ language: null });
    await repository.set("it", stamp);
    await expect(repository.read()).resolves.toEqual({ language: "it" });
    await repository.set(null, { ...stamp, now: 200 });
    await expect(repository.read()).resolves.toEqual({ language: null });
    await expect(store.get("SELECT * FROM athlete_language")).resolves.toEqual({
      id: "singleton",
      language: null,
      device_id: stamp.deviceId,
      hlc_physical_ms: 300,
      hlc_counter: 1,
    });
    await repository.set("xx", { ...stamp, now: 400 });
    await expect(repository.read()).resolves.toEqual({ language: "xx" });
    await expect(store.get("SELECT * FROM athlete_language")).resolves.toMatchObject({
      hlc_physical_ms: 400,
      hlc_counter: 0,
    });
  });

  it("creates and advances cleared preference stamps", async () => {
    const repository = createLanguagePreferenceRepository(store);
    await repository.set(null, stamp);
    await expect(store.get("SELECT * FROM athlete_language")).resolves.toEqual({
      id: "singleton",
      language: null,
      device_id: stamp.deviceId,
      hlc_physical_ms: 300,
      hlc_counter: 0,
    });
    await repository.set(null, { ...stamp, now: 200 });
    await expect(store.get("SELECT * FROM athlete_language")).resolves.toMatchObject({
      language: null,
      hlc_physical_ms: 300,
      hlc_counter: 1,
    });
    await repository.set(null, { ...stamp, now: 600 });
    await expect(store.get("SELECT * FROM athlete_language")).resolves.toMatchObject({
      language: null,
      hlc_physical_ms: 600,
      hlc_counter: 0,
    });
  });

  it("does not write unchanged non-null values", async () => {
    const repository = createLanguagePreferenceRepository(store);
    await repository.set("it", stamp);
    const before = await store.get("SELECT * FROM athlete_language");
    await repository.set("it", { ...stamp, now: 500 });
    await expect(store.get("SELECT * FROM athlete_language")).resolves.toEqual(before);
  });

  it("validates opaque string lengths and mutation stamps", async () => {
    const repository = createLanguagePreferenceRepository(store);
    for (const language of ["", "x", "abcdefgh"]) {
      await expect(repository.set(language, stamp)).rejects.toThrow();
    }
    await expect(repository.set("it", { ...stamp, id: "invalid" })).rejects.toThrow("identity");
    await expect(repository.set("it", { ...stamp, deviceId: "!" })).rejects.toThrow("identity");
    for (const now of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repository.set("it", { ...stamp, now })).rejects.toThrow("time");
    }
  });

  it("enforces singleton, string length and nonnegative stamps in SQLite", async () => {
    await expect(
      store.run("INSERT INTO athlete_language VALUES ('other', 'it', 'device', 0, 0)"),
    ).rejects.toThrow();
    await expect(
      store.run("INSERT INTO athlete_language VALUES ('singleton', 'x', 'device', 0, 0)"),
    ).rejects.toThrow();
    await expect(
      store.run("INSERT INTO athlete_language VALUES ('singleton', 'it', 'device', -1, 0)"),
    ).rejects.toThrow();
    await expect(
      store.run("INSERT INTO athlete_language VALUES ('singleton', 'it', 'device', 0, -1)"),
    ).rejects.toThrow();
    await expect(
      store.run("INSERT INTO athlete_language VALUES ('singleton', 'it', 'device', 'bad', 0)"),
    ).rejects.toThrow();
  });
});
