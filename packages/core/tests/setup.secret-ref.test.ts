import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";

import { scriptedPrompts } from "./helpers/scripted-prompts.js";
import { cyclingBinary } from "./helpers/cycling-binary-fixture.js";

let tempHome: string;
let origHome: string | undefined;
let origStdinTTY: boolean | undefined;
let origStdoutTTY: boolean | undefined;
let stderrWrites: string[];
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  for (const key of ["ENDURAGENT_LANGUAGE", "LANGUAGE", "LC_ALL", "LC_MESSAGES"])
    vi.stubEnv(key, undefined);
  vi.stubEnv("LANG", "en_US.UTF-8");
  tempHome = mkdtempSync(join(tmpdir(), "cc-ref-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
  origStdinTTY = process.stdin.isTTY;
  origStdoutTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  stderrWrites = [];
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.HOME = origHome;
  Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
  process.stderr.write = origStderrWrite;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CONFIG = () => join(tempHome, ".cycling-coach", "config.yaml");

function seedConfig(obj: Record<string, unknown>): void {
  writeFileSync(CONFIG(), toYaml(obj), { mode: 0o600 });
}

function stderrAll(): string {
  return stderrWrites.join("");
}

function mockDetect(factory: () => Record<string, unknown>): void {
  vi.doMock("../src/secrets/backends/detect.js", () => ({
    detectBackends: vi.fn(async () => factory()),
  }));
}

// ============================================================================
// PURE HELPERS
// ============================================================================

describe("_detectPrevBackend", () => {
  it("returns plain for string values", async () => {
    const { _detectPrevBackend } = await import("../src/setup.js");
    expect(_detectPrevBackend("sk-plain")).toBe("plain");
    expect(_detectPrevBackend("")).toBe("plain");
  });

  it("returns op for SecretRef with op command", async () => {
    const { _detectPrevBackend } = await import("../src/setup.js");
    expect(
      _detectPrevBackend({
        source: "exec",
        command: "/usr/local/bin/op",
        args: ["read", "op://Personal/x/credential"],
      }),
    ).toBe("op");
    expect(_detectPrevBackend({ source: "exec", command: "op", args: [] })).toBe("op");
  });

  it("returns keychain for SecretRef with security command", async () => {
    const { _detectPrevBackend } = await import("../src/setup.js");
    expect(
      _detectPrevBackend({
        source: "exec",
        command: "/usr/bin/security",
        args: ["find-generic-password", "-w"],
      }),
    ).toBe("keychain");
  });

  it("returns plain for undefined", async () => {
    const { _detectPrevBackend } = await import("../src/setup.js");
    expect(_detectPrevBackend(undefined)).toBe("plain");
  });

  it("returns unknown for SecretRef with other commands (custom wrappers)", async () => {
    const { _detectPrevBackend } = await import("../src/setup.js");
    expect(
      _detectPrevBackend({
        source: "exec",
        command: "/usr/local/bin/vault",
        args: ["kv", "get"],
      }),
    ).toBe("unknown");
  });

  it("returns unknown for env-source SecretRef (wizard does not manage env refs)", async () => {
    const { _detectPrevBackend } = await import("../src/setup.js");
    expect(_detectPrevBackend({ source: "env", var: "ANTHROPIC_API_KEY" })).toBe("unknown");
  });
});

describe("_formatOrphanCleanup", () => {
  it("returns empty string when no entries", async () => {
    const { _formatOrphanCleanup } = await import("../src/setup.js");
    expect(_formatOrphanCleanup({ createdThisRun: [] }, cyclingBinary)).toBe("");
  });

  it("lists op item delete commands for op orphans", async () => {
    const { _formatOrphanCleanup } = await import("../src/setup.js");
    const out = _formatOrphanCleanup(
      {
        createdThisRun: [
          {
            backend: "op",
            field: "llm.api_key",
            title: "cycling-coach · llm_api_key",
            vaultName: "Personal",
            opAbsPath: "/usr/local/bin/op",
            preExistedBeforeWizard: false,
          },
        ],
      },
      cyclingBinary,
    );
    expect(out).toContain('op item delete "cycling-coach · llm_api_key" --vault "Personal"');
  });

  it("lists security delete commands for keychain orphans", async () => {
    const { _formatOrphanCleanup } = await import("../src/setup.js");
    const out = _formatOrphanCleanup(
      {
        createdThisRun: [
          {
            backend: "keychain",
            field: "llm.api_key",
            title: "llm_api_key",
            keychainPath: "/Users/x/Library/Keychains/login.keychain-db",
            preExistedBeforeWizard: false,
          },
        ],
      },
      cyclingBinary,
    );
    expect(out).toContain(
      'security delete-generic-password -s cycling-coach -a "llm_api_key" "/Users/x/Library/Keychains/login.keychain-db"',
    );
  });

  it("excludes pre-existing items from cleanup output", async () => {
    const { _formatOrphanCleanup } = await import("../src/setup.js");
    const out = _formatOrphanCleanup(
      {
        createdThisRun: [
          {
            backend: "op",
            field: "llm.api_key",
            title: "pre-existing",
            vaultName: "Personal",
            opAbsPath: "/usr/local/bin/op",
            preExistedBeforeWizard: true,
          },
          {
            backend: "op",
            field: "intervals.api_key",
            title: "new-this-run",
            vaultName: "Personal",
            opAbsPath: "/usr/local/bin/op",
            preExistedBeforeWizard: false,
          },
        ],
      },
      cyclingBinary,
    );
    expect(out).not.toContain("pre-existing");
    expect(out).toContain("new-this-run");
  });
});

describe("_createSignalHandler", () => {
  it("SIGINT handler prints orphan cleanup and exits 130", async () => {
    const { _createSignalHandler } = await import("../src/setup.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const handler = _createSignalHandler(
      {
        createdThisRun: [
          {
            backend: "op",
            field: "llm.api_key",
            title: "orphan",
            vaultName: "Personal",
            opAbsPath: "/usr/local/bin/op",
            preExistedBeforeWizard: false,
          },
        ],
      },
      "SIGINT",
      cyclingBinary,
    );
    expect(() => handler()).toThrow("__exit_130");
    expect(stderrAll()).toContain('op item delete "orphan" --vault "Personal"');
    exitSpy.mockRestore();
  });

  it("SIGTERM handler prints orphan cleanup and exits 143", async () => {
    const { _createSignalHandler } = await import("../src/setup.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const handler = _createSignalHandler(
      {
        createdThisRun: [
          {
            backend: "keychain",
            field: "llm.api_key",
            title: "kc_orphan",
            keychainPath: "/tmp/test.keychain-db",
            preExistedBeforeWizard: false,
          },
        ],
      },
      "SIGTERM",
      cyclingBinary,
    );
    expect(() => handler()).toThrow("__exit_143");
    expect(stderrAll()).toContain("kc_orphan");
    exitSpy.mockRestore();
  });

  it("handler with empty ctx prints no orphan preamble and exits", async () => {
    const { _createSignalHandler } = await import("../src/setup.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const handler = _createSignalHandler({ createdThisRun: [] }, "SIGINT", cyclingBinary);
    expect(() => handler()).toThrow("__exit_130");
    expect(stderrAll()).toBe("");
    exitSpy.mockRestore();
  });

  it("handler with only pre-existing entries prints no preamble", async () => {
    const { _createSignalHandler } = await import("../src/setup.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const handler = _createSignalHandler(
      {
        createdThisRun: [
          {
            backend: "op",
            field: "llm.api_key",
            title: "pre-existing",
            vaultName: "Personal",
            opAbsPath: "/usr/local/bin/op",
            preExistedBeforeWizard: true,
          },
        ],
      },
      "SIGINT",
      cyclingBinary,
    );
    expect(() => handler()).toThrow("__exit_130");
    expect(stderrAll()).not.toContain("pre-existing");
    exitSpy.mockRestore();
  });
});

describe("process.once signal registration (double-Ctrl+C safety)", () => {
  it("registered handler fires at most once via process.once", async () => {
    const { _createSignalHandler } = await import("../src/setup.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const handler = vi.fn(_createSignalHandler({ createdThisRun: [] }, "SIGINT", cyclingBinary));
    process.once("SIGINT", handler);
    try {
      expect(() => process.emit("SIGINT")).toThrow("__exit_130");
    } finally {
      // Clean up — guard against Node's default handler firing on the second
      // emit by removing any residual listener immediately.
      process.removeAllListeners("SIGINT");
    }
    expect(handler).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
  });
});

// ============================================================================
// TTY GUARD (D14)
// ============================================================================

describe("TTY guard (D14)", () => {
  it("non-TTY invocation → exit 2 with single-line stderr message and no FS/spawn", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    mockDetect(() => {
      throw new Error("detectBackends should NOT be called before TTY guard");
    });
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({ selects: [], passwords: [], texts: [], confirms: [] }),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const { runSetup } = await import("../src/setup.js");
    await expect(runSetup(cyclingBinary)).rejects.toThrow("__exit_2");
    expect(stderrAll()).toContain("interactive TTY");
    expect(existsSync(CONFIG())).toBe(false);
    exitSpy.mockRestore();
  });
});

// ============================================================================
// D19 trim + D17 size cap
// ============================================================================

describe("D19 trim + D17 size cap on secret inputs", () => {
  it("_processSecretInput trims leading/trailing whitespace and logs INFO", async () => {
    // vi.doMock applies to subsequent import — re-mock clack so log.info is observable
    const infoSpy = vi.fn();
    vi.doMock("@clack/prompts", () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      log: { info: infoSpy, success: vi.fn(), error: vi.fn() },
      note: vi.fn(),
      isCancel: () => false,
      select: vi.fn(),
      password: vi.fn(),
      text: vi.fn(),
      confirm: vi.fn(),
    }));
    const { _processSecretInput } = await import("../src/setup.js");
    expect(_processSecretInput("  sk-abc\n", "llm.api_key")).toBe("sk-abc");
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Trimmed whitespace"));
  });

  it("_processSecretInput does NOT log when value is already trimmed", async () => {
    const infoSpy = vi.fn();
    vi.doMock("@clack/prompts", () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      log: { info: infoSpy, success: vi.fn(), error: vi.fn() },
      note: vi.fn(),
      isCancel: () => false,
      select: vi.fn(),
      password: vi.fn(),
      text: vi.fn(),
      confirm: vi.fn(),
    }));
    const { _processSecretInput } = await import("../src/setup.js");
    expect(_processSecretInput("sk-abc", "llm.api_key")).toBe("sk-abc");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("_processSecretInput throws SecretTooLargeError on 65_537-byte input after trim", async () => {
    vi.doMock("@clack/prompts", () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
      note: vi.fn(),
      isCancel: () => false,
      select: vi.fn(),
      password: vi.fn(),
      text: vi.fn(),
      confirm: vi.fn(),
    }));
    const { _processSecretInput } = await import("../src/setup.js");
    const { SecretTooLargeError } = await import("../src/secrets/backends/op.js");
    const oversize = "x".repeat(65_537);
    expect(() => _processSecretInput(oversize, "llm.api_key")).toThrow(SecretTooLargeError);
  });

  it("trim + size cap: trailing whitespace doesn't push content over size cap", async () => {
    vi.doMock("@clack/prompts", () => ({
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
      note: vi.fn(),
      isCancel: () => false,
      select: vi.fn(),
      password: vi.fn(),
      text: vi.fn(),
      confirm: vi.fn(),
    }));
    const { _processSecretInput } = await import("../src/setup.js");
    const raw = "sk-abc" + " ".repeat(100_000);
    expect(_processSecretInput(raw, "llm.api_key")).toBe("sk-abc");
  });
});

