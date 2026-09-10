import { describe, expect, it } from "vitest";
import { CLAUDE_CLI_STATES } from "../src/onboarding/constants";
import {
  claudeCliIdentityLine,
  claudeCliPresentation,
  credentialPresentation,
} from "../src/onboarding/credential-presentation";
import type { CredentialSlotStatus } from "../src/onboarding/machine";

describe("credential status presentation", () => {
  it("presents active, stored inactive, and failed credentials as distinct states", () => {
    const status = (
      runtimeState: "active" | "stored-inactive" | "failed",
    ): CredentialSlotStatus => ({ slot: "anthropic", state: "configured", runtimeState });

    expect(credentialPresentation(status("active"))).toEqual({
      className: "configured",
      copy: "Configured",
      retryable: false,
    });
    expect(credentialPresentation(status("stored-inactive"))).toEqual({
      className: "stored-inactive",
      copy: "Saved · Not in use",
      retryable: false,
    });
    expect(credentialPresentation(status("failed"))).toEqual({
      className: "failed",
      copy: "Saved · Retry",
      retryable: true,
    });
  });

  it("keeps a dormant API key non-alarming while ChatGPT is active", () => {
    const chatGpt = { state: "configured" as const, runtimeReady: true };
    const dormant: CredentialSlotStatus = {
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    };
    const presentation = credentialPresentation(dormant);

    expect(chatGpt).toEqual({ state: "configured", runtimeReady: true });
    expect(presentation.copy).toBe("Saved · Not in use");
    expect(presentation.retryable).toBe(false);
    expect(presentation.copy).not.toMatch(/error|failed|retry/iu);
  });
});

describe("claude subscription status presentation", () => {
  it("renders the signed-in identity with the plan, and never an undefined plan", () => {
    expect(
      claudeCliIdentityLine({ state: "ready", email: "athlete@example.test", plan: "Max" }),
    ).toBe("Signed in as athlete@example.test - Claude Max subscription");
    expect(claudeCliIdentityLine({ state: "ready", email: "athlete@example.test" })).toBe(
      "Signed in as athlete@example.test",
    );
    expect(claudeCliIdentityLine({ state: "ready", plan: "Pro" })).toBe(
      "Signed in - Claude Pro subscription",
    );
    expect(claudeCliIdentityLine({ state: "ready" })).toBe("Signed in");
    expect(claudeCliIdentityLine({ state: "ready", email: "  ", plan: "  " })).toBe("Signed in");
  });

  it("names api-key billing instead of claiming a subscription", () => {
    expect(claudeCliIdentityLine({ state: "ready-api-key", email: "athlete@example.test" })).toBe(
      "Using Anthropic API key billing - usage is charged to your API account.",
    );
  });

  it("withholds an identity for every unready state", () => {
    for (const state of CLAUDE_CLI_STATES) {
      if (state === "ready" || state === "ready-api-key") continue;
      expect(
        claudeCliIdentityLine({ state, email: "athlete@example.test", plan: "Max" }),
      ).toBeNull();
    }
  });

  it("gives every state a badge, and a detail only when the lane cannot coach", () => {
    for (const state of CLAUDE_CLI_STATES) {
      const presentation = claudeCliPresentation(state);
      expect(presentation.badge.length).toBeGreaterThan(0);
      if (state === "ready" || state === "ready-api-key") {
        expect(presentation.runtimeState).toBe("active");
        expect(presentation.detail).toBeNull();
      } else {
        expect(presentation.runtimeState).not.toBe("active");
        expect(presentation.detail).not.toBeNull();
      }
    }
    expect(claudeCliPresentation("disabled").runtimeState).toBe("stored-inactive");
    expect(claudeCliPresentation(null).detail).toBe(
      "Checking the Claude Code CLI sign-in on this Mac…",
    );
  });
});
