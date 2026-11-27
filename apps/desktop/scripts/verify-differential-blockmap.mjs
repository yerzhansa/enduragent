import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

const BLOCKMAP_CHECKSUM_BYTES = 18;
const SUPPORTED_ELECTRON_UPDATER_VERSION = "6.8.9";
const localRequire = createRequire(import.meta.url);

class DifferentialBlockmapVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DifferentialBlockmapVerificationError";
  }
}

function fail(message) {
  throw new DifferentialBlockmapVerificationError(message);
}

export function safeDifferentialBlockmapVerificationMessage(error) {
  return error instanceof DifferentialBlockmapVerificationError ? error.message : undefined;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

export function parseGzipBlockmap(bytes, label = "blockmap") {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 2 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b
  ) {
    fail(`${label} is invalid`);
  }
  let blockmap;
  try {
    blockmap = JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch {
    fail(`${label} is invalid`);
  }
  if (
    !exactObject(blockmap) ||
    !hasExactKeys(blockmap, ["version", "files"]) ||
    blockmap.version !== "2" ||
    !Array.isArray(blockmap.files) ||
    blockmap.files.length !== 1 ||
    !exactObject(blockmap.files[0]) ||
    !hasExactKeys(blockmap.files[0], ["name", "offset", "checksums", "sizes"])
  ) {
    fail(`${label} is invalid`);
  }
  const file = blockmap.files[0];
  if (
    file.name !== "file" ||
    file.offset !== 0 ||
    !Array.isArray(file.checksums) ||
    !Array.isArray(file.sizes) ||
    file.checksums.length === 0 ||
    file.checksums.length !== file.sizes.length ||
    !file.checksums.every(
      (checksum) =>
        validBase64(checksum) && Buffer.from(checksum, "base64").length === BLOCKMAP_CHECKSUM_BYTES,
    ) ||
    !file.sizes.every((size) => Number.isSafeInteger(size) && size > 0)
  ) {
    fail(`${label} is invalid`);
  }
  return blockmap;
}

function loadDifferentialPlanBuilder() {
  let manifest;
  let planBuilder;
  try {
    manifest = localRequire("electron-updater/package.json");
    planBuilder = localRequire("electron-updater/out/differentialDownloader/downloadPlanBuilder");
  } catch {
    fail("electron-updater differential plan builder is unavailable");
  }
  if (
    manifest.version !== SUPPORTED_ELECTRON_UPDATER_VERSION ||
    typeof planBuilder.computeOperations !== "function" ||
    !exactObject(planBuilder.OperationKind) ||
    typeof planBuilder.OperationKind.COPY !== "number" ||
    typeof planBuilder.OperationKind.DOWNLOAD !== "number"
  ) {
    fail("electron-updater differential plan builder is unsupported");
  }
  return planBuilder;
}

const silentPlanLogger = Object.freeze({
  info() {
    return undefined;
  },
  warn() {
    return undefined;
  },
  error() {
    return undefined;
  },
});

function blockmapTotalBytes(blockmap) {
  return blockmap.files[0].sizes.reduce((total, size) => total + size, 0);
}

function verifyReconstruction(
  operations,
  OperationKind,
  oldArtifact,
  newArtifact,
  oldTotal,
  newTotal,
) {
  if (!(oldArtifact instanceof Uint8Array) || !(newArtifact instanceof Uint8Array)) {
    fail("differential reconstruction requires baseline and candidate artifact bytes");
  }
  if (oldArtifact.byteLength !== oldTotal || newArtifact.byteLength !== newTotal) {
    fail("differential artifact sizes do not match blockmaps");
  }
  const reconstructed = Buffer.allocUnsafe(newTotal);
  let cursor = 0;
  for (const operation of operations) {
    const length = operation.end - operation.start;
    const source = operation.kind === OperationKind.COPY ? oldArtifact : newArtifact;
    Buffer.from(source.buffer, source.byteOffset + operation.start, length).copy(
      reconstructed,
      cursor,
    );
    cursor += length;
  }
  const expectedSha512 = createHash("sha512").update(newArtifact).digest("base64");
  const actualSha512 = createHash("sha512").update(reconstructed).digest("base64");
  if (
    cursor !== newTotal ||
    actualSha512 !== expectedSha512 ||
    !reconstructed.equals(newArtifact)
  ) {
    fail("differential reconstruction does not match candidate artifact");
  }
}

export function verifyDifferentialBlockmap(oldBlockmapBytes, newBlockmapBytes, options = {}) {
  const oldBlockmap = parseGzipBlockmap(oldBlockmapBytes, "baseline blockmap");
  const newBlockmap = parseGzipBlockmap(newBlockmapBytes, "candidate blockmap");
  if (
    options.minimumReuseRatio !== undefined &&
    (typeof options.minimumReuseRatio !== "number" ||
      !Number.isFinite(options.minimumReuseRatio) ||
      options.minimumReuseRatio < 0 ||
      options.minimumReuseRatio > 1)
  ) {
    fail("differential minimum reuse ratio is invalid");
  }
  const { computeOperations, OperationKind } = loadDifferentialPlanBuilder();
  const oldTotalBytes = blockmapTotalBytes(oldBlockmap);
  const newTotalBytes = blockmapTotalBytes(newBlockmap);
  let operations;
  try {
    operations = computeOperations(oldBlockmap, newBlockmap, silentPlanLogger);
  } catch {
    fail("differential blockmap operation planning failed");
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    fail("differential blockmap operation planning failed");
  }
  let copyBytes = 0;
  let downloadBytes = 0;
  let copyOperations = 0;
  let downloadOperations = 0;
  for (const operation of operations) {
    if (
      !exactObject(operation) ||
      !Number.isSafeInteger(operation.start) ||
      !Number.isSafeInteger(operation.end) ||
      operation.start < 0 ||
      operation.end <= operation.start
    ) {
      fail("differential blockmap operation plan is invalid");
    }
    const length = operation.end - operation.start;
    if (operation.kind === OperationKind.COPY) {
      if (operation.end > oldTotalBytes) fail("differential blockmap operation plan is invalid");
      copyBytes += length;
      copyOperations += 1;
    } else if (operation.kind === OperationKind.DOWNLOAD) {
      if (operation.end > newTotalBytes) fail("differential blockmap operation plan is invalid");
      downloadBytes += length;
      downloadOperations += 1;
    } else {
      fail("differential blockmap operation plan is invalid");
    }
  }
  if (copyBytes + downloadBytes !== newTotalBytes) {
    fail("differential blockmap size accounting mismatch");
  }
  if (options.oldArtifact !== undefined || options.newArtifact !== undefined) {
    verifyReconstruction(
      operations,
      OperationKind,
      options.oldArtifact,
      options.newArtifact,
      oldTotalBytes,
      newTotalBytes,
    );
  }
  const reuseRatio = newTotalBytes === 0 ? 0 : copyBytes / newTotalBytes;
  if (options.minimumReuseRatio !== undefined && reuseRatio < options.minimumReuseRatio) {
    fail("differential blockmap reuse ratio below threshold");
  }
  return Object.freeze({
    totalBytes: newTotalBytes,
    copyBytes,
    downloadBytes,
    copyOperations,
    downloadOperations,
    reuseRatio,
  });
}
