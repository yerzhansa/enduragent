import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openEvidenceStore,
  type EvidenceStore,
} from "../scripts/windows-host-falsifier/evidence-store.mjs";
import {
  openControllerJournal,
  type ControllerJournal,
} from "../scripts/windows-host-falsifier/controller/journal.mjs";
import {
  CONTROLLER_REQUEST_KIND,
  CONTROLLER_RESPONSE_KIND,
  deriveControllerRequestDigest,
  deriveControllerResponseDigest,
  type ControllerRequest,
  type ControllerRequestDraft,
  type ControllerResponse,
  type ControllerResponseDraft,
} from "../scripts/windows-host-falsifier/controller/protocol.mjs";
import {
  encodeControllerOperationRequest,
  encodeControllerOperationResponse,
} from "../scripts/windows-host-falsifier/controller/operation-codec.mjs";
import {
  assertControllerSpoolBytesSafe,
  createControllerSpoolClient,
  createControllerSpoolServer,
  initializeControllerSpoolStores,
} from "../scripts/windows-host-falsifier/controller/spool.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
  canonicalProbeJson,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { deriveProbeRunAuthorizationClaimReceiptDigest } from "../scripts/windows-host-falsifier/probe-run-authorization.mjs";
import { PROBE_RUN_PLAN_SHA256 } from "../scripts/windows-host-falsifier/probe-runner.mjs";

const controllerIdentitySha256 = "1".repeat(64);
const candidateSha256 = "2".repeat(64);
const runPlanSha256 = PROBE_RUN_PLAN_SHA256;
const runAuthorizationSha256 = "4".repeat(64);
const runAuthorizationClaimSha256 = "5".repeat(64);
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});
const controllerPublicKeySha256 = createHash("sha256")
  .update(controllerPublicKeyBytes)
  .digest("hex");
const authorizationRequestPayloadBytes = Buffer.from(
  canonicalProbeJson({ operation: "authorize-floor-ascii" }),
  "utf8",
);
const authorizationResponsePayloadBytes = Buffer.from(
  canonicalProbeJson({ result: "authorized-floor-ascii" }),
  "utf8",
);

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function reference(bytes: Uint8Array) {
  const digest = sha256(bytes);
  return {
    blobPath: `blobs/sha256/${digest}` as const,
    bytes: bytes.byteLength,
    sha256: digest,
  };
}

function request(
  payloadBytes: Uint8Array,
  overrides: {
    readonly operationId?: string;
    readonly intentSha256?: string;
    readonly sequence?: number;
    readonly pathProfileId?: "ascii" | "spaces-unicode";
    readonly runAuthorizationClaimSha256?: string;
  } = {},
): ControllerRequest {
  const draft: ControllerRequestDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_REQUEST_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256,
    runPlanSha256,
    runAuthorizationSha256,
    runAuthorizationClaimSha256:
      overrides.runAuthorizationClaimSha256 ?? runAuthorizationClaimSha256,
    coordinate: {
      campaignRunId: "campaign-one",
      executionRunId: "execution-one",
      attemptId: "attempt-one",
      environmentId: "win11-floor",
      pathProfileId: overrides.pathProfileId ?? "ascii",
      workId: "work-one",
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      repetition: null,
    },
    operation: {
      operationId: overrides.operationId ?? "operation-one",
      kind: "scenario-action",
      sequence: overrides.sequence ?? 1,
    },
    intentSha256: overrides.intentSha256 ?? "6".repeat(64),
    payload: reference(payloadBytes),
    controllerIdentitySha256,
  };
  return { ...draft, requestSha256: deriveControllerRequestDigest(draft) };
}

function authorizationRequest(
  payloadBytes: Uint8Array,
  pathProfileId: "ascii" | "spaces-unicode" = "ascii",
  intentSha256 = "7".repeat(64),
): ControllerRequest {
  const draft: ControllerRequestDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_REQUEST_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256,
    runPlanSha256,
    runAuthorizationSha256,
    runAuthorizationClaimSha256: null,
    coordinate: {
      campaignRunId: "campaign-one",
      executionRunId: "execution-one",
      attemptId: "attempt-one",
      environmentId: "win11-floor",
      pathProfileId,
      workId: null,
      rowId: null,
      variantId: null,
      repetition: null,
    },
    operation: {
      operationId: `authorization-claim-floor-${pathProfileId}`,
      kind: "run-authorization-claim",
      sequence: 1,
    },
    intentSha256,
    payload: reference(payloadBytes),
    controllerIdentitySha256,
  };
  return { ...draft, requestSha256: deriveControllerRequestDigest(draft) };
}

