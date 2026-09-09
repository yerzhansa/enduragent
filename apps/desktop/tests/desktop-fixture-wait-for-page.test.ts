import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPage } from "../scripts/support/desktop-cdp.js";

describe("Desktop renderer discovery", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    }
  });

  it("honors the overall deadline when a debugging probe never responds", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError();

    const started = performance.now();
    await expect(waitForPage(address.port, { timeoutMs: 150, probeTimeoutMs: 25 })).rejects.toThrow(
      "timed out waiting for the desktop renderer",
    );
    expect(performance.now() - started).toBeLessThan(750);
  });

  it.each([
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: "SIGABRT" },
    { exitCode: null, signalCode: null },
  ] satisfies { exitCode: number | null; signalCode: NodeJS.Signals | null }[])(
    "includes current output tails and child status $exitCode/$signalCode at timeout",
    async ({ exitCode, signalCode }) => {
      let stdout = "before launch";
      let stderr = "before launch";
      const server = createServer((_request, response) => {
        stdout = `discarded stdout${"o".repeat(4096)}`;
        stderr = `discarded stderr${"e".repeat(4096)}`;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("[]");
      });
      servers.push(server);
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new TypeError();
      const readLaunchDiagnostics = vi.fn(() => ({ stdout, stderr, exitCode, signalCode }));

      await expect(
        waitForPage(address.port, { timeoutMs: 150, readLaunchDiagnostics }),
      ).rejects.toThrow(
        [
          "timed out waiting for the desktop renderer",
          `Electron exit code: ${exitCode}; signal: ${signalCode}`,
          `Electron stdout (last 4096 characters):\n${"o".repeat(4096)}`,
          `Electron stderr (last 4096 characters):\n${"e".repeat(4096)}`,
        ].join("\n"),
      );
      expect(readLaunchDiagnostics).toHaveBeenCalledTimes(1);
    },
  );
});
