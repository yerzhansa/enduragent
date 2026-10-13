import type { ApiError, EventInput, IntervalsClient } from "intervals-icu-api";
import { decodeWellnessRow, RowRejection, type ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { CanonicalActivityReader } from "@enduragent/kernel/store";
import { PLANNING_EVENT_CATEGORIES, WellnessDaySchema, type WellnessDay } from "@enduragent/kernel/reference/schemas";
import type {
  AthleteDataReaderPort as AthleteDataReader,
  AthleteReadResult,
  CalendarEventForDelete,
  CalendarEventUpdate,
  PlatformCalendarMutationsPort as PlatformCalendarMutations,
  StoredDataFreshness,
} from "@enduragent/engine/sport";

export type {
  AthleteDataReader,
  AthleteReadResult,
  CalendarEventForDelete,
  CalendarEventUpdate,
  PlatformCalendarMutations,
  StoredDataFreshness,
};

export class PlatformApiError extends Error {
  readonly apiError: ApiError;
  constructor(apiError: ApiError) {
    super("platform request failed");
    this.name = "PlatformApiError";
    this.apiError = apiError;
  }
}

export class PlatformCredentialsRequiredError extends Error {
  constructor() {
    super("Calendar changes need platform credentials.");
    this.name = "PlatformCredentialsRequiredError";
  }
}

export function createMissingPlatformCalendarMutations(): PlatformCalendarMutations {
  const missing = async (): Promise<never> => { throw new PlatformCredentialsRequiredError(); };
  return Object.freeze({
    createEvent: missing,
    readEventForDelete: missing,
    updateEvent: missing,
    deleteEvent: missing,
  });
}

async function platformValue<T>(
  request: Promise<{ ok: true; value: T } | { ok: false; error: ApiError }>,
): Promise<T> {
  const result = await request;
  if (!result.ok) throw new PlatformApiError(result.error);
  return result.value;
}

function unreadableFields(fields: ReadonlySet<string>): string {
  return fields.size === 0 ? "" : ` Unreadable fields: ${[...fields].sort().join(", ")}.`;
}

export function createPlatformAthleteDataReader(intervals: IntervalsClient): AthleteDataReader {
  return Object.freeze({
    async getAthlete() {
      return { ok: true as const, value: await platformValue(intervals.athlete.get()) };
    },
    async listWellness(input: { start: string; end?: string }) {
      const rows = await platformValue(intervals.wellness.list({
        oldest: input.start,
        newest: input.end,
      })) as unknown[];
      const days: WellnessDay[] = [];
      const fields = new Set<string>();
      for (const row of rows) {
        try {
          days.push(decodeWellnessRow(row));
        } catch (error) {
          if (!(error instanceof RowRejection)) throw error;
          if (error.field !== null && Object.hasOwn(WellnessDaySchema.shape, error.field)) fields.add(error.field);
        }
      }
      const rejected = rows.length - days.length;
      if (rejected === 0) return { ok: true as const, value: days };
      if (days.length === 0) {
        return {
          ok: false as const,
          error: "wellness_unreadable" as const,
          message: `Wellness data could not be read. This is a fault in reading it, not missing athlete data.${unreadableFields(fields)}`,
        };
      }
      return {
        ok: true as const,
        value: days,
        notice: `Wellness is incomplete: ${rejected} of ${rows.length} days could not be read and are missing here.${unreadableFields(fields)}`,
      };
    },
    async listActivities(input: { start: string; end?: string }) {
      return { ok: true as const, value: await platformValue(intervals.activities.list({
        oldest: input.start,
        newest: input.end,
      })) as unknown[] };
    },
    async getActivity(input: { id: string }) {
      return { ok: true as const, value: await platformValue(intervals.activities.get(input.id)) };
    },
    async getStreams(input: { id: string; keys: readonly string[] }) {
      return { ok: true as const, value: await platformValue(
        intervals.activities.getStreams(input.id, [...input.keys]),
      ) };
    },
    async listCalendar(input: { start: string; end?: string }) {
      return { ok: true as const, value: await platformValue(intervals.events.list({
        oldest: input.start,
        newest: input.end,
        category: [...PLANNING_EVENT_CATEGORIES],
      })) as unknown[] };
    },
    freshness: () => undefined,
  });
}

export function createPlatformCalendarMutations(intervals: IntervalsClient): PlatformCalendarMutations {
  return Object.freeze({
    createEvent: (input: EventInput) => platformValue(intervals.events.create(input)),
    async readEventForDelete(input: { eventId: number }) {
      const value = await platformValue(intervals.events.get(input.eventId)) as unknown as CalendarEventForDelete;
      return {
        id: value.id,
        startDateLocal: value.startDateLocal,
        name: value.name,
        category: value.category,
        tags: value.tags,
        externalId: value.externalId,
      };
    },
    updateEvent: (input: { eventId: number; patch: CalendarEventUpdate }) =>
      platformValue(intervals.events.update(input.eventId, input.patch as EventInput)),
    deleteEvent: (input: { eventId: number }) => platformValue(intervals.events.delete(input.eventId)),
  });
}

const INVALID_DATES = Object.freeze({
  ok: false as const,
  error: "invalid_input" as const,
  message: "Dates must be real YYYY-MM-DD values with start on or before end.",
});

const CANONICAL_READ_UNAVAILABLE = Object.freeze({
  ok: false as const,
  error: "store_read_unavailable" as const,
  message: "Canonical activity data is temporarily unavailable.",
});

const INVALID_ACTIVITY_READ = Object.freeze({
  ok: false as const,
  error: "invalid_input" as const,
  message: "Activity read input is invalid.",
});

const ACTIVITY_RANGE_TOO_WIDE = Object.freeze({
  ok: false as const,
  error: "invalid_input" as const,
  message: "More than 200 activities match this date range. Narrow the date range and try again.",
});

const STREAM_ALIASES = Object.freeze({
  watts: "power",
  heartrate: "heart_rate",
  temp: "temperature",
} as const);

const PUBLIC_STREAM_KEYS = new Set([
  "time", "lat", "lng", "distance", "altitude", "speed", "heart_rate", "cadence",
  "fractional_cadence", "power", "temperature", "stance_time", "stance_time_balance",
  "vertical_oscillation", "vertical_ratio", "step_length", "left_right_balance",
  "respiration_rate",
]);

export function isRealCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

function freshnessFor(snapshot: ProducedLocalBundle, clockNow: number): StoredDataFreshness | undefined {
  const capturedMs = snapshot.captureClock.captureEpochMs;
  if (!Number.isFinite(capturedMs) || !Number.isSafeInteger(capturedMs) || capturedMs < 0
    || capturedMs - clockNow > 300_000) return undefined;
  const ageMs = Math.max(0, clockNow - capturedMs);
  const label = ageMs < 60_000
    ? "less than 60 seconds"
    : ageMs < 172_800_000
      ? `${Math.floor(ageMs / 60_000)} minutes`
      : `${Math.floor(ageMs / 86_400_000)} days`;
  return Object.freeze({ capturedAt: snapshot.captureClock.civilDateTime, ageMs, label });
}

export function formatStoreFreshness(freshness: StoredDataFreshness): string {
  return `Store data last synchronized ${freshness.label} ago (${freshness.capturedAt}).`;
}

export interface LaneStanding {
  readonly health: "ok" | "partial" | "lost";
  readonly droppedDates: readonly string[];
}

export function createStoreAthleteDataReader(input: {
  snapshot: () => ProducedLocalBundle | undefined;
  wellnessLane?: () => LaneStanding | undefined;
  canonicalActivities?: CanonicalActivityReader;
  clockNow?: () => number;
}): AthleteDataReader {
  const clockNow = input.clockNow ?? Date.now;
  const current = (): { snapshot: ProducedLocalBundle; freshness: StoredDataFreshness } | AthleteReadResult<never> => {
    const snapshot = input.snapshot();
    if (snapshot === undefined) {
      return { ok: false, error: "store_read_unavailable", message: "No complete local training-store snapshot is available." };
    }
    const freshness = freshnessFor(snapshot, clockNow());
    if (freshness === undefined) {
      return { ok: false, error: "invalid_snapshot", message: "The local training-store snapshot timestamp is invalid." };
    }
    return { snapshot, freshness };
  };
  const range = (
    snapshot: ProducedLocalBundle,
    candidate: { start: string; end?: string },
  ): { start: string; end: string } | undefined => {
    const end = candidate.end ?? snapshot.captureClock.civilDateTime.slice(0, 10);
    if (!isRealCivilDate(candidate.start) || !isRealCivilDate(end) || candidate.start > end) return undefined;
    return { start: candidate.start, end };
  };
  const invalidExplicitRange = (candidate: { start: string; end?: string }): boolean =>
    !isRealCivilDate(candidate.start)
    || (candidate.end !== undefined && (!isRealCivilDate(candidate.end) || candidate.start > candidate.end));
  const canonicalFailure = (error: unknown): AthleteReadResult<never> => {
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate?.name === "CanonicalActivityReadError" && candidate.code === "invalid_input") {
      return INVALID_ACTIVITY_READ;
    }
    return CANONICAL_READ_UNAVAILABLE;
  };
  const canonical = input.canonicalActivities;

  return Object.freeze({
    async getAthlete() {
      const selected = current();
      if (!("snapshot" in selected)) return selected;
      const athlete = selected.snapshot.bundle.athlete;
      return { ok: true as const, value: {
        ...athlete,
        sportSettings: athlete?.sportSettings ?? [],
      }, freshness: selected.freshness };
    },
    async listWellness(candidate: { start: string; end?: string }) {
      if (invalidExplicitRange(candidate)) return INVALID_DATES;
      const selected = current();
      if (!("snapshot" in selected)) return selected;
      const dates = range(selected.snapshot, candidate);
      if (dates === undefined) return INVALID_DATES;
      const lane = input.wellnessLane?.();
      if (lane?.health === "lost") {
        return { ok: false as const, error: "wellness_unreadable" as const,
          message: "Wellness data failed to sync. This is a sync fault, not missing athlete data." };
      }
      const value = selected.snapshot.bundle.wellness.filter((row) => row.id >= dates.start && row.id <= dates.end);
      const missing = (lane?.droppedDates ?? []).filter((date) => date >= dates.start && date <= dates.end).length;
      return missing === 0
        ? { ok: true as const, value, freshness: selected.freshness }
        : { ok: true as const, value, freshness: selected.freshness,
          notice: `Wellness is incomplete: ${missing} of ${value.length + missing} days failed to sync and are missing here.` };
    },
    async listActivities(candidate: { start: string; end?: string }) {
      if (invalidExplicitRange(candidate)) return INVALID_DATES;
      if (canonical === undefined) return CANONICAL_READ_UNAVAILABLE;
      const end = candidate.end ?? new Date(clockNow()).toISOString().slice(0, 10);
      if (!isRealCivilDate(end) || candidate.start > end) return INVALID_DATES;
      try {
        const page = await canonical.listActivities({ start: candidate.start, end, limit: 200 });
        return page.nextCursor === null
          ? { ok: true as const, value: [...page.activities] }
          : ACTIVITY_RANGE_TOO_WIDE;
      } catch (error) {
        return canonicalFailure(error);
      }
    },
    async getActivity(candidate: { id: string }) {
      if (canonical === undefined) return CANONICAL_READ_UNAVAILABLE;
      try {
        const value = await canonical.getActivity({ id: candidate.id });
        return value === undefined
          ? { ok: false as const, error: "not_found" as const, message: "Activity was not found in the local training store." }
          : { ok: true as const, value };
      } catch (error) {
        return canonicalFailure(error);
      }
    },
    async getStreams(candidate: { id: string; keys: readonly string[] }) {
      if (canonical === undefined) return CANONICAL_READ_UNAVAILABLE;
      if (candidate.keys.length < 1 || candidate.keys.length > 16) return INVALID_ACTIVITY_READ;
      const aliases = new Map<string, string>();
      const channels: string[] = [];
      for (const key of candidate.keys) {
        if (aliases.has(key) || key === "smooth_grade") return INVALID_ACTIVITY_READ;
        const channel = STREAM_ALIASES[key as keyof typeof STREAM_ALIASES] ?? key;
        if (!PUBLIC_STREAM_KEYS.has(channel) || channels.includes(channel)) return INVALID_ACTIVITY_READ;
        aliases.set(key, channel);
        channels.push(channel);
      }
      try {
        const value = await canonical.getStreams({ id: candidate.id, channels });
        if (value === undefined) {
          return { ok: false as const, error: "not_found" as const, message: "Activity streams were not found in the local training store." };
        }
        const requested: Record<string, readonly (number | null)[]> = {};
        for (const [alias, channel] of aliases) {
          const stream = value.channels[channel];
          if (stream !== undefined) requested[alias] = stream;
        }
        return { ok: true as const, value: requested };
      } catch (error) {
        return canonicalFailure(error);
      }
    },
    async listCalendar() {
      return { ok: false as const, error: "store_read_unavailable" as const,
        message: "Calendar reads are not available from the local training store." };
    },
    freshness() {
      const snapshot = input.snapshot();
      return snapshot === undefined ? undefined : freshnessFor(snapshot, clockNow());
    },
  });
}
