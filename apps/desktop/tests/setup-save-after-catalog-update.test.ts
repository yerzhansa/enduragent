import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot, RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import { acceptModelCatalogSnapshot, type LocalModelCatalogSnapshot } from "@enduragent/core";
import { BUNDLED_MODEL_CATALOG } from "../../../packages/core/src/model-catalog-seed.js";
import {
  DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL,
  DESKTOP_CHATGPT_LOGIN_CHANNEL,
  DESKTOP_CHATGPT_STATUS_CHANNEL,
  DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL,
  DESKTOP_CLAUDE_CLI_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_RETRY_CHANNEL,
  DESKTOP_CREDENTIAL_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_WRITE_CHANNEL,
  DESKTOP_LLM_CONFIGURATION_CHANNEL,
  DESKTOP_LLM_SELECTION_APPLY_CHANNEL,
  registerOnboardingIpc,
} from "../src/main/onboarding-ipc.js";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import type { OnboardingLlmSelection } from "../src/main/llm-selection.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";
import type { OnboardingBridge } from "../../desktop-renderer/src/onboarding/bridge.js";
import {
  createOnboardingController,
  type OnboardingSurfaceState,
} from "../../desktop-renderer/src/onboarding/controller.js";
import type { TransientPasswordInput } from "../../desktop-renderer/src/onboarding/credentials.js";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const OPENROUTER_KEY = `sk-or-v1-${"0".repeat(64)}`;

function catalogAt(revision: number): LocalModelCatalogSnapshot {
  const accepted = acceptModelCatalogSnapshot({ ...BUNDLED_MODEL_CATALOG, revision });
  if (accepted === undefined) throw new TypeError("synthetic catalog is invalid");
  return { ...accepted, origin: "installation", revision };
}

function runtimeConfig(): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "claude-sonnet-5", credential_configured: true },
    intervals: {
      athlete_id: "0",
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

const unused = async (): Promise<never> => {
  throw new TypeError("not used in this test");
};

function openSetupOverMainIpc() {
  const handlers = new Map<string, Handler>();
  const trustedEvent = {
    sender: {
      isDestroyed: () => false,
      mainFrame: { url: createDesktopRendererUrl("A".repeat(43)) },
      send: vi.fn(),
    },
  } as unknown as IpcMainInvokeEvent;
  const base = BUNDLED_MODEL_CATALOG.revision;
  let current = catalogAt(base);
  const configured = new Set<DesktopCredentialSlot>(["anthropic", "intervals-icu"]);
  const credentialStatuses = () =>
    DESKTOP_CREDENTIAL_SLOTS.map((slot) =>
      configured.has(slot)
        ? { slot, state: "configured" as const, runtimeState: "active" as const }
        : { slot, state: "missing" as const, runtimeState: null },
    );
  const keysSaved: { slot: string; value: string; catalogRevision: number | undefined }[] = [];
  const coachCatalogs: { provider: string; catalogRevision: number }[] = [];
  const activated = (provider: string, snapshot: ModelCatalogSnapshot) => {
    coachCatalogs.push({ provider, catalogRevision: snapshot.revision });
    return { status: "configured" as const, runtimeReady: true as const };
  };
  registerOnboardingIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as never,
    dialog: { showOpenDialog: unused },
    window: {} as never,
    vault: {
      credentialStatuses: async () => credentialStatuses(),
      retryFailed: async () => undefined,
      writeCredential: async (input: {
        slot: DesktopCredentialSlot;
        value: string;
        catalogSnapshot?: ModelCatalogSnapshot;
      }) => {
        keysSaved.push({
          slot: input.slot,
          value: input.value,
          catalogRevision: input.catalogSnapshot?.revision,
        });
        configured.add(input.slot);
        return { slot: input.slot, status: "configured", runtimeReady: true };
      },
      applyLlmSelection: async (
        selection: OnboardingLlmSelection,
        snapshot: ModelCatalogSnapshot,
      ) => activated(selection.provider, snapshot),
    } as never,
    chatGptAuth: {
      status: async () => ({ state: "absent", runtimeReady: false }),
      login: async (operationId: string) => ({ status: "stored", operationId }),
      cancelLogin: (operationId: string) => ({ status: "not-active", operationId }),
      hasStoredProfile: async () => true,
      activate: async (selection: OnboardingLlmSelection, snapshot: ModelCatalogSnapshot) =>
        activated(selection.provider, snapshot),
    } as never,
    claudeCli: {
      invalidateProbeCache: vi.fn(),
      status: async () => ({ state: "ready" }),
      recheck: async () => ({ state: "ready" }),
      activate: async (selection: OnboardingLlmSelection, snapshot: ModelCatalogSnapshot) =>
        activated(selection.provider, snapshot),
    } as never,
    getRuntimeConfig: async () => runtimeConfig(),
    modelCatalog: { current: () => current },
    applyExistingLlmSelection: async () => false,
    isTrusted: (event) => event === trustedEvent,
    checkIntervalsCredentialOwner: unused,
    credentialRecoveryStatus: unused,
    retryCredentialRecovery: unused,
    resetAllCredentials: unused,
    revokeIntervalsAccess: unused,
    openRouter: {} as never,
  });
  const invoke = <Result>(channel: string, ...args: unknown[]): Promise<Result> =>
    Promise.resolve(handlers.get(channel)!(trustedEvent, ...args) as Result);
  const bridge: OnboardingBridge = {
    getSetupStatus: async () => ({ schemaVersion: 1, durableTrainingData: true }),
    credentialStatuses: () => invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL),
    retryFailedCredentials: () => invoke(DESKTOP_CREDENTIAL_RETRY_CHANNEL),
    writeCredential: (input) => invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, input),
    llmConfiguration: () => invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL),
    applyLlmSelection: (selection) => invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, selection),
    chatGptStatus: () => invoke(DESKTOP_CHATGPT_STATUS_CHANNEL),
    chatGptLogin: (input) => invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, input),
    cancelChatGptLogin: (operationId) =>
      invoke(DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL, { operationId }),
    onChatGptLoginProgress: () => () => undefined,
    claudeCliStatus: () => invoke(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL),
    claudeCliRecheck: () => invoke(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL),
    signInWithIntervals: unused,
    cancelIntervalsSignIn: async () => false,
    reopenIntervalsSignIn: async () => false,
    onIntervalsSignInProgress: () => () => undefined,
    chooseImportFiles: async () => [],
    onDroppedImportFiles: () => () => undefined,
    importFiles: unused,
    openRouterSignIn: unused,
    startOpenRouterCodeSignIn: unused,
    useCopiedOpenRouterCode: unused,
    cancelOpenRouterSignIn: async () => false,
    reopenOpenRouterSignIn: async () => false,
    openRouterCreditStatus: async () => "unknown",
    openOpenRouterPage: async () => false,
    onOpenRouterSignInProgress: () => () => undefined,
  };
  const keyField: TransientPasswordInput = { value: "", dataset: { slot: "openrouter" } };
  let surface: OnboardingSurfaceState | undefined;
  const controller = createOnboardingController({
    bridge,
    credentials: { harvest: () => [keyField], clear: () => undefined },
    view: {
      render: (next) => {
        surface = next;
      },
    },
    onComplete: () => undefined,
    afterPaint: (callback) => {
      callback();
      return () => undefined;
    },
  });
  const settingsOpenedUnderNewCatalog = async (revision: number): Promise<void> => {
    current = catalogAt(revision);
    await invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL);
  };
  return {
    base,
    controller,
    keyField,
    keysSaved,
    coachCatalogs,
    settingsOpenedUnderNewCatalog,
    surface: () => surface!,
  };
}

