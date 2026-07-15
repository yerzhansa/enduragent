#!/usr/bin/env tsx

import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAggregatePackageIds } from "../packages/cycling-coach/build/legal-artifacts.js";

const requiredFiles = [
  "package/dist/index.js",
  "package/dist/index.js.map",
  "package/dist/LICENSE",
  "package/dist/NOTICE.md",
  "package/dist/THIRD_PARTY_LICENSES.txt",
  "package/README.md",
  "package/package.json",
];

interface PackedManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
}

interface NpmTreeNode {
  dependencies?: Record<string, NpmTreeNode>;
}

export interface PublishedPackageEvidence {
  nodeVersion: string;
  compressedBytes: number;
  unpackedBytes: number;
  installedBytes: number;
  globalPackageCount: number;
}

export function readTarGz(path: string): Map<string, Buffer> {
  const archive = gunzipSync(readFileSync(path));
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readString(124, 12).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size)) {
      throw new Error(`Invalid tar entry size for ${fullName}`);
    }
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    if (type === "0" || type === "\0") {
      entries.set(fullName.replace(/^\.\//, ""), archive.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function requiredEntry(entries: Map<string, Buffer>, path: string): Buffer {
  const entry = entries.get(path);
  if (!entry) throw new Error(`Published package is missing ${path}`);
  return entry;
}

function packedManifest(entries: Map<string, Buffer>): PackedManifest {
  try {
    return JSON.parse(
      requiredEntry(entries, "package/package.json").toString("utf8"),
    ) as PackedManifest;
  } catch (error) {
    throw new Error("Published package has an invalid package.json", { cause: error });
  }
}

function assertNoRuntimeDependencyFields(manifest: PackedManifest): void {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    if (Object.hasOwn(manifest, field)) {
      throw new Error(`Published package declares runtime field: ${field}`);
    }
  }
}

function generatedLocationText(path: string, text: string): string {
  if (!path.endsWith(".map")) return text;
  try {
    const sourceMap = JSON.parse(text) as {
      file?: unknown;
      sourceRoot?: unknown;
      sources?: unknown;
    };
    return JSON.stringify({
      file: sourceMap.file,
      sourceRoot: sourceMap.sourceRoot,
      sources: sourceMap.sources,
    });
  } catch {
    return text;
  }
}

export function verifyTarEntries(entries: Map<string, Buffer>, repoRoot: string): void {
  for (const path of requiredFiles) requiredEntry(entries, path);

  const absoluteBuildPath =
    /\/(?:Users|home)\/[^/\s]+\/|\/(?:private\/)?(?:tmp|var\/folders)\/|\/(?:app|workspace)\/|[A-Za-z]:\\{1,2}(?:Users|workspace|a|agent|build)\\{1,2}/;
  const forwardSlashRepoRoot = repoRoot.replaceAll("\\", "/");
  const backslashRepoRoot = forwardSlashRepoRoot.replaceAll("/", "\\");
  const buildRootVariants = [
    repoRoot,
    forwardSlashRepoRoot,
    backslashRepoRoot,
    backslashRepoRoot.replaceAll("\\", "\\\\"),
  ];
  for (const [path, contents] of entries) {
    const text = contents.toString("utf8");
    const locations = generatedLocationText(path, text);
    if (
      absoluteBuildPath.test(path) ||
      absoluteBuildPath.test(locations) ||
      buildRootVariants.some((buildRoot) => path.includes(buildRoot) || text.includes(buildRoot))
    ) {
      throw new Error(`Published package contains an absolute build path in ${path}`);
    }
  }

  const forbiddenPath = [...entries.keys()].find(
    (path) =>
      /(?:^|\/)metafile(?:-[^/]*)?\.json$/i.test(path) ||
      path.startsWith("package/build/") ||
      path.includes("/build/license-") ||
      path.startsWith("package/node_modules/"),
  );
  if (forbiddenPath) {
    throw new Error(`Published package contains build-only path: ${forbiddenPath}`);
  }

  assertNoRuntimeDependencyFields(packedManifest(entries));

  const distLicense = requiredEntry(entries, "package/dist/LICENSE");
  const distNotice = requiredEntry(entries, "package/dist/NOTICE.md");
  if (!distLicense.equals(readFileSync(resolve(repoRoot, "LICENSE")))) {
    throw new Error("Published dist/LICENSE differs from canonical root LICENSE");
  }
  if (!distNotice.equals(readFileSync(resolve(repoRoot, "NOTICE.md")))) {
    throw new Error("Published dist/NOTICE.md differs from canonical root NOTICE.md");
  }

  const aggregate = requiredEntry(entries, "package/dist/THIRD_PARTY_LICENSES.txt").toString(
    "utf8",
  );
  if (aggregate.trim().length === 0) {
    throw new Error("Published third-party aggregate is empty");
  }
  const ids = parseAggregatePackageIds(aggregate);
  if (ids.length === 0) {
    throw new Error("Published third-party aggregate has no package entries");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Published third-party aggregate has duplicate package entries");
  }
  const sortedIds = [...ids].sort();
  if (JSON.stringify(ids) !== JSON.stringify(sortedIds)) {
    throw new Error("Published third-party aggregate is not deterministically ordered");
  }
  if (aggregate.includes("\nLicense: Apache-2.0\n")) {
    const startMarker = "===== CANONICAL LICENSE: Apache-2.0 =====\n\n";
    const endMarker = "\n\n===== END CANONICAL LICENSE =====";
    const start = aggregate.indexOf(startMarker);
    const end = aggregate.indexOf(endMarker, start + startMarker.length);
    const canonicalText =
      start === -1 || end === -1 ? "" : aggregate.slice(start + startMarker.length, end);
    const pinnedText = readFileSync(
      resolve(repoRoot, "packages/cycling-coach/build/license-texts/Apache-2.0.txt"),
      "utf8",
    ).trimEnd();
    if (canonicalText !== pinnedText) {
      throw new Error("Published canonical Apache-2.0 text differs from the reviewed source");
    }
  }
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`Package: ${escaped}\\nLicense: [^\\n]+`).test(aggregate)) {
      throw new Error(`Malformed third-party aggregate entry for ${id}`);
    }
  }
}

