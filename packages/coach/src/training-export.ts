import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { makeAbortableClient } from "@enduragent/core";
import {
  ExportTrainingFileRpcResultSchema,
  TrainingExportFilenameSchema,
  type ExportTrainingFileRpcParams,
  type ExportTrainingFileRpcResult,
  type TrainingExportRefusalReason,
} from "@enduragent/coach-contract";
import type { TrustedActivitySourceResolver } from "@enduragent/kernel/store";
import type { ApiError, BinaryDownload, IntervalsClient, Result } from "intervals-icu-api";
import { awaitWithSignal } from "./abortable-operation.js";

export const MAX_ACTIVITY_EXPORT_BYTES = 128 * 1_024 * 1_024;
export const MAX_WORKOUT_ARCHIVE_EXPORT_BYTES = 256 * 1_024 * 1_024;
export const TRAINING_EXPORT_REQUEST_TIMEOUT_MS = 60_000;

export type TrainingExportWriteOutcome = "committed" | "failed" | "uncertain";

export interface TrainingExportWriter {
  write(input: {
    readonly destinationPath: string;
    readonly bytes: Uint8Array;
    readonly signal?: AbortSignal;
  }): Promise<TrainingExportWriteOutcome>;
}

export interface TrainingExportService {
  export(
    request: ExportTrainingFileRpcParams,
    signal?: AbortSignal,
  ): Promise<ExportTrainingFileRpcResult>;
}

export type TrainingExportClientFactory = (input: {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly signal: AbortSignal;
  readonly baseFetch: typeof globalThis.fetch;
}) => Pick<IntervalsClient, "activities" | "workouts">;

function refused(reason: TrainingExportRefusalReason): ExportTrainingFileRpcResult {
  return { status: "refused", reason };
}

function safeContentType(value: string | null): string | null {
  if (value === null || value.length === 0 || value.length > 255) return null;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return null;
  }
  return value;
}

function resultMetadata(value: BinaryDownload): {
  readonly suggestedFilename: string | null;
  readonly contentType: string | null;
} {
  const filename = TrainingExportFilenameSchema.safeParse(value.filename);
  return {
    suggestedFilename: filename.success ? filename.data : null,
    contentType: safeContentType(value.contentType),
  };
}

function contentTypeMatches(request: ExportTrainingFileRpcParams, value: string | null): boolean {
  if (value === null) return true;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "application/octet-stream") return true;
  if (request.kind === "workout-archive") {
    return mediaType === "application/zip" || mediaType === "application/x-zip-compressed";
  }
  if (request.format === "fit") {
    return ["application/vnd.ant.fit", "application/fit", "application/x-fit"].includes(mediaType);
  }
  return ["application/gpx+xml", "application/xml", "text/xml"].includes(mediaType);
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function contentBytesMatch(request: ExportTrainingFileRpcParams, bytes: Uint8Array): boolean {
  if (request.kind === "workout-archive") {
    return (
      bytes.byteLength >= 4 &&
      (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
        hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
        hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08]))
    );
  }
  if (request.format === "fit") {
    const headerSize = bytes[0] ?? 0;
    return (
      bytes.byteLength >= 12 &&
      headerSize >= 12 &&
      headerSize <= bytes.byteLength &&
      hasPrefix(bytes.subarray(8), [0x2e, 0x46, 0x49, 0x54])
    );
  }
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 65_536)));
  return /<gpx(?:\s|>)/iu.test(prefix);
}

function providerRefusal(
  error: ApiError,
  responseLimitExceeded: boolean,
): TrainingExportRefusalReason {
  if (responseLimitExceeded) return "response-too-large";
  if (error.kind === "RateLimit") return "rate-limited";
  if (error.kind === "Timeout") return "timeout";
  if (error.kind === "Network") return "network";
  if (error.kind === "Validation") return "invalid-response";
  if (error.kind === "NotFound") return "not-supported";
  return "provider-unavailable";
}

export function createBoundedTrainingExportFetch(input: {
  readonly baseFetch: typeof globalThis.fetch;
  readonly maximumBytes: number;
  readonly noteLimitExceeded: () => void;
}): typeof globalThis.fetch {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw new TypeError("training export response limit is invalid");
  }
  return async (request, init) => {
    const response = await input.baseFetch(request, init);
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const bytes = Number(declared);
      if (Number.isFinite(bytes) && bytes > input.maximumBytes) {
        input.noteLimitExceeded();
        await response.body?.cancel();
        throw new Error("training export response exceeded its private byte limit");
      }
    }
    if (response.body === null) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > input.maximumBytes) {
        input.noteLimitExceeded();
        await reader.cancel();
        throw new Error("training export response exceeded its private byte limit");
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  let closeError: unknown;
  try {
    await directory.sync();
  } finally {
    try {
      await directory.close();
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error.code !== "ERR_DIR_CLOSED" && error.code !== "EBADF")
      ) {
        closeError = error;
      }
    }
  }
  if (closeError !== undefined) throw closeError;
}

