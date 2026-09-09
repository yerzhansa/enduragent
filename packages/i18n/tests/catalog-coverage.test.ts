import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCatalogCoverage } from "../../../tools/check-catalog-coverage.js";

const english = { common: { cancel: "Cancel", detail: "Use {{operatingSystem}}" } };
const directories: string[] = [];

function writeJson(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "i18n-catalog-coverage-"));
  directories.push(directory);
  writeJson(directory, "en.json", english);
  writeJson(directory, "it.json", {
    common: { cancel: "Annulla", detail: "Usa {{operatingSystem}}" },
  });
  writeJson(directory, "it.meta.json", {
    keys: Object.fromEntries(
      Object.entries(english.common).map(([key, value]) => [
        `common.${key}`,
        { sourceHash: createHash("sha256").update(value).digest("hex"), translatedBy: "model" },
      ]),
    ),
  });
  return directory;
}

function check(directory: string) {
  return checkCatalogCoverage({ catalogDirectory: directory, tags: ["it"] });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("catalog coverage", () => {
  it("accepts matching nested catalogs, hashes, and placeholders", () => {
    expect(check(fixture())).toEqual({
      report: { it: { missing: [], extra: [], behind: [], placeholderMismatch: [] } },
      errors: [],
    });
  });

  it("reports missing and extra keys", () => {
    const directory = fixture();
    writeJson(directory, "it.json", {
      common: { detail: "Usa {{operatingSystem}}", save: "Salva" },
    });
    expect(check(directory).report.it).toEqual({
      missing: ["common.cancel"],
      extra: ["common.save"],
      behind: [],
      placeholderMismatch: [],
    });
  });

  it("reports a translation behind a changed English value", () => {
    const directory = fixture();
    writeJson(directory, "en.json", { common: { ...english.common, cancel: "Cancel changes" } });
    expect(check(directory).report.it.behind).toEqual(["common.cancel"]);
  });

  it("reports changed placeholders", () => {
    const directory = fixture();
    writeJson(directory, "it.json", { common: { cancel: "Annulla", detail: "Usa {{platform}}" } });
    expect(check(directory).report.it.placeholderMismatch).toEqual(["common.detail"]);
  });

  it("compares placeholder sets independently of repetition and order", () => {
    const directory = fixture();
    writeJson(directory, "it.json", {
      common: { cancel: "Annulla", detail: "{{operatingSystem}}: usa {{operatingSystem}}" },
    });
    expect(check(directory).report.it.placeholderMismatch).toEqual([]);
  });

  it.each(["", "  ", null, 42, [], {}])("rejects empty or malformed translation %j", (value) => {
    const directory = fixture();
    writeJson(directory, "it.json", {
      common: { cancel: value, detail: "Usa {{operatingSystem}}" },
    });
    const result = check(directory);
    expect(result.report.it.missing).toEqual(["common.cancel"]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports all keys behind when metadata is absent", () => {
    const directory = fixture();
    rmSync(join(directory, "it.meta.json"));
    const result = check(directory);
    expect(result.report.it.behind).toEqual(["common.cancel", "common.detail"]);
    expect(result.errors.some((error) => error.includes("it.meta.json"))).toBe(true);
  });

  it("rejects invalid translation provenance", () => {
    const directory = fixture();
    writeJson(directory, "it.meta.json", {
      keys: { "common.cancel": { sourceHash: "invalid", translatedBy: "unknown" } },
    });
    expect(check(directory).report.it.behind).toEqual(["common.cancel", "common.detail"]);
  });

  it("rejects unreadable catalog JSON", () => {
    const directory = fixture();
    writeFileSync(join(directory, "it.json"), "{");
    const result = check(directory);
    expect(result.report.it.missing).toEqual(["common.cancel", "common.detail"]);
    expect(result.errors.some((error) => error.includes("it.json"))).toBe(true);
  });
});

describe("plural categories", () => {
  function pluralFixture(tag: "pl" | "ja" | "fr", keys: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), "i18n-catalog-plurals-"));
    directories.push(directory);
    const source = { rides_one: "{{count}} ride", rides_other: "{{count}} rides" };
    writeJson(directory, "en.json", { training: source });
    writeJson(directory, `${tag}.json`, { training: keys });
    writeJson(directory, `${tag}.meta.json`, {
      keys: Object.fromEntries(
        Object.keys(keys).map((key) => [
          `training.${key}`,
          {
            sourceHash: createHash("sha256")
              .update(key === "rides_one" ? source.rides_one : source.rides_other)
              .digest("hex"),
            translatedBy: "model",
          },
        ]),
      ),
    });
    return directory;
  }

  it("requires every small-count category of the language and allows its other categories", () => {
    const polish = pluralFixture("pl", {
      rides_one: "{{count}} przejazd",
      rides_few: "{{count}} przejazdy",
      rides_many: "{{count}} przejazdów",
      rides_other: "{{count}} przejazdu",
    });
    expect(checkCatalogCoverage({ catalogDirectory: polish, tags: ["pl"] }).report.pl).toEqual({
      missing: [],
      extra: [],
      behind: [],
      placeholderMismatch: [],
    });
    const incomplete = pluralFixture("pl", {
      rides_one: "{{count}} przejazd",
      rides_other: "{{count}} przejazdu",
    });
    expect(
      checkCatalogCoverage({ catalogDirectory: incomplete, tags: ["pl"] }).report.pl.missing,
    ).toEqual(["training.rides_few", "training.rides_many"]);
  });

  it("accepts a single other form where the language has no one category", () => {
    const japanese = pluralFixture("ja", { rides_other: "{{count}}回のライド" });
    expect(checkCatalogCoverage({ catalogDirectory: japanese, tags: ["ja"] }).report.ja).toEqual({
      missing: [],
      extra: [],
      behind: [],
      placeholderMismatch: [],
    });
  });

  it("does not require categories that only apply to large counts", () => {
    const french = pluralFixture("fr", {
      rides_one: "{{count}} sortie",
      rides_other: "{{count}} sorties",
    });
    expect(checkCatalogCoverage({ catalogDirectory: french, tags: ["fr"] }).report.fr).toEqual({
      missing: [],
      extra: [],
      behind: [],
      placeholderMismatch: [],
    });
  });
});
