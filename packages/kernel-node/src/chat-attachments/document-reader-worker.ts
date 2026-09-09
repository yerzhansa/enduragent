// @ts-nocheck -- isolated worker implementation is validated through its typed host boundary.
import { Readable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import { createEngine, PdfPasswordError, PdfSecurityError } from "clawpdf";
import { parse } from "csv-parse";
import { fileTypeFromBuffer } from "file-type";
import mammoth from "mammoth";
import yauzl from "yauzl";

class ReaderFailure extends Error {
  constructor(reason) {
    super("document reader rejected input");
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
    !["pdf", "txt", "csv", "docx"].includes(input.extension) ||
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength < 1 ||
    input.limits === null ||
    typeof input.limits !== "object"
  ) {
    reject("worker_failed");
  }
  const keys = [
    "documentBytes",
    "extractedTextChars",
    "pdfPages",
    "pdfVisualPages",
    "pdfUsefulTextCharsPerPage",
    "docxEntries",
    "docxExpandedBytes",
    "docxCompressionRatio",
    "csvRows",
    "csvColumns",
    "csvRecordChars",
  ];
  if (keys.some((key) => !positiveInteger(input.limits[key]))) reject("worker_failed");
  if (
    input.bytes.byteLength > input.limits.documentBytes ||
    input.limits.pdfVisualPages > input.limits.pdfPages
  ) {
    reject("limit_exceeded");
  }
}

function strictUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject("validation_failed");
  }
}

