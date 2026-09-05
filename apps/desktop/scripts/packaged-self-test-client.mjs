import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";

export async function capturePackagedSelfTest({ athleteHome, rpcUrl, timeoutMs }) {
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  let client;
  let socket;
  let stdout = "";
  let stderr = "";
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("self-test command timed out"));
    }, timeoutMs);
  });
  const operation = async () => {
    const { connectCoachSelfTestClient, runCoachSelfTest } =
      await import("../../../packages/coach-cli/dist/index.js");
    const token = (await readFile(join(athleteHome, "config/daemon.token"), "utf8")).trim();
    controller.signal.throwIfAborted();
    const code = await runCoachSelfTest({
      connect: async () => {
        const remainingMs = Math.max(1, Math.ceil(expiresAt - performance.now()));
        client = await connectCoachSelfTestClient({
          url: rpcUrl,
          token,
          expectedAthleteHome: athleteHome,
          signal: controller.signal,
          connectTimeoutMs: remainingMs,
          handshakeTimeoutMs: remainingMs,
          webSocketFactory: (url) => {
            socket = new WebSocket(url);
            return socket;
          },
        });
        if (controller.signal.aborted) {
          await client.close();
          controller.signal.throwIfAborted();
        }
        return client;
      },
      terminal: {
        stdout: new Writable({
          write(chunk, _encoding, callback) {
            stdout += String(chunk);
            callback();
          },
        }),
        stderr: new Writable({
          write(chunk, _encoding, callback) {
            stderr += String(chunk);
            callback();
          },
        }),
      },
    });
    if (stdout.includes(token) || stdout.includes(athleteHome) || stderr !== "") {
      throw new Error("self-test output exposed private data");
    }
    return { code, signal: null, stdout, stderr };
  };
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) socket.close();
    await client?.close();
  }
}
