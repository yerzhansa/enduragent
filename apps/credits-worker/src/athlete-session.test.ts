import { describe, expect, it, vi } from "vitest";
import type { SessionPorts } from "./athlete-session.js";
import {
  asCredits,
  asUsdMillis,
  capForListPrice,
  type AthleteId,
  type DeviceCheckToken,
  type DeviceGrantOwnerId,
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
    deviceGrantOwnerId: () => `device_owner_1998_${n++}` as DeviceGrantOwnerId,
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
  ledger.packs.push(packForPolicy(policy));
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
    await expect(runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) })).rejects.toThrow(
      "mid-flight",
    );
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

it.each([false, true])(
  "banned grant repairs the ban bit while preserving claimed=%s",
  async (grantClaimed) => {
    const ports = makePorts();
    const token = "synthetic-token" as DeviceCheckToken;
    await ports.deviceCheck.update(token, { grantClaimed });
    await ports.ledger.insertBan({
      athleteId,
      reason: "operator",
      bannedAt: "1998-06-13T00:00:00Z",
    });
    await expect(runtimeFromFakes(ports).run(athleteId, grant(token))).rejects.toThrow("banned");
    await expect(ports.deviceCheck.query(token)).resolves.toEqual({ grantClaimed, banned: true });
    expect(await ports.keys.count()).toBe(0);
  },
);

it("failed lazy ban update never mints a key", async () => {
  const ports = makePorts();
  await ports.ledger.insertBan({ athleteId, reason: "operator", bannedAt: "1998-06-13T00:00:00Z" });
  ports.deviceCheck.update = async () => {
    throw new Error("synthetic update failure");
  };
  await expect(
    runtimeFromFakes(ports).run(athleteId, grant("synthetic-token" as DeviceCheckToken)),
  ).rejects.toThrow();
  expect(await ports.keys.count()).toBe(0);
});

it("marks DeviceCheck before creating a grant key", async () => {
  const ports = makePorts();
  const order: string[] = [];
  const update = ports.deviceCheck.update.bind(ports.deviceCheck);
  ports.deviceCheck.update = async (token, bits) => {
    order.push("mark");
    await update(token, bits);
  };
  const create = ports.keys.create.bind(ports.keys);
  ports.keys.create = async (input) => {
    order.push("fund");
    return create(input);
  };

  await runtimeFromFakes(ports).run(
    athleteId,
    grant("dc-1998-mark-before-fund" as DeviceCheckToken),
  );

  expect(order).toEqual(["mark", "fund"]);
});

it("a failed DeviceCheck mark never funds or compensates the grant", async () => {
  const ports = makePorts();
  ports.deviceCheck.update = async () => {
    throw new Error("synthetic mark failure");
  };

  await expect(
    runtimeFromFakes(ports).run(athleteId, grant("dc-1998-mark-failure" as DeviceCheckToken)),
  ).rejects.toThrow("synthetic mark failure");
  expect(ports.keys.createdCount).toBe(0);
  expect(await ports.ledger.grantsFor(athleteId)).toHaveLength(0);
});

it("a lost DeviceCheck mark response leaves the claimed trial unfunded", async () => {
  const ports = makePorts();
  const token = "dc-1998-lost-mark-response" as DeviceCheckToken;
  const update = ports.deviceCheck.update.bind(ports.deviceCheck);
  let loseResponse = true;
  ports.deviceCheck.update = async (value, bits) => {
    await update(value, bits);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("synthetic lost mark response");
    }
  };
  const runtime = runtimeFromFakes(ports);

  await expect(runtime.run(athleteId, grant(token))).rejects.toThrow(
    "synthetic lost mark response",
  );
  await expect(runtime.run(athleteId, grant(token))).resolves.toEqual({
    kind: "grantAlreadyGranted",
  });
  expect(ports.keys.createdCount).toBe(0);
  expect(await ports.ledger.grantsFor(athleteId)).toHaveLength(0);
});

