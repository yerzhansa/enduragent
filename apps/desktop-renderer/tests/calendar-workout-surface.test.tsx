import { renderLocalized as render } from "./language-harness";
import type { PlanCalendarRpcResult, PlanCalendarWorkout } from "@enduragent/coach-contract";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGE_SHEET_CLOSED } from "../src/calendar/change-controller";
import { CALENDAR_START } from "../src/calendar/controller";
import type { PlanCalendarRead } from "../src/calendar/grid";
import { createMoveController, MOVE_DIALOG_CLOSED } from "../src/calendar/move-controller";
import {
  createWorkoutCardController,
  WORKOUT_CARD_CLOSED,
} from "../src/calendar/workout-card-controller";
import { IDLE_TRAINING_EXPORT } from "../src/training-export/controller";
import { useEnduragentStore } from "../src/state/store";
import { CalendarView } from "../src/ui/calendar/CalendarView";
import { calendarRead, PLAN_ID, plan, week, workout, workoutId } from "./calendar-fixture";

const MONDAY = 19980112;
const TODAY = 19980114;

function read(extra: { readonly second?: Partial<PlanCalendarWorkout> } = {}): PlanCalendarRead {
  return calendarRead(
    TODAY,
    plan(
      MONDAY,
      [
        week(1, MONDAY, { plannedS: 12_600 }),
        week(2, 19980119, {
          plannedS: 3_600,
          status: { kind: "goes-out", onDateKey: 19980112 },
        }),
      ],
      [
        workout(1, TODAY, { name: "Long endurance", durationS: 9_000, movable: true }),
        workout(2, 19980120, {
          name: "Tempo",
          copy: { kind: "plan-only" },
          movable: true,
          ...extra.second,
        }),
        workout(3, MONDAY, {
          name: "Endurance",
          movable: false,
          outcome: { kind: "done-as-planned", activityId: "a".repeat(64), actualDurationS: 3_500 },
        }),
      ],
    ),
  );
}

function show(calendar = read()) {
  const prefillComposer = vi.fn();
  const openChangeInChat = vi.fn();
  const card = createWorkoutCardController({
    composerText: () => "",
    prefillComposer,
    openChangeInChat,
    publish: (next) => useEnduragentStore.getState().setCalendarWorkout(next),
  });
  const call = vi.fn(async (): Promise<PlanCalendarRpcResult> => ({ status: "moved" }));
  const move = createMoveController({
    call,
    refresh: vi.fn(),
    publish: (next) => useEnduragentStore.getState().setCalendarMove(next),
  });
  const changeOpen = vi.fn();
  const exportWorkoutArchive = vi.fn(async () => undefined);
  act(() => {
    useEnduragentStore.setState({
      calendar: {
        kind: "ready",
        read: calendar,
        range: { firstRowStart: MONDAY, rowCount: 2 },
        refresh: "idle",
      },
      calendarWorkoutActions: {
        open: (planId, id) => card.open(planId, id),
        close: () => card.close(),
        askCoach: (draft) => card.askCoach(draft),
      },
      calendarMoveActions: {
        request: (planId, id, toDateKey, swap) => move.request(planId, id, toDateKey, swap),
        setSwap: (swap) => move.setSwap(swap),
        confirm: (canSwap) => void move.confirm(canSwap),
        cancel: () => move.cancel(),
      },
      calendarChangeActions: { open: changeOpen, keep: vi.fn(), putBack: vi.fn(), close: vi.fn() },
      trainingExportActions: { exportActivity: vi.fn(), exportWorkoutArchive },
    });
  });
  return { prefillComposer, openChangeInChat, call, changeOpen, exportWorkoutArchive };
}

const gridCard = (id: string) => {
  const found = document.querySelector<HTMLElement>(`[data-workout-id="${id}"]`);
  if (found === null) throw new Error(`No card ${id}`);
  return found;
};

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      calendar: CALENDAR_START,
      calendarWorkout: WORKOUT_CARD_CLOSED,
      calendarWorkoutActions: null,
      calendarMove: MOVE_DIALOG_CLOSED,
      calendarMoveActions: null,
      calendarChange: CHANGE_SHEET_CLOSED,
      calendarChangeActions: null,
      trainingExport: IDLE_TRAINING_EXPORT,
      trainingExportActions: null,
    });
  });
});

