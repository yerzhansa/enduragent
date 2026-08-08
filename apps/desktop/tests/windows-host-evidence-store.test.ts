import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendContinuation,
  closeContinuation,
  consumeContinuationReceipt,
  initializeContinuation,
  loadContinuation,
} from "../scripts/windows-host-falsifier/continuation.mjs";
import {
  hashEvidenceValue,
  openEvidenceStore,
  sealEvidenceTree,
  validateEvidenceRelativePath,
} from "../scripts/windows-host-falsifier/evidence-store.mjs";
import {
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  deriveExternalCheckpointReceiptDigest,
  deriveExternalCheckpointRequestDigest,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import type {
  ProbeExternalCheckpointEvidence,
  ProbeLabAttestation,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";

const candidateSha256 = "a".repeat(64);
const sentinel = "ENDURAGENT-FALSIFIER-TEST-SENTINEL";
const fixedTimes = [
  "2026-08-06T00:00:00.000Z",
  "2026-08-06T00:00:01.000Z",
  "2026-08-06T00:00:02.000Z",
];
const receiptRecoveryBoundaries = [
  "transaction",
  "nonce-index",
  "request-index",
  "receipt-index",
  "closure",
].map((boundary, index) => ({ boundary, index }));
const { privateKey: controllerPrivateKey, publicKey: controllerPublicKey } =
  generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerPublicKey.export({ format: "der", type: "spki" });
const controllerPublicKeySha256 = createHash("sha256")
  .update(controllerPublicKeyBytes)
  .digest("hex");
const expectedController: ProbeLabAttestation["controller"] = {
  identitySha256: "8".repeat(64),
  publicKeySha256: controllerPublicKeySha256,
  publicKeyArtifact: {
    path: "attestations/controller-public-key.der",
    sha256: controllerPublicKeySha256,
  },
  version: "1.2.3",
};

function publicationTempPath(rootPath: string, relativePath: string, value: Uint8Array | string) {
  const bytes = Buffer.from(value);
  const pathSha256 = createHash("sha256").update(relativePath, "utf8").digest("hex");
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const segments = relativePath.split("/");
  segments.pop();
  return join(rootPath, ...segments, `.enduragent-publication-${pathSha256}-${contentSha256}.tmp`);
}

function continuationScope(
  overrides: Partial<Parameters<typeof initializeContinuation>[0]["scope"]> = {},
) {
  return {
    campaignId: "f01-f10-native-probe-v1" as const,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256,
    labAttestationSha256: "b".repeat(64),
    campaignRunId: "campaign-one",
    executionRunId: "execution-floor",
    executionBundleId: "bundle-floor",
    executionBundleManifestSha256: "c".repeat(64),
    environmentId: "win11-floor",
    pathProfileId: "ascii",
    rowId: "F-01",
    variantId: "f01-ordinary-absolute-path",
    attemptId: "attempt-one",
    vmSnapshotId: "floor-clean-snapshot",
    repetition: 1,
    chainId: "floor-ascii-f01-ordinary-one",
    ...overrides,
  };
}

function signedCheckpointEvidence(
  header: Awaited<ReturnType<typeof initializeContinuation>>,
  nonceSha256 = hashEvidenceValue("test-checkpoint-nonce", {
    chainId: header.chainId,
  }),
): ProbeExternalCheckpointEvidence {
  const requestDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-hard-cut-request" as const,
    campaignId: header.campaignId,
    manifestSha256: header.manifestSha256,
    candidateSha256: header.candidateSha256,
    campaignRunId: header.campaignRunId,
    executionRunId: header.executionRunId,
    executionBundleId: header.executionBundleId,
    executionBundleManifestSha256: header.executionBundleManifestSha256,
    attemptId: header.attemptId,
    environmentId: header.environmentId as "win11-floor",
    pathProfileId: header.pathProfileId as "ascii",
    rowId: header.rowId,
    variantId: header.variantId,
    checkpointId: `checkpoint-${header.repetition}`,
    sequence: header.repetition,
    nonceSha256,
    preCutStateSha256: hashEvidenceValue("test-pre-cut", { chainId: header.chainId }),
    preCutBootIdSha256: "7".repeat(64),
    sourceVmSnapshotId: header.vmSnapshotId,
    continuationScopeSha256: header.scopeSha256,
    controllerIdentitySha256: expectedController.identitySha256,
    controllerPublicKeySha256: expectedController.publicKeySha256,
    controllerVersion: expectedController.version,
    action: "hard-power-cut" as const,
    signatureAlgorithm: "Ed25519" as const,
  };
  const requestSha256 = deriveExternalCheckpointRequestDigest(requestDraft);
  const request = {
    ...requestDraft,
    signatureBase64: sign(null, Buffer.from(requestSha256, "hex"), controllerPrivateKey).toString(
      "base64",
    ),
    requestSha256,
  };
  const receiptDraft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-hard-cut-receipt" as const,
    requestSha256: request.requestSha256,
    controllerIdentitySha256: expectedController.identitySha256,
    controllerPublicKeySha256: expectedController.publicKeySha256,
    controllerVersion: expectedController.version,
    action: "hard-power-cut" as const,
    powerCutAt: "2026-08-06T00:00:01.000Z",
    bootStartedAt: "2026-08-06T00:00:02.000Z",
    bootCompletedAt: "2026-08-06T00:00:03.000Z",
    postBootVmSnapshotId: header.vmSnapshotId,
    preCutBootIdSha256: request.preCutBootIdSha256,
    postBootBootIdSha256: "d".repeat(64),
    artifactHashes: [{ path: `checkpoints/${header.chainId}.json`, sha256: "e".repeat(64) }],
    signatureAlgorithm: "Ed25519" as const,
  };
  const receiptSha256 = deriveExternalCheckpointReceiptDigest(receiptDraft);
  return {
    request,
    receipt: {
      ...receiptDraft,
      signatureBase64: sign(null, Buffer.from(receiptSha256, "hex"), controllerPrivateKey).toString(
        "base64",
      ),
      receiptSha256,
    },
  };
}

