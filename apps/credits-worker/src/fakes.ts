import type { AppleNotification, AppleStore, DeviceCheck } from "./apple.js";
import { directRuntime, type AthleteRuntime } from "./athlete-session.js";
import type {
  AppleEnvironment,
  AthleteId,
  AthleteKey,
  Clock,
  ConsumptionStatus,
  DeviceCheckToken,
  GrantId,
  IdFactory,
  KeyHash,
  Lot,
  LotId,
  NotificationId,
  OriginalTransactionId,
  Pack,
  PricingPolicy,
  ProductId,
  ProviderMutationId,
  TransactionId,
  UsdMillis,
  VerifiedPurchase,
} from "./domain.js";
import { asUsdMillis } from "./domain.js";
import type {
  AthleteRecord,
  BanRecord,
  GrantRecord,
  Ledger,
  NotificationRecord,
  PendingProviderMutation,
  PurchaseRecord,
} from "./ledger.js";
import type { GuardrailMode, OpenRouterKeyView, OpenRouterKeys } from "./openrouter.js";

export class MemoryLedger implements Ledger {
  policies: PricingPolicy[] = [];
  packs: Pack[] = [];
  athletes = new Map<string, AthleteRecord>();
  originals = new Map<string, AthleteId>();
  purchases = new Map<string, PurchaseRecord>();
  grants: GrantRecord[] = [];
  lots: Lot[] = [];
  notifications = new Map<string, NotificationRecord>();
  pendingRefunds = new Map<string, NotificationId>();
  pendingMutations: PendingProviderMutation[] = [];
  bans = new Map<string, BanRecord>();
  bannedOriginals = new Set<string>();

