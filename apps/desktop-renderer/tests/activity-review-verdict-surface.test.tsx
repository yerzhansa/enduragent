import type { PlanCalendarRideReview, PlanCalendarVerdict } from "@enduragent/coach-contract";
import { renderLocalized as render } from "./language-harness";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_REVIEW_START } from "../src/activity-review/controller";
import { RIDE_REVIEW_NONE, type RideReviewState } from "../src/activity-review/review-controller";
import type { ActivityReviewRead } from "../src/activity-review/rides";
import type { ActivityReviewActions } from "../src/state/activity-review-slice";
import { useEnduragentStore } from "../src/state/store";
import { ActivityReviewView } from "../src/ui/activity-review/ActivityReviewView";
import { planWorkout, ride, rideId, rides } from "./activity-review-fixture";

const THRESHOLD = planWorkout(2, 19980819, "Threshold 4×8", 4_800);
const WRITTEN_AT = new Date(1998, 7, 19, 7, 58).getTime();

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
    writeAgain: vi.fn(),
    saveNote: vi.fn(),
    askCoach: vi.fn(),
  };
}

function matched(): ActivityReviewRead {
  return rides([
    ride("b", 19980819, {
      name: "Threshold 4×8",
      durationS: 4_440,
      match: { kind: "confirmed", ...THRESHOLD, outcome: "done-differently", by: "you" },
    }),
  ]);
}

function kept(patch: Partial<Extract<PlanCalendarVerdict, { state: "kept" }>> = {}) {
  return {
    state: "kept" as const,
    text: "Three reps on target and the fourth stopped at 6 minutes.",
    writtenAtMs: WRITTEN_AT,
    trigger: "opened" as const,
    usedPlan: true,
    usedNote: false,
    marker: { kind: "current" as const },
    ...patch,
  };
}

function reviewed(
  patch: Partial<PlanCalendarRideReview> = {},
  extra: Partial<Extract<RideReviewState, { kind: "ready" }>> = {},
): RideReviewState {
  return {
    kind: "ready",
    activityId: rideId("b"),
    review: {
      activityId: rideId("b"),
      verdict: kept(),
      replies: 1,
      blocked: "none",
      note: null,
      ...patch,
    },
    asking: "idle",
    note: "idle",
    ...extra,
  };
}

function show(review: RideReviewState, read = matched(), bound = actions()): ActivityReviewActions {
  act(() => {
    useEnduragentStore.setState({
      activityReview: {
        kind: "ready",
        read,
        selectedId: null,
        refresh: "idle",
        choices: "closed",
        saving: "idle",
      },
      activityReviewActions: bound,
      rideReview: review,
    });
  });
  return bound;
}

function verdict(): HTMLElement {
  return screen.getByRole("region", { name: "Coach’s verdict" });
}

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      activityReview: ACTIVITY_REVIEW_START,
      activityReviewActions: null,
      rideReview: RIDE_REVIEW_NONE,
    });
  });
});