export function extractPackage(entries: Map<string, Buffer>, destination: string): string {
  const packageRoot = resolve(destination, "package");
  for (const [path, contents] of entries) {
    if (!path.startsWith("package/")) continue;
    const relativePath = path.slice("package/".length);
    const archiveAbsolute =
      isAbsolute(relativePath) ||
      /^[A-Za-z]:[\\/]/.test(relativePath) ||
      /^\\\\/.test(relativePath);
    const output = resolve(packageRoot, relativePath);
    const outputRelative = relative(packageRoot, output);
    if (
      archiveAbsolute ||
      outputRelative === ".." ||
      outputRelative.startsWith(`..${sep}`) ||
      isAbsolute(outputRelative)
    ) {
      throw new Error(`Unsafe tar entry path: ${path}`);
    }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, contents);
  }
  return packageRoot;
}

function packageIdentity(manifest: PackedManifest): {
  name: string;
  version: string;
  binName: string;
} {
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string" ||
    manifest.version.trim().length === 0
  ) {
    throw new Error("Published package has an invalid name or version");
  }
  const binName =
    typeof manifest.bin === "object" && manifest.bin !== null
      ? Object.keys(manifest.bin).find(
          (name) => (manifest.bin as Record<string, unknown>)[name] === "dist/index.js",
        )
      : undefined;
  if (!binName) throw new Error("Published package has no dist/index.js binary");
  return { name: manifest.name, version: manifest.version, binName };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  return environment;
}

