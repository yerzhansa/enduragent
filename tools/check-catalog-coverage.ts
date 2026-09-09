import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { LanguageTagSchema, type LanguageTag } from "../packages/coach-contract/src/language.js";
import { runGateCli } from "./lint-fs.js";

export interface CatalogFindings {
  missing: string[];
  extra: string[];
  behind: string[];
  placeholderMismatch: string[];
}

export interface CatalogCoverage {
  report: Record<string, CatalogFindings>;
  errors: string[];
}

const objectSchema = z.record(z.string(), z.unknown());
const metadataEntrySchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  translatedBy: z.enum(["model", "human"]),
});
const translatedTags = LanguageTagSchema.options.filter((tag) => tag !== "en");

function readObject(file: string, errors: string[]): Record<string, unknown> {
  try {
    const parsed = objectSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return parsed.data;
    errors.push(`${file}: expected a JSON object`);
  } catch (error) {
    errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {};
}

function readCatalog(file: string, errors: string[]): Map<string, string | null> {
  const values = new Map<string, string | null>();
  function visit(object: Record<string, unknown>, prefix: string): void {
    for (const [name, value] of Object.entries(object)) {
      const key = prefix ? `${prefix}.${name}` : name;
      if (name.includes(".") || name.length === 0) {
        errors.push(`${file}: ${key} must use nested objects with non-empty property names`);
      }
      if (typeof value === "string") {
        values.set(key, value);
        if (value.trim().length === 0) errors.push(`${file}: ${key} is empty`);
      } else {
        const nested = objectSchema.safeParse(value);
        if (nested.success && Object.keys(nested.data).length > 0) {
          visit(nested.data, key);
        } else {
          values.set(key, null);
          errors.push(`${file}: ${key} must be a string or a non-empty nested object`);
        }
      }
    }
  }
  visit(readObject(file, errors), "");
  return values;
}

function sourceHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function placeholders(value: string): string[] {
  return [
    ...new Set(Array.from(value.matchAll(/{{\s*([^{}]+?)\s*}}/g), (match) => match[1].trim())),
  ].sort();
}

export function checkCatalogCoverage({
  catalogDirectory = "packages/i18n/catalogs",
  tags = translatedTags,
}: {
  catalogDirectory?: string;
  tags?: readonly Exclude<LanguageTag, "en">[];
} = {}): CatalogCoverage {
  const errors: string[] = [];
  const english = readCatalog(join(catalogDirectory, "en.json"), errors);
  if (english.size === 0) errors.push(`${catalogDirectory}/en.json: English catalog has no keys`);
  const report: Record<string, CatalogFindings> = {};

  for (const tag of tags) {
    const catalog = readCatalog(join(catalogDirectory, `${tag}.json`), errors);
    const metadataPath = join(catalogDirectory, `${tag}.meta.json`);
    const metadata = readObject(metadataPath, errors);
    const metadataKeys = objectSchema.safeParse(metadata.keys);
    if (!metadataKeys.success) errors.push(`${metadataPath}: expected a keys object`);
    const findings: CatalogFindings = {
      missing: [],
      extra: [...catalog.keys()].filter((key) => !english.has(key)).sort(),
      behind: [],
      placeholderMismatch: [],
    };
    for (const [key, source] of [...english].sort(([left], [right]) => left.localeCompare(right))) {
      const translation = catalog.get(key);
      if (translation === undefined || translation === null || translation.trim().length === 0) {
        findings.missing.push(key);
      }
      const entry = metadataEntrySchema.safeParse(
        metadataKeys.success ? metadataKeys.data[key] : undefined,
      );
      if (!entry.success || source === null || entry.data.sourceHash !== sourceHash(source)) {
        findings.behind.push(key);
        if (!entry.success)
          errors.push(`${metadataPath}: ${key} needs a valid sourceHash and translatedBy`);
      }
      if (
        typeof source === "string" &&
        typeof translation === "string" &&
        JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(translation))
      ) {
        findings.placeholderMismatch.push(key);
      }
    }
    report[tag] = findings;
  }
  return { report, errors };
}

export function main(argv: readonly string[]): number {
  const unknownArguments = argv.filter((argument) => argument !== "--report");
  if (unknownArguments.length > 0) {
    console.error(`check-catalog-coverage: unknown arguments: ${unknownArguments.join(" ")}`);
    return 1;
  }
  const { report, errors } = checkCatalogCoverage();
  const findings = Object.entries(report).flatMap(([tag, categories]) =>
    Object.entries(categories).flatMap(([category, keys]) =>
      keys.map((key: string) => `${tag}: ${category}: ${key}`),
    ),
  );
  if (argv.includes("--report")) console.log(JSON.stringify(report, null, 2));
  if (errors.length > 0 || findings.length > 0) {
    console.error("check-catalog-coverage: catalog findings:");
    for (const error of [...errors, ...findings]) console.error(`  ${error}`);
    return argv.includes("--report") ? 0 : 1;
  }
  if (!argv.includes("--report")) {
    console.log(`check-catalog-coverage: ${translatedTags.length} translated catalogs clean.`);
  }
  return 0;
}

runGateCli(import.meta.url, main);
