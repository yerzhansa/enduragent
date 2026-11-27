import { renderLocalized as render } from "./language-harness";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANGE_SHEET_CLOSED,
  type ChangeDetail,
  type ChangeSheetState,
} from "../src/calendar/change-controller";
import { CALENDAR_START } from "../src/calendar/controller";
import type { CalendarChangeActions } from "../src/state/calendar-change-slice";
import { useEnduragentStore } from "../src/state/store";
import { CalendarView } from "../src/ui/calendar/CalendarView";
import { calendarRead, PLAN_ID, plan, week, workout, workoutId } from "./calendar-fixture";

const MONDAY = 19980112;
const TODAY = 19980113;

function changedPlan() {
  return calendarRead(
    TODAY,
    plan(
      MONDAY,
      [week(1, MONDAY, { plannedS: 14_400 })],
      [
        workout(1, 19980114, {
          copy: {
            kind: "changed-in-intervals",
            change: "edited",
            toDateKey: null,
            name: "Endurance 1",
            durationS: 2_700,
          },
        }),
        workout(2, 19980115, {
          name: "Over-unders",
          durationS: 4_800,
          copy: {
            kind: "changed-in-intervals",
            change: "moved",
            toDateKey: 19980116,
            name: "Over-unders",
            durationS: 4_800,
          },
        }),
        workout(3, 19980117, {
          name: "Long endurance",
          durationS: 9_900,
          copy: {
            kind: "changed-in-intervals",
            change: "deleted",
            toDateKey: null,
            name: null,
            durationS: null,
          },
        }),
        workout(4, 19980118),
      ],
    ),
  );
}

function actions(): CalendarChangeActions {
  return { open: vi.fn(), keep: vi.fn(), putBack: vi.fn(), close: vi.fn() };
}

function show(change: ChangeSheetState = CHANGE_SHEET_CLOSED, bound = actions()) {
  act(() => {
    useEnduragentStore.setState({
      calendar: {
        kind: "ready",
        read: changedPlan(),
        range: { firstRowStart: MONDAY, rowCount: 2 },
        refresh: "idle",
      },
      calendarChange: change,
      calendarChangeActions: bound,
    });
  });
  return bound;
}

function detail(extra: Partial<ChangeDetail>): ChangeDetail {
  return {
    status: "change-detail",
    planWorkoutId: workoutId(1),
    basis: "1@19980114:seen",
    change: "edited",
    plan: { dateKey: 19980114, name: "Endurance 1", durationS: 3_600, description: null },
    intervals: { dateKey: 19980114, name: "Endurance 1", durationS: 2_700, description: null },
    editedAt: "1998-01-13T21:10:00.000Z",
    ...extra,
  };
}

const cell = (dateKey: number) => {
  const found = document.querySelector<HTMLElement>(`[data-date-key="${dateKey}"]`);
  if (found === null) throw new Error(`No day ${dateKey}`);
  return found;
};

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      calendar: CALENDAR_START,
      calendarActions: null,
      calendarChange: CHANGE_SHEET_CLOSED,
      calendarChangeActions: null,
    });
  });
});

