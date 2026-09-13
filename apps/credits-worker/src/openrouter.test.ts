import { afterEach, expect, it, vi } from "vitest";
import { asUsdMillis, type KeyHash } from "./domain.js";
import { OpenRouterManagementClient } from "./openrouter.js";

const hash = "synthetic-hash" as KeyHash;
const config = {
  guardrailMode: "off",
  guardrailId: undefined,
  keyCountCeiling: undefined,
} as const;
const view = { hash, limit: 2, limit_remaining: 1.125, usage: 0.875, disabled: false };
afterEach(() => vi.unstubAllGlobals());

it("setLimit sends absolute limit", async () => {
  const transport = vi.fn().mockResolvedValue(Response.json({ data: view }));
  vi.stubGlobal("fetch", transport);
  await new OpenRouterManagementClient("synthetic-management", config).setLimit(
    hash,
    asUsdMillis(2500),
  );
  expect(transport).toHaveBeenCalledWith(
    "https://openrouter.ai/api/v1/keys/synthetic-hash",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ limit: 2.5 }) }),
  );
});

it("after_create posts assignment before returning a key", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ key: "test-or-key", data: view }))
    .mockResolvedValueOnce(Response.json({ assigned_count: 1 }));
  vi.stubGlobal("fetch", transport);
  const client = new OpenRouterManagementClient("synthetic-management", config);
  await expect(
    client.create({
      name: "synthetic",
      limitUsdMillis: asUsdMillis(2000),
      guardrailMode: "after_create",
      guardrailId: "guardrail",
    }),
  ).resolves.toEqual({ key: "test-or-key", hash });
  expect(transport.mock.calls[1]).toEqual([
    "https://openrouter.ai/api/v1/guardrails/guardrail/assignments/keys",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ key_hashes: [hash] }) }),
  ]);
});

it.each([1, 100, 0, -1, NaN])(
  "rejects configured ceiling %s before provider activity",
  (ceiling) => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    expect(
      () =>
        new OpenRouterManagementClient("synthetic-management", {
          ...config,
          keyCountCeiling: ceiling,
        }),
    ).toThrow("unavailable");
    expect(transport).not.toHaveBeenCalled();
  },
);

it("unset ceiling creates without an inventory check", async () => {
  const transport = vi.fn().mockResolvedValue(Response.json({ key: "test-or-key", data: view }));
  vi.stubGlobal("fetch", transport);
  await expect(
    new OpenRouterManagementClient("synthetic-management", config).create({
      name: "synthetic",
      limitUsdMillis: asUsdMillis(2000),
      ...config,
    }),
  ).resolves.toEqual({ key: "test-or-key", hash });
  expect(transport).toHaveBeenCalledExactlyOnceWith(
    "https://openrouter.ai/api/v1/keys",
    expect.objectContaining({ method: "POST" }),
  );
});

it("at_create refuses an unverified guardrail assignment and cleans up its key", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ key: "test-or-key", data: view }))
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValue(Response.json({ data: view }));
  vi.stubGlobal("fetch", transport);
  const client = new OpenRouterManagementClient("synthetic-management", config);
  await expect(
    client.create({
      name: "synthetic",
      limitUsdMillis: asUsdMillis(2000),
      guardrailMode: "at_create",
      guardrailId: "guardrail",
    }),
  ).rejects.toThrow("unavailable");
  expect(transport.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(true);
});
it("validates fractional USD and refuses unlimited balances", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: view }))
    .mockResolvedValueOnce(Response.json({ data: { ...view, limit: null } }));
  vi.stubGlobal("fetch", transport);
  const client = new OpenRouterManagementClient("synthetic-management", config);
  await expect(client.get(hash)).resolves.toMatchObject({
    remainingUsdMillis: 1125,
    usageUsdMillis: 875,
  });
  await expect(client.get(hash)).rejects.toThrow("unavailable");
});
it("paginates disabled key inventory and sanitizes provider failures", async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [view] }))
    .mockResolvedValueOnce(Response.json({ data: [{ ...view, hash: "second", disabled: true }] }))
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(new Response("synthetic-provider-secret", { status: 500 }));
  vi.stubGlobal("fetch", transport);
  const client = new OpenRouterManagementClient("synthetic-management", config);
  expect(await client.count()).toBe(2);
  expect(transport.mock.calls[1]![0]).toContain("include_disabled=true&offset=1");
  await expect(client.delete(hash)).rejects.toThrow("unavailable");
});
