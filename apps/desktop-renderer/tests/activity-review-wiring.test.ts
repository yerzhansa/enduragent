import type { CoachClient } from "@enduragent/coach-client";
import type { PlanCalendarFtpOutcome, PlanCalendarFtpRead } from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_REVIEW_START } from "../src/activity-review/controller";
import { refreshOpenCalendarPage, startCalendarPages } from "../src/page-wiring";
import { useEnduragentStore as store } from "../src/state/store";
import { TODAY, ride, rides } from "./activity-review-fixture";

interface CallParams {
  readonly action: string;
  readonly startDateKey?: number;
  readonly endDateKey?: number;
}

function ftpRead(outcome: PlanCalendarFtpOutcome): PlanCalendarFtpRead {
  return {
    status: "ftp",
    todayDateKey: TODAY,
    current: { watts: 282, dateKey: 19980713, source: "intervals" },
    history: [{ watts: 282, dateKey: 19980713, source: "intervals" }],
    estimates: [],
    chart: { startDateKey: 19980223, endDateKey: TODAY, steps: [] },
    proposal: {
      kind: "confirming",
      watts: 288,
      shownOnDateKey: TODAY,
      percent: 2,
      basis: {
        kind: "drift",
        direction: "above",
        sinceDateKey: 19980806,
        lowWatts: 291,
        highWatts: 291,
        lowestWatts: 291,
      },
      icuWatts: 282,
      changedSinceUse: false,
      icuChangedAtMs: null,
      workoutsOnIntervals: 3,
    },
    outcome,
  };
}

function started(answered: PlanCalendarFtpOutcome | null = null) {
  const call = vi.fn(async (_method: string, params: CallParams) => {
    if (params.action === "rides") return rides([ride("a", TODAY)]);
    if (answered !== null && params.action === "ftp") return ftpRead("none");
    if (answered !== null && params.action === "ftp-answer") return ftpRead(answered);
    return { status: "refused", reason: "no-active-plan" };
  });
  const client: CoachClient = {
    handshake: {} as CoachClient["handshake"],
    call: call as never,
    close: vi.fn(async () => undefined),
  };
  const dispose = startCalendarPages(store, {
    getClient: async () => client,
    reconnect: async () => client,
    onConnectionOpen: () => () => undefined,
    close: async () => undefined,
  });
  const actions = () =>
    call.mock.calls.flatMap(([method, params]) =>
      params.action === "read-review" ? [] : [`${method}:${params.action}`],
    );
  const calendarReads = () =>
    call.mock.calls.flatMap(([, params]) => (params.action === "read" ? [params] : []));
  return { dispose, actions, calendarReads };
}

afterEach(() => {
  store.setState({ activeView: "chat", activityReview: ACTIVITY_REVIEW_START, syncActions: null });
});

describe("the Activity review wiring", () => {
  it("reads the rides when the page opens, and again after a sync while it is open", async () => {
    const test = started();
    store.getState().setActiveView("activity-review");
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"));
    expect(test.actions()).toEqual(["plan.calendar:rides", "plan.calendar:ftp"]);
    refreshOpenCalendarPage(store);
    await vi.waitFor(() => expect(test.actions()).toHaveLength(4));
    expect(test.actions()).toEqual([
      "plan.calendar:rides",
      "plan.calendar:ftp",
      "plan.calendar:rides",
      "plan.calendar:ftp",
    ]);
    store.getState().setActiveView("chat");
    refreshOpenCalendarPage(store);
    await Promise.resolve();
    expect(test.actions()).toHaveLength(4);
    test.dispose();
    expect(store.getState().activityReviewActions).toBeNull();
    expect(store.getState().ftpActions).toBeNull();
  });

  it.each([
    ["written", 1],
    ["none", 0],
    ["changed", 0],
  ] as const)(
    "starts a quiet sync after the FTP answer only when it was written to intervals.icu: %s",
    async (outcome, syncs) => {
      const test = started(outcome);
      const request = vi.fn();
      const refreshQuietly = vi.fn();
      store.getState().bindSyncActions({ request, refreshQuietly });
      store.getState().setActiveView("activity-review");
      store.getState().ftpActions?.open();
      await vi.waitFor(() => expect(store.getState().ftpPanel.kind).toBe("ready"));
      store.getState().ftpActions?.answer("confirm");
      await vi.waitFor(() => expect(test.actions()).toContain("plan.calendar:ftp-answer"));
      await vi.waitFor(() => {
        const panel = store.getState().ftpPanel;
        expect(panel.kind === "ready" && panel.busy === null).toBe(true);
      });
      expect(refreshQuietly).toHaveBeenCalledTimes(syncs);
      expect(request).not.toHaveBeenCalled();
      test.dispose();
    },
  );

  it("routes Plan a 20-minute test to Chat through the composer prefill and sends nothing", async () => {
    const test = started();
    store.setState({ composerPrefill: null });
    store.getState().setActiveView("activity-review");
    store.getState().ftpActions?.open();
    store.getState().ftpActions?.planTest("Please add a 20-minute FTP test to my Plan.");
    expect(store.getState().ftpPanel.open).toBe(false);
    expect(store.getState().composerPrefill?.text).toBe(
      "Please add a 20-minute FTP test to my Plan.",
    );
    expect(store.getState().activeView).toBe("chat");
    expect(test.actions().filter((action) => !action.startsWith("plan.calendar:"))).toEqual([]);
    test.dispose();
    store.setState({ composerPrefill: null });
  });

  it("opens the Calendar on the ride's week from Show in calendar", async () => {
    const test = started();
    store.getState().setActiveView("activity-review");
    await vi.waitFor(() => expect(store.getState().activityReview.kind).toBe("ready"));
    store.getState().activityReviewActions?.showInCalendar(19980105);
    expect(store.getState().activeView).toBe("calendar");
    await vi.waitFor(() => expect(test.actions()).toContain("plan.calendar:read"));
    await vi.waitFor(() => expect(test.calendarReads()).toHaveLength(2));
    const shown = test.calendarReads().at(-1);
    expect(shown?.startDateKey).toBeLessThanOrEqual(19980105);
    expect(shown?.endDateKey).toBeGreaterThanOrEqual(19980105);
    test.dispose();
  });
});
