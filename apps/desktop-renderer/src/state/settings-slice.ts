import type { SpendSummary, UnitsPreference } from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { DesktopCredentialId } from "../onboarding/bridge";
import type { AthleteSettingsState } from "../settings/athlete-controller";
import {
  repairRequiredCredential,
  type CredentialSettingsState,
} from "../settings/credential-controller";
import type { ProviderModelSettingsState } from "../settings/provider-model-controller";
import type { SessionSettingField, SessionSettingsState } from "../settings/session-controller";
import type { TelegramSettingsState } from "../settings/telegram-controller";
import type { UnitsPreferenceViewState } from "../training-context/controller";
import type { DesktopUpdateState } from "../update/controller";
import type { EnduragentState } from "./store";

interface SettingsPanesPort {
  activate(): void;
  close(): void;
}

export interface CoachSettingsPort {
  retry(): void;
  changeProvider(provider: string): void;
  changeModel(model: string): void;
  changeCustomModel(model: string): void;
  save(): void;
  openSetup(): void;
}

export interface CredentialSettingsPort {
  retry(): void;
  requestDelete(credential: DesktopCredentialId): void;
  requestReset?(): void;
  cancelDelete(): void;
  confirmDelete(): void;
  setupOpened(): void;
  openSetup(): void;
}

export interface AthleteSettingsPort {
  retry(): void;
  change(value: string): void;
  save(): void;
  openSetup(): void;
}

export interface ConversationSettingsPort {
  retry(): void;
  change(field: SessionSettingField, value: string): void;
  save(): void;
}

export interface SpendSettingsPort {
  changeCap(value: string): void;
  save(): void;
}

export interface TelegramSettingsPort {
  retry(): void;
  pasteToken(): void;
  enable(): void;
  disable(): void;
  remove(): void;
  reconcile(): void;
  removeWebhook(): void;
  beginPairing(): void;
  cancelPairing(): void;
  acknowledgeGapWarning(): void;
  addSender(senderId: number): void;
  removeSender(senderId: number): void;
}

export interface UpdateSettingsPort {
  activate(): void;
}

interface UnitsSettingsPort {
  set(value: UnitsPreference): void;
}

interface SettingsPorts {
  readonly panes: SettingsPanesPort;
  readonly coach: CoachSettingsPort;
  readonly credentials: CredentialSettingsPort;
  readonly athlete: AthleteSettingsPort;
  readonly conversation: ConversationSettingsPort;
  readonly telegram: TelegramSettingsPort;
  readonly spend: SpendSettingsPort;
  readonly update: UpdateSettingsPort;
  readonly units: UnitsSettingsPort;
  openSetup(): void;
}

export interface SpendSurfaceState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly summary: SpendSummary | null;
  readonly stale: boolean;
  readonly capDraft: string;
  readonly capDirty: boolean;
  readonly saving: boolean;
  readonly capError: string | null;
  readonly warning: string | null;
}

export interface UpdateSurfaceState {
  readonly state: DesktopUpdateState;
  readonly actionDisabled: boolean;
}

interface SettingsSurfaceState {
  readonly savingOwners: readonly string[];
  readonly coach: ProviderModelSettingsState;
  readonly credentials: CredentialSettingsState;
  readonly athlete: AthleteSettingsState;
  readonly conversation: SessionSettingsState;
  readonly telegram: TelegramSettingsState;
  readonly spend: SpendSurfaceState;
  readonly update: UpdateSurfaceState;
  readonly units: UnitsPreferenceViewState;
}

export const CLOSED_PANE = Object.freeze({ status: "closed" } as const);

const EMPTY_SPEND_SURFACE: SpendSurfaceState = Object.freeze({
  status: "loading",
  summary: null,
  stale: false,
  capDraft: "",
  capDirty: false,
  saving: false,
  capError: null,
  warning: null,
});

const EMPTY_UPDATE_SURFACE: UpdateSurfaceState = Object.freeze({
  state: Object.freeze({ status: "idle" as const }),
  actionDisabled: false,
});

export const EMPTY_SETTINGS_SURFACE: SettingsSurfaceState = Object.freeze({
  savingOwners: Object.freeze([]),
  coach: CLOSED_PANE,
  credentials: CLOSED_PANE,
  athlete: CLOSED_PANE,
  conversation: CLOSED_PANE,
  telegram: CLOSED_PANE,
  spend: EMPTY_SPEND_SURFACE,
  update: EMPTY_UPDATE_SURFACE,
  units: Object.freeze({
    status: "loading" as const,
    value: "metric" as const,
    source: "default" as const,
  }),
});

export interface SettingsSlice {
  readonly settings: SettingsSurfaceState;
  readonly settingsPorts: SettingsPorts | null;
  bindSettingsPorts: (ports: SettingsPorts | null) => void;
  patchSettings: (patch: Partial<SettingsSurfaceState>) => void;
  beginSettingsMutation: (owner: string) => (() => void) | null;
  closeSettingsPanes: () => void;
  leaveSettings: () => void;
}

export function settingsMutationActive(state: SettingsSurfaceState): boolean {
  return state.savingOwners.length > 0;
}

export function nonTelegramSettingsMutationActive(
  state: Pick<SettingsSurfaceState, "savingOwners">,
): boolean {
  return state.savingOwners.some((owner) => owner !== "telegram");
}

export const createSettingsSlice: StateCreator<EnduragentState, [], [], SettingsSlice> = (
  set,
  get,
) => ({
  settings: EMPTY_SETTINGS_SURFACE,
  settingsPorts: null,
  bindSettingsPorts(ports) {
    set({ settingsPorts: ports });
  },
  patchSettings(patch) {
    const settings = { ...get().settings, ...patch };
    if (repairRequiredCredential(settings.credentials) !== null) {
      get().onboardingActions?.requireCompletion();
    }
    set({ settings });
  },
  beginSettingsMutation(owner) {
    if (settingsMutationActive(get().settings)) return null;
    set({ settings: { ...get().settings, savingOwners: [owner] } });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const settings = get().settings;
      set({
        settings: {
          ...settings,
          savingOwners: settings.savingOwners.filter((entry) => entry !== owner),
        },
      });
    };
  },
  closeSettingsPanes() {
    get().settingsPorts?.panes.close();
    const credentials = get().settings.credentials;
    const repairCredential = repairRequiredCredential(credentials);
    const resetUncertain = credentials.resetUncertain === true;
    if (repairCredential !== null) get().onboardingActions?.requireCompletion();
    set({
      settings: {
        ...get().settings,
        coach: CLOSED_PANE,
        credentials:
          repairCredential === null && !resetUncertain
            ? CLOSED_PANE
            : {
                status: "closed",
                ...(repairCredential === null ? {} : { repairCredential }),
                ...(resetUncertain ? { resetUncertain: true } : {}),
              },
        athlete: CLOSED_PANE,
        conversation: CLOSED_PANE,
      },
    });
  },
  leaveSettings() {
    set({ activeView: "chat" });
  },
});
