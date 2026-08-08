import { describe, expect, it } from "vitest";

import {
  PROBE_ACTOR_IDENTITY_SOURCES,
  PROBE_ACTOR_ROLES,
  PROBE_ACTION_MAP_AUDIT,
  PROBE_ACTION_MAPPINGS,
  PROBE_EXECUTION_LOCI,
  ProbeActionMapError,
  auditProbeActionMappings,
  getProbeActionMapping,
  resolveProbeActionActor,
  type ProbeActionMapping,
} from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import {
  PROBE_SCENARIO_DEFINITIONS,
  getProbeScenarioDefinition,
  type ProbeScenarioActionInvocation,
} from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

function pair(actor: string, operation: string) {
  return `${actor}/${operation}`;
}

function expectCode(work: () => unknown, code: string) {
  expect(work).toThrowError(ProbeActionMapError);
  try {
    work();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function replaceMapping(
  actor: ProbeActionMapping["actor"],
  operation: string,
  patch: Partial<ProbeActionMapping>,
) {
  return PROBE_ACTION_MAPPINGS.map((entry) =>
    entry.actor === actor && entry.operation === operation ? { ...entry, ...patch } : entry,
  );
}

describe("Windows host probe action execution map", () => {
  it("covers every frozen actor/operation pair exactly and has no dead entry", () => {
    const scenarioPairs = [
      ...new Set(
        PROBE_SCENARIO_DEFINITIONS.flatMap((definition) =>
          definition.actions.map((action) => pair(action.actor, action.operation)),
        ),
      ),
    ].sort();
    const mappedPairs = PROBE_ACTION_MAPPINGS.map((entry) =>
      pair(entry.actor, entry.operation),
    ).sort();

    expect(scenarioPairs).toHaveLength(64);
    expect(mappedPairs).toEqual(scenarioPairs);
    expect(new Set(mappedPairs).size).toBe(mappedPairs.length);
    expect(PROBE_ACTION_MAPPINGS.filter(({ actor }) => actor === "native-helper")).toHaveLength(7);
    expect(
      PROBE_ACTION_MAPPINGS.filter(({ actor }) => actor === "external-controller"),
    ).toHaveLength(57);
    expect(PROBE_ACTION_MAP_AUDIT).toEqual({
      schemaVersion: 1,
      kind: "windows-host-probe-action-map-audit",
      scenarioDefinitionCount: 261,
      scenarioActionCount: 1020,
      actionPairCount: 64,
      mappingCount: 64,
    });
  });

  it("returns the same immutable mapping for coordinates and a scenario invocation", () => {
    const definition = getProbeScenarioDefinition("F-01", "f01-ordinary-absolute-path");
    const invocation: ProbeScenarioActionInvocation = {
      schemaVersion: 1,
      kind: "windows-host-probe-scenario-action-invocation",
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action: definition.actions[0],
    };
    const fromArguments = getProbeActionMapping("external-controller", "prepare-home-topology");
    const fromCoordinates = getProbeActionMapping({
      actor: "external-controller",
      operation: "prepare-home-topology",
    });
    const fromInvocation = getProbeActionMapping(invocation);

    expect(fromArguments).toBe(fromCoordinates);
    expect(fromCoordinates).toBe(fromInvocation);
    expect(Object.isFrozen(PROBE_ACTION_MAPPINGS)).toBe(true);
    expect(Object.isFrozen(PROBE_ACTION_MAP_AUDIT)).toBe(true);
    expect(Object.isFrozen(fromInvocation)).toBe(true);
    expect(PROBE_ACTION_MAPPINGS.every(Object.isFrozen)).toBe(true);
    expect(PROBE_ACTION_MAPPINGS.every(({ actorSelector }) => Object.isFrozen(actorSelector))).toBe(
      true,
    );
    expect(PROBE_EXECUTION_LOCI).toEqual([
      "guest-native-helper",
      "guest-standard-user-worker",
      "guest-second-user-broker",
      "controller-host",
      "controller-remote-peer",
      "controller-orchestrated-guest",
    ]);
    expect(Object.isFrozen(PROBE_EXECUTION_LOCI)).toBe(true);
  });

  it("separates provenance authority from physical execution locus", () => {
    expect(getProbeActionMapping("native-helper", "private-file-create")).toEqual({
      actor: "native-helper",
      operation: "private-file-create",
      locus: "guest-native-helper",
      driverId: "f03-native-private-file-driver",
      disruptive: false,
      nativeTranscriptRequired: true,
      actorSelector: { kind: "fixed", role: "primary-standard-user" },
    });
    expect(getProbeActionMapping("external-controller", "prepare-home-topology")).toEqual({
      actor: "external-controller",
      operation: "prepare-home-topology",
      locus: "guest-standard-user-worker",
      driverId: "f01-home-topology-driver",
      disruptive: false,
      nativeTranscriptRequired: true,
      actorSelector: { kind: "fixed", role: "primary-standard-user" },
    });
    expect(getProbeActionMapping("external-controller", "exercise-directory-access")).toEqual({
      actor: "external-controller",
      operation: "exercise-directory-access",
      locus: "controller-orchestrated-guest",
      driverId: "f02-access-coordination-driver",
      disruptive: false,
      nativeTranscriptRequired: true,
      actorSelector: {
        kind: "parameter",
        parameter: "actor",
        roleByValue: {
          "current-user": "primary-standard-user",
          "second-user": "second-user",
        },
      },
    });
    expect(
      getProbeActionMapping("external-controller", "start-second-user-pipe-client"),
    ).toMatchObject({
      locus: "guest-second-user-broker",
      driverId: "f08-pipe-second-user-driver",
    });
    expect(getProbeActionMapping("external-controller", "start-remote-pipe-client")).toMatchObject({
      locus: "controller-remote-peer",
      driverId: "f08-pipe-remote-peer-driver",
    });
    expect(getProbeActionMapping("external-controller", "hard-cut-guest")).toMatchObject({
      locus: "controller-host",
      driverId: "f07-durability-campaign-driver",
      disruptive: true,
    });
  });

  it("selects exactly one actor from the closed role and identity-source vocabulary", () => {
    expect(PROBE_ACTOR_ROLES).toEqual([
      "primary-standard-user",
      "controller",
      "power-control",
      "snapshot-control",
      "remote-peer",
      "second-user",
    ]);
    expect(PROBE_ACTOR_IDENTITY_SOURCES).toEqual({
      "primary-standard-user": "actors.primaryStandardUserSidSha256",
      controller: "controller.identitySha256",
      "power-control": "actors.powerControlActorSha256",
      "snapshot-control": "actors.snapshotControlActorSha256",
      "remote-peer": "actors.remotePeerActorSha256",
      "second-user": "actors.secondUserSidSha256",
    });
    expect(Object.isFrozen(PROBE_ACTOR_ROLES)).toBe(true);
    expect(Object.isFrozen(PROBE_ACTOR_IDENTITY_SOURCES)).toBe(true);

    const parameterSelectors = PROBE_ACTION_MAPPINGS.filter(
      ({ actorSelector }) => actorSelector.kind === "parameter",
    );
    expect(parameterSelectors.map(({ operation }) => operation)).toEqual([
      "exercise-directory-access",
    ]);
    expect(
      PROBE_ACTION_MAPPINGS.some(
        ({ actorSelector }) =>
          actorSelector.kind === "fixed" && actorSelector.role === "snapshot-control",
      ),
    ).toBe(false);
    for (const mapping of PROBE_ACTION_MAPPINGS) {
      if (mapping.actorSelector.kind === "fixed") {
        expect(PROBE_ACTOR_ROLES).toContain(mapping.actorSelector.role);
      } else {
        expect(Object.values(mapping.actorSelector.roleByValue)).toEqual([
          "primary-standard-user",
          "second-user",
        ]);
      }
      expect(mapping.actorSelector).not.toHaveProperty("roles");
      expect(mapping.actorSelector).not.toHaveProperty("participants");
    }
  });

  it("resolves only the trusted F-02 actor parameter and rejects missing or unknown values", () => {
    const current = getProbeScenarioDefinition("F-02", "f02-owner-read");
    const second = getProbeScenarioDefinition("F-02", "f02-second-user-write-refusal");
    const invocation = (definition: typeof current): ProbeScenarioActionInvocation => ({
      schemaVersion: 1,
      kind: "windows-host-probe-scenario-action-invocation",
      rowId: definition.rowId,
      variantId: definition.variantId,
      planSha256: definition.planSha256,
      action: definition.actions.find(({ actionId }) => actionId === "exercise-directory-access")!,
    });

    expect(resolveProbeActionActor(invocation(current))).toEqual({
      role: "primary-standard-user",
      identitySource: "actors.primaryStandardUserSidSha256",
    });
    expect(resolveProbeActionActor(invocation(second))).toEqual({
      role: "second-user",
      identitySource: "actors.secondUserSidSha256",
    });

    for (const actor of [undefined, null, 1, "remote-peer"] as const) {
      const trusted = invocation(current);
      const parameters = actor === undefined ? {} : { actor, operation: "read" };
      expectCode(
        () =>
          resolveProbeActionActor({
            ...trusted,
            action: { ...trusted.action, parameters },
          } as never),
        "ACTION_MAP_ACTOR_SELECTOR_INPUT",
      );
    }
  });

  it("assigns each split lifecycle action to one authoritative actor", () => {
    const roles = (rowId: string, variantId: string) => {
      const definition = getProbeScenarioDefinition(rowId, variantId);
      return Object.fromEntries(
        definition.actions.map((action) => [
          action.actionId,
          resolveProbeActionActor({
            schemaVersion: 1,
            kind: "windows-host-probe-scenario-action-invocation",
            rowId,
            variantId,
            planSha256: definition.planSha256,
            action,
          }).role,
        ]),
      );
    };

    expect(roles("F-06", "f06-process-crash-after-flush-share-allows-replace")).toMatchObject({
      "arm-replacement-session": "primary-standard-user",
      "terminate-replacement-process": "controller",
      "inspect-replacement-after-recovery": "primary-standard-user",
      "capture-atomic-replacement-campaign": "controller",
    });
    expect(roles("F-06", "f06-reboot-after-flush-share-allows-replace")).toMatchObject({
      "arm-replacement-session": "primary-standard-user",
      "reboot-replacement-guest": "power-control",
      "inspect-replacement-after-recovery": "primary-standard-user",
      "capture-atomic-replacement-campaign": "controller",
    });
    expect(roles("F-07", "f07-hard-cut-after-file-flush")).toMatchObject({
      "start-durability-operation-r1": "primary-standard-user",
      "hard-cut-guest-r1": "power-control",
      "start-guest-after-hard-cut-r1": "power-control",
      "inspect-durability-after-hard-cut-r1": "primary-standard-user",
      "capture-durability-campaign": "controller",
    });
    expect(roles("F-08", "f08-kill-before-accept")).toMatchObject({
      "arm-pipe-owner-session": "primary-standard-user",
      "kill-pipe-owner-at-checkpoint": "controller",
      "inspect-pipe-after-owner-kill": "primary-standard-user",
      "capture-named-pipe-campaign": "controller",
    });
    expect(roles("F-08", "f08-reboot-stability")).toMatchObject({
      "reboot-pipe-owner-guest": "power-control",
      "inspect-pipe-after-reboot": "primary-standard-user",
      "capture-named-pipe-campaign": "controller",
    });
    expect(roles("F-10", "f10-kill-after-port-bind")).toMatchObject({
      "arm-singleton-session": "primary-standard-user",
      "kill-singleton-process": "controller",
      "inspect-singleton-after-kill": "primary-standard-user",
      "capture-singleton-campaign": "controller",
    });
    expect(roles("F-08", "f08-client-remote-pipe-refusal")).toMatchObject({
      "start-remote-pipe-client": "remote-peer",
    });
    expect(roles("F-10", "f10-second-user-acl-refusal")).toMatchObject({
      "start-second-user-singleton-client": "second-user",
    });
  });

  it("keeps the five controller campaign families independently dispatchable", () => {
    const campaigns = [
      getProbeActionMapping("external-controller", "atomic-replacement-campaign"),
      getProbeActionMapping("external-controller", "durability-campaign"),
      getProbeActionMapping("external-controller", "named-pipe-campaign"),
      getProbeActionMapping("external-controller", "job-object-campaign"),
      getProbeActionMapping("external-controller", "singleton-campaign"),
    ];

    expect(campaigns.map(({ driverId }) => driverId)).toEqual([
      "f06-replacement-campaign-driver",
      "f07-durability-campaign-driver",
      "f08-pipe-campaign-driver",
      "f09-job-campaign-driver",
      "f10-singleton-campaign-driver",
    ]);
    expect(new Set(campaigns.map(({ driverId }) => driverId)).size).toBe(campaigns.length);
    expect(campaigns.every(({ locus }) => locus === "controller-host")).toBe(true);
    expect(campaigns.every(({ disruptive }) => disruptive === false)).toBe(true);
    expect(
      campaigns.every(
        ({ actorSelector }) =>
          actorSelector.kind === "fixed" && actorSelector.role === "controller",
      ),
    ).toBe(true);
  });

  it("marks every process or machine lifecycle boundary as disruptive", () => {
    const disruptiveOperations = PROBE_ACTION_MAPPINGS.filter(({ disruptive }) => disruptive)
      .map(({ operation }) => operation)
      .sort();

    expect(disruptiveOperations).toEqual(
      [
        "hard-cut-guest",
        "kill-pipe-owner-at-checkpoint",
        "kill-process-at-checkpoint",
        "kill-singleton-process",
        "reboot-guest",
        "reboot-pipe-owner-guest",
        "reboot-replacement-guest",
        "request-os-shutdown-notification",
        "restart-pipe-owner",
        "restart-probe-process",
        "start-guest-after-hard-cut",
        "terminate-replacement-process",
      ].sort(),
    );
    expect(
      PROBE_ACTION_MAPPINGS.filter(({ disruptive }) => disruptive).every(
        ({ actor, locus }) => actor === "external-controller" && locus === "controller-host",
      ),
    ).toBe(true);
  });

  it("refuses unknown lookups and private signing material as mapping input", () => {
    expectCode(
      () => getProbeActionMapping("external-controller", "unmapped-operation"),
      "ACTION_MAP_UNKNOWN_PAIR",
    );
    expectCode(
      () =>
        getProbeActionMapping({
          actor: "external-controller",
          operation: "prepare-home-topology",
          privateKey: "not-an-input",
        } as never),
      "ACTION_MAP_PRIVATE_KEY",
    );
  });

  it("detects scenario drift through an injected definition set", () => {
    expectCode(
      () =>
        auditProbeActionMappings({
          scenarioDefinitions: [
            ...PROBE_SCENARIO_DEFINITIONS,
            {
              rowId: "F-99",
              variantId: "f99-new-operation",
              actions: [
                {
                  actor: "external-controller",
                  operation: "new-operation",
                  parameters: {},
                },
              ],
            },
          ],
        }),
      "ACTION_MAP_UNKNOWN_PAIR",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          scenarioDefinitions: [
            {
              rowId: "F-01",
              variantId: "f01-synthetic",
              actions: [
                {
                  actor: "native-helper",
                  operation: "home-identity",
                  parameters: {},
                },
              ],
            },
          ],
        }),
      "ACTION_MAP_DEAD_ENTRY",
    );
  });

  it("rejects duplicate, case-colliding, and invalid actor/locus maps", () => {
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: [...PROBE_ACTION_MAPPINGS, PROBE_ACTION_MAPPINGS[0]],
        }),
      "ACTION_MAP_DUPLICATE",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: [
            ...PROBE_ACTION_MAPPINGS,
            {
              ...PROBE_ACTION_MAPPINGS[0],
              actor: "NATIVE-HELPER",
            } as never,
          ],
        }),
      "ACTION_MAP_CASE_COLLISION",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("native-helper", "home-identity", {
            locus: "controller-host",
          }),
        }),
      "ACTION_MAP_ACTOR_LOCUS",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "reboot-guest", {
            locus: "controller-orchestrated-guest",
          }),
        }),
      "ACTION_MAP_ACTOR_LOCUS",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "terminate-replacement-process", {
            locus: "controller-orchestrated-guest",
          }),
        }),
      "ACTION_MAP_ACTOR_LOCUS",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "start-remote-pipe-client", {
            locus: "controller-host",
          }),
        }),
      "ACTION_MAP_ACTOR_LOCUS",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "start-second-user-pipe-client", {
            locus: "guest-standard-user-worker",
          }),
        }),
      "ACTION_MAP_ACTOR_LOCUS",
    );
  });

  it("rejects missing, composite, snapshot, or non-F-02 actor selectors", () => {
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "prepare-home-topology", {
            actorSelector: { kind: "fixed", role: "snapshot-control" },
          }),
        }),
      "ACTION_MAP_ACTOR_SELECTOR",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "prepare-home-topology", {
            actorSelector: {
              kind: "parameter",
              parameter: "actor",
              roleByValue: {
                "current-user": "primary-standard-user",
                "second-user": "second-user",
              },
            },
          }),
        }),
      "ACTION_MAP_ACTOR_SELECTOR",
    );
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "prepare-home-topology", {
            actorSelector: {
              kind: "fixed",
              role: "primary-standard-user",
              participants: ["controller"],
            } as never,
          }),
        }),
      "ACTION_MAP_SCHEMA",
    );
  });

  it("rejects parameter-directed second-user work in the primary guest worker", () => {
    expectCode(
      () =>
        auditProbeActionMappings({
          mappings: replaceMapping("external-controller", "exercise-directory-access", {
            locus: "guest-standard-user-worker",
          }),
        }),
      "ACTION_MAP_ACTOR_LOCUS",
    );
  });
});
