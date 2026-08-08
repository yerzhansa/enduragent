import { Buffer } from "node:buffer";
import { createPublicKey } from "node:crypto";

import { deriveNativeManifestDigests } from "./native-manifest-digest.mjs";
import { validateProbeBrokerEnrollmentInventory } from "./broker/mailbox-protocol.mjs";
import { createProbeFilesystemArtifactReader } from "./probe-adapters.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
  validateLabAttestation,
  validateProbeCandidateIdentity,
} from "./probe-contract.mjs";
import { validateProbeRunAuthorization } from "./probe-run-authorization.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "./probe-runner.mjs";

export const PROBE_BOOTSTRAP_SCHEMA_VERSION = 1;
export const PROBE_BOOTSTRAP_PATH = "bootstrap.json";
export const PROBE_BOOTSTRAP_MAXIMUM_BYTES = 256 * 1024;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const strictTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const windowsDriveRootPattern = /^[A-Z]:\\/u;
const forbiddenWindowsPathCharacter = /[<>"|?*]/u;
const forbiddenSecretKey =
  /^(?:api[_-]?key|auth(?:entication|orization)?[_-]?(?:header|material|token)|bearer|bearer[_-]?token|client[_-]?secret|cookie|cookies|credential|credentials|endpoint[_-]?auth|env|environment[_-]?variables?|password|passwd|passphrase|private[_-]?key|refresh[_-]?token|secret|secrets|session[_-]?secret|session[_-]?token|token)$/iu;
const privateKeyMaterial = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const bearerMaterial = /^Bearer\s+\S/iu;

export class ProbeBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBootstrapError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBootstrapError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("BOOTSTRAP_SCHEMA", `${label} must be a plain object`);
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) fail("BOOTSTRAP_SCHEMA", `${label} has an invalid shape`);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BOOTSTRAP_SHA256", `${label} must be lowercase 64-hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("BOOTSTRAP_IDENTIFIER", `${label} must be a bounded protocol identifier`);
  }
  return value;
}

function requireString(value, label, maximumLength = 2048) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.normalize("NFC") ||
    value.includes("\0")
  ) {
    fail("BOOTSTRAP_STRING", `${label} must be a bounded NFC string`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !strictTimestampPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail("BOOTSTRAP_TIMESTAMP", `${label} must be strict UTC ISO with milliseconds`);
  }
  return value;
}

function requirePositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("BOOTSTRAP_INTEGER", `${label} must be a bounded positive safe integer`);
  }
  return value;
}

function requireArtifactPath(value, label) {
  requireString(value, label, 1024);
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value) ||
    value.startsWith("//")
  ) {
    fail("BOOTSTRAP_REFERENCE_PATH", `${label} must be a root-relative slash path`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        forbiddenWindowsPathCharacter.test(segment) ||
        [...segment].some((character) => character.codePointAt(0) <= 0x1f) ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    )
  ) {
    fail("BOOTSTRAP_REFERENCE_PATH", `${label} contains an unsafe path segment`);
  }
  return value;
}

function requireReference(value, label) {
  assertExactKeys(value, ["path", "sha256"], label);
  return Object.freeze({
    path: requireArtifactPath(value.path, `${label}.path`),
    sha256: requireSha256(value.sha256, `${label}.sha256`),
  });
}

