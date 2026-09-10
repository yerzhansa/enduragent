import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";

import { scriptedPrompts } from "./helpers/scripted-prompts.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

let tempHome: string;
let origHome: string | undefined;
let origStdinTTY: boolean | undefined;
let origStdoutTTY: boolean | undefined;

beforeEach(() => {
  for (const key of ["ENDURAGENT_LANGUAGE", "LANGUAGE", "LC_ALL", "LC_MESSAGES"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("LANG", "en_US.UTF-8");
  tempHome = mkdtempSync(join(tmpdir(), "cc-merge-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  origStdinTTY = process.stdin.isTTY;
  origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  vi.resetModules();
  // Default to op unavailable + keychain unavailable so backend-choice
  // shows only "plain" by default. Tests that need backend detection behavior
  // override this with their own vi.doMock.
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
const PROFILES = () => join(tempHome, ".cycling-coach", "auth-profiles.json");

function seedConfig(obj: Record<string, unknown>): void {
  writeFileSync(CONFIG(), toYaml(obj), { mode: 0o600 });
}

describe("setup merge", () => {
  it("Case A: switching provider to Codex preserves intervals and telegram", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-ant-keep" },
      intervals: { api_key: "intv-keep", athlete_id: "i42" },
      telegram: { bot_token: "tg-keep" },
    });

    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openai-codex", "gpt-5.4", "plain"], // provider, model, backend
        passwords: ["", ""], // intervals Enter-to-keep, telegram Enter-to-keep
        texts: [],
        confirms: [true], // update config
      }),
    );
    vi.doMock("../src/auth/openai-codex-login.js", () => ({
      runCodexLogin: vi.fn(async () => ({
        type: "oauth",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 3_600_000,
      })),
    }));

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const merged = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(merged.llm.provider).toBe("openai-codex");
    expect(merged.llm.model).toBe("gpt-5.4");
    expect(merged.llm.api_key).toBeUndefined();
    expect(merged.llm.auth_profile).toBe("openai-codex");
    expect(merged.intervals).toEqual({ api_key: "intv-keep", athlete_id: "i42" });
    expect(merged.telegram).toEqual({ bot_token: "tg-keep" });

    const saved = JSON.parse(readFileSync(PROFILES(), "utf-8"));
    expect(saved["openai-codex"].access).toBe("fresh-access");
  });

  it("Case B: declining the update confirm leaves both files untouched", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-ant-keep" },
      intervals: { api_key: "intv-keep", athlete_id: "i42" },
      telegram: { bot_token: "tg-keep" },
    });
    const before = readFileSync(CONFIG(), "utf-8");

    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openai-codex", "gpt-5.4", "plain"], // provider, model, backend
        passwords: ["", ""],
        texts: [],
        confirms: [false], // decline update
      }),
    );
    vi.doMock("../src/auth/openai-codex-login.js", () => ({
      runCodexLogin: vi.fn(async () => ({
        type: "oauth",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: Date.now() + 3_600_000,
      })),
    }));

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(readFileSync(CONFIG(), "utf-8")).toBe(before);
    expect(existsSync(PROFILES())).toBe(false);
  });

  it("Case C: fresh install writes full config without requiring merge", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openai-codex", "gpt-5.4", "plain"], // provider, model, backend
        passwords: ["", ""],
        texts: [],
        confirms: [],
      }),
    );
    vi.doMock("../src/auth/openai-codex-login.js", () => ({
      runCodexLogin: vi.fn(async () => ({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: Date.now() + 3_600_000,
      })),
    }));

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const config = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(config.llm).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
      auth_profile: "openai-codex",
    });
    expect(config.intervals).toBeUndefined();
    expect(config.telegram).toBeUndefined();
    expect(existsSync(PROFILES())).toBe(true);
  });

  it("Case D: OAuth login failure leaves config.yaml and auth-profiles.json untouched", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-ant-keep" },
      intervals: { api_key: "intv-keep", athlete_id: "i42" },
    });
    const before = readFileSync(CONFIG(), "utf-8");

    // Case D: OAuth fails BEFORE backend-choice — only 2 selects needed.
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openai-codex", "gpt-5.4"],
        passwords: [],
        texts: [],
        confirms: [],
      }),
    );
    vi.doMock("../src/auth/openai-codex-login.js", () => ({
      runCodexLogin: vi.fn(async () => {
        throw new Error("OAuth cancelled by user");
      }),
    }));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);

    const { runSetup } = await import("../src/setup.js");
    await expect(runSetup(cyclingBinary)).rejects.toThrow(/__exit_1/);

    expect(readFileSync(CONFIG(), "utf-8")).toBe(before);
    expect(existsSync(PROFILES())).toBe(false);
    exitSpy.mockRestore();
  });

  it("preserves unknown top-level keys on merge", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-ant-keep" },
      data_dir: "/custom/dir",
      data_source: "future-source",
      session: { idleMinutes: 15 },
    });

    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openai-codex", "gpt-5.4", "plain"], // provider, model, backend
        passwords: ["", ""],
        texts: [],
        confirms: [true],
      }),
    );
    vi.doMock("../src/auth/openai-codex-login.js", () => ({
      runCodexLogin: vi.fn(async () => ({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: Date.now() + 3_600_000,
      })),
    }));

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const merged = parseYaml(readFileSync(CONFIG(), "utf-8")) as Record<string, any>;
    expect(merged.data_dir).toBe("/custom/dir");
    expect(merged.data_source).toBe("future-source");
    expect(merged.session).toEqual({ idleMinutes: 15 });
  });
});
