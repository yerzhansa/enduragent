import { renderLocalized as render } from "./language-harness";
import type {
  PlanCalendarRpcResult,
  PlanCalendarWeek,
  PlanCalendarWorkout,
} from "@enduragent/coach-contract";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGE_SHEET_CLOSED, type ChangeDetail } from "../src/calendar/change-controller";
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

function read(
  extra: {
    readonly second?: Partial<PlanCalendarWorkout>;
    readonly weekTwo?: Partial<PlanCalendarWeek>;
    readonly withoutSecond?: boolean;
  } = {},
): PlanCalendarRead {
  return calendarRead(
    TODAY,
    plan(
      MONDAY,
      [
        week(1, MONDAY, { plannedS: 12_600 }),
        week(2, 19980119, {
          plannedS: 3_600,
          status: { kind: "goes-out", onDateKey: 19980112 },
          ...extra.weekTwo,
        }),
      ],
      [
        workout(1, TODAY, { name: "Long endurance", durationS: 9_000, movable: true }),
        ...(extra.withoutSecond === true
          ? []
          : [
              workout(2, 19980120, {
                name: "Tempo",
                copy: { kind: "plan-only" },
                movable: true,
                ...extra.second,
              }),
            ]),
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
  const approveOpen = vi.fn();
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
      calendarApproveActions: {
        open: approveOpen,
        setRemoveChanges: vi.fn(),
        approve: vi.fn(),
        notNow: vi.fn(),
        retry: vi.fn(),
        connect: vi.fn(),
      },
    });
  });
  return { prefillComposer, openChangeInChat, call, changeOpen, approveOpen, exportWorkoutArchive };
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
      calendarApproveActions: null,
      calendarActions: null,
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
    ).toEqual(["Close", "Move…", "Ask the coach to change it", "Export this day’s workouts"]);
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
    expect(within(tempo).queryByRole("button", { name: "Export this day’s workouts" })).toBeNull();
    await user.click(gridCard(workoutId(3)));
    const done = screen.getByRole("dialog", { name: "Endurance" });
    expect(within(done).queryByRole("button", { name: "Move…" })).toBeNull();
    expect(
      within(done).getByRole("button", { name: "Export this day’s workouts" }),
    ).toBeInTheDocument();
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
    expect(earlier).toHaveAttribute("aria-disabled", "true");
    await user.click(later);
    expect(screen.getByRole("dialog", { name: "Move Long endurance to Fri 16 Jan?" })).toBe(dialog);
    expect(later).toHaveFocus();
    expect(earlier).toHaveAttribute("aria-disabled", "false");
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
      "Please change “Long endurance” on Wed 14 Jan:",
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
    const toggle = within(card).getByRole("button", { name: "Export this day’s workouts" });
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

  it("keeps focus on a step button at the last day, and Escape still closes the dialog", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    const dialog = screen.getByRole("dialog", { name: "Move Long endurance to Thu 15 Jan?" });
    const later = within(dialog).getByRole("button", { name: "Later day" });
    expect(within(dialog).getByRole("button", { name: "Earlier day" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    for (let press = 0; press < 12; press += 1) await user.click(later);
    expect(dialog).toHaveAccessibleName("Move Long endurance to Sun 25 Jan?");
    expect(later).toHaveAttribute("aria-disabled", "true");
    expect(later).toHaveFocus();
    expect(within(dialog).getByRole("heading")).toHaveAttribute("aria-live", "polite");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(gridCard(workoutId(1))).toHaveFocus();
  });
});

