import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { ApiError, IntervalsClient } from "intervals-icu-api";
import type { IntervalsActivityType } from "../sport.js";
import { summarizeStreams } from "./stream-summary.js";
import { projectActivity, projectAthlete, projectWellness } from "./list-projection.js";
import {
  guardDeletableEvent,
  guardUpdatableEvent,
  toTypedError,
  type IntervalsEventRuntime,
} from "./event-guards.js";
import { buildCoachEventProvenance, isCoachOwnedEvent } from "./event-provenance.js";
import {
  dateKeySchema,
  validateListRange,
  validateWorkoutCreationDate,
  INTERVALS_LIST_MAX_RANGE_DAYS,
} from "./date-schema.js";
import type {
  AthleteDataReaderPort,
  AthleteReadResult,
  PlatformCalendarMutationsPort,
  StoredDataFreshness,
} from "../host-ports.js";

function formatStoreFreshness(freshness: StoredDataFreshness): string {
  return `Store data last synchronized ${freshness.label} ago (${freshness.capturedAt}).`;
}

function readResult<T>(
  result: AthleteReadResult<T>,
): T | { error: string; message: string } | { data: T; freshness: string } {
  if (!result.ok) return { error: result.error, message: result.message };
  if (result.freshness !== undefined) {
    return { data: result.value, freshness: formatStoreFreshness(result.freshness) };
  }
  return result.value;
}

function platformFailure(error: unknown): ReturnType<typeof toTypedError> {
  const candidate = error as { name?: unknown; apiError?: unknown };
  if (candidate?.name === "PlatformApiError" && candidate.apiError !== undefined) {
    return toTypedError(candidate.apiError as ApiError);
  }
  throw error;
}

const CREDENTIALS_REQUIRED = Object.freeze({
  error: "platform_credentials_required",
  message: "Calendar changes need platform credentials.",
});

const ACTIVITY_ID_SCHEMA = z.union([
  z.number().int().positive().refine(Number.isSafeInteger),
  z.string().regex(/^i?\d+$/),
  z.string().regex(/^[0-9a-f]{64}$/),
]);

const ACTIVITY_ID_DESCRIPTION =
  "Activity ID from intervals_fetch_activities — a positive integer or digit string, " +
  "optionally i-prefixed for intervals-native activities, or a lowercase 64-hex " +
  "canonical ID. Pass exactly as listed.";

/**
 * Pure-Core intervals tools per ADR-0004 — no sport-specific config needed.
 * Wired by the binary entry point alongside the sport's own tools().
 *
 * `tz` is the athlete's IANA timezone — used so "today" in the past-workout
 * guard agrees with `event.startDateLocal` (which is in athlete-local frame),
 * not with UTC.
 */
