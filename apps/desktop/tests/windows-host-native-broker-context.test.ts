import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createProbeBrokerEnrollment,
  createProbePreparedBrokerEnrollment,
} from "../scripts/windows-host-falsifier/broker/mailbox-protocol.mjs";
import {
  NativeClientError,
  createNativeBrokerContextProtocol,
  createNativeBrokerStorageObservationProtocol,
  deriveNativeBrokerContextObservationDigest,
  deriveNativeBrokerContextReceiptDigest,
  validateNativeBrokerContextReceipt,
  type NativeBrokerContextFrame,
  type NativeBrokerContextReceipt,
  type NativeBrokerStorageObservationFrame,
} from "../scripts/windows-host-falsifier/native-client.mjs";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function contextFixture() {
  const facts = {
    mailboxSecurityProfile: "role-separated-immutable-file-mailbox-v1" as const,
    nativeHelperSha256: sha256("helper"),
    mailboxRequestedPathSha256: sha256("E:\\Broker\\floor\\primary"),
    mailboxPathSha256: sha256("mailbox-path"),
    mailboxRootObjectIdentitySha256: sha256("mailbox-object"),
    mailboxVolumeIdSha256: sha256("mailbox-volume"),
    mailboxOwnerSidSha256: sha256("process-sid"),
    mailboxAclSha256: sha256("mailbox-acl"),
    processSidSha256: sha256("process-sid"),
    authenticationLuidSha256: sha256("authentication-luid"),
    bootIdSha256: sha256("boot"),
    runnerSessionIdSha256: sha256("runner-session"),
    mailboxTransportIdentitySha256: sha256("mailbox-transport"),
    mailboxFileSystem: "NTFS" as const,
    mailboxDriveType: "fixed" as const,
    mailboxLocalAbsolute: true as const,
    mailboxNetworkPath: false as const,
    mailboxReparsePoint: false as const,
    journalSecurityProfile: "role-separated-append-only-journal-v1" as const,
    journalRootRequestedPathSha256: sha256("E:\\Broker\\floor\\journal-primary"),
    journalRootPathSha256: sha256("journal-root-path"),
    journalRootObjectIdentitySha256: sha256("journal-root-object"),
    journalVolumeIdSha256: sha256("journal-volume"),
    journalRootOwnerSidSha256: sha256("process-sid"),
    journalRootAclSha256: sha256("journal-root-acl"),
    journalDatabasePathSha256: sha256("journal-database-path"),
    journalDatabaseObjectIdentitySha256: sha256("journal-database-object"),
    journalDatabaseOwnerSidSha256: sha256("process-sid"),
    journalDatabaseAclSha256: sha256("journal-database-acl"),
    journalTransportIdentitySha256: sha256("journal-transport"),
    journalFileSystem: "NTFS" as const,
    journalDriveType: "fixed" as const,
    journalLocalAbsolute: true as const,
    journalNetworkPath: false as const,
    journalReparsePoint: false as const,
    interactiveSessionActive: true as const,
  };
  const digestInput = {
    protocolVersion: 1 as const,
    kind: "windows-host-native-broker-context-acquired" as const,
    sequence: 1,
    challengeSha256: sha256("challenge"),
    previousReceiptSha256: null,
    ...facts,
  };
  const nativeObservationSha256 = deriveNativeBrokerContextObservationDigest(digestInput);
  const enrollment = createProbeBrokerEnrollment({
    environmentId: "win11-floor",
    brokerRole: "primary-standard-user",
    brokerInstanceId: "floor-primary-broker",
    mailboxRoot: "E:\\Broker\\floor\\primary",
    mailboxAclSha256: facts.mailboxAclSha256,
    journalRoot: "E:\\Broker\\floor\\journal-primary",
    journalRootAclSha256: facts.journalRootAclSha256,
    journalDatabaseAclSha256: facts.journalDatabaseAclSha256,
    processSidSha256: facts.processSidSha256,
    peerAuthoritySha256: null,
  });
  const prepared = createProbePreparedBrokerEnrollment(enrollment, {
    schemaVersion: 1,
    kind: "windows-host-probe-broker-mailbox-observation",
    brokerEnrollmentSha256: enrollment.brokerEnrollmentSha256,
    environmentId: enrollment.environmentId,
    brokerRole: enrollment.brokerRole,
    brokerInstanceId: enrollment.brokerInstanceId,
    mailboxRoot: enrollment.mailboxRoot,
    mailboxSecurityProfile: enrollment.mailboxSecurityProfile,
    mailboxAclSha256: enrollment.mailboxAclSha256,
    mailboxOwnerSidSha256: facts.mailboxOwnerSidSha256,
    processSidSha256: enrollment.processSidSha256,
    peerAuthoritySha256: enrollment.peerAuthoritySha256,
    mailboxRootObjectIdentitySha256: facts.mailboxRootObjectIdentitySha256,
    mailboxVolumeIdSha256: facts.mailboxVolumeIdSha256,
    mailboxTransportIdentitySha256: facts.mailboxTransportIdentitySha256,
    mailboxFileSystem: "NTFS",
    mailboxDriveType: "fixed",
    mailboxLocalAbsolute: true,
    mailboxNetworkPath: false,
    mailboxReparsePoint: false,
    journalRoot: enrollment.journalRoot,
    journalSecurityProfile: enrollment.journalSecurityProfile,
    journalRootPathSha256: facts.journalRootPathSha256,
    journalRootObjectIdentitySha256: facts.journalRootObjectIdentitySha256,
    journalVolumeIdSha256: facts.journalVolumeIdSha256,
    journalRootOwnerSidSha256: facts.journalRootOwnerSidSha256,
    journalRootAclSha256: facts.journalRootAclSha256,
    journalDatabasePathSha256: facts.journalDatabasePathSha256,
    journalDatabaseObjectIdentitySha256: facts.journalDatabaseObjectIdentitySha256,
    journalDatabaseOwnerSidSha256: facts.journalDatabaseOwnerSidSha256,
    journalDatabaseAclSha256: facts.journalDatabaseAclSha256,
    journalTransportIdentitySha256: facts.journalTransportIdentitySha256,
    journalFileSystem: "NTFS",
    journalDriveType: "fixed",
    journalLocalAbsolute: true,
    journalNetworkPath: false,
    journalReparsePoint: false,
    bootIdSha256: facts.bootIdSha256,
    runnerSessionIdSha256: facts.runnerSessionIdSha256,
    nativeHelperSha256: facts.nativeHelperSha256,
    nativeObservationSha256,
  });
  return { facts, enrollment, prepared, nativeObservationSha256 };
}

