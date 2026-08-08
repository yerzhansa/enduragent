import { PROBE_SCENARIO_DEFINITIONS } from "./probe-scenarios.mjs";

export const PROBE_ACTION_MAP_SCHEMA_VERSION = 1;

export const PROBE_EXECUTION_LOCI = Object.freeze([
  "guest-native-helper",
  "guest-standard-user-worker",
  "guest-second-user-broker",
  "controller-host",
  "controller-remote-peer",
  "controller-orchestrated-guest",
]);

export const PROBE_ACTOR_ROLES = Object.freeze([
  "primary-standard-user",
  "controller",
  "power-control",
  "snapshot-control",
  "remote-peer",
  "second-user",
]);

export const PROBE_ACTOR_IDENTITY_SOURCES = Object.freeze({
  "primary-standard-user": "actors.primaryStandardUserSidSha256",
  controller: "controller.identitySha256",
  "power-control": "actors.powerControlActorSha256",
  "snapshot-control": "actors.snapshotControlActorSha256",
  "remote-peer": "actors.remotePeerActorSha256",
  "second-user": "actors.secondUserSidSha256",
});

const mappingKeys = Object.freeze([
  "actor",
  "operation",
  "locus",
  "driverId",
  "disruptive",
  "nativeTranscriptRequired",
  "actorSelector",
]);
const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const authorityInputPattern = /(?:private|signing)[-_]?key/iu;
const disruptiveOperationPattern =
  /^(?:hard-cut-guest|kill-pipe-owner-at-checkpoint|kill-process-at-checkpoint|kill-singleton-process|reboot-guest|reboot-pipe-owner-guest|reboot-replacement-guest|request-os-shutdown-notification|restart-pipe-owner|restart-probe-process|start-guest-after-hard-cut|terminate-replacement-process)$/u;
const controllerHostOperationPattern =
  /^(?:hard-cut-guest|reboot-guest|reboot-pipe-owner-guest|reboot-replacement-guest|request-os-shutdown-notification|start-guest-after-hard-cut)$/u;
const remotePeerOperationPattern = /(?:^|-)remote(?:-|$)/u;
const secondUserOperationPattern = /(?:^|-)second-user(?:-|$)/u;

export class ProbeActionMapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeActionMapError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProbeActionMapError(code, message);
}

function exactObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    return Object.freeze(value);
  }
  if (exactObject(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
  }
  return value;
}

function assertExactKeys(value, required, optional, label) {
  if (!exactObject(value)) fail("ACTION_MAP_SCHEMA", `${label} must be a plain object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail("ACTION_MAP_SCHEMA", `${label} has an invalid field set`);
    }
    if (authorityInputPattern.test(key)) {
      fail("ACTION_MAP_PRIVATE_KEY", `${label} must not receive private signing material`);
    }
    if (!allowed.has(key)) fail("ACTION_MAP_SCHEMA", `${label} has unexpected key: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("ACTION_MAP_SCHEMA", `${label}.${key} must be enumerable data`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("ACTION_MAP_SCHEMA", `${label} is missing key: ${key}`);
  }
}

function readOwnData(value, key, label) {
  if (!exactObject(value)) fail("ACTION_MAP_SCHEMA", `${label} must be a plain object`);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    fail("ACTION_MAP_SCHEMA", `${label}.${key} must be enumerable data`);
  }
  return descriptor.value;
}

function assertIdentifier(value, label, maximumLength = 128) {
  if (typeof value !== "string" || value.length > maximumLength || !identifierPattern.test(value)) {
    fail("ACTION_MAP_IDENTIFIER", `${label} must be bounded lowercase kebab-case`);
  }
}

function actionKey(actor, operation) {
  return `${actor}\u001f${operation}`;
}

function displayKey(actor, operation) {
  return `${actor}/${operation}`;
}

function resolvedActor(role) {
  return Object.freeze({ role, identitySource: PROBE_ACTOR_IDENTITY_SOURCES[role] });
}

const RESOLVED_ACTORS = Object.freeze(
  Object.fromEntries(PROBE_ACTOR_ROLES.map((role) => [role, resolvedActor(role)])),
);

