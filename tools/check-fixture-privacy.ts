// fixture-privacy-lint:skip-file — this linter's own source legitimately names
// the forbidden shapes (the SYNTHETIC_INTERVALS_ID_ALLOWLIST entries, the
// regexes, the year-threshold constant). Every literal here is a regex shape, a
// year-threshold integer, or a documented synthetic placeholder — never a real
// id or a real-era date. The shape-based design is precisely what makes this
// lint safe to ship in-repo. Same exemption for the linter's test fixtures.
/**
 * Fixture-privacy lint — `pnpm check:fixture-privacy`.
 *
 * Committed golden fixtures derive from a real intervals.icu athlete account.
 * Two classes of identifier must never reach a committed fixture, both enforced
 * here by SHAPE (no real tokens live in this source):
 *
 *   Rule A — real intervals.icu id shape `i\d{8,9}` anywhere under `packages/`,
 *            `tools/`, `.changeset/`, and the committed root prose surfaces
 *            (README.md, CONTRIBUTING.md, CONTEXT-MAP.md, NOTICE.md).
 *            The documented real shape (see the JSDoc on
 *            ActivitySchema.id) is a lowercase `i` followed by 8-9 digits.
 *            Short synthetic placeholders (`i1`, `i9876543` — <= 7 digits) are
 *            below the shape and pass; the few synthetic placeholders that DO
 *            carry 8-9 digits (so a test can exercise the real string-id shape)
 *            are listed in SYNTHETIC_INTERVALS_ID_ALLOWLIST.
 *
 *   Rule B — current-era ISO dates (year >= CURRENT_ERA_CUTOFF_YEAR) inside
 *            committed golden fixtures that carry real-athlete data. The real
 *            athlete's training calendar is shifted back one full Gregorian
 *            cycle (to the 1990s) so it can never publish race days / rest
 *            patterns. Fully-synthetic golden fixtures (hand-crafted /
 *            fuzz-derived, zero real data) carry fabricated dates and are
 *            exempt via SYNTHETIC_FIXTURE_ALLOWLIST. `.test.ts` source — which
 *            legitimately uses inline current-era dates as test inputs — is NOT
 *            a privacy surface and is out of scope for Rule B.
 *
 * Modeled on tools/check-trademarks.ts: AST walk (string + template literals +
 * comment trivia) for `.ts`, plain regex for `.json`, fenced-code-stripped
 * regex for `.md`, and a `fixture-privacy-lint:skip-file` marker recognized in
 * the first 1 KB.
 */

import * as ts from "typescript";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import type {
  Attr as XmlAttr,
  Document as XmlDocument,
  Element as XmlElement,
  Node as XmlNode,
} from "@xmldom/xmldom";
import { TS_EXTS, ext, collectFiles, makeSkipCheck, runGateCli } from "./lint-fs.js";
import {
  FIT_DATE_TIME_FLOOR_ISO,
  FIT_DATE_TIME_FLOOR_RAW,
  LOCAL_ENCODER_PACKAGE,
  LOCAL_ENCODER_VERSION,
  SYNTHETIC_FILE_ID_SERIAL_MAX,
  SYNTHETIC_FILE_ID_SERIAL_MIN,
  SYNTHETIC_GEO_ALGORITHM,
  SYNTHETIC_GEO_BOX,
  SYNTHETIC_GEO_CENTER,
  SYNTHETIC_GEO_EARTH_RADIUS_M,
  SYNTHETIC_GEO_LAPS,
  SYNTHETIC_GEO_MAX_CUMULATIVE_DIVERGENCE_RATIO,
  SYNTHETIC_GEO_QUANTIZATION,
} from "./synthetic-fixture-policy.js";

export type PrivacyRule = "intervals-id" | "current-era-date" | "binary-manifest" | "xml-privacy";

export interface PrivacyHit {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly path: string;
  readonly rule: PrivacyRule;
  readonly code: string;
  readonly detail: string;
}

// Real intervals.icu string-id shape: lowercase `i` + 8 or 9 digits.
const INTERVALS_ID_RE = /\bi\d{8,9}\b/g;

// Synthetic placeholders that intentionally carry the 8-9-digit shape so a test
// can exercise the real string-id branch. These are fabricated values, never a
// real account id. Keep in sync with the id-literal sites in the test suite.
export const SYNTHETIC_INTERVALS_ID_ALLOWLIST: ReadonlySet<string> = new Set([
  "i12345678",
  "i12345679",
]);

// Year >= this is "current era" and forbidden inside real-data golden fixtures.
// The de-identifying shift lands real dates in the 1990s; intervals.icu launched
// ~2015 and real fixtures are 2024+, so 2015 sits comfortably between. This is a
// year-threshold CONSTANT (shape config), not a real date.
const CURRENT_ERA_CUTOFF_YEAR = 2015;

// ISO date head at the START of a JSON string value: `YYYY-MM-DD...`.
const ISO_DATE_VALUE_RE = /^(\d{4})-\d{2}-\d{2}/;

// Fully-synthetic golden fixtures (hand-crafted / fuzz-derived / builder-
// generated, zero real-athlete data — see packages/core/tests/fixtures/README.md
// provenance column). Their dates are fabricated, so Rule B does not apply.
// Only the real-data fixtures (realistic-athlete, capability-qualifying,
// curve-equipped) must carry shifted dates. Filenames, not paths.
export const SYNTHETIC_FIXTURE_ALLOWLIST: ReadonlySet<string> = new Set([
  "new-athlete-empty.json",
  "data-gap-mid-history.json",
  "boundary-monotony.json",
  "boundary-sum-strain.json",
  "boundary-zone-total-secs.json",
  "multisport-tie.json",
  "multisport-thin-primary.json",
  "populated-benchmark-and-consistency.json",
  "rest-week-with-baseline.json",
  "dfa-equipped.json",
  "running-only.json",
  "post-break-resume.json",
  "zero-activities.json",
]);

const MD_EXTS = new Set([".md", ".mdx"]);
const JSON_EXTS = new Set([".json"]);

const SKIP_DIRECTIVE = "fixture-privacy-lint:skip-file";

const GOLDEN_FIXTURE_DIR = "packages/core/tests/fixtures/golden";

function basenameOf(file: string): string {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i === -1 ? file : file.slice(i + 1);
}

const isSkippedFile = makeSkipCheck(SKIP_DIRECTIVE);

function* matchIntervalsId(
  text: string,
  baseOffset: number,
): Generator<{ offset: number; value: string }> {
  INTERVALS_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTERVALS_ID_RE.exec(text)) !== null) {
    if (SYNTHETIC_INTERVALS_ID_ALLOWLIST.has(m[0])) continue;
    yield { offset: baseOffset + m.index, value: m[0] };
  }
}

// === Rule A: real intervals.icu id shape in source (.ts / .json / .md) ===

