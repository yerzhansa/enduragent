import { snakeCaseKeys, type Activity as ManagedActivity } from "intervals-icu-api";
import {
  DroppedActivitiesSchema,
  type ActivityRestriction,
  type DroppedActivities,
} from "@enduragent/coach-contract";
import { serializeError } from "../../logging/serialize-error.js";
import { redactObject } from "../../logging/redact.js";
import {
  REFERENCE_CAPTURE_STREAM_LIMIT,
  REFERENCE_CAPTURE_STREAM_TYPES,
  createReferenceCapturePlan,
  selectReferenceCaptureStreamIds,
  type ReferenceCapturePlan,
} from "@enduragent/kernel/reference/capture";
import {
  assertNoTpKeysRemain,
  decodeWellnessRow,
  deriveFtpHistory,
  normalizeStreams,
  parseRenamedActivity,
  renameTpFieldsOnActivity,
  StreamNormalizationError,
  type ReferenceBundle,
  type RenameSummary,
} from "@enduragent/kernel/reference/local-bundle";
import {
  PLANNING_EVENT_CATEGORIES,
  PlannedEventSchema,
  isPlanningEventCategory,
  type PlannedEvent,
} from "@enduragent/kernel/reference/schemas";

import {
  AthleteSchema,
  ActivityStreamsSchema,
  type Activity,
  type ActivityStreams,
  type AthleteSettings,
  type WellnessDay,
} from "../schemas/inputs.js";
import { LATEST_RETENTION_DAYS } from "../freshness.js";
import { familyOf } from "../sport-adapter-dispatcher.js";

export { deriveFtpHistory, normalizeStreams } from "@enduragent/kernel/reference/local-bundle";

export const MAX_STREAM_ACTIVITIES = REFERENCE_CAPTURE_STREAM_LIMIT;
export const PAST_PLAN_WINDOW_DAYS = 7;
export const FUTURE_PLAN_WINDOW_DAYS = 28;
const STREAM_THROTTLE_MS = 250;
const STREAM_PHASE_BUDGET_MS = 60_000;

export const STREAM_TYPES: readonly string[] = REFERENCE_CAPTURE_STREAM_TYPES;

type FetchResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface BundleFetchClient {
  readonly athlete: { get(): Promise<FetchResult<unknown>> };
  readonly activities: {
    list(query: { oldest: string; newest?: string }): Promise<FetchResult<unknown[]>>;
    getStreams(activityId: string, types: string[]): Promise<FetchResult<unknown>>;
  };
  readonly wellness: {
    list(query: { oldest?: string; newest?: string }): Promise<FetchResult<unknown[]>>;
  };
  readonly events: {
    list(query: {
      oldest: string;
      newest: string;
      category: string[];
    }): Promise<FetchResult<unknown[]>>;
  };
}

export interface FetchEndpointError {
  readonly endpoint: string;
  readonly detail: string;
}

export const SOURCE_RESTRICTED_PROVIDER = "STRAVA";

export interface LiveFetchResult {
  readonly athleteProfile: unknown;
  readonly recentActivities: readonly Activity[];
  readonly wellnessData: readonly WellnessDay[];
  readonly plannedWorkouts: readonly PlannedEvent[];
  readonly bundle: ReferenceBundle;
  readonly adapterActivities: readonly ManagedActivity[];
  readonly frozenNow: string;
  readonly droppedActivities: DroppedActivities;
  readonly fetchErrors?: readonly FetchEndpointError[];
}

function extractAthleteSettings(profile: unknown): AthleteSettings | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const sportSettings = (profile as Record<string, unknown>).sportSettings;
  if (!Array.isArray(sportSettings)) return undefined;
  const parsed = AthleteSchema.safeParse({ sportSettings: snakeCaseKeys(sportSettings) });
  return parsed.success ? parsed.data : undefined;
}

