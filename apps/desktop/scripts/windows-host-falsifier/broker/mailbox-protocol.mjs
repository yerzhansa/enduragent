import {
  PROBE_ENVIRONMENT_IDS,
  canonicalProbeJson,
  hashProbeCanonicalJson,
} from "../probe-contract.mjs";
import {
  PROBE_BROKER_ROLES,
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  validateProbeBrokerControllerAcceptanceInput,
  validateProbeBrokerControllerAcceptanceInputForTask,
  validateProbeBrokerResult,
  validateProbeBrokerTask,
} from "./protocol.mjs";

export const PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION = 1;
export const PROBE_BROKER_ENROLLMENT_KIND = "windows-host-probe-broker-enrollment";
export const PROBE_BROKER_MAILBOX_OBSERVATION_KIND =
  "windows-host-probe-broker-mailbox-observation";
export const PROBE_PREPARED_BROKER_ENROLLMENT_KIND =
  "windows-host-probe-prepared-broker-enrollment";
export const PROBE_BROKER_MAILBOX_TASK_KIND = "windows-host-probe-broker-mailbox-task";
export const PROBE_BROKER_MAILBOX_RESULT_KIND = "windows-host-probe-broker-mailbox-result";
export const PROBE_BROKER_MAILBOX_REFUSAL_KIND = "windows-host-probe-broker-mailbox-refusal";
export const PROBE_BROKER_MAILBOX_SECURITY_PROFILE = "role-separated-immutable-file-mailbox-v1";
export const PROBE_BROKER_JOURNAL_SECURITY_PROFILE = "role-separated-append-only-journal-v1";
export const PROBE_BROKER_MAILBOX_REFUSAL_CODES = Object.freeze([
  "AUTHORITY_MISMATCH",
  "BLOB_INVALID",
  "DEADLINE_EXPIRED",
  "EQUIVOCATION",
  "MALFORMED_TASK",
  "RECOVERY_REQUIRED",
  "UNSUPPORTED_DRIVER",
]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const windowsDriveRootPattern = /^[A-Z]:\\/u;
const forbiddenWindowsPathCharacter = /[<>"|?*]/u;
const printableAsciiPathComponent = /^[\x20-\x7e]+$/u;
const reservedDosDeviceNamePattern =
  /^(?:AUX|CLOCK\$|COM[1-9]|CON|CONIN\$|CONOUT\$|LPT[1-9]|NUL|PRN)$/iu;
const enrollmentKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "environmentId",
  "brokerRole",
  "brokerInstanceId",
  "mailboxRoot",
  "mailboxSecurityProfile",
  "mailboxAclSha256",
  "journalRoot",
  "journalSecurityProfile",
  "journalRootAclSha256",
  "journalDatabaseAclSha256",
  "processSidSha256",
  "peerAuthoritySha256",
  "brokerEnrollmentSha256",
]);
const observationKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "brokerEnrollmentSha256",
  "environmentId",
  "brokerRole",
  "brokerInstanceId",
  "mailboxRoot",
  "mailboxSecurityProfile",
  "mailboxAclSha256",
  "mailboxOwnerSidSha256",
  "processSidSha256",
  "peerAuthoritySha256",
  "mailboxRootObjectIdentitySha256",
  "mailboxVolumeIdSha256",
  "mailboxTransportIdentitySha256",
  "mailboxFileSystem",
  "mailboxDriveType",
  "mailboxLocalAbsolute",
  "mailboxNetworkPath",
  "mailboxReparsePoint",
  "journalRoot",
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
  "journalFileSystem",
  "journalDriveType",
  "journalLocalAbsolute",
  "journalNetworkPath",
  "journalReparsePoint",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "nativeHelperSha256",
  "nativeObservationSha256",
]);
const preparedEnrollmentKeys = Object.freeze([
  ...observationKeys,
  "preparedBrokerEnrollmentSha256",
]);
const refusalCodes = new Set(PROBE_BROKER_MAILBOX_REFUSAL_CODES);

export class ProbeBrokerMailboxProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerMailboxProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBrokerMailboxProtocolError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("BROKER_MAILBOX_SCHEMA", `${label} must be a plain object`);
  const actual = Object.keys(value).sort().join(",");
  const expected = [...keys].sort().join(",");
  if (actual !== expected) fail("BROKER_MAILBOX_SCHEMA", `${label} has an invalid shape`);
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_MAILBOX_SHA256", `${label} must be lowercase 64-hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || value.length > 96 || !identifierPattern.test(value)) {
    fail("BROKER_MAILBOX_IDENTIFIER", `${label} must be bounded lowercase kebab-case`);
  }
  return value;
}

