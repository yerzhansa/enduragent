import { describe, expect, it } from "vitest";
import type {
  NewPlanReconciliationItem,
  NewPlanReconciliationJob,
  PlanRecord,
  PlanReconciliationErrorCode,
  PlanReconciliationItemRecord,
  PlanReconciliationJobRecord,
  PlanReconciliationKind,
  PlanReconciliationRepository,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  cleanupPlanMirror,
  planMirrorExternalId,
  projectPlanReconciliation,
  reconcileActivePlanWindow,
  verifyPlanMirror,
  verifyPlanCleanup,
  type PlanMirrorCalendarPort,
  type PlanMirrorCreateInput,
  type PlanMirrorEvent,
  type PlanMirrorUpdateInput,
} from "../src/index.js";

const PLAN_ID = "01K00000000000000000000001";
const OTHER_PLAN_ID = "01K00000000000000000000002";

function plan(): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Synthetic Plan",
    primaryGoal: "Synthetic goal",
    startDateKey: 20260824,
    targetDateKey: 20261115,
    status: "active",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId: "device",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
  };
}

function workout(id: string, dateKey: number): PlanWorkoutRecord {
  return {
    id,
    planId: PLAN_ID,
    dateKey,
    sport: "cycling",
    name: "Endurance",
    durationS: 3600,
    structureJson: "{}",
    origin: "coach",
    deviceId: "device",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
  };
}

class MemoryReconciliationRepository implements PlanReconciliationRepository {
  readonly jobs = new Map<string, PlanReconciliationJobRecord>();
  readonly items = new Map<string, PlanReconciliationItemRecord>();

