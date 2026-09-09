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
