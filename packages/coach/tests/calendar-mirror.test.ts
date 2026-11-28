import { describe, expect, it } from "vitest";
import {
  createPlanCalendarMirrorRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  type PlanRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  cleanupPlanCalendar,
  expectedIcuFingerprint,
  icuEventFingerprint,
  icuEventType,
  mirrorPlanCalendar,
  planWorkoutFingerprint,
  readIcuCopies,
  saveWeekDelivery,
  storedIcuCopy,
  type CalendarEventCreate,
  type CalendarEventUpdate,
  type CalendarMirrorPort,
} from "@enduragent/engine/calendar";
import { planMirrorExternalId, type PlanMirrorEvent } from "@enduragent/engine";
import { workoutContent } from "@enduragent/sport-cycling";
import { PLAN_WORKOUT_DESCRIBERS, planWorkoutDescriber } from "../src/plan-workout-description.js";

const withoutFtp = planWorkoutDescriber({ ftpKnown: false });
const NONE_MATCHED: ReadonlySet<string> = new Set();

const PLAN_ID = "0".repeat(25) + "1";
const PLAN_KIND = "full_plan" as const;
const MONDAY = 19980803;
const NOW = 902_102_400_000;

function workoutId(index: number): string {
  return `${"0".repeat(24)}${String(10 + index).padStart(2, "0")}`;
}

function plan(): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Synthetic base",
    primaryGoal: "Ride longer",
    startDateKey: MONDAY,
    targetDateKey: null,
    status: "active",
    kind: PLAN_KIND,
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: NOW,
    updatedAtMs: NOW,
    deviceId: "test-device",
    hlcPhysicalMs: NOW,
    hlcCounter: 0,
  };
}

function workout(
  index: number,
  dateKey: number,
  extra: Partial<PlanWorkoutRecord> = {},
): PlanWorkoutRecord {
  return {
    id: workoutId(index),
    planId: PLAN_ID,
    dateKey,
    sport: "cycling",
    name: `Endurance ${index}`,
    durationS: 3_600,
    structureJson: JSON.stringify({ description: `- ${60}m 56-75%` }),
    origin: "coach",
    deviceId: "test-device",
    hlcPhysicalMs: NOW,
    hlcCounter: 0,
    ...extra,
  };
}

function intervalsAsMeasured() {
  const events: PlanMirrorEvent[] = [];
  let next = 500;
  let version = 0;
  const writes: string[] = [];
  let failedUpdates = 0;
  const stamp = () => `1998-01-01T00:00:00.${String(++version).padStart(3, "0")}+00:00`;
  const content = ({ description, durationS }: CalendarEventCreate | CalendarEventUpdate) => ({
    description,
    durationS:
      description === null || durationS === null || !/^\s*-\s/m.test(description)
        ? durationS
        : durationS + 1,
  });
  const port: CalendarMirrorPort = {
    async listEvents(range) {
      return events.filter(
        (event) => event.dateKey >= range.startDateKey && event.dateKey <= range.endDateKey,
      );
    },
    async readEvent({ eventId }) {
      return events.find((event) => event.id === eventId) ?? null;
    },
    async createEvent(input: CalendarEventCreate) {
      writes.push(`create ${input.dateKey}`);
      const event: PlanMirrorEvent = {
        id: next++,
        dateKey: input.dateKey,
        externalId: input.externalId,
        name: input.name,
        type: icuEventType(input.sport),
        ...content(input),
        updated: stamp(),
      };
      events.push(event);
      return event;
    },
    async updateEvent(input: CalendarEventUpdate) {
      if (failedUpdates > 0) {
        failedUpdates -= 1;
        throw new Error("provider unavailable");
      }
      writes.push(`update ${input.eventId}`);
      const index = events.findIndex((event) => event.id === input.eventId);
      const current = events[index];
      if (current === undefined) throw new Error("missing");
      const event = {
        ...current,
        dateKey: input.dateKey,
        name: input.name,
        type: icuEventType(input.sport),
        ...content(input),
        updated: stamp(),
      };
      events[index] = event;
      return event;
    },
    async deleteEvent({ eventId }) {
      writes.push(`delete ${eventId}`);
      const index = events.findIndex((event) => event.id === eventId);
      if (index < 0) throw new Error("missing");
      events.splice(index, 1);
    },
  };
  return {
    port,
    events,
    writes,
    failNextUpdate() {
      failedUpdates += 1;
    },
    edit(eventId: number, patch: Partial<PlanMirrorEvent>) {
      const index = events.findIndex((event) => event.id === eventId);
      const current = events[index];
      if (current === undefined) throw new Error("missing");
      events[index] = { ...current, ...patch, updated: stamp() };
    },
  };
}

