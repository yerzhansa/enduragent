import type { StateCreator } from "zustand";
import {
  onboardingCredentialMutationActive,
  type OnboardingController,
  type OnboardingSurfaceState,
} from "../onboarding/controller";
import { createOnboardingState } from "../onboarding/machine";
import { IDLE_OPENROUTER_SIGN_IN } from "../onboarding/openrouter-sign-in";
import {
  credentialChangesBlocked,
  repairRequiredCredential,
} from "../settings/credential-controller";
import { IDLE_RIDE_IMPORT } from "./ride-import-slice";
import { nonTelegramSettingsMutationActive } from "./settings-slice";
import type { EnduragentState } from "./store";

export const CLOSED_ONBOARDING: OnboardingSurfaceState = Object.freeze({
  open: false,
  initialized: false,
  loading: true,
  loadUnavailable: false,
  hasSuccessfulLoad: false,
  completionRequired: false,
  wizard: createOnboardingState(),
  statuses: Object.freeze([]),
  configuration: null,
  draft: null,
  rideImport: IDLE_RIDE_IMPORT,
  focusSeq: 0,
  readiness: Object.freeze({ provider: false, trainingData: false }),
  lastCommit: null,
  actionStatus: null,
  intervalsSignIn: Object.freeze({ phase: "idle", athleteName: null }),
  openRouter: IDLE_OPENROUTER_SIGN_IN,
});

export const READY_ONBOARDING: OnboardingSurfaceState = Object.freeze({
  ...CLOSED_ONBOARDING,
  initialized: true,
  loading: false,
  hasSuccessfulLoad: true,
  readiness: Object.freeze({ provider: true, trainingData: true }),
});

export interface OnboardingSlice {
  readonly onboarding: OnboardingSurfaceState;
  readonly onboardingActions: OnboardingController | null;
  readonly onboardingStartupSettled: boolean;
  setOnboarding: (next: OnboardingSurfaceState) => void;
  bindOnboardingActions: (actions: OnboardingController | null) => void;
  setOnboardingStartupSettled: (settled: boolean) => void;
}

export function setupReady(state: Pick<EnduragentState, "onboarding" | "settings">): boolean {
  return setupDisposition(state) === "satisfied";
}

export type SetupDisposition = "unknown" | "required" | "satisfied";

export function setupDisposition(
  state: Pick<EnduragentState, "onboarding" | "settings">,
): SetupDisposition {
  if (!state.onboarding.initialized) return "unknown";
  if (
    state.onboarding.completionRequired ||
    repairRequiredCredential(state.settings.credentials) !== null
  ) {
    return "required";
  }
  if (!state.onboarding.hasSuccessfulLoad) {
    return state.onboarding.loadUnavailable ? "required" : "unknown";
  }
  return "satisfied";
}

export function setupSignInBlocked(
  state: Pick<EnduragentState, "onboarding" | "settings">,
): boolean {
  return (
    onboardingCredentialMutationActive(state.onboarding) ||
    credentialChangesBlocked(
      state.settings.credentials,
      nonTelegramSettingsMutationActive(state.settings),
    )
  );
}

export function setupRequired(state: Pick<EnduragentState, "onboarding" | "settings">): boolean {
  return setupDisposition(state) === "required";
}

export function setupBlocked(state: Pick<EnduragentState, "onboarding" | "settings">): boolean {
  return setupDisposition(state) !== "satisfied";
}

export function setupSurfaceOnScreen(
  state: Pick<EnduragentState, "activeView" | "onboarding" | "settings">,
): boolean {
  return setupBlocked(state) || state.activeView === "settings";
}

export function rideImportStatusSuppressed(
  state: Pick<EnduragentState, "activeView" | "onboarding" | "rideImportSuppressed" | "settings">,
): boolean {
  return state.rideImportSuppressed && setupSurfaceOnScreen(state);
}

export const createOnboardingSlice: StateCreator<EnduragentState, [], [], OnboardingSlice> = (
  set,
) => ({
  onboarding: CLOSED_ONBOARDING,
  onboardingActions: null,
  onboardingStartupSettled: false,
  setOnboarding(next) {
    set({ onboarding: next });
  },
  bindOnboardingActions(actions) {
    set({ onboardingActions: actions });
  },
  setOnboardingStartupSettled(settled) {
    set({ onboardingStartupSettled: settled });
  },
});
