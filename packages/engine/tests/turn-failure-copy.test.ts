import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, expect, it } from "vitest";
import {
  presentTurnFailure,
  type TurnFailure,
  type TurnFailureRoute,
} from "../src/agent/coach-agent-copy.js";
import type { EngineLlmProvider } from "../src/host-ports.js";

const book = await createPhrasebook({ tag: "en", locale: "en-GB" });

function shown(
  failure: TurnFailure,
  provider: EngineLlmProvider,
  claudeCliBilling?: TurnFailureRoute["claudeCliBilling"],
) {
  const presentation = presentTurnFailure(failure, { provider, claudeCliBilling });
  return { kind: presentation.kind, text: book.say(presentation.message) };
}

const API_KEY_REJECTED = {
  kind: "provider-auth",
  text: "The model provider rejected the API key — check your provider credentials.",
};
const GENERIC = { kind: "unknown", text: "Sorry, something went wrong. Please try again." };

describe("turn failure copy", () => {
  it.each([
    ["claude-cli", "Claude Code"],
    ["codex-agent", "Codex"],
    ["openai-codex", "ChatGPT"],
  ] as const)("tells a %s athlete to sign in again in Setup", (provider, name) => {
    expect(shown("auth", provider)).toEqual({
      kind: "subscription-signed-out",
      text: `Your ${name} sign-in is no longer valid. Open Setup and sign in again.`,
    });
  });

  it("keeps the API-key copy for key providers and for Claude Code on API-key billing", () => {
    expect(shown("auth", "anthropic")).toEqual(API_KEY_REJECTED);
    expect(shown("auth", "openrouter")).toEqual(API_KEY_REJECTED);
    expect(shown("auth", "claude-cli", "api-key")).toEqual(API_KEY_REJECTED);
    expect(shown("auth", "claude-cli", "subscription").kind).toBe("subscription-signed-out");
  });

  it("names ChatGPT for a rejected ChatGPT sign-in refresh", () => {
    expect(shown("reauth", "openai-codex")).toEqual({
      kind: "subscription-signed-out",
      text: "Your ChatGPT sign-in is no longer valid. Open Setup and sign in again.",
    });
  });

  it.each([
    ["deepseek", "DeepSeek"],
    ["openai", "OpenAI"],
    ["kimi", "Kimi"],
    ["zai", "Z.AI"],
  ] as const)("tells a %s athlete to add credits with the provider", (provider, name) => {
    expect(shown("payment_required", provider)).toEqual({
      kind: "provider-credits",
      text: `Your ${name} account doesn’t have enough credits. Add credits with ${name}, then send your message again.`,
    });
  });

  it("keeps OpenRouter's own credits kind and the generic copy on a subscription lane", () => {
    expect(shown("payment_required", "openrouter")).toEqual({
      kind: "openrouter-credits",
      text: "Your OpenRouter account doesn't have enough credits. Add credits on OpenRouter, then send your message again.",
    });
    expect(shown("payment_required", "claude-cli")).toEqual(GENERIC);
  });

  it("tells the athlete to pick another model when the provider no longer serves it", () => {
    expect(shown("model_unavailable", "google")).toEqual({
      kind: "model-unavailable",
      text: "Google no longer serves this model. Pick another model in Settings, Coach, then send your message again.",
    });
  });

  it("keeps the existing copy for the other failures", () => {
    expect(shown("rate_limit", "openai")).toEqual({
      kind: "rate_limit",
      text: "Rate limited — please try again shortly.",
    });
    expect(shown("network", "deepseek").kind).toBe("provider-down");
    for (const failure of ["budget", "overflow", "invalid_request", "unknown"] as const) {
      expect(shown(failure, "anthropic")).toEqual(GENERIC);
    }
  });
});
