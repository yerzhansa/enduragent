import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientHandshakeError,
  CoachClientProtocolError,
  CoachClientTransportUnavailableError,
  CoachRpcRemoteError,
  type CoachClient,
  type CoachClientTerminalEnvelope,
} from "@enduragent/coach-client";
import type {
  ActivityRestriction,
  CoachOperationProgressNotificationEnvelope,
  SyncRpcResult,
} from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "./coach-client";

interface TrainingSyncRestrictionWindow {
  readonly total: number;
  readonly visible: number;
  readonly restrictions: readonly ActivityRestriction[];
  readonly other: number;
}

export interface TrainingSyncDroppedActivities {
  readonly overall: TrainingSyncRestrictionWindow;
  readonly recent7Days: TrainingSyncRestrictionWindow;
}

export type TrainingSyncState =
  | { readonly status: "idle" }
  | { readonly status: "queued"; readonly operation: number }
  | { readonly status: "running"; readonly operation: number }
  | {
      readonly status: "succeeded";
      readonly operation: number;
      readonly kind: "published" | "no-change";
      readonly droppedActivities: TrainingSyncDroppedActivities;
    }
  | {
      readonly status: "failed";
      readonly operation: number;
      readonly kind: "partial" | "operation" | "indeterminate" | "protocol";
      readonly retryable: boolean;
    };

export type TrainingSyncStateListener = (state: TrainingSyncState) => void;

export interface TrainingSyncCoordinator {
  getState(): TrainingSyncState;
  subscribe(listener: TrainingSyncStateListener): () => void;
  request(): Promise<void>;
  dispose(): void;
}

function isIndeterminateFailure(error: unknown): boolean {
  return (
    error instanceof CoachClientDisconnectedError ||
    error instanceof CoachClientCallTimeoutError ||
    error instanceof CoachClientCallAbortedError ||
    error instanceof CoachClientHandshakeError ||
    error instanceof CoachClientTransportUnavailableError
  );
}

function isSameRestrictionWindow(
  left: TrainingSyncRestrictionWindow,
  right: TrainingSyncRestrictionWindow,
): boolean {
  return (
    left.total === right.total &&
    left.visible === right.visible &&
    left.other === right.other &&
    left.restrictions.length === right.restrictions.length &&
    left.restrictions.every((entry, index) => {
      const other = right.restrictions[index];
      return (
        other !== undefined &&
        entry.reason === other.reason &&
        entry.source === other.source &&
        entry.count === other.count
      );
    })
  );
}

function isSameTrainingSyncState(left: TrainingSyncState, right: TrainingSyncState): boolean {
  switch (left.status) {
    case "idle":
      return right.status === "idle";
    case "queued":
    case "running":
      return right.status === left.status && right.operation === left.operation;
    case "succeeded":
      return (
        right.status === "succeeded" &&
        right.operation === left.operation &&
        right.kind === left.kind &&
        isSameRestrictionWindow(right.droppedActivities.overall, left.droppedActivities.overall) &&
        isSameRestrictionWindow(
          right.droppedActivities.recent7Days,
          left.droppedActivities.recent7Days,
        )
      );
    case "failed":
      return (
        right.status === "failed" &&
        right.operation === left.operation &&
        right.kind === left.kind &&
        right.retryable === left.retryable
      );
  }
}

