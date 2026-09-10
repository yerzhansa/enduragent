import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  KeychainUnsafeValueError,
  KeychainUnsupportedPlatformError,
  assertKeychainSafeValue,
  keychainItemDelete,
  keychainItemExists,
  keychainItemUpsert,
  keychainLoginPath,
  keychainSecretRef,
} from "../../../src/secrets/backends/keychain.js";
import { isSecretRef } from "../../../src/secrets/types.js";

const tempDirs: string[] = [];

async function makeSecurityStub(script: string): Promise<{ securityPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "security-stub-"));
  tempDirs.push(dir);
  const securityPath = join(dir, "security");
  const wrapped = `#!/bin/sh
STUB_DIR='${dir}'
printf '%s\\n' "$@" > "$STUB_DIR/argv"
touch "$STUB_DIR/called"
cat > "$STUB_DIR/stdin"
${script}
`;
  await writeFile(securityPath, wrapped, { mode: 0o755 });
  return { securityPath, dir };
}

async function readArgv(dir: string): Promise<string[]> {
  const raw = await readFile(join(dir, "argv"), "utf8");
  return raw.split("\n").slice(0, -1);
}

async function readStdin(dir: string): Promise<string> {
  return readFile(join(dir, "stdin"), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("keychainLoginPath", () => {
  it("returns trimmed path ending in .keychain-db on exit 0", async () => {
    const { securityPath } = await makeSecurityStub(`
printf '    "/Users/test/Library/Keychains/login.keychain-db"\\n'
`);
    const result = await keychainLoginPath({ securityPath });
    expect(result).toBe("/Users/test/Library/Keychains/login.keychain-db");
  });

  it("returns plain path with no surrounding quotes", async () => {
    const { securityPath } = await makeSecurityStub(`
printf '/Users/test/Library/Keychains/login.keychain-db\\n'
`);
    const result = await keychainLoginPath({ securityPath });
    expect(result).toBe("/Users/test/Library/Keychains/login.keychain-db");
  });

  it("accepts .keychain suffix (legacy macOS)", async () => {
    const { securityPath } = await makeSecurityStub(`
printf '"/Users/test/Library/Keychains/login.keychain"\\n'
`);
    const result = await keychainLoginPath({ securityPath });
    expect(result).toBe("/Users/test/Library/Keychains/login.keychain");
  });

  it("falls back to $HOME/Library/Keychains/login.keychain-db on timeout + logs WARN", async () => {
    const { securityPath } = await makeSecurityStub(`
sleep 2
printf 'never printed\\n'
`);
    const result = await keychainLoginPath({ securityPath, timeoutMs: 100 });
    expect(result).toMatch(/\/Library\/Keychains\/login\.keychain-db$/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/timeout/);
  });

  it("falls back on empty stdout + logs WARN", async () => {
    const { securityPath } = await makeSecurityStub(`
printf ''
`);
    const result = await keychainLoginPath({ securityPath });
    expect(result).toMatch(/\/Library\/Keychains\/login\.keychain-db$/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back on relative path stdout + logs WARN", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'login.keychain-db\\n'
`);
    const result = await keychainLoginPath({ securityPath });
    expect(result).toMatch(/\/Library\/Keychains\/login\.keychain-db$/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back on path without .keychain suffix", async () => {
    const { securityPath } = await makeSecurityStub(`
printf '/Users/test/something-else\\n'
`);
    const result = await keychainLoginPath({ securityPath });
    expect(result).toMatch(/\/Library\/Keychains\/login\.keychain-db$/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back on non-zero exit", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'ignored\\n'
exit 1
`);
    const result = await keychainLoginPath({ securityPath });
    expect(result).toMatch(/\/Library\/Keychains\/login\.keychain-db$/);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/exit 1/);
  });
});

describe("keychainItemExists", () => {
  it("returns true when security exits 0", async () => {
    const { securityPath, dir } = await makeSecurityStub(`exit 0`);
    const result = await keychainItemExists(
      "anthropic_api_key",
      "/Users/x/Library/Keychains/login.keychain-db",
      { securityPath },
    );
    expect(result).toBe(true);
    const argv = await readArgv(dir);
    expect(argv).toEqual([
      "find-generic-password",
      "-s",
      "cycling-coach",
      "-a",
      "anthropic_api_key",
      "/Users/x/Library/Keychains/login.keychain-db",
    ]);
  });

  it("returns false on non-zero exit (item not found)", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n' >&2
exit 44
`);
    const result = await keychainItemExists(
      "missing_key",
      "/Users/x/Library/Keychains/login.keychain-db",
      { securityPath },
    );
    expect(result).toBe(false);
  });

  it("places keychain path as last positional arg (C3)", async () => {
    const { securityPath, dir } = await makeSecurityStub(`exit 0`);
    await keychainItemExists("some_key", "/path/to/login.keychain-db", { securityPath });
    const argv = await readArgv(dir);
    expect(argv[argv.length - 1]).toBe("/path/to/login.keychain-db");
  });
});

describe("keychainItemUpsert", () => {
  it("passes only `-i` in argv; secret travels via stdin (argv-leak guard)", async () => {
    const { securityPath, dir } = await makeSecurityStub(`exit 0`);
    const secret = "SECRET_TOKEN_VALUE_456";
    const keychainPath = "/Users/x/Library/Keychains/login.keychain-db";
    await keychainItemUpsert("openai_api_key", secret, keychainPath, {
      securityPath,
      platform: "darwin",
    });
    const argv = await readArgv(dir);
    expect(argv).toEqual(["-i"]);
    for (const arg of argv) {
      expect(arg).not.toContain(secret);
    }
    const stdin = await readStdin(dir);
    expect(stdin).toContain(secret);
    expect(stdin).toContain(keychainPath);
    expect(stdin).toContain("add-generic-password -U -s cycling-coach");
  });

  it("happy path: no error when stdout has no `returned -N`", async () => {
    const { securityPath } = await makeSecurityStub(`exit 0`);
    await expect(
      keychainItemUpsert(
        "anthropic_api_key",
        "sk-abc",
        "/Users/x/Library/Keychains/login.keychain-db",
        { securityPath, platform: "darwin" },
      ),
    ).resolves.toBeUndefined();
  });

  it("throws on `returned -N` in stdout even when exit 0 (C5)", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'security: SecKeychainSearchCopyNext: error\\n' >&2
printf 'add-generic-password: returned -25299\\n'
exit 0
`);
    await expect(
      keychainItemUpsert(
        "anthropic_api_key",
        "sk-abc",
        "/Users/x/Library/Keychains/login.keychain-db",
        { securityPath, platform: "darwin" },
      ),
    ).rejects.toThrow(/OSStatus -25299/);
  });

  it("throws on `returned -N` appearing in stderr (also covered)", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'add-generic-password: returned -25300\\n' >&2
exit 0
`);
    await expect(
      keychainItemUpsert(
        "anthropic_api_key",
        "sk-abc",
        "/Users/x/Library/Keychains/login.keychain-db",
        { securityPath, platform: "darwin" },
      ),
    ).rejects.toThrow(/OSStatus -25300/);
  });

  it("platform guard: throws KeychainUnsupportedPlatformError on linux before any spawn", async () => {
    const { securityPath, dir } = await makeSecurityStub(`exit 0`);
    await expect(
      keychainItemUpsert(
        "anthropic_api_key",
        "sk-abc",
        "/Users/x/Library/Keychains/login.keychain-db",
        { securityPath, platform: "linux" },
      ),
    ).rejects.toBeInstanceOf(KeychainUnsupportedPlatformError);
    expect(await exists(join(dir, "called"))).toBe(false);
  });

  it("FD6 unsafe value guard: rejects newline before any spawn", async () => {
    const { securityPath, dir } = await makeSecurityStub(`exit 0`);
    await expect(
      keychainItemUpsert("k", "line1\nline2", "/Users/x/Library/Keychains/login.keychain-db", {
        securityPath,
        platform: "darwin",
      }),
    ).rejects.toBeInstanceOf(KeychainUnsafeValueError);
    expect(await exists(join(dir, "called"))).toBe(false);
  });

  it("FD6 unsafe value guard: rejects carriage return, NUL, and double-quote", async () => {
    for (const unsafe of ["a\rb", "a\0b", 'a"b']) {
      expect(() => assertKeychainSafeValue(unsafe)).toThrow(KeychainUnsafeValueError);
    }
  });

  it("FD6 safe values: alphanumerics + dash/dot/underscore pass", () => {
    for (const safe of ["sk-abc_123.def", "AAA-bbb_ccc.DDD", "plain"]) {
      expect(() => assertKeychainSafeValue(safe)).not.toThrow();
    }
  });
});

describe("keychainItemDelete", () => {
  it("returns {deleted:true} on exit 0", async () => {
    const { securityPath, dir } = await makeSecurityStub(`exit 0`);
    const result = await keychainItemDelete(
      "anthropic_api_key",
      "/Users/x/Library/Keychains/login.keychain-db",
      { securityPath },
    );
    expect(result).toEqual({ deleted: true });
    const argv = await readArgv(dir);
    expect(argv[argv.length - 1]).toBe("/Users/x/Library/Keychains/login.keychain-db");
  });

  it("returns {deleted:false} on exit 44", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'security: SecKeychainSearchCopyNext: The specified item could not be found.\\n' >&2
exit 44
`);
    const result = await keychainItemDelete(
      "missing_key",
      "/Users/x/Library/Keychains/login.keychain-db",
      { securityPath },
    );
    expect(result).toEqual({ deleted: false });
  });

  it("returns {deleted:false} on 'not found' stderr with other exit code", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'security: The specified item could not be found in the keychain.\\n' >&2
exit 1
`);
    const result = await keychainItemDelete(
      "missing_key",
      "/Users/x/Library/Keychains/login.keychain-db",
      { securityPath },
    );
    expect(result).toEqual({ deleted: false });
  });

  it("throws on other non-zero exits (e.g., auth failure)", async () => {
    const { securityPath } = await makeSecurityStub(`
printf 'security: user interaction required; keychain is locked\\n' >&2
exit 36
`);
    await expect(
      keychainItemDelete("anthropic_api_key", "/Users/x/Library/Keychains/login.keychain-db", {
        securityPath,
      }),
    ).rejects.toThrow(/security delete-generic-password failed \(exit 36\)/);
  });

  it("places keychain path as last positional arg (C3)", async () => {
    const { securityPath, dir } = await makeSecurityStub(`exit 0`);
    await keychainItemDelete("k", "/path/to/login.keychain-db", {
      securityPath,
    });
    const argv = await readArgv(dir);
    expect(argv).toEqual([
      "delete-generic-password",
      "-s",
      "cycling-coach",
      "-a",
      "k",
      "/path/to/login.keychain-db",
    ]);
  });
});

describe("keychainSecretRef", () => {
  it("produces SecretRef with keychain path as the last positional arg (C3)", () => {
    const ref = keychainSecretRef(
      "anthropic_api_key",
      "/Users/x/Library/Keychains/login.keychain-db",
    );
    expect(isSecretRef(ref)).toBe(true);
    expect(ref).toEqual({
      source: "exec",
      command: "/usr/bin/security",
      args: [
        "find-generic-password",
        "-w",
        "-s",
        "cycling-coach",
        "-a",
        "anthropic_api_key",
        "/Users/x/Library/Keychains/login.keychain-db",
      ],
    });
    expect(ref.source).toBe("exec");
    if (ref.source === "exec") {
      expect(ref.args![ref.args!.length - 1]).toBe("/Users/x/Library/Keychains/login.keychain-db");
    }
  });
});

const execFileAsync = promisify(execFile);

describe("keychain idempotency (CI-only, real keychain)", () => {
  it.skipIf(process.env.CI !== "macos")(
    "upsert twice with different values; find-generic-password returns the second",
    async () => {
      const field = `cc_citest_${process.pid}_${Math.random().toString(36).slice(2)}`;
      const loginPath = await keychainLoginPath();
      try {
        await keychainItemUpsert(field, "v1", loginPath, { platform: "darwin" });
        await keychainItemUpsert(field, "v2", loginPath, { platform: "darwin" });
        const { stdout } = await execFileAsync("/usr/bin/security", [
          "find-generic-password",
          "-w",
          "-s",
          "cycling-coach",
          "-a",
          field,
          loginPath,
        ]);
        expect(stdout.trim()).toBe("v2");
      } finally {
        await keychainItemDelete(field, loginPath);
      }
    },
  );
});
