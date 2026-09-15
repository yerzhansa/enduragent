import { DomainError, asCredits, asUsdMillis } from "./domain.js";
export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

export type DurableObjectId = { toString(): string };

export type DurableObjectStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type DurableObjectState = {
  id: DurableObjectId;
};

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

export type D1Database = {
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<unknown>;
};

export type Env = {
  DB: D1Database;
  ATHLETE_SESSION: DurableObjectNamespace;
  RATE_LIMIT_IP: RateLimitBinding;
  RATE_LIMIT_TOKEN: RateLimitBinding;
  OPENROUTER_MANAGEMENT_KEY: string;
  APPLE_APP_STORE_P8: string;
  APPLE_APP_STORE_KEY_ID: string;
  APPLE_APP_STORE_ISSUER_ID: string;
  APPLE_DEVICECHECK_P8: string;
  APPLE_DEVICECHECK_KEY_ID: string;
  APPLE_DEVICECHECK_TEAM_ID: string;
  INTERVALS_OAUTH_CLIENT_SECRET: string;
  OPERATOR_TOKEN: string;
  OPENROUTER_GUARDRAIL_ID: string | undefined;
  KEY_COUNT_CEILING: string | undefined;
  BUNDLE_ID: string;
  APPLE_ENVIRONMENT: "sandbox" | "production";
  PURCHASES_ENABLED: string;
  STARTER_CAP_USD: string;
  CREDITS_PER_USD: string;
  APPLE_COMMISSION: string;
  OPENROUTER_FEE: string;
  RATIO: string;
  GUARDRAIL_MODE: "at_create" | "after_create" | "off";
  CONSUMPTION_REPORTING: "unverified" | "enabled" | "disabled";
  REPEAT_REFUND_BAN_THRESHOLD: string;
  INTERVALS_OAUTH_ENABLED: string;
};

export function workerConfig(env: Env) {
  const number = (raw: string, integer = false) => {
    if (typeof raw !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(raw))
      throw new DomainError("unavailable");
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
      throw new DomainError("unavailable");
    return value;
  };
  if (
    env.KEY_COUNT_CEILING !== undefined ||
    !["at_create", "after_create", "off"].includes(env.GUARDRAIL_MODE) ||
    env.APPLE_ENVIRONMENT !== "sandbox" ||
    !["unverified", "enabled", "disabled"].includes(env.CONSUMPTION_REPORTING)
  )
    throw new DomainError("unavailable");
  for (const value of [env.PURCHASES_ENABLED, env.INTERVALS_OAUTH_ENABLED])
    if (value !== "true" && value !== "false") throw new DomainError("unavailable");
  const creditsPerUsd = number(env.CREDITS_PER_USD, true);
  const starter = number(env.STARTER_CAP_USD);
  const repeatRefundBanThreshold = number(env.REPEAT_REFUND_BAN_THRESHOLD, true);
  if (
    creditsPerUsd === 0 ||
    repeatRefundBanThreshold === 0 ||
    number(env.APPLE_COMMISSION) >= 1 ||
    number(env.OPENROUTER_FEE) >= 1 ||
    number(env.RATIO) === 0
  )
    throw new DomainError("unavailable");
  return {
    openRouter: {
      guardrailMode: env.GUARDRAIL_MODE,
      guardrailId: env.OPENROUTER_GUARDRAIL_ID,
      keyCountCeiling: undefined,
    },
    starterCapUsdMillis: asUsdMillis(Math.round(starter * 1000)),
    starterCredits: asCredits(Math.round(starter * creditsPerUsd)),
    repeatRefundBanThreshold,
  };
}
