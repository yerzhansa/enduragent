import type { Phrasebook } from "@enduragent/i18n/messages";
import { cliPhrasebook } from "../../cli-copy.js";
import type { SyncResult } from "./run-sync.js";

export const STRAVA_RESTRICTION_TELEGRAM_COPY = Object.freeze({
  notice(count: number, total: number, book: Phrasebook = cliPhrasebook()): string {
    return book.say("telegram.sync.restricted", {
      count,
      number: book.format.number(count, { useGrouping: false }),
      total: book.format.number(total, { useGrouping: false }),
      source: "Strava",
      service: "intervals.icu",
      importAction: "Import All Strava Data",
    });
  },
});

/**
 * Render a `SyncResult` as athlete-facing prose for the `/sync` Telegram
 * reply. Spec shape:
 *
 * ```
 * Sync ✅
 * Last sync: 2026-05-09 14:23 UTC (32s ago)
 * Refreshed: latest, history, intervals, routes, ftp_history
 * ```
 *
 * Plus cooldown / mutex_held / unreachable variants. Pure function over a
 * clock so tests can pin "now."
 */
export function formatSyncReply(
  result: SyncResult,
  now: Date = new Date(),
  book: Phrasebook = cliPhrasebook(),
): string {
  switch (result.kind) {
    case "skipped":
      switch (result.reason) {
        case "cooldown":
          return book.say("telegram.sync.cooldown", {
            seconds: book.format.number(Math.ceil((result.retryAfterMs ?? 0) / 1000), {
              useGrouping: false,
            }),
          });
        case "mutex_held":
          return book.say("telegram.sync.running", { minutes: book.format.number(2) });
        default: {
          const _exhaustive: never = result;
          throw new Error(`formatSyncReply: unhandled skipped reason ${String(_exhaustive)}`);
        }
      }
    case "failed":
      // `outer_timeout`, `gate_rejected`, and `fetch_failed` all surface to
      // athletes as the same "can't reach" message today. The future curator
      // will inspect `error_state.json` and may inject more specific guidance.
      switch (result.reason) {
        case "outer_timeout":
        case "gate_rejected":
        case "fetch_failed":
          return book.say("telegram.sync.unreachable", { service: "intervals.icu" });
        default: {
          const _exhaustive: never = result;
          throw new Error(`formatSyncReply: unhandled failed reason ${String(_exhaustive)}`);
        }
      }
    case "ran": {
      const lastLine = book.say("telegram.sync.lastSync", {
        timestamp: formatTimestamp(result.lastSyncAt, now, book),
      });
      // The content-hash short-circuit returns `refreshed: []` on a genuine
      // no-op cycle; rendering a bare "Refreshed: " label would be a dangling
      // line, so say nothing-changed instead.
      const detailLine =
        result.refreshed.length === 0
          ? book.say("telegram.sync.unchanged")
          : book.say("telegram.sync.refreshed", { sections: result.refreshed.join(", ") });
      const stravaRestriction = result.droppedActivities.overall.restrictions.find((entry) => {
        switch (entry.reason) {
          case "source-restricted":
            return entry.source === "STRAVA";
          default: {
            const _exhaustive: never = entry.reason;
            throw new Error(
              `formatSyncReply: unhandled activity restriction ${String(_exhaustive)}`,
            );
          }
        }
      });
      const restrictionLine =
        stravaRestriction === undefined
          ? null
          : STRAVA_RESTRICTION_TELEGRAM_COPY.notice(
              stravaRestriction.count,
              result.droppedActivities.overall.total,
              book,
            );
      return [book.say("telegram.sync.complete"), lastLine, detailLine, restrictionLine]
        .filter(Boolean)
        .join("\n");
    }
    default: {
      const _exhaustive: never = result;
      throw new Error(`formatSyncReply: unhandled SyncResult kind ${String(_exhaustive)}`);
    }
  }
}

// Display flags any meaningful future-dating of the cache stamp. Deliberately
// tighter than freshness.ts's FUTURE_TOLERANCE_MS (5 min): the staleness
// classifier tolerates benign sub-tolerance skew, but the human-facing line
// should surface even a small clock disagreement rather than print "0s ago".
const FUTURE_DISPLAY_THRESHOLD_MS = 1000;

function formatTimestamp(iso: string, now: Date, book: Phrasebook): string {
  const d = new Date(iso);
  const deltaMs = now.getTime() - d.getTime();
  const date = (options: Intl.DateTimeFormatOptions) =>
    book.format.date(d, { ...options, timeZone: "UTC" });
  const utc = `${date({ year: "numeric" })}-${date({ month: "2-digit" })}-${date({ day: "2-digit" })} ${date({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} UTC`;
  if (deltaMs < -FUTURE_DISPLAY_THRESHOLD_MS) {
    // A future timestamp means the cache stamp is ahead of the wall clock —
    // almost always clock skew. Word it honestly instead of clamping to "0s ago".
    return book.say("telegram.sync.future", { timestamp: utc });
  }
  const diffSec = Math.round(Math.max(0, deltaMs) / 1000);
  const ago =
    diffSec < 60
      ? book.say("telegram.sync.secondsAgo", {
          seconds: book.format.number(diffSec, { useGrouping: false }),
        })
      : diffSec < 3600
        ? book.say("telegram.sync.minutesAgo", {
            minutes: book.format.number(Math.round(diffSec / 60), { useGrouping: false }),
          })
        : book.say("telegram.sync.hoursAgo", {
            hours: book.format.number(Math.round(diffSec / 3600), { useGrouping: false }),
          });
  return book.say("telegram.sync.elapsed", { timestamp: utc, elapsed: ago });
}
