import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  serializeCoachRpcEnvelope,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientHandshakeError,
  type CoachClient,
  type CoachClientConnection,
  type ConnectCoachClientOptions,
} from "@enduragent/coach-client";
import { createDesktopCoachClientProvider } from "../src/coach-client";

function capability(fill: string, suffix = "A"): string {
  return `${fill.repeat(42)}${suffix}`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function coachConnection(
  client: CoachClient,
  lifecycle: {
    readonly closeWhenIdle?: () => Promise<void>;
    readonly close?: () => Promise<void>;
  } = {},
): CoachClientConnection {
  return {
    client,
    closeWhenIdle: lifecycle.closeWhenIdle ?? vi.fn(async () => {}),
    close: lifecycle.close ?? vi.fn(async () => {}),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop coach client lifecycle", () => {
  it("keeps an admitted sync connected while an unrelated retry replaces the shared client", async () => {
    const sockets: ServerWebSocket[] = [];
    const admitted = deferred<{ readonly id: number; readonly socket: ServerWebSocket }>();
    const firstClosed = deferred<void>();
    let syncRequests = 0;
    let connectionCount = 0;
    const rendererCapability = capability("s");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      process.stderr.write("SKIP_MARKER loopback-listen EPERM desktop-coach-client\n");
      return;
    }
    server.on("connection", (socket) => {
      sockets.push(socket);
      connectionCount += 1;
      const connectionNumber = connectionCount;
      if (connectionNumber === 1) socket.once("close", () => firstClosed.resolve());
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as {
          readonly type?: string;
          readonly id?: number;
          readonly method?: string;
        };
        if (frame.type === "handshake") {
          socket.send(
            JSON.stringify(
              createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION, {
                athleteHome: "/synthetic/athlete",
                rendererCapability,
              }),
            ),
          );
          return;
        }
        if (frame.method === "sync" && frame.id !== undefined) {
          syncRequests += 1;
          socket.send(
            serializeCoachRpcEnvelope({
              jsonrpc: "2.0",
              method: "coach.operationProgress",
              params: {
                requestId: frame.id,
                requestMethod: "sync",
                event: { phase: "started", completed: 0, total: 1 },
              },
            }),
          );
          admitted.resolve({ id: frame.id, socket });
          return;
        }
        if (frame.method === "hasSession" && frame.id !== undefined) {
          socket.send(
            serializeCoachRpcEnvelope({
              jsonrpc: "2.0",
              id: frame.id,
              result: { hasSession: false },
            }),
          );
        }
      });
    });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Missing server address");
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: `ws://127.0.0.1:${address.port}/rpc`,
        rendererCapability,
        generation: 7,
      })),
    };
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider();
    try {
      const first = await clients.getClient();
      const events: string[] = [];
      const terminals = vi.fn();
      const operation = first.call(
        "sync",
        {},
        {
          onEvent: (event) => events.push(event.phase),
          onTerminalEnvelope: terminals,
        },
      );
      void operation.catch(() => undefined);
      const pending = await admitted.promise;

      const replacement = await clients.reconnect();
      expect(replacement).not.toBe(first);
      await expect(replacement.call("hasSession", { chatId: "desktop" })).resolves.toEqual({
        hasSession: false,
      });
      expect(connectionCount).toBe(2);
      expect(syncRequests).toBe(1);

      if (pending.socket.readyState === 1) {
        pending.socket.send(
          serializeCoachRpcEnvelope({
            jsonrpc: "2.0",
            method: "coach.operationProgress",
            params: {
              requestId: pending.id,
              requestMethod: "sync",
              event: { phase: "completed", completed: 1, total: 1 },
            },
          }),
        );
        pending.socket.send(
          serializeCoachRpcEnvelope({
            jsonrpc: "2.0",
            id: pending.id,
            result: {
              schemaVersion: 1,
              published: false,
              referenceSucceeded: true,
              requests: { store: 0, reference: 0, total: 0 },
              droppedActivities: {
                overall: { total: 0, visible: 0, restrictions: [], other: 0 },
                recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
              },
            },
          }),
        );
      }

      await expect(operation).resolves.toMatchObject({ schemaVersion: 1 });
      expect(events).toEqual(["started", "completed"]);
      expect(terminals).toHaveBeenCalledTimes(1);
      await firstClosed.promise;
    } finally {
      await clients.close();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("asks the trusted main-process bridge to recover before resolving fresh coordinates", async () => {
    const order: string[] = [];
    const auth = {
      getDaemonConnection: vi.fn(async (failedGeneration?: number) => {
        order.push(failedGeneration === undefined ? "coordinates" : `recover-${failedGeneration}`);
        return {
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 7,
        };
      }),
    };
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(
      vi.fn(async () => Promise.reject(new Error())),
    );
    await expect(clients.getClient()).rejects.toThrow();
    await expect(clients.reconnect()).rejects.toThrow();
    expect(order).toEqual(["coordinates", "recover-7"]);
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 7);
  });

  it("authenticates with the renderer capability without accepting privileged coordinates", async () => {
    const client = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: "ws://127.0.0.1:45001/rpc",
        rendererCapability: capability("r"),
        generation: 1,
      })),
    };
    const connect = vi.fn(async () => coachConnection(client));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);

    await expect(clients.getClient()).resolves.toBe(client);
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:45001/rpc",
        token: capability("r"),
      }),
    );
  });

  it("rejects renderer coordinates containing privileged connection fields", async () => {
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: "ws://127.0.0.1:45001/rpc",
        rendererCapability: capability("r"),
        generation: 1,
        token: "s".repeat(43),
      })),
    };
    const connect = vi.fn();
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);

    await expect(clients.getClient()).rejects.toBeInstanceOf(Error);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects non-canonical renderer capabilities", async () => {
    const client = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: "ws://127.0.0.1:45001/rpc",
        rendererCapability: "r".repeat(43),
        generation: 1,
      })),
    };
    const connect = vi.fn(async () => coachConnection(client));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);

    await expect(clients.getClient()).rejects.toBeInstanceOf(Error);
    expect(connect).not.toHaveBeenCalled();
  });

  it("retires the old client and deduplicates successful generation-qualified reconnects", async () => {
    const first = { close: vi.fn(async () => {}) };
    const second = { close: vi.fn(async () => {}) };
    const closeFirstWhenIdle = vi.fn(async () => {});
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 1,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          rendererCapability: capability("t"),
          generation: 2,
        }),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(
        coachConnection(first as unknown as CoachClient, { closeWhenIdle: closeFirstWhenIdle }),
      )
      .mockResolvedValueOnce(coachConnection(second as unknown as CoachClient));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);
    const reconnecting = clients.reconnect();
    const duplicate = clients.reconnect();
    await expect(reconnecting).resolves.toBe(second);
    await expect(duplicate).resolves.toBe(second);
    expect(closeFirstWhenIdle).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("recovers a terminal client lazily, generation-qualified, and coalesced", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 4,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          rendererCapability: capability("t"),
          generation: 5,
        }),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(coachConnection(first))
      .mockResolvedValueOnce(coachConnection(second));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);
    const options = connect.mock.calls[0]![0] as ConnectCoachClientOptions;
    const cause = new CoachClientCallTimeoutError("chat", 11 * 60_000);

    options.onTerminal?.(first, cause);

    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    const recovery = clients.getClient();
    const duplicate = clients.getClient();
    await expect(recovery).resolves.toBe(second);
    await expect(duplicate).resolves.toBe(second);
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 4);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("advances recovery past coordinates whose client connection fails", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const third = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const connectionFailure = new Error("generation 5 connection failed");
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 4,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          rendererCapability: capability("t"),
          generation: 5,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45003/rpc",
          rendererCapability: capability("u"),
          generation: 6,
        }),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(coachConnection(first))
      .mockRejectedValueOnce(connectionFailure)
      .mockResolvedValueOnce(coachConnection(third));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);
    const options = connect.mock.calls[0]![0] as ConnectCoachClientOptions;

    options.onTerminal?.(first, new CoachClientDisconnectedError(1006, ""));

    await expect(clients.getClient()).rejects.toBe(connectionFailure);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);

    await expect(clients.getClient()).resolves.toBe(third);
    expect(auth.getDaemonConnection.mock.calls.map(([failed]) => failed)).toEqual([
      undefined,
      4,
      5,
    ]);
    expect(connect).toHaveBeenCalledTimes(3);
    await expect(clients.getClient()).resolves.toBe(third);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("drops the failed-generation latch when the recovery bridge call itself rejects", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const bridgeFailure = new Error("desktop document daemon generation mismatch");
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 4,
        })
        .mockRejectedValueOnce(bridgeFailure)
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          rendererCapability: capability("t"),
          generation: 6,
        }),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(coachConnection(first))
      .mockResolvedValueOnce(coachConnection(second));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);
    const options = connect.mock.calls[0]![0] as ConnectCoachClientOptions;

    options.onTerminal?.(first, new CoachClientDisconnectedError(1006, ""));

    await expect(clients.getClient()).rejects.toBe(bridgeFailure);
    await expect(clients.getClient()).resolves.toBe(second);
    expect(auth.getDaemonConnection.mock.calls.map(([failed]) => failed)).toEqual([
      undefined,
      4,
      undefined,
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("rejects a client terminalized during connection resolution and recovers on the next call", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const cause = new CoachClientDisconnectedError(1006, "");
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 8,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          rendererCapability: capability("t"),
          generation: 9,
        }),
    };
    const connect = vi
      .fn()
      .mockImplementationOnce(async (options: ConnectCoachClientOptions) => {
        options.onTerminal?.(first, cause);
        return coachConnection(first);
      })
      .mockResolvedValueOnce(coachConnection(second));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);

    await expect(clients.getClient()).rejects.toBe(cause);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    await expect(clients.getClient()).resolves.toBe(second);
    expect(auth.getDaemonConnection).toHaveBeenNthCalledWith(2, 8);
  });

  it("fences stale failure signals from the replacement client", async () => {
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 1,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          rendererCapability: capability("t"),
          generation: 2,
        }),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(coachConnection(first))
      .mockResolvedValueOnce(coachConnection(second));
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await clients.getClient();
    const oldOptions = connect.mock.calls[0]![0] as ConnectCoachClientOptions;
    await expect(clients.reconnect()).resolves.toBe(second);

    oldOptions.onTerminal?.(first, new CoachClientDisconnectedError(1000, "old close"));
    await expect(clients.reconnect(first)).resolves.toBe(second);

    await expect(clients.getClient()).resolves.toBe(second);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.close).not.toHaveBeenCalled();
  });

  it("force-closes current and draining connections during shutdown", async () => {
    const retirement = deferred<void>();
    const first = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const second = { close: vi.fn(async () => {}) } as unknown as CoachClient;
    const closeFirst = vi.fn(async () => retirement.resolve());
    const closeSecond = vi.fn(async () => {});
    const firstConnection = coachConnection(first, {
      closeWhenIdle: vi.fn(() => retirement.promise),
      close: closeFirst,
    });
    const secondConnection = coachConnection(second, { close: closeSecond });
    const auth = {
      getDaemonConnection: vi
        .fn()
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45001/rpc",
          rendererCapability: capability("s"),
          generation: 1,
        })
        .mockResolvedValueOnce({
          url: "ws://127.0.0.1:45002/rpc",
          rendererCapability: capability("t"),
          generation: 2,
        }),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection);
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);

    await expect(clients.getClient()).resolves.toBe(first);
    await expect(clients.reconnect()).resolves.toBe(second);
    const closing = clients.close();

    expect(clients.close()).toBe(closing);
    await expect(closing).resolves.toBeUndefined();
    expect(firstConnection.closeWhenIdle).toHaveBeenCalledTimes(1);
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeSecond).toHaveBeenCalledTimes(1);
  });

  it("aborts and awaits a client connection already establishing during shutdown", async () => {
    let signal: AbortSignal | undefined;
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: "ws://127.0.0.1:45001/rpc",
        rendererCapability: capability("s"),
        generation: 1,
      })),
    };
    const connect = vi.fn((options: ConnectCoachClientOptions): Promise<CoachClientConnection> => {
      signal = options.signal;
      return new Promise((_, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new CoachClientHandshakeError("Coach client connection aborted")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    const acquisition = clients.getClient().catch((error: unknown) => error);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));

    const closing = clients.close();

    expect(signal?.aborted).toBe(true);
    await expect(closing).resolves.toBeUndefined();
    await expect(acquisition).resolves.toBeInstanceOf(CoachClientDisconnectedError);
  });

  it("latches shutdown before a deferred client close can invalidate the provider", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const terminalCause = new CoachClientDisconnectedError(1000, "");
    let capturedOptions!: ConnectCoachClientOptions;
    const closeClient = vi.fn(async () => {
      capturedOptions.onTerminal?.(first, terminalCause);
      await closeGate;
    });
    const first = { close: closeClient } as unknown as CoachClient;
    const auth = {
      getDaemonConnection: vi.fn(async () => ({
        url: "ws://127.0.0.1:45001/rpc",
        rendererCapability: capability("s"),
        generation: 12,
      })),
    };
    const connect = vi.fn(async (options: ConnectCoachClientOptions) => {
      capturedOptions = options;
      return coachConnection(first, { close: closeClient });
    });
    vi.stubGlobal("window", { enduragentAuth: auth });
    const clients = createDesktopCoachClientProvider(connect);
    await expect(clients.getClient()).resolves.toBe(first);

    let closeSettled = false;
    const closing = clients.close();
    void closing.then(() => {
      closeSettled = true;
    });
    expect(clients.close()).toBe(closing);
    await vi.waitFor(() => expect(closeClient).toHaveBeenCalledTimes(1));

    const getDuringClose = await clients.getClient().catch((error: unknown) => error);
    const reconnectDuringClose = await clients
      .reconnect()
      .catch((error: unknown) => error);
    expect(closeSettled).toBe(false);
    expect(getDuringClose).toBeInstanceOf(CoachClientDisconnectedError);
    expect(getDuringClose).toMatchObject({ code: 1000, reason: "" });
    expect(reconnectDuringClose).toBe(getDuringClose);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);

    releaseClose();
    await expect(closing).resolves.toBeUndefined();
    expect(closeClient).toHaveBeenCalledTimes(1);

    const getAfterClose = await clients.getClient().catch((error: unknown) => error);
    const reconnectAfterClose = await clients
      .reconnect()
      .catch((error: unknown) => error);
    expect(getAfterClose).toBe(getDuringClose);
    expect(reconnectAfterClose).toBe(getDuringClose);
    expect(auth.getDaemonConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
