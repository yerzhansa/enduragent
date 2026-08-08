import { describe, expect, it } from "vitest";

import { createPreparedContextFixture } from "./fixtures/windows-host/prepared-context.js";
import { resolveProbeActionActor } from "../scripts/windows-host-falsifier/probe-action-map.mjs";
import {
  createProbeControllerPreparedAuthority,
  validateProbeControllerPreparedAuthority,
} from "../scripts/windows-host-falsifier/probe-controller-prepared-authority.mjs";
import {
  createProbeRuntimeActionBinding,
  createProbeRuntimeActionBindingFromPreparedAuthority,
} from "../scripts/windows-host-falsifier/probe-runtime-action-intent.mjs";
import { PROBE_SCENARIO_DEFINITIONS } from "../scripts/windows-host-falsifier/probe-scenarios.mjs";

const authorityKeys = [
  "schemaVersion",
  "kind",
  "campaignId",
  "manifestSha256",
  "candidateSha256",
  "runPlanSha256",
  "runAuthorizationSha256",
  "runAuthorizationClaimReceiptSha256",
  "campaignRunId",
  "executionRunId",
  "executionBundleId",
  "executionBundleManifestSha256",
  "attemptId",
  "environmentId",
  "pathProfileId",
  "vmSnapshotId",
  "preflightSha256",
  "controller",
  "actors",
  "nativeHelper",
  "evidenceRootObjectIdentitySha256",
] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const actorCases = (() => {
  const selected = new Map<
    string,
    {
      readonly definition: (typeof PROBE_SCENARIO_DEFINITIONS)[number];
      readonly action: (typeof PROBE_SCENARIO_DEFINITIONS)[number]["actions"][number];
    }
  >();
  for (const definition of PROBE_SCENARIO_DEFINITIONS) {
    for (const action of definition.actions) {
      const resolved = resolveProbeActionActor({
        schemaVersion: 1,
        kind: "windows-host-probe-scenario-action-invocation",
        rowId: definition.rowId,
        variantId: definition.variantId,
        planSha256: definition.planSha256,
        action,
      });
      if (!selected.has(resolved.identitySource)) {
        selected.set(resolved.identitySource, { definition, action });
      }
    }
  }
  return [...selected.entries()];
})();

describe("probe controller prepared authority", () => {
  it("projects a closed, digest-bound, deeply frozen authority without local roots", () => {
    const prepared = createPreparedContextFixture();
    const authority = createProbeControllerPreparedAuthority(prepared);

    expect(Object.keys(authority)).toEqual(authorityKeys);
    expect(authority).toMatchObject({
      schemaVersion: 1,
      kind: "windows-host-probe-controller-prepared-authority",
      campaignId: prepared.campaignId,
      candidateSha256: prepared.candidateSha256,
      executionBundleManifestSha256: prepared.executionBundleManifestSha256,
      preflightSha256: prepared.preflightSha256,
      controller: {
        identitySha256: prepared.executionBundleManifest.controller.identitySha256,
        publicKeySha256: prepared.executionBundleManifest.controller.publicKeySha256,
        version: prepared.executionBundleManifest.controller.version,
      },
      actors: prepared.executionBundleManifest.actors,
      nativeHelper: {
        artifactPath: prepared.executionBundleManifest.binaries.nativeHelper.path,
        sha256: prepared.executionBundleManifest.binaries.nativeHelper.sha256,
        nativeCandidateDigest:
          prepared.executionBundleManifest.binaries.nativeHelper.nativeCandidateDigest,
        nativeManifestSha256:
          prepared.executionBundleManifest.binaries.nativeHelper.nativeManifestSha256,
      },
      evidenceRootObjectIdentitySha256:
        prepared.pathProfileObservation.evidenceRootObjectIdentitySha256,
    });
    expect(authority).not.toHaveProperty("executionBundleManifest");
    expect(authority).not.toHaveProperty("brokerEnrollments");
    expect(JSON.stringify(authority)).not.toMatch(/(?:[A-Za-z]:[\\/]|file:|^[/\\])/iu);
    expect(validateProbeControllerPreparedAuthority(authority)).toEqual(authority);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.controller)).toBe(true);
    expect(Object.isFrozen(authority.actors)).toBe(true);
    expect(Object.isFrozen(authority.nativeHelper)).toBe(true);
  });

  it.each(actorCases)(
    "derives the same runtime binding for %s from full and controller authority",
    (_identitySource, { definition, action }) => {
      const preparedContext = createPreparedContextFixture();
      const preparedAuthority = createProbeControllerPreparedAuthority(preparedContext);
      const command = {
        campaignRunId: preparedContext.campaignRunId,
        attemptId: preparedContext.attemptId,
        workId: `work-${definition.rowId.toLowerCase()}`,
        rowId: definition.rowId,
        variantId: definition.variantId,
        repetition: 1,
      };
      const invocation = {
        schemaVersion: 1 as const,
        kind: "windows-host-probe-scenario-action-invocation" as const,
        rowId: definition.rowId,
        variantId: definition.variantId,
        planSha256: definition.planSha256,
        action,
      };

      expect(
        createProbeRuntimeActionBindingFromPreparedAuthority({
          command,
          invocation,
          preparedAuthority,
        }),
      ).toEqual(createProbeRuntimeActionBinding({ command, invocation, preparedContext }));
    },
  );

  it("rejects full contexts, extra fields, and absolute artifact paths", () => {
    const prepared = createPreparedContextFixture();
    const authority = createProbeControllerPreparedAuthority(prepared);
    expect(() => validateProbeControllerPreparedAuthority(prepared)).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PREPARED_AUTHORITY_SCHEMA" }),
    );
    expect(() =>
      validateProbeControllerPreparedAuthority({ ...authority, evidenceRoot: "C:\\evidence" }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PREPARED_AUTHORITY_SCHEMA" }));
    expect(() =>
      validateProbeControllerPreparedAuthority({
        ...authority,
        nativeHelper: { ...authority.nativeHelper, artifactPath: "C:\\bin\\native.exe" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PREPARED_AUTHORITY_ARTIFACT_PATH" }),
    );
    expect(() =>
      validateProbeControllerPreparedAuthority({
        ...authority,
        nativeHelper: { ...authority.nativeHelper, journalRoot: "journal/root" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PREPARED_AUTHORITY_SCHEMA" }));
    expect(() =>
      validateProbeControllerPreparedAuthority({
        ...authority,
        controller: { ...authority.controller, version: "C:\\local\\controller.exe" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PREPARED_AUTHORITY_ABSOLUTE_PATH" }),
    );
  });

  it("rejects accessors without invoking them", () => {
    const authority = clone(createProbeControllerPreparedAuthority(createPreparedContextFixture()));
    let reads = 0;
    Object.defineProperty(authority, "campaignRunId", {
      enumerable: true,
      get() {
        reads += 1;
        return "campaign-one";
      },
    });

    expect(() => validateProbeControllerPreparedAuthority(authority)).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PREPARED_AUTHORITY_SCHEMA" }),
    );
    expect(reads).toBe(0);
  });

  it("validates the complete prepared context before projection", () => {
    const prepared = createPreparedContextFixture();
    expect(() =>
      createProbeControllerPreparedAuthority({
        ...prepared,
        preflightSha256: "0".repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: "PREFLIGHT_DIGEST" }));
  });
});
