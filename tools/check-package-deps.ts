/**
 * Package-dependency lint — `pnpm check:package-deps`.
 *
 * Enforces the layered workspace graph: which package may import which. The
 * layering (per ADR-0032) reads bottom-up:
 *
 *   - the pure compute kernel imports nothing from the workspace and no host
 *     builtins (`node:*` / bare Node builtins);
 *   - the Node host adapter imports the kernel only;
 *   - the engine imports the contract, the kernel, and sport packages;
 *   - sport packages import the kernel and the engine's sport subpath;
 *   - sync packages import the kernel;
 *   - the CLI and the desktop renderer import the contract;
 *   - the composition roots (the coach app and the desktop shell) are the only
 *     places the host adapter, the engine, and sync packages meet;
 *   - the legacy shipped binaries import core and sport packages, and nothing
 *     from the new graph.
 *
 * A RULES row governs each package dir. A row whose dir is absent is skipped
 * with a `(not present yet)` note so the full end-state table ships now and
 * every future package is born governed. Some edges are allowed transitionally
 * during the pivot: they PASS but surface a `WARN` line per unique package→
 * package edge so the burn-down stays visible in CI logs.
 *
 * Mechanism, per governed row: (1) an AST import walk over the row's `.ts`
 * files collecting every module specifier (`import … from`, `export … from`,
 * dynamic `import()`, `require()`) and (2) a manifest check over the row's
 * `dependencies` + `peerDependencies`. A global R7 pass requires every
 * `@enduragent/*`-named package manifest to be `"private": true`.
 *
 * The AST import walk is strictly stronger than a text grep of `node:*`. Files
 * that legitimately need to opt out place `package-deps-lint:skip-file` in the
 * first 1 KB. `packages/coach-contract` is deliberately ungoverned here — its
 * own gate (`check:contract-deps`) owns it.
 */

import * as ts from "typescript";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename, resolve, relative, sep } from "node:path";
import { isBuiltin } from "node:module";
import { TS_EXTS, ext, collectFiles, makeSkipCheck, nonFlagArgs, runGateCli } from "./lint-fs.js";
import {
  readUiReleaseLock,
  uiReleaseLockMatches,
  uiReleaseVersion,
} from "./ui-release-artifact.js";

export interface PackageDepRule {
  readonly ruleId: string;
  readonly dir: string;
  readonly srcOnly: boolean;
  readonly allowedWorkspace: readonly string[];
  readonly allowedManifestWorkspace?: readonly string[];
  readonly allowedExternal?: readonly string[];
  readonly allowedPublished?: readonly string[];
  readonly transitionalWorkspace: readonly string[];
  readonly forbidNode: boolean;
}

const COMPOSITION_ROOT_ALLOWED: readonly string[] = [
  "@enduragent/coach-contract",
  "@enduragent/coach-cli",
  "@enduragent/engine",
  "@enduragent/kernel",
  "@enduragent/kernel-node",
  "@enduragent/sync-*",
  "@enduragent/sport-*",
];

const DESKTOP_APP_ALLOWED: readonly string[] = [
  "@enduragent/coach",
  "@enduragent/coach-client",
  "@enduragent/coach-contract",
  "@enduragent/core",
];

const LEGACY_BINARY_ALLOWED: readonly string[] = ["@enduragent/core", "@enduragent/sport-*"];

/**
 * The end-state package graph. Absent rows ship dormant (skipped with a note);
 * `srcOnly: true` scans `<dir>/src` only so sibling test trees can carry
 * dev-only and transitional edges that are not part of the runtime graph.
 */
