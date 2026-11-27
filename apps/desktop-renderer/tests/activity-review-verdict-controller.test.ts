import type { PlanCalendarRideReview, PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import {
  createRideReviewController,
  VERDICT_POLLS,
  type RideReviewState,
} from "../src/activity-review/review-controller";
import { rideId } from "./activity-review-fixture";

const RIDE = rideId("a");
const OTHER = rideId("b");

function review(patch: Partial<PlanCalendarRideReview> = {}): PlanCalendarRideReview {
  return {
    activityId: RIDE,
    verdict: { state: "not-written" },
    replies: 0,
    blocked: "none",
    note: null,
    ...patch,
  };
}

const KEPT = review({
  verdict: {
    state: "kept",
    text: "Steady and on plan.",
    writtenAtMs: 903_945_600_000,
    trigger: "opened",
    usedPlan: true,
    usedNote: false,
    marker: { kind: "current" },
  },
  replies: 1,
});

const answer = (value: PlanCalendarRideReview): PlanCalendarRpcResult => ({
  status: "review",
  review: value,
});

function harness(script: {
  read: (activityId: string) => PlanCalendarRpcResult | Error;
  write?: (event: string) => PlanCalendarRpcResult | Error;
  saveNote?: (note: string) => PlanCalendarRpcResult | Error;
}) {
  const states: RideReviewState[] = [];
  const calls: string[] = [];
  const timers: (() => void)[] = [];
  const reply = async (value: PlanCalendarRpcResult | Error) => {
    if (value instanceof Error) throw value;
    return value;
  };
  const controller = createRideReviewController({
    read: (activityId) => {
      calls.push(`read:${activityId.slice(0, 1)}`);
      return reply(script.read(activityId));
    },
    write: (request) => {
      calls.push(`write:${request.event}:${request.expected.state}:${request.expected.replies}`);
      return reply(script.write?.(request.event) ?? new Error("no write expected"));
    },
    saveNote: (request) => {
      calls.push(`note:${request.note}`);
      return reply(script.saveNote?.(request.note) ?? new Error("no note expected"));
    },
    later: (run) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    publish: (state) => states.push(state),
  });
  const tick = async () => {
    const run = timers.shift();
    if (run === undefined) throw new Error("no poll is waiting");
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { controller, states, calls, timers, tick, last: () => states.at(-1) };
}

describe("the coach's verdict controller", () => {
  it("asks for the verdict once when the athlete opens a ride", async () => {
    const test = harness({
      read: () => answer(review()),
      write: () => answer(review({ verdict: { state: "writing" }, replies: 1 })),
    });
    const showing = test.controller.show(RIDE);
    expect(test.last()).toEqual({ kind: "loading", activityId: RIDE });
    await showing;
    expect(test.calls).toEqual(["read:a", "write:opens:not-written:0"]);
    expect(test.last()).toMatchObject({ kind: "ready", review: { verdict: { state: "writing" } } });
    expect(test.timers).toHaveLength(1);
  });

  it("polls while the coach writes and stops once the verdict is kept", async () => {
    const replies = [review({ verdict: { state: "writing" }, replies: 1 }), KEPT];
    let reads = 0;
    const test = harness({
      read: () => answer(replies[Math.min(reads++, replies.length - 1)] ?? KEPT),
    });
    await test.controller.show(RIDE);
    expect(test.calls).toEqual(["read:a"]);
    await test.tick();
    expect(test.last()).toMatchObject({ kind: "ready", review: KEPT });
    expect(test.timers).toHaveLength(0);
    expect(test.calls).toEqual(["read:a", "read:a"]);
  });

  it("does not ask again on a refresh or a poll, and never retries a failed verdict by itself", async () => {
    let state = review();
    const test = harness({
      read: () => answer(state),
      write: () => {
        state = review({ verdict: { state: "failed" }, replies: 1 });
        return answer(state);
      },
    });
    await test.controller.show(RIDE);
    await test.controller.refresh();
    await test.controller.refresh();
    expect(test.calls).toEqual(["read:a", "write:opens:not-written:0", "read:a", "read:a"]);
    expect(test.last()).toMatchObject({ review: { verdict: { state: "failed" } } });
  });

  it("writes a failed verdict again when the athlete opens the ride again", async () => {
    const failed = review({ verdict: { state: "failed" }, replies: 1 });
    const test = harness({
      read: () => answer(failed),
      write: () => answer(review({ verdict: { state: "writing" }, replies: 2 })),
    });
    await test.controller.show(RIDE);
    expect(test.calls).toEqual(["read:a", "write:opens:failed:1"]);
  });

  it("waits for the match and for a model, and asks once when the block clears on a refresh", async () => {
    let state = review({ blocked: "no-model" });
    const test = harness({
      read: () => answer(state),
      write: () => answer(review({ verdict: { state: "writing" }, replies: 1 })),
    });
    await test.controller.show(RIDE);
    expect(test.calls).toEqual(["read:a"]);
    state = review();
    await test.controller.refresh();
    expect(test.calls).toEqual(["read:a", "read:a", "write:opens:not-written:0"]);
    const waiting = harness({ read: () => answer(review({ blocked: "waiting-for-match" })) });
    await waiting.controller.show(RIDE);
    await waiting.controller.refresh();
    expect(waiting.calls).toEqual(["read:a", "read:a"]);
  });

  it("writes again on request with the shown state, and re-reads when the state moved on", async () => {
    let refused = true;
    const test = harness({
      read: () => answer(refused ? KEPT : review({ ...KEPT, replies: 2 })),
      write: () => {
        if (refused) {
          refused = false;
          return { status: "refused", reason: "review-changed" };
        }
        return answer(review({ verdict: { state: "writing" }, replies: 3 }));
      },
    });
    await test.controller.show(RIDE);
    await test.controller.writeAgain();
    expect(test.calls).toEqual(["read:a", "write:asks-again:kept:1", "read:a"]);
    expect(test.last()).toMatchObject({ asking: "idle", review: { replies: 2 } });
    await test.controller.writeAgain();
    expect(test.calls.at(-1)).toBe("write:asks-again:kept:2");
    expect(test.last()).toMatchObject({ review: { verdict: { state: "writing" }, replies: 3 } });
  });

  it("says so when Write again cannot reach the app, and offers nothing while blocked", async () => {
    const test = harness({ read: () => answer(KEPT), write: () => new Error("daemon gone") });
    await test.controller.show(RIDE);
    await test.controller.writeAgain();
    expect(test.last()).toMatchObject({ asking: "failed", review: KEPT });
    const blocked = harness({ read: () => answer({ ...KEPT, blocked: "waiting-for-match" }) });
    await blocked.controller.show(RIDE);
    await blocked.controller.writeAgain();
    expect(blocked.calls).toEqual(["read:a"]);
  });

  it("saves the note and reports a failure", async () => {
    let fail = false;
    const test = harness({
      read: () => answer(KEPT),
      saveNote: (note) =>
        fail ? new Error("daemon gone") : answer({ ...KEPT, note: { text: note, savedAtMs: 1 } }),
    });
    await test.controller.show(RIDE);
    const saving = test.controller.saveNote("Legs heavy");
    expect(test.last()).toMatchObject({ note: "saving" });
    await saving;
    expect(test.last()).toMatchObject({
      note: "saved",
      review: { verdict: { state: "kept" }, note: { text: "Legs heavy" } },
    });
    fail = true;
    await test.controller.saveNote("Legs heavier");
    expect(test.last()).toMatchObject({ note: "failed", review: { note: { text: "Legs heavy" } } });
  });

  it("stops polling after its budget, when the ride changes, and when the page closes", async () => {
    const writing = review({ verdict: { state: "writing" }, replies: 1 });
    const test = harness({ read: () => answer(writing) });
    await test.controller.show(RIDE);
    for (let poll = 0; poll < VERDICT_POLLS; poll += 1) await test.tick();
    expect(test.timers).toHaveLength(0);
    expect(test.calls).toHaveLength(VERDICT_POLLS + 1);
    await test.controller.show(OTHER);
    expect(test.timers).toHaveLength(1);
    await test.controller.show(null);
    expect(test.timers).toHaveLength(0);
    expect(test.last()).toEqual({ kind: "none" });
  });

  it("shows the verdict as unavailable when it cannot be read", async () => {
    const test = harness({ read: () => new Error("daemon gone") });
    await test.controller.show(RIDE);
    expect(test.last()).toEqual({ kind: "unavailable", activityId: RIDE });
  });
});
