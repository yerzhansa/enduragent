import type { ProbeExternalCheckpointEvidence, ProbeLabAttestation } from "./probe-contract.mjs";
import type { EvidenceStore } from "./evidence-store.mjs";

export class ContinuationError extends Error {
  readonly code: string;
}

export interface ContinuationScope {
  readonly campaignId: "f01-f10-native-probe-v1";
  readonly manifestSha256: string;
  readonly candidateSha256: string;
  readonly labAttestationSha256: string;
  readonly campaignRunId: string;
  readonly executionRunId: string;
  readonly executionBundleId: string;
  readonly executionBundleManifestSha256: string;
  readonly environmentId: string;
  readonly pathProfileId: string;
  readonly rowId: string;
  readonly variantId: string;
  readonly attemptId: string;
  readonly vmSnapshotId: string;
  readonly repetition: number;
  readonly chainId: string;
}

export interface ContinuationHeader extends ContinuationScope {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-continuation";
  readonly scopeSha256: string;
  readonly createdAt: string;
  readonly headerSha256: string;
}

export interface ContinuationEntry {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-continuation-entry";
  readonly chainId: string;
  readonly scopeSha256: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly previousEntrySha256: string | null;
  readonly createdAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly entrySha256: string;
}

export interface LocalContinuationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-local-continuation-receipt";
  readonly chainId: string;
  readonly scopeSha256: string;
  readonly headerSha256: string;
  readonly terminalEntrySha256: string;
  readonly entryCount: number;
  readonly closedAt: string;
  readonly receiptSha256: string;
}

export interface ConsumedExternalContinuationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-consumed-external-receipt";
  readonly chainId: string;
  readonly scopeSha256: string;
  readonly headerSha256: string;
  readonly terminalEntrySha256: string;
  readonly checkpointEvidence: ProbeExternalCheckpointEvidence;
  readonly consumedAt: string;
  readonly markerSha256: string;
}

export interface ExternalContinuationReceiptTransaction {
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-external-receipt-transaction";
  readonly chainId: string;
  readonly scopeSha256: string;
  readonly nonceSha256: string;
  readonly requestSha256: string;
  readonly receiptSha256: string;
  readonly marker: ConsumedExternalContinuationReceipt;
  readonly transactionSha256: string;
}

export interface ContinuationReference {
  readonly repetition: number;
  readonly chainId: string;
  readonly scopeSha256: string;
  readonly headerSha256: string;
  readonly terminalEntrySha256: string;
  readonly receiptSha256: string;
}

export function initializeContinuation(options: {
  readonly store: EvidenceStore;
  readonly scope: ContinuationScope;
  readonly now?: () => Date;
}): Promise<ContinuationHeader>;

export function loadContinuation(options: {
  readonly store: EvidenceStore;
  readonly chainId: string;
}): Promise<{
  readonly header: ContinuationHeader;
  readonly entries: readonly ContinuationEntry[];
  readonly nextSequence: number;
  readonly previousEntrySha256: string | null;
  readonly closure: LocalContinuationReceipt | ConsumedExternalContinuationReceipt | null;
}>;

export function appendContinuation(options: {
  readonly store: EvidenceStore;
  readonly chainId: string;
  readonly operationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
}): Promise<ContinuationEntry>;

export function closeContinuation(options: {
  readonly store: EvidenceStore;
  readonly chainId: string;
  readonly now?: () => Date;
}): Promise<ContinuationReference>;

export function consumeContinuationReceipt(options: {
  readonly store: EvidenceStore;
  readonly chainId: string;
  readonly checkpointEvidence: ProbeExternalCheckpointEvidence;
  readonly expectedController: ProbeLabAttestation["controller"];
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly now?: () => Date;
}): Promise<{
  readonly continuation: ContinuationReference;
  readonly checkpointEvidence: ProbeExternalCheckpointEvidence;
}>;
