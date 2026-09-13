import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProof } from "./proof-build.mjs";

test("proof bundle redirects only the pinned verifier fetch import", async () => {
  const result = await buildProof();
  assert.equal(result.verifierImports, 1);
  assert.ok(result.outputFiles[0].text.includes("invalid OCSP destination"));
});

import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer, Agent } from "node:http";
import { connect } from "node:net";
import fetch, { Response } from "node-fetch";
import { generateKeyPairSync } from "node:crypto";
const require = createRequire(import.meta.url);
const fixtures = JSON.parse(
  await readFile(new URL("./proof-fixtures.json", import.meta.url), "utf8"),
);
const wrapper = fileURLToPath(new URL("./proof-ocsp.ts", import.meta.url));
const realFetch = require.resolve("node-fetch");

async function loadBundle(options) {
  const result = await buildProof(options);
  const directory = await mkdtemp(join(tmpdir(), "credits-proof-test-"));
  const output = join(directory, "proof.mjs");
  await writeFile(output, result.outputFiles[0].contents);
  return { module: await import(pathToFileURL(output)), output };
}

function testTransport() {
  return {
    name: "local-test-transport",
    setup(builder) {
      builder.onResolve({ filter: /^proof:test-transport$/ }, () => ({
        path: "transport",
        namespace: "proof-test",
      }));
      builder.onResolve({ filter: /^node-fetch$/ }, (args) =>
        args.importer === wrapper ? { path: "transport", namespace: "proof-test" } : undefined,
      );
      builder.onLoad({ filter: /.*/, namespace: "proof-test" }, () => ({
        contents: `export { Headers } from ${JSON.stringify(realFetch)};
          let transport = () => { throw new Error("unexpected transport"); };
          export function setTransport(next) { transport = next; }
          export default (url, options) => transport(url, options);`,
        resolveDir: resolve(fileURLToPath(new URL(".", import.meta.url))),
      }));
    },
  };
}

const harness = await loadBundle({
  stdin: `export { createProofVerifier, runProof } from "./proof-entry.ts";
    export { runProof as rawProof } from "./live-proof.ts";
    export { ocspTransport } from "./proof-ocsp.ts";
    export { setTransport } from "proof:test-transport";`,
  plugins: [testTransport()],
});

function setOcsp(variant = "good") {
  const requests = [];
  harness.module.setTransport(async (url, options) => {
    requests.push({ url, options });
    const index = url.endsWith("synthetic-leaf") ? 0 : 1;
    let data = Buffer.from(fixtures.ocsp[variant][index], "hex");
    return new Response(data);
  });
  return requests;
}

function verifier() {
  return harness.module.createProofVerifier([Buffer.from(fixtures.root, "base64")]);
}

test("built SDK verifies trusted synthetic JWS with both online OCSP checks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("1998-06-13T00:00:00Z") });
  const requests = setOcsp();
  const transaction = await verifier().verifyAndDecodeTransaction(fixtures.signedTransaction);
  assert.equal(transaction.originalTransactionId, "synthetic-original");
  assert.equal(requests.length, 2);
  for (const { options } of requests) {
    assert.equal(options.redirect, "error");
    assert.equal(options.method, "POST");
    assert.deepEqual([...options.headers], [["content-type", "application/ocsp-request"]]);
  }
});

for (const variant of ["revoked", "stale", "wrongCert", "future", "invalidDate", "missingNext"]) {
  test(`built SDK rejects ${variant} signed OCSP`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("1998-06-13T00:00:00Z") });
    setOcsp(variant);
    await assert.rejects(verifier().verifyAndDecodeTransaction(fixtures.signedTransaction));
  });
}

test("built SDK rejects tampered transaction and tampered OCSP signatures", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("1998-06-13T00:00:00Z") });
  setOcsp();
  const [header, payload, signature] = fixtures.signedTransaction.split(".");
  const changed = Buffer.from(signature, "base64url");
  changed[0] ^= 1;
  await assert.rejects(
    verifier().verifyAndDecodeTransaction(`${header}.${payload}.${changed.toString("base64url")}`),
  );
  harness.module.setTransport(async (url) => {
    const index = url.endsWith("synthetic-leaf") ? 0 : 1;
    const data = Buffer.from(fixtures.ocsp.good[index], "hex");
    data[Math.floor(data.length / 2)] ^= 1;
    return new Response(data);
  });
  await assert.rejects(verifier().verifyAndDecodeTransaction(fixtures.signedTransaction));
});

test("OCSP refuses unapproved destinations and credentials before transport", async () => {
  let calls = 0;
  const guarded = harness.module.ocspTransport(async () => {
    calls += 1;
    return new Response();
  });
  const options = {
    method: "POST",
    headers: { "content-type": "application/ocsp-request" },
    body: Buffer.from("synthetic"),
  };
  for (const url of [
    "https://other.invalid/",
    "http://user@ocsp.apple.com/",
    "http://ocsp.apple.com:8080/",
    "http://ocsp.apple.com/?token=synthetic",
  ]) {
    await assert.rejects(guarded(url, options));
  }
  await assert.rejects(
    guarded("http://ocsp.apple.com/status", {
      ...options,
      headers: { ...options.headers, authorization: "Bearer synthetic" },
    }),
  );
  assert.equal(calls, 0);
});

