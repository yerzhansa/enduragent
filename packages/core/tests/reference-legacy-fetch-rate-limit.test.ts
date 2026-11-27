import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncMutex } from "../src/concurrency/mutex.js";
import { Cooldown } from "../src/concurrency/cooldown.js";
import { bootstrapReference } from "../src/reference/runtime.js";
import { resetSharedRequestBucketForTests } from "../src/reference/sync/intervals-client-factory.js";
import type { ReferenceSportAdapter } from "../src/reference/sport-adapter.js";
import {
  createRunSync,
  ReferenceRateLimitedError,
  type SyncResult,
} from "../src/reference/sync/run-sync.js";
import type { Sport } from "../src/sport.js";

const CYCLING_ADAPTER: ReferenceSportAdapter = {
  activityTypes: ["Ride", "VirtualRide"],
  zoneBasis: "power",
  decouplingBasis: "power",
  sustainabilityAnchors: [300, 1200, 3600],
  dfaValidated: true,
  anchorType: "ftp",
};
const SPORT = {
  referenceAdapters: () => [CYCLING_ADAPTER],
  intervalsActivityTypes: ["Ride", "VirtualRide"],
} as unknown as Sport;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type ListPath = "/activities" | "/wellness" | "/events";

function intervals(limit: { path: ListPath; times: number; retryAfter: string }) {
  const lists = new Map<ListPath, number>();
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = (["/activities", "/wellness", "/events"] as const).find((candidate) =>
      url.pathname.endsWith(candidate),
    );
    if (path === undefined) return json({ id: "i0", sportSettings: [] });
    const count = (lists.get(path) ?? 0) + 1;
    lists.set(path, count);
    if (path === limit.path && count <= limit.times) {
      return json({ message: "slow down" }, 429, { "retry-after": limit.retryAfter });
    }
    return json([]);
  });
  return { fetch, lists: (path: ListPath) => lists.get(path) ?? 0 };
}

async function startReference(network: ReturnType<typeof intervals>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("1998-09-02T12:00:00.000Z"));
  resetSharedRequestBucketForTests();
  vi.stubGlobal("fetch", network.fetch);
  const dataDir = mkdtempSync(join(tmpdir(), "reference-legacy-rate-limit-"));
  roots.push(dataDir);
  const reference = await bootstrapReference({
    dataDir,
    intervals: { apiKey: "synthetic-intervals-key", athleteId: "0" },
    readCalendarTimeZone: () => "UTC",
    sport: SPORT,
    startScheduler: false,
  });
  return { reference, dataDir };
}

function syncHistoryKinds(dataDir: string): string[] {
  const path = join(dataDir, "data", "sync-history.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

function outcome(result: SyncResult) {
  return {
    kind: result.kind,
    reason: "reason" in result ? result.reason : undefined,
    retryAfterMs: "retryAfterMs" in result ? result.retryAfterMs : undefined,
  };
}

async function runOnce(network: ReturnType<typeof intervals>) {
  const { reference } = await startReference(network);
  return await reference.runScheduledOnce(new AbortController().signal);
}

describe("legacy reference refresh after a 429 from intervals.icu", () => {
  it("runs once when nothing is rate limited", async () => {
    const network = intervals({ path: "/activities", times: 0, retryAfter: "1" });
    const result = await runOnce(network);
    expect(network.lists("/activities")).toBe(1);
    expect(result.kind).toBe("ran");
  });

  it("runs one follow-up after Retry-After when the activities list is rate limited", async () => {
    const network = intervals({ path: "/activities", times: 1, retryAfter: "1" });
    const result = await runOnce(network);
    expect(
      {
        kind: result.kind,
        reason: "reason" in result ? result.reason : undefined,
        activityLists: network.lists("/activities"),
      },
      "legacy refresh after one 429 with Retry-After: 1",
    ).toEqual({ kind: "ran", reason: undefined, activityLists: 2 });
  });

  it("runs one follow-up when the wellness list is rate limited", async () => {
    const network = intervals({ path: "/wellness", times: 1, retryAfter: "1" });
    const result = await runOnce(network);
    expect({ ...outcome(result), wellnessLists: network.lists("/wellness") }).toEqual({
      kind: "ran",
      reason: undefined,
      retryAfterMs: undefined,
      wellnessLists: 2,
    });
  });

  it("stops after one follow-up and reports the rate limit", async () => {
    const network = intervals({ path: "/activities", times: 2, retryAfter: "1" });
    const result = await runOnce(network);
    expect({ ...outcome(result), activityLists: network.lists("/activities") }).toEqual({
      kind: "failed",
      reason: "fetch_failed",
      retryAfterMs: 1_000,
      activityLists: 2,
    });
  });

  it("runs no follow-up when Retry-After is longer than the window can wait", async () => {
    const network = intervals({ path: "/activities", times: 1, retryAfter: "120" });
    const result = await runOnce(network);
    expect({ ...outcome(result), activityLists: network.lists("/activities") }).toEqual({
      kind: "failed",
      reason: "fetch_failed",
      retryAfterMs: 120_000,
      activityLists: 1,
    });
  });

  it("stops waiting for the follow-up when the window is aborted", async () => {
    const network = intervals({ path: "/activities", times: 1, retryAfter: "1" });
    const { reference, dataDir } = await startReference(network);
    const window = new AbortController();
    const run = reference.runScheduledOnce(window.signal);
    await vi.waitFor(() => expect(syncHistoryKinds(dataDir)).toEqual(["failed"]));
    window.abort(new Error("window closed"));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(network.lists("/activities")).toBe(1);
  });
});

describe("runSync result for a failed fetch", () => {
  function runSyncFailingWith(error: Error) {
    const dataDir = mkdtempSync(join(tmpdir(), "reference-run-sync-rate-limit-"));
    roots.push(dataDir);
    return createRunSync({
      dataDir,
      mutex: new AsyncMutex(),
      cooldown: new Cooldown(),
      cooldownWindowMs: 30_000,
      fetchReferenceData: vi.fn().mockRejectedValue(error),
      syncHistory: vi.fn(),
      now: () => new Date("1998-09-02T12:00:00.000Z"),
    });
  }

  it("returns the Retry-After of a rate-limited fetch", async () => {
    const runSync = runSyncFailingWith(
      new ReferenceRateLimitedError("activities.list failed: 429", 7_000),
    );
    await expect(runSync({ caller: "scheduled" })).resolves.toEqual({
      kind: "failed",
      reason: "fetch_failed",
      failures: [{ file: "latest", reason: "activities.list failed: 429" }],
      retryAfterMs: 7_000,
    });
  });

  it("returns no Retry-After for any other fetch failure", async () => {
    const runSync = runSyncFailingWith(new Error("activities.list failed: 500"));
    await expect(runSync({ caller: "scheduled" })).resolves.toEqual({
      kind: "failed",
      reason: "fetch_failed",
      failures: [{ file: "latest", reason: "activities.list failed: 500" }],
    });
  });
});
