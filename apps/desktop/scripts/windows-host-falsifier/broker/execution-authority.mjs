import { hashProbeCanonicalJson } from "../probe-contract.mjs";

export const PROBE_BROKER_EXECUTION_AUTHORITY_SCHEMA_VERSION = 1;
export const PROBE_BROKER_EXECUTION_AUTHORITY_PHASES = Object.freeze([
  "journal-open",
  "mailbox-access",
  "acceptance",
  "journal-consumption",
  "effect-started",
  "physical-execution",
  "effect-committed",
  "result-validation",
  "result-retained",
  "retained-result-read",
  "release",
]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const rowIdPattern = /^F-(?:0[1-9]|10)$/u;
const roles = Object.freeze(["primary-standard-user", "second-user", "remote-peer"]);
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
const snapshotKeys = Object.freeze([
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
  "mailboxRootObjectIdentitySha256",
  "mailboxVolumeIdSha256",
  "mailboxTransportIdentitySha256",
  "mailboxAclSha256",
  "mailboxOwnerSidSha256",
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
  "processSidSha256",
  "bootIdSha256",
  "runnerSessionIdSha256",
  "nativeObservationSha256",
  "peerAuthoritySha256",
]);

const leaseStates = new WeakMap();
const confirmationStates = new WeakMap();

export class ProbeBrokerExecutionAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeBrokerExecutionAuthorityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeBrokerExecutionAuthorityError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label) {
  if (!exactObject(value))
    fail("BROKER_EXECUTION_AUTHORITY_SCHEMA", `${label} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
    }) ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    fail("BROKER_EXECUTION_AUTHORITY_SCHEMA", `${label} has an invalid field set`);
  }
}

function cloneCanonicalData(value, label, depth = 0, ancestors = new Set()) {
  if (depth > 32) fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} exceeds the depth bound`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed() || value !== value.normalize("NFC") || value.includes("\0")) {
      fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} contains invalid Unicode`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} is not finite`);
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} is not canonical data`);
  }
  ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)),
      )
    ) {
      fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} array shape is invalid`);
    }
    clone = value.map((_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} contains an accessor or sparse entry`);
      }
      return cloneCanonicalData(descriptor.value, label, depth + 1, ancestors);
    });
  } else {
    if (!exactObject(value)) {
      fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} must be a plain object`);
    }
    clone = {};
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !key.isWellFormed() ||
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        fail("BROKER_EXECUTION_AUTHORITY_VALUE", `${label} contains a non-data field`);
      }
      clone[key] = cloneCanonicalData(descriptor.value, label, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
  return clone;
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

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("BROKER_EXECUTION_AUTHORITY_DIGEST", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("BROKER_EXECUTION_AUTHORITY_IDENTIFIER", `${label} must be a bounded identifier`);
  }
  return value;
}

function validateCoordinate(value) {
  assertExactKeys(value, coordinateKeys, "execution authority coordinate");
  for (const key of ["campaignRunId", "executionRunId", "attemptId", "workId", "variantId"]) {
    requireIdentifier(value[key], `execution authority coordinate.${key}`);
  }
  if (
    !["win11-floor", "win11-current"].includes(value.environmentId) ||
    !["ascii", "spaces-unicode"].includes(value.pathProfileId) ||
    typeof value.rowId !== "string" ||
    !rowIdPattern.test(value.rowId) ||
    (value.repetition !== null && (!Number.isSafeInteger(value.repetition) || value.repetition < 1))
  ) {
    fail("BROKER_EXECUTION_AUTHORITY_COORDINATE", "execution authority coordinate is invalid");
  }
  return value;
}

