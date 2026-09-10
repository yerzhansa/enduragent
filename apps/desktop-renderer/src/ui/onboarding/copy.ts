import type { ClaudeCliState } from "../../onboarding/constants";
import { chatGptSignedIn, claudeCliReady, type OnboardingState } from "../../onboarding/machine";
import type { OnboardingLlmConfiguration } from "../../onboarding/bridge";
import { msg, type Message } from "@enduragent/i18n";
import type { ChatGptLoginRefusalReason } from "../../onboarding/constants";
import type { SetupLane } from "../../onboarding/lanes";
import type { ChatGptUiPhase, OnboardingErrorCode } from "../../onboarding/machine";
import { PLATFORM_COPY, platformCredentialEncryptionUnavailable } from "../../platform-copy";

export const ERROR_COPY: Readonly<Record<OnboardingErrorCode, Message>> = {
  "credential-required": msg("setup.error.credentialRequired", { chatgpt: "ChatGPT" }),
  "credential-save-failed": msg("setup.error.credentialSaveFailed"),
  "invalid-input": msg("setup.error.invalidInput"),
  "encryption-unavailable": platformCredentialEncryptionUnavailable(),
  "unsafe-backend": msg("setup.error.unsafeBackend"),
  "storage-failed": msg("setup.error.storageFailed"),
  "storage-uncertain": msg("setup.error.storageUncertain"),
  "runtime-unavailable": msg("setup.error.runtimeUnavailable"),
  "credential-status-unavailable": msg("setup.error.credentialStatusUnavailable"),
  "credential-reenter-required": msg("setup.error.credentialReenterRequired"),
  "configuration-unavailable": msg("setup.error.configurationUnavailable"),
  "model-selection-required": msg("setup.error.modelSelectionRequired"),
  "endpoint-invalid": msg("setup.error.endpointInvalid"),
  "model-runtime-unavailable": msg("setup.error.modelRuntimeUnavailable"),
  "training-account-mismatch": msg("setup.error.trainingAccountMismatch", {
    intervalsLower: "intervals.icu",
  }),
  "intervals-clipboard-unavailable": msg("setup.error.intervalsClipboardUnavailable", {
    product: "Enduragent",
    intervals: "Intervals.icu",
  }),
  "intervals-clipboard-clear-failed": msg("setup.error.intervalsClipboardClearFailed", {
    product: "Enduragent",
  }),
  "intervals-key-rejected": msg("setup.error.intervalsKeyRejected", { intervals: "Intervals.icu" }),
  "intervals-validation-unavailable": msg("setup.error.intervalsValidationUnavailable", {
    product: "Enduragent",
    intervals: "Intervals.icu",
  }),
  "intervals-owner-unavailable": msg("setup.error.intervalsOwnerUnavailable", {
    computer: PLATFORM_COPY.computer,
    product: "Enduragent",
  }),
  "intervals-storage-uncertain": msg("setup.error.intervalsStorageUncertain", {
    product: "Enduragent",
  }),
  "intervals-runtime-unavailable": msg("setup.error.intervalsRuntimeUnavailable", {
    intervals: "Intervals.icu",
  }),
  "intervals-runtime-uncertain": msg("setup.error.intervalsRuntimeUncertain", {
    product: "Enduragent",
  }),
  "training-data-required": msg("setup.error.trainingDataRequired", {
    intervalsLower: "intervals.icu",
  }),
  "intake-incomplete": msg("setup.error.intakeIncomplete"),
  "intake-save-failed": msg("setup.error.intakeSaveFailed"),
};

export const CLAUDE_CLI_LANE_COPY = msg("setup.ai.claude.detail", {
  computer: PLATFORM_COPY.computer,
  claudeCode: "Claude Code",
});

export const CLAUDE_CLI_RECHECK_LABEL = msg("setup.ai.claude.recheck");

export const CHATGPT_REFUSAL_COPY: Readonly<Record<ChatGptLoginRefusalReason, Message>> = {
  "already-in-progress": msg("setup.chatgpt.refusal.alreadyInProgress", { chatgpt: "ChatGPT" }),
  "callback-unavailable": msg("setup.chatgpt.refusal.callbackUnavailable"),
  "timed-out": msg("setup.chatgpt.refusal.timedOut", { chatgpt: "ChatGPT" }),
  cancelled: msg("setup.chatgpt.refusal.cancelled", { chatgpt: "ChatGPT" }),
  "exchange-failed": msg("setup.chatgpt.refusal.exchangeFailed", { chatgpt: "ChatGPT" }),
  "storage-failed": msg("setup.chatgpt.refusal.storageFailed", { chatgpt: "ChatGPT" }),
  "runtime-unavailable": msg("setup.chatgpt.refusal.runtimeUnavailable", { chatgpt: "ChatGPT" }),
};

