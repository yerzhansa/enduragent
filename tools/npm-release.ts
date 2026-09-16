import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "yerzhansa/enduragent";
const packages = ["cycling-coach", "enduragent"] as const;
type PackageName = (typeof packages)[number];
type Invocation = { runId: string; attempt: string; workflowCommit: string };
type Archive = { name: PackageName; filename: string; size: number; sha512: string };
type Manifest = {
  schema: 2;
  tag: string;
  version: string;
  sourceCommit: string;
  catalog: { releaseGroupId: string; revision: number; digest: string };
  coordinator: Invocation;
  preparation: Invocation;
  archives: Archive[];
};
type Reservation = { manifest: Manifest; artifactId: string; artifactDigest: string };
type Attempt = { reservation: string; name: PackageName; publisher: Invocation };

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error("Invalid release identity");
  return value;
}

const identifier = (value: unknown) => text(String(value), /^[1-9]\d*$/u);
const commit = (value: unknown) => text(value, /^[0-9a-f]{40}$/u);
const digest = (value: unknown) => text(value, /^[0-9a-f]{64}$/u);
const hash = (value: string | Buffer, algorithm = "sha256") =>
  createHash(algorithm).update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const parse = (value: string): unknown => JSON.parse(value);
const environment = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const output = (name: string, value: string) => {
  if (/[\r\n]/u.test(value)) throw new Error("Invalid workflow output");
  appendFileSync(environment("GITHUB_OUTPUT"), `${name}=${value}\n`);
};
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();

export function invocation(value: unknown): Invocation {
  const item = record(value);
  return {
    runId: identifier(item.runId),
    attempt: identifier(item.attempt),
    workflowCommit: commit(item.workflowCommit),
  };
}

function catalog(value: unknown, sourceCommit: string): Manifest["catalog"] {
  const item = record(value);
  const names = Object.keys(item).sort();
  if (names.length !== 3 || names[0] !== "digest" || names[1] !== "releaseGroupId" || names[2] !== "revision")
    throw new Error("Invalid catalog identity");
  const releaseGroupId = commit(item.releaseGroupId);
  if (releaseGroupId !== sourceCommit) throw new Error("Catalog does not bind the source commit");
  if (
    typeof item.revision !== "number" ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 1
  )
    throw new Error("Invalid catalog identity");
  return {
    releaseGroupId,
    revision: item.revision,
    digest: digest(item.digest),
  };
}

export function manifest(value: unknown): Manifest {
  const item = record(value);
  if (item.schema !== 2) throw new Error("Unsupported release manifest");
  const version = text(
    item.version,
    /^[1-9]\d{3}\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])(?:-[1-9]\d*)?$/u,
  );
  if (item.tag !== `cycling-coach@${version}`) throw new Error("Release tag mismatch");
  if (!Array.isArray(item.archives) || item.archives.length !== 2)
    throw new Error("Both release archives are required");
  const rawArchives = item.archives;
  const archives = packages.map((name) => {
    const matches = rawArchives.filter((raw: unknown) => record(raw).name === name);
    if (matches.length !== 1) throw new Error("Duplicate or missing package");
    const archive = record(matches[0]);
    if (
      archive.filename !== `${name}-${version}.tgz` ||
      typeof archive.size !== "number" ||
      !Number.isSafeInteger(archive.size) ||
      archive.size <= 0
    )
      throw new Error("Invalid archive identity");
    return {
      name,
      filename: archive.filename,
      size: archive.size,
      sha512: text(archive.sha512, /^[0-9a-f]{128}$/u),
    };
  });
  const sourceCommit = commit(item.sourceCommit);
  if (!("catalog" in item)) throw new Error("Missing catalog");
  const boundCatalog = catalog(item.catalog, sourceCommit);
  const coordinator = invocation(item.coordinator);
  if (coordinator.workflowCommit !== sourceCommit)
    throw new Error("Coordinator does not bind the source commit");
  return {
    schema: 2,
    tag: item.tag,
    version,
    sourceCommit,
    catalog: boundCatalog,
    coordinator,
    preparation: invocation(item.preparation),
    archives,
  };
}

