import type { WellnessDay } from "@enduragent/kernel/reference/schemas";
import type { AthleteDataReaderPort } from "../host-ports.js";
import { MS_PER_DAY, parseDateKeyMs } from "../sport/date-keys.js";
import { projectAthlete } from "../sport/list-projection.js";

export const LATEST_WELLNESS_LOOKBACK_DAYS = 7;
export const ATHLETE_SNAPSHOT_TIMEOUT_MS = 5_000;

export const ATHLETE_SNAPSHOT_HEADING = "# Athlete Profile & Latest Wellness";

export const ATHLETE_SNAPSHOT_FALLBACK =
  `${ATHLETE_SNAPSHOT_HEADING}\n\n` +
  "Athlete snapshot: unavailable this turn; fetch the profile and latest wellness before prescribing intensity.";

const ATHLETE_SNAPSHOT_GUIDANCE =
  "Fetch wellness or activities only for a date range or history not shown here. " +
  "Treat a single HRV or resting-HR value as one signal, not a verdict; weigh the athlete's reported feel at least as much.";

export class AthleteSnapshotTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`athlete snapshot read timed out after ${timeoutMs} ms`);
    this.name = "AthleteSnapshotTimeoutError";
  }
}

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function signed(value: number): string {
  return value > 0 ? `+${fmt(value)}` : fmt(value);
}

function sleepDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function pick(parts: string[], label: string, value: number | undefined, unit = ""): void {
  if (value !== undefined) parts.push(`${label} ${fmt(value)}${unit}`);
}

function sportSettingsFor(athlete: Row, sportTypes: readonly string[]): Row {
  const rows = Array.isArray(athlete.sportSettings) ? athlete.sportSettings.filter(isRecord) : [];
  const matching = rows.find(
    (row) => Array.isArray(row.types) && row.types.some((type) => sportTypes.includes(type)),
  );
  return matching ?? rows[0] ?? {};
}

export function renderAthleteProfileLine(
  athlete: unknown,
  sportTypes: readonly string[],
): string | undefined {
  if (!isRecord(athlete)) return undefined;
  const projected = projectAthlete(athlete);
  const settings = sportSettingsFor(projected, sportTypes);
  const parts: string[] = [];
  pick(parts, "FTP", num(settings.ftp) ?? num(projected.icuFtp), " W");
  pick(parts, "LTHR", num(settings.lthr) ?? num(projected.icuLthr), " bpm");
  pick(
    parts,
    "max HR",
    num(settings.maxHr) ?? num(settings.max_hr) ?? num(projected.icuMaxHr),
    " bpm",
  );
  pick(parts, "resting HR", num(settings.restingHr) ?? num(projected.icuRestingHr), " bpm");
  pick(
    parts,
    "weight",
    num(projected.icuWeight) ?? num(projected.weight) ?? num(settings.weight),
    " kg",
  );
  return parts.length === 0 ? undefined : `Profile: ${parts.join(" · ")}`;
}

function wellnessParts(day: WellnessDay): string[] {
  const parts: string[] = [];
  const fitness = num(day.fitness);
  const fatigue = num(day.fatigue);
  pick(parts, "Fitness", fitness);
  pick(parts, "Fatigue", fatigue);
  if (fitness !== undefined && fatigue !== undefined) {
    parts.push(`Form ${signed(Math.round((fitness - fatigue) * 10) / 10)}`);
  }
  pick(parts, "resting HR", num(day.restingHR), " bpm");
  pick(parts, "HRV", num(day.hrv));
  const sleepSecs = num(day.sleepSecs);
  if (sleepSecs !== undefined) parts.push(`sleep ${sleepDuration(sleepSecs)}`);
  pick(parts, "sleep score", num(day.sleepScore));
  pick(parts, "sleep quality", num(day.sleepQuality));
  pick(parts, "weight", num(day.weight), " kg");
  pick(parts, "readiness", num(day.readiness));
  pick(parts, "reported fatigue", num(day.subjectiveFatigue));
  pick(parts, "soreness", num(day.soreness));
  pick(parts, "stress", num(day.stress));
  pick(parts, "mood", num(day.mood));
  pick(parts, "motivation", num(day.motivation));
  pick(parts, "injury", num(day.injury));
  return parts;
}

export function renderLatestWellnessLine(days: readonly WellnessDay[]): string | undefined {
  const dated = [...days].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = dated.length - 1; i >= 0; i--) {
    const parts = wellnessParts(dated[i]!);
    if (parts.length > 0) return `Wellness ${dated[i]!.id}: ${parts.join(" · ")}`;
  }
  return undefined;
}

export function renderAthleteSnapshotBlock(input: {
  athlete?: unknown;
  wellness?: readonly WellnessDay[];
  wellnessNotice?: string | undefined;
  sportTypes: readonly string[];
}): string | undefined {
  const lines = [
    renderAthleteProfileLine(input.athlete, input.sportTypes),
    renderLatestWellnessLine(input.wellness ?? []),
    input.wellnessNotice,
  ].filter((line): line is string => line !== undefined);
  if (lines.length === 0) return undefined;
  return `${ATHLETE_SNAPSHOT_HEADING}\n\n${lines.join("\n")}\n${ATHLETE_SNAPSHOT_GUIDANCE}`;
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AthleteSnapshotTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function loadAthleteSnapshotBlock(input: {
  reader: AthleteDataReaderPort | undefined;
  today: string;
  sportTypes: readonly string[];
  timeoutMs?: number;
  onError?: (error: unknown) => void;
}): Promise<string | undefined> {
  const { reader } = input;
  if (reader === undefined) return undefined;
  const startMs = parseDateKeyMs(input.today) - (LATEST_WELLNESS_LOOKBACK_DAYS - 1) * MS_PER_DAY;
  const start = new Date(startMs).toISOString().slice(0, 10);
  const guarded = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      input.onError?.(error);
      return undefined;
    }
  };
  const reads = Promise.all([
    guarded(() => reader.getAthlete()),
    guarded(() => reader.listWellness({ start, end: input.today })),
  ]);
  let athlete: Awaited<ReturnType<AthleteDataReaderPort["getAthlete"]>> | undefined;
  let wellness: Awaited<ReturnType<AthleteDataReaderPort["listWellness"]>> | undefined;
  try {
    [athlete, wellness] = await withDeadline(reads, input.timeoutMs ?? ATHLETE_SNAPSHOT_TIMEOUT_MS);
  } catch (error) {
    input.onError?.(error);
    return undefined;
  }
  return renderAthleteSnapshotBlock({
    athlete: athlete?.ok ? athlete.value : undefined,
    wellness: wellness?.ok ? wellness.value : [],
    wellnessNotice: wellnessNotice(wellness),
    sportTypes: input.sportTypes,
  });
}

function wellnessNotice(
  read: Awaited<ReturnType<AthleteDataReaderPort["listWellness"]>> | undefined,
): string | undefined {
  if (read === undefined) return undefined;
  if (read.ok) return read.notice;
  return read.error === "wellness_unreadable" ? read.message : undefined;
}