export const RULES: readonly PackageDepRule[] = [
  {
    ruleId: "R1",
    dir: "packages/kernel",
    srcOnly: true,
    allowedWorkspace: [],
    transitionalWorkspace: [],
    forbidNode: true,
  },
  {
    ruleId: "R2",
    dir: "packages/kernel-node",
    srcOnly: true,
    allowedWorkspace: ["@enduragent/kernel"],
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R3",
    dir: "packages/engine",
    srcOnly: true,
    allowedWorkspace: ["@enduragent/coach-contract", "@enduragent/kernel", "@enduragent/sport-*"],
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R3",
    dir: "packages/core",
    srcOnly: true,
    allowedWorkspace: ["@enduragent/coach-contract"],
    transitionalWorkspace: ["@enduragent/engine", "@enduragent/kernel"],
    forbidNode: false,
  },
  {
    ruleId: "R4",
    dir: "packages/sport-*",
    srcOnly: true,
    allowedWorkspace: ["@enduragent/kernel", "@enduragent/engine/sport"],
    allowedManifestWorkspace: ["@enduragent/kernel", "@enduragent/engine"],
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R5",
    dir: "packages/sync-*",
    srcOnly: true,
    allowedWorkspace: ["@enduragent/kernel"],
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R6",
    dir: "packages/coach-cli",
    srcOnly: true,
    allowedWorkspace: ["@enduragent/coach-contract", "@enduragent/coach-client"],
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R6",
    dir: "packages/coach-client",
    srcOnly: true,
    allowedWorkspace: ["@enduragent/coach-contract"],
    transitionalWorkspace: [],
    allowedExternal: [],
    forbidNode: true,
  },
  {
    ruleId: "R6",
    dir: "apps/desktop-renderer",
    srcOnly: true,
    allowedPublished: ["@enduragent/ui"],
    allowedWorkspace: ["@enduragent/coach-contract", "@enduragent/coach-client"],
    transitionalWorkspace: [],
    allowedExternal: [
      "react",
      "react-dom",
      "zustand",
      "@base-ui/react",
      "lucide-react",
    ],
    forbidNode: true,
  },
  {
    ruleId: "R8",
    dir: "packages/coach",
    srcOnly: true,
    allowedWorkspace: COMPOSITION_ROOT_ALLOWED,
    transitionalWorkspace: ["@enduragent/core"],
    forbidNode: false,
  },
  {
    ruleId: "R8",
    dir: "apps/desktop",
    srcOnly: true,
    allowedWorkspace: DESKTOP_APP_ALLOWED,
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R-BIN",
    dir: "packages/cycling-coach",
    srcOnly: true,
    allowedWorkspace: LEGACY_BINARY_ALLOWED,
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R-BIN",
    dir: "packages/running-coach",
    srcOnly: true,
    allowedWorkspace: LEGACY_BINARY_ALLOWED,
    transitionalWorkspace: [],
    forbidNode: false,
  },
  {
    ruleId: "R-BIN",
    dir: "packages/duathlon-coach",
    srcOnly: true,
    allowedWorkspace: LEGACY_BINARY_ALLOWED,
    transitionalWorkspace: [],
    forbidNode: false,
  },
];

const WORKSPACE_SCOPE = "@enduragent/";
const SKIP_DIRECTIVE = "package-deps-lint:skip-file";
const isSkippedFile = makeSkipCheck(SKIP_DIRECTIVE);

export interface PackageDepViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly ruleId: string;
  readonly specifier: string;
  readonly pkg: string;
}

export interface TransitionalEdge {
  readonly dir: string;
  readonly target: string;
}

export interface RunResult {
  readonly violations: readonly PackageDepViolation[];
  readonly warnEdges: readonly TransitionalEdge[];
  readonly scannedFileCount: number;
  readonly notPresent: readonly string[];
}

interface SpecifierRef {
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
}

function isNodeSpecifier(spec: string): boolean {
  return spec.startsWith("node:") || isBuiltin(spec);
}

/** Root package name for an `@enduragent/*` specifier (drops any subpath). */
export function packageRoot(spec: string): string {
  return spec.split("/").slice(0, 2).join("/");
}

/**
 * Does `spec` match an allowlist entry? A plain root entry `@enduragent/x`
 * allows the root and any subpath; a subpath entry `@enduragent/x/y` allows
 * exactly that subpath and deeper (never the root); a `*`-suffixed glob entry
 * `@enduragent/sport-*` matches `@enduragent/sport-<anything>` and its subpaths.
 */
export function matchesEntry(spec: string, entry: string): boolean {
  if (entry.endsWith("*")) {
    const base = entry.slice(0, -1);
    return spec.startsWith(base) && spec.length > base.length;
  }
  return spec === entry || spec.startsWith(entry + "/");
}

function classifySourceWorkspace(
  spec: string,
  rule: PackageDepRule,
): "allowed" | "transitional" | "violation" {
  if (rule.allowedWorkspace.some((e) => matchesEntry(spec, e))) return "allowed";
  if (rule.transitionalWorkspace.some((e) => matchesEntry(spec, e))) return "transitional";
  return "violation";
}

