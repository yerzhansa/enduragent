import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONTROLLER_OPERATION_REQUEST_MAXIMUM_BYTES,
  ControllerOperationCodecError,
  decodeControllerOperationRequest,
  decodeControllerOperationResponse,
  encodeControllerOperationRequest,
  encodeControllerOperationResponse,
  type ControllerOperationArtifactBinding,
} from "../scripts/windows-host-falsifier/controller/operation-codec.mjs";
import {
  CONTROLLER_OPERATION_KINDS,
  type ControllerArtifactReference,
} from "../scripts/windows-host-falsifier/controller/protocol.mjs";
import { canonicalProbeJson } from "../scripts/windows-host-falsifier/probe-contract.mjs";
import { createProbeControllerPreparedAuthority } from "../scripts/windows-host-falsifier/probe-controller-prepared-authority.mjs";
import { createPreparedContextFixture } from "./fixtures/windows-host/prepared-context.js";

function artifact(sha256: string, bytes = 1): ControllerArtifactReference {
  return { blobPath: `blobs/sha256/${sha256}`, bytes, sha256 };
}

function binding(path: string, sha256: string): ControllerOperationArtifactBinding {
  return { path, sha256 };
}

const firstSha256 = "1".repeat(64);
const secondSha256 = "2".repeat(64);
const thirdSha256 = "3".repeat(64);
const firstArtifact = artifact(firstSha256);
const secondArtifact = artifact(secondSha256, 2);