function requireEnvironmentId(value, label) {
  if (!PROBE_ENVIRONMENT_IDS.includes(value)) {
    fail("BROKER_MAILBOX_ENVIRONMENT", `${label} is outside the probe campaign`);
  }
  return value;
}

function requireRole(value, label) {
  if (!PROBE_BROKER_ROLES.includes(value)) {
    fail("BROKER_MAILBOX_ROLE", `${label} is not a broker role`);
  }
  return value;
}

function requireLocalBrokerRoot(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 4096 ||
    value !== value.normalize("NFC") ||
    !windowsDriveRootPattern.test(value) ||
    value.includes("/") ||
    value.startsWith("\\\\") ||
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\")
  ) {
    fail("BROKER_MAILBOX_ROOT", `${label} must be an absolute local Windows drive path`);
  }
  const segments = value.slice(3).split("\\");
  if (
    segments.some((segment) => {
      const baseName = segment.split(".", 1)[0];
      return (
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !printableAsciiPathComponent.test(segment) ||
        segment.includes(":") ||
        forbiddenWindowsPathCharacter.test(segment) ||
        [...segment].some((character) => character.codePointAt(0) <= 0x1f) ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        reservedDosDeviceNamePattern.test(baseName)
      );
    })
  ) {
    fail("BROKER_MAILBOX_ROOT", `${label} contains an unsafe Windows path segment`);
  }
  return value;
}

function requireSecurityProfile(value, label) {
  if (value !== PROBE_BROKER_MAILBOX_SECURITY_PROFILE) {
    fail("BROKER_MAILBOX_SECURITY_PROFILE", `${label} is not the frozen mailbox profile`);
  }
  return value;
}

function requireJournalSecurityProfile(value, label) {
  if (value !== PROBE_BROKER_JOURNAL_SECURITY_PROFILE) {
    fail("BROKER_MAILBOX_SECURITY_PROFILE", `${label} is not the frozen journal profile`);
  }
  return value;
}

function requireNullableSha256(value, label) {
  if (value === null) return null;
  return requireSha256(value, label);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function digestPayload(value, digestKey) {
  const { [digestKey]: _digest, ...payload } = value;
  return payload;
}

function foldedRootComponents(value) {
  return [
    value.slice(0, 2).toLowerCase(),
    ...value
      .slice(3)
      .split("\\")
      .map((segment) => segment.toLowerCase()),
  ];
}

function isComponentPrefix(left, right) {
  return (
    left.length <= right.length && left.every((component, index) => component === right[index])
  );
}

function assertDisjointRoots(values, label) {
  const roots = values.map((value) => ({ value, components: foldedRootComponents(value) }));
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex];
      const right = roots[rightIndex];
      if (
        isComponentPrefix(left.components, right.components) ||
        isComponentPrefix(right.components, left.components)
      ) {
        fail("BROKER_MAILBOX_ROOT_OVERLAP", `${label} must contain pairwise disjoint roots`);
      }
    }
  }
}

export function deriveProbeBrokerEnrollmentDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-enrollment.v1",
    enrollment: digestPayload(value, "brokerEnrollmentSha256"),
  });
}

