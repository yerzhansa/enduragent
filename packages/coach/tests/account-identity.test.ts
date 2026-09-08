import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncStateRepository, dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  assertRuntimeAthleteOwner,
  assertRuntimeAthleteOwnerFromEvidence,
  checkIntervalsStoreOwnerAtPath,
  verifyIntervalsCredentialAtPath,
  verifyIntervalsCredentialAtPathWithEvidence,
} from "../src/account-identity.js";
import { runIntervalsBackfill, runIntervalsBackfillInWriter } from "../src/backfill.js";

const complete = JSON.stringify({
  v: 1,
  cycle: 0,
  window_start: "2010-12-05",
  window_end: "2010-12-31",
  last_key: null,
  complete: true,
});
const clock = { now: () => 1_300_000_000_000, monotonicNow: () => 1_000 };

describe("account identity", () => {
  type BackfillRequest = Readonly<{
    endpoint: "profile" | "activities";
    url: URL;
  }>;
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  async function fresh() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-page-"));
    roots.push(root);
    const store = openSqliteStorage(join(root, "store.db"));
    await runMigrations(store, MIGRATIONS);
    const node = createNodeImportRuntime({ archiveDir: join(root, "archive"), store });
    return { root, store, node };
  }
  function profileFetch(
    account: string,
    requests: BackfillRequest[] = [],
    athleteId = "0",
  ): typeof globalThis.fetch {
    return vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const profilePath = `/api/v1/athlete/${encodeURIComponent(athleteId)}`;
      let body: unknown;
      if (url.pathname === profilePath) {
        requests.push({ endpoint: "profile", url });
        body = {
          sportSettings: [{ id: 1, athlete_id: account, types: ["Ride"], updated: "2010-01-01" }],
        };
      } else if (url.pathname === `${profilePath}/activities`) {
        requests.push({ endpoint: "activities", url });
        body = [];
      } else {
        throw new Error("unexpected request");
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  function unresolvedProfileFetch(requests: BackfillRequest[] = []): typeof globalThis.fetch {
    return vi.fn(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      let body: unknown;
      if (url.pathname === "/api/v1/athlete/0") {
        requests.push({ endpoint: "profile", url });
        body = { sportSettings: [] };
      } else if (url.pathname === "/api/v1/athlete/0/activities") {
        requests.push({ endpoint: "activities", url });
        body = [];
      } else {
        throw new Error("unexpected request");
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  function athleteHome(root: string, storeDir = root): AthleteHome {
    return {
      root,
      storeDir,
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
  }

  async function syncInWriter(
    value: Awaited<ReturnType<typeof fresh>>,
    account: string,
    apiKey = "synthetic",
  ) {
    const baseFetch = profileFetch(account);
    const result = await runIntervalsBackfillInWriter({
      home: athleteHome(value.root),
      store: value.store,
      apiKey,
      athleteId: "0",
      historyNewestDate: "1900-12-31",
      calendarTimeZone: "UTC",
      clock,
      sleep: async () => {},
      baseFetch,
    });
    return { baseFetch, result };
  }

  async function syncInWriterWithFetch(
    value: Awaited<ReturnType<typeof fresh>>,
    accountKey: string,
    baseFetch: typeof globalThis.fetch,
  ) {
    const result = await runIntervalsBackfillInWriter({
      home: athleteHome(value.root),
      store: value.store,
      apiKey: accountKey,
      athleteId: "0",
      historyNewestDate: "1900-12-31",
      calendarTimeZone: "UTC",
      clock,
      sleep: async () => {},
      baseFetch,
    });
    return { baseFetch, result };
  }

  async function storedSyncState(store: Awaited<ReturnType<typeof fresh>>["store"]) {
    return {
      dump: await dumpStore(store),
      owner: await store.all("SELECT * FROM store_owner"),
      watermarks: await store.all("SELECT * FROM source_watermark"),
      operations: await store.all("SELECT * FROM sync_operation"),
    };
  }

  it("claims the owner when the first sync creates the store and detects a different credential afterward", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-first-sync-"));
    roots.push(root);
    const storePath = join(root, "store", "store.db");
    const firstFetch = profileFetch("synthetic-athlete-first");
    expect(existsSync(storePath)).toBe(false);

    await runIntervalsBackfill({
      env: { ENDURAGENT_HOME: root },
      apiKey: "synthetic-first",
      athleteId: "0",
      historyNewestDate: "1900-12-31",
      calendarTimeZone: "UTC",
      clock,
      sleep: async () => {},
      baseFetch: firstFetch,
    });

    expect(existsSync(storePath)).toBe(true);
    const store = openSqliteStorage(storePath);
    try {
      expect(await store.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 1 });
    } finally {
      await store.close();
    }
    expect(firstFetch).toHaveBeenCalledTimes(2);
    const mismatchFetch = profileFetch("synthetic-athlete-other");
    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-other",
        athleteId: "0",
        historyNewestDate: "1900-12-31",
        clock,
        sleep: async () => {},
        baseFetch: mismatchFetch,
      }),
    ).resolves.toBe("mismatch");
    expect(mismatchFetch).toHaveBeenCalledOnce();
  });

  it("defers an ownerless current-account claim until the matching candidate is accepted", async () => {
    const value = await fresh();
    const fingerprint = "a".repeat(64);
    const resolveFingerprint = vi.fn(
      async (options: { readonly apiKey: string; readonly athleteId: string }) => {
        if (options.apiKey !== "current-key") expect(options.apiKey).toBe("candidate-key");
        expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
          count: 0,
        });
        return fingerprint;
      },
    );
    try {
      const pendingClaim = await assertRuntimeAthleteOwner(
        value.store,
        {
          current: {
            apiKey: "current-key",
            athleteId: "current-athlete",
            historyNewestDate: "1900-12-31",
            clock,
          },
          candidate: {
            apiKey: "candidate-key",
            athleteId: "candidate-athlete",
            historyNewestDate: "1900-12-31",
            clock,
          },
          signal: new AbortController().signal,
        },
        resolveFingerprint,
      );

      expect(resolveFingerprint.mock.calls.map(([options]) => options.athleteId)).toEqual([
        "current-athlete",
        "candidate-athlete",
      ]);
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
      await pendingClaim?.claim();
      expect(await value.store.get("SELECT account_fingerprint FROM store_owner")).toEqual({
        account_fingerprint: fingerprint,
      });
    } finally {
      await value.store.close();
    }
  });

  it("skips current-account lookup when the store already has an owner", async () => {
    const value = await fresh();
    const fingerprint = "a".repeat(64);
    await value.store.run(
      "INSERT INTO store_owner (singleton, account_fingerprint) VALUES (1, ?)",
      [fingerprint],
    );
    const resolveFingerprint = vi.fn(async () => fingerprint);
    try {
      await assertRuntimeAthleteOwner(
        value.store,
        {
          current: {
            apiKey: "",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          candidate: {
            apiKey: "candidate-key",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          signal: new AbortController().signal,
        },
        resolveFingerprint,
      );

      expect(resolveFingerprint).toHaveBeenCalledOnce();
      expect(resolveFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "candidate-key", athleteId: "0" }),
      );
    } finally {
      await value.store.close();
    }
  });

  it("defers and claims a resolved first credential when no current account exists", async () => {
    const value = await fresh();
    const fingerprint = "a".repeat(64);
    const resolveFingerprint = vi.fn(async () => fingerprint);
    try {
      const pendingClaim = await assertRuntimeAthleteOwner(
        value.store,
        {
          current: {
            apiKey: "",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          candidate: {
            apiKey: "candidate-key",
            athleteId: "0",
            historyNewestDate: "1900-12-31",
            clock,
          },
          signal: new AbortController().signal,
          claimUnownedCandidateWithoutCurrent: true,
        },
        resolveFingerprint,
      );

      expect(resolveFingerprint).toHaveBeenCalledOnce();
      expect(resolveFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "candidate-key", athleteId: "0" }),
      );
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
      await pendingClaim?.claim();
      expect(await value.store.get("SELECT account_fingerprint FROM store_owner")).toEqual({
        account_fingerprint: fingerprint,
      });
    } finally {
      await value.store.close();
    }
  });

  it.each(["null", "rejection", "abort"] as const)(
    "does not bind a first credential after candidate %s",
    async (failure) => {
      const value = await fresh();
      const controller = new AbortController();
      const resolveFingerprint = vi.fn(async () => {
        if (failure === "null") return null;
        if (failure === "rejection") throw new Error("synthetic candidate lookup failure");
        controller.abort(new Error("synthetic admission close"));
        return "a".repeat(64);
      });
      try {
        await expect(
          assertRuntimeAthleteOwner(
            value.store,
            {
              current: {
                apiKey: "",
                athleteId: "0",
                historyNewestDate: "1900-12-31",
                clock,
              },
              candidate: {
                apiKey: "candidate-key",
                athleteId: "0",
                historyNewestDate: "1900-12-31",
                clock,
              },
              signal: controller.signal,
              claimUnownedCandidateWithoutCurrent: true,
            },
            resolveFingerprint,
          ),
        ).rejects.toMatchObject({
          reason: "candidate-unresolved",
          transient: failure !== "null",
        });
        expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
          count: 0,
        });
      } finally {
        await value.store.close();
      }
    },
  );

  it("refuses an unowned athlete change without a current credential", async () => {
    const value = await fresh();
    const resolveFingerprint = vi.fn(async () => "a".repeat(64));
    try {
      await expect(
        assertRuntimeAthleteOwner(
          value.store,
          {
            current: {
              apiKey: "",
              athleteId: "0",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "current-credential-missing" });
      expect(resolveFingerprint).not.toHaveBeenCalled();
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
    } finally {
      await value.store.close();
    }
  });

  it("aborts a bounded owner lookup before claiming the store", async () => {
    const value = await fresh();
    const resolveFingerprint = vi.fn(
      async (options: { readonly signal?: AbortSignal }): Promise<string> =>
        await new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    try {
      await expect(
        assertRuntimeAthleteOwner(
          value.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock: { now: clock.now, monotonicNow: () => performance.now() },
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock: { now: clock.now, monotonicNow: () => performance.now() },
            },
            signal: new AbortController().signal,
            timeoutMs: 5,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "current-unresolved" });
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
    } finally {
      await value.store.close();
    }
  });

  it("distinguishes unresolved current and candidate ownership", async () => {
    const currentUnresolved = await fresh();
    try {
      await expect(
        assertRuntimeAthleteOwner(
          currentUnresolved.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          async () => null,
        ),
      ).rejects.toMatchObject({ reason: "current-unresolved" });
      expect(
        await currentUnresolved.store.get("SELECT count(*) AS count FROM store_owner"),
      ).toEqual({
        count: 0,
      });
    } finally {
      await currentUnresolved.store.close();
    }

    const candidateUnresolved = await fresh();
    const fingerprint = "a".repeat(64);
    const resolveFingerprint = vi
      .fn()
      .mockResolvedValueOnce(fingerprint)
      .mockRejectedValueOnce(new Error("synthetic candidate lookup failure"));
    try {
      await expect(
        assertRuntimeAthleteOwner(
          candidateUnresolved.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "candidate-unresolved" });
      expect(
        await candidateUnresolved.store.get("SELECT count(*) AS count FROM store_owner"),
      ).toEqual({
        count: 0,
      });
    } finally {
      await candidateUnresolved.store.close();
    }
  });

  it("refuses a candidate whose resolved owner differs from the current owner", async () => {
    const value = await fresh();
    const currentFingerprint = "a".repeat(64);
    const candidateFingerprint = "b".repeat(64);
    const resolveFingerprint = vi
      .fn()
      .mockResolvedValueOnce(currentFingerprint)
      .mockResolvedValueOnce(candidateFingerprint);
    try {
      await expect(
        assertRuntimeAthleteOwner(
          value.store,
          {
            current: {
              apiKey: "current-key",
              athleteId: "current-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            candidate: {
              apiKey: "candidate-key",
              athleteId: "candidate-athlete",
              historyNewestDate: "1900-12-31",
              clock,
            },
            signal: new AbortController().signal,
          },
          resolveFingerprint,
        ),
      ).rejects.toMatchObject({ reason: "mismatch" });
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
    } finally {
      await value.store.close();
    }
  });

  it("claims an upgraded store without re-walking or changing its existing history", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-upgrade-"));
    roots.push(root);
    const home = athleteHome(root, join(root, "store"));
    mkdirSync(home.storeDir, { recursive: true, mode: 0o700 });
    const storePath = join(home.storeDir, "store.db");
    const legacy = openSqliteStorage(storePath);
    await runMigrations(legacy, MIGRATIONS.slice(0, 7));
    await legacy.run(
      "INSERT INTO workout(workout_key,start_utc,is_multisport,dedup_cluster_id) VALUES(?,?,0,?)",
      ["synthetic-workout", 1_262_304_000, "synthetic-cluster"],
    );
    await legacy.run(
      "INSERT INTO session(session_key,workout_key,session_seq,sport,start_utc,local_date_key,is_transition) VALUES(?,?,0,?,?,?,0)",
      ["synthetic-session", "synthetic-workout", "cycling", 1_262_304_000, 20100101],
    );
    await legacy.transaction(async () => {
      await createSyncStateRepository(legacy).recordCompletionInTransaction({
        source: "intervals-icu",
        lane: "bulk-fit",
        watermarkBefore: null,
        watermarkAfter: complete,
        artifactsSeen: 0,
        sourceChanges: 0,
      });
    });
    const beforeWorkouts = await legacy.all("SELECT * FROM workout ORDER BY workout_key");
    const beforeSessions = await legacy.all("SELECT * FROM session ORDER BY session_key");
    await legacy.close();
    const baseFetch = profileFetch("synthetic-athlete-upgrade");

    await runIntervalsBackfill({
      env: { ENDURAGENT_HOME: root },
      apiKey: "synthetic-upgrade",
      athleteId: "0",
      historyNewestDate: "2010-12-31",
      calendarTimeZone: "UTC",
      clock,
      sleep: async () => {},
      baseFetch,
    });

    expect(baseFetch).toHaveBeenCalledOnce();
    const upgraded = openSqliteStorage(storePath);
    try {
      expect(await upgraded.get("PRAGMA user_version")).toEqual({ user_version: 32 });
      expect(await upgraded.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 1 });
      expect(await upgraded.all("SELECT * FROM workout ORDER BY workout_key")).toEqual(
        beforeWorkouts,
      );
      expect(await upgraded.all("SELECT * FROM session ORDER BY session_key")).toEqual(
        beforeSessions,
      );
      expect(
        await upgraded.get("SELECT count(*) AS count FROM analytics_curve_generation"),
      ).toEqual({ count: 0 });
    } finally {
      await upgraded.close();
    }
    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-other",
        athleteId: "0",
        historyNewestDate: "2010-12-31",
        clock,
        sleep: async () => {},
        baseFetch: profileFetch("synthetic-athlete-other"),
      }),
    ).resolves.toBe("mismatch");
  });

  it("refuses a different athlete before writing any sync state or training data", async () => {
    const value = await fresh();
    try {
      await syncInWriter(value, "synthetic-athlete-owner", "synthetic-owner");
      const before = await storedSyncState(value.store);
      const mismatchRequests: BackfillRequest[] = [];
      const mismatchFetch = profileFetch("synthetic-athlete-other", mismatchRequests);

      await expect(syncInWriterWithFetch(value, "synthetic-other", mismatchFetch)).rejects.toThrow(
        "training account mismatch",
      );

      expect(mismatchRequests.filter(({ endpoint }) => endpoint === "profile")).toHaveLength(1);
      expect(mismatchRequests.filter(({ endpoint }) => endpoint === "activities")).toHaveLength(0);
      expect(await storedSyncState(value.store)).toEqual(before);
    } finally {
      await value.store.close();
    }
  });

  it("continues sync when profile sport settings cannot resolve an owner", async () => {
    const value = await fresh();
    const requests: BackfillRequest[] = [];
    const baseFetch = unresolvedProfileFetch(requests);
    try {
      const sync = await syncInWriterWithFetch(value, "synthetic-unresolved", baseFetch);

      expect(sync.result).toMatchObject({ pages: 2, artifacts: 0, reports: [] });
      expect(requests.map(({ endpoint }) => endpoint)).toEqual(["profile", "activities"]);
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
    } finally {
      await value.store.close();
    }
  });

  it("syncs the same athlete normally without re-walking completed history", async () => {
    const value = await fresh();
    try {
      const first = await syncInWriter(value, "synthetic-athlete-owner");
      const repeat = await syncInWriter(value, "synthetic-athlete-owner");

      expect(repeat.result).toMatchObject({ pages: 2, artifacts: 0, reports: [] });
      expect(first.baseFetch).toHaveBeenCalledTimes(2);
      expect(repeat.baseFetch).toHaveBeenCalledOnce();
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 1,
      });
    } finally {
      await value.store.close();
    }
  });

  it("keeps an ownerless store unclaimed during the save-time convenience check", async () => {
    const value = await fresh();
    const storePath = join(value.root, "store.db");
    await value.store.close();
    const baseFetch = profileFetch("synthetic-athlete-ownerless");

    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-ownerless",
        athleteId: "0",
        historyNewestDate: "1900-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
      }),
    ).resolves.toBe("unowned");
    expect(baseFetch).not.toHaveBeenCalled();

    const reopened = openSqliteStorage(storePath);
    try {
      expect(await reopened.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 0 });
    } finally {
      await reopened.close();
    }
  });

  it("skips identity resolution when the save-time store is unavailable", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-save-check-"));
    roots.push(root);
    const storePath = join(root, "missing", "store.db");
    const baseFetch = profileFetch("synthetic-athlete-resolved");

    await expect(
      checkIntervalsStoreOwnerAtPath(storePath, {
        apiKey: "synthetic-resolved",
        athleteId: "0",
        historyNewestDate: "1900-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
      }),
    ).resolves.toBe("store-unavailable");
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("allows save when an owned store identity cannot be resolved", async () => {
    const value = await fresh();
    try {
      await syncInWriter(value, "synthetic-athlete-owner");
      const baseFetch = unresolvedProfileFetch();
      await expect(
        checkIntervalsStoreOwnerAtPath(join(value.root, "store.db"), {
          apiKey: "synthetic-unresolved",
          athleteId: "0",
          historyNewestDate: "1900-12-31",
          clock,
          sleep: async () => {},
          baseFetch,
        }),
      ).resolves.toBe("unresolved");
      expect(baseFetch).toHaveBeenCalledOnce();
    } finally {
      await value.store.close();
    }
  });

  it("accepts a rotated credential for the same athlete at save time and sync time", async () => {
    const value = await fresh();
    try {
      await syncInWriter(value, "synthetic-athlete-owner", "synthetic-old");
      const saveFetch = profileFetch("synthetic-athlete-owner");
      await expect(
        checkIntervalsStoreOwnerAtPath(join(value.root, "store.db"), {
          apiKey: "synthetic-new",
          athleteId: "0",
          historyNewestDate: "1900-12-31",
          clock,
          sleep: async () => {},
          baseFetch: saveFetch,
        }),
      ).resolves.toBe("matched");
      const sync = await syncInWriter(value, "synthetic-athlete-owner", "synthetic-new");
      expect(sync.result).toMatchObject({ pages: 2, artifacts: 0 });
      expect(saveFetch).toHaveBeenCalledOnce();
      expect(sync.baseFetch).toHaveBeenCalledOnce();
    } finally {
      await value.store.close();
    }
  });

  it("returns verified fingerprint evidence with the observed owner state", async () => {
    const compareOwner = vi.fn(async () => "matched" as const);
    const result = await verifyIntervalsCredentialAtPathWithEvidence("synthetic-store", {
      apiKey: "synthetic-key",
      athleteId: "0",
      historyNewestDate: "1900-12-31",
      clock,
      signal: new AbortController().signal,
      sleep: async () => {},
      baseFetch: profileFetch("synthetic-athlete"),
      compareOwner,
    });

    expect(result).toEqual({
      status: "verified",
      evidence: {
        verifiedFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        ownerState: {
          status: "owned",
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
    if (result.status !== "verified" || result.evidence.ownerState.status !== "owned") {
      throw new Error("expected owned verification evidence");
    }
    expect(result.evidence.ownerState.fingerprint).toBe(result.evidence.verifiedFingerprint);
    expect(compareOwner).toHaveBeenCalledWith(
      "synthetic-store",
      result.evidence.verifiedFingerprint,
    );
  });

  it.each([
    {
      reason: "credential-rejected" as const,
      options: () => ({
        baseFetch: vi.fn(async () => new Response(null, { status: 401 })),
      }),
    },
    {
      reason: "malformed-athlete-response" as const,
      options: () => ({
        baseFetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ sportSettings: "invalid" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      }),
    },
    {
      reason: "validation-timeout" as const,
      options: () => ({
        baseFetch: vi.fn(async () => await new Promise<Response>(() => {})),
        overallTimeoutMs: 5,
      }),
    },
    {
      reason: "validation-aborted" as const,
      options: () => {
        const controller = new AbortController();
        controller.abort(new Error("synthetic shutdown"));
        return { signal: controller.signal };
      },
    },
    {
      reason: "validation-unavailable" as const,
      options: () => ({
        baseFetch: vi.fn(async () => {
          throw new Error("synthetic transport failure");
        }),
      }),
    },
    {
      reason: "training-account-mismatch" as const,
      options: () => ({
        baseFetch: profileFetch("synthetic-athlete"),
        compareOwner: vi.fn(async () => "mismatch" as const),
      }),
    },
    {
      reason: "owner-unresolved" as const,
      options: () => ({ baseFetch: unresolvedProfileFetch() }),
    },
    {
      reason: "store-unavailable" as const,
      options: () => ({
        baseFetch: profileFetch("synthetic-athlete"),
        compareOwner: vi.fn(async () => "store-unavailable" as const),
      }),
    },
  ])("keeps $reason refusal parity in the evidence verifier", async ({ reason, options }) => {
    const run = async (verify: typeof verifyIntervalsCredentialAtPath) => {
      const selected = options();
      return await verify("synthetic-store", {
        apiKey: "synthetic-key",
        athleteId: "0",
        historyNewestDate: "1900-12-31",
        clock,
        signal: new AbortController().signal,
        sleep: async () => {},
        compareOwner: async () => "matched",
        ...selected,
      });
    };

    const expected = { status: "refused", reason } as const;
    await expect(run(verifyIntervalsCredentialAtPath)).resolves.toEqual(expected);
    await expect(run(verifyIntervalsCredentialAtPathWithEvidence)).resolves.toEqual(expected);
  });

  it("compares and claims verified evidence locally without fetching", async () => {
    const value = await fresh();
    const baseFetch = vi.fn();
    vi.stubGlobal("fetch", baseFetch);
    const fingerprint = "a".repeat(64);
    const signal = new AbortController().signal;
    try {
      const claim = await assertRuntimeAthleteOwnerFromEvidence(
        value.store,
        {
          verifiedFingerprint: fingerprint,
          ownerState: { status: "unowned" },
        },
        signal,
      );

      expect(baseFetch).not.toHaveBeenCalled();
      expect(await value.store.get("SELECT count(*) AS count FROM store_owner")).toEqual({
        count: 0,
      });
      await claim?.claim();
      expect(await value.store.get("SELECT account_fingerprint FROM store_owner")).toEqual({
        account_fingerprint: fingerprint,
      });
      await expect(
        assertRuntimeAthleteOwnerFromEvidence(
          value.store,
          {
            verifiedFingerprint: fingerprint,
            ownerState: { status: "owned", fingerprint },
          },
          signal,
        ),
      ).resolves.toBeUndefined();
      expect(baseFetch).not.toHaveBeenCalled();
    } finally {
      await value.store.close();
    }
  });
});