describe("Windows host probe controller operation codec", () => {
  it("round-trips all controller operation kinds without applying domain semantics", () => {
    for (const operationKind of CONTROLLER_OPERATION_KINDS) {
      const encodedRequest = encodeControllerOperationRequest({
        operationKind,
        input: {
          opaque: [operationKind, 7, true, null],
          signatureBase64: "/w==",
        },
      });
      expect(encodedRequest.bytes.toString()).toBe(canonicalProbeJson(encodedRequest.envelope));
      expect(encodedRequest.intentSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        decodeControllerOperationRequest(encodedRequest.bytes, {
          expectedOperationKind: operationKind,
        }),
      ).toEqual(encodedRequest);

      const encodedResponse = encodeControllerOperationResponse({
        operationKind,
        result: ["opaque-result", operationKind, 11, null],
        artifactBindings: [
          binding("artifacts/first.json", secondSha256),
          binding("artifacts/second.json", firstSha256),
        ],
      });
      expect(encodedResponse.bytes.toString()).toBe(canonicalProbeJson(encodedResponse.envelope));
      expect(
        decodeControllerOperationResponse(encodedResponse.bytes, {
          expectedOperationKind: operationKind,
          outcome: "SUCCEEDED",
          artifacts: [firstArtifact, secondArtifact],
        }),
      ).toEqual(encodedResponse);
    }
  });

  it("derives the intent digest from the complete domain-separated request envelope", () => {
    const encoded = encodeControllerOperationRequest({
      operationKind: "scenario-action",
      input: { actionId: "one", count: 1 },
    });
    const expected = createHash("sha256")
      .update(
        canonicalProbeJson({
          domain: "enduragent.windows-host-probe-controller-operation-intent.v1",
          request: encoded.envelope,
        }),
        "utf8",
      )
      .digest("hex");
    expect(encoded.intentSha256).toBe(expected);
    expect(
      encodeControllerOperationRequest({
        operationKind: "scenario-action",
        input: { actionId: "one", count: 2 },
      }).intentSha256,
    ).not.toBe(encoded.intentSha256);
  });

  it("rejects mismatched expected operation kinds", () => {
    const request = encodeControllerOperationRequest({
      operationKind: "scenario-action",
      input: null,
    });
    expect(() =>
      decodeControllerOperationRequest(request.bytes, {
        expectedOperationKind: "source-transcript-sign",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_OPERATION_MISMATCH" }),
    );

    const response = encodeControllerOperationResponse({
      operationKind: "scenario-action",
      result: null,
      artifactBindings: [],
    });
    expect(() =>
      decodeControllerOperationResponse(response.bytes, {
        expectedOperationKind: "source-transcript-sign",
        outcome: "SUCCEEDED",
        artifacts: [],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_OPERATION_MISMATCH" }),
    );
  });

  it("requires exact canonical request and response envelopes", () => {
    const request = encodeControllerOperationRequest({
      operationKind: "controller-observation",
      input: { value: 1 },
    });
    expect(() =>
      decodeControllerOperationRequest(Buffer.from(JSON.stringify(request.envelope), "utf8")),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_CANONICAL" }));
    expect(() =>
      decodeControllerOperationRequest(
        Buffer.from(canonicalProbeJson({ ...request.envelope, unknown: true }), "utf8"),
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_KEYS" }));
    const { input: _input, ...requestWithoutInput } = request.envelope;
    expect(() =>
      decodeControllerOperationRequest(
        Buffer.from(canonicalProbeJson(requestWithoutInput), "utf8"),
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_KEYS" }));

    const response = encodeControllerOperationResponse({
      operationKind: "controller-observation",
      result: { value: 2 },
      artifactBindings: [],
    });
    expect(() =>
      decodeControllerOperationResponse(
        Buffer.from(canonicalProbeJson({ ...response.envelope, unknown: true }), "utf8"),
        {
          expectedOperationKind: "controller-observation",
          outcome: "SUCCEEDED",
          artifacts: [],
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_KEYS" }));
    const { result: _result, ...responseWithoutResult } = response.envelope;
    expect(() =>
      decodeControllerOperationResponse(
        Buffer.from(canonicalProbeJson(responseWithoutResult), "utf8"),
        {
          expectedOperationKind: "controller-observation",
          outcome: "SUCCEEDED",
          artifacts: [],
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_KEYS" }));
  });

  it("rejects non-JSON-safe values, invalid UTF-8, and oversized envelopes", () => {
    expect(() =>
      encodeControllerOperationRequest({
        operationKind: "controller-observation",
        input: { missing: undefined },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_VALUE" }));
    expect(() => decodeControllerOperationRequest(Buffer.from([0xff]))).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_UTF8" }),
    );
    expect(() =>
      encodeControllerOperationRequest({
        operationKind: "controller-observation",
        input: "x".repeat(CONTROLLER_OPERATION_REQUEST_MAXIMUM_BYTES),
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_BYTES_BOUND" }));
  });

  it("recursively excludes evidenceRoot and absolute path strings from request input", () => {
    expect(() =>
      encodeControllerOperationRequest({
        operationKind: "scenario-action",
        input: { nested: [{ evidenceRoot: "relative-but-forbidden" }] },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_EVIDENCE_ROOT" }));

    for (const absolutePath of [
      "/private/tmp/evidence",
      "C:\\probe\\evidence",
      "\\\\controller-host\\share",
      "\\\\?\\C:\\probe",
      "file:///private/tmp/evidence",
    ]) {
      expect(() =>
        encodeControllerOperationRequest({
          operationKind: "scenario-action",
          input: { nested: { value: absolutePath } },
        }),
      ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ABSOLUTE_PATH" }));
    }
    expect(() =>
      encodeControllerOperationRequest({
        operationKind: "scenario-action",
        input: { nested: { "/private/tmp/evidence": true } },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ABSOLUTE_PATH" }));
  });

  it("rejects the full local prepared context but round-trips its root-free authority", () => {
    const preparedContext = createPreparedContextFixture();
    expect(() =>
      encodeControllerOperationRequest({
        operationKind: "scenario-action",
        input: { preparedContext },
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ABSOLUTE_PATH" }));

    const preparedAuthority = createProbeControllerPreparedAuthority(preparedContext);
    const encoded = encodeControllerOperationRequest({
      operationKind: "scenario-action",
      input: { preparedAuthority },
    });
    const decoded = decodeControllerOperationRequest(encoded.bytes, {
      expectedOperationKind: "scenario-action",
    });
    expect(decoded.envelope.input).toEqual({ preparedAuthority });
    expect(decoded.envelope.input).not.toHaveProperty("preparedContext");
  });

  it("fails closed on signed non-success outcomes before decoding bytes or artifacts", () => {
    for (const outcome of ["FAILED", "INCONCLUSIVE"] as const) {
      let artifactsRead = false;
      const options = {
        expectedOperationKind: "scenario-action" as const,
        outcome,
        get artifacts() {
          artifactsRead = true;
          return [firstArtifact];
        },
      };
      expect(() => decodeControllerOperationResponse(Buffer.from([0xff]), options)).toThrowError(
        expect.objectContaining({
          code: "CONTROLLER_OPERATION_CODEC_RESPONSE_OUTCOME",
          outcome,
        }),
      );
      expect(artifactsRead).toBe(false);
    }
  });

  it("rejects unsafe, unordered, colliding, and multiply-bound artifact paths", () => {
    for (const path of [
      "/absolute/result.json",
      "C:\\absolute\\result.json",
      "../escape.json",
      "safe/../escape.json",
      "safe\\result.json",
      "safe/NUL.txt",
      "safe/result.json ",
      "safe/résult.json",
    ]) {
      expect(() =>
        encodeControllerOperationResponse({
          operationKind: "scenario-action",
          result: null,
          artifactBindings: [binding(path, firstSha256)],
        }),
      ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_PATH" }));
    }

    expect(() =>
      encodeControllerOperationResponse({
        operationKind: "scenario-action",
        result: null,
        artifactBindings: [
          binding("z/result.json", firstSha256),
          binding("a/result.json", secondSha256),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_ORDER" }));
    expect(() =>
      encodeControllerOperationResponse({
        operationKind: "scenario-action",
        result: null,
        artifactBindings: [
          binding("A/result.json", firstSha256),
          binding("a/result.json", secondSha256),
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_CASE_COLLISION" }),
    );
    expect(() =>
      encodeControllerOperationResponse({
        operationKind: "scenario-action",
        result: null,
        artifactBindings: [
          binding("a/result.json", firstSha256),
          binding("b/result.json", firstSha256),
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_BINDING" }),
    );
  });

  it("binds artifact SHA-256 values exactly to sorted signed response references", () => {
    const oneBinding = encodeControllerOperationResponse({
      operationKind: "scenario-action",
      result: { accepted: true },
      artifactBindings: [binding("result/first.json", firstSha256)],
    });
    for (const artifacts of [[], [firstArtifact, secondArtifact], [artifact(secondSha256)]]) {
      expect(() =>
        decodeControllerOperationResponse(oneBinding.bytes, {
          expectedOperationKind: "scenario-action",
          outcome: "SUCCEEDED",
          artifacts,
        }),
      ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_SET" }));
    }

    const twoBindings = encodeControllerOperationResponse({
      operationKind: "scenario-action",
      result: null,
      artifactBindings: [
        binding("result/first.json", firstSha256),
        binding("result/second.json", secondSha256),
      ],
    });
    expect(() =>
      decodeControllerOperationResponse(twoBindings.bytes, {
        expectedOperationKind: "scenario-action",
        outcome: "SUCCEEDED",
        artifacts: [secondArtifact, firstArtifact],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_REFERENCE" }),
    );
    expect(() =>
      decodeControllerOperationResponse(twoBindings.bytes, {
        expectedOperationKind: "scenario-action",
        outcome: "SUCCEEDED",
        artifacts: [firstArtifact, artifact(thirdSha256)],
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_OPERATION_CODEC_ARTIFACT_SET" }));
  });

  it("uses a typed error for every codec rejection", () => {
    try {
      decodeControllerOperationRequest(Buffer.from("not JSON", "utf8"));
      throw new Error("expected decode failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ControllerOperationCodecError);
      expect(error).toMatchObject({ code: "CONTROLLER_OPERATION_CODEC_JSON" });
    }
  });
});
