import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

export const REVIEWED_LICENSE_EXPRESSIONS = ["Apache-2.0", "BSD-2-Clause", "ISC", "MIT"] as const;

const reviewedLicenses = new Set<string>(REVIEWED_LICENSE_EXPRESSIONS);
const packageEntryMarker = "----- PACKAGE -----";
const packageEndMarker = "----- END PACKAGE -----";

interface MetafileOutput {
  inputs?: Record<string, unknown>;
  imports?: Array<{ path: string; kind: string; external?: boolean }>;
}

export interface BuildMetafile {
  outputs: Record<string, MetafileOutput>;
}

export interface ThirdPartyPackage {
  id: string;
  name: string;
  version: string;
  license: string;
  packageRoot: string;
  licenseFiles: Array<{ name: string; text: string }>;
  noticeFiles: Array<{ name: string; text: string }>;
  override?: { name: string; text: string };
}

export interface LegalArtifactPaths {
  packageRoot: string;
  repoRoot: string;
  inputRoot: string;
  metafilePath: string;
  distDir: string;
  apacheLicensePath: string;
  overridesDir: string;
}

function defaultPaths(): LegalArtifactPaths {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(packageRoot, "../..");
  return {
    packageRoot,
    repoRoot,
    inputRoot: repoRoot,
    metafilePath: resolve(packageRoot, "dist/metafile-esm.json"),
    distDir: resolve(packageRoot, "dist"),
    apacheLicensePath: resolve(packageRoot, "build/license-texts/Apache-2.0.txt"),
    overridesDir: resolve(packageRoot, "build/license-overrides"),
  };
}

function readText(path: string): string {
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) {
    throw new Error(`Legal material is empty: ${path}`);
  }
  return text.replace(/\r\n/g, "\n").trimEnd();
}

function findPackageRoot(inputPath: string, inputRoot: string): string | null {
  const absoluteInput = resolve(inputRoot, inputPath);
  if (!absoluteInput.split(/[\\/]/).includes("node_modules")) return null;

  let current = dirname(absoluteInput);
  const filesystemRoot = parse(current).root;
  while (current !== filesystemRoot) {
    const parent = dirname(current);
    const isPackageBoundary =
      basename(parent) === "node_modules" ||
      (basename(dirname(parent)) === "node_modules" && basename(parent).startsWith("@"));
    if (isPackageBoundary) {
      const manifestPath = resolve(current, "package.json");
      if (!existsSync(manifestPath)) return null;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      return typeof manifest.name === "string" && typeof manifest.version === "string"
        ? current
        : null;
    }
    current = parent;
  }
  return null;
}

function contributingPackageRoot(input: string, inputRoot: string): string | null {
  const absoluteInput = resolve(inputRoot, input);
  if (!absoluteInput.split(/[\\/]/).includes("node_modules")) return null;

  const dependencyRoot = findPackageRoot(input, inputRoot);
  if (!dependencyRoot) {
    throw new Error(`Cannot resolve contributing third-party package root: ${input}`);
  }
  return dependencyRoot;
}

