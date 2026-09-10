import { renderLocalized as render } from "./language-harness";
import type { ListPlansResult, PlanCreationCardModel } from "@enduragent/coach-contract";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { PlanCreationActivateDialog } from "../src/ui/chat/PlanCreationCards";

const summary: NonNullable<ListPlansResult["active"]> = {
  planId: "calendar-plan",
  version: 1,
  name: "Steady riding",
  start: "1998-09-07",
  end: "1998-10-04",
  weeks: 4,
  status: "active",
  supportingEventCandidates: [],
  closeReason: null,
  closedAt: null,
  activatedAt: "1998-09-07",
  todayChoice: null,
  calendar: { status: "pending", window: null, currentThrough: null, error: null },
  creationId: null,
};

const creation: PlanCreationCardModel = {
  creationId: "01J00000000000000000000000",
  version: 1,
  status: "in-progress",
  draft: null,
  draftStale: false,
  calendarWindow: null,
  pendingCommitment: null,
  readiness: "ready",
  answeredSummaries: [],
  openQuestion: null,
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2000, 0, 1));
  useEnduragentStore.setState({
    chat: {
      ...EMPTY_CHAT_SURFACE,
      planCreation: creation,
      planCreationActivateConfirmationOpen: true,
      planCreationActivePlanKnowledge: { kind: "none" },
    },
    planLibrary: { status: "loading", value: null },
    planLibraryActions: {
      closePlan: vi.fn(),
      readPlanHistory: vi.fn(),
      refresh: vi.fn(async () => {}),
      startCreation: vi.fn(),
      continueCreation: vi.fn(),
      changeInChat: vi.fn(),
    } as never,
    chatActions: {
      confirmPlanCreationActivate: vi.fn(),
      cancelPlanCreationActivate: vi.fn(),
    } as never,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("activation calendar consequence", () => {
  it.each([false, true])(
    "shows the connected window when closing an active Plan is %s",
    async (closing) => {
      useEnduragentStore.setState({
        chat: {
          ...useEnduragentStore.getState().chat,
          planCreation: {
            ...creation,
            calendarWindow: {
              startDate: closing ? "1998-09-08" : "1998-09-07",
              endDate: "1998-09-15",
            },
          },
          planCreationActivePlanKnowledge: closing
            ? { kind: "active", name: "Previous training Plan" }
            : { kind: "none" },
        },
        planLibrary: {
          status: "ready",
          value: {
            calendarConnected: true,
            legacy: null,
            creation: null,
            active: closing ? summary : null,
            closed: closing ? [] : [{ ...summary, status: "closed" }],
            changesPaused: null,
            changes: [],
          },
        },
      });
      render(<PlanCreationActivateDialog />);
      expect(
        await screen.findByText(
          `Dated Workouts sync from ${closing ? "tomorrow" : "today"} through 15 Sept 1998.`,
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          closing
            ? "Steady riding closes. Today’s calendar Workout stays. The new Plan activates now."
            : "The new Plan activates now.",
        ),
      ).toBeVisible();
      expect(screen.queryByText(/Previous training Plan/)).toBeNull();
      expect(
        screen.getByRole("button", { name: closing ? "Activate new Plan" : "Activate Plan" }),
      ).toBeEnabled();
    },
  );

  it.each(["unloaded", "empty", "not-connected", "verified"])(
    "waits for connection when the disconnected library is %s",
    async (kind) => {
      if (kind !== "unloaded")
        useEnduragentStore.setState({
          planLibrary: {
            status: "ready",
            value: {
              calendarConnected: false,
              legacy: null,
              creation: null,
              active:
                kind === "empty"
                  ? null
                  : {
                      ...summary,
                      calendar:
                        kind === "verified"
                          ? {
                              status: "verified",
                              window: null,
                              currentThrough: "1998-09-13",
                              error: null,
                            }
                          : {
                              status: "not-connected",
                              window: null,
                              currentThrough: null,
                              error: null,
                            },
                    },
              closed: [],
              changesPaused: null,
              changes: [],
            },
          },
        });
      render(<PlanCreationActivateDialog />);
      expect(
        await screen.findByText("Calendar updates wait until intervals.icu is connected."),
      ).toBeVisible();
      expect(screen.queryByText(/Dated Workouts sync/)).toBeNull();
      if (kind === "unloaded")
        expect(screen.getByRole("button", { name: "Activate Plan" })).toBeDisabled();
    },
  );

  it.each([false, true])(
    "uses connection availability before the first Plan: %s",
    async (calendarConnected) => {
      useEnduragentStore.setState({
        chat: {
          ...useEnduragentStore.getState().chat,
          planCreation: {
            ...creation,
            calendarWindow: calendarConnected
              ? { startDate: "1998-09-07", endDate: "1998-09-13" }
              : null,
          },
        },
        planLibrary: {
          status: "ready",
          value: {
            calendarConnected,
            legacy: null,
            creation: null,
            active: null,
            closed: [],
            changesPaused: null,
            changes: [],
          },
        },
      });
      render(<PlanCreationActivateDialog />);
      expect(
        await screen.findByText(
          calendarConnected
            ? "Dated Workouts sync from today through 13 Sept 1998."
            : "Calendar updates wait until intervals.icu is connected.",
        ),
      ).toBeVisible();
    },
  );

  it("uses a null card window even when the library reports a connected calendar", async () => {
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: true,
          legacy: null,
          creation: null,
          active: null,
          closed: [],
          changesPaused: null,
          changes: [],
        },
      },
    });
    render(<PlanCreationActivateDialog />);
    expect(
      await screen.findByText("Calendar updates wait until intervals.icu is connected."),
    ).toBeVisible();
    expect(screen.queryByText(/Dated Workouts sync/)).toBeNull();
  });

  it("shows no sync line until the library read confirms the connection", async () => {
    let finish: () => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: true,
          legacy: null,
          creation: null,
          active: null,
          closed: [],
          changesPaused: null,
          changes: [],
        },
      },
      planLibraryActions: {
        ...useEnduragentStore.getState().planLibraryActions,
        refresh,
      } as never,
    });
    render(<PlanCreationActivateDialog />);
    expect(refresh).toHaveBeenCalledOnce();
    const confirm = screen.getByRole("button", { name: "Activate Plan" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(
      useEnduragentStore.getState().chatActions?.confirmPlanCreationActivate,
    ).not.toHaveBeenCalled();
    expect(screen.queryByText(/Dated Workouts sync/)).toBeNull();
    expect(screen.queryByText(/Calendar updates wait/)).toBeNull();
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: false,
          legacy: null,
          creation: null,
          active: null,
          closed: [],
          changesPaused: null,
          changes: [],
        },
      },
    });
    finish();
    expect(
      await screen.findByText("Calendar updates wait until intervals.icu is connected."),
    ).toBeVisible();
    expect(screen.queryByText(/Dated Workouts sync/)).toBeNull();
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(
      useEnduragentStore.getState().chatActions?.confirmPlanCreationActivate,
    ).toHaveBeenCalledOnce();
  });

  it("treats a failed library read as disconnected even with a cached connected library", async () => {
    const refresh = vi.fn(async () => {
      useEnduragentStore.setState({
        planLibrary: {
          status: "unavailable",
          value: {
            calendarConnected: true,
            legacy: null,
            creation: null,
            active: null,
            closed: [],
            changesPaused: null,
            changes: [],
          },
        },
      });
    });
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: true,
          legacy: null,
          creation: null,
          active: null,
          closed: [],
          changesPaused: null,
          changes: [],
        },
      },
      planLibraryActions: {
        ...useEnduragentStore.getState().planLibraryActions,
        refresh,
      } as never,
    });
    render(<PlanCreationActivateDialog />);
    expect(
      await screen.findByText("Calendar updates wait until intervals.icu is connected."),
    ).toBeVisible();
    expect(screen.queryByText(/Dated Workouts sync/)).toBeNull();
    expect(screen.getByRole("button", { name: "Activate Plan" })).toBeDisabled();
  });

  it("blocks activation when refresh rejects despite a ready cached library", async () => {
    useEnduragentStore.setState({
      planLibrary: {
        status: "ready",
        value: {
          calendarConnected: true,
          legacy: null,
          creation: null,
          active: summary,
          closed: [],
          changesPaused: null,
          changes: [],
        },
      },
      planLibraryActions: {
        ...useEnduragentStore.getState().planLibraryActions,
        refresh: vi.fn(async () => {
          throw new Error("Library unavailable");
        }),
      } as never,
    });
    render(<PlanCreationActivateDialog />);
    expect(
      await screen.findByText("Calendar updates wait until intervals.icu is connected."),
    ).toBeVisible();
    const confirm = screen.getByRole("button", { name: "Activate new Plan" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(
      useEnduragentStore.getState().chatActions?.confirmPlanCreationActivate,
    ).not.toHaveBeenCalled();
  });
});
