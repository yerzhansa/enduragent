import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COACH_RPC_METHOD_REGISTRY,
  type CoachRpcMethodName,
  type ConfigureRuntimeRpcResult,
} from "@enduragent/coach-contract";
import type { CoachClient } from "@enduragent/coach-client";
import { bundledAcceptedCatalog, type Config } from "@enduragent/core";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createLocalCoachComposition,
  type LocalCoachComposition,
} from "../../../packages/coach/src/composition.js";
import {
  assertRuntimeAthleteOwner,
  resolveIntervalsStoreOwnerFingerprint,
} from "../../../packages/coach/src/account-identity.js";
import {
  createConnectionRuntimeAuthority,
  createCredentialRuntimeApplication,
  readSelectedLlmProvider,
} from "../src/main/credential-runtime.js";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
  type CredentialRuntimeState,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import { createIntervalsSignInRetry } from "../src/main/intervals-sign-in-retry.js";
import { createTrainingSyncCoordinator } from "../../desktop-renderer/src/training-sync";
import { toManualSyncViewState } from "../../desktop-renderer/src/training-context/manual-sync";
import type { DesktopCoachClient } from "../../desktop-renderer/src/coach-client";

const STORED_KEY = "synthetic-stored-intervals-key";
const NOT_IN_USE_COPY =
  "Intervals.icu isn’t connected right now, so nothing was synced. Enduragent will try again when your network is back.";
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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

function network() {
  let online = false;
  let requestsWhileOnline = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    if (!online) throw new TypeError("fetch failed");
    requestsWhileOnline += 1;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname !== "/api/v1/athlete/0") {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
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
  return {
    fetch,
    isOnline: () => online,
    goOnline() {
      online = true;
    },
    requestsWhileOnline: () => requestsWhileOnline,
  };
}

async function startCoach(baseFetch: typeof globalThis.fetch): Promise<LocalCoachComposition> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "intervals-offline-launch-"));
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
          resolveIntervalsStoreOwnerFingerprint({ ...lookup, baseFetch }),
        ),
    },
  );
  closers.push(async () => {
    await composition.close();
    await store.close();
  });
  return composition;
}

function inProcessClient(
  composition: LocalCoachComposition,
  observed: { configureRuntime: ConfigureRuntimeRpcResult[] },
): CoachClient {
  const operations = composition.operations as unknown as Record<
    string,
    (request: unknown, signal?: AbortSignal) => Promise<unknown>
  >;
  return {
    handshake: {} as CoachClient["handshake"],
    async call(method: CoachRpcMethodName, request: unknown, options?: { signal?: AbortSignal }) {
      const entry = COACH_RPC_METHOD_REGISTRY[method];
      const parsed = entry.requestSchema.parse(request);
      const result = entry.responseSchema.parse(await operations[method]!(parsed, options?.signal));
      if (method === "configureRuntime") {
        observed.configureRuntime.push(result as ConfigureRuntimeRpcResult);
      }
      return result as never;
    },
    async close() {},
  } as CoachClient;
}

async function launch() {
  const net = network();
  const coach = await startCoach(net.fetch);
  const observed = { configureRuntime: [] as ConfigureRuntimeRpcResult[] };
  const authority = createConnectionRuntimeAuthority(
    {
      url: "ws://127.0.0.1:45123/rpc",
      token: "synthetic-daemon-token",
      athleteHome: "/synthetic/athlete",
    },
    (async () => inProcessClient(coach, observed)) as never,
  );
  const credentials = createCredentialRuntimeApplication({
    configureRuntime: authority.configureRuntime,
    clearRuntimeCredential: authority.clearCredential,
    selectedLlmProvider: async (storedCredentialSlots) =>
      readSelectedLlmProvider(await authority.getRuntimeConfig(), {
        chatGptProfilePresent: false,
        storedCredentialSlots,
      }),
  });
  const vaultRoot = join(
    await mkdtemp(join(await realpath(tmpdir()), "intervals-offline-vault-")),
    "credentials-v1",
  );
  roots.push(join(vaultRoot, ".."));
  const runtimeState = new Map<DesktopCredentialSlot, CredentialRuntimeState>();
  const vault = createCredentialVault({
    root: vaultRoot,
    encryption: encryption(),
    runtimeState,
    applyCredential: async () => {
      throw new TypeError("not used: the key was stored in an earlier session");
    },
    reapplyCredential(slot, value, stored) {
      return signInRetry.observe(slot, () =>
        credentials.reapplyStoredCredential(slot, value, stored),
      );
    },
    clearCredential: (slot) => credentials.clearCredential(slot),
  });
  const shutdown = new AbortController();
  const signInRetry = createIntervalsSignInRetry(
    {
      vault,
      net,
      powerMonitor: new EventEmitter(),
      delaysMs: [50, 50, 50],
      offlineRecheckMs: 20,
    },
    shutdown.signal,
  );
  closers.push(async () => shutdown.abort());
  await expect(
    vault.writeCredential({ slot: "intervals-icu", value: STORED_KEY }, { activate: false }),
  ).resolves.toMatchObject({ slot: "intervals-icu", status: "configured" });
  const intervalsStatus = async () =>
    (await vault.credentialStatuses()).find((entry) => entry.slot === "intervals-icu");
  return { net, coach, observed, vault, intervalsStatus };
}

