#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DESKTOP_FEED_URL, GITHUB_DESKTOP_RELEASE_FEED_URL } from "./desktop-update-feed.js";

export { DESKTOP_FEED_URL, GITHUB_DESKTOP_RELEASE_FEED_URL };
export const DESKTOP_MANIFEST = "desktop-release-manifest.json";
export const DESKTOP_RELEASE_SCHEMA_VERSION = 3 as const;
export const DESKTOP_PROVISIONAL_RELEASE_BODY =
  "Desktop update validation is in progress. This release is not yet generally available.";
export const WINDOWS_DESKTOP_METADATA_NAME = "latest.yml";

type RetainedDesktopReleaseMode = "steady" | "genesis";

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sha512Base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u);

const DesktopReleaseFileSchema = z
  .object({
    name: z.string(),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256HexSchema,
    sha512: sha512Base64Schema,
  })
  .strict();

const DesktopReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_RELEASE_SCHEMA_VERSION),
    tag: z.string(),
    desktopVersion: z.string(),
    commit: z.string(),
    draftId: z.string(),
    mode: z.enum(["steady", "genesis"]),
    feedUrl: z.literal(DESKTOP_FEED_URL),
    workflowRunId: z.string(),
    workflowRunAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    draftBodySha256: sha256HexSchema,
    signingIdentity: z.string(),
    candidateCdHash: z.string(),
    candidateCodeDirectorySha256: sha256HexSchema,
    baselineTag: z.string(),
    baselineReleaseId: z.string(),
    baselineCommit: z.string(),
    baselineZipSha256: z.string(),
    baselineSigningIdentity: z.string(),
    baselineCdHash: z.string(),
    transactionSha256: sha256HexSchema,
    files: z.array(DesktopReleaseFileSchema),
  })
  .strict();

export type DesktopReleaseFile = z.infer<typeof DesktopReleaseFileSchema>;
export type DesktopReleaseManifest = z.infer<typeof DesktopReleaseManifestSchema>;

interface GithubAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly digest: string | null;
  readonly state: "starter" | "uploaded";
  readonly url: string;
  readonly browser_download_url: string;
}

interface GithubRelease {
  readonly id: number;
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly GithubAsset[];
  readonly upload_url: string;
  readonly body: string;
}

interface GithubReference {
  readonly object: { readonly type: "commit" | "tag"; readonly sha: string };
}

interface GithubTag {
  readonly object: { readonly type: "commit" | "tag"; readonly sha: string };
}

export interface LatestObservation {
  readonly id: number | null;
  readonly tag: string | null;
  readonly metadataSha256: string | null;
}

export type DesktopLatestPromotionOutcome = "applied" | "unknown" | "unapplied" | "foreign";

export class DesktopLatestPromotionOutcomeError extends TypeError {
  readonly outcome: Exclude<DesktopLatestPromotionOutcome, "applied">;

  constructor(
    outcome: Exclude<DesktopLatestPromotionOutcome, "applied">,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesktopLatestPromotionOutcomeError";
    this.outcome = outcome;
  }
}

export interface NpmAttestationExpectation {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly repository: string;
  readonly workflow: string;
  readonly ref: string;
  readonly workflowCommit: string;
  readonly invocationId: string;
  readonly allowPriorInvocation?: boolean;
  readonly releaseTag: string;
  readonly eventName: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
}

export interface NpmProvenanceIdentity {
  readonly issuer: "https://token.actions.githubusercontent.com";
  readonly uri: string;
}

export type NpmProvenanceBundleVerifier = (
  bundle: Record<string, unknown>,
  identity: NpmProvenanceIdentity,
) => Promise<void>;

const desktopVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const npmVersionPattern = /^([1-9]\d{3})\.([1-9]|1[0-2])\.(0|[1-9]\d*)$/u;
const desktopTagPrefix = "enduragent-desktop@";
export const DESKTOP_STABLE_DMG_NAME = "Enduragent-arm64.dmg";
const legacyDesktopBaselineTag = "cycling-coach@2026.8.8";
const legacyDesktopBaselineVersion = "0.1.0";
const commitPattern = /^[0-9a-f]{40}$/u;
const signingIdentityPattern = /^Developer ID Application: .+ \(FA494ACVTF\)$/u;
const releasePropagationAttempts = 30;
const latestReleasePropagationAttempts = 240;
const stableLatestObservationCount = 3;
const releasePropagationDelayMs = 2_000;
const latestReleasePropagationDelayMs = 5_000;
const metadataRequestTimeoutMs = 30_000;
const assetTransferTimeoutMs = 10 * 60_000;
const releasePropagationTimeoutMs = 10 * 60_000;
const latestReleasePropagationTimeoutMs = 20 * 60_000;

type DesktopReleaseTimer = unknown;

export interface GithubClientTiming {
  readonly metadataRequestTimeoutMs: number;
  readonly assetTransferTimeoutMs: number;
  readonly releasePropagationTimeoutMs: number;
  readonly latestReleasePropagationTimeoutMs: number;
  readonly releasePropagationDelayMs: number;
  readonly latestReleasePropagationDelayMs: number;
  readonly now: () => number;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => DesktopReleaseTimer;
  readonly cancelTimeout: (timer: DesktopReleaseTimer) => void;
}

export type GithubClientTimingOptions = Partial<GithubClientTiming>;

interface LatestPollBudget {
  remaining: number;
  deadlineAt: number;
}

interface LatestMutationDeadlines {
  readonly preflightDeadlineAt: number;
  readonly requestDeadlineAt: number;
  readonly reconciliationDeadlineAt: number;
}

function exactObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function requireDesktopVersion(value: unknown): string {
  if (typeof value !== "string" || !desktopVersionPattern.test(value)) {
    throw new TypeError("desktop release version is invalid");
  }
  if (value.split(".").some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new TypeError("desktop release version is invalid");
  }
  return value;
}

export function requireNpmVersion(value: unknown): string {
  if (typeof value !== "string" || !npmVersionPattern.test(value)) {
    throw new TypeError("npm release version is invalid");
  }
  return value;
}

function requireRetainedMode(value: unknown): RetainedDesktopReleaseMode {
  if (value !== "steady" && value !== "genesis") {
    throw new TypeError("desktop release mode is invalid");
  }
  return value;
}

function requireSteadyReleaseAuthority(mode: unknown): asserts mode is "steady" {
  if (mode !== "steady") {
    throw new TypeError("desktop genesis release authority is retired");
  }
}

function desktopTag(version: string): string {
  return `${desktopTagPrefix}${requireDesktopVersion(version)}`;
}

function versionFromDesktopTag(tag: string): string | null {
  if (!tag.startsWith(desktopTagPrefix)) return null;
  const version = tag.slice(desktopTagPrefix.length);
  try {
    return desktopTag(version) === tag ? version : null;
  } catch {
    return null;
  }
}

function validDesktopBaselineTag(tag: string): boolean {
  return tag === legacyDesktopBaselineTag || versionFromDesktopTag(tag) !== null;
}

export function releaseFileNames(version: string): readonly [string, string, string, string] {
  const stableVersion = requireDesktopVersion(version);
  const base = `Enduragent-${stableVersion}-arm64`;
  return [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, "latest-mac.yml"];
}

export function windowsReleaseFileNames(
  version: string,
): readonly [string, string, string, string] {
  const stableVersion = requireDesktopVersion(version);
  const installer = `Enduragent-${stableVersion}-x64.exe`;
  return [
    installer,
    `${installer}.blockmap`,
    WINDOWS_DESKTOP_METADATA_NAME,
    `Enduragent-${stableVersion}-x64-verification.json`,
  ];
}

export function macosOwnedAssets<T extends Pick<GithubAsset, "name">>(
  assets: readonly T[],
  version: string,
): readonly T[] {
  const windowsNames = new Set(windowsReleaseFileNames(version));
  return assets.filter((asset) => !windowsNames.has(asset.name));
}

function requireBinding(input: {
  tag: unknown;
  desktopVersion: unknown;
  commit: unknown;
  draftId: unknown;
  mode: unknown;
  workflowRunId?: unknown;
  workflowRunAttempt?: unknown;
  draftBodySha256?: unknown;
  signingIdentity?: unknown;
  candidateCdHash?: unknown;
  candidateCodeDirectorySha256?: unknown;
  baselineTag?: unknown;
  baselineReleaseId?: unknown;
  baselineCommit?: unknown;
  baselineZipSha256?: unknown;
  baselineSigningIdentity?: unknown;
  baselineCdHash?: unknown;
}): Omit<DesktopReleaseManifest, "schemaVersion" | "feedUrl" | "files" | "transactionSha256"> {
  const desktopVersion = requireDesktopVersion(input.desktopVersion);
  const tag = desktopTag(desktopVersion);
  if (input.tag !== tag) throw new TypeError("desktop release tag and version do not match");
  if (typeof input.commit !== "string" || !commitPattern.test(input.commit)) {
    throw new TypeError("desktop release commit is invalid");
  }
  if (typeof input.draftId !== "string" || !/^[1-9]\d*$/u.test(input.draftId)) {
    throw new TypeError("desktop release draft id is invalid");
  }
  if (typeof input.workflowRunId !== "string" || !/^[1-9]\d*$/u.test(input.workflowRunId))
    throw new TypeError("workflow run id is invalid");
  const workflowRunAttempt = Number(input.workflowRunAttempt);
  if (!Number.isSafeInteger(workflowRunAttempt) || workflowRunAttempt < 1)
    throw new TypeError("workflow run attempt is invalid");
  if (typeof input.draftBodySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.draftBodySha256))
    throw new TypeError("draft body hash is invalid");
  if (typeof input.candidateCdHash !== "string" || !/^[0-9a-f]{40}$/u.test(input.candidateCdHash))
    throw new TypeError("candidate CDHash is invalid");
  if (
    typeof input.candidateCodeDirectorySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.candidateCodeDirectorySha256)
  )
    throw new TypeError("candidate CodeDirectory hash is invalid");
  if (
    typeof input.signingIdentity !== "string" ||
    !signingIdentityPattern.test(input.signingIdentity)
  )
    throw new TypeError("signing identity is invalid");
  const baselineTag = typeof input.baselineTag === "string" ? input.baselineTag : "";
  const mode = requireRetainedMode(input.mode);
  const baselineEvidence = [
    input.baselineReleaseId,
    input.baselineCommit,
    input.baselineZipSha256,
    input.baselineSigningIdentity,
    input.baselineCdHash,
  ];
  if (
    mode === "genesis"
      ? baselineTag !== "none" || baselineEvidence.some((value) => value !== "none")
      : !validDesktopBaselineTag(baselineTag)
  )
    throw new TypeError("baseline evidence is invalid");
  if (
    mode === "steady" &&
    (typeof input.baselineReleaseId !== "string" ||
      !/^[1-9]\d*$/u.test(input.baselineReleaseId) ||
      typeof input.baselineCommit !== "string" ||
      !commitPattern.test(input.baselineCommit) ||
      typeof input.baselineZipSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(input.baselineZipSha256) ||
      typeof input.baselineSigningIdentity !== "string" ||
      !signingIdentityPattern.test(input.baselineSigningIdentity) ||
      typeof input.baselineCdHash !== "string" ||
      !/^[0-9a-f]{40}$/u.test(input.baselineCdHash))
  )
    throw new TypeError("steady baseline evidence is invalid");
  return {
    tag,
    desktopVersion,
    commit: input.commit,
    draftId: input.draftId,
    mode,
    workflowRunId: input.workflowRunId,
    workflowRunAttempt,
    draftBodySha256: input.draftBodySha256 as string,
    signingIdentity: input.signingIdentity,
    candidateCdHash: input.candidateCdHash as string,
    candidateCodeDirectorySha256: input.candidateCodeDirectorySha256 as string,
    baselineTag,
    baselineReleaseId: input.baselineReleaseId as string,
    baselineCommit: input.baselineCommit as string,
    baselineZipSha256: input.baselineZipSha256 as string,
    baselineSigningIdentity: input.baselineSigningIdentity as string,
    baselineCdHash: input.baselineCdHash as string,
  };
}

