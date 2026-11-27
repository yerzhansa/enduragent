import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  serializeCoachRpcEnvelope,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopCoachClientProvider } from "../src/coach-client";
import { createTrainingSyncCoordinator } from "../src/training-sync";
import { toManualSyncViewState } from "../src/training-context/manual-sync";

const rendererCapability = `${"s".repeat(42)}A`;

afterEach(() => vi.unstubAllGlobals());

describe("a sync the coach refuses before it starts", () => {
  it("lets the athlete sync again after the coach refused one sync", async () => {
    const sockets: ServerWebSocket[] = [];
    let syncs = 0;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    server.on("connection", (socket) => {
      sockets.push(socket);
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as {
          type?: string;
          id?: number;
          method?: string;
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
        if (frame.method !== "sync" || frame.id === undefined) return;
        syncs += 1;
        if (syncs === 1) {
          socket.send(
            serializeCoachRpcEnvelope({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32_005, message: "daemon-upgrading" },
            }),
          );
          return;
        }
        for (const event of [
          { phase: "started", completed: 0, total: 1 },
          { phase: "completed", completed: 1, total: 1 },
        ]) {
          socket.send(
            serializeCoachRpcEnvelope({
              jsonrpc: "2.0",
              method: "coach.operationProgress",
              params: { requestId: frame.id, requestMethod: "sync", event },
            }),
          );
        }
        socket.send(
          serializeCoachRpcEnvelope({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              schemaVersion: 1,
              published: true,
              referenceSucceeded: true,
              requests: { store: 1, reference: 1, total: 2 },
              droppedActivities: {
                overall: { total: 0, visible: 0, restrictions: [], other: 0 },
                recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
              },
            },
          }),
        );
      });
    });
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing address");
    vi.stubGlobal("window", {
      enduragentAuth: {
        getDaemonConnection: async () => ({
          url: `ws://127.0.0.1:${address.port}/rpc`,
          rendererCapability,
          generation: 4,
        }),
      },
    });
    const clients = createDesktopCoachClientProvider();
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({ clients, refreshTrainingContext });
    try {
      await coordinator.request();
      const afterRefusal = toManualSyncViewState(coordinator.getState());
      expect(
        {
          label: afterRefusal.label,
          disabled: afterRefusal.disabled,
          message: afterRefusal.message,
        },
        "the sync button after the coach refused one sync",
      ).toEqual({
        label: "Try again",
        disabled: false,
        message:
          "We couldn’t complete the training-data check. Your existing data is still available.",
      });
      expect(
        refreshTrainingContext,
        "the window keeps its training data when the coach ran nothing",
      ).not.toHaveBeenCalled();

      await coordinator.request();
      expect(syncs, "the coach received the athlete's second sync").toBe(2);
      expect(coordinator.getState()).toMatchObject({ status: "succeeded", kind: "published" });
      expect(refreshTrainingContext).toHaveBeenCalledTimes(1);
    } finally {
      coordinator.dispose();
      await clients.close();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
