import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoachClientTransportUnavailableError,
  CoachRpcRemoteError,
} from "@enduragent/coach-client";
import type {
  ConfigureRuntimeRpcParams,
  LlmProvider,
  RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyExplicitCredentialToRuntime,
  createActiveIntervalsCredentialPreflight,
  createConnectionRuntimeAuthority,
  createCredentialRuntimeApplication,
  intervalsAthleteIdForOwnership,
  readSelectedLlmProvider,
  runtimeConfigurationForCredentialDeletion,
  type CredentialRuntimeApplication,
} from "../src/main/credential-runtime.js";
import {
  CredentialRuntimeRefusal,
  createCredentialVault,
  type CredentialEncryptionPort,
  type CredentialVault,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import {
  DESKTOP_CREDENTIAL_STATUS_CHANNEL,
  registerOnboardingIpc,
  runtimeConfigurationForCredential,
} from "../src/main/onboarding-ipc.js";

const roots: string[] = [];
const VERIFICATION_APPROVAL = "c".repeat(64);

function encryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  };
}

function runtimeSnapshot(
  provider: LlmProvider,
  model = "custom-selected-model",
  credentialConfigured = false,
  athleteId = "custom-athlete",
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider, model, credential_configured: credentialConfigured },
    intervals: {
      athlete_id: athleteId,
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
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeDaemon(initialProvider: LlmProvider) {
  let persistedProvider = initialProvider;
  let activeProvider = initialProvider;
  let persistedModel = "custom-selected-model";
  let activeModel = persistedModel;
  let intervalsApplications = 0;
  const modelApplications: LlmProvider[] = [];

  return {
    launch(): CredentialRuntimeApplication {
      activeProvider = persistedProvider;
      activeModel = persistedModel;
      return createCredentialRuntimeApplication({
        selectedLlmProvider: async () => persistedProvider,
        async configureRuntime(request: ConfigureRuntimeRpcParams) {
          if (request.llm !== undefined) {
            activeProvider = request.llm.provider ?? activeProvider;
            persistedProvider = activeProvider;
            activeModel = request.llm.model ?? activeModel;
            persistedModel = activeModel;
            modelApplications.push(activeProvider);
          }
          if (request.intervals !== undefined) intervalsApplications += 1;
        },
      });
    },
    activeProvider: () => activeProvider,
    persistedProvider: () => persistedProvider,
    activeModel: () => activeModel,
    intervalsApplications: () => intervalsApplications,
    modelApplications: () => [...modelApplications],
    clearModelApplications: () => modelApplications.splice(0),
  };
}

function fakeVault(initialRuntime: CredentialRuntimeApplication) {
  const slots = new Set<DesktopCredentialSlot>();
  let runtime = initialRuntime;
  const port: CredentialVault = {
    async writeCredential(input) {
      slots.add(input.slot);
      await runtime.applyExplicit(
        runtimeConfigurationForCredential(input.slot, randomUUID(), input.selection),
      );
      return { slot: input.slot, status: "configured", runtimeReady: true };
    },
    async runExclusiveMutation(operation) {
      return operation({
        writeCredential: (input, behavior) => port.writeCredential(input, behavior),
        credentialStatuses: () => port.credentialStatuses(),
      });
    },
    async applyLlmSelection() {
      return { status: "configured", runtimeReady: true };
    },
    async credentialStatuses() {
      return [...slots].map((slot) => ({
        slot,
        state: "configured" as const,
        runtimeState: "stored-inactive" as const,
      }));
    },
    async deleteCredential(slot) {
      slots.delete(slot);
      return { slot, status: "deleted", cleanupPending: false };
    },
    async reapplyConfigured() {
      for (const slot of slots) {
        await runtime.reapplyStoredCredential(slot, randomUUID(), [...slots]);
      }
    },
    async retryFailed() {},
  };

  return {
    port,
    use(nextRuntime: CredentialRuntimeApplication) {
      runtime = nextRuntime;
    },
  };
}

async function pollCredentialStatuses(vault: CredentialVault): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const checkIntervalsCredentialOwner: Parameters<
    typeof registerOnboardingIpc
  >[0]["checkIntervalsCredentialOwner"] = vi.fn(async () => "unresolved" as const);
  const dispose = registerOnboardingIpc({
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
    } as never,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    window: {} as never,
    vault,
    chatGptAuth: {
      hasStoredProfile: async () => false,
      status: async () => ({ state: "absent", runtimeReady: false }),
      login: async (operationId) => ({ status: "refused", operationId, reason: "cancelled" }),
      cancelLogin: (operationId) => ({ status: "not-active", operationId }),
      activate: async () => ({ status: "refused", reason: "credential-required" }),
      deleteCredential: async () => ({ status: "refused", reason: "not-found" }),
    },
    claudeCli: {
      status: async () => ({ state: "absent-binary" }),
      recheck: async () => ({ state: "absent-binary" }),
      invalidateProbeCache: () => {},
      activate: async () => ({ status: "refused", reason: "credential-required" }),
    },
    getRuntimeConfig: async () => runtimeSnapshot("anthropic"),
    applyExistingLlmSelection: async () => false,
    credentialRecoveryStatus: async () => ({ state: "ready", unverifiedEnvelopes: 0 }),
    retryCredentialRecovery: async () => ({ state: "ready", unverifiedEnvelopes: 0 }),
    resetAllCredentials: async () => ({ status: "reset", keyCleanupPending: false }),
    isTrusted: () => true,
    checkIntervalsCredentialOwner,
  });
  try {
    await handlers.get(DESKTOP_CREDENTIAL_STATUS_CHANNEL)!({});
    expect(checkIntervalsCredentialOwner).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
}

