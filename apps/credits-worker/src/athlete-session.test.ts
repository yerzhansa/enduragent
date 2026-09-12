import { describe, expect, it } from "vitest";
import type { SessionPorts } from "./athlete-session.js";
import {
  asCredits,
  asUsdMillis,
  capForListPrice,
  type AthleteId,
  type DeviceCheckToken,
  type GrantId,
  type IdFactory,
  type LotId,
  type NotificationId,
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
  testRuntime as runtimeFromFakes,
} from "./fakes.js";

const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;
const starterCap = asUsdMillis(2000);
const starterCredits = asCredits(200);
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

function makePorts(): SessionPorts & { keys: FakeOpenRouterKeys; deviceCheck: FakeDeviceCheck } {
  const ledger = new MemoryLedger();
  seedLaunchPolicy(ledger);
  const policy = launchPolicy();
  void ledger.putPack(packForPolicy(policy));
  const keys = new FakeOpenRouterKeys();
  const deviceCheck = new FakeDeviceCheck();
  const apple = new FakeAppleStore();
  const ports: SessionPorts & { keys: FakeOpenRouterKeys; deviceCheck: FakeDeviceCheck } = {
    ledger,
    keys,
    deviceCheck,
    apple,
    openRouter: { guardrailMode: "off", guardrailId: undefined, keyCountCeiling: undefined },
    clock: testClock,
    ids: sequentialIds(),
    purchasesEnabled: false,
    consumptionReporting: "unverified",
    bundleId: "icu.enduragent.app",
    environment: "sandbox",
    repeatRefundBanThreshold: 2,
  };
  return ports;
}

function grant(token: DeviceCheckToken) {
  return {
    kind: "grant" as const,
    deviceCheckToken: token,
    starterCapUsdMillis: starterCap,
    starterCredits,
  };
}

