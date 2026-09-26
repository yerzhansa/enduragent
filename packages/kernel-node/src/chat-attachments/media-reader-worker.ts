// @ts-nocheck -- isolated worker implementation is validated through its typed host boundary.
import { parentPort, workerData } from "node:worker_threads";
import { crc32 } from "node:zlib";
import { createEngine, encodePng, PdfPasswordError, PdfSecurityError } from "clawpdf";
import { fileTypeFromBuffer } from "file-type";

class ReaderFailure extends Error {
  constructor(reason) {
    super("visual media reader rejected input");
    this.reason = reason;
  }
}

function reject(reason) {
  throw new ReaderFailure(reason);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    !["image", "pdf"].includes(input.kind) ||
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength < 1 ||
    input.limits === null ||
    typeof input.limits !== "object"
  ) {
    reject("worker_failed");
  }
  const keys = [
    "imageBytes",
    "imageDimension",
    "imagePixels",
    "documentBytes",
    "pdfPages",
    "pdfVisualPages",
    "pdfVisualPixels",
    "pdfPageDimension",
  ];
  if (keys.some((key) => !positiveInteger(input.limits[key]))) reject("worker_failed");
  if (input.kind === "image" && !["png", "jpg", "jpeg", "webp"].includes(input.extension)) {
    reject("worker_failed");
  }
  if (input.kind === "pdf") {
    if (
      !Array.isArray(input.pageNumbers) ||
      input.pageNumbers.length < 1 ||
      input.pageNumbers.length > input.limits.pdfVisualPages ||
      input.pageNumbers.some(
        (pageNumber, index) =>
          !positiveInteger(pageNumber) ||
          pageNumber > input.limits.pdfPages ||
          (index > 0 && pageNumber <= input.pageNumbers[index - 1]),
      )
    ) {
      reject("limit_exceeded");
    }
  }
}

function dimensions(width, height, limits) {
  if (
    !positiveInteger(width) ||
    !positiveInteger(height) ||
    width > limits.imageDimension ||
    height > limits.imageDimension ||
    width * height > limits.imagePixels
  ) {
    reject("limit_exceeded");
  }
  return { width, height };
}

function pngDimensions(bytes, limits) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 45) reject("validation_failed");
  let offset = 8;
  let size;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) reject("validation_failed");
    const type = buffer.subarray(typeStart, dataStart).toString("ascii");
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    if (crc32(buffer.subarray(typeStart, dataEnd)) >>> 0 !== expectedCrc) {
      reject("validation_failed");
    }
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) reject("validation_failed");
      size = dimensions(buffer.readUInt32BE(dataStart), buffer.readUInt32BE(dataStart + 4), limits);
    } else if (type === "IHDR") {
      reject("validation_failed");
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== buffer.length) reject("validation_failed");
      sawIend = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }
  if (offset !== buffer.length || size === undefined || !sawIdat || !sawIend) {
    reject("validation_failed");
  }
  return size;
}

function jpegDimensions(bytes, limits) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 8 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    reject("validation_failed");
  }
  let offset = 2;
  let size;
  let sawScan = false;
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) reject("validation_failed");
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) reject("validation_failed");
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) reject("validation_failed");
    if (frameMarkers.has(marker)) {
      if (length < 8) reject("validation_failed");
      size = dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3), limits);
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      break;
    }
  }
  if (
    size === undefined ||
    !sawScan ||
    buffer[buffer.length - 2] !== 0xff ||
    buffer[buffer.length - 1] !== 0xd9
  ) {
    reject("validation_failed");
  }
  return size;
}

function webpDimensions(bytes, limits) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 30 || buffer.readUInt32LE(4) + 8 !== buffer.length) {
    reject("validation_failed");
  }
  let offset = 12;
  let size;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) reject("validation_failed");
    if (type === "VP8X" && length >= 10) {
      const width = 1 + buffer.readUIntLE(start + 4, 3);
      const height = 1 + buffer.readUIntLE(start + 7, 3);
      size ??= dimensions(width, height, limits);
    }
    if (type === "VP8 " && length >= 10) {
      if (buffer[start + 3] !== 0x9d || buffer[start + 4] !== 0x01 || buffer[start + 5] !== 0x2a) {
        reject("validation_failed");
      }
      size ??= dimensions(
        buffer.readUInt16LE(start + 6) & 0x3fff,
        buffer.readUInt16LE(start + 8) & 0x3fff,
        limits,
      );
    }
    if (type === "VP8L" && length >= 5) {
      if (buffer[start] !== 0x2f) reject("validation_failed");
      const packed = buffer.readUInt32LE(start + 1);
      size ??= dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1, limits);
    }
    offset = end + (length % 2);
  }
  if (offset !== buffer.length || size === undefined) reject("validation_failed");
  return size;
}

