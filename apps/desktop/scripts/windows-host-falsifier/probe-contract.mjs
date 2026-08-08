import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

export const PROBE_CONTRACT_SCHEMA_VERSION = 1;
export const PROBE_CAMPAIGN_ID = "f01-f10-native-probe-v1";
export const PROBE_ENVIRONMENT_IDS = Object.freeze(["win11-floor", "win11-current"]);
export const PROBE_PATH_PROFILE_IDS = Object.freeze(["ascii", "spaces-unicode"]);
export const PROBE_SEGMENT_OUTCOMES = Object.freeze(["PASS", "FAIL", "INCONCLUSIVE", "SKIP"]);
export const PROBE_VERIFIER_IDS = Object.freeze([
  "hard-cut-probe-verifier-v1",
  "native-probe-verifier-v1",
]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const exactVersionPattern = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u;
const forbiddenFloatingVersion =
  /^(?:current|default|latest|stable|system|unknown|unversioned|\*)$/iu;

const REQUIRED_ATTESTATION_CAPABILITIES = Object.freeze([
  "bootCompleteObservation",
  "defaultUac",
  "defenderRealtimeEnabled",
  "developerModeDisabled",
  "externalAbruptPower",
  "externalSnapshotRestore",
  "immutableSnapshotIdentity",
  "interactiveStandardUserSession",
  "isolatedNatAndHostOnlyNetwork",
  "nativeWindows11X64",
  "ntfsSystemAndTestVolumes",
  "remoteWindowsPeer",
  "runnerIdentityPinned",
  "secondStandardUser",
  "standardUserNonElevated",
]);

const F03_PAYLOADS = Object.freeze(["port", "profile", "token", "vault"]);
const F03_REQUIRED_TARGETS = Object.freeze([
  "absent",
  "directory",
  "existing-regular-file",
  "hard-link",
  "inspect-create-swap",
  "junction-reparse",
  "read-only-file",
]);
const F04_TOPOLOGIES = Object.freeze([
  "ancestor-junction",
  "concurrent-swap-loop",
  "junction-chain",
  "leaf-mount-point",
  "leaf-symlink",
  "normal-nested",
]);
const F04_OPERATIONS = Object.freeze(["create", "delete", "quarantine", "read", "replace"]);
const F05_OPERATIONS = Object.freeze(["delete", "quarantine", "replace"]);
const F05_IDENTITIES = Object.freeze(["same-object", "stale-identity"]);
const F05_LIFETIMES = Object.freeze(["hard-link", "process-restart", "same-process"]);
const F06_CONTEXTS = Object.freeze([
  "baseline",
  "defender-scan",
  "process-crash",
  "rapid-readers",
  "reboot",
]);
const F06_CHECKPOINTS = Object.freeze([
  "after-flush",
  "after-replace",
  "before-replace",
  "before-temp-write",
  "during-replace",
  "during-write",
]);
const F06_SHARE_MODES = Object.freeze(["share-allows-replace", "share-denies-replace"]);

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function sorted(values) {
  return [...values].sort(compareUtf8);
}

function crossProductVariantIds(prefix, ...axes) {
  let combinations = [[]];
  for (const axis of axes) {
    combinations = combinations.flatMap((existing) => axis.map((value) => [...existing, value]));
  }
  return sorted(combinations.map((parts) => `${prefix}-${parts.join("-")}`));
}

function conditionalVariant(variantId, conditionId) {
  return { variantId, conditionId };
}

const rows = [
  {
    rowId: "F-01",
    dependsOnRowIds: [],
    claim: "Supported aliases converge on one restart-stable, move-sensitive local-home identity.",
    stopCondition:
      "Reject the identity representation and block credential, lock, and handshake binding.",
    requiredVariantIds: sorted([
      "f01-actual-component-case-alias",
      "f01-case-sensitive-directory",
      "f01-daemon-main-identity-agreement",
      "f01-directory-junction-alias",
      "f01-distinct-homes",
      "f01-drive-letter-case-alias",
      "f01-long-path-alias",
      "f01-ordinary-absolute-path",
      "f01-reboot-stability",
      "f01-relocate-copy-rebind",
      "f01-rename-rebind",
      "f01-reparse-chain-escape",
      "f01-restart-stability",
      "f01-spaces-unicode-path",
      "f01-subst-drive-alias",
      "f01-unc-path-refusal",
    ]),
    conditionalVariants: sortedConditional([
      conditionalVariant("f01-8dot3-short-name-alias", "8dot3-names-enabled"),
      conditionalVariant("f01-mapped-network-drive-refusal", "mapped-network-drive-available"),
      conditionalVariant("f01-removable-non-ntfs-refusal", "removable-non-ntfs-volume-available"),
    ]),
  },
  {
    rowId: "F-02",
    dependsOnRowIds: ["F-01"],
    claim: "A standard user can create or repair and independently prove a private directory DACL.",
    stopCondition: "Reject the DACL mechanism and block Windows private persistence.",
    requiredVariantIds: sorted([
      "f02-broad-authenticated-users-repair",
      "f02-broad-everyone-repair",
      "f02-broad-users-repair",
      "f02-create-private-directory",
      "f02-explicit-local-appdata-root",
      "f02-inherited-profile-parent",
      "f02-invalid-root-empty",
      "f02-invalid-root-network",
      "f02-invalid-root-relative",
      "f02-invalid-root-removable",
      "f02-invalid-root-reparse-escape",
      "f02-invalid-root-roaming",
      "f02-owner-create",
      "f02-owner-delete",
      "f02-owner-ordered-aces",
      "f02-owner-read",
      "f02-owner-rename",
      "f02-second-user-read-refusal",
      "f02-second-user-write-refusal",
      "f02-unrepairable-owner-deny",
    ]),
    conditionalVariants: [],
  },
  {
    rowId: "F-03",
    dependsOnRowIds: ["F-02"],
    claim:
      "Private regular-file creation fails closed on unexpected objects and proves final identity and DACL.",
    stopCondition:
      "Reject the private-file primitive and block store, vault, and daemon-token work.",
    requiredVariantIds: crossProductVariantIds("f03", F03_PAYLOADS, F03_REQUIRED_TARGETS),
    conditionalVariants: sortedConditional(
      F03_PAYLOADS.map((payload) =>
        conditionalVariant(`f03-${payload}-symlink`, "symlink-creation-privilege-available"),
      ),
    ),
  },
  {
    rowId: "F-04",
    dependsOnRowIds: ["F-03"],
    claim: "Security-sensitive path operations reject reparse escapes and swap races.",
    stopCondition:
      "Reject the reparse strategy and block Windows persistence and destructive cleanup.",
    requiredVariantIds: crossProductVariantIds("f04", F04_TOPOLOGIES, F04_OPERATIONS),
    conditionalVariants: [],
  },
  {
    rowId: "F-05",
    dependsOnRowIds: ["F-03"],
    claim: "Destructive operations act only on the same handle-bound object that was inspected.",
    stopCondition:
      "Reject the identity primitive and block identity-sensitive cleanup and deletion.",
    requiredVariantIds: crossProductVariantIds(
      "f05",
      F05_OPERATIONS,
      F05_IDENTITIES,
      F05_LIFETIMES,
    ),
    conditionalVariants: [],
  },
  {
    rowId: "F-06",
    dependsOnRowIds: ["F-03", "F-04", "F-05"],
    claim:
      "Private-file replacement is atomic under Windows sharing and security scanning with bounded retries.",
    stopCondition: "Reject the replacement primitive and block mutable private-store writes.",
    requiredVariantIds: crossProductVariantIds(
      "f06",
      F06_CONTEXTS,
      F06_CHECKPOINTS,
      F06_SHARE_MODES,
    ),
    conditionalVariants: [],
  },
  {
    rowId: "F-07",
    dependsOnRowIds: ["F-06"],
    claim:
      "Replacement outcomes distinguish not committed, durably committed, and commit uncertain after hard cuts.",
    stopCondition:
      "Reject durability overclaims and block callers that assume unproved durable mutation.",
    requiredVariantIds: sorted([
      "f07-file-flush-capability",
      "f07-hard-cut-after-file-flush",
      "f07-hard-cut-after-namespace-replace",
      "f07-hard-cut-after-parent-volume-flush",
      "f07-hard-cut-after-temp-creation",
      "f07-parent-directory-handle-capability",
      "f07-process-kill-after-file-flush",
      "f07-process-kill-after-namespace-replace",
      "f07-process-kill-after-parent-volume-flush",
      "f07-process-kill-after-temp-creation",
      "f07-recovery-envelope-checksum",
      "f07-recovery-old-or-new-complete",
      "f07-truthful-commit-uncertain",
    ]),
    conditionalVariants: [],
  },
  {
    rowId: "F-08",
    dependsOnRowIds: ["F-01"],
    claim:
      "A per-home authenticated named-pipe fence gives one successor exclusive crash-released ownership.",
    stopCondition: "Reject named pipes and require a separately falsified architecture amendment.",
    requiredVariantIds: sorted([
      "f08-client-correct-successor",
      "f08-client-duplicate-correct-attempt",
      "f08-client-foreign-precreator",
      "f08-client-ordinary-starter",
      "f08-client-remote-pipe-refusal",
      "f08-client-second-user-refusal",
      "f08-client-wrong-capability",
      "f08-continuous-ownership-sampling",
      "f08-daemon-golden-home-a",
      "f08-daemon-golden-home-b",
      "f08-daemon-production-name",
      "f08-distinct-home-names",
      "f08-endpoint-grammar",
      "f08-injected-derivation-collision",
      "f08-kill-after-capability-consumption",
      "f08-kill-after-successor-admission",
      "f08-kill-before-accept",
      "f08-kill-during-frame-read",
      "f08-main-golden-home-a",
      "f08-main-golden-home-b",
      "f08-main-production-name",
      "f08-n-to-n-plus-one-handoff",
      "f08-no-raw-identity-substring",
      "f08-reboot-stability",
      "f08-restart-stability",
      "f08-starter-race",
    ]),
    conditionalVariants: [],
  },
  {
    rowId: "F-09",
    dependsOnRowIds: [],
    claim:
      "The daemon process tree is assigned before start and terminates within bounded graceful or forced deadlines.",
    stopCondition: "Reject the Job Object mechanism and block Windows daemon packaging.",
    requiredVariantIds: sorted([
      "f09-assignment-before-start",
      "f09-crash-after-ready",
      "f09-explicit-quit",
      "f09-grandchild-cleanup",
      "f09-hang-before-ready",
      "f09-ignore-shutdown-forced-stop",
      "f09-main-process-crash",
      "f09-nestable-outer-job",
      "f09-non-nestable-outer-job-refusal",
      "f09-normal-ready-shutdown",
      "f09-os-shutdown-notification",
      "f09-pid-creation-time-binding",
      "f09-pid-reuse-pressure",
      "f09-uninstall-drain",
      "f09-unrelated-process-safety",
      "f09-update-drain",
    ]),
    conditionalVariants: [],
  },
  {
    rowId: "F-10",
    dependsOnRowIds: ["F-01", "F-02", "F-03", "F-04", "F-05", "F-06"],
    claim:
      "The port-authoritative singleton preserves one writer across Windows contention and stale-state cases.",
    stopCondition:
      "Reject the lock and publication mechanism and block Windows daemon/package claims.",
    requiredVariantIds: sorted([
      "f10-bound-unresponsive-listener",
      "f10-database-writer-sentinel",
      "f10-defender-share-deny",
      "f10-distinct-home-control",
      "f10-foreign-listener",
      "f10-healthy-compatible-peer",
      "f10-kill-after-database-open",
      "f10-kill-after-handshake-publication",
      "f10-kill-after-port-bind",
      "f10-kill-after-port-file-publication",
      "f10-kill-after-temp-hardlink-claim",
      "f10-kill-before-database-open",
      "f10-kill-before-handshake-publication",
      "f10-kill-before-port-bind",
      "f10-kill-before-port-file-publication",
      "f10-kill-before-temp-hardlink-claim",
      "f10-mixed-alias-starter-race",
      "f10-older-protocol-refusal",
      "f10-pid-reuse-pressure",
      "f10-read-only-tooling",
      "f10-second-electron-activation",
      "f10-second-user-acl-refusal",
      "f10-stale-lock-no-listener",
      "f10-stale-port-file",
      "f10-simultaneous-electron-launches",
      "f10-unmanaged-compatible-peer-guidance",
      "f10-newer-protocol-refusal",
    ]),
    conditionalVariants: [],
  },
];

function sortedConditional(values) {
  return [...values].sort((left, right) => compareUtf8(left.variantId, right.variantId));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PROBE_CAMPAIGN_MANIFEST = deepFreeze({
  schemaVersion: PROBE_CONTRACT_SCHEMA_VERSION,
  kind: "windows-host-probe-campaign",
  campaignId: PROBE_CAMPAIGN_ID,
  phase: "probe",
  rowClosureClaimed: false,
  environmentIds: [...PROBE_ENVIRONMENT_IDS],
  pathProfileIds: [...PROBE_PATH_PROFILE_IDS],
  requiredAttestationCapabilities: [...REQUIRED_ATTESTATION_CAPABILITIES],
  parameters: {
    f03PayloadBytes: {
      port: [128, 4096],
      profile: [4096, 262144, 1048576],
      token: [32, 4096],
      vault: [4096, 65536, 1048576],
    },
    f04Race: {
      durationMs: 30000,
      minimumSwapCount: 10000,
      operationWorkers: 8,
      swapWorkers: 4,
    },
    f06Replacement: {
      defenderScanMode: "mpcmdrun-custom",
      maxRetries: 8,
      rapidReaderCount: 16,
      retryBaseDelayMs: 25,
      retryDeadlineMs: 3000,
      retryMaximumDelayMs: 400,
    },
    f07Durability: {
      repetitionsPerHardCutCheckpoint: 5,
    },
    f08UpgradeFence: {
      capabilityBytes: 32,
      connectTimeoutMs: 2000,
      maxFrameBytes: 4096,
      ordinaryStarterCount: 20,
      ownershipSampleIntervalMs: 1,
      raceIterations: 1000,
      readTimeoutMs: 1000,
    },
    f09Lifecycle: {
      forcedTimeoutMs: 5000,
      gracefulTimeoutMs: 5000,
      pidPressureCount: 20000,
      pidPressureDeadlineMs: 120000,
      settleMs: 2000,
    },
    f10Singleton: {
      contentionTimeoutMs: 10000,
      maxRetries: 8,
      raceRounds: 100,
      retryDeadlineMs: 3000,
      starterCount: 32,
    },
  },
  rows,
});

export class ProbeContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeContractError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = []) {
  if (!exactObject(value)) fail("SCHEMA_OBJECT", "expected an object");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("SCHEMA_UNKNOWN_KEY", `unexpected key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("SCHEMA_MISSING_KEY", `missing key: ${key}`);
  }
}

function assertNonemptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("SCHEMA_STRING", `${label} must be a non-empty string`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("SCHEMA_IDENTIFIER", `${label} must be lowercase kebab-case`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("SCHEMA_SHA256", `${label} must be lowercase 64-hex`);
  }
}

function assertStrictTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("SCHEMA_TIMESTAMP", `${label} must be strict UTC ISO with milliseconds`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("SCHEMA_INTEGER", `${label} must be a positive safe integer`);
  }
}

function assertNonnegativeFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("SCHEMA_NUMBER", `${label} must be finite and non-negative`);
  }
}

function assertSortedUniqueStrings(values, label, validator = assertNonemptyString) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("SCHEMA_ARRAY", `${label} must be a non-empty array`);
  }
  let previous = null;
  const folded = new Set();
  for (const [index, value] of values.entries()) {
    validator(value, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, value) >= 0) {
      fail("SCHEMA_ORDER", `${label} must be strictly UTF-8 byte sorted`);
    }
    const key = value.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key)) fail("SCHEMA_CASE_COLLISION", `${label} has a duplicate/case collision`);
    folded.add(key);
    previous = value;
  }
}

function assertSortedUniqueSha256(values, label) {
  if (!Array.isArray(values)) fail("SCHEMA_ARRAY", `${label} must be an array`);
  let previous = null;
  for (const [index, value] of values.entries()) {
    assertSha256(value, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, value) >= 0) {
      fail("SCHEMA_ORDER", `${label} must be strictly sorted and unique`);
    }
    previous = value;
  }
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("CANONICAL_NUMBER", "canonical JSON forbids non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!exactObject(value)) fail("CANONICAL_VALUE", "canonical JSON forbids exotic values");
  const result = {};
  for (const key of Object.keys(value).sort(compareUtf8)) {
    const entry = value[key];
    if (entry === undefined)
      fail("CANONICAL_UNDEFINED", `canonical JSON forbids undefined: ${key}`);
    result[key] = canonicalize(entry);
  }
  return result;
}

export function canonicalProbeJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function hashProbeCanonicalJson(value) {
  return createHash("sha256").update(canonicalProbeJson(value), "utf8").digest("hex");
}

function validateConditionalVariant(value) {
  assertExactKeys(value, ["variantId", "conditionId"]);
  assertIdentifier(value.variantId, "conditionalVariant.variantId");
  assertIdentifier(value.conditionId, "conditionalVariant.conditionId");
}

function validateManifestStructure(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "campaignId",
    "phase",
    "rowClosureClaimed",
    "environmentIds",
    "pathProfileIds",
    "requiredAttestationCapabilities",
    "parameters",
    "rows",
  ]);
  if (!Array.isArray(value.rows)) fail("SCHEMA_ROWS", "manifest.rows must be an array");
  for (const row of value.rows) {
    assertExactKeys(row, [
      "rowId",
      "dependsOnRowIds",
      "claim",
      "stopCondition",
      "requiredVariantIds",
      "conditionalVariants",
    ]);
    if (
      !Array.isArray(row.dependsOnRowIds) ||
      !Array.isArray(row.requiredVariantIds) ||
      !Array.isArray(row.conditionalVariants)
    ) {
      fail("SCHEMA_VARIANTS", "row variant collections must be arrays");
    }
    for (const variant of row.conditionalVariants) validateConditionalVariant(variant);
  }
}

export function validateProbeCampaignManifest(value) {
  validateManifestStructure(value);
  if (canonicalProbeJson(value) !== canonicalProbeJson(PROBE_CAMPAIGN_MANIFEST)) {
    fail(
      "MANIFEST_IMMUTABLE",
      "probe campaign manifest differs from the frozen F-01 through F-10 contract",
    );
  }
  return value;
}

function validateRelativeArtifactPath(value, label) {
  assertNonemptyString(value, label);
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("SCHEMA_ARTIFACT_PATH", `${label} must be a normalized relative slash path`);
  }
  if (value !== value.normalize("NFC")) {
    fail("SCHEMA_UNICODE", `${label} must use NFC normalization`);
  }
}

function validateArtifactHashes(values, label, { nonempty = true } = {}) {
  if (!Array.isArray(values) || (nonempty && values.length === 0)) {
    fail("SCHEMA_ARTIFACTS", `${label} must be ${nonempty ? "a non-empty" : "an"} array`);
  }
  let previous = null;
  const folded = new Set();
  for (const [index, value] of values.entries()) {
    assertExactKeys(value, ["path", "sha256"]);
    validateRelativeArtifactPath(value.path, `${label}[${index}].path`);
    assertSha256(value.sha256, `${label}[${index}].sha256`);
    if (previous !== null && compareUtf8(previous, value.path) >= 0) {
      fail("SCHEMA_ORDER", `${label} must be strictly path sorted`);
    }
    const key = value.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key)) fail("SCHEMA_CASE_COLLISION", `${label} has a duplicate/case collision`);
    folded.add(key);
    previous = value.path;
  }
}

function validatePinnedVersion(value, label, issues) {
  assertNonemptyString(value, label);
  if (forbiddenFloatingVersion.test(value) || !exactVersionPattern.test(value)) {
    issues.push({ code: "UNPINNED_VERSION", detail: label });
  }
}

function candidateDigestPayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    repositoryCommit: value.repositoryCommit,
    sourceHashes: value.sourceHashes,
    binaryHashes: value.binaryHashes,
    compiler: value.compiler,
    toolchain: value.toolchain,
    buildFlags: value.buildFlags,
    referencedAssemblies: value.referencedAssemblies,
    configurationSha256: value.configurationSha256,
  };
}

export function deriveCandidateDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-candidate.v1",
    identity: candidateDigestPayload(value),
  });
}

function inspectCandidateIdentity(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "candidateSha256",
    "repositoryCommit",
    "sourceHashes",
    "binaryHashes",
    "compiler",
    "toolchain",
    "buildFlags",
    "referencedAssemblies",
    "configurationSha256",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-probe-candidate") {
    fail("CANDIDATE_SCHEMA", "candidate schemaVersion/kind is invalid");
  }
  assertSha256(value.candidateSha256, "candidate.candidateSha256");
  if (typeof value.repositoryCommit !== "string" || !commitPattern.test(value.repositoryCommit)) {
    fail("CANDIDATE_COMMIT", "candidate.repositoryCommit must be lowercase 40-hex");
  }
  validateArtifactHashes(value.sourceHashes, "candidate.sourceHashes");
  validateArtifactHashes(value.binaryHashes, "candidate.binaryHashes");
  const combinedPaths = [...value.sourceHashes, ...value.binaryHashes].map((entry) => entry.path);
  const combinedFolded = new Set();
  for (const path of combinedPaths) {
    const folded = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (combinedFolded.has(folded)) {
      fail("CANDIDATE_PATH_COLLISION", "source/binary hashes contain a duplicate/case collision");
    }
    combinedFolded.add(folded);
  }
  assertExactKeys(value.compiler, [
    "provider",
    "codeDomProviderAssemblyVersion",
    "cscFileVersion",
    "cscSha256",
    "outputType",
    "platform",
  ]);
  if (
    value.compiler.provider !== "Microsoft.CSharp.CSharpCodeProvider" ||
    value.compiler.outputType !== "ConsoleApplication" ||
    value.compiler.platform !== "x64"
  ) {
    fail(
      "CANDIDATE_TARGET",
      "candidate must identify the Add-Type C# CodeDOM ConsoleApplication x64 target",
    );
  }
  assertExactKeys(value.toolchain, [
    "nodeVersion",
    "electronVersion",
    "electronBuilderVersion",
    "updaterVersion",
    "nsisVersion",
    "powerShellVersion",
    "powerShellEdition",
    "powerShellExecutableSha256",
    "clrVersion",
    "runtimeDirectorySha256Before",
    "runtimeDirectorySha256After",
    "runtimeRelativeInventory",
  ]);
  assertSortedUniqueStrings(value.buildFlags, "candidate.buildFlags");
  assertSortedUniqueStrings(value.referencedAssemblies, "candidate.referencedAssemblies");
  for (const requiredFlag of ["/platform:x64", "/target:exe"]) {
    if (!value.buildFlags.includes(requiredFlag)) {
      fail("CANDIDATE_COMPILER_FLAGS", `candidate buildFlags lacks ${requiredFlag}`);
    }
  }
  assertSha256(value.configurationSha256, "candidate.configurationSha256");
  assertSha256(value.compiler.cscSha256, "candidate.compiler.cscSha256");
  assertSha256(
    value.toolchain.powerShellExecutableSha256,
    "candidate.toolchain.powerShellExecutableSha256",
  );
  assertSha256(
    value.toolchain.runtimeDirectorySha256Before,
    "candidate.toolchain.runtimeDirectorySha256Before",
  );
  assertSha256(
    value.toolchain.runtimeDirectorySha256After,
    "candidate.toolchain.runtimeDirectorySha256After",
  );
  if (
    value.toolchain.runtimeDirectorySha256Before !== value.toolchain.runtimeDirectorySha256After
  ) {
    fail("CANDIDATE_RUNTIME_CHANGED", "compiler runtime directory changed during compilation");
  }
  assertSortedUniqueStrings(
    value.toolchain.runtimeRelativeInventory,
    "candidate.toolchain.runtimeRelativeInventory",
    validateRelativeArtifactPath,
  );
  if (value.toolchain.powerShellEdition !== "Desktop") {
    fail("CANDIDATE_POWERSHELL", "Add-Type candidate requires Windows PowerShell Desktop edition");
  }
  const pinningIssues = [];
  validatePinnedVersion(
    value.compiler.codeDomProviderAssemblyVersion,
    "candidate.compiler.codeDomProviderAssemblyVersion",
    pinningIssues,
  );
  validatePinnedVersion(
    value.compiler.cscFileVersion,
    "candidate.compiler.cscFileVersion",
    pinningIssues,
  );
  for (const key of [
    "nodeVersion",
    "electronVersion",
    "electronBuilderVersion",
    "updaterVersion",
    "nsisVersion",
    "powerShellVersion",
    "clrVersion",
  ]) {
    validatePinnedVersion(value.toolchain[key], `candidate.toolchain.${key}`, pinningIssues);
  }
  const expectedDigest = deriveCandidateDigest(value);
  if (value.candidateSha256 !== expectedDigest) {
    fail("CANDIDATE_DIGEST", "candidateSha256 does not bind the declared candidate identity");
  }
  return { value, pinningIssues };
}

export function validateProbeCandidateIdentity(value) {
  const inspected = inspectCandidateIdentity(value);
  if (inspected.pinningIssues.length > 0) {
    fail("CANDIDATE_UNPINNED", "candidate compiler/toolchain identity is not fully pinned");
  }
  return inspected.value;
}

function attestationDigestPayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    environmentId: value.environmentId,
    sanitized: value.sanitized,
    host: value.host,
    snapshot: value.snapshot,
    runner: value.runner,
    runtime: value.runtime,
    controller: value.controller,
    capabilities: value.capabilities,
    guestEvidenceByPathProfile: value.guestEvidenceByPathProfile,
    controllerEvidence: value.controllerEvidence,
  };
}

export function deriveLabAttestationDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-11-lab-attestation.v1",
    attestation: attestationDigestPayload(value),
  });
}

export function validateLabAttestation(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "environmentId",
    "attestationSha256",
    "sanitized",
    "host",
    "snapshot",
    "runner",
    "runtime",
    "controller",
    "capabilities",
    "guestEvidenceByPathProfile",
    "controllerEvidence",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "sanitized-windows-11-lab-attestation") {
    fail("ATTESTATION_SCHEMA", "lab attestation schemaVersion/kind is invalid");
  }
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("ATTESTATION_ENVIRONMENT", "lab attestation environmentId is not part of the campaign");
  }
  assertSha256(value.attestationSha256, "attestation.attestationSha256");
  if (value.sanitized !== true) fail("ATTESTATION_SANITIZED", "lab attestation must be sanitized");
  assertExactKeys(value.host, [
    "windowsEdition",
    "osCaption",
    "windowsVersion",
    "osBuild",
    "patchLevel",
    "productType",
    "machineArchitecture",
    "processArchitecture",
    "systemVolumeFileSystem",
    "systemVolumeIdSha256",
    "testVolumeFileSystem",
    "testVolumeIdSha256",
    "standardUserSidSha256",
    "elevated",
    "defenderRealtimeEnabled",
    "uacDefault",
    "developerModeEnabled",
  ]);
  for (const key of [
    "windowsEdition",
    "osCaption",
    "windowsVersion",
    "osBuild",
    "patchLevel",
    "productType",
  ]) {
    assertNonemptyString(value.host[key], `attestation.host.${key}`);
  }
  if (
    !/^Windows 11 (?:Home|Pro)$/u.test(value.host.windowsEdition) ||
    !/Windows 11/iu.test(value.host.osCaption) ||
    !/^\d{2}H[12]$/u.test(value.host.windowsVersion) ||
    !/^\d{5,}$/u.test(value.host.osBuild) ||
    Number(value.host.osBuild) < 22000 ||
    value.host.productType !== "workstation" ||
    value.host.machineArchitecture !== "x64" ||
    value.host.processArchitecture !== "x64" ||
    value.host.systemVolumeFileSystem !== "NTFS" ||
    value.host.testVolumeFileSystem !== "NTFS" ||
    value.host.elevated !== false ||
    value.host.defenderRealtimeEnabled !== true ||
    value.host.uacDefault !== true ||
    value.host.developerModeEnabled !== false
  ) {
    fail("ATTESTATION_HOST_POSTURE", "lab attestation host posture is not authoritative");
  }
  for (const key of ["systemVolumeIdSha256", "testVolumeIdSha256", "standardUserSidSha256"]) {
    assertSha256(value.host[key], `attestation.host.${key}`);
  }
  if (value.host.systemVolumeIdSha256 === value.host.testVolumeIdSha256) {
    fail("ATTESTATION_VOLUME_IDENTITY", "system and test volumes must be distinct");
  }
  assertExactKeys(value.snapshot, [
    "vmImageId",
    "vmImageSha256",
    "vmSnapshotId",
    "cleanImageVersion",
  ]);
  assertIdentifier(value.snapshot.vmImageId, "attestation.snapshot.vmImageId");
  assertSha256(value.snapshot.vmImageSha256, "attestation.snapshot.vmImageSha256");
  assertIdentifier(value.snapshot.vmSnapshotId, "attestation.snapshot.vmSnapshotId");
  assertNonemptyString(value.snapshot.cleanImageVersion, "attestation.snapshot.cleanImageVersion");
  assertExactKeys(value.runner, ["version", "labels", "interactiveSessionOwnerSidSha256"]);
  const runnerPinningIssues = [];
  validatePinnedVersion(value.runner.version, "attestation.runner.version", runnerPinningIssues);
  if (runnerPinningIssues.length > 0) {
    fail("ATTESTATION_RUNNER_VERSION", "lab runner version must be exact and pinned");
  }
  assertSortedUniqueStrings(value.runner.labels, "attestation.runner.labels", assertIdentifier);
  for (const requiredLabel of [
    "self-hosted",
    "windows",
    "x64",
    "windows-11",
    "enduragent-falsifier",
    value.environmentId,
  ]) {
    if (!value.runner.labels.includes(requiredLabel)) {
      fail("ATTESTATION_RUNNER_LABEL", `attestation runner lacks ${requiredLabel}`);
    }
  }
  assertSha256(
    value.runner.interactiveSessionOwnerSidSha256,
    "attestation.runner.interactiveSessionOwnerSidSha256",
  );
  if (value.runner.interactiveSessionOwnerSidSha256 !== value.host.standardUserSidSha256) {
    fail("ATTESTATION_SESSION_OWNER", "runner session owner must be the attested standard user");
  }
  assertExactKeys(value.runtime, [
    "nodeVersion",
    "powerShellVersion",
    "powerShellEdition",
    "powerShellExecutableSha256",
    "clrVersion",
    "electronVersion",
    "electronBuilderVersion",
    "updaterVersion",
    "nsisVersion",
    "nsisExecutableSha256",
  ]);
  const runtimePinningIssues = [];
  for (const key of [
    "nodeVersion",
    "powerShellVersion",
    "clrVersion",
    "electronVersion",
    "electronBuilderVersion",
    "updaterVersion",
    "nsisVersion",
  ]) {
    validatePinnedVersion(value.runtime[key], `attestation.runtime.${key}`, runtimePinningIssues);
  }
  if (value.runtime.powerShellEdition !== "Desktop" || runtimePinningIssues.length > 0) {
    fail("ATTESTATION_RUNTIME", "attested VM runtime must be exact and pinned");
  }
  for (const key of ["powerShellExecutableSha256", "nsisExecutableSha256"]) {
    assertSha256(value.runtime[key], `attestation.runtime.${key}`);
  }
  assertExactKeys(value.controller, [
    "identitySha256",
    "publicKeySha256",
    "publicKeyArtifact",
    "version",
  ]);
  assertSha256(value.controller.identitySha256, "attestation.controller.identitySha256");
  assertSha256(value.controller.publicKeySha256, "attestation.controller.publicKeySha256");
  assertExactKeys(value.controller.publicKeyArtifact, ["path", "sha256"]);
  validateRelativeArtifactPath(
    value.controller.publicKeyArtifact.path,
    "attestation.controller.publicKeyArtifact.path",
  );
  assertSha256(
    value.controller.publicKeyArtifact.sha256,
    "attestation.controller.publicKeyArtifact.sha256",
  );
  if (value.controller.publicKeyArtifact.sha256 !== value.controller.publicKeySha256) {
    fail(
      "ATTESTATION_CONTROLLER_KEY",
      "controller public-key artifact must bind the attested public-key bytes",
    );
  }
  const controllerPinningIssues = [];
  validatePinnedVersion(
    value.controller.version,
    "attestation.controller.version",
    controllerPinningIssues,
  );
  if (controllerPinningIssues.length > 0) {
    fail("ATTESTATION_CONTROLLER", "attested controller version must be exact and pinned");
  }
  assertExactKeys(value.capabilities, REQUIRED_ATTESTATION_CAPABILITIES);
  for (const capability of REQUIRED_ATTESTATION_CAPABILITIES) {
    if (typeof value.capabilities[capability] !== "boolean") {
      fail("ATTESTATION_CAPABILITY", `attestation capability ${capability} must be boolean`);
    }
  }
  if (
    !Array.isArray(value.guestEvidenceByPathProfile) ||
    value.guestEvidenceByPathProfile.length !== PROBE_PATH_PROFILE_IDS.length
  ) {
    fail(
      "ATTESTATION_GUEST_EVIDENCE",
      "lab attestation must bind exactly one guest evidence artifact per path profile",
    );
  }
  const expectedPathProfileIds = [...PROBE_PATH_PROFILE_IDS].sort(compareUtf8);
  const guestEvidencePaths = new Set();
  const guestEvidenceDigests = new Set();
  for (const [index, entry] of value.guestEvidenceByPathProfile.entries()) {
    const label = "attestation.guestEvidenceByPathProfile[" + index + "]";
    assertExactKeys(entry, ["pathProfileId", "artifact"]);
    if (entry.pathProfileId !== expectedPathProfileIds[index]) {
      fail(
        "ATTESTATION_GUEST_EVIDENCE",
        "guest evidence path profiles must be complete, exact, and UTF-8 byte sorted",
      );
    }
    assertExactKeys(entry.artifact, ["path", "sha256"]);
    validateRelativeArtifactPath(entry.artifact.path, label + ".artifact.path");
    assertSha256(entry.artifact.sha256, label + ".artifact.sha256");
    const foldedPath = entry.artifact.path.toLocaleLowerCase("en-US");
    if (guestEvidencePaths.has(foldedPath) || guestEvidenceDigests.has(entry.artifact.sha256)) {
      fail("ATTESTATION_GUEST_EVIDENCE", "each path profile must retain distinct guest evidence");
    }
    guestEvidencePaths.add(foldedPath);
    guestEvidenceDigests.add(entry.artifact.sha256);
  }
  assertExactKeys(value.controllerEvidence, ["path", "sha256"]);
  validateRelativeArtifactPath(
    value.controllerEvidence.path,
    "attestation.controllerEvidence.path",
  );
  assertSha256(value.controllerEvidence.sha256, "attestation.controllerEvidence.sha256");
  if (
    guestEvidencePaths.has(value.controllerEvidence.path.toLocaleLowerCase("en-US")) ||
    guestEvidenceDigests.has(value.controllerEvidence.sha256)
  ) {
    fail("ATTESTATION_EVIDENCE", "guest and controller evidence must be separately retained");
  }
  if (value.attestationSha256 !== deriveLabAttestationDigest(value)) {
    fail("ATTESTATION_DIGEST", "attestationSha256 does not bind the sanitized attestation payload");
  }
  return value;
}

function validateObservation(value, artifactPaths) {
  assertExactKeys(value, ["step", "expected", "actual", "evidenceRef"]);
  assertIdentifier(value.step, "observation.step");
  assertNonemptyString(value.expected, "observation.expected");
  assertNonemptyString(value.actual, "observation.actual");
  validateRelativeArtifactPath(value.evidenceRef, "observation.evidenceRef");
  if (!artifactPaths.has(value.evidenceRef)) {
    fail("SEGMENT_EVIDENCE_REF", "observation.evidenceRef is not bound by artifactHashes");
  }
}

function validateVerificationMetrics(values) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("SEGMENT_METRICS", "verificationMetrics must be a non-empty array");
  }
  let previousName = null;
  for (const [index, metric] of values.entries()) {
    assertExactKeys(metric, ["name", "unit", "value"]);
    assertIdentifier(metric.name, `verificationMetrics[${index}].name`);
    assertIdentifier(metric.unit, `verificationMetrics[${index}].unit`);
    if (
      (typeof metric.value !== "string" &&
        typeof metric.value !== "number" &&
        typeof metric.value !== "boolean") ||
      (typeof metric.value === "number" && !Number.isFinite(metric.value)) ||
      (typeof metric.value === "string" && metric.value.length === 0)
    ) {
      fail("SEGMENT_METRIC_VALUE", `verificationMetrics[${index}].value is invalid`);
    }
    if (previousName !== null && compareUtf8(previousName, metric.name) >= 0) {
      fail("SEGMENT_METRIC_ORDER", "verification metrics must be strictly name sorted");
    }
    previousName = metric.name;
  }
}

function manifestVariantIndex() {
  const index = new Map();
  for (const row of PROBE_CAMPAIGN_MANIFEST.rows) {
    for (const variantId of row.requiredVariantIds) {
      index.set(`${row.rowId}\0${variantId}`, { availability: "required", conditionId: null });
    }
    for (const variant of row.conditionalVariants) {
      index.set(`${row.rowId}\0${variant.variantId}`, {
        availability: "conditional",
        conditionId: variant.conditionId,
      });
    }
  }
  return index;
}

const VARIANT_INDEX = manifestVariantIndex();
const MANIFEST_SHA256 = hashProbeCanonicalJson(PROBE_CAMPAIGN_MANIFEST);

function segmentDigestPayload(value) {
  const { segmentSha256: _segmentSha256, ...payload } = value;
  return payload;
}

export function deriveProbeSegmentDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-segment.v1",
    segment: segmentDigestPayload(value),
  });
}

export function deriveProbeOutcomeEvidenceDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-outcome-evidence.v1",
    outcome: value.outcome,
    observations: value.observations,
    artifactHashes: value.artifactHashes,
    unavailability: value.unavailability,
    verifierId: value.verifierId,
    verifierSourceSha256: value.verifierSourceSha256,
    verificationInputSha256: value.verificationInputSha256,
  });
}

export function deriveProbeVerificationInputDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-verification-input.v1",
    campaignId: value.campaignId,
    manifestSha256: value.manifestSha256,
    candidateSha256: value.candidateSha256,
    environmentId: value.environmentId,
    pathProfileId: value.pathProfileId,
    rowId: value.rowId,
    variantId: value.variantId,
    artifactHashes: value.artifactHashes,
    metrics: value.verificationMetrics,
    verifierId: value.verifierId,
    verifierSourceSha256: value.verifierSourceSha256,
  });
}

export function deriveProbeRowVerificationInputDigest(rowId, inputDigests) {
  assertSortedUniqueSha256(inputDigests, "row verification input digests");
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-row-verification-input.v1",
    rowId,
    inputDigests,
  });
}

export function deriveProbeRowEvidenceDigest(value) {
  if (!PROBE_CAMPAIGN_MANIFEST.rows.some((row) => row.rowId === value.rowId)) {
    fail("ROW_EVIDENCE_ROW", "row evidence rowId is not in the campaign manifest");
  }
  assertSortedUniqueSha256(value.terminalSegmentDigests, "row terminal segment digests");
  assertSortedUniqueSha256(value.attestationDigests, "row attestation digests");
  assertSortedUniqueSha256(
    value.executionBundleManifestDigests,
    "row execution-bundle manifest digests",
  );
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-row-evidence.v1",
    rowId: value.rowId,
    terminalSegmentDigests: value.terminalSegmentDigests,
    attestationDigests: value.attestationDigests,
    executionBundleManifestDigests: value.executionBundleManifestDigests,
  });
}

export function deriveProbeSelectionDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-selection.v1",
    rowId: value.rowId,
    candidateSha256: value.candidateSha256,
    mechanismId: value.mechanismId,
    mechanismDefinitionSha256: value.mechanismDefinitionSha256,
    upstreamSelectionDigests: value.upstreamSelectionDigests,
    verifierBindings: value.verifierBindings,
    verificationInputSha256: value.verificationInputSha256,
    rowEvidenceSha256: value.rowEvidenceSha256,
  });
}

export function deriveProbeContinuationScopeDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-continuation-scope.v1",
    campaignId: value.campaignId,
    manifestSha256: value.manifestSha256,
    candidateSha256: value.candidateSha256,
    campaignRunId: value.campaignRunId,
    executionRunId: value.executionRunId,
    executionBundleId: value.executionBundleId,
    executionBundleManifestSha256: value.executionBundleManifestSha256,
    environmentId: value.environmentId,
    pathProfileId: value.pathProfileId,
    rowId: value.rowId,
    variantId: value.variantId,
    attemptId: value.attemptId,
    repetition: value.repetition,
    chainId: value.chainId,
  });
}

function externalCheckpointRequestPayload(value) {
  const { requestSha256: _requestSha256, signatureBase64: _signatureBase64, ...payload } = value;
  return payload;
}

function externalCheckpointReceiptPayload(value) {
  const { receiptSha256: _receiptSha256, signatureBase64: _signatureBase64, ...payload } = value;
  return payload;
}

export function deriveExternalCheckpointRequestDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-hard-cut-request.v1",
    request: externalCheckpointRequestPayload(value),
  });
}

export function deriveExternalCheckpointReceiptDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-hard-cut-receipt.v1",
    receipt: externalCheckpointReceiptPayload(value),
  });
}

function decodeCanonicalBase64(value, label) {
  assertNonemptyString(value, label);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("SCHEMA_BASE64", `${label} must be canonical padded base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    fail("SCHEMA_BASE64", `${label} must be canonical padded base64`);
  }
  return decoded;
}

export function verifyExternalCheckpointReceiptSignature(receipt, controllerPublicKeyBytes) {
  if (
    !(controllerPublicKeyBytes instanceof Uint8Array) ||
    controllerPublicKeyBytes.byteLength === 0
  ) {
    fail(
      "SEGMENT_CHECKPOINT_PUBLIC_KEY",
      "receipt verification requires non-empty controller public-key bytes",
    );
  }
  if (receipt.signatureAlgorithm !== "Ed25519") {
    fail("SEGMENT_CHECKPOINT_SIGNATURE", "hard-cut receipt requires an Ed25519 signature");
  }
  assertSha256(receipt.controllerPublicKeySha256, "checkpoint.receipt.controllerPublicKeySha256");
  assertSha256(receipt.receiptSha256, "checkpoint.receipt.receiptSha256");
  if (receipt.receiptSha256 !== deriveExternalCheckpointReceiptDigest(receipt)) {
    fail("SEGMENT_CHECKPOINT_RECEIPT_DIGEST", "hard-cut receipt digest mismatch");
  }
  const publicKeyBytes = Buffer.from(
    controllerPublicKeyBytes.buffer,
    controllerPublicKeyBytes.byteOffset,
    controllerPublicKeyBytes.byteLength,
  );
  if (
    createHash("sha256").update(publicKeyBytes).digest("hex") !== receipt.controllerPublicKeySha256
  ) {
    fail(
      "SEGMENT_CHECKPOINT_PUBLIC_KEY",
      "controller public-key bytes do not match the attested public-key digest",
    );
  }
  const signature = decodeCanonicalBase64(
    receipt.signatureBase64,
    "checkpoint.receipt.signatureBase64",
  );
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  } catch {
    fail(
      "SEGMENT_CHECKPOINT_PUBLIC_KEY",
      "controller public-key bytes must be an Ed25519 SPKI DER document",
    );
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("SEGMENT_CHECKPOINT_PUBLIC_KEY", "controller public key must be Ed25519");
  }
  if (!verify(null, Buffer.from(receipt.receiptSha256, "hex"), publicKey, signature)) {
    fail("SEGMENT_CHECKPOINT_SIGNATURE", "hard-cut receipt signature verification failed");
  }
  return receipt;
}