async function stableFile(path: string): Promise<{ bytes: Buffer; size: number }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new TypeError(`invalid release file: ${basename(path)}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size
  ) {
    throw new TypeError(`unstable release file: ${basename(path)}`);
  }
  return { bytes, size: before.size };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!exactObject(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

export function inspectNpmAttestationClaims(
  metadata: unknown,
  expected: NpmAttestationExpectation,
): { bundle: Record<string, unknown>; workflowRef: string } {
  const document = requireRecord(metadata, "npm attestation document");
  const attestations = requireArray(document.attestations, "npm attestations");
  const types = [
    "https://slsa.dev/provenance/v1",
    "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
  ] as const;
  const statementTypes = new Map<string, string>([
    [types[0], "https://in-toto.io/Statement/v1"],
    [types[1], "https://in-toto.io/Statement/v0.1"],
  ]);
  const expectedPurl = `pkg:npm/${expected.name}@${expected.version}`;
  const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(expected.integrity);
  if (!integrityMatch) throw new TypeError("expected npm integrity is invalid");
  const expectedHex = Buffer.from(integrityMatch[1], "base64").toString("hex");
  const statements = new Map<string, Record<string, unknown>>();
  const bundles = new Map<string, Record<string, unknown>>();
  for (const raw of attestations) {
    const attestation = requireRecord(raw, "npm attestation");
    if (typeof attestation.predicateType !== "string")
      throw new TypeError("npm attestation predicate type is invalid");
    const bundle = requireRecord(attestation.bundle, "npm attestation bundle");
    const envelope = requireRecord(bundle.dsseEnvelope, "npm DSSE envelope");
    if (typeof envelope.payload !== "string") throw new TypeError("npm DSSE payload is invalid");
    let statement: unknown;
    try {
      statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    } catch {
      throw new TypeError("npm DSSE statement is invalid");
    }
    const decoded = requireRecord(statement, "npm DSSE statement");
    if (!types.includes(attestation.predicateType as (typeof types)[number])) {
      const subjects = Array.isArray(decoded.subject) ? decoded.subject : [];
      if (subjects.some((subject) => exactObject(subject) && subject.name === expectedPurl))
        throw new TypeError("unexpected npm attestation predicate for release subject");
      continue;
    }
    if (statements.has(attestation.predicateType))
      throw new TypeError("duplicate npm attestation predicate");
    statements.set(attestation.predicateType, decoded);
    bundles.set(attestation.predicateType, bundle);
  }
  if (statements.size !== types.length)
    throw new TypeError("required npm attestations are missing");
  for (const type of types) {
    const statement = statements.get(type)!;
    if (statement._type !== statementTypes.get(type) || statement.predicateType !== type)
      throw new TypeError("npm attestation statement type is invalid");
    const matchingSubjects = requireArray(statement.subject, "npm attestation subjects").filter(
      (subject) => {
        if (!exactObject(subject) || subject.name !== expectedPurl || !exactObject(subject.digest))
          return false;
        return subject.digest.sha512 === expectedHex;
      },
    );
    if (matchingSubjects.length !== 1)
      throw new TypeError("npm attestation subject digest binding is invalid");
  }
  const provenance = requireRecord(statements.get(types[0])!.predicate, "npm provenance predicate");
  const definition = requireRecord(provenance.buildDefinition, "npm provenance build definition");
  const internal = requireRecord(
    definition.internalParameters,
    "npm provenance internal parameters",
  );
  const githubInternal = requireRecord(internal.github, "npm provenance GitHub parameters");
  const external = requireRecord(
    definition.externalParameters,
    "npm provenance external parameters",
  );
  const workflow = requireRecord(external.workflow, "npm provenance workflow");
  const workflowRef = typeof workflow.ref === "string" ? workflow.ref : "";
  if (workflow.repository !== expected.repository)
    throw new TypeError("npm provenance repository rename boundary requires a new release version");
  const dependencies = requireArray(
    definition.resolvedDependencies,
    "npm provenance resolved dependencies",
  );
  const matchingDependencies = dependencies.filter((dependency) => {
    if (!exactObject(dependency) || !exactObject(dependency.digest)) return false;
    return (
      dependency.digest.gitCommit === expected.workflowCommit &&
      dependency.uri === `git+${expected.repository}@${workflowRef}`
    );
  });
  const runDetails = requireRecord(provenance.runDetails, "npm provenance run details");
  const builder = requireRecord(runDetails.builder, "npm provenance builder");
  const runMetadata = requireRecord(runDetails.metadata, "npm provenance run metadata");
  const eventNameMatches =
    expected.allowPriorInvocation === true && workflowRef === `refs/tags/${expected.releaseTag}`
      ? githubInternal.event_name === "push" || githubInternal.event_name === "workflow_dispatch"
      : githubInternal.event_name === expected.eventName;
  if (
    definition.buildType !==
      "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" ||
    workflow.repository !== expected.repository ||
    workflow.path !== expected.workflow ||
    (workflowRef !== expected.ref &&
      (!expected.allowPriorInvocation || workflowRef !== `refs/tags/${expected.releaseTag}`)) ||
    matchingDependencies.length !== 1 ||
    !eventNameMatches ||
    githubInternal.repository_id !== expected.repositoryId ||
    githubInternal.repository_owner_id !== expected.repositoryOwnerId ||
    builder.id !== "https://github.com/actions/runner/github-hosted" ||
    (expected.allowPriorInvocation
      ? typeof runMetadata.invocationId !== "string" ||
        !new RegExp(
          `^${expected.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/[1-9]\\d*/attempts/[1-9]\\d*$`,
          "u",
        ).test(runMetadata.invocationId)
      : runMetadata.invocationId !== expected.invocationId)
  )
    throw new TypeError("npm provenance workflow binding is invalid");
  const publish = requireRecord(statements.get(types[1])!.predicate, "npm publish predicate");
  if (
    publish.name !== expected.name ||
    publish.version !== expected.version ||
    publish.registry !== "https://registry.npmjs.org"
  )
    throw new TypeError("npm publish attestation binding is invalid");
  return { bundle: bundles.get(types[0])!, workflowRef };
}

export async function verifyNpmProvenanceBundle(
  metadata: unknown,
  expected: NpmAttestationExpectation,
  verifyBundle: NpmProvenanceBundleVerifier,
): Promise<void> {
  const { bundle, workflowRef } = inspectNpmAttestationClaims(metadata, expected);
  await verifyBundle(bundle, {
    issuer: "https://token.actions.githubusercontent.com",
    uri: `${expected.repository}/${expected.workflow}@${workflowRef}`,
  });
}

function requireMetadata(
  bytes: Buffer,
  version: string,
  files: ReadonlyMap<string, { bytes: Buffer; size: number }>,
): void {
  const value: unknown = parseYaml(bytes.toString("utf8"));
  if (
    !exactObject(value) ||
    !exactKeys(value, ["version", "files", "path", "sha512", "releaseDate"]) ||
    value.version !== version ||
    !Array.isArray(value.files) ||
    value.files.length !== 2 ||
    typeof value.releaseDate !== "string" ||
    !Number.isFinite(Date.parse(value.releaseDate)) ||
    new Date(Date.parse(value.releaseDate)).toISOString() !== value.releaseDate
  ) {
    throw new TypeError("latest-mac.yml is invalid");
  }
  const expected = releaseFileNames(version);
  const zip = files.get(expected[1]);
  const dmg = files.get(expected[0]);
  if (!zip || !dmg || value.path !== expected[1] || value.sha512 !== sha512(zip.bytes)) {
    throw new TypeError("latest-mac.yml is not bound to the release ZIP");
  }
  for (const [index, [name, file]] of (
    [
      [expected[1], zip],
      [expected[0], dmg],
    ] as const
  ).entries()) {
    const entry = value.files[index];
    if (
      !exactObject(entry) ||
      !exactKeys(entry, ["url", "sha512", "size"]) ||
      entry.url !== name ||
      entry.sha512 !== sha512(file.bytes) ||
      entry.size !== file.size ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    ) {
      throw new TypeError(`latest-mac.yml is not bound to ${name}`);
    }
  }
}

export async function sealDesktopRelease(
  directory: string,
  bindingInput: Parameters<typeof requireBinding>[0],
): Promise<DesktopReleaseManifest> {
  const binding = requireBinding(bindingInput);
  requireSteadyReleaseAuthority(binding.mode);
  const expected = releaseFileNames(binding.desktopVersion);
  const entries = (await readdir(directory)).sort();
  if (entries.length !== expected.length || expected.some((name) => !entries.includes(name))) {
    throw new TypeError("release envelope must contain exactly four updater files before sealing");
  }
  const snapshots = new Map<string, { bytes: Buffer; size: number }>();
  for (const name of expected) snapshots.set(name, await stableFile(resolve(directory, name)));
  requireMetadata(snapshots.get(expected[3])!.bytes, binding.desktopVersion, snapshots);
  const files = expected.map((name) => {
    const snapshot = snapshots.get(name)!;
    return {
      name,
      size: snapshot.size,
      sha256: sha256(snapshot.bytes),
      sha512: sha512(snapshot.bytes),
    };
  });
  const transactionSha256 = sha256(
    Buffer.from(JSON.stringify({ ...binding, feedUrl: DESKTOP_FEED_URL, files })),
  );
  const manifest: DesktopReleaseManifest = {
    schemaVersion: DESKTOP_RELEASE_SCHEMA_VERSION,
    ...binding,
    feedUrl: DESKTOP_FEED_URL,
    files,
    transactionSha256,
  };
  await writeFile(resolve(directory, DESKTOP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

function parseManifest(value: unknown): DesktopReleaseManifest {
  let manifest: DesktopReleaseManifest;
  try {
    manifest = DesktopReleaseManifestSchema.parse(value);
  } catch (cause) {
    throw new TypeError("desktop release manifest is invalid", { cause });
  }
  const binding = requireBinding({
    tag: manifest.tag,
    desktopVersion: manifest.desktopVersion,
    commit: manifest.commit,
    draftId: manifest.draftId,
    mode: manifest.mode,
    workflowRunId: manifest.workflowRunId,
    workflowRunAttempt: manifest.workflowRunAttempt,
    draftBodySha256: manifest.draftBodySha256,
    signingIdentity: manifest.signingIdentity,
    candidateCdHash: manifest.candidateCdHash,
    candidateCodeDirectorySha256: manifest.candidateCodeDirectorySha256,
    baselineTag: manifest.baselineTag,
    baselineReleaseId: manifest.baselineReleaseId,
    baselineCommit: manifest.baselineCommit,
    baselineZipSha256: manifest.baselineZipSha256,
    baselineSigningIdentity: manifest.baselineSigningIdentity,
    baselineCdHash: manifest.baselineCdHash,
  });
  const expected = releaseFileNames(binding.desktopVersion);
  if (manifest.files.length !== expected.length)
    throw new TypeError("desktop release manifest file set is invalid");
  for (const [index, file] of manifest.files.entries()) {
    if (file.name !== expected[index]) {
      throw new TypeError("desktop release manifest file entry is invalid");
    }
  }
  const transactionSha256 = sha256(
    Buffer.from(JSON.stringify({ ...binding, feedUrl: DESKTOP_FEED_URL, files: manifest.files })),
  );
  if (manifest.transactionSha256 !== transactionSha256)
    throw new TypeError("desktop release transaction hash is invalid");
  return manifest;
}

export async function verifyDesktopRelease(
  directory: string,
  expectedBinding?: Parameters<typeof requireBinding>[0],
): Promise<DesktopReleaseManifest> {
  const names = (await readdir(directory)).sort();
  const manifestBytes = await stableFile(resolve(directory, DESKTOP_MANIFEST));
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBytes.bytes.toString("utf8"));
  } catch {
    throw new TypeError("desktop release manifest is invalid JSON");
  }
  const manifest = parseManifest(decoded);
  const expectedNames = [...releaseFileNames(manifest.desktopVersion), DESKTOP_MANIFEST].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new TypeError("sealed release envelope contains unexpected files");
  }
  if (expectedBinding) {
    const expected = requireBinding(expectedBinding);
    for (const key of [
      "tag",
      "desktopVersion",
      "commit",
      "draftId",
      "mode",
      "workflowRunId",
      "workflowRunAttempt",
      "draftBodySha256",
      "signingIdentity",
      "candidateCdHash",
      "candidateCodeDirectorySha256",
      "baselineTag",
      "baselineReleaseId",
      "baselineCommit",
      "baselineZipSha256",
      "baselineSigningIdentity",
      "baselineCdHash",
    ] as const) {
      if (manifest[key] !== expected[key])
        throw new TypeError(`desktop release manifest ${key} mismatch`);
    }
  }
  const snapshots = new Map<string, { bytes: Buffer; size: number }>();
  for (const file of manifest.files) {
    const snapshot = await stableFile(resolve(directory, file.name));
    if (
      snapshot.size !== file.size ||
      sha256(snapshot.bytes) !== file.sha256 ||
      sha512(snapshot.bytes) !== file.sha512
    ) {
      throw new TypeError(`desktop release file digest mismatch: ${file.name}`);
    }
    snapshots.set(file.name, snapshot);
  }
  requireMetadata(snapshots.get("latest-mac.yml")!.bytes, manifest.desktopVersion, snapshots);
  return manifest;
}

export async function materializeDesktopPublicEnvelope(
  directory: string,
  output: string,
): Promise<DesktopReleaseManifest> {
  const source = resolve(directory);
  const target = resolve(output);
  const targetFromSource = relative(source, target);
  if (
    targetFromSource === "" ||
    (targetFromSource !== ".." && !targetFromSource.startsWith(`..${sep}`))
  ) {
    throw new TypeError("public envelope must be outside the sealed release envelope");
  }
  const manifest = await verifyDesktopRelease(source);
  await mkdir(target, { mode: 0o700 });
  for (const file of manifest.files) {
    const destination = resolve(target, file.name);
    await link(resolve(source, file.name), destination);
    const snapshot = await stableFile(destination);
    if (
      snapshot.size !== file.size ||
      sha256(snapshot.bytes) !== file.sha256 ||
      sha512(snapshot.bytes) !== file.sha512
    ) {
      throw new TypeError(`public envelope file digest mismatch: ${file.name}`);
    }
  }
  const names = (await readdir(target)).sort();
  const expected = [...releaseFileNames(manifest.desktopVersion)].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new TypeError("public envelope must contain exactly four updater files");
  }
  return manifest;
}

export function assertPublishableAssets(
  existing: readonly Pick<GithubAsset, "name">[],
  manifest: DesktopReleaseManifest,
): void {
  const allowed = new Set([
    ...manifest.files.map((file) => file.name),
    ...windowsReleaseFileNames(manifest.desktopVersion),
  ]);
  const duplicate = existing.find(
    (asset, index) => existing.findIndex((other) => other.name === asset.name) !== index,
  );
  if (duplicate) throw new TypeError(`duplicate release asset: ${duplicate.name}`);
  const stale = existing.find((asset) => !allowed.has(asset.name));
  if (stale) throw new TypeError(`stale release asset: ${stale.name}`);
}

async function assertResolvedBaseline(
  manifest: DesktopReleaseManifest,
  baseline: Awaited<ReturnType<typeof newestDesktopRelease>>,
  client: GithubClient,
): Promise<NonNullable<Awaited<ReturnType<typeof newestDesktopRelease>>>> {
  requireSteadyReleaseAuthority(manifest.mode);
  if (baseline === null) throw new TypeError("steady release requires a desktop baseline");
  const baselineZipName = releaseFileNames(baseline.version)[1];
  const baselineZipAsset = baseline.release.assets.find((asset) => asset.name === baselineZipName);
  const baselineZipBytes = baselineZipAsset ? await client.bytes(baselineZipAsset.url) : null;
  if (
    compareVersions(baseline.version, manifest.desktopVersion) >= 0 ||
    manifest.baselineTag !== baseline.release.tag_name ||
    manifest.baselineReleaseId !== String(baseline.release.id) ||
    manifest.baselineCommit !== baseline.commit ||
    !baselineZipAsset ||
    !baselineZipBytes ||
    baselineZipAsset.size !== baselineZipBytes.length ||
    manifest.baselineZipSha256 !== sha256(baselineZipBytes)
  ) {
    throw new TypeError("desktop release baseline binding mismatch");
  }
  return baseline;
}

export function assertRemoteAsset(file: DesktopReleaseFile, bytes: Uint8Array): void {
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
    throw new TypeError(`conflicting release asset: ${file.name}`);
  }
}

export function compareVersions(left: string, right: string): number {
  const a = requireDesktopVersion(left).split(".").map(Number);
  const b = requireDesktopVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assertLatestCas(
  candidateVersion: string,
  observed: LatestObservation,
  current: LatestObservation,
  previousDesktopVersion: string | null,
): void {
  if (
    observed.id !== current.id ||
    observed.tag !== current.tag ||
    observed.metadataSha256 !== current.metadataSha256
  ) {
    throw new TypeError("repository latest changed after publication observation");
  }
  if (
    previousDesktopVersion !== null &&
    compareVersions(candidateVersion, previousDesktopVersion) <= 0
  ) {
    throw new TypeError("desktop latest promotion is not monotonic");
  }
}

export type DesktopReleaseFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function githubClientTiming(options: GithubClientTimingOptions): GithubClientTiming {
  return Object.freeze({
    metadataRequestTimeoutMs: positiveDuration(
      options.metadataRequestTimeoutMs ?? metadataRequestTimeoutMs,
      "GitHub metadata timeout",
    ),
    assetTransferTimeoutMs: positiveDuration(
      options.assetTransferTimeoutMs ?? assetTransferTimeoutMs,
      "GitHub asset timeout",
    ),
    releasePropagationTimeoutMs: positiveDuration(
      options.releasePropagationTimeoutMs ?? releasePropagationTimeoutMs,
      "release propagation timeout",
    ),
    latestReleasePropagationTimeoutMs: positiveDuration(
      options.latestReleasePropagationTimeoutMs ?? latestReleasePropagationTimeoutMs,
      "latest propagation timeout",
    ),
    releasePropagationDelayMs: positiveDuration(
      options.releasePropagationDelayMs ?? releasePropagationDelayMs,
      "release propagation delay",
    ),
    latestReleasePropagationDelayMs: positiveDuration(
      options.latestReleasePropagationDelayMs ?? latestReleasePropagationDelayMs,
      "latest propagation delay",
    ),
    now: options.now ?? (() => Date.now()),
    scheduleTimeout:
      options.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    cancelTimeout:
      options.cancelTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
  });
}

export class GithubClient {
  readonly #repository: string;
  readonly #token: string;
  readonly #fetch: DesktopReleaseFetch;
  readonly #timing: GithubClientTiming;

  constructor(
    repository: string,
    token: string,
    fetchImplementation: DesktopReleaseFetch = fetch,
    timingOptions: GithubClientTimingOptions = {},
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
      throw new TypeError("GitHub repository is invalid");
    if (token.length === 0) throw new TypeError("GitHub token is missing");
    this.#repository = repository;
    this.#token = token;
    this.#fetch = fetchImplementation;
    this.#timing = githubClientTiming(timingOptions);
  }

  async #bounded<T>(
    label: string,
    configuredTimeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
    deadlineAt?: number,
  ): Promise<T> {
    const now = this.now();
    const availableMs = deadlineAt === undefined ? configuredTimeoutMs : deadlineAt - now;
    const timeoutMs = Math.min(configuredTimeoutMs, availableMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError(`${label} timed out`);
    }
    const controller = new AbortController();
    let timer: DesktopReleaseTimer;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.#timing.scheduleTimeout(() => {
        reject(new TypeError(`${label} timed out`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      this.#timing.cancelTimeout(timer!);
    }
  }

  now(): number {
    const now = this.#timing.now();
    if (!Number.isFinite(now)) throw new TypeError("release transaction clock is invalid");
    return now;
  }

  propagationDeadline(kind: "release" | "latest"): number {
    const duration =
      kind === "release"
        ? this.#timing.releasePropagationTimeoutMs
        : this.#timing.latestReleasePropagationTimeoutMs;
    return this.now() + duration;
  }

  latestMutationDeadlines(transactionDeadlineAt?: number): LatestMutationDeadlines {
    const now = this.now();
    const reconciliationDeadlineAt =
      transactionDeadlineAt ??
      now +
        this.#timing.releasePropagationTimeoutMs +
        this.#timing.metadataRequestTimeoutMs +
        this.#timing.latestReleasePropagationTimeoutMs;
    if (!Number.isFinite(reconciliationDeadlineAt) || reconciliationDeadlineAt <= now) {
      throw new TypeError("desktop latest transaction deadline is invalid");
    }
    const requestDeadlineAt =
      reconciliationDeadlineAt - this.#timing.latestReleasePropagationTimeoutMs;
    const preflightDeadlineAt = requestDeadlineAt - this.#timing.metadataRequestTimeoutMs;
    if (preflightDeadlineAt <= now) {
      throw new TypeError("desktop latest promotion reconciliation budget is unavailable");
    }
    return Object.freeze({
      preflightDeadlineAt,
      requestDeadlineAt,
      reconciliationDeadlineAt,
    });
  }

  async pauseForPropagation(kind: "release" | "latest", deadlineAt: number): Promise<void> {
    const configuredDelay =
      kind === "release"
        ? this.#timing.releasePropagationDelayMs
        : this.#timing.latestReleasePropagationDelayMs;
    const delayMs = Math.min(configuredDelay, deadlineAt - this.now());
    if (delayMs <= 0) return;
    await new Promise<void>((resolvePause) => {
      this.#timing.scheduleTimeout(resolvePause, delayMs);
    });
  }

  async request<T>(url: string, init: RequestInit = {}, deadlineAt?: number): Promise<T> {
    if (!url.startsWith("/")) throw new TypeError("GitHub API URL must be repository-relative");
    if (init.signal) throw new TypeError("GitHub API request signal is managed internally");
    const target = new URL(url, "https://api.github.com");
    const repositoryPrefix = `/repos/${this.#repository}/`;
    if (
      target.origin !== "https://api.github.com" ||
      target.username !== "" ||
      target.password !== "" ||
      !target.pathname.startsWith(repositoryPrefix)
    ) {
      throw new TypeError("GitHub API URL is outside the bound repository");
    }
    return this.#bounded(
      "GitHub metadata request",
      this.#timing.metadataRequestTimeoutMs,
      async (signal) => {
        const response = await this.#fetch(target, {
          ...init,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.#token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...init.headers,
          },
          signal,
        });
        if (!response.ok) {
          await response.arrayBuffer();
          throw new TypeError(`GitHub API request failed (${response.status})`);
        }
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      },
      deadlineAt,
    );
  }

  async bytes(url: string, deadlineAt?: number): Promise<Buffer> {
    const target = new URL(url);
    const assetPattern = new RegExp(
      `^/repos/${this.#repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/releases/assets/[1-9]\\d*$`,
      "u",
    );
    if (
      target.origin !== "https://api.github.com" ||
      target.username !== "" ||
      target.password !== "" ||
      !assetPattern.test(target.pathname) ||
      target.search !== "" ||
      target.hash !== ""
    ) {
      throw new TypeError("GitHub asset API URL is outside the bound repository");
    }
    return this.#bounded(
      "GitHub asset transfer",
      this.#timing.assetTransferTimeoutMs,
      async (signal) => {
        let current = target;
        for (let redirect = 0; redirect <= 5; redirect += 1) {
          const authenticated = current.origin === "https://api.github.com";
          const response = await this.#fetch(current, {
            headers: authenticated
              ? {
                  Accept: "application/octet-stream",
                  Authorization: `Bearer ${this.#token}`,
                  "X-GitHub-Api-Version": "2022-11-28",
                }
              : { Accept: "application/octet-stream" },
            redirect: "manual",
            signal,
          });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || redirect === 5)
              throw new TypeError("GitHub asset redirect is invalid");
            const next = new URL(location, current);
            if (
              next.protocol !== "https:" ||
              next.username !== "" ||
              next.password !== "" ||
              ![
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
                "github-releases.githubusercontent.com",
              ].includes(next.hostname)
            ) {
              throw new TypeError("GitHub asset redirect origin is invalid");
            }
            current = next;
            continue;
          }
          if (!response.ok) {
            await response.arrayBuffer();
            throw new TypeError(`GitHub asset download failed (${response.status})`);
          }
          return Buffer.from(await response.arrayBuffer());
        }
        throw new TypeError("GitHub asset redirect bound exceeded");
      },
      deadlineAt,
    );
  }

  async anonymousBytes(url: string, deadlineAt?: number): Promise<Buffer> {
    const target = new URL(url);
    const prefix = `/${this.#repository}/releases/`;
    const parts = target.pathname.split("/").map((part) => decodeURIComponent(part));
    const validLatest =
      parts.length === 7 &&
      parts[3] === "releases" &&
      parts[4] === "latest" &&
      parts[5] === "download" &&
      parts[6].length > 0;
    const validTag =
      parts.length === 7 &&
      parts[3] === "releases" &&
      parts[4] === "download" &&
      parts[5].length > 0 &&
      parts[6].length > 0;
    if (
      target.origin !== "https://github.com" ||
      target.username !== "" ||
      target.password !== "" ||
      !target.pathname.startsWith(prefix) ||
      (!validLatest && !validTag) ||
      target.search !== "" ||
      target.hash !== ""
    ) {
      throw new TypeError("anonymous GitHub asset URL is outside the bound repository");
    }
    return this.#bounded(
      "anonymous GitHub asset transfer",
      this.#timing.assetTransferTimeoutMs,
      async (signal) => {
        const response = await this.#fetch(target, {
          headers: { Accept: "application/octet-stream" },
          redirect: "follow",
          signal,
        });
        if (!response.ok) {
          await response.arrayBuffer();
          throw new TypeError(`anonymous GitHub asset download failed (${response.status})`);
        }
        return Buffer.from(await response.arrayBuffer());
      },
      deadlineAt,
    );
  }

  async publicFeedMetadataBytes(deadlineAt?: number): Promise<Buffer> {
    const target = new URL("latest-mac.yml", DESKTOP_FEED_URL);
    if (target.href !== `${DESKTOP_FEED_URL}latest-mac.yml`) {
      throw new TypeError("public updater feed URL is invalid");
    }
    return this.#bounded(
      "public updater feed transfer",
      this.#timing.assetTransferTimeoutMs,
      async (signal) => {
        const response = await this.#fetch(target, {
          headers: { Accept: "application/octet-stream" },
          redirect: "error",
          signal,
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new TypeError("public updater feed redirected");
        }
        if (!response.ok) {
          await response.arrayBuffer();
          throw new TypeError(`public updater feed download failed (${response.status})`);
        }
        if (response.headers.get("location") !== null) {
          await response.body?.cancel();
          throw new TypeError("public updater feed redirected");
        }
        return Buffer.from(await response.arrayBuffer());
      },
      deadlineAt,
    );
  }

  release(id: string | number, deadlineAt?: number): Promise<GithubRelease> {
    return this.request(`/repos/${this.#repository}/releases/${id}`, {}, deadlineAt);
  }

  async uploadAsset(
    release: Pick<GithubRelease, "id" | "upload_url">,
    name: string,
    bytes: Buffer,
  ): Promise<GithubAsset> {
    const expected = `https://uploads.github.com/repos/${this.#repository}/releases/${release.id}/assets{?name,label}`;
    if (release.upload_url !== expected) throw new TypeError("GitHub upload URL is invalid");
    const target = new URL(expected.slice(0, expected.indexOf("{")));
    target.searchParams.set("name", name);
    return this.#bounded(
      "GitHub asset upload",
      this.#timing.assetTransferTimeoutMs,
      async (signal) => {
        const response = await this.#fetch(target, {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.#token}`,
            "Content-Type": "application/octet-stream",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          await response.arrayBuffer();
          throw new TypeError(`GitHub asset upload failed (${response.status})`);
        }
        return (await response.json()) as GithubAsset;
      },
    );
  }

  deleteAsset(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("GitHub asset id is invalid");
    return this.request(`/repos/${this.#repository}/releases/assets/${id}`, { method: "DELETE" });
  }

  async latest(deadlineAt?: number): Promise<LatestObservation> {
    const release = await this.latestRelease(deadlineAt);
    if (!release) return { id: null, tag: null, metadataSha256: null };
    const metadata = release.assets.find((asset) => asset.name === "latest-mac.yml");
    let metadataSha256: string | null = null;
    if (metadata) {
      const match = /^sha256:([0-9a-f]{64})$/u.exec(metadata.digest ?? "");
      if (metadata.state !== "uploaded" || !match || metadata.size <= 0) {
        throw new TypeError("repository latest metadata digest is invalid");
      }
      const feedBytes = await this.publicFeedMetadataBytes(deadlineAt);
      metadataSha256 = sha256(feedBytes);
      if (feedBytes.length !== metadata.size || metadataSha256 !== match[1]) {
        throw new TypeError("repository latest and updater feed digest differ");
      }
    }
    return { id: release.id, tag: release.tag_name, metadataSha256 };
  }

  async latestRelease(deadlineAt?: number): Promise<GithubRelease | null> {
    return this.#bounded(
      "GitHub latest metadata request",
      this.#timing.metadataRequestTimeoutMs,
      async (signal) => {
        const response = await this.#fetch(
          `https://api.github.com/repos/${this.#repository}/releases/latest`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${this.#token}`,
              "Cache-Control": "no-cache",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal,
          },
        );
        if (response.status === 404) {
          await response.arrayBuffer();
          return null;
        }
        if (!response.ok) {
          await response.arrayBuffer();
          throw new TypeError(`GitHub latest request failed (${response.status})`);
        }
        return (await response.json()) as GithubRelease;
      },
      deadlineAt,
    );
  }

  async releases(deadlineAt?: number): Promise<readonly GithubRelease[]> {
    const releases: GithubRelease[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request<readonly GithubRelease[]>(
        `/repos/${this.#repository}/releases?per_page=100&page=${page}`,
        {},
        deadlineAt,
      );
      releases.push(...batch);
      if (batch.length < 100) return releases;
      if (page >= 100)
        throw new TypeError("desktop baseline history exceeds the audited pagination bound");
    }
  }

  async tagCommit(tag: string, deadlineAt?: number): Promise<string> {
    let object = (
      await this.request<GithubReference>(
        `/repos/${this.#repository}/git/ref/tags/${encodeURIComponent(tag)}`,
        {},
        deadlineAt,
      )
    ).object;
    for (let depth = 0; object.type === "tag" && depth < 8; depth += 1) {
      object = (
        await this.request<GithubTag>(
          `/repos/${this.#repository}/git/tags/${object.sha}`,
          {},
          deadlineAt,
        )
      ).object;
    }
    if (object.type !== "commit" || !commitPattern.test(object.sha)) {
      throw new TypeError("release tag does not resolve to a commit");
    }
    return object.sha;
  }

  repository(): string {
    return this.#repository;
  }
}

