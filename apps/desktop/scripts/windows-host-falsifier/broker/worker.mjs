import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { canonicalProbeJson } from "../probe-contract.mjs";
import {
  confirmProbeBrokerExecutionAuthority,
  withProbeBrokerExecutionAuthorityLease,
} from "./execution-authority.mjs";
import { openProbeBrokerJournal } from "./journal.mjs";
import { openProbeBrokerMailbox } from "./mailbox.mjs";
import { validateProbePreparedBrokerEnrollment } from "./mailbox-protocol.mjs";
import {
  assertProbeBrokerTaskMatchesPreparedOperationAuthority,
  openProbeBrokerNativeAuthoritySession,
  validateProbeBrokerPreparedOperationAuthority,
} from "./native-authority.mjs";
import {
  PROBE_BROKER_RECOVERY_CLASSES,
  PROBE_BROKER_RESULT_OUTCOMES,
  createProbeBrokerControllerAcceptanceInput,
  createProbeBrokerDriverValidationReceipt,
  createProbeBrokerResult,
  validateProbeBrokerResult,
} from "./protocol.mjs";

export const PROBE_BROKER_WORKER_SCHEMA_VERSION = 1;
export const PROBE_BROKER_WORKER_DRIVER_TERMINAL_KIND =
  "windows-host-probe-broker-worker-driver-terminal";
export const PROBE_BROKER_WORKER_MANUAL_INTERVENTION_KIND =
  "windows-host-probe-broker-worker-manual-intervention";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const terminalKeys = Object.freeze([
  "schemaVersion",
  "kind",
  "effectSha256",
  "outcome",
  "driverResultArtifact",
  "proofArtifacts",
  "observerTranscripts",
  "pausedSessionReceipt",
  "artifacts",
]);
const manualKeys = Object.freeze(["schemaVersion", "kind", "reasonCode"]);
const driverKeys = Object.freeze([
  "driverId",
  "requestSchemaSha256",
  "recoveryClass",
  "validateRequest",
  "execute",
  "reconcile",
]);
const workerOptionKeys = Object.freeze([
  "nativeBuild",
  "preparedBrokerEnrollment",
  "preparedOperationAuthority",
  "expectedPreparedOperationAuthoritySha256",
  "mailboxStore",
  "journalRoot",
  "controllerPublicKeyBytes",
  "driverRegistry",
  "now",
]);
const activePhysicalOperations = new Set();

