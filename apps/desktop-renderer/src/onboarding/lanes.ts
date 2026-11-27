import {
  AI_ROW_PENDING,
  AI_ROW_PREFIX,
  AI_ROW_UNSET,
  SETUP_LANE_LABELS,
} from "../ui/onboarding/copy";
import type { OnboardingLlmConfiguration, OnboardingLlmProviderConfiguration } from "./bridge";
import { claudeCliPresentation } from "./credential-presentation";
import {
  chatGptSignedIn,
  claudeCliReady,
  type OnboardingErrorCode,
  type OnboardingState,
} from "./machine";

export const KEYLESS_SETUP_LANES = ["claude-cli", "openai-codex"] as const;

export type SetupLane = (typeof KEYLESS_SETUP_LANES)[number] | "openrouter" | "api-key";

export type SetupErrorSection = "provider" | "training" | "footer";

export type SetupCommit = "provider" | "training" | null;

export interface AiRowCopy {
  readonly title: string;
  readonly subtitle: string;
}

export function laneForProvider(provider: string | null | undefined): SetupLane | null {
  if (provider === null || provider === undefined) return null;
  if (provider === "openrouter") return "openrouter";
  return KEYLESS_SETUP_LANES.find((lane) => lane === provider) ?? "api-key";
}

export function idleAiProvider(input: {
  readonly activeProvider: string | null | undefined;
  readonly activeProviderReady: boolean;
  readonly chatGptReady: boolean;
}): string | null {
  if (
    input.activeProviderReady &&
    input.activeProvider !== null &&
    input.activeProvider !== undefined
  ) {
    return input.activeProvider;
  }
  return input.chatGptReady ? "openai-codex" : null;
}

export function apiKeyProviders(
  configuration: OnboardingLlmConfiguration | null,
): readonly OnboardingLlmProviderConfiguration[] {
  if (configuration === null) return [];
  return configuration.providers.filter(
    (entry) => !KEYLESS_SETUP_LANES.some((lane) => lane === entry.provider),
  );
}

function offersProvider(
  configuration: OnboardingLlmConfiguration | null,
  provider: string,
): boolean {
  return configuration?.providers.some((entry) => entry.provider === provider) ?? false;
}

export function offeredLanes(
  configuration: OnboardingLlmConfiguration | null,
  _wizard: OnboardingState,
  _currentLane: SetupLane | null = null,
): readonly SetupLane[] {
  if (configuration === null) return [];
  const lanes: SetupLane[] = [];
  if (offersProvider(configuration, "claude-cli")) {
    lanes.push("claude-cli");
  }
  if (offersProvider(configuration, "openai-codex")) lanes.push("openai-codex");
  if (offersProvider(configuration, "openrouter")) lanes.push("openrouter");
  if (apiKeyProviders(configuration).length > 0) lanes.push("api-key");
  return lanes;
}

export function aiRowCopy(
  lane: SetupLane | null,
  wizard: OnboardingState,
  ready: boolean,
): AiRowCopy {
  if (lane === null) return { title: AI_ROW_UNSET.title, subtitle: AI_ROW_UNSET.subtitle };
  const title = SETUP_LANE_LABELS[lane];
  if (!ready) {
    const pending =
      lane === "claude-cli" && wizard.claudeCliState === null && wizard.busy
        ? "checking Claude Code sign-in"
        : lane === "openai-codex" && chatGptSignedIn(wizard)
          ? "signed in · activation needed"
          : AI_ROW_PENDING[lane];
    return { title, subtitle: `${AI_ROW_PREFIX} · ${pending}` };
  }
  if (lane === "claude-cli" && wizard.claudeCliIdentity !== null) {
    return { title, subtitle: `${AI_ROW_PREFIX} · ${wizard.claudeCliIdentity}` };
  }
  return { title, subtitle: `Connected · ${AI_ROW_PREFIX.toLowerCase()}` };
}

export function claudeCliNote(
  configuration: OnboardingLlmConfiguration | null,
  wizard: OnboardingState,
  currentLane: SetupLane | null = null,
): string | null {
  if (!offersProvider(configuration, "claude-cli")) return null;
  if (currentLane !== "claude-cli" || claudeCliReady(wizard)) return null;
  if (wizard.claudeCliState === null && !wizard.busy) {
    return "Choose Check again to verify Claude Code on this Mac.";
  }
  return claudeCliPresentation(wizard.claudeCliState).detail;
}

type SectionRule = SetupErrorSection | "commit";

const ERROR_SECTIONS: Readonly<Record<OnboardingErrorCode, SectionRule>> = {
  "credential-required": "provider",
  "configuration-unavailable": "provider",
  "model-selection-required": "provider",
  "endpoint-invalid": "provider",
  "model-runtime-unavailable": "provider",
  "claude-cli-check-failed": "provider",
  "training-account-mismatch": "training",
  "intervals-sign-in-denied": "training",
  "intervals-sign-in-timed-out": "training",
  "intervals-sign-in-unreachable": "training",
  "intervals-sign-in-failed": "training",
  "intervals-sign-in-rejected": "training",
  "intervals-validation-unavailable": "training",
  "intervals-owner-unavailable": "training",
  "intervals-storage-uncertain": "training",
  "intervals-runtime-unavailable": "training",
  "intervals-saved-not-active": "training",
  "training-data-required": "training",
  "credential-save-failed": "commit",
  "invalid-input": "commit",
  "encryption-unavailable": "commit",
  "unsafe-backend": "commit",
  "storage-failed": "commit",
  "storage-uncertain": "commit",
  "runtime-unavailable": "commit",
  "credential-status-unavailable": "commit",
  "credential-reenter-required": "commit",
};

export function errorSection(
  code: OnboardingErrorCode | null,
  lastCommit: SetupCommit,
): SetupErrorSection {
  if (code === null) return "footer";
  const rule = ERROR_SECTIONS[code];
  if (rule !== "commit") return rule;
  if (lastCommit === "provider") return "provider";
  if (lastCommit === "training") return "training";
  return "footer";
}
