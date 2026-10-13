import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import {
  makeIntervalsHttpFactory,
} from "@enduragent/core";
import {
  assertNoTpKeysRemain,
  normalizeStreams,
  parseRenamedActivity,
  renameTpFieldsOnActivity,
} from "@enduragent/kernel/reference/local-bundle";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { PhysicalRequestLedger } from "@enduragent/kernel/store";
import {
  createIntervalsIcuSource,
  type IntervalsIcuSource,
  type IntervalsLandingAcl,
} from "@enduragent/sync-intervals-icu";

export const DEFAULT_REQUEST_INTERVAL_MS = 250;
export const DEFAULT_PER_REQUEST_TIMEOUT_MS = 30_000;

export interface BackfillClock { now(): number; monotonicNow(): number; }

export function createIntervalsBackfillSource(options: {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly minRequestIntervalMs: number;
  readonly archive: ArchiveManager;
  readonly clock: BackfillClock;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly attemptLedger?: PhysicalRequestLedger;
}): IntervalsIcuSource {
  const acl: IntervalsLandingAcl = Object.freeze({
    activity(row: Record<string, unknown>) {
      return parseRenamedActivity(renameTpFieldsOnActivity(row));
    },
    streams(value: unknown) {
      const normalized = normalizeStreams(value);
      if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
        throw new TypeError("invalid normalized streams");
      }
      return normalized as Readonly<Record<string, unknown>>;
    },
    assertClean: assertNoTpKeysRemain,
  });
  return createIntervalsIcuSource({
    athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate,
    historyOldestDate: "1900-01-01",
    minRequestIntervalMs: options.minRequestIntervalMs,
    httpFactory: makeIntervalsHttpFactory({
      apiKey: options.apiKey,
      ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
    }),
    archive: options.archive,
    acl,
    wallClock: options.clock,
    sleep: options.sleep,
    ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }),
  });
}

export const sleepAbortably = (ms: number, signal: AbortSignal): Promise<void> =>
  setTimeoutPromise(ms, undefined, { signal }).then(() => undefined);