test("real node-fetch cannot follow an OCSP redirect to another local origin", async (t) => {
  let targetRequests = 0;
  const target = createServer((request, response) => {
    targetRequests += 1;
    response.end("unexpected");
  });
  await new Promise((done) => target.listen(0, "127.0.0.1", done));
  const received = [];
  const origin = createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    response.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` });
    response.end();
  });
  await new Promise((done) => origin.listen(0, "127.0.0.1", done));
  class LocalAgent extends Agent {
    createConnection() {
      return connect({ host: "127.0.0.1", port: origin.address().port });
    }
  }
  const agent = new LocalAgent();
  t.after(async () => {
    agent.destroy();
    await Promise.all([origin, target].map((server) => new Promise((done) => server.close(done))));
  });
  const guarded = harness.module.ocspTransport((url, options) => fetch(url, { ...options, agent }));
  await assert.rejects(
    guarded("http://ocsp.apple.com/synthetic", {
      method: "POST",
      headers: { "content-type": "application/ocsp-request" },
      body: Buffer.from("synthetic"),
    }),
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].authorization, undefined);
  assert.equal(targetRequests, 0);
});

function inputs() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    WORKER_ORIGIN: "https://worker.invalid",
    APPLE_ENVIRONMENT: "sandbox",
    PROOF_MODE: "history",
    ORIGINAL_TRANSACTION_ID: "synthetic-original",
    APPLE_APP_STORE_KEY_ID: "synthetic",
    APPLE_APP_STORE_ISSUER_ID: "synthetic",
    APPLE_APP_STORE_P8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

test("built history verifies every page and emits counts without signed payloads", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("1998-06-13T00:00:00Z") });
  setOcsp();
  const requests = [];
  const result = await harness.module.rawProof(
    inputs(),
    async (url, options) => {
      requests.push({ url, options });
      return globalThis.Response.json({
        signedTransactions: [fixtures.signedTransaction],
        hasMore: requests.length === 1,
        revision: "synthetic-next",
      });
    },
    verifier(),
  );
  assert.deepEqual(result, {
    historyHttpStatus: 200,
    verified: true,
    transactionCount: 2,
    originalTransactionCount: 1,
  });
  assert.match(requests[1].url, /revision=synthetic-next$/);
  assert.equal(requests[0].options.redirect, "error");
  assert.ok(!JSON.stringify(result).includes(fixtures.signedTransaction));
});

test("unbundled helper and 404 never invoke verification", async () => {
  const input = inputs();
  const result = await harness.module.rawProof(input, async () =>
    globalThis.Response.json({ signedTransactions: [fixtures.signedTransaction], hasMore: false }),
  );
  assert.equal(result.verified, false);
  const missing = await harness.module.rawProof(
    input,
    async () => new globalThis.Response(null, { status: 404 }),
    {
      verifyAndDecodeTransaction() {
        throw new Error("unexpected verification");
      },
    },
  );
  assert.deepEqual(missing, { historyHttpStatus: 404, verified: false });
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("actual CLI bundle defaults to validation with no provider inputs", async () => {
  const bundle = await loadBundle();
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [bundle.output], {
    env: { WORKER_ORIGIN: "https://worker.invalid", APPLE_ENVIRONMENT: "sandbox" },
  });
  assert.ok(stderr === "" || /DEP0040.*punycode/.test(stderr));
  const result = JSON.parse(stdout);
  assert.ok(result);
  assert.equal(result.mode, "validate");
});

test("strict built verifier refuses an OCSP redirect response", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("1998-06-13T00:00:00Z") });
  harness.module.setTransport(
    async () =>
      new Response(null, { status: 302, headers: { location: "https://other.invalid/" } }),
  );
  await assert.rejects(verifier().verifyAndDecodeTransaction(fixtures.signedTransaction));
});

for (const variant of ["futureBoundary", "expiryBoundary"]) {
  test(`built SDK preserves 60-second ${variant} allowance`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("1998-06-13T00:00:00Z") });
    setOcsp(variant);
    await verifier().verifyAndDecodeTransaction(fixtures.signedTransaction);
  });
}

test("built proof rejects configured ceilings without provider activity", async () => {
  let requests = 0;
  await assert.rejects(
    harness.module.runProof(
      {
        WORKER_ORIGIN: "https://worker.test",
        APPLE_ENVIRONMENT: "sandbox",
        KEY_COUNT_CEILING: "1",
      },
      async () => {
        requests++;
        throw new Error("unexpected transport");
      },
    ),
    /invalid proof configuration/,
  );
  assert.equal(requests, 0);
});

test("built spend proof preserves missing-key markers and null provider values", async () => {
  const row = {
    athleteId: "19980613-0000-4000-8000-000000000002",
    keyHash: "synthetic-missing",
    orphanedRemoteKey: false,
    missingRemoteKey: true,
    grantedUsdMillis: 3000,
    refundedUsdMillis: 1000,
    remainingUsdMillis: null,
    usageUsdMillis: null,
    creditsRemaining: null,
    disabled: null,
  };
  const result = await harness.module.runProof(
    {
      WORKER_ORIGIN: "https://credits.test",
      APPLE_ENVIRONMENT: "sandbox",
      PROOF_MODE: "spend",
      OPERATOR_TOKEN: "synthetic-operator",
    },
    async () => new Response(JSON.stringify([{ ...row, authorization: "synthetic-private" }])),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [row]);
});
