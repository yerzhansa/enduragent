import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCredentialId } from "../onboarding/bridge";
import type { ChatGptStatus, CredentialSlotStatus } from "../onboarding/machine";
import { isNonCredentialProvider } from "./provider-status-rows";

export type CredentialKind = "Provider API key" | "ChatGPT profile" | "Training account key";

export interface CredentialSettingsEntry {
  readonly credential: DesktopCredentialId;
  readonly provider: string;
  readonly kind: CredentialKind;
  readonly runtimeState: "active" | "verifying" | "stored-inactive" | "failed";
}

export const PROVIDER_NAMES: Readonly<Record<DesktopCredentialId, string>> = {
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  minimax: "MiniMax",
  kimi: "Kimi",
  zai: "Z.AI",
  "openai-codex": "ChatGPT",
  "intervals-icu": "intervals.icu",
};

const CREDENTIAL_ORDER: readonly DesktopCredentialId[] = [
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
  "intervals-icu",
];

function kind(credential: DesktopCredentialId): CredentialKind {
  if (credential === "openai-codex") return "ChatGPT profile";
  if (credential === "intervals-icu") return "Training account key";
  return "Provider API key";
}

export function belongsInPrimaryAiRow(
  entry: Pick<CredentialSettingsEntry, "credential" | "runtimeState">,
  primaryAiCredential: DesktopCredentialId | null,
): boolean {
  if (entry.credential === "intervals-icu") return false;
  return entry.credential === primaryAiCredential || entry.runtimeState === "active";
}

export function entriesFrom(
  statuses: readonly CredentialSlotStatus[],
  chatGpt: ChatGptStatus,
  runtime: RuntimeConfigSnapshot,
): readonly CredentialSettingsEntry[] {
  const entries = new Map<DesktopCredentialId, CredentialSettingsEntry>();
  const intervalsVerifying =
    runtime.intervals.credential_configured &&
    runtime.intervals.credential_verification_pending === true;
  for (const status of statuses) {
    if (status.state === "missing") continue;
    const runtimeActive =
      status.slot === "intervals-icu"
        ? runtime.intervals.credential_configured
        : runtime.llm.credential_configured && runtime.llm.provider === status.slot;
    entries.set(status.slot, {
      credential: status.slot,
      provider: PROVIDER_NAMES[status.slot],
      kind: kind(status.slot),
      runtimeState:
        status.state === "re-prompt" || status.runtimeState === "failed"
          ? "failed"
          : runtimeActive
            ? status.slot === "intervals-icu" && intervalsVerifying
              ? "verifying"
              : "active"
            : "stored-inactive",
    });
  }
  if (chatGpt.state === "configured") {
    entries.set("openai-codex", {
      credential: "openai-codex",
      provider: PROVIDER_NAMES["openai-codex"],
      kind: kind("openai-codex"),
      runtimeState: chatGpt.runtimeReady ? "active" : "stored-inactive",
    });
  }
  if (
    runtime.llm.credential_configured &&
    !isNonCredentialProvider(runtime.llm.provider) &&
    !entries.has(runtime.llm.provider)
  ) {
    const credential: DesktopCredentialId = runtime.llm.provider;
    entries.set(credential, {
      credential,
      provider: PROVIDER_NAMES[credential],
      kind: kind(credential),
      runtimeState: "active",
    });
  }
  if (runtime.intervals.credential_configured && !entries.has("intervals-icu")) {
    entries.set("intervals-icu", {
      credential: "intervals-icu",
      provider: PROVIDER_NAMES["intervals-icu"],
      kind: kind("intervals-icu"),
      runtimeState: intervalsVerifying ? "verifying" : "active",
    });
  }
  return CREDENTIAL_ORDER.flatMap((credential) => {
    const entry = entries.get(credential);
    return entry === undefined ? [] : [entry];
  });
}