function findIdHitsInTsFile(file: string): PrivacyHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const hits: PrivacyHit[] = [];

  function recordHit(offset: number, value: string): void {
    const lc = sf.getLineAndCharacterOfPosition(offset);
    hits.push({
      file,
      line: lc.line + 1,
      column: lc.character + 1,
      path: "$",
      rule: "intervals-id",
      code: "source.intervals_id",
      detail: `real intervals.icu id shape "${value}" — use a synthetic placeholder (<= 7 digits) or add to SYNTHETIC_INTERVALS_ID_ALLOWLIST`,
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const contentStart = node.getStart(sf) + 1;
      for (const hit of matchIntervalsId(node.text, contentStart)) {
        recordHit(hit.offset, hit.value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  const scanner = ts.createScanner(
    ts.ScriptTarget.ESNext,
    /*skipTrivia*/ false,
    ts.LanguageVariant.Standard,
    source,
  );
  let kind: ts.SyntaxKind;
  while ((kind = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenPos();
      for (const hit of matchIntervalsId(scanner.getTokenText(), start)) {
        recordHit(hit.offset, hit.value);
      }
    }
  }
  return hits;
}

function offsetToLineCol(lineStarts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

function buildLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  return lineStarts;
}

function findIdHitsInJsonFile(file: string): PrivacyHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const lineStarts = buildLineStarts(source);
  const hits: PrivacyHit[] = [];
  for (const hit of matchIntervalsId(source, 0)) {
    const { line, column } = offsetToLineCol(lineStarts, hit.offset);
    hits.push({
      file,
      line,
      column,
      path: "$",
      rule: "intervals-id",
      code: "source.intervals_id",
      detail: `real intervals.icu id shape "${hit.value}" in committed JSON`,
    });
  }
  return hits;
}

function findIdHitsInMdFile(file: string): PrivacyHit[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const lineStarts = buildLineStarts(source);
  const hits: PrivacyHit[] = [];
  for (const hit of matchIntervalsId(source, 0)) {
    const { line, column } = offsetToLineCol(lineStarts, hit.offset);
    hits.push({
      file,
      line,
      column,
      path: "$",
      rule: "intervals-id",
      code: "source.intervals_id",
      detail: `real intervals.icu id shape "${hit.value}" in Markdown`,
    });
  }
  return hits;
}

// === Rule B: current-era ISO dates inside real-data golden fixtures ===

function walkJsonForDates(
  value: unknown,
  path: string,
  onHit: (path: string, year: number) => void,
): void {
  if (typeof value === "string") {
    const m = ISO_DATE_VALUE_RE.exec(value);
    if (m !== null) {
      const year = Number(m[1]);
      if (year >= CURRENT_ERA_CUTOFF_YEAR) onHit(path, year);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkJsonForDates(item, `${path}[${i}]`, onHit));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The key itself can be date-shaped (streams record keyed by date).
      const km = ISO_DATE_VALUE_RE.exec(k);
      if (km !== null && Number(km[1]) >= CURRENT_ERA_CUTOFF_YEAR) {
        onHit(`${path}.<key:${k}>`, Number(km[1]));
      }
      walkJsonForDates(v, `${path}.${k}`, onHit);
    }
  }
}

function findDateHitsInGoldenFixture(file: string): PrivacyHit[] {
  const base = basenameOf(file);
  if (SYNTHETIC_FIXTURE_ALLOWLIST.has(base)) return [];
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return []; // malformed JSON is a different concern, not ours
  }
  const hits: PrivacyHit[] = [];
  walkJsonForDates(parsed, base, (p, year) => {
    hits.push({
      file,
      line: 0,
      column: 0,
      path: "$",
      rule: "current-era-date",
      code: "source.current_era_date",
      detail:
        `current-era ISO date (year ${year} >= ${CURRENT_ERA_CUTOFF_YEAR}) at ${p} — ` +
        `regenerate through tools/sanitize-fixture.ts / the build-*-fixture.ts scripts ` +
        `so dates shift back one full Gregorian cycle (the synthetic epoch)`,
    });
  });
  return hits;
}

/** Lint the given files for Rule A (id shape). Extension-routed; non-source skipped. */
export function findIdHits(files: readonly string[]): PrivacyHit[] {
  const out: PrivacyHit[] = [];
  for (const file of files) {
    const fileExt = ext(file);
    if (TS_EXTS.has(fileExt)) out.push(...findIdHitsInTsFile(file));
    else if (JSON_EXTS.has(fileExt)) out.push(...findIdHitsInJsonFile(file));
    else if (MD_EXTS.has(fileExt)) out.push(...findIdHitsInMdFile(file));
  }
  return out;
}

/** Lint the given golden-fixture files for Rule B (current-era dates). */
export function findDateHits(goldenFiles: readonly string[]): PrivacyHit[] {
  const out: PrivacyHit[] = [];
  for (const file of goldenFiles) {
    if (ext(file) === ".json") out.push(...findDateHitsInGoldenFixture(file));
  }
  return out;
}

const BINARY_FIXTURE_EXTS = new Set([".fit", ".tcx", ".gpx"]);
const ACTIVITY_SIDECAR_RE = /\.(fit|tcx|gpx)\.sha256$/i;
const COMMITTED_MANIFEST_PATH = "packages/kernel-node/tests/fixtures/ingest/manifest.json";
const INGEST_PREFIX = "packages/kernel-node/tests/fixtures/ingest/";
const POLICY_PATH = fileURLToPath(new URL("./synthetic-fixture-policy.ts", import.meta.url));

// Top-level args are statSync'd directly, so the dot-entry skip inside
// collectFiles (which only applies while recursing) does not exclude
// `.changeset` here.
export const DEFAULT_SCAN_PATHS: readonly string[] = [
  "packages",
  "apps",
  "tools",
  ".changeset",
  "README.md",
  "CONTRIBUTING.md",
  "CONTEXT-MAP.md",
  "NOTICE.md",
];

export interface BinaryPrivacyOptions {
  readonly rootDir: string;
  readonly manifestPath?: string;
}

export interface FixturePrivacyInputs {
  readonly legacySourceFiles: readonly string[];
  readonly legacyGoldenFiles: readonly string[];
  readonly binaryInventoryFiles: readonly string[];
  readonly activitySidecarFiles: readonly string[];
}

const FAILURE_DETAIL = Object.freeze({
  "artifact.missing": "Required artifact is missing, unreadable, or not a regular file.",
  "artifact.invalid_utf8": "Artifact is not valid UTF-8.",
  "artifact.invalid_json": "Artifact is not valid JSON.",
  "artifact.noncanonical": "Artifact bytes are not canonical JSON.",
  "artifact.schema": "Artifact schema, key order, or value range is invalid.",
  "artifact.unsafe_path": "Path is not a safe physically contained repository path.",
  "artifact.unsorted": "Artifact entries are not in required order.",
  "artifact.duplicate_path": "Artifact contains a duplicate path.",
  "artifact.case_collision": "Artifact contains an ASCII-case path collision.",
  "artifact.duplicate_digest": "Artifact contains a duplicate fixture digest.",
  "artifact.inventory": "Staged artifact inventory is not exact.",
  "binary.unmanifested": "Activity fixture is not present in the committed manifest.",
  "binary.manifest_missing_file": "Manifest entry has no matching activity fixture.",
  "artifact.policy_hash": "Artifact policy digest does not match the current policy source.",
  "artifact.policy_snapshot": "Artifact policy snapshot does not match the current policy.",
  "artifact.encoder_coordinate":
    "Artifact encoder coordinate is invalid or does not match the pinned package.",
  "binary.byte_count": "Activity fixture byte count does not match the manifest.",
  "binary.hash": "Activity fixture digest does not match the manifest.",
  "binary.sidecar_missing": "Activity fixture sidecar is missing or unreadable.",
  "binary.sidecar_format": "Activity fixture sidecar bytes are not canonical.",
  "binary.sidecar_mismatch": "Activity fixture sidecar does not match the fixture and manifest.",
  "binary.sidecar_orphan": "Activity fixture sidecar has no matching activity fixture.",
  "binary.stage_destination_conflict":
    "Staged fixture conflicts with its destination or committed manifest entry.",
  "artifact.provenance": "Artifact provenance or recipe binding is invalid.",
  "artifact.attestation": "Artifact operator attestation is invalid.",
  "artifact.evidence": "Artifact QA evidence is invalid.",
  "artifact.evidence_binding": "Artifact evidence digest binding is invalid.",
  "artifact.validation": "Artifact validation or drop metadata is invalid.",
  "xml.invalid_utf8": "XML fixture is not valid UTF-8.",
  "xml.doctype_forbidden": "XML document type or entity declaration is forbidden.",
  "xml.processing_instruction_forbidden": "XML processing instructions are forbidden.",
  "xml.parse": "XML fixture is not a well-formed recover-free document.",
  "xml.namespace": "XML root namespace, local name, or version is invalid.",
  "xml.missing_required": "XML fixture is missing a required paired value.",
  "xml.invalid_number": "XML fixture contains an invalid numeric value.",
  "xml.invalid_time": "XML fixture contains an invalid or unzoned required time.",
  "xml.invalid_coordinate": "XML fixture contains a coordinate outside synthetic bounds.",
  "xml.current_era_date": "XML fixture contains a current-era date-shaped value.",
  "cli.usage": "Invalid command-line usage.",
} as const);

const FAILURE_CLASS: Readonly<Record<string, number>> = Object.freeze({
  "artifact.missing": 1,
  "artifact.invalid_utf8": 1,
  "artifact.invalid_json": 1,
  "artifact.noncanonical": 1,
  "artifact.schema": 2,
  "artifact.unsafe_path": 3,
  "artifact.unsorted": 3,
  "artifact.duplicate_path": 3,
  "artifact.case_collision": 3,
  "artifact.duplicate_digest": 3,
  "artifact.inventory": 4,
  "binary.unmanifested": 4,
  "binary.manifest_missing_file": 4,
  "artifact.policy_hash": 5,
  "artifact.policy_snapshot": 5,
  "artifact.encoder_coordinate": 5,
  "binary.byte_count": 6,
  "binary.hash": 6,
  "binary.sidecar_missing": 6,
  "binary.sidecar_format": 6,
  "binary.sidecar_mismatch": 6,
  "binary.sidecar_orphan": 6,
  "binary.stage_destination_conflict": 6,
  "artifact.provenance": 7,
  "artifact.attestation": 7,
  "artifact.evidence": 7,
  "artifact.evidence_binding": 7,
  "artifact.validation": 7,
  "xml.invalid_utf8": 8,
  "xml.doctype_forbidden": 8,
  "xml.processing_instruction_forbidden": 8,
  "xml.parse": 8,
  "xml.namespace": 8,
  "xml.missing_required": 8,
  "xml.invalid_number": 8,
  "xml.invalid_time": 8,
  "xml.invalid_coordinate": 8,
  "xml.current_era_date": 8,
  "source.intervals_id": 9,
  "source.current_era_date": 9,
});

function scalarCompare(a: string, b: string): number {
  const aa = Array.from(a, (c) => c.codePointAt(0)!);
  const bb = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
}

function sortHits(hits: readonly PrivacyHit[]): PrivacyHit[] {
  return [...hits].sort((a, b) => {
    for (const [x, y] of [
      [a.file, b.file],
      [a.code, b.code],
      [a.path, b.path],
      [a.rule, b.rule],
    ] as const) {
      const n = scalarCompare(x, y);
      if (n !== 0) return n;
    }
    return a.line - b.line || a.column - b.column || scalarCompare(a.detail, b.detail);
  });
}

function firstFailureClass(hits: readonly PrivacyHit[]): PrivacyHit[] {
  if (hits.length === 0) return [];
  const first = Math.min(...hits.map((hit) => FAILURE_CLASS[hit.code] ?? 99));
  return sortHits(hits.filter((hit) => (FAILURE_CLASS[hit.code] ?? 99) === first));
}

function newHit(
  file: string,
  path: string,
  code: keyof typeof FAILURE_DETAIL,
  rule: PrivacyRule = "binary-manifest",
): PrivacyHit {
  return { file, line: 0, column: 0, path, rule, code, detail: FAILURE_DETAIL[code] };
}

export function fixturePrivacyDiagnosticForTest(
  code: keyof typeof FAILURE_DETAIL,
  file = "fixture",
  path = "$",
  rule: PrivacyRule = code.startsWith("xml.") ? "xml-privacy" : "binary-manifest",
): PrivacyHit {
  return newHit(file, path, code, rule);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function currentPolicyHash(): string {
  return sha256(readFileSync(POLICY_PATH));
}

type OrderedJson =
  | { readonly kind: "object"; readonly entries: readonly { key: string; value: OrderedJson }[] }
  | { readonly kind: "array"; readonly items: readonly OrderedJson[] }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "null" };

class OrderedJsonScanner {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): OrderedJson {
    const value = this.value();
    this.ws();
    if (this.index !== this.source.length) throw new Error("ordered JSON invariant");
    return value;
  }

  private ws(): void {
    while (/[ \t\n\r]/.test(this.source[this.index] ?? "")) this.index++;
  }

  private value(): OrderedJson {
    this.ws();
    const ch = this.source[this.index];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"') return { kind: "string", value: this.string() };
    const rest = this.source.slice(this.index);
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (number !== null) {
      this.index += number[0].length;
      return { kind: "number", raw: number[0] };
    }
    for (const [literal, node] of [
      ["true", { kind: "boolean", value: true }],
      ["false", { kind: "boolean", value: false }],
      ["null", { kind: "null" }],
    ] as const) {
      if (rest.startsWith(literal)) {
        this.index += literal.length;
        return node;
      }
    }
    throw new Error("ordered JSON invariant");
  }

  private string(): string {
    const start = this.index++;
    let escaped = false;
    while (this.index < this.source.length) {
      const ch = this.source[this.index++];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') return JSON.parse(this.source.slice(start, this.index)) as string;
    }
    throw new Error("ordered JSON invariant");
  }

  private object(): OrderedJson {
    this.index++;
    const entries: { key: string; value: OrderedJson }[] = [];
    this.ws();
    if (this.source[this.index] === "}") {
      this.index++;
      return { kind: "object", entries };
    }
    while (true) {
      this.ws();
      if (this.source[this.index] !== '"') throw new Error("ordered JSON invariant");
      const key = this.string();
      this.ws();
      if (this.source[this.index++] !== ":") throw new Error("ordered JSON invariant");
      entries.push({ key, value: this.value() });
      this.ws();
      const next = this.source[this.index++];
      if (next === "}") break;
      if (next !== ",") throw new Error("ordered JSON invariant");
    }
    return { kind: "object", entries };
  }

  private array(): OrderedJson {
    this.index++;
    const items: OrderedJson[] = [];
    this.ws();
    if (this.source[this.index] === "]") {
      this.index++;
      return { kind: "array", items };
    }
    while (true) {
      items.push(this.value());
      this.ws();
      const next = this.source[this.index++];
      if (next === "]") break;
      if (next !== ",") throw new Error("ordered JSON invariant");
    }
    return { kind: "array", items };
  }
}

function formatOrderedJson(node: OrderedJson, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (node.kind === "string") return JSON.stringify(node.value);
  if (node.kind === "number") {
    const number = Number(node.raw);
    return Number.isFinite(number) ? JSON.stringify(number) : node.raw;
  }
  if (node.kind === "boolean") return node.value ? "true" : "false";
  if (node.kind === "null") return "null";
  if (node.kind === "array") {
    if (node.items.length === 0) return "[]";
    return `[\n${node.items
      .map(
        (value, i) =>
          `${childIndent}${formatOrderedJson(value, depth + 1)}${i + 1 < node.items.length ? "," : ""}`,
      )
      .join("\n")}\n${indent}]`;
  }
  if (node.entries.length === 0) return "{}";
  return `{\n${node.entries
    .map(
      ({ key, value }, i) =>
        `${childIndent}${JSON.stringify(key)}: ${formatOrderedJson(value, depth + 1)}${i + 1 < node.entries.length ? "," : ""}`,
    )
    .join("\n")}\n${indent}}`;
}

interface ParsedArtifact {
  readonly file: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly value: unknown;
  readonly ordered: OrderedJson;
}

