import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.js";
import { resultsMarkdown, type EvalReport } from "./report.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const toStdout = args.includes("--stdout");
const paths = args.filter((arg) => arg !== "--stdout");
if (paths.length === 0) {
  process.stderr.write("usage: pnpm eval:coach:table [--stdout] <report.json>...\n");
  process.exit(2);
}
const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf-8")) as EvalReport);
const markdown = resultsMarkdown(reports, CASES);
if (toStdout) {
  process.stdout.write(markdown);
} else {
  const outPath = join(dirname(fileURLToPath(import.meta.url)), "RESULTS.md");
  writeFileSync(outPath, markdown, "utf-8");
  process.stdout.write(`wrote ${outPath}\n`);
}
