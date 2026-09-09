import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _detectBackendsWithOverrides, findInPath } from "../../../src/secrets/backends/detect.js";

const tempDirs: string[] = [];

async function makeOpStub(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "op-stub-"));
  tempDirs.push(dir);
  const path = join(dir, "op");
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("detectBackends", () => {
  it("returns unavailable/not-on-path when op is missing from PATH", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "empty-path-"));
    tempDirs.push(emptyDir);
    const result = await _detectBackendsWithOverrides({
      pathEnv: emptyDir,
      platform: "darwin",
    });
    expect(result.op).toEqual({ state: "unavailable", reason: "not-on-path" });
    expect(result.keychain).toEqual({ available: true });
  });

  it("returns ready when account list has an account and vault list succeeds", async () => {
    const opPath = await makeOpStub(`
case "$1" in
  account) printf '[{"email":"you@x.com","url":"my.1password.com"}]' ;;
  vault) printf '[{"id":"v1","name":"Personal"}]' ;;
esac
`);
    const result = await _detectBackendsWithOverrides({ opPath, platform: "darwin" });
    expect(result.op).toEqual({
      state: "ready",
      absolutePath: opPath,
      signedInAs: "you@x.com",
    });
  });

  it("returns needs-signin when vault list fails with 'not signed in'", async () => {
    const opPath = await makeOpStub(`
case "$1" in
  account) printf '[{"email":"you@x.com"}]' ;;
  vault) printf '[ERROR] account is not signed in\\n' >&2; exit 1 ;;
esac
`);
    const result = await _detectBackendsWithOverrides({ opPath, platform: "darwin" });
    expect(result.op).toEqual({
      state: "needs-signin",
      absolutePath: opPath,
    });
  });

  it("returns unavailable/no-account when account list returns []", async () => {
    const opPath = await makeOpStub(`
case "$1" in
  account) printf '[]' ;;
  vault) printf 'should-not-run' >&2; exit 1 ;;
esac
`);
    const result = await _detectBackendsWithOverrides({ opPath, platform: "darwin" });
    expect(result.op).toEqual({ state: "unavailable", reason: "no-account" });
  });

  it("returns unavailable/other when vault list fails with unrecognized stderr", async () => {
    const opPath = await makeOpStub(`
case "$1" in
  account) printf '[{"email":"you@x.com"}]' ;;
  vault) printf 'permission denied\\n' >&2; exit 1 ;;
esac
`);
    const result = await _detectBackendsWithOverrides({ opPath, platform: "darwin" });
    expect(result.op.state).toBe("unavailable");
    if (result.op.state === "unavailable") {
      expect(result.op.reason).toBe("other");
      expect(result.op.detail).toContain("permission denied");
    }
  });

  it("returns unavailable/other when account list itself fails", async () => {
    const opPath = await makeOpStub(`
printf 'op: unexpected error\\n' >&2
exit 2
`);
    const result = await _detectBackendsWithOverrides({ opPath, platform: "darwin" });
    expect(result.op.state).toBe("unavailable");
    if (result.op.state === "unavailable") {
      expect(result.op.reason).toBe("other");
      expect(result.op.detail).toContain("unexpected error");
    }
  });

  it("returns unavailable/other with detail 'timeout' when op hangs past timeoutMs", async () => {
    // Resolves at ~timeoutMs, not at the sleep child's exit: _spawn.ts kills the
    // child's process group on timeout, so the grandchild can't hold `close` open.
    const opPath = await makeOpStub(`sleep 2`);
    const result = await _detectBackendsWithOverrides({
      opPath,
      platform: "darwin",
      timeoutMs: 200,
    });
    expect(result.op).toEqual({
      state: "unavailable",
      reason: "other",
      detail: "timeout",
    });
  });

  it("marks keychain unavailable on non-Darwin platforms, preserving op state", async () => {
    const opPath = await makeOpStub(`
case "$1" in
  account) printf '[{"email":"you@x.com"}]' ;;
  vault) printf '[]' ;;
esac
`);
    const result = await _detectBackendsWithOverrides({ opPath, platform: "linux" });
    expect(result.keychain).toEqual({ available: false });
    expect(result.op.state).toBe("ready");
  });
});

describe("findInPath", () => {
  it("returns the absolute path when the binary is executable in PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "path-present-"));
    tempDirs.push(dir);
    const bin = join(dir, "mybin");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await findInPath("mybin", dir)).toBe(bin);
  });

  it("returns null when the binary is not in PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "path-missing-"));
    tempDirs.push(dir);
    expect(await findInPath("definitely-not-a-real-bin", dir)).toBeNull();
  });

  it("returns null when PATH is empty", async () => {
    expect(await findInPath("anything", "")).toBeNull();
  });
});