export function createPureCoreIntervalsTools(
  intervals: IntervalsClient | null,
  tz: string = "UTC",
  athleteData?: AthleteDataReaderPort,
  calendarMutations?: PlatformCalendarMutationsPort,
) {
  void intervals;
  const selectedReader = athleteData;
  const selectedMutations = calendarMutations;
  if (!selectedReader && !selectedMutations) return {};
  return {
    ...(selectedReader
      ? {
          intervals_fetch_athlete: tool({
            description:
              "Fetch athlete profile from intervals.icu (FTP, weight, max HR, sport settings, zones)",
            inputSchema: zodSchema(z.object({})),
            execute: async () => {
              try {
                const result = await selectedReader.getAthlete();
                if (!result.ok) return readResult(result);
                return readResult({ ...result, value: projectAthlete(result.value) });
              } catch (error) {
                return platformFailure(error);
              }
            },
          }),
        }
      : {}),

    ...(selectedReader
      ? {
          intervals_fetch_wellness: tool({
            description:
              "Fetch wellness data from intervals.icu (fitness, fatigue, weight, HRV, resting HR, sleep). Form = fitness - fatigue.",
            inputSchema: zodSchema(
              z.object({
                oldest: dateKeySchema.describe("Start date (YYYY-MM-DD)"),
                newest: dateKeySchema.optional().describe("End date (YYYY-MM-DD)"),
              }),
            ),
            execute: async (input: { oldest: string; newest?: string }) => {
              const rangeError = validateListRange(
                input.oldest,
                input.newest,
                INTERVALS_LIST_MAX_RANGE_DAYS,
              );
              if (rangeError) return rangeError;
              try {
                const result = await selectedReader.listWellness({
                  start: input.oldest,
                  ...(input.newest === undefined ? {} : { end: input.newest }),
                });
                if (!result.ok) return readResult(result);
                return readResult({ ...result, value: result.value.map(projectWellness) });
              } catch (error) {
                return platformFailure(error);
              }
            },
          }),
        }
      : {}),

    ...(selectedReader
      ? {
          intervals_fetch_activity: tool({
            description:
              "Fetch one recorded activity by legacy or canonical ID. Store-backed results " +
              "return a bounded source-neutral summary plus laps; other readers may include " +
              "additional source fields. Use only fields actually returned. " +
              "Use this for Tier B+ workout reviews; for " +
              "summary-only Tier A, use `intervals_fetch_activities`.",
            inputSchema: zodSchema(
              z.object({
                activityId: ACTIVITY_ID_SCHEMA.describe(ACTIVITY_ID_DESCRIPTION),
              }),
            ),
            execute: async (input: { activityId: number | string }) => {
              try {
                return readResult(
                  await selectedReader.getActivity({ id: String(input.activityId) }),
                );
              } catch (error) {
                return platformFailure(error);
              }
            },
          }),
        }
      : {}),

    ...(selectedReader
      ? {
          intervals_fetch_streams: tool({
            description:
              "Fetch time-series channels for an activity by legacy or canonical ID. " +
              "Store-backed reads accept up to 16 unique public channels; platform-backed " +
              "reads also accept provider-specific channels such as smooth_grade. " +
              "Returns only per-channel min/max/mean over the full series plus the sample count; " +
              "no per-second data; do not use it for pacing, " +
              "duration-based best efforts, quartile trends, decoupling, " +
              "HR recovery, fade patterns, or indoor/outdoor comparisons. " +
              "Use only minimum, maximum, and mean as descriptive recorded observations. " +
              "They alone cannot establish session quality, recovery, or readiness, " +
              "or justify changing the next session. " +
              "Expensive to fetch (~10,800 samples per type for a 3-hour ride): call it only for Tier C " +
              "deep reviews the athlete explicitly requests. For Tier A/B use " +
              "`intervals_fetch_activities` and `intervals_fetch_activity`. " +
              "Default types: watts, heartrate, cadence, time, altitude.",
            inputSchema: zodSchema(
              z.object({
                activityId: ACTIVITY_ID_SCHEMA.describe(ACTIVITY_ID_DESCRIPTION),
                types: z
                  .array(z.string())
                  .optional()
                  .describe(
                    "Channel names; defaults to watts, heartrate, cadence, time, altitude.",
                  ),
              }),
            ),
            execute: async (input: { activityId: number | string; types?: string[] }) => {
              // Treat empty array the same as omitted — defensively handle the LLM
              // calling with `types: []` "to play it safe" instead of dropping the field.
              const types = input.types?.length
                ? input.types
                : ["watts", "heartrate", "cadence", "time", "altitude"];
              try {
                const result = await selectedReader.getStreams({
                  id: String(input.activityId),
                  keys: types,
                });
                if (!result.ok) return readResult(result);
                const value = summarizeStreams(
                  result.value as Record<string, unknown> | unknown[],
                );
                return result.freshness === undefined
                  ? value
                  : { data: value, freshness: formatStoreFreshness(result.freshness) };
              } catch (error) {
                return platformFailure(error);
              }
            },
          }),
        }
      : {}),

    ...(selectedMutations
      ? {
          intervals_create_strength_workout: tool({
            description:
              "Create a strength/gym session on the intervals.icu calendar (auto-syncs to Garmin/Wahoo). The free-text description carries the whole session — exercises, sets, reps, weight/RPE — and may include coaching notes. Past dates are refused — sessions can only be created for today or later.",
            inputSchema: zodSchema(
              z.object({
                date: dateKeySchema.describe("Session date (YYYY-MM-DD)"),
                name: z
                  .string()
                  .min(1)
                  .max(120)
                  .describe("Calendar card title, e.g. 'Lower body 45min'"),
                description: z
                  .string()
                  .min(1)
                  .max(4000)
                  .describe(
                    "Free-text session content — exercises, sets, reps, weight/RPE.",
                  ),
              }),
            ),
            execute: async (input: { date: string; name: string; description: string }) => {
              const dateError = validateWorkoutCreationDate(input.date, tz);
              if (dateError) return dateError;
              try {
                const event = await selectedMutations.createEvent({
                  startDateLocal: `${input.date}T00:00:00`,
                  category: "WORKOUT",
                  name: input.name,
                  type: "WeightTraining",
                  ...buildCoachEventProvenance(input.date, `strength ${input.name}`),
                  description: input.description,
                });
                return { created: true, event };
              } catch (error) {
                if ((error as { name?: unknown })?.name === "PlatformCredentialsRequiredError") {
                  return CREDENTIALS_REQUIRED;
                }
                return platformFailure(error);
              }
            },
          }),

          intervals_delete_workout: tool({
            description:
              "List and confirm first. Delete a today-or-future coach-owned workout by event " +
              "ID. Non-workouts, unowned workouts, and past workouts are refused.",
            inputSchema: zodSchema(
              z.object({
                eventId: z.number().int().describe("Event ID from intervals_list_events"),
              }),
            ),
            execute: async (input: { eventId: number }) => {
              try {
                const event = await selectedMutations.readEventForDelete({
                  eventId: input.eventId,
                });
                const refusal = guardDeletableEvent(event, tz, input.eventId);
                if (refusal) return refusal;
                await selectedMutations.deleteEvent({ eventId: input.eventId });
                return { deleted: true };
              } catch (error) {
                if ((error as { name?: unknown })?.name === "PlatformCredentialsRequiredError") {
                  return CREDENTIALS_REQUIRED;
                }
                return platformFailure(error);
              }
            },
          }),

          intervals_update_workout: tool({
            description:
              "Update a today-or-future coach-owned workout by event ID. Non-workouts, " +
              "unowned workouts, past workouts, and past target dates are refused.",
            inputSchema: zodSchema(
              z.object({
                eventId: z.number().int().describe("Event ID from intervals_list_events"),
                changes: z
                  .object({
                    date: dateKeySchema.optional().describe("New workout date (YYYY-MM-DD)"),
                    name: z.string().min(1).max(120).optional(),
                    description: z.string().max(4000).optional(),
                    movingTime: z.number().int().positive().optional(),
                    icuTrainingLoad: z.number().nonnegative().optional(),
                    workoutDoc: z.record(z.string(), z.unknown()).optional(),
                  })
                  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
                    message: "At least one workout field must change.",
                  }),
              }),
            ),
            execute: async (input: {
              eventId: number;
              changes: {
                date?: string;
                name?: string;
                description?: string;
                movingTime?: number;
                icuTrainingLoad?: number;
                workoutDoc?: Record<string, unknown>;
              };
            }) => {
              if (input.changes.date !== undefined) {
                const dateError = validateWorkoutCreationDate(input.changes.date, tz);
                if (dateError?.error === "past_date_refused") {
                  return {
                    error: dateError.error,
                    details: dateError.details.replace("create a workout dated", "move a workout to"),
                  };
                }
                if (dateError) return dateError;
              }
              try {
                const event = await selectedMutations.readEventForDelete({
                  eventId: input.eventId,
                });
                const refusal = guardUpdatableEvent(
                  event,
                  tz,
                  input.eventId,
                  input.changes.date,
                );
                if (refusal) return refusal;
                const { date, ...changes } = input.changes;
                const updated = await selectedMutations.updateEvent({
                  eventId: input.eventId,
                  patch: {
                    ...(date === undefined ? {} : { startDateLocal: `${date}T00:00:00` }),
                    ...changes,
                  },
                });
                return { updated: true, event: updated };
              } catch (error) {
                if ((error as { name?: unknown })?.name === "PlatformCredentialsRequiredError") {
                  return CREDENTIALS_REQUIRED;
                }
                return platformFailure(error);
              }
            },
          }),
        }
      : {}),
  };
}

