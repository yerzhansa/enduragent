import { useEffect, useRef, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { cn } from "@enduragent/ui";
import {
  setManualSyncFocusFallback,
  setManualSyncFocusTarget,
} from "../../state/manual-sync-focus";
import { useEnduragentStore } from "../../state/store";
import type { TrainingContextViewState } from "../../training-context/controller";
import {
  sourceRestrictionSummary,
  STRAVA_RESTRICTION_DESKTOP_COPY,
  type ManualSyncViewState,
} from "../../training-context/manual-sync";
import { formatUtcTimestamp } from "../../training-context/format";
import { InfoTip } from "../onboarding/InfoTip";
import {
  focusTrainingRestrictionIfPresent,
  requestTrainingRestrictionFocus,
  STRAVA_RESTRICTION_CARD_ID,
} from "../settings/restriction-focus";

type SyncChipStatus = "loading" | "syncing" | "attention" | "synced" | "never" | "unavailable";

function syncChipStatus(
  training: TrainingContextViewState,
  sync: ManualSyncViewState,
): SyncChipStatus {
  if (sync.busy) return "syncing";
  if (sync.tone === "failure" || sync.tone === "partial") return "attention";
  if (training.status === "loading") return "loading";
  if (training.status === "refresh-unavailable") return "attention";
  if (training.status === "unavailable") return "unavailable";
  if (training.metadata !== null && training.metadata.lastSynced !== null) return "synced";
  return "never";
}

const HEADLINE: Readonly<Record<SyncChipStatus, string>> = {
  loading: "Loading training data",
  syncing: "Syncing",
  attention: "Sync needs attention",
  synced: "Training data synced",
  never: "Not synced yet",
  unavailable: "Training data unavailable",
};

export function SyncChip(): ReactElement {
  const training = useEnduragentStore((store) => store.training);
  const sync = useEnduragentStore((store) => store.sync);
  const actions = useEnduragentStore((store) => store.syncActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const chip = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const status = syncChipStatus(training, sync);
  const synced = training.metadata?.lastSynced ?? null;
  const syncedDetail = status === "synced" && synced !== null ? formatUtcTimestamp(synced) : null;
  const detail = sync.message === "" ? syncedDetail : sync.message;
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  const restrictionLabel =
    restriction === null
      ? null
      : restriction.count === 1
        ? "1 hidden by Strava"
        : `${restriction.count} hidden by Strava`;

  useEffect(() => {
    setManualSyncFocusFallback(wrapper.current);
    return () => setManualSyncFocusFallback(null);
  }, []);

  return (
    <div
      ref={wrapper}
      tabIndex={-1}
      className="relative grid min-h-ctl min-w-0 w-full grid-cols-[7px_minmax(0,1fr)] items-start gap-x-2 px-row py-1.5 text-left text-xs font-normal text-ink-2"
      data-sync-chip=""
      data-status={status}
    >
      <Button
        type="button"
        ref={chip}
        variant="ghost"
        size="default"
        className="sync-chip absolute inset-0 z-0 h-auto w-full p-0"
        data-status={status}
        title={restriction === null || syncedDetail === null ? undefined : syncedDetail}
        disabled={sync.disabled || actions === null}
        aria-label={[sync.label, HEADLINE[status], detail].filter(Boolean).join(" · ")}
        onClick={(event) => {
          const keyboard = event.detail === 0;
          setManualSyncFocusTarget(keyboard ? chip.current : null);
          actions?.request(keyboard ? "keyboard" : "pointer");
        }}
      />
      <span
        className={cn(
          "pointer-events-none relative z-[1] mt-[5px] size-[7px] rounded-full bg-ink-3",
          status === "synced" && "bg-ok",
          status === "syncing" && "bg-ink-2",
          (status === "attention" || status === "unavailable") && "bg-warn",
        )}
        data-status={status}
        aria-hidden="true"
      />
      <span className="pointer-events-none relative z-[1] min-w-0">
        <span className="block whitespace-normal" data-sync-headline="" aria-hidden="true">
          {HEADLINE[status]}
        </span>
        <span
          className={cn(detail === null ? "sr-only" : "mt-px block whitespace-normal text-ink-3")}
          data-sync-detail=""
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {detail}
        </span>
        {restriction === null ? null : (
          <InfoTip
            label="Why are activities hidden?"
            lead={STRAVA_RESTRICTION_DESKTOP_COPY.tooltipLead(restriction.count)}
            trigger={
              <a
                href={`#${STRAVA_RESTRICTION_CARD_ID}`}
                aria-label={`${restrictionLabel}. How to fix this`}
                className="pointer-events-auto mt-px flex w-full min-w-0 flex-wrap items-center gap-x-1 text-[11px] leading-4 no-underline"
                data-sync-restriction=""
                onClick={() => {
                  setActiveView("settings");
                  requestTrainingRestrictionFocus();
                  focusTrainingRestrictionIfPresent(
                    document.getElementById(STRAVA_RESTRICTION_CARD_ID),
                  );
                }}
              />
            }
            triggerContent={
              <>
                <span className="text-warn">{restrictionLabel}</span>
                <span className="font-sans text-brand underline-offset-2 hover:underline">
                  · How to fix this
                </span>
              </>
            }
            body={STRAVA_RESTRICTION_DESKTOP_COPY.tooltipBody}
          />
        )}
        <span
          className="mt-px block whitespace-normal text-xs text-ink-3"
          data-sync-action=""
          aria-hidden="true"
        >
          {sync.label}
        </span>
      </span>
    </div>
  );
}
