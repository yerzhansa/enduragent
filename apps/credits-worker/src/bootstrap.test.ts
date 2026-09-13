import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { D1Ledger } from "./ledger.js";
it("migrations seed only the approved initial policy and replay safely", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const ledger = new D1Ledger(env.DB);
  await expect(ledger.currentPolicy()).resolves.toMatchObject({
    version: 1,
    ratio: 1,
    appleCommission: 0.15,
    openrouterFee: 0.055,
    creditsPerUsd: 100,
  });
  await expect(ledger.activePacks(1)).resolves.toEqual([]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await expect(ledger.currentPolicy()).resolves.toMatchObject({ version: 1 });
});

import { asCredits, asUsdMillis, type ProductId } from "./domain.js";
it("failed D1 pack publication rolls back the policy and replay preserves an existing policy", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const ledger = new D1Ledger(env.DB);
  const initial = await ledger.currentPolicy();
  const policy = { ...initial, version: 2, ratio: 1.1, effectiveFrom: "1998-06-13T00:00:00Z" };
  const pack = {
    productId: "synthetic-pack" as ProductId,
    policyVersion: 2,
    listPriceUsdMillis: asUsdMillis(1000),
    capUsdMillis: asUsdMillis(804),
    credits: asCredits(80),
    active: true,
  };
  const revision = await ledger.pricingRevision();
  await expect(ledger.publishPolicy(policy, [pack, pack], revision)).rejects.toThrow();
  expect((await ledger.currentPolicy()).version).toBe(1);
  expect(await ledger.activePacks(2)).toEqual([]);
  expect(await ledger.pricingRevision()).toBe(revision);
  await ledger.publishPolicy(policy, [pack], revision);
  expect(await ledger.pricingRevision()).toBe(revision + 1);
  const migration = env.TEST_MIGRATIONS.find((row) => row.name.includes("0002"));
  expect(migration).toBeDefined();
  for (const query of migration?.queries ?? []) await env.DB.prepare(query).run();
  expect(await ledger.currentPolicy()).toEqual(policy);
});
