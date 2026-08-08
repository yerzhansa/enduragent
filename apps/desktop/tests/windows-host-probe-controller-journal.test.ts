import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openControllerJournal,
  type ControllerJournal,
} from "../scripts/windows-host-falsifier/controller/journal.mjs";
import {
  CONTROLLER_REQUEST_KIND,
  CONTROLLER_RESPONSE_KIND,
  deriveControllerRequestDigest,
  deriveControllerResponseDigest,
  validateControllerRequest,
  validateControllerResponse,
  verifyControllerResponse,
  type ControllerArtifactReference,
  type ControllerRequest,
  type ControllerRequestDraft,
  type ControllerResponse,
  type ControllerResponseDraft,
} from "../scripts/windows-host-falsifier/controller/protocol.mjs";
import {
  PROBE_CAMPAIGN_ID,
  PROBE_CAMPAIGN_MANIFEST_SHA256,
} from "../scripts/windows-host-falsifier/probe-contract.mjs";

const controllerIdentitySha256 = "1".repeat(64);
const controllerKeys = generateKeyPairSync("ed25519");
const controllerPublicKeyBytes = controllerKeys.publicKey.export({
  format: "der",
  type: "spki",
});
const controllerPublicKeySha256 = createHash("sha256")
  .update(controllerPublicKeyBytes)
  .digest("hex");
const forbiddenValue = "synthetic-controller-secret-value";
const issuedAuthorizationClaimSha256 = "5".repeat(64);
const authorizationRequestPayloadBytes = Buffer.from(
  "canonical authorization request payload\n",
  "utf8",
);
const authorizationResponsePayloadBytes = Buffer.from(
  "canonical authorization response payload\n",
  "utf8",
);
const requestPayloadBytes = Buffer.from("canonical controller request payload\n", "utf8");
const responsePayloadBytes = Buffer.from("canonical controller response payload\n", "utf8");
const journalAuthority = {
  controllerIdentitySha256,
  controllerPublicKeyBytes,
  controllerVersion: "1.0.0",
  campaignRunId: "campaign-one",
  candidateSha256: "3".repeat(64),
  runPlanSha256: "4".repeat(64),
  runAuthorizationSha256: "9".repeat(64),
} as const;

function digest(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function artifactReference(value: Uint8Array | string): ControllerArtifactReference {
  const bytes = Buffer.from(value);
  const sha256 = digest(bytes);
  return {
    blobPath: `blobs/sha256/${sha256}`,
    bytes: bytes.length,
    sha256,
  };
}

const requestPayload = artifactReference(requestPayloadBytes);
const responsePayload = artifactReference(responsePayloadBytes);
const authorizationRequestPayload = artifactReference(authorizationRequestPayloadBytes);
const authorizationResponsePayload = artifactReference(authorizationResponsePayloadBytes);

function request(
  overrides: Omit<Partial<ControllerRequestDraft>, "coordinate" | "operation"> & {
    operation?: Partial<ControllerRequestDraft["operation"]>;
    coordinate?: Partial<ControllerRequestDraft["coordinate"]>;
  } = {},
): ControllerRequest {
  const {
    coordinate: coordinateOverrides,
    operation: operationOverrides,
    ...requestOverrides
  } = overrides;
  const draft: ControllerRequestDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_REQUEST_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    manifestSha256: PROBE_CAMPAIGN_MANIFEST_SHA256,
    candidateSha256: "3".repeat(64),
    runPlanSha256: "4".repeat(64),
    runAuthorizationSha256: "9".repeat(64),
    runAuthorizationClaimSha256: "5".repeat(64),
    coordinate: {
      campaignRunId: "campaign-one",
      executionRunId: "execution-floor",
      attemptId: "attempt-one",
      environmentId: "win11-floor",
      pathProfileId: "ascii",
      workId: "work-one",
      rowId: "F-01",
      variantId: "f01-ordinary-absolute-path",
      repetition: null,
      ...coordinateOverrides,
    },
    operation: {
      operationId: "operation-one",
      kind: "scenario-action",
      sequence: 1,
      ...operationOverrides,
    },
    intentSha256: "6".repeat(64),
    payload: requestPayload,
    controllerIdentitySha256,
    ...requestOverrides,
  };
  return { ...draft, requestSha256: deriveControllerRequestDigest(draft) };
}

