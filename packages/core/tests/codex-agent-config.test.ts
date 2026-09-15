import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmProviderSchema } from "@enduragent/coach-contract";
import { engineConfigFromConfig } from "../src/agent/engine-host-adapter.js";
import { bundledAcceptedCatalog } from "../src/model-catalog.js";
import { codexAgentPatchFrom, loadConfigFromYaml, type Config } from "../src/config.js";
import {
  CODEX_AGENT_DISABLED_MESSAGE,
  CODEX_AGENT_WINDOWS_MESSAGE,
  COMPACT_MODEL_DEFAULTS,
  DEFAULT_MODELS,
  KEYLESS_LLM_PROVIDERS,
  LLM_MODEL_CATALOGUE,
  LLM_PROVIDERS,
  PROVIDER_BASE_URLS,
  contextWindowForModel,
  isKeylessProvider,
  resolveRuntimeConfig,
} from "../src/runtime-config.js";

const MANAGED_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_FLUSH_MODEL",
  "LLM_COMPACT_MODEL",
  "LLM_BASE_URL",
  "CONTEXT_WINDOW_TOKENS",
  "INTERVALS_API_KEY",
  "INTERVALS_ATHLETE_ID",
  "TELEGRAM_BOT_TOKEN",
  "CODEX_CLI_PATH",
];

let configDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cc-codex-agent-"));
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
  rmSync(configDir, { recursive: true, force: true });
});

function load(llm: Record<string, unknown>): Config {
  return loadConfigFromYaml({ llm }, configDir);
}

describe("codex-agent provider union", () => {
  it("registers the provider immediately after claude-cli in every copy", () => {
    expect(LLM_PROVIDERS.indexOf("codex-agent")).toBe(LLM_PROVIDERS.indexOf("claude-cli") + 1);
    expect(LlmProviderSchema.options.indexOf("codex-agent")).toBe(
      LlmProviderSchema.options.indexOf("claude-cli") + 1,
    );
    expect([...LlmProviderSchema.options]).toEqual([...LLM_PROVIDERS]);
  });

  it("is keyless and carries no api key", () => {
    expect(isKeylessProvider("codex-agent")).toBe(true);
    expect([...KEYLESS_LLM_PROVIDERS]).toContain("codex-agent");
  });
});

describe("codex-agent flag-off registry", () => {
  it("is absent from the model catalogue so neither picker can offer it", () => {
    expect(LLM_MODEL_CATALOGUE.map((entry) => entry.provider)).not.toContain("codex-agent");
    expect(LLM_MODEL_CATALOGUE.map((entry) => entry.provider)).toEqual(
      LLM_PROVIDERS.filter((provider) => provider !== "codex-agent"),
    );
  });

  it("keeps the registry deltas minimal", () => {
    expect(DEFAULT_MODELS["codex-agent"]).toBe("gpt-5.6-sol");
    expect(COMPACT_MODEL_DEFAULTS).not.toHaveProperty("codex-agent");
    expect(PROVIDER_BASE_URLS).not.toHaveProperty("codex-agent");
    expect(contextWindowForModel("gpt-5.6-sol", "codex-agent")).toBe(1_050_000);
  });

  it("publishes the flag-off refusal messages", () => {
    expect(CODEX_AGENT_DISABLED_MESSAGE).toBe(
      "The Codex agent provider is not enabled on this instance (set llm.codex_agent.enabled: true in config.yaml). It is experimental and off by default.",
    );
    expect(CODEX_AGENT_WINDOWS_MESSAGE).toBe(
      "The Codex agent provider is not supported on Windows yet (macOS and Linux only). Track the Windows lane in the project backlog.",
    );
  });
});

describe("codex-agent runtime resolution", () => {
  it("refuses an api key", () => {
    expect(() =>
      resolveRuntimeConfig({ llm: { provider: "codex-agent", apiKey: "obviously-fake-key" } }),
    ).toThrow(/llm.apiKey must be absent for codex-agent/);
  });

  it("refuses a base url because the CLI owns its endpoint", () => {
    expect(() =>
      resolveRuntimeConfig({
        llm: { provider: "codex-agent", baseUrl: "https://api.example.invalid/v1" },
      }),
    ).toThrow(/llm.baseUrl must be absent for codex-agent/);
  });

  it("refuses the codexAgent block under any other provider", () => {
    expect(() =>
      resolveRuntimeConfig({ llm: { provider: "anthropic", codexAgent: { enabled: true } } }),
    ).toThrow(/llm.codexAgent must be absent/);
  });

  it("attaches a disabled block by default", () => {
    const resolved = resolveRuntimeConfig({ llm: { provider: "codex-agent" } });
    expect(resolved.llm.apiKey).toBe("");
    expect(resolved.llm.baseUrl).toBeUndefined();
    expect(resolved.llm.authProfile).toBeUndefined();
    expect(resolved.llm.model).toBe("gpt-5.6-sol");
    expect(resolved.llm.compactModel).toBe("gpt-5.6-sol");
    expect(resolved.llm.codexAgent).toEqual({ enabled: false });
    expect(resolved.contextWindowTokens).toBe(1_050_000);
  });

  it("takes an explicit opt-in without inventing other fields", () => {
    const resolved = resolveRuntimeConfig({
      llm: {
        provider: "codex-agent",
        codexAgent: {
          enabled: true,
          binaryPath: "/opt/synthetic/bin/codex",
          reasoningEffort: "medium",
        },
      },
    });
    expect(resolved.llm.codexAgent).toEqual({
      enabled: true,
      binaryPath: "/opt/synthetic/bin/codex",
      reasoningEffort: "medium",
    });
  });

  it("rejects unknown fields and out-of-enum values", () => {
    expect(() =>
      resolveRuntimeConfig({
        llm: {
          provider: "codex-agent",
          codexAgent: { billing: "subscription" } as unknown as { enabled: boolean },
        },
      }),
    ).toThrow(/Unknown llm.codexAgent field: billing/);
    expect(() =>
      resolveRuntimeConfig({
        llm: {
          provider: "codex-agent",
          codexAgent: { enabled: "yes" as unknown as boolean },
        },
      }),
    ).toThrow(/llm.codexAgent.enabled must be a boolean/);
    expect(() =>
      resolveRuntimeConfig({
        llm: {
          provider: "codex-agent",
          codexAgent: { reasoningEffort: "extreme" as unknown as "high" },
        },
      }),
    ).toThrow(/llm.codexAgent.reasoningEffort/);
  });

  it("carries the block across a patch that keeps the provider", () => {
    const current = resolveRuntimeConfig({
      llm: { provider: "codex-agent", codexAgent: { enabled: true, reasoningEffort: "high" } },
    });
    const next = resolveRuntimeConfig({ llm: { model: "gpt-5.6-terra" } }, current);
    expect(next.llm.codexAgent).toEqual({ enabled: true, reasoningEffort: "high" });
  });

  it("drops the block when the provider changes away", () => {
    const current = resolveRuntimeConfig({
      llm: { provider: "codex-agent", codexAgent: { enabled: true } },
    });
    const next = resolveRuntimeConfig(
      { llm: { provider: "anthropic", apiKey: "obviously-fake-key" } },
      current,
    );
    expect(next.llm.codexAgent).toBeUndefined();
  });

  it("omits the block for every other provider", () => {
    expect(
      resolveRuntimeConfig({ llm: { provider: "anthropic", apiKey: "obviously-fake-key" } }).llm
        .codexAgent,
    ).toBeUndefined();
  });
});

