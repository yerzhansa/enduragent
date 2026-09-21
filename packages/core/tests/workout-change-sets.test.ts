import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventInput, Result } from "intervals-icu-api";
import type { PreparedChange } from "@enduragent/engine";
import {
  openWorkoutChangeSets,
  type WorkoutChangeSets,
} from "../src/workout-change-sets/service.js";
import type { CalendarClient } from "../src/workout-change-sets/calendar.js";
import { deliverWorkoutReview } from "../src/channels/workout-approval.js";

const add: PreparedChange = {
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
const base = {
  id: 101,
  category: "WORKOUT" as const,
  name: "Intervals",
  startDateLocal: "1998-09-09T00:00:00",
  movingTime: 3600,
  description: "Steady",
  icuTrainingLoad: 50,
  workoutDoc: { steps: [1, 2] },
  tags: ["cycling-coach"],
};
const roots: string[] = [];
const services: WorkoutChangeSets[] = [];
function calendar() {
  let account = "fictional-account";
  let nextId = 200;
  const events = new Map<
    number,
    Omit<EventInput, "workoutDoc"> & { id: number; workoutDoc?: unknown }
  >([
    [101, { ...base }],
    [102, { ...base, id: 102, name: "Recovery", movingTime: 1800 }],
    [
      103,
      {
        ...base,
        id: 103,
        name: "Existing ride",
        startDateLocal: "1998-09-08T00:00:00",
        movingTime: 2700,
        tags: [],
      },
    ],
  ]);
  const writes: { kind: string; id: number; input?: EventInput }[] = [];
  let failure: "reject" | "lost" | "absent" | undefined;
  let failAt = 1;
  const mutate = async (kind: string, id: number, input?: EventInput): Promise<Result<unknown>> => {
    writes.push({ kind, id, input });
    const failing = writes.length === failAt;
    if (failing && failure === "reject")
      return { ok: false, error: { kind: "RateLimit", status: 429, retryAfterMs: 0, body: null } };
    if (!(failing && failure === "absent")) {
      if (kind === "delete") events.delete(id);
      else events.set(id, { ...events.get(id), ...input, id });
    }
    if (failing && (failure === "lost" || failure === "absent")) throw new Error("Response lost");
    return { ok: true, value: kind === "delete" ? undefined : events.get(id) };
  };
  const client: CalendarClient = {
    athlete: { get: async () => ({ ok: true, value: { id: account } }) },
    events: {
      get: async (id) =>
        events.has(id)
          ? { ok: true, value: events.get(id) }
          : { ok: false, error: { kind: "NotFound", status: 404, body: null } },
      list: async ({ oldest, newest }) => ({
        ok: true,
        value: [...events.values()].filter(
          (event) =>
            (event.startDateLocal ?? "").slice(0, 10) >= oldest &&
            (event.startDateLocal ?? "").slice(0, 10) <= newest,
        ),
      }),
      create: async (input) => mutate("add", nextId++, input),
      update: async (id, input) => mutate("edit", id, input),
      delete: async (id) => mutate("delete", id),
    },
  };
  return {
    client,
    events,
    writes,
    fail(kind: typeof failure, at = 1) {
      failure = kind;
      failAt = at;
    },
    switchAccount() {
      account = "different-fictional-account";
    },
  };
}
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "workout-batch-"));
  roots.push(dataDir);
  const fake = calendar();
  const service = await openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" });
  services.push(service);
  return { dataDir, fake, service };
}
async function prepare(
  service: WorkoutChangeSets,
  changes: readonly PreparedChange[],
  turnId = "turn-one",
) {
  const pending = await service.preparation.readPending({ chatId: "chat" });
  expect(
    await service.preparation.prepare({
      chatId: "chat",
      turnId,
      preparation:
        pending.kind === "pending"
          ? { kind: "replace", base: pending.reference, changes }
          : { kind: "complete", changes },
    }),
  ).toEqual({ kind: "prepared", changeCount: changes.length });
  await service.preparation.settleTurn({ chatId: "chat", turnId, outcome: "commit" });
  const review = await service.review({ chatId: "chat", language: "en" });
  if (!review || review.handle === null) throw new Error("Missing review");
  const control = await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
  if (!control) throw new Error("Missing approval");
  return { review, control };
}
async function approve(
  service: WorkoutChangeSets,
  token: string,
  kind: "approve" | "retry-remaining" = "approve",
) {
  return service.resolve({ chatId: "chat", language: "en", action: { kind, token } });
}
async function pendingSet(service: WorkoutChangeSets) {
  const pending = await service.preparation.readPending({ chatId: "chat" });
  if (pending.kind !== "pending") throw new Error("Missing pending set");
  return pending;
}
async function acknowledgeAbandoned(service: WorkoutChangeSets) {
  const review = await service.review({ chatId: "chat", language: "en" });
  if (!review || review.handle === null) throw new Error("Missing abandoned notice");
  expect(review.text).toContain("complete proposal");
  expect(await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle })).toBeNull();
  expect((await approve(service, review.handle)).kind).toBe("invalid-action");
  return review;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("1998-09-07T12:00:00Z"));
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.useRealTimers();
});