function response(
  requestValue: ControllerRequest,
  artifacts: readonly ControllerArtifactReference[] = [],
  overrides: Partial<ControllerResponseDraft> = {},
): ControllerResponse {
  const draft: ControllerResponseDraft = {
    schemaVersion: 1,
    kind: CONTROLLER_RESPONSE_KIND,
    campaignId: PROBE_CAMPAIGN_ID,
    requestSha256: requestValue.requestSha256,
    outcome: "SUCCEEDED",
    payload: responsePayload,
    artifacts,
    controllerIdentitySha256,
    controllerVersion: "1.0.0",
    controllerPublicKeySha256,
    signatureAlgorithm: "Ed25519",
    ...overrides,
  };
  const responseSha256 = deriveControllerResponseDigest(draft);
  return {
    ...draft,
    signatureBase64: sign(
      null,
      Buffer.from(responseSha256, "hex"),
      controllerKeys.privateKey,
    ).toString("base64"),
    responseSha256,
  };
}

function authorizationClaimRequest(): ControllerRequest {
  return request({
    runAuthorizationClaimSha256: null,
    coordinate: {
      workId: null,
      rowId: null,
      variantId: null,
      repetition: null,
    },
    operation: {
      operationId: "authorization-claim-floor-ascii",
      kind: "run-authorization-claim",
      sequence: 1,
    },
    intentSha256: "7".repeat(64),
    payload: authorizationRequestPayload,
  });
}

