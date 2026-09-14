import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import { unstable_dev } from "wrangler";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");

async function providerWorker(outboundService) {
  const result = await build({
    entryPoints: [resolve("scripts/provider-fetch.fixture.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "apple-sdk-error-mapping",
        setup(builder) {
          builder.onResolve({ filter: /^@apple\/app-store-server-library$/ }, () => ({
            path: "apple-sdk-error-mapping",
            namespace: "provider-runtime-test",
          }));
          builder.onLoad({ filter: /.*/, namespace: "provider-runtime-test" }, () => ({
            contents:
              "export class VerificationException extends Error {} export const VerificationStatus = {};",
          }));
        },
      },
    ],
  });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: "2026-08-22",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        APPLE_ENVIRONMENT: "sandbox",
        APPLE_DEVICECHECK_KEY_ID: "synthetic-key",
        APPLE_DEVICECHECK_TEAM_ID: "synthetic-team",
        APPLE_DEVICECHECK_P8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        OPENROUTER_MANAGEMENT_KEY: "synthetic-management",
      },
      outboundService,
    }),
  );
}

function providerResponse(request) {
  const url = new URL(request.url);
  if (url.origin === "https://api.development.devicecheck.apple.com") {
    return Response.json({ bit0: false, bit1: false });
  }
  if (url.origin === "https://openrouter.ai") {
    return Response.json({
      key: "synthetic-key",
      data: {
        hash: "synthetic-hash",
        limit: 2,
        limit_remaining: 2,
        usage: 0,
        disabled: false,
      },
    });
  }
  return new Response("Unexpected test request", { status: 502 });
}

test("provider clients reach expected outbound endpoints in the Workers runtime", async (t) => {
  const requests = [];
  const worker = await providerWorker((request) => {
    const url = new URL(request.url);
    requests.push({
      origin: url.origin,
      pathname: url.pathname,
      method: request.method,
      authorized: request.headers.get("authorization")?.startsWith("Bearer ") === true,
    });
    return providerResponse(request);
  });
  t.after(() => worker.dispose());

  const [deviceCheck, openRouter] = await Promise.all([
    worker.dispatchFetch("http://localhost/devicecheck"),
    worker.dispatchFetch("http://localhost/openrouter"),
  ]);
  assert.deepEqual([deviceCheck.status, openRouter.status], [200, 204]);
  assert.deepEqual(
    requests.sort((left, right) => left.origin.localeCompare(right.origin)),
    [
      {
        origin: "https://api.development.devicecheck.apple.com",
        pathname: "/v1/query_two_bits",
        method: "POST",
        authorized: true,
      },
      {
        origin: "https://openrouter.ai",
        pathname: "/api/v1/keys",
        method: "POST",
        authorized: true,
      },
    ],
  );
});

test("provider clients refuse redirects without requesting the destination", async (t) => {
  let providerRequests = 0;
  let destinationRequests = 0;
  const worker = await providerWorker((request) => {
    const url = new URL(request.url);
    if (url.origin === "https://redirect.invalid") {
      destinationRequests += 1;
      return providerResponse(request);
    }
    providerRequests += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "https://redirect.invalid/provider" },
    });
  });
  t.after(() => worker.dispose());

  const [deviceCheck, openRouter] = await Promise.all([
    worker.dispatchFetch("http://localhost/devicecheck"),
    worker.dispatchFetch("http://localhost/openrouter"),
  ]);
  assert.deepEqual([deviceCheck.status, openRouter.status], [503, 503]);
  assert.deepEqual(await Promise.all([deviceCheck.json(), openRouter.json()]), [
    { error: "unavailable" },
    { error: "unavailable" },
  ]);
  assert.equal(providerRequests, 2);
  assert.equal(destinationRequests, 0);
});

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
