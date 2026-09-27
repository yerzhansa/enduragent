import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { canonicalJson, toHex, type ArchiveManager } from "@enduragent/kernel/archive";
import {
  parseReferenceCaptureManifest,
  serializeReferenceCaptureManifest,
  validateReferenceCaptureManifest,
  type ReferenceCaptureManifest,
  type SnapshotRef,
} from "@enduragent/kernel/reference/capture";
import {
  classifyPrivatePathDurability,
  classifyPrivatePathErrorCode,
  decidePrivatePathBinding,
  decidePrivatePathEntry,
  decidePrivatePathRead,
  type CryptoPort,
  type PrivatePathEntryType,
  type PrivatePathPolicyDecision,
  type PrivatePathPolicyErrorCategory,
} from "@enduragent/kernel/ports";
import { z } from "zod";
import { ensurePrivateDirectory, nodeFileSystem } from "../filesystem/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_PATH = /^[0-9]{4}\/[0-9]{2}\/[0-9a-f]{64}\.json\.gz$/;

export const MAX_REFERENCE_CAPTURE_SIDECAR_BYTES = 67_108_864;

export type WindowsReferenceCaptureSidecarStage =
  | "entry-check"
  | "binding-check"
  | "read-check"
  | "content-write"
  | "file-flush"
  | "rename";

export class WindowsReferenceCaptureSidecarError extends Error {
  override readonly name = "WindowsReferenceCaptureSidecarError";
  readonly stage: WindowsReferenceCaptureSidecarStage;
  readonly category: PrivatePathPolicyErrorCategory;

  constructor(stage: WindowsReferenceCaptureSidecarStage, category: PrivatePathPolicyErrorCategory) {
    super("Windows Reference capture sidecar policy failed");
    this.stage = stage;
    this.category = category;
  }
}

type CapturePathMetadata = Awaited<ReturnType<typeof lstat>>;

interface CapturePathIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface CaptureDirectoryBinding {
  readonly path: string;
  readonly parentPath: string;
  readonly identity: CapturePathIdentity;
  readonly parentIdentity: CapturePathIdentity;
}

function captureErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function captureFailure(
  stage: WindowsReferenceCaptureSidecarStage,
  error: unknown,
): WindowsReferenceCaptureSidecarError {
  if (error instanceof WindowsReferenceCaptureSidecarError) return error;
  return new WindowsReferenceCaptureSidecarError(
    stage,
    classifyPrivatePathErrorCode(captureErrorCode(error)),
  );
}

function assertCaptureDecision(
  stage: WindowsReferenceCaptureSidecarStage,
  decision: PrivatePathPolicyDecision,
): void {
  if (decision.kind === "reject") {
    throw new WindowsReferenceCaptureSidecarError(stage, decision.category);
  }
}

function captureEntryType(metadata: CapturePathMetadata): PrivatePathEntryType {
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  return "other";
}

