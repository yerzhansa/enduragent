import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import {
  acceptModelCatalogSnapshot,
  type CodexLoginOptions,
  type LocalModelCatalogSnapshot,
} from "@enduragent/core";
import { BUNDLED_MODEL_CATALOG } from "../../../packages/core/src/model-catalog-seed.js";
import { createChatGptAuth } from "../src/main/chatgpt-auth.js";
import type { CredentialVault } from "../src/main/credential-vault.js";
import { initializeDesktopLanguage } from "../src/main/language.js";
import {
  DESKTOP_CHATGPT_LOGIN_CHANNEL,
  DESKTOP_LLM_CONFIGURATION_CHANNEL,
  registerOnboardingIpc,
} from "../src/main/onboarding-ipc.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

await initializeDesktopLanguage();

const ACCEPTED = acceptModelCatalogSnapshot(BUNDLED_MODEL_CATALOG);
if (ACCEPTED === undefined) throw new TypeError("bundled catalog is invalid");
const LOCAL_CATALOG: LocalModelCatalogSnapshot = {
  ...ACCEPTED,
  origin: "bundled",
  revision: BUNDLED_MODEL_CATALOG.revision,
} as LocalModelCatalogSnapshot;
const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function runtimeSnapshot(): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: false },
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

function openWindow(chatGptAuth: ReturnType<typeof createChatGptAuth>) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const event = {
    sender: { isDestroyed: () => false, mainFrame: { url: RENDERER_URL }, send: vi.fn() },
  } as unknown as IpcMainInvokeEvent;
  const dispose = registerOnboardingIpc({
    ipcMain: ipcMain as never,
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    window: {} as never,
    vault: {
      credentialStatuses: vi.fn(async () => []),
    } as unknown as CredentialVault,
    chatGptAuth,
    claudeCli: {
      status: vi.fn(async () => ({ state: "not-logged-in" as const })),
      recheck: vi.fn(async () => ({ state: "not-logged-in" as const })),
      invalidateProbeCache: vi.fn(),
      activate: vi.fn(),
    } as never,
    getRuntimeConfig: async () => runtimeSnapshot(),
    modelCatalog: { current: () => LOCAL_CATALOG },
    applyExistingLlmSelection: vi.fn(async () => false),
    isTrusted: (candidate) => candidate === event,
    checkIntervalsCredentialOwner: vi.fn(async () => "unresolved" as const),
    credentialRecoveryStatus: vi.fn(async () => ({
      state: "ready" as const,
      unverifiedEnvelopes: 0,
    })),
    retryCredentialRecovery: vi.fn(async () => ({
      state: "ready" as const,
      unverifiedEnvelopes: 0,
    })),
    resetAllCredentials: vi.fn(async () => ({
      status: "reset" as const,
      keyCleanupPending: false,
    })),
    revokeIntervalsAccess: vi.fn(async () => "revoked" as const),
    openRouter: {
      ports: {
        openExternal: vi.fn(async () => undefined),
        signIn: vi.fn(async () => {
          throw new TypeError("not reached");
        }),
        startCodeSignIn: vi.fn(() => {
          throw new TypeError("not reached");
        }),
        readCreditStatus: vi.fn(async () => "unknown" as const),
      },
      clipboard: { readText: vi.fn(async () => ""), clear: vi.fn() },
      readStoredKey: vi.fn(async () => undefined),
    },
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new TypeError(`no handler for ${channel}`);
    return Promise.resolve(handler(event, ...args));
  };
  return { invoke, dispose };
}

const selection = {
  catalogRevision: BUNDLED_MODEL_CATALOG.revision,
  provider: "openai-codex" as const,
  model: "gpt-5.5",
  endpoint: { mode: "automatic" as const },
};

describe("repro onboarding D: a ChatGPT sign-in outlives its window", () => {
  it("lets the next window start a ChatGPT sign-in after the first renderer is gone", async () => {
    const base = await mkdtemp(join(tmpdir(), "repro-onboarding-d-"));
    roots.push(base);
    const loginCodex = vi.fn(
      (options: CodexLoginOptions) =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const appSignal = new AbortController();
    const chatGptAuth = createChatGptAuth({
      configDir: join(base, "config"),
      applyRuntimeConfig: vi.fn(async () => undefined),
      getRuntimeConfig: async () => runtimeSnapshot(),
      openExternal: vi.fn(async () => undefined),
      signal: appSignal.signal,
      dependencies: { loginCodex, writeProfile: vi.fn(async () => undefined) },
    });

    const first = openWindow(chatGptAuth);
    await first.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL);
    const firstLogin = first.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, {
      operationId: "synthetic-operation-1",
      selection,
    });
    await vi.waitFor(() => expect(loginCodex).toHaveBeenCalledTimes(1));

    first.dispose();

    const second = openWindow(chatGptAuth);
    await second.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL);
    let secondResult: unknown = "still waiting for the browser";
    void second
      .invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, { operationId: "synthetic-operation-2", selection })
      .then((value) => {
        secondResult = value;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      expect({
        secondSignIn: secondResult,
        browserSignInsStarted: loginCodex.mock.calls.length,
      }).toEqual({
        secondSignIn: "still waiting for the browser",
        browserSignInsStarted: 2,
      });
    } finally {
      appSignal.abort();
      await firstLogin;
      second.dispose();
    }
  });
});
