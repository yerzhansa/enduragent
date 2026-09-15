import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { TextDecoder } from "node:util";

export const MODEL_CATALOG_ENDPOINT = "https://api.enduragent.icu/models/v1/catalog.json";
export const MODEL_CATALOG_REQUEST_TIMEOUT_MS = 5_000;
export const MODEL_CATALOG_RESPONSE_LIMIT_BYTES = 512 * 1_024;

export class ResponseLimitError extends Error {}

export function nodeTlsVerificationEnabled(): boolean {
  return process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const singleDispatchFetch: typeof globalThis.fetch = async (input, init) => {
  if (input instanceof Request) throw new TypeError("Request objects are not supported");
  if (init?.body !== undefined && init.body !== null) {
    throw new TypeError("Request bodies are not supported");
  }
  const endpoint = new URL(input);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("Unsupported model catalog protocol");
  }
  const method = init?.method ?? "GET";
  if (method.toUpperCase() !== "GET") throw new TypeError("Only GET requests are supported");
  const headers = Object.fromEntries(new Headers(init?.headers));
  const request = endpoint.protocol === "https:" ? requestHttps : requestHttp;
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      endpoint,
      {
        headers,
        method: "GET",
        rejectUnauthorized: true,
        signal: init?.signal ?? undefined,
      },
      (incoming) => {
        const status = incoming.statusCode;
        if (status === undefined) {
          incoming.destroy();
          reject(new Error("Model catalog response omitted a status"));
          return;
        }
        if (REDIRECT_STATUSES.has(status)) {
          incoming.destroy();
          reject(new Error("Model catalog redirects are not allowed"));
          return;
        }
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
          }
          let closed = false;
          let receivedBytes = 0;
          const body =
            status === 204 || status === 205 || status === 304
              ? null
              : new ReadableStream<Uint8Array>({
                  start(controller) {
                    const fail = (error: unknown): void => {
                      if (closed) return;
                      closed = true;
                      controller.error(error);
                    };
                    incoming.on("data", (chunk: Buffer) => {
                      if (closed) return;
                      receivedBytes += chunk.byteLength;
                      if (receivedBytes > MODEL_CATALOG_RESPONSE_LIMIT_BYTES) {
                        closed = true;
                        controller.error(new ResponseLimitError());
                        incoming.destroy();
                        return;
                      }
                      controller.enqueue(chunk);
                    });
                    incoming.once("aborted", () => fail(new Error("Response aborted")));
                    incoming.once("error", fail);
                    incoming.once("end", () => {
                      if (closed) return;
                      closed = true;
                      controller.close();
                    });
                  },
                  cancel() {
                    closed = true;
                    incoming.destroy();
                  },
                });
          resolve(
            new Response(body, {
              headers: responseHeaders,
              status,
              statusText: incoming.statusMessage,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    outgoing.once("error", reject);
    outgoing.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Model catalog protocol upgrades are not allowed"));
    });
    outgoing.end();
  });
};

export async function cancelResponseBody(
  response: Response,
  controller: AbortController,
): Promise<void> {
  controller.abort();
  try {
    await response.body?.cancel();
  } catch {}
}

export async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MODEL_CATALOG_RESPONSE_LIMIT_BYTES) {
      throw new ResponseLimitError();
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MODEL_CATALOG_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new ResponseLimitError();
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}
