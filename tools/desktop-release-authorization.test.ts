import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z
        .array(z.object({ name: z.string().optional(), run: z.string().optional() }))
        .default([]),
    }),
  ),
});
const workflowsDirectory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

function workflow(name: string) {
  return workflowSchema.parse(parse(readFileSync(join(workflowsDirectory, name), "utf8")));
}

const gitShowIntoEarlyExitReader =
  /git show [^|\n]*\|\s*(?:grep\s+-[A-Za-z]*[mq]|head\b|awk\s+'[^']*\bexit\b|sed\s[^|\n]*\bq\b)/;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("desktop release authorization", () => {
  it("flags git show piped into a reader that can exit before the end", () => {
    expect("X=$(git show \"$C:apps/desktop/CHANGELOG.md\" | grep -m1 '^## ')").toMatch(
      gitShowIntoEarlyExitReader,
    );
    expect(
      "X=$(git show \"$C:apps/desktop/CHANGELOG.md\" | awk '/^## /{i++} i==1{print} i==2{exit}' | tail -n +2)",
    ).toMatch(gitShowIntoEarlyExitReader);
    expect("X=$(git show \"$C:apps/desktop/package.json\" | jq -er '.version')").not.toMatch(
      gitShowIntoEarlyExitReader,
    );

    for (const name of readdirSync(workflowsDirectory).filter((file) => file.endsWith(".yml"))) {
      for (const job of Object.values(workflow(name).jobs)) {
        for (const step of job.steps) {
          expect(step.run ?? "", `${name}: ${step.name}`).not.toMatch(gitShowIntoEarlyExitReader);
        }
      }
    }
  });

  it("passes ten times in a row with a changelog larger than a pipe buffer", () => {
    const authorize = workflow("desktop-release.yml").jobs["authorize-release"]?.steps.find(
      (step) => step.name === "Authorize release dispatch",
    )?.run;
    if (!authorize) throw new Error("Missing Authorize release dispatch step");

    const directory = mkdtempSync(join(tmpdir(), "desktop-release-authorization-"));
    directories.push(directory);
    const version = "9.9.9";
    const tag = `enduragent-desktop@${version}`;
    const repository = "example/enduragent";
    const body = "\n### Patch Changes\n\n- Fix the synthetic release.";
    const olderReleases = Array.from(
      { length: 20_000 },
      (_, index) => `## 0.0.${index}\n\n- Synthetic release notes.\n`,
    ).join("\n");
    const changelog = `# enduragent-desktop\n\n## ${version}\n${body}\n\n${olderReleases}`;
    expect(Buffer.byteLength(changelog)).toBeGreaterThan(65_536);

    const gitEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Synthetic",
      GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic",
      GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
    };
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const source = join(directory, "source");
    mkdirSync(join(source, "apps/desktop"), { recursive: true });
    writeFileSync(join(source, "apps/desktop/package.json"), JSON.stringify({ version }));
    writeFileSync(join(source, "apps/desktop/CHANGELOG.md"), changelog);
    git(source, "init", "--quiet", "--initial-branch=main");
    git(source, "add", "--all");
    git(source, "commit", "--quiet", "--message", "Version Packages");
    git(source, "tag", tag);
    const checkout = join(directory, "checkout");
    git(directory, "clone", "--quiet", source, checkout);
    const commit = git(checkout, "rev-parse", "HEAD");

    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}\nconst [command, path] = process.argv.slice(2);
if (command !== "api" || path !== "repos/${repository}/releases/42") process.exit(1);
console.log(JSON.stringify({ id: 42, tag_name: ${JSON.stringify(tag)}, prerelease: false, draft: true, body: ${JSON.stringify(body)} }));\n`,
      { mode: 0o755 },
    );
    const runnerTemp = join(directory, "runner-temp");
    mkdirSync(runnerTemp);

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const result = spawnSync("/bin/bash", ["-c", authorize], {
        cwd: checkout,
        encoding: "utf8",
        timeout: 25_000,
        env: {
          ...gitEnv,
          PATH: [bin, process.env.PATH].join(delimiter),
          RUNNER_TEMP: runnerTemp,
          GITHUB_REPOSITORY: repository,
          GH_TOKEN: "synthetic",
          RELEASE_TAG: tag,
          DESKTOP_VERSION: version,
          RELEASE_COMMIT: commit,
          RELEASE_DRAFT_ID: "42",
          RELEASE_BODY_SHA256: createHash("sha256").update(body).digest("hex"),
          RELEASE_BASELINE_TAG: "none",
          DESKTOP_ENABLED: "true",
          WORKFLOW_REF: `refs/tags/${tag}`,
          WORKFLOW_REF_NAME: tag,
          WORKFLOW_COMMIT: commit,
          CURRENT_RUN_ID: "7",
          CURRENT_RUN_ATTEMPT: String(attempt),
          EVENT_NAME: "workflow_dispatch",
          CALLER_WORKFLOW_REF: `${repository}/.github/workflows/desktop-release.yml@refs/tags/${tag}`,
          CALLER_WORKFLOW_SHA: commit,
          REPOSITORY_ID: "1",
        },
      });
      expect(
        { status: result.status, signal: result.signal },
        `attempt ${attempt}: ${result.stderr}`,
      ).toEqual({ status: 0, signal: null });
    }
  });
});
