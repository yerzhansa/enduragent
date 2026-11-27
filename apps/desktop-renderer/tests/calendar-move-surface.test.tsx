import { renderLocalized as render } from "./language-harness";
import type { PlanCalendarWeek, PlanCalendarWorkout } from "@enduragent/coach-contract";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_START } from "../src/calendar/controller";
import { MOVE_DIALOG_CLOSED, type MoveDialogState } from "../src/calendar/move-controller";
import type { CalendarMoveActions } from "../src/state/calendar-move-slice";
import { useEnduragentStore } from "../src/state/store";
import { CalendarView } from "../src/ui/calendar/CalendarView";
import { calendarRead, PLAN_ID, plan, week, workout, workoutId } from "./calendar-fixture";

const MONDAY = 19980112;
const TODAY = 19980113;

function read(recovery: Partial<PlanCalendarWorkout> = {}) {
  return calendarRead(
    TODAY,
    plan(
      MONDAY,
      [week(1, MONDAY, { plannedS: 9_900 }), week(2, 19980119, { plannedS: 3_600 })],
      [
        workout(1, 19980114, { name: "Long endurance", movable: true, durationS: 5_400 }),
        workout(2, 19980117, {
          name: "Recovery spin",
          movable: true,
          durationS: 2_700,
          ...recovery,
        }),
        workout(3, 19980112, { name: "Done ride", movable: false }),
        workout(4, 19980120, {
          name: "Endurance",
          movedByYou: { fromDateKey: 19980119 },
        }),
      ],
    ),
  );
}

function show(move: MoveDialogState = MOVE_DIALOG_CLOSED, calendar = read()) {
  const actions: CalendarMoveActions = {
    request: vi.fn(),
    setSwap: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
  };
  act(() => {
    useEnduragentStore.setState({
      calendar: {
        kind: "ready",
        read: calendar,
        range: { firstRowStart: MONDAY, rowCount: 2 },
        refresh: "idle",
      },
      calendarMove: move,
      calendarMoveActions: actions,
    });
  });
  return actions;
}

const cell = (dateKey: number) => {
  const found = document.querySelector<HTMLElement>(`[role="cell"][data-date-key="${dateKey}"]`);
  if (found === null) throw new Error(`No day ${dateKey}`);
  return found;
};

