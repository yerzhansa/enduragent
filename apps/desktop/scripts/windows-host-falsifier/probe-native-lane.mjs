import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  observeNativePreflight,
  openNativeChannel,
  validateNativeCommandResult,
  validateNativeCommandTranscript,
  validateNativePreflightTranscript,
} from "./native-client.mjs";
import { validateEvidenceRelativePath } from "./evidence-store.mjs";
import { canonicalProbeJson, hashProbeCanonicalJson } from "./probe-contract.mjs";
import { readVerifiedControllerNativeActionPlan } from "./probe-controller-spool-transport.mjs";
import { probeSegmentArtifactPaths } from "./probe-finalizer.mjs";
import {
  createProbeNativeOperationIntent,
  openProbeNativeOperationJournal,
} from "./probe-native-operation-journal.mjs";
import { PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX } from "./probe-native-paths.mjs";
import {
  deriveProbeNativeActionPlanStepOperationId,
  verifyProbeNativeActionPlanBinding,
} from "./probe-native-action-plan.mjs";
import { getProbeRunWorkItem } from "./probe-runner.mjs";
import { createProbeRuntimeActionBinding } from "./probe-runtime-action-intent.mjs";
import { PROBE_SCENARIO_DEFINITIONS, executeProbeScenarioActionSlice } from "./probe-scenarios.mjs";

export { PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX } from "./probe-native-paths.mjs";

export const PROBE_NATIVE_LANE_SCHEMA_VERSION = 1;

export const PROBE_NATIVE_LANE_DRIVER_KEYS = Object.freeze(
  [
    ...new Set(
      PROBE_SCENARIO_DEFINITIONS.flatMap((definition) =>
        definition.actions
          .filter(({ actor }) => actor === "native-helper")
          .map(({ actionId }) => `${definition.rowId}:${actionId}`),
      ),
    ),
  ].sort(compareUtf8),
);

export function probeNativeLaneDriverKey(rowId, actionId) {
  requireString(rowId, "native lane driver rowId");
  requireString(actionId, "native lane driver actionId");
  const key = `${rowId}:${actionId}`;
  if (!PROBE_NATIVE_LANE_DRIVER_KEYS.includes(key)) {
    fail("NATIVE_LANE_DRIVER_MISSING", "scenario action has no native row-driver key");
  }
  return key;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const journalDirectory = `${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/journal`;
const transcriptDirectory = `${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/transcripts`;
const stepResultDirectory = `${PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX}/step-results`;

export class ProbeNativeLaneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeNativeLaneError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeNativeLaneError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function assertExactKeys(value, keys, label, code = "NATIVE_LANE_SCHEMA") {
  if (!exactObject(value)) fail(code, `${label} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail(code, `${label} has an invalid field set`);
  }
  const expected = [...keys].sort(compareUtf8);
  actual.sort(compareUtf8);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} has an invalid field set`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(code, `${label} fields must be enumerable data`);
    }
  }
}

function requireString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    value.includes("\0") ||
    value !== value.normalize("NFC")
  ) {
    fail("NATIVE_LANE_STRING", `${label} must be a bounded NFC string`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("NATIVE_LANE_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== "function") fail("NATIVE_LANE_FUNCTION", `${label} must be a function`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEqual(left, right) {
  return canonicalProbeJson(left) === canonicalProbeJson(right);
}

function canonicalBytes(value) {
  return Buffer.from(canonicalProbeJson(value), "utf8");
}

function compactCanonicalJson(value) {
  return JSON.stringify(JSON.parse(canonicalProbeJson(value)));
}

function deepFreeze(value) {
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

function parseCanonicalObject(
  bytes,
  label,
  { terminalNewline = false, nativeCompact = false } = {},
) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("NATIVE_LANE_CANONICAL", `${label} is not UTF-8`);
  }
  const json = terminalNewline && text.endsWith("\n") ? text.slice(0, -1) : text;
  if (terminalNewline && json.length === text.length) {
    fail("NATIVE_LANE_CANONICAL", `${label} has no terminal newline`);
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    fail("NATIVE_LANE_CANONICAL", `${label} is not JSON`);
  }
  const canonical = nativeCompact ? compactCanonicalJson(value) : canonicalProbeJson(value);
  if (!exactObject(value) || canonical !== json) {
    fail("NATIVE_LANE_CANONICAL", `${label} is not canonical JSON`);
  }
  return value;
}

function isReservedPath(value) {
  const normalized = value.replaceAll("\\", "/");
  const folded = normalized.toLocaleLowerCase("en-US");
  const reserved = PROBE_NATIVE_OPERATION_JOURNAL_RESERVED_PREFIX.toLocaleLowerCase("en-US");
  return folded === reserved || folded.startsWith(`${reserved}/`);
}

function rejectReservedPath(value, label) {
  if (typeof value === "string" && isReservedPath(value)) {
    fail("NATIVE_LANE_RESERVED_PATH", `${label} uses the native journal namespace`);
  }
  validateEvidenceRelativePath(value);
  return value;
}

function rejectReservedRequestValues(value, label) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (isReservedPath(current)) {
        fail("NATIVE_LANE_RESERVED_PATH", `${label} uses the native journal namespace`);
      }
      continue;
    }
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) stack.push(child);
    }
  }
}

async function ensureDirectory(store, path) {
  const parts = validateEvidenceRelativePath(path).split("/");
  let current = "";
  for (const part of parts) {
    const parent = current;
    current = current.length === 0 ? part : `${current}/${part}`;
    const entries =
      parent.length === 0
        ? await readdir(store.root, { withFileTypes: true }).then((values) =>
            values.map((entry) => ({
              name: entry.name,
              kind: entry.isDirectory() ? "directory" : "other",
            })),
          )
        : await store.list(parent);
    const folded = part.toLocaleLowerCase("en-US");
    const matches = entries.filter((entry) => entry.name.toLocaleLowerCase("en-US") === folded);
    if (matches.length > 0) {
      if (matches.length !== 1 || matches[0].name !== part || matches[0].kind !== "directory") {
        fail("NATIVE_LANE_DIRECTORY_COLLISION", `native lane directory collides: ${current}`);
      }
      continue;
    }
    try {
      await store.createDirectory(current);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const racedEntries =
        parent.length === 0
          ? await readdir(store.root, { withFileTypes: true }).then((values) =>
              values.map((entry) => ({
                name: entry.name,
                kind: entry.isDirectory() ? "directory" : "other",
              })),
            )
          : await store.list(parent);
      const racedMatches = racedEntries.filter(
        (entry) => entry.name.toLocaleLowerCase("en-US") === folded,
      );
      if (
        racedMatches.length !== 1 ||
        racedMatches[0].name !== part ||
        racedMatches[0].kind !== "directory"
      ) {
        fail("NATIVE_LANE_DIRECTORY_COLLISION", `native lane directory raced: ${current}`);
      }
    }
  }
}

async function retainExactBytes(store, path, suppliedBytes, label) {
  validateEvidenceRelativePath(path);
  const bytes = Buffer.from(suppliedBytes);
  const digest = sha256(bytes);
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent.length !== 0) await ensureDirectory(store, parent);
  await store.assertRootStable();
  try {
    const retained = await store.writeBytes(path, bytes);
    if (retained?.path !== path || retained?.sha256 !== digest) {
      fail("NATIVE_LANE_RETENTION", `${label} publication acknowledgment differs`);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const retained = await store.readArtifact(path);
    if (
      retained?.path !== path ||
      retained?.size !== bytes.length ||
      retained?.sha256 !== digest ||
      !Buffer.from(retained?.bytes ?? []).equals(bytes)
    ) {
      fail("NATIVE_LANE_COLLISION", `${label} replay differs from retained bytes`);
    }
  }
  await store.assertRootStable();
  return Object.freeze({ path, sha256: digest, bytes: bytes.length });
}