function run(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string {
  return execFileSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertCommandVersion(
  executable: string,
  leadingArgs: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  expected: string,
): void {
  run(executable, [...leadingArgs, "--help"], cwd, environment);
  const actual = run(executable, [...leadingArgs, "version"], cwd, environment).trim();
  if (actual !== expected) {
    throw new Error(`Published binary reported ${JSON.stringify(actual)}; expected ${expected}`);
  }
}

export function assertOnlyCliGloballyInstalled(tree: NpmTreeNode, packageName: string): number {
  const topLevel = Object.keys(tree.dependencies ?? {});
  if (topLevel.length !== 1 || topLevel[0] !== packageName) {
    throw new Error(`Global install contains unexpected packages: ${topLevel.sort().join(",")}`);
  }
  const nested = Object.keys(tree.dependencies?.[packageName]?.dependencies ?? {});
  if (nested.length > 0) {
    throw new Error(`Global CLI package contains runtime dependencies: ${nested.sort().join(",")}`);
  }
  return 1;
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else total += statSync(child).size;
  }
  return total;
}

function assertHostileModuleResolves(bundlePath: string, sentinelModulePath: string): void {
  const resolved = createRequire(pathToFileURL(bundlePath).href).resolve("encoding");
  if (realpathSync(resolved) !== realpathSync(sentinelModulePath)) {
    throw new Error(`Hostile encoding positive control resolved ${resolved}`);
  }
}

export function verifyPublishedPackage(
  tarballPath: string,
  repoRoot: string,
): PublishedPackageEvidence {
  const entries = readTarGz(tarballPath);
  verifyTarEntries(entries, repoRoot);
  const identity = packageIdentity(packedManifest(entries));
  const root = mkdtempSync(resolve(tmpdir(), "published-package-check-"));
  const prefix = resolve(root, "global-prefix");
  const directRoot = resolve(prefix, "lib/direct");
  const environment = {
    ...cleanEnvironment(),
    npm_config_cache: resolve(root, "npm-cache"),
    npm_config_update_notifier: "false",
  };

  try {
    const directPackage = extractPackage(entries, directRoot);
    if (existsSync(resolve(directPackage, "node_modules"))) {
      throw new Error("Direct extraction created node_modules");
    }
    const directBundle = resolve(directPackage, "dist/index.js");
    const expectedVersion = `${identity.name} v${identity.version}`;
    assertCommandVersion(
      process.execPath,
      [directBundle],
      directRoot,
      environment,
      expectedVersion,
    );

    run(
      "npm",
      [
        "install",
        "-g",
        tarballPath,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
      ],
      root,
      environment,
    );
    const globalRoot = run("npm", ["root", "-g", "--prefix", prefix], root, environment).trim();
    const inventory = JSON.parse(
      run("npm", ["ls", "-g", "--prefix", prefix, "--depth=Infinity", "--json"], root, environment),
    ) as NpmTreeNode;
    const globalPackageCount = assertOnlyCliGloballyInstalled(inventory, identity.name);
    const installedPackage = resolve(globalRoot, identity.name);
    const installedBytes = directoryBytes(installedPackage);
    const installedBin = resolve(
      prefix,
      process.platform === "win32" ? `${identity.binName}.cmd` : `bin/${identity.binName}`,
    );
    if (!existsSync(installedBin)) throw new Error(`Global install is missing ${installedBin}`);

    const sentinelPath = resolve(root, "encoding-loaded");
    const hostileRoot = resolve(globalRoot, "encoding");
    const hostileModule = resolve(hostileRoot, "index.js");
    mkdirSync(hostileRoot, { recursive: true });
    writeFileSync(
      resolve(hostileRoot, "package.json"),
      JSON.stringify({ name: "encoding", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(
      hostileModule,
      'require("node:fs").writeFileSync(process.env.CYCLING_COACH_ENCODING_SENTINEL, "loaded"); module.exports = {};\n',
    );
    const hostileEnvironment = {
      ...environment,
      CYCLING_COACH_ENCODING_SENTINEL: sentinelPath,
    };
    assertHostileModuleResolves(directBundle, hostileModule);
    const installedBundle = resolve(installedPackage, "dist/index.js");
    assertHostileModuleResolves(installedBundle, hostileModule);

    assertCommandVersion(
      process.execPath,
      [directBundle],
      directRoot,
      hostileEnvironment,
      expectedVersion,
    );
    if (existsSync(sentinelPath)) throw new Error("Direct bundle initialized ambient encoding");
    assertCommandVersion(installedBin, [], prefix, hostileEnvironment, expectedVersion);
    if (existsSync(sentinelPath)) throw new Error("Installed bundle initialized ambient encoding");

    return {
      nodeVersion: process.versions.node,
      compressedBytes: statSync(tarballPath).size,
      unpackedBytes: [...entries.values()].reduce((sum, contents) => sum + contents.length, 0),
      installedBytes,
      globalPackageCount,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const tarballPath = args[0];
  if (!tarballPath || args.length !== 1) {
    throw new Error("usage: pnpm check:published-package -- <package.tgz>");
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const evidence = verifyPublishedPackage(resolve(tarballPath), repoRoot);
  console.log(`Verified published package: ${tarballPath}`);
  console.log(
    `Package evidence: node=${evidence.nodeVersion} compressed=${evidence.compressedBytes} unpacked=${evidence.unpackedBytes} installed=${evidence.installedBytes} globalPackages=${evidence.globalPackageCount}`,
  );
}
