import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const RESULT_SCHEMA_VERSION = 1;
export const EXPERIMENT_PHASES = Object.freeze(["probe", "implementation", "package", "release"]);
export const EXPERIMENT_STATUSES = Object.freeze(["PASS", "FAIL", "INCONCLUSIVE"]);
export const FOUNDATION_OUTCOMES = Object.freeze([
  "foundation-succeeded",
  "foundation-failed",
  "foundation-inconclusive",
]);
export const FOUNDATION_DISPOSAL_STATES = Object.freeze(["external-runner-disposal-required"]);
export const EXPERIMENT_IDS = Object.freeze(
  Array.from({ length: 23 }, (_, index) => `F-${String(index + 1).padStart(2, "0")}`),
);

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const repositoryRoot = resolve(scriptDirectory, "../../..");
const reservedWindowsNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const strictIsoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const lowercaseSha256 = /^[a-f0-9]{64}$/u;
const repositoryCommitPattern = /^[a-f0-9]{40}$/u;
const runIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const maxArtifactBytes = 4 * 1024 * 1024;
const maxScanBytes = 16 * 1024 * 1024;
const maxScanFiles = 256;
const maxScanDepth = 8;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const knownFoundationPolicyExceptions = Object.freeze([
  "DEFENDER_REALTIME_DISABLED_ON_GITHUB_HOSTED_RUNNER",
  "DEVELOPER_MODE_ENABLED_ON_GITHUB_HOSTED_RUNNER",
  "ELEVATED_GITHUB_HOSTED_RUNNER",
  "UAC_DISABLED_ON_ELEVATED_GITHUB_HOSTED_SERVER",
  "WINDOWS_SERVER_GITHUB_HOSTED_RUNNER",
]);