async function readExactArtifact(store, path, label) {
  validateEvidenceRelativePath(path);
  await store.assertRootStable();
  let artifact;
  try {
    artifact = await store.readArtifact(path);
  } catch {
    fail("NATIVE_LANE_ARTIFACT_MISSING", `${label} is not retained`);
  }
  const bytes = Buffer.from(artifact?.bytes ?? []);
  const digest = sha256(bytes);
  if (artifact?.path !== path || artifact?.size !== bytes.length || artifact?.sha256 !== digest) {
    fail("NATIVE_LANE_ARTIFACT_CHANGED", `${label} is not a stable retained artifact`);
  }
  await store.assertRootStable();
  return Object.freeze({ path, bytes, size: bytes.length, sha256: digest });
}

function requireContext(context) {
  assertExactKeys(
    context,
    ["loadedBootstrap", "nativeBuild", "resolveStore", "metadata"],
    "lane context",
  );
  if (!exactObject(context.loadedBootstrap) || !exactObject(context.nativeBuild)) {
    fail("NATIVE_LANE_CONTEXT", "lane context bootstrap and native build must be objects");
  }
  requireFunction(context.resolveStore, "lane context resolveStore");
  const loaded = context.loadedBootstrap;
  const bootstrap = loaded.bootstrap;
  const build = context.nativeBuild;
  const manifest = loaded.nativeCandidateManifest;
  if (
    !exactObject(bootstrap) ||
    !exactObject(manifest) ||
    !exactObject(manifest.assembly) ||
    build.candidateDigest !== manifest.candidateDigest ||
    build.manifestSha256 !== bootstrap.nativeCandidateManifest?.sha256 ||
    build.assemblySha256 !== manifest.assembly.sha256 ||
    build.sourceBundleSha256 !== manifest.sourceBundleSha256 ||
    build.toolchainDigest !== manifest.toolchainDigest ||
    build.nativeHelperArtifactPath !== bootstrap.candidateBinaries?.nativeHelperArtifactPath ||
    build.candidateRoot !== bootstrap.binaryRoot
  ) {
    fail(
      "NATIVE_LANE_CANDIDATE_BINDING",
      "native build differs from bootstrap candidate authority",
    );
  }
  if (!Array.isArray(loaded.attestations) || loaded.attestations.length === 0) {
    fail("NATIVE_LANE_ATTESTATION", "lane context has no lab attestations");
  }
  return context;
}

function requireDrivers(rowDrivers) {
  if (!exactObject(rowDrivers)) {
    fail("NATIVE_LANE_DRIVER_REGISTRY", "rowDrivers must be an exhaustive plain object");
  }
  assertExactKeys(
    rowDrivers,
    PROBE_NATIVE_LANE_DRIVER_KEYS,
    "row driver registry",
    "NATIVE_LANE_DRIVER_REGISTRY",
  );
  return Object.freeze(
    Object.fromEntries(
      PROBE_NATIVE_LANE_DRIVER_KEYS.map((driverKey) => {
        const driver = rowDrivers[driverKey];
        const separator = driverKey.indexOf(":");
        const rowId = driverKey.slice(0, separator);
        const actionId = driverKey.slice(separator + 1);
        const definition = PROBE_SCENARIO_DEFINITIONS.find((entry) => entry.rowId === rowId);
        const action = definition?.actions.find((entry) => entry.actionId === actionId);
        if (!exactObject(driver)) {
          fail("NATIVE_LANE_DRIVER_REGISTRY", `row driver ${driverKey} must be a plain object`);
        }
        assertExactKeys(
          driver,
          [
            "rowId",
            "actionId",
            "operation",
            "driverId",
            "captureCommandId",
            "factKeys",
            "validateActionPlan",
            "projectActionResult",
          ],
          `row driver ${driverKey}`,
          "NATIVE_LANE_DRIVER_REGISTRY",
        );
        if (
          action?.actor !== "native-helper" ||
          action.capture === null ||
          driver.rowId !== rowId ||
          driver.actionId !== actionId ||
          driver.operation !== action.operation ||
          driver.captureCommandId !== action.capture.commandId ||
          !canonicalEqual(driver.factKeys, action.capture.factKeys)
        ) {
          fail("NATIVE_LANE_DRIVER_REGISTRY", `row driver ${driverKey} metadata differs`);
        }
        requireString(driver.driverId, `row driver ${driverKey}.driverId`);
        requireFunction(driver.validateActionPlan, `row driver ${driverKey}.validateActionPlan`);
        requireFunction(driver.projectActionResult, `row driver ${driverKey}.projectActionResult`);
        return [
          driverKey,
          Object.freeze({
            rowId: driver.rowId,
            actionId: driver.actionId,
            operation: driver.operation,
            driverId: driver.driverId,
            captureCommandId: driver.captureCommandId,
            factKeys: Object.freeze([...driver.factKeys]),
            validateActionPlan: driver.validateActionPlan,
            projectActionResult: driver.projectActionResult,
          }),
        ];
      }),
    ),
  );
}

function attestationFor(context, environmentId) {
  const matches = context.loadedBootstrap.attestations.filter(
    (entry) => entry.environmentId === environmentId,
  );
  if (matches.length !== 1) {
    fail("NATIVE_LANE_ATTESTATION", `environment has no unique attestation: ${environmentId}`);
  }
  return matches[0];
}

function guestEvidenceFor(attestation, pathProfileId) {
  const matches = attestation.guestEvidenceByPathProfile?.filter(
    (entry) => entry.pathProfileId === pathProfileId,
  );
  if (matches?.length !== 1 || !exactObject(matches[0].artifact)) {
    fail("NATIVE_LANE_GUEST_EVIDENCE", "attestation has no unique path-profile guest evidence");
  }
  const artifact = matches[0].artifact;
  rejectReservedPath(artifact.path, "attested guest evidence");
  requireSha256(artifact.sha256, "attested guest evidence sha256");
  return Object.freeze({ path: artifact.path, sha256: artifact.sha256 });
}

function expectedStoreRoot(context, environmentId, pathProfileId) {
  const matches = context.loadedBootstrap.bootstrap.evidenceRoots?.filter(
    (entry) => entry.environmentId === environmentId && entry.pathProfileId === pathProfileId,
  );
  if (matches?.length !== 1) {
    fail("NATIVE_LANE_EVIDENCE_ROOT", "bootstrap has no unique evidence-root binding");
  }
  return matches[0].root;
}

async function resolveBoundStore(context, campaignRunId, environmentId, pathProfileId, root) {
  if (campaignRunId !== context.loadedBootstrap.bootstrap.campaignRunId) {
    fail("NATIVE_LANE_CAMPAIGN", "native lane coordinate belongs to another campaign run");
  }
  if (root !== expectedStoreRoot(context, environmentId, pathProfileId)) {
    fail("NATIVE_LANE_EVIDENCE_ROOT", "native lane evidence root differs from bootstrap");
  }
  const store = await context.resolveStore({ campaignRunId, environmentId, pathProfileId });
  if (
    !exactObject(store) ||
    store.root !== root ||
    typeof store.createDirectory !== "function" ||
    typeof store.writeBytes !== "function" ||
    typeof store.readArtifact !== "function" ||
    typeof store.verifyArtifactSet !== "function" ||
    typeof store.list !== "function" ||
    typeof store.assertRootStable !== "function"
  ) {
    fail("NATIVE_LANE_EVIDENCE_STORE", "resolved store does not preserve its bound root");
  }
  await store.assertRootStable();
  return store;
}

