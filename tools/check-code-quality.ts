import * as ts from "typescript";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TS_EXTS, ext, nonFlagArgs, runGateCli } from "./lint-fs.js";

const LINT_ROOTS = ["packages", "apps", "tools"] as const;
const BASELINE_PATH = "tools/code-quality-baseline.json";
const OXLINT_BIN = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url));
const OXFMT_BIN = fileURLToPath(new URL("../node_modules/oxfmt/bin/oxfmt", import.meta.url));
const FORMATTED_ROOTS = ["packages/", "apps/"] as const;
const FILE_LENGTH_LIMIT = 800;
const RENDERER_UI_DIR = "apps/desktop-renderer/src/ui/";
const TEST_DIRS: ReadonlySet<string> = new Set(["tests", "test", "e2e", "fixtures"]);
const SPAWN_BUFFER = 64 * 1024 * 1024;
const BASE_ENV = "BASE_SHA";
const DEFAULT_BASE = "origin/main";
const FULL_HISTORY_HINT = "fetch full history, for example `actions/checkout` with `fetch-depth: 0`";
const CHANGED_FILE_ACTION = "this PR changes the file, so remove every violation of this rule in it";
const BASELINE_ONLY_SHRINKS = "the baseline may only shrink; fix the code instead";

const RULE_IDS = [
  "comment",
  "disguised-swallow",
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

const CHANGED_FILE_RULES: readonly RuleId[] = RULE_IDS.filter((rule) => rule !== "file-length");

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
  "disguised-swallow": { scope: "all", guidance: HANDLE_THE_ERROR },
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

const FileCountsSchema = z.record(z.string(), z.number().int().positive());
const BaselineSchema = z.partialRecord(z.enum(RULE_IDS), FileCountsSchema);
const RecordedBaselineSchema = z.record(z.string(), FileCountsSchema);

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

type InlineFunction = ts.ArrowFunction | ts.FunctionExpression;
type Handler = InlineFunction | ts.FunctionDeclaration;
type ResolveHandler = (reference: ts.Identifier) => Handler | undefined;
type Completion = "continues" | "returns" | "throws";

interface Scenario {
  readonly bound: string | undefined;
  readonly isError: boolean;
}

const BOOLEAN_COMPARISONS: ReadonlyMap<ts.SyntaxKind, boolean> = new Map([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, true],
  [ts.SyntaxKind.EqualsEqualsToken, true],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, false],
  [ts.SyntaxKind.ExclamationEqualsToken, false],
]);

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function refersTo(expression: ts.Expression, name: string | undefined): boolean {
  const value = unwrapParentheses(expression);
  return name !== undefined && ts.isIdentifier(value) && value.text === name;
}

