import { workerConfig } from "./env.js";
import { AppStoreServerClient, DeviceCheckClient } from "./apple.js";
import { bindDurableRuntime, createCreditsApp, type AppPorts } from "./app.js";
import { AthleteSession } from "./athlete-session.js";
import type { Env } from "./env.js";
import { IntervalsOAuthClient } from "./intervals.js";
import { D1Ledger } from "./ledger.js";
import { consoleLog } from "./log.js";
import { createOperator } from "./ops.js";
import { OpenRouterManagementClient } from "./openrouter.js";

export function productionPorts(env: Env): AppPorts {
  const config = workerConfig(env);
  const ledger = new D1Ledger(env.DB);
  const apple = new AppStoreServerClient(env);
  const deviceCheck = new DeviceCheckClient(env);
  const keys = new OpenRouterManagementClient(env.OPENROUTER_MANAGEMENT_KEY, config.openRouter);
  const runtime = bindDurableRuntime(env);
  const intervals = new IntervalsOAuthClient(env.INTERVALS_OAUTH_CLIENT_SECRET);
  return {
    apple,
    deviceCheck,
    keys,
    ledger,
    runtime,
    operator: createOperator({ ledger, keys, apple, deviceCheck, runtime }),
    ipLimit: {
      async take(key) {
        const result = await env.RATE_LIMIT_IP.limit({ key });
        return result.success ? "allow" : "deny";
      },
    },
    tokenLimit: {
      async take(key) {
        const result = await env.RATE_LIMIT_TOKEN.limit({ key });
        return result.success ? "allow" : "deny";
      },
    },
    log: consoleLog,
    starterCapUsdMillis: config.starterCapUsdMillis,
    starterCredits: config.starterCredits,
    purchasesEnabled: env.PURCHASES_ENABLED === "true",
    intervalsOAuthEnabled: env.INTERVALS_OAUTH_ENABLED === "true",
    intervalsExchange: (code) => intervals.exchange(code),
  };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health")
      return Response.json({ ok: true });
    try {
      return await createCreditsApp(productionPorts(env)).fetch(request, env, ctx);
    } catch {
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
  },
};

export { AthleteSession };
