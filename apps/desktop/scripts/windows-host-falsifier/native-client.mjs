import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32 as windowsPath,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveNativeCandidateDigest,
  deriveNativeSourceBundleSha256,
  deriveNativeToolchainDigest,
} from "./native-manifest-digest.mjs";
import {
  validateProbeBrokerEnrollment,
  validateProbePreparedBrokerEnrollment,
} from "./broker/mailbox-protocol.mjs";

export const NATIVE_PROTOCOL_VERSION = 1;
export const NATIVE_PREFLIGHT_OBSERVATION_SCHEMA_VERSION = 1;
export const NATIVE_BROKER_CONTEXT_SECURITY_PROFILE = "role-separated-immutable-file-mailbox-v1";
export const NATIVE_BROKER_JOURNAL_SECURITY_PROFILE = "role-separated-append-only-journal-v1";
export const NATIVE_BROKER_CONTEXT_KINDS = Object.freeze([
  "windows-host-native-broker-storage-observed",
  "windows-host-native-broker-context-acquired",
  "windows-host-native-broker-context-revalidated",
  "windows-host-native-broker-context-released",
]);
export const NATIVE_COMMANDS = Object.freeze([
  "home-identity",
  "private-directory-ensure",
  "private-directory-inspect",
  "private-file-create",
  "secure-path-operation",
  "file-identity",
  "evidence-tree-seal",
  "durable-replace",
  "pipe-name-derive",
  "pipe-owner",
  "pipe-client",
  "pipe-foreign-precreate",
  "job-owner",
  "process-identity",
  "job-query",
]);

export const NATIVE_CHILD_ENV_ALLOWLIST = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "ComSpec",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
]);

const nativeChildBindingAllowlist = Object.freeze([
  "ENDURAGENT_NATIVE_LOCK_PATH",
  "ENDURAGENT_NATIVE_LOCK_SHA256",
  "ENDURAGENT_NATIVE_LOCK_NONCE",
  "ENDURAGENT_NATIVE_PRIVATE_DIRECTORY_PATH",
  "ENDURAGENT_NATIVE_PRIVATE_DIRECTORY_NONCE",
  "ENDURAGENT_NATIVE_RUN_ROOT",
  "ENDURAGENT_PATH_PROFILE_ID",
  "ENDURAGENT_CAMPAIGN_RUN_ID",
  "ENDURAGENT_CAMPAIGN_CANDIDATE_SHA256",
  "ENDURAGENT_PREFLIGHT_SHA256",
  "ENDURAGENT_EXECUTION_BUNDLE_MANIFEST_SHA256",
  "ENDURAGENT_NATIVE_CANDIDATE_DIGEST",
  "ENDURAGENT_NATIVE_MANIFEST_SHA256",
  "ENDURAGENT_PREFLIGHT_NATIVE_HELPER_SHA256",
  "ENDURAGENT_EVIDENCE_ROOT_OBJECT_IDENTITY_SHA256",
  "ENDURAGENT_NATIVE_SESSION_ID",
]);

const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "native");
const sourceAllowlist = Object.freeze([
  "Program.cs",
  "Protocol.cs",
  "FileSystem.cs",
  "NamedPipe.cs",
  "JobObject.cs",
  "BrokerContext.cs",
  "compile.ps1",
]);
const csharpSourceAllowlist = sourceAllowlist.filter((name) => name.endsWith(".cs"));
const lowerHex64 = /^[a-f0-9]{64}$/u;
const frozenPipeName = /^\\\\\.\\pipe\\Enduragent-upgrade-v1-[a-f0-9]{64}$/u;
const maxInputFrameBytes = 64 * 1024;
const maxOutputFrameBytes = 256 * 1024;
const maxProcessOutputBytes = 4 * 1024 * 1024;
const maxStderrBytes = 64 * 1024;
const maxContentBytes = 4 * 1024 * 1024;
const requiredCompilerOptions = "/target:exe /platform:x64 /checked+ /optimize+ /warn:4 /nologo";
const requiredAddTypeInvocation =
  'Add-Type -Path Program.cs,Protocol.cs,FileSystem.cs,NamedPipe.cs,JobObject.cs,BrokerContext.cs -CompilerParameters <GenerateExecutable=true;GenerateInMemory=false;OutputAssembly=<owned-build-root>;CompilerOptions="/target:exe /platform:x64 /checked+ /optimize+ /warn:4 /nologo";References=allowlisted-framework-paths>';
const nativeTranscriptDomain = "enduragent.windows-host-native-command-transcript.v1";
const buildAssemblyObjectIdentities = new WeakMap();
const buildCandidateBindings = new WeakMap();

export class NativeClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeClientError";
    this.code = code;
  }
}

function nativeProcessExitRequired(primary, cleanupFailures, message) {
  const error = new NativeClientError(
    "NATIVE_PROCESS_EXIT_REQUIRED",
    `${message}; this process must terminate`,
  );
  error.requiresProcessExit = true;
  error.cause = new AggregateError(
    [primary, ...cleanupFailures],
    "native operation and process cleanup both failed",
  );
  return error;
}

async function preserveNativeCleanupFailure(primary, cleanupOperations, message) {
  const settled = await Promise.allSettled(cleanupOperations);
  const cleanupFailures = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupFailures.length !== 0) {
    throw nativeProcessExitRequired(primary, cleanupFailures, message);
  }
  throw primary;
}

function fail(code, message) {
  throw new NativeClientError(code, message);
}

function windowsPathCaseKey(value) {
  return value.normalize("NFC").toLocaleUpperCase("en-US");
}

function assertNoWindowsPathCaseCollisions(paths, label) {
  const seen = new Set();
  for (const path of paths) {
    const key = windowsPathCaseKey(path);
    if (seen.has(key)) {
      fail("NATIVE_PATH_CASE_COLLISION", `${label} contains a case-colliding Windows path`);
    }
    seen.add(key);
  }
}

function validateCanonicalWindowsLocalDirectory(value, label, code) {
  requireString(value, label, { min: 4, max: 32767 });
  if (
    value.includes("/") ||
    !/^[A-Za-z]:\\/u.test(value) ||
    !windowsPath.isAbsolute(value) ||
    windowsPath.normalize(value) !== value ||
    value.normalize("NFC") !== value
  ) {
    fail(code, `${label} must be a canonical local-drive path`);
  }
  const components = value.slice(3).split("\\");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (
    components.length === 0 ||
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        /[. ]$/u.test(component) ||
        reserved.test(component) ||
        [...component].some(
          (character) => character.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(character),
        ),
    )
  ) {
    fail(code, `${label} contains an unsafe Windows component`);
  }
  return value;
}

function loadedWindowsSystemLibraries() {
  const report = process.report?.getReport?.();
  if (!exactObject(report) || !Array.isArray(report.sharedObjects)) {
    fail(
      "NATIVE_SYSTEM_ROOT_ANCHOR",
      "Node did not expose loaded Windows system-library identities",
    );
  }
  if (report.sharedObjects.some((entry) => typeof entry !== "string")) {
    fail("NATIVE_SYSTEM_ROOT_ANCHOR", "Node exposed an invalid system-library identity");
  }
  return Object.freeze([...report.sharedObjects]);
}

export function resolveNativeWindowsToolPaths(base, loadedSystemLibraries) {
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    fail("NATIVE_SYSTEM_ROOT_SCHEMA", "Windows environment must be an object");
  }
  if (!Array.isArray(loadedSystemLibraries)) {
    fail("NATIVE_SYSTEM_ROOT_ANCHOR", "loaded Windows system libraries must be an array");
  }
  const anchors = new Map();
  for (const libraryPath of loadedSystemLibraries) {
    if (typeof libraryPath !== "string") {
      fail("NATIVE_SYSTEM_ROOT_ANCHOR", "loaded Windows system libraries must be strings");
    }
    const name = windowsPath.basename(libraryPath).toLocaleUpperCase("en-US");
    if (name !== "KERNEL32.DLL" && name !== "NTDLL.DLL") continue;
    if (anchors.has(name)) {
      fail("NATIVE_SYSTEM_ROOT_ANCHOR", "loaded Windows system-library identity is ambiguous");
    }
    anchors.set(name, libraryPath);
  }
  const kernel32 = anchors.get("KERNEL32.DLL");
  const ntdll = anchors.get("NTDLL.DLL");
  if (kernel32 === undefined || ntdll === undefined) {
    fail("NATIVE_SYSTEM_ROOT_ANCHOR", "loaded Windows system-library anchors are incomplete");
  }
  const kernelSystem32 = windowsPath.dirname(kernel32);
  const ntdllSystem32 = windowsPath.dirname(ntdll);
  validateCanonicalWindowsLocalDirectory(
    kernelSystem32,
    "loaded kernel32 directory",
    "NATIVE_SYSTEM_ROOT_ANCHOR",
  );
  validateCanonicalWindowsLocalDirectory(
    ntdllSystem32,
    "loaded ntdll directory",
    "NATIVE_SYSTEM_ROOT_ANCHOR",
  );
  if (
    windowsPathCaseKey(kernelSystem32) !== windowsPathCaseKey(ntdllSystem32) ||
    windowsPath.basename(kernelSystem32).toLocaleUpperCase("en-US") !== "SYSTEM32"
  ) {
    fail("NATIVE_SYSTEM_ROOT_ANCHOR", "loaded Windows system libraries are not co-located");
  }
  const anchoredSystemRoot = windowsPath.dirname(kernelSystem32);
  validateCanonicalWindowsLocalDirectory(
    anchoredSystemRoot,
    "loaded Windows system root",
    "NATIVE_SYSTEM_ROOT_ANCHOR",
  );
  const selected = new Map();
  for (const [key, value] of Object.entries(base)) {
    const folded = key.toLocaleUpperCase("en-US");
    if (folded !== "SYSTEMROOT" && folded !== "WINDIR") continue;
    if (value === undefined) continue;
    if (typeof value !== "string") {
      fail("NATIVE_SYSTEM_ROOT_VALUE", "Windows system root values must be strings");
    }
    if (selected.has(folded)) {
      fail("NATIVE_SYSTEM_ROOT_COLLISION", "Windows system root has a case-folded collision");
    }
    selected.set(folded, value);
  }
  const systemRoot = selected.get("SYSTEMROOT");
  if (systemRoot === undefined) {
    fail("NATIVE_SYSTEM_ROOT_MISSING", "SystemRoot is required for native tooling");
  }
  validateCanonicalWindowsLocalDirectory(systemRoot, "SystemRoot", "NATIVE_SYSTEM_ROOT_PATH");
  if (windowsPathCaseKey(systemRoot) !== windowsPathCaseKey(anchoredSystemRoot)) {
    fail("NATIVE_SYSTEM_ROOT_MISMATCH", "SystemRoot differs from loaded Windows system libraries");
  }
  const windir = selected.get("WINDIR");
  if (windir !== undefined) {
    validateCanonicalWindowsLocalDirectory(windir, "WINDIR", "NATIVE_SYSTEM_ROOT_PATH");
    if (windowsPathCaseKey(windir) !== windowsPathCaseKey(systemRoot)) {
      fail("NATIVE_SYSTEM_ROOT_MISMATCH", "SystemRoot and WINDIR identify different paths");
    }
  }
  const system32 = kernelSystem32;
  return Object.freeze({
    systemRoot: anchoredSystemRoot,
    system32,
    powerShellExecutable: windowsPath.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
  });
}

export function buildNativeToolEnvironment(base, tempDirectory, loadedSystemLibraries) {
  const paths = resolveNativeWindowsToolPaths(base, loadedSystemLibraries);
  validateCanonicalWindowsLocalDirectory(
    tempDirectory,
    "native tool temp directory",
    "NATIVE_SYSTEM_ROOT_TEMP",
  );
  return Object.freeze({
    SystemRoot: paths.systemRoot,
    WINDIR: paths.systemRoot,
    PATH: paths.system32,
    TEMP: tempDirectory,
    TMP: tempDirectory,
  });
}

export function buildNativeChildEnvironment(base, bindings = {}) {
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    fail("NATIVE_ENV_SCHEMA", "native child base environment must be an object");
  }
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    fail("NATIVE_ENV_SCHEMA", "native child bindings must be an object");
  }
  const baseByFoldedKey = new Map();
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (typeof value !== "string") {
      fail("NATIVE_ENV_VALUE", "native child environment values must be strings");
    }
    const folded = key.toLocaleUpperCase("en-US");
    const prior = baseByFoldedKey.get(folded);
    if (prior !== undefined && prior !== value) {
      fail("NATIVE_ENV_COLLISION", "native child environment has a case-folded collision");
    }
    baseByFoldedKey.set(folded, value);
  }
  const environment = {};
  for (const key of NATIVE_CHILD_ENV_ALLOWLIST) {
    const value = baseByFoldedKey.get(key.toLocaleUpperCase("en-US"));
    if (value !== undefined) environment[key] = value;
  }
  const permittedBindings = new Set(nativeChildBindingAllowlist);
  for (const [key, value] of Object.entries(bindings)) {
    if (!permittedBindings.has(key)) {
      fail("NATIVE_ENV_BINDING", "native child binding is not allowlisted");
    }
    if (typeof value !== "string" || value.length === 0) {
      fail("NATIVE_ENV_BINDING", "native child binding must be a non-empty string");
    }
    environment[key] = value;
  }
  return Object.freeze(environment);
}

