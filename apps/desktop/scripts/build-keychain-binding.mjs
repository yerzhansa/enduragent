import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { machoBundleIdentity } from "./package-inventory.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");

export const KEYCHAIN_BINDING_FILE = "keychain-binding.node";
export const KEYCHAIN_BINDING_BUILD_DIRECTORY = "dist/keychain-binding";
export const KEYCHAIN_BINDING_SOURCE = "native/keychain-binding/keychain-binding.mm";
export const KEYCHAIN_BINDING_PARTITION_DESCRIPTION_SOURCE =
  "native/keychain-binding/partition-description.mm";
export const KEYCHAIN_BINDING_MINIMUM_MACOS = "12.0";
export const KEYCHAIN_BINDING_NAPI_VERSION = "9";
export const KEYCHAIN_BINDING_COMPILE_TIMEOUT_MS = 300_000;

export function keychainBindingBuildPath(desktopRoot = canonicalDesktopRoot) {
  return join(desktopRoot, KEYCHAIN_BINDING_BUILD_DIRECTORY, KEYCHAIN_BINDING_FILE);
}

export async function nodeApiIncludeDirectory() {
  const executable = await realpath(process.execPath);
  const configuredPrefix = process.config.variables.node_prefix;
  const candidates = [
    resolve(executable, "../../include/node"),
    ...(typeof configuredPrefix === "string" && configuredPrefix !== "/"
      ? [resolve(configuredPrefix, "include/node")]
      : []),
    "/usr/local/include/node",
    "/opt/homebrew/include/node",
  ];
  for (const candidate of new Set(candidates)) {
    try {
      await access(join(candidate, "node_api.h"));
      return candidate;
    } catch {}
  }
  throw new Error("Node-API headers are required to build the macOS keychain binding");
}

export function keychainBindingCompilerAvailable() {
  const probe = spawnSync("xcrun", ["--find", "clang++"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

export async function buildKeychainBinding(desktopRoot = canonicalDesktopRoot) {
  if (process.platform !== "darwin") return undefined;
  if (!keychainBindingCompilerAvailable()) {
    throw new Error("Xcode clang++ is required to build the macOS keychain binding");
  }
  const buildRoot = join(desktopRoot, KEYCHAIN_BINDING_BUILD_DIRECTORY);
  const temporaryRoot = join(desktopRoot, "dist", `.keychain-binding-${process.pid}`);
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true });
  try {
    const temporaryBinding = join(temporaryRoot, KEYCHAIN_BINDING_FILE);
    const compile = spawnSync(
      "xcrun",
      [
        "clang++",
        join(desktopRoot, KEYCHAIN_BINDING_SOURCE),
        join(desktopRoot, KEYCHAIN_BINDING_PARTITION_DESCRIPTION_SOURCE),
        "-std=c++20",
        "-O2",
        "-fobjc-arc",
        "-fvisibility=hidden",
        "-arch",
        "arm64",
        `-mmacosx-version-min=${KEYCHAIN_BINDING_MINIMUM_MACOS}`,
        `-DNAPI_VERSION=${KEYCHAIN_BINDING_NAPI_VERSION}`,
        "-I",
        await nodeApiIncludeDirectory(),
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        "-framework",
        "CoreFoundation",
        "-framework",
        "Security",
        "-o",
        temporaryBinding,
      ],
      { cwd: temporaryRoot, encoding: "utf8", timeout: KEYCHAIN_BINDING_COMPILE_TIMEOUT_MS },
    );
    if (compile.error !== undefined || compile.status !== 0 || compile.signal !== null) {
      if (typeof compile.stderr === "string" && compile.stderr.length > 0) {
        process.stderr.write(compile.stderr);
      }
      throw new Error("keychain binding compilation failed");
    }
    machoBundleIdentity(await readFile(temporaryBinding), KEYCHAIN_BINDING_BUILD_DIRECTORY);
    await rm(buildRoot, { recursive: true, force: true });
    await rename(temporaryRoot, buildRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return keychainBindingBuildPath(desktopRoot);
}

export async function copyKeychainBindingToAsarStaging(desktopRoot, asarRoot) {
  if (process.platform !== "darwin") return undefined;
  const source = keychainBindingBuildPath(desktopRoot);
  const target = join(asarRoot, "native", KEYCHAIN_BINDING_FILE);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  machoBundleIdentity(await readFile(target), "native/keychain-binding.node");
  return target;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("arguments are not supported");
  const built = await buildKeychainBinding();
  process.stdout.write(
    built === undefined
      ? "keychain binding build skipped on this platform\n"
      : `keychain binding: ${KEYCHAIN_BINDING_BUILD_DIRECTORY}/${KEYCHAIN_BINDING_FILE}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