function capturePathIdentity(metadata: CapturePathMetadata): CapturePathIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameCapturePathIdentity(left: CapturePathIdentity, right: CapturePathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertCaptureDirectoryEntry(metadata: CapturePathMetadata): void {
  assertCaptureDecision("entry-check", decidePrivatePathEntry({
    expectedType: "directory",
    actualType: captureEntryType(metadata),
    linkOrReparseShaped: metadata.isSymbolicLink(),
  }));
}

function assertCaptureFileEntry(metadata: CapturePathMetadata): void {
  assertCaptureDecision("entry-check", decidePrivatePathEntry({
    expectedType: "file",
    actualType: captureEntryType(metadata),
    linkOrReparseShaped: metadata.isSymbolicLink(),
  }));
  assertCaptureDecision("binding-check", decidePrivatePathBinding({
    identityStable: true,
    authenticatedHomeBinding: metadata.nlink === 1,
  }));
}

async function observeCaptureDirectoryBinding(
  parentPath: string,
  path: string,
): Promise<CaptureDirectoryBinding> {
  const parentBefore = await lstat(parentPath);
  const parentPhysicalPath = await realpath(parentPath);
  const parentPhysical = await lstat(parentPhysicalPath);
  const parentAfter = await lstat(parentPath);
  const before = await lstat(path);
  const physicalPath = await realpath(path);
  const physical = await lstat(physicalPath);
  const after = await lstat(path);
  const physicalParent = await lstat(dirname(physicalPath));
  for (const metadata of [parentBefore, parentPhysical, parentAfter, before, physical, after]) {
    assertCaptureDirectoryEntry(metadata);
  }
  assertCaptureDirectoryEntry(physicalParent);
  const parentIdentity = capturePathIdentity(parentBefore);
  const identity = capturePathIdentity(before);
  assertCaptureDecision("binding-check", decidePrivatePathBinding({
    identityStable:
      sameCapturePathIdentity(parentIdentity, capturePathIdentity(parentPhysical)) &&
      sameCapturePathIdentity(parentIdentity, capturePathIdentity(parentAfter)) &&
      sameCapturePathIdentity(identity, capturePathIdentity(physical)) &&
      sameCapturePathIdentity(identity, capturePathIdentity(after)),
    authenticatedHomeBinding: sameCapturePathIdentity(
      parentIdentity,
      capturePathIdentity(physicalParent),
    ),
  }));
  return { path, parentPath, identity, parentIdentity };
}

async function bindCaptureDirectory(
  parentPath: string,
  path: string,
): Promise<CaptureDirectoryBinding> {
  try {
    return await observeCaptureDirectoryBinding(parentPath, path);
  } catch (error) {
    throw captureFailure("binding-check", error);
  }
}

async function assertCaptureDirectoryStable(binding: CaptureDirectoryBinding): Promise<void> {
  try {
    const observed = await observeCaptureDirectoryBinding(binding.parentPath, binding.path);
    assertCaptureDecision("binding-check", decidePrivatePathBinding({
      identityStable:
        sameCapturePathIdentity(binding.identity, observed.identity) &&
        sameCapturePathIdentity(binding.parentIdentity, observed.parentIdentity),
      authenticatedHomeBinding: true,
    }));
  } catch (error) {
    throw captureFailure("binding-check", error);
  }
}

async function assertCaptureFileBinding(
  directory: CaptureDirectoryBinding,
  path: string,
  expectedIdentity: CapturePathIdentity,
): Promise<CapturePathMetadata> {
  try {
    await assertCaptureDirectoryStable(directory);
    const before = await lstat(path);
    const physicalPath = await realpath(path);
    const physical = await lstat(physicalPath);
    const after = await lstat(path);
    const physicalParent = await lstat(dirname(physicalPath));
    assertCaptureFileEntry(before);
    assertCaptureFileEntry(physical);
    assertCaptureFileEntry(after);
    assertCaptureDirectoryEntry(physicalParent);
    assertCaptureDecision("binding-check", decidePrivatePathBinding({
      identityStable:
        sameCapturePathIdentity(expectedIdentity, capturePathIdentity(before)) &&
        sameCapturePathIdentity(expectedIdentity, capturePathIdentity(physical)) &&
        sameCapturePathIdentity(expectedIdentity, capturePathIdentity(after)),
      authenticatedHomeBinding: sameCapturePathIdentity(
        directory.identity,
        capturePathIdentity(physicalParent),
      ),
    }));
    await assertCaptureDirectoryStable(directory);
    return after;
  } catch (error) {
    throw captureFailure("binding-check", error);
  }
}

function classifyCaptureDirectorySync(): void {
  const classification = classifyPrivatePathDurability({
    platform: "windows",
    stage: "directory-sync",
  });
  if (classification.kind !== "unavailable") {
    throw new WindowsReferenceCaptureSidecarError("file-flush", "io-failure");
  }
}

async function writeWindowsCaptureFile(
  directory: CaptureDirectoryBinding,
  path: string,
  bytes: string,
  dependencies: ReferenceCaptureSidecarDependencies | undefined,
  recordIdentity: (identity: CapturePathIdentity) => void,
): Promise<CapturePathIdentity> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertCaptureDirectoryStable(directory);
    try {
      handle = await (dependencies?.openFile ?? open)(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (error) {
      throw captureFailure("content-write", error);
    }
    const opened = await handle.stat();
    assertCaptureFileEntry(opened);
    const identity = capturePathIdentity(opened);
    await assertCaptureFileBinding(directory, path, identity);
    recordIdentity(identity);
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      throw captureFailure("content-write", error);
    }
    try {
      if (dependencies?.syncFile === undefined) await handle.sync();
      else await dependencies.syncFile(handle);
    } catch (error) {
      throw captureFailure("file-flush", error);
    }
    const flushed = await handle.stat();
    assertCaptureFileEntry(flushed);
    if (flushed.size !== Buffer.byteLength(bytes)) {
      throw new WindowsReferenceCaptureSidecarError("content-write", "corruption");
    }
    assertCaptureDecision("binding-check", decidePrivatePathBinding({
      identityStable: sameCapturePathIdentity(identity, capturePathIdentity(flushed)),
      authenticatedHomeBinding: true,
    }));
    try {
      await handle.close();
      handle = undefined;
    } catch (error) {
      throw captureFailure("file-flush", error);
    }
    await assertCaptureFileBinding(directory, path, identity);
    return identity;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED"))) handle = undefined;
      }
    }
  }
}

