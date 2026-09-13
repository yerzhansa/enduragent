import {
  DomainError,
  asCredits,
  asUsdMillis,
  capForListPrice,
  type OriginalTransactionId,
} from "./domain.js";
import type { OpenRouterKeyView } from "./openrouter.js";
import type { AppleStore, DeviceCheck } from "./apple.js";
import type { AthleteRuntime } from "./athlete-session.js";
import type { AthleteId, Credits, KeyHash, ProductId, UsdMillis } from "./domain.js";
import { PricingConflict, type Ledger } from "./ledger.js";
import type { OpenRouterKeys } from "./openrouter.js";

export type PricingChange = {
  ratio: number;
};

export type NewPack = {
  productId: ProductId;
  listPriceUsdMillis: UsdMillis;
};

export type SpendReport = {
  athleteId: AthleteId | undefined;
  keyHash: KeyHash;
  grantedUsdMillis: UsdMillis;
  refundedUsdMillis: UsdMillis;
} & (
  | {
      missingRemoteKey: false;
      orphanedRemoteKey: boolean;
      remainingUsdMillis: UsdMillis;
      usageUsdMillis: UsdMillis;
      creditsRemaining: Credits;
      disabled: boolean;
    }
  | {
      missingRemoteKey: true;
      orphanedRemoteKey: false;
      athleteId: AthleteId;
      remainingUsdMillis: null;
      usageUsdMillis: null;
      creditsRemaining: null;
      disabled: null;
    }
);

export type Operator = {
  setRatio(change: PricingChange): Promise<{ policyVersion: number }>;
  addPack(pack: NewPack): Promise<void>;
  ban(input: { athleteId: AthleteId } | { originalTransactionId: string }): Promise<void>;
  spend(athleteId: AthleteId): Promise<SpendReport>;
  spendAll(): Promise<readonly SpendReport[]>;
};

export function createOperator(ports: {
  ledger: Ledger;
  keys: OpenRouterKeys;
  apple: AppleStore;
  deviceCheck: DeviceCheck;
  runtime: AthleteRuntime;
}): Operator {
  const { ledger, keys } = ports;
  async function mutatePricing<T>(write: (revision: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = await ledger.pricingRevision();
      try {
        return await write(revision);
      } catch (error) {
        if (!(error instanceof PricingConflict)) throw error;
      }
    }
    throw new DomainError("unavailable");
  }
  async function report(
    athleteId: AthleteId,
    view?: OpenRouterKeyView | null,
  ): Promise<SpendReport> {
    const athlete = await ledger.athlete(athleteId);
    if (!athlete) throw new DomainError("identity_mismatch");
    const remote = view === undefined ? await keys.get(athlete.keyHash) : view;
    const grants = await ledger.grantsFor(athleteId);
    const purchases = await ledger.purchasesFor(athleteId);
    const totals = {
      athleteId,
      keyHash: athlete.keyHash,
      grantedUsdMillis: asUsdMillis(
        [...grants, ...purchases].reduce((sum, row) => sum + row.capUsdMillis, 0),
      ),
      refundedUsdMillis: asUsdMillis(
        purchases
          .filter((row) => row.refundedAt !== undefined)
          .reduce((sum, row) => sum + row.capUsdMillis, 0),
      ),
    };
    if (remote === null) {
      return {
        ...totals,
        missingRemoteKey: true,
        orphanedRemoteKey: false,
        remainingUsdMillis: null,
        usageUsdMillis: null,
        creditsRemaining: null,
        disabled: null,
      };
    }
    const policy = await ledger.currentPolicy();
    return {
      ...totals,
      missingRemoteKey: false,
      orphanedRemoteKey: false,
      remainingUsdMillis: remote.remainingUsdMillis,
      usageUsdMillis: remote.usageUsdMillis,
      creditsRemaining: asCredits(
        Math.floor((remote.remainingUsdMillis * policy.creditsPerUsd) / 1000),
      ),
      disabled: remote.disabled,
    };
  }
  return {
    async setRatio({ ratio }) {
      if (!Number.isFinite(ratio) || ratio <= 0) throw new DomainError("identity_mismatch");
      return mutatePricing(async (revision) => {
        const previous = await ledger.currentPolicy();
        const policy = {
          ...previous,
          version: previous.version + 1,
          ratio,
          effectiveFrom: new Date().toISOString(),
        };
        const packs = (await ledger.activePacks(previous.version)).map((pack) => ({
          ...pack,
          policyVersion: policy.version,
          ...capForListPrice(pack.listPriceUsdMillis, policy),
        }));
        await ledger.publishPolicy(policy, packs, revision);
        return { policyVersion: policy.version };
      });
    },
    async addPack(pack) {
      if (!/^[A-Za-z0-9._-]{1,255}$/.test(pack.productId) || pack.listPriceUsdMillis <= 0)
        throw new DomainError("identity_mismatch");
      return mutatePricing(async (revision) => {
        const policy = await ledger.currentPolicy();
        await ledger.putPack(
          {
            ...pack,
            policyVersion: policy.version,
            ...capForListPrice(pack.listPriceUsdMillis, policy),
            active: true,
          },
          revision,
        );
      });
    },
    async ban(input) {
      const athleteId =
        "athleteId" in input
          ? input.athleteId
          : (
              await ledger.athleteByOriginalTransaction(
                input.originalTransactionId as OriginalTransactionId,
              )
            )?.athleteId;
      if (!athleteId) throw new DomainError("identity_mismatch");
      await ports.runtime.run(athleteId, { kind: "ban", reason: "operator" });
    },
    spend: report,
    async spendAll() {
      const remote = await keys.list();
      const athletes = await ledger.listAthletes();
      const owners = new Map(athletes.map((athlete) => [athlete.keyHash, athlete.athleteId]));
      const reports: SpendReport[] = [];
      const policy = await ledger.currentPolicy();
      for (const view of remote) {
        const athleteId = owners.get(view.hash);
        if (athleteId) reports.push(await report(athleteId, view));
        else
          reports.push({
            athleteId: undefined,
            keyHash: view.hash,
            orphanedRemoteKey: true,
            missingRemoteKey: false,
            grantedUsdMillis: asUsdMillis(0),
            refundedUsdMillis: asUsdMillis(0),
            remainingUsdMillis: view.remainingUsdMillis,
            usageUsdMillis: view.usageUsdMillis,
            creditsRemaining: asCredits(
              Math.floor((view.remainingUsdMillis * policy.creditsPerUsd) / 1000),
            ),
            disabled: view.disabled,
          });
      }
      for (const athlete of athletes) {
        if (!remote.some((view) => view.hash === athlete.keyHash))
          reports.push(await report(athlete.athleteId, null));
      }
      return reports;
    },
  };
}
