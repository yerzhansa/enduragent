import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";

import { canonicalProbeJson } from "../probe-contract.mjs";
import { observeNativeBrokerStorage } from "../native-client.mjs";
import {
  validateProbeBrokerEnrollment,
  validateProbePreparedBrokerEnrollment,
} from "./mailbox-protocol.mjs";
import {
  createProbeBrokerMailboxObservationFromNativeStorage,
  validateProbeBrokerPreparedOperationAuthority,
} from "./native-authority.mjs";
import { PROBE_BROKER_RECOVERY_CLASSES } from "./protocol.mjs";
import { createProbeBrokerWorker } from "./worker.mjs";

export const PROBE_BROKER_ROLE_PROCESS_HOST_SCHEMA_VERSION = 1;
export const PROBE_BROKER_ROLE_PROCESS_HOST_KIND = "windows-host-probe-broker-role-process-host";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const optionKeys = Object.freeze([
  "nativeBuild",
  "brokerEnrollment",
  "mailboxStore",
  "controllerPublicKeyBytes",
  "driverRegistry",
  "now",
]);
const runKeys = Object.freeze([
  "preparedBrokerEnrollment",
  "preparedOperationAuthority",
  "expectedPreparedOperationAuthoritySha256",
]);
const nativeBuildKeys = Object.freeze([
  "assemblyPath",
  "buildDirectory",
  "candidateRoot",
  "candidateDirectory",
  "nativeHelperArtifactPath",
  "snapshotDirectory",
  "manifestPath",
  "candidateDigest",
  "assemblySha256",
  "sourceBundleSha256",
  "toolchainDigest",
  "manifestSha256",
  "sources",
  "toolchain",
]);
const nativeBuildIdentityKeys = Object.freeze([
  "candidateDigest",
  "assemblySha256",
  "sourceBundleSha256",
  "toolchainDigest",
  "manifestSha256",
  "sources",
  "toolchain",
]);
const sourceKeys = Object.freeze(["name", "sha256", "bytes"]);
const driverKeys = Object.freeze([
  "driverId",
  "requestSchemaSha256",
  "recoveryClass",
  "validateRequest",
  "execute",
  "reconcile",
]);
const evidenceStoreMethods = Object.freeze([
  "createDirectory",
  "writeBytes",
  "writeCanonicalJson",
  "readArtifact",
  "verifyArtifactSet",
  "scan",
  "list",
  "assertRootStable",
]);
let roleProcessPoison = null;

function assertRoleProcessHealthy() {
  if (roleProcessPoison === null) return;
  const error = new ProbeBrokerRoleProcessHostError(
    "BROKER_ROLE_PROCESS_EXIT_REQUIRED",
    "this process retained uncertain native authority and must terminate",
  );
  error.requiresProcessExit = true;
  error.cause = roleProcessPoison;
  throw error;
}

export class ProbeBrokerRoleProcessHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerRoleProcessHostError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBrokerRoleProcessHostError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value)) {
    fail("BROKER_ROLE_PROCESS_SCHEMA", `${label} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    })
  ) {
    fail("BROKER_ROLE_PROCESS_SCHEMA", `${label} has an invalid field set`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_ROLE_PROCESS_DIGEST", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("BROKER_ROLE_PROCESS_IDENTIFIER", `${label} must be a bounded identifier`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("BROKER_ROLE_PROCESS_SCHEMA", `${label} must be a non-empty string`);
  }
  return value;
}

function freezeDeep(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        fail("BROKER_ROLE_PROCESS_SCHEMA", "canonical arrays must be dense data arrays");
      }
      freezeDeep(descriptor.value);
    }
    const permitted = new Set(["length", ...value.map((_, index) => String(index))]);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !permitted.has(key))) {
      fail("BROKER_ROLE_PROCESS_SCHEMA", "canonical arrays contain unexpected properties");
    }
  } else {
    if (!exactObject(value)) {
      fail("BROKER_ROLE_PROCESS_SCHEMA", "canonical data must use plain objects");
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        fail("BROKER_ROLE_PROCESS_SCHEMA", "canonical objects must use enumerable data fields");
      }
      freezeDeep(descriptor.value);
    }
  }
  Object.freeze(value);
  return value;
}

function canonicalSnapshot(value, label) {
  try {
    return freezeDeep(JSON.parse(canonicalProbeJson(value)));
  } catch {
    fail("BROKER_ROLE_PROCESS_SCHEMA", `${label} must be canonical JSON data`);
  }
}

function canonicalEqual(left, right) {
  try {
    return canonicalProbeJson(left) === canonicalProbeJson(right);
  } catch {
    return false;
  }
}

function snapshotNativeBuild(value) {
  assertExactKeys(value, nativeBuildKeys, "broker role-process native build");
  for (const key of [
    "assemblyPath",
    "buildDirectory",
    "candidateRoot",
    "candidateDirectory",
    "nativeHelperArtifactPath",
    "snapshotDirectory",
    "manifestPath",
  ]) {
    requireString(value[key], `broker role-process native build.${key}`);
  }
  for (const key of [
    "candidateDigest",
    "assemblySha256",
    "sourceBundleSha256",
    "toolchainDigest",
    "manifestSha256",
  ]) {
    requireSha256(value[key], `broker role-process native build.${key}`);
  }
  if (!Array.isArray(value.sources) || !exactObject(value.toolchain)) {
    fail(
      "BROKER_ROLE_PROCESS_NATIVE_BUILD",
      "broker role-process native build inventory is invalid",
    );
  }
  const sourceNames = new Set();
  for (const [index, source] of value.sources.entries()) {
    assertExactKeys(source, sourceKeys, `broker role-process native source ${index}`);
    requireString(source.name, `broker role-process native source ${index}.name`);
    requireSha256(source.sha256, `broker role-process native source ${index}.sha256`);
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 0) {
      fail(
        "BROKER_ROLE_PROCESS_NATIVE_BUILD",
        `broker role-process native source ${index}.bytes is invalid`,
      );
    }
    if (sourceNames.has(source.name)) {
      fail(
        "BROKER_ROLE_PROCESS_NATIVE_BUILD",
        "broker role-process native source inventory contains a duplicate",
      );
    }
    sourceNames.add(source.name);
  }
  freezeDeep(value);
  canonicalSnapshot(value, "broker role-process native build");
  return value;
}

function nativeBuildIdentity(build) {
  return freezeDeep(Object.fromEntries(nativeBuildIdentityKeys.map((key) => [key, build[key]])));
}

function snapshotMailboxStore(value, expectedRoot) {
  if (!exactObject(value) || value.root !== expectedRoot) {
    fail(
      "BROKER_ROLE_PROCESS_MAILBOX_ROOT",
      "broker role-process mailbox store differs from its startup enrollment",
    );
  }
  const store = { root: expectedRoot };
  for (const method of evidenceStoreMethods) {
    const descriptor = Object.getOwnPropertyDescriptor(value, method);
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    ) {
      fail(
        "BROKER_ROLE_PROCESS_MAILBOX_STORE",
        `broker role-process mailbox store.${method} must be a data function`,
      );
    }
    store[method] = descriptor.value;
  }
  return Object.freeze(store);
}

function snapshotControllerPublicKey(value) {
  if (!(value instanceof Uint8Array)) {
    fail(
      "BROKER_ROLE_PROCESS_CONTROLLER_KEY",
      "broker role-process controller public key must be bytes",
    );
  }
  const bytes = Buffer.from(value);
  let key;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    fail(
      "BROKER_ROLE_PROCESS_CONTROLLER_KEY",
      "broker role-process controller public key must be SPKI DER",
    );
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !Buffer.from(key.export({ format: "der", type: "spki" })).equals(bytes)
  ) {
    fail(
      "BROKER_ROLE_PROCESS_CONTROLLER_KEY",
      "broker role-process controller public key must be canonical Ed25519 SPKI DER",
    );
  }
  return Buffer.from(bytes);
}

function snapshotDriverRegistry(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    fail("BROKER_ROLE_PROCESS_DRIVER_REGISTRY", "broker role-process driver registry is invalid");
  }
  const driverIds = new Set();
  return Object.freeze(
    value.map((driver, index) => {
      assertExactKeys(driver, driverKeys, `broker role-process driver ${index}`);
      requireIdentifier(driver.driverId, `broker role-process driver ${index}.driverId`);
      requireSha256(
        driver.requestSchemaSha256,
        `broker role-process driver ${index}.requestSchemaSha256`,
      );
      if (!PROBE_BROKER_RECOVERY_CLASSES.includes(driver.recoveryClass)) {
        fail(
          "BROKER_ROLE_PROCESS_DRIVER_REGISTRY",
          `broker role-process driver ${index}.recoveryClass is invalid`,
        );
      }
      for (const method of ["validateRequest", "execute", "reconcile"]) {
        if (typeof driver[method] !== "function") {
          fail(
            "BROKER_ROLE_PROCESS_DRIVER_REGISTRY",
            `broker role-process driver ${index}.${method} must be a function`,
          );
        }
      }
      if (driverIds.has(driver.driverId)) {
        fail(
          "BROKER_ROLE_PROCESS_DRIVER_REGISTRY",
          "broker role-process driver registry contains a duplicate",
        );
      }
      driverIds.add(driver.driverId);
      return Object.freeze({ ...driver });
    }),
  );
}

function assertPreparedBinding(prepared, enrollment, nativeBuild) {
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
    if (prepared[key] !== enrollment[key]) {
      fail(
        "BROKER_ROLE_PROCESS_ENROLLMENT_BINDING",
        `prepared broker enrollment differs from startup field ${key}`,
      );
    }
  }
  if (prepared.nativeHelperSha256 !== nativeBuild.assemblySha256) {
    fail(
      "BROKER_ROLE_PROCESS_NATIVE_BUILD",
      "prepared broker enrollment differs from the startup native helper",
    );
  }
}

function validateRun(
  value,
  enrollment,
  nativeBuild,
  controllerPublicKeySha256,
  availableDriverIds,
) {
  assertExactKeys(value, runKeys, "broker role-process run request");
  const preparedBrokerEnrollment = validateProbePreparedBrokerEnrollment(
    value.preparedBrokerEnrollment,
  );
  const preparedOperationAuthority = validateProbeBrokerPreparedOperationAuthority(
    value.preparedOperationAuthority,
  );
  requireSha256(
    value.expectedPreparedOperationAuthoritySha256,
    "broker role-process expected prepared operation authority digest",
  );
  assertPreparedBinding(preparedBrokerEnrollment, enrollment, nativeBuild);
  if (
    value.expectedPreparedOperationAuthoritySha256 !==
    preparedOperationAuthority.preparedOperationAuthoritySha256
  ) {
    fail(
      "BROKER_ROLE_PROCESS_AUTHORITY_PIN",
      "prepared operation authority differs from its external process pin",
    );
  }
  if (
    preparedOperationAuthority.preparedBrokerEnrollmentSha256 !==
      preparedBrokerEnrollment.preparedBrokerEnrollmentSha256 ||
    preparedOperationAuthority.brokerEnrollmentSha256 !== enrollment.brokerEnrollmentSha256 ||
    preparedOperationAuthority.brokerInstanceId !== enrollment.brokerInstanceId ||
    preparedOperationAuthority.brokerRole !== enrollment.brokerRole ||
    preparedOperationAuthority.coordinate.environmentId !== enrollment.environmentId
  ) {
    fail(
      "BROKER_ROLE_PROCESS_OPERATION_BINDING",
      "prepared operation authority differs from this role process",
    );
  }
  if (preparedOperationAuthority.controllerPublicKeySha256 !== controllerPublicKeySha256) {
    fail(
      "BROKER_ROLE_PROCESS_CONTROLLER_KEY",
      "prepared operation authority differs from the startup controller key",
    );
  }
  if (!availableDriverIds.has(preparedOperationAuthority.driverId)) {
    fail(
      "BROKER_ROLE_PROCESS_UNSUPPORTED_DRIVER",
      "prepared operation selected a driver unavailable to this role process",
    );
  }
  return Object.freeze({
    preparedBrokerEnrollment,
    preparedOperationAuthority,
    expectedPreparedOperationAuthoritySha256: value.expectedPreparedOperationAuthoritySha256,
  });
}

export function createProbeBrokerRoleProcessHost(options) {
  assertRoleProcessHealthy();
  assertExactKeys(options, optionKeys, "broker role-process host options");
  const brokerEnrollment = validateProbeBrokerEnrollment(options.brokerEnrollment);
  const nativeBuild = snapshotNativeBuild(options.nativeBuild);
  const mailboxStore = snapshotMailboxStore(options.mailboxStore, brokerEnrollment.mailboxRoot);
  const controllerPublicKeyBytes = snapshotControllerPublicKey(options.controllerPublicKeyBytes);
  const controllerPublicKeySha256 = createHash("sha256")
    .update(controllerPublicKeyBytes)
    .digest("hex");
  const driverRegistry = snapshotDriverRegistry(options.driverRegistry);
  const availableDriverIds = new Set(driverRegistry.map(({ driverId }) => driverId));
  if (typeof options.now !== "function") {
    fail("BROKER_ROLE_PROCESS_CLOCK", "broker role-process clock must be a function");
  }
  const now = options.now;
  const identity = freezeDeep({
    schemaVersion: PROBE_BROKER_ROLE_PROCESS_HOST_SCHEMA_VERSION,
    kind: PROBE_BROKER_ROLE_PROCESS_HOST_KIND,
    environmentId: brokerEnrollment.environmentId,
    brokerRole: brokerEnrollment.brokerRole,
    brokerInstanceId: brokerEnrollment.brokerInstanceId,
    brokerEnrollmentSha256: brokerEnrollment.brokerEnrollmentSha256,
    mailboxRoot: brokerEnrollment.mailboxRoot,
    journalRoot: brokerEnrollment.journalRoot,
    nativeHelperSha256: nativeBuild.assemblySha256,
    controllerPublicKeySha256,
  });
  let state = "ready";
  let observationActive = false;

  return Object.freeze({
    identity,
    state: () => state,
    async observeMailbox() {
      assertRoleProcessHealthy();
      if (state !== "ready" || observationActive) {
        fail(
          "BROKER_ROLE_PROCESS_BUSY",
          "broker role process cannot start another native observation",
        );
      }
      observationActive = true;
      try {
        const observed = await observeNativeBrokerStorage({
          build: nativeBuild,
          brokerEnrollment,
        });
        assertExactKeys(
          observed,
          ["brokerEnrollment", "build", "observation"],
          "native broker storage observation result",
        );
        if (
          !canonicalEqual(observed.brokerEnrollment, brokerEnrollment) ||
          !canonicalEqual(observed.build, nativeBuildIdentity(nativeBuild))
        ) {
          fail(
            "BROKER_ROLE_PROCESS_NATIVE_OBSERVATION",
            "native broker storage observation differs from startup authority",
          );
        }
        return createProbeBrokerMailboxObservationFromNativeStorage({
          brokerEnrollment,
          nativeHelperSha256: nativeBuild.assemblySha256,
          observation: observed.observation,
        });
      } catch (error) {
        if (error?.requiresProcessExit === true) {
          state = "exit-required";
          roleProcessPoison = error;
          process.exit(70);
          throw error;
        }
        throw error;
      } finally {
        observationActive = false;
      }
    },
    async runOnce(value) {
      assertRoleProcessHealthy();
      if (state !== "ready" || observationActive) {
        fail(
          "BROKER_ROLE_PROCESS_ALREADY_USED",
          "broker role process is one-shot and cannot run this operation",
        );
      }
      const run = validateRun(
        value,
        brokerEnrollment,
        nativeBuild,
        controllerPublicKeySha256,
        availableDriverIds,
      );
      const worker = createProbeBrokerWorker({
        nativeBuild,
        preparedBrokerEnrollment: run.preparedBrokerEnrollment,
        preparedOperationAuthority: run.preparedOperationAuthority,
        expectedPreparedOperationAuthoritySha256: run.expectedPreparedOperationAuthoritySha256,
        mailboxStore,
        journalRoot: brokerEnrollment.journalRoot,
        controllerPublicKeyBytes,
        driverRegistry,
        now,
      });
      state = "running";
      try {
        const result = await worker.run();
        state = "completed";
        return result;
      } catch (error) {
        if (error?.requiresProcessExit === true) {
          state = "exit-required";
          roleProcessPoison = error;
          process.exit(70);
          throw error;
        }
        state = "failed";
        throw error;
      }
    },
  });
}
