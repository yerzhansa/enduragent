import { msg, type Message } from "@enduragent/i18n";
import type {
  AnalysisRefreshFailureCode,
  AnalysisUnavailableReason,
  PowerProgressComputed,
  PowerProgressRefreshFailureCode,
  PowerProgressUnavailableReason,
} from "@enduragent/coach-contract";
import type { TrainingContextStatus } from "../../training-context/controller";

export const POWER_PROGRESS_UNAVAILABLE_COPY: Readonly<
  Record<PowerProgressUnavailableReason, Message>
> = {
  "not-synced": msg("training.power.unavailable.notSynced"),
  "insufficient-data": msg("training.power.unavailable.insufficientData"),
  "invalid-data": msg("training.power.unavailable.invalidData"),
  "refresh-failed": msg("training.power.unavailable.refreshFailed"),
  "temporary-failure": msg("training.power.unavailable.temporaryFailure"),
  "source-restricted": msg("training.power.unavailable.sourceRestricted"),
};

export const POWER_PROGRESS_REFRESH_FAILURE_COPY: Readonly<
  Record<PowerProgressRefreshFailureCode, Message>
> = {
  "request-budget-exhausted": msg("training.power.refreshFailure.requestBudgetExhausted"),
  "rate-limited": msg("training.power.refreshFailure.rateLimited", { provider: "intervals.icu" }),
  timeout: msg("training.power.refreshFailure.timeout"),
  network: msg("training.power.refreshFailure.network"),
  "provider-unavailable": msg("training.power.refreshFailure.providerUnavailable", {
    provider: "intervals.icu",
  }),
  "malformed-response": msg("training.power.refreshFailure.malformedResponse"),
  "response-too-large": msg("training.power.refreshFailure.responseTooLarge"),
  cancelled: msg("training.power.refreshFailure.cancelled"),
  "temporary-failure": msg("training.power.refreshFailure.temporaryFailure"),
};

export const POWER_PROGRESS_ROTATION_COPY: Readonly<
  Record<PowerProgressComputed["rotation"], Message>
> = {
  sprint: msg("training.power.rotation.sprint"),
  endurance: msg("training.power.rotation.endurance"),
  balanced: msg("training.power.rotation.balanced"),
  unknown: msg("training.power.rotation.unknown"),
};

export const POWER_PROGRESS_FRESHNESS_COPY: Readonly<
  Record<PowerProgressComputed["freshness"], Message>
> = {
  fresh: msg("training.power.freshness.fresh"),
  flag: msg("training.power.freshness.flag"),
  stale: msg("training.power.freshness.stale"),
  critical: msg("training.power.freshness.critical"),
};

export const TRAINING_HISTORY_COPY = {
  current: msg("training.view.history.current"),
  previous: msg("training.view.history.previous"),
  next: msg("training.view.history.next"),
  lastRecorded: msg("training.view.history.lastRecorded"),
  coverage: msg("training.view.history.coverage"),
  trendTitle: msg("training.view.history.trendTitle"),
  trendLabel: msg("training.view.history.trendLabel"),
  trendPeriod: msg("training.view.history.trendPeriod"),
  newestFirst: msg("training.view.history.newestFirst"),
  recentRides: msg("training.view.history.recentRides"),
  recordedRides: msg("training.view.history.recordedRides"),
  latestAvailableRides: msg("training.view.history.latestAvailableRides"),
  trendUnavailable: msg("training.view.history.trendUnavailable"),
  limitedHistory: msg("training.view.history.limitedHistory"),
  incompleteTrend: msg("training.view.history.incompleteTrend"),
  missingDuration: msg("training.view.history.missingDuration"),
  currentEmpty: msg("training.view.history.currentEmpty"),
  previousEmpty: msg("training.view.history.previousEmpty"),
  lastRecordedEmpty: msg("training.view.history.lastRecordedEmpty"),
  unknownRides: msg("training.view.history.unknownRides"),
  incomplete: msg("training.view.history.incomplete"),
  outOfDate: msg("training.view.history.outOfDate"),
  outOfDateIncomplete: msg("training.view.history.outOfDateIncomplete"),
  coverageLag: msg("training.view.history.coverageLag"),
  sparse: msg("training.view.history.sparse"),
  refreshFailure: msg("training.view.history.refreshFailure"),
  unavailable: msg("training.view.history.unavailable"),
  review: msg("training.view.history.review"),
  back: msg("training.view.history.back"),
  keyStats: msg("training.view.history.keyStats"),
  disclosure: msg("training.view.history.disclosure"),
} as const;

