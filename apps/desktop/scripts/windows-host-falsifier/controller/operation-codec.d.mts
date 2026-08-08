import type {
  ControllerArtifactReference,
  ControllerOperationKind,
  ControllerResponseOutcome,
} from "./protocol.mjs";

export const CONTROLLER_OPERATION_CODEC_SCHEMA_VERSION: 1;
export const CONTROLLER_OPERATION_REQUEST_KIND: "windows-host-probe-controller-operation-request";
export const CONTROLLER_OPERATION_RESPONSE_KIND: "windows-host-probe-controller-operation-response";
export const CONTROLLER_OPERATION_REQUEST_MAXIMUM_BYTES: number;
export const CONTROLLER_OPERATION_RESPONSE_MAXIMUM_BYTES: number;

export type ControllerOperationCodecErrorCode =
  | "CONTROLLER_OPERATION_CODEC_OBJECT"
  | "CONTROLLER_OPERATION_CODEC_KEYS"
  | "CONTROLLER_OPERATION_CODEC_OPERATION_KIND"
  | "CONTROLLER_OPERATION_CODEC_SHA256"
  | "CONTROLLER_OPERATION_CODEC_VALUE_BOUND"
  | "CONTROLLER_OPERATION_CODEC_VALUE"
  | "CONTROLLER_OPERATION_CODEC_ABSOLUTE_PATH"
  | "CONTROLLER_OPERATION_CODEC_EVIDENCE_ROOT"
  | "CONTROLLER_OPERATION_CODEC_BYTES_BOUND"
  | "CONTROLLER_OPERATION_CODEC_UTF8"
  | "CONTROLLER_OPERATION_CODEC_JSON"
  | "CONTROLLER_OPERATION_CODEC_CANONICAL"
  | "CONTROLLER_OPERATION_CODEC_ENVELOPE"
  | "CONTROLLER_OPERATION_CODEC_ARTIFACT_PATH"
  | "CONTROLLER_OPERATION_CODEC_ARTIFACT_BINDING"
  | "CONTROLLER_OPERATION_CODEC_ARTIFACT_ORDER"
  | "CONTROLLER_OPERATION_CODEC_ARTIFACT_CASE_COLLISION"
  | "CONTROLLER_OPERATION_CODEC_ARTIFACT_REFERENCE"
  | "CONTROLLER_OPERATION_CODEC_ARTIFACT_SET"
  | "CONTROLLER_OPERATION_CODEC_OPERATION_MISMATCH"
  | "CONTROLLER_OPERATION_CODEC_RESPONSE_OUTCOME";

export class ControllerOperationCodecError extends Error {
  readonly code: ControllerOperationCodecErrorCode;
  readonly operationKind: ControllerOperationKind | null;
  readonly outcome: ControllerResponseOutcome | null;
  constructor(
    code: ControllerOperationCodecErrorCode,
    message: string,
    details?: {
      readonly operationKind?: ControllerOperationKind | null;
      readonly outcome?: ControllerResponseOutcome | null;
    },
  );
}

export interface ControllerOperationRequestEnvelope<
  Kind extends ControllerOperationKind = ControllerOperationKind,
  Input = unknown,
> {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-operation-request";
  readonly operationKind: Kind;
  readonly input: Input;
}

export interface ControllerOperationArtifactBinding {
  readonly path: string;
  readonly sha256: string;
}

export interface ControllerOperationResponseEnvelope<
  Kind extends ControllerOperationKind = ControllerOperationKind,
  Result = unknown,
> {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-operation-response";
  readonly operationKind: Kind;
  readonly result: Result;
  readonly artifactBindings: readonly ControllerOperationArtifactBinding[];
}

export interface EncodedControllerOperationRequest<
  Kind extends ControllerOperationKind = ControllerOperationKind,
  Input = unknown,
> {
  readonly envelope: ControllerOperationRequestEnvelope<Kind, Input>;
  readonly bytes: Uint8Array;
  readonly intentSha256: string;
}

export interface EncodedControllerOperationResponse<
  Kind extends ControllerOperationKind = ControllerOperationKind,
  Result = unknown,
> {
  readonly envelope: ControllerOperationResponseEnvelope<Kind, Result>;
  readonly bytes: Uint8Array;
}

export function encodeControllerOperationRequest<
  Kind extends ControllerOperationKind,
  Input = unknown,
>(value: {
  readonly operationKind: Kind;
  readonly input: Input;
}): EncodedControllerOperationRequest<Kind, Input>;

export function decodeControllerOperationRequest<
  Kind extends ControllerOperationKind = ControllerOperationKind,
  Input = unknown,
>(
  bytes: Uint8Array,
  options?: { readonly expectedOperationKind?: Kind },
): EncodedControllerOperationRequest<Kind, Input>;

export function encodeControllerOperationResponse<
  Kind extends ControllerOperationKind,
  Result = unknown,
>(value: {
  readonly operationKind: Kind;
  readonly result: Result;
  readonly artifactBindings: readonly ControllerOperationArtifactBinding[];
}): EncodedControllerOperationResponse<Kind, Result>;

export function decodeControllerOperationResponse<
  Kind extends ControllerOperationKind,
  Result = unknown,
>(
  bytes: Uint8Array,
  options: {
    readonly expectedOperationKind: Kind;
    readonly outcome: ControllerResponseOutcome;
    readonly artifacts: readonly ControllerArtifactReference[];
  },
): EncodedControllerOperationResponse<Kind, Result>;