it("an ambiguous grant key creation is fenced without replay", async () => {
  const ports = makePorts();
  const create = ports.keys.create.bind(ports.keys);
  let loseResponse = true;
  ports.keys.create = async (input) => {
    const created = await create(input);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("synthetic lost create response");
    }
    return created;
  };
  const runtime = runtimeFromFakes(ports);

  await expect(
    runtime.run(athleteId, grant("dc-1998-create-uncertain" as DeviceCheckToken)),
  ).rejects.toThrow("synthetic lost create response");
  await expect(
    runtime.run(athleteId, grant("dc-1998-after-create-uncertain" as DeviceCheckToken)),
  ).rejects.toThrow("unavailable");
  expect(ports.keys.createdCount).toBe(1);
});

it("an ambiguous grant top-up is fenced without replay", async () => {
  const ports = makePorts();
  const runtime = runtimeFromFakes(ports);
  await runtime.run(athleteId, grant("dc-1998-first-device" as DeviceCheckToken));
  const setLimit = ports.keys.setLimit.bind(ports.keys);
  let loseResponse = true;
  ports.keys.setLimit = async (hash, limit) => {
    await setLimit(hash, limit);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("synthetic lost limit response");
    }
  };

  await expect(
    runtime.run(athleteId, grant("dc-1998-second-device" as DeviceCheckToken)),
  ).rejects.toThrow("synthetic lost limit response");
  await expect(
    runtime.run(athleteId, grant("dc-1998-third-device" as DeviceCheckToken)),
  ).rejects.toThrow("unavailable");
  expect(ports.keys.setLimitCount).toBe(1);
});

it("unavailable consumption preserves retry and records no reported notification", async () => {
  const ports = makePorts();
  ports.consumptionReporting = "enabled";
  const runtime = runtimeFromFakes(ports);
  const tx = "synthetic-consumption" as TransactionId;
  await runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) });
  const send = vi
    .spyOn(ports.apple, "reportConsumption")
    .mockRejectedValue(new Error("unavailable"));
  const command = {
    kind: "consumptionRequest" as const,
    notificationId: "synthetic-retry" as NotificationId,
    transactionId: tx,
  };
  await expect(runtime.run(athleteId, command)).rejects.toThrow("unavailable");
  await expect(runtime.run(athleteId, command)).rejects.toThrow("unavailable");
  expect(send).toHaveBeenCalledTimes(2);
  expect((ports.ledger as MemoryLedger).notifications.has(command.notificationId)).toBe(false);
});

it("successful consumption is sent once and recorded after completion", async () => {
  const ports = makePorts();
  ports.consumptionReporting = "enabled";
  const runtime = runtimeFromFakes(ports);
  const tx = "synthetic-success" as TransactionId;
  await runtime.run(athleteId, { kind: "claim", purchase: purchase(tx) });
  const command = {
    kind: "consumptionRequest" as const,
    notificationId: "synthetic-success" as NotificationId,
    transactionId: tx,
  };
  const send = vi.spyOn(ports.apple, "reportConsumption").mockImplementation(async () => {
    expect((ports.ledger as MemoryLedger).notifications.has(command.notificationId)).toBe(false);
  });
  await expect(runtime.run(athleteId, command)).resolves.toEqual({
    kind: "consumptionReported",
    status: "not_consumed",
  });
  await runtime.run(athleteId, command);
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(["unverified", "disabled"] as const)(
  "%s consumption records no send",
  async (reporting) => {
    const ports = makePorts();
    ports.consumptionReporting = reporting;
    const send = vi.spyOn(ports.apple, "reportConsumption");
    const command = {
      kind: "consumptionRequest" as const,
      notificationId: "synthetic-no-send" as NotificationId,
      transactionId: "synthetic-tx" as TransactionId,
    };
    await expect(runtimeFromFakes(ports).run(athleteId, command)).resolves.toEqual({
      kind: "consumptionReported",
      status: "undeclared",
    });
    expect(send).not.toHaveBeenCalled();
    expect((ports.ledger as MemoryLedger).notifications.get(command.notificationId)?.outcome).toBe(
      "not_reported",
    );
  },
);