function readArtifact(
  pathname: string,
  file: string,
): { artifact?: ParsedArtifact; hits: PrivacyHit[] } {
  let bytes: Buffer;
  try {
    if (!statSync(pathname).isFile()) throw new Error("not file");
    accessSync(pathname, constants.R_OK);
    bytes = readFileSync(pathname);
  } catch {
    return { hits: [newHit(file, "$", "artifact.missing")] };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { hits: [newHit(file, "$", "artifact.invalid_utf8")] };
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return { hits: [newHit(file, "$", "artifact.noncanonical")] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { hits: [newHit(file, "$", "artifact.invalid_json")] };
  }
  let ordered: OrderedJson;
  try {
    ordered = new OrderedJsonScanner(text).parse();
  } catch {
    throw new Error("JSON scanner disagreed with JSON.parse");
  }
  if (`${formatOrderedJson(ordered)}\n` !== text) {
    return { hits: [newHit(file, "$", "artifact.noncanonical")] };
  }
  return { artifact: { file, bytes, text, value, ordered }, hits: [] };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function orderedObject(
  node: OrderedJson,
): readonly { key: string; value: OrderedJson }[] | undefined {
  return node.kind === "object" ? node.entries : undefined;
}

function exactKeys(
  value: unknown,
  node: OrderedJson,
  keys: readonly string[],
): value is Record<string, unknown> {
  const object = objectValue(value);
  const entries = orderedObject(node);
  return (
    object !== undefined &&
    entries !== undefined &&
    entries.length === keys.length &&
    entries.every((entry, i) => entry.key === keys[i]) &&
    Object.keys(object).length === keys.length &&
    keys.every((key) => Object.hasOwn(object, key))
  );
}

function childNode(node: OrderedJson, key: string): OrderedJson | undefined {
  const entries = orderedObject(node);
  return entries?.find((entry) => entry.key === key)?.value;
}

function arrayNodes(node: OrderedJson | undefined): readonly OrderedJson[] | undefined {
  return node?.kind === "array" ? node.items : undefined;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafePath(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) return false;
  const segments = value.split("/");
  return (
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    posix.normalize(value) === value
  );
}

const QA_CELLS = [
  "triathlon-multisport",
  "duathlon-run-bike-run",
  "brick-cycling",
  "brick-running",
  "multisport-missing-generic-transition",
  "pool-swim-drill-lengths",
  "pool-size-correction",
  "dual-developer-index",
  "fallback-cycling-tcx",
  "fallback-cycling-gpx",
] as const;
const FIT_QA_CELLS = QA_CELLS.slice(0, 8);

interface ManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: "fit" | "tcx" | "gpx";
  readonly serial: number | null;
  readonly qa_cell: string;
}

interface Manifest {
  readonly schema_version: 1;
  readonly hash_algorithm: "sha256";
  readonly policy_sha256: string;
  readonly files: readonly ManifestEntry[];
}

function validateManifestEntry(value: unknown, node: OrderedJson): value is ManifestEntry {
  if (!exactKeys(value, node, ["path", "sha256", "bytes", "kind", "serial", "qa_cell"]))
    return false;
  const object = value;
  if (
    typeof object.path !== "string" ||
    !isDigest(object.sha256) ||
    !isPositiveSafeInteger(object.bytes) ||
    !["fit", "tcx", "gpx"].includes(object.kind as string) ||
    !QA_CELLS.includes(object.qa_cell as (typeof QA_CELLS)[number])
  )
    return false;
  const kind = object.kind as "fit" | "tcx" | "gpx";
  if (extname(object.path).toLowerCase() !== `.${kind}`) return false;
  if (kind === "fit") {
    return (
      Number.isSafeInteger(object.serial) &&
      (object.serial as number) >= SYNTHETIC_FILE_ID_SERIAL_MIN &&
      (object.serial as number) <= SYNTHETIC_FILE_ID_SERIAL_MAX &&
      FIT_QA_CELLS.includes(object.qa_cell as (typeof FIT_QA_CELLS)[number])
    );
  }
  return object.serial === null && object.qa_cell === `fallback-cycling-${kind}`;
}

function validateManifestSchema(artifact: ParsedArtifact): {
  manifest?: Manifest;
  hits: PrivacyHit[];
} {
  const value = artifact.value;
  const node = artifact.ordered;
  if (!exactKeys(value, node, ["schema_version", "hash_algorithm", "policy_sha256", "files"])) {
    return { hits: [newHit(artifact.file, "$", "artifact.schema")] };
  }
  const fileNodes = arrayNodes(childNode(node, "files"));
  if (
    value.schema_version !== 1 ||
    value.hash_algorithm !== "sha256" ||
    !isDigest(value.policy_sha256) ||
    !Array.isArray(value.files) ||
    fileNodes === undefined ||
    value.files.length !== fileNodes.length ||
    !value.files.every((entry, i) => validateManifestEntry(entry, fileNodes[i])) ||
    (value.files.length !== 0 && value.files.length !== 10)
  ) {
    return { hits: [newHit(artifact.file, "$", "artifact.schema")] };
  }
  if (value.files.length === 10) {
    const kinds = value.files.map((entry) => (entry as ManifestEntry).kind);
    const qa = value.files.map((entry) => (entry as ManifestEntry).qa_cell);
    const serials = value.files
      .filter((entry) => (entry as ManifestEntry).kind === "fit")
      .map((entry) => (entry as ManifestEntry).serial);
    if (
      kinds.filter((kind) => kind === "fit").length !== 8 ||
      kinds.filter((kind) => kind === "tcx").length !== 1 ||
      kinds.filter((kind) => kind === "gpx").length !== 1 ||
      new Set(qa).size !== 10 ||
      !QA_CELLS.every((cell) => qa.includes(cell)) ||
      new Set(serials).size !== 8 ||
      !Array.from({ length: 8 }, (_, i) => SYNTHETIC_FILE_ID_SERIAL_MIN + i).every((serial) =>
        serials.includes(serial),
      )
    )
      return { hits: [newHit(artifact.file, "$.files", "artifact.schema")] };
  }
  return { manifest: value as unknown as Manifest, hits: [] };
}

function validateEntryCollections(entries: readonly ManifestEntry[], file: string): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  const seen = new Set<string>();
  const folded = new Set<string>();
  const digests = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const p = `$.files[${i}].path`;
    if (!isSafePath(entry.path) || !entry.path.startsWith(INGEST_PREFIX)) {
      hits.push(newHit(file, p, "artifact.unsafe_path"));
    }
    if (i > 0 && scalarCompare(entries[i - 1].path, entry.path) > 0) {
      hits.push(newHit(file, "$.files", "artifact.unsorted"));
    }
    const duplicate = seen.has(entry.path);
    if (duplicate) hits.push(newHit(file, p, "artifact.duplicate_path"));
    const lower = entry.path.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (folded.has(lower) && !duplicate) hits.push(newHit(file, p, "artifact.case_collision"));
    seen.add(entry.path);
    folded.add(lower);
    if (digests.has(entry.sha256))
      hits.push(newHit(file, `$.files[${i}].sha256`, "artifact.duplicate_digest"));
    digests.add(entry.sha256);
  }
  return hits;
}

interface InventoryResult {
  readonly fixtures: readonly string[];
  readonly sidecars: readonly string[];
  readonly hits: readonly PrivacyHit[];
}

function lexicalRelative(rootAbsolute: string, lexicalPath: string): string | undefined {
  const absoluteLexical = resolve(rootAbsolute, lexicalPath);
  const relativeLexical = relative(rootAbsolute, absoluteLexical);
  if (
    relativeLexical === "" ||
    relativeLexical === ".." ||
    relativeLexical.startsWith(`..${sep}`) ||
    isAbsolute(relativeLexical)
  )
    return undefined;
  const repositoryPath = relativeLexical.split(sep).join("/");
  return isSafePath(repositoryPath) ? repositoryPath : undefined;
}