function validateEnrollmentFields(value, { withDigest }) {
  assertExactKeys(
    value,
    withDigest ? enrollmentKeys : enrollmentKeys.filter((key) => key !== "brokerEnrollmentSha256"),
    "broker enrollment",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_ENROLLMENT_KIND
  ) {
    fail("BROKER_MAILBOX_ENROLLMENT", "broker enrollment identity is invalid");
  }
  const brokerRole = requireRole(value.brokerRole, "brokerEnrollment.brokerRole");
  const peerAuthoritySha256 = requireNullableSha256(
    value.peerAuthoritySha256,
    "brokerEnrollment.peerAuthoritySha256",
  );
  if ((brokerRole === "remote-peer") !== (peerAuthoritySha256 !== null)) {
    fail(
      "BROKER_MAILBOX_PEER_AUTHORITY",
      "only the remote-peer enrollment may bind a peer authority",
    );
  }
  const normalized = {
    schemaVersion: PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION,
    kind: PROBE_BROKER_ENROLLMENT_KIND,
    environmentId: requireEnvironmentId(value.environmentId, "brokerEnrollment.environmentId"),
    brokerRole,
    brokerInstanceId: requireIdentifier(
      value.brokerInstanceId,
      "brokerEnrollment.brokerInstanceId",
    ),
    mailboxRoot: requireLocalBrokerRoot(value.mailboxRoot, "brokerEnrollment.mailboxRoot"),
    mailboxSecurityProfile: requireSecurityProfile(
      value.mailboxSecurityProfile,
      "brokerEnrollment.mailboxSecurityProfile",
    ),
    mailboxAclSha256: requireSha256(value.mailboxAclSha256, "brokerEnrollment.mailboxAclSha256"),
    journalRoot: requireLocalBrokerRoot(value.journalRoot, "brokerEnrollment.journalRoot"),
    journalSecurityProfile: requireJournalSecurityProfile(
      value.journalSecurityProfile,
      "brokerEnrollment.journalSecurityProfile",
    ),
    journalRootAclSha256: requireSha256(
      value.journalRootAclSha256,
      "brokerEnrollment.journalRootAclSha256",
    ),
    journalDatabaseAclSha256: requireSha256(
      value.journalDatabaseAclSha256,
      "brokerEnrollment.journalDatabaseAclSha256",
    ),
    processSidSha256: requireSha256(value.processSidSha256, "brokerEnrollment.processSidSha256"),
    peerAuthoritySha256,
  };
  assertDisjointRoots([normalized.mailboxRoot, normalized.journalRoot], "broker enrollment");
  return normalized;
}

export function createProbeBrokerEnrollment(input) {
  assertExactKeys(
    input,
    [
      "environmentId",
      "brokerRole",
      "brokerInstanceId",
      "mailboxRoot",
      "mailboxAclSha256",
      "journalRoot",
      "journalRootAclSha256",
      "journalDatabaseAclSha256",
      "processSidSha256",
      "peerAuthoritySha256",
    ],
    "broker enrollment input",
  );
  const fields = validateEnrollmentFields(
    {
      schemaVersion: PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION,
      kind: PROBE_BROKER_ENROLLMENT_KIND,
      ...input,
      mailboxSecurityProfile: PROBE_BROKER_MAILBOX_SECURITY_PROFILE,
      journalSecurityProfile: PROBE_BROKER_JOURNAL_SECURITY_PROFILE,
    },
    { withDigest: false },
  );
  return deepFreeze({
    ...fields,
    brokerEnrollmentSha256: deriveProbeBrokerEnrollmentDigest(fields),
  });
}

export function validateProbeBrokerEnrollment(value) {
  const fields = validateEnrollmentFields(value, { withDigest: true });
  requireSha256(value.brokerEnrollmentSha256, "brokerEnrollment.brokerEnrollmentSha256");
  if (value.brokerEnrollmentSha256 !== deriveProbeBrokerEnrollmentDigest(value)) {
    fail("BROKER_MAILBOX_ENROLLMENT_DIGEST", "broker enrollment digest mismatch");
  }
  return deepFreeze({ ...fields, brokerEnrollmentSha256: value.brokerEnrollmentSha256 });
}

export function validateProbeBrokerEnrollmentInventory(value) {
  const expected = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
    PROBE_BROKER_ROLES.map((brokerRole) => ({ environmentId, brokerRole })),
  );
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail(
      "BROKER_MAILBOX_ENROLLMENT_INVENTORY",
      "broker enrollment inventory must contain every environment and role",
    );
  }
  const enrollments = value.map((entry, index) => {
    const enrollment = validateProbeBrokerEnrollment(entry);
    if (
      enrollment.environmentId !== expected[index].environmentId ||
      enrollment.brokerRole !== expected[index].brokerRole
    ) {
      fail(
        "BROKER_MAILBOX_ENROLLMENT_ORDER",
        "broker enrollment inventory must use canonical environment/role order",
      );
    }
    return enrollment;
  });
  const instanceIds = new Set(enrollments.map((entry) => entry.brokerInstanceId));
  const digests = new Set(enrollments.map((entry) => entry.brokerEnrollmentSha256));
  if (instanceIds.size !== enrollments.length || digests.size !== enrollments.length) {
    fail(
      "BROKER_MAILBOX_ENROLLMENT_COLLISION",
      "broker enrollment instances and digests must be globally unique",
    );
  }
  assertDisjointRoots(
    enrollments.flatMap((entry) => [entry.mailboxRoot, entry.journalRoot]),
    "broker enrollment inventory",
  );
  return deepFreeze(enrollments);
}

