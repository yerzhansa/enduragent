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
