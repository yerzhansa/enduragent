import { describe, expect, it } from "vitest";
import type { OnboardingLlmConfiguration } from "../src/onboarding/bridge";
import { CLAUDE_CLI_STATES, type ClaudeCliState } from "../src/onboarding/constants";
import { claudeCliPresentation } from "../src/onboarding/credential-presentation";
import {
  aiRowCopy,
  apiKeyProviders,
  claudeCliNote,
  errorSection,
  laneForProvider,
  offeredLanes,
  type SetupCommit,
  type SetupErrorSection,
  type SetupLane,
} from "../src/onboarding/lanes";
import {
  createOnboardingState,
  withClaudeCliStatus,
  type OnboardingErrorCode,
  type OnboardingState,
} from "../src/onboarding/machine";

const FULL_CONFIGURATION: OnboardingLlmConfiguration = {
  schemaVersion: 1,
  catalogRevision: 7,
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
      provider: "claude-cli",
      defaultModel: "sonnet",
      models: [{ value: "sonnet", label: "Claude Sonnet" }],
    },
  ],
  active: null,
};

const NO_CLAUDE_CLI: OnboardingLlmConfiguration = {
  ...FULL_CONFIGURATION,
  providers: FULL_CONFIGURATION.providers.filter((entry) => entry.provider !== "claude-cli"),
};

function stateWith(claudeCli: ClaudeCliState | null): OnboardingState {
  const base = createOnboardingState();
  return claudeCli === null ? base : withClaudeCliStatus(base, { state: claudeCli });
}

const CLAUDE_CLI_CASES: readonly (ClaudeCliState | null)[] = [null, ...CLAUDE_CLI_STATES];