export function selectProbeBrokerEnrollments(value, environmentId) {
  requireEnvironmentId(environmentId, "environmentId");
  const selected = validateProbeBrokerEnrollmentInventory(value).filter(
    (entry) => entry.environmentId === environmentId,
  );
  if (selected.length !== PROBE_BROKER_ROLES.length) {
    fail("BROKER_MAILBOX_ENROLLMENT_INVENTORY", "environment has an incomplete enrollment set");
  }
  return deepFreeze(selected);
}

function validateObservationFields(value, { prepared }) {
  assertExactKeys(
    value,
    prepared ? preparedEnrollmentKeys : observationKeys,
    "broker mailbox fact",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION ||
    value.kind !==
      (prepared ? PROBE_PREPARED_BROKER_ENROLLMENT_KIND : PROBE_BROKER_MAILBOX_OBSERVATION_KIND)
  ) {
    fail("BROKER_MAILBOX_OBSERVATION", "broker mailbox fact identity is invalid");
  }
  const brokerRole = requireRole(value.brokerRole, "brokerMailboxFact.brokerRole");
  const peerAuthoritySha256 = requireNullableSha256(
    value.peerAuthoritySha256,
    "brokerMailboxFact.peerAuthoritySha256",
  );
  if ((brokerRole === "remote-peer") !== (peerAuthoritySha256 !== null)) {
    fail(
      "BROKER_MAILBOX_PEER_AUTHORITY",
      "only the remote-peer mailbox fact may bind a peer authority",
    );
  }
  if (
    value.mailboxFileSystem !== "NTFS" ||
    value.mailboxDriveType !== "fixed" ||
    value.mailboxLocalAbsolute !== true ||
    value.mailboxNetworkPath !== false ||
    value.mailboxReparsePoint !== false
  ) {
    fail("BROKER_MAILBOX_POSTURE", "broker mailbox must be a local non-reparse path on fixed NTFS");
  }
  if (
    value.journalFileSystem !== "NTFS" ||
    value.journalDriveType !== "fixed" ||
    value.journalLocalAbsolute !== true ||
    value.journalNetworkPath !== false ||
    value.journalReparsePoint !== false
  ) {
    fail("BROKER_MAILBOX_POSTURE", "broker journal must be a local non-reparse path on fixed NTFS");
  }
  const shaKeys = [
    "brokerEnrollmentSha256",
    "mailboxAclSha256",
    "mailboxOwnerSidSha256",
    "processSidSha256",
    "mailboxRootObjectIdentitySha256",
    "mailboxVolumeIdSha256",
    "mailboxTransportIdentitySha256",
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
    "bootIdSha256",
    "runnerSessionIdSha256",
    "nativeHelperSha256",
    "nativeObservationSha256",
  ];
  const normalized = {
    schemaVersion: PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION,
    kind: prepared ? PROBE_PREPARED_BROKER_ENROLLMENT_KIND : PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
    brokerEnrollmentSha256: value.brokerEnrollmentSha256,
    environmentId: requireEnvironmentId(value.environmentId, "brokerMailboxFact.environmentId"),
    brokerRole,
    brokerInstanceId: requireIdentifier(
      value.brokerInstanceId,
      "brokerMailboxFact.brokerInstanceId",
    ),
    mailboxRoot: requireLocalBrokerRoot(value.mailboxRoot, "brokerMailboxFact.mailboxRoot"),
    mailboxSecurityProfile: requireSecurityProfile(
      value.mailboxSecurityProfile,
      "brokerMailboxFact.mailboxSecurityProfile",
    ),
    mailboxAclSha256: value.mailboxAclSha256,
    mailboxOwnerSidSha256: value.mailboxOwnerSidSha256,
    processSidSha256: value.processSidSha256,
    peerAuthoritySha256,
    mailboxRootObjectIdentitySha256: value.mailboxRootObjectIdentitySha256,
    mailboxVolumeIdSha256: value.mailboxVolumeIdSha256,
    mailboxTransportIdentitySha256: value.mailboxTransportIdentitySha256,
    mailboxFileSystem: "NTFS",
    mailboxDriveType: "fixed",
    mailboxLocalAbsolute: true,
    mailboxNetworkPath: false,
    mailboxReparsePoint: false,
    journalRoot: requireLocalBrokerRoot(value.journalRoot, "brokerMailboxFact.journalRoot"),
    journalSecurityProfile: requireJournalSecurityProfile(
      value.journalSecurityProfile,
      "brokerMailboxFact.journalSecurityProfile",
    ),
    journalRootPathSha256: value.journalRootPathSha256,
    journalRootObjectIdentitySha256: value.journalRootObjectIdentitySha256,
    journalVolumeIdSha256: value.journalVolumeIdSha256,
    journalRootOwnerSidSha256: value.journalRootOwnerSidSha256,
    journalRootAclSha256: value.journalRootAclSha256,
    journalDatabasePathSha256: value.journalDatabasePathSha256,
    journalDatabaseObjectIdentitySha256: value.journalDatabaseObjectIdentitySha256,
    journalDatabaseOwnerSidSha256: value.journalDatabaseOwnerSidSha256,
    journalDatabaseAclSha256: value.journalDatabaseAclSha256,
    journalTransportIdentitySha256: value.journalTransportIdentitySha256,
    journalFileSystem: "NTFS",
    journalDriveType: "fixed",
    journalLocalAbsolute: true,
    journalNetworkPath: false,
    journalReparsePoint: false,
    bootIdSha256: value.bootIdSha256,
    runnerSessionIdSha256: value.runnerSessionIdSha256,
    nativeHelperSha256: value.nativeHelperSha256,
    nativeObservationSha256: value.nativeObservationSha256,
  };
  for (const key of shaKeys) requireSha256(normalized[key], `brokerMailboxFact.${key}`);
  assertDisjointRoots([normalized.mailboxRoot, normalized.journalRoot], "broker mailbox fact");
  if (
    normalized.mailboxOwnerSidSha256 !== normalized.processSidSha256 ||
    normalized.journalRootOwnerSidSha256 !== normalized.processSidSha256 ||
    normalized.journalDatabaseOwnerSidSha256 !== normalized.processSidSha256
  ) {
    fail(
      "BROKER_MAILBOX_OWNER",
      "broker mailbox and journal objects must be owned by the broker process identity",
    );
  }
  if (
    new Set([
      normalized.mailboxRootObjectIdentitySha256,
      normalized.journalRootObjectIdentitySha256,
      normalized.journalDatabaseObjectIdentitySha256,
    ]).size !== 3 ||
    normalized.mailboxTransportIdentitySha256 === normalized.journalTransportIdentitySha256
  ) {
    fail(
      "BROKER_MAILBOX_PREPARED_COLLISION",
      "broker mailbox, journal root, and journal database identities must be distinct",
    );
  }
  return normalized;
}