async function readWindowsCaptureFile(
  directory: CaptureDirectoryBinding,
  path: string,
  openFile: typeof open = open,
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let buffer: Buffer | undefined;
  try {
    await assertCaptureDirectoryStable(directory);
    const before = await lstat(path);
    assertCaptureFileEntry(before);
    const identity = capturePathIdentity(before);
    handle = await openFile(path, constants.O_RDONLY);
    const opened = await handle.stat();
    assertCaptureFileEntry(opened);
    const bounded = Number.isSafeInteger(opened.size) && opened.size >= 0 &&
      opened.size <= MAX_REFERENCE_CAPTURE_SIDECAR_BYTES;
    assertCaptureDecision("read-check", decidePrivatePathRead({
      bounded,
      identityStable: sameCapturePathIdentity(identity, capturePathIdentity(opened)),
      contentValid: true,
      authenticatedHomeBinding: opened.nlink === 1,
    }));
    buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < opened.size) {
      const result = await handle.read(buffer, offset, opened.size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const probe = await handle.read(buffer, opened.size, 1, opened.size);
    const after = await handle.stat();
    assertCaptureFileEntry(after);
    await handle.close();
    handle = undefined;
    const current = await assertCaptureFileBinding(directory, path, identity);
    assertCaptureDecision("read-check", decidePrivatePathRead({
      bounded: offset === opened.size && probe.bytesRead === 0,
      identityStable:
        sameCapturePathIdentity(identity, capturePathIdentity(after)) &&
        sameCapturePathIdentity(capturePathIdentity(opened), capturePathIdentity(after)) &&
        opened.size === after.size &&
        opened.size === current.size &&
        opened.mtimeMs === after.mtimeMs &&
        opened.mtimeMs === current.mtimeMs &&
        opened.ctimeMs === after.ctimeMs &&
        opened.ctimeMs === current.ctimeMs,
      contentValid: true,
      authenticatedHomeBinding: after.nlink === 1,
    }));
    return new Uint8Array(buffer.subarray(0, opened.size));
  } catch (error) {
    throw captureFailure("read-check", error);
  } finally {
    buffer?.fill(0);
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && (String(error.code) === "EBADF" || String(error.code) === "ERR_DIR_CLOSED"))) handle = undefined;
      }
    }
  }
}

function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