function fixedActorSelector(role) {
  return { kind: "fixed", role };
}

const PRIMARY_STANDARD_USER_SELECTOR = fixedActorSelector("primary-standard-user");
const CONTROLLER_SELECTOR = fixedActorSelector("controller");
const POWER_CONTROL_SELECTOR = fixedActorSelector("power-control");
const REMOTE_PEER_SELECTOR = fixedActorSelector("remote-peer");
const SECOND_USER_SELECTOR = fixedActorSelector("second-user");
const F02_ACCESS_ACTOR_SELECTOR = {
  kind: "parameter",
  parameter: "actor",
  roleByValue: {
    "current-user": "primary-standard-user",
    "second-user": "second-user",
  },
};

function createMapping(
  actorSelector,
  actor,
  operation,
  locus,
  driverId,
  disruptive,
  nativeTranscriptRequired,
) {
  return {
    actor,
    operation,
    locus,
    driverId,
    disruptive,
    nativeTranscriptRequired,
    actorSelector,
  };
}

function primaryMapping(...args) {
  return createMapping(PRIMARY_STANDARD_USER_SELECTOR, ...args);
}

function controllerMapping(...args) {
  return createMapping(CONTROLLER_SELECTOR, ...args);
}

function powerMapping(...args) {
  return createMapping(POWER_CONTROL_SELECTOR, ...args);
}

function remotePeerMapping(...args) {
  return createMapping(REMOTE_PEER_SELECTOR, ...args);
}

function secondUserMapping(...args) {
  return createMapping(SECOND_USER_SELECTOR, ...args);
}

function f02AccessMapping(...args) {
  return createMapping(F02_ACCESS_ACTOR_SELECTOR, ...args);
}

function assertActorSelector(mappingEntry, label) {
  const selector = mappingEntry.actorSelector;
  if (!exactObject(selector)) {
    fail("ACTION_MAP_ACTOR_SELECTOR", `${label}.actorSelector must be a plain object`);
  }
  const kind = readOwnData(selector, "kind", `${label}.actorSelector`);
  if (kind === "fixed") {
    assertExactKeys(selector, ["kind", "role"], [], `${label}.actorSelector`);
    if (!PROBE_ACTOR_ROLES.includes(selector.role)) {
      fail("ACTION_MAP_ACTOR_SELECTOR", `${label}.actorSelector.role is not a closed actor role`);
    }
    if (selector.role === "snapshot-control") {
      fail("ACTION_MAP_ACTOR_SELECTOR", `${label} selects preflight-only snapshot authority`);
    }
    return selector.role;
  }
  if (kind !== "parameter") {
    fail("ACTION_MAP_ACTOR_SELECTOR", `${label}.actorSelector.kind is invalid`);
  }
  assertExactKeys(selector, ["kind", "parameter", "roleByValue"], [], `${label}.actorSelector`);
  if (
    mappingEntry.actor !== "external-controller" ||
    mappingEntry.operation !== "exercise-directory-access" ||
    selector.parameter !== "actor"
  ) {
    fail("ACTION_MAP_ACTOR_SELECTOR", `${label} is not the frozen F-02 actor selector`);
  }
  assertExactKeys(
    selector.roleByValue,
    ["current-user", "second-user"],
    [],
    `${label}.actorSelector.roleByValue`,
  );
  if (
    selector.roleByValue["current-user"] !== "primary-standard-user" ||
    selector.roleByValue["second-user"] !== "second-user"
  ) {
    fail("ACTION_MAP_ACTOR_SELECTOR", `${label} changes the frozen F-02 actor selection`);
  }
  return null;
}

