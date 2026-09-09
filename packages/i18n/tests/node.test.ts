import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageTagSchema } from "@enduragent/coach-contract";
import { createFileLanguagePreferenceStore, readEnvironmentSurfaceHint } from "../src/node.js";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "language-test-"));
  directories.push(root);
  const dir = join(root, "preferences");
  return { dir, path: join(dir, "language.json") };
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("round trips every language and Automatic with private permissions", async () => {
  const { dir, path } = fixture();
  const store = createFileLanguagePreferenceStore({ dir, env: {} });
  expect(await store.read()).toEqual({ value: null, origin: "unset" });
  for (const value of LanguageTagSchema.options) {
    expect(await store.write(value)).toEqual({ value, origin: "stored" });
    expect(await createFileLanguagePreferenceStore({ dir, env: {} }).read()).toEqual({
      value,
      origin: "stored",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, language: value });
  }
  expect(await store.write(null)).toEqual({ value: null, origin: "stored" });
  expect(readFileSync(path, "utf8")).toBe('{"version":1}');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

it("parses environment overrides once and still persists writes", async () => {
  const { dir, path } = fixture();
  const env = { ENDURAGENT_LANGUAGE: "pt-br" };
  const store = createFileLanguagePreferenceStore({ dir, env });
  env.ENDURAGENT_LANGUAGE = "fr";
  const expected = { value: "pt-BR", origin: "environment", variable: "ENDURAGENT_LANGUAGE" };
  expect(await store.read()).toEqual(expected);
  expect(await store.write("it")).toEqual(expected);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, language: "it" });
  expect(await createFileLanguagePreferenceStore({ dir, env: {} }).read()).toEqual({
    value: "it",
    origin: "stored",
  });
});

it("reports unsupported overrides once at construction and ignores them", async () => {
  const { dir } = fixture();
  const onInvalidOverride = vi.fn();
  const store = createFileLanguagePreferenceStore({
    dir,
    env: { ENDURAGENT_LANGUAGE: "klingon" },
    onInvalidOverride,
  });
  expect(onInvalidOverride).toHaveBeenCalledExactlyOnceWith("klingon");
  expect(await store.read()).toEqual({ value: null, origin: "unset" });
  expect(await store.write("fr")).toEqual({ value: "fr", origin: "stored" });
  expect(await store.read()).toEqual({ value: "fr", origin: "stored" });
  expect(onInvalidOverride).toHaveBeenCalledTimes(1);
});

it.each([undefined, "fr_FR.UTF-8"])("does not report valid or absent overrides: %s", (raw) => {
  const { dir } = fixture();
  const onInvalidOverride = vi.fn();
  createFileLanguagePreferenceStore({
    dir,
    env: { ENDURAGENT_LANGUAGE: raw },
    onInvalidOverride,
  });
  expect(onInvalidOverride).not.toHaveBeenCalled();
});

it("refreshes a cached value after an external mtime change, replacement, and removal", async () => {
  const { dir, path } = fixture();
  const store = createFileLanguagePreferenceStore({ dir, env: {} });
  await store.write("it");
  const previous = statSync(path);
  writeFileSync(path, '{"version":1,"language":"fr"}');
  utimesSync(path, previous.atime, previous.mtimeMs / 1000 + 2);
  expect(await store.read()).toEqual({ value: "fr", origin: "stored" });
  writeFileSync(join(dir, "replacement"), '{"version":1,"language":"de"}');
  renameSync(join(dir, "replacement"), path);
  expect(await store.read()).toEqual({ value: "de", origin: "stored" });
  rmSync(path);
  expect(await store.read()).toEqual({ value: null, origin: "unset" });
});

it("replaces complete documents atomically and leaves no temporary files", async () => {
  const { dir, path } = fixture();
  const first = createFileLanguagePreferenceStore({ dir, env: {} });
  const second = createFileLanguagePreferenceStore({ dir, env: {} });
  await first.write("it");
  const originalInode = statSync(path).ino;
  await second.write("de");
  expect(statSync(path).ino).not.toBe(originalInode);
  expect(await first.read()).toEqual({ value: "de", origin: "stored" });
  await Promise.all(LanguageTagSchema.options.map((tag) => first.write(tag)));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, language: "zh-Hant" });
  expect(readdirSync(dir)).toEqual(["language.json"]);
});

it("cleans up a temporary file when replacement fails", async () => {
  const { dir, path } = fixture();
  mkdirSync(path, { recursive: true });
  const store = createFileLanguagePreferenceStore({ dir, env: {} });
  await expect(store.write("it")).rejects.toThrow();
  expect(readdirSync(dir)).toEqual(["language.json"]);
});

it.each(['{"version":1,"language":"xx"}', '{"version":2,"language":"it"}', "broken"])(
  "ignores invalid stored data: %s",
  async (content) => {
    const { dir, path } = fixture();
    mkdirSync(dir);
    writeFileSync(path, content);
    expect(await createFileLanguagePreferenceStore({ dir, env: {} }).read()).toEqual({
      value: null,
      origin: "unset",
    });
  },
);

it.each([
  [
    { LANGUAGE: "ru_RU:fr_BE:en", LC_ALL: "de_DE" },
    { language: "fr", locale: "fr-BE" },
  ],
  [{ LANGUAGE: "en_US:en" }, { language: "en", locale: "en-US" }],
  [
    { LANGUAGE: "C:xx", LC_ALL: "it_IT.UTF-8", LANG: "en_US" },
    { language: "it", locale: "it-IT" },
  ],
  [
    { LC_MESSAGES: "nl_BE.UTF-8", LANG: "de_DE" },
    { language: "nl", locale: "nl-BE" },
  ],
  [{ LANG: "pt-br" }, { language: "pt-BR", locale: "pt-BR" }],
  [{ LANG: "zh_Hant_TW" }, { language: "zh-Hant", locale: "zh-Hant-TW" }],
  [{ LANG: "C.UTF-8" }, { language: undefined, locale: undefined }],
  [
    { LANGUAGE: "POSIX", LANG: "C" },
    { language: undefined, locale: undefined },
  ],
  [{ ENDURAGENT_LANGUAGE: "it" }, { language: undefined, locale: undefined }],
])("reads language and locale from the same environment entry %j", (env, expected) => {
  expect(readEnvironmentSurfaceHint(env)).toEqual(expected);
});