export function validateProbeBrokerMailboxObservation(value) {
  return deepFreeze(validateObservationFields(value, { prepared: false }));
}

export function deriveProbePreparedBrokerEnrollmentDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-prepared-broker-enrollment.v1",
    enrollment: digestPayload(value, "preparedBrokerEnrollmentSha256"),
  });
}

export function createProbePreparedBrokerEnrollment(enrollmentValue, observationValue) {
  const enrollment = validateProbeBrokerEnrollment(enrollmentValue);
  const observation = validateProbeBrokerMailboxObservation(observationValue);
  for (const key of [
    "brokerEnrollmentSha256",
    "environmentId",
    "brokerRole",
    "brokerInstanceId",
    "mailboxRoot",
    "mailboxSecurityProfile",
    "mailboxAclSha256",
    "journalRoot",
    "journalSecurityProfile",
    "journalRootAclSha256",
    "journalDatabaseAclSha256",
    "processSidSha256",
    "peerAuthoritySha256",
  ]) {
    if (observation[key] !== enrollment[key]) {
      fail(
        "BROKER_MAILBOX_ENROLLMENT_BINDING",
        `broker mailbox observation differs from enrollment field ${key}`,
      );
    }
  }
  const fields = {
    ...observation,
    kind: PROBE_PREPARED_BROKER_ENROLLMENT_KIND,
  };
  return deepFreeze({
    ...fields,
    preparedBrokerEnrollmentSha256: deriveProbePreparedBrokerEnrollmentDigest(fields),
  });
}

