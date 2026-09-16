import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.union([z.string(), z.boolean()]).optional(),
  env: z.record(z.string(), z.string()).default({}),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
const jobSchema = z.object({
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).default([]),
  permissions: z.record(z.string(), z.string()).default({}),
  steps: z.array(stepSchema),
});
const workflowSchema = z.object({
  permissions: z.union([z.record(z.string(), z.string()), z.string()]).optional(),
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

function pinLines(run: string): string[] {
  return run
    .replace(/\\\s*\n/g, " ")
    .split("\n")
    .filter((line) => line.includes("models:release-pin"));
}

const release = workflow("release.yml");
const image = workflow("publish-image.yml");
const desktop = workflow("desktop-release.yml");
const windows = workflow("desktop-windows-release.yml");
const versionPr = workflow("version-pr.yml");
const pinWorkflows = [
  ["release.yml", release],
  ["publish-image.yml", image],
  ["desktop-release.yml", desktop],
  ["desktop-windows-release.yml", windows],
] as const;
const CONTRACT_BUILD = "pnpm --filter @enduragent/coach-contract build";

describe("model catalog release pin workflow wiring", () => {
  it("gives prepare jobs contents write and actions read", () => {
    const prepare = [
      job(release, "prepare-catalog"),
      job(image, "prepare-catalog"),
      job(desktop, "prepare-catalog"),
    ];
    for (const source of prepare) {
      expect(source.permissions).toEqual({ contents: "write", actions: "read" });
      expect(script(source)).toContain("models:release-pin prepare");
      expect(script(source)).toContain(
        'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .run_started_at',
      );
    }
    expect(script(job(windows, "verify-windows-envelope"))).not.toContain(
      "models:release-pin prepare",
    );
  });

  it("builds coach-contract after install and before any release-pin invocation", () => {
    for (const [name, source] of pinWorkflows) {
      for (const [jobName, value] of Object.entries(source.jobs)) {
        const run = script(value);
        if (!run.includes("models:release-pin")) continue;
        expect(run, `${name} ${jobName}`).toContain("pnpm install --frozen-lockfile");
        expect(run, `${name} ${jobName}`).toContain(CONTRACT_BUILD);
        const installAt = run.indexOf("pnpm install --frozen-lockfile");
        const buildAt = run.indexOf(CONTRACT_BUILD);
        const pinAt = run.indexOf("models:release-pin");
        expect(buildAt, `${name} ${jobName}`).toBeGreaterThan(installAt);
        expect(pinAt, `${name} ${jobName}`).toBeGreaterThan(buildAt);
      }
    }
    for (const source of [
      job(image, "prepare-catalog"),
      job(image, "image"),
      job(release, "prepare-catalog"),
      job(desktop, "prepare-catalog"),
      job(desktop, "verify-macos-envelope"),
      job(windows, "verify-windows-envelope"),
    ]) {
      expect(script(source)).not.toContain("pnpm -r build");
    }
  });

  it("release-pin still loads the bundled seed through coach-contract dist", () => {
    const seed = readFileSync(
      join(repositoryRoot, "packages/core/src/model-catalog-seed.ts"),
      "utf8",
    );
    const command = readFileSync(
      join(repositoryRoot, "tools/model-catalog-release-pin-command.ts"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "packages/coach-contract/package.json"), "utf8"),
    ) as { exports?: { "./model-catalog"?: { import?: string } } };
    expect(command).toContain('from "../packages/core/src/model-catalog-seed.js"');
    expect(seed).toContain('from "@enduragent/coach-contract/model-catalog"');
    expect(manifest.exports?.["./model-catalog"]?.import).toBe("./dist/model-catalog.js");
  });

  it("keeps pack, image, and sign jobs from gaining contents write", () => {
    const readers = [
      job(release, "smoke"),
      job(image, "image"),
      job(desktop, "sign-macos"),
      job(desktop, "verify-macos-envelope"),
    ];
    for (const source of readers) {
      expect(source.permissions.contents, JSON.stringify(source.permissions)).toBe("read");
      expect(source.permissions.contents).not.toBe("write");
    }
    expect(job(windows, "verify-windows-envelope").permissions.contents).toBe("write");
    expect(job(windows, "verify-windows-envelope").permissions.actions).toBe("read");
  });

  it("does not invent a clock or random in any run script", () => {
    for (const [name, source] of pinWorkflows) {
      for (const [jobName, value] of Object.entries(source.jobs)) {
        expect(script(value), `${name} ${jobName}`).not.toMatch(
          /Date\.now|new Date\(|Math\.random/,
        );
      }
    }
  });

  it("passes --now-iso on every prepare, read, materialize, and extract invocation", () => {
    for (const [name, source] of pinWorkflows) {
      for (const [jobName, value] of Object.entries(source.jobs)) {
        for (const line of pinLines(script(value))) {
          expect(line, `${name} ${jobName}: ${line}`).toContain("--now-iso");
          expect(line).toMatch(
            /pnpm --silent models:release-pin (prepare|read|materialize|extract)/,
          );
        }
      }
    }
  });

  it("installs the Windows NSIS envelope silently and extracts the unpacked tree", () => {
    const source = job(windows, "verify-windows-envelope");
    const catalog = source.steps.find((step) => step.id === "catalog");
    const evidence = source.steps.find((step) => step.run?.includes("--argjson catalog"));
    expect(catalog?.if).toBeUndefined();
    expect(catalog?.run).toContain('"$INSTALLER" /S');
    expect(catalog?.run).toContain("resources/app.asar");
    expect(catalog?.run).toContain("sleep 2");
    expect(catalog?.run).toContain("windows-unpacked");
    expect(catalog?.run).toContain("pwsh.exe");
    expect(catalog?.run).not.toContain("powershell.exe");
    expect(catalog?.run).toContain("RELEASE_CATALOG");
    expect(catalog?.run).toContain("Uninstall Enduragent.exe");
    expect(catalog?.run).toContain("trap");
    expect(script(source)).not.toMatch(/7z|7-Zip/i);
    expect(evidence?.if).toContain("dry_run == false");
    expect(evidence?.run).toContain('--argjson catalog "$RELEASE_CATALOG"');
    expect(evidence?.env.RELEASE_CATALOG).toBe("${{ steps.catalog.outputs.release_catalog }}");
    expect(evidence?.run).not.toContain("windows-unpacked");
  });

  it("splits image prepare from push and still publishes both GHCR names", () => {
    expect(job(image, "prepare-catalog")).toBeDefined();
    expect(dependencies(job(image, "image"))).toEqual(["prepare-catalog"]);
    expect(job(image, "image").permissions).toEqual({ contents: "read", packages: "write" });
    const push = script(job(image, "image"));
    expect(push).toContain("${IMAGE_NAME}:main-${short_sha}");
    expect(push).toContain("${ALIAS_IMAGE_NAME}:main-${short_sha}");
    expect(push).toContain("models:release-pin materialize");
    expect(push.indexOf(CONTRACT_BUILD)).toBeLessThan(
      push.indexOf("models:release-pin materialize"),
    );
    expect(push.indexOf("models:release-pin materialize")).toBeLessThan(
      push.indexOf("models:release-pin extract --kind oci-image"),
    );
    expect(push).toContain('--image "$image"');
    expect(push).toContain("linux/amd64");
    expect(push).toContain("linux/arm64");
  });

  it("seals and verifies the desktop envelope with the prepared catalog binding", () => {
    const sign = script(job(desktop, "sign-macos"));
    const verify = script(job(desktop, "verify-macos-envelope"));
    expect(sign).toContain('--catalog-release-group-id "$CATALOG_RELEASE_GROUP_ID"');
    expect(sign).toContain('--catalog-revision "$CATALOG_REVISION"');
    expect(sign).toContain('--catalog-digest "$CATALOG_DIGEST"');
    expect(verify).toContain('--catalog-release-group-id "$CATALOG_RELEASE_GROUP_ID"');
    expect(verify).toContain('--catalog-revision "$CATALOG_REVISION"');
    expect(verify).toContain('--catalog-digest "$CATALOG_DIGEST"');
    expect(verify).toContain("models:release-pin extract --kind macos-zip");
    expect(verify).toContain("Enduragent-$DESKTOP_VERSION-arm64.zip");
    expect(job(desktop, "sign-macos").permissions.contents).toBe("read");
    expect(script(job(desktop, "authorize-release"))).not.toMatch(
      /(?:pnpm|npm)\s+(?:install|ci|exec)/,
    );
  });

  it("keeps version-pr coordinators install-free", () => {
    for (const name of ["package-coordinator", "desktop-coordinator"]) {
      expect(script(job(versionPr, name))).not.toMatch(/(?:pnpm|npm)\s+(?:install|ci|exec)/);
    }
  });

  it("does not interpolate expressions inside run scripts", () => {
    for (const [name, source] of pinWorkflows) {
      for (const [jobName, value] of Object.entries(source.jobs)) {
        expect(script(value), `${name} ${jobName}`).not.toContain("${{");
      }
    }
  });
});

function dependencies(source: Job): string[] {
  return typeof source.needs === "string" ? [source.needs] : source.needs;
}
