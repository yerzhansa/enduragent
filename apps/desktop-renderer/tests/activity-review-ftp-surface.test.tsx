import { renderLocalized as render } from "./language-harness";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PlanCalendarFtpProposal,
  PlanCalendarFtpRead,
  PlanCalendarRide,
} from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_REVIEW_START } from "../src/activity-review/controller";
import { FTP_PANEL_START, type FtpPanelState } from "../src/activity-review/ftp-controller";
import type { ActivityReviewActions, FtpActions } from "../src/state/activity-review-slice";
import { useEnduragentStore } from "../src/state/store";
import { ActivityReviewView } from "../src/ui/activity-review/ActivityReviewView";
import { TODAY, planWorkout, ride, rides } from "./activity-review-fixture";

const THRESHOLD = planWorkout(2, 19980819, "Threshold 4×8", 4_800);

const DRIFT: PlanCalendarFtpProposal = {
  kind: "shown",
  watts: 288,
  shownOnDateKey: 19980819,
  percent: 2,
  basis: {
    kind: "drift",
    direction: "above",
    sinceDateKey: 19980805,
    lowWatts: 291,
    highWatts: 293,
    lowestWatts: 291,
  },
};

const CONFIRMING: PlanCalendarFtpProposal = {
  ...DRIFT,
  kind: "confirming",
  icuWatts: 282,
  changedSinceUse: false,
  icuChangedAtMs: null,
  workoutsOnIntervals: 10,
};

function ftpRead(extra: Partial<PlanCalendarFtpRead> = {}): PlanCalendarFtpRead {
  return {
    status: "ftp",
    todayDateKey: TODAY,
    current: { watts: 282, dateKey: 19980713, source: "intervals" },
    history: [
      { watts: 268, dateKey: 19980302, source: "first-sync" },
      { watts: 275, dateKey: 19980518, source: "coach-test" },
      { watts: 282, dateKey: 19980713, source: "intervals" },
    ],
    estimates: Array.from({ length: 20 }, (_, index) => ({
      dateKey: 19980801 + index,
      watts: index < 4 ? 284 : 291 + (index % 3),
    })),
    chart: {
      startDateKey: 19980223,
      endDateKey: TODAY,
      steps: [
        { dateKey: 19980223, watts: 268, source: "first-sync" },
        { dateKey: 19980518, watts: 275, source: "coach-test" },
        { dateKey: 19980713, watts: 282, source: "intervals" },
      ],
    },
    proposal: { kind: "none" },
    outcome: "none",
    ...extra,
  };
}

function reviewActions(): ActivityReviewActions {
  return {
    refresh: vi.fn(),
    select: vi.fn(),
    change: vi.fn(),
    otherDay: vi.fn(),
    closeChoices: vi.fn(),
    confirm: vi.fn(),
    extra: vi.fn(),
    rematch: vi.fn(),
    showInCalendar: vi.fn(),
    writeAgain: vi.fn(),
    saveNote: vi.fn(),
    askCoach: vi.fn(),
  };
}

function ftpActions(): FtpActions {
  return { open: vi.fn(), close: vi.fn(), answer: vi.fn(), planTest: vi.fn() };
}

const KNOWN_282: PlanCalendarRide["ftp"] = {
  kind: "known",
  watts: 282,
  use: "outdoor",
  setBy: "you",
  setOnDateKey: 19980713,
  outdoorWatts: 282,
};

function show(
  panel: FtpPanelState,
  list: readonly PlanCalendarRide[] = [
    ride("b", 19980819, {
      name: "Threshold 4×8",
      match: { kind: "confirmed", ...THRESHOLD, outcome: "done-differently", by: "you" },
      ftp: KNOWN_282,
    }),
  ],
  bound = ftpActions(),
): FtpActions {
  act(() => {
    useEnduragentStore.setState({
      activityReview: {
        kind: "ready",
        read: rides(list),
        selectedId: null,
        refresh: "idle",
        choices: "closed",
        saving: "idle",
      },
      activityReviewActions: reviewActions(),
      ftpPanel: panel,
      ftpActions: bound,
    });
  });
  return bound;
}

function ready(read: PlanCalendarFtpRead, extra: Partial<FtpPanelState> = {}): FtpPanelState {
  return { kind: "ready", read, open: true, busy: null, notice: "none", ...extra } as FtpPanelState;
}

