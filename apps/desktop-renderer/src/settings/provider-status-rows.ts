import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { ClaudeCliState } from "../onboarding/constants";
import {
  claudeCliIdentityLine,
  claudeCliPresentation,
} from "../onboarding/credential-presentation";
import type { ClaudeCliStatus } from "../onboarding/machine";

export const NON_CREDENTIAL_PROVIDERS = ["claude-cli", "codex-agent"] as const;

export type NonCredentialProviderId = (typeof NON_CREDENTIAL_PROVIDERS)[number];

export type NonCredentialProviderKind = "Claude Code CLI" | "Codex CLI";

export interface ProviderStatusEntry {
  readonly provider: NonCredentialProviderId;
  readonly label: string;
  readonly kind: NonCredentialProviderKind;
  readonly state: ClaudeCliState | null;
  readonly identity: string | null;
}

const NON_CREDENTIAL_PROVIDER_ROWS: Readonly<
  Record<NonCredentialProviderId, Pick<ProviderStatusEntry, "provider" | "label" | "kind">>
> = {
  "claude-cli": {
    provider: "claude-cli",
    label: "Claude subscription",
    kind: "Claude Code CLI",
  },
  "codex-agent": {
    provider: "codex-agent",
    label: "Codex agent",
    kind: "Codex CLI",
  },
};

export function isNonCredentialProvider(provider: string): provider is NonCredentialProviderId {
  return (NON_CREDENTIAL_PROVIDERS as readonly string[]).includes(provider);
}

export function providerStatusesFrom(
  runtime: RuntimeConfigSnapshot,
  claudeCli: ClaudeCliStatus | null = null,
): readonly ProviderStatusEntry[] {
  const provider = runtime.llm.provider;
  if (!isNonCredentialProvider(provider)) return [];
  if (provider === "codex-agent") {
    return [{ ...NON_CREDENTIAL_PROVIDER_ROWS[provider], state: null, identity: null }];
  }
  const state = claudeCli?.state ?? null;
  const identity = claudeCli === null ? null : claudeCliIdentityLine(claudeCli);
  return [
    {
      ...NON_CREDENTIAL_PROVIDER_ROWS[provider],
      state,
      identity: identity ?? claudeCliPresentation(state).detail,
    },
  ];
}
