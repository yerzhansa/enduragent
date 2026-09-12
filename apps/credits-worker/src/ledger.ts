import type {
  AppleEnvironment,
  AthleteId,
  BanReason,
  Credits,
  GrantId,
  KeyHash,
  NotificationId,
  OriginalTransactionId,
  Pack,
  PricingPolicy,
  ProductId,
  ProviderMutationId,
  TransactionId,
  UsdMillis,
  Lot,
} from "./domain.js";
import { asCredits, asUsdMillis } from "./domain.js";
import type { D1Database } from "./env.js";

export type AthleteRecord = {
  athleteId: AthleteId;
  keyHash: KeyHash;
  keyGeneration: number;
  disabled: boolean;
  refundsAfterUse: number;
  createdAt: string;
};

export type PurchaseRecord = {
  transactionId: TransactionId;
  originalTransactionId: OriginalTransactionId;
  athleteId: AthleteId;
  productId: ProductId;
  environment: AppleEnvironment;
  capUsdMillis: UsdMillis;
  credits: Credits;
  policyVersion: number;
  claimedAt: string;
  refundedAt: string | undefined;
};

export type GrantRecord = {
  grantId: GrantId;
  athleteId: AthleteId;
  capUsdMillis: UsdMillis;
  credits: Credits;
  grantedAt: string;
};

export type ProviderMutation =
  | { kind: "createKey"; name: string; limitUsdMillis: UsdMillis }
  | { kind: "setLimit"; hash: KeyHash; limitUsdMillis: UsdMillis }
  | { kind: "setDisabled"; hash: KeyHash; disabled: boolean }
  | { kind: "deleteKey"; hash: KeyHash };

export type PendingProviderMutation = {
  mutationId: ProviderMutationId;
  athleteId: AthleteId;
  mutation: ProviderMutation;
  startedAt: string;
  completedAt: string | undefined;
};

export type NotificationRecord = {
  notificationId: NotificationId;
  type: "refund" | "revoke" | "consumption_request";
  transactionId: TransactionId | undefined;
  processedAt: string;
  outcome: "applied" | "duplicate" | "pending_purchase" | "reported";
};

export type BanRecord = {
  athleteId: AthleteId;
  reason: BanReason;
  bannedAt: string;
};

