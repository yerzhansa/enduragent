import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedChange } from "@enduragent/engine";
import type { EventInput } from "intervals-icu-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarClient } from "../src/workout-change-sets/calendar.js";
import {
  openWorkoutChangeSets,
  type WorkoutChangeSets,
} from "../src/workout-change-sets/service.js";

const defect = vi.hoisted(() => {
  const value = process.env.WORKOUT_PROTECTION_DEFECT;
  if (
    value !== undefined &&
    !["duplicate-write", "stale-comparison", "ownership"].includes(value)
  ) {
    throw new Error("Unknown workout protection defect probe.");
  }
  return value;
});

vi.mock(import("../src/workout-change-sets/calendar.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sameSnapshot: defect === "stale-comparison" ? () => true : actual.sameSnapshot,
    write:
      defect === "duplicate-write"
        ? async (...args: Parameters<typeof actual.write>) => {
            await actual.write(...args);
            return actual.write(...args);
          }
        : actual.write,
  };
});

vi.mock(import("../src/io/interprocess-file-lock-sync.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    acquireInterprocessFileLock:
      defect === "ownership"
        ? async () => ({ release: () => undefined })
        : actual.acquireInterprocessFileLock,
  };
});

const roots: string[] = [];
const services: WorkoutChangeSets[] = [];
const addition: PreparedChange = {
  kind: "add",
  sport: "cycling",
  date: "1998-09-08",
  name: "Easy ride",
  durationSeconds: 3000,
  description: "Easy effort",
  effort: "Easy",
  structure: null,
  trainingLoad: null,
};
const existing = {
  id: 101,
  category: "WORKOUT" as const,
  name: "Steady ride",
  startDateLocal: "1998-09-09T00:00:00",
  movingTime: 3600,
  description: "Steady effort",
  tags: ["cycling-coach"],
};

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "workout-protection-"));
  roots.push(dataDir);
  const events = new Map<number, EventInput & { id: number }>([[existing.id, { ...existing }]]);
  const writes: { kind: string; input?: EventInput }[] = [];
  let nextId = 200;
  const client: CalendarClient = {
    athlete: { get: async () => ({ ok: true, value: { id: "fictional-account" } }) },
    events: {
      get: async (id) =>
        events.has(id)
          ? { ok: true, value: events.get(id) }
          : { ok: false, error: { kind: "NotFound", status: 404, body: null } },
      list: async ({ oldest, newest }) => ({
        ok: true,
        value: [...events.values()].filter((event) => {
          const date = (event.startDateLocal ?? "").slice(0, 10);
          return date >= oldest && date <= newest;
        }),
      }),
      create: async (input) => {
        const event = { ...input, id: nextId++ };
        writes.push({ kind: "add", input });
        events.set(event.id, event);
        return { ok: true, value: event };
      },
      update: async (id, input) => {
        const event = { ...events.get(id), ...input, id };
        writes.push({ kind: "edit", input });
        events.set(id, event);
        return { ok: true, value: event };
      },
      delete: async (id) => {
        writes.push({ kind: "delete" });
        events.delete(id);
        return { ok: true, value: undefined };
      },
    },
  };
  const service = await openWorkoutChangeSets({ dataDir, client, timezone: "UTC" });
  services.push(service);
  return { dataDir, client, service, events, writes };
}

async function prepare(service: WorkoutChangeSets, changes: readonly PreparedChange[]) {
  expect(
    await service.preparation.prepare({
      chatId: "fictional-chat",
      turnId: "fictional-turn",
      preparation: { kind: "complete", changes },
    }),
  ).toEqual({ kind: "prepared", changeCount: changes.length });
  await service.preparation.settleTurn({
    chatId: "fictional-chat",
    turnId: "fictional-turn",
    outcome: "commit",
  });
  const review = await service.review({ chatId: "fictional-chat", language: "en" });
  if (review === null || review.handle === null) throw new Error("Complete review missing");
  const control = await service.acknowledgeDelivery({
    chatId: "fictional-chat",
    delivery: review.handle,
  });
  if (control === null) throw new Error("Approval missing");
  return control;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("1998-09-07T12:00:00Z"));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.useRealTimers();
});

describe("workout change-set critical protections", () => {
  it("rejects duplicate calendar effects for concurrent repeated approval", async () => {
    const { service, events, writes } = await fixture();
    const control = await prepare(service, [addition]);
    const request = {
      chatId: "fictional-chat",
      language: "en",
      action: { kind: "approve", token: control.token },
    } satisfies Parameters<WorkoutChangeSets["resolve"]>[0];
    const outcomes = await Promise.all([service.resolve(request), service.resolve(request)]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["completed", "invalid-action"]);
    expect(
      [...events.values()].filter((event) => event.name === "Easy ride"),
      "one reviewed addition must produce one calendar workout",
    ).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.input).toMatchObject({
      category: "WORKOUT",
      type: "Ride",
      startDateLocal: "1998-09-08T00:00:00",
      name: "Easy ride",
      movingTime: 3000,
      description: "Easy effort",
      tags: ["cycling-coach"],
    });
    expect(events.get(existing.id)).toEqual(existing);
  });

  it("rejects all writes when the final reviewed target changed", async () => {
    const { service, events, writes } = await fixture();
    const control = await prepare(service, [
      addition,
      { kind: "edit", eventId: existing.id, patch: { durationSeconds: 4500 } },
    ]);
    const externallyChanged = { ...existing, movingTime: 5400 };
    events.set(existing.id, externallyChanged);
    const result = await service.resolve({
      chatId: "fictional-chat",
      language: "en",
      action: { kind: "approve", token: control.token },
    });
    expect(writes, "a stale final target must prevent even the first addition").toEqual([]);
    expect(result.kind).toBe("refresh-required");
    expect([...events.values()]).toEqual([externallyChanged]);
    const review = await service.review({ chatId: "fictional-chat", language: "en" });
    expect(review?.text).toContain("90 min");
  });

  it("rejects a second writer for the same durable store", async () => {
    const { service, dataDir, client, events, writes } = await fixture();
    const control = await prepare(service, [addition]);
    const secondOwner = await openWorkoutChangeSets({ dataDir, client, timezone: "UTC" }).then(
      (opened) => {
        services.push(opened);
        return "opened";
      },
      () => "refused",
    );
    expect(secondOwner, "a second writer must not obtain ownership of the active store").toBe(
      "refused",
    );
    expect(writes).toEqual([]);
    expect([...events.values()]).toEqual([existing]);
    expect(
      (
        await service.resolve({
          chatId: "fictional-chat",
          language: "en",
          action: { kind: "approve", token: control.token },
        })
      ).kind,
    ).toBe("completed");
    expect(writes).toHaveLength(1);
  });
});
