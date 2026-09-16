import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type RequestListener,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";

export interface CountedHttpRequest {
  readonly headers: IncomingHttpHeaders;
  readonly method: string | undefined;
  readonly url: string | undefined;
}

export interface CountedHttpResponse {
  readonly chunks?: readonly (string | Uint8Array)[];
  readonly delayBetweenChunksMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface CountedHttpServer {
  readonly requests: readonly CountedHttpRequest[];
  readonly url: string;
  close(): Promise<void>;
}

export interface CountedHttpsServerCredentials {
  readonly certificate: string;
  readonly hostname: string;
  readonly privateKey: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function countedRequestListener(
  requests: CountedHttpRequest[],
  respond: (request: CountedHttpRequest, index: number) => CountedHttpResponse,
): RequestListener {
  return async (request, response) => {
    const received = {
      headers: request.headers,
      method: request.method,
      url: request.url,
    };
    const index = requests.push(received) - 1;
    const selected = respond(received, index);
    response.writeHead(selected.status, selected.headers);
    for (const chunk of selected.chunks ?? []) {
      response.write(chunk);
      if (selected.delayBetweenChunksMs !== undefined) {
        await delay(selected.delayBetweenChunksMs);
      }
    }
    response.end();
  };
}

async function startCountedServer(
  server: Server,
  protocol: "http" | "https",
  hostname: string,
  requests: CountedHttpRequest[],
): Promise<CountedHttpServer> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing server address");
  return {
    requests,
    url: `${protocol}://${hostname}:${address.port}/models/v1/catalog.json`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

export async function startCountedHttpServer(
  respond: (request: CountedHttpRequest, index: number) => CountedHttpResponse,
): Promise<CountedHttpServer> {
  const requests: CountedHttpRequest[] = [];
  const server = createHttpServer(countedRequestListener(requests, respond));
  return await startCountedServer(server, "http", "127.0.0.1", requests);
}

export async function startCountedHttpsServer(
  credentials: CountedHttpsServerCredentials,
  respond: (request: CountedHttpRequest, index: number) => CountedHttpResponse,
): Promise<CountedHttpServer> {
  const requests: CountedHttpRequest[] = [];
  const server = createHttpsServer(
    { cert: credentials.certificate, key: credentials.privateKey },
    countedRequestListener(requests, respond),
  );
  return await startCountedServer(server, "https", credentials.hostname, requests);
}
