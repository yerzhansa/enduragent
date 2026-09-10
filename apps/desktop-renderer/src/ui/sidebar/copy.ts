import { msg, type Message } from "@enduragent/i18n";
import {
  sourceRestrictionSummary,
  STRAVA_RESTRICTION_DESKTOP_COPY,
  SYNC_INDETERMINATE_COPY,
  SYNC_NO_CHANGE_COPY,
  SYNC_OPERATION_FAILURE_COPY,
  SYNC_PARTIAL_COPY,
  SYNC_PROTOCOL_COPY,
  SYNC_PUBLISHED_COPY,
  SYNC_QUEUED_COPY,
  SYNC_RUNNING_COPY,
  type ManualSyncViewState,
} from "../../training-context/manual-sync";

export function manualSyncActionMessage(label: ManualSyncViewState["label"]): Message {
  switch (label) {
    case "Sync now":
      return msg("sidebar.sync.action.now");
    case "Sync again":
      return msg("sidebar.sync.action.again");
    case "Try again":
      return msg("sidebar.sync.action.retry");
    case "Sync unavailable":
      return msg("sidebar.sync.action.unavailable");
  }
}

export function manualSyncStatusMessage(
  sync: ManualSyncViewState,
  formattedCount: string,
): Message | null {
  switch (sync.message) {
    case "":
      return null;
    case SYNC_QUEUED_COPY:
      return msg("sidebar.sync.message.queued");
    case SYNC_RUNNING_COPY:
      return msg("sidebar.sync.message.running");
    case SYNC_PUBLISHED_COPY:
      return msg("sidebar.sync.message.published");
    case SYNC_NO_CHANGE_COPY:
      return msg("sidebar.sync.message.noChange");
    case SYNC_PARTIAL_COPY:
      return msg("sidebar.sync.message.partial");
    case SYNC_OPERATION_FAILURE_COPY:
      return msg("sidebar.sync.message.operationFailure");
    case SYNC_INDETERMINATE_COPY:
      return msg("sidebar.sync.message.indeterminate", { product: "Enduragent" });
    case SYNC_PROTOCOL_COPY:
      return msg("sidebar.sync.message.protocol", { product: "Enduragent" });
  }
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  if (restriction !== null) {
    const suffix = STRAVA_RESTRICTION_DESKTOP_COPY.syncMessage(restriction.count);
    const vars = {
      count: restriction.count,
      formattedCount,
      source: "Strava",
      provider: "intervals.icu",
    };
    if (sync.message === `${SYNC_PUBLISHED_COPY} ${suffix}`) {
      return msg("sidebar.sync.message.publishedRestricted", { ...vars, count: restriction.count });
    }
    if (sync.message === `${SYNC_NO_CHANGE_COPY} ${suffix}`) {
      return msg("sidebar.sync.message.noChangeRestricted", { ...vars, count: restriction.count });
    }
  }
  return msg("sidebar.sync.message.external", { message: sync.message });
}
