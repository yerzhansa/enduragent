import { createHash } from "node:crypto";

import { canonicalProbeJson, hashProbeCanonicalJson } from "../probe-contract.mjs";
import {
  openNativeBrokerContextChannel,
  validateNativeBrokerContextReceipt,
} from "../native-client.mjs";
import {
  acquireProbeBrokerExecutionAuthorityLease,
  releaseProbeBrokerExecutionAuthorityLease,
  withProbeBrokerExecutionAuthorityLease,
} from "./execution-authority.mjs";
import {
  PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
  validateProbeBrokerEnrollment,
  validateProbeBrokerMailboxObservation,
  validateProbePreparedBrokerEnrollment,
} from "./mailbox-protocol.mjs";
import {
  deriveProbeBrokerTaskPhysicalOperationKeySha256,
  deriveProbeBrokerTaskSemanticKeySha256,
  validateProbeBrokerTask,
} from "./protocol.mjs";

export const PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_SCHEMA_VERSION = 1;
export const PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_KIND =
  "windows-host-probe-broker-prepared-operation-authority";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const rowIdPattern = /^F-(?:0[1-9]|10)$/u;
const coordinateKeys = Object.freeze([
  "campaignRunId",
  "executionRunId",
  "attemptId",
  "workId",
  "environmentId",
  "pathProfileId",
  "rowId",
  "variantId",
  "repetition",
]);
const authorityKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "preparedRunGenerationSha256",
  "controllerIdentitySha256",
  "controllerPublicKeySha256",
  "candidateSha256",
  "runAuthorizationClaimReceiptSha256",
  "coordinate",
  "semanticKeySha256",
  "physicalOperationKeySha256",
  "runtimeActionIntentSha256",
  "operationId",
  "producerActionId",
  "driverId",
  "brokerEnrollmentSha256",
  "preparedBrokerEnrollmentSha256",
  "brokerInstanceId",
  "brokerRole",
  "preparedOperationAuthoritySha256",
]);
const authorityInputKeys = Object.freeze(
  authorityKeys.filter(
    (key) => !["schemaVersion", "kind", "preparedOperationAuthoritySha256"].includes(key),
  ),
);
const nativeStorageObservationOptionKeys = Object.freeze([
  "brokerEnrollment",
  "nativeHelperSha256",
  "observation",
]);

export class ProbeBrokerNativeAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerNativeAuthorityError";
    this.code = code;
  }
}

function releaseFailure(primary, releaseCause) {
  const error = new ProbeBrokerNativeAuthorityError(
    "BROKER_NATIVE_AUTHORITY_RELEASE",
    "native context channel could not be released; this process must terminate",
  );
  error.requiresProcessExit = true;
  error.cause =
    primary === null
      ? releaseCause
      : new AggregateError(
          [primary, releaseCause],
          "native authority validation and cleanup both failed",
        );
  return error;
}

function fail(code, message) {
  throw new ProbeBrokerNativeAuthorityError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeCanonical(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current !== null && typeof current === "object" && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) stack.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) fail("BROKER_NATIVE_AUTHORITY_SCHEMA", `${label} must be an object`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    })
  ) {
    fail("BROKER_NATIVE_AUTHORITY_SCHEMA", `${label} has an invalid field set`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_NATIVE_AUTHORITY_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("BROKER_NATIVE_AUTHORITY_IDENTIFIER", `${label} must be a bounded identifier`);
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateCoordinate(value) {
  assertExactKeys(value, coordinateKeys, "prepared operation coordinate");
  for (const key of ["campaignRunId", "executionRunId", "attemptId", "workId", "variantId"]) {
    requireIdentifier(value[key], `prepared operation coordinate.${key}`);
  }
  if (
    !["win11-floor", "win11-current"].includes(value.environmentId) ||
    !["ascii", "spaces-unicode"].includes(value.pathProfileId) ||
    typeof value.rowId !== "string" ||
    !rowIdPattern.test(value.rowId) ||
    (value.repetition !== null && (!Number.isSafeInteger(value.repetition) || value.repetition < 1))
  ) {
    fail("BROKER_NATIVE_AUTHORITY_COORDINATE", "prepared operation coordinate is invalid");
  }
  return value;
}

function authorityDigestPayload(value) {
  const { preparedOperationAuthoritySha256: _digest, ...payload } = value;
  return payload;
}

export function deriveProbeBrokerPreparedOperationAuthorityDigest(value) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-prepared-operation-authority.v1",
    authority: authorityDigestPayload(value),
  });
}