const card = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-workout-id="${id}"]`);
  if (found === null) throw new Error(`No card ${id}`);
  return found;
};

function transfer() {
  return { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
}

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      calendar: CALENDAR_START,
      calendarMove: MOVE_DIALOG_CLOSED,
      calendarMoveActions: null,
    });
  });
});

describe("moving a workout on the Calendar", () => {
  it("lets the athlete drag a later workout to another day of the Plan, and asks before moving", () => {
    const actions = show();
    render(<CalendarView />);
    expect(card(workoutId(1))).toHaveAttribute("draggable", "true");
    expect(card(workoutId(3))).not.toHaveAttribute("draggable");
    const dataTransfer = transfer();
    fireEvent.dragStart(card(workoutId(1)), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-enduragent-workout",
      workoutId(1),
    );
    const past = fireEvent.dragOver(cell(MONDAY), { dataTransfer });
    expect(past).toBe(true);
    const later = fireEvent.dragOver(cell(19980116), { dataTransfer });
    expect(later).toBe(false);
    expect(cell(19980116)).toHaveAttribute("data-drop-target");
    fireEvent.drop(cell(19980116), { dataTransfer });
    expect(actions.request).toHaveBeenCalledWith(PLAN_ID, workoutId(1), 19980116, false);
  });

  it("labels a workout the athlete moved with the day it came from", () => {
    show();
    render(<CalendarView />);
    expect(card(workoutId(4))).toHaveTextContent("Moved by you from Mon");
  });

  it("asks about the workout already on that day, offering a swap first", async () => {
    const user = userEvent.setup();
    const actions = show({
      kind: "open",
      planId: PLAN_ID,
      workoutId: workoutId(1),
      toDateKey: 19980117,
      swap: true,
    });
    render(<CalendarView />);
    const dialog = screen.getByRole("dialog", { name: "Move Long endurance to Sat 17 Jan?" });
    expect(dialog).toHaveTextContent(
      "It moves on intervals.icu too, so your head unit gets it for Saturday. The week stays 2h 45m.",
    );
    expect(dialog).toHaveTextContent("Saturday already has Recovery spin 45m");
    const swap = within(dialog).getByRole("radio", {
      name: "Swap: Recovery spin goes to Wed 14 Jan",
    });
    expect(swap).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Keep both on Saturday" }));
    expect(actions.setSwap).toHaveBeenCalledWith(false);
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(actions.confirm).toHaveBeenCalledOnce();
    expect(actions.cancel).toHaveBeenCalledOnce();
    expect(card(workoutId(1))).toHaveAttribute("aria-label", "Long endurance, being moved");
    expect(cell(19980117).querySelector(`[data-move-preview="${workoutId(1)}"]`)).not.toBeNull();
  });

  it("says how both weeks change when the workout crosses into another week", () => {
    show({
      kind: "open",
      planId: PLAN_ID,
      workoutId: workoutId(1),
      toDateKey: 19980121,
      swap: true,
    });
    render(<CalendarView />);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Week 1 becomes 1h 15m and Week 2 becomes 2h 30m.",
    );
  });

  it.each([
    ["card-open", "Wed 14 Jan was changed in intervals.icu. Keep or Put back first, then move it."],
    ["refused", "The Plan could not take this move, so nothing moved."],
    ["not-movable", "This workout can’t move to that day, so nothing moved."],
    ["unavailable", "The app did not answer, so nothing moved. Try again."],
  ] as const)("explains a %s failure and keeps both choices", (reason, message) => {
    show({
      kind: "failed",
      reason,
      planId: PLAN_ID,
      workoutId: workoutId(1),
      toDateKey: 19980116,
      swap: true,
    });
    render(<CalendarView />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(message);
    expect(within(dialog).getByRole("button", { name: "Move" })).toBeEnabled();
  });

  it("names the day whose card opened when a swap partner was changed in intervals.icu", () => {
    show(
      {
        kind: "failed",
        reason: "card-open",
        planId: PLAN_ID,
        workoutId: workoutId(1),
        toDateKey: 19980117,
        swap: true,
      },
      read({
        copy: {
          kind: "changed-in-intervals",
          change: "edited",
          toDateKey: null,
          name: null,
          durationS: 1_800,
        },
      }),
    );
    render(<CalendarView />);
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      "Sat 17 Jan was changed in intervals.icu. Keep or Put back first, then move it.",
    );
  });

  it("locks the dialog while the move is saved", () => {
    show({
      kind: "moving",
      planId: PLAN_ID,
      workoutId: workoutId(1),
      toDateKey: 19980116,
      swap: true,
    });
    render(<CalendarView />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Move" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("names the date a swapped workout goes to, and shows it there while Swap is chosen", () => {
    const earlier = calendarRead(
      19980105,
      plan(
        19980105,
        [week(1, 19980105), week(2, 19980112)],
        [
          workout(1, 19980107, { name: "Endurance ride", movable: true }),
          workout(2, 19980112, { name: "Controlled effort", movable: true, durationS: 2_700 }),
          workout(3, 19980114, { name: "Endurance ride", movable: true }),
        ],
      ),
    );
    const target = {
      kind: "open",
      planId: PLAN_ID,
      workoutId: workoutId(1),
      toDateKey: 19980112,
      swap: true,
    } as const;
    show(target, earlier);
    act(() => {
      useEnduragentStore.setState({
        calendar: {
          kind: "ready",
          read: earlier,
          range: { firstRowStart: 19980105, rowCount: 2 },
          refresh: "idle",
        },
      });
    });
    render(<CalendarView />);
    const dialog = screen.getByRole("dialog", { name: "Move Endurance ride to Mon 12 Jan?" });
    expect(
      within(dialog).getByRole("radio", { name: "Swap: Controlled effort goes to Wed 7 Jan" }),
    ).toBeChecked();
    expect(cell(19980112).querySelector(`[data-move-preview="${workoutId(1)}"]`)).not.toBeNull();
    expect(cell(19980107).querySelector(`[data-move-preview="${workoutId(2)}"]`)).not.toBeNull();
    expect(card(workoutId(2))).toHaveAttribute("aria-label", "Controlled effort, being moved");
    act(() => {
      useEnduragentStore.setState({ calendarMove: { ...target, swap: false } });
    });
    expect(cell(19980107).querySelector("[data-move-preview]")).toBeNull();
    expect(card(workoutId(2))).not.toHaveAttribute("aria-label");
  });

  describe("the body across the line between intervals.icu weeks and Plan-only weeks", () => {
    const JAN_5 = 19980105;
    function line(sentWeekTwo: boolean) {
      return calendarRead(
        JAN_5,
        plan(
          JAN_5,
          [
            week(1, JAN_5, { plannedS: 6_000 }),
            week(
              2,
              19980112,
              sentWeekTwo
                ? { plannedS: 6_000 }
                : { plannedS: 6_000, status: { kind: "goes-out", onDateKey: JAN_5 } },
            ),
          ],
          [
            workout(1, 19980107, { name: "Endurance ride", movable: true }),
            workout(2, 19980117, {
              name: "Long ride",
              movable: true,
              durationS: 6_000,
              copy: sentWeekTwo ? { kind: "on-intervals", owner: "plan" } : { kind: "plan-only" },
            }),
          ],
        ),
      );
    }
    function open(
      calendar: ReturnType<typeof line>,
      moving: string,
      toDateKey: number,
      swap: boolean,
    ) {
      show({ kind: "open", planId: PLAN_ID, workoutId: moving, toDateKey, swap }, calendar);
      act(() => {
        useEnduragentStore.setState({
          calendar: {
            kind: "ready",
            read: calendar,
            range: { firstRowStart: JAN_5, rowCount: 2 },
            refresh: "idle",
          },
        });
      });
      render(<CalendarView />);
      const body = document.querySelector("[data-move-effect]");
      if (body === null) throw new Error("No body");
      return body;
    }

    it("names both workouts when a sent workout swaps with a Plan-only one", () => {
      const body = open(line(false), workoutId(1), 19980117, true);
      expect(body).toHaveTextContent(
        "Endurance ride comes off intervals.icu until Week 2 goes out. Long ride goes on intervals.icu for Wed 7 Jan. Week 1 becomes",
      );
      act(() => {
        useEnduragentStore.setState({
          calendarMove: {
            kind: "open",
            planId: PLAN_ID,
            workoutId: workoutId(1),
            toDateKey: 19980117,
            swap: false,
          },
        });
      });
      expect(body).toHaveTextContent(
        /^It comes off intervals.icu until Week 2 goes out. Week 1 becomes/u,
      );
      expect(body).not.toHaveTextContent("Long ride");
    });

    it("names both workouts the other way round", () => {
      const body = open(line(false), workoutId(2), 19980107, true);
      expect(body).toHaveTextContent(
        "Long ride goes on intervals.icu for Wed 7 Jan. Endurance ride comes off intervals.icu until Week 2 goes out. Week 2 becomes",
      );
    });

    it("keeps today's text when both days are already on intervals.icu", () => {
      const body = open(line(true), workoutId(1), 19980117, true);
      expect(body).toHaveTextContent(
        /^It moves on intervals.icu too, so your head unit gets it for Saturday./u,
      );
      expect(body).not.toHaveTextContent("Long ride");
    });
  });

  describe("naming every workout whose intervals.icu state changes with Swap", () => {
    const JAN_5 = 19980105;
    const sent = { kind: "on-intervals", owner: "plan" } as const;
    const planOnly = { kind: "plan-only" } as const;
    const goesOut = { status: { kind: "goes-out", onDateKey: 19980112 } } as const;
    const waiting = { status: { kind: "waiting-for-week-approve" } } as const;
    function build(
      weekTwo: Partial<PlanCalendarWeek>,
      second: number,
      secondCopy: PlanCalendarWorkout["copy"],
    ) {
      return calendarRead(
        JAN_5,
        plan(
          JAN_5,
          [week(1, JAN_5), week(2, 19980112, weekTwo), week(3, 19980119, goesOut)],
          [
            workout(1, 19980107, { name: "Endurance ride", movable: true, copy: sent }),
            workout(2, second, { name: "Long ride", movable: true, copy: secondCopy }),
          ],
        ),
      );
    }
    it.each([
      [
        "A: an intervals.icu workout swaps into a week that has not gone out",
        build({}, 19980121, planOnly),
        1,
        19980121,
        "Endurance ride comes off intervals.icu until Week 3 goes out. Long ride goes on intervals.icu for Wed 7 Jan.",
      ],
      [
        "B: a Plan-only workout swaps into a week on intervals.icu",
        build({}, 19980121, planOnly),
        2,
        19980107,
        "Long ride goes on intervals.icu for Wed 7 Jan. Endurance ride comes off intervals.icu until Week 3 goes out.",
      ],
      [
        "C: only the other workout goes on, into a week waiting for Approve",
        build(waiting, 19980114, planOnly),
        1,
        19980114,
        "It moves on intervals.icu too, so your head unit gets it for Wednesday. Long ride goes on intervals.icu for Wed 7 Jan.",
      ],
      [
        "D: only the moved workout goes on, from a week waiting for Approve",
        build(waiting, 19980114, planOnly),
        2,
        19980107,
        "Long ride goes on intervals.icu for Wed 7 Jan. Week 2 becomes",
      ],
      [
        "E: both workouts stay on intervals.icu",
        build({}, 19980114, sent),
        1,
        19980114,
        "It moves on intervals.icu too, so your head unit gets it for Wednesday. Week 1 becomes",
      ],
    ] as const)("%s", (_case, calendar, moving, toDateKey, expected) => {
      show(
        { kind: "open", planId: PLAN_ID, workoutId: workoutId(moving), toDateKey, swap: true },
        calendar,
      );
      act(() => {
        useEnduragentStore.setState({
          calendar: {
            kind: "ready",
            read: calendar,
            range: { firstRowStart: JAN_5, rowCount: 3 },
            refresh: "idle",
          },
        });
      });
      render(<CalendarView />);
      const body = document.querySelector("[data-move-effect]");
      expect(body?.textContent?.replaceAll("\u00a0", " ")).toContain(expected);
    });
  });

  it("ignores Escape while the move is saved", async () => {
    const user = userEvent.setup();
    const actions = show({
      kind: "moving",
      planId: PLAN_ID,
      workoutId: workoutId(1),
      toDateKey: 19980116,
      swap: true,
    });
    render(<CalendarView />);
    screen.getByRole("button", { name: "Later day" }).focus();
    await user.keyboard("{Escape}");
    expect(actions.cancel).not.toHaveBeenCalled();
  });
});
