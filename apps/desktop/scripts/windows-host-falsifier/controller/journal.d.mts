import type {
  ControllerArtifactReference,
  ControllerRequest,
  ControllerResponse,
} from "./protocol.mjs";

export const CONTROLLER_JOURNAL_SCHEMA_VERSION: 1;

export class ControllerJournalError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface PendingControllerOperation {
  readonly operationId: string;
  readonly state: "pending";
  readonly request: ControllerRequest;
  readonly response: null;
}

export interface CompleteControllerOperation {
  readonly operationId: string;
  readonly state: "complete";
  readonly request: ControllerRequest;
  readonly response: ControllerResponse;
}

export type ControllerOperationRecord = PendingControllerOperation | CompleteControllerOperation;

export interface ControllerAuthorizationClaimRecord {
  readonly environmentId: string;
  readonly pathProfileId: string;
  readonly claimSha256: string;
  readonly issuanceOperationId: string;
}

export interface ControllerJournalScan {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-journal-scan";
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly campaignRunId: string;
  readonly candidateSha256: string;
  readonly runPlanSha256: string;
  readonly runAuthorizationSha256: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeySha256: string;
  readonly controllerVersion: string;
  readonly journalMode: "wal";
  readonly synchronous: "FULL";
  readonly operations: readonly ControllerOperationRecord[];
  readonly authorizationClaims: readonly ControllerAuthorizationClaimRecord[];
  readonly pendingOperationIds: readonly string[];
  readonly blobs: readonly ControllerArtifactReference[];
  readonly orphanBlobSha256s: readonly string[];
}

export interface ControllerJournal {
  readonly root: string;
  readonly controllerIdentitySha256: string;
  claimOperation(request: ControllerRequest): Promise<{
    readonly record: ControllerOperationRecord;
    readonly created: boolean;
  }>;
  beginOperation(request: ControllerRequest): Promise<ControllerOperationRecord>;
  retainBlob(value: Uint8Array | string): Promise<ControllerArtifactReference>;
  readBlob(reference: ControllerArtifactReference): Promise<Buffer>;
  completeOperation(input: {
    readonly request: ControllerRequest;
    readonly response: ControllerResponse;
    readonly issuedAuthorizationClaimSha256?: string | null;
  }): Promise<CompleteControllerOperation>;
  readOperation(operationId: string): Promise<ControllerOperationRecord | null>;
  scan(): Promise<ControllerJournalScan>;
  assertClean(): Promise<ControllerJournalScan>;
  assertRootStable(): Promise<void>;
  close(): Promise<void>;
}

export function openControllerJournal(options: {
  readonly root: string;
  readonly controllerIdentitySha256: string;
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly controllerVersion: string;
  readonly campaignRunId: string;
  readonly candidateSha256: string;
  readonly runPlanSha256: string;
  readonly runAuthorizationSha256: string;
  readonly forbiddenValues?: readonly string[];
  readonly limits?: Partial<{
    readonly maxBlobBytes: number;
    readonly maxBlobs: number;
    readonly maxTotalBlobBytes: number;
    readonly maxOperations: number;
  }>;
}): Promise<ControllerJournal>;
