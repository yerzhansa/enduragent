import { renderLocalized as render } from "./language-harness";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_START, type CalendarViewState } from "../src/calendar/controller";
import type { CalendarActions } from "../src/state/calendar-slice";
import { useEnduragentStore } from "../src/state/store";
import { CalendarView } from "../src/ui/calendar/CalendarView";
import { activity, calendarRead, plan, week, workout } from "./calendar-fixture";

const MONDAY = 19980105;
const TODAY = 19980114;

function actions(): CalendarActions {
  return {
    refresh: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    today: vi.fn(),
    showWeekOf: vi.fn(),
  };
}

function show(state: CalendarViewState, bound = actions()): CalendarActions {
  act(() => {
    useEnduragentStore.setState({ calendar: state, calendarActions: bound });
  });
  return bound;
}

function runningPlan() {
  const weeks = [
    week(1, MONDAY, { doneS: 5_280, toConfirm: 1, status: { kind: "passed" } }),
    week(2, 19980112),
    week(3, 19980119, { status: { kind: "goes-out", onDateKey: 19980112 } }),
    week(4, 19980126, { status: { kind: "waiting-for-first-approve" } }),
  ];
  const workouts = [
    workout(1, MONDAY, {
      outcome: { kind: "done-as-planned", activityId: "a".repeat(64), actualDurationS: 3_700 },
    }),
    workout(2, 19980107, {
      outcome: { kind: "done-differently", activityId: "b".repeat(64), actualDurationS: 2_520 },
    }),
    workout(3, 19980110, {
      outcome: { kind: "is-this-it", matchId: "m", activityId: "c".repeat(64) },
    }),
    workout(4, 19980112, { outcome: { kind: "missed" } }),
    workout(5, TODAY),
    workout(6, 19980116, {
      copy: {
        kind: "changed-in-intervals",
        change: "edited",
        toDateKey: null,
        name: "Endurance 6",
        durationS: 2_700,
      },
    }),
    workout(7, 19980121, { copy: { kind: "plan-only" } }),
  ];
  return calendarRead(
    TODAY,
    plan(MONDAY, weeks, workouts, { currentWeek: 2, targetDateKey: 19980201 }),
    [activity("c", 19980110, { durationS: 5_400 }), activity("d", 19980106, { name: "Café ride" })],
  );
}

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({ calendar: CALENDAR_START, calendarActions: null });
  });
});

