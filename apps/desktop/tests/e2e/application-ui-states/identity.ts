import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import {
  applicationBaselineForEnvironment,
  assertApplicationBaselineEnvironment,
  currentApplicationEnvironment,
  type ApplicationCaptureEnvironment,
} from "./baseline-environment.js";

export const applicationBaselineVersion = applicationBaselineForEnvironment(
  currentApplicationEnvironment(),
);

export const applicationProjects = {
  "compact-dark": { width: 760, height: 760, theme: "dark" },
  "compact-light": { width: 760, height: 760, theme: "light" },
  "wide-dark": { width: 1180, height: 820, theme: "dark" },
  "wide-light": { width: 1180, height: 820, theme: "light" },
} as const;

export const applicationScenarios = [
  "desktop--chat-empty",
  "desktop--chat-sync-failed",
  "desktop--chat-syncing",
  "desktop--settings-preferences",
  "desktop--training-loading",
] as const;

export interface FileSetIdentity {
  readonly fileCount: number;
  readonly sha256: string;
}

export interface SourceRevisionIdentity {
  readonly commit: string;
  readonly dirty: boolean;
}

export interface ApplicationBuildIdentity {
  readonly schemaVersion: 1;
  readonly environment: ApplicationCaptureEnvironment;
  readonly applicationSource: FileSetIdentity;
  readonly verificationSource: FileSetIdentity;
  readonly applicationBuild: FileSetIdentity & {
    readonly desktopVersion: string;
    readonly rendererVersion: string;
  };
  readonly uiPackage: FileSetIdentity & {
    readonly name: string;
    readonly version: string;
    readonly dependencySpecifier: string;
    readonly lockIntegrity: string;
    readonly lockResolution: string;
  };
  readonly electron: {
    readonly packageVersion: string;
    readonly executableSha256: string;
    readonly runtime: {
      readonly chrome: string;
      readonly electron: string;
      readonly node: string;
    };
  };
}

interface FileDigest {
  readonly path: string;
  readonly sha256: string;
}

const execFileAsync = promisify(execFile);
const repository = resolve(import.meta.dirname, "../../../../..");
const desktopRequire = createRequire(resolve(repository, "apps/desktop/package.json"));

