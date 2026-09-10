import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { ManagedChatAttachmentStore } from "./managed-store.js";

export type ManagedDocumentExtension = "pdf" | "txt" | "csv" | "docx";
export type ManagedDocumentReaderName = "pdf" | "text" | "csv" | "docx";

export const MANAGED_DOCUMENT_READER_VERSIONS = Object.freeze({
  pdf: "pdf-clawpdf-0.3.0-v1",
  text: "text-utf8-v1",
  csv: "csv-parse-7.0.2-v1",
  docx: "docx-mammoth-1.12.1-v1",
} satisfies Readonly<Record<ManagedDocumentReaderName, string>>);

export interface ManagedDocumentReaderLimits {
  readonly documentBytes: number;
  readonly extractedTextChars: number;
  readonly pdfPages: number;
  readonly pdfVisualPages: number;
  readonly pdfUsefulTextCharsPerPage: number;
  readonly docxEntries: number;
  readonly docxExpandedBytes: number;
  readonly docxCompressionRatio: number;
  readonly csvRows: number;
  readonly csvColumns: number;
  readonly csvRecordChars: number;
  readonly parserMs: number;
  readonly parserOldGenerationMiB: number;
}

export interface ManagedDocumentProjection {
  readonly kind: "managed-document";
  readonly objectId: string;
  readonly reader: ManagedDocumentReaderName;
  readonly readerVersion: string;
  readonly extractedTextSha256: string;
  readonly extractedTextChars: number;
  readonly visualPageNumbers: readonly number[];
}

export interface ManagedDocumentReadResult {
  readonly projection: ManagedDocumentProjection;
  readonly content: {
    readonly trust: "untrusted-attachment-content";
    readonly text: string;
    readonly truncated: boolean;
  };
}

export type ManagedDocumentReaderFailure =
  | "encrypted_pdf"
  | "integrity_mismatch"
  | "limit_exceeded"
  | "parser_timeout"
  | "validation_failed"
  | "worker_failed";

export class ManagedDocumentReaderError extends Error {
  constructor(readonly reason: ManagedDocumentReaderFailure) {
    super("managed document could not be read");
    this.name = "ManagedDocumentReaderError";
  }
}

export interface ManagedDocumentSource {
  readonly objectId: string;
  readonly relativePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly extension: ManagedDocumentExtension;
}

export interface ManagedDocumentReader {
  read(source: ManagedDocumentSource): Promise<ManagedDocumentReadResult>;
}

export interface ManagedDocumentReaderOptions {
  readonly objects: Pick<ManagedChatAttachmentStore, "readObjectBytes">;
  readonly limits: ManagedDocumentReaderLimits;
  readonly workerUrl?: URL;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly text: unknown;
  readonly visualPageNumbers: unknown;
  readonly truncated: unknown;
}

interface WorkerFailure {
  readonly ok: false;
  readonly reason: unknown;
}

const FAILURE_REASONS = new Set<ManagedDocumentReaderFailure>([
  "encrypted_pdf",
  "integrity_mismatch",
  "limit_exceeded",
  "parser_timeout",
  "validation_failed",
  "worker_failed",
]);
const SAFE_OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validateLimits(limits: ManagedDocumentReaderLimits): void {
  positiveInteger(limits.documentBytes, "documentBytes");
  positiveInteger(limits.extractedTextChars, "extractedTextChars");
  positiveInteger(limits.pdfPages, "pdfPages");
  positiveInteger(limits.pdfVisualPages, "pdfVisualPages");
  positiveInteger(limits.pdfUsefulTextCharsPerPage, "pdfUsefulTextCharsPerPage");
  positiveInteger(limits.docxEntries, "docxEntries");
  positiveInteger(limits.docxExpandedBytes, "docxExpandedBytes");
  positiveInteger(limits.docxCompressionRatio, "docxCompressionRatio");
  positiveInteger(limits.csvRows, "csvRows");
  positiveInteger(limits.csvColumns, "csvColumns");
  positiveInteger(limits.csvRecordChars, "csvRecordChars");
  positiveInteger(limits.parserMs, "parserMs");
  positiveInteger(limits.parserOldGenerationMiB, "parserOldGenerationMiB");
  if (limits.pdfVisualPages > limits.pdfPages) {
    throw new TypeError("pdfVisualPages cannot exceed pdfPages");
  }
}

function readerName(extension: ManagedDocumentExtension): ManagedDocumentReaderName {
  return extension === "txt" ? "text" : extension;
}

