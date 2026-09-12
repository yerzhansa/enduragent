declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AthleteId = Brand<string, "AthleteId">;
export type TransactionId = Brand<string, "TransactionId">;
export type OriginalTransactionId = Brand<string, "OriginalTransactionId">;
export type ProductId = Brand<string, "ProductId">;
export type KeyHash = Brand<string, "KeyHash">;
export type AthleteKey = Brand<string, "AthleteKey">;
export type NotificationId = Brand<string, "NotificationId">;
export type DeviceCheckToken = Brand<string, "DeviceCheckToken">;
export type LotId = Brand<string, "LotId">;
export type GrantId = Brand<string, "GrantId">;
export type ProviderMutationId = Brand<string, "ProviderMutationId">;
export type UsdMillis = Brand<number, "UsdMillis">;
export type Credits = Brand<number, "Credits">;

export type DomainErrorCode =
  | "banned"
  | "not_our_bundle"
  | "wrong_environment"
  | "unknown_pack"
  | "no_purchase_to_recover"
  | "purchases_disabled"
  | "rate_limited"
  | "unavailable"
  | "identity_mismatch";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode) {
    super(code);
    this.name = "DomainError";
    this.code = code;
  }
}

export function athleteIdFromUuid(raw: string): AthleteId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new DomainError("identity_mismatch");
  }
  return raw.toLowerCase() as AthleteId;
}

export function asCredits(units: number): Credits {
  if (!Number.isInteger(units) || units < 0) throw new DomainError("unavailable");
  return units as Credits;
}

export function asUsdMillis(n: number): UsdMillis {
  if (!Number.isInteger(n) || n < 0) throw new DomainError("unavailable");
  return n as UsdMillis;
}

export type AppleEnvironment = "sandbox" | "production";

export type DeviceBits = {
  grantClaimed: boolean;
  banned: boolean;
};

export type VerifiedPurchase = {
  transactionId: TransactionId;
  originalTransactionId: OriginalTransactionId;
  productId: ProductId;
  bundleId: string;
  environment: AppleEnvironment;
  athleteId: AthleteId;
  priceMillis: number;
  currency: string;
};

export type PricingPolicy = {
  version: number;
  ratio: number;
  appleCommission: number;
  openrouterFee: number;
  creditsPerUsd: number;
  effectiveFrom: string;
};

export type Pack = {
  productId: ProductId;
  policyVersion: number;
  listPriceUsdMillis: UsdMillis;
  capUsdMillis: UsdMillis;
  credits: Credits;
  active: boolean;
};

export function capForListPrice(
  listPriceUsdMillis: UsdMillis,
  policy: PricingPolicy,
): {
  capUsdMillis: UsdMillis;
  credits: Credits;
} {
  const cap =
    listPriceUsdMillis *
    (1 - policy.appleCommission) *
    (1 - policy.openrouterFee) *
    policy.ratio;
  const capUsdMillis = asUsdMillis(Math.round(cap));
  const credits = asCredits(Math.round((capUsdMillis / 1000) * policy.creditsPerUsd));
  return { capUsdMillis, credits };
}

export type LotSource = "grant" | "purchase";

export type Lot = {
  lotId: LotId;
  athleteId: AthleteId;
  source: LotSource;
  transactionId: TransactionId | undefined;
  originalCapUsdMillis: UsdMillis;
  createdAt: string;
};

export type ConsumptionStatus = "undeclared" | "not_consumed" | "partially_consumed" | "fully_consumed";

export type RefundPreference = "decline" | "prorate" | "grant";

export type ConsumptionReporting = "unverified" | "enabled" | "disabled";

export function spendUsdMillisFromRemaining(input: {
  grantedUsdMillis: UsdMillis;
  refundedUsdMillis: UsdMillis;
  remainingUsdMillis: UsdMillis;
}): UsdMillis {
  return asUsdMillis(
    Math.max(0, input.grantedUsdMillis - input.refundedUsdMillis - input.remainingUsdMillis),
  );
}