function controllerResponse(
  requestValue: ControllerRequest,
  payloadBytes: Uint8Array,
  outcome: ControllerResponseDraft["outcome"] = "SUCCEEDED",
): ControllerResponse {
  const draft: ControllerResponseDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_RESPONSE_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    requestSha256: requestValue.requestSha256,
    outcome,
    payload: reference(payloadBytes),
    artifacts: [],
    controllerIdentitySha256,
    controllerVersion: "1.0.0",
    controllerPublicKeySha256,
    signatureAlgorithm: "Ed25519",
  };
  const responseSha256 = deriveControllerResponseDigest(draft);
  return {
    ...draft,
    responseSha256,
    signatureBase64: sign(
      null,
      Buffer.from(responseSha256, "hex"),
      controllerKeys.privateKey,
    ).toString("base64"),
  };
}

function authorizationClaimReceipt(evidenceRootObjectIdentitySha256: string) {
  const draft = {
    schemaVersion: 1 as const,
    kind: "windows-host-probe-run-authorization-claim-receipt" as const,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    runPlanSha256,
    candidateSha256,
    campaignRunId: "campaign-one",
    environmentId: "win11-floor",
    labAttestationSha256: "8".repeat(64),
    evidenceRootObjectIdentitySha256,
    authorizationSha256: runAuthorizationSha256,
    operatorKeyId: "operator-one",
    operatorPublicKeySha256: "9".repeat(64),
    trustStoreId: "trust-store-one",
    trustStoreGeneration: 1,
    trustStoreSha256: "a".repeat(64),
    verifiedAt: "2026-08-06T10:00:00.000Z",
    authorizationExpiresAt: "2026-08-06T11:00:00.000Z",
    controllerIdentitySha256,
    controllerPublicKeySha256,
    controllerVersion: "1.0.0",
    signatureAlgorithm: "Ed25519" as const,
    signatureBase64: Buffer.alloc(64, 3).toString("base64"),
  };
  return {
    ...draft,
    receiptSha256: deriveProbeRunAuthorizationClaimReceiptDigest(draft),
  };
}

function signResponseDigest({ responseSha256 }: { readonly responseSha256: string }) {
  return sign(null, Buffer.from(responseSha256, "hex"), controllerKeys.privateKey).toString(
    "base64",
  );
}