export function resolveDesktopReleaseVersion(
  release: GithubRelease,
  excludingTag?: string,
): string | null {
  if (release.draft || release.prerelease || release.tag_name === excludingTag) return null;
  const tagVersion =
    release.tag_name === legacyDesktopBaselineTag
      ? legacyDesktopBaselineVersion
      : versionFromDesktopTag(release.tag_name);
  if (tagVersion === null) return null;
  const versions = release.assets.flatMap((asset) => {
    const match = /^Enduragent-(\d+\.\d+\.\d+)-arm64\.dmg$/u.exec(asset.name);
    return match ? [match[1]] : [];
  });
  if (versions.length !== 1 || versions[0] !== tagVersion) return null;
  const version = versions[0];
  const macosAssets = macosOwnedAssets(release.assets, version);
  const expected = [...releaseFileNames(version)].sort();
  const actual = macosAssets
    .filter((asset) => asset.name !== DESKTOP_STABLE_DMG_NAME)
    .map((asset) => asset.name)
    .sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    return null;
  }
  const stableDmg = release.assets.find((asset) => asset.name === DESKTOP_STABLE_DMG_NAME);
  if (!stableDmg) return version;
  const versionedDmg = release.assets.find((asset) => asset.name === releaseFileNames(version)[0]);
  return versionedDmg &&
    stableDmg.state === "uploaded" &&
    stableDmg.size === versionedDmg.size &&
    stableDmg.digest !== null &&
    stableDmg.digest === versionedDmg.digest
    ? version
    : null;
}

