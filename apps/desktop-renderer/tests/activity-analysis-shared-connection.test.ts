// Issue 411: leaving a ride analysis that is still loading must not close the window's shared
// coach connection, which would break a running sync (path A) and any other call in flight
// (path B). Real pieces: the coach client, the desktop client provider, the sign-in health
// wrapper, the ride-analysis controller and the sync coordinator, wired as boot.ts wires them.
// Only the coach's RPC socket is faked, by a loopback WebSocket server.
import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  serializeCoachRpcEnvelope,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopCoachClientProvider } from "../src/coach-client";
import { createIntervalsSignInHealth } from "../src/intervals-sign-in-health";
import { createRideAnalysisController } from "../src/activity-analysis/controller";
import { createTrainingSyncCoordinator, type TrainingSyncState } from "../src/training-sync";

const RIDE_A = "a".repeat(64);
const RIDE_B = "b".repeat(64);
const rendererCapability = `${"s".repeat(42)}A`;

interface Frame {
  readonly type?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
}

interface Received {
  readonly socket: ServerWebSocket;
  readonly frame: Frame;
}

const syncResult = {
  schemaVersion: 1,
  published: false,
  referenceSucceeded: true,
  requests: { store: 0, reference: 0, total: 0 },
  droppedActivities: {
    overall: { total: 0, visible: 0, restrictions: [], other: 0 },
    recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
  },
};

async function startCoach() {
  const sockets: ServerWebSocket[] = [];
  const received: Received[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
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
      received.push({ socket, frame });
      if (frame.method === "sync" && frame.id !== undefined) {
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
      }
      // getActivityAnalysis, chat and getRuntimeConfig are held: the coach is "still working".
    });
  });
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("missing address");
  const auth = {
    getDaemonConnection: vi.fn(async () => ({
      url: `ws://127.0.0.1:${address.port}/rpc`,
      rendererCapability,
      generation: 3,
    })),
  };
  vi.stubGlobal("window", { enduragentAuth: auth });
  const find = (method: string): Received | undefined =>
    received.find((entry) => entry.frame.method === method);
  return {
    sockets,
    received,
    find,
    async waitFor(method: string): Promise<Received> {
      await vi.waitFor(() => expect(find(method)).toBeDefined(), { timeout: 5_000 });
      return find(method)!;
    },
    finishSync(entry: Received): void {
      entry.socket.send(
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          method: "coach.operationProgress",
          params: {
            requestId: entry.frame.id!,
            requestMethod: "sync",
            event: { phase: "completed", completed: 1, total: 1 },
          },
        }),
      );
      entry.socket.send(
        serializeCoachRpcEnvelope({ jsonrpc: "2.0", id: entry.frame.id!, result: syncResult }),
      );
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function wireLikeBoot() {
  const signInHealth = createIntervalsSignInHealth(createDesktopCoachClientProvider(), {
    getState: () => ({ setIntervalsSignInRejected() {} }),
  });
  const clients = signInHealth.clients;
  const analysis = createRideAnalysisController({ clients, view: { render() {} } });
  const refreshed = vi.fn(async () => {});
  const sync = createTrainingSyncCoordinator({
    clients,
    refreshTrainingContext: async () => {
      // boot.ts:165-166
      analysis.invalidate();
      await refreshed();
    },
  });
  const states: TrainingSyncState[] = [];
  sync.subscribe((state) => states.push(state));
  return { clients, analysis, sync, states, refreshed };
}

afterEach(() => vi.unstubAllGlobals());

describe("one ride-analysis cancel and the shared coach connection", () => {
  it("path A: clicking another ride while its analysis loads leaves the running sync alone", async () => {
    const coach = await startCoach();
    const app = wireLikeBoot();
    let probeRejection: unknown;
    try {
      // 1. The athlete presses Sync. The coach reports "started" and keeps working.
      const syncTask = app.sync.request();
      const syncFrame = await coach.waitFor("sync");
      await vi.waitFor(() => expect(app.sync.getState().status).toBe("running"));

      // 2. They open ride A's analysis. The request reaches the coach and is held.
      await app.analysis.select(RIDE_A);
      void app.analysis.start();
      await coach.waitFor("getActivityAnalysis");

      // Observe the sync call's own outcome through the shared client.
      const client = await app.clients.getClient();
      const probe = client.call("hasSession", { chatId: "desktop" }).catch((error: unknown) => {
        probeRejection = error;
      });
      await coach.waitFor("hasSession");

      // 3. Before it loads they click ride B. Only ride A's request should be cancelled.
      await app.analysis.select(RIDE_B);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(probeRejection, "another call on the shared connection was rejected").toBeUndefined();
      expect(syncFrame.socket.readyState, "shared coach socket state (1 = open)").toBe(1);
      expect(app.sync.getState()).toMatchObject({ status: "running" });

      // 4. The coach finishes the sync. The window should show success.
      coach.finishSync(syncFrame);
      await syncTask;
      expect(app.sync.getState()).toMatchObject({ status: "succeeded", kind: "no-change" });
      void probe;
    } finally {
      app.sync.dispose();
      app.analysis.dispose();
      await app.clients.close();
      await coach.close();
    }
  });

  it("path A: the sync itself is not marked indeterminate by a ride-analysis cancel", async () => {
    const coach = await startCoach();
    const app = wireLikeBoot();
    try {
      void app.sync.request();
      const syncFrame = await coach.waitFor("sync");
      await vi.waitFor(() => expect(app.sync.getState().status).toBe("running"));
      await app.analysis.select(RIDE_A);
      void app.analysis.start();
      await coach.waitFor("getActivityAnalysis");

      await app.analysis.select(RIDE_B);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(app.sync.getState()).toEqual({ status: "running", operation: 1 });
      expect(syncFrame.socket.readyState).toBe(1);
    } finally {
      app.sync.dispose();
      app.analysis.dispose();
      await app.clients.close();
      await coach.close();
    }
  });

  it("path B: a sync that finishes while an analysis loads does not cut off a coach reply in flight", async () => {
    const coach = await startCoach();
    const app = wireLikeBoot();
    let chatRejection: unknown;
    try {
      const syncTask = app.sync.request();
      const syncFrame = await coach.waitFor("sync");
      await vi.waitFor(() => expect(app.sync.getState().status).toBe("running"));

      // A coach reply is streaming on the same connection.
      const client = await app.clients.getClient();
      const chat = client
        .call("chat", { chatId: "desktop", message: "How was my ride?" })
        .catch((error: unknown) => {
          chatRejection = error;
        });
      await coach.waitFor("chat");

      // The athlete has a ride analysis open and loading.
      await app.analysis.select(RIDE_A);
      void app.analysis.start();
      await coach.waitFor("getActivityAnalysis");

      // The sync finishes; refreshTrainingContext runs analysis.invalidate() (boot.ts:165-166).
      coach.finishSync(syncFrame);
      await syncTask;
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(app.sync.getState()).toMatchObject({ status: "succeeded" });
      expect(chatRejection, "the streaming coach reply was rejected").toBeUndefined();
      expect(syncFrame.socket.readyState, "shared coach socket state (1 = open)").toBe(1);
      void chat;
    } finally {
      app.sync.dispose();
      app.analysis.dispose();
      await app.clients.close();
      await coach.close();
    }
  });
});
