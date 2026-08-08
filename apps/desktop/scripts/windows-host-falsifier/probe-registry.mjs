import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { PROBE_CAMPAIGN_MANIFEST, hashProbeCanonicalJson } from "./probe-contract.mjs";

export const PROBE_VERIFIER_SOURCE_PATH =
  "apps/desktop/scripts/windows-host-falsifier/probe-registry.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const reasonCodePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

export class ProbeVerifierRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeVerifierRegistryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeVerifierRegistryError(code, message);
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, required, label) {
  if (!exactObject(value)) fail("VERIFIER_SCHEMA_OBJECT", `${label} must be an object`);
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("VERIFIER_SCHEMA_UNKNOWN_KEY", `${label} has unexpected key: ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("VERIFIER_SCHEMA_MISSING_KEY", `${label} is missing key: ${key}`);
    }
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("VERIFIER_SCHEMA_SHA256", `${label} must be lowercase 64-hex`);
  }
}

function assertNullableSha256(value, label) {
  if (value !== null) assertSha256(value, label);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    fail("VERIFIER_SCHEMA_BOOLEAN", `${label} must be boolean`);
  }
}

function assertNullableBoolean(value, label) {
  if (value !== null) assertBoolean(value, label);
}

function assertNullableNonnegativeInteger(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    fail("VERIFIER_SCHEMA_INTEGER", `${label} must be null or a non-negative safe integer`);
  }
}

function assertNullablePositiveInteger(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    fail("VERIFIER_SCHEMA_INTEGER", `${label} must be null or a positive safe integer`);
  }
}

function assertNullableNonnegativeFinite(value, label) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    fail("VERIFIER_SCHEMA_NUMBER", `${label} must be null or finite and non-negative`);
  }
}

function assertNullableEnum(value, allowed, label) {
  if (value !== null && !allowed.includes(value)) {
    fail("VERIFIER_SCHEMA_ENUM", `${label} is not allowlisted`);
  }
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail("VERIFIER_SCHEMA_ENUM", `${label} is not allowlisted`);
  }
}

function assertNullableReasonCode(value, label) {
  if (value !== null && (typeof value !== "string" || !reasonCodePattern.test(value))) {
    fail("VERIFIER_SCHEMA_REASON", `${label} must be null or an uppercase underscore reason code`);
  }
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function assertSortedUniqueSha256(values, label) {
  if (!Array.isArray(values)) fail("VERIFIER_SCHEMA_ARRAY", `${label} must be an array`);
  let previous = null;
  for (const [index, value] of values.entries()) {
    assertSha256(value, `${label}[${index}]`);
    if (previous !== null && compareUtf8(previous, value) >= 0) {
      fail("VERIFIER_SCHEMA_ORDER", `${label} must be strictly sorted and unique`);
    }
    previous = value;
  }
}

function assertSortedUniqueIntegers(values, label) {
  if (!Array.isArray(values)) fail("VERIFIER_SCHEMA_ARRAY", `${label} must be an array`);
  let previous = null;
  for (const [index, value] of values.entries()) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("VERIFIER_SCHEMA_INTEGER", `${label}[${index}] must be a non-negative safe integer`);
    }
    if (previous !== null && previous >= value) {
      fail("VERIFIER_SCHEMA_ORDER", `${label} must be strictly sorted and unique`);
    }
    previous = value;
  }
}

function assertSortedUniqueIdentifiers(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("VERIFIER_SCHEMA_ARRAY", `${label} must be a non-empty array`);
  }
  let previous = null;
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !identifierPattern.test(value)) {
      fail("VERIFIER_SCHEMA_IDENTIFIER", `${label}[${index}] must be lowercase kebab-case`);
    }
    if (previous !== null && compareUtf8(previous, value) >= 0) {
      fail("VERIFIER_SCHEMA_ORDER", `${label} must be strictly sorted and unique`);
    }
    previous = value;
  }
}

function assertArtifactHashes(values) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("VERIFIER_ARTIFACTS", "artifactHashes must be a non-empty array");
  }
  let previous = null;
  const foldedPaths = new Set();
  for (const [index, value] of values.entries()) {
    assertExactKeys(value, ["path", "sha256"], `artifactHashes[${index}]`);
    if (
      typeof value.path !== "string" ||
      value.path.length === 0 ||
      value.path.includes("\\") ||
      value.path.startsWith("/") ||
      value.path !== value.path.normalize("NFC") ||
      value.path
        .split("/")
        .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      fail(
        "VERIFIER_ARTIFACT_PATH",
        `artifactHashes[${index}].path must be a normalized relative slash path`,
      );
    }
    assertSha256(value.sha256, `artifactHashes[${index}].sha256`);
    if (previous !== null && compareUtf8(previous, value.path) >= 0) {
      fail("VERIFIER_ARTIFACT_ORDER", "artifactHashes must be strictly path sorted");
    }
    const folded = value.path.toLocaleLowerCase("en-US");
    if (foldedPaths.has(folded)) {
      fail("VERIFIER_ARTIFACT_COLLISION", "artifactHashes has a case-colliding path");
    }
    foldedPaths.add(folded);
    previous = value.path;
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const mechanisms = deepFreeze({
  "F-01": {
    schemaVersion: 1,
    mechanismId: "win32-file-identity-home-key-v1",
    primitive: "handle-derived-volume-and-file-identity",
    guarantees: ["alias-convergence", "local-ntfs-only", "move-sensitive", "restart-stable"],
  },
  "F-02": {
    schemaVersion: 1,
    mechanismId: "win32-private-directory-dacl-v1",
    primitive: "owner-bound-protected-dacl",
    guarantees: ["broad-principals-removed", "independent-access-check", "owner-bound"],
  },
  "F-03": {
    schemaVersion: 1,
    mechanismId: "win32-private-regular-file-v1",
    primitive: "handle-open-with-final-object-proof",
    guarantees: ["dacl-proved", "payload-round-trip", "regular-file-only", "single-link-only"],
  },
  "F-04": {
    schemaVersion: 1,
    mechanismId: "win32-handle-relative-reparse-guard-v1",
    primitive: "handle-bound-root-and-reparse-refusal",
    guarantees: ["bounded-root", "no-reparse-traversal", "swap-race-contained"],
  },
  "F-05": {
    schemaVersion: 1,
    mechanismId: "win32-handle-bound-object-mutation-v1",
    primitive: "inspect-and-mutate-same-object-identity",
    guarantees: ["hard-link-aware", "identity-rechecked", "stale-identity-refused"],
  },
  "F-06": {
    schemaVersion: 1,
    mechanismId: "win32-atomic-private-file-replace-v1",
    primitive: "flush-then-replace-with-bounded-sharing-retry",
    guarantees: ["bounded-retry", "old-or-new-observation", "owned-temp-cleanup"],
  },
  "F-07": {
    schemaVersion: 1,
    mechanismId: "win32-truthful-replacement-durability-v1",
    primitive: "flush-replace-and-explicit-commit-uncertain",
    guarantees: ["hard-cut-receipts", "no-durability-overclaim", "old-or-new-recovery"],
  },
  "F-08": {
    schemaVersion: 1,
    mechanismId: "win32-authenticated-named-pipe-fence-v1",
    primitive: "first-instance-sid-dacl-capability-pipe",
    guarantees: ["authenticated-successor", "crash-release", "one-owner", "remote-refusal"],
  },
  "F-09": {
    schemaVersion: 1,
    mechanismId: "win32-suspended-job-object-containment-v1",
    primitive: "create-suspended-assign-job-resume",
    guarantees: ["assignment-before-start", "bounded-stop", "pid-creation-binding", "tree-cleanup"],
  },
  "F-10": {
    schemaVersion: 1,
    mechanismId: "win32-port-authoritative-singleton-v1",
    primitive: "authenticated-port-owner-with-private-publication",
    guarantees: ["one-database-writer", "one-port-owner", "stale-state-recovery"],
  },
});

const F01_SAME = new Set([
  "f01-8dot3-short-name-alias",
  "f01-actual-component-case-alias",
  "f01-daemon-main-identity-agreement",
  "f01-directory-junction-alias",
  "f01-drive-letter-case-alias",
  "f01-long-path-alias",
  "f01-reboot-stability",
  "f01-restart-stability",
  "f01-subst-drive-alias",
]);
const F01_DIFFERENT = new Set([
  "f01-distinct-homes",
  "f01-relocate-copy-rebind",
  "f01-rename-rebind",
]);
const F01_REFUSE = new Set([
  "f01-case-sensitive-directory",
  "f01-mapped-network-drive-refusal",
  "f01-removable-non-ntfs-refusal",
  "f01-reparse-chain-escape",
  "f01-unc-path-refusal",
]);

const F01_SCENARIOS = {
  "f01-8dot3-short-name-alias": {
    pathTopology: "8dot3-short-name-alias",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-actual-component-case-alias": {
    pathTopology: "actual-component-case-alias",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-case-sensitive-directory": {
    pathTopology: "case-sensitive-directory",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-daemon-main-identity-agreement": {
    pathTopology: "ordinary-absolute-path",
    processRole: "daemon-and-main",
    lifecycle: "same-process",
  },
  "f01-directory-junction-alias": {
    pathTopology: "directory-junction-alias",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-distinct-homes": {
    pathTopology: "distinct-homes",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-drive-letter-case-alias": {
    pathTopology: "drive-letter-case-alias",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-long-path-alias": {
    pathTopology: "long-path-alias",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-mapped-network-drive-refusal": {
    pathTopology: "mapped-network-drive",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-ordinary-absolute-path": {
    pathTopology: "ordinary-absolute-path",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-reboot-stability": {
    pathTopology: "ordinary-absolute-path",
    processRole: "main",
    lifecycle: "reboot",
  },
  "f01-relocate-copy-rebind": {
    pathTopology: "relocated-copy",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-removable-non-ntfs-refusal": {
    pathTopology: "removable-non-ntfs",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-rename-rebind": {
    pathTopology: "renamed-home",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-reparse-chain-escape": {
    pathTopology: "reparse-chain-escape",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-restart-stability": {
    pathTopology: "ordinary-absolute-path",
    processRole: "main",
    lifecycle: "restart",
  },
  "f01-spaces-unicode-path": {
    pathTopology: "spaces-unicode-path",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-subst-drive-alias": {
    pathTopology: "subst-drive-alias",
    processRole: "main",
    lifecycle: "same-process",
  },
  "f01-unc-path-refusal": {
    pathTopology: "unc-path",
    processRole: "main",
    lifecycle: "same-process",
  },
};

function f01Expectation(variantId) {
  const scenario = F01_SCENARIOS[variantId];
  if (scenario === undefined) fail("VERIFIER_INTERNAL", `unparsed F-01 variant: ${variantId}`);
  if (F01_SAME.has(variantId)) return { kind: "same-identity", ...scenario };
  if (F01_DIFFERENT.has(variantId)) return { kind: "different-identity", ...scenario };
  if (F01_REFUSE.has(variantId)) {
    return {
      kind: "refused",
      ...scenario,
      storageClass:
        variantId === "f01-mapped-network-drive-refusal" || variantId === "f01-unc-path-refusal"
          ? "network"
          : variantId === "f01-removable-non-ntfs-refusal"
            ? "removable-non-ntfs"
            : "ambiguous-local",
    };
  }
  return { kind: "accepted-local-identity", ...scenario };
}

const F02_SCENARIOS = {
  "f02-broad-authenticated-users-repair": {
    rootClass: "authenticated-users",
    actor: "current-user",
    operation: "repair",
  },
  "f02-broad-everyone-repair": {
    rootClass: "everyone",
    actor: "current-user",
    operation: "repair",
  },
  "f02-broad-users-repair": {
    rootClass: "users",
    actor: "current-user",
    operation: "repair",
  },
  "f02-create-private-directory": {
    rootClass: "fresh-private",
    actor: "current-user",
    operation: "create",
  },
  "f02-explicit-local-appdata-root": {
    rootClass: "explicit-local-appdata",
    actor: "current-user",
    operation: "create",
  },
  "f02-inherited-profile-parent": {
    rootClass: "inherited-profile",
    actor: "current-user",
    operation: "repair",
  },
  "f02-invalid-root-empty": {
    rootClass: "invalid-empty",
    actor: "current-user",
    operation: "validate-root",
  },
  "f02-invalid-root-network": {
    rootClass: "invalid-network",
    actor: "current-user",
    operation: "validate-root",
  },
  "f02-invalid-root-relative": {
    rootClass: "invalid-relative",
    actor: "current-user",
    operation: "validate-root",
  },
  "f02-invalid-root-removable": {
    rootClass: "invalid-removable",
    actor: "current-user",
    operation: "validate-root",
  },
  "f02-invalid-root-reparse-escape": {
    rootClass: "invalid-reparse-escape",
    actor: "current-user",
    operation: "validate-root",
  },
  "f02-invalid-root-roaming": {
    rootClass: "invalid-roaming",
    actor: "current-user",
    operation: "validate-root",
  },
  "f02-owner-create": { rootClass: "owned-private", actor: "current-user", operation: "create" },
  "f02-owner-delete": { rootClass: "owned-private", actor: "current-user", operation: "delete" },
  "f02-owner-ordered-aces": {
    rootClass: "owned-private",
    actor: "current-user",
    operation: "inspect",
  },
  "f02-owner-read": { rootClass: "owned-private", actor: "current-user", operation: "read" },
  "f02-owner-rename": { rootClass: "owned-private", actor: "current-user", operation: "rename" },
  "f02-second-user-read-refusal": {
    rootClass: "second-user",
    actor: "second-user",
    operation: "read",
  },
  "f02-second-user-write-refusal": {
    rootClass: "second-user",
    actor: "second-user",
    operation: "write",
  },
  "f02-unrepairable-owner-deny": {
    rootClass: "unrepairable-owner-deny",
    actor: "current-user",
    operation: "repair",
  },
};

function f02Expectation(variantId) {
  const scenario = F02_SCENARIOS[variantId];
  if (scenario === undefined) fail("VERIFIER_INTERNAL", `unparsed F-02 variant: ${variantId}`);
  if (
    variantId.includes("invalid-root-") ||
    variantId === "f02-unrepairable-owner-deny" ||
    variantId.startsWith("f02-second-user-")
  ) {
    const allowedReasonCodes = variantId.startsWith("f02-second-user-")
      ? ["ACCESS_DENIED"]
      : variantId === "f02-invalid-root-reparse-escape"
        ? ["REPARSE_POINT"]
        : variantId === "f02-unrepairable-owner-deny"
          ? ["ACCESS_DENIED", "OWNER_DENIED"]
          : ["INVALID_ROOT", "UNSUPPORTED_ROOT", "UNSUPPORTED_STORAGE"];
    return { kind: "access-refused", ...scenario, allowedReasonCodes };
  }
  return { kind: "private-dacl-proved", ...scenario };
}

function f03Expectation(variantId) {
  const accepted = variantId.endsWith("-absent") || variantId.endsWith("-existing-regular-file");
  const payload = ["port", "profile", "token", "vault"].find((name) =>
    variantId.startsWith(`f03-${name}-`),
  );
  if (payload === undefined) fail("VERIFIER_INTERNAL", `unparsed F-03 variant: ${variantId}`);
  const targetTopology = variantId.slice(`f03-${payload}-`.length);
  if (
    ![
      "absent",
      "directory",
      "existing-regular-file",
      "hard-link",
      "inspect-create-swap",
      "junction-reparse",
      "read-only-file",
      "symlink",
    ].includes(targetTopology)
  ) {
    fail("VERIFIER_INTERNAL", `unparsed F-03 topology: ${variantId}`);
  }
  return {
    kind: accepted ? "regular-file-proved" : "unexpected-object-refused",
    payloadKind: payload,
    targetTopology,
    operation: "create-private-file",
    payloadBytes: [...PROBE_CAMPAIGN_MANIFEST.parameters.f03PayloadBytes[payload]],
  };
}

function f04Expectation(variantId) {
  const parsed =
    /^f04-(ancestor-junction|concurrent-swap-loop|junction-chain|leaf-mount-point|leaf-symlink|normal-nested)-(create|delete|quarantine|read|replace)$/u.exec(
      variantId,
    );
  if (parsed === null) fail("VERIFIER_INTERNAL", `unparsed F-04 variant: ${variantId}`);
  const scenario = { pathTopology: parsed[1], operation: parsed[2] };
  if (variantId.startsWith("f04-normal-nested-")) {
    return { kind: "bounded-operation", ...scenario };
  }
  if (variantId.startsWith("f04-concurrent-swap-loop-")) {
    return {
      kind: "contained-swap-race",
      ...scenario,
      minimumDurationMs: PROBE_CAMPAIGN_MANIFEST.parameters.f04Race.durationMs,
      minimumSwapCount: PROBE_CAMPAIGN_MANIFEST.parameters.f04Race.minimumSwapCount,
      operationWorkers: PROBE_CAMPAIGN_MANIFEST.parameters.f04Race.operationWorkers,
      swapWorkers: PROBE_CAMPAIGN_MANIFEST.parameters.f04Race.swapWorkers,
    };
  }
  return { kind: "reparse-refused", ...scenario };
}

function f05Expectation(variantId) {
  const parsed =
    /^f05-(delete|quarantine|replace)-(same-object|stale-identity)-(hard-link|process-restart|same-process)$/u.exec(
      variantId,
    );
  if (parsed === null) fail("VERIFIER_INTERNAL", `unparsed F-05 variant: ${variantId}`);
  return {
    kind: parsed[2] === "stale-identity" ? "stale-refused" : "same-object-mutated",
    operation: parsed[1],
    identityClass: parsed[2],
    lifetime: parsed[3],
  };
}

const F06_CONTEXTS = ["baseline", "defender-scan", "process-crash", "rapid-readers", "reboot"];
const F06_CHECKPOINTS = [
  "after-flush",
  "after-replace",
  "before-replace",
  "before-temp-write",
  "during-replace",
  "during-write",
];

function f06Expectation(variantId) {
  const context = F06_CONTEXTS.find((value) => variantId.startsWith(`f06-${value}-`));
  const checkpoint = F06_CHECKPOINTS.find((value) => variantId.includes(`-${value}-share-`));
  const shareMode = variantId.endsWith("-share-denies-replace")
    ? "share-denies-replace"
    : "share-allows-replace";
  if (context === undefined || checkpoint === undefined) {
    fail("VERIFIER_INTERNAL", `unparsed F-06 variant: ${variantId}`);
  }
  const allowedDispositions =
    shareMode === "share-denies-replace"
      ? ["not-committed"]
      : checkpoint === "after-replace"
        ? ["committed"]
        : checkpoint === "during-replace"
          ? ["committed", "not-committed"]
          : ["not-committed"];
  return {
    kind: "atomic-replacement",
    context,
    checkpoint,
    shareMode,
    allowedDispositions,
  };
}

const F07_HARD_CUT = new Set([
  "f07-hard-cut-after-file-flush",
  "f07-hard-cut-after-namespace-replace",
  "f07-hard-cut-after-parent-volume-flush",
  "f07-hard-cut-after-temp-creation",
]);

function f07CheckpointDisposition(variantId) {
  if (variantId.endsWith("after-parent-volume-flush")) return ["durably-committed"];
  if (variantId.endsWith("after-namespace-replace")) return ["commit-uncertain"];
  return ["not-committed"];
}

function f07Expectation(variantId) {
  if (variantId === "f07-file-flush-capability") {
    return {
      kind: "capability-observed",
      capability: "file-flush",
      cutKind: "none",
      checkpoint: "file-flush-capability",
    };
  }
  if (variantId === "f07-parent-directory-handle-capability") {
    return {
      kind: "capability-observed",
      capability: "parent-directory-flush",
      cutKind: "none",
      checkpoint: "parent-directory-handle-capability",
    };
  }
  if (F07_HARD_CUT.has(variantId)) {
    return {
      kind: "hard-cut-recovery",
      cutKind: "hard-cut",
      checkpoint: variantId.slice("f07-hard-cut-after-".length),
      allowedDispositions: f07CheckpointDisposition(variantId),
      repetitions: PROBE_CAMPAIGN_MANIFEST.parameters.f07Durability.repetitionsPerHardCutCheckpoint,
    };
  }
  if (variantId.startsWith("f07-process-kill-")) {
    return {
      kind: "process-kill-recovery",
      cutKind: "process-kill",
      checkpoint: variantId.slice("f07-process-kill-after-".length),
      allowedDispositions: f07CheckpointDisposition(variantId),
    };
  }
  if (variantId === "f07-truthful-commit-uncertain") {
    return {
      kind: "truthful-uncertain",
      cutKind: "none",
      checkpoint: "truthful-commit-uncertain",
    };
  }
  if (variantId === "f07-recovery-envelope-checksum") {
    return { kind: "recovery-envelope", cutKind: "none", checkpoint: "recovery-envelope-checksum" };
  }
  if (variantId === "f07-recovery-old-or-new-complete") {
    return {
      kind: "recovery-envelope",
      cutKind: "none",
      checkpoint: "recovery-old-or-new-complete",
    };
  }
  fail("VERIFIER_INTERNAL", `unparsed F-07 variant: ${variantId}`);
}

const F08_GOLDEN_SUFFIXES = {
  "home-a": "ae2b85ba30dee3e6422838e25c209a38d3d8f45b0dcff2e3753fa72181427736",
  "home-b": "e5bd25ef024958a42053b684b05b3bd185e0642985aebcb863af6ea312678112",
};

const F08_HANDOFF_CHECKPOINTS = {
  "f08-kill-after-capability-consumption": "after-capability-consumption",
  "f08-kill-after-successor-admission": "after-successor-admission",
  "f08-kill-before-accept": "before-accept",
  "f08-kill-during-frame-read": "during-frame-read",
  "f08-n-to-n-plus-one-handoff": "n-to-n-plus-one",
};

function f08Expectation(variantId) {
  const golden = /^f08-(main|daemon)-golden-(home-[ab])$/u.exec(variantId);
  if (golden !== null) {
    return {
      kind: "golden-endpoint",
      processRole: golden[1],
      home: golden[2],
      endpointSuffix: F08_GOLDEN_SUFFIXES[golden[2]],
    };
  }
  const production = /^f08-(main|daemon)-production-name$/u.exec(variantId);
  if (production !== null) {
    return { kind: "production-endpoint", processRole: production[1] };
  }
  if (Object.hasOwn(F08_HANDOFF_CHECKPOINTS, variantId)) {
    return {
      kind: "single-successor-handoff",
      checkpoint: F08_HANDOFF_CHECKPOINTS[variantId],
    };
  }
  if (variantId === "f08-client-correct-successor") {
    return { kind: "client-decision", decision: "designated", clientKind: "correct-successor" };
  }
  if (variantId === "f08-client-ordinary-starter") {
    return { kind: "client-decision", decision: "reserved", clientKind: "ordinary-starter" };
  }
  if (variantId === "f08-client-duplicate-correct-attempt") {
    return { kind: "client-decision", decision: "reserved", clientKind: "duplicate-attempt" };
  }
  if (variantId === "f08-client-wrong-capability") {
    return { kind: "client-decision", decision: "reserved", clientKind: "wrong-capability" };
  }
  if (variantId === "f08-client-remote-pipe-refusal") {
    return { kind: "transport-refused", clientKind: "remote-client" };
  }
  if (variantId === "f08-client-second-user-refusal") {
    return { kind: "transport-refused", clientKind: "second-user" };
  }
  if (variantId === "f08-client-foreign-precreator") {
    return { kind: "transport-refused", clientKind: "foreign-precreator" };
  }
  if (variantId === "f08-distinct-home-names") return { kind: "distinct-endpoints" };
  if (variantId === "f08-injected-derivation-collision") {
    return { kind: "collision-refused" };
  }
  if (variantId === "f08-starter-race" || variantId === "f08-continuous-ownership-sampling") {
    return { kind: "one-owner-race", continuous: variantId.includes("continuous") };
  }
  if (variantId === "f08-restart-stability") return { kind: "restart-stability" };
  if (variantId === "f08-reboot-stability") return { kind: "reboot-stability" };
  if (variantId === "f08-endpoint-grammar") return { kind: "endpoint-grammar" };
  if (variantId === "f08-no-raw-identity-substring") return { kind: "identity-redaction" };
  fail("VERIFIER_INTERNAL", `unparsed F-08 variant: ${variantId}`);
}

function f09Expectation(variantId) {
  if (variantId === "f09-assignment-before-start") return { kind: "assigned-before-start" };
  if (variantId === "f09-nestable-outer-job") return { kind: "nested-job-assigned" };
  if (variantId === "f09-non-nestable-outer-job-refusal") {
    return { kind: "nested-job-refused" };
  }
  if (variantId === "f09-pid-creation-time-binding") return { kind: "pid-bound" };
  if (variantId === "f09-pid-reuse-pressure") {
    return {
      kind: "pid-pressure",
      count: PROBE_CAMPAIGN_MANIFEST.parameters.f09Lifecycle.pidPressureCount,
    };
  }
  if (variantId === "f09-os-shutdown-notification") return { kind: "os-shutdown" };
  const lifecycleKinds = {
    "f09-crash-after-ready": "daemon-crash-after-ready",
    "f09-explicit-quit": "explicit-quit",
    "f09-grandchild-cleanup": "grandchild-cleanup",
    "f09-hang-before-ready": "hang-before-ready",
    "f09-ignore-shutdown-forced-stop": "ignored-shutdown",
    "f09-main-process-crash": "main-process-crash",
    "f09-normal-ready-shutdown": "normal-ready-shutdown",
    "f09-uninstall-drain": "uninstall-drain",
    "f09-unrelated-process-safety": "unrelated-process-safety",
    "f09-update-drain": "update-drain",
  };
  const kind = lifecycleKinds[variantId];
  if (kind === undefined) fail("VERIFIER_INTERNAL", `unparsed F-09 variant: ${variantId}`);
  return { kind };
}

const F10_RACES = new Set(["f10-mixed-alias-starter-race", "f10-simultaneous-electron-launches"]);
const F10_CRASHES = new Set([
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
]);

function f10Expectation(variantId) {
  if (F10_RACES.has(variantId)) {
    return {
      kind: "singleton-race",
      raceKind:
        variantId === "f10-mixed-alias-starter-race"
          ? "mixed-alias"
          : "simultaneous-electron-launch",
      raceRounds: PROBE_CAMPAIGN_MANIFEST.parameters.f10Singleton.raceRounds,
      starterCount: PROBE_CAMPAIGN_MANIFEST.parameters.f10Singleton.starterCount,
    };
  }
  if (F10_CRASHES.has(variantId)) {
    return { kind: "crash-recovery", checkpoint: variantId.slice("f10-kill-".length) };
  }
  if (variantId === "f10-distinct-home-control") return { kind: "distinct-home-control" };
  if (variantId === "f10-healthy-compatible-peer") return { kind: "compatible-peer" };
  if (variantId === "f10-foreign-listener") {
    return { kind: "peer-refused", peerKind: "foreign" };
  }
  if (variantId === "f10-bound-unresponsive-listener") {
    return { kind: "peer-refused", peerKind: "unresponsive" };
  }
  if (variantId === "f10-older-protocol-refusal") {
    return { kind: "peer-refused", peerKind: "older-protocol" };
  }
  if (variantId === "f10-newer-protocol-refusal") {
    return { kind: "peer-refused", peerKind: "newer-protocol" };
  }
  if (variantId === "f10-stale-lock-no-listener") return { kind: "stale-lock-reclaimed" };
  if (variantId === "f10-stale-port-file") return { kind: "stale-port-reclaimed" };
  if (variantId === "f10-read-only-tooling") return { kind: "read-only" };
  if (variantId === "f10-second-user-acl-refusal") return { kind: "second-user-refused" };
  if (variantId === "f10-pid-reuse-pressure") return { kind: "pid-bound" };
  if (variantId === "f10-unmanaged-compatible-peer-guidance") return { kind: "guidance" };
  if (variantId === "f10-defender-share-deny") return { kind: "bounded-share-deny" };
  if (variantId === "f10-database-writer-sentinel") return { kind: "one-database-writer" };
  if (variantId === "f10-second-electron-activation") return { kind: "second-activation" };
  fail("VERIFIER_INTERNAL", `unparsed F-10 variant: ${variantId}`);
}

const EXPECTATION_BUILDERS = {
  "F-01": f01Expectation,
  "F-02": f02Expectation,
  "F-03": f03Expectation,
  "F-04": f04Expectation,
  "F-05": f05Expectation,
  "F-06": f06Expectation,
  "F-07": f07Expectation,
  "F-08": f08Expectation,
  "F-09": f09Expectation,
  "F-10": f10Expectation,
};

function verifierIdFor(rowId, variantId) {
  return rowId === "F-07" && F07_HARD_CUT.has(variantId)
    ? "hard-cut-probe-verifier-v1"
    : "native-probe-verifier-v1";
}

const TRANSCRIPT_DEFINITIONS = {
  "F-01": {
    transcriptKind: "windows-host-probe-native-transcript",
    transcriptCommandIds: ["home-identity"],
    factKeysByCommand: null,
  },
  "F-02": {
    transcriptKind: "windows-host-probe-native-transcript",
    transcriptCommandIds: ["private-directory-ensure", "private-directory-inspect"],
    factKeysByCommand: {
      "private-directory-ensure": [
        "rootClass",
        "actor",
        "operation",
        "operationApplied",
        "win32Error",
        "reasonCode",
      ],
      "private-directory-inspect": [
        "ownerSidSha256",
        "currentUserSidSha256",
        "inheritanceProtected",
        "broadPrincipalEffectiveMask",
        "currentUserEffectiveMask",
        "secondUserReadSucceeded",
        "secondUserWriteSucceeded",
        "securityDescriptorSha256",
      ],
    },
  },
  "F-03": {
    transcriptKind: "windows-host-probe-native-transcript",
    transcriptCommandIds: ["file-identity", "private-file-create"],
    factKeysByCommand: {
      "file-identity": [
        "targetTopology",
        "finalObjectType",
        "finalObjectIdentitySha256",
        "openedObjectIdentitySha256",
        "linkCount",
        "reparseTag",
        "outsideMutationCount",
      ],
      "private-file-create": [
        "payloadKind",
        "operation",
        "operationApplied",
        "win32Error",
        "reasonCode",
        "writtenPayloadSha256",
        "readBackPayloadSha256",
        "securityDescriptorSha256",
        "ownerOnlyDacl",
        "testedPayloadBytes",
      ],
    },
  },
  "F-04": {
    transcriptKind: "windows-host-probe-native-transcript",
    transcriptCommandIds: ["evidence-tree-seal", "secure-path-operation"],
    factKeysByCommand: {
      "evidence-tree-seal": [
        "openedRootIdentitySha256",
        "finalRootIdentitySha256",
        "beforeTreeSha256",
        "afterTreeSha256",
        "outsideMutationCount",
        "reparseTraversalCount",
        "swapCount",
      ],
      "secure-path-operation": [
        "pathTopology",
        "operation",
        "operationApplied",
        "win32Error",
        "reasonCode",
        "durationMs",
        "operationWorkerCount",
        "swapWorkerCount",
      ],
    },
  },
  "F-05": {
    transcriptKind: "windows-host-probe-native-transcript",
    transcriptCommandIds: ["file-identity", "secure-path-operation"],
    factKeysByCommand: {
      "file-identity": [
        "identityClass",
        "lifetime",
        "inspectedObjectIdentitySha256",
        "currentObjectIdentitySha256",
        "processRestartObserved",
        "hardLinkAliasObserved",
      ],
      "secure-path-operation": [
        "operation",
        "operationApplied",
        "win32Error",
        "reasonCode",
        "actedObjectIdentitySha256",
        "unrelatedMutationCount",
        "identityCheckCount",
      ],
    },
  },
  "F-06": {
    transcriptKind: "windows-host-probe-controller-transcript",
    transcriptCommandIds: ["atomic-replacement-campaign"],
    factKeysByCommand: null,
  },
  "F-07": {
    transcriptKind: "windows-host-probe-controller-transcript",
    transcriptCommandIds: ["durability-campaign"],
    factKeysByCommand: null,
  },
  "F-08": {
    transcriptKind: "windows-host-probe-controller-transcript",
    transcriptCommandIds: ["named-pipe-campaign"],
    factKeysByCommand: null,
  },
  "F-09": {
    transcriptKind: "windows-host-probe-controller-transcript",
    transcriptCommandIds: ["job-object-campaign"],
    factKeysByCommand: null,
  },
  "F-10": {
    transcriptKind: "windows-host-probe-controller-transcript",
    transcriptCommandIds: ["singleton-campaign"],
    factKeysByCommand: null,
  },
};

function definitionPayload(value) {
  const { definitionSha256: _definitionSha256, ...payload } = value;
  return payload;
}

function buildDefinitions() {
  const definitions = new Map();
  for (const row of PROBE_CAMPAIGN_MANIFEST.rows) {
    const expectationBuilder = EXPECTATION_BUILDERS[row.rowId];
    const mechanismDefinition = mechanisms[row.rowId];
    const transcriptDefinition = TRANSCRIPT_DEFINITIONS[row.rowId];
    if (
      expectationBuilder === undefined ||
      mechanismDefinition === undefined ||
      transcriptDefinition === undefined
    ) {
      fail("VERIFIER_INTERNAL", `missing row verifier for ${row.rowId}`);
    }
    const variants = [
      ...row.requiredVariantIds.map((variantId) => ({ variantId, conditionId: null })),
      ...row.conditionalVariants.map(({ variantId, conditionId }) => ({ variantId, conditionId })),
    ];
    for (const { variantId, conditionId } of variants) {
      const draft = {
        schemaVersion: 1,
        kind: "windows-host-probe-verifier-definition",
        rowId: row.rowId,
        variantId,
        verifierId: verifierIdFor(row.rowId, variantId),
        sourceArtifactPath: PROBE_VERIFIER_SOURCE_PATH,
        rawFactSchemaId: `${row.rowId.toLowerCase()}-raw-facts-v1`,
        transcriptKind: transcriptDefinition.transcriptKind,
        transcriptCommandIds: transcriptDefinition.transcriptCommandIds,
        conditionId,
        mechanismId: mechanismDefinition.mechanismId,
        mechanismDefinition,
        expectation: expectationBuilder(variantId),
      };
      const definition = deepFreeze({
        ...draft,
        definitionSha256: hashProbeCanonicalJson({
          domain: "enduragent.windows-host-probe-verifier-definition.v1",
          definition: draft,
        }),
      });
      const key = `${row.rowId}\0${variantId}`;
      if (definitions.has(key)) fail("VERIFIER_INTERNAL", `duplicate verifier definition: ${key}`);
      definitions.set(key, definition);
    }
  }
  return definitions;
}

const DEFINITIONS = buildDefinitions();

export const PROBE_VERIFIER_DEFINITIONS = deepFreeze(
  [...DEFINITIONS.values()].sort((left, right) => {
    const rowOrder = compareUtf8(left.rowId, right.rowId);
    return rowOrder === 0 ? compareUtf8(left.variantId, right.variantId) : rowOrder;
  }),
);

export function getProbeVerifierDefinition(rowId, variantId) {
  if (typeof rowId !== "string" || typeof variantId !== "string") {
    fail("VERIFIER_COORDINATE", "rowId and variantId must be strings");
  }
  const definition = DEFINITIONS.get(`${rowId}\0${variantId}`);
  if (definition === undefined) {
    fail("VERIFIER_NOT_ALLOWLISTED", `no allowlisted verifier for ${rowId}/${variantId}`);
  }
  return definition;
}

const F01_KEYS = [
  "pathTopology",
  "processRole",
  "lifecycle",
  "credentialReadAttempted",
  "canonicalIdentitySha256",
  "comparisonIdentitySha256",
  "localPathSha256",
  "volumeIdentitySha256",
  "volumeFileSystem",
  "volumeDriveType",
  "win32Error",
  "reasonCode",
];
const F02_KEYS = [
  "rootClass",
  "actor",
  "operation",
  "operationApplied",
  "win32Error",
  "reasonCode",
  "ownerSidSha256",
  "currentUserSidSha256",
  "inheritanceProtected",
  "broadPrincipalEffectiveMask",
  "currentUserEffectiveMask",
  "secondUserReadSucceeded",
  "secondUserWriteSucceeded",
  "securityDescriptorSha256",
];
const F03_KEYS = [
  "payloadKind",
  "targetTopology",
  "operation",
  "operationApplied",
  "win32Error",
  "reasonCode",
  "finalObjectType",
  "finalObjectIdentitySha256",
  "openedObjectIdentitySha256",
  "linkCount",
  "reparseTag",
  "writtenPayloadSha256",
  "readBackPayloadSha256",
  "securityDescriptorSha256",
  "ownerOnlyDacl",
  "testedPayloadBytes",
  "outsideMutationCount",
];
const F04_KEYS = [
  "pathTopology",
  "operation",
  "operationApplied",
  "win32Error",
  "reasonCode",
  "openedRootIdentitySha256",
  "finalRootIdentitySha256",
  "outsideMutationCount",
  "reparseTraversalCount",
  "swapCount",
  "durationMs",
  "operationWorkerCount",
  "swapWorkerCount",
  "beforeTreeSha256",
  "afterTreeSha256",
];
const F05_KEYS = [
  "operation",
  "identityClass",
  "lifetime",
  "operationApplied",
  "win32Error",
  "reasonCode",
  "inspectedObjectIdentitySha256",
  "currentObjectIdentitySha256",
  "actedObjectIdentitySha256",
  "unrelatedMutationCount",
  "identityCheckCount",
  "processRestartObserved",
  "hardLinkAliasObserved",
];
const F06_KEYS = [
  "context",
  "checkpoint",
  "shareMode",
  "replaceDisposition",
  "win32Error",
  "reasonCode",
  "oldRecordSha256",
  "candidateRecordSha256",
  "observedRecordSha256s",
  "partialRecordCount",
  "missingRecordCount",
  "readerSampleCount",
  "remainingOwnedTempCount",
  "retryCount",
  "elapsedMs",
  "defenderScanObserved",
  "processCrashObserved",
  "rebootObserved",
];
const F07_KEYS = [
  "cutKind",
  "checkpoint",
  "operationDisposition",
  "oldRecordSha256",
  "candidateRecordSha256",
  "recoveredRecordSha256s",
  "recoveredCompleteCount",
  "recoveredTornCount",
  "recoveredMissingCount",
  "fileFlushSupported",
  "parentDirectoryFlushSupported",
  "signedReceiptSha256s",
  "verifiedReceiptSignatureCount",
  "verifiedReceiptBindingCount",
  "repetitionCount",
  "unprovableBoundaryObserved",
  "checksumMismatchCount",
];
const F08_KEYS = [
  "primaryEndpointSha256",
  "comparisonEndpointSha256",
  "independentEndpointSha256",
  "canonicalHomeInputSha256",
  "endpointName",
  "endpointSuffix",
  "derivationDomain",
  "appId",
  "processRole",
  "endpointGrammarValid",
  "rawIdentitySubstringPresent",
  "connectionAccepted",
  "authenticated",
  "clientKind",
  "clientDecision",
  "win32Error",
  "reasonCode",
  "ownerSidSha256",
  "standardUserSidSha256",
  "firstInstanceHeld",
  "maxConcurrentOwners",
  "ownershipSampleCount",
  "raceIterations",
  "ordinaryStarterCount",
  "crashReleased",
  "admittedSuccessorCount",
  "observedFrameBytes",
  "connectElapsedMs",
  "readElapsedMs",
  "restartObserved",
  "rebootObserved",
  "handoffCheckpoint",
  "collisionInjected",
  "collisionRefused",
  "neitherWindowCount",
];
const F09_KEYS = [
  "processCreatedSuspended",
  "jobAssignedBeforeResume",
  "mainPid",
  "mainCreationTimeSha256",
  "observedCreationTimeSha256",
  "descendantCount",
  "survivingDescendantCount",
  "unrelatedProcessSurvived",
  "gracefulStopElapsedMs",
  "forcedStopElapsedMs",
  "readyObserved",
  "shutdownAcknowledged",
  "forcedTerminationUsed",
  "outerJobPresent",
  "breakawayAllowed",
  "nestedAssignmentSucceeded",
  "win32Error",
  "reasonCode",
  "pidPressureCount",
  "pidReuseMisbindCount",
  "osShutdownNotificationObserved",
  "startFrameSent",
  "mainProcessCrashObserved",
  "daemonCrashAfterReadyObserved",
  "grandchildSpawned",
  "hangBeforeReadyObserved",
  "normalReadyShutdownObserved",
  "explicitQuitObserved",
  "uninstallDrainObserved",
  "updateDrainObserved",
  "unrelatedSafetyProbeObserved",
];
const F10_KEYS = [
  "starterCount",
  "raceRounds",
  "successfulWriterCount",
  "simultaneousWriterMax",
  "databaseWriterCount",
  "portOwnerCount",
  "homeIdentitySha256",
  "comparisonHomeIdentitySha256",
  "listenerAuthenticated",
  "listenerCompatible",
  "listenerResponsive",
  "starterAdmitted",
  "win32Error",
  "reasonCode",
  "staleLockReclaimed",
  "stalePortFileReclaimed",
  "readOnlyMutationCount",
  "secondUserAccessSucceeded",
  "pidCreationMatches",
  "retryCount",
  "elapsedMs",
  "defenderShareDenyObserved",
  "crashCheckpointReached",
  "crashCheckpoint",
  "recoveryWriterCount",
  "protocolRelation",
  "unmanagedPeerGuidanceEmitted",
  "healthyPeerObserved",
  "foreignListenerObserved",
  "unresponsiveListenerObserved",
  "databaseSentinelObserved",
  "distinctHomeControlObserved",
  "staleLockIdentityProved",
  "stalePortIdentityProved",
  "readOnlyToolingObserved",
  "secondElectronActivationObserved",
  "activationRoutedToExistingInstance",
  "secondUserProbeObserved",
  "pidReusePressureObserved",
  "unmanagedPeerObserved",
  "mixedAliasRaceObserved",
  "simultaneousElectronLaunchObserved",
];

const FACT_KEYS = {
  "F-01": F01_KEYS,
  "F-02": F02_KEYS,
  "F-03": F03_KEYS,
  "F-04": F04_KEYS,
  "F-05": F05_KEYS,
  "F-06": F06_KEYS,
  "F-07": F07_KEYS,
  "F-08": F08_KEYS,
  "F-09": F09_KEYS,
  "F-10": F10_KEYS,
};

function buildTranscriptFactDefinition(definition) {
  const transcriptDefinition = TRANSCRIPT_DEFINITIONS[definition.rowId];
  const rowFactKeys = FACT_KEYS[definition.rowId];
  if (transcriptDefinition === undefined || rowFactKeys === undefined) {
    fail("VERIFIER_INTERNAL", `missing transcript fact schema for ${definition.rowId}`);
  }
  const commands = definition.transcriptCommandIds.map((commandId) => {
    const configured = transcriptDefinition.factKeysByCommand;
    if (configured === null) {
      if (definition.transcriptCommandIds.length !== 1) {
        fail(
          "VERIFIER_INTERNAL",
          `${definition.rowId} needs explicit multi-command fact ownership`,
        );
      }
      return { commandId, factKeys: [...rowFactKeys].sort(compareUtf8) };
    }
    const factKeys = configured[commandId];
    if (!Array.isArray(factKeys)) {
      fail("VERIFIER_INTERNAL", `${definition.rowId}/${commandId} has no fact ownership schema`);
    }
    return { commandId, factKeys: [...factKeys].sort(compareUtf8) };
  });
  const mappedFactKeys = commands.flatMap((command) => command.factKeys).sort(compareUtf8);
  const expectedFactKeys = [...rowFactKeys].sort(compareUtf8);
  if (transcriptDefinition.factKeysByCommand !== null) {
    const configuredCommandIds = Object.keys(transcriptDefinition.factKeysByCommand).sort(
      compareUtf8,
    );
    const expectedCommandIds = [...definition.transcriptCommandIds].sort(compareUtf8);
    if (
      configuredCommandIds.length !== expectedCommandIds.length ||
      configuredCommandIds.some((commandId, index) => commandId !== expectedCommandIds[index])
    ) {
      fail("VERIFIER_INTERNAL", `${definition.rowId} transcript command ownership drifted`);
    }
  }
  if (
    new Set(mappedFactKeys).size !== mappedFactKeys.length ||
    new Set(expectedFactKeys).size !== expectedFactKeys.length ||
    mappedFactKeys.length !== expectedFactKeys.length ||
    mappedFactKeys.some((factKey, index) => factKey !== expectedFactKeys[index])
  ) {
    fail(
      "VERIFIER_INTERNAL",
      `${definition.rowId} transcript fact ownership is incomplete or duplicated`,
    );
  }
  const draft = {
    schemaVersion: 1,
    kind: "windows-host-probe-transcript-fact-definition",
    rowId: definition.rowId,
    variantId: definition.variantId,
    definitionSha256: definition.definitionSha256,
    rawFactSchemaId: definition.rawFactSchemaId,
    transcriptKind: definition.transcriptKind,
    commands,
  };
  return deepFreeze({
    ...draft,
    mappingSha256: hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-transcript-fact-definition.v1",
      definition: draft,
    }),
  });
}

const TRANSCRIPT_FACT_DEFINITIONS = new Map(
  PROBE_VERIFIER_DEFINITIONS.map((definition) => [
    `${definition.rowId}\0${definition.variantId}`,
    buildTranscriptFactDefinition(definition),
  ]),
);

export const PROBE_TRANSCRIPT_FACT_DEFINITIONS = deepFreeze(
  [...TRANSCRIPT_FACT_DEFINITIONS.values()].sort((left, right) => {
    const rowOrder = compareUtf8(left.rowId, right.rowId);
    return rowOrder === 0 ? compareUtf8(left.variantId, right.variantId) : rowOrder;
  }),
);

export function getProbeTranscriptFactDefinition(rowId, variantId) {
  getProbeVerifierDefinition(rowId, variantId);
  const definition = TRANSCRIPT_FACT_DEFINITIONS.get(`${rowId}\0${variantId}`);
  if (definition === undefined) {
    fail("VERIFIER_INTERNAL", `missing transcript fact definition for ${rowId}/${variantId}`);
  }
  return definition;
}

function validateAvailability(value) {
  assertExactKeys(value, ["status", "reason"], "rawFacts.availability");
  if (!["available", "unavailable", "unknown"].includes(value.status)) {
    fail("VERIFIER_AVAILABILITY", "rawFacts.availability.status is invalid");
  }
  if (
    value.reason !== null &&
    (typeof value.reason !== "string" || value.reason.trim().length === 0)
  ) {
    fail("VERIFIER_AVAILABILITY", "rawFacts.availability.reason must be null or non-empty");
  }
  if (value.status === "available" && value.reason !== null) {
    fail("VERIFIER_AVAILABILITY", "an available capability cannot carry an unavailable reason");
  }
}

function validateF01Facts(value) {
  assertEnum(
    value.pathTopology,
    [
      "8dot3-short-name-alias",
      "actual-component-case-alias",
      "case-sensitive-directory",
      "directory-junction-alias",
      "distinct-homes",
      "drive-letter-case-alias",
      "long-path-alias",
      "mapped-network-drive",
      "ordinary-absolute-path",
      "relocated-copy",
      "removable-non-ntfs",
      "renamed-home",
      "reparse-chain-escape",
      "spaces-unicode-path",
      "subst-drive-alias",
      "unc-path",
    ],
    "rawFacts.facts.pathTopology",
  );
  assertEnum(value.processRole, ["daemon-and-main", "main"], "rawFacts.facts.processRole");
  assertEnum(value.lifecycle, ["reboot", "restart", "same-process"], "rawFacts.facts.lifecycle");
  assertBoolean(value.credentialReadAttempted, "rawFacts.facts.credentialReadAttempted");
  for (const key of [
    "canonicalIdentitySha256",
    "comparisonIdentitySha256",
    "localPathSha256",
    "volumeIdentitySha256",
  ]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableEnum(
    value.volumeFileSystem,
    ["NTFS", "exFAT", "FAT32", "other"],
    "rawFacts.facts.volumeFileSystem",
  );
  assertNullableEnum(
    value.volumeDriveType,
    ["fixed", "network", "removable"],
    "rawFacts.facts.volumeDriveType",
  );
  assertNullableNonnegativeInteger(value.win32Error, "rawFacts.facts.win32Error");
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF02Facts(value) {
  assertEnum(
    value.rootClass,
    [
      "authenticated-users",
      "everyone",
      "explicit-local-appdata",
      "fresh-private",
      "inherited-profile",
      "invalid-empty",
      "invalid-network",
      "invalid-relative",
      "invalid-removable",
      "invalid-reparse-escape",
      "invalid-roaming",
      "owned-private",
      "second-user",
      "unrepairable-owner-deny",
      "users",
    ],
    "rawFacts.facts.rootClass",
  );
  assertEnum(value.actor, ["current-user", "second-user"], "rawFacts.facts.actor");
  assertEnum(
    value.operation,
    ["create", "delete", "inspect", "read", "rename", "repair", "validate-root", "write"],
    "rawFacts.facts.operation",
  );
  for (const key of [
    "operationApplied",
    "inheritanceProtected",
    "secondUserReadSucceeded",
    "secondUserWriteSucceeded",
  ]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["win32Error", "broadPrincipalEffectiveMask", "currentUserEffectiveMask"]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["ownerSidSha256", "currentUserSidSha256", "securityDescriptorSha256"]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF03Facts(value) {
  assertEnum(
    value.payloadKind,
    ["port", "profile", "token", "vault"],
    "rawFacts.facts.payloadKind",
  );
  assertEnum(
    value.targetTopology,
    [
      "absent",
      "directory",
      "existing-regular-file",
      "hard-link",
      "inspect-create-swap",
      "junction-reparse",
      "read-only-file",
      "symlink",
    ],
    "rawFacts.facts.targetTopology",
  );
  assertEnum(value.operation, ["create-private-file"], "rawFacts.facts.operation");
  for (const key of ["operationApplied", "ownerOnlyDacl"]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["win32Error", "linkCount", "reparseTag", "outsideMutationCount"]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableEnum(
    value.finalObjectType,
    ["directory", "other", "regular-file", "reparse-point"],
    "rawFacts.facts.finalObjectType",
  );
  for (const key of [
    "finalObjectIdentitySha256",
    "openedObjectIdentitySha256",
    "writtenPayloadSha256",
    "readBackPayloadSha256",
    "securityDescriptorSha256",
  ]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  assertSortedUniqueIntegers(value.testedPayloadBytes, "rawFacts.facts.testedPayloadBytes");
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF04Facts(value) {
  assertEnum(
    value.pathTopology,
    [
      "ancestor-junction",
      "concurrent-swap-loop",
      "junction-chain",
      "leaf-mount-point",
      "leaf-symlink",
      "normal-nested",
    ],
    "rawFacts.facts.pathTopology",
  );
  assertEnum(
    value.operation,
    ["create", "delete", "quarantine", "read", "replace"],
    "rawFacts.facts.operation",
  );
  assertNullableBoolean(value.operationApplied, "rawFacts.facts.operationApplied");
  for (const key of [
    "win32Error",
    "outsideMutationCount",
    "reparseTraversalCount",
    "swapCount",
    "operationWorkerCount",
    "swapWorkerCount",
  ]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableNonnegativeFinite(value.durationMs, "rawFacts.facts.durationMs");
  for (const key of [
    "openedRootIdentitySha256",
    "finalRootIdentitySha256",
    "beforeTreeSha256",
    "afterTreeSha256",
  ]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF05Facts(value) {
  assertEnum(value.operation, ["delete", "quarantine", "replace"], "rawFacts.facts.operation");
  assertEnum(
    value.identityClass,
    ["same-object", "stale-identity"],
    "rawFacts.facts.identityClass",
  );
  assertEnum(
    value.lifetime,
    ["hard-link", "process-restart", "same-process"],
    "rawFacts.facts.lifetime",
  );
  for (const key of ["operationApplied", "processRestartObserved", "hardLinkAliasObserved"]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["win32Error", "unrelatedMutationCount", "identityCheckCount"]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of [
    "inspectedObjectIdentitySha256",
    "currentObjectIdentitySha256",
    "actedObjectIdentitySha256",
  ]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF06Facts(value) {
  assertEnum(
    value.context,
    ["baseline", "defender-scan", "process-crash", "rapid-readers", "reboot"],
    "rawFacts.facts.context",
  );
  assertEnum(
    value.checkpoint,
    [
      "after-flush",
      "after-replace",
      "before-replace",
      "before-temp-write",
      "during-replace",
      "during-write",
    ],
    "rawFacts.facts.checkpoint",
  );
  assertEnum(
    value.shareMode,
    ["share-allows-replace", "share-denies-replace"],
    "rawFacts.facts.shareMode",
  );
  assertNullableEnum(
    value.replaceDisposition,
    ["committed", "not-committed"],
    "rawFacts.facts.replaceDisposition",
  );
  for (const key of [
    "win32Error",
    "partialRecordCount",
    "missingRecordCount",
    "readerSampleCount",
    "remainingOwnedTempCount",
    "retryCount",
  ]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableNonnegativeFinite(value.elapsedMs, "rawFacts.facts.elapsedMs");
  for (const key of ["oldRecordSha256", "candidateRecordSha256"]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  assertSortedUniqueSha256(value.observedRecordSha256s, "rawFacts.facts.observedRecordSha256s");
  for (const key of ["defenderScanObserved", "processCrashObserved", "rebootObserved"]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF07Facts(value) {
  assertEnum(value.cutKind, ["hard-cut", "none", "process-kill"], "rawFacts.facts.cutKind");
  assertEnum(
    value.checkpoint,
    [
      "file-flush",
      "file-flush-capability",
      "namespace-replace",
      "parent-directory-handle-capability",
      "parent-volume-flush",
      "recovery-envelope-checksum",
      "recovery-old-or-new-complete",
      "temp-creation",
      "truthful-commit-uncertain",
    ],
    "rawFacts.facts.checkpoint",
  );
  assertNullableEnum(
    value.operationDisposition,
    ["commit-uncertain", "durably-committed", "not-committed"],
    "rawFacts.facts.operationDisposition",
  );
  for (const key of ["oldRecordSha256", "candidateRecordSha256"]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["recoveredRecordSha256s", "signedReceiptSha256s"]) {
    assertSortedUniqueSha256(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of [
    "recoveredCompleteCount",
    "recoveredTornCount",
    "recoveredMissingCount",
    "verifiedReceiptSignatureCount",
    "verifiedReceiptBindingCount",
    "repetitionCount",
    "checksumMismatchCount",
  ]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of [
    "fileFlushSupported",
    "parentDirectoryFlushSupported",
    "unprovableBoundaryObserved",
  ]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
}

function validateF08Facts(value) {
  for (const key of [
    "primaryEndpointSha256",
    "comparisonEndpointSha256",
    "independentEndpointSha256",
    "canonicalHomeInputSha256",
    "ownerSidSha256",
    "standardUserSidSha256",
  ]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["endpointName", "endpointSuffix", "derivationDomain", "appId"]) {
    if (value[key] !== null && (typeof value[key] !== "string" || value[key].length === 0)) {
      fail("VERIFIER_SCHEMA_STRING", `rawFacts.facts.${key} must be null or non-empty`);
    }
  }
  assertNullableEnum(
    value.processRole,
    ["controller", "daemon", "main"],
    "rawFacts.facts.processRole",
  );
  assertNullableEnum(
    value.clientKind,
    [
      "correct-successor",
      "duplicate-attempt",
      "foreign-precreator",
      "ordinary-starter",
      "remote-client",
      "second-user",
      "wrong-capability",
    ],
    "rawFacts.facts.clientKind",
  );
  assertNullableEnum(
    value.clientDecision,
    ["designated", "refused", "reserved"],
    "rawFacts.facts.clientDecision",
  );
  assertNullableEnum(
    value.handoffCheckpoint,
    [
      "after-capability-consumption",
      "after-successor-admission",
      "before-accept",
      "during-frame-read",
      "n-to-n-plus-one",
    ],
    "rawFacts.facts.handoffCheckpoint",
  );
  for (const key of [
    "endpointGrammarValid",
    "rawIdentitySubstringPresent",
    "connectionAccepted",
    "authenticated",
    "firstInstanceHeld",
    "crashReleased",
    "restartObserved",
    "rebootObserved",
    "collisionInjected",
    "collisionRefused",
  ]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of [
    "win32Error",
    "maxConcurrentOwners",
    "ownershipSampleCount",
    "raceIterations",
    "ordinaryStarterCount",
    "admittedSuccessorCount",
    "observedFrameBytes",
    "neitherWindowCount",
  ]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["connectElapsedMs", "readElapsedMs"]) {
    assertNullableNonnegativeFinite(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF09Facts(value) {
  for (const key of [
    "processCreatedSuspended",
    "jobAssignedBeforeResume",
    "unrelatedProcessSurvived",
    "readyObserved",
    "shutdownAcknowledged",
    "forcedTerminationUsed",
    "outerJobPresent",
    "breakawayAllowed",
    "nestedAssignmentSucceeded",
    "osShutdownNotificationObserved",
    "startFrameSent",
    "mainProcessCrashObserved",
    "daemonCrashAfterReadyObserved",
    "grandchildSpawned",
    "hangBeforeReadyObserved",
    "normalReadyShutdownObserved",
    "explicitQuitObserved",
    "uninstallDrainObserved",
    "updateDrainObserved",
    "unrelatedSafetyProbeObserved",
  ]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
  assertNullablePositiveInteger(value.mainPid, "rawFacts.facts.mainPid");
  for (const key of ["mainCreationTimeSha256", "observedCreationTimeSha256"]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of [
    "descendantCount",
    "survivingDescendantCount",
    "win32Error",
    "pidPressureCount",
    "pidReuseMisbindCount",
  ]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["gracefulStopElapsedMs", "forcedStopElapsedMs"]) {
    assertNullableNonnegativeFinite(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

function validateF10Facts(value) {
  for (const key of [
    "starterCount",
    "raceRounds",
    "successfulWriterCount",
    "simultaneousWriterMax",
    "databaseWriterCount",
    "portOwnerCount",
    "win32Error",
    "readOnlyMutationCount",
    "retryCount",
    "recoveryWriterCount",
  ]) {
    assertNullableNonnegativeInteger(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of ["homeIdentitySha256", "comparisonHomeIdentitySha256"]) {
    assertNullableSha256(value[key], `rawFacts.facts.${key}`);
  }
  for (const key of [
    "listenerAuthenticated",
    "listenerCompatible",
    "listenerResponsive",
    "starterAdmitted",
    "staleLockReclaimed",
    "stalePortFileReclaimed",
    "secondUserAccessSucceeded",
    "pidCreationMatches",
    "defenderShareDenyObserved",
    "crashCheckpointReached",
    "unmanagedPeerGuidanceEmitted",
    "healthyPeerObserved",
    "foreignListenerObserved",
    "unresponsiveListenerObserved",
    "databaseSentinelObserved",
    "distinctHomeControlObserved",
    "staleLockIdentityProved",
    "stalePortIdentityProved",
    "readOnlyToolingObserved",
    "secondElectronActivationObserved",
    "activationRoutedToExistingInstance",
    "secondUserProbeObserved",
    "pidReusePressureObserved",
    "unmanagedPeerObserved",
    "mixedAliasRaceObserved",
    "simultaneousElectronLaunchObserved",
  ]) {
    assertNullableBoolean(value[key], `rawFacts.facts.${key}`);
  }
  assertNullableNonnegativeFinite(value.elapsedMs, "rawFacts.facts.elapsedMs");
  assertNullableEnum(
    value.protocolRelation,
    ["compatible", "newer", "older", "unknown"],
    "rawFacts.facts.protocolRelation",
  );
  if (
    value.crashCheckpoint !== null &&
    (typeof value.crashCheckpoint !== "string" || !identifierPattern.test(value.crashCheckpoint))
  ) {
    fail(
      "VERIFIER_SCHEMA_IDENTIFIER",
      "rawFacts.facts.crashCheckpoint must be null or lowercase kebab-case",
    );
  }
  assertNullableReasonCode(value.reasonCode, "rawFacts.facts.reasonCode");
}

const FACT_VALIDATORS = {
  "F-01": validateF01Facts,
  "F-02": validateF02Facts,
  "F-03": validateF03Facts,
  "F-04": validateF04Facts,
  "F-05": validateF05Facts,
  "F-06": validateF06Facts,
  "F-07": validateF07Facts,
  "F-08": validateF08Facts,
  "F-09": validateF09Facts,
  "F-10": validateF10Facts,
};

function validateRawFacts(definition, value) {
  assertExactKeys(
    value,
    ["schemaVersion", "kind", "captureComplete", "availability", "scenario", "facts"],
    "rawFacts",
  );
  if (value.schemaVersion !== 1 || value.kind !== "windows-host-probe-raw-facts") {
    fail("VERIFIER_RAW_FACT_SCHEMA", "rawFacts schemaVersion/kind is invalid");
  }
  assertBoolean(value.captureComplete, "rawFacts.captureComplete");
  validateAvailability(value.availability);
  assertExactKeys(
    value.scenario,
    ["variantId", "definitionSha256", "evidenceSha256", "transcript"],
    "rawFacts.scenario",
  );
  if (value.scenario.variantId !== definition.variantId) {
    fail("VERIFIER_SCENARIO", "rawFacts.scenario.variantId does not match the allowlisted variant");
  }
  assertSha256(value.scenario.definitionSha256, "rawFacts.scenario.definitionSha256");
  if (value.scenario.definitionSha256 !== definition.definitionSha256) {
    fail(
      "VERIFIER_SCENARIO",
      "rawFacts.scenario.definitionSha256 does not match the allowlisted verifier definition",
    );
  }
  assertSha256(value.scenario.evidenceSha256, "rawFacts.scenario.evidenceSha256");
  const rowId = definition.rowId;
  const keys = FACT_KEYS[rowId];
  const validator = FACT_VALIDATORS[rowId];
  if (keys === undefined || validator === undefined) {
    fail("VERIFIER_INTERNAL", `missing raw-fact schema for ${rowId}`);
  }
  assertExactKeys(value.facts, keys, "rawFacts.facts");
  validator(value.facts);

  const transcript = value.scenario.transcript;
  assertExactKeys(
    transcript,
    [
      "schemaVersion",
      "kind",
      "rowId",
      "variantId",
      "verifierDefinitionSha256",
      "commandIds",
      "sourceTranscriptSha256",
      "factsSha256",
      "captureSha256",
    ],
    "rawFacts.scenario.transcript",
  );
  if (transcript.schemaVersion !== 1 || transcript.kind !== definition.transcriptKind) {
    fail(
      "VERIFIER_TRANSCRIPT",
      "rawFacts.scenario.transcript schemaVersion/kind does not match the allowlisted verifier",
    );
  }
  if (transcript.rowId !== definition.rowId || transcript.variantId !== definition.variantId) {
    fail(
      "VERIFIER_TRANSCRIPT",
      "rawFacts.scenario.transcript coordinates do not match the allowlisted verifier",
    );
  }
  assertSha256(
    transcript.verifierDefinitionSha256,
    "rawFacts.scenario.transcript.verifierDefinitionSha256",
  );
  if (transcript.verifierDefinitionSha256 !== definition.definitionSha256) {
    fail(
      "VERIFIER_TRANSCRIPT",
      "rawFacts.scenario.transcript verifier definition does not match the allowlisted verifier",
    );
  }
  assertSortedUniqueIdentifiers(transcript.commandIds, "rawFacts.scenario.transcript.commandIds");
  if (JSON.stringify(transcript.commandIds) !== JSON.stringify(definition.transcriptCommandIds)) {
    fail(
      "VERIFIER_TRANSCRIPT",
      "rawFacts.scenario.transcript commandIds do not match the allowlisted verifier",
    );
  }
  assertSha256(
    transcript.sourceTranscriptSha256,
    "rawFacts.scenario.transcript.sourceTranscriptSha256",
  );
  if (value.scenario.evidenceSha256 !== transcript.sourceTranscriptSha256) {
    fail(
      "VERIFIER_TRANSCRIPT",
      "rawFacts.scenario.evidenceSha256 does not identify the retained source transcript",
    );
  }
  assertSha256(transcript.factsSha256, "rawFacts.scenario.transcript.factsSha256");
  const expectedFactsSha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-transcript-facts.v1",
    rowId: definition.rowId,
    variantId: definition.variantId,
    facts: value.facts,
  });
  if (transcript.factsSha256 !== expectedFactsSha256) {
    fail(
      "VERIFIER_TRANSCRIPT",
      "rawFacts.scenario.transcript factsSha256 does not bind the submitted primitive facts",
    );
  }
  assertSha256(transcript.captureSha256, "rawFacts.scenario.transcript.captureSha256");
  const expectedCaptureSha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-transcript-capture.v1",
    rowId: definition.rowId,
    variantId: definition.variantId,
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    captureComplete: value.captureComplete,
    availability: value.availability,
    facts: value.facts,
  });
  if (transcript.captureSha256 !== expectedCaptureSha256) {
    fail(
      "VERIFIER_TRANSCRIPT",
      "rawFacts.scenario.transcript captureSha256 does not bind availability and completeness",
    );
  }
}

function rendered(value) {
  if (value === null) return "not observed";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function check(step, expected, actual, pass) {
  return { step, expected, actual: rendered(actual), pass };
}

function known(value) {
  return value === null ? null : true;
}

function equals(left, right) {
  if (left === null || right === null) return null;
  return left === right;
}

function differs(left, right) {
  const equal = equals(left, right);
  return equal === null ? null : !equal;
}

function isZero(value) {
  return value === null ? null : value === 0;
}

function isPositive(value) {
  return value === null ? null : value > 0;
}

function refusalPass(facts, allowedReasonCodes = []) {
  if (facts.reasonCode !== null) {
    return allowedReasonCodes.length === 0 || allowedReasonCodes.includes(facts.reasonCode);
  }
  return isPositive(facts.win32Error);
}

function refusalActual(facts) {
  return { reasonCode: facts.reasonCode, win32Error: facts.win32Error };
}

function isAtLeast(value, minimum) {
  return value === null ? null : value >= minimum;
}

function isAtMost(value, maximum) {
  return value === null ? null : value <= maximum;
}

function isFalse(value) {
  return value === null ? null : value === false;
}

function isTrue(value) {
  return value === null ? null : value === true;
}

function scenarioAxisChecks(facts, expectation, axes) {
  return axes.map((axis) =>
    check(
      `scenario-${axis.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
      expectation[axis],
      facts[axis],
      facts[axis] === expectation[axis],
    ),
  );
}