export class FalsifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FalsifierError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FalsifierError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = []) {
  if (!exactObject(value)) fail("SCHEMA_OBJECT", "expected an object");
  const permitted = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) fail("SCHEMA_UNKNOWN_KEY", `unexpected key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("SCHEMA_MISSING_KEY", `missing key: ${key}`);
  }
}

function assertString(value, label, { nonempty = true } = {}) {
  if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
    fail("SCHEMA_STRING", `${label} must be ${nonempty ? "a non-empty " : "a "}string`);
  }
}

function assertBooleanOrNull(value, label) {
  if (value !== null && typeof value !== "boolean") {
    fail("SCHEMA_BOOLEAN", `${label} must be boolean or null`);
  }
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("SCHEMA_INTEGER", `${label} must be an integer >= ${minimum}`);
  }
}

function compareBytes(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("CANONICAL_NUMBER", "canonical JSON forbids non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!exactObject(value))
    fail("CANONICAL_VALUE", "canonical JSON forbids undefined or exotic values");
  const result = {};
  for (const key of Object.keys(value).sort(compareBytes)) {
    const entry = value[key];
    if (entry === undefined)
      fail("CANONICAL_UNDEFINED", `canonical JSON forbids undefined: ${key}`);
    result[key] = canonicalize(entry);
  }
  return result;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function validateObservation(value) {
  assertExactKeys(value, ["step", "expected", "actual", "evidenceRef"]);
  assertString(value.step, "observation.step");
  assertString(value.expected, "observation.expected");
  assertString(value.actual, "observation.actual");
  if (value.evidenceRef !== null) assertString(value.evidenceRef, "observation.evidenceRef");
}

function validateArtifactRelativePath(value) {
  assertString(value, "artifact.path");
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("SCHEMA_ARTIFACT_PATH", "artifact paths must be normalized relative paths");
  }
  return value;
}

function validateArtifactHash(value) {
  assertExactKeys(value, ["path", "sha256"]);
  validateArtifactRelativePath(value.path);
  if (!lowercaseSha256.test(value.sha256)) {
    fail("SCHEMA_ARTIFACT_HASH", "artifact sha256 must be lowercase 64-hex");
  }
}

function validateRunIdentity(value) {
  assertExactKeys(value, [
    "runId",
    "repositoryCommit",
    "repositoryDirty",
    "scriptSha256",
    "startedAt",
    "endedAt",
    "monotonicDurationMs",
  ]);
  validateRunId(value.runId);
  if (!repositoryCommitPattern.test(value.repositoryCommit)) {
    fail("SCHEMA_COMMIT", "repositoryCommit must be lowercase 40-hex");
  }
  if (typeof value.repositoryDirty !== "boolean") {
    fail("SCHEMA_DIRTY", "repositoryDirty must be boolean");
  }
  if (!lowercaseSha256.test(value.scriptSha256)) {
    fail("SCHEMA_SCRIPT_HASH", "scriptSha256 must be lowercase 64-hex");
  }
  if (!strictIsoUtc.test(value.startedAt) || !strictIsoUtc.test(value.endedAt)) {
    fail("SCHEMA_TIMESTAMP", "run timestamps must be strict UTC ISO milliseconds");
  }
  if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
    fail("SCHEMA_TIMESTAMP_ORDER", "endedAt precedes startedAt");
  }
  if (!Number.isFinite(value.monotonicDurationMs) || value.monotonicDurationMs < 0) {
    fail("SCHEMA_DURATION", "monotonicDurationMs must be finite and non-negative");
  }
}

function validateCommonToolchainIdentity(value) {
  assertExactKeys(value, [
    "nodeVersion",
    "electronVersion",
    "electronBuilderVersion",
    "updaterVersion",
    "nsis",
  ]);
  for (const key of [
    "nodeVersion",
    "electronVersion",
    "electronBuilderVersion",
    "updaterVersion",
  ]) {
    assertString(value[key], `environment.toolchain.${key}`);
  }
  if (!exactObject(value.nsis)) fail("SCHEMA_NSIS", "toolchain.nsis must be an object");
}

function validateAuthoritativeToolchainIdentity(value) {
  validateCommonToolchainIdentity(value);
  assertExactKeys(value.nsis, ["state", "version"]);
  if (value.nsis.state !== "observed") {
    fail("SCHEMA_NSIS", "authoritative NSIS state must be observed");
  }
  assertString(value.nsis.version, "environment.toolchain.nsis.version");
}

function validateFoundationToolchainIdentity(value) {
  validateCommonToolchainIdentity(value);
  assertExactKeys(value.nsis, ["state", "version"]);
  if (value.nsis.state !== "not-invoked" || value.nsis.version !== null) {
    fail("SCHEMA_NSIS", "foundation NSIS must be explicitly recorded as not invoked");
  }
}

const commonEnvironmentKeys = Object.freeze([
  "platform",
  "processArchitecture",
  "machineArchitecture",
  "windowsEdition",
  "osCaption",
  "osVersion",
  "osBuild",
  "productType",
  "fileSystem",
  "elevated",
  "userSidSha256",
  "defenderAntivirusEnabled",
  "defenderRealtimeProtectionEnabled",
  "uacDefault",
  "developerModeEnabled",
  "toolchain",
]);

function validateEnvironmentFields(value, toolchainValidator) {
  for (const key of [
    "platform",
    "processArchitecture",
    "machineArchitecture",
    "windowsEdition",
    "osCaption",
    "osVersion",
    "osBuild",
    "productType",
    "fileSystem",
    "userSidSha256",
  ]) {
    assertString(value[key], `environment.${key}`);
  }
  if (!lowercaseSha256.test(value.userSidSha256)) {
    fail("SCHEMA_SID_HASH", "userSidSha256 must be lowercase 64-hex");
  }
  assertBooleanOrNull(value.elevated, "environment.elevated");
  assertBooleanOrNull(value.defenderAntivirusEnabled, "environment.defenderAntivirusEnabled");
  assertBooleanOrNull(
    value.defenderRealtimeProtectionEnabled,
    "environment.defenderRealtimeProtectionEnabled",
  );
  assertBooleanOrNull(value.uacDefault, "environment.uacDefault");
  assertBooleanOrNull(value.developerModeEnabled, "environment.developerModeEnabled");
  toolchainValidator(value.toolchain);
}

function validateAuthoritativeEnvironment(value) {
  assertExactKeys(value, [
    ...commonEnvironmentKeys,
    "environmentKind",
    "vmImageId",
    "vmSnapshotId",
  ]);
  validateEnvironmentFields(value, validateAuthoritativeToolchainIdentity);
  if (value.environmentKind !== "controlled-windows-11-vm") {
    fail("SCHEMA_ENVIRONMENT_KIND", "authoritative environment kind is invalid");
  }
  assertString(value.vmImageId, "environment.vmImageId");
  assertString(value.vmSnapshotId, "environment.vmSnapshotId");
}

function validateFoundationEnvironment(value) {
  assertExactKeys(value, [
    ...commonEnvironmentKeys,
    "environmentKind",
    "runnerImage",
    "runnerImageVersion",
    "hostPolicyExceptions",
  ]);
  validateEnvironmentFields(value, validateFoundationToolchainIdentity);
  if (value.environmentKind !== "github-hosted-runner") {
    fail("SCHEMA_ENVIRONMENT_KIND", "foundation environment kind is invalid");
  }
  assertString(value.runnerImage, "environment.runnerImage");
  assertString(value.runnerImageVersion, "environment.runnerImageVersion");
  if (!Array.isArray(value.hostPolicyExceptions)) {
    fail("SCHEMA_HOST_POLICY", "hostPolicyExceptions must be an array");
  }
  const uniqueExceptions = new Set(value.hostPolicyExceptions);
  if (
    uniqueExceptions.size !== value.hostPolicyExceptions.length ||
    value.hostPolicyExceptions.some(
      (exception) => !knownFoundationPolicyExceptions.includes(exception),
    ) ||
    value.hostPolicyExceptions.some(
      (exception, index) => exception !== [...value.hostPolicyExceptions].sort(compareBytes)[index],
    )
  ) {
    fail("SCHEMA_HOST_POLICY", "hostPolicyExceptions must be unique, known, and sorted");
  }
  const assessment = hostAssessment(value, {
    allowWindowsServer: true,
    allowElevated: true,
    allowDisabledUacOnElevatedHostedServer: true,
    allowDisabledDefenderRealtime: true,
    allowEnabledDeveloperMode: true,
    checkLocalAppData: false,
  });
  if (assessment.reasons.length > 0) {
    fail(
      "SCHEMA_ENVIRONMENT_FOUNDATION",
      `foundation environment is invalid: ${assessment.reasons.join(",")}`,
    );
  }
  if (
    assessment.exceptions.length !== value.hostPolicyExceptions.length ||
    assessment.exceptions.some(
      (exception, index) => exception !== value.hostPolicyExceptions[index],
    )
  ) {
    fail("SCHEMA_HOST_POLICY", "hostPolicyExceptions do not match the retained posture");
  }
}

function validateSharedRecord(value, expectedKind) {
  if (value.schemaVersion !== RESULT_SCHEMA_VERSION) {
    fail("SCHEMA_VERSION", `schemaVersion must be ${RESULT_SCHEMA_VERSION}`);
  }
  if (value.kind !== expectedKind) fail("SCHEMA_KIND", `kind must be ${expectedKind}`);
  if (expectedKind === "experiment") validateAuthoritativeEnvironment(value.environment);
  else validateFoundationEnvironment(value.environment);
  validateRunIdentity(value.run);
  if (!Array.isArray(value.observations) || value.observations.length === 0) {
    fail("SCHEMA_OBSERVATIONS", "observations must be a non-empty array");
  }
  value.observations.forEach(validateObservation);
  if (!Array.isArray(value.artifactHashes)) {
    fail("SCHEMA_ARTIFACTS", "artifactHashes must be an array");
  }
  value.artifactHashes.forEach(validateArtifactHash);
  const paths = value.artifactHashes.map((entry) => entry.path);
  const folded = new Set();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (folded.has(key))
      fail("SCHEMA_DUPLICATE_ARTIFACT", "artifact paths collide case-insensitively");
    folded.add(key);
  }
  const sorted = [...paths].sort(compareBytes);
  if (paths.some((path, index) => path !== sorted[index])) {
    fail("SCHEMA_ARTIFACT_ORDER", "artifact paths must be bytewise sorted");
  }
  for (const observation of value.observations) {
    if (observation.evidenceRef !== null && !folded.has(observation.evidenceRef.toLowerCase())) {
      fail("SCHEMA_EVIDENCE_REF", `unhashed evidenceRef: ${observation.evidenceRef}`);
    }
  }
}

export function validateExperimentRecord(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "authority",
      "id",
      "phase",
      "status",
      "claim",
      "environment",
      "run",
      "observations",
      "stopConditionTriggered",
      "artifactHashes",
    ],
    ["selectedMechanism"],
  );
  validateSharedRecord(value, "experiment");
  if (value.authority !== "native") fail("SCHEMA_AUTHORITY", "experiment authority must be native");
  const environmentAssessment = assessRetainedAuthoritativeEnvironment(value.environment);
  if (!environmentAssessment.accepted) {
    fail(
      "SCHEMA_ENVIRONMENT_AUTHORITY",
      `experiment environment is non-authoritative: ${environmentAssessment.reasons.join(",")}`,
    );
  }
  if (value.run.repositoryDirty) {
    fail("SCHEMA_DIRTY_AUTHORITY", "authoritative experiment evidence requires a clean worktree");
  }
  if (!EXPERIMENT_IDS.includes(value.id)) fail("SCHEMA_EXPERIMENT_ID", "invalid F-row id");
  if (!EXPERIMENT_PHASES.includes(value.phase)) fail("SCHEMA_PHASE", "invalid experiment phase");
  if (!EXPERIMENT_STATUSES.includes(value.status))
    fail("SCHEMA_STATUS", "invalid experiment status");
  assertString(value.claim, "claim");
  if (typeof value.stopConditionTriggered !== "boolean") {
    fail("SCHEMA_STOP", "stopConditionTriggered must be boolean");
  }
  if (value.stopConditionTriggered !== (value.status !== "PASS")) {
    fail(
      "SCHEMA_STOP_INVARIANT",
      "stop condition must be triggered exactly when status is not PASS",
    );
  }
  if (value.phase === "probe" && value.status === "PASS") {
    assertString(value.selectedMechanism, "selectedMechanism");
  } else if (Object.hasOwn(value, "selectedMechanism")) {
    fail("SCHEMA_MECHANISM", "selectedMechanism is allowed only for a probe PASS");
  }
  return value;
}

export function validateFoundationRecord(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "authority",
    "outcome",
    "operationQuiesced",
    "disposalState",
    "failureCode",
    "claim",
    "environment",
    "run",
    "observations",
    "artifactHashes",
  ]);
  validateSharedRecord(value, "ci-foundation");
  if (value.authority !== "non-authoritative") {
    fail("SCHEMA_AUTHORITY", "ci-foundation authority must be non-authoritative");
  }
  if (!FOUNDATION_OUTCOMES.includes(value.outcome)) {
    fail("SCHEMA_FOUNDATION_OUTCOME", "invalid foundation outcome");
  }
  if (typeof value.operationQuiesced !== "boolean") {
    fail("SCHEMA_FOUNDATION_QUIESCENCE", "operationQuiesced must be boolean");
  }
  if (!FOUNDATION_DISPOSAL_STATES.includes(value.disposalState)) {
    fail("SCHEMA_FOUNDATION_DISPOSAL", "invalid foundation disposal state");
  }
  if (value.failureCode !== null) assertString(value.failureCode, "failureCode");
  if (value.outcome === "foundation-succeeded") {
    if (!value.operationQuiesced || value.failureCode !== null) {
      fail("SCHEMA_FOUNDATION_SUCCESS", "successful foundation must quiesce without failure");
    }
  } else if (value.failureCode === null) {
    fail("SCHEMA_FOUNDATION_FAILURE", "non-success foundation must retain a failure code");
  }
  if (!value.operationQuiesced && value.outcome !== "foundation-inconclusive") {
    fail("SCHEMA_FOUNDATION_QUIESCENCE", "unquiesced foundation must be inconclusive");
  }
  assertString(value.claim, "claim");
  return value;
}

export function validateRunId(value) {
  if (typeof value !== "string" || value.length < 2 || !runIdPattern.test(value)) {
    fail("RUN_ID", "run id must be 2-64 lowercase ASCII letters, digits, or internal hyphens");
  }
  return value;
}

export function resolveWindowsChild(root, candidate) {
  if (typeof root !== "string" || !win32.isAbsolute(root) || root.startsWith("\\\\")) {
    fail("PATH_ROOT", "root must be an absolute local Windows path");
  }
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\u0000")) {
    fail("PATH_RELATIVE", "child path must be a non-empty relative string");
  }
  if (
    win32.isAbsolute(candidate) ||
    /^[a-z]:/iu.test(candidate) ||
    /^(?:\\\\|\/\/)/u.test(candidate) ||
    /^\\\\[?.]\\/u.test(candidate)
  ) {
    fail("PATH_ABSOLUTE", "absolute, drive-relative, UNC, and device paths are forbidden");
  }
  const segments = candidate.split(/[\\/]/u);
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      /[. ]$/u.test(segment) ||
      reservedWindowsNames.test(segment)
    ) {
      fail("PATH_SEGMENT", `unsafe Windows path segment: ${segment || "<empty>"}`);
    }
  }
  const resolved = win32.resolve(root, ...segments);
  const relation = win32.relative(win32.resolve(root), resolved);
  if (relation === ".." || relation.startsWith(`..${win32.sep}`) || win32.isAbsolute(relation)) {
    fail("PATH_ESCAPE", "child path escapes the run root");
  }
  return resolved;
}

export function validateLocalAppDataPath(value) {
  const normalized = typeof value === "string" ? win32.normalize(value) : "";
  const parsed = normalized.length === 0 ? undefined : win32.parse(normalized);
  if (
    typeof value !== "string" ||
    !win32.isAbsolute(value) ||
    value.startsWith("\\\\") ||
    value.slice(2).includes(":") ||
    parsed === undefined ||
    normalized.toLowerCase() === parsed.root.toLowerCase() ||
    normalized
      .split("\\")
      .some(
        (segment, index) =>
          index > 0 &&
          (segment.length === 0 || /[. ]$/u.test(segment) || reservedWindowsNames.test(segment)),
      )
  ) {
    fail("LOCALAPPDATA", "LOCALAPPDATA must be an absolute non-root local drive path");
  }
  return normalized;
}

function assessRetainedAuthoritativeEnvironment(environment) {
  const reasons = [];
  if (environment.platform !== "win32") reasons.push("NOT_WIN32");
  if (String(environment.processArchitecture).toLowerCase() !== "x64")
    reasons.push("PROCESS_NOT_X64");
  if (String(environment.machineArchitecture).toLowerCase() !== "x64")
    reasons.push("MACHINE_NOT_X64");
  if (String(environment.fileSystem).toUpperCase() !== "NTFS") reasons.push("ROOT_NOT_NTFS");
  if (environment.productType !== "workstation" || !/windows 11/iu.test(environment.osCaption)) {
    reasons.push("NOT_WINDOWS_11_CLIENT");
  }
  if (environment.elevated !== false) reasons.push("NOT_STANDARD_USER");
  if (environment.defenderAntivirusEnabled !== true) reasons.push("DEFENDER_ANTIVIRUS_NOT_ENABLED");
  if (environment.defenderRealtimeProtectionEnabled !== true)
    reasons.push("DEFENDER_REALTIME_NOT_ENABLED");
  if (environment.uacDefault !== true) reasons.push("UAC_NOT_DEFAULT");
  if (environment.developerModeEnabled !== false) reasons.push("DEVELOPER_MODE_ENABLED_OR_UNKNOWN");
  return reasons.length === 0 ? { accepted: true } : { accepted: false, reasons };
}

function hostAssessment(
  observed,
  {
    allowWindowsServer,
    allowElevated,
    allowDisabledUacOnElevatedHostedServer,
    allowDisabledDefenderRealtime,
    allowEnabledDeveloperMode,
    checkLocalAppData = true,
  },
) {
  const reasons = [];
  const exceptions = [];
  if (observed.platform !== "win32") reasons.push("NOT_WIN32");
  if (String(observed.processArchitecture).toLowerCase() !== "x64") reasons.push("PROCESS_NOT_X64");
  if (String(observed.machineArchitecture).toLowerCase() !== "x64") reasons.push("MACHINE_NOT_X64");
  if (String(observed.fileSystem).toUpperCase() !== "NTFS") reasons.push("ROOT_NOT_NTFS");
  if (checkLocalAppData) {
    try {
      validateLocalAppDataPath(observed.localAppData);
    } catch {
      reasons.push("LOCALAPPDATA_UNSAFE");
    }
  }
  if (observed.productType !== "workstation" || !/windows 11/iu.test(observed.osCaption)) {
    if (allowWindowsServer && observed.productType === "server") {
      exceptions.push("WINDOWS_SERVER_GITHUB_HOSTED_RUNNER");
    } else {
      reasons.push("NOT_WINDOWS_11_CLIENT");
    }
  }
  if (observed.elevated !== false) {
    if (allowElevated && observed.elevated === true) {
      exceptions.push("ELEVATED_GITHUB_HOSTED_RUNNER");
    } else {
      reasons.push("NOT_STANDARD_USER");
    }
  }
  if (observed.defenderAntivirusEnabled !== true) {
    reasons.push("DEFENDER_ANTIVIRUS_NOT_ENABLED");
  }
  if (observed.defenderRealtimeProtectionEnabled !== true) {
    if (allowDisabledDefenderRealtime && observed.defenderRealtimeProtectionEnabled === false) {
      exceptions.push("DEFENDER_REALTIME_DISABLED_ON_GITHUB_HOSTED_RUNNER");
    } else {
      reasons.push("DEFENDER_REALTIME_NOT_ENABLED");
    }
  }
  const permittedHostedUacException =
    allowDisabledUacOnElevatedHostedServer &&
    observed.productType === "server" &&
    observed.elevated === true &&
    observed.uacDefault === false;
  if (observed.uacDefault !== true && !permittedHostedUacException) {
    reasons.push("UAC_NOT_DEFAULT");
  } else if (permittedHostedUacException) {
    exceptions.push("UAC_DISABLED_ON_ELEVATED_GITHUB_HOSTED_SERVER");
  }
  if (observed.developerModeEnabled !== false) {
    if (allowEnabledDeveloperMode && observed.developerModeEnabled === true) {
      exceptions.push("DEVELOPER_MODE_ENABLED_ON_GITHUB_HOSTED_RUNNER");
    } else {
      reasons.push("DEVELOPER_MODE_ENABLED_OR_UNKNOWN");
    }
  }
  return {
    reasons: [...new Set(reasons)],
    exceptions: [...new Set(exceptions)].sort(compareBytes),
  };
}

export function assessAuthoritativeHost(observed) {
  const assessment = hostAssessment(observed, {
    allowWindowsServer: false,
    allowElevated: false,
    allowDisabledUacOnElevatedHostedServer: false,
    allowDisabledDefenderRealtime: false,
    allowEnabledDeveloperMode: false,
  });
  return assessment.reasons.length === 0
    ? { accepted: true }
    : { accepted: false, reasons: assessment.reasons };
}

export function assessCiFoundationHost(observed, { githubHostedRunnerAttested = false } = {}) {
  const assessment = hostAssessment(observed, {
    allowWindowsServer: githubHostedRunnerAttested,
    allowElevated: githubHostedRunnerAttested,
    allowDisabledUacOnElevatedHostedServer: githubHostedRunnerAttested,
    allowDisabledDefenderRealtime: githubHostedRunnerAttested,
    allowEnabledDeveloperMode: githubHostedRunnerAttested,
  });
  return assessment.reasons.length === 0
    ? { accepted: true, exceptions: assessment.exceptions }
    : { accepted: false, reasons: assessment.reasons };
}

export function redactText(value, { sentinel, replacements = [] } = {}) {
  let redacted = String(value);
  const ordered = replacements
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const replacement of ordered) redacted = redacted.split(replacement).join("<redacted-path>");
  if (typeof sentinel === "string" && sentinel.length > 0) {
    redacted = redacted.split(sentinel).join("<redacted-sentinel>");
  }
  return redacted
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu, "<redacted-email>")
    .replace(/S-1-(?:\d+-){2,14}\d+/gu, "<redacted-sid>")
    .replace(/[a-z]:\\Users\\[^\\\r\n]+/giu, "%USERPROFILE%");
}

export function bufferContainsSentinel(bytes, sentinel) {
  assertString(sentinel, "sentinel");
  const buffer = Buffer.from(bytes);
  return (
    buffer.indexOf(Buffer.from(sentinel, "utf8")) !== -1 ||
    buffer.indexOf(Buffer.from(sentinel, "utf16le")) !== -1
  );
}

function objectIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.isDirectory() ? "d" : "f"}`;
}