export const SETUP_HEADING = msg("setup.heading");
export const SETUP_SETTINGS_HEADING = msg("setup.settingsHeading");

export const SETUP_CHAT_SUBTITLE = msg("setup.chatSubtitle", { telegram: "Telegram" });

export const SETUP_CHECKING_HEADING = msg("setup.checking.heading");

export const SETUP_CHECKING_SUBTITLE = msg("setup.checking.subtitle");

export const SETUP_STATUS_CHECKING_COPY = msg("setup.checking.status");

export const SETUP_ROW_CHECKING_SUBTITLE = msg("setup.checking.rowSubtitle");
export const SETUP_STATUS_UNAVAILABLE_COPY = msg("setup.statusUnavailable", {
  product: "Enduragent",
});

export const RETRY_SETUP_STATUS_LABEL = msg("setup.retryStatus");

export const SETUP_MENU_LABEL = msg("setup.ai.menuLabel");

export const SETUP_LANE_LABELS = {
  "claude-cli": "Claude Code",
  "openai-codex": "ChatGPT subscription",
  "api-key": "API key",
} as const satisfies Readonly<Record<SetupLane, string>>;

export const SETUP_LANE_MENU_HINTS = {
  "claude-cli": msg("setup.ai.laneHint.claudeCli", { claude: "Claude" }),
  "openai-codex": msg("setup.ai.laneHint.openaiCodex"),
  "api-key": msg("setup.ai.laneHint.apiKey", { providers: 9 }),
} as const satisfies Readonly<Record<SetupLane, Message>>;

export const AI_ROW_UNSET = {
  title: "AI that powers your coach",
  subtitle: "Required — Enduragent doesn't include one",
} as const;

export const AI_ROW_PREFIX = "Powers your coach";

export const AI_ROW_PENDING = {
  "claude-cli": "sign in from a terminal to finish",
  "openai-codex": "sign in to finish",
  "api-key": "add a key to finish",
} as const satisfies Readonly<Record<SetupLane, string>>;

export const AI_TRIGGER_LABELS = {
  unset: msg("setup.ai.trigger.unset"),
  set: msg("setup.ai.trigger.set"),
} as const;

export const AI_SAVE_LABEL = msg("setup.ai.saveLabel");

export const AI_CANCEL_LABEL = msg("setup.ai.cancelLabel");

export const CHATGPT_CANCEL_LABEL = msg("setup.chatgpt.cancelLabel", { chatgpt: "ChatGPT" });

export const AI_PANEL_ANNOUNCEMENTS = {
  chatgpt: msg("setup.ai.announcement.chatgpt", { chatgpt: "ChatGPT" }),
  "api-key": msg("setup.ai.announcement.apiKey"),
} as const;

export const AI_ROW_TOOLTIP = {
  label: msg("setup.ai.tooltip.label"),
  lead: msg("setup.ai.tooltip.lead", { product: "Enduragent" }),
  body: msg("setup.ai.tooltip.body", {
    computer: PLATFORM_COPY.computer,
    chatgpt: "ChatGPT",
    claudeCode: "Claude Code",
  }),
} as const;

export const CHATGPT_SIGN_IN_LABEL = msg("setup.chatgpt.signIn", { chatgpt: "ChatGPT" });

export const CHATGPT_CANCEL_SIGN_IN_LABEL = msg("setup.chatgpt.cancelSignIn");

export const CHATGPT_RETRY_ACTIVATION_LABEL = msg("setup.chatgpt.retryActivation");

export const CHATGPT_ACTIVATION_FAILURE_COPY = msg("setup.chatgpt.activationFailure");

export const CHATGPT_PHASE_COPY: Readonly<
  Record<Exclude<ChatGptUiPhase, "idle" | "login-failed" | "activation-failed">, Message>
> = {
  "waiting-for-browser": msg("setup.chatgpt.phase.waitingForBrowser"),
  "completing-sign-in": msg("setup.chatgpt.phase.completingSignIn"),
  "signed-in": msg("setup.chatgpt.phase.signedIn"),
  "activating-coach": msg("setup.chatgpt.phase.activatingCoach"),
  ready: msg("setup.chatgpt.phase.ready"),
};

export const CHATGPT_PANEL_HINT = msg("setup.chatgpt.hint", { openai: "OpenAI" });

export const API_KEY_PANEL_HINT = msg("setup.ai.apiKeyHint");

export const TRAINING_ROW_TITLE = "Intervals.icu";