function evaluateF01(facts, expectation) {
  const scenarioChecks = [
    ...scenarioAxisChecks(facts, expectation, ["pathTopology", "processRole", "lifecycle"]),
    check(
      "credential-read-not-attempted",
      "identity probe did not attempt credential reads",
      facts.credentialReadAttempted,
      isFalse(facts.credentialReadAttempted),
    ),
  ];
  if (expectation.kind === "refused") {
    const checks = [
      ...scenarioChecks,
      check(
        "native-refusal",
        "allowlisted typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts, [
          "CASE_SENSITIVE_DIRECTORY",
          "PATH_NOT_FOUND",
          "REPARSE_POINT",
          "UNSUPPORTED_STORAGE",
          "UNSUPPORTED_VOLUME_IDENTITY",
        ]),
      ),
      check(
        "identity-not-issued",
        "no authoritative identity",
        facts.canonicalIdentitySha256,
        facts.canonicalIdentitySha256 === null,
      ),
    ];
    if (expectation.storageClass === "network") {
      checks.push(
        check(
          "network-storage-observed",
          "network drive type independently observed",
          facts.volumeDriveType,
          facts.volumeDriveType === null ? null : facts.volumeDriveType === "network",
        ),
      );
    }
    if (expectation.storageClass === "removable-non-ntfs") {
      checks.push(
        check(
          "removable-storage-observed",
          "removable drive type independently observed",
          facts.volumeDriveType,
          facts.volumeDriveType === null ? null : facts.volumeDriveType === "removable",
        ),
        check(
          "non-ntfs-observed",
          "non-NTFS filesystem independently observed",
          facts.volumeFileSystem,
          facts.volumeFileSystem === null ? null : facts.volumeFileSystem !== "NTFS",
        ),
      );
    }
    if (expectation.storageClass === "ambiguous-local") {
      checks.push(
        check(
          "fixed-volume-observed",
          "fixed local drive type independently observed",
          facts.volumeDriveType,
          facts.volumeDriveType === null ? null : facts.volumeDriveType === "fixed",
        ),
        check(
          "ntfs-observed",
          "NTFS filesystem independently observed",
          facts.volumeFileSystem,
          facts.volumeFileSystem === null ? null : facts.volumeFileSystem === "NTFS",
        ),
        check(
          "volume-identity-bound",
          "local volume identity digest retained",
          facts.volumeIdentitySha256,
          known(facts.volumeIdentitySha256),
        ),
      );
    }
    return checks;
  }
  const relation =
    expectation.kind === "same-identity"
      ? equals(facts.canonicalIdentitySha256, facts.comparisonIdentitySha256)
      : expectation.kind === "different-identity"
        ? differs(facts.canonicalIdentitySha256, facts.comparisonIdentitySha256)
        : known(facts.canonicalIdentitySha256);
  const checks = [
    ...scenarioChecks,
    check(
      "identity-relation",
      expectation.kind,
      [facts.canonicalIdentitySha256, facts.comparisonIdentitySha256],
      relation,
    ),
    check(
      "local-path-bound",
      "local resolved path digest",
      facts.localPathSha256,
      known(facts.localPathSha256),
    ),
    check(
      "fixed-volume",
      "fixed local volume",
      facts.volumeDriveType,
      facts.volumeDriveType === null ? null : facts.volumeDriveType === "fixed",
    ),
    check(
      "ntfs-volume",
      "NTFS filesystem",
      facts.volumeFileSystem,
      facts.volumeFileSystem === null ? null : facts.volumeFileSystem === "NTFS",
    ),
    check(
      "volume-identity-bound",
      "local volume identity digest retained",
      facts.volumeIdentitySha256,
      known(facts.volumeIdentitySha256),
    ),
    check("no-win32-error", "no Win32 error", facts.win32Error, facts.win32Error === null),
  ];
  return checks;
}