const ReviewSchema = z.object({
  schema_version: z.literal(1),
  capture_id: z.string().regex(UUID),
  reviewed_on: z.string().refine(realDate, "must be a real civil date"),
  replaces_capture_id: z.string().regex(UUID).nullable(),
  reason: z.enum(["initial", "provider-refresh", "schema-change", "capture-invalid", "operator-request"]),
}).strict().superRefine((value, context) => {
  if (value.reason === "initial" && value.replaces_capture_id !== null) {
    context.addIssue({ code: "custom", message: "initial review cannot replace a capture", path: ["replaces_capture_id"] });
  }
  if (value.reason !== "initial" && (value.replaces_capture_id === null || value.replaces_capture_id === value.capture_id)) {
    context.addIssue({ code: "custom", message: "replacement review is invalid", path: ["replaces_capture_id"] });
  }
});

export type ReferenceCaptureReview = z.infer<typeof ReviewSchema>;

export function validateReferenceCaptureReview(value: unknown): ReferenceCaptureReview {
  return ReviewSchema.parse(value);
}

export function serializeReferenceCaptureReview(value: unknown): string {
  return `${canonicalJson(validateReferenceCaptureReview(value))}\n`;
}

export function parseReferenceCaptureReview(bytes: string | Uint8Array): ReferenceCaptureReview {
  let text: string;
  try { text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError("capture review encoding is invalid"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("capture review JSON is invalid"); }
  const value = validateReferenceCaptureReview(parsed);
  if (serializeReferenceCaptureReview(value) !== text) throw new TypeError("capture review bytes are not canonical");
  return value;
}

function validateSnapshotRef(reference: SnapshotRef): void {
  if (reference === null || typeof reference !== "object" || !HEX.test(reference.address)
    || !SNAPSHOT_PATH.test(reference.rel_path)
    || reference.rel_path.split("/").at(-1) !== `${reference.address}.json.gz`) {
    throw new TypeError("Reference snapshot is invalid");
  }
}

export async function readVerifiedReferenceSnapshot(
  reference: SnapshotRef,
  dependencies: { readonly archive: ArchiveManager; readonly crypto: CryptoPort },
): Promise<unknown> {
  validateSnapshotRef(reference);
  const compressed = await dependencies.archive.readArtifact(reference.rel_path);
  if (toHex(await dependencies.crypto.sha256(compressed)) !== reference.address) {
    throw new Error("Reference snapshot address differs");
  }
  let raw: Uint8Array;
  try { raw = new Uint8Array(gunzipSync(compressed)); }
  catch { throw new TypeError("Reference snapshot compression is invalid"); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new TypeError("Reference snapshot encoding is invalid"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("Reference snapshot JSON is invalid"); }
  if (canonicalJson(parsed) !== text) throw new TypeError("Reference snapshot bytes are not canonical");
  return parsed;
}

export type AssertReferenceCaptureReplayable = (manifest: ReferenceCaptureManifest) => Promise<void>;

interface ReferenceCaptureSidecarDependencies {
  readonly beforeRename?: () => void | Promise<void>;
  readonly openFile?: typeof open;
  readonly syncFile?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
}

export interface ReferenceCaptureSidecars {
  readonly manifest: ReferenceCaptureManifest;
  readonly review: ReferenceCaptureReview;
}

function captureDirectory(root: string, captureId: string): string {
  if (typeof root !== "string" || root.length === 0 || !UUID.test(captureId)) {
    throw new TypeError("capture sidecar location is invalid");
  }
  return join(root, "captures", captureId);
}

async function assertCommittedMode(path: string, kind: "directory" | "file", mode: number): Promise<void> {
  const value = await lstat(path);
  if ((kind === "directory" ? !value.isDirectory() : !value.isFile()) || (value.mode & 0o777) !== mode) {
    throw new Error("capture sidecar mode is invalid");
  }
}

export async function loadReferenceCaptureSidecars(input: {
  readonly root: string;
  readonly captureId: string;
  readonly assertReplayable: AssertReferenceCaptureReplayable;
  readonly platform?: NodeJS.Platform;
  readonly openFile?: typeof open;
}): Promise<ReferenceCaptureSidecars> {
  if (typeof input.assertReplayable !== "function") throw new TypeError("capture replay assertion is invalid");
  const captures = join(input.root, "captures");
  const directory = captureDirectory(input.root, input.captureId);
  const manifestPath = join(directory, "manifest.json"), reviewPath = join(directory, "review.json");
  if ((input.platform ?? process.platform) === "win32") {
    const rootBinding = await bindCaptureDirectory(dirname(input.root), input.root);
    const capturesBinding = await bindCaptureDirectory(input.root, captures);
    const directoryBinding = await bindCaptureDirectory(captures, directory);
    let manifest: ReferenceCaptureManifest;
    let review: ReferenceCaptureReview;
    try {
      manifest = parseReferenceCaptureManifest(
        await readWindowsCaptureFile(directoryBinding, manifestPath, input.openFile),
      );
      review = parseReferenceCaptureReview(
        await readWindowsCaptureFile(directoryBinding, reviewPath, input.openFile),
      );
    } catch (error) {
      if (error instanceof WindowsReferenceCaptureSidecarError) throw error;
      throw new WindowsReferenceCaptureSidecarError("read-check", "corruption");
    }
    if (manifest.capture_id !== input.captureId || review.capture_id !== input.captureId) {
      throw new WindowsReferenceCaptureSidecarError("read-check", "corruption");
    }
    await assertCaptureDirectoryStable(directoryBinding);
    await assertCaptureDirectoryStable(capturesBinding);
    await assertCaptureDirectoryStable(rootBinding);
    await input.assertReplayable(manifest);
    return Object.freeze({ manifest, review });
  }
  await assertCommittedMode(captures, "directory", 0o700);
  await assertCommittedMode(directory, "directory", 0o700);
  await assertCommittedMode(manifestPath, "file", 0o444);
  await assertCommittedMode(reviewPath, "file", 0o444);
  const fs = nodeFileSystem();
  const manifest = parseReferenceCaptureManifest(await fs.readFile(manifestPath));
  const review = parseReferenceCaptureReview(await fs.readFile(reviewPath));
  if (manifest.capture_id !== input.captureId || review.capture_id !== input.captureId) {
    throw new Error("capture sidecar IDs disagree");
  }
  await input.assertReplayable(manifest);
  return Object.freeze({ manifest, review });
}

async function assertWindowsCapturePathMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new WindowsReferenceCaptureSidecarError("entry-check", "corruption");
  } catch (error) {
    if (captureErrorCode(error) === "ENOENT") return;
    throw captureFailure("entry-check", error);
  }
}

