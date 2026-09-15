import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptedReceipt,
  manifest,
  promoteLatest,
  restore,
  runNpmRelease,
  stageResponse,
  validateArtifact,
  validateInvocation,
  validatePolicies,
  validateRun,
  validateSource,
  verifyArchives,
  verifyPolicy,
} from "./npm-release.js";

const repository = "yerzhansa/enduragent";
const version = "1998.8.7";
const tag = `cycling-coach@${version}`;
const source = "a".repeat(40);
const preparation = { runId: "456", attempt: "2", workflowCommit: "b".repeat(40) };
const publisher = { runId: "789", attempt: "1", workflowCommit: "c".repeat(40) };
const coordinator = { runId: "123", attempt: "1", workflowCommit: source };
const reservationSha = "d".repeat(40);
const catalog = {
  releaseGroupId: source,
  revision: 1,
  digest: "0".repeat(64),
};
const stageId = "12345678-1234-1234-1234-123456789abc";
const policyRevision = "1998-08-07T00:00:00Z";
const tagPolicy = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  updated_at: policyRevision,
  target: "tag",
  enforcement: "active",
  bypass_actors: [],
  rules: [{ type: "update" }, { type: "deletion" }],
  conditions: {
    ref_name: {
      include: ["refs/tags/npm-stage/**", "refs/tags/npm-stage-attempt/**"],
      exclude: [],
    },
  },
  ...extra,
});
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const sha = (value: string | Buffer, algorithm = "sha256") =>
  createHash(algorithm).update(value).digest("hex");
const routes = new Map<string, unknown>();
const requests: { path: string; method: string; body?: unknown }[] = [];
let directory: string;
let release: ReturnType<typeof manifest>;
let reservation: {
  manifest: ReturnType<typeof manifest>;
  artifactId: string;
  artifactDigest: string;
  sha: string;
};