export function analysisUnavailableCopy(reason: AnalysisUnavailableReason): Message {
  switch (reason) {
    case "activity-not-found":
      return msg("training.ride.unavailable.activityNotFound");
    case "source-not-found":
    case "not-provider-backed":
      return msg("training.ride.unavailable.notProviderBacked", { provider: "intervals.icu" });
    case "ambiguous-source":
      return msg("training.ride.unavailable.ambiguousSource", { provider: "intervals.icu" });
    case "missing-sensor-data":
      return msg("training.ride.unavailable.missingSensorData");
    case "duplicate-stream":
      return msg("training.ride.unavailable.duplicateStream");
    case "misaligned-stream":
      return msg("training.ride.unavailable.misalignedStream");
    case "invalid-timestamps":
      return msg("training.ride.unavailable.invalidTimestamps");
    case "activity-too-short":
      return msg("training.ride.unavailable.activityTooShort");
    case "insufficient-coverage":
      return msg("training.ride.unavailable.insufficientCoverage");
    case "unstable-output":
      return msg("training.ride.unavailable.unstableOutput");
    case "moving-status-unavailable":
      return msg("training.ride.unavailable.movingStatusUnavailable");
    case "unsuitable-activity":
      return msg("training.ride.unavailable.unsuitableActivity");
    case "empty-response":
    case "malformed-response":
      return msg("training.ride.unavailable.malformedResponse");
    case "response-too-large":
      return msg("training.ride.unavailable.responseTooLarge");
    case "request-budget-exhausted":
      return msg("training.ride.unavailable.requestBudgetExhausted");
    case "rate-limited":
      return msg("training.ride.unavailable.rateLimited", { provider: "intervals.icu" });
    case "timeout":
      return msg("training.ride.unavailable.timeout");
    case "network":
      return msg("training.ride.unavailable.network");
    case "provider-unavailable":
      return msg("training.ride.unavailable.providerUnavailable", { provider: "intervals.icu" });
    case "cancelled":
      return msg("training.ride.unavailable.cancelled");
    case "unsupported":
      return msg("training.ride.unavailable.unsupported");
    case "temporary-failure":
      return msg("training.ride.unavailable.temporaryFailure");
  }
}

export function analysisRefreshFailureCopy(reason: AnalysisRefreshFailureCode): Message {
  switch (reason) {
    case "request-budget-exhausted":
      return msg("training.ride.refreshFailure.requestBudgetExhausted");
    case "rate-limited":
      return msg("training.ride.refreshFailure.rateLimited", { provider: "intervals.icu" });
    case "timeout":
      return msg("training.ride.refreshFailure.timeout");
    case "network":
      return msg("training.ride.refreshFailure.network");
    case "provider-unavailable":
      return msg("training.ride.refreshFailure.providerUnavailable", { provider: "intervals.icu" });
    case "malformed-response":
      return msg("training.ride.refreshFailure.malformedResponse");
    case "response-too-large":
      return msg("training.ride.refreshFailure.responseTooLarge");
    case "cancelled":
      return msg("training.ride.refreshFailure.cancelled");
    case "source-changed":
      return msg("training.ride.refreshFailure.sourceChanged");
    case "temporary-failure":
      return msg("training.ride.refreshFailure.temporaryFailure");
  }
}

export function trainingStatusCopy(status: TrainingContextStatus): Message | null {
  if (status === "loading") return msg("training.view.status.loading");
  if (status === "unavailable") return msg("training.view.status.unavailable");
  if (status === "refresh-unavailable") return msg("training.view.status.refreshUnavailable");
  return null;
}

export const TRAINING_DEGRADED_COPY = msg("training.view.status.degraded");