describe("athlete session", () => {
  it("grant twice on one device is minted then alreadyGranted", async () => {
    const ports = makePorts();
    const runtime = runtimeFromFakes(ports);
    const token = "dc-1998-1" as DeviceCheckToken;
    const first = await runtime.run(athleteId, grant(token));
    expect(first.kind).toBe("grantMinted");
    if (first.kind === "grantMinted") {
      expect(first.credits).toEqual(starterCredits);
      expect(String(first.key).startsWith("fake-or-key-")).toBe(true);
    }
    const bits = await ports.deviceCheck.query(token);
    expect(bits.grantClaimed).toBe(true);
    const second = await runtime.run(athleteId, grant(token));
    expect(second).toEqual({ kind: "grantAlreadyGranted" });
    expect(ports.keys.createdCount).toBe(1);
  });

  it("grant on second device tops up the same hash", async () => {
    const ports = makePorts();
    const runtime = runtimeFromFakes(ports);
    const first = await runtime.run(athleteId, grant("dc-1998-1" as DeviceCheckToken));
    const second = await runtime.run(athleteId, grant("dc-1998-2" as DeviceCheckToken));
    expect(first.kind).toBe("grantMinted");
    expect(second).toEqual({ kind: "grantToppedUp", added: starterCredits });
    const athlete = await ports.ledger.athlete(athleteId);
    if (!athlete) throw new Error("missing athlete");
    const view = await ports.keys.get(athlete.keyHash);
    expect(view.limitUsdMillis).toEqual(asUsdMillis(4000));
    expect(ports.keys.createdCount).toBe(1);
    expect(ports.keys.setLimitCount).toBe(1);
  });

  it("claim twice on one transactionId is minted then alreadyClaimed with no key", async () => {
    const ports = makePorts();
    const runtime = runtimeFromFakes(ports);
    const tx = "tx-1998-1" as TransactionId;
    const first = await runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) });
    expect(first.kind).toBe("claimMinted");
    if (first.kind === "claimMinted") {
      expect("key" in first).toBe(true);
    }
    const second = await runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) });
    expect(second).toEqual({ kind: "claimAlreadyClaimed" });
    expect("key" in second).toBe(false);
  });

  it("refund arriving before claim is applied when the claim lands", async () => {
    const ports = makePorts();
    const runtime = runtimeFromFakes(ports);
    await runtime.run(athleteId, grant("dc-1998-1" as DeviceCheckToken));
    const tx = "tx-1998-1" as TransactionId;
    const refund = await runtime.run(athleteId, {
      kind: "refund",
      notificationId: "note-1998-1" as NotificationId,
      transactionId: tx,
    });
    expect(refund).toEqual({ kind: "refundPendingPurchase" });
    const claimed = await runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) });
    expect(claimed.kind).toBe("claimToppedUp");
    const athlete = await ports.ledger.athlete(athleteId);
    if (!athlete) throw new Error("missing athlete");
    const view = await ports.keys.get(athlete.keyHash);
    expect(view.limitUsdMillis).toEqual(starterCap);
  });

  it("refund during claim leaves limit equal to purchases minus refunds", async () => {
    const ports = makePorts();
    const runtime = runtimeFromFakes(ports);
    await runtime.run(athleteId, grant("dc-1998-1" as DeviceCheckToken));
    const tx = "tx-1998-1" as TransactionId;
    const claimP = runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) });
    const refundP = runtime.run(athleteId, {
      kind: "refund",
      notificationId: "note-1998-1" as NotificationId,
      transactionId: tx,
    });
    await Promise.all([claimP, refundP]);
    const athlete = await ports.ledger.athlete(athleteId);
    if (!athlete) throw new Error("missing athlete");
    const view = await ports.keys.get(athlete.keyHash);
    expect(view.limitUsdMillis).toEqual(starterCap);
  });

  it("provider mutation crash mid-flight is finished on next entry and the cap is applied once", async () => {
    const ports = makePorts();
    const original = ports.keys.setLimit.bind(ports.keys);
    let crash = true;
    ports.keys.setLimit = async (hash, limit) => {
      await original(hash, limit);
      if (crash) {
        crash = false;
        throw new Error("mid-flight");
      }
    };
    const runtime = runtimeFromFakes(ports);
    await runtime.run(athleteId, grant("dc-1998-1" as DeviceCheckToken));
    const tx = "tx-1998-1" as TransactionId;
    await expect(
      runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) }),
    ).rejects.toThrow("mid-flight");
    await runtime.run(athleteId, grant("dc-1998-1" as DeviceCheckToken));
    const athlete = await ports.ledger.athlete(athleteId);
    if (!athlete) throw new Error("missing athlete");
    const view = await ports.keys.get(athlete.keyHash);
    const packCap = packForPolicy(launchPolicy()).capUsdMillis;
    expect(view.limitUsdMillis).toEqual(asUsdMillis((starterCap as number) + (packCap as number)));
  });

  it("recover during claim never PATCHes a deleted hash", async () => {
    const ports = makePorts();
    const runtime = runtimeFromFakes(ports);
    await runtime.run(athleteId, grant("dc-1998-1" as DeviceCheckToken));
    const firstTx = "tx-1998-1" as TransactionId;
    const secondTx = "tx-1998-2" as TransactionId;
    await runtime.run(athleteId, { kind: "claim", purchase: purchase(firstTx) });
    const athleteBefore = await ports.ledger.athlete(athleteId);
    if (!athleteBefore) throw new Error("missing athlete");
    const oldHash = athleteBefore.keyHash;
    const claimP = runtime.run(athleteId, { kind: "claim", purchase: purchase(secondTx) });
    const recoverP = runtime.run(athleteId, { kind: "recover", purchase: purchase(firstTx) });
    await Promise.all([claimP, recoverP]);
    expect(ports.keys.keys.has(oldHash)).toBe(false);
    const athlete = await ports.ledger.athlete(athleteId);
    if (!athlete) throw new Error("missing athlete");
    await expect(ports.keys.get(athlete.keyHash)).resolves.toMatchObject({ disabled: false });
  });

  it("second refund after use bans at threshold", async () => {
    const ports = makePorts();
    const runtime = runtimeFromFakes(ports);
    await runtime.run(athleteId, grant("dc-1998-1" as DeviceCheckToken));
    const txA = "tx-1998-1" as TransactionId;
    const txB = "tx-1998-2" as TransactionId;
    await runtime.run(athleteId, { kind: "claim", purchase: purchase(txA) });
    await runtime.run(athleteId, { kind: "claim", purchase: purchase(txB) });
    const athlete = await ports.ledger.athlete(athleteId);
    if (!athlete) throw new Error("missing athlete");
    const row = ports.keys.keys.get(athlete.keyHash);
    if (!row) throw new Error("missing key");
    const spent = 7000;
    const remaining = Math.max(0, (row.view.limitUsdMillis as number) - spent);
    row.view = {
      ...row.view,
      remainingUsdMillis: asUsdMillis(remaining),
      usageUsdMillis: asUsdMillis(spent),
    };
    await runtime.run(athleteId, {
      kind: "refund",
      notificationId: "note-1998-b" as NotificationId,
      transactionId: txB,
    });
    expect(await ports.ledger.ban(athleteId)).toBeUndefined();
    await runtime.run(athleteId, {
      kind: "refund",
      notificationId: "note-1998-a" as NotificationId,
      transactionId: txA,
    });
    const banned = await ports.ledger.ban(athleteId);
    expect(banned?.reason).toBe("repeat_refund_after_use");
    const updated = await ports.ledger.athlete(athleteId);
    expect(updated?.disabled).toBe(true);
  });
});
