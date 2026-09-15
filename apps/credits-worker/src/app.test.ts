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

import { OpenRouterManagementClient } from "./openrouter.js";
import { asCredits, asUsdMillis, type GrantId, type KeyHash } from "./domain.js";

async function inventoryApp() {
  const ports = sessionPorts();
  ports.keys = new OpenRouterManagementClient("synthetic-management", {
    guardrailMode: "off",
    guardrailId: undefined,
    keyCountCeiling: undefined,
  });
  const missingId = "19980613-0000-4000-8000-000000000002" as AthleteId;
  for (const [id, hash] of [
    [athleteId, "synthetic-present"],
    [missingId, "synthetic-missing"],
  ] as const) {
    await ports.ledger.insertAthlete({
      athleteId: id,
      keyHash: hash as KeyHash,
      keyGeneration: 1,
      disabled: false,
      refundsAfterUse: 0,
      createdAt: "1998-06-13T00:00:00Z",
    });
  }
  await ports.ledger.insertGrant({
    grantId: "synthetic-grant" as GrantId,
    athleteId: missingId,
    capUsdMillis: asUsdMillis(2000),
    credits: asCredits(200),
    grantedAt: "1998-06-13T00:00:00Z",
  });
  await ports.ledger.insertPurchase({
    transactionId: "synthetic-purchase" as TransactionId,
    originalTransactionId: "synthetic-original" as OriginalTransactionId,
    athleteId: missingId,
    productId: "synthetic-pack" as ProductId,
    environment: "sandbox",
    capUsdMillis: asUsdMillis(1000),
    credits: asCredits(100),
    policyVersion: 1,
    claimedAt: "1998-06-13T00:00:00Z",
    refundedAt: "1998-06-14T00:00:00Z",
  });
  return { app: createCreditsApp(appFrom(ports)), missingId };
}

const inventoryPage = [
  { hash: "synthetic-present", disabled: false, limit: 2, limit_remaining: 1.5, usage: 0.5 },
  { hash: "synthetic-orphan", disabled: true, limit: 4, limit_remaining: 3.5, usage: 0.5 },
];

it("bulk spend reports missing provider values without losing normal or orphan rows", async () => {
  const { app, missingId } = await inventoryApp();
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("offset=0")) return Response.json({ data: inventoryPage });
    if (url.endsWith("offset=2")) return Response.json({ data: [] });
    return new Response(null, { status: 404 });
  });
  try {
    const response = await app.fetch(
      new Request("https://credits.test/ops/spend", {
        headers: { authorization: "Bearer synthetic-operator" },
      }),
      { ...envStub(), OPERATOR_TOKEN: "synthetic-operator" },
      ctx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        athleteId,
        keyHash: "synthetic-present",
        orphanedRemoteKey: false,
        missingRemoteKey: false,
        grantedUsdMillis: 0,
        refundedUsdMillis: 0,
        remainingUsdMillis: 1500,
        usageUsdMillis: 500,
        creditsRemaining: 150,
        disabled: false,
      },
      {
        keyHash: "synthetic-orphan",
        orphanedRemoteKey: true,
        missingRemoteKey: false,
        grantedUsdMillis: 0,
        refundedUsdMillis: 0,
        remainingUsdMillis: 3500,
        usageUsdMillis: 500,
        creditsRemaining: 350,
        disabled: true,
      },
      {
        athleteId: missingId,
        keyHash: "synthetic-missing",
        orphanedRemoteKey: false,
        missingRemoteKey: true,
        grantedUsdMillis: 3000,
        refundedUsdMillis: 1000,
        remainingUsdMillis: null,
        usageUsdMillis: null,
        creditsRemaining: null,
        disabled: null,
      },
    ]);
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/keys?include_disabled=true&offset=0",
      "https://openrouter.ai/api/v1/keys?include_disabled=true&offset=2",
    ]);
  } finally {
    transport.mockRestore();
  }
});

it.each(["unauthorized", "timeout", "malformed", "repeated"])(
  "bulk spend fails closed when inventory is %s",
  async (failure) => {
    const { app } = await inventoryApp();
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("offset=0")) return Response.json({ data: inventoryPage });
      if (failure === "timeout") throw new Error("synthetic timeout");
      if (failure === "unauthorized") return new Response(null, { status: 401 });
      return Response.json({ data: failure === "malformed" ? null : inventoryPage });
    });
    try {
      const response = await app.fetch(
        new Request("https://credits.test/ops/spend", {
          headers: { authorization: "Bearer synthetic-operator" },
        }),
        { ...envStub(), OPERATOR_TOKEN: "synthetic-operator" },
        ctx(),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable" });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      transport.mockRestore();
    }
  },
);

it("single-athlete spend still fails when its remote key cannot be fetched", async () => {
  const { app, missingId } = await inventoryApp();
  const transport = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 404 }));
  try {
    const response = await app.fetch(
      new Request(`https://credits.test/ops/spend?athleteId=${missingId}`, {
        headers: { authorization: "Bearer synthetic-operator" },
      }),
      { ...envStub(), OPERATOR_TOKEN: "synthetic-operator" },
      ctx(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/keys/synthetic-missing",
    ]);
  } finally {
    transport.mockRestore();
  }
});