function record(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${description} must be a nonempty string`);
  }
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function filesBelow(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== ".DS_Store")
      .map(async (entry): Promise<readonly string[]> => {
        const path = resolve(root, entry.name);
        return entry.isDirectory() ? filesBelow(path) : [path];
      }),
  );
  return nested.flat().sort();
}

async function inventory(
  roots: readonly string[],
  label: (path: string) => string = (path) => `./${relative(repository, path)}`,
): Promise<readonly FileDigest[]> {
  const files = await pathsIn(roots);
  if (files.length === 0) throw new Error("Identity inventory must not be empty");
  return Promise.all(
    files.map(async (path) => ({ path: label(path), sha256: await sha256(path) })),
  );
}

async function pathsIn(roots: readonly string[]): Promise<readonly string[]> {
  return (
    await Promise.all(
      roots.map(async (root) => {
        const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
        return entries === null ? [root] : filesBelow(root);
      }),
    )
  )
    .flat()
    .sort();
}

function applicationSourceRoots(input: {
  readonly desktopPackagePath: string;
  readonly lockPath: string;
  readonly rendererPackagePath: string;
}): readonly string[] {
  return [
    resolve(repository, "apps/desktop-renderer/src"),
    resolve(repository, "apps/desktop-renderer/index.html"),
    resolve(repository, "apps/desktop-renderer/tray.html"),
    resolve(repository, "apps/desktop-renderer/vite.config.ts"),
    input.rendererPackagePath,
    resolve(repository, "apps/desktop/src"),
    resolve(repository, "apps/desktop/electron.vite.config.ts"),
    input.desktopPackagePath,
    input.lockPath,
  ];
}

function fileSet(files: readonly FileDigest[]): FileSetIdentity {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.sha256).update("\n");
  return { fileCount: files.length, sha256: hash.digest("hex") };
}

async function packageJson(path: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await readFile(path, "utf8")), path);
}

function uiLockIdentity(lock: unknown): {
  readonly dependencySpecifier: string;
  readonly lockIntegrity: string;
  readonly lockResolution: string;
} {
  const root = record(lock, "pnpm lockfile");
  const importers = record(root.importers, "pnpm importers");
  const renderer = record(importers["apps/desktop-renderer"], "renderer importer");
  const dependencies = record(renderer.dependencies, "renderer dependencies");
  const dependency = record(dependencies["@enduragent/ui"], "@enduragent/ui dependency");
  const dependencySpecifier = string(dependency.specifier, "@enduragent/ui specifier");
  const lockResolution = string(dependency.version, "@enduragent/ui lock resolution");
  const packages = record(root.packages, "pnpm packages");
  const prefix = "@enduragent/ui@";
  const packageKey = Object.keys(packages)
    .filter((key) => key.startsWith(prefix) && lockResolution.startsWith(key.slice(prefix.length)))
    .sort((left, right) => right.length - left.length)[0];
  if (packageKey === undefined) throw new TypeError("@enduragent/ui package entry is missing");
  const packageEntry = record(packages[packageKey], "@enduragent/ui package entry");
  const resolution = record(packageEntry.resolution, "@enduragent/ui package resolution");
  return {
    dependencySpecifier,
    lockIntegrity: string(resolution.integrity, "@enduragent/ui lock integrity"),
    lockResolution,
  };
}

async function electronIdentity(): Promise<ApplicationBuildIdentity["electron"]> {
  const executable = desktopRequire("electron") as unknown;
  if (typeof executable !== "string") throw new TypeError("Electron executable is unavailable");
  const electronRoot = dirname(desktopRequire.resolve("electron"));
  const metadata = await packageJson(resolve(electronRoot, "package.json"));
  const result = await execFileAsync(executable, ["-p", "JSON.stringify(process.versions)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const versions = record(JSON.parse(result.stdout.trim()), "Electron runtime versions");
  return {
    packageVersion: string(metadata.version, "Electron package version"),
    executableSha256: await sha256(executable),
    runtime: {
      chrome: string(versions.chrome, "Electron Chromium version"),
      electron: string(versions.electron, "Electron runtime version"),
      node: string(versions.node, "Electron Node.js version"),
    },
  };
}

export function expectedApplicationScreenshots(): readonly string[] {
  return Object.keys(applicationProjects)
    .flatMap((project) => applicationScenarios.map((scenario) => `${project}/${scenario}.png`))
    .sort();
}

export async function currentSourceRevision(): Promise<SourceRevisionIdentity> {
  const [revisionResult, statusResult] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: repository,
    }),
  ]);
  const commit = revisionResult.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Git revision is invalid");
  return { commit, dirty: statusResult.stdout.trim().length > 0 };
}

export async function collectApplicationBuildIdentity(): Promise<ApplicationBuildIdentity> {
  const desktopPackagePath = resolve(repository, "apps/desktop/package.json");
  const rendererPackagePath = resolve(repository, "apps/desktop-renderer/package.json");
  const lockPath = resolve(repository, "pnpm-lock.yaml");
  const [desktopPackage, rendererPackage, lockText, uiRoot] = await Promise.all([
    packageJson(desktopPackagePath),
    packageJson(rendererPackagePath),
    readFile(lockPath, "utf8"),
    realpath(resolve(repository, "apps/desktop-renderer/node_modules/@enduragent/ui")),
  ]);
  const [applicationSource, verificationSource, applicationBuild, uiFiles, electron] =
    await Promise.all([
      inventory([...applicationSourceRoots({ desktopPackagePath, lockPath, rendererPackagePath })]),
      inventory([
        resolve(repository, "apps/desktop/playwright.ui-states.config.ts"),
        resolve(repository, "apps/desktop/tests/e2e/application-ui-states.spec.ts"),
        resolve(repository, "apps/desktop/tests/e2e/application-ui-states/fixture.ts"),
        resolve(repository, "apps/desktop/tests/e2e/application-ui-states/global-setup.ts"),
        resolve(repository, "apps/desktop/tests/e2e/application-ui-states/identity.ts"),
        resolve(repository, "apps/desktop/tests/e2e/application-ui-states/baseline-environment.ts"),
        resolve(repository, "apps/desktop/tests/e2e/application-ui-states/seal-baseline.ts"),
        resolve(repository, "apps/desktop/tests/helpers/desktop-fixture.ts"),
        resolve(repository, "tools/ui-verification/contracts.ts"),
        resolve(repository, "tools/ui-verification/structure.ts"),
      ]),
      inventory([resolve(repository, "apps/desktop/out")]),
      inventory(
        [resolve(uiRoot, "package.json"), resolve(uiRoot, "NOTICE.md"), resolve(uiRoot, "dist")],
        (path) => `./${relative(uiRoot, path)}`,
      ),
      electronIdentity(),
    ]);
  const uiPackage = await packageJson(resolve(uiRoot, "package.json"));
  return {
    schemaVersion: 1,
    environment: currentApplicationEnvironment(),
    applicationSource: fileSet(applicationSource),
    verificationSource: fileSet(verificationSource),
    applicationBuild: {
      ...fileSet(applicationBuild),
      desktopVersion: string(desktopPackage.version, "desktop version"),
      rendererVersion: string(rendererPackage.version, "renderer version"),
    },
    uiPackage: {
      ...fileSet(uiFiles),
      name: string(uiPackage.name, "UI package name"),
      version: string(uiPackage.version, "UI package version"),
      ...uiLockIdentity(parseYaml(lockText) as unknown),
    },
    electron,
  };
}

export async function assertApplicationBuildIsFresh(): Promise<void> {
  const desktopPackagePath = resolve(repository, "apps/desktop/package.json");
  const rendererPackagePath = resolve(repository, "apps/desktop-renderer/package.json");
  const lockPath = resolve(repository, "pnpm-lock.yaml");
  const uiRoot = await realpath(
    resolve(repository, "apps/desktop-renderer/node_modules/@enduragent/ui"),
  );
  const [sources, outputs] = await Promise.all([
    pathsIn([
      ...applicationSourceRoots({ desktopPackagePath, lockPath, rendererPackagePath }),
      resolve(uiRoot, "package.json"),
      resolve(uiRoot, "NOTICE.md"),
      resolve(uiRoot, "dist"),
    ]),
    pathsIn([resolve(repository, "apps/desktop/out")]),
  ]);
  const [sourceTimes, outputTimes] = await Promise.all([
    Promise.all(sources.map(async (path) => (await stat(path)).mtimeMs)),
    Promise.all(outputs.map(async (path) => (await stat(path)).mtimeMs)),
  ]);
  const newestSource = Math.max(...sourceTimes);
  const oldestOutput = Math.min(...outputTimes);
  if (newestSource > oldestOutput) {
    throw new Error("Desktop build is older than its application or UI package inputs; rebuild it");
  }
}

export function assertApplicationCaptureEnvironment(identity: ApplicationBuildIdentity): void {
  assertApplicationBaselineEnvironment(identity.environment, applicationBaselineVersion);
}

export function applicationRepositoryRoot(): string {
  return repository;
}
