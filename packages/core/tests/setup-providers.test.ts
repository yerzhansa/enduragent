import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";

import { scriptedPrompts } from "./helpers/scripted-prompts.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

// Ordered prompt contract for a NEW (non-codex) provider with a BASE_URL default:
//   selects: [provider, model, backend]
//   texts:   [base-url]          (custom-model text is skipped by picking a catalog model;
//                                 athlete-id text is skipped by not entering an intervals key)
//   passwords: [llm api_key, intervals (skip), telegram (skip)]

let tempHome: string;
let origHome: string | undefined;
let origStdinTTY: boolean | undefined;
let origStdoutTTY: boolean | undefined;

beforeEach(() => {
  for (const key of ["ENDURAGENT_LANGUAGE", "LANGUAGE", "LC_ALL", "LC_MESSAGES"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("LANG", "en_US.UTF-8");
  tempHome = mkdtempSync(join(tmpdir(), "cc-providers-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  origStdinTTY = process.stdin.isTTY;
  origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.resetModules();
  vi.doMock("../src/secrets/backends/detect.js", () => ({
    detectBackends: vi.fn(async () => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    })),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.HOME = origHome;
  Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CONFIG = () => join(tempHome, ".cycling-coach", "config.yaml");

describe("setup — new providers", () => {
  it("zai fresh install: Enter at base-URL prompt persists the provider default", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["zai", "glm-4.6", "plain"],
        texts: [""], // Enter at the base-URL prompt → falls back to the default
        passwords: ["sk-zai-test", "", ""], // llm key, intervals skip, telegram skip
        confirms: [],
      }),
    );

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("zai");
    expect(cfg.llm.model).toBe("glm-4.6");
    expect(cfg.llm.base_url).toBe("https://api.z.ai/api/openai/v1");
    expect(cfg.llm.api_key).toBe("sk-zai-test");
  });

  it("minimax fresh install: a typed base URL overrides the default", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["minimax", "MiniMax-M2-Stable", "plain"],
        texts: ["https://proxy.example/v1"],
        passwords: ["sk-minimax-test", "", ""],
        confirms: [],
      }),
    );

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("minimax");
    expect(cfg.llm.base_url).toBe("https://proxy.example/v1");
  });

  it("openrouter fresh install: writes a namespaced model id + default base URL", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openrouter", "deepseek/deepseek-chat", "plain"],
        texts: [""],
        passwords: ["sk-or-test", "", ""],
        confirms: [],
      }),
    );

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("openrouter");
    expect(cfg.llm.model).toBe("deepseek/deepseek-chat");
    expect(cfg.llm.base_url).toBe("https://openrouter.ai/api/v1");
  });
});

describe("setup — off-catalogue provider guard", () => {
  function seedOffCatalogue(): void {
    writeFileSync(
      CONFIG(),
      toYaml({
        llm: { provider: "codex-agent", model: "gpt-5.6-sol", codex_agent: { enabled: true } },
        intervals: { athlete_id: "i1" },
      }),
    );
  }

  it("warns, keeps the provider and still runs the rest of the wizard when the operator declines", async () => {
    seedOffCatalogue();
    const prompts = scriptedPrompts({
      selects: ["plain"],
      texts: [""],
      passwords: ["sk-intervals-test", ""],
      confirms: [false, true],
    });
    vi.doMock("@clack/prompts", () => prompts);

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(prompts.log.warn).toHaveBeenCalledWith(
      "Your current provider `codex-agent` is not offered by the wizard; re-running setup will replace it.",
    );

    const promptMessages = (calls: unknown[][]): string[] =>
      calls.map(([options]) => (options as { message: string }).message);

    const selectMessages = promptMessages(prompts.select.mock.calls);
    expect(selectMessages).not.toContain("LLM provider");
    expect(selectMessages).not.toContain("Model");
    expect(selectMessages).toContain("Where to store secrets?");

    const passwordMessages = promptMessages(prompts.password.mock.calls);
    expect(passwordMessages.some((message) => message.includes("intervals.icu API key"))).toBe(
      true,
    );
    expect(passwordMessages.some((message) => message.includes("Telegram bot token"))).toBe(true);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("codex-agent");
    expect(cfg.llm.model).toBe("gpt-5.6-sol");
    expect(cfg.llm.codex_agent).toEqual({ enabled: true });
    expect(cfg.intervals.api_key).toBe("sk-intervals-test");
  });

  it("replaces the provider once the operator confirms", async () => {
    seedOffCatalogue();
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["zai", "glm-4.6", "plain"],
        texts: [""],
        passwords: ["sk-zai-test", "", ""],
        confirms: [true, true],
      }),
    );

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const cfg = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(cfg.llm.provider).toBe("zai");
    expect(cfg.llm.codex_agent).toBeUndefined();
  });
});
