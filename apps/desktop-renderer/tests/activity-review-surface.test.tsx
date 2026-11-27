import { renderLocalized as render } from "./language-harness";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_REVIEW_START, type ActivityReviewState } from "../src/activity-review/controller";
import type { ActivityReviewRead } from "../src/activity-review/rides";
import type { ActivityReviewActions } from "../src/state/activity-review-slice";
import { useEnduragentStore } from "../src/state/store";
import { ActivityReviewView } from "../src/ui/activity-review/ActivityReviewView";
import { TODAY, planWorkout, ride, rideId, rides } from "./activity-review-fixture";

const EASY = planWorkout(1, TODAY, "Easy endurance");
const THRESHOLD = planWorkout(2, 19980819, "Threshold 4×8", 4_800);
const SATURDAY = planWorkout(3, 19980822, "Long endurance", 9_000);

function actions(): ActivityReviewActions {
  return {
    refresh: vi.fn(),
    select: vi.fn(),
    change: vi.fn(),
    otherDay: vi.fn(),
    closeChoices: vi.fn(),
    confirm: vi.fn(),
    extra: vi.fn(),
    rematch: vi.fn(),
    showInCalendar: vi.fn(),
  };
}

function show(
  read: ActivityReviewRead,
  extra: Partial<Extract<ActivityReviewState, { kind: "ready" }>> = {},
  bound = actions(),
): ActivityReviewActions {
  act(() => {
    useEnduragentStore.setState({
      activityReview: {
        kind: "ready",
        read,
        selectedId: null,
        refresh: "idle",
        choices: "closed",
        saving: "idle",
        ...extra,
      },
      activityReviewActions: bound,
    });
  });
  return bound;
}

function withPlan(): ActivityReviewRead {
  return rides([
    ride("a", TODAY, {
      match: { kind: "suggested", ...EASY },
      otherWorkouts: [THRESHOLD, SATURDAY],
    }),
    ride("b", 19980819, {
      name: "Threshold 4×8",
      durationS: 4_440,
      perceivedExertion: 7,
      match: { kind: "confirmed", ...THRESHOLD, outcome: "done-differently", by: "you" },
    }),
    ride("c", 19980818, {
      name: "Endurance",
      durationS: 5_460,
      match: {
        kind: "confirmed",
        ...planWorkout(4, 19980818, "Endurance"),
        outcome: "done-as-planned",
        by: "you",
      },
    }),
    ride("d", 19980814, { name: "Café ride", durationS: 3_300 }),
  ]);
}

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      activityReview: ACTIVITY_REVIEW_START,
      activityReviewActions: null,
    });
  });
});

