import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { CanonicalActivityReader } from "@enduragent/kernel/store";
import type { IntervalsClient } from "intervals-icu-api";
import { describe, expect, it, vi } from "vitest";
import {
  createMissingPlatformCalendarMutations,
  createPlatformAthleteDataReader,
  createPlatformCalendarMutations,
  createStoreAthleteDataReader,
  formatStoreFreshness,
  type PlatformCalendarMutations,
} from "../src/athlete-data.js";
import {
  createCoreToolsWithSportConfig,
  createPureCoreIntervalsTools,
} from "../../engine/src/sport/platform-tools.js";
import { COACH_EVENT_TAG } from "../../engine/src/sport/event-provenance.js";

function produced(frozenNow = "1998-07-18T12:00:00.000Z"): ProducedLocalBundle {
  return {
    captureId: "12345678-1234-4123-8123-123456789abc",
    captureClock: {
      captureEpochMs: Date.parse(frozenNow),
      civilDateTime: frozenNow,
      calendarTimeZone: "UTC",
    },
    bundle: {
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 250 }] },
      activities: [
        {
          id: 2,
          type: "Ride",
          start_date_local: "1998-07-02T08:00:00",
          moving_time: 10,
          elapsed_time: 10,
        },
        {
          id: 1,
          type: "Ride",
          start_date_local: "1998-07-01T08:00:00",
          moving_time: 10,
          elapsed_time: 10,
        },
      ],
      wellness: [
        { id: "1998-07-01", weight: 70, restingHR: 50, hrv: 60, sleepSecs: 1, sleepQuality: 3 },
        { id: "1998-07-02", weight: 70, restingHR: 50, hrv: 60, sleepSecs: 1, sleepQuality: 3 },
      ],
      ftpHistory: [],
      streams: { "1": { watts: [100, 200], heartrate: [120, 140] } },
    },
  };
}