function evaluateF02(facts, expectation) {
  const scenarioChecks = scenarioAxisChecks(facts, expectation, [
    "rootClass",
    "actor",
    "operation",
  ]);
  if (expectation.kind === "access-refused") {
    const checks = [
      ...scenarioChecks,
      check(
        "operation-refused",
        "operation not applied",
        facts.operationApplied,
        isFalse(facts.operationApplied),
      ),
      check(
        "native-refusal",
        "typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts, expectation.allowedReasonCodes),
      ),
    ];
    if (expectation.actor === "second-user") {
      const accessSucceeded =
        expectation.operation === "read"
          ? facts.secondUserReadSucceeded
          : facts.secondUserWriteSucceeded;
      checks.push(
        check(
          "second-user-access-refused",
          `second-user ${expectation.operation} denied`,
          accessSucceeded,
          isFalse(accessSucceeded),
        ),
      );
    }
    return checks;
  }
  return [
    ...scenarioChecks,
    check(
      "operation-applied",
      "DACL create or repair applied",
      facts.operationApplied,
      isTrue(facts.operationApplied),
    ),
    check(
      "owner-bound",
      "owner SID equals current user SID",
      [facts.ownerSidSha256, facts.currentUserSidSha256],
      equals(facts.ownerSidSha256, facts.currentUserSidSha256),
    ),
    check(
      "inheritance-protected",
      "DACL inheritance protected",
      facts.inheritanceProtected,
      isTrue(facts.inheritanceProtected),
    ),
    check(
      "broad-mask-empty",
      "no broad-principal effective access",
      facts.broadPrincipalEffectiveMask,
      isZero(facts.broadPrincipalEffectiveMask),
    ),
    check(
      "owner-mask-present",
      "current user has effective access",
      facts.currentUserEffectiveMask,
      isPositive(facts.currentUserEffectiveMask),
    ),
    check(
      "second-user-read-refused",
      "second-user read denied",
      facts.secondUserReadSucceeded,
      isFalse(facts.secondUserReadSucceeded),
    ),
    check(
      "second-user-write-refused",
      "second-user write denied",
      facts.secondUserWriteSucceeded,
      isFalse(facts.secondUserWriteSucceeded),
    ),
    check(
      "descriptor-retained",
      "security descriptor digest retained",
      facts.securityDescriptorSha256,
      known(facts.securityDescriptorSha256),
    ),
  ];
}