function classifyManifestWorkspace(
  name: string,
  rule: PackageDepRule,
): "allowed" | "transitional" | "violation" {
  const allowed = rule.allowedManifestWorkspace ?? rule.allowedWorkspace;
  if (allowed.some((entry) => matchesEntry(name, entry))) return "allowed";
  if (rule.transitionalWorkspace.some((entry) => matchesEntry(name, entry))) return "transitional";
  return "violation";
}

function collectSpecifiers(file: string): SpecifierRef[] {
  const source = readFileSync(file, "utf-8");
  if (isSkippedFile(source)) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /*setParentNodes*/ true);
  const refs: SpecifierRef[] = [];

  function record(node: ts.Node, specifier: string): void {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    refs.push({ line: lc.line + 1, column: lc.character + 1, specifier });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) record(arg, arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return refs;
}

interface ManifestDep {
  readonly name: string;
  readonly block: string;
  readonly version: unknown;
}

function readManifestDeps(
  fsDir: string,
  ruleId: string,
): {
  deps: ManifestDep[];
  present: boolean;
  packageName: string;
  packageVersion: string;
  packageExports: Record<string, unknown>;
} {
  const manifestPath = join(fsDir, "package.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch {
    return { deps: [], present: false, packageName: "", packageVersion: "", packageExports: {} };
  }
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const blocks =
    ruleId === "R1"
      ? ["dependencies", "peerDependencies", "devDependencies"]
      : ["dependencies", "peerDependencies"];
  const deps: ManifestDep[] = [];
  for (const block of blocks) {
    const entry = pkg[block];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    for (const [name, version] of Object.entries(entry)) deps.push({ name, block, version });
  }
  const packageExports =
    pkg.exports !== null && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)
      ? (pkg.exports as Record<string, unknown>)
      : {};
  return {
    deps,
    present: true,
    packageName: typeof pkg.name === "string" ? pkg.name : "",
    packageVersion: typeof pkg.version === "string" ? pkg.version : "",
    packageExports,
  };
}

interface ConcreteDir {
  readonly dir: string;
  readonly fsDir: string;
}

interface WorkspacePackage {
  readonly fsDir: string;
  readonly name: string;
  readonly exports: Record<string, unknown>;
}

function workspacePackages(root: string): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const group of ["packages", "apps"]) {
    const parent = join(root, group);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fsDir = resolve(parent, entry.name);
      const manifest = readManifestDeps(fsDir, "");
      if (manifest.packageName.startsWith(WORKSPACE_SCOPE)) {
        packages.push({ fsDir, name: manifest.packageName, exports: manifest.packageExports });
      }
    }
  }
  return packages;
}