function requireLocalAbsoluteRoot(value, label, { allowPosix = false } = {}) {
  requireString(value, label, 4096);
  if (
    value.startsWith("\\\\") ||
    value.startsWith("//") ||
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\")
  ) {
    fail("BOOTSTRAP_ABSOLUTE_ROOT", `${label} must not be UNC or a device path`);
  }
  if (windowsDriveRootPattern.test(value)) {
    if (value.includes("/") || value.length <= 3) {
      fail("BOOTSTRAP_ABSOLUTE_ROOT", `${label} must be a canonical Windows drive path`);
    }
    const segments = value.slice(3).split("\\");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes(":") ||
          forbiddenWindowsPathCharacter.test(segment) ||
          [...segment].some((character) => character.codePointAt(0) <= 0x1f) ||
          segment.endsWith(".") ||
          segment.endsWith(" "),
      )
    ) {
      fail("BOOTSTRAP_ABSOLUTE_ROOT", `${label} contains an unsafe Windows segment`);
    }
    return value;
  }
  if (allowPosix && value.startsWith("/")) {
    const segments = value.slice(1).split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          [...segment].some((character) => character.codePointAt(0) <= 0x1f),
      )
    ) {
      fail("BOOTSTRAP_ABSOLUTE_ROOT", `${label} contains an unsafe POSIX segment`);
    }
    return value;
  }
  fail(
    "BOOTSTRAP_ABSOLUTE_ROOT",
    `${label} must be ${allowPosix ? "an absolute local" : "a local Windows drive"} path`,
  );
}

function requireControllerSpoolRoot(value) {
  const label = "bootstrap.controllerSpool.root";
  requireString(value, label, 4096);
  if (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")) {
    fail("BOOTSTRAP_ABSOLUTE_ROOT", `${label} must not be a device path`);
  }
  if (!value.startsWith("\\\\")) {
    return requireLocalAbsoluteRoot(value, label);
  }
  if (value.includes("/")) {
    fail("BOOTSTRAP_ABSOLUTE_ROOT", `${label} must use canonical Windows separators`);
  }
  const segments = value.slice(2).split("\\");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        forbiddenWindowsPathCharacter.test(segment) ||
        [...segment].some((character) => character.codePointAt(0) <= 0x1f) ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    )
  ) {
    fail("BOOTSTRAP_ABSOLUTE_ROOT", `${label} contains an unsafe UNC segment`);
  }
  return value;
}

function folded(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function assertUniqueCaseFolded(values, label) {
  const seen = new Set();
  for (const value of values) {
    const key = folded(value);
    if (seen.has(key))
      fail("BOOTSTRAP_CASE_COLLISION", `${label} has a duplicate or case collision`);
    seen.add(key);
  }
}

function windowsRootComponents(value) {
  if (windowsDriveRootPattern.test(value)) {
    return Object.freeze([
      "drive",
      folded(value.slice(0, 2)),
      ...value.slice(3).split("\\").map(folded),
    ]);
  }
  const segments = value.slice(2).split("\\");
  return Object.freeze([
    "unc",
    folded(segments[0]),
    folded(segments[1]),
    ...segments.slice(2).map(folded),
  ]);
}

function isWindowsComponentPrefix(left, right) {
  return (
    left.length <= right.length && left.every((component, index) => component === right[index])
  );
}

function assertPairwiseWindowsRootDisjoint(entries) {
  const roots = entries.map((entry) => ({
    ...entry,
    components: windowsRootComponents(entry.root),
  }));
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex];
      const right = roots[rightIndex];
      if (
        isWindowsComponentPrefix(left.components, right.components) ||
        isWindowsComponentPrefix(right.components, left.components)
      ) {
        fail(
          "BOOTSTRAP_ROOT_OVERLAP",
          `${left.label} and ${right.label} must be disjoint Windows roots`,
        );
      }
    }
  }
}