export function validateProbeBrokerPreparedOperationAuthority(value) {
  assertExactKeys(value, authorityKeys, "prepared broker operation authority");
  if (
    value.schemaVersion !== PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_KIND
  ) {
    fail("BROKER_NATIVE_AUTHORITY_IDENTITY", "prepared operation authority identity is invalid");
  }
  for (const key of [
    "preparedRunGenerationSha256",
    "controllerIdentitySha256",
    "controllerPublicKeySha256",
    "candidateSha256",
    "runAuthorizationClaimReceiptSha256",
    "semanticKeySha256",
    "physicalOperationKeySha256",
    "runtimeActionIntentSha256",
    "brokerEnrollmentSha256",
    "preparedBrokerEnrollmentSha256",
    "preparedOperationAuthoritySha256",
  ]) {
    requireSha256(value[key], `prepared operation authority.${key}`);
  }
  for (const key of ["operationId", "producerActionId", "driverId", "brokerInstanceId"]) {
    requireIdentifier(value[key], `prepared operation authority.${key}`);
  }
  if (!["primary-standard-user", "second-user", "remote-peer"].includes(value.brokerRole)) {
    fail("BROKER_NATIVE_AUTHORITY_ROLE", "prepared operation authority broker role is invalid");
  }
  validateCoordinate(value.coordinate);
  const expectedSemanticKeySha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-semantic-operation.v1",
    controllerIdentitySha256: value.controllerIdentitySha256,
    brokerEnrollmentSha256: value.brokerEnrollmentSha256,
    candidateSha256: value.candidateSha256,
    runAuthorizationClaimReceiptSha256: value.runAuthorizationClaimReceiptSha256,
    coordinate: value.coordinate,
    runtimeActionIntentSha256: value.runtimeActionIntentSha256,
    operationId: value.operationId,
    producerActionId: value.producerActionId,
  });
  const expectedPhysicalOperationKeySha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-physical-operation.v1",
    controllerIdentitySha256: value.controllerIdentitySha256,
    brokerEnrollmentSha256: value.brokerEnrollmentSha256,
    runtimeActionIntentSha256: value.runtimeActionIntentSha256,
    operationId: value.operationId,
    producerActionId: value.producerActionId,
  });
  if (
    value.semanticKeySha256 !== expectedSemanticKeySha256 ||
    value.physicalOperationKeySha256 !== expectedPhysicalOperationKeySha256
  ) {
    fail(
      "BROKER_NATIVE_AUTHORITY_OPERATION_KEY",
      "prepared operation authority operation keys do not match its trusted fields",
    );
  }
  if (
    value.preparedOperationAuthoritySha256 !==
    deriveProbeBrokerPreparedOperationAuthorityDigest(value)
  ) {
    fail("BROKER_NATIVE_AUTHORITY_DIGEST", "prepared operation authority digest mismatch");
  }
  return freezeCanonical(JSON.parse(canonicalProbeJson(value)));
}

