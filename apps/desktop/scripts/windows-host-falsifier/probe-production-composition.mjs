import { performance } from "node:perf_hooks";
import { win32 } from "node:path";

import { openEvidenceStore } from "./evidence-store.mjs";
import { loadNativeHelper } from "./native-client.mjs";
import { createProbeAuthoritativeRuntime } from "./probe-authoritative-runtime.mjs";
import { loadProbeBootstrap } from "./probe-bootstrap.mjs";
import {
  PROBE_ENVIRONMENT_IDS,
  PROBE_PATH_PROFILE_IDS,
  canonicalProbeJson,
} from "./probe-contract.mjs";
import { createProbeControllerSpoolTransport } from "./probe-controller-spool-transport.mjs";
import { createProbeNativeLane } from "./probe-native-lane.mjs";
import { PROBE_NATIVE_ROW_DRIVERS } from "./probe-native-row-drivers.mjs";

export const PROBE_PRODUCTION_COMPOSITION_SCHEMA_VERSION = 1;
export const PROBE_PRODUCTION_CLOCK_AUTHORITY = "attested-standard-user-system-clock";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const factoryKeys = Object.freeze([
  "loadBootstrap",
  "loadNativeHelper",
  "openEvidenceStore",
  "createNativeLane",
  "createBrokerLane",
  "createControllerLane",
  "now",
  "monotonicNow",
]);

