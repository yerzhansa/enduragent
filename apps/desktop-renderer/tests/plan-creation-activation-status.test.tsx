import type { ListPlansResult, PlanCalendarStatus } from "@enduragent/coach-contract";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_CHAT_SURFACE } from "../src/state/chat-slice";
import { useEnduragentStore } from "../src/state/store";
import { PlanChangeCards } from "../src/ui/chat/PlanChangeCards";
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
    sentence: "Connect to mirror Workouts",
  },
  {
    calendar: { status: "pending", window: null, currentThrough: null, error: null },
    sentence: "Local only",
  },
  {
    calendar: { status: "running", window: null, currentThrough: null, error: null },
    sentence: "Updating calendar",
  },
  {
    calendar: {
      status: "verified",
      window: { start: "1998-09-07", end: "1998-10-04" },
      currentThrough: "1998-10-04",
      error: null,
    },
    sentence: "7 Sept 1998 to 4 Oct 1998 · Up to date",
  },
  {
    calendar: {
      status: "failed",
      window: null,
      currentThrough: null,
      error: "Calendar update unavailable",
    },
    sentence: "Calendar sync failed.",
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

      render(<PlanChangeCards />);

      expect(screen.getByRole("region", { name: "Build steady power" })).toHaveTextContent(
        sentence,
      );
      expect(screen.queryByText("Plan activated locally.")).not.toBeInTheDocument();
    },
  );

  it("renders no transcript content after activation", () => {
    const { container } = render(<PlanCreationConversation model={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