export function verifyExternalCheckpointRequestSignature(request, controllerPublicKeyBytes) {
  if (
    !(controllerPublicKeyBytes instanceof Uint8Array) ||
    controllerPublicKeyBytes.byteLength === 0
  ) {
    fail(
      "SEGMENT_CHECKPOINT_PUBLIC_KEY",
      "request verification requires non-empty controller public-key bytes",
    );
  }
  if (request.signatureAlgorithm !== "Ed25519") {
    fail("SEGMENT_CHECKPOINT_SIGNATURE", "hard-cut request requires an Ed25519 signature");
  }
  assertSha256(request.controllerPublicKeySha256, "checkpoint.request.controllerPublicKeySha256");
  assertSha256(request.requestSha256, "checkpoint.request.requestSha256");
  if (request.requestSha256 !== deriveExternalCheckpointRequestDigest(request)) {
    fail("SEGMENT_CHECKPOINT_REQUEST_DIGEST", "hard-cut request digest mismatch");
  }
  const publicKeyBytes = Buffer.from(
    controllerPublicKeyBytes.buffer,
    controllerPublicKeyBytes.byteOffset,
    controllerPublicKeyBytes.byteLength,
  );
  if (
    createHash("sha256").update(publicKeyBytes).digest("hex") !== request.controllerPublicKeySha256
  ) {
    fail(
      "SEGMENT_CHECKPOINT_PUBLIC_KEY",
      "controller public-key bytes do not match the attested public-key digest",
    );
  }
  const signature = decodeCanonicalBase64(
    request.signatureBase64,
    "checkpoint.request.signatureBase64",
  );
  let publicKey;
  try {
    publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  } catch {
    fail(
      "SEGMENT_CHECKPOINT_PUBLIC_KEY",
      "controller public-key bytes must be an Ed25519 SPKI DER document",
    );
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("SEGMENT_CHECKPOINT_PUBLIC_KEY", "controller public key must be Ed25519");
  }
  if (!verify(null, Buffer.from(request.requestSha256, "hex"), publicKey, signature)) {
    fail("SEGMENT_CHECKPOINT_SIGNATURE", "hard-cut request signature verification failed");
  }
  return request;
}