function booleanLiteral(expression: ts.Expression): boolean | undefined {
  const value = unwrapParentheses(expression);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function cannotHaveEffect(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  return (
    ts.isIdentifier(value) ||
    ts.isLiteralExpression(value) ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    booleanLiteral(value) !== undefined
  );
}

function isVoidWithoutEffect(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  return ts.isVoidExpression(value) && cannotHaveEffect(value.expression);
}

function isNothing(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  return value.kind === ts.SyntaxKind.NullKeyword || refersTo(value, "undefined") || isVoidWithoutEffect(value);
}

function isErrorConstructor(expression: ts.Expression): boolean {
  const value = unwrapParentheses(expression);
  if (!ts.isPropertyAccessExpression(value)) return refersTo(value, "Error");
  return value.name.text === "Error" && refersTo(value.expression, "globalThis");
}

function evaluateErrorTest(condition: ts.Expression, scenario: Scenario): boolean | undefined {
  const test = unwrapParentheses(condition);
  if (ts.isPrefixUnaryExpression(test)) {
    if (test.operator !== ts.SyntaxKind.ExclamationToken) return undefined;
    const operand = evaluateErrorTest(test.operand, scenario);
    return operand === undefined ? undefined : !operand;
  }
  if (!ts.isBinaryExpression(test)) return undefined;
  if (test.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
    return refersTo(test.left, scenario.bound) && isErrorConstructor(test.right) ? scenario.isError : undefined;
  }
  const expectsEqual = BOOLEAN_COMPARISONS.get(test.operatorToken.kind);
  const rightLiteral = booleanLiteral(test.right);
  const literal = rightLiteral ?? booleanLiteral(test.left);
  if (expectsEqual === undefined || literal === undefined) return undefined;
  const compared = evaluateErrorTest(rightLiteral === undefined ? test.right : test.left, scenario);
  return compared === undefined ? undefined : (compared === literal) === expectsEqual;
}

function completionOf(statement: ts.Statement, scenario: Scenario): Completion | undefined {
  if (ts.isEmptyStatement(statement)) return "continues";
  if (ts.isBlock(statement)) return completionOfAll(statement.statements, scenario);
  if (ts.isExpressionStatement(statement)) {
    return isVoidWithoutEffect(statement.expression) ? "continues" : undefined;
  }
  if (ts.isThrowStatement(statement)) return refersTo(statement.expression, scenario.bound) ? "throws" : undefined;
  if (ts.isReturnStatement(statement)) {
    return statement.expression === undefined || isNothing(statement.expression) ? "returns" : undefined;
  }
  if (!ts.isIfStatement(statement)) return undefined;
  const holds = evaluateErrorTest(statement.expression, scenario);
  if (holds === undefined) return undefined;
  const taken = holds ? statement.thenStatement : statement.elseStatement;
  return taken === undefined ? "continues" : completionOf(taken, scenario);
}

function completionOfAll(statements: readonly ts.Statement[], scenario: Scenario): Completion | undefined {
  for (const statement of statements) {
    const completion = completionOf(statement, scenario);
    if (completion !== "continues") return completion;
  }
  return "continues";
}

function dropsEveryError(block: ts.Block, binding: ts.BindingName | undefined, returnFallsThrough: boolean): boolean {
  if (block.statements.length === 0) return false;
  const bound = binding !== undefined && ts.isIdentifier(binding) ? binding.text : undefined;
  const forError = completionOfAll(block.statements, { bound, isError: true });
  const forOther = completionOfAll(block.statements, { bound, isError: false });
  if (forError === undefined || forError === "throws" || forOther === undefined) return false;
  if (returnFallsThrough || forOther === "throws") return true;
  return forError !== "returns" && forOther !== "returns";
}

function isInlineFunction(node: ts.Node): node is InlineFunction {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function rejectionHandler(node: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text;
  const argument = method === "catch" ? node.arguments[0] : method === "then" ? node.arguments[1] : undefined;
  return argument === undefined ? undefined : unwrapParentheses(argument);
}

function returnsNothing(handler: Handler): boolean {
  const body = handler.body;
  if (body === undefined) return false;
  return ts.isBlock(body) ? body.statements.length === 0 : isNothing(body);
}

function disguisesSwallow(handler: Handler): boolean {
  const body = handler.body;
  return body !== undefined && ts.isBlock(body) && dropsEveryError(body, handler.parameters[0]?.name, true);
}

function sameFileChecker(sourceFile: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost(options),
    getSourceFile: (name) => (name === sourceFile.fileName ? sourceFile : undefined),
    fileExists: () => false,
    directoryExists: () => false,
    readFile: () => undefined,
  };
  return ts.createProgram([sourceFile.fileName], options, host).getTypeChecker();
}

function declaredHandler(reference: ts.Identifier, checker: ts.TypeChecker): Handler | undefined {
  const declaration = checker.getSymbolAtLocation(reference)?.valueDeclaration;
  if (declaration === undefined) return undefined;
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
  if ((ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return undefined;
  const initializer = unwrapParentheses(declaration.initializer);
  return isInlineFunction(initializer) ? initializer : undefined;
}

function isSwallowedRejection(node: ts.Node, resolve: ResolveHandler): boolean {
  const handler = rejectionHandler(node);
  if (handler === undefined) return false;
  if (isInlineFunction(handler)) return returnsNothing(handler);
  const declared = ts.isIdentifier(handler) ? resolve(handler) : undefined;
  return declared !== undefined && (returnsNothing(declared) || disguisesSwallow(declared));
}

function isDisguisedSwallow(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (ts.isCatchClause(node)) {
    if (node.block.statements.length > 0) return dropsEveryError(node.block, node.variableDeclaration?.name, false);
    return sourceFile.text.slice(node.block.getStart(sourceFile) + 1, node.block.end - 1).trim() !== "";
  }
  const handler = rejectionHandler(node);
  return handler !== undefined && isInlineFunction(handler) && disguisesSwallow(handler);
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

  let checker: ts.TypeChecker | undefined;
  const resolve: ResolveHandler = (reference) =>
    declaredHandler(reference, (checker ??= sameFileChecker(sourceFile)));

  function visit(node: ts.Node): void {
    if (isSwallowedRejection(node, resolve)) add(counts, "swallowed-rejection", file);
    if (isDisguisedSwallow(node, sourceFile)) add(counts, "disguised-swallow", file);
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

type Env = Readonly<Record<string, string | undefined>>;

interface Violation {
  readonly rule: RuleId;
  readonly file: string;
  readonly count: number;
}

interface ChangedFiles {
  readonly kind: "changed";
  readonly base: string;
  readonly mergeBase: string;
  readonly files: readonly string[];
}

type ChangeScope =
  | ChangedFiles
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "no-merge-base"; readonly reason: string };

function git(root: string, args: readonly string[]): SpawnSyncReturns<string> {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: SPAWN_BUFFER });
  if (result.error !== undefined) throw result.error;
  return result;
}

function gitOutput(root: string, args: readonly string[]): string {
  const result = git(root, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

export function listSourceFiles(root: string): string[] {
  const output = gitOutput(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...LINT_ROOTS]);
  return [...new Set(output.split("\0"))]
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

function resolveBase(root: string, env: Env): string | undefined {
  const fromEnv = env[BASE_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return git(root, ["rev-parse", "--verify", "--quiet", `${DEFAULT_BASE}^{commit}`]).status === 0
    ? DEFAULT_BASE
    : undefined;
}

function findChangeScope(root: string, env: Env): ChangeScope {
  const base = resolveBase(root, env);
  if (base === undefined) return { kind: "skipped", reason: `neither ${BASE_ENV} nor ${DEFAULT_BASE} is available` };
  const found = git(root, ["merge-base", base, "HEAD"]);
  if (found.status !== 0) {
    const detail = found.stderr.trim() === "" ? "the histories share no commit" : found.stderr.trim();
    return { kind: "no-merge-base", reason: `cannot find the merge-base of ${base} and HEAD (${detail}); ${FULL_HISTORY_HINT}` };
  }
  const mergeBase = found.stdout.trim();
  const head = gitOutput(root, ["rev-parse", "HEAD"]).trim();
  if (head === mergeBase && gitOutput(root, ["status", "--porcelain"]) === "") {
    return { kind: "skipped", reason: `HEAD is the merge-base with ${base} and the working tree is clean` };
  }
  const files = gitOutput(root, ["diff", "--name-only", "--diff-filter=ACMR", "-z", mergeBase, "--", ...LINT_ROOTS])
    .split("\0")
    .filter((file) => TS_EXTS.has(ext(file)))
    .sort();
  return { kind: "changed", base, mergeBase, files };
}

function changedFileViolations(counts: Counts, files: readonly string[]): Violation[] {
  return files.flatMap((file) =>
    CHANGED_FILE_RULES.flatMap((rule) => {
      const count = counts[rule]?.[file] ?? 0;
      return count > 0 ? [{ rule, file, count }] : [];
    }),
  );
}

function listUnformatted(root: string, files: readonly string[]): string[] {
  const targets = files.filter((file) => FORMATTED_ROOTS.some((formattedRoot) => file.startsWith(formattedRoot)));
  if (targets.length === 0) return [];
  const result = spawnSync(process.execPath, [OXFMT_BIN, "--list-different", ...targets], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: SPAWN_BUFFER,
  });
  if (result.error !== undefined) throw result.error;
  const listed = result.stdout.split("\n").filter((line) => line !== "");
  if (result.status === 0 && listed.length === 0) return [];
  if (result.status === 1 && listed.length > 0) return listed.sort();
  throw new Error(`oxfmt exited ${result.status}: ${result.stdout}${result.stderr}`);
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

function increasesFrom(before: Counts, after: Counts): Drift[] {
  return compareCounts(before, after).filter((drift) => drift.current > drift.baseline);
}

export function updateBaseline(baseline: Counts, current: Counts): UpdateResult {
  const increases = increasesFrom(baseline, current);
  if (increases.length > 0) return { kind: "refused", increases };
  return { kind: "updated", baseline: normalize(current) };
}

export function serializeBaseline(counts: Counts): string {
  return `${JSON.stringify(normalize(counts), null, 2)}\n`;
}

export function parseBaseline(json: string): Counts {
  return BaselineSchema.parse(JSON.parse(json));
}

function parseRecordedBaseline(json: string): Counts {
  const recorded = RecordedBaselineSchema.parse(JSON.parse(json));
  const counts: Counts = {};
  for (const rule of RULE_IDS) {
    const byFile = recorded[rule];
    if (byFile !== undefined) counts[rule] = byFile;
  }
  return counts;
}

export function formatDrift(drift: Drift): string {
  const action =
    drift.current > drift.baseline
      ? RULES[drift.rule].guidance
      : "run `pnpm check:code-quality --update` to lock in the lower count";
  return `  ${drift.file}  ${drift.rule}  ${drift.baseline} -> ${drift.current}  ${action}`;
}

function formatViolation(violation: Violation): string {
  const { file, rule, count } = violation;
  return `  ${file}  ${rule}  ${count}  ${RULES[rule].guidance}; ${CHANGED_FILE_ACTION}`;
}

function formatUnformatted(file: string): string {
  return `  ${file}  format  run \`pnpm exec oxfmt ${file}\`, because this PR changes the file`;
}

function formatRaise(drift: Drift): string {
  return `  ${drift.file}  ${drift.rule}  ${drift.baseline} -> ${drift.current}  ${BASELINE_ONLY_SHRINKS}`;
}

function entryCount(counts: Counts): number {
  return RULE_IDS.reduce((sum, rule) => sum + Object.keys(counts[rule] ?? {}).length, 0);
}

function writeBaseline(path: string, counts: Counts): void {
  writeFileSync(path, serializeBaseline(counts), "utf8");
  console.log(`check-code-quality: wrote ${BASELINE_PATH} (${entryCount(counts)} file entries).`);
}

function checkWholeTree(baseline: Counts, { fileCount, counts }: Measurement): boolean {
  const drifts = compareCounts(baseline, counts);
  if (drifts.length === 0) {
    console.log(`check-code-quality: ${fileCount} source file(s) within ${BASELINE_PATH}.`);
    return true;
  }
  console.error(`check-code-quality: ${drifts.length} count(s) differ from ${BASELINE_PATH}:`);
  for (const drift of drifts) console.error(formatDrift(drift));
  return false;
}

function checkChangedFiles(root: string, { base, mergeBase, files }: ChangedFiles, counts: Counts): boolean {
  console.log(`check-code-quality: ${files.length} changed source file(s) since ${mergeBase}, the merge-base with ${base}:`);
  for (const file of files) console.log(`  ${file}`);
  const failures = [
    ...changedFileViolations(counts, files).map(formatViolation),
    ...listUnformatted(root, files).map(formatUnformatted),
  ];
  if (failures.length === 0) return true;
  console.error(`check-code-quality: ${failures.length} violation(s) in changed files:`);
  for (const failure of failures) console.error(failure);
  return false;
}

function guardBaseline(root: string, mergeBase: string, baseline: Counts): boolean {
  if (gitOutput(root, ["ls-tree", "--name-only", mergeBase, "--", BASELINE_PATH]).trim() === "") {
    console.log(`check-code-quality: skipping the baseline guard: ${mergeBase} has no ${BASELINE_PATH}.`);
    return true;
  }
  const recorded = gitOutput(root, ["show", `${mergeBase}:${BASELINE_PATH}`]);
  const raises = increasesFrom(parseRecordedBaseline(recorded), baseline);
  if (raises.length === 0) return true;
  console.error(`check-code-quality: ${raises.length} count(s) in ${BASELINE_PATH} rise above ${mergeBase}:`);
  for (const raise of raises) console.error(formatRaise(raise));
  return false;
}

function checkChanges(root: string, baseline: Counts, counts: Counts, env: Env): boolean {
  const scope = findChangeScope(root, env);
  if (scope.kind === "skipped") {
    console.log(`check-code-quality: skipping the changed-file check and the baseline guard: ${scope.reason}.`);
    return true;
  }
  if (scope.kind === "no-merge-base") {
    console.error(`check-code-quality: ${scope.reason}.`);
    return false;
  }
  const changedFilesPass = checkChangedFiles(root, scope, counts);
  const baselineHolds = guardBaseline(root, scope.mergeBase, baseline);
  return changedFilesPass && baselineHolds;
}

export function main(argv: readonly string[], env: Env = process.env): number {
  const root = nonFlagArgs(argv)[0] ?? ".";
  const update = argv.includes("--update");
  const baselinePath = join(root, BASELINE_PATH);
  const baseline = existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, "utf8")) : null;
  const measurement = measure(root);

  if (baseline === null) {
    if (update) {
      writeBaseline(baselinePath, measurement.counts);
      return 0;
    }
    console.error(`check-code-quality: missing ${BASELINE_PATH}; run \`pnpm check:code-quality --update\`.`);
    return 1;
  }

  if (update) {
    const result = updateBaseline(baseline, measurement.counts);
    if (result.kind === "updated") {
      writeBaseline(baselinePath, result.baseline);
      return 0;
    }
    console.error(`check-code-quality: refusing to raise ${BASELINE_PATH}; fix these first:`);
    for (const drift of result.increases) console.error(formatDrift(drift));
    return 1;
  }

  const wholeTreePasses = checkWholeTree(baseline, measurement);
  const changesPass = checkChanges(root, baseline, measurement.counts, env);
  return wholeTreePasses && changesPass ? 0 : 1;
}

runGateCli(import.meta.url, main);