export type LinkedAppleId = {
  originalTransactionId: OriginalTransactionId;
  athleteId: AthleteId;
};

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pricing_policies (
  version INTEGER PRIMARY KEY,
  ratio TEXT NOT NULL,
  apple_commission TEXT NOT NULL,
  openrouter_fee TEXT NOT NULL,
  credits_per_usd INTEGER NOT NULL,
  effective_from TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packs (
  product_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  list_price_usd_millis INTEGER NOT NULL,
  cap_usd_millis INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  active INTEGER NOT NULL,
  PRIMARY KEY (product_id, policy_version)
);
CREATE TABLE IF NOT EXISTS athletes (
  athlete_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  key_generation INTEGER NOT NULL,
  disabled INTEGER NOT NULL,
  refunds_after_use INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS original_transactions (
  original_transaction_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  transaction_id TEXT PRIMARY KEY,
  original_transaction_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  cap_usd_millis INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  refunded_at TEXT
);
CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL,
  cap_usd_millis INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  granted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lots (
  lot_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL,
  source TEXT NOT NULL,
  transaction_id TEXT,
  original_cap_usd_millis INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apple_notifications (
  notification_uuid TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  transaction_id TEXT,
  processed_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_refunds (
  transaction_id TEXT PRIMARY KEY,
  notification_uuid TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bans (
  athlete_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  banned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS banned_original_transactions (
  original_transaction_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_provider_mutations (
  mutation_id TEXT PRIMARY KEY,
  athlete_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
`;

export type Ledger = {
  currentPolicy(): Promise<PricingPolicy>;
  insertPolicy(policy: PricingPolicy): Promise<void>;
  activePacks(policyVersion: number): Promise<readonly Pack[]>;
  pack(productId: ProductId, policyVersion: number): Promise<Pack | undefined>;
  putPack(pack: Pack): Promise<void>;

  athlete(athleteId: AthleteId): Promise<AthleteRecord | undefined>;
  athleteByOriginalTransaction(
    originalTransactionId: OriginalTransactionId,
  ): Promise<AthleteRecord | undefined>;
  insertAthlete(row: AthleteRecord): Promise<void>;
  updateAthlete(row: AthleteRecord): Promise<void>;

  linkOriginalTransaction(link: LinkedAppleId): Promise<void>;
  linkedOriginals(athleteId: AthleteId): Promise<readonly OriginalTransactionId[]>;

  purchase(transactionId: TransactionId): Promise<PurchaseRecord | undefined>;
  insertPurchase(row: PurchaseRecord): Promise<"inserted" | "duplicate">;
  markPurchaseRefunded(transactionId: TransactionId, at: string): Promise<void>;
  purchasesFor(athleteId: AthleteId): Promise<readonly PurchaseRecord[]>;

  grantsFor(athleteId: AthleteId): Promise<readonly GrantRecord[]>;
  insertGrant(row: GrantRecord): Promise<"inserted" | "duplicate">;

  putPendingMutation(row: PendingProviderMutation): Promise<void>;
  takePendingMutation(athleteId: AthleteId): Promise<PendingProviderMutation | undefined>;
  markPendingMutationDone(mutationId: ProviderMutationId, at: string): Promise<void>;

  insertLot(lot: Lot): Promise<void>;
  lotsOldestFirst(athleteId: AthleteId): Promise<readonly Lot[]>;

  insertNotification(row: NotificationRecord): Promise<"inserted" | "duplicate">;
  insertPendingRefund(transactionId: TransactionId, notificationId: NotificationId): Promise<void>;
  takePendingRefund(transactionId: TransactionId): Promise<NotificationId | undefined>;

  insertBan(row: BanRecord): Promise<void>;
  ban(athleteId: AthleteId): Promise<BanRecord | undefined>;
  banOriginals(ids: readonly OriginalTransactionId[], athleteId: AthleteId): Promise<void>;
  isOriginalBanned(originalTransactionId: OriginalTransactionId): Promise<boolean>;

  listAthletes(): Promise<readonly AthleteRecord[]>;
};

type D1RunResult = { meta?: { changes?: number } };

type PolicyRow = {
  version: number;
  ratio: string;
  apple_commission: string;
  openrouter_fee: string;
  credits_per_usd: number;
  effective_from: string;
};

type PackRow = {
  product_id: string;
  policy_version: number;
  list_price_usd_millis: number;
  cap_usd_millis: number;
  credits: number;
  active: number;
};

type AthleteRow = {
  athlete_id: string;
  key_hash: string;
  key_generation: number;
  disabled: number;
  refunds_after_use: number;
  created_at: string;
};

type PurchaseRow = {
  transaction_id: string;
  original_transaction_id: string;
  athlete_id: string;
  product_id: string;
  environment: string;
  cap_usd_millis: number;
  credits: number;
  policy_version: number;
  claimed_at: string;
  refunded_at: string | null;
};

type GrantRow = {
  grant_id: string;
  athlete_id: string;
  cap_usd_millis: number;
  credits: number;
  granted_at: string;
};

type LotRow = {
  lot_id: string;
  athlete_id: string;
  source: string;
  transaction_id: string | null;
  original_cap_usd_millis: number;
  created_at: string;
};

type MutationRow = {
  mutation_id: string;
  athlete_id: string;
  kind: string;
  payload_json: string;
  started_at: string;
  completed_at: string | null;
};

type BanRow = {
  athlete_id: string;
  reason: string;
  banned_at: string;
};

function mapPolicy(row: PolicyRow): PricingPolicy {
  return {
    version: row.version,
    ratio: Number(row.ratio),
    appleCommission: Number(row.apple_commission),
    openrouterFee: Number(row.openrouter_fee),
    creditsPerUsd: row.credits_per_usd,
    effectiveFrom: row.effective_from,
  };
}

function mapPack(row: PackRow): Pack {
  return {
    productId: row.product_id as ProductId,
    policyVersion: row.policy_version,
    listPriceUsdMillis: asUsdMillis(row.list_price_usd_millis),
    capUsdMillis: asUsdMillis(row.cap_usd_millis),
    credits: asCredits(row.credits),
    active: row.active === 1,
  };
}

function mapAthlete(row: AthleteRow): AthleteRecord {
  return {
    athleteId: row.athlete_id as AthleteId,
    keyHash: row.key_hash as KeyHash,
    keyGeneration: row.key_generation,
    disabled: row.disabled === 1,
    refundsAfterUse: row.refunds_after_use,
    createdAt: row.created_at,
  };
}

function mapPurchase(row: PurchaseRow): PurchaseRecord {
  return {
    transactionId: row.transaction_id as TransactionId,
    originalTransactionId: row.original_transaction_id as OriginalTransactionId,
    athleteId: row.athlete_id as AthleteId,
    productId: row.product_id as ProductId,
    environment: row.environment as AppleEnvironment,
    capUsdMillis: asUsdMillis(row.cap_usd_millis),
    credits: asCredits(row.credits),
    policyVersion: row.policy_version,
    claimedAt: row.claimed_at,
    refundedAt: row.refunded_at ?? undefined,
  };
}

function mapGrant(row: GrantRow): GrantRecord {
  return {
    grantId: row.grant_id as GrantId,
    athleteId: row.athlete_id as AthleteId,
    capUsdMillis: asUsdMillis(row.cap_usd_millis),
    credits: asCredits(row.credits),
    grantedAt: row.granted_at,
  };
}

function mapLot(row: LotRow): Lot {
  return {
    lotId: row.lot_id as Lot["lotId"],
    athleteId: row.athlete_id as AthleteId,
    source: row.source as Lot["source"],
    transactionId: row.transaction_id ? (row.transaction_id as TransactionId) : undefined,
    originalCapUsdMillis: asUsdMillis(row.original_cap_usd_millis),
    createdAt: row.created_at,
  };
}

function mapMutation(row: MutationRow): PendingProviderMutation {
  return {
    mutationId: row.mutation_id as ProviderMutationId,
    athleteId: row.athlete_id as AthleteId,
    mutation: JSON.parse(row.payload_json) as ProviderMutation,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function mapBan(row: BanRow): BanRecord {
  return {
    athleteId: row.athlete_id as AthleteId,
    reason: row.reason as BanReason,
    bannedAt: row.banned_at,
  };
}

async function insertOrDuplicate(run: Promise<unknown>): Promise<"inserted" | "duplicate"> {
  const result = (await run) as D1RunResult;
  if ((result.meta?.changes ?? 0) === 0) return "duplicate";
  return "inserted";
}

export class D1Ledger implements Ledger {
  constructor(private readonly db: D1Database) {}

  async currentPolicy(): Promise<PricingPolicy> {
    const row = await this.db
      .prepare(
        `SELECT version, ratio, apple_commission, openrouter_fee, credits_per_usd, effective_from
         FROM pricing_policies ORDER BY version DESC LIMIT 1`,
      )
      .first<PolicyRow>();
    if (!row) throw new Error("not implemented");
    return mapPolicy(row);
  }

  async insertPolicy(policy: PricingPolicy): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pricing_policies
          (version, ratio, apple_commission, openrouter_fee, credits_per_usd, effective_from)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        policy.version,
        String(policy.ratio),
        String(policy.appleCommission),
        String(policy.openrouterFee),
        policy.creditsPerUsd,
        policy.effectiveFrom,
      )
      .run();
  }

  async activePacks(policyVersion: number): Promise<readonly Pack[]> {
    const { results } = await this.db
      .prepare(
        `SELECT product_id, policy_version, list_price_usd_millis, cap_usd_millis, credits, active
         FROM packs WHERE policy_version = ? AND active = 1`,
      )
      .bind(policyVersion)
      .all<PackRow>();
    return results.map(mapPack);
  }

  async pack(productId: ProductId, policyVersion: number): Promise<Pack | undefined> {
    const row = await this.db
      .prepare(
        `SELECT product_id, policy_version, list_price_usd_millis, cap_usd_millis, credits, active
         FROM packs WHERE product_id = ? AND policy_version = ?`,
      )
      .bind(productId, policyVersion)
      .first<PackRow>();
    return row ? mapPack(row) : undefined;
  }

  async putPack(pack: Pack): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO packs
          (product_id, policy_version, list_price_usd_millis, cap_usd_millis, credits, active)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        pack.productId,
        pack.policyVersion,
        pack.listPriceUsdMillis,
        pack.capUsdMillis,
        pack.credits,
        pack.active ? 1 : 0,
      )
      .run();
  }

  async athlete(athleteId: AthleteId): Promise<AthleteRecord | undefined> {
    const row = await this.db
      .prepare(
        `SELECT athlete_id, key_hash, key_generation, disabled, refunds_after_use, created_at
         FROM athletes WHERE athlete_id = ?`,
      )
      .bind(athleteId)
      .first<AthleteRow>();
    return row ? mapAthlete(row) : undefined;
  }

  async athleteByOriginalTransaction(
    originalTransactionId: OriginalTransactionId,
  ): Promise<AthleteRecord | undefined> {
    const row = await this.db
      .prepare(
        `SELECT a.athlete_id, a.key_hash, a.key_generation, a.disabled, a.refunds_after_use, a.created_at
         FROM original_transactions o
         JOIN athletes a ON a.athlete_id = o.athlete_id
         WHERE o.original_transaction_id = ?`,
      )
      .bind(originalTransactionId)
      .first<AthleteRow>();
    return row ? mapAthlete(row) : undefined;
  }

  async insertAthlete(row: AthleteRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO athletes
          (athlete_id, key_hash, key_generation, disabled, refunds_after_use, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.athleteId,
        row.keyHash,
        row.keyGeneration,
        row.disabled ? 1 : 0,
        row.refundsAfterUse,
        row.createdAt,
      )
      .run();
  }

  async updateAthlete(row: AthleteRecord): Promise<void> {
    await this.db
      .prepare(
        `UPDATE athletes
         SET key_hash = ?, key_generation = ?, disabled = ?, refunds_after_use = ?, created_at = ?
         WHERE athlete_id = ?`,
      )
      .bind(
        row.keyHash,
        row.keyGeneration,
        row.disabled ? 1 : 0,
        row.refundsAfterUse,
        row.createdAt,
        row.athleteId,
      )
      .run();
  }

  async linkOriginalTransaction(link: LinkedAppleId): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO original_transactions (original_transaction_id, athlete_id)
         VALUES (?, ?)`,
      )
      .bind(link.originalTransactionId, link.athleteId)
      .run();
  }

  async linkedOriginals(athleteId: AthleteId): Promise<readonly OriginalTransactionId[]> {
    const { results } = await this.db
      .prepare(`SELECT original_transaction_id FROM original_transactions WHERE athlete_id = ?`)
      .bind(athleteId)
      .all<{ original_transaction_id: string }>();
    return results.map((row) => row.original_transaction_id as OriginalTransactionId);
  }

  async purchase(transactionId: TransactionId): Promise<PurchaseRecord | undefined> {
    const row = await this.db
      .prepare(
        `SELECT transaction_id, original_transaction_id, athlete_id, product_id, environment,
                cap_usd_millis, credits, policy_version, claimed_at, refunded_at
         FROM purchases WHERE transaction_id = ?`,
      )
      .bind(transactionId)
      .first<PurchaseRow>();
    return row ? mapPurchase(row) : undefined;
  }

  async insertPurchase(row: PurchaseRecord): Promise<"inserted" | "duplicate"> {
    return insertOrDuplicate(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO purchases
            (transaction_id, original_transaction_id, athlete_id, product_id, environment,
             cap_usd_millis, credits, policy_version, claimed_at, refunded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.transactionId,
          row.originalTransactionId,
          row.athleteId,
          row.productId,
          row.environment,
          row.capUsdMillis,
          row.credits,
          row.policyVersion,
          row.claimedAt,
          row.refundedAt ?? null,
        )
        .run(),
    );
  }

  async markPurchaseRefunded(transactionId: TransactionId, at: string): Promise<void> {
    await this.db
      .prepare(`UPDATE purchases SET refunded_at = ? WHERE transaction_id = ?`)
      .bind(at, transactionId)
      .run();
  }

  async purchasesFor(athleteId: AthleteId): Promise<readonly PurchaseRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT transaction_id, original_transaction_id, athlete_id, product_id, environment,
                cap_usd_millis, credits, policy_version, claimed_at, refunded_at
         FROM purchases WHERE athlete_id = ?`,
      )
      .bind(athleteId)
      .all<PurchaseRow>();
    return results.map(mapPurchase);
  }

  async grantsFor(athleteId: AthleteId): Promise<readonly GrantRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT grant_id, athlete_id, cap_usd_millis, credits, granted_at
         FROM grants WHERE athlete_id = ?`,
      )
      .bind(athleteId)
      .all<GrantRow>();
    return results.map(mapGrant);
  }

  async insertGrant(row: GrantRecord): Promise<"inserted" | "duplicate"> {
    return insertOrDuplicate(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO grants
            (grant_id, athlete_id, cap_usd_millis, credits, granted_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(row.grantId, row.athleteId, row.capUsdMillis, row.credits, row.grantedAt)
        .run(),
    );
  }

  async putPendingMutation(row: PendingProviderMutation): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_provider_mutations
          (mutation_id, athlete_id, kind, payload_json, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.mutationId,
        row.athleteId,
        row.mutation.kind,
        JSON.stringify(row.mutation),
        row.startedAt,
        row.completedAt ?? null,
      )
      .run();
  }

  async takePendingMutation(athleteId: AthleteId): Promise<PendingProviderMutation | undefined> {
    const row = await this.db
      .prepare(
        `SELECT mutation_id, athlete_id, kind, payload_json, started_at, completed_at
         FROM pending_provider_mutations
         WHERE athlete_id = ? AND completed_at IS NULL
         ORDER BY started_at ASC
         LIMIT 1`,
      )
      .bind(athleteId)
      .first<MutationRow>();
    return row ? mapMutation(row) : undefined;
  }

  async markPendingMutationDone(mutationId: ProviderMutationId, at: string): Promise<void> {
    await this.db
      .prepare(`UPDATE pending_provider_mutations SET completed_at = ? WHERE mutation_id = ?`)
      .bind(at, mutationId)
      .run();
  }

  async insertLot(lot: Lot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO lots
          (lot_id, athlete_id, source, transaction_id, original_cap_usd_millis, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        lot.lotId,
        lot.athleteId,
        lot.source,
        lot.transactionId ?? null,
        lot.originalCapUsdMillis,
        lot.createdAt,
      )
      .run();
  }

  async lotsOldestFirst(athleteId: AthleteId): Promise<readonly Lot[]> {
    const { results } = await this.db
      .prepare(
        `SELECT lot_id, athlete_id, source, transaction_id, original_cap_usd_millis, created_at
         FROM lots WHERE athlete_id = ?
         ORDER BY created_at ASC, lot_id ASC`,
      )
      .bind(athleteId)
      .all<LotRow>();
    return results.map(mapLot);
  }

  async insertNotification(row: NotificationRecord): Promise<"inserted" | "duplicate"> {
    return insertOrDuplicate(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO apple_notifications
            (notification_uuid, type, transaction_id, processed_at, outcome)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          row.notificationId,
          row.type,
          row.transactionId ?? null,
          row.processedAt,
          row.outcome,
        )
        .run(),
    );
  }

  async insertPendingRefund(
    transactionId: TransactionId,
    notificationId: NotificationId,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_refunds (transaction_id, notification_uuid)
         VALUES (?, ?)`,
      )
      .bind(transactionId, notificationId)
      .run();
  }

  async takePendingRefund(transactionId: TransactionId): Promise<NotificationId | undefined> {
    const row = await this.db
      .prepare(`SELECT notification_uuid FROM pending_refunds WHERE transaction_id = ?`)
      .bind(transactionId)
      .first<{ notification_uuid: string }>();
    if (!row) return undefined;
    await this.db
      .prepare(`DELETE FROM pending_refunds WHERE transaction_id = ?`)
      .bind(transactionId)
      .run();
    return row.notification_uuid as NotificationId;
  }

  async insertBan(row: BanRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO bans (athlete_id, reason, banned_at) VALUES (?, ?, ?)`,
      )
      .bind(row.athleteId, row.reason, row.bannedAt)
      .run();
  }

  async ban(athleteId: AthleteId): Promise<BanRecord | undefined> {
    const row = await this.db
      .prepare(`SELECT athlete_id, reason, banned_at FROM bans WHERE athlete_id = ?`)
      .bind(athleteId)
      .first<BanRow>();
    return row ? mapBan(row) : undefined;
  }

  async banOriginals(ids: readonly OriginalTransactionId[], athleteId: AthleteId): Promise<void> {
    for (const originalTransactionId of ids) {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO banned_original_transactions
            (original_transaction_id, athlete_id) VALUES (?, ?)`,
        )
        .bind(originalTransactionId, athleteId)
        .run();
    }
  }

  async isOriginalBanned(originalTransactionId: OriginalTransactionId): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT original_transaction_id FROM banned_original_transactions
         WHERE original_transaction_id = ?`,
      )
      .bind(originalTransactionId)
      .first<{ original_transaction_id: string }>();
    return row !== null;
  }

  async listAthletes(): Promise<readonly AthleteRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT athlete_id, key_hash, key_generation, disabled, refunds_after_use, created_at
         FROM athletes`,
      )
      .all<AthleteRow>();
    return results.map(mapAthlete);
  }
}
