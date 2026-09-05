import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractFile, listPackage } from "@electron/asar";
import { parse } from "yaml";
import {
  configureTelegramAcceptanceSigningEnvironment,
  createTelegramAcceptanceBuilderConfiguration,
  selectTelegramAcceptanceNestedTarget,
  TELEGRAM_ACCEPTANCE_APP_ID,
  TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
  verifyTelegramAcceptanceDesignatedRequirement,
  verifyTelegramAcceptanceEntitlements,
  verifyTelegramAcceptanceInfoPlist,
  verifyTelegramAcceptanceMainEntry,
  verifyTelegramAcceptanceManifest,
  verifyTelegramAcceptanceNestedEntitlements,
  verifyTelegramAcceptanceNestedListing,
  verifyTelegramAcceptanceNestedSignature,
  verifyTelegramAcceptanceSignature,
  verifyTelegramAcceptanceWorkspaceRuntime,
} from "./support/packaged-telegram/package-acceptance.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = "dist/telegram-acceptance-package";
const execute = promisify(execFile);

function commandOutput(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function hasErrorCode(error, code) {
  return error !== null && typeof error === "object" && error.code === code;
}

async function optionalReadFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function optionalRealpath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return undefined;
    throw error;
  }
}

function sameOrDescendant(root, target) {
  const displacement = relative(root, target);
  return (
    displacement === "" ||
    (!isAbsolute(displacement) && displacement !== ".." && !displacement.startsWith(`..${sep}`))
  );
}

async function readEntitlements(target, scratch, label) {
  const entitlementsDer = join(scratch, `${label}.der`);
  const entitlementsXml = join(scratch, `${label}.plist`);
  await execute("/usr/bin/codesign", [
    "--display",
    "--entitlements",
    entitlementsDer,
    "--der",
    target,
  ]);
  if ((await optionalReadFile(entitlementsDer)) === undefined) return undefined;
  await execute("/usr/bin/derq", ["query", "--xml", "-i", entitlementsDer, "-o", entitlementsXml]);
  const entitlementJson = await execute("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    entitlementsXml,
  ]);
  return JSON.parse(entitlementJson.stdout);
}

async function resolveNestedTarget(applicationRoot, parentTarget, executable, nestedPath) {
  const executablePath = await realpath(executable);
  if (
    !sameOrDescendant(applicationRoot, executablePath) ||
    !sameOrDescendant(parentTarget, executablePath)
  ) {
    throw new TypeError("Telegram acceptance nested executable is outside its code object");
  }

  const searchRoots = [];
  let searchRoot = dirname(executablePath);
  while (sameOrDescendant(parentTarget, searchRoot)) {
    searchRoots.push(searchRoot);
    if (searchRoot === parentTarget) break;
    const parent = dirname(searchRoot);
    if (parent === searchRoot) break;
    searchRoot = parent;
  }
  const candidates = [];
  for (const root of searchRoots) {
    const candidate = await optionalRealpath(join(root, nestedPath));
    if (candidate === undefined) continue;
    candidates.push(candidate);
  }
  return selectTelegramAcceptanceNestedTarget(applicationRoot, candidates);
}

async function verifyNestedSigning(application, rootDescription, scratch) {
  const applicationRoot = await realpath(application);
  const pending = [{ target: applicationRoot, description: rootDescription, root: true }];
  const seen = new Set([applicationRoot]);
  let entitlementIndex = 0;

  while (pending.length > 0) {
    const current = pending.shift();
    const listing = verifyTelegramAcceptanceNestedListing(current.description);
    const executable = await realpath(listing.executable);
    if (
      !sameOrDescendant(applicationRoot, executable) ||
      !sameOrDescendant(current.target, executable)
    ) {
      throw new TypeError("Telegram acceptance nested executable is outside its code object");
    }
    if (!current.root) {
      verifyTelegramAcceptanceNestedSignature(current.description);
      verifyTelegramAcceptanceNestedEntitlements(
        await readEntitlements(
          current.target,
          scratch,
          `nested-entitlements-${entitlementIndex++}`,
        ),
      );
    }
    for (const nestedPath of listing.nested) {
      const target = await resolveNestedTarget(
        applicationRoot,
        current.target,
        listing.executable,
        nestedPath,
      );
      if (seen.has(target)) {
        throw new TypeError("Telegram acceptance nested code target is duplicated");
      }
      seen.add(target);
      const displayed = await execute("/usr/bin/codesign", [
        "--display",
        "--deep",
        "--verbose=4",
        target,
      ]);
      pending.push({ target, description: commandOutput(displayed), root: false });
    }
  }
}

async function verifySigningPayload(application, expectedCdHash, rootDescription) {
  const scratch = await mkdtemp(join(tmpdir(), "enduragent-telegram-signature-"));
  const requirements = join(scratch, "root-requirements.txt");
  try {
    verifyTelegramAcceptanceEntitlements(
      await readEntitlements(application, scratch, "root-entitlements"),
    );
    await execute("/usr/bin/codesign", ["--display", "--requirements", requirements, application]);
    verifyTelegramAcceptanceDesignatedRequirement(
      await readFile(requirements, "utf8"),
      expectedCdHash,
    );
    await verifyNestedSigning(application, rootDescription, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

configureTelegramAcceptanceSigningEnvironment(process.env);
const { build } = await import("electron-builder");
await rm(join(desktopRoot, outputDirectory), { recursive: true, force: true });
const sourceManifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
if (typeof sourceManifest.version !== "string" || sourceManifest.version.length === 0) {
  throw new TypeError("Desktop package version is invalid");
}
const canonical = parse(await readFile(join(desktopRoot, "electron-builder.yml"), "utf8"));
const artifacts = await build({
  projectDir: desktopRoot,
  publish: "never",
  config: createTelegramAcceptanceBuilderConfiguration(canonical),
});
const application = join(
  desktopRoot,
  outputDirectory,
  `mac-arm64/${TELEGRAM_ACCEPTANCE_PRODUCT_NAME}.app`,
);
await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", application]);
const signature = await execute("/usr/bin/codesign", [
  "--display",
  "--deep",
  "--verbose=4",
  application,
]);
const signatureDescription = commandOutput(signature);
const signatureCdHash = verifyTelegramAcceptanceSignature(signatureDescription);
await verifySigningPayload(application, signatureCdHash, signatureDescription);
const infoPlist = await execute("/usr/bin/plutil", [
  "-convert",
  "json",
  "-o",
  "-",
  join(application, "Contents/Info.plist"),
]);
verifyTelegramAcceptanceInfoPlist(JSON.parse(infoPlist.stdout));
const archive = join(application, "Contents/Resources/app.asar");
const packagedManifest = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
verifyTelegramAcceptanceManifest(packagedManifest, sourceManifest.version);
verifyTelegramAcceptanceWorkspaceRuntime(packagedManifest, listPackage(archive), (manifestPath) =>
  JSON.parse(extractFile(archive, manifestPath).toString("utf8")),
);
const productionMain = verifyTelegramAcceptanceMainEntry(
  extractFile(archive, packagedManifest.main).toString("utf8"),
  (path) => extractFile(archive, path).toString("utf8"),
);
if (extractFile(archive, productionMain).length === 0) {
  throw new TypeError("Telegram acceptance production main is empty");
}
process.stdout.write(
  `${JSON.stringify({
    application,
    appId: TELEGRAM_ACCEPTANCE_APP_ID,
    signature: "ad-hoc",
    artifacts: artifacts.map((path) => resolve(path)),
  })}\n`,
);
