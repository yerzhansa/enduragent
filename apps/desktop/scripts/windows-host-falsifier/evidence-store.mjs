import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import { canonicalProbeJson } from "./probe-contract.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const forbiddenWindowsPathCharacter = /[<>:"|?*]/u;
const printableAsciiPathComponent = /^[\x20-\x7e]+$/u;
const publicationLeafPrefix = ".enduragent-publication-";
const publicationLeafPattern = /^\.enduragent-publication-([a-f0-9]{64})-([a-f0-9]{64})\.tmp$/u;
const defaultLimits = Object.freeze({
  maxArtifactBytes: 16 * 1024 * 1024,
  maxFiles: 4096,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 12,
});

export class EvidenceStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvidenceStoreError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvidenceStoreError(code, message);
}

function compareUtf8(left, right) {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateLimits(limits) {
  const value = { ...defaultLimits, ...limits };
  for (const key of Object.keys(defaultLimits)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      fail("EVIDENCE_LIMIT", `${key} must be a positive safe integer`);
    }
  }
  return Object.freeze(value);
}

function hasForbiddenWindowsPathCharacter(value) {
  return (
    forbiddenWindowsPathCharacter.test(value) ||
    [...value].some((character) => character.codePointAt(0) <= 0x1f)
  );
}

function isPublicationLeaf(value) {
  return value.startsWith(publicationLeafPrefix);
}

export function validateEvidenceRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
    fail("EVIDENCE_PATH", "evidence path must be a non-empty NFC string");
  }
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    fail("EVIDENCE_PATH", "evidence path must be normalized and relative");
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      !printableAsciiPathComponent.test(segment) ||
      hasForbiddenWindowsPathCharacter(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      isPublicationLeaf(segment) ||
      reservedWindowsName.test(segment)
    ) {
      fail("EVIDENCE_PATH", "evidence path contains an unsafe component");
    }
  }
  return value;
}

function pathWithin(root, candidate) {
  const relation = relative(root, candidate);
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function objectFingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.birthtimeMs].join(":");
}

function publicationPathSha256(relativePath) {
  return createHash("sha256").update(relativePath, "utf8").digest("hex");
}

function publicationLeaf(relativePath, contentSha256) {
  return `${publicationLeafPrefix}${publicationPathSha256(relativePath)}-${contentSha256}.tmp`;
}

function fileFingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.nlink,
    stat.size,
    stat.mode,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.birthtimeMs,
  ].join(":");
}

function requireSingleLinkFile(stat) {
  if (stat.nlink !== 1) {
    fail("EVIDENCE_HARD_LINK", "evidence artifact must have exactly one filesystem link");
  }
}

function requirePublicationFile(state, stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf is not a regular file");
  }
  if (stat.nlink !== 1 && stat.nlink !== 2) {
    fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf has an invalid link count");
  }
  if (process.platform !== "win32") {
    if ((stat.mode & 0o777) !== 0o600) {
      fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf permissions changed");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf ownership changed");
    }
  }
  if (stat.dev !== state.device) {
    fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf changed filesystem");
  }
}

function requirePlainDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("EVIDENCE_REPARSE", `${label} is not a plain directory`);
  }
}

async function inspectRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    fail("EVIDENCE_ROOT", "evidence root must be an absolute path");
  }
  const rootStat = await lstat(root);
  requirePlainDirectory(rootStat, "evidence root");
  const canonicalRoot = await realpath(root);
  return {
    root: resolve(root),
    canonicalRoot,
    fingerprint: objectFingerprint(rootStat),
    device: rootStat.dev,
  };
}

async function assertRootStable(state) {
  const current = await lstat(state.root);
  requirePlainDirectory(current, "evidence root");
  if (
    objectFingerprint(current) !== state.fingerprint ||
    (await realpath(state.root)) !== state.canonicalRoot
  ) {
    fail("EVIDENCE_ROOT_CHANGED", "evidence root identity changed");
  }
}

async function resolveExistingPath(state, relativePath, expectedType) {
  validateEvidenceRelativePath(relativePath);
  await assertRootStable(state);
  const segments = relativePath.split("/");
  let current = state.root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      fail("EVIDENCE_REPARSE", "evidence path traverses a symbolic link or junction");
    }
    if (index < segments.length - 1) requirePlainDirectory(stat, "evidence ancestor");
    else if (expectedType === "file" && !stat.isFile()) {
      fail("EVIDENCE_TYPE", "evidence artifact is not a regular file");
    } else if (expectedType === "directory") {
      requirePlainDirectory(stat, "evidence directory");
    }
  }
  const canonical = await realpath(current);
  if (!pathWithin(state.canonicalRoot, canonical)) {
    fail("EVIDENCE_ESCAPE", "evidence path resolves outside the owned root");
  }
  return current;
}