describe("the workout card on the Calendar", () => {
  it("lays the workout's card over the grid with its day, length and intervals.icu copy", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    const card = screen.getByRole("dialog", { name: "Long endurance" });
    expect(card).toHaveTextContent("Wed 14 Jan · Today · Plan Workout");
    expect(card.textContent?.replaceAll(" ", " ")).toContain("2h 30m");
    expect(card.querySelector('[data-workout-copy="on-intervals"]')).toHaveTextContent(
      "On intervals.icu",
    );
    expect(within(card).getByRole("heading", { name: "Long endurance" })).toHaveFocus();
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Move…", "Ask the coach to change it", "Export", "Close"]);
    expect(gridCard(workoutId(1))).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("[data-calendar-state]")).toBeInTheDocument();
  });

  it("closes with Escape or Close and gives focus back to the workout in the grid", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(gridCard(workoutId(1))).toHaveFocus();
    expect(gridCard(workoutId(1))).toHaveAttribute("aria-expanded", "false");
    await user.click(gridCard(workoutId(3)));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(gridCard(workoutId(3))).toHaveFocus();
  });

  it("opens from the keyboard with Enter on a focused workout", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    gridCard(workoutId(2)).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Tempo" })).toBeInTheDocument();
  });

  it("says when a Plan-only workout goes out, and offers no export or move it cannot make", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(2)));
    const tempo = screen.getByRole("dialog", { name: "Tempo" });
    expect(tempo.querySelector('[data-workout-copy="plan-only"]')).toHaveTextContent(
      "In the Plan only, goes out Mon 12 Jan",
    );
    expect(within(tempo).queryByRole("button", { name: "Export" })).toBeNull();
    await user.click(gridCard(workoutId(3)));
    const done = screen.getByRole("dialog", { name: "Endurance" });
    expect(within(done).queryByRole("button", { name: "Move…" })).toBeNull();
    expect(within(done).getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("keeps opening the change sheet for a workout changed in intervals.icu", async () => {
    const user = userEvent.setup();
    const bound = show(
      read({
        second: {
          copy: {
            kind: "changed-in-intervals",
            change: "edited",
            toDateKey: null,
            name: "Tempo",
            durationS: 1_800,
          },
        },
      }),
    );
    render(<CalendarView />);
    await user.click(gridCard(workoutId(2)));
    expect(bound.changeOpen).toHaveBeenCalledWith(PLAN_ID, workoutId(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves from the keyboard: Move… opens the move dialog on the next free day, and the day steps", async () => {
    const user = userEvent.setup();
    const bound = show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    expect(screen.queryByRole("dialog", { name: "Long endurance" })).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Move Long endurance to Thu 15 Jan?" });
    const earlier = within(dialog).getByRole("button", { name: "Earlier day" });
    const later = within(dialog).getByRole("button", { name: "Later day" });
    expect(earlier).toBeDisabled();
    await user.click(later);
    expect(screen.getByRole("dialog", { name: "Move Long endurance to Fri 16 Jan?" })).toBe(dialog);
    expect(later).toHaveFocus();
    expect(earlier).toBeEnabled();
    await user.click(earlier);
    expect(dialog).toHaveAccessibleName("Move Long endurance to Thu 15 Jan?");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(bound.call).toHaveBeenCalledWith({
      action: "move-workout",
      planId: PLAN_ID,
      planWorkoutId: workoutId(1),
      toDateKey: 19980115,
      swap: false,
    });
  });

  it("gives focus back to the workout when the move dialog is cancelled", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(gridCard(workoutId(1))).toHaveFocus();
  });

  it("asks the coach in Chat with a draft naming the workout and day, sending nothing", async () => {
    const user = userEvent.setup();
    const bound = show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Ask the coach to change it" }));
    expect(bound.prefillComposer).toHaveBeenCalledWith(
      "Please change Long endurance on Wed 14 Jan:",
    );
    expect(bound.openChangeInChat).toHaveBeenCalledOnce();
    expect(bound.call).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exports the workout's day from intervals.icu with the existing workout export", async () => {
    const user = userEvent.setup();
    const bound = show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    const card = screen.getByRole("dialog", { name: "Long endurance" });
    const toggle = within(card).getByRole("button", { name: "Export" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(card).getByText("Workout format")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Export workouts" }));
    expect(bound.exportWorkoutArchive).toHaveBeenCalledWith({
      oldest: "1998-01-14",
      newest: "1998-01-14",
      format: "zwo",
    });
  });

  it("closes the card when a refresh shows the workout was changed in intervals.icu", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(2)));
    expect(screen.getByRole("dialog", { name: "Tempo" })).toBeInTheDocument();
    act(() => {
      useEnduragentStore.setState({
        calendar: {
          kind: "ready",
          read: read({
            second: {
              copy: {
                kind: "changed-in-intervals",
                change: "deleted",
                toDateKey: null,
                name: null,
                durationS: null,
              },
            },
          }),
          range: { firstRowStart: MONDAY, rowCount: 2 },
          refresh: "idle",
        },
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useEnduragentStore.getState().calendarWorkout).toEqual(WORKOUT_CARD_CLOSED);
  });
});
