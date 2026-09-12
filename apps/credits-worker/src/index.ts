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
  const ledger = new D1Ledger(env.DB);
  const apple = new AppStoreServerClient(env);
  const deviceCheck = new DeviceCheckClient(env);
  const keys = new OpenRouterManagementClient(env.OPENROUTER_MANAGEMENT_KEY, {
    guardrailMode: env.GUARDRAIL_MODE,
    guardrailId: env.OPENROUTER_GUARDRAIL_ID,
    keyCountCeiling: env.KEY_COUNT_CEILING ? Number(env.KEY_COUNT_CEILING) : undefined,
  });
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
    starterCapUsdMillis: Math.round(Number(env.STARTER_CAP_USD) * 1000),
    starterCredits: Math.round(Number(env.STARTER_CAP_USD) * Number(env.CREDITS_PER_USD)),
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
    return createCreditsApp(productionPorts(env)).fetch(request, env, ctx);
  },
};

export { AthleteSession };
