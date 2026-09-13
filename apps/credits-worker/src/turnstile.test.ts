import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { bindDurableRuntime } from "./app.js";
import { AthleteSession, type SessionPorts } from "./athlete-session.js";
import {
  asUsdMillis,
  capForListPrice,
  type AthleteId,
  type GrantId,
  type IdFactory,
  type LotId,
  type OriginalTransactionId,
  type Pack,
  type PricingPolicy,
  type ProductId,
  type ProviderMutationId,
  type TransactionId,
  type VerifiedPurchase,
} from "./domain.js";
import {
  FakeAppleStore,
  FakeDeviceCheck,
  FakeOpenRouterKeys,
  MemoryLedger,
  seedLaunchPolicy,
  testClock,
} from "./fakes.js";

const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;
const productId = "credits_4_99" as ProductId;
const originalTx = "orig-1998-1" as OriginalTransactionId;

function sequentialIds(): IdFactory {
  let n = 1;
  return {
    lotId: () => `lot_1998_${n++}` as LotId,
    grantId: () => `grant_1998_${n++}` as GrantId,
    mutationId: () => `mut_1998_${n++}` as ProviderMutationId,
  };
}

function launchPolicy(): PricingPolicy {
  return {
    version: 1,
    ratio: 1,
    appleCommission: 0.15,
    openrouterFee: 0.055,
    creditsPerUsd: 100,
    effectiveFrom: "1998-06-13T00:00:00Z",
  };
}

function packForPolicy(policy: PricingPolicy): Pack {
  const priced = capForListPrice(asUsdMillis(4990), policy);
  return {
    productId,
    policyVersion: policy.version,
    listPriceUsdMillis: asUsdMillis(4990),
    capUsdMillis: priced.capUsdMillis,
    credits: priced.credits,
    active: true,
  };
}

function purchase(transactionId: TransactionId): VerifiedPurchase {
  return {
    transactionId,
    originalTransactionId: originalTx,
    productId,
    bundleId: "icu.enduragent.app",
    environment: "sandbox",
    athleteId,
    priceMillis: 4990,
    currency: "USD",
  };
}

function makePorts(): SessionPorts {
  const ledger = new MemoryLedger();
  seedLaunchPolicy(ledger);
  ledger.packs.push(packForPolicy(launchPolicy()));
  return {
    ledger,
    keys: new FakeOpenRouterKeys(),
    deviceCheck: new FakeDeviceCheck(),
    apple: new FakeAppleStore(),
    openRouter: { guardrailMode: "off", guardrailId: undefined, keyCountCeiling: undefined },
    clock: testClock,
    ids: sequentialIds(),
    purchasesEnabled: false,
    consumptionReporting: "unverified",
    bundleId: "icu.enduragent.app",
    environment: "sandbox",
    repeatRefundBanThreshold: 2,
  };
}

describe("turnstile", () => {
  it("two claims through the stub for one athlete serialize", async () => {
    const id = env.ATHLETE_SESSION.idFromName(athleteId);
    const stub = env.ATHLETE_SESSION.get(id);
    await runInDurableObject(stub, (instance) => {
      (instance as AthleteSession).ports = makePorts();
    });
    const runtime = bindDurableRuntime(env);
    const first = runtime.run(athleteId, {
      kind: "claim",
      purchase: purchase("tx-1998-1" as TransactionId),
    });
    const second = runtime.run(athleteId, {
      kind: "claim",
      purchase: purchase("tx-1998-2" as TransactionId),
    });
    await Promise.all([first, second]);
    const counts = await runInDurableObject(stub, (instance) => {
      const keys = (instance as AthleteSession).ports?.keys as FakeOpenRouterKeys;
      return { created: keys.createdCount, setLimit: keys.setLimitCount };
    });
    expect(counts.created).toBe(1);
    expect(counts.setLimit).toBe(1);
  });
});

import { applyD1Migrations } from "cloudflare:test";
import { createCreditsApp } from "./app.js";
import { productionPorts } from "./index.js";
import { D1Ledger } from "./ledger.js";

it("production catalog reads migrated D1 and production construction rejects invalid ceilings", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const configured = {
    ...env,
    DB: env.DB,
    ATHLETE_SESSION: env.ATHLETE_SESSION,
    RATE_LIMIT_IP: env.RATE_LIMIT_IP,
    RATE_LIMIT_TOKEN: env.RATE_LIMIT_TOKEN,
  };
  const ports = productionPorts(configured);
  const response = await createCreditsApp(ports).fetch(
    new Request("https://credits.test/catalog"),
    configured,
    { waitUntil() {} },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ purchasesEnabled: false, creditsPerUsd: 100, packs: [] });
  const transport = vi.spyOn(globalThis, "fetch");
  try {
    for (const ceiling of ["1", "100", "0", "", "NaN"])
      expect(() => productionPorts({ ...configured, KEY_COUNT_CEILING: ceiling })).toThrow(
        "unavailable",
      );
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
  const session = new AthleteSession(
    { id: { toString: () => "synthetic" } },
    { ...configured, KEY_COUNT_CEILING: "1" },
  );
  await expect(
    session.fetch(
      new Request(`https://athlete.session/${athleteId}`, {
        method: "POST",
        body: JSON.stringify({ kind: "ban", reason: "operator" }),
      }),
    ),
  ).rejects.toThrow("unavailable");
});

it("verified refund HTTP dispatch reaches the production Durable Object and D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const apple = new FakeAppleStore();
  apple.notifications.push({
    type: "refund",
    notificationId: "synthetic-prod-refund" as import("./domain.js").NotificationId,
    transactionId: "synthetic-prod-tx" as TransactionId,
    originalTransactionId: originalTx,
    athleteId,
  });
  await runInDurableObject(
    env.ATHLETE_SESSION.get(env.ATHLETE_SESSION.idFromName(athleteId)),
    (instance) => {
      if (!(instance instanceof AthleteSession)) throw new Error("unexpected session");
      instance.ports = undefined;
    },
  );
  const configured = productionPorts(env);
  const app = createCreditsApp({ ...configured, apple });
  const response = await app.fetch(
    new Request("https://credits.test/apple", {
      method: "POST",
      body: JSON.stringify({ signedPayload: "synthetic" }),
    }),
    env,
    { waitUntil() {} },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: "refundPendingPurchase" });
  const ledger = new D1Ledger(env.DB);
  expect(await ledger.takePendingRefund("synthetic-prod-tx" as TransactionId)).toBe(
    "synthetic-prod-refund",
  );
});