function evaluateF03(facts, expectation) {
  const common = [
    ...scenarioAxisChecks(facts, expectation, ["payloadKind", "targetTopology", "operation"]),
    check(
      "bounded-root",
      "no outside-root mutation",
      facts.outsideMutationCount,
      isZero(facts.outsideMutationCount),
    ),
    check(
      "payload-sizes",
      `exact payload sizes ${expectation.payloadBytes.join(",")}`,
      facts.testedPayloadBytes,
      JSON.stringify(facts.testedPayloadBytes) === JSON.stringify(expectation.payloadBytes),
    ),
  ];
  if (expectation.kind === "unexpected-object-refused") {
    return [
      ...common,
      check(
        "operation-refused",
        "unexpected object not replaced",
        facts.operationApplied,
        isFalse(facts.operationApplied),
      ),
      check(
        "native-refusal",
        "allowlisted typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts, [
          "ACCESS_DENIED",
          "IDENTITY_MISMATCH",
          "PATH_NOT_FOUND",
          "READ_ONLY",
          "REPARSE_POINT",
          "TARGET_EXISTS",
          "UNEXPECTED_OBJECT",
        ]),
      ),
    ];
  }
  return [
    ...common,
    check(
      "operation-applied",
      "private file created or opened",
      facts.operationApplied,
      isTrue(facts.operationApplied),
    ),
    check(
      "regular-file",
      "final object is a regular file",
      facts.finalObjectType,
      facts.finalObjectType === null ? null : facts.finalObjectType === "regular-file",
    ),
    check(
      "same-opened-object",
      "opened and final object identities match",
      [facts.openedObjectIdentitySha256, facts.finalObjectIdentitySha256],
      equals(facts.openedObjectIdentitySha256, facts.finalObjectIdentitySha256),
    ),
    check(
      "single-link",
      "link count equals one",
      facts.linkCount,
      facts.linkCount === null ? null : facts.linkCount === 1,
    ),
    check("not-reparse", "reparse tag equals zero", facts.reparseTag, isZero(facts.reparseTag)),
    check(
      "payload-round-trip",
      "written and read-back payload digests match",
      [facts.writtenPayloadSha256, facts.readBackPayloadSha256],
      equals(facts.writtenPayloadSha256, facts.readBackPayloadSha256),
    ),
    check(
      "private-dacl",
      "owner-only DACL independently observed",
      facts.ownerOnlyDacl,
      isTrue(facts.ownerOnlyDacl),
    ),
    check(
      "descriptor-retained",
      "security descriptor digest retained",
      facts.securityDescriptorSha256,
      known(facts.securityDescriptorSha256),
    ),
  ];
}

