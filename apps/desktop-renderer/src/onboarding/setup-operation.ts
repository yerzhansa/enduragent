import type { RideImportState } from "../ride-import";
import type { IntervalsSignInSurface } from "./intervals-sign-in";
import type { OnboardingState } from "./machine";
import { openRouterSignInBusy, type OpenRouterSignInView } from "./openrouter-sign-in";

export type SetupOperation =
  | "setup-step"
  | "chatgpt-sign-in"
  | "chatgpt-activation"
  | "openrouter-sign-in"
  | "intervals-sign-in"
  | "ride-import";

export interface SetupOperationSurface {
  readonly wizard: Pick<OnboardingState, "busy" | "chatGptLoginPhase" | "chatGptRuntimeState">;
  readonly openRouter: OpenRouterSignInView;
  readonly intervalsSignIn: Pick<IntervalsSignInSurface, "phase">;
  readonly rideImport: Pick<RideImportState, "status">;
}

export function setupOperationRunning(
  surface: SetupOperationSurface,
  except?: SetupOperation,
): boolean {
  const running: Readonly<Record<SetupOperation, boolean>> = {
    "setup-step": surface.wizard.busy,
    "chatgpt-sign-in": surface.wizard.chatGptLoginPhase !== "idle",
    "chatgpt-activation": surface.wizard.chatGptRuntimeState === "activating",
    "openrouter-sign-in": openRouterSignInBusy(surface.openRouter),
    "intervals-sign-in": surface.intervalsSignIn.phase !== "idle",
    "ride-import": surface.rideImport.status === "running",
  };
  return Object.entries(running).some(([operation, active]) => active && operation !== except);
}
