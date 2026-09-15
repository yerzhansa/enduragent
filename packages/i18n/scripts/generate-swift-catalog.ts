import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const TAGS = [
  "en",
  "es",
  "fr",
  "it",
  "de",
  "nl",
  "da",
  "sv",
  "nb",
  "fi",
  "pt-PT",
  "pt-BR",
  "pl",
  "ko",
  "ja",
  "zh-Hans",
  "zh-Hant",
] as const;

const PLURAL_FORM = /_(zero|one|two|few|many|other)$/u;
const TOKEN = /{{\s*([^{}]+?)\s*}}/g;
const SUBSTITUTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type NestedCatalog = { readonly [key: string]: string | NestedCatalog };
type StringMap = Map<string, string>;

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid English catalog at ${prefix}`);
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if (!key || key.includes(".")) throw new Error(`Invalid catalog property ${key}`);
    return leafKeys(child, prefix ? `${prefix}.${key}` : key);
  });
}

function flatten(value: unknown, prefix = "", into: StringMap = new Map()): StringMap {
  if (typeof value === "string") {
    into.set(prefix, value);
    return into;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid catalog at ${prefix}`);
  }
  for (const [key, child] of Object.entries(value as NestedCatalog)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, into);
  }
  return into;
}

function swiftName(key: string): string {
  return key
    .split(".")
    .map((part, i) =>
      part
        .split("_")
        .map((segment, j) => {
          if (!segment) return "";
          if (i === 0 && j === 0) return segment;
          return segment.charAt(0).toUpperCase() + segment.slice(1);
        })
        .join(""),
    )
    .join("");
}

function appleFormat(value: string): { value: string; names: string[] } {
  const names: string[] = [];
  const seen = new Set<string>();
  const pieces: string[] = [];
  let last = 0;
  TOKEN.lastIndex = 0;
  for (const match of value.matchAll(TOKEN)) {
    const name = match[1]?.trim() ?? "";
    if (!SUBSTITUTION_NAME.test(name)) {
      throw new Error(`Invalid substitution name ${name}`);
    }
    pieces.push(value.slice(last, match.index).replaceAll("%", "%%"));
    pieces.push(`%#@${name}@`);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
    last = (match.index ?? 0) + match[0].length;
  }
  pieces.push(value.slice(last).replaceAll("%", "%%"));
  return { value: pieces.join(""), names };
}

function substitutions(names: string[]): Record<string, { argNum: number; formatSpecifier: string }> | undefined {
  if (names.length === 0) return undefined;
  return Object.fromEntries(
    names.map((name, index) => [name, { argNum: index + 1, formatSpecifier: "@" }]),
  );
}

function stringUnit(value: string): { stringUnit: { state: "translated"; value: string } } {
  return { stringUnit: { state: "translated", value } };
}

function loadCatalog(tag: (typeof TAGS)[number]): StringMap {
  const source = new URL(`../catalogs/${tag}.json`, import.meta.url);
  return flatten(JSON.parse(readFileSync(source, "utf8")));
}

function writeIfChanged(url: URL, contents: string): void {
  let previous: string | undefined;
  try {
    previous = readFileSync(url, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (previous === contents) return;
  mkdirSync(new URL(".", url), { recursive: true });
  writeFileSync(url, contents);
}

const englishCatalog: unknown = JSON.parse(
  readFileSync(new URL("../catalogs/en.json", import.meta.url), "utf8"),
);
const englishLeaves = leafKeys(englishCatalog);
const pluralBases = [
  ...new Set(
    englishLeaves.filter((key) => /_(one|other)$/u.test(key)).map((key) => key.replace(/_(one|other)$/u, "")),
  ),
].sort();
const catalogKeys = [...new Set([...englishLeaves, ...pluralBases])].sort();
if (catalogKeys.length === 0) throw new Error("English catalog has no keys");

const names = new Map<string, string>();
for (const key of catalogKeys) {
  const name = swiftName(key);
  if (!/^[A-Za-z_][A-Za-z0-9]*$/.test(name)) {
    throw new Error(`Invalid Swift identifier ${name} for ${key}`);
  }
  const existing = names.get(name);
  if (existing !== undefined) throw new Error(`Duplicate Swift identifier ${name} for ${existing} and ${key}`);
  names.set(name, key);
}

const catalogs = Object.fromEntries(TAGS.map((tag) => [tag, loadCatalog(tag)])) as Record<
  (typeof TAGS)[number],
  StringMap
>;
const english = catalogs.en;
const pluralBaseSet = new Set(pluralBases);
const pluralLeaves = new Set(englishLeaves.filter((key) => PLURAL_FORM.test(key)));
const plainLeaves = englishLeaves.filter((key) => !pluralLeaves.has(key)).sort();
const xcstringKeys = [...plainLeaves, ...pluralBases].sort();

const strings: Record<string, { localizations: Record<string, unknown> }> = {};
for (const key of xcstringKeys) {
  const localizations: Record<string, unknown> = {};
  if (pluralBaseSet.has(key)) {
    const englishForms = ["one", "other", "zero", "two", "few", "many"]
      .map((form) => {
        const value = english.get(`${key}_${form}`);
        return value === undefined ? undefined : { form, converted: appleFormat(value) };
      })
      .filter((entry) => entry !== undefined);
    const englishNames = [...new Set(englishForms.flatMap((entry) => entry.converted.names))];
    const vars = substitutions(englishNames);
    for (const tag of TAGS) {
      const catalog = catalogs[tag];
      const forms: Record<string, { stringUnit: { state: "translated"; value: string } }> = {};
      for (const form of ["zero", "one", "two", "few", "many", "other"] as const) {
        const raw = catalog.get(`${key}_${form}`);
        if (raw === undefined) continue;
        forms[form] = stringUnit(appleFormat(raw).value);
      }
      if (Object.keys(forms).length === 0) continue;
      localizations[tag] = vars === undefined ? { variations: { plural: forms } } : { variations: { plural: forms }, substitutions: vars };
    }
  } else {
    const englishConverted = appleFormat(english.get(key) ?? "");
    const vars = substitutions(englishConverted.names);
    for (const tag of TAGS) {
      const raw = catalogs[tag].get(key);
      if (raw === undefined) continue;
      const converted = appleFormat(raw);
      localizations[tag] =
        vars === undefined ? stringUnit(converted.value) : { ...stringUnit(converted.value), substitutions: vars };
    }
  }
  strings[key] = { localizations };
}

const swift = [
  "public enum Catalog {",
  `\tpublic static let englishLeafCount = ${englishLeaves.length}`,
  `\tpublic static let keyCount = ${catalogKeys.length}`,
  ...catalogKeys.map((key) => `\tpublic static let ${swiftName(key)} = CatalogKey(rawValue: ${JSON.stringify(key)})`),
  "}",
  "",
].join("\n");

const xcstrings = `${JSON.stringify({ sourceLanguage: "en", strings, version: "1.0" }, null, 2)}\n`;

const swiftOut = new URL(
  "../../../apps/ios/Packages/EnduragentCoach/Sources/EnduragentCoach/I18n/CatalogKey.generated.swift",
  import.meta.url,
);
const xcstringsOut = new URL(
  "../../../apps/ios/Packages/EnduragentCoach/Sources/EnduragentCoach/Resources/Localizable.xcstrings",
  import.meta.url,
);

writeIfChanged(swiftOut, swift);
writeIfChanged(xcstringsOut, xcstrings);
process.stdout.write(`${englishLeaves.length} leaves, ${catalogKeys.length} keys, ${TAGS.length} locales\n`);
