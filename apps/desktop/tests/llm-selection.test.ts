import { describe, expect, it } from "vitest";
import {
  isClaudeCliLaneEligible,
  parseChatGptLlmSelection,
  parseClaudeCliLlmSelection,
  runtimeConfigurationForSelection,
} from "../src/main/llm-selection.js";

describe("desktop claude-cli selection parsing", () => {
  it("accepts a claude-cli selection with an automatic endpoint", () => {
    expect(
      parseClaudeCliLlmSelection({
        catalogRevision: 7,
        provider: "claude-cli",
        model: "  sonnet  ",
        endpoint: { mode: "automatic" },
      }),
    ).toEqual({
      catalogRevision: 7,
      provider: "claude-cli",
      model: "sonnet",
      endpoint: { mode: "automatic" },
    });
  });

  it("builds a keyless runtime request for the lane", () => {
    expect(
      runtimeConfigurationForSelection(
        parseClaudeCliLlmSelection({
          catalogRevision: 7,
          provider: "claude-cli",
          model: "opus",
          endpoint: { mode: "automatic" },
        }),
      ),
    ).toEqual({ llm: { provider: "claude-cli", model: "opus" } });
  });

  it.each([
    [
      "another provider",
      {
        catalogRevision: 7,
        provider: "openai-codex",
        model: "gpt-5.5",
        endpoint: { mode: "automatic" },
      },
    ],
    [
      "a default endpoint",
      {
        catalogRevision: 7,
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "default" },
      },
    ],
    [
      "a custom endpoint",
      {
        catalogRevision: 7,
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "custom", value: "http://127.0.0.1:4321" },
      },
    ],
    ["an unknown key", { catalogRevision: 7, provider: "claude-cli", model: "sonnet" }],
  ])("rejects %s", (_case, selection) => {
    expect(() => parseClaudeCliLlmSelection(selection)).toThrow(TypeError);
  });

  it("keeps the ChatGPT parser pinned to its own provider", () => {
    expect(() =>
      parseChatGptLlmSelection({
        catalogRevision: 7,
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      }),
    ).toThrow(TypeError);
  });
});

describe("desktop claude-cli lane eligibility", () => {
  it.each([
    ["an empty environment", {}, undefined, true],
    ["an enabled flag", {}, true, true],
    ["a disabled flag", {}, false, false],
    ["the kill switch set to 1", { ENDURAGENT_CLAUDE_CLI_DISABLED: "1" }, true, false],
    ["the kill switch set to TRUE", { ENDURAGENT_CLAUDE_CLI_DISABLED: " TRUE " }, undefined, false],
    ["an unrelated kill-switch value", { ENDURAGENT_CLAUDE_CLI_DISABLED: "no" }, undefined, true],
  ])("resolves %s", (_case, environment, enabled, expected) => {
    expect(
      isClaudeCliLaneEligible({
        environment,
        ...(enabled === undefined ? {} : { enabled }),
      }),
    ).toBe(expected);
  });
});