  async createOrGetJob(record: NewPlanReconciliationJob): Promise<PlanReconciliationJobRecord> {
    const existing = [...this.jobs.values()].find(
      (job) =>
        job.planId === record.planId &&
        job.kind === record.kind &&
        job.windowStartDateKey === record.windowStartDateKey &&
        job.windowEndDateKey === record.windowEndDateKey,
    );
    if (existing !== undefined) return existing;
    const job: PlanReconciliationJobRecord = {
      ...record,
      status: "pending",
      attemptCount: 0,
      failureCount: 0,
      resumedCount: 0,
      lastResumedAttempt: null,
      lastErrorCode: null,
      updatedAtMs: record.createdAtMs,
      completedAtMs: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async readJob(id: string): Promise<PlanReconciliationJobRecord | undefined> {
    return this.jobs.get(id);
  }

  async readLatestJob(
    planId: string,
    kind: PlanReconciliationKind,
  ): Promise<PlanReconciliationJobRecord | undefined> {
    return [...this.jobs.values()]
      .filter((job) => job.planId === planId && job.kind === kind)
      .at(-1);
  }

  async reopenJob(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord> {
    const job: PlanReconciliationJobRecord = {
      ...this.jobs.get(id)!,
      status: "pending",
      lastErrorCode: null,
      completedAtMs: null,
      updatedAtMs,
    };
    this.jobs.set(id, job);
    return job;
  }

  async beginAttempt(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord> {
    const current = this.jobs.get(id)!;
    const job: PlanReconciliationJobRecord = {
      ...current,
      status: current.status === "failed" || current.status === "retrying" ? "retrying" : "running",
      attemptCount: current.attemptCount + 1,
      resumedCount:
        current.resumedCount +
        (current.status === "running" || current.status === "retrying" ? 1 : 0),
      lastResumedAttempt:
        current.status === "running" || current.status === "retrying"
          ? current.attemptCount + 1
          : null,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: null,
    };
    this.jobs.set(id, job);
    return job;
  }

  async listRunnable(input: {
    nowMs: number;
    leaseMs: number;
    maxFailures: number;
  }): Promise<readonly PlanReconciliationJobRecord[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === "pending" ||
          job.status === "retrying" ||
          (job.status === "failed" && job.failureCount < input.maxFailures) ||
          (job.status === "running" && job.updatedAtMs + input.leaseMs <= input.nowMs),
      )
      .sort(
        (left, right) =>
          left.windowStartDateKey - right.windowStartDateKey ||
          left.createdAtMs - right.createdAtMs ||
          left.id.localeCompare(right.id),
      );
  }

  async claim(
    id: string,
    nowMs: number,
    leaseMs: number,
  ): Promise<PlanReconciliationJobRecord | undefined> {
    const job = this.jobs.get(id);
    if (
      job === undefined ||
      job.status === "verified" ||
      (job.status === "running" && job.updatedAtMs + leaseMs > nowMs)
    ) {
      return undefined;
    }
    return this.beginAttempt(id, nowMs);
  }

  async readLatestJobsForLibrary(): Promise<readonly PlanReconciliationJobRecord[]> {
    const latest = new Map<string, PlanReconciliationJobRecord>();
    for (const job of [...this.jobs.values()].sort(
      (left, right) =>
        left.planId.localeCompare(right.planId) ||
        left.kind.localeCompare(right.kind) ||
        right.windowStartDateKey - left.windowStartDateKey ||
        right.windowEndDateKey - left.windowEndDateKey ||
        right.id.localeCompare(left.id),
    )) {
      const key = `${job.planId}:${job.kind}`;
      if (!latest.has(key)) latest.set(key, job);
    }
    return Object.freeze([...latest.values()]);
  }

  async readLatestJobByWindow(
    planId: string,
    kind: PlanReconciliationKind,
  ): Promise<PlanReconciliationJobRecord | undefined> {
    return [...this.jobs.values()]
      .filter((job) => job.planId === planId && job.kind === kind)
      .sort(
        (left, right) =>
          right.windowStartDateKey - left.windowStartDateKey ||
          right.windowEndDateKey - left.windowEndDateKey ||
          right.id.localeCompare(left.id),
      )[0];
  }

  async failJob(
    id: string,
    errorCode: PlanReconciliationErrorCode,
    updatedAtMs: number,
  ): Promise<PlanReconciliationJobRecord> {
    const current = this.jobs.get(id)!;
    const job = {
      ...current,
      status: "failed" as const,
      failureCount: current.failureCount + 1,
      lastErrorCode: errorCode,
      updatedAtMs,
    };
    this.jobs.set(id, job);
    return job;
  }

  async verifyJob(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord> {
    const job = {
      ...this.jobs.get(id)!,
      status: "verified" as const,
      lastResumedAttempt: null,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: updatedAtMs,
    };
    this.jobs.set(id, job);
    return job;
  }

  async prepareItem(record: NewPlanReconciliationItem): Promise<PlanReconciliationItemRecord> {
    const existing = [...this.items.values()].find(
      (item) =>
        item.jobId === record.jobId &&
        item.operation === record.operation &&
        item.externalId === record.externalId,
    );
    if (existing !== undefined) {
      if (
        existing.expectedJson !== record.expectedJson ||
        existing.dateKey !== record.dateKey ||
        existing.planWorkoutId !== record.planWorkoutId
      ) {
        const changed: PlanReconciliationItemRecord = {
          ...existing,
          planWorkoutId: record.planWorkoutId,
          dateKey: record.dateKey,
          expectedJson: record.expectedJson,
          status: "pending",
          providerEventId: null,
          lastErrorCode: null,
          updatedAtMs: record.createdAtMs,
          completedAtMs: null,
        };
        this.items.set(existing.id, changed);
        return changed;
      }
      return existing;
    }
    const item: PlanReconciliationItemRecord = {
      ...record,
      status: "pending",
      providerEventId: null,
      attemptCount: 0,
      lastErrorCode: null,
      updatedAtMs: record.createdAtMs,
      completedAtMs: null,
    };
    this.items.set(item.id, item);
    return item;
  }

  async readItems(jobId: string): Promise<readonly PlanReconciliationItemRecord[]> {
    return [...this.items.values()].filter((item) => item.jobId === jobId);
  }

  async startItem(id: string, updatedAtMs: number): Promise<PlanReconciliationItemRecord> {
    const current = this.items.get(id)!;
    const item = {
      ...current,
      status: "running" as const,
      attemptCount: current.attemptCount + 1,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: null,
    };
    this.items.set(id, item);
    return item;
  }

  async markItemCreated(id: string, updatedAtMs: number): Promise<PlanReconciliationItemRecord> {
    const item = {
      ...this.items.get(id)!,
      status: "created" as const,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: null,
    };
    this.items.set(id, item);
    return item;
  }

  async failItem(
    id: string,
    errorCode: Exclude<PlanReconciliationErrorCode, "calendar-list-failed">,
    updatedAtMs: number,
  ): Promise<PlanReconciliationItemRecord> {
    const item = {
      ...this.items.get(id)!,
      status: "failed" as const,
      lastErrorCode: errorCode,
      updatedAtMs,
    };
    this.items.set(id, item);
    return item;
  }

  async deleteItem(id: string): Promise<void> {
    this.items.delete(id);
  }

  async verifyItem(
    id: string,
    providerEventId: number | null,
    updatedAtMs: number,
  ): Promise<PlanReconciliationItemRecord> {
    const item = {
      ...this.items.get(id)!,
      status: "verified" as const,
      providerEventId,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: updatedAtMs,
    };
    this.items.set(id, item);
    return item;
  }
}

class MemoryCalendar implements PlanMirrorCalendarPort {
  readonly events: PlanMirrorEvent[] = [];
  readonly creates: PlanMirrorCreateInput[] = [];
  readonly updates: PlanMirrorUpdateInput[] = [];
  readonly deletes: number[] = [];
  readonly lists: Array<{ readonly startDateKey: number; readonly endDateKey: number }> = [];
  createFailures = 0;
  listFailure = false;
  nextEventId = 100;
  onList: ((call: number) => void) | undefined;

  async listEvents(input: { startDateKey: number; endDateKey: number }) {
    if (this.listFailure) throw new Error("unavailable");
    this.lists.push(input);
    this.onList?.(this.lists.length);
    return this.events.filter(
      (event) => event.dateKey >= input.startDateKey && event.dateKey <= input.endDateKey,
    );
  }

  async createEvent(input: PlanMirrorCreateInput) {
    this.creates.push(input);
    if (this.createFailures > 0) {
      this.createFailures -= 1;
      throw new Error("unavailable");
    }
    const content = JSON.parse(input.structureJson) as Record<string, unknown>;
    this.events.push({
      id: this.nextEventId++,
      dateKey: input.dateKey,
      externalId: input.externalId,
      name: input.name,
      durationS: input.durationS,
      description: typeof content.description === "string" ? content.description : null,
      workoutDoc:
        content.workoutDoc !== null &&
        typeof content.workoutDoc === "object" &&
        !Array.isArray(content.workoutDoc)
          ? (content.workoutDoc as Readonly<Record<string, unknown>>)
          : null,
    });
  }

  async updateEvent(input: PlanMirrorUpdateInput) {
    this.updates.push(input);
    const index = this.events.findIndex((event) => event.id === input.eventId);
    if (index < 0) throw new Error("missing");
    const content = JSON.parse(input.structureJson) as Record<string, unknown>;
    this.events[index] = {
      ...this.events[index]!,
      dateKey: input.dateKey,
      name: input.name,
      durationS: input.durationS,
      description: typeof content.description === "string" ? content.description : null,
      workoutDoc:
        content.workoutDoc !== null &&
        typeof content.workoutDoc === "object" &&
        !Array.isArray(content.workoutDoc)
          ? (content.workoutDoc as Readonly<Record<string, unknown>>)
          : null,
    };
  }

  async deleteEvent(input: { eventId: number }) {
    this.deletes.push(input.eventId);
    const index = this.events.findIndex((event) => event.id === input.eventId);
    if (index < 0) throw new Error("missing");
    this.events.splice(index, 1);
  }
}

function harness() {
  const repository = new MemoryReconciliationRepository();
  const calendar = new MemoryCalendar();
  let id = 10;
  let now = 10;
  return {
    repository,
    calendar,
    deps: {
      repository,
      calendar,
      identity: { newId: () => `01K00000000000000000000${String(id++).padStart(3, "0")}` },
      now: () => now++,
    },
  };
}

describe("Plan reconciler", () => {
  it("projects every accepted activation and reconciliation domain state", async () => {
    const value = harness();
    const base = await value.repository.createOrGetJob({
      id: "01K00000000000000000000201",
      planId: PLAN_ID,
      kind: "mirror",
      windowStartDateKey: 20260825,
      windowEndDateKey: 20260831,
      createdAtMs: 1,
    });
    const states: Array<readonly [PlanReconciliationJobRecord, string]> = [
      [base, "activation-local"],
      [{ ...base, status: "running", attemptCount: 1 }, "reconcile-running"],
      [
        {
          ...base,
          status: "failed",
          attemptCount: 1,
          failureCount: 1,
          lastErrorCode: "calendar-create-failed",
        },
        "reconcile-failed",
      ],
      [{ ...base, status: "retrying", attemptCount: 2, failureCount: 1 }, "reconcile-retrying"],
      [
        {
          ...base,
          status: "failed",
          attemptCount: 2,
          failureCount: 2,
          lastErrorCode: "calendar-create-failed",
        },
        "reconcile-failed-again",
      ],
      [
        { ...base, status: "running", attemptCount: 2, resumedCount: 1, lastResumedAttempt: 2 },
        "reconcile-crash-resume",
      ],
      [{ ...base, status: "verified", attemptCount: 1, completedAtMs: 2 }, "reconcile-verified"],
    ];
    for (const [job, expected] of states) {
      expect((await projectPlanReconciliation(value.repository, job)).state).toBe(expected);
    }
  });

  it("mirrors only today plus six dates and prechecks every external id before create", async () => {
    const value = harness();
    const today = workout("01K00000000000000000000101", 20260825);
    const daySix = workout("01K00000000000000000000102", 20260831);
    const outside = workout("01K00000000000000000000103", 20260901);
    value.calendar.events.push({
      id: 42,
      dateKey: today.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, today.id),
    });
    const first = await reconcileActivePlanWindow(
      {
        plan: plan(),
        workouts: [today, daySix, outside],
        todayDateKey: 20260825,
      },
      value.deps,
    );
    expect(first).toMatchObject({
      state: "reconcile-verified",
      created: 2,
      pending: 0,
      failed: 0,
      total: 2,
    });
    expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([daySix.id]);
    await reconcileActivePlanWindow(
      {
        plan: plan(),
        workouts: [today, daySix, outside],
        todayDateKey: 20260825,
      },
      value.deps,
    );
    expect(value.calendar.creates).toHaveLength(1);
  });

  it("preserves today's events when eligibility starts tomorrow without shifting the window", async () => {
    const value = harness();
    const activePlan = { ...plan(), startDateKey: 19980824, targetDateKey: 19981115 };
    const today = workout("01K00000000000000000000101", 19980831);
    const tomorrow = workout("01K00000000000000000000102", 19980901);
    const daySix = workout("01K00000000000000000000103", 19980906);
    const outside = workout("01K00000000000000000000104", 19980907);
    const otherPlanToday = {
      id: 42,
      dateKey: today.dateKey,
      externalId: planMirrorExternalId(OTHER_PLAN_ID, "01K00000000000000000000105"),
    };
    const staleToday = {
      id: 43,
      dateKey: today.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, "01K00000000000000000000106"),
    };
    const staleTomorrow = {
      id: 44,
      dateKey: tomorrow.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, "01K00000000000000000000107"),
    };
    value.calendar.events.push(otherPlanToday, staleToday, staleTomorrow);
    const input = {
      plan: activePlan,
      workouts: [today, tomorrow, daySix, outside],
      todayDateKey: today.dateKey,
    };
    const first = await reconcileActivePlanWindow(
      { ...input, firstEligibleDateKey: tomorrow.dateKey },
      value.deps,
    );
    expect(first.state).toBe("reconcile-verified");
    expect([...value.repository.jobs.values()]).toMatchObject([
      { windowStartDateKey: today.dateKey, windowEndDateKey: daySix.dateKey },
    ]);
    expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([
      tomorrow.id,
      daySix.id,
    ]);
    expect(value.calendar.deletes).toEqual([staleTomorrow.id]);
    expect(value.calendar.events).toEqual(expect.arrayContaining([otherPlanToday, staleToday]));
    expect([...value.repository.items.values()].map((item) => item.dateKey)).toEqual([
      tomorrow.dateKey,
      daySix.dateKey,
      tomorrow.dateKey,
    ]);
    const second = await reconcileActivePlanWindow(input, value.deps);
    expect(second.state).toBe("reconcile-verified");
    expect(value.repository.jobs.size).toBe(1);
    expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([
      tomorrow.id,
      daySix.id,
      today.id,
    ]);
    expect(value.calendar.events).toContainEqual(otherPlanToday);
  });

  it.each([true, false])(
    "verifies today's retained delete without touching its pre-eligibility event: %s",
    async (eventExists) => {
      const value = harness();
      const tomorrow = workout("01K00000000000000000000102", 19980901);
      const event = {
        id: 43,
        dateKey: 19980831,
        externalId: planMirrorExternalId(PLAN_ID, "01K00000000000000000000106"),
      };
      const job = await value.repository.createOrGetJob({
        id: "01K00000000000000000000201",
        planId: PLAN_ID,
        kind: "mirror",
        windowStartDateKey: event.dateKey,
        windowEndDateKey: 19980906,
        createdAtMs: 1,
      });
      const retained = await value.repository.prepareItem({
        id: "01K00000000000000000000202",
        jobId: job.id,
        planWorkoutId: null,
        operation: "delete",
        dateKey: event.dateKey,
        externalId: event.externalId,
        expectedJson: JSON.stringify([{ eventId: event.id }]),
        createdAtMs: 1,
      });
      if (eventExists) value.calendar.events.push(event);

      const result = await reconcileActivePlanWindow(
        {
          plan: { ...plan(), startDateKey: 19980824, targetDateKey: 19981115 },
          workouts: [tomorrow],
          todayDateKey: event.dateKey,
          firstEligibleDateKey: tomorrow.dateKey,
        },
        value.deps,
      );

      expect(result).toMatchObject({ state: "reconcile-verified", pending: 0 });
      expect(value.repository.items.get(retained.id)).toMatchObject({ status: "verified" });
      expect(await value.repository.readJob(job.id)).toMatchObject({ status: "verified" });
      expect(value.calendar.deletes).toEqual([]);
      if (eventExists) expect(value.calendar.events).toContainEqual(event);
      expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([tomorrow.id]);
    },
  );

  it("removes an obsolete retained delete when its Workout is selected again", async () => {
    const value = harness();
    const restored = workout("01K00000000000000000000102", 19980903);
    const externalId = planMirrorExternalId(PLAN_ID, restored.id);
    const event = { id: 46, dateKey: restored.dateKey, externalId };
    const job = await value.repository.createOrGetJob({
      id: "01K00000000000000000000201",
      planId: PLAN_ID,
      kind: "mirror",
      windowStartDateKey: 19980831,
      windowEndDateKey: 19980906,
      createdAtMs: 1,
    });
    const obsolete = await value.repository.prepareItem({
      id: "01K00000000000000000000202",
      jobId: job.id,
      planWorkoutId: null,
      operation: "delete",
      dateKey: event.dateKey,
      externalId,
      expectedJson: JSON.stringify([{ eventId: event.id }]),
      createdAtMs: 1,
    });
    value.calendar.events.push(event);

    const result = await reconcileActivePlanWindow(
      {
        plan: { ...plan(), startDateKey: 19980824, targetDateKey: 19981115 },
        workouts: [restored],
        todayDateKey: 19980831,
      },
      value.deps,
    );

    expect(result).toMatchObject({ state: "reconcile-verified", pending: 0 });
    expect(value.repository.items.has(obsolete.id)).toBe(false);
    expect(value.calendar.deletes).toEqual([]);
    expect(value.calendar.events.filter((row) => row.externalId === externalId)).toHaveLength(1);
  });

  it("deletes an unwanted future duplicate while keeping today's owned event under tomorrow eligibility", async () => {
    const value = harness();
    const tomorrow = workout("01K00000000000000000000102", 19980901);
    const externalId = planMirrorExternalId(PLAN_ID, "01K00000000000000000000106");
    const todayEvent = { id: 47, dateKey: 19980831, externalId };
    const futureEvent = { id: 48, dateKey: 19980902, externalId };
    value.calendar.events.push(todayEvent, futureEvent);

    const result = await reconcileActivePlanWindow(
      {
        plan: { ...plan(), startDateKey: 19980824, targetDateKey: 19981115 },
        workouts: [tomorrow],
        todayDateKey: 19980831,
        firstEligibleDateKey: tomorrow.dateKey,
      },
      value.deps,
    );

    expect(result).toMatchObject({ state: "reconcile-verified", pending: 0 });
    expect(value.calendar.deletes).toEqual([futureEvent.id]);
    expect(value.calendar.events).toContainEqual(todayEvent);
    expect(value.calendar.events).not.toContainEqual(futureEvent);
    expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([tomorrow.id]);
  });

  it("retires a retained create whose Workout moved to an excluded today and deletes its event", async () => {
    const value = harness();
    const moved = workout("01K00000000000000000000102", 19980831);
    const tomorrow = workout("01K00000000000000000000103", 19980901);
    const event = {
      id: 45,
      dateKey: 19980902,
      externalId: planMirrorExternalId(PLAN_ID, moved.id),
    };
    const job = await value.repository.createOrGetJob({
      id: "01K00000000000000000000201",
      planId: PLAN_ID,
      kind: "mirror",
      windowStartDateKey: 19980831,
      windowEndDateKey: 19980906,
      createdAtMs: 1,
    });
    const retained = await value.repository.prepareItem({
      id: "01K00000000000000000000202",
      jobId: job.id,
      planWorkoutId: moved.id,
      operation: "create",
      dateKey: event.dateKey,
      externalId: event.externalId,
      expectedJson: JSON.stringify({ dateKey: event.dateKey }),
      createdAtMs: 1,
    });
    value.calendar.events.push(event);

    const result = await reconcileActivePlanWindow(
      {
        plan: { ...plan(), startDateKey: 19980824, targetDateKey: 19981115 },
        workouts: [moved, tomorrow],
        todayDateKey: 19980831,
        firstEligibleDateKey: tomorrow.dateKey,
      },
      value.deps,
    );

    expect(result).toMatchObject({ state: "reconcile-verified" });
    expect(value.repository.items.has(retained.id)).toBe(false);
    expect(value.calendar.deletes).toEqual([event.id]);
    expect(value.calendar.events.some((row) => row.externalId === event.externalId)).toBe(false);
    expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([tomorrow.id]);
  });

  it.each([false, true])(
    "deletes only eligible matches of a retained delete and keeps its pre-eligibility event: %s",
    async (hasEligibleMatch) => {
      const value = harness();
      const tomorrow = workout("01K00000000000000000000102", 19980901);
      const event = {
        id: 43,
        dateKey: 19980831,
        externalId: planMirrorExternalId(PLAN_ID, "01K00000000000000000000106"),
      };
      const eligibleEvent = { ...event, id: 44, dateKey: tomorrow.dateKey };
      const job = await value.repository.createOrGetJob({
        id: "01K00000000000000000000201",
        planId: PLAN_ID,
        kind: "mirror",
        windowStartDateKey: event.dateKey,
        windowEndDateKey: 19980906,
        createdAtMs: 1,
      });
      const retained = await value.repository.prepareItem({
        id: "01K00000000000000000000202",
        jobId: job.id,
        planWorkoutId: null,
        operation: "delete",
        dateKey: tomorrow.dateKey,
        externalId: event.externalId,
        expectedJson: JSON.stringify([{ eventId: event.id }]),
        createdAtMs: 1,
      });
      value.calendar.events.push(event);
      if (hasEligibleMatch) value.calendar.events.push(eligibleEvent);

      const result = await reconcileActivePlanWindow(
        {
          plan: { ...plan(), startDateKey: 19980824, targetDateKey: 19981115 },
          workouts: [tomorrow],
          todayDateKey: event.dateKey,
          firstEligibleDateKey: tomorrow.dateKey,
        },
        value.deps,
      );

      expect(result).toMatchObject({ state: "reconcile-verified", pending: 0 });
      expect(value.repository.items.get(retained.id)).toMatchObject({ status: "verified" });
      expect(await value.repository.readJob(job.id)).toMatchObject({ status: "verified" });
      expect(value.calendar.deletes).toEqual(hasEligibleMatch ? [eligibleEvent.id] : []);
      expect(value.calendar.events).toContainEqual(event);
      expect(value.calendar.events).not.toContainEqual(eligibleEvent);
      expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([tomorrow.id]);
    },
  );

  it("keeps today as the selection start when first eligibility is earlier", async () => {
    const value = harness();
    const today = workout("01K00000000000000000000101", 19980901);
    const yesterday = workout("01K00000000000000000000102", 19980831);
    const result = await reconcileActivePlanWindow(
      {
        plan: { ...plan(), startDateKey: 19980824, targetDateKey: 19981115 },
        workouts: [yesterday, today],
        todayDateKey: today.dateKey,
        firstEligibleDateKey: yesterday.dateKey,
      },
      value.deps,
    );
    expect(result.state).toBe("reconcile-verified");
    expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([today.id]);
  });

  it("lists again immediately before create and skips an event that appeared after the batch precheck", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    value.calendar.onList = (call) => {
      if (call === 2) {
        value.calendar.events.push({
          id: 42,
          dateKey: target.dateKey,
          externalId: planMirrorExternalId(PLAN_ID, target.id),
        });
      }
    };
    const result = await reconcileActivePlanWindow(
      {
        plan: plan(),
        workouts: [target],
        todayDateKey: 20260825,
      },
      value.deps,
    );
    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, total: 1 });
    expect(value.calendar.creates).toEqual([]);
    expect(value.calendar.lists.slice(0, 2)).toEqual([
      { startDateKey: 20260825, endDateKey: 20260831 },
      { startDateKey: 20260825, endDateKey: 20260825 },
    ]);
  });

  it("updates an existing managed event when the accepted Plan workout changed", async () => {
    const value = harness();
    const target = {
      ...workout("01K00000000000000000000101", 20260825),
      name: "Recovery",
      durationS: 1_800,
    };
    value.calendar.events.push({
      id: 42,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
      name: "Endurance",
      durationS: 3_600,
      description: null,
      workoutDoc: null,
    });

    const result = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      value.deps,
    );

    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, failed: 0 });
    expect(value.calendar.updates).toEqual([
      expect.objectContaining({ eventId: 42, name: "Recovery", durationS: 1_800 }),
    ]);
    expect(value.calendar.creates).toEqual([]);
  });

  it("updates a sparse verified event when the expected workout content changes", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260827);
    const sparseCalendar: PlanMirrorCalendarPort = {
      async listEvents(input) {
        return (await value.calendar.listEvents(input)).map(({ id, dateKey, externalId }) => ({
          id,
          dateKey,
          externalId,
        }));
      },
      createEvent: (input) => value.calendar.createEvent(input),
      updateEvent: (input) => value.calendar.updateEvent(input),
      deleteEvent: (input) => value.calendar.deleteEvent(input),
    };
    await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      { ...value.deps, calendar: sparseCalendar },
    );
    const changed = { ...target, name: "Recovery", durationS: 1_800 };

    const result = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [changed], todayDateKey: 20260826 },
      { ...value.deps, calendar: sparseCalendar },
    );

    expect(result).toMatchObject({ state: "reconcile-verified", failed: 0 });
    expect(value.calendar.updates).toEqual([
      expect.objectContaining({ name: "Recovery", durationS: 1_800 }),
    ]);
    expect(value.calendar.events).toEqual([
      expect.objectContaining({ name: "Recovery", durationS: 1_800 }),
    ]);
  });

  it("retries a failed update instead of trusting a sparse stale event", async () => {
    const value = harness();
    const target = {
      ...workout("01K00000000000000000000101", 20260825),
      name: "Recovery",
      durationS: 1_800,
    };
    value.calendar.events.push({
      id: 42,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
      name: "Endurance",
      durationS: 3_600,
      description: null,
      workoutDoc: null,
    });
    let updateAttempts = 0;
    const sparseCalendar: PlanMirrorCalendarPort = {
      async listEvents(input) {
        return (await value.calendar.listEvents(input)).map(({ id, dateKey, externalId }) => ({
          id,
          dateKey,
          externalId,
        }));
      },
      createEvent: (input) => value.calendar.createEvent(input),
      deleteEvent: (input) => value.calendar.deleteEvent(input),
      async updateEvent(input) {
        updateAttempts += 1;
        if (updateAttempts === 1) throw new Error("temporary update failure");
        await value.calendar.updateEvent(input);
      },
    };

    const first = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      { ...value.deps, calendar: sparseCalendar },
    );
    const second = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      { ...value.deps, calendar: sparseCalendar },
    );

    expect(first).toMatchObject({ state: "reconcile-failed", failed: 1 });
    expect(second).toMatchObject({ state: "reconcile-verified", failed: 0 });
    expect(updateAttempts).toBe(2);
    expect(value.calendar.updates).toEqual([
      expect.objectContaining({ eventId: 42, name: "Recovery", durationS: 1_800 }),
    ]);
  });

  it("deletes a managed event when its Plan workout moved outside the seven-day window", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260901);
    value.calendar.events.push({
      id: 42,
      dateKey: 20260825,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
      name: target.name,
      durationS: target.durationS,
      description: null,
      workoutDoc: null,
    });

    const result = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      value.deps,
    );

    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, failed: 0 });
    expect(value.calendar.deletes).toEqual([42]);
    expect(value.calendar.events).toEqual([]);
  });

  it("does not delete an athlete-owned event that uses the Plan mirror namespace", async () => {
    const value = harness();
    const target = {
      ...workout("01K00000000000000000000101", 20260825),
      origin: "athlete" as const,
    };
    value.calendar.events.push({
      id: 42,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
      name: target.name,
      durationS: target.durationS,
      description: null,
      workoutDoc: null,
    });

    const result = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      value.deps,
    );

    expect(result).toMatchObject({ state: "reconcile-verified", total: 0, failed: 0 });
    expect(value.calendar.deletes).toEqual([]);
    expect(value.calendar.events).toEqual([expect.objectContaining({ id: 42 })]);
  });

  it("fails verification when a provider event disappears after the initial list", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    value.calendar.events.push({
      id: 42,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
    });
    value.calendar.onList = (call) => {
      if (call === 2) value.calendar.events.splice(0);
    };
    const result = await reconcileActivePlanWindow(
      {
        plan: plan(),
        workouts: [target],
        todayDateKey: 20260825,
      },
      value.deps,
    );
    expect(result).toMatchObject({ state: "reconcile-failed", created: 0, failed: 1, total: 1 });
    expect(value.calendar.creates).toEqual([]);
  });

  it("resumes an interrupted item by prechecking the provider instead of duplicating it", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    const job = await value.repository.createOrGetJob({
      id: "01K00000000000000000000201",
      planId: PLAN_ID,
      kind: "mirror",
      windowStartDateKey: 20260825,
      windowEndDateKey: 20260831,
      createdAtMs: 1,
    });
    const item = await value.repository.prepareItem({
      id: "01K00000000000000000000202",
      jobId: job.id,
      planWorkoutId: target.id,
      operation: "create",
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
      expectedJson: JSON.stringify({
        dateKey: target.dateKey,
        name: target.name,
        sport: target.sport,
        durationS: target.durationS,
        structureJson: target.structureJson,
      }),
      createdAtMs: 1,
    });
    await value.repository.beginAttempt(job.id, 2);
    await value.repository.startItem(item.id, 3);
    value.calendar.events.push({ id: 42, dateKey: target.dateKey, externalId: item.externalId });
    const result = await reconcileActivePlanWindow(
      {
        plan: plan(),
        workouts: [target],
        todayDateKey: 20260825,
      },
      value.deps,
    );
    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, failed: 0 });
    expect(result.job).toMatchObject({ attemptCount: 2, resumedCount: 1 });
    expect(value.calendar.creates).toHaveLength(0);
  });

  it("keeps first and repeated failures distinct until an idempotent retry verifies", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    value.calendar.createFailures = 2;
    const first = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      value.deps,
    );
    const second = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      value.deps,
    );
    const third = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      value.deps,
    );
    expect(first.state).toBe("reconcile-failed");
    expect(second.state).toBe("reconcile-failed-again");
    expect(third).toMatchObject({ state: "reconcile-verified", created: 1, failed: 0 });
    expect(value.calendar.creates).toHaveLength(3);
  });

  it("verifies provider state without creating another event", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    value.calendar.createFailures = 1;
    const failed = await reconcileActivePlanWindow(
      { plan: plan(), workouts: [target], todayDateKey: 20260825 },
      value.deps,
    );
    value.calendar.events.push({
      id: 88,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
      name: target.name,
      durationS: target.durationS,
      description: null,
      workoutDoc: null,
    });

    const verified = await verifyPlanMirror(failed.job, value.deps);

    expect(verified).toMatchObject({ state: "reconcile-verified", created: 1, failed: 0 });
    expect(value.calendar.creates).toHaveLength(1);
  });

  it("cleanup preserves today and other Plans while deleting every duplicate tomorrow onward", async () => {
    const value = harness();
    const ownToday = planMirrorExternalId(PLAN_ID, "01K00000000000000000000101");
    const ownTomorrow = planMirrorExternalId(PLAN_ID, "01K00000000000000000000102");
    const otherTomorrow = planMirrorExternalId(OTHER_PLAN_ID, "01K00000000000000000000103");
    value.calendar.events.push(
      { id: 1, dateKey: 20260825, externalId: ownToday },
      { id: 2, dateKey: 20260826, externalId: ownTomorrow },
      { id: 3, dateKey: 20260826, externalId: ownTomorrow },
      { id: 4, dateKey: 20260826, externalId: otherTomorrow },
      { id: 5, dateKey: 20260826, externalId: null },
    );
    const result = await cleanupPlanMirror(
      {
        planId: PLAN_ID,
        todayDateKey: 20260825,
        endDateKey: 20260831,
      },
      value.deps,
    );
    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, total: 1 });
    expect(value.calendar.deletes).toEqual([2, 3]);
    expect(value.calendar.events.map((event) => event.id)).toEqual([1, 4, 5]);
  });

  it("verifies cleanup without deleting and discovers remaining Plan events", async () => {
    const value = harness();
    const ownTomorrow = planMirrorExternalId(PLAN_ID, "01K00000000000000000000102");
    const job = await value.repository.createOrGetJob({
      id: "01K00000000000000000000901",
      planId: PLAN_ID,
      kind: "cleanup",
      windowStartDateKey: 20260826,
      windowEndDateKey: 20260831,
      createdAtMs: 1,
    });
    value.calendar.events.push({ id: 2, dateKey: 20260826, externalId: ownTomorrow });

    const result = await verifyPlanCleanup(job, value.deps);

    expect(result).toMatchObject({ state: "reconcile-failed", created: 0, failed: 1, total: 1 });
    expect(value.calendar.deletes).toEqual([]);
  });

  it("persists a list failure without mutating the active local Plan", async () => {
    const value = harness();
    const active = plan();
    value.calendar.listFailure = true;
    const result = await reconcileActivePlanWindow(
      {
        plan: active,
        workouts: [workout("01K00000000000000000000101", 20260825)],
        todayDateKey: 20260825,
      },
      value.deps,
    );
    expect(result).toMatchObject({ state: "reconcile-failed", created: 0, pending: 1, failed: 0 });
    expect(active.status).toBe("active");
    expect(value.calendar.creates).toHaveLength(0);
  });
});
