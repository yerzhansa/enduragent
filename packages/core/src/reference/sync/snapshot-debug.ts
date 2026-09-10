import { escapeHtmlText } from "../../channels/html-escape.js";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { cliPhrasebook } from "../../cli-copy.js";
import {
  SNAPSHOT_DOCUMENT_THRESHOLD_BYTES,
  SNAPSHOT_DOCUMENT_THRESHOLD_CHUNKS,
} from "../freshness.js";
import type { LatestJson } from "../schemas/latest.js";
import { GARMIN_DATA_ATTRIBUTION } from "../../agent/garmin-attribution.js";
import { EMPTY_PROVENANCE, type SourceProvenance } from "../../provenance.js";
import { provenanceForLatest, provenanceForLatestSection } from "../source-provenance.js";

const TELEGRAM_MAX_CHUNK = 4096;
// Each chunk is a code fence the Telegram HTML path renders as an escaped
// <pre> block (the snapshot reply runs every chunk through markdownToTelegramHtml).
const FENCE_OPEN = "```\n";
const FENCE_CLOSE = "\n```";
const ATTRIBUTION_PREFIX = `${GARMIN_DATA_ATTRIBUTION}\n\n`;
const ATTRIBUTED_FENCE_PREFIX = `${ATTRIBUTION_PREFIX}${FENCE_OPEN}`;
// Room the rendered `<pre>${escapeHtmlText(body)}</pre>` leaves for the body.
// The trailing `-1` reserves the leading `\n` of FENCE_CLOSE: FENCE_RE captures
// `slice + "\n"` as the fence body, so the restored <pre> carries one extra char
// the `<pre></pre>` overhead alone doesn't account for.
const renderedBudget = (attributed: boolean): number =>
  TELEGRAM_MAX_CHUNK - (attributed ? ATTRIBUTION_PREFIX.length : 0) - "<pre></pre>".length - 1;

const VALID_SECTIONS: readonly (keyof LatestJson)[] = [
  "athlete_profile",
  "current_status",
  "derived_metrics",
  "recent_activities",
  "planned_workouts",
  "wellness_data",
  "metadata",
];

export type SnapshotOutput =
  | {
      readonly kind: "chunks";
      readonly chunks: readonly string[];
      readonly provenance?: SourceProvenance;
    }
  | {
      readonly kind: "document";
      readonly buffer: Buffer;
      readonly filename: string;
      /** Same body re-chunked, for the handler's document→chunks fall-through. */
      readonly chunks: readonly string[];
      readonly provenance?: SourceProvenance;
    };

/**
 * Format `latest.json` for the operator's `/snapshot raw` debug command.
 * Returns either chunked Telegram-friendly markdown or a single-document
 * upload buffer when the dump exceeds the configured thresholds. The handler
 * dispatches on `kind` to call `ctx.reply` vs `bot.api.sendDocument`.
 */
export function formatSnapshotRaw(
  latest: LatestJson | null,
  section?: string,
  book: Phrasebook = cliPhrasebook(),
): SnapshotOutput {
  if (latest === null) {
    return {
      kind: "chunks",
      chunks: [book.say("telegram.snapshot.notSynced", { command: "/sync" })],
      provenance: EMPTY_PROVENANCE,
    };
  }

  if (section !== undefined) {
    const key = section.toLowerCase();
    if (!VALID_SECTIONS.includes(key as keyof LatestJson)) {
      return {
        kind: "chunks",
        chunks: [
          book.say("telegram.snapshot.unknownSection", {
            section,
            sections: VALID_SECTIONS.join(", "),
          }),
        ],
        provenance: EMPTY_PROVENANCE,
      };
    }
    const value = (latest as Record<string, unknown>)[key];
    const provenance =
      key === "metadata"
        ? EMPTY_PROVENANCE
        : provenanceForLatestSection(
            latest,
            key as Exclude<
              keyof LatestJson,
              "metadata" | "derived_metrics_meta" | "source_provenance"
            >,
          );
    return wrap(JSON.stringify(value, null, 2), provenance);
  }

  return wrap(JSON.stringify(latest, null, 2), provenanceForLatest(latest));
}

function wrap(body: string, provenance: SourceProvenance): SnapshotOutput {
  const totalBytes = Buffer.byteLength(body, "utf8");
  const chunks = splitIntoChunks(body, provenance.garmin);

  // Body containing "```" would close the outer ```json…``` Markdown fence
  // prematurely, producing a Telegram 400 (parse-mode error) or rendered
  // garbage. Force document mode in that case to side-step Markdown escaping
  // entirely. Realistic trigger: an athlete's intervals.icu activity name or
  // description that includes a code block (mirrored from Strava etc.).
  const containsFenceBreaker = body.includes("```");

  if (
    containsFenceBreaker ||
    totalBytes > SNAPSHOT_DOCUMENT_THRESHOLD_BYTES ||
    chunks.length > SNAPSHOT_DOCUMENT_THRESHOLD_CHUNKS
  ) {
    return asDocument(body, chunks, provenance);
  }
  return { kind: "chunks", chunks, provenance };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// Each emitted chunk is a code fence the HTML path restores as
// `<pre>${escapeHtmlText(body)}</pre>`. Budget by the RENDERED length, not the
// raw length: a slice dense with `& < >` expands under escaping (`&`→`&amp;` is
// +4), so a raw-length budget could render a <pre> past Telegram's 4096 limit,
// and the converter's own chunker would then re-split it — breaking the 1:1
// raw→sent mapping the snapshot retry relies on. Growing the slice until the
// rendered <pre> would overflow guarantees one sub-chunk out per raw chunk.
function splitIntoChunks(body: string, attributed: boolean): readonly string[] {
  const out: string[] = [];
  const budget = renderedBudget(attributed);
  let i = 0;
  while (i < body.length) {
    let rendered = 0;
    let j = i;
    while (j < body.length) {
      const next = escapeHtmlText(body[j]).length;
      if (rendered + next > budget) break;
      rendered += next;
      j++;
    }
    // Don't cut between the halves of a surrogate pair (but always make progress).
    if (j > i + 1 && j < body.length && isHighSurrogate(body.charCodeAt(j - 1))) j--;
    // A single char can never exceed the budget, so j always advances past i.
    const prefix = attributed ? ATTRIBUTED_FENCE_PREFIX : FENCE_OPEN;
    out.push(`${prefix}${body.slice(i, j)}${FENCE_CLOSE}`);
    i = j;
  }
  return out;
}

export function snapshotChunkToTelegramHtml(chunk: string): string {
  const attributed = chunk.startsWith(ATTRIBUTED_FENCE_PREFIX);
  const prefix = attributed ? ATTRIBUTED_FENCE_PREFIX : FENCE_OPEN;
  if (!chunk.startsWith(prefix) || !chunk.endsWith(FENCE_CLOSE)) {
    throw new Error("Invalid snapshot data chunk");
  }
  const body = chunk.slice(prefix.length, -FENCE_CLOSE.length);
  return `${attributed ? escapeHtmlText(ATTRIBUTION_PREFIX) : ""}<pre>${escapeHtmlText(`${body}\n`)}</pre>`;
}

function asDocument(
  body: string,
  chunks: readonly string[],
  provenance: SourceProvenance,
): SnapshotOutput {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    kind: "document",
    buffer: Buffer.from(body, "utf8"),
    filename: `snapshot-${ts}.json`,
    chunks,
    provenance,
  };
}
