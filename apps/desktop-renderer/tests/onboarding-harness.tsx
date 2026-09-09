import { act, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { OnboardingBridge, OnboardingLlmConfiguration } from "../src/onboarding/bridge";
import {
  createOnboardingController,
  type OnboardingController,
} from "../src/onboarding/controller";
import type {
  ChatGptLoginProgress,
  ChatGptLoginResult,
  OnboardingCompletion,
} from "../src/onboarding/machine";
import type { RideImportController } from "../src/ride-import";
import type {
  TelegramControlStatus,
  TelegramSettingsFeedback,
  TelegramSettingsState,
} from "../src/settings/telegram-controller";
import { createOnboardingViewAdapter } from "../src/state/adapters/onboarding";
import { credentialDrafts } from "../src/state/credential-drafts";
import { CLOSED_ONBOARDING } from "../src/state/onboarding-slice";
import { EMPTY_SETTINGS_SURFACE, type TelegramSettingsPort } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { OnboardingWizard, SetupPanel } from "../src/ui/onboarding/OnboardingWizard";

export type UserEvent = ReturnType<typeof userEvent.setup>;

export interface MountedWizard {
  readonly controller: OnboardingController;
  readonly focusOpener: ReturnType<typeof vi.fn<() => void>>;
  readonly rendered: RenderResult;
  open(): Promise<void>;
}

export function resetOnboardingStore(): void {
  useEnduragentStore.setState({
    onboarding: CLOSED_ONBOARDING,
    onboardingActions: null,
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
}

export function testTelegramPort() {
  return {
    retry: vi.fn(),
    pasteToken: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    remove: vi.fn(),
    reconcile: vi.fn(),
    removeWebhook: vi.fn(),
    beginPairing: vi.fn(),
    cancelPairing: vi.fn(),
    acknowledgeGapWarning: vi.fn(),
    addSender: vi.fn(),
    removeSender: vi.fn(),
  } satisfies TelegramSettingsPort;
}

export function readyTelegramSettings(
  telegram: TelegramControlStatus,
  feedback: TelegramSettingsFeedback | null = null,
): Extract<TelegramSettingsState, { readonly status: "ready" }> {
  return {
    status: "ready",
    telegram,
    allowedSenders: { senders: [] },
    senderLoadFailed: false,
    announcement: feedback?.message ?? "",
    healthAnnouncement: "",
    feedback,
  };
}

export function setTelegramSettings(state: TelegramSettingsState, port = testTelegramPort()) {
  useEnduragentStore.setState({
    settings: { ...useEnduragentStore.getState().settings, telegram: state },
    settingsPorts: { telegram: port } as never,
  });
  return port;
}

export function mountWizard(input: {
  readonly bridge: OnboardingBridge;
  readonly rideImports?: RideImportController;
  readonly onRideImportPresentationChange?: (presenting: boolean) => void;
  readonly onComplete?: (completion: OnboardingCompletion) => void;
  readonly credentialMutationsBlocked?: () => boolean;
  readonly createOperationId?: () => string;
  readonly afterPaint?: (callback: () => void) => () => void;
  readonly placement?: "gate" | "settings";
  readonly codexAgentSupported?: boolean;
}): MountedWizard {
  const focusOpener = vi.fn<() => void>();
  const adapter = createOnboardingViewAdapter({
    publish: (next) => useEnduragentStore.getState().setOnboarding(next),
  });
  const controller = createOnboardingController({
    bridge: input.bridge,
    credentials: credentialDrafts,
    view: adapter.view,
    ...(input.rideImports === undefined ? {} : { rideImports: input.rideImports }),
    ...(input.onRideImportPresentationChange === undefined
      ? {}
      : { onRideImportPresentationChange: input.onRideImportPresentationChange }),
    focusOpener,
    onComplete: input.onComplete ?? vi.fn(),
    ...(input.credentialMutationsBlocked === undefined
      ? {}
      : { credentialMutationsBlocked: input.credentialMutationsBlocked }),
    ...(input.createOperationId === undefined
      ? {}
      : { createOperationId: input.createOperationId }),
    ...(input.afterPaint === undefined ? {} : { afterPaint: input.afterPaint }),
    ...(input.codexAgentSupported === undefined
      ? {}
      : { codexAgentSupported: input.codexAgentSupported }),
  });
  useEnduragentStore.getState().bindOnboardingActions(controller);
  const rendered = render(
    input.placement === "settings" ? <SetupPanel placement="settings" /> : <OnboardingWizard />,
  );

  return {
    controller,
    focusOpener,
    rendered,
    async open() {
      await act(async () => {
        await controller.open();
      });
    },
  };
}

export function passwordInput(slot: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[data-slot="${slot}"]`);
  if (input === null) throw new Error(`Password input not found: ${slot}`);
  return input;
}

export function control<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`#${id}`);
  if (element === null) throw new Error(`Control not found: ${id}`);
  return element;
}

const SETUP_OPTION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "onboarding-injury-status": {
    none: "No current injury",
    returning: "Returning after an injury",
  },
  "onboarding-llm-provider": {
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
  },
  "onboarding-llm-model": {
    __custom__: "Other model…",
    "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  },
  "onboarding-endpoint-mode": {
    custom: "Use a custom endpoint",
  },
};

export async function selectSetupOption(user: UserEvent, id: string, value: string): Promise<void> {
  const label = SETUP_OPTION_LABELS[id]?.[value] ?? value;
  await user.click(control(id));
  await user.click(await screen.findByRole("option", { name: label }));
}

export function errorText(): string {
  return document.querySelector("#onboarding-error")?.textContent ?? "";
}

export function retryButtons(): readonly HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button) => button.textContent === "Retry saved keys",
  );
}