async function waitForRequest(store: EvidenceStore, requestSha256: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await store.readArtifact(`requests/${requestSha256}.json`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("request was not published");
}

async function issueAuthorizationClaimDirect(journal: ControllerJournal) {
  const requestValue = authorizationRequest(authorizationRequestPayloadBytes);
  const responseValue = controllerResponse(requestValue, authorizationResponsePayloadBytes);
  await journal.retainBlob(authorizationRequestPayloadBytes);
  await journal.beginOperation(requestValue);
  await journal.retainBlob(authorizationResponsePayloadBytes);
  await journal.completeOperation({
    request: requestValue,
    response: responseValue,
    issuedAuthorizationClaimSha256: runAuthorizationClaimSha256,
  });
}

describe("Windows host probe controller file spool", () => {
  let root: string;
  let inboxStore: EvidenceStore;
  let outboxStore: EvidenceStore;
  let journal: ControllerJournal;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "enduragent-controller-spool-")));
    const inboxRoot = join(root, "guest-to-controller");
    const outboxRoot = join(root, "controller-to-guest");
    const journalRoot = join(root, "controller-journal");
    await Promise.all([
      mkdir(inboxRoot, { mode: 0o700 }),
      mkdir(outboxRoot, { mode: 0o700 }),
      mkdir(journalRoot, { mode: 0o700 }),
    ]);
    inboxStore = await openEvidenceStore({ root: inboxRoot });
    outboxStore = await openEvidenceStore({ root: outboxRoot });
    await initializeControllerSpoolStores({ inboxStore, outboxStore });
    journal = await openControllerJournal({
      root: journalRoot,
      controllerIdentitySha256,
      controllerPublicKeyBytes,
      controllerVersion: "1.0.0",
      campaignRunId: "campaign-one",
      candidateSha256,
      runPlanSha256,
      runAuthorizationSha256,
    });
    await issueAuthorizationClaimDirect(journal);
  });

  afterEach(async () => {
    await journal?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  function client(overrides: { readonly monotonicNow?: () => number } = {}) {
    return createControllerSpoolClient({
      inboxStore,
      outboxStore,
      controllerIdentitySha256,
      controllerVersion: "1.0.0",
      controllerPublicKeyBytes,
      pollIntervalMs: 2,
      responseTimeoutMs: 2000,
      ...overrides,
    });
  }

  it("publishes payload then request, verifies the signed response, and replays exactly", async () => {
    const payloadBytes = Buffer.from(canonicalProbeJson({ operation: "safe-request" }), "utf8");
    const responsePayloadBytes = Buffer.from(
      canonicalProbeJson({ result: "safe-response" }),
      "utf8",
    );
    const artifactBytes = Buffer.from("sanitized controller evidence\n", "utf8");
    const requestValue = request(payloadBytes);
    const handler = vi.fn(async ({ recoveryRequired }) => {
      expect(recoveryRequired).toBe(false);
      return {
        outcome: "SUCCEEDED" as const,
        payloadBytes: responsePayloadBytes,
        artifactBytes: [artifactBytes],
      };
    });
    const server = await createControllerSpoolServer({
      inboxStore,
      outboxStore,
      journal,
      handler,
      signResponseDigest,
    });

    const firstExchange = client().exchange({ request: requestValue, payloadBytes });
    await waitForRequest(inboxStore, requestValue.requestSha256);
    await expect(server.processPending()).resolves.toHaveLength(1);
    await expect(firstExchange).resolves.toMatchObject({
      response: { outcome: "SUCCEEDED", requestSha256: requestValue.requestSha256 },
      payloadBytes: responsePayloadBytes,
      artifacts: [{ reference: reference(artifactBytes), bytes: artifactBytes }],
    });
    expect(handler).toHaveBeenCalledTimes(1);

    const replayExchange = client().exchange({ request: requestValue, payloadBytes });
    await expect(server.processRequest(requestValue.requestSha256)).resolves.toMatchObject({
      recovered: true,
      handlerInvoked: false,
    });
    await expect(replayExchange).resolves.toMatchObject({ payloadBytes: responsePayloadBytes });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(journal.assertClean()).resolves.toMatchObject({
      pendingOperationIds: [],
      orphanBlobSha256s: [],
    });
  });

  it("atomically persists the claim digest bound inside a successful authorization response", async () => {
    const evidenceRootObjectIdentitySha256 = "b".repeat(64);
    const encodedRequest = encodeControllerOperationRequest({
      operationKind: "run-authorization-claim",
      input: { evidenceRootObjectIdentitySha256 },
    });
    const requestValue = authorizationRequest(
      encodedRequest.bytes,
      "spaces-unicode",
      encodedRequest.intentSha256,
    );
    const receipt = authorizationClaimReceipt(evidenceRootObjectIdentitySha256);
    const encodedResponse = encodeControllerOperationResponse({
      operationKind: "run-authorization-claim",
      result: receipt,
      artifactBindings: [],
    });
    const server = await createControllerSpoolServer({
      inboxStore,
      outboxStore,
      journal,
      signResponseDigest,
      handler: async () => ({
        outcome: "SUCCEEDED",
        payloadBytes: encodedResponse.bytes,
        artifactBytes: [],
      }),
    });

    const exchange = client({ monotonicNow: () => 0 }).exchange({
      request: requestValue,
      payloadBytes: encodedRequest.bytes,
    });
    await waitForRequest(inboxStore, requestValue.requestSha256);
    await expect(server.processRequest(requestValue.requestSha256)).resolves.toMatchObject({
      recovered: false,
      handlerInvoked: true,
    });
    await expect(exchange).resolves.toMatchObject({
      response: { outcome: "SUCCEEDED" },
      payloadBytes: encodedResponse.bytes,
    });
    await expect(journal.scan()).resolves.toMatchObject({
      authorizationClaims: expect.arrayContaining([
        {
          environmentId: "win11-floor",
          pathProfileId: "spaces-unicode",
          claimSha256: receipt.receiptSha256,
          issuanceOperationId: "authorization-claim-floor-spaces-unicode",
        },
      ]),
    });

    const workPayloadBytes = Buffer.from(
      canonicalProbeJson({ operation: "authorized-unicode-profile" }),
      "utf8",
    );
    await journal.retainBlob(workPayloadBytes);
    await expect(
      journal.beginOperation(
        request(workPayloadBytes, {
          operationId: "operation-authorized-unicode-profile",
          pathProfileId: "spaces-unicode",
          runAuthorizationClaimSha256: receipt.receiptSha256,
        }),
      ),
    ).resolves.toMatchObject({ state: "pending" });
  });

  it("marks a retained pending operation as recovery-required before repeating its driver", async () => {
    const payloadBytes = Buffer.from(canonicalProbeJson({ operation: "recoverable" }), "utf8");
    const requestValue = request(payloadBytes, { operationId: "operation-recoverable" });
    let calls = 0;
    const server = await createControllerSpoolServer({
      inboxStore,
      outboxStore,
      journal,
      signResponseDigest,
      handler: async ({ recoveryRequired }) => {
        calls += 1;
        if (calls === 1) {
          expect(recoveryRequired).toBe(false);
          throw Object.assign(new Error("simulated driver interruption"), { code: "EIO" });
        }
        expect(recoveryRequired).toBe(true);
        return {
          outcome: "SUCCEEDED",
          payloadBytes: Buffer.from(canonicalProbeJson({ recovered: true }), "utf8"),
          artifactBytes: [],
        };
      },
    });

    const exchange = client().exchange({ request: requestValue, payloadBytes });
    await waitForRequest(inboxStore, requestValue.requestSha256);
    await expect(server.processRequest(requestValue.requestSha256)).rejects.toMatchObject({
      code: "EIO",
    });
    await expect(journal.readOperation(requestValue.operation.operationId)).resolves.toMatchObject({
      state: "pending",
    });
    await expect(server.processRequest(requestValue.requestSha256)).resolves.toMatchObject({
      recovered: true,
      handlerInvoked: true,
    });
    await expect(exchange).resolves.toMatchObject({ response: { outcome: "SUCCEEDED" } });
    expect(calls).toBe(2);
  });

  it("recovers publication after the journal committed without repeating the handler", async () => {
    const payloadBytes = Buffer.from(canonicalProbeJson({ operation: "publish-recovery" }), "utf8");
    const requestValue = request(payloadBytes, { operationId: "operation-publish-recovery" });
    let failEnvelope = true;
    const failingOutbox = {
      ...outboxStore,
      writeBytes: async (path: string, bytes: Uint8Array | string) => {
        if (failEnvelope && path.startsWith("responses/")) {
          failEnvelope = false;
          throw Object.assign(new Error("simulated outbox interruption"), { code: "EIO" });
        }
        return outboxStore.writeBytes(path, bytes);
      },
    } satisfies EvidenceStore;
    const handler = vi.fn(async () => ({
      outcome: "SUCCEEDED" as const,
      payloadBytes: Buffer.from(canonicalProbeJson({ committed: true }), "utf8"),
      artifactBytes: [],
    }));
    const failingServer = await createControllerSpoolServer({
      inboxStore,
      outboxStore: failingOutbox,
      journal,
      handler,
      signResponseDigest,
    });

    const exchange = client().exchange({ request: requestValue, payloadBytes });
    await waitForRequest(inboxStore, requestValue.requestSha256);
    await expect(failingServer.processRequest(requestValue.requestSha256)).rejects.toMatchObject({
      code: "EIO",
    });
    await expect(journal.readOperation(requestValue.operation.operationId)).resolves.toMatchObject({
      state: "complete",
    });

    const recoveryServer = await createControllerSpoolServer({
      inboxStore,
      outboxStore,
      journal,
      handler,
      signResponseDigest,
    });
    await expect(recoveryServer.processRequest(requestValue.requestSha256)).resolves.toMatchObject({
      recovered: true,
      handlerInvoked: false,
    });
    await expect(exchange).resolves.toMatchObject({ response: { outcome: "SUCCEEDED" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects an operation-id replay whose digest-bound request differs", async () => {
    const firstPayload = Buffer.from(canonicalProbeJson({ value: "first" }), "utf8");
    const secondPayload = Buffer.from(canonicalProbeJson({ value: "second" }), "utf8");
    const first = request(firstPayload, { operationId: "operation-collision" });
    const second = request(secondPayload, {
      operationId: "operation-collision",
      intentSha256: "7".repeat(64),
      sequence: 2,
    });
    const server = await createControllerSpoolServer({
      inboxStore,
      outboxStore,
      journal,
      signResponseDigest,
      handler: async () => ({
        outcome: "SUCCEEDED",
        payloadBytes: Buffer.from(canonicalProbeJson({ ok: true }), "utf8"),
        artifactBytes: [],
      }),
    });
    for (const [requestValue, bytes] of [
      [first, firstPayload],
      [second, secondPayload],
    ] as const) {
      await inboxStore.writeBytes(requestValue.payload.blobPath, bytes);
      await inboxStore.writeBytes(
        `requests/${requestValue.requestSha256}.json`,
        canonicalProbeJson(requestValue),
      );
    }
    await expect(server.processRequest(first.requestSha256)).resolves.toBeTruthy();
    await expect(server.processRequest(second.requestSha256)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_OPERATION_COLLISION",
    });
  });

  it("rejects forged response signatures and referenced-byte substitution", async () => {
    const payloadBytes = Buffer.from(canonicalProbeJson({ operation: "forgery" }), "utf8");
    const requestValue = request(payloadBytes, { operationId: "operation-forgery" });
    const responseBytes = Buffer.from(canonicalProbeJson({ result: "expected" }), "utf8");
    const draft: ControllerResponseDraft = {
      schemaVersion: 1,
      kind: CONTROLLER_RESPONSE_KIND,
      campaignId: PROBE_CAMPAIGN_ID,
      requestSha256: requestValue.requestSha256,
      outcome: "SUCCEEDED",
      payload: reference(responseBytes),
      artifacts: [],
      controllerIdentitySha256,
      controllerVersion: "1.0.0",
      controllerPublicKeySha256,
      signatureAlgorithm: "Ed25519",
    };
    const responseSha256 = deriveControllerResponseDigest(draft);
    const forged: ControllerResponse = {
      ...draft,
      responseSha256,
      signatureBase64: Buffer.alloc(64, 9).toString("base64"),
    };
    const exchange = client().exchange({ request: requestValue, payloadBytes });
    await waitForRequest(inboxStore, requestValue.requestSha256);
    await outboxStore.writeBytes(draft.payload.blobPath, responseBytes);
    await outboxStore.writeBytes(
      `responses/${requestValue.requestSha256}.json`,
      canonicalProbeJson(forged),
    );
    await expect(exchange).rejects.toMatchObject({
      code: "CONTROLLER_PROTOCOL_RESPONSE_SIGNATURE",
    });

    const substitutedPayload = Buffer.from(
      canonicalProbeJson({ operation: "substitution" }),
      "utf8",
    );
    const substitutedRequest = request(substitutedPayload, {
      operationId: "operation-substitution",
    });
    const expectedSubstitutedResponse = Buffer.from(
      canonicalProbeJson({ result: "substitution-expected" }),
      "utf8",
    );
    const validDraft = {
      ...draft,
      requestSha256: substitutedRequest.requestSha256,
      payload: reference(expectedSubstitutedResponse),
    };
    const validDigest = deriveControllerResponseDigest(validDraft);
    const validResponse: ControllerResponse = {
      ...validDraft,
      responseSha256: validDigest,
      signatureBase64: sign(
        null,
        Buffer.from(validDigest, "hex"),
        controllerKeys.privateKey,
      ).toString("base64"),
    };
    const substitutedExchange = client().exchange({
      request: substitutedRequest,
      payloadBytes: substitutedPayload,
    });
    await waitForRequest(inboxStore, substitutedRequest.requestSha256);
    await outboxStore.writeBytes(
      validDraft.payload.blobPath,
      Buffer.from("substituted response bytes\n", "utf8"),
    );
    await outboxStore.writeBytes(
      `responses/${substitutedRequest.requestSha256}.json`,
      canonicalProbeJson(validResponse),
    );
    await expect(substitutedExchange).rejects.toMatchObject({
      code: "CONTROLLER_SPOOL_ARTIFACT",
    });
  });

  it("refuses private material, pre-aborted publication, and a regressing clock", async () => {
    const privateKeyBytes = Buffer.from(
      controllerKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    expect(() => assertControllerSpoolBytesSafe(privateKeyBytes)).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_SPOOL_SECRET_MATERIAL" }),
    );
    const safeBytes = Buffer.from(canonicalProbeJson({ safe: true }), "utf8");
    const requestValue = request(safeBytes, { operationId: "operation-aborted" });
    const abortController = new AbortController();
    abortController.abort();
    await expect(
      client().exchange({
        request: requestValue,
        payloadBytes: safeBytes,
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ code: "CONTROLLER_SPOOL_ABORT" });
    await expect(inboxStore.list("requests")).resolves.toEqual([]);

    const samples = [10, 9];
    await expect(
      client({ monotonicNow: () => samples.shift() ?? 9 }).exchange({
        request: request(safeBytes, { operationId: "operation-clock" }),
        payloadBytes: safeBytes,
      }),
    ).rejects.toMatchObject({ code: "CONTROLLER_SPOOL_CLOCK" });
  });
});