function resolveMappingActor(mappingEntry, parameters, label) {
  const fixedRole = assertActorSelector(mappingEntry, label);
  if (fixedRole !== null) return RESOLVED_ACTORS[fixedRole];
  if (!exactObject(parameters)) {
    fail("ACTION_MAP_ACTOR_SELECTOR_INPUT", `${label} parameters must be a plain object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    parameters,
    mappingEntry.actorSelector.parameter,
  );
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    fail("ACTION_MAP_ACTOR_SELECTOR_INPUT", `${label} actor selector input must be data`);
  }
  const value = descriptor.value;
  if (typeof value !== "string") {
    fail("ACTION_MAP_ACTOR_SELECTOR_INPUT", `${label} actor selector input must be a string`);
  }
  const role = mappingEntry.actorSelector.roleByValue[value];
  if (role === undefined) {
    fail("ACTION_MAP_ACTOR_SELECTOR_INPUT", `${label} actor selector input is unknown: ${value}`);
  }
  return RESOLVED_ACTORS[role];
}

export const PROBE_ACTION_MAPPINGS = deepFreeze([
  primaryMapping(
    "native-helper",
    "home-identity",
    "guest-native-helper",
    "f01-native-home-identity-driver",
    false,
    true,
  ),
  primaryMapping(
    "native-helper",
    "private-directory-ensure",
    "guest-native-helper",
    "f02-native-private-directory-driver",
    false,
    true,
  ),
  primaryMapping(
    "native-helper",
    "private-directory-inspect",
    "guest-native-helper",
    "f02-native-private-directory-driver",
    false,
    true,
  ),
  primaryMapping(
    "native-helper",
    "file-identity",
    "guest-native-helper",
    "f03-f05-native-file-identity-driver",
    false,
    true,
  ),
  primaryMapping(
    "native-helper",
    "private-file-create",
    "guest-native-helper",
    "f03-native-private-file-driver",
    false,
    true,
  ),
  primaryMapping(
    "native-helper",
    "secure-path-operation",
    "guest-native-helper",
    "f04-f05-native-secure-path-driver",
    false,
    true,
  ),
  primaryMapping(
    "native-helper",
    "evidence-tree-seal",
    "guest-native-helper",
    "f04-native-evidence-seal-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-home-topology",
    "guest-standard-user-worker",
    "f01-home-topology-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "restart-probe-process",
    "controller-host",
    "guest-process-lifecycle-driver",
    true,
    true,
  ),
  powerMapping(
    "external-controller",
    "reboot-guest",
    "controller-host",
    "f01-guest-boot-driver",
    true,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-directory-root",
    "guest-standard-user-worker",
    "f02-directory-setup-driver",
    false,
    true,
  ),
  f02AccessMapping(
    "external-controller",
    "exercise-directory-access",
    "controller-orchestrated-guest",
    "f02-access-coordination-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-private-file-target",
    "guest-standard-user-worker",
    "f03-target-setup-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "arm-inspect-create-swap",
    "controller-orchestrated-guest",
    "f03-swap-coordination-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-path-topology",
    "guest-standard-user-worker",
    "f04-path-topology-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "start-swap-workers",
    "controller-orchestrated-guest",
    "f04-swap-coordination-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "stop-swap-workers",
    "controller-orchestrated-guest",
    "f04-swap-coordination-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-object-lifetime",
    "guest-standard-user-worker",
    "f05-object-lifetime-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "replace-inspected-object",
    "guest-standard-user-worker",
    "f05-object-replacement-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-replacement-target",
    "guest-standard-user-worker",
    "f06-replacement-setup-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "start-defender-scan",
    "controller-orchestrated-guest",
    "f06-replacement-context-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "start-rapid-readers",
    "controller-orchestrated-guest",
    "f06-replacement-context-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "arm-replacement-session",
    "guest-standard-user-worker",
    "f06-replacement-campaign-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "run-replacement-operation",
    "guest-standard-user-worker",
    "f06-replacement-campaign-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "terminate-replacement-process",
    "controller-host",
    "f06-replacement-campaign-driver",
    true,
    true,
  ),
  powerMapping(
    "external-controller",
    "reboot-replacement-guest",
    "controller-host",
    "f06-replacement-campaign-driver",
    true,
    true,
  ),
  controllerMapping(
    "external-controller",
    "atomic-replacement-campaign",
    "controller-host",
    "f06-replacement-campaign-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "stop-context-workers",
    "controller-orchestrated-guest",
    "f06-replacement-context-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "inspect-replacement-after-recovery",
    "guest-standard-user-worker",
    "f06-replacement-campaign-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-durability-target",
    "guest-standard-user-worker",
    "f07-durability-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "start-durability-operation",
    "controller-orchestrated-guest",
    "f07-durability-guest-driver",
    false,
    true,
  ),
  powerMapping(
    "external-controller",
    "hard-cut-guest",
    "controller-host",
    "f07-durability-campaign-driver",
    true,
    true,
  ),
  powerMapping(
    "external-controller",
    "start-guest-after-hard-cut",
    "controller-host",
    "f07-durability-campaign-driver",
    true,
    true,
  ),
  primaryMapping(
    "external-controller",
    "inspect-durability-after-hard-cut",
    "guest-standard-user-worker",
    "f07-durability-guest-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "kill-process-at-checkpoint",
    "controller-host",
    "f07-durability-campaign-driver",
    true,
    true,
  ),
  primaryMapping(
    "external-controller",
    "inspect-durability-after-process-kill",
    "guest-standard-user-worker",
    "f07-durability-guest-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "durability-campaign",
    "controller-host",
    "f07-durability-campaign-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-named-pipe-scenario",
    "guest-standard-user-worker",
    "f08-pipe-guest-driver",
    false,
    true,
  ),
  remotePeerMapping(
    "external-controller",
    "start-remote-pipe-client",
    "controller-remote-peer",
    "f08-pipe-remote-peer-driver",
    false,
    true,
  ),
  secondUserMapping(
    "external-controller",
    "start-second-user-pipe-client",
    "guest-second-user-broker",
    "f08-pipe-second-user-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "precreate-foreign-pipe",
    "controller-orchestrated-guest",
    "f08-pipe-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "arm-pipe-owner-session",
    "guest-standard-user-worker",
    "f08-pipe-campaign-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "kill-pipe-owner-at-checkpoint",
    "controller-host",
    "f08-pipe-campaign-driver",
    true,
    true,
  ),
  primaryMapping(
    "external-controller",
    "inspect-pipe-after-owner-kill",
    "guest-standard-user-worker",
    "f08-pipe-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "launch-competing-starters",
    "controller-orchestrated-guest",
    "f08-pipe-guest-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "restart-pipe-owner",
    "controller-host",
    "f08-pipe-campaign-driver",
    true,
    true,
  ),
  primaryMapping(
    "external-controller",
    "inspect-pipe-after-restart",
    "guest-standard-user-worker",
    "f08-pipe-guest-driver",
    false,
    true,
  ),
  powerMapping(
    "external-controller",
    "reboot-pipe-owner-guest",
    "controller-host",
    "f08-pipe-campaign-driver",
    true,
    true,
  ),
  primaryMapping(
    "external-controller",
    "inspect-pipe-after-reboot",
    "guest-standard-user-worker",
    "f08-pipe-guest-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "named-pipe-campaign",
    "controller-host",
    "f08-pipe-campaign-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-job-object-scenario",
    "guest-standard-user-worker",
    "f09-job-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "configure-outer-job",
    "controller-orchestrated-guest",
    "f09-job-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "start-pid-pressure",
    "controller-orchestrated-guest",
    "f09-job-guest-driver",
    false,
    true,
  ),
  powerMapping(
    "external-controller",
    "request-os-shutdown-notification",
    "controller-host",
    "f09-job-campaign-driver",
    true,
    true,
  ),
  primaryMapping(
    "external-controller",
    "start-unrelated-sentinel",
    "controller-orchestrated-guest",
    "f09-job-guest-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "job-object-campaign",
    "controller-host",
    "f09-job-campaign-driver",
    false,
    true,
  ),

  primaryMapping(
    "external-controller",
    "prepare-singleton-scenario",
    "guest-standard-user-worker",
    "f10-singleton-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "launch-singleton-starters",
    "controller-orchestrated-guest",
    "f10-singleton-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "arm-singleton-session",
    "guest-standard-user-worker",
    "f10-singleton-campaign-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "kill-singleton-process",
    "controller-host",
    "f10-singleton-campaign-driver",
    true,
    true,
  ),
  primaryMapping(
    "external-controller",
    "inspect-singleton-after-kill",
    "guest-standard-user-worker",
    "f10-singleton-guest-driver",
    false,
    true,
  ),
  primaryMapping(
    "external-controller",
    "start-defender-share-deny",
    "controller-orchestrated-guest",
    "f10-singleton-guest-driver",
    false,
    true,
  ),
  secondUserMapping(
    "external-controller",
    "start-second-user-singleton-client",
    "guest-second-user-broker",
    "f10-singleton-second-user-driver",
    false,
    true,
  ),
  controllerMapping(
    "external-controller",
    "singleton-campaign",
    "controller-host",
    "f10-singleton-campaign-driver",
    false,
    true,
  ),
]);

function assertMapping(mappingEntry, index, exactKeys, normalizedKeys) {
  const label = `mappings[${index}]`;
  assertExactKeys(mappingEntry, mappingKeys, [], label);

  const rawActor = typeof mappingEntry.actor === "string" ? mappingEntry.actor : "";
  const rawOperation = typeof mappingEntry.operation === "string" ? mappingEntry.operation : "";
  const rawKey = actionKey(rawActor, rawOperation);
  const normalizedKey = actionKey(rawActor.toLowerCase(), rawOperation.toLowerCase());
  if (exactKeys.has(rawKey)) {
    fail("ACTION_MAP_DUPLICATE", `${displayKey(rawActor, rawOperation)} is duplicated`);
  }
  if (normalizedKeys.has(normalizedKey)) {
    fail("ACTION_MAP_CASE_COLLISION", `${displayKey(rawActor, rawOperation)} case-collides`);
  }
  exactKeys.add(rawKey);
  normalizedKeys.add(normalizedKey);

  if (!["native-helper", "external-controller"].includes(mappingEntry.actor)) {
    fail("ACTION_MAP_ACTOR", `${label}.actor is not a frozen scenario authority`);
  }
  assertIdentifier(mappingEntry.operation, `${label}.operation`);
  if (!PROBE_EXECUTION_LOCI.includes(mappingEntry.locus)) {
    fail("ACTION_MAP_LOCUS", `${label}.locus is not a closed execution locus`);
  }
  assertIdentifier(mappingEntry.driverId, `${label}.driverId`, 64);
  if (authorityInputPattern.test(mappingEntry.driverId)) {
    fail("ACTION_MAP_PRIVATE_KEY", `${label}.driverId must not name private signing material`);
  }
  if (typeof mappingEntry.disruptive !== "boolean") {
    fail("ACTION_MAP_SCHEMA", `${label}.disruptive must be boolean`);
  }
  if (typeof mappingEntry.nativeTranscriptRequired !== "boolean") {
    fail("ACTION_MAP_SCHEMA", `${label}.nativeTranscriptRequired must be boolean`);
  }
  const fixedRole = assertActorSelector(mappingEntry, label);

  if (mappingEntry.actor === "native-helper") {
    if (mappingEntry.locus !== "guest-native-helper") {
      fail("ACTION_MAP_ACTOR_LOCUS", `${label} moves native-helper authority out of the guest`);
    }
    if (!mappingEntry.nativeTranscriptRequired) {
      fail("ACTION_MAP_NATIVE_TRANSCRIPT", `${label} must retain native transcript evidence`);
    }
  } else if (mappingEntry.locus === "guest-native-helper") {
    fail("ACTION_MAP_ACTOR_LOCUS", `${label} assigns controller authority to the native helper`);
  }

  const allowedLociByRole = {
    "primary-standard-user": [
      "guest-native-helper",
      "guest-standard-user-worker",
      "controller-orchestrated-guest",
    ],
    controller: ["controller-host"],
    "power-control": ["controller-host"],
    "remote-peer": ["controller-remote-peer"],
    "second-user": ["guest-second-user-broker"],
  };
  if (fixedRole !== null && !allowedLociByRole[fixedRole].includes(mappingEntry.locus)) {
    fail(
      "ACTION_MAP_ACTOR_LOCUS",
      `${label} does not execute in the selected actor's closed locus`,
    );
  }
  if (fixedRole === null && mappingEntry.locus !== "controller-orchestrated-guest") {
    fail("ACTION_MAP_ACTOR_LOCUS", `${label} moves F-02 actor routing out of its coordinator`);
  }

  if (mappingEntry.disruptive && mappingEntry.locus !== "controller-host") {
    fail(
      "ACTION_MAP_CONTROLLER_BOUNDARY",
      `${label} moves a disruptive lifecycle action out of the controller host`,
    );
  }
  if (mappingEntry.locus !== "controller-host" && !mappingEntry.nativeTranscriptRequired) {
    fail("ACTION_MAP_NATIVE_TRANSCRIPT", `${label} omits evidence for a Windows execution locus`);
  }
  if (
    controllerHostOperationPattern.test(mappingEntry.operation) &&
    (mappingEntry.locus !== "controller-host" || fixedRole !== "power-control")
  ) {
    fail(
      "ACTION_MAP_CONTROLLER_BOUNDARY",
      `${label} moves a machine lifecycle action out of power-control`,
    );
  }
  if (
    remotePeerOperationPattern.test(mappingEntry.operation) &&
    (mappingEntry.locus !== "controller-remote-peer" || fixedRole !== "remote-peer")
  ) {
    fail("ACTION_MAP_REMOTE_BOUNDARY", `${label} does not execute on the remote peer`);
  }
  if (
    secondUserOperationPattern.test(mappingEntry.operation) &&
    (mappingEntry.locus !== "guest-second-user-broker" || fixedRole !== "second-user")
  ) {
    fail("ACTION_MAP_SECOND_USER_BOUNDARY", `${label} does not use the second-user broker`);
  }
  if (disruptiveOperationPattern.test(mappingEntry.operation) && !mappingEntry.disruptive) {
    fail("ACTION_MAP_DISRUPTIVE_BOUNDARY", `${label} hides a disruptive lifecycle boundary`);
  }
  if (mappingEntry.disruptive && fixedRole !== "controller" && fixedRole !== "power-control") {
    fail("ACTION_MAP_ACTOR_SELECTOR", `${label} assigns disruption to a guest actor`);
  }
}

