import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runMigrations } from "../src/store/migrator.js";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import { createPlanCreationRepository } from "../src/planning/creation-repository.js";
import {
  createPlanChangeRepository,
  type PreviewPlanChangeInput,
} from "../src/planning/change-repository.js";
import { openSqliteStorage } from "../../kernel-node/src/sqlite/index.js";

const id = (value: number) => String(value).padStart(26, "0");
const planId = id(11);
const nowMs = 883_612_800_000;
const stamp = (commandId: string, offset: number) => ({
  commandId,
  requestDigest: "a".repeat(64),
  nowMs: nowMs + offset,
  deviceId: "test-device-1998",
  hlcPhysicalMs: nowMs + offset,
  hlcCounter: 0,
});
const workout = {
  id: "ride",
  name: "Endurance ride",
  kind: "easy",
  date: "1998-01-01",
  minutes: 60,
};
const snapshot = {
  outputFingerprint: "f".repeat(64),
  weeks: [{ number: 1, minutes: 60, workouts: [workout] }],
};
const build: PreviewPlanChangeInput["build"] = () => ({
  afterSnapshotJson: JSON.stringify(snapshot),
  envelope: {
    title: "Limit weekly duration",
    intent: { kind: "weekly-duration", hours: 1 },
    diff: [],
    totals: {
      before: { plan: 60, weeks: [{ number: 1, minutes: 60 }] },
      after: { plan: 60, weeks: [{ number: 1, minutes: 60 }] },
    },
    supersedes: null,
    confidence: "Based on your confirmed limits.",
    premises: [],
  },
});

async function activePlan() {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  const creation = createPlanCreationRepository(store);
  const fingerprint = "f".repeat(64);
  await creation.start({
    command: stamp("start", 1),
    creationId: id(1),
    seed: { schemaVersion: 1, eventCandidates: [] },
  });
  await creation.recordDraft({
    command: stamp("draft", 2),
    creationId: id(1),
    expectedVersion: 1,
    draftId: id(2),
    inputSnapshotJson: "{}",
    inputFingerprint: "e".repeat(64),
    outputSnapshotJson: JSON.stringify(snapshot),
    builderId: "cycling",
    builderVersion: "1",
    activationFingerprint: fingerprint,
  });
  await creation.activate({
    command: stamp("activate", 3),
    incumbent: null,
    creationId: id(1),
    expectedVersion: 2,
    activatedAt: "1998-01-01",
    todayDateKey: 19980101,
    mirrorJobId: id(4),
    cleanupJobId: id(5),
    revisionId: id(3),
    materialize: () => ({
      plan: {
        id: planId,
        originId: null,
        name: "Improve fitness",
        primaryGoal: "Ride well",
        startDateKey: 19980101,
        targetDateKey: 19980107,
        status: "active",
        kind: "short_race_preparation",
        totalWeeks: 1,
        weekStartDay: 4,
        structureJson: "{}",
        createdAtMs: nowMs + 3,
        updatedAtMs: nowMs + 3,
        deviceId: "test-device-1998",
        hlcPhysicalMs: nowMs + 3,
        hlcCounter: 0,
      },
      workouts: [
        {
          id: id(31),
          planId,
          dateKey: 19980101,
          sport: "Ride",
          name: workout.name,
          durationS: workout.minutes * 60,
          structureJson: JSON.stringify(workout),
          origin: "coach",
          deviceId: "test-device-1998",
          hlcPhysicalMs: nowMs + 3,
          hlcCounter: 0,
        },
      ],
    }),
  });
  let sequence = 100;
  const repository = createPlanChangeRepository(store, {
    newId: () => id(++sequence),
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  const previewInput = (offset: number): PreviewPlanChangeInput => ({
    command: stamp(`preview-${offset}`, offset),
    planId,
    expectedVersion: 1,
    nowMs: nowMs + offset,
    changeId: id(offset),
    build,
  });
  const cancel = (changeId: string) =>
    repository.apply({
      command: stamp("cancel", 30),
      planId,
      changeId,
      expectedVersion: 1,
      decision: "cancel",
      nowMs: nowMs + 30,
      todayDateKey: () => 19980101,
      mirrorJobId: id(6),
      materialize: () => ({ insert: [], update: [], delete: [] }),
    });
  return { store, repository, previewInput, cancel };
}

describe("Plan Change publication sequence", () => {
  it("rejects an older translation after a newer preview is cancelled", async () => {
    const { store, repository, previewInput, cancel } = await activePlan();
    const expectedChangeSequence = await repository.captureChangeSequence(planId);
    const newer = await repository.preview(previewInput(20));
    expect(newer.status).toBe("previewed");
    expect(await cancel(id(20))).toMatchObject({ status: "cancelled", version: 1 });
    const olderBuild = vi.fn(build);
    expect(
      await repository.preview({ ...previewInput(10), expectedChangeSequence, build: olderBuild }),
    ).toEqual({ status: "rejected", reason: "stale-version" });
    expect(olderBuild).not.toHaveBeenCalled();
    expect(await repository.listChanges(planId)).toMatchObject([
      { changeId: id(20), status: "cancelled" },
    ]);
    expect(await store.get("SELECT version,current_revision_number FROM planning_plan")).toEqual({
      version: 1,
      current_revision_number: 1,
    });
    expect(
      await repository.preview({
        ...previewInput(40),
        expectedChangeSequence: await repository.captureChangeSequence(planId),
      }),
    ).toMatchObject({ status: "previewed", version: 1 });
  });

  it("invalidates a capture when an already pending preview is cancelled", async () => {
    const { repository, previewInput, cancel } = await activePlan();
    expect(await repository.preview(previewInput(10))).toMatchObject({ status: "previewed" });
    const expectedChangeSequence = await repository.captureChangeSequence(planId);
    expect(await cancel(id(10))).toMatchObject({ status: "cancelled" });
    expect(await repository.preview({ ...previewInput(40), expectedChangeSequence })).toEqual({
      status: "rejected",
      reason: "stale-version",
    });
  });

  it("replays a published command after cancellation without reviving its preview", async () => {
    const { repository, previewInput, cancel } = await activePlan();
    const input = {
      ...previewInput(10),
      expectedChangeSequence: await repository.captureChangeSequence(planId),
    };
    const published = await repository.preview(input);
    expect(published.status).toBe("previewed");
    expect(await cancel(id(10))).toMatchObject({ status: "cancelled" });
    expect(await repository.preview(input)).toEqual(published);
    expect(await repository.listChanges(planId)).toMatchObject([
      { changeId: id(10), status: "cancelled" },
    ]);
  });
});