describe("intervals.icu sign-in after a launch without network", () => {
  it("retries the refused stored key by itself once the network returns", async () => {
    const app = await launch();

    await app.vault.reapplyConfigured();
    await app.coach.startInitialRefresh();

    expect(app.observed.configureRuntime).toEqual([
      { schemaVersion: 3, status: "refused", reason: "ownership-unavailable" },
    ]);
    expect(await app.intervalsStatus()).toEqual({
      slot: "intervals-icu",
      state: "configured",
      runtimeState: "failed",
    });

    app.net.goOnline();
    await vi.waitFor(
      async () => expect((await app.intervalsStatus())?.runtimeState).toBe("active"),
      { timeout: 5_000, interval: 20 },
    );

    expect({
      configureRuntimeCalls: app.observed.configureRuntime.length,
      lastConfigureRuntime: app.observed.configureRuntime.at(-1)?.status,
      coachHasKey: (await app.coach.operations.getRuntimeConfig({})).intervals
        .credential_configured,
    }).toEqual({
      configureRuntimeCalls: 2,
      lastConfigureRuntime: "applied",
      coachHasKey: true,
    });
    expect(app.net.requestsWhileOnline()).toBeGreaterThan(0);
  });

  it("control: a manual Retry saved keys after the network returns does activate the key", async () => {
    const app = await launch();
    await app.vault.reapplyConfigured();
    await app.coach.startInitialRefresh();
    expect((await app.intervalsStatus())?.runtimeState).toBe("failed");

    app.net.goOnline();
    await app.vault.retryFailed();

    expect(app.observed.configureRuntime.at(-1)).toMatchObject({ status: "applied" });
    expect((await app.intervalsStatus())?.runtimeState).toBe("active");
    expect((await app.coach.operations.getRuntimeConfig({})).intervals).toMatchObject({
      credential_configured: true,
    });
    expect(app.net.requestsWhileOnline()).toBeGreaterThan(0);
  });

  it("Sync does not report success while the stored key is not active in the coach", async () => {
    const app = await launch();
    await app.vault.reapplyConfigured();
    await app.coach.startInitialRefresh();
    const status = await app.intervalsStatus();
    expect(status?.runtimeState).toBe("failed");

    const operations = app.coach.operations;
    const client: DesktopCoachClient = {
      handshake: {} as DesktopCoachClient["handshake"],
      async call(method, request, options) {
        if (method !== "sync") throw new TypeError(`unexpected ${method}`);
        const requestId = 7;
        const result = COACH_RPC_METHOD_REGISTRY.sync.responseSchema.parse(
          await operations.sync(request as never, (event) =>
            options?.onNotificationEnvelope?.({
              jsonrpc: "2.0",
              method: "coach.operationProgress",
              params: { requestId, requestMethod: "sync", event },
            } as never),
          ),
        );
        options?.onTerminalEnvelope?.({ jsonrpc: "2.0", id: requestId, result } as never);
        return result as never;
      },
    };
    const coordinator = createTrainingSyncCoordinator({
      clients: {
        getClient: async () => client,
        reconnect: async () => client,
        close: async () => {},
        onConnectionOpen: () => () => {},
      },
      refreshTrainingContext: async () => {},
      intervalsSignInSaved: () => status?.state === "configured",
    });
    await coordinator.request();

    expect(coordinator.getState()).toMatchObject({
      status: "failed",
      kind: "not-in-use",
      retryable: true,
    });
    const shown = toManualSyncViewState(coordinator.getState());
    expect({ label: shown.label, tone: shown.tone, message: shown.message }).toEqual({
      label: "Try again",
      tone: "failure",
      message: NOT_IN_USE_COPY,
    });
    coordinator.dispose();
  });
});