function stableFileIdentity(stat) {
  return `${objectIdentity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function classifyFoundationFinalizationError(error) {
  const failureCode =
    error instanceof FalsifierError ? error.code : "FOUNDATION_FINALIZATION_FAILED";
  const outcome =
    failureCode === "SENTINEL_CONTENT" || failureCode === "SENTINEL_FILENAME"
      ? "foundation-failed"
      : "foundation-inconclusive";
  return { outcome, failureCode };
}

async function assertPlainDirectory(path, label) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("REPARSE_DIRECTORY", `${label} is not a plain directory`);
  return stat;
}

async function walkTree(root, visitor, depth = 0, state = { files: 0, bytes: 0 }) {
  if (depth > maxScanDepth) fail("SCAN_DEPTH", "scan depth exceeded");
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => compareBytes(left.name, right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      fail("SCAN_REPARSE", "scan surface contains a symbolic link or junction");
    const path = join(root, entry.name);
    await visitor({ entry, path, state });
    if (entry.isDirectory()) await walkTree(path, visitor, depth + 1, state);
  }
  return state;
}

export async function scanTreeForSentinel(root, sentinel) {
  await assertPlainDirectory(root, "scan root");
  const rootResolved = resolve(root);
  return walkTree(rootResolved, async ({ entry, path, state }) => {
    const relation = relative(rootResolved, path);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      fail("SCAN_ESCAPE", "scan entry escaped root");
    }
    if (bufferContainsSentinel(Buffer.from(entry.name, "utf8"), sentinel)) {
      fail("SENTINEL_FILENAME", "sentinel detected in a retained filename");
    }
    if (!entry.isFile()) return;
    state.files += 1;
    if (state.files > maxScanFiles) fail("SCAN_FILE_COUNT", "scan file-count bound exceeded");
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink())
      fail("SCAN_FILE_TYPE", "scan entry is not a stable file");
    if (before.size > maxArtifactBytes) fail("SCAN_FILE_SIZE", "scan per-file bound exceeded");
    state.bytes += before.size;
    if (state.bytes > maxScanBytes) fail("SCAN_TOTAL_SIZE", "scan total-byte bound exceeded");
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (stableFileIdentity(before) !== stableFileIdentity(after)) {
      fail("SCAN_UNSTABLE", "scan entry changed while being read");
    }
    if (bufferContainsSentinel(bytes, sentinel)) {
      fail("SENTINEL_CONTENT", "sentinel detected in retained content");
    }
  });
}

async function resolveOwnedArtifact(evidenceRoot, relativePath) {
  const retainedPath = validateArtifactRelativePath(relativePath);
  await assertPlainDirectory(evidenceRoot, "evidence root");
  const canonicalRoot = await realpath(evidenceRoot);
  const candidate = resolve(evidenceRoot, ...retainedPath.split("/"));
  const before = await lstat(candidate);
  if (!before.isFile() || before.isSymbolicLink())
    fail("HASH_FILE_TYPE", "artifact is not a stable regular file");
  const canonicalCandidate = await realpath(candidate);
  const relationToRoot = relative(canonicalRoot, canonicalCandidate);
  if (
    relationToRoot === ".." ||
    relationToRoot.startsWith(`..${sep}`) ||
    isAbsolute(relationToRoot)
  ) {
    fail("HASH_ESCAPE", "artifact resolves outside the owned evidence root");
  }
  return { retainedPath, candidate, canonicalRoot, canonicalCandidate, before };
}

export async function hashStableArtifact(evidenceRoot, relativePath, { sentinel } = {}) {
  const resolvedArtifact = await resolveOwnedArtifact(evidenceRoot, relativePath);
  const { before, candidate } = resolvedArtifact;
  if (before.size > maxArtifactBytes) fail("HASH_FILE_SIZE", "artifact exceeds the hashing bound");
  const handle = await open(candidate, "r");
  let bytes;
  try {
    const handleBefore = await handle.stat();
    if (stableFileIdentity(before) !== stableFileIdentity(handleBefore)) {
      fail("HASH_UNSTABLE", "opened artifact identity differs from the resolved object");
    }
    bytes = Buffer.alloc(handleBefore.size);
    const firstRead = await handle.read(bytes, 0, bytes.length, 0);
    if (firstRead.bytesRead !== bytes.length) {
      fail("HASH_UNSTABLE", "opened artifact could not be read completely");
    }
    const verificationBytes = Buffer.alloc(handleBefore.size);
    const secondRead = await handle.read(verificationBytes, 0, verificationBytes.length, 0);
    if (secondRead.bytesRead !== verificationBytes.length || !bytes.equals(verificationBytes)) {
      fail("HASH_UNSTABLE", "opened artifact bytes changed between bounded reads");
    }
    const handleAfter = await handle.stat();
    if (stableFileIdentity(handleBefore) !== stableFileIdentity(handleAfter)) {
      fail("HASH_UNSTABLE", "opened artifact changed while being hashed");
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(candidate);
  const canonicalCandidateAfter = await realpath(candidate);
  const canonicalRootAfter = await realpath(evidenceRoot);
  const relationAfter = relative(resolvedArtifact.canonicalRoot, canonicalCandidateAfter);
  if (stableFileIdentity(before) !== stableFileIdentity(after)) {
    fail("HASH_UNSTABLE", "artifact changed while being hashed");
  }
  if (
    relationAfter === ".." ||
    relationAfter.startsWith(`..${sep}`) ||
    isAbsolute(relationAfter) ||
    canonicalRootAfter !== resolvedArtifact.canonicalRoot ||
    canonicalCandidateAfter !== resolvedArtifact.canonicalCandidate
  ) {
    fail("HASH_UNSTABLE", "artifact identity or containment changed while being hashed");
  }
  if (sentinel !== undefined) {
    assertString(sentinel, "sentinel");
    if (bufferContainsSentinel(Buffer.from(resolvedArtifact.retainedPath, "utf8"), sentinel)) {
      fail("SENTINEL_FILENAME", "sentinel detected in the retained artifact path");
    }
    if (bufferContainsSentinel(bytes, sentinel)) {
      fail("SENTINEL_CONTENT", "sentinel detected in the exact retained artifact bytes");
    }
  }
  return {
    path: resolvedArtifact.retainedPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function runWithDeadline(operation, { timeoutMs, quiescenceMs = 250 } = {}) {
  assertInteger(timeoutMs, "timeoutMs", 1);
  assertInteger(quiescenceMs, "quiescenceMs", 1);
  const controller = new AbortController();
  let timeoutHandle;
  let graceHandle;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  operationPromise.catch(() => undefined);
  const timed = new Promise((resolveTimed) => {
    timeoutHandle = setTimeout(() => resolveTimed({ kind: "timeout" }), timeoutMs);
  });
  const first = await Promise.race([
    operationPromise.then(
      (value) => ({ kind: "completed", value }),
      (error) => ({ kind: "rejected", error }),
    ),
    timed,
  ]);
  clearTimeout(timeoutHandle);
  if (first.kind === "completed") return { state: "completed", value: first.value };
  if (first.kind === "rejected") return { state: "rejected", error: first.error };
  controller.abort();
  const quiescence = await Promise.race([
    operationPromise.then(
      () => ({ settled: true }),
      () => ({ settled: true }),
    ),
    new Promise((resolveGrace) => {
      graceHandle = setTimeout(() => resolveGrace({ settled: false }), quiescenceMs);
    }),
  ]);
  clearTimeout(graceHandle);
  return { state: "timed-out", quiesced: quiescence.settled };
}

async function repositoryIdentity() {
  const [{ stdout: commitOutput }, { stdout: statusOutput }, scriptBytes] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    }),
    readFile(scriptPath),
  ]);
  const repositoryCommit = commitOutput.trim().toLowerCase();
  if (!repositoryCommitPattern.test(repositoryCommit))
    fail("REPOSITORY_COMMIT", "cannot resolve exact repository commit");
  return {
    repositoryCommit,
    repositoryDirty: statusOutput.trim().length > 0,
    scriptSha256: createHash("sha256").update(scriptBytes).digest("hex"),
  };
}

async function readInstalledPackageVersion(packageName) {
  const manifestPath = join(
    repositoryRoot,
    "apps/desktop/node_modules",
    packageName,
    "package.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("TOOLCHAIN_PACKAGE", `cannot read installed ${packageName} package identity`);
  }
  if (
    !exactObject(manifest) ||
    manifest.name !== packageName ||
    typeof manifest.version !== "string" ||
    !exactVersionPattern.test(manifest.version)
  ) {
    fail("TOOLCHAIN_VERSION", `installed ${packageName} package identity is invalid`);
  }
  return manifest.version;
}

export async function resolveFoundationToolchainIdentity({ nodeVersion = process.version } = {}) {
  assertString(nodeVersion, "toolchain.nodeVersion");
  const [electronVersion, electronBuilderVersion, updaterVersion] = await Promise.all([
    readInstalledPackageVersion("electron"),
    readInstalledPackageVersion("electron-builder"),
    readInstalledPackageVersion("electron-updater"),
  ]);
  return {
    nodeVersion,
    electronVersion,
    electronBuilderVersion,
    updaterVersion,
    nsis: { state: "not-invoked", version: null },
  };
}

const hostObservationScript = String.raw`
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$currentVersion = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$volume = @(Get-Volume -FilePath $env:LOCALAPPDATA)[0]
$uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$developerMode = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction SilentlyContinue
$defenderAntivirusEnabled = $null
$defenderRealtimeProtectionEnabled = $null
try {
  $defender = Get-MpComputerStatus -ErrorAction Stop
  $defenderAntivirusEnabled = [bool]$defender.AntivirusEnabled
  $defenderRealtimeProtectionEnabled = [bool]$defender.RealTimeProtectionEnabled
} catch {}
$uacDefault = [bool](
  $uac.EnableLUA -eq 1 -and
  $uac.ConsentPromptBehaviorAdmin -eq 5 -and
  $uac.PromptOnSecureDesktop -eq 1
)
[ordered]@{
  machineArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  windowsEdition = [string]$currentVersion.EditionID
  osCaption = [string]$os.Caption
  osVersion = [string]$os.Version
  osBuild = "$($currentVersion.CurrentBuildNumber).$($currentVersion.UBR)"
  productType = if ([int]$os.ProductType -eq 1) { 'workstation' } else { 'server' }
  fileSystem = [string]$volume.FileSystem
  elevated = [bool]$elevated
  userSid = [string]$identity.User.Value
  defenderAntivirusEnabled = $defenderAntivirusEnabled
  defenderRealtimeProtectionEnabled = $defenderRealtimeProtectionEnabled
  uacDefault = $uacDefault
  developerModeEnabled = [bool]($null -ne $developerMode -and $developerMode.AllowDevelopmentWithoutDevLicense -eq 1)
} | ConvertTo-Json -Compress
`;

export async function observeWindowsHost({ localAppData = process.env.LOCALAPPDATA } = {}) {
  if (process.platform !== "win32")
    fail("HOST_PLATFORM", "native host observation requires Windows");
  validateLocalAppDataPath(localAppData);
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      hostObservationScript,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    },
  );
  let native;
  try {
    native = JSON.parse(stdout.trim());
  } catch {
    fail("HOST_ATTESTATION", "Windows host attestation did not return valid JSON");
  }
  const toolchain = await resolveFoundationToolchainIdentity();
  return {
    platform: process.platform,
    processArchitecture: process.arch,
    machineArchitecture: String(native.machineArchitecture).toLowerCase(),
    windowsEdition: String(native.windowsEdition),
    osCaption: String(native.osCaption),
    osVersion: String(native.osVersion),
    osBuild: String(native.osBuild),
    productType: String(native.productType),
    fileSystem: String(native.fileSystem),
    elevated: typeof native.elevated === "boolean" ? native.elevated : null,
    userSid: String(native.userSid),
    defenderAntivirusEnabled:
      typeof native.defenderAntivirusEnabled === "boolean" ? native.defenderAntivirusEnabled : null,
    defenderRealtimeProtectionEnabled:
      typeof native.defenderRealtimeProtectionEnabled === "boolean"
        ? native.defenderRealtimeProtectionEnabled
        : null,
    uacDefault: typeof native.uacDefault === "boolean" ? native.uacDefault : null,
    developerModeEnabled:
      typeof native.developerModeEnabled === "boolean" ? native.developerModeEnabled : null,
    toolchain,
    localAppData,
  };
}

function retainedEnvironmentFields(observed) {
  const retained = {
    platform: observed.platform,
    processArchitecture: observed.processArchitecture,
    machineArchitecture: observed.machineArchitecture,
    windowsEdition: observed.windowsEdition,
    osCaption: observed.osCaption,
    osVersion: observed.osVersion,
    osBuild: observed.osBuild,
    productType: observed.productType,
    fileSystem: observed.fileSystem,
    elevated: observed.elevated,
    userSidSha256: createHash("sha256").update(observed.userSid, "utf8").digest("hex"),
    defenderAntivirusEnabled: observed.defenderAntivirusEnabled,
    defenderRealtimeProtectionEnabled: observed.defenderRealtimeProtectionEnabled,
    uacDefault: observed.uacDefault,
    developerModeEnabled: observed.developerModeEnabled,
    toolchain: observed.toolchain,
  };
  return retained;
}

export function retainedFoundationEnvironment(
  observed,
  { runnerImage, runnerImageVersion, hostPolicyExceptions },
) {
  const retained = {
    ...retainedEnvironmentFields(observed),
    environmentKind: "github-hosted-runner",
    runnerImage,
    runnerImageVersion,
    hostPolicyExceptions,
  };
  validateFoundationEnvironment(retained);
  return retained;
}

export function retainedAuthoritativeEnvironment(observed, { vmImageId, vmSnapshotId }) {
  const retained = {
    ...retainedEnvironmentFields(observed),
    environmentKind: "controlled-windows-11-vm",
    vmImageId,
    vmSnapshotId,
  };
  validateAuthoritativeEnvironment(retained);
  return retained;
}

export function attestGitHubHostedRunner(
  { runnerImage, runnerImageVersion },
  environment = process.env,
) {
  return (
    environment.GITHUB_ACTIONS === "true" &&
    environment.RUNNER_ENVIRONMENT === "github-hosted" &&
    environment.RUNNER_OS === "Windows" &&
    environment.ImageOS === runnerImage &&
    environment.ImageVersion === runnerImageVersion
  );
}

async function createOwnedRunRoot({ localAppData, runId }) {
  validateRunId(runId);
  validateLocalAppDataPath(localAppData);
  const base = join(localAppData, "Enduragent-Falsifier");
  await assertPlainDirectory(localAppData, "LOCALAPPDATA");
  const canonicalLocalAppData = await realpath(localAppData);
  await mkdir(base, { recursive: true });
  await assertPlainDirectory(base, "falsifier base");
  const canonicalBase = await realpath(base);
  const relationToLocal = relative(canonicalLocalAppData, canonicalBase);
  if (
    relationToLocal === ".." ||
    relationToLocal.startsWith(`..${sep}`) ||
    isAbsolute(relationToLocal)
  ) {
    fail("RUN_BASE_ESCAPE", "falsifier base resolves outside LOCALAPPDATA");
  }
  const root = join(base, runId);
  await mkdir(root, { recursive: false });
  await assertPlainDirectory(root, "run root");
  const controlScratch = join(root, "control-scratch");
  const evidence = join(root, "evidence");
  await mkdir(controlScratch, { recursive: false });
  await mkdir(evidence, { recursive: false });
  const [controlScratchStat, evidenceStat] = await Promise.all([
    assertPlainDirectory(controlScratch, "control scratch"),
    assertPlainDirectory(evidence, "evidence root"),
  ]);
  return {
    runId,
    root,
    controlScratch,
    evidence,
    controlScratchIdentity: objectIdentity(controlScratchStat),
    evidenceIdentity: objectIdentity(evidenceStat),
  };
}

export async function runCiFoundation({
  runId,
  runnerImage,
  runnerImageVersion,
  observedHost,
  wallNow = () => new Date(),
  monotonicNow = () => performance.now(),
  randomBytesFn = randomBytes,
  timeoutMs = 5_000,
  quiescenceMs = 1_000,
  selfTestOperation,
} = {}) {
  validateRunId(runId);
  assertString(runnerImage, "runnerImage");
  assertString(runnerImageVersion, "runnerImageVersion");
  if (process.platform !== "win32") {
    fail("HOST_PLATFORM", "ci-foundation execution requires the actual Windows runtime");
  }
  if (!attestGitHubHostedRunner({ runnerImage, runnerImageVersion })) {
    fail("RUNNER_ATTESTATION", "ci-foundation execution requires a GitHub-hosted Windows runner");
  }
  const observed = observedHost ?? (await observeWindowsHost());
  const assessment = assessCiFoundationHost(observed, { githubHostedRunnerAttested: true });
  if (!assessment.accepted) {
    fail("HOST_REFUSED", `ci-foundation host refused: ${assessment.reasons.join(",")}`);
  }
  const startedAt = wallNow().toISOString();
  const startedMonotonic = monotonicNow();
  const identity = await repositoryIdentity();
  const owned = await createOwnedRunRoot({
    localAppData: observed.localAppData,
    runId,
  });
  const sentinel = `ENDURAGENT-FALSIFIER-${Buffer.from(randomBytesFn(24)).toString("hex")}`;
  const artifactName = "foundation-artifact.txt";
  const stagedArtifactPath = join(owned.controlScratch, artifactName);
  const scratchPath = join(owned.controlScratch, "bounded-write.txt");
  const operation =
    selfTestOperation ??
    (async ({ signal }) => {
      if (signal.aborted) fail("FOUNDATION_ABORTED", "foundation self-test aborted before start");
      await writeFile(scratchPath, "bounded scratch write\n", { flag: "wx", mode: 0o600 });
      const raw = `redaction-check:${sentinel}:synthetic@example.invalid`;
      const redacted = redactText(raw, { sentinel, replacements: [observed.localAppData] });
      await writeFile(stagedArtifactPath, `${redacted}\n`, { flag: "wx", mode: 0o600 });
      return true;
    });

  let outcome = "foundation-inconclusive";
  let operationQuiesced = true;
  let failureCode = null;
  let selfTestActual = "foundation self-test did not complete";
  let artifactHashes = [];
  try {
    const selfTest = await runWithDeadline(
      (signal) =>
        operation({
          signal,
          controlScratch: owned.controlScratch,
          stagedArtifactPath,
          scratchPath,
          sentinel,
        }),
      { timeoutMs, quiescenceMs },
    );
    if (selfTest.state === "completed") {
      const scratchStat = await assertPlainDirectory(owned.controlScratch, "control scratch");
      if (objectIdentity(scratchStat) !== owned.controlScratchIdentity) {
        fail("CONTROL_SCRATCH_SWAPPED", "control scratch identity changed");
      }
      await scanTreeForSentinel(owned.controlScratch, sentinel);
      const stagedBefore = await lstat(stagedArtifactPath);
      if (!stagedBefore.isFile() || stagedBefore.isSymbolicLink()) {
        fail("FOUNDATION_ARTIFACT_TYPE", "staged foundation artifact is not a regular file");
      }
      const stagedBytes = await readFile(stagedArtifactPath);
      const stagedAfter = await lstat(stagedArtifactPath);
      if (stableFileIdentity(stagedBefore) !== stableFileIdentity(stagedAfter)) {
        fail("FOUNDATION_ARTIFACT_UNSTABLE", "staged foundation artifact changed while read");
      }
      const evidenceStat = await assertPlainDirectory(owned.evidence, "evidence root");
      if (objectIdentity(evidenceStat) !== owned.evidenceIdentity) {
        fail("EVIDENCE_ROOT_SWAPPED", "evidence root identity changed");
      }
      await writeFile(join(owned.evidence, artifactName), stagedBytes, {
        flag: "wx",
        mode: 0o600,
      });
      await scanTreeForSentinel(owned.evidence, sentinel);
      artifactHashes = [await hashStableArtifact(owned.evidence, artifactName, { sentinel })];
      outcome = "foundation-succeeded";
      selfTestActual = "bounded redaction, scanning, and owned-root hashing completed";
    } else if (selfTest.state === "rejected") {
      outcome = "foundation-failed";
      failureCode =
        selfTest.error instanceof FalsifierError
          ? selfTest.error.code
          : "FOUNDATION_OPERATION_REJECTED";
      selfTestActual = `foundation self-test rejected with ${failureCode}`;
    } else {
      operationQuiesced = selfTest.quiesced;
      outcome = "foundation-inconclusive";
      failureCode = selfTest.quiesced
        ? "FOUNDATION_TIMEOUT_QUIESCED"
        : "FOUNDATION_TIMEOUT_UNQUIESCED";
      selfTestActual = `foundation self-test timed out; quiesced=${selfTest.quiesced}`;
    }
  } catch (error) {
    ({ outcome, failureCode } = classifyFoundationFinalizationError(error));
    selfTestActual = `foundation finalization failed with ${failureCode}`;
  }

  const endedMonotonic = monotonicNow();
  const endedAt = wallNow().toISOString();
  const record = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kind: "ci-foundation",
    authority: "non-authoritative",
    outcome,
    operationQuiesced,
    disposalState: "external-runner-disposal-required",
    failureCode,
    claim:
      outcome === "foundation-succeeded"
        ? "The native Windows harness foundation created bounded data, retained sanitized evidence, and left control scratch for external runner disposal; this closes no F-row."
        : outcome === "foundation-failed"
          ? "The native Windows harness foundation retained a non-authoritative negative result and left control scratch for external runner disposal; this closes no F-row."
          : "The native Windows harness foundation retained a non-authoritative inconclusive result and left control scratch for external runner disposal; this closes no F-row.",
    environment: retainedFoundationEnvironment(observed, {
      runnerImage,
      runnerImageVersion,
      hostPolicyExceptions: assessment.exceptions,
    }),
    run: {
      runId,
      ...identity,
      startedAt,
      endedAt,
      monotonicDurationMs: Math.max(0, endedMonotonic - startedMonotonic),
    },
    observations: [
      {
        step: "host-assessment",
        expected:
          "attested GitHub-hosted win32 x64 process on x64 NTFS with explicit posture exceptions",
        actual: `accepted only for non-authoritative CI foundation execution; exceptions=${assessment.exceptions.join(",") || "none"}`,
        evidenceRef: null,
      },
      {
        step: "bounded-redaction-scan",
        expected: "sentinel and synthetic email absent from retained evidence",
        actual: selfTestActual,
        evidenceRef: outcome === "foundation-succeeded" ? artifactName : null,
      },
      {
        step: "scratch-disposition",
        expected: "no destructive tree cleanup before native reparse and file-identity selection",
        actual: operationQuiesced
          ? "bounded control scratch retained for external ephemeral-runner disposal"
          : "unquiesced control scratch retained; external runner disposal is mandatory",
        evidenceRef: null,
      },
    ],
    artifactHashes,
  };
  validateFoundationRecord(record);
  const recordPath = join(owned.evidence, "ci-foundation.json");
  const recordBytes = canonicalJson(record);
  await writeFile(recordPath, recordBytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await scanTreeForSentinel(owned.evidence, sentinel);
  const recordHash = createHash("sha256").update(recordBytes, "utf8").digest("hex");
  await writeFile(
    join(owned.evidence, "ci-foundation.sha256"),
    `${recordHash}  ci-foundation.json\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
  return { record, evidenceDirectory: owned.evidence };
}

