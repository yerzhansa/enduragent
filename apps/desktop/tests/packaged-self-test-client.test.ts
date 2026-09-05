import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  ClientHandshakeFrameSchema,
  SelfTestCommandTerminalSchema,
  createAcceptedServerHandshakeFrame,
  parseCoachRpcEnvelope,
  type SelfTestRpcResult,
} from "@enduragent/coach-contract";
import { capturePackagedSelfTest } from "../scripts/packaged-self-test-client.mjs";

const token = "synthetic-packaged-diagnostic-token";
const roots: string[] = [];
const servers: WebSocketServer[] = [];
const success = {
  schemaVersion: 1,
  type: "self-test-terminal",
  ok: true,
  runtime: { node: "24.19.0", electron: "43.1.1", v8: "15.0" },
  resources: {
    algorithm: "sha256",
    matrixSha256: "a".repeat(64),
    insideAsarSha256: "a".repeat(64),
    extraResourcesSha256: "a".repeat(64),
    byteIdentical: true,
  },
  suites: { parity: { cases: 2, passed: 2 }, differential: { cases: 3, passed: 3 } },
} satisfies SelfTestRpcResult;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  options: {
    readonly result?: SelfTestRpcResult;
    readonly wrongHome?: boolean;
    readonly malformedProgress?: boolean;
    readonly stall?: "handshake" | "operation";
  } = {},
) {
  const athleteHome = await mkdtemp(join(tmpdir(), "ea-diagnostic-"));
  roots.push(athleteHome);
  await mkdir(join(athleteHome, "config"));
  await writeFile(join(athleteHome, "config/daemon.token"), `${token}\n`);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  let calls = 0;
  let closed = false;
  let authenticated = false;
  server.on("connection", (socket, request) => {
    expect(request.url).toBe("/");
    socket.on("close", () => {
      closed = true;
    });
    socket.on("message", (raw) => {
      const handshake = ClientHandshakeFrameSchema.safeParse(JSON.parse(String(raw)));
      if (handshake.success) {
        authenticated = handshake.data.token === token;
        if (options.stall === "handshake") return;
        socket.send(
          JSON.stringify(
            createAcceptedServerHandshakeFrame("app-supervised", PROTOCOL_VERSION, {
              athleteHome: options.wrongHome ? join(athleteHome, "other") : athleteHome,
              rendererCapability: "A".repeat(43),
            }),
          ),
        );
        return;
      }
      const frame = parseCoachRpcEnvelope(String(raw));
      if (!("method" in frame) || frame.method !== "selfTest") {
        throw new Error("unexpected diagnostic request");
      }
      calls += 1;
      expect(frame.method).toBe("selfTest");
      expect(frame.params).toEqual({});
      if (options.stall === "operation") return;
      const events = [
        { phase: "started", completed: 0, total: 1 },
        { phase: "completed", completed: 1, total: 1 },
      ];
      if (options.malformedProgress) events.reverse();
      for (const event of events) {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "coach.operationProgress",
            params: { requestId: frame.id, requestMethod: "selfTest", event },
          }),
        );
      }
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: options.result ?? success }),
      );
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing RPC address");
  return {
    athleteHome,
    rpcUrl: `ws://127.0.0.1:${address.port}`,
    state: () => ({ calls, closed, authenticated }),
  };
}

describe("packaged diagnostic RPC client", () => {
  it("runs through the app-owned service without exposing its home or token and closes", async () => {
    const input = await fixture();
    const output = await capturePackagedSelfTest({ ...input, timeoutMs: 5_000 });
    expect(output).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(output.stdout.split("\n")).toHaveLength(2);
    expect(SelfTestCommandTerminalSchema.parse(JSON.parse(output.stdout))).toEqual(success);
    expect(output.stdout).not.toContain(token);
    expect(output.stdout).not.toContain(input.athleteHome);
    await expect.poll(input.state).toEqual({ calls: 1, closed: true, authenticated: true });
  });

  it("preserves the checksum failure terminal and exit code", async () => {
    const result = {
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: false,
      error: {
        code: "CHECKSUM_MISMATCH",
        message: "packaged self-test resource checksum mismatch",
        location: "extraResources",
        resource: "matrix.json",
        expectedSha256: "a".repeat(64),
        actualSha256: "b".repeat(64),
      },
    } satisfies SelfTestRpcResult;
    const input = await fixture({ result });
    const output = await capturePackagedSelfTest({ ...input, timeoutMs: 5_000 });
    expect(output.code).toBe(7);
    expect(SelfTestCommandTerminalSchema.parse(JSON.parse(output.stdout))).toEqual(result);
    await expect.poll(() => input.state().closed).toBe(true);
  });

  it("rejects a different athlete home before diagnostic dispatch", async () => {
    const input = await fixture({ wrongHome: true });
    const output = await capturePackagedSelfTest({ ...input, timeoutMs: 5_000 });
    expect(output.code).not.toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ error: { code: "DAEMON_UNAVAILABLE" } });
    await expect.poll(input.state).toEqual({ calls: 0, closed: true, authenticated: true });
  });

  it("rejects malformed progress despite a successful terminal", async () => {
    const input = await fixture({ malformedProgress: true });
    const output = await capturePackagedSelfTest({ ...input, timeoutMs: 5_000 });
    expect(output.code).not.toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({ error: { code: "RUNNER_ERROR" } });
    await expect.poll(() => input.state().closed).toBe(true);
  });

  it("refuses a terminal that contains the daemon token", async () => {
    const input = await fixture({
      result: {
        ...success,
        runtime: { ...success.runtime, v8: token },
      },
    });
    await expect(capturePackagedSelfTest({ ...input, timeoutMs: 5_000 })).rejects.toThrow(
      "self-test output exposed private data",
    );
    await expect.poll(() => input.state().closed).toBe(true);
  });

  it.each(["handshake", "operation"] as const)(
    "closes a stalled %s at the deadline",
    async (stall) => {
      const input = await fixture({ stall });
      await expect(capturePackagedSelfTest({ ...input, timeoutMs: 100 })).rejects.toThrow(
        "self-test command timed out",
      );
      await expect.poll(() => input.state().closed).toBe(true);
    },
  );
});
