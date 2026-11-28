import {
  CoachClientCallAbortedError,
  CoachClientCallNotAdmittedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientHandshakeError,
  CoachClientProtocolError,
  CoachClientTransportUnavailableError,
  CoachRpcRemoteError,
  type CoachClient,
  type CoachClientCallOptions,
  type CoachClientTerminalEnvelope,
} from "@enduragent/coach-client";
import type { CoachRpcNotification, SyncRpcResult } from "@enduragent/coach-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import { createTrainingSyncCoordinator, type TrainingSyncState } from "../src/training-sync";

type SyncOptions = CoachClientCallOptions<"sync">;

const published: SyncRpcResult = {
  schemaVersion: 1,
  published: true,
  referenceSucceeded: true,
  requests: { store: 1, reference: 1, total: 2 },
  droppedActivities: {
    overall: { total: 0, visible: 0, restrictions: [], other: 0 },
    recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
  },
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function envelope(
  phase: "started" | "completed",
  completed: number,
  total = 1,
  requestId: string | number = 1,
): CoachRpcNotification<"sync"> {
  return {
    jsonrpc: "2.0",
    method: "coach.operationProgress",
    params: { requestId, requestMethod: "sync", event: { phase, completed, total } },
  };
}

function terminal(
  result: SyncRpcResult = published,
  id: string | number = 1,
): CoachClientTerminalEnvelope {
  return { jsonrpc: "2.0", id, result };
}

function remoteTerminal(id: string | number = 1): CoachClientTerminalEnvelope {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32_000, message: "private daemon detail" },
  };
}

function clientWith(
  implementation: (options: SyncOptions) => Promise<SyncRpcResult>,
): CoachClient & { readonly callMock: ReturnType<typeof vi.fn> } {
  const callMock = vi.fn(async (method: string, params: unknown, options?: SyncOptions) => {
    expect(method).toBe("sync");
    expect(params).toEqual({});
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("signal");
    return implementation(options!);
  });
  return {
    handshake: {} as CoachClient["handshake"],
    call: callMock as unknown as CoachClient["call"],
    callMock,
    close: vi.fn(async () => {}),
  };
}

function providerWith(client: CoachClient): DesktopCoachClientProvider {
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    onConnectionOpen: () => () => {},
    close: vi.fn(async () => {}),
  };
}