describe("Setup after two model list updates in one open window", () => {
  it("saves a typed key with the newest model list", async () => {
    const setup = openSetupOverMainIpc();
    await setup.controller.open();
    await setup.settingsOpenedUnderNewCatalog(setup.base + 1);
    await setup.settingsOpenedUnderNewCatalog(setup.base + 2);

    setup.controller.selectProvider("openrouter");
    setup.keyField.value = OPENROUTER_KEY;
    setup.controller.saveModelKey();
    await vi.waitFor(() => expect(setup.surface().wizard.busy).toBe(false));

    expect({
      error: setup.surface().wizard.fixedError,
      keysSaved: setup.keysSaved,
    }).toEqual({
      error: null,
      keysSaved: [{ slot: "openrouter", value: OPENROUTER_KEY, catalogRevision: setup.base + 2 }],
    });
    setup.controller.dispose();
  });

  it("activates Claude Code with the newest model list", async () => {
    const setup = openSetupOverMainIpc();
    await setup.controller.open();
    await setup.settingsOpenedUnderNewCatalog(setup.base + 1);
    await setup.settingsOpenedUnderNewCatalog(setup.base + 2);

    setup.controller.selectProvider("claude-cli");
    await vi.waitFor(() =>
      expect(setup.coachCatalogs.length + Number(setup.surface().wizard.fixedError !== null)).toBe(
        1,
      ),
    );
    await vi.waitFor(() => expect(setup.surface().wizard.busy).toBe(false));

    expect({
      error: setup.surface().wizard.fixedError,
      coachCatalogs: setup.coachCatalogs,
    }).toEqual({
      error: null,
      coachCatalogs: [{ provider: "claude-cli", catalogRevision: setup.base + 2 }],
    });
    setup.controller.dispose();
  });

  it("signs in with ChatGPT and activates it with the newest model list", async () => {
    const setup = openSetupOverMainIpc();
    await setup.controller.open();
    await setup.settingsOpenedUnderNewCatalog(setup.base + 1);
    await setup.settingsOpenedUnderNewCatalog(setup.base + 2);

    setup.controller.selectProvider("openai-codex");
    setup.controller.startChatGptLogin();
    await vi.waitFor(() =>
      expect(setup.coachCatalogs.length + Number(setup.surface().wizard.fixedError !== null)).toBe(
        1,
      ),
    );

    expect({
      error: setup.surface().wizard.fixedError,
      coachCatalogs: setup.coachCatalogs,
    }).toEqual({
      error: null,
      coachCatalogs: [{ provider: "openai-codex", catalogRevision: setup.base + 2 }],
    });
    setup.controller.dispose();
  });
});
