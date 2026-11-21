import { rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackagePlan } from "./package-plan.mjs";
import {
  WINDOWS_PACKAGE_APP_ID,
  WINDOWS_PACKAGE_PRODUCT_NAME,
  readWindowsDesktopVersion,
  requireWindowsDesktopVersion,
} from "./windows-package-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");
const identityNamePattern = /^[A-Za-z0-9.-]{3,50}$/u;
const publisherPattern = /^CN=[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/u;
const publisherDisplayNamePattern = /^[^\p{Cc}&<>]{1,256}$/u;

export const WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY = "dist/windows-store";
export const WINDOWS_STORE_PACKAGE_PLATFORM = "win32";
export const WINDOWS_STORE_PACKAGE_ARCH = "x64";
export const WINDOWS_STORE_PACKAGE_TARGET = "appx";
export const WINDOWS_STORE_PACKAGE_APPLICATION_ID = "Enduragent";
export const WINDOWS_STORE_PACKAGE_LANGUAGES = Object.freeze(["en-US"]);
export const WINDOWS_STORE_PACKAGE_MIN_VERSION = "10.0.19041.0";
export const WINDOWS_STORE_PACKAGE_MAX_VERSION_TESTED = "10.0.26100.0";
export const WINDOWS_STORE_IDENTITY_ENVIRONMENT = Object.freeze({
  identityName: "ENDURAGENT_STORE_IDENTITY_NAME",
  publisher: "ENDURAGENT_STORE_PUBLISHER",
  publisherDisplayName: "ENDURAGENT_STORE_PUBLISHER_DISPLAY_NAME",
});

const safeWindowsStorePackageMessages = new Set([
  `${WINDOWS_STORE_IDENTITY_ENVIRONMENT.identityName} must be the Package/Identity/Name from Partner Center`,
  `${WINDOWS_STORE_IDENTITY_ENVIRONMENT.publisher} must be the Package/Identity/Publisher from Partner Center`,
  `${WINDOWS_STORE_IDENTITY_ENVIRONMENT.publisherDisplayName} must be the Package/Properties/PublisherDisplayName from Partner Center`,
  "desktop package version is invalid",
  "desktop package manifest is invalid",
]);

export function safeWindowsStorePackageMessage(error) {
  return error instanceof TypeError && safeWindowsStorePackageMessages.has(error.message)
    ? error.message
    : undefined;
}

function requireIdentityValue(environment, key, pattern, description) {
  const name = WINDOWS_STORE_IDENTITY_ENVIRONMENT[key];
  const value = environment[name];
  if (typeof value !== "string" || value !== value.trim() || !pattern.test(value)) {
    throw new TypeError(`${name} must be the ${description} from Partner Center`);
  }
  return value;
}

export function readWindowsStoreIdentity(environment = process.env) {
  return Object.freeze({
    identityName: requireIdentityValue(
      environment,
      "identityName",
      identityNamePattern,
      "Package/Identity/Name",
    ),
    publisher: requireIdentityValue(
      environment,
      "publisher",
      publisherPattern,
      "Package/Identity/Publisher",
    ),
    publisherDisplayName: requireIdentityValue(
      environment,
      "publisherDisplayName",
      publisherDisplayNamePattern,
      "Package/Properties/PublisherDisplayName",
    ),
  });
}

export function windowsStorePackageArtifactName(version) {
  return `${WINDOWS_PACKAGE_PRODUCT_NAME}-${requireWindowsDesktopVersion(version)}-${WINDOWS_STORE_PACKAGE_ARCH}.appx`;
}

export async function createWindowsStorePackagePlan(input = {}, dependencies = {}) {
  const desktopRoot = input.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) throw new TypeError("desktop root must be absolute");
  const identity = readWindowsStoreIdentity(input.environment ?? process.env);
  const version = await readWindowsDesktopVersion(
    { desktopRoot },
    { readFile: dependencies.readFile },
  );
  const artifactPattern = `${WINDOWS_PACKAGE_PRODUCT_NAME}-${version}-${WINDOWS_STORE_PACKAGE_ARCH}.\${ext}`;
  const plan = createPackagePlan({
    desktopRoot,
    outputDirectory: WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY,
    applicationRelativePath: "win-unpacked",
    executableRelativePath: `${WINDOWS_PACKAGE_PRODUCT_NAME}.exe`,
    builderConfig: {
      extends: join(desktopRoot, "electron-builder.yml"),
      appId: WINDOWS_PACKAGE_APP_ID,
      productName: WINDOWS_PACKAGE_PRODUCT_NAME,
      artifactName: artifactPattern,
      directories: { output: WINDOWS_STORE_PACKAGE_OUTPUT_DIRECTORY },
      forceCodeSigning: false,
      extraMetadata: { version, enduragentDesktopRelease: true },
      win: {
        icon: "resources/app-icon.ico",
        signExecutable: false,
        requestedExecutionLevel: "asInvoker",
        files: ["resources/tray.ico"],
        target: [{ target: WINDOWS_STORE_PACKAGE_TARGET, arch: [WINDOWS_STORE_PACKAGE_ARCH] }],
      },
      appx: {
        artifactName: artifactPattern,
        applicationId: WINDOWS_STORE_PACKAGE_APPLICATION_ID,
        identityName: identity.identityName,
        publisher: identity.publisher,
        publisherDisplayName: identity.publisherDisplayName,
        displayName: WINDOWS_PACKAGE_PRODUCT_NAME,
        languages: [...WINDOWS_STORE_PACKAGE_LANGUAGES],
        backgroundColor: "transparent",
        showNameOnTiles: false,
        addAutoLaunchExtension: false,
        capabilities: ["runFullTrust"],
        electronUpdaterAware: false,
        setBuildNumber: false,
        minVersion: WINDOWS_STORE_PACKAGE_MIN_VERSION,
        maxVersionTested: WINDOWS_STORE_PACKAGE_MAX_VERSION_TESTED,
      },
    },
  });
  const artifactName = windowsStorePackageArtifactName(version);
  return Object.freeze({
    ...plan,
    version,
    identity,
    artifactName,
    artifactPath: join(plan.outputPath, artifactName),
    platform: WINDOWS_STORE_PACKAGE_PLATFORM,
    arch: WINDOWS_STORE_PACKAGE_ARCH,
    target: WINDOWS_STORE_PACKAGE_TARGET,
    signed: false,
    distribution: "microsoft-store-submission",
    updateEligible: false,
    builderOptions: {
      ...plan.builderOptions,
      win: [`${WINDOWS_STORE_PACKAGE_TARGET}:${WINDOWS_STORE_PACKAGE_ARCH}`],
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

export async function runWindowsStorePackage(input = {}, dependencies = {}) {
  dependencies.reportStage?.("package-plan");
  const plan = await createWindowsStorePackagePlan(input, dependencies);
  const remove = dependencies.rm ?? rm;
  dependencies.reportStage?.("output-cleanup");
  await remove(plan.outputPath, { recursive: true, force: true });
  const build = dependencies.build ?? (await import("electron-builder")).build;
  dependencies.reportStage?.("electron-builder");
  const artifacts = await build(plan.builderOptions);
  dependencies.reportStage?.("artifact-set");
  if (!exactArtifacts(artifacts, plan.artifactPath)) {
    throw new TypeError("Windows Store package artifact set is invalid");
  }
  const inspect = dependencies.stat ?? stat;
  const metadata = await inspect(plan.artifactPath);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new TypeError("Windows Store package artifact set is invalid");
  }
  return Object.freeze({ artifacts: Object.freeze([...artifacts]), plan });
}

async function main() {
  let activeStage = "initialization";
  try {
    if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
    const result = await runWindowsStorePackage(
      {},
      {
        reportStage(stage) {
          activeStage = stage;
        },
      },
    );
    process.stdout.write(`Windows Store package: ${result.plan.artifactPath}\n`);
  } catch (error) {
    const detail = safeWindowsStorePackageMessage(error);
    process.stderr.write(
      detail === undefined
        ? `Windows Store package build failed at ${activeStage}\n`
        : `Windows Store package build failed at ${activeStage}: ${detail}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
