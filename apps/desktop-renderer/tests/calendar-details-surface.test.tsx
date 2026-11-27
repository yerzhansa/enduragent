import { renderLocalized as render } from "./language-harness";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_START } from "../src/calendar/controller";
import {
  DETAILS_SHEET_CLOSED,
  type DetailsSheetState,
  type PlanDetails,
} from "../src/calendar/details-controller";
import type { CalendarDetailsActions } from "../src/state/calendar-details-slice";
import { useEnduragentStore } from "../src/state/store";
import { CalendarView } from "../src/ui/calendar/CalendarView";
import { calendarRead, PLAN_ID, plan, week, workout, workoutId } from "./calendar-fixture";

const MONDAY = 19980105;
const TODAY = 19980114;

function read() {
  return calendarRead(
    TODAY,
    plan(
      MONDAY,
      [
        week(1, MONDAY, { phase: "Base" }),
        week(2, 19980112, { phase: "Base" }),
        week(3, 19980119, { phase: "Build" }),
      ],
      [
        workout(1, 19980106, {
          outcome: { kind: "done-as-planned", activityId: "a".repeat(64), actualDurationS: 3_600 },
        }),
        workout(2, 19980108, { outcome: { kind: "missed" } }),
        workout(3, 19980113, {
          outcome: { kind: "is-this-it", matchId: "m", activityId: "b".repeat(64) },
        }),
        workout(4, 19980116),
      ],
      { name: "Synthetic base", targetDateKey: 19980125 },
    ),
  );
}

const DETAILS: PlanDetails = {
  status: "plan-details",
  planId: PLAN_ID,
  version: 2,
  history: [
    {
      kind: "moved",
      atMs: Date.UTC(1998, 0, 13, 12),
      name: "Endurance 4",
      fromDateKey: 19980115,
      toDateKey: 19980116,
    },
    { kind: "kept", atMs: Date.UTC(1998, 0, 12, 12), dateKey: 19980117, durationS: 2_700 },
    { kind: "change", atMs: Date.UTC(1998, 0, 9, 12), title: "Week 2 eased after a cold" },
    { kind: "saved", atMs: Date.UTC(1998, 0, 4, 12) },
  ],
  ending: {
    removes: [
      { planWorkoutId: workoutId(4), name: "Endurance 4", dateKey: 19980116, durationS: 3_600 },
    ],
    staysToday: [
      { planWorkoutId: workoutId(5), name: "Recovery spin", dateKey: TODAY, durationS: 2_700 },
    ],
    athleteChanges: [
      {
        planWorkoutId: workoutId(6),
        name: "Long ride",
        dateKey: 19980117,
        durationS: 2_700,
        tick: { planWorkoutId: workoutId(6), eventId: 9, dateKey: 19980117, fingerprint: "seen" },
      },
    ],
  },
};

function show(details: DetailsSheetState = DETAILS_SHEET_CLOSED) {
  const actions: CalendarDetailsActions = {
    open: vi.fn(),
    close: vi.fn(),
    startEnd: vi.fn(),
    setRemoveChanges: vi.fn(),
    cancelEnd: vi.fn(),
    confirmEnd: vi.fn(),
    replace: vi.fn(),
  };
  act(() => {
    useEnduragentStore.setState({
      calendar: {
        kind: "ready",
        read: read(),
        range: { firstRowStart: MONDAY, rowCount: 3 },
        refresh: "idle",
      },
      calendarDetails: details,
      calendarDetailsActions: actions,
    });
  });
  return actions;
}

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      calendar: CALENDAR_START,
      calendarDetails: DETAILS_SHEET_CLOSED,
      calendarDetailsActions: null,
    });
  });
});

describe("the Plan details sheet", () => {
  it("opens from the Calendar header", async () => {
    const user = userEvent.setup();
    const actions = show();
    render(<CalendarView />);
    await user.click(screen.getByRole("button", { name: "Plan details" }));
    expect(actions.open).toHaveBeenCalledWith(PLAN_ID);
  });

  it("shows the Plan, its progress, its history, and Replace and End", async () => {
    const user = userEvent.setup();
    const actions = show({ kind: "open", details: DETAILS, end: null });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", { name: "Plan details" });
    expect(sheet).toHaveTextContent("PlanSynthetic base · 3 Training Weeks");
    expect(sheet).toHaveTextContent("DatesMon 5 Jan to Sun 25 Jan");
    expect(sheet).toHaveTextContent("RaceSun 25 Jan");
    expect(sheet).toHaveTextContent("PhasesBase 1–2 · Build 3");
    expect(sheet).toHaveTextContent(
      "1 of 3 Training Weeks done. 1 of 3 workouts done or done differently, 1 missed, 1 to confirm.",
    );
    expect(sheet).toHaveTextContent(
      "When you activate it, the old Plan’s workouts from tomorrow on come off intervals.icu, and nothing from the new Plan goes on until you approve its first two Training Weeks.",
    );
    const history = within(sheet)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(history).toEqual([
      "13 JanEndurance 4 moved by you from Thu 15 to Fri 16",
      "12 JanSat 17 changed in intervals.icu; you kept 45m",
      "9 JanPlan Change: Week 2 eased after a cold",
      "4 JanPlan saved",
    ]);
    await user.click(within(sheet).getByRole("button", { name: "Replace Plan" }));
    await user.click(within(sheet).getByRole("button", { name: "End Plan" }));
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(actions.replace).toHaveBeenCalledOnce();
    expect(actions.startEnd).toHaveBeenCalledOnce();
    expect(actions.close).toHaveBeenCalledOnce();
  });

  it("asks before ending, keeps the athlete's changes unless ticked, and keeps today's workout", async () => {
    const user = userEvent.setup();
    const actions = show({
      kind: "open",
      details: DETAILS,
      end: { kind: "idle", removeChanges: false, commandId: "end-1" },
    });
    render(<CalendarView />);
    const confirm = screen.getByRole("region", { name: "End the Plan?" });
    expect(confirm).toHaveTextContent(
      "Removes 1 workout from tomorrow on. Today’s Recovery spin stays on intervals.icu.",
    );
    expect(confirm).toHaveTextContent("1 you changed in intervals.icu stays, as your own:");
    expect(confirm).toHaveTextContent("Sat 17 · Long ride · 45m");
    const box = within(confirm).getByRole("checkbox", { name: "Remove that one too" });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(actions.setRemoveChanges).toHaveBeenCalledWith(true);
    await user.click(within(confirm).getByRole("button", { name: "End Plan" }));
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(actions.confirmEnd).toHaveBeenCalledOnce();
    expect(actions.cancelEnd).toHaveBeenCalledOnce();
  });

  it.each([
    ["changed", "The Plan changed meanwhile, so it was not ended. Open Plan details again."],
    ["unconfirmed", "The app did not answer, so ending could not be confirmed. Try again."],
  ] as const)("says what happened when ending fails (%s)", (reason, message) => {
    show({
      kind: "open",
      details: DETAILS,
      end: { kind: "failed", reason, removeChanges: true, commandId: "end-1" },
    });
    render(<CalendarView />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    const box = screen.getByRole("checkbox", { name: "Remove that one too" });
    if (reason === "unconfirmed") expect(box).toBeDisabled();
    else expect(box).toBeEnabled();
  });

  it("locks Replace, Close and the header button while the Plan is ending", () => {
    show({
      kind: "open",
      details: DETAILS,
      end: { kind: "ending", removeChanges: false, commandId: "end-1" },
    });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", { name: "Plan details" });
    expect(within(sheet).getByRole("button", { name: "Replace Plan" })).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Plan details" })[0]).toBeDisabled();
  });
});
