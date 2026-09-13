import { expect, it, vi } from "vitest";
import { proofOrigin, redactProof, runProof } from "../scripts/live-proof.js";
it("redacts nested credentials and plaintext keys before evidence", () => {
  expect(
    redactProof(
      {
        key: "sk-or-synthetic",
        nested: {
          signedPayload: "synthetic-jws",
          deviceCheckToken: "synthetic-token",
          message: "Bearer synthetic-secret sk-or-synthetic",
        },
      },
      ["synthetic-secret"],
    ),
  ).toEqual({ key: "sk-or-REDACTED", nested: { message: "REDACTED sk-or-REDACTED" } });
});
it("refuses unsafe origins", () => {
  for (const origin of [
    "http://worker.test",
    "https://user:pass@example.com",
    "https://worker.test/path",
    "https://worker.test/?token=x",
  ])
    expect(() => proofOrigin(origin)).toThrow("invalid proof configuration");
});
it("defaults to validation without network calls", async () => {
  const transport = vi.fn();
  await expect(
    runProof({ WORKER_ORIGIN: "https://worker.test", APPLE_ENVIRONMENT: "sandbox" }, transport),
  ).resolves.toEqual({ mode: "validate", origin: "https://worker.test", environment: "sandbox" });
  expect(transport).not.toHaveBeenCalled();
});
it("refuses redirects without forwarding credentials or retrying a mint", async () => {
  const transport = vi
    .fn()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://other.test" } }),
    );
  await expect(
    runProof(
      {
        PROOF_MODE: "grant",
        WORKER_ORIGIN: "https://worker.test",
        APPLE_ENVIRONMENT: "sandbox",
        ATHLETE_ID: "19980613-0000-4000-8000-000000000001",
        DEVICECHECK_TOKEN: "synthetic-token",
      },
      transport,
    ),
  ).rejects.toThrow("proof request failed");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]![1].redirect).toBe("error");
});

it("redacts returned key fields regardless of the provider prefix", () => {
  expect(redactProof({ key: "test-or-key", keyHash: "synthetic-hash" })).toEqual({
    key: "sk-or-REDACTED",
    keyHash: "synthetic-hash",
  });
});
it("records failed probe cleanup without retaining its key or retrying the mint", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ key: "test-or-key", data: { hash: "synthetic-hash" } }))
    .mockRejectedValue(new Error("Bearer synthetic-secret"));
  const result = await runProof(
    {
      PROOF_MODE: "probe-key",
      WORKER_ORIGIN: "https://worker.test",
      APPLE_ENVIRONMENT: "sandbox",
      OPENROUTER_MANAGEMENT_KEY: "synthetic-secret",
      OPENROUTER_GUARDRAIL_ID: "synthetic-guardrail",
    },
    transport,
  );
  expect(result).toMatchObject({
    cleaned: false,
    proof: { hash: "synthetic-hash", assignmentVerified: false },
  });
  expect(JSON.stringify(result)).not.toContain("test-or-key");
  expect(
    transport.mock.calls.filter(
      ([url, init]) => url === "https://openrouter.ai/api/v1/keys" && init.method === "POST",
    ),
  ).toHaveLength(1);
});
it("read-only inventory paginates and includes disabled keys", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ data: [{ hash: "synthetic-hash", disabled: true, key: "test-or-key" }] }),
    )
    .mockResolvedValueOnce(Response.json({ data: [] }));
  const result = await runProof(
    {
      PROOF_MODE: "inventory",
      WORKER_ORIGIN: "https://worker.test",
      APPLE_ENVIRONMENT: "sandbox",
      OPENROUTER_MANAGEMENT_KEY: "synthetic-secret",
    },
    transport,
  );
  expect(result).toEqual({
    observedKeyCount: 1,
    keys: [{ hash: "synthetic-hash", disabled: true }],
  });
  expect(transport.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
});

