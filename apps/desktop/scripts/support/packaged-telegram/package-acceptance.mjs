import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import ts from "typescript";

export const TELEGRAM_ACCEPTANCE_APP_ID = "icu.enduragent.desktop.telegram-acceptance";
export const TELEGRAM_ACCEPTANCE_PACKAGE_NAME = "enduragent-desktop-telegram-acceptance";
export const TELEGRAM_ACCEPTANCE_PRODUCT_NAME = "Enduragent Telegram Acceptance";
export const TELEGRAM_ACCEPTANCE_MARKER = "enduragentDesktopTelegramAcceptance";
export const TELEGRAM_ACCEPTANCE_ENTITLEMENTS = Object.freeze({
  "com.apple.security.cs.allow-jit": true,
});

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function configureTelegramAcceptanceSigningEnvironment(environment) {
  if (!exactObject(environment)) {
    throw new TypeError("Telegram acceptance signing environment is invalid");
  }
  environment.CSC_FOR_PULL_REQUEST = "true";
  environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}

const WORKSPACE_PACKAGE_NAME = /^@enduragent\/[a-z0-9][a-z0-9._-]*$/u;

function workspaceDependencies(manifest) {
  if (!exactObject(manifest)) {
    throw new TypeError("Telegram acceptance workspace manifest is invalid");
  }
  if (manifest.dependencies === undefined) return [];
  if (!exactObject(manifest.dependencies)) {
    throw new TypeError("Telegram acceptance workspace dependencies are invalid");
  }
  const dependencies = [];
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (!name.startsWith("@enduragent/")) continue;
    if (
      !WORKSPACE_PACKAGE_NAME.test(name) ||
      typeof version !== "string" ||
      version.length === 0 ||
      version.trim() !== version
    ) {
      throw new TypeError("Telegram acceptance workspace dependencies are invalid");
    }
    dependencies.push(name);
  }
  return dependencies.sort();
}

function exactRuntimeExportTargets(exportsValue) {
  const targets = new Set();
  const visited = new Set();
  const visit = (value) => {
    if (value === null) return;
    if (typeof value === "string") {
      const path = value.slice(2);
      const segments = path.split("/");
      if (
        !value.startsWith("./") ||
        value.includes("\\") ||
        value.includes("\0") ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
      ) {
        throw new TypeError("Telegram acceptance workspace export target is invalid");
      }
      if (!value.includes("*")) targets.add(value);
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError("Telegram acceptance workspace exports are invalid");
    }
    if (visited.has(value)) {
      throw new TypeError("Telegram acceptance workspace exports are invalid");
    }
    visited.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else {
      for (const [condition, entry] of Object.entries(value)) {
        if (condition === "types" || condition.startsWith("types@")) continue;
        visit(entry);
      }
    }
    visited.delete(value);
  };
  visit(exportsValue);
  return [...targets].sort();
}

function requireUniqueLine(lines, prefix, expected, message) {
  const matches = lines.filter((line) => line.startsWith(`${prefix}=`));
  if (matches.length !== 1 || matches[0] !== `${prefix}=${expected}`) {
    throw new TypeError(message);
  }
}

function requirePositiveLine(lines, pattern, message) {
  const match = lines.map((line) => pattern.exec(line)).find((candidate) => candidate !== null);
  if (match === undefined || match.slice(1).some((value) => Number(value) < 1)) {
    throw new TypeError(message);
  }
}

export function createTelegramAcceptanceBuilderConfiguration(canonical) {
  if (
    !exactObject(canonical) ||
    !Array.isArray(canonical.files) ||
    !exactObject(canonical.directories) ||
    !exactObject(canonical.mac) ||
    (canonical.extraMetadata !== undefined && !exactObject(canonical.extraMetadata))
  ) {
    throw new TypeError("canonical Desktop builder configuration is invalid");
  }
  const matches = canonical.files.filter((entry) => entry === "out/**");
  if (matches.length !== 1) {
    throw new TypeError("canonical Desktop runtime FileSet is ambiguous");
  }
  return {
    ...canonical,
    appId: TELEGRAM_ACCEPTANCE_APP_ID,
    productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    extraMetadata: {
      name: TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
      productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
      [TELEGRAM_ACCEPTANCE_MARKER]: true,
    },
    directories: {
      ...canonical.directories,
      output: "dist/telegram-acceptance-package",
    },
    files: canonical.files.map((entry) =>
      entry === "out/**"
        ? {
            from: "dist/telegram-acceptance-build/out",
            to: "out",
            filter: ["**/*"],
          }
        : entry,
    ),
    mac: {
      ...canonical.mac,
      identity: "-",
      hardenedRuntime: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      target: [{ target: "dir", arch: ["arm64"] }],
    },
  };
}