async function approveFirstWeeks(mirror: ReturnType<typeof createPlanCalendarMirrorRepository>) {
  await saveWeekDelivery(
    mirror,
    PLAN_ID,
    { kind: "approved", firstSetWeeks: [1, 2], approvedWeeks: [] },
    NOW,
  );
}

async function setup() {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  await createPlanRepository(store).replace(plan(), []);
  const mirror = createPlanCalendarMirrorRepository(store);
  const intervals = intervalsAsMeasured();
  const deps = {
    calendar: intervals.port,
    mirror,
    describe: withoutFtp,
    describers: PLAN_WORKOUT_DESCRIBERS,
    now: () => NOW,
  };
  return { store, mirror, intervals, deps };
}

describe("the calendar mirror", () => {
  it("predicts intervals.icu's stored fingerprint for a fresh write", async () => {
    const { intervals } = await setup();
    const described = workout(1, MONDAY);
    const plain = workout(2, MONDAY + 1, { structureJson: "{}" });
    const one = await intervals.port.createEvent({
      planId: PLAN_ID,
      planWorkoutId: described.id,
      dateKey: described.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, described.id),
      name: described.name,
      sport: "cycling",
      durationS: described.durationS,
      description: withoutFtp(described.structureJson),
    });
    const two = await intervals.port.createEvent({
      planId: PLAN_ID,
      planWorkoutId: plain.id,
      dateKey: plain.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, plain.id),
      name: plain.name,
      sport: "cycling",
      durationS: plain.durationS,
      description: withoutFtp(plain.structureJson),
    });
    expect(one.durationS).toBe(3_601);
    expect(icuEventFingerprint(one)).toBe(expectedIcuFingerprint(described, withoutFtp));
    expect(icuEventFingerprint(two)).toBe(expectedIcuFingerprint(plain, withoutFtp));
    expect(icuEventFingerprint({ ...two, durationS: 3_000 })).not.toBe(
      expectedIcuFingerprint(plain, withoutFtp),
    );
  });

  it("keeps the fingerprints it stored before for workouts whose text does not change", () => {
    const withFtp = planWorkoutDescriber({ ftpKnown: true });
    const before = (row: PlanWorkoutRecord, description: string | null) =>
      JSON.stringify([row.dateKey, row.name, row.sport, row.durationS, description]);
    const legacy = workout(1, MONDAY);
    const emptyText = workout(2, MONDAY, { structureJson: JSON.stringify({ description: "" }) });
    const chatWithoutContent = workout(3, MONDAY, {
      structureJson: JSON.stringify({ id: "draft-3", kind: "endurance", minutes: 60 }),
    });
    const chatWithContent = workout(4, MONDAY, {
      structureJson: JSON.stringify({ id: "draft-4", kind: "endurance", content: { version: 1 } }),
    });
    for (const describer of [withFtp, withoutFtp]) {
      expect(planWorkoutFingerprint(legacy, describer)).toBe(before(legacy, "- 60m 56-75%"));
      expect(planWorkoutFingerprint(emptyText, describer)).toBe(before(emptyText, ""));
      expect(planWorkoutFingerprint(chatWithoutContent, describer)).toBe(
        before(chatWithoutContent, null),
      );
    }
    expect(planWorkoutFingerprint(chatWithContent, withoutFtp)).toBe(before(chatWithContent, null));
  });

  it("sends this week and next once approved, and nothing on a second run", async () => {
    const { mirror, intervals, deps } = await setup();
    const workouts = [workout(1, MONDAY + 1), workout(2, MONDAY + 8), workout(3, MONDAY + 15)];
    const input = {
      plan: plan(),
      workouts,
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    expect(await mirrorPlanCalendar(input, deps)).toEqual({ kind: "waiting-for-first-approve" });
    await saveWeekDelivery(
      mirror,
      PLAN_ID,
      { kind: "approved", firstSetWeeks: [1, 2], approvedWeeks: [] },
      NOW,
    );
    expect(await mirrorPlanCalendar(input, deps)).toMatchObject({
      kind: "ran",
      written: 2,
      failures: [],
    });
    expect(intervals.events.map((event) => event.dateKey)).toEqual([MONDAY + 1, MONDAY + 8]);
    expect(await mirrorPlanCalendar(input, deps)).toMatchObject({ kind: "ran", written: 0 });
    expect(intervals.writes).toEqual([`create ${MONDAY + 1}`, `create ${MONDAY + 8}`]);
  });

  it("opens the card for a workout the athlete moved out of the window, instead of calling it deleted", async () => {
    const { mirror, intervals, deps } = await setup();
    const workouts = [workout(1, MONDAY + 1)];
    const input = {
      plan: plan(),
      workouts,
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await saveWeekDelivery(
      mirror,
      PLAN_ID,
      { kind: "approved", firstSetWeeks: [1, 2], approvedWeeks: [] },
      NOW,
    );
    await mirrorPlanCalendar(input, deps);
    const event = intervals.events[0];
    if (event === undefined) throw new Error("Expected an event");
    intervals.edit(event.id, { dateKey: MONDAY + 22 });
    expect(await mirrorPlanCalendar(input, deps)).toMatchObject({
      kind: "ran",
      changedInIcu: 1,
      written: 0,
    });
    const copy = storedIcuCopy((await readIcuCopies(mirror, PLAN_ID)).get(workoutId(1)));
    expect(copy).toMatchObject({
      kind: "changed-in-icu",
      shown: { kind: "present", dateKey: MONDAY + 22 },
    });
  });

  it("skips a write when intervals.icu already holds what the app would send", async () => {
    const { mirror, intervals, deps } = await setup();
    const first = workout(1, MONDAY + 1);
    const input = {
      plan: plan(),
      workouts: [first],
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await saveWeekDelivery(
      mirror,
      PLAN_ID,
      { kind: "approved", firstSetWeeks: [1, 2], approvedWeeks: [] },
      NOW,
    );
    await mirrorPlanCalendar(input, deps);
    const renamed = { ...first, name: "Renamed by the coach" };
    const event = intervals.events[0];
    if (event === undefined) throw new Error("Expected an event");
    await mirrorPlanCalendar(
      { ...input, workouts: [renamed] },
      {
        ...deps,
        calendar: {
          ...deps.calendar,
          readEvent: async (request) => {
            intervals.edit(event.id, { name: "Renamed by the coach" });
            return deps.calendar.readEvent(request);
          },
        },
      },
    );
    expect(intervals.writes.filter((write) => write.startsWith("update"))).toEqual([]);
    expect(storedIcuCopy((await readIcuCopies(mirror, PLAN_ID)).get(first.id))).toMatchObject({
      kind: "on-icu",
      baseline: {
        readBack: { fingerprint: icuEventFingerprint({ ...event, name: "Renamed by the coach" }) },
      },
    });
  });

  it("does not update over an edit made between the list and the write", async () => {
    const { mirror, intervals, deps } = await setup();
    const first = workout(1, MONDAY + 1);
    const input = {
      plan: plan(),
      workouts: [first],
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await saveWeekDelivery(
      mirror,
      PLAN_ID,
      { kind: "approved", firstSetWeeks: [1, 2], approvedWeeks: [] },
      NOW,
    );
    await mirrorPlanCalendar(input, deps);
    const event = intervals.events[0];
    if (event === undefined) throw new Error("Expected an event");
    await mirrorPlanCalendar(
      { ...input, workouts: [{ ...first, name: "Coach rename" }] },
      {
        ...deps,
        calendar: {
          ...deps.calendar,
          readEvent: async (request) => {
            intervals.edit(event.id, { name: "Athlete rename" });
            return deps.calendar.readEvent(request);
          },
        },
      },
    );
    expect(intervals.events[0]?.name).toBe("Athlete rename");
    expect(storedIcuCopy((await readIcuCopies(mirror, PLAN_ID)).get(first.id)).kind).toBe(
      "changed-in-icu",
    );
  });
});

describe("what the mirror counts and sends", () => {
  it("stops counting an old failed write once the athlete's edit opens a card", async () => {
    const { mirror, intervals, deps } = await setup();
    const first = workout(1, MONDAY + 1);
    const input = {
      plan: plan(),
      workouts: [first],
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await approveFirstWeeks(mirror);
    await mirrorPlanCalendar(input, deps);
    const renamed = { ...input, workouts: [{ ...first, name: "Coach rename" }] };
    intervals.failNextUpdate();
    expect(await mirrorPlanCalendar(renamed, deps)).toMatchObject({
      kind: "ran",
      failures: ["calendar-update-failed"],
    });
    const event = intervals.events[0];
    if (event === undefined) throw new Error("Expected an event");
    intervals.edit(event.id, { name: "Athlete rename" });
    for (let run = 0; run < 2; run += 1) {
      expect(await mirrorPlanCalendar(renamed, deps)).toMatchObject({
        kind: "ran",
        failures: [],
        changedInIcu: 1,
      });
    }
    expect((await readIcuCopies(mirror, PLAN_ID)).get(first.id)?.lastWrite).toEqual({
      kind: "none",
    });
  });

  it("sends a length or sport change for a workout described in free text", async () => {
    const { mirror, intervals, deps } = await setup();
    const first = workout(1, MONDAY + 1, {
      structureJson: JSON.stringify({ description: "Easy spin, stay relaxed" }),
    });
    const input = {
      plan: plan(),
      workouts: [first],
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await approveFirstWeeks(mirror);
    await mirrorPlanCalendar(input, deps);
    const event = intervals.events[0];
    if (event === undefined) throw new Error("Expected an event");
    expect(event).toMatchObject({ durationS: 3_600, type: "Ride" });
    await mirrorPlanCalendar({ ...input, workouts: [{ ...first, durationS: 3_000 }] }, deps);
    expect(intervals.events[0]).toMatchObject({ durationS: 3_000, type: "Ride" });
    await mirrorPlanCalendar(
      { ...input, workouts: [{ ...first, durationS: 3_000, sport: "running" }] },
      deps,
    );
    expect(intervals.events[0]).toMatchObject({ durationS: 3_000, type: "Run" });
    expect(intervals.writes).toEqual([
      `create ${MONDAY + 1}`,
      `update ${event.id}`,
      `update ${event.id}`,
    ]);
  });

  it("leaves a sent workout on intervals.icu when its origin changes to the athlete", async () => {
    const { mirror, intervals, deps } = await setup();
    const first = workout(1, MONDAY + 1);
    const input = {
      plan: plan(),
      workouts: [first],
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await approveFirstWeeks(mirror);
    await mirrorPlanCalendar(input, deps);
    await mirrorPlanCalendar({ ...input, workouts: [{ ...first, origin: "athlete" }] }, deps);
    expect(intervals.events).toHaveLength(1);
    expect(intervals.writes).toEqual([`create ${MONDAY + 1}`]);
    expect(storedIcuCopy((await readIcuCopies(mirror, PLAN_ID)).get(first.id)).kind).toBe("on-icu");
  });
});

describe("a fingerprint saved in an older format", () => {
  it("takes intervals.icu's copy as the new baseline instead of opening a card", async () => {
    const { store, mirror, intervals, deps } = await setup();
    const first = workout(1, MONDAY + 1);
    const input = {
      plan: plan(),
      workouts: [first],
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await approveFirstWeeks(mirror);
    await mirrorPlanCalendar(input, deps);
    const record = (await readIcuCopies(mirror, PLAN_ID)).get(first.id);
    if (record === undefined) throw new Error("Expected a copy");
    const copy = JSON.parse(record.stateJson);
    copy.baseline.readBack.fingerprint = JSON.stringify([MONDAY + 1, first.name, null, 3_600]);
    await store.run("UPDATE plan_icu_copy SET state_json=? WHERE plan_workout_id=?", [
      JSON.stringify(copy),
      first.id,
    ]);
    expect(await mirrorPlanCalendar(input, deps)).toMatchObject({
      kind: "ran",
      written: 0,
      changedInIcu: 0,
    });
    const after = storedIcuCopy((await readIcuCopies(mirror, PLAN_ID)).get(first.id));
    expect(after.kind).toBe("on-icu");
    expect(after.kind === "on-icu" && after.baseline.readBack.fingerprint).toBe(
      icuEventFingerprint(intervals.events[0] ?? { id: 0, dateKey: 0, externalId: null }),
    );
    expect(intervals.writes).toEqual([`create ${MONDAY + 1}`]);
  });
});

describe("pairing rides with mirrored workouts", () => {
  it("reads each mirrored workout's intervals.icu event id for the matcher", async () => {
    const { store, mirror, intervals, deps } = await setup();
    const workouts = [workout(1, MONDAY + 1), workout(2, MONDAY + 2)];
    await saveWeekDelivery(
      mirror,
      PLAN_ID,
      { kind: "approved", firstSetWeeks: [1, 2], approvedWeeks: [] },
      NOW,
    );
    await mirrorPlanCalendar(
      {
        plan: plan(),
        workouts,
        todayDateKey: MONDAY,
        firstEligibleDateKey: MONDAY,
        matchedWorkoutIds: NONE_MATCHED,
      },
      deps,
    );
    const identities =
      await createPlanWorkoutMatchRepository(store).readProviderIdentities(PLAN_ID);
    expect(
      [...identities].sort((left, right) => left.providerEventId - right.providerEventId),
    ).toEqual(
      intervals.events.map((event) => ({
        planWorkoutId: event.externalId?.split(":").at(-1),
        providerEventId: event.id,
      })),
    );
  });
});

describe("the End and Replace cleanup", () => {
  it("removes the Plan's own later workouts, keeps today's and the athlete's changes", async () => {
    const { store, mirror, intervals, deps } = await setup();
    const workouts = [workout(1, MONDAY), workout(2, MONDAY + 1), workout(3, MONDAY + 2)];
    const input = {
      plan: plan(),
      workouts,
      todayDateKey: MONDAY,
      firstEligibleDateKey: MONDAY,
      matchedWorkoutIds: NONE_MATCHED,
    };
    await saveWeekDelivery(
      mirror,
      PLAN_ID,
      { kind: "approved", firstSetWeeks: [1, 2], approvedWeeks: [] },
      NOW,
    );
    await mirrorPlanCalendar(input, deps);
    const edited = intervals.events.find((event) => event.dateKey === MONDAY + 2);
    if (edited === undefined) throw new Error("Expected an event");
    intervals.edit(edited.id, { name: "Mine" });
    await mirrorPlanCalendar(input, deps);
    const reconciliation = createPlanReconciliationRepository(store);
    const job = await reconciliation.createOrGetJob({
      id: "1".repeat(26),
      planId: PLAN_ID,
      kind: "cleanup",
      windowStartDateKey: MONDAY + 1,
      windowEndDateKey: MONDAY + 27,
      createdAtMs: NOW,
    });
    expect(
      await cleanupPlanCalendar(job, { ...deps, reconciliation, workouts: async () => workouts }),
    ).toEqual({
      kind: "verified",
      removed: 1,
      kept: 1,
    });
    expect(intervals.events.map((event) => event.dateKey)).toEqual([MONDAY, MONDAY + 2]);
    expect(storedIcuCopy((await readIcuCopies(mirror, PLAN_ID)).get(workoutId(3)))).toEqual({
      kind: "kept-as-yours",
      eventId: edited.id,
    });
  });

  it("removes the Plan's own workouts that have no copy record or a create that timed out", async () => {
    const { store, mirror, intervals, deps } = await setup();
    await approveFirstWeeks(mirror);
    const timedOut = workout(1, MONDAY + 1);
    const legacy = workout(2, MONDAY + 2);
    await mirrorPlanCalendar(
      {
        plan: plan(),
        workouts: [timedOut],
        todayDateKey: MONDAY,
        firstEligibleDateKey: MONDAY,
        matchedWorkoutIds: NONE_MATCHED,
      },
      {
        ...deps,
        calendar: {
          ...deps.calendar,
          createEvent: async (request) => {
            await deps.calendar.createEvent(request);
            throw new Error("timed out");
          },
        },
      },
    );
    expect(storedIcuCopy((await readIcuCopies(mirror, PLAN_ID)).get(timedOut.id))).toEqual({
      kind: "not-sent",
      owner: "plan",
    });
    intervals.events.push({
      id: 900,
      dateKey: legacy.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, legacy.id),
      name: legacy.name,
      type: "Ride",
      description: "- 60m 56-75%",
      durationS: 3_601,
      updated: "1998-01-01T00:00:00.900+00:00",
    });
    const reconciliation = createPlanReconciliationRepository(store);
    const job = await reconciliation.createOrGetJob({
      id: "1".repeat(26),
      planId: PLAN_ID,
      kind: "cleanup",
      windowStartDateKey: MONDAY + 1,
      windowEndDateKey: MONDAY + 27,
      createdAtMs: NOW,
    });
    await reconciliation.prepareItem({
      id: "2".repeat(26),
      jobId: job.id,
      planWorkoutId: null,
      operation: "delete",
      dateKey: MONDAY + 2,
      externalId: planMirrorExternalId(PLAN_ID, legacy.id),
      expectedJson: "{}",
      createdAtMs: NOW,
    });
    expect(
      await cleanupPlanCalendar(job, {
        ...deps,
        reconciliation,
        workouts: async () => [timedOut, legacy],
      }),
    ).toEqual({ kind: "verified", removed: 2, kept: 0 });
    expect(intervals.events).toEqual([]);
    expect(await reconciliation.readJob(job.id)).toMatchObject({ status: "verified" });
  });

  it("removes the Plan's own leftovers whether they were sent with an FTP or without one", async () => {
    const { store, intervals, deps } = await setup();
    const withFtp = planWorkoutDescriber({ ftpKnown: true });
    const contentRow = (index: number) =>
      workout(index, MONDAY + index, {
        structureJson: JSON.stringify({
          id: `draft-${index}`,
          kind: "endurance",
          minutes: 60,
          content: workoutContent("endurance", 60),
        }),
      });
    const sentWithFtp = contentRow(1);
    const sentWithout = contentRow(2);
    const leftover = (row: PlanWorkoutRecord, description: string | null): PlanMirrorEvent => ({
      id: 900 + Number(row.id.slice(-2)),
      dateKey: row.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, row.id),
      name: row.name,
      type: "Ride",
      description,
      durationS: description === null ? 3_600 : 3_601,
      updated: "1998-01-01T00:00:00.900+00:00",
    });
    intervals.events.push(
      leftover(sentWithFtp, withFtp(sentWithFtp.structureJson)),
      leftover(sentWithout, null),
    );
    const reconciliation = createPlanReconciliationRepository(store);
    const job = await reconciliation.createOrGetJob({
      id: "1".repeat(26),
      planId: PLAN_ID,
      kind: "cleanup",
      windowStartDateKey: MONDAY + 1,
      windowEndDateKey: MONDAY + 27,
      createdAtMs: NOW,
    });
    expect(
      await cleanupPlanCalendar(job, {
        ...deps,
        reconciliation,
        workouts: async () => [sentWithFtp, sentWithout],
      }),
    ).toEqual({ kind: "verified", removed: 2, kept: 0 });
    expect(intervals.events).toEqual([]);
  });

  it("keeps a copy of a Plan workout that does not hold what the app sent", async () => {
    const { store, mirror, intervals, deps } = await setup();
    await approveFirstWeeks(mirror);
    const first = workout(1, MONDAY + 1);
    const second = workout(2, MONDAY + 2);
    await mirrorPlanCalendar(
      {
        plan: plan(),
        workouts: [first],
        todayDateKey: MONDAY,
        firstEligibleDateKey: MONDAY,
        matchedWorkoutIds: NONE_MATCHED,
      },
      deps,
    );
    const sent = intervals.events[0];
    if (sent === undefined) throw new Error("Expected an event");
    intervals.events.push(
      { ...sent, id: 901, dateKey: MONDAY + 3, name: "Endurance 1, my copy" },
      {
        id: 902,
        dateKey: second.dateKey,
        externalId: planMirrorExternalId(PLAN_ID, second.id),
        name: "Endurance 2, my version",
        type: "Ride",
        updated: "1998-01-01T00:00:00.902+00:00",
      },
    );
    const reconciliation = createPlanReconciliationRepository(store);
    const job = await reconciliation.createOrGetJob({
      id: "1".repeat(26),
      planId: PLAN_ID,
      kind: "cleanup",
      windowStartDateKey: MONDAY + 1,
      windowEndDateKey: MONDAY + 27,
      createdAtMs: NOW,
    });
    expect(
      await cleanupPlanCalendar(job, {
        ...deps,
        reconciliation,
        workouts: async () => [first, second],
      }),
    ).toEqual({ kind: "verified", removed: 1, kept: 0 });
    expect(intervals.events.map((event) => event.id).sort()).toEqual([901, 902]);
  });
});