function preflightScope(input) {
  if (
    !exactObject(input.command) ||
    !exactObject(input.candidate) ||
    !exactObject(input.attestation)
  ) {
    fail("NATIVE_LANE_PREFLIGHT_INPUT", "preflight input is incomplete");
  }
  return Object.freeze({
    campaignRunId: input.command.campaignRunId,
    executionRunId: input.command.executionRunId,
    executionBundleId: input.command.executionBundleId,
    attemptId: input.command.attemptId,
    environmentId: input.command.environmentId,
    pathProfileId: input.command.pathProfileId,
    candidateSha256: input.candidate.candidateSha256,
    attestationSha256: input.attestation.attestationSha256,
    evidenceRoot: input.evidenceRoot,
  });
}

function preflightKey(scope) {
  return canonicalProbeJson(scope);
}

function validatePreflightTranscriptBinding(context, transcript, scope, attestation) {
  const observation = transcript.observation;
  const build = context.nativeBuild;
  if (
    transcript.binding.candidateRootSha256 !== sha256(Buffer.from(build.candidateRoot, "utf8")) ||
    transcript.binding.candidateDirectorySha256 !==
      sha256(Buffer.from(build.candidateDirectory, "utf8")) ||
    transcript.binding.requestedRunRootSha256 !== sha256(Buffer.from(scope.evidenceRoot, "utf8")) ||
    transcript.binding.nativeHelperArtifactPath !== build.nativeHelperArtifactPath ||
    transcript.binding.nativeHelperSha256 !== build.assemblySha256 ||
    transcript.binding.nativeCandidateDigest !== build.candidateDigest ||
    transcript.binding.nativeManifestSha256 !== build.manifestSha256 ||
    transcript.binding.sourceBundleSha256 !== build.sourceBundleSha256 ||
    transcript.binding.pathProfileId !== scope.pathProfileId ||
    observation.pathProfileId !== scope.pathProfileId ||
    observation.nativeHelperSha256 !== build.assemblySha256 ||
    observation.nativeCandidateDigest !== build.candidateDigest ||
    observation.nativeManifestSha256 !== build.manifestSha256 ||
    observation.sourceBundleSha256 !== build.sourceBundleSha256 ||
    observation.runnerUserSidSha256 !== attestation.runner.interactiveSessionOwnerSidSha256 ||
    observation.volumeIdSha256 !== attestation.host.testVolumeIdSha256
  ) {
    fail("NATIVE_LANE_PREFLIGHT_BINDING", "native preflight transcript differs from authority");
  }
  return observation;
}

async function producePreflight(context, observePreflight, input) {
  const scope = preflightScope(input);
  if (
    !canonicalEqual(input.candidate, context.loadedBootstrap.candidate) ||
    !canonicalEqual(input.attestation, attestationFor(context, scope.environmentId)) ||
    scope.candidateSha256 !== context.loadedBootstrap.candidate.candidateSha256 ||
    scope.attestationSha256 !== attestationFor(context, scope.environmentId).attestationSha256
  ) {
    fail("NATIVE_LANE_PREFLIGHT_BINDING", "preflight authority differs from bootstrap");
  }
  const attestation = attestationFor(context, scope.environmentId);
  const store = await resolveBoundStore(
    context,
    scope.campaignRunId,
    scope.environmentId,
    scope.pathProfileId,
    scope.evidenceRoot,
  );
  const observed = await observePreflight({
    runRoot: scope.evidenceRoot,
    pathProfileId: scope.pathProfileId,
    candidateRoot: context.nativeBuild.candidateRoot,
    candidateDirectory: context.nativeBuild.candidateDirectory,
  });
  if (!exactObject(observed) || !(observed.transcriptBytes instanceof Uint8Array)) {
    fail("NATIVE_LANE_PREFLIGHT_OBSERVER", "native preflight observer returned no transcript");
  }
  assertBuildIdentity(context, observed.build);
  const transcript = validateNativePreflightTranscript(observed.transcript);
  if (!canonicalEqual(observed.observation, transcript.observation)) {
    fail("NATIVE_LANE_PREFLIGHT_OBSERVER", "native preflight observation differs from transcript");
  }
  const transcriptBytes = Buffer.from(observed.transcriptBytes);
  const parsed = validateNativePreflightTranscript(
    parseCanonicalObject(transcriptBytes, "native preflight transcript", {
      terminalNewline: true,
      nativeCompact: true,
    }),
  );
  if (!canonicalEqual(parsed, transcript)) {
    fail("NATIVE_LANE_PREFLIGHT_OBSERVER", "native preflight transcript bytes differ");
  }
  const observation = validatePreflightTranscriptBinding(context, transcript, scope, attestation);
  const guestEvidence = guestEvidenceFor(attestation, scope.pathProfileId);
  if (sha256(transcriptBytes) !== guestEvidence.sha256) {
    fail("NATIVE_LANE_GUEST_EVIDENCE", "live preflight transcript differs from attestation");
  }
  const retained = await retainExactBytes(
    store,
    guestEvidence.path,
    transcriptBytes,
    "attested path-profile guest evidence",
  );
  if (retained.sha256 !== guestEvidence.sha256) {
    fail("NATIVE_LANE_GUEST_EVIDENCE", "retained guest evidence differs from attestation");
  }
  const request = deepFreeze({
    campaignRunId: scope.campaignRunId,
    executionRunId: scope.executionRunId,
    executionBundleId: scope.executionBundleId,
    attemptId: scope.attemptId,
    environmentId: scope.environmentId,
    pathProfileId: scope.pathProfileId,
    vmSnapshotId: attestation.snapshot.vmSnapshotId,
    bootIdSha256: observation.bootIdSha256,
    runnerSessionIdSha256: observation.runnerSessionIdSha256,
    nativeHelperArtifactPath: context.nativeBuild.nativeHelperArtifactPath,
    nsisArtifactPath: context.loadedBootstrap.bootstrap.candidateBinaries.nsisArtifactPath,
  });
  const guestObservation = deepFreeze({
    environmentId: scope.environmentId,
    pathProfileId: scope.pathProfileId,
    host: attestation.host,
    snapshot: attestation.snapshot,
    runner: attestation.runner,
    runtime: attestation.runtime,
    bootIdSha256: observation.bootIdSha256,
    runnerSessionIdSha256: observation.runnerSessionIdSha256,
    pathProfile: {
      profileId: scope.pathProfileId,
      rootPathSha256: observation.rootPathSha256,
      evidenceRootObjectIdentitySha256: observation.evidenceRootObjectIdentitySha256,
      volumeIdSha256: observation.volumeIdSha256,
      localAbsolute: observation.localAbsolute,
      networkPath: observation.networkPath,
      removableVolume: observation.removableVolume,
      reparsePoint: observation.reparsePoint,
      nfcNormalized: observation.nfcNormalized,
      containsSpaces: observation.containsSpaces,
      containsUnicode: observation.containsUnicode,
    },
    guestEvidence,
  });
  return Object.freeze({ scope, request, guestObservation });
}