export function verifyTelegramAcceptanceSignature(description) {
  if (typeof description !== "string") {
    throw new TypeError("Telegram acceptance signature description is invalid");
  }
  const lines = description.split(/\r?\n/u).map((line) => line.trim());
  requireUniqueLine(
    lines,
    "Identifier",
    TELEGRAM_ACCEPTANCE_APP_ID,
    "Telegram acceptance signature identifier is invalid",
  );
  requireUniqueLine(lines, "Signature", "adhoc", "Telegram acceptance signature is not ad-hoc");
  requireUniqueLine(
    lines,
    "TeamIdentifier",
    "not set",
    "Telegram acceptance signature unexpectedly has a team",
  );
  requirePositiveLine(
    lines,
    /^Info\.plist entries=(\d+)$/u,
    "Telegram acceptance signature does not bind Info.plist",
  );
  requirePositiveLine(
    lines,
    /^Sealed Resources version=(\d+) rules=(\d+) files=(\d+)$/u,
    "Telegram acceptance signature does not seal bundle resources",
  );
  requirePositiveLine(
    lines,
    /^Internal requirements count=\d+ size=(\d+)$/u,
    "Telegram acceptance signature has no internal requirements record",
  );
  const cdHashLines = lines.filter((line) => line.startsWith("CDHash="));
  if (cdHashLines.length !== 1 || !/^CDHash=[0-9a-f]{40}$/u.test(cdHashLines[0])) {
    throw new TypeError("Telegram acceptance signature code-directory hash is invalid");
  }
  return cdHashLines[0].slice("CDHash=".length);
}

export function verifyTelegramAcceptanceNestedSignature(description) {
  if (typeof description !== "string") {
    throw new TypeError("Telegram acceptance nested signature is invalid");
  }
  const lines = description.split(/\r?\n/u).map((line) => line.trim());
  const identifiers = lines.filter((line) => /^Identifier=.+$/u.test(line));
  const cdHashes = lines.filter((line) => line.startsWith("CDHash="));
  const signatures = lines.filter((line) => line.startsWith("Signature="));
  const teams = lines.filter((line) => line.startsWith("TeamIdentifier="));
  if (
    identifiers.length !== 1 ||
    cdHashes.length !== 1 ||
    !/^CDHash=[0-9a-f]{40}$/u.test(cdHashes[0]) ||
    signatures.length !== 1 ||
    signatures[0] !== "Signature=adhoc" ||
    teams.length !== 1 ||
    teams[0] !== "TeamIdentifier=not set"
  ) {
    throw new TypeError("Telegram acceptance nested signature is invalid");
  }
}

export function verifyTelegramAcceptanceInfoPlist(value) {
  if (
    !exactObject(value) ||
    value.CFBundleIdentifier !== TELEGRAM_ACCEPTANCE_APP_ID ||
    value.CFBundleName !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME ||
    value.CFBundleDisplayName !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME ||
    value.CFBundleExecutable !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME
  ) {
    throw new TypeError("Telegram acceptance Info.plist identity is invalid");
  }
}

export function verifyTelegramAcceptanceEntitlements(value) {
  if (
    !exactObject(value) ||
    Object.keys(value).length !== 1 ||
    value["com.apple.security.cs.allow-jit"] !== true
  ) {
    throw new TypeError("Telegram acceptance signed entitlements are invalid");
  }
}

export function verifyTelegramAcceptanceNestedEntitlements(value) {
  if (value === undefined) return;
  if (
    !exactObject(value) ||
    Object.keys(value).length !== 1 ||
    value["com.apple.security.cs.allow-jit"] !== true
  ) {
    throw new TypeError("Telegram acceptance nested entitlements are invalid");
  }
}

export function verifyTelegramAcceptanceNestedListing(description) {
  if (typeof description !== "string") {
    throw new TypeError("Telegram acceptance nested code listing is invalid");
  }
  const lines = description
    .split(/\n/u)
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const executableLines = lines.filter((line) => line.startsWith("Executable="));
  if (executableLines.length !== 1) {
    throw new TypeError("Telegram acceptance nested code listing is invalid");
  }
  const executable = executableLines[0].slice("Executable=".length);
  if (
    !executable.startsWith("/") ||
    executable.trim() !== executable ||
    executable.includes("\0")
  ) {
    throw new TypeError("Telegram acceptance nested code listing is invalid");
  }
  const nested = lines
    .filter((line) => line.startsWith("Nested="))
    .map((line) => line.slice("Nested=".length));
  const seen = new Set();
  for (const path of nested) {
    const segments = path.split("/");
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.trim() !== path ||
      path.includes("\\") ||
      path.includes("\0") ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      seen.has(path)
    ) {
      throw new TypeError("Telegram acceptance nested code listing is invalid");
    }
    seen.add(path);
  }
  return { executable, nested };
}

