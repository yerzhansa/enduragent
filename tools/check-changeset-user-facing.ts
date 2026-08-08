// changeset-userfacing-lint:skip-file — this gate's own source and its test
// legitimately embed sample changeset bodies (with `User-facing:` lines) and
// sample package names as fixtures; without the marker the gate would have no
// reason to flag itself, but the marker keeps the convention uniform with the
// sibling gates whose source/tests embed the tokens they scan for.
/**
 * Changeset user-facing routing lint — `pnpm check:changeset-userfacing`.
 *
 * The Telegram bot's `/whatsnew` parses `User-facing:` lines out of the
 * published release body. A release body is built by changesets ONLY for
 * packages that actually publish — the private `@enduragent/core` package has
 * no npm release, so a `User-facing:` line filed against `@enduragent/core`
 * alone never reaches an athlete. This gate blocks that misfiling on PR: every
 * changeset whose body carries a `User-facing:` line MUST name at least one
 * PUBLISHED BINARY package in its frontmatter package list.
 *
 * "Published binary" is computed DYNAMICALLY from the on-disk package manifests
 * (`packages/<dir>/package.json`), never hardcoded:
 *   hasBin  = pkg.bin is a non-empty string OR an object with >= 1 key
 *   isPublic = pkg.private !== true   (a missing `private` field is public)
 *   publishedBinary = hasBin && isPublic
 * The set is keyed by `pkg.name` (npm identity), since the directory basename
 * and the scoped npm name can diverge. This auto-extends: the moment a sibling
 * binary drops `private` (or sets it false) it joins the set with zero code
 * change; marking the one published binary private auto-removes it.
 *
 * A changeset with NO `User-facing:` line is unaffected (pure-infra changesets
 * legitimately target only the private packages). `.changeset/README.md` and
 * `.changeset/config.json` are not changesets and are ignored.
 *
 * Parsing matches the sibling gates: `.md` is treated as a frontmatter block
 * (the leading `--- ... ---` fence) plus a prose body, both reached by plain
 * string scanning — no YAML or frontmatter library. The `User-facing:` line is
 * matched case-insensitively anywhere in the BODY; the package list is read
 * from the frontmatter's `"<name>": <bump>` lines.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { ext, collectFiles, makeSkipCheck, nonFlagArgs, runGateCli } from "./lint-fs.js";

export interface ChangesetHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly namedPackages: readonly string[];
}

const MD_EXTS = new Set([".md", ".mdx"]);

// Filenames inside .changeset/ that are NOT changesets.
const NON_CHANGESET_BASENAMES: ReadonlySet<string> = new Set(["README.md", "config.json"]);

const SKIP_DIRECTIVE = "changeset-userfacing-lint:skip-file";

const isSkippedFile = makeSkipCheck(SKIP_DIRECTIVE);

// A `User-facing:` marker anywhere in a body line, case-insensitive and
// UNANCHORED, matching the literal `User-facing:` token the consumer keys on:
// `parseUserFacing` in packages/core/src/release-notes.ts (`/User-facing:\s*(.+?)\s*$/i`).
// Unanchored is what makes the gate sound — a marker written as a markdown
// bullet (`- User-facing: …`) or otherwise indented still reaches /whatsnew, so
// the gate MUST see it too; an anchored `^[ \t]*…` regex would miss the bullet
// form and let a real misfiling through. The colon is required immediately
// after `facing` (no `[ \t]*` before it) so the gate stays in lockstep with the
// consumer and does not over-flag a `User-facing :` form the consumer ignores.
const USER_FACING_RE = /user-facing:/i;

// A frontmatter package entry: `"<name>": <bump>`. The name is double-quoted;
// the bump (patch/minor/major) follows a colon. Single-quoted or unquoted YAML
// keys are not produced by `changeset add`, so the double-quoted shape is the
// one the tool emits and the only one we read.
const FRONTMATTER_PKG_RE = /^[ \t]*"([^"]+)"[ \t]*:[ \t]*\S/;

/**
 * Split a changeset's raw text into its frontmatter block and body. The
 * frontmatter is the content between the first `---` fence and the next `---`
 * fence (the changeset format always opens with `---` on line 1). When no
 * closing fence is found, everything is treated as body (no package list).
 */
function splitFrontmatter(source: string): {
  frontmatter: string;
  body: string;
  bodyStartLine: number;
} {
  const lines = source.split("\n");
  // No opening fence, or no closing fence found: the whole source is body.
  const noFrontmatter = { frontmatter: "", body: source, bodyStartLine: 1 };
  if (lines[0]?.trim() !== "---") return noFrontmatter;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return {
        frontmatter: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
        // 1-based source line of the body's first line (after the closing fence).
        bodyStartLine: i + 2,
      };
    }
  }
  return noFrontmatter;
}

/** Package names from a changeset's frontmatter package list. */
function parseFrontmatterPackages(frontmatter: string): string[] {
  const names: string[] = [];
  for (const line of frontmatter.split("\n")) {
    const m = FRONTMATTER_PKG_RE.exec(line);
    if (m !== null) names.push(m[1]);
  }
  return names;
}

/**
 * Discover the set of published-binary package names by scanning
 * `<packagesDir>/<entry>/package.json`. A package qualifies when it declares a
 * non-empty `bin` AND is not `private`. Unparseable manifests are skipped with
 * a warning rather than crashing the gate. Keyed by `pkg.name`.
 */