function definitionActionPairs(scenarioDefinitions) {
  if (!Array.isArray(scenarioDefinitions) || scenarioDefinitions.length === 0) {
    fail("ACTION_MAP_SCHEMA", "scenarioDefinitions must be a non-empty array");
  }
  const pairs = new Map();
  let actionCount = 0;
  for (const [definitionIndex, definition] of scenarioDefinitions.entries()) {
    const label = `scenarioDefinitions[${definitionIndex}]`;
    if (!exactObject(definition) || !Array.isArray(definition.actions)) {
      fail("ACTION_MAP_SCHEMA", `${label} must expose an actions array`);
    }
    const coordinate = `${String(definition.rowId)}/${String(definition.variantId)}`;
    for (const [actionIndex, action] of definition.actions.entries()) {
      if (!exactObject(action)) {
        fail("ACTION_MAP_SCHEMA", `${label}.actions[${actionIndex}] must be a plain object`);
      }
      const actor = action.actor;
      const operation = action.operation;
      if (typeof actor !== "string" || typeof operation !== "string") {
        fail("ACTION_MAP_SCHEMA", `${label}.actions[${actionIndex}] has no actor/operation pair`);
      }
      const key = actionKey(actor, operation);
      const retained = pairs.get(key) ?? {
        actor,
        operation,
        coordinates: [],
        parameterSamples: [],
      };
      retained.coordinates.push(coordinate);
      retained.parameterSamples.push(action.parameters);
      pairs.set(key, retained);
      actionCount += 1;
    }
  }
  return { pairs, actionCount };
}

