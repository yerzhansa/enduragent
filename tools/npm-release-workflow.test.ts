import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
const jobSchema = z.object({
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).default([]),
  environment: z.string().optional(),
  permissions: z.record(z.string(), z.string()).default({}),
  env: z.record(z.string(), z.string()).default({}),
  steps: z.array(stepSchema),
});
const workflowSchema = z.object({
  on: z.record(z.string(), z.unknown()),
  permissions: z.record(z.string(), z.string()),
  jobs: z.record(z.string(), jobSchema),
});
type Workflow = z.infer<typeof workflowSchema>;
type Job = z.infer<typeof jobSchema>;
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function workflow(name: string): Workflow {
  return workflowSchema.parse(
    parse(readFileSync(join(repositoryRoot, ".github/workflows", name), "utf8")),
  );
}

function job(source: Workflow, name: string): Job {
  const result = source.jobs[name];
  if (!result) throw new Error(`Missing workflow job ${name}`);
  return result;
}

function script(source: Job): string {
  return source.steps.flatMap((step) => step.run ?? []).join("\n");
}

function dependencies(source: Job): string[] {
  return typeof source.needs === "string" ? [source.needs] : source.needs;
}

const release = workflow("release.yml");
const coordinator = workflow("version-pr.yml");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runCoordinator(options: {
  previousVersion?: string;
  version?: string;
  tagCommit?: string;
  tagDepth?: number;
  tagLookupFails?: boolean;
  dispatchFails?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), "npm-coordinator-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const log = join(directory, "calls.jsonl");
  mkdirSync(bin);
  writeFileSync(log, "");
  symlinkSync(process.execPath, join(bin, "node"));
  for (const [name, contents] of Object.entries({
    git: `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(["git", ...args]) + "\\n");
if (args[0] === "rev-parse") {
  if (!["HEAD", "HEAD^"].includes(args[1])) throw new Error("Unexpected git ref");
  console.log(args[1] === "HEAD" ? process.env.SOURCE_COMMIT : "b".repeat(40));
} else if (args[0] === "show") {
  console.log(JSON.stringify({ version: process.env.PREVIOUS_VERSION }));
} else {
  throw new Error("Unexpected git invocation: " + args.join(" "));
}`,
    gh: `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(["gh", ...args]) + "\\n");
if (args[0] !== "workflow" && args[0] !== "api") throw new Error("Unexpected gh invocation");
if (args[1]?.includes("/git/ref/tags/")) {
  if (process.env.TAG_LOOKUP_FAILS === "true") {
    console.error("HTTP 403");
    process.exit(1);
  }
  if (!process.env.FIXTURE_TAG_COMMIT) {
    console.error("HTTP 404");
    process.exit(1);
  }
  const depth = Number(process.env.TAG_DEPTH);
  console.log(JSON.stringify({object: depth > 0 ? {type: "tag", sha: "tag" + depth} : {type: "commit", sha: process.env.FIXTURE_TAG_COMMIT}}));
} else if (args[1]?.includes("/git/tags/")) {
  const depth = Number(args[1].split("/git/tags/tag")[1]) - 1;
  console.log(JSON.stringify({object: depth > 0 ? {type: "tag", sha: "tag" + depth} : {type: "commit", sha: process.env.FIXTURE_TAG_COMMIT}}));
}
if (args[0] === "workflow" && process.env.DISPATCH_FAILS === "true") process.exit(1);`,
    jq: `const fs = require("node:fs");
const [flag, field, input] = process.argv.slice(2);
if (flag !== "-er" || ![".version", ".object.sha", ".object.type"].includes(field)) throw new Error("Unexpected jq invocation");
console.log(field.slice(1).split(".").reduce((value, key) => value[key], JSON.parse(fs.readFileSync(input || 0, "utf8"))));`,
    sleep: `process.exit(0);`,
  })) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${contents}\n`, { mode: 0o755 });
  }
  for (const [name, contents] of Object.entries({
    "cycling-coach": { name: "cycling-coach", version: options.version ?? "2026.9.5" },
    "private-package": { name: "@enduragent/private-package", private: true, version: "0.0.0" },
  })) {
    const target = join(directory, "packages", name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "package.json"), JSON.stringify(contents));
  }
  const result = spawnSync("/bin/bash", ["-c", script(job(coordinator, "package-coordinator"))], {
    cwd: directory,
    encoding: "utf8",
    timeout: 25_000,
    env: {
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      HOME: directory,
      CALL_LOG: log,
      SOURCE_COMMIT: "a".repeat(40),
      FIXTURE_TAG_COMMIT: options.tagCommit ?? "",
      TAG_DEPTH: String(options.tagDepth ?? 0),
      TAG_LOOKUP_FAILS: String(options.tagLookupFails ?? false),
      PREVIOUS_VERSION: options.previousVersion ?? "2026.8.18",
      DISPATCH_FAILS: String(options.dispatchFails ?? false),
      GITHUB_REPOSITORY: "fixture/project",
      GITHUB_RUN_ID: "1234",
      GITHUB_RUN_ATTEMPT: "3",
      RUNNER_TEMP: directory,
    },
  });
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => z.array(z.string()).parse(JSON.parse(line)));
  return { result, calls };
}

describe("npm package coordinator dispatch", { timeout: 30_000 }, () => {
  it("dispatches from main with the exact source and coordinator attempt identity", () => {
    const { result, calls } = runCoordinator({});
    expect(result.status, result.stderr).toBe(0);
    expect(calls.filter((call) => call[0] === "gh")).toEqual([
      ["gh", "api", "repos/fixture/project/git/ref/tags/cycling-coach@2026.9.5"],
      [
        "gh",
        "api",
        "--method",
        "POST",
        "repos/fixture/project/git/refs",
        "-f",
        "ref=refs/tags/cycling-coach@2026.9.5",
        "-f",
        `sha=${"a".repeat(40)}`,
      ],
      [
        "gh",
        "workflow",
        "run",
        "release.yml",
        "--ref",
        "main",
        "-f",
        "phase=prepare",
        "-f",
        "tag=cycling-coach@2026.9.5",
        "-f",
        `commit=${"a".repeat(40)}`,
        "-f",
        "coordinator_run_id=1234",
        "-f",
        "coordinator_run_attempt=3",
      ],
    ]);
    expect(calls.some((call) => call.some((arg) => arg.includes("private-package")))).toBe(false);
  });

  it("reuses a tag only when it resolves to the exact source commit", () => {
    const { result, calls } = runCoordinator({ tagCommit: "a".repeat(40) });
    expect(result.status, result.stderr).toBe(0);
    expect(calls.some((call) => call.includes("POST"))).toBe(false);
    expect(calls.filter((call) => call[0] === "gh" && call[1] === "workflow")).toHaveLength(1);
    expect(calls).toContainEqual([
      "gh",
      "api",
      "repos/fixture/project/git/ref/tags/cycling-coach@2026.9.5",
    ]);
  });

  it("refuses a mismatching tag before dispatch or tag mutation", () => {
    const { result, calls } = runCoordinator({ tagCommit: "c".repeat(40) });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Existing tag resolves to a different source commit");
    expect(calls.some((call) => call.includes("POST") || call[1] === "workflow")).toBe(false);
  });

  it("peels annotated tags before checking their source commit", () => {
    const { result, calls } = runCoordinator({ tagCommit: "a".repeat(40), tagDepth: 2 });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContainEqual(["gh", "api", "repos/fixture/project/git/tags/tag2"]);
    expect(calls).toContainEqual(["gh", "api", "repos/fixture/project/git/tags/tag1"]);
    expect(calls.filter((call) => call[1] === "workflow")).toHaveLength(1);
  });

  it("refuses to dispatch an unresolved tag after ten indirections", () => {
    const { result, calls } = runCoordinator({ tagCommit: "a".repeat(40), tagDepth: 11 });
    expect(result.status).not.toBe(0);
    expect(calls.filter((call) => call[2]?.includes("/git/tags/"))).toHaveLength(10);
    expect(calls.some((call) => call.includes("POST") || call[1] === "workflow")).toBe(false);
  });

  it("refuses tag creation and dispatch on lookup errors other than absence", () => {
    const { result, calls } = runCoordinator({ tagLookupFails: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Release tag lookup failed");
    expect(calls.some((call) => call.includes("POST") || call[1] === "workflow")).toBe(false);
  });

  it("skips an unchanged package version without remote tag lookups", () => {
    const { result, calls } = runCoordinator({ previousVersion: "2026.9.5" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("skipping npm release");
    expect(calls.filter((call) => call[0] === "gh" || call[1] === "ls-remote")).toEqual([]);
  });

  it("rejects shell metacharacters in package metadata before external mutations", () => {
    const { result, calls } = runCoordinator({ version: "2026.9.5; gh forbidden" });
    expect(result.status).not.toBe(0);
    expect(calls.filter((call) => call[0] === "gh")).toEqual([]);
  });

  it("reports dispatch failure after six attempts", () => {
    const { result, calls } = runCoordinator({ dispatchFails: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("after bounded retries");
    expect(calls.filter((call) => call[0] === "gh" && call[1] === "workflow")).toHaveLength(6);
  });
});

describe("version PR coordinator gate", () => {
  const coordinators = ["package-coordinator", "desktop-coordinator"] as const;

  function gateExpression(): string {
    const expression = job(coordinator, "package-coordinator").if;
    if (!expression) throw new Error("package-coordinator is missing if");
    return expression;
  }

  function pushMessageWouldRunCoordinators(message: string): boolean {
    const expression = gateExpression();
    const title = expression.match(/startsWith\(github\.event\.head_commit\.message, '([^']*)'\)/);
    const mergedHead = expression.match(
      /contains\(github\.event\.head_commit\.message, '([^']*)'\)/,
    );
    if (!title?.[1] || !mergedHead?.[1] || !expression.includes("||")) {
      throw new Error(`coordinator if must OR title and merged-head detection: ${expression}`);
    }
    return message.startsWith(title[1]) || message.includes(mergedHead[1]);
  }

  it("shares a push OR-gate across both coordinators", () => {
    const expression = gateExpression();
    expect(expression).toBe(
      "github.event_name == 'push' && (startsWith(github.event.head_commit.message, 'Version Packages') || contains(github.event.head_commit.message, 'changeset-release/main'))",
    );
    for (const name of coordinators) {
      expect(job(coordinator, name).if, name).toBe(expression);
    }
  });

  it("would have run coordinators for the #1082 changeset-release merge commit", () => {
    const incident =
      "Merge pull request #1082 from yerzhansa/changeset-release/main\n\nVersion Packages";
    expect(pushMessageWouldRunCoordinators(incident)).toBe(true);
    expect(pushMessageWouldRunCoordinators("Version Packages")).toBe(true);
    expect(pushMessageWouldRunCoordinators("Version Packages\n\nBumps desktop.")).toBe(true);
    expect(pushMessageWouldRunCoordinators("Version Packages (#1082)")).toBe(true);
    expect(
      pushMessageWouldRunCoordinators(
        "Merge pull request #1081 from yerzhansa/cursor/catalog-usable-snapshot-bar-aacb",
      ),
    ).toBe(false);
    expect(pushMessageWouldRunCoordinators("fix: something else")).toBe(false);
  });
});

describe("protected-main npm workflow boundaries", () => {
  it("resolves runner paths only in the publishing step environment", () => {
    for (const source of [release, coordinator]) {
      for (const [name, value] of Object.entries(source.jobs)) {
        for (const expression of Object.values(value.env)) {
          expect(expression, name).not.toMatch(/\brunner\s*(?:\.|\[)/);
        }
      }
    }
    for (const name of ["primary-stage", "alias-stage"]) {
      const source = job(release, name);
      const stage = source.steps.find((step) => step.run?.includes("npm-release.ts stage"));
      const receipt = source.steps.find((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      );
      expect(stage?.env, name).toMatchObject({
        PUBLISHER_NPM: "${{ runner.temp }}/publisher/package/bin/npm-cli.js",
        RECEIPT_PATH: receipt?.with.path,
      });
    }
  });

  it("gates every job through a main-only explicit dispatch", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(job(release, "parse-tag").if).toBe(
      "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'",
    );
    function reachesGate(name: string, seen = new Set<string>()): boolean {
      if (name === "parse-tag") return true;
      if (seen.has(name)) return false;
      return dependencies(job(release, name)).some((dependency) =>
        reachesGate(dependency, new Set([...seen, name])),
      );
    }
    for (const name of Object.keys(release.jobs)) expect(reachesGate(name), name).toBe(true);
  });

  it("keeps dependency installation outside tag and stage coordinators", () => {
    for (const name of ["package-coordinator", "desktop-coordinator"]) {
      expect(script(job(coordinator, name))).not.toMatch(/(?:pnpm|npm)\s+(?:install|ci|exec)/);
      expect(job(coordinator, name).steps.some((step) => step.uses?.startsWith("pnpm/"))).toBe(
        false,
      );
    }
    for (const name of [
      "parse-tag",
      "reserve",
      "primary-intent",
      "alias-intent",
      "primary-stage",
      "alias-stage",
    ]) {
      expect(script(job(release, name)), name).not.toMatch(
        /(?:pnpm|npm)\s+(?:install|ci|exec|run)/,
      );
    }
  });

  it("runs release control from the workflow commit and builds only the validated source", () => {
    for (const [name, source] of Object.entries(release.jobs)) {
      const checkouts = source.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
      for (const checkout of checkouts) {
        const buildsPackage =
          ["build", "test", "smoke"].includes(name) && checkout.with.path !== ".release-control";
        const pinsCatalog = name === "prepare-catalog";
        expect(checkout.with.ref, name).toBe(
          buildsPackage || pinsCatalog
            ? "${{ needs.parse-tag.outputs.commit }}"
            : "${{ github.sha }}",
        );
        if (buildsPackage) expect(source.permissions, name).toEqual({ contents: "read" });
      }
    }
  });

  it("grants publishing identity only to the two stage jobs", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(
      Object.entries(release.jobs)
        .filter(([, value]) => value.permissions["id-token"] === "write")
        .map(([name]) => name)
        .sort(),
    ).toEqual(["alias-stage", "primary-stage"]);
    for (const name of ["primary-stage", "alias-stage"]) {
      expect(job(release, name).environment).toBe("npm-production");
      expect(job(release, name).permissions).toEqual({
        actions: "read",
        contents: "read",
        "id-token": "write",
      });
    }
    for (const source of [release, coordinator]) {
      for (const value of Object.values(source.jobs)) {
        expect(JSON.stringify(value)).not.toMatch(/secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)/);
        for (const step of value.steps.filter((entry) =>
          entry.uses?.startsWith("actions/checkout@"),
        )) {
          expect(step.with["persist-credentials"]).toBe(false);
        }
      }
    }
  });

  it("pins the administrator-verified reservation policy in every reserve, intent, and stage job", () => {
    for (const name of [
      "reserve",
      "primary-intent",
      "alias-intent",
      "primary-stage",
      "alias-stage",
    ]) {
      const source = job(release, name);
      expect(source.env, name).toMatchObject({
        RESERVATION_RULESET_ID: "${{ vars.RESERVATION_RULESET_ID }}",
        RESERVATION_RULESET_UPDATED_AT: "${{ vars.RESERVATION_RULESET_UPDATED_AT }}",
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      });
      expect(source.permissions.administration, name).toBeUndefined();
    }
  });

  it("passes event input through environment values instead of interpolating shell programs", () => {
    for (const source of [release, coordinator]) {
      for (const [name, value] of Object.entries(source.jobs))
        expect(script(value), name).not.toContain("${{");
    }
    expect(job(release, "parse-tag").env).toMatchObject({
      RELEASE_TAG: "${{ inputs.tag }}",
      RELEASE_COMMIT: "${{ inputs.commit }}",
      COORDINATOR_RUN_ID: "${{ inputs.coordinator_run_id }}",
      COORDINATOR_RUN_ATTEMPT: "${{ inputs.coordinator_run_attempt }}",
    });
  });

  it("seals both archives and their source identity before an immutable upload and reservation", () => {
    const smoke = job(release, "smoke");
    const sealIndex = smoke.steps.findIndex((step) => step.run?.includes("npm-release.ts seal"));
    const uploadIndex = smoke.steps.findIndex((step) => step.id === "npm-artifact");
    expect(sealIndex).toBeGreaterThan(0);
    expect(uploadIndex).toBeGreaterThan(sealIndex);
    expect(smoke.steps[sealIndex]?.env).toMatchObject({
      RELEASE_COMMIT: "${{ needs.parse-tag.outputs.commit }}",
      COORDINATOR_RUN_ID: "${{ inputs.coordinator_run_id }}",
      COORDINATOR_RUN_ATTEMPT: "${{ inputs.coordinator_run_attempt }}",
      CATALOG_RELEASE_GROUP_ID: "${{ needs.prepare-catalog.outputs.catalog_release_group_id }}",
      CATALOG_REVISION: "${{ needs.prepare-catalog.outputs.catalog_revision }}",
      CATALOG_DIGEST: "${{ needs.prepare-catalog.outputs.catalog_digest }}",
    });
    expect(smoke.steps[sealIndex]?.run).toContain("RELEASE_CATALOG");
    expect(smoke.steps[uploadIndex]?.with).toMatchObject({
      name: "npm-release-${{ github.run_id }}-${{ github.run_attempt }}-${{ needs.parse-tag.outputs.package }}",
      path: "${{ steps.pack.outputs.pack_dir }}/*.tgz\n${{ steps.pack.outputs.pack_dir }}/release-manifest.json\n",
      "if-no-files-found": "error",
    });
    const packing = smoke.steps.find((step) => step.id === "pack")?.run;
    expect(packing).toContain('pnpm check:published-package -- "$TARBALL"');
    expect(packing).toContain('pnpm check:published-package -- "$PACK_DIR/$ALIAS_FILENAME"');
    expect(packing).toContain('shasum -a 512 "$TARBALL"');
    expect(packing).toContain('shasum -a 512 "$PACK_DIR/$ALIAS_FILENAME"');
    expect(dependencies(job(release, "reserve"))).toContain("smoke");
    expect(dependencies(job(release, "primary-intent"))).toContain("reserve");
  });

  it("restores exact archives before staging and retains outcomes even on failure", () => {
    for (const name of ["primary-stage", "alias-stage"]) {
      const source = job(release, name);
      const intent = name === "primary-stage" ? "primary-intent" : "alias-intent";
      expect(source.if).toBe(`needs.${intent}.outputs.stage == 'true'`);
      expect(dependencies(source)).toContain(intent);
      const restoreIndex = source.steps.findIndex((step) =>
        step.run?.includes("npm-release.ts restore"),
      );
      const stageIndex = source.steps.findIndex((step) =>
        step.run?.includes("npm-release.ts stage"),
      );
      const receipt = source.steps.find((step) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      );
      expect(restoreIndex, name).toBeGreaterThan(0);
      expect(stageIndex, name).toBeGreaterThan(restoreIndex);
      expect(receipt?.if).toBe("always()");
      expect(receipt?.with["if-no-files-found"]).toBe("error");
      expect(script(source).indexOf("sha512sum --check")).toBeLessThan(
        script(source).indexOf("npm-release.ts stage"),
      );
      expect(script(source).match(/[a-f0-9]{128}/g)).toEqual(
        script(job(release, "publisher-tools")).match(/[a-f0-9]{128}/g),
      );
      for (const step of source.steps.filter((entry) =>
        entry.uses?.startsWith("actions/download-artifact@"),
      )) {
        expect(step.with["artifact-ids"]).toBeTruthy();
        expect(step.with["digest-mismatch"]).toBe("error");
      }
    }
    expect(dependencies(job(release, "alias-intent"))).toContain("primary-stage");
    expect(job(release, "alias-intent").if).toContain(
      "needs.primary-stage.result == 'success' || needs.primary-stage.result == 'skipped'",
    );
    expect(dependencies(job(release, "publish-package-only-release"))).toContain(
      "verify-npm-publication",
    );
    expect(job(release, "verify-npm-publication").if).toBe("inputs.phase == 'finalize'");
  });

  it("preserves desktop dispatch from its validated release tag", () => {
    const desktop = script(job(coordinator, "desktop-coordinator"));
    expect(desktop).toContain('gh workflow run desktop-release.yml --ref "$DESKTOP_TAG"');
    expect(desktop).toContain('if [ "$DESKTOP_TAG_COMMIT" != "$RELEASE_COMMIT" ]');
    expect(desktop).toContain('-f commit="$RELEASE_COMMIT"');
    expect(desktop).toContain('-f draft_id="$DRAFT_ID"');
    expect(desktop).toContain('-f draft_body_sha256="$RELEASE_BODY_SHA256"');
  });
});

describe("release catalog pin jobs", () => {
  it("prepares the pin after parse-tag and only during prepare", () => {
    const source = job(release, "prepare-catalog");
    expect(source.if).toBe("inputs.phase == 'prepare'");
    expect(dependencies(source)).toEqual(["parse-tag"]);
    expect(source.permissions).toEqual({ contents: "write", actions: "read" });
    expect(script(source)).toContain("pnpm --silent models:release-pin prepare");
    expect(script(source)).toContain("pnpm --filter @enduragent/coach-contract build");
    expect(script(source)).toContain("--now-iso");
    expect(script(source)).not.toMatch(/Date\.now|new Date\(|Math\.random/);
    expect(script(source)).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .run_started_at',
    );
  });

  it("keeps owner tests on the bundled checkout and materializes only in smoke", () => {
    expect(script(job(release, "build"))).not.toContain("models:release-pin");
    expect(script(job(release, "test"))).not.toContain("models:release-pin");
    const smoke = job(release, "smoke");
    expect(dependencies(smoke)).toEqual(["parse-tag", "build", "test", "prepare-catalog"]);
    expect(smoke.permissions).toEqual({ contents: "read" });
    const installIndex = smoke.steps.findIndex(
      (step) => step.run === "pnpm install --frozen-lockfile",
    );
    const contractBuildIndex = smoke.steps.findIndex(
      (step) => step.run === "pnpm --filter @enduragent/coach-contract build",
    );
    const materializeIndex = smoke.steps.findIndex((step) =>
      step.run?.includes("models:release-pin materialize"),
    );
    const buildIndex = smoke.steps.findIndex((step) => step.run === "pnpm -r build");
    const packIndex = smoke.steps.findIndex((step) => step.id === "pack");
    expect(contractBuildIndex).toBeGreaterThan(installIndex);
    expect(materializeIndex).toBeGreaterThan(contractBuildIndex);
    expect(buildIndex).toBeGreaterThan(materializeIndex);
    expect(packIndex).toBeGreaterThan(buildIndex);
    expect(smoke.steps[materializeIndex]?.run).toContain("models:release-pin read");
    expect(smoke.steps[packIndex]?.run).toContain("models:release-pin extract --kind npm-tarball");
    expect(smoke.steps[packIndex]?.run).toContain("--expected-release-group-id");
    expect(script(smoke)).not.toMatch(/Date\.now|new Date\(|Math\.random/);
  });

  it("does not prepare a catalog pin on resume or finalize", () => {
    expect(script(job(release, "parse-tag"))).not.toContain("models:release-pin");
    expect(script(job(release, "primary-stage"))).not.toContain("models:release-pin");
    expect(script(job(release, "alias-stage"))).not.toContain("models:release-pin");
    expect(script(job(release, "verify-npm-publication"))).not.toContain("models:release-pin");
  });
});
