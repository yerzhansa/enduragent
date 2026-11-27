import { renderLocalized as render } from "./language-harness";
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

function read() {
  return calendarRead(
    TODAY,
    plan(
      MONDAY,
      [week(1, MONDAY, { plannedS: 9_900 }), week(2, 19980119, { plannedS: 3_600 })],
      [
        workout(1, 19980114, { name: "Long endurance", movable: true, durationS: 5_400 }),
        workout(2, 19980117, { name: "Recovery spin", movable: true, durationS: 2_700 }),
        workout(3, 19980112, { name: "Done ride", movable: false }),
        workout(4, 19980120, {
          name: "Endurance",
          movedByYou: { fromDateKey: 19980119 },
        }),
      ],
    ),
  );
}

function show(move: MoveDialogState = MOVE_DIALOG_CLOSED) {
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
        read: read(),
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
      name: "Swap: Recovery spin goes to Wednesday",
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
    ["card-open", "Fri 16 Jan was changed in intervals.icu. Keep or Put back first, then move it."],
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
});