// ============================================================================
// BACKEND AVAILABILITY — options filtered by detectBackends
// ============================================================================

describe("backend availability filtering", () => {
  it("op unavailable hides the 1Password option from the backend select", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-existing" },
    });
    const optionsCaptured: unknown[] = [];
    vi.doMock("@clack/prompts", () => {
      const selects = ["anthropic", "claude-sonnet-4-6", "plain"];
      let s = 0;
      return {
        intro: vi.fn(),
        outro: vi.fn(),
        cancel: vi.fn(),
        log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
        note: vi.fn(),
        isCancel: () => false,
        select: vi.fn(async (opts: { options: unknown[] }) => {
          optionsCaptured.push(opts.options);
          return selects[s++];
        }),
        password: vi.fn(async () => ""),
        text: vi.fn(),
        confirm: vi.fn(async () => true),
      };
    });
    mockDetect(() => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: true },
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    // options at index 2 = backend select; should have plain + keychain only
    const backendOpts = optionsCaptured[2] as Array<{ value: string }>;
    const values = backendOpts.map((o) => o.value);
    expect(values).toContain("plain");
    expect(values).toContain("keychain");
    expect(values).not.toContain("op");
    expect(values).not.toContain("op-signin");
  });

  it("keychain unavailable on non-Darwin hides the Keychain option", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-existing" },
    });
    const optionsCaptured: unknown[] = [];
    vi.doMock("@clack/prompts", () => {
      const selects = ["anthropic", "claude-sonnet-4-6", "plain"];
      let s = 0;
      return {
        intro: vi.fn(),
        outro: vi.fn(),
        cancel: vi.fn(),
        log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
        note: vi.fn(),
        isCancel: () => false,
        select: vi.fn(async (opts: { options: unknown[] }) => {
          optionsCaptured.push(opts.options);
          return selects[s++];
        }),
        password: vi.fn(async () => ""),
        text: vi.fn(),
        confirm: vi.fn(async () => true),
      };
    });
    mockDetect(() => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const backendOpts = optionsCaptured[2] as Array<{ value: string }>;
    const values = backendOpts.map((o) => o.value);
    expect(values).toEqual(["plain"]);
  });
});

