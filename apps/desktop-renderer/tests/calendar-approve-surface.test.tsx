import { renderLocalized as render } from "./language-harness";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVE_SHEET_CLOSED, type ApproveSheetState } from "../src/calendar/approve-controller";
import { CALENDAR_START } from "../src/calendar/controller";
import {
  CALENDAR_SETTINGS_START,
  type CalendarSettingsState,
} from "../src/calendar/settings-controller";
import type {
  CalendarApproveActions,
  CalendarSettingsActions,
} from "../src/state/calendar-approve-slice";
import { useEnduragentStore } from "../src/state/store";
import { CalendarView } from "../src/ui/calendar/CalendarView";
import { CalendarSection } from "../src/ui/settings/CalendarSection";
import { calendarRead, plan, week, workout } from "./calendar-fixture";

const MONDAY = 19980105;

function waitingRead(connected = true) {
  return {
    ...calendarRead(
      MONDAY,
      plan(
        MONDAY,
        [
          week(1, MONDAY, { status: { kind: "waiting-for-first-approve" } }),
          week(2, 19980112, { status: { kind: "waiting-for-first-approve" } }),
          week(3, 19980119, { status: { kind: "goes-out", onDateKey: 19980112 } }),
        ],
        [
          workout(1, MONDAY, { copy: { kind: "plan-only" } }),
          workout(2, 19980108, { copy: { kind: "plan-only" } }),
          workout(3, 19980113, { copy: { kind: "plan-only" } }),
          workout(4, 19980115, { copy: { kind: "plan-only" } }),
        ],
      ),
    ),
    calendarConnected: connected,
  };
}

function approveActions(): CalendarApproveActions {
  return { open: vi.fn(), approve: vi.fn(), notNow: vi.fn(), retry: vi.fn(), connect: vi.fn() };
}

function settingsActions(): CalendarSettingsActions {
  return { load: vi.fn(), setWeekDelivery: vi.fn(), setStartAtLogin: vi.fn() };
}

function show(
  read: ReturnType<typeof waitingRead>,
  sheet: ApproveSheetState,
  settings: CalendarSettingsState = {
    weekDelivery: { kind: "ready", value: "send-each-week" },
    startAtLogin: { kind: "ready", enabled: false },
  },
) {
  const approve = approveActions();
  const set = settingsActions();
  act(() => {
    useEnduragentStore.setState({
      calendar: {
        kind: "ready",
        read,
        range: { firstRowStart: MONDAY, rowCount: 3 },
        refresh: "idle",
      },
      calendarActions: {
        refresh: vi.fn(),
        previous: vi.fn(),
        next: vi.fn(),
        today: vi.fn(),
        showWeekOf: vi.fn(),
      },
      calendarApproval: sheet,
      calendarApproveActions: approve,
      calendarSettings: settings,
      calendarSettingsActions: set,
    });
  });
  return { approve, set };
}

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      calendar: CALENDAR_START,
      calendarActions: null,
      calendarApproval: APPROVE_SHEET_CLOSED,
      calendarApproveActions: null,
      calendarSettings: CALENDAR_SETTINGS_START,
      calendarSettingsActions: null,
    });
  });
});

describe("the Approve sheet", () => {
  it("lists the first two weeks, outlines them in the grid, and approves or waits", async () => {
    const user = userEvent.setup();
    const { approve, set } = show(waitingRead(), { kind: "open", scope: { kind: "first-weeks" } });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", {
      name: "Send the first two Training Weeks to intervals.icu?",
    });
    expect(sheet).toHaveTextContent("4 workouts are added to your intervals.icu calendar.");
    expect(sheet).toHaveTextContent("Week 1 · 5–11 Jan");
    expect(sheet).toHaveTextContent("Week 2 · 12–18 Jan · 2 workouts");
    expect(document.querySelectorAll("[data-highlighted]")).toHaveLength(4);
    await user.click(within(sheet).getByRole("checkbox", { name: /Start Enduragent at login/u }));
    expect(set.setStartAtLogin).toHaveBeenCalledWith(true);
    await user.click(within(sheet).getByRole("button", { name: "Approve 4 workouts" }));
    expect(approve.approve).toHaveBeenCalledOnce();
    await user.click(within(sheet).getByRole("button", { name: "Not now" }));
    expect(approve.notNow).toHaveBeenCalledOnce();
  });

  it("offers Connect when intervals.icu is not connected", async () => {
    const user = userEvent.setup();
    const { approve } = show(waitingRead(false), { kind: "open", scope: { kind: "first-weeks" } });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary");
    expect(sheet).toHaveTextContent("intervals.icu is not connected.");
    expect(within(sheet).queryByRole("button", { name: /^Approve/u })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Connect intervals.icu" }));
    expect(approve.connect).toHaveBeenCalledOnce();
  });

  it("names the days that failed and offers Retry", async () => {
    const user = userEvent.setup();
    const read = waitingRead();
    const planned = read.plan;
    if (planned === null) throw new Error("plan");
    const failed = {
      ...read,
      plan: {
        ...planned,
        weeks: planned.weeks.map((entry) => ({ ...entry, status: { kind: "due" as const } })),
        workouts: planned.workouts.map((entry) =>
          entry.dateKey === 19980113
            ? { ...entry, lastWrite: "failed" as const }
            : { ...entry, copy: { kind: "on-intervals" as const, owner: "plan" as const } },
        ),
      },
    };
    const { approve } = show(failed, {
      kind: "send-failed",
      scope: { kind: "first-weeks" },
      weeks: [1, 2],
    });
    render(<CalendarView />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("3 of 4 sent. Tue 13 failed: intervals.icu did not answer.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(approve.retry).toHaveBeenCalledOnce();
  });
});

describe("Calendar settings", () => {
  it("switches Approve each week and Start at login", async () => {
    const user = userEvent.setup();
    const { set } = show(waitingRead(), APPROVE_SHEET_CLOSED);
    render(<CalendarSection />);
    expect(set.load).toHaveBeenCalled();
    await user.click(screen.getByRole("switch", { name: "Approve each week" }));
    expect(set.setWeekDelivery).toHaveBeenCalledWith("approve-each-week");
    await user.click(screen.getByRole("switch", { name: "Start Enduragent at login" }));
    expect(set.setStartAtLogin).toHaveBeenCalledWith(true);
  });

  it("hides Start at login where the computer cannot start apps at login", () => {
    show(waitingRead(), APPROVE_SHEET_CLOSED, {
      weekDelivery: { kind: "ready", value: "approve-each-week" },
      startAtLogin: { kind: "unavailable" },
    });
    render(<CalendarSection />);
    expect(screen.getByRole("switch", { name: "Approve each week" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("switch", { name: "Start Enduragent at login" })).toBeNull();
  });
});
