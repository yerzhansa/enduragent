import { overviewStyles } from "./overviewStyles";

export const rideStyles = {
  ...overviewStyles,
  rideBack: "bg-surface text-ink-2",
  rideOverview:
    "rounded-card border border-line bg-surface p-5 shadow-elev-1 [&_h2]:m-0 [&_h2]:mt-2 [&_h2]:text-2xl [&_h2]:leading-8 [&_h2]:font-semibold [&_h2]:tracking-normal",
  rideOverviewEyebrow: "m-0 text-xs font-semibold text-ink-3",
  elapsedFallback: "mt-2 text-xs leading-5 text-ink-3",
  keyStats:
    "mt-7 [&>h2]:m-0 [&>h2]:mb-row [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:tracking-normal",
  recordedDisclosureBody: "pb-3.5 [&>section:first-child]:mt-3.5",
  analysisPanel: overviewStyles.analysisPanel,
  analysisHeading:
    "flex items-start justify-between gap-4 [&_h2]:m-0 [&_h2]:text-xl [&_h2]:leading-6 [&_h2]:font-semibold [&_h2]:tracking-normal",
  analysisTitle: overviewStyles.analysisTitle,
  analysisIntro: overviewStyles.analysisIntro,
  analysisLoading: "mt-5 text-sm leading-[1.5] text-ink-2",
  analysisUnavailable:
    "[&_p]:mt-5 [&_p]:text-sm [&_p]:leading-[1.5] [&_p]:text-ink-2 [&_[data-slot=button]]:mt-3",
  analysisNotice:
    "mt-[18px] border-l-[3px] border-warn bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] px-[11px] py-[9px] text-xs leading-[1.5] text-ink-2",
  analysisRefresh: "mt-4 text-xs leading-[1.5] text-ink-2",
  driftReading:
    "mt-[22px] flex min-w-0 items-end justify-between gap-[22px] border-l-2 border-ink pl-[13px] max-[520px]:grid max-[520px]:items-start",
  driftValue: "m-0 text-2xl leading-8 font-semibold tracking-normal tabular-nums",
  driftContext:
    "grid min-w-0 justify-items-end gap-1.5 text-right max-[520px]:justify-items-start max-[520px]:text-left [&_p]:m-0 [&_p]:text-xs [&_p]:text-ink-3",
  driftEvidenceBadge:
    "inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-chip bg-surface-2 px-1.5 text-xs font-medium text-ink-2 data-[evidence=limited]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[evidence=limited]:text-warn",
  driftTrace:
    "mt-[18px] grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] items-stretch gap-2 max-[520px]:grid-cols-1",
  driftHalf:
    "min-w-0 rounded-card bg-sunk px-3.5 py-[13px] [&_h3]:m-0 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-ink-3",
  driftEf: "mt-2.5 text-lg leading-5 font-semibold tabular-nums",
  driftHalfStats: "mt-[7px] text-xs leading-[1.4] text-ink-2 tabular-nums",
  driftHalfMeta: "mt-1 [overflow-wrap:anywhere] text-xs leading-[1.4] text-ink-3 tabular-nums",
  driftConnector:
    "relative isolate grid place-items-center text-sm text-ink-3 before:absolute before:right-0 before:left-0 before:-z-10 before:h-px before:bg-line before:content-[''] max-[520px]:h-[18px] max-[520px]:rotate-90",
  driftCoverage: "mt-[13px] [overflow-wrap:anywhere] text-xs leading-[1.5] text-ink-3 tabular-nums",
  driftLimitations: "mt-[13px] grid gap-[5px] pl-[18px] text-xs leading-[1.45] text-ink-2",
  analysisSource: "mt-[17px] text-xs leading-[1.5] text-ink-3",
  analysisEmpty: "mt-4 text-sm leading-[1.5] text-ink-2",
  intervalList: "mt-3.5 grid list-none gap-[9px] p-0",
  intervalGroups:
    "mt-4 [&>h3]:m-0 [&>h3]:text-sm [&>h3]:font-semibold [&>p]:mt-1 [&>p]:text-xs [&>p]:leading-[1.45] [&>p]:text-ink-3",
  intervalGroupList: "mt-2.5 grid list-none gap-[9px] p-0",
  intervalGroupItem: "grid min-w-0 gap-3 rounded-card bg-sunk px-3.5 py-3",
  intervalGroupIdentity:
    "flex min-w-0 items-end justify-between gap-3 max-[520px]:flex-col max-[520px]:items-start [&>div]:grid [&>div]:min-w-0 [&>div]:gap-[3px] [&_span]:text-xs [&_span]:text-ink-3 [&_strong]:text-sm [&_strong]:font-semibold [&_p]:m-0 [&_p]:[overflow-wrap:anywhere] [&_p]:text-right [&_p]:text-xs [&_p]:leading-[1.3] [&_p]:text-ink-3 max-[520px]:[&_p]:text-left",
  intervalItem:
    "grid min-w-0 grid-cols-[minmax(155px,0.72fr)_minmax(0,1.6fr)] items-center gap-4 rounded-card border-l-[3px] border-line-2 bg-sunk px-3.5 py-[13px] data-[kind=recovery]:border-l-ink-3 data-[kind=work]:border-l-brand max-[761px]:grid-cols-1",
  intervalIdentity:
    "grid min-w-0 grid-cols-[27px_minmax(0,1fr)] items-start gap-2.5 [&_h3]:mt-1 [&_h3]:[overflow-wrap:anywhere] [&_h3]:text-sm [&_h3]:font-semibold [&_p]:mt-1 [&_p]:text-xs [&_p]:leading-[1.3] [&_p]:text-ink-3",
  intervalOrdinal:
    "grid size-[25px] place-items-center rounded-full border border-line-2 text-xs text-ink-2 tabular-nums",
  intervalKind: "text-xs text-ink-3",
  intervalMetrics:
    "m-0 grid min-w-0 grid-cols-4 gap-2.5 max-[761px]:grid-cols-2 max-[520px]:grid-cols-1 [&>div]:min-w-0 [&_dt]:text-xs [&_dt]:text-ink-3 [&_dd]:mt-[5px] [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-xs [&_dd]:leading-[1.4] [&_dd]:text-ink-2 [&_dd]:tabular-nums",
  effortList:
    "mt-3.5 grid list-none grid-cols-3 gap-[9px] p-0 max-[761px]:grid-cols-2 max-[520px]:grid-cols-1 [&_strong]:text-xl [&_strong]:leading-[1.1] [&_strong]:font-semibold [&_strong]:tabular-nums",
  effortItem:
    "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-[5px] rounded-card bg-sunk px-3.5 py-[13px] [&>span:last-child]:[overflow-wrap:anywhere] [&>span:last-child]:text-xs [&>span:last-child]:leading-[1.4] [&>span:last-child]:text-ink-3",
  effortRank: "row-span-2 row-start-1 text-xs text-ink-3",
  rideEyebrow: "mb-2 text-xs font-medium text-ink-3",
  rideSummary:
    "mt-[calc(var(--row-inset)+var(--inset))] grid grid-cols-3 gap-3.5 border-t border-line pt-3.5 max-[520px]:grid-cols-1 [&>div]:min-w-0 [&_dt]:mb-[5px] [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-ink-3 [&_dd]:m-0 [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-xs [&_dd]:leading-[1.45] [&_dd]:text-ink [&_dd]:tabular-nums",
} as const;
