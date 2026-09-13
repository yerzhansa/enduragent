import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import { Buffer } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import fixtures from "../scripts/proof-fixtures.json" with { type: "json" };

afterEach(() => vi.useRealTimers());

function verifier() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("1998-06-13T00:00:00Z"));
  return new SignedDataVerifier(
    [Buffer.from(fixtures.root, "base64")],
    true,
    Environment.SANDBOX,
    "icu.enduragent.app",
  );
}

it.each(["good", "futureBoundary", "expiryBoundary"] as const)(
  "workerd accepts signed %s OCSP through the production SDK",
  async (variant) => {
    await expect(
      verifier().verifyAndDecodeTransaction(fixtures.transactions[variant]),
    ).resolves.toMatchObject({ originalTransactionId: "synthetic-original" });
  },
);

it.each(["revoked", "stale", "wrongCert", "future", "invalidDate", "missingNext"] as const)(
  "workerd rejects signed %s OCSP through the production SDK",
  async (variant) => {
    await expect(
      verifier().verifyAndDecodeTransaction(fixtures.transactions[variant]),
    ).rejects.toThrow();
  },
);