export function selectTelegramAcceptanceNestedTarget(applicationRoot, candidates) {
  if (
    typeof applicationRoot !== "string" ||
    !isAbsolute(applicationRoot) ||
    !Array.isArray(candidates)
  ) {
    throw new TypeError("Telegram acceptance nested code resolution is invalid");
  }
  const resolved = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) {
      throw new TypeError("Telegram acceptance nested code resolution is invalid");
    }
    const displacement = relative(applicationRoot, candidate);
    if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) {
      throw new TypeError("Telegram acceptance nested code target escapes the application");
    }
    resolved.add(candidate);
  }
  if (resolved.size !== 1) {
    throw new TypeError(
      resolved.size === 0
        ? "Telegram acceptance nested code target is missing"
        : "Telegram acceptance nested code target is ambiguous",
    );
  }
  return resolved.values().next().value;
}

export function verifyTelegramAcceptanceDesignatedRequirement(value, expectedCdHash) {
  if (typeof expectedCdHash !== "string" || !/^[0-9a-f]{40}$/u.test(expectedCdHash)) {
    throw new TypeError("Telegram acceptance code-directory hash is invalid");
  }
  if (
    typeof value !== "string" ||
    value.trim().replaceAll(/\s+/gu, " ") !== `# designated => cdhash H"${expectedCdHash}"`
  ) {
    throw new TypeError("Telegram acceptance designated requirement is invalid");
  }
}

export function verifyTelegramAcceptanceManifest(value, expectedVersion) {
  if (
    !exactObject(value) ||
    typeof expectedVersion !== "string" ||
    expectedVersion.length === 0 ||
    value.name !== TELEGRAM_ACCEPTANCE_PACKAGE_NAME ||
    value.productName !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME ||
    value[TELEGRAM_ACCEPTANCE_MARKER] !== true ||
    value.version !== expectedVersion ||
    value.type !== "module" ||
    value.main !== "out/main/index.js"
  ) {
    throw new TypeError("Telegram acceptance ASAR manifest identity is invalid");
  }
}

export function verifyTelegramAcceptanceWorkspaceRuntime(
  rootManifest,
  archiveEntries,
  readManifest,
) {
  if (
    !Array.isArray(archiveEntries) ||
    archiveEntries.some((entry) => typeof entry !== "string") ||
    typeof readManifest !== "function"
  ) {
    throw new TypeError("Telegram acceptance workspace archive is invalid");
  }
  const entries = new Set(
    archiveEntries.map((entry) => (entry.startsWith("/") ? entry.slice(1) : entry)),
  );
  const pending = workspaceDependencies(rootManifest);
  if (pending.length === 0) {
    throw new TypeError("Telegram acceptance workspace dependency closure is empty");
  }
  const seen = new Set();
  const exportTargets = [];

  while (pending.length > 0) {
    const packageName = pending.shift();
    if (seen.has(packageName)) continue;
    seen.add(packageName);
    const packageRoot = `node_modules/${packageName}`;
    const manifestPath = `${packageRoot}/package.json`;
    if (!entries.has(manifestPath)) {
      throw new TypeError(
        `Telegram acceptance workspace package manifest is missing: ${packageName}`,
      );
    }
    const manifest = readManifest(manifestPath);
    if (!exactObject(manifest) || manifest.name !== packageName) {
      throw new TypeError(
        `Telegram acceptance workspace package manifest is invalid: ${packageName}`,
      );
    }
    const targets = exactRuntimeExportTargets(manifest.exports);
    for (const target of targets) {
      const archivePath = `${packageRoot}/${target.slice(2)}`;
      if (!entries.has(archivePath)) {
        throw new TypeError(
          `Telegram acceptance workspace export target is missing: ${packageName} ${target}`,
        );
      }
      exportTargets.push(archivePath);
    }
    pending.push(...workspaceDependencies(manifest));
  }

  return {
    packages: [...seen].sort(),
    exportTargets: exportTargets.sort(),
  };
}

