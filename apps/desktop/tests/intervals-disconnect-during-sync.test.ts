import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COACH_RPC_METHOD_REGISTRY, type CoachRpcMethodName } from "@enduragent/coach-contract";
import type { CoachClient } from "@enduragent/coach-client";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { runIntervalsBackfillInWriter } from "../../../packages/coach/src/backfill.js";
import { createCoachOperations } from "../../../packages/coach/src/operations.js";
import type { CoachStoreWriterContext } from "../../../packages/coach/src/runtime.js";
import { createStoreRuntime } from "../../../packages/coach/src/store-runtime.js";
import {
  createConnectionRuntimeAuthority,
  createCredentialRuntimeApplication,
} from "../src/main/credential-runtime.js";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
  type CredentialRuntimeState,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";

const ATHLETE_ID = "synthetic-athlete";
const API_KEY = "synthetic-intervals-key";
const NOW = Date.UTC(1900, 0, 1);
const SCALED_DEADLINE_MS = 300;

const config: Config = {
  dataSource: "store",
  llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
  intervals: { apiKey: API_KEY, athleteId: ATHLETE_ID },
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
  plan: { capture_epoch_ms: NOW, frozenNow: "1900-01-01T00:00:00.000Z", calendar_timezone: "UTC" },
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
const snapshot = {
  schemaVersion: 3 as const,
  llm: { provider: "openai" as const, model: "model-a", credential_configured: true },
  intervals: {
    athlete_id: ATHLETE_ID,
    credential_configured: true,
    managedByEnvironment: { athleteId: false },
  },
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
    managedByEnvironment: {
      historyTokenBudgetRatio: false,
      idleMinutes: false,
      dailyResetHour: false,
      resetArchiveRetentionDays: false,
      timezone: false,
    },
  },
};

interface HeldRequest {
  answer(): void;
}

function heldIntervals() {
  const held: HeldRequest[] = [];
  let arrived: (() => void) | undefined;
  return {
    baseFetch: (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const profile = url.pathname === `/api/v1/athlete/${ATHLETE_ID}`;
      await new Promise<void>((answer, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        held.push({ answer });
        arrived?.();
      });
      const body = profile
        ? {
            sportSettings: [
              { id: 1, athlete_id: ATHLETE_ID, types: ["Ride"], updated: "1900-01-01" },
            ],
          }
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch,
    async nextRequest(): Promise<HeldRequest> {
      while (held.length === 0) {
        await new Promise<void>((resolve) => {
          arrived = resolve;
        });
      }
      return held.shift()!;
    },
  };
}

function encryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value).reverse(), Buffer.from(":END")]),
    decryptString(value) {
      if (
        !value.subarray(0, 5).equals(Buffer.from("SAFE:")) ||
        !value.subarray(-4).equals(Buffer.from(":END"))
      ) {
        throw new TypeError();
      }
      return value.subarray(5, -4).reverse().toString();
    },
  };
}

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("the sync called intervals.icu without the store runtime's fetch");
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function signedInApp() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "intervals-disconnect-"));
  roots.push(root);
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  const store = openSqliteStorage(join(root, "store.db"));
  await runMigrations(store, MIGRATIONS);
  const context: CoachStoreWriterContext = {
    home,
    store,
    listener: {} as CoachStoreWriterContext["listener"],
  };
  const intervals = heldIntervals();
  const runtime = createStoreRuntime({
    env: {},
    config,
    home,
    reference: {
      scheduler: { stop: vi.fn() },
      services: {},
      runScheduledOnce: async () => ({
        kind: "ran",
        lastSyncAt: "1900-01-01T00:00:00.000Z",
        refreshed: [],
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      }),
    } as unknown as ReferenceRuntime,
    dependencies: {
      capture: async () => ({ manifest }),
      refreshCurves: async (options) => ({
        kind: "skipped" as const,
        generationId: "a".repeat(64),
        frozenAt: options.frozenAt.toISOString(),
        physicalRequests: 0,
        decodedBytes: 0,
        failure: "request-budget-exhausted" as const,
      }),
      produce: async () => produced,
      fetch: intervals.baseFetch,
      now: () => new Date(NOW),
      monotonicNow: () => 1,
      openReadonlyStore: () => ({
        get: async () => undefined,
        all: async () => [],
        close: async () => {},
      }),
    },
  });
  const applyRuntimeConfig = vi.fn(async () => {});
  const operations = createCoachOperations(
    {
      home,
      context,
      runtime,
      intervalsCredentials: { read: async () => ({ apiKey: API_KEY, athleteId: ATHLETE_ID }) },
      historyNewestDate: () => new Date(NOW).toISOString().slice(0, 10),
      calendarTimeZone: () => "UTC",
      applyRuntimeConfig,
      readRuntimeConfig: () => snapshot,
    },
    {
      backfill: (options) =>
        runIntervalsBackfillInWriter({
          ...options,
          clock: { now: () => NOW, monotonicNow: () => 1_000 },
          sleep: async () => {},
        }),
      runtimeConfigurationDeadlineMs: SCALED_DEADLINE_MS,
    },
  );
  closers.push(async () => {
    await runtime.close();
    await store.close();
  });

  const dispatch = operations as unknown as Record<
    string,
    (request: unknown, signal?: AbortSignal) => Promise<unknown>
  >;
  const connect = (async () =>
    ({
      handshake: {} as CoachClient["handshake"],
      async call(method: CoachRpcMethodName, request: unknown, options?: { signal?: AbortSignal }) {
        const entry = COACH_RPC_METHOD_REGISTRY[method];
        return entry.responseSchema.parse(
          await dispatch[method]!(entry.requestSchema.parse(request), options?.signal),
        ) as never;
      },
      async close() {},
    }) as CoachClient) as never;
  const authority = createConnectionRuntimeAuthority(
    {
      url: "ws://127.0.0.1:45124/rpc",
      token: "synthetic-daemon-token",
      athleteHome: "/synthetic/athlete",
    },
    connect,
  );
  const credentials = createCredentialRuntimeApplication({
    configureRuntime: authority.configureRuntime,
    clearRuntimeCredential: authority.clearCredential,
    selectedLlmProvider: async () => undefined,
  });
  const vaultRoot = join(
    await mkdtemp(join(await realpath(tmpdir()), "intervals-disconnect-vault-")),
    "credentials-v1",
  );
  roots.push(join(vaultRoot, ".."));
  const runtimeState = new Map<DesktopCredentialSlot, CredentialRuntimeState>();
  const vault = createCredentialVault({
    root: vaultRoot,
    encryption: encryption(),
    runtimeState,
    applyCredential: async () => {},
    clearCredential: (slot) => credentials.clearCredential(slot),
  });
  await expect(
    vault.writeCredential({ slot: "intervals-icu", value: API_KEY }),
  ).resolves.toMatchObject({ slot: "intervals-icu", status: "configured", runtimeReady: true });
  return { operations, intervals, applyRuntimeConfig, vault, runtimeState };
}

