import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { resolve } from "node:path";
import { unstable_dev } from "wrangler";

test("the bundled worker starts and rejects malformed Apple notifications", async (t) => {
  const worker = await unstable_dev(resolve("src/index.ts"), {
    config: "wrangler.jsonc",
    env: "testflight",
    envFiles: [],
    experimental: { disableDevRegistry: true, disableExperimentalWarning: true },
    inspect: false,
    local: true,
    logLevel: "none",
    persist: false,
  });
  t.after(() => worker.stop());

  const health = await worker.fetch("https://credits.test/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const notification = await worker.fetch("https://credits.test/apple", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedPayload: "invalid" }),
  });
  assert.equal(notification.status, 400);
  assert.deepEqual(await notification.json(), { error: "identity_mismatch" });
});

test("the bundled Apple SDK reaches outbound fetch", async (t) => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const worker = await unstable_dev(resolve("scripts/apple-sdk-fetch.fixture.ts"), {
    config: "wrangler.jsonc",
    env: "testflight",
    envFiles: [],
    experimental: { disableDevRegistry: true, disableExperimentalWarning: true },
    inspect: false,
    local: true,
    logLevel: "none",
    persist: false,
    vars: {
      APPLE_APP_STORE_P8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      APPLE_APP_STORE_KEY_ID: "synthetic-key",
      APPLE_APP_STORE_ISSUER_ID: "synthetic-issuer",
      BUNDLE_ID: "icu.enduragent.app",
    },
  });
  t.after(() => worker.stop());

  const response = await worker.fetch("https://credits.test/");
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.deepEqual(JSON.parse(body), {
    outbound: {
      origin: "https://api.storekit-sandbox.apple.com",
      pathname: "/inApps/v1/notifications/test",
      method: "POST",
      authorized: true,
    },
    testNotificationToken: "synthetic-notification",
  });
});
