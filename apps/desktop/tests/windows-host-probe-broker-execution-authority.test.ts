import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  acquireProbeBrokerExecutionAuthorityLease,
  assertProbeBrokerExecutionAuthorityLease,
  bindProbeBrokerExecutionAuthorityLeaseToOperation,
  confirmProbeBrokerExecutionAuthority,
  consumeProbeBrokerExecutionAuthorityConfirmation,
  discardProbeBrokerExecutionAuthorityConfirmation,
  markProbeBrokerExecutionAuthorityEffectStarted,
  markProbeBrokerExecutionAuthorityResultRetained,
  releaseProbeBrokerExecutionAuthorityLease,
} from "../scripts/windows-host-falsifier/broker/execution-authority.mjs";
import type {
  ProbeBrokerExecutionAuthorityConfirmation,
  ProbeBrokerExecutionAuthorityLease,
  ProbeBrokerExecutionAuthoritySnapshot,
} from "../scripts/windows-host-falsifier/broker/execution-authority.mjs";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function authoritySnapshot(
  overrides: Partial<ProbeBrokerExecutionAuthoritySnapshot> = {},
): ProbeBrokerExecutionAuthoritySnapshot {
  return {
    schemaVersion: 1,
    kind: "windows-host-probe-broker-execution-authority",
    preparedRunGenerationSha256: sha256("prepared-run-generation"),
    controllerIdentitySha256: sha256("controller-identity"),
    controllerPublicKeySha256: sha256("controller-public-key"),
    candidateSha256: sha256("candidate"),
    runAuthorizationClaimReceiptSha256: sha256("run-authorization-claim"),
    coordinate: {
      campaignRunId: "campaign-run-a",
      executionRunId: "execution-run-a",
      attemptId: "attempt-a",
      workId: "work-0001",
      environmentId: "win11-current",
      pathProfileId: "ascii",
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      repetition: null,
    },
    semanticKeySha256: sha256("semantic-operation"),
    physicalOperationKeySha256: sha256("physical-operation"),
    runtimeActionIntentSha256: sha256("runtime-action-intent"),
    operationId: "operation-a",
    producerActionId: "producer-action-a",
    driverId: "driver-a",
    brokerEnrollmentSha256: sha256("static-broker-enrollment"),
    preparedBrokerEnrollmentSha256: sha256("prepared-broker-enrollment"),
    brokerInstanceId: "primary-broker-a",
    brokerRole: "primary-standard-user",
    mailboxRootObjectIdentitySha256: sha256("mailbox-root-object"),
    mailboxVolumeIdSha256: sha256("mailbox-volume"),
    mailboxTransportIdentitySha256: sha256("mailbox-transport"),
    mailboxAclSha256: sha256("mailbox-acl"),
    mailboxOwnerSidSha256: sha256("mailbox-owner"),
    journalRoot: "/tmp/enduragent-authority-journal",
    journalSecurityProfile: "role-separated-append-only-journal-v1",
    journalRootPathSha256: sha256("journal-root-path"),
    journalRootObjectIdentitySha256: sha256("journal-root-object"),
    journalVolumeIdSha256: sha256("journal-volume"),
    journalRootOwnerSidSha256: sha256("journal-root-owner"),
    journalRootAclSha256: sha256("journal-root-acl"),
    journalDatabasePathSha256: sha256("journal-database-path"),
    journalDatabaseObjectIdentitySha256: sha256("journal-database-object"),
    journalDatabaseOwnerSidSha256: sha256("journal-database-owner"),
    journalDatabaseAclSha256: sha256("journal-database-acl"),
    journalTransportIdentitySha256: sha256("journal-transport"),
    processSidSha256: sha256("primary-user-sid"),
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("runner-session"),
    nativeObservationSha256: sha256("native-observation"),
    peerAuthoritySha256: null,
    ...overrides,
  };
}

async function acquire(
  snapshot = authoritySnapshot(),
  overrides: {
    readonly acquire?: () => ProbeBrokerExecutionAuthoritySnapshot;
    readonly revalidate?: () => ProbeBrokerExecutionAuthoritySnapshot;
    readonly release?: () => void | Promise<void>;
  } = {},
) {
  return acquireProbeBrokerExecutionAuthorityLease({
    acquire: overrides.acquire ?? (() => snapshot),
    revalidate: overrides.revalidate ?? (() => snapshot),
    release: overrides.release ?? (() => {}),
  });
}