describe("Windows host falsifier evidence store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "enduragent-evidence-store-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("retains append-only canonical evidence and recomputes declared hashes", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");
    const first = await store.writeCanonicalJson("segments/first.json", {
      kind: "synthetic-evidence",
      value: 1,
    });
    const second = await store.writeBytes("segments/raw.txt", "synthetic observation\n");

    await expect(store.verifyArtifactSet([first, second])).resolves.toEqual([first, second]);
    await expect(store.writeBytes("segments/raw.txt", "replacement")).rejects.toMatchObject({
      code: "EEXIST",
    });
    const scan = await store.scan();
    expect(scan.files).toBe(2);
    expect(scan.artifacts.map((artifact) => artifact.path)).toEqual([
      "segments/first.json",
      "segments/raw.txt",
    ]);
    const seal = await sealEvidenceTree(store);
    expect(seal.files).toBe(2);
    expect(seal.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps a partial staging write invisible and recovers its exact prefix", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");
    const relativePath = "segments/crash-safe.txt";
    const complete = Buffer.from("complete retained evidence\n", "utf8");
    const stagingPath = publicationTempPath(root, relativePath, complete);
    await writeFile(stagingPath, complete.subarray(0, 9), { mode: 0o600 });

    await expect(store.list("segments")).resolves.toEqual([]);
    await expect(store.scan()).rejects.toMatchObject({
      code: "EVIDENCE_PUBLICATION_INCOMPLETE",
    });
    await expect(store.readArtifact(relativePath)).rejects.toMatchObject({ code: "ENOENT" });

    const retained = await store.writeBytes(relativePath, complete);
    expect(retained.sha256).toBe(createHash("sha256").update(complete).digest("hex"));
    await expect(store.readArtifact(relativePath)).resolves.toMatchObject({ bytes: complete });
    await expect(lstat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(root, "segments", "crash-safe.txt"))).nlink).toBe(1);
  });

  it("recovers fully synced and post-link publication crash states", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");

    const stagedPath = "segments/staged.txt";
    const stagedBytes = Buffer.from("fully synced staging leaf", "utf8");
    const stagedTemp = publicationTempPath(root, stagedPath, stagedBytes);
    await writeFile(stagedTemp, stagedBytes, { mode: 0o600 });
    await expect(store.writeBytes(stagedPath, stagedBytes)).resolves.toMatchObject({
      path: stagedPath,
    });
    await expect(lstat(stagedTemp)).rejects.toMatchObject({ code: "ENOENT" });

    const linkedPath = "segments/linked.txt";
    const linkedBytes = Buffer.from("complete before the atomic link", "utf8");
    const linkedTemp = publicationTempPath(root, linkedPath, linkedBytes);
    const linkedFinal = join(root, "segments", "linked.txt");
    await writeFile(linkedTemp, linkedBytes, { mode: 0o600 });
    await link(linkedTemp, linkedFinal);
    expect((await lstat(linkedFinal)).nlink).toBe(2);

    await expect(store.writeBytes(linkedPath, linkedBytes)).resolves.toMatchObject({
      path: linkedPath,
    });
    await expect(lstat(linkedTemp)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(linkedFinal)).nlink).toBe(1);
    await expect(store.readArtifact(linkedPath)).resolves.toMatchObject({ bytes: linkedBytes });
  });

  it("rejects corrupt or ambiguously linked staging leaves without publishing them", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");

    const corruptPath = "segments/corrupt.txt";
    const expected = Buffer.from("expected complete content", "utf8");
    const corruptTemp = publicationTempPath(root, corruptPath, expected);
    await writeFile(corruptTemp, "not-an-expected-prefix", { mode: 0o600 });
    await expect(store.writeBytes(corruptPath, expected)).rejects.toMatchObject({
      code: "EVIDENCE_PUBLICATION_COLLISION",
    });
    await expect(lstat(join(root, "segments", "corrupt.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const ambiguousPath = "segments/ambiguous.txt";
    const ambiguous = Buffer.from("fully staged but linked elsewhere", "utf8");
    const ambiguousTemp = publicationTempPath(root, ambiguousPath, ambiguous);
    await writeFile(ambiguousTemp, ambiguous, { mode: 0o600 });
    await link(ambiguousTemp, join(root, "segments", "unrelated-alias.txt"));
    await expect(store.writeBytes(ambiguousPath, ambiguous)).rejects.toMatchObject({
      code: "EVIDENCE_PUBLICATION_STATE",
    });
    await expect(lstat(join(root, "segments", "ambiguous.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes competing writers and atomically preserves the first complete artifact", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");
    const [winner, loser] = await Promise.allSettled([
      store.writeBytes("segments/race.txt", "first complete value"),
      store.writeBytes("segments/race.txt", "second complete value"),
    ]);

    expect(winner.status).toBe("fulfilled");
    expect(loser).toMatchObject({ status: "rejected", reason: { code: "EEXIST" } });
    const retained = await store.readArtifact("segments/race.txt");
    expect(retained.bytes.toString("utf8")).toBe("first complete value");
    expect((await lstat(join(root, "segments", "race.txt"))).nlink).toBe(1);
    expect(
      (await readdir(join(root, "segments"))).some((name) =>
        name.startsWith(".enduragent-publication-"),
      ),
    ).toBe(false);
  });

  it("uses no-replace publication across independent store instances", async () => {
    const firstStore = await openEvidenceStore({ root, sentinel });
    await firstStore.createDirectory("segments");
    const secondStore = await openEvidenceStore({ root, sentinel });
    const results = await Promise.allSettled([
      firstStore.writeBytes("segments/cross-store-race.txt", "first complete contender"),
      secondStore.writeBytes("segments/cross-store-race.txt", "second complete contender"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const retained = await firstStore.readArtifact("segments/cross-store-race.txt");
    expect(["first complete contender", "second complete contender"]).toContain(
      retained.bytes.toString("utf8"),
    );
    expect((await lstat(join(root, "segments", "cross-store-race.txt"))).nlink).toBe(1);
    expect(
      (await readdir(join(root, "segments"))).some((name) =>
        name.startsWith(".enduragent-publication-"),
      ),
    ).toBe(false);
  });

  it("rejects traversal, Windows aliases, sentinel retention, and dishonest declarations", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");
    expect(() => validateEvidenceRelativePath("../outside.txt")).toThrow(/unsafe/u);
    expect(() => validateEvidenceRelativePath("C:\\outside.txt")).toThrow(/relative/u);
    expect(() => validateEvidenceRelativePath("segments/CON.txt")).toThrow(/unsafe/u);
    expect(() =>
      validateEvidenceRelativePath(`segments/.enduragent-publication-${"a".repeat(64)}.tmp`),
    ).toThrow(/unsafe/u);
    await expect(store.writeBytes("segments/leak.txt", `value=${sentinel}`)).rejects.toMatchObject({
      code: "EVIDENCE_SENTINEL",
    });
    await expect(
      store.writeBytes("segments/leak-utf16.txt", Buffer.from(sentinel, "utf16le")),
    ).rejects.toMatchObject({ code: "EVIDENCE_SENTINEL" });
    await expect(
      store.writeBytes(
        "segments/leak-base64.txt",
        Buffer.from(sentinel, "utf8").toString("base64"),
      ),
    ).rejects.toMatchObject({ code: "EVIDENCE_SENTINEL" });
    const artifact = await store.writeBytes("segments/value.txt", "safe");
    await expect(
      store.verifyArtifactSet([{ path: artifact.path, sha256: "b".repeat(64) }]),
    ).rejects.toMatchObject({ code: "EVIDENCE_HASH" });
  });

  it("allows a Unicode evidence root but requires printable ASCII artifact components", async () => {
    const unicodeRoot = join(root, "retained-évidence");
    await mkdir(unicodeRoot);
    const store = await openEvidenceStore({ root: unicodeRoot, sentinel });
    await store.createDirectory("segments");
    await expect(store.writeBytes("segments/value.txt", "safe")).resolves.toMatchObject({
      path: "segments/value.txt",
    });
    expect(() => validateEvidenceRelativePath("segments/İ-value.txt")).toThrowError(
      expect.objectContaining({ code: "EVIDENCE_PATH" }),
    );
    await expect(store.writeBytes("segments/é-value.txt", "unsafe")).rejects.toMatchObject({
      code: "EVIDENCE_PATH",
    });
  });

  it("rejects retained artifacts with more than one filesystem link", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");
    await store.writeBytes("segments/value.txt", "safe");
    await link(join(root, "segments", "value.txt"), join(root, "segments", "alias.txt"));

    await expect(store.readArtifact("segments/value.txt")).rejects.toMatchObject({
      code: "EVIDENCE_HARD_LINK",
    });
    await expect(store.scan()).rejects.toMatchObject({ code: "EVIDENCE_HARD_LINK" });
  });

  it("refuses a linked ancestor instead of following it outside the owned root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "enduragent-evidence-outside-"));
    try {
      try {
        await symlink(
          outside,
          join(root, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EPERM") return;
        throw error;
      }
      const store = await openEvidenceStore({ root, sentinel });
      await expect(store.writeBytes("linked/escape.txt", "unsafe")).rejects.toMatchObject({
        code: "EVIDENCE_REPARSE",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("detects retained artifact mutation rather than trusting its declared digest", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    await store.createDirectory("segments");
    const artifact = await store.writeBytes("segments/value.txt", "original");
    await writeFile(join(root, "segments", "value.txt"), "mutated", "utf8");
    await expect(store.verifyArtifactSet([artifact])).rejects.toMatchObject({
      code: "EVIDENCE_HASH",
    });
  });

  it("enforces a self-hashed append-only continuation and survives reload", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    const now = () => new Date(fixedTimes.shift() ?? "2026-08-06T00:00:03.000Z");
    const header = await initializeContinuation({
      store,
      scope: continuationScope(),
      now,
    });
    expect(header.headerSha256).toMatch(/^[a-f0-9]{64}$/u);
    const first = await appendContinuation({
      store,
      chainId: header.chainId,
      operationId: "prepare-checkpoint",
      payload: { checkpoint: "prepared", stateSha256: "c".repeat(64) },
      now,
    });
    const second = await appendContinuation({
      store,
      chainId: header.chainId,
      operationId: "recover-checkpoint",
      payload: { checkpoint: "recovered", stateSha256: "d".repeat(64) },
      now,
    });
    expect(first.sequence).toBe(1);
    expect(second.previousEntrySha256).toBe(first.entrySha256);
    const resumed = await loadContinuation({ store, chainId: header.chainId });
    expect(resumed.nextSequence).toBe(3);
    expect(resumed.previousEntrySha256).toBe(second.entrySha256);
    await expect(
      appendContinuation({
        store,
        chainId: header.chainId,
        operationId: "forbidden-authority",
        payload: { outcome: "PASS" },
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_TRUST" });
    const reference = await closeContinuation({ store, chainId: header.chainId, now });
    expect(reference).toMatchObject({
      chainId: header.chainId,
      scopeSha256: header.scopeSha256,
      headerSha256: header.headerSha256,
      terminalEntrySha256: second.entrySha256,
    });
    const closed = await loadContinuation({ store, chainId: header.chainId });
    expect(closed.closure).toMatchObject({
      kind: "windows-host-probe-local-continuation-receipt",
      receiptSha256: reference.receiptSha256,
    });
    await expect(
      appendContinuation({
        store,
        chainId: header.chainId,
        operationId: "late-write",
        payload: { checkpoint: "late-write" },
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_CLOSED" });
  });

  it("recovers partial and complete continuation initialization by exact scope", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    const scope = continuationScope({ chainId: "floor-ascii-initialize-recovery" });
    await store.createDirectory("continuations");
    await store.createDirectory("continuations/chains");
    await store.createDirectory(`continuations/chains/${scope.chainId}`);
    await store.createDirectory(`continuations/chains/${scope.chainId}/entries`);

    const initialized = await initializeContinuation({
      store,
      scope,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    const replayed = await initializeContinuation({
      store,
      scope,
      now: () => new Date("2026-08-06T00:00:09.000Z"),
    });
    expect(replayed).toEqual(initialized);

    await expect(
      initializeContinuation({
        store,
        scope: { ...scope, vmSnapshotId: "another-floor-snapshot" },
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_SCOPE_COLLISION" });

    const crashScope = continuationScope({ chainId: "floor-ascii-initialize-post-write" });
    let crashed = false;
    const crashingStore = {
      ...store,
      async writeCanonicalJson(relativePath: string, value: Readonly<Record<string, unknown>>) {
        const artifact = await store.writeCanonicalJson(relativePath, value);
        if (!crashed && relativePath.endsWith(`/${crashScope.chainId}/header.json`)) {
          crashed = true;
          throw Object.assign(new Error("simulated initialization crash"), {
            code: "SIMULATED_CRASH",
          });
        }
        return artifact;
      },
    };
    await expect(
      initializeContinuation({
        store: crashingStore,
        scope: crashScope,
        now: () => new Date("2026-08-06T00:00:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SIMULATED_CRASH" });
    const recovered = await initializeContinuation({
      store,
      scope: crashScope,
      now: () => new Date("2026-08-06T00:00:09.000Z"),
    });
    expect(recovered.createdAt).toBe("2026-08-06T00:00:01.000Z");
  });

  it("recovers append and local close after durable-write crashes", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    const header = await initializeContinuation({
      store,
      scope: continuationScope({ chainId: "floor-ascii-operation-recovery" }),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    let appendCrashed = false;
    const crashingAppendStore = {
      ...store,
      async writeCanonicalJson(relativePath: string, value: Readonly<Record<string, unknown>>) {
        const artifact = await store.writeCanonicalJson(relativePath, value);
        if (!appendCrashed && relativePath.endsWith("/entries/00000001.json")) {
          appendCrashed = true;
          throw Object.assign(new Error("simulated append crash"), { code: "SIMULATED_CRASH" });
        }
        return artifact;
      },
    };
    const payload = { checkpoint: "prepared", stateSha256: "c".repeat(64) };
    await expect(
      appendContinuation({
        store: crashingAppendStore,
        chainId: header.chainId,
        operationId: "prepare-checkpoint",
        payload,
        now: () => new Date("2026-08-06T00:00:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SIMULATED_CRASH" });
    const recoveredEntry = await appendContinuation({
      store,
      chainId: header.chainId,
      operationId: "prepare-checkpoint",
      payload,
      now: () => new Date("2026-08-06T00:00:09.000Z"),
    });
    expect(recoveredEntry.createdAt).toBe("2026-08-06T00:00:01.000Z");
    await expect(
      appendContinuation({
        store,
        chainId: header.chainId,
        operationId: "prepare-checkpoint",
        payload: { ...payload, stateSha256: "d".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_OPERATION_COLLISION" });

    let closeCrashed = false;
    const crashingCloseStore = {
      ...store,
      async writeCanonicalJson(relativePath: string, value: Readonly<Record<string, unknown>>) {
        const artifact = await store.writeCanonicalJson(relativePath, value);
        if (!closeCrashed && relativePath.endsWith("/receipts/local.json")) {
          closeCrashed = true;
          throw Object.assign(new Error("simulated close crash"), { code: "SIMULATED_CRASH" });
        }
        return artifact;
      },
    };
    await expect(
      closeContinuation({
        store: crashingCloseStore,
        chainId: header.chainId,
        now: () => new Date("2026-08-06T00:00:02.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SIMULATED_CRASH" });
    const recoveredClose = await closeContinuation({
      store,
      chainId: header.chainId,
      now: () => new Date("2026-08-06T00:00:10.000Z"),
    });
    await expect(closeContinuation({ store, chainId: header.chainId })).resolves.toEqual(
      recoveredClose,
    );
    await expect(
      appendContinuation({
        store,
        chainId: header.chainId,
        operationId: "prepare-checkpoint",
        payload,
      }),
    ).resolves.toEqual(recoveredEntry);
  });

  it("retains signed external receipts and rejects signature or campaign-wide replay", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    const header = await initializeContinuation({
      store,
      scope: continuationScope({
        rowId: "F-07",
        variantId: "f07-hard-cut-after-file-flush",
        chainId: "floor-ascii-f07-hard-cut-one",
      }),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    await appendContinuation({
      store,
      chainId: header.chainId,
      operationId: "pre-cut",
      payload: { checkpoint: "pre-cut", stateSha256: "f".repeat(64) },
      now: () => new Date("2026-08-06T00:00:00.500Z"),
    });
    const checkpointEvidence = signedCheckpointEvidence(header);
    const forged = {
      ...checkpointEvidence,
      receipt: {
        ...checkpointEvidence.receipt,
        signatureBase64: Buffer.alloc(64).toString("base64"),
      },
    };
    await expect(
      consumeContinuationReceipt({
        store,
        chainId: header.chainId,
        checkpointEvidence: forged,
        expectedController,
        controllerPublicKeyBytes,
        now: () => new Date("2026-08-06T00:00:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_RECEIPT" });
    const consumed = await consumeContinuationReceipt({
      store,
      chainId: header.chainId,
      checkpointEvidence,
      expectedController,
      controllerPublicKeyBytes,
      now: () => new Date("2026-08-06T00:00:01.000Z"),
    });
    expect(consumed.continuation).toMatchObject({
      chainId: header.chainId,
      receiptSha256: checkpointEvidence.receipt.receiptSha256,
    });
    const closed = await loadContinuation({ store, chainId: header.chainId });
    expect(closed.closure).toMatchObject({
      kind: "windows-host-probe-consumed-external-receipt",
      checkpointEvidence,
    });

    const secondHeader = await initializeContinuation({
      store,
      scope: continuationScope({
        rowId: "F-07",
        variantId: "f07-hard-cut-after-file-flush",
        repetition: 2,
        chainId: "floor-ascii-f07-hard-cut-two",
      }),
      now: () => new Date("2026-08-06T00:00:02.000Z"),
    });
    await appendContinuation({
      store,
      chainId: secondHeader.chainId,
      operationId: "pre-cut",
      payload: { checkpoint: "pre-cut", stateSha256: "a".repeat(64) },
      now: () => new Date("2026-08-06T00:00:02.500Z"),
    });
    const replayedNonce = signedCheckpointEvidence(
      secondHeader,
      checkpointEvidence.request.nonceSha256,
    );
    await expect(
      consumeContinuationReceipt({
        store,
        chainId: secondHeader.chainId,
        checkpointEvidence: replayedNonce,
        expectedController,
        controllerPublicKeyBytes,
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_RECEIPT" });
  });

  it.each(receiptRecoveryBoundaries)(
    "recovers exact external-receipt consumption after the $boundary durable write boundary",
    async ({ boundary, index }) => {
      const caseRoot = await mkdtemp(join(root, `receipt-recovery-${index}-`));
      const store = await openEvidenceStore({ root: caseRoot, sentinel });
      const chainId = `floor-ascii-f07-recovery-${index + 1}`;
      const header = await initializeContinuation({
        store,
        scope: continuationScope({
          rowId: "F-07",
          variantId: "f07-hard-cut-after-file-flush",
          repetition: index + 1,
          chainId,
        }),
        now: () => new Date("2026-08-06T00:00:00.000Z"),
      });
      await appendContinuation({
        store,
        chainId,
        operationId: "pre-cut",
        payload: { checkpoint: "pre-cut", stateSha256: "f".repeat(64) },
        now: () => new Date("2026-08-06T00:00:00.500Z"),
      });
      const checkpointEvidence = signedCheckpointEvidence(header);
      const writePaths = {
        transaction: `continuations/receipt-transactions/${chainId}.json`,
        "nonce-index": `continuations/receipt-index/nonces/${checkpointEvidence.request.nonceSha256}.json`,
        "request-index": `continuations/receipt-index/requests/${checkpointEvidence.request.requestSha256}.json`,
        "receipt-index": `continuations/receipt-index/receipts/${checkpointEvidence.receipt.receiptSha256}.json`,
        closure: `continuations/chains/${chainId}/receipts/external.json`,
      } as const;
      let injected = false;
      const crashingStore = {
        ...store,
        async writeCanonicalJson(relativePath: string, value: Readonly<Record<string, unknown>>) {
          const artifact = await store.writeCanonicalJson(relativePath, value);
          if (!injected && relativePath === writePaths[boundary as keyof typeof writePaths]) {
            injected = true;
            throw Object.assign(new Error(`simulated crash after ${boundary}`), {
              code: "SIMULATED_CRASH",
            });
          }
          return artifact;
        },
      };
      await expect(
        consumeContinuationReceipt({
          store: crashingStore,
          chainId,
          checkpointEvidence,
          expectedController,
          controllerPublicKeyBytes,
          now: () => new Date("2026-08-06T00:00:01.000Z"),
        }),
      ).rejects.toMatchObject({ code: "SIMULATED_CRASH" });
      expect(injected).toBe(true);

      const recovered = await consumeContinuationReceipt({
        store,
        chainId,
        checkpointEvidence,
        expectedController,
        controllerPublicKeyBytes,
        now: () => new Date("2026-08-06T00:00:09.000Z"),
      });
      const repeated = await consumeContinuationReceipt({
        store,
        chainId,
        checkpointEvidence,
        expectedController,
        controllerPublicKeyBytes,
        now: () => new Date("2026-08-06T00:00:10.000Z"),
      });
      expect(repeated).toEqual(recovered);
      const closed = await loadContinuation({ store, chainId });
      expect(closed.closure).toMatchObject({
        kind: "windows-host-probe-consumed-external-receipt",
        checkpointEvidence,
        consumedAt: "2026-08-06T00:00:01.000Z",
      });
    },
  );

  it("rejects a different external receipt after a durable transaction claim", async () => {
    const store = await openEvidenceStore({ root, sentinel });
    const chainId = "floor-ascii-f07-transaction-collision";
    const header = await initializeContinuation({
      store,
      scope: continuationScope({
        rowId: "F-07",
        variantId: "f07-hard-cut-after-file-flush",
        chainId,
      }),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    await appendContinuation({
      store,
      chainId,
      operationId: "pre-cut",
      payload: { checkpoint: "pre-cut", stateSha256: "f".repeat(64) },
      now: () => new Date("2026-08-06T00:00:00.500Z"),
    });
    const originalEvidence = signedCheckpointEvidence(header);
    let injected = false;
    const crashingStore = {
      ...store,
      async writeCanonicalJson(relativePath: string, value: Readonly<Record<string, unknown>>) {
        const artifact = await store.writeCanonicalJson(relativePath, value);
        if (!injected && relativePath === `continuations/receipt-transactions/${chainId}.json`) {
          injected = true;
          throw Object.assign(new Error("simulated crash after transaction"), {
            code: "SIMULATED_CRASH",
          });
        }
        return artifact;
      },
    };
    await expect(
      consumeContinuationReceipt({
        store: crashingStore,
        chainId,
        checkpointEvidence: originalEvidence,
        expectedController,
        controllerPublicKeyBytes,
        now: () => new Date("2026-08-06T00:00:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SIMULATED_CRASH" });

    const differentEvidence = signedCheckpointEvidence(
      header,
      hashEvidenceValue("test-checkpoint-nonce", { chainId, collision: true }),
    );
    await expect(
      consumeContinuationReceipt({
        store,
        chainId,
        checkpointEvidence: differentEvidence,
        expectedController,
        controllerPublicKeyBytes,
      }),
    ).rejects.toMatchObject({ code: "CONTINUATION_RECEIPT_REPLAY" });
    await expect(
      consumeContinuationReceipt({
        store,
        chainId,
        checkpointEvidence: originalEvidence,
        expectedController,
        controllerPublicKeyBytes,
      }),
    ).resolves.toMatchObject({ checkpointEvidence: originalEvidence });
  });

  it("rejects conflicting nonce, request, and receipt index owners", async () => {
    for (const [index, category] of ["nonces", "requests", "receipts"].entries()) {
      const caseRoot = await mkdtemp(join(root, `receipt-index-collision-${index}-`));
      const store = await openEvidenceStore({ root: caseRoot, sentinel });
      const chainId = `floor-ascii-f07-index-collision-${index + 1}`;
      const header = await initializeContinuation({
        store,
        scope: continuationScope({
          rowId: "F-07",
          variantId: "f07-hard-cut-after-file-flush",
          repetition: index + 1,
          chainId,
        }),
        now: () => new Date("2026-08-06T00:00:00.000Z"),
      });
      await appendContinuation({
        store,
        chainId,
        operationId: "pre-cut",
        payload: { checkpoint: "pre-cut", stateSha256: "f".repeat(64) },
        now: () => new Date("2026-08-06T00:00:00.500Z"),
      });
      const checkpointEvidence = signedCheckpointEvidence(header);
      const digestByCategory = {
        nonces: checkpointEvidence.request.nonceSha256,
        requests: checkpointEvidence.request.requestSha256,
        receipts: checkpointEvidence.receipt.receiptSha256,
      } as const;
      await store.writeCanonicalJson(
        `continuations/receipt-index/${category}/${digestByCategory[category as keyof typeof digestByCategory]}.json`,
        {
          schemaVersion: 1,
          kind: "windows-host-probe-receipt-index",
          transactionSha256: "9".repeat(64),
          chainId: "another-continuation",
          scopeSha256: "8".repeat(64),
          nonceSha256: "7".repeat(64),
          requestSha256: "6".repeat(64),
          receiptSha256: "5".repeat(64),
        },
      );

      await expect(
        consumeContinuationReceipt({
          store,
          chainId,
          checkpointEvidence,
          expectedController,
          controllerPublicKeyBytes,
        }),
      ).rejects.toMatchObject({ code: "CONTINUATION_RECEIPT" });
      await expect(store.list("continuations/receipt-transactions")).resolves.toEqual([]);
    }
  });
});