/**
 * Core-with-sport-config intervals tools per ADR-0004 — Core implementation,
 * sport-supplied activity-type filter at construction time.
 */
export function createCoreToolsWithSportConfig(
  intervals: IntervalsClient | null,
  activityTypes: readonly IntervalsActivityType[],
  athleteData?: AthleteDataReaderPort,
) {
  void intervals;
  const selectedReader = athleteData;
  if (!selectedReader) return {};
  // The activityTypes array is reserved for future filtering of the API responses
  // (e.g., when intervals.icu adds a server-side filter); today we keep the same
  // list/fetch shape and let the LLM disambiguate via descriptions. Embedding
  // the param in the closure keeps the contract stable across sports.
  void activityTypes;
  return {
    intervals_fetch_activities: tool({
      description:
        "Fetch up to 200 recorded activity summaries for a date range. Store-backed " +
        "results use positive integer or lowercase 64-hex IDs and a bounded source-neutral " +
        "shape; other readers may include additional source fields. If more than 200 " +
        "store-backed activities match, narrow the date range.",
      inputSchema: zodSchema(
        z.object({
          oldest: dateKeySchema.describe("Oldest date (YYYY-MM-DD)"),
          newest: dateKeySchema.optional().describe("Newest date (YYYY-MM-DD)"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string }) => {
        const rangeError = validateListRange(
          input.oldest,
          input.newest,
          INTERVALS_LIST_MAX_RANGE_DAYS,
        );
        if (rangeError) return rangeError;
        try {
          const result = await selectedReader.listActivities({
            start: input.oldest,
            ...(input.newest === undefined ? {} : { end: input.newest }),
          });
          if (!result.ok) return readResult(result);
          return readResult({ ...result, value: result.value.map(projectActivity) });
        } catch (error) {
          return platformFailure(error);
        }
      },
    }),

    intervals_list_events: tool({
      description:
        "List scheduled calendar workouts on intervals.icu for a date range. " +
        "Use this BEFORE deleting so you can show the athlete the list (id, date, name) " +
        "and ask which one to delete. Filters to WORKOUT category only. Each row carries " +
        "a coachCreated flag; only coach-created workouts can be deleted with " +
        "intervals_delete_workout. Pass coachCreatedOnly: true to return only " +
        "coach-created events.",
      inputSchema: zodSchema(
        z.object({
          oldest: dateKeySchema.describe("Oldest date (YYYY-MM-DD)"),
          newest: dateKeySchema.optional().describe("Newest date (YYYY-MM-DD)"),
          coachCreatedOnly: z
            .boolean()
            .optional()
            .describe("Return only events created by this coach"),
        }),
      ),
      execute: async (input: { oldest: string; newest?: string; coachCreatedOnly?: boolean }) => {
        const rangeError = validateListRange(
          input.oldest,
          input.newest,
          INTERVALS_LIST_MAX_RANGE_DAYS,
        );
        if (rangeError) return rangeError;
        try {
          const result = await selectedReader.listCalendar({
            start: input.oldest,
            ...(input.newest === undefined ? {} : { end: input.newest }),
          });
          if (!result.ok) return readResult(result);
          const events = result.value as IntervalsEventRuntime[];
          const source = input.coachCreatedOnly === true ? events.filter(isCoachOwnedEvent) : events;
          const value = source.map((e) => ({
            id: e.id,
            startDateLocal: e.startDateLocal,
            name: e.name,
            movingTime: e.movingTime,
            icuTrainingLoad: e.icuTrainingLoad,
            category: e.category,
            externalId: e.externalId,
            tags: e.tags,
            coachCreated: input.coachCreatedOnly === true ? true : isCoachOwnedEvent(e),
          }));
          return result.freshness === undefined
            ? value
            : { data: value, freshness: formatStoreFreshness(result.freshness) };
        } catch (error) {
          return platformFailure(error);
        }
      },
    }),
  };
}
