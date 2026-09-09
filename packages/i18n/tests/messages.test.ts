import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { LANGUAGE_OPTIONS } from "../src/registry.js";
import { msg, type CatalogKey } from "../src/message.js";
import { createPhrasebook, loadCatalog } from "../src/messages.js";
import english from "../catalogs/en.json";

describe("phrasebooks", () => {
  it("translates bare keys and message values in isolated languages", async () => {
    const [italian, japanese] = await Promise.all([
      createPhrasebook({ tag: "it", locale: "it-IT" }),
      createPhrasebook({ tag: "ja", locale: "ja-JP" }),
    ]);
    expect(italian.tag).toBe("it");
    expect(italian.locale).toBe("it-IT");
    expect(italian.say("common.cancel")).toBe("Annulla");
    expect(japanese.say(msg("common.cancel"))).toBe("キャンセル");
    expect(italian.say("common.cancel")).toBe("Annulla");
    expect(
      italian.say(msg("settings.language.automaticDetail", { operatingSystem: "macOS" })),
    ).toBe("Automatico usa la lingua di macOS. Il coach risponde nella lingua in cui scrivi.");
    expect(japanese.say("settings.appearance.detail", { operatingSystem: "Windows" })).toBe(
      "システムはWindowsのライトモードとダークモードの設定に従います",
    );
  });

  it("interpolates values without HTML escaping or translation-option injection", async () => {
    const book = await createPhrasebook({ tag: "it", locale: "it-IT" });
    expect(book.say("settings.appearance.detail", { operatingSystem: "<host>", lng: "ja" })).toBe(
      "Sistema segue l’impostazione chiara e scura di <host>",
    );
  });

  it("formats every value with the requested locale independently of catalog language", async () => {
    const locales = ["en-US", "de-DE", "ja-JP"];
    const date = new Date("1998-06-15T12:00:00Z");
    const dateOptions: Intl.DateTimeFormatOptions = { dateStyle: "long", timeZone: "UTC" };
    const numberOptions: Intl.NumberFormatOptions = { style: "currency", currency: "JPY" };
    const listOptions: Intl.ListFormatOptions = { type: "conjunction", style: "long" };
    const values = ["A", "B", "C"];
    const results = await Promise.all(
      locales.map(async (locale) => {
        const book = await createPhrasebook({ tag: "en", locale });
        const formatted = {
          date: book.format.date(date, dateOptions),
          number: book.format.number(1234.5, numberOptions),
          list: book.format.list(values, listOptions),
          relativeDays: book.format.relativeDays(-1),
        };
        expect(formatted.date).toBe(new Intl.DateTimeFormat(locale, dateOptions).format(date));
        expect(formatted.number).toBe(new Intl.NumberFormat(locale, numberOptions).format(1234.5));
        expect(formatted.list).toBe(new Intl.ListFormat(locale, listOptions).format(values));
        expect(formatted.relativeDays).toBe(
          new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day"),
        );
        expect(book.format.number(12n)).toBe(new Intl.NumberFormat(locale).format(12n));
        expect(book.format.relativeDays(0)).toBe(
          new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day"),
        );
        return formatted;
      }),
    );
    for (const field of ["date", "number", "list", "relativeDays"] as const) {
      expect(new Set(results.map((result) => result[field])).size).toBe(3);
    }
  });
});

it.each(LANGUAGE_OPTIONS)("loads the complete $tag catalog", async ({ tag }) => {
  const catalog = await loadCatalog(tag);
  function keys(value: unknown, prefix = ""): string[] {
    if (typeof value === "string") {
      expect(value.trim()).not.toBe("");
      return [prefix];
    }
    if (typeof value !== "object" || value === null) throw new Error("Invalid catalog");
    return Object.entries(value).flatMap(([key, child]) =>
      keys(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  const base = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/u, "");
  expect(new Set(keys(catalog).map(base))).toEqual(new Set(keys(english).map(base)));
});

it("derives message and phrasebook keys from the English catalog", () => {
  const generated = readFileSync(new URL("../src/catalog-keys.ts", import.meta.url), "utf8");
  const generatedKeys = [...generated.matchAll(/^ {2}\| "([^"]+)";?$/gmu)].map(([, key]) => key);
  const leaves = (value: unknown, prefix = ""): string[] =>
    typeof value === "string"
      ? [prefix]
      : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
          leaves(child, prefix ? `${prefix}.${key}` : key),
        );
  const englishLeaves = leaves(english);
  const bases = englishLeaves
    .filter((key) => /_(one|other)$/u.test(key))
    .map((key) => key.replace(/_(one|other)$/u, ""));
  expect(generatedKeys).toEqual([...new Set([...englishLeaves, ...bases])].sort());
  expectTypeOf<Parameters<typeof msg>[0]>().toEqualTypeOf<CatalogKey>();
  expectTypeOf<"settings.language.automaticDetail">().toExtend<CatalogKey>();
  expectTypeOf<"settings.language">().not.toExtend<CatalogKey>();
  expectTypeOf<"unknown.key">().not.toExtend<CatalogKey>();
  expect(msg("common.save")).toEqual({ key: "common.save" });
});

describe("plural selection", () => {
  it("chooses the form from count using the language's plural rules", async () => {
    const polish = await createPhrasebook({ tag: "pl", locale: "pl-PL" });
    const japanese = await createPhrasebook({ tag: "ja", locale: "ja-JP" });
    const english = await createPhrasebook({ tag: "en", locale: "en-GB" });
    const catalogs = await Promise.all([loadCatalog("pl"), loadCatalog("ja")]);
    const key = "archive.turnCount";
    const pl = catalogs[0].archive as Record<string, string>;
    const ja = catalogs[1].archive as Record<string, string>;
    const vars = (count: number) => ({ count, formattedCount: String(count) });
    expect(english.say(key, vars(1))).toBe("1 message");
    expect(english.say(key, vars(3))).toBe("3 messages");
    expect(polish.say(key, vars(1))).toBe(pl.turnCount_one.replace("{{formattedCount}}", "1"));
    expect(polish.say(key, vars(3))).toBe(pl.turnCount_few.replace("{{formattedCount}}", "3"));
    expect(polish.say(key, vars(7))).toBe(pl.turnCount_many.replace("{{formattedCount}}", "7"));
    expect(japanese.say(key, vars(1))).toBe(ja.turnCount_other.replace("{{formattedCount}}", "1"));
  });
});