function parseArguments(argv) {
  const values = new Map();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
    if (!match) fail("ARGUMENT", `invalid argument: ${argument}`);
    if (values.has(match[1])) fail("ARGUMENT_DUPLICATE", `duplicate argument: --${match[1]}`);
    values.set(match[1], match[2]);
  }
  const permitted = new Set(["mode", "run-id", "runner-image", "runner-image-version"]);
  for (const key of values.keys()) {
    if (!permitted.has(key)) fail("ARGUMENT_UNKNOWN", `unknown argument: --${key}`);
  }
  return values;
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const mode = argumentsMap.get("mode");
  if (mode !== "ci-foundation") {
    fail(
      "MODE",
      "PR-01a exposes only --mode=ci-foundation; authoritative F-row probes arrive in PR-01b",
    );
  }
  const runId = argumentsMap.get("run-id");
  const runnerImage = argumentsMap.get("runner-image");
  const runnerImageVersion = argumentsMap.get("runner-image-version");
  validateRunId(runId);
  assertString(runnerImage, "runner-image");
  assertString(runnerImageVersion, "runner-image-version");
  const { record } = await runCiFoundation({ runId, runnerImage, runnerImageVersion });
  process.stdout.write(
    canonicalJson({
      kind: record.kind,
      authority: record.authority,
      outcome: record.outcome,
      runId: record.run.runId,
      evidence: "%LOCALAPPDATA%\\Enduragent-Falsifier\\<run-id>\\evidence",
    }),
  );
  if (record.outcome !== "foundation-succeeded") process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath.toLowerCase() === resolve(scriptPath).toLowerCase()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = redactText(message, {
      replacements: [process.env.LOCALAPPDATA, process.env.USERPROFILE, tmpdir()],
    });
    process.stderr.write(`windows-host-falsifier: ${safeMessage}\n`);
    process.exitCode = 1;
  });
}
