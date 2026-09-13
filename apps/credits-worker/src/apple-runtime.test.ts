import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import { generateKeyPairSync, sign, verify, X509Certificate } from "node:crypto";
import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import roots from "./certificates/apple-roots.json" with { type: "json" };

it("executes Apple certificate parsing, ES256 and SDK signed HTTP in workerd", async () => {
  const certificate = new X509Certificate(Buffer.from(roots.G3, "base64"));
  expect(certificate.ca).toBe(true);
  const verifier = new SignedDataVerifier(
    [Buffer.from(roots.G3, "base64")],
    true,
    Environment.SANDBOX,
    "icu.enduragent.app",
  );
  await expect(verifier.verifyAndDecodeTransaction("invalid")).rejects.toThrow();
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bytes = Buffer.from("synthetic-1998");
  const signature = sign("sha256", bytes, keys.privateKey);
  expect(verify("sha256", bytes, keys.publicKey, signature)).toBe(true);
  const client = new AppStoreServerAPIClient(
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "synthetic-key",
    "synthetic-issuer",
    "icu.enduragent.app",
    Environment.SANDBOX,
  );
  await expect(client.requestTestNotification()).resolves.toEqual({
    testNotificationToken: "synthetic-notification",
  });
});

import fixtures from "./apple-fixtures.json" with { type: "json" };

it("verifies a trusted synthetic 1998 JWS and rejects tampering and expired certificates", async () => {
  const trusted = [Buffer.from(fixtures.root, "base64")];
  const verifier = new SignedDataVerifier(
    trusted,
    false,
    Environment.SANDBOX,
    "icu.enduragent.app",
  );
  await expect(
    verifier.verifyAndDecodeTransaction(fixtures.signedTransaction),
  ).resolves.toMatchObject({ transactionId: "synthetic-transaction" });
  const parts = fixtures.signedTransaction.split(".");
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  parts[1] = Buffer.from(JSON.stringify({ ...payload, price: 1 })).toString("base64url");
  await expect(verifier.verifyAndDecodeTransaction(parts.join("."))).rejects.toThrow();
  const strict = new SignedDataVerifier(trusted, true, Environment.SANDBOX, "icu.enduragent.app");
  await expect(strict.verifyAndDecodeTransaction(fixtures.signedTransaction)).rejects.toThrow();
});