function packageIdentity(dependencyRoot: string): { name: string; version: string; id: string } {
  const manifest = JSON.parse(readFileSync(resolve(dependencyRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`Contributing package has invalid identity: ${dependencyRoot}`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    id: `${manifest.name}@${manifest.version}`,
  };
}

function requiredOutput(metafile: BuildMetafile, output: string): MetafileOutput {
  const matchedOutputs = Object.entries(metafile.outputs).filter(([path]) => {
    const normalized = path.replaceAll("\\", "/");
    return normalized === output || normalized.endsWith(`/${output}`);
  });
  const matchedOutput = matchedOutputs.length === 1 ? matchedOutputs[0][1] : undefined;
  if (!matchedOutput) {
    throw new Error(`Metafile does not describe the required ${output} output`);
  }
  return matchedOutput;
}

export function assertOnlyNodeBuiltinExternals(
  metafile: BuildMetafile,
  output = "dist/index.js",
): string[] {
  const externals = (requiredOutput(metafile, output).imports ?? []).filter(
    (entry) => entry.external === true,
  );
  const unexpected = externals
    .filter((entry) => !isBuiltin(entry.path))
    .map((entry) => `${entry.path} (${entry.kind})`);
  if (unexpected.length > 0) {
    throw new Error(`Bundle contains non-Node external imports: ${unexpected.join(", ")}`);
  }
  return [...new Set(externals.map((entry) => `${entry.path} (${entry.kind})`))].sort();
}

export function contributingInputs(metafile: BuildMetafile, output = "dist/index.js"): string[] {
  const matchedOutput = requiredOutput(metafile, output);
  if (!matchedOutput.inputs) {
    throw new Error(`Metafile does not describe the required ${output} inputs`);
  }
  return Object.keys(matchedOutput.inputs).sort();
}

export function overrideFilename(name: string, version: string): string {
  return `${name.replaceAll("/", "+")}@${version}.txt`;
}

export function contributingThirdPartyPackageIds(
  metafile: BuildMetafile,
  packageRoot: string,
): string[] {
  const ids = new Set<string>();
  for (const input of contributingInputs(metafile)) {
    const dependencyRoot = contributingPackageRoot(input, packageRoot);
    if (!dependencyRoot) continue;
    ids.add(packageIdentity(dependencyRoot).id);
  }
  return [...ids].sort();
}

function materialFiles(
  packageRoot: string,
  pattern: RegExp,
): Array<{ name: string; text: string }> {
  return readdirSync(packageRoot)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => {
      const path = resolve(packageRoot, name);
      return statSync(path).isFile() ? { name, text: readText(path) } : null;
    })
    .filter((entry): entry is { name: string; text: string } => entry !== null);
}

export function collectThirdPartyPackages(
  metafile: BuildMetafile,
  paths: Pick<LegalArtifactPaths, "inputRoot" | "overridesDir">,
): ThirdPartyPackage[] {
  const packages = new Map<string, ThirdPartyPackage>();

  for (const input of contributingInputs(metafile)) {
    const dependencyRoot = contributingPackageRoot(input, paths.inputRoot);
    if (!dependencyRoot) continue;

    const manifest = JSON.parse(readFileSync(resolve(dependencyRoot, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      license?: unknown;
    };
    const { name, version, id } = packageIdentity(dependencyRoot);
    if (typeof manifest.license !== "string") {
      throw new Error(`Missing declared license expression for ${id}`);
    }
    if (!reviewedLicenses.has(manifest.license)) {
      throw new Error(`Unreviewed license expression for ${id}: ${manifest.license}`);
    }
    if (packages.has(id)) continue;

    const licenseFiles = materialFiles(dependencyRoot, /^(?:licen[cs]e|copying)(?:[._-].*)?$/i);
    const noticeFiles = materialFiles(
      dependencyRoot,
      /^(?:notice|authors|attribution)(?:[._-].*)?$/i,
    );
    const overrideName = overrideFilename(name, version);
    const overridePath = resolve(paths.overridesDir, overrideName);
    const override = existsSync(overridePath)
      ? { name: overrideName, text: readText(overridePath) }
      : undefined;

    if (override && licenseFiles.length > 0) {
      throw new Error(
        `Exact-version override conflicts with discovered license material for ${id}`,
      );
    }
    if (licenseFiles.length === 0 && !override) {
      throw new Error(`Missing license material for ${id}`);
    }

    packages.set(id, {
      id,
      name,
      version,
      license: manifest.license,
      packageRoot: dependencyRoot,
      licenseFiles,
      noticeFiles,
      override,
    });
  }

  return [...packages.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function section(label: string, name: string, text: string): string {
  return `${label}: ${name}\n\n${text}`;
}

function apachePackageSpecificText(packageText: string, canonicalText: string): string {
  const canonicalLines = new Set(
    canonicalText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const packageLines = packageText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !canonicalLines.has(line));
  return [...new Set(packageLines)].join("\n");
}

export function renderAggregate(packages: ThirdPartyPackage[], apacheLicenseText: string): string {
  const canonicalApacheText = apacheLicenseText.trimEnd();
  const parts = [
    "THIRD-PARTY LICENSES AND NOTICES",
    "Generated from the exact inputs contributing to dist/index.js.",
  ];

  if (packages.some((entry) => entry.license === "Apache-2.0")) {
    parts.push(
      [
        "===== CANONICAL LICENSE: Apache-2.0 =====",
        canonicalApacheText,
        "===== END CANONICAL LICENSE =====",
      ].join("\n\n"),
    );
  }

  for (const entry of packages) {
    const entryParts = [packageEntryMarker, `Package: ${entry.id}`, `License: ${entry.license}`];

    if (entry.license === "Apache-2.0") {
      entryParts.push("License text: canonical Apache-2.0 text above");
      for (const file of entry.licenseFiles) {
        const packageSpecificText = apachePackageSpecificText(file.text, canonicalApacheText);
        if (packageSpecificText.length > 0) {
          entryParts.push(section("Package notice", file.name, packageSpecificText));
        }
      }
    } else {
      for (const file of entry.licenseFiles) {
        entryParts.push(section("License text", file.name, file.text));
      }
    }

    if (entry.override) {
      entryParts.push(section("Exact-version override", entry.override.name, entry.override.text));
    }
    for (const file of entry.noticeFiles) {
      entryParts.push(section("Notice", file.name, file.text));
    }
    entryParts.push(packageEndMarker);
    parts.push([entryParts.slice(0, 3).join("\n"), ...entryParts.slice(3)].join("\n\n"));
  }

  return `${parts.join("\n\n")}\n`;
}

export function parseAggregatePackageIds(aggregate: string): string[] {
  const ids: string[] = [];
  const lines = aggregate.split("\n");
  let apacheEntries = 0;
  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === packageEndMarker) {
      throw new Error("Unmatched third-party package entry terminator");
    }
    if (line !== packageEntryMarker) {
      if (line.startsWith("Package: ") || line.startsWith("License: ")) {
        throw new Error("Third-party package field appears outside an entry");
      }
      cursor += 1;
      continue;
    }

    const end = lines.indexOf(packageEndMarker, cursor + 1);
    const nestedStart = lines.indexOf(packageEntryMarker, cursor + 1);
    if (end === -1) throw new Error("Unterminated third-party package entry");
    if (nestedStart !== -1 && nestedStart < end) {
      throw new Error("Malformed nested third-party package entry");
    }

    const packageLine = lines[cursor + 1];
    const licenseLine = lines[cursor + 2];
    if (!packageLine?.startsWith("Package: ") || !licenseLine?.startsWith("License: ")) {
      throw new Error("Malformed third-party package entry header");
    }
    const id = packageLine.slice("Package: ".length);
    const license = licenseLine.slice("License: ".length);
    if (id.length === 0) throw new Error("Malformed third-party package entry");
    if (!reviewedLicenses.has(license)) {
      throw new Error(
        `Unreviewed license expression in third-party aggregate for ${id}: ${license}`,
      );
    }

    const body = lines.slice(cursor + 3, end);
    if (
      body.some((bodyLine) => bodyLine.startsWith("Package: ") || bodyLine.startsWith("License: "))
    ) {
      throw new Error(`Duplicate package field in third-party aggregate for ${id}`);
    }
    const hasLicenseMaterial = body.some((bodyLine, index) => {
      if (bodyLine === "License text: canonical Apache-2.0 text above") {
        return license === "Apache-2.0";
      }
      if (
        !bodyLine.startsWith("License text: ") &&
        !bodyLine.startsWith("Exact-version override: ")
      ) {
        return false;
      }
      const followingLines = body.slice(index + 1);
      const nextSection = followingLines.findIndex((materialLine) =>
        /^(?:License text|Exact-version override|Package notice|Notice): /.test(materialLine),
      );
      const materialLines =
        nextSection === -1 ? followingLines : followingLines.slice(0, nextSection);
      return materialLines.some((materialLine) => materialLine.trim().length > 0);
    });
    if (!hasLicenseMaterial) {
      throw new Error(`Missing legal material in third-party aggregate for ${id}`);
    }

    ids.push(id);
    if (license === "Apache-2.0") apacheEntries += 1;
    cursor = end + 1;
  }

  const canonicalStarts = lines.filter(
    (line) => line === "===== CANONICAL LICENSE: Apache-2.0 =====",
  ).length;
  const canonicalEnds = lines.filter((line) => line === "===== END CANONICAL LICENSE =====").length;
  const canonicalStartIndex = lines.indexOf("===== CANONICAL LICENSE: Apache-2.0 =====");
  const canonicalEndIndex = lines.indexOf("===== END CANONICAL LICENSE =====");
  const hasCanonicalBody =
    canonicalStartIndex !== -1 &&
    canonicalEndIndex > canonicalStartIndex &&
    lines
      .slice(canonicalStartIndex + 1, canonicalEndIndex)
      .some((canonicalLine) => canonicalLine.trim().length > 0);
  if (
    (apacheEntries > 0 && (canonicalStarts !== 1 || canonicalEnds !== 1 || !hasCanonicalBody)) ||
    (apacheEntries === 0 && (canonicalStarts !== 0 || canonicalEnds !== 0))
  ) {
    throw new Error("Malformed canonical Apache-2.0 license section");
  }
  return ids;
}

export function assertAggregateMatchesGraph(aggregateIds: string[], graphIds: string[]): void {
  const normalizedAggregate = [...aggregateIds].sort();
  const normalizedGraph = [...new Set(graphIds)].sort();
  if (
    normalizedAggregate.length !== aggregateIds.length ||
    JSON.stringify(normalizedAggregate) !== JSON.stringify(normalizedGraph)
  ) {
    throw new Error(
      `Third-party aggregate does not match bundle graph: aggregate=${normalizedAggregate.join(",")} graph=${normalizedGraph.join(",")}`,
    );
  }
}

export async function generateLegalArtifacts(
  pathOverrides: Partial<LegalArtifactPaths> = {},
): Promise<void> {
  const paths = { ...defaultPaths(), ...pathOverrides };
  const rootLicense = resolve(paths.repoRoot, "LICENSE");
  const rootNotice = resolve(paths.repoRoot, "NOTICE.md");
  if (!existsSync(rootLicense)) throw new Error("Canonical root LICENSE is missing");
  if (!existsSync(rootNotice)) throw new Error("Canonical root NOTICE.md is missing");
  if (!existsSync(paths.metafilePath)) {
    throw new Error(`Build metafile is missing: ${paths.metafilePath}`);
  }

  const metafile = JSON.parse(readFileSync(paths.metafilePath, "utf8")) as BuildMetafile;
  const externals = assertOnlyNodeBuiltinExternals(metafile);
  console.log(`Bundle externals (Node built-ins): ${externals.join(", ") || "(none)"}`);
  const graphIds = contributingThirdPartyPackageIds(metafile, paths.inputRoot);
  const packages = collectThirdPartyPackages(metafile, paths);
  if (packages.length === 0) {
    throw new Error("Bundle graph contains no third-party packages");
  }
  const apacheLicenseText = readText(paths.apacheLicensePath);
  const aggregate = renderAggregate(packages, apacheLicenseText);
  assertAggregateMatchesGraph(parseAggregatePackageIds(aggregate), graphIds);

  copyFileSync(rootLicense, resolve(paths.distDir, "LICENSE"));
  copyFileSync(rootNotice, resolve(paths.distDir, "NOTICE.md"));
  writeFileSync(resolve(paths.distDir, "THIRD_PARTY_LICENSES.txt"), aggregate, "utf8");
  rmSync(paths.metafilePath);
}