function evaluateF04(facts, expectation) {
  const common = [
    ...scenarioAxisChecks(facts, expectation, ["pathTopology", "operation"]),
    check(
      "root-identity",
      "opened and final root identities match",
      [facts.openedRootIdentitySha256, facts.finalRootIdentitySha256],
      equals(facts.openedRootIdentitySha256, facts.finalRootIdentitySha256),
    ),
    check(
      "outside-root",
      "no outside-root mutation",
      facts.outsideMutationCount,
      isZero(facts.outsideMutationCount),
    ),
    check(
      "reparse-traversal",
      "no reparse traversal",
      facts.reparseTraversalCount,
      isZero(facts.reparseTraversalCount),
    ),
    check(
      "before-seal",
      "before evidence-tree seal retained",
      facts.beforeTreeSha256,
      known(facts.beforeTreeSha256),
    ),
    check(
      "after-seal",
      "after evidence-tree seal retained",
      facts.afterTreeSha256,
      known(facts.afterTreeSha256),
    ),
  ];
  if (expectation.kind === "bounded-operation") {
    return [
      ...common,
      check(
        "operation-applied",
        "normal nested operation applied",
        facts.operationApplied,
        isTrue(facts.operationApplied),
      ),
    ];
  }
  if (expectation.kind === "reparse-refused") {
    return [
      ...common,
      check(
        "operation-refused",
        "reparse topology refused",
        facts.operationApplied,
        isFalse(facts.operationApplied),
      ),
      check(
        "native-refusal",
        "allowlisted typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts, ["IDENTITY_MISMATCH", "PATH_NOT_FOUND", "REPARSE_POINT"]),
      ),
    ];
  }
  return [
    ...common,
    check(
      "race-duration",
      `at least ${expectation.minimumDurationMs} ms`,
      facts.durationMs,
      isAtLeast(facts.durationMs, expectation.minimumDurationMs),
    ),
    check(
      "swap-count",
      `at least ${expectation.minimumSwapCount} swaps`,
      facts.swapCount,
      isAtLeast(facts.swapCount, expectation.minimumSwapCount),
    ),
    check(
      "operation-workers",
      `${expectation.operationWorkers} operation workers`,
      facts.operationWorkerCount,
      facts.operationWorkerCount === null
        ? null
        : facts.operationWorkerCount === expectation.operationWorkers,
    ),
    check(
      "swap-workers",
      `${expectation.swapWorkers} swap workers`,
      facts.swapWorkerCount,
      facts.swapWorkerCount === null ? null : facts.swapWorkerCount === expectation.swapWorkers,
    ),
  ];
}

