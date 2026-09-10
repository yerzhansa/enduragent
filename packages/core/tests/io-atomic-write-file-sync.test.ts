import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../src/io/atomic-write-file-sync.js";
import { WindowsPrivatePathPolicyError } from "../src/io/windows-private-path-policy.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cc-atomic-sync-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("atomicWriteFileSync", () => {
  it("writes UTF-8 content to the target path", () => {
    const target = join(tempDir, "MEMORY.md");
    atomicWriteFileSync(target, "## profile\nFTP 247W, 72kg\n");

    expect(readFileSync(target, "utf-8")).toBe("## profile\nFTP 247W, 72kg\n");
  });

  it.runIf(process.platform !== "win32")(
    "creates the target with owner-only 0o600 permissions",
    () => {
      const target = join(tempDir, "private.md");
      atomicWriteFileSync(target, "resting HR 44\n");

      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "tightens a pre-existing world-readable target to 0o600 on overwrite",
    () => {
      const target = join(tempDir, "was-readable.md");
      writeFileSync(target, "old\n", { encoding: "utf-8", mode: 0o644 });

      atomicWriteFileSync(target, "new\n");

      expect(readFileSync(target, "utf-8")).toBe("new\n");
      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );

  it("leaves no dangling temp siblings after repeated writes", () => {
    const target = join(tempDir, "repeated.md");
    for (let i = 0; i < 5; i++) {
      atomicWriteFileSync(target, `iter ${i}\n`);
    }

    const entries = readdirSync(tempDir);
    expect(entries).toContain("repeated.md");
    expect(entries.filter((e) => e.startsWith("repeated.md.tmp"))).toEqual([]);
  });

  it("keeps Windows write failures path-free and stage-coded", () => {
    const target = join(tempDir, "missing", "private-athlete.md");
    let failure: unknown;
    try {
      atomicWriteFileSync(target, "private\n", { platform: "win32" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(WindowsPrivatePathPolicyError);
    expect(failure).toMatchObject({ stage: "content-write", category: "io-failure" });
    expect(String(failure)).not.toContain(target);
    expect(JSON.stringify(failure)).not.toContain(target);
  });
});
