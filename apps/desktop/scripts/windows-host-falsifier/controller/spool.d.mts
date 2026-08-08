import type { EvidenceStore } from "../evidence-store.mjs";
import type { ControllerJournal } from "./journal.mjs";
import type {
  ControllerRequest,
  ControllerResponse,
  ControllerResponseDraft,
  ControllerResponseOutcome,
} from "./protocol.mjs";

export const CONTROLLER_SPOOL_SCHEMA_VERSION: 1;
export const CONTROLLER_SPOOL_MECHANISM: "same-filesystem-hardlink-publication-v1";

export class ControllerSpoolError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function assertControllerSpoolBytesSafe(
  value: Uint8Array,
  options?: { readonly forbiddenValues?: readonly string[] },
): Buffer;

export function initializeControllerSpoolStores(options: {
  readonly inboxStore: EvidenceStore;
  readonly outboxStore: EvidenceStore;
}): Promise<{
  readonly schemaVersion: 1;
  readonly kind: "windows-host-probe-controller-spool-initialized";
  readonly mechanism: "same-filesystem-hardlink-publication-v1";
}>;

export interface ControllerSpoolExchangeResult {
  readonly response: ControllerResponse;
  readonly payloadBytes: Buffer;
  readonly artifacts: readonly {
    readonly reference: ControllerResponse["artifacts"][number];
    readonly bytes: Buffer;
  }[];
}

export interface ControllerSpoolClient {
  exchange(input: {
    readonly request: ControllerRequest;
    readonly payloadBytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<ControllerSpoolExchangeResult>;
}

export function createControllerSpoolClient(options: {
  readonly inboxStore: EvidenceStore;
  readonly outboxStore: EvidenceStore;
  readonly controllerIdentitySha256: string;
  readonly controllerVersion: string;
  readonly controllerPublicKeyBytes: Uint8Array;
  readonly forbiddenValues?: readonly string[];
  readonly monotonicNow?: () => number;
  readonly pollIntervalMs?: number;
  readonly responseTimeoutMs?: number;
}): ControllerSpoolClient;

export interface ControllerSpoolHandlerInput {
  readonly request: ControllerRequest;
  readonly payloadBytes: Buffer;
  readonly recoveryRequired: boolean;
}

export interface ControllerSpoolHandlerResult {
  readonly outcome: ControllerResponseOutcome;
  readonly payloadBytes: Uint8Array;
  readonly artifactBytes: readonly Uint8Array[];
}

export interface ControllerSpoolServer {
  processRequest(requestSha256: string): Promise<{
    readonly requestSha256: string;
    readonly responseSha256: string;
    readonly recovered: boolean;
    readonly handlerInvoked: boolean;
  }>;
  processPending(): Promise<
    readonly {
      readonly requestSha256: string;
      readonly responseSha256: string;
      readonly recovered: boolean;
      readonly handlerInvoked: boolean;
    }[]
  >;
}

export function createControllerSpoolServer(options: {
  readonly inboxStore: EvidenceStore;
  readonly outboxStore: EvidenceStore;
  readonly journal: ControllerJournal;
  readonly forbiddenValues?: readonly string[];
  readonly handler: (
    input: ControllerSpoolHandlerInput,
  ) => ControllerSpoolHandlerResult | Promise<ControllerSpoolHandlerResult>;
  readonly signResponseDigest: (input: {
    readonly responseSha256: string;
    readonly request: ControllerRequest;
    readonly responseDraft: ControllerResponseDraft;
  }) => string | Promise<string>;
}): Promise<ControllerSpoolServer>;
