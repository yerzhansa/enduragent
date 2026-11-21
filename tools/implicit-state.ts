import * as ts from "typescript";

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const TEXT_MATCH_METHODS: ReadonlySet<string> = new Set(["startsWith", "endsWith", "includes"]);
const SYNCHRONOUS_ITERATORS: ReadonlySet<string> = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);
const SENTENCE_END = /[.!?…]$/u;
const LETTER = /\p{L}/u;
const WHITESPACE = /\s/u;
const LOOSE_FLAG_THRESHOLD = 2;

type FunctionOwner = ts.SignatureDeclaration | ts.ClassStaticBlockDeclaration;
type Owner = FunctionOwner | ts.ClassLikeDeclaration | ts.SourceFile;
type NamedLet = ts.VariableDeclaration & { readonly name: ts.Identifier };

function isDisplayCopy(node: ts.Node): boolean {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;
  const text = node.text.trim();
  return WHITESPACE.test(text) && LETTER.test(text) && SENTENCE_END.test(text);
}

export function isCopyComparison(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) {
    return EQUALITY_OPERATORS.has(node.operatorToken.kind) && (isDisplayCopy(node.left) || isDisplayCopy(node.right));
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const [first] = node.arguments;
  return TEXT_MATCH_METHODS.has(node.expression.name.text) && first !== undefined && isDisplayCopy(first);
}

function isFunctionOwner(node: ts.Node): node is FunctionOwner {
  return ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
}

function functionOwner(node: ts.Node): FunctionOwner | ts.SourceFile {
  let current = node.parent;
  while (!isFunctionOwner(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function isSynchronousCallback(node: ts.Node): boolean {
  const call = node.parent;
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isCallExpression(call) &&
    call.arguments.some((argument) => argument === node) &&
    ts.isPropertyAccessExpression(call.expression) &&
    SYNCHRONOUS_ITERATORS.has(call.expression.name.text)
  );
}

function crossesDeferredBoundary(node: ts.Node, owner: ts.Node): boolean {
  for (let current = node.parent; current !== owner; current = current.parent) {
    if (isFunctionOwner(current) && !isSynchronousCallback(current)) return true;
  }
  return false;
}

function isBooleanLiteral(expression: ts.Expression | undefined): boolean {
  return expression?.kind === ts.SyntaxKind.TrueKeyword || expression?.kind === ts.SyntaxKind.FalseKeyword;
}

function isBooleanType(type: ts.TypeNode | undefined): boolean {
  return type?.kind === ts.SyntaxKind.BooleanKeyword;
}

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function someNode(root: ts.Node, matches: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (matches(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function isBooleanLet(node: ts.Node): node is NamedLet {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Let) !== 0 &&
    (isBooleanLiteral(node.initializer) || isBooleanType(node.type))
  );
}

function writtenLater(declaration: NamedLet, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return false;
  const owner = functionOwner(declaration);
  return someNode(
    owner,
    (node) =>
      isAssignment(node) &&
      ts.isIdentifier(node.left) &&
      checker.getSymbolAtLocation(node.left) === symbol &&
      crossesDeferredBoundary(node, owner),
  );
}

function isWrittenThroughThis(field: ts.PropertyDeclaration, owner: ts.ClassLikeDeclaration): boolean {
  if (!ts.isIdentifier(field.name) && !ts.isPrivateIdentifier(field.name)) return false;
  const name = field.name.text;
  return owner.members.some(
    (member) =>
      member !== field &&
      someNode(
        member,
        (node) =>
          isAssignment(node) &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          node.left.name.text === name,
      ),
  );
}

function isMutableBooleanField(field: ts.PropertyDeclaration, owner: ts.ClassLikeDeclaration): boolean {
  if ((ts.getCombinedModifierFlags(field) & (ts.ModifierFlags.Readonly | ts.ModifierFlags.Ambient)) !== 0) return false;
  if (!isBooleanLiteral(field.initializer) && !isBooleanType(field.type)) return false;
  return isWrittenThroughThis(field, owner);
}

function isBooleanInitialState(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) return false;
  if (isBooleanLiteral(argument)) return true;
  return ts.isArrowFunction(argument) && !ts.isBlock(argument.body) && isBooleanLiteral(argument.body);
}

function isBooleanUseState(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const named =
    (ts.isIdentifier(callee) && callee.text === "useState") ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === "useState");
  if (!named) return false;
  const [typeArgument] = node.typeArguments ?? [];
  return isBooleanInitialState(node.arguments[0]) || isBooleanType(typeArgument);
}

export function countLooseStateFlags(sourceFile: ts.SourceFile, checker: () => ts.TypeChecker): number {
  const flagsByOwner = new Map<Owner, number>();
  const note = (owner: Owner): void => {
    flagsByOwner.set(owner, (flagsByOwner.get(owner) ?? 0) + 1);
  };
  const visit = (node: ts.Node): void => {
    if (isBooleanLet(node) && writtenLater(node, checker())) note(functionOwner(node));
    if (ts.isPropertyDeclaration(node) && ts.isClassLike(node.parent) && isMutableBooleanField(node, node.parent)) {
      note(node.parent);
    }
    if (isBooleanUseState(node)) note(functionOwner(node));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let total = 0;
  for (const flags of flagsByOwner.values()) if (flags >= LOOSE_FLAG_THRESHOLD) total += flags;
  return total;
}