function defaultWorkerUrl(): URL {
  const sourceModule = import.meta.url.endsWith(".ts");
  return new URL(
    sourceModule ? "./document-reader-worker.ts" : "./document-reader-worker.js",
    import.meta.url,
  );
}

function failure(reason: unknown): ManagedDocumentReaderError {
  return new ManagedDocumentReaderError(
    typeof reason === "string" && FAILURE_REASONS.has(reason as ManagedDocumentReaderFailure)
      ? (reason as ManagedDocumentReaderFailure)
      : "worker_failed",
  );
}

function validateWorkerResult(
  value: WorkerSuccess,
  limits: ManagedDocumentReaderLimits,
): {
  readonly text: string;
  readonly visualPageNumbers: readonly number[];
  readonly truncated: boolean;
} {
  if (
    typeof value.text !== "string" ||
    value.text.length > limits.extractedTextChars ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.visualPageNumbers)
  ) {
    throw failure("worker_failed");
  }
  const visualPageNumbers = value.visualPageNumbers.map(Number);
  if (
    visualPageNumbers.length > limits.pdfVisualPages ||
    visualPageNumbers.some(
      (pageNumber, index) =>
        !Number.isSafeInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > limits.pdfPages ||
        (index > 0 && pageNumber <= visualPageNumbers[index - 1]!),
    )
  ) {
    throw failure("worker_failed");
  }
  return { text: value.text, visualPageNumbers, truncated: value.truncated };
}

function runWorker(
  workerUrl: URL,
  extension: ManagedDocumentExtension,
  bytes: Uint8Array,
  limits: ManagedDocumentReaderLimits,
): Promise<ReturnType<typeof validateWorkerResult>> {
  return new Promise((resolve, reject) => {
    const transferable = Uint8Array.from(bytes);
    const worker = new Worker(workerUrl, {
      workerData: { extension, bytes: transferable, limits },
      transferList: [transferable.buffer],
      resourceLimits: { maxOldGenerationSizeMb: limits.parserOldGenerationMiB },
    });
    let settled = false;
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
      void worker.terminate();
    };
    const timer = setTimeout(() => {
      finish(() => reject(failure("parser_timeout")));
    }, limits.parserMs);
    timer.unref();
    worker.once("message", (message: WorkerSuccess | WorkerFailure) => {
      if (message?.ok === false) {
        finish(() => reject(failure(message.reason)));
        return;
      }
      if (message?.ok !== true) {
        finish(() => reject(failure("worker_failed")));
        return;
      }
      try {
        const result = validateWorkerResult(message, limits);
        finish(() => resolve(result));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    worker.once("error", () => {
      finish(() => reject(failure("worker_failed")));
    });
    worker.once("exit", () => {
      finish(() => reject(failure("worker_failed")));
    });
  });
}

export function createManagedDocumentReader(
  options: ManagedDocumentReaderOptions,
): ManagedDocumentReader {
  validateLimits(options.limits);
  const workerUrl = options.workerUrl ?? defaultWorkerUrl();
  return {
    async read(source) {
      if (
        !SAFE_OBJECT_ID.test(source.objectId) ||
        !SHA256.test(source.sha256) ||
        !Number.isSafeInteger(source.byteSize) ||
        source.byteSize < 1
      ) {
        throw new ManagedDocumentReaderError("integrity_mismatch");
      }
      if (source.byteSize > options.limits.documentBytes) {
        throw new ManagedDocumentReaderError("limit_exceeded");
      }
      let bytes: Uint8Array;
      try {
        bytes = await options.objects.readObjectBytes({
          relativePath: source.relativePath,
          byteSize: source.byteSize,
          sha256: source.sha256,
        });
      } catch {
        throw new ManagedDocumentReaderError("integrity_mismatch");
      }
      const parsed = await runWorker(workerUrl, source.extension, bytes, options.limits);
      const reader = readerName(source.extension);
      return {
        projection: {
          kind: "managed-document",
          objectId: source.objectId,
          reader,
          readerVersion: MANAGED_DOCUMENT_READER_VERSIONS[reader],
          extractedTextSha256: createHash("sha256").update(parsed.text, "utf8").digest("hex"),
          extractedTextChars: parsed.text.length,
          visualPageNumbers: parsed.visualPageNumbers,
        },
        content: {
          trust: "untrusted-attachment-content",
          text: parsed.text,
          truncated: parsed.truncated,
        },
      };
    },
  };
}