async function newestDesktopRelease(
  releases: readonly GithubRelease[],
  client: GithubClient,
  excludingTag?: string,
  deadlineAt?: number,
): Promise<{ release: GithubRelease; version: string; commit: string } | null> {
  let selected: { release: GithubRelease; version: string; commit: string } | null = null;
  for (const release of releases) {
    const version = resolveDesktopReleaseVersion(release, excludingTag);
    if (!version) continue;
    const commit = await client.tagCommit(release.tag_name, deadlineAt);
    if (!selected || compareVersions(version, selected.version) > 0) {
      selected = { release, version, commit };
    }
  }
  return selected;
}

async function exactDesktopRelease(
  release: GithubRelease | undefined | null,
  client: GithubClient,
  tag: string,
): Promise<{ release: GithubRelease; version: string; commit: string } | null> {
  if (!release || release.tag_name !== tag) return null;
  const version = resolveDesktopReleaseVersion(release);
  if (!version) return null;
  return { release, version, commit: await client.tagCommit(tag) };
}

async function steadyDesktopBaseline(
  releases: readonly GithubRelease[],
  client: GithubClient,
  requestedTag: string,
): Promise<Awaited<ReturnType<typeof newestDesktopRelease>>> {
  const latest = await client.latestRelease();
  const accepted = latest ? await exactDesktopRelease(latest, client, latest.tag_name) : null;
  if (accepted) {
    if (requestedTag !== "none" && requestedTag !== accepted.release.tag_name) {
      throw new TypeError("steady baseline must match the accepted desktop latest release");
    }
    return accepted;
  }
  if (requestedTag === "none") return null;
  return exactDesktopRelease(
    releases.find((release) => release.tag_name === requestedTag),
    client,
    requestedTag,
  );
}

