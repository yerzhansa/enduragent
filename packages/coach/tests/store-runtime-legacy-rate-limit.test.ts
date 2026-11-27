import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapReference, type Config, type Sport } from "@enduragent/core";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreRuntime, type StoreRuntime } from "../src/store-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config: Config = {
  dataSource: "store",
  llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
  intervals: { apiKey: "synthetic", athleteId: "0" },
  telegram: { botToken: "" },
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  contextWindowTokens: 1000,
  dataDir: "unused",
};
const manifest = {
  capture_id: "12345678-1234-4123-8123-123456789abc",
  plan: {
    capture_epoch_ms: Date.parse("1998-09-02T12:00:00.000Z"),
    frozenNow: "1998-09-02T12:00:00.000Z",
    calendar_timezone: "UTC",
  },
} as ReferenceCaptureManifest;
const produced: ProducedLocalBundle = {
  captureId: manifest.capture_id,
  captureClock: {
    captureEpochMs: manifest.plan.capture_epoch_ms,
    civilDateTime: manifest.plan.frozenNow,
    calendarTimeZone: "UTC",
  },
  bundle: { activities: [], wellness: [], ftpHistory: [], athlete: { sportSettings: [] } },
};
const SPORT = {
  referenceAdapters: () => [
    {
      activityTypes: ["Ride", "VirtualRide"],
      zoneBasis: "power",
      decouplingBasis: "power",
      sustainabilityAnchors: [300, 1200, 3600],
      dfaValidated: true,
      anchorType: "ftp",
    },
  ],
  intervalsActivityTypes: ["Ride", "VirtualRide"],
} as unknown as Sport;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function intervalsLimitingActivitiesOnce(retryAfter: string) {
  let activityLists = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/activities")) {
        activityLists += 1;
        if (activityLists === 1) {
          return json({ message: "slow down" }, 429, { "retry-after": retryAfter });
        }
        return json([]);
      }
      if (url.pathname.endsWith("/wellness") || url.pathname.endsWith("/events")) return json([]);
      return json({ id: "i0", sportSettings: [] });
    }),
  );
  return { activityLists: () => activityLists };
}

async function startRuntime(): Promise<StoreRuntime> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("1998-09-02T12:00:00.000Z"));
  const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-legacy-429-"));
  roots.push(root);
  let runtime: StoreRuntime | undefined;
  const reference = await bootstrapReference({
    dataDir: root,
    intervals: config.intervals,
    readCalendarTimeZone: () => "UTC",
    sport: SPORT,
    startScheduler: false,
    attemptLedgerForRun: () => {
      if (runtime === undefined) throw new Error("Store runtime has not started.");
      return runtime.attemptLedgerForRun();
    },
  });
  runtime = createStoreRuntime({
    env: {},
    config,
    home: {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    },
    reference,
    dependencies: {
      capture: async (options) => {
        options.attemptLedger?.charge("store", "store:settings");
        return { manifest };
      },
      refreshCurves: async (options) => ({
        kind: "skipped",
        generationId: "a".repeat(64),
        frozenAt: options.frozenAt.toISOString(),
        physicalRequests: 0,
        decodedBytes: 0,
        failure: "request-budget-exhausted",
      }),
      produce: async () => produced,
      now: () => new Date("1998-09-02T12:00:00.000Z"),
      monotonicNow: () => 1,
    },
  });
  return runtime;
}

describe("sync window when intervals.icu rate-limits the legacy reference refresh", () => {
  it("finishes with the reference refreshed after one follow-up", async () => {
    const network = intervalsLimitingActivitiesOnce("1");
    const runtime = await startRuntime();
    const window = await runtime.runWindow();
    await runtime.close();
    expect({
      published: window.published,
      legacySucceeded: window.legacySucceeded,
      legacyRequests: window.counts.legacyRequests,
      activityLists: network.activityLists(),
    }).toEqual({ published: true, legacySucceeded: true, legacyRequests: 6, activityLists: 2 });
  });

  it("reports the refresh as failed when Retry-After is longer than the window waits", async () => {
    const network = intervalsLimitingActivitiesOnce("120");
    const runtime = await startRuntime();
    const window = await runtime.runWindow();
    await runtime.close();
    expect({
      published: window.published,
      legacySucceeded: window.legacySucceeded,
      legacyRequests: window.counts.legacyRequests,
      activityLists: network.activityLists(),
    }).toEqual({ published: true, legacySucceeded: false, legacyRequests: 2, activityLists: 1 });
  });
});