function reopeningProvider(input: {
  readonly current: CoachClient;
  readonly replacement: CoachClient;
}): {
  readonly clients: DesktopCoachClientProvider;
  readonly open: () => void;
  readonly listening: () => number;
} {
  const listeners = new Set<() => void>();
  return {
    clients: {
      getClient: vi.fn(async () => input.current),
      reconnect: vi.fn(async () => input.replacement),
      close: vi.fn(async () => {}),
      onConnectionOpen: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    },
    open: () => {
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function exactCall(options: SyncOptions, result: SyncRpcResult): Promise<SyncRpcResult> {
  options.onNotificationEnvelope?.(envelope("started", 0));
  options.onNotificationEnvelope?.(envelope("completed", 1));
  options.onTerminalEnvelope?.(terminal(result));
  return result;
}

describe("training sync coordinator", () => {
  it("queues synchronously, validates the exact progress sequence, and announces only after refresh", async () => {
    const clientGate = deferred<CoachClient>();
    const callGate = deferred<SyncRpcResult>();
    const refreshGate = deferred<void>();
    let options!: SyncOptions;
    const client = clientWith((selected) => {
      options = selected;
      return callGate.promise;
    });
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(() => clientGate.promise),
      reconnect: vi.fn(async () => client),
      onConnectionOpen: () => () => {},
      close: vi.fn(async () => {}),
    };
    const refreshTrainingContext = vi.fn(() => refreshGate.promise);
    const states: TrainingSyncState[] = [];
    const coordinator = createTrainingSyncCoordinator({ clients, refreshTrainingContext });
    coordinator.subscribe((state) => states.push(state));

    const first = coordinator.request();
    const second = coordinator.request();
    expect(first).toBe(second);
    expect(states).toEqual([{ status: "idle" }, { status: "queued", operation: 1 }]);
    expect(clients.getClient).toHaveBeenCalledTimes(1);
    expect(client.callMock).not.toHaveBeenCalled();

    clientGate.resolve(client);
    await Promise.resolve();
    expect(client.callMock).toHaveBeenCalledTimes(1);
    expect(() => options.onNotificationEnvelope?.(envelope("started", 0))).not.toThrow();
    expect(states.at(-1)).toEqual({ status: "running", operation: 1 });
    expect(() => options.onNotificationEnvelope?.(envelope("completed", 1))).not.toThrow();
    expect(states).toHaveLength(3);
    expect(() => options.onTerminalEnvelope?.(terminal())).not.toThrow();
    callGate.resolve(published);
    await vi.waitFor(() => expect(refreshTrainingContext).toHaveBeenCalledTimes(1));
    expect(states.at(-1)).toEqual({ status: "running", operation: 1 });

    refreshGate.resolve();
    await first;
    expect(states.at(-1)).toEqual({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
  });

  it.each([
    [
      true,
      true,
      {
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      },
    ],
    [
      false,
      true,
      {
        status: "succeeded",
        operation: 1,
        kind: "no-change",
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      },
    ],
    [true, false, { status: "failed", operation: 1, kind: "partial", retryable: true }],
    [false, false, { status: "failed", operation: 1, kind: "operation", retryable: true }],
  ] as const)(
    "maps published=%s Reference-success=%s after exactly one refresh",
    async (isPublished, referenceSucceeded, expected) => {
      const result = { ...published, published: isPublished, referenceSucceeded };
      const client = clientWith((options) => exactCall(options, result));
      const refreshTrainingContext = vi.fn(async () => {});
      const coordinator = createTrainingSyncCoordinator({
        clients: providerWith(client),
        refreshTrainingContext,
      });
      await coordinator.request();
      expect(coordinator.getState()).toEqual(expected);
      expect(refreshTrainingContext).toHaveBeenCalledTimes(1);
    },
  );

  it("carries the dropped-activity split onto the succeeded state", async () => {
    const result: SyncRpcResult = {
      ...published,
      droppedActivities: {
        overall: {
          total: 67,
          visible: 5,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 60 }],
          other: 2,
        },
        recent7Days: {
          total: 5,
          visible: 1,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 4 }],
          other: 0,
        },
      },
    };
    const client = clientWith((options) => exactCall(options, result));
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext: vi.fn(async () => {}),
    });

    await coordinator.request();

    expect(coordinator.getState()).toEqual({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: result.droppedActivities,
    });
  });

  it("maps a pending-verification backfill to a retryable operation failure", async () => {
    const result: SyncRpcResult = { ...published, backfill: "pending-verification" };
    const client = clientWith((options) => exactCall(options, result));
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext,
    });
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "operation",
      retryable: true,
    });
    expect(refreshTrainingContext).toHaveBeenCalledTimes(1);
  });

  it("reports a keyless sync as not in use while an intervals.icu sign-in is saved", async () => {
    const keyless: SyncRpcResult = {
      ...published,
      backfill: "skipped-no-credential",
      published: false,
      requests: { store: 0, reference: 1, total: 1 },
    };
    const client = clientWith((options) => exactCall(options, keyless));
    let saved = true;
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext: vi.fn(async () => {}),
      intervalsSignInSaved: () => saved,
    });

    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "not-in-use",
      retryable: true,
    });

    saved = false;
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "succeeded",
      operation: 2,
      kind: "no-change",
      droppedActivities: published.droppedActivities,
    });
  });

  it("keeps a keyless sync as no change when nothing tells it a sign-in is saved", async () => {
    const keyless: SyncRpcResult = {
      ...published,
      backfill: "skipped-no-credential",
      published: false,
      requests: { store: 0, reference: 1, total: 1 },
    };
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(clientWith((options) => exactCall(options, keyless))),
      refreshTrainingContext: vi.fn(async () => {}),
    });

    await coordinator.request();
    expect(coordinator.getState()).toMatchObject({ status: "succeeded", kind: "no-change" });
  });

  it("treats an authoritative remote terminal as a fixed operation failure and refreshes once", async () => {
    const client = clientWith(async (options) => {
      options.onNotificationEnvelope?.(envelope("started", 0));
      options.onTerminalEnvelope?.(remoteTerminal());
      throw new CoachRpcRemoteError(-32_000, "private daemon detail", {
        cursor: "private-cursor",
      });
    });
    const refreshTrainingContext = vi.fn(async () => {});
    const states: TrainingSyncState[] = [];
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext,
    });
    coordinator.subscribe((state) => states.push(state));
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "operation",
      retryable: true,
    });
    expect(refreshTrainingContext).toHaveBeenCalledTimes(1);
    expect(states).toEqual([
      { status: "idle" },
      { status: "queued", operation: 1 },
      { status: "running", operation: 1 },
      { status: "failed", operation: 1, kind: "operation", retryable: true },
    ]);
    expect(JSON.stringify(states)).not.toMatch(/private|cursor/u);
  });

  it("keeps a quiet sync's failure out of view, but shows it once Sync is pressed during it", async () => {
    const failing = async (options: SyncOptions): Promise<SyncRpcResult> => {
      options.onNotificationEnvelope?.(envelope("started", 0));
      options.onTerminalEnvelope?.(remoteTerminal());
      throw new CoachRpcRemoteError(-32_000, "private daemon detail");
    };
    const states: TrainingSyncState[] = [];
    const quiet = createTrainingSyncCoordinator({
      clients: providerWith(clientWith(failing)),
      refreshTrainingContext: vi.fn(async () => {}),
    });
    quiet.subscribe((state) => states.push(state));
    await quiet.request({ quiet: true });
    expect(states).toEqual([
      { status: "idle" },
      { status: "queued", operation: 1 },
      { status: "running", operation: 1 },
      { status: "idle" },
    ]);

    const held = deferred<void>();
    const pressed = createTrainingSyncCoordinator({
      clients: providerWith(
        clientWith(async (options) => {
          await held.promise;
          return failing(options);
        }),
      ),
      refreshTrainingContext: vi.fn(async () => {}),
    });
    const running = pressed.request({ quiet: true });
    const press = pressed.request();
    held.resolve();
    await Promise.all([running, press]);
    expect(pressed.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "operation",
      retryable: true,
    });
  });

  it("shows a quiet sync that succeeds like any other", async () => {
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(clientWith((options) => exactCall(options, published))),
      refreshTrainingContext: vi.fn(async () => {}),
    });
    await coordinator.request({ quiet: true });
    expect(coordinator.getState()).toMatchObject({ status: "succeeded", kind: "published" });
  });

  it("rejects completed progress followed by an error terminal as protocol-invalid", async () => {
    const client = clientWith(async (options) => {
      options.onNotificationEnvelope?.(envelope("started", 0));
      options.onNotificationEnvelope?.(envelope("completed", 1));
      options.onTerminalEnvelope?.(remoteTerminal());
      throw new CoachRpcRemoteError(-32_000, "private daemon detail");
    });
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext,
    });
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "protocol",
      retryable: false,
    });
    expect(refreshTrainingContext).not.toHaveBeenCalled();
  });

  it("treats an idle-retirement admission race as retryable without rotating the provider", async () => {
    const retired = clientWith(async () => {
      throw new CoachClientCallNotAdmittedError();
    });
    const successor = clientWith((options) => exactCall(options, published));
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn().mockResolvedValueOnce(retired).mockResolvedValueOnce(successor),
      reconnect: vi.fn(async () => successor),
      onConnectionOpen: () => () => {},
      close: vi.fn(async () => {}),
    };
    const coordinator = createTrainingSyncCoordinator({
      clients,
      refreshTrainingContext: vi.fn(async () => {}),
    });

    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "operation",
      retryable: true,
    });
    expect(clients.reconnect).not.toHaveBeenCalled();

    await coordinator.request();
    expect(retired.callMock).toHaveBeenCalledTimes(1);
    expect(successor.callMock).toHaveBeenCalledTimes(1);
    expect(clients.reconnect).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({ status: "succeeded", operation: 2 });
  });

  it.each([
    new CoachClientDisconnectedError(1006, "private close reason"),
    new CoachClientCallTimeoutError("sync", 24 * 60 * 60_000),
    new CoachClientCallAbortedError("sync"),
  ])("settles %s without a terminal as indeterminate and never refreshes", async (failure) => {
    const client = clientWith(async () => {
      throw failure;
    });
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext,
    });
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "indeterminate",
      retryable: true,
    });
    expect(refreshTrainingContext).not.toHaveBeenCalled();
  });

  it.each([
    ["client acquisition", new Error("private acquisition failure")],
    ["transport setup", new CoachClientTransportUnavailableError()],
    ["handshake", new CoachClientHandshakeError()],
    ["connection", new CoachClientDisconnectedError(1006, "private close reason")],
  ])("maps a pre-admission %s failure to an ordinary retryable failure", async (_name, failure) => {
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => {
        throw failure;
      }),
      reconnect: vi.fn(async () => {
        throw failure;
      }),
      onConnectionOpen: () => () => {},
      close: vi.fn(async () => {}),
    };
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({ clients, refreshTrainingContext });
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "operation",
      retryable: true,
    });
    expect(clients.reconnect).not.toHaveBeenCalled();
    expect(refreshTrainingContext).not.toHaveBeenCalled();
  });

  it("uses a newer healthy provider generation after a pre-admission failure", async () => {
    const successor = clientWith((options) => exactCall(options, published));
    let current: CoachClient | undefined;
    let acquisitions = 0;
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => {
        acquisitions += 1;
        if (acquisitions === 1) throw new CoachClientHandshakeError();
        if (current === undefined) throw new Error("missing current provider generation");
        return current;
      }),
      reconnect: vi.fn(async () => {
        await current?.close();
        return successor;
      }),
      onConnectionOpen: () => () => {},
      close: vi.fn(async () => {}),
    };
    const coordinator = createTrainingSyncCoordinator({
      clients,
      refreshTrainingContext: vi.fn(async () => {}),
    });
    await coordinator.request();
    expect(clients.reconnect).not.toHaveBeenCalled();
    expect(successor.callMock).not.toHaveBeenCalled();

    current = successor;
    await coordinator.request();
    expect(clients.getClient).toHaveBeenCalledTimes(2);
    expect(clients.reconnect).not.toHaveBeenCalled();
    expect(successor.close).not.toHaveBeenCalled();
    expect(successor.callMock).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual({
      status: "succeeded",
      operation: 2,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
  });

  it("recovers only on a later explicit retry and submits exactly one new call", async () => {
    const failed = clientWith(async () => {
      throw new CoachClientDisconnectedError(1006, "private close reason");
    });
    const recovered = clientWith((options) => exactCall(options, published));
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => failed),
      reconnect: vi.fn(async () => recovered),
      onConnectionOpen: () => () => {},
      close: vi.fn(async () => {}),
    };
    const coordinator = createTrainingSyncCoordinator({
      clients,
      refreshTrainingContext: vi.fn(async () => {}),
    });
    await coordinator.request();
    await Promise.resolve();
    expect(failed.callMock).toHaveBeenCalledTimes(1);
    expect(recovered.callMock).not.toHaveBeenCalled();
    expect(clients.reconnect).not.toHaveBeenCalled();

    await coordinator.request();
    expect(failed.callMock).toHaveBeenCalledTimes(1);
    expect(recovered.callMock).toHaveBeenCalledTimes(1);
    expect(clients.reconnect).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toEqual({
      status: "succeeded",
      operation: 2,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
  });

  it.each([
    ["reversed", [envelope("completed", 1), envelope("started", 0)]],
    ["duplicate", [envelope("started", 0), envelope("started", 0), envelope("completed", 1)]],
    [
      "duplicate completed",
      [envelope("started", 0), envelope("completed", 1), envelope("completed", 1)],
    ],
    ["skipped", [envelope("started", 0)]],
    ["wrong started count", [envelope("started", 1), envelope("completed", 1)]],
    ["wrong completed count", [envelope("started", 0), envelope("completed", 0)]],
    ["wrong total", [envelope("started", 0, 2), envelope("completed", 1)]],
    [
      "wrong method",
      [
        {
          ...envelope("started", 0),
          params: { ...envelope("started", 0).params, requestMethod: "importFiles" },
        },
        envelope("completed", 1),
      ],
    ],
    ["cross request", [envelope("started", 0, 1, 1), envelope("completed", 1, 1, 2)]],
  ])("latches %s progress as a protocol fault without observer throws", async (_name, events) => {
    const client = clientWith(async (options) => {
      for (const event of events) {
        expect(() => {
          if (options.onNotificationEnvelope !== undefined)
            Reflect.apply(options.onNotificationEnvelope, undefined, [event]);
        }).not.toThrow();
      }
      expect(() => options.onTerminalEnvelope?.(terminal())).not.toThrow();
      return published;
    });
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext,
    });
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "protocol",
      retryable: false,
    });
    expect(refreshTrainingContext).not.toHaveBeenCalled();
    await coordinator.request();
    expect(client.callMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no progress notifications", []],
    ["completed(1,1) alone", [envelope("completed", 1)]],
  ] as const)(
    "rejects %s before a success terminal as a non-retryable protocol failure",
    async (_name, events) => {
      const client = clientWith(async (options) => {
        for (const event of events) options.onNotificationEnvelope?.(event);
        options.onTerminalEnvelope?.(terminal());
        return published;
      });
      const refreshTrainingContext = vi.fn(async () => {});
      const coordinator = createTrainingSyncCoordinator({
        clients: providerWith(client),
        refreshTrainingContext,
      });
      await coordinator.request();
      expect(coordinator.getState()).toEqual({
        status: "failed",
        operation: 1,
        kind: "protocol",
        retryable: false,
      });
      expect(refreshTrainingContext).not.toHaveBeenCalled();
    },
  );

  it("publishes one protocol failure for an invalid correlated terminal and replays it", async () => {
    const client = clientWith(async (options) => {
      options.onNotificationEnvelope?.(envelope("started", 0));
      options.onNotificationEnvelope?.(envelope("completed", 1));
      options.onTerminalEnvelope?.(terminal(published, 2));
      return published;
    });
    const refreshTrainingContext = vi.fn(async () => {});
    const states: TrainingSyncState[] = [];
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext,
    });
    coordinator.subscribe((state) => states.push(state));
    await coordinator.request();
    expect(states).toEqual([
      { status: "idle" },
      { status: "queued", operation: 1 },
      { status: "running", operation: 1 },
      { status: "failed", operation: 1, kind: "protocol", retryable: false },
    ]);
    const replayed: TrainingSyncState[] = [];
    coordinator.subscribe((state) => replayed.push(state));
    expect(replayed).toEqual([
      { status: "failed", operation: 1, kind: "protocol", retryable: false },
    ]);
    expect(refreshTrainingContext).not.toHaveBeenCalled();
  });

  it("requires an observed terminal even when a typed result resolves", async () => {
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(
        clientWith(async (options) => {
          options.onNotificationEnvelope?.(envelope("started", 0));
          options.onNotificationEnvelope?.(envelope("completed", 1));
          return published;
        }),
      ),
      refreshTrainingContext,
    });
    await coordinator.request();
    expect(coordinator.getState()).toMatchObject({ kind: "protocol", retryable: false });
    expect(refreshTrainingContext).not.toHaveBeenCalled();
  });

  it("maps a client protocol terminal to a non-retryable protocol fault", async () => {
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(
        clientWith(async () => {
          throw new CoachClientProtocolError();
        }),
      ),
      refreshTrainingContext: vi.fn(async () => {}),
    });
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "protocol",
      retryable: false,
    });
  });

  it("turns a late current-epoch notification into a protocol fault", async () => {
    let options!: SyncOptions;
    const client = clientWith(async (selected) => {
      options = selected;
      return exactCall(selected, published);
    });
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext,
    });
    await coordinator.request();
    expect(coordinator.getState()).toMatchObject({ status: "succeeded" });
    expect(() => options.onNotificationEnvelope?.(envelope("completed", 1))).not.toThrow();
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "protocol",
      retryable: false,
    });
    expect(refreshTrainingContext).toHaveBeenCalledTimes(1);
  });

  it("turns a duplicate current-epoch terminal into a protocol fault", async () => {
    let options!: SyncOptions;
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(
        clientWith(async (selected) => {
          options = selected;
          return exactCall(selected, published);
        }),
      ),
      refreshTrainingContext: vi.fn(async () => {}),
    });
    await coordinator.request();
    expect(() => options.onTerminalEnvelope?.(terminal())).not.toThrow();
    expect(coordinator.getState()).toMatchObject({ kind: "protocol", retryable: false });
  });

  it("does not rewrite a verified outcome when the post-terminal refresh rejects", async () => {
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(clientWith((options) => exactCall(options, published))),
      refreshTrainingContext: vi.fn(async () => {
        throw new Error("private refresh failure");
      }),
    });
    await coordinator.request();
    expect(coordinator.getState()).toEqual({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
  });

  it("ignores callbacks from an older epoch during an explicit new run", async () => {
    const options: SyncOptions[] = [];
    const retryGate = deferred<SyncRpcResult>();
    let calls = 0;
    const client = clientWith(async (selected) => {
      options.push(selected);
      calls += 1;
      if (calls === 1) {
        selected.onNotificationEnvelope?.(envelope("started", 0));
        selected.onTerminalEnvelope?.(remoteTerminal());
        throw new CoachRpcRemoteError(-32_000, "synthetic");
      }
      return retryGate.promise;
    });
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext: vi.fn(async () => {}),
    });
    await coordinator.request();
    const retry = coordinator.request();
    await Promise.resolve();
    expect(options).toHaveLength(2);
    expect(() => options[0]!.onNotificationEnvelope?.(envelope("started", 0))).not.toThrow();
    options[1]!.onNotificationEnvelope?.(envelope("started", 0, 1, 2));
    options[1]!.onNotificationEnvelope?.(envelope("completed", 1, 1, 2));
    options[1]!.onTerminalEnvelope?.(terminal(published, 2));
    retryGate.resolve(published);
    await retry;
    expect(coordinator.getState()).toEqual({
      status: "succeeded",
      operation: 2,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
  });

  it("makes acquisition, observer, refresh completion, and later requests inert after disposal", async () => {
    const refreshGate = deferred<void>();
    let options!: SyncOptions;
    const client = clientWith(async (selected) => {
      options = selected;
      selected.onNotificationEnvelope?.(envelope("started", 0));
      selected.onNotificationEnvelope?.(envelope("completed", 1));
      selected.onTerminalEnvelope?.(terminal());
      return published;
    });
    const states: TrainingSyncState[] = [];
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext: () => refreshGate.promise,
    });
    coordinator.subscribe((state) => states.push(state));
    const request = coordinator.request();
    await Promise.resolve();
    coordinator.dispose();
    expect(() => options.onNotificationEnvelope?.(envelope("completed", 1))).not.toThrow();
    refreshGate.resolve();
    await request;
    await coordinator.request();
    expect(client.callMock).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ status: "running", operation: 1 });
  });
});