export function validateProbePreparedBrokerEnrollment(value) {
  const fields = validateObservationFields(value, { prepared: true });
  validateProbeBrokerEnrollment({
    schemaVersion: fields.schemaVersion,
    kind: PROBE_BROKER_ENROLLMENT_KIND,
    environmentId: fields.environmentId,
    brokerRole: fields.brokerRole,
    brokerInstanceId: fields.brokerInstanceId,
    mailboxRoot: fields.mailboxRoot,
    mailboxSecurityProfile: fields.mailboxSecurityProfile,
    mailboxAclSha256: fields.mailboxAclSha256,
    journalRoot: fields.journalRoot,
    journalSecurityProfile: fields.journalSecurityProfile,
    journalRootAclSha256: fields.journalRootAclSha256,
    journalDatabaseAclSha256: fields.journalDatabaseAclSha256,
    processSidSha256: fields.processSidSha256,
    peerAuthoritySha256: fields.peerAuthoritySha256,
    brokerEnrollmentSha256: fields.brokerEnrollmentSha256,
  });
  requireSha256(
    value.preparedBrokerEnrollmentSha256,
    "preparedBrokerEnrollment.preparedBrokerEnrollmentSha256",
  );
  if (value.preparedBrokerEnrollmentSha256 !== deriveProbePreparedBrokerEnrollmentDigest(value)) {
    fail("BROKER_MAILBOX_PREPARED_DIGEST", "prepared broker enrollment digest mismatch");
  }
  return deepFreeze({
    ...fields,
    preparedBrokerEnrollmentSha256: value.preparedBrokerEnrollmentSha256,
  });
}

export function validateProbePreparedBrokerEnrollmentSet(value, environmentId) {
  requireEnvironmentId(environmentId, "environmentId");
  if (!Array.isArray(value) || value.length !== PROBE_BROKER_ROLES.length) {
    fail(
      "BROKER_MAILBOX_PREPARED_SET",
      "prepared broker enrollments must contain exactly three roles",
    );
  }
  const prepared = value.map((entry, index) => {
    const enrollment = validateProbePreparedBrokerEnrollment(entry);
    if (
      enrollment.environmentId !== environmentId ||
      enrollment.brokerRole !== PROBE_BROKER_ROLES[index]
    ) {
      fail(
        "BROKER_MAILBOX_PREPARED_ORDER",
        "prepared broker enrollments must use canonical role order for one environment",
      );
    }
    return enrollment;
  });
  const enrollmentDigests = new Set(prepared.map((entry) => entry.brokerEnrollmentSha256));
  const bindingDigests = new Set(prepared.map((entry) => entry.preparedBrokerEnrollmentSha256));
  const rootObjectIdentities = new Set(
    prepared.flatMap((entry) => [
      entry.mailboxRootObjectIdentitySha256,
      entry.journalRootObjectIdentitySha256,
      entry.journalDatabaseObjectIdentitySha256,
    ]),
  );
  const transportIdentities = new Set(
    prepared.flatMap((entry) => [
      entry.mailboxTransportIdentitySha256,
      entry.journalTransportIdentitySha256,
    ]),
  );
  if (
    enrollmentDigests.size !== prepared.length ||
    bindingDigests.size !== prepared.length ||
    rootObjectIdentities.size !== prepared.length * 3 ||
    transportIdentities.size !== prepared.length * 2
  ) {
    fail(
      "BROKER_MAILBOX_PREPARED_COLLISION",
      "prepared broker enrollment and physical storage identities must be unique",
    );
  }
  assertDisjointRoots(
    prepared.flatMap((entry) => [entry.mailboxRoot, entry.journalRoot]),
    "prepared broker enrollment set",
  );
  return deepFreeze(prepared);
}

function deriveEnvelopeDigest(domain, value, digestKey) {
  return hashProbeCanonicalJson({ domain, envelope: digestPayload(value, digestKey) });
}

export function deriveProbeBrokerMailboxTaskEnvelopeDigest(value) {
  return deriveEnvelopeDigest(
    "enduragent.windows-host-probe-broker-mailbox-task.v1",
    value,
    "taskEnvelopeSha256",
  );
}

export function createProbeBrokerMailboxTaskEnvelope(taskValue) {
  const task = validateProbeBrokerTask(taskValue);
  const fields = {
    schemaVersion: PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION,
    kind: PROBE_BROKER_MAILBOX_TASK_KIND,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    brokerRole: task.brokerRole,
    brokerInstanceId: task.brokerInstanceId,
    semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(task),
    physicalOperationKeySha256: deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    taskSha256: task.taskSha256,
    task,
  };
  return deepFreeze({
    ...fields,
    taskEnvelopeSha256: deriveProbeBrokerMailboxTaskEnvelopeDigest(fields),
  });
}