export function auditProbeActionMappings(options = {}) {
  assertExactKeys(options, [], ["scenarioDefinitions", "mappings"], "action map audit options");
  const scenarioDefinitions = options.scenarioDefinitions ?? PROBE_SCENARIO_DEFINITIONS;
  const mappings = options.mappings ?? PROBE_ACTION_MAPPINGS;
  if (!Array.isArray(mappings) || mappings.length === 0) {
    fail("ACTION_MAP_SCHEMA", "mappings must be a non-empty array");
  }

  const exactKeys = new Set();
  const normalizedKeys = new Set();
  const mappingByKey = new Map();
  for (const [index, mappingEntry] of mappings.entries()) {
    assertMapping(mappingEntry, index, exactKeys, normalizedKeys);
    mappingByKey.set(actionKey(mappingEntry.actor, mappingEntry.operation), mappingEntry);
  }

  const { pairs, actionCount } = definitionActionPairs(scenarioDefinitions);
  for (const { actor, operation, coordinates, parameterSamples } of pairs.values()) {
    const mappingEntry = mappingByKey.get(actionKey(actor, operation));
    if (mappingEntry === undefined) {
      fail(
        "ACTION_MAP_UNKNOWN_PAIR",
        `${displayKey(actor, operation)} has no mapping (${coordinates[0]})`,
      );
    }
    for (const [index, parameters] of parameterSamples.entries()) {
      resolveMappingActor(
        mappingEntry,
        parameters,
        `${coordinates[index]} ${displayKey(actor, operation)}`,
      );
    }
  }
  for (const mappingEntry of mappings) {
    if (!pairs.has(actionKey(mappingEntry.actor, mappingEntry.operation))) {
      fail(
        "ACTION_MAP_DEAD_ENTRY",
        `${displayKey(mappingEntry.actor, mappingEntry.operation)} is not used by a scenario`,
      );
    }
  }

  return deepFreeze({
    schemaVersion: PROBE_ACTION_MAP_SCHEMA_VERSION,
    kind: "windows-host-probe-action-map-audit",
    scenarioDefinitionCount: scenarioDefinitions.length,
    scenarioActionCount: actionCount,
    actionPairCount: pairs.size,
    mappingCount: mappings.length,
  });
}

