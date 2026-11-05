import { Agent } from "node:https";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, type ApiClientOptions } from "grammy";

const COMMAND_ACK_MAX_RETRY_DELAY_SECONDS = 5;

export function telegramApiClientOptions(proxyEnv: NodeJS.ProcessEnv): ApiClientOptions {
  return { baseFetchConfig: { agent: new Agent({ keepAlive: true, proxyEnv }) } };
}

export function createRateLimitRetryingBot(token: string, proxyEnv: NodeJS.ProcessEnv): Bot {
  const bot = new Bot(token, { client: telegramApiClientOptions(proxyEnv) });
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: 1,
      maxDelaySeconds: COMMAND_ACK_MAX_RETRY_DELAY_SECONDS,
      rethrowInternalServerErrors: true,
      rethrowHttpErrors: true,
    }),
  );
  return bot;
}
