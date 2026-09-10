import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..", "src");

const CARD_MODULE = /(?:^|\/)components\/ui\/card$/u;
const BORDER_TOKENS = new Set(["border", "border-line", "border-line-2"]);
const RADIUS_TOKENS = new Set(["rounded-card", "rounded-lg", "rounded-xl"]);
const BOUNDARY_ELEMENTS = new Set([
  "Dialog",
  "DialogContent",
  "DialogPortal",
  "DialogPrimitive.Portal",
  "DialogPrimitive.Popup",
  "Popover",
  "PopoverContent",
  "PopoverPrimitive.Portal",
  "PopoverPrimitive.Popup",
  "Select",
  "SelectContent",
  "SelectPrimitive.Portal",
  "SelectPrimitive.Popup",
]);
const BOUNDARY_CLASS_MARKERS = new Set(["chat-composer__controls"]);

interface Violation {
  readonly file: string;
  readonly outer: string;
  readonly inner: string;
}

const ALLOWLIST: readonly Violation[] = [];

async function tsxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(path);
      return entry.name.endsWith(".tsx") ? [path] : [];
    }),
  );
  return files.flat().sort();
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

type Constants = ReadonlyMap<string, ts.Expression>;

function moduleConstants(sourceFile: ts.SourceFile): Constants {
  const constants = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined)
        constants.set(declaration.name.text, declaration.initializer);
  }
  return constants;
}

function staticClassText(node: ts.Node, constants: Constants): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  if (ts.isCallExpression(node))
    return node.arguments.map((argument) => staticClassText(argument, constants)).join(" ");
  if (ts.isJsxExpression(node) && node.expression !== undefined)
    return staticClassText(node.expression, constants);
  if (ts.isIdentifier(node)) {
    const constant = constants.get(node.text);
    return constant === undefined ? "" : staticClassText(constant, new Map());
  }
  return "";
}

function classTokens(node: ts.JsxOpeningLikeElement, constants: Constants): readonly string[] {
  for (const attribute of node.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== "className") continue;
    if (attribute.initializer === undefined) return [];
    return staticClassText(attribute.initializer, constants)
      .split(/\s+/u)
      .filter((token) => token !== "");
  }
  return [];
}

function importsCard(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      CARD_MODULE.test(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) => element.name.text === "Card"),
  );
}

function describeCardLike(
  node: ts.JsxOpeningLikeElement,
  cardImported: boolean,
  constants: Constants,
): string | null {
  const tag = tagName(node);
  const tokens = classTokens(node, constants);
  if (cardImported && tag === "Card") return "Card";
  if (tokens.some((token) => BORDER_TOKENS.has(token)) && tokens.some((t) => RADIUS_TOKENS.has(t)))
    return `${tag}[${tokens.join(" ")}]`;
  return null;
}

function isBoundary(node: ts.JsxOpeningLikeElement, constants: Constants): boolean {
  return (
    BOUNDARY_ELEMENTS.has(tagName(node)) ||
    classTokens(node, constants).some((token) => BOUNDARY_CLASS_MARKERS.has(token))
  );
}

function collectViolations(sourceFile: ts.SourceFile, file: string): Violation[] {
  const cardImported = importsCard(sourceFile);
  const constants = moduleConstants(sourceFile);
  const found: Violation[] = [];

  function visit(node: ts.Node, outer: string | null): void {
    let next = outer;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (isBoundary(opening, constants)) next = null;
      else {
        const self = describeCardLike(opening, cardImported, constants);
        if (self !== null) {
          if (outer !== null) found.push({ file, outer, inner: self });
          next = self;
        }
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, next);
    });
  }

  visit(sourceFile, null);
  return found;
}

function key(violation: Violation): string {
  return `${violation.file} :: ${violation.outer} > ${violation.inner}`;
}

function tally(violations: readonly Violation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const violation of violations)
    counts.set(key(violation), (counts.get(key(violation)) ?? 0) + 1);
  return counts;
}

function difference(left: Map<string, number>, right: Map<string, number>): string[] {
  const lines: string[] = [];
  for (const [entry, count] of left) {
    const missing = count - (right.get(entry) ?? 0);
    if (missing > 0) lines.push(`${entry} (x${missing})`);
  }
  return lines.sort();
}

async function scanRenderer(): Promise<Violation[]> {
  const files = await tsxFiles(sourceRoot);
  const violations = await Promise.all(
    files.map(async (path) => {
      const source = await readFile(path, "utf8");
      const sourceFile = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TSX,
      );
      return collectViolations(sourceFile, relative(sourceRoot, path).split(sep).join("/"));
    }),
  );
  return violations.flat();
}

describe("card-on-card nesting guard", () => {
  it("scans the renderer JSX", async () => {
    const files = await tsxFiles(sourceRoot);
    expect(files.length).toBeGreaterThan(0);
  });

  it("finds no card-like element nested inside another card-like element beyond the allowlist", async () => {
    const found = tally(await scanRenderer());
    expect(difference(found, tally(ALLOWLIST))).toEqual([]);
  });

  it("keeps every allowlist entry live so the list only shrinks", async () => {
    const found = tally(await scanRenderer());
    expect(difference(tally(ALLOWLIST), found)).toEqual([]);
  });
});