describe("training sync coordinator after the window reconnects", () => {
  const dropped = (): CoachClient & { readonly callMock: ReturnType<typeof vi.fn> } =>
    clientWith(async () => {
      throw new CoachClientDisconnectedError(1006, "private close reason");
    });

  it("asks the coach again once when a connection opens after an interrupted sync", async () => {
    const replacement = clientWith((options) => exactCall(options, published));
    const provider = reopeningProvider({ current: dropped(), replacement });
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({
      clients: provider.clients,
      refreshTrainingContext,
    });
    await coordinator.request();
    expect(coordinator.getState()).toMatchObject({ status: "failed", kind: "indeterminate" });

    provider.open();

    await vi.waitFor(() =>
      expect(coordinator.getState()).toMatchObject({
        status: "succeeded",
        operation: 2,
        kind: "published",
      }),
    );
    expect(replacement.callMock).toHaveBeenCalledTimes(1);
    expect(refreshTrainingContext).toHaveBeenCalledTimes(1);

    provider.open();
    await settle();
    expect(replacement.callMock).toHaveBeenCalledTimes(1);
    expect(refreshTrainingContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["before any sync", undefined],
    ["after a finished sync", () => clientWith((options) => exactCall(options, published))],
    [
      "after a sync the coach did not admit",
      () =>
        clientWith(async () => {
          throw new CoachClientCallNotAdmittedError();
        }),
    ],
    [
      "after a sync whose result could not be verified",
      () =>
        clientWith(async (options) => {
          options.onTerminalEnvelope?.(terminal());
          return published;
        }),
    ],
  ])("does not ask the coach again when a connection opens %s", async (_name, first) => {
    const current = first?.() ?? clientWith((options) => exactCall(options, published));
    const replacement = clientWith((options) => exactCall(options, published));
    const provider = reopeningProvider({ current, replacement });
    const coordinator = createTrainingSyncCoordinator({
      clients: provider.clients,
      refreshTrainingContext: vi.fn(async () => {}),
    });
    if (first !== undefined) await coordinator.request();
    const before = coordinator.getState();

    provider.open();
    await settle();

    expect(coordinator.getState()).toEqual(before);
    expect(current.callMock).toHaveBeenCalledTimes(first === undefined ? 0 : 1);
    expect(replacement.callMock).not.toHaveBeenCalled();
  });

  it("does not start a second sync when a connection opens while one is running", async () => {
    const release = deferred<void>();
    const current = clientWith(async (options) => {
      options.onNotificationEnvelope?.(envelope("started", 0));
      await release.promise;
      options.onNotificationEnvelope?.(envelope("completed", 1));
      options.onTerminalEnvelope?.(terminal());
      return published;
    });
    const replacement = clientWith((options) => exactCall(options, published));
    const provider = reopeningProvider({ current, replacement });
    const coordinator = createTrainingSyncCoordinator({
      clients: provider.clients,
      refreshTrainingContext: vi.fn(async () => {}),
    });
    const running = coordinator.request();
    await vi.waitFor(() => expect(coordinator.getState()).toMatchObject({ status: "running" }));

    provider.open();
    await settle();
    release.resolve();
    await running;

    expect(current.callMock).toHaveBeenCalledTimes(1);
    expect(replacement.callMock).not.toHaveBeenCalled();
    expect(coordinator.getState()).toMatchObject({ status: "succeeded", operation: 1 });
  });

  it("stops listening for new connections once disposed", async () => {
    const replacement = clientWith((options) => exactCall(options, published));
    const provider = reopeningProvider({ current: dropped(), replacement });
    const coordinator = createTrainingSyncCoordinator({
      clients: provider.clients,
      refreshTrainingContext: vi.fn(async () => {}),
    });
    await coordinator.request();
    expect(coordinator.getState()).toMatchObject({ status: "failed", kind: "indeterminate" });
    expect(provider.listening()).toBe(1);

    coordinator.dispose();
    provider.open();
    await settle();

    expect(provider.listening()).toBe(0);
    expect(replacement.callMock).not.toHaveBeenCalled();
  });
});

describe("training sync coordinator when re-asks keep getting interrupted", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function interruptedSyncs(replies: ReadonlyArray<"dropped" | "published"> = []) {
    let replied = 0;
    const current = clientWith(async () => {
      throw new CoachClientDisconnectedError(1006, "synthetic");
    });
    const replacement = clientWith(async (options) => {
      const reply = replies[replied] ?? "dropped";
      replied += 1;
      if (reply === "dropped") throw new CoachClientDisconnectedError(1006, "synthetic");
      return exactCall(options, published);
    });
    const provider = reopeningProvider({ current, replacement });
    const coordinator = createTrainingSyncCoordinator({
      clients: provider.clients,
      refreshTrainingContext: vi.fn(async () => {}),
    });
    const syncs = (): number =>
      current.callMock.mock.calls.length + replacement.callMock.mock.calls.length;
    return { coordinator, provider, syncs };
  }

  it("asks again at once, then waits 5 s, 30 s, 2 min and every 5 min between re-asks", async () => {
    const { coordinator, provider, syncs } = interruptedSyncs();
    await coordinator.request();
    expect(syncs()).toBe(1);

    provider.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs()).toBe(2);

    let expected = 2;
    for (const wait of [5_000, 30_000, 120_000, 300_000, 300_000]) {
      provider.open();
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(syncs()).toBe(expected);
      await vi.advanceTimersByTimeAsync(1);
      expected += 1;
      expect(syncs()).toBe(expected);
    }
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: expected,
      kind: "indeterminate",
      retryable: true,
    });
  });

  it("keeps one re-ask waiting however many connections open meanwhile", async () => {
    const { coordinator, provider, syncs } = interruptedSyncs();
    await coordinator.request();
    provider.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs()).toBe(2);

    provider.open();
    provider.open();
    provider.open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncs()).toBe(3);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncs()).toBe(3);
  });

  it("asks again at once after an interrupted sync the athlete started, dropping the waiting re-ask", async () => {
    const { coordinator, provider, syncs } = interruptedSyncs();
    await coordinator.request();
    provider.open();
    await vi.advanceTimersByTimeAsync(0);
    provider.open();
    expect(syncs()).toBe(2);

    await coordinator.request();
    expect(syncs()).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncs()).toBe(3);

    provider.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs()).toBe(4);
  });

  it("asks again at once after a sync that ended in a coach answer", async () => {
    const { coordinator, provider, syncs } = interruptedSyncs(["dropped", "published"]);
    await coordinator.request();
    provider.open();
    await vi.advanceTimersByTimeAsync(0);
    provider.open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncs()).toBe(3);
    expect(coordinator.getState()).toMatchObject({ status: "succeeded", operation: 3 });

    await coordinator.request();
    expect(coordinator.getState()).toMatchObject({ status: "failed", kind: "indeterminate" });
    provider.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs()).toBe(5);
  });

  it("keeps the sync interrupted when a re-ask finds the coach down, then asks again once it is back", async () => {
    const listeners = new Set<() => void>();
    let coachDown = false;
    let answer: "dropped" | "published" = "dropped";
    const client = clientWith(async (options) => {
      if (answer === "dropped") throw new CoachClientDisconnectedError(1006, "synthetic");
      return exactCall(options, published);
    });
    const connect = async (): Promise<CoachClient> => {
      if (coachDown) throw new CoachClientTransportUnavailableError();
      return client;
    };
    const coordinator = createTrainingSyncCoordinator({
      clients: {
        getClient: vi.fn(connect),
        reconnect: vi.fn(connect),
        close: vi.fn(async () => {}),
        onConnectionOpen: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      refreshTrainingContext: vi.fn(async () => {}),
    });
    const open = (): void => {
      for (const listener of listeners) listener();
    };
    await coordinator.request();
    open();
    await vi.advanceTimersByTimeAsync(0);
    open();
    expect(client.callMock).toHaveBeenCalledTimes(2);

    coachDown = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.callMock).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 3,
      kind: "indeterminate",
      retryable: true,
    });

    coachDown = false;
    answer = "published";
    open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.callMock).toHaveBeenCalledTimes(3);
    expect(coordinator.getState()).toMatchObject({
      status: "succeeded",
      operation: 4,
      kind: "published",
    });
  });

  it("keeps the sync interrupted when the coach refuses a re-ask before it starts, then asks again on the next connection", async () => {
    const listeners = new Set<() => void>();
    let answer: "dropped" | "refused" | "published" = "dropped";
    const client = clientWith(async (options) => {
      if (answer === "dropped") throw new CoachClientDisconnectedError(1006, "synthetic");
      if (answer === "refused") {
        options.onTerminalEnvelope?.({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32_005, message: "daemon-upgrading" },
        });
        throw new CoachRpcRemoteError(-32_005, "daemon-upgrading");
      }
      return exactCall(options, published);
    });
    const coordinator = createTrainingSyncCoordinator({
      clients: {
        getClient: vi.fn(async () => client),
        reconnect: vi.fn(async () => client),
        close: vi.fn(async () => {}),
        onConnectionOpen: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      refreshTrainingContext: vi.fn(async () => {}),
    });
    const open = (): void => {
      for (const listener of listeners) listener();
    };
    await coordinator.request();
    answer = "refused";
    open();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.callMock).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 2,
      kind: "indeterminate",
      retryable: true,
    });

    answer = "published";
    open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.callMock).toHaveBeenCalledTimes(3);
    expect(coordinator.getState()).toMatchObject({
      status: "succeeded",
      operation: 3,
      kind: "published",
    });
  });

  it("keeps an error before the sync starts a protocol fault unless the coach closed admission", async () => {
    const client = clientWith(async (options) => {
      options.onTerminalEnvelope?.({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_603, message: "Internal error" },
      });
      throw new CoachRpcRemoteError(-32_603, "Internal error");
    });
    const coordinator = createTrainingSyncCoordinator({
      clients: providerWith(client),
      refreshTrainingContext: vi.fn(async () => {}),
    });

    await coordinator.request();

    expect(coordinator.getState()).toEqual({
      status: "failed",
      operation: 1,
      kind: "protocol",
      retryable: false,
    });
  });

  it("drops a waiting re-ask once disposed", async () => {
    const { coordinator, provider, syncs } = interruptedSyncs();
    await coordinator.request();
    provider.open();
    await vi.advanceTimersByTimeAsync(0);
    provider.open();
    expect(syncs()).toBe(2);

    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(syncs()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
