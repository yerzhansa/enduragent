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
  return {
    open: vi.fn(),
    setRemoveChanges: vi.fn(),
    approve: vi.fn(),
    notNow: vi.fn(),
    retry: vi.fn(),
    connect: vi.fn(),
  };
}

function settingsActions(): CalendarSettingsActions {
  return { load: vi.fn(), setWeekDelivery: vi.fn(), setStartAtLogin: vi.fn() };
}

function replacingRead(
  cleanup: "held" | "pending" | "running" | "failed",
  removes: readonly number[] = [19980106, 19980108],
) {
  return {
    ...waitingRead(),
    replacing: {
      planName: "Old base",
      cleanup,
      removes: removes.map((dateKey, index) => ({
        planWorkoutId: "0".repeat(24) + String(60 + index),
        name: `Old ride ${index + 1}`,
        dateKey,
        durationS: 3_600,
      })),
      staysToday: [
        {
          planWorkoutId: "0".repeat(24) + "70",
          name: "Old spin",
          dateKey: MONDAY,
          durationS: 2_700,
        },
      ],
      athleteChanges: [
        {
          planWorkoutId: "0".repeat(24) + "77",
          name: "My own ride",
          dateKey: 19980110,
          durationS: 5_400,
          tick: {
            planWorkoutId: "0".repeat(24) + "77",
            eventId: 707,
            dateKey: 19980110,
            fingerprint: "icu:edited",
          },
        },
      ],
    },
  };
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

describe("the Replace Approve sheet", () => {
  it("lists what comes off above the new weeks and what stays, and ticks the athlete's changes", async () => {
    const user = userEvent.setup();
    const { approve } = show(replacingRead("held"), {
      kind: "open",
      scope: { kind: "first-weeks" },
    });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", {
      name: "Switch intervals.icu to your new Plan?",
    });
    expect(sheet).toHaveTextContent("Workout Change Set · your new Plan replaces Old base");
    expect(sheet).toHaveTextContent(
      "2 workouts from Old base come off, from tomorrow on. Once they are gone, 4 from your new Plan are added. Your head unit downloads each new one from intervals.icu.",
    );
    const off = within(sheet).getByText("Comes off · Old base · 2 workouts").parentElement;
    if (off === null) throw new Error("Comes off block");
    expect(within(off).getByText("Old ride 1")).toHaveClass("line-through");
    expect(within(off).getByText("Old ride 2")).toHaveClass("line-through");
    expect(within(off).queryByText("My own ride")).toBeNull();
    const stays = within(sheet).getByText("Stays on intervals.icu").parentElement;
    if (stays === null) throw new Error("Stays block");
    expect(stays).toHaveTextContent("Old spin · today");
    expect(stays).toHaveTextContent("My own ride · changed by you in intervals.icu");
    const goesOn = within(sheet).getByText("Goes on · your new Plan");
    expect(
      off.compareDocumentPosition(goesOn) & Node.DOCUMENT_POSITION_FOLLOWING,
      "Comes off is listed above the new weeks",
    ).toBeTruthy();
    expect(
      goesOn.compareDocumentPosition(within(sheet).getByText("Week 1 · 5–11 Jan")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await user.click(
      within(sheet).getByRole("checkbox", { name: "Remove the one you changed too" }),
    );
    expect(approve.setRemoveChanges).toHaveBeenCalledWith(true);
    await user.click(within(sheet).getByRole("button", { name: "Approve 2 off, 4 on" }));
    expect(approve.approve).toHaveBeenCalledOnce();
    await user.click(within(sheet).getByRole("button", { name: "Not now" }));
    expect(approve.notNow).toHaveBeenCalledOnce();
  });

  it("moves the athlete's changes into Comes off once they are ticked", () => {
    show(replacingRead("held"), {
      kind: "open",
      scope: { kind: "first-weeks" },
      removeChanges: true,
    });
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary");
    const off = within(sheet).getByText("Comes off · Old base · 3 workouts").parentElement;
    if (off === null) throw new Error("Comes off block");
    expect(within(off).getByText("My own ride")).toHaveClass("line-through");
    expect(sheet).not.toHaveTextContent("changed by you in intervals.icu");
    expect(
      within(sheet).getByRole("checkbox", { name: "Remove the one you changed too" }),
    ).toBeChecked();
    expect(within(sheet).getByRole("button", { name: "Approve 3 off, 4 on" })).toBeEnabled();
  });

  it("says each step while it sends: removing, checking, then the new weeks", () => {
    const sending = {
      kind: "sending" as const,
      scope: { kind: "first-weeks" as const },
      weeks: [1, 2],
      polls: 0,
      removing: 2,
    };
    show(replacingRead("running"), sending);
    const view = render(<CalendarView />);
    expect(screen.getByRole("status")).toHaveTextContent("Removing 2 workouts from intervals.icu…");
    view.unmount();
    show(replacingRead("running", []), sending);
    const checking = render(<CalendarView />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking they are gone…");
    checking.unmount();
    show({ ...waitingRead(), replacing: null }, sending);
    render(<CalendarView />);
    expect(screen.getByRole("status")).toHaveTextContent("Sending 4 workouts to intervals.icu…");
  });

  it("names what did not come off, lists only what is left, and offers Retry", async () => {
    const user = userEvent.setup();
    const { approve } = show(replacingRead("failed", [19980108]), {
      kind: "remove-failed",
      scope: { kind: "first-weeks" },
      weeks: [1, 2],
      removing: 2,
    });
    render(<CalendarView />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 of 2 came off. Thu 8 failed: intervals.icu did not answer. Nothing from your new Plan was sent yet.",
    );
    const sheet = screen.getByRole("complementary");
    expect(within(sheet).getByText("Comes off · Old base · 1 workout")).toBeVisible();
    expect(within(sheet).getAllByText(/^Old ride/u)).toHaveLength(1);
    await user.click(within(sheet).getByRole("button", { name: "Retry" }));
    expect(approve.retry).toHaveBeenCalledOnce();
  });

  it("shows a banner after Not now that reopens the sheet", async () => {
    const user = userEvent.setup();
    const { approve } = show(replacingRead("held"), APPROVE_SHEET_CLOSED);
    render(<CalendarView />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(
      "Your new Plan is not on intervals.icu yet. 2 workouts from Old base are still there, so your head unit shows the old Plan.",
    );
    await user.click(within(banner).getByRole("button", { name: "Review and approve" }));
    expect(approve.open).toHaveBeenCalledWith({ kind: "first-weeks" });
  });

  it("is the first-two-weeks sheet when nothing comes off", () => {
    const read = replacingRead("held", []);
    show(
      { ...read, replacing: { ...read.replacing, athleteChanges: [] } },
      { kind: "open", scope: { kind: "first-weeks" } },
    );
    render(<CalendarView />);
    const sheet = screen.getByRole("complementary", {
      name: "Send the first two Training Weeks to intervals.icu?",
    });
    expect(sheet).toHaveTextContent("Nothing already there is changed or deleted.");
    expect(within(sheet).getByRole("button", { name: "Approve 4 workouts" })).toBeEnabled();
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