async function resolvedBaselineForManifest(
  manifest: DesktopReleaseManifest,
  client: GithubClient,
): Promise<Awaited<ReturnType<typeof newestDesktopRelease>>> {
  requireSteadyReleaseAuthority(manifest.mode);
  const releases = await client.releases();
  const latest = await client.latestRelease();
  if (latest?.tag_name === manifest.tag) {
    return exactDesktopRelease(
      releases.find((release) => release.tag_name === manifest.baselineTag),
      client,
      manifest.baselineTag,
    );
  }
  return steadyDesktopBaseline(releases, client, manifest.baselineTag);
}

function hasFinalReleaseBody(
  release: Pick<GithubRelease, "body">,
  manifest: DesktopReleaseManifest,
): boolean {
  return sha256(Buffer.from(release.body, "utf8")) === manifest.draftBodySha256;
}

function hasRecoverablePublicBody(
  release: Pick<GithubRelease, "body">,
  manifest: DesktopReleaseManifest,
): boolean {
  return (
    release.body === DESKTOP_PROVISIONAL_RELEASE_BODY || hasFinalReleaseBody(release, manifest)
  );
}

async function verifyRecoverableReleaseBinding(
  client: GithubClient,
  manifest: DesktopReleaseManifest,
): Promise<GithubRelease> {
  const release = await client.release(manifest.draftId);
  if (
    String(release.id) !== manifest.draftId ||
    release.prerelease ||
    release.tag_name !== manifest.tag
  ) {
    throw new TypeError("GitHub recoverable candidate binding mismatch");
  }
  if ((await client.tagCommit(manifest.tag)) !== manifest.commit) {
    throw new TypeError("Git tag commit binding mismatch");
  }
  if (release.draft) {
    if (sha256(Buffer.from(release.body, "utf8")) !== manifest.draftBodySha256) {
      throw new TypeError("GitHub recoverable draft body binding mismatch");
    }
  } else if (!hasRecoverablePublicBody(release, manifest)) {
    throw new TypeError("GitHub recoverable public body binding mismatch");
  }
  return release;
}

async function verifyReleaseBinding(
  client: GithubClient,
  manifest: DesktopReleaseManifest,
): Promise<GithubRelease> {
  const release = await client.release(manifest.draftId);
  if (
    String(release.id) !== manifest.draftId ||
    !release.draft ||
    release.prerelease ||
    release.tag_name !== manifest.tag
  )
    throw new TypeError("GitHub draft binding mismatch");
  if (sha256(Buffer.from(release.body, "utf8")) !== manifest.draftBodySha256)
    throw new TypeError("GitHub draft body binding mismatch");
  if ((await client.tagCommit(manifest.tag)) !== manifest.commit)
    throw new TypeError("Git tag commit binding mismatch");
  return release;
}

async function preflightReleaseAssets(
  client: GithubClient,
  release: GithubRelease,
  manifest: DesktopReleaseManifest,
): Promise<readonly GithubAsset[]> {
  const starters: GithubAsset[] = [];
  for (const file of manifest.files) {
    const asset = release.assets.find((candidate) => candidate.name === file.name);
    if (!asset) continue;
    if (asset.state === "starter") {
      if (!release.draft) throw new TypeError(`starter asset exists outside a draft: ${file.name}`);
      starters.push(asset);
      continue;
    }
    if (asset.state !== "uploaded")
      throw new TypeError(`release asset state is invalid: ${file.name}`);
    const remote = await client.bytes(asset.url);
    assertRemoteAsset(file, remote);
  }
  return starters;
}

async function uploadWithRecovery(
  client: GithubClient,
  release: GithubRelease,
  directory: string,
  manifest: DesktopReleaseManifest,
  file: DesktopReleaseFile,
): Promise<void> {
  const local = await stableFile(resolve(directory, file.name));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const uploaded = await client.uploadAsset(release, file.name, local.bytes);
      if (uploaded.state !== "uploaded")
        throw new TypeError(`uploaded release asset state is invalid: ${file.name}`);
      assertRemoteAsset(file, await client.bytes(uploaded.url));
      return;
    } catch (error) {
      const current = await client.release(release.id);
      if (!current.draft || current.prerelease || current.tag_name !== release.tag_name)
        throw error;
      assertPublishableAssets(current.assets, manifest);
      const observed = current.assets.find((candidate) => candidate.name === file.name);
      if (observed?.state === "uploaded") {
        assertRemoteAsset(file, await client.bytes(observed.url));
        return;
      }
      if (observed?.state === "starter") await client.deleteAsset(observed.id);
      else if (observed) throw error;
      if (attempt === 3) throw error;
    }
  }
}

async function stageExactAssets(
  client: GithubClient,
  release: GithubRelease,
  directory: string,
  manifest: DesktopReleaseManifest,
): Promise<GithubRelease> {
  const starters = await preflightReleaseAssets(client, release, manifest);
  for (const starter of starters) await client.deleteAsset(starter.id);
  const starterNames = new Set(starters.map((asset) => asset.name));
  for (const file of manifest.files) {
    const existing = release.assets.find((asset) => asset.name === file.name);
    if (!existing || starterNames.has(file.name))
      await uploadWithRecovery(client, release, directory, manifest, file);
  }
  const staged = await verifyReleaseBinding(client, manifest);
  assertPublishableAssets(staged.assets, manifest);
  if (macosOwnedAssets(staged.assets, manifest.desktopVersion).length !== manifest.files.length)
    throw new TypeError("staged release asset set is incomplete");
  for (const file of manifest.files) {
    const asset = staged.assets.find((candidate) => candidate.name === file.name);
    if (!asset || asset.state !== "uploaded")
      throw new TypeError(`staged release asset is incomplete: ${file.name}`);
    assertRemoteAsset(file, await client.bytes(asset.url));
  }
  return staged;
}

async function assertCompleteReleaseAssets(
  client: GithubClient,
  release: GithubRelease,
  manifest: DesktopReleaseManifest,
  label: string,
  deadlineAt?: number,
): Promise<void> {
  assertPublishableAssets(release.assets, manifest);
  if (macosOwnedAssets(release.assets, manifest.desktopVersion).length !== manifest.files.length) {
    throw new TypeError(`${label} asset set is incomplete`);
  }
  for (const file of manifest.files) {
    const asset = release.assets.find((candidate) => candidate.name === file.name);
    if (!asset || asset.state !== "uploaded") {
      throw new TypeError(`${label} asset is incomplete: ${file.name}`);
    }
    assertRemoteAsset(file, await client.bytes(asset.url, deadlineAt));
  }
}

