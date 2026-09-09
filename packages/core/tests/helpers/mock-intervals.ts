/**
 * MSW mock server for intervals.icu API.
 *
 * Intercepts fetch calls to https://intervals.icu so tests run without
 * hitting the real API.  Exports a factory that returns the server plus
 * a mutable array of every workout POSTed via the events endpoint.
 *
 * Usage:
 *   const { server, createdWorkouts, deletedEventIds } = createMockIntervalsServer();
 *   server.listen({ onUnhandledRequest: "bypass" });
 *   // ... run agent ...
 *   server.close();
 *   console.log(createdWorkouts); // inspect created workouts
 *   console.log(deletedEventIds); // inspect deleted event IDs
 */

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockAthlete {
  id: string;
  icu_ftp: number;
  icu_weight: number;
  icu_max_hr: number;
  icu_lthr: number;
  icu_resting_hr: number;
  name: string;
  email: string;
  sex: string;
  city: string;
  country: string;
  bio: string;
  locale: string;
  icu_date_of_birth: string;
  sport_settings: SportSetting[];
  [key: string]: unknown;
}

interface SportSetting {
  types: string[];
  ftp: number;
  ftp_type: string;
  lthr: number;
  max_hr: number;
  resting_hr: number;
  weight: number;
  power_zones: PowerZone[];
  hr_zones: HrZone[];
}

interface PowerZone {
  name: string;
  min: number;
  max: number;
}

interface HrZone {
  name: string;
  min: number;
  max: number;
}

export interface MockActivity {
  id: number;
  start_date_local: string;
  name: string;
  type: string;
  moving_time: number;
  elapsed_time: number;
  distance: number;
  icu_training_load: number;
  icu_intensity: number;
  average_watts: number;
  average_heartrate: number;
  max_heartrate: number;
  total_elevation_gain: number;
  [key: string]: unknown;
}

export interface MockWellness {
  id: string;
  ctl: number;
  atl: number;
  rampRate: number;
  ctlLoad: number;
  atlLoad: number;
  sportInfo: Record<string, unknown>;
  weight: number;
  restingHR: number;
  hrv: number;
  hrvSDNN: number;
  sleepSecs: number;
  sleepQuality: number;
  [key: string]: unknown;
}

export interface CreatedWorkout {
  id: number;
  start_date_local: string;
  category: string;
  name: string;
  type: string;
  moving_time: number;
  icu_training_load?: number;
  description?: string;
  [key: string]: unknown;
}

export interface MockIntervalsOptions {
  athlete?: Partial<MockAthlete>;
  activities?: Partial<MockActivity>[];
  wellness?: Partial<MockWellness>[];
}

// ---------------------------------------------------------------------------
// Default data factories
// ---------------------------------------------------------------------------

function defaultAthlete(overrides: Partial<MockAthlete> = {}): MockAthlete {
  const ftp = overrides.icu_ftp ?? 200;
  const maxHr = overrides.icu_max_hr ?? 190;
  const restHr = overrides.icu_resting_hr ?? 52;
  const weight = overrides.icu_weight ?? 75;
  const lthr = overrides.icu_lthr ?? Math.round(maxHr * 0.82);

  return {
    id: "i12345",
    name: "Test Athlete",
    email: "test@example.com",
    sex: "M",
    city: "Test City",
    country: "US",
    bio: "",
    locale: "en",
    icu_date_of_birth: "1992-06-15",
    icu_ftp: ftp,
    icu_weight: weight,
    icu_max_hr: maxHr,
    icu_lthr: lthr,
    icu_resting_hr: restHr,
    sport_settings: [
      {
        types: ["Ride", "VirtualRide"],
        ftp,
        ftp_type: "POWER",
        lthr,
        max_hr: maxHr,
        resting_hr: restHr,
        weight,
        power_zones: [
          { name: "Z1 Recovery", min: 0, max: Math.round(ftp * 0.55) },
          { name: "Z2 Endurance", min: Math.round(ftp * 0.55), max: Math.round(ftp * 0.75) },
          { name: "Z3 Tempo", min: Math.round(ftp * 0.75), max: Math.round(ftp * 0.9) },
          { name: "Z4 Threshold", min: Math.round(ftp * 0.9), max: Math.round(ftp * 1.05) },
          { name: "Z5 VO2max", min: Math.round(ftp * 1.05), max: Math.round(ftp * 1.2) },
          { name: "Z6 Anaerobic", min: Math.round(ftp * 1.2), max: Math.round(ftp * 1.5) },
          { name: "Z7 Neuromuscular", min: Math.round(ftp * 1.5), max: 2000 },
        ],
        hr_zones: [
          { name: "Z1", min: restHr, max: Math.round(restHr + (maxHr - restHr) * 0.6) },
          { name: "Z2", min: Math.round(restHr + (maxHr - restHr) * 0.6), max: Math.round(restHr + (maxHr - restHr) * 0.7) },
          { name: "Z3", min: Math.round(restHr + (maxHr - restHr) * 0.7), max: Math.round(restHr + (maxHr - restHr) * 0.8) },
          { name: "Z4", min: Math.round(restHr + (maxHr - restHr) * 0.8), max: Math.round(restHr + (maxHr - restHr) * 0.9) },
          { name: "Z5", min: Math.round(restHr + (maxHr - restHr) * 0.9), max: maxHr },
        ],
      },
    ],
    ...overrides,
  };
}

