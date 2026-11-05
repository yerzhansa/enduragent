import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { once } from "node:events";
import { Api } from "grammy";
import {
  createRateLimitRetryingBot,
  telegramApiClientOptions,
} from "../src/channels/telegram-transport.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function logTunnels(): Promise<{ readonly tunnels: string[]; readonly proxyUrl: string }> {
  const tunnels: string[] = [];
  const proxy = createHttpServer();
  proxy.on("connect", (request, socket) => {
    tunnels.push(request.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  const proxyPort = await listen(proxy);
  return { tunnels, proxyUrl: `http://127.0.0.1:${proxyPort}` };
}

async function telegramRoute(env: (proxyUrl: string) => NodeJS.ProcessEnv) {
  const { tunnels, proxyUrl } = await logTunnels();
  let directConnections = 0;
  const targetPort = await listen(
    createTcpServer((socket) => {
      directConnections += 1;
      socket.destroy();
    }),
  );
  const api = new Api("123:test", {
    ...telegramApiClientOptions(env(proxyUrl)),
    apiRoot: `https://127.0.0.1:${targetPort}`,
  });
  await expect(api.getMe()).rejects.toThrow();
  return { tunnels, directConnections, target: `127.0.0.1:${targetPort}` };
}

describe("Telegram API transport", () => {
  it.each([
    ["HTTPS_PROXY", (proxy: string) => ({ HTTPS_PROXY: proxy })],
    ["lowercase https_proxy", (proxy: string) => ({ https_proxy: proxy })],
  ])("tunnels requests through %s", async (_name, env) => {
    const route = await telegramRoute(env);
    expect(route.tunnels).toEqual([route.target]);
    expect(route.directConnections).toBe(0);
  });

  it.each([
    [
      "NO_PROXY matches the host",
      (proxy: string) => ({ HTTPS_PROXY: proxy, NO_PROXY: "127.0.0.1" }),
    ],
    [
      "lowercase no_proxy matches the host",
      (proxy: string) => ({ https_proxy: proxy, no_proxy: "127.0.0.1" }),
    ],
    ["no proxy is configured", () => ({})],
  ])("connects directly when %s", async (_name, env) => {
    const route = await telegramRoute(env);
    expect(route.tunnels).toEqual([]);
    expect(route.directConnections).toBe(1);
  });

  it("routes the bot runtime client through the proxy", async () => {
    const { tunnels, proxyUrl } = await logTunnels();
    const bot = createRateLimitRetryingBot("123:test", { HTTPS_PROXY: proxyUrl });
    await expect(bot.api.getMe()).rejects.toThrow();
    expect(tunnels).toEqual(["api.telegram.org:443"]);
  });
});
