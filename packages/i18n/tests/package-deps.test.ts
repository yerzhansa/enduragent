import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkBuiltDependencyGraph,
  checkI18nBuiltDependencies,
} from "../../../tools/check-package-deps.js";

let fixture: string;

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "i18n-package-deps-")));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function write(path: string, contents: string): string {
  const file = join(fixture, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function check(entry: string) {
  return checkBuiltDependencyGraph({
    entry,
    forbiddenPackages: ["react", "react-i18next", "i18next"],
  });
}

describe("built i18n dependency boundaries", () => {
  it.each(["react", "react/jsx-runtime", "react-i18next", "i18next", "node:fs", "fs"])(
    "rejects %s reached through a re-export and dynamic import",
    (specifier) => {
      const entry = write("dist/index.js", 'export * from "./shared.js";');
      write("dist/shared.js", 'export const load = () => import("./translator.js");');
      const forbidden = write("dist/translator.js", `import "${specifier}";`);

      expect(check(entry).violations).toEqual([
        expect.objectContaining({ file: forbidden, specifier }),
      ]);
    },
  );

  it("follows external import exports and ignores declarations and require exports", () => {
    const entry = write("dist/index.js", 'export * from "helper";');
    write("package.json", '{"type":"module"}');
    write("node_modules/helper/package.json", JSON.stringify({
      name: "helper",
      type: "module",
      exports: { types: "./index.d.ts", import: "./index.js", require: "./index.cjs" },
    }));
    write("node_modules/helper/index.d.ts", "export declare const value: string;");
    write("node_modules/helper/index.cjs", "exports.value = 'safe';");
    const forbidden = write("node_modules/helper/index.js", 'export * from "react";');

    expect(check(entry).violations).toEqual([
      expect.objectContaining({ file: forbidden, specifier: "react" }),
    ]);
  });

  it("follows CommonJS require exports", () => {
    const entry = write("dist/index.js", 'const helper = require("helper");');
    write("node_modules/helper/package.json", JSON.stringify({
      name: "helper",
      exports: { import: "./index.js", require: "./index.cjs" },
    }));
    write("node_modules/helper/index.js", "export const value = 'safe';");
    const forbidden = write("node_modules/helper/index.cjs", 'require("node:fs");');

    expect(check(entry).violations).toEqual([
      expect.objectContaining({ file: forbidden, specifier: "node:fs" }),
    ]);
  });

  it("accepts cyclic safe imports and JSON catalog modules", () => {
    const entry = write("dist/index.js", 'export * from "./shared.js";');
    write("dist/shared.js", 'import "./index.js"; export const load = () => import("./en.json", { with: { type: "json" } });');
    write("dist/en.json", '{"cancel":"Cancel"}');

    expect(check(entry)).toEqual({ violations: [], scannedFileCount: 3 });
  });

  it("fails closed for an unresolved runtime import", () => {
    const entry = write("dist/index.js", 'import "./missing.js";');

    expect(check(entry).violations).toEqual([
      expect.objectContaining({ specifier: "./missing.js", message: expect.stringContaining("Unresolved") }),
    ]);
  });

  it("requires both built entries and permits i18next only from messages", () => {
    expect(checkI18nBuiltDependencies(fixture)).toHaveLength(2);
    write("packages/i18n/dist/index.js", "export const msg = () => null;");
    write("packages/i18n/dist/messages.js", 'import "i18next";');
    write("packages/i18n/node_modules/i18next/package.json", '{"name":"i18next","exports":"./index.js"}');
    write("packages/i18n/node_modules/i18next/index.js", "export const createInstance = () => null;");

    expect(checkI18nBuiltDependencies(fixture)).toEqual([]);

    write("packages/i18n/dist/index.js", 'export * from "./messages.js";');
    expect(checkI18nBuiltDependencies(fixture)).toEqual([
      expect.objectContaining({ specifier: "i18next" }),
    ]);

    write("packages/i18n/dist/index.js", "export const msg = () => null;");
    write("packages/i18n/node_modules/i18next/index.js", 'import "react";');
    expect(checkI18nBuiltDependencies(fixture)).toEqual([
      expect.objectContaining({ specifier: "react" }),
    ]);
  });
});