// ============================================================================
// BACKEND SELECT — secure-by-default ordering + initialValue
// ============================================================================

type BackendSelectOpts = {
  message: string;
  options: { value: string; label: string; hint?: string }[];
  initialValue?: string;
};

describe("backend select secure-by-default", () => {
  function captureSelects(): BackendSelectOpts[] {
    const captured: BackendSelectOpts[] = [];
    vi.doMock("@clack/prompts", () => {
      const selects = ["anthropic", "claude-sonnet-4-6", "plain"];
      let s = 0;
      return {
        intro: vi.fn(),
        outro: vi.fn(),
        cancel: vi.fn(),
        log: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() },
        note: vi.fn(),
        isCancel: () => false,
        select: vi.fn(async (opts: BackendSelectOpts) => {
          captured.push(opts);
          return selects[s++];
        }),
        password: vi.fn(async () => ""),
        text: vi.fn(),
        confirm: vi.fn(async () => true),
      };
    });
    return captured;
  }

  function seedPlainConfig(): void {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-existing" },
    });
  }

  it("keychain available + op ready → keychain default, listed first, plain last with hint", async () => {
    seedPlainConfig();
    const captured = captureSelects();
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: true },
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const backendSelect = captured[2];
    expect(backendSelect.initialValue).toBe("keychain");
    expect(backendSelect.options.map((o) => o.value)).toEqual(["keychain", "op", "plain"]);
    const plain = backendSelect.options.find((o) => o.value === "plain");
    expect(plain?.hint).toContain("unencrypted");
  });

  it("keychain unavailable + op ready → op default, listed before plain", async () => {
    seedPlainConfig();
    const captured = captureSelects();
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const backendSelect = captured[2];
    expect(backendSelect.initialValue).toBe("op");
    expect(backendSelect.options.map((o) => o.value)).toEqual(["op", "plain"]);
  });

  it("op needs-signin only → plain default (op-signin offered but never auto-selected)", async () => {
    seedPlainConfig();
    const captured = captureSelects();
    mockDetect(() => ({
      op: { state: "needs-signin", absolutePath: "/usr/local/bin/op" },
      keychain: { available: false },
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const backendSelect = captured[2];
    expect(backendSelect.initialValue).toBe("plain");
    expect(backendSelect.options.map((o) => o.value)).toEqual(["op-signin", "plain"]);
  });

  it("no secure backend detected → plain default", async () => {
    seedPlainConfig();
    const captured = captureSelects();
    mockDetect(() => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    const backendSelect = captured[2];
    expect(backendSelect.initialValue).toBe("plain");
    expect(backendSelect.options.map((o) => o.value)).toEqual(["plain"]);
  });
});

// ============================================================================
// CONFIG FILE PERMISSIONS
// ============================================================================

describe("config file permissions", () => {
  it("fresh install: config dir created 0o700, config.yaml written 0o600", async () => {
    const freshHome = join(tempHome, "fresh-coach-home");
    process.env.CYCLING_COACH_HOME = freshHome;
    try {
      vi.doMock("@clack/prompts", () =>
        scriptedPrompts({
          selects: ["anthropic", "claude-sonnet-4-6", "plain"],
          passwords: ["sk-fresh", "", ""],
          texts: [],
          confirms: [],
        }),
      );
      mockDetect(() => ({
        op: { state: "unavailable", reason: "not-on-path" },
        keychain: { available: false },
      }));
      const { runSetup } = await import("../src/setup.js");
      await runSetup(cyclingBinary);

      expect(statSync(freshHome).mode & 0o777).toBe(0o700);
      expect(statSync(join(freshHome, "config.yaml")).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.CYCLING_COACH_HOME;
    }
  });

  it("re-run tightens a pre-existing world-readable config.yaml to 0o600", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-existing" },
    });
    chmodSync(CONFIG(), 0o644);
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["", "", ""],
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);

    expect(statSync(CONFIG()).mode & 0o777).toBe(0o600);
  });
});

