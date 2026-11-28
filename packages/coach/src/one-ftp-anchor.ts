import { ftpAt } from "@enduragent/engine/calendar";
import {
  CYCLING_FTP_STALENESS_DEFAULTS,
  type CyclingFtpAnchorResolver,
  type CyclingFtpStalenessBand,
} from "@enduragent/kernel/anchors";
import type { SqlStore } from "@enduragent/kernel/store";
import { ftpOwner, readOneFtp } from "./one-ftp.js";
import { readFtpInUseSinceMs, readFtpRecord } from "./one-ftp-store.js";

const SECONDS_PER_DAY = 86_400;

function band(ageDays: number): CyclingFtpStalenessBand {
  if (ageDays <= CYCLING_FTP_STALENESS_DEFAULTS.freshMaxDays) return "fresh";
  if (ageDays <= CYCLING_FTP_STALENESS_DEFAULTS.agingMaxDays) return "aging";
  if (ageDays <= CYCLING_FTP_STALENESS_DEFAULTS.staleMaxDays) return "stale";
  return "very-stale";
}

function dateKeyMs(dateKey: number): number {
  const text = String(dateKey).padStart(8, "0");
  return Date.parse(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00.000Z`);
}

async function firstSyncedSinceMs(
  store: SqlStore,
  input: {
    readonly watts: number;
    readonly evaluatedAtMs: number;
    readonly athleteId: string | null;
  },
): Promise<number | null> {
  const { watts, evaluatedAtMs } = input;
  const fromRides = await readFtpInUseSinceMs(store, watts);
  if (fromRides !== null) return fromRides;
  const seen = (await readFtpRecord(store, input.athleteId)).proposal.memory.ftpSeen;
  return seen.kind === "seen" && seen.watts === watts
    ? Math.min(dateKeyMs(seen.sinceDateKey), evaluatedAtMs)
    : null;
}

export function createOneFtpAnchorResolver(
  store: SqlStore,
  athleteId: () => string | null,
): CyclingFtpAnchorResolver {
  return {
    async resolve(input) {
      if (
        !Number.isSafeInteger(input.effectiveAtEpochS) ||
        !Number.isSafeInteger(input.evaluatedAtEpochS) ||
        input.effectiveAtEpochS < 0 ||
        input.evaluatedAtEpochS < input.effectiveAtEpochS
      ) {
        throw new RangeError("Invalid cycling FTP anchor epochs");
      }
      const history = await readOneFtp(store, athleteId());
      const point = ftpAt(history.points, input.effectiveAtEpochS * 1_000);
      if (point === null || point.watts === null) {
        return { kind: "missing", refusal: "missing-cycling-ftp-anchor" };
      }
      const evaluatedAtMs = input.evaluatedAtEpochS * 1_000;
      const sinceMs =
        point.source === "first-sync"
          ? await firstSyncedSinceMs(store, {
              watts: point.watts,
              evaluatedAtMs,
              athleteId: await ftpOwner(store, athleteId()),
            })
          : point.setAtMs;
      const ageDays =
        Math.max(0, evaluatedAtMs - (sinceMs ?? evaluatedAtMs)) / 1_000 / SECONDS_PER_DAY;
      const stalenessBand = sinceMs === null ? "stale" : band(ageDays);
      return {
        kind: "ftp",
        watts: point.watts,
        validFrom: new Date(sinceMs ?? evaluatedAtMs).toISOString().slice(0, 10),
        source: "intervals-icu",
        confidence: "platform",
        ageDays,
        stalenessBand,
        stale: stalenessBand !== "fresh",
      };
    },
  };
}