describe("the Calendar page", () => {
  it("shows each Training Week with its totals, status and workout outcomes", () => {
    show({
      kind: "ready",
      read: runningPlan(),
      range: { firstRowStart: MONDAY, rowCount: 4 },
      refresh: "idle",
    });
    render(<CalendarView />);
    expect(screen.getByText("Synthetic base · Training Week 2 of 4")).toBeInTheDocument();
    const [first, second, third, fourth] = screen.getAllByRole("rowheader");
    expect(first).toHaveTextContent("Week 1");
    expect(first).toHaveTextContent("1h 28m of 3h 25m");
    expect(first).toHaveTextContent("1 ride to confirm");
    expect(second).toHaveTextContent("0m of 3h 25m");
    expect(third).toHaveTextContent("3h 25m · Plan only");
    expect(third).toHaveTextContent("Goes out");
    expect(fourth).toHaveTextContent("Waiting for Approve");
    const cell = (dateKey: number) => document.querySelector(`[data-date-key="${dateKey}"]`);
    expect(cell(MONDAY)).toHaveTextContent("1h 2m of 1h 0mDone as planned");
    expect(cell(19980107)).toHaveTextContent("42m of 1h 0mDone differently");
    expect(cell(19980110)).toHaveTextContent("A 1h 30m ride syncedIs this it?");
    expect(cell(19980112)).toHaveTextContent("1h 0m · no ActivityMissed");
    expect(cell(TODAY)).toHaveTextContent("14 · Today");
    expect(cell(19980116)).toHaveTextContent("Changed in intervals.icu");
    expect(cell(19980106)).toHaveTextContent("Café ride1h 5m · 32 kmExtra");
    expect(cell(19980108)).toHaveTextContent("Rest day");
    expect(cell(19980121)?.querySelector('[data-copy="plan-only"]')).not.toBeNull();
    expect(screen.getByText("Race 1 Feb")).toBeInTheDocument();
  });

  it("moves through weeks and jumps to a season week", async () => {
    const user = userEvent.setup();
    const bound = show({
      kind: "ready",
      read: runningPlan(),
      range: { firstRowStart: MONDAY, rowCount: 4 },
      refresh: "idle",
    });
    render(<CalendarView />);
    await user.click(screen.getByRole("button", { name: "Previous week" }));
    await user.click(screen.getByRole("button", { name: "Next week" }));
    await user.click(screen.getByRole("button", { name: "Today" }));
    await user.click(screen.getByRole("button", { name: /^Week 4,/u }));
    expect(bound.previous).toHaveBeenCalledOnce();
    expect(bound.next).toHaveBeenCalledOnce();
    expect(bound.today).toHaveBeenCalledOnce();
    expect(bound.showWeekOf).toHaveBeenCalledWith(19980126);
  });

  it("offers Chat when there is no Plan and lists Activities by date", () => {
    show({
      kind: "ready",
      read: calendarRead(TODAY, null, [activity("a", 19980112)]),
      range: { firstRowStart: MONDAY, rowCount: 4 },
      refresh: "idle",
    });
    render(<CalendarView />);
    expect(screen.getByText("No Plan · your Activities from intervals.icu")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No Plan yet" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Week" })).toBeInTheDocument();
    const rows = screen.getAllByRole("rowheader");
    expect(rows[1]).toHaveTextContent("12–18 Jan1h 5m so farLoad 60");
    expect(rows[2]).toHaveTextContent("Nothing planned");
  });

  it("keeps the calendar when a refresh fails and offers to try again", async () => {
    const user = userEvent.setup();
    const bound = show({
      kind: "ready",
      read: runningPlan(),
      range: { firstRowStart: MONDAY, rowCount: 4 },
      refresh: "failed",
    });
    render(<CalendarView />);
    const status = screen
      .getAllByRole("status")
      .find((element) => element.textContent?.includes("The calendar could not refresh."));
    if (status === undefined) throw new Error("Expected the refresh notice");
    await user.click(within(status).getByRole("button", { name: "Try again" }));
    expect(bound.refresh).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("rowheader")).toHaveLength(4);
  });

  it("says when the calendar could not load", () => {
    show({ kind: "unavailable", range: null });
    render(<CalendarView />);
    expect(screen.getByRole("alert")).toHaveTextContent("The calendar could not load.");
  });

  it("gives each Training Week its totals and status when rows cross weeks", () => {
    const thursday = 19980108;
    const weeks = [
      week(1, thursday, { status: { kind: "passed" }, doneS: 1_800 }),
      week(2, 19980115, { status: { kind: "waiting-for-first-approve" } }),
      week(3, 19980122, { status: { kind: "goes-out", onDateKey: 19980115 } }),
    ];
    show({
      kind: "ready",
      read: calendarRead(19980116, plan(thursday, weeks, []), []),
      range: { firstRowStart: MONDAY, rowCount: 4 },
      refresh: "idle",
    });
    render(<CalendarView />);
    const [first, second, third, fourth] = screen.getAllByRole("rowheader");
    expect(first).toHaveTextContent("Week 1starts Thu 8 Jan30m of 3h 25m");
    expect(second).toHaveTextContent(
      "Week 1 → 2Week 2 starts Thu 15 Jan0m of 3h 25mWaiting for Approve",
    );
    expect(third).toHaveTextContent(
      "Week 2 → 3Week 3 starts Thu 22 Jan3h 25m · Plan onlyGoes out Thu 15 Jan",
    );
    expect(fourth).toHaveTextContent("Week 3until Wed 28 Jan");
  });

  it("says when intervals.icu is not connected instead of a send day", () => {
    const weeks = [
      week(1, MONDAY, { status: { kind: "due" } }),
      week(2, 19980112, { status: { kind: "goes-out", onDateKey: 19980105 } }),
    ];
    show({
      kind: "ready",
      read: { ...calendarRead(19980107, plan(MONDAY, weeks, [])), calendarConnected: false },
      range: { firstRowStart: MONDAY, rowCount: 2 },
      refresh: "idle",
    });
    render(<CalendarView />);
    const [first, second] = screen.getAllByRole("rowheader");
    expect(first).toHaveTextContent("intervals.icu is not connected");
    expect(second).toHaveTextContent("3h 25m · Plan onlyintervals.icu is not connected");
  });

  it("shows moved, removed, not synced, not sent and intervals.icu changes over Missed", () => {
    const workouts = [
      workout(1, MONDAY, {
        outcome: { kind: "moved", activityId: "a".repeat(64), toDateKey: 19980106 },
      }),
      workout(2, 19980106, { outcome: { kind: "removed-by-you" } }),
      workout(3, 19980107, { outcome: { kind: "not-synced-yet" } }),
      workout(4, 19980108, { copy: { kind: "plan-only" }, lastWrite: "failed" }),
      workout(5, 19980109, {
        outcome: { kind: "missed" },
        copy: {
          kind: "changed-in-intervals",
          change: "deleted",
          toDateKey: null,
          name: null,
          durationS: null,
        },
      }),
      workout(6, 19980110, { outcome: { kind: "missed" }, durationS: null }),
    ];
    show({
      kind: "ready",
      read: calendarRead(19980108, plan(MONDAY, [week(1, MONDAY)], workouts), [
        activity("b", 19980111, { name: null }),
      ]),
      range: { firstRowStart: MONDAY, rowCount: 1 },
      refresh: "idle",
    });
    render(<CalendarView />);
    const cell = (dateKey: number) => document.querySelector(`[data-date-key="${dateKey}"]`);
    expect(cell(MONDAY)).toHaveTextContent("Moved to Tue 6 Jan");
    expect(cell(19980106)).toHaveTextContent("Removed by you");
    expect(cell(19980107)).toHaveTextContent("Not synced yet");
    expect(cell(19980108)).toHaveTextContent("Not sent: intervals.icu did not answer");
    expect(cell(19980109)).toHaveTextContent("Deleted in intervals.icu");
    expect(cell(19980109)).not.toHaveTextContent("Missed");
    expect(cell(19980110)).toHaveTextContent("Endurance 6No ActivityMissed");
    expect(cell(19980111)).toHaveTextContent("Ride");
  });
});