describe("one Calendar sheet at a time", () => {
  function transfer() {
    return { setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" };
  }

  it("closes the card when a workout is dragged to another day", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    const dataTransfer = transfer();
    const target = document.querySelector('[role="cell"][data-date-key="19980116"]');
    if (target === null) throw new Error("No Friday");
    fireEvent.dragStart(gridCard(workoutId(1)), { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(screen.queryByRole("dialog", { name: "Long endurance" })).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Move Long endurance to Fri 16 Jan?" }),
    ).toBeVisible();
  });

  it("cancels the move dialog when another workout is opened", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    await user.click(gridCard(workoutId(2)));
    expect(useEnduragentStore.getState().calendarMove).toEqual(MOVE_DIALOG_CLOSED);
    expect(screen.getByRole("dialog", { name: "Tempo" })).toBeVisible();
  });

  it("opens nothing while a change from intervals.icu is being kept", async () => {
    const user = userEvent.setup();
    show();
    const detail: ChangeDetail = {
      status: "change-detail",
      planWorkoutId: workoutId(2),
      basis: "7@19980120:seen",
      change: "edited",
      plan: { dateKey: 19980120, name: "Tempo", durationS: 3_600, description: null },
      intervals: { dateKey: 19980120, name: "Tempo", durationS: 2_700, description: null },
      editedAt: null,
    };
    act(() => {
      useEnduragentStore.setState({
        calendarChange: { kind: "working", planId: PLAN_ID, detail, choice: "keep" },
      });
    });
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    expect(useEnduragentStore.getState().calendarWorkout).toEqual(WORKOUT_CARD_CLOSED);
    expect(screen.getByRole("button", { name: "Plan details" })).toBeDisabled();
  });

  it("closes the card before Review opens the Approve sheet", async () => {
    const user = userEvent.setup();
    const bound = show(read({ weekTwo: { status: { kind: "waiting-for-week-approve" } } }));
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Review and approve" }));
    expect(useEnduragentStore.getState().calendarWorkout).toEqual(WORKOUT_CARD_CLOSED);
    expect(bound.approveOpen).toHaveBeenCalledWith({ kind: "week", week: 2 });
  });

  it("marks the workout whose change sheet is open, without calling it a dialog", () => {
    show(
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
    act(() => {
      useEnduragentStore.setState({
        calendarChange: { kind: "loading", planId: PLAN_ID, planWorkoutId: workoutId(2) },
      });
    });
    render(<CalendarView />);
    expect(gridCard(workoutId(2))).toHaveAttribute("aria-expanded", "true");
    expect(gridCard(workoutId(2))).not.toHaveAttribute("aria-haspopup");
    expect(gridCard(workoutId(1))).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("gives focus to the grid when a refresh removes the open workout", async () => {
    const user = userEvent.setup();
    show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(2)));
    act(() => {
      useEnduragentStore.setState({
        calendar: {
          kind: "ready",
          read: read({ withoutSecond: true }),
          range: { firstRowStart: MONDAY, rowCount: 2 },
          refresh: "idle",
        },
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[data-calendar-grid]")).toHaveFocus();
  });

  it("pages the grid to a target day outside the shown weeks, and back on Escape", async () => {
    const user = userEvent.setup();
    const longer = calendarRead(
      TODAY,
      plan(
        MONDAY,
        [week(1, MONDAY), week(2, 19980119), week(3, 19980126)],
        [workout(1, 19980125, { name: "Long endurance", durationS: 9_000, movable: true })],
      ),
    );
    show(longer);
    const showWeekOf = vi.fn();
    act(() => {
      useEnduragentStore.setState({
        calendarActions: {
          refresh: vi.fn(),
          previous: vi.fn(),
          next: vi.fn(),
          today: vi.fn(),
          showWeekOf,
        },
      });
    });
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    expect(
      screen.getByRole("dialog", { name: "Move Long endurance to Mon 26 Jan?" }),
    ).toBeVisible();
    expect(showWeekOf).toHaveBeenLastCalledWith(19980126);
    await user.keyboard("{Escape}");
    expect(showWeekOf).toHaveBeenLastCalledWith(19980125);
    expect(useEnduragentStore.getState().calendarMove).toEqual(MOVE_DIALOG_CLOSED);
  });

  function paging() {
    const longer = calendarRead(
      TODAY,
      plan(
        MONDAY,
        [week(1, MONDAY), week(2, 19980119), week(3, 19980126)],
        [workout(1, 19980125, { name: "Long endurance", durationS: 9_000, movable: true })],
      ),
    );
    show(longer);
    const calendar = {
      refresh: vi.fn(),
      previous: vi.fn(),
      next: vi.fn(),
      today: vi.fn(),
      showWeekOf: vi.fn(),
    };
    act(() => {
      useEnduragentStore.setState({ calendarActions: calendar });
    });
    const shows = (firstRowStart: number, refresh: "idle" | "failed" = "idle") =>
      act(() => {
        useEnduragentStore.setState({
          calendar: {
            kind: "ready",
            read: { ...longer },
            range: { firstRowStart, rowCount: 2 },
            refresh,
          },
        });
      });
    const failed = () =>
      act(() => {
        const current = useEnduragentStore.getState().calendar;
        if (current.kind === "ready") {
          useEnduragentStore.setState({ calendar: { ...current, refresh: "failed" } });
        }
      });
    return { calendar, shows, failed };
  }

  it("lets the athlete page away while the move dialog is open, and scrolls once per target", async () => {
    const user = userEvent.setup();
    const { calendar, shows } = paging();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<CalendarView />);
      await user.click(gridCard(workoutId(1)));
      await user.click(screen.getByRole("button", { name: "Move…" }));
      expect(calendar.showWeekOf).toHaveBeenCalledTimes(1);
      shows(19980119);
      expect(scrolled).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole("button", { name: "Next week" }));
      shows(19980202);
      await user.click(screen.getByRole("button", { name: "Next week" }));
      shows(19980216);
      shows(19980216);
      expect(calendar.next).toHaveBeenCalledTimes(2);
      expect(calendar.showWeekOf).toHaveBeenCalledTimes(1);
      expect(scrolled).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("pages again when the target changed while its own page was loading", async () => {
    const user = userEvent.setup();
    const { calendar, shows } = paging();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    expect(calendar.showWeekOf).toHaveBeenLastCalledWith(19980126);
    await user.click(screen.getByRole("button", { name: "Earlier day" }));
    expect(calendar.showWeekOf).toHaveBeenCalledTimes(1);
    shows(19980126);
    expect(calendar.showWeekOf).toHaveBeenLastCalledWith(19980124);
    expect(calendar.showWeekOf).toHaveBeenCalledTimes(2);
  });

  it("retries the dialog's own failed page, and reloads the athlete's own view otherwise", async () => {
    const user = userEvent.setup();
    const { calendar, shows, failed } = paging();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    failed();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(calendar.showWeekOf).toHaveBeenLastCalledWith(19980126);
    expect(calendar.showWeekOf).toHaveBeenCalledTimes(2);
    expect(calendar.refresh).not.toHaveBeenCalled();
    shows(19980119);
    await user.click(screen.getByRole("button", { name: "Next week" }));
    shows(19980202);
    failed();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(calendar.refresh).toHaveBeenCalledOnce();
    expect(calendar.showWeekOf).toHaveBeenCalledTimes(2);
  });

  it("keeps the moved layout from Move until the read with the move arrives", async () => {
    const user = userEvent.setup();
    const bound = show();
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(bound.call).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    const day = (dateKey: number) => {
      const found = document.querySelector(`[role="cell"][data-date-key="${dateKey}"]`);
      if (found === null) throw new Error(`No day ${dateKey}`);
      return found;
    };
    expect(day(19980115).querySelector(`[data-move-landed="${workoutId(1)}"]`)).not.toBeNull();
    expect(day(TODAY).querySelector(`[data-workout-id="${workoutId(1)}"]`)).toBeNull();
    const moved = read();
    const landed = {
      ...moved,
      plan:
        moved.plan === null
          ? null
          : {
              ...moved.plan,
              workouts: moved.plan.workouts.map((entry) =>
                entry.id === workoutId(1) ? { ...entry, dateKey: 19980115 } : entry,
              ),
            },
    };
    act(() => {
      useEnduragentStore.setState({
        calendar: {
          kind: "ready",
          read: landed,
          range: { firstRowStart: MONDAY, rowCount: 2 },
          refresh: "idle",
        },
      });
    });
    expect(day(19980115).querySelector("[data-move-landed]")).toBeNull();
    expect(day(19980115).querySelector(`[data-workout-id="${workoutId(1)}"]`)).not.toBeNull();
  });

  it("goes back to the preview when the move fails", async () => {
    const user = userEvent.setup();
    const bound = show();
    bound.call.mockRejectedValueOnce(new Error("offline"));
    render(<CalendarView />);
    await user.click(gridCard(workoutId(1)));
    await user.click(screen.getByRole("button", { name: "Move…" }));
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeVisible();
    expect(document.querySelector("[data-move-landed]")).toBeNull();
    expect(gridCard(workoutId(1))).toHaveAttribute("aria-label", "Long endurance, being moved");
  });
});
