import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledAcceptedCatalog, type Config } from "@enduragent/core";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { encodeIntervalsOAuthCredential } from "../../core/src/intervals-credential.js";
import { createLocalCoachComposition } from "../src/composition.js";
import {
  assertRuntimeAthleteOwner,
  resolveIntervalsStoreOwnerFingerprint,
} from "../src/account-identity.js";

const HEALTHY = encodeIntervalsOAuthCredential("fixture-healthy-in-use");
const REPLACEMENT = encodeIntervalsOAuthCredential("fixture-revoked-replacement");

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const intervals: typeof globalThis.fetch = async (_input, init) => {
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  if (authorization.includes("fixture-revoked-replacement")) {
    return new Response(JSON.stringify({ status: 401 }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      sportSettings: [
        { id: 1, athlete_id: "synthetic-owner", types: ["Ride"], updated: "1998-01-01" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

async function startCoach() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "refused-replacement-keeps-sign-in-"));
  roots.push(root);
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(home.configDir, { recursive: true });
  await mkdir(home.storeDir, { recursive: true });
  const store = openSqliteStorage(join(home.storeDir, "store.db"));
  await runMigrations(store, MIGRATIONS);
  const config: Config = {
    dataSource: "store",
    llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
    intervals: { apiKey: "", athleteId: "" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1000,
    dataDir: root,
  };
  const catalog = bundledAcceptedCatalog();
  const composition = await createLocalCoachComposition(
    {
      env: { ENDURAGENT_HOME: root },
      home,
      context: { home, store, listener: inertWriterProtocolListener },
      config,
      catalog,
      readCatalog: () => catalog,
      deferInitialRefresh: true,
    },
    {
      bootstrap: async () => ({
        scheduler: { stop() {} },
        async runScheduledOnce() {
          return { kind: "skipped", reason: "cooldown" } as never;
        },
      }),
      createBackend: () =>
        ({
          chat: async () => ({ text: "ok" }),
          getCoachDecision: async () => ({ decision: null }),
          resetSession: async () => ({ memoryFlushed: true }),
          hasSession: async () => ({ hasSession: false }),
        }) as never,
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => ({
        resolve: async () => ({ kind: "missing", refusal: "missing-cycling-ftp-anchor" }) as never,
      }),
      assertRuntimeAthleteOwner: (ownerStore, options) =>
        assertRuntimeAthleteOwner(ownerStore, options, (lookup) =>
          resolveIntervalsStoreOwnerFingerprint({ ...lookup, baseFetch: intervals }),
        ),
    },
  );
  closers.push(async () => {
    await composition.close();
    await store.close();
  });
  return composition.operations;
}

describe("a replacement intervals.icu sign-in that intervals.icu rejects", () => {
  it("keeps the healthy sign-in in use reported as not rejected", async () => {
    const operations = await startCoach();
    await expect(
      operations.configureRuntime({ intervals: { api_key: HEALTHY } }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(operations.getRuntimeConfig({})).resolves.not.toHaveProperty(
      "intervals.credential_rejected",
    );

    await expect(
      operations.configureRuntime({ intervals: { api_key: REPLACEMENT } }),
    ).resolves.toMatchObject({ status: "refused", reason: "ownership-unavailable" });

    const after = await operations.getRuntimeConfig({});
    expect(
      after.intervals.credential_rejected ?? false,
      "credential_rejected while the healthy sign-in is still the one in use",
    ).toBe(false);
  });
});
