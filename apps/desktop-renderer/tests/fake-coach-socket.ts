import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  serializeCoachRpcEnvelope,
  type OperationProgressEvent,
  type RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import { vi } from "vitest";

const rendererCapability = `${"s".repeat(42)}A`;

export interface FakeCoachReply {
  progress(event: OperationProgressEvent): void;
  result(value: unknown): void;
  error(code: number, message: string): void;
}

export interface FakeCoachSocket {
  readonly received: string[];
  close(): Promise<void>;
}

export function runtimeSnapshot(
  intervals: Partial<RuntimeConfigSnapshot["intervals"]> = {},
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: true },
    intervals: {
      athlete_id: "synthetic-athlete",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
      ...intervals,
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

export async function startFakeCoachSocket(
  answer: (method: string, reply: FakeCoachReply) => void,
): Promise<FakeCoachSocket> {
  const sockets: ServerWebSocket[] = [];
  const received: string[] = [];
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
      const { id, method } = frame;
      if (method === undefined || id === undefined) return;
      received.push(method);
      answer(method, {
        progress: (event) =>
          socket.send(
            serializeCoachRpcEnvelope({
              jsonrpc: "2.0",
              method: "coach.operationProgress",
              params: { requestId: id, requestMethod: method, event },
            }),
          ),
        result: (value) =>
          socket.send(serializeCoachRpcEnvelope({ jsonrpc: "2.0", id, result: value })),
        error: (code, message) =>
          socket.send(serializeCoachRpcEnvelope({ jsonrpc: "2.0", id, error: { code, message } })),
      });
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
  return {
    received,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