describe("Windows host probe broker execution authority", () => {
  it("acquires without task selectors and mints single-use phase-bound confirmations", async () => {
    const snapshot = authoritySnapshot();
    const acquireArguments: unknown[][] = [];
    const revalidateArguments: unknown[][] = [];
    const lease = await acquire(snapshot, {
      acquire: (...args: unknown[]) => {
        acquireArguments.push(args);
        return snapshot;
      },
      revalidate: (...args: unknown[]) => {
        revalidateArguments.push(args);
        return snapshot;
      },
    });

    expect(acquireArguments).toEqual([[]]);
    expect(assertProbeBrokerExecutionAuthorityLease(lease)).toMatchObject({ snapshot });
    const confirmation = await confirmProbeBrokerExecutionAuthority(lease, "effect-started");
    expect(revalidateArguments).toEqual([[]]);
    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(lease, confirmation, "effect-started"),
    ).resolves.toEqual(snapshot);
    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(lease, confirmation, "effect-started"),
    ).rejects.toThrow(/already consumed/i);
  });

  it("rejects forged, serialized, cross-lease, and cross-phase confirmations", async () => {
    const snapshot = authoritySnapshot();
    const first = await acquire(snapshot);
    const second = await acquire(snapshot);
    const confirmation = await confirmProbeBrokerExecutionAuthority(first, "effect-committed");
    const serialized = JSON.parse(
      JSON.stringify(confirmation),
    ) as ProbeBrokerExecutionAuthorityConfirmation;

    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(first, serialized, "effect-committed"),
    ).rejects.toThrow(/not minted/i);
    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(second, confirmation, "effect-committed"),
    ).rejects.toThrow(/another lease or phase/i);
    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(first, confirmation, "result-retained"),
    ).rejects.toThrow(/another lease or phase/i);
    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(
        {} as ProbeBrokerExecutionAuthorityLease,
        confirmation,
        "effect-committed",
      ),
    ).rejects.toThrow(/lease is not live/i);
    discardProbeBrokerExecutionAuthorityConfirmation(first, confirmation, "effect-committed");
  });

  it("holds the live source from confirmation mint through confirmation consumption", async () => {
    const sourceRelease = vi.fn();
    const lease = await acquire(authoritySnapshot(), { release: sourceRelease });
    const confirmation = await confirmProbeBrokerExecutionAuthority(lease, "journal-consumption");

    const release = releaseProbeBrokerExecutionAuthorityLease(lease);
    await Promise.resolve();
    expect(sourceRelease).not.toHaveBeenCalled();

    await consumeProbeBrokerExecutionAuthorityConfirmation(
      lease,
      confirmation,
      "journal-consumption",
    );
    await release;
    expect(sourceRelease).toHaveBeenCalledOnce();
  });

  it("cannot release a live authority after effect start until the result is retained", async () => {
    const lease = await acquire();
    const effectStarted = await confirmProbeBrokerExecutionAuthority(lease, "effect-started");
    await consumeProbeBrokerExecutionAuthorityConfirmation(lease, effectStarted, "effect-started");
    markProbeBrokerExecutionAuthorityEffectStarted(lease);

    await expect(releaseProbeBrokerExecutionAuthorityLease(lease)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_INCOMPLETE",
    });
    expect(assertProbeBrokerExecutionAuthorityLease(lease).snapshot).toEqual(authoritySnapshot());

    const resultRetained = await confirmProbeBrokerExecutionAuthority(lease, "result-retained");
    await consumeProbeBrokerExecutionAuthorityConfirmation(
      lease,
      resultRetained,
      "result-retained",
    );
    markProbeBrokerExecutionAuthorityResultRetained(lease);
    await expect(releaseProbeBrokerExecutionAuthorityLease(lease)).resolves.toBeUndefined();
  });

  it("does not let authority drift release a started effect before result retention", async () => {
    let current = authoritySnapshot();
    const sourceRelease = vi.fn();
    const lease = await acquire(current, {
      revalidate: () => current,
      release: sourceRelease,
    });
    markProbeBrokerExecutionAuthorityEffectStarted(lease);
    current = authoritySnapshot({ bootIdSha256: sha256("drift-after-effect-start") });

    await expect(
      confirmProbeBrokerExecutionAuthority(lease, "physical-execution"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
    await expect(releaseProbeBrokerExecutionAuthorityLease(lease)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_INCOMPLETE",
    });
    expect(sourceRelease).not.toHaveBeenCalled();
  });

  it("binds each live lease to exactly one physical operation", async () => {
    const lease = await acquire();
    const firstOperation = authoritySnapshot().physicalOperationKeySha256;
    bindProbeBrokerExecutionAuthorityLeaseToOperation(lease, firstOperation);
    bindProbeBrokerExecutionAuthorityLeaseToOperation(lease, firstOperation);

    markProbeBrokerExecutionAuthorityEffectStarted(lease);
    markProbeBrokerExecutionAuthorityResultRetained(lease);
    expect(() =>
      bindProbeBrokerExecutionAuthorityLeaseToOperation(lease, sha256("second-physical-operation")),
    ).toThrowError(
      expect.objectContaining({ code: "BROKER_EXECUTION_AUTHORITY_OPERATION_BINDING" }),
    );
    await releaseProbeBrokerExecutionAuthorityLease(lease);
  });

  it("does not release when an in-flight release observes a newly incomplete effect", async () => {
    const snapshot = authoritySnapshot();
    let unblockValidation!: () => void;
    let announceValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      announceValidation = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      unblockValidation = resolve;
    });
    let blockOnce = true;
    const lease = await acquire(snapshot, {
      revalidate: async () => {
        if (blockOnce) {
          blockOnce = false;
          announceValidation();
          await validationGate;
        }
        return snapshot;
      },
    });

    const release = releaseProbeBrokerExecutionAuthorityLease(lease);
    await validationStarted;
    markProbeBrokerExecutionAuthorityEffectStarted(lease);
    unblockValidation();
    await expect(release).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_INCOMPLETE",
    });

    markProbeBrokerExecutionAuthorityResultRetained(lease);
    await releaseProbeBrokerExecutionAuthorityLease(lease);
  });

  it("burns a confirmation and invalidates the lease when authority drifts before consumption", async () => {
    let current = authoritySnapshot();
    const lease = await acquire(current, { revalidate: () => current });
    const confirmation = await confirmProbeBrokerExecutionAuthority(lease, "result-validation");
    current = authoritySnapshot({ bootIdSha256: sha256("drift-after-mint") });

    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(lease, confirmation, "result-validation"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
    current = authoritySnapshot();
    await expect(
      consumeProbeBrokerExecutionAuthorityConfirmation(lease, confirmation, "result-validation"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
  });

  it("permanently invalidates drift and revalidation failure", async () => {
    let current = authoritySnapshot();
    const drifted = await acquire(current, { revalidate: () => current });
    current = authoritySnapshot({ bootIdSha256: sha256("another-boot") });
    await expect(
      confirmProbeBrokerExecutionAuthority(drifted, "journal-consumption"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
    current = authoritySnapshot();
    await expect(
      confirmProbeBrokerExecutionAuthority(drifted, "journal-consumption"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });

    let failObservation = true;
    const deadChannel = await acquire(authoritySnapshot(), {
      revalidate: () => {
        if (failObservation) throw new Error("native child exited");
        return authoritySnapshot();
      },
    });
    await expect(
      confirmProbeBrokerExecutionAuthority(deadChannel, "effect-started"),
    ).rejects.toThrow(/native child exited/i);
    failObservation = false;
    await expect(
      confirmProbeBrokerExecutionAuthority(deadChannel, "effect-started"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
  });

  it("owns one-shot source cleanup after success, drift, and release failure", async () => {
    const released = vi.fn();
    const lease = await acquire(authoritySnapshot(), { release: released });
    await releaseProbeBrokerExecutionAuthorityLease(lease);
    expect(released).toHaveBeenCalledOnce();
    expect(() => assertProbeBrokerExecutionAuthorityLease(lease)).toThrow(/released/i);
    await expect(releaseProbeBrokerExecutionAuthorityLease(lease)).rejects.toThrow(/released/i);

    let current = authoritySnapshot();
    const driftRelease = vi.fn();
    const drifted = await acquire(current, {
      revalidate: () => current,
      release: driftRelease,
    });
    current = authoritySnapshot({ mailboxAclSha256: sha256("another-mailbox-acl") });
    await expect(
      confirmProbeBrokerExecutionAuthority(drifted, "result-retained"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_DRIFT" });
    await releaseProbeBrokerExecutionAuthorityLease(drifted);
    expect(driftRelease).toHaveBeenCalledOnce();

    let failRelease = true;
    const releaseFailureSource = vi.fn(() => {
      if (failRelease) throw new Error("channel close failed");
    });
    const releaseFailure = await acquire(authoritySnapshot(), {
      release: releaseFailureSource,
    });
    await expect(releaseProbeBrokerExecutionAuthorityLease(releaseFailure)).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_RELEASE",
    });
    expect(() => assertProbeBrokerExecutionAuthorityLease(releaseFailure)).toThrowError(
      expect.objectContaining({
        code: "BROKER_EXECUTION_AUTHORITY_RELEASE_REQUIRED",
      }),
    );
    await expect(
      confirmProbeBrokerExecutionAuthority(releaseFailure, "release"),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_RELEASE_REQUIRED" });
    failRelease = false;
    await expect(
      releaseProbeBrokerExecutionAuthorityLease(releaseFailure),
    ).resolves.toBeUndefined();
    expect(releaseFailureSource).toHaveBeenCalledTimes(2);
    expect(() => assertProbeBrokerExecutionAuthorityLease(releaseFailure)).toThrow(/released/i);

    const invalidAcquisitionRelease = vi.fn();
    await expect(
      acquireProbeBrokerExecutionAuthorityLease({
        acquire: () => ({ ...authoritySnapshot(), unexpected: true }) as never,
        revalidate: () => authoritySnapshot(),
        release: invalidAcquisitionRelease,
      }),
    ).rejects.toMatchObject({ code: "BROKER_EXECUTION_AUTHORITY_SCHEMA" });
    expect(invalidAcquisitionRelease).toHaveBeenCalledOnce();

    const invalidAcquisitionReleaseFailure = vi.fn(async () => {
      throw new Error("invalid acquisition cleanup failed");
    });
    await expect(
      acquireProbeBrokerExecutionAuthorityLease({
        acquire: () => ({ ...authoritySnapshot(), unexpected: true }) as never,
        revalidate: () => authoritySnapshot(),
        release: invalidAcquisitionReleaseFailure,
      }),
    ).rejects.toMatchObject({
      code: "BROKER_EXECUTION_AUTHORITY_RELEASE",
      requiresProcessExit: true,
    });
    expect(invalidAcquisitionReleaseFailure).toHaveBeenCalledOnce();
  });
});
