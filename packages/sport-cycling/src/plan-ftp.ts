import type {
  PlanFtpAdapter,
  PlanFtpSnapshot,
  PlanFtpSource,
  PlanFtpSourceValue,
} from "@enduragent/engine/sport";

export interface CyclingPlanFtpSourcePorts {
  readManual(): Promise<PlanFtpSourceValue | null>;
  readIntervalsFtp(): Promise<PlanFtpSourceValue | null>;
  readIntervalsEftp(): Promise<PlanFtpSourceValue | null>;
  saveManual(watts: number): Promise<void>;
  refreshIntervals(): Promise<void>;
}

export async function readCyclingPlanFtpCandidates(adapter: Pick<PlanFtpAdapter, "read">) {
  const snapshot = await adapter.read();
  const sources: readonly [PlanFtpSource, PlanFtpSourceValue | null][] = [
    ["manual", snapshot.manual],
    ["intervals-ftp", snapshot.intervalsFtp],
    ["intervals-eftp", snapshot.intervalsEftp],
  ];
  return sources.flatMap(([source, value]) =>
    value === null
      ? []
      : [{ source, watts: value.watts, selected: snapshot.usedSource === source }],
  );
}

function validSource(value: PlanFtpSourceValue | null): PlanFtpSourceValue | null {
  if (value === null) return null;
  if (
    !Number.isFinite(value.watts) ||
    value.watts <= 0 ||
    value.watts > 9_999 ||
    !Number.isSafeInteger(value.refreshedAtMs) ||
    value.refreshedAtMs < 0
  ) {
    throw new TypeError("Cycling FTP source is invalid.");
  }
  return { watts: Math.round(value.watts), refreshedAtMs: value.refreshedAtMs };
}

export function validateManualPlanFtp(watts: number): number {
  if (!Number.isSafeInteger(watts) || watts < 1 || watts > 9_999) {
    throw new RangeError("Enter 1–9999 whole watts.");
  }
  return watts;
}

function resolveSources(input: {
  readonly manual: PlanFtpSourceValue | null;
  readonly intervalsFtp: PlanFtpSourceValue | null;
  readonly intervalsEftp: PlanFtpSourceValue | null;
}): PlanFtpSnapshot {
  const manual = validSource(input.manual);
  const intervalsFtp = validSource(input.intervalsFtp);
  const intervalsEftp = validSource(input.intervalsEftp);
  const selected: readonly [PlanFtpSource, PlanFtpSourceValue] | null =
    manual !== null
      ? ["manual", manual]
      : intervalsFtp !== null
        ? ["intervals-ftp", intervalsFtp]
        : intervalsEftp !== null
          ? ["intervals-eftp", intervalsEftp]
          : null;
  const values = [manual, intervalsFtp, intervalsEftp].filter(
    (value): value is PlanFtpSourceValue => value !== null,
  );
  return {
    manual,
    intervalsFtp,
    intervalsEftp,
    usedSource: selected?.[0] ?? null,
    usedWatts: selected?.[1].watts ?? null,
    conflict: new Set(values.map((value) => value.watts)).size > 1,
  };
}

export function createCyclingPlanFtpAdapter(ports: CyclingPlanFtpSourcePorts): PlanFtpAdapter {
  const read = async (): Promise<PlanFtpSnapshot> => {
    const [manual, intervalsFtp, intervalsEftp] = await Promise.all([
      ports.readManual(),
      ports.readIntervalsFtp(),
      ports.readIntervalsEftp(),
    ]);
    return resolveSources({ manual, intervalsFtp, intervalsEftp });
  };
  return {
    read,
    async saveManual(watts) {
      await ports.saveManual(validateManualPlanFtp(watts));
      return read();
    },
    async refreshIntervals() {
      await ports.refreshIntervals();
      return read();
    },
  };
}
