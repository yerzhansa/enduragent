export const LEDGER_EVENT_KINDS = [
  "decision",
  "override",
  "illness",
  "experiment",
  "outcome",
] as const;
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

export const LEDGER_EVENT_SOURCES = ["flush", "chat"] as const;
export type LedgerEventSource = (typeof LEDGER_EVENT_SOURCES)[number];

export const LEDGER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface LedgerEventInput {
  readonly date: string;
  readonly kind: LedgerEventKind;
  readonly text: string;
  readonly source: LedgerEventSource;
}
