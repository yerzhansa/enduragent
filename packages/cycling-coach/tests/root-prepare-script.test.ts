import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function rootPrepare(): string {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts?: { prepare?: string };
  };
  const prepare = manifest.scripts?.prepare;
  if (prepare === undefined) {
    throw new Error("root package.json is missing scripts.prepare");
  }
  return prepare;
}

function tempCwd(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("root prepare script", () => {
  it("succeeds when .githooks/install is absent", () => {
    expect(() =>
      execFileSync("sh", ["-c", rootPrepare()], { cwd: tempCwd("prepare-absent-"), encoding: "utf8" }),
    ).not.toThrow();
  });

  it("runs .githooks/install when that file exists", () => {
    const dir = tempCwd("prepare-present-");
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks/install"), "#!/bin/sh\necho ran > marker\n");
    execFileSync("sh", ["-c", rootPrepare()], { cwd: dir, encoding: "utf8" });
    expect(readFileSync(join(dir, "marker"), "utf8")).toBe("ran\n");
  });
});