export function setupCard(): HTMLElement {
  const card = document.querySelector<HTMLElement>("[data-setup-card]");
  if (card === null) throw new Error("Setup card not found");
  return card;
}

export function setupRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-setup-row="${id}"]`);
  if (row === null) throw new Error(`Setup row not found: ${id}`);
  return row;
}

export function rowState(id: string): string {
  return setupRow(id).dataset.state ?? "";
}

export function rowSubtitle(id: string): string {
  return (
    setupRow(id).querySelector("[data-setup-row-title]")?.nextElementSibling?.textContent ?? ""
  );
}

export function panel(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-setup-panel="${name}"]`);
}

export function panelButton(name: string, label: string): HTMLButtonElement {
  const host = panel(name);
  if (host === null) throw new Error(`panel not open: ${name}`);
  return within(host).getByRole("button", { name: label });
}

export async function saveModelKey(user: UserEvent): Promise<void> {
  await user.click(panelButton("api-key", "Save API key"));
}

export function laneMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-setup-menu="ai"]');
}

export function laneItems(): readonly HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-lane]"));
}

export async function openLaneMenu(user: UserEvent): Promise<void> {
  const trigger = document.querySelector<HTMLElement>('[data-setup-trigger="ai"]');
  if (trigger === null) throw new Error("AI row trigger not found");
  await user.click(trigger);
  await waitFor(() => {
    if (laneMenu() === null) throw new Error("Lane menu did not open");
  });
}

export async function chooseLane(user: UserEvent, lane: string): Promise<void> {
  await openLaneMenu(user);
  const item = document.querySelector<HTMLElement>(`[data-lane="${lane}"]`);
  if (item === null) throw new Error(`Lane not offered: ${lane}`);
  await user.click(item);
  await waitFor(() => {
    if (laneMenu() !== null) throw new Error("Lane menu did not close");
  });
}

export async function openApiKeyPanel(user: UserEvent): Promise<void> {
  await chooseLane(user, "api-key");
  await waitFor(() => {
    if (panel("api-key") === null) throw new Error("API key panel did not open");
  });
}

export async function openTrainingPanel(user: UserEvent): Promise<void> {
  const trigger = document.querySelector<HTMLElement>('[data-setup-trigger="training"]');
  if (trigger === null) throw new Error("Training row trigger not found");
  await user.click(trigger);
  await waitFor(() => {
    if (panel("training") === null) throw new Error("Training panel did not open");
  });
}