export function createTrainingSyncCoordinator(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly refreshTrainingContext: () => Promise<void>;
}): TrainingSyncCoordinator {
  let state: TrainingSyncState = { status: "idle" };
  let operation = 0;
  let epoch = 0;
  let inFlight: Promise<void> | undefined;
  let disposed = false;
  let needsReconnect = false;
  let failedClient: CoachClient | undefined;
  const listeners = new Set<TrainingSyncStateListener>();

  const current = (selectedEpoch: number): boolean => !disposed && selectedEpoch === epoch;
  const publish = (next: TrainingSyncState): void => {
    if (disposed) return;
    if (isSameTrainingSyncState(state, next)) return;
    state = next;
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {}
    }
  };
  const publishProtocol = (selectedEpoch: number, selectedOperation: number): void => {
    if (!current(selectedEpoch)) return;
    publish({
      status: "failed",
      operation: selectedOperation,
      kind: "protocol",
      retryable: false,
    });
  };

  const clientAfterFailure = async (previous: CoachClient | undefined): Promise<CoachClient> => {
    if (previous === undefined) return input.clients.getClient();
    const client = await input.clients.getClient();
    return client === previous ? input.clients.reconnect() : client;
  };

  const begin = (): Promise<void> => {
    const selectedEpoch = ++epoch;
    const selectedOperation = ++operation;
    publish({ status: "queued", operation: selectedOperation });

    let selectedClient: CoachClient | undefined;
    let admitted = false;
    let progress = 0;
    let requestId: string | number | undefined;
    let terminal: CoachClientTerminalEnvelope | undefined;
    let terminalValid = false;
    let callSettled = false;
    let protocolFault = false;

    const failProtocol = (): void => {
      if (!current(selectedEpoch)) return;
      protocolFault = true;
      if (callSettled || terminal !== undefined) {
        publishProtocol(selectedEpoch, selectedOperation);
      }
    };

    const onNotificationEnvelope = (envelope: CoachOperationProgressNotificationEnvelope): void => {
      if (!current(selectedEpoch)) return;
      if (callSettled || terminal !== undefined) {
        failProtocol();
        return;
      }
      if (
        envelope.jsonrpc !== "2.0" ||
        envelope.method !== "coach.operationProgress" ||
        envelope.params.requestMethod !== "sync"
      ) {
        failProtocol();
        return;
      }
      const event = envelope.params.event;
      if (progress === 0) {
        if (event.phase !== "started" || event.completed !== 0 || event.total !== 1) {
          failProtocol();
          return;
        }
        requestId = envelope.params.requestId;
        progress = 1;
        publish({ status: "running", operation: selectedOperation });
        return;
      }
      if (
        progress !== 1 ||
        envelope.params.requestId !== requestId ||
        event.phase !== "completed" ||
        event.completed !== 1 ||
        event.total !== 1
      ) {
        failProtocol();
        return;
      }
      progress = 2;
    };

    const onTerminalEnvelope = (envelope: CoachClientTerminalEnvelope): void => {
      if (!current(selectedEpoch)) return;
      if (callSettled || terminal !== undefined) {
        failProtocol();
        return;
      }
      terminal = envelope;
      const successTerminal = "result" in envelope && !("error" in envelope);
      const errorTerminal = "error" in envelope && !("result" in envelope);
      terminalValid =
        !protocolFault &&
        envelope.jsonrpc === "2.0" &&
        envelope.id === requestId &&
        ((successTerminal && progress === 2) || (errorTerminal && progress === 1));
      if (!terminalValid) failProtocol();
    };

    const task = (async () => {
      let result: SyncRpcResult | undefined;
      let failure: unknown;
      try {
        selectedClient = needsReconnect
          ? await clientAfterFailure(failedClient)
          : await input.clients.getClient();
        if (!current(selectedEpoch)) return;
        needsReconnect = false;
        failedClient = undefined;
        const call = selectedClient.call(
          "sync",
          {},
          {
            onNotificationEnvelope,
            onTerminalEnvelope,
          },
        );
        admitted = true;
        result = await call;
      } catch (error) {
        failure = error;
      }
      if (!current(selectedEpoch)) return;
      callSettled = true;

      if (protocolFault || failure instanceof CoachClientProtocolError) {
        publishProtocol(selectedEpoch, selectedOperation);
        return;
      }
      if (terminal === undefined) {
        if (failure !== undefined && !admitted) {
          if (isIndeterminateFailure(failure)) {
            needsReconnect = true;
            failedClient = selectedClient;
          }
          publish({
            status: "failed",
            operation: selectedOperation,
            kind: "operation",
            retryable: true,
          });
          return;
        }
        if (failure !== undefined && isIndeterminateFailure(failure)) {
          needsReconnect = true;
          failedClient = selectedClient;
          publish({
            status: "failed",
            operation: selectedOperation,
            kind: "indeterminate",
            retryable: true,
          });
          return;
        }
        publishProtocol(selectedEpoch, selectedOperation);
        return;
      }
      if (!terminalValid) {
        publishProtocol(selectedEpoch, selectedOperation);
        return;
      }

      const successTerminal = "result" in terminal;
      if (
        (successTerminal && failure !== undefined) ||
        (!successTerminal && !(failure instanceof CoachRpcRemoteError))
      ) {
        publishProtocol(selectedEpoch, selectedOperation);
        return;
      }

      try {
        await input.refreshTrainingContext();
      } catch {}
      if (!current(selectedEpoch)) return;
      if (protocolFault) {
        publishProtocol(selectedEpoch, selectedOperation);
        return;
      }
      if (!successTerminal) {
        publish({
          status: "failed",
          operation: selectedOperation,
          kind: "operation",
          retryable: true,
        });
        return;
      }
      if (result === undefined) {
        publishProtocol(selectedEpoch, selectedOperation);
      } else if (result.backfill === "pending-verification") {
        publish({
          status: "failed",
          operation: selectedOperation,
          kind: "operation",
          retryable: true,
        });
      } else if (result.published && result.referenceSucceeded) {
        publish({
          status: "succeeded",
          operation: selectedOperation,
          kind: "published",
          droppedActivities: result.droppedActivities,
        });
      } else if (!result.published && result.referenceSucceeded) {
        publish({
          status: "succeeded",
          operation: selectedOperation,
          kind: "no-change",
          droppedActivities: result.droppedActivities,
        });
      } else if (result.published) {
        publish({
          status: "failed",
          operation: selectedOperation,
          kind: "partial",
          retryable: true,
        });
      } else {
        publish({
          status: "failed",
          operation: selectedOperation,
          kind: "operation",
          retryable: true,
        });
      }
    })();

    inFlight = task;
    void task
      .finally(() => {
        if (inFlight === task) inFlight = undefined;
      })
      .catch(() => {});
    return task;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      try {
        listener(state);
      } catch {}
      return () => listeners.delete(listener);
    },
    request() {
      if (disposed || (state.status === "failed" && state.kind === "protocol")) {
        return Promise.resolve();
      }
      return inFlight ?? begin();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      inFlight = undefined;
      needsReconnect = false;
      failedClient = undefined;
      listeners.clear();
    },
  };
}
