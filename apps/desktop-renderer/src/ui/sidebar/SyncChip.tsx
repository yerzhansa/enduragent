import type { Message } from "@enduragent/i18n";
import { msg } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
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
  SYNC_RUNNING_COPY,
  type ManualSyncViewState,
} from "../../training-context/manual-sync";
import { InfoTip } from "../onboarding/InfoTip";
import {
  focusTrainingRestrictionIfPresent,
  requestTrainingRestrictionFocus,
  STRAVA_HELP_HREF,
  STRAVA_RESTRICTION_CARD_ID,
} from "../settings/restriction-focus";

import { manualSyncActionMessage, manualSyncStatusMessage } from "./copy";

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
  if (sync.tone === "success") return "synced";
  if (training.metadata !== null && training.metadata.lastSynced !== null) return "synced";
  return "never";
}

const HEADLINE: Readonly<Record<SyncChipStatus, Message>> = {
  loading: msg("sidebar.sync.headline.loading"),
  syncing: msg("sidebar.sync.headline.syncing"),
  attention: msg("sidebar.sync.headline.attention"),
  synced: msg("sidebar.sync.headline.synced"),
  never: msg("sidebar.sync.headline.never"),
  unavailable: msg("sidebar.sync.headline.unavailable"),
};

export function SyncChip(): ReactElement {
  const { say, format } = usePhrasebook();
  const training = useEnduragentStore((store) => store.training);
  const sync = useEnduragentStore((store) => store.sync);
  const actions = useEnduragentStore((store) => store.syncActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const chip = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const status = syncChipStatus(training, sync);
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  const formattedCount = format.number(restriction?.count ?? 0, { useGrouping: false });
  const message = manualSyncStatusMessage(sync, formattedCount);
  const detail = message === null || sync.message === SYNC_RUNNING_COPY ? null : say(message);
  const action = sync.busy
    ? null
    : say(
        status === "synced"
          ? msg("sidebar.sync.action.again")
          : manualSyncActionMessage(sync.label),
      );
  const headline = say(HEADLINE[status]);
  const statusAnnouncement = detail ?? (sync.busy ? headline : null);
  const restrictionVars = { count: restriction?.count ?? 0, formattedCount, source: "Strava" };
  const restrictionLabel =
    restriction === null
      ? null
      : say("sidebar.sync.restriction.label", { ...restrictionVars, count: restriction.count });

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
        disabled={sync.disabled || actions === null}
        aria-label={
          action === null
            ? headline
            : detail === null
              ? say("sidebar.sync.ariaLabel", { action, headline })
              : say("sidebar.sync.ariaLabelDetail", { action, headline, detail })
        }
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
        <span
          className={status === "synced" ? "sr-only" : "block whitespace-normal"}
          data-sync-headline=""
          aria-hidden="true"
        >
          {headline}
        </span>
        <span
          className={cn(
            detail === null || status === "synced"
              ? "sr-only"
              : "mt-px block whitespace-normal text-ink-3",
          )}
          data-sync-detail=""
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusAnnouncement}
        </span>
        {restriction === null ? null : (
          <InfoTip
            label={say("sidebar.sync.restriction.tooltipLabel")}
            lead={say("sidebar.sync.restriction.tooltipLead", {
              ...restrictionVars,
              count: restriction.count,
            })}
            trigger={
              <a
                href={`#${STRAVA_RESTRICTION_CARD_ID}`}
                aria-label={say("sidebar.sync.restriction.fixLabel", {
                  restrictionLabel: restrictionLabel ?? "",
                })}
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
                  {say("sidebar.sync.restriction.fixAction")}
                </span>
              </>
            }
            body={
              <div className="grid gap-1.5">
                <p className="m-0">
                  {say("sidebar.sync.restriction.tooltipBody", {
                    source: "Strava",
                  })}
                </p>
                <a
                  className="font-medium text-brand underline-offset-2 hover:underline"
                  href={STRAVA_HELP_HREF}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  {say("settings.athlete.restriction.helpAction")}
                </a>
              </div>
            }
          />
        )}
        {action === null ? null : (
          <span
            className="mt-px block whitespace-normal text-xs text-ink-3"
            data-sync-action=""
            aria-hidden="true"
          >
            {action}
          </span>
        )}
      </span>
    </div>
  );
}