describe("codex-agent config loading", () => {
  it("defaults enabled to false when the yaml block is absent", () => {
    expect(load({ provider: "codex-agent" }).llm.codexAgent).toEqual({ enabled: false });
  });

  it("defaults enabled to false when the yaml block omits the flag", () => {
    expect(
      load({ provider: "codex-agent", codex_agent: { binary_path: "/opt/synthetic/bin/codex" } })
        .llm.codexAgent,
    ).toEqual({ enabled: false, binaryPath: "/opt/synthetic/bin/codex" });
  });

  it("reads the opt-in yaml block without requiring a key", () => {
    const config = load({
      provider: "codex-agent",
      codex_agent: {
        enabled: true,
        binary_path: "/opt/synthetic/bin/codex",
        reasoning_effort: "high",
      },
    });
    expect(config.llm.apiKey).toBe("");
    expect(config.llm.codexAgent).toEqual({
      enabled: true,
      binaryPath: "/opt/synthetic/bin/codex",
      reasoningEffort: "high",
    });
  });

  it("ignores llm api key env for the keyless lane", () => {
    process.env.LLM_API_KEY = "obviously-fake-key";
    process.env.OPENAI_API_KEY = "obviously-fake-key";
    expect(load({ provider: "codex-agent" }).llm.apiKey).toBe("");
  });

  it("refuses LLM_BASE_URL for this provider", () => {
    process.env.LLM_BASE_URL = "https://api.example.invalid/v1";
    expect(() => load({ provider: "codex-agent" })).toThrow(/llm.baseUrl must be absent/);
  });

  it("lets CODEX_CLI_PATH override the yaml binary path", () => {
    process.env.CODEX_CLI_PATH = "/synthetic/override/codex";
    const config = load({
      provider: "codex-agent",
      codex_agent: { enabled: true, binary_path: "/opt/synthetic/bin/codex" },
    });
    expect(config.llm.codexAgent?.binaryPath).toBe("/synthetic/override/codex");
  });

  it("has no enable or disable environment override", () => {
    const patch = codexAgentPatchFrom(
      { enabled: false },
      { ENDURAGENT_CODEX_AGENT_DISABLED: "1", ENDURAGENT_CODEX_AGENT_ENABLED: "1" },
    );
    expect(patch).toEqual({ enabled: false });
  });

  it("reads the binary path only from the injected environment", () => {
    process.env.CODEX_CLI_PATH = "/synthetic/process-env/codex";
    expect(codexAgentPatchFrom({}, {})).toEqual({});
    expect(codexAgentPatchFrom({}, { CODEX_CLI_PATH: "/synthetic/injected/codex" })).toEqual({
      binaryPath: "/synthetic/injected/codex",
    });
  });
});

describe("codex-agent engine config mapping", () => {
  it("maps the block with no derived on-disk path", () => {
    const config = loadConfigFromYaml(
      {
        data_dir: join(configDir, "data"),
        llm: {
          provider: "codex-agent",
          codex_agent: {
            enabled: true,
            binary_path: "/opt/synthetic/bin/codex",
            reasoning_effort: "low",
          },
        },
      },
      configDir,
    );
    expect(
      engineConfigFromConfig(config, { catalog: bundledAcceptedCatalog() }).llm.codexAgent,
    ).toEqual({
      enabled: true,
      binaryPath: "/opt/synthetic/bin/codex",
      reasoningEffort: "low",
    });
    expect(
      engineConfigFromConfig(config, { catalog: bundledAcceptedCatalog() }).llm.claudeCli,
    ).toBeUndefined();
  });

  it("omits the engine block for other providers", () => {
    process.env.ANTHROPIC_API_KEY = "obviously-fake-key";
    const config = loadConfigFromYaml({ llm: { provider: "anthropic" } }, configDir);
    expect(
      engineConfigFromConfig(config, { catalog: bundledAcceptedCatalog() }).llm.codexAgent,
    ).toBeUndefined();
  });
});