function defaultActivities(overrides?: Partial<MockActivity>[]): MockActivity[] {
  if (overrides) {
    return overrides.map((o, i) => ({
      id: i + 1000,
      start_date_local: o.start_date_local ?? isoDateNDaysAgo(14 - i),
      name: o.name ?? "Ride",
      type: "Ride",
      moving_time: 3600,
      elapsed_time: 4000,
      distance: 30000,
      icu_training_load: 60,
      icu_intensity: 0.7,
      average_watts: 155,
      average_heartrate: 138,
      max_heartrate: 170,
      total_elevation_gain: 200,
      ...o,
    }));
  }

  // Generate ~10 realistic recent rides over the past 14 days
  const rides: MockActivity[] = [
    ride(1001, 1, "Recovery Spin", 2700, 40, 120, 115, 135),
    ride(1002, 2, "Sweet Spot Intervals", 5400, 85, 185, 152, 175),
    ride(1003, 4, "Zone 2 Endurance", 7200, 65, 150, 135, 155),
    ride(1004, 5, "VO2max Intervals", 4800, 95, 210, 158, 185),
    ride(1005, 7, "Long Ride", 9000, 110, 148, 138, 168),
    ride(1006, 8, "Recovery Spin", 2700, 38, 118, 112, 130),
    ride(1007, 9, "Tempo Ride", 5400, 78, 168, 148, 170),
    ride(1008, 11, "Sweet Spot 2x20", 5400, 88, 182, 155, 178),
    ride(1009, 12, "Zone 2 Endurance", 6300, 58, 148, 132, 152),
    ride(1010, 13, "Group Ride", 7200, 100, 175, 150, 188),
  ];
  return rides;
}

function ride(
  id: number,
  daysAgo: number,
  name: string,
  movingTime: number,
  tss: number,
  avgWatts: number,
  avgHr: number,
  maxHr: number,
): MockActivity {
  return {
    id,
    start_date_local: `${isoDateNDaysAgo(daysAgo)}T08:00:00`,
    name,
    type: "Ride",
    moving_time: movingTime,
    elapsed_time: Math.round(movingTime * 1.12),
    distance: Math.round((movingTime / 3600) * 28 * 1000), // ~28 km/h average
    icu_training_load: tss,
    icu_intensity: Math.round((tss / (movingTime / 3600)) * 0.01 * 100) / 100,
    average_watts: avgWatts,
    average_heartrate: avgHr,
    max_heartrate: maxHr,
    total_elevation_gain: Math.round((movingTime / 3600) * 150),
  };
}

