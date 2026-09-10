import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import parserConfig from "../../../i18next-parser.config.js";

const require = createRequire(import.meta.url);
const parserCli = resolve(dirname(require.resolve("i18next-parser")), "../bin/cli.js");
const directories: string[] = [];
const seed = { common: { cancel: "Cancel" } };

function fixture(source: string, extension = "ts"): string {
  const directory = mkdtempSync(join(tmpdir(), "i18n-extraction-"));
  directories.push(directory);
  writeFileSync(join(directory, `source.${extension}`), source);
  writeFileSync(join(directory, "en.json"), `${JSON.stringify(seed, null, 2)}\n`);
  writeFileSync(
    join(directory, "i18next-parser.config.ts"),
    `export default ${JSON.stringify({
      ...parserConfig,
      input: [`source.${extension}`],
      output: join(directory, "$LOCALE.json"),
    })};\n`,
  );
  return directory;
}

function extract(directory: string, failOnUpdate = false) {
  return spawnSync(
    process.execPath,
    [
      parserCli,
      "--config",
      join(directory, "i18next-parser.config.ts"),
      "--silent",
      ...(failOnUpdate ? ["--fail-on-update"] : []),
    ],
    { cwd: directory, encoding: "utf8", timeout: 15_000 },
  );
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("catalog extraction configuration", () => {
  it("keeps unused seed keys without changing the English catalog", () => {
    const directory = fixture("export const value = 1;\n");
    const before = readFileSync(join(directory, "en.json"), "utf8");
    const result = extract(directory, true);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(directory, "en.json"), "utf8")).toBe(before);
  });

  it.each([
    ["t", "ts"],
    ["say", "ts"],
    ["msg", "ts"],
    ["book.say", "tsx"],
  ])(
    "extracts %s calls from %s and fails CI until the key exists",
    (callee, extension) => {
      const directory = fixture(`${callee}("settings.language.title");\n`, extension);
      const missing = extract(directory, true);
      expect(missing.error).toBeUndefined();
      expect(missing.status, missing.stdout + missing.stderr).toBe(1);
      expect(missing.stdout).toContain("translations was updated");

      const updated = extract(directory);
      expect(updated.error).toBeUndefined();
      expect(updated.status, updated.stdout + updated.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(directory, "en.json"), "utf8"))).toEqual({
        common: { cancel: "Cancel" },
        settings: { language: { title: "" } },
      });

      const before = readFileSync(join(directory, "en.json"), "utf8");
      const unchanged = extract(directory, true);
      expect(unchanged.error).toBeUndefined();
      expect(unchanged.status, unchanged.stdout + unchanged.stderr).toBe(0);
      expect(readFileSync(join(directory, "en.json"), "utf8")).toBe(before);
    },
    15_000,
  );
});