function evaluateF05(facts, expectation) {
  const lifetimeChecks = [
    ...scenarioAxisChecks(facts, expectation, ["operation", "identityClass", "lifetime"]),
    check(
      "identity-rechecked",
      "at least one handle-bound identity recheck",
      facts.identityCheckCount,
      isAtLeast(facts.identityCheckCount, 1),
    ),
    check(
      "unrelated-object-safe",
      "no unrelated object mutation",
      facts.unrelatedMutationCount,
      isZero(facts.unrelatedMutationCount),
    ),
    check(
      "restart-lifetime",
      expectation.lifetime === "process-restart"
        ? "process restart observed"
        : "no required process restart",
      facts.processRestartObserved,
      expectation.lifetime === "process-restart"
        ? isTrue(facts.processRestartObserved)
        : known(facts.processRestartObserved),
    ),
    check(
      "hard-link-lifetime",
      expectation.lifetime === "hard-link"
        ? "hard-link alias observed"
        : "no required hard-link alias",
      facts.hardLinkAliasObserved,
      expectation.lifetime === "hard-link"
        ? isTrue(facts.hardLinkAliasObserved)
        : known(facts.hardLinkAliasObserved),
    ),
  ];
  if (expectation.kind === "stale-refused") {
    return [
      ...lifetimeChecks,
      check(
        "stale-identity",
        "inspected and current identities differ",
        [facts.inspectedObjectIdentitySha256, facts.currentObjectIdentitySha256],
        differs(facts.inspectedObjectIdentitySha256, facts.currentObjectIdentitySha256),
      ),
      check(
        "operation-refused",
        "stale object not mutated",
        facts.operationApplied,
        isFalse(facts.operationApplied),
      ),
      check(
        "acted-object-empty",
        "no acted object identity",
        facts.actedObjectIdentitySha256,
        facts.actedObjectIdentitySha256 === null,
      ),
      check(
        "native-refusal",
        "IDENTITY_MISMATCH or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts, ["IDENTITY_MISMATCH"]),
      ),
    ];
  }
  return [
    ...lifetimeChecks,
    check(
      "same-current-object",
      "inspected and current identities match",
      [facts.inspectedObjectIdentitySha256, facts.currentObjectIdentitySha256],
      equals(facts.inspectedObjectIdentitySha256, facts.currentObjectIdentitySha256),
    ),
    check(
      "same-acted-object",
      "inspected and acted identities match",
      [facts.inspectedObjectIdentitySha256, facts.actedObjectIdentitySha256],
      equals(facts.inspectedObjectIdentitySha256, facts.actedObjectIdentitySha256),
    ),
    check(
      "operation-applied",
      "operation applied to inspected object",
      facts.operationApplied,
      isTrue(facts.operationApplied),
    ),
  ];
}

function observedRecordsAreComplete(facts) {
  if (facts.oldRecordSha256 === null || facts.candidateRecordSha256 === null) return null;
  if (facts.observedRecordSha256s.length === 0) return null;
  const allowed = new Set([facts.oldRecordSha256, facts.candidateRecordSha256]);
  return facts.observedRecordSha256s.every((digest) => allowed.has(digest));
}

function evaluateF06(facts, expectation) {
  const dispositionKnown = facts.replaceDisposition === null ? null : true;
  const dispositionAllowed =
    dispositionKnown === null
      ? null
      : expectation.allowedDispositions.includes(facts.replaceDisposition);
  const terminalDigest =
    facts.replaceDisposition === "committed" ? facts.candidateRecordSha256 : facts.oldRecordSha256;
  const terminalObserved =
    terminalDigest === null || facts.observedRecordSha256s.length === 0
      ? null
      : facts.observedRecordSha256s.includes(terminalDigest);
  const contextCheck =
    expectation.context === "defender-scan"
      ? isTrue(facts.defenderScanObserved)
      : expectation.context === "process-crash"
        ? isTrue(facts.processCrashObserved)
        : expectation.context === "reboot"
          ? isTrue(facts.rebootObserved)
          : expectation.context === "rapid-readers"
            ? isAtLeast(
                facts.readerSampleCount,
                PROBE_CAMPAIGN_MANIFEST.parameters.f06Replacement.rapidReaderCount,
              )
            : known(facts.readerSampleCount);
  const checks = [
    ...scenarioAxisChecks(facts, expectation, ["context", "checkpoint", "shareMode"]),
    check(
      "replace-disposition",
      `one of ${expectation.allowedDispositions.join(",")}`,
      facts.replaceDisposition,
      dispositionAllowed,
    ),
    check(
      "terminal-record-observed",
      "disposition's complete terminal record observed",
      terminalDigest,
      terminalObserved,
    ),
    check(
      "complete-records-only",
      "all observations equal the complete old or candidate record",
      facts.observedRecordSha256s,
      observedRecordsAreComplete(facts),
    ),
    check(
      "no-partial-record",
      "zero partial observations",
      facts.partialRecordCount,
      isZero(facts.partialRecordCount),
    ),
    check(
      "no-missing-record",
      "zero absent observations",
      facts.missingRecordCount,
      isZero(facts.missingRecordCount),
    ),
    check(
      "owned-temp-cleanup",
      "zero owned temp artifacts remain",
      facts.remainingOwnedTempCount,
      isZero(facts.remainingOwnedTempCount),
    ),
    check(
      "retry-budget",
      `at most ${PROBE_CAMPAIGN_MANIFEST.parameters.f06Replacement.maxRetries} retries`,
      facts.retryCount,
      isAtMost(facts.retryCount, PROBE_CAMPAIGN_MANIFEST.parameters.f06Replacement.maxRetries),
    ),
    check(
      "retry-deadline",
      `at most ${PROBE_CAMPAIGN_MANIFEST.parameters.f06Replacement.retryDeadlineMs} ms`,
      facts.elapsedMs,
      isAtMost(facts.elapsedMs, PROBE_CAMPAIGN_MANIFEST.parameters.f06Replacement.retryDeadlineMs),
    ),
    check(
      "context-observed",
      `${expectation.context} context independently observed`,
      expectation.context,
      contextCheck,
    ),
  ];
  if (expectation.shareMode === "share-denies-replace") {
    checks.push(
      check(
        "sharing-refusal",
        "SHARING_VIOLATION or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts, ["SHARING_VIOLATION"]),
      ),
    );
  }
  return checks;
}

function recoveredRecordsAreComplete(facts) {
  if (facts.oldRecordSha256 === null || facts.candidateRecordSha256 === null) return null;
  if (facts.recoveredRecordSha256s.length === 0) return null;
  const allowed = new Set([facts.oldRecordSha256, facts.candidateRecordSha256]);
  return facts.recoveredRecordSha256s.every((digest) => allowed.has(digest));
}

function evaluateF07(facts, expectation) {
  const scenarioChecks = scenarioAxisChecks(facts, expectation, ["cutKind", "checkpoint"]);
  if (expectation.kind === "capability-observed") {
    const observed =
      expectation.capability === "file-flush"
        ? facts.fileFlushSupported
        : facts.parentDirectoryFlushSupported;
    return [
      ...scenarioChecks,
      check(
        "capability-measured",
        `${expectation.capability} support measured true or false`,
        observed,
        known(observed),
      ),
    ];
  }
  const recoveryChecks = [
    ...scenarioChecks,
    check(
      "complete-recovery",
      "at least one complete recovery",
      facts.recoveredCompleteCount,
      isAtLeast(facts.recoveredCompleteCount, 1),
    ),
    check(
      "no-torn-recovery",
      "zero torn records",
      facts.recoveredTornCount,
      isZero(facts.recoveredTornCount),
    ),
    check(
      "no-missing-recovery",
      "zero missing records",
      facts.recoveredMissingCount,
      isZero(facts.recoveredMissingCount),
    ),
    check(
      "checksum-valid",
      "zero checksum mismatches",
      facts.checksumMismatchCount,
      isZero(facts.checksumMismatchCount),
    ),
    check(
      "old-or-new-only",
      "all recovered records are complete old or candidate values",
      facts.recoveredRecordSha256s,
      recoveredRecordsAreComplete(facts),
    ),
  ];
  if (expectation.kind === "hard-cut-recovery") {
    const receiptSetComplete =
      facts.signedReceiptSha256s.length < expectation.repetitions
        ? null
        : facts.signedReceiptSha256s.length === expectation.repetitions;
    return [
      ...recoveryChecks,
      check(
        "hard-cut-repetitions",
        `${expectation.repetitions} independent hard cuts`,
        facts.repetitionCount,
        facts.repetitionCount === null ? null : facts.repetitionCount === expectation.repetitions,
      ),
      check(
        "signed-receipts",
        `${expectation.repetitions} distinct signed receipts`,
        facts.signedReceiptSha256s,
        receiptSetComplete,
      ),
      check(
        "receipt-signatures",
        "every retained receipt signature verified",
        facts.verifiedReceiptSignatureCount,
        facts.verifiedReceiptSignatureCount === null || receiptSetComplete === null
          ? null
          : facts.verifiedReceiptSignatureCount === expectation.repetitions,
      ),
      check(
        "receipt-bindings",
        "every retained receipt request binding verified",
        facts.verifiedReceiptBindingCount,
        facts.verifiedReceiptBindingCount === null || receiptSetComplete === null
          ? null
          : facts.verifiedReceiptBindingCount === expectation.repetitions,
      ),
      check(
        "truthful-disposition",
        `one of ${expectation.allowedDispositions.join(",")}`,
        facts.operationDisposition,
        facts.operationDisposition === null
          ? null
          : expectation.allowedDispositions.includes(facts.operationDisposition),
      ),
    ];
  }
  if (expectation.kind === "process-kill-recovery") {
    return [
      ...recoveryChecks,
      check(
        "truthful-disposition",
        `one of ${expectation.allowedDispositions.join(",")}`,
        facts.operationDisposition,
        facts.operationDisposition === null
          ? null
          : expectation.allowedDispositions.includes(facts.operationDisposition),
      ),
    ];
  }
  if (expectation.kind === "truthful-uncertain") {
    return [
      ...recoveryChecks,
      check(
        "uncertain-boundary",
        "an unprovable boundary was observed",
        facts.unprovableBoundaryObserved,
        isTrue(facts.unprovableBoundaryObserved),
      ),
      check(
        "uncertain-label",
        "operation returned commit-uncertain",
        facts.operationDisposition,
        facts.operationDisposition === null
          ? null
          : facts.operationDisposition === "commit-uncertain",
      ),
    ];
  }
  return recoveryChecks;
}

function endpointBasics(facts) {
  const expectedPrefix = "\\\\.\\pipe\\Enduragent-upgrade-v1-";
  const endpointNameValid =
    facts.endpointName === null || facts.endpointSuffix === null
      ? null
      : facts.endpointName === `${expectedPrefix}${facts.endpointSuffix}` &&
        /^[a-f0-9]{64}$/u.test(facts.endpointSuffix);
  const endpointNameSha256 =
    facts.endpointName === null
      ? null
      : createHash("sha256").update(facts.endpointName, "utf8").digest("hex");
  return [
    check(
      "endpoint-derived",
      "independent and primary endpoint digests match",
      [facts.primaryEndpointSha256, facts.independentEndpointSha256],
      equals(facts.primaryEndpointSha256, facts.independentEndpointSha256),
    ),
    check(
      "derivation-domain",
      "enduragent.windows-upgrade-fence.v1",
      facts.derivationDomain,
      facts.derivationDomain === null
        ? null
        : facts.derivationDomain === "enduragent.windows-upgrade-fence.v1",
    ),
    check(
      "derivation-app-id",
      "icu.enduragent.desktop",
      facts.appId,
      facts.appId === null ? null : facts.appId === "icu.enduragent.desktop",
    ),
    check(
      "derivation-home-input",
      "canonical home input digest retained",
      facts.canonicalHomeInputSha256,
      known(facts.canonicalHomeInputSha256),
    ),
    check(
      "endpoint-name-hash",
      "retained endpoint name hashes to primary endpoint digest",
      endpointNameSha256,
      equals(endpointNameSha256, facts.primaryEndpointSha256),
    ),
    check(
      "endpoint-name-shape",
      "exact pipe prefix plus 64 lowercase hexadecimal suffix",
      facts.endpointName,
      endpointNameValid,
    ),
    check(
      "endpoint-grammar",
      "endpoint grammar accepted",
      facts.endpointGrammarValid,
      isTrue(facts.endpointGrammarValid),
    ),
    check(
      "identity-redacted",
      "no raw home identity substring",
      facts.rawIdentitySubstringPresent,
      isFalse(facts.rawIdentitySubstringPresent),
    ),
    check(
      "owner-sid",
      "pipe owner SID equals standard user SID",
      [facts.ownerSidSha256, facts.standardUserSidSha256],
      equals(facts.ownerSidSha256, facts.standardUserSidSha256),
    ),
    check(
      "first-instance",
      "first-instance ownership held",
      facts.firstInstanceHeld,
      isTrue(facts.firstInstanceHeld),
    ),
  ];
}

