import type { MemoryStorePort } from "../host-ports.js";
import type { SourceProvenance } from "../provenance.js";

export const COMPACTION_SUMMARY_MARKER = "### Compaction summary";
export const COMPACTION_SUMMARY_END_MARKER = "### End of compaction summary";

export function demoteSummaryHeadings(summary: string): string {
  return summary.replace(/^## (?!#)/gm, "#### ");
}

export function formatCompactionNote(summary: string): string {
  return `${COMPACTION_SUMMARY_MARKER}\n\n${demoteSummaryHeadings(summary)}\n${COMPACTION_SUMMARY_END_MARKER}`;
}

export function persistCompactionSummary(
  memory: Pick<MemoryStorePort, "appendDailyNote">,
  summary: string,
  provenance?: SourceProvenance,
): void {
  if (summary.trim() === "") return;
  memory.appendDailyNote(formatCompactionNote(summary), undefined, provenance);
}