export function createExternalCheckpointReplayRegistry() {
  return {
    nonces: new Set(),
    requests: new Set(),
    receipts: new Set(),
  };
}

export function validateExternalCheckpointEvidence(
  pair,
  {
    segment,
    continuation,
    repetition,
    replayRegistry,
    expectedController = null,
    controllerPublicKeyBytes = null,
    expectedPreCutBootIdSha256 = null,
  },
) {
  if (
    !exactObject(replayRegistry) ||
    !(replayRegistry.nonces instanceof Set) ||
    !(replayRegistry.requests instanceof Set) ||
    !(replayRegistry.receipts instanceof Set)
  ) {
    fail("SEGMENT_CHECKPOINT_REGISTRY", "checkpoint validation requires a replay registry");
  }
  if (expectedPreCutBootIdSha256 !== null) {
    assertSha256(expectedPreCutBootIdSha256, "checkpoint.expectedPreCutBootIdSha256");
  }
  assertExactKeys(pair, ["request", "receipt"]);
  const request = pair.request;
  assertExactKeys(request, [
    "schemaVersion",
    "kind",
    "campaignId",
    "manifestSha256",
    "candidateSha256",
    "campaignRunId",
    "executionRunId",
    "executionBundleId",
    "executionBundleManifestSha256",
    "attemptId",
    "environmentId",
    "pathProfileId",
    "rowId",
    "variantId",
    "checkpointId",
    "sequence",
    "nonceSha256",
    "preCutStateSha256",
    "preCutBootIdSha256",
    "sourceVmSnapshotId",
    "continuationScopeSha256",
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "controllerVersion",
    "action",
    "signatureAlgorithm",
    "signatureBase64",
    "requestSha256",
  ]);
  if (
    request.schemaVersion !== 1 ||
    request.kind !== "windows-host-probe-hard-cut-request" ||
    request.campaignId !== segment.campaignId ||
    request.manifestSha256 !== segment.manifestSha256 ||
    request.candidateSha256 !== segment.candidateSha256 ||
    request.campaignRunId !== segment.provenance.campaignRunId ||
    request.executionRunId !== segment.provenance.executionRunId ||
    request.executionBundleId !== segment.provenance.executionBundleId ||
    request.executionBundleManifestSha256 !== segment.provenance.executionBundleManifestSha256 ||
    request.attemptId !== segment.provenance.attemptId ||
    request.environmentId !== segment.environmentId ||
    request.pathProfileId !== segment.pathProfileId ||
    request.rowId !== segment.rowId ||
    request.variantId !== segment.variantId ||
    request.sequence !== repetition ||
    request.sourceVmSnapshotId !== segment.provenance.vmSnapshotId ||
    request.continuationScopeSha256 !== continuation.scopeSha256 ||
    request.action !== "hard-power-cut"
  ) {
    fail("SEGMENT_CHECKPOINT_REQUEST", "hard-cut request is bound to different evidence");
  }
  assertIdentifier(request.checkpointId, "checkpoint.request.checkpointId");
  assertPositiveInteger(request.sequence, "checkpoint.request.sequence");
  assertIdentifier(request.executionRunId, "checkpoint.request.executionRunId");
  assertIdentifier(request.executionBundleId, "checkpoint.request.executionBundleId");
  for (const key of [
    "nonceSha256",
    "preCutStateSha256",
    "preCutBootIdSha256",
    "executionBundleManifestSha256",
    "continuationScopeSha256",
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "requestSha256",
  ]) {
    assertSha256(request[key], `checkpoint.request.${key}`);
  }
  if (
    expectedController !== null &&
    (request.controllerIdentitySha256 !== expectedController.identitySha256 ||
      request.controllerPublicKeySha256 !== expectedController.publicKeySha256 ||
      request.controllerVersion !== expectedController.version)
  ) {
    fail("SEGMENT_CHECKPOINT_CONTROLLER", "hard-cut request uses another controller identity");
  }
  const controllerVersionIssues = [];
  validatePinnedVersion(
    request.controllerVersion,
    "checkpoint.request.controllerVersion",
    controllerVersionIssues,
  );
  if (controllerVersionIssues.length > 0) {
    fail("SEGMENT_CHECKPOINT_CONTROLLER", "hard-cut controller version must be pinned");
  }
  if (request.requestSha256 !== deriveExternalCheckpointRequestDigest(request)) {
    fail("SEGMENT_CHECKPOINT_REQUEST_DIGEST", "hard-cut request digest mismatch");
  }
  if (request.signatureAlgorithm !== "Ed25519") {
    fail("SEGMENT_CHECKPOINT_SIGNATURE", "hard-cut request requires an Ed25519 signature");
  }
  decodeCanonicalBase64(request.signatureBase64, "checkpoint.request.signatureBase64");
  if (
    expectedPreCutBootIdSha256 !== null &&
    request.preCutBootIdSha256 !== expectedPreCutBootIdSha256
  ) {
    fail(
      "SEGMENT_CHECKPOINT_BOOT_CHAIN",
      "hard-cut request pre-cut boot identity breaks the segment boot chain",
    );
  }
  if (controllerPublicKeyBytes !== null) {
    verifyExternalCheckpointRequestSignature(request, controllerPublicKeyBytes);
  }

  const receipt = pair.receipt;
  assertExactKeys(receipt, [
    "schemaVersion",
    "kind",
    "requestSha256",
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "controllerVersion",
    "action",
    "powerCutAt",
    "bootStartedAt",
    "bootCompletedAt",
    "postBootVmSnapshotId",
    "preCutBootIdSha256",
    "postBootBootIdSha256",
    "artifactHashes",
    "signatureAlgorithm",
    "signatureBase64",
    "receiptSha256",
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "windows-host-probe-hard-cut-receipt" ||
    receipt.requestSha256 !== request.requestSha256 ||
    receipt.controllerIdentitySha256 !== request.controllerIdentitySha256 ||
    receipt.controllerPublicKeySha256 !== request.controllerPublicKeySha256 ||
    receipt.controllerVersion !== request.controllerVersion ||
    receipt.action !== request.action ||
    receipt.preCutBootIdSha256 !== request.preCutBootIdSha256
  ) {
    fail("SEGMENT_CHECKPOINT_RECEIPT", "hard-cut receipt does not answer its request");
  }
  for (const key of [
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "preCutBootIdSha256",
    "postBootBootIdSha256",
    "receiptSha256",
  ]) {
    assertSha256(receipt[key], `checkpoint.receipt.${key}`);
  }
  for (const key of ["powerCutAt", "bootStartedAt", "bootCompletedAt"]) {
    assertStrictTimestamp(receipt[key], `checkpoint.receipt.${key}`);
  }
  if (
    Date.parse(receipt.bootStartedAt) < Date.parse(receipt.powerCutAt) ||
    Date.parse(receipt.bootCompletedAt) < Date.parse(receipt.bootStartedAt)
  ) {
    fail("SEGMENT_CHECKPOINT_TIME", "hard-cut and boot timestamps are out of order");
  }
  if (receipt.postBootBootIdSha256 === receipt.preCutBootIdSha256) {
    fail(
      "SEGMENT_CHECKPOINT_BOOT_TRANSITION",
      "hard-cut receipt must prove a different post-boot identity",
    );
  }
  assertIdentifier(receipt.postBootVmSnapshotId, "checkpoint.receipt.postBootVmSnapshotId");
  validateArtifactHashes(receipt.artifactHashes, "checkpoint.receipt.artifactHashes");
  if (receipt.signatureAlgorithm !== "Ed25519") {
    fail("SEGMENT_CHECKPOINT_SIGNATURE", "hard-cut receipt requires an Ed25519 signature");
  }
  decodeCanonicalBase64(receipt.signatureBase64, "checkpoint.receipt.signatureBase64");
  if (receipt.receiptSha256 !== deriveExternalCheckpointReceiptDigest(receipt)) {
    fail("SEGMENT_CHECKPOINT_RECEIPT_DIGEST", "hard-cut receipt digest mismatch");
  }
  if (controllerPublicKeyBytes !== null) {
    verifyExternalCheckpointReceiptSignature(receipt, controllerPublicKeyBytes);
  }
  if (continuation.receiptSha256 !== receipt.receiptSha256) {
    fail("SEGMENT_CHECKPOINT_CONTINUATION", "continuation does not bind the hard-cut receipt");
  }
  for (const [set, digest] of [
    [replayRegistry.nonces, request.nonceSha256],
    [replayRegistry.requests, request.requestSha256],
    [replayRegistry.receipts, receipt.receiptSha256],
  ]) {
    if (set.has(digest)) {
      fail("SEGMENT_CHECKPOINT_REPLAY", "hard-cut request or receipt was replayed");
    }
  }
  replayRegistry.nonces.add(request.nonceSha256);
  replayRegistry.requests.add(request.requestSha256);
  replayRegistry.receipts.add(receipt.receiptSha256);
  return pair;
}

export function validateProbeSegmentRecord(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "campaignId",
    "manifestSha256",
    "candidateSha256",
    "labAttestationSha256",
    "environmentId",
    "pathProfileId",
    "rowId",
    "variantId",
    "phase",
    "outcome",
    "mechanismId",
    "mechanismDefinitionSha256",
    "upstreamSelectionDigests",
    "verifierId",
    "verifierSourceSha256",
    "verificationMetrics",
    "verificationInputSha256",
    "outcomeEvidenceSha256",
    "observations",
    "artifactHashes",
    "unavailability",
    "provenance",
    "continuations",
    "segmentSha256",
    "rowClosureClaimed",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-probe-segment") {
    fail("SEGMENT_SCHEMA", "segment schemaVersion/kind is invalid");
  }
  if (value.campaignId !== PROBE_CAMPAIGN_ID || value.manifestSha256 !== MANIFEST_SHA256) {
    fail("SEGMENT_MANIFEST", "segment is not bound to the frozen campaign manifest");
  }
  assertSha256(value.candidateSha256, "segment.candidateSha256");
  assertSha256(value.labAttestationSha256, "segment.labAttestationSha256");
  if (!PROBE_ENVIRONMENT_IDS.includes(value.environmentId)) {
    fail("SEGMENT_ENVIRONMENT", "segment environmentId is not part of the campaign");
  }
  if (!PROBE_PATH_PROFILE_IDS.includes(value.pathProfileId)) {
    fail("SEGMENT_PATH_PROFILE", "segment pathProfileId is not part of the campaign");
  }
  const variant = VARIANT_INDEX.get(`${value.rowId}\0${value.variantId}`);
  if (variant === undefined)
    fail("SEGMENT_VARIANT", "segment rowId/variantId is not in the manifest");
  if (value.phase !== "probe") fail("SEGMENT_PHASE", "PR-01b segment phase must be probe");
  if (!PROBE_SEGMENT_OUTCOMES.includes(value.outcome)) {
    fail("SEGMENT_OUTCOME", "segment outcome is invalid");
  }
  assertIdentifier(value.mechanismId, "segment.mechanismId");
  assertSha256(value.mechanismDefinitionSha256, "segment.mechanismDefinitionSha256");
  assertSortedUniqueSha256(value.upstreamSelectionDigests, "segment.upstreamSelectionDigests");
  const expectedVerifierId = value.variantId.startsWith("f07-hard-cut-")
    ? "hard-cut-probe-verifier-v1"
    : "native-probe-verifier-v1";
  if (value.verifierId !== expectedVerifierId || !PROBE_VERIFIER_IDS.includes(value.verifierId)) {
    fail("SEGMENT_VERIFIER", `segment requires allowlisted verifier ${expectedVerifierId}`);
  }
  assertSha256(value.verifierSourceSha256, "segment.verifierSourceSha256");
  validateVerificationMetrics(value.verificationMetrics);
  assertSha256(value.verificationInputSha256, "segment.verificationInputSha256");
  assertSha256(value.outcomeEvidenceSha256, "segment.outcomeEvidenceSha256");
  if (value.rowClosureClaimed !== false) {
    fail("SEGMENT_ROW_CLOSURE", "probe evidence cannot claim F-row closure");
  }
  assertExactKeys(value.provenance, [
    "campaignRunId",
    "executionRunId",
    "executionBundleId",
    "executionBundleManifestSha256",
    "attemptId",
    "startedAt",
    "endedAt",
    "monotonicDurationMs",
    "vmSnapshotId",
    "bootIdSha256",
    "externalCheckpoints",
  ]);
  assertIdentifier(value.provenance.campaignRunId, "segment.provenance.campaignRunId");
  assertIdentifier(value.provenance.executionRunId, "segment.provenance.executionRunId");
  assertIdentifier(value.provenance.executionBundleId, "segment.provenance.executionBundleId");
  assertSha256(
    value.provenance.executionBundleManifestSha256,
    "segment.provenance.executionBundleManifestSha256",
  );
  assertIdentifier(value.provenance.attemptId, "segment.provenance.attemptId");
  assertStrictTimestamp(value.provenance.startedAt, "segment.provenance.startedAt");
  assertStrictTimestamp(value.provenance.endedAt, "segment.provenance.endedAt");
  if (Date.parse(value.provenance.endedAt) < Date.parse(value.provenance.startedAt)) {
    fail("SEGMENT_TIME_ORDER", "segment provenance ends before it starts");
  }
  assertNonnegativeFinite(
    value.provenance.monotonicDurationMs,
    "segment.provenance.monotonicDurationMs",
  );
  assertIdentifier(value.provenance.vmSnapshotId, "segment.provenance.vmSnapshotId");
  assertSha256(value.provenance.bootIdSha256, "segment.provenance.bootIdSha256");
  const requiresExternalReceipt = value.variantId.startsWith("f07-hard-cut-");
  const expectedRepetitions = requiresExternalReceipt
    ? PROBE_CAMPAIGN_MANIFEST.parameters.f07Durability.repetitionsPerHardCutCheckpoint
    : 1;
  if (
    !Array.isArray(value.provenance.externalCheckpoints) ||
    value.provenance.externalCheckpoints.length !==
      (requiresExternalReceipt ? expectedRepetitions : 0)
  ) {
    fail(
      "SEGMENT_CHECKPOINT_RECEIPT",
      `segment requires exactly ${requiresExternalReceipt ? expectedRepetitions : 0} external checkpoints`,
    );
  }
  if (!Array.isArray(value.continuations) || value.continuations.length !== expectedRepetitions) {
    fail(
      "SEGMENT_CONTINUATIONS",
      `segment requires exactly ${expectedRepetitions} independent continuation references`,
    );
  }
  const continuationScopes = new Set();
  const checkpointReplayRegistry = createExternalCheckpointReplayRegistry();
  let expectedPreCutBootIdSha256 = value.provenance.bootIdSha256;
  for (let index = 0; index < expectedRepetitions; index += 1) {
    const repetition = index + 1;
    const continuation = value.continuations[index];
    assertExactKeys(continuation, [
      "repetition",
      "chainId",
      "scopeSha256",
      "headerSha256",
      "terminalEntrySha256",
      "receiptSha256",
    ]);
    if (continuation.repetition !== repetition) {
      fail(
        "SEGMENT_CONTINUATION_REPETITION",
        "continuation repetitions must be complete and ordered",
      );
    }
    assertPositiveInteger(continuation.repetition, "segment.continuation.repetition");
    assertIdentifier(continuation.chainId, "segment.continuation.chainId");
    for (const key of ["scopeSha256", "headerSha256", "terminalEntrySha256", "receiptSha256"]) {
      assertSha256(continuation[key], `segment.continuation.${key}`);
    }
    const expectedScope = deriveProbeContinuationScopeDigest({
      campaignId: value.campaignId,
      manifestSha256: value.manifestSha256,
      candidateSha256: value.candidateSha256,
      campaignRunId: value.provenance.campaignRunId,
      executionRunId: value.provenance.executionRunId,
      executionBundleId: value.provenance.executionBundleId,
      executionBundleManifestSha256: value.provenance.executionBundleManifestSha256,
      environmentId: value.environmentId,
      pathProfileId: value.pathProfileId,
      rowId: value.rowId,
      variantId: value.variantId,
      attemptId: value.provenance.attemptId,
      repetition,
      chainId: continuation.chainId,
    });
    if (continuation.scopeSha256 !== expectedScope || continuationScopes.has(expectedScope)) {
      fail("SEGMENT_CONTINUATION_SCOPE", "continuation scope is mismatched or replayed");
    }
    continuationScopes.add(expectedScope);
    if (requiresExternalReceipt) {
      validateExternalCheckpointEvidence(value.provenance.externalCheckpoints[index], {
        segment: value,
        continuation,
        repetition,
        replayRegistry: checkpointReplayRegistry,
        expectedPreCutBootIdSha256,
      });
      expectedPreCutBootIdSha256 =
        value.provenance.externalCheckpoints[index].receipt.postBootBootIdSha256;
    }
  }
  assertSha256(value.segmentSha256, "segment.segmentSha256");
  if (value.segmentSha256 !== deriveProbeSegmentDigest(value)) {
    fail("SEGMENT_DIGEST", "segmentSha256 does not bind the per-variant evidence record");
  }
  validateArtifactHashes(value.artifactHashes, "segment.artifactHashes");
  if (!value.artifactHashes.some((entry) => entry.sha256 === value.mechanismDefinitionSha256)) {
    fail(
      "SEGMENT_MECHANISM_DEFINITION",
      "mechanismDefinitionSha256 must identify a retained segment artifact",
    );
  }
  if (!value.artifactHashes.some((entry) => entry.sha256 === value.verifierSourceSha256)) {
    fail("SEGMENT_VERIFIER_SOURCE", "verifierSourceSha256 must identify a retained artifact");
  }
  if (value.verificationInputSha256 !== deriveProbeVerificationInputDigest(value)) {
    fail("SEGMENT_VERIFICATION_INPUT", "verification input digest mismatch");
  }
  const artifactPaths = new Set(value.artifactHashes.map((entry) => entry.path));
  if (!Array.isArray(value.observations) || value.observations.length === 0) {
    fail("SEGMENT_OBSERVATIONS", "segment observations must be non-empty");
  }
  const steps = new Set();
  for (const observation of value.observations) {
    validateObservation(observation, artifactPaths);
    const folded = observation.step.toLocaleLowerCase("en-US");
    if (steps.has(folded)) fail("SCHEMA_CASE_COLLISION", "observation steps collide");
    steps.add(folded);
  }
  if (value.outcome === "SKIP") {
    if (variant.availability !== "conditional") {
      fail("SEGMENT_REQUIRED_SKIP", "a required variant cannot be skipped");
    }
    assertExactKeys(value.unavailability, ["conditionId", "observedUnavailable", "reason"]);
    if (
      value.unavailability.conditionId !== variant.conditionId ||
      value.unavailability.observedUnavailable !== true
    ) {
      fail(
        "SEGMENT_CONDITIONAL_SKIP",
        "conditional skip lacks matching observed-unavailable evidence",
      );
    }
    assertNonemptyString(value.unavailability.reason, "segment.unavailability.reason");
  } else if (value.unavailability !== null) {
    fail("SEGMENT_UNAVAILABILITY", "unavailability is allowed only for a conditional SKIP");
  }
  if (value.outcomeEvidenceSha256 !== deriveProbeOutcomeEvidenceDigest(value)) {
    fail("SEGMENT_OUTCOME_EVIDENCE", "outcome is not bound to observations and artifact hashes");
  }
  return value;
}