function text(element: Element | null): string {
  return (element?.textContent ?? "").replaceAll(" ", " ");
}

afterEach(() => {
  act(() => {
    useEnduragentStore.setState({
      activityReview: ACTIVITY_REVIEW_START,
      activityReviewActions: null,
      ftpPanel: FTP_PANEL_START,
      ftpActions: null,
    });
  });
});

describe("FTP on Activity review", () => {
  it("says which FTP the ride's targets used and opens the FTP history", async () => {
    const actions = show(ready(ftpRead(), { open: false }));
    render(<ActivityReviewView />);
    expect(text(document.querySelector("[data-ride-ftp]"))).toBe(
      "Targets use FTP 282 W, set by you in intervals.icu on 13 Jul.FTP history",
    );
    await userEvent.click(screen.getByRole("button", { name: "FTP history" }));
    expect(actions.open).toHaveBeenCalledOnce();
  });

  it("shows the FTP the coach sent for a ride, whatever the panel holds", () => {
    show(
      ready(ftpRead({ current: { watts: 291, dateKey: TODAY, source: "coach-estimate" } }), {
        open: false,
      }),
      [
        ride("c", 19980601, {
          name: "June ride",
          ftp: {
            kind: "known",
            watts: 275,
            use: "outdoor",
            setBy: "coach",
            setOnDateKey: 19980518,
            outdoorWatts: 275,
          },
        }),
      ],
    );
    render(<ActivityReviewView />);
    expect(text(document.querySelector("[data-ride-ftp]"))).toBe(
      "FTP 275 W, set in intervals.icu on 18 May from the coach’s proposal.FTP history",
    );
  });

  it("says where a first-synced FTP came from without a date", () => {
    show(ready(ftpRead(), { open: false }), [
      ride("d", 19980301, {
        match: { kind: "confirmed", ...THRESHOLD, outcome: "done-as-planned", by: "you" },
        ftp: {
          kind: "known",
          watts: 282,
          use: "outdoor",
          setBy: "unknown",
          setOnDateKey: null,
          outdoorWatts: 282,
        },
      }),
    ]);
    render(<ActivityReviewView />);
    expect(text(document.querySelector("[data-ride-ftp]"))).toBe(
      "Targets use FTP 282 W from intervals.icu.FTP history",
    );
  });

  it("says when no FTP is known for a ride", () => {
    show(ready(ftpRead(), { open: false }), [ride("e", 19980101)]);
    render(<ActivityReviewView />);
    expect(text(document.querySelector("[data-ride-ftp]"))).toBe(
      "No FTP is known for this ride.FTP history",
    );
  });

  it("shows the indoor FTP on an indoor ride and the outdoor one beside it", () => {
    show(ready(ftpRead(), { open: false }), [
      ride("f", 19980819, {
        name: "Over-unders 3×9",
        kind: "indoor",
        ftp: {
          kind: "known",
          watts: 274,
          use: "indoor",
          setBy: "you",
          setOnDateKey: 19980713,
          outdoorWatts: 282,
        },
      }),
    ]);
    render(<ActivityReviewView />);
    expect(text(document.querySelector("[data-ftp-indoor]"))).toBe(
      "FTP 274 W indoor · set by you in intervals.icu on 13 JulOutdoor rides use 282 W.",
    );
  });
});

