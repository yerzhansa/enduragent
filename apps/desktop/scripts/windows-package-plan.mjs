import { readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackagePlan } from "./package-plan.mjs";
import { WINDOWS_INSTALLER_LANGUAGES } from "./package-locales.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");
const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const WINDOWS_PACKAGE_APP_ID = "icu.enduragent.desktop";
export const WINDOWS_PACKAGE_PRODUCT_NAME = "Enduragent";
export const WINDOWS_PACKAGE_GUID = "80611707-2ddf-50e5-b3ec-95f38ab4a6fa";
export const WINDOWS_PACKAGE_OUTPUT_DIRECTORY = "dist/windows";
export const WINDOWS_PACKAGE_PLATFORM = "win32";
export const WINDOWS_PACKAGE_ARCH = "x64";
export const WINDOWS_PACKAGE_TARGET = "nsis";
export const WINDOWS_PACKAGE_INSTALLER_LANGUAGES = WINDOWS_INSTALLER_LANGUAGES;
export const WINDOWS_PACKAGE_DETERMINISM = Object.freeze({
  artifactName: "desktop-version-and-x64",
  inventory: "exact-paths-types-platform-and-staged-bytes",
  artifactBytes: "electron-builder-timestamps-excluded",
});

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireWindowsDesktopVersion(value) {
  if (typeof value !== "string" || !stableVersionPattern.test(value)) {
    throw new TypeError("desktop package version is invalid");
  }
  return value;
}

export async function readWindowsDesktopVersion(input = {}, dependencies = {}) {
  const desktopRoot = input.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) throw new TypeError("desktop root must be absolute");
  const read = dependencies.readFile ?? readFile;
  let manifest;
  try {
    manifest = JSON.parse(await read(join(desktopRoot, "package.json"), "utf8"));
  } catch {
    throw new TypeError("desktop package manifest is invalid");
  }
  if (!exactObject(manifest) || !Object.hasOwn(manifest, "version")) {
    throw new TypeError("desktop package manifest is invalid");
  }
  return requireWindowsDesktopVersion(manifest.version);
}

export function windowsPackageArtifactName(version) {
  return `${WINDOWS_PACKAGE_PRODUCT_NAME}-${requireWindowsDesktopVersion(version)}-${WINDOWS_PACKAGE_ARCH}.exe`;
}

export async function createWindowsPackagePlan(input = {}, dependencies = {}) {
  const desktopRoot = input.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) throw new TypeError("desktop root must be absolute");
  const version = await readWindowsDesktopVersion(
    { desktopRoot },
    { readFile: dependencies.readFile },
  );
  const plan = createPackagePlan({
    desktopRoot,
    outputDirectory: WINDOWS_PACKAGE_OUTPUT_DIRECTORY,
    applicationRelativePath: "win-unpacked",
    executableRelativePath: `${WINDOWS_PACKAGE_PRODUCT_NAME}.exe`,
    builderConfig: {
      extends: join(desktopRoot, "electron-builder.yml"),
      appId: WINDOWS_PACKAGE_APP_ID,
      productName: WINDOWS_PACKAGE_PRODUCT_NAME,
      artifactName: `Enduragent-${version}-x64.\${ext}`,
      directories: { output: WINDOWS_PACKAGE_OUTPUT_DIRECTORY },
      forceCodeSigning: false,
      extraMetadata: { version },
      win: {
        icon: "resources/app-icon.ico",
        signExecutable: false,
        requestedExecutionLevel: "asInvoker",
        files: ["resources/tray.ico"],
        target: [{ target: WINDOWS_PACKAGE_TARGET, arch: [WINDOWS_PACKAGE_ARCH] }],
      },
      nsis: {
        artifactName: `Enduragent-${version}-x64.\${ext}`,
        guid: WINDOWS_PACKAGE_GUID,
        oneClick: true,
        perMachine: false,
        packElevateHelper: false,
        createStartMenuShortcut: true,
        createDesktopShortcut: false,
        deleteAppDataOnUninstall: false,
        installerLanguages: [...WINDOWS_PACKAGE_INSTALLER_LANGUAGES],
        language: "1033",
        multiLanguageInstaller: true,
        displayLanguageSelector: false,
        differentialPackage: false,
        buildUniversalInstaller: false,
        include: "build/installer.nsh",
      },
    },
  });
  const artifactName = windowsPackageArtifactName(version);
  return Object.freeze({
    ...plan,
    version,
    artifactName,
    artifactPath: join(plan.outputPath, artifactName),
    platform: WINDOWS_PACKAGE_PLATFORM,
    arch: WINDOWS_PACKAGE_ARCH,
    target: WINDOWS_PACKAGE_TARGET,
    signed: false,
    distribution: "private-test-only",
    updateEligible: false,
    determinism: WINDOWS_PACKAGE_DETERMINISM,
    builderOptions: {
      ...plan.builderOptions,
      win: [`${WINDOWS_PACKAGE_TARGET}:${WINDOWS_PACKAGE_ARCH}`],
    },
  });
}

function exactArtifacts(artifacts, artifactPath) {
  return (
    Array.isArray(artifacts) &&
    artifacts.length === 1 &&
    typeof artifacts[0] === "string" &&
    resolve(artifacts[0]) === artifactPath &&
    basename(artifacts[0]) === basename(artifactPath)
  );
}

export async function runWindowsPackage(input = {}, dependencies = {}) {
  dependencies.reportStage?.("package-plan");
  const plan = await createWindowsPackagePlan(input, dependencies);
  const remove = dependencies.rm ?? rm;
  dependencies.reportStage?.("output-cleanup");
  await remove(plan.outputPath, { recursive: true, force: true });
  const build = dependencies.build ?? (await import("electron-builder")).build;
  dependencies.reportStage?.("electron-builder");
  const artifacts = await build(plan.builderOptions);
  dependencies.reportStage?.("artifact-set");
  if (!exactArtifacts(artifacts, plan.artifactPath)) {
    throw new TypeError("Windows package artifact set is invalid");
  }
  const verifyWindowsPackage =
    dependencies.verifyWindowsPackage ??
    (await import("./verify-windows-package.mjs")).verifyWindowsPackage;
  dependencies.reportStage?.("package-verification");
  const evidence = await verifyWindowsPackage(plan.artifactPath, plan.applicationPath, {
    desktopRoot: plan.builderOptions.projectDir,
  });
  return Object.freeze({ artifacts: Object.freeze([...artifacts]), evidence, plan });
}

async function main() {
  let activeStage = "initialization";
  try {
    if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
    const result = await runWindowsPackage(
      {},
      {
        reportStage(stage) {
          activeStage = stage;
        },
      },
    );
    process.stdout.write(`Windows package: ${result.plan.artifactPath}\n`);
  } catch {
    process.stderr.write(`Windows package build failed at ${activeStage}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
