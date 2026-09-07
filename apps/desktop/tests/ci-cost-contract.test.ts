import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function job(workflow: string, name: string): string {
  const section = workflow.split(`  ${name}:\n`)[1]?.split(/\r?\n  [a-z0-9_-]+:\r?\n/u)[0];
  if (section === undefined) throw new TypeError(`workflow job ${name} is missing`);
  return section;
}

describe("CI cost contract", () => {
  let ci = "";
  let image = "";

  beforeAll(async () => {
    [ci, image] = await Promise.all([
      readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(join(repositoryRoot, ".github/workflows/publish-image.yml"), "utf8"),
    ]);
  });

  it("consolidates Linux validation into one prepared workspace", () => {
    const check = job(ci, "check");
    expect(check.match(/pnpm install --frozen-lockfile/gu)).toHaveLength(1);
    expect(check).toContain("run: pnpm check");
    expect(check).toContain("pnpm exec vitest run --shard=1/2");
    expect(check).toContain("pnpm exec vitest run --shard=2/2");
    expect(check).toContain("run: pnpm s8a");
    expect(check).toContain("Pack and smoke cycling-coach");
    expect(check).not.toContain("Test Desktop E2E on Linux");
    expect(check).not.toContain("xvfb-run");
    expect(ci).not.toContain("test_shards:");
    expect(ci).not.toMatch(/^  s8a:/mu);
  });

  it("runs one scoped macOS package and native UI job and preserves required status names", () => {
    const native = job(ci, "desktop-packaged-native");
    const packagedStatus = job(ci, "desktop-packaged-self-test");
    const secretsStatus = job(ci, "secrets-macos");
    expect(ci.match(/runs-on: macos-[^\r\n]+/gu)).toEqual(["runs-on: macos-26"]);
    expect(native).toContain("runs-on: macos-26");
    expect(native).toContain("needs: desktop-scope");
    expect(native).toContain("if: needs.desktop-scope.outputs.native == 'true'");
    expect(native).toContain("Verify native application UI states");
    expect(native).toContain("run: pnpm check:ui-states");
    expect(job(ci, "check")).not.toContain("pnpm check:ui-states");
    expect(native).toContain("package:dir");
    expect(native).toContain("--prepared-package");
    expect(native).not.toContain("-- --prepared-package");
    expect(native).toContain("Test Desktop integrations on macOS");
    expect(native).toContain("tests/onboarding-first-run.integration.test.ts");
    expect(native).toContain("tests/spend-meter.integration.test.ts");
    expect(native).toContain("tests/chat-panels.integration.test.ts");
    expect(native).toContain("Test Desktop E2E on macOS");
    expect(native).toContain("test:e2e");
    expect(native).toContain("desktop-e2e-macos-artifacts");
    expect(native).toContain(
      "run: pnpm --filter @enduragent/desktop package:telegram-acceptance:prepared",
    );
    expect(native).toContain("Test macOS Keychain secrets");
    expect(native).toContain("node_version=\"$(node -p 'process.version')\"");
    expect(native).toContain("node ../../node_modules/vitest/vitest.mjs run tests/secrets");
    expect(native).not.toContain("@enduragent/core exec node");
    expect(packagedStatus).toContain("runs-on: ubuntu-latest");
    expect(secretsStatus).toContain("runs-on: ubuntu-latest");
    expect(ci).not.toContain("desktop-integration-macos:");
    expect(ci).not.toContain("desktop-e2e-macos:");
  });

  it("detects native scope before installing workspace dependencies", () => {
    const scope = job(ci, "desktop-scope");
    expect(scope).toContain("native: ${{ steps.scope.outputs.native }}");
    expect(scope).toContain("fetch-depth: 0");
    expect(scope).toContain("node-version: 24");
    expect(scope).toContain("run: node tools/ui-verification/desktop-scope.ts");
    expect(scope.indexOf("actions/setup-node@")).toBeLessThan(scope.indexOf("- id: scope"));
    expect(scope).toContain(
      "BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}",
    );
    expect(scope).not.toContain("pnpm install");
    expect(ci).not.toContain("preview-scope");
    expect(ci).not.toContain("outputs.previews");
    expect(ci).not.toContain("playwright install chromium");
  });

  it("scopes Windows packaging and leaves synthetic contracts on Linux", () => {
    const windows = job(ci, "windows-desktop-package");
    expect(windows).toContain("needs: desktop-scope");
    expect(windows).toContain("needs.desktop-scope.outputs.native == 'true'");
    expect(windows).toContain("package:win");
    expect(windows).toContain("test:windows-installed-self-test");
    expect(windows).not.toContain("vitest run");
  });

  it("caches Docker layers and cancels obsolete image builds", () => {
    expect(image).toContain("cancel-in-progress: true");
    expect(image).toContain("cache-from: type=gha,scope=cycling-coach");
    expect(image).toContain("cache-to: type=gha,mode=max,scope=cycling-coach");
  });
});
