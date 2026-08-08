export const CONTROLLER_PROTOCOL_SCHEMA_VERSION: 1;
export const CONTROLLER_REQUEST_KIND: "windows-host-probe-controller-request";
export const CONTROLLER_RESPONSE_KIND: "windows-host-probe-controller-response";
export const CONTROLLER_OPERATION_KINDS: readonly [
  "capture-disposition-observation",
  "controller-observation",
  "evidence-quiescence-abandon",
  "evidence-quiescence-acquire",
  "evidence-quiescence-capture",
  "evidence-quiescence-complete",
  "evidence-quiescence-renew",
  "hard-cut-receipt-read",
  "hard-cut-request-claim",
  "run-authorization-claim",
  "scenario-action",
  "source-transcript-sign",
];
export const CONTROLLER_RESPONSE_OUTCOMES: readonly ["FAILED", "INCONCLUSIVE", "SUCCEEDED"];

export class ControllerProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export type ControllerOperationKind = (typeof CONTROLLER_OPERATION_KINDS)[number];
export type ControllerResponseOutcome = (typeof CONTROLLER_RESPONSE_OUTCOMES)[number];

export interface ControllerCoordinateBinding {
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly attemptId: string;
  readonly environmentId: "win11-current" | "win11-floor";
  readonly pathProfileId: "ascii" | "spaces-unicode";
  readonly workId: string | null;
  readonly rowId: `F-${string}` | null;
  readonly variantId: string | null;
  readonly repetition: number | null;
}

export interface ControllerOperationBinding {
  readonly operationId: string;
  readonly kind: ControllerOperationKind;
  readonly sequence: number;
}

export interface ControllerRequestDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-request";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly runPlanSha256: string;
  readonly runAuthorizationSha256: string;
  readonly runAuthorizationClaimSha256: string | null;
  readonly coordinate: ControllerCoordinateBinding;
  readonly operation: ControllerOperationBinding;
  readonly intentSha256: string;
  readonly payload: ControllerArtifactReference;
  readonly controllerIdentitySha256: string;
}

export interface ControllerRequest extends ControllerRequestDraft {
  readonly requestSha256: string;
}

export interface ControllerArtifactReference {
  readonly blobPath: `blobs/sha256/${string}`;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ControllerResponseDraft {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-response";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly requestSha256: string;
  readonly outcome: ControllerResponseOutcome;
  readonly payload: ControllerArtifactReference;
  readonly artifacts: readonly ControllerArtifactReference[];
  readonly controllerIdentitySha256: string;
  readonly controllerVersion: string;
  readonly controllerPublicKeySha256: string;
  readonly signatureAlgorithm: "Ed25519";
}

export interface ControllerResponse extends ControllerResponseDraft {
  readonly signatureBase64: string;
  readonly responseSha256: string;
}

export function deriveControllerRequestDigest(
  value: ControllerRequestDraft | ControllerRequest,
): string;
export function validateControllerRequest(value: unknown): ControllerRequest;
export function deriveControllerResponseDigest(
  value: ControllerResponseDraft | ControllerResponse,
): string;
export function validateControllerResponse(value: unknown): ControllerResponse;
export function verifyControllerResponse(
  value: unknown,
  options: {
    readonly request: ControllerRequest;
    readonly controllerIdentitySha256: string;
    readonly controllerVersion: string;
    readonly controllerPublicKeyBytes: Uint8Array;
  },
): ControllerResponse;
