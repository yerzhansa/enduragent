import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createPhrasebook, loadCatalog } from "../dist/messages.js";
import { LANGUAGE_OPTIONS } from "../src/registry.js";

const dist = new URL("../dist/", import.meta.url);
const sourceMapSchema = z.object({ sources: z.array(z.string()) });

function imports(file: URL): { eager: URL[]; lazy: URL[] } {
  const source = ts.createSourceFile(
    fileURLToPath(file),
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
  );
  const eager: URL[] = [];
  const lazy: URL[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith(".")
    ) {
      eager.push(new URL(node.moduleSpecifier.text, file));
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument === undefined || !ts.isStringLiteralLike(argument)) {
        throw new Error(`Nonliteral dynamic import in ${file.pathname}`);
      }
      lazy.push(new URL(argument.text, file));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { eager, lazy };
}

function eagerMessagesGraph(): URL[] {
  const pending = [new URL("messages.js", dist)];
  const files = new Map<string, URL>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file.href)) continue;
    files.set(file.href, file);
    pending.push(...imports(file).eager);
  }
  return [...files.values()];
}

function sources(file: URL): string[] {
  const map: unknown = JSON.parse(readFileSync(new URL(`${file.href}.map`), "utf8"));
  return sourceMapSchema.parse(map).sources;
}

describe("built package", () => {
  it.each(["index.js", "node.js", "messages.js"])("ships the %s entry", (entry) => {
    expect(statSync(new URL(entry, dist)).isFile()).toBe(true);
  });

  it("keeps the eager translator graph below 16 KiB without catalog modules", () => {
    const eager = eagerMessagesGraph();
    expect(eager.flatMap(sources).filter((source) => source.includes("catalogs/"))).toEqual([]);
    expect(eager.reduce((bytes, file) => bytes + statSync(file).size, 0)).toBeLessThan(16 * 1024);
  });

  it("emits a separate dynamically imported module for each of the 17 catalogs", () => {
    const eager = eagerMessagesGraph();
    const lazy = eager.flatMap((file) => imports(file).lazy);
    expect(lazy).toHaveLength(17);
    expect(new Set(lazy.map((file) => file.href)).size).toBe(17);
    expect(lazy.some((file) => eager.some((loaded) => loaded.href === file.href))).toBe(false);
    const catalogSources = lazy.flatMap((file) => {
      expect(statSync(file).isFile()).toBe(true);
      return sources(file).filter((source) => source.includes("catalogs/"));
    });
    expect(catalogSources.map((source) => source.split("/").at(-1)).sort()).toEqual(
      LANGUAGE_OPTIONS.map(({ tag }) => `${tag}.json`).sort(),
    );
  });

  it("loads every compiled catalog and translates through the built entry", async () => {
    for (const { tag } of LANGUAGE_OPTIONS) {
      const expected: unknown = JSON.parse(
        readFileSync(new URL(`../catalogs/${tag}.json`, import.meta.url), "utf8"),
      );
      expect(await loadCatalog(tag)).toEqual(expected);
    }
    const italian = await createPhrasebook({ tag: "it", locale: "it-IT" });
    const japanese = await createPhrasebook({ tag: "ja", locale: "ja-JP" });
    expect(italian.say("common.cancel")).toBe("Annulla");
    expect(japanese.say("common.cancel")).toBe("キャンセル");
  });
});