export function usageTowardLot(
  lotsOldestFirst: readonly Lot[],
  spendUsdMillis: UsdMillis,
  target: TransactionId,
): UsdMillis | undefined {
  let remaining = spendUsdMillis as number;
  for (const lot of lotsOldestFirst) {
    const cap = lot.originalCapUsdMillis as number;
    const consumed = Math.min(cap, Math.max(0, remaining));
    remaining -= consumed;
    if (lot.transactionId === target) {
      return asUsdMillis(consumed);
    }
  }
  return undefined;
}

export function consumptionForTransaction(
  lotsOldestFirst: readonly Lot[],
  spendUsdMillis: UsdMillis,
  target: TransactionId,
): ConsumptionStatus {
  const lot = lotsOldestFirst.find((row) => row.transactionId === target);
  if (!lot) return "undeclared";
  const consumed = usageTowardLot(lotsOldestFirst, spendUsdMillis, target);
  if (consumed === undefined) return "undeclared";
  if ((consumed as number) <= 0) return "not_consumed";
  if ((consumed as number) >= (lot.originalCapUsdMillis as number)) return "fully_consumed";
  return "partially_consumed";
}

export function consumptionPreference(args: {
  packCapUsdMillis: UsdMillis;
  usageTowardPackUsdMillis: UsdMillis;
}): RefundPreference {
  if ((args.usageTowardPackUsdMillis as number) <= 0) return "grant";
  if ((args.usageTowardPackUsdMillis as number) >= (args.packCapUsdMillis as number)) {
    return "decline";
  }
  return "prorate";
}

export function consumptionMilliunits(args: {
  packCapUsdMillis: UsdMillis;
  usageTowardPackUsdMillis: UsdMillis;
}): number {
  if ((args.packCapUsdMillis as number) === 0) return 0;
  const fraction = Math.min(
    1,
    (args.usageTowardPackUsdMillis as number) / (args.packCapUsdMillis as number),
  );
  return Math.round(fraction * 100_000);
}

export function reportedConsumption(input: {
  reporting: ConsumptionReporting;
  openRouterReachable: boolean;
  status: ConsumptionStatus;
}): ConsumptionStatus {
  if (!input.openRouterReachable || input.reporting !== "enabled") return "undeclared";
  return input.status;
}

export type BanReason = "operator" | "repeat_refund_after_use" | "linked_apple_account";

export type AthleteCommand =
  | {
      kind: "grant";
      deviceCheckToken: DeviceCheckToken;
      starterCapUsdMillis: UsdMillis;
      starterCredits: Credits;
    }
  | { kind: "claim"; purchase: VerifiedPurchase }
  | { kind: "recover"; purchase: VerifiedPurchase }
  | { kind: "refund"; notificationId: NotificationId; transactionId: TransactionId }
  | { kind: "revoke"; notificationId: NotificationId; transactionId: TransactionId }
  | {
      kind: "consumptionRequest";
      notificationId: NotificationId;
      transactionId: TransactionId;
    }
  | { kind: "ban"; reason: BanReason };

export type GrantResult =
  | { kind: "grantMinted"; key: AthleteKey; credits: Credits }
  | { kind: "grantToppedUp"; added: Credits }
  | { kind: "grantAlreadyGranted" };

export type AthleteResult =
  | GrantResult
  | { kind: "claimMinted"; key: AthleteKey; creditsAdded: Credits }
  | { kind: "claimToppedUp"; creditsAdded: Credits }
  | { kind: "claimAlreadyClaimed" }
  | { kind: "recovered"; athleteId: AthleteId; key: AthleteKey; credits: Credits }
  | { kind: "refundApplied"; capRemoved: UsdMillis }
  | { kind: "refundPendingPurchase" }
  | { kind: "refundDuplicate" }
  | { kind: "revoked" }
  | { kind: "consumptionReported"; status: ConsumptionStatus }
  | { kind: "banned" };

export type Clock = { now(): Date };

export type IdFactory = {
  lotId(): LotId;
  grantId(): GrantId;
  mutationId(): ProviderMutationId;
};
