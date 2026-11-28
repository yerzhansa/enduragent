import type { PlanFtpAdapter, PlanFtpSourceValue } from "@enduragent/engine/sport";
import type { AnchorRepository, SqlStore } from "@enduragent/kernel/store";
import { createCyclingPlanFtpAdapter } from "@enduragent/sport-cycling";
import { readOneFtp } from "./one-ftp.js";

export interface OneFtpPlanAdapterInput {
  readonly store: SqlStore;
  readonly repository: Pick<AnchorRepository, "insertIfAbsent">;
  readonly identity: {
    readonly newUlid: () => string;
    readonly deviceId: () => Promise<string>;
    readonly hlcStamp: () => { readonly physicalMs: number; readonly counter: number };
  };
  readonly athleteId: () => string | null;
  readonly readLatest: () => {
    readonly metadata?: { readonly last_updated?: string };
    readonly derived_metrics?: { readonly eftp?: number | null };
  } | null;
  readonly refreshIntervals: () => Promise<void>;
}

async function readManual(store: SqlStore): Promise<PlanFtpSourceValue | null> {
  const row = await store.get(
    "SELECT value, valid_from FROM anchor_history WHERE sport = ? AND anchor_type = ? AND confidence = ? ORDER BY valid_from DESC, id DESC LIMIT 1",
    ["cycling", "ftp", "manual"],
  );
  return typeof row?.value === "number" && typeof row.valid_from === "number"
    ? { watts: row.value, refreshedAtMs: row.valid_from * 1_000 }
    : null;
}

async function saveManual(input: OneFtpPlanAdapterInput, watts: number): Promise<void> {
  const stamp = input.identity.hlcStamp();
  const validFrom = Math.floor(stamp.physicalMs / 1_000);
  const deviceId = await input.identity.deviceId();
  const inserted = await input.repository.insertIfAbsent({
    id: input.identity.newUlid(),
    sport: "cycling",
    anchor_type: "ftp",
    value: watts,
    unit: "W",
    valid_from: validFrom,
    source: "athlete",
    confidence: "manual",
    note: null,
    provenance: "manual",
    device_id: deviceId,
    hlc_physical_ms: stamp.physicalMs,
    hlc_counter: stamp.counter,
  });
  if (inserted) return;
  const existing = await input.store.get(
    "SELECT confidence FROM anchor_history WHERE sport = ? AND anchor_type = ? AND valid_from = ?",
    ["cycling", "ftp", validFrom],
  );
  if (existing?.confidence !== "manual") throw new Error("Manual FTP could not be saved.");
  await input.store.run(
    "UPDATE anchor_history SET value = ?, unit = ?, source = ?, note = ?, provenance = ?, device_id = ?, hlc_physical_ms = ?, hlc_counter = ? WHERE sport = ? AND anchor_type = ? AND valid_from = ? AND confidence = ?",
    [
      watts,
      "W",
      "athlete",
      null,
      "manual",
      deviceId,
      stamp.physicalMs,
      stamp.counter,
      "cycling",
      "ftp",
      validFrom,
      "manual",
    ],
  );
}

export function createOneFtpPlanAdapter(input: OneFtpPlanAdapterInput): PlanFtpAdapter {
  return createCyclingPlanFtpAdapter({
    readManual: () => readManual(input.store),
    async readIntervalsFtp() {
      const current = (await readOneFtp(input.store, input.athleteId())).current;
      return current === null ? null : { watts: current.watts, refreshedAtMs: current.setAtMs };
    },
    async readIntervalsEftp() {
      const latest = input.readLatest();
      const watts = latest?.derived_metrics?.eftp;
      const refreshedAtMs = Date.parse(latest?.metadata?.last_updated ?? "");
      return typeof watts === "number" && Number.isFinite(refreshedAtMs)
        ? { watts, refreshedAtMs }
        : null;
    },
    saveManual: (watts) => saveManual(input, watts),
    refreshIntervals: input.refreshIntervals,
  });
}