function inspectInventoryPath(
  rootAbsolute: string,
  rootReal: string,
  lexicalPath: string,
): { relative?: string; hit?: PrivacyHit } {
  const repositoryPath = lexicalRelative(rootAbsolute, lexicalPath);
  const display =
    repositoryPath ??
    relative(rootAbsolute, resolve(rootAbsolute, lexicalPath)).split(sep).join("/");
  if (repositoryPath === undefined)
    return { hit: newHit(display || "$", "$", "artifact.unsafe_path") };
  try {
    const targetReal = realpathSync(resolve(rootAbsolute, lexicalPath));
    if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`))
      throw new Error("outside");
    const target = statSync(targetReal);
    accessSync(targetReal, constants.R_OK);
    if (!target.isFile()) throw new Error("not file");
    return { relative: repositoryPath };
  } catch {
    return { hit: newHit(repositoryPath, "$", "artifact.unsafe_path") };
  }
}

function secureInventory(rootDir: string): InventoryResult {
  const rootAbsolute = resolve(rootDir);
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbsolute);
  } catch {
    return { fixtures: [], sidecars: [], hits: [newHit("$", "$", "artifact.unsafe_path")] };
  }
  const fixtures: string[] = [];
  const sidecars: string[] = [];
  const hits: PrivacyHit[] = [];

  const walk = (lexicalPath: string, explicit: boolean): void => {
    const absolute = resolve(rootAbsolute, lexicalPath);
    let lstat;
    try {
      lstat = lstatSync(absolute);
    } catch {
      return;
    }
    if (lstat.isSymbolicLink()) {
      let target;
      try {
        target = statSync(absolute);
      } catch {
        const repositoryPath =
          lexicalRelative(rootAbsolute, lexicalPath) ?? lexicalPath.split(sep).join("/");
        if (
          BINARY_FIXTURE_EXTS.has(extname(lexicalPath).toLowerCase()) ||
          ACTIVITY_SIDECAR_RE.test(lexicalPath)
        ) {
          hits.push(newHit(repositoryPath, "$", "artifact.unsafe_path"));
        } else {
          hits.push(newHit(repositoryPath, "$", "artifact.unsafe_path"));
        }
        return;
      }
      if (target.isDirectory()) {
        const repositoryPath =
          lexicalRelative(rootAbsolute, lexicalPath) ?? lexicalPath.split(sep).join("/");
        hits.push(newHit(repositoryPath, "$", "artifact.unsafe_path"));
        return;
      }
    }
    let target;
    try {
      target = statSync(absolute);
    } catch {
      return;
    }
    if (target.isDirectory()) {
      for (const entry of readdirSync(absolute).sort(scalarCompare)) {
        if (!explicit && (entry === "node_modules" || entry === "dist" || entry.startsWith(".")))
          continue;
        walk(join(lexicalPath, entry), false);
      }
      return;
    }
    const binary = BINARY_FIXTURE_EXTS.has(extname(lexicalPath).toLowerCase());
    const sidecar = ACTIVITY_SIDECAR_RE.test(lexicalPath);
    if (!binary && !sidecar) return;
    const inspected = inspectInventoryPath(rootAbsolute, rootReal, lexicalPath);
    if (inspected.hit !== undefined) hits.push(inspected.hit);
    else if (binary) fixtures.push(inspected.relative!);
    else sidecars.push(inspected.relative!);
  };

  for (const scanPath of DEFAULT_SCAN_PATHS) walk(scanPath, true);
  return {
    fixtures: [...new Set(fixtures)].sort(scalarCompare),
    sidecars: [...new Set(sidecars)].sort(scalarCompare),
    hits,
  };
}

const TCX_NAMESPACE = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2";
const GPX_NAMESPACES = new Set([
  "http://www.topografix.com/GPX/1/0",
  "http://www.topografix.com/GPX/1/1",
]);
const XML_NUMBER_RE = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const EXPLICIT_ZONE_RE = /(?:Z|[+-]\d{2}:\d{2})$/i;
const DATE_HEAD_RE = /^(\d{4})-\d{2}-\d{2}/;

type XmlParserFunction = (text: string) => XmlDocument;

function childNodePath(parentPath: string, parent: XmlNode, child: XmlNode): string {
  let index = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const candidate = parent.childNodes.item(i);
    if (candidate === child) break;
    if (candidate?.nodeType === 1) index++;
  }
  return `${parentPath}/element()[${index}]`;
}

function anyNodePath(parentPath: string, parent: XmlNode, child: XmlNode): string {
  let index = 0;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const candidate = parent.childNodes.item(i);
    if (candidate === child) break;
    index++;
  }
  return `${parentPath}/node()[${index}]`;
}

function documentElementPath(node: XmlNode): string | undefined {
  if (node.nodeType === 9) return "$";
  const parent = node.parentNode;
  if (parent === null) return undefined;
  if (parent.nodeType === 9) return "$";
  const parentPath = documentElementPath(parent);
  return parentPath === undefined ? undefined : childNodePath(parentPath, parent, node);
}

export function guardXmlDocument(document: XmlDocument, file: string): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  let elementCount = 0;
  const visit = (node: XmlNode, path: string): void => {
    if (node.nodeType === 10 || node.nodeType === 6 || node.nodeType === 5) {
      hits.push(newHit(file, path, "xml.doctype_forbidden", "xml-privacy"));
      return;
    }
    if (node.nodeType === 7) {
      hits.push(newHit(file, path, "xml.processing_instruction_forbidden", "xml-privacy"));
      return;
    }
    if (node.parentNode?.nodeType === 9 && node.nodeType === 1) elementCount++;
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i);
      if (child === null) continue;
      const childPath =
        node.nodeType === 9 && child === document.documentElement
          ? "$"
          : child.nodeType === 1
            ? childNodePath(path, node, child)
            : anyNodePath(path, node, child);
      visit(child, childPath);
    }
  };
  visit(document, "$" as string);
  if (elementCount !== 1 || document.documentElement === null) {
    hits.push(newHit(file, "$", "xml.parse", "xml-privacy"));
  }
  return firstFailureClass(hits);
}

function directChildren(element: XmlElement, namespace: string, localName: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes.item(i);
    if (child?.nodeType === 1) {
      const candidate = child as XmlElement;
      if (candidate.namespaceURI === namespace && candidate.localName === localName)
        result.push(candidate);
    }
  }
  return result;
}

function elementsByNamespace(
  document: XmlDocument,
  namespace: string,
  names: ReadonlySet<string>,
): XmlElement[] {
  const result: XmlElement[] = [];
  const visit = (node: XmlNode): void => {
    if (node.nodeType === 1) {
      const element = node as XmlElement;
      if (element.namespaceURI === namespace && names.has(element.localName ?? ""))
        result.push(element);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i);
      if (child !== null) visit(child);
    }
  };
  visit(document);
  return result;
}

function xmlValueHit(file: string, path: string, code: keyof typeof FAILURE_DETAIL): PrivacyHit {
  return newHit(file, path, code, "xml-privacy");
}

function validateCoordinate(
  file: string,
  path: string,
  token: string,
  minimum: number,
  maximum: number,
): PrivacyHit | undefined {
  const trimmed = token.trim();
  if (!XML_NUMBER_RE.test(trimmed) || !Number.isFinite(Number(trimmed))) {
    return xmlValueHit(file, path, "xml.invalid_number");
  }
  const number = Number(trimmed);
  return number < minimum || number > maximum
    ? xmlValueHit(file, path, "xml.invalid_coordinate")
    : undefined;
}

function validateRequiredTime(file: string, path: string, value: string): PrivacyHit | undefined {
  const trimmed = value.trim();
  return !EXPLICIT_ZONE_RE.test(trimmed) || !Number.isFinite(Date.parse(trimmed))
    ? xmlValueHit(file, path, "xml.invalid_time")
    : undefined;
}

function validateXmlDom(document: XmlDocument, file: string): PrivacyHit[] {
  const root = document.documentElement;
  if (root === null) return [xmlValueHit(file, "$", "xml.parse")];
  const hits: PrivacyHit[] = [];
  const isTcx = root.namespaceURI === TCX_NAMESPACE && root.localName === "TrainingCenterDatabase";
  const isGpx = GPX_NAMESPACES.has(root.namespaceURI ?? "") && root.localName === "gpx";
  if (!isTcx && !isGpx) return [xmlValueHit(file, "$", "xml.namespace")];

  if (isGpx) {
    const versions: XmlAttr[] = [];
    for (let i = 0; i < root.attributes.length; i++) {
      const attribute = root.attributes.item(i);
      if (attribute?.localName === "version") versions.push(attribute);
    }
    const unqualified = versions.filter(
      (attribute) =>
        attribute.name === "version" &&
        (attribute.namespaceURI === null || attribute.namespaceURI === ""),
    );
    const expected = root.namespaceURI === "http://www.topografix.com/GPX/1/0" ? "1.0" : "1.1";
    if (versions.length !== 1 || unqualified.length !== 1 || unqualified[0].value !== expected) {
      hits.push(xmlValueHit(file, "$/@version", "xml.namespace"));
    }
  }

  if (isTcx) {
    for (const position of elementsByNamespace(document, TCX_NAMESPACE, new Set(["Position"]))) {
      const positionPath = documentElementPath(position) ?? "$";
      const latitudes = directChildren(position, TCX_NAMESPACE, "LatitudeDegrees");
      const longitudes = directChildren(position, TCX_NAMESPACE, "LongitudeDegrees");
      if (latitudes.length !== 1 || longitudes.length !== 1) {
        hits.push(xmlValueHit(file, positionPath, "xml.missing_required"));
        continue;
      }
      const latitudePath = documentElementPath(latitudes[0]) ?? positionPath;
      const longitudePath = documentElementPath(longitudes[0]) ?? positionPath;
      const latitudeHit = validateCoordinate(
        file,
        latitudePath,
        latitudes[0].textContent ?? "",
        SYNTHETIC_GEO_BOX.minLat,
        SYNTHETIC_GEO_BOX.maxLat,
      );
      const longitudeHit = validateCoordinate(
        file,
        longitudePath,
        longitudes[0].textContent ?? "",
        SYNTHETIC_GEO_BOX.minLon,
        SYNTHETIC_GEO_BOX.maxLon,
      );
      if (latitudeHit !== undefined) hits.push(latitudeHit);
      if (longitudeHit !== undefined) hits.push(longitudeHit);
    }
  } else {
    for (const point of elementsByNamespace(
      document,
      root.namespaceURI!,
      new Set(["trkpt", "rtept", "wpt"]),
    )) {
      const pointPath = documentElementPath(point) ?? "$";
      const lat = point.getAttributeNode("lat");
      const lon = point.getAttributeNode("lon");
      const latitudeAttributes: XmlAttr[] = [];
      const longitudeAttributes: XmlAttr[] = [];
      for (let i = 0; i < point.attributes.length; i++) {
        const attribute = point.attributes.item(i);
        if (attribute?.localName === "lat") latitudeAttributes.push(attribute);
        if (attribute?.localName === "lon") longitudeAttributes.push(attribute);
      }
      if (
        lat === null ||
        lon === null ||
        latitudeAttributes.length !== 1 ||
        longitudeAttributes.length !== 1
      ) {
        hits.push(xmlValueHit(file, pointPath, "xml.missing_required"));
        continue;
      }
      const latitudeHit = validateCoordinate(
        file,
        `${pointPath}/@lat`,
        lat.value,
        SYNTHETIC_GEO_BOX.minLat,
        SYNTHETIC_GEO_BOX.maxLat,
      );
      const longitudeHit = validateCoordinate(
        file,
        `${pointPath}/@lon`,
        lon.value,
        SYNTHETIC_GEO_BOX.minLon,
        SYNTHETIC_GEO_BOX.maxLon,
      );
      if (latitudeHit !== undefined) hits.push(latitudeHit);
      if (longitudeHit !== undefined) hits.push(longitudeHit);
    }
  }

  const visit = (node: XmlNode): void => {
    if (node.nodeType === 1) {
      const element = node as XmlElement;
      const elementPath = documentElementPath(element) ?? "$";
      for (let i = 0; i < element.attributes.length; i++) {
        const attribute = element.attributes.item(i);
        if (attribute === null) continue;
        const path = `${elementPath}/@${attribute.name}`;
        const match = DATE_HEAD_RE.exec(attribute.value.trim());
        if (match !== null && Number(match[1]) >= CURRENT_ERA_CUTOFF_YEAR) {
          hits.push(xmlValueHit(file, path, "xml.current_era_date"));
        }
        if (
          isTcx &&
          element.namespaceURI === TCX_NAMESPACE &&
          element.localName === "Lap" &&
          attribute.name === "StartTime"
        ) {
          const timeHit = validateRequiredTime(file, path, attribute.value);
          if (timeHit !== undefined) hits.push(timeHit);
        }
      }
      if (
        (isTcx && element.namespaceURI === TCX_NAMESPACE && element.localName === "Time") ||
        (isGpx && element.namespaceURI === root.namespaceURI && element.localName === "time")
      ) {
        const timeHit = validateRequiredTime(file, elementPath, element.textContent ?? "");
        if (timeHit !== undefined) hits.push(timeHit);
      }
    }
    if (node.nodeType === 3) {
      const match = DATE_HEAD_RE.exec((node.nodeValue ?? "").trim());
      if (match !== null && Number(match[1]) >= CURRENT_ERA_CUTOFF_YEAR) {
        const parentPath =
          node.parentNode === null ? "$" : (documentElementPath(node.parentNode) ?? "$");
        hits.push(xmlValueHit(file, parentPath, "xml.current_era_date"));
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i);
      if (child !== null) visit(child);
    }
  };
  visit(root);
  return sortHits(hits);
}

export function validateXmlFixtureBytes(
  bytes: Uint8Array,
  file: string,
  parser: XmlParserFunction = (text) =>
    new DOMParser({
      onError: () => {
        throw new Error("xml.parse");
      },
    }).parseFromString(text, "application/xml"),
): PrivacyHit[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [xmlValueHit(file, "$", "xml.invalid_utf8")];
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const declaration =
    /^<\?xml[ \t]+version=(["'])1\.0\1(?:[ \t]+encoding=(["'])UTF-8\2)?[ \t]*\?>/i.exec(text);
  if (declaration !== null) text = text.slice(declaration[0].length);
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    return [xmlValueHit(file, "$", "xml.doctype_forbidden")];
  }
  if (text.includes("<?")) {
    return [xmlValueHit(file, "$", "xml.processing_instruction_forbidden")];
  }
  let document: XmlDocument;
  try {
    document = parser(text);
  } catch {
    return [xmlValueHit(file, "$", "xml.parse")];
  }
  const guardHits = guardXmlDocument(document, file);
  if (guardHits.length > 0) return guardHits;
  return validateXmlDom(document, file);
}

function normalizeInventoryInputs(
  paths: readonly string[],
  rootAbsolute: string,
  rootReal: string,
): { paths: string[]; hits: PrivacyHit[] } {
  const normalized: string[] = [];
  const hits: PrivacyHit[] = [];
  for (const pathname of new Set(paths)) {
    const inspected = inspectInventoryPath(rootAbsolute, rootReal, pathname);
    if (inspected.hit !== undefined) hits.push(inspected.hit);
    else normalized.push(inspected.relative!);
  }
  return { paths: normalized.sort(scalarCompare), hits };
}

function manifestDiagnosticPath(rootAbsolute: string, manifestPath: string): string {
  const rel = relative(rootAbsolute, manifestPath).split(sep).join("/");
  return rel !== "" && !rel.startsWith("../") && !isAbsolute(rel) ? rel : COMMITTED_MANIFEST_PATH;
}

export function findBinaryFixtureHits(
  binaryInventoryFiles: readonly string[],
  activitySidecarFiles: readonly string[],
  options: BinaryPrivacyOptions,
): PrivacyHit[] {
  const rootAbsolute = resolve(options.rootDir);
  const manifestPath =
    options.manifestPath === undefined
      ? resolve(rootAbsolute, COMMITTED_MANIFEST_PATH)
      : isAbsolute(options.manifestPath)
        ? options.manifestPath
        : resolve(rootAbsolute, options.manifestPath);
  const manifestFile = manifestDiagnosticPath(rootAbsolute, manifestPath);
  const parsed = readArtifact(manifestPath, manifestFile);
  if (parsed.hits.length > 0) return parsed.hits;
  const schema = validateManifestSchema(parsed.artifact!);
  if (schema.hits.length > 0) return schema.hits;
  const manifest = schema.manifest!;

  const collectionHits = validateEntryCollections(manifest.files, manifestFile);
  if (collectionHits.length > 0) return firstFailureClass(collectionHits);

  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbsolute);
  } catch {
    return [newHit("$", "$", "artifact.unsafe_path")];
  }
  const fixtureInventory = normalizeInventoryInputs(binaryInventoryFiles, rootAbsolute, rootReal);
  const sidecarInventory = normalizeInventoryInputs(activitySidecarFiles, rootAbsolute, rootReal);
  const containmentHits = [...fixtureInventory.hits, ...sidecarInventory.hits];
  if (containmentHits.length > 0) return firstFailureClass(containmentHits);

  const manifestPaths = new Set(manifest.files.map((entry) => entry.path));
  const inventoryPaths = new Set(fixtureInventory.paths);
  const inventoryHits: PrivacyHit[] = [];
  for (const fixture of fixtureInventory.paths) {
    if (!manifestPaths.has(fixture))
      inventoryHits.push(newHit(fixture, "$", "binary.unmanifested"));
  }
  for (let i = 0; i < manifest.files.length; i++) {
    if (!inventoryPaths.has(manifest.files[i].path)) {
      inventoryHits.push(
        newHit(manifest.files[i].path, `$.files[${i}].path`, "binary.manifest_missing_file"),
      );
    }
  }
  if (inventoryHits.length > 0) return firstFailureClass(inventoryHits);

  if (manifest.policy_sha256 !== currentPolicyHash()) {
    return [newHit(manifestFile, "$.policy_sha256", "artifact.policy_hash")];
  }

  const integrityHits: PrivacyHit[] = [];
  const fixtureSet = new Set(fixtureInventory.paths);
  const sidecarSet = new Set(sidecarInventory.paths);
  for (const sidecar of sidecarInventory.paths) {
    const fixture = sidecar.replace(/\.sha256$/i, "");
    if (!fixtureSet.has(fixture) || sidecar !== `${fixture}.sha256`) {
      integrityHits.push(newHit(sidecar, "$", "binary.sidecar_orphan"));
    }
  }
  const xmlEntries: { entry: ManifestEntry; bytes: Buffer }[] = [];
  for (let i = 0; i < manifest.files.length; i++) {
    const entry = manifest.files[i];
    const fixturePath = resolve(rootAbsolute, entry.path);
    const bytes = readFileSync(fixturePath);
    const digest = sha256(bytes);
    if (bytes.length !== entry.bytes) {
      integrityHits.push(newHit(entry.path, `$.files[${i}].bytes`, "binary.byte_count"));
    }
    if (digest !== entry.sha256) {
      integrityHits.push(newHit(entry.path, `$.files[${i}].sha256`, "binary.hash"));
    }
    const sidecarPath = `${entry.path}.sha256`;
    if (!sidecarSet.has(sidecarPath)) {
      integrityHits.push(newHit(sidecarPath, "$", "binary.sidecar_missing"));
    } else {
      let sidecarBytes: Buffer;
      try {
        sidecarBytes = readFileSync(resolve(rootAbsolute, sidecarPath));
      } catch {
        integrityHits.push(newHit(sidecarPath, "$", "binary.sidecar_missing"));
        continue;
      }
      const expected = `${digest}  ${basename(entry.path)}\n`;
      if (!/^[0-9a-f]{64}  [A-Za-z0-9._-]+\n$/.test(sidecarBytes.toString("latin1"))) {
        integrityHits.push(newHit(sidecarPath, "$", "binary.sidecar_format"));
      } else if (sidecarBytes.toString("utf8") !== expected || digest !== entry.sha256) {
        integrityHits.push(newHit(sidecarPath, "$", "binary.sidecar_mismatch"));
      }
    }
    if (entry.kind === "tcx" || entry.kind === "gpx") xmlEntries.push({ entry, bytes });
  }
  if (integrityHits.length > 0) return firstFailureClass(integrityHits);

  const xmlHits = xmlEntries.flatMap(({ entry, bytes }) =>
    validateXmlFixtureBytes(bytes, entry.path),
  );
  return firstFailureClass(xmlHits);
}

export function findFixturePrivacyHits(
  inputs: FixturePrivacyInputs,
  options: BinaryPrivacyOptions,
): PrivacyHit[] {
  const hits = [
    ...findBinaryFixtureHits(inputs.binaryInventoryFiles, inputs.activitySidecarFiles, options),
    ...findIdHits(inputs.legacySourceFiles),
    ...findDateHits(inputs.legacyGoldenFiles),
  ];
  return firstFailureClass(hits);
}

interface Fragment {
  readonly schema_version: 1;
  readonly policy_sha256: string;
  readonly files: readonly ManifestEntry[];
}

function validateFragmentSchema(artifact: ParsedArtifact): {
  fragment?: Fragment;
  hits: PrivacyHit[];
} {
  const value = artifact.value;
  const node = artifact.ordered;
  if (!exactKeys(value, node, ["schema_version", "policy_sha256", "files"])) {
    return { hits: [newHit(artifact.file, "$", "artifact.schema")] };
  }
  const nodes = arrayNodes(childNode(node, "files"));
  if (
    value.schema_version !== 1 ||
    !isDigest(value.policy_sha256) ||
    !Array.isArray(value.files) ||
    nodes === undefined ||
    value.files.length !== 8 ||
    !value.files.every((entry, i) => validateManifestEntry(entry, nodes[i]))
  )
    return { hits: [newHit(artifact.file, "$", "artifact.schema")] };
  const files = value.files as unknown as ManifestEntry[];
  const serials = files.map((entry) => entry.serial);
  const qa = files.map((entry) => entry.qa_cell);
  if (
    files.some((entry) => entry.kind !== "fit") ||
    new Set(serials).size !== 8 ||
    new Set(qa).size !== 8 ||
    !Array.from({ length: 8 }, (_, i) => SYNTHETIC_FILE_ID_SERIAL_MIN + i).every((serial) =>
      serials.includes(serial),
    ) ||
    !FIT_QA_CELLS.every((cell) => qa.includes(cell))
  )
    return { hits: [newHit(artifact.file, "$.files", "artifact.schema")] };
  return { fragment: value as unknown as Fragment, hits: [] };
}

interface ReadyEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly serial: number;
  readonly qa_cell: string;
  readonly source_kind: "synthetic_from_scratch";
  readonly producer_recipe_sha256: string;
  readonly evidence: unknown;
  readonly evidence_binding_sha256: string;
  readonly validation: Record<string, unknown>;
  readonly drops: Record<string, unknown>;
}

interface ReadyArtifact {
  readonly schema_version: 1;
  readonly producer_recipe_version: "w2-fit-producer-v1";
  readonly policy_sha256: string;
  readonly encoder: Record<string, unknown>;
  readonly policy: Record<string, unknown>;
  readonly operator_attestation: Record<string, unknown>;
  readonly files: readonly ReadyEntry[];
}

const EVIDENCE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "triathlon-multisport": [
    "kind",
    "session_count",
    "session_tuples",
    "session_trigger_raw",
    "session_trigger_sdk",
    "session_start_raw",
    "session_end_raw",
    "transition_indexes",
    "shared_boundary_pairs",
    "markers",
    "terminal_activity",
    "assignment_ranges",
    "per_index_counts",
    "record_count",
    "unassigned_records",
    "ambiguous_records",
    "corrected_rerun_verdict",
  ],
  "duathlon-run-bike-run": [
    "kind",
    "session_count",
    "session_tuples",
    "session_start_raw",
    "session_end_raw",
    "repeated_running_indexes",
    "per_index_counts",
    "record_count",
  ],
  "brick-cycling": [
    "kind",
    "role",
    "counterpart_path",
    "counterpart_sha256",
    "sport",
    "start_raw",
    "end_raw",
    "counterpart_start_raw",
    "gap_s",
  ],
  "brick-running": [
    "kind",
    "role",
    "counterpart_path",
    "counterpart_sha256",
    "sport",
    "start_raw",
    "end_raw",
    "counterpart_end_raw",
    "gap_s",
  ],
  "multisport-missing-generic-transition": [
    "kind",
    "session_count",
    "session_tuples",
    "session_start_raw",
    "session_end_raw",
    "generic_transition_indexes",
    "missing_transition_boundaries",
    "non_transition_session_indexes",
  ],
  "pool-swim-drill-lengths": [
    "kind",
    "session_count",
    "pool_length_m",
    "length_count",
    "active_length_count",
    "drill_length_index",
    "drill_raw_swim_stroke",
    "drill_length_type",
    "source_session_distance_m",
  ],
  "pool-size-correction": [
    "kind",
    "session_count",
    "length_count",
    "active_length_count",
    "source_session_distance_m",
    "original_pool_length_m",
    "proposed_correction_m",
    "expected_multiplier",
    "expected_active_length_distances_m",
    "expected_corrected_session_distance_m",
  ],
  "dual-developer-index": [
    "kind",
    "developer_data_ids",
    "field_descriptions",
    "duplicate_names",
    "native_message_types",
    "identity_slots",
    "identity_slots_by_family",
    "duplicate_name",
    "duplicate_values",
  ],
});

function validateEvidenceShape(value: unknown, node: OrderedJson, qaCell: string): boolean {
  const keys = EVIDENCE_KEYS[qaCell];
  if (keys === undefined || !exactKeys(value, node, keys)) return false;
  const placeholderDigest = "0".repeat(64);
  const placeholders = FIT_QA_CELLS.map((cell) => ({
    qa_cell: cell,
    sha256: placeholderDigest,
  })) as ReadyEntry[];
  const template = expectedEvidence(qaCell, placeholders);
  const matchesShape = (
    candidate: unknown,
    candidateNode: OrderedJson,
    expected: unknown,
  ): boolean => {
    if (expected === null) return candidate === null && candidateNode.kind === "null";
    if (Array.isArray(expected)) {
      const nodes = arrayNodes(candidateNode);
      return (
        Array.isArray(candidate) &&
        nodes !== undefined &&
        candidate.length === expected.length &&
        candidate.every((item, i) => matchesShape(item, nodes[i], expected[i]))
      );
    }
    const expectedObject = objectValue(expected);
    if (expectedObject !== undefined) {
      const expectedKeys = Object.keys(expectedObject);
      if (!exactKeys(candidate, candidateNode, expectedKeys)) return false;
      return expectedKeys.every((key) =>
        matchesShape(candidate[key], childNode(candidateNode, key)!, expectedObject[key]),
      );
    }
    if (typeof expected === "number")
      return isFiniteNumber(candidate) && candidateNode.kind === "number";
    return typeof candidate === typeof expected;
  };
  return template !== undefined && matchesShape(value, node, template);
}

const VALIDATION_KEYS = [
  "sdk_decode_errors",
  "sdk_redecode_errors",
  "two_fresh_encodes_equal",
  "lossless_scope",
  "fit_file_parser_records",
  "fit_file_parser_sessions",
  "geo_box",
  "geo_max_cumulative_divergence_ratio",
  "minimum_raw_date_time",
  "date_floor_and_roundtrip",
  "field_lifecycle",
  "exotic_family_parity",
  "record_assignment_exactly_once",
  "u10_exactly_once",
] as const;

function validateValidationShape(value: unknown, node: OrderedJson): boolean {
  if (!exactKeys(value, node, VALIDATION_KEYS)) return false;
  return (
    isNonnegativeSafeInteger(value.sdk_decode_errors) &&
    isNonnegativeSafeInteger(value.sdk_redecode_errors) &&
    typeof value.two_fresh_encodes_equal === "boolean" &&
    typeof value.lossless_scope === "boolean" &&
    isNonnegativeSafeInteger(value.fit_file_parser_records) &&
    isNonnegativeSafeInteger(value.fit_file_parser_sessions) &&
    typeof value.geo_box === "boolean" &&
    isFiniteNumber(value.geo_max_cumulative_divergence_ratio) &&
    isNonnegativeSafeInteger(value.minimum_raw_date_time) &&
    typeof value.date_floor_and_roundtrip === "boolean" &&
    typeof value.field_lifecycle === "boolean" &&
    typeof value.exotic_family_parity === "boolean" &&
    typeof value.record_assignment_exactly_once === "boolean" &&
    (typeof value.u10_exactly_once === "boolean" || value.u10_exactly_once === null)
  );
}

function validateLossArrayShape(
  value: unknown,
  node: OrderedJson | undefined,
  keys: readonly string[],
): boolean {
  if (!Array.isArray(value)) return false;
  const nodes = arrayNodes(node);
  if (nodes === undefined || nodes.length !== value.length) return false;
  return value.every((entry, i) => {
    if (!exactKeys(entry, nodes[i], keys)) return false;
    return keys.every((key) => {
      const member = entry[key];
      return key === "count"
        ? isPositiveSafeInteger(member)
        : typeof member === "string" && member.length > 0;
    });
  });
}

function validateDropsShape(value: unknown, node: OrderedJson): boolean {
  if (
    !exactKeys(value, node, [
      "zero_enumerable_messages",
      "non_finite_numeric_values",
      "user_profile_messages",
    ])
  )
    return false;
  return (
    validateLossArrayShape(
      value.zero_enumerable_messages,
      childNode(node, "zero_enumerable_messages"),
      ["message_type", "count"],
    ) &&
    validateLossArrayShape(
      value.non_finite_numeric_values,
      childNode(node, "non_finite_numeric_values"),
      ["message_type", "field", "count"],
    ) &&
    isNonnegativeSafeInteger(value.user_profile_messages)
  );
}

function validateReadyEntryShape(value: unknown, node: OrderedJson): value is ReadyEntry {
  if (
    !exactKeys(value, node, [
      "path",
      "sha256",
      "bytes",
      "serial",
      "qa_cell",
      "source_kind",
      "producer_recipe_sha256",
      "evidence",
      "evidence_binding_sha256",
      "validation",
      "drops",
    ])
  )
    return false;
  if (
    typeof value.path !== "string" ||
    extname(value.path).toLowerCase() !== ".fit" ||
    !isDigest(value.sha256) ||
    !isPositiveSafeInteger(value.bytes) ||
    !Number.isSafeInteger(value.serial) ||
    (value.serial as number) < SYNTHETIC_FILE_ID_SERIAL_MIN ||
    (value.serial as number) > SYNTHETIC_FILE_ID_SERIAL_MAX ||
    !FIT_QA_CELLS.includes(value.qa_cell as (typeof FIT_QA_CELLS)[number]) ||
    value.source_kind !== "synthetic_from_scratch" ||
    !isDigest(value.producer_recipe_sha256) ||
    !isDigest(value.evidence_binding_sha256)
  )
    return false;
  const evidenceNode = childNode(node, "evidence");
  const validationNode = childNode(node, "validation");
  const dropsNode = childNode(node, "drops");
  return (
    evidenceNode !== undefined &&
    validationNode !== undefined &&
    dropsNode !== undefined &&
    validateEvidenceShape(value.evidence, evidenceNode, value.qa_cell as string) &&
    validateValidationShape(value.validation, validationNode) &&
    validateDropsShape(value.drops, dropsNode)
  );
}

function validateAttestedFileShape(value: unknown, node: OrderedJson): boolean {
  return (
    exactKeys(value, node, [
      "path",
      "sha256",
      "source_kind",
      "producer_recipe_sha256",
      "evidence_binding_sha256",
    ]) &&
    typeof value.path === "string" &&
    isDigest(value.sha256) &&
    value.source_kind === "synthetic_from_scratch" &&
    isDigest(value.producer_recipe_sha256) &&
    isDigest(value.evidence_binding_sha256)
  );
}

function validateReadySchema(artifact: ParsedArtifact): {
  ready?: ReadyArtifact;
  hits: PrivacyHit[];
} {
  const value = artifact.value;
  const node = artifact.ordered;
  if (
    !exactKeys(value, node, [
      "schema_version",
      "producer_recipe_version",
      "policy_sha256",
      "encoder",
      "policy",
      "operator_attestation",
      "files",
    ])
  ) {
    return { hits: [newHit(artifact.file, "$", "artifact.schema")] };
  }
  const encoderNode = childNode(node, "encoder")!;
  const policyNode = childNode(node, "policy")!;
  const attestationNode = childNode(node, "operator_attestation")!;
  if (
    value.schema_version !== 1 ||
    value.producer_recipe_version !== "w2-fit-producer-v1" ||
    !isDigest(value.policy_sha256) ||
    !exactKeys(value.encoder, encoderNode, ["package", "version", "coordinate"]) ||
    value.encoder.package !== LOCAL_ENCODER_PACKAGE ||
    value.encoder.version !== LOCAL_ENCODER_VERSION ||
    typeof value.encoder.coordinate !== "string" ||
    !exactKeys(value.policy, policyNode, [
      "geo_algorithm",
      "earth_radius_m",
      "center",
      "box",
      "laps",
      "quantization",
      "max_cumulative_divergence_ratio",
      "fit_date_time_floor_raw",
      "fit_date_time_floor_iso",
      "serial_min",
      "serial_max",
    ]) ||
    typeof value.policy.geo_algorithm !== "string" ||
    !isFiniteNumber(value.policy.earth_radius_m) ||
    !exactKeys(value.policy.center, childNode(policyNode, "center")!, ["lat", "lon"]) ||
    !isFiniteNumber(value.policy.center.lat) ||
    !isFiniteNumber(value.policy.center.lon) ||
    !exactKeys(value.policy.box, childNode(policyNode, "box")!, [
      "minLat",
      "maxLat",
      "minLon",
      "maxLon",
    ]) ||
    !Object.values(value.policy.box).every(isFiniteNumber) ||
    !isNonnegativeSafeInteger(value.policy.laps) ||
    typeof value.policy.quantization !== "string" ||
    !isFiniteNumber(value.policy.max_cumulative_divergence_ratio) ||
    !isNonnegativeSafeInteger(value.policy.fit_date_time_floor_raw) ||
    typeof value.policy.fit_date_time_floor_iso !== "string" ||
    !isNonnegativeSafeInteger(value.policy.serial_min) ||
    !isNonnegativeSafeInteger(value.policy.serial_max) ||
    !exactKeys(value.operator_attestation, attestationNode, [
      "attestation_version",
      "attestor_role",
      "statement",
      "source_kind",
      "producer_recipe_sha256",
      "files",
      "attestation_sha256",
    ]) ||
    value.operator_attestation.attestation_version !== 1 ||
    value.operator_attestation.attestor_role !== "capable_operator" ||
    value.operator_attestation.statement !==
      "Every listed FIT fixture was synthesized from scratch without using an athlete recording as input." ||
    value.operator_attestation.source_kind !== "synthetic_from_scratch" ||
    !isDigest(value.operator_attestation.producer_recipe_sha256) ||
    !isDigest(value.operator_attestation.attestation_sha256)
  )
    return { hits: [newHit(artifact.file, "$", "artifact.schema")] };
  const attested = value.operator_attestation.files;
  const attestedNodes = arrayNodes(childNode(attestationNode, "files"));
  const files = value.files;
  const fileNodes = arrayNodes(childNode(node, "files"));
  if (
    !Array.isArray(attested) ||
    attestedNodes === undefined ||
    attested.length !== 8 ||
    !attested.every((entry, i) => validateAttestedFileShape(entry, attestedNodes[i])) ||
    !Array.isArray(files) ||
    fileNodes === undefined ||
    files.length !== 8 ||
    !files.every((entry, i) => validateReadyEntryShape(entry, fileNodes[i]))
  )
    return { hits: [newHit(artifact.file, "$", "artifact.schema")] };
  const ready = value as unknown as ReadyArtifact;
  const serials = ready.files.map((entry) => entry.serial);
  const qa = ready.files.map((entry) => entry.qa_cell);
  if (
    new Set(serials).size !== 8 ||
    new Set(qa).size !== 8 ||
    !Array.from({ length: 8 }, (_, i) => SYNTHETIC_FILE_ID_SERIAL_MIN + i).every((serial) =>
      serials.includes(serial),
    ) ||
    !FIT_QA_CELLS.every((cell) => qa.includes(cell))
  )
    return { hits: [newHit(artifact.file, "$.files", "artifact.schema")] };
  return { ready, hits: [] };
}

function expectedEvidence(qaCell: string, ready: readonly ReadyEntry[]): unknown {
  const byQa = new Map(ready.map((entry) => [entry.qa_cell, entry]));
  switch (qaCell) {
    case "triathlon-multisport":
      return {
        kind: "triathlon_multisport",
        session_count: 5,
        session_tuples: [
          ["swimming", "open_water"],
          ["transition", "generic"],
          ["cycling", "generic"],
          ["transition", "generic"],
          ["running", "generic"],
        ],
        session_trigger_raw: [2, 2, 2, 2, 0],
        session_trigger_sdk: [
          "autoMultiSport",
          "autoMultiSport",
          "autoMultiSport",
          "autoMultiSport",
          "activityEnd",
        ],
        session_start_raw: [268500000, 268500003, 268500005, 268500009, 268500011],
        session_end_raw: [268500003, 268500005, 268500009, 268500011, 268500014],
        transition_indexes: [1, 3],
        shared_boundary_pairs: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4],
        ],
        markers: [
          {
            event: 38,
            event_type: "marker",
            data: 271,
            timestamp_raw: 268500002,
            role: "before_session_0_closing_lap_and_session",
          },
          {
            event: 38,
            event_type: "marker",
            data: 0,
            timestamp_raw: 268500013,
            role: "before_session_4_closing_lap_session_and_activity",
          },
        ],
        terminal_activity: {
          type: "auto_multi_sport",
          num_sessions: 5,
          event: "activity",
          event_type: "stop",
        },
        assignment_ranges: [
          "[start,end)",
          "[start,end)",
          "[start,end)",
          "[start,end)",
          "[start,end]",
        ],
        per_index_counts: [3, 2, 4, 2, 3],
        record_count: 14,
        unassigned_records: 0,
        ambiguous_records: 0,
        corrected_rerun_verdict: "KEEP",
      };
    case "duathlon-run-bike-run":
      return {
        kind: "duathlon_run_bike_run",
        session_count: 3,
        session_tuples: [
          ["running", "generic"],
          ["cycling", "generic"],
          ["running", "generic"],
        ],
        session_start_raw: [268510000, 268510003, 268510007],
        session_end_raw: [268510003, 268510007, 268510010],
        repeated_running_indexes: [0, 2],
        per_index_counts: [3, 4, 3],
        record_count: 10,
      };
    case "brick-cycling":
      return {
        kind: "brick_member",
        role: "earlier",
        counterpart_path: `${INGEST_PREFIX}brick-running.fit`,
        counterpart_sha256: byQa.get("brick-running")?.sha256,
        sport: "cycling",
        start_raw: 268520000,
        end_raw: 268522400,
        counterpart_start_raw: 268523300,
        gap_s: 900,
      };
    case "brick-running":
      return {
        kind: "brick_member",
        role: "later",
        counterpart_path: `${INGEST_PREFIX}brick-cycling.fit`,
        counterpart_sha256: byQa.get("brick-cycling")?.sha256,
        sport: "running",
        start_raw: 268523300,
        end_raw: 268525100,
        counterpart_end_raw: 268522400,
        gap_s: 900,
      };
    case "multisport-missing-generic-transition":
      return {
        kind: "missing_generic_transition",
        session_count: 4,
        session_tuples: [
          ["running", "generic"],
          ["transition", "generic"],
          ["cycling", "generic"],
          ["running", "generic"],
        ],
        session_start_raw: [268530000, 268530003, 268530005, 268530009],
        session_end_raw: [268530003, 268530005, 268530009, 268530012],
        generic_transition_indexes: [1],
        missing_transition_boundaries: [{ from_index: 2, to_index: 3 }],
        non_transition_session_indexes: [0, 2, 3],
      };
    case "pool-swim-drill-lengths":
      return {
        kind: "pool_swim_drill",
        session_count: 1,
        pool_length_m: 25,
        length_count: 4,
        active_length_count: 4,
        drill_length_index: 2,
        drill_raw_swim_stroke: 4,
        drill_length_type: "active",
        source_session_distance_m: 100,
      };
    case "pool-size-correction":
      return {
        kind: "pool_size_correction_ready",
        session_count: 1,
        length_count: 4,
        active_length_count: 4,
        source_session_distance_m: 100,
        original_pool_length_m: 25,
        proposed_correction_m: 50,
        expected_multiplier: 2,
        expected_active_length_distances_m: [50, 50, 50, 50],
        expected_corrected_session_distance_m: 200,
      };
    case "dual-developer-index":
      return {
        kind: "dual_developer_index",
        developer_data_ids: 2,
        field_descriptions: 28,
        duplicate_names: 14,
        native_message_types: [18, 19, 20],
        identity_slots: 178,
        identity_slots_by_family: { session: 12, lap: 6, record: 160 },
        duplicate_name: "currHemoPerc",
        duplicate_values: [
          { developer_data_index: 0, value: 62.099998474121094 },
          { developer_data_index: 1, value: 65.5999984741211 },
        ],
      };
    default:
      return undefined;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePolicySnapshot(ready: ReadyArtifact, file: string): PrivacyHit[] {
  const expected = {
    geo_algorithm: SYNTHETIC_GEO_ALGORITHM,
    earth_radius_m: SYNTHETIC_GEO_EARTH_RADIUS_M,
    center: { lat: SYNTHETIC_GEO_CENTER.lat, lon: SYNTHETIC_GEO_CENTER.lon },
    box: {
      minLat: SYNTHETIC_GEO_BOX.minLat,
      maxLat: SYNTHETIC_GEO_BOX.maxLat,
      minLon: SYNTHETIC_GEO_BOX.minLon,
      maxLon: SYNTHETIC_GEO_BOX.maxLon,
    },
    laps: SYNTHETIC_GEO_LAPS,
    quantization: SYNTHETIC_GEO_QUANTIZATION,
    max_cumulative_divergence_ratio: SYNTHETIC_GEO_MAX_CUMULATIVE_DIVERGENCE_RATIO,
    fit_date_time_floor_raw: FIT_DATE_TIME_FLOOR_RAW,
    fit_date_time_floor_iso: FIT_DATE_TIME_FLOOR_ISO,
    serial_min: SYNTHETIC_FILE_ID_SERIAL_MIN,
    serial_max: SYNTHETIC_FILE_ID_SERIAL_MAX,
  };
  return sameJson(ready.policy, expected)
    ? []
    : [newHit(file, "$.policy", "artifact.policy_snapshot")];
}

function validateEncoder(ready: ReadyArtifact, file: string, rootDir: string): PrivacyHit[] {
  const coordinate = ready.encoder.coordinate;
  try {
    const url = new URL(coordinate as string);
    if (
      url.protocol !== "file:" ||
      url.hostname !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new Error("url");
    const path = fileURLToPath(url);
    if (!isAbsolute(path)) throw new Error("relative");
    const real = realpathSync(path);
    const repoReal = realpathSync(rootDir);
    if (real === repoReal || real.startsWith(`${repoReal}${sep}`)) throw new Error("inside");
    if (!statSync(real).isFile()) throw new Error("not file");
    accessSync(real, constants.R_OK);
    const segments = real.split(sep).filter(Boolean);
    if (segments.slice(-4).join("/") !== "node_modules/@garmin/fitsdk/package.json")
      throw new Error("suffix");
    const bytes = readFileSync(real);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const packageJson = objectValue(JSON.parse(text) as unknown);
    if (
      packageJson?.name !== LOCAL_ENCODER_PACKAGE ||
      packageJson.version !== LOCAL_ENCODER_VERSION
    )
      throw new Error("package");
    return [];
  } catch {
    return [newHit(file, "$.encoder.coordinate", "artifact.encoder_coordinate")];
  }
}

function tupleCompare(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const comparison = scalarCompare(a[i], b[i]);
    if (comparison !== 0) return comparison;
  }
  return a.length - b.length;
}

function validateReadySemantics(ready: ReadyArtifact, file: string): PrivacyHit[] {
  const hits: PrivacyHit[] = [];
  const recipe = ready.operator_attestation.producer_recipe_sha256;
  const attestedFiles = ready.operator_attestation.files as Record<string, unknown>[];
  for (let i = 0; i < ready.files.length; i++) {
    const entry = ready.files[i];
    const prefix = `$.files[${i}]`;
    if (entry.producer_recipe_sha256 !== recipe)
      hits.push(newHit(file, `${prefix}.producer_recipe_sha256`, "artifact.provenance"));
    if (!sameJson(entry.evidence, expectedEvidence(entry.qa_cell, ready.files))) {
      hits.push(newHit(file, `${prefix}.evidence`, "artifact.evidence"));
    }
    const expectedBinding = sha256(
      `${JSON.stringify({ fixture_sha256: entry.sha256, qa_cell: entry.qa_cell, evidence: entry.evidence }, null, 2)}\n`,
    );
    if (entry.evidence_binding_sha256 !== expectedBinding) {
      hits.push(newHit(file, `${prefix}.evidence_binding_sha256`, "artifact.evidence_binding"));
    }
    const validation = entry.validation;
    const validValidation =
      validation.sdk_decode_errors === 0 &&
      validation.sdk_redecode_errors === 0 &&
      validation.two_fresh_encodes_equal === true &&
      validation.lossless_scope === true &&
      isPositiveSafeInteger(validation.fit_file_parser_records) &&
      isPositiveSafeInteger(validation.fit_file_parser_sessions) &&
      validation.geo_box === true &&
      isFiniteNumber(validation.geo_max_cumulative_divergence_ratio) &&
      validation.geo_max_cumulative_divergence_ratio >= 0 &&
      validation.geo_max_cumulative_divergence_ratio <=
        SYNTHETIC_GEO_MAX_CUMULATIVE_DIVERGENCE_RATIO &&
      isNonnegativeSafeInteger(validation.minimum_raw_date_time) &&
      validation.minimum_raw_date_time >= FIT_DATE_TIME_FLOOR_RAW &&
      validation.minimum_raw_date_time <= 0xffffffff &&
      validation.date_floor_and_roundtrip === true &&
      validation.field_lifecycle === true &&
      validation.exotic_family_parity === true &&
      validation.record_assignment_exactly_once === true &&
      (entry.qa_cell === "triathlon-multisport"
        ? validation.u10_exactly_once === true
        : validation.u10_exactly_once === null);
    const zeroes = entry.drops.zero_enumerable_messages as Record<string, unknown>[];
    const nonfinite = entry.drops.non_finite_numeric_values as Record<string, unknown>[];
    const lossStringsValid = [...zeroes, ...nonfinite].every((loss) =>
      Object.entries(loss).every(
        ([key, value]) =>
          key === "count" ||
          (typeof value === "string" && value.trim() === value && value.length > 0),
      ),
    );
    const zeroTuples = zeroes.map((loss) => [loss.message_type as string]);
    const finiteTuples = nonfinite.map((loss) => [
      loss.message_type as string,
      loss.field as string,
    ]);
    const lossOrderValid =
      zeroTuples.every(
        (tuple, index) => index === 0 || tupleCompare(zeroTuples[index - 1], tuple) < 0,
      ) &&
      finiteTuples.every(
        (tuple, index) => index === 0 || tupleCompare(finiteTuples[index - 1], tuple) < 0,
      );
    if (!validValidation || !lossStringsValid || !lossOrderValid) {
      hits.push(newHit(file, `${prefix}.validation`, "artifact.validation"));
    }
    const attested = attestedFiles[i];
    if (
      attested === undefined ||
      attested.path !== entry.path ||
      attested.sha256 !== entry.sha256 ||
      attested.source_kind !== entry.source_kind ||
      attested.producer_recipe_sha256 !== entry.producer_recipe_sha256 ||
      attested.evidence_binding_sha256 !== entry.evidence_binding_sha256
    )
      hits.push(newHit(file, `$.operator_attestation.files[${i}]`, "artifact.attestation"));
  }
  const attestation = ready.operator_attestation;
  const withoutHash = {
    attestation_version: attestation.attestation_version,
    attestor_role: attestation.attestor_role,
    statement: attestation.statement,
    source_kind: attestation.source_kind,
    producer_recipe_sha256: attestation.producer_recipe_sha256,
    files: attestation.files,
  };
  const expectedAttestationHash = sha256(`${JSON.stringify(withoutHash, null, 2)}\n`);
  if (attestation.attestation_sha256 !== expectedAttestationHash) {
    hits.push(newHit(file, "$.operator_attestation.attestation_sha256", "artifact.attestation"));
  }
  return hits;
}

function finalCanonicalHit(artifact: ParsedArtifact): PrivacyHit[] {
  const expected = `${JSON.stringify(artifact.value, null, 2)}\n`;
  return expected === artifact.text ? [] : [newHit(artifact.file, "$", "artifact.noncanonical")];
}

function manifestEntryFromReady(entry: ReadyEntry): ManifestEntry {
  return {
    path: entry.path,
    sha256: entry.sha256,
    bytes: entry.bytes,
    kind: "fit",
    serial: entry.serial,
    qa_cell: entry.qa_cell,
  };
}

function collectBundleInventory(bundlePath: string): { paths: string[]; hits: PrivacyHit[] } {
  const paths: string[] = [];
  const hits: PrivacyHit[] = [];
  const walk = (absolute: string, relativePath: string): void => {
    let lstat;
    try {
      lstat = lstatSync(absolute);
    } catch {
      hits.push(newHit(relativePath || "$", "$", "artifact.inventory"));
      return;
    }
    if (lstat.isSymbolicLink()) {
      hits.push(newHit(relativePath || "$", "$", "artifact.inventory"));
      return;
    }
    if (lstat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort(scalarCompare)) {
        walk(resolve(absolute, entry), relativePath === "" ? entry : `${relativePath}/${entry}`);
      }
      return;
    }
    try {
      accessSync(absolute, constants.R_OK);
      if (!lstat.isFile()) throw new Error("not file");
      paths.push(relativePath);
    } catch {
      hits.push(newHit(relativePath || "$", "$", "artifact.inventory"));
    }
  };
  walk(bundlePath, "");
  return { paths: paths.sort(scalarCompare), hits };
}

function sameManifestEntry(a: ManifestEntry, b: ManifestEntry): boolean {
  return sameJson(a, b);
}

export function findStagedBundleHits(stagedBundle: string, rootDir: string): PrivacyHit[] {
  const rootAbsolute = resolve(rootDir);
  const bundleAbsolute = resolve(rootAbsolute, stagedBundle);
  const readyPath = resolve(bundleAbsolute, "READY.json");
  const fragmentPath = resolve(bundleAbsolute, "manifest-fragment.json");
  const manifestPath = resolve(rootAbsolute, COMMITTED_MANIFEST_PATH);
  const readyRead = readArtifact(readyPath, `${stagedBundle}/READY.json`);
  const fragmentRead = readArtifact(fragmentPath, `${stagedBundle}/manifest-fragment.json`);
  const manifestRead = readArtifact(manifestPath, COMMITTED_MANIFEST_PATH);
  const classOne = [...readyRead.hits, ...fragmentRead.hits, ...manifestRead.hits];
  if (classOne.length > 0) return firstFailureClass(classOne);

  const readySchema = validateReadySchema(readyRead.artifact!);
  const fragmentSchema = validateFragmentSchema(fragmentRead.artifact!);
  const manifestSchema = validateManifestSchema(manifestRead.artifact!);
  const classTwo = [...readySchema.hits, ...fragmentSchema.hits, ...manifestSchema.hits];
  if (classTwo.length > 0) return firstFailureClass(classTwo);
  const canonicalInvariant = [
    ...finalCanonicalHit(readyRead.artifact!),
    ...finalCanonicalHit(fragmentRead.artifact!),
    ...finalCanonicalHit(manifestRead.artifact!),
  ];
  if (canonicalInvariant.length > 0) return firstFailureClass(canonicalInvariant);
  const ready = readySchema.ready!;
  const fragment = fragmentSchema.fragment!;
  const manifest = manifestSchema.manifest!;

  const readyEntries = ready.files.map(manifestEntryFromReady);
  const attested = ready.operator_attestation.files as Record<string, unknown>[];
  const classThree = [
    ...validateEntryCollections(fragment.files, fragmentRead.artifact!.file),
    ...validateEntryCollections(readyEntries, readyRead.artifact!.file),
    ...validateEntryCollections(
      attested.map((entry, index) => ({
        path: entry.path as string,
        sha256: entry.sha256 as string,
        bytes: 1,
        kind: "fit" as const,
        serial: SYNTHETIC_FILE_ID_SERIAL_MIN + index,
        qa_cell: FIT_QA_CELLS[index],
      })),
      readyRead.artifact!.file,
    ),
    ...validateEntryCollections(manifest.files, manifestRead.artifact!.file),
  ];
  for (let i = 1; i < attested.length; i++) {
    if (scalarCompare(attested[i - 1].path as string, attested[i].path as string) >= 0) {
      classThree.push(
        newHit(readyRead.artifact!.file, "$.operator_attestation.files", "artifact.unsorted"),
      );
    }
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbsolute);
    const bundleReal = realpathSync(bundleAbsolute);
    if (
      bundleReal === rootReal ||
      !bundleReal.startsWith(`${rootReal}${sep}`) ||
      !statSync(bundleReal).isDirectory()
    ) {
      throw new Error("outside");
    }
  } catch {
    classThree.push(newHit(stagedBundle, "$", "artifact.unsafe_path"));
  }
  if (classThree.length > 0) return firstFailureClass(classThree);

  const inventory = collectBundleInventory(bundleAbsolute);
  const expectedInventory = ["READY.json", "manifest-fragment.json"];
  for (const entry of ready.files) {
    expectedInventory.push(`files/${entry.path}`, `files/${entry.path}.sha256`);
  }
  expectedInventory.sort(scalarCompare);
  if (inventory.hits.length > 0 || !sameJson(inventory.paths, expectedInventory)) {
    return firstFailureClass([...inventory.hits, newHit(stagedBundle, "$", "artifact.inventory")]);
  }

  const policyHash = currentPolicyHash();
  const classFive: PrivacyHit[] = [];
  for (const [artifact, digestPath, digest] of [
    [readyRead.artifact!.file, "$.policy_sha256", ready.policy_sha256],
    [fragmentRead.artifact!.file, "$.policy_sha256", fragment.policy_sha256],
    [manifestRead.artifact!.file, "$.policy_sha256", manifest.policy_sha256],
  ] as const) {
    if (digest !== policyHash) classFive.push(newHit(artifact, digestPath, "artifact.policy_hash"));
  }
  classFive.push(...validatePolicySnapshot(ready, readyRead.artifact!.file));
  classFive.push(...validateEncoder(ready, readyRead.artifact!.file, rootAbsolute));
  if (classFive.length > 0) return firstFailureClass(classFive);

  const classSix: PrivacyHit[] = [];
  const manifestByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (let i = 0; i < ready.files.length; i++) {
    const entry = ready.files[i];
    const stagedFixture = resolve(bundleAbsolute, "files", entry.path);
    const stagedSidecar = `${stagedFixture}.sha256`;
    const bytes = readFileSync(stagedFixture);
    const digest = sha256(bytes);
    const fragmentEntry = fragment.files[i];
    if (bytes.length !== entry.bytes)
      classSix.push(newHit(`files/${entry.path}`, `$.files[${i}].bytes`, "binary.byte_count"));
    if (digest !== entry.sha256)
      classSix.push(newHit(`files/${entry.path}`, `$.files[${i}].sha256`, "binary.hash"));
    if (fragmentEntry.bytes !== bytes.length)
      classSix.push(
        newHit(fragmentRead.artifact!.file, `$.files[${i}].bytes`, "binary.byte_count"),
      );
    if (fragmentEntry.sha256 !== digest)
      classSix.push(newHit(fragmentRead.artifact!.file, `$.files[${i}].sha256`, "binary.hash"));
    const sidecarBytes = readFileSync(stagedSidecar);
    const expectedSidecar = `${digest}  ${basename(entry.path)}\n`;
    if (!/^[0-9a-f]{64}  [A-Za-z0-9._-]+\n$/.test(sidecarBytes.toString("latin1"))) {
      classSix.push(newHit(`files/${entry.path}.sha256`, "$", "binary.sidecar_format"));
    } else if (sidecarBytes.toString("utf8") !== expectedSidecar || digest !== entry.sha256) {
      classSix.push(newHit(`files/${entry.path}.sha256`, "$", "binary.sidecar_mismatch"));
    }
    const destination = resolve(rootAbsolute, entry.path);
    const destinationSidecar = `${destination}.sha256`;
    let fixtureExists = false;
    let sidecarExists = false;
    let fixtureRegular = false;
    let sidecarRegular = false;
    try {
      const state = lstatSync(destination);
      fixtureExists = true;
      fixtureRegular = state.isFile() && !state.isSymbolicLink();
    } catch {
      fixtureExists = false;
    }
    try {
      const state = lstatSync(destinationSidecar);
      sidecarExists = true;
      sidecarRegular = state.isFile() && !state.isSymbolicLink();
    } catch {
      sidecarExists = false;
    }
    if (
      fixtureExists !== sidecarExists ||
      (fixtureExists && (!fixtureRegular || !sidecarRegular))
    ) {
      classSix.push(newHit(entry.path, "$", "binary.stage_destination_conflict"));
    } else if (fixtureExists && sidecarExists) {
      const committed = manifestByPath.get(entry.path);
      if (
        !readFileSync(destination).equals(bytes) ||
        !readFileSync(destinationSidecar).equals(sidecarBytes) ||
        committed === undefined ||
        !sameManifestEntry(committed, fragment.files[i])
      )
        classSix.push(newHit(entry.path, "$", "binary.stage_destination_conflict"));
    }
  }
  if (classSix.length > 0) return firstFailureClass(classSix);

  const classSeven = validateReadySemantics(ready, readyRead.artifact!.file);
  for (let i = 0; i < readyEntries.length; i++) {
    if (!sameManifestEntry(readyEntries[i], fragment.files[i])) {
      classSeven.push(newHit(readyRead.artifact!.file, `$.files[${i}]`, "artifact.provenance"));
    }
  }
  return firstFailureClass(classSeven);
}

function collectLegacyFiles(rootDir: string, paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const pathname of paths) collectFiles(resolve(rootDir, pathname), files);
  const seen = new Set<string>();
  return files.filter((file) => {
    const absolute = resolve(file);
    if (seen.has(absolute)) return false;
    seen.add(absolute);
    return true;
  });
}

function displayLegacyHits(hits: readonly PrivacyHit[], rootDir: string): PrivacyHit[] {
  const rootAbsolute = resolve(rootDir);
  return hits.map((hit) => {
    const rel = relative(rootAbsolute, resolve(hit.file));
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      ? { ...hit, file: rel.split(sep).join("/") }
      : hit;
  });
}

function formatHit(hit: PrivacyHit): string {
  const loc = hit.line > 0 ? `${hit.file}:${hit.line}:${hit.column}` : hit.file;
  return `${loc}  [${hit.code}] ${hit.path} ${hit.detail}`;
}

export function main(argv: readonly string[]): number {
  const modeFlags = argv.filter((arg) => arg === "--root" || arg === "--staged-bundle");
  const unknownFlags = argv.filter(
    (arg) => arg.startsWith("-") && arg !== "--root" && arg !== "--staged-bundle",
  );
  const invalidMode =
    unknownFlags.length > 0 ||
    modeFlags.length > 1 ||
    (modeFlags.length === 1 && (argv.length !== 2 || argv[0] !== modeFlags[0]));
  if (invalidMode) {
    console.error(`check-fixture-privacy: ${FAILURE_DETAIL["cli.usage"]}`);
    return 2;
  }

  let rootDir = process.cwd();
  let hits: PrivacyHit[];
  let sourceCount = 0;
  let goldenCount = 0;
  if (modeFlags[0] === "--staged-bundle") {
    const bundle = argv[1];
    if (!isSafePath(bundle) || isAbsolute(bundle)) {
      console.error(`check-fixture-privacy: ${FAILURE_DETAIL["cli.usage"]}`);
      return 2;
    }
    hits = findStagedBundleHits(bundle, rootDir);
  } else {
    if (modeFlags[0] === "--root") {
      const requestedRoot = argv[1];
      if (!isAbsolute(requestedRoot)) {
        console.error(`check-fixture-privacy: ${FAILURE_DETAIL["cli.usage"]}`);
        return 2;
      }
      const current = resolve(process.cwd());
      rootDir = resolve(requestedRoot);
      if (rootDir === current || rootDir.startsWith(`${current}${sep}`)) {
        console.error(`check-fixture-privacy: ${FAILURE_DETAIL["cli.usage"]}`);
        return 2;
      }
      try {
        const currentReal = realpathSync(current);
        const requestedReal = realpathSync(rootDir);
        if (requestedReal === currentReal || requestedReal.startsWith(`${currentReal}${sep}`)) {
          console.error(`check-fixture-privacy: ${FAILURE_DETAIL["cli.usage"]}`);
          return 2;
        }
      } catch {
        // A missing shadow root is validated as a missing committed artifact.
      }
    }
    const explicitPaths = modeFlags.length === 0 ? argv : [];
    if (explicitPaths.some((arg) => arg.startsWith("-"))) {
      console.error(`check-fixture-privacy: ${FAILURE_DETAIL["cli.usage"]}`);
      return 2;
    }
    const legacyPaths = explicitPaths.length > 0 ? explicitPaths : DEFAULT_SCAN_PATHS;
    const legacySourceFiles = collectLegacyFiles(rootDir, legacyPaths);
    const legacyGoldenFiles = collectLegacyFiles(rootDir, [GOLDEN_FIXTURE_DIR]);
    const inventory = secureInventory(rootDir);
    sourceCount = legacySourceFiles.length;
    goldenCount = legacyGoldenFiles.length;
    hits =
      inventory.hits.length > 0
        ? firstFailureClass(inventory.hits)
        : findFixturePrivacyHits(
            {
              legacySourceFiles,
              legacyGoldenFiles,
              binaryInventoryFiles: inventory.fixtures,
              activitySidecarFiles: inventory.sidecars,
            },
            { rootDir },
          );
    hits = displayLegacyHits(hits, rootDir);
  }
  if (hits.length === 0) {
    console.log(
      `check-fixture-privacy: ${sourceCount} source file(s) + ${goldenCount} golden fixture(s) clean.`,
    );
    return 0;
  }
  console.error(`check-fixture-privacy: ${hits.length} privacy violation(s) found:`);
  for (const hit of hits) console.error("  " + formatHit(hit));
  return 1;
}

runGateCli(import.meta.url, main);