function coordinateKey(segment) {
  return [segment.environmentId, segment.pathProfileId, segment.rowId, segment.variantId].join(
    "\0",
  );
}

function expectedCoordinatesForRow(row) {
  const variants = [
    ...row.requiredVariantIds,
    ...row.conditionalVariants.map((variant) => variant.variantId),
  ];
  return PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
    PROBE_PATH_PROFILE_IDS.flatMap((pathProfileId) =>
      variants.map((variantId) => ({ environmentId, pathProfileId, variantId })),
    ),
  );
}

function aggregateStatus(hasFailure, hasInconclusive) {
  if (hasFailure) return "FAIL";
  if (hasInconclusive) return "INCONCLUSIVE";
  return "PASS";
}

export function analyzeProbeCampaignRecords(input) {
  assertExactKeys(input, ["manifest", "candidate", "attestations", "segments"]);
  validateProbeCampaignManifest(input.manifest);
  const candidateInspection = inspectCandidateIdentity(input.candidate);
  if (!Array.isArray(input.attestations) || !Array.isArray(input.segments)) {
    fail("CAMPAIGN_ARRAY", "attestations and segments must be arrays");
  }

  const attestations = new Map();
  for (const rawAttestation of input.attestations) {
    const attestation = validateLabAttestation(rawAttestation);
    const folded = attestation.environmentId.toLocaleLowerCase("en-US");
    if (attestations.has(folded)) {
      fail("CAMPAIGN_DUPLICATE_ATTESTATION", "duplicate/case-colliding lab attestation");
    }
    attestations.set(folded, attestation);
  }

  const segments = new Map();
  let campaignRunId = null;
  const executionBundles = new Map();
  const executionRunOwners = new Map();
  const executionBundleIdOwners = new Map();
  const executionBundleManifestOwners = new Map();
  const continuationScopes = new Set();
  const continuationHeaders = new Set();
  const continuationTerminals = new Set();
  const continuationReceipts = new Set();
  const checkpointReplayRegistry = createExternalCheckpointReplayRegistry();
  for (const rawSegment of input.segments) {
    const segment = validateProbeSegmentRecord(rawSegment);
    const key = coordinateKey(segment);
    const folded = key.toLocaleLowerCase("en-US");
    if (segments.has(folded)) {
      fail("CAMPAIGN_DUPLICATE_SEGMENT", "duplicate/case-colliding segment coordinate");
    }
    if (segment.candidateSha256 !== input.candidate.candidateSha256) {
      fail("CAMPAIGN_MIXED_CANDIDATE", "segment candidate differs from campaign candidate");
    }
    const attestation = attestations.get(segment.environmentId.toLocaleLowerCase("en-US"));
    if (
      attestation !== undefined &&
      segment.labAttestationSha256 !== attestation.attestationSha256
    ) {
      fail("CAMPAIGN_FORGED_ATTESTATION", "segment lab-attestation hash does not match its VM");
    }
    if (
      attestation !== undefined &&
      segment.provenance.vmSnapshotId !== attestation.snapshot.vmSnapshotId
    ) {
      fail("CAMPAIGN_SNAPSHOT", "segment VM snapshot differs from its lab attestation");
    }
    if (segment.provenance.externalCheckpoints.length > 0) {
      for (const [index, checkpoint] of segment.provenance.externalCheckpoints.entries()) {
        validateExternalCheckpointEvidence(checkpoint, {
          segment,
          continuation: segment.continuations[index],
          repetition: index + 1,
          replayRegistry: checkpointReplayRegistry,
          expectedController: attestation?.controller ?? null,
        });
      }
    }
    if (campaignRunId === null) campaignRunId = segment.provenance.campaignRunId;
    else if (segment.provenance.campaignRunId !== campaignRunId) {
      fail("CAMPAIGN_RUN", "segments from different campaign runs cannot be combined");
    }
    const executionBinding = {
      executionRunId: segment.provenance.executionRunId,
      executionBundleId: segment.provenance.executionBundleId,
      executionBundleManifestSha256: segment.provenance.executionBundleManifestSha256,
    };
    const existingExecutionBinding = executionBundles.get(segment.environmentId);
    if (
      existingExecutionBinding !== undefined &&
      canonicalProbeJson(existingExecutionBinding) !== canonicalProbeJson(executionBinding)
    ) {
      fail(
        "CAMPAIGN_EXECUTION_BUNDLE",
        `${segment.environmentId} segments mix execution-run or bundle identities`,
      );
    }
    if (existingExecutionBinding === undefined) {
      for (const [owners, identity] of [
        [executionRunOwners, executionBinding.executionRunId],
        [executionBundleIdOwners, executionBinding.executionBundleId],
        [executionBundleManifestOwners, executionBinding.executionBundleManifestSha256],
      ]) {
        const owner = owners.get(identity);
        if (owner !== undefined && owner !== segment.environmentId) {
          fail(
            "CAMPAIGN_EXECUTION_BUNDLE_REPLAY",
            "per-VM execution-run and bundle identities must not be reused across environments",
          );
        }
        owners.set(identity, segment.environmentId);
      }
      executionBundles.set(segment.environmentId, executionBinding);
    }
    for (const continuation of segment.continuations) {
      for (const [set, digest] of [
        [continuationScopes, continuation.scopeSha256],
        [continuationHeaders, continuation.headerSha256],
        [continuationTerminals, continuation.terminalEntrySha256],
        [continuationReceipts, continuation.receiptSha256],
      ]) {
        if (set.has(digest)) {
          fail("CAMPAIGN_CONTINUATION_REPLAY", "continuation evidence was reused across segments");
        }
        set.add(digest);
      }
    }
    segments.set(folded, segment);
  }

  const campaignIssues = candidateInspection.pinningIssues.map((issue) => ({
    code: issue.code,
    detail: issue.detail,
  }));
  for (const environmentId of PROBE_ENVIRONMENT_IDS) {
    const attestation = attestations.get(environmentId.toLocaleLowerCase("en-US"));
    if (attestation === undefined) {
      campaignIssues.push({ code: "MISSING_ATTESTATION", detail: environmentId });
      continue;
    }
    for (const capability of REQUIRED_ATTESTATION_CAPABILITIES) {
      if (!attestation.capabilities[capability]) {
        campaignIssues.push({
          code: "UNAVAILABLE_REQUIRED_CAPABILITY",
          detail: `${environmentId}:${capability}`,
        });
      }
    }
  }

  const rowResults = [];
  const authorityReady = campaignIssues.length === 0;
  for (const row of PROBE_CAMPAIGN_MANIFEST.rows) {
    const missingSegments = [];
    const inconclusiveSegments = [];
    const skippedConditionalSegments = [];
    const mechanismIds = new Set();
    const mechanismDefinitionDigests = new Set();
    const upstreamSelectionDigestSets = new Set();
    const verifierSourcesById = new Map();
    const verificationInputDigests = new Set();
    const terminalSegmentDigests = new Set();
    const environmentEvidence = new Map();
    let rowFailure = false;
    for (const coordinate of expectedCoordinatesForRow(row)) {
      const key = [
        coordinate.environmentId,
        coordinate.pathProfileId,
        row.rowId,
        coordinate.variantId,
      ]
        .join("\0")
        .toLocaleLowerCase("en-US");
      const segment = segments.get(key);
      if (segment === undefined) {
        missingSegments.push(coordinate);
        continue;
      }
      mechanismIds.add(segment.mechanismId);
      mechanismDefinitionDigests.add(segment.mechanismDefinitionSha256);
      upstreamSelectionDigestSets.add(canonicalProbeJson(segment.upstreamSelectionDigests));
      const verifierSources = verifierSourcesById.get(segment.verifierId) ?? new Set();
      verifierSources.add(segment.verifierSourceSha256);
      verifierSourcesById.set(segment.verifierId, verifierSources);
      verificationInputDigests.add(segment.verificationInputSha256);
      terminalSegmentDigests.add(segment.segmentSha256);
      const evidenceKey = `${coordinate.environmentId}\0${coordinate.pathProfileId}`;
      const evidenceRefs = environmentEvidence.get(evidenceKey) ?? new Set();
      for (const artifact of segment.artifactHashes) evidenceRefs.add(artifact.path);
      environmentEvidence.set(evidenceKey, evidenceRefs);
      if (segment.outcome === "FAIL") rowFailure = true;
      else if (segment.outcome === "INCONCLUSIVE") inconclusiveSegments.push(coordinate);
      else if (segment.outcome === "SKIP") skippedConditionalSegments.push(coordinate);
    }
    if (mechanismIds.size > 1) {
      fail("CAMPAIGN_MIXED_MECHANISM", `${row.rowId} segments name more than one mechanism`);
    }
    if (mechanismDefinitionDigests.size > 1 || upstreamSelectionDigestSets.size > 1) {
      fail(
        "CAMPAIGN_MIXED_SELECTION",
        `${row.rowId} segments do not bind one selection definition`,
      );
    }
    if ([...verifierSourcesById.values()].some((sources) => sources.size > 1)) {
      fail(
        "CAMPAIGN_MIXED_VERIFIER",
        `${row.rowId} segments bind one verifier ID to multiple source artifacts`,
      );
    }
    const verifierBindings = [...verifierSourcesById]
      .map(([verifierId, sources]) => ({
        verifierId,
        verifierSourceSha256: [...sources][0],
      }))
      .sort((left, right) => compareUtf8(left.verifierId, right.verifierId));
    const rowVerificationInputSha256 = deriveProbeRowVerificationInputDigest(
      row.rowId,
      sorted(verificationInputDigests),
    );
    const rowEvidenceSha256 = deriveProbeRowEvidenceDigest({
      rowId: row.rowId,
      terminalSegmentDigests: sorted(terminalSegmentDigests),
      attestationDigests: sorted(
        [...attestations.values()].map((entry) => entry.attestationSha256),
      ),
      executionBundleManifestDigests: sorted(
        [...executionBundles.values()].map((entry) => entry.executionBundleManifestSha256),
      ),
    });
    const rowInconclusive =
      missingSegments.length > 0 || inconclusiveSegments.length > 0 || campaignIssues.length > 0;
    const status = authorityReady ? aggregateStatus(rowFailure, rowInconclusive) : "INCONCLUSIVE";
    rowResults.push({
      rowId: row.rowId,
      claim: row.claim,
      stopCondition: row.stopCondition,
      status,
      stopConditionTriggered: status !== "PASS",
      selectedMechanism: status === "PASS" ? [...mechanismIds][0] : null,
      mechanismDefinitionSha256: status === "PASS" ? [...mechanismDefinitionDigests][0] : null,
      verifierBindings: status === "PASS" ? verifierBindings : [],
      verificationInputSha256: status === "PASS" ? rowVerificationInputSha256 : null,
      rowEvidenceSha256: status === "PASS" ? rowEvidenceSha256 : null,
      upstreamSelectionDigests: [],
      selectionDigest: null,
      blockedByRowIds: [],
      environmentEvidenceRefs: PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
        PROBE_PATH_PROFILE_IDS.map((pathProfileId) => ({
          environmentId,
          pathProfileId,
          evidenceRefs: sorted([
            ...(environmentEvidence.get(`${environmentId}\0${pathProfileId}`) ?? []),
          ]),
        })),
      ),
      expectedSegmentCount: expectedCoordinatesForRow(row).length,
      observedSegmentCount: expectedCoordinatesForRow(row).length - missingSegments.length,
      missingSegments,
      inconclusiveSegments,
      skippedConditionalSegments,
      rowClosureClaimed: false,
    });
  }

  const rowsById = new Map(rowResults.map((result) => [result.rowId, result]));
  for (const [index, row] of PROBE_CAMPAIGN_MANIFEST.rows.entries()) {
    const result = rowResults[index];
    const blockedByRowIds = row.dependsOnRowIds.filter(
      (dependencyRowId) => rowsById.get(dependencyRowId)?.selectionDigest === null,
    );
    if (blockedByRowIds.length > 0) {
      result.status = "INCONCLUSIVE";
      result.stopConditionTriggered = true;
      result.selectedMechanism = null;
      result.mechanismDefinitionSha256 = null;
      result.verifierBindings = [];
      result.verificationInputSha256 = null;
      result.rowEvidenceSha256 = null;
      result.upstreamSelectionDigests = [];
      result.blockedByRowIds = blockedByRowIds;
      continue;
    }
    if (result.status !== "PASS") continue;
    const upstreamSelectionDigests = sorted(
      row.dependsOnRowIds.map((dependencyRowId) => rowsById.get(dependencyRowId).selectionDigest),
    );
    const declaredUpstream = JSON.parse(
      [
        ...new Set(
          input.segments
            .filter((segment) => segment.rowId === row.rowId)
            .map((segment) => canonicalProbeJson(segment.upstreamSelectionDigests)),
        ),
      ][0] ?? "[]",
    );
    if (canonicalProbeJson(declaredUpstream) !== canonicalProbeJson(upstreamSelectionDigests)) {
      fail(
        "CAMPAIGN_UPSTREAM_SELECTION",
        `${row.rowId} does not bind the selected dependency digests`,
      );
    }
    result.upstreamSelectionDigests = upstreamSelectionDigests;
    result.selectionDigest = deriveProbeSelectionDigest({
      rowId: row.rowId,
      candidateSha256: input.candidate.candidateSha256,
      mechanismId: result.selectedMechanism,
      mechanismDefinitionSha256: result.mechanismDefinitionSha256,
      upstreamSelectionDigests,
      verifierBindings: result.verifierBindings,
      verificationInputSha256: result.verificationInputSha256,
      rowEvidenceSha256: result.rowEvidenceSha256,
    });
  }

  const hasInconclusive =
    campaignIssues.length > 0 || rowResults.some((result) => result.status === "INCONCLUSIVE");
  const status = authorityReady
    ? aggregateStatus(
        rowResults.some((result) => result.status === "FAIL"),
        hasInconclusive,
      )
    : "INCONCLUSIVE";
  return deepFreeze({
    schemaVersion: 1,
    kind: "windows-host-probe-campaign-analysis",
    authority: "unverified-record-analysis",
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: MANIFEST_SHA256,
    candidateSha256: input.candidate.candidateSha256,
    phase: "probe",
    status,
    selectionEligible: false,
    rowClosureClaimed: false,
    issues: campaignIssues,
    rowResults,
  });
}

export const PROBE_CAMPAIGN_MANIFEST_SHA256 = MANIFEST_SHA256;
