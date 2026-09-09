import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { describe, expect, it, vi } from "vitest";
import { createPlanChangeEventSourceReader } from "../src/plan-change-event-source-reader.js";

const event = {
  id: 17,
  name: "Autumn ride",
  start_date_local: "1998-09-12T09:00:00",
  category: "RACE_B",
};

const reader = (planned_workouts: unknown[]) =>
  createPlanChangeEventSourceReader({
    calendarConnected: () => true,
    readLatest: () => ({ planned_workouts }),
  });

describe("Plan Change event sources", () => {
  it("reads only race categories and fingerprints the exact provider fields", async () => {
    const sources = await reader([
      event,
      { ...event, id: 18, category: "RACE_A" },
      { ...event, id: 19, category: "RACE_C" },
      { ...event, category: "WORKOUT" },
      { ...event, category: "RACE" },
      null,
    ]).read();
    expect(sources).toHaveLength(3);
    expect(sources[0]).toEqual({
      providerId: "17",
      name: "Autumn ride",
      date: "1998-09-12",
      category: "RACE_B",
      sourceRevision: createHash("sha256").update(canonicalJson(event)).digest("hex"),
    });
  });

  it("ignores unrelated fields and object key order", async () => {
    const original = await reader([event]).read();
    const reordered = {
      category: event.category,
      start_date_local: event.start_date_local,
      description: "Changed provider description",
      moving_time: 7200,
      name: event.name,
      id: event.id,
    };
    expect(await reader([reordered]).read()).toEqual(original);
  });

  it.each([
    { id: 18 },
    { name: "Renamed ride" },
    { start_date_local: "1998-09-12T10:00:00" },
    { category: "RACE_A" },
  ])("detects a change in a fingerprint field: %j", async (change) => {
    const [before] = await reader([event]).read();
    const [after] = await reader([{ ...event, ...change }]).read();
    expect(after?.sourceRevision).not.toBe(before?.sourceRevision);
  });

  it("does not expose events without a valid name or exact civil date", async () => {
    expect(
      await reader([
        { ...event, name: null },
        { ...event, name: " " },
        { ...event, start_date_local: "1998-02-30T09:00:00" },
        { ...event, start_date_local: "not-a-date" },
      ]).read(),
    ).toEqual([]);
  });

  it("returns no sources when disconnected without reading the reference", async () => {
    const readLatest = vi.fn(() => ({ planned_workouts: [event] }));
    const disconnected = createPlanChangeEventSourceReader({
      calendarConnected: async () => false,
      readLatest,
    });
    expect(await disconnected.read()).toEqual([]);
    expect(readLatest).not.toHaveBeenCalled();
  });

  it("returns no sources when no validated reference exists", async () => {
    expect(
      await createPlanChangeEventSourceReader({
        calendarConnected: () => true,
        readLatest: () => null,
      }).read(),
    ).toEqual([]);
  });

  it("reads current provider values on every call", async () => {
    let current = event;
    const source = createPlanChangeEventSourceReader({
      calendarConnected: () => true,
      readLatest: () => ({ planned_workouts: [current] }),
    });
    const before = await source.read();
    current = { ...event, name: "Updated ride" };
    const after = await source.read();
    expect(after[0]?.name).toBe("Updated ride");
    expect(after[0]?.sourceRevision).not.toBe(before[0]?.sourceRevision);
  });
});