import { generateKeyPairSync } from "node:crypto";
function signingInputs() {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    WORKER_ORIGIN: "https://worker.test",
    APPLE_ENVIRONMENT: "sandbox",
    APPLE_DEVICECHECK_P8: key,
    APPLE_DEVICECHECK_KEY_ID: "synthetic-key",
    APPLE_DEVICECHECK_TEAM_ID: "synthetic-team",
    APPLE_APP_STORE_P8: key,
    APPLE_APP_STORE_KEY_ID: "synthetic-key",
    APPLE_APP_STORE_ISSUER_ID: "synthetic-issuer",
    ATHLETE_ID: "19980613-0000-4000-8000-000000000001",
    DISPOSABLE_ATHLETE_CONFIRMED: "19980613-0000-4000-8000-000000000001",
    DEVICECHECK_TOKEN: "synthetic-token",
    OPERATOR_TOKEN: "synthetic-operator",
  };
}
it.each([403, 200])("ban-bit requires an actual 403 refusal, observed %s", async (status) => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ bit0: true, bit1: false }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ error: "banned" }, { status }))
    .mockResolvedValueOnce(Response.json({ bit0: true, bit1: true }))
    .mockResolvedValueOnce(Response.json({ disabled: true }));
  const result = await runProof({ ...signingInputs(), PROOF_MODE: "ban-bit" }, transport);
  expect(result).toMatchObject({ banRequested: true, verified: status === 403 });
  if (status === 403)
    expect(result).toMatchObject({
      grantRefused: true,
      keyDisabled: true,
      after: { bit0: true, bit1: true },
    });
});
it("ban-bit preserves partial evidence after a failed grant contact", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ bit0: false, bit1: false }))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockRejectedValue(new Error("synthetic-secret"));
  expect(await runProof({ ...signingInputs(), PROOF_MODE: "ban-bit" }, transport)).toMatchObject({
    banRequested: true,
    verified: false,
  });
  expect(transport).toHaveBeenCalledTimes(3);
});
it.each([404, 200])(
  "history records safe status %s without unguarded verifier requests",
  async (status) => {
    const transport = vi
      .fn()
      .mockResolvedValue(Response.json({ signedTransactions: ["synthetic-secret"] }, { status }));
    const result = await runProof(
      { ...signingInputs(), PROOF_MODE: "history", ORIGINAL_TRANSACTION_ID: "synthetic-original" },
      transport,
    );
    expect(result).toMatchObject({ historyHttpStatus: status, verified: false });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(transport).toHaveBeenCalledTimes(1);
  },
);
it("at-create probe verifies assignment and cleans up only its own hash", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ key: "test-or-key", data: { hash: "synthetic-probe" } }))
    .mockResolvedValueOnce(Response.json({ data: [{ key_hash: "synthetic-probe" }] }))
    .mockResolvedValueOnce(
      Response.json({ data: { hash: "synthetic-probe", limit: 0, disabled: false } }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  const result = await runProof(
    {
      ...signingInputs(),
      PROOF_MODE: "probe-key",
      PROBE_GUARDRAIL_MODE: "at_create",
      OPENROUTER_MANAGEMENT_KEY: "synthetic-management",
      OPENROUTER_GUARDRAIL_ID: "synthetic-guardrail",
    },
    transport,
  );
  expect(result).toMatchObject({
    cleaned: true,
    proof: { hash: "synthetic-probe", assignmentVerified: true },
  });
  expect(JSON.parse(transport.mock.calls[0]![1].body)).toMatchObject({
    limit: 0,
    guardrail_id: "synthetic-guardrail",
  });
  expect(transport.mock.calls.at(-1)).toEqual([
    "https://openrouter.ai/api/v1/keys/synthetic-probe",
    expect.objectContaining({ method: "DELETE" }),
  ]);
});

it.each(["validate", "probe-key", "inventory", "grant"])(
  "refuses configured ceilings before %s proof activity",
  async (mode) => {
    const transport = vi.fn();
    await expect(
      runProof(
        {
          WORKER_ORIGIN: "https://worker.test",
          APPLE_ENVIRONMENT: "sandbox",
          KEY_COUNT_CEILING: "1",
          PROOF_MODE: mode,
          ATHLETE_ID: "19980613-0000-4000-8000-000000000001",
          DEVICECHECK_TOKEN: "synthetic-token",
          OPENROUTER_MANAGEMENT_KEY: "synthetic-management",
          OPENROUTER_GUARDRAIL_ID: "synthetic-guardrail",
        },
        transport,
      ),
    ).rejects.toThrow("invalid proof configuration");
    expect(transport).not.toHaveBeenCalled();
  },
);