export class ProbeBrokerWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerWorkerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBrokerWorkerError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!exactObject(value)) fail("BROKER_WORKER_SCHEMA", `${label} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expectedKeys.length ||
    actual.some((key) => typeof key !== "string" || !expectedKeys.includes(key)) ||
    expectedKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    })
  ) {
    fail("BROKER_WORKER_SCHEMA", `${label} has an invalid field set`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_WORKER_DIGEST", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("BROKER_WORKER_IDENTIFIER", `${label} must be a bounded identifier`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function freezeDeep(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    ArrayBuffer.isView(value) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeReference(value, label, observer = false) {
  assertExactKeys(
    value,
    observer
      ? ["blobPath", "bytes", "sha256", "transcriptSha256"]
      : ["blobPath", "bytes", "sha256"],
    label,
  );
  requireSha256(value.sha256, `${label}.sha256`);
  if (observer) requireSha256(value.transcriptSha256, `${label}.transcriptSha256`);
  if (
    value.blobPath !== `blobs/sha256/${value.sha256}` ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0
  ) {
    fail("BROKER_WORKER_ARTIFACT", `${label} is not a content-addressed reference`);
  }
  return freezeDeep({ ...value });
}

function validateDriverTerminalHeader(value) {
  assertExactKeys(value, terminalKeys, "broker worker driver terminal");
  if (
    value.schemaVersion !== PROBE_BROKER_WORKER_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_WORKER_DRIVER_TERMINAL_KIND
  ) {
    fail("BROKER_WORKER_DRIVER_TERMINAL", "broker worker driver terminal identity is invalid");
  }
  requireSha256(value.effectSha256, "broker worker driver terminal.effectSha256");
  return value;
}

function validateArtifacts(values, expectedReferences) {
  if (!Array.isArray(values)) {
    fail("BROKER_WORKER_ARTIFACT", "broker worker terminal artifacts must be an array");
  }
  const expected = new Map();
  for (const [index, referenceValue] of expectedReferences.entries()) {
    const reference = normalizeReference(
      {
        blobPath: referenceValue.blobPath,
        bytes: referenceValue.bytes,
        sha256: referenceValue.sha256,
      },
      `broker worker expected artifact ${index}`,
    );
    const existing = expected.get(reference.sha256);
    if (existing !== undefined && canonicalProbeJson(existing) !== canonicalProbeJson(reference)) {
      fail("BROKER_WORKER_ARTIFACT", "one artifact digest names conflicting references");
    }
    expected.set(reference.sha256, reference);
  }
  const artifacts = new Map();
  for (const [index, value] of values.entries()) {
    assertExactKeys(value, ["reference", "bytes"], `broker worker artifact ${index}`);
    const reference = normalizeReference(
      value.reference,
      `broker worker artifact ${index}.reference`,
    );
    if (!(value.bytes instanceof Uint8Array)) {
      fail("BROKER_WORKER_ARTIFACT", `broker worker artifact ${index}.bytes must be bytes`);
    }
    const bytes = Buffer.from(value.bytes);
    if (bytes.byteLength !== reference.bytes || sha256(bytes) !== reference.sha256) {
      fail("BROKER_WORKER_ARTIFACT", `broker worker artifact ${index} differs from its reference`);
    }
    if (artifacts.has(reference.sha256)) {
      fail("BROKER_WORKER_ARTIFACT", "broker worker terminal contains duplicate artifacts");
    }
    artifacts.set(reference.sha256, freezeDeep({ reference, bytes }));
  }
  if (
    artifacts.size !== expected.size ||
    [...expected].some(
      ([digest, reference]) =>
        !artifacts.has(digest) ||
        canonicalProbeJson(artifacts.get(digest).reference) !== canonicalProbeJson(reference),
    )
  ) {
    fail("BROKER_WORKER_ARTIFACT", "broker worker terminal artifacts are not exact");
  }
  return Object.freeze([...expected.keys()].sort().map((digest) => artifacts.get(digest)));
}

function materializeDriverTerminal(value, task) {
  const terminal = validateDriverTerminalHeader(value);
  if (!PROBE_BROKER_RESULT_OUTCOMES.includes(terminal.outcome)) {
    fail("BROKER_WORKER_DRIVER_TERMINAL", "broker worker terminal outcome is invalid");
  }
  const driverResultArtifact = normalizeReference(
    terminal.driverResultArtifact,
    "broker worker terminal.driverResultArtifact",
  );
  if (!Array.isArray(terminal.proofArtifacts)) {
    fail("BROKER_WORKER_ARTIFACT", "broker worker proofArtifacts must be an array");
  }
  const proofArtifacts = Object.freeze(
    terminal.proofArtifacts.map((reference, index) =>
      normalizeReference(reference, `broker worker terminal.proofArtifacts[${index}]`),
    ),
  );
  if (!Array.isArray(terminal.observerTranscripts)) {
    fail("BROKER_WORKER_ARTIFACT", "broker worker observerTranscripts must be an array");
  }
  const observerTranscripts = Object.freeze(
    terminal.observerTranscripts.map((reference, index) =>
      normalizeReference(reference, `broker worker terminal.observerTranscripts[${index}]`, true),
    ),
  );
  const pausedSessionReceipt =
    terminal.pausedSessionReceipt === null
      ? null
      : normalizeReference(
          terminal.pausedSessionReceipt,
          "broker worker terminal.pausedSessionReceipt",
        );
  const result = validateProbeBrokerResult(
    createProbeBrokerResult({
      taskSha256: task.taskSha256,
      brokerEnrollmentSha256: task.brokerEnrollmentSha256,
      brokerInstanceId: task.brokerInstanceId,
      brokerRole: task.brokerRole,
      actor: task.expectedActor,
      bootIdSha256: task.bootIdSha256,
      runnerSessionIdSha256: task.runnerSessionIdSha256,
      outcome: terminal.outcome,
      driverResult: {
        schemaVersion: 1,
        kind: "windows-host-probe-broker-driver-result",
        driverId: task.driverRequest.driverId,
        resultArtifact: driverResultArtifact,
      },
      proofArtifacts,
      observerTranscripts,
      pausedSessionReceipt,
    }),
  );
  const references = [
    result.driverResult.resultArtifact,
    ...result.proofArtifacts,
    ...result.observerTranscripts,
    ...(result.pausedSessionReceipt === null ? [] : [result.pausedSessionReceipt]),
  ];
  return freezeDeep({
    effectSha256: terminal.effectSha256,
    result,
    artifacts: validateArtifacts(terminal.artifacts, references),
  });
}

function validateManualIntervention(value) {
  assertExactKeys(value, manualKeys, "broker worker manual intervention");
  if (
    value.schemaVersion !== PROBE_BROKER_WORKER_SCHEMA_VERSION ||
    value.kind !== PROBE_BROKER_WORKER_MANUAL_INTERVENTION_KIND
  ) {
    fail("BROKER_WORKER_MANUAL_INTERVENTION", "manual intervention identity is invalid");
  }
  requireIdentifier(value.reasonCode, "broker worker manual intervention.reasonCode");
  return freezeDeep({ ...value });
}

function validateDriverRegistry(value, selectedDriverId) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    fail("BROKER_WORKER_DRIVER_REGISTRY", "broker worker driver registry is invalid");
  }
  const drivers = new Map();
  for (const [index, driver] of value.entries()) {
    assertExactKeys(driver, driverKeys, `broker worker driver ${index}`);
    requireIdentifier(driver.driverId, `broker worker driver ${index}.driverId`);
    requireSha256(driver.requestSchemaSha256, `broker worker driver ${index}.requestSchemaSha256`);
    if (!PROBE_BROKER_RECOVERY_CLASSES.includes(driver.recoveryClass)) {
      fail("BROKER_WORKER_DRIVER_REGISTRY", "broker worker driver recovery class is invalid");
    }
    for (const method of ["validateRequest", "execute", "reconcile"]) {
      if (typeof driver[method] !== "function") {
        fail("BROKER_WORKER_DRIVER_REGISTRY", `broker worker driver.${method} must be a function`);
      }
    }
    if (drivers.has(driver.driverId)) {
      fail("BROKER_WORKER_DRIVER_REGISTRY", "broker worker driver registry contains a duplicate");
    }
    drivers.set(driver.driverId, Object.freeze({ ...driver }));
  }
  const selected = drivers.get(selectedDriverId);
  if (selected === undefined) {
    fail("BROKER_WORKER_UNSUPPORTED_DRIVER", "prepared operation selected an unavailable driver");
  }
  return selected;
}

function validateWorkerOptions(value) {
  if (!exactObject(value)) {
    fail("BROKER_WORKER_SCHEMA", "broker worker options must be a plain object");
  }
  const keys = Object.hasOwn(value, "openNativeBrokerContextChannel")
    ? [...workerOptionKeys, "openNativeBrokerContextChannel"]
    : workerOptionKeys;
  assertExactKeys(value, keys, "broker worker options");
  const preparedOperationAuthority = validateProbeBrokerPreparedOperationAuthority(
    value.preparedOperationAuthority,
  );
  const preparedBrokerEnrollment = validateProbePreparedBrokerEnrollment(
    value.preparedBrokerEnrollment,
  );
  requireSha256(
    value.expectedPreparedOperationAuthoritySha256,
    "broker worker expected prepared authority digest",
  );
  if (!(value.controllerPublicKeyBytes instanceof Uint8Array)) {
    fail("BROKER_WORKER_CONTROLLER_KEY", "broker worker controller public key must be bytes");
  }
  if (typeof value.journalRoot !== "string" || typeof value.now !== "function") {
    fail("BROKER_WORKER_OPTIONS", "broker worker journal root or clock is invalid");
  }
  if (
    Object.hasOwn(value, "openNativeBrokerContextChannel") &&
    typeof value.openNativeBrokerContextChannel !== "function"
  ) {
    fail("BROKER_WORKER_OPTIONS", "broker worker native context opener is invalid");
  }
  const selectedDriver = validateDriverRegistry(
    value.driverRegistry,
    preparedOperationAuthority.driverId,
  );
  return Object.freeze({
    ...value,
    preparedOperationAuthority,
    preparedBrokerEnrollment,
    controllerPublicKeyBytes: Buffer.from(value.controllerPublicKeyBytes),
    selectedDriver,
  });
}

function requestMatchesTask(request, task) {
  return (
    request.taskSha256 === task.taskSha256 &&
    request.driverId === task.driverRequest.driverId &&
    canonicalProbeJson(request.execution) === canonicalProbeJson(task.execution) &&
    canonicalProbeJson(request.requestArtifact) ===
      canonicalProbeJson(task.driverRequest.requestArtifact)
  );
}

function refusalCodeFor(error) {
  const code = error?.code;
  if (code === "BROKER_PROTOCOL_DEADLINE") return "DEADLINE_EXPIRED";
  if (
    new Set([
      "BROKER_NATIVE_AUTHORITY_TASK_BINDING",
      "BROKER_PROTOCOL_BROKER",
      "BROKER_PROTOCOL_CONTROLLER",
      "BROKER_PROTOCOL_LOCAL_IDENTITY",
    ]).has(code)
  ) {
    return "AUTHORITY_MISMATCH";
  }
  if (
    new Set([
      "BROKER_MAILBOX_ARTIFACTS",
      "BROKER_MAILBOX_BLOB",
      "BROKER_MAILBOX_REFERENCE",
      "BROKER_WORKER_ARTIFACT",
    ]).has(code)
  ) {
    return "BLOB_INVALID";
  }
  if (
    typeof code === "string" &&
    (code === "BROKER_PROTOCOL_SIGNATURE" ||
      code === "BROKER_PROTOCOL_PUBLIC_KEY" ||
      code === "BROKER_PROTOCOL_RECOVERY" ||
      code === "BROKER_WORKER_DRIVER_REQUEST")
  ) {
    return "MALFORMED_TASK";
  }
  return null;
}

function outcome(disposition, authority, values = {}) {
  return freezeDeep({
    schemaVersion: PROBE_BROKER_WORKER_SCHEMA_VERSION,
    kind: "windows-host-probe-broker-worker-outcome",
    disposition,
    physicalOperationKeySha256: authority.physicalOperationKeySha256,
    ...values,
  });
}

function cleanupError(primary, failures) {
  if (failures.length === 0) return primary;
  const error = new ProbeBrokerWorkerError(
    "BROKER_WORKER_CLEANUP",
    "broker worker could not preserve its shutdown ordering",
  );
  error.cause = new AggregateError([primary, ...failures], "broker worker cleanup failed");
  if (
    primary?.requiresProcessExit === true ||
    failures.some((failure) => failure?.requiresProcessExit === true)
  ) {
    error.requiresProcessExit = true;
  }
  return error;
}

function processExitRequiredError(primary) {
  const error = new ProbeBrokerWorkerError(
    "BROKER_WORKER_PROCESS_EXIT_REQUIRED",
    "broker worker retained a native authority channel; this process must terminate",
  );
  error.requiresProcessExit = true;
  if (primary?.manualIntervention !== undefined) {
    error.manualIntervention = primary.manualIntervention;
  }
  error.cause = primary;
  return error;
}

export function createProbeBrokerWorker(optionsValue) {
  const options = validateWorkerOptions(optionsValue);
  let started = false;

  return Object.freeze({
    async run() {
      if (started) fail("BROKER_WORKER_ALREADY_RUN", "broker worker may run only once");
      started = true;
      const authority = options.preparedOperationAuthority;
      const driver = options.selectedDriver;
      if (activePhysicalOperations.has(authority.physicalOperationKeySha256)) {
        fail(
          "BROKER_WORKER_OPERATION_ACTIVE",
          "another worker still owns the prepared physical operation",
        );
      }
      activePhysicalOperations.add(authority.physicalOperationKeySha256);
      let nativeSession = null;
      let journal = null;
      let mailbox = null;
      let task = null;
      let acceptedContext = null;
      let postEffect = false;
      let resultRetained = false;

      async function closeJournal() {
        if (journal === null) return;
        const closing = journal;
        await closing.close();
        journal = null;
      }

      async function closeAndRelease() {
        await closeJournal();
        if (nativeSession !== null) {
          const releasing = nativeSession;
          await releasing.release();
          nativeSession = null;
        }
      }

      async function publishRetained(acceptedContext, disposition) {
        const completion = await journal.readRetainedCompletion(acceptedContext);
        if (completion === null) {
          fail("BROKER_WORKER_RETAINED_RESULT", "retained result completion is missing");
        }
        const envelope = await mailbox.publishRetainedResult({
          task,
          result: completion.result,
          controllerAcceptanceInput: completion.controllerAcceptanceInput,
        });
        await closeAndRelease();
        return outcome(disposition, authority, {
          taskSha256: task.taskSha256,
          resultSha256: completion.result.resultSha256,
          resultEnvelopeSha256: envelope.resultEnvelopeSha256,
        });
      }

      async function retainDriverTerminal(rawTerminal, acceptedContext, expectedEffectSha256) {
        const terminal = materializeDriverTerminal(rawTerminal, task);
        if (expectedEffectSha256 !== null && terminal.effectSha256 !== expectedEffectSha256) {
          fail(
            "BROKER_WORKER_EFFECT_MISMATCH",
            "reconciled effect differs from the durable effect commitment",
          );
        }
        await journal.recordEffectCommitted({
          acceptedContext,
          effectSha256: terminal.effectSha256,
        });
        const validationConfirmation = await confirmProbeBrokerExecutionAuthority(
          nativeSession.executionAuthorityLease,
          "result-validation",
        );
        const provisionalControllerAcceptanceInput =
          await createProbeBrokerControllerAcceptanceInput(
            terminal.result,
            acceptedContext,
            validationConfirmation,
          );
        await mailbox.stageResultArtifacts({
          task,
          result: terminal.result,
          controllerAcceptanceInput: provisionalControllerAcceptanceInput,
          artifacts: terminal.artifacts,
        });
        await journal.recordResultRetained({
          acceptedContext,
          result: terminal.result,
        });
        resultRetained = true;
        return publishRetained(acceptedContext, "published-result");
      }

      async function reconcile(recovery, preparedRequest, acceptedContext) {
        if (recovery.orchestrationDirective !== "reconcile") {
          const manual = validateManualIntervention({
            schemaVersion: PROBE_BROKER_WORKER_SCHEMA_VERSION,
            kind: PROBE_BROKER_WORKER_MANUAL_INTERVENTION_KIND,
            reasonCode: "durable-recovery-requires-operator",
          });
          const error = new ProbeBrokerWorkerError(
            "BROKER_WORKER_MANUAL_INTERVENTION",
            `broker recovery requires manual intervention: ${manual.reasonCode}`,
          );
          error.manualIntervention = manual;
          throw error;
        }
        const reconciled = await withProbeBrokerExecutionAuthorityLease(
          nativeSession.executionAuthorityLease,
          "physical-execution",
          () => driver.reconcile(preparedRequest, recovery),
        );
        if (
          exactObject(reconciled) &&
          reconciled.kind === PROBE_BROKER_WORKER_MANUAL_INTERVENTION_KIND
        ) {
          const manual = validateManualIntervention(reconciled);
          const error = new ProbeBrokerWorkerError(
            "BROKER_WORKER_MANUAL_INTERVENTION",
            `broker reconciliation requires manual intervention: ${manual.reasonCode}`,
          );
          error.manualIntervention = manual;
          throw error;
        }
        return retainDriverTerminal(reconciled, acceptedContext, recovery.effectSha256);
      }

      try {
        nativeSession = await openProbeBrokerNativeAuthoritySession({
          build: options.nativeBuild,
          preparedMailboxBinding: options.preparedBrokerEnrollment,
          preparedOperationAuthority: authority,
          expectedPreparedOperationAuthoritySha256:
            options.expectedPreparedOperationAuthoritySha256,
          ...(Object.hasOwn(options, "openNativeBrokerContextChannel")
            ? { openContextChannel: options.openNativeBrokerContextChannel }
            : {}),
        });
        mailbox = openProbeBrokerMailbox({
          store: options.mailboxStore,
          binding: options.preparedBrokerEnrollment,
          principal: "broker",
          assertMailboxAuthority: nativeSession.assertMailboxAuthority,
        });
        journal = await openProbeBrokerJournal({
          root: options.journalRoot,
          preparedBrokerEnrollment: options.preparedBrokerEnrollment,
          executionAuthorityLease: nativeSession.executionAuthorityLease,
        });
        const delivery = await mailbox.readTask(authority.physicalOperationKeySha256);
        task = assertProbeBrokerTaskMatchesPreparedOperationAuthority(delivery.task, authority);
        const durableRecord = await journal.readTaskByDigest(task.taskSha256);
        if (durableRecord !== null) {
          postEffect = durableRecord.currentState !== "accepted";
          resultRetained = durableRecord.currentState === "result-retained";
          if (canonicalProbeJson(durableRecord.task) !== canonicalProbeJson(task)) {
            fail(
              "BROKER_WORKER_DURABLE_TASK_MISMATCH",
              "mailbox task differs from its durable journal task",
            );
          }
        }
        const verificationInstant = options.now();
        if (
          !(verificationInstant instanceof Date) ||
          !Number.isFinite(verificationInstant.getTime())
        ) {
          fail("BROKER_WORKER_CLOCK", "broker worker clock returned an invalid instant");
        }
        let preparedRequest;
        let preparedRequestReady = false;
        let driverValidationReceipt = null;
        async function prepareDriverRequest() {
          if (preparedRequestReady) return preparedRequest;
          preparedRequest = await withProbeBrokerExecutionAuthorityLease(
            nativeSession.executionAuthorityLease,
            "acceptance",
            () => driver.validateRequest(Buffer.from(delivery.driverRequestBytes), authority),
          );
          preparedRequestReady = true;
          return preparedRequest;
        }
        acceptedContext = await journal.acceptTask(task, {
          controllerPublicKeyBytes: options.controllerPublicKeyBytes,
          executionAuthorityLease: nativeSession.executionAuthorityLease,
          async validateDriverRequest(request) {
            if (!requestMatchesTask(request, task)) {
              fail(
                "BROKER_WORKER_DRIVER_REQUEST",
                "journal acceptance requested another driver operation",
              );
            }
            if (driverValidationReceipt !== null) return driverValidationReceipt;
            if (durableRecord === null) await prepareDriverRequest();
            driverValidationReceipt = createProbeBrokerDriverValidationReceipt({
              taskSha256: task.taskSha256,
              driverId: driver.driverId,
              requestArtifactSha256: task.driverRequest.requestArtifact.sha256,
              requestArtifactBytes: task.driverRequest.requestArtifact.bytes,
              requestSchemaSha256: driver.requestSchemaSha256,
              recoveryClass: driver.recoveryClass,
            });
            return driverValidationReceipt;
          },
          verificationInstant: new Date(verificationInstant.getTime()),
        });
        if (driverValidationReceipt === null) {
          fail(
            "BROKER_WORKER_DRIVER_REQUEST",
            "signed task acceptance did not validate its driver request",
          );
        }
        let recovery = await journal.recover(acceptedContext);
        postEffect = recovery.currentState !== "accepted";
        resultRetained = recovery.currentState === "result-retained";
        if (recovery.orchestrationDirective === "replay-retained-result") {
          return await publishRetained(acceptedContext, "replayed-retained-result");
        }
        if (recovery.orchestrationDirective !== "execute") {
          return await reconcile(
            recovery,
            recovery.orchestrationDirective === "reconcile"
              ? await prepareDriverRequest()
              : undefined,
            acceptedContext,
          );
        }
        preparedRequest = await prepareDriverRequest();
        postEffect = true;
        const authorization = await journal.authorizeEffect(acceptedContext);
        if (!authorization.authorized) {
          recovery = authorization.recovery;
          postEffect = recovery.currentState !== "accepted";
          resultRetained = recovery.currentState === "result-retained";
          if (recovery.orchestrationDirective === "replay-retained-result") {
            return await publishRetained(acceptedContext, "replayed-retained-result");
          }
          return await reconcile(recovery, preparedRequest, acceptedContext);
        }
        postEffect = true;
        const executed = await withProbeBrokerExecutionAuthorityLease(
          nativeSession.executionAuthorityLease,
          "physical-execution",
          () => driver.execute(preparedRequest),
        );
        return await retainDriverTerminal(executed, acceptedContext, null);
      } catch (error) {
        let primaryError = error;
        if (!postEffect && task !== null && mailbox !== null) {
          const refusalCode = refusalCodeFor(primaryError);
          if (refusalCode !== null) {
            try {
              const envelope = await mailbox.publishRefusal({ task, refusalCode });
              await closeAndRelease();
              return outcome("published-refusal", authority, {
                taskSha256: task.taskSha256,
                refusalCode,
                refusalEnvelopeSha256: envelope.refusalEnvelopeSha256,
              });
            } catch (refusalError) {
              primaryError = cleanupError(primaryError, [refusalError]);
            }
          }
        }
        const cleanupFailures = [];
        if (postEffect && !resultRetained && journal !== null && acceptedContext !== null) {
          try {
            const recovery = await journal.recover(acceptedContext);
            postEffect = recovery.currentState !== "accepted";
            resultRetained = recovery.currentState === "result-retained";
          } catch (recoveryError) {
            cleanupFailures.push(recoveryError);
          }
        }
        try {
          await closeJournal();
        } catch (closeError) {
          cleanupFailures.push(closeError);
        }
        if (
          cleanupFailures.length === 0 &&
          nativeSession !== null &&
          (!postEffect || resultRetained)
        ) {
          try {
            const releasing = nativeSession;
            await releasing.release();
            nativeSession = null;
          } catch (releaseError) {
            cleanupFailures.push(releaseError);
          }
        }
        const finalError = cleanupError(primaryError, cleanupFailures);
        if (nativeSession !== null || finalError?.requiresProcessExit === true) {
          throw processExitRequiredError(finalError);
        }
        throw finalError;
      } finally {
        activePhysicalOperations.delete(authority.physicalOperationKeySha256);
      }
    },
  });
}
