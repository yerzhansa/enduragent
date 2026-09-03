import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_VERSION_MISMATCH,
  PROTOCOL_VERSION,
  createAcceptedServerHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
  type DaemonOwner,
  type TelegramControlSnapshot,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { acquireWriteLock } from "@enduragent/kernel-node/lock";
import {
  HANDOFF_RESERVED_MESSAGE,
  UNMANAGED_UPGRADE_MESSAGE,
  UPGRADE_SUCCESSOR_FAILED_MESSAGE,
  alreadyServingNotice,
  classifyPeerReadOnly,
  lowerClientMessage,
  observePeerHandshake,
  openAuthenticatedDaemonControl,
  resolveSecondStarter,
  type ResolveSecondStarterDependencies,
} from "../src/daemon/handshake.js";
import { createCoachRpcServer } from "../src/daemon/rpc-server.js";
import type { UpgradeFenceHandle } from "../src/daemon/upgrade-fence.js";
import type { DesktopTelegramController } from "../src/desktop-telegram-controller.js";
import { planCreationOperationStubs } from "./helpers/plan-creation-operation-stubs.js";

const roots: string[] = [];
const disabledTelegramSnapshot: TelegramControlSnapshot = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
};
const disabledTelegram: DesktopTelegramController = {
  getStatus: () => disabledTelegramSnapshot,
  configure: async () => ({ outcome: "applied", current: disabledTelegramSnapshot }),
  enable: async () => disabledTelegramSnapshot,
  disable: async () => disabledTelegramSnapshot,
  replace: async () => ({ outcome: "applied", current: disabledTelegramSnapshot }),
  reconcile: async () => disabledTelegramSnapshot,
  inspectTelegramCredential: async () => ({ status: "invalid-token" }),
  deleteTelegramWebhook: async () => ({ status: "invalid-token" }),
  forgetTelegramCredential: async () => disabledTelegramSnapshot,
  resetTelegramAccess: async () => disabledTelegramSnapshot,
  beginTelegramPairing: async () => disabledTelegramSnapshot,
  cancelTelegramPairing: async () => disabledTelegramSnapshot,
  listTelegramAllowedSenders: async () => ({ senders: [] }),
  addTelegramAllowedSender: async () => ({
    outcome: "applied" as const,
    current: { senders: [] },
  }),
  removeTelegramAllowedSender: async () => ({
    outcome: "applied" as const,
    current: { senders: [] },
  }),
  stopPolling: async () => disabledTelegramSnapshot,
  resumePolling: async () => disabledTelegramSnapshot,
  drainPending: async () => disabledTelegramSnapshot,
  close: async () => disabledTelegramSnapshot,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "daemon-handshake-"));
  roots.push(root);
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}

async function loopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM") {
        process.stderr.write("SKIP_MARKER loopback-listen EPERM daemon-handshake\n");
      }
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => server.close(() => resolve(true)));
  });
}

const hasLoopback = await loopbackAvailable();

it("opens upgrade control against an exact protocol-11 accepted frame", async () => {
  const controlRequests: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];

  class LegacyDaemonSocket extends EventTarget {
    static readonly OPEN = 1;
    readonly readyState = LegacyDaemonSocket.OPEN;

    constructor(_url: string) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(data: string): void {
      const request = JSON.parse(data) as Record<string, unknown>;
      if (request.clientProtocolVersion === 11) {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "handshake",
                status: "accepted",
                clientProtocolVersion: 11,
                serverProtocolVersion: 11,
                owner: "service-managed",
              }),
            }),
          ),
        );
        return;
      }

      const method = request.method;
      expect(method).toMatch(/^daemon\.(reserveUpgrade|shutdownForUpgrade|startInitialRefresh)$/);
      controlRequests.push({ method: String(method), params: request.params });
      const status = method === "daemon.reserveUpgrade" ? "reserved" : "accepted";
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { status },
            }),
          }),
        ),
      );
    }

    close(): void {}
  }

  vi.stubGlobal("WebSocket", LegacyDaemonSocket);
  try {
    const control = await openAuthenticatedDaemonControl({
      port: 45_010,
      token: "token",
      incumbentProtocolVersion: 11,
      expectedOwner: "service-managed",
    });
    expect(control.accepted).toEqual({
      type: "handshake",
      status: "accepted",
      clientProtocolVersion: 11,
      serverProtocolVersion: 11,
      owner: "service-managed",
    });
    const handoff = {
      targetProtocolVersion: PROTOCOL_VERSION,
      handoffCapability: Buffer.alloc(32, 6).toString("base64url"),
    };
    await expect(control.reserveUpgrade(handoff)).resolves.toEqual({ status: "reserved" });
    await expect(control.shutdownForUpgrade(handoff)).resolves.toEqual({ status: "accepted" });
    await expect(control.startInitialRefresh()).resolves.toEqual({ status: "accepted" });
    expect(controlRequests).toEqual([
      { method: "daemon.reserveUpgrade", params: handoff },
      { method: "daemon.shutdownForUpgrade", params: handoff },
      { method: "daemon.startInitialRefresh", params: {} },
    ]);
    await control.close();
    await expect(
      observePeerHandshake({ port: 45_010, token: "token", clientProtocolVersion: 11 }),
    ).rejects.toThrow("daemon handshake failed");
  } finally {
    vi.unstubAllGlobals();
  }
});