function validateSnapshot(value) {
  const snapshot = cloneCanonicalData(value, "execution authority snapshot");
  assertExactKeys(snapshot, snapshotKeys, "execution authority snapshot");
  if (
    snapshot.schemaVersion !== PROBE_BROKER_EXECUTION_AUTHORITY_SCHEMA_VERSION ||
    snapshot.kind !== "windows-host-probe-broker-execution-authority"
  ) {
    fail("BROKER_EXECUTION_AUTHORITY_IDENTITY", "execution authority identity is invalid");
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
    "mailboxRootObjectIdentitySha256",
    "mailboxVolumeIdSha256",
    "mailboxTransportIdentitySha256",
    "mailboxAclSha256",
    "mailboxOwnerSidSha256",
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
    "processSidSha256",
    "bootIdSha256",
    "runnerSessionIdSha256",
    "nativeObservationSha256",
  ]) {
    requireSha256(snapshot[key], `execution authority.${key}`);
  }
  validateCoordinate(snapshot.coordinate);
  requireIdentifier(snapshot.operationId, "execution authority.operationId");
  requireIdentifier(snapshot.producerActionId, "execution authority.producerActionId");
  requireIdentifier(snapshot.driverId, "execution authority.driverId");
  requireIdentifier(snapshot.brokerInstanceId, "execution authority.brokerInstanceId");
  if (!roles.includes(snapshot.brokerRole)) {
    fail("BROKER_EXECUTION_AUTHORITY_ROLE", "execution authority broker role is invalid");
  }
  if (
    typeof snapshot.journalRoot !== "string" ||
    snapshot.journalRoot.length === 0 ||
    snapshot.journalRoot.length > 4096 ||
    snapshot.journalSecurityProfile !== "role-separated-append-only-journal-v1"
  ) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_JOURNAL",
      "execution authority journal root or security profile is invalid",
    );
  }
  if (snapshot.brokerRole === "remote-peer") {
    requireSha256(snapshot.peerAuthoritySha256, "execution authority.peerAuthoritySha256");
  } else if (snapshot.peerAuthoritySha256 !== null) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_PEER",
      "local execution authority must not claim a remote peer authority",
    );
  }
  return freezeCanonical(snapshot);
}

function authorityDigest(snapshot) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-broker-execution-authority.v1",
    authority: snapshot,
  });
}

function requireLeaseState(
  value,
  { allowInvalidated = false, allowReleasing = false, allowReleaseOnly = false } = {},
) {
  if (!exactObject(value) || !leaseStates.has(value)) {
    fail("BROKER_EXECUTION_AUTHORITY_LEASE", "execution authority lease is not live");
  }
  const state = leaseStates.get(value);
  if (!state.active) {
    fail("BROKER_EXECUTION_AUTHORITY_RELEASED", "execution authority lease was released");
  }
  if (state.releasing && !allowReleasing) {
    fail("BROKER_EXECUTION_AUTHORITY_RELEASING", "execution authority lease is releasing");
  }
  if (state.releaseOnly && !allowReleaseOnly) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_RELEASE_REQUIRED",
      "execution authority source requires release retry",
    );
  }
  if (state.invalidated && !allowInvalidated) {
    fail("BROKER_EXECUTION_AUTHORITY_DRIFT", "execution authority lease was invalidated by drift");
  }
  return state;
}

function beginLeaseOperation(lease) {
  const state = requireLeaseState(lease);
  state.inFlight += 1;
  return state;
}

function endLeaseOperation(state) {
  state.inFlight -= 1;
  if (state.inFlight === 0) {
    for (const resolve of state.idleResolvers.splice(0)) resolve();
  }
}

function waitForLeaseIdle(state) {
  if (state.inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => state.idleResolvers.push(resolve));
}

function validatePhase(phase) {
  if (!PROBE_BROKER_EXECUTION_AUTHORITY_PHASES.includes(phase)) {
    fail("BROKER_EXECUTION_AUTHORITY_PHASE", "execution authority phase is invalid");
  }
  return phase;
}

async function revalidateLeaseState(state, phase) {
  let observed;
  try {
    observed = validateSnapshot(await state.revalidate());
  } catch (error) {
    state.invalidated = true;
    throw error;
  }
  if (authorityDigest(observed) !== state.authoritySha256) {
    state.invalidated = true;
    fail("BROKER_EXECUTION_AUTHORITY_DRIFT", `execution authority drifted before ${phase}`);
  }
}