// ============================================================================
// KEYCHAIN BACKEND — idempotency
// ============================================================================

describe("Keychain backend", () => {
  it("idempotency: seeded keychain SecretRef + Enter-keep → YAML bytes unchanged, no upsert", async () => {
    seedConfig({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: {
          source: "exec",
          command: "/usr/bin/security",
          args: [
            "find-generic-password",
            "-w",
            "-s",
            "cycling-coach",
            "-a",
            "llm_api_key",
            "/tmp/login.keychain-db",
          ],
        },
      },
    });
    const before = readFileSync(CONFIG(), "utf-8");
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "keychain"],
        passwords: ["", "", ""], // llm, intervals, telegram all Enter-keep
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: true },
    }));
    const upsertSpy = vi.fn();
    vi.doMock("../src/secrets/backends/keychain.js", () => ({
      keychainLoginPath: vi.fn(async () => "/tmp/login.keychain-db"),
      keychainItemExists: vi.fn(async () => true),
      keychainItemUpsert: upsertSpy,
      keychainItemDelete: vi.fn(async () => ({ deleted: true })),
      keychainSecretRef: vi.fn((field: string, path: string) => ({
        source: "exec",
        command: "/usr/bin/security",
        args: ["find-generic-password", "-w", "-s", "cycling-coach", "-a", field, path],
      })),
      KeychainUnsafeValueError: class extends Error {},
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    const after = readFileSync(CONFIG(), "utf-8");
    const beforeParsed = parseYaml(before);
    const afterParsed = parseYaml(after);
    expect(afterParsed).toEqual(beforeParsed);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 1PASSWORD BACKEND — idempotency + multi-vault fallback + needs-signin
// ============================================================================

describe("1Password backend", () => {
  it("idempotency: seeded op SecretRef + Enter-keep + Keep-existing → no opItemUpdate call", async () => {
    seedConfig({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: {
          source: "exec",
          command: "/usr/local/bin/op",
          args: ["read", "op://Personal/cycling-coach · llm_api_key/credential"],
        },
      },
    });
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op", "keep"],
        passwords: ["", "", ""], // llm, intervals, telegram all Enter-keep
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    const updateSpy = vi.fn();
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: true, vaultName: "Personal" })),
        opItemUpdate: updateSpy,
        opItemCreate: vi.fn(),
        opItemDelete: vi.fn(async () => ({ deleted: true })),
        opVaultList: vi.fn(async () => []),
      };
    });
    const { runSetup } = await import("../src/setup.js");
    // Note: Enter-keep on llm triggers the "same backend, keep as-is" fast-path —
    // no opItemGet call either.
    await runSetup(cyclingBinary);
    expect(updateSpy).not.toHaveBeenCalled();
    const after = parseYaml(readFileSync(CONFIG(), "utf-8"));
    expect(after).toMatchObject({
      llm: {
        api_key: {
          source: "exec",
          command: "/usr/local/bin/op",
          args: ["read", "op://Personal/cycling-coach · llm_api_key/credential"],
        },
      },
    });
  });

  it("multi-vault fallback: OpVaultAmbiguousError → opVaultList → user picks → retry succeeds + caches vault", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op", "Personal"], // provider, model, backend, vault pick
        passwords: ["sk-first", "", ""], // llm typed, intervals/telegram Enter-skip
        texts: [],
        confirms: [], // no prev config → no update confirm
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    let createCalls = 0;
    const createSpy = vi.fn(
      async (_opPath: string, _title: string, _value: string, vault?: string) => {
        createCalls++;
        if (createCalls === 1 && vault === undefined) {
          const err = new (await import("../src/secrets/backends/op.js")).OpVaultAmbiguousError(
            "more than one vault",
          );
          throw err;
        }
        return { vaultName: vault ?? "Personal" };
      },
    );
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: createSpy,
        opItemUpdate: vi.fn(),
        opItemDelete: vi.fn(),
        opVaultList: vi.fn(async () => [
          { id: "v1", name: "Personal" },
          { id: "v2", name: "Team" },
          { id: "v3", name: "Shared" },
        ]),
      };
    });
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    expect(createCalls).toBe(2);
    const after = parseYaml(readFileSync(CONFIG(), "utf-8"));
    expect(after.llm.api_key.args).toEqual([
      "read",
      "op://Personal/cycling-coach · llm_api_key/credential",
    ]);
  });

  it("needs-signin → op signin succeeds → re-detect ready → continues into op branch", async () => {
    let detectCalls = 0;
    vi.doMock("../src/secrets/backends/detect.js", () => ({
      detectBackends: vi.fn(async () => {
        detectCalls++;
        if (detectCalls === 1) {
          return {
            op: { state: "needs-signin", absolutePath: "/usr/local/bin/op" },
            keychain: { available: false },
          };
        }
        return {
          op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
          keychain: { available: false },
        };
      }),
    }));
    // Stub child_process.spawn so the `op signin` call resolves immediately
    // with a successful exit code. setImmediate (not synchronous) so the
    // listener registration order in runOpSignin is preserved.
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => ({
        on: (event: string, cb: (code: number) => void) => {
          if (event === "close") {
            setImmediate(() => cb(0));
          }
        },
      })),
    }));
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op-signin"],
        passwords: ["sk-first", "", ""],
        texts: [],
        confirms: [],
      }),
    );
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: vi.fn(async () => ({ vaultName: "Personal" })),
        opItemUpdate: vi.fn(),
        opItemDelete: vi.fn(),
        opVaultList: vi.fn(async () => []),
      };
    });
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    const after = parseYaml(readFileSync(CONFIG(), "utf-8"));
    expect(after.llm.api_key.command).toBe("/usr/local/bin/op");
    expect(detectCalls).toBeGreaterThanOrEqual(2);
  });

  it("needs-signin → op signin fails → user picks plain instead (no crash)", async () => {
    vi.doMock("../src/secrets/backends/detect.js", () => ({
      detectBackends: vi.fn(async () => ({
        op: { state: "needs-signin", absolutePath: "/usr/local/bin/op" },
        keychain: { available: false },
      })),
    }));
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => {
        const listeners: Record<string, (code: number) => void> = {};
        const emitter = {
          on: (event: string, cb: (code: number) => void) => {
            listeners[event] = cb;
            if (event === "close") {
              setImmediate(() => cb(1));
            }
          },
        };
        return emitter;
      }),
    }));
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op-signin", "plain"], // retry → pick plain
        passwords: ["sk-plain", "", ""],
        texts: [],
        confirms: [],
      }),
    );
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    const after = parseYaml(readFileSync(CONFIG(), "utf-8"));
    expect(after.llm.api_key).toBe("sk-plain");
  });
});