export class ProbeProductionCompositionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeProductionCompositionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeProductionCompositionError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, optional = [], label = "value") {
  if (!exactObject(value)) fail("COMPOSITION_SCHEMA", `${label} must be a plain object`);
  const permitted = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !permitted.has(key)) {
      fail("COMPOSITION_SCHEMA", `${label} has an unexpected key: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("COMPOSITION_SCHEMA", `${label}.${key} must be an enumerable data property`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("COMPOSITION_SCHEMA", `${label} is missing key: ${key}`);
    }
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== "function") {
    fail("COMPOSITION_FACTORY", `${label} must be a function`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("COMPOSITION_SCHEMA", `${label} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("COMPOSITION_SHA256", `${label} must be lowercase SHA-256 hex`);
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function coordinateKey(environmentId, pathProfileId) {
  return `${environmentId}\0${pathProfileId}`;
}

function selectFactories(supplied) {
  if (supplied === undefined) {
    return Object.freeze({
      loadBootstrap: loadProbeBootstrap,
      loadNativeHelper,
      openEvidenceStore,
      createNativeLane: (context) =>
        createProbeNativeLane(context, { rowDrivers: PROBE_NATIVE_ROW_DRIVERS }),
      createBrokerLane: () =>
        fail(
          "COMPOSITION_BROKER_LANE_UNAVAILABLE",
          "role-local broker observation is unavailable; inject an independent broker lane for the primary-user, second-user, and remote-peer roles",
        ),
      createControllerLane: ({ loadedBootstrap, resolveStore }) =>
        createProbeControllerSpoolTransport({ loadedBootstrap, resolveStore }),
      now: () => new Date(),
      monotonicNow: () => performance.now(),
    });
  }
  const factories = supplied;
  assertExactKeys(factories, factoryKeys, [], "factories");
  return Object.freeze({
    loadBootstrap: requireFunction(factories.loadBootstrap, "factories.loadBootstrap"),
    loadNativeHelper: requireFunction(factories.loadNativeHelper, "factories.loadNativeHelper"),
    openEvidenceStore: requireFunction(factories.openEvidenceStore, "factories.openEvidenceStore"),
    createNativeLane: requireFunction(factories.createNativeLane, "factories.createNativeLane"),
    createBrokerLane: requireFunction(factories.createBrokerLane, "factories.createBrokerLane"),
    createControllerLane: requireFunction(
      factories.createControllerLane,
      "factories.createControllerLane",
    ),
    now: requireFunction(factories.now, "factories.now"),
    monotonicNow: requireFunction(factories.monotonicNow, "factories.monotonicNow"),
  });
}

function validateClock(factories) {
  const wallClock = factories.now();
  if (!(wallClock instanceof Date) || !Number.isFinite(wallClock.getTime())) {
    fail("COMPOSITION_CLOCK", "the standard-user wall clock returned an invalid instant");
  }
  const monotonicClock = factories.monotonicNow();
  if (
    typeof monotonicClock !== "number" ||
    !Number.isFinite(monotonicClock) ||
    monotonicClock < 0
  ) {
    fail("COMPOSITION_CLOCK", "the process monotonic clock returned an invalid value");
  }
  return Object.freeze({ wallClock, monotonicClock });
}

function validateClockAttestations(loadedBootstrap) {
  if (!Array.isArray(loadedBootstrap?.attestations) || loadedBootstrap.attestations.length === 0) {
    fail("COMPOSITION_CLOCK_AUTHORITY", "bootstrap attestations are required for clock authority");
  }
  for (const attestation of loadedBootstrap.attestations) {
    if (
      attestation?.host?.elevated !== false ||
      attestation?.capabilities?.standardUserNonElevated !== true ||
      attestation?.runner?.interactiveSessionOwnerSidSha256 !==
        attestation?.host?.standardUserSidSha256
    ) {
      fail(
        "COMPOSITION_CLOCK_AUTHORITY",
        "every environment must attest the interactive non-elevated standard-user session",
      );
    }
  }
}

function expectedEvidenceBindings(loadedBootstrap) {
  const mappings = loadedBootstrap?.bootstrap?.evidenceRoots;
  const expected = PROBE_ENVIRONMENT_IDS.flatMap((environmentId) =>
    PROBE_PATH_PROFILE_IDS.map((pathProfileId) => ({ environmentId, pathProfileId })),
  );
  if (!Array.isArray(mappings) || mappings.length !== expected.length) {
    fail("COMPOSITION_EVIDENCE_ROOTS", "bootstrap must contain the exact 2x2 evidence mapping");
  }
  return Object.freeze(
    expected.map((coordinate, index) => {
      const mapping = mappings[index];
      assertExactKeys(
        mapping,
        ["environmentId", "pathProfileId", "root"],
        [],
        `bootstrap evidence mapping ${index}`,
      );
      const { environmentId, pathProfileId, root } = mapping;
      if (
        environmentId !== coordinate.environmentId ||
        pathProfileId !== coordinate.pathProfileId ||
        typeof root !== "string" ||
        root.length === 0
      ) {
        fail(
          "COMPOSITION_EVIDENCE_ROOTS",
          "bootstrap evidence mappings must be complete, exact, and ordered",
        );
      }
      return Object.freeze({ ...coordinate, root });
    }),
  );
}

function requireNativeBuildShape(nativeBuild) {
  const keys = [
    "assemblyPath",
    "buildDirectory",
    "candidateRoot",
    "candidateDirectory",
    "nativeHelperArtifactPath",
    "snapshotDirectory",
    "manifestPath",
    "assemblySha256",
    "sourceBundleSha256",
    "toolchainDigest",
    "candidateDigest",
    "manifestSha256",
    "sources",
    "toolchain",
  ];
  assertExactKeys(nativeBuild, keys, [], "native build");
  for (const key of [
    "assemblyPath",
    "buildDirectory",
    "candidateRoot",
    "candidateDirectory",
    "nativeHelperArtifactPath",
    "snapshotDirectory",
    "manifestPath",
  ]) {
    requireString(nativeBuild[key], `nativeBuild.${key}`);
  }
  for (const key of [
    "assemblySha256",
    "sourceBundleSha256",
    "toolchainDigest",
    "candidateDigest",
    "manifestSha256",
  ]) {
    requireSha256(nativeBuild[key], `nativeBuild.${key}`);
  }
  if (!Array.isArray(nativeBuild.sources) || !exactObject(nativeBuild.toolchain)) {
    fail("COMPOSITION_NATIVE_BUILD", "native build source or toolchain inventory is invalid");
  }
  return nativeBuild;
}

function canonicalEqual(left, right) {
  try {
    return canonicalProbeJson(left) === canonicalProbeJson(right);
  } catch {
    return false;
  }
}

function bindNativeBuild(loadedBootstrap, nativeBuild) {
  const bootstrap = loadedBootstrap?.bootstrap;
  const manifest = loadedBootstrap?.nativeCandidateManifest;
  const candidate = loadedBootstrap?.candidate;
  if (!exactObject(bootstrap) || !exactObject(manifest) || !exactObject(candidate)) {
    fail("COMPOSITION_BOOTSTRAP", "bootstrap loader returned an incomplete validated inventory");
  }
  const artifactPath = bootstrap.candidateBinaries?.nativeHelperArtifactPath;
  const nsisArtifactPath = bootstrap.candidateBinaries?.nsisArtifactPath;
  const binaryRoot = bootstrap.binaryRoot;
  requireString(artifactPath, "bootstrap.candidateBinaries.nativeHelperArtifactPath");
  requireString(nsisArtifactPath, "bootstrap.candidateBinaries.nsisArtifactPath");
  requireString(binaryRoot, "bootstrap.binaryRoot");
  const expectedAssemblyPath = win32.join(binaryRoot, ...artifactPath.split("/"));
  const candidateDirectory = win32.dirname(expectedAssemblyPath);
  const expectedSnapshotDirectory = win32.join(candidateDirectory, "source");
  const expectedManifestPath = win32.join(candidateDirectory, "native-candidate.json");
  const candidateBinaries = Array.isArray(candidate.binaryHashes) ? candidate.binaryHashes : [];
  const candidateBinary = candidateBinaries.find((entry) => entry.path === artifactPath);
  const candidateNsis = candidateBinaries.find((entry) => entry.path === nsisArtifactPath);
  const native = requireNativeBuildShape(nativeBuild);
  const matches =
    exactObject(manifest.assembly) &&
    manifest.assembly.name === win32.basename(expectedAssemblyPath) &&
    manifest.assembly.name === win32.basename(native.assemblyPath) &&
    native.assemblyPath === expectedAssemblyPath &&
    native.buildDirectory === candidateDirectory &&
    native.candidateRoot === binaryRoot &&
    native.candidateDirectory === candidateDirectory &&
    native.nativeHelperArtifactPath === artifactPath &&
    native.snapshotDirectory === expectedSnapshotDirectory &&
    native.manifestPath === expectedManifestPath &&
    native.manifestSha256 === bootstrap.nativeCandidateManifest?.sha256 &&
    native.assemblySha256 === manifest.assembly.sha256 &&
    candidateBinary?.sha256 === manifest.assembly.sha256 &&
    candidateNsis !== undefined &&
    candidateNsis.path !== candidateBinary?.path &&
    native.candidateDigest === manifest.candidateDigest &&
    native.sourceBundleSha256 === manifest.sourceBundleSha256 &&
    native.toolchainDigest === manifest.toolchainDigest &&
    canonicalEqual(native.sources, manifest.sources) &&
    canonicalEqual(native.toolchain, manifest.toolchain);
  if (!matches) {
    fail(
      "COMPOSITION_NATIVE_BINDING",
      "loaded native helper differs from the bootstrap-bound candidate inventory",
    );
  }
  return Object.freeze({ candidateDirectory, expectedAssemblyPath });
}

function validateNativeLane(value) {
  assertExactKeys(value, ["transport", "resolvePreflightRequest"], [], "native lane");
  requireFunction(value.resolvePreflightRequest, "native lane resolvePreflightRequest");
  if (!exactObject(value.transport)) {
    fail("COMPOSITION_NATIVE_LANE", "native lane transport must be a plain object");
  }
  return value;
}

function bindNativePreflightIdentity(resolvePreflightRequest, nativeBuild) {
  return async (input) => {
    const request = await resolvePreflightRequest(input);
    if (!exactObject(request)) {
      fail("COMPOSITION_PREFLIGHT_REQUEST", "native lane must resolve a plain preflight request");
    }
    return deepFreeze({
      ...request,
      nativeCandidateDigest: nativeBuild.candidateDigest,
      nativeManifestSha256: nativeBuild.manifestSha256,
    });
  };
}

function validateControllerLane(value) {
  if (!exactObject(value)) {
    fail("COMPOSITION_CONTROLLER_LANE", "controller lane must return a plain transport object");
  }
  return value;
}

function validateBrokerLane(value, nativeTransport) {
  assertExactKeys(value, ["observeBrokerMailbox"], [], "broker lane");
  requireFunction(value.observeBrokerMailbox, "broker lane observeBrokerMailbox");
  if (
    value === nativeTransport ||
    Object.values(nativeTransport).some((nativeOperation) =>
      Object.is(value.observeBrokerMailbox, nativeOperation),
    )
  ) {
    fail(
      "COMPOSITION_BROKER_LANE_CROSS_WIRED",
      "broker mailbox observation must use an independent role-local lane, not the primary native lane",
    );
  }
  return value;
}

export async function createAuthoritativeProbeComposition(options) {
  assertExactKeys(
    options,
    ["bootstrapRoot", "bootstrapSha256"],
    ["factories"],
    "composition options",
  );
  const bootstrapRoot = requireString(options.bootstrapRoot, "bootstrapRoot");
  const bootstrapSha256 = requireSha256(options.bootstrapSha256, "bootstrapSha256");
  const factories = selectFactories(options.factories);
  const loadedBootstrap = await factories.loadBootstrap({
    root: bootstrapRoot,
    expectedSha256: bootstrapSha256,
  });
  if (!exactObject(loadedBootstrap) || loadedBootstrap.bootstrapSha256 !== bootstrapSha256) {
    fail(
      "COMPOSITION_BOOTSTRAP",
      "bootstrap loader did not return the requested digest-bound bootstrap",
    );
  }
  validateClockAttestations(loadedBootstrap);
  const evidenceBindings = expectedEvidenceBindings(loadedBootstrap);
  const artifactPath = loadedBootstrap.bootstrap?.candidateBinaries?.nativeHelperArtifactPath;
  const binaryRoot = loadedBootstrap.bootstrap?.binaryRoot;
  requireString(artifactPath, "bootstrap.candidateBinaries.nativeHelperArtifactPath");
  requireString(binaryRoot, "bootstrap.binaryRoot");
  const candidateDirectory = win32.dirname(win32.join(binaryRoot, ...artifactPath.split("/")));
  const nativeBuild = await factories.loadNativeHelper({
    candidateRoot: binaryRoot,
    candidateDirectory,
  });
  const nativeBinding = bindNativeBuild(loadedBootstrap, nativeBuild);
  const clock = validateClock(factories);

  const stores = new Map();
  const evidenceStoreMethods = [
    "createDirectory",
    "writeBytes",
    "writeCanonicalJson",
    "readArtifact",
    "verifyArtifactSet",
    "scan",
    "list",
    "assertRootStable",
  ];
  for (const binding of evidenceBindings) {
    const store = await factories.openEvidenceStore({ root: binding.root });
    if (
      store === null ||
      typeof store !== "object" ||
      store.root !== binding.root ||
      evidenceStoreMethods.some((method) => typeof store[method] !== "function")
    ) {
      fail(
        "COMPOSITION_EVIDENCE_STORE",
        "evidence store must preserve the exact bootstrap-bound root",
      );
    }
    await store.assertRootStable();
    stores.set(coordinateKey(binding.environmentId, binding.pathProfileId), store);
  }

  async function resolveStore(coordinate) {
    assertExactKeys(
      coordinate,
      ["campaignRunId", "environmentId", "pathProfileId"],
      [],
      "evidence coordinate",
    );
    if (coordinate.campaignRunId !== loadedBootstrap.bootstrap.campaignRunId) {
      fail("COMPOSITION_COORDINATE", "evidence coordinate belongs to another campaign run");
    }
    const key = coordinateKey(coordinate.environmentId, coordinate.pathProfileId);
    const store = stores.get(key);
    const binding = evidenceBindings.find(
      (entry) =>
        entry.environmentId === coordinate.environmentId &&
        entry.pathProfileId === coordinate.pathProfileId,
    );
    if (store === undefined || binding === undefined) {
      fail("COMPOSITION_COORDINATE", "evidence coordinate is not bootstrap-bound");
    }
    if (store.root !== binding.root) {
      fail("COMPOSITION_EVIDENCE_STORE", "cached evidence store root changed");
    }
    await store.assertRootStable();
    return store;
  }

  const metadata = deepFreeze({
    schemaVersion: PROBE_PRODUCTION_COMPOSITION_SCHEMA_VERSION,
    kind: "windows-host-probe-production-composition-metadata",
    clockAuthority: PROBE_PRODUCTION_CLOCK_AUTHORITY,
    networkTimeClaim: "none",
    constructedAt: clock.wallClock.toISOString(),
    constructionMonotonic: clock.monotonicClock,
    nativeCandidateDirectory: nativeBinding.candidateDirectory,
    evidenceRootCount: evidenceBindings.length,
  });
  const laneContext = deepFreeze({
    loadedBootstrap,
    nativeBuild,
    resolveStore,
    metadata,
  });
  const nativeLane = validateNativeLane(await factories.createNativeLane(laneContext));
  const brokerTransport = validateBrokerLane(
    await factories.createBrokerLane(laneContext),
    nativeLane.transport,
  );
  const controllerTransport = validateControllerLane(
    await factories.createControllerLane(laneContext),
  );
  const runtime = createProbeAuthoritativeRuntime({
    campaignRunId: loadedBootstrap.bootstrap.campaignRunId,
    candidate: loadedBootstrap.candidate,
    attestations: loadedBootstrap.attestations,
    runAuthorization: loadedBootstrap.runAuthorization,
    brokerEnrollments: loadedBootstrap.bootstrap.brokerEnrollments,
    repositoryRoot: loadedBootstrap.bootstrap.repositoryRoot,
    binaryRoot: loadedBootstrap.bootstrap.binaryRoot,
    lifecyclePolicy: loadedBootstrap.lifecyclePolicy,
    resolveStore,
    resolvePreflightRequest: bindNativePreflightIdentity(
      nativeLane.resolvePreflightRequest,
      nativeBuild,
    ),
    nativeTransport: nativeLane.transport,
    brokerTransport,
    controllerTransport,
    now: factories.now,
    monotonicNow: factories.monotonicNow,
  });
  const dispatchers = Object.freeze({
    prepare: runtime.prepare,
    segment: runtime.segment,
    checkpoint: runtime.checkpoint,
    resume: runtime.resume,
    finalizeSegment: runtime.finalizeSegment,
    finalizeCampaign: runtime.finalizeCampaign,
  });
  return deepFreeze({ loadedBootstrap, nativeBuild, runtime, dispatchers, metadata });
}