export const TRAINING_ROW_SUBTITLES = {
  connected: msg("setup.training.subtitle.connected"),
  missing: msg("setup.training.subtitle.missing"),
} as const;

export const TRAINING_ROW_TOOLTIP = {
  label: msg("setup.training.tooltip.label", { intervals: "Intervals.icu" }),
  lead: "Intervals.icu",
  body: msg("setup.training.tooltip.body", { product: "Enduragent" }),
} as const;

export const TRAINING_TRIGGER_LABELS = {
  disconnected: msg("setup.training.trigger.disconnected", { intervals: "Intervals.icu" }),
} as const;

export const TRAINING_CANCEL_LABEL = msg("setup.training.cancelLabel", {
  intervals: "Intervals.icu",
});

export const TRAINING_CONNECT_TITLE = msg("setup.training.connectTitle", {
  intervals: "Intervals.icu",
});

export const INTERVALS_PANEL_HINT = msg("setup.training.hint", {
  product: "Enduragent",
  intervals: "Intervals.icu",
});

export const TRAINING_USE_COPIED_KEY_LABEL = msg("setup.training.useCopiedKey");

export const IMPORT_FILES_LABEL = msg("setup.training.importFiles");

export const TELEGRAM_ROW_TITLE = "Telegram";

export const TELEGRAM_OPTIONAL_LABEL = msg("setup.telegram.optional");

export const TELEGRAM_AVAILABILITY_COPY = msg("setup.telegram.availability", {
  computer: PLATFORM_COPY.computer,
  product: "Enduragent",
  telegram: "Telegram",
});

export const TELEGRAM_VERIFIED_PREFIX = msg("setup.telegram.verifiedPrefix");

export const TELEGRAM_CREATE_TITLE = msg("setup.telegram.createTitle", { botFather: "BotFather" });

export const TELEGRAM_CREATE_COPY_AFTER_BOTFATHER = msg("setup.telegram.createAfterBotFather", {
  product: "Enduragent",
});

export const TELEGRAM_CREATE_COPY = msg("setup.telegram.createCopy", {
  botFather: "@BotFather",
  product: "Enduragent",
});

export const TELEGRAM_DELETE_TITLE = msg("setup.telegram.deleteTitle", { telegram: "Telegram" });

export const TELEGRAM_DELETE_COPY = msg("setup.telegram.deleteCopy", {
  computer: PLATFORM_COPY.computer,
  telegram: "Telegram",
});

export const RETRY_SAVED_KEYS_LABEL = msg("setup.retrySavedKeys");

export const RETRY_INTAKE_SAVE_LABEL = msg("setup.intake.retrySave");

export const FOOTER_NOTE = msg("setup.footerNote", { computer: PLATFORM_COPY.computer });

export const PRIMARY_LABEL = msg("setup.startCoaching");

export function setupLaneMessage(lane: SetupLane): Message | "Claude Code" {
  switch (lane) {
    case "claude-cli":
      return "Claude Code";
    case "openai-codex":
      return msg("setup.ai.lane.chatgpt", { chatgpt: "ChatGPT" });
    case "api-key":
      return msg("setup.ai.lane.apiKey");
  }
}

export function aiRowMessageCopy(
  lane: SetupLane | null,
  wizard: OnboardingState,
  ready: boolean,
  identity = wizard.claudeCliIdentity,
): { readonly title: Message | "Claude Code"; readonly subtitle: Message } {
  if (lane === null)
    return {
      title: msg("setup.ai.title"),
      subtitle: msg("setup.ai.subtitle", { product: "Enduragent" }),
    };
  const title = setupLaneMessage(lane);
  if (!ready) {
    if (lane === "claude-cli" && wizard.claudeCliState === null && wizard.busy)
      return {
        title,
        subtitle: msg("setup.ai.pending.checkingClaude", { claudeCode: "Claude Code" }),
      };
    if (lane === "openai-codex" && chatGptSignedIn(wizard))
      return { title, subtitle: msg("setup.ai.pending.activation") };
    switch (lane) {
      case "claude-cli":
        return { title, subtitle: msg("setup.ai.pending.claude") };
      case "openai-codex":
        return { title, subtitle: msg("setup.ai.pending.chatgpt") };
      case "api-key":
        return { title, subtitle: msg("setup.ai.pending.apiKey") };
    }
  }
  if (lane === "claude-cli" && wizard.claudeCliIdentity !== null)
    return {
      title,
      subtitle: msg("setup.ai.identity", { identity: identity ?? wizard.claudeCliIdentity }),
    };
  return { title, subtitle: msg("setup.ai.connected") };
}