// ============================================================================
// D13 CROSS-BACKEND MIGRATION
// ============================================================================

describe("D13 cross-backend migration", () => {
  it("plain → op, new value typed: YAML ends with SecretRef, no plain remnant", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-old-plain" },
    });
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op"],
        passwords: ["sk-new-op", "", ""],
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: vi.fn(async () => ({ vaultName: "Personal" })),
        opItemUpdate: vi.fn(),
        opItemDelete: vi.fn(),
        opVaultList: vi.fn(async () => []),
      };
    });
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    const after = parseYaml(readFileSync(CONFIG(), "utf-8"));
    expect(typeof after.llm.api_key).toBe("object");
    expect(after.llm.api_key.source).toBe("exec");
    expect(after.llm.api_key.command).toBe("/usr/local/bin/op");
  });

  it("plain → op, Enter-keep: D13 prompt shows [Paste|Keep] → user picks Keep → YAML unchanged", async () => {
    seedConfig({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "sk-old-plain" },
    });
    const before = readFileSync(CONFIG(), "utf-8");
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op", "keep"], // provider, model, backend, migration pick
        passwords: ["", "", ""],
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    const createSpy = vi.fn();
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: createSpy,
        opItemUpdate: vi.fn(),
        opItemDelete: vi.fn(),
        opVaultList: vi.fn(async () => []),
      };
    });
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    const after = readFileSync(CONFIG(), "utf-8");
    expect(parseYaml(after)).toEqual(parseYaml(before));
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("op → keychain, Enter-keep: D13 prompt → Keep → YAML unchanged, no upsert", async () => {
    seedConfig({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: {
          source: "exec",
          command: "/usr/local/bin/op",
          args: ["read", "op://Personal/x/credential"],
        },
      },
    });
    const before = readFileSync(CONFIG(), "utf-8");
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "keychain", "keep"],
        passwords: ["", "", ""],
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: true },
    }));
    const upsertSpy = vi.fn();
    vi.doMock("../src/secrets/backends/keychain.js", () => ({
      keychainLoginPath: vi.fn(async () => "/tmp/login.keychain-db"),
      keychainItemExists: vi.fn(async () => false),
      keychainItemUpsert: upsertSpy,
      keychainItemDelete: vi.fn(),
      keychainSecretRef: vi.fn(),
      KeychainUnsafeValueError: class extends Error {},
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    expect(parseYaml(readFileSync(CONFIG(), "utf-8"))).toEqual(parseYaml(before));
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("op → plain, new value typed: resulting YAML has plain string, op item NOT deleted", async () => {
    seedConfig({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: {
          source: "exec",
          command: "/usr/local/bin/op",
          args: ["read", "op://Personal/x/credential"],
        },
      },
    });
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "plain"],
        passwords: ["sk-new-plain", "", ""],
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "unavailable", reason: "not-on-path" },
      keychain: { available: false },
    }));
    const deleteSpy = vi.fn();
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(),
        opItemCreate: vi.fn(),
        opItemUpdate: vi.fn(),
        opItemDelete: deleteSpy,
        opVaultList: vi.fn(),
      };
    });
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    const after = parseYaml(readFileSync(CONFIG(), "utf-8"));
    expect(after.llm.api_key).toBe("sk-new-plain");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("invariant: no cross-backend reads — resolveSecretRef is NEVER called from the wizard", async () => {
    seedConfig({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: {
          source: "exec",
          command: "/usr/local/bin/op",
          args: ["read", "op://Personal/x/credential"],
        },
      },
    });
    const resolveSpy = vi.fn();
    vi.doMock("../src/secrets/resolve.js", () => ({
      resolveSecretRef: resolveSpy,
      _resolveSecretRefWithOverrides: resolveSpy,
    }));
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "keychain", "keep"],
        passwords: ["", "", ""],
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: true },
    }));
    vi.doMock("../src/secrets/backends/keychain.js", () => ({
      keychainLoginPath: vi.fn(async () => "/tmp/login.keychain-db"),
      keychainItemExists: vi.fn(async () => false),
      keychainItemUpsert: vi.fn(),
      keychainItemDelete: vi.fn(),
      keychainSecretRef: vi.fn(),
      KeychainUnsafeValueError: class extends Error {},
    }));
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// D11 GUARDED CLEANUP
// ============================================================================