function propertyPath(value, expected) {
  let current = value;
  for (let index = expected.length - 1; index > 0; index -= 1) {
    if (!ts.isPropertyAccessExpression(current) || current.name.text !== expected[index]) {
      return false;
    }
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === expected[0];
}

function callExpression(value, target, argumentChecks = []) {
  return (
    ts.isCallExpression(value) &&
    propertyPath(value.expression, target) &&
    value.arguments.length === argumentChecks.length &&
    value.arguments.every((argument, index) => argumentChecks[index](argument))
  );
}

function expressionStatement(value, check) {
  return ts.isExpressionStatement(value) && check(value.expression);
}

function exactPropertyAssignments(value, expectedNames) {
  if (!ts.isObjectLiteralExpression(value) || value.properties.length !== expectedNames.length) {
    return undefined;
  }
  const assignments = new Map();
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return undefined;
    if (assignments.has(property.name.text)) return undefined;
    assignments.set(property.name.text, property.initializer);
  }
  if (expectedNames.some((name) => !assignments.has(name))) return undefined;
  return assignments;
}

function exactParameter(value, name) {
  return (
    ts.isIdentifier(value.name) &&
    value.name.text === name &&
    value.modifiers === undefined &&
    value.dotDotDotToken === undefined &&
    value.questionToken === undefined &&
    value.type === undefined &&
    value.initializer === undefined
  );
}

function arrowFunction(value, parameters, bodyCheck) {
  return (
    ts.isArrowFunction(value) &&
    value.modifiers === undefined &&
    value.typeParameters === undefined &&
    value.type === undefined &&
    value.parameters.length === parameters.length &&
    !value.parameters.hasTrailingComma &&
    value.parameters.every((parameter, index) => exactParameter(parameter, parameters[index])) &&
    bodyCheck(value.body)
  );
}

function emptyCatchCall(value, check) {
  return (
    ts.isTryStatement(value) &&
    value.finallyBlock === undefined &&
    value.tryBlock.statements.length === 1 &&
    expressionStatement(value.tryBlock.statements[0], check) &&
    value.catchClause !== undefined &&
    value.catchClause.variableDeclaration === undefined &&
    value.catchClause.block.statements.length === 0
  );
}

const PACKAGED_TELEGRAM_HELPERS = Object.freeze({
  installTelegramAcceptanceQuitControl: `function installTelegramAcceptanceQuitControl(input, quit) {
  let source = "";
  let valid = true;
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    if (!valid) return;
    source += chunk;
    if (source.length > TELEGRAM_ACCEPTANCE_QUIT_FRAME.length || !TELEGRAM_ACCEPTANCE_QUIT_FRAME.startsWith(source)) {
      valid = false;
    }
  });
  input.once("error", () => {
    valid = false;
  });
  input.once("end", () => {
    if (valid && source === TELEGRAM_ACCEPTANCE_QUIT_FRAME) quit();
  });
  input.resume();
}`,
  telegramAcceptanceStartupFailureDiagnostic: `function telegramAcceptanceStartupFailureDiagnostic(error) {
  let category = "unknown";
  try {
    if (typeof error === "object" && error !== null && "code" in error) {
      switch (error.code) {
        case "ERR_INVALID_PACKAGE_CONFIG":
        case "ERR_INVALID_PACKAGE_TARGET":
        case "ERR_MODULE_NOT_FOUND":
        case "ERR_PACKAGE_IMPORT_NOT_DEFINED":
        case "ERR_PACKAGE_PATH_NOT_EXPORTED":
        case "ERR_UNKNOWN_FILE_EXTENSION":
        case "ERR_UNSUPPORTED_DIR_IMPORT":
          category = "module-resolution";
      }
    }
  } catch {
  }
  return \`packaged Desktop production startup failed; category=${"${category}"}\`;
}`,
  installSingleLoginLaunchObservation: `function installSingleLoginLaunchObservation(app2, wasOpenedAtLogin) {
  const key = "getLoginItemSettings";
  const ownDescriptor = Object.getOwnPropertyDescriptor(app2, key);
  const original = app2.getLoginItemSettings;
  let pending = true;
  const restore = () => {
    if (ownDescriptor === void 0) {
      if (!Reflect.deleteProperty(app2, key)) {
        throw new TypeError("Telegram acceptance startup port could not be restored");
      }
      return;
    }
    Object.defineProperty(app2, key, ownDescriptor);
  };
  Object.defineProperty(app2, key, {
    configurable: true,
    writable: true,
    value(...args) {
      if (!pending) throw new TypeError("Telegram acceptance startup marker was reused");
      pending = false;
      restore();
      return { ...original.apply(app2, args), wasOpenedAtLogin };
    }
  });
}`,
  consumeAcceptanceStartupMarker: `function consumeAcceptanceStartupMarker(environment, app2) {
  const marker = environment[ACCEPTANCE_OS_LOGIN_MARKER_ENV];
  delete environment[ACCEPTANCE_OS_LOGIN_MARKER_ENV];
  if (marker === void 0) {
    installSingleLoginLaunchObservation(app2, false);
    return "manual";
  }
  if (marker !== ACCEPTANCE_OS_LOGIN_MARKER_VALUE) {
    throw new TypeError("Telegram acceptance startup marker is invalid");
  }
  installSingleLoginLaunchObservation(app2, true);
  return "os-login";
}`,
});