export function claudeCliBadgeMessage(state: ClaudeCliState | null): Message {
  switch (state) {
    case "ready":
      return msg("setup.ai.claude.badge.ready");
    case "ready-api-key":
      return msg("setup.ai.claude.badge.readyApiKey");
    case "absent-binary":
      return msg("setup.ai.claude.badge.absentBinary");
    case "not-logged-in":
      return msg("setup.ai.claude.badge.notLoggedIn");
    case "api-key-token":
      return msg("setup.ai.claude.badge.apiKeyToken");
    case "disabled":
      return msg("setup.ai.claude.badge.disabled");
    case "working-area-unavailable":
      return msg("setup.ai.claude.badge.workingAreaUnavailable");
    case null:
      return msg("setup.ai.claude.badge.checking");
  }
}

export function claudeCliDetailMessage(state: ClaudeCliState | null): Message | null {
  switch (state) {
    case "ready":
      return null;
    case "ready-api-key":
      return null;
    case "absent-binary":
      return msg("setup.ai.claude.statusDetail.absentBinary", { claudeCode: "Claude Code" });
    case "not-logged-in":
      return msg("setup.ai.claude.statusDetail.notLoggedIn", {
        command: "claude",
        claudeCode: "Claude Code",
        product: "Enduragent",
        claude: "Claude",
      });
    case "api-key-token":
      return msg("setup.ai.claude.statusDetail.apiKeyToken", {
        command: "claude",
        claudeCode: "Claude Code",
      });
    case "disabled":
      return msg("setup.ai.claude.statusDetail.disabled", {
        computer: PLATFORM_COPY.computer,
        claude: "Claude",
      });
    case "working-area-unavailable":
      return msg("setup.ai.claude.statusDetail.workingAreaUnavailable", {
        product: "Enduragent",
        claude: "Claude",
      });
    case null:
      return msg("setup.ai.claude.statusDetail.checking", {
        computer: PLATFORM_COPY.computer,
        claudeCode: "Claude Code",
      });
  }
}

export function claudeCliNoteMessage(
  configuration: OnboardingLlmConfiguration | null,
  wizard: OnboardingState,
  lane: SetupLane | null,
): Message | null {
  if (
    !configuration?.providers.some((entry) => entry.provider === "claude-cli") ||
    lane !== "claude-cli" ||
    claudeCliReady(wizard)
  )
    return null;
  if (wizard.claudeCliState === null && !wizard.busy)
    return msg("setup.ai.claude.checkAgain", { claudeCode: "Claude Code" });
  return claudeCliDetailMessage(wizard.claudeCliState);
}

export function claudeCliIdentityMessage(value: string): Message | null {
  if (value === "Using Anthropic API key billing - usage is charged to your API account.")
    return msg("setup.ai.claude.identity.apiKey", { anthropic: "Anthropic" });
  if (value === "Signed in") return msg("setup.ai.claude.identity.signedIn");
  const emailPlan = /^Signed in as (.+) - Claude (.+) subscription$/u.exec(value);
  if (emailPlan !== null)
    return msg("setup.ai.claude.identity.emailPlan", {
      email: emailPlan[1],
      plan: emailPlan[2],
      claude: "Claude",
    });
  const plan = /^Signed in - Claude (.+) subscription$/u.exec(value);
  if (plan !== null)
    return msg("setup.ai.claude.identity.plan", { plan: plan[1], claude: "Claude" });
  const email = /^Signed in as (.+)$/u.exec(value);
  return email === null ? null : msg("setup.ai.claude.identity.email", { email: email[1] });
}

export function modelHintMessage(value: string): Message | null {
  switch (value) {
    case "recommended":
      return msg("setup.ai.modelHints.recommended");
    case "fast & cheap":
      return msg("setup.ai.modelHints.fastAndCheap");
    case "most capable":
      return msg("setup.ai.modelHints.mostCapable");
    case "balanced":
      return msg("setup.ai.modelHints.balanced");
    case "cheapest":
      return msg("setup.ai.modelHints.cheapest");
    case "experimental":
      return msg("setup.ai.modelHints.experimental");
    case "faster":
      return msg("setup.ai.modelHints.faster");
    case "fast":
      return msg("setup.ai.modelHints.fast");
    case "cheaper":
      return msg("setup.ai.modelHints.cheaper");
    case "one key, many models":
      return msg("setup.ai.modelHints.manyModels");
    case "cheap":
      return msg("setup.ai.modelHints.cheap");
    default:
      return null;
  }
}

export function modelLabelMessage(value: string): Message | null {
  const via = /^(.*) \(via (.*)\)$/u.exec(value);
  return via === null ? null : msg("setup.ai.modelVia", { model: via[1], provider: via[2] });
}