describe("D11 guarded cleanup on mid-wizard failure", () => {
  it("accept-cleanup: 2 created + 3rd fails → user accepts → both prior items deleted", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op"],
        passwords: ["sk-1", "sk-2", "sk-3"],
        texts: [],
        confirms: [true], // accept cleanup
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    let createCalls = 0;
    const deleteSpy = vi.fn(async () => ({ deleted: true }));
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: vi.fn(async (_opPath: string, _title: string) => {
          createCalls++;
          if (createCalls === 3) throw new Error("boom — third secret write failed");
          return { vaultName: "Personal" };
        }),
        opItemUpdate: vi.fn(),
        opItemDelete: deleteSpy,
        opVaultList: vi.fn(async () => []),
      };
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const { runSetup } = await import("../src/setup.js");
    await expect(runSetup(cyclingBinary)).rejects.toThrow("__exit_1");
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(existsSync(CONFIG())).toBe(false); // YAML untouched
    exitSpy.mockRestore();
  });

  it("decline-cleanup: user says No → no opItemDelete, manual commands printed", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op"],
        passwords: ["sk-1", "sk-2", "sk-3"],
        texts: [],
        confirms: [false], // decline cleanup
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    let createCalls = 0;
    const deleteSpy = vi.fn();
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: vi.fn(async () => {
          createCalls++;
          if (createCalls === 3) throw new Error("boom");
          return { vaultName: "Personal" };
        }),
        opItemUpdate: vi.fn(),
        opItemDelete: deleteSpy,
        opVaultList: vi.fn(async () => []),
      };
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const { runSetup } = await import("../src/setup.js");
    await expect(runSetup(cyclingBinary)).rejects.toThrow("__exit_1");
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(stderrAll()).toContain("op item delete");
    exitSpy.mockRestore();
  });

  it("pre-existence guard: a pre-existing updated item is NOT offered for deletion", async () => {
    seedConfig({
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: {
          source: "exec",
          command: "/usr/local/bin/op",
          args: ["read", "op://Personal/cycling-coach · llm_api_key/credential"],
        },
      },
    });
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op", "update"], // provider, model, backend, action-on-existing
        passwords: ["sk-updated-llm", "sk-new-intervals", "sk-telegram-fail"],
        texts: ["42"], // intervals athlete id
        confirms: [true], // accept cleanup
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    const deleteSpy = vi.fn(async () => ({ deleted: true }));
    let createCalls = 0;
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async (_opPath: string, title: string) => {
          if (title === "cycling-coach · llm_api_key") {
            return { exists: true, vaultName: "Personal" };
          }
          return { exists: false };
        }),
        opItemUpdate: vi.fn(),
        opItemCreate: vi.fn(async () => {
          createCalls++;
          if (createCalls === 2) throw new Error("telegram boom");
          return { vaultName: "Personal" };
        }),
        opItemDelete: deleteSpy,
        opVaultList: vi.fn(async () => []),
      };
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const { runSetup } = await import("../src/setup.js");
    await expect(runSetup(cyclingBinary)).rejects.toThrow("__exit_1");
    // Only the NEW intervals item should be deleted; the LLM one pre-existed.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const firstDeleteArgs = deleteSpy.mock.calls[0] as unknown[];
    expect(firstDeleteArgs[1]).toBe("cycling-coach · intervals_api_key");
    exitSpy.mockRestore();
  });

  it("best-effort: first delete fails with auth error, second still attempted", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op"],
        passwords: ["sk-1", "sk-2", "sk-3"],
        texts: [],
        confirms: [true],
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    let createCalls = 0;
    const deleteSpy = vi.fn(async (_opPath: string, title: string) => {
      if (title === "cycling-coach · llm_api_key") {
        throw new Error("auth failure deleting first");
      }
      return { deleted: true };
    });
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: vi.fn(async () => {
          createCalls++;
          if (createCalls === 3) throw new Error("third fails");
          return { vaultName: "Personal" };
        }),
        opItemUpdate: vi.fn(),
        opItemDelete: deleteSpy,
        opVaultList: vi.fn(async () => []),
      };
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}`);
    }) as never);
    const { runSetup } = await import("../src/setup.js");
    await expect(runSetup(cyclingBinary)).rejects.toThrow("__exit_1");
    expect(deleteSpy).toHaveBeenCalledTimes(2); // both attempted
    exitSpy.mockRestore();
  });
});

// ============================================================================
// SecretRef uses discovered vault (not hardcoded "Private")
// ============================================================================

describe("SecretRef uses discovered vault from opItemCreate", () => {
  it("single-vault consumer account → YAML SecretRef reflects actual vault name (Personal)", async () => {
    vi.doMock("@clack/prompts", () =>
      scriptedPrompts({
        selects: ["anthropic", "claude-sonnet-4-6", "op"],
        passwords: ["sk-first", "", ""],
        texts: [],
        confirms: [],
      }),
    );
    mockDetect(() => ({
      op: { state: "ready", absolutePath: "/usr/local/bin/op", signedInAs: "me@x.com" },
      keychain: { available: false },
    }));
    vi.doMock("../src/secrets/backends/op.js", async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        "../src/secrets/backends/op.js",
      );
      return {
        ...actual,
        opItemGet: vi.fn(async () => ({ exists: false })),
        opItemCreate: vi.fn(async () => ({ vaultName: "Personal" })),
        opItemUpdate: vi.fn(),
        opItemDelete: vi.fn(),
        opVaultList: vi.fn(async () => []),
      };
    });
    const { runSetup } = await import("../src/setup.js");
    await runSetup(cyclingBinary);
    const after = parseYaml(readFileSync(CONFIG(), "utf-8"));
    expect(after.llm.api_key.args[1]).toBe("op://Personal/cycling-coach · llm_api_key/credential");
    expect(after.llm.api_key.args[1]).not.toContain("Private");
  });
});