const retainedMappingByKey = new Map(
  PROBE_ACTION_MAPPINGS.map((entry) => [actionKey(entry.actor, entry.operation), entry]),
);

function mappingCoordinates(first, operation) {
  if (typeof first === "string") {
    if (typeof operation !== "string") {
      fail("ACTION_MAP_LOOKUP", "actor/operation lookup requires two strings");
    }
    return { actor: first, operation };
  }
  if (operation !== undefined || !exactObject(first)) {
    fail("ACTION_MAP_LOOKUP", "lookup must be an invocation or actor/operation pair");
  }
  if (first.kind === "windows-host-probe-scenario-action-invocation") {
    assertExactKeys(
      first,
      ["schemaVersion", "kind", "rowId", "variantId", "planSha256", "action"],
      [],
      "action invocation",
    );
    if (!exactObject(first.action)) {
      fail("ACTION_MAP_LOOKUP", "action invocation.action must be a plain object");
    }
    if (
      exactObject(first.action.parameters) &&
      Object.keys(first.action.parameters).some((key) => authorityInputPattern.test(key))
    ) {
      fail("ACTION_MAP_PRIVATE_KEY", "action invocation must not contain private signing material");
    }
    return { actor: first.action.actor, operation: first.action.operation };
  }
  assertExactKeys(first, ["actor", "operation"], [], "action mapping coordinates");
  return { actor: first.actor, operation: first.operation };
}

export function getProbeActionMapping(first, operation) {
  const coordinates = mappingCoordinates(first, operation);
  if (typeof coordinates.actor !== "string" || typeof coordinates.operation !== "string") {
    fail("ACTION_MAP_LOOKUP", "action mapping coordinates must be strings");
  }
  const retained = retainedMappingByKey.get(actionKey(coordinates.actor, coordinates.operation));
  if (retained === undefined) {
    fail(
      "ACTION_MAP_UNKNOWN_PAIR",
      `${displayKey(coordinates.actor, coordinates.operation)} is not mapped`,
    );
  }
  return retained;
}

export function resolveProbeActionActor(invocation) {
  if (!exactObject(invocation)) {
    fail("ACTION_MAP_ACTOR_SELECTOR_INPUT", "action invocation must be a plain object");
  }
  const mappingEntry = getProbeActionMapping(invocation);
  if (!exactObject(invocation.action) || !exactObject(invocation.action.parameters)) {
    fail("ACTION_MAP_ACTOR_SELECTOR_INPUT", "action invocation parameters are invalid");
  }
  return resolveMappingActor(mappingEntry, invocation.action.parameters, "action invocation");
}

export const PROBE_ACTION_MAP_AUDIT = auditProbeActionMappings();