export async function publishDesktopRelease(
  directory: string,
  client: GithubClient,
  observedLatest?: LatestObservation,
): Promise<void> {
  const manifest = await verifyDesktopRelease(directory);
  requireSteadyReleaseAuthority(manifest.mode);
  const release = await verifyRecoverableReleaseBinding(client, manifest);
  assertPublishableAssets(release.assets, manifest);
  const baseline = await assertResolvedBaseline(
    manifest,
    await resolvedBaselineForManifest(manifest, client),
    client,
  );
  if (observedLatest === undefined) {
    throw new TypeError("desktop publication requires a bound latest observation");
  }
  assertLatestCas(manifest.desktopVersion, observedLatest, await client.latest(), baseline.version);
  let published = release;
  if (release.draft) {
    await stageExactAssets(client, release, directory, manifest);
    await client.request(`/repos/${client.repository()}/releases/${release.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draft: false,
        make_latest: "false",
        body: DESKTOP_PROVISIONAL_RELEASE_BODY,
      }),
    });
    published = await client.release(release.id);
  }
  if (published.draft || !hasRecoverablePublicBody(published, manifest)) {
    throw new TypeError("desktop release did not enter a recoverable public state");
  }
  await assertCompleteReleaseAssets(client, published, manifest, "published release");
  const releasePropagationDeadline = client.propagationDeadline("release");
  for (const file of manifest.files) {
    const asset = published.assets.find((candidate) => candidate.name === file.name);
    if (!asset) throw new TypeError(`published release asset is missing: ${file.name}`);
    const url = new URL(asset.browser_download_url);
    const parts = url.pathname.split("/").map((part) => decodeURIComponent(part));
    if (!parts.includes(manifest.tag) || parts.at(-1) !== file.name) {
      throw new TypeError(`release asset is not tag-specific: ${file.name}`);
    }
    await waitForAnonymousAsset(
      client,
      asset.browser_download_url,
      file,
      releasePropagationDeadline,
    );
  }
  assertLatestCas(manifest.desktopVersion, observedLatest, await client.latest(), baseline.version);
}

export async function observeDesktopLatest(
  directory: string,
  client: GithubClient,
): Promise<LatestObservation> {
  const manifest = await verifyDesktopRelease(directory);
  requireSteadyReleaseAuthority(manifest.mode);
  const release = await verifyRecoverableReleaseBinding(client, manifest);
  await assertResolvedBaseline(
    manifest,
    await resolvedBaselineForManifest(manifest, client),
    client,
  );
  await assertCompleteReleaseAssets(client, release, manifest, "observed desktop release");
  return client.latest();
}

export async function resolveDesktopRollbackLatest(
  directory: string,
  client: GithubClient,
  baselineMetadataSha256: string,
): Promise<LatestObservation> {
  const manifest = await verifyDesktopRelease(directory);
  requireSteadyReleaseAuthority(manifest.mode);
  const baseline = await assertResolvedBaseline(
    manifest,
    await resolvedBaselineForManifest(manifest, client),
    client,
  );
  if (!sha256HexSchema.safeParse(baselineMetadataSha256).success) {
    throw new TypeError("steady rollback metadata binding is invalid");
  }
  const metadata = baseline.release.assets.find((asset) => asset.name === "latest-mac.yml");
  if (
    !metadata ||
    metadata.state !== "uploaded" ||
    metadata.digest !== `sha256:${baselineMetadataSha256}` ||
    metadata.size <= 0
  ) {
    throw new TypeError("steady rollback metadata asset binding mismatch");
  }
  const bytes = await client.bytes(metadata.url);
  if (bytes.length !== metadata.size || sha256(bytes) !== baselineMetadataSha256) {
    throw new TypeError("steady rollback metadata bytes binding mismatch");
  }
  return {
    id: baseline.release.id,
    tag: baseline.release.tag_name,
    metadataSha256: baselineMetadataSha256,
  };
}

export async function stageDesktopRelease(directory: string, client: GithubClient): Promise<void> {
  const manifest = await verifyDesktopRelease(directory);
  requireSteadyReleaseAuthority(manifest.mode);
  const release = await verifyRecoverableReleaseBinding(client, manifest);
  assertPublishableAssets(release.assets, manifest);
  await assertResolvedBaseline(
    manifest,
    await resolvedBaselineForManifest(manifest, client),
    client,
  );
  if (release.draft) await stageExactAssets(client, release, directory, manifest);
  else await assertCompleteReleaseAssets(client, release, manifest, "resumed public release");
}

export async function promoteDesktopLatest(
  directory: string,
  client: GithubClient,
  observed: LatestObservation,
  transactionDeadlineAt?: number,
): Promise<"applied"> {
  let mutationAttempted = false;
  try {
    const mutationDeadlines = client.latestMutationDeadlines(transactionDeadlineAt);
    const preflightDeadlineAt = Math.min(
      mutationDeadlines.preflightDeadlineAt,
      client.propagationDeadline("release"),
    );
    const manifest = await verifyDesktopRelease(directory);
    requireSteadyReleaseAuthority(manifest.mode);
    const candidate = await client.release(manifest.draftId, preflightDeadlineAt);
    if (candidate.draft || candidate.prerelease || candidate.tag_name !== manifest.tag)
      throw new TypeError("published candidate binding mismatch");
    if (!hasRecoverablePublicBody(candidate, manifest))
      throw new TypeError("published release body is not recoverable");
    const candidateWasFinal = hasFinalReleaseBody(candidate, manifest);
    if ((await client.tagCommit(manifest.tag, preflightDeadlineAt)) !== manifest.commit)
      throw new TypeError("published tag commit binding mismatch");
    const current = await client.latest(preflightDeadlineAt);
    const previous = await newestDesktopRelease(
      await client.releases(preflightDeadlineAt),
      client,
      manifest.tag,
      preflightDeadlineAt,
    );
    assertPromotionLatestCas(manifest.desktopVersion, observed, current, previous?.version ?? null);
    assertPublishableAssets(candidate.assets, manifest);
    if (
      macosOwnedAssets(candidate.assets, manifest.desktopVersion).length !== manifest.files.length
    ) {
      throw new TypeError("promotion candidate asset set is incomplete");
    }
    const releasePropagationDeadline = preflightDeadlineAt;
    for (const file of manifest.files) {
      const asset = candidate.assets.find((candidateAsset) => candidateAsset.name === file.name);
      if (!asset || asset.state !== "uploaded")
        throw new TypeError(`promotion candidate asset is missing: ${file.name}`);
      await waitForAnonymousAsset(
        client,
        asset.browser_download_url,
        file,
        releasePropagationDeadline,
      );
    }
    assertPromotionLatestCas(
      manifest.desktopVersion,
      observed,
      await client.latest(preflightDeadlineAt),
      previous?.version ?? null,
    );
    const rebound = await client.release(candidate.id, preflightDeadlineAt);
    if (
      rebound.draft ||
      rebound.prerelease ||
      rebound.tag_name !== manifest.tag ||
      !hasRecoverablePublicBody(rebound, manifest) ||
      hasFinalReleaseBody(rebound, manifest) !== candidateWasFinal ||
      (await client.tagCommit(manifest.tag, preflightDeadlineAt)) !== manifest.commit
    ) {
      throw new TypeError("promotion candidate changed during final preflight");
    }
    await assertCompleteReleaseAssets(
      client,
      rebound,
      manifest,
      "promotion candidate",
      preflightDeadlineAt,
    );
    for (const file of manifest.files) {
      const asset = rebound.assets.find((entry) => entry.name === file.name);
      if (!asset) throw new TypeError(`promotion candidate asset is missing: ${file.name}`);
      await waitForAnonymousAsset(
        client,
        asset.browser_download_url,
        file,
        releasePropagationDeadline,
      );
    }
    const finalLatest = await client.latest(preflightDeadlineAt);
    assertPromotionLatestCas(
      manifest.desktopVersion,
      observed,
      finalLatest,
      previous?.version ?? null,
    );
    const metadata = manifest.files.find((file) => file.name === "latest-mac.yml");
    if (!metadata) throw new TypeError("desktop latest metadata is missing");
    const promotedLatest = {
      id: rebound.id,
      tag: manifest.tag,
      metadataSha256: metadata.sha256,
    };
    if (candidateWasFinal) {
      if (!sameLatest(finalLatest, promotedLatest)) {
        throw new TypeError("final desktop release is not the stable latest release");
      }
      return "applied";
    }
    mutationAttempted = true;
    try {
      await client.request(
        `/repos/${client.repository()}/releases/${rebound.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ make_latest: "true" }),
        },
        mutationDeadlines.requestDeadlineAt,
      );
    } catch {
      await reconcilePromotionMutation(
        client,
        finalLatest,
        promotedLatest,
        mutationDeadlines.reconciliationDeadlineAt,
      );
    }
    return "applied";
  } catch (error) {
    if (error instanceof DesktopLatestPromotionOutcomeError) throw error;
    throw new DesktopLatestPromotionOutcomeError(
      mutationAttempted ? "unknown" : "unapplied",
      error instanceof Error ? error.message : "desktop latest promotion failed",
      { cause: error },
    );
  }
}

export async function reconcileDesktopLatest(
  directory: string,
  client: GithubClient,
): Promise<void> {
  const manifest = await verifyDesktopRelease(directory);
  requireSteadyReleaseAuthority(manifest.mode);
  const candidate = await client.release(manifest.draftId);
  if (
    candidate.draft ||
    candidate.prerelease ||
    candidate.tag_name !== manifest.tag ||
    !hasRecoverablePublicBody(candidate, manifest) ||
    (await client.tagCommit(manifest.tag)) !== manifest.commit
  ) {
    throw new TypeError("desktop latest reconciliation candidate binding mismatch");
  }
  assertPublishableAssets(candidate.assets, manifest);
  if (
    macosOwnedAssets(candidate.assets, manifest.desktopVersion).length !== manifest.files.length
  ) {
    throw new TypeError("desktop latest reconciliation asset set is incomplete");
  }
  const metadata = manifest.files.find((file) => file.name === "latest-mac.yml");
  if (!metadata) throw new TypeError("desktop latest metadata is missing");
  await waitForLatest(
    client,
    { id: candidate.id, tag: manifest.tag, metadataSha256: metadata.sha256 },
    "desktop latest reconciliation did not converge",
  );
}

async function readFinalReleaseBody(
  path: string,
  manifest: DesktopReleaseManifest,
): Promise<string> {
  const snapshot = await stableFile(path);
  const body = snapshot.bytes.toString("utf8");
  if (
    !Buffer.from(body, "utf8").equals(snapshot.bytes) ||
    sha256(snapshot.bytes) !== manifest.draftBodySha256
  ) {
    throw new TypeError("final release body binding mismatch");
  }
  return body;
}

function sameLatest(left: LatestObservation, right: LatestObservation): boolean {
  return (
    left.id === right.id && left.tag === right.tag && left.metadataSha256 === right.metadataSha256
  );
}

function sameLatestIdentity(left: LatestObservation, right: LatestObservation): boolean {
  return left.id === right.id && left.tag === right.tag;
}

function assertPromotionLatestCas(
  candidateVersion: string,
  observed: LatestObservation,
  current: LatestObservation,
  previousDesktopVersion: string | null,
): void {
  try {
    assertLatestCas(candidateVersion, observed, current, previousDesktopVersion);
  } catch (error) {
    throw new DesktopLatestPromotionOutcomeError(
      "foreign",
      error instanceof Error ? error.message : "desktop latest compare-and-swap failed",
      { cause: error },
    );
  }
}

function latestPollBudget(client: GithubClient, deadlineAt?: number): LatestPollBudget {
  return {
    remaining: latestReleasePropagationAttempts,
    deadlineAt: Math.min(
      deadlineAt ?? Number.POSITIVE_INFINITY,
      client.propagationDeadline("latest"),
    ),
  };
}