describe.skipIf(!hasLoopback)("production peer observations", () => {
  it("classifies writer-clear, healthy, bound-unresponsive, and foreign cases", async () => {
    const clearHome = await home();
    await expect(classifyPeerReadOnly(clearHome)).resolves.toEqual({ status: "writer-clear" });

    const healthyHome = await home();
    const healthy = await acquireWriteLock({
      configDir: healthyHome.configDir,
      athleteHome: healthyHome.root,
      version: "0.1.0",
    });
    expect(healthy.status).toBe("acquired");
    if (healthy.status !== "acquired") return;
    const healthyBinding = await healthy.listener.bind({
      request: (_request, response) => {
        response.end(
          `${JSON.stringify({
            service: "enduragent-store-writer",
            version: "0.1.0",
          })}\n`,
        );
      },
      upgrade: (_request, socket) => socket.destroy(),
    });
    await expect(classifyPeerReadOnly(healthyHome)).resolves.toEqual({
      status: "peer-healthy",
      peer: {
        status: "peer-healthy",
        pid: process.pid,
        port: healthyBinding.port,
        peerVersion: "0.1.0",
      },
    });
    await healthy.release();

    const boundHome = await home();
    const bound = await acquireWriteLock({
      configDir: boundHome.configDir,
      athleteHome: boundHome.root,
      version: "0.1.0",
    });
    expect(bound.status).toBe("acquired");
    if (bound.status !== "acquired") return;
    await expect(classifyPeerReadOnly(boundHome)).resolves.toMatchObject({
      status: "bound-unresponsive",
      stdout: "",
    });
    await bound.release();

    const foreignHome = await home();
    const foreign = await acquireWriteLock({
      configDir: foreignHome.configDir,
      athleteHome: foreignHome.root,
      version: "0.1.0",
    });
    expect(foreign.status).toBe("acquired");
    if (foreign.status !== "acquired") return;
    await foreign.listener.bind({
      request: (_request, response) => response.end("foreign\n"),
      upgrade: (_request, socket) => socket.destroy(),
    });
    await expect(classifyPeerReadOnly(foreignHome)).resolves.toMatchObject({
      status: "foreign-port",
      stdout: "",
    });
    await foreign.release();
  });

  it("observes strict compatible, mismatch, and auth-invalid handshakes", async () => {
    const selectedHome = await home();
    const lock = await acquireWriteLock({
      configDir: selectedHome.configDir,
      athleteHome: selectedHome.root,
      version: "0.1.0",
    });
    expect(lock.status).toBe("acquired");
    if (lock.status !== "acquired") return;
    const token = "x".repeat(43);
    const rpc = createCoachRpcServer({
      token,
      owner: "service-managed",
      athleteHome: selectedHome.root,
      telegram: disabledTelegram,
      selfTestOperations: {
        selfTest: async () => ({
          schemaVersion: 1,
          type: "self-test-terminal",
          ok: false,
          error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
        }),
      },
      operations: {
        ...planCreationOperationStubs,
        importFiles: async ({ paths }) => ({
          schemaVersion: 2,
          files: { total: paths.length, imported: paths.length, quarantined: 0 },
          changes: {
            rawFilesInserted: 0,
            sourceRecordsInserted: 0,
            sourceRecordsUpdated: 0,
            relinkedSourceRecords: 0,
          },
          publication: { scope: "activities-and-streams", status: "available" },
        }),
        sync: async () => ({
          schemaVersion: 1,
          published: false,
          referenceSucceeded: true,
          requests: { store: 0, reference: 0, total: 0 },
          droppedActivities: {
            overall: { total: 0, visible: 0, restrictions: [], other: 0 },
            recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
          },
        }),
        saveIntake: async () => ({ schemaVersion: 1, saved: true }),
        getTranscriptPage: async () => ({
          schemaVersion: 1,
          status: "page",
          turns: [],
          nextCursor: null,
        }),
        listArchivedConversations: async () => ({
          schemaVersion: 1,
          conversations: [],
          truncated: false,
        }),
        deleteArchivedConversation: async () => ({ schemaVersion: 1, status: "deleted" }),
        getArchivedTranscriptPage: async () => ({
          schemaVersion: 1,
          status: "page",
          turns: [],
          nextCursor: null,
        }),
        configureRuntime: async ({ llm, intervals, session }) => ({
          schemaVersion: 3,
          status: "applied",
          applied: {
            llm: llm !== undefined,
            intervals: intervals !== undefined,
            session: session !== undefined,
          },
        }),
        getRuntimeConfig: async () => ({
          schemaVersion: 3,
          llm: {
            provider: "anthropic",
            model: "synthetic-model",
            credential_configured: false,
          },
          intervals: {
            athlete_id: "synthetic-athlete",
            credential_configured: false,
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
        }),
      },
      spend: {
        getSpendSummary: () => Promise.reject(new Error("Spend handler is not used.")),
        setDailySpendCap: () => Promise.reject(new Error("Spend handler is not used.")),
      },
      engine: {
        chat: async () => ({ text: "ok" }),
        getCoachDecision: async () => ({ decision: null }),
        answerCoachDecision: async () => {
          throw new Error("Coach decisions are not used in this test.");
        },
        skipCoachDecision: async () => {
          throw new Error("Coach decisions are not used in this test.");
        },
        resumeCoachDecision: async () => {
          throw new Error("Coach decisions are not used in this test.");
        },
        resetSession: async () => ({ memoryFlushed: true }),
        hasSession: async () => ({ hasSession: false }),
        getAthleteState: async () => ({
          schemaVersion: "3",
          lastUpdated: "2026-01-01T00:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: "2026-01-01T00:00:00.000Z",
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        }),
      },
    });
    const binding = await lock.listener.bind({
      request: (_request, response) => response.end(),
      upgrade: rpc.handleUpgrade,
    });
    await expect(
      observePeerHandshake({
        port: binding.port,
        token,
        clientProtocolVersion: PROTOCOL_VERSION,
      }),
    ).resolves.toMatchObject({ status: "accepted", owner: "service-managed" });
    await expect(
      observePeerHandshake({
        port: binding.port,
        token,
        clientProtocolVersion: PROTOCOL_VERSION + 1,
      }),
    ).resolves.toMatchObject({ status: "version-mismatch", direction: "client-newer" });
    const control = await openAuthenticatedDaemonControl({
      port: binding.port,
      token,
      incumbentProtocolVersion: PROTOCOL_VERSION,
      expectedOwner: "service-managed",
    });
    await expect(
      control.reserveUpgrade({
        targetProtocolVersion: PROTOCOL_VERSION + 1,
        handoffCapability: Buffer.alloc(32, 6).toString("base64url"),
      }),
    ).resolves.toEqual({ status: "reserved" });
    await control.close();
    await expect(
      observePeerHandshake({
        port: binding.port,
        token: "wrong",
        clientProtocolVersion: PROTOCOL_VERSION,
      }),
    ).rejects.toThrow("daemon handshake failed");
    await rpc.close();
    await binding.close();
    await lock.release();
  });
});

function resolverHarness(owner: DaemonOwner, clientVersion: number, serverVersion: number) {
  const selectedHome: AthleteHome = {
    root: "/synthetic",
    storeDir: "/synthetic/store",
    archiveDir: "/synthetic/archive",
    configDir: "/synthetic/config",
  };
  const peer = { status: "peer-healthy", pid: 7, port: 41_001, peerVersion: "old" } as const;
  const publishedPeer = {
    status: "peer-healthy",
    pid: 8,
    port: 41_002,
    peerVersion: "new",
  } as const;
  const rendererCapability = Buffer.alloc(32, 2).toString("base64url");
  const acceptedBinding = {
    athleteHome: selectedHome.root,
    rendererCapability,
  } as const;
  const handshake =
    clientVersion === serverVersion
      ? createAcceptedServerHandshakeFrame(owner, clientVersion, acceptedBinding, serverVersion)
      : createVersionMismatchServerHandshakeFrame(owner, clientVersion, serverVersion);
  const publishedHandshake = createAcceptedServerHandshakeFrame(
    owner,
    clientVersion,
    acceptedBinding,
    clientVersion,
  );
  const fence: UpgradeFenceHandle = {
    socketPath: "/synthetic/config/upgrade.sock",
    handoffCapability: Buffer.alloc(32, 1).toString("base64url"),
    release: vi.fn(async () => {}),
  };
  const serviceUpgrade = {
    isInstalled: vi.fn(async () => true),
    restartInstalledService: vi.fn(async () => {}),
    kickstartInstalledServiceAfterEphemeral: vi.fn(async () => {}),
    startEphemeralSuccessor: vi.fn(async () => {}),
  };
  const control = {
    port: peer.port,
    accepted:
      serverVersion === 11
        ? {
            type: "handshake" as const,
            status: "accepted" as const,
            clientProtocolVersion: 11 as const,
            serverProtocolVersion: 11 as const,
            owner,
          }
        : createAcceptedServerHandshakeFrame(
            owner,
            PROTOCOL_VERSION,
            acceptedBinding,
            PROTOCOL_VERSION,
          ),
    reserveUpgrade: vi.fn(async () => ({ status: "reserved" as const })),
    shutdownForUpgrade: vi.fn(async () => ({ status: "accepted" as const })),
    startInitialRefresh: vi.fn(async () => ({ status: "accepted" as const })),
    close: vi.fn(async () => {}),
  };
  const acquireFence = vi.fn<ResolveSecondStarterDependencies["acquireUpgradeFence"]>(async () => ({
    status: "acquired",
    handle: fence,
  }));
  const dependencies = {
    observePeerHandshake: vi.fn(async () => handshake),
    openUpgradeControl: vi.fn(async () => control),
    classifyPeerReadOnly: vi.fn(async () => ({ status: "peer-healthy" as const, peer })),
    acquireUpgradeFence: acquireFence,
    serviceUpgrade,
    timer: { nowMs: () => 100, schedule: () => ({ cancel() {} }) },
    waitForWriterRelease: vi.fn(async () => ({ status: "released" as const })),
    waitForCompatiblePeer: vi.fn(async () => ({
      status: "published" as const,
      peer: publishedPeer,
      handshake: publishedHandshake,
    })),
  } satisfies ResolveSecondStarterDependencies;
  return {
    selectedHome,
    peer,
    publishedPeer,
    handshake,
    dependencies,
    fence,
    control,
    serviceUpgrade,
  };
}

describe("second starter resolution", () => {
  it("defers daemon starters and attaches client races for compatible peers", async () => {
    for (const caller of ["serve", "service", "cli-auto-start", "local"] as const) {
      const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION);
      const result = await resolveSecondStarter(
        {
          caller,
          home: test.selectedHome,
          clientProtocolVersion: PROTOCOL_VERSION,
          clientAppVersion: "new",
          bearerToken: "token",
          peer: test.peer,
        },
        test.dependencies,
      );
      if (caller === "serve" || caller === "service") {
        expect(result).toEqual({
          status: "defer",
          exitCode: 0,
          stdout: "",
          stderr: alreadyServingNotice(test.peer.port),
        });
      } else {
        expect(result).toMatchObject({ status: "attach", port: test.peer.port });
      }
      expect(test.dependencies.acquireUpgradeFence).not.toHaveBeenCalled();
    }
  });

  it("refuses a compatible daemon bound to a different athlete home", async () => {
    const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION);
    test.dependencies.observePeerHandshake.mockResolvedValue(
      createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION, {
        athleteHome: "/different-athlete",
        rendererCapability: Buffer.alloc(32, 5).toString("base64url"),
      }),
    );
    const result = await resolveSecondStarter(
      {
        caller: "desktop",
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: test.peer,
      },
      test.dependencies,
    );
    expect(result).toMatchObject({ status: "refuse" });
  });

  it("returns exit 5 for a lower client and never restarts downward", async () => {
    const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION + 1);
    const result = await resolveSecondStarter(
      {
        caller: "cli-auto-start",
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "old",
        bearerToken: "token",
        peer: test.peer,
      },
      test.dependencies,
    );
    expect(result).toEqual({
      status: "refuse",
      exitCode: EXIT_VERSION_MISMATCH,
      stdout: "",
      stderr: lowerClientMessage(PROTOCOL_VERSION, PROTOCOL_VERSION + 1),
    });
    expect(test.dependencies.acquireUpgradeFence).not.toHaveBeenCalled();
    expect(test.serviceUpgrade.restartInstalledService).not.toHaveBeenCalled();
  });

  it("refuses an authenticated unmanaged owner with exit 3 and zero takeover", async () => {
    const test = resolverHarness("unmanaged-foreground", PROTOCOL_VERSION, PROTOCOL_VERSION - 1);
    const result = await resolveSecondStarter(
      {
        caller: "local",
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: test.peer,
      },
      test.dependencies,
    );
    expect(result).toEqual({
      status: "refuse",
      exitCode: 3,
      stdout: "",
      stderr: UNMANAGED_UPGRADE_MESSAGE,
    });
    expect(test.dependencies.acquireUpgradeFence).not.toHaveBeenCalled();
  });

  it("performs one fenced upward restart and attaches to the new port", async () => {
    const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION - 1);
    const result = await resolveSecondStarter(
      {
        caller: "cli-auto-start",
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: test.peer,
      },
      test.dependencies,
    );
    expect(result).toMatchObject({ status: "attach", port: test.publishedPeer.port });
    expect(test.control.reserveUpgrade).toHaveBeenCalledTimes(1);
    expect(test.control.shutdownForUpgrade).toHaveBeenCalledTimes(1);
    expect(test.serviceUpgrade.restartInstalledService).toHaveBeenCalledTimes(1);
    expect(test.fence.release).toHaveBeenCalledTimes(1);
  });

  it("abandons handoff when the authenticated incumbent keeps changing", async () => {
    const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION - 1);
    test.dependencies.observePeerHandshake
      .mockReset()
      .mockResolvedValueOnce(test.handshake)
      .mockResolvedValueOnce(
        createVersionMismatchServerHandshakeFrame(
          "app-supervised",
          PROTOCOL_VERSION,
          PROTOCOL_VERSION - 1,
        ),
      )
      .mockResolvedValueOnce(
        createVersionMismatchServerHandshakeFrame(
          "ephemeral-client-started",
          PROTOCOL_VERSION,
          PROTOCOL_VERSION - 1,
        ),
      )
      .mockResolvedValue(
        createVersionMismatchServerHandshakeFrame(
          "app-supervised",
          PROTOCOL_VERSION,
          PROTOCOL_VERSION - 1,
        ),
      );
    const result = await resolveSecondStarter(
      {
        caller: "desktop",
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: test.peer,
      },
      test.dependencies,
    );
    expect(result).toMatchObject({ status: "refuse" });
    expect(test.dependencies.openUpgradeControl).not.toHaveBeenCalled();
    expect(test.fence.release).toHaveBeenCalledTimes(2);
  });

  it("refuses a successor published for a different athlete home", async () => {
    const test = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION - 1);
    test.dependencies.waitForCompatiblePeer.mockResolvedValue({
      status: "published",
      peer: test.publishedPeer,
      handshake: createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION, {
        athleteHome: "/different-athlete",
        rendererCapability: Buffer.alloc(32, 4).toString("base64url"),
      }),
    });
    const result = await resolveSecondStarter(
      {
        caller: "cli-auto-start",
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: test.peer,
      },
      test.dependencies,
    );
    expect(result).toMatchObject({ status: "refuse", stderr: UPGRADE_SUCCESSOR_FAILED_MESSAGE });
    expect(test.fence.release).toHaveBeenCalledTimes(1);
  });

  it("returns the fence to a designated ephemeral daemon starter", async () => {
    const test = resolverHarness(
      "ephemeral-client-started",
      PROTOCOL_VERSION,
      PROTOCOL_VERSION - 1,
    );
    test.serviceUpgrade.isInstalled.mockResolvedValue(false);
    const result = await resolveSecondStarter(
      {
        caller: "serve",
        home: test.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: test.peer,
      },
      test.dependencies,
    );
    expect(result).toMatchObject({
      status: "become-successor",
      handoffCapability: test.fence.handoffCapability,
    });
    expect(test.fence.release).not.toHaveBeenCalled();
  });

  it("maps a live fence and successor failure to their exact terminal diagnostics", async () => {
    const reserved = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION - 1);
    reserved.dependencies.acquireUpgradeFence.mockResolvedValue({
      status: "reserved",
      exitCode: 3,
      message: HANDOFF_RESERVED_MESSAGE,
    });
    const reservedResult = await resolveSecondStarter(
      {
        caller: "serve",
        home: reserved.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: reserved.peer,
      },
      reserved.dependencies,
    );
    expect(reservedResult).toMatchObject({ stderr: HANDOFF_RESERVED_MESSAGE });

    const failed = resolverHarness("service-managed", PROTOCOL_VERSION, PROTOCOL_VERSION - 1);
    failed.serviceUpgrade.restartInstalledService.mockRejectedValue(new Error("secret"));
    const failedResult = await resolveSecondStarter(
      {
        caller: "service",
        home: failed.selectedHome,
        clientProtocolVersion: PROTOCOL_VERSION,
        clientAppVersion: "new",
        bearerToken: "token",
        peer: failed.peer,
      },
      failed.dependencies,
    );
    expect(failedResult).toMatchObject({ stderr: UPGRADE_SUCCESSOR_FAILED_MESSAGE });
  });
});