describe("durable workout change sets", () => {
  it("revises Thursday while preserving the other seven complete pending workouts", async () => {
    const { service, fake } = await setup();
    const changes = Array.from({ length: 8 }, (_, index) => ({
      ...add,
      date: `1998-09-${String(index + 7).padStart(2, "0")}`,
      name: `Recovery ${index + 1}`,
      durationSeconds: 600,
      description: "Main set\n- 10m 50%",
      effort: "50% FTP",
      trainingLoad: 8,
    }));
    const original = await prepare(service, changes);
    const before = await service.preparation.readPending({ chatId: "chat" });
    if (before.kind !== "pending") throw new Error("Missing pending set");
    const thursday = before.changes[3];
    if (!thursday || thursday.change.kind !== "add") throw new Error("Missing Thursday");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "revise-thursday",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [
            {
              id: thursday.id,
              change: {
                ...thursday.change,
                durationSeconds: 300,
                description: "Main set\n- 5m 45%",
                effort: "45% FTP",
              },
            },
          ],
        },
      }),
    ).toEqual({ kind: "prepared", changeCount: 8 });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "revise-thursday",
      outcome: "commit",
    });
    const after = await service.preparation.readPending({ chatId: "chat" });
    if (after.kind !== "pending") throw new Error("Missing revised set");
    expect(after.changes.filter((_, index) => index !== 3)).toEqual(
      before.changes.filter((_, index) => index !== 3),
    );
    expect(after.changes[3]).toMatchObject({
      id: thursday.id,
      change: { durationSeconds: 300, trainingLoad: 8 },
    });
    expect((await approve(service, original.control.token)).kind).toBe("invalid-action");
    const review = await service.review({ chatId: "chat", language: "en" });
    if (!review?.handle) throw new Error("Missing revision review");
    expect(review.text).toContain("Changes to this proposal:");
    expect(review.text).toContain("duration: 10 min → 5 min");
    expect(review.text).toContain("effort: 50% FTP → 45% FTP");
    expect(review.text).toContain("All other proposed workouts stay unchanged.");
    const control = await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
    if (!control) throw new Error("Missing revision approval");
    expect(fake.writes).toEqual([]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes).toHaveLength(8);
    expect(fake.writes.map((write) => write.input?.icuTrainingLoad)).toEqual(Array(8).fill(8));
    expect(fake.writes.map((write) => write.input?.movingTime)).toEqual([
      600, 600, 600, 300, 600, 600, 600, 600,
    ]);
    expect(fake.writes.map((write) => write.input?.externalId)).toEqual(
      before.changes.map((change) => `cycling-coach:batch:${change.id}`),
    );
  });
  it("refuses implicit whole-set replacement without invalidating the pending approval", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add]);
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "implicit-replacement",
        preparation: { kind: "complete", changes: [{ ...add, trainingLoad: 4 }] },
      }),
    ).toMatchObject({ kind: "refused" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "implicit-replacement",
      outcome: "abandon",
    });
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes[0]?.input?.icuTrainingLoad).toBeUndefined();
  });
  it.each(["awaiting approval", "partial retry"] as const)(
    "preserves %s and its original control across an incomplete revision and restart",
    async (mode) => {
      const { service, fake, dataDir } = await setup();
      const initial = await prepare(service, [add, { ...add, name: "Second ride" }]);
      let control = initial.control;
      if (mode === "partial retry") {
        fake.fail("reject", 2);
        expect((await approve(service, control.token)).kind).toBe("partial");
        const review = await service.review({ chatId: "chat", language: "en" });
        if (!review?.handle) throw new Error("Missing retry review");
        const retry = await service.acknowledgeDelivery({
          chatId: "chat",
          delivery: review.handle,
        });
        if (!retry) throw new Error("Missing retry control");
        control = retry;
      }
      const before = await pendingSet(service);
      const writesBefore = [...fake.writes];
      expect(
        await service.preparation.prepare({
          chatId: "chat",
          turnId: "incomplete-revision",
          preparation: { kind: "incomplete", reason: "The requested revision cannot be prepared." },
        }),
      ).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("previous proposal is unchanged"),
      });
      await service.preparation.settleTurn({
        chatId: "chat",
        turnId: "incomplete-revision",
        outcome: "abandon",
      });
      expect(await pendingSet(service)).toEqual(before);
      expect(fake.writes).toEqual(writesBefore);
      await service.close();
      const restarted = await openWorkoutChangeSets({
        dataDir,
        client: fake.client,
        timezone: "UTC",
      });
      services.push(restarted);
      expect(await pendingSet(restarted)).toEqual(before);
      expect(fake.writes).toEqual(writesBefore);
      expect(
        (
          await approve(
            restarted,
            control.token,
            mode === "partial retry" ? "retry-remaining" : "approve",
          )
        ).kind,
      ).toBe("completed");
      expect(fake.writes.map((write) => write.input?.name)).toEqual(
        mode === "partial retry"
          ? ["Easy ride", "Second ride", "Second ride"]
          : ["Easy ride", "Second ride"],
      );
    },
  );
  it("invalidates a read reference after refreshed calendar contents and preserves that newer review", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [
      { kind: "edit", eventId: 101, patch: { name: "New name" } },
    ]);
    const before = await pendingSet(service);
    fake.events.set(101, { ...base, movingTime: 5400 });
    expect((await approve(service, control.token)).kind).toBe("refresh-required");
    const refreshed = await pendingSet(service);
    expect(refreshed.reference.revision).toBeGreaterThan(before.reference.revision);
    expect(refreshed.changes[0]).toMatchObject({ desired: { durationSeconds: 5400 } });
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "stale-replacement",
        preparation: {
          kind: "replace",
          base: before.reference,
          changes: [add],
        },
      }),
    ).toMatchObject({ kind: "refused" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "stale-replacement",
      outcome: "abandon",
    });
    expect(await pendingSet(service)).toEqual(refreshed);
    expect(fake.writes).toEqual([]);
  });
  it("keeps completed receipts when the athlete explicitly replaces all remaining work", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add, { ...add, name: "Second ride" }]);
    fake.fail("reject", 2);
    expect((await approve(service, control.token)).kind).toBe("partial");
    const next = await prepare(
      service,
      [{ kind: "edit", eventId: 101, patch: { name: "Replacement" } }],
      "replace-remaining",
    );
    const pending = await pendingSet(service);
    expect(pending.completedCount).toBe(1);
    expect(pending.changes).toHaveLength(1);
    expect(next.review.text).toContain("Already completed");
    expect((await approve(service, next.control.token)).kind).toBe("completed");
    expect(fake.writes.map((write) => write.kind)).toEqual(["add", "add", "edit"]);
  });
  it("refuses a selected edit that changes patch representation but leaves the proposed workout unchanged", async () => {
    const { service } = await setup();
    const { control } = await prepare(service, [
      { kind: "edit", eventId: 101, patch: { name: "New name" } },
    ]);
    const before = await pendingSet(service);
    const selected = before.changes[0];
    if (!selected) throw new Error("Missing edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "equivalent-patch",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [
            {
              id: selected.id,
              change: {
                kind: "edit",
                eventId: 101,
                patch: { name: "New name", durationSeconds: 3600 },
              },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "refused" });
    expect(await pendingSet(service)).toEqual(before);
    expect((await approve(service, control.token)).kind).toBe("completed");
  });
  it.each([
    { patch: { name: "Revised name" }, load: 75 },
    { patch: { name: "Revised name", trainingLoad: 0 }, load: 0 },
    { patch: { name: "Revised name", trainingLoad: undefined }, load: 75 },
  ])("merges selected edit fields with the pending patch: %j", async ({ patch, load }) => {
    const { service, fake } = await setup();
    const initial = await prepare(service, [
      add,
      {
        kind: "edit",
        eventId: 101,
        patch: { name: "Planned name", trainingLoad: 75, durationSeconds: 4500 },
      },
    ]);
    const before = await pendingSet(service);
    const selected = before.changes[1];
    if (!selected) throw new Error("Missing edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "revise-name",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [{ id: selected.id, change: { kind: "edit", eventId: 101, patch } }],
        },
      }),
    ).toMatchObject({ kind: "prepared", changeCount: 2 });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "revise-name",
      outcome: "commit",
    });
    const after = await pendingSet(service);
    expect(after.changes[0]).toEqual(before.changes[0]);
    expect(after.changes[1]).toMatchObject({
      id: selected.id,
      change: {
        kind: "edit",
        eventId: 101,
        patch: { name: "Revised name", trainingLoad: load, durationSeconds: 4500 },
      },
      desired: { name: "Revised name", trainingLoad: load, durationSeconds: 4500 },
    });
    expect((await approve(service, initial.control.token)).kind).toBe("invalid-action");
    const review = await service.review({ chatId: "chat", language: "en" });
    if (!review?.handle) throw new Error("Missing revision review");
    if (load === 75) expect(review.text).not.toContain("training load: 75 →");
    else expect(review.text).toContain("training load: 75 → 0");
    const control = await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
    if (!control) throw new Error("Missing revision approval");
    expect(fake.writes).toEqual([]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes[1]).toEqual({
      kind: "edit",
      id: 101,
      input: { name: "Revised name", movingTime: 4500, icuTrainingLoad: load },
    });
  });
  it("rejects omission-only edit revisions as no-ops without losing previous pending fields", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [
      { kind: "edit", eventId: 101, patch: { name: "Planned name", trainingLoad: 75 } },
    ]);
    const before = await pendingSet(service);
    const selected = before.changes[0];
    if (!selected) throw new Error("Missing edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "omit-load",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [
            {
              id: selected.id,
              change: { kind: "edit", eventId: 101, patch: { name: "Planned name" } },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "refused", message: expect.stringContaining("actual change") });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "omit-load",
      outcome: "abandon",
    });
    expect(await pendingSet(service)).toEqual(before);
    expect(fake.writes).toEqual([]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes[0]?.input?.icuTrainingLoad).toBe(75);
  });
  it("restores canonical revision values and IDs after restart without conversation history", async () => {
    const { service, fake, dataDir } = await setup();
    await prepare(service, [
      add,
      { kind: "edit", eventId: 101, patch: { name: "Thursday recovery" } },
      { kind: "delete", eventId: 102 },
    ]);
    const before = await pendingSet(service);
    expect(before.changes[1]).toMatchObject({
      reviewed: { date: "1998-09-09", name: "Intervals" },
      desired: { name: "Thursday recovery" },
    });
    expect(before.changes[2]).toMatchObject({ reviewed: { name: "Recovery", date: "1998-09-09" } });
    expect(JSON.stringify(before)).not.toMatch(/token|recoveryIdentity|fictional-account/);
    await service.close();
    const restarted = await openWorkoutChangeSets({
      dataDir,
      client: fake.client,
      timezone: "UTC",
    });
    services.push(restarted);
    expect(await pendingSet(restarted)).toEqual(before);
    const selected = before.changes[0];
    if (!selected || selected.change.kind !== "add") throw new Error("Missing addition");
    expect(
      await restarted.preparation.prepare({
        chatId: "chat",
        turnId: "after-restart",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [
            { id: selected.id, change: { ...selected.change, name: "Short recovery" } },
          ],
        },
      }),
    ).toMatchObject({ kind: "prepared", changeCount: 3 });
    await restarted.preparation.settleTurn({
      chatId: "chat",
      turnId: "after-restart",
      outcome: "commit",
    });
    expect((await pendingSet(restarted)).changes.slice(1)).toEqual(before.changes.slice(1));
  });
  it("preserves review-only structure through restart and revision without writing it to the calendar", async () => {
    const { service, fake, dataDir } = await setup();
    const reviewStructure = {
      name: "Easy ride",
      steps: [
        {
          type: "steady",
          duration: { value: 50, unit: "minutes" },
          power: { kind: "percent_ftp", value: 55 },
        },
      ],
    } as const;
    const chartAdd: PreparedChange = { ...add, reviewStructure };
    const initial = await prepare(service, [chartAdd, { ...add, name: "Second ride" }]);
    expect(initial.review.presentation.kind).toBe("cards");
    if (initial.review.presentation.kind !== "cards") throw new Error("Missing card review");
    expect(initial.review.presentation.document.cards[0]).toMatchObject({
      kind: "plot",
      chart: { durationSeconds: 3000 },
    });
    await service.close();
    const restarted = await openWorkoutChangeSets({
      dataDir,
      client: fake.client,
      timezone: "UTC",
    });
    services.push(restarted);
    const before = await pendingSet(restarted);
    expect(before.changes[0]).toMatchObject({ change: { reviewStructure } });
    const second = before.changes[1];
    if (!second || second.change.kind !== "add") throw new Error("Missing second addition");
    expect(
      await restarted.preparation.prepare({
        chatId: "chat",
        turnId: "revise-second",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [
            { id: second.id, change: { ...second.change, name: "Revised second ride" } },
          ],
        },
      }),
    ).toMatchObject({ kind: "prepared", changeCount: 2 });
    await restarted.preparation.settleTurn({
      chatId: "chat",
      turnId: "revise-second",
      outcome: "commit",
    });
    expect((await pendingSet(restarted)).changes[0]).toEqual(before.changes[0]);
    const review = await restarted.review({ chatId: "chat", language: "en" });
    if (!review?.handle) throw new Error("Missing revised review");
    const control = await restarted.acknowledgeDelivery({
      chatId: "chat",
      delivery: review.handle,
    });
    if (!control) throw new Error("Missing revised control");
    expect((await approve(restarted, control.token)).kind).toBe("completed");
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes.every((write) => write.input?.workoutDoc === undefined)).toBe(true);
  });

  it("replaces a stale authored patch with trusted edit metadata and persists the native write", async () => {
    const { service, fake, dataDir } = await setup();
    const reviewStructure = {
      steps: [
        {
          type: "steady",
          duration: { value: 15, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      ],
    } as const;
    await prepare(service, [{ kind: "edit", eventId: 101, patch: { structure: reviewStructure } }]);
    const stale = await pendingSet(service);
    const selected = stale.changes[0];
    if (!selected || selected.change.kind !== "edit") throw new Error("Missing edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "normalize-authored-edit",
        preparation: {
          kind: "revise",
          base: stale.reference,
          replacements: [
            {
              id: selected.id,
              change: {
                kind: "edit",
                eventId: 101,
                patch: {
                  durationSeconds: 900,
                  description: "Main set\n- 15m 50%",
                },
                reviewStructure,
              },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "prepared" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "normalize-authored-edit",
      outcome: "commit",
    });
    const normalized = await pendingSet(service);
    const normalizedEdit = normalized.changes[0];
    expect(normalizedEdit).toMatchObject({
      id: selected.id,
      change: {
        kind: "edit",
        patch: { durationSeconds: 900, description: "Main set\n- 15m 50%" },
        reviewStructure,
      },
      desired: {
        durationSeconds: 900,
        description: "Main set\n- 15m 50%",
        structure: null,
      },
    });
    if (!normalizedEdit || normalizedEdit.change.kind !== "edit")
      throw new Error("Missing normalized edit");
    expect(normalizedEdit.change.patch).not.toHaveProperty("structure");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "rename-authored-edit",
        preparation: {
          kind: "revise",
          base: normalized.reference,
          replacements: [
            {
              id: normalizedEdit.id,
              change: { kind: "edit", eventId: 101, patch: { name: "Synthetic recovery" } },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "prepared" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "rename-authored-edit",
      outcome: "commit",
    });
    const beforeRestart = await pendingSet(service);
    expect(beforeRestart.changes[0]).toMatchObject({
      change: {
        patch: {
          name: "Synthetic recovery",
          durationSeconds: 900,
          description: "Main set\n- 15m 50%",
        },
        reviewStructure,
      },
    });
    await service.close();
    const restarted = await openWorkoutChangeSets({
      dataDir,
      client: fake.client,
      timezone: "UTC",
    });
    services.push(restarted);
    expect(await pendingSet(restarted)).toEqual(beforeRestart);
    const review = await restarted.review({ chatId: "chat", language: "en" });
    if (!review?.handle || review.presentation.kind !== "cards")
      throw new Error("Missing authored edit review");
    expect(review.presentation.document.cards[0]).toMatchObject({
      kind: "plot",
      chart: {
        durationSeconds: 900,
        segments: [{ kind: "steady", durationSeconds: 900, target: 50 }],
      },
    });
    const control = await restarted.acknowledgeDelivery({
      chatId: "chat",
      delivery: review.handle,
    });
    if (!control) throw new Error("Missing authored edit approval");
    expect((await approve(restarted, control.token)).kind).toBe("completed");
    expect(fake.writes).toEqual([
      {
        kind: "edit",
        id: 101,
        input: {
          name: "Synthetic recovery",
          movingTime: 900,
          description: "Main set\n- 15m 50%",
        },
      },
    ]);
  });

  it("preserves authored review metadata when a rename repeats unchanged workout content", async () => {
    const { service } = await setup();
    const description = "Main set\n- 15m 50%";
    const reviewStructure = {
      steps: [
        {
          type: "steady",
          duration: { value: 15, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      ],
    };
    await prepare(service, [
      {
        kind: "edit",
        eventId: 101,
        patch: { durationSeconds: 900, description },
        reviewStructure,
      },
    ]);
    const before = await pendingSet(service);
    const selected = before.changes[0];
    if (!selected || selected.change.kind !== "edit") throw new Error("Missing edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "rename-with-repeated-content",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [
            {
              id: selected.id,
              change: {
                kind: "edit",
                eventId: 101,
                patch: {
                  name: "Synthetic renamed ride",
                  durationSeconds: 900,
                  description,
                },
              },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "prepared" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "rename-with-repeated-content",
      outcome: "commit",
    });
    const after = await pendingSet(service);
    expect(after.changes[0]).toMatchObject({
      change: { patch: { name: "Synthetic renamed ride" }, reviewStructure },
      desired: { name: "Synthetic renamed ride", durationSeconds: 900, description },
    });
    const review = await service.review({ chatId: "chat", language: "en" });
    expect(review?.presentation).toMatchObject({
      kind: "cards",
      document: { cards: [{ kind: "plot" }] },
    });
  });

  it.each([
    ["description", { description: "Manual instructions" }],
    ["duration", { durationSeconds: 1200 }],
    [
      "platform structure",
      { structure: { steps: [{ duration: 900, power: { units: "%ftp", value: 45 } }] } },
    ],
  ] as const)("clears authored review metadata after a %s revision", async (_label, patch) => {
    const { service } = await setup();
    const reviewStructure = {
      steps: [
        {
          type: "steady",
          duration: { value: 15, unit: "minutes" },
          power: { kind: "percent_ftp", value: 50 },
        },
      ],
    } as const;
    await prepare(service, [
      {
        kind: "edit",
        eventId: 101,
        patch: { durationSeconds: 900, description: "Main set\n- 15m 50%" },
        reviewStructure,
      },
    ]);
    const beforeMetadata = await pendingSet(service);
    const selected = beforeMetadata.changes[0];
    if (!selected || selected.change.kind !== "edit") throw new Error("Missing edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "metadata-only-edit",
        preparation: {
          kind: "revise",
          base: beforeMetadata.reference,
          replacements: [
            {
              id: selected.id,
              change: {
                kind: "edit",
                eventId: 101,
                patch: { name: "Synthetic metadata", date: "1998-09-10", trainingLoad: 45 },
              },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "prepared" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "metadata-only-edit",
      outcome: "commit",
    });
    const afterMetadata = await pendingSet(service);
    expect(afterMetadata.changes[0]).toMatchObject({ change: { reviewStructure } });
    const revised = afterMetadata.changes[0];
    if (!revised || revised.change.kind !== "edit") throw new Error("Missing revised edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "content-edit",
        preparation: {
          kind: "revise",
          base: afterMetadata.reference,
          replacements: [
            {
              id: revised.id,
              change: { kind: "edit", eventId: 101, patch },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "prepared" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "content-edit",
      outcome: "commit",
    });
    const afterContent = await pendingSet(service);
    expect(afterContent.changes[0]?.change).not.toHaveProperty("reviewStructure");
  });
  it.each([
    "stale",
    "wrong-set",
    "unknown",
    "duplicate",
    "action",
    "sport",
    "unchanged",
    "invalid",
  ] as const)("preserves current approval when a targeted revision is %s", async (scenario) => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add]);
    const before = await pendingSet(service);
    const selected = before.changes[0];
    if (!selected || selected.change.kind !== "add") throw new Error("Missing addition");
    const replacement = {
      id: scenario === "unknown" ? "unknown-item" : selected.id,
      change: {
        ...selected.change,
        name: scenario === "unchanged" ? selected.change.name : "New name",
      },
    };
    const replacements =
      scenario === "duplicate"
        ? [replacement, replacement]
        : scenario === "action"
          ? [{ id: selected.id, change: { kind: "delete" as const, eventId: 101 } }]
          : scenario === "sport"
            ? [{ ...replacement, change: { ...replacement.change, sport: "strength" as const } }]
            : scenario === "invalid"
              ? [{ ...replacement, change: { ...replacement.change, durationSeconds: -1 } }]
              : [replacement];
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "rejected-revision",
        preparation: {
          kind: "revise",
          base: {
            setId: scenario === "wrong-set" ? "wrong-set" : before.reference.setId,
            revision:
              scenario === "stale" ? before.reference.revision + 1 : before.reference.revision,
          },
          replacements,
        },
      }),
    ).toMatchObject({ kind: "refused" });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "rejected-revision",
      outcome: "abandon",
    });
    expect(await pendingSet(service)).toEqual(before);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes[0]?.input?.name).toBe(add.name);
  });
  it("requires explicit replacement to change a pending calendar target and checks duplicates across retained entries", async () => {
    const { service } = await setup();
    await prepare(service, [
      { kind: "edit", eventId: 101, patch: { name: "New name" } },
      { kind: "delete", eventId: 102 },
    ]);
    const before = await pendingSet(service);
    const selected = before.changes[0];
    if (!selected) throw new Error("Missing edit");
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "change-target",
        preparation: {
          kind: "revise",
          base: before.reference,
          replacements: [
            {
              id: selected.id,
              change: { kind: "edit", eventId: 102, patch: { name: "Another target" } },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: "refused" });
    expect(await pendingSet(service)).toEqual(before);
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "duplicate-target",
        preparation: {
          kind: "replace",
          base: before.reference,
          changes: [
            { kind: "edit", eventId: 102, patch: { name: "Another target" } },
            { kind: "delete", eventId: 102 },
          ],
        },
      }),
    ).toMatchObject({ kind: "refused" });
    expect(await pendingSet(service)).toEqual(before);
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "explicit-new-target",
        preparation: {
          kind: "replace",
          base: before.reference,
          changes: [{ kind: "edit", eventId: 102, patch: { name: "Another target" } }],
        },
      }),
    ).toMatchObject({ kind: "prepared", changeCount: 1 });
  });
  it("revises only remaining work after partial approval and rejects the completed ID and old reference", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add, { ...add, name: "Second ride" }]);
    const before = await pendingSet(service);
    fake.fail("reject", 2);
    expect((await approve(service, control.token)).kind).toBe("partial");
    const remaining = await pendingSet(service);
    expect(remaining.completedCount).toBe(1);
    expect(remaining.reference.revision).toBeGreaterThan(before.reference.revision);
    expect(remaining.changes).toEqual(before.changes.slice(1));
    const completed = before.changes[0];
    const selected = remaining.changes[0];
    if (!completed || !selected || selected.change.kind !== "add")
      throw new Error("Missing additions");
    const change = { ...selected.change, name: "Revised remaining ride" };
    for (const [turnId, base, id] of [
      ["old-reference", before.reference, selected.id],
      ["completed-target", remaining.reference, completed.id],
    ] as const) {
      expect(
        await service.preparation.prepare({
          chatId: "chat",
          turnId,
          preparation: { kind: "revise", base, replacements: [{ id, change }] },
        }),
      ).toMatchObject({ kind: "refused" });
      await service.preparation.settleTurn({ chatId: "chat", turnId, outcome: "abandon" });
    }
    expect(await pendingSet(service)).toEqual(remaining);
    expect(
      await service.preparation.prepare({
        chatId: "chat",
        turnId: "revise-remaining",
        preparation: {
          kind: "revise",
          base: remaining.reference,
          replacements: [{ id: selected.id, change }],
        },
      }),
    ).toMatchObject({ kind: "prepared", changeCount: 1 });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "revise-remaining",
      outcome: "commit",
    });
    const review = await service.review({ chatId: "chat", language: "en" });
    if (!review?.handle) throw new Error("Missing review");
    expect(review.text).toContain("Already completed");
    const next = await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
    if (!next) throw new Error("Missing control");
    expect((await approve(service, next.token)).kind).toBe("completed");
    expect(fake.writes.map((write) => write.input?.name)).toEqual([
      "Easy ride",
      "Second ride",
      "Revised remaining ride",
    ]);
    expect(fake.writes[2]?.input?.externalId).toBe(fake.writes[1]?.input?.externalId);
  });
  it("reviews the complete mixed set and applies exact commands once", async () => {
    const { service, fake } = await setup();
    const changes: PreparedChange[] = [
      add,
      { ...add, sport: "strength", name: "Strength", durationSeconds: 1800 },
      { kind: "edit", eventId: 101, patch: { durationSeconds: 4500 } },
      { kind: "delete", eventId: 102 },
    ];
    const { control, review } = await prepare(service, changes);
    expect(review.text).toContain("155 min");
    expect(review.text).toContain("Existing ride · 45 min");
    expect(review.text).toContain("Current:");
    expect(review.text).toContain("75 min");
    expect(review.text).toContain("Remove this workout");
    expect(fake.writes).toEqual([]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes.map((write) => write.kind)).toEqual(["add", "add", "edit", "delete"]);
    expect(fake.writes[0]?.input).toMatchObject({
      name: "Easy ride",
      movingTime: 3000,
      description: "Easy effort",
      category: "WORKOUT",
      type: "Ride",
    });
    expect(fake.events.get(101)?.movingTime).toBe(4500);
    expect(fake.events.has(102)).toBe(false);
    expect(fake.events.get(103)?.movingTime).toBe(2700);
    expect((await approve(service, control.token)).kind).toBe("invalid-action");
    expect(fake.writes).toHaveLength(4);
  });
  it("keeps staged, abandoned, and multiply submitted turns non-actionable", async () => {
    const { service, fake } = await setup();
    const request = {
      chatId: "chat",
      turnId: "turn",
      preparation: { kind: "complete" as const, changes: [add] },
    };
    await service.preparation.prepare(request);
    expect(await service.review({ chatId: "chat", language: "en" })).toBeNull();
    expect((await service.preparation.prepare(request)).kind).toBe("incomplete");
    await service.preparation.settleTurn({ chatId: "chat", turnId: "turn", outcome: "commit" });
    await acknowledgeAbandoned(service);
    expect((await service.preparation.prepare(request)).kind).toBe("refused");
    await service.preparation.prepare({ ...request, turnId: "other" });
    await service.preparation.settleTurn({ chatId: "chat", turnId: "other", outcome: "abandon" });
    await acknowledgeAbandoned(service);
    expect(fake.writes).toEqual([]);
  });
  it("requires delivery acknowledgement and preserves approval across unrelated turns", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add]);
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "unrelated",
      outcome: "commit",
    });
    expect(await service.review({ chatId: "chat", language: "en" })).toBeNull();
    expect(await service.acknowledgeDelivery({ chatId: "chat", delivery: "wrong" })).toBeNull();
    expect(
      (
        await service.resolve({
          chatId: "other",
          language: "en",
          action: { kind: "approve", token: control.token },
        })
      ).kind,
    ).toBe("invalid-action");
    expect(fake.writes).toEqual([]);
    expect((await approve(service, control.token)).kind).toBe("completed");
  });
  it("keeps an abandoned notice pending after failed delivery and delivers it only once", async () => {
    const { service, fake } = await setup();
    await service.preparation.prepare({
      chatId: "chat",
      turnId: "unfinished",
      preparation: { kind: "incomplete", reason: "The final workout could not be prepared." },
    });
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "unfinished",
      outcome: "abandon",
    });
    const pending = await service.review({ chatId: "chat", language: "en" });
    expect(await service.acknowledgeDelivery({ chatId: "chat", delivery: "wrong" })).toBeNull();
    expect(await service.review({ chatId: "chat", language: "en" })).toEqual(pending);
    const controls = vi.fn();
    const deliver = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Delivery failed"))
      .mockResolvedValue(undefined);
    const send = () =>
      deliverWorkoutReview({
        approvals: service,
        chatId: "chat",
        language: "en",
        deliver,
        controls,
      });
    await expect(send()).rejects.toThrow("Delivery failed");
    expect(await service.review({ chatId: "chat", language: "en" })).toEqual(pending);
    await send();
    await service.preparation.settleTurn({
      chatId: "chat",
      turnId: "unrelated",
      outcome: "commit",
    });
    await send();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await service.review({ chatId: "chat", language: "en" })).toBeNull();
    expect(controls).not.toHaveBeenCalled();
    expect(fake.writes).toEqual([]);
  });
  it("claims concurrent duplicate approval only once", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add]);
    const outcomes = await Promise.all([
      approve(service, control.token),
      approve(service, control.token),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["completed", "invalid-action"]);
    expect(fake.writes).toHaveLength(1);
  });
  it("cancels and replaces approval without writes", async () => {
    const { service, fake } = await setup();
    const first = await prepare(service, [add]);
    const second = await prepare(service, [{ ...add, name: "Easier" }], "revision");
    expect(await approve(service, first.control.token)).toEqual({
      kind: "invalid-action",
      text: "The previous approval is no longer active. Review the current proposal.",
    });
    expect(
      (
        await service.resolve({
          chatId: "chat",
          language: "en",
          action: { kind: "cancel", token: second.control.token },
        })
      ).kind,
    ).toBe("canceled");
    expect((await approve(service, second.control.token)).kind).toBe("invalid-action");
    expect(fake.writes).toEqual([]);
  });
  it.each(["missing", "canceled", "completed"] as const)(
    "does not direct an invalid approval to a current proposal when it is %s",
    async (state) => {
      const { service, fake } = await setup();
      let token = "unmatched-approval";
      if (state !== "missing") {
        const { control } = await prepare(service, [add]);
        token = control.token;
        if (state === "completed") expect((await approve(service, token)).kind).toBe("completed");
        else
          await service.resolve({
            chatId: "chat",
            language: "en",
            action: { kind: "cancel", token },
          });
      }
      const writes = [...fake.writes];
      expect(await approve(service, token)).toEqual({
        kind: "invalid-action",
        text: "This approval is no longer active.",
      });
      expect(fake.writes).toEqual(writes);
    },
  );
  it("localizes an obsolete approval while a retry review is available without writing", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add]);
    fake.fail("reject");
    expect((await approve(service, control.token)).kind).toBe("partial");
    const writes = [...fake.writes];
    expect(
      await service.resolve({
        chatId: "chat",
        language: "es",
        action: { kind: "approve", token: control.token },
      }),
    ).toEqual({
      kind: "invalid-action",
      text: "La aprobación anterior ya no está activa. Revisa la propuesta actual.",
    });
    expect(fake.writes).toEqual(writes);
  });
  it.each([
    { movingTime: 5400 },
    { name: "Changed name" },
    { description: "Changed description" },
    { startDateLocal: "1998-09-10T00:00:00" },
    { icuTrainingLoad: 85 },
    { workoutDoc: { steps: [2, 1] } },
  ])("checks every reviewed field before even the first addition: %j", async (patch) => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [
      add,
      { kind: "edit", eventId: 101, patch: { durationSeconds: 4500 } },
    ]);
    fake.events.set(101, { ...base, ...patch });
    const result = await approve(service, control.token);
    expect(result.kind).toBe("refresh-required");
    expect(result.text).toContain("changed in intervals.icu");
    expect(result.text).toContain("No changes were applied");
    expect(fake.writes).toEqual([]);
    expect(await approve(service, control.token)).toEqual({
      kind: "invalid-action",
      text: "The previous approval is no longer active. Review the current proposal.",
    });
    const review = await service.review({ chatId: "chat", language: "en" });
    if (!review || review.handle === null) throw new Error("Missing refreshed review");
    const refreshed = await service.acknowledgeDelivery({
      chatId: "chat",
      delivery: review.handle,
    });
    if (!refreshed) throw new Error("Missing refreshed control");
    expect((await approve(service, refreshed.token)).kind).toBe("completed");
    expect(fake.events.get(101)?.movingTime).toBe(4500);
  });
  it.each([{ tags: [] }, { category: "NOTE" as const }, { startDateLocal: "1998-09-06T00:00:00" }])(
    "enforces guards across the full set: %j",
    async (patch) => {
      const { service, fake } = await setup();
      const { control } = await prepare(service, [add, { kind: "delete", eventId: 101 }]);
      fake.events.set(101, { ...base, ...patch });
      expect((await approve(service, control.token)).kind).toBe("blocked");
      expect(fake.writes).toEqual([]);
    },
  );
  it("normalizes object key order and line endings, ignores unrelated metadata", async () => {
    const { service, fake } = await setup();
    fake.events.set(101, { ...base, description: "A\r\nB", workoutDoc: { a: 1, b: 2 } });
    const { control } = await prepare(service, [{ kind: "delete", eventId: 101 }]);
    fake.events.set(101, {
      ...base,
      description: "A\nB",
      workoutDoc: { b: 2, a: 1 },
      color: "red",
    });
    expect((await approve(service, control.token)).kind).toBe("completed");
  });
  it("does not preview obsolete workout steps after a description-only edit", async () => {
    const { service, fake } = await setup();
    const reviewedStructure = {
      steps: [{ duration: 600, power: { units: "%ftp", value: 51 } }],
    };
    const description = "Warmup\n- 5m 45%\n\nMain set\n- 3x 2m 100% 2m 50%";
    fake.events.set(101, {
      ...base,
      description: "Old instructions",
      workoutDoc: reviewedStructure,
    });
    const { review } = await prepare(service, [
      { kind: "edit", eventId: 101, patch: { description } },
    ]);
    const pending = await pendingSet(service);
    expect(pending.changes[0]).toMatchObject({
      reviewed: { description: "Old instructions", structure: reviewedStructure },
      desired: { description, structure: null },
    });
    expect(review.text).toContain(description);
    expect(review.text.match(/10 min · 51% FTP/g)).toHaveLength(1);
    expect(fake.events.get(101)?.workoutDoc).toEqual(reviewedStructure);
  });
  it("retains reviewed workout steps for a line-ending-only description patch", async () => {
    const { service, fake } = await setup();
    const reviewedStructure = {
      steps: [{ duration: 600, power: { units: "%ftp", value: 51 } }],
    };
    fake.events.set(101, {
      ...base,
      description: "Same\r\ninstructions",
      workoutDoc: reviewedStructure,
    });
    await prepare(service, [
      { kind: "edit", eventId: 101, patch: { description: "Same\ninstructions" } },
    ]);
    const pending = await pendingSet(service);
    expect(pending.changes[0]).toMatchObject({
      reviewed: { description: "Same\ninstructions", structure: reviewedStructure },
      desired: { description: "Same\ninstructions", structure: reviewedStructure },
    });
  });
  it("uses explicit workout steps when an edit changes both description and structure", async () => {
    const { service, fake } = await setup();
    const reviewedStructure = {
      steps: [{ duration: 600, power: { units: "%ftp", value: 51 } }],
    };
    const desiredStructure = {
      steps: [{ duration: 300, power: { units: "%ftp", value: 45 } }],
    };
    fake.events.set(101, {
      ...base,
      description: "Old instructions",
      workoutDoc: reviewedStructure,
    });
    await prepare(service, [
      {
        kind: "edit",
        eventId: 101,
        patch: { description: "New instructions", structure: desiredStructure },
      },
    ]);
    const pending = await pendingSet(service);
    expect(pending.changes[0]).toMatchObject({
      reviewed: { description: "Old instructions", structure: reviewedStructure },
      desired: { description: "New instructions", structure: desiredStructure },
    });
    expect(fake.events.get(101)?.workoutDoc).toEqual(reviewedStructure);
  });
  it("allows no TTL and has no fixed workout count cap", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(
      service,
      Array.from({ length: 80 }, (_, index) => ({ ...add, name: `Ride ${index}` })),
    );
    vi.setSystemTime(new Date("1998-09-08T23:00:00Z"));
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes).toHaveLength(80);
  });

  it("applies eight workouts spanning ten days with one approval", async () => {
    const { service, fake } = await setup();
    const dates = [
      "1998-09-07",
      "1998-09-08",
      "1998-09-09",
      "1998-09-10",
      "1998-09-12",
      "1998-09-13",
      "1998-09-15",
      "1998-09-16",
    ];
    const { control, review } = await prepare(
      service,
      dates.map((date) => ({ ...add, date })),
    );
    for (const date of dates) expect(review.text).toContain(date);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.writes.map((write) => write.input?.startDateLocal)).toEqual(
      dates.map((date) => `${date}T00:00:00`),
    );
  });

  it("allows editing today's coach workout and deleting a future coach workout", async () => {
    const { service, fake } = await setup();
    const event = fake.events.get(101);
    if (event === undefined) throw new Error("Missing fictional workout");
    event.startDateLocal = "1998-09-07T00:00:00";
    const { control } = await prepare(service, [
      { kind: "edit", eventId: 101, patch: { name: "Today's easy ride" } },
      { kind: "delete", eventId: 102 },
    ]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(fake.events.get(101)?.name).toBe("Today's easy ride");
    expect(fake.events.has(102)).toBe(false);
  });
  it("retries only remaining work and retains successful receipts across restart", async () => {
    const { service, fake, dataDir } = await setup();
    const { control } = await prepare(service, [
      add,
      { ...add, name: "Second" },
      { kind: "edit", eventId: 101, patch: { durationSeconds: 4500 } },
      { kind: "delete", eventId: 102 },
    ]);
    fake.fail("reject", 3);
    const first = await approve(service, control.token);
    expect(first.kind).toBe("partial");
    expect(first.text).toContain("Already completed");
    expect(fake.writes).toHaveLength(3);
    await service.close();
    const reopened = await openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" });
    services.push(reopened);
    const review = await reopened.review({ chatId: "chat", language: "en" });
    if (!review || review.handle === null) throw new Error("Missing retry review");
    const retry = await reopened.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
    if (!retry) throw new Error("Missing retry");
    expect(retry.kind).toBe("retry");
    expect((await approve(reopened, retry.token, "retry-remaining")).kind).toBe("completed");
    expect(fake.writes.filter((write) => write.kind === "add")).toHaveLength(2);
    expect(fake.events.get(101)?.movingTime).toBe(4500);
    expect(fake.events.has(102)).toBe(false);
  });
  it("revalidates remaining work after partial failure", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add, { kind: "delete", eventId: 101 }]);
    fake.fail("reject", 2);
    await approve(service, control.token);
    fake.events.set(101, { ...base, movingTime: 5400 });
    const review = await service.review({ chatId: "chat", language: "en" });
    if (!review || review.handle === null) throw new Error("Missing retry review");
    const retry = await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
    if (!retry) throw new Error("Missing retry");
    const result = await approve(service, retry.token, "retry-remaining");
    expect(result.kind).toBe("refresh-required");
    expect(result.text).toContain("No additional changes were applied");
    expect(result.text).toContain("Already completed");
    expect(fake.writes).toHaveLength(2);
  });
  it.each(["lost", "absent"] as const)(
    "never replays an uncertain creation (%s)",
    async (failure) => {
      const { service, fake, dataDir } = await setup();
      const { control } = await prepare(service, [add]);
      fake.fail(failure);
      expect((await approve(service, control.token)).kind).toBe("uncertain");
      await service.close();
      const reopened = await openWorkoutChangeSets({
        dataDir,
        client: fake.client,
        timezone: "UTC",
      });
      services.push(reopened);
      expect((await approve(reopened, control.token)).kind).toBe("invalid-action");
      expect(fake.writes).toHaveLength(1);
      const restoredReview = await reopened.review({ chatId: "chat", language: "en" });
      if (failure === "lost") expect(restoredReview).toBeNull();
      else expect(restoredReview?.handle).toBeNull();
      const next = await reopened.preparation.prepare({
        chatId: "chat",
        turnId: "new",
        preparation: { kind: "complete", changes: [add] },
      });
      expect(next.kind).toBe(failure === "lost" ? "prepared" : "refused");
    },
  );
  it("does not turn absent delete into an acknowledged success", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [{ kind: "delete", eventId: 101 }]);
    fake.fail("lost");
    expect((await approve(service, control.token)).kind).toBe("uncertain");
    expect(fake.events.has(101)).toBe(false);
    await service.recover();
    expect(
      (
        await service.preparation.prepare({
          chatId: "chat",
          turnId: "new",
          preparation: { kind: "complete", changes: [add] },
        })
      ).kind,
    ).toBe("refused");
    expect(fake.writes).toHaveLength(1);
  });
  it("restores a pending token after restart and blocks a second writer", async () => {
    const { service, fake, dataDir } = await setup();
    const { control } = await prepare(service, [add]);
    await expect(
      openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" }),
    ).rejects.toThrow("writer lock");
    await service.close();
    const reopened = await openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" });
    services.push(reopened);
    expect((await approve(reopened, control.token)).kind).toBe("completed");
  });
  it("rejects changed account identity and corrupt saved data", async () => {
    const { service, fake, dataDir } = await setup();
    const { control } = await prepare(service, [add]);
    fake.switchAccount();
    expect((await approve(service, control.token)).kind).toBe("blocked");
    expect(fake.writes).toEqual([]);
    await service.close();
    const root = join(dataDir, "workout-change-sets");
    const accountDir = (await readdir(root)).find((entry) => entry !== "writer.lock");
    if (!accountDir) throw new Error("Missing account directory");
    const file = (await readdir(join(root, accountDir))).find((entry) => entry.endsWith(".json"));
    if (!file) throw new Error("Missing record");
    const path = join(root, accountDir, file);
    const saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, version: 999 }));
    const original = calendar();
    await expect(
      openWorkoutChangeSets({ dataDir, client: original.client, timezone: "UTC" }),
    ).rejects.toThrow();
  });
  it("refuses invalid dates, past moves, and duplicate targets during preparation", async () => {
    const { service, fake } = await setup();
    const invalid: PreparedChange[][] = [
      [{ ...add, date: "1998-09-06" }],
      [{ ...add, date: "1998-02-30" }],
      [{ kind: "edit", eventId: 101, patch: { date: "1998-09-06" } }],
      [
        { kind: "delete", eventId: 101 },
        { kind: "delete", eventId: 101 },
      ],
    ];
    for (const [index, changes] of invalid.entries()) {
      expect(
        (
          await service.preparation.prepare({
            chatId: "chat",
            turnId: `invalid-${index}`,
            preparation: { kind: "complete", changes },
          })
        ).kind,
      ).toBe("refused");
    }
    expect(fake.writes).toEqual([]);
  });
  it("protects workouts that become past and targets that disappear", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add, { kind: "delete", eventId: 101 }]);
    fake.events.delete(101);
    expect((await approve(service, control.token)).kind).toBe("blocked");
    expect(fake.writes).toEqual([]);
    const next = await prepare(service, [add], "new-turn");
    vi.setSystemTime(new Date("1998-09-09T00:00:00Z"));
    expect((await approve(service, next.control.token)).kind).toBe("blocked");
    expect(fake.writes).toEqual([]);
  });
  it.each([{ tags: [] }, { category: "NOTE" as const }, { startDateLocal: "1998-09-06T00:00:00" }])(
    "refuses ineligible edit and deletion proposals before offering approval: %j",
    async (patch) => {
      const { service, fake } = await setup();
      fake.events.set(101, { ...base, ...patch });
      const changes: PreparedChange[] = [
        { kind: "edit", eventId: 101, patch: { name: "Changed" } },
        { kind: "delete", eventId: 101 },
      ];
      for (const change of changes) {
        const result = await service.preparation.prepare({
          chatId: "chat",
          turnId: change.kind,
          preparation: { kind: "complete", changes: [add, change] },
        });
        expect(result.kind).toBe("refused");
        expect(
          (await service.review({ chatId: "chat", language: "en" }))?.handle ?? null,
        ).toBeNull();
      }
      expect(fake.writes).toEqual([]);
    },
  );
  it("blocks the first valid addition when the final target becomes past", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [
      { ...add, date: "1998-09-12" },
      { kind: "delete", eventId: 101 },
    ]);
    vi.setSystemTime(new Date("1998-09-10T00:00:00Z"));
    expect((await approve(service, control.token)).kind).toBe("blocked");
    expect(fake.writes).toEqual([]);
    expect(fake.events.has(101)).toBe(true);
  });
  it("blocks all writes and fresh approval when a reviewed target cannot be read", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add, { kind: "delete", eventId: 101 }]);
    fake.client.events.get = async () => {
      throw new Error("Calendar unavailable");
    };
    expect((await approve(service, control.token)).kind).toBe("blocked");
    expect(fake.writes).toEqual([]);
    expect((await service.review({ chatId: "chat", language: "en" }))?.handle).toBeNull();
  });
  it("recovers the durable pre-write image after remote acceptance without repeating creation", async () => {
    const { service, fake, dataDir } = await setup();
    const original = fake.client.events.create;
    let crashImage: { path: string; contents: string } | undefined;
    fake.client.events.create = async (input) => {
      const root = join(dataDir, "workout-change-sets");
      const accountDir = (await readdir(root)).find((entry) => entry !== "writer.lock");
      if (!accountDir) throw new Error("Missing account directory");
      const file = (await readdir(join(root, accountDir))).find((entry) => entry.endsWith(".json"));
      if (!file) throw new Error("Missing state");
      const path = join(root, accountDir, file);
      const contents = await readFile(path, "utf8");
      expect(JSON.parse(contents).state.kind).toBe("executing");
      crashImage = { path, contents };
      return original(input);
    };
    const { control } = await prepare(service, [add]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    await service.close();
    if (!crashImage) throw new Error("Missing durable crash image");
    await writeFile(crashImage.path, crashImage.contents);
    const reopened = await openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" });
    services.push(reopened);
    expect((await approve(reopened, control.token)).kind).toBe("invalid-action");
    const result = await reopened.review({ chatId: "chat", language: "en", redisplay: true });
    expect(result?.handle).toBeNull();
    expect(result?.text).toContain("desired state observed");
    expect(fake.writes).toHaveLength(1);
    expect([...fake.events.values()].filter((event) => event.name === add.name)).toHaveLength(1);
  });
  it("abandons uncommitted preparation after restart", async () => {
    const { service, fake, dataDir } = await setup();
    await service.preparation.prepare({
      chatId: "chat",
      turnId: "unfinished",
      preparation: { kind: "complete", changes: [add] },
    });
    await service.close();
    const reopened = await openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" });
    services.push(reopened);
    const pending = await reopened.review({ chatId: "chat", language: "en" });
    await reopened.preparation.settleTurn({
      chatId: "chat",
      turnId: "unfinished",
      outcome: "commit",
    });
    expect(await reopened.review({ chatId: "chat", language: "en" })).toEqual(pending);
    await reopened.close();
    const pendingRestart = await openWorkoutChangeSets({
      dataDir,
      client: fake.client,
      timezone: "UTC",
    });
    services.push(pendingRestart);
    expect(await pendingRestart.review({ chatId: "chat", language: "en" })).toEqual(pending);
    const delivered = await acknowledgeAbandoned(pendingRestart);
    await pendingRestart.close();
    const restored = await openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" });
    services.push(restored);
    expect(await restored.review({ chatId: "chat", language: "en" })).toBeNull();
    expect(await restored.review({ chatId: "chat", language: "en", redisplay: true })).toEqual({
      handle: null,
      text: delivered.text,
      presentation: { kind: "text" },
    });
    expect(await restored.review({ chatId: "chat", language: "en" })).toBeNull();
    expect(fake.writes).toEqual([]);
  });
  it("explicit redisplay renews the control while ordinary chat preserves it", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [add]);
    const review = await service.review({ chatId: "chat", language: "en", redisplay: true });
    if (!review || review.handle === null) throw new Error("Missing redisplay");
    expect((await approve(service, control.token)).kind).toBe("invalid-action");
    const renewed = await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
    if (!renewed) throw new Error("Missing renewed control");
    expect((await approve(service, renewed.token)).kind).toBe("completed");
    expect(fake.writes).toHaveLength(1);
  });
  it("recovers a lost update response by observing its exact desired state", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [
      {
        kind: "edit",
        eventId: 101,
        patch: {
          name: "New name",
          date: "1998-09-11",
          description: "New description",
          durationSeconds: 4500,
          trainingLoad: 75,
          structure: { steps: [3, 4] },
        },
      },
      add,
    ]);
    fake.fail("lost");
    expect((await approve(service, control.token)).kind).toBe("uncertain");
    await service.recover();
    const review = await service.review({ chatId: "chat", language: "en" });
    if (!review || review.handle === null) throw new Error("Missing recovered review");
    expect(review.text).toContain("desired state observed");
    expect(fake.events.get(101)).toMatchObject({
      name: "New name",
      startDateLocal: "1998-09-11T00:00:00",
      description: "New description",
      movingTime: 4500,
      icuTrainingLoad: 75,
      workoutDoc: { steps: [3, 4] },
    });
    const retry = await service.acknowledgeDelivery({ chatId: "chat", delivery: review.handle });
    if (!retry) throw new Error("Missing recovered retry");
    expect((await approve(service, retry.token, "retry-remaining")).kind).toBe("completed");
    expect(fake.writes.filter((write) => write.kind === "edit")).toHaveLength(1);
  });

  it("flushes attempt before dispatch and receipt before the next request", async () => {
    const { service, fake, dataDir } = await setup();
    const original = fake.client.events.create;
    let attempt = 0;
    fake.client.events.create = async (input) => {
      const root = join(dataDir, "workout-change-sets");
      const accountDir = (await readdir(root)).find((entry) => entry !== "writer.lock");
      if (!accountDir) throw new Error("Missing account directory");
      const file = (await readdir(join(root, accountDir))).find((entry) => entry.endsWith(".json"));
      if (!file) throw new Error("Missing state");
      const record = JSON.parse(await readFile(join(root, accountDir, file), "utf8"));
      expect(record.state.kind).toBe("executing");
      expect(record.state.attemptId).toEqual(expect.any(String));
      expect(record.state.finished).toHaveLength(attempt);
      expect(record.state.attempting.prepared.name).toBe(input.name);
      attempt += 1;
      return original(input);
    };
    const { control } = await prepare(service, [add, { ...add, name: "Second ride" }]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    expect(attempt).toBe(2);
  });
  it.each([undefined, "fictional-activity"])(
    "does not add an activity-pairing restriction (%s)",
    async (pairedActivityId) => {
      const { service, fake } = await setup();
      fake.events.set(101, Object.assign({ ...base }, { pairedActivityId }));
      const { control } = await prepare(service, [{ kind: "delete", eventId: 101 }]);
      expect((await approve(service, control.token)).kind).toBe("completed");
      expect(fake.events.has(101)).toBe(false);
    },
  );

  it("renders saved stale-review differences in the currently selected language", async () => {
    const { service, fake } = await setup();
    const { control } = await prepare(service, [
      { kind: "edit", eventId: 101, patch: { durationSeconds: 4500 } },
    ]);
    fake.events.set(101, { ...base, movingTime: 5400 });
    expect((await approve(service, control.token)).text).toContain("No changes were applied");
    const review = await service.review({ chatId: "chat", language: "es" });
    expect(review?.text).toContain("No se aplicó ningún cambio");
    expect(review?.text).not.toContain("No changes were applied");
    if (!review || review.handle === null) throw new Error("Missing localized review");
    const localized = await service.acknowledgeDelivery({
      chatId: "chat",
      delivery: review.handle,
      language: "es",
    });
    expect(localized?.prompt).not.toContain("Apply all");
  });
  it("retains the completed outcome on restart without reusing its old approval", async () => {
    const { service, fake, dataDir } = await setup();
    const { control } = await prepare(service, [add]);
    expect((await approve(service, control.token)).kind).toBe("completed");
    await service.close();
    const reopened = await openWorkoutChangeSets({ dataDir, client: fake.client, timezone: "UTC" });
    services.push(reopened);
    expect((await approve(reopened, control.token)).kind).toBe("invalid-action");
    const outcome = await reopened.review({ chatId: "chat", language: "en", redisplay: true });
    expect(outcome?.handle).toBeNull();
    expect(outcome?.text).toContain("All reviewed changes are complete");
    expect(outcome?.text).toContain("Easy ride");
    expect(fake.writes).toHaveLength(1);
  });
});