function evaluateF08(facts, expectation) {
  const basics = endpointBasics(facts);
  if (expectation.kind === "golden-endpoint") {
    return [
      ...basics,
      check(
        "golden-process-role",
        expectation.processRole,
        facts.processRole,
        facts.processRole === null ? null : facts.processRole === expectation.processRole,
      ),
      check(
        "golden-endpoint-suffix",
        expectation.endpointSuffix,
        facts.endpointSuffix,
        facts.endpointSuffix === null ? null : facts.endpointSuffix === expectation.endpointSuffix,
      ),
    ];
  }
  if (expectation.kind === "production-endpoint") {
    return [
      ...basics,
      check(
        "production-process-role",
        expectation.processRole,
        facts.processRole,
        facts.processRole === null ? null : facts.processRole === expectation.processRole,
      ),
    ];
  }
  if (expectation.kind === "transport-refused") {
    return [
      ...basics,
      check(
        "client-kind",
        expectation.clientKind,
        facts.clientKind,
        facts.clientKind === null ? null : facts.clientKind === expectation.clientKind,
      ),
      check(
        "client-refused",
        "connection not accepted",
        facts.connectionAccepted,
        isFalse(facts.connectionAccepted),
      ),
      check(
        "refusal-decision",
        "refused",
        facts.clientDecision,
        facts.clientDecision === null ? null : facts.clientDecision === "refused",
      ),
      check(
        "native-refusal",
        "typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts),
      ),
    ];
  }
  if (expectation.kind === "client-decision") {
    return [
      ...basics,
      check(
        "client-kind",
        expectation.clientKind,
        facts.clientKind,
        facts.clientKind === null ? null : facts.clientKind === expectation.clientKind,
      ),
      check(
        "client-accepted",
        "connection accepted",
        facts.connectionAccepted,
        isTrue(facts.connectionAccepted),
      ),
      check(
        "client-decision",
        expectation.decision,
        facts.clientDecision,
        facts.clientDecision === null ? null : facts.clientDecision === expectation.decision,
      ),
      check(
        "successor-authentication",
        expectation.decision === "designated"
          ? "correct successor capability authenticated"
          : "non-successor was not authenticated for designation",
        facts.authenticated,
        expectation.decision === "designated"
          ? isTrue(facts.authenticated)
          : isFalse(facts.authenticated),
      ),
      check(
        "frame-bound",
        `frame no larger than ${PROBE_CAMPAIGN_MANIFEST.parameters.f08UpgradeFence.maxFrameBytes} bytes`,
        facts.observedFrameBytes,
        isAtMost(
          facts.observedFrameBytes,
          PROBE_CAMPAIGN_MANIFEST.parameters.f08UpgradeFence.maxFrameBytes,
        ),
      ),
    ];
  }
  if (expectation.kind === "distinct-endpoints") {
    return [
      ...basics,
      check(
        "distinct-endpoints",
        "distinct inputs derive distinct endpoints",
        [facts.primaryEndpointSha256, facts.comparisonEndpointSha256],
        differs(facts.primaryEndpointSha256, facts.comparisonEndpointSha256),
      ),
    ];
  }
  if (expectation.kind === "collision-refused") {
    return [
      ...basics,
      check(
        "collision-injected",
        "derivation collision deliberately injected",
        facts.collisionInjected,
        isTrue(facts.collisionInjected),
      ),
      check(
        "collision-refused",
        "colliding identity refused before ownership",
        facts.collisionRefused,
        isTrue(facts.collisionRefused),
      ),
      check(
        "collision-decision",
        "refused",
        facts.clientDecision,
        facts.clientDecision === null ? null : facts.clientDecision === "refused",
      ),
    ];
  }
  if (expectation.kind === "one-owner-race") {
    return [
      ...basics,
      check(
        "single-owner",
        "at most one concurrent owner",
        facts.maxConcurrentOwners,
        facts.maxConcurrentOwners === null ? null : facts.maxConcurrentOwners === 1,
      ),
      check(
        "ownership-sampled",
        "at least one ownership sample",
        facts.ownershipSampleCount,
        isAtLeast(facts.ownershipSampleCount, 1),
      ),
      check(
        "race-count",
        `at least ${PROBE_CAMPAIGN_MANIFEST.parameters.f08UpgradeFence.raceIterations} race iterations`,
        facts.raceIterations,
        isAtLeast(
          facts.raceIterations,
          PROBE_CAMPAIGN_MANIFEST.parameters.f08UpgradeFence.raceIterations,
        ),
      ),
      check(
        "starter-count",
        `at least ${PROBE_CAMPAIGN_MANIFEST.parameters.f08UpgradeFence.ordinaryStarterCount} ordinary starters`,
        facts.ordinaryStarterCount,
        isAtLeast(
          facts.ordinaryStarterCount,
          PROBE_CAMPAIGN_MANIFEST.parameters.f08UpgradeFence.ordinaryStarterCount,
        ),
      ),
      check(
        "no-neither-window",
        "zero ownership samples with neither owner",
        facts.neitherWindowCount,
        isZero(facts.neitherWindowCount),
      ),
    ];
  }
  if (expectation.kind === "single-successor-handoff") {
    return [
      ...basics,
      check(
        "crash-release",
        "prior owner crash released the fence",
        facts.crashReleased,
        isTrue(facts.crashReleased),
      ),
      check(
        "handoff-checkpoint",
        expectation.checkpoint,
        facts.handoffCheckpoint,
        facts.handoffCheckpoint === null
          ? null
          : facts.handoffCheckpoint === expectation.checkpoint,
      ),
      check(
        "single-successor",
        "exactly one successor admitted",
        facts.admittedSuccessorCount,
        facts.admittedSuccessorCount === null ? null : facts.admittedSuccessorCount === 1,
      ),
      check(
        "single-owner",
        "at most one concurrent owner",
        facts.maxConcurrentOwners,
        facts.maxConcurrentOwners === null ? null : facts.maxConcurrentOwners === 1,
      ),
      check(
        "no-neither-window",
        "zero ownership samples with neither owner",
        facts.neitherWindowCount,
        isZero(facts.neitherWindowCount),
      ),
    ];
  }
  if (expectation.kind === "restart-stability") {
    return [
      ...basics,
      check(
        "restart-observed",
        "process restart independently observed",
        facts.restartObserved,
        isTrue(facts.restartObserved),
      ),
    ];
  }
  if (expectation.kind === "reboot-stability") {
    return [
      ...basics,
      check(
        "reboot-observed",
        "OS reboot independently observed",
        facts.rebootObserved,
        isTrue(facts.rebootObserved),
      ),
    ];
  }
  if (expectation.kind === "endpoint-grammar") {
    return basics.filter((entry) =>
      ["endpoint-grammar", "endpoint-name-hash", "endpoint-name-shape"].includes(entry.step),
    );
  }
  if (expectation.kind === "identity-redaction") {
    return basics.filter((entry) =>
      ["derivation-home-input", "identity-redacted"].includes(entry.step),
    );
  }
  fail("VERIFIER_INTERNAL", `missing F-08 evaluator for ${expectation.kind}`);
}

function treeStopChecks(facts, forced) {
  const parameters = PROBE_CAMPAIGN_MANIFEST.parameters.f09Lifecycle;
  const elapsed = forced ? facts.forcedStopElapsedMs : facts.gracefulStopElapsedMs;
  const deadline = forced ? parameters.forcedTimeoutMs : parameters.gracefulTimeoutMs;
  return [
    check(
      "tree-terminated",
      "zero surviving descendants",
      facts.survivingDescendantCount,
      isZero(facts.survivingDescendantCount),
    ),
    check(
      "unrelated-safe",
      "unrelated process survived",
      facts.unrelatedProcessSurvived,
      isTrue(facts.unrelatedProcessSurvived),
    ),
    check(
      "stop-deadline",
      `stop completed within ${deadline} ms`,
      elapsed,
      isAtMost(elapsed, deadline),
    ),
    check(
      "forced-mode",
      forced ? "forced termination used" : "graceful path measured",
      facts.forcedTerminationUsed,
      forced ? isTrue(facts.forcedTerminationUsed) : known(facts.forcedTerminationUsed),
    ),
  ];
}

function evaluateF09(facts, expectation) {
  if (expectation.kind === "assigned-before-start") {
    return [
      check(
        "created-suspended",
        "process created suspended",
        facts.processCreatedSuspended,
        isTrue(facts.processCreatedSuspended),
      ),
      check(
        "assigned-before-resume",
        "job assigned before resume",
        facts.jobAssignedBeforeResume,
        isTrue(facts.jobAssignedBeforeResume),
      ),
      check(
        "start-frame-withheld",
        "start frame not sent before assignment",
        facts.startFrameSent,
        isFalse(facts.startFrameSent),
      ),
      check("pid-recorded", "positive main PID retained", facts.mainPid, known(facts.mainPid)),
    ];
  }
  if (expectation.kind === "nested-job-assigned") {
    return [
      check(
        "outer-job",
        "outer job observed",
        facts.outerJobPresent,
        isTrue(facts.outerJobPresent),
      ),
      check(
        "breakaway",
        "breakaway capability observed",
        facts.breakawayAllowed,
        isTrue(facts.breakawayAllowed),
      ),
      check(
        "nested-assignment",
        "inner job assignment succeeded",
        facts.nestedAssignmentSucceeded,
        isTrue(facts.nestedAssignmentSucceeded),
      ),
    ];
  }
  if (expectation.kind === "nested-job-refused") {
    return [
      check(
        "outer-job",
        "outer job observed",
        facts.outerJobPresent,
        isTrue(facts.outerJobPresent),
      ),
      check(
        "no-breakaway",
        "breakaway unavailable",
        facts.breakawayAllowed,
        isFalse(facts.breakawayAllowed),
      ),
      check(
        "nested-refusal",
        "inner job assignment refused",
        facts.nestedAssignmentSucceeded,
        isFalse(facts.nestedAssignmentSucceeded),
      ),
      check(
        "native-refusal",
        "typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts),
      ),
    ];
  }
  if (expectation.kind === "pid-bound") {
    return [
      check("pid-recorded", "positive main PID retained", facts.mainPid, known(facts.mainPid)),
      check(
        "pid-creation-binding",
        "retained and observed creation-time digests match",
        [facts.mainCreationTimeSha256, facts.observedCreationTimeSha256],
        equals(facts.mainCreationTimeSha256, facts.observedCreationTimeSha256),
      ),
    ];
  }
  if (expectation.kind === "pid-pressure") {
    return [
      check(
        "pid-pressure-count",
        `at least ${expectation.count} process identities exercised`,
        facts.pidPressureCount,
        isAtLeast(facts.pidPressureCount, expectation.count),
      ),
      check(
        "pid-misbind",
        "zero PID-reuse misbindings",
        facts.pidReuseMisbindCount,
        isZero(facts.pidReuseMisbindCount),
      ),
    ];
  }
  if (expectation.kind === "os-shutdown") {
    return [
      check(
        "shutdown-notification",
        "OS shutdown notification observed",
        facts.osShutdownNotificationObserved,
        isTrue(facts.osShutdownNotificationObserved),
      ),
      ...treeStopChecks(facts, false),
    ];
  }
  if (expectation.kind === "normal-ready-shutdown") {
    return [
      check(
        "normal-scenario",
        "normal ready/shutdown scenario observed",
        facts.normalReadyShutdownObserved,
        isTrue(facts.normalReadyShutdownObserved),
      ),
      check(
        "ready-observed",
        "daemon reached ready",
        facts.readyObserved,
        isTrue(facts.readyObserved),
      ),
      check(
        "shutdown-acknowledged",
        "daemon acknowledged graceful shutdown",
        facts.shutdownAcknowledged,
        isTrue(facts.shutdownAcknowledged),
      ),
      ...treeStopChecks(facts, false),
    ];
  }
  if (expectation.kind === "daemon-crash-after-ready") {
    return [
      check(
        "daemon-crash-scenario",
        "daemon crash after ready observed",
        facts.daemonCrashAfterReadyObserved,
        isTrue(facts.daemonCrashAfterReadyObserved),
      ),
      check(
        "ready-observed",
        "daemon reached ready before crash",
        facts.readyObserved,
        isTrue(facts.readyObserved),
      ),
      ...treeStopChecks(facts, false),
    ];
  }
  if (expectation.kind === "main-process-crash") {
    return [
      check(
        "main-crash-scenario",
        "main-process crash observed",
        facts.mainProcessCrashObserved,
        isTrue(facts.mainProcessCrashObserved),
      ),
      ...treeStopChecks(facts, true),
    ];
  }
  if (expectation.kind === "grandchild-cleanup") {
    return [
      check(
        "grandchild-scenario",
        "grandchild process spawned",
        facts.grandchildSpawned,
        isTrue(facts.grandchildSpawned),
      ),
      check(
        "descendant-depth",
        "daemon plus grandchild observed",
        facts.descendantCount,
        isAtLeast(facts.descendantCount, 2),
      ),
      ...treeStopChecks(facts, false),
    ];
  }
  if (expectation.kind === "hang-before-ready") {
    return [
      check(
        "hang-scenario",
        "hang before ready observed",
        facts.hangBeforeReadyObserved,
        isTrue(facts.hangBeforeReadyObserved),
      ),
      check(
        "ready-not-observed",
        "daemon did not reach ready",
        facts.readyObserved,
        isFalse(facts.readyObserved),
      ),
      ...treeStopChecks(facts, true),
    ];
  }
  if (expectation.kind === "ignored-shutdown") {
    return [
      check(
        "ready-observed",
        "daemon reached ready",
        facts.readyObserved,
        isTrue(facts.readyObserved),
      ),
      check(
        "shutdown-ignored",
        "daemon did not acknowledge shutdown",
        facts.shutdownAcknowledged,
        isFalse(facts.shutdownAcknowledged),
      ),
      ...treeStopChecks(facts, true),
    ];
  }
  const lifecycleField = {
    "explicit-quit": ["explicitQuitObserved", "explicit Quit observed"],
    "uninstall-drain": ["uninstallDrainObserved", "uninstall drain observed"],
    "unrelated-process-safety": [
      "unrelatedSafetyProbeObserved",
      "unrelated-process safety probe observed",
    ],
    "update-drain": ["updateDrainObserved", "update drain observed"],
  }[expectation.kind];
  if (lifecycleField !== undefined) {
    return [
      check(
        "lifecycle-scenario",
        lifecycleField[1],
        facts[lifecycleField[0]],
        isTrue(facts[lifecycleField[0]]),
      ),
      ...treeStopChecks(facts, false),
    ];
  }
  fail("VERIFIER_INTERNAL", `missing F-09 evaluator for ${expectation.kind}`);
}

function singletonInvariantChecks(facts) {
  return [
    check(
      "one-writer",
      "at most one simultaneous writer",
      facts.simultaneousWriterMax,
      facts.simultaneousWriterMax === null ? null : facts.simultaneousWriterMax === 1,
    ),
    check(
      "one-database-writer",
      "at most one database writer",
      facts.databaseWriterCount,
      facts.databaseWriterCount === null ? null : facts.databaseWriterCount === 1,
    ),
    check(
      "one-port-owner",
      "at most one port owner",
      facts.portOwnerCount,
      facts.portOwnerCount === null ? null : facts.portOwnerCount === 1,
    ),
  ];
}

