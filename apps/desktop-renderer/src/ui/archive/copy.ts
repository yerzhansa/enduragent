import { msg, type Message } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";

export const ARCHIVE_TITLE = msg("archive.title");
export const ARCHIVE_READ_ONLY_NOTE = msg("archive.readOnly");
export const ARCHIVE_EMPTY_COPY = msg("archive.empty");
export const ARCHIVE_LOADING_COPY = msg("archive.loading");
export const ARCHIVE_LIST_FAILURE_COPY = msg("archive.listFailure");
export const ARCHIVE_PAGE_FAILURE_COPY = msg("archive.pageFailure");
export const ARCHIVE_UNAVAILABLE_COPY = msg("archive.unavailable");
export const ARCHIVE_TRUNCATED_COPY = msg("archive.truncated");
export const ARCHIVE_BACK_COPY = msg("archive.back");
export const ARCHIVE_LOAD_EARLIER_COPY = msg("archive.loadEarlier");
export const ARCHIVE_RETRY_COPY = msg("archive.retry");
export const ARCHIVE_EMPTY_CONVERSATION_COPY = msg("archive.emptyConversation");
export const ARCHIVE_DELETE_COPY = msg("archive.delete.action");
export const ARCHIVE_DELETE_TITLE = msg("archive.delete.title");
export const ARCHIVE_DELETE_DESCRIPTION = msg("archive.delete.description");
export const ARCHIVE_DELETE_FAILURE_COPY = msg("archive.delete.failure");

export function archiveReasonCopy(reason: "explicit-reset" | "stale-reset"): Message {
  return reason === "explicit-reset" ? msg("archive.reason.explicit") : msg("archive.reason.stale");
}

export function archiveTurnCountCopy(turnCount: number, formattedCount: string): Message {
  return msg("archive.turnCount", { count: turnCount, formattedCount });
}

export function archiveTimestampCopy(value: string, format: Phrasebook["format"]): Message {
  const number = (part: string, digits: number): string =>
    format.number(Number(part), {
      useGrouping: false,
      minimumIntegerDigits: digits,
    });
  return msg("archive.timestamp", {
    year: number(value.slice(0, 4), 4),
    month: number(value.slice(5, 7), 2),
    day: number(value.slice(8, 10), 2),
    hour: number(value.slice(11, 13), 2),
    minute: number(value.slice(14, 16), 2),
    timezone: "UTC",
  });
}