function modulePath(path: string): string {
  return path
    .replaceAll(sep, "/")
    .replace(/^\.\//, "")
    .replace(/^(?:src|dist)\//, "")
    .replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function publishedImportAllowed(
  lockfile: unknown,
  importer: string,
  fsDir: string,
  specifier: string,
  deps: readonly ManifestDep[],
): boolean {
  const name = packageRoot(specifier);
  const declared = deps.filter((dependency) => dependency.name === name);
  if (declared.length === 0) return false;
  const installed = readManifestDeps(join(fsDir, "node_modules", name), "");
  if (
    installed.packageName !== name ||
    !declared.every(
      (dependency) =>
        typeof dependency.version === "string" &&
        uiReleaseVersion(dependency.version) === installed.packageVersion &&
        uiReleaseLockMatches(lockfile, importer, dependency.version, installed.packageVersion),
    )
  )
    return false;
  const exportKey = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  return (
    Object.hasOwn(installed.packageExports, exportKey) &&
    exportTargets(installed.packageExports[exportKey]).length > 0
  );
}

function relativeWorkspaceSpecifier(
  file: string,
  specifier: string,
  ownerDir: string,
  packages: readonly WorkspacePackage[],
): string | undefined {
  const target = resolve(dirname(file), specifier);
  const owner = packages.find((pkg) => target === pkg.fsDir || target.startsWith(pkg.fsDir + sep));
  if (!owner || owner.fsDir === resolve(ownerDir)) return undefined;
  const targetPath = modulePath(relative(owner.fsDir, target));
  for (const [key, value] of Object.entries(owner.exports)) {
    if (!key.startsWith("./")) continue;
    if (
      exportTargets(value).some((entry) => {
        const entryPath = modulePath(entry);
        return (
          entryPath === targetPath || (ext(target) === "" && entryPath === `${targetPath}/index`)
        );
      })
    ) {
      return owner.name + key.slice(1);
    }
  }
  return owner.name;
}

function expandRuleDirs(root: string, rule: PackageDepRule): ConcreteDir[] {
  if (rule.dir.includes("*")) {
    const parent = dirname(rule.dir);
    const prefix = basename(rule.dir).slice(0, -1);
    let entries: string[];
    try {
      entries = readdirSync(join(root, parent));
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.startsWith(prefix))
      .map((e) => ({ dir: join(parent, e), fsDir: join(root, parent, e) }))
      .filter((c) => {
        try {
          return statSync(c.fsDir).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }
  const fsDir = join(root, rule.dir);
  return existsSync(fsDir) ? [{ dir: rule.dir, fsDir }] : [];
}

/** Run the RULES table against a repo root (real repo or an injected fixture tree). */
export function runRulesAgainst(root: string, rules: readonly PackageDepRule[]): RunResult {
  const violations: PackageDepViolation[] = [];
  const warnSet = new Map<string, TransitionalEdge>();
  const notPresent: string[] = [];
  let scannedFileCount = 0;
  const packages = workspacePackages(root);
  const releaseLock = readUiReleaseLock(root);

  const recordWarn = (dir: string, target: string): void => {
    const key = `${dir} -> ${target}`;
    if (!warnSet.has(key)) warnSet.set(key, { dir, target });
  };

  for (const rule of rules) {
    const concrete = expandRuleDirs(root, rule);
    if (concrete.length === 0) {
      notPresent.push(rule.dir);
      continue;
    }
    for (const { dir, fsDir } of concrete) {
      const { deps, packageName, packageExports } = readManifestDeps(fsDir, rule.ruleId);

      // (1) AST import walk over the scan root.
      const scanRoot = rule.srcOnly ? join(fsDir, "src") : fsDir;
      const files: string[] = [];
      collectFiles(scanRoot, files);
      for (const file of files) {
        if (!TS_EXTS.has(ext(file))) continue;
        scannedFileCount++;
        for (const ref of collectSpecifiers(file)) {
          const isRelative = ref.specifier.startsWith("./") || ref.specifier.startsWith("../");
          const spec = isRelative
            ? relativeWorkspaceSpecifier(file, ref.specifier, fsDir, packages)
            : ref.specifier;
          if (spec === undefined) continue;
          if (isNodeSpecifier(spec)) {
            if (rule.forbidNode) {
              violations.push({
                file,
                line: ref.line,
                column: ref.column,
                ruleId: rule.ruleId,
                specifier: ref.specifier,
                pkg: dir,
              });
            }
            continue;
          }
          if (rule.allowedPublished?.includes(packageRoot(spec))) {
            if (!publishedImportAllowed(releaseLock, dir, fsDir, spec, deps)) {
              violations.push({
                file,
                line: ref.line,
                column: ref.column,
                ruleId: rule.ruleId,
                specifier: ref.specifier,
                pkg: dir,
              });
            }
            continue;
          }
          if (spec.startsWith(WORKSPACE_SCOPE)) {
            const isSelfReference = packageRoot(spec) === packageName;
            if (isSelfReference) {
              const exportKey = spec === packageName ? null : `.${spec.slice(packageName.length)}`;
              const isDeclaredPublicSubpath =
                exportKey !== null &&
                Object.prototype.hasOwnProperty.call(packageExports, exportKey) &&
                packageExports[exportKey] !== null;
              if (isDeclaredPublicSubpath) continue;
              violations.push({
                file,
                line: ref.line,
                column: ref.column,
                ruleId: rule.ruleId,
                specifier: ref.specifier,
                pkg: dir,
              });
              continue;
            }
            const verdict = classifySourceWorkspace(spec, rule);
            if (verdict === "allowed") continue;
            if (verdict === "transitional") {
              recordWarn(dir, packageRoot(spec));
              continue;
            }
            violations.push({
              file,
              line: ref.line,
              column: ref.column,
              ruleId: rule.ruleId,
              specifier: ref.specifier,
              pkg: dir,
            });
            continue;
          }
          if (
            rule.allowedExternal === undefined ||
            rule.allowedExternal.some((entry) => matchesEntry(spec, entry))
          ) {
            continue;
          }
          violations.push({
            file,
            line: ref.line,
            column: ref.column,
            ruleId: rule.ruleId,
            specifier: spec,
            pkg: dir,
          });
        }
      }

      // (2) Manifest check over declared runtime dependency edges.
      const manifestFile = join(dir, "package.json");
      for (const { name } of deps) {
        if (rule.allowedPublished?.includes(name)) {
          if (!publishedImportAllowed(releaseLock, dir, fsDir, name, deps)) {
            violations.push({
              file: manifestFile,
              line: 1,
              column: 1,
              ruleId: rule.ruleId,
              specifier: name,
              pkg: dir,
            });
          }
          continue;
        }
        if (name.startsWith(WORKSPACE_SCOPE)) {
          const verdict = classifyManifestWorkspace(name, rule);
          if (verdict === "allowed") continue;
          if (verdict === "transitional") {
            recordWarn(dir, packageRoot(name));
            continue;
          }
          violations.push({
            file: manifestFile,
            line: 1,
            column: 1,
            ruleId: rule.ruleId,
            specifier: name,
            pkg: dir,
          });
          continue;
        }
        if (
          rule.allowedExternal === undefined ||
          rule.allowedExternal.some((entry) => matchesEntry(name, entry))
        )
          continue;
        violations.push({
          file: manifestFile,
          line: 1,
          column: 1,
          ruleId: rule.ruleId,
          specifier: name,
          pkg: dir,
        });
      }
    }
  }

  const warnEdges = [...warnSet.values()].sort((a, b) =>
    `${a.dir} -> ${a.target}`.localeCompare(`${b.dir} -> ${b.target}`),
  );
  return { violations, warnEdges, scannedFileCount, notPresent };
}

export interface PrivateViolation {
  readonly file: string;
  readonly name: string;
}

/** R7: every `@enduragent/*`-named workspace manifest must be `"private": true`. */
export function checkPrivatePackages(root: string): PrivateViolation[] {
  const out: PrivateViolation[] = [];
  for (const group of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const manifestPath = join(root, group, entry, "package.json");
      let pkg: { name?: string; private?: boolean };
      try {
        pkg = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          name?: string;
          private?: boolean;
        };
      } catch {
        continue;
      }
      if (
        typeof pkg.name === "string" &&
        pkg.name.startsWith(WORKSPACE_SCOPE) &&
        pkg.private !== true
      ) {
        out.push({ file: join(group, entry, "package.json"), name: pkg.name });
      }
    }
  }
  return out;
}

function remediation(v: PackageDepViolation): string {
  const rule = RULES.find((r) => r.dir === v.pkg || (r.dir.includes("*") && r.ruleId === v.ruleId));
  const allowed = rule
    ? [...rule.allowedWorkspace, ...rule.transitionalWorkspace, ...(rule.allowedPublished ?? [])]
    : [];
  const allowedText = allowed.length > 0 ? allowed.join(", ") : "(nothing from the workspace)";
  const nodeText = rule?.forbidNode ? " and no host builtins (node:* / bare builtins)" : "";
  return `  ${v.pkg} may import only: ${allowedText}${nodeText}.`;
}

export function main(argv: readonly string[]): number {
  const args = nonFlagArgs(argv);
  const root = args[0] ?? ".";

  const result = runRulesAgainst(root, RULES);
  const privateViolations = checkPrivatePackages(root);

  for (const dir of result.notPresent) {
    console.log(`check-package-deps: ${dir} (not present yet)`);
  }
  for (const edge of result.warnEdges) {
    console.error(
      `WARN: transitional workspace edge: ${edge.dir} -> ${edge.target} (allowlisted transitional dependency)`,
    );
  }

  const hasViolations = result.violations.length > 0 || privateViolations.length > 0;
  if (!hasViolations) {
    console.log(
      `check-package-deps: ${result.scannedFileCount} source file(s) across the governed package graph clean.`,
    );
    return 0;
  }

  console.error(
    `check-package-deps: ${result.violations.length + privateViolations.length} forbidden package edge(s) found:`,
  );
  for (const v of result.violations) {
    console.error(
      `  ${v.file}:${v.line}:${v.column}  ${v.ruleId}: forbidden import "${v.specifier}" from ${v.pkg}`,
    );
    console.error(remediation(v));
  }
  for (const pv of privateViolations) {
    console.error(
      `  ${pv.file}:1:1  R7: ${pv.name} is @enduragent/*-named but not "private": true`,
    );
  }
  return 1;
}

runGateCli(import.meta.url, main);