async function reconcilePromotionMutation(
  client: GithubClient,
  before: LatestObservation,
  after: LatestObservation,
  deadlineAt?: number,
): Promise<"applied"> {
  const budget = latestPollBudget(client, deadlineAt);
  let lastObserved: LatestObservation | null = null;
  let stableAfterCount = 0;
  let stableBeforeCount = 0;
  let lastPollSucceeded = false;
  while (budget.remaining > 0 && client.now() < budget.deadlineAt) {
    budget.remaining -= 1;
    let current: LatestObservation;
    try {
      current = await client.latest(budget.deadlineAt);
    } catch {
      lastPollSucceeded = false;
      stableAfterCount = 0;
      stableBeforeCount = 0;
      if (budget.remaining > 0 && client.now() < budget.deadlineAt) {
        await client.pauseForPropagation("latest", budget.deadlineAt);
      }
      continue;
    }
    lastPollSucceeded = true;
    lastObserved = current;
    if (sameLatest(current, after)) {
      stableAfterCount += 1;
      stableBeforeCount = 0;
      if (stableAfterCount >= stableLatestObservationCount) return "applied";
    } else if (sameLatest(current, before)) {
      stableAfterCount = 0;
      stableBeforeCount += 1;
    } else if (sameLatestIdentity(current, before)) {
      stableAfterCount = 0;
      stableBeforeCount = 0;
    } else if (sameLatestIdentity(current, after)) {
      stableAfterCount = 0;
      stableBeforeCount = 0;
    } else {
      throw new DesktopLatestPromotionOutcomeError(
        "foreign",
        "desktop latest promotion observed a foreign latest release",
      );
    }
    if (budget.remaining > 0 && client.now() < budget.deadlineAt) {
      await client.pauseForPropagation("latest", budget.deadlineAt);
    }
  }
  if (
    lastPollSucceeded &&
    lastObserved !== null &&
    sameLatest(lastObserved, before) &&
    stableBeforeCount >= stableLatestObservationCount
  ) {
    throw new DesktopLatestPromotionOutcomeError(
      "unapplied",
      "desktop latest promotion was not applied",
    );
  }
  throw new DesktopLatestPromotionOutcomeError(
    "unknown",
    "desktop latest promotion outcome could not be reconciled",
  );
}

async function waitForAnonymousAsset(
  client: GithubClient,
  url: string,
  file: DesktopReleaseFile,
  deadlineAt: number = client.propagationDeadline("release"),
): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= releasePropagationAttempts && client.now() < deadlineAt;
    attempt += 1
  ) {
    try {
      assertRemoteAsset(file, await client.anonymousBytes(url, deadlineAt));
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof TypeError && error.message.startsWith("conflicting release asset:")) {
        throw error;
      }
      if (attempt < releasePropagationAttempts && client.now() < deadlineAt) {
        await client.pauseForPropagation("release", deadlineAt);
      }
    }
  }
  throw new TypeError(`tag-specific release download did not converge: ${file.name}`, {
    cause: lastError,
  });
}

async function waitForLatest(
  client: GithubClient,
  expected: LatestObservation | readonly LatestObservation[],
  message: string,
  budget: LatestPollBudget = latestPollBudget(client),
): Promise<LatestObservation> {
  const accepted = Array.isArray(expected) ? expected : [expected];
  let lastError: unknown;
  let stableObservation: LatestObservation | null = null;
  let stableCount = 0;
  while (budget.remaining > 0 && client.now() < budget.deadlineAt) {
    budget.remaining -= 1;
    try {
      const current = await client.latest(budget.deadlineAt);
      const matched = accepted.some((candidate) => sameLatest(candidate, current));
      if (matched) {
        if (stableObservation !== null && sameLatest(stableObservation, current)) {
          stableCount += 1;
        } else {
          stableObservation = current;
          stableCount = 1;
        }
        if (stableCount >= stableLatestObservationCount) return current;
        lastError = new TypeError("repository latest has not remained stable long enough");
      } else {
        stableObservation = null;
        stableCount = 0;
        lastError = new TypeError("repository latest does not match the expected release");
      }
    } catch (error) {
      stableObservation = null;
      stableCount = 0;
      lastError = error;
    }
    if (budget.remaining > 0 && client.now() < budget.deadlineAt) {
      await client.pauseForPropagation("latest", budget.deadlineAt);
    }
  }
  throw new TypeError(message, { cause: lastError });
}

function requireObservedLatest(value: LatestObservation): LatestObservation {
  if (
    (value.id === null) !== (value.tag === null) ||
    (value.id !== null && (!Number.isSafeInteger(value.id) || value.id <= 0)) ||
    (value.tag !== null && !/^[-A-Za-z0-9@._]+$/u.test(value.tag)) ||
    (value.id === null && value.metadataSha256 !== null) ||
    (value.metadataSha256 !== null && !/^[0-9a-f]{64}$/u.test(value.metadataSha256))
  ) {
    throw new TypeError("observed latest release is invalid");
  }
  return value;
}