  async currentPolicy(): Promise<PricingPolicy> {
    const last = this.policies.at(-1);
    if (!last) throw new Error("not implemented");
    return last;
  }
  async insertPolicy(policy: PricingPolicy): Promise<void> {
    this.policies.push(policy);
  }
  async activePacks(policyVersion: number): Promise<readonly Pack[]> {
    return this.packs.filter((p) => p.policyVersion === policyVersion && p.active);
  }
  async pack(productId: ProductId, policyVersion: number): Promise<Pack | undefined> {
    return this.packs.find((p) => p.productId === productId && p.policyVersion === policyVersion);
  }
  async putPack(pack: Pack): Promise<void> {
    this.packs.push(pack);
  }
  async athlete(athleteId: AthleteId): Promise<AthleteRecord | undefined> {
    return this.athletes.get(athleteId);
  }
  async athleteByOriginalTransaction(
    originalTransactionId: OriginalTransactionId,
  ): Promise<AthleteRecord | undefined> {
    const id = this.originals.get(originalTransactionId);
    return id ? this.athletes.get(id) : undefined;
  }
  async insertAthlete(row: AthleteRecord): Promise<void> {
    this.athletes.set(row.athleteId, row);
  }
  async updateAthlete(row: AthleteRecord): Promise<void> {
    this.athletes.set(row.athleteId, row);
  }
  async linkOriginalTransaction(link: {
    originalTransactionId: OriginalTransactionId;
    athleteId: AthleteId;
  }): Promise<void> {
    this.originals.set(link.originalTransactionId, link.athleteId);
  }
  async linkedOriginals(athleteId: AthleteId): Promise<readonly OriginalTransactionId[]> {
    return [...this.originals.entries()]
      .filter(([, id]) => id === athleteId)
      .map(([tx]) => tx as OriginalTransactionId);
  }
  async purchase(transactionId: TransactionId): Promise<PurchaseRecord | undefined> {
    return this.purchases.get(transactionId);
  }
  async insertPurchase(row: PurchaseRecord): Promise<"inserted" | "duplicate"> {
    if (this.purchases.has(row.transactionId)) return "duplicate";
    this.purchases.set(row.transactionId, row);
    return "inserted";
  }
  async markPurchaseRefunded(transactionId: TransactionId, at: string): Promise<void> {
    const row = this.purchases.get(transactionId);
    if (row) this.purchases.set(transactionId, { ...row, refundedAt: at });
  }
  async purchasesFor(athleteId: AthleteId): Promise<readonly PurchaseRecord[]> {
    return [...this.purchases.values()].filter((p) => p.athleteId === athleteId);
  }
  async grantsFor(athleteId: AthleteId): Promise<readonly GrantRecord[]> {
    return this.grants.filter((row) => row.athleteId === athleteId);
  }
  async insertGrant(row: GrantRecord): Promise<"inserted" | "duplicate"> {
    if (this.grants.some((existing) => existing.grantId === row.grantId)) return "duplicate";
    this.grants.push(row);
    return "inserted";
  }
  async putPendingMutation(row: PendingProviderMutation): Promise<void> {
    this.pendingMutations.push(row);
  }
  async takePendingMutation(athleteId: AthleteId): Promise<PendingProviderMutation | undefined> {
    return this.pendingMutations.find(
      (row) => row.athleteId === athleteId && row.completedAt === undefined,
    );
  }
  async markPendingMutationDone(mutationId: ProviderMutationId, at: string): Promise<void> {
    const row = this.pendingMutations.find((mutation) => mutation.mutationId === mutationId);
    if (row) row.completedAt = at;
  }
  async insertLot(lot: Lot): Promise<void> {
    this.lots.push(lot);
  }
  async lotsOldestFirst(athleteId: AthleteId): Promise<readonly Lot[]> {
    return this.lots
      .filter((l) => l.athleteId === athleteId)
      .slice()
      .sort((a, b) => {
        const byTime = a.createdAt.localeCompare(b.createdAt);
        if (byTime !== 0) return byTime;
        return a.lotId.localeCompare(b.lotId);
      });
  }
  async insertNotification(row: NotificationRecord): Promise<"inserted" | "duplicate"> {
    if (this.notifications.has(row.notificationId)) return "duplicate";
    this.notifications.set(row.notificationId, row);
    return "inserted";
  }
  async insertPendingRefund(
    transactionId: TransactionId,
    notificationId: NotificationId,
  ): Promise<void> {
    this.pendingRefunds.set(transactionId, notificationId);
  }
  async takePendingRefund(transactionId: TransactionId): Promise<NotificationId | undefined> {
    const id = this.pendingRefunds.get(transactionId);
    this.pendingRefunds.delete(transactionId);
    return id;
  }
  async insertBan(row: BanRecord): Promise<void> {
    this.bans.set(row.athleteId, row);
  }
  async ban(athleteId: AthleteId): Promise<BanRecord | undefined> {
    return this.bans.get(athleteId);
  }
  async banOriginals(ids: readonly OriginalTransactionId[], _athleteId: AthleteId): Promise<void> {
    for (const id of ids) this.bannedOriginals.add(id);
  }
  async isOriginalBanned(originalTransactionId: OriginalTransactionId): Promise<boolean> {
    return this.bannedOriginals.has(originalTransactionId);
  }
  async listAthletes(): Promise<readonly AthleteRecord[]> {
    return [...this.athletes.values()];
  }
}

export function seedLaunchPolicy(ledger: MemoryLedger): void {
  ledger.policies.push({
    version: 1,
    ratio: 1,
    appleCommission: 0.15,
    openrouterFee: 0.055,
    creditsPerUsd: 100,
    effectiveFrom: "1998-06-13T00:00:00Z",
  });
}

export class FakeOpenRouterKeys implements OpenRouterKeys {
  keys = new Map<string, { secret: AthleteKey; view: OpenRouterKeyView }>();
  nextHash = 1;
  nextSecret = 1;
  createdCount = 0;
  setLimitCount = 0;