async function readImage(input) {
  if (input.bytes.byteLength > input.limits.imageBytes) reject("limit_exceeded");
  const detected = await fileTypeFromBuffer(input.bytes);
  const expected =
    input.extension === "jpg" || input.extension === "jpeg" ? "jpg" : input.extension;
  if (detected?.ext !== expected) reject("validation_failed");
  const size =
    expected === "png"
      ? pngDimensions(input.bytes, input.limits)
      : expected === "jpg"
        ? jpegDimensions(input.bytes, input.limits)
        : webpDimensions(input.bytes, input.limits);
  return {
    mediaType: expected === "png" ? "image/png" : expected === "jpg" ? "image/jpeg" : "image/webp",
    bytes: input.bytes,
    ...size,
  };
}

async function renderPdf(input) {
  if (input.bytes.byteLength > input.limits.documentBytes) reject("limit_exceeded");
  const detected = await fileTypeFromBuffer(input.bytes);
  if (detected?.ext !== "pdf") reject("validation_failed");
  let engine;
  let pdf;
  let result;
  let destroyFailure;
  try {
    engine = await createEngine();
    pdf = await engine.open(input.bytes);
    if (!positiveInteger(pdf.pageCount) || pdf.pageCount > input.limits.pdfPages) {
      reject("limit_exceeded");
    }
    const perPagePixels = Math.floor(input.limits.pdfVisualPixels / input.pageNumbers.length);
    const results = [];
    for (const pageNumber of input.pageNumbers) {
      if (pageNumber > pdf.pageCount) reject("validation_failed");
      const page = pdf.page(pageNumber);
      const rotated = page.rotation === 90 || page.rotation === 270;
      const baseWidth = rotated ? page.height : page.width;
      const baseHeight = rotated ? page.width : page.height;
      const naturalScale = 96 / 72;
      const scale = Math.min(
        naturalScale,
        input.limits.pdfPageDimension / baseWidth,
        input.limits.pdfPageDimension / baseHeight,
        Math.sqrt(perPagePixels / (baseWidth * baseHeight)),
      );
      if (!Number.isFinite(scale) || scale <= 0) reject("limit_exceeded");
      const requestedWidth = Math.max(1, Math.floor(baseWidth * scale));
      const rendered = page.render({ width: requestedWidth, background: "white", forms: true });
      if (
        rendered.width > input.limits.pdfPageDimension ||
        rendered.height > input.limits.pdfPageDimension ||
        rendered.width * rendered.height > perPagePixels
      ) {
        reject("limit_exceeded");
      }
      const bytes = await encodePng(rendered.rgba, {
        width: rendered.width,
        height: rendered.height,
      });
      results.push({
        pageNumber,
        mediaType: "image/png",
        bytes,
        width: rendered.width,
        height: rendered.height,
      });
    }
    result = results;
  } catch (error) {
    if (error instanceof ReaderFailure) throw error;
    if (error instanceof PdfPasswordError || error instanceof PdfSecurityError) {
      reject("validation_failed");
    }
    reject("validation_failed");
  } finally {
    pdf?.destroy();
    try {
      await engine?.destroy();
    } catch (error) {
      if (destroyFailure === undefined) destroyFailure = error;
    }
  }
  if (destroyFailure !== undefined) throw destroyFailure;
  return result;
}

async function main() {
  validateInput(workerData);
  const result =
    workerData.kind === "image" ? await readImage(workerData) : await renderPdf(workerData);
  const buffers =
    workerData.kind === "image" ? [result.bytes.buffer] : result.map((item) => item.bytes.buffer);
  parentPort?.postMessage({ ok: true, kind: workerData.kind, result }, buffers);
}

main().catch((error) => {
  parentPort?.postMessage({
    ok: false,
    reason: error instanceof ReaderFailure ? error.reason : "validation_failed",
  });
});