describe("the coach's verdict on Activity review", () => {
  it("shows the kept verdict with what it was written from, and writes again on request", async () => {
    const user = userEvent.setup();
    const bound = show(reviewed());
    render(<ActivityReviewView />);
    const section = verdict();
    expect(within(section).getByText("Coach’s verdict")).toBeInTheDocument();
    expect(section).toHaveTextContent("Three reps on target and the fourth stopped at 6 minutes.");
    expect(section).toHaveTextContent(
      "Written at 7:58 AM, when you first opened this ride, from its file and your Plan · 1 coach reply · kept",
    );
    await user.click(within(section).getByRole("button", { name: "Write again · 1 reply" }));
    expect(bound.writeAgain).toHaveBeenCalledOnce();
  });

  it("says which match a kept verdict was written before, until Write again", () => {
    show(reviewed({ verdict: kept({ marker: { kind: "matched-to", name: "Easy endurance" } }) }));
    const view = render(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent(
      "Written before you matched this ride to Easy endurance · 1 coach reply · kept",
    );
    show(reviewed({ verdict: kept({ marker: { kind: "matched-extra" } }) }));
    view.rerender(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent("Written before you matched this ride to Extra");
  });

  it("keeps the meta line short for a ride with no Plan", () => {
    show(
      reviewed({ verdict: kept({ usedPlan: false }) }),
      rides([ride("b", 19980819, { name: "Café ride" })], null),
    );
    render(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent("Written at 7:58 AM · 1 coach reply");
    expect(verdict()).not.toHaveTextContent("kept");
  });

  it("names the note and the reply count when the athlete asked again", () => {
    show(reviewed({ verdict: kept({ trigger: "asked", usedNote: true }), replies: 2 }));
    render(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent(
      "Written at 7:58 AM, when you asked again, from its file, your Plan and your note · 2 coach replies · kept",
    );
  });

  it("shows writing, an honest failure with Write again, and no button while it writes", async () => {
    const user = userEvent.setup();
    const bound = show(reviewed({ verdict: { state: "writing" } }));
    const view = render(<ActivityReviewView />);
    expect(within(verdict()).getByRole("status")).toHaveTextContent("Writing the coach’s verdict…");
    expect(within(verdict()).queryByRole("button")).toBeNull();
    show(
      reviewed({ verdict: { state: "failed", failedBy: "model", earlier: null } }),
      matched(),
      bound,
    );
    view.rerender(<ActivityReviewView />);
    expect(within(verdict()).getByRole("alert")).toHaveTextContent(
      "The coach could not write its verdict this time, so nothing was kept.",
    );
    expect(verdict().querySelector("[data-earlier-verdict]")).toBeNull();
    await user.click(within(verdict()).getByRole("button", { name: "Write again · 1 reply" }));
    expect(bound.writeAgain).toHaveBeenCalledOnce();
  });

  it("dates the meta line when it was written on another day, with the year only when it differs", () => {
    show(reviewed({ verdict: kept({ writtenAtMs: new Date(1998, 7, 26, 10, 22).getTime() }) }));
    const view = render(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent(
      "Written on Wed 26 Aug at 10:22 AM, when you first opened this ride, from its file and your Plan · 1 coach reply · kept",
    );
    show(
      reviewed({
        verdict: kept({
          writtenAtMs: new Date(1998, 7, 26, 10, 22).getTime(),
          trigger: "asked",
          usedNote: true,
        }),
        replies: 2,
      }),
      rides(matched().rides, { weeks: 4 }, 19990110),
    );
    view.rerender(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent(
      "Written on Wed 26 Aug 1998 at 10:22 AM, when you asked again, from its file, your Plan and your note · 2 coach replies · kept",
    );
  });

  it("keeps the earlier verdict under the failure line when Write again fails", async () => {
    const user = userEvent.setup();
    const earlier = {
      text: "Three reps on target and the fourth stopped at 6 minutes.",
      writtenAtMs: WRITTEN_AT,
      trigger: "opened" as const,
      usedPlan: true,
      usedNote: false,
      marker: { kind: "current" as const },
      replies: 1,
    };
    const bound = show(
      reviewed({ verdict: { state: "failed", failedBy: "model", earlier }, replies: 2 }),
    );
    const view = render(<ActivityReviewView />);
    const section = verdict();
    expect(within(section).getByRole("alert")).toHaveTextContent(
      "The coach could not write a new verdict this time, so the earlier one stays.",
    );
    expect(section).not.toHaveTextContent("so nothing was kept");
    const kept = section.querySelector("[data-earlier-verdict]");
    expect(kept).toHaveTextContent("Three reps on target and the fourth stopped at 6 minutes.");
    expect(kept).toHaveTextContent(
      "Written at 7:58 AM, when you first opened this ride, from its file and your Plan · 1 coach reply · kept",
    );
    expect(section.textContent?.indexOf("could not write a new verdict")).toBeLessThan(
      section.textContent?.indexOf("Three reps") ?? 0,
    );
    await user.click(within(section).getByRole("button", { name: "Write again · 1 reply" }));
    expect(bound.writeAgain).toHaveBeenCalledOnce();
    show(
      reviewed({
        verdict: {
          state: "failed",
          failedBy: "model",
          earlier: { ...earlier, marker: { kind: "matched-to", name: "Easy endurance" } },
        },
        replies: 2,
      }),
      matched(),
      bound,
    );
    view.rerender(<ActivityReviewView />);
    expect(verdict().querySelector("[data-earlier-verdict]")).toHaveTextContent(
      "Written before you matched this ride to Easy endurance · 1 coach reply · kept",
    );
  });

  it("says why there is no verdict when no model is set up or the ride has no file", () => {
    show(reviewed({ verdict: { state: "not-written" }, replies: 0, blocked: "no-model" }));
    const view = render(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent(
      "The coach writes its verdict on your own model, and none is set up yet. Choose one in Settings, then open this ride again.",
    );
    show(reviewed({ verdict: { state: "not-written" }, replies: 0, blocked: "no-file" }));
    view.rerender(<ActivityReviewView />);
    expect(verdict()).toHaveTextContent(
      "This ride has only a time and a distance, with no power or heart rate from a file, so the coach writes no verdict for it.",
    );
    expect(within(verdict()).queryByRole("button")).toBeNull();
  });

  it("says the verdict comes after the athlete answers the match", () => {
    const easy = planWorkout(1, 19980820, "Easy endurance");
    show(
      reviewed({ verdict: { state: "not-written" }, replies: 0, blocked: "waiting-for-match" }),
      rides([ride("b", 19980820, { match: { kind: "suggested", ...easy } })]),
    );
    render(<ActivityReviewView />);
    expect(
      screen.getByText(
        "The coach writes its verdict after you answer: one reply on your own model.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Coach’s verdict" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask the coach about this ride" })).toBeNull();
  });

  it("saves the athlete's note without touching the verdict", async () => {
    const user = userEvent.setup();
    const bound = show(reviewed());
    const view = render(<ActivityReviewView />);
    const note = screen.getByRole("textbox", { name: "Your note" });
    expect(note).toHaveAccessibleDescription(
      "Your note goes to the coach with this ride. Saving it does not rewrite the verdict unless you ask.",
    );
    const save = screen.getByRole("button", { name: "Save note" });
    expect(save).toBeDisabled();
    await user.type(note, "Legs heavy after Tuesday.");
    await user.click(save);
    expect(bound.saveNote).toHaveBeenCalledWith("Legs heavy after Tuesday.");
    expect(bound.writeAgain).not.toHaveBeenCalled();
    show(
      reviewed(
        { note: { text: "Legs heavy after Tuesday.", savedAtMs: WRITTEN_AT } },
        { note: "saved" },
      ),
      matched(),
      bound,
    );
    view.rerender(<ActivityReviewView />);
    expect(screen.getByText("Note saved.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Your note" })).toHaveValue(
      "Legs heavy after Tuesday.",
    );
  });

  it("clears Note saved as soon as the athlete edits the note again", async () => {
    const user = userEvent.setup();
    show(
      reviewed(
        { note: { text: "Legs heavy after Tuesday.", savedAtMs: WRITTEN_AT } },
        { note: "saved" },
      ),
    );
    render(<ActivityReviewView />);
    expect(screen.getByText("Note saved.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Your note" }), " And tired.");
    expect(screen.queryByText("Note saved.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled();
  });

  it("picks up a note saved elsewhere unless the athlete has unsaved edits", async () => {
    const user = userEvent.setup();
    const bound = show(reviewed({ note: { text: "First note.", savedAtMs: WRITTEN_AT } }));
    const view = render(<ActivityReviewView />);
    const note = () => screen.getByRole("textbox", { name: "Your note" });
    expect(note()).toHaveValue("First note.");
    show(
      reviewed({ note: { text: "Saved in another window.", savedAtMs: WRITTEN_AT + 1 } }),
      matched(),
      bound,
    );
    view.rerender(<ActivityReviewView />);
    expect(note()).toHaveValue("Saved in another window.");
    await user.clear(note());
    await user.type(note(), "My unsaved edit.");
    show(
      reviewed({ note: { text: "Saved again elsewhere.", savedAtMs: WRITTEN_AT + 2 } }),
      matched(),
      bound,
    );
    view.rerender(<ActivityReviewView />);
    expect(note()).toHaveValue("My unsaved edit.");
  });

  it("asks the coach about the ride with a draft that names it", async () => {
    const user = userEvent.setup();
    const bound = show(reviewed());
    render(<ActivityReviewView />);
    await user.click(screen.getByRole("button", { name: "Ask the coach about this ride" }));
    expect(bound.askCoach).toHaveBeenCalledWith(
      "What do you make of my ride “Threshold 4×8” on Wed 19 Aug?",
    );
  });
});
