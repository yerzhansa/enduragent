import { describe, expect, it } from "vitest";
import { reviewRange, rideGroups, rideOutcome, selectedRide } from "../src/activity-review/rides";
import { MONDAY, TODAY, planWorkout, ride, rideId, rides } from "./activity-review-fixture";

const ENDURANCE = planWorkout(1, TODAY, "Easy endurance");

describe("the Activity review list", () => {
  it("asks for the last 120 days, ending today", () => {
    expect(reviewRange(TODAY)).toEqual({ startDateKey: 19980423, endDateKey: TODAY });
  });

  it("groups rides newest first by Training Week while a Plan is active", () => {
    const read = rides([
      ride("b", 19980814),
      ride("a", TODAY, { match: { kind: "suggested", ...ENDURANCE } }),
      ride("c", 19980819, {
        startEpochSeconds: Date.parse("1998-08-19T05:40:00Z") / 1000,
      }),
      ride("d", 19980819, {
        startEpochSeconds: Date.parse("1998-08-19T16:00:00Z") / 1000,
      }),
    ]);
    const groups = rideGroups(read, 1);
    expect(groups.map((group) => group.label)).toEqual([
      { kind: "training-week", week: 3 },
      { kind: "training-week", week: 2 },
    ]);
    expect(groups.flatMap((group) => group.rides.map((entry) => entry.activityId))).toEqual([
      rideId("a"),
      rideId("d"),
      rideId("c"),
      rideId("b"),
    ]);
    expect(selectedRide(read, null)?.activityId).toBe(rideId("a"));
    expect(selectedRide(read, rideId("c"))?.activityId).toBe(rideId("c"));
    expect(selectedRide(read, rideId("z"))?.activityId).toBe(rideId("a"));
  });

  it("groups by calendar week from the region's first day without a Plan", () => {
    const read = rides([ride("a", 19980822), ride("b", 19980816), ride("c", 19980811)], null);
    expect(rideGroups(read, 1).map((group) => group.label)).toEqual([
      { kind: "week", startDateKey: 19980817, endDateKey: 19980823 },
      { kind: "week", startDateKey: MONDAY, endDateKey: 19980816 },
    ]);
    expect(rideGroups(read, 7).map((group) => group.label)).toEqual([
      { kind: "week", startDateKey: 19980816, endDateKey: 19980822 },
      { kind: "week", startDateKey: 19980809, endDateKey: 19980815 },
    ]);
  });

  it("names each ride's outcome, and leaves rides before the Plan without one", () => {
    const read = rides([]);
    const outcome = (extra: Parameters<typeof ride>[2], dateKey = TODAY) =>
      rideOutcome(read, ride("a", dateKey, extra));
    expect(outcome({ match: { kind: "suggested", ...ENDURANCE } })).toEqual({
      kind: "is-this",
      name: "Easy endurance",
    });
    expect(
      outcome({
        match: { kind: "confirmed", ...ENDURANCE, outcome: "done-differently", by: "you" },
      }),
    ).toEqual({ kind: "done-differently" });
    expect(outcome({})).toEqual({ kind: "extra" });
    expect(outcome({}, 19980720)).toEqual({ kind: "none" });
    expect(rideOutcome(rides([], null), ride("a", TODAY))).toEqual({ kind: "none" });
  });
});
