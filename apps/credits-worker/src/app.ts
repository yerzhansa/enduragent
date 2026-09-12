import type { AppleStore, DeviceCheck } from "./apple.js";
import { encodeCommand, decodeResult, type AthleteRuntime } from "./athlete-session.js";
import type {
  AthleteCommand,
  AthleteId,
  AthleteResult,
  DeviceCheckToken,
  DomainErrorCode,
} from "./domain.js";
import { DomainError, athleteIdFromUuid, asCredits, asUsdMillis } from "./domain.js";
import type { Env } from "./env.js";
import type { Ledger } from "./ledger.js";
import type { RedactingLog } from "./log.js";
import type { Operator } from "./ops.js";
import type { OpenRouterKeys } from "./openrouter.js";

export type RateLimiter = {
  take(key: string): Promise<"allow" | "deny">;
};

export type RouteName =
  | "grant"
  | "claim"
  | "recover"
  | "apple"
  | "catalog"
  | "health"
  | "opsPricing"
  | "opsPacks"
  | "opsBan"
  | "opsSpend"
  | "intervalsToken";

export type Route = {
  method: "GET" | "POST";
  path: string;
  name: RouteName;
  audience: "phone" | "apple" | "operator" | "probe";
};

export const routes: readonly Route[] = [
  { method: "POST", path: "/grant", name: "grant", audience: "phone" },
  { method: "POST", path: "/claim", name: "claim", audience: "phone" },
  { method: "POST", path: "/recover", name: "recover", audience: "phone" },
  { method: "POST", path: "/apple", name: "apple", audience: "apple" },
  { method: "GET", path: "/catalog", name: "catalog", audience: "phone" },
  { method: "GET", path: "/health", name: "health", audience: "probe" },
  { method: "POST", path: "/ops/pricing", name: "opsPricing", audience: "operator" },
  { method: "POST", path: "/ops/packs", name: "opsPacks", audience: "operator" },
  { method: "POST", path: "/ops/ban", name: "opsBan", audience: "operator" },
  { method: "GET", path: "/ops/spend", name: "opsSpend", audience: "operator" },
  { method: "POST", path: "/intervals/token", name: "intervalsToken", audience: "phone" },
];

export type PhoneGrant = {
  athleteId: AthleteId;
  deviceCheckToken: DeviceCheckToken;
};

export type PhoneClaim = { signedTransaction: string };
export type PhoneRecover = { signedTransaction: string };

export type GrantHandler = (input: PhoneGrant) => Promise<AthleteResult>;
export type ClaimHandler = (input: PhoneClaim) => Promise<AthleteResult>;
export type RecoverHandler = (input: PhoneRecover) => Promise<AthleteResult>;
export type AppleWebhookHandler = (
  signedPayload: string,
) => Promise<AthleteResult | { kind: "ignored" }>;
export type CatalogHandler = () => Promise<{
  purchasesEnabled: boolean;
  creditsPerUsd: number;
  packs: readonly { productId: string; credits: number }[];
}>;
export type HealthHandler = () => Promise<{ ok: true }>;
export type IntervalsTokenHandler = (authorizationCode: string) => Promise<{
  accessToken: string;
  refreshToken: string;
}>;