function defaultWellness(overrides?: Partial<MockWellness>[]): MockWellness[] {
  if (overrides) {
    return overrides.map((o, i) => ({
      id: isoDateNDaysAgo(7 - i),
      ctl: 55,
      atl: 48,
      rampRate: 0.5,
      ctlLoad: 55,
      atlLoad: 48,
      sportInfo: {},
      weight: 75,
      restingHR: 52,
      hrv: 45,
      hrvSDNN: 48,
      sleepSecs: 27000,
      sleepQuality: 3,
      ...o,
    }));
  }

  // 7 days of wellness data with slight daily variation
  return Array.from({ length: 7 }, (_, i) => {
    const day = 7 - i;
    const ctlBase = 55;
    const atlBase = 48;
    return {
      id: isoDateNDaysAgo(day),
      ctl: ctlBase + Math.round((Math.sin(i * 0.8) * 2) * 10) / 10,
      atl: atlBase + Math.round((Math.sin(i * 1.2) * 4) * 10) / 10,
      rampRate: Math.round((0.3 + Math.sin(i * 0.5) * 0.3) * 10) / 10,
      ctlLoad: ctlBase + Math.round(Math.sin(i * 0.8) * 2 * 10) / 10,
      atlLoad: atlBase + Math.round(Math.sin(i * 1.2) * 4 * 10) / 10,
      sportInfo: {},
      weight: 75 + Math.round(Math.sin(i * 0.7) * 0.3 * 10) / 10,
      restingHR: 50 + Math.round(Math.random() * 4),
      hrv: 42 + Math.round(Math.random() * 8),
      hrvSDNN: 45 + Math.round(Math.random() * 10),
      sleepSecs: 25200 + Math.round(Math.random() * 3600),
      sleepQuality: 3,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMockIntervalsServer(options: MockIntervalsOptions = {}) {
  const athlete = defaultAthlete(options.athlete);
  const activities = defaultActivities(options.activities);
  const wellness = defaultWellness(options.wellness);
  const createdWorkouts: CreatedWorkout[] = [];
  const updatedEventIds: number[] = [];
  const deletedEventIds: number[] = [];
  let nextEventId = 5000;

  const handlers = [
    // GET /api/v1/athlete/:id — athlete profile
    http.get("https://intervals.icu/api/v1/athlete/:id", () => {
      return HttpResponse.json(athlete);
    }),

    // GET /api/v1/athlete/:id/activities — recent activities
    http.get("https://intervals.icu/api/v1/athlete/:id/activities", ({ request }) => {
      const url = new URL(request.url);
      const oldest = url.searchParams.get("oldest");
      const newest = url.searchParams.get("newest");

      let filtered = activities;
      if (oldest) {
        filtered = filtered.filter((a) => a.start_date_local >= oldest);
      }
      if (newest) {
        filtered = filtered.filter((a) => a.start_date_local <= newest + "T23:59:59");
      }
      return HttpResponse.json(filtered);
    }),

    // GET /api/v1/athlete/:id/wellness — wellness/fitness data
    http.get("https://intervals.icu/api/v1/athlete/:id/wellness", ({ request }) => {
      const url = new URL(request.url);
      const oldest = url.searchParams.get("oldest");
      const newest = url.searchParams.get("newest");

      let filtered = wellness;
      if (oldest) {
        filtered = filtered.filter((w) => w.id >= oldest);
      }
      if (newest) {
        filtered = filtered.filter((w) => w.id <= newest);
      }
      return HttpResponse.json(filtered);
    }),

    // POST /api/v1/athlete/:id/events — create workout
    http.post("https://intervals.icu/api/v1/athlete/:id/events", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const eventId = nextEventId++;
      const workout: CreatedWorkout = {
        id: eventId,
        start_date_local: (body.start_date_local as string) ?? "",
        category: (body.category as string) ?? "WORKOUT",
        name: (body.name as string) ?? "",
        type: (body.type as string) ?? "Ride",
        moving_time: (body.moving_time as number) ?? 0,
        icu_training_load: body.icu_training_load as number | undefined,
        description: body.description as string | undefined,
        ...body,
      };
      createdWorkouts.push(workout);
      return HttpResponse.json({ id: eventId, ...body }, { status: 200 });
    }),

    // GET /api/v1/athlete/:id/events — list scheduled events
    http.get("https://intervals.icu/api/v1/athlete/:id/events", ({ request }) => {
      const url = new URL(request.url);
      const oldest = url.searchParams.get("oldest");
      const newest = url.searchParams.get("newest");

      let filtered = createdWorkouts;
      if (oldest) {
        filtered = filtered.filter((w) => w.start_date_local >= oldest);
      }
      if (newest) {
        filtered = filtered.filter((w) => w.start_date_local <= newest + "T23:59:59");
      }
      return HttpResponse.json(filtered);
    }),

    // GET /api/v1/athlete/:id/events/:eventId — fetch single event (used by the
    // delete tool to read the authoritative date before deciding whether to delete)
    http.get(
      "https://intervals.icu/api/v1/athlete/:id/events/:eventId",
      ({ params }) => {
        const eventId = Number(params.eventId);
        const workout = createdWorkouts.find((w) => w.id === eventId);
        if (!workout) {
          return HttpResponse.json({ error: "not_found" }, { status: 404 });
        }
        return HttpResponse.json(workout);
      },
    ),

    http.put(
      "https://intervals.icu/api/v1/athlete/:id/events/:eventId",
      async ({ params, request }) => {
        const eventId = Number(params.eventId);
        const workout = createdWorkouts.find((candidate) => candidate.id === eventId);
        if (!workout) {
          return HttpResponse.json({ error: "not_found" }, { status: 404 });
        }
        const patch = (await request.json()) as Record<string, unknown>;
        Object.assign(workout, patch);
        updatedEventIds.push(eventId);
        return HttpResponse.json(workout);
      },
    ),

    // DELETE /api/v1/athlete/:id/events/:eventId — delete scheduled event
    // (no notBefore enforcement — the real API's notBefore only caps the `others`
    // cascade, not the target event, so protection lives client-side in the tool)
    http.delete(
      "https://intervals.icu/api/v1/athlete/:id/events/:eventId",
      ({ params }) => {
        const eventId = Number(params.eventId);
        const idx = createdWorkouts.findIndex((w) => w.id === eventId);
        if (idx === -1) {
          return HttpResponse.json({ error: "not_found" }, { status: 404 });
        }
        createdWorkouts.splice(idx, 1);
        deletedEventIds.push(eventId);
        return new HttpResponse(null, { status: 200 });
      },
    ),
  ];

  const server = setupServer(...handlers);

  return { server, createdWorkouts, updatedEventIds, deletedEventIds };
}
