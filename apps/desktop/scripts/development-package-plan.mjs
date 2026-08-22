import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackagePlan } from "./package-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");

export const DEVELOPMENT_APP_ID = "icu.enduragent.desktop.development";
export const DEVELOPMENT_PRODUCT_NAME = "Enduragent Development";
export const DEVELOPMENT_PACKAGE_NAME = "enduragent-desktop-development";
export const DEVELOPMENT_OUTPUT_DIRECTORY = "dist/development";

export function createDevelopmentPackagePlan(input = {}) {
  const desktopRoot = input.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) {
    throw new TypeError("desktop root must be absolute");
  }
  return createPackagePlan({
    desktopRoot,
    outputDirectory: DEVELOPMENT_OUTPUT_DIRECTORY,
    applicationRelativePath: join("mac-arm64", `${DEVELOPMENT_PRODUCT_NAME}.app`),
    executableRelativePath: join("Contents", "MacOS", DEVELOPMENT_PRODUCT_NAME),
    builderConfig: {
      extends: join(desktopRoot, "electron-builder.yml"),
      appId: DEVELOPMENT_APP_ID,
      productName: DEVELOPMENT_PRODUCT_NAME,
      directories: { output: DEVELOPMENT_OUTPUT_DIRECTORY },
      forceCodeSigning: false,
      extraMetadata: {
        name: DEVELOPMENT_PACKAGE_NAME,
        enduragentDesktopDevelopment: true,
      },
      mac: {
        identity: "-",
        hardenedRuntime: false,
        target: [{ target: "dir", arch: ["arm64"] }],
      },
    },
  });
}

export async function runDevelopmentPackage(input = {}, dependencies = {}) {
  const plan = createDevelopmentPackagePlan(input);
  const remove = dependencies.rm ?? rm;
  await remove(plan.outputPath, { recursive: true, force: true });
  const build = dependencies.build ?? (await import("electron-builder")).build;
  const artifacts = await build(plan.builderOptions);
  const verifyPackageLayout =
    dependencies.verifyPackageLayout ??
    (await import("./verify-package-layout.mjs")).verifyPackageLayout;
  await verifyPackageLayout(plan.applicationPath, {
    desktopRoot: plan.builderOptions.projectDir,
    development: true,
  });
  return Object.freeze({ artifacts, plan });
}

async function main() {
  if (process.argv.length !== 2) throw new TypeError("arguments are not supported");
  const result = await runDevelopmentPackage();
  process.stdout.write(`development application: ${result.plan.applicationPath}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("development package build failed\n");
    process.exitCode = 1;
  }
}
