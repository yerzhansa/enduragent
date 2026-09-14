import assert from "node:assert/strict";
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