export async function activateDesktopRelease(
  directory: string,
  bodyPath: string,
  client: GithubClient,
): Promise<void> {
  const manifest = await verifyDesktopRelease(directory);
  requireSteadyReleaseAuthority(manifest.mode);
  const finalBody = await readFinalReleaseBody(bodyPath, manifest);
  const candidate = await client.release(manifest.draftId);
  if (
    candidate.draft ||
    candidate.prerelease ||
    candidate.tag_name !== manifest.tag ||
    !hasRecoverablePublicBody(candidate, manifest) ||
    (await client.tagCommit(manifest.tag)) !== manifest.commit
  ) {
    throw new TypeError("desktop activation candidate binding mismatch");
  }
  assertPublishableAssets(candidate.assets, manifest);
  if (
    macosOwnedAssets(candidate.assets, manifest.desktopVersion).length !== manifest.files.length
  ) {
    throw new TypeError("desktop activation asset set is incomplete");
  }
  for (const file of manifest.files) {
    const asset = candidate.assets.find((entry) => entry.name === file.name);
    if (!asset || asset.state !== "uploaded") {
      throw new TypeError(`desktop activation asset is incomplete: ${file.name}`);
    }
    assertRemoteAsset(file, await client.anonymousBytes(asset.browser_download_url));
  }
  const metadata = manifest.files.find((file) => file.name === "latest-mac.yml");
  if (!metadata) throw new TypeError("desktop activation latest metadata is missing");
  const expectedLatest = {
    id: candidate.id,
    tag: manifest.tag,
    metadataSha256: metadata.sha256,
  };
  const pollBudget = latestPollBudget(client);
  const latest = await waitForLatest(
    client,
    expectedLatest,
    "desktop activation latest state did not converge",
    pollBudget,
  );
  if (
    latest.id !== candidate.id ||
    latest.tag !== manifest.tag ||
    latest.metadataSha256 !== metadata.sha256
  ) {
    throw new TypeError("desktop activation latest binding mismatch");
  }
  const mutationCandidate = await client.release(candidate.id);
  if (
    mutationCandidate.draft ||
    mutationCandidate.prerelease ||
    mutationCandidate.tag_name !== manifest.tag ||
    mutationCandidate.body !== candidate.body ||
    !hasRecoverablePublicBody(mutationCandidate, manifest) ||
    (await client.tagCommit(manifest.tag)) !== manifest.commit
  ) {
    throw new TypeError("desktop activation candidate changed at the mutation boundary");
  }
  assertPublishableAssets(mutationCandidate.assets, manifest);
  if (
    macosOwnedAssets(mutationCandidate.assets, manifest.desktopVersion).length !==
      manifest.files.length ||
    !sameLatest(expectedLatest, await client.latest())
  ) {
    throw new TypeError("desktop activation candidate changed at the mutation boundary");
  }
  if (!hasFinalReleaseBody(mutationCandidate, manifest)) {
    await client.request(`/repos/${client.repository()}/releases/${candidate.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: finalBody }),
    });
  }
  const activated = await client.release(candidate.id);
  if (
    activated.draft ||
    activated.prerelease ||
    activated.tag_name !== manifest.tag ||
    activated.body !== finalBody ||
    sha256(Buffer.from(activated.body, "utf8")) !== manifest.draftBodySha256 ||
    !sameLatest(
      latest,
      await waitForLatest(
        client,
        expectedLatest,
        "desktop activation latest state changed during body activation",
        pollBudget,
      ),
    )
  ) {
    throw new TypeError("desktop release body activation did not round-trip");
  }
}

export async function compensateDesktopRelease(
  directory: string,
  bodyPath: string,
  client: GithubClient,
  rawObserved: LatestObservation,
): Promise<void> {
  const manifest = await verifyDesktopRelease(directory);
  requireSteadyReleaseAuthority(manifest.mode);
  const finalBody = await readFinalReleaseBody(bodyPath, manifest);
  const observed = requireObservedLatest(rawObserved);
  let candidate = await client.release(manifest.draftId);
  if (
    candidate.prerelease ||
    candidate.tag_name !== manifest.tag ||
    (!candidate.draft && !hasRecoverablePublicBody(candidate, manifest))
  ) {
    throw new TypeError("desktop compensation candidate binding mismatch");
  }
  if (candidate.draft) {
    const current = await waitForLatest(
      client,
      observed,
      "desktop compensation draft latest state did not converge",
    );
    if (candidate.body !== finalBody || !sameLatest(observed, current)) {
      throw new TypeError("desktop compensation draft state is invalid");
    }
    return;
  }
  if ((await client.tagCommit(manifest.tag)) !== manifest.commit) {
    throw new TypeError("desktop compensation tag binding mismatch");
  }
  const metadata = manifest.files.find((file) => file.name === "latest-mac.yml");
  if (!metadata) throw new TypeError("desktop compensation latest metadata is missing");
  const candidateLatest = {
    id: candidate.id,
    tag: manifest.tag,
    metadataSha256: metadata.sha256,
  };
  const pollBudget = latestPollBudget(client);
  await waitForLatest(
    client,
    candidateLatest,
    "desktop compensation requires a reconciled candidate latest state",
    pollBudget,
  );
  const resolveRollback = async (): Promise<LatestObservation> => {
    const rebound = await resolveDesktopRollbackLatest(
      directory,
      client,
      observed.metadataSha256 ?? "none",
    );
    if (!sameLatest(rebound, observed)) {
      throw new TypeError("desktop compensation rollback target binding mismatch");
    }
    return rebound;
  };
  await resolveRollback();
  await waitForLatest(
    client,
    candidateLatest,
    "desktop compensation candidate changed during rollback preflight",
    pollBudget,
  );
  await resolveRollback();
  let previous: GithubRelease | null = null;
  if (observed.id !== null) {
    previous = await client.release(observed.id);
    if (previous.draft || previous.prerelease || previous.tag_name !== observed.tag) {
      throw new TypeError("desktop compensation previous latest binding mismatch");
    }
  }
  candidate = await client.release(candidate.id);
  if (
    candidate.draft ||
    candidate.prerelease ||
    candidate.tag_name !== manifest.tag ||
    !hasRecoverablePublicBody(candidate, manifest) ||
    (await client.tagCommit(manifest.tag)) !== manifest.commit
  ) {
    throw new TypeError("desktop compensation candidate changed at the mutation boundary");
  }
  assertPublishableAssets(candidate.assets, manifest);
  if (
    macosOwnedAssets(candidate.assets, manifest.desktopVersion).length !== manifest.files.length
  ) {
    throw new TypeError("desktop compensation candidate changed at the mutation boundary");
  }
  if (!sameLatest(candidateLatest, await client.latest())) {
    throw new TypeError("desktop compensation latest changed at the mutation boundary");
  }
  if (previous !== null) {
    await client.request(`/repos/${client.repository()}/releases/${previous.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ make_latest: "true" }),
    });
    await waitForLatest(
      client,
      observed,
      "desktop compensation latest restoration failed",
      pollBudget,
    );
  }
  candidate = await client.release(candidate.id);
  if (
    candidate.draft ||
    candidate.prerelease ||
    candidate.tag_name !== manifest.tag ||
    !hasRecoverablePublicBody(candidate, manifest) ||
    (await client.tagCommit(manifest.tag)) !== manifest.commit
  ) {
    throw new TypeError("desktop compensation candidate changed before withdrawal");
  }
  assertPublishableAssets(candidate.assets, manifest);
  if (
    macosOwnedAssets(candidate.assets, manifest.desktopVersion).length !== manifest.files.length
  ) {
    throw new TypeError("desktop compensation candidate changed before withdrawal");
  }
  await client.request(`/repos/${client.repository()}/releases/${candidate.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: true, make_latest: "false", body: finalBody }),
  });
  candidate = await client.release(candidate.id);
  const restored = await waitForLatest(
    client,
    observed,
    "desktop compensation latest state did not converge",
    pollBudget,
  );
  if (!candidate.draft || candidate.body !== finalBody || !sameLatest(observed, restored)) {
    throw new TypeError("desktop compensation did not round-trip");
  }
}

export async function prepareDesktopBaseline(
  directory: string,
  client: GithubClient,
  mode: unknown,
  candidateTag: string,
  candidateVersion: string,
  requestedBaselineTag: string,
  output: string,
): Promise<void> {
  const version = requireDesktopVersion(candidateVersion);
  if (candidateTag !== desktopTag(version)) {
    throw new TypeError("candidate desktop release tag and version do not match");
  }
  requireSteadyReleaseAuthority(mode);
  const releases = await client.releases();
  const baseline = await steadyDesktopBaseline(releases, client, requestedBaselineTag);
  if (baseline === null) throw new TypeError("steady release requires a desktop baseline");
  if (compareVersions(baseline.version, version) >= 0)
    throw new TypeError("steady desktop baseline must precede the candidate version");
  await mkdir(directory, { recursive: true });
  const names = releaseFileNames(baseline.version);
  let zipSha256 = "";
  let zipPath = "";
  let metadataSha256 = "";
  for (const name of names) {
    const asset = baseline.release.assets.find((candidate) => candidate.name === name);
    if (!asset) throw new TypeError(`desktop baseline asset is missing: ${name}`);
    const bytes = await client.bytes(asset.url);
    if (bytes.length !== asset.size || bytes.length === 0) {
      throw new TypeError(`desktop baseline asset is invalid: ${name}`);
    }
    const path = resolve(directory, name);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    if (name === names[1]) {
      zipSha256 = sha256(bytes);
      zipPath = path;
    }
    if (name === "latest-mac.yml") metadataSha256 = sha256(bytes);
  }
  await writeFile(
    output,
    `baseline_tag=${baseline.release.tag_name}\nbaseline_version=${baseline.version}\nbaseline_release_id=${baseline.release.id}\nbaseline_commit=${baseline.commit}\nbaseline_zip_sha256=${zipSha256}\nbaseline_metadata_sha256=${metadataSha256}\nbaseline_zip=${zipPath}\n`,
    { flag: "a" },
  );
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`missing --${name}`);
  return value;
}

function bindingArguments(): Parameters<typeof requireBinding>[0] {
  return {
    tag: argument("tag"),
    desktopVersion: argument("desktop-version"),
    commit: argument("commit"),
    draftId: argument("draft-id"),
    mode: argument("mode"),
    workflowRunId: argument("workflow-run-id"),
    workflowRunAttempt: argument("workflow-run-attempt"),
    draftBodySha256: argument("draft-body-sha256"),
    signingIdentity: argument("signing-identity"),
    candidateCdHash: argument("candidate-cdhash"),
    candidateCodeDirectorySha256: argument("candidate-code-directory-sha256"),
    baselineTag: argument("baseline-tag"),
    baselineReleaseId: argument("baseline-release-id"),
    baselineCommit: argument("baseline-commit"),
    baselineZipSha256: argument("baseline-zip-sha256"),
    baselineSigningIdentity: argument("baseline-signing-identity"),
    baselineCdHash: argument("baseline-cdhash"),
  };
}

function latestArguments(): LatestObservation {
  const id = argument("expected-latest-id");
  const tag = argument("expected-latest-tag");
  const metadataSha256 = argument("expected-latest-metadata-sha256");
  if (id !== "none" && !/^[1-9]\d*$/u.test(id)) {
    throw new TypeError("expected latest id is invalid");
  }
  if (tag !== "none" && !/^[-A-Za-z0-9@._]+$/u.test(tag)) {
    throw new TypeError("expected latest tag is invalid");
  }
  if ((id === "none") !== (tag === "none")) {
    throw new TypeError("expected latest release is incomplete");
  }
  if (id === "none" && metadataSha256 !== "none") {
    throw new TypeError("expected latest metadata has no release");
  }
  if (metadataSha256 !== "none" && !/^[0-9a-f]{64}$/u.test(metadataSha256)) {
    throw new TypeError("expected latest metadata hash is invalid");
  }
  return {
    id: id === "none" ? null : Number(id),
    tag: tag === "none" ? null : tag,
    metadataSha256: metadataSha256 === "none" ? null : metadataSha256,
  };
}

function transactionDeadlineArgument(): number {
  const value = argument("transaction-deadline-ms");
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new TypeError("desktop latest transaction deadline is invalid");
  }
  const deadlineAt = Number(value);
  if (!Number.isSafeInteger(deadlineAt)) {
    throw new TypeError("desktop latest transaction deadline is invalid");
  }
  return deadlineAt;
}

async function writeLatestOutput(
  output: string,
  observed: LatestObservation,
  rollback: LatestObservation,
): Promise<void> {
  await writeFile(
    output,
    `latest_id=${observed.id ?? "none"}\nlatest_tag=${observed.tag ?? "none"}\nlatest_metadata_sha256=${observed.metadataSha256 ?? "none"}\nrollback_latest_id=${rollback.id ?? "none"}\nrollback_latest_tag=${rollback.tag ?? "none"}\nrollback_latest_metadata_sha256=${rollback.metadataSha256 ?? "none"}\n`,
    { flag: "a" },
  );
}

async function writePromotionOutcome(
  output: string,
  outcome: DesktopLatestPromotionOutcome,
): Promise<void> {
  await writeFile(output, `promotion_outcome=${outcome}\n`, { flag: "a" });
}

export async function runDesktopLatestPromotionWithOutput(
  output: string,
  promote: () => Promise<"applied">,
): Promise<"applied"> {
  let outcome: DesktopLatestPromotionOutcome = "unknown";
  try {
    outcome = await promote();
  } catch (error) {
    if (error instanceof DesktopLatestPromotionOutcomeError) outcome = error.outcome;
    await writePromotionOutcome(output, outcome);
    throw error;
  }
  await writePromotionOutcome(output, outcome);
  return outcome;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "verify-npm-provenance") {
    const metadata = JSON.parse(await readFile(resolve(argument("metadata")), "utf8")) as unknown;
    const { verify: verifySigstore } = await import("sigstore");
    await verifyNpmProvenanceBundle(
      metadata,
      {
        name: argument("name"),
        version: requireNpmVersion(argument("version")),
        integrity: argument("integrity"),
        repository: argument("repository"),
        workflow: argument("workflow"),
        ref: argument("ref"),
        workflowCommit: argument("workflow-commit"),
        invocationId: argument("invocation-id"),
        allowPriorInvocation: argument("allow-prior-invocation") === "true",
        releaseTag: argument("release-tag"),
        eventName: argument("event-name"),
        repositoryId: argument("repository-id"),
        repositoryOwnerId: argument("repository-owner-id"),
      },
      async (bundle, identity) => {
        const escapedIdentity = identity.uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        await verifySigstore(bundle as Parameters<typeof verifySigstore>[0], {
          certificateIssuer: identity.issuer,
          certificateIdentityURI: `^${escapedIdentity}$`,
        });
      },
    );
    return;
  }
  const directory = resolve(argument("directory"));
  if (command === "seal") {
    await sealDesktopRelease(directory, bindingArguments());
    return;
  }
  if (command === "verify") {
    await verifyDesktopRelease(directory, bindingArguments());
    return;
  }
  if (command === "public-envelope") {
    await materializeDesktopPublicEnvelope(directory, resolve(argument("output")));
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const client = new GithubClient(repository, token);
  if (command === "baseline") {
    await prepareDesktopBaseline(
      directory,
      client,
      argument("mode"),
      argument("candidate-tag"),
      requireDesktopVersion(argument("candidate-version")),
      argument("baseline-tag"),
      argument("github-output"),
    );
    return;
  }
  if (command === "observe") {
    const observed = await observeDesktopLatest(directory, client);
    const rollback = await resolveDesktopRollbackLatest(
      directory,
      client,
      argument("baseline-metadata-sha256"),
    );
    await writeLatestOutput(argument("github-output"), observed, rollback);
    return;
  }
  if (command === "publish") {
    await publishDesktopRelease(directory, client, latestArguments());
    return;
  }
  if (command === "stage") {
    await stageDesktopRelease(directory, client);
    return;
  }
  if (command === "promote") {
    await runDesktopLatestPromotionWithOutput(argument("github-output"), () =>
      promoteDesktopLatest(directory, client, latestArguments(), transactionDeadlineArgument()),
    );
    return;
  }
  if (command === "reconcile") {
    await reconcileDesktopLatest(directory, client);
    return;
  }
  if (command === "activate") {
    await activateDesktopRelease(directory, resolve(argument("body-file")), client);
    return;
  }
  if (command === "compensate") {
    await compensateDesktopRelease(
      directory,
      resolve(argument("body-file")),
      client,
      latestArguments(),
    );
    return;
  }
  throw new TypeError(
    "desktop release command must be verify-npm-provenance, seal, verify, public-envelope, baseline, stage, observe, publish, promote, reconcile, activate, or compensate",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "desktop release transaction failed"}\n`,
    );
    process.exitCode = 1;
  });
}