export function assertProbeBrokerTaskMatchesPreparedOperationAuthority(taskValue, authorityValue) {
  const task = validateProbeBrokerTask(taskValue);
  const authority = validateProbeBrokerPreparedOperationAuthority(authorityValue);
  if (
    task.controllerIdentitySha256 !== authority.controllerIdentitySha256 ||
    task.controllerPublicKeySha256 !== authority.controllerPublicKeySha256 ||
    task.candidateSha256 !== authority.candidateSha256 ||
    task.runAuthorizationClaimReceiptSha256 !== authority.runAuthorizationClaimReceiptSha256 ||
    canonicalProbeJson(task.coordinate) !== canonicalProbeJson(authority.coordinate) ||
    task.runtimeActionIntentSha256 !== authority.runtimeActionIntentSha256 ||
    task.action.operationId !== authority.operationId ||
    task.action.producerActionId !== authority.producerActionId ||
    task.execution.driverId !== authority.driverId ||
    task.driverRequest.driverId !== authority.driverId ||
    task.brokerEnrollmentSha256 !== authority.brokerEnrollmentSha256 ||
    task.brokerInstanceId !== authority.brokerInstanceId ||
    task.brokerRole !== authority.brokerRole ||
    deriveProbeBrokerTaskSemanticKeySha256(task) !== authority.semanticKeySha256 ||
    deriveProbeBrokerTaskPhysicalOperationKeySha256(task) !== authority.physicalOperationKeySha256
  ) {
    fail(
      "BROKER_NATIVE_AUTHORITY_TASK_BINDING",
      "broker task differs from the independently prepared operation authority",
    );
  }
  return task;
}

export function createProbeBrokerPreparedOperationAuthority(input) {
  assertExactKeys(input, authorityInputKeys, "prepared broker operation authority input");
  const draft = {
    schemaVersion: PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_SCHEMA_VERSION,
    kind: PROBE_BROKER_PREPARED_OPERATION_AUTHORITY_KIND,
    ...input,
  };
  return validateProbeBrokerPreparedOperationAuthority({
    ...draft,
    preparedOperationAuthoritySha256: deriveProbeBrokerPreparedOperationAuthorityDigest(draft),
  });
}

function assertReceiptMatchesBinding(receiptValue, binding) {
  const receipt = validateNativeBrokerContextReceipt(receiptValue);
  if (
    receipt.mailboxRequestedPathSha256 !== sha256Text(binding.mailboxRoot) ||
    receipt.journalRootRequestedPathSha256 !== sha256Text(binding.journalRoot)
  ) {
    fail(
      "BROKER_NATIVE_AUTHORITY_PREPARED_MISMATCH",
      "native broker context differs from the prepared storage paths",
    );
  }
  for (const key of [
    "mailboxRootObjectIdentitySha256",
    "mailboxVolumeIdSha256",
    "mailboxOwnerSidSha256",
    "mailboxAclSha256",
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
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
    "nativeHelperSha256",
    "nativeObservationSha256",
  ]) {
    if (receipt[key] !== binding[key]) {
      fail(
        "BROKER_NATIVE_AUTHORITY_PREPARED_MISMATCH",
        `native broker context differs from prepared field ${key}`,
      );
    }
  }
  return receipt;
}