export function validateProbeBrokerMailboxTaskEnvelope(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "brokerEnrollmentSha256",
      "brokerRole",
      "brokerInstanceId",
      "semanticKeySha256",
      "physicalOperationKeySha256",
      "taskSha256",
      "task",
      "taskEnvelopeSha256",
    ],
    "broker mailbox task envelope",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_MAILBOX_TASK_KIND
  ) {
    fail("BROKER_MAILBOX_TASK_ENVELOPE", "broker mailbox task envelope identity is invalid");
  }
  const task = validateProbeBrokerTask(value.task);
  for (const key of ["brokerEnrollmentSha256", "brokerRole", "brokerInstanceId", "taskSha256"]) {
    if (value[key] !== task[key]) {
      fail("BROKER_MAILBOX_TASK_BINDING", `task envelope differs from task field ${key}`);
    }
  }
  for (const key of [
    "brokerEnrollmentSha256",
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "taskSha256",
    "taskEnvelopeSha256",
  ]) {
    requireSha256(value[key], `brokerMailboxTask.${key}`);
  }
  if (
    value.semanticKeySha256 !== deriveProbeBrokerTaskSemanticKeySha256(task) ||
    value.physicalOperationKeySha256 !== deriveProbeBrokerTaskPhysicalOperationKeySha256(task) ||
    value.taskEnvelopeSha256 !== deriveProbeBrokerMailboxTaskEnvelopeDigest(value)
  ) {
    fail("BROKER_MAILBOX_TASK_DIGEST", "broker mailbox task envelope digest binding is invalid");
  }
  return deepFreeze({ ...value, task });
}

function assertResultMatchesTask(result, task) {
  if (
    result.taskSha256 !== task.taskSha256 ||
    result.brokerEnrollmentSha256 !== task.brokerEnrollmentSha256 ||
    result.brokerInstanceId !== task.brokerInstanceId ||
    result.brokerRole !== task.brokerRole ||
    result.driverResult.driverId !== task.driverRequest.driverId ||
    result.bootIdSha256 !== task.bootIdSha256 ||
    result.runnerSessionIdSha256 !== task.runnerSessionIdSha256 ||
    canonicalProbeJson(result.actor) !== canonicalProbeJson(task.expectedActor)
  ) {
    fail("BROKER_MAILBOX_RESULT_BINDING", "broker result differs from its mailbox task");
  }
  if (task.execution.nativeTranscriptRequired && result.observerTranscripts.length === 0) {
    fail("BROKER_MAILBOX_RESULT_BINDING", "broker result omitted its required native transcript");
  }
}

export function deriveProbeBrokerMailboxResultEnvelopeDigest(value) {
  return deriveEnvelopeDigest(
    "enduragent.windows-host-probe-broker-mailbox-result.v1",
    value,
    "resultEnvelopeSha256",
  );
}

export function createProbeBrokerMailboxResultEnvelope(
  taskValue,
  resultValue,
  controllerAcceptanceInputValue,
) {
  const task = validateProbeBrokerTask(taskValue);
  const result = validateProbeBrokerResult(resultValue);
  assertResultMatchesTask(result, task);
  const controllerAcceptanceInput = validateProbeBrokerControllerAcceptanceInputForTask(
    controllerAcceptanceInputValue,
    task,
    result,
  );
  const fields = {
    schemaVersion: PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION,
    kind: PROBE_BROKER_MAILBOX_RESULT_KIND,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    brokerRole: task.brokerRole,
    brokerInstanceId: task.brokerInstanceId,
    semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(task),
    physicalOperationKeySha256: deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    taskSha256: task.taskSha256,
    resultSha256: result.resultSha256,
    result,
    controllerAcceptanceInput,
  };
  return deepFreeze({
    ...fields,
    resultEnvelopeSha256: deriveProbeBrokerMailboxResultEnvelopeDigest(fields),
  });
}

