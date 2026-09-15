import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asCredits,
  asUsdMillis,
  type AthleteId,
  type DeviceGrantOwnerId,
  type KeyHash,
  type LotId,
  type NotificationId,
  type OriginalTransactionId,
  type ProductId,
  type ProviderMutationId,
  type TransactionId,
} from "./domain.js";
import { MemoryLedger } from "./fakes.js";
import { D1Ledger, type Ledger, type PurchaseRecord } from "./ledger.js";

const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;
const tx = "tx-1998-1" as TransactionId;
const original = "orig-1998-1" as OriginalTransactionId;

function purchaseRow(transactionId: TransactionId = tx): PurchaseRecord {
  return {
    transactionId,
    originalTransactionId: original,
    athleteId,
    productId: "credits_4_99" as ProductId,
    environment: "sandbox",
    capUsdMillis: asUsdMillis(4008),
    credits: asCredits(401),
    policyVersion: 1,
    claimedAt: "1998-06-13T06:00:00.000Z",
    refundedAt: undefined,
  };
}

async function seedSchema(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

async function clearD1(): Promise<void> {
  await env.DB.exec(`
DELETE FROM pending_provider_mutations;
DELETE FROM device_grant_gate;
DELETE FROM pending_refunds;
DELETE FROM apple_notifications;
DELETE FROM lots;
DELETE FROM grants;
DELETE FROM purchases;
DELETE FROM banned_original_transactions;
DELETE FROM original_transactions;
DELETE FROM bans;
DELETE FROM athletes;
DELETE FROM packs;
DELETE FROM pricing_policies;
`);
}

function contract(name: string, makeLedger: () => Promise<Ledger>): void {
  describe(name, () => {
    it("notification identity appears only after a recorded outcome", async () => {
      const ledger = await makeLedger();
      const notificationId = "synthetic-consumption" as NotificationId;
      expect(await ledger.hasNotification(notificationId)).toBe(false);
      await ledger.insertNotification({
        notificationId,
        type: "consumption_request",
        transactionId: tx,
        processedAt: "1998-06-13T00:00:00Z",
        outcome: "not_reported",
      });
      expect(await ledger.hasNotification(notificationId)).toBe(true);
      expect(await ledger.hasNotification("synthetic-other" as NotificationId)).toBe(false);
    });

    it("insertPurchase duplicate", async () => {
      const ledger = await makeLedger();
      const row = purchaseRow();
      expect(await ledger.insertPurchase(row)).toBe("inserted");
      expect(await ledger.insertPurchase(row)).toBe("duplicate");
    });

    it("takePendingMutation returns only unfinished", async () => {
      const ledger = await makeLedger();
      await ledger.putPendingMutation({
        mutationId: "mut_1998_1" as ProviderMutationId,
        athleteId,
        mutation: { kind: "setDisabled", hash: "hash_1" as KeyHash, disabled: true },
        recovery: "replay",
        startedAt: "1998-06-13T06:00:00.000Z",
        completedAt: undefined,
      });
      await ledger.putPendingMutation({
        mutationId: "mut_1998_2" as ProviderMutationId,
        athleteId,
        mutation: { kind: "deleteKey", hash: "hash_2" as KeyHash },
        recovery: "replay",
        startedAt: "1998-06-13T07:00:00.000Z",
        completedAt: undefined,
      });
      await ledger.markPendingMutationDone(
        "mut_1998_1" as ProviderMutationId,
        "1998-06-13T08:00:00.000Z",
      );
      const pending = await ledger.takePendingMutation(athleteId);
      expect(pending?.mutationId).toBe("mut_1998_2");
      expect(pending?.completedAt).toBeUndefined();
    });

    it("device grant ownership expires and fences the previous owner", async () => {
      const ledger = await makeLedger();
      const first = "device_owner_1998_first" as DeviceGrantOwnerId;
      const second = "device_owner_1998_second" as DeviceGrantOwnerId;
      expect(
        await ledger.tryClaimDeviceGrant({
          ownerId: first,
          now: "1998-06-13T06:00:00.000Z",
          expiresAt: "1998-06-13T06:01:00.000Z",
        }),
      ).toBe("claimed");
      expect(
        await ledger.tryClaimDeviceGrant({
          ownerId: second,
          now: "1998-06-13T06:00:30.000Z",
          expiresAt: "1998-06-13T06:01:30.000Z",
        }),
      ).toBe("busy");
      expect(
        await ledger.tryClaimDeviceGrant({
          ownerId: second,
          now: "1998-06-13T06:01:00.000Z",
          expiresAt: "1998-06-13T06:02:00.000Z",
        }),
      ).toBe("claimed");
      expect(await ledger.authorizeDeviceGrant(first, "1998-06-13T06:01:01.000Z")).toBe(false);
      expect(await ledger.authorizeDeviceGrant(second, "1998-06-13T06:01:01.000Z")).toBe(true);
    });

    it("lotsOldestFirst order", async () => {
      const ledger = await makeLedger();
      await ledger.insertLot({
        lotId: "lot_1998_new" as LotId,
        athleteId,
        source: "purchase",
        transactionId: "tx-1998-2" as TransactionId,
        originalCapUsdMillis: asUsdMillis(4008),
        createdAt: "1998-06-13T10:00:00.000Z",
      });
      await ledger.insertLot({
        lotId: "lot_1998_old" as LotId,
        athleteId,
        source: "grant",
        transactionId: undefined,
        originalCapUsdMillis: asUsdMillis(2000),
        createdAt: "1998-06-13T06:00:00.000Z",
      });
      const lots = await ledger.lotsOldestFirst(athleteId);
      expect(lots.map((lot) => lot.lotId)).toEqual(["lot_1998_old", "lot_1998_new"]);
    });
  });
}

contract("MemoryLedger", async () => new MemoryLedger());

describe("D1Ledger", () => {
  beforeAll(async () => {
    await seedSchema();
  });

  beforeEach(async () => {
    await seedSchema();
    await clearD1();
  });

  contract("binding", async () => new D1Ledger(env.DB));
});