export async function acquireProbeBrokerExecutionAuthorityLease(options) {
  assertExactKeys(
    options,
    ["acquire", "revalidate", "release"],
    "execution authority acquisition options",
  );
  if (
    typeof options.acquire !== "function" ||
    typeof options.revalidate !== "function" ||
    typeof options.release !== "function"
  ) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_SOURCE",
      "execution authority acquisition, revalidation, and release must be functions",
    );
  }
  let snapshot;
  try {
    snapshot = validateSnapshot(await options.acquire());
  } catch (error) {
    try {
      await options.release();
    } catch (releaseCause) {
      const releaseError = new ProbeBrokerExecutionAuthorityError(
        "BROKER_EXECUTION_AUTHORITY_RELEASE",
        "execution authority source could not be released after acquisition failure",
      );
      releaseError.requiresProcessExit = true;
      releaseError.cause = new AggregateError(
        [error, releaseCause],
        "execution authority acquisition and cleanup both failed",
      );
      throw releaseError;
    }
    throw error;
  }
  const authoritySha256 = authorityDigest(snapshot);
  const lease = freezeCanonical({
    schemaVersion: PROBE_BROKER_EXECUTION_AUTHORITY_SCHEMA_VERSION,
    kind: "windows-host-probe-broker-execution-authority-lease",
    authoritySha256,
  });
  leaseStates.set(lease, {
    active: true,
    releasing: false,
    releaseOnly: false,
    invalidated: false,
    effectStarted: false,
    resultRetained: false,
    operationKeySha256: snapshot.physicalOperationKeySha256,
    inFlight: 0,
    idleResolvers: [],
    sequence: 0,
    snapshot,
    authoritySha256,
    revalidate: options.revalidate,
    release: options.release,
  });
  return lease;
}

export function assertProbeBrokerExecutionAuthorityLease(value) {
  const state = requireLeaseState(value);
  return freezeCanonical({
    authoritySha256: state.authoritySha256,
    snapshot: state.snapshot,
  });
}

export function bindProbeBrokerExecutionAuthorityLeaseToOperation(
  lease,
  physicalOperationKeySha256,
) {
  requireSha256(physicalOperationKeySha256, "execution authority physical operation key");
  const state = requireLeaseState(lease);
  if (state.operationKeySha256 !== physicalOperationKeySha256) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_OPERATION_BINDING",
      "execution authority lease is already bound to another physical operation",
    );
  }
}

export async function confirmProbeBrokerExecutionAuthority(lease, phaseValue) {
  const phase = validatePhase(phaseValue);
  const state = beginLeaseOperation(lease);
  let reserved = false;
  try {
    await revalidateLeaseState(state, phase);
    requireLeaseState(lease, { allowReleasing: true });
    state.sequence += 1;
    const draft = {
      schemaVersion: PROBE_BROKER_EXECUTION_AUTHORITY_SCHEMA_VERSION,
      kind: "windows-host-probe-broker-execution-authority-confirmation",
      authoritySha256: state.authoritySha256,
      phase,
      sequence: state.sequence,
    };
    const confirmation = freezeCanonical({
      ...draft,
      confirmationSha256: hashProbeCanonicalJson({
        domain: "enduragent.windows-host-probe-broker-execution-authority-confirmation.v1",
        confirmation: draft,
      }),
    });
    confirmationStates.set(confirmation, {
      lease,
      phase,
      used: false,
      reservationState: state,
    });
    reserved = true;
    return confirmation;
  } finally {
    if (!reserved) endLeaseOperation(state);
  }
}

async function consumeConfirmation(lease, confirmation, expectedPhaseValue, operation) {
  const expectedPhase = validatePhase(expectedPhaseValue);
  const state = requireLeaseState(lease, { allowReleasing: true });
  if (!exactObject(confirmation) || !confirmationStates.has(confirmation)) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_CONFIRMATION",
      "execution authority confirmation was not minted in this process",
    );
  }
  const confirmationState = confirmationStates.get(confirmation);
  if (
    confirmationState.lease !== lease ||
    confirmationState.phase !== expectedPhase ||
    confirmation.phase !== expectedPhase ||
    confirmation.authoritySha256 !== state.authoritySha256
  ) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_CONFIRMATION",
      "execution authority confirmation belongs to another lease or phase",
    );
  }
  if (confirmationState.used) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_CONFIRMATION_REPLAY",
      "execution authority confirmation was already consumed",
    );
  }
  confirmationState.used = true;
  try {
    await revalidateLeaseState(confirmationState.reservationState, expectedPhase);
    requireLeaseState(lease, { allowReleasing: true });
    return await operation(confirmationState.reservationState.snapshot);
  } finally {
    endLeaseOperation(confirmationState.reservationState);
  }
}