export function validateProbeBrokerMailboxResultEnvelope(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "brokerEnrollmentSha256",
      "brokerRole",
      "brokerInstanceId",
      "semanticKeySha256",
      "physicalOperationKeySha256",
      "taskSha256",
      "resultSha256",
      "result",
      "controllerAcceptanceInput",
      "resultEnvelopeSha256",
    ],
    "broker mailbox result envelope",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_MAILBOX_RESULT_KIND
  ) {
    fail("BROKER_MAILBOX_RESULT_ENVELOPE", "broker mailbox result envelope identity is invalid");
  }
  const result = validateProbeBrokerResult(value.result);
  const controllerAcceptanceInput = validateProbeBrokerControllerAcceptanceInput(
    value.controllerAcceptanceInput,
  );
  for (const key of [
    "brokerEnrollmentSha256",
    "brokerRole",
    "brokerInstanceId",
    "taskSha256",
    "resultSha256",
  ]) {
    if (value[key] !== result[key]) {
      fail("BROKER_MAILBOX_RESULT_BINDING", `result envelope differs from result field ${key}`);
    }
  }
  if (
    controllerAcceptanceInput.brokerTaskSha256 !== value.taskSha256 ||
    controllerAcceptanceInput.brokerResultSha256 !== result.resultSha256 ||
    controllerAcceptanceInput.brokerEnrollmentSha256 !== result.brokerEnrollmentSha256 ||
    controllerAcceptanceInput.brokerInstanceId !== result.brokerInstanceId ||
    controllerAcceptanceInput.brokerRole !== result.brokerRole ||
    canonicalProbeJson(controllerAcceptanceInput.expectedActor) !==
      canonicalProbeJson(result.actor) ||
    controllerAcceptanceInput.bootIdSha256 !== result.bootIdSha256 ||
    controllerAcceptanceInput.runnerSessionIdSha256 !== result.runnerSessionIdSha256
  ) {
    fail(
      "BROKER_MAILBOX_RESULT_BINDING",
      "result envelope controller acceptance differs from its broker result",
    );
  }
  for (const key of [
    "brokerEnrollmentSha256",
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "taskSha256",
    "resultSha256",
    "resultEnvelopeSha256",
  ]) {
    requireSha256(value[key], `brokerMailboxResult.${key}`);
  }
  if (value.resultEnvelopeSha256 !== deriveProbeBrokerMailboxResultEnvelopeDigest(value)) {
    fail("BROKER_MAILBOX_RESULT_DIGEST", "broker mailbox result envelope digest mismatch");
  }
  return deepFreeze({ ...value, result, controllerAcceptanceInput });
}

export function deriveProbeBrokerMailboxRefusalEnvelopeDigest(value) {
  return deriveEnvelopeDigest(
    "enduragent.windows-host-probe-broker-mailbox-refusal.v1",
    value,
    "refusalEnvelopeSha256",
  );
}

export function createProbeBrokerMailboxRefusalEnvelope(taskValue, refusalCode) {
  const task = validateProbeBrokerTask(taskValue);
  if (!refusalCodes.has(refusalCode)) {
    fail("BROKER_MAILBOX_REFUSAL_CODE", "broker mailbox refusal code is invalid");
  }
  const fields = {
    schemaVersion: PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION,
    kind: PROBE_BROKER_MAILBOX_REFUSAL_KIND,
    brokerEnrollmentSha256: task.brokerEnrollmentSha256,
    brokerRole: task.brokerRole,
    brokerInstanceId: task.brokerInstanceId,
    semanticKeySha256: deriveProbeBrokerTaskSemanticKeySha256(task),
    physicalOperationKeySha256: deriveProbeBrokerTaskPhysicalOperationKeySha256(task),
    taskSha256: task.taskSha256,
    refusalCode,
  };
  return deepFreeze({
    ...fields,
    refusalEnvelopeSha256: deriveProbeBrokerMailboxRefusalEnvelopeDigest(fields),
  });
}

export function validateProbeBrokerMailboxRefusalEnvelope(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "brokerEnrollmentSha256",
      "brokerRole",
      "brokerInstanceId",
      "semanticKeySha256",
      "physicalOperationKeySha256",
      "taskSha256",
      "refusalCode",
      "refusalEnvelopeSha256",
    ],
    "broker mailbox refusal envelope",
  );
  if (
    value.schemaVersion !== PROBE_BROKER_MAILBOX_PROTOCOL_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_MAILBOX_REFUSAL_KIND ||
    !refusalCodes.has(value.refusalCode)
  ) {
    fail("BROKER_MAILBOX_REFUSAL_ENVELOPE", "broker mailbox refusal envelope is invalid");
  }
  requireRole(value.brokerRole, "brokerMailboxRefusal.brokerRole");
  requireIdentifier(value.brokerInstanceId, "brokerMailboxRefusal.brokerInstanceId");
  for (const key of [
    "brokerEnrollmentSha256",
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "taskSha256",
    "refusalEnvelopeSha256",
  ]) {
    requireSha256(value[key], `brokerMailboxRefusal.${key}`);
  }
  if (value.refusalEnvelopeSha256 !== deriveProbeBrokerMailboxRefusalEnvelopeDigest(value)) {
    fail("BROKER_MAILBOX_REFUSAL_DIGEST", "broker mailbox refusal envelope digest mismatch");
  }
  return deepFreeze({ ...value });
}