function current(): Invocation {
  if (
    environment("GITHUB_REPOSITORY") !== repository ||
    environment("GITHUB_REF") !== "refs/heads/main" ||
    environment("GITHUB_EVENT_NAME") !== "workflow_dispatch"
  )
    throw new Error("Release execution requires protected main dispatch");
  return invocation({
    runId: environment("GITHUB_RUN_ID"),
    attempt: environment("GITHUB_RUN_ATTEMPT"),
    workflowCommit: environment("GITHUB_SHA"),
  });
}

async function github(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${environment("GH_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`GitHub request failed with ${response.status}`);
  return response.json() as Promise<unknown>;
}

export function validateRun(value: unknown, expected: Invocation, workflow: string, event: string) {
  const item = record(value);
  if (
    String(item.id) !== expected.runId ||
    String(item.run_attempt) !== expected.attempt ||
    item.head_sha !== expected.workflowCommit ||
    item.head_branch !== "main" ||
    item.path !== `.github/workflows/${workflow}` ||
    item.event !== event ||
    record(item.repository).full_name !== repository ||
    record(item.head_repository).full_name !== repository
  )
    throw new Error("Workflow run identity mismatch");
}

export async function validateInvocation(
  expected: Invocation,
  workflow: string,
  event: string,
  job?: string,
) {
  const path = `actions/runs/${expected.runId}/attempts/${expected.attempt}`;
  validateRun(await github(path), expected, workflow, event);
  if (!job) return;
  const polls = job === "package-coordinator" ? 12 : 1;
  for (let poll = 0; poll < polls; poll += 1) {
    const matches: Record<string, unknown>[] = [];
    for (let page = 1; ; page += 1) {
      const response = record(await github(`${path}/jobs?per_page=100&page=${page}`));
      if (!Array.isArray(response.jobs)) throw new Error("Missing workflow jobs");
      matches.push(...response.jobs.map(record).filter((entry) => entry.name === job));
      if (response.jobs.length < 100) break;
    }
    if (
      matches.length === 1 &&
      matches[0]?.status === "completed" &&
      matches[0].conclusion === "success"
    )
      return;
    if (
      matches.length > 1 ||
      matches.some((entry) => entry.status === "completed") ||
      poll === polls - 1
    )
      throw new Error(`Required job ${job} has not succeeded`);
    await new Promise<void>((done) => setTimeout(done, 5_000));
  }
}

async function validateEnvironments() {
  for (const name of ["npm-production", "npm-stage"]) {
    const environment = record(await github(`environments/${name}`));
    const policies = record(await github(`environments/${name}/deployment-branch-policies`));
    const mode = record(environment.deployment_branch_policy);
    if (
      environment.can_admins_bypass !== false ||
      mode.custom_branch_policies !== true ||
      mode.protected_branches !== false ||
      !Array.isArray(policies.branch_policies) ||
      policies.branch_policies.length !== 1 ||
      record(policies.branch_policies[0]).name !== "main" ||
      record(policies.branch_policies[0]).type !== "branch"
    )
      throw new Error(`Environment ${name} must permit only main and prevent administrator bypass`);
  }
}

async function reservationPolicy() {
  const id = identifier(environment("RESERVATION_RULESET_ID"));
  const ruleset = record(await github(`rulesets/${id}`));
  const refs = record(record(ruleset.conditions).ref_name);
  if (
    identifier(ruleset.id) !== id ||
    ruleset.target !== "tag" ||
    ruleset.enforcement !== "active" ||
    !Array.isArray(refs.include) ||
    !refs.include.includes("refs/tags/npm-stage/**") ||
    !refs.include.includes("refs/tags/npm-stage-attempt/**") ||
    !Array.isArray(refs.exclude) ||
    refs.exclude.length !== 0 ||
    !Array.isArray(ruleset.rules)
  )
    throw new Error("Reservation ruleset must protect both namespaces without exclusions");
  const types = ruleset.rules.map((entry) => record(entry).type);
  if (!types.includes("update") || !types.includes("deletion"))
    throw new Error("Reservation ruleset must prevent updates and deletion");
  return {
    id,
    ruleset,
    updatedAt: text(
      ruleset.updated_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u,
    ),
  };
}

export async function verifyPolicy() {
  await validateEnvironments();
  const policy = await reservationPolicy();
  if (!Array.isArray(policy.ruleset.bypass_actors) || policy.ruleset.bypass_actors.length !== 0)
    throw new Error("Administrator verification requires a visible empty ruleset bypass list");
  return { RESERVATION_RULESET_ID: policy.id, RESERVATION_RULESET_UPDATED_AT: policy.updatedAt };
}

export async function validatePolicies() {
  const pinnedRevision = environment("RESERVATION_RULESET_UPDATED_AT");
  await validateEnvironments();
  const policy = await reservationPolicy();
  if (policy.updatedAt !== pinnedRevision)
    throw new Error("Reservation ruleset changed; administrator verification is required");
  if (
    Object.hasOwn(policy.ruleset, "bypass_actors") &&
    (!Array.isArray(policy.ruleset.bypass_actors) || policy.ruleset.bypass_actors.length !== 0)
  )
    throw new Error("Reservation ruleset must remain without bypass");
}

export async function validateSource(value: Manifest) {
  await validateInvocation(value.coordinator, "version-pr.yml", "push", "package-coordinator");
  if (value.coordinator.workflowCommit !== value.sourceCommit)
    throw new Error("Coordinator does not bind the source commit");
  const main = record(await github("branches/main"));
  if (main.protected !== true) throw new Error("Release source requires protected main");
  const mainCommit = commit(record(main.commit).sha);
  const reference = record(await github(`git/ref/tags/${value.tag}`));
  let target = record(reference.object);
  for (let depth = 0; target.type === "tag" && depth < 8; depth += 1)
    target = record(record(await github(`git/tags/${commit(target.sha)}`)).object);
  if (target.type !== "commit" || target.sha !== value.sourceCommit)
    throw new Error("Release tag changed");
  for (const ancestor of new Set([value.sourceCommit, value.preparation.workflowCommit])) {
    const comparison = record(await github(`compare/${ancestor}...${mainCommit}`));
    if (
      (comparison.status !== "ahead" && comparison.status !== "identical") ||
      record(comparison.base_commit).sha !== ancestor ||
      record(comparison.merge_base_commit).sha !== ancestor
    )
      throw new Error("Release commit is not an ancestor of protected main");
  }
  const contents = record(
    await github(`contents/packages/cycling-coach/package.json?ref=${value.sourceCommit}`),
  );
  if (
    contents.type !== "file" ||
    contents.encoding !== "base64" ||
    typeof contents.content !== "string"
  )
    throw new Error("Source package manifest is unavailable");
  const source = record(parse(Buffer.from(contents.content, "base64").toString("utf8")));
  if (
    source.name !== "cycling-coach" ||
    source.version !== value.version ||
    source.private === true
  )
    throw new Error("Source package identity mismatch");
}

export function verifyArchives(value: Manifest, directory: string) {
  for (const archive of value.archives) {
    const path = join(directory, archive.filename);
    if (!lstatSync(path).isFile()) throw new Error("Sealed archive must be a regular file");
    const bytes = readFileSync(path);
    if (bytes.length !== archive.size || hash(bytes, "sha512") !== archive.sha512)
      throw new Error("Sealed archive changed");
    const packed = record(parse(run("tar", ["-xOf", path, "package/package.json"])));
    const source = record(packed.repository);
    if (
      packed.name !== archive.name ||
      packed.version !== value.version ||
      packed.publishConfig != null ||
      source.type !== "git" ||
      source.url !== `git+https://github.com/${repository}.git` ||
      source.directory !== "packages/cycling-coach"
    )
      throw new Error("Packed package identity mismatch");
  }
}

async function readTag(name: string) {
  const ref = await github(`git/ref/tags/${name}`);
  if (ref === null) return null;
  const object = record(record(ref).object);
  if (object.type !== "tag") throw new Error("Reservation must be an annotated tag");
  const tag = record(await github(`git/tags/${commit(object.sha)}`));
  if (tag.tag !== name || typeof tag.message !== "string")
    throw new Error("Invalid reservation tag");
  return { sha: commit(object.sha), object: record(tag.object), value: parse(tag.message) };
}

async function createTag(name: string, source: string, value: unknown) {
  const tag = record(
    await github("git/tags", { tag: name, message: json(value), object: source, type: "commit" }),
  );
  await github("git/refs", { ref: `refs/tags/${name}`, sha: commit(tag.sha) });
  return commit(tag.sha);
}

function reservation(value: unknown): Reservation {
  const item = record(value);
  return {
    manifest: manifest(item.manifest),
    artifactId: identifier(item.artifactId),
    artifactDigest: digest(item.artifactDigest),
  };
}

export async function validateArtifact(value: Reservation) {
  const artifact = record(await github(`actions/artifacts/${value.artifactId}`));
  if (
    artifact.expired !== false ||
    artifact.name !==
      `npm-release-${value.manifest.preparation.runId}-${value.manifest.preparation.attempt}-cycling-coach` ||
    artifact.digest !== `sha256:${value.artifactDigest}` ||
    String(record(artifact.workflow_run).id) !== value.manifest.preparation.runId ||
    record(artifact.workflow_run).head_sha !== value.manifest.preparation.workflowCommit
  )
    throw new Error("Prepared artifact unavailable or mismatched; operator disposition required");
}

export async function restore(tag: string, directory: string) {
  text(tag, /^cycling-coach@[1-9]\d{3}\.\d{1,2}\.\d{1,2}(?:-[1-9]\d*)?$/u);
  const stored = await readTag(`npm-stage/${tag}`);
  if (!stored) throw new Error("No prepared reservation exists");
  const value = reservation(stored.value);
  if (
    value.manifest.tag !== tag ||
    stored.object.type !== "commit" ||
    stored.object.sha !== value.manifest.sourceCommit
  )
    throw new Error("Reservation source mismatch");
  await validateSource(value.manifest);
  await validateInvocation(value.manifest.preparation, "release.yml", "workflow_dispatch", "smoke");
  await validateArtifact(value);
  mkdirSync(directory, { recursive: true });
  const archive = join(directory, "artifact.zip");
  writeFileSync(
    archive,
    execFileSync("gh", ["api", `repos/${repository}/actions/artifacts/${value.artifactId}/zip`], {
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  if (hash(readFileSync(archive)) !== value.artifactDigest)
    throw new Error("Artifact ZIP digest mismatch");
  const expected = [
    "release-manifest.json",
    ...value.manifest.archives.map((entry) => entry.filename),
  ].sort();
  const observed = run("unzip", ["-Z1", archive]).split("\n").sort();
  if (json(expected) !== json(observed)) throw new Error("Unexpected artifact entries");
  run("unzip", ["-o", archive, "-d", directory]);
  if (
    json(manifest(parse(readFileSync(join(directory, "release-manifest.json"), "utf8")))) !==
    json(value.manifest)
  )
    throw new Error("Reservation does not match prepared manifest");
  verifyArchives(value.manifest, directory);
  return { ...value, sha: stored.sha };
}

function packageName(value: unknown): PackageName {
  if (value !== "cycling-coach" && value !== "enduragent")
    throw new Error("Unsupported npm package");
  return value;
}

async function readAttempt(value: Reservation & { sha: string }, name: PackageName) {
  const stored = await readTag(`npm-stage-attempt/${value.manifest.tag}/${name}`);
  if (!stored) return null;
  const raw = record(stored.value);
  const attempt: Attempt = {
    reservation: commit(raw.reservation),
    name: packageName(raw.name),
    publisher: invocation(raw.publisher),
  };
  if (
    attempt.reservation !== value.sha ||
    attempt.name !== name ||
    stored.object.type !== "commit" ||
    stored.object.sha !== attempt.publisher.workflowCommit
  )
    throw new Error("Publisher attempt mismatch");
  await validateInvocation(attempt.publisher, "release.yml", "workflow_dispatch");
  return attempt;
}

function receiptName(value: Manifest, attempt: Attempt) {
  return `npm-stage-receipt-${value.preparation.runId}-${value.preparation.attempt}-${attempt.name}-${attempt.publisher.runId}-${attempt.publisher.attempt}`;
}

export async function acceptedReceipt(value: Reservation & { sha: string }, attempt: Attempt) {
  const name = receiptName(value.manifest, attempt);
  const response = record(
    (await github(`actions/runs/${attempt.publisher.runId}/artifacts?name=${name}&per_page=100`)) ??
      {},
  );
  if (!Array.isArray(response.artifacts) || response.artifacts.length !== 1)
    throw new Error("Missing stage receipt; reconcile with npm using maintainer authentication");
  const artifact = record(response.artifacts[0]);
  if (
    artifact.name !== name ||
    artifact.expired !== false ||
    String(record(artifact.workflow_run).id) !== attempt.publisher.runId ||
    record(artifact.workflow_run).head_sha !== attempt.publisher.workflowCommit
  )
    throw new Error("Stage receipt artifact identity mismatch");
  const bytes = execFileSync(
    "gh",
    ["api", `repos/${repository}/actions/artifacts/${identifier(artifact.id)}/zip`],
    {
      maxBuffer: 1024 * 1024,
    },
  );
  if (artifact.digest !== `sha256:${hash(bytes)}`)
    throw new Error("Stage receipt artifact changed");
  const path = join(environment("RUNNER_TEMP"), `${name}.zip`);
  writeFileSync(path, bytes);
  if (run("unzip", ["-Z1", path]) !== "receipt.json")
    throw new Error("Unexpected stage receipt content");
  const receipt = record(parse(run("unzip", ["-p", path, "receipt.json"])));
  if (
    receipt.status !== "accepted" ||
    receipt.reservation !== value.sha ||
    receipt.name !== attempt.name ||
    json(invocation(receipt.publisher)) !== json(attempt.publisher) ||
    receipt.manifestSha256 !== hash(json(value.manifest))
  )
    throw new Error("Unknown or mismatched stage outcome; do not restage automatically");
  return text(receipt.stageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
}

async function verifyPublic(
  value: Reservation & { sha: string },
  directory: string,
  names: readonly PackageName[] = packages,
) {
  for (const archive of value.manifest.archives.filter((item) => names.includes(item.name))) {
    const attempt = await readAttempt(value, archive.name);
    if (!attempt) throw new Error("No publisher attempt exists for the package");
    const spec = `${archive.name}@${value.manifest.version}`;
    const metadata = record(
      parse(run("npm", ["view", spec, "--json", "--registry=https://registry.npmjs.org/"])),
    );
    const dist = record(metadata.dist);
    const integrity = `sha512-${Buffer.from(archive.sha512, "hex").toString("base64")}`;
    const tarballUrl = `https://registry.npmjs.org/${archive.name}/-/${archive.filename}`;
    const attestationUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${spec}`;
    if (
      metadata.name !== archive.name ||
      metadata.version !== value.manifest.version ||
      dist.integrity !== integrity ||
      dist.tarball !== tarballUrl ||
      record(dist.attestations).url !== attestationUrl
    )
      throw new Error("Public npm metadata mismatch");
    const response = await fetch(tarballUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Public npm archive is unavailable");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== archive.size || hash(bytes, "sha512") !== archive.sha512)
      throw new Error("Public npm archive does not match the approved release");
    const attestationResponse = await fetch(attestationUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!attestationResponse.ok) throw new Error("Public npm provenance is unavailable");
    const attestationPath = join(directory, `${archive.name}-attestations.json`);
    writeFileSync(attestationPath, await attestationResponse.text());
    run("pnpm", [
      "desktop-release:transaction",
      "verify-npm-provenance",
      "--metadata",
      attestationPath,
      "--name",
      archive.name,
      "--version",
      value.manifest.version,
      "--integrity",
      integrity,
      "--repository",
      `https://github.com/${repository}`,
      "--workflow",
      ".github/workflows/release.yml",
      "--ref",
      "refs/heads/main",
      "--workflow-commit",
      attempt.publisher.workflowCommit,
      "--invocation-id",
      `https://github.com/${repository}/actions/runs/${attempt.publisher.runId}/attempts/${attempt.publisher.attempt}`,
      "--allow-prior-invocation",
      "false",
      "--release-tag",
      value.manifest.tag,
      "--event-name",
      "workflow_dispatch",
      "--repository-id",
      environment("REPOSITORY_ID"),
      "--repository-owner-id",
      environment("REPOSITORY_OWNER_ID"),
    ]);
  }
}

export function stageResponse(value: unknown, archive: Archive, version: string): string {
  const document = record(value);
  if (Object.keys(document).length !== 1 || !Object.hasOwn(document, archive.name))
    throw new Error("npm stage response must contain exactly the expected package");
  const result = record(document[archive.name]);
  if (
    result.name !== archive.name ||
    result.version !== version ||
    result.size !== archive.size ||
    result.integrity !== `sha512-${Buffer.from(archive.sha512, "hex").toString("base64")}`
  )
    throw new Error("npm stage response archive mismatch");
  return text(result.stageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
}

function assertLatestIsNotNewer(latest: string, version: string) {
  const order = (value: string) => {
    text(value, /^[1-9]\d{3}\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])(?:-[1-9]\d*)?$/u);
    const [year, month, day, sequence = 0] = value.split(/[.-]/u).map(Number);
    return [year, month, day, sequence];
  };
  const observed = order(latest);
  const proposed = order(version);
  for (let index = 0; index < proposed.length; index += 1) {
    if (observed[index] > proposed[index])
      throw new Error("Refusing to replace a newer npm latest version");
    if (observed[index] < proposed[index]) return;
  }
}

export function promoteLatest(
  version: string,
  readLatest: (name: PackageName) => string,
  writeLatest: (name: PackageName, version: string) => void,
) {
  const observed = packages.map((name) => ({ name, version: readLatest(name) }));
  for (const entry of observed) assertLatestIsNotNewer(entry.version, version);
  for (const name of packages) {
    const latest = readLatest(name);
    assertLatestIsNotNewer(latest, version);
    if (latest === version) continue;
    try {
      writeLatest(name, version);
      if (readLatest(name) !== version) throw new Error("Latest did not converge");
    } catch (cause) {
      throw new Error("Latest promotion is incomplete; reconcile both packages before retrying", {
        cause,
      });
    }
  }
}

export async function runNpmRelease(command: string, directory: string) {
  const operatorCommand =
    command === "reconcile" || command === "promote-latest" || command === "verify-policy";
  const caller = operatorCommand ? null : current();
  if (command === "verify-policy") {
    process.stdout.write(json(await verifyPolicy()));
    return;
  }
  if (command === "validate-input") {
    if (!caller) throw new Error("Missing workflow identity");
    const version = environment("RELEASE_TAG").replace(/^cycling-coach@/u, "");
    const sourceCommit = environment("RELEASE_COMMIT");
    const value = manifest({
      schema: 2,
      tag: environment("RELEASE_TAG"),
      version,
      sourceCommit,
      catalog: {
        releaseGroupId: sourceCommit,
        revision: 1,
        digest: "0".repeat(64),
      },
      preparation: caller,
      coordinator: {
        runId: environment("COORDINATOR_RUN_ID"),
        attempt: environment("COORDINATOR_RUN_ATTEMPT"),
        workflowCommit: environment("RELEASE_COMMIT"),
      },
      archives: packages.map((name) => ({
        name,
        filename: `${name}-${version}.tgz`,
        size: 1,
        sha512: "0".repeat(128),
      })),
    });
    await validateSource(value);
    output("package", "cycling-coach");
    output("version", value.version);
    output("ref", value.tag);
    output("commit", value.sourceCommit);
    return;
  }
  if (command === "seal") {
    const version = environment("RELEASE_VERSION");
    const sourceCommit = environment("RELEASE_COMMIT");
    const value = manifest({
      schema: 2,
      tag: `cycling-coach@${version}`,
      version,
      sourceCommit,
      catalog: catalog(parse(environment("RELEASE_CATALOG")), sourceCommit),
      coordinator: {
        runId: environment("COORDINATOR_RUN_ID"),
        attempt: environment("COORDINATOR_RUN_ATTEMPT"),
        workflowCommit: environment("RELEASE_COMMIT"),
      },
      preparation: caller,
      archives: packages.map((name) => {
        const filename = `${name}-${version}.tgz`;
        const path = join(directory, filename);
        return {
          name,
          filename,
          size: statSync(path).size,
          sha512: hash(readFileSync(path), "sha512"),
        };
      }),
    });
    verifyArchives(value, directory);
    writeFileSync(join(directory, "release-manifest.json"), json(value));
    return;
  }
  if (command === "reserve") {
    await validatePolicies();
    const value = manifest(parse(readFileSync(join(directory, "release-manifest.json"), "utf8")));
    if (json(value.preparation) !== json(caller))
      throw new Error("Preparation invocation mismatch");
    await validateSource(value);
    await validateInvocation(value.preparation, "release.yml", "workflow_dispatch", "smoke");
    const name = `npm-stage/${value.tag}`;
    if (await readTag(name))
      throw new Error("A reservation already exists; use resume without rebuilding");
    const reserved = {
      manifest: value,
      artifactId: identifier(environment("ARTIFACT_ID")),
      artifactDigest: digest(environment("ARTIFACT_DIGEST")),
    };
    await validateArtifact(reserved);
    await createTag(name, value.sourceCommit, reserved);
    return;
  }
  if (command === "stage") {
    await validatePolicies();
    if (!caller) throw new Error("Missing publisher identity");
    const name = packageName(environment("RELEASE_PACKAGE"));
    const stored = await readTag(`npm-stage/${environment("RELEASE_TAG")}`);
    if (!stored) throw new Error("Missing reservation");
    const value = { ...reservation(stored.value), sha: stored.sha };
    if (
      stored.object.type !== "commit" ||
      stored.object.sha !== value.manifest.sourceCommit ||
      value.manifest.tag !== environment("RELEASE_TAG")
    )
      throw new Error("Reservation source mismatch");
    await validateSource(value.manifest);
    const attempt = await readAttempt(value, name);
    if (!attempt || json(attempt.publisher) !== json(caller))
      throw new Error("Stage attempt is not owned by this invocation");
    await validateInvocation(
      caller,
      "release.yml",
      "workflow_dispatch",
      name === "cycling-coach" ? "primary-intent" : "alias-intent",
    );
    if (
      json(manifest(parse(readFileSync(join(directory, "release-manifest.json"), "utf8")))) !==
      json(value.manifest)
    )
      throw new Error("Publisher manifest mismatch");
    verifyArchives(value.manifest, directory);
    const archive = value.manifest.archives.find((entry) => entry.name === name);
    if (!archive) throw new Error("Missing archive");
    const receipt = {
      status: "unknown",
      reservation: value.sha,
      name,
      publisher: caller,
      manifestSha256: hash(json(value.manifest)),
    };
    const receiptPath = environment("RECEIPT_PATH");
    writeFileSync(receiptPath, json(receipt), { flag: "wx" });
    const response = run(environment("PUBLISHER_NODE"), [
      environment("PUBLISHER_NPM"),
      "stage",
      "publish",
      join(directory, archive.filename),
      "--access",
      "public",
      "--ignore-scripts",
      "--json",
      "--provenance",
      "--tag",
      `candidate-${value.manifest.preparation.runId}-${value.manifest.preparation.attempt}`,
      "--fetch-retries=0",
      "--fetch-timeout=30000",
      "--registry=https://registry.npmjs.org/",
    ]);
    const stageId = stageResponse(parse(response), archive, value.manifest.version);
    writeFileSync(receiptPath, json({ ...receipt, status: "accepted", stageId }));
    output("stage_id", stageId);
    return;
  }
  const value = await restore(environment("RELEASE_TAG"), directory);
  if (command === "restore") {
    output("package", "cycling-coach");
    output("version", value.manifest.version);
    output("ref", value.manifest.tag);
    output("commit", value.manifest.sourceCommit);
    output("artifact_id", value.artifactId);
    output("artifact_digest", value.artifactDigest);
    output("preparation_run_id", value.manifest.preparation.runId);
    output("preparation_run_attempt", value.manifest.preparation.attempt);
    return;
  }
  if (command === "begin") {
    await validatePolicies();
    if (!caller) throw new Error("Missing publisher identity");
    const name = packageName(environment("RELEASE_PACKAGE"));
    if (name === "enduragent") {
      const primary = await readAttempt(value, "cycling-coach");
      if (!primary) throw new Error("Primary package has not been staged");
      await acceptedReceipt(value, primary);
    }
    const existing = await readAttempt(value, name);
    if (existing) {
      output("stage_id", await acceptedReceipt(value, existing));
      output("stage", "false");
      return;
    }
    const attempt = { reservation: value.sha, name, publisher: caller };
    await createTag(
      `npm-stage-attempt/${value.manifest.tag}/${name}`,
      caller.workflowCommit,
      attempt,
    );
    output("stage", "true");
    output("artifact_id", value.artifactId);
    output("preparation_run_id", value.manifest.preparation.runId);
    output("receipt_name", receiptName(value.manifest, attempt));
    return;
  }
  if (command === "reconcile") {
    const verified: { name: PackageName; stageId: string }[] = [];
    for (const archive of value.manifest.archives) {
      const attempt = await readAttempt(value, archive.name);
      if (!attempt) continue;
      const list: unknown = parse(
        run("npm", [
          "stage",
          "list",
          archive.name,
          "--json",
          "--registry=https://registry.npmjs.org/",
        ]),
      );
      if (!Array.isArray(list)) throw new Error("Invalid staged package list");
      const candidates = list
        .map(record)
        .filter(
          (item) =>
            item.packageName === archive.name &&
            item.version === value.manifest.version &&
            item.tag ===
              `candidate-${value.manifest.preparation.runId}-${value.manifest.preparation.attempt}`,
        );
      if (candidates.length !== 1)
        throw new Error("Stage result remains ambiguous; do not restage");
      const stageId = text(
        candidates[0]?.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
      );
      execFileSync(
        "npm",
        ["stage", "download", stageId, "--registry=https://registry.npmjs.org/"],
        { cwd: directory },
      );
      const bytes = readFileSync(
        join(directory, `${archive.name}-${value.manifest.version}-${stageId}.tgz`),
      );
      if (bytes.length !== archive.size || hash(bytes, "sha512") !== archive.sha512)
        throw new Error("Staged package archive mismatch");
      verified.push({ name: archive.name, stageId });
    }
    if (verified.length === 0) throw new Error("No attempted packages to reconcile");
    process.stdout.write(
      json({ status: "attempted-staged-archives-verified", packages: verified }),
    );
    return;
  }
  if (command === "verify-primary-public") {
    await verifyPublic(value, directory, ["cycling-coach"]);
    return;
  }
  if (command === "verify-public" || command === "promote-latest") {
    await verifyPublic(value, directory);
    const readLatest = (name: PackageName) =>
      run("npm", ["view", `${name}@latest`, "version", "--registry=https://registry.npmjs.org/"]);
    if (command === "verify-public") {
      if (packages.some((name) => readLatest(name) !== value.manifest.version))
        throw new Error("Both public archives verified; operator must promote latest");
    } else {
      promoteLatest(value.manifest.version, readLatest, (name, version) => {
        execFileSync(
          "npm",
          [
            "dist-tag",
            "add",
            `${name}@${version}`,
            "latest",
            "--registry=https://registry.npmjs.org/",
          ],
          { stdio: "inherit" },
        );
      });
    }
    return;
  }
  throw new Error("Unsupported release operation");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNpmRelease(process.argv[2] ?? "", resolve(process.argv[3] ?? ".")).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Release failed"}\n`);
    process.exitCode = 1;
  });
}