function evaluateF10(facts, expectation) {
  const invariants = singletonInvariantChecks(facts);
  if (expectation.kind === "singleton-race") {
    const raceObserved =
      expectation.raceKind === "mixed-alias"
        ? facts.mixedAliasRaceObserved
        : facts.simultaneousElectronLaunchObserved;
    return [
      ...invariants,
      check(
        "race-scenario",
        `${expectation.raceKind} race observed`,
        raceObserved,
        isTrue(raceObserved),
      ),
      check(
        "starter-count",
        `at least ${expectation.starterCount} starters`,
        facts.starterCount,
        isAtLeast(facts.starterCount, expectation.starterCount),
      ),
      check(
        "race-rounds",
        `at least ${expectation.raceRounds} race rounds`,
        facts.raceRounds,
        isAtLeast(facts.raceRounds, expectation.raceRounds),
      ),
      check(
        "one-successful-writer",
        "exactly one successful writer",
        facts.successfulWriterCount,
        facts.successfulWriterCount === null ? null : facts.successfulWriterCount === 1,
      ),
    ];
  }
  if (expectation.kind === "crash-recovery") {
    return [
      ...invariants,
      check(
        "crash-checkpoint",
        expectation.checkpoint,
        facts.crashCheckpoint,
        facts.crashCheckpoint === null ? null : facts.crashCheckpoint === expectation.checkpoint,
      ),
      check(
        "crash-checkpoint-reached",
        "requested crash checkpoint reached",
        facts.crashCheckpointReached,
        isTrue(facts.crashCheckpointReached),
      ),
      check(
        "one-recovery-writer",
        "exactly one recovery writer",
        facts.recoveryWriterCount,
        facts.recoveryWriterCount === null ? null : facts.recoveryWriterCount === 1,
      ),
    ];
  }
  if (expectation.kind === "distinct-home-control") {
    return [
      check(
        "distinct-home-scenario",
        "distinct-home control observed",
        facts.distinctHomeControlObserved,
        isTrue(facts.distinctHomeControlObserved),
      ),
      check(
        "distinct-homes",
        "home identities differ",
        [facts.homeIdentitySha256, facts.comparisonHomeIdentitySha256],
        differs(facts.homeIdentitySha256, facts.comparisonHomeIdentitySha256),
      ),
      check(
        "two-independent-writers",
        "one writer per distinct home",
        facts.successfulWriterCount,
        facts.successfulWriterCount === null ? null : facts.successfulWriterCount === 2,
      ),
    ];
  }
  if (expectation.kind === "compatible-peer") {
    return [
      ...invariants,
      check(
        "healthy-peer-scenario",
        "healthy compatible peer observed",
        facts.healthyPeerObserved,
        isTrue(facts.healthyPeerObserved),
      ),
      check(
        "peer-authenticated",
        "listener authenticated",
        facts.listenerAuthenticated,
        isTrue(facts.listenerAuthenticated),
      ),
      check(
        "peer-compatible",
        "listener protocol compatible",
        facts.listenerCompatible,
        isTrue(facts.listenerCompatible),
      ),
      check(
        "peer-responsive",
        "listener responsive",
        facts.listenerResponsive,
        isTrue(facts.listenerResponsive),
      ),
      check(
        "starter-not-adopted",
        "existing peer not adopted as a new writer",
        facts.starterAdmitted,
        isFalse(facts.starterAdmitted),
      ),
      check(
        "peer-guidance",
        "app-owned peer guidance emitted",
        facts.unmanagedPeerGuidanceEmitted,
        isTrue(facts.unmanagedPeerGuidanceEmitted),
      ),
    ];
  }
  if (expectation.kind === "peer-refused") {
    const checks = [
      ...invariants,
      check(
        "starter-refused",
        "starter not admitted as writer",
        facts.starterAdmitted,
        isFalse(facts.starterAdmitted),
      ),
      check(
        "native-refusal",
        "typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts),
      ),
    ];
    if (expectation.peerKind === "foreign") {
      checks.push(
        check(
          "foreign-listener-scenario",
          "foreign listener observed",
          facts.foreignListenerObserved,
          isTrue(facts.foreignListenerObserved),
        ),
        check(
          "foreign-not-authenticated",
          "foreign listener did not authenticate",
          facts.listenerAuthenticated,
          isFalse(facts.listenerAuthenticated),
        ),
      );
    } else if (expectation.peerKind === "unresponsive") {
      checks.push(
        check(
          "unresponsive-listener-scenario",
          "bound unresponsive listener observed",
          facts.unresponsiveListenerObserved,
          isTrue(facts.unresponsiveListenerObserved),
        ),
        check(
          "listener-unresponsive",
          "listener did not respond",
          facts.listenerResponsive,
          isFalse(facts.listenerResponsive),
        ),
      );
    } else {
      const relation = expectation.peerKind === "older-protocol" ? "older" : "newer";
      checks.push(
        check(
          "protocol-relation",
          relation,
          facts.protocolRelation,
          facts.protocolRelation === null ? null : facts.protocolRelation === relation,
        ),
        check(
          "protocol-incompatible",
          "listener protocol incompatible",
          facts.listenerCompatible,
          isFalse(facts.listenerCompatible),
        ),
      );
    }
    return checks;
  }
  if (expectation.kind === "stale-lock-reclaimed") {
    return [
      ...invariants,
      check(
        "stale-lock-identity",
        "stale lock identity independently proved",
        facts.staleLockIdentityProved,
        isTrue(facts.staleLockIdentityProved),
      ),
      check(
        "stale-lock",
        "stale lock reclaimed",
        facts.staleLockReclaimed,
        isTrue(facts.staleLockReclaimed),
      ),
    ];
  }
  if (expectation.kind === "stale-port-reclaimed") {
    return [
      ...invariants,
      check(
        "stale-port-identity",
        "stale port identity independently proved",
        facts.stalePortIdentityProved,
        isTrue(facts.stalePortIdentityProved),
      ),
      check(
        "stale-port",
        "stale port file reclaimed",
        facts.stalePortFileReclaimed,
        isTrue(facts.stalePortFileReclaimed),
      ),
    ];
  }
  if (expectation.kind === "read-only") {
    return [
      check(
        "read-only-scenario",
        "read-only tooling run observed",
        facts.readOnlyToolingObserved,
        isTrue(facts.readOnlyToolingObserved),
      ),
      check(
        "read-only",
        "zero mutations from read-only tooling",
        facts.readOnlyMutationCount,
        isZero(facts.readOnlyMutationCount),
      ),
    ];
  }
  if (expectation.kind === "second-user-refused") {
    return [
      check(
        "second-user-scenario",
        "second-user access probe observed",
        facts.secondUserProbeObserved,
        isTrue(facts.secondUserProbeObserved),
      ),
      check(
        "second-user-refused",
        "second-user access refused",
        facts.secondUserAccessSucceeded,
        isFalse(facts.secondUserAccessSucceeded),
      ),
      check(
        "native-refusal",
        "typed refusal or positive Win32 code",
        refusalActual(facts),
        refusalPass(facts),
      ),
    ];
  }
  if (expectation.kind === "pid-bound") {
    return [
      check(
        "pid-pressure-scenario",
        "PID-reuse pressure observed",
        facts.pidReusePressureObserved,
        isTrue(facts.pidReusePressureObserved),
      ),
      check(
        "pid-bound",
        "PID creation identity matched",
        facts.pidCreationMatches,
        isTrue(facts.pidCreationMatches),
      ),
    ];
  }
  if (expectation.kind === "guidance") {
    return [
      check(
        "unmanaged-peer-scenario",
        "unmanaged compatible peer observed",
        facts.unmanagedPeerObserved,
        isTrue(facts.unmanagedPeerObserved),
      ),
      check(
        "guidance",
        "unmanaged compatible-peer guidance emitted",
        facts.unmanagedPeerGuidanceEmitted,
        isTrue(facts.unmanagedPeerGuidanceEmitted),
      ),
    ];
  }
  if (expectation.kind === "bounded-share-deny") {
    return [
      ...invariants,
      check(
        "share-deny",
        "Defender sharing denial observed",
        facts.defenderShareDenyObserved,
        isTrue(facts.defenderShareDenyObserved),
      ),
      check(
        "retry-budget",
        `at most ${PROBE_CAMPAIGN_MANIFEST.parameters.f10Singleton.maxRetries} retries`,
        facts.retryCount,
        isAtMost(facts.retryCount, PROBE_CAMPAIGN_MANIFEST.parameters.f10Singleton.maxRetries),
      ),
      check(
        "retry-deadline",
        `at most ${PROBE_CAMPAIGN_MANIFEST.parameters.f10Singleton.retryDeadlineMs} ms`,
        facts.elapsedMs,
        isAtMost(facts.elapsedMs, PROBE_CAMPAIGN_MANIFEST.parameters.f10Singleton.retryDeadlineMs),
      ),
    ];
  }
  if (expectation.kind === "one-database-writer") {
    return [
      ...invariants,
      check(
        "database-sentinel-scenario",
        "database writer sentinel observed",
        facts.databaseSentinelObserved,
        isTrue(facts.databaseSentinelObserved),
      ),
      check(
        "database-writer",
        "exactly one successful writer",
        facts.successfulWriterCount,
        facts.successfulWriterCount === null ? null : facts.successfulWriterCount === 1,
      ),
    ];
  }
  if (expectation.kind === "second-activation") {
    return [
      ...invariants,
      check(
        "second-activation-scenario",
        "second Electron activation observed",
        facts.secondElectronActivationObserved,
        isTrue(facts.secondElectronActivationObserved),
      ),
      check(
        "activation-routed",
        "second activation routed to the existing instance",
        facts.activationRoutedToExistingInstance,
        isTrue(facts.activationRoutedToExistingInstance),
      ),
      check(
        "one-successful-writer",
        "exactly one successful writer",
        facts.successfulWriterCount,
        facts.successfulWriterCount === null ? null : facts.successfulWriterCount === 1,
      ),
    ];
  }
  fail("VERIFIER_INTERNAL", `missing F-10 evaluator for ${expectation.kind}`);
}

const EVALUATORS = {
  "F-01": evaluateF01,
  "F-02": evaluateF02,
  "F-03": evaluateF03,
  "F-04": evaluateF04,
  "F-05": evaluateF05,
  "F-06": evaluateF06,
  "F-07": evaluateF07,
  "F-08": evaluateF08,
  "F-09": evaluateF09,
  "F-10": evaluateF10,
};

function numericMetrics(rowId, facts) {
  let selected;
  switch (rowId) {
    case "F-01":
      selected = [["win32-error", "code", facts.win32Error]];
      break;
    case "F-02":
      selected = [
        ["broad-principal-effective-mask", "access-mask", facts.broadPrincipalEffectiveMask],
        ["current-user-effective-mask", "access-mask", facts.currentUserEffectiveMask],
      ];
      break;
    case "F-03":
      selected = [
        ["link-count", "count", facts.linkCount],
        ["outside-mutation-count", "count", facts.outsideMutationCount],
      ];
      break;
    case "F-04":
      selected = [
        ["duration", "milliseconds", facts.durationMs],
        ["outside-mutation-count", "count", facts.outsideMutationCount],
        ["swap-count", "count", facts.swapCount],
      ];
      break;
    case "F-05":
      selected = [
        ["identity-check-count", "count", facts.identityCheckCount],
        ["unrelated-mutation-count", "count", facts.unrelatedMutationCount],
      ];
      break;
    case "F-06":
      selected = [
        ["elapsed", "milliseconds", facts.elapsedMs],
        ["reader-sample-count", "count", facts.readerSampleCount],
        ["retry-count", "count", facts.retryCount],
      ];
      break;
    case "F-07":
      selected = [
        ["recovered-complete-count", "count", facts.recoveredCompleteCount],
        ["repetition-count", "count", facts.repetitionCount],
        ["signed-receipt-count", "count", facts.signedReceiptSha256s.length],
      ];
      break;
    case "F-08":
      selected = [
        ["max-concurrent-owners", "count", facts.maxConcurrentOwners],
        ["ownership-sample-count", "count", facts.ownershipSampleCount],
        ["race-iterations", "count", facts.raceIterations],
      ];
      break;
    case "F-09":
      selected = [
        ["descendant-count", "count", facts.descendantCount],
        ["pid-pressure-count", "count", facts.pidPressureCount],
        ["surviving-descendant-count", "count", facts.survivingDescendantCount],
      ];
      break;
    case "F-10":
      selected = [
        ["database-writer-count", "count", facts.databaseWriterCount],
        ["port-owner-count", "count", facts.portOwnerCount],
        ["race-rounds", "count", facts.raceRounds],
        ["starter-count", "count", facts.starterCount],
      ];
      break;
    default:
      fail("VERIFIER_INTERNAL", `missing metrics for ${rowId}`);
  }
  return selected
    .filter(([, , value]) => value !== null)
    .map(([name, unit, value]) => ({ name, unit, value }));
}

function metric(name, unit, value) {
  return { name, unit, value };
}

function resultOutcome(checks, captureComplete) {
  if (checks.some((entry) => entry.pass === false)) return "FAIL";
  if (!captureComplete || checks.some((entry) => entry.pass === null)) return "INCONCLUSIVE";
  return "PASS";
}

export function verifyProbeFacts(input) {
  assertExactKeys(
    input,
    ["rowId", "variantId", "rawFacts", "artifactHashes", "verifierSourceSha256"],
    "verifier input",
  );
  const definition = getProbeVerifierDefinition(input.rowId, input.variantId);
  validateRawFacts(definition, input.rawFacts);
  assertArtifactHashes(input.artifactHashes);
  assertSha256(input.verifierSourceSha256, "verifierSourceSha256");
  if (!input.artifactHashes.some((artifact) => artifact.sha256 === input.verifierSourceSha256)) {
    fail(
      "VERIFIER_SOURCE_NOT_RETAINED",
      "verifierSourceSha256 must identify a retained artifact hash",
    );
  }

  const verifierInputSha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-verifier-input.v1",
    definitionSha256: definition.definitionSha256,
    rowId: definition.rowId,
    variantId: definition.variantId,
    verifierId: definition.verifierId,
    verifierSourceSha256: input.verifierSourceSha256,
    rawFacts: input.rawFacts,
    artifactHashes: input.artifactHashes,
  });
  const rawFactsSha256 = hashProbeCanonicalJson({
    domain: "enduragent.windows-host-probe-raw-facts.v1",
    rowId: definition.rowId,
    variantId: definition.variantId,
    rawFacts: input.rawFacts,
  });
  const evidenceRef = input.artifactHashes.find(
    (artifact) =>
      artifact.path !== PROBE_VERIFIER_SOURCE_PATH &&
      artifact.sha256 === input.rawFacts.scenario.evidenceSha256,
  )?.path;
  if (evidenceRef === undefined) {
    fail(
      "VERIFIER_EVIDENCE_NOT_RETAINED",
      "artifactHashes must retain evidence separate from the verifier source",
    );
  }

  let checks = [];
  let outcome;
  let unavailability = null;
  const availability = input.rawFacts.availability;
  if (availability.status === "available") {
    checks = EVALUATORS[definition.rowId](input.rawFacts.facts, definition.expectation);
    outcome = resultOutcome(checks, input.rawFacts.captureComplete);
  } else if (
    availability.status === "unavailable" &&
    definition.conditionId !== null &&
    availability.reason !== null &&
    input.rawFacts.captureComplete
  ) {
    checks = [
      check(
        "conditional-unavailability",
        `independent observation that ${definition.conditionId} is unavailable`,
        availability.reason,
        true,
      ),
    ];
    outcome = "SKIP";
    unavailability = {
      conditionId: definition.conditionId,
      observedUnavailable: true,
      reason: availability.reason,
    };
  } else {
    checks = [
      check(
        "capability-availability",
        definition.conditionId === null
          ? "required capability available"
          : `availability of ${definition.conditionId} resolved`,
        availability.status,
        null,
      ),
    ];
    outcome = "INCONCLUSIVE";
  }

  const passCount = checks.filter((entry) => entry.pass === true).length;
  const failureCount = checks.filter((entry) => entry.pass === false).length;
  const unknownCount = checks.filter((entry) => entry.pass === null).length;
  const verificationMetrics = [
    metric("capture-complete", "boolean", input.rawFacts.captureComplete),
    metric("check-count", "count", checks.length),
    metric("failed-check-count", "count", failureCount),
    metric("passed-check-count", "count", passCount),
    metric("raw-facts-sha256", "sha256", rawFactsSha256),
    metric("unknown-check-count", "count", unknownCount),
    metric("verifier-definition-sha256", "sha256", definition.definitionSha256),
    metric("verifier-input-sha256", "sha256", verifierInputSha256),
    ...numericMetrics(definition.rowId, input.rawFacts.facts),
  ].sort((left, right) => compareUtf8(left.name, right.name));
  const observations = checks.map(({ step, expected, actual }) => ({
    step,
    expected,
    actual,
    evidenceRef,
  }));

  return deepFreeze({
    verifierId: definition.verifierId,
    verifierSourceSha256: input.verifierSourceSha256,
    verifierDefinitionSha256: definition.definitionSha256,
    verifierInputSha256,
    rawFactsSha256,
    outcome,
    observations,
    verificationMetrics,
    unavailability,
    mechanismId: definition.mechanismId,
    mechanismDefinition: definition.mechanismDefinition,
  });
}

for (const definition of PROBE_VERIFIER_DEFINITIONS) {
  if (
    definition.definitionSha256 !==
    hashProbeCanonicalJson({
      domain: "enduragent.windows-host-probe-verifier-definition.v1",
      definition: definitionPayload(definition),
    })
  ) {
    fail(
      "VERIFIER_INTERNAL",
      `definition digest drifted for ${definition.rowId}/${definition.variantId}`,
    );
  }
}
