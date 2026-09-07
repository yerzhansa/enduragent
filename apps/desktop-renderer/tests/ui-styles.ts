import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";

const require = createRequire(resolve(import.meta.dirname, "..", "package.json"));

export async function readUiStylesheet(name: "tokens.css" | "fonts.css"): Promise<string> {
  const entry = require.resolve("@enduragent/ui/tailwind.css");
  const source = await readFile(entry, "utf8");
  const imported = [...source.matchAll(/@import\s+["'](\.[^"']+)["']/gu)].find(
    (match) => basename(match[1]) === name,
  );
  if (imported === undefined) throw new Error(`Public UI stylesheet does not import ${name}`);
  return readFile(resolve(dirname(entry), imported[1]), "utf8");
}