function expectedNativeBinding(prepared) {
  return Object.freeze({
    campaignRunId: prepared.campaignRunId,
    candidateSha256: prepared.candidateSha256,
    preflightSha256: prepared.preflightSha256,
    executionBundleManifestSha256: prepared.executionBundleManifestSha256,
    nativeHelperArtifactPath: prepared.executionBundleManifest.binaries.nativeHelper.path,
    nativeHelperSha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
    nativeCandidateDigest:
      prepared.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest,
    nativeManifestSha256:
      prepared.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256,
    evidenceRootObjectIdentitySha256:
      prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
  });
}

function transcriptPath(transcriptSha256) {
  requireSha256(transcriptSha256, "native transcript sha256");
  return `${transcriptDirectory}/${transcriptSha256}.json`;
}

function stepResultPath(operationId) {
  requireString(operationId, "native step operationId");
  return `${stepResultDirectory}/${operationId}.json`;
}

function validateTranscriptForPlan(transcriptValue, input, plan, intents) {
  const transcript = validateNativeCommandTranscript(transcriptValue);
  if (transcript.termination === null) {
    fail("NATIVE_LANE_TRANSCRIPT", "native action transcript is not terminal");
  }
  const binding = expectedNativeBinding(input.preparedContext);
  for (const [key, expected] of Object.entries(binding)) {
    if (transcript.binding[key] !== expected) {
      fail("NATIVE_LANE_TRANSCRIPT_BINDING", `native transcript ${key} differs from preflight`);
    }
  }
  if (
    sha256(Buffer.from(transcript.binding.runRootIdentity, "utf8")) !==
    binding.evidenceRootObjectIdentitySha256
  ) {
    fail("NATIVE_LANE_TRANSCRIPT_BINDING", "native transcript run root differs from preflight");
  }
  const commands = transcript.records.filter(({ kind }) => kind === "command");
  if (commands.length !== plan.steps.length || intents.length !== plan.steps.length) {
    fail("NATIVE_LANE_TRANSCRIPT_COMMAND", "native transcript command count differs from plan");
  }
  const outcomes = plan.steps.map((step, index) => {
    const intent = intents[index];
    const record = commands[index];
    if (record.command !== step.command || record.operationId !== intent.operationId) {
      fail("NATIVE_LANE_TRANSCRIPT_COMMAND", "native transcript command order differs from plan");
    }
    if (record.ok) {
      return deepFreeze({
        ok: true,
        result: validateNativeCommandResult(step.command, record.result),
      });
    }
    return deepFreeze({ ok: false, error: record.error });
  });
  return Object.freeze({ transcript, outcomes: Object.freeze(outcomes) });
}

function assertBuildIdentity(context, build) {
  const expected = context.nativeBuild;
  for (const key of [
    "candidateDigest",
    "assemblySha256",
    "sourceBundleSha256",
    "toolchainDigest",
    "manifestSha256",
  ]) {
    if (build?.[key] !== expected[key]) {
      fail("NATIVE_LANE_CANDIDATE_BINDING", `native execution build ${key} differs`);
    }
  }
}

function stepInputSha256(input, plan, step, operationId) {
  return hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-native-lane-step-input.v1",
    actionPlanSha256: plan.actionPlanSha256,
    runtimeOperationId: input.operationId,
    nativeOperationId: operationId,
    stepId: step.stepId,
    command: step.command,
    request: step.request,
    preparedContextSha256: input.preparedContext.preflightSha256,
  });
}

function stepResultDigestPayload(value) {
  const { recordSha256: _recordSha256, ...payload } = value;
  return payload;
}

function validateStepOutcome(value, step, label) {
  if (!exactObject(value) || typeof value.ok !== "boolean") {
    fail("NATIVE_LANE_STEP_RESULT", `${label} is not a native step outcome`);
  }
  if (value.ok) {
    assertExactKeys(value, ["ok", "result"], label);
    return deepFreeze({
      ok: true,
      result: validateNativeCommandResult(step.command, value.result),
    });
  }
  assertExactKeys(value, ["ok", "error"], label);
  assertExactKeys(value.error, ["code", "message", "win32Code"], `${label}.error`);
  requireString(value.error.code, `${label}.error.code`);
  requireString(value.error.message, `${label}.error.message`);
  if (
    value.error.win32Code !== null &&
    (!Number.isSafeInteger(value.error.win32Code) || value.error.win32Code < 0)
  ) {
    fail("NATIVE_LANE_STEP_RESULT", `${label}.error.win32Code is invalid`);
  }
  return deepFreeze({ ok: false, error: value.error });
}

function validateStepResultRecord(value, plan, step, intent) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "actionPlanSha256",
      "operationId",
      "stepId",
      "command",
      "inputSha256",
      "transcriptSha256",
      "transcriptPath",
      "outcome",
      "recordSha256",
    ],
    "native step result record",
  );
  if (
    value.schemaVersion !== PROBE_NATIVE_LANE_SCHEMA_VERSION ||
    value.kind !== "windows-host-probe-native-step-result" ||
    value.actionPlanSha256 !== plan.actionPlanSha256 ||
    value.operationId !== intent.operationId ||
    value.stepId !== step.stepId ||
    value.command !== step.command ||
    value.inputSha256 !== intent.inputSha256 ||
    value.transcriptPath !== transcriptPath(value.transcriptSha256)
  ) {
    fail("NATIVE_LANE_STEP_RESULT_BINDING", "native step result belongs to another intent");
  }
  requireSha256(value.transcriptSha256, "native step result transcriptSha256");
  requireSha256(value.recordSha256, "native step result recordSha256");
  validateStepOutcome(value.outcome, step, "native step result outcome");
  const expectedDigest = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-native-step-result.v1",
    record: stepResultDigestPayload(value),
  });
  if (value.recordSha256 !== expectedDigest) {
    fail("NATIVE_LANE_STEP_RESULT_DIGEST", "native step result digest is invalid");
  }
  return deepFreeze(value);
}

function createStepResultRecord(plan, step, intent, transcriptSha256, outcome) {
  const draft = {
    schemaVersion: PROBE_NATIVE_LANE_SCHEMA_VERSION,
    kind: "windows-host-probe-native-step-result",
    actionPlanSha256: plan.actionPlanSha256,
    operationId: intent.operationId,
    stepId: step.stepId,
    command: step.command,
    inputSha256: intent.inputSha256,
    transcriptSha256,
    transcriptPath: transcriptPath(transcriptSha256),
    outcome,
  };
  return validateStepResultRecord(
    {
      ...draft,
      recordSha256: hashProbeCanonicalJson({
        domain: "enduragent.windows-host-probe-native-step-result.v1",
        record: draft,
      }),
    },
    plan,
    step,
    intent,
  );
}

async function loadRetainedPlanTranscript(store, input, plan, intents, transcriptSha256) {
  const artifact = await readExactArtifact(
    store,
    transcriptPath(transcriptSha256),
    "native action transcript",
  );
  const validated = validateTranscriptForPlan(
    parseCanonicalObject(artifact.bytes, "retained native transcript"),
    input,
    plan,
    intents,
  );
  if (validated.transcript.transcriptSha256 !== transcriptSha256) {
    fail("NATIVE_LANE_TRANSCRIPT_BINDING", "retained native transcript digest differs");
  }
  return Object.freeze({ ...validated, transcriptBytes: artifact.bytes });
}

