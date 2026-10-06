import { createServer } from "node:net";

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

export interface WaitForPageOptions {
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly readLaunchDiagnostics?: () => {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
  };
}

export function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new TypeError("loopback port was not assigned"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}

export async function waitForPage(port: number, options: WaitForPageOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(probeTimeoutMs) ||
    probeTimeoutMs < 1
  ) {
    throw new TypeError("desktop renderer wait timing is invalid");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(probeTimeoutMs, remaining))),
      });
      if (response.ok) {
        const entries = (await response.json()) as readonly {
          readonly type?: unknown;
          readonly url?: unknown;
          readonly webSocketDebuggerUrl?: unknown;
        }[];
        const page = entries.find(
          (entry) =>
            entry.type === "page" &&
            typeof entry.url === "string" &&
            entry.url.startsWith("enduragent://app/") &&
            typeof entry.webSocketDebuggerUrl === "string",
        );
        if (page !== undefined) return page.webSocketDebuggerUrl as string;
      }
    } catch {}
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(25, remaining)));
    }
  }
  const diagnostics = options.readLaunchDiagnostics?.();
  throw new Error(
    [
      "timed out waiting for the desktop renderer",
      ...(diagnostics === undefined
        ? []
        : [
            `Electron exit code: ${diagnostics.exitCode}; signal: ${diagnostics.signalCode}`,
            `Electron stdout (last 4096 characters):\n${diagnostics.stdout.slice(-4096)}`,
            `Electron stderr (last 4096 characters):\n${diagnostics.stderr.slice(-4096)}`,
          ]),
    ].join("\n"),
  );
}

export function connectCdp(
  url: string,
  onEvent: (message: CdpResponse) => void,
): Promise<{
  readonly socket: WebSocket;
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}> {
  return new Promise((resolveConnection, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      {
        readonly resolve: (value: Record<string, unknown>) => void;
        readonly reject: (error: Error) => void;
      }
    >();
    let sequence = 0;
    socket.addEventListener(
      "error",
      () => reject(new Error("desktop debugger connection failed")),
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id === undefined) {
        onEvent(message);
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error.message ?? "desktop debugger command failed"));
      } else {
        waiter.resolve(message.result ?? {});
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error("desktop debugger disconnected"));
      }
      pending.clear();
    });
    socket.addEventListener(
      "open",
      () => {
        resolveConnection({
          socket,
          call(method, params = {}) {
            const id = ++sequence;
            return new Promise((resolveCall, rejectCall) => {
              pending.set(id, { resolve: resolveCall, reject: rejectCall });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        });
      },
      { once: true },
    );
  });
}
