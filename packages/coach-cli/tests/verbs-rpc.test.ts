import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoachOperationProgressNotificationEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
  type CoachRpcNotification,
} from "@enduragent/coach-contract";
import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  type CoachClient,
  type CoachClientCallOptions,
} from "@enduragent/coach-client";

const mocks = vi.hoisted(() => ({ connectCoachClient: vi.fn() }));

vi.mock("@enduragent/coach-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@enduragent/coach-client")>()),
  connectCoachClient: mocks.connectCoachClient,
}));

import {
  CoachRemoteError,
  connectCoachVerbTransport,
  connectRemoteCoachTransport,
  connectWithBoundedRetry,
  type CoachVerbRequest,
  type CoachVerbTransport,
} from "../src/index.js";

afterEach(() => mocks.connectCoachClient.mockReset());

const transport: CoachVerbTransport = {
  kind: "remote",
  request: async () => {
    throw new Error("unused");
  },
  close: async () => {},
};

describe("bounded remote connection", () => {
  it("returns the exact validated operational notification and terminal envelopes", async () => {
    const notification: CoachRpcNotification<"sync"> = {
      jsonrpc: "2.0",
      method: "coach.operationProgress",
      params: {
        requestId: 1,
        requestMethod: "sync",
        event: { phase: "completed", completed: 1, total: 1 },
      },
    };
    expect(CoachOperationProgressNotificationEnvelopeSchema.parse(notification)).toEqual(
      notification,
    );
    const terminal = JsonRpcSuccessResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        schemaVersion: 1,
        published: true,
        referenceSucceeded: true,
        requests: { store: 1, reference: 0, total: 1 },
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      },
    });
    const call = vi.fn(
      async (method: string, params: unknown, options?: CoachClientCallOptions<"sync">) => {
        expect(method).toBe("sync");
        expect(params).toEqual({});
        options?.onNotificationEnvelope?.(notification);
        options?.onTerminalEnvelope?.(terminal);
        return terminal.result;
      },
    );
    const close = vi.fn(async () => {});
    mocks.connectCoachClient.mockResolvedValue({ call, close } as unknown as CoachClient);
    const remote = await connectCoachVerbTransport({
      url: "ws://127.0.0.1:43123/rpc",
      token: "synthetic-token",
    });
    const notifications: unknown[] = [];
    const terminals: unknown[] = [];
    const returned = await remote.request({
      method: "sync",
      params: {},
      signal: new AbortController().signal,
      onNotificationEnvelope: (envelope) => notifications.push(envelope),
      onTerminalEnvelope: (envelope) => terminals.push(envelope),
    });
    expect(notifications).toEqual([notification]);
    expect(terminals).toEqual([terminal]);
    expect(returned).toBe(terminal);
    await remote.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["chat", { chatId: "chat-1", message: "hello" }],
    ["getAthleteState", {}],
    ["importFiles", { paths: ["/synthetic/ride.fit"] }],
    ["sync", {}],
  ] as const)("forwards the exact request signal for %s", async (method, params) => {
    const terminal = JsonRpcSuccessResponseEnvelopeSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    const call = vi.fn(
      async (
        _method: string,
        _params: unknown,
        options?: Pick<CoachClientCallOptions<"sync">, "signal" | "onTerminalEnvelope">,
      ) => {
        options?.onTerminalEnvelope?.(terminal);
        return {};
      },
    );
    mocks.connectCoachClient.mockResolvedValue({
      call,
      close: vi.fn(async () => {}),
    } as unknown as CoachClient);
    const remote = await connectCoachVerbTransport({
      url: "ws://127.0.0.1:43123/rpc",
      token: "synthetic-token",
    });
    const controller = new AbortController();
    const request = {
      method,
      params,
      signal: controller.signal,
      onNotificationEnvelope: vi.fn(),
      onTerminalEnvelope: vi.fn(),
    } as CoachVerbRequest;

    await expect(remote.request(request)).resolves.toBe(terminal);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toBe(method);
    expect(call.mock.calls[0]![2]?.signal).toBe(controller.signal);
  });

  it("detaches a pre-aborted request without calling the client or fabricating a terminal", async () => {
    const call = vi.fn();
    mocks.connectCoachClient.mockResolvedValue({
      call,
      close: vi.fn(async () => {}),
    } as unknown as CoachClient);
    const remote = await connectCoachVerbTransport({
      url: "ws://127.0.0.1:43123/rpc",
      token: "synthetic-token",
    });
    const controller = new AbortController();
    controller.abort();
    const terminal = vi.fn();

    await expect(
      remote.request({
        method: "sync",
        params: {},
        signal: controller.signal,
        onNotificationEnvelope: vi.fn(),
        onTerminalEnvelope: terminal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "detached" } });
    expect(call).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });

  it.each([
    new CoachClientCallAbortedError("sync"),
    new CoachClientCallTimeoutError("sync", 24 * 60 * 60_000),
  ])("maps $name after admission to detached without a terminal envelope", async (failure) => {
    const call = vi.fn(async () => Promise.reject(failure));
    mocks.connectCoachClient.mockResolvedValue({
      call,
      close: vi.fn(async () => {}),
    } as unknown as CoachClient);
    const remote = await connectCoachVerbTransport({
      url: "ws://127.0.0.1:43123/rpc",
      token: "synthetic-token",
    });
    const terminal = vi.fn();

    await expect(
      remote.request({
        method: "sync",
        params: {},
        signal: new AbortController().signal,
        onNotificationEnvelope: vi.fn(),
        onTerminalEnvelope: terminal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "detached" } });
    expect(terminal).not.toHaveBeenCalled();
  });

  it("attempts immediately and pins 50/100/200 delays", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(transport);
    let now = 0;
    const delays: number[] = [];
    await expect(
      connectWithBoundedRetry({
        connect,
        delay: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).resolves.toBe(transport);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([50, 100, 200]);
  });

  it("stops at 5000ms and propagates non-unavailable failures immediately", async () => {
    let now = 0;
    const delays: number[] = [];
    await expect(
      connectWithBoundedRetry({
        connect: async () => {
          throw new CoachRemoteError({ kind: "unavailable" });
        },
        delay: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        monotonicNow: () => now,
      }),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
    expect(delays.reduce((sum, value) => sum + value, 0)).toBe(5_000);
    const mismatch = new CoachRemoteError({ kind: "version-mismatch", direction: "client-newer" });
    const delay = vi.fn();
    await expect(
      connectWithBoundedRetry({
        connect: async () => {
          throw mismatch;
        },
        delay,
        monotonicNow: () => 0,
      }),
    ).rejects.toBe(mismatch);
    expect(delay).not.toHaveBeenCalled();
  });

  it("resumes a registered service once and never spawns a competitor", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new CoachRemoteError({ kind: "unavailable" }))
      .mockResolvedValueOnce(transport);
    const resumeService = vi.fn(async () => "resumed" as const);
    const startEphemeralDaemon = vi.fn();
    await expect(
      connectRemoteCoachTransport({
        connect,
        serviceRegistrationState: async () => "present",
        resumeService,
        startEphemeralDaemon,
        delay: async () => {},
        monotonicNow: () => 0,
      }),
    ).resolves.toBe(transport);
    expect(resumeService).toHaveBeenCalledTimes(1);
    expect(startEphemeralDaemon).not.toHaveBeenCalled();
  });
});