function workflowRun(invocation: typeof preparation, workflow: string, event: string) {
  return {
    id: Number(invocation.runId),
    run_attempt: Number(invocation.attempt),
    head_sha: invocation.workflowCommit,
    head_branch: "main",
    path: `.github/workflows/${workflow}`,
    event,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
}

function installRun(invocation: typeof preparation, workflow: string, event: string, job: string) {
  const path = `actions/runs/${invocation.runId}/attempts/${invocation.attempt}`;
  routes.set(path, workflowRun(invocation, workflow, event));
  routes.set(`${path}/jobs?per_page=100&page=1`, {
    jobs: [{ name: job, status: "completed", conclusion: "success" }],
  });
}

function installAttempt(name: "cycling-coach" | "enduragent" = "cycling-coach", owner = publisher) {
  const attempt = { reservation: reservationSha, name, publisher: owner };
  const attemptName = `npm-stage-attempt/${tag}/${name}`;
  const id = (name === "cycling-coach" ? "e" : "f").repeat(40);
  routes.set(`git/ref/tags/${attemptName}`, { object: { type: "tag", sha: id } });
  routes.set(`git/tags/${id}`, {
    tag: attemptName,
    object: { type: "commit", sha: owner.workflowCommit },
    message: json(attempt),
  });
  return attempt;
}

function zip(name: string, folder: string, files: string[]) {
  const path = join(directory, name);
  execFileSync("zip", ["-q", path, ...files], { cwd: folder });
  return path;
}

function installReceipt(status = "accepted") {
  const attempt = installAttempt();
  const name = `npm-stage-receipt-${preparation.runId}-${preparation.attempt}-cycling-coach-${publisher.runId}-${publisher.attempt}`;
  const folder = join(directory, "receipt");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "receipt.json"),
    json({
      status,
      reservation: reservationSha,
      name: "cycling-coach",
      publisher,
      manifestSha256: sha(json(release)),
      stageId,
    }),
  );
  const path = zip(`receipt-${status}.zip`, folder, ["receipt.json"]);
  routes.set(`actions/runs/${publisher.runId}/artifacts?name=${name}&per_page=100`, {
    artifacts: [
      {
        id: 901,
        name,
        expired: false,
        workflow_run: { id: Number(publisher.runId), head_sha: publisher.workflowCommit },
        digest: `sha256:${sha(readFileSync(path))}`,
      },
    ],
  });
  vi.stubEnv("FAKE_RECEIPT_ZIP", path);
  return attempt;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "npm-release-contract-"));
  routes.clear();
  requests.length = 0;
  const archives = (["cycling-coach", "enduragent"] as const).map((name) => {
    const folder = join(directory, name);
    mkdirSync(join(folder, "package"), { recursive: true });
    writeFileSync(
      join(folder, "package/package.json"),
      json({
        name,
        version,
        repository: {
          type: "git",
          url: `git+https://github.com/${repository}.git`,
          directory: "packages/cycling-coach",
        },
      }),
    );
    const filename = `${name}-${version}.tgz`;
    execFileSync("tar", ["-czf", join(directory, filename), "package/package.json"], {
      cwd: folder,
    });
    const bytes = readFileSync(join(directory, filename));
    return { name, filename, size: bytes.length, sha512: sha(bytes, "sha512") };
  });
  release = manifest({
    schema: 2,
    tag,
    version,
    sourceCommit: source,
    catalog,
    coordinator,
    preparation,
    archives,
  });
  writeFileSync(join(directory, "release-manifest.json"), json(release));
  const artifactZip = zip("prepared.zip", directory, [
    "release-manifest.json",
    ...archives.map((archive) => archive.filename),
  ]);
  reservation = {
    manifest: release,
    artifactId: "900",
    artifactDigest: sha(readFileSync(artifactZip)),
    sha: reservationSha,
  };
  routes.set(`git/ref/tags/npm-stage/${tag}`, { object: { type: "tag", sha: reservationSha } });
  routes.set(`git/tags/${reservationSha}`, {
    tag: `npm-stage/${tag}`,
    object: { type: "commit", sha: source },
    message: json(reservation),
  });
  routes.set(`git/ref/tags/${tag}`, { object: { type: "commit", sha: source } });
  routes.set("branches/main", { protected: true, commit: { sha: publisher.workflowCommit } });
  for (const ancestor of [source, preparation.workflowCommit])
    routes.set(`compare/${ancestor}...${publisher.workflowCommit}`, {
      status: "ahead",
      base_commit: { sha: ancestor },
      merge_base_commit: { sha: ancestor },
    });
  routes.set(`contents/packages/cycling-coach/package.json?ref=${source}`, {
    type: "file",
    encoding: "base64",
    content: Buffer.from(json({ name: "cycling-coach", version })).toString("base64"),
  });
  installRun(coordinator, "version-pr.yml", "push", "package-coordinator");
  installRun(preparation, "release.yml", "workflow_dispatch", "smoke");
  installRun(publisher, "release.yml", "workflow_dispatch", "primary-intent");
  routes.set("actions/artifacts/900", {
    id: 900,
    expired: false,
    name: `npm-release-${preparation.runId}-${preparation.attempt}-cycling-coach`,
    digest: `sha256:${reservation.artifactDigest}`,
    workflow_run: { id: Number(preparation.runId), head_sha: preparation.workflowCommit },
  });
  for (const name of ["npm-production", "npm-stage"]) {
    routes.set(`environments/${name}`, {
      can_admins_bypass: false,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    routes.set(`environments/${name}/deployment-branch-policies`, {
      branch_policies: [{ name: "main", type: "branch" }],
    });
  }
  routes.set("rulesets/1", tagPolicy());
  vi.stubEnv("RESERVATION_RULESET_ID", "1");
  vi.stubEnv("RESERVATION_RULESET_UPDATED_AT", policyRevision);
  vi.stubEnv("GH_TOKEN", "fixture-github-token");
  vi.stubEnv("GITHUB_REPOSITORY", repository);
  vi.stubEnv("GITHUB_REF", "refs/heads/main");
  vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
  vi.stubEnv("GITHUB_SHA", publisher.workflowCommit);
  vi.stubEnv("GITHUB_RUN_ID", publisher.runId);
  vi.stubEnv("GITHUB_RUN_ATTEMPT", publisher.attempt);
  vi.stubEnv("GITHUB_OUTPUT", join(directory, "output"));
  vi.stubEnv("RELEASE_TAG", tag);
  vi.stubEnv("RELEASE_PACKAGE", "cycling-coach");
  vi.stubEnv("RUNNER_TEMP", directory);
  vi.stubEnv("FAKE_ARTIFACT_ZIP", artifactZip);
  const binaries = join(directory, "bin");
  mkdirSync(binaries);
  writeFileSync(
    join(binaries, "gh"),
    `#!/usr/bin/env node\nconst {readFileSync} = require('node:fs');\nconst path = process.argv[3];\nif (!path?.endsWith('/900/zip') && !path?.endsWith('/901/zip')) throw new Error('Unexpected fake GitHub command');\nprocess.stdout.write(readFileSync(path.endsWith('/900/zip') ? process.env.FAKE_ARTIFACT_ZIP : process.env.FAKE_RECEIPT_ZIP));\n`,
  );
  chmodSync(join(binaries, "gh"), 0o755);
  vi.stubEnv("PATH", `${binaries}:${process.env.PATH}`);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.origin).toBe("https://api.github.com");
      const path = `${url.pathname.replace(`/repos/${repository}/`, "")}${url.search}`;
      const method = options?.method ?? "GET";
      requests.push({
        path,
        method,
        ...(typeof options?.body === "string" ? { body: JSON.parse(options.body) } : {}),
      });
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer fixture-github-token",
      );
      if (method !== "GET") throw new Error("Unexpected GitHub mutation in fixture");
      return new Response(routes.has(path) ? json(routes.get(path)) : "{}", {
        status: routes.has(path) ? 200 : 404,
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe("protected workflow and source identities", () => {
  it("checks distinct workflow and source commits through protected main without git credentials", async () => {
    await expect(validateSource(release)).resolves.toBeUndefined();
    expect(
      requests.some((request) => request.path.includes(`compare/${preparation.workflowCommit}`)),
    ).toBe(true);
    expect(requests.some((request) => request.path.endsWith(`?ref=${source}`))).toBe(true);
  });

  it("rejects a coordinator for another source before accepting its manifest", () => {
    expect(() =>
      manifest({
        ...release,
        sourceCommit: publisher.workflowCommit,
        catalog: { ...catalog, releaseGroupId: publisher.workflowCommit },
      }),
    ).toThrow("Coordinator");
  });

  it("requires schema 2 catalog identity bound to the source commit", () => {
    expect(() => manifest({ ...release, schema: 1 })).toThrow("Unsupported release manifest");
    const { catalog: _omitted, ...withoutCatalog } = release;
    expect(() => manifest(withoutCatalog)).toThrow("Missing catalog");
    expect(() =>
      manifest({
        ...release,
        catalog: { ...catalog, releaseGroupId: publisher.workflowCommit },
      }),
    ).toThrow("Catalog does not bind the source commit");
  });

  it.each(["head_sha", "head_branch", "path", "event", "id", "run_attempt"])(
    "rejects mismatched run field %s",
    (key) => {
      expect(() =>
        validateRun(
          { ...workflowRun(publisher, "release.yml", "workflow_dispatch"), [key]: "wrong" },
          publisher,
          "release.yml",
          "workflow_dispatch",
        ),
      ).toThrow("identity mismatch");
    },
  );

  it.each([
    [
      "branches/main",
      { protected: false, commit: { sha: publisher.workflowCommit } },
      "protected main",
    ],
    [
      `git/ref/tags/${tag}`,
      { object: { type: "commit", sha: preparation.workflowCommit } },
      "tag changed",
    ],
    [
      `compare/${source}...${publisher.workflowCommit}`,
      { status: "diverged", base_commit: { sha: source }, merge_base_commit: { sha: source } },
      "ancestor",
    ],
  ])("rejects source boundary drift at %s", async (path, value, message) => {
    routes.set(String(path), value);
    await expect(validateSource(release)).rejects.toThrow(String(message));
  });

  it("peels annotated release tags", async () => {
    routes.set(`git/ref/tags/${tag}`, { object: { type: "tag", sha: "f".repeat(40) } });
    routes.set(`git/tags/${"f".repeat(40)}`, { object: { type: "commit", sha: source } });
    await expect(validateSource(release)).resolves.toBeUndefined();
  });

  it("waits for the exact dispatching coordinator job to finish", async () => {
    vi.useFakeTimers();
    const path = "actions/runs/123/attempts/1/jobs?per_page=100&page=1";
    routes.set(path, {
      jobs: [{ name: "package-coordinator", status: "in_progress", conclusion: null }],
    });
    const pending = validateInvocation(
      coordinator,
      "version-pr.yml",
      "push",
      "package-coordinator",
    );
    await vi.advanceTimersByTimeAsync(1);
    routes.set(path, {
      jobs: [{ name: "package-coordinator", status: "completed", conclusion: "success" }],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
    expect(requests.filter((request) => request.path === path)).toHaveLength(2);
  });

  it("stops waiting after a bounded coordinator timeout", async () => {
    vi.useFakeTimers();
    routes.set("actions/runs/123/attempts/1/jobs?per_page=100&page=1", { jobs: [] });
    const pending = expect(
      validateInvocation(coordinator, "version-pr.yml", "push", "package-coordinator"),
    ).rejects.toThrow("has not succeeded");
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(requests.filter((request) => request.path.includes("/jobs?"))).toHaveLength(12);
  });
});

describe("policy and sealed artifact gates", () => {
  it("accepts GitHub revision timestamps with offsets and fractional seconds", async () => {
    const revision = "1998-08-06T14:37:10.649+05:00";
    routes.set("rulesets/1", tagPolicy({ updated_at: revision }));
    vi.stubEnv("RESERVATION_RULESET_UPDATED_AT", revision);
    await expect(validatePolicies()).resolves.toBeUndefined();
    await expect(verifyPolicy()).resolves.toEqual({
      RESERVATION_RULESET_ID: "1",
      RESERVATION_RULESET_UPDATED_AT: revision,
    });
    vi.stubEnv("RESERVATION_RULESET_UPDATED_AT", "1998-08-06T09:37:10.649Z");
    await expect(validatePolicies()).rejects.toThrow("ruleset changed");
    vi.stubEnv("RESERVATION_RULESET_UPDATED_AT", "1998-08-06T14:37:10.650+05:00");
    await expect(validatePolicies()).rejects.toThrow("ruleset changed");
  });

  it("accepts active main-only environments and immutable reservation tags", async () => {
    await expect(validatePolicies()).resolves.toBeUndefined();
  });

  it("rejects stored main patterns when custom restrictions are disabled", async () => {
    routes.set("environments/npm-production", {
      can_admins_bypass: false,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    });
    await expect(validatePolicies()).rejects.toThrow("permit only main");
  });

  it("rejects tag protection with an administrator bypass", async () => {
    routes.set("rulesets/1", tagPolicy({ bypass_actors: [{ actor_id: 1 }] }));
    await expect(validatePolicies()).rejects.toThrow("without bypass");
  });

  it("accepts hidden bypass data only against the administrator-verified revision", async () => {
    routes.set("rulesets/1", tagPolicy({ bypass_actors: undefined }));
    await expect(validatePolicies()).resolves.toBeUndefined();
    routes.set(
      "rulesets/1",
      tagPolicy({ bypass_actors: undefined, updated_at: "1998-08-07T00:00:01Z" }),
    );
    await expect(validatePolicies()).rejects.toThrow("ruleset changed");
  });

  it.each(["RESERVATION_RULESET_ID", "RESERVATION_RULESET_UPDATED_AT"])(
    "requires setup pin %s",
    async (name) => {
      vi.stubEnv(name, "");
      await expect(validatePolicies()).rejects.toThrow(`Missing ${name}`);
    },
  );

  it("outputs policy setup evidence only when the administrator can see every bypass", async () => {
    await expect(verifyPolicy()).resolves.toEqual({
      RESERVATION_RULESET_ID: "1",
      RESERVATION_RULESET_UPDATED_AT: policyRevision,
    });
    routes.set("rulesets/1", tagPolicy({ bypass_actors: undefined }));
    await expect(verifyPolicy()).rejects.toThrow("visible empty ruleset bypass list");
  });

  it("rejects artifact replacement, expiration, and wrong attempt names", async () => {
    for (const change of [
      { expired: true },
      { digest: `sha256:${"f".repeat(64)}` },
      { name: "npm-release-456-3-cycling-coach" },
    ]) {
      routes.set("actions/artifacts/900", {
        id: 900,
        expired: false,
        name: "npm-release-456-2-cycling-coach",
        digest: `sha256:${reservation.artifactDigest}`,
        workflow_run: { id: 456, head_sha: preparation.workflowCommit },
        ...change,
      });
      await expect(validateArtifact(reservation)).rejects.toThrow("unavailable or mismatched");
    }
  });

  it("restores actual sealed ZIP bytes and exports source identity", async () => {
    const destination = join(directory, "restored");
    await runNpmRelease("restore", destination);
    expect(readFileSync(join(destination, release.archives[0].filename))).toEqual(
      readFileSync(join(directory, release.archives[0].filename)),
    );
    const outputs = readFileSync(join(directory, "output"), "utf8");
    expect(outputs).toContain(`commit=${source}\n`);
    expect(outputs).toContain(`ref=${tag}\n`);
    expect(outputs).toContain("preparation_run_attempt=2\n");
  });

  it("rejects modified archive bytes and symlinked archives", () => {
    const path = join(directory, release.archives[0].filename);
    writeFileSync(path, "modified");
    expect(() => verifyArchives(release, directory)).toThrow("changed");
    rmSync(path);
    symlinkSync(join(directory, release.archives[1].filename), path);
    expect(() => verifyArchives(release, directory)).toThrow("regular file");
  });

  it("rejects unexpected ZIP entries before extracting them", async () => {
    writeFileSync(join(directory, "unexpected"), "extra");
    const path = zip("extra.zip", directory, [
      "release-manifest.json",
      ...release.archives.map((archive) => archive.filename),
      "unexpected",
    ]);
    reservation.artifactDigest = sha(readFileSync(path));
    routes.set(`git/tags/${reservationSha}`, {
      tag: `npm-stage/${tag}`,
      object: { type: "commit", sha: source },
      message: json(reservation),
    });
    routes.set("actions/artifacts/900", {
      expired: false,
      name: "npm-release-456-2-cycling-coach",
      digest: `sha256:${reservation.artifactDigest}`,
      workflow_run: { id: 456, head_sha: preparation.workflowCommit },
    });
    vi.stubEnv("FAKE_ARTIFACT_ZIP", path);
    await expect(restore(tag, join(directory, "restore-extra"))).rejects.toThrow(
      "Unexpected artifact entries",
    );
  });

  it("rejects a reservation whose catalog digest differs from the prepared manifest", async () => {
    routes.set(`git/tags/${reservationSha}`, {
      tag: `npm-stage/${tag}`,
      object: { type: "commit", sha: source },
      message: json({
        ...reservation,
        manifest: {
          ...release,
          catalog: { ...catalog, digest: "1".repeat(64) },
        },
      }),
    });
    await expect(restore(tag, join(directory, "restore-catalog"))).rejects.toThrow(
      "Reservation does not match prepared manifest",
    );
  });

  it("synthesizes a dummy catalog when validating input and ignores RELEASE_CATALOG", async () => {
    vi.stubEnv("RELEASE_COMMIT", source);
    vi.stubEnv("COORDINATOR_RUN_ID", coordinator.runId);
    vi.stubEnv("COORDINATOR_RUN_ATTEMPT", coordinator.attempt);
    vi.stubEnv("RELEASE_CATALOG", "not-json");
    vi.stubEnv("GITHUB_SHA", preparation.workflowCommit);
    await runNpmRelease("validate-input", directory);
    expect(readFileSync(join(directory, "output"), "utf8")).toContain(`commit=${source}\n`);
  });

  it("requires RELEASE_CATALOG when sealing archives", async () => {
    vi.stubEnv("RELEASE_VERSION", version);
    vi.stubEnv("RELEASE_COMMIT", source);
    vi.stubEnv("COORDINATOR_RUN_ID", coordinator.runId);
    vi.stubEnv("COORDINATOR_RUN_ATTEMPT", coordinator.attempt);
    await expect(runNpmRelease("seal", directory)).rejects.toThrow("Missing RELEASE_CATALOG");
  });
});

describe("latest promotion", () => {
  it("checks both package versions before changing either latest tag", () => {
    const read = vi.fn((name: string) => (name === "cycling-coach" ? "1998.8.6" : "1998.8.8"));
    const write = vi.fn();
    expect(() => promoteLatest(version, read, write)).toThrow("newer npm latest");
    expect(read.mock.calls).toEqual([["cycling-coach"], ["enduragent"]]);
    expect(write).not.toHaveBeenCalled();
  });

  it("treats the project same-day -N release as newer than its base date", () => {
    const latest: Record<string, string> = { "cycling-coach": version, enduragent: version };
    const writes: string[] = [];
    promoteLatest(
      `${version}-1`,
      (name) => latest[name],
      (name, next) => {
        writes.push(name);
        latest[name] = next;
      },
    );
    expect(writes).toEqual(["cycling-coach", "enduragent"]);
    expect(() =>
      promoteLatest(
        version,
        (name) => latest[name],
        () => {
          throw new Error("Must not write");
        },
      ),
    ).toThrow("newer npm latest");
  });

  it("rechecks before each mutation and refuses a concurrent newer version", () => {
    const latest: Record<string, string> = { "cycling-coach": "1998.8.6", enduragent: "1998.8.6" };
    const writes: string[] = [];
    expect(() =>
      promoteLatest(
        version,
        (name) => latest[name],
        (name, next) => {
          writes.push(name);
          latest[name] = next;
          latest.enduragent = "1998.8.8";
        },
      ),
    ).toThrow("newer npm latest");
    expect(writes).toEqual(["cycling-coach"]);
    expect(latest.enduragent).toBe("1998.8.8");
  });

  it("requires reconciliation when a mutation has an uncertain result", () => {
    const write = vi.fn(() => {
      throw new Error("Response lost");
    });
    expect(() => promoteLatest(version, () => "1998.8.6", write)).toThrow(
      "promotion is incomplete",
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("leaves already promoted versions unchanged", () => {
    const write = vi.fn();
    promoteLatest(version, () => version, write);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("staged publication and retry evidence", () => {
  function response() {
    const archive = release.archives[0];
    return {
      "cycling-coach": {
        name: archive.name,
        version,
        size: archive.size,
        integrity: `sha512-${Buffer.from(archive.sha512, "hex").toString("base64")}`,
        stageId,
      },
    };
  }

  it("parses the package-keyed JSON emitted by npm 11.19.1", () => {
    expect(stageResponse(response(), release.archives[0], version)).toBe(stageId);
    expect(() => stageResponse(response()["cycling-coach"], release.archives[0], version)).toThrow(
      "exactly the expected package",
    );
    expect(() => stageResponse({ ...response(), error: {} }, release.archives[0], version)).toThrow(
      "exactly the expected package",
    );
    expect(() =>
      stageResponse(
        { "cycling-coach": { ...response()["cycling-coach"], size: 1 } },
        release.archives[0],
        version,
      ),
    ).toThrow("archive mismatch");
  });

  it("restores a verified accepted receipt and refuses to restage", async () => {
    installReceipt();
    await runNpmRelease("begin", join(directory, "resume"));
    expect(readFileSync(join(directory, "output"), "utf8")).toContain("stage=false\n");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it.each(["missing", "unknown"])("does not restage an existing %s outcome", async (status) => {
    if (status === "missing") installAttempt();
    else installReceipt(status);
    await expect(runNpmRelease("begin", join(directory, `resume-${status}`))).rejects.toThrow(
      status === "missing" ? "Missing stage receipt" : "Unknown or mismatched stage outcome",
    );
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("does not trust a receipt from a different publisher commit", async () => {
    const attempt = installReceipt();
    await expect(
      acceptedReceipt(reservation, {
        ...attempt,
        publisher: { ...publisher, workflowCommit: source },
      }),
    ).rejects.toThrow("identity mismatch");
  });

  it.each(["accepted", "interrupted"])(
    "records %s publication without a second request",
    async (result) => {
      installAttempt();
      const script = join(directory, "publisher.mjs");
      const calls = join(directory, "publisher-calls");
      writeFileSync(
        script,
        `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, 'called\\n');\n${result === "accepted" ? `process.stdout.write(${JSON.stringify(json(response()))});` : "process.exitCode = 1;"}\n`,
      );
      vi.stubEnv("PUBLISHER_NODE", process.execPath);
      vi.stubEnv("PUBLISHER_NPM", script);
      vi.stubEnv("RECEIPT_PATH", join(directory, "stage-receipt.json"));
      if (result === "accepted") await runNpmRelease("stage", directory);
      else await expect(runNpmRelease("stage", directory)).rejects.toThrow();
      expect(JSON.parse(readFileSync(join(directory, "stage-receipt.json"), "utf8")).status).toBe(
        result === "accepted" ? "accepted" : "unknown",
      );
      await expect(runNpmRelease("stage", directory)).rejects.toThrow("EEXIST");
      expect(readFileSync(calls, "utf8")).toBe("called\n");
    },
  );
});