describe("store athlete reader", () => {
  it("reads the activity family only from the canonical reader and preserves stream aliases", async () => {
    const activityId = "a".repeat(64);
    const summary = {
      id: activityId,
      workoutId: "b".repeat(64),
      sessionSequence: 0,
      isMultisport: false,
      sport: "cycling",
      subSport: null,
      isTransition: false,
      startEpochSeconds: 899_539_200,
      timezoneOffsetSeconds: 0,
      localDate: "1998-07-02",
      elapsedSeconds: 600,
      timerSeconds: 600,
      movingSeconds: 590,
      distanceMeters: 5_000,
    } as const;
    const canonical: CanonicalActivityReader = {
      listActivities: vi.fn(async () => ({ activities: [summary], nextCursor: null })),
      getActivity: vi.fn(async () => ({ ...summary, laps: [] })),
      getStreams: vi.fn(async () => ({
        activityId,
        channels: { power: [100, 200], heart_rate: [120, 140], temperature: [20, 21] },
      })),
    };
    const reader = createStoreAthleteDataReader({
      snapshot: () => undefined,
      canonicalActivities: canonical,
      clockNow: () => Date.parse("1998-07-18T12:00:30.000Z"),
    });

    await expect(reader.getAthlete()).resolves.toMatchObject({
      ok: false,
      error: "store_read_unavailable",
    });
    await expect(
      reader.listActivities({ start: "1998-07-01", end: "1998-07-02" }),
    ).resolves.toEqual({ ok: true, value: [summary] });
    await expect(reader.getActivity({ id: activityId })).resolves.toEqual({
      ok: true,
      value: { ...summary, laps: [] },
    });
    await expect(
      reader.getStreams({ id: activityId, keys: ["watts", "heartrate", "temp"] }),
    ).resolves.toEqual({
      ok: true,
      value: { watts: [100, 200], heartrate: [120, 140], temp: [20, 21] },
    });
    expect(canonical.getStreams).toHaveBeenCalledWith({
      id: activityId,
      channels: ["power", "heart_rate", "temperature"],
    });
  });

  it("fails closed on canonical pagination, invalid streams, and reader errors without snapshot fallback", async () => {
    const activityId = "e".repeat(64);
    const listActivities = vi.fn<CanonicalActivityReader["listActivities"]>(async () => ({
      activities: [],
      nextCursor: { startEpochSeconds: 1, id: activityId },
    }));
    const getActivity = vi
      .fn<CanonicalActivityReader["getActivity"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error("invalid canonical row"), {
          name: "CanonicalActivityReadError",
          code: "invalid_row",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("invalid canonical input"), {
          name: "CanonicalActivityReadError",
          code: "invalid_input",
        }),
      );
    const getStreams = vi.fn<CanonicalActivityReader["getStreams"]>();
    const reader = createStoreAthleteDataReader({
      snapshot: () => produced(),
      canonicalActivities: { listActivities, getActivity, getStreams },
      clockNow: () => Date.parse("1998-07-18T12:00:30.000Z"),
    });

    await expect(
      reader.listActivities({ start: "1998-07-01", end: "1998-07-31" }),
    ).resolves.toEqual({
      ok: false,
      error: "invalid_input",
      message:
        "More than 200 activities match this date range. Narrow the date range and try again.",
    });
    await expect(reader.getActivity({ id: "1" })).resolves.toMatchObject({
      ok: false,
      error: "not_found",
    });
    await expect(reader.getActivity({ id: activityId })).resolves.toEqual({
      ok: false,
      error: "store_read_unavailable",
      message: "Canonical activity data is temporarily unavailable.",
    });
    await expect(reader.getActivity({ id: activityId })).resolves.toEqual({
      ok: false,
      error: "invalid_input",
      message: "Activity read input is invalid.",
    });
    await expect(
      reader.getStreams({ id: activityId, keys: ["watts", "power"] }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_input" });
    await expect(
      reader.getStreams({ id: activityId, keys: ["smooth_grade"] }),
    ).resolves.toMatchObject({ ok: false, error: "invalid_input" });
    expect(getStreams).not.toHaveBeenCalled();
  });

  it("validates real inclusive snapshot dates, preserves manifest order, and discloses freshness", async () => {
    const reader = createStoreAthleteDataReader({
      snapshot: () => produced(),
      clockNow: () => Date.parse("1998-07-18T12:02:00.000Z"),
    });
    const result = await reader.listWellness({ start: "1998-07-01", end: "1998-07-02" });
    expect(result.ok && result.value.map((row) => (row as { id: string }).id)).toEqual([
      "1998-07-01",
      "1998-07-02",
    ]);
    expect(result.ok && formatStoreFreshness(result.freshness!)).toBe(
      "Store data last synchronized 2 minutes ago (1998-07-18T12:00:00.000Z).",
    );
    await expect(reader.listWellness({ start: "1998-02-30" })).resolves.toEqual({
      ok: false,
      error: "invalid_input",
      message: "Dates must be real YYYY-MM-DD values with start on or before end.",
    });
  });

  it.each([
    ["ahead", "Europe/Amsterdam", "1998-07-18T22:30:00"],
    ["behind", "America/New_York", "1998-07-18T16:30:00"],
  ] as const)("derives snapshot age from the capture epoch when the civil zone is %s", async (
    _direction,
    calendarTimeZone,
    civilDateTime,
  ) => {
    const snapshot = {
      ...produced("not-an-instant"),
      captureClock: {
        captureEpochMs: Date.parse("1998-07-18T20:30:00.000Z"),
        civilDateTime,
        calendarTimeZone,
      },
    };
    const reader = createStoreAthleteDataReader({
      snapshot: () => snapshot,
      clockNow: () => Date.parse("1998-07-18T20:32:00.000Z"),
    });
    const result = await reader.getAthlete();
    expect(result.ok && result.freshness).toEqual({
      capturedAt: civilDateTime,
      ageMs: 120_000,
      label: "2 minutes",
    });
  });

  it("fails closed for a snapshot more than five minutes in the future", async () => {
    const reader = createStoreAthleteDataReader({
      snapshot: () => produced("1998-07-18T12:05:00.001Z"),
      clockNow: () => Date.parse("1998-07-18T12:00:00.000Z"),
    });
    await expect(reader.getAthlete()).resolves.toMatchObject({
      ok: false,
      error: "invalid_snapshot",
    });
  });

  it("routes every read tool through the selected store reader without touching the platform client", async () => {
    const activityId = "c".repeat(64);
    const summary = {
      id: activityId,
      workoutId: "d".repeat(64),
      sessionSequence: 0,
      isMultisport: false,
      sport: "cycling",
      subSport: null,
      isTransition: false,
      startEpochSeconds: 899_539_200,
      timezoneOffsetSeconds: 0,
      localDate: "1998-07-02",
      elapsedSeconds: 10,
      timerSeconds: 10,
      movingSeconds: 10,
      distanceMeters: null,
    } as const;
    const canonical: CanonicalActivityReader = {
      listActivities: vi.fn(async () => ({ activities: [summary], nextCursor: null })),
      getActivity: vi.fn(async () => ({ ...summary, laps: [] })),
      getStreams: vi.fn(async () => ({
        activityId,
        channels: { power: [100, 200] },
      })),
    };
    const network = vi.fn(() => {
      throw new Error("Network disabled for composition test");
    });
    const client = {
      athlete: { get: network },
      wellness: { list: network },
      activities: { list: network, get: network, getStreams: network },
      events: { list: network, get: network, create: network, update: network, delete: network },
    } as unknown as IntervalsClient;
    const reader = createStoreAthleteDataReader({
      snapshot: () => produced(),
      canonicalActivities: canonical,
      clockNow: () => Date.parse("1998-07-18T12:00:30.000Z"),
    });
    const pure = createPureCoreIntervalsTools(
      client,
      "UTC",
      reader,
      createMissingPlatformCalendarMutations(),
    );
    const configured = createCoreToolsWithSportConfig(client, ["Ride"], reader);

    await expect(pure.intervals_fetch_athlete!.execute!({}, {} as never)).resolves.toMatchObject({
      data: { sportSettings: [{ ftp: 250 }] },
      freshness:
        "Store data last synchronized less than 60 seconds ago (1998-07-18T12:00:00.000Z).",
    });
    await expect(
      pure.intervals_fetch_wellness!.execute!(
        { oldest: "1998-07-01", newest: "1998-07-02" },
        {} as never,
      ),
    ).resolves.toMatchObject({ data: [{ id: "1998-07-01" }, { id: "1998-07-02" }] });
    await expect(
      configured.intervals_fetch_activities!.execute!(
        { oldest: "1998-07-01", newest: "1998-07-02" },
        {} as never,
      ),
    ).resolves.toEqual([summary]);
    await expect(
      pure.intervals_fetch_activity!.execute!({ activityId }, {} as never),
    ).resolves.toEqual({ ...summary, laps: [] });
    await expect(
      pure.intervals_fetch_streams!.execute!({ activityId, types: ["watts"] }, {} as never),
    ).resolves.toMatchObject({ channels: { watts: { min: 100, max: 200, mean: 150 } } });
    await expect(
      configured.intervals_list_events!.execute!(
        { oldest: "1998-07-01", newest: "1998-07-02" },
        {} as never,
      ),
    ).resolves.toEqual({
      error: "store_read_unavailable",
      message: "Calendar reads are not available from the local training store.",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps platform registration names, descriptions, order, and JSON schemas byte-identical", () => {
    const ok = async (value: unknown) => ({ ok: true as const, value });
    const client = {
      athlete: { get: () => ok({}) },
      wellness: { list: () => ok([]) },
      activities: { list: () => ok([]), get: () => ok({}), getStreams: () => ok({}) },
      events: {
        list: () => ok([]),
        get: () => ok({ id: 1, startDateLocal: "2998-01-01" }),
        create: () => ok({}),
        update: () => ok({}),
        delete: () => ok({}),
      },
    } as unknown as IntervalsClient;
    const signature = (
      tools: Record<string, { description?: string; inputSchema?: unknown } | undefined>,
    ): string =>
      JSON.stringify(
        Object.entries(tools).map(([name, tool]) => [name, tool?.description, tool?.inputSchema]),
      );
    const athleteData = createPlatformAthleteDataReader(client);
    const calendarMutations = createPlatformCalendarMutations(client);
    const directPure = createPureCoreIntervalsTools(client, "UTC", athleteData, calendarMutations);
    const selectedPure = createPureCoreIntervalsTools(null, "UTC", athleteData, calendarMutations);
    expect(signature(selectedPure)).toBe(signature(directPure));
    expect(signature(createCoreToolsWithSportConfig(client, ["Ride"], athleteData))).toBe(
      signature(createCoreToolsWithSportConfig(null, ["Ride"], athleteData)),
    );
  });

  it("reads Workout and Race categories for Planning", async () => {
    const list = vi.fn(async () => ({ ok: true as const, value: [] }));
    const reader = createPlatformAthleteDataReader({ events: { list } } as unknown as IntervalsClient);
    await expect(reader.listCalendar({ start: "1998-07-01", end: "1998-07-31" }))
      .resolves.toEqual({ ok: true, value: [] });
    expect(list).toHaveBeenCalledWith({
      oldest: "1998-07-01",
      newest: "1998-07-31",
      category: ["WORKOUT", "RACE_A", "RACE_B", "RACE_C"],
    });
  });

  it("forwards an exact partial event update through the platform adapter", async () => {
    const update = vi.fn(async () => ({ ok: true as const, value: { id: 91 } }));
    const client = { events: { update } } as unknown as IntervalsClient;
    const mutations = createPlatformCalendarMutations(client);
    await expect(
      mutations.updateEvent({
        eventId: 91,
        patch: { name: "Tempo", movingTime: 3_600, icuTrainingLoad: 70 },
      }),
    ).resolves.toEqual({ id: 91 });
    expect(update).toHaveBeenCalledWith(91, {
      name: "Tempo",
      movingTime: 3_600,
      icuTrainingLoad: 70,
    });
  });

  it("keeps legacy platform activity results supported without promising canonical grouping fields", async () => {
    const platformActivity = {
      id: 42,
      startDateLocal: "1998-07-18T08:00:00",
      movingTime: 3_600,
      distance: 40_000,
      icuTrainingLoad: 50,
    };
    const client = {
      activities: {
        list: vi.fn(async () => ({ ok: true as const, value: [platformActivity] })),
      },
    } as unknown as IntervalsClient;
    const tools = createCoreToolsWithSportConfig(
      client,
      ["Ride"],
      createPlatformAthleteDataReader(client),
    );

    await expect(
      tools.intervals_fetch_activities!.execute!(
        { oldest: "1998-07-18", newest: "1998-07-18" },
        {} as never,
      ),
    ).resolves.toEqual([platformActivity]);
    expect(tools.intervals_fetch_activities!.description).toContain("other readers");
    expect(tools.intervals_fetch_activities!.description).not.toContain("Returns string IDs");
  });

  it("rejects reversed ranges at the tool boundary and again at store execution", async () => {
    const reader = createStoreAthleteDataReader({
      snapshot: () => produced(),
      clockNow: () => Date.parse("1998-07-18T12:00:00.000Z"),
    });
    const tools = createCoreToolsWithSportConfig(null, ["Ride"], reader);
    await expect(
      tools.intervals_fetch_activities!.execute!(
        { oldest: "1998-07-02", newest: "1998-07-01" },
        {} as never,
      ),
    ).resolves.toMatchObject({ error: "invalid_range" });
    await expect(
      reader.listActivities({ start: "1998-07-02", end: "1998-07-01" }),
    ).resolves.toMatchObject({
      ok: false,
      error: "invalid_input",
      message: "Dates must be real YYYY-MM-DD values with start on or before end.",
    });
    expect(
      (
        tools.intervals_fetch_activities!.inputSchema as {
          jsonSchema: { properties: { oldest: unknown } };
        }
      ).jsonSchema.properties.oldest,
    ).toMatchObject({ type: "string" });
  });

  it("keeps a fresh delete guard read and makes no delete for past or failed GET", async () => {
    const read = vi
      .fn<PlatformCalendarMutations["readEventForDelete"]>()
      .mockResolvedValue({
        id: 7,
        startDateLocal: "1998-07-01T00:00:00",
        category: "WORKOUT",
        tags: [COACH_EVENT_TAG],
      });
    const remove = vi.fn<PlatformCalendarMutations["deleteEvent"]>().mockResolvedValue({});
    const mutations: PlatformCalendarMutations = {
      createEvent: vi.fn(),
      readEventForDelete: read,
      updateEvent: vi.fn(),
      deleteEvent: remove,
    };
    const tools = createPureCoreIntervalsTools(null, "UTC", undefined, mutations);
    const past = await tools.intervals_delete_workout!.execute!({ eventId: 7 }, {} as never);
    expect(past).toMatchObject({ error: "past_workout_protected" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();

    read.mockRejectedValueOnce(new Error("GET failed"));
    await expect(
      tools.intervals_delete_workout!.execute!({ eventId: 8 }, {} as never),
    ).rejects.toThrow("GET failed");
    expect(remove).not.toHaveBeenCalled();
  });

  it("performs one guard read then one delete for a future workout", async () => {
    const order: string[] = [];
    const mutations: PlatformCalendarMutations = {
      createEvent: vi.fn(),
      readEventForDelete: vi.fn(async () => {
        order.push("get");
        return {
          id: 7,
          startDateLocal: "2998-07-01T00:00:00",
          category: "WORKOUT",
          tags: [COACH_EVENT_TAG],
        };
      }),
      updateEvent: vi.fn(),
      deleteEvent: vi.fn(async () => {
        order.push("delete");
        return {};
      }),
    };
    const tools = createPureCoreIntervalsTools(null, "UTC", undefined, mutations);
    await expect(
      tools.intervals_delete_workout!.execute!({ eventId: 7 }, {} as never),
    ).resolves.toEqual({ deleted: true });
    expect(order).toEqual(["get", "delete"]);
  });

  it("keeps delete registered with no credentials and performs zero platform requests", async () => {
    const tools = createPureCoreIntervalsTools(
      null,
      "UTC",
      undefined,
      createMissingPlatformCalendarMutations(),
    );
    await expect(
      tools.intervals_delete_workout!.execute!({ eventId: 7 }, {} as never),
    ).resolves.toEqual({
      error: "platform_credentials_required",
      message: "Calendar changes need platform credentials.",
    });
  });

  it("keeps update registered with no credentials and performs zero platform requests", async () => {
    const tools = createPureCoreIntervalsTools(
      null,
      "UTC",
      undefined,
      createMissingPlatformCalendarMutations(),
    );
    await expect(
      tools.intervals_update_workout!.execute!(
        { eventId: 7, changes: { name: "Tempo" } },
        {} as never,
      ),
    ).resolves.toEqual({
      error: "platform_credentials_required",
      message: "Calendar changes need platform credentials.",
    });
  });
});