export function discoverPublishedBinaries(packagesDir: string): Set<string> {
  const published = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync(packagesDir);
  } catch {
    return published; // no packages dir in scope (e.g. a temp tree) — empty set
  }
  for (const entry of entries) {
    const manifestPath = join(packagesDir, entry, "package.json");
    let raw: string;
    try {
      if (!statSync(manifestPath).isFile()) continue;
      raw = readFileSync(manifestPath, "utf-8");
    } catch {
      continue; // no package.json under this entry
    }
    let pkg: { name?: unknown; bin?: unknown; private?: unknown };
    try {
      pkg = JSON.parse(raw) as typeof pkg;
    } catch {
      console.warn(`check-changeset-userfacing: skipping unparseable manifest ${manifestPath}`);
      continue;
    }
    const hasBin =
      pkg.bin != null &&
      (typeof pkg.bin === "string"
        ? pkg.bin.length > 0
        : typeof pkg.bin === "object" && Object.keys(pkg.bin as object).length > 0);
    const isPublic = pkg.private !== true;
    if (hasBin && isPublic && typeof pkg.name === "string" && pkg.name.length > 0) {
      published.add(pkg.name);
    }
  }
  return published;
}

/**
 * Lint a single changeset file. Returns a hit when the body carries a
 * `User-facing:` line but no named frontmatter package is a published binary.
 * Returns `[]` when there is no `User-facing:` line, when the file is skipped,
 * when it is a non-changeset (README/config), or when the routing is correct.
 *
 * The hit's line/column point at the first `User-facing:` line (the offending
 * surface), so the report tells the author exactly which line provoked the
 * routing requirement.
 */
function findHitsInChangesetFile(file: string, published: ReadonlySet<string>): ChangesetHit[] {
  if (NON_CHANGESET_BASENAMES.has(basename(file))) return [];
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];

  const { frontmatter, body, bodyStartLine } = splitFrontmatter(source);

  // Find the first `User-facing:` marker in the BODY only — the frontmatter is
  // the package list, not prose, so a stray match there must not count. Scanning
  // per body line yields both the existence check and an accurate location.
  const bodyLines = body.split("\n");
  let markerBodyIdx = -1;
  let column = 1;
  for (let i = 0; i < bodyLines.length; i++) {
    const m = USER_FACING_RE.exec(bodyLines[i]);
    if (m !== null) {
      markerBodyIdx = i;
      column = m.index + 1;
      break;
    }
  }
  if (markerBodyIdx === -1) return [];

  const named = parseFrontmatterPackages(frontmatter);
  if (named.some((name) => published.has(name))) return [];

  // Translate the body-relative line back to the original source line so the
  // report points at the offending line, not an offset into the stripped body.
  const line = bodyStartLine + markerBodyIdx;

  return [{ file, line, column, namedPackages: named }];
}

/**
 * Lint the given files. Non-`.md`/`.mdx` files are skipped silently so the
 * aggregator tolerates `git diff --name-only` output. The published-binary set
 * is computed once from `packagesDir`, or reused when a caller (e.g. `main`,
 * which prints the set too) has already discovered it.
 */
export function findChangesetHits(
  files: readonly string[],
  packagesDir = "packages",
  published: ReadonlySet<string> = discoverPublishedBinaries(packagesDir),
): ChangesetHit[] {
  const out: ChangesetHit[] = [];
  for (const file of files) {
    if (MD_EXTS.has(ext(file))) {
      out.push(...findHitsInChangesetFile(file, published));
    }
  }
  return out;
}

const DEFAULT_SCAN_PATHS: readonly string[] = [".changeset"];
const DEFAULT_PACKAGES_DIR = "packages";

function formatHit(hit: ChangesetHit): string {
  const named =
    hit.namedPackages.length > 0
      ? hit.namedPackages.map((n) => `"${n}"`).join(", ")
      : "(no packages named)";
  return (
    `${hit.file}:${hit.line}:${hit.column}  has a User-facing line but names no published binary ` +
    `— named ${named}; add a published binary (e.g. "cycling-coach") to the frontmatter package list`
  );
}

export function main(argv: readonly string[]): number {
  const args = nonFlagArgs(argv);
  const inputPaths = args.length > 0 ? args : DEFAULT_SCAN_PATHS;

  const files: string[] = [];
  for (const p of inputPaths) collectFiles(p, files);

  const changesetFiles = files.filter((f) => MD_EXTS.has(ext(f)));
  if (changesetFiles.length === 0) {
    console.log("check-changeset-userfacing: no changesets in scope.");
    return 0;
  }

  const published = discoverPublishedBinaries(DEFAULT_PACKAGES_DIR);
  const hits = findChangesetHits(changesetFiles, DEFAULT_PACKAGES_DIR, published);
  if (hits.length === 0) {
    console.log(
      `check-changeset-userfacing: ${changesetFiles.length} changeset(s) clean ` +
        `(published binaries: ${[...published].sort().join(", ") || "none"}).`,
    );
    return 0;
  }
  console.error(`check-changeset-userfacing: ${hits.length} misfiled User-facing changeset(s) found:`);
  for (const hit of hits) console.error("  " + formatHit(hit));
  console.error(
    "\nA `User-facing:` line only reaches athletes via /whatsnew if the changeset " +
      "names a PUBLISHED BINARY package (one with a `bin` field and not `private`). " +
      `Currently: ${[...published].sort().join(", ") || "none"}. ` +
      "Add it to the changeset frontmatter, or drop the User-facing line if the change " +
      "is pure infra. See .changeset/README.md / CLAUDE.local.md (Changesets).",
  );
  return 1;
}

runGateCli(import.meta.url, main);
