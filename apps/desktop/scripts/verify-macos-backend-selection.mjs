import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KEYCHAIN_BINDING_ASAR_PATH } from "./package-inventory.mjs";
import { verifyMacosKeychainBinding } from "./verify-macos-release.mjs";

export const BACKEND_SELECTION_SERVICE = "icu.enduragent.desktop";
export const BACKEND_SELECTION_TEAM_IDENTIFIER = "FA494ACVTF";
export const BACKEND_SELECTION_BACKEND = "keychain_partition_v1";
export const BACKEND_SELECTION_PROBE_TIMEOUT_MS = 15_000;
export const BACKEND_SELECTION_MAX_RESPONSE_BYTES = 8_192;
export const BACKEND_SELECTION_OUTPUT_PREFIX = "ENDURAGENT_KEYCHAIN_BINDING_PROBE ";

class MacosBackendSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "MacosBackendSelectionError";
  }
}

function fail(message) {
  throw new MacosBackendSelectionError(message);
}

export function safeMacosBackendSelectionMessage(error) {
  return error instanceof MacosBackendSelectionError ? error.message : undefined;
}

async function requireRegularBinding(binding) {
  let entry;
  try {
    entry = await lstat(binding);
  } catch {
    fail("bundled keychain binding is missing");
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail("bundled keychain binding is not a regular file");
  }
}

function runSignedApplication(executable, userData) {
  return new Promise((resolveProbe, rejectProbe) => {
    let child;
    try {
      child = spawn(
        executable,
        ["--desktop-keychain-binding-probe", `--user-data-dir=${userData}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      rejectProbe(new MacosBackendSelectionError("signed application probe could not be launched"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message === undefined) resolveProbe(result);
      else rejectProbe(new MacosBackendSelectionError(message));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined, "signed application keychain probe timed out");
    }, BACKEND_SELECTION_PROBE_TIMEOUT_MS);
    child.once("error", () => finish(undefined, "signed application probe could not be launched"));
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > BACKEND_SELECTION_MAX_RESPONSE_BYTES) {
        child.kill("SIGKILL");
        finish(undefined, "signed application keychain probe answered too much output");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr) > BACKEND_SELECTION_MAX_RESPONSE_BYTES) {
        child.kill("SIGKILL");
        finish(undefined, "signed application keychain probe answered too much output");
      }
    });
    child.once("close", (code, signal) => finish({ code, signal, stdout, stderr }));
  });
}

function parseProbe(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.code !== 0 ||
    result.signal !== null ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    result.stderr !== ""
  ) {
    fail("signed application keychain binding probe was refused");
  }
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1 || !lines[0].startsWith(BACKEND_SELECTION_OUTPUT_PREFIX)) {
    fail("signed application keychain binding probe was malformed");
  }
  const encodedPayload = lines[0].slice(BACKEND_SELECTION_OUTPUT_PREFIX.length);
  let payload;
  try {
    payload = JSON.parse(encodedPayload);
  } catch {
    fail("signed application keychain binding probe was malformed");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    !Object.hasOwn(payload, "backend") ||
    !Object.hasOwn(payload, "teamIdentifier")
  ) {
    fail("signed application keychain binding probe was malformed");
  }
  if (payload.backend !== BACKEND_SELECTION_BACKEND) {
    fail("signed application keychain binding probe reported an unexpected backend");
  }
  if (payload.teamIdentifier !== BACKEND_SELECTION_TEAM_IDENTIFIER) {
    fail("signed application keychain binding probe reported an unexpected identity");
  }
  if (
    encodedPayload !==
    JSON.stringify({
      backend: BACKEND_SELECTION_BACKEND,
      teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
    })
  ) {
    fail("signed application keychain binding probe was malformed");
  }
  return payload;
}

export async function verifyMacosBackendSelection(application, overrides = {}) {
  if (typeof application !== "string" || !isAbsolute(application)) {
    fail("application path must be absolute");
  }
  const binding = join(
    application,
    "Contents/Resources/app.asar.unpacked",
    KEYCHAIN_BINDING_ASAR_PATH,
  );
  await (overrides.requireBinding ?? requireRegularBinding)(binding);
  const verifyBinding =
    overrides.verifyKeychainBinding ??
    ((candidate) => verifyMacosKeychainBinding(candidate, { executeFile: overrides.executeFile }));
  let signature;
  try {
    signature = await verifyBinding(application);
  } catch (error) {
    fail(
      typeof error?.message === "string" && error.message.length > 0
        ? error.message
        : "bundled keychain binding signature verification failed",
    );
  }
  if (
    signature === null ||
    typeof signature !== "object" ||
    signature.teamIdentifier !== BACKEND_SELECTION_TEAM_IDENTIFIER
  ) {
    fail("bundled keychain binding signing identity is invalid");
  }
  const makeTemporary = overrides.mkdtemp ?? mkdtemp;
  const remove = overrides.rm ?? rm;
  const scratch = await makeTemporary(join(tmpdir(), "enduragent-binding-probe-"));
  try {
    const executable = join(application, "Contents/MacOS/Enduragent");
    const result = await (overrides.runApplication ?? runSignedApplication)(executable, scratch);
    const payload = parseProbe(result);
    return Object.freeze({
      binding,
      service: BACKEND_SELECTION_SERVICE,
      backend: payload.backend,
      teamIdentifier: payload.teamIdentifier,
      designatedRequirement: signature.designatedRequirement,
    });
  } finally {
    await remove(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [application] = process.argv.slice(2);
    if (application === undefined) fail("expected an absolute application path");
    await verifyMacosBackendSelection(application);
    process.stdout.write("macOS keychain backend selection verified\n");
  } catch (error) {
    process.stderr.write(
      `${safeMacosBackendSelectionMessage(error) ?? "macOS keychain backend selection verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
