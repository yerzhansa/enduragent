import { describe, expect, it } from "vitest";
import { createCreditsApp, type AppPorts } from "./app.js";
import type { SessionPorts } from "./athlete-session.js";
import { type AthleteId, type DeviceCheckToken } from "./domain.js";
import type { Env as WorkerEnv } from "./env.js";
import {
  FakeAppleStore,
  FakeDeviceCheck,
  FakeOpenRouterKeys,
  MemoryLedger,
  seedLaunchPolicy,
  testClock,
  testIds,
  testRuntime,
} from "./fakes.js";
import type { RedactingLog } from "./log.js";
import { createOperator } from "./ops.js";

const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;
const token = "dc-1998-1" as DeviceCheckToken;

function allow(): AppPorts["ipLimit"] {
  return { take: async () => "allow" };
}

function deny(): AppPorts["ipLimit"] {
  return { take: async () => "deny" };
}

function silentLog(): RedactingLog {
  return {
    info() {},
    warn() {},
  };
}

function envStub(): WorkerEnv {
  return {
    BUNDLE_ID: "icu.enduragent.app",
    APPLE_ENVIRONMENT: "sandbox",
  } as WorkerEnv;
}

function ctx(): { waitUntil(p: Promise<unknown>): void } {
  return { waitUntil() {} };
}

function sessionPorts(): SessionPorts {
  const ledger = new MemoryLedger();
  seedLaunchPolicy(ledger);
  return {
    ledger,
    keys: new FakeOpenRouterKeys(),
    deviceCheck: new FakeDeviceCheck(),
    apple: new FakeAppleStore(),
    openRouter: { guardrailMode: "off", guardrailId: undefined, keyCountCeiling: undefined },
    clock: testClock,
    ids: testIds,
    purchasesEnabled: false,
    consumptionReporting: "unverified",
    bundleId: "icu.enduragent.app",
    environment: "sandbox",
    repeatRefundBanThreshold: 2,
  };
}

function appFrom(ports: SessionPorts, overrides: Partial<AppPorts> = {}): AppPorts {
  return {
    apple: ports.apple,
    deviceCheck: ports.deviceCheck,
    keys: ports.keys,
    ledger: ports.ledger,
    runtime: testRuntime(ports),
    operator: createOperator({
      ledger: ports.ledger,
      keys: ports.keys,
      apple: ports.apple,
      deviceCheck: ports.deviceCheck,
      runtime: testRuntime(ports),
    }),
    ipLimit: allow(),
    tokenLimit: allow(),
    log: silentLog(),
    starterCapUsdMillis: 2000,
    starterCredits: 200,
    purchasesEnabled: false,
    intervalsOAuthEnabled: false,
    intervalsExchange: undefined,
    ...overrides,
  };
}

describe("app", () => {
  it("grant wire kind grantMinted", async () => {
    const ports = sessionPorts();
    const info = vi.fn();
    const app = createCreditsApp(appFrom(ports, { log: { info, warn() {} } }));
    const response = await app.fetch(
      new Request("https://credits.test/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          athleteId,
          deviceCheckToken: token,
        }),
      }),
      envStub(),
      ctx(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      credits: number;
      key: string;
    };
    expect(info).toHaveBeenCalledExactlyOnceWith({ route: "grant", outcome: "grantMinted" });
    expect(body.kind).toBe("grantMinted");
    expect(body.credits).toBe(200);
    expect(body.key.startsWith("fake-or-key-")).toBe(true);
  });

  it("catalog purchasesEnabled false", async () => {
    const ports = sessionPorts();
    const app = createCreditsApp(appFrom(ports));
    const response = await app.fetch(new Request("https://credits.test/catalog"), envStub(), ctx());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      purchasesEnabled: boolean;
      creditsPerUsd: number;
      packs: unknown[];
    };
    expect(body.purchasesEnabled).toBe(false);
    expect(body.creditsPerUsd).toBe(100);
    expect(body.packs).toEqual([]);
  });

  it("banned maps to 403", async () => {
    const ports = sessionPorts();
    await ports.deviceCheck.update(token, { banned: true });
    const app = createCreditsApp(appFrom(ports));
    const response = await app.fetch(
      new Request("https://credits.test/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          athleteId,
          deviceCheckToken: token,
        }),
      }),
      envStub(),
      ctx(),
    );
    expect(response.status).toBe(403);
  });

  it("rate limit maps to 429", async () => {
    const ports = sessionPorts();
    const app = createCreditsApp(appFrom(ports, { ipLimit: deny() }));
    const response = await app.fetch(new Request("https://credits.test/catalog"), envStub(), ctx());
    expect(response.status).toBe(429);
  });
});