describe("setup lanes", () => {
  it("maps providers onto the three setup lanes", () => {
    expect(laneForProvider("claude-cli")).toBe("claude-cli");
    expect(laneForProvider("openai-codex")).toBe("openai-codex");
    expect(laneForProvider("anthropic")).toBe("api-key");
    expect(laneForProvider("openrouter")).toBe("api-key");
    expect(laneForProvider(null)).toBeNull();
    expect(laneForProvider(undefined)).toBeNull();
  });

  it("lists only api-key providers as key-bearing", () => {
    expect(apiKeyProviders(FULL_CONFIGURATION).map((entry) => entry.provider)).toEqual([
      "anthropic",
    ]);
    expect(apiKeyProviders(null)).toEqual([]);
  });

  it.each(CLAUDE_CLI_CASES)("offers claude-cli before checking readiness: %s", (claudeCli) => {
    const wizard = stateWith(claudeCli);
    const lanes = offeredLanes(FULL_CONFIGURATION, wizard);
    expect(lanes).toEqual(["claude-cli", "openai-codex", "api-key"]);
  });

  it("keeps a selected claude-cli lane listed even after it degrades", () => {
    const wizard = stateWith("not-logged-in");
    expect(offeredLanes(FULL_CONFIGURATION, wizard, "claude-cli")).toEqual([
      "claude-cli",
      "openai-codex",
      "api-key",
    ]);
    expect(offeredLanes(FULL_CONFIGURATION, wizard, "api-key")).toEqual([
      "claude-cli",
      "openai-codex",
      "api-key",
    ]);
  });

  it("offers nothing when the configuration is unavailable", () => {
    expect(offeredLanes(null, stateWith("ready"))).toEqual([]);
  });

  it("never offers claude-cli when the daemon does not expose it", () => {
    expect(offeredLanes(NO_CLAUDE_CLI, stateWith("ready"))).toEqual(["openai-codex", "api-key"]);
  });

  it("describes the unset row exactly", () => {
    expect(aiRowCopy(null, stateWith(null), false)).toEqual({
      title: "AI that powers your coach",
      subtitle: "Required — Enduragent doesn't include one",
    });
    expect(aiRowCopy(null, stateWith("ready"), true)).toEqual({
      title: "AI that powers your coach",
      subtitle: "Required — Enduragent doesn't include one",
    });
  });

  it.each([
    {
      lane: "claude-cli",
      ready: false,
      subtitle: "Powers your coach · sign in from a terminal to finish",
    },
    { lane: "openai-codex", ready: false, subtitle: "Powers your coach · sign in to finish" },
    { lane: "api-key", ready: false, subtitle: "Powers your coach · add a key to finish" },
    { lane: "openai-codex", ready: true, subtitle: "Connected · powers your coach" },
    { lane: "api-key", ready: true, subtitle: "Connected · powers your coach" },
  ] as const)("describes the $lane row when ready is $ready", ({ lane, ready, subtitle }) => {
    const titles: Readonly<Record<SetupLane, string>> = {
      "claude-cli": "Claude Code",
      "openai-codex": "ChatGPT subscription",
      "api-key": "API key",
    };
    expect(aiRowCopy(lane, stateWith(null), ready)).toEqual({ title: titles[lane], subtitle });
  });

  it("carries the claude-cli identity into a ready row", () => {
    const wizard = withClaudeCliStatus(createOnboardingState(), {
      state: "ready",
      email: "athlete@example.test",
      plan: "Max",
    });
    expect(aiRowCopy("claude-cli", wizard, true)).toEqual({
      title: "Claude Code",
      subtitle: "Powers your coach · Signed in as athlete@example.test - Claude Max subscription",
    });
  });

  it.each(CLAUDE_CLI_CASES)("explains a selected unready claude-cli lane: %s", (claudeCli) => {
    const wizard = stateWith(claudeCli);
    const note = claudeCliNote(FULL_CONFIGURATION, wizard, "claude-cli");
    if (claudeCli === "ready" || claudeCli === "ready-api-key") {
      expect(note).toBeNull();
      return;
    }
    if (claudeCli === null) {
      expect(note).toBe("Choose Check again to verify Claude Code on this Mac.");
      return;
    }
    expect(note).toBe(claudeCliPresentation(claudeCli).detail);
    expect(note).not.toBeNull();
  });

  it("stays silent about claude-cli when the daemon does not expose it", () => {
    expect(claudeCliNote(NO_CLAUDE_CLI, stateWith("not-logged-in"), "claude-cli")).toBeNull();
    expect(claudeCliNote(null, stateWith("not-logged-in"), "claude-cli")).toBeNull();
  });

  it("offers an explicit check without claiming an idle probe is running", () => {
    expect(claudeCliNote(FULL_CONFIGURATION, stateWith(null), "claude-cli")).toBe(
      "Choose Check again to verify Claude Code on this Mac.",
    );
  });

  it("routes every error code to the row that owns it", () => {
    const expected: Readonly<
      Record<OnboardingErrorCode, Readonly<Record<"provider" | "training", SetupErrorSection>>>
    > = {
      "credential-required": { provider: "provider", training: "provider" },
      "configuration-unavailable": { provider: "provider", training: "provider" },
      "model-selection-required": { provider: "provider", training: "provider" },
      "endpoint-invalid": { provider: "provider", training: "provider" },
      "model-runtime-unavailable": { provider: "provider", training: "provider" },
      "training-account-mismatch": { provider: "training", training: "training" },
      "intervals-clipboard-unavailable": { provider: "training", training: "training" },
      "intervals-clipboard-clear-failed": { provider: "training", training: "training" },
      "intervals-key-rejected": { provider: "training", training: "training" },
      "intervals-validation-unavailable": { provider: "training", training: "training" },
      "intervals-owner-unavailable": { provider: "training", training: "training" },
      "intervals-storage-uncertain": { provider: "training", training: "training" },
      "intervals-runtime-unavailable": { provider: "training", training: "training" },
      "intervals-runtime-uncertain": { provider: "training", training: "training" },
      "training-data-required": { provider: "training", training: "training" },
      "intake-incomplete": { provider: "intake", training: "intake" },
      "intake-save-failed": { provider: "intake", training: "intake" },
      "credential-save-failed": { provider: "provider", training: "training" },
      "invalid-input": { provider: "provider", training: "training" },
      "encryption-unavailable": { provider: "provider", training: "training" },
      "unsafe-backend": { provider: "provider", training: "training" },
      "storage-failed": { provider: "provider", training: "training" },
      "storage-uncertain": { provider: "provider", training: "training" },
      "runtime-unavailable": { provider: "provider", training: "training" },
      "credential-status-unavailable": { provider: "provider", training: "training" },
      "credential-reenter-required": { provider: "provider", training: "training" },
    };
    for (const [code, sections] of Object.entries(expected) as ReadonlyArray<
      [OnboardingErrorCode, Readonly<Record<"provider" | "training", SetupErrorSection>>]
    >) {
      expect(errorSection(code, "provider")).toBe(sections.provider);
      expect(errorSection(code, "training")).toBe(sections.training);
    }
  });

  it.each([null, "provider", "training"] as const satisfies readonly SetupCommit[])(
    "keeps the footer as the resting place for no error (%s)",
    (commit) => {
      expect(errorSection(null, commit)).toBe("footer");
    },
  );

  it("falls back to the footer for a credential write with no owning panel", () => {
    expect(errorSection("credential-save-failed", null)).toBe("footer");
  });
});
