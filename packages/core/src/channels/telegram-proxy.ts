import type { ApiClientOptions } from "grammy";
import { ProxyAgent } from "proxy-agent";

// grammY's Node transport supplies its own agent, so the usual proxy environment
// variables are otherwise ignored. ProxyAgent selects HTTP_PROXY / HTTPS_PROXY
// for each request and honors NO_PROXY (including their lowercase variants).
const agent = new ProxyAgent({ keepAlive: true });

export const telegramApiClientOptions: ApiClientOptions = {
  baseFetchConfig: { agent },
};
