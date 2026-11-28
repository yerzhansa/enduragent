import { isKeylessProvider, type AgentErrorKind } from "@enduragent/coach-contract";
import { msg, type Message } from "@enduragent/i18n";
import type { EngineLlmProvider, FailureReason } from "../host-ports.js";

export const TAINTED_BY_WRITES_MESSAGE = msg("coach.fallback.writesSaved");
export const STEP_LIMIT_TRUNCATION_MESSAGE = msg("coach.fallback.stepLimit");
export const PROTOCOL_FAILURE_MESSAGE = msg("chat.notice.protocolFailure");
export const SAVED_INFORMATION_UNVERIFIED_MESSAGE = msg("chat.notice.savedUnverified");
export const DISK_FULL_NOTE = msg("coach.history.diskFull");
export const WORKOUT_PREPARATION_FAILED_MESSAGE = msg("coach.workoutPreparation.failed");
export const WORKOUT_PREPARATION_PREPARED_MESSAGE = msg("coach.workoutPreparation.prepared");
export const WORKOUT_PREPARATION_SAVED_INFORMATION_FAILED_MESSAGE = msg(
  "coach.workoutPreparation.savedInformationFailed",
);

export function coachReplyMessage(input: {
  readonly reply: string;
  readonly message?: Message;
  readonly reset: boolean;
  readonly unsaved: boolean;
}): Message | undefined {
  if (input.message?.key === STEP_LIMIT_TRUNCATION_MESSAGE.key) {
    if (input.reset && input.unsaved) return msg("coach.history.resetUnsavedStepLimit");
    if (input.reset) return msg("coach.history.resetStepLimit");
    if (input.unsaved) return msg("coach.history.unsavedStepLimit");
  }
  const vars = { reply: input.reply };
  if (input.reset && input.unsaved) return msg("coach.history.resetUnsavedReply", vars);
  if (input.reset) return msg("coach.history.resetReply", vars);
  if (input.unsaved) return msg("coach.history.unsavedReply", vars);
  return input.message;
}

export type TurnFailure = FailureReason | "budget";

export interface TurnFailureRoute {
  readonly provider: EngineLlmProvider;
  readonly claudeCliBilling: "subscription" | "api-key" | undefined;
}

export interface TurnFailurePresentation {
  readonly kind: AgentErrorKind;
  readonly message: Message;
}

const PROVIDER_NAMES = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "openai-codex": "ChatGPT",
  "claude-cli": "Claude Code",
  "codex-agent": "Codex",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  minimax: "MiniMax",
  kimi: "Kimi",
  zai: "Z.AI",
  openrouter: "OpenRouter",
} as const satisfies Record<EngineLlmProvider, string>;

const UNKNOWN_FAILURE = { kind: "unknown", message: msg("coach.error.unknown") } as const;

function signedOut(provider: string): TurnFailurePresentation {
  return { kind: "subscription-signed-out", message: msg("coach.error.reauthSetup", { provider }) };
}

function signsInWithSubscription(route: TurnFailureRoute): boolean {
  if (route.provider === "claude-cli") return route.claudeCliBilling !== "api-key";
  return isKeylessProvider(route.provider);
}

export function presentTurnFailure(
  failure: TurnFailure,
  route: TurnFailureRoute,
): TurnFailurePresentation {
  const provider = PROVIDER_NAMES[route.provider];
  switch (failure) {
    case "rate_limit":
      return { kind: "rate_limit", message: msg("coach.error.rateLimit") };
    case "reauth":
      return signedOut(PROVIDER_NAMES["openai-codex"]);
    case "auth":
      return signsInWithSubscription(route)
        ? signedOut(provider)
        : { kind: "provider-auth", message: msg("coach.error.providerCredentials") };
    case "server_error":
    case "network":
    case "timeout":
      return { kind: "provider-down", message: msg("coach.error.providerDown") };
    case "payment_required":
      if (route.provider === "openrouter") {
        return {
          kind: "openrouter-credits",
          message: msg("coach.error.openRouterCredits", { openrouter: provider }),
        };
      }
      return isKeylessProvider(route.provider)
        ? UNKNOWN_FAILURE
        : { kind: "provider-credits", message: msg("coach.error.providerCredits", { provider }) };
    case "model_unavailable":
      return {
        kind: "model-unavailable",
        message: msg("coach.error.modelUnavailable", { provider }),
      };
    case "budget":
    case "overflow":
    case "invalid_request":
    case "unknown":
      return UNKNOWN_FAILURE;
  }
}
