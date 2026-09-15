import { env } from "cloudflare:test";
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { AppStoreServerClient } from "./apple.js";
import fixtures from "./apple-fixtures.json" with { type: "json" };

const expected = { bundleId: "icu.enduragent.app", environment: "sandbox" } as const;
function client() {
  return new AppStoreServerClient(env, {
    verifier: new SignedDataVerifier(
      [Buffer.from(fixtures.root, "base64")],
      false,
      Environment.SANDBOX,
      expected.bundleId,
    ),
  });
}
it("notification type REFUND maps to refund", async () => {
  await expect(client().verifyNotification(fixtures.refund, expected)).resolves.toMatchObject({
    type: "refund",
    transactionId: "synthetic-transaction",
    athleteId: "19980613-0000-4000-8000-000000000001",
  });
});
it("unknown notification type is ignored", async () => {
  await expect(client().verifyNotification(fixtures.test, expected)).resolves.toEqual({
    type: "ignored",
    notificationId: "synthetic-test",
  });
});
it("wrong bundle id throws not_our_bundle", async () => {
  await expect(client().verifySignedTransaction(fixtures.wrongBundle, expected)).rejects.toThrow(
    "not_our_bundle",
  );
});
it("rejects wrong environment and missing verified identity", async () => {
  await expect(
    client().verifySignedTransaction(fixtures.wrongEnvironment, expected),
  ).rejects.toThrow("wrong_environment");
  await expect(
    client().verifySignedTransaction(fixtures.missingIdentity, expected),
  ).rejects.toThrow("identity_mismatch");
});

import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, vi } from "vitest";
import { DeviceCheckClient } from "./apple.js";
import type { DeviceCheckToken, OriginalTransactionId, TransactionId } from "./domain.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("DeviceCheck preserves set bits and never sends a false bit write", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("1998-06-13T00:00:00Z"));
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ bit0: false, bit1: false }))
    .mockResolvedValueOnce(new Response(null));
  vi.stubGlobal("fetch", transport);
  const device = new DeviceCheckClient({
    ...env,
    APPLE_ENVIRONMENT: "sandbox",
    APPLE_DEVICECHECK_KEY_ID: "synthetic-key",
    APPLE_DEVICECHECK_TEAM_ID: "synthetic-team",
    APPLE_DEVICECHECK_P8: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  expect(crypto.randomUUID()).toBeTypeOf("string");
  await device.update("c3ludGhldGlj" as DeviceCheckToken, { banned: true });
  const init = transport.mock.calls[1]![1];
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ bit1: true });
  expect(body).not.toHaveProperty("bit0");
  expect(body.timestamp).toBe(Date.parse("1998-06-13T00:00:00Z"));
  expect(body.transaction_id).not.toBe(JSON.parse(transport.mock.calls[0]![1].body).transaction_id);
  const jwt = init.headers.authorization.slice(7).split(".");
  expect(JSON.parse(Buffer.from(jwt[0], "base64url").toString())).toMatchObject({
    alg: "ES256",
    kid: "synthetic-key",
  });
  expect(JSON.parse(Buffer.from(jwt[1], "base64url").toString())).toEqual({
    iss: "synthetic-team",
    iat: body.timestamp / 1000,
  });
  expect(
    verify(
      "sha256",
      Buffer.from(jwt.slice(0, 2).join(".")),
      { key: keys.publicKey.export({ type: "spki", format: "pem" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(jwt[2], "base64url"),
    ),
  ).toBe(true);
});

it("history paginates and verifies every signed entry", async () => {
  const getTransactionHistory = vi
    .fn()
    .mockResolvedValueOnce({
      signedTransactions: [fixtures.signedTransaction],
      hasMore: true,
      revision: "next",
    })
    .mockResolvedValueOnce({ signedTransactions: [fixtures.signedTransaction], hasMore: false });
  const apple = new AppStoreServerClient(env, {
    verifier: new SignedDataVerifier(
      [Buffer.from(fixtures.root, "base64")],
      false,
      Environment.SANDBOX,
      expected.bundleId,
    ),
    api: { getTransactionHistory },
  });
  await expect(
    apple.getTransactionHistory("synthetic-original" as OriginalTransactionId),
  ).resolves.toEqual(["synthetic-original"]);
  expect(getTransactionHistory.mock.calls[1]![1]).toBe("next");
});

it("rejects malformed identity, product and nested signatures", async () => {
  await expect(
    client().verifySignedTransaction(fixtures.invalidIdentity, expected),
  ).rejects.toThrow("identity_mismatch");
  await expect(client().verifySignedTransaction(fixtures.invalidProduct, expected)).rejects.toThrow(
    "unknown_pack",
  );
  await expect(client().verifyNotification(fixtures.invalidNested, expected)).rejects.toThrow(
    "identity_mismatch",
  );
});
it("DeviceCheck refuses invalid tokens and provider query/update failures", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const device = new DeviceCheckClient({
    ...env,
    APPLE_ENVIRONMENT: "sandbox",
    APPLE_DEVICECHECK_P8: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  const transport = vi
    .fn()
    .mockResolvedValueOnce(new Response("synthetic-secret", { status: 500 }))
    .mockResolvedValueOnce(Response.json({ bit0: true, bit1: false }))
    .mockResolvedValueOnce(new Response("synthetic-secret", { status: 500 }));
  vi.stubGlobal("fetch", transport);
  await expect(device.query("invalid token" as DeviceCheckToken)).rejects.toThrow(
    "identity_mismatch",
  );
  expect(transport).not.toHaveBeenCalled();
  await expect(device.query("c3ludGhldGlj" as DeviceCheckToken)).rejects.toThrow("unavailable");
  await expect(device.update("c3ludGhldGlj" as DeviceCheckToken, { banned: true })).rejects.toThrow(
    "unavailable",
  );
});
it("unverified reporting and undeclared status send no request", async () => {
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  await client().reportConsumption({
    transactionId: "synthetic-tx" as import("./domain.js").TransactionId,
    status: "undeclared",
    delivered: true,
  });
  await client().reportConsumption({
    transactionId: "synthetic-tx" as import("./domain.js").TransactionId,
    status: "fully_consumed",
    delivered: true,
  });
  expect(transport).not.toHaveBeenCalled();
});

it("enabled consumption without consent and sample facts refuses without transport", async () => {
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  const apple = new AppStoreServerClient({ ...env, CONSUMPTION_REPORTING: "enabled" });
  await expect(
    apple.reportConsumption({
      transactionId: "synthetic-tx" as TransactionId,
      status: "fully_consumed",
      delivered: true,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  await apple.reportConsumption({
    transactionId: "synthetic-tx" as TransactionId,
    status: "undeclared",
    delivered: true,
  });
  expect(transport).not.toHaveBeenCalled();
});

it("preserves retryable verification failures for transactions and notifications", async () => {
  const verifier = new SignedDataVerifier(
    [Buffer.from(fixtures.root, "base64")],
    false,
    Environment.SANDBOX,
    expected.bundleId,
  );
  const failure = new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE);
  vi.spyOn(verifier, "verifyAndDecodeTransaction").mockRejectedValue(failure);
  vi.spyOn(verifier, "verifyAndDecodeNotification").mockRejectedValue(failure);
  const apple = new AppStoreServerClient(env, { verifier });
  await expect(apple.verifySignedTransaction("synthetic", expected)).rejects.toThrow("unavailable");
  await expect(apple.verifyNotification("synthetic", expected)).rejects.toThrow("unavailable");
});