export function claudeCliNoteText(): string | null {
  return document.querySelector<HTMLElement>('[data-setup-note="claude-cli"]')?.textContent ?? null;
}

export function primaryButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Start coaching" });
}

export async function finishSetup(user: UserEvent): Promise<void> {
  await user.click(primaryButton());
}

export function seedSecret(slot: string, secret: string): HTMLInputElement {
  const input = passwordInput(slot);
  input.value = secret;
  return input;
}

export const TEST_LLM_CONFIGURATION: OnboardingLlmConfiguration = {
  schemaVersion: 1,
  providers: [
    {
      provider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
    },
    {
      provider: "openai-codex",
      defaultModel: "gpt-5.5",
      models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
    },
    {
      provider: "openrouter",
      defaultModel: "deepseek/deepseek-v4-flash",
      models: [{ value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    },
    {
      provider: "openai",
      defaultModel: "gpt-5.5",
      models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
    },
    {
      provider: "google",
      defaultModel: "gemini-3.5-flash",
      models: [{ value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
    },
    {
      provider: "deepseek",
      defaultModel: "deepseek-v4-flash",
      models: [{ value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
      defaultBaseUrl: "https://api.deepseek.com/v1",
    },
    {
      provider: "qwen",
      defaultModel: "qwen3.5-plus",
      models: [{ value: "qwen3.5-plus", label: "Qwen3.5 Plus" }],
      defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    },
    {
      provider: "minimax",
      defaultModel: "MiniMax-M2.7",
      models: [{ value: "MiniMax-M2.7", label: "MiniMax M2.7" }],
      defaultBaseUrl: "https://api.minimax.io/v1",
    },
    {
      provider: "kimi",
      defaultModel: "kimi-k2.6",
      models: [{ value: "kimi-k2.6", label: "Kimi K2.6" }],
      defaultBaseUrl: "https://api.moonshot.ai/v1",
    },
    {
      provider: "zai",
      defaultModel: "glm-4.7",
      models: [{ value: "glm-4.7", label: "GLM-4.7" }],
      defaultBaseUrl: "https://api.z.ai/api/openai/v1",
    },
  ],
  active: { provider: "openai-codex", model: "gpt-5.5" },
};

export type TestBridge = OnboardingBridge & {
  readonly credentialStatuses: ReturnType<typeof vi.fn<OnboardingBridge["credentialStatuses"]>>;
  readonly retryFailedCredentials: ReturnType<
    typeof vi.fn<OnboardingBridge["retryFailedCredentials"]>
  >;
  readonly llmConfiguration: ReturnType<typeof vi.fn<OnboardingBridge["llmConfiguration"]>>;
  readonly applyLlmSelection: ReturnType<typeof vi.fn<OnboardingBridge["applyLlmSelection"]>>;
  readonly chatGptStatus: ReturnType<typeof vi.fn<OnboardingBridge["chatGptStatus"]>>;
  readonly chatGptLogin: ReturnType<typeof vi.fn<OnboardingBridge["chatGptLogin"]>>;
  readonly cancelChatGptLogin: ReturnType<typeof vi.fn<OnboardingBridge["cancelChatGptLogin"]>>;
  readonly onChatGptLoginProgress: ReturnType<
    typeof vi.fn<OnboardingBridge["onChatGptLoginProgress"]>
  >;
  readonly claudeCliStatus: ReturnType<typeof vi.fn<OnboardingBridge["claudeCliStatus"]>>;
  readonly claudeCliRecheck: ReturnType<typeof vi.fn<OnboardingBridge["claudeCliRecheck"]>>;
  readonly writeCredential: ReturnType<typeof vi.fn<OnboardingBridge["writeCredential"]>>;
  readonly pasteIntervalsApiKeyFromClipboard: ReturnType<
    typeof vi.fn<OnboardingBridge["pasteIntervalsApiKeyFromClipboard"]>
  >;
  readonly importFiles: ReturnType<typeof vi.fn<OnboardingBridge["importFiles"]>>;
  readonly chooseImportFiles: ReturnType<typeof vi.fn<OnboardingBridge["chooseImportFiles"]>>;
  readonly onDroppedImportFiles: ReturnType<typeof vi.fn<OnboardingBridge["onDroppedImportFiles"]>>;
  readonly saveIntake: ReturnType<typeof vi.fn<OnboardingBridge["saveIntake"]>>;
  emitChatGptProgress(progress: ChatGptLoginProgress): void;
};

type LegacyChatGptLoginResult =
  | ChatGptLoginResult
  | { readonly status: "configured"; readonly runtimeReady: true }
  | {
      readonly status: "refused";
      readonly reason: Extract<ChatGptLoginResult, { status: "refused" }>["reason"];
    };

export function testBridge(login: () => Promise<LegacyChatGptLoginResult>): TestBridge {
  const progressListeners = new Set<(progress: ChatGptLoginProgress) => void>();
  return {
    credentialStatuses: vi.fn<OnboardingBridge["credentialStatuses"]>(async () => []),
    retryFailedCredentials: vi.fn<OnboardingBridge["retryFailedCredentials"]>(async () => []),
    writeCredential: vi.fn<OnboardingBridge["writeCredential"]>(async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    })),
    pasteIntervalsApiKeyFromClipboard: vi.fn<OnboardingBridge["pasteIntervalsApiKeyFromClipboard"]>(
      async () => ({
        outcome: "applied",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      }),
    ),
    llmConfiguration: vi.fn<OnboardingBridge["llmConfiguration"]>(
      async () => TEST_LLM_CONFIGURATION,
    ),
    applyLlmSelection: vi.fn<OnboardingBridge["applyLlmSelection"]>(async () => ({
      status: "configured",
      runtimeReady: true,
    })),
    chatGptStatus: vi.fn<OnboardingBridge["chatGptStatus"]>(async () => ({
      state: "configured",
      runtimeReady: true,
    })),
    chatGptLogin: vi.fn<OnboardingBridge["chatGptLogin"]>(async (input) => {
      const result = await login();
      if (result.status === "configured") {
        return { status: "stored", operationId: input.operationId };
      }
      if ("operationId" in result) return result;
      return {
        status: "refused",
        operationId: input.operationId,
        reason: result.reason as Extract<ChatGptLoginResult, { status: "refused" }>["reason"],
      };
    }),
    cancelChatGptLogin: vi.fn<OnboardingBridge["cancelChatGptLogin"]>(async (operationId) => ({
      status: "cancelling",
      operationId,
    })),
    onChatGptLoginProgress: vi.fn<OnboardingBridge["onChatGptLoginProgress"]>((listener) => {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    }),
    claudeCliStatus: vi.fn<OnboardingBridge["claudeCliStatus"]>(async () => ({
      state: "not-logged-in",
    })),
    claudeCliRecheck: vi.fn<OnboardingBridge["claudeCliRecheck"]>(async () => ({
      state: "not-logged-in",
    })),
    chooseImportFiles: vi.fn<OnboardingBridge["chooseImportFiles"]>(async () => []),
    onDroppedImportFiles: vi.fn<OnboardingBridge["onDroppedImportFiles"]>(() => () => {}),
    importFiles: vi.fn<OnboardingBridge["importFiles"]>(async () => ({
      schemaVersion: 2,
      files: { total: 0, imported: 0, quarantined: 0 },
      changes: {
        rawFilesInserted: 0,
        sourceRecordsInserted: 0,
        sourceRecordsUpdated: 0,
        relinkedSourceRecords: 0,
      },
      publication: { scope: "activities-and-streams", status: "available" },
    })),
    saveIntake: vi.fn<OnboardingBridge["saveIntake"]>(async () => {}),
    emitChatGptProgress(progress) {
      for (const listener of progressListeners) listener(progress);
    },
  };
}

export function importResult(input: {
  readonly total: number;
  readonly imported: number;
  readonly quarantined: number;
}) {
  return {
    schemaVersion: 2 as const,
    files: input,
    changes: {
      rawFilesInserted: input.imported,
      sourceRecordsInserted: input.imported,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams" as const, status: "available" as const },
  };
}