describe("workouts changed in intervals.icu on the Calendar", () => {
  it("says what changed on each card and in one banner, and opens a card's choice", async () => {
    const user = userEvent.setup();
    const bound = show();
    render(<CalendarView />);
    const banner = document.querySelector("[data-intervals-changes]");
    expect(banner).toHaveTextContent(
      "3 workouts were changed in intervals.icu: 1 edited, 1 moved, 1 deleted. The Plan and intervals.icu stay as they are until you choose.",
    );
    const edited = within(cell(19980114)).getByRole("button", { name: /Endurance 1/u });
    expect(edited).toHaveTextContent("45m here, 1h 0m in PlanChanged in intervals.icu");
    expect(within(cell(19980115)).queryByRole("button")).toBeNull();
    expect(cell(19980115)).toHaveTextContent("Over-undersMoved to Fri 16 Jan in intervals.icu");
    const movedIn = within(cell(19980116)).getByRole("button", { name: /Over-unders/u });
    expect(movedIn).toHaveTextContent("1h 20m · from Thu 15Moved in intervals.icu");
    const deleted = within(cell(19980117)).getByRole("button", { name: /Long endurance/u });
    expect(deleted).toHaveTextContent("Long endurance2h 45mDeleted in intervals.icu");
    expect(cell(19980116)).not.toHaveTextContent("Rest day");
    expect(within(cell(19980118)).queryByRole("button")).toBeNull();
    await user.click(edited);
    await user.click(movedIn);
    await user.click(deleted);
    expect(bound.open).toHaveBeenNthCalledWith(1, PLAN_ID, workoutId(1));
    expect(bound.open).toHaveBeenNthCalledWith(2, PLAN_ID, workoutId(2));
    expect(bound.open).toHaveBeenNthCalledWith(3, PLAN_ID, workoutId(3));
  });

  it("compares an edit side by side and offers Keep and Put back with their lengths", async () => {
    const user = userEvent.setup();
    const bound = show({ kind: "open", planId: PLAN_ID, detail: detail({}) });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", {
      name: "You changed this workout in intervals.icu",
    });
    expect(within(sheet).getByRole("heading", { level: 2 })).toHaveFocus();
    expect(sheet).toHaveTextContent("Wed 14 Jan · Endurance 1");
    const table = within(sheet).getByRole("table");
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) => row.textContent?.replaceAll("\u00a0", " ")),
    ).toEqual([
      "In your PlanIn intervals.icu now",
      "DayWed 14 JanWed 14 Jan",
      "NameEndurance 1Endurance 1",
      "Length1h 0m45m",
    ]);
    expect(table.querySelectorAll("[data-changed]")).toHaveLength(1);
    expect(sheet).toHaveTextContent("The Plan takes 45m for Wed 14 Jan. The week drops to 3h 45m.");
    expect(sheet).toHaveTextContent("intervals.icu goes back to 1h 0m.");
    await user.click(within(sheet).getByRole("button", { name: "Keep 45m" }));
    await user.click(within(sheet).getByRole("button", { name: /^Put back 1h\s0m$/u }));
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(bound.keep).toHaveBeenCalledOnce();
    expect(bound.putBack).toHaveBeenCalledOnce();
    expect(bound.close).toHaveBeenCalledOnce();
  });

  it("offers Keep it deleted and Put it back for a delete, with no comparison", () => {
    show({
      kind: "open",
      planId: PLAN_ID,
      detail: detail({
        planWorkoutId: workoutId(3),
        change: "deleted",
        plan: { dateKey: 19980117, name: "Long endurance", durationS: 9_900, description: null },
        intervals: null,
        editedAt: null,
      }),
    });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", {
      name: "You deleted this workout in intervals.icu",
    });
    expect(sheet).toHaveTextContent("Sat 17 Jan · Long endurance · 2h 45m");
    expect(within(sheet).queryByRole("table")).toBeNull();
    expect(sheet).toHaveTextContent(
      "The Plan marks Sat 17 Jan “Removed by you”. The week drops to 1h 15m.",
    );
    expect(sheet).toHaveTextContent(
      "Long endurance 2h 45m goes back to Sat 17 Jan on intervals.icu, so your head unit gets it.",
    );
    expect(within(sheet).getByRole("button", { name: "Keep it deleted" })).toBeEnabled();
    expect(within(sheet).getByRole("button", { name: "Put it back" })).toBeEnabled();
  });

  it("names both days for a move, and locks both choices while one is saved", () => {
    show({
      kind: "working",
      planId: PLAN_ID,
      choice: "keep",
      detail: detail({
        planWorkoutId: workoutId(2),
        change: "moved",
        plan: { dateKey: 19980115, name: "Over-unders", durationS: 4_800, description: null },
        intervals: { dateKey: 19980116, name: "Over-unders", durationS: 4_800, description: null },
      }),
    });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", {
      name: "You moved this workout in intervals.icu",
    });
    expect(within(sheet).getByRole("button", { name: "Keep Fri 16 Jan" })).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Put back to Thu 15 Jan" })).toBeDisabled();
    expect(sheet).toHaveTextContent("The Plan follows intervals.icu and moves it to Fri 16 Jan.");
  });

  it("says nothing changed when intervals.icu does not answer or the Plan refuses", () => {
    show({ kind: "failed", planId: PLAN_ID, detail: detail({}), reason: "unavailable" });
    const { unmount } = render(<CalendarView />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "intervals.icu did not answer, so nothing changed. Try again.",
    );
    unmount();
    show({ kind: "failed", planId: PLAN_ID, detail: detail({}), reason: "refused" });
    render(<CalendarView />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The Plan could not take this change, so nothing changed.",
    );
  });

  it("shows a reading state and a could-not-read state before the choice", () => {
    show({ kind: "loading", planId: PLAN_ID, planWorkoutId: workoutId(1) });
    const { unmount } = render(<CalendarView />);
    const reading = screen.getByRole("complementary", { name: "Changed in intervals.icu" });
    expect(reading).toHaveAttribute("aria-busy", "true");
    expect(within(reading).getByRole("status")).toHaveTextContent(
      "Reading the workout from intervals.icu…",
    );
    unmount();
    show({ kind: "unavailable", planId: PLAN_ID, planWorkoutId: workoutId(1) });
    render(<CalendarView />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "intervals.icu did not answer, so the workout could not be read. Nothing changed.",
    );
  });
});