describe("desktop credential runtime precedence", () => {
  it("builds fixed credential-clear requests and preserves managed refusals", async () => {
    expect(runtimeConfigurationForCredentialDeletion("anthropic")).toEqual({
      llm: { provider: "anthropic", clear_credential: true },
    });
    expect(runtimeConfigurationForCredentialDeletion("openai-codex")).toEqual({
      llm: { provider: "openai-codex", clear_credential: true },
    });
    expect(runtimeConfigurationForCredentialDeletion("intervals-icu")).toEqual({
      intervals: { clear_credential: true },
    });
    const results = [
      {
        schemaVersion: 3,
        status: "refused",
        reason: "credential-required",
      },
      {
        schemaVersion: 3,
        status: "refused",
        reason: "managed-by-environment",
      },
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: false, session: false },
      },
    ];
    const call = vi.fn(async () => results.shift());
    const connect = vi.fn(async () => ({
      handshake: {} as never,
      call,
      close: vi.fn(async () => {}),
    }));
    const authority = createConnectionRuntimeAuthority(
      {
        url: "ws://127.0.0.1:45005/rpc",
        token: "x".repeat(43),
        athleteHome: "/synthetic/athlete",
      },
      connect as never,
    );

    await expect(authority.clearCredential("anthropic")).resolves.toBe("not-active");
    await expect(authority.clearCredential("anthropic")).resolves.toBe("managed-by-environment");
    await expect(authority.clearCredential("anthropic")).resolves.toBe("cleared");
    expect(call).toHaveBeenNthCalledWith(1, "configureRuntime", {
      llm: { provider: "anthropic", clear_credential: true },
    });
    expect(connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:45005/rpc",
      token: "x".repeat(43),
      expectedAthleteHome: "/synthetic/athlete",
    });
  });

  it("forwards the activation deadline through connection, RPC, and serialization", async () => {
    const request = {
      llm: { model: "gpt-5.5" },
    };
    const controller = new AbortController();
    const call = vi.fn(async () => ({
      schemaVersion: 3 as const,
      status: "applied" as const,
      applied: { llm: true, intervals: false, session: false },
    }));
    const connect = vi.fn(async () => ({
      handshake: {} as never,
      call,
      close: vi.fn(async () => {}),
    }));
    const authority = createConnectionRuntimeAuthority(
      {
        url: "ws://127.0.0.1:45005/rpc",
        token: "x".repeat(43),
        athleteHome: "/synthetic/athlete",
      },
      connect as never,
    );
    const configureRuntime = vi.fn(authority.configureRuntime);
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => "openai-codex",
      configureRuntime,
    });

    await expect(
      runtime.applyExistingLlmSelection("openai-codex", request, controller.signal),
    ).resolves.toBe(true);

    expect(configureRuntime).toHaveBeenCalledWith(request, controller.signal);
    expect(connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:45005/rpc",
      token: "x".repeat(43),
      expectedAthleteHome: "/synthetic/athlete",
      signal: controller.signal,
    });
    expect(call).toHaveBeenCalledWith("configureRuntime", request, {
      signal: controller.signal,
    });
  });

  it("calls daemon credential preflight with the candidate key and abort signal", async () => {
    const controller = new AbortController();
    const call = vi.fn(async () => ({ approval: VERIFICATION_APPROVAL }));
    const connect = vi.fn(async () => ({
      handshake: {} as never,
      call,
      close: vi.fn(async () => {}),
    }));
    const authority = createConnectionRuntimeAuthority(
      {
        url: "ws://127.0.0.1:45005/rpc",
        token: "x".repeat(43),
        athleteHome: "/synthetic/athlete",
      },
      connect as never,
    );

    await expect(
      authority.verifyIntervalsCredential("synthetic-intervals-key", controller.signal),
    ).resolves.toEqual({ approval: VERIFICATION_APPROVAL });
    expect(call).toHaveBeenCalledWith(
      "verify_intervals_credential",
      { api_key: "synthetic-intervals-key" },
      { signal: controller.signal },
    );
    expect(connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:45005/rpc",
      token: "x".repeat(43),
      expectedAthleteHome: "/synthetic/athlete",
      signal: controller.signal,
    });
  });

  it("falls back only for method absence or a lifecycle that cannot attempt preflight", async () => {
    const lifecycle = { status: "ready", generation: 1 };
    const verifyIntervalsCredential = vi.fn(async (_apiKey: string, _signal?: AbortSignal) => ({
      approval: VERIFICATION_APPROVAL,
    }));
    const binding = { authority: { verifyIntervalsCredential } };
    const preflight = createActiveIntervalsCredentialPreflight({
      currentBinding: () => binding,
      lifecycleSnapshot: () => lifecycle,
    });
    const signal = new AbortController().signal;

    verifyIntervalsCredential.mockRejectedValueOnce(
      new CoachRpcRemoteError(-32601, "synthetic method unavailable"),
    );
    await expect(preflight("synthetic-intervals-key", signal)).resolves.toBeUndefined();
    expect(verifyIntervalsCredential).toHaveBeenCalledOnce();

    verifyIntervalsCredential.mockClear();
    const transportError = new CoachClientTransportUnavailableError();
    verifyIntervalsCredential.mockRejectedValueOnce(transportError);
    await expect(preflight("synthetic-intervals-key", signal)).rejects.toBe(transportError);
    expect(verifyIntervalsCredential).toHaveBeenCalledOnce();

    verifyIntervalsCredential.mockClear();
    lifecycle.status = "starting";
    await expect(preflight("synthetic-intervals-key", signal)).resolves.toBeUndefined();
    expect(verifyIntervalsCredential).not.toHaveBeenCalled();
  });

  it("does not start a queued runtime mutation after its activation deadline", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const configured = new Promise<void>((resolve) => {
      started = resolve;
    });
    const selectedLlmProvider = vi.fn(async () => "openai-codex" as const);
    const configureRuntime = vi.fn(async () => {
      started();
      await gate;
    });
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider,
      configureRuntime,
    });
    const blocker = runtime.applyExplicit({
      llm: { provider: "anthropic", model: "athlete-selected-model" },
    });
    await configured;
    const controller = new AbortController();
    const queued = runtime.applyExistingLlmSelection(
      "openai-codex",
      { llm: { model: "gpt-5.5" } },
      controller.signal,
    );
    const queuedExpectation = expect(queued).rejects.toMatchObject({ name: "TimeoutError" });
    controller.abort(new DOMException("Activation timed out", "TimeoutError"));

    release();
    await blocker;
    await queuedExpectation;
    expect(selectedLlmProvider).not.toHaveBeenCalled();
    expect(configureRuntime).toHaveBeenCalledOnce();
  });

  it("uses the current-account sentinel only for a blank ownership preflight", () => {
    expect(intervalsAthleteIdForOwnership(runtimeSnapshot("anthropic", undefined, false, ""))).toBe(
      "0",
    );
    expect(
      intervalsAthleteIdForOwnership(
        runtimeSnapshot("anthropic", undefined, false, "selected-athlete"),
      ),
    ).toBe("selected-athlete");
  });

  it("replays an intervals credential as the key-only canonical runtime patch", async () => {
    const configureRuntime = vi.fn(async () => {});
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => undefined,
      configureRuntime,
    });

    await expect(
      runtime.reapplyStoredCredential("intervals-icu", "obviously-fake-intervals-key", [
        "intervals-icu",
      ]),
    ).resolves.toBe("active");

    expect(configureRuntime).toHaveBeenCalledWith({
      intervals: { api_key: "obviously-fake-intervals-key" },
    });
  });

  it("adds an approval only to its explicit Intervals activation request", async () => {
    const configureRuntime = vi.fn(async () => {});
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => undefined,
      configureRuntime,
    });

    await runtime.applyExplicit(
      { intervals: { api_key: "synthetic-intervals-key" } },
      undefined,
      VERIFICATION_APPROVAL,
    );

    expect(configureRuntime).toHaveBeenNthCalledWith(
      1,
      {
        intervals: {
          api_key: "synthetic-intervals-key",
          verification_approval: VERIFICATION_APPROVAL,
        },
      },
      undefined,
    );

    await runtime.reapplyStoredCredential("intervals-icu", "synthetic-intervals-key", [
      "intervals-icu",
    ]);

    expect(configureRuntime).toHaveBeenNthCalledWith(2, {
      intervals: { api_key: "synthetic-intervals-key" },
    });
    expect(JSON.stringify(configureRuntime.mock.calls[1])).not.toContain(VERIFICATION_APPROVAL);
  });

  it("keeps legacy activation tokenless and forwards an approval only when present", async () => {
    const applyExplicit = vi.fn(async () => {});
    const runtime = { applyExplicit };
    const request = { intervals: { api_key: "synthetic-intervals-key" } } as const;

    await applyExplicitCredentialToRuntime(runtime, request);
    await applyExplicitCredentialToRuntime(runtime, request, VERIFICATION_APPROVAL);

    expect(applyExplicit.mock.calls).toEqual([
      [request],
      [request, undefined, VERIFICATION_APPROVAL],
    ]);
  });

  it("self-heals a stored provider after the first-run seed outlives a failed apply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-credential-runtime-"));
    roots.push(directory);
    const configDir = join(directory, "config");
    const vaultRoot = join(directory, "credentials-v1");
    await mkdir(configDir);
    await writeFile(
      join(configDir, "config.yaml"),
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-6\n",
    );
    let runtimeAvailable = false;
    let activeProvider: LlmProvider = "anthropic";
    const launchRuntime = (): CredentialRuntimeApplication =>
      createCredentialRuntimeApplication({
        selectedLlmProvider: async (storedCredentialSlots) =>
          readSelectedLlmProvider(runtimeSnapshot(activeProvider), {
            chatGptProfilePresent: false,
            storedCredentialSlots,
          }),
        async configureRuntime(request) {
          if (!runtimeAvailable) throw new TypeError();
          if (request.llm === undefined) return;
          activeProvider = request.llm.provider ?? activeProvider;
          await writeFile(
            join(configDir, "config.yaml"),
            `llm:\n  provider: ${activeProvider}\n  model: custom-selected-model\n`,
          );
        },
      });
    let runtime = launchRuntime();
    const launchVault = () =>
      createCredentialVault({
        root: vaultRoot,
        encryption: encryption(),
        applyCredential: (slot, value) =>
          runtime.applyExplicit(runtimeConfigurationForCredential(slot, value)),
        reapplyCredential: runtime.reapplyStoredCredential,
      });
    let vault = launchVault();

    await expect(
      vault.writeCredential({ slot: "openrouter", value: randomUUID() }),
    ).resolves.toEqual({
      slot: "openrouter",
      status: "configured",
      runtimeReady: false,
    });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "openrouter",
      state: "configured",
      runtimeState: "failed",
    });

    runtimeAvailable = true;
    runtime = launchRuntime();
    vault = launchVault();
    await vault.reapplyConfigured();

    expect(activeProvider).toBe("openrouter");
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "openrouter",
      state: "configured",
      runtimeState: "active",
    });
  });

  it("keeps a dormant API credential inactive across relaunch when a profile corroborates ChatGPT", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-credential-runtime-"));
    roots.push(directory);
    const configDir = join(directory, "config");
    const vaultRoot = join(directory, "credentials-v1");
    await mkdir(configDir);
    const initialVault = createCredentialVault({
      root: vaultRoot,
      encryption: encryption(),
      applyCredential: async () => {},
    });
    await expect(
      initialVault.writeCredential({ slot: "anthropic", value: randomUUID() }),
    ).resolves.toMatchObject({ status: "configured" });
    await writeFile(
      join(configDir, "config.yaml"),
      "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
    );
    const configureRuntime = vi.fn(async () => {});
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async (storedCredentialSlots) =>
        readSelectedLlmProvider(runtimeSnapshot("openai-codex"), {
          chatGptProfilePresent: true,
          storedCredentialSlots,
        }),
      configureRuntime,
    });
    const relaunchedVault = createCredentialVault({
      root: vaultRoot,
      encryption: encryption(),
      applyCredential: (slot, value) =>
        runtime.applyExplicit(runtimeConfigurationForCredential(slot, value)),
      reapplyCredential: runtime.reapplyStoredCredential,
    });

    await relaunchedVault.reapplyConfigured();

    expect(configureRuntime).not.toHaveBeenCalled();
    await expect(relaunchedVault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
  });

  it.each([
    ["externally configured provider", runtimeSnapshot("google", "external-model", true)],
    ["custom active ChatGPT profile", runtimeSnapshot("openai-codex", "chat-model", true)],
  ])(
    "keeps an unrelated vault key inactive at boot for an authoritative %s",
    async (_case, snapshot) => {
      const directory = await mkdtemp(join(tmpdir(), "enduragent-credential-runtime-"));
      roots.push(directory);
      const vaultRoot = join(directory, "credentials-v1");
      const initialVault = createCredentialVault({
        root: vaultRoot,
        encryption: encryption(),
        applyCredential: async () => {},
      });
      await expect(
        initialVault.writeCredential({ slot: "anthropic", value: randomUUID() }),
      ).resolves.toMatchObject({ status: "configured" });
      const configureRuntime = vi.fn(async () => {});
      const runtime = createCredentialRuntimeApplication({
        selectedLlmProvider: async (storedCredentialSlots) =>
          readSelectedLlmProvider(snapshot, {
            chatGptProfilePresent: false,
            storedCredentialSlots,
          }),
        configureRuntime,
      });
      const relaunchedVault = createCredentialVault({
        root: vaultRoot,
        encryption: encryption(),
        applyCredential: (slot, value) =>
          runtime.applyExplicit(runtimeConfigurationForCredential(slot, value)),
        reapplyCredential: runtime.reapplyStoredCredential,
      });

      await relaunchedVault.reapplyConfigured();

      expect(configureRuntime).not.toHaveBeenCalled();
      await expect(relaunchedVault.credentialStatuses()).resolves.toContainEqual({
        slot: "anthropic",
        state: "configured",
        runtimeState: "stored-inactive",
      });
    },
  );

  it("requires a profile or stored credential to corroborate the recorded provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-credential-runtime-"));
    roots.push(directory);
    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
    );

    expect(
      readSelectedLlmProvider(runtimeSnapshot("openai-codex"), {
        chatGptProfilePresent: true,
        storedCredentialSlots: [],
      }),
    ).toBe("openai-codex");
    expect(
      readSelectedLlmProvider(runtimeSnapshot("openai-codex"), {
        chatGptProfilePresent: false,
        storedCredentialSlots: [],
      }),
    ).toBeUndefined();

    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-6\n",
    );
    expect(
      readSelectedLlmProvider(runtimeSnapshot("anthropic"), {
        chatGptProfilePresent: false,
        storedCredentialSlots: ["anthropic"],
      }),
    ).toBe("anthropic");
    expect(
      readSelectedLlmProvider(runtimeSnapshot("anthropic"), {
        chatGptProfilePresent: false,
        storedCredentialSlots: [],
      }),
    ).toBeUndefined();
    expect(
      readSelectedLlmProvider(runtimeSnapshot("google", "external-model", true), {
        chatGptProfilePresent: false,
        storedCredentialSlots: ["anthropic"],
      }),
    ).toBe("google");
    expect(
      readSelectedLlmProvider(runtimeSnapshot("openai-codex", "chat-model", true), {
        chatGptProfilePresent: false,
        storedCredentialSlots: ["anthropic"],
      }),
    ).toBe("openai-codex");
  });

  it("serializes passive replay before a later explicit provider selection", async () => {
    let selectedProvider: LlmProvider = "anthropic";
    let releaseReplay!: () => void;
    let replayStarted!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayStart = new Promise<void>((resolve) => {
      replayStarted = resolve;
    });
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => selectedProvider,
      async configureRuntime(request) {
        if (request.llm?.provider === "anthropic") {
          replayStarted();
          await replayGate;
        }
        if (request.llm?.provider !== undefined) selectedProvider = request.llm.provider;
      },
    });
    const replay = runtime.reapplyStoredCredential("anthropic", randomUUID(), ["anthropic"]);
    await replayStart;
    const explicit = runtime.applyExplicit({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });

    releaseReplay();
    await Promise.all([replay, explicit]);

    expect(selectedProvider).toBe("openai-codex");
  });

  it.each(["anthropic", "openai-codex"] as const)(
    "edits an existing %s selection without resending the provider",
    async (provider) => {
      const configureRuntime = vi.fn(async () => {});
      const runtime = createCredentialRuntimeApplication({
        selectedLlmProvider: async () => provider,
        configureRuntime,
      });
      const request = { llm: { model: "athlete-selected-model" } };

      await expect(runtime.applyExistingLlmSelection(provider, request)).resolves.toBe(true);
      await expect(
        runtime.applyExistingLlmSelection(
          provider === "anthropic" ? "openai-codex" : "anthropic",
          request,
        ),
      ).resolves.toBe(false);

      expect(configureRuntime).toHaveBeenCalledOnce();
      expect(configureRuntime).toHaveBeenCalledWith(request);
    },
  );

  it("keeps a later ChatGPT selection when stored model credentials reapply at boot", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();

    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.persistedProvider()).toBe("openai-codex");
    expect(daemon.modelApplications()).toEqual([]);
  });

  it("keeps a later ChatGPT selection when the wizard polls credential status", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    daemon.clearModelApplications();
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.modelApplications()).toEqual([]);

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.modelApplications()).toEqual([]);
  });

  it("reads an unrelated service credential without changing the ChatGPT selection", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    daemon.clearModelApplications();
    await vault.port.writeCredential({ slot: "intervals-icu", value: randomUUID() });
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.intervalsApplications()).toBe(1);
    expect(daemon.modelApplications()).toEqual([]);

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.intervalsApplications()).toBe(2);
    expect(daemon.modelApplications()).toEqual([]);
  });

  it("reapplies the selected API-key provider when there is no ChatGPT selection", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();

    expect(daemon.activeProvider()).toBe("anthropic");
    expect(daemon.persistedProvider()).toBe("anthropic");
    expect(daemon.modelApplications()).toEqual(["anthropic"]);
    expect(daemon.activeModel()).toBe("custom-selected-model");
  });

  it("self-heals an unrecorded explicit selection after runtime application recovers", async () => {
    let selectedProvider: LlmProvider | undefined;
    let runtimeAvailable = false;
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => selectedProvider,
      async configureRuntime(request) {
        if (!runtimeAvailable) throw new TypeError();
        if (request.llm?.provider !== undefined) selectedProvider = request.llm.provider;
      },
    });
    const slot = "anthropic" as const;

    await expect(
      runtime.applyExplicit(runtimeConfigurationForCredential(slot, randomUUID())),
    ).rejects.toBeInstanceOf(TypeError);
    runtimeAvailable = true;

    await expect(runtime.reapplyStoredCredential(slot, randomUUID(), [slot])).resolves.toBe(
      "active",
    );
    expect(selectedProvider).toBe(slot);
  });

  it("self-heals a failed stored key after that slot becomes the recorded selection", async () => {
    let selectedProvider: LlmProvider | undefined;
    let runtimeAvailable = false;
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => selectedProvider,
      async configureRuntime(request) {
        if (!runtimeAvailable) throw new TypeError();
        if (request.llm?.provider !== undefined) selectedProvider = request.llm.provider;
      },
    });
    const slot = "anthropic" as const;

    await expect(
      runtime.applyExplicit(runtimeConfigurationForCredential(slot, randomUUID())),
    ).rejects.toBeInstanceOf(TypeError);
    selectedProvider = slot;
    runtimeAvailable = true;

    await expect(runtime.reapplyStoredCredential(slot, randomUUID(), [slot])).resolves.toBe(
      "active",
    );
    expect(selectedProvider).toBe(slot);
  });

  it("keeps self-heal inert when another provider is the recorded selection", async () => {
    const configureRuntime = vi.fn(async () => {});
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => "openai-codex",
      configureRuntime,
    });

    await expect(
      runtime.reapplyStoredCredential("anthropic", randomUUID(), ["anthropic"]),
    ).resolves.toBe("stored-inactive");
    expect(configureRuntime).not.toHaveBeenCalled();
  });

  it("persists a deliberate switch from ChatGPT back to an API-key provider", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    await vault.port.writeCredential({ slot: "openrouter", value: randomUUID() });
    daemon.clearModelApplications();
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openrouter");
    expect(daemon.persistedProvider()).toBe("openrouter");
    expect(daemon.modelApplications()).toEqual([]);

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();
    expect(daemon.activeProvider()).toBe("openrouter");
    expect(daemon.persistedProvider()).toBe("openrouter");
    expect(daemon.modelApplications()).toEqual(["openrouter"]);
  });

  it("binds successor reads and credential replay to the supplied connection", async () => {
    const calls: string[] = [];
    const callSignals: (AbortSignal | undefined)[] = [];
    const connect = vi.fn(
      async (_options: {
        readonly url: string;
        readonly token: string;
        readonly signal?: AbortSignal;
      }) => ({
        handshake: {} as never,
        async call(method: string, _params: unknown, options?: { readonly signal?: AbortSignal }) {
          calls.push(method);
          callSignals.push(options?.signal);
          if (method === "getRuntimeConfig") return runtimeSnapshot("anthropic");
          return {
            schemaVersion: 3,
            status: "applied",
            applied: { llm: true, intervals: false, session: false },
          };
        },
        async close() {},
      }),
    );
    const successor = createConnectionRuntimeAuthority(
      {
        url: "ws://127.0.0.1:45002/rpc",
        token: "obviously-fake-successor-token",
        athleteHome: "/synthetic/athlete",
      },
      connect as never,
    );

    const controller = new AbortController();
    await expect(successor.getRuntimeConfig(controller.signal)).resolves.toEqual(
      runtimeSnapshot("anthropic"),
    );
    await successor.configureRuntime({
      llm: { provider: "anthropic", api_key: "obviously-fake-successor-key" },
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenNthCalledWith(1, {
      url: "ws://127.0.0.1:45002/rpc",
      token: "obviously-fake-successor-token",
      expectedAthleteHome: "/synthetic/athlete",
      signal: controller.signal,
    });
    expect(connect).toHaveBeenNthCalledWith(2, {
      url: "ws://127.0.0.1:45002/rpc",
      token: "obviously-fake-successor-token",
      expectedAthleteHome: "/synthetic/athlete",
    });
    expect(calls).toEqual(["getRuntimeConfig", "configureRuntime"]);
    expect(callSignals).toEqual([controller.signal, undefined]);
  });

  it.each([
    [
      { llm: { model: "candidate-model" } },
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: false, intervals: false, session: false },
      },
    ],
    [
      { intervals: { athlete_id: "candidate-athlete" } },
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: false, intervals: false, session: false },
      },
    ],
    [
      { session: { idleMinutes: 30 } },
      {
        schemaVersion: 3,
        status: "applied",
        applied: { llm: false, intervals: false, session: false },
      },
    ],
  ] as const)(
    "accepts only an applied result for every requested runtime slot",
    async (request, result) => {
      const connect = vi.fn(async () => ({
        handshake: {} as never,
        call: vi.fn(async () => result),
        close: vi.fn(async () => {}),
      }));
      const authority = createConnectionRuntimeAuthority(
        {
          url: "ws://127.0.0.1:45004/rpc",
          token: "obviously-fake-successor-token",
          athleteHome: "/synthetic/athlete",
        },
        connect as never,
      );

      await expect(authority.configureRuntime(request)).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("preserves a structured runtime refusal", async () => {
    const connect = vi.fn(async () => ({
      handshake: {} as never,
      call: vi.fn(async () => ({
        schemaVersion: 3,
        status: "refused" as const,
        reason: "training-account-mismatch" as const,
      })),
      close: vi.fn(async () => {}),
    }));
    const authority = createConnectionRuntimeAuthority(
      {
        url: "ws://127.0.0.1:45004/rpc",
        token: "obviously-fake-successor-token",
        athleteHome: "/synthetic/athlete",
      },
      connect as never,
    );

    const failure = await authority
      .configureRuntime({ intervals: { athlete_id: "candidate-athlete" } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CredentialRuntimeRefusal);
    expect((failure as CredentialRuntimeRefusal).reason).toBe("training-account-mismatch");
  });

  it.each([
    ["externally configured provider", runtimeSnapshot("google", "external-model", true)],
    ["custom active ChatGPT profile", runtimeSnapshot("openai-codex", "chat-model", true)],
  ])(
    "binds authoritative %s replay evidence to the successor without LLM reconfiguration",
    async (_case, snapshot) => {
      const calls: string[] = [];
      const connect = vi.fn(async () => ({
        handshake: {} as never,
        async call(method: string) {
          calls.push(method);
          if (method === "getRuntimeConfig") return snapshot;
          return {
            schemaVersion: 3,
            status: "applied",
            applied: { llm: true, intervals: false, session: false },
          };
        },
        async close() {},
      }));
      const successor = createConnectionRuntimeAuthority(
        {
          url: "ws://127.0.0.1:45003/rpc",
          token: "obviously-fake-successor-token",
          athleteHome: "/synthetic/athlete",
        },
        connect as never,
      );
      const configureRuntime = vi.fn(successor.configureRuntime);
      const runtime = createCredentialRuntimeApplication({
        selectedLlmProvider: async (storedCredentialSlots) =>
          readSelectedLlmProvider(await successor.getRuntimeConfig(), {
            chatGptProfilePresent: false,
            storedCredentialSlots,
          }),
        configureRuntime,
      });

      await expect(
        runtime.reapplyStoredCredential("anthropic", randomUUID(), ["anthropic"]),
      ).resolves.toBe("stored-inactive");

      expect(configureRuntime).not.toHaveBeenCalled();
      expect(calls).toEqual(["getRuntimeConfig"]);
      expect(connect).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledWith({
        url: "ws://127.0.0.1:45003/rpc",
        token: "obviously-fake-successor-token",
        expectedAthleteHome: "/synthetic/athlete",
      });
    },
  );
});