function observationFromValidatedReceipt(binding, receipt) {
  return validateProbeBrokerMailboxObservation({
    schemaVersion: 1,
    kind: PROBE_BROKER_MAILBOX_OBSERVATION_KIND,
    brokerEnrollmentSha256: binding.brokerEnrollmentSha256,
    environmentId: binding.environmentId,
    brokerRole: binding.brokerRole,
    brokerInstanceId: binding.brokerInstanceId,
    mailboxRoot: binding.mailboxRoot,
    mailboxSecurityProfile: binding.mailboxSecurityProfile,
    mailboxAclSha256: receipt.mailboxAclSha256,
    mailboxOwnerSidSha256: receipt.mailboxOwnerSidSha256,
    processSidSha256: receipt.processSidSha256,
    peerAuthoritySha256: binding.peerAuthoritySha256,
    mailboxRootObjectIdentitySha256: receipt.mailboxRootObjectIdentitySha256,
    mailboxVolumeIdSha256: receipt.mailboxVolumeIdSha256,
    mailboxTransportIdentitySha256: receipt.mailboxTransportIdentitySha256,
    mailboxFileSystem: receipt.mailboxFileSystem,
    mailboxDriveType: receipt.mailboxDriveType,
    mailboxLocalAbsolute: receipt.mailboxLocalAbsolute,
    mailboxNetworkPath: receipt.mailboxNetworkPath,
    mailboxReparsePoint: receipt.mailboxReparsePoint,
    journalRoot: binding.journalRoot,
    journalSecurityProfile: binding.journalSecurityProfile,
    journalRootPathSha256: receipt.journalRootPathSha256,
    journalRootObjectIdentitySha256: receipt.journalRootObjectIdentitySha256,
    journalVolumeIdSha256: receipt.journalVolumeIdSha256,
    journalRootOwnerSidSha256: receipt.journalRootOwnerSidSha256,
    journalRootAclSha256: receipt.journalRootAclSha256,
    journalDatabasePathSha256: receipt.journalDatabasePathSha256,
    journalDatabaseObjectIdentitySha256: receipt.journalDatabaseObjectIdentitySha256,
    journalDatabaseOwnerSidSha256: receipt.journalDatabaseOwnerSidSha256,
    journalDatabaseAclSha256: receipt.journalDatabaseAclSha256,
    journalTransportIdentitySha256: receipt.journalTransportIdentitySha256,
    journalFileSystem: receipt.journalFileSystem,
    journalDriveType: receipt.journalDriveType,
    journalLocalAbsolute: receipt.journalLocalAbsolute,
    journalNetworkPath: receipt.journalNetworkPath,
    journalReparsePoint: receipt.journalReparsePoint,
    bootIdSha256: receipt.bootIdSha256,
    runnerSessionIdSha256: receipt.runnerSessionIdSha256,
    nativeHelperSha256: receipt.nativeHelperSha256,
    nativeObservationSha256: receipt.nativeObservationSha256,
  });
}

function observationFromReceipt(binding, receiptValue) {
  return observationFromValidatedReceipt(
    binding,
    assertReceiptMatchesBinding(receiptValue, binding),
  );
}

export function createProbeBrokerMailboxObservationFromNativeStorage(options) {
  assertExactKeys(
    options,
    nativeStorageObservationOptionKeys,
    "native broker storage observation options",
  );
  const { brokerEnrollment, nativeHelperSha256, observation } = options;
  const enrollment = validateProbeBrokerEnrollment(brokerEnrollment);
  requireSha256(nativeHelperSha256, "native broker storage helper digest");
  const receipt = validateNativeBrokerContextReceipt(observation);
  if (
    receipt.kind !== "windows-host-native-broker-storage-observed" ||
    receipt.mailboxSecurityProfile !== enrollment.mailboxSecurityProfile ||
    receipt.mailboxRequestedPathSha256 !== sha256Text(enrollment.mailboxRoot) ||
    receipt.mailboxAclSha256 !== enrollment.mailboxAclSha256 ||
    receipt.mailboxOwnerSidSha256 !== enrollment.processSidSha256 ||
    receipt.processSidSha256 !== enrollment.processSidSha256 ||
    receipt.journalSecurityProfile !== enrollment.journalSecurityProfile ||
    receipt.journalRootRequestedPathSha256 !== sha256Text(enrollment.journalRoot) ||
    receipt.journalRootAclSha256 !== enrollment.journalRootAclSha256 ||
    receipt.journalRootOwnerSidSha256 !== enrollment.processSidSha256 ||
    receipt.journalDatabaseAclSha256 !== enrollment.journalDatabaseAclSha256 ||
    receipt.journalDatabaseOwnerSidSha256 !== enrollment.processSidSha256 ||
    receipt.nativeHelperSha256 !== nativeHelperSha256
  ) {
    fail(
      "BROKER_NATIVE_AUTHORITY_ENROLLMENT_MISMATCH",
      "native broker storage observation differs from its externally pinned enrollment",
    );
  }
  return observationFromValidatedReceipt(enrollment, receipt);
}