function assertNoSecretMaterial(value, path = "artifact") {
  if (typeof value === "string") {
    if (privateKeyMaterial.test(value) || bearerMaterial.test(value)) {
      fail("BOOTSTRAP_SECRET", `${path} contains forbidden secret material`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      assertNoSecretMaterial(entry, `${path}[${index}]`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenSecretKey.test(key)) {
      fail("BOOTSTRAP_SECRET", `${path}.${key} is a forbidden secret-shaped field`);
    }
    assertNoSecretMaterial(entry, `${path}.${key}`);
  }
}

function parseCanonicalJson(bytes, label) {
  const input = Buffer.from(bytes);
  if (input.length === 0 || (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf)) {
    fail("BOOTSTRAP_UTF8", `${label} must be non-empty UTF-8 without a BOM`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("BOOTSTRAP_UTF8", `${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("BOOTSTRAP_JSON", `${label} is not valid JSON`);
  }
  if (!exactObject(value) || canonicalProbeJson(value) !== text) {
    fail("BOOTSTRAP_CANONICAL", `${label} is not exact canonical JSON`);
  }
  assertNoSecretMaterial(value, label);
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function canonicalControllerPublicKeyBase64(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 4096) {
    fail("BOOTSTRAP_CONTROLLER_KEY", "controller public key artifact is invalid");
  }
  const source = Buffer.from(bytes);
  let key;
  try {
    key = createPublicKey({ key: source, format: "der", type: "spki" });
  } catch {
    fail("BOOTSTRAP_CONTROLLER_KEY", "controller public key is not SPKI DER");
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !Buffer.from(key.export({ format: "der", type: "spki" })).equals(source)
  ) {
    fail("BOOTSTRAP_CONTROLLER_KEY", "controller public key is not canonical Ed25519");
  }
  return source.toString("base64");
}

function validateAttestationReferences(values) {
  if (!Array.isArray(values) || values.length !== PROBE_ENVIRONMENT_IDS.length) {
    fail("BOOTSTRAP_ATTESTATIONS", "bootstrap must reference exactly both lab attestations");
  }
  return values.map((entry, index) => {
    assertExactKeys(entry, ["environmentId", "artifact"], `bootstrap.attestations[${index}]`);
    if (entry.environmentId !== PROBE_ENVIRONMENT_IDS[index]) {
      fail("BOOTSTRAP_ATTESTATIONS", "bootstrap attestation mappings must be complete and ordered");
    }
    return Object.freeze({
      environmentId: entry.environmentId,
      artifact: requireReference(entry.artifact, `bootstrap.attestations[${index}].artifact`),
    });
  });
}

function validateEvidenceRoots(values) {
  const expected = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
    PROBE_PATH_PROFILE_IDS.map((pathProfileId) => ({ environmentId, pathProfileId })),
  );
  if (!Array.isArray(values) || values.length !== expected.length) {
    fail("BOOTSTRAP_EVIDENCE_ROOTS", "bootstrap must map every environment/path-profile root");
  }
  const roots = values.map((entry, index) => {
    assertExactKeys(
      entry,
      ["environmentId", "pathProfileId", "root"],
      `bootstrap.evidenceRoots[${index}]`,
    );
    if (
      entry.environmentId !== expected[index].environmentId ||
      entry.pathProfileId !== expected[index].pathProfileId
    ) {
      fail("BOOTSTRAP_EVIDENCE_ROOTS", "evidence-root mappings must be complete and ordered");
    }
    return Object.freeze({
      environmentId: entry.environmentId,
      pathProfileId: entry.pathProfileId,
      root: requireLocalAbsoluteRoot(entry.root, `bootstrap.evidenceRoots[${index}].root`),
    });
  });
  assertUniqueCaseFolded(
    roots.map((entry) => entry.root),
    "bootstrap evidence roots",
  );
  return Object.freeze(roots);
}

function validateControllerSpool(value) {
  assertExactKeys(
    value,
    ["root", "identitySha256", "publicKeySha256", "version"],
    "bootstrap.controllerSpool",
  );
  return Object.freeze({
    root: requireControllerSpoolRoot(value.root),
    identitySha256: requireSha256(value.identitySha256, "bootstrap.controllerSpool.identitySha256"),
    publicKeySha256: requireSha256(
      value.publicKeySha256,
      "bootstrap.controllerSpool.publicKeySha256",
    ),
    version: requireString(value.version, "bootstrap.controllerSpool.version", 128),
  });
}

function validateCandidateBinaries(value) {
  assertExactKeys(
    value,
    ["nativeHelperArtifactPath", "nsisArtifactPath"],
    "bootstrap.candidateBinaries",
  );
  const nativeHelperArtifactPath = requireArtifactPath(
    value.nativeHelperArtifactPath,
    "bootstrap.candidateBinaries.nativeHelperArtifactPath",
  );
  const nsisArtifactPath = requireArtifactPath(
    value.nsisArtifactPath,
    "bootstrap.candidateBinaries.nsisArtifactPath",
  );
  if (folded(nativeHelperArtifactPath) === folded(nsisArtifactPath)) {
    fail("BOOTSTRAP_NATIVE_BINDING", "native helper and NSIS artifact paths must be distinct");
  }
  return Object.freeze({ nativeHelperArtifactPath, nsisArtifactPath });
}

function validateBootstrapDocument(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "campaignId",
      "campaignRunId",
      "runPlanSha256",
      "candidate",
      "attestations",
      "runAuthorization",
      "lifecyclePolicy",
      "nativeCandidateManifest",
      "candidateBinaries",
      "repositoryRoot",
      "binaryRoot",
      "evidenceRoots",
      "controllerSpool",
      "brokerEnrollments",
    ],
    "bootstrap",
  );
  if (
    value.schemaVersion !== PROBE_BOOTSTRAP_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-bootstrap" ||
    value.campaignId !== PROBE_CAMPAIGN_ID ||
    value.runPlanSha256 !== PROBE_RUN_PLAN_SHA256
  ) {
    fail("BOOTSTRAP_IDENTITY", "bootstrap does not select the frozen probe campaign and plan");
  }
  const bootstrap = {
    schemaVersion: PROBE_BOOTSTRAP_SCHEMA_VERSION,
    kind: "windows-host-probe-bootstrap",
    campaignId: PROBE_CAMPAIGN_ID,
    campaignRunId: requireIdentifier(value.campaignRunId, "bootstrap.campaignRunId"),
    runPlanSha256: requireSha256(value.runPlanSha256, "bootstrap.runPlanSha256"),
    candidate: requireReference(value.candidate, "bootstrap.candidate"),
    attestations: validateAttestationReferences(value.attestations),
    runAuthorization: requireReference(value.runAuthorization, "bootstrap.runAuthorization"),
    lifecyclePolicy: requireReference(value.lifecyclePolicy, "bootstrap.lifecyclePolicy"),
    nativeCandidateManifest: requireReference(
      value.nativeCandidateManifest,
      "bootstrap.nativeCandidateManifest",
    ),
    candidateBinaries: validateCandidateBinaries(value.candidateBinaries),
    repositoryRoot: requireLocalAbsoluteRoot(value.repositoryRoot, "bootstrap.repositoryRoot"),
    binaryRoot: requireLocalAbsoluteRoot(value.binaryRoot, "bootstrap.binaryRoot"),
    evidenceRoots: validateEvidenceRoots(value.evidenceRoots),
    controllerSpool: validateControllerSpool(value.controllerSpool),
    brokerEnrollments: validateProbeBrokerEnrollmentInventory(value.brokerEnrollments),
  };
  const references = [
    bootstrap.candidate,
    ...bootstrap.attestations.map((entry) => entry.artifact),
    bootstrap.runAuthorization,
    bootstrap.lifecyclePolicy,
    bootstrap.nativeCandidateManifest,
  ];
  assertUniqueCaseFolded(
    references.map((entry) => entry.path),
    "bootstrap artifact references",
  );
  assertPairwiseWindowsRootDisjoint([
    { label: "bootstrap.repositoryRoot", root: bootstrap.repositoryRoot },
    { label: "bootstrap.binaryRoot", root: bootstrap.binaryRoot },
    ...bootstrap.evidenceRoots.map((entry, index) => ({
      label: `bootstrap.evidenceRoots[${index}].root`,
      root: entry.root,
    })),
    { label: "bootstrap.controllerSpool.root", root: bootstrap.controllerSpool.root },
    ...bootstrap.brokerEnrollments.flatMap((entry, index) => [
      {
        label: `bootstrap.brokerEnrollments[${index}].mailboxRoot`,
        root: entry.mailboxRoot,
      },
      {
        label: `bootstrap.brokerEnrollments[${index}].journalRoot`,
        root: entry.journalRoot,
      },
    ]),
  ]);
  return deepFreeze(bootstrap);
}

function validateLifecyclePolicy(value) {
  assertExactKeys(value, ["policyId", "evaluatedAt", "mappings"], "lifecycle policy");
  requireIdentifier(value.policyId, "lifecycle policy.policyId");
  requireTimestamp(value.evaluatedAt, "lifecycle policy.evaluatedAt");
  if (!Array.isArray(value.mappings) || value.mappings.length !== PROBE_ENVIRONMENT_IDS.length) {
    fail("BOOTSTRAP_LIFECYCLE", "lifecycle policy must contain exactly both environments");
  }
  const expected = [
    { environmentId: "win11-floor", role: "floor", windowsVersion: "24H2" },
    { environmentId: "win11-current", role: "current", windowsVersion: "25H2" },
  ];
  for (const [index, mapping] of value.mappings.entries()) {
    assertExactKeys(
      mapping,
      [
        "environmentId",
        "role",
        "windowsVersion",
        "minimumBuild",
        "maximumBuild",
        "supportedFrom",
        "supportedUntil",
        "declaredSupported",
      ],
      `lifecycle policy.mappings[${index}]`,
    );
    const selected = expected[index];
    if (
      mapping.environmentId !== selected.environmentId ||
      mapping.role !== selected.role ||
      mapping.windowsVersion !== selected.windowsVersion ||
      mapping.declaredSupported !== true ||
      !Number.isSafeInteger(mapping.minimumBuild) ||
      mapping.minimumBuild < 22_000 ||
      (mapping.maximumBuild !== null &&
        (!Number.isSafeInteger(mapping.maximumBuild) ||
          mapping.maximumBuild < mapping.minimumBuild))
    ) {
      fail("BOOTSTRAP_LIFECYCLE", "lifecycle environment mapping is invalid");
    }
    requireTimestamp(mapping.supportedFrom, `lifecycle policy.mappings[${index}].supportedFrom`);
    requireTimestamp(mapping.supportedUntil, `lifecycle policy.mappings[${index}].supportedUntil`);
  }
  return value;
}

const nativeToolchainKeys = Object.freeze([
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
]);

function validateNamedDigests(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("BOOTSTRAP_NATIVE_MANIFEST", `${label} must be a non-empty array`);
  }
  const names = [];
  for (const [index, entry] of values.entries()) {
    assertExactKeys(entry, ["name", "sha256"], `${label}[${index}]`);
    names.push(requireString(entry.name, `${label}[${index}].name`, 256));
    requireSha256(entry.sha256, `${label}[${index}].sha256`);
  }
  assertUniqueCaseFolded(names, label);
}

function validateNativeCandidateManifest(value) {
  assertExactKeys(
    value,
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
  if (value.schemaVersion !== 1) {
    fail("BOOTSTRAP_NATIVE_MANIFEST", "native candidate manifest version is invalid");
  }
  for (const key of ["candidateDigest", "sourceBundleSha256", "toolchainDigest"]) {
    requireSha256(value[key], `native candidate manifest.${key}`);
  }
  assertExactKeys(value.assembly, ["name", "sha256"], "native candidate manifest.assembly");
  if (value.assembly.name !== "windows-host-falsifier-native.exe") {
    fail("BOOTSTRAP_NATIVE_MANIFEST", "native candidate assembly name is invalid");
  }
  requireSha256(value.assembly.sha256, "native candidate manifest.assembly.sha256");
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    fail("BOOTSTRAP_NATIVE_MANIFEST", "native candidate sources must be a non-empty array");
  }
  const sourceNames = [];
  for (const [index, source] of value.sources.entries()) {
    assertExactKeys(source, ["name", "sha256", "bytes"], `native candidate sources[${index}]`);
    sourceNames.push(requireString(source.name, `native candidate sources[${index}].name`, 256));
    requireSha256(source.sha256, `native candidate sources[${index}].sha256`);
    requirePositiveInteger(
      source.bytes,
      `native candidate sources[${index}].bytes`,
      2 * 1024 * 1024,
    );
  }
  assertUniqueCaseFolded(sourceNames, "native candidate source names");
  assertExactKeys(value.toolchain, nativeToolchainKeys, "native candidate manifest.toolchain");
  if (
    value.toolchain.schemaVersion !== 1 ||
    value.toolchain.powerShellEdition !== "Desktop" ||
    value.toolchain.codeDomProvider !== "Microsoft.CSharp.CSharpCodeProvider" ||
    value.toolchain.outputType !== "ConsoleApplication" ||
    value.toolchain.platform !== "x64"
  ) {
    fail("BOOTSTRAP_NATIVE_MANIFEST", "native candidate toolchain identity is invalid");
  }
  for (const key of [
    "cscSha256Before",
    "cscSha256After",
    "powerShellExecutableSha256Before",
    "powerShellExecutableSha256After",
    "runtimeDirectorySha256Before",
    "runtimeDirectorySha256After",
    "assemblySha256",
  ]) {
    requireSha256(value.toolchain[key], `native candidate manifest.toolchain.${key}`);
  }
  for (const key of [
    "powerShellVersion",
    "clrVersion",
    "codeDomProviderAssemblyVersion",
    "cscFileVersion",
    "compilerOptions",
    "addTypeInvocation",
  ]) {
    requireString(value.toolchain[key], `native candidate manifest.toolchain.${key}`);
  }
  for (const key of ["runtimeRelativeInventory", "referencedAssemblies"]) {
    if (!Array.isArray(value.toolchain[key]) || value.toolchain[key].length === 0) {
      fail("BOOTSTRAP_NATIVE_MANIFEST", `native candidate manifest.toolchain.${key} is invalid`);
    }
    for (const [index, entry] of value.toolchain[key].entries()) {
      requireString(entry, `native candidate manifest.toolchain.${key}[${index}]`, 256);
    }
    assertUniqueCaseFolded(value.toolchain[key], `native candidate manifest.toolchain.${key}`);
  }
  for (const key of [
    "referenceSha256Before",
    "referenceSha256After",
    "sourceSha256Before",
    "sourceSha256After",
  ]) {
    validateNamedDigests(value.toolchain[key], `native candidate manifest.toolchain.${key}`);
  }
  if (value.toolchain.assemblySha256 !== value.assembly.sha256) {
    fail("BOOTSTRAP_NATIVE_MANIFEST", "native candidate assembly identities disagree");
  }
  const expectedDigests = deriveNativeManifestDigests({
    sources: value.sources,
    toolchain: value.toolchain,
    assemblySha256: value.assembly.sha256,
  });
  if (
    value.sourceBundleSha256 !== expectedDigests.sourceBundleSha256 ||
    value.toolchainDigest !== expectedDigests.toolchainDigest ||
    value.candidateDigest !== expectedDigests.candidateDigest
  ) {
    fail(
      "BOOTSTRAP_NATIVE_MANIFEST_DIGEST",
      "native candidate manifest aggregate digests are inconsistent",
    );
  }
  return value;
}

function canonicalAttestationBindings(attestations) {
  return attestations
    .map(({ environmentId, attestationSha256 }) => ({ environmentId, attestationSha256 }))
    .sort((left, right) => compareUtf8(left.environmentId, right.environmentId));
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

export async function loadProbeBootstrap({ root, expectedSha256 }) {
  requireSha256(expectedSha256, "expectedSha256");
  const readArtifact = await createProbeFilesystemArtifactReader({
    root,
    maximumArtifactBytes: PROBE_BOOTSTRAP_MAXIMUM_BYTES,
  });
  const bootstrapArtifact = await readArtifact({
    path: PROBE_BOOTSTRAP_PATH,
    sha256: expectedSha256,
  });
  const bootstrap = validateBootstrapDocument(
    parseCanonicalJson(bootstrapArtifact.bytes, "bootstrap.json"),
  );

  async function readJson(reference, label) {
    const artifact = await readArtifact(reference);
    return parseCanonicalJson(artifact.bytes, label);
  }

  const candidate = validateProbeCandidateIdentity(
    await readJson(bootstrap.candidate, "candidate"),
  );
  const attestations = [];
  for (const reference of bootstrap.attestations) {
    const attestation = validateLabAttestation(
      await readJson(reference.artifact, `attestation ${reference.environmentId}`),
    );
    if (attestation.environmentId !== reference.environmentId) {
      fail("BOOTSTRAP_ATTESTATIONS", "an attestation reference selects another environment");
    }
    attestations.push(attestation);
  }
  const runAuthorization = validateProbeRunAuthorization(
    await readJson(bootstrap.runAuthorization, "run authorization"),
  );
  const lifecyclePolicy = validateLifecyclePolicy(
    await readJson(bootstrap.lifecyclePolicy, "lifecycle policy"),
  );
  const nativeCandidateManifest = validateNativeCandidateManifest(
    await readJson(bootstrap.nativeCandidateManifest, "native candidate manifest"),
  );

  const authorizationAttestations = canonicalAttestationBindings(attestations);
  if (
    runAuthorization.campaignId !== bootstrap.campaignId ||
    runAuthorization.campaignRunId !== bootstrap.campaignRunId ||
    runAuthorization.runPlanSha256 !== bootstrap.runPlanSha256 ||
    runAuthorization.candidateSha256 !== candidate.candidateSha256 ||
    !canonicalEqual(runAuthorization.attestations, authorizationAttestations)
  ) {
    fail("BOOTSTRAP_AUTHORIZATION_BINDING", "run authorization is not bound to this bootstrap");
  }

  const controllerPublicKeyArtifact = attestations[0].controller.publicKeyArtifact;
  for (const attestation of attestations) {
    const primaryEnrollment = bootstrap.brokerEnrollments.find(
      (entry) =>
        entry.environmentId === attestation.environmentId &&
        entry.brokerRole === "primary-standard-user",
    );
    if (primaryEnrollment?.processSidSha256 !== attestation.host.standardUserSidSha256) {
      fail(
        "BOOTSTRAP_BROKER_BINDING",
        "primary broker enrollment differs from the attested standard-user SID",
      );
    }
    if (
      attestation.controller.identitySha256 !== bootstrap.controllerSpool.identitySha256 ||
      attestation.controller.publicKeySha256 !== bootstrap.controllerSpool.publicKeySha256 ||
      attestation.controller.publicKeyArtifact.sha256 !==
        bootstrap.controllerSpool.publicKeySha256 ||
      !canonicalEqual(attestation.controller.publicKeyArtifact, controllerPublicKeyArtifact) ||
      attestation.controller.version !== bootstrap.controllerSpool.version
    ) {
      fail(
        "BOOTSTRAP_CONTROLLER_BINDING",
        "both attestations must select the bootstrap controller identity, key, and version",
      );
    }
  }
  const controllerPublicKey = await readArtifact(controllerPublicKeyArtifact);
  const controllerPublicKeySpkiDerBase64 = canonicalControllerPublicKeyBase64(
    controllerPublicKey.bytes,
  );
  if (
    !candidate.binaryHashes.some(
      (entry) =>
        entry.path === bootstrap.candidateBinaries.nativeHelperArtifactPath &&
        entry.sha256 === nativeCandidateManifest.assembly.sha256,
    ) ||
    !candidate.binaryHashes.some(
      (entry) => entry.path === bootstrap.candidateBinaries.nsisArtifactPath,
    )
  ) {
    fail(
      "BOOTSTRAP_NATIVE_BINDING",
      "bootstrap candidate binary paths are not exactly bound by the candidate inventory",
    );
  }

  return deepFreeze({
    bootstrapSha256: expectedSha256,
    bootstrap,
    candidate,
    attestations,
    runAuthorization,
    lifecyclePolicy,
    nativeCandidateManifest,
    controllerPublicKeySpkiDerBase64,
  });
}