async function removeWindowsCaptureFile(
  directory: CaptureDirectoryBinding,
  path: string,
  identity: CapturePathIdentity | undefined,
): Promise<void> {
  if (identity === undefined) return;
  await assertCaptureFileBinding(directory, path, identity);
  try {
    await unlink(path);
  } catch (error) {
    throw captureFailure("rename", error);
  }
  await assertCaptureDirectoryStable(directory);
}

async function writeWindowsReferenceCaptureSidecars(
  input: {
    readonly root: string;
    readonly manifest: ReferenceCaptureManifest;
    readonly review: ReferenceCaptureReview;
    readonly assertReplayable: AssertReferenceCaptureReplayable;
  },
  dependencies: ReferenceCaptureSidecarDependencies | undefined,
): Promise<ReferenceCaptureSidecars> {
  const { manifest, review } = input;
  if (review.replaces_capture_id !== null) {
    await loadReferenceCaptureSidecars({
      root: input.root,
      captureId: review.replaces_capture_id,
      assertReplayable: input.assertReplayable,
      platform: "win32",
    });
  }
  const captures = join(input.root, "captures");
  const finalDirectory = captureDirectory(input.root, manifest.capture_id);
  const pendingName = `.pending-${manifest.capture_id}`;
  const pendingDirectory = join(captures, pendingName);
  await ensurePrivateDirectory(input.root, { platform: "win32" });
  await ensurePrivateDirectory(captures, { platform: "win32" });
  const rootBinding = await bindCaptureDirectory(dirname(input.root), input.root);
  const capturesBinding = await bindCaptureDirectory(input.root, captures);
  await assertWindowsCapturePathMissing(finalDirectory);
  await assertWindowsCapturePathMissing(pendingDirectory);

  let createdPending = false;
  let renamed = false;
  let pendingBinding: CaptureDirectoryBinding | undefined;
  let manifestIdentity: CapturePathIdentity | undefined;
  let reviewIdentity: CapturePathIdentity | undefined;
  try {
    try {
      await mkdir(pendingDirectory, { mode: 0o700 });
    } catch (error) {
      throw captureFailure("content-write", error);
    }
    createdPending = true;
    pendingBinding = await bindCaptureDirectory(captures, pendingDirectory);
    const manifestPath = join(pendingDirectory, "manifest.json");
    const reviewPath = join(pendingDirectory, "review.json");
    const manifestBytes = serializeReferenceCaptureManifest(manifest);
    const reviewBytes = serializeReferenceCaptureReview(review);
    if (
      Buffer.byteLength(manifestBytes) > MAX_REFERENCE_CAPTURE_SIDECAR_BYTES ||
      Buffer.byteLength(reviewBytes) > MAX_REFERENCE_CAPTURE_SIDECAR_BYTES
    ) {
      throw new WindowsReferenceCaptureSidecarError("read-check", "corruption");
    }
    manifestIdentity = await writeWindowsCaptureFile(
      pendingBinding,
      manifestPath,
      manifestBytes,
      dependencies,
      (identity) => {
        manifestIdentity = identity;
      },
    );
    reviewIdentity = await writeWindowsCaptureFile(
      pendingBinding,
      reviewPath,
      reviewBytes,
      dependencies,
      (identity) => {
        reviewIdentity = identity;
      },
    );
    try {
      await chmod(manifestPath, 0o444);
      await chmod(reviewPath, 0o444);
    } catch (error) {
      throw captureFailure("content-write", error);
    }
    await assertCaptureFileBinding(pendingBinding, manifestPath, manifestIdentity);
    await assertCaptureFileBinding(pendingBinding, reviewPath, reviewIdentity);
    classifyCaptureDirectorySync();
    await input.assertReplayable(manifest);
    await assertCaptureDirectoryStable(pendingBinding);
    await assertCaptureDirectoryStable(capturesBinding);
    try {
      await dependencies?.beforeRename?.();
    } catch (error) {
      throw captureFailure("rename", error);
    }
    try {
      await rename(pendingDirectory, finalDirectory);
    } catch (error) {
      throw captureFailure("rename", error);
    }
    renamed = true;
    const finalBinding = await bindCaptureDirectory(captures, finalDirectory);
    assertCaptureDecision("binding-check", decidePrivatePathBinding({
      identityStable: sameCapturePathIdentity(pendingBinding.identity, finalBinding.identity),
      authenticatedHomeBinding: true,
    }));
    await assertCaptureFileBinding(finalBinding, join(finalDirectory, "manifest.json"), manifestIdentity);
    await assertCaptureFileBinding(finalBinding, join(finalDirectory, "review.json"), reviewIdentity);
    await assertCaptureDirectoryStable(capturesBinding);
    await assertCaptureDirectoryStable(rootBinding);
    classifyCaptureDirectorySync();
  } catch (error) {
    if (createdPending && !renamed) {
      if (pendingName !== `.pending-${manifest.capture_id}` || dirname(pendingDirectory) !== captures) {
        throw new WindowsReferenceCaptureSidecarError("binding-check", "corruption");
      }
      try {
        const cleanupBinding = pendingBinding ?? await bindCaptureDirectory(captures, pendingDirectory);
        await assertCaptureDirectoryStable(cleanupBinding);
        await removeWindowsCaptureFile(
          cleanupBinding,
          join(pendingDirectory, "review.json"),
          reviewIdentity,
        );
        await removeWindowsCaptureFile(
          cleanupBinding,
          join(pendingDirectory, "manifest.json"),
          manifestIdentity,
        );
        await rmdir(pendingDirectory);
        await assertCaptureDirectoryStable(capturesBinding);
      } catch (cleanupError) {
        throw captureFailure("rename", cleanupError);
      }
    }
    throw error;
  }
  return loadReferenceCaptureSidecars({
    root: input.root,
    captureId: manifest.capture_id,
    assertReplayable: input.assertReplayable,
    platform: "win32",
  });
}