function executionSnapshot(authority, binding, receiptValue) {
  const receipt = assertReceiptMatchesBinding(receiptValue, binding);
  return Object.freeze({
    schemaVersion: 1,
    kind: "windows-host-probe-broker-execution-authority",
    preparedRunGenerationSha256: authority.preparedRunGenerationSha256,
    controllerIdentitySha256: authority.controllerIdentitySha256,
    controllerPublicKeySha256: authority.controllerPublicKeySha256,
    candidateSha256: authority.candidateSha256,
    runAuthorizationClaimReceiptSha256: authority.runAuthorizationClaimReceiptSha256,
    coordinate: authority.coordinate,
    semanticKeySha256: authority.semanticKeySha256,
    physicalOperationKeySha256: authority.physicalOperationKeySha256,
    runtimeActionIntentSha256: authority.runtimeActionIntentSha256,
    operationId: authority.operationId,
    producerActionId: authority.producerActionId,
    driverId: authority.driverId,
    brokerEnrollmentSha256: authority.brokerEnrollmentSha256,
    preparedBrokerEnrollmentSha256: binding.preparedBrokerEnrollmentSha256,
    brokerInstanceId: binding.brokerInstanceId,
    brokerRole: binding.brokerRole,
    mailboxRootObjectIdentitySha256: receipt.mailboxRootObjectIdentitySha256,
    mailboxVolumeIdSha256: receipt.mailboxVolumeIdSha256,
    mailboxTransportIdentitySha256: receipt.mailboxTransportIdentitySha256,
    mailboxAclSha256: receipt.mailboxAclSha256,
    mailboxOwnerSidSha256: receipt.mailboxOwnerSidSha256,
    journalRoot: binding.journalRoot,
    journalSecurityProfile: binding.journalSecurityProfile,
    journalRootPathSha256: receipt.journalRootPathSha256,
    journalRootObjectIdentitySha256: receipt.journalRootObjectIdentitySha256,
    journalVolumeIdSha256: receipt.journalVolumeIdSha256,
    journalRootOwnerSidSha256: receipt.journalRootOwnerSidSha256,
    journalRootAclSha256: receipt.journalRootAclSha256,
    journalDatabasePathSha256: receipt.journalDatabasePathSha256,
    journalDatabaseObjectIdentitySha256: receipt.journalDatabaseObjectIdentitySha256,
    journalDatabaseOwnerSidSha256: receipt.journalDatabaseOwnerSidSha256,
    journalDatabaseAclSha256: receipt.journalDatabaseAclSha256,
    journalTransportIdentitySha256: receipt.journalTransportIdentitySha256,
    processSidSha256: receipt.processSidSha256,
    bootIdSha256: receipt.bootIdSha256,
    runnerSessionIdSha256: receipt.runnerSessionIdSha256,
    nativeObservationSha256: receipt.nativeObservationSha256,
    peerAuthoritySha256: binding.peerAuthoritySha256,
  });
}

function validateAuthorityRequest(value, binding) {
  assertExactKeys(
    value,
    [
      "preparedBrokerEnrollmentSha256",
      "brokerEnrollmentSha256",
      "environmentId",
      "brokerRole",
      "brokerInstanceId",
      "mailboxRoot",
    ],
    "broker mailbox authority request",
  );
  for (const key of Object.keys(value)) {
    if (value[key] !== binding[key]) {
      fail(
        "BROKER_NATIVE_AUTHORITY_REQUEST",
        `mailbox authority request differs from prepared field ${key}`,
      );
    }
  }
}

