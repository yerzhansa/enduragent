import { readFileSync, writeFileSync } from "node:fs";

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

const source = new URL("../catalogs/en.json", import.meta.url);
const target = new URL("../src/catalog-keys.ts", import.meta.url);
const catalog: unknown = JSON.parse(readFileSync(source, "utf8"));
const keys = leafKeys(catalog).sort();
if (keys.length === 0) throw new Error("English catalog has no keys");
const output = `export type CatalogKey =\n${keys.map((key) => `  | ${JSON.stringify(key)}`).join("\n")};\n`;
let previous: string | undefined;
try {
  previous = readFileSync(target, "utf8");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
if (previous !== output) writeFileSync(target, output);