  async create(input: {
    name: string;
    limitUsdMillis: UsdMillis;
    guardrailMode: GuardrailMode;
    guardrailId: string | undefined;
  }): Promise<{ key: AthleteKey; hash: KeyHash }> {
    void input.name;
    void input.guardrailMode;
    void input.guardrailId;
    this.createdCount += 1;
    const hash = `hash_${this.nextHash++}` as KeyHash;
    const key = `fake-or-key-${this.nextSecret++}` as AthleteKey;
    this.keys.set(hash, {
      secret: key,
      view: {
        hash,
        limitUsdMillis: input.limitUsdMillis,
        remainingUsdMillis: input.limitUsdMillis,
        usageUsdMillis: asUsdMillis(0),
        disabled: false,
      },
    });
    return { key, hash };
  }
  async get(hash: KeyHash): Promise<OpenRouterKeyView> {
    const row = this.keys.get(hash);
    if (!row) throw new Error("not implemented");
    return row.view;
  }
  async setLimit(hash: KeyHash, limitUsdMillis: UsdMillis): Promise<void> {
    const row = this.keys.get(hash);
    if (!row) throw new Error("not implemented");
    this.setLimitCount += 1;
    const used = row.view.limitUsdMillis - row.view.remainingUsdMillis;
    row.view = {
      ...row.view,
      limitUsdMillis,
      remainingUsdMillis: asUsdMillis(Math.max(0, limitUsdMillis - used)),
    };
  }
  async setDisabled(hash: KeyHash, disabled: boolean): Promise<void> {
    const row = this.keys.get(hash);
    if (!row) throw new Error("not implemented");
    row.view = { ...row.view, disabled };
  }
  async delete(hash: KeyHash): Promise<void> {
    this.keys.delete(hash);
  }
  async count(): Promise<number> {
    return this.keys.size;
  }
  async list(): Promise<readonly OpenRouterKeyView[]> {
    return [...this.keys.values()].map((row) => row.view);
  }
}

export class FakeDeviceCheck implements DeviceCheck {
  bits = new Map<string, { grantClaimed: boolean; banned: boolean }>();
  async query(token: DeviceCheckToken) {
    return this.bits.get(token) ?? { grantClaimed: false, banned: false };
  }
  async update(token: DeviceCheckToken, bits: { grantClaimed?: boolean; banned?: boolean }) {
    const prev = await this.query(token);
    this.bits.set(token, {
      grantClaimed: bits.grantClaimed ?? prev.grantClaimed,
      banned: bits.banned ?? prev.banned,
    });
  }
}

export class FakeAppleStore implements AppleStore {
  purchases = new Map<string, VerifiedPurchase>();
  notifications: AppleNotification[] = [];
  history = new Map<string, OriginalTransactionId[]>();
  consumption: { transactionId: TransactionId; status: ConsumptionStatus }[] = [];

  async verifySignedTransaction(
    jws: string,
    _expected: { bundleId: string; environment: AppleEnvironment },
  ): Promise<VerifiedPurchase> {
    const row = this.purchases.get(jws);
    if (!row) throw new Error("not implemented");
    return row;
  }
  async verifyNotification(
    _signedPayload: string,
    _expected: { bundleId: string; environment: AppleEnvironment },
  ): Promise<AppleNotification> {
    const next = this.notifications.shift();
    if (!next) throw new Error("not implemented");
    return next;
  }
  async getTransactionHistory(
    originalTransactionId: OriginalTransactionId,
  ): Promise<readonly OriginalTransactionId[]> {
    return this.history.get(originalTransactionId) ?? [originalTransactionId];
  }
  async reportConsumption(input: {
    transactionId: TransactionId;
    status: ConsumptionStatus;
    delivered: boolean;
  }): Promise<void> {
    void input.delivered;
    this.consumption.push({ transactionId: input.transactionId, status: input.status });
  }
}

export const testClock: Clock = {
  now: () => new Date("1998-06-13T08:00:00+02:00"),
};

export const testIds: IdFactory = {
  lotId: () => "lot_1998_1" as LotId,
  grantId: () => "grant_1998_1" as GrantId,
  mutationId: () => "mut_1998_1" as ProviderMutationId,
};

export function testRuntime(ports: Parameters<typeof directRuntime>[0]): AthleteRuntime {
  return directRuntime(ports);
}
