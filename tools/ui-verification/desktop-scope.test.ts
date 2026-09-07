import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectNativeScope, requiresNative } from "./desktop-scope";

const temporaryRepositories: string[] = [];

afterEach(() => {
  for (const directory of temporaryRepositories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function write(root: string, path: string, contents = "fixture\n"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=CI Scope Test",
      "-c",
      "user.email=ci-scope@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "desktop-ci-scope-"));
  temporaryRepositories.push(root);
  git(root, "init", "-q");
  write(root, "README.md");
  return root;
}

function commit(root: string): string {
  git(root, "add", ".");
  git(root, "commit", "-qm", "test(ci): update fixture");
  return git(root, "rev-parse", "HEAD");
}

describe("native desktop CI scope", () => {
  it.each([
    "apps/desktop/src/main/index.ts",
    "apps/desktop/tests/e2e/application-ui-states.spec.ts",
    "apps/desktop-renderer/src/theme/application.css",
    "tools/ui-verification/desktop-scope.ts",
    "packages/coach/src/planning.ts",
    "packages/coach-cli/src/index.ts",
    "packages/coach-client/src/index.ts",
    "packages/coach-contract/src/events.ts",
    "packages/core/src/agent.ts",
    "packages/engine/tests/sync.test.ts",
    "packages/kernel/src/store.ts",
    "packages/kernel-node/src/index.ts",
    "packages/sport-cycling/src/index.ts",
    "packages/sync-intervals-icu/src/index.ts",
    "packages/core/CONTEXT.md",
  ])("runs native checks for %s", (path) => expect(requiresNative(path)).toBe(true));

  it.each([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.check.json",
    ".github/workflows/ci.yml",
    ".npmrc",
    "patches/example.patch",
    "packages/unrelated/package.json",
    "packages/unrelated/tsup.config.ts",
    "unknown/build-input.json",
  ])("fails closed for install, build or unknown input %s", (path) =>
    expect(requiresNative(path)).toBe(true),
  );

  it.each([
    "README.md",
    "CONTRIBUTING.md",
    "CONTEXT-MAP.md",
    "NOTICE.md",
    "LICENSE",
    ".changeset/example.md",
    "packages/unrelated/CONTEXT.md",
    "apps/unrelated/CONTEXT.md",
    "packages/unrelated/src/index.ts",
    "packages/unrelated/tests/example.test.ts",
  ])("skips native checks for %s", (path) => expect(requiresNative(path)).toBe(false));

  it.each([undefined, "", "0".repeat(40), "--help", "not-a-commit"])(
    "fails closed for an invalid comparison base: %s",
    (base) => expect(detectNativeScope(fixture(), base)).toBe(true),
  );

  it("fails closed when Git cannot resolve a syntactically valid base", () => {
    const root = fixture();
    commit(root);
    expect(detectNativeScope(root, "f".repeat(40))).toBe(true);
  });

  it("skips an unchanged snapshot and documentation-only changes", () => {
    const root = fixture();
    const base = commit(root);
    expect(detectNativeScope(root, base)).toBe(false);
    write(root, "README.md", "Updated documentation\n");
    write(root, ".changeset/example.md");
    commit(root);
    expect(detectNativeScope(root, base)).toBe(false);
  });

  it("keeps unknown inputs in a mixed documentation change", () => {
    const root = fixture();
    const base = commit(root);
    write(root, "README.md", "Updated documentation\n");
    write(root, ".npmrc", "minimum-release-age=1440\n");
    commit(root);
    expect(detectNativeScope(root, base)).toBe(true);
  });

  it("detects both sides of a rename out of a native directory", () => {
    const root = fixture();
    write(root, "apps/desktop-renderer/src/view.ts");
    const base = commit(root);
    mkdirSync(join(root, "packages/unrelated/src"), { recursive: true });
    renameSync(
      join(root, "apps/desktop-renderer/src/view.ts"),
      join(root, "packages/unrelated/src/view.ts"),
    );
    commit(root);
    expect(detectNativeScope(root, base)).toBe(true);
  });

  it("detects deletion of a native input", () => {
    const root = fixture();
    write(root, "apps/desktop-renderer/src/view.ts");
    const base = commit(root);
    rmSync(join(root, "apps/desktop-renderer/src/view.ts"));
    commit(root);
    expect(detectNativeScope(root, base)).toBe(true);
  });

  it("skips unrelated package source changes without resolving workspace dependencies", () => {
    const root = fixture();
    write(
      root,
      "apps/desktop-renderer/package.json",
      JSON.stringify({
        dependencies: {
          "@enduragent/ui":
            "https://github.com/yerzhansa/enduragent-ui/releases/download/v0.1.0/enduragent-ui-0.1.0.tgz",
        },
      }),
    );
    const base = commit(root);
    write(root, "packages/unrelated/src/index.ts");
    commit(root);
    expect(detectNativeScope(root, base)).toBe(false);
  });

  it("writes only the native output with Node's built-in TypeScript support", () => {
    const root = fixture();
    const output = join(root, "github-output");
    const script = resolve(import.meta.dirname, "desktop-scope.ts");
    const stdout = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, BASE_SHA: "", GITHUB_OUTPUT: output },
    });
    expect(stdout).toBe("native=true\n");
    expect(readFileSync(output, "utf8")).toBe(stdout);
  });
});