export async function writeReferenceCaptureSidecars(input: {
  readonly root: string;
  readonly manifest: ReferenceCaptureManifest;
  readonly review: ReferenceCaptureReview;
  readonly assertReplayable: AssertReferenceCaptureReplayable;
  readonly platform?: NodeJS.Platform;
}, dependencies?: ReferenceCaptureSidecarDependencies): Promise<ReferenceCaptureSidecars> {
  if (typeof input.assertReplayable !== "function") {
    throw new TypeError("capture replay assertion is invalid");
  }
  const manifest = validateReferenceCaptureManifest(input.manifest);
  const review = validateReferenceCaptureReview(input.review);
  if (manifest.capture_id !== review.capture_id) throw new Error("capture sidecar IDs disagree");
  if ((input.platform ?? process.platform) === "win32") {
    return writeWindowsReferenceCaptureSidecars({
      root: input.root,
      manifest,
      review,
      assertReplayable: input.assertReplayable,
    }, dependencies);
  }
  if (review.replaces_capture_id !== null) {
    await loadReferenceCaptureSidecars({ root: input.root, captureId: review.replaces_capture_id,
      assertReplayable: input.assertReplayable,
      ...(input.platform === undefined ? {} : { platform: input.platform }) });
  }
  const captures = join(input.root, "captures");
  const finalDirectory = captureDirectory(input.root, manifest.capture_id);
  const pendingName = `.pending-${manifest.capture_id}`;
  const pendingDirectory = join(captures, pendingName);
  if (input.platform === undefined) {
    await ensurePrivateDirectory(input.root);
    await ensurePrivateDirectory(captures);
  } else {
    await ensurePrivateDirectory(input.root, { platform: input.platform });
    await ensurePrivateDirectory(captures, { platform: input.platform });
  }
  await assertCommittedMode(captures, "directory", 0o700);
  try { await lstat(finalDirectory); throw new Error("capture sidecars already exist"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await lstat(pendingDirectory); throw new Error("capture sidecar pending directory already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  let createdPending = false;
  let renamed = false;
  try {
    await mkdir(pendingDirectory, { mode: 0o700 });
    createdPending = true;
    const fs = nodeFileSystem();
    const manifestPath = join(pendingDirectory, "manifest.json");
    const reviewPath = join(pendingDirectory, "review.json");
    await fs.writeFile(manifestPath, serializeReferenceCaptureManifest(manifest), { mode: 0o444 });
    await fs.writeFile(reviewPath, serializeReferenceCaptureReview(review), { mode: 0o444 });
    await chmod(manifestPath, 0o444);
    await chmod(reviewPath, 0o444);
    await chmod(pendingDirectory, 0o700);
    await input.assertReplayable(manifest);
    await dependencies?.beforeRename?.();
    await rename(pendingDirectory, finalDirectory);
    renamed = true;
    await chmod(finalDirectory, 0o700);
  } catch (error) {
    if (createdPending && !renamed) {
      if (pendingName !== `.pending-${manifest.capture_id}` || !pendingDirectory.startsWith(`${captures}/`)) {
        throw new Error("capture pending cleanup target is invalid", { cause: error });
      }
      await rm(pendingDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  return loadReferenceCaptureSidecars({ root: input.root, captureId: manifest.capture_id,
    assertReplayable: input.assertReplayable,
    ...(input.platform === undefined ? {} : { platform: input.platform }) });
}