import worker from "./index.js";
import { vi } from "vitest";
import type { NotificationId, OriginalTransactionId, ProductId, TransactionId } from "./domain.js";
it("health succeeds without provider configuration or rate limits", async () => {
  const response = await worker.fetch(new Request("https://credits.test/health"), envStub(), ctx());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
it.each([undefined, "wrong"])("operator route rejects token %s before operation", async (token) => {
  const operation = vi.fn();
  const ports = appFrom(sessionPorts());
  ports.operator.setRatio = operation;
  const response = await createCreditsApp(ports).fetch(
    new Request("https://credits.test/ops/pricing", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ ratio: "1.1" }),
    }),
    { ...envStub(), OPERATOR_TOKEN: "synthetic-operator" },
    ctx(),
  );
  expect(response.status).toBe(401);
  expect(operation).not.toHaveBeenCalled();
});
it("operator pricing accepts the approved ratio string", async () => {
  const ports = appFrom(sessionPorts());
  const response = await createCreditsApp(ports).fetch(
    new Request("https://credits.test/ops/pricing", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-operator" },
      body: JSON.stringify({ ratio: "1.1" }),
    }),
    { ...envStub(), OPERATOR_TOKEN: "synthetic-operator" },
    ctx(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ policyVersion: 2 });
});
it("verified pre-claim refund routes through the athlete runtime and replay is harmless", async () => {
  const session = sessionPorts();
  const apple = new FakeAppleStore();
  const notification = {
    type: "refund",
    athleteId,
    notificationId: "synthetic-refund" as NotificationId,
    transactionId: "synthetic-tx" as TransactionId,
    originalTransactionId: "synthetic-original" as OriginalTransactionId,
  } as const;
  apple.notifications.push(notification, notification);
  const app = createCreditsApp(appFrom(session, { apple, ipLimit: deny() }));
  for (const kind of ["refundPendingPurchase", "refundDuplicate"]) {
    const response = await app.fetch(
      new Request("https://credits.test/apple", {
        method: "POST",
        body: JSON.stringify({ signedPayload: "synthetic-jws" }),
      }),
      envStub(),
      ctx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind });
  }
});
it("ignored notification logs only allowed fields and malformed JSON is sanitized", async () => {
  const apple = new FakeAppleStore();
  apple.notifications.push({ type: "ignored", notificationId: "synthetic-test" as NotificationId });
  const info = vi.fn();
  const app = createCreditsApp(appFrom(sessionPorts(), { apple, log: { info, warn() {} } }));
  expect(
    (
      await app.fetch(
        new Request("https://credits.test/apple", {
          method: "POST",
          body: JSON.stringify({ signedPayload: "synthetic-jws" }),
        }),
        envStub(),
        ctx(),
      )
    ).status,
  ).toBe(200);
  expect(info).toHaveBeenCalledWith({ route: "apple", outcome: "ignored" });
  const response = await app.fetch(
    new Request("https://credits.test/grant", { method: "POST", body: "invalid" }),
    envStub(),
    ctx(),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "identity_mismatch" });
});

it.each([
  ["refund", "refund"],
  ["revoke", "revoke"],
  ["consumption_request", "consumptionRequest"],
] as const)("dispatches verified %s as %s", async (type, kind) => {
  const apple = new FakeAppleStore();
  apple.notifications.push({
    type,
    athleteId,
    notificationId: "synthetic-dispatch" as NotificationId,
    transactionId: "synthetic-dispatch-tx" as TransactionId,
    originalTransactionId: "synthetic-original" as OriginalTransactionId,
  });
  const run = vi.fn().mockResolvedValue({ kind: "revoked" });
  const info = vi.fn();
  const app = createCreditsApp(
    appFrom(sessionPorts(), { apple, runtime: { run }, log: { info, warn() {} } }),
  );
  const response = await app.fetch(
    new Request("https://credits.test/apple", {
      method: "POST",
      body: JSON.stringify({ signedPayload: "synthetic" }),
    }),
    envStub(),
    ctx(),
  );
  expect(response.status).toBe(200);
  expect(info).toHaveBeenCalledExactlyOnceWith({ route: "apple", outcome: "revoked" });
  expect(run).toHaveBeenCalledWith(athleteId, {
    kind,
    notificationId: "synthetic-dispatch",
    transactionId: "synthetic-dispatch-tx",
  });
});


it.each(["claim", "recover"] as const)("%s logs only route and outcome", async (route) => {
  const apple = new FakeAppleStore();
  const purchase = {
    athleteId,
    transactionId: "synthetic-private-transaction" as TransactionId,
    originalTransactionId: "synthetic-private-original" as OriginalTransactionId,
    productId: "synthetic-pack" as ProductId,
    bundleId: "icu.enduragent.app",
    environment: "sandbox",
    priceMillis: 4990,
    currency: "USD",
  } as const;
  apple.purchases.set("synthetic-jws", purchase);
  const info = vi.fn();
  const run = vi.fn().mockResolvedValue({ kind: "claimAlreadyClaimed" });
  const app = createCreditsApp(
    appFrom(sessionPorts(), { apple, runtime: { run }, log: { info, warn() {} } }),
  );
  const response = await app.fetch(
    new Request(`https://credits.test/${route}`, {
      method: "POST",
      body: JSON.stringify({ signedTransaction: "synthetic-jws" }),
    }),
    envStub(),
    ctx(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: "claimAlreadyClaimed" });
  expect(run).toHaveBeenCalledExactlyOnceWith(athleteId, { kind: route, purchase });
  expect(info).toHaveBeenCalledExactlyOnceWith({ route, outcome: "claimAlreadyClaimed" });
});