async function retainStepResult(store, record) {
  const bytes = canonicalBytes(record);
  const retained = await retainExactBytes(
    store,
    stepResultPath(record.operationId),
    bytes,
    `native step result ${record.operationId}`,
  );
  return Object.freeze({ record, resultArtifactSha256: retained.sha256 });
}

async function loadStepResult(store, plan, step, intent, expectedArtifactSha256) {
  const artifact = await readExactArtifact(
    store,
    stepResultPath(intent.operationId),
    `native step result ${intent.operationId}`,
  );
  if (expectedArtifactSha256 !== null && artifact.sha256 !== expectedArtifactSha256) {
    fail("NATIVE_LANE_STEP_RESULT_BINDING", "retained step result artifact digest differs");
  }
  const record = validateStepResultRecord(
    parseCanonicalObject(artifact.bytes, "retained native step result"),
    plan,
    step,
    intent,
  );
  return Object.freeze({
    record,
    resultArtifactSha256: artifact.sha256,
  });
}

function createPlanIntents(input, plan) {
  return Object.freeze(
    plan.steps.map((step) => {
      rejectReservedRequestValues(step.request, `native action plan step ${step.stepId}`);
      const operationId = deriveProbeNativeActionPlanStepOperationId(plan, step.stepId);
      const intent = createProbeNativeOperationIntent({
        actionPlan: plan,
        stepId: step.stepId,
        inputSha256: stepInputSha256(input, plan, step, operationId),
      });
      if (intent.operationId !== operationId) {
        fail("NATIVE_LANE_OPERATION_ID", "native step operation identifier is inconsistent");
      }
      return intent;
    }),
  );
}

async function recoverRetainedPlan({ store, journal, input, plan, intents, recoveries, digest }) {
  const retainedTranscript = await loadRetainedPlanTranscript(store, input, plan, intents, digest);
  const executions = [];
  for (const [index, step] of plan.steps.entries()) {
    const intent = intents[index];
    const recovery = recoveries[index];
    if (recovery.currentState === "claim") {
      fail("NATIVE_LANE_RECOVERY", "retained transcript names a step with no started effect");
    }
    if (recovery.currentState === "terminal-result-retained") {
      const loaded = await loadStepResult(store, plan, step, intent, recovery.terminalResultSha256);
      if (loaded.record.transcriptSha256 !== digest) {
        fail("NATIVE_LANE_RECOVERY", "terminal step result names another action transcript");
      }
      executions.push(loaded);
      continue;
    }
    await journal.recordTranscriptRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: digest,
    });
    const record = createStepResultRecord(
      plan,
      step,
      intent,
      digest,
      retainedTranscript.outcomes[index],
    );
    const retained = await retainStepResult(store, record);
    await journal.recordTerminalResultRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: retained.resultArtifactSha256,
    });
    executions.push(retained);
  }
  return Object.freeze({
    executions: Object.freeze(executions),
    transcript: retainedTranscript.transcript,
  });
}

function validateExecutionBatchCoordinates(entries, intents, label, readIntentSha256) {
  if (!Array.isArray(entries) || entries.length !== intents.length) {
    fail("NATIVE_LANE_EXECUTION_OWNERSHIP", `${label} differs from the native action plan`);
  }
  for (const [index, intent] of intents.entries()) {
    const entry = entries[index];
    if (
      !exactObject(entry) ||
      entry.operationId !== intent.operationId ||
      readIntentSha256(entry) !== intent.intentSha256
    ) {
      fail("NATIVE_LANE_EXECUTION_OWNERSHIP", `${label} differs from the native action plan`);
    }
  }
}

function isCrashRecoverableExecutionBatch(plan, recoveries) {
  let sawReadOnlyEffect = false;
  let sawClaim = false;
  for (const [index, recovery] of recoveries.entries()) {
    const step = plan.steps[index];
    if (
      recovery.transcriptSha256 !== null ||
      recovery.retainedTranscript !== null ||
      recovery.terminalResultSha256 !== null ||
      recovery.recoveryClass !== step.recoveryClass
    ) {
      return false;
    }
    if (recovery.currentState === "effect-started") {
      if (
        sawClaim ||
        step.recoveryClass !== "read-only-replay" ||
        recovery.decision !== "REPLAY_READ_ONLY" ||
        recovery.reason !== "read-only-effect-is-replayable"
      ) {
        return false;
      }
      sawReadOnlyEffect = true;
      continue;
    }
    if (
      recovery.currentState !== "claim" ||
      recovery.decision !== "INCONCLUSIVE" ||
      recovery.reason !== "claim-owner-is-unknown"
    ) {
      return false;
    }
    sawClaim = true;
  }
  return sawReadOnlyEffect;
}

function validatePreparedStep(prepared, step, intent) {
  if (
    !exactObject(prepared) ||
    prepared.command !== step.command ||
    prepared.operationId !== intent.operationId ||
    !exactObject(prepared.requestFrame) ||
    prepared.requestFrame.command !== step.command ||
    !exactObject(prepared.requestFrame.context) ||
    prepared.requestFrame.context.operationId !== intent.operationId ||
    typeof prepared.requestFrameSha256 !== "string" ||
    !sha256Pattern.test(prepared.requestFrameSha256)
  ) {
    fail("NATIVE_LANE_PREPARED_REQUEST", "prepared native request differs from planned step");
  }
  return prepared;
}

