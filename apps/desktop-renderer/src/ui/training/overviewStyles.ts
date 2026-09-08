export const overviewStyles = {
  periodGroup: "flex items-center gap-inset max-[761px]:gap-1",
  periodButton: "border-line-2 bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
  weekSection: "min-w-0",
  ridesSection: "mt-7 min-w-0",
  moreHistory: "mt-3.5 flex justify-center",
  moreHistoryButton: "border-line-2 bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
  historyRideList: "m-0 list-none p-0",
  historyEmpty: "m-0 py-3.5 text-sm leading-5 text-ink-2",
  truncation: "mt-3 text-xs leading-5 text-ink-3",
  importStatus: "mt-7 border-t border-line pt-3.5 [&>h2]:m-0 [&>h2]:text-sm [&>h2]:font-semibold",
  meta: "m-0 [overflow-wrap:anywhere] text-xs leading-[1.45] text-ink-2",
  support: "mt-2 [overflow-wrap:anywhere] text-sm leading-[1.45] text-ink-2",
  empty: "m-0 text-sm leading-[1.45] text-ink-2",
  srOnly: "sr-only",
  progressNotice:
    "mb-3.5 border-l-[3px] border-warn bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] px-[11px] py-[9px] text-xs leading-6 text-ink-2",
  progressHeader:
    "flex min-w-0 items-start justify-between gap-3 [&>div]:min-w-0 [&_.training-badge]:m-0 [&_.training-badge]:shrink-0",
  progressLead: "mb-[5px] text-sm leading-5 font-semibold text-ink",
  progressTableWrap: "training-progress-table-wrap mt-3.5 min-w-0 overflow-x-auto",
  progressTable:
    "w-full min-w-[390px] border-separate border-spacing-0 tabular-nums [&_th]:border-b [&_th]:border-line [&_th]:px-2 [&_th]:py-[9px] [&_th]:text-right [&_td]:border-b [&_td]:border-line [&_td]:px-2 [&_td]:py-[9px] [&_td]:text-right [&_thead_th]:pt-0 [&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:tracking-normal [&_thead_th]:text-ink-3 [&_th:first-child]:pl-0 [&_th:first-child]:text-left [&_td:first-child]:pl-0 [&_td:first-child]:text-left [&_th:last-child]:pr-0 [&_td:last-child]:pr-0 [&_tbody_th]:relative [&_tbody_th]:text-xs [&_tbody_th]:leading-4 [&_tbody_th]:font-semibold [&_tbody_th]:text-ink [&_tbody_th::before]:mr-[9px] [&_tbody_th::before]:inline-block [&_tbody_th::before]:h-[18px] [&_tbody_th::before]:w-[3px] [&_tbody_th::before]:rounded-sm [&_tbody_th::before]:bg-ink [&_tbody_th::before]:align-middle [&_tbody_th::before]:opacity-25 [&_tbody_th::before]:content-[''] [&_tbody_tr:nth-child(1)_th::before]:opacity-100 [&_tbody_tr:nth-child(2)_th::before]:opacity-80 [&_tbody_tr:nth-child(3)_th::before]:opacity-60 [&_tbody_tr:nth-child(4)_th::before]:opacity-40 [&_tbody_td]:text-xs [&_tbody_td]:leading-4 [&_tbody_td]:text-ink-2 [&_tbody_td:nth-child(2)]:font-semibold [&_tbody_td:nth-child(2)]:text-ink",
  progressChange: "data-[tone=positive]:text-ok data-[tone=negative]:text-warn",
  progressDetails:
    "mt-3.5 text-xs text-ink-2 [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:font-semibold [&_summary]:focus-visible:outline-2 [&_summary]:focus-visible:outline-offset-[3px] [&_summary]:focus-visible:outline-ink [&_.training-progress-table-wrap]:mt-2.5",
  heartRateTable: "[&_tbody_th::before]:opacity-45",
  progressFoot: "mt-3.5 text-xs leading-6 text-ink-3",
  badge:
    "training-badge mt-1 mb-2 inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-chip bg-surface-2 px-1.5 text-xs font-medium text-ink-2 capitalize data-[band=aging]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[band=aging]:text-warn data-[band=stale]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[band=stale]:text-warn data-[band=very-stale]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[band=very-stale]:text-warn data-[freshness=flag]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[freshness=flag]:text-warn data-[freshness=stale]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[freshness=stale]:text-warn data-[freshness=critical]:bg-[color-mix(in_srgb,var(--warn)_var(--tint),transparent)] data-[freshness=critical]:text-warn",
  exportControls:
    "mt-3 flex flex-wrap items-center gap-[9px] [&_label]:text-xs [&_label]:text-ink-2",
  exportStatus: "mt-2.5 text-xs leading-[1.45] text-ink-2",
  analysisPanel: "mt-3.5 rounded-card border border-line bg-surface p-5 shadow-elev-1",
  analysisTitle: "m-0 text-xl leading-6 font-semibold tracking-normal",
  analysisIntro: "mt-[9px] max-w-[650px] text-xs leading-6 text-ink-2",
} as const;
