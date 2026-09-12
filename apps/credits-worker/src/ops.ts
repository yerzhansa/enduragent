import type { AppleStore, DeviceCheck } from "./apple.js";
import type { AthleteRuntime } from "./athlete-session.js";
import type { AthleteId, Credits, KeyHash, ProductId, UsdMillis } from "./domain.js";
import type { Ledger } from "./ledger.js";
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
  keyHash: KeyHash | undefined;
  orphanedRemoteKey: boolean;
  grantedUsdMillis: UsdMillis;
  refundedUsdMillis: UsdMillis;
  remainingUsdMillis: UsdMillis;
  usageUsdMillis: UsdMillis;
  creditsRemaining: Credits;
  disabled: boolean;
};

export type Operator = {
  setRatio(change: PricingChange): Promise<{ policyVersion: number }>;
  addPack(pack: NewPack): Promise<void>;
  ban(input: { athleteId: AthleteId } | { originalTransactionId: string }): Promise<void>;
  spend(athleteId: AthleteId): Promise<SpendReport>;
  spendAll(): Promise<readonly SpendReport[]>;
};

export function createOperator(_ports: {
  ledger: Ledger;
  keys: OpenRouterKeys;
  apple: AppleStore;
  deviceCheck: DeviceCheck;
  runtime: AthleteRuntime;
}): Operator {
  return {
    setRatio() {
      throw new Error("not implemented");
    },
    addPack() {
      throw new Error("not implemented");
    },
    ban() {
      throw new Error("not implemented");
    },
    spend() {
      throw new Error("not implemented");
    },
    spendAll() {
      throw new Error("not implemented");
    },
  };
}