describe("Windows host probe external controller protocol and journal", () => {
  let root: string;
  let journals: ControllerJournal[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "enduragent-controller-journal-")));
    journals = [];
  });

  afterEach(async () => {
    for (const journal of journals) await journal.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  async function openUnclaimedJournal(
    path = root,
    limits?: Parameters<typeof openControllerJournal>[0]["limits"],
  ) {
    const journal = await openControllerJournal({
      root: path,
      ...journalAuthority,
      forbiddenValues: [forbiddenValue],
      limits,
    });
    journals.push(journal);
    return journal;
  }

  async function authorizeJournal(journal: ControllerJournal) {
    const requestValue = authorizationClaimRequest();
    const responseValue = response(requestValue, [], { payload: authorizationResponsePayload });
    await journal.retainBlob(authorizationRequestPayloadBytes);
    await journal.beginOperation(requestValue);
    await journal.retainBlob(authorizationResponsePayloadBytes);
    await journal.completeOperation({
      request: requestValue,
      response: responseValue,
      issuedAuthorizationClaimSha256,
    });
  }

  async function openJournal(path = root) {
    const journal = await openUnclaimedJournal(path);
    await authorizeJournal(journal);
    return journal;
  }

  async function beginDefaultOperation(
    journal: ControllerJournal,
    requestValue: ControllerRequest,
  ) {
    await expect(journal.retainBlob(requestPayloadBytes)).resolves.toEqual(requestValue.payload);
    return journal.beginOperation(requestValue);
  }

  async function completeDefaultOperation(
    journal: ControllerJournal,
    requestValue: ControllerRequest,
    responseValue: ControllerResponse,
  ) {
    await expect(journal.retainBlob(responsePayloadBytes)).resolves.toEqual(responseValue.payload);
    return journal.completeOperation({ request: requestValue, response: responseValue });
  }

  it("validates exact campaign-bound canonical request and response envelopes", () => {
    const requestValue = request();
    const responseValue = response(requestValue);

    expect(validateControllerRequest(requestValue)).toEqual(requestValue);
    expect(validateControllerResponse(responseValue)).toEqual(responseValue);
    expect(
      verifyControllerResponse(responseValue, {
        request: requestValue,
        controllerIdentitySha256,
        controllerVersion: "1.0.0",
        controllerPublicKeyBytes,
      }),
    ).toEqual(responseValue);

    expect(() =>
      validateControllerRequest({ ...requestValue, runAuthorizationSha256: "8".repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PROTOCOL_REQUEST_DIGEST" }));
    expect(() =>
      validateControllerRequest({ ...requestValue, token: "must-not-be-a-field" }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PROTOCOL_KEYS" }));
    expect(() =>
      validateControllerResponse({
        ...responseValue,
        signatureBase64: Buffer.alloc(63).toString("base64"),
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PROTOCOL_SIGNATURE" }));
    expect(() =>
      verifyControllerResponse(
        { ...responseValue, signatureBase64: Buffer.alloc(64, 7).toString("base64") },
        {
          request: requestValue,
          controllerIdentitySha256,
          controllerVersion: "1.0.0",
          controllerPublicKeyBytes,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PROTOCOL_RESPONSE_SIGNATURE" }));
  });

  it("enforces authorization bootstrap and preparation-versus-work coordinate scope", () => {
    const preparationCoordinate = {
      workId: null,
      rowId: null,
      variantId: null,
      repetition: null,
    } as const;
    const bootstrap = request({
      runAuthorizationClaimSha256: null,
      coordinate: preparationCoordinate,
      operation: { kind: "run-authorization-claim" },
    });
    expect(validateControllerRequest(bootstrap)).toEqual(bootstrap);

    expect(() =>
      request({
        coordinate: preparationCoordinate,
        operation: { kind: "run-authorization-claim" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PROTOCOL_AUTHORIZATION_CLAIM" }));
    expect(() => request({ runAuthorizationClaimSha256: null })).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PROTOCOL_SHA256" }),
    );
    expect(() => request({ coordinate: { rowId: null } })).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PROTOCOL_COORDINATE_SCOPE" }),
    );
    expect(validateControllerRequest(request({ coordinate: { repetition: 1 } }))).toBeTruthy();
    expect(() =>
      request({
        coordinate: { repetition: 1 },
        operation: { kind: "capture-disposition-observation" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PROTOCOL_COORDINATE_SCOPE" }));
    expect(() => request({ coordinate: { repetition: 0 } })).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PROTOCOL_INTEGER" }),
    );
    expect(() => request({ operation: { kind: "hard-cut-request-claim" } })).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PROTOCOL_INTEGER" }),
    );
    expect(
      validateControllerRequest(
        request({
          coordinate: { repetition: 1 },
          operation: { kind: "hard-cut-request-claim" },
        }),
      ),
    ).toBeTruthy();
    expect(
      validateControllerRequest(
        request({
          coordinate: { repetition: 2 },
          operation: { kind: "hard-cut-receipt-read" },
        }),
      ),
    ).toBeTruthy();
    expect(() =>
      request({
        coordinate: { ...preparationCoordinate, workId: "mixed-work" },
        operation: { kind: "controller-observation" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_PROTOCOL_COORDINATE_SCOPE" }));
    expect(
      validateControllerRequest(
        request({
          coordinate: preparationCoordinate,
          operation: { kind: "controller-observation" },
        }),
      ),
    ).toBeTruthy();
  });

  it("durably gates every work operation on the issued coordinate claim", async () => {
    let journal = await openUnclaimedJournal();
    await journal.retainBlob(requestPayloadBytes);
    await expect(journal.beginOperation(request())).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM",
    });

    await authorizeJournal(journal);
    await expect(journal.scan()).resolves.toMatchObject({
      authorizationClaims: [
        {
          environmentId: "win11-floor",
          pathProfileId: "ascii",
          claimSha256: issuedAuthorizationClaimSha256,
          issuanceOperationId: "authorization-claim-floor-ascii",
        },
      ],
    });

    await expect(
      journal.beginOperation(
        request({
          runAuthorizationClaimSha256: "8".repeat(64),
          operation: { operationId: "operation-wrong-claim", sequence: 2 },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM" });
    await expect(
      journal.beginOperation(
        request({
          coordinate: { pathProfileId: "spaces-unicode" },
          operation: { operationId: "operation-unclaimed-profile", sequence: 3 },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM" });
    await expect(
      journal.beginOperation(
        request({
          runAuthorizationClaimSha256: null,
          coordinate: {
            attemptId: "attempt-two",
            workId: null,
            rowId: null,
            variantId: null,
            repetition: null,
          },
          operation: {
            operationId: "authorization-claim-floor-ascii-second",
            kind: "run-authorization-claim",
            sequence: 2,
          },
          intentSha256: "8".repeat(64),
          payload: authorizationRequestPayload,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM" });

    const firstAuthorizedWork = request({
      operation: { operationId: "operation-authorized-before-reopen", sequence: 4 },
    });
    await expect(journal.beginOperation(firstAuthorizedWork)).resolves.toMatchObject({
      state: "pending",
    });
    await completeDefaultOperation(journal, firstAuthorizedWork, response(firstAuthorizedWork));
    await journal.close();

    journal = await openUnclaimedJournal();
    const secondAuthorizedWork = request({
      operation: { operationId: "operation-authorized-after-reopen", sequence: 5 },
      coordinate: { variantId: "f01-drive-letter-alias" },
    });
    await expect(journal.beginOperation(secondAuthorizedWork)).resolves.toMatchObject({
      state: "pending",
    });
    await completeDefaultOperation(journal, secondAuthorizedWork, response(secondAuthorizedWork));
  });

  it("commits a successful authorization response and its claim atomically", async () => {
    const journal = await openUnclaimedJournal();
    const requestValue = authorizationClaimRequest();
    const responseValue = response(requestValue, [], { payload: authorizationResponsePayload });
    await journal.retainBlob(authorizationRequestPayloadBytes);
    await journal.beginOperation(requestValue);
    await journal.retainBlob(authorizationResponsePayloadBytes);

    await expect(
      journal.completeOperation({ request: requestValue, response: responseValue }),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_AUTHORIZATION_CLAIM" });
    await expect(journal.readOperation(requestValue.operation.operationId)).resolves.toMatchObject({
      state: "pending",
      response: null,
    });
    await expect(journal.scan()).resolves.toMatchObject({ authorizationClaims: [] });

    await expect(
      journal.completeOperation({
        request: requestValue,
        response: responseValue,
        issuedAuthorizationClaimSha256,
      }),
    ).resolves.toMatchObject({ state: "complete" });
    await expect(journal.scan()).resolves.toMatchObject({
      authorizationClaims: [{ claimSha256: issuedAuthorizationClaimSha256 }],
    });
  });

  it("pins one campaign authority and rejects unsigned terminal state", async () => {
    const journal = await openJournal();
    await journal.retainBlob(requestPayloadBytes);
    await expect(
      journal.beginOperation(request({ candidateSha256: "8".repeat(64) })),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_REQUEST_BINDING" });

    const requestValue = request();
    await journal.beginOperation(requestValue);
    await journal.retainBlob(responsePayloadBytes);
    const forged = {
      ...response(requestValue),
      signatureBase64: Buffer.alloc(64, 7).toString("base64"),
    };
    await expect(
      journal.completeOperation({ request: requestValue, response: forged }),
    ).rejects.toMatchObject({ code: "CONTROLLER_PROTOCOL_RESPONSE_SIGNATURE" });
    await expect(journal.readOperation(requestValue.operation.operationId)).resolves.toMatchObject({
      state: "pending",
      response: null,
    });
    await expect(
      journal.completeOperation({ request: requestValue, response: response(requestValue) }),
    ).resolves.toMatchObject({ state: "complete" });
  });

  it("refuses to close a live claim and retains authority through terminal commit", async () => {
    const requestValue = request();
    let journal = await openJournal();
    await expect(journal.retainBlob(requestPayloadBytes)).resolves.toEqual(requestValue.payload);
    const retainedRequestPayload = await journal.readBlob(requestValue.payload);
    expect(retainedRequestPayload).toEqual(requestPayloadBytes);
    retainedRequestPayload.fill(0);
    await expect(journal.readBlob(requestValue.payload)).resolves.toEqual(requestPayloadBytes);
    await expect(journal.scan()).resolves.toMatchObject({
      pendingOperationIds: [],
      orphanBlobSha256s: [requestValue.payload.sha256],
    });
    await expect(journal.beginOperation(requestValue)).resolves.toMatchObject({
      state: "pending",
      request: requestValue,
      response: null,
    });
    await expect(journal.scan()).resolves.toMatchObject({
      pendingOperationIds: [requestValue.operation.operationId],
      orphanBlobSha256s: [],
    });
    await expect(journal.assertClean()).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_PENDING",
    });
    await expect(journal.close()).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_EXECUTION_ACTIVE",
    });

    const observer = await openUnclaimedJournal();
    await expect(observer.readOperation("operation-one")).resolves.toMatchObject({
      state: "pending",
      request: requestValue,
    });
    await expect(observer.claimOperation(requestValue)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_EXECUTION_BUSY",
    });
    const artifact = await journal.retainBlob("canonical controller result\n");
    const responseValue = response(requestValue, [artifact]);
    await expect(journal.retainBlob(responsePayloadBytes)).resolves.toEqual(responseValue.payload);
    await expect(journal.scan()).resolves.toMatchObject({
      orphanBlobSha256s: [artifact.sha256, responseValue.payload.sha256].sort(),
    });
    const completed = await journal.completeOperation({
      request: requestValue,
      response: responseValue,
    });
    expect(completed).toMatchObject({ state: "complete", response: responseValue });
    await expect(observer.claimOperation(requestValue)).resolves.toEqual({
      created: false,
      record: completed,
    });
    await expect(journal.assertClean()).resolves.toMatchObject({
      journalMode: "wal",
      synchronous: "FULL",
      pendingOperationIds: [],
      orphanBlobSha256s: [],
    });
    await journal.close();

    journal = await openUnclaimedJournal();
    await expect(journal.readOperation("operation-one")).resolves.toEqual(completed);
    await expect(
      journal.completeOperation({ request: requestValue, response: responseValue }),
    ).resolves.toEqual(completed);
  });

  it("rejects altered operation and terminal-response replays", async () => {
    const journal = await openJournal();
    const requestValue = request();
    await beginDefaultOperation(journal, requestValue);

    const alteredPayloadBytes = Buffer.from("altered controller request payload\n", "utf8");
    const alteredPayload = await journal.retainBlob(alteredPayloadBytes);
    const alteredRequest = request({ payload: alteredPayload });
    await expect(journal.beginOperation(alteredRequest)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_OPERATION_COLLISION",
    });

    const responseValue = response(requestValue);
    await completeDefaultOperation(journal, requestValue, responseValue);
    const alteredResponse = response(requestValue, [], { outcome: "INCONCLUSIVE" });
    await expect(
      journal.completeOperation({ request: requestValue, response: alteredResponse }),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_RESPONSE_COLLISION" });
  });

  it("rejects a semantic replay hidden behind a fresh operation identifier", async () => {
    const journal = await openJournal();
    const original = request({
      operation: { operationId: "operation-semantic-original", sequence: 9 },
    });
    await beginDefaultOperation(journal, original);

    const alteredPayloadBytes = Buffer.from("semantic replay with altered input\n", "utf8");
    const alteredPayload = await journal.retainBlob(alteredPayloadBytes);
    const replay = request({
      operation: { operationId: "operation-semantic-fresh-id", sequence: 9 },
      intentSha256: "8".repeat(64),
      payload: alteredPayload,
    });
    await expect(journal.beginOperation(replay)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_OPERATION_COLLISION",
    });
    await expect(journal.readOperation(replay.operation.operationId)).resolves.toBeNull();
    await completeDefaultOperation(journal, original, response(original));
  });

  it("recovers an already-committed response when the caller restarts before acknowledgment", async () => {
    const requestValue = request({
      operation: { operationId: "operation-response-recovery", sequence: 2 },
    });
    const responseValue = response(requestValue);
    let journal = await openJournal();
    await beginDefaultOperation(journal, requestValue);
    const committed = await completeDefaultOperation(journal, requestValue, responseValue);
    await journal.close();

    journal = await openJournal();
    await expect(journal.beginOperation(requestValue)).resolves.toEqual(committed);
    await expect(
      journal.completeOperation({ request: requestValue, response: responseValue }),
    ).resolves.toEqual(committed);
  });

  it("grants physical execution to exactly one concurrent journal handle", async () => {
    const first = await openJournal();
    const second = await openJournal();
    const requestValue = request({
      operation: { operationId: "operation-concurrent-replay", sequence: 3 },
    });
    await first.retainBlob(requestPayloadBytes);
    const claims = await Promise.allSettled([
      first.claimOperation(requestValue),
      second.claimOperation(requestValue),
    ]);
    const ownerIndex = claims.findIndex((entry) => entry.status === "fulfilled");
    const observerIndex = claims.findIndex((entry) => entry.status === "rejected");
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(observerIndex).toBeGreaterThanOrEqual(0);
    expect(claims[ownerIndex]).toMatchObject({
      status: "fulfilled",
      value: { created: true, record: { state: "pending" } },
    });
    expect(claims[observerIndex]).toMatchObject({
      status: "rejected",
      reason: { code: "CONTROLLER_JOURNAL_EXECUTION_BUSY" },
    });

    const responseValue = response(requestValue);
    const [firstPayload, secondPayload] = await Promise.all([
      first.retainBlob(responsePayloadBytes),
      second.retainBlob(responsePayloadBytes),
    ]);
    expect(firstPayload).toEqual(secondPayload);
    const owner = ownerIndex === 0 ? first : second;
    const observer = ownerIndex === 0 ? second : first;
    await expect(
      observer.completeOperation({ request: requestValue, response: responseValue }),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_EXECUTION_AUTHORITY" });
    const terminal = await owner.completeOperation({
      request: requestValue,
      response: responseValue,
    });
    await expect(observer.claimOperation(requestValue)).resolves.toEqual({
      created: false,
      record: terminal,
    });
    await expect(
      observer.completeOperation({ request: requestValue, response: responseValue }),
    ).resolves.toEqual(terminal);
  });

  it("releases execution authority on process death while preserving recovery state", async () => {
    const requestValue = request({
      operation: { operationId: "operation-crashed-controller", sequence: 4 },
    });
    const setup = await openJournal();
    await setup.retainBlob(requestPayloadBytes);
    await setup.close();

    const moduleUrl = new URL(
      "../scripts/windows-host-falsifier/controller/journal.mjs",
      import.meta.url,
    ).href;
    const childSource = [
      `import { openControllerJournal } from ${JSON.stringify(moduleUrl)};`,
      `const journal = await openControllerJournal({ root: ${JSON.stringify(root)}, controllerIdentitySha256: ${JSON.stringify(journalAuthority.controllerIdentitySha256)}, controllerPublicKeyBytes: Buffer.from(${JSON.stringify(controllerPublicKeyBytes.toString("base64"))}, "base64"), controllerVersion: ${JSON.stringify(journalAuthority.controllerVersion)}, campaignRunId: ${JSON.stringify(journalAuthority.campaignRunId)}, candidateSha256: ${JSON.stringify(journalAuthority.candidateSha256)}, runPlanSha256: ${JSON.stringify(journalAuthority.runPlanSha256)}, runAuthorizationSha256: ${JSON.stringify(journalAuthority.runAuthorizationSha256)} });`,
      `const claim = await journal.claimOperation(${JSON.stringify(requestValue)});`,
      "if (!claim.created) throw new Error('child did not create the execution claim');",
      "process.stdout.write('CLAIMED\\n');",
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--input-type=module", "--eval", childSource],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let childError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      childError += chunk;
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = "";
        const timeout = setTimeout(() => {
          rejectReady(new Error(`child did not claim execution: ${childError}`));
        }, 10_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("CLAIMED\n")) {
            clearTimeout(timeout);
            resolveReady();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        child.once("exit", (code) => {
          if (!output.includes("CLAIMED\n")) {
            clearTimeout(timeout);
            rejectReady(new Error(`child exited ${String(code)} before claim: ${childError}`));
          }
        });
      });

      const recovery = await openUnclaimedJournal();
      await expect(
        recovery.readOperation(requestValue.operation.operationId),
      ).resolves.toMatchObject({
        state: "pending",
        request: requestValue,
      });
      await expect(recovery.claimOperation(requestValue)).rejects.toMatchObject({
        code: "CONTROLLER_JOURNAL_EXECUTION_BUSY",
      });

      child.kill("SIGKILL");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      await expect(recovery.claimOperation(requestValue)).resolves.toMatchObject({
        created: false,
        record: { state: "pending", request: requestValue },
      });
      const responseValue = response(requestValue);
      await expect(
        completeDefaultOperation(recovery, requestValue, responseValue),
      ).resolves.toMatchObject({ state: "complete", response: responseValue });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      }
    }
  });

  it("recovers lease-first initialization and persists the bound lease identity", async () => {
    const executionLeasePath = join(root, "journal-execution-lease.sqlite");
    await writeFile(executionLeasePath, Buffer.alloc(0), { mode: 0o600 });

    const initialized = await openUnclaimedJournal();
    await authorizeJournal(initialized);
    await initialized.close();

    const reopened = await openUnclaimedJournal();
    await expect(reopened.scan()).resolves.toMatchObject({
      authorizationClaims: [{ claimSha256: issuedAuthorizationClaimSha256 }],
      pendingOperationIds: [],
    });
  });

  it("recovers an empty main database left after lease-first publication", async () => {
    await writeFile(join(root, "journal-execution-lease.sqlite"), Buffer.alloc(0), { mode: 0o600 });
    await writeFile(join(root, "journal.sqlite"), Buffer.alloc(0), { mode: 0o600 });

    const initialized = await openUnclaimedJournal();
    await expect(initialized.scan()).resolves.toMatchObject({
      operations: [],
      pendingOperationIds: [],
    });
    await initialized.close();

    const reopened = await openUnclaimedJournal();
    await expect(reopened.scan()).resolves.toMatchObject({
      operations: [],
      pendingOperationIds: [],
    });
  });

  it("never recreates a missing execution lease for an existing journal", async () => {
    const setup = await openJournal();
    await setup.close();
    const executionLeasePath = join(root, "journal-execution-lease.sqlite");
    await unlink(executionLeasePath);

    await expect(openControllerJournal({ root, ...journalAuthority })).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_EXECUTION_LEASE_IDENTITY",
    });
    await expect(lstat(executionLeasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unlinked and recreated execution lease before a new claim", async () => {
    const setup = await openJournal();
    await setup.close();
    const executionLeasePath = join(root, "journal-execution-lease.sqlite");
    const replacementSeedPath = join(root, "replacement-execution-lease.sqlite");
    await writeFile(replacementSeedPath, Buffer.alloc(0), { mode: 0o600 });
    await unlink(executionLeasePath);
    await link(replacementSeedPath, executionLeasePath);
    await unlink(replacementSeedPath);

    await expect(openControllerJournal({ root, ...journalAuthority })).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_EXECUTION_LEASE_IDENTITY",
    });
  });

  it("prevents split-brain authority when a live owner's lease path is recreated", async () => {
    const owner = await openJournal();
    const requestValue = request({
      operation: { operationId: "operation-live-lease-replacement", sequence: 5 },
    });
    await beginDefaultOperation(owner, requestValue);
    const executionLeasePath = join(root, "journal-execution-lease.sqlite");
    const replacementSeedPath = join(root, "replacement-live-execution-lease.sqlite");
    await writeFile(replacementSeedPath, Buffer.alloc(0), { mode: 0o600 });
    await unlink(executionLeasePath);
    await link(replacementSeedPath, executionLeasePath);
    await unlink(replacementSeedPath);

    await expect(openControllerJournal({ root, ...journalAuthority })).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_EXECUTION_LEASE_IDENTITY",
    });
    await expect(owner.close()).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_TREE_CHANGED",
    });
    await expect(owner.close()).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_TREE_CHANGED",
    });
  });

  it("fails closed on a corrupted execution lease database before recording intent", async () => {
    const setup = await openJournal();
    await setup.close();
    await writeFile(join(root, "journal-execution-lease.sqlite"), "not a sqlite database", {
      mode: 0o600,
    });

    const journal = await openUnclaimedJournal();
    const requestValue = request({
      operation: { operationId: "operation-corrupt-execution-lease", sequence: 5 },
    });
    await journal.retainBlob(requestPayloadBytes);
    await expect(journal.claimOperation(requestValue)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_EXECUTION_LEASE",
    });
    await expect(journal.readOperation(requestValue.operation.operationId)).resolves.toBeNull();
    await expect(journal.scan()).resolves.toMatchObject({
      pendingOperationIds: [],
      operations: [expect.objectContaining({ operationId: "authorization-claim-floor-ascii" })],
    });
  });

  it("requires an exact retained request payload before recording intent", async () => {
    const journal = await openJournal();
    const missingPayloadRequest = request();
    await expect(journal.beginOperation(missingPayloadRequest)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_ARTIFACT",
    });
    await expect(
      journal.readOperation(missingPayloadRequest.operation.operationId),
    ).resolves.toBeNull();

    await journal.retainBlob(requestPayloadBytes);
    const mismatchedPayloadRequest = request({
      operation: { operationId: "operation-request-payload-mismatch", sequence: 4 },
      payload: { ...requestPayload, bytes: requestPayload.bytes + 1 },
    });
    await expect(journal.beginOperation(mismatchedPayloadRequest)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_ARTIFACT",
    });
    await expect(
      journal.readOperation(mismatchedPayloadRequest.operation.operationId),
    ).resolves.toBeNull();
  });

  it("requires an exact retained response payload before terminal commit", async () => {
    const journal = await openJournal();
    const requestValue = request({
      operation: { operationId: "operation-response-payload", sequence: 5 },
    });
    await beginDefaultOperation(journal, requestValue);
    const missingPayloadResponse = response(requestValue);
    await expect(
      journal.completeOperation({ request: requestValue, response: missingPayloadResponse }),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_ARTIFACT" });

    await journal.retainBlob(responsePayloadBytes);
    const mismatchedPayloadResponse = response(requestValue, [], {
      payload: { ...responsePayload, bytes: responsePayload.bytes + 1 },
    });
    await expect(
      journal.completeOperation({ request: requestValue, response: mismatchedPayloadResponse }),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_ARTIFACT" });
    await expect(
      journal.completeOperation({ request: requestValue, response: missingPayloadResponse }),
    ).resolves.toMatchObject({ state: "complete", response: missingPayloadResponse });

    expect(() => response(requestValue, [responsePayload])).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_PROTOCOL_ARTIFACT" }),
    );
  });

  it("recovers pre-link, partial, and post-link blob publications after reopen", async () => {
    let journal = await openJournal();
    const partialBytes = Buffer.from("partial controller artifact\n", "utf8");
    const partialSha256 = digest(partialBytes);
    const partialPublication = join(
      root,
      "blobs",
      "sha256",
      `.enduragent-controller-blob-${partialSha256}-${"a".repeat(24)}.tmp`,
    );
    await writeFile(partialPublication, partialBytes.subarray(0, 11), { mode: 0o600 });
    await journal.close();

    journal = await openJournal();
    await expect(lstat(partialPublication)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "blobs", "sha256", partialSha256))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const secondBytes = Buffer.from("complete before link controller artifact\n", "utf8");
    const secondSha256 = digest(secondBytes);
    const secondPublication = join(
      root,
      "blobs",
      "sha256",
      `.enduragent-controller-blob-${secondSha256}-${"b".repeat(24)}.tmp`,
    );
    const secondFinal = join(root, "blobs", "sha256", secondSha256);
    await writeFile(secondPublication, secondBytes, { mode: 0o600 });
    await journal.close();

    journal = await openJournal();
    await expect(lstat(secondPublication)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(secondFinal)).nlink).toBe(1);
    await expect(readFile(secondFinal)).resolves.toEqual(secondBytes);

    const thirdBytes = Buffer.from("linked before controller crash\n", "utf8");
    const thirdSha256 = digest(thirdBytes);
    const thirdPublication = join(
      root,
      "blobs",
      "sha256",
      `.enduragent-controller-blob-${thirdSha256}-${"c".repeat(24)}.tmp`,
    );
    const thirdFinal = join(root, "blobs", "sha256", thirdSha256);
    await writeFile(thirdPublication, thirdBytes, { mode: 0o600 });
    await link(thirdPublication, thirdFinal);
    await journal.close();

    journal = await openJournal();
    await expect(lstat(thirdPublication)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(thirdFinal)).nlink).toBe(1);
    await expect(readFile(thirdFinal)).resolves.toEqual(thirdBytes);
    const scan = await journal.scan();
    expect(scan.orphanBlobSha256s).toEqual([secondSha256, thirdSha256].sort());
  });

  it("fails closed on a content-address collision", async () => {
    const journal = await openJournal();
    const expected = Buffer.from("expected controller evidence", "utf8");
    const expectedSha256 = digest(expected);
    await writeFile(join(root, "blobs", "sha256", expectedSha256), "conflicting bytes", {
      mode: 0o600,
    });

    await expect(journal.retainBlob(expected)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_BLOB_COLLISION",
    });
  });

  it("enforces operation and blob limits before durable growth", async () => {
    const journal = await openUnclaimedJournal(root, {
      maxOperations: 2,
      maxBlobs: 4,
      maxBlobBytes: 1024,
      maxTotalBlobBytes: 4096,
    });
    await authorizeJournal(journal);
    await journal.retainBlob(requestPayloadBytes);
    const requestValue = request();
    await journal.beginOperation(requestValue);
    await expect(
      journal.beginOperation(request({ operation: { operationId: "operation-two", sequence: 2 } })),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_OPERATION_COUNT" });

    await journal.retainBlob(responsePayloadBytes);
    await expect(journal.retainBlob("third distinct controller blob\n")).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_BLOB_COUNT",
    });
    await expect(
      journal.completeOperation({ request: requestValue, response: response(requestValue) }),
    ).resolves.toMatchObject({ state: "complete" });
  });

  it("does not retain private keys, token-shaped documents, or configured secrets", async () => {
    const journal = await openJournal();
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyBytes = privateKey.export({ format: "der", type: "pkcs8" });

    await expect(journal.retainBlob(privateKeyBytes)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_SECRET_MATERIAL",
    });
    await expect(journal.retainBlob('{"token":"synthetic-value"}\n')).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_SECRET_MATERIAL",
    });
    await expect(journal.retainBlob(`prefix:${forbiddenValue}:suffix`)).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_SECRET_MATERIAL",
    });
    await journal.retainBlob(requestPayloadBytes);
    await expect(
      journal.beginOperation(request({ operation: { operationId: forbiddenValue } })),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_SECRET_MATERIAL" });

    const requestValue = request();
    const responseValue = response(requestValue);
    await journal.beginOperation(requestValue);
    await completeDefaultOperation(journal, requestValue, responseValue);
    const exported = JSON.stringify(await journal.assertClean());
    expect(exported).not.toMatch(/"(?:apiKey|credential|password|privateKey|secret|token)"/u);
    expect(exported).not.toContain(forbiddenValue);
  });

  it("rejects an aliased root and a replaced blob directory", async () => {
    const alias = `${root}-alias`;
    await symlink(root, alias, "dir");
    await expect(
      openControllerJournal({
        root: alias,
        ...journalAuthority,
      }),
    ).rejects.toMatchObject({ code: "CONTROLLER_JOURNAL_REPARSE" });
    await rm(alias, { force: true });

    const journal = await openJournal();
    await journal.close();
    const shaRoot = join(root, "blobs", "sha256");
    await rm(shaRoot, { recursive: true, force: true });
    await symlink(tmpdir(), shaRoot, "dir");
    await expect(openControllerJournal({ root, ...journalAuthority })).rejects.toMatchObject({
      code: "CONTROLLER_JOURNAL_REPARSE",
    });
  });
});
