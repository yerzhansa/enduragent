import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Docker image supply-chain guards", () => {
  it("pins every Dockerfile base image by digest", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "packages/cycling-coach/Dockerfile"), "utf8");
    const fromLines = dockerfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("FROM "));

    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) {
      expect(line).toMatch(/^FROM\s+\S+@sha256:[a-f0-9]{64}(?:\s+AS\s+\S+)?$/);
    }
  });

  it("copies canonical legal inputs before building and preserves runtime copies", () => {
    const dockerfile = readFileSync(resolve(repoRoot, "packages/cycling-coach/Dockerfile"), "utf8");
    const builderCopy = "COPY LICENSE NOTICE.md ./";
    const build = "RUN pnpm --filter cycling-coach... build";
    const runtimeCopy = "COPY --chown=root:root LICENSE NOTICE.md ./";

    expect(dockerfile.indexOf(builderCopy)).toBeGreaterThan(-1);
    expect(dockerfile.indexOf(builderCopy)).toBeLessThan(dockerfile.indexOf(build));
    expect(dockerfile.indexOf(runtimeCopy)).toBeGreaterThan(dockerfile.indexOf(build));
  });

  it("keeps Dependabot watching the cycling-coach Dockerfile", () => {
    const dependabot = YAML.parse(
      readFileSync(resolve(repoRoot, ".github/dependabot.yml"), "utf8"),
    ) as { updates?: Array<Record<string, unknown>> };

    expect(
      dependabot.updates?.some(
        (entry) =>
          entry["package-ecosystem"] === "docker" && entry.directory === "/packages/cycling-coach",
      ),
    ).toBe(true);
  });

  it("configures one root npm update stream with reviewed grouping", () => {
    const dependabot = YAML.parse(
      readFileSync(resolve(repoRoot, ".github/dependabot.yml"), "utf8"),
    ) as { updates?: Array<Record<string, unknown>> };
    const npmUpdates =
      dependabot.updates?.filter((entry) => entry["package-ecosystem"] === "npm") ?? [];

    expect(npmUpdates).toHaveLength(1);
    expect(npmUpdates[0].directory).toBe("/");
    expect(npmUpdates[0].schedule).toEqual({ interval: "weekly" });
    expect(npmUpdates[0].groups).toEqual({
      "minor-and-patch": { patterns: ["*"], "update-types": ["minor", "patch"] },
    });
    expect(npmUpdates[0].ignore).toContainEqual({
      "dependency-name": "pyodide",
      "update-types": ["version-update:semver-major"],
    });
  });

  it("keeps stale build allowlisting and second lockfiles out of the workspace", () => {
    const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      pnpm?: { onlyBuiltDependencies?: string[] };
    };
    expect(rootManifest.pnpm?.onlyBuiltDependencies).not.toContain("@google/genai");
    expect(rootManifest.pnpm?.onlyBuiltDependencies).not.toContain("protobufjs");

    const forbiddenTrackedFiles = execFileSync(
      "git",
      ["ls-files", "*npm-shrinkwrap.json", "*package-lock.json", "patches/**"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
    expect(forbiddenTrackedFiles).toBe("");
  });
});