describe("the Activity review page", () => {
  it("lists rides by Training Week with each outcome and asks about the suggested match", () => {
    show(withPlan());
    render(<ActivityReviewView />);
    expect(screen.getByText("Thu 20 Aug · Road ride")).toBeInTheDocument();
    const list = screen.getByRole("navigation", { name: "Activities" });
    expect(within(list).getByText("Activities · Training Week 3")).toBeInTheDocument();
    expect(within(list).getByText("Training Week 2")).toBeInTheDocument();
    const rows = within(list).getAllByRole("button");
    expect(rows.map((row) => row.textContent?.replaceAll("\u00a0", " "))).toEqual([
      "Thu 20 · TodayRoad ride · 52mIs this Easy endurance? Confirm",
      "Wed 19Threshold 4×8 · 1h 14mDone differently",
      "Tue 18Endurance · 1h 31mDone as planned",
      "Fri 14Café ride · 55mExtra",
    ]);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByText("Thu 20 Aug, 6:55 AM · Road ride · from intervals.icu"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Road ride", level: 2 })).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Plan Workout match" });
    expect(within(card).getByText("Is this Thursday’s Easy endurance?")).toBeInTheDocument();
    expect(card).toHaveTextContent("Plan Workout · Thu 20Easy endurance50m");
    expect(card).toHaveTextContent("This rideRoad ride, 52m24.1 km, average 181 W");
    expect(card).toHaveTextContent(
      "Until you answer, this ride does not count toward the Plan, and the calendar shows Thursday as waiting, not done or missed.",
    );
    const stats = document.querySelector("dl");
    expect(stats).toHaveTextContent(
      "Riding time52mDistance24.1 kmLoad38Average power181 WAverage heart rate131 bpmPerceived exertionNot given",
    );
  });

  it("answers the match card: yes, something else, or another day's workout", async () => {
    const user = userEvent.setup();
    const bound = show(withPlan());
    const view = render(<ActivityReviewView />);
    await user.click(screen.getByRole("button", { name: "Yes, it is" }));
    expect(bound.confirm).toHaveBeenCalledWith(EASY.planWorkoutId);
    await user.click(screen.getByRole("button", { name: "No, it was something else" }));
    expect(bound.extra).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "It was another day’s workout" }));
    expect(bound.otherDay).toHaveBeenCalledOnce();
    show(withPlan(), { choices: "other-day" }, bound);
    view.rerender(<ActivityReviewView />);
    await user.click(screen.getByRole("button", { name: /^Sat 22 · Long endurance · 2h\s30m$/u }));
    expect(bound.rematch).toHaveBeenCalledWith(SATURDAY.planWorkoutId);
  });

  it("shows a confirmed match with Change, and the same choices once Change is open", async () => {
    const user = userEvent.setup();
    const bound = show(withPlan(), { selectedId: rideId("b") });
    const view = render(<ActivityReviewView />);
    expect(screen.getByText("Wed 19 Aug · Threshold 4×8")).toBeInTheDocument();
    expect(
      screen.getByText("Matched to Wednesday’s Plan Workout · confirmed by you"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Plan Workout match" })).toBeNull();
    expect(document.querySelector("dl")).toHaveTextContent("Perceived exertion7 of 10");
    await user.click(screen.getByRole("button", { name: "Show in calendar" }));
    expect(bound.showInCalendar).toHaveBeenCalledWith(19980819);
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(bound.change).toHaveBeenCalledOnce();
    show(withPlan(), { selectedId: rideId("b"), choices: "open", saving: "refused" }, bound);
    view.rerender(<ActivityReviewView />);
    const card = screen.getByRole("region", { name: "Plan Workout match" });
    expect(within(card).getByText("Is this Wednesday’s Threshold 4×8?")).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "This ride’s match changed meanwhile.",
    );
    expect(card).not.toHaveTextContent("Until you answer");
    await user.click(screen.getByRole("button", { name: /Fri 14/u }));
    expect(bound.select).toHaveBeenCalledWith(rideId("d"));
  });

  it("lists rides by calendar week without a Plan and has nothing to compare", () => {
    show(
      rides(
        [
          ride("a", 19980822, { name: "Café ride", durationS: 3_300 }),
          ride("b", 19980816, { name: "Easy spin", durationS: 1_200, fromIntervals: false }),
        ],
        null,
        19980822,
      ),
      { selectedId: null },
    );
    render(<ActivityReviewView />);
    expect(screen.getByText("Sat 22 Aug · Café ride · no Plan")).toBeInTheDocument();
    const list = screen.getByRole("navigation", { name: "Activities" });
    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Activities · 17–23 Aug", "10–16 Aug"]);
    expect(within(list).getAllByRole("button")[0]).toHaveTextContent(
      "Sat 22 · TodayCafé ride · 55m",
    );
    expect(within(list).getAllByRole("button")[0]?.textContent).not.toContain("Extra");
    expect(
      screen.getByText("No Plan, so there is nothing planned to compare."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("offers Retry when the rides cannot be read", async () => {
    const user = userEvent.setup();
    const bound = actions();
    act(() => {
      useEnduragentStore.setState({
        activityReview: { kind: "unavailable" },
        activityReviewActions: bound,
      });
    });
    render(<ActivityReviewView />);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(bound.refresh).toHaveBeenCalledOnce();
  });
});
