import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { DesktopFixtureScript } from "./scripted-coach.js";

interface FixtureConnection {
  readonly origin: string;
  readonly token: string;
  readonly streaming: boolean;
  readonly routeChatAttachmentComposer: boolean;
  readonly routeChatAttachmentOperations: boolean;
}

export function parseFixtureConnection(serialized: string | undefined): FixtureConnection {
  const value: unknown = JSON.parse(serialized ?? "null");
  if (
    value === null ||
    typeof value !== "object" ||
    !("origin" in value) ||
    typeof value.origin !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(value.origin) ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    !("streaming" in value) ||
    typeof value.streaming !== "boolean" ||
    !("routeChatAttachmentComposer" in value) ||
    typeof value.routeChatAttachmentComposer !== "boolean" ||
    !("routeChatAttachmentOperations" in value) ||
    typeof value.routeChatAttachmentOperations !== "boolean"
  )
    throw new TypeError("invalid desktop fixture connection");
  return {
    origin: value.origin,
    token: value.token,
    streaming: value.streaming,
    routeChatAttachmentComposer: value.routeChatAttachmentComposer,
    routeChatAttachmentOperations: value.routeChatAttachmentOperations,
  };
}

export async function startFixtureBridge(input: {
  readonly script: DesktopFixtureScript;
  readonly routeChatAttachmentComposer?: boolean;
  readonly routeChatAttachmentOperations?: boolean;
}) {
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST" || (request.url !== "/request" && request.url !== "/stream")) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const value: unknown = JSON.parse(body);
      if (request.url === "/request") {
        const frames = await input.script.onRequest(value);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(frames));
        return;
      }
      if (input.script.onStreamRequest === undefined) throw new Error("fixture streaming disabled");
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      const frame = await input.script.onStreamRequest(value, (event) => {
        response.write(`${JSON.stringify({ type: "event", frame: event })}\n`);
      });
      response.end(`${JSON.stringify({ type: "terminal", frame })}\n`);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture bridge unavailable");
  return {
    connection: {
      origin: `http://127.0.0.1:${address.port}`,
      token,
      streaming: input.script.onStreamRequest !== undefined,
      routeChatAttachmentComposer: input.routeChatAttachmentComposer === true,
      routeChatAttachmentOperations: input.routeChatAttachmentOperations === true,
    } satisfies FixtureConnection,
    async close(): Promise<void> {
      const closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
      await closing;
    },
  };
}

export function createBridgeScript(connection: FixtureConnection): DesktopFixtureScript {
  const request = async (route: string, value: unknown): Promise<Response> => {
    const response = await fetch(`${connection.origin}/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("desktop fixture request failed");
    return response;
  };
  return {
    async onRequest(value) {
      const frames: unknown = await (await request("request", value)).json();
      if (
        !Array.isArray(frames) ||
        !frames.every((frame): frame is string => typeof frame === "string")
      ) {
        throw new TypeError("invalid desktop fixture frames");
      }
      return frames;
    },
    ...(connection.streaming
      ? {
          async onStreamRequest(value: unknown, emitFrame: (frame: string) => void) {
            const response = await request("stream", value);
            if (response.body === null) throw new Error("desktop fixture stream missing");
            const lines = createInterface({
              input: Readable.from(response.body),
              crlfDelay: Infinity,
            });
            let terminal: string | undefined;
            for await (const line of lines) {
              const frame: unknown = JSON.parse(line);
              if (
                frame === null ||
                typeof frame !== "object" ||
                !("type" in frame) ||
                !("frame" in frame) ||
                typeof frame.frame !== "string"
              ) {
                throw new TypeError("invalid desktop fixture stream frame");
              }
              if (terminal !== undefined) throw new Error("desktop fixture frame after terminal");
              if (frame.type === "event") emitFrame(frame.frame);
              else if (frame.type === "terminal") terminal = frame.frame;
              else throw new TypeError("invalid desktop fixture stream type");
            }
            if (terminal === undefined) throw new Error("desktop fixture terminal missing");
            return terminal;
          },
        }
      : {}),
  };
}