export function discardProbeBrokerExecutionAuthorityConfirmation(
  lease,
  confirmation,
  expectedPhaseValue,
) {
  const expectedPhase = validatePhase(expectedPhaseValue);
  requireLeaseState(lease, { allowReleasing: true });
  if (!exactObject(confirmation) || !confirmationStates.has(confirmation)) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_CONFIRMATION",
      "execution authority confirmation was not minted in this process",
    );
  }
  const confirmationState = confirmationStates.get(confirmation);
  if (
    confirmationState.lease !== lease ||
    confirmationState.phase !== expectedPhase ||
    confirmation.phase !== expectedPhase
  ) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_CONFIRMATION",
      "execution authority confirmation belongs to another lease or phase",
    );
  }
  if (confirmationState.used) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_CONFIRMATION_REPLAY",
      "execution authority confirmation was already consumed",
    );
  }
  confirmationState.used = true;
  endLeaseOperation(confirmationState.reservationState);
}

export function consumeProbeBrokerExecutionAuthorityConfirmation(
  lease,
  confirmation,
  expectedPhaseValue,
) {
  return consumeConfirmation(lease, confirmation, expectedPhaseValue, (snapshot) => snapshot);
}

export function withProbeBrokerExecutionAuthorityConfirmation(
  lease,
  confirmation,
  expectedPhaseValue,
  operation,
) {
  if (typeof operation !== "function") {
    fail(
      "BROKER_EXECUTION_AUTHORITY_OPERATION",
      "execution authority operation must be a function",
    );
  }
  return consumeConfirmation(lease, confirmation, expectedPhaseValue, operation);
}

export async function withProbeBrokerExecutionAuthorityLease(lease, phaseValue, operation) {
  const phase = validatePhase(phaseValue);
  if (typeof operation !== "function") {
    fail(
      "BROKER_EXECUTION_AUTHORITY_OPERATION",
      "execution authority operation must be a function",
    );
  }
  const state = beginLeaseOperation(lease);
  try {
    await revalidateLeaseState(state, phase);
    requireLeaseState(lease, { allowReleasing: true });
    return await operation(state.snapshot);
  } finally {
    endLeaseOperation(state);
  }
}

export function markProbeBrokerExecutionAuthorityEffectStarted(lease) {
  requireLeaseState(lease, { allowReleasing: true }).effectStarted = true;
}

export function markProbeBrokerExecutionAuthorityResultRetained(lease) {
  const state = requireLeaseState(lease, { allowReleasing: true });
  if (!state.effectStarted) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_RESULT_ORDER",
      "execution authority cannot retain a result before effect start",
    );
  }
  state.resultRetained = true;
}

export async function releaseProbeBrokerExecutionAuthorityLease(lease) {
  const state = requireLeaseState(lease, {
    allowInvalidated: true,
    allowReleaseOnly: true,
  });
  if (state.effectStarted && !state.resultRetained) {
    fail(
      "BROKER_EXECUTION_AUTHORITY_INCOMPLETE",
      "execution authority cannot be released after effect start and before result retention",
    );
  }
  state.releasing = true;
  await waitForLeaseIdle(state);
  if (state.effectStarted && !state.resultRetained) {
    state.releasing = false;
    fail(
      "BROKER_EXECUTION_AUTHORITY_INCOMPLETE",
      "execution authority cannot be released after effect start and before result retention",
    );
  }
  let validationError = null;
  if (!state.invalidated) {
    try {
      await revalidateLeaseState(state, "release");
    } catch (error) {
      validationError = error;
    }
  }
  if (state.effectStarted && !state.resultRetained) {
    state.releasing = false;
    fail(
      "BROKER_EXECUTION_AUTHORITY_INCOMPLETE",
      "execution authority cannot be released after effect start and before result retention",
    );
  }
  try {
    await state.release();
  } catch (error) {
    state.releasing = false;
    state.releaseOnly = true;
    const releaseError = new ProbeBrokerExecutionAuthorityError(
      "BROKER_EXECUTION_AUTHORITY_RELEASE",
      "execution authority source could not be released and requires retry",
    );
    releaseError.cause = error;
    throw releaseError;
  }
  state.active = false;
  if (validationError !== null) throw validationError;
}