async function executeActionPlanWithLease({ store, journal, context, input, plan, openChannel }) {
  const intents = createPlanIntents(input, plan);
  const acquisition = await journal.acquireExecutionBatch(intents);
  if (!exactObject(acquisition) || typeof acquisition.acquired !== "boolean") {
    fail("NATIVE_LANE_EXECUTION_OWNERSHIP", "native action ownership result is invalid");
  }
  if (acquisition.acquired) {
    validateExecutionBatchCoordinates(
      acquisition.records,
      intents,
      "acquired records",
      (record) => record.intent?.intentSha256,
    );
    if (acquisition.records.some(({ currentState }) => currentState !== "claim")) {
      fail("NATIVE_LANE_EXECUTION_OWNERSHIP", "new native action ownership is not pristine");
    }
  } else {
    validateExecutionBatchCoordinates(
      acquisition.recoveries,
      intents,
      "recovery decisions",
      (recovery) => recovery.intentSha256,
    );
  }
  if (!acquisition.acquired) {
    const recoveries = acquisition.recoveries;
    const transcriptDigests = [
      ...new Set(
        recoveries
          .map(({ transcriptSha256 }) => transcriptSha256)
          .filter((value) => value !== null),
      ),
    ];
    if (transcriptDigests.length > 1) {
      fail("NATIVE_LANE_RECOVERY", "native action journal names multiple transcripts");
    }
    if (transcriptDigests.length === 1) {
      return recoverRetainedPlan({
        store,
        journal,
        input,
        plan,
        intents,
        recoveries,
        digest: transcriptDigests[0],
      });
    }
    if (!isCrashRecoverableExecutionBatch(plan, recoveries)) {
      for (const [index, recovery] of recoveries.entries()) {
        if (recovery.decision === "INSPECT_AND_RECONCILE") {
          fail(
            "NATIVE_LANE_RECONCILIATION_REQUIRED",
            `native step ${plan.steps[index].stepId} requires inspection and reconciliation`,
          );
        }
        if (recovery.decision === "INCONCLUSIVE") {
          fail(
            "NATIVE_LANE_INCONCLUSIVE",
            `native step ${plan.steps[index].stepId} cannot be replayed safely`,
          );
        }
      }
      fail(
        "NATIVE_LANE_EXECUTION_OWNERSHIP",
        "native action execution is already owned without a retained terminal transcript",
      );
    }
  }
  const requestTimeoutMs = Math.max(...plan.steps.map(({ timeoutMs }) => timeoutMs));
  const totalTimeoutMs = plan.steps.reduce((total, { timeoutMs }) => total + timeoutMs, 30_000);
  if (totalTimeoutMs > 3_600_000) {
    fail("NATIVE_LANE_TIMEOUT", "native action plan exceeds one channel lifetime");
  }
  const channel = await openChannel({
    runRoot: input.evidenceRoot,
    preflightBinding: expectedNativeBinding(input.preparedContext),
    candidateRoot: context.nativeBuild.candidateRoot,
    candidateDirectory: context.nativeBuild.candidateDirectory,
    requestTimeoutMs,
    totalTimeoutMs,
  });
  let closePromise;
  const closeOnce = () => {
    if (closePromise === undefined) {
      closePromise =
        typeof channel?.close === "function"
          ? Promise.resolve().then(() =>
              channel.close({ timeoutMs: Math.min(requestTimeoutMs, 10_000) }),
            )
          : Promise.resolve(undefined);
    }
    return closePromise;
  };
  const observedOutcomes = [];
  let completed;
  try {
    if (
      !exactObject(channel) ||
      typeof channel.prepare !== "function" ||
      typeof channel.executePrepared !== "function" ||
      typeof channel.close !== "function"
    ) {
      fail("NATIVE_LANE_EXECUTION", "native channel factory returned an invalid channel");
    }
    assertBuildIdentity(context, channel.build);
    for (const [index, step] of plan.steps.entries()) {
      const intent = intents[index];
      const prepared = validatePreparedStep(
        await channel.prepare(step.command, step.request, {
          timeoutMs: step.timeoutMs,
          operationId: intent.operationId,
        }),
        step,
        intent,
      );
      await journal.recordEffectStarted({
        operationId: intent.operationId,
        intentSha256: intent.intentSha256,
      });
      const outcome = await channel.executePrepared(prepared);
      if (
        !exactObject(outcome) ||
        typeof outcome.ok !== "boolean" ||
        outcome.command !== step.command ||
        outcome.operationId !== intent.operationId
      ) {
        fail("NATIVE_LANE_EXECUTION", "native channel outcome differs from planned step");
      }
      observedOutcomes.push(
        outcome.ok
          ? deepFreeze({ ok: true, result: outcome.result })
          : deepFreeze({ ok: false, error: outcome.error }),
      );
    }
    completed = await closeOnce();
  } catch (error) {
    await closeOnce().catch(() => undefined);
    throw error;
  }
  const validated = validateTranscriptForPlan(completed?.transcript, input, plan, intents);
  for (const [index, observed] of observedOutcomes.entries()) {
    if (observed.ok !== validated.outcomes[index].ok) {
      fail("NATIVE_LANE_EXECUTION", "native channel outcome differs from its transcript");
    }
    if (observed.ok && !canonicalEqual(observed.result, validated.outcomes[index].result)) {
      fail("NATIVE_LANE_EXECUTION", "native channel result differs from its transcript");
    }
    if (!observed.ok && !canonicalEqual(observed.error, validated.outcomes[index].error)) {
      fail("NATIVE_LANE_EXECUTION", "native channel failure differs from its transcript");
    }
  }
  const transcriptBytes = canonicalBytes(validated.transcript);
  await retainExactBytes(
    store,
    transcriptPath(validated.transcript.transcriptSha256),
    transcriptBytes,
    "native action transcript",
  );
  for (const intent of intents) {
    await journal.recordTranscriptRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: validated.transcript.transcriptSha256,
    });
  }
  const executions = [];
  for (const [index, step] of plan.steps.entries()) {
    const intent = intents[index];
    const record = createStepResultRecord(
      plan,
      step,
      intent,
      validated.transcript.transcriptSha256,
      validated.outcomes[index],
    );
    const retained = await retainStepResult(store, record);
    await journal.recordTerminalResultRetained({
      operationId: intent.operationId,
      intentSha256: intent.intentSha256,
      artifactSha256: retained.resultArtifactSha256,
    });
    executions.push(retained);
  }
  return Object.freeze({
    executions: Object.freeze(executions),
    transcript: validated.transcript,
  });
}

async function executeActionPlan(options) {
  const lease = await options.journal.tryAcquireExecutionLease();
  if (!exactObject(lease) || typeof lease.acquired !== "boolean") {
    fail("NATIVE_LANE_EXECUTION_LEASE", "native action execution lease result is invalid");
  }
  if (!lease.acquired) {
    assertExactKeys(lease, ["acquired"], "native action execution lease contention");
    fail("NATIVE_LANE_EXECUTION_BUSY", "another native action execution owner is active");
  }
  assertExactKeys(lease, ["acquired", "release"], "native action execution lease");
  requireFunction(lease.release, "native action execution lease release");
  try {
    return await executeActionPlanWithLease(options);
  } finally {
    await lease.release();
  }
}

async function validateDriverActionPlan(driver, verifiedControllerPlan, input, prerequisites) {
  const validated = await driver.validateActionPlan(
    deepFreeze({
      plan: verifiedControllerPlan.plan,
      verifiedControllerPlan,
      input,
      verifiedPrerequisites: prerequisites,
    }),
  );
  assertExactKeys(validated, ["plan", "primaryStepId"], "validated native row-driver plan");
  if (
    !canonicalEqual(validated.plan, verifiedControllerPlan.plan) ||
    typeof validated.primaryStepId !== "string" ||
    !validated.plan.steps.some(({ stepId }) => stepId === validated.primaryStepId)
  ) {
    fail("NATIVE_LANE_DRIVER_PLAN", "row driver did not validate the exact signed action plan");
  }
  return deepFreeze({ plan: validated.plan, primaryStepId: validated.primaryStepId });
}

function primaryCommandRecord(transcript, plan, primaryStepId) {
  const operationId = deriveProbeNativeActionPlanStepOperationId(plan, primaryStepId);
  const matching = transcript.records.filter(
    (record) => record.kind === "command" && record.operationId === operationId,
  );
  if (matching.length !== 1) {
    fail("NATIVE_LANE_DRIVER_PRIMARY", "primary native step has no unique transcript record");
  }
  return matching[0];
}

