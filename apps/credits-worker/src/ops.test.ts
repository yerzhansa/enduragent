import { expect, it, vi } from "vitest";
import { createOperator } from "./ops.js";
import {
  FakeAppleStore,
  FakeDeviceCheck,
  FakeOpenRouterKeys,
  MemoryLedger,
  seedLaunchPolicy,
} from "./fakes.js";
import { asUsdMillis, type ProductId } from "./domain.js";
function setup() {
  const ledger = new MemoryLedger();
  seedLaunchPolicy(ledger);
  const keys = new FakeOpenRouterKeys();
  const runtime = { run: vi.fn() };
  return {
    ledger,
    keys,
    runtime,
    operator: createOperator({
      ledger,
      keys,
      runtime,
      apple: new FakeAppleStore(),
      deviceCheck: new FakeDeviceCheck(),
    }),
  };
}
it("setRatio copies packs into vN+1 without changing the old cap", async () => {
  const { ledger, operator } = setup();
  const productId = "synthetic-pack" as ProductId;
  await operator.addPack({ productId, listPriceUsdMillis: asUsdMillis(4990) });
  const before = await ledger.pack(productId, 1);
  await expect(operator.setRatio({ ratio: 1.1 })).resolves.toEqual({ policyVersion: 2 });
  expect(await ledger.pack(productId, 1)).toEqual(before);
  expect((await ledger.pack(productId, 2))?.capUsdMillis).toBe(4409);
});
it("spendAll marks orphaned remote key", async () => {
  const { operator, keys } = setup();
  const created = await keys.create({
    name: "synthetic",
    limitUsdMillis: asUsdMillis(2000),
    guardrailMode: "off",
    guardrailId: undefined,
  });
  await expect(operator.spendAll()).resolves.toEqual([
    expect.objectContaining({
      keyHash: created.hash,
      orphanedRemoteKey: true,
      athleteId: undefined,
      remainingUsdMillis: 2000,
      creditsRemaining: 200,
    }),
  ]);
});

import {
  asCredits,
  type AthleteId,
  type GrantId,
  type OriginalTransactionId,
  type TransactionId,
} from "./domain.js";
it("ratio changes preserve sold caps and spend totals include grants, purchases and refunds", async () => {
  const { ledger, keys, operator } = setup();
  const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;
  const key = await keys.create({
    name: "synthetic",
    limitUsdMillis: asUsdMillis(3009),
    guardrailMode: "off",
    guardrailId: undefined,
  });
  await ledger.insertAthlete({
    athleteId,
    keyHash: key.hash,
    keyGeneration: 1,
    disabled: false,
    refundsAfterUse: 0,
    createdAt: "1998-06-13T00:00:00Z",
  });
  await ledger.insertGrant({
    grantId: "synthetic-grant" as GrantId,
    athleteId,
    capUsdMillis: asUsdMillis(2000),
    credits: asCredits(200),
    grantedAt: "1998-06-13T00:00:00Z",
  });
  const sold = {
    transactionId: "synthetic-sold" as TransactionId,
    originalTransactionId: "synthetic-original" as OriginalTransactionId,
    athleteId,
    productId: "synthetic-pack" as ProductId,
    environment: "sandbox",
    capUsdMillis: asUsdMillis(1000),
    credits: asCredits(100),
    policyVersion: 1,
    claimedAt: "1998-06-13T00:00:00Z",
    refundedAt: "1998-06-14T00:00:00Z",
  } as const;
  await ledger.insertPurchase(sold);
  await operator.setRatio({ ratio: 1.1 });
  expect(await ledger.purchase(sold.transactionId)).toEqual(sold);
  expect(await operator.spend(athleteId)).toMatchObject({
    grantedUsdMillis: 3000,
    refundedUsdMillis: 1000,
    remainingUsdMillis: 3009,
    creditsRemaining: 300,
  });
});
it("ban by original resolves and forwards the operator command", async () => {
  const { ledger, keys, operator, runtime } = setup();
  const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;
  const key = await keys.create({
    name: "synthetic",
    limitUsdMillis: asUsdMillis(2000),
    guardrailMode: "off",
    guardrailId: undefined,
  });
  await ledger.insertAthlete({
    athleteId,
    keyHash: key.hash,
    keyGeneration: 1,
    disabled: false,
    refundsAfterUse: 0,
    createdAt: "1998-06-13T00:00:00Z",
  });
  await ledger.linkOriginalTransaction({
    athleteId,
    originalTransactionId: "synthetic-original" as OriginalTransactionId,
  });
  await operator.ban({ originalTransactionId: "synthetic-original" });
  expect(runtime.run).toHaveBeenCalledWith(athleteId, { kind: "ban", reason: "operator" });
});
