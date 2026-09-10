import type {
  ListPlansResult,
  PlanChangeIntent,
  PlanChangeModel,
  PlanChangeWorkout,
} from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import { currentSupportingEvents, supportingEventDifference } from "../src/plan/supporting-events";

const eventWorkout: PlanChangeWorkout = {
  id: "event-workout",
  supportingEventId: "event-one",
  kind: "event",
  name: "River ride",
  date: "1998-09-12",
  minutes: 45,
  pinned: true,
  power: null,
  guidance: "Use the accepted event limit",
};

function change(
  revision: number,
  intent: PlanChangeIntent,
  patch: Partial<PlanChangeModel> = {},
): PlanChangeModel {
  return {
    changeId: `change-${revision}`,
    planId: "plan-one",
    baseRevisionNumber: revision - 1,
    resultRevisionNumber: revision,
    status: "applied",
    title: "Supporting Event",
    intent,
    diff: [],
    totals: { before: { plan: 180, weeks: [] }, after: { plan: 180, weeks: [] } },
    supersedes: null,
    supersededBy: null,
    undo: { eligible: true },
    confidence: "Ready",
    premises: [],
    ...patch,
  };
}

function added(patch: Partial<PlanChangeModel> = {}) {
  return change(
    2,
    {
      kind: "supporting-event",
      operation: "add",
      name: "River ride",
      date: "1998-09-12",
      role: "Training",
    },
    { diff: [{ workoutId: eventWorkout.id, before: null, after: eventWorkout }], ...patch },
  );
}

function library(changes: PlanChangeModel[]): ListPlansResult {
  return {
    active: {
      planId: "plan-one",
      version: 10,
      name: "Autumn rides",
      start: "1998-09-07",
      end: "1998-10-04",
      weeks: 4,
      status: "active",
      supportingEventCandidates: [],
      todayChoice: null,
      closeReason: null,
      closedAt: null,
      activatedAt: "1998-09-07",
      creationId: null,
      calendar: { status: "not-connected", window: null, currentThrough: null, error: null },
    },
    calendarConnected: false,
    creation: null,
    legacy: null,
    closed: [],
    changes,
    pendingChangeCheck: null,
    changesPaused: null,
  };
}

describe("Supporting Event history", () => {
  it("uses applied changes for the active Plan and ignores pending and abandoned additions", () => {
    const read = library([
      added({ status: "pending", resultRevisionNumber: null, undo: null }),
      added({ status: "cancelled", resultRevisionNumber: null, undo: null }),
      added({ status: "superseded", resultRevisionNumber: null, undo: null }),
      added({ planId: "closed-plan" }),
    ]);
    expect(currentSupportingEvents(read)).toEqual([]);
    expect(currentSupportingEvents({ ...library([added()]), active: null })).toEqual([]);
  });

  it("replays role, manual corrections, and metadata-only names in revision order", () => {
    const role = change(3, {
      kind: "supporting-event",
      operation: "role",
      eventId: "event-one",
      role: "Important",
    });
    const corrected = change(4, {
      kind: "supporting-event",
      operation: "manual",
      eventId: "event-one",
      name: "River circuit",
      date: "1998-09-13",
    });
    const renamed = change(5, {
      kind: "supporting-event",
      operation: "name",
      eventId: "event-one",
      name: "Sunday circuit",
    });
    const read = library([renamed, role, corrected, added()]);
    expect(currentSupportingEvents(read)).toEqual([
      {
        id: "event-one",
        name: "Sunday circuit",
        date: "1998-09-13",
        role: "Important",
        source: { kind: "manual" },
      },
    ]);
    expect(supportingEventDifference(read, renamed)).toMatchObject({
      before: [{ name: "River circuit" }],
      after: [{ name: "Sunday circuit" }],
    });
  });

  it("shows pending facts at their base revision without accepting the preview", () => {
    const renamed = change(
      3,
      { kind: "supporting-event", operation: "name", eventId: "event-one", name: "Sunday ride" },
      { status: "pending", resultRevisionNumber: null, undo: null },
    );
    const read = library([renamed, added()]);
    expect(currentSupportingEvents(read)[0]?.name).toBe("River ride");
    expect(supportingEventDifference(read, renamed)).toMatchObject({
      before: [{ name: "River ride" }],
      after: [{ name: "Sunday ride" }],
    });
  });

  it("restores removed events and names through inverse changes", () => {
    const renamed = change(3, {
      kind: "supporting-event",
      operation: "name",
      eventId: "event-one",
      name: "Sunday ride",
    });
    const removed = change(
      4,
      { kind: "supporting-event", operation: "remove", eventId: "event-one" },
      { diff: [{ workoutId: eventWorkout.id, before: eventWorkout, after: null }] },
    );
    expect(currentSupportingEvents(library([added(), renamed, removed]))).toEqual([]);
    const inverse = change(
      5,
      { kind: "inverse", changeId: removed.changeId },
      { diff: [{ workoutId: eventWorkout.id, before: null, after: eventWorkout }] },
    );
    expect(currentSupportingEvents(library([added(), renamed, removed, inverse]))[0]?.name).toBe(
      "Sunday ride",
    );
    expect(
      currentSupportingEvents(
        library([added(), renamed, change(4, { kind: "inverse", changeId: renamed.changeId })]),
      )[0]?.name,
    ).toBe("River ride");
  });

  it("preserves a protected event when an inverse cannot remove its Workout", () => {
    expect(
      currentSupportingEvents(
        library([added(), change(3, { kind: "inverse", changeId: "change-2" })]),
      ),
    ).toHaveLength(1);
  });

  it("reads synchronized source evidence and accepts updated details", () => {
    const source = {
      providerId: "fixture-event",
      sourceRevision: "a".repeat(64),
      name: "River race",
      date: "1998-09-12",
      category: "RACE_B",
    };
    const synced = added({
      intent: {
        kind: "supporting-event",
        operation: "add",
        name: "River race",
        date: "1998-09-12",
        role: "Important",
        providerId: source.providerId,
      },
      diff: [
        { workoutId: eventWorkout.id, before: null, after: { ...eventWorkout, name: source.name } },
      ],
      premises: [
        { id: "event-source", label: "Event", source: "Intervals.icu event", value: source },
      ],
    });
    const updated = change(
      3,
      { kind: "supporting-event", operation: "source-update", eventId: "event-one" },
      {
        premises: [
          {
            id: "event-source",
            label: "Event",
            source: "Intervals.icu event",
            value: {
              ...source,
              sourceRevision: "b".repeat(64),
              date: "1998-09-13",
              name: "River race updated",
            },
          },
        ],
      },
    );
    expect(currentSupportingEvents(library([synced, updated]))).toEqual([
      {
        id: "event-one",
        name: "River race updated",
        date: "1998-09-13",
        role: "Important",
        source: { kind: "synced", providerId: "fixture-event", sourceRevision: "b".repeat(64) },
      },
    ]);
  });
});