interface LiveFetchDeps {
  readonly client: BundleFetchClient;
  readonly signal: AbortSignal;
  readonly now: Date;
  readonly calendarTimeZone: string;
  readonly sportTypes?: readonly string[];
  readonly throttleMs?: number;
  readonly log?: (msg: string) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function renderEndpointError(error: unknown): string {
  return JSON.stringify(
    error !== null && typeof error === "object" ? redactObject(error) : serializeError(error),
  );
}

function shiftedDate(value: string, days: number): string {
  const instant = new Date(`${value}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

export async function fetchLiveBundle(deps: LiveFetchDeps): Promise<LiveFetchResult> {
  const { client, signal, now } = deps;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const throttleMs = deps.throttleMs ?? STREAM_THROTTLE_MS;
  const plan = createReferenceCapturePlan({ now, calendarTimeZone: deps.calendarTimeZone });
  const frozenNow = plan.frozenNow;
  const { oldest, newest } = plan.window;
  const cyclingSportTypes = new Set(
    (deps.sportTypes ?? []).filter((type) => familyOf(type, undefined) === "cycling"),
  );

  const fetchErrors: FetchEndpointError[] = [];

  const athleteResult = await client.athlete.get();
  if (!athleteResult.ok) {
    const detail = renderEndpointError(athleteResult.error);
    log(`Reference: athlete.get failed: ${detail}`);
    fetchErrors.push({ endpoint: "athlete", detail });
  }
  const athleteProfile = athleteResult.ok ? athleteResult.value : {};

  const actResult = await client.activities.list({ oldest, newest });
  if (!actResult.ok) {
    throw new Error(`activities.list failed: ${renderEndpointError(actResult.error)}`);
  }
  let adapterActivities: ManagedActivity[] = [];
  let rawActivities: Array<Record<string, unknown>> = [];
  if (Array.isArray(actResult.value)) {
    adapterActivities = actResult.value as ManagedActivity[];
    rawActivities = snakeCaseKeys(actResult.value) as Array<Record<string, unknown>>;
  } else {
    log("Reference: activities.list returned a non-array body; treating as empty");
  }

  const wellResult = await client.wellness.list({ oldest, newest });
  if (!wellResult.ok) {
    const detail = renderEndpointError(wellResult.error);
    log(`Reference: wellness.list failed: ${detail}`);
    fetchErrors.push({ endpoint: "wellness", detail });
  }
  const rawWellness: Array<Record<string, unknown>> =
    wellResult.ok && Array.isArray(wellResult.value)
      ? (wellResult.value as Array<Record<string, unknown>>)
      : [];

  const frozenDate = frozenNow.slice(0, 10);
  const planOldest = shiftedDate(frozenDate, -(PAST_PLAN_WINDOW_DAYS - 1));
  const planNewest = shiftedDate(frozenDate, FUTURE_PLAN_WINDOW_DAYS);
  const eventResult = await client.events.list({
    oldest: planOldest,
    newest: planNewest,
    category: [...PLANNING_EVENT_CATEGORIES],
  });
  if (!eventResult.ok) {
    const detail = renderEndpointError(eventResult.error);
    log(`Reference: events.list failed: ${detail}`);
    fetchErrors.push({ endpoint: "events", detail });
  }
  const plannedEvents: PlannedEvent[] = [];
  if (eventResult.ok && Array.isArray(eventResult.value)) {
    const rawEvents = snakeCaseKeys(eventResult.value) as Array<Record<string, unknown>>;
    for (const row of rawEvents) {
      const parsed = PlannedEventSchema.safeParse(row);
      if (!parsed.success) {
        log(`Reference: skipped malformed event row: ${parsed.error.message}`);
        continue;
      }
      if (
        !isPlanningEventCategory(parsed.data.category) ||
        (parsed.data.category === "WORKOUT" &&
          (parsed.data.type == null || !cyclingSportTypes.has(parsed.data.type)))
      ) {
        continue;
      }
      plannedEvents.push(parsed.data);
    }
  } else if (eventResult.ok) {
    log("Reference: events.list returned a non-array body; treating as empty");
  }
  plannedEvents.sort(
    (left, right) =>
      left.start_date_local.localeCompare(right.start_date_local) || left.id - right.id,
  );
  const pastEvents = plannedEvents.filter((event) => {
    const date = event.start_date_local.slice(0, 10);
    return date >= planOldest && date <= frozenDate;
  });
  const plannedWorkouts = plannedEvents.filter((event) => {
    const date = event.start_date_local.slice(0, 10);
    return date >= frozenDate && date <= planNewest;
  });

  const actSummary: RenameSummary = { skippedNonNumeric: {} };

  const retentionCutoffMs = now.getTime() - LATEST_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const isRecent = (row: { readonly start_date_local?: unknown }): boolean => {
    if (typeof row.start_date_local !== "string") return false;
    const milliseconds = Date.parse(row.start_date_local);
    return Number.isFinite(milliseconds) && milliseconds >= retentionCutoffMs;
  };
  const activities: Activity[] = [];
  const droppedRows: Array<Record<string, unknown>> = [];
  for (const row of rawActivities) {
    try {
      activities.push(parseRenamedActivity(renameTpFieldsOnActivity(row, actSummary)));
    } catch (err) {
      droppedRows.push(row);
      log(
        `Reference: skipped malformed activity row: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const restrictionsFor = (rows: readonly Record<string, unknown>[]): ActivityRestriction[] => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.source !== SOURCE_RESTRICTED_PROVIDER) continue;
      counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
    }
    return [...counts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([source, count]) => ({ reason: "source-restricted", source, count }));
  };
  const recentRawActivities = rawActivities.filter(isRecent);
  const recentActivities = activities.filter(isRecent);
  const recentDroppedRows = droppedRows.filter(isRecent);
  const restrictions = restrictionsFor(droppedRows);
  const recentRestrictions = restrictionsFor(recentDroppedRows);
  const restrictedCount = restrictions.reduce((sum, entry) => sum + entry.count, 0);
  const recentRestrictedCount = recentRestrictions.reduce((sum, entry) => sum + entry.count, 0);
  const droppedActivities = DroppedActivitiesSchema.parse({
    overall: {
      total: rawActivities.length,
      visible: activities.length,
      restrictions,
      other: droppedRows.length - restrictedCount,
    },
    recent7Days: {
      total: recentRawActivities.length,
      visible: recentActivities.length,
      restrictions: recentRestrictions,
      other: recentDroppedRows.length - recentRestrictedCount,
    },
  });
  const wellness: WellnessDay[] = [];
  for (const row of rawWellness) {
    try {
      wellness.push(decodeWellnessRow(row));
    } catch (err) {
      log(
        `Reference: skipped malformed wellness row: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  assertNoTpKeysRemain({ activities, wellness });

  const streams = await fetchStreams(client, activities, signal, plan, throttleMs, log);

  const ftpHistory = deriveFtpHistory(wellness);
  const athlete = extractAthleteSettings(athleteProfile);

  const bundle: ReferenceBundle = {
    activities,
    wellness,
    ftpHistory,
    pastEvents,
    ...(Object.keys(streams).length > 0 ? { streams } : {}),
    ...(athlete !== undefined ? { athlete } : {}),
  };

  return {
    athleteProfile,
    recentActivities,
    wellnessData: wellness,
    plannedWorkouts,
    bundle,
    adapterActivities,
    frozenNow,
    droppedActivities,
    ...(fetchErrors.length > 0 ? { fetchErrors } : {}),
  };
}

async function fetchStreams(
  client: BundleFetchClient,
  activities: readonly Activity[],
  signal: AbortSignal,
  plan: ReferenceCapturePlan,
  throttleMs: number,
  log: (msg: string) => void,
): Promise<Record<string, ActivityStreams>> {
  const candidates = selectReferenceCaptureStreamIds(activities, plan);

  const deadline = Date.now() + STREAM_PHASE_BUDGET_MS;
  const out: Record<string, ActivityStreams> = {};
  for (const id of candidates) {
    if (signal.aborted || Date.now() > deadline) break;
    let result: FetchResult<unknown>;
    try {
      result = await client.activities.getStreams(id, [...STREAM_TYPES]);
    } catch (err) {
      log(
        `Reference: streams fetch threw for an activity: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!result.ok) {
      log(`Reference: streams fetch failed for an activity: ${renderEndpointError(result.error)}`);
      continue;
    }
    let normalized: unknown;
    try {
      normalized = normalizeStreams(result.value);
    } catch (error) {
      const reason =
        error instanceof StreamNormalizationError
          ? "duplicate descriptor types"
          : "normalization rejected input";
      log(`Reference: streams shape rejected for an activity: ${reason}`);
      continue;
    }
    const parsed = ActivityStreamsSchema.safeParse(normalized);
    if (!parsed.success) {
      log(`Reference: streams shape rejected for an activity: ${parsed.error.message}`);
      continue;
    }
    out[id] = parsed.data;
    await sleep(throttleMs, signal);
  }
  return out;
}