async function resolveNewLeaf(state, relativePath) {
  validateEvidenceRelativePath(relativePath);
  const segments = relativePath.split("/");
  const leaf = segments.pop();
  const parentRelative = segments.join("/");
  const parent =
    parentRelative.length === 0
      ? state.root
      : await resolveExistingPath(state, parentRelative, "directory");
  await assertRootStable(state);
  const candidate = join(parent, leaf);
  if (!pathWithin(state.root, candidate)) fail("EVIDENCE_ESCAPE", "new path escapes evidence root");
  return candidate;
}

async function lstatIfPresent(absolutePath) {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectoryMetadata(absolutePath) {
  let handle;
  try {
    handle = await open(absolutePath, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(error?.code)
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readStableAbsoluteFile(state, absolutePath, { allowedLinks, sentinel, maxBytes }) {
  const handle = await open(absolutePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink()) {
      fail("EVIDENCE_TYPE", "evidence artifact is not a regular file");
    }
    if (!allowedLinks.has(before.nlink)) {
      fail("EVIDENCE_HARD_LINK", "evidence artifact has an unexpected filesystem link count");
    }
    if (before.size > maxBytes) {
      fail("EVIDENCE_ARTIFACT_SIZE", "evidence artifact exceeds its bound");
    }
    const bytes = await readFile(handle);
    const after = await handle.stat();
    if (!allowedLinks.has(after.nlink)) {
      fail("EVIDENCE_HARD_LINK", "evidence artifact has an unexpected filesystem link count");
    }
    if (fileFingerprint(before) !== fileFingerprint(after) || bytes.length !== after.size) {
      fail("EVIDENCE_MUTATED", "evidence artifact changed while it was read");
    }
    const pathAfter = await lstat(absolutePath);
    if (!allowedLinks.has(pathAfter.nlink)) {
      fail("EVIDENCE_HARD_LINK", "evidence artifact has an unexpected filesystem link count");
    }
    if (fileFingerprint(after) !== fileFingerprint(pathAfter)) {
      fail("EVIDENCE_MUTATED", "evidence artifact path changed while it was read");
    }
    if (containsSentinel(bytes, sentinel)) {
      fail("EVIDENCE_SENTINEL", "retained evidence contains the run sentinel");
    }
    return {
      bytes,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      stat: after,
    };
  } finally {
    await handle.close();
  }
}

async function recoverLinkedPublication({
  state,
  directoryAbsolute,
  directoryRelative,
  entries,
  publicationEntry,
  sentinel,
  maxBytes,
}) {
  const match = publicationLeafPattern.exec(publicationEntry.name);
  if (match === null) {
    fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf name is invalid");
  }
  const publicationAbsolute = join(directoryAbsolute, publicationEntry.name);
  const publicationStat = await lstat(publicationAbsolute);
  requirePublicationFile(state, publicationStat);
  if (publicationStat.size > maxBytes) {
    fail("EVIDENCE_ARTIFACT_SIZE", "evidence publication leaf exceeds its bound");
  }
  if (publicationStat.nlink === 1) return null;

  const siblings = [];
  for (const entry of entries) {
    if (entry.name === publicationEntry.name || isPublicationLeaf(entry.name)) continue;
    const siblingAbsolute = join(directoryAbsolute, entry.name);
    const siblingStat = await lstat(siblingAbsolute);
    if (
      siblingStat.isFile() &&
      !siblingStat.isSymbolicLink() &&
      objectFingerprint(siblingStat) === objectFingerprint(publicationStat)
    ) {
      siblings.push({ entry, absolutePath: siblingAbsolute, stat: siblingStat });
    }
  }
  if (siblings.length !== 1) {
    fail("EVIDENCE_PUBLICATION_STATE", "linked publication leaf has no unique final artifact");
  }
  const [sibling] = siblings;
  const siblingRelative =
    directoryRelative.length === 0
      ? sibling.entry.name
      : `${directoryRelative}/${sibling.entry.name}`;
  validateEvidenceRelativePath(siblingRelative);
  if (publicationPathSha256(siblingRelative) !== match[1]) {
    fail("EVIDENCE_PUBLICATION_STATE", "linked publication leaf targets another artifact");
  }
  const retained = await readStableAbsoluteFile(state, sibling.absolutePath, {
    allowedLinks: new Set([2]),
    sentinel,
    maxBytes,
  });
  if (retained.sha256 !== match[2]) {
    fail("EVIDENCE_PUBLICATION_STATE", "linked publication leaf content is invalid");
  }
  const publicationAfter = await lstat(publicationAbsolute);
  if (
    publicationAfter.nlink !== 2 ||
    objectFingerprint(publicationAfter) !== objectFingerprint(retained.stat)
  ) {
    fail("EVIDENCE_MUTATED", "linked publication leaf changed during recovery");
  }
  await unlink(publicationAbsolute);
  await syncDirectoryMetadata(directoryAbsolute);
  const finalStat = await lstat(sibling.absolutePath);
  requireSingleLinkFile(finalStat);
  if (objectFingerprint(finalStat) !== objectFingerprint(retained.stat)) {
    fail("EVIDENCE_MUTATED", "published evidence identity changed during recovery");
  }
  return siblingRelative;
}

async function visibleDirectoryEntries(
  state,
  directoryAbsolute,
  directoryRelative,
  { sentinel, maxBytes, allowUnpublished = true },
) {
  let entries = await readdir(directoryAbsolute, { withFileTypes: true });
  let recovered = false;
  for (const entry of entries) {
    if (!isPublicationLeaf(entry.name)) continue;
    const result = await recoverLinkedPublication({
      state,
      directoryAbsolute,
      directoryRelative,
      entries,
      publicationEntry: entry,
      sentinel,
      maxBytes,
    });
    recovered ||= result !== null;
  }
  if (recovered) entries = await readdir(directoryAbsolute, { withFileTypes: true });
  const visible = [];
  for (const entry of entries) {
    if (isPublicationLeaf(entry.name)) {
      const match = publicationLeafPattern.exec(entry.name);
      if (match === null) {
        fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf name is invalid");
      }
      const stat = await lstat(join(directoryAbsolute, entry.name));
      requirePublicationFile(state, stat);
      if (stat.nlink !== 1 || stat.size > maxBytes) {
        fail("EVIDENCE_PUBLICATION_STATE", "unpublished evidence leaf is not isolated");
      }
      if (!allowUnpublished) {
        fail("EVIDENCE_PUBLICATION_INCOMPLETE", "evidence tree contains an unpublished artifact");
      }
      continue;
    }
    visible.push(entry);
  }
  visible.sort((left, right) => compareUtf8(left.name, right.name));
  return visible;
}

function bytesArePrefix(prefix, complete) {
  return prefix.length <= complete.length && complete.subarray(0, prefix.length).equals(prefix);
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten < 1) {
      fail("EVIDENCE_PUBLICATION_STATE", "evidence publication write made no progress");
    }
    offset += result.bytesWritten;
  }
}

async function stagePublicationBytes({ state, absolutePath, bytes, sentinel, maxBytes, existing }) {
  const handle = await open(absolutePath, existing ? "r+" : "wx", 0o600);
  try {
    const before = await handle.stat();
    requirePublicationFile(state, before);
    if (before.nlink !== 1) {
      fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf is already linked");
    }
    if (existing) {
      const retained = await readFile(handle);
      const afterRead = await handle.stat();
      if (
        fileFingerprint(before) !== fileFingerprint(afterRead) ||
        retained.length !== afterRead.size
      ) {
        fail("EVIDENCE_MUTATED", "evidence publication leaf changed during recovery");
      }
      if (!bytesArePrefix(retained, bytes)) {
        fail("EVIDENCE_PUBLICATION_COLLISION", "evidence publication leaf has conflicting bytes");
      }
    }
    await handle.truncate(0);
    await writeAll(handle, bytes);
    await handle.sync();
    const after = await handle.stat();
    requirePublicationFile(state, after);
    if (after.nlink !== 1 || after.size !== bytes.length) {
      fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf did not stabilize");
    }
  } finally {
    await handle.close();
  }
  const retained = await readStableAbsoluteFile(state, absolutePath, {
    allowedLinks: new Set([1]),
    sentinel,
    maxBytes,
  });
  requirePublicationFile(state, retained.stat);
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (retained.sha256 !== expectedSha256) {
    fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf digest is invalid");
  }
  return retained;
}

function containsSentinel(bytes, sentinel) {
  if (sentinel === undefined || sentinel === null || sentinel.length === 0) return false;
  const utf8 = Buffer.from(sentinel, "utf8");
  const utf16LittleEndian = Buffer.from(sentinel, "utf16le");
  const utf16BigEndian = Buffer.from(utf16LittleEndian);
  utf16BigEndian.swap16();
  return [
    utf8,
    utf16LittleEndian,
    utf16BigEndian,
    Buffer.from(utf8.toString("base64"), "ascii"),
    Buffer.from(utf8.toString("hex"), "ascii"),
  ].some((encoded) => bytes.includes(encoded));
}

async function readStableFile(state, relativePath, { sentinel, maxBytes }) {
  const absolutePath = await resolveExistingPath(state, relativePath, "file");
  const segments = relativePath.split("/");
  segments.pop();
  const directoryRelative = segments.join("/");
  await visibleDirectoryEntries(state, dirname(absolutePath), directoryRelative, {
    sentinel,
    maxBytes,
  });
  const retained = await readStableAbsoluteFile(state, absolutePath, {
    allowedLinks: new Set([1]),
    sentinel,
    maxBytes,
  });
  return {
    path: relativePath,
    bytes: retained.bytes,
    size: retained.size,
    sha256: retained.sha256,
  };
}

async function scanDirectory(state, relativePath, context, depth) {
  if (depth > context.limits.maxDepth) fail("EVIDENCE_DEPTH", "evidence tree exceeds depth bound");
  const absolute =
    relativePath.length === 0
      ? state.root
      : await resolveExistingPath(state, relativePath, "directory");
  const entries = await visibleDirectoryEntries(state, absolute, relativePath, {
    sentinel: context.sentinel,
    maxBytes: context.limits.maxArtifactBytes,
    allowUnpublished: false,
  });
  for (const entry of entries) {
    const child = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`;
    validateEvidenceRelativePath(child);
    if (entry.isSymbolicLink()) fail("EVIDENCE_REPARSE", "evidence tree contains a link");
    if (entry.isDirectory()) {
      await scanDirectory(state, child, context, depth + 1);
    } else if (entry.isFile()) {
      context.files += 1;
      if (context.files > context.limits.maxFiles) {
        fail("EVIDENCE_FILE_COUNT", "evidence tree exceeds file-count bound");
      }
      const artifact = await readStableFile(state, child, {
        sentinel: context.sentinel,
        maxBytes: context.limits.maxArtifactBytes,
      });
      context.totalBytes += artifact.size;
      if (context.totalBytes > context.limits.maxTotalBytes) {
        fail("EVIDENCE_TOTAL_SIZE", "evidence tree exceeds total-byte bound");
      }
      context.artifacts.push({
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.size,
      });
    } else {
      fail("EVIDENCE_TYPE", "evidence tree contains an unsupported object");
    }
  }
}

export async function openEvidenceStore({ root, sentinel, limits } = {}) {
  if (sentinel !== undefined && (typeof sentinel !== "string" || sentinel.length < 16)) {
    fail("EVIDENCE_SENTINEL", "sentinel must be omitted or contain at least 16 characters");
  }
  const state = await inspectRoot(root);
  const bounded = validateLimits(limits);
  let operationTail = Promise.resolve();

  async function serialize(operation) {
    let release;
    const turn = new Promise((resolveTurn) => {
      release = resolveTurn;
    });
    const previous = operationTail;
    operationTail = turn;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function createDirectory(relativePath) {
    return serialize(async () => {
      const absolute = await resolveNewLeaf(state, relativePath);
      await mkdir(absolute, { recursive: false, mode: 0o700 });
      await resolveExistingPath(state, relativePath, "directory");
      return relativePath;
    });
  }

  async function writeBytes(relativePath, value) {
    return serialize(async () => {
      const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
      if (bytes.length > bounded.maxArtifactBytes) {
        fail("EVIDENCE_ARTIFACT_SIZE", "evidence artifact exceeds its bound");
      }
      if (containsSentinel(bytes, sentinel)) {
        fail("EVIDENCE_SENTINEL", "refusing to retain an artifact containing the run sentinel");
      }
      const absolute = await resolveNewLeaf(state, relativePath);
      const directoryAbsolute = dirname(absolute);
      const segments = relativePath.split("/");
      segments.pop();
      const directoryRelative = segments.join("/");
      const contentSha256 = createHash("sha256").update(bytes).digest("hex");
      const pathSha256 = publicationPathSha256(relativePath);
      const expectedPublicationLeaf = publicationLeaf(relativePath, contentSha256);
      const expectedPublicationAbsolute = join(directoryAbsolute, expectedPublicationLeaf);
      let entries = await readdir(directoryAbsolute, { withFileTypes: true });
      for (const entry of entries) {
        if (isPublicationLeaf(entry.name) && publicationLeafPattern.exec(entry.name) === null) {
          fail("EVIDENCE_PUBLICATION_STATE", "evidence publication leaf name is invalid");
        }
      }

      const existingFinal = await lstatIfPresent(absolute);
      const expectedPublicationEntry = entries.find(
        (entry) => entry.name === expectedPublicationLeaf,
      );
      if (existingFinal !== null) {
        if (expectedPublicationEntry !== undefined) {
          const recovered = await recoverLinkedPublication({
            state,
            directoryAbsolute,
            directoryRelative,
            entries,
            publicationEntry: expectedPublicationEntry,
            sentinel,
            maxBytes: bounded.maxArtifactBytes,
          });
          if (recovered === relativePath) {
            const retained = await readStableFile(state, relativePath, {
              sentinel,
              maxBytes: bounded.maxArtifactBytes,
            });
            if (retained.sha256 !== contentSha256) {
              fail("EVIDENCE_PUBLICATION_STATE", "recovered evidence digest is invalid");
            }
            return { path: relativePath, sha256: retained.sha256 };
          }
          const unpublishedStat = await lstatIfPresent(expectedPublicationAbsolute);
          if (unpublishedStat !== null) {
            requirePublicationFile(state, unpublishedStat);
            if (unpublishedStat.nlink === 1) {
              await unlink(expectedPublicationAbsolute);
              await syncDirectoryMetadata(directoryAbsolute);
            }
          }
        }
        fail("EEXIST", "evidence artifact already exists");
      }

      let reuseExpectedPublication = false;
      for (const entry of entries) {
        const match = publicationLeafPattern.exec(entry.name);
        if (match === null || match[1] !== pathSha256) continue;
        const publicationAbsolute = join(directoryAbsolute, entry.name);
        const stat = await lstat(publicationAbsolute);
        requirePublicationFile(state, stat);
        if (stat.nlink !== 1) {
          fail("EVIDENCE_PUBLICATION_STATE", "unpublished evidence leaf has extra links");
        }
        if (entry.name === expectedPublicationLeaf) {
          const staged = await readStableAbsoluteFile(state, publicationAbsolute, {
            allowedLinks: new Set([1]),
            sentinel,
            maxBytes: bounded.maxArtifactBytes,
          });
          requirePublicationFile(state, staged.stat);
          if (!bytesArePrefix(staged.bytes, bytes)) {
            fail(
              "EVIDENCE_PUBLICATION_COLLISION",
              "evidence publication leaf has conflicting bytes",
            );
          }
          reuseExpectedPublication = true;
          continue;
        }
        fail(
          "EVIDENCE_PUBLICATION_COLLISION",
          "another publication value already owns this artifact path",
        );
      }

      try {
        await stagePublicationBytes({
          state,
          absolutePath: expectedPublicationAbsolute,
          bytes,
          sentinel,
          maxBytes: bounded.maxArtifactBytes,
          existing: reuseExpectedPublication,
        });
      } catch (error) {
        if (error?.code === "EEXIST") {
          fail("EVIDENCE_PUBLICATION_IN_PROGRESS", "artifact publication is already in progress");
        }
        throw error;
      }
      await assertRootStable(state);
      try {
        await link(expectedPublicationAbsolute, absolute);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const publicationStat = await lstatIfPresent(expectedPublicationAbsolute);
        if (publicationStat !== null) {
          requirePublicationFile(state, publicationStat);
          if (publicationStat.nlink === 1) {
            await unlink(expectedPublicationAbsolute);
            await syncDirectoryMetadata(directoryAbsolute);
          }
        }
        fail("EEXIST", "evidence artifact already exists");
      }
      entries = await readdir(directoryAbsolute, { withFileTypes: true });
      const publicationEntry = entries.find((entry) => entry.name === expectedPublicationLeaf);
      if (publicationEntry === undefined) {
        fail("EVIDENCE_PUBLICATION_STATE", "linked evidence publication leaf disappeared");
      }
      const recovered = await recoverLinkedPublication({
        state,
        directoryAbsolute,
        directoryRelative,
        entries,
        publicationEntry,
        sentinel,
        maxBytes: bounded.maxArtifactBytes,
      });
      if (recovered !== relativePath) {
        fail("EVIDENCE_PUBLICATION_STATE", "evidence publication targeted another artifact");
      }
      const retained = await readStableFile(state, relativePath, {
        sentinel,
        maxBytes: bounded.maxArtifactBytes,
      });
      if (retained.sha256 !== contentSha256) {
        fail("EVIDENCE_PUBLICATION_STATE", "published evidence digest is invalid");
      }
      return { path: relativePath, sha256: retained.sha256 };
    });
  }

  async function writeCanonicalJson(relativePath, value) {
    if (!exactObject(value)) fail("EVIDENCE_JSON", "retained JSON root must be an object");
    return writeBytes(relativePath, canonicalProbeJson(value));
  }

  async function readArtifact(relativePath) {
    return serialize(() =>
      readStableFile(state, relativePath, {
        sentinel,
        maxBytes: bounded.maxArtifactBytes,
      }),
    );
  }

  async function verifyArtifactSet(declarations) {
    if (!Array.isArray(declarations))
      fail("EVIDENCE_DECLARATIONS", "artifact declarations must be an array");
    let previous = null;
    const foldedPaths = new Set();
    const verified = [];
    for (const declaration of declarations) {
      if (
        !exactObject(declaration) ||
        Object.keys(declaration).sort().join(",") !== "path,sha256" ||
        typeof declaration.sha256 !== "string" ||
        !sha256Pattern.test(declaration.sha256)
      ) {
        fail("EVIDENCE_DECLARATION", "artifact declaration is invalid");
      }
      validateEvidenceRelativePath(declaration.path);
      if (previous !== null && compareUtf8(previous, declaration.path) >= 0) {
        fail("EVIDENCE_DECLARATION_ORDER", "artifact declarations must be strictly sorted");
      }
      const foldedPath = declaration.path.toLocaleLowerCase("en-US");
      if (foldedPaths.has(foldedPath)) {
        fail("EVIDENCE_DECLARATION_ORDER", "artifact declarations contain a case collision");
      }
      const artifact = await readArtifact(declaration.path);
      if (artifact.sha256 !== declaration.sha256) {
        fail("EVIDENCE_HASH", `artifact hash mismatch: ${declaration.path}`);
      }
      verified.push({ path: declaration.path, sha256: artifact.sha256 });
      foldedPaths.add(foldedPath);
      previous = declaration.path;
    }
    return verified;
  }

  async function scan() {
    return serialize(async () => {
      const context = { limits: bounded, sentinel, files: 0, totalBytes: 0, artifacts: [] };
      await scanDirectory(state, "", context, 0);
      return {
        files: context.files,
        totalBytes: context.totalBytes,
        artifacts: context.artifacts,
      };
    });
  }

  async function list(relativePath) {
    return serialize(async () => {
      const absolute = await resolveExistingPath(state, relativePath, "directory");
      const entries = await visibleDirectoryEntries(state, absolute, relativePath, {
        sentinel,
        maxBytes: bounded.maxArtifactBytes,
      });
      for (const entry of entries) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          fail("EVIDENCE_REPARSE", "evidence directory contains an unsupported entry");
        }
      }
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isDirectory() ? "directory" : "file",
      }));
    });
  }

  return Object.freeze({
    root: state.root,
    createDirectory,
    writeBytes,
    writeCanonicalJson,
    readArtifact,
    verifyArtifactSet,
    scan,
    list,
    assertRootStable: () => serialize(() => assertRootStable(state)),
  });
}

export function hashEvidenceValue(domain, value) {
  if (typeof domain !== "string" || domain.length === 0) {
    fail("EVIDENCE_DOMAIN", "hash domain must be non-empty");
  }
  return createHash("sha256").update(canonicalProbeJson({ domain, value }), "utf8").digest("hex");
}

export async function sealEvidenceTree(store) {
  const scanned = await store.scan();
  const manifest = {
    schemaVersion: 1,
    kind: "windows-host-probe-evidence-tree",
    files: scanned.files,
    totalBytes: scanned.totalBytes,
    artifacts: scanned.artifacts,
  };
  return Object.freeze({
    ...manifest,
    treeSha256: hashEvidenceValue("enduragent.windows-host-probe-evidence-tree.v1", manifest),
  });
}
