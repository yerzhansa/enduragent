export const settingsStyles = {
  heading:
    "settings-heading mx-1 mt-[26px] mb-2 text-[11px] font-normal tracking-[0.07em] text-ink-3 uppercase first:mt-0",
  group:
    "settings-group rounded-card border border-line bg-surface shadow-elev-1 [&>*:last-child]:border-b-0 data-[cap-status=reached]:[&_progress::-webkit-progress-value]:bg-danger",
  row: "settings-row flex items-center gap-4 border-b border-line px-4 py-[13px]",
  rowStacked: "flex-col! items-stretch! gap-2!",
  label: "settings-label flex min-w-0 flex-1 flex-col items-stretch",
  rowTitle: "settings-row-title text-sm font-semibold",
  rowDetail: "settings-row-detail mt-px text-[12.5px] text-ink-2",
  dangerTitle: "text-danger!",
  actions: "flex flex-wrap justify-end gap-2 border-t border-line px-4 py-[13px]",
  control:
    "h-ctl w-full min-w-0 max-w-[260px] shrink-0 rounded-ctl border border-input bg-background px-ctl-px text-sm text-foreground shadow-elev-1 outline-none placeholder:text-ink-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 disabled:opacity-64 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
  controlWide: "max-w-none!",
  feedback: "m-0 border-t border-line px-4 py-[11px] text-[12.5px] text-ink-2",
  error: "mt-1 mb-0 text-[12.5px] text-danger",
  help: "mt-1 mb-0 text-[12.5px] text-ink-2",
  note: "m-0 border-b border-line px-4 py-[13px] text-[13px] text-ink-2",
  empty: "m-0 px-4 py-[13px] text-[13px] text-ink-2",
  runtime:
    "inline-flex h-5 shrink-0 items-center justify-center gap-1 rounded-chip bg-surface-2 px-1.5 text-xs font-medium text-ink-2 data-[state=active]:bg-[color-mix(in_srgb,var(--ok)_var(--tint),transparent)] data-[state=active]:text-ok data-[state=failed]:bg-[color-mix(in_srgb,var(--danger)_var(--tint),transparent)] data-[state=failed]:text-danger",
  bareRow: "flex w-full items-center gap-4",
  meter:
    "block h-[3px] w-full appearance-none overflow-hidden rounded-full border-0 bg-line [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-line [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-ok",
  updateProgressTrack: "h-[3px] w-full overflow-hidden rounded-full bg-line",
  updateProgressFill:
    "h-full rounded-full bg-brand transition-[width] duration-300 motion-reduce:transition-none",
  updateProgressIndeterminate: "h-full rounded-full bg-brand update-progress-indeterminate",
  capError: "flex-[1_0_100%]!",
  amount: "shrink-0 text-[13px] tabular-nums",
  routes: "px-4 pb-1",
  route: "border-b border-line py-[11px] last:border-b-0",
  routeHeading: "m-0 text-[13px] font-semibold",
  routeDetail: "mt-[3px] mb-0 text-[12.5px] text-ink-2",
  capEditor: "flex flex-wrap items-center gap-2 border-t border-line px-4 py-[13px]",
  capLabel: "min-w-0 flex-1 text-sm font-semibold",
  srOnly: "sr-only",
  dialog:
    "new-settings-dialog m-auto w-[min(520px,calc(100vw-48px))] max-w-none max-h-[min(70vh,620px)] rounded-card border border-line-2 bg-surface p-5 text-ink shadow-elev-4 backdrop:bg-[var(--scrim)]",
  dialogHeader: "flex items-baseline justify-between gap-3 [&_h2]:m-0 [&_h2]:text-[15px]",
  dialogContent: "mt-3 text-[13.5px] text-ink-2 [&_ol]:m-0 [&_ol]:pl-5 [&_li]:mb-1.5",
  dialogActions:
    "mt-4 flex items-center justify-end gap-2.5 [&_a]:text-[13px] [&_a]:text-ink [&_a]:underline [&_a]:underline-offset-4",
} as const;
