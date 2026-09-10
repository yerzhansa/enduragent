import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { scriptedPrompts } from "./helpers/scripted-prompts.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

let tempHome: string;
let origHome: string | undefined;
let origStdinTTY: boolean | undefined;
let origStdoutTTY: boolean | undefined;

function invalidUtf8ProfilesBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('{"openai-codex":{"type":"oauth","access":"invalid-', "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('","refresh":"invalid-refresh","expires":4102444800000}}', "utf8"),
  ]);
}

beforeEach(() => {
  for (const key of ["ENDURAGENT_LANGUAGE", "LANGUAGE", "LC_ALL", "LC_MESSAGES"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("LANG", "en_US.UTF-8");
  tempHome = mkdtempSync(join(tmpdir(), "cc-setup-"));
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

describe("codex setup flow", () => {
  it("writes config without api_key and saves auth-profiles.json with 0o600", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openai-codex", "gpt-5.4", "plain"], // provider, model, backend
        passwords: ["", ""],
      }),
    );

    vi.doMock("../src/auth/openai-codex-login.js", () => ({
      runCodexLogin: vi.fn(async () => ({
        type: "oauth",
        access: "fake-access",
        refresh: "fake-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct",
      })),
    }));

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const configPath = join(tempHome, ".cycling-coach", "config.yaml");
    expect(existsSync(configPath)).toBe(true);
    const yaml = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const llm = yaml.llm as Record<string, unknown>;
    expect(llm.provider).toBe("openai-codex");
    expect(llm.model).toBe("gpt-5.4");
    expect(llm.api_key).toBeUndefined();
    expect(llm.auth_profile).toBe("openai-codex");

    const profilesPath = join(tempHome, ".cycling-coach", "auth-profiles.json");
    expect(existsSync(profilesPath)).toBe(true);
    const st = statSync(profilesPath);
    expect(st.mode & 0o777).toBe(0o600);

    const saved = JSON.parse(readFileSync(profilesPath, "utf-8"));
    expect(saved["openai-codex"].access).toBe("fake-access");
    expect(saved["openai-codex"].refresh).toBe("fake-refresh");
  });

  it("re-login quarantines invalid UTF-8 profile bytes and persists new credentials", async () => {
    const profilesPath = join(tempHome, ".cycling-coach", "auth-profiles.json");
    const originalBytes = invalidUtf8ProfilesBytes();
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["openai-codex", "gpt-5.4", "plain"],
        passwords: ["", ""],
      }),
    );
    vi.doMock("../src/auth/openai-codex-login.js", () => ({
      runCodexLogin: vi.fn(async () => ({
        type: "oauth",
        access: "replacement-access",
        refresh: "replacement-refresh",
        expires: 4_102_444_800_000,
        accountId: "replacement-account",
      })),
    }));

    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(readFileSync(`${profilesPath}.corrupt`)).toEqual(originalBytes);
    expect(statSync(`${profilesPath}.corrupt`).mode & 0o777).toBe(0o600);
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(profilesPath, "utf8"))["openai-codex"]).toMatchObject({
      access: "replacement-access",
      refresh: "replacement-refresh",
    });
  });
});
