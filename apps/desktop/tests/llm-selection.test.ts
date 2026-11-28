import { describe, expect, it } from "vitest";
import {
  isClaudeCliLaneEligible,
  parseChatGptLlmSelection,
  parseClaudeCliLlmSelection,
  runtimeConfigurationForSelection,
  savedModel,
  type OnboardingLlmProviderConfiguration,
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

describe("the saved model the Coach answers with", () => {
  const providers = [
    {
      provider: "anthropic",
      defaultModel: "claude-sonnet-5-5",
      models: [
        { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
        { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
      ],
    },
    {
      provider: "openrouter",
      defaultModel: "z-ai/glm-5.3",
      models: [{ value: "z-ai/glm-5.3", label: "GLM 5.3" }],
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    },
  ] as const satisfies readonly OnboardingLlmProviderConfiguration[];

  it("is listed when the model list offers it", () => {
    expect(savedModel(providers, "anthropic", "claude-opus-5-5")).toEqual({
      provider: "anthropic",
      model: "claude-opus-5-5",
      kind: "listed",
    });
  });

  it("is retired with its listed replacement when the list dropped a kept model", () => {
    expect(savedModel(providers, "anthropic", "claude-opus-5")).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      kind: "retired",
      replacedBy: "claude-opus-5-5",
    });
    expect(savedModel(providers, "openrouter", "z-ai/glm-5.2")).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      kind: "retired",
      replacedBy: "z-ai/glm-5.3",
    });
  });

  it("is retired with no replacement when the list offers none", () => {
    expect(savedModel(providers, "openrouter", "anthropic/claude-fable-5.1")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-fable-5.1",
      kind: "retired",
      replacedBy: null,
    });
    expect(savedModel(providers, "anthropic", "claude-fable-5-1")).toEqual({
      provider: "anthropic",
      model: "claude-fable-5-1",
      kind: "retired",
      replacedBy: null,
    });
  });

  it("is listed again when a newer list offers the dropped model", () => {
    const relisted = [
      {
        ...providers[0],
        models: [...providers[0].models, { value: "claude-opus-5", label: "Claude Opus 5" }],
      },
    ];
    expect(savedModel(relisted, "anthropic", "claude-opus-5")).toMatchObject({ kind: "listed" });
  });

  it("is custom for a model the athlete typed or a provider the list leaves out", () => {
    expect(savedModel(providers, "anthropic", "athlete-typed-model")).toEqual({
      provider: "anthropic",
      model: "athlete-typed-model",
      kind: "custom",
    });
    expect(savedModel(providers, "codex-agent", "gpt-5.6-sol")).toMatchObject({ kind: "custom" });
  });
});