const PACKAGED_TELEGRAM_PROTECTED_BINDINGS = new Set([
  "TELEGRAM_ACCEPTANCE_QUIT_FRAME",
  "installTelegramAcceptanceQuitControl",
  "telegramAcceptanceStartupFailureDiagnostic",
  "runTelegramAcceptanceBootstrap",
  "ACCEPTANCE_OS_LOGIN_MARKER_ENV",
  "ACCEPTANCE_OS_LOGIN_MARKER_VALUE",
  "installSingleLoginLaunchObservation",
  "consumeAcceptanceStartupMarker",
]);

const PACKAGED_TELEGRAM_MUTATING_CALLS = Object.freeze([
  ["Object", "assign"],
  ["Object", "defineProperties"],
  ["Object", "defineProperty"],
  ["Object", "setPrototypeOf"],
  ["Reflect", "defineProperty"],
  ["Reflect", "deleteProperty"],
  ["Reflect", "set"],
  ["Reflect", "setPrototypeOf"],
]);

function syntaxTokens(value) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    value,
  );
  const tokens = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push([token, scanner.getTokenText()]);
  }
  return tokens;
}

function sameSyntax(actual, expected) {
  const actualTokens = syntaxTokens(actual);
  const expectedTokens = syntaxTokens(expected);
  return (
    actualTokens.length === expectedTokens.length &&
    actualTokens.every(
      (token, index) =>
        token[0] === expectedTokens[index][0] && token[1] === expectedTokens[index][1],
    )
  );
}

function verifyTelegramAcceptanceStringConstant(source, name, expectedValue) {
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .filter((statement) => (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  if (
    declaration === undefined ||
    !ts.isStringLiteral(declaration.initializer) ||
    declaration.initializer.text !== expectedValue
  ) {
    throw new TypeError("Telegram acceptance production helper constant is invalid");
  }
}

function verifyTelegramAcceptanceHelperDeclarations(source) {
  verifyTelegramAcceptanceStringConstant(
    source,
    "TELEGRAM_ACCEPTANCE_QUIT_FRAME",
    '{"type":"enduragent-telegram-acceptance","command":"quit"}\n',
  );
  verifyTelegramAcceptanceStringConstant(
    source,
    "ACCEPTANCE_OS_LOGIN_MARKER_ENV",
    "ENDURAGENT_ACCEPTANCE_OS_LOGIN_LAUNCH",
  );
  verifyTelegramAcceptanceStringConstant(source, "ACCEPTANCE_OS_LOGIN_MARKER_VALUE", "os-login");
  for (const [name, expected] of Object.entries(PACKAGED_TELEGRAM_HELPERS)) {
    const declarations = source.statements.filter(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (declarations.length !== 1 || !sameSyntax(declarations[0].getText(source), expected)) {
      throw new TypeError(`Telegram acceptance production helper is invalid: ${name}`);
    }
  }
}

function protectedTelegramBindingWriteTarget(value) {
  if (ts.isIdentifier(value)) return PACKAGED_TELEGRAM_PROTECTED_BINDINGS.has(value.text);
  if (
    ts.isParenthesizedExpression(value) ||
    ts.isSpreadElement(value) ||
    ts.isSpreadAssignment(value)
  ) {
    return protectedTelegramBindingWriteTarget(value.expression);
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    return protectedTelegramBindingWriteTarget(value.expression);
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) => !ts.isOmittedExpression(element) && protectedTelegramBindingWriteTarget(element),
    );
  }
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return PACKAGED_TELEGRAM_PROTECTED_BINDINGS.has(property.name.text);
      }
      if (ts.isPropertyAssignment(property)) {
        return protectedTelegramBindingWriteTarget(property.initializer);
      }
      return ts.isSpreadAssignment(property) && protectedTelegramBindingWriteTarget(property);
    });
  }
  return (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    protectedTelegramBindingWriteTarget(value.left)
  );
}

function assignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function verifyTelegramAcceptanceProtectedBindings(source) {
  let invalidWrite = false;
  const visit = (node) => {
    if (invalidWrite) return;
    if (
      (ts.isBinaryExpression(node) &&
        assignmentOperator(node.operatorToken.kind) &&
        protectedTelegramBindingWriteTarget(node.left)) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        protectedTelegramBindingWriteTarget(node.operand)) ||
      (ts.isDeleteExpression(node) && protectedTelegramBindingWriteTarget(node.expression)) ||
      ((ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        !ts.isVariableDeclarationList(node.initializer) &&
        protectedTelegramBindingWriteTarget(node.initializer)) ||
      (ts.isCallExpression(node) &&
        PACKAGED_TELEGRAM_MUTATING_CALLS.some((target) => propertyPath(node.expression, target)) &&
        node.arguments.length > 0 &&
        protectedTelegramBindingWriteTarget(node.arguments[0]))
    ) {
      invalidWrite = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (invalidWrite) {
    throw new TypeError("Telegram acceptance production helper binding is mutated");
  }
}

function topLevelConstant(value, name) {
  const declaration = ts.isVariableStatement(value)
    ? value.declarationList.declarations[0]
    : undefined;
  return (
    ts.isVariableStatement(value) &&
    (value.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    value.declarationList.declarations.length === 1 &&
    declaration !== undefined &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === name
  );
}

function topLevelFunction(value, name) {
  return ts.isFunctionDeclaration(value) && value.name?.text === name;
}

function verifyTelegramAcceptanceTopLevelLayout(source) {
  const statements = source.statements.filter(
    (statement) =>
      !ts.isImportDeclaration(statement) ||
      (ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "electron"),
  );
  if (
    statements.length !== 10 ||
    !ts.isImportDeclaration(statements[0]) ||
    !topLevelConstant(statements[1], "TELEGRAM_ACCEPTANCE_QUIT_FRAME") ||
    !topLevelFunction(statements[2], "installTelegramAcceptanceQuitControl") ||
    !topLevelFunction(statements[3], "telegramAcceptanceStartupFailureDiagnostic") ||
    !topLevelFunction(statements[4], "runTelegramAcceptanceBootstrap") ||
    !topLevelConstant(statements[5], "ACCEPTANCE_OS_LOGIN_MARKER_ENV") ||
    !topLevelConstant(statements[6], "ACCEPTANCE_OS_LOGIN_MARKER_VALUE") ||
    !topLevelFunction(statements[7], "installSingleLoginLaunchObservation") ||
    !topLevelFunction(statements[8], "consumeAcceptanceStartupMarker") ||
    !ts.isExpressionStatement(statements[9]) ||
    !ts.isAwaitExpression(statements[9].expression)
  ) {
    throw new TypeError("Telegram acceptance production top-level layout is invalid");
  }
}

function verifyTelegramAcceptanceBootstrapDeclaration(source) {
  const declarations = source.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "runTelegramAcceptanceBootstrap",
  );
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  const inputParameter = declaration?.parameters[0];
  const statement = declaration?.body?.statements[0];
  if (
    declaration === undefined ||
    declaration.modifiers?.length !== 1 ||
    declaration.modifiers[0].kind !== ts.SyntaxKind.AsyncKeyword ||
    declaration.asteriskToken !== undefined ||
    declaration.typeParameters !== undefined ||
    declaration.type !== undefined ||
    declaration.typeArguments !== undefined ||
    declaration.parameters.length !== 1 ||
    declaration.parameters.hasTrailingComma ||
    inputParameter === undefined ||
    !exactParameter(inputParameter, "input") ||
    declaration.body?.statements.length !== 1 ||
    statement === undefined ||
    !ts.isTryStatement(statement) ||
    statement.finallyBlock !== undefined ||
    statement.tryBlock.statements.length !== 3 ||
    !expressionStatement(statement.tryBlock.statements[0], (expression) =>
      callExpression(
        expression,
        ["installTelegramAcceptanceQuitControl"],
        [
          (argument) => propertyPath(argument, ["input", "input"]),
          (argument) => propertyPath(argument, ["input", "quit"]),
        ],
      ),
    ) ||
    !expressionStatement(statement.tryBlock.statements[1], (expression) =>
      callExpression(expression, ["input", "beforeImport"]),
    ) ||
    !expressionStatement(
      statement.tryBlock.statements[2],
      (expression) =>
        ts.isAwaitExpression(expression) &&
        callExpression(expression.expression, ["input", "importProduction"]),
    )
  ) {
    throw new TypeError("Telegram acceptance production bootstrap is invalid");
  }
  const catchClause = statement.catchClause;
  const catchParameter = catchClause?.variableDeclaration?.name;
  const catchStatements = catchClause?.block.statements;
  if (
    catchClause === undefined ||
    catchParameter === undefined ||
    !ts.isIdentifier(catchParameter) ||
    catchParameter.text !== "error" ||
    catchStatements === undefined ||
    catchStatements.length !== 2 ||
    !emptyCatchCall(catchStatements[0], (expression) =>
      callExpression(
        expression,
        ["input", "report"],
        [
          (argument) =>
            callExpression(
              argument,
              ["telegramAcceptanceStartupFailureDiagnostic"],
              [
                (diagnosticArgument) =>
                  ts.isIdentifier(diagnosticArgument) && diagnosticArgument.text === "error",
              ],
            ),
        ],
      ),
    ) ||
    !emptyCatchCall(catchStatements[1], (expression) =>
      callExpression(
        expression,
        ["input", "exit"],
        [(argument) => ts.isNumericLiteral(argument) && argument.text === "1"],
      ),
    )
  ) {
    throw new TypeError("Telegram acceptance production bootstrap is invalid");
  }
}

export function verifyTelegramAcceptanceMainEntry(value, readRoute) {
  if (typeof value !== "string") {
    throw new TypeError("Telegram acceptance main entry is invalid");
  }
  const source = ts.createSourceFile(
    "telegram-acceptance-main.js",
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  verifyTelegramAcceptanceProtectedBindings(source);
  verifyTelegramAcceptanceTopLevelLayout(source);
  const imports = [];
  const collectImports = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(node);
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(source);
  const staticImports = source.statements.filter(ts.isImportDeclaration);
  const hasOAuthRoute = staticImports.length === 4;
  if (readRoute !== undefined && !hasOAuthRoute) {
    throw new TypeError("OAuth acceptance route import is required");
  }
  const electronImport = staticImports[0];
  const electronBindings = electronImport?.importClause?.namedBindings;
  const appImport = ts.isNamedImports(electronBindings) ? electronBindings.elements[0] : undefined;
  const finalStatement = source.statements.at(-1);
  const finalExpression =
    finalStatement !== undefined && ts.isExpressionStatement(finalStatement)
      ? finalStatement.expression
      : undefined;
  const finalCall =
    finalExpression !== undefined && ts.isAwaitExpression(finalExpression)
      ? finalExpression.expression
      : undefined;
  const bootstrapCall =
    finalCall !== undefined &&
    ts.isCallExpression(finalCall) &&
    propertyPath(finalCall.expression, ["runTelegramAcceptanceBootstrap"])
      ? finalCall
      : undefined;
  const assignments =
    bootstrapCall?.arguments.length === 1
      ? exactPropertyAssignments(bootstrapCall.arguments[0], [
          "input",
          "beforeImport",
          "importProduction",
          "quit",
          "report",
          "exit",
        ])
      : undefined;
  const importProduction = assignments?.get("importProduction");
  const productionImport =
    importProduction !== undefined &&
    arrowFunction(
      importProduction,
      [],
      (body) => ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword,
    )
      ? importProduction.body
      : undefined;
  const importPath =
    productionImport !== undefined &&
    ts.isCallExpression(productionImport) &&
    productionImport.arguments.length === 1 &&
    ts.isStringLiteral(productionImport.arguments[0])
      ? productionImport.arguments[0].text
      : undefined;
  const beforeImport = assignments?.get("beforeImport");
  const quit = assignments?.get("quit");
  const report = assignments?.get("report");
  const exit = assignments?.get("exit");
  if (
    source.parseDiagnostics.length !== 0 ||
    (staticImports.length !== 1 && staticImports.length !== 4) ||
    electronImport === undefined ||
    electronImport.modifiers !== undefined ||
    electronImport.attributes !== undefined ||
    electronImport.assertClause !== undefined ||
    !ts.isStringLiteral(electronImport.moduleSpecifier) ||
    electronImport.moduleSpecifier.text !== "electron" ||
    electronImport.importClause === undefined ||
    electronImport.importClause.isTypeOnly ||
    electronImport.importClause.phaseModifier !== undefined ||
    electronImport.importClause?.name !== undefined ||
    !ts.isNamedImports(electronBindings) ||
    electronBindings.elements.length !== (hasOAuthRoute ? 2 : 1) ||
    electronBindings.elements.hasTrailingComma ||
    appImport === undefined ||
    appImport.isTypeOnly ||
    appImport.propertyName !== undefined ||
    appImport.name.text !== "app" ||
    (hasOAuthRoute &&
      (electronBindings.elements[1].name.text !== "shell" ||
        electronBindings.elements[1].propertyName !== undefined ||
        electronBindings.elements[1].isTypeOnly)) ||
    imports.length !== 1 ||
    imports[0] !== productionImport ||
    assignments === undefined ||
    !propertyPath(assignments.get("input"), ["process", "stdin"]) ||
    beforeImport === undefined ||
    !arrowFunction(beforeImport, [], (body) =>
      !hasOAuthRoute
        ? callExpression(
            body,
            ["consumeAcceptanceStartupMarker"],
            [
              (argument) => propertyPath(argument, ["process", "env"]),
              (argument) => ts.isIdentifier(argument) && argument.text === "app",
            ],
          )
        : ts.isBlock(body) &&
          body.statements.length === 2 &&
          expressionStatement(body.statements[0], (expression) =>
            callExpression(
              expression,
              ["installOAuthAcceptanceRoute"],
              [
                (argument) => ts.isStringLiteral(argument) && argument.text === "main",
                (argument) => ts.isIdentifier(argument) && argument.text === "shell",
              ],
            ),
          ) &&
          expressionStatement(body.statements[1], (expression) =>
            callExpression(
              expression,
              ["consumeAcceptanceStartupMarker"],
              [
                (argument) => propertyPath(argument, ["process", "env"]),
                (argument) => ts.isIdentifier(argument) && argument.text === "app",
              ],
            ),
          ),
    ) ||
    quit === undefined ||
    !arrowFunction(quit, [], (body) => callExpression(body, ["app", "quit"])) ||
    report === undefined ||
    !arrowFunction(report, ["diagnostic"], (body) =>
      callExpression(
        body,
        ["process", "stderr", "write"],
        [
          (argument) =>
            ts.isTemplateExpression(argument) &&
            argument.head.text === "" &&
            argument.templateSpans.length === 1 &&
            ts.isIdentifier(argument.templateSpans[0].expression) &&
            argument.templateSpans[0].expression.text === "diagnostic" &&
            argument.templateSpans[0].literal.text === "\n",
        ],
      ),
    ) ||
    exit === undefined ||
    !arrowFunction(
      exit,
      ["code"],
      (body) =>
        ts.isBlock(body) &&
        body.statements.length === 2 &&
        expressionStatement(
          body.statements[0],
          (expression) =>
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            propertyPath(expression.left, ["process", "exitCode"]) &&
            ts.isIdentifier(expression.right) &&
            expression.right.text === "code",
        ) &&
        expressionStatement(body.statements[1], (expression) =>
          callExpression(
            expression,
            ["app", "exit"],
            [(argument) => ts.isIdentifier(argument) && argument.text === "code"],
          ),
        ),
    ) ||
    typeof importPath !== "string" ||
    !/^\.\/index-[A-Za-z0-9_-]+\.js$/u.test(importPath)
  ) {
    throw new TypeError("Telegram acceptance production main location is invalid");
  }
  verifyTelegramAcceptanceHelperDeclarations(source);
  verifyTelegramAcceptanceBootstrapDeclaration(source);
  if (hasOAuthRoute) {
    for (const [index, moduleName] of [
      [2, "node:fs"],
      [3, "node:path"],
    ]) {
      const sideImport = staticImports[index];
      if (
        sideImport.importClause !== undefined ||
        sideImport.modifiers !== undefined ||
        sideImport.attributes !== undefined ||
        !ts.isStringLiteral(sideImport.moduleSpecifier) ||
        sideImport.moduleSpecifier.text !== moduleName
      ) {
        throw new TypeError("OAuth acceptance route dependency is invalid");
      }
    }
    const routeImport = staticImports[1];
    const routeBindings = routeImport?.importClause?.namedBindings;
    if (
      routeImport === undefined ||
      !ts.isStringLiteral(routeImport.moduleSpecifier) ||
      !/^\.\/oauth-acceptance-route-[A-Za-z0-9_-]+\.js$/u.test(routeImport.moduleSpecifier.text) ||
      routeImport.modifiers !== undefined ||
      routeImport.attributes !== undefined ||
      routeImport.importClause?.name !== undefined ||
      !ts.isNamedImports(routeBindings) ||
      routeBindings.elements.length !== 1 ||
      routeBindings.elements[0].name.text !== "installOAuthAcceptanceRoute" ||
      routeBindings.elements[0].propertyName !== undefined ||
      routeBindings.elements[0].isTypeOnly ||
      typeof readRoute !== "function"
    ) {
      throw new TypeError("OAuth acceptance route import is invalid");
    }
    verifyOAuthAcceptanceRoute(readRoute(`out/main/${routeImport.moduleSpecifier.text.slice(2)}`));
  }
  return `out/main/${importPath.slice(2)}`;
}

export function verifyOAuthAcceptanceRoute(value) {
  if (
    typeof value !== "string" ||
    createHash("sha256")
      .update(JSON.stringify(syntaxTokens(value)))
      .digest("hex") !== "c148f7a3a422dfcddcdc84481c7e657025b2e4be0648ae269b0d5d3275ee9ce4"
  ) {
    throw new TypeError("OAuth acceptance route does not match the reviewed transport");
  }
}