async function retainProjectionReceipt({
  store,
  input,
  driver,
  validatedPlan,
  verifiedControllerPlan,
  verifiedPrerequisites,
  execution,
  observations,
}) {
  const primary = primaryCommandRecord(
    execution.transcript,
    validatedPlan.plan,
    validatedPlan.primaryStepId,
  );
  const draft = {
    schemaVersion: PROBE_NATIVE_LANE_SCHEMA_VERSION,
    kind: "windows-host-probe-native-action-projection-receipt",
    driverId: driver.driverId,
    candidateSha256: input.preparedContext.candidateSha256,
    campaignRunId: input.command.campaignRunId,
    executionRunId: input.preparedContext.executionRunId,
    attemptId: input.command.attemptId,
    workId: input.command.workId,
    environmentId: input.command.environmentId,
    pathProfileId: input.command.pathProfileId,
    rowId: input.command.rowId,
    variantId: input.command.variantId,
    actionId: input.invocation.action.actionId,
    actionPlanSha256: validatedPlan.plan.actionPlanSha256,
    controllerPlanAuthoritySha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-controller-plan-authority.v1",
      provenance: verifiedControllerPlan.provenance,
      commitSha256: verifiedControllerPlan.commit.commitSha256,
      requestSha256: verifiedControllerPlan.request.requestSha256,
      responseSha256: verifiedControllerPlan.response.responseSha256,
    }),
    primaryStepId: validatedPlan.primaryStepId,
    primaryOperationId: primary.operationId,
    nativeTranscriptSha256: execution.transcript.transcriptSha256,
    prerequisiteEvidence: verifiedPrerequisites,
    stepResults: execution.executions.map(({ record, resultArtifactSha256 }) => ({
      stepId: record.stepId,
      operationId: record.operationId,
      recordSha256: record.recordSha256,
      resultArtifactSha256,
    })),
    observations,
  };
  const receipt = deepFreeze({
    ...draft,
    receiptSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-native-action-projection-receipt.v1",
      receipt: draft,
    }),
  });
  const path = `${probeSegmentArtifactPaths(input.workItem).evidence}/native-actions/${input.invocation.action.actionId}.json`;
  const retained = await retainExactBytes(
    store,
    path,
    canonicalBytes(receipt),
    "native action projection receipt",
  );
  return Object.freeze({
    primary,
    artifact: Object.freeze({ path: retained.path, sha256: retained.sha256 }),
  });
}

async function projectActionResult({
  store,
  input,
  driver,
  validatedPlan,
  verifiedControllerPlan,
  verifiedPrerequisites,
  execution,
}) {
  const primary = primaryCommandRecord(
    execution.transcript,
    validatedPlan.plan,
    validatedPlan.primaryStepId,
  );
  const projected = await driver.projectActionResult(
    deepFreeze({
      input,
      validatedPlan,
      verifiedControllerPlan,
      verifiedPrerequisites,
      transcript: execution.transcript,
      primaryRecord: primary,
      steps: execution.executions.map(({ record }) => ({
        step: validatedPlan.plan.steps.find(({ stepId }) => stepId === record.stepId),
        operationId: record.operationId,
        outcome: record.outcome,
        recordSha256: record.recordSha256,
      })),
    }),
  );
  assertExactKeys(projected, ["observations"], "native row-driver projection");
  if (!Array.isArray(projected.observations)) {
    fail("NATIVE_LANE_DRIVER_RESULT", "row driver projection has no observation array");
  }
  const receipt = await retainProjectionReceipt({
    store,
    input,
    driver,
    validatedPlan,
    verifiedControllerPlan,
    verifiedPrerequisites,
    execution,
    observations: projected.observations,
  });
  return deepFreeze({
    actionId: input.invocation.action.actionId,
    commandEvent: {
      sequence: input.invocation.action.capture.sequence,
      producerKind: "native-helper",
      commandId: driver.captureCommandId,
      requestSha256: receipt.primary.requestFrameSha256,
      responseSha256: receipt.primary.responseFrameSha256,
      nativeTranscriptSha256s: [execution.transcript.transcriptSha256],
      observations: projected.observations,
    },
    evidenceArtifacts: [receipt.artifact],
  });
}

async function validateProjectedResult(input, transcript, projected, store) {
  const capture = await executeProbeScenarioActionSlice({
    rowId: input.command.rowId,
    variantId: input.command.variantId,
    actionIds: [input.invocation.action.actionId],
    invokeNative: async () => projected,
  });
  const normalized = deepFreeze({
    actionId: input.invocation.action.actionId,
    commandEvent: capture.commandEvents[0] ?? null,
    evidenceArtifacts: capture.evidenceArtifacts,
  });
  if (!canonicalEqual(normalized, projected)) {
    fail("NATIVE_LANE_DRIVER_RESULT", "row driver result is not canonical for its action");
  }
  if (
    normalized.commandEvent === null ||
    !canonicalEqual(normalized.commandEvent.nativeTranscriptSha256s, [transcript.transcriptSha256])
  ) {
    fail("NATIVE_LANE_DRIVER_TRANSCRIPTS", "row driver did not bind the exact native transcripts");
  }
  const evidencePrefix = `${probeSegmentArtifactPaths(input.workItem).evidence}/`;
  for (const artifact of normalized.evidenceArtifacts) {
    rejectReservedPath(artifact.path, "row driver evidence artifact");
    if (!artifact.path.startsWith(evidencePrefix)) {
      fail("NATIVE_LANE_DRIVER_EVIDENCE", "row driver evidence escapes its segment namespace");
    }
  }
  await store.verifyArtifactSet(normalized.evidenceArtifacts);
  return normalized;
}