function normalizeText(text) {
  if (text.includes("\0")) reject("validation_failed");
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function boundedText(text, maximum) {
  if (text.length <= maximum) return { text, truncated: false };
  return { text: text.slice(0, maximum), truncated: true };
}

async function assertDetectedType(bytes, expected) {
  let detected;
  try {
    detected = await fileTypeFromBuffer(bytes);
  } catch {
    reject("validation_failed");
  }
  if (expected === "pdf" || expected === "docx") {
    if (detected?.ext !== expected) reject("validation_failed");
    return;
  }
  if (detected !== undefined) reject("validation_failed");
}

async function readPlainText(bytes, limits) {
  await assertDetectedType(bytes, "txt");
  return {
    ...boundedText(normalizeText(strictUtf8(bytes)), limits.extractedTextChars),
    visualPageNumbers: [],
  };
}

async function* textChunks(text) {
  const size = 65_536;
  for (let offset = 0; offset < text.length; offset += size) {
    yield text.slice(offset, offset + size);
  }
}

async function readCsv(bytes, limits) {
  await assertDetectedType(bytes, "csv");
  const text = strictUtf8(bytes);
  if (text.includes("\0")) reject("validation_failed");
  const parser = parse({
    bom: true,
    max_record_size: limits.csvRecordChars,
    relax_column_count: true,
  });
  const records = Readable.from(textChunks(text)).pipe(parser);
  let rows = 0;
  let output = "";
  let truncated = false;
  try {
    for await (const candidate of records) {
      if (!Array.isArray(candidate)) reject("validation_failed");
      rows += 1;
      if (rows > limits.csvRows || candidate.length > limits.csvColumns) {
        reject("limit_exceeded");
      }
      const row = candidate.map((cell) => String(cell));
      if (row.some((cell) => cell.length > limits.csvRecordChars)) {
        reject("limit_exceeded");
      }
      const line = `${JSON.stringify(row)}\n`;
      const remaining = limits.extractedTextChars - output.length;
      if (line.length > remaining) {
        if (remaining > 0) output += line.slice(0, remaining);
        truncated = true;
      } else if (!truncated) {
        output += line;
      }
    }
  } catch (error) {
    if (error instanceof ReaderFailure) throw error;
    if (error?.code === "CSV_MAX_RECORD_SIZE") reject("limit_exceeded");
    reject("validation_failed");
  } finally {
    records.destroy();
    parser.destroy();
  }
  return {
    text: output.trimEnd(),
    truncated,
    visualPageNumbers: [],
  };
}

function entryText(zip, entry) {
  return new Promise((resolve, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || stream === undefined) {
        rejectPromise(error ?? new Error("ZIP entry is unavailable"));
        return;
      }
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.once("error", rejectPromise);
      stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

function safeZipName(name) {
  if (
    name.length < 1 ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.split("/").some((segment) => segment === ".." || segment.includes("\0"))
  ) {
    reject("validation_failed");
  }
}

function inspectDocx(bytes, limits) {
  return new Promise((resolve, rejectPromise) => {
    yauzl.fromBuffer(
      Buffer.from(bytes),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (openError, zip) => {
        if (openError || zip === undefined) {
          rejectPromise(new ReaderFailure("validation_failed"));
          return;
        }
        let settled = false;
        let entries = 0;
        let expanded = 0;
        let compressed = 0;
        let contentTypes;
        const relationships = [];
        const names = new Set();
        let hasDocument = false;
        const finish = (work) => {
          if (settled) return;
          settled = true;
          zip.close();
          work();
        };
        const fail = (reason) => finish(() => rejectPromise(new ReaderFailure(reason)));
        zip.once("error", () => fail("validation_failed"));
        zip.on("entry", async (entry) => {
          try {
            safeZipName(entry.fileName);
            const canonicalName = entry.fileName.toLowerCase();
            if (names.has(canonicalName)) reject("validation_failed");
            names.add(canonicalName);
            entries += 1;
            expanded += entry.uncompressedSize;
            compressed += entry.compressedSize;
            if (
              entries > limits.docxEntries ||
              expanded > limits.docxExpandedBytes ||
              entry.uncompressedSize > limits.docxExpandedBytes ||
              (entry.compressedSize > 0 &&
                entry.uncompressedSize / entry.compressedSize > limits.docxCompressionRatio) ||
              (compressed > 0 && expanded / compressed > limits.docxCompressionRatio)
            ) {
              reject("limit_exceeded");
            }
            if ((entry.generalPurposeBitFlag & 1) !== 0) reject("validation_failed");
            if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
              reject("validation_failed");
            }
            if (
              canonicalName === "word/vbaproject.bin" ||
              canonicalName.startsWith("word/embeddings/") ||
              canonicalName.startsWith("word/activex/") ||
              canonicalName.startsWith("customui/")
            ) {
              reject("validation_failed");
            }
            hasDocument ||= canonicalName === "word/document.xml";
            if (canonicalName === "[content_types].xml") {
              contentTypes = await entryText(zip, entry);
            } else if (canonicalName.endsWith(".rels")) {
              relationships.push(await entryText(zip, entry));
            }
            zip.readEntry();
          } catch (error) {
            fail(error instanceof ReaderFailure ? error.reason : "validation_failed");
          }
        });
        zip.once("end", () => {
          if (settled) return;
          if (!hasDocument || typeof contentTypes !== "string") {
            fail("validation_failed");
            return;
          }
          const xml = [contentTypes, ...relationships].join("\n");
          if (
            /<!DOCTYPE|<!ENTITY/iu.test(xml) ||
            /TargetMode\s*=\s*["']External["']/iu.test(xml) ||
            /macroEnabled/iu.test(contentTypes) ||
            !/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml/iu.test(
              contentTypes,
            )
          ) {
            fail("validation_failed");
            return;
          }
          finish(resolve);
        });
        zip.readEntry();
      },
    );
  });
}

async function readDocx(bytes, limits) {
  await assertDetectedType(bytes, "docx");
  await inspectDocx(bytes, limits);
  let extracted;
  try {
    extracted = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  } catch {
    reject("validation_failed");
  }
  const result = boundedText(normalizeText(extracted.value), limits.extractedTextChars);
  return { ...result, visualPageNumbers: [] };
}

function usefulPdfText(text) {
  return text.replace(/\s/gu, "").length;
}

async function readPdf(bytes, limits) {
  await assertDetectedType(bytes, "pdf");
  let engine;
  let pdf;
  try {
    engine = await createEngine();
    pdf = await engine.open(bytes);
    if (!positiveInteger(pdf.pageCount) || pdf.pageCount > limits.pdfPages) {
      reject("limit_exceeded");
    }
    let text = "";
    let truncated = false;
    const visualPageNumbers = [];
    for (let pageNumber = 1; pageNumber <= pdf.pageCount; pageNumber += 1) {
      const extracted = await pdf.extract({
        mode: "text",
        pages: [pageNumber],
        maxTextChars: limits.extractedTextChars,
      });
      const normalized = normalizeText(extracted.text);
      if (usefulPdfText(normalized) < limits.pdfUsefulTextCharsPerPage) {
        if (visualPageNumbers.length < limits.pdfVisualPages) visualPageNumbers.push(pageNumber);
        continue;
      }
      const prefix = `${text.length === 0 ? "" : "\n\n"}[Page ${pageNumber}]\n`;
      const available = Math.max(0, limits.extractedTextChars - text.length - prefix.length);
      const included = normalized.slice(0, available);
      if (included.length > 0) text += prefix + included;
      if (included.length < normalized.length || extracted.truncated.text) truncated = true;
    }
    return { text, visualPageNumbers, truncated };
  } catch (error) {
    if (error instanceof ReaderFailure) throw error;
    if (error instanceof PdfPasswordError || error instanceof PdfSecurityError) {
      reject("encrypted_pdf");
    }
    reject("validation_failed");
  } finally {
    pdf?.destroy();
    await engine?.destroy().catch(() => {});
  }
}

async function readDocument(input) {
  validateInput(input);
  const bytes = new Uint8Array(input.bytes);
  if (input.extension === "txt") return readPlainText(bytes, input.limits);
  if (input.extension === "csv") return readCsv(bytes, input.limits);
  if (input.extension === "docx") return readDocx(bytes, input.limits);
  return readPdf(bytes, input.limits);
}

if (parentPort === null) throw new Error("document reader worker requires a parent port");

try {
  parentPort.postMessage({ ok: true, ...(await readDocument(workerData)) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    reason: error instanceof ReaderFailure ? error.reason : "worker_failed",
  });
}
parentPort.close();
