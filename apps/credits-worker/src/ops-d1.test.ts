import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { asUsdMillis, capForListPrice, type ProductId } from "./domain.js";
import { FakeAppleStore, FakeDeviceCheck, FakeOpenRouterKeys } from "./fakes.js";
import { D1Ledger, PricingConflict } from "./ledger.js";
import { createOperator } from "./ops.js";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.exec("DELETE FROM packs; DELETE FROM pricing_policies WHERE version > 1;");
});

function client() {
  const ledger = new D1Ledger(env.DB);
  return {
    ledger,
    operator: createOperator({
      ledger,
      keys: new FakeOpenRouterKeys(),
      apple: new FakeAppleStore(),
      deviceCheck: new FakeDeviceCheck(),
      runtime: { run: vi.fn() },
    }),
  };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pack = {
  productId: "synthetic-concurrent-pack" as ProductId,
  listPriceUsdMillis: asUsdMillis(4990),
};

it("publishes a concurrently added pack when the ratio snapshot is stale", async () => {
  const first = client();
  const second = client();
  const read = first.ledger.activePacks.bind(first.ledger);
  const captured = deferred();
  const resume = deferred();
  vi.spyOn(first.ledger, "activePacks").mockImplementationOnce(async (version) => {
    const packs = await read(version);
    captured.resolve();
    await resume.promise;
    return packs;
  });
  const publishing = first.operator.setRatio({ ratio: 1.1 });
  await captured.promise;
  try {
    await second.operator.addPack(pack);
  } finally {
    resume.resolve();
  }
  await expect(publishing).resolves.toEqual({ policyVersion: 2 });
  expect(await second.ledger.pack(pack.productId, 2)).toMatchObject({
    capUsdMillis: 4409,
    credits: 441,
  });
  expect(await second.ledger.pack(pack.productId, 1)).toMatchObject({ capUsdMillis: 4008 });
});

it("adds a pack to the current policy when its initial policy read is stale", async () => {
  const first = client();
  const second = client();
  const read = first.ledger.currentPolicy.bind(first.ledger);
  const captured = deferred();
  const resume = deferred();
  vi.spyOn(first.ledger, "currentPolicy").mockImplementationOnce(async () => {
    const policy = await read();
    captured.resolve();
    await resume.promise;
    return policy;
  });
  const adding = first.operator.addPack(pack);
  await captured.promise;
  try {
    await second.operator.setRatio({ ratio: 1.1 });
  } finally {
    resume.resolve();
  }
  await adding;
  expect(await second.ledger.pack(pack.productId, 2)).toMatchObject({ capUsdMillis: 4409 });
  expect(await second.ledger.pack(pack.productId, 1)).toBeUndefined();
});

it("serializes concurrent ratio publications without rewriting historical packs", async () => {
  const first = client();
  const second = client();
  await second.operator.addPack(pack);
  const original = await second.ledger.pack(pack.productId, 1);
  const read = first.ledger.activePacks.bind(first.ledger);
  const captured = deferred();
  const resume = deferred();
  vi.spyOn(first.ledger, "activePacks").mockImplementationOnce(async (version) => {
    const packs = await read(version);
    captured.resolve();
    await resume.promise;
    return packs;
  });
  const publishing = first.operator.setRatio({ ratio: 1.2 });
  await captured.promise;
  try {
    await expect(second.operator.setRatio({ ratio: 1.1 })).resolves.toEqual({ policyVersion: 2 });
  } finally {
    resume.resolve();
  }
  await expect(publishing).resolves.toEqual({ policyVersion: 3 });
  const current = await second.ledger.currentPolicy();
  expect(current.ratio).toBe(1.2);
  expect(await second.ledger.pack(pack.productId, 3)).toMatchObject(
    capForListPrice(pack.listPriceUsdMillis, current),
  );
  expect(await second.ledger.pack(pack.productId, 1)).toEqual(original);
  expect(await second.ledger.pack(pack.productId, 2)).toMatchObject({ capUsdMillis: 4409 });
});

it("rejects a stale pack write without changing the revision or stored pack", async () => {
  const first = client();
  const second = client();
  const revision = await first.ledger.pricingRevision();
  const initial = await first.ledger.currentPolicy();
  await second.operator.setRatio({ ratio: 1.1 });
  await expect(
    first.ledger.putPack(
      {
        ...pack,
        policyVersion: initial.version,
        ...capForListPrice(pack.listPriceUsdMillis, initial),
        active: true,
      },
      revision,
    ),
  ).rejects.toBeInstanceOf(PricingConflict);
  expect(await second.ledger.pricingRevision()).toBe(revision + 1);
  expect(await second.ledger.pack(pack.productId, initial.version)).toBeUndefined();
});

it("returns unavailable after bounded conflicts without publishing a partial policy", async () => {
  const first = client();
  const second = client();
  const read = first.ledger.activePacks.bind(first.ledger);
  let competingWrites = 0;
  vi.spyOn(first.ledger, "activePacks").mockImplementation(async (version) => {
    const packs = await read(version);
    await second.operator.addPack(pack);
    competingWrites++;
    return packs;
  });
  await expect(first.operator.setRatio({ ratio: 1.1 })).rejects.toThrow("unavailable");
  expect(competingWrites).toBe(3);
  expect((await second.ledger.currentPolicy()).version).toBe(1);
  expect(await second.ledger.activePacks(2)).toEqual([]);
  expect(await second.ledger.pack(pack.productId, 1)).toMatchObject({ capUsdMillis: 4008 });
});
