// Operator CLI for piping a real intervals.icu JSON dump through the
// privacy-allowlist transform. Output lands under
// `tests/fixtures/golden/<name>.json` for committing.
//
// Usage:
//   pnpm exec tsx tools/sanitize-fixture.ts <input.json> <output-name> [--force]

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJson } from "../packages/core/src/io/atomic-write-json.js";
import {
  assertNoTpKeysRemain,
  decodeWellnessRow,
  renameTpFieldsOnActivity,
  RowRejection,
  type RenameSummary,
} from "../packages/core/src/reference/sync/rename-tp-fields.js";
import {
  sanitizeFixtureWithSummary,
  type SanitizeSummary,
} from "./sanitize-fixture-transform.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_ROOT = resolve(
  REPO_ROOT,
  "packages",
  "core",
  "tests",
  "fixtures",
  "golden",
);

// Allowlisted CLI flags. Unknown --<word> arguments are rejected so an
// operator typo like `--force-overrride` or `--dryrun` doesn't get
// silently swallowed (which would either bypass overwrite protection,
// or fail intent-of-dry-run, depending on the typo).
const KNOWN_FLAGS: ReadonlySet<string> = new Set(["--force"]);

export interface MainOptions {
  /** Override the output-root directory. Tests pass tmpdir; production uses
   *  `packages/core/tests/fixtures/golden/`. */
  outputRoot?: string;
  /** Capture stdout. Tests pass a collector; production uses console.log. */
  out?: (msg: string) => void;
  /** Capture stderr. */
  err?: (msg: string) => void;
}

export async function main(argv: string[], opts?: MainOptions): Promise<number> {
  const out = opts?.out ?? ((m: string) => console.log(m));
  const err = opts?.err ?? ((m: string) => console.error(m));
  const outputRoot = opts?.outputRoot ?? DEFAULT_OUTPUT_ROOT;

  const positional = argv.filter((a) => !a.startsWith("--"));
  const flagsList = argv.filter((a) => a.startsWith("--"));

  const unknown = flagsList.filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) {
    err(`unknown flag(s): ${unknown.join(", ")}`);
    err(`known flags: ${[...KNOWN_FLAGS].join(", ")}`);
    return 2;
  }
  const flags = new Set(flagsList);

  if (positional.length < 2) {
    err(
      "usage: tsx tools/sanitize-fixture.ts <input.json> <output-name> [--force]",
    );
    return 2;
  }

  const [inputPath, outputName] = positional;
  const outputPath = resolve(outputRoot, `${outputName}.json`);
  const force = flags.has("--force");

  if (!force && fileExists(outputPath)) {
    err(`refusing to overwrite ${outputPath} without --force`);
    return 1;
  }

  const raw = readFileSync(inputPath, "utf-8");
  const parsed = JSON.parse(raw);
  const activitiesRenameSummary: RenameSummary = { skippedNonNumeric: {} };
  const activities = Array.isArray(parsed.activities) && {
    activities: parsed.activities.map((row: unknown) =>
      renameTpFieldsOnActivity(row as Record<string, unknown>, activitiesRenameSummary),
    ),
  };
  let renamed: Record<string, unknown>;
  // Defense-in-depth — see assertNoTpKeysRemain's JSDoc for the invariant.
  try {
    renamed = {
      ...parsed,
      ...activities,
      ...(Array.isArray(parsed.wellness) && { wellness: parsed.wellness.map(decodeWellnessDay) }),
    };
    assertNoTpKeysRemain(renamed);
  } catch (e) {
    err((e as Error).message);
    return 3;
  }

  const { data, summary } = sanitizeFixtureWithSummary(renamed);

  await atomicWriteJson(outputPath, data);

  // Emit the SHA-256 checksum alongside the JSON. The companion test at
  // `realistic-athlete-fixture-checksum.test.ts` re-hashes the committed
  // file and compares to this checksum on every CI run; if they ever
  // diverge, either the operator forgot to commit one of the two files or
  // the JSON was mutated in place after regen. Both are bugs we want loud.
  // Format matches `shasum -a 256` output: `<hex>  <basename>`.
  const writtenBytes = readFileSync(outputPath);
  const hash = createHash("sha256").update(writtenBytes).digest("hex");
  const checksumPath = `${outputPath}.sha256`;
  writeFileSync(checksumPath, `${hash}  ${basename(outputPath)}\n`);

  out(`Wrote sanitized fixture: ${outputPath}`);
  out(`Wrote checksum:          ${checksumPath}`);
  for (const line of formatSummary(summary)) out(line);
  for (const line of formatRenameWarnings(activitiesRenameSummary)) err(line);

  return 0;
}

function decodeWellnessDay(row: unknown, index: number) {
  try {
    return decodeWellnessRow(row);
  } catch (error) {
    if (!(error instanceof RowRejection)) throw error;
    throw new Error(`wellness[${index}]: ${error.message}`, { cause: error });
  }
}

function formatRenameWarnings(summary: RenameSummary): string[] {
  return Object.entries(summary.skippedNonNumeric)
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([field, count]) =>
        `⚠ Skipped non-number TP values during rename: ${field} (×${count} in activities)`,
    );
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function formatSummary(s: SanitizeSummary): string[] {
  const lines: string[] = [];
  const droppedEntries = orderedEntries(s.droppedKeys);
  if (droppedEntries.length > 0) {
    const total = droppedEntries.reduce((sum, [, n]) => sum + n, 0);
    const top = droppedEntries.slice(0, 12);
    const tail = droppedEntries.length > top.length ? `, …+${droppedEntries.length - top.length} more` : "";
    lines.push(`Dropped ${total} key occurrence(s) (${droppedEntries.length} distinct): ${formatCounts(top)}${tail}`);
  }
  const transformedEntries = orderedEntries(s.transformedKeys);
  if (transformedEntries.length > 0) {
    lines.push(`Transformed: ${formatCounts(transformedEntries)}`);
  }
  return lines;
}

function orderedEntries(record: Record<string, number>): Array<[string, number]> {
  return Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatCounts(entries: Array<[string, number]>): string {
  return entries.map(([k, n]) => `${k} (×${n})`).join(", ");
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
