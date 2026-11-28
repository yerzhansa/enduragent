import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexLoginOptions } from "@enduragent/core";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import { createChatGptAuth } from "../src/main/chatgpt-auth.js";
import { createCredentialMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";
import { DesktopDaemonLifecycle } from "../src/main/daemon-lifecycle.js";
import { createTelegramControlCoordinator } from "../src/main/telegram-control.js";
import { BUNDLED_MODEL_CATALOG } from "../../../packages/core/src/model-catalog-seed.js";

const roots: string[] = [];
const realSetTimeout = globalThis.setTimeout;

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await vi.advanceTimersByTimeAsync(Math.min(100, ms - elapsed));
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

function connected(port: number, exit: Promise<{ readonly exitCode: number | null }>) {
  let alive = true;
  void exit.then(() => {
    alive = false;
  });
  return {
    status: "connected" as const,
    url: `ws://127.0.0.1:${port}/rpc` as const,
    token: "s".repeat(43),
    athleteHome: "/synthetic/athlete",
    rendererCapability: `${"r".repeat(42)}A`,
    owner: "app-supervised" as const,
    supervision: "app-supervised" as const,
    exited: exit,
    isAlive: () => alive,
    close: vi.fn(async () => {}),
  };
}

function runtimeSnapshot(): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: true },
    intervals: {
      athlete_id: "0",
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
  };
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "repro-onboarding-b-"));
  roots.push(base);
  const credentialRoot = join(base, "credentials-v1");
  const configDir = join(base, "config");
  const encryptionPort = encryption();
  const serializeCredentialMutation = createCredentialMutationLock();

  const vault = createCredentialVault({
    root: credentialRoot,
    encryption: encryptionPort,
    serializeCredentialMutation,
    applyCredential: vi.fn(async () => undefined),
  });
  await expect(
    vault.writeCredential({ slot: "anthropic", value: "synthetic-model-key" }),
  ).resolves.toMatchObject({ slot: "anthropic", status: "configured" });

  const loginCodex = vi.fn(
    (options: CodexLoginOptions) =>
      new Promise<never>((_resolve, reject) => {
        options.onAuth?.({
          url: "https://auth.example.invalid/authorize",
          callbackAvailable: true,
        });
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );
  const chatGptAuth = createChatGptAuth({
    configDir,
    applyRuntimeConfig: vi.fn(async () => undefined),
    getRuntimeConfig: async () => runtimeSnapshot(),
    openExternal: vi.fn(async () => undefined),
    serializeCredentialMutation,
    dependencies: { loginCodex, writeProfile: vi.fn(async () => undefined) },
  });

  const successorApply = vi.fn(async () => undefined);
  const firstExit = deferred<{ readonly exitCode: number | null }>();
  const first = connected(45_001, firstExit.promise);
  const successor = connected(45_002, new Promise(() => {}));
  const resolver = {
    resolveForRecovery: vi.fn(async (budget: { remainingAttempts: number }) => {
      budget.remainingAttempts -= 1;
      return successor;
    }),
    reobserveAttached: vi.fn(),
    close: vi.fn(async () => {}),
  };
  let now = 0;
  const lifecycle = new DesktopDaemonLifecycle(resolver, first, {
    delay: async (ms) => {
      now += ms;
    },
    monotonicNow: () => now,
    prepareReady: async ({ signal }) => {
      if (signal.aborted) throw signal.reason;
      const successorVault = createCredentialVault({
        root: credentialRoot,
        encryption: encryptionPort,
        serializeCredentialMutation,
        applyCredential: successorApply,
      });
      await successorVault.reapplyConfigured();
      await successorVault.credentialStatuses();
    },
  });
  const telegram = createTelegramControlCoordinator({
    selectedAthleteHome: () => "/synthetic/athlete" as never,
    vault: {
      profileStatus: vi.fn(async () => ({ state: "missing" }) as const),
      replaceProfile: vi.fn(),
      applyStoredProfile: vi.fn(),
      preauthorizeProfileRemoval: vi.fn(),
      deleteProfile: vi.fn(),
      desiredState: vi.fn(async () => ({ state: "missing" }) as const),
      setDesiredState: vi.fn(),
    } as never,
    daemon: { current: () => undefined },
    serializeCredentialMutation,
  });
  return { vault, chatGptAuth, loginCodex, lifecycle, firstExit, successorApply, telegram };
}

const selection = {
  catalogRevision: BUNDLED_MODEL_CATALOG.revision,
  provider: "openai-codex" as const,
  model: "gpt-5.5",
  endpoint: { mode: "automatic" as const },
};

describe("repro onboarding B: ChatGPT sign-in and the shared credential lock", () => {
  it("control: a coach restart with no sign-in open reaches ready", async () => {
    const { lifecycle, firstExit, successorApply } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    lifecycle.start();

    firstExit.resolve({ exitCode: 1 });
    await advance(5_100);

    expect(lifecycle.snapshot()).toEqual({ status: "ready", generation: 2 });
    expect(successorApply).toHaveBeenCalledWith("anthropic", "synthetic-model-key");
  });

  it("reaches ready when the coach restarts while a ChatGPT browser sign-in is open", async () => {
    const { chatGptAuth, loginCodex, lifecycle, firstExit, successorApply } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    lifecycle.start();
    const login = chatGptAuth.login("synthetic-operation", selection);
    await advance(100);
    expect(loginCodex).toHaveBeenCalledOnce();

    try {
      firstExit.resolve({ exitCode: 1 });
      await advance(5_100);

      expect({
        lifecycle: lifecycle.snapshot(),
        credentialsReplayed: successorApply.mock.calls.length,
      }).toEqual({
        lifecycle: { status: "ready", generation: 2 },
        credentialsReplayed: 1,
      });
    } finally {
      chatGptAuth.cancelLogin("synthetic-operation");
      await expect(login).resolves.toMatchObject({ status: "refused", reason: "cancelled" });
    }
  });

  it.each([
    { signInOpen: false, label: "control: no sign-in open" },
    { signInOpen: true, label: "a ChatGPT browser sign-in is open" },
  ])("lets a Coach save finish within 10 s when $label", async ({ signInOpen }) => {
    const { vault, chatGptAuth } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const login = signInOpen ? chatGptAuth.login("synthetic-operation", selection) : undefined;
    await advance(100);

    try {
      let saved = false;
      const save = vault
        .applyLlmSelection(
          {
            catalogRevision: BUNDLED_MODEL_CATALOG.revision,
            provider: "anthropic",
            model: "synthetic-model",
            endpoint: { mode: "automatic" },
          },
          BUNDLED_MODEL_CATALOG,
        )
        .then((result) => {
          saved = true;
          return result;
        });
      await advance(10_000);

      expect(saved).toBe(true);
      await expect(save).resolves.toEqual({ status: "configured", runtimeReady: true });
    } finally {
      chatGptAuth.cancelLogin("synthetic-operation");
      await login;
    }
  });

  it.each([
    { signInOpen: false, label: "control: no sign-in open" },
    { signInOpen: true, label: "a ChatGPT browser sign-in is open" },
  ])("answers a pasted Telegram token within 10 s when $label", async ({ signInOpen }) => {
    const { chatGptAuth, telegram } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const login = signInOpen ? chatGptAuth.login("synthetic-operation", selection) : undefined;
    await advance(100);

    try {
      let answered = false;
      const configure = telegram.configure("123456:synthetic-token").then((result) => {
        answered = true;
        return result;
      });
      await advance(10_000);

      expect(answered).toBe(true);
      await configure;
    } finally {
      chatGptAuth.cancelLogin("synthetic-operation");
      await login;
    }
  });
});