async function finishSync(
  app: Awaited<ReturnType<typeof signedInApp>>,
  sync: Promise<unknown>,
  first: HeldRequest,
): Promise<void> {
  const done = sync.then(() => "done" as const);
  first.answer();
  for (;;) {
    const next = await Promise.race([app.intervals.nextRequest(), done]);
    if (next === "done") return;
    next.answer();
  }
}

describe("Disconnect while a sync runs", () => {
  it("control: Disconnect with no sync running revokes and removes the key", async () => {
    const app = await signedInApp();
    const revoke = vi.fn(async () => {});
    await expect(
      app.vault.deleteCredential("intervals-icu", { beforeRemove: revoke }),
    ).resolves.toEqual({ slot: "intervals-icu", status: "deleted", cleanupPending: false });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("Disconnect during a sync stops the sync, then revokes and removes the key inside the deadline", async () => {
    const app = await signedInApp();
    const sync = app.operations.sync({}).then(
      () => "finished" as const,
      () => "stopped" as const,
    );
    await app.intervals.nextRequest();

    const revoke = vi.fn(async () => {});
    const deletion = app.vault.deleteCredential("intervals-icu", { beforeRemove: revoke });
    const settled = await Promise.race([
      deletion.then(() => "settled" as const),
      new Promise<"past the deadline">((resolve) =>
        setTimeout(() => resolve("past the deadline"), SCALED_DEADLINE_MS),
      ),
    ]);

    expect(settled).toBe("settled");
    expect({ result: await deletion, revokes: revoke.mock.calls.length }).toEqual({
      result: { slot: "intervals-icu", status: "deleted", cleanupPending: false },
      revokes: 1,
    });
    expect(await sync).toBe("stopped");
  });

  it("control: Settings reads the runtime config during a sync when no Disconnect is queued", async () => {
    const app = await signedInApp();
    const sync = app.operations.sync({});
    const first = await app.intervals.nextRequest();
    const outcome = await Promise.race([
      app.operations.getRuntimeConfig({}).then(() => "answered" as const),
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    await finishSync(app, sync, first);
    expect(outcome).toBe("answered");
  });

  it("Settings can read the runtime config while a Disconnect waits behind a sync", async () => {
    const app = await signedInApp();
    const sync = app.operations.sync({}).then(
      () => "finished" as const,
      () => "stopped" as const,
    );
    await app.intervals.nextRequest();
    const deletion = app.vault
      .deleteCredential("intervals-icu", { beforeRemove: async () => {} })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const read = app.operations.getRuntimeConfig({}).then(
      () => "answered" as const,
      () => "failed" as const,
    );
    const outcome = await Promise.race([
      read,
      new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    expect(await sync).toBe("stopped");
    await deletion;
    expect(outcome, "getRuntimeConfig while the sync runs").toBe("answered");
  });
});
