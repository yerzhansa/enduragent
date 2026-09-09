import type { Message } from "@enduragent/i18n";
import { msg } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
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
  type ManualSyncViewState,
} from "../../training-context/manual-sync";
import { formatUtcTimestamp } from "../../training-context/format";
import { InfoTip } from "../onboarding/InfoTip";
import {
  focusTrainingRestrictionIfPresent,
  requestTrainingRestrictionFocus,
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

function syncTimestamp(value: string, { say, format }: Phrasebook): string {
  const normalized = formatUtcTimestamp(value);
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/u.exec(normalized);
  if (match === null) return say("sidebar.sync.unknownTimestamp");
  const component = (index: number, digits = 2): string =>
    format.number(Number(match[index]), { minimumIntegerDigits: digits, useGrouping: false });
  return say("sidebar.sync.timestamp", {
    year: component(1, 4),
    month: component(2),
    day: component(3),
    hour: component(4),
    minute: component(5),
    second: component(6),
    timezone: "UTC",
  });
}

export function SyncChip(): ReactElement {
  const phrasebook = usePhrasebook();
  const { say, format } = phrasebook;
  const training = useEnduragentStore((store) => store.training);
  const sync = useEnduragentStore((store) => store.sync);
  const actions = useEnduragentStore((store) => store.syncActions);
  const setActiveView = useEnduragentStore((store) => store.setActiveView);
  const chip = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const status = syncChipStatus(training, sync);
  const synced = training.metadata?.lastSynced ?? null;
  const syncedDetail =
    status === "synced" && synced !== null ? syncTimestamp(synced, phrasebook) : null;
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  const formattedCount = format.number(restriction?.count ?? 0, { useGrouping: false });
  const message = manualSyncStatusMessage(sync, formattedCount);
  const detail = message === null ? syncedDetail : say(message);
  const action = say(manualSyncActionMessage(sync.label));
  const headline = say(HEADLINE[status]);
  const restrictionVars = { count: restriction?.count ?? 0, formattedCount, source: "Strava" };
  const restrictionLabel =
    restriction === null
      ? null
      : restriction.count === 1
        ? say("sidebar.sync.restriction.label_one", restrictionVars)
        : say("sidebar.sync.restriction.label_other", restrictionVars);

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
        aria-label={
          detail === null
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
        <span className="block whitespace-normal" data-sync-headline="" aria-hidden="true">
          {headline}
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
            label={say("sidebar.sync.restriction.tooltipLabel")}
            lead={
              restriction.count === 1
                ? say("sidebar.sync.restriction.tooltipLead_one", restrictionVars)
                : say("sidebar.sync.restriction.tooltipLead_other", restrictionVars)
            }
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
            body={say("sidebar.sync.restriction.tooltipBody", {
              source: "Strava",
              provider: "intervals.icu",
              product: "Enduragent",
            })}
          />
        )}
        <span
          className="mt-px block whitespace-normal text-xs text-ink-3"
          data-sync-action=""
          aria-hidden="true"
        >
          {action}
        </span>
      </span>
    </div>
  );
}
