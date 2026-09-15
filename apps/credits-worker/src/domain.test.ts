import { describe, expect, it } from "vitest";
import {
  asUsdMillis,
  capForListPrice,
  reportedConsumption,
  usageTowardLot,
  type AthleteId,
  type Lot,
  type PricingPolicy,
  type TransactionId,
} from "./domain.js";

const policy: PricingPolicy = {
  version: 1,
  ratio: 1.0,
  appleCommission: 0.15,
  openrouterFee: 0.055,
  creditsPerUsd: 100,
  effectiveFrom: "1998-06-13T00:00:00Z",
};

const athleteId = "19980613-0000-4000-8000-000000000001" as AthleteId;

describe("domain", () => {
  it("cap for 4.99 at ratio 1.0", () => {
    expect(capForListPrice(asUsdMillis(4990), policy)).toEqual({
      capUsdMillis: asUsdMillis(4008),
      credits: 401,
    });
  });

  it("consumption undeclared when reporting unverified", () => {
    expect(
      reportedConsumption({
        reporting: "unverified",
        openRouterReachable: true,
        status: "fully_consumed",
      }),
    ).toBe("undeclared");
  });

  it("FIFO burn reaches second lot", () => {
    const second = "tx-1998-2" as TransactionId;
    const lots: Lot[] = [
      {
        lotId: "lot_1998_1" as Lot["lotId"],
        athleteId,
        source: "grant",
        transactionId: undefined,
        originalCapUsdMillis: asUsdMillis(2000),
        createdAt: "1998-06-13T06:00:00.000Z",
      },
      {
        lotId: "lot_1998_2" as Lot["lotId"],
        athleteId,
        source: "purchase",
        transactionId: second,
        originalCapUsdMillis: asUsdMillis(4008),
        createdAt: "1998-06-13T07:00:00.000Z",
      },
    ];
    expect(usageTowardLot(lots, asUsdMillis(2500), second)).toEqual(asUsdMillis(500));
  });
});