async function readBoundedPlainFile(path, maximumBytes, label) {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 0 ||
    before.size > maximumBytes
  ) {
    fail("NATIVE_FILE_BOUND", `${label} is not a bounded plain file`);
  }
  const handle = await open(path, "r");
  try {
    const openedBefore = await handle.stat();
    if (
      !openedBefore.isFile() ||
      openedBefore.size < 0 ||
      openedBefore.size > maximumBytes ||
      before.dev !== openedBefore.dev ||
      before.ino !== openedBefore.ino
    ) {
      fail("NATIVE_FILE_CHANGED", `${label} changed while opened`);
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (
      !openedAfter.isFile() ||
      bytes.length !== openedAfter.size ||
      bytes.length > maximumBytes ||
      openedBefore.dev !== openedAfter.dev ||
      openedBefore.ino !== openedAfter.ino
    ) {
      fail("NATIVE_FILE_CHANGED", `${label} changed while read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function bigintObjectIdentity(stats) {
  return `${stats.dev.toString(10)}:${stats.ino.toString(10)}`;
}

async function observePlainDirectory(path, label) {
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    fail("NATIVE_TOOL_PATH", `${label} is not a plain directory`);
  }
  const canonical = await realpath(path);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    bigintObjectIdentity(before) !== bigintObjectIdentity(after) ||
    windowsPathCaseKey(canonical) !== windowsPathCaseKey(path)
  ) {
    fail("NATIVE_TOOL_PATH_CHANGED", `${label} changed during identity observation`);
  }
  return Object.freeze({
    canonical,
    objectIdentity: bigintObjectIdentity(before),
  });
}

async function observeBoundedExecutable(path, maximumBytes, label) {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail("NATIVE_TOOL_EXECUTABLE", `${label} is not a bounded plain file`);
  }
  const canonical = await realpath(path);
  const bytes = await readBoundedPlainFile(path, maximumBytes, label);
  const after = await lstat(path, { bigint: true });
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    bigintObjectIdentity(before) !== bigintObjectIdentity(after) ||
    before.size !== after.size ||
    BigInt(bytes.length) !== after.size ||
    windowsPathCaseKey(canonical) !== windowsPathCaseKey(path)
  ) {
    fail("NATIVE_TOOL_EXECUTABLE_CHANGED", `${label} changed during identity observation`);
  }
  return Object.freeze({
    canonical,
    objectIdentity: bigintObjectIdentity(before),
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}

function assertStableToolObservation(before, after, label) {
  if (
    windowsPathCaseKey(before.canonical) !== windowsPathCaseKey(after.canonical) ||
    before.objectIdentity !== after.objectIdentity ||
    before.bytes !== after.bytes ||
    before.sha256 !== after.sha256
  ) {
    fail("NATIVE_TOOL_EXECUTABLE_CHANGED", `${label} changed around execution`);
  }
}

function assertStableDirectoryObservation(before, after, label) {
  if (
    windowsPathCaseKey(before.canonical) !== windowsPathCaseKey(after.canonical) ||
    before.objectIdentity !== after.objectIdentity
  ) {
    fail("NATIVE_TOOL_PATH_CHANGED", `${label} changed around execution`);
  }
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, required, label) {
  if (!exactObject(value)) fail("NATIVE_SCHEMA_OBJECT", `${label} must be an object`);
  const expected = new Set(required);
  for (const key of Object.keys(value)) {
    if (!expected.has(key))
      fail("NATIVE_SCHEMA_UNKNOWN_KEY", `${label} contains an unexpected key`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      fail("NATIVE_SCHEMA_MISSING_KEY", `${label} is missing a required key`);
  }
}

function assertKeys(value, required, optional, label) {
  if (!exactObject(value)) fail("NATIVE_SCHEMA_OBJECT", `${label} must be an object`);
  const permitted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key))
      fail("NATIVE_SCHEMA_UNKNOWN_KEY", `${label} contains an unexpected key`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      fail("NATIVE_SCHEMA_MISSING_KEY", `${label} is missing a required key`);
  }
}

function requireString(value, label, { min = 1, max = 32767 } = {}) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.includes("\0")
  ) {
    fail("NATIVE_SCHEMA_STRING", `${label} is invalid`);
  }
  return value;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("NATIVE_SCHEMA_INTEGER", `${label} is outside the allowed range`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail("NATIVE_SCHEMA_BOOLEAN", `${label} must be a boolean`);
  return value;
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) fail("NATIVE_SCHEMA_ENUM", `${label} is invalid`);
  return value;
}

function requireNullableString(value, label, options) {
  return value === null ? null : requireString(value, label, options);
}

function requireNullableHex64(value, label) {
  return value === null ? null : requireHex64(value, label);
}

function requireNullableInteger(value, label, minimum, maximum) {
  return value === null ? null : requireInteger(value, label, minimum, maximum);
}

function requireHex64(value, label) {
  if (typeof value !== "string" || !lowerHex64.test(value)) {
    fail("NATIVE_SCHEMA_DIGEST", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function framedDigest(...fields) {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(String(field), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NATIVE_CANONICAL_JSON", "non-finite JSON number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!exactObject(value)) fail("NATIVE_CANONICAL_JSON", "non-JSON value");
  const result = {};
  for (const key of Object.keys(value).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  )) {
    if (value[key] === undefined) fail("NATIVE_CANONICAL_JSON", "undefined JSON field");
    result[key] = canonicalJson(value[key]);
  }
  return result;
}

function canonicalJsonSha256(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalJson(value)), "utf8"));
}

function canonicalJsonText(value) {
  return `${JSON.stringify(canonicalJson(value), null, 2)}\n`;
}

function nativeTranscriptSha256(payload) {
  return canonicalJsonSha256({
    domain: nativeTranscriptDomain,
    transcript: payload,
  });
}

function freezeJson(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry);
    return Object.freeze(value);
  }
  if (exactObject(value)) {
    for (const entry of Object.values(value)) freezeJson(entry);
    return Object.freeze(value);
  }
  return value;
}

function validatePreflightBinding(value) {
  assertExactKeys(
    value,
    [
      "campaignRunId",
      "candidateSha256",
      "preflightSha256",
      "executionBundleManifestSha256",
      "nativeHelperArtifactPath",
      "nativeHelperSha256",
      "nativeCandidateDigest",
      "nativeManifestSha256",
      "evidenceRootObjectIdentitySha256",
    ],
    "native preflight binding",
  );
  const campaignRunId = requireString(value.campaignRunId, "preflightBinding.campaignRunId", {
    min: 2,
    max: 128,
  });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(campaignRunId)) {
    fail("NATIVE_SCHEMA_IDENTIFIER", "preflightBinding.campaignRunId is invalid");
  }
  const nativeHelperArtifactPath = requireString(
    value.nativeHelperArtifactPath,
    "preflightBinding.nativeHelperArtifactPath",
    { max: 32767 },
  );
  if (
    nativeHelperArtifactPath.includes("\\") ||
    validateRelativeTarget(
      nativeHelperArtifactPath,
      "preflightBinding.nativeHelperArtifactPath",
    ).replaceAll("\\", "/") !== nativeHelperArtifactPath
  ) {
    fail(
      "NATIVE_SCHEMA_ARTIFACT_PATH",
      "preflightBinding.nativeHelperArtifactPath is not canonical",
    );
  }
  return Object.freeze({
    campaignRunId,
    candidateSha256: requireHex64(value.candidateSha256, "preflightBinding.candidateSha256"),
    preflightSha256: requireHex64(value.preflightSha256, "preflightBinding.preflightSha256"),
    executionBundleManifestSha256: requireHex64(
      value.executionBundleManifestSha256,
      "preflightBinding.executionBundleManifestSha256",
    ),
    nativeHelperArtifactPath,
    nativeHelperSha256: requireHex64(
      value.nativeHelperSha256,
      "preflightBinding.nativeHelperSha256",
    ),
    nativeCandidateDigest: requireHex64(
      value.nativeCandidateDigest,
      "preflightBinding.nativeCandidateDigest",
    ),
    nativeManifestSha256: requireHex64(
      value.nativeManifestSha256,
      "preflightBinding.nativeManifestSha256",
    ),
    evidenceRootObjectIdentitySha256: requireHex64(
      value.evidenceRootObjectIdentitySha256,
      "preflightBinding.evidenceRootObjectIdentitySha256",
    ),
  });
}

function randomId(prefix) {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function validateRunRootPathSyntax(runRoot) {
  requireString(runRoot, "runRoot");
  if (!isAbsolute(runRoot)) fail("NATIVE_RUN_ROOT", "runRoot must be absolute");
  if (runRoot.normalize("NFC") !== runRoot)
    fail("NATIVE_RUN_ROOT", "runRoot must be NFC-normalized");
  if (process.platform === "win32") {
    const normalDrive = /^[A-Za-z]:\\/u.test(runRoot);
    if (
      !normalDrive ||
      runRoot.startsWith("\\\\?\\") ||
      runRoot.startsWith("\\\\.\\") ||
      /GLOBALROOT/iu.test(runRoot)
    ) {
      fail("NATIVE_RUN_ROOT", "runRoot must use a canonical local-drive path");
    }
  }
}

function trimDirectorySeparators(path) {
  const root = process.platform === "win32" ? windowsPath.parse(path).root : sep;
  let trimmed = path;
  while (trimmed.length > root.length && /[\\/]$/u.test(trimmed)) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

function validateCanonicalCandidatePath(value, label) {
  validateCanonicalWindowsLocalDirectory(value, label, "NATIVE_CANDIDATE_PATH");
  if (trimDirectorySeparators(value) !== value) {
    fail("NATIVE_CANDIDATE_PATH", `${label} must not contain a trailing separator`);
  }
  return value;
}

function strictWindowsDescendantRelation(root, target, label) {
  const relation = windowsPath.relative(root, target);
  if (
    relation.length === 0 ||
    relation === ".." ||
    relation.startsWith("..\\") ||
    windowsPath.isAbsolute(relation)
  ) {
    fail("NATIVE_CANDIDATE_ROOT_ESCAPE", `${label} must be strictly beneath candidateRoot`);
  }
  const reconstructed = windowsPath.join(root, relation);
  if (reconstructed !== target) {
    if (windowsPathCaseKey(reconstructed) === windowsPathCaseKey(target)) {
      fail("NATIVE_PATH_CASE_COLLISION", `${label} has a case-colliding Windows path`);
    }
    fail("NATIVE_CANDIDATE_PATH_ALIAS", `${label} is not an exact descendant path`);
  }
  return relation;
}

export function resolveNativeCandidateArtifactPath({
  candidateRoot,
  candidateDirectory,
  assemblyPath,
} = {}) {
  assertExactKeys(
    { candidateRoot, candidateDirectory, assemblyPath },
    ["candidateRoot", "candidateDirectory", "assemblyPath"],
    "native candidate location",
  );
  const root = validateCanonicalCandidatePath(candidateRoot, "candidateRoot");
  const directory = validateCanonicalCandidatePath(candidateDirectory, "candidateDirectory");
  const assembly = validateCanonicalCandidatePath(assemblyPath, "assemblyPath");
  strictWindowsDescendantRelation(root, directory, "candidateDirectory");
  strictWindowsDescendantRelation(root, assembly, "assemblyPath");
  if (windowsPath.dirname(assembly) !== directory) {
    const expectedDirectory = windowsPath.dirname(assembly);
    if (windowsPathCaseKey(expectedDirectory) === windowsPathCaseKey(directory)) {
      fail("NATIVE_PATH_CASE_COLLISION", "assemblyPath has a case-colliding candidateDirectory");
    }
    fail("NATIVE_CANDIDATE_DIRECTORY", "assemblyPath must be directly beneath candidateDirectory");
  }
  const portable = windowsPath.relative(root, assembly).replaceAll("\\", "/");
  validateRelativeTarget(portable, "native candidate artifact path");
  return portable;
}

async function validateRunRoot(runRoot) {
  validateRunRootPathSyntax(runRoot);
  const before = await lstat(runRoot, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    fail("NATIVE_RUN_ROOT", "runRoot must be a plain directory");
  }
  const canonical = trimDirectorySeparators(await realpath(runRoot));
  validateRunRootPathSyntax(canonical);
  const canonicalBefore = await lstat(canonical, { bigint: true });
  const after = await lstat(runRoot, { bigint: true });
  const canonicalAfter = await lstat(canonical, { bigint: true });
  const identity = bigintObjectIdentity(before);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !canonicalBefore.isDirectory() ||
    canonicalBefore.isSymbolicLink() ||
    !canonicalAfter.isDirectory() ||
    canonicalAfter.isSymbolicLink() ||
    identity !== bigintObjectIdentity(after) ||
    identity !== bigintObjectIdentity(canonicalBefore) ||
    identity !== bigintObjectIdentity(canonicalAfter) ||
    trimDirectorySeparators(await realpath(runRoot)) !== canonical
  ) {
    fail("NATIVE_RUN_ROOT_CHANGED", "runRoot changed during validation");
  }
  return Object.freeze({
    canonical,
    launchPath: canonical,
    identity,
  });
}

async function assertRunRootUnchanged(expected) {
  const observed = await validateRunRoot(expected.canonical);
  const sameCanonical =
    process.platform === "win32"
      ? windowsPathCaseKey(observed.canonical) === windowsPathCaseKey(expected.canonical)
      : observed.canonical === expected.canonical;
  if (!sameCanonical || observed.identity !== expected.identity) {
    fail("NATIVE_RUN_ROOT_CHANGED", "canonical runRoot changed across native startup");
  }
}

async function observeExactCandidateDirectory(path, label) {
  const exactPath = validateCanonicalCandidatePath(path, label);
  const observed = await validateRunRoot(exactPath);
  if (observed.canonical !== exactPath) {
    if (windowsPathCaseKey(observed.canonical) === windowsPathCaseKey(exactPath)) {
      fail("NATIVE_PATH_CASE_COLLISION", `${label} differs only by Windows path casing`);
    }
    fail("NATIVE_CANDIDATE_PATH_ALIAS", `${label} resolves through a path alias`);
  }
  return observed;
}

async function assertCandidateDirectoryUnchanged(expected, label) {
  const observed = await observeExactCandidateDirectory(expected.canonical, label);
  if (observed.identity !== expected.identity) {
    fail("NATIVE_CANDIDATE_OBJECT_SUBSTITUTED", `${label} object identity changed`);
  }
}

function candidatePathContains(root, target) {
  const relation = windowsPath.relative(root, target);
  return (
    relation.length === 0 ||
    (relation !== ".." && !relation.startsWith("..\\") && !windowsPath.isAbsolute(relation))
  );
}

function assertCandidateRunRootDisjoint(runRoot, candidateRoot) {
  if (
    candidatePathContains(runRoot, candidateRoot) ||
    candidatePathContains(candidateRoot, runRoot)
  ) {
    fail(
      "NATIVE_CANDIDATE_RUN_ROOT_OVERLAP",
      "candidateRoot and runRoot must be disjoint mutation namespaces",
    );
  }
}

async function snapshotSources(buildDirectory) {
  const snapshotDirectory = join(buildDirectory, "source");
  await mkdir(snapshotDirectory, { recursive: false, mode: 0o700 });
  const sources = [];
  for (const name of sourceAllowlist) {
    const sourcePath = join(sourceDirectory, name);
    const bytesBefore = await readBoundedPlainFile(sourcePath, 2 * 1024 * 1024, "native source");
    const digestBefore = sha256(bytesBefore);
    const destinationPath = join(snapshotDirectory, name);
    const handle = await open(destinationPath, "wx", 0o600);
    try {
      await handle.writeFile(bytesBefore);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const bytesAfter = await readBoundedPlainFile(sourcePath, 2 * 1024 * 1024, "native source");
    const snapshotBytes = await readBoundedPlainFile(
      destinationPath,
      2 * 1024 * 1024,
      "snapshotted native source",
    );
    if (digestBefore !== sha256(bytesAfter) || digestBefore !== sha256(snapshotBytes)) {
      fail("NATIVE_SOURCE_CHANGED", "native source changed while snapshotted");
    }
    sources.push(Object.freeze({ name, sha256: digestBefore, bytes: bytesBefore.length }));
  }
  return { snapshotDirectory, sources };
}

export function describeSingleJsonFrameShape(stdout) {
  const bytes = Buffer.from(stdout);
  const startsWith = (...signature) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  return Object.freeze({
    stdoutBytes: bytes.length,
    utf8NonemptyLines: bytes
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line.length > 0).length,
    utf8Bom: startsWith(0xef, 0xbb, 0xbf),
    utf16LeBom: startsWith(0xff, 0xfe),
    utf16BeBom: startsWith(0xfe, 0xff),
    utf16LeJsonSignature: startsWith(0x7b, 0x00) || startsWith(0xff, 0xfe, 0x7b, 0x00),
    utf16BeJsonSignature: startsWith(0x00, 0x7b) || startsWith(0xfe, 0xff, 0x00, 0x7b),
    nulBytes: bytes.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0),
  });
}

function singleJsonFrameShapeDetail(stdout, processFacts) {
  const shape = describeSingleJsonFrameShape(stdout);
  const processDetail =
    processFacts === undefined
      ? "process=unavailable"
      : `exit=${String(processFacts.code)},signal=${processFacts.signal ?? "none"},stderrBytes=${String(processFacts.stderrBytes)}`;
  return `stdoutBytes=${String(shape.stdoutBytes)},utf8NonemptyLines=${String(shape.utf8NonemptyLines)},utf8Bom=${String(shape.utf8Bom)},utf16LeBom=${String(shape.utf16LeBom)},utf16BeBom=${String(shape.utf16BeBom)},utf16LeJsonSignature=${String(shape.utf16LeJsonSignature)},utf16BeJsonSignature=${String(shape.utf16BeJsonSignature)},nulBytes=${String(shape.nulBytes)},${processDetail}`;
}

function parseSingleJsonLine(stdout, label, processFacts) {
  const text = stdout.toString("utf8");
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length !== 1)
    fail(
      "NATIVE_PROCESS_PROTOCOL",
      `${label} did not emit exactly one JSON line (${singleJsonFrameShapeDetail(stdout, processFacts)})`,
    );
  try {
    return JSON.parse(lines[0]);
  } catch {
    fail(
      "NATIVE_PROCESS_PROTOCOL",
      `${label} did not emit valid JSON (${singleJsonFrameShapeDetail(stdout, processFacts)})`,
    );
  }
}

function runBounded(
  executable,
  args,
  {
    cwd,
    env,
    bindings,
    timeoutMs,
    signal,
    maxStdout = maxOutputFrameBytes,
    maxStderr = maxStderrBytes,
  } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd,
      env: buildNativeChildEnvironment(env, bindings),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalError = null;
    let timer;
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action(value);
    };
    const stop = (error) => {
      if (settled || terminalError !== null) return;
      terminalError = error;
      child.kill();
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        stop(
          new NativeClientError("NATIVE_STDOUT_LIMIT", "native child exceeded its stdout limit"),
        );
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderr) {
        stop(
          new NativeClientError("NATIVE_STDERR_LIMIT", "native child exceeded its stderr limit"),
        );
      } else stderr.push(chunk);
    });
    child.once("error", () => {
      settle(
        rejectPromise,
        terminalError ?? new NativeClientError("NATIVE_SPAWN", "native child could not be started"),
      );
    });
    child.once("exit", (code, exitSignal) => {
      if (terminalError !== null) settle(rejectPromise, terminalError);
      else
        settle(resolvePromise, {
          code,
          signal: exitSignal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
    });
    timer = setTimeout(
      () => stop(new NativeClientError("NATIVE_TIMEOUT", "native child exceeded its deadline")),
      timeoutMs,
    );
    const abort = () => stop(new NativeClientError("NATIVE_ABORTED", "native child was aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

const createOwnedDirectoryPowerShell = String.raw`$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ENDURAGENT_NATIVE_PRIVATE_DIRECTORY_PATH')
$nonce = [Environment]::GetEnvironmentVariable('ENDURAGENT_NATIVE_PRIVATE_DIRECTORY_NONCE')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = New-Object Security.AccessControl.DirectorySecurity
$security.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = New-Object Security.AccessControl.FileSystemAccessRule -ArgumentList @(
  $sid,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
$security.AddAccessRule($rule)
$security.SetOwner($sid)
$directory = [IO.Directory]::CreateDirectory($path, $security)
if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 42 }
$actual = $directory.GetAccessControl(
  [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
)
$owner = $actual.GetOwner([Security.Principal.SecurityIdentifier])
$rules = @($actual.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
if (!$actual.AreAccessRulesProtected -or $owner.Value -cne $sid.Value -or $rules.Count -ne 1) { exit 43 }
$actualRule = $rules[0]
if (
  $actualRule.IsInherited -or
  $actualRule.IdentityReference.Value -cne $sid.Value -or
  $actualRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
  $actualRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
  $actualRule.InheritanceFlags -ne $inheritance -or
  $actualRule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None
) { exit 44 }
[Console]::Out.WriteLine($nonce)`;

export function describePrivateDirectoryCreationFailure({
  code,
  signal,
  stderrBytes,
  stdoutMatchesNonce,
}) {
  if (signal !== null) return "PowerShell terminated before proving the directory ACL";
  if (code === 0 && stdoutMatchesNonce) return null;
  if (stderrBytes !== 0) {
    return `PowerShell emitted ${String(stderrBytes)} stderr bytes (exit ${String(code)}, nonce ${stdoutMatchesNonce ? "matched" : "mismatched"})`;
  }
  if (code === 42) return "PowerShell observed a reparse point after directory creation";
  if (code === 43)
    return "PowerShell observed a mismatched owner, DACL protection flag, or explicit ACE count";
  if (code === 44) return "PowerShell observed an inexact owner-only Full Control ACE";
  if (code !== 0) return `PowerShell exited with code ${String(code)}`;
  return "PowerShell did not return the private-directory nonce";
}

async function createOwnedWindowsDirectory({
  parentDirectory,
  leaf,
  toolPaths,
  loadedSystemLibraries,
  timeoutMs,
  signal,
  label,
}) {
  const parent = await validateRunRoot(parentDirectory);
  const directoryPath = join(parent.canonical, leaf);
  validateCanonicalWindowsLocalDirectory(directoryPath, label, "NATIVE_PRIVATE_DIRECTORY_PATH");
  const nonce = randomBytes(32).toString("hex");
  const encodedCommand = Buffer.from(createOwnedDirectoryPowerShell, "utf16le").toString("base64");
  const created = await runBounded(
    toolPaths.powerShellExecutable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      cwd: parent.canonical,
      env: buildNativeToolEnvironment(
        { SystemRoot: toolPaths.systemRoot, WINDIR: toolPaths.systemRoot },
        parent.canonical,
        loadedSystemLibraries,
      ),
      bindings: {
        ENDURAGENT_NATIVE_PRIVATE_DIRECTORY_PATH: directoryPath,
        ENDURAGENT_NATIVE_PRIVATE_DIRECTORY_NONCE: nonce,
      },
      timeoutMs,
      signal,
      maxStdout: 256,
      maxStderr: maxStderrBytes,
    },
  );
  const failureReason = describePrivateDirectoryCreationFailure({
    code: created.code,
    signal: created.signal,
    stderrBytes: created.stderr.length,
    stdoutMatchesNonce: created.stdout.toString("utf8").replace(/\r?\n$/u, "") === nonce,
  });
  if (failureReason !== null) {
    fail(
      "NATIVE_PRIVATE_DIRECTORY",
      `${label} could not be created with a protected owner ACL: ${failureReason}`,
    );
  }
  const owned = await validateRunRoot(directoryPath);
  await assertRunRootUnchanged(parent);
  if (windowsPathCaseKey(dirname(owned.canonical)) !== windowsPathCaseKey(parent.canonical)) {
    fail("NATIVE_PRIVATE_DIRECTORY", `${label} escaped its validated parent`);
  }
  return owned;
}

async function assertOwnedWindowsDirectory({
  expected,
  parentDirectory,
  toolPaths,
  loadedSystemLibraries,
  timeoutMs,
  signal,
  label,
}) {
  const observed = await createOwnedWindowsDirectory({
    parentDirectory,
    leaf: basename(expected.canonical),
    toolPaths,
    loadedSystemLibraries,
    timeoutMs,
    signal,
    label,
  });
  if (
    windowsPathCaseKey(observed.canonical) !== windowsPathCaseKey(expected.canonical) ||
    observed.identity !== expected.identity
  ) {
    fail("NATIVE_PRIVATE_DIRECTORY_CHANGED", `${label} changed after protected creation`);
  }
}

const launchHoldPowerShell = String.raw`$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('ENDURAGENT_NATIVE_LOCK_PATH')
$expected = [Environment]::GetEnvironmentVariable('ENDURAGENT_NATIVE_LOCK_SHA256')
$nonce = [Environment]::GetEnvironmentVariable('ENDURAGENT_NATIVE_LOCK_NONCE')
$stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  if ($actual -cne $expected) { exit 41 }
  [Console]::Out.WriteLine($nonce + ':' + $actual)
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
}
finally { $stream.Dispose() }`;

function withTimeout(promise, timeoutMs, onTimeout, code, message) {
  let timer;
  const timeout = new Promise((_, rejectPromise) => {
    timer = setTimeout(() => {
      onTimeout();
      rejectPromise(new NativeClientError(code, message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startAssemblyLaunchHold(
  build,
  { runRoot, timeoutMs, signal, createProtectedTemp = true },
) {
  const loadedSystemLibraries = loadedWindowsSystemLibraries();
  const toolPaths = resolveNativeWindowsToolPaths(process.env, loadedSystemLibraries);
  const systemRootBefore = await observePlainDirectory(toolPaths.systemRoot, "SystemRoot");
  const powerShellBefore = await observeBoundedExecutable(
    toolPaths.powerShellExecutable,
    16 * 1024 * 1024,
    "Windows PowerShell launch holder",
  );
  if (
    powerShellBefore.sha256 !== build.toolchain.powerShellExecutableSha256Before ||
    powerShellBefore.sha256 !== build.toolchain.powerShellExecutableSha256After
  ) {
    fail(
      "NATIVE_LAUNCH_HOLDER_IDENTITY",
      "Windows PowerShell differs from the native build toolchain identity",
    );
  }
  const temp = createProtectedTemp
    ? await createOwnedWindowsDirectory({
        parentDirectory: runRoot,
        leaf: `launch-temp-${randomBytes(12).toString("hex")}`,
        toolPaths,
        loadedSystemLibraries,
        timeoutMs,
        signal,
        label: "native launch-holder temp directory",
      })
    : null;
  const tempDirectory = temp?.canonical ?? runRoot;
  const nonce = randomBytes(32).toString("hex");
  const encodedCommand = Buffer.from(launchHoldPowerShell, "utf16le").toString("base64");
  const child = spawn(
    toolPaths.powerShellExecutable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      cwd: runRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildNativeChildEnvironment(
        buildNativeToolEnvironment(
          { SystemRoot: toolPaths.systemRoot, WINDIR: toolPaths.systemRoot },
          tempDirectory,
          loadedSystemLibraries,
        ),
        {
          ENDURAGENT_NATIVE_LOCK_PATH: build.assemblyPath,
          ENDURAGENT_NATIVE_LOCK_SHA256: build.assemblySha256,
          ENDURAGENT_NATIVE_LOCK_NONCE: nonce,
        },
      ),
    },
  );
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let ready = false;
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", () =>
      rejectExit(
        new NativeClientError(
          "NATIVE_LAUNCH_HOLDER_SPAWN",
          "assembly launch holder could not be started",
        ),
      ),
    );
    child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
  });
  const readyPromise = new Promise((resolveReady, rejectReady) => {
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > 256) {
        child.kill();
        rejectReady(
          new NativeClientError(
            "NATIVE_LAUNCH_HOLDER_PROTOCOL",
            "assembly launch holder exceeded its response bound",
          ),
        );
        return;
      }
      const newline = stdout.indexOf(0x0a);
      if (newline < 0 || ready) return;
      const line = stdout.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
      if (line !== `${nonce}:${build.assemblySha256}` || stdout.length !== newline + 1) {
        child.kill();
        rejectReady(
          new NativeClientError(
            "NATIVE_LAUNCH_HOLDER_PROTOCOL",
            "assembly launch holder identity response is invalid",
          ),
        );
        return;
      }
      ready = true;
      resolveReady(undefined);
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > maxStderrBytes) child.kill();
    });
    exit.then(({ code }) => {
      if (!ready)
        rejectReady(
          new NativeClientError(
            "NATIVE_LAUNCH_HOLDER_EXIT",
            `assembly launch holder exited before readiness (${String(code)})`,
          ),
        );
    }, rejectReady);
  });
  const abort = () => child.kill();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let observationsFinalized = false;
  const finalizeObservations = async () => {
    if (observationsFinalized) return;
    observationsFinalized = true;
    let identityError;
    try {
      if (temp !== null) {
        await assertOwnedWindowsDirectory({
          expected: temp,
          parentDirectory: runRoot,
          toolPaths,
          loadedSystemLibraries,
          timeoutMs,
          signal,
          label: "native launch-holder temp directory",
        });
      }
      const [systemRootAfter, powerShellAfter] = await Promise.all([
        observePlainDirectory(toolPaths.systemRoot, "SystemRoot"),
        observeBoundedExecutable(
          toolPaths.powerShellExecutable,
          16 * 1024 * 1024,
          "Windows PowerShell launch holder",
        ),
      ]);
      assertStableDirectoryObservation(systemRootBefore, systemRootAfter, "SystemRoot");
      assertStableToolObservation(
        powerShellBefore,
        powerShellAfter,
        "Windows PowerShell launch holder",
      );
    } catch (error) {
      identityError = error;
    }
    let cleanupFailed = false;
    if (temp !== null) {
      try {
        await rm(tempDirectory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (identityError !== undefined) throw identityError;
    if (cleanupFailed) {
      fail("NATIVE_LAUNCH_HOLDER_TEMP", "owned launch-holder temp directory could not be removed");
    }
  };
  try {
    await withTimeout(
      readyPromise,
      timeoutMs,
      () => child.kill(),
      "NATIVE_LAUNCH_HOLDER_TIMEOUT",
      "assembly launch holder did not become ready",
    );
  } catch (error) {
    child.kill();
    await exit.catch(() => undefined);
    signal?.removeEventListener("abort", abort);
    await finalizeObservations();
    throw error;
  }
  let released = false;
  return Object.freeze({
    release: async () => {
      if (released)
        fail("NATIVE_LAUNCH_HOLDER_RELEASED", "assembly launch hold was already released");
      released = true;
      child.stdin.end("release\n");
      let result;
      let releaseError;
      try {
        result = await withTimeout(
          exit,
          timeoutMs,
          () => child.kill(),
          "NATIVE_LAUNCH_HOLDER_TIMEOUT",
          "assembly launch holder did not release",
        );
      } catch (error) {
        releaseError = error;
        await exit.catch(() => undefined);
      }
      signal?.removeEventListener("abort", abort);
      await finalizeObservations();
      if (releaseError !== undefined) throw releaseError;
      if (
        result.code !== 0 ||
        result.signal !== null ||
        stderr.length !== 0 ||
        stdout.toString("utf8").replace(/\r?\n$/u, "") !== `${nonce}:${build.assemblySha256}`
      ) {
        fail("NATIVE_LAUNCH_HOLDER_EXIT", "assembly launch holder exited unsuccessfully");
      }
    },
    abort: async () => {
      if (!released) {
        released = true;
        child.kill();
      }
      await exit.catch(() => undefined);
      signal?.removeEventListener("abort", abort);
      await finalizeObservations();
    },
  });
}

function validateBuildMetadata(value, sources) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "powerShellVersion",
      "powerShellEdition",
      "clrVersion",
      "codeDomProvider",
      "codeDomProviderAssemblyVersion",
      "cscFileVersion",
      "cscSha256Before",
      "cscSha256After",
      "powerShellExecutableSha256Before",
      "powerShellExecutableSha256After",
      "runtimeDirectorySha256Before",
      "runtimeDirectorySha256After",
      "runtimeRelativeInventory",
      "outputType",
      "platform",
      "compilerOptions",
      "referencedAssemblies",
      "referenceSha256Before",
      "referenceSha256After",
      "addTypeInvocation",
      "sourceSha256Before",
      "sourceSha256After",
      "assemblySha256",
    ],
    "native build metadata",
  );
  for (const key of [
    "powerShellVersion",
    "clrVersion",
    "codeDomProviderAssemblyVersion",
    "cscFileVersion",
    "compilerOptions",
    "addTypeInvocation",
  ])
    requireString(value[key], `build.${key}`, { max: 2048 });
  if (
    value.schemaVersion !== 1 ||
    value.powerShellEdition !== "Desktop" ||
    value.outputType !== "ConsoleApplication" ||
    value.platform !== "x64" ||
    value.codeDomProvider !== "Microsoft.CSharp.CSharpCodeProvider" ||
    !(value.powerShellVersion === "5.1" || value.powerShellVersion.startsWith("5.1.")) ||
    !value.clrVersion.startsWith("4.") ||
    value.compilerOptions !== requiredCompilerOptions ||
    value.addTypeInvocation !== requiredAddTypeInvocation
  ) {
    fail("NATIVE_BUILD_IDENTITY", "native build metadata did not match the required toolchain");
  }
  for (const key of [
    "cscSha256Before",
    "cscSha256After",
    "powerShellExecutableSha256Before",
    "powerShellExecutableSha256After",
    "runtimeDirectorySha256Before",
    "runtimeDirectorySha256After",
    "assemblySha256",
  ])
    requireHex64(value[key], `build.${key}`);
  if (
    value.cscSha256Before !== value.cscSha256After ||
    value.powerShellExecutableSha256Before !== value.powerShellExecutableSha256After ||
    value.runtimeDirectorySha256Before !== value.runtimeDirectorySha256After
  ) {
    fail("NATIVE_BUILD_TOOL_CHANGED", "native compiler executable changed during compilation");
  }
  if (
    !Array.isArray(value.referencedAssemblies) ||
    JSON.stringify(value.referencedAssemblies) !==
      JSON.stringify([
        "System.dll",
        "System.Core.dll",
        "System.Security.dll",
        "System.Web.Extensions.dll",
      ])
  )
    fail("NATIVE_BUILD_REFERENCES", "native build reference allowlist changed");
  if (
    !Array.isArray(value.runtimeRelativeInventory) ||
    JSON.stringify(value.runtimeRelativeInventory) !==
      JSON.stringify([
        "System.Core.dll",
        "System.Security.dll",
        "System.Web.Extensions.dll",
        "System.dll",
        "csc.exe",
      ])
  )
    fail("NATIVE_BUILD_RUNTIME", "native runtime relative inventory changed");
  for (const key of ["sourceSha256Before", "sourceSha256After"]) {
    if (!Array.isArray(value[key]) || value[key].length !== csharpSourceAllowlist.length) {
      fail("NATIVE_BUILD_SOURCES", "native build source identity is incomplete");
    }
    value[key].forEach((entry, index) => {
      assertExactKeys(entry, ["name", "sha256"], `build.${key} entry`);
      if (entry.name !== csharpSourceAllowlist[index])
        fail("NATIVE_BUILD_SOURCES", "native source order changed");
      requireHex64(entry.sha256, `build.${key}.sha256`);
      const expected = sources.find((source) => source.name === entry.name)?.sha256;
      if (entry.sha256 !== expected) fail("NATIVE_BUILD_SOURCES", "compiled source digest changed");
    });
  }
  for (const key of ["referenceSha256Before", "referenceSha256After"]) {
    if (!Array.isArray(value[key]) || value[key].length !== value.referencedAssemblies.length) {
      fail("NATIVE_BUILD_REFERENCES", "native framework reference identity is incomplete");
    }
    value[key].forEach((entry, index) => {
      assertExactKeys(entry, ["name", "sha256"], `build.${key} entry`);
      if (entry.name !== value.referencedAssemblies[index])
        fail("NATIVE_BUILD_REFERENCES", "framework reference order changed");
      requireHex64(entry.sha256, `build.${key}.sha256`);
    });
  }
  if (JSON.stringify(value.referenceSha256Before) !== JSON.stringify(value.referenceSha256After)) {
    fail("NATIVE_BUILD_REFERENCE_CHANGED", "framework reference changed during compilation");
  }
  return value;
}

function assertAmd64Pe(bytes) {
  if (bytes.length < 512 || bytes.readUInt16LE(0) !== 0x5a4d) {
    fail("NATIVE_ASSEMBLY_FORMAT", "native helper is not a PE image");
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset < 64 ||
    peOffset + 24 > bytes.length ||
    bytes.readUInt32LE(peOffset) !== 0x00004550 ||
    bytes.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    fail("NATIVE_ASSEMBLY_ARCHITECTURE", "native helper PE machine is not AMD64");
  }
}

export async function buildNativeHelper({ runRoot, timeoutMs = 60_000, signal } = {}) {
  if (process.platform !== "win32")
    fail("NATIVE_PLATFORM", "native helper compilation requires Windows");
  if (process.arch !== "x64")
    fail("NATIVE_ARCHITECTURE", "native helper compilation requires x64 Node");
  const owned = await validateRunRoot(runRoot);
  const loadedSystemLibraries = loadedWindowsSystemLibraries();
  const toolPaths = resolveNativeWindowsToolPaths(process.env, loadedSystemLibraries);
  const systemRootBefore = await observePlainDirectory(toolPaths.systemRoot, "SystemRoot");
  const powerShellBefore = await observeBoundedExecutable(
    toolPaths.powerShellExecutable,
    16 * 1024 * 1024,
    "Windows PowerShell compiler",
  );
  const buildRoot = await createOwnedWindowsDirectory({
    parentDirectory: owned.canonical,
    leaf: `native-build-${randomBytes(12).toString("hex")}`,
    toolPaths,
    loadedSystemLibraries,
    timeoutMs,
    signal,
    label: "native build directory",
  });
  const buildDirectory = buildRoot.canonical;
  const { snapshotDirectory, sources } = await snapshotSources(buildDirectory);
  const assemblyPath = join(buildDirectory, "windows-host-falsifier-native.exe");
  const temp = await createOwnedWindowsDirectory({
    parentDirectory: buildDirectory,
    leaf: `temp-${randomBytes(12).toString("hex")}`,
    toolPaths,
    loadedSystemLibraries,
    timeoutMs,
    signal,
    label: "native compiler temp directory",
  });
  const tempDirectory = temp.canonical;
  let compiled;
  let executionError;
  try {
    compiled = await runBounded(
      toolPaths.powerShellExecutable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(snapshotDirectory, "compile.ps1"),
        "-SourceRoot",
        snapshotDirectory,
        "-OutputAssembly",
        assemblyPath,
      ],
      {
        cwd: buildDirectory,
        env: buildNativeToolEnvironment(
          { SystemRoot: toolPaths.systemRoot, WINDIR: toolPaths.systemRoot },
          tempDirectory,
          loadedSystemLibraries,
        ),
        timeoutMs,
        signal,
      },
    );
  } catch (error) {
    executionError = error;
  }
  let identityError;
  try {
    await assertOwnedWindowsDirectory({
      expected: buildRoot,
      parentDirectory: owned.canonical,
      toolPaths,
      loadedSystemLibraries,
      timeoutMs,
      signal,
      label: "native build directory",
    });
    await assertOwnedWindowsDirectory({
      expected: temp,
      parentDirectory: buildDirectory,
      toolPaths,
      loadedSystemLibraries,
      timeoutMs,
      signal,
      label: "native compiler temp directory",
    });
    const [systemRootAfter, powerShellAfter] = await Promise.all([
      observePlainDirectory(toolPaths.systemRoot, "SystemRoot"),
      observeBoundedExecutable(
        toolPaths.powerShellExecutable,
        16 * 1024 * 1024,
        "Windows PowerShell compiler",
      ),
    ]);
    assertStableDirectoryObservation(systemRootBefore, systemRootAfter, "SystemRoot");
    assertStableToolObservation(powerShellBefore, powerShellAfter, "Windows PowerShell compiler");
    await assertRunRootUnchanged(owned);
    await assertRunRootUnchanged(buildRoot);
  } catch (error) {
    identityError = error;
  }
  let cleanupError;
  try {
    await rm(tempDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (identityError !== undefined) throw identityError;
  if (executionError !== undefined) throw executionError;
  if (cleanupError !== undefined) {
    fail("NATIVE_BUILD_TEMP", "owned native build temp directory could not be removed");
  }
  if (compiled.code !== 0 || compiled.signal !== null || compiled.stderr.length !== 0) {
    fail("NATIVE_BUILD_FAILED", "Windows PowerShell Add-Type compilation failed");
  }
  const metadata = validateBuildMetadata(
    parseSingleJsonLine(compiled.stdout, "native compiler", {
      code: compiled.code,
      signal: compiled.signal,
      stderrBytes: compiled.stderr.length,
    }),
    sources,
  );
  if (
    metadata.powerShellExecutableSha256Before !== powerShellBefore.sha256 ||
    metadata.powerShellExecutableSha256After !== powerShellBefore.sha256
  ) {
    fail(
      "NATIVE_BUILD_TOOL_IDENTITY",
      "compiler metadata differs from the independently observed PowerShell identity",
    );
  }
  const assemblyBytes = await readBoundedPlainFile(
    assemblyPath,
    16 * 1024 * 1024,
    "native helper assembly",
  );
  if (assemblyBytes.length === 0 || assemblyBytes.length > 16 * 1024 * 1024) {
    fail("NATIVE_ASSEMBLY_SIZE", "native helper assembly size is invalid");
  }
  assertAmd64Pe(assemblyBytes);
  const assemblySha256 = sha256(assemblyBytes);
  if (assemblySha256 !== metadata.assemblySha256) {
    fail("NATIVE_ASSEMBLY_CHANGED", "native helper assembly digest did not match compiler output");
  }
  const assemblyObservation = await observeBoundedExecutable(
    assemblyPath,
    16 * 1024 * 1024,
    "native helper assembly",
  );
  if (
    assemblyObservation.sha256 !== assemblySha256 ||
    assemblyObservation.bytes !== assemblyBytes.length
  ) {
    fail("NATIVE_ASSEMBLY_CHANGED", "native helper assembly changed after compilation");
  }
  const sourceBundleSha256 = deriveNativeSourceBundleSha256(sources);
  const toolchainDigest = deriveNativeToolchainDigest(metadata);
  const candidateDigest = deriveNativeCandidateDigest({
    sourceBundleSha256,
    assemblySha256,
    toolchainDigest,
  });
  const manifest = {
    schemaVersion: 1,
    candidateDigest,
    assembly: { name: basename(assemblyPath), sha256: assemblySha256 },
    sourceBundleSha256,
    toolchainDigest,
    sources,
    toolchain: metadata,
  };
  const manifestBytes = Buffer.from(canonicalJsonText(manifest), "utf8");
  const manifestPath = join(buildDirectory, "native-candidate.json");
  const manifestHandle = await open(manifestPath, "wx", 0o600);
  try {
    await manifestHandle.writeFile(manifestBytes);
    await manifestHandle.sync();
  } finally {
    await manifestHandle.close();
  }
  const build = Object.freeze({
    assemblyPath,
    buildDirectory,
    candidateRoot: owned.canonical,
    candidateDirectory: buildDirectory,
    nativeHelperArtifactPath: resolveNativeCandidateArtifactPath({
      candidateRoot: owned.canonical,
      candidateDirectory: buildDirectory,
      assemblyPath,
    }),
    snapshotDirectory,
    assemblySha256,
    sourceBundleSha256,
    toolchainDigest,
    candidateDigest,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    sources: Object.freeze(sources),
    toolchain: Object.freeze({ ...metadata }),
  });
  buildAssemblyObjectIdentities.set(build, assemblyObservation.objectIdentity);
  buildCandidateBindings.set(
    build,
    Object.freeze({ candidateRoot: owned, candidateDirectory: buildRoot }),
  );
  return build;
}

export async function loadNativeHelper({ candidateRoot, candidateDirectory } = {}) {
  const root = await observeExactCandidateDirectory(candidateRoot, "candidateRoot");
  const directory = await observeExactCandidateDirectory(candidateDirectory, "candidateDirectory");
  strictWindowsDescendantRelation(root.canonical, directory.canonical, "candidateDirectory");
  const manifestPath = join(directory.canonical, "native-candidate.json");
  const manifestBytes = await readBoundedPlainFile(
    manifestPath,
    maxOutputFrameBytes,
    "native candidate manifest",
  );
  if (
    manifestBytes.length === 0 ||
    manifestBytes.length > maxOutputFrameBytes ||
    manifestBytes.at(-1) !== 0x0a
  ) {
    fail("NATIVE_CANDIDATE_MANIFEST", "native candidate manifest is invalid");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("NATIVE_CANDIDATE_MANIFEST", "native candidate manifest is not valid JSON");
  }
  if (canonicalJsonText(manifest) !== manifestBytes.toString("utf8")) {
    fail("NATIVE_CANDIDATE_MANIFEST", "native candidate manifest is not exact canonical JSON");
  }
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "candidateDigest",
      "assembly",
      "sourceBundleSha256",
      "toolchainDigest",
      "sources",
      "toolchain",
    ],
    "native candidate manifest",
  );
  if (manifest.schemaVersion !== 1)
    fail("NATIVE_CANDIDATE_MANIFEST", "native candidate manifest version is invalid");
  assertExactKeys(manifest.assembly, ["name", "sha256"], "native candidate assembly");
  if (manifest.assembly.name !== "windows-host-falsifier-native.exe")
    fail("NATIVE_CANDIDATE_ASSEMBLY", "native candidate assembly name is invalid");
  requireHex64(manifest.assembly.sha256, "candidate assembly sha256");
  requireHex64(manifest.candidateDigest, "candidate digest");
  requireHex64(manifest.sourceBundleSha256, "source bundle digest");
  requireHex64(manifest.toolchainDigest, "toolchain digest");
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== sourceAllowlist.length) {
    fail("NATIVE_CANDIDATE_SOURCES", "native candidate source inventory is invalid");
  }
  const sources = manifest.sources.map((source, index) => {
    assertExactKeys(source, ["name", "sha256", "bytes"], "native candidate source");
    if (source.name !== sourceAllowlist[index])
      fail("NATIVE_CANDIDATE_SOURCES", "native candidate source order is invalid");
    requireHex64(source.sha256, "native candidate source digest");
    requireInteger(source.bytes, "native candidate source bytes", 1, 2 * 1024 * 1024);
    return Object.freeze({ ...source });
  });
  const snapshotDirectory = join(directory.canonical, "source");
  for (const source of sources) {
    const bytes = await readBoundedPlainFile(
      join(snapshotDirectory, source.name),
      2 * 1024 * 1024,
      "native candidate source",
    );
    if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256)
      fail("NATIVE_CANDIDATE_SOURCE_CHANGED", "native candidate source digest changed");
  }
  const sourceBundleSha256 = deriveNativeSourceBundleSha256(sources);
  if (sourceBundleSha256 !== manifest.sourceBundleSha256)
    fail("NATIVE_CANDIDATE_SOURCE_CHANGED", "native candidate source bundle changed");
  const metadata = validateBuildMetadata(manifest.toolchain, sources);
  const assemblyPath = join(directory.canonical, manifest.assembly.name);
  const nativeHelperArtifactPath = resolveNativeCandidateArtifactPath({
    candidateRoot: root.canonical,
    candidateDirectory: directory.canonical,
    assemblyPath,
  });
  const assemblyBytes = await readBoundedPlainFile(
    assemblyPath,
    16 * 1024 * 1024,
    "native candidate assembly",
  );
  assertAmd64Pe(assemblyBytes);
  const assemblySha256 = sha256(assemblyBytes);
  if (assemblySha256 !== manifest.assembly.sha256 || assemblySha256 !== metadata.assemblySha256) {
    fail("NATIVE_CANDIDATE_ASSEMBLY", "native candidate assembly digest changed");
  }
  const assemblyObservation = await observeBoundedExecutable(
    assemblyPath,
    16 * 1024 * 1024,
    "native candidate assembly",
  );
  if (
    assemblyObservation.sha256 !== assemblySha256 ||
    assemblyObservation.bytes !== assemblyBytes.length
  ) {
    fail("NATIVE_CANDIDATE_ASSEMBLY", "native candidate assembly changed while loaded");
  }
  const toolchainDigest = deriveNativeToolchainDigest(metadata);
  const candidateDigest = deriveNativeCandidateDigest({
    sourceBundleSha256,
    assemblySha256,
    toolchainDigest,
  });
  if (
    toolchainDigest !== manifest.toolchainDigest ||
    candidateDigest !== manifest.candidateDigest
  ) {
    fail("NATIVE_CANDIDATE_DIGEST", "native candidate aggregate digest changed");
  }
  await Promise.all([
    assertCandidateDirectoryUnchanged(root, "candidateRoot"),
    assertCandidateDirectoryUnchanged(directory, "candidateDirectory"),
  ]);
  const build = Object.freeze({
    assemblyPath,
    buildDirectory: directory.canonical,
    candidateRoot: root.canonical,
    candidateDirectory: directory.canonical,
    nativeHelperArtifactPath,
    snapshotDirectory,
    assemblySha256,
    sourceBundleSha256,
    toolchainDigest,
    candidateDigest,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    sources: Object.freeze(sources),
    toolchain: Object.freeze({ ...metadata }),
  });
  buildAssemblyObjectIdentities.set(build, assemblyObservation.objectIdentity);
  buildCandidateBindings.set(
    build,
    Object.freeze({ candidateRoot: root, candidateDirectory: directory }),
  );
  return build;
}

async function verifyBuildUnchanged(build) {
  const expectedAssemblyObjectIdentity = buildAssemblyObjectIdentities.get(build);
  if (expectedAssemblyObjectIdentity === undefined) {
    fail("NATIVE_ASSEMBLY_IDENTITY", "native helper assembly has no retained object identity");
  }
  const candidateBinding = buildCandidateBindings.get(build);
  if (candidateBinding === undefined) {
    fail("NATIVE_CANDIDATE_IDENTITY", "native helper has no retained candidate-root identity");
  }
  await Promise.all([
    assertCandidateDirectoryUnchanged(candidateBinding.candidateRoot, "candidateRoot"),
    assertCandidateDirectoryUnchanged(candidateBinding.candidateDirectory, "candidateDirectory"),
  ]);
  const portableArtifactPath = resolveNativeCandidateArtifactPath({
    candidateRoot: candidateBinding.candidateRoot.canonical,
    candidateDirectory: candidateBinding.candidateDirectory.canonical,
    assemblyPath: build.assemblyPath,
  });
  if (
    build.candidateRoot !== candidateBinding.candidateRoot.canonical ||
    build.candidateDirectory !== candidateBinding.candidateDirectory.canonical ||
    build.nativeHelperArtifactPath !== portableArtifactPath
  ) {
    fail("NATIVE_CANDIDATE_BINDING", "native helper candidate-root binding changed");
  }
  const assembly = await observeBoundedExecutable(
    build.assemblyPath,
    16 * 1024 * 1024,
    "native helper assembly",
  );
  if (
    assembly.sha256 !== build.assemblySha256 ||
    assembly.objectIdentity !== expectedAssemblyObjectIdentity
  ) {
    fail("NATIVE_ASSEMBLY_CHANGED", "native helper assembly changed before or after execution");
  }
  for (const source of build.sources) {
    const bytes = await readBoundedPlainFile(
      join(build.snapshotDirectory, source.name),
      2 * 1024 * 1024,
      "snapshotted native source",
    );
    if (sha256(bytes) !== source.sha256 || bytes.length !== source.bytes) {
      fail("NATIVE_SOURCE_CHANGED", "snapshotted native source changed before or after execution");
    }
  }
  const manifestBytes = await readBoundedPlainFile(
    build.manifestPath,
    maxOutputFrameBytes,
    "native candidate manifest",
  );
  if (sha256(manifestBytes) !== build.manifestSha256) {
    fail("NATIVE_MANIFEST_CHANGED", "native candidate manifest changed before or after execution");
  }
}

const nativePreflightObservationDraftKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "pathProfileId",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "runnerUserSidSha256",
  "rootPathSha256",
  "rootSecuritySha256",
  "evidenceRootObjectIdentitySha256",
  "volumeIdSha256",
  "localAbsolute",
  "interactiveSessionActive",
  "networkPath",
  "removableVolume",
  "reparsePoint",
  "nfcNormalized",
  "containsSpaces",
  "containsUnicode",
  "fileSystem",
  "driveType",
  "nativeHelperSha256",
  "nativeCandidateDigest",
  "nativeManifestSha256",
  "sourceBundleSha256",
]);

const nativePreflightRootSnapshotLimits = Object.freeze({
  maxDepth: 12,
  maxEntries: 8192,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});

function nativePreflightStat(value) {
  return Object.freeze({
    device: value.dev.toString(10),
    object: value.ino.toString(10),
    mode: value.mode.toString(10),
    links: value.nlink.toString(10),
    bytes: value.size.toString(10),
    modifiedNs: value.mtimeNs.toString(10),
    changedNs: value.ctimeNs.toString(10),
    createdNs: value.birthtimeNs.toString(10),
  });
}

function sameNativePreflightStat(left, right) {
  return (
    canonicalJsonText(nativePreflightStat(left)) === canonicalJsonText(nativePreflightStat(right))
  );
}

async function snapshotNativePreflightRoot(root) {
  const records = [];
  let entryCount = 0;
  let totalBytes = 0;

  async function walk(absolutePath, relativePath, depth) {
    if (depth > nativePreflightRootSnapshotLimits.maxDepth) {
      fail("NATIVE_PREFLIGHT_ROOT_BOUND", "native preflight root exceeds its depth bound");
    }
    const before = await lstat(absolutePath, { bigint: true });
    if (before.isSymbolicLink()) {
      fail("NATIVE_PREFLIGHT_ROOT_REPARSE", "native preflight root contains a reparse entry");
    }
    entryCount += 1;
    if (entryCount > nativePreflightRootSnapshotLimits.maxEntries) {
      fail("NATIVE_PREFLIGHT_ROOT_BOUND", "native preflight root exceeds its entry bound");
    }
    if (before.isDirectory()) {
      const directoryEntries = await readdir(absolutePath, { withFileTypes: true });
      directoryEntries.sort((left, right) =>
        Buffer.from(left.name, "utf8").compare(Buffer.from(right.name, "utf8")),
      );
      assertNoWindowsPathCaseCollisions(
        directoryEntries.map(({ name }) => name),
        "native preflight root directory",
      );
      for (const entry of directoryEntries) {
        if (entry.name !== entry.name.normalize("NFC") || entry.name.includes("\0")) {
          fail("NATIVE_PREFLIGHT_ROOT_NAME", "native preflight root contains an unsafe name");
        }
        const childRelative =
          relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
        await walk(join(absolutePath, entry.name), childRelative, depth + 1);
      }
      const after = await lstat(absolutePath, { bigint: true });
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        !sameNativePreflightStat(before, after)
      ) {
        fail("NATIVE_PREFLIGHT_ROOT_CHANGED", "native preflight root changed while inspected");
      }
      records.push(
        Object.freeze({ kind: "directory", path: relativePath, ...nativePreflightStat(before) }),
      );
      return;
    }
    if (!before.isFile() || before.size > BigInt(nativePreflightRootSnapshotLimits.maxFileBytes)) {
      fail("NATIVE_PREFLIGHT_ROOT_TYPE", "native preflight root contains an unsupported entry");
    }
    const handle = await open(absolutePath, "r");
    let bytes;
    try {
      const openedBefore = await handle.stat({ bigint: true });
      if (!openedBefore.isFile() || !sameNativePreflightStat(before, openedBefore)) {
        fail("NATIVE_PREFLIGHT_ROOT_CHANGED", "native preflight file changed before read");
      }
      bytes = await handle.readFile();
      const openedAfter = await handle.stat({ bigint: true });
      if (
        bytes.length !== Number(openedAfter.size) ||
        !sameNativePreflightStat(openedBefore, openedAfter)
      ) {
        fail("NATIVE_PREFLIGHT_ROOT_CHANGED", "native preflight file changed while read");
      }
    } finally {
      await handle.close();
    }
    totalBytes += bytes.length;
    if (totalBytes > nativePreflightRootSnapshotLimits.maxTotalBytes) {
      fail("NATIVE_PREFLIGHT_ROOT_BOUND", "native preflight root exceeds its byte bound");
    }
    records.push(
      Object.freeze({
        kind: "file",
        path: relativePath,
        ...nativePreflightStat(before),
        sha256: sha256(bytes),
      }),
    );
  }

  await walk(root, "", 0);
  records.sort((left, right) =>
    Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")),
  );
  const snapshot = canonicalJson({
    schemaVersion: 1,
    kind: "windows-host-native-preflight-root-snapshot",
    entryCount,
    totalBytes,
    records,
  });
  return Object.freeze({
    snapshot,
    sha256: canonicalJsonSha256({
      domain: "enduragent.windows-host-native-preflight-root-snapshot.v1",
      snapshot,
    }),
  });
}

function validateNativePreflightObservationPayload(value, includeDigest) {
  assertExactKeys(
    value,
    includeDigest
      ? [...nativePreflightObservationDraftKeys, "observationSha256"]
      : nativePreflightObservationDraftKeys,
    "native preflight observation",
  );
  if (
    value.schemaVersion !== NATIVE_PREFLIGHT_OBSERVATION_SCHEMA_VERSION ||
    value.kind !== "windows-host-native-preflight-observation"
  ) {
    fail("NATIVE_PREFLIGHT_OBSERVATION", "native preflight observation identity is invalid");
  }
  requireEnum(value.pathProfileId, ["ascii", "spaces-unicode"], "native preflight path profile");
  for (const key of [
    "bootIdSha256",
    "runnerSessionIdSha256",
    "runnerUserSidSha256",
    "rootPathSha256",
    "rootSecuritySha256",
    "evidenceRootObjectIdentitySha256",
    "volumeIdSha256",
    "nativeHelperSha256",
    "nativeCandidateDigest",
    "nativeManifestSha256",
    "sourceBundleSha256",
  ]) {
    requireHex64(value[key], "native preflight observation " + key);
  }
  if (includeDigest) {
    requireHex64(value.observationSha256, "native preflight observation observationSha256");
  }
  if (value.fileSystem !== "NTFS" || value.driveType !== "fixed") {
    fail(
      "NATIVE_PREFLIGHT_STORAGE",
      "native preflight observation is not fixed local NTFS storage",
    );
  }
  for (const key of [
    "localAbsolute",
    "interactiveSessionActive",
    "networkPath",
    "removableVolume",
    "reparsePoint",
    "nfcNormalized",
    "containsSpaces",
    "containsUnicode",
  ]) {
    if (typeof value[key] !== "boolean") {
      fail("NATIVE_PREFLIGHT_OBSERVATION", "native preflight flags must be boolean");
    }
  }
  const complex = value.pathProfileId === "spaces-unicode";
  if (
    value.localAbsolute !== true ||
    value.interactiveSessionActive !== true ||
    value.networkPath !== false ||
    value.removableVolume !== false ||
    value.reparsePoint !== false ||
    value.nfcNormalized !== true ||
    value.containsSpaces !== complex ||
    value.containsUnicode !== complex
  ) {
    fail(
      "NATIVE_PREFLIGHT_PATH_PROFILE",
      "native preflight path does not satisfy its requested profile",
    );
  }
  return value;
}

function nativePreflightObservationDigestPayload(value) {
  const includesDigest = exactObject(value) && Object.hasOwn(value, "observationSha256");
  validateNativePreflightObservationPayload(value, includesDigest);
  const payload = {};
  for (const key of nativePreflightObservationDraftKeys) payload[key] = value[key];
  return payload;
}

export function deriveNativePreflightObservationDigest(value) {
  return canonicalJsonSha256({
    domain: "enduragent.windows-host-native-preflight-observation.v1",
    observation: nativePreflightObservationDigestPayload(value),
  });
}

export function validateNativePreflightObservation(value) {
  validateNativePreflightObservationPayload(value, true);
  if (value.observationSha256 !== deriveNativePreflightObservationDigest(value)) {
    fail("NATIVE_PREFLIGHT_OBSERVATION_DIGEST", "native preflight observation digest is invalid");
  }
  return freezeJson(canonicalJson(value));
}

const nativePreflightTranscriptBindingKeys = Object.freeze([
  "candidateRootSha256",
  "candidateDirectorySha256",
  "requestedRunRootSha256",
  "rootMutationCheck",
  "nativeHelperArtifactPath",
  "nativeHelperSha256",
  "nativeCandidateDigest",
  "nativeManifestSha256",
  "sourceBundleSha256",
  "pathProfileId",
]);

function nativePreflightTranscriptPayload(value, includeDigest) {
  assertExactKeys(
    value,
    includeDigest
      ? ["schemaVersion", "kind", "binding", "observation", "termination", "transcriptSha256"]
      : ["schemaVersion", "kind", "binding", "observation", "termination"],
    "native preflight transcript",
  );
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-native-preflight-transcript") {
    fail("NATIVE_PREFLIGHT_TRANSCRIPT", "native preflight transcript identity is invalid");
  }
  assertExactKeys(
    value.binding,
    nativePreflightTranscriptBindingKeys,
    "native preflight transcript binding",
  );
  for (const key of [
    "candidateRootSha256",
    "candidateDirectorySha256",
    "requestedRunRootSha256",
    "nativeHelperSha256",
    "nativeCandidateDigest",
    "nativeManifestSha256",
    "sourceBundleSha256",
  ]) {
    requireHex64(value.binding[key], `native preflight transcript binding.${key}`);
  }
  if (value.binding.rootMutationCheck !== "bounded-recursive-before-after-v1") {
    fail("NATIVE_PREFLIGHT_TRANSCRIPT", "native preflight mutation check is invalid");
  }
  const nativeHelperArtifactPath = requireString(
    value.binding.nativeHelperArtifactPath,
    "native preflight transcript binding.nativeHelperArtifactPath",
  );
  if (
    nativeHelperArtifactPath.includes("\\") ||
    validateRelativeTarget(
      nativeHelperArtifactPath,
      "native preflight transcript binding.nativeHelperArtifactPath",
    ).replaceAll("\\", "/") !== nativeHelperArtifactPath
  ) {
    fail("NATIVE_PREFLIGHT_TRANSCRIPT", "native preflight helper path is not canonical");
  }
  requireEnum(
    value.binding.pathProfileId,
    ["ascii", "spaces-unicode"],
    "native preflight transcript path profile",
  );
  const observation = validateNativePreflightObservation(value.observation);
  if (
    observation.pathProfileId !== value.binding.pathProfileId ||
    observation.nativeHelperSha256 !== value.binding.nativeHelperSha256 ||
    observation.nativeCandidateDigest !== value.binding.nativeCandidateDigest ||
    observation.nativeManifestSha256 !== value.binding.nativeManifestSha256 ||
    observation.sourceBundleSha256 !== value.binding.sourceBundleSha256
  ) {
    fail("NATIVE_PREFLIGHT_TRANSCRIPT_BINDING", "native preflight transcript binding differs");
  }
  assertExactKeys(
    value.termination,
    ["code", "signal", "stderrBytes"],
    "native preflight transcript termination",
  );
  if (
    value.termination.code !== 0 ||
    value.termination.signal !== null ||
    value.termination.stderrBytes !== 0
  ) {
    fail("NATIVE_PREFLIGHT_TRANSCRIPT", "native preflight transcript is not successful");
  }
  if (includeDigest) requireHex64(value.transcriptSha256, "native preflight transcript digest");
  return { observation };
}

export function deriveNativePreflightTranscriptDigest(value) {
  const includeDigest = exactObject(value) && Object.hasOwn(value, "transcriptSha256");
  nativePreflightTranscriptPayload(value, includeDigest);
  const { transcriptSha256: _transcriptSha256, ...transcript } = value;
  return canonicalJsonSha256({
    domain: "enduragent.windows-host-native-preflight-transcript.v1",
    transcript,
  });
}

export function validateNativePreflightTranscript(value) {
  nativePreflightTranscriptPayload(value, true);
  if (value.transcriptSha256 !== deriveNativePreflightTranscriptDigest(value)) {
    fail("NATIVE_PREFLIGHT_TRANSCRIPT_DIGEST", "native preflight transcript digest is invalid");
  }
  return freezeJson(canonicalJson(value));
}

export async function observeNativePreflight({
  runRoot,
  pathProfileId,
  candidateRoot,
  candidateDirectory,
  timeoutMs = 30_000,
  signal,
} = {}) {
  if (process.platform !== "win32") {
    fail("NATIVE_PLATFORM", "native preflight observation requires Windows");
  }
  if (process.arch !== "x64") {
    fail("NATIVE_ARCHITECTURE", "native preflight observation requires x64 Node");
  }
  requireEnum(pathProfileId, ["ascii", "spaces-unicode"], "native preflight path profile");
  requireInteger(timeoutMs, "native preflight timeoutMs", 1, 300_000);
  const owned = await validateRunRoot(runRoot);
  const build = await loadNativeHelper({ candidateRoot, candidateDirectory });
  assertCandidateRunRootDisjoint(owned.canonical, build.candidateRoot);
  await assertRunRootUnchanged(owned);
  await verifyBuildUnchanged(build);
  const rootSnapshotBefore = await snapshotNativePreflightRoot(owned.canonical);
  const launchHold = await startAssemblyLaunchHold(build, {
    runRoot: owned.canonical,
    timeoutMs,
    signal,
    createProtectedTemp: false,
  });
  let launched;
  let launchError;
  try {
    await assertRunRootUnchanged(owned);
    await verifyBuildUnchanged(build);
    launched = await runBounded(build.assemblyPath, ["--preflight-observe"], {
      cwd: owned.canonical,
      env: process.env,
      bindings: {
        ENDURAGENT_NATIVE_RUN_ROOT: owned.canonical,
        ENDURAGENT_PATH_PROFILE_ID: pathProfileId,
      },
      timeoutMs,
      signal,
      maxStdout: maxOutputFrameBytes,
      maxStderr: maxStderrBytes,
    });
    await assertRunRootUnchanged(owned);
    await verifyBuildUnchanged(build);
  } catch (error) {
    launchError = error;
  }
  let holderError;
  try {
    if (launchError === undefined) await launchHold.release();
    else await launchHold.abort();
  } catch (error) {
    holderError = error;
  }
  await assertRunRootUnchanged(owned);
  await verifyBuildUnchanged(build);
  const rootSnapshotAfter = await snapshotNativePreflightRoot(owned.canonical);
  if (
    rootSnapshotBefore.sha256 !== rootSnapshotAfter.sha256 ||
    canonicalJsonText(rootSnapshotBefore.snapshot) !== canonicalJsonText(rootSnapshotAfter.snapshot)
  ) {
    fail("NATIVE_PREFLIGHT_MUTATION", "native preflight observation changed the run root");
  }
  if (holderError !== undefined) throw holderError;
  if (launchError !== undefined) throw launchError;
  if (launched.code !== 0 || launched.signal !== null || launched.stderr.length !== 0) {
    fail("NATIVE_PREFLIGHT_EXIT", "native preflight observer exited unsuccessfully");
  }
  const parsed = parseSingleJsonLine(launched.stdout, "native preflight observer");
  const canonicalOutput = Buffer.from(JSON.stringify(canonicalJson(parsed)) + "\n", "utf8");
  if (!canonicalOutput.equals(launched.stdout)) {
    fail(
      "NATIVE_PREFLIGHT_CANONICAL",
      "native preflight observer output is not exact canonical JSON",
    );
  }
  validateNativePreflightObservationPayload(parsed, false);
  if (
    parsed.pathProfileId !== pathProfileId ||
    parsed.nativeHelperSha256 !== build.assemblySha256 ||
    parsed.nativeCandidateDigest !== build.candidateDigest ||
    parsed.nativeManifestSha256 !== build.manifestSha256 ||
    parsed.sourceBundleSha256 !== build.sourceBundleSha256
  ) {
    fail(
      "NATIVE_PREFLIGHT_CANDIDATE_BINDING",
      "native preflight observation differs from its loaded candidate",
    );
  }
  const observation = validateNativePreflightObservation({
    ...parsed,
    observationSha256: deriveNativePreflightObservationDigest(parsed),
  });
  const transcriptDraft = canonicalJson({
    schemaVersion: 1,
    kind: "windows-host-native-preflight-transcript",
    binding: {
      candidateRootSha256: sha256(Buffer.from(build.candidateRoot, "utf8")),
      candidateDirectorySha256: sha256(Buffer.from(build.candidateDirectory, "utf8")),
      requestedRunRootSha256: sha256(Buffer.from(owned.canonical, "utf8")),
      rootMutationCheck: "bounded-recursive-before-after-v1",
      nativeHelperArtifactPath: build.nativeHelperArtifactPath,
      nativeHelperSha256: build.assemblySha256,
      nativeCandidateDigest: build.candidateDigest,
      nativeManifestSha256: build.manifestSha256,
      sourceBundleSha256: build.sourceBundleSha256,
      pathProfileId,
    },
    observation,
    termination: {
      code: launched.code,
      signal: launched.signal,
      stderrBytes: launched.stderr.length,
    },
  });
  const transcript = validateNativePreflightTranscript({
    ...transcriptDraft,
    transcriptSha256: deriveNativePreflightTranscriptDigest(transcriptDraft),
  });
  return Object.freeze({
    build: retainedBuildIdentity(build),
    observation,
    transcript,
    transcriptBytes: Buffer.from(JSON.stringify(transcript) + "\n", "utf8"),
  });
}

const nativeBrokerContextReceiptKeys = Object.freeze([
  "protocolVersion",
  "kind",
  "sequence",
  "challengeSha256",
  "previousReceiptSha256",
  "mailboxSecurityProfile",
  "nativeHelperSha256",
  "mailboxRequestedPathSha256",
  "mailboxPathSha256",
  "mailboxRootObjectIdentitySha256",
  "mailboxVolumeIdSha256",
  "mailboxOwnerSidSha256",
  "mailboxAclSha256",
  "processSidSha256",
  "authenticationLuidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "mailboxTransportIdentitySha256",
  "mailboxFileSystem",
  "mailboxDriveType",
  "mailboxLocalAbsolute",
  "mailboxNetworkPath",
  "mailboxReparsePoint",
  "journalSecurityProfile",
  "journalRootRequestedPathSha256",
  "journalRootPathSha256",
  "journalRootObjectIdentitySha256",
  "journalVolumeIdSha256",
  "journalRootOwnerSidSha256",
  "journalRootAclSha256",
  "journalDatabasePathSha256",
  "journalDatabaseObjectIdentitySha256",
  "journalDatabaseOwnerSidSha256",
  "journalDatabaseAclSha256",
  "journalTransportIdentitySha256",
  "journalFileSystem",
  "journalDriveType",
  "journalLocalAbsolute",
  "journalNetworkPath",
  "journalReparsePoint",
  "interactiveSessionActive",
  "nativeObservationSha256",
  "receiptSha256",
]);

export function deriveNativeBrokerContextObservationDigest(value) {
  return framedDigest(
    "enduragent.windows-host-native-broker-context-observation.v1",
    value.mailboxSecurityProfile,
    value.nativeHelperSha256,
    value.mailboxRequestedPathSha256,
    value.mailboxPathSha256,
    value.mailboxRootObjectIdentitySha256,
    value.mailboxVolumeIdSha256,
    value.mailboxOwnerSidSha256,
    value.mailboxAclSha256,
    value.processSidSha256,
    value.authenticationLuidSha256,
    value.bootIdSha256,
    value.runnerSessionIdSha256,
    value.mailboxTransportIdentitySha256,
    value.mailboxFileSystem,
    value.mailboxDriveType,
    String(value.mailboxLocalAbsolute),
    String(value.mailboxNetworkPath),
    String(value.mailboxReparsePoint),
    value.journalSecurityProfile,
    value.journalRootRequestedPathSha256,
    value.journalRootPathSha256,
    value.journalRootObjectIdentitySha256,
    value.journalVolumeIdSha256,
    value.journalRootOwnerSidSha256,
    value.journalRootAclSha256,
    value.journalDatabasePathSha256,
    value.journalDatabaseObjectIdentitySha256,
    value.journalDatabaseOwnerSidSha256,
    value.journalDatabaseAclSha256,
    value.journalTransportIdentitySha256,
    value.journalFileSystem,
    value.journalDriveType,
    String(value.journalLocalAbsolute),
    String(value.journalNetworkPath),
    String(value.journalReparsePoint),
    String(value.interactiveSessionActive),
  );
}

export function deriveNativeBrokerContextReceiptDigest(value) {
  return framedDigest(
    "enduragent.windows-host-native-broker-context-receipt.v1",
    value.kind,
    String(value.sequence),
    value.challengeSha256,
    value.previousReceiptSha256 ?? "",
    value.nativeObservationSha256,
  );
}

export function validateNativeBrokerContextReceipt(value) {
  assertExactKeys(value, nativeBrokerContextReceiptKeys, "native broker-context receipt");
  if (value.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    fail("NATIVE_BROKER_CONTEXT_VERSION", "native broker-context protocol version is invalid");
  }
  requireEnum(value.kind, NATIVE_BROKER_CONTEXT_KINDS, "native broker-context receipt kind");
  requireInteger(
    value.sequence,
    "native broker-context receipt sequence",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  for (const key of [
    "challengeSha256",
    "nativeHelperSha256",
    "mailboxRequestedPathSha256",
    "mailboxPathSha256",
    "mailboxRootObjectIdentitySha256",
    "mailboxVolumeIdSha256",
    "mailboxOwnerSidSha256",
    "mailboxAclSha256",
    "processSidSha256",
    "authenticationLuidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "mailboxTransportIdentitySha256",
    "journalRootRequestedPathSha256",
    "journalRootPathSha256",
    "journalRootObjectIdentitySha256",
    "journalVolumeIdSha256",
    "journalRootOwnerSidSha256",
    "journalRootAclSha256",
    "journalDatabasePathSha256",
    "journalDatabaseObjectIdentitySha256",
    "journalDatabaseOwnerSidSha256",
    "journalDatabaseAclSha256",
    "journalTransportIdentitySha256",
    "nativeObservationSha256",
    "receiptSha256",
  ]) {
    requireHex64(value[key], `native broker-context receipt.${key}`);
  }
  requireNullableHex64(
    value.previousReceiptSha256,
    "native broker-context receipt.previousReceiptSha256",
  );
  if (value.mailboxSecurityProfile !== NATIVE_BROKER_CONTEXT_SECURITY_PROFILE) {
    fail(
      "NATIVE_BROKER_CONTEXT_SECURITY_PROFILE",
      "native broker-context mailbox security profile is invalid",
    );
  }
  if (value.journalSecurityProfile !== NATIVE_BROKER_JOURNAL_SECURITY_PROFILE) {
    fail(
      "NATIVE_BROKER_CONTEXT_JOURNAL_SECURITY_PROFILE",
      "native broker-context journal security profile is invalid",
    );
  }
  if (
    value.mailboxFileSystem !== "NTFS" ||
    value.mailboxDriveType !== "fixed" ||
    value.mailboxLocalAbsolute !== true ||
    value.mailboxNetworkPath !== false ||
    value.mailboxReparsePoint !== false ||
    value.journalFileSystem !== "NTFS" ||
    value.journalDriveType !== "fixed" ||
    value.journalLocalAbsolute !== true ||
    value.journalNetworkPath !== false ||
    value.journalReparsePoint !== false ||
    value.interactiveSessionActive !== true
  ) {
    fail(
      "NATIVE_BROKER_CONTEXT_POSTURE",
      "native broker-context storage or session posture is invalid",
    );
  }
  if (value.nativeObservationSha256 !== deriveNativeBrokerContextObservationDigest(value)) {
    fail(
      "NATIVE_BROKER_CONTEXT_OBSERVATION_DIGEST",
      "native broker-context observation digest is invalid",
    );
  }
  if (value.receiptSha256 !== deriveNativeBrokerContextReceiptDigest(value)) {
    fail("NATIVE_BROKER_CONTEXT_RECEIPT_DIGEST", "native broker-context receipt digest is invalid");
  }
  return freezeJson(value);
}

function assertNativeBrokerContextPreparedBinding(receipt, prepared, nativeHelperSha256) {
  if (receipt.nativeHelperSha256 !== nativeHelperSha256) {
    fail(
      "NATIVE_BROKER_CONTEXT_PREPARED_MISMATCH",
      "native broker context differs from prepared field nativeHelperSha256",
    );
  }
  if (
    receipt.mailboxRequestedPathSha256 !== sha256(Buffer.from(prepared.mailboxRoot, "utf8")) ||
    receipt.journalRootRequestedPathSha256 !== sha256(Buffer.from(prepared.journalRoot, "utf8"))
  ) {
    fail(
      "NATIVE_BROKER_CONTEXT_PREPARED_MISMATCH",
      "native broker context differs from the prepared storage paths",
    );
  }
  for (const key of [
    "mailboxSecurityProfile",
    "nativeHelperSha256",
    "mailboxRootObjectIdentitySha256",
    "mailboxVolumeIdSha256",
    "mailboxOwnerSidSha256",
    "mailboxAclSha256",
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "mailboxTransportIdentitySha256",
    "journalSecurityProfile",
    "journalRootPathSha256",
    "journalRootObjectIdentitySha256",
    "journalVolumeIdSha256",
    "journalRootOwnerSidSha256",
    "journalRootAclSha256",
    "journalDatabasePathSha256",
    "journalDatabaseObjectIdentitySha256",
    "journalDatabaseOwnerSidSha256",
    "journalDatabaseAclSha256",
    "journalTransportIdentitySha256",
    "nativeObservationSha256",
  ]) {
    if (receipt[key] !== prepared[key]) {
      fail(
        "NATIVE_BROKER_CONTEXT_PREPARED_MISMATCH",
        `native broker context differs from prepared field ${key}`,
      );
    }
  }
}

function assertNativeBrokerStorageEnrollment(receipt, enrollment, nativeHelperSha256) {
  if (
    receipt.mailboxRequestedPathSha256 !== sha256(Buffer.from(enrollment.mailboxRoot, "utf8")) ||
    receipt.mailboxSecurityProfile !== enrollment.mailboxSecurityProfile ||
    receipt.mailboxAclSha256 !== enrollment.mailboxAclSha256 ||
    receipt.journalSecurityProfile !== enrollment.journalSecurityProfile ||
    receipt.journalRootAclSha256 !== enrollment.journalRootAclSha256 ||
    receipt.journalDatabaseAclSha256 !== enrollment.journalDatabaseAclSha256 ||
    receipt.processSidSha256 !== enrollment.processSidSha256 ||
    receipt.mailboxOwnerSidSha256 !== enrollment.processSidSha256 ||
    receipt.journalRootRequestedPathSha256 !==
      sha256(Buffer.from(enrollment.journalRoot, "utf8")) ||
    receipt.journalRootOwnerSidSha256 !== enrollment.processSidSha256 ||
    receipt.journalDatabaseOwnerSidSha256 !== enrollment.processSidSha256 ||
    receipt.nativeHelperSha256 !== nativeHelperSha256
  ) {
    fail(
      "NATIVE_BROKER_STORAGE_ENROLLMENT_MISMATCH",
      "native broker storage differs from its static enrollment",
    );
  }
}

export function createNativeBrokerStorageObservationProtocol({
  brokerEnrollment,
  nativeHelperSha256,
  exchange,
  waitForExit,
  terminate,
  requestTimeoutMs = 30_000,
} = {}) {
  const enrollment = validateProbeBrokerEnrollment(brokerEnrollment);
  requireHex64(nativeHelperSha256, "native broker-storage helper sha256");
  if (
    typeof exchange !== "function" ||
    typeof waitForExit !== "function" ||
    typeof terminate !== "function"
  ) {
    fail("NATIVE_BROKER_STORAGE_TRANSPORT", "native broker-storage transport is incomplete");
  }
  requireInteger(requestTimeoutMs, "native broker-storage requestTimeoutMs", 1, 300_000);
  let consumed = false;
  return Object.freeze({
    brokerEnrollment: enrollment,
    nativeHelperSha256,
    observe: async () => {
      if (consumed) {
        fail("NATIVE_BROKER_STORAGE_STATE", "native broker-storage observation was already used");
      }
      consumed = true;
      const challengeSha256 = randomBytes(32).toString("hex");
      const frame = Object.freeze({
        protocolVersion: NATIVE_PROTOCOL_VERSION,
        kind: "observe",
        sequence: 1,
        challengeSha256,
        previousReceiptSha256: null,
        mailboxPath: enrollment.mailboxRoot,
        mailboxSecurityProfile: enrollment.mailboxSecurityProfile,
        expectedMailboxAclSha256: enrollment.mailboxAclSha256,
        journalRoot: enrollment.journalRoot,
        journalSecurityProfile: enrollment.journalSecurityProfile,
        expectedJournalRootAclSha256: enrollment.journalRootAclSha256,
        expectedJournalDatabaseAclSha256: enrollment.journalDatabaseAclSha256,
      });
      try {
        const receipt = validateNativeBrokerContextReceipt(await exchange(frame, requestTimeoutMs));
        if (
          receipt.kind !== "windows-host-native-broker-storage-observed" ||
          receipt.sequence !== 1 ||
          receipt.challengeSha256 !== challengeSha256 ||
          receipt.previousReceiptSha256 !== null
        ) {
          fail(
            "NATIVE_BROKER_STORAGE_CHAIN",
            "native broker-storage receipt does not match its observation request",
          );
        }
        assertNativeBrokerStorageEnrollment(receipt, enrollment, nativeHelperSha256);
        const exit = await waitForExit(requestTimeoutMs);
        if (exit.code !== 0 || exit.signal !== null) {
          fail(
            "NATIVE_BROKER_STORAGE_EXIT",
            "native broker-storage helper did not exit cleanly after observation",
          );
        }
        return receipt;
      } catch (error) {
        await preserveNativeCleanupFailure(
          error,
          [Promise.resolve().then(() => terminate())],
          "native broker-storage cleanup failed",
        );
      }
    },
  });
}

export function createNativeBrokerContextProtocol({
  preparedMailboxBinding,
  nativeHelperSha256,
  exchange,
  waitForExit,
  terminate,
  isOpen,
  requestTimeoutMs = 30_000,
} = {}) {
  const prepared = validateProbePreparedBrokerEnrollment(preparedMailboxBinding);
  requireHex64(nativeHelperSha256, "native broker-context helper sha256");
  if (nativeHelperSha256 !== prepared.nativeHelperSha256) {
    fail(
      "NATIVE_BROKER_CONTEXT_HELPER_MISMATCH",
      "native broker-context helper differs from the prepared mailbox binding",
    );
  }
  if (
    typeof exchange !== "function" ||
    typeof waitForExit !== "function" ||
    typeof isOpen !== "function"
  ) {
    fail("NATIVE_BROKER_CONTEXT_TRANSPORT", "native broker-context transport is incomplete");
  }
  if (typeof terminate !== "function") {
    fail(
      "NATIVE_BROKER_CONTEXT_TRANSPORT",
      "native broker-context transport termination is unavailable",
    );
  }
  requireInteger(requestTimeoutMs, "native broker-context requestTimeoutMs", 1, 300_000);
  let sequence = 0;
  let previousReceiptSha256 = null;
  let acquiredReceipt = null;
  let closed = false;
  let active = false;
  const challenges = new Set();
  const assertAvailable = () => {
    if (!isOpen()) closed = true;
    if (closed) fail("NATIVE_BROKER_CONTEXT_CLOSED", "native broker-context channel is closed");
    if (active) fail("NATIVE_BROKER_CONTEXT_BUSY", "native broker-context channel is busy");
  };
  const nextChallenge = () => {
    const challenge = randomBytes(32).toString("hex");
    if (challenges.has(challenge)) {
      fail("NATIVE_BROKER_CONTEXT_CHALLENGE", "native broker-context challenge was reused");
    }
    challenges.add(challenge);
    return challenge;
  };
  const invoke = async (command, expectedKind) => {
    assertAvailable();
    if ((command === "init") !== (sequence === 0)) {
      fail("NATIVE_BROKER_CONTEXT_STATE", "native broker-context command state is invalid");
    }
    active = true;
    const nextSequence = sequence + 1;
    const challengeSha256 = nextChallenge();
    const frame = Object.freeze({
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      kind: command,
      sequence: nextSequence,
      challengeSha256,
      previousReceiptSha256,
      ...(command === "init"
        ? {
            mailboxPath: prepared.mailboxRoot,
            mailboxSecurityProfile: prepared.mailboxSecurityProfile,
            expectedMailboxAclSha256: prepared.mailboxAclSha256,
            journalRoot: prepared.journalRoot,
            journalSecurityProfile: prepared.journalSecurityProfile,
            expectedJournalRootAclSha256: prepared.journalRootAclSha256,
            expectedJournalDatabaseAclSha256: prepared.journalDatabaseAclSha256,
          }
        : {}),
    });
    try {
      const receipt = validateNativeBrokerContextReceipt(await exchange(frame, requestTimeoutMs));
      if (
        receipt.kind !== expectedKind ||
        receipt.sequence !== nextSequence ||
        receipt.challengeSha256 !== challengeSha256 ||
        receipt.previousReceiptSha256 !== previousReceiptSha256
      ) {
        fail(
          "NATIVE_BROKER_CONTEXT_CHAIN",
          "native broker-context receipt does not match its request chain",
        );
      }
      assertNativeBrokerContextPreparedBinding(receipt, prepared, nativeHelperSha256);
      if (
        acquiredReceipt !== null &&
        receipt.nativeObservationSha256 !== acquiredReceipt.nativeObservationSha256
      ) {
        fail(
          "NATIVE_BROKER_CONTEXT_CHANGED",
          "native broker-context observation changed while authority was live",
        );
      }
      sequence = nextSequence;
      previousReceiptSha256 = receipt.receiptSha256;
      if (acquiredReceipt === null) acquiredReceipt = receipt;
      return receipt;
    } catch (error) {
      closed = true;
      await preserveNativeCleanupFailure(
        error,
        [Promise.resolve().then(() => terminate())],
        "native broker-context cleanup failed",
      );
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    preparedMailboxBinding: prepared,
    nativeHelperSha256,
    acquire: () => invoke("init", "windows-host-native-broker-context-acquired"),
    revalidate: () => {
      if (sequence === 0) {
        return Promise.reject(
          new NativeClientError(
            "NATIVE_BROKER_CONTEXT_STATE",
            "native broker-context channel has not been acquired",
          ),
        );
      }
      return invoke("revalidate", "windows-host-native-broker-context-revalidated");
    },
    release: async () => {
      if (sequence === 0) {
        fail("NATIVE_BROKER_CONTEXT_STATE", "native broker-context channel has not been acquired");
      }
      const receipt = await invoke("release", "windows-host-native-broker-context-released");
      closed = true;
      const exit = await waitForExit(requestTimeoutMs);
      if (exit.code !== 0 || exit.signal !== null) {
        fail(
          "NATIVE_BROKER_CONTEXT_EXIT",
          "native broker-context helper did not exit cleanly after release",
        );
      }
      return Object.freeze({ receipt, exit: Object.freeze(exit) });
    },
    wait: async () => {
      const exit = await waitForExit(requestTimeoutMs);
      closed = true;
      return exit;
    },
    isLive: () => sequence > 0 && !closed && isOpen(),
  });
}

function validateRelativeTarget(value, label) {
  requireString(value, label);
  if (isAbsolute(value) || value.startsWith("\\") || value.startsWith("/") || value.includes(":")) {
    fail("NATIVE_TARGET_PATH", `${label} must be root-relative`);
  }
  const segments = value.split(/[\\/]/u);
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      /[. ]$/u.test(segment) ||
      reserved.test(segment) ||
      containsUnsafeWindowsCharacter(segment) ||
      segment.normalize("NFC") !== segment
    ) {
      fail("NATIVE_TARGET_PATH", `${label} contains an unsafe Windows component`);
    }
  }
  return segments.join("\\");
}

function containsUnsafeWindowsCharacter(value) {
  for (const character of value) {
    if (character.codePointAt(0) < 0x20 || '<>"|?*:'.includes(character)) return true;
  }
  return false;
}

function targetRelativeToRoot(runRoot, target, label) {
  requireString(target, label);
  if (!isAbsolute(target)) return validateRelativeTarget(target, label);
  const relation = relative(resolve(runRoot), resolve(target));
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    fail("NATIVE_TARGET_PATH", `${label} must resolve beneath runRoot`);
  }
  return validateRelativeTarget(relation, label);
}

function assertRequestedRoot(runRoot, requestedRoot) {
  requireString(requestedRoot, "request.root");
  if (resolve(requestedRoot).toLowerCase() !== resolve(runRoot).toLowerCase()) {
    fail("NATIVE_RUN_ROOT_MISMATCH", "request root does not match runRoot");
  }
}

function validateContentSource(source) {
  if (!exactObject(source)) fail("NATIVE_CONTENT", "contentSource must be an object");
  if (source.kind === "staged-file") {
    assertExactKeys(source, ["kind", "relativePath", "bytes", "sha256"], "contentSource");
    return {
      kind: source.kind,
      relativePath: validateRelativeTarget(source.relativePath, "contentSource.relativePath"),
      bytes: requireInteger(source.bytes, "contentSource.bytes", 0, maxContentBytes),
      sha256: requireHex64(source.sha256, "contentSource.sha256"),
    };
  }
  if (source.kind === "deterministic") {
    assertExactKeys(source, ["kind", "seedHex", "bytes", "sha256"], "contentSource");
    return {
      kind: source.kind,
      seedHex: requireHex64(source.seedHex, "contentSource.seedHex"),
      bytes: requireInteger(source.bytes, "contentSource.bytes", 0, maxContentBytes),
      sha256: requireHex64(source.sha256, "contentSource.sha256"),
    };
  }
  fail("NATIVE_CONTENT", "contentSource kind is invalid");
}

function deterministicContentSha256(seedHex, length) {
  const domain = Buffer.from("enduragent.windows-falsifier-content.v1", "utf8");
  const seed = Buffer.from(seedHex, "hex");
  const counter = Buffer.allocUnsafe(8);
  const content = createHash("sha256");
  let remaining = length;
  let sequence = 0n;
  while (remaining > 0) {
    counter.writeBigUInt64BE(sequence);
    const block = createHash("sha256").update(domain).update(seed).update(counter).digest();
    const count = Math.min(block.length, remaining);
    content.update(block.subarray(0, count));
    remaining -= count;
    sequence += 1n;
  }
  return content.digest("hex");
}

async function normalizeContent(runRoot, request, operationId) {
  const source = validateContentSource(request.contentSource);
  let observedBytes;
  let observedSha256;
  if (source.kind === "staged-file") {
    const path = resolve(runRoot, ...source.relativePath.split("\\"));
    const bytes = await readBoundedPlainFile(
      path,
      maxContentBytes,
      `native content prerequisite for ${operationId}`,
    );
    observedBytes = bytes.length;
    observedSha256 = sha256(bytes);
  } else {
    observedBytes = source.bytes;
    observedSha256 = deterministicContentSha256(source.seedHex, source.bytes);
  }
  if (observedBytes !== source.bytes || observedSha256 !== source.sha256) {
    fail(
      "NATIVE_CONTENT_MISMATCH",
      "native content prerequisite size or digest does not match its request",
    );
  }
  return source;
}

function validatePipeRequest(request, owner) {
  const required = owner
    ? [
        "pipeName",
        "capabilityHex",
        "bindingHex",
        "maxFrameBytes",
        "connectDeadlineMs",
        "readDeadlineMs",
      ]
    : [
        "pipeName",
        "capabilityHex",
        "bindingHex",
        "role",
        "maxFrameBytes",
        "connectDeadlineMs",
        "readDeadlineMs",
      ];
  assertExactKeys(request, required, owner ? "pipe-owner request" : "pipe-client request");
  if (!frozenPipeName.test(request.pipeName))
    fail("NATIVE_PIPE_NAME", "pipeName does not match the frozen grammar");
  requireHex64(request.capabilityHex, "capabilityHex");
  requireHex64(request.bindingHex, "bindingHex");
  if (!owner && !["ordinary", "successor"].includes(request.role))
    fail("NATIVE_PIPE_ROLE", "pipe role is invalid");
  requireInteger(request.maxFrameBytes, "maxFrameBytes", 256, 65536);
  requireInteger(request.connectDeadlineMs, "connectDeadlineMs", 1, 120000);
  requireInteger(request.readDeadlineMs, "readDeadlineMs", 1, 120000);
  return { ...request };
}

function projectPipeSecret(value) {
  return sha256(Buffer.from(value, "hex"));
}

function retainTranscriptRequest(command, request) {
  if (command !== "pipe-owner" && command !== "pipe-client") {
    return freezeJson(canonicalJson(request));
  }
  const { capabilityHex, bindingHex, ...retained } = request;
  return freezeJson(
    canonicalJson({
      ...retained,
      capabilitySha256: projectPipeSecret(capabilityHex),
      bindingSha256: projectPipeSecret(bindingHex),
    }),
  );
}

async function normalizeRequest(runRoot, command, request, operationId) {
  if (!NATIVE_COMMANDS.includes(command))
    fail("NATIVE_COMMAND", "native command is not allowlisted");
  if (!exactObject(request)) fail("NATIVE_REQUEST_SCHEMA", "native request must be an object");
  if (command === "home-identity") {
    if (Object.hasOwn(request, "path")) {
      assertExactKeys(request, ["path"], "home-identity request");
      return { relativePath: targetRelativeToRoot(runRoot, request.path, "path") };
    }
    assertExactKeys(request, ["relativePath"], "home-identity request");
    return { relativePath: validateRelativeTarget(request.relativePath, "relativePath") };
  }
  if (command === "private-directory-ensure") {
    assertExactKeys(request, ["relativePath", "action"], "private-directory-ensure request");
    if (!["create", "repair"].includes(request.action))
      fail("NATIVE_DIRECTORY_ACTION", "directory action is invalid");
    return {
      relativePath: validateRelativeTarget(request.relativePath, "relativePath"),
      action: request.action,
    };
  }
  if (command === "private-directory-inspect") {
    assertExactKeys(request, ["relativePath"], "private-directory-inspect request");
    return { relativePath: validateRelativeTarget(request.relativePath, "relativePath") };
  }
  if (command === "private-file-create") {
    assertKeys(request, ["relativePath", "contentSource"], ["root"], "private-file-create request");
    if (request.root !== undefined) assertRequestedRoot(runRoot, request.root);
    return {
      relativePath: validateRelativeTarget(request.relativePath, "relativePath"),
      contentSource: await normalizeContent(runRoot, request, operationId),
    };
  }
  if (command === "file-identity") {
    assertKeys(request, ["relativePath"], ["root"], "file-identity request");
    if (request.root !== undefined) assertRequestedRoot(runRoot, request.root);
    return { relativePath: validateRelativeTarget(request.relativePath, "relativePath") };
  }
  if (command === "evidence-tree-seal") {
    assertKeys(
      request,
      ["relativePath", "maxDepth", "maxEntries", "maxFileBytes", "maxTotalBytes"],
      ["mode", "exactPaths"],
      "evidence-tree-seal request",
    );
    const mode = request.mode ?? "entries";
    if (!["entries", "digest-only", "exact-paths"].includes(mode))
      fail("NATIVE_EVIDENCE_MODE", "evidence seal mode is invalid");
    requireInteger(request.maxDepth, "maxDepth", 1, 64);
    requireInteger(request.maxEntries, "maxEntries", 1, 8192);
    requireInteger(request.maxFileBytes, "maxFileBytes", 1, 512 * 1024 * 1024);
    requireInteger(request.maxTotalBytes, "maxTotalBytes", 1, 1024 * 1024 * 1024);
    const normalized = {
      relativePath: validateRelativeTarget(request.relativePath, "relativePath"),
      mode,
      maxDepth: request.maxDepth,
      maxEntries: request.maxEntries,
      maxFileBytes: request.maxFileBytes,
      maxTotalBytes: request.maxTotalBytes,
    };
    if (mode === "exact-paths") {
      if (!Array.isArray(request.exactPaths) || request.exactPaths.length === 0) {
        fail("NATIVE_EVIDENCE_ARTIFACT_SET", "exactPaths must be a non-empty array");
      }
      if (request.exactPaths.length > Math.min(request.maxEntries, 768)) {
        fail("NATIVE_EVIDENCE_ARTIFACT_SET", "exactPaths exceeds the bounded entry limit");
      }
      const exactPaths = request.exactPaths
        .map((path, index) =>
          validateRelativeTarget(path, `exactPaths[${index}]`).replaceAll("\\", "/"),
        )
        .sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
      assertNoWindowsPathCaseCollisions(exactPaths, "exactPaths");
      for (let index = 1; index < exactPaths.length; index += 1) {
        if (exactPaths[index - 1] === exactPaths[index]) {
          fail("NATIVE_EVIDENCE_ARTIFACT_SET", "exactPaths must be unique");
        }
      }
      normalized.exactPaths = exactPaths;
    } else if (request.exactPaths !== undefined) {
      fail("NATIVE_EVIDENCE_ARTIFACT_SET", "exactPaths requires exact-paths mode");
    }
    return normalized;
  }
  if (command === "secure-path-operation") {
    const optional = ["root", "expectedIdentity", "destinationRelativePath", "contentSource"];
    assertKeys(request, ["relativePath", "operation"], optional, "secure-path-operation request");
    if (request.root !== undefined) assertRequestedRoot(runRoot, request.root);
    if (!["read", "create", "replace", "quarantine", "delete"].includes(request.operation)) {
      fail("NATIVE_OPERATION", "secure path operation is invalid");
    }
    const result = {
      relativePath: validateRelativeTarget(request.relativePath, "relativePath"),
      operation: request.operation,
    };
    if (request.expectedIdentity !== undefined)
      result.expectedIdentity = requireString(request.expectedIdentity, "expectedIdentity", {
        max: 128,
      });
    if (request.destinationRelativePath !== undefined) {
      result.destinationRelativePath = validateRelativeTarget(
        request.destinationRelativePath,
        "destinationRelativePath",
      );
    }
    const needsContent = ["create", "replace"].includes(request.operation);
    if (needsContent) result.contentSource = await normalizeContent(runRoot, request, operationId);
    else if (request.contentSource !== undefined)
      fail("NATIVE_CONTENT", "operation does not accept content");
    if (request.operation === "quarantine" && result.destinationRelativePath === undefined) {
      fail("NATIVE_TARGET_PATH", "quarantine requires destinationRelativePath");
    }
    return result;
  }
  if (command === "durable-replace") {
    assertKeys(
      request,
      ["relativePath", "tempRelativePath", "checkpoint", "retry", "contentSource"],
      ["root"],
      "durable-replace request",
    );
    if (request.root !== undefined) assertRequestedRoot(runRoot, request.root);
    assertExactKeys(
      request.retry,
      ["maxAttempts", "baseDelayMs", "maxDelayMs", "deadlineMs"],
      "retry policy",
    );
    requireInteger(request.retry.maxAttempts, "retry.maxAttempts", 1, 32);
    requireInteger(request.retry.baseDelayMs, "retry.baseDelayMs", 0, 10_000);
    requireInteger(request.retry.maxDelayMs, "retry.maxDelayMs", 0, 30_000);
    requireInteger(request.retry.deadlineMs, "retry.deadlineMs", 1, 120_000);
    if (request.retry.baseDelayMs > request.retry.maxDelayMs)
      fail("NATIVE_RETRY", "retry base delay exceeds maximum delay");
    if (
      ![
        "before-temp",
        "during-write",
        "after-file-flush",
        "before-rename",
        "during-rename",
        "after-rename",
      ].includes(request.checkpoint)
    ) {
      fail("NATIVE_CHECKPOINT", "durable replacement checkpoint is invalid");
    }
    return {
      relativePath: validateRelativeTarget(request.relativePath, "relativePath"),
      tempRelativePath: validateRelativeTarget(request.tempRelativePath, "tempRelativePath"),
      contentSource: await normalizeContent(runRoot, request, operationId),
      checkpoint: requireString(request.checkpoint, "checkpoint", { max: 32 }),
      retry: { ...request.retry },
    };
  }
  if (command === "pipe-name-derive") {
    assertExactKeys(request, ["appId", "canonicalHomeId"], "pipe-name-derive request");
    return {
      appId: requireString(request.appId, "appId", { max: 256 }),
      canonicalHomeId: requireString(request.canonicalHomeId, "canonicalHomeId", { max: 4096 }),
    };
  }
  if (command === "pipe-owner") return validatePipeRequest(request, true);
  if (command === "pipe-client") return validatePipeRequest(request, false);
  if (command === "pipe-foreign-precreate") {
    assertExactKeys(request, ["pipeName", "maxFrameBytes"], "pipe-foreign-precreate request");
    if (!frozenPipeName.test(request.pipeName))
      fail("NATIVE_PIPE_NAME", "pipeName does not match the frozen grammar");
    requireInteger(request.maxFrameBytes, "maxFrameBytes", 256, 65536);
    return { ...request };
  }
  if (command === "job-owner") {
    assertExactKeys(request, ["scenario", "deadlines"], "job-owner request");
    assertExactKeys(request.deadlines, ["startMs", "gracefulMs", "forceMs"], "job deadlines");
    requireInteger(request.deadlines.startMs, "deadlines.startMs", 1, 120_000);
    requireInteger(request.deadlines.gracefulMs, "deadlines.gracefulMs", 1, 120_000);
    requireInteger(request.deadlines.forceMs, "deadlines.forceMs", 1, 120_000);
    if (
      !["normal", "hung", "grandchild", "crash-before-ready", "crash-after-ready"].includes(
        request.scenario,
      )
    ) {
      fail("NATIVE_JOB_SCENARIO", "job scenario is invalid");
    }
    return {
      scenario: requireString(request.scenario, "scenario", { max: 32 }),
      deadlines: { ...request.deadlines },
    };
  }
  if (command === "process-identity") {
    assertExactKeys(request, ["pid"], "process-identity request");
    requireInteger(request.pid, "pid", 1, 0x7fffffff);
    return { pid: request.pid };
  }
  assertExactKeys(request, ["pid", "creationTimeSha256"], "job-query request");
  requireInteger(request.pid, "pid", 1, 0x7fffffff);
  requireHex64(request.creationTimeSha256, "creationTimeSha256");
  return { ...request };
}

function validateProcessEntry(value, label) {
  assertExactKeys(value, ["pid", "creationTimeSha256"], label);
  requireInteger(value.pid, `${label}.pid`, 1, 0x7fffffff);
  requireNullableHex64(value.creationTimeSha256, `${label}.creationTimeSha256`);
  return value;
}

function validateProcessEntries(value, label) {
  if (!Array.isArray(value) || value.length > 1024) {
    fail("NATIVE_RESULT_SCHEMA", `${label} must be a bounded array`);
  }
  value.forEach((entry, index) => validateProcessEntry(entry, `${label}[${index}]`));
  return value;
}

function validateEvidenceEntry(value, label, exactPaths) {
  assertExactKeys(value, ["path", "type", "bytes", "sha256", "objectIdentity"], label);
  const path = requireString(value.path, `${label}.path`, { max: 32767 });
  if (
    path.includes("\\") ||
    validateRelativeTarget(path, `${label}.path`).replaceAll("\\", "/") !== path
  ) {
    fail("NATIVE_RESULT_SCHEMA", `${label}.path is not canonical`);
  }
  const type = requireEnum(value.type, ["directory", "file"], `${label}.type`);
  requireInteger(value.bytes, `${label}.bytes`, 0, 512 * 1024 * 1024);
  if (type === "directory") {
    if (value.bytes !== 0 || value.sha256 !== null || exactPaths) {
      fail("NATIVE_RESULT_SCHEMA", `${label} directory fields are inconsistent`);
    }
  } else {
    requireHex64(value.sha256, `${label}.sha256`);
  }
  requireString(value.objectIdentity, `${label}.objectIdentity`, { max: 128 });
  return value;
}

function validateEvidenceResult(value) {
  const mode = requireEnum(
    value?.mode,
    ["entries", "digest-only", "exact-paths"],
    "native evidence result mode",
  );
  const exactPaths = mode === "exact-paths";
  const withEntries = mode !== "digest-only";
  assertExactKeys(
    value,
    withEntries
      ? [
          "mode",
          "rootObjectIdentity",
          "entryCount",
          "entries",
          "totalBytes",
          exactPaths ? "setSha256" : "treeSha256",
        ]
      : ["mode", "rootObjectIdentity", "entryCount", "totalBytes", "treeSha256"],
    "native evidence result",
  );
  requireString(value.rootObjectIdentity, "native evidence root identity", { max: 128 });
  requireInteger(value.entryCount, "native evidence entryCount", 0, 8192);
  requireInteger(value.totalBytes, "native evidence totalBytes", 0, 1024 * 1024 * 1024);
  requireHex64(
    exactPaths ? value.setSha256 : value.treeSha256,
    exactPaths ? "native evidence setSha256" : "native evidence treeSha256",
  );
  if (withEntries) {
    if (!Array.isArray(value.entries) || value.entries.length !== value.entryCount) {
      fail("NATIVE_RESULT_SCHEMA", "native evidence entry count is inconsistent");
    }
    let totalBytes = 0;
    let prior = null;
    const entryPaths = [];
    value.entries.forEach((entry, index) => {
      validateEvidenceEntry(entry, `native evidence entries[${index}]`, exactPaths);
      if (
        prior !== null &&
        Buffer.from(prior, "utf8").compare(Buffer.from(entry.path, "utf8")) >= 0
      ) {
        fail("NATIVE_RESULT_SCHEMA", "native evidence entries are not unique and sorted");
      }
      prior = entry.path;
      entryPaths.push(entry.path);
      if (entry.type === "file") totalBytes += entry.bytes;
    });
    assertNoWindowsPathCaseCollisions(entryPaths, "native evidence entries");
    if (totalBytes !== value.totalBytes) {
      fail("NATIVE_RESULT_SCHEMA", "native evidence byte count is inconsistent");
    }
    const computedSealSha256 = framedDigest(
      exactPaths
        ? "enduragent.windows-evidence-artifact-set-seal.v1"
        : "enduragent.windows-evidence-tree-seal.v1",
      value.rootObjectIdentity,
      ...value.entries.flatMap((entry) => [
        entry.path,
        entry.type,
        String(entry.bytes),
        entry.sha256 ?? "",
        entry.objectIdentity,
      ]),
    );
    if (computedSealSha256 !== (exactPaths ? value.setSha256 : value.treeSha256)) {
      fail("NATIVE_RESULT_DIGEST", "native evidence seal digest is inconsistent");
    }
  }
  return value;
}

export function validateNativeEvidenceSeal(value) {
  return freezeJson(validateEvidenceResult(value));
}

function validatePrivateDirectoryResult(value) {
  assertExactKeys(
    value,
    [
      "objectIdentity",
      "ownerSidSha256",
      "protectedAcl",
      "principals",
      "unexpectedAceCount",
      "sddlSha256",
    ],
    "private directory result",
  );
  requireString(value.objectIdentity, "private directory objectIdentity", { max: 128 });
  requireHex64(value.ownerSidSha256, "private directory ownerSidSha256");
  requireBoolean(value.protectedAcl, "private directory protectedAcl");
  if (!Array.isArray(value.principals) || value.principals.length > 3) {
    fail("NATIVE_RESULT_SCHEMA", "private directory principals must be bounded");
  }
  const principals = new Set();
  for (const principal of value.principals) {
    requireEnum(principal, ["current-user", "System", "Administrators"], "principal");
    if (principals.has(principal)) fail("NATIVE_RESULT_SCHEMA", "principal is duplicated");
    principals.add(principal);
  }
  requireInteger(value.unexpectedAceCount, "private directory unexpectedAceCount", 0, 1024);
  requireHex64(value.sddlSha256, "private directory sddlSha256");
  return value;
}

function validateNativeResult(command, value, resourceCommand) {
  if (!exactObject(value)) fail("NATIVE_RESULT_SCHEMA", "native result must be an object");
  if (command === "native-binding-check") {
    assertExactKeys(
      value,
      [
        "ready",
        "processId",
        "nativeHelperSha256",
        "runRootIdentity",
        "evidenceRootObjectIdentitySha256",
      ],
      "binding result",
    );
    if (value.ready !== true) fail("NATIVE_RESULT_SCHEMA", "native binding is not ready");
    requireInteger(value.processId, "binding processId", 1, 0x7fffffff);
    requireHex64(value.nativeHelperSha256, "binding nativeHelperSha256");
    requireString(value.runRootIdentity, "binding runRootIdentity", { max: 128 });
    requireHex64(
      value.evidenceRootObjectIdentitySha256,
      "binding evidenceRootObjectIdentitySha256",
    );
  } else if (command === "home-identity") {
    assertExactKeys(
      value,
      [
        "canonicalHomeId",
        "objectIdentity",
        "volumeIdentity",
        "finalPathSha256",
        "fileSystem",
        "driveType",
        "reparseTag",
        "linkCount",
      ],
      "home identity result",
    );
    requireString(value.canonicalHomeId, "canonicalHomeId", { max: 128 });
    requireString(value.objectIdentity, "home objectIdentity", { max: 128 });
    requireString(value.volumeIdentity, "home volumeIdentity", { max: 128 });
    requireHex64(value.finalPathSha256, "home finalPathSha256");
    requireEnum(value.fileSystem, ["NTFS"], "home fileSystem");
    requireEnum(value.driveType, ["fixed"], "home driveType");
    requireInteger(value.reparseTag, "home reparseTag", 0, 0xffffffff);
    requireInteger(value.linkCount, "home linkCount", 1, 0xffffffff);
  } else if (command === "private-directory-ensure" || command === "private-directory-inspect") {
    validatePrivateDirectoryResult(value);
  } else if (command === "private-file-create") {
    assertExactKeys(
      value,
      ["objectIdentity", "linkCount", "bytesWritten", "sddlSha256"],
      "private file result",
    );
    requireString(value.objectIdentity, "private file objectIdentity", { max: 128 });
    requireInteger(value.linkCount, "private file linkCount", 1, 0xffffffff);
    requireInteger(value.bytesWritten, "private file bytesWritten", 0, maxContentBytes);
    requireHex64(value.sddlSha256, "private file sddlSha256");
  } else if (command === "file-identity") {
    assertExactKeys(value, ["objectIdentity", "linkCount"], "file identity result");
    requireString(value.objectIdentity, "file objectIdentity", { max: 128 });
    requireInteger(value.linkCount, "file linkCount", 1, 0xffffffff);
  } else if (command === "evidence-tree-seal") {
    validateNativeEvidenceSeal(value);
  } else if (command === "secure-path-operation") {
    assertExactKeys(
      value,
      ["outcome", "objectIdentity", "contentSha256", "win32Code", "reasonCode"],
      "secure path result",
    );
    requireEnum(value.outcome, ["completed", "refused", "not-committed"], "path outcome");
    requireNullableString(value.objectIdentity, "path objectIdentity", { max: 128 });
    requireNullableHex64(value.contentSha256, "path contentSha256");
    requireNullableInteger(value.win32Code, "path win32Code", 0, 0xffffffff);
    requireNullableString(value.reasonCode, "path reasonCode", { max: 128 });
  } else if (command === "durable-replace") {
    assertExactKeys(value, ["outcome", "retries", "errorCode", "oldOrNewDigest"], "durable result");
    requireEnum(
      value.outcome,
      ["committed", "commit-uncertain", "not-committed"],
      "durable outcome",
    );
    requireInteger(value.retries, "durable retries", 0, 32);
    requireNullableString(value.errorCode, "durable errorCode", { max: 128 });
    requireHex64(value.oldOrNewDigest, "durable oldOrNewDigest");
  } else if (command === "pipe-name-derive") {
    assertExactKeys(value, ["pipeName", "suffix"], "pipe name result");
    if (!frozenPipeName.test(value.pipeName)) fail("NATIVE_RESULT_SCHEMA", "pipe name is invalid");
    requireHex64(value.suffix, "pipe suffix");
    if (!value.pipeName.endsWith(value.suffix))
      fail("NATIVE_RESULT_SCHEMA", "pipe suffix is mismatched");
  } else if (command === "pipe-owner") {
    assertExactKeys(
      value,
      ["sessionId", "state", "ownerSidSha256", "pipeNameSha256"],
      "pipe owner result",
    );
    requireString(value.sessionId, "pipe owner sessionId", { max: 64 });
    requireEnum(value.state, ["ready"], "pipe owner state");
    requireHex64(value.ownerSidSha256, "pipe owner SID digest");
    requireHex64(value.pipeNameSha256, "pipe owner name digest");
  } else if (command === "pipe-foreign-precreate") {
    assertExactKeys(value, ["sessionId", "state"], "foreign pipe result");
    requireString(value.sessionId, "foreign pipe sessionId", { max: 64 });
    requireEnum(value.state, ["ready"], "foreign pipe state");
  } else if (command === "pipe-client") {
    assertExactKeys(value, ["decision", "responseSha256"], "pipe client result");
    requireEnum(
      value.decision,
      ["designated", "reserved", "collision-refused", "refused"],
      "pipe client decision",
    );
    requireHex64(value.responseSha256, "pipe responseSha256");
  } else if (command === "job-owner") {
    assertExactKeys(
      value,
      ["sessionId", "state", "pid", "creationTimeSha256", "assignedBeforeResume", "insideOuterJob"],
      "job owner result",
    );
    requireString(value.sessionId, "job owner sessionId", { max: 64 });
    requireEnum(value.state, ["running"], "job owner state");
    requireInteger(value.pid, "job owner pid", 1, 0x7fffffff);
    requireHex64(value.creationTimeSha256, "job owner creationTimeSha256");
    if (value.assignedBeforeResume !== true)
      fail("NATIVE_RESULT_SCHEMA", "job was not assigned before resume");
    requireBoolean(value.insideOuterJob, "job owner insideOuterJob");
  } else if (command === "process-identity") {
    assertExactKeys(
      value,
      ["exists", "pid", "creationTimeSha256", "running", "exitCode"],
      "process identity result",
    );
    requireBoolean(value.exists, "process exists");
    requireInteger(value.pid, "process pid", 1, 0x7fffffff);
    requireNullableHex64(value.creationTimeSha256, "process creationTimeSha256");
    requireBoolean(value.running, "process running");
    requireNullableInteger(value.exitCode, "process exitCode", 0, 0xffffffff);
  } else if (command === "job-query") {
    assertExactKeys(
      value,
      ["exists", "identityMatches", "running", "exitCode"],
      "job query result",
    );
    requireBoolean(value.exists, "job query exists");
    requireBoolean(value.identityMatches, "job query identityMatches");
    requireBoolean(value.running, "job query running");
    requireNullableInteger(value.exitCode, "job query exitCode", 0, 0xffffffff);
  } else if (command === "session-control") {
    if (resourceCommand === "pipe-owner") {
      assertKeys(value, ["sessionId", "state"], ["capabilityConsumed"], "pipe control result");
      requireString(value.sessionId, "pipe control sessionId", { max: 64 });
      requireEnum(value.state, ["ready", "stopping", "closed"], "pipe control state");
      if (value.state === "closed") {
        if (value.capabilityConsumed !== undefined)
          fail("NATIVE_RESULT_SCHEMA", "closed pipe result has unexpected capability state");
      } else {
        requireBoolean(value.capabilityConsumed, "pipe capabilityConsumed");
      }
    } else if (resourceCommand === "pipe-foreign-precreate") {
      assertExactKeys(value, ["sessionId", "state"], "foreign pipe control result");
      requireString(value.sessionId, "foreign pipe control sessionId", { max: 64 });
      requireEnum(value.state, ["ready", "closed"], "foreign pipe control state");
    } else if (resourceCommand === "job-owner") {
      requireString(value.sessionId, "job control sessionId", { max: 64 });
      if (Object.hasOwn(value, "running")) {
        assertExactKeys(
          value,
          ["sessionId", "running", "identityMatches", "assigned", "processes"],
          "job query control result",
        );
        requireBoolean(value.running, "job control running");
        requireBoolean(value.identityMatches, "job control identityMatches");
        requireBoolean(value.assigned, "job control assigned");
        validateProcessEntries(value.processes, "job control processes");
      } else {
        requireEnum(
          value.outcome,
          ["exited", "graceful-unsupported", "terminated", "termination-failed", "closed"],
          "job action outcome",
        );
        if (value.outcome === "closed") {
          assertExactKeys(value, ["sessionId", "outcome"], "closed job result");
        } else {
          assertExactKeys(value, ["sessionId", "outcome", "identityMatches"], "job action result");
          requireBoolean(value.identityMatches, "job action identityMatches");
        }
      }
    } else {
      fail("NATIVE_RESULT_SCHEMA", "session control result has no bound resource command");
    }
  } else {
    fail("NATIVE_RESULT_SCHEMA", "native result command is not recognized");
  }
  return freezeJson(value);
}

export function validateNativeCommandResult(command, value) {
  if (!NATIVE_COMMANDS.includes(command)) {
    fail("NATIVE_COMMAND", "native command is not allowlisted");
  }
  return validateNativeResult(command, value);
}

function validateNativeEvent(resourceCommand, eventName, data) {
  if (resourceCommand === "pipe-owner") {
    if (eventName === "ready") {
      assertExactKeys(data, ["pipeNameSha256"], "pipe ready event");
      requireHex64(data.pipeNameSha256, "pipe ready digest");
    } else if (eventName === "client-decision") {
      assertExactKeys(data, ["decision", "reasonCode", "clientSidSha256"], "pipe decision event");
      requireEnum(
        data.decision,
        ["designated", "reserved", "collision-refused", "refused"],
        "pipe event decision",
      );
      requireString(data.reasonCode, "pipe event reasonCode", { max: 128 });
      requireHex64(data.clientSidSha256, "pipe event clientSidSha256");
    } else if (eventName === "client-error") {
      assertExactKeys(data, ["code", "win32Code"], "pipe error event");
      requireString(data.code, "pipe error code", { max: 64 });
      requireNullableInteger(data.win32Code, "pipe error win32Code", 0, 0xffffffff);
    } else {
      fail("NATIVE_EVENT_SCHEMA", "pipe owner emitted an unknown event");
    }
  } else if (resourceCommand === "job-owner") {
    if (["created", "assigned", "resumed"].includes(eventName)) {
      assertExactKeys(
        data,
        eventName === "created"
          ? ["pid", "creationTimeSha256", "suspended"]
          : ["pid", "creationTimeSha256", "assignedBeforeResume"],
        "job lifecycle event",
      );
      requireInteger(data.pid, "job event pid", 1, 0x7fffffff);
      requireHex64(data.creationTimeSha256, "job event creationTimeSha256");
      if (eventName === "created" && data.suspended !== true)
        fail("NATIVE_EVENT_SCHEMA", "created job was not suspended");
      if (eventName !== "created" && data.assignedBeforeResume !== true)
        fail("NATIVE_EVENT_SCHEMA", "job was not assigned before resume");
    } else if (eventName === "terminated") {
      assertExactKeys(data, ["pid", "exited"], "job terminated event");
      requireInteger(data.pid, "job terminated pid", 1, 0x7fffffff);
      requireBoolean(data.exited, "job terminated exited");
    } else if (eventName === "tree") {
      assertExactKeys(data, ["processes"], "job tree event");
      validateProcessEntries(data.processes, "job event processes");
    } else {
      fail("NATIVE_EVENT_SCHEMA", "job owner emitted an unknown event");
    }
  } else {
    fail("NATIVE_EVENT_SCHEMA", "native event has no event-capable resource binding");
  }
  return freezeJson(data);
}

function requireCanonicalRelativePath(value, label, { posix = false } = {}) {
  const normalized = validateRelativeTarget(value, label);
  const expected = posix ? normalized.replaceAll("\\", "/") : normalized;
  if (value !== expected) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", `${label} is not in canonical native form`);
  }
  return value;
}

function validateTranscriptContentSource(value, label) {
  const normalized = validateContentSource(value);
  if (normalized.kind === "staged-file" && normalized.relativePath !== value.relativePath) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", `${label}.relativePath is not in canonical native form`);
  }
}

function validateTranscriptRequest(command, request) {
  if (!exactObject(request)) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript request must be an object");
  }
  if (command === "home-identity") {
    assertExactKeys(request, ["relativePath"], "transcript home-identity request");
    requireCanonicalRelativePath(request.relativePath, "transcript request.relativePath");
    return;
  }
  if (command === "private-directory-ensure") {
    assertExactKeys(
      request,
      ["relativePath", "action"],
      "transcript private-directory-ensure request",
    );
    requireCanonicalRelativePath(request.relativePath, "transcript request.relativePath");
    requireEnum(request.action, ["create", "repair"], "transcript request.action");
    return;
  }
  if (command === "private-directory-inspect" || command === "file-identity") {
    assertExactKeys(request, ["relativePath"], `transcript ${command} request`);
    requireCanonicalRelativePath(request.relativePath, "transcript request.relativePath");
    return;
  }
  if (command === "private-file-create") {
    assertExactKeys(
      request,
      ["relativePath", "contentSource"],
      "transcript private-file-create request",
    );
    requireCanonicalRelativePath(request.relativePath, "transcript request.relativePath");
    validateTranscriptContentSource(request.contentSource, "transcript request.contentSource");
    return;
  }
  if (command === "secure-path-operation") {
    assertKeys(
      request,
      ["relativePath", "operation"],
      ["expectedIdentity", "destinationRelativePath", "contentSource"],
      "transcript secure-path-operation request",
    );
    requireCanonicalRelativePath(request.relativePath, "transcript request.relativePath");
    const operation = requireEnum(
      request.operation,
      ["read", "create", "replace", "quarantine", "delete"],
      "transcript request.operation",
    );
    if (request.expectedIdentity !== undefined) {
      requireString(request.expectedIdentity, "transcript request.expectedIdentity", {
        max: 128,
      });
    }
    if (request.destinationRelativePath !== undefined) {
      requireCanonicalRelativePath(
        request.destinationRelativePath,
        "transcript request.destinationRelativePath",
      );
    }
    if (operation === "create" || operation === "replace") {
      if (request.contentSource === undefined) {
        fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript write request has no content source");
      }
      validateTranscriptContentSource(request.contentSource, "transcript request.contentSource");
    } else if (request.contentSource !== undefined) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript non-write request has content");
    }
    if (operation === "quarantine" && request.destinationRelativePath === undefined) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript quarantine has no destination");
    }
    return;
  }
  if (command === "evidence-tree-seal") {
    const mode = requireEnum(
      request.mode,
      ["entries", "digest-only", "exact-paths"],
      "transcript evidence mode",
    );
    const baseKeys = [
      "relativePath",
      "mode",
      "maxDepth",
      "maxEntries",
      "maxFileBytes",
      "maxTotalBytes",
    ];
    assertExactKeys(
      request,
      mode === "exact-paths" ? [...baseKeys, "exactPaths"] : baseKeys,
      "transcript evidence-tree-seal request",
    );
    requireCanonicalRelativePath(request.relativePath, "transcript request.relativePath");
    requireInteger(request.maxDepth, "transcript request.maxDepth", 1, 64);
    requireInteger(request.maxEntries, "transcript request.maxEntries", 1, 8192);
    requireInteger(request.maxFileBytes, "transcript request.maxFileBytes", 1, 512 * 1024 * 1024);
    requireInteger(
      request.maxTotalBytes,
      "transcript request.maxTotalBytes",
      1,
      1024 * 1024 * 1024,
    );
    if (mode === "exact-paths") {
      if (
        !Array.isArray(request.exactPaths) ||
        request.exactPaths.length === 0 ||
        request.exactPaths.length > Math.min(request.maxEntries, 768)
      ) {
        fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript exact artifact set is invalid");
      }
      let prior = null;
      const exactPaths = [];
      request.exactPaths.forEach((path, index) => {
        requireCanonicalRelativePath(path, `transcript request.exactPaths[${index}]`, {
          posix: true,
        });
        if (prior !== null && Buffer.from(prior, "utf8").compare(Buffer.from(path, "utf8")) >= 0) {
          fail(
            "NATIVE_TRANSCRIPT_SCHEMA",
            "native transcript exact artifact paths are not unique and sorted",
          );
        }
        prior = path;
        exactPaths.push(path);
      });
      assertNoWindowsPathCaseCollisions(exactPaths, "native transcript exact artifact paths");
    }
    return;
  }
  if (command === "durable-replace") {
    assertExactKeys(
      request,
      ["relativePath", "tempRelativePath", "contentSource", "checkpoint", "retry"],
      "transcript durable-replace request",
    );
    requireCanonicalRelativePath(request.relativePath, "transcript request.relativePath");
    requireCanonicalRelativePath(request.tempRelativePath, "transcript request.tempRelativePath");
    validateTranscriptContentSource(request.contentSource, "transcript request.contentSource");
    requireEnum(
      request.checkpoint,
      [
        "before-temp",
        "during-write",
        "after-file-flush",
        "before-rename",
        "during-rename",
        "after-rename",
      ],
      "transcript request.checkpoint",
    );
    assertExactKeys(
      request.retry,
      ["maxAttempts", "baseDelayMs", "maxDelayMs", "deadlineMs"],
      "transcript retry policy",
    );
    requireInteger(request.retry.maxAttempts, "transcript retry.maxAttempts", 1, 32);
    requireInteger(request.retry.baseDelayMs, "transcript retry.baseDelayMs", 0, 10_000);
    requireInteger(request.retry.maxDelayMs, "transcript retry.maxDelayMs", 0, 30_000);
    requireInteger(request.retry.deadlineMs, "transcript retry.deadlineMs", 1, 120_000);
    if (request.retry.baseDelayMs > request.retry.maxDelayMs) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript retry bounds are inconsistent");
    }
    return;
  }
  if (command === "pipe-name-derive") {
    assertExactKeys(request, ["appId", "canonicalHomeId"], "transcript pipe-name-derive request");
    requireString(request.appId, "transcript request.appId", { max: 256 });
    requireString(request.canonicalHomeId, "transcript request.canonicalHomeId", { max: 4096 });
    return;
  }
  if (command === "pipe-owner" || command === "pipe-client") {
    const owner = command === "pipe-owner";
    assertExactKeys(
      request,
      owner
        ? [
            "pipeName",
            "capabilitySha256",
            "bindingSha256",
            "maxFrameBytes",
            "connectDeadlineMs",
            "readDeadlineMs",
          ]
        : [
            "pipeName",
            "capabilitySha256",
            "bindingSha256",
            "role",
            "maxFrameBytes",
            "connectDeadlineMs",
            "readDeadlineMs",
          ],
      owner ? "transcript pipe-owner request" : "transcript pipe-client request",
    );
    if (!frozenPipeName.test(request.pipeName)) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript pipe name is invalid");
    }
    requireHex64(request.capabilitySha256, "transcript request.capabilitySha256");
    requireHex64(request.bindingSha256, "transcript request.bindingSha256");
    if (!owner) requireEnum(request.role, ["ordinary", "successor"], "transcript request.role");
    requireInteger(request.maxFrameBytes, "transcript request.maxFrameBytes", 256, 65536);
    requireInteger(request.connectDeadlineMs, "transcript request.connectDeadlineMs", 1, 120000);
    requireInteger(request.readDeadlineMs, "transcript request.readDeadlineMs", 1, 120000);
    return;
  }
  if (command === "pipe-foreign-precreate") {
    assertExactKeys(
      request,
      ["pipeName", "maxFrameBytes"],
      "transcript pipe-foreign-precreate request",
    );
    if (!frozenPipeName.test(request.pipeName)) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript pipe name is invalid");
    }
    requireInteger(request.maxFrameBytes, "transcript request.maxFrameBytes", 256, 65536);
    return;
  }
  if (command === "job-owner") {
    assertExactKeys(request, ["scenario", "deadlines"], "transcript job-owner request");
    requireEnum(
      request.scenario,
      ["normal", "hung", "grandchild", "crash-before-ready", "crash-after-ready"],
      "transcript request.scenario",
    );
    assertExactKeys(
      request.deadlines,
      ["startMs", "gracefulMs", "forceMs"],
      "transcript job deadlines",
    );
    requireInteger(request.deadlines.startMs, "transcript deadlines.startMs", 1, 120_000);
    requireInteger(request.deadlines.gracefulMs, "transcript deadlines.gracefulMs", 1, 120_000);
    requireInteger(request.deadlines.forceMs, "transcript deadlines.forceMs", 1, 120_000);
    return;
  }
  if (command === "process-identity") {
    assertExactKeys(request, ["pid"], "transcript process-identity request");
    requireInteger(request.pid, "transcript request.pid", 1, 0x7fffffff);
    return;
  }
  if (command === "job-query") {
    assertExactKeys(request, ["pid", "creationTimeSha256"], "transcript job-query request");
    requireInteger(request.pid, "transcript request.pid", 1, 0x7fffffff);
    requireHex64(request.creationTimeSha256, "transcript request.creationTimeSha256");
    return;
  }
  if (command === "session-control") {
    assertExactKeys(request, ["sessionId", "action"], "transcript session-control request");
    requireString(request.sessionId, "transcript request.sessionId", { min: 2, max: 64 });
    requireEnum(
      request.action,
      ["query", "graceful", "terminate", "close"],
      "transcript request.action",
    );
    return;
  }
  fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript command is not recognized");
}

function requireProtocolIdentifier(value, label) {
  const identifier = requireString(value, label, { min: 1, max: 64 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(identifier)) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", `${label} is not a protocol identifier`);
  }
  return identifier;
}

function validateTranscriptStartupHandshake(value, binding) {
  assertExactKeys(
    value,
    ["protocolVersion", "kind", "requestId", "command", "context", "ok", "result"],
    "native transcript startup handshake",
  );
  if (
    value.protocolVersion !== NATIVE_PROTOCOL_VERSION ||
    value.kind !== "response" ||
    value.command !== "native-binding-check" ||
    value.ok !== true
  ) {
    fail("NATIVE_TRANSCRIPT_HANDSHAKE", "native transcript startup handshake is invalid");
  }
  const requestId = requireProtocolIdentifier(
    value.requestId,
    "native transcript startup requestId",
  );
  assertExactKeys(
    value.context,
    [
      "campaignRunId",
      "candidateSha256",
      "preflightSha256",
      "executionBundleManifestSha256",
      "nativeCandidateDigest",
      "nativeManifestSha256",
      "nativeHelperSha256",
      "evidenceRootObjectIdentitySha256",
      "nativeSessionId",
      "operationId",
      "requestFrameSha256",
      "runRootIdentity",
    ],
    "native transcript startup context",
  );
  const operationId = requireProtocolIdentifier(
    value.context.operationId,
    "native transcript startup operationId",
  );
  const requestContext = transcriptRequestContext(binding, operationId);
  for (const [key, expected] of Object.entries(requestContext)) {
    if (value.context[key] !== expected) {
      fail("NATIVE_TRANSCRIPT_HANDSHAKE", "native startup request context differs from binding");
    }
  }
  if (value.context.runRootIdentity !== binding.runRootIdentity) {
    fail("NATIVE_TRANSCRIPT_HANDSHAKE", "native startup run root differs from binding");
  }
  const expectedRequestFrameSha256 = canonicalJsonSha256({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId,
    command: "native-binding-check",
    context: requestContext,
    request: {},
  });
  if (
    requireHex64(
      value.context.requestFrameSha256,
      "native transcript startup requestFrameSha256",
    ) !== expectedRequestFrameSha256
  ) {
    fail("NATIVE_TRANSCRIPT_HANDSHAKE", "native startup request digest is inconsistent");
  }
  validateNativeResult("native-binding-check", value.result);
  if (
    value.result.nativeHelperSha256 !== binding.nativeHelperSha256 ||
    value.result.runRootIdentity !== binding.runRootIdentity ||
    value.result.evidenceRootObjectIdentitySha256 !== binding.evidenceRootObjectIdentitySha256
  ) {
    fail("NATIVE_TRANSCRIPT_HANDSHAKE", "native startup result differs from binding");
  }
  return { requestId, operationId };
}

function validateTranscriptBinding(value) {
  assertExactKeys(
    value,
    [
      "campaignRunId",
      "candidateSha256",
      "preflightSha256",
      "executionBundleManifestSha256",
      "nativeHelperArtifactPath",
      "nativeHelperSha256",
      "evidenceRootObjectIdentitySha256",
      "nativeCandidateDigest",
      "nativeManifestSha256",
      "nativeSessionId",
      "runRootIdentity",
      "startupHandshake",
      "startupHandshakeSha256",
    ],
    "native transcript binding",
  );
  validatePreflightBinding({
    campaignRunId: value.campaignRunId,
    candidateSha256: value.candidateSha256,
    preflightSha256: value.preflightSha256,
    executionBundleManifestSha256: value.executionBundleManifestSha256,
    nativeHelperArtifactPath: value.nativeHelperArtifactPath,
    nativeHelperSha256: value.nativeHelperSha256,
    nativeCandidateDigest: value.nativeCandidateDigest,
    nativeManifestSha256: value.nativeManifestSha256,
    evidenceRootObjectIdentitySha256: value.evidenceRootObjectIdentitySha256,
  });
  requireProtocolIdentifier(value.nativeSessionId, "native transcript nativeSessionId");
  requireString(value.runRootIdentity, "native transcript runRootIdentity", { max: 128 });
  if (
    sha256(Buffer.from(value.runRootIdentity, "utf8")) !== value.evidenceRootObjectIdentitySha256
  ) {
    fail("NATIVE_TRANSCRIPT_BINDING", "native transcript run root differs from preflight");
  }
  const startup = validateTranscriptStartupHandshake(value.startupHandshake, value);
  if (
    requireHex64(value.startupHandshakeSha256, "native transcript startupHandshakeSha256") !==
    canonicalJsonSha256(value.startupHandshake)
  ) {
    fail("NATIVE_TRANSCRIPT_HANDSHAKE", "native startup response digest is inconsistent");
  }
  return startup;
}

function validateTranscriptTermination(value) {
  if (value === null) return;
  if (!exactObject(value)) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript termination must be an object or null");
  }
  if (value.mode === "clean-eof") {
    assertExactKeys(value, ["mode", "code", "signal"], "native transcript termination");
    if (value.code !== 0 || value.signal !== null) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native clean termination is inconsistent");
    }
    return;
  }
  if (value.mode !== "expected-termination") {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript termination mode is invalid");
  }
  assertExactKeys(
    value,
    ["mode", "code", "signal", "expectedCode", "expectedSignal", "killSignal"],
    "native transcript termination",
  );
  const code = requireNullableInteger(value.code, "native transcript exit code", 0, 0xffffffff);
  const signal = requireNullableString(value.signal, "native transcript exit signal", { max: 32 });
  const expectedCode = requireNullableInteger(
    value.expectedCode,
    "native transcript expected exit code",
    0,
    0xffffffff,
  );
  const expectedSignal = requireNullableString(
    value.expectedSignal,
    "native transcript expected exit signal",
    { max: 32 },
  );
  requireEnum(value.killSignal, ["SIGTERM", "SIGKILL"], "native transcript kill signal");
  if (code !== expectedCode || signal !== expectedSignal || (code === null) === (signal === null)) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native expected termination is inconsistent");
  }
}

function transcriptRequestContext(binding, operationId) {
  return {
    campaignRunId: binding.campaignRunId,
    candidateSha256: binding.candidateSha256,
    preflightSha256: binding.preflightSha256,
    executionBundleManifestSha256: binding.executionBundleManifestSha256,
    nativeCandidateDigest: binding.nativeCandidateDigest,
    nativeManifestSha256: binding.nativeManifestSha256,
    nativeHelperSha256: binding.nativeHelperSha256,
    evidenceRootObjectIdentitySha256: binding.evidenceRootObjectIdentitySha256,
    nativeSessionId: binding.nativeSessionId,
    operationId,
  };
}

function transcriptResponseContext(binding, operationId, requestFrameSha256) {
  return {
    ...transcriptRequestContext(binding, operationId),
    requestFrameSha256,
    runRootIdentity: binding.runRootIdentity,
  };
}

function transcriptEventContext(binding, operationId) {
  return {
    ...transcriptRequestContext(binding, operationId),
    runRootIdentity: binding.runRootIdentity,
  };
}

function validateTranscriptCommandRecord(record, binding, state) {
  requireBoolean(record.ok, "native transcript command ok");
  assertExactKeys(
    record,
    record.ok
      ? [
          "kind",
          "sequence",
          "requestId",
          "command",
          "operationId",
          "requestFrameSha256",
          "nativeRequestFrameSha256",
          "requestFrameVerification",
          "responseFrameSha256",
          "ok",
          "request",
          "result",
        ]
      : [
          "kind",
          "sequence",
          "requestId",
          "command",
          "operationId",
          "requestFrameSha256",
          "nativeRequestFrameSha256",
          "requestFrameVerification",
          "responseFrameSha256",
          "ok",
          "request",
          "error",
        ],
    "native transcript command record",
  );
  const requestId = requireProtocolIdentifier(record.requestId, "native transcript requestId");
  if (state.requestIds.has(requestId)) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript requestId is duplicated");
  }
  state.requestIds.add(requestId);
  const command = requireString(record.command, "native transcript command", { max: 64 });
  if (command !== "session-control" && !NATIVE_COMMANDS.includes(command)) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript command is not allowlisted");
  }
  const operationId = requireProtocolIdentifier(
    record.operationId,
    "native transcript operationId",
  );
  if (state.commandOperations.has(operationId)) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript command operation is duplicated");
  }
  state.commandOperations.set(operationId, command);
  validateTranscriptRequest(command, record.request);
  const requestFrameSha256 = requireHex64(
    record.requestFrameSha256,
    "native transcript requestFrameSha256",
  );
  const nativeRequestFrameSha256 = requireHex64(
    record.nativeRequestFrameSha256,
    "native transcript nativeRequestFrameSha256",
  );
  if (requestFrameSha256 !== nativeRequestFrameSha256) {
    fail("NATIVE_TRANSCRIPT_REQUEST_RECEIPT", "native request receipt differs from sent frame");
  }
  const projectedPipeRequest = command === "pipe-owner" || command === "pipe-client";
  const requestFrameVerification = requireEnum(
    record.requestFrameVerification,
    ["recomputed", "native-receipt"],
    "native transcript requestFrameVerification",
  );
  if (requestFrameVerification !== (projectedPipeRequest ? "native-receipt" : "recomputed")) {
    fail("NATIVE_TRANSCRIPT_REQUEST_DIGEST", "native request verification mode is inconsistent");
  }
  if (!projectedPipeRequest) {
    const expectedRequestDigest = canonicalJsonSha256({
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId,
      command,
      context: transcriptRequestContext(binding, operationId),
      request: record.request,
    });
    if (requestFrameSha256 !== expectedRequestDigest) {
      fail("NATIVE_TRANSCRIPT_REQUEST_DIGEST", "native transcript request digest is inconsistent");
    }
  }
  let responsePayload;
  if (record.ok) {
    let resourceCommand;
    if (command === "session-control") {
      const resource = state.successfulSessions.get(record.request.sessionId);
      if (resource === undefined || state.closedSessions.has(record.request.sessionId)) {
        fail("NATIVE_TRANSCRIPT_SESSION", "native session control has no live owner");
      }
      resourceCommand = resource.command;
    }
    validateNativeResult(command, record.result, resourceCommand);
    if (command === "session-control") {
      if (record.result.sessionId !== record.request.sessionId) {
        fail("NATIVE_TRANSCRIPT_SESSION", "native session control result is mismatched");
      }
      if (record.request.action === "close") {
        state.closedSessions.add(record.request.sessionId);
      }
    }
    if (["pipe-owner", "pipe-foreign-precreate", "job-owner"].includes(command)) {
      const sessionId = requireProtocolIdentifier(
        record.result.sessionId,
        "native transcript resource sessionId",
      );
      const prior = state.resourceBindings.get(sessionId);
      if (prior !== undefined && (prior.command !== command || prior.operationId !== operationId)) {
        fail("NATIVE_TRANSCRIPT_SESSION", "native resource session binding changed");
      }
      state.resourceBindings.set(sessionId, { command, operationId });
      state.successfulSessions.set(sessionId, { command, operationId });
      state.ownerResultSessions.set(operationId, sessionId);
    }
    responsePayload = { result: record.result };
  } else {
    assertExactKeys(record.error, ["code", "message", "win32Code"], "native transcript error");
    requireString(record.error.code, "native transcript error.code", { max: 64 });
    requireString(record.error.message, "native transcript error.message", { max: 256 });
    requireNullableInteger(
      record.error.win32Code,
      "native transcript error.win32Code",
      0,
      0xffffffff,
    );
    responsePayload = { error: record.error };
  }
  const expectedResponseDigest = canonicalJsonSha256({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    command,
    context: transcriptResponseContext(binding, operationId, nativeRequestFrameSha256),
    ok: record.ok,
    ...responsePayload,
  });
  if (
    requireHex64(record.responseFrameSha256, "native transcript responseFrameSha256") !==
    expectedResponseDigest
  ) {
    fail("NATIVE_TRANSCRIPT_RESPONSE_DIGEST", "native transcript response digest is inconsistent");
  }
}

function validateTranscriptEventRecord(record, binding, state) {
  assertExactKeys(
    record,
    [
      "kind",
      "sequence",
      "resourceSessionId",
      "resourceCommand",
      "operationId",
      "event",
      "eventSequence",
      "eventFrameSha256",
      "data",
    ],
    "native transcript event record",
  );
  const sessionId = requireProtocolIdentifier(
    record.resourceSessionId,
    "native transcript resourceSessionId",
  );
  const resourceCommand = requireEnum(
    record.resourceCommand,
    ["pipe-owner", "job-owner"],
    "native transcript resourceCommand",
  );
  const operationId = requireProtocolIdentifier(
    record.operationId,
    "native transcript operationId",
  );
  const prior = state.resourceBindings.get(sessionId);
  if (
    prior !== undefined &&
    (prior.command !== resourceCommand || prior.operationId !== operationId)
  ) {
    fail("NATIVE_TRANSCRIPT_SESSION", "native event resource binding changed");
  }
  if (state.closedSessions.has(sessionId)) {
    fail("NATIVE_TRANSCRIPT_SESSION", "native event followed resource closure");
  }
  state.resourceBindings.set(sessionId, { command: resourceCommand, operationId });
  const event = requireString(record.event, "native transcript event", { max: 64 });
  const eventSequence = requireInteger(
    record.eventSequence,
    "native transcript eventSequence",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const priorEventSequence = state.eventSequences.get(sessionId) ?? 0;
  if (eventSequence !== priorEventSequence + 1) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript event sequence is not contiguous");
  }
  state.eventSequences.set(sessionId, eventSequence);
  validateNativeEvent(resourceCommand, event, record.data);
  const expectedEventDigest = canonicalJsonSha256({
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    kind: "event",
    sessionId,
    context: transcriptEventContext(binding, operationId),
    sequence: eventSequence,
    event,
    data: record.data,
  });
  if (
    requireHex64(record.eventFrameSha256, "native transcript eventFrameSha256") !==
    expectedEventDigest
  ) {
    fail("NATIVE_TRANSCRIPT_EVENT_DIGEST", "native transcript event digest is inconsistent");
  }
  state.eventBindings.push({ sessionId, resourceCommand, operationId });
}

export function validateNativeCommandTranscript(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "binding", "records", "termination", "transcriptSha256"],
    "native command transcript",
  );
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-native-command-transcript") {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native command transcript identity is invalid");
  }
  const startup = validateTranscriptBinding(value.binding);
  if (!Array.isArray(value.records) || value.records.length > 65_536) {
    fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript records must be a bounded array");
  }
  const state = {
    requestIds: new Set([startup.requestId]),
    commandOperations: new Map([[startup.operationId, "native-binding-check"]]),
    resourceBindings: new Map(),
    successfulSessions: new Map(),
    ownerResultSessions: new Map(),
    closedSessions: new Set(),
    eventSequences: new Map(),
    eventBindings: [],
  };
  value.records.forEach((record, index) => {
    if (!exactObject(record)) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript record must be an object");
    }
    requireInteger(record.sequence, "native transcript record sequence", 1, 65_536);
    if (record.sequence !== index + 1) {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript record sequence is not contiguous");
    }
    if (record.kind === "command") {
      validateTranscriptCommandRecord(record, value.binding, state);
    } else if (record.kind === "event") {
      validateTranscriptEventRecord(record, value.binding, state);
    } else {
      fail("NATIVE_TRANSCRIPT_SCHEMA", "native transcript record kind is invalid");
    }
  });
  for (const eventBinding of state.eventBindings) {
    if (state.commandOperations.get(eventBinding.operationId) !== eventBinding.resourceCommand) {
      fail("NATIVE_TRANSCRIPT_SESSION", "native event has no matching owner command");
    }
    const ownerSessionId = state.ownerResultSessions.get(eventBinding.operationId);
    if (ownerSessionId === undefined || ownerSessionId !== eventBinding.sessionId) {
      fail("NATIVE_TRANSCRIPT_SESSION", "native event has no successful matching owner result");
    }
  }
  validateTranscriptTermination(value.termination);
  const suppliedDigest = requireHex64(value.transcriptSha256, "native transcript transcriptSha256");
  const payload = canonicalJson({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    binding: value.binding,
    records: value.records,
    termination: value.termination,
  });
  if (nativeTranscriptSha256(payload) !== suppliedDigest) {
    fail("NATIVE_TRANSCRIPT_DIGEST", "native command transcript digest is inconsistent");
  }
  return freezeJson(canonicalJson({ ...payload, transcriptSha256: suppliedDigest }));
}

function retainedBuildIdentity(build) {
  return Object.freeze({
    candidateDigest: build.candidateDigest,
    assemblySha256: build.assemblySha256,
    sourceBundleSha256: build.sourceBundleSha256,
    toolchainDigest: build.toolchainDigest,
    manifestSha256: build.manifestSha256,
    sources: build.sources.map((source) => ({ ...source })),
    toolchain: { ...build.toolchain },
  });
}

function prepareNativeTransmission(
  preflightBinding,
  nativeSessionId,
  command,
  request,
  operationId,
  timeoutMs,
  { record = true } = {},
) {
  requireProtocolIdentifier(operationId, "native operationId");
  requireInteger(timeoutMs, "timeoutMs", 1, 300_000);
  const requestId = randomId("req");
  const requestFrame = freezeJson(
    canonicalJson({
      protocolVersion: NATIVE_PROTOCOL_VERSION,
      requestId,
      command,
      context: {
        campaignRunId: preflightBinding.campaignRunId,
        candidateSha256: preflightBinding.candidateSha256,
        preflightSha256: preflightBinding.preflightSha256,
        executionBundleManifestSha256: preflightBinding.executionBundleManifestSha256,
        nativeCandidateDigest: preflightBinding.nativeCandidateDigest,
        nativeManifestSha256: preflightBinding.nativeManifestSha256,
        nativeHelperSha256: preflightBinding.nativeHelperSha256,
        evidenceRootObjectIdentitySha256: preflightBinding.evidenceRootObjectIdentitySha256,
        nativeSessionId,
        operationId,
      },
      request,
    }),
  );
  const frameBytes = Buffer.from(`${JSON.stringify(requestFrame)}\n`, "utf8");
  if (frameBytes.length > maxInputFrameBytes) {
    fail("NATIVE_REQUEST_FRAME", "native request exceeds the frame limit");
  }
  return Object.freeze({
    command,
    operationId,
    requestId,
    timeoutMs,
    requestFrame,
    requestFrameSha256: sha256(frameBytes.subarray(0, frameBytes.length - 1)),
    frameBytes: Buffer.from(frameBytes),
    record,
  });
}

function publicPreparedRequest(prepared) {
  return freezeJson({
    command: prepared.command,
    operationId: prepared.operationId,
    requestId: prepared.requestId,
    timeoutMs: prepared.timeoutMs,
    requestFrame: prepared.requestFrame,
    requestFrameSha256: prepared.requestFrameSha256,
  });
}

function commandFailureError(failure) {
  const error = new NativeClientError(failure.code, failure.message);
  if (failure.win32Code !== null) error.win32Code = failure.win32Code;
  return error;
}

class NativeBrokerContextTransport {
  constructor({ build, mailboxRoot, observationOnly = false, signal, totalTimeoutMs = null }) {
    this.pending = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.protocolError = null;
    this.closed = false;
    this.totalTimer = null;
    this.child = spawn(
      build.assemblyPath,
      [observationOnly ? "--broker-context-observe" : "--broker-context-channel"],
      {
        cwd: mailboxRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildNativeChildEnvironment(process.env),
      },
    );
    this.exit = new Promise((resolveExit, rejectExit) => {
      this.child.once("error", () => {
        const error = new NativeClientError(
          "NATIVE_BROKER_CONTEXT_SPAWN",
          "native broker-context helper could not be started",
        );
        this.closed = true;
        if (this.totalTimer !== null) clearTimeout(this.totalTimer);
        signal?.removeEventListener("abort", this.abort);
        if (this.pending !== null) {
          clearTimeout(this.pending.timer);
          this.pending.reject(error);
          this.pending = null;
        }
        rejectExit(error);
      });
      this.child.once("exit", (code, exitSignal) => {
        this.closed = true;
        if (this.totalTimer !== null) clearTimeout(this.totalTimer);
        signal?.removeEventListener("abort", this.abort);
        if (this.pending !== null) {
          clearTimeout(this.pending.timer);
          this.pending.reject(
            new NativeClientError(
              "NATIVE_BROKER_CONTEXT_EARLY_EXIT",
              "native broker-context helper exited before responding",
            ),
          );
          this.pending = null;
        }
        resolveExit({ code, signal: exitSignal });
      });
    });
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > maxStderrBytes) {
        this.#violate(
          "NATIVE_BROKER_CONTEXT_STDERR_LIMIT",
          "native broker-context helper exceeded its stderr limit",
        );
      }
    });
    this.abort = () =>
      this.#violate("NATIVE_BROKER_CONTEXT_ABORTED", "native broker-context helper was aborted");
    if (totalTimeoutMs !== null) {
      this.totalTimer = setTimeout(
        () =>
          this.#violate(
            "NATIVE_BROKER_CONTEXT_TIMEOUT",
            "native broker-context helper exceeded its total deadline",
          ),
        totalTimeoutMs,
      );
    }
    if (signal?.aborted) this.abort();
    else signal?.addEventListener("abort", this.abort, { once: true });
  }

  #onStdout(chunk) {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > maxProcessOutputBytes) {
      this.#violate(
        "NATIVE_BROKER_CONTEXT_STDOUT_LIMIT",
        "native broker-context helper exceeded its output limit",
      );
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length === 0 || line.length > maxOutputFrameBytes || this.pending === null) {
        this.#violate(
          "NATIVE_BROKER_CONTEXT_RESPONSE",
          "native broker-context helper emitted an unexpected response frame",
        );
        return;
      }
      let value;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        value = JSON.parse(text);
        if (JSON.stringify(canonicalJson(value)) !== text) {
          throw new Error("non-canonical broker-context response");
        }
      } catch {
        this.#violate(
          "NATIVE_BROKER_CONTEXT_RESPONSE",
          "native broker-context helper emitted invalid JSON",
        );
        return;
      }
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(value);
    }
    if (this.stdoutBuffer.length > maxOutputFrameBytes) {
      this.#violate(
        "NATIVE_BROKER_CONTEXT_RESPONSE",
        "native broker-context response frame exceeded its limit",
      );
    }
  }

  #violate(code, message) {
    if (this.protocolError !== null) return;
    this.protocolError = new NativeClientError(code, message);
    this.child.kill();
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.protocolError);
      this.pending = null;
    }
  }

  isOpen() {
    return !this.closed && this.protocolError === null;
  }

  exchange(frame, timeoutMs) {
    if (!this.isOpen()) {
      return Promise.reject(
        this.protocolError ??
          new NativeClientError(
            "NATIVE_BROKER_CONTEXT_CLOSED",
            "native broker-context helper is closed",
          ),
      );
    }
    if (this.pending !== null) {
      return Promise.reject(
        new NativeClientError(
          "NATIVE_BROKER_CONTEXT_BUSY",
          "native broker-context helper already has a pending frame",
        ),
      );
    }
    const bytes = Buffer.from(`${JSON.stringify(canonicalJson(frame))}\n`, "utf8");
    if (bytes.length === 0 || bytes.length > maxInputFrameBytes) {
      return Promise.reject(
        new NativeClientError(
          "NATIVE_BROKER_CONTEXT_FRAME",
          "native broker-context input frame exceeds its bound",
        ),
      );
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending = null;
        rejectPromise(
          new NativeClientError(
            "NATIVE_BROKER_CONTEXT_REQUEST_TIMEOUT",
            "native broker-context request exceeded its deadline",
          ),
        );
        this.#violate(
          "NATIVE_BROKER_CONTEXT_REQUEST_TIMEOUT",
          "native broker-context request exceeded its deadline",
        );
      }, timeoutMs);
      this.pending = { resolve: resolvePromise, reject: rejectPromise, timer };
      try {
        this.child.stdin.write(bytes, (error) => {
          if (error !== null && error !== undefined) {
            this.#violate(
              "NATIVE_BROKER_CONTEXT_STDIN",
              "native broker-context request could not be written",
            );
          }
        });
      } catch {
        this.#violate(
          "NATIVE_BROKER_CONTEXT_STDIN",
          "native broker-context request could not be written",
        );
      }
    });
  }

  async waitForExit(timeoutMs) {
    const exit = await withTimeout(
      this.exit,
      timeoutMs,
      () => this.child.kill(),
      "NATIVE_BROKER_CONTEXT_EXIT_TIMEOUT",
      "native broker-context helper did not exit",
    );
    if (this.protocolError !== null) throw this.protocolError;
    if (this.stdoutBuffer.length !== 0 || this.stderrBytes !== 0) {
      fail(
        "NATIVE_BROKER_CONTEXT_EXIT",
        "native broker-context helper left invalid output at exit",
      );
    }
    return exit;
  }

  async terminate() {
    if (!this.closed) this.child.kill();
    return this.exit.catch(() => ({ code: null, signal: null }));
  }
}

export async function observeNativeBrokerStorage({
  build,
  brokerEnrollment,
  requestTimeoutMs = 30_000,
  totalTimeoutMs = 120_000,
  signal,
} = {}) {
  if (process.platform !== "win32") {
    fail("NATIVE_PLATFORM", "native broker-storage observation requires Windows");
  }
  if (process.arch !== "x64") {
    fail("NATIVE_ARCHITECTURE", "native broker-storage observation requires x64 Node");
  }
  requireInteger(requestTimeoutMs, "native broker-storage requestTimeoutMs", 1, 300_000);
  requireInteger(
    totalTimeoutMs,
    "native broker-storage totalTimeoutMs",
    requestTimeoutMs,
    3_600_000,
  );
  const enrollment = validateProbeBrokerEnrollment(brokerEnrollment);
  validateCanonicalWindowsLocalDirectory(
    enrollment.mailboxRoot,
    "broker mailbox root",
    "NATIVE_BROKER_CONTEXT_MAILBOX_PATH",
  );
  validateCanonicalWindowsLocalDirectory(
    enrollment.journalRoot,
    "broker journal root",
    "NATIVE_BROKER_CONTEXT_JOURNAL_PATH",
  );
  if (build === null || typeof build !== "object") {
    fail("NATIVE_BROKER_CONTEXT_BUILD", "native broker-storage build is unavailable");
  }
  await verifyBuildUnchanged(build);
  const mailbox = await validateRunRoot(enrollment.mailboxRoot);
  const journal = await validateRunRoot(enrollment.journalRoot);
  for (const [observed, expected, label] of [
    [mailbox.canonical, enrollment.mailboxRoot, "mailbox"],
    [journal.canonical, enrollment.journalRoot, "journal"],
  ]) {
    if (windowsPathCaseKey(observed) !== windowsPathCaseKey(expected)) {
      fail(
        "NATIVE_BROKER_CONTEXT_STORAGE_PATH",
        `prepared broker ${label} root differs from its canonical path`,
      );
    }
  }
  const launchHold = await startAssemblyLaunchHold(build, {
    runRoot: mailbox.canonical,
    timeoutMs: Math.min(requestTimeoutMs, 30_000),
    signal,
    createProtectedTemp: false,
  });
  let transport;
  try {
    await verifyBuildUnchanged(build);
    await Promise.all([assertRunRootUnchanged(mailbox), assertRunRootUnchanged(journal)]);
    transport = new NativeBrokerContextTransport({
      build,
      mailboxRoot: mailbox.canonical,
      observationOnly: true,
      signal,
      totalTimeoutMs,
    });
    const protocol = createNativeBrokerStorageObservationProtocol({
      brokerEnrollment: enrollment,
      nativeHelperSha256: build.assemblySha256,
      exchange: (frame, timeoutMs) => transport.exchange(frame, timeoutMs),
      waitForExit: (timeoutMs) => transport.waitForExit(timeoutMs),
      terminate: () => transport.terminate(),
      requestTimeoutMs,
    });
    const observation = await protocol.observe();
    await launchHold.release();
    await verifyBuildUnchanged(build);
    await Promise.all([assertRunRootUnchanged(mailbox), assertRunRootUnchanged(journal)]);
    return Object.freeze({
      brokerEnrollment: enrollment,
      build: retainedBuildIdentity(build),
      observation,
    });
  } catch (error) {
    await preserveNativeCleanupFailure(
      error,
      [
        ...(transport === undefined ? [] : [Promise.resolve().then(() => transport.terminate())]),
        Promise.resolve().then(() => launchHold.abort()),
      ],
      "native broker-storage process cleanup failed",
    );
  }
}

export async function openNativeBrokerContextChannel({
  build,
  preparedMailboxBinding,
  requestTimeoutMs = 30_000,
  signal,
} = {}) {
  if (process.platform !== "win32") {
    fail("NATIVE_PLATFORM", "native broker-context execution requires Windows");
  }
  if (process.arch !== "x64") {
    fail("NATIVE_ARCHITECTURE", "native broker-context execution requires x64 Node");
  }
  requireInteger(requestTimeoutMs, "native broker-context requestTimeoutMs", 1, 300_000);
  const prepared = validateProbePreparedBrokerEnrollment(preparedMailboxBinding);
  validateCanonicalWindowsLocalDirectory(
    prepared.mailboxRoot,
    "prepared broker mailbox root",
    "NATIVE_BROKER_CONTEXT_MAILBOX_PATH",
  );
  validateCanonicalWindowsLocalDirectory(
    prepared.journalRoot,
    "prepared broker journal root",
    "NATIVE_BROKER_CONTEXT_JOURNAL_PATH",
  );
  if (build === null || typeof build !== "object") {
    fail("NATIVE_BROKER_CONTEXT_BUILD", "native broker-context build is unavailable");
  }
  await verifyBuildUnchanged(build);
  if (build.assemblySha256 !== prepared.nativeHelperSha256) {
    fail(
      "NATIVE_BROKER_CONTEXT_HELPER_MISMATCH",
      "native broker-context build differs from the prepared mailbox binding",
    );
  }
  const mailbox = await validateRunRoot(prepared.mailboxRoot);
  const journal = await validateRunRoot(prepared.journalRoot);
  if (windowsPathCaseKey(mailbox.canonical) !== windowsPathCaseKey(prepared.mailboxRoot)) {
    fail(
      "NATIVE_BROKER_CONTEXT_MAILBOX_PATH",
      "prepared broker mailbox root differs from its canonical path",
    );
  }
  if (windowsPathCaseKey(journal.canonical) !== windowsPathCaseKey(prepared.journalRoot)) {
    fail(
      "NATIVE_BROKER_CONTEXT_JOURNAL_PATH",
      "prepared broker journal root differs from its canonical path",
    );
  }
  const launchHold = await startAssemblyLaunchHold(build, {
    runRoot: mailbox.canonical,
    timeoutMs: Math.min(requestTimeoutMs, 30_000),
    signal,
    createProtectedTemp: false,
  });
  let transport;
  try {
    await verifyBuildUnchanged(build);
    await Promise.all([assertRunRootUnchanged(mailbox), assertRunRootUnchanged(journal)]);
    transport = new NativeBrokerContextTransport({
      build,
      mailboxRoot: mailbox.canonical,
      signal,
    });
    const protocol = createNativeBrokerContextProtocol({
      preparedMailboxBinding: prepared,
      nativeHelperSha256: build.assemblySha256,
      exchange: (frame, timeoutMs) => transport.exchange(frame, timeoutMs),
      waitForExit: (timeoutMs) => transport.waitForExit(timeoutMs),
      terminate: () => transport.terminate(),
      isOpen: () => transport.isOpen(),
      requestTimeoutMs,
    });
    const acquired = await protocol.acquire();
    await launchHold.release();
    await verifyBuildUnchanged(build);
    await Promise.all([assertRunRootUnchanged(mailbox), assertRunRootUnchanged(journal)]);
    return Object.freeze({
      preparedMailboxBinding: prepared,
      build: retainedBuildIdentity(build),
      acquired,
      revalidate: () => protocol.revalidate(),
      release: async () => {
        const released = await protocol.release();
        await verifyBuildUnchanged(build);
        await Promise.all([assertRunRootUnchanged(mailbox), assertRunRootUnchanged(journal)]);
        return released;
      },
      wait: () => protocol.wait(),
      isLive: () => protocol.isLive(),
    });
  } catch (error) {
    await preserveNativeCleanupFailure(
      error,
      [
        ...(transport === undefined ? [] : [Promise.resolve().then(() => transport.terminate())]),
        Promise.resolve().then(() => launchHold.abort()),
      ],
      "native broker-context process cleanup failed",
    );
  }
}

class NativeTransport {
  constructor({ build, runRoot, preflightBinding, nativeSessionId, signal, totalTimeoutMs }) {
    this.build = build;
    this.runRoot = runRoot;
    this.preflightBinding = preflightBinding;
    this.nativeSessionId = nativeSessionId;
    this.pending = new Map();
    this.operationIds = new Set();
    this.events = [];
    this.eventWaiters = [];
    this.sequences = new Map();
    this.sessionOperations = new Map();
    this.unboundSessionOperations = new Map();
    this.resourceCommands = new Map();
    this.records = [];
    this.recordSequence = 0;
    this.termination = null;
    this.startupHandshake = null;
    this.startupHandshakeSha256 = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.closed = false;
    this.protocolError = null;
    this.rootIdentity = null;
    this.child = spawn(build.assemblyPath, [], {
      cwd: runRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildNativeChildEnvironment(process.env, {
        ENDURAGENT_NATIVE_RUN_ROOT: runRoot,
        ENDURAGENT_CAMPAIGN_RUN_ID: preflightBinding.campaignRunId,
        ENDURAGENT_CAMPAIGN_CANDIDATE_SHA256: preflightBinding.candidateSha256,
        ENDURAGENT_PREFLIGHT_SHA256: preflightBinding.preflightSha256,
        ENDURAGENT_EXECUTION_BUNDLE_MANIFEST_SHA256: preflightBinding.executionBundleManifestSha256,
        ENDURAGENT_NATIVE_CANDIDATE_DIGEST: preflightBinding.nativeCandidateDigest,
        ENDURAGENT_NATIVE_MANIFEST_SHA256: preflightBinding.nativeManifestSha256,
        ENDURAGENT_PREFLIGHT_NATIVE_HELPER_SHA256: preflightBinding.nativeHelperSha256,
        ENDURAGENT_EVIDENCE_ROOT_OBJECT_IDENTITY_SHA256:
          preflightBinding.evidenceRootObjectIdentitySha256,
        ENDURAGENT_NATIVE_SESSION_ID: nativeSessionId,
      }),
    });
    this.exit = new Promise((resolveExit, rejectExit) => {
      this.child.once("error", () =>
        rejectExit(new NativeClientError("NATIVE_SPAWN", "native helper could not be started")),
      );
      this.child.once("exit", (code, exitSignal) => {
        this.closed = true;
        const exit = { code, signal: exitSignal };
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(
            new NativeClientError("NATIVE_EARLY_EXIT", "native helper exited before responding"),
          );
        }
        this.pending.clear();
        for (const waiter of this.eventWaiters) waiter.resolve(null);
        this.eventWaiters.length = 0;
        resolveExit(exit);
      });
    });
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > maxStderrBytes)
        this.#violate("NATIVE_STDERR_LIMIT", "native helper exceeded its stderr limit");
    });
    this.signal = signal;
    this.abort = () => this.#violate("NATIVE_ABORTED", "native helper session was aborted");
    if (signal?.aborted) this.abort();
    else signal?.addEventListener("abort", this.abort, { once: true });
    this.totalTimer = setTimeout(
      () =>
        this.#violate(
          "NATIVE_SESSION_TIMEOUT",
          "native helper session exceeded its total deadline",
        ),
      totalTimeoutMs,
    );
  }

  #onStdout(chunk) {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > maxProcessOutputBytes) {
      this.#violate("NATIVE_STDOUT_LIMIT", "native helper exceeded its total stdout limit");
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length === 0 || line.length > maxOutputFrameBytes) {
        this.#violate("NATIVE_RESPONSE_FRAME", "native helper emitted an invalid response frame");
        return;
      }
      let value;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        this.#violate("NATIVE_RESPONSE_JSON", "native helper emitted invalid JSON");
        return;
      }
      try {
        this.#onMessage(value);
      } catch (error) {
        this.#violate(
          error instanceof NativeClientError ? error.code : "NATIVE_RESPONSE_SCHEMA",
          error instanceof NativeClientError ? error.message : "native helper response is invalid",
        );
        return;
      }
    }
    if (this.stdoutBuffer.length > maxOutputFrameBytes) {
      this.#violate("NATIVE_RESPONSE_FRAME", "native helper response frame exceeded its limit");
    }
  }

  #validateContext(context, pendingOperationId, requestFrameSha256 = null) {
    assertExactKeys(
      context,
      [
        "campaignRunId",
        "candidateSha256",
        "preflightSha256",
        "executionBundleManifestSha256",
        "nativeCandidateDigest",
        "nativeManifestSha256",
        "nativeHelperSha256",
        "evidenceRootObjectIdentitySha256",
        "nativeSessionId",
        "operationId",
        ...(requestFrameSha256 === null ? [] : ["requestFrameSha256"]),
        "runRootIdentity",
      ],
      "native response context",
    );
    if (
      context.campaignRunId !== this.preflightBinding.campaignRunId ||
      context.candidateSha256 !== this.preflightBinding.candidateSha256 ||
      context.preflightSha256 !== this.preflightBinding.preflightSha256 ||
      context.executionBundleManifestSha256 !==
        this.preflightBinding.executionBundleManifestSha256 ||
      context.nativeCandidateDigest !== this.preflightBinding.nativeCandidateDigest ||
      context.nativeManifestSha256 !== this.preflightBinding.nativeManifestSha256 ||
      context.nativeHelperSha256 !== this.preflightBinding.nativeHelperSha256 ||
      context.evidenceRootObjectIdentitySha256 !==
        this.preflightBinding.evidenceRootObjectIdentitySha256 ||
      context.nativeSessionId !== this.nativeSessionId ||
      context.operationId !== pendingOperationId ||
      (requestFrameSha256 !== null && context.requestFrameSha256 !== requestFrameSha256)
    ) {
      fail("NATIVE_CONTEXT_MISMATCH", "native response context did not match its request");
    }
    requireString(context.runRootIdentity, "runRootIdentity", { max: 128 });
    if (
      sha256(Buffer.from(context.runRootIdentity, "utf8")) !==
      this.preflightBinding.evidenceRootObjectIdentitySha256
    ) {
      fail("NATIVE_ROOT_IDENTITY_MISMATCH", "native run-root identity differs from preflight");
    }
    if (this.rootIdentity === null) this.rootIdentity = context.runRootIdentity;
    else if (this.rootIdentity !== context.runRootIdentity)
      fail("NATIVE_ROOT_IDENTITY_CHANGED", "native run-root identity changed");
  }

  #onMessage(value) {
    if (!exactObject(value) || value.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      fail("NATIVE_RESPONSE_VERSION", "native helper response version is invalid");
    }
    if (value.kind === "response") {
      requireBoolean(value.ok, "native response ok");
      const keys =
        value.ok === true
          ? ["protocolVersion", "kind", "requestId", "command", "context", "ok", "result"]
          : ["protocolVersion", "kind", "requestId", "command", "context", "ok", "error"];
      assertExactKeys(value, keys, "native response");
      const pending = this.pending.get(value.requestId);
      if (!pending)
        fail("NATIVE_RESPONSE_UNEXPECTED", "native helper response has no pending request");
      if (value.command !== pending.command)
        fail("NATIVE_COMMAND_MISMATCH", "native helper response command did not match");
      this.#validateContext(value.context, pending.operationId, pending.requestFrameSha256);
      if (value.ok) {
        const resourceCommand =
          pending.command === "session-control"
            ? this.resourceCommands.get(pending.request.sessionId)
            : undefined;
        const result = validateNativeResult(pending.command, value.result, resourceCommand);
        if (["pipe-owner", "pipe-foreign-precreate", "job-owner"].includes(pending.command)) {
          const resourceSessionId = requireString(
            value.result.sessionId,
            "native resource session id",
            { max: 64 },
          );
          const earlyOperation = this.unboundSessionOperations.get(resourceSessionId);
          if (earlyOperation !== undefined && earlyOperation !== pending.operationId) {
            fail("NATIVE_EVENT_BINDING", "native event operation did not match owner creation");
          }
          this.unboundSessionOperations.delete(resourceSessionId);
          this.sessionOperations.set(resourceSessionId, pending.operationId);
          this.resourceCommands.set(resourceSessionId, pending.command);
        }
        const responseFrameSha256 = canonicalJsonSha256(value);
        if (pending.command === "native-binding-check") {
          if (
            result.processId !== this.child.pid ||
            result.nativeHelperSha256 !== this.preflightBinding.nativeHelperSha256 ||
            result.runRootIdentity !== this.rootIdentity ||
            result.evidenceRootObjectIdentitySha256 !==
              this.preflightBinding.evidenceRootObjectIdentitySha256
          ) {
            fail("NATIVE_BINDING_HANDSHAKE", "native startup handshake identity is mismatched");
          }
          this.startupHandshake = freezeJson(value);
          this.startupHandshakeSha256 = responseFrameSha256;
        }
        if (pending.record) {
          this.records.push(
            freezeJson({
              kind: "command",
              sequence: ++this.recordSequence,
              requestId: value.requestId,
              command: pending.command,
              operationId: pending.operationId,
              requestFrameSha256: pending.requestFrameSha256,
              nativeRequestFrameSha256: value.context.requestFrameSha256,
              requestFrameVerification:
                pending.command === "pipe-owner" || pending.command === "pipe-client"
                  ? "native-receipt"
                  : "recomputed",
              responseFrameSha256,
              ok: true,
              request: pending.request,
              result,
            }),
          );
        }
        this.pending.delete(value.requestId);
        clearTimeout(pending.timer);
        pending.resolve(pending.resolveCommandFailure ? freezeJson({ ok: true, result }) : result);
      } else {
        assertExactKeys(value.error, ["code", "message", "win32Code"], "native error");
        const error = new NativeClientError(
          requireString(value.error.code, "native error code", { max: 64 }),
          requireString(value.error.message, "native error message", { max: 256 }),
        );
        if (value.error.win32Code !== null)
          error.win32Code = requireInteger(value.error.win32Code, "win32Code", 0, 0xffffffff);
        const failure = freezeJson({
          code: error.code,
          message: error.message,
          win32Code: error.win32Code ?? null,
        });
        if (pending.record) {
          this.records.push(
            freezeJson({
              kind: "command",
              sequence: ++this.recordSequence,
              requestId: value.requestId,
              command: pending.command,
              operationId: pending.operationId,
              requestFrameSha256: pending.requestFrameSha256,
              nativeRequestFrameSha256: value.context.requestFrameSha256,
              requestFrameVerification:
                pending.command === "pipe-owner" || pending.command === "pipe-client"
                  ? "native-receipt"
                  : "recomputed",
              responseFrameSha256: canonicalJsonSha256(value),
              ok: false,
              request: pending.request,
              error: failure,
            }),
          );
        }
        this.pending.delete(value.requestId);
        clearTimeout(pending.timer);
        if (pending.resolveCommandFailure)
          pending.resolve(freezeJson({ ok: false, error: failure }));
        else pending.reject(error);
      }
      return;
    }
    if (value.kind === "event") {
      assertExactKeys(
        value,
        ["protocolVersion", "kind", "sessionId", "context", "sequence", "event", "data"],
        "native event",
      );
      requireString(value.sessionId, "event.sessionId", { max: 64 });
      requireString(value.event, "event.event", { max: 64 });
      requireInteger(value.sequence, "event.sequence", 1, Number.MAX_SAFE_INTEGER);
      if (!exactObject(value.data))
        fail("NATIVE_EVENT_SCHEMA", "native event data must be an object");
      let expectedOperation = this.sessionOperations.get(value.sessionId);
      if (expectedOperation === undefined) {
        const ownerPending = [...this.pending.values()].find(
          (pending) =>
            ["pipe-owner", "pipe-foreign-precreate", "job-owner"].includes(pending.command) &&
            pending.operationId === value.context.operationId,
        );
        if (!ownerPending)
          fail("NATIVE_EVENT_BINDING", "native event was not bound to an owner request");
        expectedOperation = ownerPending.operationId;
        const priorUnbound = this.unboundSessionOperations.get(value.sessionId);
        if (priorUnbound !== undefined && priorUnbound !== expectedOperation) {
          fail("NATIVE_EVENT_BINDING", "native event session changed operation binding");
        }
        this.unboundSessionOperations.set(value.sessionId, expectedOperation);
      }
      this.#validateContext(value.context, expectedOperation);
      const resourceCommand = this.resourceCommands.get(value.sessionId);
      if (resourceCommand === undefined) {
        const ownerPending = [...this.pending.values()].find(
          (pending) => pending.operationId === expectedOperation,
        );
        if (ownerPending !== undefined)
          this.resourceCommands.set(value.sessionId, ownerPending.command);
      }
      const boundResourceCommand = this.resourceCommands.get(value.sessionId);
      validateNativeEvent(boundResourceCommand, value.event, value.data);
      const prior = this.sequences.get(value.sessionId) ?? 0;
      if (value.sequence !== prior + 1)
        fail("NATIVE_EVENT_SEQUENCE", "native event sequence is not monotonic contiguous");
      this.sequences.set(value.sessionId, value.sequence);
      this.records.push(
        freezeJson({
          kind: "event",
          sequence: ++this.recordSequence,
          resourceSessionId: value.sessionId,
          resourceCommand: boundResourceCommand,
          operationId: expectedOperation,
          event: value.event,
          eventSequence: value.sequence,
          eventFrameSha256: canonicalJsonSha256(value),
          data: value.data,
        }),
      );
      const retainedEvent = freezeJson(value);
      const waiter = this.eventWaiters.shift();
      if (waiter) waiter.resolve(retainedEvent);
      else this.events.push(retainedEvent);
      return;
    }
    fail("NATIVE_RESPONSE_KIND", "native helper message kind is invalid");
  }

  #violate(code, message) {
    if (this.protocolError) return;
    this.protocolError = new NativeClientError(code, message);
    this.child.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.protocolError);
    }
    this.pending.clear();
  }

  send(command, request, operationId, timeoutMs, { record = true } = {}) {
    let prepared;
    try {
      prepared = prepareNativeTransmission(
        this.preflightBinding,
        this.nativeSessionId,
        command,
        request,
        operationId,
        timeoutMs,
        { record },
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return this.sendPrepared(prepared);
  }

  sendPrepared(prepared, { resolveCommandFailure = false } = {}) {
    if (this.closed || this.protocolError)
      return Promise.reject(
        this.protocolError ?? new NativeClientError("NATIVE_CLOSED", "native helper is closed"),
      );
    let bytes;
    try {
      assertExactKeys(
        prepared,
        [
          "command",
          "operationId",
          "requestId",
          "timeoutMs",
          "requestFrame",
          "requestFrameSha256",
          "frameBytes",
          "record",
        ],
        "prepared native transmission",
      );
      requireProtocolIdentifier(prepared.operationId, "native operationId");
      requireProtocolIdentifier(prepared.requestId, "native requestId");
      requireInteger(prepared.timeoutMs, "timeoutMs", 1, 300_000);
      requireHex64(prepared.requestFrameSha256, "prepared requestFrameSha256");
      requireBoolean(prepared.record, "prepared record");
      if (!(prepared.frameBytes instanceof Uint8Array)) {
        fail("NATIVE_PREPARED_FRAME", "prepared native frame bytes are invalid");
      }
      bytes = Buffer.from(prepared.frameBytes);
      const expectedBytes = Buffer.from(`${JSON.stringify(prepared.requestFrame)}\n`, "utf8");
      if (
        bytes.length === 0 ||
        bytes.length > maxInputFrameBytes ||
        !bytes.equals(expectedBytes) ||
        prepared.requestFrameSha256 !== sha256(bytes.subarray(0, bytes.length - 1)) ||
        prepared.requestFrame?.protocolVersion !== NATIVE_PROTOCOL_VERSION ||
        prepared.requestFrame?.requestId !== prepared.requestId ||
        prepared.requestFrame?.command !== prepared.command ||
        prepared.requestFrame?.context?.operationId !== prepared.operationId
      ) {
        fail("NATIVE_PREPARED_FRAME", "prepared native frame changed before execution");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.operationIds.has(prepared.operationId)) {
      return Promise.reject(
        new NativeClientError(
          "NATIVE_OPERATION_ID_REUSE",
          "native operationId was reused within one helper session",
        ),
      );
    }
    if (this.pending.has(prepared.requestId)) {
      return Promise.reject(
        new NativeClientError(
          "NATIVE_REQUEST_ID_REUSE",
          "native requestId was reused within one helper session",
        ),
      );
    }
    this.operationIds.add(prepared.operationId);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(prepared.requestId);
        rejectPromise(
          new NativeClientError("NATIVE_REQUEST_TIMEOUT", "native request exceeded its deadline"),
        );
        this.#violate("NATIVE_REQUEST_TIMEOUT", "native request exceeded its deadline");
      }, prepared.timeoutMs);
      this.pending.set(prepared.requestId, {
        command: prepared.command,
        operationId: prepared.operationId,
        request: retainTranscriptRequest(prepared.command, prepared.requestFrame.request),
        requestFrameSha256: prepared.requestFrameSha256,
        record: prepared.record,
        resolveCommandFailure,
        timer,
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      try {
        this.child.stdin.write(bytes, (error) => {
          if (error) this.#violate("NATIVE_STDIN", "native request could not be written");
        });
      } catch {
        this.#violate("NATIVE_STDIN", "native request could not be written");
      }
    });
  }

  async initialize(timeoutMs) {
    const operationId = randomId("op");
    await this.send("native-binding-check", {}, operationId, timeoutMs, { record: false });
    if (
      this.startupHandshake === null ||
      this.startupHandshakeSha256 === null ||
      this.rootIdentity === null
    ) {
      fail("NATIVE_BINDING_HANDSHAKE", "native startup handshake is incomplete");
    }
  }

  snapshotTranscript() {
    if (
      this.rootIdentity === null ||
      this.startupHandshake === null ||
      this.startupHandshakeSha256 === null
    ) {
      fail("NATIVE_TRANSCRIPT_BINDING", "native transcript has no completed startup binding");
    }
    const payload = canonicalJson({
      schemaVersion: 1,
      kind: "windows-host-native-command-transcript",
      binding: {
        campaignRunId: this.preflightBinding.campaignRunId,
        candidateSha256: this.preflightBinding.candidateSha256,
        preflightSha256: this.preflightBinding.preflightSha256,
        executionBundleManifestSha256: this.preflightBinding.executionBundleManifestSha256,
        nativeHelperArtifactPath: this.preflightBinding.nativeHelperArtifactPath,
        nativeHelperSha256: this.preflightBinding.nativeHelperSha256,
        evidenceRootObjectIdentitySha256: this.preflightBinding.evidenceRootObjectIdentitySha256,
        nativeCandidateDigest: this.preflightBinding.nativeCandidateDigest,
        nativeManifestSha256: this.preflightBinding.nativeManifestSha256,
        nativeSessionId: this.nativeSessionId,
        runRootIdentity: this.rootIdentity,
        startupHandshake: this.startupHandshake,
        startupHandshakeSha256: this.startupHandshakeSha256,
      },
      records: this.records,
      termination: this.termination,
    });
    const transcriptSha256 = nativeTranscriptSha256(payload);
    return validateNativeCommandTranscript(canonicalJson({ ...payload, transcriptSha256 }));
  }

  nextEvent(timeoutMs) {
    if (this.events.length > 0) return Promise.resolve(this.events.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { resolve: resolvePromise };
      this.eventWaiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        rejectPromise(
          new NativeClientError("NATIVE_EVENT_TIMEOUT", "native event wait exceeded its deadline"),
        );
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      };
    });
  }

  async finish(timeoutMs) {
    if (!this.closed) this.child.stdin.end();
    const exit = await withTimeout(
      this.exit,
      timeoutMs,
      () => this.child.kill(),
      "NATIVE_EXIT_TIMEOUT",
      "native helper did not exit after stdin closed",
    );
    clearTimeout(this.totalTimer);
    this.signal?.removeEventListener("abort", this.abort);
    if (this.protocolError) throw this.protocolError;
    if (this.stdoutBuffer.length !== 0)
      fail("NATIVE_RESPONSE_TERMINATOR", "native helper left an unterminated response frame");
    if (exit.code !== 0 || exit.signal !== null || this.stderrBytes !== 0) {
      fail("NATIVE_EXIT", "native helper exited unsuccessfully");
    }
    this.termination = freezeJson({ mode: "clean-eof", code: exit.code, signal: exit.signal });
    return exit;
  }

  async terminateExpected({ expectedExit, killSignal = "SIGTERM", timeoutMs }) {
    assertExactKeys(expectedExit, ["code", "signal"], "expected native exit");
    const expectedCode = requireNullableInteger(
      expectedExit.code,
      "expected native exit code",
      0,
      0xffffffff,
    );
    const expectedSignal = requireNullableString(
      expectedExit.signal,
      "expected native exit signal",
      { max: 32 },
    );
    requireEnum(killSignal, ["SIGTERM", "SIGKILL"], "native kill signal");
    requireInteger(timeoutMs, "native termination timeout", 1, 300_000);
    if (this.pending.size !== 0) {
      fail("NATIVE_TERMINATION_PENDING", "native helper has pending requests");
    }
    if (!this.closed) this.child.kill(killSignal);
    const exit = await withTimeout(
      this.exit,
      timeoutMs,
      () => this.child.kill(),
      "NATIVE_EXIT_TIMEOUT",
      "native helper did not reach the expected termination",
    );
    clearTimeout(this.totalTimer);
    this.signal?.removeEventListener("abort", this.abort);
    if (this.protocolError) throw this.protocolError;
    if (this.stdoutBuffer.length !== 0) {
      fail("NATIVE_RESPONSE_TERMINATOR", "native helper left an unterminated response frame");
    }
    if (exit.code !== expectedCode || exit.signal !== expectedSignal || this.stderrBytes !== 0) {
      fail("NATIVE_EXPECTED_EXIT_MISMATCH", "native helper termination differed from expectation");
    }
    this.termination = freezeJson({
      mode: "expected-termination",
      code: exit.code,
      signal: exit.signal,
      expectedCode,
      expectedSignal,
      killSignal,
    });
    return exit;
  }
}

async function createTransport({
  runRoot,
  preflightBinding,
  candidateRoot,
  candidateDirectory,
  signal,
  totalTimeoutMs,
}) {
  if (process.platform !== "win32")
    fail("NATIVE_PLATFORM", "native helper execution requires Windows");
  if (process.arch !== "x64")
    fail("NATIVE_ARCHITECTURE", "native helper execution requires x64 Node");
  const owned = await validateRunRoot(runRoot);
  const binding = validatePreflightBinding(preflightBinding);
  if (candidateRoot === undefined || candidateDirectory === undefined) {
    fail(
      "NATIVE_CANDIDATE_BINDING",
      "native launch requires candidateRoot and exact candidateDirectory",
    );
  }
  const build = await loadNativeHelper({ candidateRoot, candidateDirectory });
  assertCandidateRunRootDisjoint(owned.canonical, build.candidateRoot);
  await assertRunRootUnchanged(owned);
  await verifyBuildUnchanged(build);
  if (build.nativeHelperArtifactPath !== binding.nativeHelperArtifactPath) {
    if (
      windowsPathCaseKey(build.nativeHelperArtifactPath) ===
      windowsPathCaseKey(binding.nativeHelperArtifactPath)
    ) {
      fail(
        "NATIVE_PATH_CASE_COLLISION",
        "preflight helper path differs only by Windows path casing",
      );
    }
    fail(
      "NATIVE_PREFLIGHT_HELPER_PATH_MISMATCH",
      "loaded native helper path differs from the preflight artifact locator",
    );
  }
  if (build.assemblySha256 !== binding.nativeHelperSha256) {
    fail(
      "NATIVE_PREFLIGHT_HELPER_MISMATCH",
      "loaded native helper differs from the preflight artifact identity",
    );
  }
  if (build.candidateDigest !== binding.nativeCandidateDigest) {
    fail(
      "NATIVE_PREFLIGHT_CANDIDATE_MISMATCH",
      "loaded native candidate differs from the preflight build identity",
    );
  }
  if (build.manifestSha256 !== binding.nativeManifestSha256) {
    fail(
      "NATIVE_PREFLIGHT_MANIFEST_MISMATCH",
      "loaded native manifest differs from the preflight build identity",
    );
  }
  const nativeSessionId = randomId("native");
  const launchHold = await startAssemblyLaunchHold(build, {
    runRoot: owned.canonical,
    timeoutMs: Math.min(totalTimeoutMs, 30_000),
    signal,
  });
  let transport;
  try {
    await assertRunRootUnchanged(owned);
    await verifyBuildUnchanged(build);
    transport = new NativeTransport({
      build,
      runRoot: owned.launchPath,
      preflightBinding: binding,
      nativeSessionId,
      signal,
      totalTimeoutMs,
    });
    await verifyBuildUnchanged(build);
    await assertRunRootUnchanged(owned);
    await transport.initialize(Math.min(totalTimeoutMs, 30_000));
    await assertRunRootUnchanged(owned);
    await launchHold.release();
    await verifyBuildUnchanged(build);
    await assertRunRootUnchanged(owned);
  } catch (error) {
    transport?.child?.kill();
    await Promise.all([
      transport?.exit?.catch(() => undefined),
      launchHold.abort().catch(() => undefined),
    ]);
    throw error;
  }
  return {
    build,
    transport,
    runRoot: owned.launchPath,
    preflightBinding: binding,
  };
}

export function createNativeChannelApi({
  build,
  transport,
  runRoot: canonicalRoot,
  preflightBinding,
  requestTimeoutMs = 30_000,
} = {}) {
  requireInteger(requestTimeoutMs, "requestTimeoutMs", 1, 300_000);
  requireString(canonicalRoot, "native channel runRoot");
  const binding = validatePreflightBinding(preflightBinding);
  requireProtocolIdentifier(transport?.nativeSessionId, "nativeSessionId");
  const requiredTransportMethods = [
    "send",
    "sendPrepared",
    "nextEvent",
    "snapshotTranscript",
    "finish",
    "terminateExpected",
  ];
  for (const method of requiredTransportMethods) {
    if (typeof transport?.[method] !== "function") {
      fail("NATIVE_CHANNEL_TRANSPORT", `native channel transport.${method} must be a function`);
    }
  }
  let finalized = false;
  let finalizing = false;
  let active = 0;
  const preparedTransmissions = new WeakMap();
  const consumedPreparations = new WeakSet();
  const assertOpen = () => {
    if (finalized || finalizing) fail("NATIVE_CHANNEL_CLOSED", "native channel is closed");
  };
  const finalize = async (work) => {
    assertOpen();
    if (active !== 0) fail("NATIVE_CHANNEL_BUSY", "native channel has active commands");
    finalizing = true;
    try {
      const exit = await work();
      finalized = true;
      return Object.freeze({
        exit: Object.freeze(exit),
        transcript: transport.snapshotTranscript(),
      });
    } finally {
      if (transport.closed) finalized = true;
      finalizing = false;
      await verifyBuildUnchanged(build);
    }
  };
  const prepare = async (
    command,
    request,
    { timeoutMs = requestTimeoutMs, operationId: suppliedOperationId } = {},
  ) => {
    assertOpen();
    requireInteger(timeoutMs, "timeoutMs", 1, 300_000);
    const operationId =
      suppliedOperationId === undefined
        ? randomId("op")
        : requireProtocolIdentifier(suppliedOperationId, "native operationId");
    const normalized = await normalizeRequest(canonicalRoot, command, request, operationId);
    assertOpen();
    const transmission = prepareNativeTransmission(
      binding,
      transport.nativeSessionId,
      command,
      normalized,
      operationId,
      timeoutMs,
    );
    const prepared = publicPreparedRequest(transmission);
    preparedTransmissions.set(prepared, transmission);
    return prepared;
  };
  const executePrepared = async (prepared) => {
    assertOpen();
    const transmission =
      prepared !== null && typeof prepared === "object"
        ? preparedTransmissions.get(prepared)
        : undefined;
    if (transmission === undefined) {
      fail("NATIVE_PREPARED_REQUEST", "prepared native request was not issued by this channel");
    }
    if (consumedPreparations.has(prepared)) {
      fail("NATIVE_PREPARED_REUSE", "prepared native request was already executed");
    }
    consumedPreparations.add(prepared);
    active += 1;
    try {
      const outcome = await transport.sendPrepared(transmission, {
        resolveCommandFailure: true,
      });
      if (!exactObject(outcome) || typeof outcome.ok !== "boolean") {
        fail("NATIVE_CHANNEL_TRANSPORT", "native transport returned an invalid outcome");
      }
      if (outcome.ok) {
        assertExactKeys(outcome, ["ok", "result"], "native prepared outcome");
        const result = validateNativeResult(transmission.command, outcome.result);
        return freezeJson({
          command: transmission.command,
          operationId: transmission.operationId,
          ok: true,
          result,
        });
      }
      assertExactKeys(outcome, ["ok", "error"], "native prepared outcome");
      assertExactKeys(outcome.error, ["code", "message", "win32Code"], "native command failure");
      const failure = freezeJson({
        code: requireString(outcome.error.code, "native command failure code", { max: 64 }),
        message: requireString(outcome.error.message, "native command failure message", {
          max: 256,
        }),
        win32Code: requireNullableInteger(
          outcome.error.win32Code,
          "native command failure win32Code",
          0,
          0xffffffff,
        ),
      });
      return freezeJson({
        command: transmission.command,
        operationId: transmission.operationId,
        ok: false,
        error: failure,
      });
    } finally {
      active -= 1;
    }
  };
  const execute = async (command, request, options) => {
    const outcome = await executePrepared(await prepare(command, request, options));
    if (!outcome.ok) throw commandFailureError(outcome.error);
    return Object.freeze({
      command: outcome.command,
      operationId: outcome.operationId,
      result: outcome.result,
    });
  };
  return Object.freeze({
    nativeSessionId: transport.nativeSessionId,
    build: retainedBuildIdentity(build),
    preflightBinding: binding,
    prepare,
    executePrepared,
    execute,
    control: async (
      sessionId,
      action,
      { timeoutMs = requestTimeoutMs, operationId: suppliedOperationId } = {},
    ) => {
      assertOpen();
      requireString(sessionId, "native resource session id", { min: 2, max: 64 });
      requireEnum(action, ["query", "graceful", "terminate", "close"], "session action");
      requireInteger(timeoutMs, "timeoutMs", 1, 300_000);
      const operationId =
        suppliedOperationId === undefined
          ? randomId("op")
          : requireProtocolIdentifier(suppliedOperationId, "native operationId");
      active += 1;
      try {
        const result = await transport.send(
          "session-control",
          { sessionId, action },
          operationId,
          timeoutMs,
        );
        return Object.freeze({ operationId, result });
      } finally {
        active -= 1;
      }
    },
    nextEvent: ({ timeoutMs = requestTimeoutMs } = {}) => {
      assertOpen();
      requireInteger(timeoutMs, "timeoutMs", 1, 300_000);
      return transport.nextEvent(timeoutMs);
    },
    transcript: () => transport.snapshotTranscript(),
    close: ({ timeoutMs = Math.min(requestTimeoutMs, 10_000) } = {}) => {
      requireInteger(timeoutMs, "timeoutMs", 1, 300_000);
      return finalize(() => transport.finish(timeoutMs));
    },
    terminateExpected: ({
      expectedExit,
      killSignal = "SIGTERM",
      timeoutMs = Math.min(requestTimeoutMs, 10_000),
    } = {}) => finalize(() => transport.terminateExpected({ expectedExit, killSignal, timeoutMs })),
    wait: () => transport.exit,
  });
}

export async function openNativeChannel({
  runRoot,
  preflightBinding,
  candidateRoot,
  candidateDirectory,
  requestTimeoutMs = 30_000,
  totalTimeoutMs = 300_000,
  signal,
} = {}) {
  requireInteger(requestTimeoutMs, "requestTimeoutMs", 1, 300_000);
  requireInteger(totalTimeoutMs, "totalTimeoutMs", requestTimeoutMs, 3_600_000);
  const channel = await createTransport({
    runRoot,
    preflightBinding,
    candidateRoot,
    candidateDirectory,
    signal,
    totalTimeoutMs,
  });
  return createNativeChannelApi({ ...channel, requestTimeoutMs });
}

export async function invokeNative({
  runRoot,
  preflightBinding,
  candidateRoot,
  candidateDirectory,
  command,
  request,
  operationId: suppliedOperationId,
  timeoutMs = 30_000,
  signal,
} = {}) {
  requireInteger(timeoutMs, "timeoutMs", 1, 300_000);
  const {
    build,
    transport,
    runRoot: canonicalRoot,
  } = await createTransport({
    runRoot,
    preflightBinding,
    candidateRoot,
    candidateDirectory,
    signal,
    totalTimeoutMs: timeoutMs + 10_000,
  });
  const operationId =
    suppliedOperationId === undefined
      ? randomId("op")
      : requireProtocolIdentifier(suppliedOperationId, "native operationId");
  try {
    const normalized = await normalizeRequest(canonicalRoot, command, request, operationId);
    const result = await transport.send(command, normalized, operationId, timeoutMs);
    await transport.finish(Math.min(timeoutMs, 10_000));
    return Object.freeze({
      command,
      operationId,
      result,
      build: retainedBuildIdentity(build),
      transcript: transport.snapshotTranscript(),
    });
  } catch (error) {
    transport.child?.kill();
    await transport.exit.catch(() => undefined);
    throw error;
  } finally {
    await verifyBuildUnchanged(build);
  }
}

export async function startNativeSession({
  runRoot,
  preflightBinding,
  candidateRoot,
  candidateDirectory,
  command,
  request,
  operationId: suppliedOperationId,
  timeoutMs = 30_000,
  totalTimeoutMs = 300_000,
  signal,
} = {}) {
  if (!["pipe-owner", "pipe-foreign-precreate", "job-owner"].includes(command)) {
    fail("NATIVE_SESSION_COMMAND", "command is not a long-running native session command");
  }
  requireInteger(timeoutMs, "timeoutMs", 1, 300_000);
  requireInteger(totalTimeoutMs, "totalTimeoutMs", timeoutMs, 3_600_000);
  const {
    build,
    transport,
    runRoot: canonicalRoot,
  } = await createTransport({
    runRoot,
    preflightBinding,
    candidateRoot,
    candidateDirectory,
    signal,
    totalTimeoutMs,
  });
  const operationId =
    suppliedOperationId === undefined
      ? randomId("op")
      : requireProtocolIdentifier(suppliedOperationId, "native operationId");
  let initial;
  try {
    const normalized = await normalizeRequest(canonicalRoot, command, request, operationId);
    initial = await transport.send(command, normalized, operationId, timeoutMs);
  } catch (error) {
    transport.child?.kill();
    await transport.exit.catch(() => undefined);
    await verifyBuildUnchanged(build);
    throw error;
  }
  const sessionId = requireString(initial.sessionId, "native resource session id", { max: 64 });
  let closed = false;
  return Object.freeze({
    command,
    operationId,
    sessionId,
    initial,
    build: retainedBuildIdentity(build),
    transcript: () => transport.snapshotTranscript(),
    nextEvent: ({ timeoutMs: eventTimeoutMs = 30_000 } = {}) => {
      requireInteger(eventTimeoutMs, "timeoutMs", 1, 300_000);
      return transport.nextEvent(eventTimeoutMs);
    },
    control: async (action, { timeoutMs: controlTimeoutMs = 30_000 } = {}) => {
      if (closed) fail("NATIVE_SESSION_CLOSED", "native session is closed");
      if (!["query", "graceful", "terminate", "close"].includes(action)) {
        fail("NATIVE_SESSION_ACTION", "native session action is invalid");
      }
      requireInteger(controlTimeoutMs, "timeoutMs", 1, 300_000);
      const controlOperation = randomId("op");
      const result = await transport.send(
        "session-control",
        { sessionId, action },
        controlOperation,
        controlTimeoutMs,
      );
      if (action === "close") closed = true;
      return result;
    },
    close: async ({ timeoutMs: closeTimeoutMs = 30_000 } = {}) => {
      requireInteger(closeTimeoutMs, "timeoutMs", 1, 300_000);
      if (!closed) {
        const controlOperation = randomId("op");
        await transport.send(
          "session-control",
          { sessionId, action: "close" },
          controlOperation,
          closeTimeoutMs,
        );
        closed = true;
      }
      try {
        await transport.finish(Math.min(closeTimeoutMs, 10_000));
        return transport.snapshotTranscript();
      } finally {
        await verifyBuildUnchanged(build);
      }
    },
    terminateExpected: async ({
      expectedExit,
      killSignal = "SIGTERM",
      timeoutMs: terminationTimeoutMs = 10_000,
    } = {}) => {
      if (closed) fail("NATIVE_SESSION_CLOSED", "native session is closed");
      assertExactKeys(expectedExit, ["code", "signal"], "expected native exit");
      requireNullableInteger(expectedExit.code, "expected native exit code", 0, 0xffffffff);
      requireNullableString(expectedExit.signal, "expected native exit signal", { max: 32 });
      requireEnum(killSignal, ["SIGTERM", "SIGKILL"], "native kill signal");
      requireInteger(terminationTimeoutMs, "timeoutMs", 1, 300_000);
      closed = true;
      try {
        await transport.terminateExpected({
          expectedExit,
          killSignal,
          timeoutMs: terminationTimeoutMs,
        });
        return transport.snapshotTranscript();
      } finally {
        await verifyBuildUnchanged(build);
      }
    },
    wait: () => transport.exit,
  });
}
