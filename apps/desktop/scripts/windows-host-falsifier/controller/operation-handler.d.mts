import type { ControllerSpoolHandlerInput, ControllerSpoolHandlerResult } from "./spool.mjs";
import type {
  ControllerOperationKind,
  ControllerRequest,
  ControllerResponseOutcome,
} from "./protocol.mjs";

export type ControllerOperationHandlerErrorCode =
  | "CONTROLLER_OPERATION_HANDLER_SCHEMA"
  | "CONTROLLER_OPERATION_HANDLER_REGISTRY"
  | "CONTROLLER_OPERATION_HANDLER_INPUT"
  | "CONTROLLER_OPERATION_HANDLER_PAYLOAD_BINDING"
  | "CONTROLLER_OPERATION_HANDLER_DRIVER_RESULT"
  | "CONTROLLER_OPERATION_HANDLER_OUTCOME"
  | "CONTROLLER_OPERATION_HANDLER_ARTIFACT"
  | "CONTROLLER_OPERATION_HANDLER_ARTIFACT_PATH_COLLISION"
  | "CONTROLLER_OPERATION_HANDLER_ARTIFACT_DIGEST_COLLISION"
  | "CONTROLLER_OPERATION_HANDLER_PAYLOAD_ARTIFACT_COLLISION"
  | "CONTROLLER_OPERATION_HANDLER_OPERATION_KIND"
  | "CONTROLLER_OPERATION_HANDLER_INTENT"
  | "CONTROLLER_OPERATION_HANDLER_SCENARIO_RECEIPT"
  | "CONTROLLER_OPERATION_HANDLER_SCENARIO_BINDING"
  | "CONTROLLER_OPERATION_HANDLER_SCENARIO_REQUEST"
  | "CONTROLLER_OPERATION_HANDLER_SCENARIO_ARTIFACT"
  | "CONTROLLER_OPERATION_HANDLER_SCENARIO_RESULT"
  | "CONTROLLER_OPERATION_HANDLER_SCENARIO_OBSERVER"
  | "CONTROLLER_OPERATION_HANDLER_SCENARIO_ATTESTATION"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RECEIPT"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_BINDING"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_REQUEST"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_CHECKPOINT"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_ARTIFACT"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_RESULT"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_OBSERVER"
  | "CONTROLLER_OPERATION_HANDLER_HARD_CUT_ATTESTATION";

export class ControllerOperationHandlerError extends Error {
  readonly code: ControllerOperationHandlerErrorCode;
  readonly operationKind: ControllerOperationKind | null;
  constructor(
    code: ControllerOperationHandlerErrorCode,
    message: string,
    details?: { readonly operationKind?: ControllerOperationKind | null },
  );
}

export interface ControllerOperationDriverInput<Input = unknown> {
  readonly request: ControllerRequest;
  readonly input: Input;
  readonly recoveryRequired: boolean;
}

export interface ControllerOperationDriverArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ControllerOperationDriverResult<Result = unknown> {
  readonly outcome: ControllerResponseOutcome;
  readonly result: Result;
  readonly artifacts: readonly ControllerOperationDriverArtifact[];
}

export type ControllerOperationDriver<Input = unknown, Result = unknown> = (
  input: ControllerOperationDriverInput<Input>,
) => ControllerOperationDriverResult<Result> | Promise<ControllerOperationDriverResult<Result>>;

export type ControllerOperationDriverRegistry = {
  readonly [Kind in ControllerOperationKind]: ControllerOperationDriver;
};

export function createControllerOperationHandler(
  driverRegistry: ControllerOperationDriverRegistry,
): (
  input: ControllerSpoolHandlerInput,
) => ControllerSpoolHandlerResult | Promise<ControllerSpoolHandlerResult>;