export type CreditsApp = {
  fetch(
    request: Request,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<Response>;
};

export type AppPorts = {
  apple: AppleStore;
  deviceCheck: DeviceCheck;
  keys: OpenRouterKeys;
  ledger: Ledger;
  runtime: AthleteRuntime;
  operator: Operator;
  ipLimit: RateLimiter;
  tokenLimit: RateLimiter;
  log: RedactingLog;
  starterCapUsdMillis: number;
  starterCredits: number;
  purchasesEnabled: boolean;
  intervalsOAuthEnabled: boolean;
  intervalsExchange: IntervalsTokenHandler | undefined;
};

const PHONE_ROUTES = new Set<RouteName>(["grant", "claim", "recover", "catalog"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

export function createCreditsApp(ports: AppPorts): CreditsApp {
  return {
    async fetch(request, env, _ctx) {
      const url = new URL(request.url);
      const route = routes.find(
        (entry) => entry.method === request.method && entry.path === url.pathname,
      );
      if (!route || !PHONE_ROUTES.has(route.name)) {
        return new Response("Not Found", { status: 404 });
      }
      try {
        if ((await ports.ipLimit.take(clientIp(request))) === "deny") {
          throw new DomainError("rate_limited");
        }
        switch (route.name) {
          case "grant": {
            const grant = await parseGrant(request);
            if ((await ports.tokenLimit.take(grant.athleteId)) === "deny") {
              throw new DomainError("rate_limited");
            }
            const result = await ports.runtime.run(grant.athleteId, {
              kind: "grant",
              deviceCheckToken: grant.deviceCheckToken,
              starterCapUsdMillis: asUsdMillis(ports.starterCapUsdMillis),
              starterCredits: asCredits(ports.starterCredits),
            });
            ports.log.info({
              route: route.name,
              athleteId: grant.athleteId,
              outcome: result.kind,
            });
            return Response.json(result);
          }
          case "claim": {
            const command = await parseClaim(request, ports.apple, env);
            if (command.kind !== "claim") throw new DomainError("identity_mismatch");
            if ((await ports.tokenLimit.take(command.purchase.athleteId)) === "deny") {
              throw new DomainError("rate_limited");
            }
            const result = await ports.runtime.run(command.purchase.athleteId, command);
            ports.log.info({
              route: route.name,
              athleteId: command.purchase.athleteId,
              transactionId: command.purchase.transactionId,
              outcome: result.kind,
            });
            return Response.json(result);
          }
          case "recover": {
            const command = await parseRecover(request, ports.apple, env);
            if ((await ports.tokenLimit.take(command.purchase.athleteId)) === "deny") {
              throw new DomainError("rate_limited");
            }
            const result = await ports.runtime.run(command.purchase.athleteId, command);
            ports.log.info({
              route: route.name,
              athleteId: command.purchase.athleteId,
              transactionId: command.purchase.transactionId,
              outcome: result.kind,
            });
            return Response.json(result);
          }
          case "catalog": {
            if ((await ports.tokenLimit.take("catalog")) === "deny") {
              throw new DomainError("rate_limited");
            }
            const policy = await ports.ledger.currentPolicy();
            const packs = await ports.ledger.activePacks(policy.version);
            ports.log.info({ route: route.name, outcome: "catalog" });
            return Response.json({
              purchasesEnabled: ports.purchasesEnabled,
              creditsPerUsd: policy.creditsPerUsd,
              packs: packs.map((pack) => ({
                productId: pack.productId,
                credits: pack.credits,
              })),
            });
          }
          default:
            return new Response("Not Found", { status: 404 });
        }
      } catch (error) {
        if (error instanceof DomainError) {
          ports.log.warn({ route: route.name, outcome: error.code });
          return Response.json({ error: error.code }, { status: statusFor(error.code) });
        }
        throw error;
      }
    },
  };
}

export async function parseGrant(request: Request): Promise<PhoneGrant> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new DomainError("identity_mismatch");
  if (typeof body.athleteId !== "string" || typeof body.deviceCheckToken !== "string") {
    throw new DomainError("identity_mismatch");
  }
  return {
    athleteId: athleteIdFromUuid(body.athleteId),
    deviceCheckToken: body.deviceCheckToken as DeviceCheckToken,
  };
}

export async function parseClaim(
  request: Request,
  apple: AppleStore,
  env: Env,
): Promise<AthleteCommand> {
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.signedTransaction !== "string") {
    throw new DomainError("identity_mismatch");
  }
  const purchase = await apple.verifySignedTransaction(body.signedTransaction, {
    bundleId: env.BUNDLE_ID,
    environment: env.APPLE_ENVIRONMENT,
  });
  return { kind: "claim", purchase };
}

async function parseRecover(
  request: Request,
  apple: AppleStore,
  env: Env,
): Promise<Extract<AthleteCommand, { kind: "recover" }>> {
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.signedTransaction !== "string") {
    throw new DomainError("identity_mismatch");
  }
  const purchase = await apple.verifySignedTransaction(body.signedTransaction, {
    bundleId: env.BUNDLE_ID,
    environment: env.APPLE_ENVIRONMENT,
  });
  return { kind: "recover", purchase };
}

export function statusFor(code: DomainErrorCode): number {
  switch (code) {
    case "banned":
      return 403;
    case "rate_limited":
      return 429;
    case "unavailable":
      return 503;
    case "purchases_disabled":
    case "unknown_pack":
    case "not_our_bundle":
    case "wrong_environment":
    case "no_purchase_to_recover":
    case "identity_mismatch":
      return 400;
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

export function bindDurableRuntime(env: Env): AthleteRuntime {
  return {
    async run(athleteId, command) {
      const id = env.ATHLETE_SESSION.idFromName(athleteId);
      const stub = env.ATHLETE_SESSION.get(id);
      const encoded = await encodeCommand(command);
      const request = new Request(`https://athlete.session/${athleteId}`, {
        method: "POST",
        headers: encoded.headers,
        body: encoded.body,
      });
      const response = await stub.fetch(request);
      return decodeResult(response);
    },
  };
}

export { athleteIdFromUuid, DomainError };
