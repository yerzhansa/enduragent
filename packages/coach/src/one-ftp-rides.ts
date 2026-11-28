import type { PlanCalendarRideFtp } from "@enduragent/coach-contract";
import { rideFtpAt } from "@enduragent/engine/calendar";
import type { SqlStore } from "@enduragent/kernel/store";
import { readOneFtp } from "./one-ftp.js";
import { readAppliedFtps } from "./one-ftp-store.js";

export interface RideFtpInput {
  readonly activityId: string;
  readonly startEpochSeconds: number;
  readonly indoor: boolean;
}

export type RideFtpReader = (
  rides: readonly RideFtpInput[],
) => Promise<ReadonlyMap<string, PlanCalendarRideFtp>>;

export function createRideFtpReader(input: {
  readonly store: SqlStore;
  readonly athleteId: () => string | null;
  readonly dateKeyOfMs: (ms: number) => number;
}): RideFtpReader {
  return async (rides) => {
    const found = new Map<string, PlanCalendarRideFtp>();
    if (rides.length === 0) return found;
    const history = await readOneFtp(input.store, input.athleteId());
    const applied = await readAppliedFtps(
      input.store,
      rides.map((ride) => ride.activityId),
    );
    for (const ride of rides) {
      const ftp = rideFtpAt(history, {
        startMs: ride.startEpochSeconds * 1_000,
        indoor: ride.indoor,
        appliedWatts: applied.get(ride.activityId) ?? null,
      });
      if (ftp.kind === "unknown") {
        found.set(ride.activityId, { kind: "unknown" });
        continue;
      }
      const line = ftp.line;
      const setBy =
        line === null || line.source === "first-sync"
          ? "unknown"
          : line.source === "intervals"
            ? "you"
            : "coach";
      found.set(ride.activityId, {
        kind: "known",
        watts: ftp.watts,
        use: ftp.use,
        setBy,
        setOnDateKey: setBy === "unknown" || line === null ? null : input.dateKeyOfMs(line.setAtMs),
        outdoorWatts: ftp.outdoorWatts,
      });
    }
    return found;
  };
}
