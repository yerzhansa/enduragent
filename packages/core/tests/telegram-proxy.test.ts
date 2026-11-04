import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { Api } from "grammy";
import { ProxyAgent } from "proxy-agent";
import { telegramApiClientOptions } from "../src/channels/telegram-proxy.js";

const keys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
const saved = new Map<string, string | undefined>();
const servers: Server[] = [];

beforeEach(() => {
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(onRequest: (url: string | undefined) => void): Promise<string> {
  const server = createServer((req, res) => {
    onRequest(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, first_name: "Test" } }));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("Telegram grammY proxy transport", () => {
  it("routes HTTP_PROXY requests through the proxy and honors NO_PROXY", async () => {
    const direct: (string | undefined)[] = [];
    const proxied: (string | undefined)[] = [];
    const apiRoot = await serve((url) => direct.push(url));
    process.env.HTTP_PROXY = await serve((url) => proxied.push(url));
    const api = new Api("test-token", { ...telegramApiClientOptions, apiRoot });

    await api.getMe();
    expect(proxied).toEqual([`${apiRoot}/bottest-token/getMe`]);
    expect(direct).toEqual([]);

    process.env.NO_PROXY = "127.0.0.1";
    await api.getMe();
    expect(direct).toEqual(["/bottest-token/getMe"]);
    expect(proxied).toHaveLength(1);
  });

  it("selects HTTPS_PROXY and lowercase proxy settings for HTTPS URLs", async () => {
    const agent = telegramApiClientOptions.baseFetchConfig?.agent;
    expect(agent).toBeInstanceOf(ProxyAgent);
    const proxy = agent as ProxyAgent;
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    expect(proxy.getProxyForUrl("https://api.telegram.org/botTEST/getMe", {} as never)).toBe(
      "http://proxy.example:8080",
    );
    delete process.env.HTTPS_PROXY;
    process.env.https_proxy = "http://other.example:8080";
    expect(proxy.getProxyForUrl("https://api.telegram.org/botTEST/getMe", {} as never)).toBe(
      "http://other.example:8080",
    );
    process.env.no_proxy = "api.telegram.org";
    expect(proxy.getProxyForUrl("https://api.telegram.org/botTEST/getMe", {} as never)).toBe("");
  });
});
