import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineConfigFromConfig } from "../src/agent/engine-host-adapter.js";
import { loadConfigFromYaml, type Config } from "../src/config.js";
import {
  COMPACT_MODEL_DEFAULTS,
  DEFAULT_MODELS,
  LLM_MODEL_CATALOGUE,
  LLM_PROVIDERS,
  contextWindowForModel,
  resolveRuntimeConfig,
} from "../src/runtime-config.js";

const MANAGED_ENV = [
  "ANTHROPIC_API_KEY",
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
  "CLAUDE_CLI_PATH",
  "ENDURAGENT_CLAUDE_CLI_DISABLED",
];

let configDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cc-claude-cli-"));
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

describe("claude-cli provider registry", () => {
  it("registers the provider immediately after openai-codex", () => {
    expect(LLM_PROVIDERS.indexOf("claude-cli")).toBe(LLM_PROVIDERS.indexOf("openai-codex") + 1);
    expect(LLM_MODEL_CATALOGUE.map((entry) => entry.provider)).toEqual(
      LLM_PROVIDERS.filter((provider) => provider !== "codex-agent"),
    );
  });

  it("publishes the subscription catalogue entry", () => {
    const entry = LLM_MODEL_CATALOGUE.find((candidate) => candidate.provider === "claude-cli");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Claude subscription (Claude Code CLI)");
    expect(entry?.hint).toBe("experimental");
    expect(entry?.defaultBaseUrl).toBeUndefined();
    expect(entry?.models.map((model) => model.value)).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("defaults the chat model to sonnet and the compaction model to haiku", () => {
    expect(DEFAULT_MODELS["claude-cli"]).toBe("sonnet");
    expect(COMPACT_MODEL_DEFAULTS["claude-cli"]).toBe("haiku");
  });
});

describe("claude-cli context windows", () => {
  it.each(["sonnet", "opus", "haiku"])("resolves the %s alias to 200k", (model) => {
    expect(contextWindowForModel(model)).toBe(200_000);
  });

  it.each(["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-haiku-9-9-19990101"])(
    "normalizes the pinned full id %s to its family alias",
    (model) => {
      expect(contextWindowForModel(model)).toBe(200_000);
    },
  );

  it("keeps exact catalogue entries ahead of family normalization for api lanes", () => {
    expect(contextWindowForModel("claude-sonnet-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-opus-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-sonnet-4-6", "anthropic")).toBe(1_000_000);
  });

  it.each(["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-8"])(
    "normalizes %s to its family alias before the lookup on the claude-cli lane",
    (model) => {
      expect(contextWindowForModel(model, "claude-cli")).toBe(200_000);
    },
  );

  it("still falls back for ids with no family match", () => {
    expect(contextWindowForModel("obviously-unknown-model")).toBe(200_000);
    expect(contextWindowForModel("obviously-unknown-model", "claude-cli")).toBe(200_000);
  });
});

describe("claude-cli runtime resolution", () => {
  it("refuses an api key", () => {
    expect(() =>
      resolveRuntimeConfig({ llm: { provider: "claude-cli", apiKey: "obviously-fake-key" } }),
    ).toThrow(/llm.apiKey must be absent for claude-cli/);
  });

  it("refuses a base url because the CLI owns its endpoint", () => {
    expect(() =>
      resolveRuntimeConfig({
        llm: { provider: "claude-cli", baseUrl: "https://api.example.invalid/v1" },
      }),
    ).toThrow(/llm.baseUrl must be absent for claude-cli/);
  });

  it("refuses the claudeCli block under any other provider", () => {
    expect(() =>
      resolveRuntimeConfig({ llm: { provider: "anthropic", claudeCli: { enabled: false } } }),
    ).toThrow(/llm.claudeCli must be absent/);
  });

  it("attaches an enabled subscription block by default", () => {
    const resolved = resolveRuntimeConfig({ llm: { provider: "claude-cli" } });
    expect(resolved.llm.apiKey).toBe("");
    expect(resolved.llm.baseUrl).toBeUndefined();
    expect(resolved.llm.authProfile).toBeUndefined();
    expect(resolved.llm.model).toBe("sonnet");
    expect(resolved.llm.compactModel).toBe("haiku");
    expect(resolved.llm.claudeCli).toEqual({ enabled: true, billing: "subscription" });
  });

  it("resolves a pinned full model id to the 200k lane window", () => {
    const resolved = resolveRuntimeConfig({
      llm: { provider: "claude-cli", model: "claude-sonnet-4-6" },
    });
    expect(resolved.contextWindowTokens).toBe(200_000);
  });

  it("omits the block for every other provider", () => {
    expect(
      resolveRuntimeConfig({ llm: { provider: "anthropic", apiKey: "obviously-fake-key" } }).llm
        .claudeCli,
    ).toBeUndefined();
  });

  it("rejects a non-boolean enabled flag and an unknown billing mode", () => {
    expect(() =>
      resolveRuntimeConfig({
        llm: { provider: "claude-cli", claudeCli: { enabled: "yes" as unknown as boolean } },
      }),
    ).toThrow(/llm.claudeCli.enabled must be a boolean/);
    expect(() =>
      resolveRuntimeConfig({
        llm: {
          provider: "claude-cli",
          claudeCli: { billing: "invoice" as unknown as "api-key" },
        },
      }),
    ).toThrow(/llm.claudeCli.billing/);
  });

  it("carries the block across a patch that keeps the provider", () => {
    const current = resolveRuntimeConfig({
      llm: {
        provider: "claude-cli",
        claudeCli: { binaryPath: "/opt/synthetic/bin/claude", billing: "api-key" },
      },
    });
    const next = resolveRuntimeConfig({ llm: { model: "opus" } }, current);
    expect(next.llm.claudeCli).toEqual({
      enabled: true,
      binaryPath: "/opt/synthetic/bin/claude",
      billing: "api-key",
    });
  });

  it("drops the block when the provider changes away", () => {
    const current = resolveRuntimeConfig({ llm: { provider: "claude-cli" } });
    const next = resolveRuntimeConfig(
      { llm: { provider: "anthropic", apiKey: "obviously-fake-key" } },
      current,
    );
    expect(next.llm.claudeCli).toBeUndefined();
  });
});

describe("claude-cli config loading", () => {
  it("reads the yaml block without requiring a key", () => {
    const config = load({
      provider: "claude-cli",
      claude_cli: {
        enabled: true,
        binary_path: "/opt/synthetic/bin/claude",
        config_dir: "/synthetic/claude-config",
        billing: "api-key",
      },
    });
    expect(config.llm.apiKey).toBe("");
    expect(config.llm.claudeCli).toEqual({
      enabled: true,
      binaryPath: "/opt/synthetic/bin/claude",
      configDir: "/synthetic/claude-config",
      billing: "api-key",
    });
  });

  it("ignores llm.api_key env for the keyless lane", () => {
    process.env.LLM_API_KEY = "obviously-fake-key";
    process.env.ANTHROPIC_API_KEY = "obviously-fake-key";
    expect(load({ provider: "claude-cli" }).llm.apiKey).toBe("");
  });

  it("refuses LLM_BASE_URL for this provider", () => {
    process.env.LLM_BASE_URL = "https://api.example.invalid/v1";
    expect(() => load({ provider: "claude-cli" })).toThrow(/llm.baseUrl must be absent/);
  });

  it("lets CLAUDE_CLI_PATH override the yaml binary path", () => {
    process.env.CLAUDE_CLI_PATH = "/synthetic/override/claude";
    const config = load({
      provider: "claude-cli",
      claude_cli: { binary_path: "/opt/synthetic/bin/claude" },
    });
    expect(config.llm.claudeCli?.binaryPath).toBe("/synthetic/override/claude");
  });

  it("defaults to enabled with subscription billing", () => {
    expect(load({ provider: "claude-cli" }).llm.claudeCli).toEqual({
      enabled: true,
      billing: "subscription",
    });
  });

  it("honours the yaml kill switch", () => {
    expect(
      load({ provider: "claude-cli", claude_cli: { enabled: false } }).llm.claudeCli?.enabled,
    ).toBe(false);
  });

  it.each(["1", "true", "TRUE", " True "])(
    "honours the env kill switch value %j over an enabled yaml block",
    (value) => {
      process.env.ENDURAGENT_CLAUDE_CLI_DISABLED = value;
      expect(
        load({ provider: "claude-cli", claude_cli: { enabled: true } }).llm.claudeCli?.enabled,
      ).toBe(false);
    },
  );

  it.each(["0", "false", "", "no"])(
    "leaves the yaml value in charge for the non-disabling env value %j",
    (value) => {
      process.env.ENDURAGENT_CLAUDE_CLI_DISABLED = value;
      expect(load({ provider: "claude-cli" }).llm.claudeCli?.enabled).toBe(true);
      expect(
        load({ provider: "claude-cli", claude_cli: { enabled: false } }).llm.claudeCli?.enabled,
      ).toBe(false);
    },
  );
});

describe("claude-cli engine config mapping", () => {
  it("maps the block plus a cursor store path under the data dir", () => {
    const config = loadConfigFromYaml(
      {
        data_dir: join(configDir, "data"),
        llm: {
          provider: "claude-cli",
          claude_cli: { binary_path: "/opt/synthetic/bin/claude" },
        },
      },
      configDir,
    );
    expect(engineConfigFromConfig(config).llm.claudeCli).toEqual({
      enabled: true,
      binaryPath: "/opt/synthetic/bin/claude",
      billing: "subscription",
      cursorStorePath: join(configDir, "data", "claude-cli-sessions.json"),
    });
  });

  it("omits the engine block for other providers", () => {
    process.env.ANTHROPIC_API_KEY = "obviously-fake-key";
    const config = loadConfigFromYaml({ llm: { provider: "anthropic" } }, configDir);
    expect(engineConfigFromConfig(config).llm.claudeCli).toBeUndefined();
  });
});