export function createDurableTrainingExportWriter(input?: {
  readonly platform?: NodeJS.Platform;
  readonly pathApi?: Pick<
    typeof posix,
    "basename" | "dirname" | "isAbsolute" | "join" | "normalize"
  >;
  readonly createTemporaryId?: () => string;
  readonly openFile?: typeof open;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (path: string) => Promise<void>;
}): TrainingExportWriter {
  const platform = input?.platform ?? process.platform;
  const pathApi = input?.pathApi ?? (platform === "win32" ? win32 : posix);
  const createTemporaryId = input?.createTemporaryId ?? (() => randomBytes(12).toString("hex"));
  const openFile = input?.openFile ?? open;
  const renameFile = input?.renameFile ?? rename;
  const removeFile = input?.removeFile ?? rm;
  const sync = input?.syncDirectory ?? syncDirectory;
  return Object.freeze({
    async write(request: {
      readonly destinationPath: string;
      readonly bytes: Uint8Array;
      readonly signal?: AbortSignal;
    }): Promise<TrainingExportWriteOutcome> {
      const destination =
        platform === "win32" && /^[A-Za-z]:[\\/]/.test(request.destinationPath)
          ? request.destinationPath.replaceAll("/", "\\")
          : request.destinationPath;
      const fileName = pathApi.basename(destination);
      if (
        !pathApi.isAbsolute(destination) ||
        pathApi.normalize(destination) !== destination ||
        fileName.length === 0 ||
        fileName === "/" ||
        fileName === "." ||
        fileName === ".."
      ) {
        return "failed";
      }
      const root = pathApi.dirname(destination);
      const id = createTemporaryId();
      if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) return "failed";
      const temporary = pathApi.join(root, `.enduragent-export-${id}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let renamed = false;
      let outcome: "committed" | "uncertain" | "failed";
      try {
        request.signal?.throwIfAborted();
        handle = await openFile(temporary, "wx", 0o600);
        request.signal?.throwIfAborted();
        await handle.writeFile(request.bytes, { signal: request.signal });
        request.signal?.throwIfAborted();
        await handle.chmod(0o600);
        request.signal?.throwIfAborted();
        await handle.sync();
        request.signal?.throwIfAborted();
        await handle.close();
        handle = undefined;
        // No abort may advance past this boundary. Once rename starts, an abort
        // has an uncertain commit outcome and the service must not invite a retry.
        request.signal?.throwIfAborted();
        await renameFile(temporary, destination);
        renamed = true;
        if (platform !== "win32") await sync(root);
        outcome = "committed";
      } catch {
        outcome = renamed ? "uncertain" : "failed";
      } finally {
        if (handle !== undefined) {
          try {
            await handle.close();
          } catch (error) {
            const benign =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              (error.code === "ERR_DIR_CLOSED" || error.code === "EBADF");
            if (!benign && outcome === "committed") outcome = "uncertain";
          }
        }
        try {
          await removeFile(temporary, { force: true });
        } catch {
          if (outcome === "committed") outcome = "uncertain";
        }
      }
      return outcome;
    },
  });
}

function downloadActivity(
  client: Pick<IntervalsClient, "activities">,
  providerActivityId: string,
  format: "fit" | "gpx",
): Promise<Result<BinaryDownload>> {
  return format === "fit"
    ? client.activities.downloadFitFile(providerActivityId, {
        includeMetadata: true,
        power: true,
        hr: true,
      })
    : client.activities.downloadGpxFile(providerActivityId, {
        includeMetadata: true,
        power: true,
        hr: true,
      });
}

export function createTrainingExportService(input: {
  readonly credentials: {
    read(): Promise<{ readonly apiKey: string; readonly athleteId: string }>;
  };
  readonly sources: TrustedActivitySourceResolver;
  readonly writer?: TrainingExportWriter;
  readonly createClient?: TrainingExportClientFactory;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly maximumActivityBytes?: number;
  readonly maximumWorkoutArchiveBytes?: number;
  readonly requestTimeoutMs?: number;
}): TrainingExportService {
  const writer = input.writer ?? createDurableTrainingExportWriter();
  const maximumActivityBytes = input.maximumActivityBytes ?? MAX_ACTIVITY_EXPORT_BYTES;
  const maximumWorkoutArchiveBytes =
    input.maximumWorkoutArchiveBytes ?? MAX_WORKOUT_ARCHIVE_EXPORT_BYTES;
  const requestTimeoutMs = input.requestTimeoutMs ?? TRAINING_EXPORT_REQUEST_TIMEOUT_MS;
  for (const value of [maximumActivityBytes, maximumWorkoutArchiveBytes, requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("training export limit is invalid");
    }
  }
  const createClient =
    input.createClient ??
    ((options) =>
      makeAbortableClient({
        apiKey: options.apiKey,
        ...(options.athleteId.length === 0 ? {} : { athleteId: options.athleteId }),
        signal: options.signal,
        perRequestMs: requestTimeoutMs,
        baseFetch: options.baseFetch,
      }));

  return Object.freeze({
    async export(
      request: ExportTrainingFileRpcParams,
      signal: AbortSignal = new AbortController().signal,
    ): Promise<ExportTrainingFileRpcResult> {
      const deadline = AbortSignal.timeout(requestTimeoutMs);
      const operationSignal = AbortSignal.any([signal, deadline]);
      const preCommitAbort = (error: unknown): ExportTrainingFileRpcResult => {
        if (signal.aborted) throw signal.reason ?? error;
        return refused("timeout");
      };
      operationSignal.throwIfAborted();
      let providerActivityId: string | undefined;
      if (request.kind === "activity") {
        let resolution;
        try {
          resolution = await awaitWithSignal(
            input.sources.resolve({ canonicalActivityId: request.canonicalActivityId }),
            operationSignal,
          );
        } catch (error) {
          if (operationSignal.aborted) return preCommitAbort(error);
          throw error;
        }
        if (resolution.kind === "unavailable") {
          return refused(
            resolution.reason === "ambiguous" ? "ambiguous-source" : "source-not-found",
          );
        }
        providerActivityId = resolution.providerActivityId;
      }
      let credentials;
      try {
        credentials = await awaitWithSignal(input.credentials.read(), operationSignal);
      } catch (error) {
        if (operationSignal.aborted) return preCommitAbort(error);
        throw error;
      }
      if (
        credentials.apiKey.length === 0 ||
        (request.kind === "workout-archive" && credentials.athleteId.length === 0)
      ) {
        return refused("not-configured");
      }
      const maximumBytes =
        request.kind === "activity" ? maximumActivityBytes : maximumWorkoutArchiveBytes;
      let responseLimitExceeded = false;
      const client = createClient({
        apiKey: credentials.apiKey,
        athleteId: credentials.athleteId,
        signal: operationSignal,
        baseFetch: createBoundedTrainingExportFetch({
          baseFetch: input.baseFetch ?? globalThis.fetch,
          maximumBytes,
          noteLimitExceeded: () => {
            responseLimitExceeded = true;
          },
        }),
      });
      let result: Result<BinaryDownload>;
      try {
        result =
          request.kind === "activity"
            ? await awaitWithSignal(
                downloadActivity(client, providerActivityId!, request.format),
                operationSignal,
              )
            : await awaitWithSignal(
                client.workouts.downloadZip({
                  format: request.format,
                  oldest: request.oldest,
                  newest: request.newest,
                  includeMetadata: true,
                }),
                operationSignal,
              );
      } catch (error) {
        if (operationSignal.aborted) return preCommitAbort(error);
        return refused(responseLimitExceeded ? "response-too-large" : "provider-unavailable");
      }
      try {
        operationSignal.throwIfAborted();
      } catch (error) {
        return preCommitAbort(error);
      }
      if (!result.ok) return refused(providerRefusal(result.error, responseLimitExceeded));
      if (
        !(result.value.bytes instanceof ArrayBuffer) ||
        result.value.bytes.byteLength < 1 ||
        result.value.bytes.byteLength > maximumBytes
      ) {
        return refused(
          result.value.bytes.byteLength > maximumBytes ? "response-too-large" : "invalid-response",
        );
      }
      if (!contentTypeMatches(request, result.value.contentType)) {
        return refused("invalid-response");
      }
      const metadata = resultMetadata(result.value);
      const bytes = new Uint8Array(result.value.bytes);
      let writerOwnsBytes = false;
      try {
        if (!contentBytesMatch(request, bytes)) return refused("invalid-response");
        let outcome: TrainingExportWriteOutcome;
        try {
          operationSignal.throwIfAborted();
        } catch (error) {
          return preCommitAbort(error);
        }
        try {
          const write = writer.write({
            destinationPath: request.destinationPath,
            bytes,
            signal: operationSignal,
          });
          writerOwnsBytes = true;
          void write
            .finally(() => bytes.fill(0))
            .then(
              () => undefined,
              () => undefined,
            );
          outcome = await awaitWithSignal(write, operationSignal);
        } catch {
          if (operationSignal.aborted) return refused("commit-uncertain");
          return refused("write-failed");
        }
        // A successful rename is the commit point. If the caller disconnects while the
        // file is being published, report the committed result rather than encouraging
        // an unsafe retry that could overwrite the file.
        if (outcome !== "committed") {
          if (outcome === "failed" && operationSignal.aborted) {
            return preCommitAbort(operationSignal.reason);
          }
          return refused(outcome === "uncertain" ? "commit-uncertain" : "write-failed");
        }
        return ExportTrainingFileRpcResultSchema.parse({
          status: "exported",
          byteLength: bytes.byteLength,
          ...metadata,
        });
      } finally {
        // Once handed off, the writer may still be using the buffer after the
        // service has conservatively reported commit uncertainty. Its settlement
        // handler owns zeroization so the bytes cannot change underneath it.
        if (!writerOwnsBytes) bytes.fill(0);
      }
    },
  });
}
