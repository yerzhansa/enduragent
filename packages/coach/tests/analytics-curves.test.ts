import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPhysicalRequestLedger,
  runMigrations,
  type SyncBudget,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAnalyticsCurveRefresh } from "../src/analytics-curves.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("desktop analytics curve composition", () => {
  it("uses the active writer, authenticated transport, private archive, and shared ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "analytics-curve-composition-"));
    roots.push(root);
    const home = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    await mkdir(home.archiveDir, { recursive: true });
    const store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    const writerContext: CoachStoreWriterContext = {
      home,
      store,
      listener: {} as CoachStoreWriterContext["listener"],
    };
    const ledger = createPhysicalRequestLedger({
      storeLimit: 64,
      legacyLimit: 15,
      totalLimit: 79,
    });
    const controller = new AbortController();
    let monotonicMs = 1_000;
    const budget: SyncBudget = {
      signal: controller.signal,
      clock: { monotonicNow: () => monotonicMs },
      deadlineMonotonicMs: 601_000,
      perRequestTimeoutMs: 30_000,
      maxRequests: 64,
      maxArtifacts: 1_000,
    };
    const requests: string[] = [];
    const baseFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toMatch(/^Basic /);
      expect(authorization).not.toContain("synthetic-secret");
      return new Response(JSON.stringify({ activities: {}, list: [] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });

    try {
      const outcome = await runAnalyticsCurveRefresh(
        {
          env: {},
          writerContext,
          apiKey: "synthetic-secret",
          athleteId: "i0",
          frozenAt: new Date("2012-06-15T12:00:00.000Z"),
          frozenOn: "2012-06-15",
          budget,
          attemptLedger: ledger,
          baseFetch,
        },
        {
          sleep: async (ms, signal) => {
            signal.throwIfAborted();
            monotonicMs += ms;
          },
        },
      );

      expect(outcome).toMatchObject({
        kind: "promoted",
        frozenAt: "2012-06-15T12:00:00.000Z",
        physicalRequests: 4,
      });
      expect(requests).toHaveLength(4);
      expect(ledger.snapshot()).toMatchObject({
        storeRequests: 4,
        totalRequests: 4,
        byTag: { "store:analytics-curves": 4 },
      });
      await expect(
        store.get("SELECT generation_id FROM analytics_curve_current WHERE singleton = 1"),
      ).resolves.toEqual({ generation_id: outcome.generationId });
      await expect(
        store.get("SELECT count(*) AS count FROM analytics_curve_evidence"),
      ).resolves.toEqual({ count: 4 });
    } finally {
      await store.close();
    }
  });

  it("rejects an invalid frozen instant before opening a writer", async () => {
    await expect(
      runAnalyticsCurveRefresh({
        env: {},
        apiKey: "synthetic-secret",
        athleteId: "i0",
        frozenAt: new Date(Number.NaN),
        frozenOn: "2012-06-15",
        budget: {} as SyncBudget,
        attemptLedger: {} as never,
      }),
    ).rejects.toThrow("analytics curve frozen instant is invalid");
  });

  it("rejects an invalid capture civil date before opening a writer", async () => {
    await expect(
      runAnalyticsCurveRefresh({
        env: {},
        apiKey: "synthetic-secret",
        athleteId: "i0",
        frozenAt: new Date("2012-06-15T12:00:00.000Z"),
        frozenOn: "2012-02-30",
        budget: {} as SyncBudget,
        attemptLedger: {} as never,
      }),
    ).rejects.toThrow("invalid analytics curve input");
  });
});
