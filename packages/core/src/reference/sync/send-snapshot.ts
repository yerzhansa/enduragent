import { GrammyError } from "grammy";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { cliPhrasebook } from "../../cli-copy.js";
import { snapshotChunkToTelegramHtml, type SnapshotOutput } from "./snapshot-debug.js";
import { retryWithBackoff } from "../../concurrency/retry.js";
import { GARMIN_DATA_ATTRIBUTION } from "../../agent/garmin-attribution.js";

/**
 * Outcome of sending a snapshot to Telegram. `sent` counts successful chunks
 * (or `1` for a successful document upload); `interrupted: true` means the
 * handler abandoned the loop after a retry failure.
 */
export interface SendOutcome {
  readonly sent: number;
  readonly total: number;
  readonly interrupted: boolean;
}

export interface SendDeps {
  readonly book?: Phrasebook;
  readonly reply: (text: string) => Promise<unknown>;
  readonly replyHtml: (html: string) => Promise<unknown>;
  readonly sendDocument?: (buffer: Buffer, filename: string, caption?: string) => Promise<unknown>;
  /** Injectable for tests; defaults to a real timeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TRANSIENT_BACKOFF_MS = 1_000;
/** Hard cap on `retry_after` to defend against malformed or pathological values. */
const MAX_RETRY_AFTER_SEC = 300;

/**
 * Send a `SnapshotOutput` to Telegram with single-retry on transient errors
 * (429 honors Grammy's `parameters.retry_after`; other errors sleep 1s).
 * Document mode falls through to chunked-with-retry on `sendDocument`
 * failure.
 */
export async function sendSnapshotOutput(
  output: SnapshotOutput,
  deps: SendDeps,
): Promise<SendOutcome> {
  const sleep = deps.sleep ?? defaultSleep;

  if (output.kind === "document") {
    if (deps.sendDocument !== undefined) {
      try {
        await deps.sendDocument(
          output.buffer,
          output.filename,
          output.provenance?.garmin === true ? GARMIN_DATA_ATTRIBUTION : undefined,
        );
        return { sent: 1, total: 1, interrupted: false };
      } catch {
        // Fall through to chunked reply with the same retry semantics below.
      }
    }
    return await sendChunks(
      output.chunks.map(snapshotChunkToTelegramHtml),
      deps.replyHtml,
      sleep,
      deps.reply,
      deps.book ?? cliPhrasebook(),
    );
  }

  return await sendChunks(
    output.chunks,
    deps.reply,
    sleep,
    deps.reply,
    deps.book ?? cliPhrasebook(),
  );
}

async function sendChunks(
  chunks: readonly string[],
  reply: SendDeps["reply"],
  sleep: (ms: number) => Promise<void>,
  reportInterrupted: SendDeps["reply"],
  book: Phrasebook,
): Promise<SendOutcome> {
  const total = chunks.length;
  let sent = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const ok = await trySendWithSingleRetry(chunk, reply, sleep);
    if (!ok) {
      await reportInterrupted(
        book.say("telegram.snapshot.interrupted", {
          chunk: book.format.number(i + 1, { useGrouping: false }),
          total: book.format.number(total, { useGrouping: false }),
          command: "/snapshot raw",
          sectionCommand: "/snapshot raw <section>",
        }),
      );
      return { sent, total, interrupted: true };
    }
    sent += 1;
  }
  return { sent, total, interrupted: false };
}

async function trySendWithSingleRetry(
  chunk: string,
  reply: SendDeps["reply"],
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  try {
    await retryWithBackoff(() => reply(chunk), {
      attempts: 2,
      baseMs: DEFAULT_TRANSIENT_BACKOFF_MS,
      capMs: MAX_RETRY_AFTER_SEC * 1_000,
      shouldRetry: () => true,
      // backoffMsFor is a validated lower bound (Telegram's retry_after, or the
      // default transient backoff); honor it exactly, with jitter disabled so the
      // single-retry delay stays deterministic.
      retryAfterMs: (err) => backoffMsFor(err),
      random: () => 0,
      sleep,
    });
    return true;
  } catch {
    return false;
  }
}

function backoffMsFor(err: unknown): number {
  if (err instanceof GrammyError && err.error_code === 429) {
    const retryAfter = err.parameters?.retry_after;
    // Reject NaN, Infinity, negatives, zero, and any value beyond the cap.
    // Telegram realistically returns small integer seconds; an Infinity or
    // pathological 999_999 would otherwise park us for ~25 days.
    if (
      typeof retryAfter === "number" &&
      Number.isFinite(retryAfter) &&
      retryAfter > 0 &&
      retryAfter <= MAX_RETRY_AFTER_SEC
    ) {
      return retryAfter * 1_000;
    }
  }
  return DEFAULT_TRANSIENT_BACKOFF_MS;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