function receiptFor(
  frame: NativeBrokerContextFrame | NativeBrokerStorageObservationFrame,
  facts: ReturnType<typeof contextFixture>["facts"],
  nativeObservationSha256: string,
): NativeBrokerContextReceipt {
  const kind: NativeBrokerContextReceipt["kind"] =
    frame.kind === "observe"
      ? "windows-host-native-broker-storage-observed"
      : frame.kind === "init"
        ? "windows-host-native-broker-context-acquired"
        : frame.kind === "revalidate"
          ? "windows-host-native-broker-context-revalidated"
          : "windows-host-native-broker-context-released";
  const draft = {
    protocolVersion: 1 as const,
    kind,
    sequence: frame.sequence,
    challengeSha256: frame.challengeSha256,
    previousReceiptSha256: frame.previousReceiptSha256,
    ...facts,
    nativeObservationSha256,
  };
  return {
    ...draft,
    receiptSha256: deriveNativeBrokerContextReceiptDigest(draft),
  };
}

function receiptForChangedFacts(
  frame: NativeBrokerContextFrame | NativeBrokerStorageObservationFrame,
  facts: ReturnType<typeof contextFixture>["facts"],
  key:
    | "mailboxRequestedPathSha256"
    | "journalRootRequestedPathSha256"
    | "journalRootAclSha256"
    | "journalDatabaseAclSha256"
    | "journalRootObjectIdentitySha256"
    | "journalDatabaseObjectIdentitySha256",
) {
  const changedFacts = { ...facts, [key]: sha256(`changed-${key}`) };
  const kind: NativeBrokerContextReceipt["kind"] =
    frame.kind === "observe"
      ? "windows-host-native-broker-storage-observed"
      : frame.kind === "init"
        ? "windows-host-native-broker-context-acquired"
        : frame.kind === "revalidate"
          ? "windows-host-native-broker-context-revalidated"
          : "windows-host-native-broker-context-released";
  const observationDraft = {
    protocolVersion: 1 as const,
    kind,
    sequence: frame.sequence,
    challengeSha256: frame.challengeSha256,
    previousReceiptSha256: frame.previousReceiptSha256,
    ...changedFacts,
  };
  const draft = {
    ...observationDraft,
    nativeObservationSha256: deriveNativeBrokerContextObservationDigest(observationDraft),
  };
  return {
    ...draft,
    receiptSha256: deriveNativeBrokerContextReceiptDigest(draft),
  };
}

