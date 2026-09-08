import type { ListPlansResult, PlanCalendarStatus } from "@enduragent/coach-contract";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { PlanCreationConversation } from "../src/ui/chat/PlanCreationCards";

const emptyLibrary: ListPlansResult = {
  calendarConnected: false,
  legacy: null,
  active: null,
  creation: null,
  closed: [],
  changesPaused: null,
  changes: [],
};

const calendarCases = [
  {
    calendar: { status: "not-connected", window: null, currentThrough: null, error: null },
    sentence: "Connect intervals.icu to mirror Workouts.",
  },
  {
    calendar: { status: "pending", window: null, currentThrough: null, error: null },
    sentence: "Calendar Workouts are being added.",
  },
  {
    calendar: { status: "running", window: null, currentThrough: null, error: null },
    sentence: "Calendar Workouts are being added.",
  },
  {
    calendar: {
      status: "verified",
      window: { start: "1998-09-07", end: "1998-10-04" },
      currentThrough: "1998-10-04",
      error: null,
    },
    sentence: "Calendar is up to date.",
  },
  {
    calendar: {
      status: "failed",
      window: null,
      currentThrough: null,
      error: "Calendar update unavailable",
    },
    sentence: "Calendar update failed; see the Plan library.",
  },
] satisfies readonly { calendar: PlanCalendarStatus; sentence: string }[];

beforeEach(() => {
  useEnduragentStore.setState({
    chat: EMPTY_CHAT_SURFACE,
    planLibrary: { status: "ready", value: emptyLibrary },
  });
});

describe("Plan creation activation status", () => {
  it.each(calendarCases)(
    "names the active Plan and reports the $calendar.status calendar state",
    ({ calendar, sentence }) => {
      useEnduragentStore.setState({
        planLibrary: {
          status: "ready",
          value: {
            ...emptyLibrary,
            calendarConnected: calendar.status !== "not-connected",
            active: {
              supportingEventCandidates: [],
              planId: "activation-status-plan",
              version: 1,
              name: "Build steady power",
              start: "1998-09-07",
              end: "1998-10-04",
              weeks: 4,
              status: "active",
              closeReason: null,
              closedAt: null,
              activatedAt: "1998-09-07",
              todayChoice: null,
              calendar,
              creationId: null,
            },
          },
        },
      });

      render(<PlanCreationConversation model={null} />);

      expect(screen.getByRole("status")).toHaveTextContent(
        `Build steady power is active. ${sentence}`,
      );
      expect(screen.queryByText("Plan activated locally.")).not.toBeInTheDocument();
    },
  );

  it("keeps the local activation status until an active Plan is available", () => {
    render(<PlanCreationConversation model={null} />);

    expect(screen.getByRole("status")).toHaveTextContent("Plan activated locally.");
  });
});