export async function openProbeBrokerNativeAuthoritySession(options) {
  assertExactKeys(
    options,
    Object.hasOwn(options, "openContextChannel")
      ? [
          "build",
          "preparedMailboxBinding",
          "preparedOperationAuthority",
          "expectedPreparedOperationAuthoritySha256",
          "openContextChannel",
        ]
      : [
          "build",
          "preparedMailboxBinding",
          "preparedOperationAuthority",
          "expectedPreparedOperationAuthoritySha256",
        ],
    "native broker authority session options",
  );
  const binding = validateProbePreparedBrokerEnrollment(options.preparedMailboxBinding);
  const authority = validateProbeBrokerPreparedOperationAuthority(
    options.preparedOperationAuthority,
  );
  requireSha256(
    options.expectedPreparedOperationAuthoritySha256,
    "expected prepared operation authority digest",
  );
  if (
    authority.preparedOperationAuthoritySha256 !== options.expectedPreparedOperationAuthoritySha256
  ) {
    fail(
      "BROKER_NATIVE_AUTHORITY_TRUST_ANCHOR",
      "prepared operation authority differs from its external startup pin",
    );
  }
  if (
    authority.preparedBrokerEnrollmentSha256 !== binding.preparedBrokerEnrollmentSha256 ||
    authority.brokerEnrollmentSha256 !== binding.brokerEnrollmentSha256 ||
    authority.brokerInstanceId !== binding.brokerInstanceId ||
    authority.brokerRole !== binding.brokerRole ||
    authority.coordinate.environmentId !== binding.environmentId
  ) {
    fail(
      "BROKER_NATIVE_AUTHORITY_BINDING",
      "prepared operation authority differs from its prepared broker enrollment",
    );
  }
  const openContextChannel =
    options.openContextChannel ??
    (() =>
      openNativeBrokerContextChannel({
        build: options.build,
        preparedMailboxBinding: binding,
      }));
  if (typeof openContextChannel !== "function") {
    fail("BROKER_NATIVE_AUTHORITY_CHANNEL", "native context channel opener is invalid");
  }
  const channel = await openContextChannel();
  const acquiredDescriptor = exactObject(channel)
    ? Object.getOwnPropertyDescriptor(channel, "acquired")
    : undefined;
  const revalidateDescriptor = exactObject(channel)
    ? Object.getOwnPropertyDescriptor(channel, "revalidate")
    : undefined;
  const releaseDescriptor = exactObject(channel)
    ? Object.getOwnPropertyDescriptor(channel, "release")
    : undefined;
  const acquired =
    acquiredDescriptor?.enumerable === true && Object.hasOwn(acquiredDescriptor, "value")
      ? acquiredDescriptor.value
      : null;
  const revalidateChannel =
    revalidateDescriptor?.enumerable === true &&
    Object.hasOwn(revalidateDescriptor, "value") &&
    typeof revalidateDescriptor.value === "function"
      ? () => Reflect.apply(revalidateDescriptor.value, channel, [])
      : null;
  const releaseChannel =
    releaseDescriptor?.enumerable === true &&
    Object.hasOwn(releaseDescriptor, "value") &&
    typeof releaseDescriptor.value === "function"
      ? () => Reflect.apply(releaseDescriptor.value, channel, [])
      : null;
  if (
    !exactObject(channel) ||
    acquired === null ||
    revalidateChannel === null ||
    releaseChannel === null
  ) {
    if (releaseChannel !== null) {
      try {
        await releaseChannel();
      } catch (releaseCause) {
        throw releaseFailure(null, releaseCause);
      }
      fail("BROKER_NATIVE_AUTHORITY_CHANNEL", "native context channel is incomplete");
    }
    const error = new ProbeBrokerNativeAuthorityError(
      "BROKER_NATIVE_AUTHORITY_CHANNEL",
      "native context channel is incomplete and cannot be released; this process must terminate",
    );
    error.requiresProcessExit = true;
    throw error;
  }
  try {
    assertReceiptMatchesBinding(acquired, binding);
  } catch (error) {
    try {
      await releaseChannel();
    } catch (releaseCause) {
      throw releaseFailure(error, releaseCause);
    }
    throw error;
  }
  const executionAuthorityLease = await acquireProbeBrokerExecutionAuthorityLease({
    acquire: () => executionSnapshot(authority, binding, acquired),
    revalidate: async () => executionSnapshot(authority, binding, await revalidateChannel()),
    release: releaseChannel,
  });
  return Object.freeze({
    preparedOperationAuthority: authority,
    preparedMailboxBinding: binding,
    executionAuthorityLease,
    async assertMailboxAuthority(request) {
      validateAuthorityRequest(request, binding);
      return withProbeBrokerExecutionAuthorityLease(
        executionAuthorityLease,
        "mailbox-access",
        async () => observationFromReceipt(binding, await revalidateChannel()),
      );
    },
    release: () => releaseProbeBrokerExecutionAuthorityLease(executionAuthorityLease),
  });
}
