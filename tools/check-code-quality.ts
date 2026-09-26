import * as ts from "typescript";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TS_EXTS, ext, nonFlagArgs, runGateCli } from "./lint-fs.js";

const LINT_ROOTS = ["packages", "apps", "tools"] as const;
const BASELINE_PATH = "tools/code-quality-baseline.json";
const OXLINT_BIN = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url));
const FILE_LENGTH_LIMIT = 800;
const RENDERER_UI_DIR = "apps/desktop-renderer/src/ui/";
const TEST_DIRS: ReadonlySet<string> = new Set(["tests", "test", "e2e", "fixtures"]);
const SPAWN_BUFFER = 64 * 1024 * 1024;

const RULE_IDS = [
  "comment",
  "double-assertion",
  "file-length",
  "lint-suppression",
  "no-empty",
  "no-empty-function",
  "no-warning-comments",
  "swallowed-rejection",
  "typescript/ban-ts-comment",
  "typescript/no-explicit-any",
  "typescript/no-non-null-assertion",
  "ui-restricted-api",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

type Scope = "all" | "non-test" | "renderer-ui";

interface RuleSpec {
  readonly scope: Scope;
  readonly guidance: string;
}

const HANDLE_THE_ERROR = "handle the error, return a typed failure, or let it propagate";
const FIX_INSTEAD_OF_SUPPRESSING = "fix the type or the code instead of suppressing the checker";

const RULES: Readonly<Record<RuleId, RuleSpec>> = {
  comment: {
    scope: "all",
    guidance:
      "move the rationale to the PR description or an ADR, and make the code say it through names and structure",
  },
  "double-assertion": { scope: "non-test", guidance: FIX_INSTEAD_OF_SUPPRESSING },
  "file-length": { scope: "non-test", guidance: "split the file before adding to it" },
  "lint-suppression": { scope: "non-test", guidance: FIX_INSTEAD_OF_SUPPRESSING },
  "no-empty": { scope: "all", guidance: HANDLE_THE_ERROR },
  "no-empty-function": { scope: "non-test", guidance: "remove the no-op or give it behavior" },
  "no-warning-comments": {
    scope: "all",
    guidance: "finish the work or file it in docs/issues/",
  },
  "swallowed-rejection": { scope: "non-test", guidance: HANDLE_THE_ERROR },
  "typescript/ban-ts-comment": { scope: "all", guidance: FIX_INSTEAD_OF_SUPPRESSING },
  "typescript/no-explicit-any": { scope: "all", guidance: FIX_INSTEAD_OF_SUPPRESSING },
  "typescript/no-non-null-assertion": {
    scope: "non-test",
    guidance: "narrow the type or parse the value at its boundary",
  },
  "ui-restricted-api": {
    scope: "renderer-ui",
    guidance:
      "read state through a controller or store; UI components do not call the bridge, network, or timers",
  },
};

const OXLINT_CODES: ReadonlyMap<string, RuleId> = new Map([
  ["eslint(no-empty)", "no-empty"],
  ["eslint(no-empty-function)", "no-empty-function"],
  ["eslint(no-warning-comments)", "no-warning-comments"],
  ["typescript(ban-ts-comment)", "typescript/ban-ts-comment"],
  ["typescript(no-explicit-any)", "typescript/no-explicit-any"],
  ["typescript(no-non-null-assertion)", "typescript/no-non-null-assertion"],
  ["eslint(no-restricted-globals)", "ui-restricted-api"],
  ["eslint(no-restricted-properties)", "ui-restricted-api"],
]);

const EXEMPT_DIRECTIVES: readonly RegExp[] = [
  /^\/\/\/\s*<reference\b/u,
  /^\/\*\s*[#@]__PURE__\s*\*\/$/u,
  /^\/\*\s*@vite-ignore\s*\*\/$/u,
];
const TEST_EXEMPT_DIRECTIVES: readonly RegExp[] = [
  /^\/[/*]\s*@ts-expect-error\b/u,
  /^\/[/*]\s*(?:eslint|oxlint)-disable\b/u,
];
const LINT_SUPPRESSION = /^\/[/*]\s*(?:eslint|oxlint)-disable\b/u;

export type Counts = { [Rule in RuleId]?: Record<string, number> };

export interface Measurement {
  readonly fileCount: number;
  readonly counts: Counts;
}

export interface Drift {
  readonly rule: RuleId;
  readonly file: string;
  readonly baseline: number;
  readonly current: number;
}

export type UpdateResult =
  | { readonly kind: "updated"; readonly baseline: Counts }
  | { readonly kind: "refused"; readonly increases: readonly Drift[] };

export interface OxlintDiagnostic {
  readonly code: string;
  readonly filename: string;
}

const BaselineSchema = z.partialRecord(
  z.enum(RULE_IDS),
  z.record(z.string(), z.number().int().positive()),
);

const OxlintReportSchema = z.object({
  diagnostics: z.array(z.object({ code: z.string(), filename: z.string() })),
});

export function isTestPath(file: string): boolean {
  const segments = file.split("/");
  const name = segments.pop() ?? "";
  return /\.(?:test|spec)\./u.test(name) || segments.some((segment) => TEST_DIRS.has(segment));
}

function appliesTo(rule: RuleId, file: string): boolean {
  switch (RULES[rule].scope) {
    case "all":
      return true;
    case "non-test":
      return !isTestPath(file);
    case "renderer-ui":
      return file.startsWith(RENDERER_UI_DIR);
  }
}

function add(counts: Counts, rule: RuleId, file: string, amount = 1): void {
  if (!appliesTo(rule, file)) return;
  const byFile = (counts[rule] ??= {});
  byFile[file] = (byFile[file] ?? 0) + amount;
}

function mergeInto(target: Counts, source: Counts): void {
  for (const rule of RULE_IDS) {
    for (const [file, amount] of Object.entries(source[rule] ?? {})) add(target, rule, file, amount);
  }
}

function normalize(counts: Counts): Counts {
  const normalized: Counts = {};
  for (const rule of [...RULE_IDS].sort()) {
    const byFile = counts[rule] ?? {};
    const files = Object.keys(byFile).sort();
    if (files.length > 0) normalized[rule] = Object.fromEntries(files.map((file) => [file, byFile[file]]));
  }
  return normalized;
}

function collectComments(sourceFile: ts.SourceFile): string[] {
  const text = sourceFile.text;
  const ranges = new Map<number, ts.CommentRange>();
  const jsxTextSpans: Array<readonly [number, number]> = [];

  function visit(node: ts.Node): void {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTextSpans.push([node.pos, node.end]);
      return;
    }
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) ranges.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) ranges.set(range.pos, range);
  }

  visit(sourceFile);
  return [...ranges.values()]
    .filter((range) => !jsxTextSpans.some(([start, end]) => range.pos >= start && range.pos < end))
    .sort((a, b) => a.pos - b.pos)
    .map((range) => text.slice(range.pos, range.end));
}

function isExemptComment(comment: string, inTest: boolean): boolean {
  if (EXEMPT_DIRECTIVES.some((directive) => directive.test(comment))) return true;
  return inTest && TEST_EXEMPT_DIRECTIVES.some((directive) => directive.test(comment));
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isNothing(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  if (ts.isIdentifier(value)) return value.text === "undefined";
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  if (!ts.isVoidExpression(value)) return false;
  const operand = unwrapParentheses(value.expression);
  return ts.isNumericLiteral(operand) && operand.text === "0";
}

function isSwallowedRejection(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "catch") return false;
  const handler = node.arguments[0] === undefined ? undefined : unwrapParentheses(node.arguments[0]);
  if (handler === undefined || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) return false;
  return ts.isBlock(handler.body) ? handler.body.statements.length === 0 : isNothing(handler.body);
}

function isDoubleAssertion(node: ts.Node): boolean {
  if (!ts.isAsExpression(node)) return false;
  const inner = unwrapParentheses(node.expression);
  return ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

export function scanSource(file: string, text: string): Counts {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const counts: Counts = {};
  const inTest = isTestPath(file);

  for (const comment of collectComments(sourceFile)) {
    if (!isExemptComment(comment, inTest)) add(counts, "comment", file);
    if (LINT_SUPPRESSION.test(comment)) add(counts, "lint-suppression", file);
  }

  function visit(node: ts.Node): void {
    if (isSwallowedRejection(node)) add(counts, "swallowed-rejection", file);
    if (isDoubleAssertion(node)) add(counts, "double-assertion", file);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const lines = lineCount(text);
  if (lines > FILE_LENGTH_LIMIT) add(counts, "file-length", file, lines);
  return counts;
}

export function countOxlintDiagnostics(diagnostics: readonly OxlintDiagnostic[]): Counts {
  const counts: Counts = {};
  for (const diagnostic of diagnostics) {
    const rule = OXLINT_CODES.get(diagnostic.code);
    if (rule !== undefined) add(counts, rule, diagnostic.filename);
  }
  return counts;
}

export function runOxlint(root: string): OxlintDiagnostic[] {
  const result = spawnSync(
    process.execPath,
    [OXLINT_BIN, "-c", ".oxlintrc.json", "-f", "json", ...LINT_ROOTS],
    { cwd: root, encoding: "utf8", maxBuffer: SPAWN_BUFFER },
  );
  if (result.error !== undefined) throw result.error;
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`oxlint exited ${result.status} without a JSON report: ${result.stderr}`, {
      cause: error,
    });
  }
  return OxlintReportSchema.parse(report).diagnostics;
}

export function listSourceFiles(root: string): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...LINT_ROOTS],
    { cwd: root, encoding: "utf8", maxBuffer: SPAWN_BUFFER },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files exited ${result.status}: ${result.stderr}`);
  return [...new Set(result.stdout.split("\0"))]
    .filter((file) => TS_EXTS.has(ext(file)) && existsSync(join(root, file)))
    .sort();
}

export function measure(root: string): Measurement {
  const files = listSourceFiles(root);
  const counts: Counts = {};
  for (const file of files) mergeInto(counts, scanSource(file, readFileSync(join(root, file), "utf8")));
  mergeInto(counts, countOxlintDiagnostics(runOxlint(root)));
  return { fileCount: files.length, counts: normalize(counts) };
}

export function compareCounts(baseline: Counts, current: Counts): Drift[] {
  const drifts: Drift[] = [];
  for (const rule of RULE_IDS) {
    const before = baseline[rule] ?? {};
    const after = current[rule] ?? {};
    for (const file of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const was = before[file] ?? 0;
      const now = after[file] ?? 0;
      if (was !== now) drifts.push({ rule, file, baseline: was, current: now });
    }
  }
  return drifts;
}

export function updateBaseline(baseline: Counts, current: Counts): UpdateResult {
  const increases = compareCounts(baseline, current).filter((drift) => drift.current > drift.baseline);
  if (increases.length > 0) return { kind: "refused", increases };
  return { kind: "updated", baseline: normalize(current) };
}

export function serializeBaseline(counts: Counts): string {
  return `${JSON.stringify(normalize(counts), null, 2)}\n`;
}

export function parseBaseline(json: string): Counts {
  return BaselineSchema.parse(JSON.parse(json));
}

export function formatDrift(drift: Drift): string {
  const action =
    drift.current > drift.baseline
      ? RULES[drift.rule].guidance
      : "run `pnpm check:code-quality --update` to lock in the lower count";
  return `  ${drift.file}  ${drift.rule}  ${drift.baseline} -> ${drift.current}  ${action}`;
}

function entryCount(counts: Counts): number {
  return RULE_IDS.reduce((sum, rule) => sum + Object.keys(counts[rule] ?? {}).length, 0);
}

function writeBaseline(path: string, counts: Counts): void {
  writeFileSync(path, serializeBaseline(counts), "utf8");
  console.log(`check-code-quality: wrote ${BASELINE_PATH} (${entryCount(counts)} file entries).`);
}

export function main(argv: readonly string[]): number {
  const root = nonFlagArgs(argv)[0] ?? ".";
  const update = argv.includes("--update");
  const baselinePath = join(root, BASELINE_PATH);
  const baseline = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, "utf8")) : null;
  const { fileCount, counts } = measure(root);

  if (baseline === null) {
    if (update) {
      writeBaseline(baselinePath, counts);
      return 0;
    }
    console.error(`check-code-quality: missing ${BASELINE_PATH}; run \`pnpm check:code-quality --update\`.`);
    return 1;
  }

  if (update) {
    const result = updateBaseline(baseline, counts);
    if (result.kind === "updated") {
      writeBaseline(baselinePath, result.baseline);
      return 0;
    }
    console.error(`check-code-quality: refusing to raise ${BASELINE_PATH}; fix these first:`);
    for (const drift of result.increases) console.error(formatDrift(drift));
    return 1;
  }

  const drifts = compareCounts(baseline, counts);
  if (drifts.length === 0) {
    console.log(`check-code-quality: ${fileCount} source file(s) within ${BASELINE_PATH}.`);
    return 0;
  }
  console.error(`check-code-quality: ${drifts.length} count(s) differ from ${BASELINE_PATH}:`);
  for (const drift of drifts) console.error(formatDrift(drift));
  return 1;
}

runGateCli(import.meta.url, main);