export function createProbeNativeLane(contextValue, options = {}) {
  const context = requireContext(contextValue);
  if (!exactObject(options)) fail("NATIVE_LANE_OPTIONS", "native lane options must be an object");
  const optionKeys = Object.keys(options).sort(compareUtf8);
  const allowed = ["observePreflight", "openNativeChannel", "rowDrivers"];
  if (optionKeys.some((key) => !allowed.includes(key)) || !Object.hasOwn(options, "rowDrivers")) {
    fail("NATIVE_LANE_OPTIONS", "native lane options have an invalid field set");
  }
  const drivers = requireDrivers(options.rowDrivers);
  const observePreflight =
    options.observePreflight === undefined
      ? observeNativePreflight
      : requireFunction(options.observePreflight, "options.observePreflight");
  const openChannel =
    options.openNativeChannel === undefined
      ? openNativeChannel
      : requireFunction(options.openNativeChannel, "options.openNativeChannel");
  const memo = new Map();

  async function resolvePreflightRequest(input) {
    const scope = preflightScope(input);
    const key = preflightKey(scope);
    let promise = memo.get(key);
    if (promise === undefined) {
      promise = producePreflight(context, observePreflight, input);
      memo.set(key, promise);
    }
    try {
      return (await promise).request;
    } catch (error) {
      if (memo.get(key) === promise) memo.delete(key);
      throw error;
    }
  }

  async function observeGuest({ request, evidenceRoot }) {
    if (!exactObject(request)) fail("NATIVE_LANE_PREFLIGHT_REQUEST", "guest request is invalid");
    const scope = Object.freeze({
      campaignRunId: request.campaignRunId,
      executionRunId: request.executionRunId,
      executionBundleId: request.executionBundleId,
      attemptId: request.attemptId,
      environmentId: request.environmentId,
      pathProfileId: request.pathProfileId,
      candidateSha256: context.loadedBootstrap.candidate.candidateSha256,
      attestationSha256: attestationFor(context, request.environmentId).attestationSha256,
      evidenceRoot,
    });
    const entry = memo.get(preflightKey(scope));
    if (entry === undefined) {
      fail("NATIVE_LANE_PREFLIGHT_MEMO", "guest observation has no complete live preflight");
    }
    const completed = await entry;
    const expectedRequest = {
      ...completed.request,
      nativeCandidateDigest: context.nativeBuild.candidateDigest,
      nativeManifestSha256: context.nativeBuild.manifestSha256,
    };
    if (
      !canonicalEqual(request, expectedRequest) ||
      completed.scope.evidenceRoot !== evidenceRoot
    ) {
      fail("NATIVE_LANE_PREFLIGHT_REQUEST", "guest request differs from its live preflight");
    }
    return completed.guestObservation;
  }

  async function invokeScenarioAction(input) {
    if (!exactObject(input) || !exactObject(input.command) || !exactObject(input.preparedContext)) {
      fail("NATIVE_LANE_ACTION_INPUT", "native scenario action input is incomplete");
    }
    if (input.transportAuthority !== "injected-authoritative-lab") {
      fail("NATIVE_LANE_ACTION_AUTHORITY", "native scenario action has no lab authority");
    }
    const binding = createProbeRuntimeActionBinding({
      command: input.command,
      invocation: input.invocation,
      preparedContext: input.preparedContext,
    });
    if (!exactObject(input.execution) || !canonicalEqual(input.execution, binding.execution)) {
      fail("NATIVE_LANE_ACTION_EXECUTION", "native scenario execution mapping differs");
    }
    if (input.operationId !== binding.operationId) {
      fail("NATIVE_LANE_ACTION_OPERATION", "native scenario operation identity differs");
    }
    if (
      input.operationIntentPath !== binding.operationIntentPath ||
      input.operationResultPath !== binding.operationResultPath
    ) {
      fail("NATIVE_LANE_ACTION_PATH", "native scenario action path binding differs");
    }
    rejectReservedPath(input.operationIntentPath, "runtime action intent");
    rejectReservedPath(input.operationResultPath, "runtime action result");
    const store = await resolveBoundStore(
      context,
      input.command.campaignRunId,
      input.command.environmentId,
      input.command.pathProfileId,
      input.evidenceRoot,
    );
    const intentArtifact = await readExactArtifact(
      store,
      input.operationIntentPath,
      "runtime native action intent",
    );
    const runtimeIntent = parseCanonicalObject(
      intentArtifact.bytes,
      "runtime native action intent",
    );
    if (!canonicalEqual(runtimeIntent, binding.intent)) {
      fail("NATIVE_LANE_ACTION_INTENT", "retained runtime action intent differs");
    }
    if (
      !canonicalEqual(input.candidate, context.loadedBootstrap.candidate) ||
      !canonicalEqual(input.attestation, attestationFor(context, input.command.environmentId))
    ) {
      fail("NATIVE_LANE_ACTION_AUTHORITY", "native scenario action authority differs");
    }
    const verified = await readVerifiedControllerNativeActionPlan({
      store,
      loadedBootstrap: context.loadedBootstrap,
      campaignRunId: input.command.campaignRunId,
      executionRunId: input.preparedContext.executionRunId,
      attemptId: input.command.attemptId,
      workId: input.command.workId,
      environmentId: input.command.environmentId,
      pathProfileId: input.command.pathProfileId,
      rowId: input.command.rowId,
      variantId: input.command.variantId,
      consumerActionId: input.invocation.action.actionId,
    });
    const rootIdentity =
      input.preparedContext.pathProfileObservation?.evidenceRootObjectIdentitySha256;
    const plan = verifyProbeNativeActionPlanBinding(verified.plan, {
      command: input.command,
      workItem: input.workItem,
      preparedContext: input.preparedContext,
      invocation: input.invocation,
      operationId: input.operationId,
      evidenceRootObjectIdentitySha256: rootIdentity,
    });
    for (const prerequisite of plan.prerequisiteEvidence) {
      rejectReservedPath(prerequisite.path, "native action plan prerequisite");
    }
    const verifiedPrerequisites = await store.verifyArtifactSet(plan.prerequisiteEvidence);
    const driverKey = probeNativeLaneDriverKey(
      input.command.rowId,
      input.invocation.action.actionId,
    );
    const driver = drivers[driverKey];
    if (driver === undefined) {
      fail("NATIVE_LANE_DRIVER_MISSING", `native row driver is missing: ${driverKey}`);
    }
    const validatedPlan = await validateDriverActionPlan(
      driver,
      verified,
      input,
      verifiedPrerequisites,
    );
    await ensureDirectory(store, journalDirectory);
    await ensureDirectory(store, transcriptDirectory);
    await ensureDirectory(store, stepResultDirectory);
    const journal = await openProbeNativeOperationJournal({
      root: join(store.root, ...journalDirectory.split("/")),
    });
    try {
      const execution = await executeActionPlan({
        store,
        journal,
        context,
        input,
        plan: validatedPlan.plan,
        openChannel,
      });
      const projected = await projectActionResult({
        store,
        input,
        driver,
        validatedPlan,
        verifiedControllerPlan: verified,
        verifiedPrerequisites,
        execution,
      });
      const result = await validateProjectedResult(input, execution.transcript, projected, store);
      const retained = await retainExactBytes(
        store,
        input.operationResultPath,
        canonicalBytes(result),
        `native scenario action result ${input.invocation.action.actionId}`,
      );
      return Object.freeze({ operationId: input.operationId, resultSha256: retained.sha256 });
    } finally {
      await journal.close();
    }
  }

  async function readNativeTranscript(input) {
    if (!exactObject(input) || !exactObject(input.command) || !exactObject(input.preparedContext)) {
      fail("NATIVE_LANE_TRANSCRIPT_READ", "native transcript read input is incomplete");
    }
    requireSha256(input.transcriptSha256, "native transcript read sha256");
    rejectReservedPath(input.retainedPath, "runtime native transcript destination");
    const store = await resolveBoundStore(
      context,
      input.command.campaignRunId,
      input.command.environmentId,
      input.command.pathProfileId,
      input.evidenceRoot,
    );
    const trustedWorkItem = getProbeRunWorkItem({
      environmentId: input.command.environmentId,
      pathProfileId: input.command.pathProfileId,
      rowId: input.command.rowId,
      variantId: input.command.variantId,
    });
    const expectedRetainedPath = `${probeSegmentArtifactPaths(trustedWorkItem).nativeTranscripts}/${input.transcriptSha256}.json`;
    if (
      !canonicalEqual(input.workItem, trustedWorkItem) ||
      input.command.workId !== trustedWorkItem.workId ||
      input.preparedContext.campaignRunId !== input.command.campaignRunId ||
      input.preparedContext.attemptId !== input.command.attemptId ||
      input.preparedContext.environmentId !== input.command.environmentId ||
      input.preparedContext.pathProfileId !== input.command.pathProfileId ||
      input.retainedPath !== expectedRetainedPath
    ) {
      fail("NATIVE_LANE_TRANSCRIPT_READ", "native transcript read coordinate differs");
    }
    const artifact = await readExactArtifact(
      store,
      transcriptPath(input.transcriptSha256),
      "durable native transcript",
    );
    const transcript = validateNativeCommandTranscript(
      parseCanonicalObject(artifact.bytes, "durable native transcript"),
    );
    if (transcript.transcriptSha256 !== input.transcriptSha256) {
      fail("NATIVE_LANE_TRANSCRIPT_READ", "durable native transcript digest differs");
    }
    const binding = expectedNativeBinding(input.preparedContext);
    for (const [key, expected] of Object.entries(binding)) {
      if (transcript.binding[key] !== expected) {
        fail("NATIVE_LANE_TRANSCRIPT_READ", `durable native transcript ${key} differs`);
      }
    }
    return Buffer.from(artifact.bytes);
  }

  return Object.freeze({
    transport: Object.freeze({ observeGuest, invokeScenarioAction, readNativeTranscript }),
    resolvePreflightRequest,
  });
}
