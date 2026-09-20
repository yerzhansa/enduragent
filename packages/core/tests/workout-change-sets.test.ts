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
  expect(
    await service.preparation.prepare({
      chatId: "chat",
      turnId,
      preparation: { kind: "complete", changes },
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
    expect((await approve(service, first.control.token)).kind).toBe("invalid-action");
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
    expect((await approve(service, control.token)).kind).toBe("invalid-action");
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