describe("native broker-context protocol", () => {
  it("bounds one-shot observation without imposing a lifetime on live authority", async () => {
    const source = await readFile(
      new URL("../scripts/windows-host-falsifier/native-client.mjs", import.meta.url),
      "utf8",
    );
    const observationStart = source.indexOf("export async function observeNativeBrokerStorage(");
    const liveStart = source.indexOf("export async function openNativeBrokerContextChannel(");
    const liveEnd = source.indexOf("\nclass NativeTransport", liveStart);

    expect(observationStart).toBeGreaterThanOrEqual(0);
    expect(liveStart).toBeGreaterThan(observationStart);
    expect(liveEnd).toBeGreaterThan(liveStart);

    const observationSource = source.slice(observationStart, liveStart);
    const liveSource = source.slice(liveStart, liveEnd);
    expect(observationSource).toContain("totalTimeoutMs = 120_000");
    expect(observationSource).toContain("totalTimeoutMs,");
    expect(liveSource).not.toContain("totalTimeoutMs");
    expect(liveSource).toContain("requestTimeoutMs = 30_000");
    expect(liveSource).toContain("signal,");
  });

  it("allows only observation mode to create the journal database", async () => {
    const source = await readFile(
      new URL("../scripts/windows-host-falsifier/native/BrokerContext.cs", import.meta.url),
      "utf8",
    );
    const constructorStart = source.indexOf("internal ChannelState(");
    const constructorEnd = source.indexOf(
      "internal Dictionary<string, object> Observed",
      constructorStart,
    );

    expect(constructorStart).toBeGreaterThanOrEqual(0);
    expect(constructorEnd).toBeGreaterThan(constructorStart);

    const constructorSource = source.slice(constructorStart, constructorEnd);
    expect(constructorSource).toContain("bool createJournalDatabaseIfMissing");
    expect(constructorSource).toContain(
      "createJournalDatabaseIfMissing\n                        ? OpenOrCreateJournalDatabase(journalRoot)\n                        : OpenJournalDatabase(journalRoot)",
    );
    expect(source).toContain("challengeSha256,\n                observationOnly))");
    expect(source.match(/OpenOrCreateJournalDatabase\(journalRoot\)/gu)).toHaveLength(1);
  });

  it("performs a single selector-free storage observation before preparation", async () => {
    const { facts, enrollment, nativeObservationSha256 } = contextFixture();
    const frames: NativeBrokerStorageObservationFrame[] = [];
    const protocol = createNativeBrokerStorageObservationProtocol({
      brokerEnrollment: enrollment,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => {
        frames.push(frame);
        return receiptFor(frame, facts, nativeObservationSha256);
      },
      waitForExit: async () => ({ code: 0, signal: null }),
      terminate: async () => undefined,
    });

    const receipt = await protocol.observe();

    expect(receipt.kind).toBe("windows-host-native-broker-storage-observed");
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0]).sort()).toEqual(
      [
        "challengeSha256",
        "expectedJournalDatabaseAclSha256",
        "expectedJournalRootAclSha256",
        "expectedMailboxAclSha256",
        "journalRoot",
        "journalSecurityProfile",
        "kind",
        "mailboxPath",
        "mailboxSecurityProfile",
        "previousReceiptSha256",
        "protocolVersion",
        "sequence",
      ].sort(),
    );
    for (const selector of [
      "brokerRole",
      "brokerInstanceId",
      "controllerIdentitySha256",
      "operationId",
      "coordinate",
      "task",
    ]) {
      expect(frames[0]).not.toHaveProperty(selector);
    }
    await expect(protocol.observe()).rejects.toMatchObject({
      code: "NATIVE_BROKER_STORAGE_STATE",
    });
  });

  it("rejects a native storage receipt bound to another requested path", async () => {
    const { facts, enrollment } = contextFixture();
    const terminate = vi.fn(async () => undefined);
    const protocol = createNativeBrokerStorageObservationProtocol({
      brokerEnrollment: enrollment,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => receiptForChangedFacts(frame, facts, "mailboxRequestedPathSha256"),
      waitForExit: async () => ({ code: 5, signal: null }),
      terminate,
    });

    await expect(protocol.observe()).rejects.toMatchObject({
      code: "NATIVE_BROKER_STORAGE_ENROLLMENT_MISMATCH",
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("requires process exit when native storage termination fails after receipt rejection", async () => {
    const { facts, enrollment } = contextFixture();
    const terminate = vi.fn(async () => {
      throw new Error("synthetic storage termination failure");
    });
    const protocol = createNativeBrokerStorageObservationProtocol({
      brokerEnrollment: enrollment,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => receiptForChangedFacts(frame, facts, "mailboxAclSha256"),
      waitForExit: async () => ({ code: 5, signal: null }),
      terminate,
    });

    await expect(protocol.observe()).rejects.toMatchObject({
      code: "NATIVE_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("chains fresh selector-free init, revalidation, and release frames", async () => {
    const { facts, prepared, nativeObservationSha256 } = contextFixture();
    const frames: NativeBrokerContextFrame[] = [];
    let open = true;
    const protocol = createNativeBrokerContextProtocol({
      preparedMailboxBinding: prepared,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => {
        frames.push(frame);
        return receiptFor(frame, facts, nativeObservationSha256);
      },
      waitForExit: async () => ({ code: 0, signal: null }),
      terminate: async () => {
        open = false;
      },
      isOpen: () => open,
    });

    const acquired = await protocol.acquire();
    const revalidated = await protocol.revalidate();
    const released = await protocol.release();

    expect(acquired.kind).toBe("windows-host-native-broker-context-acquired");
    expect(revalidated.previousReceiptSha256).toBe(acquired.receiptSha256);
    expect(released.receipt.previousReceiptSha256).toBe(revalidated.receiptSha256);
    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2, 3]);
    expect(new Set(frames.map((frame) => frame.challengeSha256)).size).toBe(3);
    expect(Object.keys(frames[0]).sort()).toEqual(
      [
        "challengeSha256",
        "expectedMailboxAclSha256",
        "expectedJournalDatabaseAclSha256",
        "expectedJournalRootAclSha256",
        "journalRoot",
        "journalSecurityProfile",
        "kind",
        "mailboxPath",
        "mailboxSecurityProfile",
        "previousReceiptSha256",
        "protocolVersion",
        "sequence",
      ].sort(),
    );
    for (const frame of frames) {
      expect(frame).not.toHaveProperty("brokerRole");
      expect(frame).not.toHaveProperty("brokerInstanceId");
      expect(frame).not.toHaveProperty("brokerEnrollmentSha256");
      expect(frame).not.toHaveProperty("task");
    }
    expect(protocol.isLive()).toBe(false);
    await expect(protocol.revalidate()).rejects.toMatchObject({
      code: "NATIVE_BROKER_CONTEXT_CLOSED",
    });
  });

  it("rejects receipt substitution and terminates the channel", async () => {
    const { facts, prepared, nativeObservationSha256 } = contextFixture();
    const terminate = vi.fn(async () => undefined);
    const protocol = createNativeBrokerContextProtocol({
      preparedMailboxBinding: prepared,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => {
        const receipt = receiptFor(frame, facts, nativeObservationSha256);
        const substituted = {
          ...receipt,
          challengeSha256: sha256("substituted-challenge"),
        };
        return {
          ...substituted,
          receiptSha256: deriveNativeBrokerContextReceiptDigest(substituted),
        };
      },
      waitForExit: async () => ({ code: 5, signal: null }),
      terminate,
      isOpen: () => true,
    });

    await expect(protocol.acquire()).rejects.toMatchObject({
      code: "NATIVE_BROKER_CONTEXT_CHAIN",
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("requires process exit when native context termination fails after receipt rejection", async () => {
    const { facts, prepared, nativeObservationSha256 } = contextFixture();
    const terminate = vi.fn(async () => {
      throw new Error("synthetic context termination failure");
    });
    const protocol = createNativeBrokerContextProtocol({
      preparedMailboxBinding: prepared,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => {
        const receipt = receiptFor(frame, facts, nativeObservationSha256);
        return { ...receipt, receiptSha256: sha256("invalid-receipt-digest") };
      },
      waitForExit: async () => ({ code: 5, signal: null }),
      terminate,
      isOpen: () => true,
    });

    await expect(protocol.acquire()).rejects.toMatchObject({
      code: "NATIVE_PROCESS_EXIT_REQUIRED",
      requiresProcessExit: true,
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it.each([
    "mailboxRequestedPathSha256",
    "journalRootRequestedPathSha256",
    "journalRootAclSha256",
    "journalDatabaseAclSha256",
    "journalRootObjectIdentitySha256",
    "journalDatabaseObjectIdentitySha256",
  ] as const)("distinguishes pinned journal drift in %s", async (field) => {
    const { facts, prepared } = contextFixture();
    const terminate = vi.fn(async () => undefined);
    const protocol = createNativeBrokerContextProtocol({
      preparedMailboxBinding: prepared,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => receiptForChangedFacts(frame, facts, field),
      waitForExit: async () => ({ code: 5, signal: null }),
      terminate,
      isOpen: () => true,
    });

    await expect(protocol.acquire()).rejects.toMatchObject({
      code: "NATIVE_BROKER_CONTEXT_PREPARED_MISMATCH",
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("invalidates authority as soon as the child transport is no longer open", async () => {
    const { facts, prepared, nativeObservationSha256 } = contextFixture();
    let open = true;
    const protocol = createNativeBrokerContextProtocol({
      preparedMailboxBinding: prepared,
      nativeHelperSha256: facts.nativeHelperSha256,
      exchange: async (frame) => receiptFor(frame, facts, nativeObservationSha256),
      waitForExit: async () => ({ code: 5, signal: null }),
      terminate: async () => undefined,
      isOpen: () => open,
    });
    await protocol.acquire();
    open = false;

    expect(protocol.isLive()).toBe(false);
    await expect(protocol.revalidate()).rejects.toMatchObject({
      code: "NATIVE_BROKER_CONTEXT_CLOSED",
    });
  });

  it("validates observation and receipt digests before prepared binding checks", () => {
    const { facts, nativeObservationSha256 } = contextFixture();
    const frame: NativeBrokerContextFrame = {
      protocolVersion: 1,
      kind: "init",
      sequence: 1,
      challengeSha256: sha256("validation-challenge"),
      previousReceiptSha256: null,
      mailboxPath: "E:\\Broker\\floor\\primary",
      mailboxSecurityProfile: "role-separated-immutable-file-mailbox-v1",
      expectedMailboxAclSha256: facts.mailboxAclSha256,
      journalRoot: "E:\\Broker\\floor\\journal-primary",
      journalSecurityProfile: "role-separated-append-only-journal-v1",
      expectedJournalRootAclSha256: facts.journalRootAclSha256,
      expectedJournalDatabaseAclSha256: facts.journalDatabaseAclSha256,
    };
    const receipt = receiptFor(frame, facts, nativeObservationSha256);
    expect(validateNativeBrokerContextReceipt(receipt)).toEqual(receipt);
    expect(() =>
      validateNativeBrokerContextReceipt({
        ...receipt,
        authenticationLuidSha256: sha256("changed-authentication-luid"),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<NativeClientError>>({
        code: "NATIVE_BROKER_CONTEXT_OBSERVATION_DIGEST",
      }),
    );
  });
});