describe("the FTP history panel", () => {
  it("shows the one FTP, its chart, the explainer, the history and the closing note", async () => {
    const actions = show(ready(ftpRead()));
    render(<ActivityReviewView />);
    const sheet = screen.getByRole("complementary", { name: "FTP" });
    expect(screen.getByRole("heading", { name: "FTP", level: 2 })).toHaveFocus();
    expect(text(sheet.querySelector("[data-ftp-current]"))).toBe(
      "282 W set by you in intervals.icu on 13 Jul",
    );
    const chart = within(sheet).getByRole("img");
    expect(chart.getAttribute("aria-label")).toBe(
      "FTP from 23 Feb to 20 Aug: 268 W in intervals.icu, 275 W from 18 May, 282 W from 13 Jul. A dotted line shows intervals.icu’s estimate.",
    );
    expect(sheet.querySelector("[data-ftp-steps]")?.getAttribute("d")).toMatch(/^M50\.0,/);
    expect(text(chart)).toContain("MarAprMayJunJulAug");
    expect(sheet.querySelector("[data-ftp-steps]")).not.toBeNull();
    expect(sheet.querySelector("[data-ftp-estimate]")).not.toBeNull();
    expect(sheet).toHaveTextContent(
      "Solid: your FTP, the one number every target uses. Dotted: intervals.icu’s eFTP, an estimate, shown for information only; it never changes your FTP by itself.",
    );
    const table = within(sheet).getByRole("table", { name: "FTP history" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => text(cell)),
    ).toEqual(["Date", "FTP", "Where it came from"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => text(row))).toEqual([
      "13 Jul282 WSet by you in intervals.icu",
      "18 May275 WCoach’s proposal after your 20-minute test; you chose Use",
      "268 WIn intervals.icu when the app first synced",
    ]);
    expect(sheet).toHaveTextContent(
      "There is one FTP, the one in intervals.icu. If you change it there, the app reads it at the next sync and adds a line here; there is nothing to choose. A separate indoor FTP set in intervals.icu is shown for indoor rides and never changed by the app.",
    );
    expect(sheet.querySelector("[data-ftp-proposal]")).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(actions.close).toHaveBeenCalledOnce();
  });

  it("names a first-synced FTP as in intervals.icu", () => {
    show(ready(ftpRead({ current: { watts: 268, dateKey: 19980302, source: "first-sync" } })));
    render(<ActivityReviewView />);
    expect(text(document.querySelector("[data-ftp-current]"))).toBe("268 W in intervals.icu");
  });

  it("shows the coach's proposal with its reason and the three answers", async () => {
    const actions = show(ready(ftpRead({ proposal: DRIFT })));
    render(<ActivityReviewView />);
    const card = screen.getByRole("region", { name: "The coach’s FTP proposal" });
    expect(text(card)).toContain("Proposed by the coach · Wed 19 Aug");
    expect(text(card)).toContain("intervals.icu’s estimate has stayed above your FTP for 14 days");
    expect(text(card)).toContain(
      "eFTP has read 291 to 293 W since Wed 5 Aug, 3% or more above 282 W. The coach proposes 288 W, just under your lowest estimate in 14 days (291 W). A single ride never starts a proposal; only a planned FTP test or 14 days like this do.",
    );
    expect(text(card)).toContain("rises about 2% by itself");
    expect(document.querySelector("[data-ftp-proposed]")).not.toBeNull();
    await userEvent.click(within(card).getByRole("button", { name: "Keep 282 W" }));
    await userEvent.click(within(card).getByRole("button", { name: "Use 288 W from today" }));
    await userEvent.click(within(card).getByRole("button", { name: "Plan a 20-minute test" }));
    expect(vi.mocked(actions.answer).mock.calls).toEqual([["keep"], ["use"]]);
    expect(actions.planTest).toHaveBeenCalledWith(
      "Please add a 20-minute FTP test to my Plan, so we can check my FTP.",
    );
  });

  it("names a planned test and its best 20 minutes as the reason", () => {
    show(
      ready(
        ftpRead({
          proposal: {
            kind: "shown",
            watts: 288,
            shownOnDateKey: 19980819,
            percent: 2,
            basis: { kind: "planned-test", testDateKey: 19980818, bestWatts: 303 },
          },
        }),
      ),
    );
    render(<ActivityReviewView />);
    const card = screen.getByRole("region", { name: "The coach’s FTP proposal" });
    expect(text(card)).toContain("Your 20-minute test suggests 288 W");
    expect(text(card)).toContain(
      "Your planned 20-minute test on Tue 18 Aug held 303 W for its best 20 minutes. The coach proposes 288 W, 95% of that.",
    );
  });

  it("asks before writing the new FTP to intervals.icu and moves focus to the confirm", async () => {
    const actions = show(ready(ftpRead({ proposal: CONFIRMING })));
    render(<ActivityReviewView />);
    const confirm = screen.getByRole("region", { name: "Set your FTP to 288 W in intervals.icu?" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Set your FTP to 288 W in intervals.icu?" }),
    ).toHaveFocus();
    expect(text(confirm)).toBe(
      [
        "Set your FTP to 288 W in intervals.icu?",
        "ChangesRide FTP in your intervals.icu settings: 282 W → 288 W, from today",
        "Workoutsintervals.icu works out new watts for every planned workout, including the 10 already there: about 2% higher",
        "StaysPast rides keep 282 W. Your indoor FTP is not touched.",
        "Set 288 W in intervals.icuCancel",
      ].join(""),
    );
    expect(document.querySelector("[data-ftp-proposal]")).toBeNull();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Set 288 W in intervals.icu" }),
    );
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(vi.mocked(actions.answer).mock.calls).toEqual([["confirm"], ["cancel"]]);
  });

  it("cancels the confirm on Escape without closing the panel", async () => {
    const actions = show(ready(ftpRead({ proposal: CONFIRMING })));
    render(<ActivityReviewView />);
    await userEvent.keyboard("{Escape}");
    expect(vi.mocked(actions.answer).mock.calls).toEqual([["cancel"]]);
    expect(actions.close).not.toHaveBeenCalled();
  });

  it.each([
    ["Escape", async () => userEvent.keyboard("{Escape}")],
    ["Cancel", async () => userEvent.click(screen.getByRole("button", { name: "Cancel" }))],
  ] as const)(
    "puts focus back on Use after %s in the confirm, and a second Escape closes the panel",
    async (_how, leave) => {
      const bound = show(ready(ftpRead({ proposal: CONFIRMING })));
      render(<ActivityReviewView />);
      await leave();
      expect(vi.mocked(bound.answer).mock.calls).toEqual([["cancel"]]);
      show(ready(ftpRead({ proposal: DRIFT })), undefined, bound);
      expect(screen.getByRole("button", { name: "Use 288 W from today" })).toHaveFocus();
      expect(bound.close).not.toHaveBeenCalled();
      await userEvent.keyboard("{Escape}");
      expect(bound.close).toHaveBeenCalledOnce();
    },
  );

  it("shows the number intervals.icu now holds, then Set instead or Keep it", async () => {
    const actions = show(
      ready(
        ftpRead({
          proposal: {
            ...CONFIRMING,
            icuWatts: 285,
            changedSinceUse: true,
            icuChangedAtMs: new Date(1998, 7, 19, 18, 2).getTime(),
            percent: 1,
            workoutsOnIntervals: 1,
          },
        }),
        { notice: "changed" },
      ),
    );
    render(<ActivityReviewView />);
    const confirm = screen.getByRole("region", { name: "Set your FTP to 288 W in intervals.icu?" });
    expect(within(confirm).getByRole("alert")).toHaveTextContent(
      "intervals.icu now says 285 W (you set it at 6:02 PM).Set 288 W instead?",
    );
    expect(text(confirm)).toContain("285 W → 288 W");
    expect(text(confirm)).toContain("including the one already there: about 1% higher");
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep 285 W" }));
    expect(vi.mocked(actions.answer).mock.calls).toEqual([["keep"]]);
  });

  it("moves focus to the notice when the confirm goes away after a write", () => {
    const bound = show(ready(ftpRead({ proposal: CONFIRMING })));
    render(<ActivityReviewView />);
    show(
      ready(ftpRead({ current: { watts: 288, dateKey: TODAY, source: "coach-estimate" } }), {
        notice: "written",
      }),
      undefined,
      bound,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(
      "Your FTP in intervals.icu is now 288 W. Every planned workout follows it from today.",
    );
    expect(notice).toHaveFocus();
  });

  it("returns focus to FTP history when the panel closes", async () => {
    const bound = show(ready(ftpRead(), { open: false }));
    render(<ActivityReviewView />);
    const opener = screen.getByRole("button", { name: "FTP history" });
    show(ready(ftpRead()), undefined, bound);
    expect(screen.getByRole("heading", { name: "FTP", level: 2 })).toHaveFocus();
    show(ready(ftpRead(), { open: false }), undefined, bound);
    expect(opener).toHaveFocus();
  });

  it("says when intervals.icu did not answer", () => {
    show(ready(ftpRead({ proposal: DRIFT }), { notice: "unavailable" }));
    render(<ActivityReviewView />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "intervals.icu did not answer, so nothing changed. Try again.",
    );
  });
});
